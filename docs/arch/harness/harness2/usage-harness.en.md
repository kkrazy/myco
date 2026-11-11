# Harness² User Guide

Harness² automatically tunes harness configurations. Give it a concrete code task and it generates multiple harness variants, runs real rollouts, blindly selects the best-performing one, and returns it for you to adopt or publish.

## Prerequisites

- myco service running normally
- `claude` CLI available
- A project directory containing the source files you want the agent to work on

## Quick Start

### 1. Run a sweep

```
/harness run fix greet() to return "hello" instead of "hi"
```

The task text is passed directly to the adapter — any project directory works. k=1 takes about 5 minutes.

**Optional flags:**

| Flag | Description | Example |
|---|---|---|
| `--k <1-4>` | Number of rollouts per variant, default 1, cost doubles per rung | `/harness run --k 2 <task>` |
| `--n2` | Run rollouts in dual-agent (run-n2) mode | `/harness run --n2 <task>` |
| `--timeout <dur>` | Per-rollout timeout, default 5h. Accepts `1800` / `300m` / `5h`; capped at 24h | `/harness run --timeout 8h <task>` |

Flags can be combined (they must come before the task text):

```
/harness run --k 2 --n2 fix greet() to return "hello"
/harness run --n2 --k 2 --timeout 5h fix add() to return a+b instead of a-b
```

**How the timeout is used**: `--timeout` bounds a single rollout. The sweep's own
wall-clock cap is derived from it as `4 × k × per-rollout + 3600 s` (the reserve for
the improvement phase) — `k=1 --timeout 5h` gives 75600 s (21 h). It is derived
rather than fixed because an earlier flat 7200 s cap was shorter than the rollout
budget itself, killing sweeps before the improvement phase ever ran.

**Cost reference**: one full-size `k=1` sweep runs about $200; `k=2` doubles it.

### 2. Check progress

```
/harness status
```

### 3. Review the diff

After the sweep completes:

```
/harness diff
```

### 4. Adopt

```
/harness adopt
```

Writes the selected harness into the current session's workspace. Takes effect on the next conversation turn.

### 5. Retrieve the agent's output

```
/harness pull
```

`adopt` installs the **harness** (`CLAUDE.md`, `skills/`, `memory/`). The **code**
the agent wrote during a rollout is not in there — use `pull` for that.

```
/harness pull                     # the blindly-selected run
/harness pull --all               # one subdirectory per run, ready for diff -r
/harness pull inv1                # a specific run
/harness pull --to src            # destination (default _harness_/deliverables/<sweep>/)
/harness pull --bulk              # include datasets and build output
```

**How it separates output from noise**: a rollout workspace mixes three kinds of
file, and only one of them is the agent's work —

| Kind | Test | Treatment |
|---|---|---|
| task input | hash matches the seed | excluded |
| harness file | listed in `meta.harnessWritten` | excluded |
| everything else | added, **or modified away from its seed** | deliverable |

The second half of the last row matters: when a task ships a starting
implementation, editing it *is* the work. Treating "the name is in the seed" as
"untouched" reports zero output for the task itself.

Bulk files are filtered three ways: size (a 10 MB corpus), extension (PNG/PDF/
archives), and a NUL-byte probe over the first 8 KB (compiled output often has no
extension at all). Every skipped file is named in the reply rather than dropped
silently.

### 6. Roll back

```
/harness rollback
```

### 7. Publish to market

```
/harness publish
```

## Manual Harness Installation

### Generate a template

```
/harness init
```

Creates `_harness_/template/` with: `systemprompt.md`, `tool_guidance.md`, `guardrails.md`.

For n2 mode:

```
/harness init n2
```

Adds three n2 components: `worker_a_startup.md`, `worker_b_startup.md`, `board_guidance.md`.

### Install a local harness

```
/harness install _harness_/template
```

Installs the harness tree from a local directory into the current session. Accepts relative or absolute paths.

## Harness Market

### Panel

Open the Skills panel → click the **Harness Market** tab: browse, view details, install.

### Commands

```
/harness-market list
/harness-market info <name>
/harness-market install <name>
```

## run-n2 Mode

run-n2 is a dual-agent collaboration mode (worker-A + worker-B sharing a single DelmBoard). Harness² can tune the collaboration strategy.

n2-exclusive components:

| Component | Purpose |
|---|---|
| `worker_a_startup.md` | worker-A task decomposition strategy |
| `worker_b_startup.md` | worker-B environment exploration strategy |
| `board_guidance.md` | Board usage protocol and waiting strategy |

These three components are not written to disk. They are injected into the worker system prompts when `TeamSession` starts.

## Command Reference

| Command | Purpose |
|---|---|
| `/harness run [--n2] [--k <1-4>] [--timeout <dur>] <task>` | Start a sweep (default k=1, single-agent) |
| `/harness status [id]` | Check sweep status |
| `/harness cancel` | Cancel a running sweep |
| `/harness diff [id]` | Review changes |
| `/harness adopt [id]` | Adopt the selected harness |
| `/harness pull [--all] [--bulk] [--to <dir>] [id] [runLabel]` | Retrieve the code the agent produced |
| `/harness rollback [sweepId]` | Roll back an adoption |
| `/harness publish [id]` | Publish to market |
| `/harness init [n2]` | Generate config templates |
| `/harness install <dir>` | Install a local harness |
| `/harness-market list` | List market items |
| `/harness-market info <name>` | View item details |
| `/harness-market install <name>` | Install from market |

## File Layout

Paths written when a harness is adopted:

| harness² path | myco path | Purpose |
|---|---|---|
| `systemprompt.md` | `CLAUDE.md` | Role, workflow, rules |
| `guardrails.md` | `CLAUDE.md` (appended) | Prohibitions |
| `tool_guidance.md` | `.claude/tool_guidance.md` | Tool usage guidance |
| `sub_agents/<name>/AGENT.md` | `.claude/agents/<name>.md` | Sub-agents |
| `skills/<name>/` | `.claude/skills/<name>/` | Reusable skills |
| `scripts/<name>.py` | `.myco_harness/scripts/<name>.py` | Pre-approved scripts |
| `worker_a_startup.md` | (injected, not written) | n2: worker-A strategy |
| `worker_b_startup.md` | (injected, not written) | n2: worker-B strategy |
| `board_guidance.md` | (injected, not written) | n2: board protocol |

## Cross-Project Reuse (P8)

A session with a market harness installed will automatically use it as the tuning baseline on the next `/harness run`, rather than starting from bare defaults.

## Troubleshooting

**Sweep fails immediately**: confirm the myco service is running and `claude` CLI is available.

**No change after adopting**: adopting takes effect on the next conversation turn, not the current one.

**Use a specific harness as baseline**: set `HARNESS2_MYCO_BASE_HARNESS` to point at its directory.
