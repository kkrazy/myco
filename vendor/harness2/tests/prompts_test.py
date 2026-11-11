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

"""Team-mode prompt content (D3) and selection semantics (D6).

The myco substrate's n2 rollouts emit worker-tagged trajectories with board
events (bench/harness2/lib/transcript.js mergeTeamEvents). That grammar is
model-read text: if the improvement prompts never teach it, the merged stream
degrades from "read the coordination" to "guess at the tags". And if the
selector is never told that a stalled worker is a data point, a team harness
whose startup prompts failed worker-B reads as a fine harness.

These tests pin presence on myco and absence everywhere else — the notes are
opt-in via the surface, so OpenCode/Codex prompts must stay byte-stable.

Run: python -m unittest tests.prompts_test
"""

from __future__ import annotations

import unittest

from harness2.benchmarks.myco import MYCO_BASE
from harness2.benchmarks.workbuddy import SUBSETS, spec_for
from harness2.core import prompts as P
from harness2.substrate.myco import MYCO_SURFACE


def _workbuddy_prompts(substrate: str):
    """The prompts of the first workbuddy subset on `substrate`."""
    subset = sorted(SUBSETS)[0]
    return spec_for(subset, substrate).prompts


class TeamImprovementPromptTest(unittest.TestCase):
    """D3: every myco improvement prompt teaches the team grammar."""

    def _assert_team_note(self, rendered: str, what: str) -> None:
        self.assertIn("READING A TEAM TRAJECTORY", rendered, f"{what} must carry the team note")
        for needle in (
            "worker=worker-A",
            "kind=board",
            "board_guidance.md",
            "worker_a_startup.md",
            "verdict=\"conflict\"",
        ):
            self.assertIn(needle, rendered, f"{what} must teach {needle}")

    def test_myco_propose_inv_carries_the_team_note(self):
        self._assert_team_note(P.propose(MYCO_BASE, "INV", MYCO_SURFACE), "propose INV")

    def test_myco_propose_dom_carries_the_team_note(self):
        self._assert_team_note(P.propose(MYCO_BASE, "DOM", MYCO_SURFACE), "propose DOM")

    def test_myco_aggregate_carries_the_team_note(self):
        self._assert_team_note(P.aggregate(MYCO_BASE, MYCO_SURFACE), "aggregate")

    def test_myco_surface_tables_list_the_n2_files(self):
        # The improver must see the three files as legitimate tree members,
        # or D1's editable-surface widening is invisible to the model.
        inv = P.propose(MYCO_BASE, "INV", MYCO_SURFACE)
        for name in ("worker_a_startup.md", "worker_b_startup.md", "board_guidance.md"):
            self.assertIn(name, inv)
        self.assertIn("never composed into `CLAUDE.md`", inv)

    def test_non_team_substrate_prompts_are_untouched(self):
        for substrate in ("opencode", "codex"):
            bp = _workbuddy_prompts(substrate)
            for dim in ("INV", "DOM"):
                self.assertNotIn(
                    "TEAM TRAJECTORY", P.propose(bp, dim, substrate),
                    f"{substrate} has no teams; its prompts must stay byte-stable")
            self.assertNotIn("TEAM TRAJECTORY", P.aggregate(bp, substrate))

    def test_sequential_mode_propose_carries_the_note_too(self):
        out = P.propose(MYCO_BASE, "INV", MYCO_SURFACE, round_t=1)
        self._assert_team_note(out, "seq-mode propose")


class TeamSelectPromptTest(unittest.TestCase):
    """D6: the selector judges coordination, and a stalled worker is data."""

    def _assert_team_select(self, rendered: str, what: str) -> None:
        self.assertIn("WHEN THE RUNS WERE TEAMS", rendered, what)
        self.assertIn("board friction", rendered, f"{what}: less friction wins ties")
        self.assertIn("stalled", rendered, f"{what}: the stall rule must be present")

    def test_myco_select_with_team_note(self):
        out = P.select(MYCO_BASE, 2, pool_kind="finals", team_note=P._TEAM_SELECT_NOTE)
        self._assert_team_select(out, "select finals")

    def test_myco_select_mixed_pool_with_team_note(self):
        out = P.select(MYCO_BASE, 3, pool_kind="mixed", team_note=P._TEAM_SELECT_NOTE)
        self._assert_team_select(out, "select mixed")

    def test_default_select_has_no_team_note(self):
        # run_selection passes team_note only when the surface opts in; the
        # default call shape must not grow team wording by itself.
        out = P.select(MYCO_BASE, 2, pool_kind="finals")
        self.assertNotIn("WHEN THE RUNS WERE TEAMS", out)

    def test_run_selection_passes_team_note_for_myco(self):
        # The wiring, not just the capability: run_selection derives the note
        # from the adapter's surface. A stub adapter isolates the branch.
        from harness2.core import selection as S

        captured: dict = {}

        class _Prop:
            def call(self, mission, context_dir, label, **kw):
                captured["mission"] = mission

                class _Reply:
                    text = "```choice\nbase1\n```\n<why>picked base</why>"
                    cost_usd = 0.0
                    attempts = 1
                    cached = False

                return _Reply()

        class _Adapter:
            class spec:  # noqa: N801 - protocol stand-in
                state_deliverable = False
                leak_globs: tuple = ()
                prompts = MYCO_BASE

            def __init__(self):
                from harness2.substrate.myco import MycoSubstrate

                class _Sub:
                    def surface(self):
                        return MYCO_SURFACE

                self.substrate = _Sub()

            def deliverable_text(self, run_dir):
                return "artifact text"

            def task_prompt(self, task_id):
                return "the task"

        import tempfile
        from pathlib import Path

        tmp = Path(tempfile.mkdtemp(prefix="h2-select-test-"))
        self.addCleanup(__import__("shutil").rmtree, tmp, ignore_errors=True)
        for label in ("base1", "agg1"):
            d = tmp / label
            d.mkdir()
            (d / "x.txt").write_text("artifact text", encoding="utf-8")

        from harness2.core.spec import RunView

        candidates = {
            lbl: RunView(label=lbl, run_id=lbl, run_dir=tmp / lbl, ok=True, delivered=True)
            for lbl in ("base1", "agg1")
        }
        sel = S.run_selection(
            "inline-task", 1, "agg", candidates,
            adapter=_Adapter(), prop=_Prop(), work_dir=tmp, pool_kind="finals",
        )
        self.assertIn("WHEN THE RUNS WERE TEAMS", captured["mission"],
                      "run_selection must pass the team note for a surface with n2 components")
        self.assertTrue(sel.ok or sel.chosen_label, "the stub selection must resolve")


if __name__ == "__main__":
    unittest.main(verbosity=2)
