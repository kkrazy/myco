# Harness² n2 team mode — design gaps D1–D6 and follow-up fixes

> **Scope:** six commits on top of `origin/develop`:
> `7242bd3` (D1–D6), `4b73a30` (k default review decision),
> `716f616` + `a241bb9` + `25b9565` + `92e468b` (three runner/evidence
> bug fixes ported from the k=2 n2 experiment, plus their test wiring).
> All touch only `vendor/harness2/`, `bench/harness2/`,
> `server/src/` harness² glue, and `test/test.sh`.
>
> **What this finishes:** the integration of dual-agent (n2) team
> rollouts with the harness² tuning loop (`/harness run --n2`). The
> plumbing existed end-to-end, but the feature silently degraded in six
> places; three more runner/evidence bugs surfaced when the combination
> was first run at scale (a k=2 n2 sweep over a codec-tuning task).

---

## 1. Background

**myco** is a web-based multi-user environment for Claude Code sessions.
A session runs a single agent (`AgentSession`) or a two-worker team
(`TeamSession`): worker-A and worker-B share a task, a queue, and a
coordination board (`board.jsonl` — claims, dones, cross-check notes,
apply verdicts). Teams are used interactively via `/run-n2` and
`/compare`.

**Harness²** (vendored at `vendor/harness2/`) is an offline
harness-tuning loop: it runs *rollouts* of a task under a candidate
harness (the c1–c8 component tree: system prompt, guardrails, skills,
sub-agents, scripts …), has *improvement sessions* (propose INV/DOM,
then aggregate) read the rollout *trajectories* and edit the tree, then
a blind *selector* picks the best candidate's artifact. Its only
evidence about a rollout is the rendered trajectory text — myco tasks
have no score (`MycoAdapter.score()` returns `None`: no rubric exists
for "was this work item handled well"), so **trajectories are the only
signal the whole loop optimizes against**.

`/harness run --n2` makes the loop's *rollouts* be teams: the same
`TeamSession` machinery as `/run-n2`, driven headlessly by the runner.
Each defect below was verified on the pre-fix tree; each fix came with
a regression test that was **red-flipped** (fails on the pre-fix tree,
passes on the fixed tree) and wired into `./test/test.sh`.

## 2. The six gaps

### D1 — the n2 components were untunable (`7242bd3`)

The three team components — `worker_a_startup.md`,
`worker_b_startup.md`, `board_guidance.md` — override the built-in
worker startup prompts and board protocol when a team session starts
(`readN2Components()` in [bench/harness2/lib/engine.js](../../../../bench/harness2/lib/engine.js)
collects them; `TeamSession`'s constructor accepts the overrides). They
are harness-tree members, so tuning them is the entire point of team
mode. But harness²'s surface gate (`read_tree` → `is_allowed`,
[vendor/harness2/harness2/core/tree.py](../../../../vendor/harness2/harness2/core/tree.py))
knew no such paths: an improver that emitted any of the three files had
its **whole proposal rejected** with a misleading naming-rules error —
and a tree that merely *carried* an untouched `board_guidance.md`
(e.g. seeded by `/harness init n2`) failed too.

**Fix:** a new opt-in `SurfaceSpec.extra_editable` field (exact paths
allowed on the surface in addition to the regex families), honored by
`is_allowed`. `MYCO_SURFACE`
([vendor/harness2/harness2/substrate/myco.py](../../../../vendor/harness2/harness2/substrate/myco.py))
lists the three files. Deliberately **not** `always_on`: these files
never compose into the single-agent `CLAUDE.md`; they ride the `n2:`
sentinel path unchanged. OpenCode/Codex surfaces set nothing — zero
behavior change there. (Design note: the field must NOT be added to the
stub-path list, which is a *skip* list in `read_tree` — that would hide
the files instead of allowing them.)

**Test:** `ExtraEditableTest` in
[vendor/harness2/tests/test_myco_bench.py](../../../../vendor/harness2/tests/test_myco_bench.py)
(4 cases), wired into `test/test.sh`.

### D2 — team trajectories had no worker dimension and no board (`7242bd3`)

The trajectory is the only evidence (see §1). For n2 rollouts it was
rendered as worker-A's whole journal, then worker-B's
(`=== Worker A ===` / `=== Worker B ===` in
[bench/harness2/myco-runner.js](../../../../bench/harness2/myco-runner.js)):
chronology across workers destroyed, no line attributable to a worker,
and — worst — `board.jsonl` (the *coordination* evidence: who claimed
what, cross-checks, conflicts, waits) never rendered at all. Improvers
were tuning team behavior with zero visibility into the team.

**Fix:** `mergeTeamEvents(workerFiles, boardFile, opts)` in
[bench/harness2/lib/transcript.js](../../../../bench/harness2/lib/transcript.js).
It parses both worker journals (events stamped `{ts: ISO, …}`) and the
board journal (rows `{timeNs: epoch-ms, actor, kind, payload}`),
defensively (dirty JSONL lines skip — a kill mid-append truncates the
last line), and merges all three **by timestamp** into one stream. Every
line is tagged by its source file, extending the shared trajectory
grammar (CONTRACT.md §8) additions-only, so the Python reader needs no
change:

```text
[ACTION]      worker=worker-A tool=Bash input={"command":"ls"}
[OBSERVATION] worker=worker-B …
[OBSERVATION] worker=board kind=board event=done item="q-1" summary="…"
[ASSISTANT]   worker=worker-A …
```

Three deliberate rules: worker identity comes from the source file,
never in-band fields; board rows are metadata, clipped by the small
`argsTrunc` budget so they cannot eat the `obs_trunc` budget real tool
output needs; a board `apply` verdict of `conflict` renders as an
**observation, not an `[ERROR]`** — routine coordination read as
defects would poison every reflection. Equal timestamps keep
deterministic file order (A, then B, then board). `myco-runner.js`'s n2
path now calls this instead of concatenating.

**Test:** 7 new `mergeTeamEvents` cases in
[bench/harness2/transcript.test.js](../../../../bench/harness2/transcript.test.js)
(interleave order, board events at correct positions, dirty-line skip,
conflict-as-observation, missing files, truncation floor/cap,
deterministic ties); the module's suite is 27/27.

### D3 — improvement prompts couldn't read team trajectories (`7242bd3`)

With D2 done, a merged team trajectory is in front of the improver — but
nothing taught the `worker=` / `kind=board` grammar, and the surface
tables in the prompts didn't list the three n2 files, so an improver
that noticed `board_guidance.md` in its workspace had no documented slot
for it.

**Fix:** a shared `_TEAM_TRAJECTORY_NOTE` in
[vendor/harness2/harness2/core/prompts.py](../../../../vendor/harness2/harness2/core/prompts.py),
appended to **all five** myco improvement-prompt paths (tts propose,
tts aggregate, adapt propose, adapt aggregate, sequential aggregate) via
a new opt-in `_SurfaceText.team_note` field. It teaches the grammar,
what good team behavior looks like (non-overlapping split, peer FACT/FAIL
cross-checks, few waits, no avoidable conflicts), and where to change
what: coordination failure → `board_guidance.md` /
`worker_*_startup.md`; wrong work with a fine split → ordinary component
files. Both myco surface tables list the three files as "ONLY in n2
rollouts … never composed into `CLAUDE.md`". OpenCode/Codex prompts are
byte-stable (pinned by test).

### D4 — adopting a tuned team harness lost it twice (`7242bd3`)

`/harness adopt`/`install` copied every mapped harness file into the
session workspace — including the `n2:` *sentinel strings*
(`mapHarnessPath` returns `n2:worker_a_startup` for these files), which
became **literal files named `n2:worker_a_startup`**: junk nothing
reads, components silently gone (the market install path skipped
sentinels correctly; the adopt path was missed). And even leak-free,
nothing consumed adopted team components: the interactive `/run-n2` lane
(`startN2Lane` in [server/src/compare-lanes.js](../../../../server/src/compare-lanes.js))
constructed `TeamSession` with no overrides, so the "adopt takes effect
on the next run" promise didn't hold for team mode.

**Fix:** a shared `_resolveHarnessPath` in
[server/src/harness-result.js](../../../../server/src/harness-result.js)
maps `n2:` sentinels to real files — `.myco_harness/n2/<name>.md` — and
is used by **all three consumers** (diff, adopt copy, snapshot), so
`/harness rollback` restores exactly what adopt wrote. `startN2Lane`
reads `.myco_harness/n2/` and passes the three overrides to
`TeamSession` (the constructor already accepted them); `/compare`'s n2
lane inherits this for free. The adopt reply lists the n2 files it
installed and says the next `/run-n2` runs with them.

**Verified at runtime** (not just statically): adopt a tree containing
the three files → they land under `.myco_harness/n2/`, no `n2:*` junk;
`startN2Lane` picks them up; rollback removes them; a session with no
adopted harness gets `null` overrides = byte-identical legacy behavior.

### D5 — team sweeps hid cost and worker identity; k default stays 1 (`7242bd3` + `4b73a30`)

n2 rollouts cost ≈2× model per rollout (two workers) and ≈2× trajectory
tokens, and the live pane collapsed both workers into one anonymous
progress stream. **Fix:** the `/harness run --n2` confirmation states
the ≈2× cost; progress lines carry the worker.

The k default was decided in review (`4b73a30`): the original design
proposed defaulting `--n2` to k=2, because a k=1 sweep runs
`trivial_selection` (the selection pool is *exactly the k finals* —
[vendor/harness2/harness2/core/selection.py](../../../../vendor/harness2/harness2/core/selection.py)
`selection_pool` excludes base by design), so k=1 has no
*selection-level* contrast and the D6 selector never fires. The reviewer
counterpoint won: k=1 still has full *improver-level* contrast — inv1
and dom1 are each rolled out, and the aggregate judges both against the
base rollouts — at half the cost (≈4 rollouts vs ≈8, ×2 workers each).
**k stays 1 in every mode; `--k 2` is the explicit choice for selection
contrast.**

### D6 — the selector ignored the coordination trail (`7242bd3`)

The blind selector's taught criteria were artifact-only, so two team
harnesses with equivalent artifacts were indistinguishable no matter how
one duplicated work and sat in `wait`s while the other split cleanly —
and before D2 the trail wasn't even in its evidence.

**Fix:** a `_TEAM_SELECT_NOTE` in prompts.py — judge **both** the
artifact and the coordination trail (ties go to less board friction);
a rollout where one worker delivered and the other stalled is a *usable
data point about the harness* (worker engagement is a startup-prompt
property), not an automatic failure; visible effort (many board events,
rework) is cost, not diligence. Passed as a new `team_note` parameter of
`select()`, supplied by `run_selection` **only when the adapter's
surface has `extra_editable`** — i.e. myco opts in; other substrates'
selector prompts are byte-stable.

**Test:** [vendor/harness2/tests/prompts_test.py](../../../../vendor/harness2/tests/prompts_test.py)
(10 cases): all five improvement prompts carry the team note on myco and
not on opencode/codex; the surface tables list the n2 files; the
selector note appears with and is absent without the opt-in; and the
`run_selection` wiring is exercised end-to-end with a stub adapter/prop.

## 3. Follow-up fixes found by the first at-scale run

A k=2 n2 sweep over a codec-tuning task (two runs, 12 team rollouts)
surfaced three more shared-code bugs. None is n2-specific.

### 3.1 `materialiseHarness` wrote `n2:*` sentinel strings as files (`716f616`)

The runner-side twin of D4: `materialiseHarness` used the `n2:` sentinel
as a *destination path*, so every sweep rollout workspace got literal
files named `n2:worker_a_startup` etc. Consequences: junk visible to the
rollout agents; a **false `isDelivered` positive for every n2 rollout**
(rule 2 counts any non-seeded file as "added", and sentinel files are
not seeded); sentinel prompt text leaking into the selector's candidate
evidence. Also bit single-agent sweeps: any harness tree merely
*carrying* `board_guidance.md` produced the junk.

**Fix:** skip sentinel-mapped components in `materialiseHarness`
([bench/harness2/lib/engine.js](../../../../bench/harness2/lib/engine.js));
the overrides still reach the rollout through `readN2Components` →
`TeamSession` as intended.

**Test:** "n2 components are prompt overrides, never files on disk" in
[bench/harness2/engine.test.js](../../../../bench/harness2/engine.test.js)
(23 cases).

### 3.2 `ChannelSpec.timeout` was a hardcoded 3600 s wall (`92e468b`)

The per-session wall for every proposer/selector channel was fixed at
3600 s — structurally below the read time for a large evidence pool
(measured: ~1.2 MB mandatory evidence at ~32 s/turn; a successful
aggregate composition needed 4271 s). All 4 aggregate composition
sessions of the experiment's second run died mid-read with zero edits.

**Fix:** `ChannelSpec.timeout` is now `int | None`; `None` (the default)
resolves `HARNESS2_CHANNEL_TIMEOUT` (fallback 3600) in `__post_init__`.
Explicit caller timeouts still win; `resolve_channel_model` passes
`None` through. Sweeps raise the wall by run policy (env var), not by
editing code defaults.

**Test:** `tests.test_channel_timeout` (4 cases: default / env /
explicit wins / bad value names the variable).

### 3.3 `deliverable_files` filtered by size, not text-ness (`a241bb9`)

The adapter's deliverable reader capped files at 512 KB but never
checked that they were text; `read_text(errors="replace")` then
laundered any small binary into the selection pool's `produced.md`. A
337 KB PGO+LTO static library turned the agg/selector evidence into
50–80% replacement characters; both aggregate sessions burned their
entire budget navigating the mojibake and fell back to base.

**Fix:** `_looks_like_text()` in
[vendor/harness2/harness2/benchmarks/myco.py](../../../../vendor/harness2/harness2/benchmarks/myco.py)
— reject on a NUL byte or undecodable UTF-8 in the first 4 KB. Verified
against all six rollout workspaces of the experiment run: binaries out,
every real source/markdown deliverable in.

**Test:** two new cases in `DeliverableDetectTest`
([vendor/harness2/tests/test_myco_bench.py](../../../../vendor/harness2/tests/test_myco_bench.py));
`25b9565` wires the class (plus `tests.test_channel_timeout`) into
`test/test.sh`'s pinned unittest list — its 4 pre-existing cases were
env-independent but had never been wired.

## 4. Test evidence

| Check | Where | Result |
|---|---|---|
| `ExtraEditableTest` (D1) | `test/test.sh` unittest line | 4/4 green, red-flipped |
| `mergeTeamEvents` suite (D2) | `bench/harness2/transcript.test.js` | 27/27 incl. 7 new, red-flipped |
| `prompts_test.py` (D3/D6) | `test/test.sh` unittest line | 10/10 green, red-flipped |
| `test_harness_n2_roundtrip` (D4/D5) | `test/test.sh` static guard | 7/7 green, 7/7 red pre-fix |
| Sentinel-skip case (§3.1) | `bench/harness2/engine.test.js` | 23/23 green, red-flipped |
| Channel-timeout cases (§3.2) | `tests.test_channel_timeout` | 4/4 green, red-flipped |
| Text-ness cases (§3.3) | `DeliverableDetectTest` | 6/6 green, red-flipped |
| Full `./test/test.sh` | on the rebased tip | 927 ✓, 4 ✗ |

The 4 ✗ are environmental or pre-existing upstream: 3 Docker checks
(the build registry is DNS-unreachable from the dev host; identical on
a clean tree) and `test/fr-55-lean-ctx-mcp.test.js`, which fails
identically on `origin/develop` without any of these commits.

## 5. How to try it

```text
# in a myco session (server built from this branch):
/harness init n2          # seeds template incl. the three n2 files
# edit _harness_/template/*, then:
/harness install _harness_/template
# or run a tuning sweep whose rollouts are teams:
/harness run --n2 <task>          # k=1 by default; --k 2 for selection contrast
/harness status · /harness diff   # n2 files show under .myco_harness/n2/
/harness adopt                    # installs them; reply names the n2 files
/run-n2 <task>                    # next team run carries the adopted overrides
/harness rollback                 # removes them again
```

## 6. Non-goals

No n>2 rosters, no `server/src/` core changes beyond the named glue, no
cross-run board persistence, no team mode in the market surface.
`score()` stays `None` — contrast-based selection is the intended
semantics for this open-world substrate, not a gap.
