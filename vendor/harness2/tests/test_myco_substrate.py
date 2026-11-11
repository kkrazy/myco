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

"""MycoSubstrate: surface shape, materialise layout, trajectory reading, preflight.

The parts that need neither node nor a model run unconditionally. The parts that
exercise the real runner CLI are skipped unless HARNESS2_MYCO_ROOT (or
HARNESS2_MYCO_RUNNER) points at a myco checkout, so this file is runnable in a bare
harness2 environment.

Run: python -m pytest tests/test_myco_substrate.py
     (or: python tests/test_myco_substrate.py)
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from harness2.core import tree as HT
from harness2.core.spec import INSTALL_MODES
from harness2.substrate import MYCO_SURFACE, MycoSubstrate
from harness2.substrate.base import Substrate
from harness2.substrate.myco import RUNNER_CONTRACT, render_events


def _runner_available() -> bool:
    if shutil.which(os.environ.get("HARNESS2_NODE", "node")) is None:
        return False
    try:
        from harness2.substrate.myco import _runner_path

        return _runner_path().is_file()
    except Exception:
        return False


NEEDS_RUNNER = unittest.skipUnless(
    _runner_available(),
    "set HARNESS2_MYCO_ROOT to a myco checkout (and have node on PATH) to run this",
)


def _valid_tree() -> dict[str, str]:
    """A minimal tree that core.tree.validate accepts for this surface."""
    t = {name: "" for name in MYCO_SURFACE.always_on}
    t["systemprompt.md"] = "# Role\n\nYou are careful.\n"
    t["guardrails.md"] = "- When counting ledger rows, load the `ledger` skill.\n"
    t["tool_descriptions/tool_guidance.md"] = "Prefer scripts/count.py over new Python.\n"
    t["scripts/count.py"] = "import csv, sys\nprint(len(list(csv.DictReader(open(sys.argv[1])))))\n"
    t["sub_agents/checker/AGENT.md"] = (
        "---\nname: checker\ndescription: checks columns\n---\nYou check columns.\n"
    )
    t["skills/ledger/SKILL.md"] = (
        "---\nname: ledger\ndescription: ledger counting\n---\nCount rows.\n"
    )
    return t


class _Spec:
    def __init__(self, install_mode: str = "myco_workspace") -> None:
        self.install_mode = install_mode


class SurfaceTest(unittest.TestCase):
    def test_install_mode_is_registered(self):
        # A mode missing from this tuple makes BenchSpec reject every myco cell.
        self.assertIn("myco_workspace", INSTALL_MODES)

    def test_satisfies_the_substrate_protocol(self):
        self.assertIsInstance(MycoSubstrate(), Substrate)

    def test_always_on_cap_is_lower_than_opencode(self):
        # myco prepends its best-practices block and the claude_code preset, so the
        # project's own always-on text starts from a smaller remaining budget.
        from harness2.substrate import OPENCODE_SURFACE

        self.assertLess(MYCO_SURFACE.always_on_max, OPENCODE_SURFACE.always_on_max)
        self.assertTrue(MYCO_SURFACE.always_on_cap_reason.strip())

    def test_c8_is_absent_on_purpose(self):
        # myco's hooks are DECLARATIVE (log / note / deny, interpreted by myco).
        # core.tree.check_hooks validates the Claude Code shape, whose
        # {"type": "command"} entries execute shell — which myco refuses to load out
        # of a session workspace. Declaring hooks_file would therefore make every
        # myco-shaped hooks.json fail validation, and declaring the Claude Code shape
        # would make myco refuse to load it. Both stay None.
        self.assertIsNone(MYCO_SURFACE.hooks_file)
        self.assertIsNone(MYCO_SURFACE.plugin_dir)

    def test_subagents_need_no_mode_frontmatter(self):
        # myco reads name / description / tools / model; there is no mode field.
        self.assertFalse(MYCO_SURFACE.subagent_requires_mode)

    def test_a_myco_shaped_tree_passes_the_shared_validator(self):
        census = HT.validate(MYCO_SURFACE, _valid_tree())
        self.assertEqual(census["skills"], 1)
        self.assertEqual(census["sub_agents"], 1)
        self.assertEqual(census["scripts"], 1)

    def test_an_untriggered_skill_is_rejected(self):
        # A skill no always-on file names can never fire, so it is dead weight that
        # still costs the proposer a component slot.
        t = _valid_tree()
        t["guardrails.md"] = "- Be careful.\n"
        with self.assertRaises(ValueError) as cm:
            HT.validate(MYCO_SURFACE, t)
        self.assertIn("ledger", str(cm.exception))

    def test_a_script_that_does_not_compile_is_rejected(self):
        t = _valid_tree()
        t["scripts/count.py"] = "def broken(:\n"
        with self.assertRaises(ValueError):
            HT.validate(MYCO_SURFACE, t)


class MaterialiseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="myco-sub-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.tree_dir = self.tmp / "tree"
        HT.write_tree(MYCO_SURFACE, _valid_tree(), self.tree_dir, stubs=False)
        self.sub = MycoSubstrate(out_root=self.tmp / "out")

    def _staged(self, install):
        return sorted(
            p.relative_to(install.staging_dir).as_posix()
            for p in install.staging_dir.rglob("*")
            if p.is_file()
        )

    def test_stages_the_tree_verbatim(self):
        # No rendering here: the mapping onto myco's own layout happens on the Node
        # side, because that layout moves with myco.
        inst = self.sub.materialise(self.tree_dir, _Spec(), {})
        self.assertIn("systemprompt.md", self._staged(inst))
        self.assertIn("sub_agents/checker/AGENT.md", self._staged(inst))
        self.assertIn("scripts/count.py", self._staged(inst))
        self.assertEqual(inst.extras["install_mode"], "myco_workspace")
        self.assertTrue(inst.fingerprint)

    def test_file_ctx_entries_ride_along(self):
        inst = self.sub.materialise(self.tree_dir, _Spec(), {"file:extra/note.md": "hi\n"})
        self.assertIn("extra/note.md", self._staged(inst))
        self.assertEqual((inst.staging_dir / "extra" / "note.md").read_text(), "hi\n")

    def test_non_file_ctx_entries_become_extras(self):
        inst = self.sub.materialise(self.tree_dir, _Spec(), {"model": "GLM"})
        self.assertEqual(inst.extras["model"], "GLM")

    def test_a_ctx_path_that_escapes_is_refused(self):
        with self.assertRaises(ValueError):
            self.sub.materialise(self.tree_dir, _Spec(), {"file:../escape.md": "x"})

    def test_the_wrong_install_mode_is_refused(self):
        with self.assertRaises(ValueError) as cm:
            self.sub.materialise(self.tree_dir, _Spec("codex_root"), {})
        self.assertIn("myco_workspace", str(cm.exception))

    def test_a_directory_that_is_not_a_tree_is_refused(self):
        empty = self.tmp / "empty"
        empty.mkdir()
        with self.assertRaises(ValueError):
            self.sub.materialise(empty, _Spec(), {})


class TrajectoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="myco-traj-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_reads_the_runner_rendered_trajectory(self):
        # Rendering happens in bench/harness2/lib/transcript.js, where the raw SDK
        # events are. Duplicating it here would give two implementations of one
        # format and no way to notice them drifting.
        f = self.tmp / "trajectory.txt"
        f.write_text('[ACTION] Bash({"command":"ls"})\n[OBSERVATION] a.txt\n', encoding="utf-8")
        got = render_events(f, obs_trunc=12000, max_chars=200000)
        self.assertIn("[ACTION] Bash(", got)
        self.assertIn("[OBSERVATION] a.txt", got)

    def test_accepts_a_run_directory_as_well_as_the_file(self):
        run_dir = self.tmp / "r-1"
        run_dir.mkdir()
        (run_dir / "trajectory.txt").write_text("[ASSISTANT] done\n", encoding="utf-8")
        self.assertEqual(render_events(run_dir, obs_trunc=12000, max_chars=1000), "[ASSISTANT] done")

    def test_a_missing_trajectory_reports_the_reason(self):
        # A rollout that died before journalling is a normal outcome; the caller
        # records it as evidence rather than crashing the sweep.
        got = render_events(self.tmp / "nope.txt", obs_trunc=12000, max_chars=1000)
        self.assertTrue(got.startswith("(failed to read trajectory:"))

    def test_an_empty_trajectory_uses_the_shared_sentinel(self):
        f = self.tmp / "trajectory.txt"
        f.write_text("   \n", encoding="utf-8")
        self.assertEqual(
            render_events(f, obs_trunc=12000, max_chars=1000),
            "(no parseable events in trajectory)",
        )

    def test_max_chars_tail_truncates_with_the_shared_marker(self):
        f = self.tmp / "trajectory.txt"
        f.write_text("[OBSERVATION] " + "x" * 5000, encoding="utf-8")
        got = render_events(f, obs_trunc=12000, max_chars=100)
        self.assertTrue(got.endswith("chars — render truncation)"))
        self.assertIn("…(+", got)

    def test_obs_trunc_below_the_floor_is_refused(self):
        f = self.tmp / "trajectory.txt"
        f.write_text("[OBSERVATION] x\n", encoding="utf-8")
        with self.assertRaises(ValueError) as cm:
            render_events(f, obs_trunc=4000, max_chars=1000)
        self.assertIn("fabricates defects", str(cm.exception))


@NEEDS_RUNNER
class RunnerIntegrationTest(unittest.TestCase):
    """Exercises the real Node CLI through --dry-run. No model is called."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="myco-run-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.task = self.tmp / "task"
        self.task.mkdir()
        (self.task / "task.md").write_text("count the rows\n", encoding="utf-8")

    def _dry_run(self, run_id: str):
        from harness2.substrate.myco import _runner_path

        proc = subprocess.run(
            [os.environ.get("HARNESS2_NODE", "node"), str(_runner_path()), "--dry-run",
             "--task-dir", str(self.task), "--run-id", run_id,
             "--out", str(self.tmp / "out"), "--timeout", "30"],
            capture_output=True, text=True, timeout=120, check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = proc.stdout.strip().splitlines()
        self.assertEqual(len(lines), 1, f"stdout must be one JSON line, got:\n{proc.stdout}")
        return json.loads(lines[0])

    def test_the_runner_speaks_the_contract_version_we_parse(self):
        # A mismatch means field names or the layout moved; parsing on regardless is
        # how a sweep silently reads the wrong thing.
        self.assertEqual(self._dry_run("ct")["contract"], RUNNER_CONTRACT)

    def test_dry_run_produces_a_trajectory_this_module_can_read(self):
        doc = self._dry_run("tr")
        run_dir = Path(doc["runs"][0]["run_dir"])
        got = render_events(run_dir, obs_trunc=12000, max_chars=200000)
        self.assertIn("[ACTION]", got)
        self.assertIn("[OBSERVATION]", got)

    def test_preflight_passes_every_check_before_the_gateway(self):
        # Clearing the gateway variables makes the LAST check the one that fires,
        # which proves node, the runner, the contract version and the on-disk layout
        # all passed. A green run needs a configured gateway, which a bare harness2
        # environment does not have.
        saved = {k: os.environ.pop(k, None)
                 for k in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY")}
        self.addCleanup(lambda: os.environ.update({k: v for k, v in saved.items() if v}))
        with self.assertRaises(RuntimeError) as cm:
            MycoSubstrate().preflight()
        self.assertIn("ANTHROPIC_BASE_URL", str(cm.exception))

    def test_a_namespaced_run_id_does_not_break_the_runner(self):
        # Harness² names run ids by task and label (`bug-1/inv1`). The runner
        # rejects anything outside [A-Za-z0-9._-] because the id becomes a path
        # segment, so the substrate must encode the separator instead of passing
        # it through. Found live: every rollout reported "--run-id must match"
        # and the sweep ended with "no candidate produced an artifact".
        from harness2.substrate.myco import _runner_path
        import json as _json

        out = Path(tempfile.mkdtemp(prefix="myco-ns-"))
        self.addCleanup(shutil.rmtree, out, ignore_errors=True)
        proc = subprocess.run(
            [os.environ.get("HARNESS2_NODE", "node"), str(_runner_path()), "--dry-run",
             "--task-dir", str(self.task),
             "--run-id", "bug-1-inv1",
             "--out", str(out), "--timeout", "30"],
            capture_output=True, text=True, timeout=120, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        doc = _json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertTrue(doc["runs"][0]["delivered"], "the sanitised id must run normally")


    def test_preflight_names_the_docker_exec_pitfall(self):
        # A `docker exec` into a myco container inherits none of the ANTHROPIC_*
        # variables (the entrypoint loads them into PID 1), so every rollout answers
        # "Not logged in". Measured during P1 verification; the message must say so.
        saved = {k: os.environ.pop(k, None)
                 for k in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY")}
        os.environ["ANTHROPIC_BASE_URL"] = "http://example.invalid"
        self.addCleanup(lambda: os.environ.update({k: v for k, v in saved.items() if v}))
        self.addCleanup(lambda: os.environ.pop("ANTHROPIC_BASE_URL", None))
        with self.assertRaises(RuntimeError) as cm:
            MycoSubstrate().preflight()
        self.assertIn("docker exec", str(cm.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
