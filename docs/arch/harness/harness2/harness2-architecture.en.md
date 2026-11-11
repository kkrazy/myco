# Harness² Architecture

Harness² is myco's automated harness tuning system. Give it a concrete code task and it generates multiple harness configuration variants, runs real rollouts against each one, blindly selects the best-performing variant, and returns it for adoption or publication.

## Overall Flow

```
/harness run [--n2] [--k N] <task description>
       │
       ▼
  harness-runner.js
  startSweep({ cwd, task, k, rolloutMode })
       │  writes status.json, spawns python3
       ▼
  run_sweep.py (harness² Python library)
       │
  ┌────┴────┐
  │ Propose │  propose → probe → compose
  │  phase  │  uses claude_local channel (local claude CLI)
  │         │  produces N harness variants (inv/dom/agg)
  └────┬────┘
       │ N harness variants
  ┌────┴────┐
  │ Execute │  each variant runs rollouts
  │  phase  │  myco-runner.js → AgentSession (single agent)
  │         │                → TeamSession  (--n2, dual agent)
  └────┬────┘
       │ rollout results (trajectory.txt + meta.json)
  ┌────┴────┐
  │  Select │  blind selection — looks at results, not harness content
  │  phase  │  selection.json (winner + rationale)
  └────┬────┘
       │
       ▼
  /harness diff → adopt → publish
```

## Module Structure

```
server/src/
  agents/harness2/       ← unified module entry point (mirrors agents/rlm/)
    index.js             ← façade, re-exports the three sub-modules
    runner.js            ── → harness-runner.js
    result.js            ── → harness-result.js
    market.js            ── → harness-market.js
  harness-runner.js      ← sweep lifecycle (startSweep / cancelSweep / getStatus / orphan cleanup)
                            also the derivation point for per-session isolation:
                            runsRootFor / sweepTagFor
  harness-result.js      ← diff / adopt / pull / rollback / snapshot
  harness-market.js      ← market publish / install / list
  harness-hooks.js       ← c8 hooks.json declarative hooks
  harness-scripts.js     ← .myco_harness/scripts/ pre-approved scripts

bench/harness2/
  myco-runner.js         ← CLI called by harness², once per rollout batch
                           supports --mode myco (single agent) and --mode n2 (dual agent)
  lib/
    engine.js            ← path mapping, materialise, runRollout, runRolloutN2
    transcript.js        ← trajectory rendering (events.jsonl → trajectory.txt)

vendor/harness2/
  harness2/
    benchmarks/myco.py   ← MycoAdapter (task source, preflight, stage_task)
    substrate/myco.py    ← MycoSubstrate (calls myco-runner.js)
    core/proposer.py     ← claude_local channel implementation
    core/spec.py         ← CHANNELS registration
    config.py            ← PROPOSER_MODEL_BY_CHANNEL
```

## Harness Component Mapping

Harness² stores configuration files in its own layout (c1..c8). `myco-runner.js` maps them to myco's paths during materialisation:

| harness² path | myco path | Purpose |
|---|---|---|
| `systemprompt.md` | `CLAUDE.md` | Role, workflow, rules |
| `guardrails.md` | `CLAUDE.md` (appended) | Prohibitions |
| `tool_guidance.md` | `.claude/tool_guidance.md` | Tool usage guidance |
| `hooks.json` | `.claude/hooks.json` | Declarative hooks |
| `sub_agents/<name>/AGENT.md` | `.claude/agents/<name>.md` | Sub-agents (flattened) |
| `skills/<name>/` | `.claude/skills/<name>/` | Reusable skills |
| `scripts/<name>.py` | `.myco_harness/scripts/<name>.py` | Pre-approved scripts |

### run-n2 Exclusive Components

These three components are not written to disk. They are injected directly into worker system prompts when `TeamSession` starts:

| harness² path | Purpose |
|---|---|
| `worker_a_startup.md` | Overrides `STARTUP_A` (worker-A task decomposition strategy) |
| `worker_b_startup.md` | Overrides `STARTUP_B` (worker-B environment exploration strategy) |
| `board_guidance.md` | Overrides `BOARD_COMMANDS + WAITING` (collaboration board protocol) |

Read path: `engine.readN2Components(harnessDir)` → passed into `new TeamSession({ workerAStartup, ... })`.

## Sweep Lifecycle

```
harness-runner.js
  startSweep({ cwd, task, k, rolloutMode })
    → generates sweep id (sw-<timestamp>)
    → writes _harness_/sweeps/<id>/status.json { status: 'running' }
    → spawns: python3 -m harness2.cli.run_sweep --bench myco --substrate myco --k <k>
        env: sweepEnv({ cwd, task, rolloutMode })
    → polls stderr for progress lines, emits chat events
    → sweep ends → writes result.json, updates status.json { status: 'success'|'failed' }
    → at server boot: scans _harness_/sweeps/*/run.pid to clean up orphan processes
```

## State Isolation: Three Boundaries

Several users and sessions share one container, so every piece of sweep state is
scoped.

| Layer | Scope | Location |
|---|---|---|
| sweep run tree | per (user, session) | `<MYCO_DATA>/harness2-runs/<user>/<session>/myco/{rollouts,adapt}` |
| namespace | one tag per session | `myco-myco-agg<k>-sess-<user>-<hex8>` |
| staging task dir | one per distinct task TEXT, shared across sessions | `<MYCO_STAGE_ROOT>/<staging-key>` |
| market items | personal per user; published global | `/data/market/` |

`sessionScope(cwd)` splits `/wks/<user>/<session-id>/…` into both. A cwd outside
that shape (tests, cross-mounted setups) falls back to `default/<basename>`, which
is still a stable non-shared area.

**The namespace tag has a length constraint.** The tag enters the namespace, the
namespace enters every run id, and `myco-runner.js` rejects run ids over 64
characters (the id is a path segment). Session ids are `myco-<user>-<8 hex>`, so
the tag keeps only the 8-hex suffix:

```
OK     sess-t59900502-9cfbc953               -> run id 56 chars
BROKEN sess-t59900502-myco-t59900502-9cfbc953 -> run id 71 chars, every rollout dies in argv parsing
```

## Task Staging

A rollout's task inputs come from a staged copy, produced by `_stage()` and cached,
addressed by a hash of the task TEXT.

**Why the text and not just the id**: every inline task shares the id
`inline-task`, so an id-only cache makes the container's first task permanent —
the `staged` marker survives and later sweeps are fed the previous prompt.

**Location**: the data volume by default (`<MYCO_DATA>/harness2-task-cache`, a 2 TB
bind mount in the container), not `/tmp` (overlay, ~10 GB). A staged task is a
FULL COPY of the project, and the runner then copies it into every rollout
workspace — one `k=1` sweep costs `(1 + 4k) × staged size`. The volume holding it
is therefore what bounds how large a task can be.

Resolution order: `MYCO_STAGE_ROOT` → `<MYCO_DATA>/harness2-task-cache` →
`/data/harness2-task-cache` → `tempfile.gettempdir()`.

**Size budgets** (two env knobs, no hardcoded cap):

| Variable | Meaning | Default |
|---|---|---|
| `MYCO_STAGE_MAX_FILE_MB` | per-file ceiling | 64 |
| `MYCO_STAGE_MAX_TOTAL_MB` | whole-copy ceiling | 512 |

Files over budget are recorded in `<meta>/skipped.json` (the META dir, never the
task dir — anything there is copied into the workspace as project content) and
summarised on stderr.

> This was previously a hardcoded 2 MB per file. That number was chosen for the
> PROPOSER's context, but the same directory is also the agent's task input; the
> two budgets differ, and the proposer already had its own protection
> (`deliverable_files` excludes seeds and applies its own 512 KB text cap). The
> effect was a Silesia-corpus task (twelve 5–51 MB files) starting with NO data,
> leaving the agent to `find /` for it.

## Deciding "ran" vs "delivered"

Two separate verdicts, and each predicate has to be stated once — both directions
have been got wrong.

**Runner side `delivered` (`isDelivered`)**: the workspace holds a file that is
either new or CHANGED relative to its seed hash. Not turns alone: a rollout killed
at its timeout can report `turns=0` while having made 51 tool calls, and tool
calls are the durable proof of work.

**Adapter side `rollout_ok`**: `runs` is non-empty AND (`ok` or `delivered` or
`toolCalls > 0`). Three shapes that look like failures must pass:

| Report | Meaning | Verdict |
|---|---|---|
| `runs: []` | runner exited in argv parsing; nothing began | failure |
| `ok:false, delivered:true` | finished the work, stopped untidily (n2 stall) | **usable** |
| `ok:false, toolCalls:51` | killed at timeout, but real work behind it | **usable** |

The opposite mistake is `run_dir.exists()`: the substrate creates the directory
BEFORE invoking the runner, so a failed rollout has one too.

## Stall Watchdog

n2 team liveness is tracked PER WORKER, not per team. A team-wide clock lets a busy
worker mask a peer — measured: worker-B went silent for 23 minutes unnoticed
because worker-A kept emitting events, resetting the single timer each time.

Two steps:

1. Silent past `STALL_NUDGE_MS` (default 5 min) → send that worker a "continue"
   nudge. If it still HOLDS A CLAIM, the nudge tells it to close the item with
   `board.done`, not to hunt for more work — it may already be finished and simply
   never closed the item.
2. Still silent past `STALL_FAIL_MS` (default 8 min) → `team-failed`, naming the
   stuck worker in the report.

Note step 2's window: filtering on step 1's 5-minute window kills the team 20
seconds after the nudge, giving the nudged worker no chance to answer.

Both windows are overridable via `MYCO_N2_STALL_NUDGE_MS` / `MYCO_N2_STALL_FAIL_MS`.

## Re-runs and Continuation

Run ids derive from (namespace, task, label), so a re-run in the same session lands
on the SAME run directory. The runner clears that directory before materialising
(with a path-containment check), otherwise the previous attempt's output makes
`isDelivered` true immediately — a base rollout "delivers" with zero work.

**To continue from the previous round**, put its output into the PROJECT directory
as a task input instead:

```
/harness pull --to sol
```

It then counts as a seed, `isDelivered` means "changed relative to this baseline",
and all four labels start from the same point — which is what makes blind
selection fair. Reusing the run directory cannot do this: only that one label sees
the leftovers, and the agent has no idea who wrote them or how far along they are.

## Proposer Channel (claude_local)

Harness² natively supports `opencode` and `claude_cli`, neither of which works on servers without a Vertex account. myco adds the `claude_local` channel:

- Preserves the caller's `ANTHROPIC_*` environment variables (routes through mycod's configured gateway)
- Uses `--permission-mode acceptEdits --allowedTools Read,Write,Edit,Glob,Grep,LS` instead of `--dangerously-skip-permissions` (compatible with running as root)
- Model id comes from the `ANTHROPIC_MODEL` environment variable (`PROPOSER_MODEL_BY_CHANNEL["claude_local"]`)

## Task Source

The sweep task text is passed through `HARNESS2_MYCO_TASK`, set by `harness-runner.js`'s `sweepEnv()`:

```
/harness run fix greet()
  → sweepEnv({ task: "fix greet()" })
      → HARNESS2_MYCO_TASK = "fix greet()"
          → MycoAdapter._plan() builds [{ id: "inline-task", text: "fix greet()" }]
```

Any project directory containing source files works as a tuning target — no `_myco_/plan.json` needed.

## n2 Rollout Call Chain

```
/harness run --n2 <task>
  → slashcmds.js: rolloutMode = 'n2'
  → startSweep({ rolloutMode: 'n2' })
  → sweepEnv: HARNESS2_MYCO_ROLLOUT_MODE = 'n2'
  → substrate/myco.py: cmd += ['--mode', 'n2']
  → myco-runner.js --mode n2
  → engine.readN2Components(harnessDir)
  → new TeamSession({ workerAStartup, workerBStartup, boardGuidance })
  → worker-A + worker-B collaborative rollout (DelmBoard coordination)
```

## Market Pipeline (P6/P7)

```
/harness publish
  → harness-market.buildFromSweep()
    → reads selection.json to find chosen_run_dir
    → reads harness files from workspace/
    → computes sha1, builds item { type: 'harness', files, metadata }
    → market.publishToMarket({ type: 'harness', ... })

/harness-market install <name>
  → harness-market.installIntoSession()
    → market.readMarketItem({ type: 'harness', name })
    → writes to session cwd using component mapping (same as adoptHarness)
    → writes _harness_/market-installed.json (P8 reuse marker)
    → saves snapshot to support rollback
```

## P8: Experience Reuse

If the session directory contains `_harness_/market-installed.json` (written at install time), the next `/harness run` automatically uses the installed harness as the tuning baseline (`HARNESS2_MYCO_BASE_HARNESS`), so tuning starts from a known-good configuration rather than bare defaults.

```
sweepEnv() checks _harness_/market-installed.json
  → present and valid → HARNESS2_MYCO_BASE_HARNESS = <installed harness dir>
  → explicit override already set → keep it (explicit takes precedence)
```
