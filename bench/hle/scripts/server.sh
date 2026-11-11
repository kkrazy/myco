#!/usr/bin/env bash
# Start the bench HTTP server (blocking POST /answer + /judge), reusing
# myco's engine. Pass server args through, e.g.:
#   scripts/server.sh --port 8787
#   scripts/server.sh --mock --port 8787        (offline smoke test)
#   MYCO_ENV=/path/to/state/.env scripts/server.sh --port 8787
set -euo pipefail
HLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HLE_ROOT"
export NODE_PATH="$PWD/node_modules"
exec node server.js "$@"
