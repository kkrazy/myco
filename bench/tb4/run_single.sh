#!/usr/bin/env bash
# Run ONLY the single-agent pipeline for the selected TB4 tasks.
# Starts the tb4 server if not running. Pass run.py args through,
# e.g.: ./run_single.sh --tasks photonic-waveguide-routing
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec ./run_all.sh --mode single "$@"
