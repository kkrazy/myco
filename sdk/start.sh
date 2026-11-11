#!/usr/bin/env bash
# Launch the myco SDK interface — an HTTP server over the single-agent and
# run-n2 engines (reused from bench/hle; myco's own server/src modules are
# required in-process). This script is the only thing you need to start it.
#
# Pass server args through, e.g.:
#   ./start.sh --port 8787
#   ./start.sh --mock --port 8788        # offline smoke test (no model calls)
#   MYCO_ENV=/path/to/state/.env ./start.sh --port 8787
#
# Full flag set mirrors bench/hle/server.js for drop-in compatibility:
#   --port <n>  --concurrency <n>  --timeout <ms>  --env <state/.env>
#   --stamp <YYYYMMDDHHMMSS>   --mock 1
set -euo pipefail
SDK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_HLE="$SDK_ROOT/../bench/hle"

# Point the SDK at the (reused) bench engines, tell the engine where myco's
# server/src lives, and let its bare requires (@anthropic-ai/claude-agent-sdk,
# zod) resolve through bench/hle/node_modules — no separate npm install needed.
export MYCO_BENCH_LIB="${MYCO_BENCH_LIB:-$BENCH_HLE/lib}"
export MYCO_SRC="${MYCO_SRC:-$SDK_ROOT/../server/src}"
export NODE_PATH="$BENCH_HLE/node_modules${NODE_PATH:+:$NODE_PATH}"

cd "$SDK_ROOT"
exec node server.js "$@"
