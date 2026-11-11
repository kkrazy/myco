#!/usr/bin/env bash
# Regression test for the bench process-tree cleanup: killing a run_all / bench
# server must kill the whole tree (server + claude-agent-sdk workers) WITHOUT
# ever touching anything outside that run (the "误杀/互相杀死" guard).
#
#   Part 1 (live smoke, no engine/model): the process-GROUP kill the launcher
#           relies on. Spawns a throwaway session (setsid), asserts its members
#           die together on one group TERM, and asserts the test's own process
#           is untouched (scoping).
#   Part 2 (static guards): the fix stays wired into run_all.sh + server.js.
#
# Usage: bash test_cleanup.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
pass=0; fail=0
ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL: $1"; fail=$((fail+1)); }
alive(){ kill -0 "$1" 2>/dev/null; }

echo "# 1) process-group kill smoke (launcher layer)"
LEADER=""
MY_PID=$$
trap '[ -n "$LEADER" ] && { kill -KILL -- "-$LEADER" 2>/dev/null || true; }' EXIT

setsid bash -c 'sleep 300 & sleep 300 & wait' < /dev/null &
LEADER=$!
sleep 0.3
KIDS=$(awk '{print $1}' "/proc/$LEADER/task/$LEADER/children" 2>/dev/null | tr '\n' ' ')
if [ "$MY_PID" -ne "$LEADER" ] && alive "$LEADER"; then
  ok "throwaway session $LEADER is up (its PGID != test pid $MY_PID)"
else
  bad "session leader not alive / collided with test pid"
fi
if [ -n "$KIDS" ]; then
  ok "session leader has child worker(s): $(echo $KIDS)"
else
  bad "session leader has no children to clean up"
fi

# one TERM to the whole group — exactly what run_all.sh cleanup() does
kill -- "-$LEADER" 2>/dev/null || true
sleep 0.5
leader_dead=false; kid_leak=false
alive "$LEADER" || leader_dead=true
for k in $KIDS; do alive "$k" && kid_leak=true; done
if $leader_dead && ! $kid_leak; then
  ok "group TERM killed leader + all children together (no orphans)"
else
  bad "tree leaked after group kill (leader_dead=$leader_dead children_leaked=$kid_leak)"
fi
if alive "$MY_PID"; then
  ok "test's own process NOT touched by the group kill (scoped, no over-kill)"
else
  bad "group kill over-reached into the test process!"
fi

echo "# 2) cleanup wiring static guards"
if grep -q 'setsid' run_all.sh && grep -q 'kill -- "-\$SRV"' run_all.sh; then
  ok "run_all.sh isolates the server in its own group and group-kills it"
else
  bad "run_all.sh missing setsid / group kill (regression?)"
fi
if grep -qE "process\.on\('SIG(TERM|INT)'" server.js && grep -q 'descendantPids' server.js; then
  ok "server.js tears down its own SDK-worker descendants on SIGTERM/SIGINT"
else
  bad "server.js missing shutdown handler / descendantPids (regression?)"
fi

echo "# 3) judge workdir placement (non-persisted n2 dirs stay under judge/)"
if grep -q 'path.join(WORK_ROOT, '"'"'judge'"'"')' lib/engine.js \
   && grep -q 'n2TempDir()' lib/engine.js; then
  ok "engine.js puts non-persisted n2 workdirs under judge/ (via n2TempDir)"
else
  bad "engine.js judge-dir routing missing (regression?)"
fi

trap - EXIT
[ -n "$LEADER" ] && { kill -KILL -- "-$LEADER" 2>/dev/null || true; }
echo
echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
