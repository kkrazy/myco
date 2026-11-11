#!/usr/bin/env bash
# One-click TB4 launch: start the tb4 server (if not already running), run the
# selected Terminal-Bench tasks (single + n2 agents, default sequential),
# verify each with the task's official verifier, and write
# work/tb4-<stamp>/result/{report.md,results.json,results.jsonl}.
#
# Pass run.py args through, e.g.:
#   ./run_all.sh --tasks photonic-waveguide-routing,music-harmony
#   ./run_all.sh --mode n2 --no-resume
#   ./run_all.sh --timeout 3600000
set -euo pipefail
TB4_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HLE_ROOT="$(cd "$TB4_ROOT/../hle" && pwd)"
cd "$TB4_ROOT"
# Reuse myco's shared SDK deps from hle's node_modules (they drive the same
# claude-agent-sdk). Falls back to a local ./node_modules if present.
export NODE_PATH="$HLE_ROOT/node_modules:$PWD/node_modules"

# One timestamped dir per run, prefixed tb4- to sit apart from hle-<stamp>.
STAMP="tb4-$(date +%Y%m%d%H%M%S)"
PORT="${TB4_PORT:-8790}"

# Tear down the WHOLE tb4 tree on exit: the server + every SDK worker it
# spawned. The server runs in its own session (setsid -> PGID == server PID),
# so `kill -- -$SRV` reaches only THIS run's process group. Sibling runs /
# the user's interactive claude / the main myco server live in other sessions
# and are never touched.
cleanup() {
  [ -n "${SRV:-}" ] || return 0
  kill -- "-$SRV" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    kill -0 -- "-$SRV" 2>/dev/null || return 0
    sleep 0.2
  done
  kill -KILL -- "-$SRV" 2>/dev/null || true
}

# Start the server only if nothing is already listening on $PORT.
if ! curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  mkdir -p "work/$STAMP/result"
  echo "[tb4] starting server on :$PORT stamp=$STAMP"
  setsid node server.js --port "$PORT" --stamp "$STAMP" > "work/$STAMP/result/server.log" 2>&1 &
  ready=0
  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    echo "[tb4] server failed to start; see work/$STAMP/result/server.log" >&2
    exit 1
  fi
  SRV=$(cat "work/$STAMP/.server.pid" 2>/dev/null || true)
  [ -n "$SRV" ] && trap cleanup EXIT INT TERM HUP
else
  echo "[tb4] reusing existing server on :$PORT"
fi

echo "[tb4] running: python3 run.py --server http://127.0.0.1:$PORT $*"
python3 run.py --server "http://127.0.0.1:$PORT" "$@"
echo "[tb4] done. See work/$STAMP/result/report.md"
