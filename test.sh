#!/usr/bin/env bash
# Smoke test for myco — run before every commit.
set -euo pipefail

# ─── shared state ────────────────────────────────────────────────────────────
PASS=0
FAIL=0

# Server smoke test runtime state
SMOKE_PID=""
SMOKE_PORT=""
SMOKE_STATE_DIR=""
SMOKE_WORKSPACE=""

# Persistence test runtime state
PERSIST_DIR=""
PERSIST_HOME=""
PERSIST_WKS=""
PERSIST_TOKEN=""
PERSIST_NEW_TOKEN=""
PERSIST_SID=""
PERSIST_PORT=""
PERSIST_NAME=""

# ─── helpers ─────────────────────────────────────────────────────────────────
pass()    { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail()    { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
die()     { FAIL=$((FAIL+1)); echo "  ✗ FATAL: $1"; exit 1; }
section() { printf "\n── %s ──\n" "$*"; }

free_port() {
  python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()"
}

# ─── static checks ───────────────────────────────────────────────────────────

test_server_js_files() {
  node -e "
    const fs = require('fs');
    ['src/index.js','src/pty.js','src/sessions.js','src/transcript.js','src/auth.js','src/btw.js'].forEach(f => {
      try { require('fs').readFileSync('server/' + f, 'utf8'); } catch(e) { throw new Error('Missing: server/' + f); }
    });
  " && pass "Server JS files readable" || fail "Server JS files"
}

test_frontend_files() {
  for f in web/public/app.js web/public/styles.css web/public/index.html web/public/keyboard.js; do
    test -f "$f" && pass "$f exists" || fail "$f missing"
  done
}

test_vendor_assets() {
  for f in web/public/vendor/highlight.min.js web/public/vendor/mermaid.min.js web/public/vendor/github-dark.min.css; do
    test -f "$f" && pass "$f exists" || fail "$f missing"
  done
}

test_npm_deps() {
  (cd server && node -e "
    ['express','ws','marked','highlight.js','@homebridge/node-pty-prebuilt-multiarch','ansi-to-html'].forEach(p => {
      try { require.resolve(p); } catch { throw new Error('Missing npm dep: ' + p); }
    });
  ") && pass "npm deps resolve" || fail "npm deps"
}

test_cache_busters() {
  local app_v css_v
  app_v=$(grep -oP 'app\.js\?v=\K\d+' web/public/index.html)
  css_v=$(grep -oP 'styles\.css\?v=\K\d+' web/public/index.html)
  test -n "$app_v" && pass "app.js cache buster = v$app_v" || fail "app.js cache buster"
  test -n "$css_v" && pass "styles.css cache buster = v$css_v" || fail "styles.css cache buster"
}

test_conv_view_css() {
  grep -q 'conversation-wrap' web/public/styles.css && pass "conversation-wrap CSS" || fail "conversation-wrap CSS"
  grep -q 'conv-msg-user' web/public/styles.css && pass "user message CSS" || fail "user message CSS"
  grep -q 'conv-msg-assistant' web/public/styles.css && pass "assistant message CSS" || fail "assistant message CSS"
  grep -q 'conv-tool-call' web/public/styles.css && pass "tool call CSS" || fail "tool call CSS"
  grep -q 'conv-mermaid' web/public/styles.css && pass "mermaid CSS" || fail "mermaid CSS"
}

test_conv_view_js() {
  grep -q 'function renderConvMessage' web/public/app.js && pass "renderConvMessage" || fail "renderConvMessage"
  grep -q 'function renderMd' web/public/app.js && pass "renderMd" || fail "renderMd"
  grep -q 'function renderMermaidInContainer' web/public/app.js && pass "renderMermaidInContainer" || fail "renderMermaidInContainer"
  grep -q 'function openSession' web/public/app.js && pass "openSession" || fail "openSession"
  grep -q 'function renderTranscriptMessages' web/public/app.js && pass "renderTranscriptMessages" || fail "renderTranscriptMessages"
}

test_at_claude_chat_handler() {
  grep -q '@claude' server/src/pty.js && pass "@claude handler" || fail "@claude handler"
  grep -q 'session.write' server/src/pty.js && pass "PTY write for @claude" || fail "PTY write"
}

test_viewer_ws_handler_wired() {
  grep -q 'attachViewerWebSocket' server/src/pty.js && pass "attachViewerWebSocket" || fail "attachViewerWebSocket"
  grep -q 'attachViewerWebSocket' server/src/index.js && pass "viewer WS routing" || fail "viewer WS routing"
}

test_chat_user_capture() {
  grep -q 'body.user' web/public/app.js && pass "chatUser capture" || fail "chatUser capture"
  grep -q 'from-self' web/public/app.js && pass "self chat alignment" || fail "self chat alignment"
}

test_session_switching_clears_panes() {
  grep -q "conversation-wrap.*hidden.*true" web/public/app.js && pass "pane clear on switch" || fail "pane clear on switch"
}

test_mermaid_html_init() {
  grep -q 'mermaid.initialize' web/public/index.html && pass "mermaid init" || fail "mermaid init"
  grep -q 'highlight.min.js' web/public/index.html && pass "highlight.js loaded" || fail "highlight.js loaded"
}

run_static_checks() {
  section "Static checks"
  test_server_js_files
  test_frontend_files
  test_vendor_assets
  test_npm_deps
  test_cache_busters
  test_conv_view_css
  test_conv_view_js
  test_at_claude_chat_handler
  test_viewer_ws_handler_wired
  test_chat_user_capture
  test_session_switching_clears_panes
  test_mermaid_html_init
}

# ─── feature checks ──────────────────────────────────────────────────────────

test_syntax_highlighting() {
  grep -q 'hljs.highlight(' web/public/app.js && pass "hljs.highlight() invoked" || fail "hljs.highlight() invoked"
  grep -q 'hljs.highlightAuto(' web/public/app.js && pass "hljs.highlightAuto() invoked" || fail "hljs.highlightAuto() invoked"
  grep -q 'hljs.getLanguage(' web/public/app.js && pass "hljs language detection" || fail "hljs language detection"
  grep -q 'github-dark.min.css' web/public/index.html && pass "highlight theme CSS linked" || fail "highlight theme CSS linked"
  grep -q 'class="hljs' web/public/app.js && pass "hljs class emitted" || fail "hljs class emitted"
}

test_mermaid_diagrams() {
  grep -q 'mermaid.render(' web/public/app.js && pass "mermaid.render() invoked" || fail "mermaid.render() invoked"
  grep -q 'language-mermaid' web/public/app.js && pass "mermaid code-block detection" || fail "mermaid code-block detection"
  grep -q 'querySelectorAll.*language-mermaid' web/public/app.js && pass "mermaid block scan" || fail "mermaid block scan"
  grep -q "class.*=.*'conv-mermaid'" web/public/app.js && pass "conv-mermaid container created" || fail "conv-mermaid container created"
  grep -q '\.conv-mermaid' web/public/styles.css && pass "conv-mermaid styled" || fail "conv-mermaid styled"
}

test_readonly_viewer() {
  grep -q 'attachViewerWebSocket' server/src/pty.js && pass "viewer WS handler exported" || fail "viewer WS handler"
  grep -q 'readOnly' server/src/pty.js && pass "readOnly flag in pty" || fail "readOnly flag"
  grep -q "t: 'viewer-mode'" server/src/pty.js && pass "viewer-mode signal sent" || fail "viewer-mode signal"
  grep -q 'viewer-mode' web/public/app.js && pass "viewer-mode handled in client" || fail "viewer-mode client"
  # Server must drop write-side messages (PTY input/resize) for viewers
  grep -Pzoq '(?s)readOnly\s*\)\s*return.*?session\.write|session\.write.*?readOnly' server/src/pty.js \
    && pass "viewer drops PTY writes" \
    || fail "viewer drops PTY writes"
}

test_chat_window() {
  grep -q 'id="chatpane"' web/public/index.html && pass "#chatpane element" || fail "#chatpane element"
  grep -q 'id="chat-input"' web/public/index.html && pass "#chat-input element" || fail "#chat-input element"
  grep -q 'id="chat-send"' web/public/index.html && pass "#chat-send element" || fail "#chat-send element"
  grep -q 'id="chat-form"' web/public/index.html && pass "#chat-form element" || fail "#chat-form element"
  grep -q 'function sendChatMessage' web/public/app.js && pass "sendChatMessage() defined" || fail "sendChatMessage() defined"
  grep -q "t: 'chat'" server/src/pty.js && pass "chat WS frame format" || fail "chat WS frame"
  grep -q "t: 'chat-history'" server/src/pty.js && pass "chat-history replay" || fail "chat-history replay"
  grep -q "msg.t === 'chat-history'" web/public/app.js && pass "chat-history client handler" || fail "chat-history client handler"
  grep -q 'chatpane-close' web/public/app.js && pass "chatpane close binding" || fail "chatpane close binding"
}

test_layout() {
  grep -q -- '--sidebar-w' web/public/styles.css && pass "sidebar width var" || fail "sidebar width var"
  grep -q -- '--chatpane-w' web/public/styles.css && pass "chatpane width var" || fail "chatpane width var"
  grep -q '#sidebar' web/public/styles.css && pass "#sidebar styling" || fail "#sidebar styling"
  grep -q '#chatpane' web/public/styles.css && pass "#chatpane styling" || fail "#chatpane styling"
  grep -q '@media' web/public/styles.css && pass "responsive @media rule" || fail "responsive @media rule"
  grep -q 'id="sidebar"' web/public/index.html && pass "sidebar in HTML" || fail "sidebar in HTML"
  grep -q 'conversation-wrap' web/public/index.html && pass "conversation-wrap in HTML" || fail "conversation-wrap in HTML"
}

run_feature_checks() {
  section "Feature checks"
  test_syntax_highlighting
  test_mermaid_diagrams
  test_readonly_viewer
  test_chat_window
  test_layout
}

# ─── server smoke test ───────────────────────────────────────────────────────

start_smoke_server() {
  SMOKE_STATE_DIR=$(mktemp -d)
  SMOKE_WORKSPACE=$(mktemp -d)
  SMOKE_PORT=$(free_port)
  MYCO_STATE_DIR="$SMOKE_STATE_DIR" MYCO_WORKSPACE="$SMOKE_WORKSPACE" PORT="$SMOKE_PORT" \
    node server/src/index.js &
  SMOKE_PID=$!
  sleep 2
}

stop_smoke_server() {
  kill "$SMOKE_PID" 2>/dev/null || true
  rm -rf "$SMOKE_STATE_DIR" "$SMOKE_WORKSPACE"
}

test_server_root() {
  if curl -sf "http://127.0.0.1:$SMOKE_PORT/" -o /dev/null 2>/dev/null; then
    pass "Server responds on /"
  else
    fail "Server responds on / (port $SMOKE_PORT)"
  fi
}

test_sessions_endpoint() {
  if curl -sf "http://127.0.0.1:$SMOKE_PORT/sessions?all=1" -o /dev/null 2>/dev/null; then
    pass "GET /sessions?all=1"
  else
    fail "GET /sessions?all=1"
  fi
}

test_auth_check_endpoint() {
  local resp
  resp=$(curl -sf "http://127.0.0.1:$SMOKE_PORT/auth/check" 2>/dev/null || echo '{}')
  echo "$resp" | grep -q '"ok"' && pass "GET /auth/check" || fail "GET /auth/check"
}

test_vendor_serving() {
  curl -sf "http://127.0.0.1:$SMOKE_PORT/vendor/highlight.min.js" -o /dev/null 2>/dev/null && pass "highlight.min.js served" || fail "highlight.min.js served"
  curl -sf "http://127.0.0.1:$SMOKE_PORT/vendor/github-dark.min.css" -o /dev/null 2>/dev/null && pass "github-dark.css served" || fail "github-dark.css served"
  curl -sf "http://127.0.0.1:$SMOKE_PORT/vendor/mermaid.min.js" -o /dev/null 2>/dev/null && pass "mermaid.min.js served" || fail "mermaid.min.js served"
}

test_index_html_contents() {
  local index
  index=$(curl -sf "http://127.0.0.1:$SMOKE_PORT/" 2>/dev/null || echo "")
  echo "$index" | grep -q 'id="chatpane"' && pass "index serves chatpane" || fail "index serves chatpane"
  echo "$index" | grep -q 'conversation-wrap' && pass "index serves conversation-wrap" || fail "index serves conversation-wrap"
  echo "$index" | grep -q 'mermaid.min.js' && pass "index includes mermaid script" || fail "index includes mermaid script"
  echo "$index" | grep -q 'highlight.min.js' && pass "index includes highlight script" || fail "index includes highlight script"
}

test_invalid_share_token_rejected() {
  local resp
  resp=$(curl -s "http://127.0.0.1:$SMOKE_PORT/auth/check?s=bogus-token-xyz" 2>/dev/null || echo '{}')
  echo "$resp" | grep -q '"share":true' && fail "invalid share token rejected" || pass "invalid share token rejected"
}

run_server_smoke() {
  section "Server smoke test"
  start_smoke_server
  test_server_root
  test_sessions_endpoint
  test_auth_check_endpoint
  test_vendor_serving
  test_index_html_contents
  test_invalid_share_token_rejected
  stop_smoke_server
}

# ─── docker build ────────────────────────────────────────────────────────────

test_docker_build() {
  section "Docker build"
  docker build -t myco-test . --quiet 2>&1 && pass "Docker build" || fail "Docker build"
}

# ─── persistence: claude config / auth / sessions across restart + redeploy ──

setup_persist_env() {
  PERSIST_DIR=$(mktemp -d)
  PERSIST_HOME=$(mktemp -d)
  PERSIST_WKS=$(mktemp -d)
  PERSIST_TOKEN="t-$(date +%s%N | tail -c 12)"
  PERSIST_NEW_TOKEN="t-new-$(date +%s%N | tail -c 12)"
  PERSIST_SID="myco-persist-test-$(date +%s%N | tail -c 8)"
  PERSIST_PORT=$(free_port)
  PERSIST_NAME="myco-persist-$$"

  # .env: auth token mycod should load
  cat > "$PERSIST_DIR/.env" <<EOF
MYCO_TOKENS=alice:$PERSIST_TOKEN
EOF

  # sessions.json: pre-seeded session that should appear post-restart
  cat > "$PERSIST_DIR/sessions.json" <<EOF
{"sessions":{"$PERSIST_SID":{"id":"$PERSIST_SID","user":"alice","cwd":"persist-test","absCwd":"/wks/alice/persist-test","claudeSessionId":null,"createdAt":"2026-01-01T00:00:00.000Z"}},"dismissed":[]}
EOF

  # .claude.json + .claude/ — entrypoint should migrate these into /root
  echo '{"persistMarker":true,"version":42}' > "$PERSIST_DIR/.claude.json"
  mkdir -p "$PERSIST_DIR/.claude"
  echo '{"persistMarker":"settings"}' > "$PERSIST_DIR/.claude/settings.json"

  # Test Caddyfile — no ACME, accepts any host
  cat > "$PERSIST_DIR/Caddyfile" <<EOF
:80 {
    reverse_proxy localhost:3000
}
EOF

  # Pre-create the workspace dir mycod expects
  mkdir -p "$PERSIST_WKS/alice/persist-test"
}

start_persist_container() {
  docker rm -f "$PERSIST_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$PERSIST_NAME" \
    -p "$PERSIST_PORT:80" \
    -v "$PERSIST_DIR:/data" \
    -v "$PERSIST_HOME:/root" \
    -v "$PERSIST_WKS:/wks" \
    -v "$PERSIST_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
    myco-test >/dev/null 2>&1
}

wait_persist_ready() {
  local label="$1"
  local ready=0 i
  for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:$PERSIST_PORT/auth/check" -H "Authorization: Bearer $PERSIST_TOKEN" -o /dev/null 2>/dev/null; then
      ready=1; break
    fi
    sleep 0.5
  done
  [ "$ready" = "1" ] && pass "$label" || fail "$label"
}

test_persist_initial() {
  start_persist_container && pass "container started" || fail "container started"
  wait_persist_ready "container ready"

  local resp sessions
  resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/auth/check" -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  echo "$resp" | grep -q '"ok":true' && pass "auth token from .env works" || fail "auth from .env (got: $resp)"

  sessions=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions?all=1" -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  echo "$sessions" | grep -q "$PERSIST_SID" && pass "seeded session visible" || fail "seeded session visible"

  docker exec "$PERSIST_NAME" test -f /root/.claude.json && pass ".claude.json migrated to /root" || fail ".claude.json migrated"
  docker exec "$PERSIST_NAME" test -d /root/.claude && pass ".claude/ migrated to /root" || fail ".claude/ migrated"
  docker exec "$PERSIST_NAME" grep -q 'persistMarker' /root/.claude.json && pass ".claude.json contents preserved" || fail ".claude.json contents"
}

test_persist_after_restart() {
  docker restart "$PERSIST_NAME" >/dev/null 2>&1
  wait_persist_ready "container ready after restart"

  local resp sessions
  resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/auth/check" -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  echo "$resp" | grep -q '"ok":true' && pass "auth survives restart" || fail "auth survives restart"

  sessions=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions?all=1" -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  echo "$sessions" | grep -q "$PERSIST_SID" && pass "session survives restart" || fail "session survives restart"

  docker exec "$PERSIST_NAME" grep -q 'persistMarker' /root/.claude.json && pass "claude config survives restart" || fail "claude config survives restart"
}

test_persist_after_redeploy() {
  # Full rm + run cycle against the same data dir
  docker rm -f "$PERSIST_NAME" >/dev/null 2>&1
  start_persist_container
  wait_persist_ready "container ready after redeploy"

  local resp sessions
  resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/auth/check" -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  echo "$resp" | grep -q '"ok":true' && pass "auth survives redeploy" || fail "auth survives redeploy"

  sessions=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions?all=1" -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  echo "$sessions" | grep -q "$PERSIST_SID" && pass "session survives redeploy" || fail "session survives redeploy"

  docker exec "$PERSIST_NAME" grep -q 'persistMarker' /root/.claude.json && pass "claude config survives redeploy" || fail "claude config survives redeploy"
}

test_auth_hot_reload() {
  # Pre-flight: brand-new bob token must NOT auth yet.
  local resp
  resp=$(curl -s -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$PERSIST_PORT/sessions?all=1" \
    -H "Authorization: Bearer $PERSIST_NEW_TOKEN" 2>/dev/null)
  [ "$resp" = "401" ] \
    && pass "new token rejected before reload" \
    || fail "new token rejected before reload (got HTTP $resp)"

  # Add bob to /data/.env (kept on the host bind-mount so the container sees it).
  cat > "$PERSIST_DIR/.env" <<EOF
MYCO_TOKENS=alice:$PERSIST_TOKEN,bob:$PERSIST_NEW_TOKEN
EOF

  # Trigger hot-reload using alice's existing token.
  resp=$(curl -s -X POST "http://127.0.0.1:$PERSIST_PORT/auth/reload" \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  echo "$resp" | grep -q '"ok":true' \
    && pass "POST /auth/reload returns ok" \
    || fail "POST /auth/reload (got: $resp)"

  # Bob's token should now authenticate without a service restart.
  resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/auth/check" \
    -H "Authorization: Bearer $PERSIST_NEW_TOKEN" 2>/dev/null)
  echo "$resp" | grep -q '"ok":true' \
    && pass "new token accepted after hot-reload" \
    || fail "new token accepted after hot-reload (got: $resp)"

  # Sanity: alice still works after reload.
  resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/auth/check" \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  echo "$resp" | grep -q '"ok":true' \
    && pass "existing token still works after hot-reload" \
    || fail "existing token still works (got: $resp)"
}

test_auth_enables_via_hot_reload() {
  # Verify the flip-on path: a server started with NO tokens should become
  # auth-required after MYCO_TOKENS is added to .env and /auth/reload is hit.
  # Regression test for the const-AUTH_REQUIRED bug — the flag used to be
  # captured at module load and never re-evaluated.
  local tmp_dir tmp_home tmp_wks tmp_port tmp_name new_tok
  tmp_dir=$(mktemp -d)
  tmp_home=$(mktemp -d)
  tmp_wks=$(mktemp -d)
  tmp_port=$(free_port)
  tmp_name="myco-flip-$$"
  new_tok="t-flip-$(date +%s%N | tail -c 12)"

  # Start with NO MYCO_TOKENS in .env — auth should be disabled.
  : > "$tmp_dir/.env"
  cat > "$tmp_dir/Caddyfile" <<EOF
:80 {
    reverse_proxy localhost:3000
}
EOF

  docker rm -f "$tmp_name" >/dev/null 2>&1 || true
  docker run -d --name "$tmp_name" \
    -p "$tmp_port:80" \
    -v "$tmp_dir:/data" \
    -v "$tmp_home:/root" \
    -v "$tmp_wks:/wks" \
    -v "$tmp_dir/Caddyfile:/etc/caddy/Caddyfile:ro" \
    myco-test >/dev/null 2>&1

  local ready=0 i
  for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:$tmp_port/auth/check" -o /dev/null 2>/dev/null; then
      ready=1; break
    fi
    sleep 0.5
  done
  [ "$ready" = "1" ] && pass "no-auth container ready" || fail "no-auth container ready"

  local resp code
  resp=$(curl -s "http://127.0.0.1:$tmp_port/auth/check" 2>/dev/null)
  echo "$resp" | grep -q '"required":false' \
    && pass "auth disabled at start" \
    || fail "auth disabled at start (got: $resp)"

  # Add a token to .env and hot-reload (no auth currently, anyone can hit it).
  echo "MYCO_TOKENS=admin:$new_tok" > "$tmp_dir/.env"
  resp=$(curl -s -X POST "http://127.0.0.1:$tmp_port/auth/reload" 2>/dev/null)
  echo "$resp" | grep -q '"ok":true' \
    && pass "POST /auth/reload accepted while open" \
    || fail "POST /auth/reload while open (got: $resp)"

  # The flag must now reflect the populated TOKENS map.
  resp=$(curl -s "http://127.0.0.1:$tmp_port/auth/check" 2>/dev/null)
  echo "$resp" | grep -q '"required":true' \
    && pass "auth REQUIRED after hot-reload (was the bug)" \
    || fail "auth REQUIRED after hot-reload (got: $resp)"

  # Unauth request should now get 401.
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$tmp_port/sessions?all=1" 2>/dev/null)
  [ "$code" = "401" ] \
    && pass "unauth request rejected after reload" \
    || fail "unauth request rejected (got HTTP $code)"

  # New token should authenticate.
  resp=$(curl -s "http://127.0.0.1:$tmp_port/auth/check" \
    -H "Authorization: Bearer $new_tok" 2>/dev/null)
  echo "$resp" | grep -q '"ok":true' \
    && pass "new token authenticates after flip-on" \
    || fail "new token authenticates after flip-on (got: $resp)"

  # Cleanup
  docker rm -f "$tmp_name" >/dev/null 2>&1
  docker run --rm \
    -v "$tmp_dir:/d" -v "$tmp_home:/h" -v "$tmp_wks:/w" \
    alpine sh -c 'rm -rf /d/* /d/.* /h/* /h/.* /w/* /w/.* 2>/dev/null; true' >/dev/null 2>&1 || true
  rmdir "$tmp_dir" "$tmp_home" "$tmp_wks" 2>/dev/null || true
}

cleanup_persist_env() {
  # Entrypoint writes as root inside the container — use a one-shot container
  # to remove the bind-mounted contents, then rmdir the empty dirs as us.
  docker rm -f "$PERSIST_NAME" >/dev/null 2>&1
  docker run --rm \
    -v "$PERSIST_DIR:/d" -v "$PERSIST_HOME:/h" -v "$PERSIST_WKS:/w" \
    alpine sh -c 'rm -rf /d/* /d/.* /h/* /h/.* /w/* /w/.* 2>/dev/null; true' >/dev/null 2>&1 || true
  rmdir "$PERSIST_DIR" "$PERSIST_HOME" "$PERSIST_WKS" 2>/dev/null || true
}

run_persistence_checks() {
  section "Persistence: claude config / auth / sessions survive restart"
  setup_persist_env
  test_persist_initial
  test_persist_after_restart
  test_persist_after_redeploy
  test_auth_hot_reload
  test_auth_enables_via_hot_reload
  cleanup_persist_env
}

# ─── summary ─────────────────────────────────────────────────────────────────

print_summary() {
  echo ""
  echo "─────────────────────────"
  echo "  Passed: $PASS"
  echo "  Failed: $FAIL"
  if [ "$FAIL" -gt 0 ]; then
    echo "  FAILED — fix before committing"
    exit 1
  fi
  echo "  All good!"
}

# ─── main ────────────────────────────────────────────────────────────────────

main() {
  cd "$(dirname "$0")"
  run_static_checks
  run_feature_checks
  run_server_smoke
  test_docker_build
  run_persistence_checks
  print_summary
}

main "$@"
