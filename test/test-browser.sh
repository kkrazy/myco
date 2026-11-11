#!/usr/bin/env bash
# Browser-level rendering tests (Playwright). Slower than ./test/test.sh — run before push.
set -euo pipefail

# Anchor to repo root. After the td-32 move into test/, the script's
# parent dir is test/ — paths like `node server/src/index.js` and
# `node test/browser/render.test.js` below need to resolve from repo
# root. The double-cd-then-pwd pattern is robust against $0 being
# a relative path like `./test/test-browser.sh` vs absolute.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/.."

# 1. Ensure Playwright is installed
if ! node -e "require.resolve('playwright')" 2>/dev/null; then
  echo "Playwright not installed. Run:"
  echo "  npm install"
  echo "  npx playwright install chromium"
  exit 1
fi

# 2. Ensure the chromium browser is installed
if ! node -e "
  const { chromium } = require('playwright');
  chromium.executablePath();
" 2>/dev/null; then
  echo "Playwright chromium browser missing. Run:"
  echo "  npx playwright install chromium"
  exit 1
fi

# 3. Start mycod on a free port with isolated state
MYCO_STATE_DIR=$(mktemp -d)
MYCO_WORKSPACE=$(mktemp -d)
TEST_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()")
echo "Starting mycod on port $TEST_PORT..."

MYCO_STATE_DIR="$MYCO_STATE_DIR" MYCO_WORKSPACE="$MYCO_WORKSPACE" PORT="$TEST_PORT" \
  node server/src/index.js >/tmp/mycod-browser-test.log 2>&1 &
SERVER_PID=$!

# Cleanup hook
cleanup() {
  kill $SERVER_PID 2>/dev/null || true
  rm -rf "$MYCO_STATE_DIR" "$MYCO_WORKSPACE"
}
trap cleanup EXIT

# Wait for server to be ready (max 10s)
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$TEST_PORT/" -o /dev/null 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if ! curl -sf "http://127.0.0.1:$TEST_PORT/" -o /dev/null 2>/dev/null; then
  echo "  ✗ Server failed to start on port $TEST_PORT"
  echo "── server log ──"
  cat /tmp/mycod-browser-test.log
  exit 1
fi

# 4. Run browser tests
TEST_URL="http://127.0.0.1:$TEST_PORT" node test/browser/render.test.js
