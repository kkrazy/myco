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

test_at_myco_chat_handler() {
  grep -q '@myco' server/src/pty.js && pass "@myco handler" || fail "@myco handler"
  grep -q 'session.write' server/src/pty.js && pass "PTY write for @myco" || fail "PTY write"
  # Plain chat (no @myco prefix, no /btw) must NOT trigger the assistant.
  # Regression guard: the old shouldAskAssistant treated any '?'-ending
  # message as an assistant trigger, making every question look like claude
  # was replying even without a /btw prefix.
  node -e "
    const { shouldAskAssistant } = require('./server/src/btw');
    const cases = [
      ['hello', false],
      ['is this on?', false],
      ['@myco what time is it', false],
      ['/btw whats up', true],
    ];
    for (const [text, want] of cases) {
      const got = shouldAskAssistant(text);
      if (got !== want) throw new Error('shouldAskAssistant(' + JSON.stringify(text) + ') = ' + got + ', want ' + want);
    }
  " && pass "shouldAskAssistant only fires on /btw" || fail "shouldAskAssistant fires too eagerly"
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

test_status_bar_user_and_build_stamps() {
  # Status-bar chips that surface "logged in as X" + build timestamp.
  grep -q 'id="build-stamp"' web/public/index.html && pass "#build-stamp in HTML" || fail "#build-stamp in HTML"
  grep -q 'id="user-stamp"' web/public/index.html && pass "#user-stamp in HTML" || fail "#user-stamp in HTML"
  grep -q 'function showBuildStamp' web/public/app.js && pass "showBuildStamp() defined" || fail "showBuildStamp() defined"
  grep -q 'function showUserStamp' web/public/app.js && pass "showUserStamp() defined" || fail "showUserStamp() defined"
  grep -q "fetch('/build.txt'" web/public/app.js && pass "build.txt fetched on load" || fail "build.txt fetched on load"
  grep -q '/build\.txt' Dockerfile && pass "Dockerfile writes build.txt" || fail "Dockerfile writes build.txt"
}

test_mermaid_html_init() {
  grep -q 'mermaid.initialize' web/public/index.html && pass "mermaid init" || fail "mermaid init"
  grep -q 'highlight.min.js' web/public/index.html && pass "highlight.js loaded" || fail "highlight.js loaded"
}

test_file_viewer_polish_static() {
  # Header chrome + action bar additions in HTML
  grep -q 'id="files-view-crumbs"' web/public/index.html && pass "html: #files-view-crumbs" || fail "html: #files-view-crumbs"
  grep -q 'id="files-view-lang"'   web/public/index.html && pass "html: #files-view-lang"   || fail "html: #files-view-lang"
  grep -q 'id="files-view-size"'   web/public/index.html && pass "html: #files-view-size"   || fail "html: #files-view-size"
  grep -q 'id="files-view-body"'   web/public/index.html && pass "html: #files-view-body"   || fail "html: #files-view-body"
  grep -q 'id="files-action-bar"'  web/public/index.html && pass "html: #files-action-bar"  || fail "html: #files-action-bar"
  grep -q 'id="files-copy"'        web/public/index.html && pass "html: #files-copy"        || fail "html: #files-copy"
  grep -q 'id="files-wrap-toggle"' web/public/index.html && pass "html: #files-wrap-toggle" || fail "html: #files-wrap-toggle"
  grep -q 'data-action="explain"'  web/public/index.html && pass "html: action explain"     || fail "html: action explain"

  # CSS
  grep -q '#files-action-bar' web/public/styles.css && pass "css: #files-action-bar" || fail "css: #files-action-bar"
  grep -q '\.claude-card'     web/public/styles.css && pass "css: .claude-card"     || fail "css: .claude-card"
  grep -q '\.code-chunk'      web/public/styles.css && pass "css: .code-chunk"      || fail "css: .code-chunk"
  grep -q '\.ln-gutter'       web/public/styles.css && pass "css: .ln-gutter"       || fail "css: .ln-gutter"
  grep -q '\.lang-badge'      web/public/styles.css && pass "css: .lang-badge"      || fail "css: .lang-badge"

  # JS
  grep -q 'function renderFileViewerWithCards' web/public/app.js && pass "js: renderFileViewerWithCards" || fail "js: renderFileViewerWithCards"
  grep -q 'function renderClaudeCard'          web/public/app.js && pass "js: renderClaudeCard"          || fail "js: renderClaudeCard"
  grep -q 'function loadFileChat'              web/public/app.js && pass "js: loadFileChat"              || fail "js: loadFileChat"
  grep -q 'function askClaudeAboutSelection'   web/public/app.js && pass "js: askClaudeAboutSelection"   || fail "js: askClaudeAboutSelection"
  grep -q 'function deleteClaudeCard'          web/public/app.js && pass "js: deleteClaudeCard"          || fail "js: deleteClaudeCard"
  grep -q 'function onSelectionChange'         web/public/app.js && pass "js: onSelectionChange"         || fail "js: onSelectionChange"
  grep -q 'function renderCodeChunk'           web/public/app.js && pass "js: renderCodeChunk"           || fail "js: renderCodeChunk"

  # Backend
  grep -q 'function askAboutFile' server/src/btw.js && pass "btw.js: askAboutFile" || fail "btw.js: askAboutFile"
  grep -q 'fileChats'             server/src/sessions.js && pass "sessions.js: fileChats" || fail "sessions.js: fileChats"
  grep -q 'appendFileChatMessage' server/src/sessions.js && pass "sessions.js: appendFileChatMessage" || fail "sessions.js: appendFileChatMessage"
  grep -q 'deleteFileChatMessage' server/src/sessions.js && pass "sessions.js: deleteFileChatMessage" || fail "sessions.js: deleteFileChatMessage"
  grep -q "app.get.*'/sessions/:id/file-chat'" server/src/index.js    && pass "GET /file-chat route"    || fail "GET /file-chat route"
  grep -q "app.post.*'/sessions/:id/file-chat'" server/src/index.js   && pass "POST /file-chat route"   || fail "POST /file-chat route"
  grep -q "app.delete.*'/sessions/:id/file-chat'" server/src/index.js && pass "DELETE /file-chat route" || fail "DELETE /file-chat route"
}

test_file_explorer_static() {
  # Backend module + routes
  test -f server/src/files.js && pass "server/src/files.js exists" || fail "server/src/files.js missing"
  grep -q 'function safeJoin' server/src/files.js && pass "files.js: safeJoin"            || fail "files.js: safeJoin"
  grep -q 'ERR_MTIME_CONFLICT' server/src/files.js && pass "files.js: ERR_MTIME_CONFLICT" || fail "files.js: ERR_MTIME_CONFLICT"
  grep -q 'ERR_OUTSIDE' server/src/files.js && pass "files.js: ERR_OUTSIDE"               || fail "files.js: ERR_OUTSIDE"
  grep -q "require('./files')" server/src/index.js && pass "index.js: requires files"      || fail "index.js: requires files"
  grep -q "app.get.*'/sessions/:id/files'" server/src/index.js  && pass "GET /sessions/:id/files route"  || fail "GET /sessions/:id/files route"
  grep -q "app.get.*'/sessions/:id/file'"  server/src/index.js  && pass "GET /sessions/:id/file route"   || fail "GET /sessions/:id/file route"
  grep -q "app.put.*'/sessions/:id/file'"  server/src/index.js  && pass "PUT /sessions/:id/file route"   || fail "PUT /sessions/:id/file route"
  grep -q 'resolveCwd' server/src/sessions.js && pass "sessions.js: resolveCwd defined"    || fail "sessions.js: resolveCwd defined"
  grep -q 'resolveCwd,' server/src/sessions.js && pass "sessions.js: exports resolveCwd"   || fail "sessions.js: exports resolveCwd"

  # Frontend HTML
  grep -q 'id="btn-files"'   web/public/index.html && pass "html: #btn-files"   || fail "html: #btn-files"
  grep -q 'id="files-wrap"'  web/public/index.html && pass "html: #files-wrap"  || fail "html: #files-wrap"
  grep -q 'id="files-tree"'  web/public/index.html && pass "html: #files-tree"  || fail "html: #files-tree"

  # Frontend CSS
  grep -q '#files-wrap'      web/public/styles.css && pass "css: #files-wrap"   || fail "css: #files-wrap"
  grep -q '#btn-files'       web/public/styles.css && pass "css: #btn-files"    || fail "css: #btn-files"

  # Frontend JS
  grep -q 'function loadFileTree'    web/public/app.js && pass "js: loadFileTree"    || fail "js: loadFileTree"
  grep -q 'function openFileInViewer' web/public/app.js && pass "js: openFileInViewer" || fail "js: openFileInViewer"
  grep -q 'function saveFile'        web/public/app.js && pass "js: saveFile"        || fail "js: saveFile"
  grep -q 'function enterEditMode'   web/public/app.js && pass "js: enterEditMode"   || fail "js: enterEditMode"
  grep -q 'expectedMtimeMs'          web/public/app.js && pass "js: mtime guard sent"|| fail "js: mtime guard sent"
}

test_deploy_add_token() {
  grep -q '^add_token()' deploy.sh             && pass "deploy.sh: add_token() defined"        || fail "deploy.sh: add_token() defined"
  grep -q '^upsert_token_in_env()' deploy.sh   && pass "deploy.sh: upsert_token_in_env()"      || fail "deploy.sh: upsert_token_in_env()"
  grep -q '^hot_reload_auth()' deploy.sh       && pass "deploy.sh: hot_reload_auth()"          || fail "deploy.sh: hot_reload_auth()"
  grep -q -- '--add-token)' deploy.sh          && pass "deploy.sh: --add-token flag parsed"    || fail "deploy.sh: --add-token flag parsed"
  grep -q 'add_token "$ADD_TOKEN"' deploy.sh   && pass "deploy.sh: main() dispatches add_token" || fail "deploy.sh: main() dispatches add_token"
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
  test_at_myco_chat_handler
  test_viewer_ws_handler_wired
  test_chat_user_capture
  test_session_switching_clears_panes
  test_mermaid_html_init
  test_status_bar_user_and_build_stamps
  test_deploy_add_token
  test_file_explorer_static
  test_file_viewer_polish_static
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

test_cache_headers() {
  # Static vendor assets and ?v=… cache-busted files should be long-cached.
  # Dynamic responses (HTML index, /sessions, /auth/*) must stay no-store.
  local h
  h=$(curl -sI "http://127.0.0.1:$SMOKE_PORT/vendor/highlight.min.js" 2>/dev/null | tr -d '\r')
  echo "$h" | grep -qi '^cache-control:.*max-age=31536000' \
    && pass "vendor: long Cache-Control" \
    || fail "vendor: long Cache-Control"

  h=$(curl -sI "http://127.0.0.1:$SMOKE_PORT/styles.css?v=1" 2>/dev/null | tr -d '\r')
  echo "$h" | grep -qi '^cache-control:.*max-age=31536000' \
    && pass "?v= cache-busted: long Cache-Control" \
    || fail "?v= cache-busted: long Cache-Control"

  h=$(curl -sI "http://127.0.0.1:$SMOKE_PORT/" 2>/dev/null | tr -d '\r')
  echo "$h" | grep -qi '^cache-control:.*no-store' \
    && pass "HTML index: no-store" \
    || fail "HTML index: no-store"

  h=$(curl -sI "http://127.0.0.1:$SMOKE_PORT/sessions?all=1" 2>/dev/null | tr -d '\r')
  echo "$h" | grep -qi '^cache-control:.*no-store' \
    && pass "API endpoint: no-store" \
    || fail "API endpoint: no-store"
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
  test_cache_headers
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

  # Pre-create the workspace dir mycod expects + seed a file for the
  # file-explorer API tests (test_files_api).
  mkdir -p "$PERSIST_WKS/alice/persist-test/sub"
  printf 'hi\n' > "$PERSIST_WKS/alice/persist-test/hello.txt"
  printf 'inside\n' > "$PERSIST_WKS/alice/persist-test/sub/inner.txt"
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

test_non_owner_sees_session_with_owner_tag() {
  # After test_auth_hot_reload, both alice's token and bob's token are loaded.
  # bob (a non-owner) should see alice's seeded session in /sessions?all=1
  # tagged with owned=false and owner="alice", so the client can render the
  # read-only badge and route through the viewer WS path.
  local sessions
  sessions=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions?all=1" \
    -H "Authorization: Bearer $PERSIST_NEW_TOKEN" 2>/dev/null)
  echo "$sessions" | grep -q "$PERSIST_SID" \
    && pass "non-owner sees other-user session" \
    || fail "non-owner sees other-user session (got: $sessions)"
  echo "$sessions" | grep -qE '"owned":false' \
    && pass "session tagged owned=false for non-owner" \
    || fail "session tagged owned=false (got: $sessions)"
  echo "$sessions" | grep -q '"owner":"alice"' \
    && pass "session carries owner name for non-owner" \
    || fail "session carries owner name (got: $sessions)"
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

test_files_api() {
  # ── 1. List the seeded session's cwd. hello.txt + sub/ should both appear.
  local resp
  resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/files?path=." \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  echo "$resp" | grep -q '"hello.txt"' && pass "files: list shows hello.txt" \
    || fail "files: list shows hello.txt (got: $resp)"
  echo "$resp" | grep -q '"sub"'       && pass "files: list shows sub/"      \
    || fail "files: list shows sub/ (got: $resp)"
  echo "$resp" | grep -q '"kind":"dir"'  && pass "files: list tags dir kind"   \
    || fail "files: list tags dir kind"
  echo "$resp" | grep -q '"kind":"file"' && pass "files: list tags file kind"  \
    || fail "files: list tags file kind"

  # ── 2. Read hello.txt → content + numeric mtime.
  resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file?path=hello.txt" \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  echo "$resp" | grep -q '"content":"hi\\n"' && pass "files: read returns content" \
    || fail "files: read returns content (got: $resp)"
  local mtime
  mtime=$(echo "$resp" | grep -oE '"mtimeMs":[0-9.]+' | head -1 | sed 's/.*://')
  [ -n "$mtime" ] && pass "files: read returns numeric mtimeMs ($mtime)" \
    || fail "files: read returns numeric mtimeMs (got: $resp)"

  # ── 3. Write happy path with the captured mtime → 200; re-read shows new content.
  resp=$(curl -s -X PUT "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file" \
    -H "Authorization: Bearer $PERSIST_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"path\":\"hello.txt\",\"content\":\"bye\\n\",\"expectedMtimeMs\":$mtime}" 2>/dev/null)
  echo "$resp" | grep -q '"mtimeMs"' && pass "files: write 200 returns new mtime" \
    || fail "files: write 200 returns new mtime (got: $resp)"
  resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file?path=hello.txt" \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  echo "$resp" | grep -q '"content":"bye\\n"' && pass "files: written content persists" \
    || fail "files: written content persists (got: $resp)"

  # ── 4. Path traversal on GET → 403.
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file?path=../../../etc/passwd" \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  [ "$code" = "403" ] && pass "files: GET path traversal → 403" \
    || fail "files: GET path traversal → 403 (got HTTP $code)"

  # ── 5. Path traversal on PUT → 403, and no escape.txt appears at the workspace root.
  code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file" \
    -H "Authorization: Bearer $PERSIST_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"path":"../escape.txt","content":"x","expectedMtimeMs":1}' 2>/dev/null)
  [ "$code" = "403" ] && pass "files: PUT path traversal → 403" \
    || fail "files: PUT path traversal → 403 (got HTTP $code)"
  [ ! -e "$PERSIST_WKS/alice/escape.txt" ] && pass "files: traversal did not write escape file" \
    || fail "files: traversal did not write escape file"

  # ── 6. mtime conflict on PUT → 409.
  code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file" \
    -H "Authorization: Bearer $PERSIST_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"path":"hello.txt","content":"x","expectedMtimeMs":1}' 2>/dev/null)
  [ "$code" = "409" ] && pass "files: stale mtime → 409" \
    || fail "files: stale mtime → 409 (got HTTP $code)"

  # ── 7. Bob (non-owner, after test_auth_hot_reload) gets 403 on all three routes.
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/files?path=." \
    -H "Authorization: Bearer $PERSIST_NEW_TOKEN" 2>/dev/null)
  [ "$code" = "403" ] && pass "files: non-owner GET list → 403" \
    || fail "files: non-owner GET list → 403 (got HTTP $code)"
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file?path=hello.txt" \
    -H "Authorization: Bearer $PERSIST_NEW_TOKEN" 2>/dev/null)
  [ "$code" = "403" ] && pass "files: non-owner GET file → 403" \
    || fail "files: non-owner GET file → 403 (got HTTP $code)"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file" \
    -H "Authorization: Bearer $PERSIST_NEW_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"path":"hello.txt","content":"x","expectedMtimeMs":1}' 2>/dev/null)
  [ "$code" = "403" ] && pass "files: non-owner PUT → 403" \
    || fail "files: non-owner PUT → 403 (got HTTP $code)"

  # ── 8. Share-token client (no Bearer) → 401. The file API requires real auth.
  local share_url share_tok
  share_url=$(curl -s -X POST \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/share" \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  share_tok=$(echo "$share_url" | grep -oE '\?s=[^"]+' | head -1 | sed 's/^?s=//')
  if [ -n "$share_tok" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file?path=hello.txt&s=$share_tok" 2>/dev/null)
    [ "$code" = "401" ] && pass "files: share-token client → 401 on file API" \
      || fail "files: share-token client → 401 on file API (got HTTP $code)"
  else
    fail "files: could not mint share token (got: $share_url)"
  fi

  # ── 9. PUT to a non-existent path → 404 (no creates in v1).
  code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file" \
    -H "Authorization: Bearer $PERSIST_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"path":"new.txt","content":"x","expectedMtimeMs":0}' 2>/dev/null)
  [ "$code" = "404" ] && pass "files: PUT to missing file → 404" \
    || fail "files: PUT to missing file → 404 (got HTTP $code)"

  # ── 10. Binary file detection. Drop a NULL byte into a file via docker exec
  # so it's seen by the same FS the server is reading.
  docker exec "$PERSIST_NAME" sh -c 'printf "\x00\x01\x02hello" > /wks/alice/persist-test/binfile.bin' >/dev/null 2>&1
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file?path=binfile.bin" \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  [ "$code" = "415" ] && pass "files: binary file → 415" \
    || fail "files: binary file → 415 (got HTTP $code)"
}

test_file_chat_api() {
  # File-chat persists per (session, file). We don't assume a real Claude
  # subscription is reachable — `claude -p` may fail and return an error
  # stand-in. The API contract (200 + structured message) still holds, and
  # the user message is appended even on Claude failure, so we can verify
  # storage + ordering without being subscription-dependent.

  # ── 1. GET on a file with no thread → empty messages array.
  local resp
  resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file-chat?path=hello.txt" \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  echo "$resp" | grep -q '"messages":\[\]' && pass "file-chat: empty thread on first GET" \
    || fail "file-chat: empty thread on first GET (got: $resp)"

  # ── 2. POST a question; expect 200 with a `message` object whose user is 'claude'
  # and a `userMessage` echoing the question. Note: claude -p may take 30+s; allow
  # generous timeout. We don't care if claude returned an error stand-in.
  resp=$(curl -s --max-time 90 -X POST \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file-chat" \
    -H "Authorization: Bearer $PERSIST_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"path":"hello.txt","anchor":{"startLine":1,"endLine":1},"question":"what is in this file?"}' 2>/dev/null)
  echo "$resp" | grep -q '"message"'      && pass "file-chat: POST returns message" \
    || fail "file-chat: POST returns message (got: $resp)"
  echo "$resp" | grep -q '"user":"claude"' && pass "file-chat: reply tagged user=claude" \
    || fail "file-chat: reply tagged user=claude (got: $resp)"
  echo "$resp" | grep -q '"userMessage"'   && pass "file-chat: POST echoes userMessage" \
    || fail "file-chat: POST echoes userMessage"

  # ── 3. GET again → at least the user msg + the claude reply both present.
  resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file-chat?path=hello.txt" \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  local you_count claude_count
  you_count=$(echo "$resp" | grep -o '"user":"you"' | wc -l)
  claude_count=$(echo "$resp" | grep -o '"user":"claude"' | wc -l)
  [ "$you_count" -ge 1 ]    && pass "file-chat: user message persisted ($you_count)"     || fail "file-chat: user message persisted (got $you_count)"
  [ "$claude_count" -ge 1 ] && pass "file-chat: claude reply persisted ($claude_count)" || fail "file-chat: claude reply persisted (got $claude_count)"

  # ── 4. Anchor shape preserved on the persisted user message.
  echo "$resp" | grep -q '"startLine":1' && pass "file-chat: anchor.startLine persisted" || fail "file-chat: anchor.startLine persisted"
  echo "$resp" | grep -q '"endLine":1'   && pass "file-chat: anchor.endLine persisted"   || fail "file-chat: anchor.endLine persisted"

  # ── 5. Restart container; thread survives (in the session store).
  docker restart "$PERSIST_NAME" >/dev/null 2>&1
  wait_persist_ready "container ready after file-chat restart"
  resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file-chat?path=hello.txt" \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  you_count=$(echo "$resp" | grep -o '"user":"you"' | wc -l)
  [ "$you_count" -ge 1 ] && pass "file-chat: thread survives container restart" \
    || fail "file-chat: thread survives container restart (got: $resp)"

  # ── 6. Path traversal rejected.
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file-chat?path=../../../etc/passwd" \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  [ "$code" = "403" ] && pass "file-chat: GET path traversal → 403" \
    || fail "file-chat: GET path traversal → 403 (got HTTP $code)"

  # ── 7. Bob (non-owner) gets 403 on all three methods.
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file-chat?path=hello.txt" \
    -H "Authorization: Bearer $PERSIST_NEW_TOKEN" 2>/dev/null)
  [ "$code" = "403" ] && pass "file-chat: non-owner GET → 403" \
    || fail "file-chat: non-owner GET → 403 (got HTTP $code)"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file-chat" \
    -H "Authorization: Bearer $PERSIST_NEW_TOKEN" -H "Content-Type: application/json" \
    -d '{"path":"hello.txt","question":"x"}' 2>/dev/null)
  [ "$code" = "403" ] && pass "file-chat: non-owner POST → 403" \
    || fail "file-chat: non-owner POST → 403 (got HTTP $code)"

  # ── 8. Share-token client → 401.
  local share_url share_tok
  share_url=$(curl -s -X POST \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/share" \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  share_tok=$(echo "$share_url" | grep -oE '\?s=[^"]+' | head -1 | sed 's/^?s=//')
  if [ -n "$share_tok" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file-chat?path=hello.txt&s=$share_tok" 2>/dev/null)
    [ "$code" = "401" ] && pass "file-chat: share-token client → 401" \
      || fail "file-chat: share-token client → 401 (got HTTP $code)"
  fi

  # ── 9. DELETE removes one message; subsequent GET shows fewer messages.
  # Pull a Claude message id from the thread.
  local mid before_n after_n
  resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file-chat?path=hello.txt" \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  before_n=$(echo "$resp" | grep -o '"id":"[a-f0-9]\+"' | wc -l)
  mid=$(echo "$resp" | grep -oE '"id":"[a-f0-9]+"' | head -1 | sed 's/.*"id":"\([a-f0-9]*\)".*/\1/')
  if [ -n "$mid" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
      "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file-chat?path=hello.txt&messageId=$mid" \
      -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
    [ "$code" = "200" ] && pass "file-chat: DELETE existing message → 200" \
      || fail "file-chat: DELETE existing message → 200 (got HTTP $code)"
    resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file-chat?path=hello.txt" \
      -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
    after_n=$(echo "$resp" | grep -o '"id":"[a-f0-9]\+"' | wc -l)
    [ "$after_n" -lt "$before_n" ] && pass "file-chat: DELETE actually removed ($before_n→$after_n)" \
      || fail "file-chat: DELETE removed (was $before_n, now $after_n)"
  fi

  # ── 10. DELETE non-existent messageId → 404.
  code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file-chat?path=hello.txt&messageId=deadbeef" \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  [ "$code" = "404" ] && pass "file-chat: DELETE missing → 404" \
    || fail "file-chat: DELETE missing → 404 (got HTTP $code)"
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
  test_non_owner_sees_session_with_owner_tag
  test_files_api
  test_file_chat_api
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
