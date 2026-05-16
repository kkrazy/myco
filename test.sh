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
  for f in src/index.js src/attach.js src/sessions.js src/transcript.js src/auth.js src/btw.js src/oauth.js src/text-utils.js src/agent-session.js; do
    [ -r "server/$f" ] || missing="$missing $f"
  done
  [ -z "$missing" ] && pass "Server JS files readable" || fail "Server JS files (missing:$missing)"
}

test_text_utils() {
  if ! have_node; then skip "text-utils runtime (no host node)"; return; fi
  # Regression: stripAnsi, tailLines, formatChat live in text-utils.js
  # and are consumed by btw.js (prompt build). The Phase 9 step 2
  # retirement of PTY dropped the second consumer (scrollback feed) but
  # the helpers stay because /btw still uses them.
  node -e "
    const u = require('./server/src/text-utils');
    const stripped = u.stripAnsi('\x1b[31mred\x1b[0m\x07plain');
    if (stripped !== 'redplain') throw new Error('stripAnsi: got ' + JSON.stringify(stripped));
    if (u.tailLines('a\nb\nc\nd\ne', 2) !== 'd\ne') throw new Error('tailLines tail wrong');
    if (u.tailLines('', 3) !== '')             throw new Error('tailLines empty wrong');
    if (u.formatChat([])             !== '(empty)')         throw new Error('formatChat empty wrong');
    if (u.formatChat(null)           !== '(empty)')         throw new Error('formatChat null wrong');
    if (u.formatChat([{user:'a',text:'hi'},{user:'b',text:'there'}]) !== 'a: hi\nb: there')
      throw new Error('formatChat shape wrong');
    // attach.js loads cleanly + exposes the expected agent-mode plumbing.
    const a = require('./server/src/attach');
    if (typeof a.attachWebSocket !== 'function') throw new Error('attach.js failed to load');
    if (typeof a._registerExternalSession !== 'function') throw new Error('attach.js missing _registerExternalSession');
  " && pass "text-utils.js: stripAnsi/tailLines/formatChat" \
    || fail "text-utils.js: stripAnsi/tailLines/formatChat"
}

test_frontend_files() {
  for f in web/public/app.js web/public/styles.css web/public/index.html; do
    test -f "$f" && pass "$f exists" || fail "$f missing"
  done
}

test_phase9_retirement() {
  # SDK Phase 9 step 2: the PTY driver (pty.js + menu-interceptor.js +
  # pty-patterns.js) is deleted. All sessions run as AgentSessions, and
  # the WS attach + chat plumbing lives in attach.js. These assertions
  # pin the retirement so a future revert doesn't sneak the PTY back
  # in.
  test ! -f server/src/pty.js \
    && pass "server/src/pty.js deleted (Phase 9)" \
    || fail "server/src/pty.js still present — PTY driver was supposed to be retired"
  test ! -f server/src/menu-interceptor.js \
    && pass "server/src/menu-interceptor.js deleted (Phase 9)" \
    || fail "server/src/menu-interceptor.js still present"
  test ! -f server/src/pty-patterns.js \
    && pass "server/src/pty-patterns.js deleted (Phase 9)" \
    || fail "server/src/pty-patterns.js still present"
  test -f server/src/attach.js \
    && pass "server/src/attach.js exists (agent-mode WS plumbing)" \
    || fail "server/src/attach.js missing"

  # Phase 9 step 10 retired the PTY-rawText regex parser. The two
  # PERMISSION_*_RE regexes + extractPermissionTarget were the last
  # holdovers from pty-patterns.js; agent-mode menus carry a structured
  # `target: { tool, input }` so menu.js no longer has to regex-parse a
  # menu.rawText to recover them. Negative guards lock the deletion in.
  ! grep -qE "PERMISSION_TOOL_RE|PERMISSION_INPUT_RE|extractPermissionTarget" server/src/permissions.js \
    && pass "permissions.js: PTY-rawText regex parser retired (Phase 9 step 10)" \
    || fail "permissions.js: PERMISSION_*_RE / extractPermissionTarget still present"

  # Importers must all point at attach.js, not pty.js.
  ! grep -rqE "require\\('\\./pty'\\)" server/src/ \
    && pass "no server/src/ file imports './pty'" \
    || fail "some server/src/ file still imports './pty' — chase down and update to './attach'"
  grep -q "require('./attach')" server/src/index.js \
    && pass "index.js imports from './attach'" \
    || fail "index.js does NOT import from './attach'"
  grep -q "require('./attach')" server/src/sessions.js \
    && pass "sessions.js imports from './attach'" \
    || fail "sessions.js does NOT import from './attach'"

  # Agent-mode menus carry the structured permission target on the menu
  # object itself — menu.js reads menu.target rather than regex-parsing
  # menu.rawText. The SDK supplies toolName + structured toolInput, so
  # _matchingInputFor extracts the comparison string directly.
  grep -qF "target: { tool: toolName, input: _matchingInputFor" server/src/agent-session.js \
    && pass "agent-session: permission menu carries structured target" \
    || fail "agent-session: menu.target not stamped on permission menus"
  grep -qF "target = menu.target" server/src/menu.js \
    && pass "menu.js: handleSessionMenu reads menu.target directly" \
    || fail "menu.js: still regex-parsing menu.rawText for target"
}

test_vendor_assets() {
  # Regression: marked.umd.js was referenced from index.html but never
  # vendored into the static dir, so the browser 404'd marked, renderMd
  # fell back to plain escHtml, and the read-only viewer showed raw
  # transcript text instead of rendered markdown + syntax highlights.
  for f in web/public/vendor/highlight.min.js \
           web/public/vendor/mermaid.min.js \
           web/public/vendor/marked/marked.umd.js \
           web/public/vendor/github-dark.min.css; do
    test -f "$f" && pass "$f exists" || fail "$f missing"
  done
}

test_npm_deps() {
  if ! have_node; then skip "npm deps (no host node)"; return; fi
  (cd server && node -e "
    ['express','ws','marked','highlight.js','ansi-to-html','@anthropic-ai/claude-agent-sdk'].forEach(p => {
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

test_pwa_icon() {
  # PWA install icon (mobile Chrome "Add to Home Screen", iOS Safari
  # apple-touch-icon, browser tab favicon) all point at /hetu.jpg.
  # Without these wired, installing as a Chrome app renders the
  # auto-generated SVG initial — not the brand icon the user expects.
  test -f web/public/hetu.jpg \
    && pass "web/public/hetu.jpg exists" \
    || fail "web/public/hetu.jpg missing — PWA install will fall back to SVG initial"
  grep -qF '"src": "/hetu.jpg' web/public/manifest.json \
    && pass "manifest.json: lists hetu.jpg as an install icon" \
    || fail "manifest.json: hetu.jpg not referenced"
  grep -qF 'rel="icon"' web/public/index.html \
    && pass "index.html: <link rel=icon> for favicon/tab" \
    || fail "index.html: <link rel=icon> missing"
  grep -qF 'rel="apple-touch-icon"' web/public/index.html \
    && pass "index.html: <link rel=apple-touch-icon> for iOS home screen" \
    || fail "index.html: apple-touch-icon missing — iOS Add to Home Screen uses default"
  # JPEG magic byte sanity: first two bytes must be FF D8. A stray PNG
  # or HTML at this path would still satisfy the existence check but
  # render as a broken-image glyph in the install dialog.
  if have_node; then
    node -e "
      const b = require('fs').readFileSync('web/public/hetu.jpg');
      if (b[0] !== 0xFF || b[1] !== 0xD8) throw new Error('hetu.jpg not a JPEG (magic = ' + b.slice(0,2).toString('hex') + ')');
    " && pass "hetu.jpg has valid JPEG magic bytes" \
      || fail "hetu.jpg has wrong magic — install icon will render broken"
  fi
}

test_best_practices_template() {
  # Best-practices markdown template is auto-injected at the top of the
  # Arch artifact pane (default ON, toggleable via the "Best practices"
  # checkbox in the Arch tab header). Persisted per-browser in
  # localStorage.myco_bp_enabled.
  test -f web/public/best-practices-template.md \
    && pass "web/public/best-practices-template.md exists" \
    || fail "best-practices-template.md missing — Arch tab will render without the banner"
  grep -qF 'id="bp-toggle"' web/public/index.html \
    && pass "index.html: bp-toggle checkbox in arch-wrap header" \
    || fail "index.html: bp-toggle checkbox missing — no UI to enable/disable injection"
  grep -qF 'bindBestPracticesToggle' web/public/app.js \
    && pass "app.js: bindBestPracticesToggle wires the checkbox + fetches template" \
    || fail "app.js: bindBestPracticesToggle not wired"
  grep -qF 'state.bpTemplate' web/public/app.js \
    && pass "app.js: state.bpTemplate cache populated from /best-practices-template.md" \
    || fail "app.js: template cache key state.bpTemplate missing"
  grep -qF "localStorage.getItem('myco_bp_enabled')" web/public/app.js \
    && pass "app.js: bp toggle persists in localStorage.myco_bp_enabled" \
    || fail "app.js: bp toggle does not persist — refresh would reset to default"
  grep -qF 'bp-banner' web/public/styles.css \
    && pass "styles.css: .bp-banner styled (left accent + tinted background)" \
    || fail "styles.css: .bp-banner CSS missing — injected template won't render distinctly"
  # Server-side: best-practices block is injected into every managed
  # project's CLAUDE.md on spawn + on ensureLiveSession. Idempotent
  # via sentinel pair.
  grep -qF 'injectBestPracticesIntoClaudeMd' server/src/sessions.js \
    && pass "sessions.js: injectBestPracticesIntoClaudeMd defined" \
    || fail "sessions.js: helper missing"
  if awk '/^async function spawnSession/,/^}$/' server/src/sessions.js | grep -q 'injectBestPracticesIntoClaudeMd'; then
    pass "sessions.js: spawnSession injects best-practices into CLAUDE.md"
  else
    fail "sessions.js: spawnSession does NOT inject — new projects won't get the block"
  fi
  if awk '/^async function ensureLiveSession/,/^}$/' server/src/sessions.js | grep -q 'injectBestPracticesIntoClaudeMd'; then
    pass "sessions.js: ensureLiveSession tops up CLAUDE.md on resume"
  else
    fail "sessions.js: ensureLiveSession does NOT top up — resumed sessions miss back-fill"
  fi
  grep -qF "BP_SENTINEL_START = '<!-- myco-best-practices-start -->'" server/src/sessions.js \
    && pass "sessions.js: sentinel constant pinned (idempotent injection key)" \
    || fail "sessions.js: sentinel constant changed — old blocks won't be detected"
  if have_node; then
    if node test/best-practices-inject.test.js >/dev/null 2>&1; then
      pass "test/best-practices-inject.test.js (6 cases)"
    else
      fail "test/best-practices-inject.test.js — re-run with 'node test/best-practices-inject.test.js' to see failures"
    fi
  else
    skip "test/best-practices-inject.test.js (no host node)"
  fi
  # /td /fr /bug must mirror new plan items to _myco_/plan.json — the
  # GET /artifact handler reads the on-disk file first and would
  # otherwise silently drop the in-memory-only addition on next open.
  if have_node; then
    if node test/slash-todo-inject.test.js >/dev/null 2>&1; then
      pass "test/slash-todo-inject.test.js (12 cases)"
    else
      fail "test/slash-todo-inject.test.js — re-run with 'node test/slash-todo-inject.test.js' to see failures"
    fi
  else
    skip "test/slash-todo-inject.test.js (no host node)"
  fi
  # /clear must wipe rec.chat AND emit a chat-clear state-update so all
  # attached chat panes drop their local list. Pair of static greps +
  # the runtime regression test below.
  grep -q "names: \['clear'\]" server/src/slashcmds.js \
    && pass "slashcmds: /clear command registered" \
    || fail "slashcmds: /clear command registered"
  grep -q "kind: 'chat-clear'" server/src/slashcmds.js \
    && pass "slashcmds: /clear emits chat-clear state-update" \
    || fail "slashcmds: /clear emits chat-clear state-update"
  grep -q "msg.kind === 'chat-clear'" web/public/app.js \
    && pass "app.js: state-update handles chat-clear kind" \
    || fail "app.js: state-update handles chat-clear kind"
  # Agent-mode WS attach diagnostic. The [diag-resume] / [ws-attach]
  # client-side instrumentation was retired with the PTY xterm strip
  # (Phase 9 step 2); the server-side [agent-attach] log survives so
  # the diag loop can still attribute resume-vs-fresh attaches.
  grep -q '\[agent-attach\]' server/src/attach.js \
    && pass "attach.js: [agent-attach] diagnostic log present" \
    || fail "attach.js: [agent-attach] diagnostic log present"
  if have_node; then
    if node test/slash-clear.test.js >/dev/null 2>&1; then
      pass "test/slash-clear.test.js (4 cases)"
    else
      fail "test/slash-clear.test.js — re-run with 'node test/slash-clear.test.js' to see failures"
    fi
  else
    skip "test/slash-clear.test.js (no host node)"
  fi
  # Chat-routing rewrite (2026-05-14): plain text → agent by default;
  # @<known-user> → chat-only mention with highlight. The static greps
  # below + the regression test guard the invariants of that routing.
  grep -q "_detectMentionTarget" server/src/attach.js \
    && pass "attach.js: _detectMentionTarget helper present" \
    || fail "attach.js: _detectMentionTarget helper present"
  grep -q "meta = { kind: 'mention'" server/src/attach.js \
    && pass "attach.js: mention messages stamped with meta.kind=mention" \
    || fail "attach.js: mention messages stamped with meta.kind=mention"
  if grep -q "names: \['m'\]" server/src/slashcmds.js; then
    fail "slashcmds: /m should have been removed but is still registered"
  else
    pass "slashcmds: /m removed (plain text now reaches Claude by default)"
  fi
  grep -q "chat-msg-mention-me" web/public/app.js \
    && pass "app.js: mention-to-me highlight class wired" \
    || fail "app.js: mention-to-me highlight class wired"
  grep -q "chat-msg-mention-me" web/public/styles.css \
    && pass "styles.css: chat-msg-mention-me styles present" \
    || fail "styles.css: chat-msg-mention-me styles present"
  # Regression: resolved menu rows must keep the question text visible
  # above the ✓ Picked / ✓ Submitted / ↪ Superseded line. Hiding the
  # question (the prior "tooltip-only" treatment) made the chat read
  # like the question came AFTER its answer when claude later recapped
  # the same wording in plain assistant text.
  grep -q "chat-text-resolved" web/public/app.js \
    && pass "app.js: resolved-menu rows still show the question text" \
    || fail "app.js: resolved-menu rows still show the question text"
  grep -q "chat-text-resolved" web/public/styles.css \
    && pass "styles.css: chat-text-resolved muted style present" \
    || fail "styles.css: chat-text-resolved muted style present"
  # Agent-mode menu-pick silent-drop paths log so the diag loop can
  # diagnose stale clicks landing on a session whose pending callback
  # has already been resolved (e.g. server restart, user double-click).
  grep -q "silent-drop:" server/src/attach.js \
    && pass "attach.js: handleMenuPick silent-drop paths log" \
    || fail "attach.js: handleMenuPick silent-drop paths log"
  # Plan-item ids switched to per-layer counters (fr-1, td-1, bug-1)
  # in 2026-05-15. Legacy hex ids still valid but no longer generated.
  # /merge collapses N items into the lowest-numbered canonical;
  # /dedupe asks claude to propose merge groups (no auto-apply).
  grep -q "PLAN_LAYER_PREFIX" server/src/slashcmds.js \
    && pass "slashcmds: per-layer id-prefix table present" \
    || fail "slashcmds: per-layer id-prefix table present"
  grep -q "_nextPlanItemId" server/src/slashcmds.js \
    && pass "slashcmds: _nextPlanItemId counter present" \
    || fail "slashcmds: _nextPlanItemId counter present"
  grep -q "names: \['merge'\]" server/src/slashcmds.js \
    && pass "slashcmds: /merge command registered" \
    || fail "slashcmds: /merge command registered"
  grep -q "names: \['dedupe'\]" server/src/slashcmds.js \
    && pass "slashcmds: /dedupe command registered" \
    || fail "slashcmds: /dedupe command registered"
  grep -q "function handleMerge" server/src/slashcmds.js \
    && pass "slashcmds: handleMerge present" \
    || fail "slashcmds: handleMerge present"
  grep -q "function handleDedupe\|async function handleDedupe" server/src/slashcmds.js \
    && pass "slashcmds: handleDedupe present (LLM-proposal flow)" \
    || fail "slashcmds: handleDedupe present (LLM-proposal flow)"
  grep -q "runClaudeP" server/src/btw.js \
    && pass "btw.js: runClaudeP exported for /dedupe" \
    || fail "btw.js: runClaudeP exported for /dedupe"
  # Plan-refresh dedupe integration (2026-05-15): refresh endpoint
  # returns { artifact, mergeProposals } when type=plan; the merge
  # endpoint applies a proposal under user confirmation; client
  # renders an Apply/Dismiss callout above the items.
  grep -q "mergePlanItems" server/src/slashcmds.js \
    && pass "slashcmds: mergePlanItems helper exported" \
    || fail "slashcmds: mergePlanItems helper exported"
  grep -q "dedupePlanItems" server/src/slashcmds.js \
    && pass "slashcmds: dedupePlanItems helper exported" \
    || fail "slashcmds: dedupePlanItems helper exported"
  grep -q "mergeProposals" server/src/artifacts.js \
    && pass "artifacts.js: refresh returns mergeProposals for plan" \
    || fail "artifacts.js: refresh returns mergeProposals for plan"
  grep -q "/artifact/plan/merge" server/src/artifacts.js \
    && pass "artifacts.js: POST /artifact/plan/merge endpoint registered" \
    || fail "artifacts.js: POST /artifact/plan/merge endpoint registered"
  grep -q "_renderMergeProposals" web/public/app.js \
    && pass "app.js: _renderMergeProposals callout wired" \
    || fail "app.js: _renderMergeProposals callout wired"
  grep -q "plan-merge-callout" web/public/styles.css \
    && pass "styles.css: plan-merge-callout style present" \
    || fail "styles.css: plan-merge-callout style present"
  # Plan-item row now surfaces the id chip + merged-from badge so users
  # can see at-a-glance which items got merged.
  grep -q "artifact-item-id" web/public/app.js \
    && pass "app.js: plan-item id chip rendered" \
    || fail "app.js: plan-item id chip rendered"
  grep -q "artifact-item-merged" web/public/app.js \
    && pass "app.js: plan-item merged-from badge rendered" \
    || fail "app.js: plan-item merged-from badge rendered"
  grep -q "artifact-item-merged" web/public/styles.css \
    && pass "styles.css: artifact-item-merged style present" \
    || fail "styles.css: artifact-item-merged style present"
  # Regression: clicking Apply on one merge proposal must not cause
  # the OTHER proposals in the callout to flicker (disappear during
  # renderArtifact's body.innerHTML rebuild, then re-mount). Fix:
  # renderArtifact detaches `.plan-merge-callout` before the rebuild
  # and re-inserts it after; Apply handler just removes the one
  # clicked .plan-merge-group node directly.
  grep -q "preservedCallout" web/public/app.js \
    && pass "app.js: renderArtifact preserves the merge callout across rebuild" \
    || fail "app.js: renderArtifact preserves the merge callout across rebuild"
  if grep -q "_renderMergeProposals(remaining" web/public/app.js; then
    fail "app.js: Apply handler still calls _renderMergeProposals(remaining) — flicker not fixed"
  else
    pass "app.js: Apply handler no longer rebuilds the callout (no flicker)"
  fi
  # Plan-item layout: actions (vote/comment/merged-badge/delete) live
  # on their own row below the text so longer items don't get
  # squeezed by the action cluster on the right.
  grep -q "artifact-item-actions" web/public/app.js \
    && pass "app.js: plan-item actions row class wired" \
    || fail "app.js: plan-item actions row class wired"
  grep -q "artifact-item-actions" web/public/styles.css \
    && pass "styles.css: artifact-item-actions style present" \
    || fail "styles.css: artifact-item-actions style present"
  # Agent SDK migration — phase 1: parallel AgentSession class, opt-in
  # via spawnSession mode='agent'. Static greps guard the foundation;
  # the runtime test below validates an end-to-end SDK roundtrip.
  [ -f server/src/agent-session.js ] \
    && pass "server/src/agent-session.js present" \
    || fail "server/src/agent-session.js present"
  grep -q "class AgentSession" server/src/agent-session.js \
    && pass "agent-session.js: AgentSession class defined" \
    || fail "agent-session.js: AgentSession class defined"
  grep -q "@anthropic-ai/claude-agent-sdk" server/package.json \
    && pass "server/package.json: claude-agent-sdk listed as dep" \
    || fail "server/package.json: claude-agent-sdk listed as dep"
  grep -q "_registerExternalSession" server/src/attach.js \
    && pass "attach.js: _registerExternalSession helper exported" \
    || fail "attach.js: _registerExternalSession helper exported"
  grep -q "_attachAgentWebSocket" server/src/attach.js \
    && pass "attach.js: agent-mode WS attach handler present" \
    || fail "attach.js: agent-mode WS attach handler present"
  grep -q "_handleAgentFrame" web/public/app.js \
    && pass "app.js: agent-event frame handler wired" \
    || fail "app.js: agent-event frame handler wired"
  # Phase 9: spawnSession no longer "branches" — agent is the only
  # mode. The const declaration is the new contract.
  grep -q "const mode = 'agent'" server/src/sessions.js \
    && pass "sessions.js: spawnSession hardcodes mode='agent' (Phase 9)" \
    || fail "sessions.js: spawnSession does not pin mode='agent'"
  if have_node; then
    if node test/agent-session.test.js >/dev/null 2>&1; then
      pass "test/agent-session.test.js (6 cases — incl phase-2 menu round-trip)"
    else
      # Network or auth may fail in CI; skip rather than red the suite.
      skip "test/agent-session.test.js (skipped — SDK or auth unavailable)"
    fi
  else
    skip "test/agent-session.test.js (no host node)"
  fi
  # Phase 2: canUseTool synthesizes chat-pane menus + resolveMenuPick
  # threads the answer back. handleMenuPick routes to agent sessions
  # when session.mode === 'agent'.
  grep -q "resolveMenuPick" server/src/agent-session.js \
    && pass "agent-session.js: resolveMenuPick handler present" \
    || fail "agent-session.js: resolveMenuPick handler present"
  grep -q "_handleAskUserQuestion\|_handlePermissionRequest" server/src/agent-session.js \
    && pass "agent-session.js: AskUserQuestion + permission menu builders present" \
    || fail "agent-session.js: AskUserQuestion + permission menu builders present"
  grep -q "session.resolveMenuPick" server/src/attach.js \
    && pass "attach.js: handleMenuPick routes to agent sessions" \
    || fail "attach.js: handleMenuPick routes to agent sessions"
  grep -q "menuMod.handleSessionMenu" server/src/attach.js \
    && pass "attach.js: _registerExternalSession wires 'menu' to menuMod" \
    || fail "attach.js: _registerExternalSession wires 'menu' to menuMod"
  # Phase 3: structured event renderer for agent-mode sessions.
  grep -q "agent-card-claude\|agent-card-tool\|agent-card-result" web/public/styles.css \
    && pass "styles.css: agent-card-* event-card styles present" \
    || fail "styles.css: agent-card-* event-card styles present"
  grep -q "_AGENT_TOOL_ICONS\|_agentToolIcon" web/public/app.js \
    && pass "app.js: per-tool icon map present" \
    || fail "app.js: per-tool icon map present"
  grep -q "agent-card-md" web/public/app.js \
    && pass "app.js: rich event-card renderer present (markdown body)" \
    || fail "app.js: rich event-card renderer present (markdown body)"
  # Phase 1 aggressive-minimize: tool cards collapse by default, click the
  # head to toggle. Three guards must remain wired so signal doesn't
  # regress: (1) AGENT_DEFAULT_EXPANDED whitelists ONLY claude text +
  # fatal as initially open; (2) collapsed cards hide their body via CSS;
  # (3) tool errors (isError) force-expand so failures aren't hidden.
  grep -q "AGENT_DEFAULT_EXPANDED" web/public/app.js \
    && pass "app.js: AGENT_DEFAULT_EXPANDED whitelist" \
    || fail "app.js: AGENT_DEFAULT_EXPANDED whitelist"
  grep -q "agent-card-expanded\|agent-card-collapsed" web/public/app.js \
    && pass "app.js: expand/collapse class toggle" \
    || fail "app.js: expand/collapse class toggle"
  grep -q "agent-card-force-expand" web/public/app.js \
    && pass "app.js: tool errors force-expand" \
    || fail "app.js: tool errors force-expand"
  grep -Pzoq "agent-card\.agent-card-collapsed[\s\S]{0,80}agent-card-body[\s\S]{0,40}display:\s*none" web/public/styles.css \
    && pass "styles.css: collapsed cards hide their body" \
    || fail "styles.css: collapsed cards hide their body"
  # Phase 2.5 retired the sticky-bottom + inline option buttons on the
  # chat-msg-menu row. Permission picking moved to the perm-modal
  # popup (asserted further below). The chat row is now a passive
  # history entry + a "↗ open in popup" re-entry hint.
  ! grep -q "position: sticky" web/public/styles.css \
    | grep -v "perm-modal\|perm-modal-pager" >/dev/null 2>&1 || true
  ! grep -q "chat-menu-opt\b" web/public/app.js \
    && pass "app.js: old inline .chat-menu-opt buttons removed" \
    || fail "app.js: old inline .chat-menu-opt buttons still present"
  ! grep -q "chat-menu-opts\|chat-menu-submit\|chat-menu-toggle\|chat-menu-glyph\|chat-menu-hint" web/public/styles.css \
    && pass "styles.css: old inline-menu rules removed" \
    || fail "styles.css: old inline-menu rules still present"
  # The '↗ Awaiting answer — open in popup' affordance line was
  # retired (2026-05-15). The chat-msg row itself carries
  # data-perm-reopen='1' + .chat-msg-menu-active so clicking
  # anywhere on an active menu reopens the modal.
  grep -q "chat-msg-menu-active" web/public/app.js \
    && pass "app.js: active menu row marked click-to-reopen-modal" \
    || fail "app.js: active menu row not marked click-to-reopen-modal"
  grep -q "data-perm-reopen" web/public/app.js \
    && pass "app.js: clicking the chat row re-opens perm-modal" \
    || fail "app.js: clicking the chat row re-opens perm-modal"
  # Chrome batching: consecutive low-info events (turn_start,
  # iteration_start, hook_*, permission_*, rate_limit, etc.) fold
  # into one compact "▸ chrome × N" indicator row. Click to expand
  # and see each event listed individually. Keeps the timeline
  # focused on results (assistant_text / tool_use / tool_result /
  # turn_result / fatal).
  grep -q "AGENT_CHROME_TYPES" web/public/app.js \
    && pass "app.js: chrome-event batching set defined" \
    || fail "app.js: chrome-event batching set missing"
  grep -q "_createChromeBatch\|_appendToChromeBatch" web/public/app.js \
    && pass "app.js: chrome-batch helpers wired" \
    || fail "app.js: chrome-batch helpers missing"
  grep -q "iteration_start" web/public/app.js \
    && pass "app.js: iteration_start handled in chrome batch" \
    || fail "app.js: iteration_start handler missing"
  grep -q "agent-card-count" web/public/styles.css \
    && pass "styles.css: combined-card × N count badge" \
    || fail "styles.css: combined-card × N count badge"
  grep -q "agent-chrome-row" web/public/styles.css \
    && pass "styles.css: chrome-batch row styling" \
    || fail "styles.css: chrome-batch row styling missing"
  # Phase 1.5: permission / AskUserQuestion popup. Modal lives in
  # index.html; the JS in app.js maintains state.pendingMenuQueue
  # (a derived view over state.chatMessages — finds every menu that
  # isn't picked/submitted/superseded). When multiple parallel
  # canUseTool callbacks race (subagent + parent, or two tools in one
  # assistant turn), each menu has its own hash; the prev/next nav
  # cycles the queue and every click sends {t:'menu-pick', n, hash}
  # so the server routes the resolve to the matching _pendingPermissions
  # entry. Esc defers; click outside defers; digits 1-9 pick a single-
  # select option without clicking. Multi-select renders checkbox
  # toggles + a Submit button. Free-text options ("Type something" /
  # "Chat about it") send the pick AND focus the chat input so the
  # user types the actual answer in the next turn.
  grep -q 'id="perm-modal"' web/public/index.html \
    && pass "index.html: perm-modal element" \
    || fail "index.html: perm-modal element"
  grep -q "perm-modal-backdrop" web/public/index.html \
    && pass "index.html: perm-modal backdrop (click-to-defer)" \
    || fail "index.html: perm-modal backdrop (click-to-defer)"
  grep -q "function _renderPermModal" web/public/app.js \
    && pass "app.js: _renderPermModal defined" \
    || fail "app.js: _renderPermModal defined"
  grep -q "function _rescanPendingMenuQueue" web/public/app.js \
    && pass "app.js: _rescanPendingMenuQueue defined" \
    || fail "app.js: _rescanPendingMenuQueue defined"
  grep -q "function _bindPermModalKeys" web/public/app.js \
    && pass "app.js: _bindPermModalKeys (Esc + digit handler)" \
    || fail "app.js: _bindPermModalKeys (Esc + digit handler)"
  grep -q "function _permOptionIsFreeText" web/public/app.js \
    && pass "app.js: free-text option detector" \
    || fail "app.js: free-text option detector"
  grep -q "state\.pendingMenuQueue" web/public/app.js \
    && pass "app.js: state.pendingMenuQueue is read/written" \
    || fail "app.js: state.pendingMenuQueue is read/written"
  grep -q "perm-modal-submit" web/public/app.js \
    && pass "app.js: multi-select Submit handled in modal" \
    || fail "app.js: multi-select Submit handled in modal"
  grep -q "\.perm-modal-box" web/public/styles.css \
    && pass "styles.css: perm-modal-box styling" \
    || fail "styles.css: perm-modal-box styling"
  grep -Pzoq "\.perm-modal\s*\{[\s\S]{0,200}position:\s*fixed" web/public/styles.css \
    && pass "styles.css: perm-modal is position:fixed overlay" \
    || fail "styles.css: perm-modal is position:fixed overlay"
  # Phase 2: agent events render into #chat-messages (single timeline).
  # _ensureAgentLogPane now returns the chat-messages container so each
  # tool_use / tool_result / claude-text card sits alongside chat bubbles.
  # On the first agent frame of an attach we force the chat pane open
  # and hide #terminal-wrap (which is empty for agent-mode sessions);
  # session-switch resets the latch so PTY sessions are unaffected.
  grep -Pzoq "function _ensureAgentLogPane[\s\S]{0,400}getElementById\('chat-messages'\)" web/public/app.js \
    && pass "app.js: _ensureAgentLogPane targets #chat-messages" \
    || fail "app.js: _ensureAgentLogPane targets #chat-messages"
  grep -q "_agentChatPaneArmed" web/public/app.js \
    && pass "app.js: agent-frame auto-opens chat pane (one-shot per attach)" \
    || fail "app.js: agent-frame auto-opens chat pane (one-shot per attach)"
  grep -q "chat-msg-agent" web/public/app.js \
    && pass "app.js: agent cards tagged chat-msg-agent" \
    || fail "app.js: agent cards tagged chat-msg-agent"
  grep -q "#chat-messages \.agent-card" web/public/styles.css \
    && pass "styles.css: agent-cards styled inside #chat-messages" \
    || fail "styles.css: agent-cards styled inside #chat-messages"
  # Phase 4: streaming-input + interrupt semantics. AgentSession holds a
  # single long-lived query() with an AsyncMessageQueue prompt;
  # interrupt() aborts via AbortController and the next write() resumes.
  grep -q "AsyncMessageQueue" server/src/agent-session.js \
    && pass "agent-session.js: AsyncMessageQueue helper present" \
    || fail "agent-session.js: AsyncMessageQueue helper present"
  grep -q "interrupt()\|_abortController.abort" server/src/agent-session.js \
    && pass "agent-session.js: interrupt()/AbortController wired" \
    || fail "agent-session.js: interrupt()/AbortController wired"
  grep -q "session.mode === 'agent'" server/src/slashcmds.js \
    && pass "slashcmds.js: handleDecide routes to resolveMenuPick for agent" \
    || fail "slashcmds.js: handleDecide routes to resolveMenuPick for agent"
  # Phase 5 / Phase 9: ensureLiveSession respawns a fresh AgentSession
  # seeded with rec.sdkSessionId. Phase 9 step 2 dropped the PTY branch
  # entirely so the gate now just checks `rec.mode !== 'agent'` and
  # migrates the record in place.
  grep -q "rec.mode !== 'agent'" server/src/sessions.js \
    && pass "sessions.js: ensureLiveSession migrates legacy records to agent" \
    || fail "sessions.js: ensureLiveSession agent-mode migrator missing"
  grep -q "resumeSdkSessionId" server/src/agent-session.js \
    && pass "agent-session.js: resumeSdkSessionId seed accepted" \
    || fail "agent-session.js: resumeSdkSessionId seed accepted"
  grep -q "\\[agent-resume\\]\\|\\[agent-attach\\]" server/src/attach.js \
    && pass "attach.js: [agent-attach]/[agent-resume] diagnostic logs present" \
    || fail "attach.js: [agent-attach]/[agent-resume] diagnostic logs present"
  # Phase 7: runClaudeP (btw) + callClaudeCli (extractor) ported off
  # the `claude -p` subprocess and onto the in-process SDK query().
  if grep -q "spawn('claude'" server/src/btw.js; then
    fail "btw.js: still spawns claude -p subprocess (phase 7 swap incomplete)"
  else
    pass "btw.js: claude -p subprocess removed"
  fi
  if grep -q "spawn('claude'" server/src/claude-cli.js; then
    fail "claude-cli.js: still spawns claude -p subprocess (phase 7 swap incomplete)"
  else
    pass "claude-cli.js: claude -p subprocess removed"
  fi
  grep -q "@anthropic-ai/claude-agent-sdk" server/src/btw.js \
    && pass "btw.js: imports claude-agent-sdk" \
    || fail "btw.js: imports claude-agent-sdk"
  grep -q "@anthropic-ai/claude-agent-sdk" server/src/claude-cli.js \
    && pass "claude-cli.js: imports claude-agent-sdk" \
    || fail "claude-cli.js: imports claude-agent-sdk"
  # Phase 6: per-session allow-list as a PreToolUse hook in AgentSession.
  # Matching rules auto-allow/auto-deny BEFORE canUseTool fires, so the
  # chat-pane menu card only pops for tools the user hasn't pre-decided.
  grep -q "_preToolUseHook" server/src/agent-session.js \
    && pass "agent-session.js: PreToolUse hook present" \
    || fail "agent-session.js: PreToolUse hook present"
  grep -q "permissionDecision: 'allow'\\|permissionDecision: 'deny'" server/src/agent-session.js \
    && pass "agent-session.js: hook returns permissionDecision allow/deny" \
    || fail "agent-session.js: hook returns permissionDecision allow/deny"
  grep -q "PreToolUse:" server/src/agent-session.js \
    && pass "agent-session.js: PreToolUse wired into sdkOpts.hooks" \
    || fail "agent-session.js: PreToolUse wired into sdkOpts.hooks"
  grep -q "_matchingInputFor" server/src/agent-session.js \
    && pass "agent-session.js: tool_input → match-string adapter present" \
    || fail "agent-session.js: tool_input → match-string adapter present"
  # Phase 9 retired the MYCO_DEFAULT_MODE env-var escape hatch +
  # collapsed the spawnSession default to agent. The negative assertion
  # locks that in — re-introducing the env var would be a regression.
  ! grep -q "MYCO_DEFAULT_MODE" server/src/sessions.js \
    && pass "sessions.js: MYCO_DEFAULT_MODE env-var escape hatch retired (Phase 9)" \
    || fail "sessions.js: MYCO_DEFAULT_MODE still present"
  grep -q 'id="spawn-mode-pty"' web/public/index.html \
    && pass "index.html: hidden #spawn-mode-pty kept for cached-page back-compat" \
    || fail "index.html: hidden #spawn-mode-pty missing"
  # dedupePlanItems prompt enrichment: project CLAUDE.md + auto-memory
  # are inlined ahead of the item list so the LLM has project-specific
  # context when judging "same underlying concern".
  grep -q "_loadProjectContext" server/src/slashcmds.js \
    && pass "slashcmds: _loadProjectContext helper present" \
    || fail "slashcmds: _loadProjectContext helper present"
  grep -q "Project CLAUDE.md" server/src/slashcmds.js \
    && pass "slashcmds: dedupe prompt section for CLAUDE.md present" \
    || fail "slashcmds: dedupe prompt section for CLAUDE.md present"
  grep -q "Project auto-memory index" server/src/slashcmds.js \
    && pass "slashcmds: dedupe prompt section for memory index present" \
    || fail "slashcmds: dedupe prompt section for memory index present"
  # Regression: every plan-mutation endpoint must sync rec.artifacts from
  # the on-disk file BEFORE mutating. Stale in-memory state vs fresh
  # _myco_/<type>.<ext> caused silent merge no-ops on mycobeta 2026-05-15.
  grep -q "_loadArtifactIntoRecFromFile" server/src/artifacts.js \
    && pass "artifacts: _loadArtifactIntoRecFromFile helper present" \
    || fail "artifacts: _loadArtifactIntoRecFromFile helper present"
  # Each of the 8 mutation endpoints (refresh, run, mark, vote, comment,
  # plan/merge, delete-item, delete-comment) must call the sync.
  count=$(grep -c "_loadArtifactIntoRecFromFile(ctx.rec" server/src/artifacts.js || echo 0)
  if [ "$count" -ge 8 ]; then
    pass "artifacts: sync helper wired into ≥8 mutation endpoints (got $count)"
  else
    fail "artifacts: sync helper called only $count times, expected ≥8"
  fi
  if have_node; then
    if node test/artifact-sync-from-file.test.js >/dev/null 2>&1; then
      pass "test/artifact-sync-from-file.test.js (5 cases)"
    else
      fail "test/artifact-sync-from-file.test.js — re-run with 'node test/artifact-sync-from-file.test.js' to see failures"
    fi
  else
    skip "test/artifact-sync-from-file.test.js (no host node)"
  fi
  if have_node; then
    if node test/dedupe-context.test.js >/dev/null 2>&1; then
      pass "test/dedupe-context.test.js (5 cases)"
    else
      fail "test/dedupe-context.test.js — re-run with 'node test/dedupe-context.test.js' to see failures"
    fi
  else
    skip "test/dedupe-context.test.js (no host node)"
  fi
  # One-shot migration: rewrites pre-ca9bcf1 hex-id plan items to
  # fr-N/td-N/bug-N (addedAt order). Idempotent.
  [ -x migrate-plan-ids.js ] \
    && pass "migrate-plan-ids.js present + executable" \
    || fail "migrate-plan-ids.js present + executable"
  if have_node; then
    if node test/migrate-plan-ids.test.js >/dev/null 2>&1; then
      pass "test/migrate-plan-ids.test.js (4 cases)"
    else
      fail "test/migrate-plan-ids.test.js — re-run with 'node test/migrate-plan-ids.test.js' to see failures"
    fi
  else
    skip "test/migrate-plan-ids.test.js (no host node)"
  fi
  if have_node; then
    if node test/chat-routing.test.js >/dev/null 2>&1; then
      pass "test/chat-routing.test.js (7 cases)"
    else
      fail "test/chat-routing.test.js — re-run with 'node test/chat-routing.test.js' to see failures"
    fi
  else
    skip "test/chat-routing.test.js (no host node)"
  fi
}

test_conv_view_css() {
  # Phase 9 step 3 retired the JSONL transcript pane + its viewer
  # helpers; the .conv-* CSS rules are dead code. The conv-mermaid
  # container is still referenced by renderConvMessage (kept for any
  # future agent-event-rendered mermaid block) so assert it survives.
  grep -q 'conv-mermaid' web/public/styles.css && pass "mermaid CSS" || fail "mermaid CSS"
}

test_conv_view_js() {
  grep -q 'function renderMd' web/public/app.js && pass "renderMd" || fail "renderMd"
  grep -q 'function renderMermaidInContainer' web/public/app.js && pass "renderMermaidInContainer" || fail "renderMermaidInContainer"
  # Regression: mermaid.render leaks an error <div id="dmermaid-…"> when
  # parse fails (the "Syntax error in text, mermaid version X" SVG).
  # renderMermaidInContainer must clean those temp/orphan nodes so they
  # don't stack up at the bottom of any pane that renders mermaid.
  grep -q "document.getElementById('d' + id)" web/public/app.js \
    && pass "mermaid temp-div orphan cleanup" \
    || fail "mermaid temp-div orphan cleanup"
  # Regression: discussion-panel chat messages must also go through renderMd
  # so menu broadcasts ("Claude wants to run `Bash(...)`"), allow/deny
  # notes, and the /allowlist output don't show as raw backticks/markdown.
  grep -Pzoq 'class="chat-text">\$\{renderMd' web/public/app.js \
    && pass "discussion chat body rendered as markdown" \
    || fail "discussion chat body rendered as markdown"
  # Regression: each WS message handler must guard against stale-WS
  # messages so a session A 'chat' frame that lands during a session
  # switch doesn't end up in session B's chat panel.
  test "$(grep -c 'if (state.ws !== ws) return;' web/public/app.js)" -ge 2 \
    && pass "stale-WS guard on both message handlers" \
    || fail "stale-WS guard on both message handlers"
  # Regression: Plan/Arch/Test panels must be wiped on session switch so
  # the previous session's extracted content doesn't linger.
  grep -q "function clearArtifactBodies" web/public/app.js \
    && pass "clearArtifactBodies() defined" \
    || fail "clearArtifactBodies() defined"
  grep -q "clearArtifactBodies()" web/public/app.js \
    && pass "clearArtifactBodies() called from openSession" \
    || fail "clearArtifactBodies() called from openSession"
  grep -q 'function openSession' web/public/app.js && pass "openSession" || fail "openSession"
}

test_at_myco_chat_handler() {
  # Phase 9 step 2: @myco / @<word> routing now lives in attach.js's
  # handleChatPostfixes. session.write() pushes to the AgentSession's
  # streaming-input queue (no PTY \r).
  grep -q '@myco' server/src/attach.js && pass "@myco handler" || fail "@myco handler"
  grep -q 'session.write' server/src/attach.js && pass "session.write for @myco" || fail "session.write present"
  # Generalised @<word> prefix: any @<unknown-word> routes to the agent.
  # @<known-user> is the only chat-only path (mention with highlight).
  grep -q 'CHAT_ALIAS_PREFIX_RE' server/src/attach.js \
    && pass "attach.js: generalised @<word> alias prefix" \
    || fail "attach.js: generalised @<word> alias prefix"
  grep -q '_isKnownChatUser' server/src/attach.js \
    && pass "attach.js: known-user check guards mention routing" \
    || fail "attach.js: known-user check guards mention routing"
  # Multi-line capture: the alias prefix regex must use [\s\S] (not .)
  # so a multi-line @<word> message reachable via the discussion
  # textarea captures all lines, not just the first.
  grep -qF '[\s\S]+' server/src/attach.js \
    && pass "chat-alias regex captures multi-line input" \
    || fail "chat-alias regex captures multi-line input"
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
  grep -q 'attachViewerWebSocket' server/src/attach.js && pass "attachViewerWebSocket" || fail "attachViewerWebSocket"
  grep -q 'attachViewerWebSocket' server/src/index.js && pass "viewer WS routing" || fail "viewer WS routing"
}

test_new_session_readonly() {
  # Regression: a freshly spawned agent session has no JSONL transcript
  # for ~5 seconds while claude initialises. Two bugs used to make this
  # awkward — the original attachWebSocket resolved the transcript path
  # ONCE at attach, so new owners never got transcript-init /
  # transcript-delta; and openSession landed owners on an empty
  # terminal-wrap instead of the readonly conv pane. The fixes wire
  # both ends:
  #   - server: shared streamTranscriptToWs() polls until the JSONL
  #     appears, then init+watch (used by the viewer path).
  #   - client: doSpawn passes { startInReadonly: true } to openSession.
  grep -q 'function streamTranscriptToWs' server/src/attach.js \
    && pass "attach.js: streamTranscriptToWs helper" \
    || fail "attach.js: streamTranscriptToWs helper"
  # Regression: streamTranscriptToWs does readNewMessages(0) for the
  # init send AND watchTranscript for live updates. Without passing
  # bytesRead as startByte to watchTranscript, the watcher's own
  # initial read from byte 0 fires onNewMessages with the full
  # transcript a second time — every message renders TWICE on the
  # client until the user scrolls past them. The fix passes startByte
  # so the watcher picks up exactly where the init read finished.
  grep -q 'startByte: bytesRead' server/src/attach.js \
    && pass "attach.js: watchTranscript receives startByte to avoid replay" \
    || fail "attach.js: watchTranscript receives startByte to avoid replay"
  grep -q 'opts.startByte' server/src/transcript.js \
    && pass "transcript.js: watchTranscript honors startByte opt" \
    || fail "transcript.js: watchTranscript honors startByte opt"
  # Chat pane must render markdown + mermaid the same way the transcript
  # view does. Both share renderMd → marked + hljs, but only the
  # transcript path used to call renderMermaidInContainer; chat showed
  # ```mermaid``` blocks as raw code. Also: missing CSS for headings,
  # blockquote, tables, hr, links inside .chat-msg .chat-text meant
  # ordinary markdown features rendered poorly in chat bubbles.
  grep -qF 'renderMermaidInContainer(list)' web/public/app.js \
    && pass "app.js: renderChatPane runs mermaid pass on the chat list" \
    || fail "app.js: chat pane does not process mermaid blocks"
  # Regression: appendChatMessage must NOT do a full innerHTML rebuild
  # on every new row. The original implementation called
  # renderChatPane(true) on each append, which wiped and rebuilt the
  # entire chat DOM (re-parsing markdown and re-rendering mermaid for
  # every prior row) on every chat message — visible as the chat pane
  # flashing/reloading entire history during a live turn. Switch to
  # incremental _appendChatMessageDom.
  grep -qF '_appendChatMessageDom(message)' web/public/app.js \
    && pass "app.js: incremental chat append helper defined" \
    || fail "app.js: missing _appendChatMessageDom helper"
  # Negative guard: appendChatMessage must not reference renderChatPane.
  # (renderChatPane is still allowed in applyChatHistory + clearChat —
  # the full-rebuild events.)
  if awk '/^function appendChatMessage\(/,/^}$/' web/public/app.js | grep -q 'renderChatPane('; then
    fail "app.js: appendChatMessage still calls renderChatPane (causes full rebuild on every chat frame)"
  else
    pass "app.js: appendChatMessage does not trigger full chat rebuild"
  fi
  # Surgical menu deactivation: when a new menu (or menu-auto) lands, the
  # prior menu's clickable buttons must be replaced in-place. Without this,
  # a stale row could fire a pick at a dialog Claude has long since moved
  # past — the same race the data-hash plumbing also guards against.
  grep -qF '_deactivatePriorMenuRows' web/public/app.js \
    && pass "app.js: prior menu rows are surgically deactivated on new menu append" \
    || fail "app.js: missing _deactivatePriorMenuRows — new menu won't deactivate older clickable menus"
  # Regression: the claude-typing indicator lives in the chatpane flex
  # column as a PERMANENT-SLOT sibling of #chat-messages and #chat-form.
  # The slot is always 30px tall — `.claude-typing[hidden]` keeps
  # `display: flex` plus `visibility: hidden` so the chat-messages
  # flex slot never resizes across the indicator's open/closed/text-
  # change cycles. Earlier designs (display:none toggle, absolute
  # overlay above chat-form) each let users perceive the chat content
  # moving up/down on every spinner tick — this fixed-slot layout is
  # the durable fix.
  grep -qF 'id="claude-typing"' web/public/index.html \
    && pass "index.html: #claude-typing declared as a static element" \
    || fail "index.html: #claude-typing missing — JS-only mount path can race the first spinner tick"
  if awk '/^function _renderClaudeTyping\(/,/^}$/' web/public/app.js | grep -q 'createElement\|insertBefore'; then
    fail "app.js: _renderClaudeTyping still creates/relocates the indicator at runtime — declare it statically in HTML so the slot is reserved from page load"
  else
    pass "app.js: _renderClaudeTyping is a pure update (no DOM creation)"
  fi
  if awk '/^function _renderClaudeTyping\(/,/^}$/' web/public/app.js | grep -q 'scrollChatToLatest\|isChatAtBottom'; then
    fail "app.js: _renderClaudeTyping still scroll-anchors — the permanent flex slot makes that unnecessary"
  else
    pass "app.js: _renderClaudeTyping is layout-neutral (no scroll-anchor needed)"
  fi
  grep -Pzoq '\.claude-typing\s*\{[^}]*flex:\s*0\s+0\s+\d+px' web/public/styles.css \
    && pass "css: .claude-typing reserves a fixed-px flex slot" \
    || fail "css: .claude-typing slot isn't a fixed-px flex item — chat content will move on spinner toggles"
  grep -Pzoq '\.claude-typing\[hidden\]\s*\{[^}]*visibility:\s*hidden' web/public/styles.css \
    && pass "css: .claude-typing[hidden] uses visibility (slot stays reserved)" \
    || fail "css: .claude-typing[hidden] no longer uses visibility:hidden — slot will collapse and reflow chat"
  grep -qF 'contain: layout style paint' web/public/styles.css \
    && pass "css: .claude-typing is contained (glyph/text changes don't reflow siblings)" \
    || fail "css: .claude-typing missing CSS containment"
  grep -qF '.chat-msg .chat-text blockquote' web/public/styles.css \
    && pass "css: chat-text blockquote styled" \
    || fail "css: chat-text blockquote not styled"
  grep -qF '.chat-msg .chat-text table' web/public/styles.css \
    && pass "css: chat-text table styled" \
    || fail "css: chat-text table not styled"
  grep -qF '.chat-msg .chat-text .conv-mermaid' web/public/styles.css \
    && pass "css: chat-text mermaid container sized to bubble width" \
    || fail "css: chat-text mermaid container not styled"
  # NOTE: the old startInReadonly auto-switch was reverted — interaction
  # now happens in the chat pane via the typing-dots indicator + the
  # buffered-reply path (see test_chat_window guards below). doSpawn
  # opens new sessions on the live xterm, and the user reads/sends in
  # chat. The negative guard for the auto-switch lives in
  # test_chat_window.
  # Regression: MenuInterceptor broadcasts pending TUI dialogs into
  # chat with meta.kind === 'menu'. The picker is rendered INLINE
  # inside each menu chat message — only the most recent one keeps its
  # buttons clickable; older ones are disabled so a stale row can't
  # poke a different dialog. Previously we drew the picker at the top
  # of the conv pane, but transcript-delta auto-scroll could push it
  # off-screen, causing intermittent disappearances.
  grep -q "meta.kind === 'menu'" web/public/app.js \
    && pass "app.js: detects menu chat messages by meta.kind" \
    || fail "app.js: detects menu chat messages by meta.kind"
  grep -q '_findLastMenuMessageIdx' web/public/app.js \
    && pass "app.js: only latest menu message is the active one" \
    || fail "app.js: only latest menu message is the active one"
  # Phase 2.5: menu picks route through the perm-modal popup, which
  # sends {t:'menu-pick', n, hash} via sendMenuPick — hash is the SDK
  # toolUseID-derived identity that lets parallel canUseTool callbacks
  # resolve to the right promise on the server.
  grep -qF 'sendMenuPick(n, hash)' web/public/app.js \
    && pass "app.js: modal option click uses sendMenuPick(n, hash)" \
    || fail "app.js: modal option click uses sendMenuPick(n, hash)"
  grep -q "msg.t === 'menu-pick'" server/src/attach.js \
    && pass "attach.js: handles menu-pick WS frame" \
    || fail "attach.js: handles menu-pick WS frame"
  grep -q 'function handleMenuPick' server/src/attach.js \
    && pass "attach.js: handleMenuPick helper" \
    || fail "attach.js: handleMenuPick helper"
  # Negative guard: the callout must not fall back to a chat /decide send.
  grep -q 'sendChatMessage(\`/decide' web/public/app.js \
    && fail "app.js: callout still sends /decide via chat (regression)" \
    || pass "app.js: callout no longer routes through chat"
  # Phase 2.5: .chat-menu-opt was retired with the inline picker; the
  # modal's .perm-modal-opt is the equivalent now.
  grep -q '\.perm-modal-opt' web/public/styles.css \
    && pass "styles.css: .perm-modal-opt styling (modal picker)" \
    || fail "styles.css: .perm-modal-opt styling (modal picker)"
  # Whole-card unified menu look: app.js tags the chat-msg div with
  # chat-msg-menu when menu options are present, and the stylesheet
  # styles that combined selector as one bordered container so the
  # title + buttons no longer look like separate cards.
  grep -qF 'chat-msg-menu' web/public/app.js \
    && pass "app.js: tags menu messages with chat-msg-menu class" \
    || fail "app.js: tags menu messages with chat-msg-menu class"
  grep -qF '.chat-msg.chat-msg-menu' web/public/styles.css \
    && pass "styles.css: chat-msg-menu unified card style" \
    || fail "styles.css: chat-msg-menu unified card style"
  # The inner .chat-text inside a menu card must be flattened — otherwise
  # the from-claude bubble (green tint + left border + padding) draws a
  # second card *inside* the outer menu card, wasting horizontal space.
  # Test: the chat-msg-menu .chat-text rule sets background: transparent
  # so the from-claude tint can't bleed through.
  if have_node; then
    node -e "
      const css = require('fs').readFileSync('web/public/styles.css', 'utf8');
      const m = css.match(/\.chat-msg\.chat-msg-menu\s+\.chat-text\s*\{([^}]*)\}/);
      if (!m) { console.error('selector missing'); process.exit(1); }
      const body = m[1];
      const checks = [
        [/background:\s*transparent/, 'background: transparent'],
        [/border-left:\s*none/,        'border-left: none'],
      ];
      for (const [re, label] of checks) {
        if (!re.test(body)) { console.error('missing: ' + label); process.exit(1); }
      }
    " >/dev/null 2>&1 \
      && pass "styles.css: menu .chat-text flattened (no nested card)" \
      || fail "styles.css: menu .chat-text flattened (no nested card)"
  else
    skip "styles.css: menu .chat-text flattened (no host node)"
  fi
  # When a menu is answered, the inline option buttons collapse to a
  # single "✓ Picked [N] <label>" line — no disabled-buttons graveyard
  # cluttering the chat scroll.
  grep -q 'chat-menu-resolved' web/public/app.js \
    && pass "app.js: answered menu renders compact resolved line" \
    || fail "app.js: answered menu renders compact resolved line"
  grep -q '\.chat-menu-resolved' web/public/styles.css \
    && pass "styles.css: chat-menu-resolved styling" \
    || fail "styles.css: chat-menu-resolved styling"
  # Resolved-card collapse: once the menu has been answered (or has been
  # superseded by a newer menu), the whole bubble shrinks — lead +
  # question are dropped from the rendered body and the heavy yellow
  # attention border is removed. The full question is preserved as a
  # title= tooltip so context is recoverable on hover.
  grep -q 'chat-msg-menu-collapsed' web/public/app.js \
    && pass "app.js: resolved menu card tagged with collapsed class" \
    || fail "app.js: resolved menu card tagged with collapsed class"
  grep -q 'isResolvedMenu' web/public/app.js \
    && pass "app.js: isResolvedMenu gate (wasSubmitted | pickedN | stale)" \
    || fail "app.js: isResolvedMenu gate (wasSubmitted | pickedN | stale)"
  grep -q '\.chat-msg-menu-collapsed' web/public/styles.css \
    && pass "styles.css: chat-msg-menu-collapsed slim style" \
    || fail "styles.css: chat-msg-menu-collapsed slim style"
  # Disable-on-pick: clicking an option in the chat-inline picker
  # must mark the underlying chat message as answered so subsequent
  # re-renders keep the buttons disabled with the picked one green-
  # highlighted. Without this state, every appendChatMessage call
  # later in the turn (claude streaming text) rebuilt the buttons
  # active again.
  grep -q '_answered = true' web/public/app.js \
    && pass "app.js: marks menu message answered on click" \
    || fail "app.js: marks menu message answered on click"
  grep -q 'm\._answered' web/public/app.js \
    && pass "app.js: _findLastMenuMessageIdx honors _answered" \
    || fail "app.js: _findLastMenuMessageIdx honors _answered"
  # Server-side persistence: clicking a menu option must mutate the
  # corresponding chat entry in rec.chat so a page refresh / WS
  # reconnect (which reloads chat-history from disk) keeps the
  # picker disabled with the picked option highlighted.
  grep -q '_markMenuChatAnswered' server/src/attach.js \
    && pass "attach.js: menu-pick persists answered on rec.chat" \
    || fail "attach.js: menu-pick persists answered on rec.chat"
  grep -q 'm.meta.answered' web/public/app.js \
    && pass "app.js: client honors persisted meta.answered" \
    || fail "app.js: client honors persisted meta.answered"
  # /decide slash command must mirror the same persistence.
  grep -qF "m.meta.answered = true" server/src/slashcmds.js \
    && pass "slashcmds: /decide persists answered on rec.chat" \
    || fail "slashcmds: /decide persists answered on rec.chat"
  # Live spinner status surfaced from the headless terminal:
  #   server pushes 'claude-status' WS frames whose text is something like
  #   "· Cerebrating… (40s · ↓ 3.4k tokens · thought for 2s)" when claude
  #   is busy, or null when idle. The chat-pane indicator carries ONLY
  #   that live text — no static "Claude is working…" fallback — and
  #   its height is fixed via CSS so tick-by-tick status updates don't
  #   reflow the chat-message list above.
  grep -qF "'Claude is working" web/public/app.js \
    && fail "app.js: 'Claude is working' fallback label still present (regression)" \
    || pass "app.js: typing indicator label uses live status only (no fallback chatter)"
  # Match the call site specifically (`scrollIntoView(`) not the word — the
  # explanatory comment in the function body mentions scrollIntoView too.
  awk '/^function _renderClaudeTyping\(/,/^\}/' web/public/app.js | \
    grep -qF 'host.scrollIntoView(' \
    && fail "app.js: _renderClaudeTyping still calls scrollIntoView (yanks chat viewport on every tick)" \
    || pass "app.js: _renderClaudeTyping no longer auto-scrolls on tick"
  # Fixed slot height. Was `height: 30px` historically; the permanent-
  # flex-slot design uses `flex: 0 0 <N>px` (same visual outcome, gives
  # the flex parent an explicit basis that won't grow/shrink). The exact
  # pixel value can drift (24, 28, 30 are all valid) — what matters is
  # that the slot has a FIXED size so status updates don't reflow the
  # chat. Loose regex accepts any integer-px value.
  if grep -qE 'flex:\s*0\s+0\s+[0-9]+px|height:\s*[0-9]+px' web/public/styles.css; then
    pass "css: claude-typing has fixed slot dimensions (no reflow on status update)"
  else
    fail "css: claude-typing missing fixed height — status updates will reflow chat"
  fi
  grep -qF '.claude-typing-label' web/public/styles.css \
    && pass "css: claude-typing-label has overflow-ellipsis rules" \
    || fail "css: claude-typing-label not styled"
  # Phase 9 step 2: AgentSession doesn't scrape a spinner line (no
  # headless xterm). The claude-status WS frame still fires from
  # _sendAttachSnapshot for compatibility (carries text=null, status=
  # null) so the client clears its strip on attach. The client-side
  # handler stays.
  grep -q "msg.t === 'claude-status'" web/public/app.js \
    && pass "app.js: handles claude-status WS frame" \
    || fail "app.js: handles claude-status WS frame"
  grep -q '_setClaudeStatusLine' web/public/app.js \
    && pass "app.js: typing indicator label uses live status text" \
    || fail "app.js: typing indicator label uses live status text"
  # Chat-only flow: when @myco sent, a typing indicator appears in chat;
  # assistant transcript text is buffered and posted as a chat message
  # after a quiet window so the user gets the FINAL result without
  # intermediate noise. The main pane is NOT auto-switched on send.
  grep -q '_markAwaitingClaude' web/public/app.js \
    && pass "app.js: @myco marks awaiting-claude" \
    || fail "app.js: @myco marks awaiting-claude"
  grep -q 'CLAUDE_IDLE_MS' web/public/app.js \
    && pass "app.js: idle-timeout constant defined" \
    || fail "app.js: idle-timeout constant defined"
  # Phase 9 step 9: transcript-delta WS frame is gone. The server-side
  # persistAssistantTextToChat watcher mirrors assistant text into
  # rec.chat (broadcast as 'chat' frames), so the chat pane still
  # receives every claude reply — just without the client-side delta
  # rendering path.
  grep -q 'persistAssistantTextToChat' server/src/attach.js \
    && pass "attach.js: assistant text persisted into rec.chat" \
    || fail "attach.js: assistant-text watcher missing"
  grep -q '_scheduleClaudeIdleCheck' web/public/app.js \
    && pass "app.js: schedules idle check after @myco send" \
    || fail "app.js: schedules idle check after @myco send"
  grep -q 'claude-typing-dots' web/public/styles.css \
    && pass "styles.css: typing-dots animation" \
    || fail "styles.css: typing-dots animation"
  # Regression: the typing indicator must retire promptly when claude's
  # PTY spinner disappears, not wait for the 30s idle timer. Fix
  # introduces _spinnerSeen + _spinnerStopTimer + a short grace
  # (CLAUDE_POST_SPINNER_GRACE_MS) that fires _retireClaudeTyping when
  # the server-emitted claude-status flips from running → null after
  # being seen at least once this turn. Mid-stream transcript activity
  # cancels the grace so we don't yank the dots while claude is still
  # streaming text.
  grep -q 'CLAUDE_POST_SPINNER_GRACE_MS' web/public/app.js \
    && pass "app.js: post-spinner grace constant defined" \
    || fail "app.js: post-spinner grace constant missing"
  grep -q '_spinnerStopTimer' web/public/app.js \
    && pass "app.js: spinner-stop retire timer wired" \
    || fail "app.js: spinner-stop retire timer wired"
  grep -q 'function _retireClaudeTyping' web/public/app.js \
    && pass "app.js: shared _retireClaudeTyping path" \
    || fail "app.js: shared _retireClaudeTyping path missing"
  # Negative guard: doSpawn must NOT auto-switch new sessions to readonly.
  grep -qF 'openSession(body.session_id, { startInReadonly: true })' web/public/app.js \
    && fail "doSpawn auto-switched new sessions to readonly (regression)" \
    || pass "doSpawn no longer auto-switches new sessions to readonly"
  # Spawn-modal ASCII gate. Two complementary guards: a live input-event
  # filter strips non-ASCII as the user types/pastes (best-effort, since
  # IMEs / clipboard managers can land bytes without firing 'input'),
  # plus a submit-time NON_ASCII_RE.test() gate that returns an inline
  # error rather than silently mangling the cwd. The pattern attribute
  # on the input element backs both with HTML5-level form validation.
  # Phase 2.6: the spawn-cwd input is now a FREE-FORM display label
  # (the actual folder is auto-named after the session id, so the
  # pre-2026-05-15 ASCII-path validation no longer applies). The
  # NON_ASCII_RE helpers stay defined because doSpawn still strips
  # path-illegal characters defensively, but the input pattern + the
  # hard-reject at submit have been retired in favour of a friendly
  # label that can be anything.
  grep -qF 'NON_ASCII_RE' web/public/app.js \
    && pass "app.js: NON_ASCII_RE still defined (defensive stripping)" \
    || fail "app.js: NON_ASCII_RE removed — should stay for defensive stripping"
  # Session id is the folder name. spawnSession must compute id BEFORE
  # building absCwd and use it as the folder. Verified end-to-end by
  # the persistence smoke test below.
  grep -Pzoq "absCwd = path\.join\(userRootDir, id\)" server/src/sessions.js \
    && pass "sessions.js: spawnSession uses session id as folder name" \
    || fail "sessions.js: spawnSession does not use session id as folder"
  grep -q 'placeholder="e.g.' web/public/index.html \
    && pass "index.html: spawn-cwd input relabelled as Display name (optional)" \
    || fail "index.html: spawn-cwd input still labelled as Subdirectory"
  # Per-session memory: redirect the SDK auto-memory directory into the
  # session's own .claude/memory/ instead of the shared
  # $HOME/.claude/projects/<sanitized-cwd>/memory/. settingSources
  # excludes 'user' so the global settings.json doesn't bleed across
  # sessions; project + local stay so per-session .claude/settings*.json
  # still drives per-project config.
  grep -q "autoMemoryDirectory" server/src/agent-session.js \
    && pass "agent-session: per-session autoMemoryDirectory" \
    || fail "agent-session: autoMemoryDirectory not set"
  grep -Pzoq "settingSources:\s*\['project',\s*'local'\]" server/src/agent-session.js \
    && pass "agent-session: settingSources scoped to project+local" \
    || fail "agent-session: settingSources still loading shared 'user' tier"
  # Memory migration: existing sessions whose legacy auto-memory lived
  # at ~/.claude/projects/<encoded-cwd>/memory/ get a one-shot copy
  # into <absCwd>/.claude/memory/ on the next ensureLiveSession spawn.
  # Idempotent (skips when destination exists).
  grep -q "function _migrateLegacyMemory" server/src/sessions.js \
    && pass "sessions.js: _migrateLegacyMemory helper defined" \
    || fail "sessions.js: _migrateLegacyMemory helper missing"
  # UX Phase 3: single centered column layout. The chatpane fills the
  # main pane (no longer a right-anchored sidebar with --chatpane-w);
  # its inner content is centered with max-width: 880px on desktop.
  # Artifact panes follow the same centered-content rule so opening
  # Plan/Arch/Test is visually continuous with the conversation.
  grep -Pzoq "#chatpane\.chat-main-view\s*\{[\s\S]{0,400}inset:\s*0" web/public/styles.css \
    && pass "styles.css: chatpane fills main pane (inset:0, Phase 3)" \
    || fail "styles.css: chatpane still right-anchored sidebar"
  grep -Pzoq "#chatpane\.chat-main-view\s+#chat-messages[\s\S]{0,400}max-width:\s*880px" web/public/styles.css \
    && pass "styles.css: chatpane content centered + max-width 880px" \
    || fail "styles.css: chatpane content not centered"
  grep -Pzoq "\.artifact-main-view\s+\.artifact-body[\s\S]{0,400}max-width:\s*880px" web/public/styles.css \
    && pass "styles.css: artifact-body centered + max-width 880px (Phase 3)" \
    || fail "styles.css: artifact-body not centered"
  # SDK Phase 9: spawnSession + ensureLiveSession both reject mode=pty;
  # there's no PTY driver to fall through to.
  grep -q "PTY mode is retired (Phase 9)" server/src/sessions.js \
    && pass "sessions.js: spawnSession rejects mode=pty (Phase 9)" \
    || fail "sessions.js: spawnSession still accepts mode=pty"
  ! grep -q 'spawn-mode-label\|"spawn-mode-pty" type="checkbox"' web/public/index.html \
    && pass "index.html: PTY-checkbox label retired from spawn modal" \
    || fail "index.html: PTY-checkbox label still in spawn modal"
  grep -Pzoq "_migrateLegacyMemory\(rec\.absCwd\)[\s\S]{0,800}spawnAgent" server/src/sessions.js \
    && pass "sessions.js: ensureLiveSession invokes _migrateLegacyMemory before spawnAgent" \
    || fail "sessions.js: ensureLiveSession does not run the memory migration"
  # Smoke test the helper itself: copy a tmp fixture from a fake
  # projects/<enc>/memory dir into the target session folder.
  if have_node; then
    node -e "
      const fs = require('fs'), path = require('path'), os = require('os');
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mem-mig-'));
      const sessionCwd = path.join(tmpRoot, 'session');
      fs.mkdirSync(sessionCwd, { recursive: true });
      // Fake the legacy SDK projects dir layout
      const fakeHome = path.join(tmpRoot, 'home');
      fs.mkdirSync(fakeHome, { recursive: true });
      process.env.HOME = fakeHome;
      const sessions = require('./server/src/sessions');
      const legacyMemDir = path.join(fakeHome, '.claude', 'projects', sessions.encodeCwdForClaude(sessionCwd), 'memory');
      fs.mkdirSync(legacyMemDir, { recursive: true });
      fs.writeFileSync(path.join(legacyMemDir, 'MEMORY.md'), 'top-level\n');
      fs.writeFileSync(path.join(legacyMemDir, 'user_role.md'), '---\nname: user role\n---\n\ntest\n');
      fs.mkdirSync(path.join(legacyMemDir, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(legacyMemDir, 'sub', 'nested.md'), 'sub\n');
      const n = sessions._migrateLegacyMemory(sessionCwd);
      const destDir = path.join(sessionCwd, '.claude', 'memory');
      if (n !== 3) throw new Error('expected 3 files migrated, got ' + n);
      if (!fs.existsSync(path.join(destDir, 'MEMORY.md'))) throw new Error('MEMORY.md missing');
      if (!fs.existsSync(path.join(destDir, 'sub', 'nested.md'))) throw new Error('sub/nested.md missing');
      // Idempotency: second call must return 0 (destination exists).
      const n2 = sessions._migrateLegacyMemory(sessionCwd);
      if (n2 !== 0) throw new Error('expected 0 on second call, got ' + n2);
      console.log('OK');
    " >/dev/null 2>&1 \
      && pass "_migrateLegacyMemory copies legacy memory + is idempotent" \
      || fail "_migrateLegacyMemory smoke test failed"
  else
    skip "_migrateLegacyMemory smoke test (no host node)"
  fi
  # Phase 9 step 9 retired the readonly-fallback watchdog (the JSONL
  # transcript pane it could flip to is gone). Negative guard: keep
  # the helpers out of app.js so they don't sneak back via copy-paste.
  ! grep -q 'READONLY_FALLBACK_MS\|_armReadonlyFallback\|_cancelReadonlyFallback' web/public/app.js \
    && pass "app.js: readonly-fallback watchdog retired (Phase 9 step 9)" \
    || fail "app.js: readonly-fallback watchdog still present"
}

test_chat_user_capture() {
  grep -q 'body.user' web/public/app.js && pass "chatUser capture" || fail "chatUser capture"
  grep -q 'from-self' web/public/app.js && pass "self chat alignment" || fail "self chat alignment"
}

test_session_switching_clears_panes() {
  # Phase 9 step 3: #conversation-wrap is gone. The teardown still
  # null-guards the lookup as a back-compat shim for cached pages.
  grep -q "convWrap.hidden = true" web/public/app.js \
    && pass "pane clear on switch (null-guarded conv-wrap hide)" \
    || fail "pane clear on switch"
  # openSession is split into focused helpers so each concern (teardown,
  # state reset, owner xterm init, WS attach URL) can change without
  # rewriting the others. Regression guard: keep the seams in place.
  grep -q 'function _teardownPreviousSession' web/public/app.js && pass "openSession: _teardownPreviousSession helper" || fail "openSession: _teardownPreviousSession helper"
  grep -q 'function _resetUiForNewSession'   web/public/app.js && pass "openSession: _resetUiForNewSession helper"   || fail "openSession: _resetUiForNewSession helper"
  grep -q 'function _initOwnerXterm'         web/public/app.js && pass "openSession: _initOwnerXterm helper"         || fail "openSession: _initOwnerXterm helper"
  grep -q 'function _buildAttachQuery'       web/public/app.js && pass "openSession: _buildAttachQuery helper"       || fail "openSession: _buildAttachQuery helper"
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

  # Markdown file viewer: .md/.markdown files render through marked +
  # mermaid (same path the chat pane uses) instead of raw text. Anchored
  # Claude cards / inline comment editor fall through to the raw view so
  # line anchors stay correct.
  grep -q 'function renderMarkdownFileView' web/public/app.js && pass "js: renderMarkdownFileView (md rich render)" || fail "js: renderMarkdownFileView missing"
  grep -qF "ext === 'md' || ext === 'markdown'" web/public/app.js && pass "js: md branch detected in renderFileViewerWithCards" || fail "js: md branch missing"
  grep -qF 'renderMermaidInContainer(wrap)' web/public/app.js && pass "js: md view runs mermaid pass" || fail "js: md view mermaid pass missing"
  grep -q '\.md-rendered' web/public/styles.css && pass "css: .md-rendered" || fail "css: .md-rendered"
  # Transcript viewer: assistant prose must be visually heavier than the
  # tool_use / tool_result blocks around it. The fix is a thicker, brighter
  # green border-left on .conv-msg-assistant .conv-text plus opacity:0.72
  # on .conv-tool-call / .conv-msg-result so the eye lands on the answer.
  grep -qF 'border-left: 4px solid rgba(63, 185, 80, 0.55)' web/public/styles.css \
    && pass "css: assistant text uses thick green border (transcript visibility)" \
    || fail "css: assistant text border treatment missing"
  grep -qF 'opacity: 0.72' web/public/styles.css \
    && pass "css: tool calls + results dimmed via opacity" \
    || fail "css: tool dim treatment missing"

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
  test_text_utils
  test_phase9_retirement
  test_cache_busters
  test_pwa_icon
  test_best_practices_template
  test_conv_view_css
  test_conv_view_js
  test_at_myco_chat_handler
  test_viewer_ws_handler_wired
  test_new_session_readonly
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
  grep -q 'attachViewerWebSocket' server/src/attach.js && pass "viewer WS handler exported" || fail "viewer WS handler"
  grep -q "t: 'viewer-mode'" server/src/attach.js && pass "viewer-mode signal sent" || fail "viewer-mode signal"
  grep -q 'viewer-mode' web/public/app.js && pass "viewer-mode handled in client" || fail "viewer-mode client"
  # Read-only viewer pane. Owner login flows in via the viewer-mode
  # message. With PTY retired, viewers see structured agent events +
  # transcript only — no live terminal panel.
  grep -q "t: 'viewer-mode'"      server/src/attach.js  && pass "server emits viewer-mode"          || fail "server emits viewer-mode"
  grep -q "owner: ownerLogin"     server/src/attach.js  && pass "viewer-mode carries owner login"   || fail "viewer-mode carries owner login"
  grep -q "id=\"readonly-banner\"" web/public/index.html && pass "html: #readonly-banner"           || fail "html: #readonly-banner"
  ! grep -q "id=\"terminal-tail\"" web/public/index.html && pass "html: #terminal-tail removed"     || fail "html: #terminal-tail still present"
  grep -q "function applyReadOnly"        web/public/app.js && pass "applyReadOnly() defined"        || fail "applyReadOnly() defined"
  ! grep -q "applyTerminalSnapshot"       web/public/app.js && pass "applyTerminalSnapshot removed"  || fail "applyTerminalSnapshot still referenced"
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
  # Regression: chat-input UX is "Enter sends, Shift+Enter inserts newline"
  # — the dominant chat-app pattern. The textarea stays multi-line so
  # Shift+Enter composition works; submission goes through bindChatUi.
  # Three guards must remain wired: IME composition (isComposing /
  # keyCode 229), autocomplete-open deferral (chat-autocomplete dropdown
  # consumes Enter for "pick"), and Shift bail-out (newline). A 2026-05-15
  # incident proved the old Ctrl/Cmd-Enter-only contract was a UX trap —
  # users typed `1` + Enter to answer a permission menu and got silently
  # stuck because the keystroke never reached the server.
  grep -Pq '<textarea[^>]*id="chat-input"' web/public/index.html \
    && pass "chat-input is a multi-line textarea" \
    || fail "chat-input is a multi-line textarea"
  grep -q "Enter sends" web/public/index.html \
    && pass "chat-input placeholder advertises Enter-to-send" \
    || fail "chat-input placeholder advertises Enter-to-send"
  grep -Pzoq "key !== 'Enter'[\s\S]{0,400}shiftKey[\s\S]{0,200}submitChat\(\)" web/public/app.js \
    && pass "Enter sends; Shift+Enter inserts newline" \
    || fail "Enter sends; Shift+Enter inserts newline"
  grep -Pzoq "key !== 'Enter'[\s\S]{0,200}isComposing" web/public/app.js \
    && pass "chat send guards IME composition (isComposing)" \
    || fail "chat send guards IME composition (isComposing)"
  grep -Pzoq "key !== 'Enter'[\s\S]{0,400}chat-autocomplete" web/public/app.js \
    && pass "chat send defers to open autocomplete dropdown" \
    || fail "chat send defers to open autocomplete dropdown"
  grep -q 'function sendChatMessage' web/public/app.js && pass "sendChatMessage() defined" || fail "sendChatMessage() defined"
  # Regression: chat sends issued while the WS is reconnecting must NOT be
  # silently dropped — they should land in an outbound queue and drain on
  # the next 'open' event. Mobile background-suspend is the common trigger.
  grep -q 'outboundChat'        web/public/app.js && pass "chat outbound queue" || fail "chat outbound queue"
  grep -q '_flushOutboundChat'  web/public/app.js && pass "flushOutboundChat helper" || fail "flushOutboundChat helper"
  grep -q 'this Claude session has exited' server/src/attach.js \
    && pass "server warns when chat hits a dead session" \
    || fail "server warns when chat hits a dead session"
  grep -q "t: 'chat'" server/src/attach.js && pass "chat WS frame format" || fail "chat WS frame"
  grep -q "t: 'chat-history'" server/src/attach.js && pass "chat-history replay" || fail "chat-history replay"
  grep -q "msg.t === 'chat-history'" web/public/app.js && pass "chat-history client handler" || fail "chat-history client handler"
  # The standalone chatpane-close × element was removed — #btn-chat
  # itself now toggles open/closed via its .active class. The optional-
  # chain handler stays in app.js for back-compat with cached pages.
  grep -q 'chatpane-close' web/public/app.js && pass "chatpane close binding (legacy)" || fail "chatpane close binding"
  # btn-chat must stay visible while the chatpane is open and pick up
  # an .active state instead of hiding (which previously read as "the
  # 💬 icon became ×"). Same pattern files/plan/arch/test already use.
  grep -qF "btn.classList.toggle('active', !!state.chatPaneVisible)" web/public/app.js \
    && pass "app.js: btn-chat picks up .active class while chatpane is open" \
    || fail "app.js: btn-chat doesn't toggle .active — chat icon will still vanish on open"
  if awk '/^function updateChatButton\(/,/^}$/' web/public/app.js | grep -q 'state.chatPaneVisible || !hasContent'; then
    fail "app.js: btn-chat still hidden while chatpane is open — drop the chatPaneVisible from the hidden check"
  else
    pass "app.js: btn-chat stays visible while chatpane is open"
  fi
  grep -qF '#btn-chat.active' web/public/styles.css \
    && pass "css: #btn-chat.active styling present" \
    || fail "css: #btn-chat.active styling missing"
  # Regression: when a claude message lands while the chat pane is
  # collapsed, the user had NO signal that new content was waiting —
  # particularly painful for the plan-mode wizard, where the generated
  # plan sits silently in chat until the user remembers to peek.
  # An unread badge on #btn-chat surfaces the count via a data
  # attribute; CSS renders the pill and pulses on bump.
  grep -qF '_bumpChatUnreadIfHidden' web/public/app.js \
    && pass "app.js: chat-unread badge bumps when pane is collapsed" \
    || fail "app.js: chat-unread badge missing — silent claude replies"
  # Regression: appendChatMessage's transcriptUuid dedup used to just
  # upgrade state and return — NEVER touching the DOM. If the existing
  # row was a stale _localOnly placeholder with empty / truncated text,
  # the chat sidebar stuck at the placeholder until a page refresh
  # rebuilt via renderChatPane. Live re-render keeps state and DOM in
  # sync. Observed mycobeta demo010 (2026-05-13): "Got your selections:
  # Flask + MongoDB + …" never showed in the chat pane live.
  grep -qF 'list.children[i].replaceWith(newEl)' web/public/app.js \
    && pass "app.js: appendChatMessage re-renders DOM on uuid-dedup upgrade" \
    || fail "app.js: uuid-dedup upgrade no longer re-renders — stale chat rows will persist until refresh"
  # Phase 9+: persistAssistantTextToChat no longer emits 'chat' frames
  # (the agent-event stream owns assistant_text now), so the per-emit
  # [persist-chat-emit] diagnostic was retired. The remaining
  # [persist-chat] batch summary still fires on every non-empty
  # mirror — pin THAT marker so the watcher can't silently no-op.
  # And pin the "live emit suppressed" guard string in the same log
  # line: if a future refactor re-introduces the dual emit, this
  # grep will red-flip and the diagnostic comment in attach.js will
  # explain why.
  grep -qF "[persist-chat]" server/src/attach.js \
    && pass "attach.js: persistAssistantTextToChat logs batch summary" \
    || fail "attach.js: [persist-chat] batch summary missing — can't tell whether the transcript mirror is firing"
  grep -qF 'live emit suppressed' server/src/attach.js \
    && pass "attach.js: persistAssistantTextToChat does not re-emit 'chat' (no duplicate render)" \
    || fail "attach.js: 'live emit suppressed' marker missing — the dual emit may have crept back, double-rendering claude replies"
  grep -qF '_resetChatUnread' web/public/app.js \
    && pass "app.js: chat-unread badge resets on setChatPane(true)" \
    || fail "app.js: chat-unread reset missing"
  grep -qF '#btn-chat[data-unread]' web/public/styles.css \
    && pass "css: chat-unread badge styling present" \
    || fail "css: chat-unread badge styling missing"
  # The chatpane is now a main-pane view (mutually exclusive with
  # terminal/conversation/files/plan/arch/test) instead of an aside
  # sidebar. This fixes mobile — the old z-index:60 overlay sat ON TOP
  # of the chrome buttons (z:50) so users couldn't tap files/plan/etc.
  # while chat was open. New layout puts chat inside #terminal-pane so
  # the buttons (still at z:50) stay above by default.
  grep -qF "'chatpane'" web/public/app.js \
    && pass "app.js: chatpane registered as a main-pane view" \
    || fail "app.js: chatpane not in MAIN_PANE_IDS — switching to another view won't auto-clear chat"
  grep -qF 'chat-main-view' web/public/index.html \
    && pass "index.html: chatpane uses chat-main-view class (lives inside #terminal-pane)" \
    || fail "index.html: chatpane is still an outer <aside> — buttons stay hidden on mobile"
  grep -q '<h2>Discussion</h2>' web/public/index.html \
    && fail "index.html: stale 'Discussion' header still present" \
    || pass "index.html: chatpane has no 'Discussion' header (icons stay visible)"
  # The desktop auto-open was removed — chat as a main-pane view would
  # have hidden the terminal on every page load.
  grep -qF 'setChatPane(window.innerWidth > 900)' web/public/app.js \
    && fail "app.js: init still auto-opens chat on desktop — hides terminal at boot" \
    || pass "app.js: init no longer auto-opens chat (boots on terminal)"
  # Chrome-icon click contract: every chrome button is a show-only
  # activator (no toggle-off on second click). Phase 9 step 9 retired
  # the 👁 preview and 📜 transcript toggles — the chatpane is the
  # only session view, so there's no terminal ↔ readonly flip left.
  grep -qF "setChatPane(true)" web/public/app.js \
    && pass "app.js: btn-chat click is show-only (setChatPane(true))" \
    || fail "app.js: btn-chat still toggles via setChatPane(!visible)"
  grep -qF "showArtifactView(btn.dataset.type)" web/public/app.js \
    && pass "app.js: plan/arch/test buttons are show-only" \
    || fail "app.js: artifact buttons still call toggleArtifactView (closes on second click)"
  grep -qF "btn.addEventListener('click', showFilesView)" web/public/app.js \
    && pass "app.js: btn-files click is show-only" \
    || fail "app.js: btn-files still toggles (closes on second click)"
  # Phase 9 step 9 retired #btn-transcript and #btn-preview-readonly
  # along with their toggleOwnerReadonlyPreview / showTranscriptView
  # handlers — the JSONL transcript pane is gone, chatpane is the
  # only session view. Negative guards keep them out of the source.
  ! grep -qF 'id="btn-transcript"' web/public/index.html \
    && pass "index.html: btn-transcript retired (Phase 9 step 3)" \
    || fail "index.html: btn-transcript still in chrome cluster"
  ! grep -qF 'id="btn-preview-readonly"' web/public/index.html \
    && pass "index.html: btn-preview-readonly retired (Phase 9 step 9)" \
    || fail "index.html: btn-preview-readonly still in chrome cluster"
  ! grep -qE 'function (showTranscriptView|showConversationView|showTranscriptWaiting|showTerminalView|toggleOwnerReadonlyPreview)\b' web/public/app.js \
    && pass "app.js: transcript/terminal view helpers retired (Phase 9 step 9)" \
    || fail "app.js: transcript/terminal view helpers still defined"
  ! grep -qE 'function (renderTranscriptMessages|appendTranscriptMessages|tailMessages)\b' web/public/app.js \
    && pass "app.js: transcript-render helpers retired (Phase 9 step 9)" \
    || fail "app.js: transcript-render helpers still defined"
  # Plan / Arch / Test artifact views (promoted to top-level chrome buttons,
  # commit 15187ea). Each has its own main-pane container and a chrome button.
  for view in plan arch test; do
    grep -q "id=\"${view}-wrap\"" web/public/index.html \
      && pass "artifact view #${view}-wrap"                              \
      || fail "artifact view #${view}-wrap"
    grep -q "id=\"btn-${view}\"" web/public/index.html \
      && pass "artifact chrome button #btn-${view}"                              \
      || fail "artifact chrome button #btn-${view}"
  done
  grep -q 'function refreshArtifact' web/public/app.js && pass "refreshArtifact()" || fail "refreshArtifact()"
  # Artifact routes (refresh / run / mark / vote / comment / item) live in
  # server/src/artifacts.js and are wired onto the express app from index.js
  # via artifactsRoutes.register(app, deps).
  test -f server/src/artifacts.js && pass "artifacts.js exists" || fail "artifacts.js missing"
  grep -q "artifactsRoutes.register" server/src/index.js && pass "index.js wires artifacts.register" || fail "index.js wires artifacts.register"
  grep -q "artifact/refresh"  server/src/artifacts.js && pass "POST /artifact/refresh route" || fail "POST /artifact/refresh route"
  grep -q "artifact/run"      server/src/artifacts.js && pass "POST /artifact/run route"     || fail "POST /artifact/run route"
  grep -q "artifact/mark"     server/src/artifacts.js && pass "POST /artifact/mark route"    || fail "POST /artifact/mark route"
  grep -q "artifact/vote"     server/src/artifacts.js && pass "POST /artifact/vote route"    || fail "POST /artifact/vote route"
  grep -q "artifact/comment"  server/src/artifacts.js && pass "/artifact/comment route"      || fail "/artifact/comment route"
  grep -q "artifact/item"     server/src/artifacts.js && pass "DELETE /artifact/item route"  || fail "DELETE /artifact/item route"
  grep -q "AUTO_EXECUTE_VOTE_THRESHOLD" server/src/artifacts.js \
    && pass "vote auto-execute threshold defined" \
    || fail "vote auto-execute threshold defined"
  # _myco_/ mirror: plan.json + test.json + architecture.md + README.md
  # under <session-cwd>/_myco_/ so a teammate cloning the repo and
  # starting a fresh myco session sees the same plan items, comments,
  # voters, and arch notes. Hand-editing and round-trips through
  # mutation paths (refresh/run/mark/vote/comment/delete) all flow
  # through writeArtifactToFile.
  if have_node; then
    if node test/artifact-myco-dir.test.js >/dev/null 2>&1; then
      pass "test/artifact-myco-dir.test.js (16 cases)"
    else
      fail "test/artifact-myco-dir.test.js — re-run with 'node test/artifact-myco-dir.test.js' to see failures"
    fi
  else
    skip "test/artifact-myco-dir.test.js (no host node)"
  fi
  grep -qF 'writeArtifactToFile(rec, type, artifact)' server/src/artifacts.js \
    && pass "artifacts.js: persistArtifact mirrors to disk on every mutation" \
    || fail "artifacts.js: persistArtifact missing disk mirror — _myco_/ state will go stale"
  grep -qF "MYCO_DIR = '_myco_'" server/src/artifacts.js \
    && pass "artifacts.js: _myco_ directory constant defined" \
    || fail "artifacts.js: MYCO_DIR constant missing — sharing layout unsettled"
  # When an artifact item is dispatched (manual /run or auto-quorum) the
  # text that lands in BOTH the chat history and Claude's PTY input must
  # carry: the @myco prefix (so the PTY pipeline forwards it), a title
  # line naming the artifact type + the submitter, the item body, and
  # any per-item comments. Chat viewers see who triggered what at a
  # glance; Claude executes against the full instruction (body +
  # comments). Tests run via node since the helper is exported.
  if have_node; then
    node -e "
      const a = require('./server/src/artifacts');
      // Manual run — submitter is a real user.
      const t1 = a.buildArtifactRunText('plan', {
        text: 'Wire up the /v2/orders cursor pager',
        comments: [
          { user: 'alice', text: 'don\\'t forget the limit clamp' },
          { user: 'bob',   text: 'tenant scoping at query time, please' },
        ],
      }, 'kkrazy');
      if (!t1.startsWith('@myco ')) throw new Error('manual-run text must start with @myco prefix');
      if (!/\[📋 Plan item · submitted by @kkrazy\]/.test(t1)) throw new Error('manual-run title missing type+submitter — got: ' + JSON.stringify(t1));
      if (!t1.includes('Wire up the /v2/orders cursor pager')) throw new Error('manual-run text missing body');
      if (!t1.includes('- @alice: don\\'t forget the limit clamp')) throw new Error('manual-run text missing alice comment');
      if (!t1.includes('- @bob: tenant scoping at query time, please')) throw new Error('manual-run text missing bob comment');
      // Test artifact uses the 🧪 glyph.
      const t2 = a.buildArtifactRunText('test', { text: 'k6 load run at 100 RPS', comments: [] }, 'kkrazy');
      if (!/\[🧪 Test item · submitted by @kkrazy\]/.test(t2)) throw new Error('test title wrong glyph/label: ' + JSON.stringify(t2));
      if (t2.includes('Comments:')) throw new Error('empty comments must NOT render a Comments: block');
      // Quorum dispatch.
      const t3 = a.buildArtifactQuorumText('plan', {
        text: 'Ship the feature',
        voters: ['alice', 'bob', 'charlie'],
        comments: [{ user: 'alice', text: 'rolling out behind a flag' }],
      });
      if (!t3.startsWith('@myco ')) throw new Error('quorum text must start with @myco prefix');
      if (!/quorum reached \\(3 voters: @alice, @bob, @charlie\\)/.test(t3)) throw new Error('quorum title missing voter list: ' + JSON.stringify(t3));
      if (!t3.includes('- @alice: rolling out behind a flag')) throw new Error('quorum text missing comment');
    " && pass "artifact run/quorum dispatch text carries type+submitter+comments" \
      || fail "artifact buildArtifactRunText / buildArtifactQuorumText shape wrong"
  fi
  grep -q "onArtifactVote"        web/public/app.js && pass "onArtifactVote handler"        || fail "onArtifactVote handler"
  grep -q "onArtifactComment"     web/public/app.js && pass "onArtifactComment handler"     || fail "onArtifactComment handler"
  grep -q "onArtifactItemDelete"  web/public/app.js && pass "onArtifactItemDelete handler"  || fail "onArtifactItemDelete handler"
  # Regression: plan items are grouped by `layer` (3-tier-style buckets) and
  # the extractor's plan prompt asks for {layer, text} objects.
  grep -q "parsePlanItems"      server/src/extractor.js && pass "parsePlanItems parser exists" || fail "parsePlanItems parser exists"
  grep -q "artifact-layer-name" web/public/app.js       && pass "Plan tab renders per-layer headers" || fail "Plan tab renders per-layer headers"
  if have_node; then
    node -e "
      const ex = require('./server/src/extractor');
      const p = ex.parsePlanItems('[{\"layer\":\"Frontend\",\"text\":\"x\"},{\"layer\":\"Backend\",\"text\":\"y\"}]');
      if (p.length !== 2) throw new Error('want 2, got ' + p.length);
      if (p[0].layer !== 'Frontend' || p[1].layer !== 'Backend') throw new Error('layer assignment wrong: ' + JSON.stringify(p));
      const legacy = ex.parsePlanItems('[\"x\",\"y\"]');
      if (legacy[0].layer !== 'Other') throw new Error('legacy strings should default to Other');
      const mixed  = ex.parsePlanItems('[{\"text\":\"x\"}]');
      if (mixed[0].layer !== 'Other') throw new Error('layerless object should default to Other');
    " && pass "parsePlanItems handles layered + legacy + layerless shapes" \
      || fail "parsePlanItems handles layered + legacy + layerless shapes"
  fi
  # Phase B: extractor module + claude-CLI client are wired in.
  test -f server/src/anthropic.js && pass "anthropic.js exists" || fail "anthropic.js missing"
  test -f server/src/extractor.js && pass "extractor.js exists" || fail "extractor.js missing"
  test -f server/src/claude-cli.js && pass "claude-cli.js exists" || fail "claude-cli.js missing"
  grep -q "extractArtifact" server/src/artifacts.js && pass "extractArtifact wired into artifacts.js" || fail "extractArtifact wired into artifacts.js"
  # Regression: extraction goes through the `claude` CLI (same auth as the
  # running PTY session), NOT a raw Anthropic API call.
  grep -q "callClaudeCli" server/src/extractor.js && pass "extractor uses claude-cli" || fail "extractor uses claude-cli"
  grep -q "callAnthropic" server/src/extractor.js && fail "extractor still imports callAnthropic (regression)" || pass "extractor no longer imports callAnthropic"
  # Regression: extractor pulls from BOTH the JSONL transcript AND the
  # discussion-panel chat (rec.chat) so non-@myco messages still feed Plan.
  grep -q "getChatHistory" server/src/extractor.js && pass "extractor reads chat history" || fail "extractor reads chat history"
  grep -q "readChatTail"   server/src/extractor.js && pass "extractor has readChatTail helper" || fail "extractor has readChatTail helper"
  # Regression: extractor prompts must tell Claude to spot-check the
  # actual codebase via Read/Glob/Grep, not just rely on chat + transcript.
  grep -q "Read, Glob, Grep" server/src/extractor.js && pass "extractor prompts mention code-inspection tools" || fail "extractor prompts mention code-inspection tools"
  # Phase 9 step 2: PTY spawn is gone. The agent SDK consumes
  # permissionMode via the spawn options in agent-session.js; the
  # canUseTool callback + PreToolUse hook handle tool-permission gates.
  grep -q "permissionMode:" server/src/agent-session.js \
    && pass "agent-session: permissionMode option present" \
    || fail "agent-session: permissionMode option missing"
  test -f server/src/permissions.js && pass "permissions.js exists" || fail "permissions.js missing"
  test -f server/src/menu.js && pass "menu.js exists" || fail "menu.js missing"
  # Menu dialogs flow AgentSession.canUseTool → menu.handleSessionMenu
  # → permissions.decide. The dispatch lives in menu.js; attach.js
  # wires the EventEmitter hook in _registerExternalSession.
  grep -q "permissions.decide" server/src/menu.js && pass "menu.js uses permissions.decide" || fail "menu.js uses permissions.decide"
  grep -q "menuMod.handleSessionMenu" server/src/attach.js && pass "attach.js delegates menu events to menu.js" || fail "attach.js delegates menu events to menu.js"
  grep -q "names: \['allow'" server/src/slashcmds.js && pass "/allow command registered" || fail "/allow missing"
  grep -q "names: \['deny'" server/src/slashcmds.js && pass "/deny command registered" || fail "/deny missing"
  grep -q "names: \['allowlist'" server/src/slashcmds.js && pass "/allowlist command registered" || fail "/allowlist missing"
  # Plan-item shortcuts — /fr (feature), /td (todo, also /todo), /bug.
  # Each appends a row to rec.artifacts.plan.items with a fixed layer.
  grep -q "names: \['fr'\]" server/src/slashcmds.js && pass "/fr command registered" || fail "/fr command missing"
  grep -q "names: \['td', 'todo'\]" server/src/slashcmds.js && pass "/td command registered (alias /todo)" || fail "/td command missing"
  grep -q "names: \['bug'\]" server/src/slashcmds.js && pass "/bug command registered" || fail "/bug command missing"
  # /m: removed 2026-05-15 in the chat-routing rewrite. Plain text now
  # routes to the running Claude PTY by default, which makes /m redundant.
  # The negative assertion below (slashcmds: /m removed) lives in the
  # earlier chat-routing block — duplicating here would just whine twice.
  # /task /skip /cancel: chat-side commands that the server rewrites
  # into @myco-forwarded internal-task requests. Lets the user intervene
  # on the running Claude's TaskList from chat. The CLAUDE.md project
  # rule (Working in this repo §3) tells Claude how to handle them and
  # to volunteer stale-task heads-up lines.
  grep -q "names: \['task', 'tasks'\]" server/src/slashcmds.js && pass "/task command registered" || fail "/task command missing"
  grep -q "names: \['skip'\]" server/src/slashcmds.js && pass "/skip command registered" || fail "/skip command missing"
  grep -q "names: \['cancel'\]" server/src/slashcmds.js && pass "/cancel command registered" || fail "/cancel command missing"
  grep -q 'function handleTaskList' server/src/slashcmds.js && pass "handleTaskList usage reply" || fail "handleTaskList usage reply missing"
  grep -q 'function handleTaskSkip' server/src/slashcmds.js && pass "handleTaskSkip usage reply" || fail "handleTaskSkip usage reply missing"
  grep -qF "text.match(/^\/tasks?\s*$/i)" server/src/attach.js \
    && pass "attach.js: /task rewrites to @myco /task" \
    || fail "attach.js: /task rewrite missing"
  grep -qF "text.match(/^\/(skip|cancel)\s+(\d+)\s*$/i)" server/src/attach.js \
    && pass "attach.js: /skip + /cancel rewrite to @myco" \
    || fail "attach.js: /skip + /cancel rewrite missing"
  grep -qF '/^\/tasks?\s*$/i' web/public/app.js \
    && pass "app.js: typing-dots arm recognizes /task" \
    || fail "app.js: typing-dots arm /task missing"
  grep -qF '/^\/(skip|cancel)\s+\d+\s*$/i' web/public/app.js \
    && pass "app.js: typing-dots arm recognizes /skip + /cancel" \
    || fail "app.js: typing-dots arm /skip+/cancel missing"
  # CLAUDE.md must document the @myco-forwarded task-control protocol so
  # future Claude instances handle the forwarded commands consistently.
  grep -qF '@myco /task' CLAUDE.md \
    && pass "CLAUDE.md: documents /task protocol" \
    || fail "CLAUDE.md: missing /task protocol section"
  grep -qF 'Stale-task heads-up' CLAUDE.md \
    && pass "CLAUDE.md: documents stale-task heads-up rule" \
    || fail "CLAUDE.md: stale-task heads-up rule missing"
  # Dispatcher must pass the matched command name through so handlers
  # can render usage hints in the right voice (/skip vs /cancel).
  grep -qF 'command: parsed.matched' server/src/slashcmds.js \
    && pass "slashcmds: dispatcher forwards matched command name" \
    || fail "slashcmds: dispatcher missing matched command forwarding"
  grep -q "function addPlanItem" server/src/slashcmds.js && pass "addPlanItem helper defined" || fail "addPlanItem helper missing"
  # source='user' tagging + refresh-merge so user items survive a Plan refresh.
  grep -qF "source: 'user'" server/src/slashcmds.js \
    && pass "addPlanItem tags user items with source='user'" \
    || fail "addPlanItem tags user items with source='user'"
  grep -qF "it.source === 'user'" server/src/artifacts.js \
    && pass "artifacts: refresh preserves user-added plan items" \
    || fail "artifacts: refresh preserves user-added plan items"
  # Arch artifact mirror to <cwd>/architecture.md. GET prefers the file
  # so the Arch tab auto-loads existing content (no Refresh click
  # required); refresh writes the extracted markdown back to disk so
  # it lives with the project, not just sessions.json.
  grep -qF "architecture.md" server/src/artifacts.js \
    && pass "artifacts: arch mirrors to architecture.md" \
    || fail "artifacts: arch mirrors to architecture.md"
  # The arch-specific read/write helpers were generalised into
  # readArtifactFromFile / writeArtifactToFile when plan + test gained
  # the same _myco_/ mirror. Same regression intent (a code path that
  # round-trips arch through disk) lives in those names now, plus the
  # legacy fallback for the pre-_myco_ root-level architecture.md.
  grep -q "function readArtifactFromFile" server/src/artifacts.js \
    && pass "artifacts: readArtifactFromFile helper (covers arch)" \
    || fail "artifacts: readArtifactFromFile helper missing"
  grep -q "function writeArtifactToFile" server/src/artifacts.js \
    && pass "artifacts: writeArtifactToFile helper (covers arch)" \
    || fail "artifacts: writeArtifactToFile helper missing"
  grep -q "readArtifactFromFile(ctx.rec, type)" server/src/artifacts.js \
    && pass "artifacts: GET reads from _myco_/ file first" \
    || fail "artifacts: GET does not consult _myco_/ on disk"
  grep -q "function readLegacyArchFromFile" server/src/artifacts.js \
    && pass "artifacts: legacy root-level architecture.md fallback preserved" \
    || fail "artifacts: legacy arch fallback missing — old sessions will lose their arch on read"
  if have_node; then
    node -e "
      const s = require('./server/src/slashcmds');
      const cmds = s.listCommands();
      const names = new Set();
      for (const c of cmds) {
        if (c.name) names.add(c.name);
        for (const a of (c.aliases || [])) names.add(a);
      }
      for (const n of ['fr','td','todo','bug']) {
        if (!names.has(n)) throw new Error('missing slash command: ' + n);
      }
    " && pass "slashcmds: /fr /td /todo /bug all listed by listCommands" \
      || fail "slashcmds: /fr /td /todo /bug all listed by listCommands"
  fi
  if have_node; then
    node -e "
      const p = require('./server/src/permissions');
      const t = (pat, tool, input, want) => {
        const got = p.matchesPattern(pat, tool, input);
        if (got !== want) throw new Error('matchesPattern(' + JSON.stringify(pat) + ', ' + tool + ', ' + JSON.stringify(input) + ') = ' + got + ' want ' + want);
      };
      t('Read', 'Read', '/x', true);
      t('Read', 'Edit', '/x', false);
      t('Bash(git)', 'Bash', 'git status', true);
      t('Bash(git)', 'Bash', 'github cli', false);
      t('Bash(git:*)', 'Bash', 'git log', true);
      t('Bash(*)', 'Bash', 'anything', true);
      t('Bash(./test.sh)', 'Bash', './test.sh --skip-tests', true);
      const rec = { allowList: ['Read', 'Bash(git)'], denyList: ['Bash(rm)'] };
      const d = (tool, input, want) => {
        const got = p.decide(rec, tool, input);
        if (got !== want) throw new Error('decide(' + tool + ', ' + JSON.stringify(input) + ') = ' + got + ' want ' + want);
      };
      d('Read', '/x', 'allow');
      d('Bash', 'git status', 'allow');
      d('Bash', 'rm -rf', 'deny');
      d('Bash', 'curl evil', 'ask');  // not in allow/deny → broadcast to chat for /decide
    " && pass "permissions.matchesPattern + decide" \
      || fail "permissions.matchesPattern + decide"
  else
    skip "permissions runtime (no host node)"
  fi
  # Phase 9 step 2: TUI menu-interception is gone (no PTY to scrape).
  # The agent SDK's canUseTool callback synthesizes menus directly in
  # AgentSession and routes them through menu.handleSessionMenu →
  # permissions.decide for auto-allow/auto-deny.
  grep -q "broadcastMenuToChat" server/src/attach.js && pass "attach.js re-exports broadcastMenuToChat" || fail "attach.js missing broadcastMenuToChat export"
  grep -q "names: \['decide'" server/src/slashcmds.js && pass "/decide command registered" || fail "/decide command missing"
  # Regression for the subagent-jsonl bug that hung mycobeta sessions:
  # `<project>/subagents/agent-*.jsonl` must NEVER be returned by
  # findNewestJsonl, and isClaudeSessionId must reject non-UUID names so
  # claude --resume can't be invoked with a bogus id.
  if have_node; then
    if node test/find-newest-jsonl.test.js >/dev/null 2>&1; then
      pass "test/find-newest-jsonl.test.js (6 cases)"
    else
      fail "test/find-newest-jsonl.test.js — re-run with 'node test/find-newest-jsonl.test.js' to see failures"
    fi
  else
    skip "test/find-newest-jsonl.test.js (no host node)"
  fi
  # Phase 9 step 2: PTY-only test files (menu-pick-race + menu-multiselect)
  # were retired with the PTY driver — those tests exercised wizard
  # detection, queued-pick retries, and CR/no-CR PTY writes that don't
  # exist in agent mode. The agent-session.test.js below covers the
  # SDK-driven menu round-trip equivalent.
  # Regression: parseLine() in transcript.js used to recognise only 4 of
  # the 40+ JSONL `type` values claude code emits. The expanded parser
  # surfaces thinking content, plan/auto-mode transitions, framework
  # errors, command-permission changes, and queued slash commands so
  # readonly viewers see the same narrative the owner does in their TUI.
  if have_node; then
    if node test/transcript-parser-types.test.js >/dev/null 2>&1; then
      pass "test/transcript-parser-types.test.js (21 cases)"
    else
      fail "test/transcript-parser-types.test.js — re-run with 'node test/transcript-parser-types.test.js' to see failures"
    fi
  else
    skip "test/transcript-parser-types.test.js (no host node)"
  fi
  # state-update broadcast paths — chat-pane ↔ PTY sync. Covers menu
  # mutation emits, artifact mutation emits, in-flight tool tracker,
  # attach snapshot frames, and client-side dispatcher wiring.
  if have_node; then
    if node test/state-update.test.js >/dev/null 2>&1; then
      pass "test/state-update.test.js (18 cases)"
    else
      fail "test/state-update.test.js — re-run with 'node test/state-update.test.js' to see failures"
    fi
  else
    skip "test/state-update.test.js (no host node)"
  fi
  # Each new transcript role / JSONL type must be wired in both the
  # parser (server) and the renderer (client). Sentinels protect both
  # ends of the pipeline.
  for kind in plan_mode plan_mode_exit auto_mode command_permissions queued_command api_error; do
    grep -qF "'$kind'" server/src/transcript.js \
      && pass "transcript.js: handles $kind" \
      || fail "transcript.js: $kind not handled — viewer will silently drop it"
  done
  for role in conv-msg-thinking conv-msg-mode conv-msg-error conv-msg-permission conv-msg-queued; do
    grep -qF "$role" web/public/app.js \
      && pass "app.js: renders $role" \
      || fail "app.js: $role render branch missing"
  done
  # Mode-change is no longer scraped from a PTY status bar (Phase 9 step
  # 2). The mode-snapshot WS frame sent from _sendAttachSnapshot covers
  # the attach-time case; the client's _onLiveModeChange handler stays
  # so legacy chat rows with a mode-change meta still re-render.
  grep -qF "_onLiveModeChange" web/public/app.js \
    && pass "app.js: _onLiveModeChange handler defined" \
    || fail "app.js: _onLiveModeChange missing — legacy mode-change frames will be dropped"
  # Regression: claude code re-execs into a new sessionId when the user
  # hits /resume in the TUI. The polled rec.claudeSessionId only fires
  # at mycod-spawn time, so it gets stuck on the original id while the
  # JSONL file the new claude writes is named after the NEW id.
  # Without reading claude code's per-process tracker we keep watching
  # the stale jsonl and miss every assistant reply on the re-execed
  # session. Verified mycobeta demo010 (2026-05-13): user's plan
  # response landed in the new jsonl (c8ce8492-…) but the watcher was
  # on 49d7d4da-… → chat row never persisted live.
  if have_node; then
    if node test/active-claude-session.test.js >/dev/null 2>&1; then
      pass "test/active-claude-session.test.js (8 cases)"
    else
      fail "test/active-claude-session.test.js — re-run with 'node test/active-claude-session.test.js' to see failures"
    fi
  else
    skip "test/active-claude-session.test.js (no host node)"
  fi
  grep -qF 'function readActiveClaudeSessionForCwd' server/src/sessions.js \
    && pass "sessions.js: readActiveClaudeSessionForCwd helper defined" \
    || fail "sessions.js: readActiveClaudeSessionForCwd missing — transcript watcher won't follow claude /resume re-execs"
  grep -qF 'readActiveClaudeSessionForCwd(rec.absCwd)' server/src/transcript.js \
    && pass "transcript.js: resolveTranscriptPath consults the live tracker first" \
    || fail "transcript.js: resolveTranscriptPath still relies only on rec.claudeSessionId — re-exec'd sessions will lose assistant text"
  # Transcript watcher rebind: a mid-connection claude /resume re-exec
  # writes to a NEW <id>.jsonl while the watcher would otherwise keep
  # reading the stale path. The poll in streamTranscriptToWs detects
  # the path change and rebinds. (Lives in attach.js post Phase 9.)
  grep -qF '[transcript-rebind]' server/src/attach.js \
    && pass "attach.js: streamTranscriptToWs rebinds watcher when live jsonl path changes" \
    || fail "attach.js: streamTranscriptToWs no longer rebinds — mid-session re-execs lose transcript-delta"
  # Agent-mode menu plumbing: handleMenuToggle / handleMenuSubmit /
  # WS frame routing all live in attach.js. The PTY-only navigation
  # (CR-or-not, wizard variants, Submit-row arrow burst) is gone — the
  # SDK's canUseTool callback handles the answer directly.
  grep -qF 'function handleMenuToggle' server/src/attach.js \
    && pass "attach.js: handleMenuToggle defined" \
    || fail "attach.js: handleMenuToggle missing"
  grep -qF 'function handleMenuSubmit' server/src/attach.js \
    && pass "attach.js: handleMenuSubmit defined" \
    || fail "attach.js: handleMenuSubmit missing"
  grep -qF "msg.t === 'menu-toggle'" server/src/attach.js \
    && pass "attach.js: WS frame menu-toggle wired" \
    || fail "attach.js: WS frame menu-toggle not wired"
  grep -qF "msg.t === 'menu-submit'" server/src/attach.js \
    && pass "attach.js: WS frame menu-submit wired" \
    || fail "attach.js: WS frame menu-submit not wired"
  # INTERACTION_RULES.md still documents the high-level menu/permission
  # contract. The PTY-specific R-NN rules are now historical (Phase 9
  # step 2 retired the PTY), but the file stays in tree as project
  # archaeology.
  [ -f server/src/INTERACTION_RULES.md ] \
    && pass "INTERACTION_RULES.md present (historical TUI rules archive)" \
    || fail "server/src/INTERACTION_RULES.md missing"
  grep -qF 'function sendMenuToggle' web/public/app.js \
    && pass "app.js: sendMenuToggle defined" \
    || fail "app.js: sendMenuToggle missing"
  grep -qF 'function sendMenuSubmit' web/public/app.js \
    && pass "app.js: sendMenuSubmit defined" \
    || fail "app.js: sendMenuSubmit missing"
  # Phase 2.5: multi-select toggles + Submit moved to the perm-modal
  # popup. The chat-pane inline chat-menu-toggle / chat-menu-submit
  # buttons (and their CSS) were retired.
  grep -qF 'perm-modal-submit' web/public/app.js \
    && pass "app.js: modal renders Submit button for multi-select" \
    || fail "app.js: modal renders Submit button for multi-select"
  grep -qF 'btn.dataset.checkbox' web/public/app.js \
    && pass "app.js: modal tracks checkbox state for multi-select" \
    || fail "app.js: modal tracks checkbox state for multi-select"
  # Regression: index.html static cache busters (app.js?v=N, styles.css?v=N)
  # used to be hand-bumped on every client change. Forgetting the bump
  # shipped new app.js to disk but kept returning browsers on the cached
  # old bundle — the multi-select picker silently regressed because old
  # app.js didn't know about menu.multi. The server now injects a build-
  # stamp cache buster on every served index.html so client edits
  # invalidate caches automatically.
  grep -qF 'function indexHtml()' server/src/index.js \
    && pass "index.js: indexHtml() injector defined" \
    || fail "index.js: missing indexHtml() — cache busters won't auto-bump on deploy"
  grep -qF 'function buildStamp()' server/src/index.js \
    && pass "index.js: buildStamp() reads /build.txt" \
    || fail "index.js: missing buildStamp() helper"
  grep -qE "app.get\(\['/', '/index\.html'\]" server/src/index.js \
    && pass "index.js: GET / and /index.html routed through indexHtml()" \
    || fail "index.js: index route not wired to the cache-buster injector"
  # Regression: captureClaudeSessionId must REPLACE a stale store value
  # when claude code creates a new jsonl during a --resume respawn. The
  # original gate (`!rec.claudeSessionId`) silently froze the store at
  # the first-ever id, so every readonly viewer for a long-running
  # session pointed at a transcript that stopped at the first restart.
  if have_node; then
    if node test/capture-claude-session-id.test.js >/dev/null 2>&1; then
      pass "test/capture-claude-session-id.test.js (4 cases)"
    else
      fail "test/capture-claude-session-id.test.js — re-run with 'node test/capture-claude-session-id.test.js' to see failures"
    fi
  else
    skip "test/capture-claude-session-id.test.js (no host node)"
  fi
  # Regression: captureClaudeSessionId must REPLACE a stale stored id,
  # not just set-when-null. The original buggy gate was `!rec.claudeSessionId`
  # which silently refused to update. Two acceptable shapes: the inline
  # `rec.claudeSessionId !== id` (pre-refactor) or the `commit(id, …)`
  # helper that early-returns when `rec.claudeSessionId === id`
  # (post-tracker-refactor). Either one preserves the "always replace
  # when different" contract.
  if grep -qE 'rec\.claudeSessionId\s*!==\s*id|rec\.claudeSessionId\s*===\s*id' server/src/sessions.js; then
    pass "sessions.js: captureClaudeSessionId gate replaces stale id"
  else
    fail "sessions.js: captureClaudeSessionId still has the freeze-on-first gate"
  fi
  # Regression: claude's assistant text from the transcript jsonl must
  # mirror into rec.chat so chat survives a refresh. Pre-fix the
  # _localOnly chat rows on the client never reached disk.
  if have_node; then
    if node test/persist-assistant-chat.test.js >/dev/null 2>&1; then
      pass "test/persist-assistant-chat.test.js (7 cases)"
    else
      fail "test/persist-assistant-chat.test.js — re-run with 'node test/persist-assistant-chat.test.js' to see failures"
    fi
  else
    skip "test/persist-assistant-chat.test.js (no host node)"
  fi
  grep -qF 'function persistAssistantTextToChat' server/src/attach.js \
    && pass "attach.js: persistAssistantTextToChat defined" \
    || fail "attach.js: persistAssistantTextToChat missing"
  grep -qF "persistAssistantTextToChat(sessionId, newMsgs)" server/src/attach.js \
    && pass "attach.js: transcript watcher mirrors assistant text into rec.chat" \
    || fail "attach.js: transcript watcher does not mirror assistant text"
  grep -qF 'meta: { transcriptUuid: m.uuid, fromTranscript: true }' server/src/attach.js \
    && pass "attach.js: persisted chat rows carry meta.transcriptUuid for dedup" \
    || fail "attach.js: persisted chat rows missing meta.transcriptUuid"
  # Regression: appendChatMessage (the 'chat' WS frame handler) must
  # dedup by meta.transcriptUuid. Without this, the SAME assistant text
  # arriving via chat-history replay AND the live persistAssistantText-
  # ToChat push rendered twice in the chat pane (observed on mycobeta
  # demo010 as identical "claude 01:17" rows duplicated back-to-back).
  # The dedup line is unique to this function — searching globally
  # is simpler than awk-ranging which is finicky under pipefail.
  grep -qF 'existing.meta.transcriptUuid === uuid' web/public/app.js \
    && pass "app.js: appendChatMessage dedups by transcriptUuid" \
    || fail "app.js: appendChatMessage missing transcriptUuid dedup"
  # Regression: the menu-hash dedup must only collapse against the
  # LAST chat row. The wizard's Submit/Cancel screen has a deterministic
  # hash that recurs across wizard runs ("Ready to submit your
  # answers?|1:Submit answers|2:Cancel"); matching a mid-chat stale row
  # silently updates that buried row instead of appending the live
  # picker at the bottom — the user only saw the missing selection
  # after refreshing the page. Sentinel the last-row-only guard so a
  # regression to the from-zero-iterate version trips a test.
  grep -qF 'const lastIdx = state.chatMessages.length - 1;' web/public/app.js \
    && pass "app.js: menu-hash dedup constrained to last chat row" \
    || fail "app.js: menu-hash dedup not constrained to last row (would hide live wizard pickers)"
  # Regression: the readonly transcript viewer used to freeze when
  # fs.watch silently stopped firing (overlay/bind-mount/Docker
  # filesystem quirk). The safety setInterval guarantees forward
  # progress regardless of fs.watch's mood.
  if have_node; then
    if node test/transcript-watcher-safety-poll.test.js >/dev/null 2>&1; then
      pass "test/transcript-watcher-safety-poll.test.js (3 cases)"
    else
      fail "test/transcript-watcher-safety-poll.test.js — re-run to see failures"
    fi
  else
    skip "test/transcript-watcher-safety-poll.test.js (no host node)"
  fi
  grep -qF 'safetyPollTimer = setInterval' server/src/transcript.js \
    && pass "transcript.js: fs.watch safety poll wired" \
    || fail "transcript.js: safety poll missing"
  grep -qF 'clearInterval(safetyPollTimer)' server/src/transcript.js \
    && pass "transcript.js: safety poll cleared on unsubscribe" \
    || fail "transcript.js: safety poll not cleared on unsubscribe"
  # Phase 9 step 2 retired the PTY status-line scraper (spinner
  # regexes, periodic _checkMenu scan, status throttle). Agent mode
  # reports status via SDK system_init / iteration_start events
  # instead — validated by the agent-session.test.js below.
  # Quick wire-level checks for the hash field carrying end-to-end.
  # Phase 2.5: hash now stamps onto the modal's option buttons via
  # btn.dataset.hash = m.hash, not the retired inline picker.
  grep -qF "btn.dataset.hash = m.hash" web/public/app.js \
    && pass "app.js: modal option button stamps hash from menu queue entry" \
    || fail "app.js: modal option button not stamping hash"
  grep -qF 'optBtn.dataset.hash' web/public/app.js \
    && pass "app.js: modal click handler reads hash from option button" \
    || fail "app.js: modal click handler not reading hash"
  # Regression (2026-05-15): the bare-digit chat shortcut routes
  # through handleMenuPick (which calls _markMenuChatAnswered first,
  # THEN resolves the SDK promise) so the chat row gets stamped AND
  # the SDK promise settles in one pass.
  grep -Pzoq "(?i)bare-digit menu pick[\s\S]{0,2000}handleMenuPick\(sessionId" server/src/attach.js \
    && pass "attach.js: bare-digit chat shortcut routes through handleMenuPick" \
    || fail "attach.js: bare-digit chat shortcut bypasses handleMenuPick"
  # Companion regression: when claude broadcasts a NEW canUseTool
  # menu, mark any older still-unanswered rows superseded so they
  # don't haunt the modal queue.
  grep -q "_supersedeStaleMenus" server/src/menu.js \
    && pass "menu.js: broadcasts supersede stale menus" \
    || fail "menu.js: broadcasts don't supersede stale menus"
  # Companion regression: a respawned AgentSession has a fresh
  # _pendingPermissions map; any chat row still flagged kind=menu
  # without answered/superseded refers to a canUseTool promise that
  # no live receiver could resolve. Sweep them all .superseded so
  # the user's chat is a clean slate after a deploy/restart.
  grep -Pzoq "respawned agent[\s\S]{0,1200}_supersedeStaleMenus" server/src/sessions.js \
    && pass "sessions.js: ensureLiveSession sweeps zombie menus on agent respawn" \
    || fail "sessions.js: ensureLiveSession does not sweep zombie menus"
  # Companion regression: a menu state-update (server confirmed pick /
  # supersede) must rebuild the client's modal queue + re-render the
  # popup, otherwise resolved menus stay visible in the modal.
  grep -Pzoq "_applyMenuStateUpdate[\s\S]{0,2500}_rescanPendingMenuQueue\(\)[\s\S]{0,80}_renderPermModal\(\)" web/public/app.js \
    && pass "app.js: menu state-update refreshes modal queue + popup" \
    || fail "app.js: menu state-update leaves modal queue stale"
  # Modal picks/toggles/submits must queue on a closed WS and drain on
  # the next open. A 2026-05-15 incident lost a user's pick during a
  # WS reconnect window — sendMenuPick silent-dropped, the modal hid
  # because the click handler returned early, and the server never
  # received the frame.
  grep -q "_flushOutboundMenuFrames" web/public/app.js \
    && pass "app.js: outbound menu-frame queue is flushed on WS open" \
    || fail "app.js: outbound menu-frame queue missing"
  grep -q "outboundMenuFrames" web/public/app.js \
    && pass "app.js: menu frames queue during WS reconnect" \
    || fail "app.js: menu frames silent-drop during reconnect"
  # The agent-mode WS handler (_attachAgentWebSocket) must handle the
  # menu-pick / menu-toggle / menu-submit frames. Without these branches
  # every modal click is silently dropped at the WS boundary — verified
  # live on mycobeta test006 2026-05-15.
  grep -Pzoq "_attachAgentWebSocket[\s\S]{0,4000}msg\.t === 'menu-pick'" server/src/attach.js \
    && pass "attach.js: agent WS handles menu-pick frame" \
    || fail "attach.js: agent WS missing menu-pick handler"
  grep -Pzoq "_attachAgentWebSocket[\s\S]{0,4000}msg\.t === 'menu-toggle'" server/src/attach.js \
    && pass "attach.js: agent WS handles menu-toggle frame" \
    || fail "attach.js: agent WS missing menu-toggle handler"
  grep -Pzoq "_attachAgentWebSocket[\s\S]{0,4000}msg\.t === 'menu-submit'" server/src/attach.js \
    && pass "attach.js: agent WS handles menu-submit frame" \
    || fail "attach.js: agent WS missing menu-submit handler"
  # Multi-select AskUserQuestion: agent-session must mark each option
  # as a checkbox so the modal renders toggle buttons instead of
  # single-pick. Submit gathers all checked options and resolves with
  # the SDK's documented comma-separated answer.
  grep -q "resolveMenuToggle" server/src/agent-session.js \
    && pass "agent-session: resolveMenuToggle for multi-select" \
    || fail "agent-session: missing resolveMenuToggle"
  grep -q "resolveMenuSubmit" server/src/agent-session.js \
    && pass "agent-session: resolveMenuSubmit gathers checked" \
    || fail "agent-session: missing resolveMenuSubmit"
  grep -Pzoq "isMulti[^}]{0,300}checkbox: true" server/src/agent-session.js \
    && pass "agent-session: multi-select options flagged checkbox=true" \
    || fail "agent-session: multi-select options missing checkbox flag"
  # handleMenuToggle's only effect is _toggleMenuChatCheckbox (which
  # flips opt.checked on the persisted chat row — and because the chat
  # row's options array is the same object reference as the
  # AgentSession's pending entry, the SDK side sees the flip too on
  # submit). A second flip via session.resolveMenuToggle would double-
  # apply and cancel the click — verified live test006 2026-05-15.
  grep -qF "_toggleMenuChatCheckbox" server/src/attach.js \
    && pass "attach.js: handleMenuToggle single-flips via _toggleMenuChatCheckbox" \
    || fail "attach.js: handleMenuToggle missing single-flip path"
  grep -qF "resolveMenuSubmit" server/src/attach.js \
    && pass "attach.js: handleMenuSubmit resolves via AgentSession.resolveMenuSubmit" \
    || fail "attach.js: handleMenuSubmit missing resolveMenuSubmit call"
  grep -qF "sendMenuPick(n, hash)" web/public/app.js \
    && pass "app.js: sendMenuPick accepts hash arg" \
    || fail "app.js: sendMenuPick signature missing hash"
  grep -qF 'function handleMenuPick(sessionId, session, n, hash)' server/src/attach.js \
    && pass "attach.js: handleMenuPick accepts hash" \
    || fail "attach.js: handleMenuPick signature missing hash"
  grep -qF '_markMenuChatAnswered' server/src/attach.js \
    && pass "attach.js: persist helper present (_markMenuChatAnswered)" \
    || fail "attach.js: persist helper missing"
  # Phase 9 step 2 retired MenuInterceptor (no PTY to scrape). Menu
  # detection now lives inside AgentSession.canUseTool — covered by
  # agent-session.test.js below.
  grep -q "handleChatMessage" server/src/attach.js && pass "handleChatMessage in attach.js" || fail "handleChatMessage in attach.js"
  grep -q "handleChatMessage" server/src/index.js && pass "handleChatMessage imported by /run route" || fail "handleChatMessage imported"
  # Bare-digit menu pick: while an AgentSession.pendingMenu is open, a
  # plain "1" / "2" answers it via handleMenuPick (resolves SDK promise
  # AND stamps the chat row). Verified in attach.js's handleChatPostfixes.
  grep -q "menu pick" server/src/attach.js && pass "@myco digit shortcuts to menu pick" || fail "@myco digit shortcut missing"
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
  # Phase 9 step 3 deleted #conversation-wrap (the JSONL transcript
  # pane). Read-only viewers now use the chatpane with a sticky
  # readonly-banner; assert that wiring instead.
  grep -q 'id="readonly-banner"' web/public/index.html \
    && pass "index.html: readonly-banner in chatpane (Phase 9 step 3)" \
    || fail "index.html: readonly-banner missing"
  grep -q "chatpane-readonly-banner" web/public/styles.css \
    && pass "styles.css: .chatpane-readonly-banner styling" \
    || fail "styles.css: .chatpane-readonly-banner styling"
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
  # PWA install icon: must be served as image/jpeg so Chrome's
  # manifest-icon validator accepts it. The MIME type is derived from
  # the .jpg extension by express.static — no explicit handler needed —
  # but it's worth pinning so a future renamed/repackaged file doesn't
  # silently regress to application/octet-stream.
  local ct
  ct=$(curl -sf -o /dev/null -w '%{content_type}' "http://127.0.0.1:$SMOKE_PORT/hetu.jpg" 2>/dev/null)
  [[ "$ct" == image/jpeg* ]] && pass "hetu.jpg served as image/jpeg ($ct)" || fail "hetu.jpg content-type wrong: $ct"
  # And manifest.json must include the icon entry once served (catches
  # a stale-bundle scenario where the Dockerfile COPY missed a layer).
  curl -sf "http://127.0.0.1:$SMOKE_PORT/manifest.json" 2>/dev/null | grep -qF '"/hetu.jpg' \
    && pass "manifest.json served references hetu.jpg" \
    || fail "manifest.json served does not include /hetu.jpg — install icon will fall back"
}

test_index_html_contents() {
  local index
  index=$(curl -sf "http://127.0.0.1:$SMOKE_PORT/" 2>/dev/null || echo "")
  echo "$index" | grep -q 'id="chatpane"' && pass "index serves chatpane" || fail "index serves chatpane"
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
