#!/usr/bin/env bash
# One-click launch: start the bench server (if not already running) and run
# BOTH pipelines (single-agent + run-n2) in parallel, then cross-judge, and
# write work/<stamp>/result/{report.md,results.json,results.jsonl}.
#
# Pass run.py args through, e.g.:
#   ./run_all.sh --limit 20 --concurrency 3
#   ./run_all.sh --mode n2 --problems /path/to/problems
set -euo pipefail
HLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HLE_ROOT"
export NODE_PATH="$PWD/node_modules"

# One timestamped dir per run, shared by the server's worker artifacts AND the
# run.py report (work/<stamp>/result), so a whole run stays in one folder.
# Prefix `hle-` distinguishes it from a tb4 run's work/tb4-<stamp>/.
STAMP="hle-$(date +%Y%m%d%H%M%S)"
PORT="${HLE_PORT:-8787}"

# Forward run.py's --concurrency to the server too: the server's internal
# model-call pool otherwise caps at 2 and throttles the whole run regardless of
# how high the client's --concurrency is. Extract N from "--concurrency N".
SRV_C=2
prev=""
for a in "$@"; do
  if [ "$prev" = "--concurrency" ] && [[ "$a" =~ ^[0-9]+$ ]]; then SRV_C="$a"; fi
  prev="$a"
done
SRV_EXTRA=(--concurrency "$SRV_C")

# n2 footgun warning: each n2 problem spawns TWO claude-agent-sdk workers, so
# the REAL concurrent model-call load is 2× the server pool. concurrency=100 →
# 200 in-flight claude workers on the gateway → upstream times out throughout
# ("n2 stalled: no worker output") and the run degenerates into a long churn
# that keeps re-writing the same work/<stamp> dirs. Keep n2 concurrency modest
# (single-agent can go higher; n2 should stay ~<=8 = 16 workers). Warn so a
# copy-pasted "--concurrency 100" doesn't silently waste a whole run again.
if [ "$SRV_C" -gt 8 ]; then
  echo "[run_all] WARNING: --concurrency $SRV_C is far above the n2-safe range." >&2
  echo "[run_all]          n2 spawns 2 workers/problem -> $((SRV_C * 2)) concurrent claude" >&2
  echo "[run_all]          processes hitting the model gateway. High concurrency is the" >&2
  echo "[run_all]          usual cause of 'n2 stalled: no worker output' error storms." >&2
  echo "[run_all]          Prefer --concurrency 3..8 (single can be raised separately)." >&2
fi

# Tear down the WHOLE bench tree on any exit: the bench server AND every
# claude-agent-sdk worker it spawned. The server runs in its own session
# (setsid below -> PGID == $SRV), so `kill -- -$SRV` reaches only THIS run's
# process group: the server + all its SDK workers. Sibling runs, the user's
# interactive claude sessions, and the main myco server live in different
# sessions and are never touched. TERM first, then hard-KILL stragglers so no
# in-flight worker can orphan to init. (SIGKILL to run_all itself can't run a
# trap; in that case kill the group explicitly: `kill -KILL -- -<PGID>`.)
cleanup() {
  [ -n "${SRV:-}" ] || return 0            # server reused/not started: nothing of ours
  kill -- "-$SRV" 2>/dev/null || true      # SIGTERM to every member of the group
  for _ in 1 2 3 4 5; do
    kill -0 -- "-$SRV" 2>/dev/null || return 0   # group gone -> all clean
    sleep 0.2
  done
  kill -KILL -- "-$SRV" 2>/dev/null || true      # stragglers: force kill the group
}

# Start the server only if nothing is already listening on $PORT. Pin the same
# STAMP the run shares, so its worker dirs (work/$STAMP/<id>/) and run.py's
# report dir (work/$STAMP/result/) stay in one timestamped folder.
if ! curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  mkdir -p "work/$STAMP/result"
  echo "[run_all] starting bench server on :$PORT concurrency=${SRV_EXTRA[1]} stamp=$STAMP"
  setsid node server.js --port "$PORT" --stamp "$STAMP" "${SRV_EXTRA[@]}" > "work/$STAMP/result/server.log" 2>&1 &
  ready=0
  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    echo "[run_all] server failed to start; see work/$STAMP/result/server.log" >&2
    exit 1
  fi
  # Server is up. setsid put it in its own session (PGID == server PID — even
  # when setsid forks, the server itself is the new group leader). Read its real
  # PID from the pidfile it wrote at boot: that PID is the process-group id every
  # SDK worker it spawns joins, so cleanup() tears down the whole tree. We can
  # NOT trust `$!` here — if setsid forked, `$!` is the short-lived setsid
  # wrapper, not the server.
  SRV=$(cat "work/$STAMP/.server.pid" 2>/dev/null || true)
  [ -n "$SRV" ] && trap cleanup EXIT INT TERM HUP
else
  echo "[run_all] reusing existing server on :$PORT"
fi

echo "[run_all] running: python3 run.py --server http://127.0.0.1:$PORT $*"
python3 run.py --server "http://127.0.0.1:$PORT" "$@"
echo "[run_all] done. See work/$STAMP/result/report.md"
