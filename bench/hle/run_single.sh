#!/usr/bin/env bash
# Run ONLY the single-agent pipeline (answer via single-agent, judged by
# run-n2). Starts the bench server if not running. Pass run.py args through,
# e.g.: ./run_single.sh --limit 20 --concurrency 3
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec ./run_all.sh --mode single "$@"
