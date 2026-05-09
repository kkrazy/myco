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
echo "── Feature checks ──"

# Syntax highlighting
grep -q 'hljs.highlight(' web/public/app.js && pass "hljs.highlight() invoked" || fail "hljs.highlight() invoked"
grep -q 'hljs.highlightAuto(' web/public/app.js && pass "hljs.highlightAuto() invoked" || fail "hljs.highlightAuto() invoked"
grep -q 'hljs.getLanguage(' web/public/app.js && pass "hljs language detection" || fail "hljs language detection"
grep -q 'github-dark.min.css' web/public/index.html && pass "highlight theme CSS linked" || fail "highlight theme CSS linked"
grep -q 'class="hljs' web/public/app.js && pass "hljs class emitted" || fail "hljs class emitted"

# Mermaid diagrams
grep -q 'mermaid.render(' web/public/app.js && pass "mermaid.render() invoked" || fail "mermaid.render() invoked"
grep -q 'language-mermaid' web/public/app.js && pass "mermaid code-block detection" || fail "mermaid code-block detection"
grep -q 'querySelectorAll.*language-mermaid' web/public/app.js && pass "mermaid block scan" || fail "mermaid block scan"
grep -q "class.*=.*'conv-mermaid'" web/public/app.js && pass "conv-mermaid container created" || fail "conv-mermaid container created"
grep -q '\.conv-mermaid' web/public/styles.css && pass "conv-mermaid styled" || fail "conv-mermaid styled"

# Read-only / viewer session
grep -q 'attachViewerWebSocket' server/src/pty.js && pass "viewer WS handler exported" || fail "viewer WS handler"
grep -q 'readOnly' server/src/pty.js && pass "readOnly flag in pty" || fail "readOnly flag"
grep -q "t: 'viewer-mode'" server/src/pty.js && pass "viewer-mode signal sent" || fail "viewer-mode signal"
grep -q 'viewer-mode' web/public/app.js && pass "viewer-mode handled in client" || fail "viewer-mode client"
# Server must drop write-side messages (PTY input/resize) for viewers
grep -Pzoq '(?s)readOnly\s*\)\s*return.*?session\.write|session\.write.*?readOnly' server/src/pty.js \
  && pass "viewer drops PTY writes" \
  || fail "viewer drops PTY writes"

# Chat window
grep -q 'id="chatpane"' web/public/index.html && pass "#chatpane element" || fail "#chatpane element"
grep -q 'id="chat-input"' web/public/index.html && pass "#chat-input element" || fail "#chat-input element"
grep -q 'id="chat-send"' web/public/index.html && pass "#chat-send element" || fail "#chat-send element"
grep -q 'id="chat-form"' web/public/index.html && pass "#chat-form element" || fail "#chat-form element"
grep -q 'function sendChatMessage' web/public/app.js && pass "sendChatMessage() defined" || fail "sendChatMessage() defined"
grep -q "t: 'chat'" server/src/pty.js && pass "chat WS frame format" || fail "chat WS frame"
grep -q "t: 'chat-history'" server/src/pty.js && pass "chat-history replay" || fail "chat-history replay"
grep -q "msg.t === 'chat-history'" web/public/app.js && pass "chat-history client handler" || fail "chat-history client handler"
grep -q 'chatpane-close' web/public/app.js && pass "chatpane close binding" || fail "chatpane close binding"

# Layout
grep -q -- '--sidebar-w' web/public/styles.css && pass "sidebar width var" || fail "sidebar width var"
grep -q -- '--chatpane-w' web/public/styles.css && pass "chatpane width var" || fail "chatpane width var"
grep -q '#sidebar' web/public/styles.css && pass "#sidebar styling" || fail "#sidebar styling"
grep -q '#chatpane' web/public/styles.css && pass "#chatpane styling" || fail "#chatpane styling"
grep -q '@media' web/public/styles.css && pass "responsive @media rule" || fail "responsive @media rule"
grep -q 'id="sidebar"' web/public/index.html && pass "sidebar in HTML" || fail "sidebar in HTML"
grep -q 'conversation-wrap' web/public/index.html && pass "conversation-wrap in HTML" || fail "conversation-wrap in HTML"

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

# 17. Index HTML actually serves the chat pane and conversation wrapper
INDEX=$(curl -sf "http://127.0.0.1:$TEST_PORT/" 2>/dev/null || echo "")
echo "$INDEX" | grep -q 'id="chatpane"' && pass "index serves chatpane" || fail "index serves chatpane"
echo "$INDEX" | grep -q 'conversation-wrap' && pass "index serves conversation-wrap" || fail "index serves conversation-wrap"
echo "$INDEX" | grep -q 'mermaid.min.js' && pass "index includes mermaid script" || fail "index includes mermaid script"
echo "$INDEX" | grep -q 'highlight.min.js' && pass "index includes highlight script" || fail "index includes highlight script"

# 18. Invalid share token is rejected (read-only path returns share=false / not ok)
SHARE_RESP=$(curl -s "http://127.0.0.1:$TEST_PORT/auth/check?s=bogus-token-xyz" 2>/dev/null || echo '{}')
echo "$SHARE_RESP" | grep -q '"share":true' && fail "invalid share token rejected" || pass "invalid share token rejected"

# Cleanup
kill $SERVER_PID 2>/dev/null || true
rm -rf "$MYCO_STATE_DIR" "$MYCO_WORKSPACE"

echo ""
echo "── Docker build ──"
docker build -t myco-test . --quiet 2>&1 && pass "Docker build" || fail "Docker build"

echo ""
echo "── Persistence: claude config / auth / sessions survive restart ──"

# Set up an isolated data dir with seeded auth + sessions + claude config
PERSIST_DIR=$(mktemp -d)
PERSIST_HOME=$(mktemp -d)
PERSIST_WKS=$(mktemp -d)
PERSIST_TOKEN="t-$(date +%s%N | tail -c 12)"
PERSIST_SID="myco-persist-test-$(date +%s%N | tail -c 8)"
PERSIST_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()")
PERSIST_NAME="myco-persist-$$"

# 1. .env: auth token that mycod should load
cat > "$PERSIST_DIR/.env" <<EOF
MYCO_TOKENS=alice:$PERSIST_TOKEN
EOF

# 2. sessions.json: a hand-rolled session that should appear post-restart
cat > "$PERSIST_DIR/sessions.json" <<EOF
{"sessions":{"$PERSIST_SID":{"id":"$PERSIST_SID","user":"alice","cwd":"persist-test","absCwd":"/wks/alice/persist-test","claudeSessionId":null,"createdAt":"2026-01-01T00:00:00.000Z"}},"dismissed":[]}
EOF

# 3. .claude.json + .claude/ — entrypoint should migrate these into /root
echo '{"persistMarker":true,"version":42}' > "$PERSIST_DIR/.claude.json"
mkdir -p "$PERSIST_DIR/.claude"
echo '{"persistMarker":"settings"}' > "$PERSIST_DIR/.claude/settings.json"

# 4. Test Caddyfile — no ACME, accepts any host (Caddy still proxies to node:3000)
cat > "$PERSIST_DIR/Caddyfile" <<EOF
:80 {
    reverse_proxy localhost:3000
}
EOF

# 5. Pre-create the workspace dir mycod expects (mirrors the absCwd above)
mkdir -p "$PERSIST_WKS/alice/persist-test"

docker rm -f "$PERSIST_NAME" >/dev/null 2>&1 || true
docker run -d --name "$PERSIST_NAME" \
  -p "$PERSIST_PORT:80" \
  -v "$PERSIST_DIR:/data" \
  -v "$PERSIST_HOME:/root" \
  -v "$PERSIST_WKS:/wks" \
  -v "$PERSIST_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
  myco-test >/dev/null 2>&1 && pass "container started" || fail "container started"

# Wait for ready (Caddy + node both up)
PERSIST_READY=0
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PERSIST_PORT/auth/check" -H "Authorization: Bearer $PERSIST_TOKEN" -o /dev/null 2>/dev/null; then
    PERSIST_READY=1; break
  fi
  sleep 0.5
done
[ "$PERSIST_READY" = "1" ] && pass "container ready" || fail "container ready"

# Pre-restart checks
RESP1=$(curl -s "http://127.0.0.1:$PERSIST_PORT/auth/check" -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
echo "$RESP1" | grep -q '"ok":true' && pass "auth token from .env works" || fail "auth from .env (got: $RESP1)"

SESS1=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions?all=1" -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
echo "$SESS1" | grep -q "$PERSIST_SID" && pass "seeded session visible" || fail "seeded session visible"

docker exec "$PERSIST_NAME" test -f /root/.claude.json && pass ".claude.json migrated to /root" || fail ".claude.json migrated"
docker exec "$PERSIST_NAME" test -d /root/.claude && pass ".claude/ migrated to /root" || fail ".claude/ migrated"
docker exec "$PERSIST_NAME" grep -q 'persistMarker' /root/.claude.json && pass ".claude.json contents preserved" || fail ".claude.json contents"

# Restart and re-check the same things
docker restart "$PERSIST_NAME" >/dev/null 2>&1
PERSIST_READY=0
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PERSIST_PORT/auth/check" -H "Authorization: Bearer $PERSIST_TOKEN" -o /dev/null 2>/dev/null; then
    PERSIST_READY=1; break
  fi
  sleep 0.5
done
[ "$PERSIST_READY" = "1" ] && pass "container ready after restart" || fail "container ready after restart"

RESP2=$(curl -s "http://127.0.0.1:$PERSIST_PORT/auth/check" -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
echo "$RESP2" | grep -q '"ok":true' && pass "auth survives restart" || fail "auth survives restart"

SESS2=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions?all=1" -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
echo "$SESS2" | grep -q "$PERSIST_SID" && pass "session survives restart" || fail "session survives restart"

docker exec "$PERSIST_NAME" grep -q 'persistMarker' /root/.claude.json && pass "claude config survives restart" || fail "claude config survives restart"

# Redeploy: stop, remove, run a fresh container against the same data dir
docker rm -f "$PERSIST_NAME" >/dev/null 2>&1
docker run -d --name "$PERSIST_NAME" \
  -p "$PERSIST_PORT:80" \
  -v "$PERSIST_DIR:/data" \
  -v "$PERSIST_HOME:/root" \
  -v "$PERSIST_WKS:/wks" \
  -v "$PERSIST_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
  myco-test >/dev/null 2>&1

PERSIST_READY=0
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PERSIST_PORT/auth/check" -H "Authorization: Bearer $PERSIST_TOKEN" -o /dev/null 2>/dev/null; then
    PERSIST_READY=1; break
  fi
  sleep 0.5
done
[ "$PERSIST_READY" = "1" ] && pass "container ready after redeploy" || fail "container ready after redeploy"

RESP3=$(curl -s "http://127.0.0.1:$PERSIST_PORT/auth/check" -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
echo "$RESP3" | grep -q '"ok":true' && pass "auth survives redeploy" || fail "auth survives redeploy"

SESS3=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions?all=1" -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
echo "$SESS3" | grep -q "$PERSIST_SID" && pass "session survives redeploy" || fail "session survives redeploy"

docker exec "$PERSIST_NAME" grep -q 'persistMarker' /root/.claude.json && pass "claude config survives redeploy" || fail "claude config survives redeploy"

# Cleanup — entrypoint writes as root inside the container, so use a one-shot
# container to remove the bind-mounted contents, then rm the empty dirs as us.
docker rm -f "$PERSIST_NAME" >/dev/null 2>&1
docker run --rm \
  -v "$PERSIST_DIR:/d" -v "$PERSIST_HOME:/h" -v "$PERSIST_WKS:/w" \
  alpine sh -c 'rm -rf /d/* /d/.* /h/* /h/.* /w/* /w/.* 2>/dev/null; true' >/dev/null 2>&1 || true
rmdir "$PERSIST_DIR" "$PERSIST_HOME" "$PERSIST_WKS" 2>/dev/null || true

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
