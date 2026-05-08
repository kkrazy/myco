#!/usr/bin/env bash
# Smoke test for myco — run before every commit.
set -euo pipefail

PASS=0
FAIL=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
die() { FAIL=$((FAIL+1)); echo "  ✗ FATAL: $1"; exit 1; }

cd "$(dirname "$0")"

echo "── Static checks ──"

# 1. Server JS parses without errors
node -e "
  const fs = require('fs');
  ['src/index.js','src/pty.js','src/sessions.js','src/transcript.js','src/auth.js','src/btw.js'].forEach(f => {
    try { require('fs').readFileSync('server/' + f, 'utf8'); } catch(e) { throw new Error('Missing: server/' + f); }
  });
" && pass "Server JS files readable" || fail "Server JS files"

# 2. Frontend files exist
for f in web/public/app.js web/public/styles.css web/public/index.html web/public/keyboard.js; do
  test -f "$f" && pass "$f exists" || fail "$f missing"
done

# 3. Vendor assets exist
for f in web/public/vendor/highlight.min.js web/public/vendor/mermaid.min.js web/public/vendor/github-dark.min.css; do
  test -f "$f" && pass "$f exists" || fail "$f missing"
done

# 4. key dependencies installed
(cd server && node -e "
  ['express','ws','marked','highlight.js','@homebridge/node-pty-prebuilt-multiarch','ansi-to-html'].forEach(p => {
    try { require.resolve(p); } catch { throw new Error('Missing npm dep: ' + p); }
  });
") && pass "npm deps resolve" || fail "npm deps"

# 5. Check cache busters are in sync (app.js and styles.css referenced in index.html)
APP_V=$(grep -oP 'app\.js\?v=\K\d+' web/public/index.html)
CSS_V=$(grep -oP 'styles\.css\?v=\K\d+' web/public/index.html)
test -n "$APP_V" && pass "app.js cache buster = v$APP_V" || fail "app.js cache buster"
test -n "$CSS_V" && pass "styles.css cache buster = v$CSS_V" || fail "styles.css cache buster"

# 6. Conversation view CSS exists
grep -q 'conversation-wrap' web/public/styles.css && pass "conversation-wrap CSS" || fail "conversation-wrap CSS"
grep -q 'conv-msg-user' web/public/styles.css && pass "user message CSS" || fail "user message CSS"
grep -q 'conv-msg-assistant' web/public/styles.css && pass "assistant message CSS" || fail "assistant message CSS"
grep -q 'conv-tool-call' web/public/styles.css && pass "tool call CSS" || fail "tool call CSS"
grep -q 'conv-mermaid' web/public/styles.css && pass "mermaid CSS" || fail "mermaid CSS"

# 7. Conversation view JS functions exist
grep -q 'function renderConvMessage' web/public/app.js && pass "renderConvMessage" || fail "renderConvMessage"
grep -q 'function renderMd' web/public/app.js && pass "renderMd" || fail "renderMd"
grep -q 'function renderMermaidInContainer' web/public/app.js && pass "renderMermaidInContainer" || fail "renderMermaidInContainer"
grep -q 'function openSession' web/public/app.js && pass "openSession" || fail "openSession"
grep -q 'function renderTranscriptMessages' web/public/app.js && pass "renderTranscriptMessages" || fail "renderTranscriptMessages"

# 8. @claude chat command handler in pty.js
grep -q '@claude' server/src/pty.js && pass "@claude handler" || fail "@claude handler"
grep -q 'session.write' server/src/pty.js && pass "PTY write for @claude" || fail "PTY write"

# 9. Viewer WS handler exists
grep -q 'attachViewerWebSocket' server/src/pty.js && pass "attachViewerWebSocket" || fail "attachViewerWebSocket"
grep -q 'attachViewerWebSocket' server/src/index.js && pass "viewer WS routing" || fail "viewer WS routing"

# 10. Auth check returns user
grep -q 'body.user' web/public/app.js && pass "chatUser capture" || fail "chatUser capture"
grep -q 'from-self' web/public/app.js && pass "self chat alignment" || fail "self chat alignment"

# 11. Session switching clears panes
grep -q "conversation-wrap.*hidden.*true" web/public/app.js && pass "pane clear on switch" || fail "pane clear on switch"

# 12. Mermaid init in index.html
grep -q 'mermaid.initialize' web/public/index.html && pass "mermaid init" || fail "mermaid init"
grep -q 'highlight.min.js' web/public/index.html && pass "highlight.js loaded" || fail "highlight.js loaded"

echo ""
echo "── Server smoke test ──"

# 13. Server starts and responds
MYCO_STATE_DIR=$(mktemp -d)
MYCO_WORKSPACE=$(mktemp -d)
TEST_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()")
MYCO_STATE_DIR="$MYCO_STATE_DIR" MYCO_WORKSPACE="$MYCO_WORKSPACE" PORT="$TEST_PORT" node server/src/index.js &
SERVER_PID=$!
sleep 2

if curl -sf "http://127.0.0.1:$TEST_PORT/" -o /dev/null 2>/dev/null; then
  pass "Server responds on /"
else
  fail "Server responds on / (port $TEST_PORT)"
fi

# 14. Sessions endpoint works
if curl -sf "http://127.0.0.1:$TEST_PORT/sessions?all=1" -o /dev/null 2>/dev/null; then
  pass "GET /sessions?all=1"
else
  fail "GET /sessions?all=1"
fi

# 15. Auth check endpoint
RESP=$(curl -sf "http://127.0.0.1:$TEST_PORT/auth/check" 2>/dev/null || echo '{}')
echo "$RESP" | grep -q '"ok"' && pass "GET /auth/check" || fail "GET /auth/check"

# 16. Static vendor files served
curl -sf "http://127.0.0.1:$TEST_PORT/vendor/highlight.min.js" -o /dev/null 2>/dev/null && pass "highlight.min.js served" || fail "highlight.min.js served"
curl -sf "http://127.0.0.1:$TEST_PORT/vendor/github-dark.min.css" -o /dev/null 2>/dev/null && pass "github-dark.css served" || fail "github-dark.css served"
curl -sf "http://127.0.0.1:$TEST_PORT/vendor/mermaid.min.js" -o /dev/null 2>/dev/null && pass "mermaid.min.js served" || fail "mermaid.min.js served"

# Cleanup
kill $SERVER_PID 2>/dev/null || true
rm -rf "$MYCO_STATE_DIR" "$MYCO_WORKSPACE"

echo ""
echo "── Docker build ──"
docker build -t myco-test . --quiet 2>&1 && pass "Docker build" || fail "Docker build"

echo ""
echo "─────────────────────────"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "  FAILED — fix before committing"
  exit 1
else
  echo "  All good!"
fi
