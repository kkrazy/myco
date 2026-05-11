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

# Persistence test runtime state. PERSIST_TOKEN/PERSIST_NEW_TOKEN are
# OAuth-derived myco session tokens minted via the /auth/github/* test bypass.
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

# Some checks need a host-side node binary (`node -e "require(...)"`). The
# Docker-based persistence section never needs this — the image bakes node
# in. Hosts without node can still run static + docker tests; we surface
# that those node-dependent slots were skipped instead of marking failed.
SKIP=0
skip()    { SKIP=$((SKIP+1)); echo "  ~ $1 (skipped)"; }
have_node() { command -v node >/dev/null 2>&1; }

# Drive one OAuth round-trip via the /auth/github/* test bypass and echo the
# minted myco session token. Args: <port> <login>. Echoes the token on stdout
# (empty on failure).
mint_session_via_oauth() {
  local port="$1" login="$2"
  # /start returns 302 to github.com/...&state=<nonce>; pull the nonce.
  local state
  state=$(curl -sI "http://127.0.0.1:$port/auth/github/start" 2>/dev/null \
          | tr -d '\r' | grep -i '^location:' \
          | grep -oE 'state=[A-Fa-f0-9]+' | head -1 | sed 's/^state=//')
  [ -n "$state" ] || { echo ""; return 1; }
  # Callback returns a tiny HTML bridge with the token in a localStorage call.
  local body
  body=$(curl -s "http://127.0.0.1:$port/auth/github/callback?code=$login&state=$state" 2>/dev/null)
  echo "$body" | grep -oE "myco_token', \"[A-Fa-f0-9]+\"" | head -1 \
      | sed -E "s/.*\"([A-Fa-f0-9]+)\".*/\1/"
}

# ─── static checks ───────────────────────────────────────────────────────────

test_server_js_files() {
  local missing=""
  for f in src/index.js src/pty.js src/sessions.js src/transcript.js src/auth.js src/btw.js src/oauth.js; do
    [ -r "server/$f" ] || missing="$missing $f"
  done
  [ -z "$missing" ] && pass "Server JS files readable" || fail "Server JS files (missing:$missing)"
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
  if ! have_node; then skip "npm deps (no host node)"; return; fi
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
  # Regression: the @myco prompt MUST end with bare \r so Claude Code's input
  # editor actually submits. We briefly sent '\n\r' to leave a trailing blank
  # line, but the \n landed in the editor without firing submit on many runs.
  grep -qF "input + '\\r'" server/src/pty.js \
    && pass "@myco submits with bare \\r (no leading \\n)" \
    || fail "@myco submits with bare \\r (no leading \\n)"
  grep -qF "input + '\\n\\r'" server/src/pty.js \
    && fail "@myco still uses '\\n\\r' (regression — should be bare \\r)" \
    || pass "@myco no longer uses '\\n\\r'"
  # Regression: the @myco capture regex must use [\s\S] so multi-line chat
  # messages (now reachable via the discussion textarea + Ctrl/⌘+Enter)
  # don't get truncated to the first line by the `.` shorthand.
  grep -qF '@myco\s+([\s\S]+)' server/src/pty.js \
    && pass "@myco regex captures multi-line input" \
    || fail "@myco regex captures multi-line input"
  # Plain chat (no @myco prefix, no /btw) must NOT trigger the assistant.
  # Regression guard: the old shouldAskAssistant treated any '?'-ending
  # message as an assistant trigger, making every question look like claude
  # was replying even without a /btw prefix.
  if ! have_node; then skip "shouldAskAssistant runtime (no host node)"; return; fi
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

  # Frontend JS — file editing now happens through the inline action-bar
  # comment editor, so saveFile/enterEditMode are no longer separate functions.
  grep -q 'function loadFileTree'    web/public/app.js && pass "js: loadFileTree"    || fail "js: loadFileTree"
  grep -q 'function openFileInViewer' web/public/app.js && pass "js: openFileInViewer" || fail "js: openFileInViewer"
  grep -q 'expectedMtimeMs'          web/public/app.js && pass "js: mtime guard sent"|| fail "js: mtime guard sent"
  # Regression: mobile hides files-tree-pane when opening a file. Re-showing
  # the explorer must reset both inner panes so we don't land on a wrap
  # where every child is hidden (empty screen).
  grep -Pzoq "(?s)showFilesView[^}]+files-tree-pane.*hidden.*=.*false" web/public/app.js \
    && pass "js: showFilesView resets files-tree-pane visibility" \
    || fail "js: showFilesView resets files-tree-pane visibility"
}

# Replaces the old test_deploy_add_token. The MYCO_TOKENS bearer-token system
# is gone; deploy.sh now manages the GitHub OAuth allowlist via
# --allow-github-user and OAuth client credentials via --set-oauth.
test_deploy_oauth_flags() {
  grep -q '^allow_github_user()'   deploy.sh && pass "deploy.sh: allow_github_user()"          || fail "deploy.sh: allow_github_user()"
  grep -q '^set_oauth_in_env()'    deploy.sh && pass "deploy.sh: set_oauth_in_env()"           || fail "deploy.sh: set_oauth_in_env()"
  grep -q '^ensure_allowlist_seed()' deploy.sh && pass "deploy.sh: ensure_allowlist_seed()"   || fail "deploy.sh: ensure_allowlist_seed()"
  grep -q '^warn_if_oauth_unset()' deploy.sh && pass "deploy.sh: warn_if_oauth_unset()"        || fail "deploy.sh: warn_if_oauth_unset()"
  grep -q -- '--allow-github-user)' deploy.sh && pass "deploy.sh: --allow-github-user parsed"  || fail "deploy.sh: --allow-github-user parsed"
  grep -q -- '--set-oauth)'         deploy.sh && pass "deploy.sh: --set-oauth parsed"          || fail "deploy.sh: --set-oauth parsed"
  # Regression: the token-based flags must NOT come back without an explicit
  # design decision — we removed --add-token entirely.
  ! grep -qE -- '--add-token' deploy.sh && pass "deploy.sh: --add-token removed"               || fail "deploy.sh: --add-token still referenced"
  ! grep -q 'MYCO_TOKENS' deploy.sh     && pass "deploy.sh: MYCO_TOKENS removed"               || fail "deploy.sh: MYCO_TOKENS still referenced"
}

test_oauth_static() {
  # Server-side OAuth wiring.
  grep -q "require('./oauth')"             server/src/index.js && pass "index.js: requires oauth"            || fail "index.js: requires oauth"
  grep -q "app.get.*'/auth/github/start'"  server/src/index.js && pass "route: /auth/github/start"           || fail "route: /auth/github/start"
  grep -q "app.get.*'/auth/github/callback'" server/src/index.js && pass "route: /auth/github/callback"      || fail "route: /auth/github/callback"
  grep -q "app.post.*'/auth/logout'"       server/src/index.js && pass "route: /auth/logout"                 || fail "route: /auth/logout"
  grep -q 'function startUrl'              server/src/oauth.js && pass "oauth.js: startUrl"                  || fail "oauth.js: startUrl"
  grep -q 'function exchangeCode'          server/src/oauth.js && pass "oauth.js: exchangeCode"              || fail "oauth.js: exchangeCode"
  grep -q 'function fetchUser'             server/src/oauth.js && pass "oauth.js: fetchUser"                 || fail "oauth.js: fetchUser"
  grep -q 'MYCO_TEST_OAUTH_BYPASS'         server/src/oauth.js && pass "oauth.js: test bypass"               || fail "oauth.js: test bypass"
  grep -q 'function mintSession'           server/src/auth.js  && pass "auth.js: mintSession"                || fail "auth.js: mintSession"
  grep -q 'function revokeSession'         server/src/auth.js  && pass "auth.js: revokeSession"              || fail "auth.js: revokeSession"
  grep -q 'function loadAllowlist'         server/src/auth.js  && pass "auth.js: loadAllowlist"              || fail "auth.js: loadAllowlist"
  grep -q 'function isAllowed'             server/src/auth.js  && pass "auth.js: isAllowed"                  || fail "auth.js: isAllowed"
  # The bearer-token auth model is gone.
  ! grep -qE 'MYCO_TOKEN[S]?\b' server/src/auth.js  && pass "auth.js: MYCO_TOKEN(S) removed"               || fail "auth.js: MYCO_TOKEN(S) still referenced"
  ! grep -qE "'/auth/reload'|'/github/token'" server/src/index.js && pass "index.js: /auth/reload + /github/token routes removed" || fail "index.js: stale auth routes still present"
  # Allowlist is the gate.
  grep -q 'allowed-github-users.txt' server/src/auth.js && pass "auth.js: references allowlist file" || fail "auth.js: allowlist file"
}

test_login_modal_static() {
  # Login modal exposes BOTH paths: GitHub OAuth button + PAT paste input.
  grep -q 'id="login-github"'      web/public/index.html && pass "html: #login-github (OAuth button)" || fail "html: #login-github (OAuth button)"
  grep -q 'id="login-pat"'         web/public/index.html && pass "html: #login-pat (PAT input)"       || fail "html: #login-pat (PAT input)"
  grep -q 'id="login-pat-submit"'  web/public/index.html && pass "html: #login-pat-submit"            || fail "html: #login-pat-submit"
  grep -q 'id="login-pat-form"'    web/public/index.html && pass "html: #login-pat-form (real form)"  || fail "html: #login-pat-form (real form)"
  ! grep -q 'id="login-token"'     web/public/index.html && pass "html: #login-token removed"          || fail "html: #login-token still in HTML"
  ! grep -q 'id="github-modal"'    web/public/index.html && pass "html: #github-modal removed"        || fail "html: #github-modal still in HTML"
  # JS doesn't reference the dropped widgets.
  ! grep -q 'bindGithubModal' web/public/app.js && pass "js: bindGithubModal call removed"          || fail "js: bindGithubModal still referenced"
  ! grep -q "getElementById('login-token')" web/public/app.js && pass "js: login-token usage removed" || fail "js: login-token still used"
  ! grep -q "getElementById('login-ok')"    web/public/app.js && pass "js: login-ok usage removed"    || fail "js: login-ok still used"
  # Bootstrap handles the OAuth callback bridge token; PAT submit posts to /auth/login.
  grep -q "mycoSession"            web/public/app.js && pass "js: bootstrap honors ?mycoSession="              || fail "js: bootstrap honors ?mycoSession="
  grep -q "function bindChatAutocomplete" web/public/app.js && pass "js: bindChatAutocomplete defined" || fail "js: bindChatAutocomplete defined"
  grep -q "function doLogout"      web/public/app.js && pass "js: doLogout defined"                    || fail "js: doLogout defined"
  grep -q "function doPatLogin"    web/public/app.js && pass "js: doPatLogin defined"                  || fail "js: doPatLogin defined"
  grep -q "/auth/login"            web/public/app.js && pass "js: posts to /auth/login"                || fail "js: posts to /auth/login"
  grep -q "app.post.*'/auth/login'" server/src/index.js && pass "route: POST /auth/login"              || fail "route: POST /auth/login"
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
  test_deploy_oauth_flags
  test_oauth_static
  test_login_modal_static
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
  # Read-only viewers stay on the structured-transcript pane (clean record of
  # user/assistant/tool messages) and ALSO see a docked live terminal-tail
  # panel that surfaces Claude's interactive prompts (which never make it
  # into the JSONL). Owner login flows in via the viewer-mode message.
  grep -q "t: 'viewer-mode'"      server/src/pty.js     && pass "server emits viewer-mode"          || fail "server emits viewer-mode"
  grep -q "owner: ownerLogin"     server/src/pty.js     && pass "viewer-mode carries owner login"   || fail "viewer-mode carries owner login"
  # Server-side headless xterm is still kept for auto-mode detection in
  # handleChatPostfixes — but we no longer ship per-snapshot WS frames or
  # render a "live terminal" panel in the viewer pane.
  grep -q "@xterm/headless"       server/src/pty.js     && pass "pty.js uses headless xterm"        || fail "pty.js uses headless xterm"
  grep -q "getVisibleText"        server/src/pty.js     && pass "PtySession.getVisibleText defined" || fail "PtySession.getVisibleText defined"
  ! grep -q "t: 'terminal-snapshot'" server/src/pty.js  && pass "terminal-snapshot WS frame removed" || fail "terminal-snapshot WS frame still emitted"
  grep -q "id=\"readonly-banner\"" web/public/index.html && pass "html: #readonly-banner"           || fail "html: #readonly-banner"
  ! grep -q "id=\"terminal-tail\"" web/public/index.html && pass "html: #terminal-tail removed"     || fail "html: #terminal-tail still present"
  grep -q "function applyReadOnly"        web/public/app.js && pass "applyReadOnly() defined"        || fail "applyReadOnly() defined"
  ! grep -q "applyTerminalSnapshot"       web/public/app.js && pass "applyTerminalSnapshot removed"  || fail "applyTerminalSnapshot still referenced"
  # Special-key shortcuts let viewers answer y/n/Enter/Esc prompts without
  # ever typing into the (rejected) terminal directly.
  grep -qE "SPECIAL_KEYS|'enter':|enter:" server/src/pty.js && pass "special key tokens recognized" || fail "special key tokens recognized"
  # Auto-mode: chat-injected @myco messages should land Claude Code in
  # auto-accept-edits mode so file edits / tool calls don't pause for
  # permission. The toggle is detected from the headless terminal tail.
  grep -q 'function autoAcceptToggleBytes' server/src/pty.js && pass "autoAcceptToggleBytes() defined" || fail "autoAcceptToggleBytes() defined"
  grep -q 'function detectClaudeMode'      server/src/pty.js && pass "detectClaudeMode() defined"      || fail "detectClaudeMode() defined"
  grep -q 'shift-tab'                      server/src/pty.js && pass "shift-tab special key registered" || fail "shift-tab special key registered"
  # Shift+Tab byte sequence (\x1b[Z) is the toggle Claude Code listens for.
  grep -qF 'SHIFT_TAB'                     server/src/pty.js && pass "shift-tab byte sequence wired"    || fail "shift-tab byte sequence wired"
}

test_chat_window() {
  grep -q 'id="chatpane"' web/public/index.html && pass "#chatpane element" || fail "#chatpane element"
  # Regression: chat history must allow text selection so users can copy
  # messages. iOS needs ALL THREE of user-select:text, touch-callout:default,
  # touch-action:auto for the long-press → Copy callout to fire. Without
  # touch-callout the body's selection-disabled value propagates down.
  grep -Pzoq '#chat-messages[^{]*\{[^}]*user-select:\s*text\s*!important' web/public/styles.css \
    && pass "#chat-messages re-enables user-select with !important" \
    || fail "#chat-messages re-enables user-select with !important"
  grep -Pzoq '#chat-messages[^{]*\{[^}]*touch-callout:\s*default' web/public/styles.css \
    && pass "#chat-messages re-enables iOS touch-callout" \
    || fail "#chat-messages re-enables iOS touch-callout"
  grep -Pzoq '#chat-messages[^{]*\{[^}]*touch-action:\s*auto' web/public/styles.css \
    && pass "#chat-messages re-enables touch-action" \
    || fail "#chat-messages re-enables touch-action"
  grep -q 'id="chat-input"' web/public/index.html && pass "#chat-input element" || fail "#chat-input element"
  grep -q 'id="chat-send"' web/public/index.html && pass "#chat-send element" || fail "#chat-send element"
  grep -q 'id="chat-form"' web/public/index.html && pass "#chat-form element" || fail "#chat-form element"
  # Regression: the chat input must be a <textarea> so plain Enter inserts a
  # newline (instead of submitting). Ctrl/⌘+Enter is the send shortcut, wired
  # in bindChatUi(). Reverting either half breaks the multi-line UX.
  grep -Pq '<textarea[^>]*id="chat-input"' web/public/index.html \
    && pass "chat-input is a multi-line textarea" \
    || fail "chat-input is a multi-line textarea"
  grep -Pzoq "key === 'Enter'[^}]*ctrlKey[^}]*metaKey" web/public/app.js \
    && pass "Ctrl/Cmd+Enter sends chat message" \
    || fail "Ctrl/Cmd+Enter sends chat message"
  grep -q 'function sendChatMessage' web/public/app.js && pass "sendChatMessage() defined" || fail "sendChatMessage() defined"
  # Regression: chat sends issued while the WS is reconnecting must NOT be
  # silently dropped — they should land in an outbound queue and drain on
  # the next 'open' event. Mobile background-suspend is the common trigger.
  grep -q 'outboundChat'        web/public/app.js && pass "chat outbound queue" || fail "chat outbound queue"
  grep -q '_flushOutboundChat'  web/public/app.js && pass "flushOutboundChat helper" || fail "flushOutboundChat helper"
  grep -q 'this Claude session has exited' server/src/pty.js \
    && pass "server warns when @myco hits dead PTY" \
    || fail "server warns when @myco hits dead PTY"
  grep -q "t: 'chat'" server/src/pty.js && pass "chat WS frame format" || fail "chat WS frame"
  grep -q "t: 'chat-history'" server/src/pty.js && pass "chat-history replay" || fail "chat-history replay"
  grep -q "msg.t === 'chat-history'" web/public/app.js && pass "chat-history client handler" || fail "chat-history client handler"
  grep -q 'chatpane-close' web/public/app.js && pass "chatpane close binding" || fail "chatpane close binding"
  # Chatpane tabs: Discussion / Plan / Arch / Test
  for tab in discussion plan arch test; do
    grep -q "data-tab=\"$tab\"" web/public/index.html \
      && pass "chatpane tab #$tab"                              \
      || fail "chatpane tab #$tab"
  done
  grep -q 'id="chatpane-tabs"' web/public/index.html && pass "#chatpane-tabs container" || fail "#chatpane-tabs container"
  grep -q 'function setChatpaneTab'  web/public/app.js && pass "setChatpaneTab()"  || fail "setChatpaneTab()"
  grep -q 'function refreshArtifact' web/public/app.js && pass "refreshArtifact()" || fail "refreshArtifact()"
  grep -q "artifact/refresh"  server/src/index.js && pass "POST /artifact/refresh route" || fail "POST /artifact/refresh route"
  grep -q "artifact/run"      server/src/index.js && pass "POST /artifact/run route"     || fail "POST /artifact/run route"
  grep -q "artifact/mark"     server/src/index.js && pass "POST /artifact/mark route"    || fail "POST /artifact/mark route"
  # Phase B: extractor module + claude-CLI client are wired in.
  test -f server/src/anthropic.js && pass "anthropic.js exists" || fail "anthropic.js missing"
  test -f server/src/extractor.js && pass "extractor.js exists" || fail "extractor.js missing"
  test -f server/src/claude-cli.js && pass "claude-cli.js exists" || fail "claude-cli.js missing"
  grep -q "extractArtifact" server/src/index.js && pass "extractArtifact wired into index.js" || fail "extractArtifact wired"
  # Regression: extraction goes through the `claude` CLI (same auth as the
  # running PTY session), NOT a raw Anthropic API call.
  grep -q "callClaudeCli" server/src/extractor.js && pass "extractor uses claude-cli" || fail "extractor uses claude-cli"
  grep -q "callAnthropic" server/src/extractor.js && fail "extractor still imports callAnthropic (regression)" || pass "extractor no longer imports callAnthropic"
  # Regression: extractor pulls from BOTH the JSONL transcript AND the
  # discussion-panel chat (rec.chat) so non-@myco messages still feed Plan.
  grep -q "getChatHistory" server/src/extractor.js && pass "extractor reads chat history" || fail "extractor reads chat history"
  grep -q "readChatTail"   server/src/extractor.js && pass "extractor has readChatTail helper" || fail "extractor has readChatTail helper"
  # Regression: any non-@myco, non-slash chat must trigger the auto-accept-
  # edits toggle so the next @myco / Plan checkbox runs without a prompt.
  grep -q 'auto-toggle on discussion' server/src/pty.js \
    && pass "pty toggles auto-mode on plain discussion" \
    || fail "pty toggles auto-mode on plain discussion"
  grep -q "handleChatMessage" server/src/pty.js && pass "handleChatMessage in pty.js" || fail "handleChatMessage in pty.js"
  grep -q "handleChatMessage" server/src/index.js && pass "handleChatMessage imported by /run route" || fail "handleChatMessage imported"
  # Regression: parseStringArray must tolerate code fences + non-JSON.
  if have_node; then
    node -e "
      const ex = require('./server/src/extractor');
      const t = (got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { console.error('mismatch', JSON.stringify(got), 'vs', JSON.stringify(want)); process.exit(1); } };
      t(ex.parseStringArray('[\"a\"]'), ['a']);
      t(ex.parseStringArray('\`\`\`json\n[\"b\"]\n\`\`\`'), ['b']);
      t(ex.parseStringArray('not json'), []);
      t(ex.parseStringArray('[\"  \", \"real\"]'), ['real']);
    " && pass "extractor.parseStringArray tolerates fences + bad input" \
      || fail "extractor.parseStringArray tolerates fences + bad input"
  else
    skip "parseStringArray (no host node)"
  fi
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
  if ! have_node; then
    skip "Server smoke (no host node — Docker persistence section still covers runtime behaviour)"
    return
  fi
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
  PERSIST_SID="myco-persist-test-$(date +%s%N | tail -c 8)"
  PERSIST_PORT=$(free_port)
  PERSIST_NAME="myco-persist-$$"

  # .env: GitHub OAuth + the test bypass that lets us mint sessions without
  # ever talking to github.com.
  cat > "$PERSIST_DIR/.env" <<EOF
MYCO_GH_CLIENT_ID=test-client-id
MYCO_GH_CLIENT_SECRET=test-client-secret
MYCO_PUBLIC_ORIGIN=http://localhost
MYCO_TEST_OAUTH_BYPASS=alice
EOF

  # Allowlist: alice and bob are invited. eve stays out.
  cat > "$PERSIST_DIR/allowed-github-users.txt" <<EOF
# test allowlist
alice
bob
EOF

  # sessions.json: pre-seeded session that should appear post-restart.
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

# Wait for the server to come up. Uses /auth/check, which is unauthenticated
# and always returns 200 — so we don't need a token before the OAuth round-trip.
wait_persist_ready() {
  local label="$1"
  local ready=0 i
  for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:$PERSIST_PORT/auth/check" -o /dev/null 2>/dev/null; then
      ready=1; break
    fi
    sleep 0.5
  done
  [ "$ready" = "1" ] && pass "$label" || fail "$label"
}

test_persist_initial() {
  start_persist_container && pass "container started" || fail "container started"
  wait_persist_ready "container ready"

  # Mint a session for alice and bob via the OAuth test bypass.
  PERSIST_TOKEN=$(mint_session_via_oauth "$PERSIST_PORT" alice)
  [ -n "$PERSIST_TOKEN" ] && pass "OAuth: minted session for alice" \
    || fail "OAuth: minted session for alice"

  PERSIST_NEW_TOKEN=$(mint_session_via_oauth "$PERSIST_PORT" bob)
  [ -n "$PERSIST_NEW_TOKEN" ] && pass "OAuth: minted session for bob" \
    || fail "OAuth: minted session for bob"

  local resp sessions
  resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/auth/check" -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  echo "$resp" | grep -q '"ok":true' && pass "auth: alice session token works" \
    || fail "auth: alice session token works (got: $resp)"
  echo "$resp" | grep -q '"user":"alice"' && pass "auth: /auth/check returns login" \
    || fail "auth: /auth/check returns login (got: $resp)"

  sessions=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions?all=1" -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  echo "$sessions" | grep -q "$PERSIST_SID" && pass "seeded session visible" || fail "seeded session visible"

  docker exec "$PERSIST_NAME" test -f /root/.claude.json && pass ".claude.json migrated to /root" || fail ".claude.json migrated"
  docker exec "$PERSIST_NAME" test -d /root/.claude && pass ".claude/ migrated to /root" || fail ".claude/ migrated"
  docker exec "$PERSIST_NAME" grep -q 'persistMarker' /root/.claude.json && pass ".claude.json contents preserved" || fail ".claude.json contents"
}

test_allowlist_gate() {
  # eve is NOT on the allowlist — the OAuth callback should bounce her with
  # a 403 "not invited" page and refuse to mint a session.
  local state code
  state=$(curl -sI "http://127.0.0.1:$PERSIST_PORT/auth/github/start" 2>/dev/null \
          | tr -d '\r' | grep -i '^location:' \
          | grep -oE 'state=[A-Fa-f0-9]+' | head -1 | sed 's/^state=//')
  [ -n "$state" ] && pass "OAuth /start returns a state nonce" || fail "OAuth /start returns a state nonce"

  code=$(curl -s -o /tmp/myco-eve-body -w '%{http_code}' \
    "http://127.0.0.1:$PERSIST_PORT/auth/github/callback?code=eve&state=$state" 2>/dev/null)
  [ "$code" = "403" ] && pass "OAuth callback for non-allowlisted login → 403" \
    || fail "OAuth callback for non-allowlisted login → 403 (got HTTP $code)"
  grep -qiE 'not invited|--allow-github-user' /tmp/myco-eve-body \
    && pass "403 page mentions allowlist" \
    || fail "403 page mentions allowlist"
  rm -f /tmp/myco-eve-body
}

test_oauth_state_validation() {
  # A callback with an unknown state nonce must be rejected, even for a
  # login that's on the allowlist. Otherwise the server would mint sessions
  # for any caller that knew a username.
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$PERSIST_PORT/auth/github/callback?code=alice&state=bogusnonce" 2>/dev/null)
  [ "$code" = "400" ] && pass "OAuth callback with bad state → 400" \
    || fail "OAuth callback with bad state → 400 (got HTTP $code)"
}

test_persist_after_restart() {
  docker restart "$PERSIST_NAME" >/dev/null 2>&1
  wait_persist_ready "container ready after restart"

  local resp sessions
  resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/auth/check" -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  echo "$resp" | grep -q '"ok":true' && pass "auth survives restart (auth-sessions.json reloaded)" \
    || fail "auth survives restart (got: $resp)"

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

test_pat_login_flow() {
  # Positive: posting a PAT for an allowlisted login mints a session, just
  # like the OAuth callback path. Test bypass parses `test-token-<login>`.
  local body code
  body=$(curl -s -X POST "http://127.0.0.1:$PERSIST_PORT/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"token":"test-token-alice"}' 2>/dev/null)
  echo "$body" | grep -q '"ok":true' && pass "PAT login: alice (allowlisted) → ok" \
    || fail "PAT login: alice (allowlisted) → ok (got: $body)"
  echo "$body" | grep -qE '"token":"[A-Fa-f0-9]+"' && pass "PAT login: returns minted myco session" \
    || fail "PAT login: returns minted myco session (got: $body)"
  echo "$body" | grep -q '"login":"alice"' && pass "PAT login: returns user.login" \
    || fail "PAT login: returns user.login (got: $body)"

  # The minted token actually authenticates subsequent requests.
  local pat_tok
  pat_tok=$(echo "$body" | grep -oE '"token":"[A-Fa-f0-9]+"' | head -1 | sed -E 's/.*"([A-Fa-f0-9]+)".*/\1/')
  if [ -n "$pat_tok" ]; then
    body=$(curl -s "http://127.0.0.1:$PERSIST_PORT/auth/check" -H "Authorization: Bearer $pat_tok" 2>/dev/null)
    echo "$body" | grep -q '"ok":true' && pass "PAT login: minted token authenticates" \
      || fail "PAT login: minted token authenticates (got: $body)"
  fi

  # Negative: PAT for a non-allowlisted login → 403 with hint.
  code=$(curl -s -o /tmp/myco-pat-eve -w '%{http_code}' -X POST \
    "http://127.0.0.1:$PERSIST_PORT/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"token":"test-token-eve"}' 2>/dev/null)
  [ "$code" = "403" ] && pass "PAT login: non-allowlisted → 403" \
    || fail "PAT login: non-allowlisted → 403 (got HTTP $code)"
  grep -qiE 'not invited|allow-github-user' /tmp/myco-pat-eve \
    && pass "PAT login: 403 body explains the gate" \
    || fail "PAT login: 403 body explains the gate"
  rm -f /tmp/myco-pat-eve

  # Empty body → 400.
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "http://127.0.0.1:$PERSIST_PORT/auth/login" \
    -H "Content-Type: application/json" -d '{}' 2>/dev/null)
  [ "$code" = "400" ] && pass "PAT login: missing token → 400" \
    || fail "PAT login: missing token → 400 (got HTTP $code)"
}

test_logout() {
  # Mint a throw-away session, log out, confirm it's now rejected.
  local tok code
  tok=$(mint_session_via_oauth "$PERSIST_PORT" alice)
  [ -n "$tok" ] || { fail "logout: minted session for logout test"; return; }
  pass "logout: minted throw-away session"

  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "http://127.0.0.1:$PERSIST_PORT/auth/logout" \
    -H "Authorization: Bearer $tok" 2>/dev/null)
  [ "$code" = "200" ] && pass "POST /auth/logout → 200" \
    || fail "POST /auth/logout → 200 (got HTTP $code)"

  local resp
  resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/auth/check" -H "Authorization: Bearer $tok" 2>/dev/null)
  echo "$resp" | grep -q '"ok":false' && pass "logged-out token no longer authenticates" \
    || fail "logged-out token no longer authenticates (got: $resp)"
}

test_non_owner_sees_session_with_owner_tag() {
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

  # ── 7. Bob (non-owner) — viewer access: GETs OK (200), writes 200 (collaborator).
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/files?path=." \
    -H "Authorization: Bearer $PERSIST_NEW_TOKEN" 2>/dev/null)
  [ "$code" = "200" ] && pass "files: non-owner GET list → 200 (viewer)" \
    || fail "files: non-owner GET list → 200 (got HTTP $code)"
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file?path=hello.txt" \
    -H "Authorization: Bearer $PERSIST_NEW_TOKEN" 2>/dev/null)
  [ "$code" = "200" ] && pass "files: non-owner GET file → 200 (viewer)" \
    || fail "files: non-owner GET file → 200 (got HTTP $code)"
  # Bob's PUT needs the current mtime — fetch it, then write a real edit.
  local bob_resp bob_mtime
  bob_resp=$(curl -s "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file?path=hello.txt" \
    -H "Authorization: Bearer $PERSIST_NEW_TOKEN" 2>/dev/null)
  bob_mtime=$(echo "$bob_resp" | grep -oE '"mtimeMs":[0-9.]+' | head -1 | sed 's/.*://')
  code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file" \
    -H "Authorization: Bearer $PERSIST_NEW_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"path\":\"hello.txt\",\"content\":\"bob-was-here\\n\",\"expectedMtimeMs\":$bob_mtime}" 2>/dev/null)
  [ "$code" = "200" ] && pass "files: non-owner PUT → 200 (collaborator can edit)" \
    || fail "files: non-owner PUT → 200 (got HTTP $code)"

  # ── 8. Share-token client — viewer access: GET file OK (200); writes denied.
  local share_url share_tok
  share_url=$(curl -s -X POST \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/share" \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  share_tok=$(echo "$share_url" | grep -oE '\?s=[^"]+' | head -1 | sed 's/^?s=//')
  if [ -n "$share_tok" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file?path=hello.txt&s=$share_tok" 2>/dev/null)
    [ "$code" = "200" ] && pass "files: share-token GET file → 200 (viewer)" \
      || fail "files: share-token GET file → 200 (got HTTP $code)"
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

  # ── 7. Bob (non-owner) — viewer access: GET OK (200), POST 200 (collaborator).
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file-chat?path=hello.txt" \
    -H "Authorization: Bearer $PERSIST_NEW_TOKEN" 2>/dev/null)
  [ "$code" = "200" ] && pass "file-chat: non-owner GET → 200 (viewer)" \
    || fail "file-chat: non-owner GET → 200 (got HTTP $code)"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 90 -X POST \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file-chat" \
    -H "Authorization: Bearer $PERSIST_NEW_TOKEN" -H "Content-Type: application/json" \
    -d '{"path":"hello.txt","question":"viewer asking"}' 2>/dev/null)
  [ "$code" = "200" ] && pass "file-chat: non-owner POST → 200 (collaborator can ask Claude)" \
    || fail "file-chat: non-owner POST → 200 (got HTTP $code)"

  # ── 8. Share-token client — viewer access: GET OK (200); writes denied (401).
  local share_url share_tok
  share_url=$(curl -s -X POST \
    "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/share" \
    -H "Authorization: Bearer $PERSIST_TOKEN" 2>/dev/null)
  share_tok=$(echo "$share_url" | grep -oE '\?s=[^"]+' | head -1 | sed 's/^?s=//')
  if [ -n "$share_tok" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:$PERSIST_PORT/sessions/$PERSIST_SID/file-chat?path=hello.txt&s=$share_tok" 2>/dev/null)
    [ "$code" = "200" ] && pass "file-chat: share-token GET → 200 (viewer)" \
      || fail "file-chat: share-token GET → 200 (got HTTP $code)"
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
  test_allowlist_gate
  test_oauth_state_validation
  test_persist_after_restart
  test_persist_after_redeploy
  test_pat_login_flow
  test_logout
  test_non_owner_sees_session_with_owner_tag
  test_files_api
  test_file_chat_api
  cleanup_persist_env
}

# ─── summary ─────────────────────────────────────────────────────────────────

print_summary() {
  echo ""
  echo "─────────────────────────"
  echo "  Passed:  $PASS"
  echo "  Failed:  $FAIL"
  [ "$SKIP" -gt 0 ] && echo "  Skipped: $SKIP"
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
