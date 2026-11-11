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

"""The myco substrate: rollouts run as isolated myco AgentSessions.

myco (https://github.com/kkrazy/myco) is a multi-user web surface around the Claude
Agent SDK. A rollout here is one `AgentSession` with its own workspace, driven by a
blocking Node CLI (`bench/harness2/myco-runner.js` in the myco checkout) whose
interface is frozen in that repo's `bench/harness2/CONTRACT.md`.

Install mode: `myco_workspace`. `materialise()` stages the c1..c8 tree as-is; the Node
runner performs the final mapping onto myco's own layout (`CLAUDE.md`,
`.claude/agents/<n>.md`, `.claude/tool_guidance.md`, `.myco_harness/scripts/`), because
that layout is myco's to define and it changes with myco, not with this file.

Two components of the generic surface are deliberately absent here:

* **c8 plugins/hooks.** myco's hook surface is DECLARATIVE — a JSON file of
  `log` / `note` / `deny` rules interpreted by myco itself — because loading
  executable code out of a session workspace would hand anyone who can write a
  file in it arbitrary code execution inside the server process that holds every
  other session's credentials. `core.tree.check_hooks` validates the Claude Code
  shape instead (`{"hooks": {"<Event>": [{"hooks": [{"type": "command", ...}]}]}}`),
  whose `type: "command"` entries are exactly that executable path. The two are
  incompatible by design, so `hooks_file` and `plugin_dir` are both None and c8
  stays a human-authored myco feature rather than a tunable component.
* **`mode: subagent` frontmatter.** myco reads `.claude/agents/<name>.md` with
  `name` / `description` / `tools` / `model` and has no mode field, so
  `subagent_requires_mode` is False.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Mapping

from .. import config
from ..core import runmark as RM
from ..core import tree as HT
from ..core.tree import SurfaceSpec
from .base import Install

# The runner's JSON contract version (CONTRACT.md §10). A runner that reports a
# different one has changed its field names or layout, and parsing it as if it
# had not is how a sweep ends up reading the wrong thing silently.
RUNNER_CONTRACT = 1

# Concurrency for a multi-run execute(). Each rollout is a full AgentSession in
# its own process on the myco host; the cap is about that host's memory and the
# model gateway's rate limit, not about correctness.
PHASE_WIDTH = 2

MYCO_SURFACE = SurfaceSpec(
    name="myco",
    always_on=(
        "systemprompt.md",
        "guardrails.md",
        "LongTermMEMORY.md",
        "tool_descriptions/tool_guidance.md",
    ),
    # Lower than OpenCode's 24k: myco composes CLAUDE.md with its own
    # best-practices block and the Claude Code preset prompt, so the project's
    # own always-on text starts from a smaller remaining budget.
    always_on_max=12_000,
    always_on_cap_reason=(
        "myco prepends its best-practices block and the claude_code preset prompt, so "
        "always-on text competes with the agent's output budget from a smaller base"
    ),
    skill_dir="skills",
    skill_name_rule="must_match",
    trigger_hint=(
        "Fix it by adding a trigger line naming `{name}` to systemprompt.md or "
        'guardrails.md, e.g. "When <the situation this skill handles>, load the '
        '`{name}` skill."'
    ),
    autotrigger_file="guardrails.md",
    trigger_line="- When {desc}, load the `{name}` skill.\n",
    # myco's .claude/agents/<name>.md has no mode field; see the module docstring.
    subagent_requires_mode=False,
    # Both None on purpose; see the module docstring.
    plugin_dir=None,
    hooks_file=None,
    compile_skill_scripts=True,
    stubs=(
        (
            "scripts/README.md",
            "<!-- c7: deterministic helpers. myco stages these at "
            ".myco_harness/scripts/<name>.py and pre-approves `python3 <that path>`, so "
            "an unattended rollout runs them without a permission prompt. Add one by "
            "emitting scripts/<name>.py. -->\n",
        ),
        (
            "sub_agents/README.md",
            "<!-- c5: delegated subagents, invoked with the Task tool in their OWN "
            "context. Add one as sub_agents/<name>/AGENT.md with frontmatter `name:` and "
            "`description:` (myco needs no mode field). -->\n",
        ),
        (
            "skills/README.md",
            "<!-- c6: on-demand skills, free until triggered. Add one as "
            "skills/<name>/SKILL.md with frontmatter `name:` matching the directory, and "
            "name it from an always-on file so it can fire. -->\n",
        ),
    ),
)


def _runner_path() -> Path:
    """Absolute path to myco-runner.js.

    `HARNESS2_MYCO_RUNNER` points straight at the file; `HARNESS2_MYCO_ROOT` points at
    a myco checkout and the standard location inside it is used.
    """
    explicit = os.environ.get("HARNESS2_MYCO_RUNNER", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    root = os.environ.get("HARNESS2_MYCO_ROOT", "").strip()
    if root:
        return (Path(root).expanduser() / "bench" / "harness2" / "myco-runner.js").resolve()
    raise config.ConfigError(
        "set HARNESS2_MYCO_ROOT to a myco checkout (or HARNESS2_MYCO_RUNNER to "
        "bench/harness2/myco-runner.js directly) so this substrate can find the runner"
    )


def _myco_src() -> Path:
    """`server/src` of the myco checkout the runner must require.

    The runner refuses to guess this, for a reason worth repeating here: myco's own
    bench/hle hardcodes a default that exists on one machine, and copying it turns a
    missing variable into a MODULE_NOT_FOUND deep inside a require chain.
    """
    explicit = os.environ.get("MYCO_SRC", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    root = os.environ.get("HARNESS2_MYCO_ROOT", "").strip()
    if root:
        return (Path(root).expanduser() / "server" / "src").resolve()
    raise config.ConfigError(
        "set MYCO_SRC to myco's server/src (or HARNESS2_MYCO_ROOT to the checkout)"
    )


def _node() -> str:
    return os.environ.get("HARNESS2_NODE", "node")


def render_events(
    stream_path: Path, *, obs_trunc: int, max_chars: int, args_trunc: int = 400
) -> str:
    """Read the runner's already-normalised trajectory.

    Unlike the OpenCode and Codex substrates, the rendering happens on the Node side
    (`bench/harness2/lib/transcript.js`), which is where the raw SDK events are. That
    module emits the same grammar this one would, marker for marker, so a trajectory
    from either substrate reads identically; duplicating the renderer in Python would
    give two implementations of one format and no way to notice them drifting.

    `obs_trunc` and `args_trunc` are applied there, at render time. They are accepted
    here so the Protocol signature matches and a caller's intent is visible, and the
    floor is re-checked because a caller that reached this function directly bypassed
    the CLI's own check.
    """
    if obs_trunc < 10_000:
        raise ValueError(
            f"obs_trunc={obs_trunc} is in the range that fabricates defects; "
            f"core/spec.py rejects anything below 10000"
        )
    p = Path(stream_path)
    # Accept either the trajectory file or the run directory holding it.
    if p.is_dir():
        p = p / "trajectory.txt"
    try:
        rendered = p.read_text(encoding="utf-8", errors="replace").strip()
    except OSError as e:
        return f"(failed to read trajectory: {e})"
    if not rendered:
        return "(no parseable events in trajectory)"
    if len(rendered) > max_chars:
        dropped = len(rendered) - max_chars
        rendered = rendered[:max_chars] + f"\n…(+{dropped} chars — render truncation)"
    return rendered


class MycoSubstrate:
    """Runs rollouts as isolated myco AgentSessions through the frozen runner CLI."""

    name = "myco"

    def __init__(self, out_root: Path | None = None) -> None:
        # Where run directories land. Defaults under the configured runs root so a
        # sweep's rollout artifacts sit beside its other outputs.
        self._out_root = Path(out_root) if out_root else (config.RUNS / "myco-rollouts")

    def surface(self) -> SurfaceSpec:
        return MYCO_SURFACE

    def materialise(self, tree_dir: Path, spec, ctx: Mapping[str, str]) -> Install:
        """Stage the c1..c8 tree verbatim for the Node runner to map.

        No rendering happens here. The mapping onto myco's layout belongs to the Node
        side because that layout is myco's own and moves with myco; splitting it across
        two languages would mean two places to update and one of them forgotten.
        """
        if spec.install_mode != "myco_workspace":
            raise ValueError(
                f"install_mode {spec.install_mode!r} is not the myco mode; this substrate "
                f"has exactly one: 'myco_workspace'"
            )
        tree_dir = Path(tree_dir)
        if not HT.is_tree(MYCO_SURFACE, tree_dir):
            raise ValueError(f"{tree_dir} is not a myco harness tree (no systemprompt.md)")
        staged = Path(tempfile.mkdtemp(prefix="adapt-myco-ws-"))
        for src in sorted(tree_dir.rglob("*")):
            if not src.is_file():
                continue
            rel = src.relative_to(tree_dir)
            dst = staged / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        # Integration files the benchmark rides along with the tree (`file:<rel>`).
        for key, value in ctx.items():
            if not key.startswith("file:"):
                continue
            rel = HT.normalize_rel(key[len("file:") :])
            dst = staged / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(value, encoding="utf-8")
        return Install(
            staging_dir=staged,
            fingerprint=RM.fingerprint(tree_dir),
            extras={
                "install_mode": "myco_workspace",
                **{k: v for k, v in ctx.items() if not k.startswith("file:")},
            },
        )

    def execute(
        self, task_ref: str, install: Install, run_ids: list[str], timeout: int
    ) -> list[Path]:
        """Invoke the runner once per run_id and return one run directory each.

        One invocation per run_id rather than a single `--k N` batch: the contract names
        run directories `<run-id>-<i>`, so a batch would produce `<first>-1..N` and the
        caller's own labels (`base1`, `inv2`, …) would be lost. Concurrency is kept by
        running the invocations in a small pool.

        A rollout that fails is a RESULT, not an exception: Harness² records failures as
        evidence, so this returns the run directory either way and leaves the verdict in
        the run's own `meta.json` / the runner's JSON.
        """
        runner = _runner_path()
        if not runner.is_file():
            raise config.ConfigError(f"myco runner not found at {runner}")
        env = {**os.environ, "MYCO_SRC": str(_myco_src())}
        out_root = self._out_root
        out_root.mkdir(parents=True, exist_ok=True)

        def one(rid: str) -> Path:
            # Harness²' run ids are namespaced (`bug-1/inv1`, `task/agg2`). The
            # runner rejects anything outside [A-Za-z0-9._-] because the id goes
            # into a path — a slash there would escape the output root. Encode
            # the separator instead of loosening that check: `safe` is what the
            # runner sees, and the caller still gets a run dir it can map back.
            safe = re.sub(r"[^A-Za-z0-9._-]", "-", rid)[:100] or "run"
            cmd = [
                _node(), str(runner),
                "--task-dir", str(task_ref),
                "--harness-dir", str(install.staging_dir),
                "--run-id", safe,
                "--out", str(out_root),
                "--timeout", str(int(timeout)),
                "--k", "1",
                # E3 fix: thread the spec's obs_trunc through to the renderer.
                # Without this the runner falls back to DEFAULT_OBS_TRUNC (12k)
                # instead of the spec value (50k), silently truncating trajectories
                # and degrading improvement quality.
                "--obs-trunc", str(int(os.environ.get("HARNESS2_OBS_TRUNC", "50000"))),
            ]
            # n2 substrate: pass --mode n2 to the runner so it uses TeamSession
            # instead of AgentSession for each rollout.
            if os.environ.get("HARNESS2_MYCO_ROLLOUT_MODE", "").strip() == "n2":
                cmd += ["--mode", "n2"]
            proc = subprocess.run(
                cmd, env=env, capture_output=True, text=True,
                # The runner enforces its own per-rollout timeout; this outer bound only
                # catches a runner that never returns at all, so it is deliberately
                # looser than the rollout's own.
                timeout=int(timeout) + 120,
                check=False,
            )
            run_dir = out_root / f"{safe}-1"
            self._record(run_dir, proc)
            return run_dir

        if len(run_ids) <= 1:
            return [one(r) for r in run_ids]
        with ThreadPoolExecutor(max_workers=min(PHASE_WIDTH, len(run_ids))) as pool:
            return list(pool.map(one, run_ids))

    @staticmethod
    def _record(run_dir: Path, proc: subprocess.CompletedProcess) -> None:
        """Persist the runner's own report beside the run so a failure is diagnosable.

        stdout is one JSON line (CONTRACT.md §4). When it is not, that is itself the
        finding — most often a runner that exited before its write flushed — so the raw
        text is kept rather than discarded.
        """
        run_dir.mkdir(parents=True, exist_ok=True)
        report: dict = {"exitCode": proc.returncode}
        line = (proc.stdout or "").strip().splitlines()
        if line:
            try:
                parsed = json.loads(line[-1])
                got = parsed.get("contract")
                if got != RUNNER_CONTRACT:
                    report["contractMismatch"] = (
                        f"runner reported contract={got!r}, this substrate speaks "
                        f"{RUNNER_CONTRACT}"
                    )
                report["runner"] = parsed
            except json.JSONDecodeError as e:
                report["unparseableStdout"] = f"{e}: {line[-1][:400]}"
        else:
            report["unparseableStdout"] = "runner produced no stdout"
        if proc.stderr:
            (run_dir / "runner.stderr.log").write_text(proc.stderr, encoding="utf-8")
        (run_dir / "runner-report.json").write_text(
            json.dumps(report, indent=2) + "\n", encoding="utf-8"
        )

    def read_trajectory(
        self, stream_path: Path, *, obs_trunc: int, max_chars: int, args_trunc: int = 400
    ) -> str:
        return render_events(
            Path(stream_path), obs_trunc=obs_trunc, max_chars=max_chars, args_trunc=args_trunc
        )

    def preflight(self) -> None:
        """Check node, the runner and the model gateway before any money is spent.

        Every failure names the command that fixes it, and nothing in the model chain
        starts: the runner's `--dry-run` calls no model.
        """
        node = _node()
        if shutil.which(node) is None:
            raise RuntimeError(
                f"node not found on PATH as {node!r}: install Node 20+ or set HARNESS2_NODE"
            )
        try:
            ver = subprocess.run(
                [node, "--version"], capture_output=True, text=True, timeout=30, check=True
            ).stdout.strip()
        except (OSError, subprocess.SubprocessError) as e:
            raise RuntimeError(f"`{node} --version` failed: {e}") from e
        major = 0
        if ver.startswith("v"):
            try:
                major = int(ver[1:].split(".", 1)[0])
            except ValueError:
                major = 0
        if major and major < 20:
            raise RuntimeError(
                f"node {ver} is too old; myco's SDK needs Node 20+ "
                f"(the agent SDK ships ESM-only)"
            )

        runner = _runner_path()
        if not runner.is_file():
            raise RuntimeError(
                f"myco runner not found at {runner}: set HARNESS2_MYCO_ROOT to a myco "
                f"checkout, or HARNESS2_MYCO_RUNNER to the file"
            )

        src = _myco_src()
        if not (src / "agent-session.js").is_file():
            raise RuntimeError(
                f"MYCO_SRC={src} does not contain agent-session.js — wrong directory?"
            )

        # Exercise the runner end to end without a model. This is the one check that
        # proves node, the CLI, the contract version and the on-disk layout all agree.
        with tempfile.TemporaryDirectory(prefix="adapt-myco-pre-") as td:
            tmp = Path(td)
            (tmp / "task").mkdir()
            (tmp / "task" / "task.md").write_text("preflight\n", encoding="utf-8")
            proc = subprocess.run(
                [_node(), str(runner), "--dry-run",
                 "--task-dir", str(tmp / "task"),
                 "--run-id", "preflight",
                 "--out", str(tmp / "out"),
                 "--timeout", "30"],
                capture_output=True, text=True, timeout=120, check=False,
            )
            if proc.returncode != 0:
                raise RuntimeError(
                    f"`myco-runner.js --dry-run` exited {proc.returncode}: "
                    f"{(proc.stdout or proc.stderr or '').strip()[:400]}"
                )
            lines = (proc.stdout or "").strip().splitlines()
            if not lines:
                raise RuntimeError("`myco-runner.js --dry-run` produced no stdout")
            try:
                doc = json.loads(lines[-1])
            except json.JSONDecodeError as e:
                raise RuntimeError(f"runner stdout is not one JSON line: {e}") from e
            if doc.get("contract") != RUNNER_CONTRACT:
                raise RuntimeError(
                    f"runner speaks contract {doc.get('contract')!r}, this substrate "
                    f"speaks {RUNNER_CONTRACT}; update whichever is older"
                )
            runs = doc.get("runs") or []
            if not runs or not Path(runs[0].get("run_dir", "")).is_dir():
                raise RuntimeError("runner reported no usable run directory")
            traj = Path(runs[0]["run_dir"]) / "trajectory.txt"
            if not traj.is_file():
                raise RuntimeError(f"runner wrote no trajectory at {traj}")

        # The gateway the rollouts will call. Checked last because the three above are
        # cheaper and a failure there makes this one meaningless.
        base = os.environ.get("ANTHROPIC_BASE_URL", "").strip()
        if not base:
            raise RuntimeError(
                "ANTHROPIC_BASE_URL is not set: rollouts would reach the SDK's default "
                "endpoint instead of myco's configured gateway"
            )
        if not (os.environ.get("ANTHROPIC_AUTH_TOKEN", "").strip()
                or os.environ.get("ANTHROPIC_API_KEY", "").strip()):
            raise RuntimeError(
                "neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY is set: every rollout "
                "would answer 'Not logged in · Please run /login'. Note that a `docker exec` "
                "into a myco container does NOT inherit these — they are loaded into PID 1 "
                "by the entrypoint, so export them explicitly or launch from mycod."
            )


__all__ = ["MYCO_SURFACE", "MycoSubstrate", "render_events", "RUNNER_CONTRACT"]
