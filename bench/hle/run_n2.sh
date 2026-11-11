#!/usr/bin/env bash
# Run ONLY the run-n2 pipeline (answer via run-n2, judged by single-agent).
# Starts the bench server if not running. Pass run.py args through,
# e.g.: ./run_n2.sh --limit 20 --concurrency 2
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec ./run_all.sh --mode n2 "$@"
