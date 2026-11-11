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

"""MycoAdapter: task source, leakage boundaries, staging, deliverables, preflight.

The task source is the part that decides what a sweep even measures, and two of
its failure modes are silent: leaking a previous attempt's conclusion into the
next task prompt, and treating a closed item as work. Both have explicit tests
here.

Run: python -m unittest tests.test_myco_bench
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from harness2.benchmarks.myco import MycoAdapter, myco_spec


def _plan(items: list[dict]) -> dict:
    return {"version": 1, "items": items}


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="myco-bench-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.project = self.tmp / "proj"
        (self.project / "_myco_").mkdir(parents=True)
        (self.tmp / "README.md").write_text("# proj" + chr(10), encoding="utf-8")
        self.write_plan([
            {"id": "bug-1", "layer": "Bug", "done": False,
             "text": "The load-older button loops past page 5."},
            {"id": "fr-7", "layer": "Feature", "done": False,
             "text": "Add a dark-mode toggle to the header."},
            {"id": "td-3", "layer": "Todo", "done": False,
             "text": "Bump node to 22 in the Dockerfile."},
        ])
        self._saved = os.environ.get("HARNESS2_MYCO_PROJECT")
        self._saved_stage_root = os.environ.get("MYCO_STAGE_ROOT")
        os.environ["HARNESS2_MYCO_PROJECT"] = str(self.project)
        # Keep staging inside this test's tmpdir: the default root is a shared
        # data volume now, so an unpinned fixture would write there and read
        # whatever an earlier run left behind.
        os.environ["MYCO_STAGE_ROOT"] = str(self.tmp / "staging")
        # The adapter builds a MycoSubstrate, which resolves the runner lazily, so
        # construction works without a myco checkout.

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("HARNESS2_MYCO_PROJECT", None)
        else:
            os.environ["HARNESS2_MYCO_PROJECT"] = self._saved
        if getattr(self, "_saved_stage_root", None) is None:
            os.environ.pop("MYCO_STAGE_ROOT", None)
        else:
            os.environ["MYCO_STAGE_ROOT"] = self._saved_stage_root

    def write_plan(self, items):
        (self.project / "_myco_" / "plan.json").write_text(
            json.dumps(_plan(items)), encoding="utf-8")

    def adapter(self) -> MycoAdapter:
        return MycoAdapter(project=self.project)


class TaskSourceTest(_Base):
    def test_open_items_are_tasks_in_plan_order(self):
        self.assertEqual(self.adapter().tasks(), ["bug-1", "fr-7", "td-3"])

    def test_a_closed_item_is_not_work(self):
        # Tuning against a shipped item would reward re-doing it.
        self.write_plan([
            {"id": "bug-1", "layer": "Bug", "done": True, "text": "already fixed"},
            {"id": "bug-2", "layer": "Bug", "done": False, "text": "still broken"},
        ])
        self.assertEqual(self.adapter().tasks(), ["bug-2"])

    def test_an_item_with_no_text_is_skipped(self):
        self.write_plan([
            {"id": "bug-1", "layer": "Bug", "done": False, "text": "   "},
            {"id": "bug-2", "layer": "Bug", "done": False, "text": "real"},
        ])
        self.assertEqual(self.adapter().tasks(), ["bug-2"])

    def test_an_unusable_id_is_skipped_rather_than_crashing_the_sweep(self):
        self.write_plan([
            {"id": "../../etc/passwd", "layer": "Bug", "done": False, "text": "x"},
            {"id": "bug-2", "layer": "Bug", "done": False, "text": "real"},
        ])
        self.assertEqual(self.adapter().tasks(), ["bug-2"])

    def test_the_domain_is_the_layer(self):
        a = self.adapter()
        self.assertEqual(a.domain_of("bug-1"), "Bug")
        self.assertEqual(a.domain_of("fr-7"), "Feature")
        self.assertEqual(a.domain_of("td-3"), "Todo")
        self.assertEqual(a.reference_domain_order(), ["Bug", "Feature", "Todo"])

    def test_an_unknown_layer_is_an_error_not_a_silent_default(self):
        # Silently bucketing into the wrong domain would pool unrelated items in
        # the experience library.
        self.write_plan([{"id": "x-1", "layer": "Weird", "done": False, "text": "t"}])
        with self.assertRaises(ValueError) as cm:
            self.adapter().domain_of("x-1")
        self.assertIn("Bug/Feature/Todo", str(cm.exception))

    def test_the_plan_is_read_fresh_so_a_closed_item_drops_out(self):
        a = self.adapter()
        self.assertEqual(len(a.tasks()), 3)
        self.write_plan([
            {"id": "bug-1", "layer": "Bug", "done": True, "text": "x"},
            {"id": "fr-7", "layer": "Feature", "done": False, "text": "y"},
        ])
        # No cache: a sweep must not keep working an item that just closed.
        self.assertEqual(a.tasks(), ["fr-7"])

    def test_a_missing_plan_names_the_problem(self):
        (self.project / "_myco_" / "plan.json").unlink()
        with self.assertRaises(ValueError) as cm:
            self.adapter().tasks()
        self.assertIn("plan", str(cm.exception).lower())

    def test_broken_json_names_the_file(self):
        (self.project / "_myco_" / "plan.json").write_text("{not json", encoding="utf-8")
        with self.assertRaises(ValueError) as cm:
            self.adapter().tasks()
        self.assertIn("plan.json", str(cm.exception))


class PromptLeakTest(_Base):
    def test_the_prompt_is_the_item_text_alone(self):
        self.assertEqual(self.adapter().task_prompt("bug-1"),
                         "The load-older button loops past page 5.")

    def test_run_summaries_and_comments_never_reach_the_prompt(self):
        # A run-summary is what a PREVIOUS rollout concluded. Feeding it back
        # hands the answer to the next candidate and destroys the contrast the
        # method runs on.
        self.write_plan([{
            "id": "bug-1", "layer": "Bug", "done": False,
            "text": "The load-older button loops past page 5.",
            "comments": [
                {"user": "claude", "text": "✓ success · 2m18s · fixed by resetting page",
                 "meta": {"kind": "run-summary"}},
                {"user": "a", "text": "try paging backwards instead"},
            ],
            "runs": [{"status": "success", "summary": "resetting page fixed it"}],
            "voters": ["a", "b"],
        }])
        prompt = self.adapter().task_prompt("bug-1")
        for leaked in ("fixed by resetting page", "paging backwards", "success", "voters"):
            self.assertNotIn(leaked, prompt, f"{leaked!r} leaked into the task prompt")

    def test_a_rewritten_item_prefers_the_rewrite(self):
        self.write_plan([{
            "id": "bug-9", "layer": "Bug", "done": False,
            "text": "Problem: paging loops.\nExpected: stop at page 5.\nActual: wraps.",
            "meta": {"originalText": "paging is broken"},
        }])
        self.assertIn("Expected:", self.adapter().task_prompt("bug-9"))

    def test_an_item_with_empty_text_falls_back_to_the_original(self):
        self.write_plan([{
            "id": "bug-9", "layer": "Bug", "done": False, "text": "",
            "meta": {"originalText": "paging is broken"},
        }])
        self.assertEqual(self.adapter().task_prompt("bug-9"), "paging is broken")


class SpecTest(unittest.TestCase):
    def test_the_spec_uses_the_myco_install_mode(self):
        spec = myco_spec()
        self.assertEqual(spec.name, "myco")
        self.assertEqual(spec.install_mode, "myco_workspace")
        self.assertEqual(spec.obs_trunc, 50_000)

    def test_plan_json_is_declared_a_leak_glob(self):
        # plan.json names the item under test and carries every previous run's
        # verdict; an improvement session reading it would see the answer.
        self.assertIn("plan.json", myco_spec().leak_globs)

    def test_prompts_describe_work_not_measurement(self):
        # BenchPrompts refuses the words benchmark/evaluation/grader/rubric/score;
        # constructing the spec already proves it, but keep the intent explicit.
        spec = myco_spec()
        self.assertIn("work item", spec.prompts.work)

    def test_the_wrong_substrate_is_refused(self):
        with self.assertRaises(ValueError) as cm:
            MycoAdapter(substrate="oc", project=Path(tempfile.gettempdir()))
        self.assertIn("myco", str(cm.exception))


class StagingTest(_Base):
    def test_staging_writes_the_prompt_and_the_project_files(self):
        # The runner copies the CONTENTS of the task dir into the rollout workspace,
        # so project files must sit BESIDE task.md. Nesting them under workspace/
        # reproduced as <ws>/workspace/app.py and the agent saw an empty project.
        staged = self.adapter()._stage("bug-1")
        self.assertEqual((staged / "task.md").read_text(encoding="utf-8").strip(),
                         self.adapter().task_prompt("bug-1"))
        self.assertTrue((staged / "README.md").is_file(),
                        sorted(p.name for p in staged.iterdir()))
        self.assertFalse((staged / "workspace").exists(),
                         "a nested workspace/ directory would be copied in verbatim")

    def test_staging_excludes_the_myco_directory_and_git(self):
        # _myco_/plan.json is the answer key for this very task.
        (self.project / "_myco_" / "plan.json").exists()
        (self.project / ".git").mkdir()
        (self.project / ".git" / "config").write_text("x", encoding="utf-8")
        staged = self.adapter()._stage("bug-1")
        self.assertFalse((staged / "_myco_").exists(), "_myco_ must never be staged")
        self.assertFalse((staged / ".git").exists(), ".git would only add cost")

    def test_staging_bookkeeping_is_kept_out_of_the_task_dir(self):
        # A marker or seed list inside the task dir would be copied into the
        # workspace as if it were project content.
        staged = self.adapter()._stage("bug-1")
        names = {p.name for p in staged.iterdir()}
        self.assertNotIn("staged", names)
        self.assertNotIn(".staged", names)
        self.assertNotIn("seeded.json", names)
        self.assertNotIn(".seeded.json", names)


class StagingSizeTest(unittest.TestCase):
    """A task's own data must reach the agent, and nothing may vanish silently.

    `_restricted_project` used one flat 2 MB per-file cap. That number was
    chosen to keep bulk content out of the PROPOSER's context, but the same
    staging directory is also the agent's task input, so a codec task whose
    corpus is twelve 5-51 MB Silesia files ran with no data at all. Measured on
    the test server: the agent spent its first tool calls on `find /` and found
    the corpus only because a sibling session happened to share the box. The
    fix is two configurable budgets; the tests here pin both the capability and
    the reporting, because a silently dropped corpus looks exactly like a task
    that never had one.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="myco-stagesize-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "README.md").write_text("# proj" + chr(10), encoding="utf-8")
        self._saved = {
            k: os.environ.get(k) for k in
            ("HARNESS2_MYCO_PROJECT", "HARNESS2_MYCO_TASK",
             "MYCO_STAGE_MAX_FILE_MB", "MYCO_STAGE_MAX_TOTAL_MB")
        }
        os.environ["HARNESS2_MYCO_PROJECT"] = str(self.tmp)
        # Unique per test instance. Staging is keyed by a hash of the task TEXT
        # and lives under the shared tempdir, so two tests sharing a prompt
        # share a staging directory: the second finds the first's `staged`
        # marker, skips staging entirely, and asserts against stale state.
        os.environ["HARNESS2_MYCO_TASK"] = f"compress the corpus ({self.tmp.name})"
        self.addCleanup(self._purge_staging)

    def _purge_staging(self):
        """Drop this test's staging dir so a re-run starts cold.

        test_* files must own their state (test.sh guideline (c)); without this
        the assertions below pass or fail depending on what an earlier run left
        in the shared tempdir.
        """
        proj = os.environ.get("HARNESS2_MYCO_PROJECT")
        os.environ["HARNESS2_MYCO_PROJECT"] = str(self.tmp)
        try:
            adapter = MycoAdapter(project=self.tmp)
            shutil.rmtree(adapter._task_dir("inline-task"), ignore_errors=True)
            shutil.rmtree(adapter._meta_dir("inline-task"), ignore_errors=True)
        finally:
            if proj is not None:
                os.environ["HARNESS2_MYCO_PROJECT"] = proj

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _stage(self):
        adapter = MycoAdapter(project=self.tmp)
        return adapter, adapter._stage("inline-task")

    def test_a_large_task_input_is_staged_at_full_size(self):
        big = self.tmp / "dataset"
        big.mkdir()
        (big / "dickens").write_bytes(b"x" * (3 * 1024 * 1024))

        _, staged = self._stage()

        self.assertTrue((staged / "dataset" / "dickens").is_file(),
                        "a 3 MB task input must be staged, not dropped")
        self.assertEqual((staged / "dataset" / "dickens").stat().st_size,
                         3 * 1024 * 1024,
                         "and at full size — a truncated corpus silently changes the task")

    def test_an_over_limit_file_is_reported_not_silently_dropped(self):
        (self.tmp / "huge.txt").write_bytes(b"x" * (2 * 1024 * 1024))
        os.environ["MYCO_STAGE_MAX_FILE_MB"] = "1"

        adapter, staged = self._stage()

        self.assertFalse((staged / "huge.txt").exists(), "over the per-file cap")
        self.assertTrue((staged / "README.md").is_file(), "and the rest still stages")
        report = json.loads(
            (adapter._meta_dir("inline-task") / "skipped.json").read_text(encoding="utf-8"))
        self.assertEqual([r["path"] for r in report], ["huge.txt"])
        self.assertEqual(report[0]["reason"], "over_file_limit")

    def test_the_report_lives_outside_the_task_dir(self):
        # Anything inside the staged dir is copied into the rollout workspace as
        # project content, so bookkeeping there would become a fake deliverable.
        (self.tmp / "huge.txt").write_bytes(b"x" * (2 * 1024 * 1024))
        os.environ["MYCO_STAGE_MAX_FILE_MB"] = "1"

        attacker, staged = self._stage()

        self.assertFalse((staged / "skipped.json").exists(),
                         "the skip report must not land in the staged task dir")
        self.assertTrue((attacker._meta_dir("inline-task") / "skipped.json").is_file())

    def test_nothing_is_reported_for_a_project_inside_the_budgets(self):
        adapter, _ = self._stage()
        report = json.loads(
            (adapter._meta_dir("inline-task") / "skipped.json").read_text(encoding="utf-8"))
        self.assertEqual(report, [], "a project inside the budgets must not warn")


class StageRootTest(unittest.TestCase):
    """Staged tasks must not land in /tmp by default.

    A staged task is a full copy of the project, so one per distinct task text.
    In the container /tmp is overlay storage (~10 GB) while /data is the host's
    ~2 TB volume; the first Silesia-sized task was 200 MB and the runner copies
    it into 4k rollout workspaces, so /tmp fills long before /data does.
    Observed: /tmp/harness2-myco-tasks/ held 202 MB of staged corpus on a
    container with 9.9 GB left on the overlay.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="myco-stageroot-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "proj").mkdir()
        (self.tmp / "proj" / "README.md").write_text("# p" + chr(10), encoding="utf-8")
        self._saved = {k: os.environ.get(k) for k in
                       ("HARNESS2_MYCO_PROJECT", "HARNESS2_MYCO_TASK",
                        "MYCO_STAGE_ROOT", "MYCO_DATA")}
        os.environ["HARNESS2_MYCO_PROJECT"] = str(self.tmp / "proj")
        os.environ["HARNESS2_MYCO_TASK"] = "root probe " + self.tmp.name

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_explicit_stage_root_wins(self):
        explicit = self.tmp / "staging"
        os.environ["MYCO_STAGE_ROOT"] = str(explicit)
        adapter = MycoAdapter(project=self.tmp / "proj")
        self.assertEqual(adapter._stage_root(), explicit)
        adapter._stage("inline-task")
        self.assertTrue((explicit / adapter._staging_key / "task.md").is_file(),
                        "the staged task must land under the explicit root")

    def test_data_volume_is_preferred_over_tmp(self):
        data = self.tmp / "data"
        data.mkdir()
        os.environ.pop("MYCO_STAGE_ROOT", None)
        os.environ["MYCO_DATA"] = str(data)
        adapter = MycoAdapter(project=self.tmp / "proj")
        self.assertEqual(adapter._stage_root(), data / "harness2-task-cache",
                         "a writable data volume must be used instead of /tmp")
        self.assertTrue(adapter._stage_root().is_dir(), "and created, not just named")

    def test_falls_back_to_tmp_without_a_data_volume(self):
        os.environ.pop("MYCO_STAGE_ROOT", None)
        os.environ.pop("MYCO_DATA", None)
        adapter = MycoAdapter(project=self.tmp / "proj")
        root = adapter._stage_root()
        # On a dev box /data does not exist, so the fallback must apply; on a
        # host that HAS /data the volume is the right answer and this test just
        # confirms it picked a real directory.
        self.assertTrue(root.is_dir(), "the staging root must exist")
        if not Path("/data").is_dir():
            self.assertEqual(root, Path(tempfile.gettempdir()) / "harness2-myco-tasks")


class DeliverableTest(_Base):
    def setUp(self):
        super().setUp()
        self.run_dir = self.tmp / "run-1"
        self.ws = self.run_dir / "workspace"
        self.ws.mkdir(parents=True)
        # Simulate a staged task: seeded files plus a task.md.
        (self.ws / "README.md").write_text("# proj\n", encoding="utf-8")
        (self.ws / "task.md").write_text("do it\n", encoding="utf-8")
        (self.ws / ".seeded.json").parent.mkdir(parents=True, exist_ok=True)
        # Staging now lives under _stage_root(), which prefers a data volume.
        # Pin it into this test's own tmpdir: a fixture that writes into the
        # shared root both pollutes other runs and depends on what they left.
        os.environ["MYCO_STAGE_ROOT"] = str(self.tmp / "staging")
        td = self.adapter()._task_dir("bug-1")
        td.mkdir(parents=True, exist_ok=True)
        meta = self.adapter()._meta_dir("bug-1")
        meta.mkdir(parents=True, exist_ok=True)
        (meta / "seeded.json").write_text(json.dumps(["README.md"]), encoding="utf-8")
        (self.run_dir / "meta.json").write_text(
            json.dumps({"task_dir": str(td)}), encoding="utf-8")

    def test_only_changed_files_count_as_deliverables(self):
        a = self.adapter()
        self.assertEqual(a.deliverable_files(self.run_dir), {}, "nothing changed yet")
        (self.ws / "app.js").write_text("fixed\n", encoding="utf-8")
        files = a.deliverable_files(self.run_dir)
        self.assertIn("app.js", files)
        self.assertNotIn("README.md", files, "a seeded input is not a deliverable")
        self.assertNotIn("task.md", files, "the prompt is not a deliverable")

    def test_harness_and_myco_directories_are_not_deliverables(self):
        (self.ws / ".claude" / "agents").mkdir(parents=True)
        (self.ws / ".claude" / "agents" / "a.md").write_text("x", encoding="utf-8")
        (self.ws / "_myco_").mkdir()
        (self.ws / "_myco_" / "events.jsonl").write_text("{}", encoding="utf-8")
        self.assertEqual(self.adapter().deliverable_files(self.run_dir), {})

    def test_deliverable_text_joins_files_with_headers(self):
        (self.ws / "out.txt").write_text("3\n", encoding="utf-8")
        text = self.adapter().deliverable_text(self.run_dir)
        self.assertIn("--- out.txt ---", text)
        self.assertIn("3", text)

    def test_delivered_reads_the_runner_report(self):
        a = self.adapter()
        self.assertFalse(a.delivered(self.run_dir), "no report yet")
        (self.run_dir / "runner-report.json").write_text(json.dumps({
            "runner": {"runs": [{"run_id": "r1-1", "ok": True, "delivered": True}]},
        }), encoding="utf-8")
        self.assertTrue(a.delivered(self.run_dir))

    def test_a_corrupt_report_reads_as_not_delivered(self):
        (self.run_dir / "runner-report.json").write_text("{broken", encoding="utf-8")
        self.assertFalse(self.adapter().delivered(self.run_dir))


class ScoreTest(_Base):
    def test_score_is_none_because_no_rubric_exists(self):
        # None means NOT JUDGED and is excluded from the denominator; a 0 would be
        # cached as "this harness scored zero".
        self.assertIsNone(self.adapter().score(Path(tempfile.gettempdir()), "bug-1"))


class BaseHarnessTest(_Base):
    def test_the_base_harness_mirrors_the_project(self):
        (self.project / "CLAUDE.md").write_text("# project rules\n", encoding="utf-8")
        (self.project / ".claude" / "agents").mkdir(parents=True)
        (self.project / ".claude" / "agents" / "reviewer.md").write_text(
            "---\nname: reviewer\ndescription: d\n---\nbody\n", encoding="utf-8")
        (self.project / ".myco_harness" / "scripts").mkdir(parents=True)
        (self.project / ".myco_harness" / "scripts" / "count.py").write_text("print(1)\n",
                                                                            encoding="utf-8")
        base = self.adapter().base_harness()
        self.assertEqual((base / "systemprompt.md").read_text(encoding="utf-8"),
                         "# project rules\n")
        # myco's flat <name>.md becomes the surface's <name>/AGENT.md.
        agent = base / "sub_agents" / "reviewer" / "AGENT.md"
        self.assertTrue(agent.is_file(), sorted(p.as_posix() for p in base.rglob("*")))
        self.assertTrue((base / "scripts" / "count.py").is_file())
        for always_on in ("guardrails.md", "LongTermMEMORY.md",
                          "tool_descriptions/tool_guidance.md"):
            self.assertTrue((base / always_on).is_file(), always_on)

    def test_an_explicit_base_harness_wins(self):
        explicit = self.tmp / "explicit-base"
        explicit.mkdir()
        (explicit / "systemprompt.md").write_text("mine\n", encoding="utf-8")
        saved = os.environ.get("HARNESS2_MYCO_BASE_HARNESS")
        os.environ["HARNESS2_MYCO_BASE_HARNESS"] = str(explicit)
        self.addCleanup(lambda: os.environ.pop("HARNESS2_MYCO_BASE_HARNESS", None)
                        if saved is None else os.environ.__setitem__(
                            "HARNESS2_MYCO_BASE_HARNESS", saved))
        self.assertEqual(self.adapter().base_harness(), explicit.resolve())


class ValidateTreeTest(_Base):
    def test_a_subagent_without_frontmatter_is_rejected_with_the_fix(self):
        # myco loads the file but can never CHOOSE it without a description, so
        # the sub-agent becomes dead weight the proposer believes is active.
        with self.assertRaises(ValueError) as cm:
            self.adapter().validate_tree({"sub_agents/x/AGENT.md": "just a body\n"})
        msg = str(cm.exception)
        self.assertIn("front-matter", msg)
        self.assertIn("description:", msg, "the error must say what to add")

    def test_a_subagent_without_description_is_rejected(self):
        with self.assertRaises(ValueError) as cm:
            self.adapter().validate_tree({
                "sub_agents/x/AGENT.md": "---\nname: x\n---\nbody\n"})
        self.assertIn("description", str(cm.exception))

    def test_a_proper_subagent_passes(self):
        self.adapter().validate_tree({
            "sub_agents/x/AGENT.md": "---\nname: x\ndescription: use for checks\n---\nbody\n"})

    def test_other_components_are_left_to_the_shared_validator(self):
        self.adapter().validate_tree({"scripts/a.py": "print(1)\n"})


class PreflightTest(_Base):
    def test_an_empty_backlog_is_refused(self):
        # A sweep with no tasks would "succeed" while measuring nothing.
        self.write_plan([{"id": "bug-1", "layer": "Bug", "done": True, "text": "done"}])
        with self.assertRaises(RuntimeError) as cm:
            self.adapter().preflight()
        self.assertIn("no OPEN items", str(cm.exception))
        self.assertIn("/bug", str(cm.exception), "the message must say how to fix it")

    def test_a_missing_project_is_refused(self):
        with self.assertRaises(RuntimeError) as cm:
            MycoAdapter(project=self.tmp / "nowhere").preflight()
        self.assertIn("plan.json", str(cm.exception))


class RegistrationTest(unittest.TestCase):
    def test_the_cli_knows_the_bench_and_substrate(self):
        # Both tuples were hardcoded copies in several places; registering in one
        # is worth asserting because a miss surfaces as argparse rejecting a
        # benchmark that make_adapter already supports.
        from harness2.cli._common import BENCHES, SUBSTRATES

        self.assertIn("myco", BENCHES)
        self.assertIn("myco", SUBSTRATES)

    def test_check_accepts_myco(self):
        src = (Path(__file__).resolve().parents[1] / "harness2" / "cli" / "check.py")
        text = src.read_text(encoding="utf-8")
        self.assertIn("from ._common import BENCHES", text.replace("_common import BENCHES, SUBSTRATES, WB_SUBSETS", "_common import BENCHES, SUBSTRATES, WB_SUBSETS"),
                      "check.py must source its choices from _common, not a copy")


if __name__ == "__main__":
    unittest.main(verbosity=2)


class RolloutOkTest(unittest.TestCase):
    """A run DIRECTORY is not a successful rollout.

    MycoSubstrate creates the run dir before it invokes the runner, and
    _record() writes runner-report.json into it either way. schedule._roll_bases
    used `run_dir.exists()` as its success test, so a rollout that died in argv
    parsing counted as a good base: the sweep spent minutes of proposer calls
    against empty trajectories before anyone could see why.

    Observed on sw-20261031-160905 — every label rejected its own --run-id
    ("myco-myco-agg1-sess-…-inline-task-base1", 71 chars, over the runner's
    64-char path limit), report said ok:false, and the sweep kept going.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="myco-rolloutok-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "README.md").write_text("# p" + chr(10), encoding="utf-8")
        self._saved = {k: os.environ.get(k) for k in
                       ("HARNESS2_MYCO_PROJECT", "HARNESS2_MYCO_TASK", "MYCO_STAGE_ROOT")}
        os.environ["HARNESS2_MYCO_PROJECT"] = str(self.tmp)
        os.environ["HARNESS2_MYCO_TASK"] = "rollout ok probe"
        os.environ["MYCO_STAGE_ROOT"] = str(self.tmp / "staging")

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _adapter(self):
        return MycoAdapter(project=self.tmp)

    def _run(self, name, report):
        rd = self.tmp / "runs" / name
        rd.mkdir(parents=True)
        if report is not None:
            (rd / "runner-report.json").write_text(json.dumps(report), encoding="utf-8")
        return rd

    def test_a_rejected_run_is_not_ok(self):
        rd = self._run("rejected", {
            "exitCode": 1,
            "runner": {"contract": 1, "run_id": None, "ok": False, "runs": [],
                       "error": "--run-id must match ^[A-Za-z0-9._-]{1,64}$"}})
        self.assertFalse(self._adapter().rollout_ok(rd),
                         "a runner that exited on its own arguments did not run the rollout")

    def test_a_run_with_no_report_is_not_ok(self):
        rd = self._run("silent", None)
        self.assertFalse(self._adapter().rollout_ok(rd),
                         "no report means the runner never reported back")

    def test_a_report_with_no_runs_is_not_ok(self):
        rd = self._run("empty", {"exitCode": 0, "runner": {"ok": True, "runs": []}})
        self.assertFalse(self._adapter().rollout_ok(rd),
                         "a batch that produced zero rollouts has nothing to tune against")

    def test_a_failed_rollout_inside_a_successful_batch_is_not_ok(self):
        rd = self._run("failed-rollout", {
            "exitCode": 1,
            "runner": {"ok": True, "runs": [{"run_id": "r-1", "ok": False, "delivered": False}]}})
        self.assertFalse(self._adapter().rollout_ok(rd),
                         "runs[0].ok is the per-rollout verdict (CONTRACT.md §4.1)")

    def test_a_real_rollout_is_ok(self):
        rd = self._run("good", {
            "exitCode": 0,
            "runner": {"ok": True,
                       "runs": [{"run_id": "r-1", "ok": True, "delivered": True}]}})
        self.assertTrue(self._adapter().rollout_ok(rd),
                        "a rollout that ran must stay usable — the guard must not over-reject")

    def test_a_stalled_team_that_delivered_is_still_usable(self):
        # n2's stall watchdog fires when both workers go quiet after finishing:
        # ok:false with delivered:true. sw-20261031-163112 produced a complete
        # sol/ and a 15.8 KB REPORT.md (H1/H2/H3/H6/H7 passing, ratio 3.18% off
        # LZ4) and was thrown away — 10366 s and $205.80 spent, the sweep
        # aborted at base-failed before any improvement ran.
        rd = self._run("stalled-delivered", {
            "exitCode": 1,
            "runner": {"ok": True, "runs": [{
                "run_id": "r-1", "ok": False, "delivered": True,
                "wall_s": 10365.762, "turns": 2, "toolCalls": 426,
                "error": "stall (idle=485s)"}]}})
        self.assertTrue(self._adapter().rollout_ok(rd),
                        "a rollout that delivered is usable evidence, whatever the stop reason")

    def test_a_timed_out_rollout_with_tool_calls_is_still_usable(self):
        # Same rule myco-runner.js uses for its delivered gate: a rollout killed
        # at its timeout reaches zero turns while having done real work.
        rd = self._run("timeout-with-work", {
            "exitCode": 1,
            "runner": {"ok": True, "runs": [{
                "run_id": "r-1", "ok": False, "delivered": False,
                "wall_s": 18000, "turns": 0, "toolCalls": 51}]}})
        self.assertTrue(self._adapter().rollout_ok(rd),
                        "51 tool calls are proof of work even with no turn_result")

    def test_a_rejected_run_with_no_work_is_still_rejected(self):
        # The guard must not swing back to permissive: the argv-rejection case
        # has no runs at all and must stay a failure.
        rd = self._run("rejected-no-work", {
            "exitCode": 1,
            "runner": {"ok": False, "runs": [],
                       "error": "--run-id must match ^[A-Za-z0-9._-]{1,64}$"}})
        self.assertFalse(self._adapter().rollout_ok(rd),
                         "a runner that never started a rollout did not do work")

    def test_a_failed_rollout_with_no_work_is_not_usable(self):
        rd = self._run("failed-no-work", {
            "exitCode": 1,
            "runner": {"ok": True, "runs": [{
                "run_id": "r-1", "ok": False, "delivered": False, "toolCalls": 0}]}})
        self.assertFalse(self._adapter().rollout_ok(rd),
                         "nothing ran, nothing delivered, no tool calls — nothing to tune against")


class DeliverableDetectTest(unittest.TestCase):
    """A MODIFIED seed file is a deliverable; an untouched one is not.

    This is the same rule `isDelivered` uses in the runner, and it has to hold
    in BOTH places. Excluding by filename alone was correct only while a task
    had no starting implementation — the moment `sol/zcomp.c` was seeded as the
    working baseline, an agent that tuned it (the entire point) reported zero
    deliverables. Measured on sw-20261101-080841: 8 rollouts, 4 with real
    zcomp.c edits, the selection pool came up empty and the sweep died with
    "no candidate produced an artifact" after 20272 s.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="myco-detect-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.project = self.tmp / "proj"
        (self.project / "sol").mkdir(parents=True)
        (self.project / "sol" / "zcomp.c").write_text("/* seed */" + chr(10), encoding="utf-8")
        (self.project / "README.md").write_text("# p" + chr(10), encoding="utf-8")
        self._saved = {k: os.environ.get(k) for k in
                       ("HARNESS2_MYCO_PROJECT", "HARNESS2_MYCO_TASK", "MYCO_STAGE_ROOT")}
        os.environ["HARNESS2_MYCO_PROJECT"] = str(self.project)
        os.environ["HARNESS2_MYCO_TASK"] = "tune it " + self.tmp.name
        os.environ["MYCO_STAGE_ROOT"] = str(self.tmp / "staging")

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _run(self, mutate=None):
        """Stage the task, then lay out a rollout workspace from it."""
        a = MycoAdapter(project=self.project)
        staged = a._stage("inline-task")
        run_dir = self.tmp / "run-1"
        ws = run_dir / "workspace"
        shutil.copytree(staged, ws)
        (run_dir / "meta.json").write_text(
            json.dumps({"task_dir": str(staged)}), encoding="utf-8")
        if mutate:
            mutate(ws)
        return a, run_dir

    def test_an_untouched_seed_is_not_a_deliverable(self):
        a, run_dir = self._run()
        files = a.deliverable_files(run_dir)
        self.assertNotIn("sol/zcomp.c", files,
                         "a seed nobody touched is an input, not output")
        self.assertEqual(a.deliverable_text(run_dir), "",
                         "an idle run must render no artifact")

    def test_a_modified_seed_is_a_deliverable(self):
        def tune(ws):
            (ws / "sol" / "zcomp.c").write_text(
                "/* seed */" + chr(10) + "/* faster */" + chr(10), encoding="utf-8")
        a, run_dir = self._run(tune)
        files = a.deliverable_files(run_dir)
        self.assertIn("sol/zcomp.c", files,
                      "tuning the seeded implementation IS the deliverable")
        self.assertIn("faster", a.deliverable_text(run_dir),
                      "the selector must see the new code, not just its name")

    def test_a_new_file_is_a_deliverable(self):
        a, run_dir = self._run(lambda ws: (ws / "NOTES.md").write_text("hi" + chr(10),
                                                                      encoding="utf-8"))
        self.assertIn("NOTES.md", a.deliverable_files(run_dir))

    def test_a_same_size_different_content_edit_still_counts(self):
        # Hash comparison, not size: an in-place rewrite that keeps the length
        # (common in tuning — a constant changes) must still register.
        def swap(ws):
            (ws / "sol" / "zcomp.c").write_text("/* SEED */" + chr(10), encoding="utf-8")
        a, run_dir = self._run(swap)
        self.assertIn("sol/zcomp.c", a.deliverable_files(run_dir))


class StagingKeyTest(unittest.TestCase):
    """The staging directory must be keyed by the task TEXT, not just its id.

    Every inline task shares the id `inline-task`, so keying by id alone made
    the first task of a container permanent: its `staged` marker survived and a
    later sweep ran the PREVIOUS task's text while status.json reported the new
    one. Observed on the test server — a README task was still fed to the agent
    under a different prompt, across sessions and after a container rebuild.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="myco-stagekey-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "README.md").write_text("# proj\n", encoding="utf-8")
        self._saved = os.environ.get("HARNESS2_MYCO_PROJECT")
        os.environ["HARNESS2_MYCO_PROJECT"] = str(self.tmp)
        self._saved_task = os.environ.get("HARNESS2_MYCO_TASK")

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("HARNESS2_MYCO_PROJECT", None)
        else:
            os.environ["HARNESS2_MYCO_PROJECT"] = self._saved
        if self._saved_task is None:
            os.environ.pop("HARNESS2_MYCO_TASK", None)
        else:
            os.environ["HARNESS2_MYCO_TASK"] = self._saved_task

    def _adapter_with(self, text: str) -> MycoAdapter:
        os.environ["HARNESS2_MYCO_TASK"] = text
        return MycoAdapter(project=self.tmp)

    def test_different_text_yields_a_different_staging_dir(self):
        a1 = self._adapter_with("do the first thing")
        a2 = self._adapter_with("do the second thing")
        self.assertNotEqual(a1._task_dir("inline-task"), a2._task_dir("inline-task"),
                            "a new task must not reuse the previous task's staging dir")
        self.assertNotEqual(a1._meta_dir("inline-task"), a2._meta_dir("inline-task"),
                            "the staged marker must not survive into a new task")

    def test_same_text_is_idempotent(self):
        a1 = self._adapter_with("the same task")
        a2 = self._adapter_with("the same task")
        self.assertEqual(a1._task_dir("inline-task"), a2._task_dir("inline-task"),
                         "an unchanged task must still hit the cache")

    def test_staging_rewrites_task_md_when_text_changes(self):
        first = self._adapter_with("first task text")
        d1 = first._stage("inline-task")
        self.assertIn("first task text", (d1 / "task.md").read_text(encoding="utf-8"))
        # A new task with a different prompt must stage fresh content, not
        # return the first directory with its stale task.md.
        second = self._adapter_with("second task text")
        d2 = second._stage("inline-task")
        body = (d2 / "task.md").read_text(encoding="utf-8")
        self.assertIn("second task text", body)
        self.assertNotIn("first task text", body)
