# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""The myco benchmark: task items passed via HARNESS2_MYCO_TASK.

The task text is always provided inline by the caller (e.g. /harness run <task>).
No plan.json or _myco_/ directory is required. Any project directory works.

The task's domain is always "Bug" for harness² purposes. Scoring returns None
— there is no automated rubric; the adapter's own selection is the verdict.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

from .. import config
from ..core.spec import BenchPrompts, BenchSpec, ChannelSpec, resolve_channel_model
from ..substrate.myco import MycoSubstrate


def _same_content(a: Path, b: Path) -> bool:
    """True when two files hold the same bytes. Missing on either side is a difference."""
    try:
        if a.stat().st_size != b.stat().st_size:
            return False
        return hashlib.sha1(a.read_bytes()).hexdigest() == hashlib.sha1(b.read_bytes()).hexdigest()
    except OSError:
        return False


def _project_root() -> Path:
    explicit = os.environ.get("HARNESS2_MYCO_PROJECT", "").strip()
    if not explicit:
        raise config.ConfigError(
            "set HARNESS2_MYCO_PROJECT to the project directory harness² should tune against"
        )
    root = Path(explicit).expanduser().resolve()
    if not root.is_dir():
        raise config.ConfigError(f"HARNESS2_MYCO_PROJECT={root} is not a directory")
    return root


MYCO_BASE = BenchPrompts(
    work=(
        "a work item filed in this project's plan: a bug to fix, a feature to add, or a "
        "task to carry out"
    ),
    domain_word="work type",
    inv_levers=(
        "how the agent approaches the work: which files it reads first, whether it "
        "reproduces before editing, how it verifies its change, when it stops"
    ),
    dom_levers=(
        "what someone experienced with this kind of work knows: the conventions this "
        "codebase follows, the traps in the area being touched, what a complete change "
        "looks like"
    ),
    yardstick=(
        "whether the change actually does what the item asked, stays inside the area the "
        "item is about, and leaves the project in a state its maintainer would accept"
    ),
    deliverable_word="change",
    domain_guidance=(
        "Bug items reward finding the real cause rather than the nearest symptom; "
        "Feature items reward following the project's existing patterns; Todo items "
        "reward doing exactly the named thing and nothing else."
    ),
)


def myco_spec(substrate_name: str = "myco") -> BenchSpec:
    """The myco BenchSpec. A value, not a code path."""
    # The improver and selector run through `claude` against the gateway myco itself is
    # configured with, not through OpenCode: a myco host has no OpenCode checkout, and
    # `claude_cli` would drop the gateway env for a Vertex account nobody has. Override
    # with HARNESS2_PROPOSER_CHANNEL + HARNESS2_PROPOSER_MODEL (both, never one).
    kind = os.environ.get("HARNESS2_PROPOSER_CHANNEL", "").strip() or "claude_local"
    model = (
        os.environ.get("HARNESS2_PROPOSER_MODEL", "").strip()
        or config.PROPOSER_MODEL_BY_CHANNEL.get(kind, "")
    )
    # An unset model is "not configured yet", not a mismatch: resolve_channel_model
    # rejects a lone override precisely because a half-specified pair fails silently
    # downstream, but here the default legitimately resolves to "" on a host that has
    # no ANTHROPIC_MODEL. Building the spec anyway lets tasks/preflight run and lets
    # Proposer.__post_init__ name the missing variable when a session actually starts.
    channel = (
        resolve_channel_model(kind, model, effort="high")
        if model.strip()
        else ChannelSpec(kind, "", effort="high")
    )
    return BenchSpec(
        name="myco",
        runs_root=config.RUNS / "myco",
        install_mode="myco_workspace",
        prompts=MYCO_BASE,
        channels={"proposer": channel, "selector": channel},
        domain_word="work type",
        proposer_deliverables="contents",
        obs_trunc=50_000,
    )


class MycoAdapter:
    """The BenchmarkAdapter surface for myco projects, on the myco substrate."""

    def __init__(
        self,
        *,
        substrate: str = "myco",
        model: str | None = None,
        timeout: int | None = None,
        split_file: Path | None = None,
        project: Path | None = None,
    ):
        if substrate != "myco":
            raise ValueError(
                f"the myco benchmark runs on the myco substrate only, got {substrate!r}"
            )
        self.split_file = split_file
        self.project = Path(project).expanduser().resolve() if project else _project_root()
        self.spec = myco_spec(substrate)
        self.substrate = MycoSubstrate(out_root=config.RUNS / "myco" / "rollouts")
        self.model = model or config.SOLVER_MODEL_OC
        # HARNESS2_MYCO_ROLLOUT_TIMEOUT is read by harness-runner.js too: the
        # sweep's wall-clock cap is derived from this number, so the two must
        # agree or the supervisor kills a sweep still inside its rollout budget.
        # Default 5h: a codec-sized task legitimately needs more than the hour
        # three rollouts hit in one sweep (138-251 tool calls each, progressing).
        env_timeout = os.environ.get("HARNESS2_MYCO_ROLLOUT_TIMEOUT", "").strip()
        self.timeout = int(timeout or env_timeout or 18000)
        self._staged: Path | None = None
        # Capture the staging key ONCE, at construction. Reading the task text
        # lazily would let two adapters in the same process (or a re-read after
        # the env changed) resolve to the same directory, which is the very
        # collision this key exists to prevent.
        self._staging_key = self._compute_stage_key()

    def _compute_stage_key(self) -> str:
        """Directory key that changes with the task TEXT, not just its id.

        Every inline task shares the id `inline-task`, so keying staging by id
        alone made the first task of a container permanent: the `staged` marker
        survived, `_stage()` returned the old directory, and a later sweep ran
        the PREVIOUS task's text while its status.json reported the new one.
        Observed on the test server — a README task staged under
        /tmp/harness2-myco-tasks/ was still fed to the agent hours later under
        a different prompt, across sessions and after a container rebuild.

        Hashing the prompt makes a new task a cache miss and keeps an idempotent
        re-run (same text) a hit.
        """
        try:
            text = self.task_prompt('inline-task')
        except Exception:
            text = ''
        return 'inline-task-' + hashlib.sha1(text.encode('utf-8')).hexdigest()[:12]

    # ── task staging ───────────────────────────────────────────────────────

    # Where staged tasks live. A staged task is a FULL COPY of the project, so
    # its home has to be a volume with room for one per distinct task text —
    # and /tmp is not that: in the container it is overlay storage (~10 GB free)
    # while the state volume (/data) is the host's ~2 TB disk. One Silesia-sized
    # task is 200 MB before the runner copies it into 4k rollout workspaces.
    #
    # Resolution order:
    #   1. MYCO_STAGE_ROOT         — explicit, used verbatim
    #   2. <MYCO_DATA>/harness2-task-cache, then /data/harness2-task-cache
    #   3. tempfile.gettempdir()/harness2-myco-tasks   (dev machines, no /data)
    #
    # Deliberately NOT inside the session workspace: staging is shared across
    # every sweep of the same task text, and putting it under /wks would make it
    # part of the user's git tree.
    def _stage_root(self) -> Path:
        cached = getattr(self, "_stage_root_cached", None)
        if cached is not None:
            return cached
        explicit = os.environ.get("MYCO_STAGE_ROOT", "").strip()
        if explicit:
            root = Path(explicit).expanduser()
        else:
            root = None
            for base in (os.environ.get("MYCO_DATA", "").strip(), "/data"):
                if not base:
                    continue
                cand = Path(base) / "harness2-task-cache"
                try:
                    cand.mkdir(parents=True, exist_ok=True)
                    if os.access(cand, os.W_OK):
                        root = cand
                        break
                except OSError:
                    continue
            if root is None:
                root = Path(tempfile.gettempdir()) / "harness2-myco-tasks"
        self._stage_root_cached = root
        return root

    def _task_dir(self, task_id: str) -> Path:
        """The directory the runner copies INTO the rollout workspace, flat.

        Everything here becomes a file the agent sees at its workspace root, so it
        holds the task prompt and the project's files and nothing else. Bookkeeping
        lives in `_meta_dir` — a marker or a seed list dropped here would be copied
        into the workspace as if it were project content.
        """
        return self._stage_root() / self._staging_key

    def _meta_dir(self, task_id: str) -> Path:
        """Staging bookkeeping, deliberately OUTSIDE the task dir (see above)."""
        return self._stage_root() / ".meta" / self._staging_key

    # ── task source ────────────────────────────────────────────────────────

    def _plan(self) -> list[dict]:
        """Build the task list from HARNESS2_MYCO_TASK env var.

        plan.json is no longer required. The task text is always passed
        directly via HARNESS2_MYCO_TASK (set by harness-runner.js sweepEnv).
        """
        inline = os.environ.get("HARNESS2_MYCO_TASK", "").strip()
        if not inline:
            raise ValueError(
                "HARNESS2_MYCO_TASK is not set — pass a task description via "
                "`/harness run <task>` or set the env var directly"
            )
        return [{"id": "inline-task", "layer": "Bug", "text": inline}]

    def tasks(self, split: str = "all") -> list[str]:
        """Return the single inline task id."""
        plan = self._plan()
        return [item["id"] for item in plan if isinstance(item, dict) and item.get("text")]

    def _item(self, task_id: str) -> dict:
        for item in self._plan():
            if isinstance(item, dict) and item.get("id") == task_id:
                return item
        raise ValueError(f"task {task_id!r} not found")

    def domain_of(self, task_id: str) -> str:
        """All inline tasks are treated as Bug domain."""
        return "Bug"

    def reference_domain_order(self) -> list[str]:
        return ["Bug", "Feature", "Todo"]

    def task_prompt(self, task_id: str) -> str:
        """The task text passed via HARNESS2_MYCO_TASK."""
        return self._item(task_id).get("text", "").strip()

    def task_files(self, task_id: str) -> Path | None:
        """The staged task directory, or None before staging."""
        d = self._task_dir(task_id)
        return d if d.is_dir() else None

    # Staging limits, in bytes. The cap exists so a sweep does not copy a
    # multi-gigabyte checkout four times per run; it must NOT be so tight that
    # a task's own data never reaches the agent.
    #
    # The old rule was a flat 2 MB per file, chosen to keep bulk content out of
    # the proposer's context. That conflated two different budgets: the agent
    # needs its task inputs, while deliverable_files() already keeps seed files
    # out of the proposer and applies its own 512 KB text cap. A codec task
    # whose dataset is twelve 5-51 MB Silesia files therefore ran with NO data
    # at all: the agent burned its first tool calls on `find /` and found the
    # corpus only because a sibling session happened to be on the same box.
    #
    # MYCO_STAGE_MAX_FILE_MB  per-file ceiling          (default 64)
    # MYCO_STAGE_MAX_TOTAL_MB whole-copy ceiling         (default 512)
    # Raise the total, not the file cap, for a genuinely large corpus; both are
    # reported through skipped files so a truncation is never silent.
    #
    # Mind the multiplier: the staged directory is COPIED into every rollout
    # workspace, so one sweep with k=1 costs (1 + 4k) times the staged size —
    # about 2.5 GB at the 512 MB default, ~1 GB for the Silesia task. A corpus
    # that genuinely needs more should be read in place via an absolute path
    # rather than staged; raising the ceiling four-times-over is rarely right.
    _DEFAULT_MAX_FILE_MB = 64
    _DEFAULT_MAX_TOTAL_MB = 512

    @staticmethod
    def _env_mb(name: str, default: int) -> int:
        raw = os.environ.get(name, "").strip()
        if not raw:
            return default * 1024 * 1024
        try:
            val = int(raw)
        except ValueError:
            return default * 1024 * 1024
        return max(0, val) * 1024 * 1024

    def _restricted_project(self, dest: Path) -> list[str]:
        """Copy the project's source files into the task staging directory.

        `.git/`, `_myco_/`, `_harness_/`, `.claude/`, `.myco_harness/`, and common
        dependency dirs are excluded to keep the copy cheap, clean, and free of
        session secrets (settings allowlists, memory files, PATs).

        Size is bounded by two configurable budgets rather than one flat cap —
        see the constants above for why. Every file that does not make it is
        recorded so the omission can be reported instead of silently changing
        what the task even is.
        """
        seeded = []
        skipped: list[dict] = []
        skip = {".git", "_myco_", "_harness_", "node_modules", ".venv", "__pycache__",
                ".claude", ".myco_harness"}
        # Extensions whose content the proposer cannot meaningfully read.
        # Add to MYCO_RESTRICT_BINARY_EXTS (comma-separated) to extend the list.
        _DEFAULT_BINARY_EXTS = {
            ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".tiff",
            ".svg",   # vector but large and opaque to most LLMs
            ".pdf", ".docx", ".xlsx", ".pptx",
            ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".zst",
            ".mp4", ".mov", ".avi", ".mkv", ".webm",
            ".mp3", ".wav", ".ogg", ".flac",
            ".ttf", ".woff", ".woff2", ".otf",
            ".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a",
            ".pyc", ".pyo",
        }
        _extra = os.environ.get("MYCO_RESTRICT_BINARY_EXTS", "")
        binary_exts = _DEFAULT_BINARY_EXTS | {
            e.strip().lower() for e in _extra.split(",") if e.strip()
        }

        max_file = self._env_mb("MYCO_STAGE_MAX_FILE_MB", self._DEFAULT_MAX_FILE_MB)
        max_total = self._env_mb("MYCO_STAGE_MAX_TOTAL_MB", self._DEFAULT_MAX_TOTAL_MB)
        copied_bytes = 0

        for src in sorted(self.project.rglob("*")):
            rel = src.relative_to(self.project)
            if any(part in skip for part in rel.parts):
                continue
            # Skip dotfiles that might carry secrets (.env, .envrc, etc.)
            if rel.parts[0].startswith("."):
                continue
            if not src.is_file():
                continue
            if src.suffix.lower() in binary_exts:
                continue
            try:
                size = src.stat().st_size
            except OSError:
                continue
            if size > max_file:
                skipped.append({"path": rel.as_posix(), "bytes": size,
                                "reason": "over_file_limit"})
                continue
            if copied_bytes + size > max_total:
                skipped.append({"path": rel.as_posix(), "bytes": size,
                                "reason": "over_total_limit"})
                continue
            dst = dest / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copy2(src, dst)
            except OSError:
                skipped.append({"path": rel.as_posix(), "bytes": size,
                                "reason": "copy_failed"})
                continue
            copied_bytes += size
            seeded.append(rel.as_posix())

        self._last_skipped = skipped
        if skipped:
            total_mb = sum(s["bytes"] for s in skipped) / (1024 * 1024)
            print(
                f"[stage] {len(skipped)} file(s) not staged ({total_mb:.1f} MB) — "
                f"per-file limit {max_file / (1024 * 1024):.0f} MB, "
                f"total limit {max_total / (1024 * 1024):.0f} MB; "
                f"adjust MYCO_STAGE_MAX_FILE_MB / MYCO_STAGE_MAX_TOTAL_MB",
                file=sys.stderr, flush=True)
            for s in skipped[:10]:
                print(f"[stage]   skipped {s['path']} ({s['bytes'] / (1024 * 1024):.1f} MB, "
                      f"{s['reason']})", file=sys.stderr, flush=True)
            if len(skipped) > 10:
                print(f"[stage]   … and {len(skipped) - 10} more", file=sys.stderr, flush=True)
        return seeded

    def _stage(self, task_id: str) -> Path:
        """Materialise the task once per task id, idempotently.

        Layout matters: the runner copies the CONTENTS of this directory into the
        rollout workspace, so the project's files sit here directly beside task.md.
        An earlier version nested them under `workspace/`, which the runner faithfully
        reproduced as `<ws>/workspace/app.py` — the agent opened an empty project and
        every candidate "failed to produce an artifact".
        """
        dest = self._task_dir(task_id)
        meta = self._meta_dir(task_id)
        marker = meta / "staged"
        if marker.exists() and dest.is_dir():
            return dest
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        dest.mkdir(parents=True, exist_ok=True)
        meta.mkdir(parents=True, exist_ok=True)
        (dest / "task.md").write_text(self.task_prompt(task_id) + "\n", encoding="utf-8")
        seeded = self._restricted_project(dest)
        (meta / "seeded.json").write_text(json.dumps(seeded), encoding="utf-8")
        # Kept in the meta dir, never the task dir: anything inside `dest` is
        # copied into the rollout workspace as if it were project content.
        (meta / "skipped.json").write_text(
            json.dumps(getattr(self, "_last_skipped", []), ensure_ascii=False, indent=2),
            encoding="utf-8")
        # A change is the deliverable for every layer: a bug fix, a feature, a
        # todo all land as edits. The runner's rule 2 (any new/modified file
        # beyond the seeded inputs) is therefore the right test, and no
        # DELIVERABLE pointer is written.
        marker.write_text("1", encoding="utf-8")
        return dest

    # ── execution ──────────────────────────────────────────────────────────

    def execute(
        self, task_id: str, harness_dir: Path | None, run_id: str, *, timeout: int | None = None
    ) -> Path:
        """One rollout. `harness_dir=None` means the unmodified base harness."""
        task_dir = self._stage(task_id)
        install = self.substrate.materialise(
            Path(harness_dir) if harness_dir else self.base_harness(),
            self.spec,
            {},
        )
        dirs = self.substrate.execute(
            str(task_dir), install, [run_id], int(timeout or self.timeout)
        )
        return dirs[0]

    def delivered(self, run_dir: Path) -> bool:
        """The runner decides; read its report rather than re-deriving the rule."""
        report = self._runner_report(run_dir)
        if report is None:
            return False
        runs = (report.get("runner") or {}).get("runs") or []
        return bool(runs and runs[0].get("delivered"))

    def rollout_ok(self, run_dir: Path) -> bool:
        """Did this rollout do real work, as opposed to merely leaving a directory?

        Two opposite mistakes are on record here, so the predicate is stated
        once, precisely:

        - `run_dir.exists()` was too loose. The substrate creates the run
          directory BEFORE invoking the runner, so a rollout that died in argv
          parsing still had one — with a report saying `ok: false`. Measured on
          sw-20261031-160905: all four labels rejected their own `--run-id`
          (71 chars, over the runner's 64-char path limit) and the sweep spent
          minutes of proposer calls against 224-byte empty trajectories.

        - `runs[0].ok` alone was too strict. A team that finished its work and
          then went quiet trips the n2 stall watchdog, which reports
          `ok: false, delivered: true` with 426 tool calls behind it. Measured
          on sw-20261031-163112: a complete sol/ plus a 15.8 KB REPORT.md, and
          the sweep aborted at `base-failed` before any improvement ran, burning
          10366 s and $205.80 for nothing.

        So: usable means the runner got far enough to report at all, AND the
        rollout either succeeded, delivered, or demonstrably called tools. An
        empty `runs` list (argv rejection, crash before any rollout started) is
        still a failure — there is no work to reason about.
        """
        report = self._runner_report(run_dir)
        if report is None:
            return False
        runs = (report.get("runner") or {}).get("runs") or []
        if not runs:
            return False
        r0 = runs[0] or {}
        if r0.get("ok") or r0.get("delivered"):
            return True

        # A rollout killed at its timeout also reports ok:false while having
        # done real work; tool calls are the durable proof (same rule myco-runner
        # uses for its `delivered` gate).
        return int(r0.get("toolCalls") or 0) > 0

    def _runner_report(self, run_dir: Path) -> dict | None:
        try:
            return json.loads((Path(run_dir) / "runner-report.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def trajectory(self, run_dir: Path, *, obs_trunc: int) -> str:
        return self.substrate.read_trajectory(
            Path(run_dir), obs_trunc=obs_trunc, max_chars=self.spec.obs_trunc
        )

    # ── deliverables ───────────────────────────────────────────────────────

    def _workspace(self, run_dir: Path) -> Path:
        return Path(run_dir) / "workspace"

    def _seeded(self, task_id: str) -> set[str]:
        try:
            f = self._meta_dir(task_id) / "seeded.json"
            return set(json.loads(f.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            return set()

    def deliverable_files(self, run_dir: Path) -> dict[str, str]:
        """Files the agent CHANGED, as name -> readable text.

        Only text files, and only ones the agent actually touched: the method is
        read by the SELECTOR to compare behaviour, so a 2 MB binary would cost
        context while telling it nothing.

        "Touched" is decided by CONTENT, not by name. Excluding every seeded
        filename was wrong the moment a task ships a working starting point:
        the seed contains sol/zcomp.c, so an agent that tuned that file — the
        entire point of the task — reported zero deliverables, the selection
        pool came up empty and the sweep died with "no candidate produced an
        artifact". Measured on sw-20261101-080841: 8 rollouts, 4 of them with
        real edits to sol/zcomp.c, all dropped. `isDelivered` in the runner
        already compares hashes for exactly this reason; this is the same rule.
        """
        ws = self._workspace(run_dir)
        if not ws.is_dir():
            return {}
        task_id = self._task_id_for_run(run_dir)
        seeded = self._seeded(task_id) if task_id else set()
        seed_dir = self._task_dir(task_id) if task_id else None
        out: dict[str, str] = {}
        for p in sorted(ws.rglob("*")):
            if not p.is_file():
                continue
            rel = p.relative_to(ws)
            if any(part in {".claude", "_myco_", ".myco_harness", "node_modules", ".git"}
                   for part in rel.parts):
                continue
            key = rel.as_posix()
            if key == "task.md":
                continue
            if key in seeded:
                # A seeded file is a deliverable only if it DIFFERS from the seed.
                if seed_dir is None or _same_content(p, Path(seed_dir) / rel):
                    continue
            try:
                if p.stat().st_size > 512 * 1024:
                    continue
                out[key] = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
        return out

    def _task_id_for_run(self, run_dir: Path) -> str | None:
        try:
            meta = json.loads((Path(run_dir) / "meta.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        td = meta.get("task_dir")
        return Path(td).name if td else None

    def deliverable_text(self, run_dir: Path) -> str:
        """Everything the agent produced, as one text blob."""
        files = self.deliverable_files(run_dir)
        if not files:
            return ""
        parts = []
        for name in sorted(files):
            parts.append(f"--- {name} ---\n{files[name].rstrip()}")
        return "\n\n".join(parts)

    # ── harness ────────────────────────────────────────────────────────────

    def base_harness(self) -> Path:
        """The unmodified c1..c8 tree this benchmark starts from.

        `HARNESS2_MYCO_BASE_HARNESS` names an explicit tree. Without it the base
        is generated from the project's OWN current .claude/, which makes the
        baseline honest: it measures how this project works today, so a tuned
        harness has to beat the state it actually has rather than a generic
        default nobody ran.
        """
        explicit = os.environ.get("HARNESS2_MYCO_BASE_HARNESS", "").strip()
        if explicit:
            p = Path(explicit).expanduser().resolve()
            if not p.is_dir():
                raise config.ConfigError(f"HARNESS2_MYCO_BASE_HARNESS={p} is not a directory")
            return p
        if self._staged and (self._staged / ".staged-base").exists():
            return self._staged

        dest = Path(tempfile.mkdtemp(prefix="harness2-myco-base-"))
        claude_md = self.project / "CLAUDE.md"
        (dest / "systemprompt.md").write_text(
            claude_md.read_text(encoding="utf-8") if claude_md.is_file() else "",
            encoding="utf-8",
        )
        for name in ("guardrails.md", "LongTermMEMORY.md",
                     "tool_descriptions/tool_guidance.md"):
            (dest / name).parent.mkdir(parents=True, exist_ok=True)
            (dest / name).write_text("", encoding="utf-8")
        for src_rel, dst_rel in (
            (".claude/agents", "sub_agents"),
            (".claude/skills", "skills"),
            (".myco_harness/scripts", "scripts"),
        ):
            src = self.project / src_rel
            if not src.is_dir():
                continue
            for f in src.rglob("*"):
                if not f.is_file():
                    continue
                if dst_rel == "sub_agents":
                    # myco stores <name>.md flat; the surface wants <name>/AGENT.md.
                    rel = Path(f.stem) / "AGENT.md"
                else:
                    rel = f.relative_to(src)
                dst = dest / dst_rel / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, dst)
        (dest / ".staged-base").write_text("1", encoding="utf-8")
        self._staged = dest
        return dest

    def validate_tree(self, tree: dict[str, str]) -> None:
        """Surface validation already runs in core.tree; this adds the one myco
        invariant a proposal can plausibly break: a sub-agent file must carry the
        frontmatter myco's loader needs, or it is silently skipped at runtime."""
        problems = []
        for rel in tree:
            m = re.fullmatch(r"sub_agents/([^/]+)/AGENT\.md", rel)
            if not m:
                continue
            body = tree[rel] or ""
            fm = re.match(r"^---\r?\n(.*?)\r?\n---", body, re.S)
            if not fm:
                problems.append(
                    f"{rel} has no front-matter. myco reads `description:` from it to decide "
                    f"when to delegate; without front-matter the sub-agent is loaded but can "
                    f"never be chosen. Add:\n---\nname: {m.group(1)}\ndescription: <when to use it>\n---"
                )
                continue
            if not re.search(r"^description:\s*\S", fm.group(1), re.M):
                problems.append(
                    f"{rel} front-matter has no `description:`. That field is how the main "
                    f"agent knows when to delegate; without it the sub-agent is dead weight."
                )
        if problems:
            raise ValueError("\n\n".join(problems))

    # ── preflight ──────────────────────────────────────────────────────────

    def preflight(self) -> None:
        """Adapter-level checks, run by harness2-check before anything is spent."""
        inline_task = os.environ.get("HARNESS2_MYCO_TASK", "").strip()
        if not inline_task:
            raise RuntimeError(
                "HARNESS2_MYCO_TASK is not set — pass a task via "
                "`/harness run <task>` or set the env var directly"
            )
        tasks = self.tasks()
        if not tasks:
            raise RuntimeError("No tasks available — ensure HARNESS2_MYCO_TASK is non-empty.")
        # Domain assignment is a per-item lookup; a bad layer on the only item
        # would surface mid-sweep otherwise.
        for t in tasks:
            self.domain_of(t)
        base = self.base_harness()
        if not any(base.iterdir()):
            raise RuntimeError(f"the base harness at {base} is empty")
        self.substrate.preflight()

    # ── scoring ────────────────────────────────────────────────────────────

    def score(self, run_dir: Path, task_id: str) -> dict | None:
        """No rubric exists for "was this work item handled well".

        Returning None is the honest answer and not a failure: `None` means NOT
        JUDGED, which core/judge.py excludes from the denominator, whereas a 0
        would be cached as "this harness scored zero". A judge can be added later
        (the plan suggests "do the tests pass" for code items); until one exists,
        the method's own selection — which never reads a score — is the verdict.
        """
        return None


__all__ = ["MycoAdapter", "myco_spec", "MYCO_BASE"]
