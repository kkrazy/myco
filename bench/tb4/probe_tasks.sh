#!/usr/bin/env bash
# probe_tasks.sh — probe which TB4 tasks can BUILD on this host, one task at a
# time (no concurrent docker builds), using the daemon proxy for base-image
# pulls and RUN-step installs. "Buildable" = the task's environment AND tests
# (verifier) images both build from local Dockerfiles — the precondition for the
# task to actually run. This is the first gate of the "probe 5 locally-runnable
# tasks" effort.
#
# Usage:
#   ./probe_tasks.sh [task1 task2 ...]    # default: the 5 curated DEFAULT_TASKS
#   TB4_BUILD_PROXY=... ./probe_tasks.sh
#
# Writes:
#   work/probe_results.txt   — one line per task: OK <name> | FAIL <name>
#   work/probe/<name>.log    — full env+tests build output for each task
set -euo pipefail
TB4_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$TB4_ROOT"

if [ "$#" -gt 0 ]; then
  TASKS=("$@")
else
  TASKS=(photonic-waveguide-routing music-harmony bun-sourcemap-leak \
         foodstuff-beta-activity interleaved-vigenere)
fi

export TB4_BUILD_PROXY="${TB4_BUILD_PROXY:-http://p_atlas:proxy%40123@10.195.176.39:8081}"

mkdir -p work/probe
RES=work/probe_results.txt
: > "$RES"

probe_one() {
  local n="$1"
  echo "=== probing $n ===" | tee -a "$RES"
  if python3 - "$n" > "work/probe/$n.log" 2>&1 <<'PY'
import sys
sys.path.insert(0, 'lib')
from loader import load_tasks
from workspace import build_env_image
from verify import build_tests_image
name = sys.argv[1]
t = load_tasks([name])[0]
try:
    build_env_image(t, 'tb4-env-' + name)
    print('[probe] env OK      ', name, flush=True)
    build_tests_image(t, 'tb4-test-' + name)
    print('[probe] tests OK    ', name, flush=True)
    print('[probe] BUILDABLE   ', name)
except Exception as e:
    print('[probe] BUILD FAIL  ', name, '::', str(e)[-2000:], flush=True)
    sys.exit(2)
PY
  then :; fi
  if grep -q 'BUILDABLE' "work/probe/$n.log"; then
    echo "OK $n" >> "$RES"
  else
    echo "FAIL $n  (see work/probe/$n.log)" >> "$RES"
  fi
}

for n in "${TASKS[@]}"; do
  probe_one "$n"
done

echo "=== probe results ==="
cat "$RES"
