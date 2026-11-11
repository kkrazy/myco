#!/usr/bin/env bash
# Run ONLY the run-n2 pipeline for the selected TB4 tasks.
# Starts the tb4 server if not running. Pass run.py args through,
# e.g.: ./run_n2.sh --tasks music-harmony
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec ./run_all.sh --mode n2 "$@"
