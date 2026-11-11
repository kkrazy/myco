# Harness² Installation Guide

This document explains how to install and configure the Harness² integration in a myco project.

## Prerequisites

- myco service (mycod) running normally
- `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` configured (myco's built-in gateway)
- `claude` CLI available (`which claude` returns a path)

## Server Deployment (Docker)

The Harness² integration is built into the myco Docker image — no separate installation required. The image includes:

- `/app/vendor/harness2/` — Harness² Python library (includes myco adapter and `claude_local` channel)
- `/app/bench/harness2/` — myco runner (Node.js, handles rollout execution)
- `/app/server/src/harness-*.js` — Node.js server-side integration

Ensure the following mounts when starting the container:

```bash
docker run -d \
  -v /your/state:/data \
  -v /your/workspaces:/wks \
  myco:latest
```

## Environment Variables

Harness² sweeps require the following environment variables (automatically inherited when mycod starts):

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_AUTH_TOKEN` | Yes | Gateway auth token |
| `ANTHROPIC_BASE_URL` | Yes | Gateway URL |
| `ANTHROPIC_MODEL` | Yes | Model ID to use |
| `HARNESS2_MYCO_ROOT` | No | myco checkout root (default `/app`) |

The following are set automatically by `harness-runner.js` — no manual configuration needed:

| Variable | Automatic value |
|---|---|
| `HARNESS2_MYCO_PROJECT` | Current session cwd |
| `HARNESS2_MYCO_RUNNER` | `/app/bench/harness2/myco-runner.js` |
| `MYCO_SRC` | `/app/server/src` |
| `HARNESS2_SOLVER_MODEL` | `local/${ANTHROPIC_MODEL}` |
| `HARNESS2_JUDGE_MODEL` | `local/${ANTHROPIC_MODEL}` |

## Task Source Configuration

Harness² needs to know which task to tune against. Pass the task text directly via `/harness run <task description>` — no files required:

```
/harness run fix greet() to return "hello" instead of "hi"
```

The task text is passed through `HARNESS2_MYCO_TASK` to the adapter. Any project directory containing source files works as a tuning target.

## Verifying the Installation

In the myco chat interface, run:

```
/harness status
```

If it returns `No sweep running`, the integration is working correctly.

Quick functional test (no tokens consumed):

```bash
docker exec myco-tz sh -c '
export HARNESS2_MYCO_PROJECT=/tmp/test-proj
export HARNESS2_MYCO_TASK="test task"
mkdir -p $HARNESS2_MYCO_PROJECT
echo "{}" > $HARNESS2_MYCO_PROJECT/app.py
export PYTHONPATH=/app/vendor/harness2
python3 -c "
from harness2.benchmarks.myco import MycoAdapter
a = MycoAdapter()
print(a.tasks())
"
'
```

Output of `['inline-task']` confirms the installation is correct.

## Local Development Setup

When developing myco locally, confirm these paths exist:

```bash
# bench runner
ls bench/harness2/myco-runner.js

# Python vendor
ls vendor/harness2/harness2/benchmarks/myco.py

# server-side integration
ls server/src/harness-runner.js server/src/harness-result.js server/src/harness-market.js

# module facade
ls server/src/agents/harness2/
```

Run local tests:

```bash
node --test bench/harness2/engine.test.js
node test/harness-runner.test.js
node test/harness-p4-p7.test.js
```

## Developing New Features from Source

### Code Structure

The Harness² integration is split across three layers:

```
bench/harness2/          ← rollout execution layer (Node.js CLI)
  myco-runner.js         ← entry point called by Harness², supports --mode myco/n2
  lib/engine.js          ← path mapping, materialise, runRollout, runRolloutN2

vendor/harness2/         ← propose/schedule layer (Python)
  harness2/
    benchmarks/myco.py   ← myco BenchmarkAdapter (task source, adapter interface)
    core/proposer.py     ← claude_local channel implementation
    core/spec.py         ← CHANNELS registration
    config.py            ← PROPOSER_MODEL_BY_CHANNEL
    substrate/myco.py    ← MycoSubstrate (calls myco-runner.js)

server/src/              ← server integration layer (Node.js)
  agents/harness2/       ← unified module entry point
    index.js             ← façade, re-exports the three sub-modules below
    runner.js            ← → harness-runner.js
    result.js            ← → harness-result.js
    market.js            ← → harness-market.js
  harness-runner.js      ← sweep lifecycle (startSweep/cancelSweep/getStatus)
  harness-result.js      ← diff/adopt/rollback/snapshot
  harness-market.js      ← publish/install/list
```

### Development Workflow

**1. Modifying the bench layer (rollout logic)**

```bash
# edit locally
vim bench/harness2/lib/engine.js

# run unit tests
node --test bench/harness2/engine.test.js

# sync to server (requires image rebuild to take effect)
pscp bench/harness2/lib/engine.js root@<server>:/data/.../bench/harness2/lib/
```

**2. Modifying the vendor layer (Python adapter)**

```bash
# edit locally
vim vendor/harness2/harness2/benchmarks/myco.py

# syntax check
python -c "import ast; ast.parse(open('vendor/harness2/harness2/benchmarks/myco.py').read())"

# sync to server
pscp vendor/harness2/harness2/benchmarks/myco.py root@<server>:/data/.../vendor/harness2/harness2/benchmarks/
```

**3. Modifying the server layer (Node.js integration)**

```bash
# edit locally
vim server/src/harness-runner.js

# syntax check
node --check server/src/harness-runner.js

# run tests
node test/harness-runner.test.js
node test/harness-p4-p7.test.js

# sync to server — hot-update via docker cp, no rebuild needed
pscp server/src/harness-runner.js root@<server>:/data/.../server/src/
```

### Key Design Conventions

**Environment variable chain:**

```
mycod (PID 1)
  └── ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL
       └── harness-runner.js sweepEnv()
            ├── HARNESS2_MYCO_PROJECT = session cwd
            ├── HARNESS2_MYCO_TASK = task text (optional inline)
            ├── HARNESS2_MYCO_RUNNER = bench/harness2/myco-runner.js
            ├── MYCO_SRC = server/src
            ├── HARNESS2_SOLVER_MODEL = local/${ANTHROPIC_MODEL}
            └── HARNESS2_JUDGE_MODEL = local/${ANTHROPIC_MODEL}
```

**Task source:**

1. `HARNESS2_MYCO_TASK` constructs a single `inline-task` when non-empty
2. When not set, preflight reports an error — pass the task via `/harness run <task>`

**Adding a new harness component:**

1. Add the mapping to `COMPONENT_MAP` or `DIR_MAP` in `bench/harness2/lib/engine.js`
2. Add handling to `adoptHarness()` and `diffHarness()` in `harness-result.js`
3. Update the component table in `docs/arch/harness2-architecture.zh.md`
4. Add validation rules to `validateTree()` in `harness-market.js` if needed

**run-n2 exclusive components** (`worker_a_startup.md`, `worker_b_startup.md`, `board_guidance.md`) are not written to disk. They are read by `engine.readN2Components()` and injected into the `TeamSession` constructor at runtime.

## Build Notes

After modifying the Python layer (`vendor/harness2/`) or bench layer (`bench/harness2/`, `server/src/harness*.js`), rebuild the image:

```bash
# rebuild
docker build -f docker/Dockerfile -t myco:latest .

# recreate container
docker rm -f myco-tz
docker run -d --name myco-tz ... myco:latest
```

Node.js files in `server/src/` can be hot-updated with `docker cp` without a rebuild, but will be overwritten on the next build.
