#!/usr/bin/env bash
# Smoke test for myco — run before every commit.
set -euo pipefail

# Anchor every command in this script to the repo root, regardless of
# where the caller invoked us from. Lets `./test/test.sh`, `test/test.sh`,
# `bash /abs/path/test/test.sh`, or `cd test && ./test.sh` all behave the
# same. Without this line, the many `grep -q ... web/public/app.js`-style
# relative-path checks below would resolve against the caller's CWD.
# The double-cd-then-pwd pattern is needed because plain
# `cd "$(dirname "$0")/.."` resolves lexically — when $0 is a relative
# path like `./test/test.sh` it appends `/..` to the relative dir and
# `cd`'s into the result, which can land short if the invoking shell's
# cwd isn't where you think it is.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/.."

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
  # Node-based port discovery. Falls back to python or a random high port
  # if node is not on the host's PATH.
  if have_node; then
    node -e "const s = require('net').createServer(); s.listen(0, () => { console.log(s.address().port); s.close(); });"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import socket; s = socket.socket(); s.bind(('', 0)); print(s.getsockname()[1]); s.close()"
  elif command -v python >/dev/null 2>&1; then
    python -c "import socket; s = socket.socket(); s.bind(('', 0)); print(s.getsockname()[1]); s.close()"
  else
    echo $(( 10000 + RANDOM % 50000 ))
  fi
}

# Some checks need a host-side node binary (`node -e "require(...)"`). The
# Docker-based persistence section never needs this — the image bakes node
# in. Hosts without node can still run static + docker tests; we surface
# that those node-dependent slots were skipped instead of marking failed.
SKIP=0
skip()    { SKIP=$((SKIP+1)); echo "  ~ $1 (skipped)"; }
have_node() { command -v node >/dev/null 2>&1; }

# bug-69: portable PCRE matcher. Replaces `grep -Pzoq` (which busybox
# doesn't support — busybox grep has no PCRE engine, fails with
# `grep: unrecognized option: P`) by delegating to Node's RegExp
# engine. Same syntax: \s, \d, (?i), (?s), [\s\S]{0,N} all work
# verbatim. Works on every host where the rest of test.sh runs (node
# >=18 is already a hard dep for node_test_prelaunch + test_npm_deps
# + test_text_utils). Usage:
#   pcre_match "<pattern>" "<file>" && pass "..." || fail "..."
# Return codes: 0 = match, 1 = no match, 2 = unrecoverable (no node /
# invalid regex / unreadable file). The `|| fail` pattern in callers
# treats 1 and 2 identically, matching the prior `grep -P` behavior.
pcre_match() {
  local pattern="$1" file="$2"
  if ! have_node; then return 2; fi
  node -e '
    const fs = require("fs");
    try {
      // PCRE accepts (?i) / (?s) / (?is) as inline-prefix mode flags.
      // JS RegExp does NOT — it requires those as the second-arg
      // flags string. Extract any leading (?<flags>) into a flags
      // string so the patterns from test.sh stay verbatim. Common
      // PCRE flags we honor: i = case-insensitive, s = dotall (. matches \n).
      let pat = process.argv[1];
      let flags = "";
      const m = pat.match(/^\(\?([a-z]+)\)/);
      if (m) {
        const valid = "ims";
        for (const c of m[1]) if (valid.includes(c) && !flags.includes(c)) flags += c;
        pat = pat.slice(m[0].length);
      }
      const re = new RegExp(pat, flags);
      const content = fs.readFileSync(process.argv[2], "utf8");
      process.exit(re.test(content) ? 0 : 1);
    } catch (err) {
      console.error("pcre_match: " + err.message);
      process.exit(2);
    }
  ' "$pattern" "$file"
}

# bug-69: auto-install server/ deps when server/node_modules/ is
# absent. Without this, test_npm_deps (line ~295) + run_server_smoke
# (line ~4313) fail on a fresh checkout because `require.resolve` /
# `require('global-agent/bootstrap')` can't find packages. CLAUDE.md
# §Pre-Commit §1 says "fix the host OR the script first — don't skip
# the suite", so we install on the user's behalf rather than skipping.
# Idempotent: once node_modules + .package-lock.json exist the
# function returns immediately. First-run cost is ~5-10s; cached
# subsequent runs are sub-second.
ensure_server_deps() {
  if [ -d server/node_modules ] && [ -f server/node_modules/.package-lock.json ]; then
    return
  fi
  if ! command -v npm >/dev/null 2>&1; then
    die "ensure_server_deps: npm not on PATH. Install Node >=18 (which ships with npm) before running test.sh."
  fi
  echo "── bug-69 ensure_server_deps: installing server/ deps (first run on this checkout) ──"
  (cd server && npm install --prefer-offline --no-audit --no-fund) || \
    die "ensure_server_deps: npm install failed in server/. Check network / npm registry availability and re-run."
}

# ─── parallel node-test runner ────────────────────────────────────────────────
# Goal: cut wall time by running every test/*.test.js in the background up
# front, then having each call-site read the pre-computed exit code instead
# of blocking on `node …` serially. The slow tests (capture-claude-session-id
# ~65 s, transcript-watcher-safety-poll ~12 s, chat-history-window ~6 s) form
# the long pole; everything else lands in under 1 s and now overlaps with them.
#
# Usage from a check site (replaces `if node test/foo …; then pass …; else fail …; fi`):
#
#   node_test_result test/foo.test.js "test/foo.test.js (N cases)"
#
# The helper returns 0 on pass, 1 on fail (so the caller can keep chaining
# with `&&`/`||` if needed). It calls pass/fail itself so the existing tally
# stays accurate. If the pre-run wasn't done (no host node), it falls back
# to a synchronous `node …` invocation so the script still works on a host
# that gains node mid-run.
NODE_TEST_RESULT_DIR=""

# Fire every test/*.test.js in the background and stash {basename}.exit /
# {basename}.out into a tempdir so call-sites can read the result later.
# Idempotent — second call no-ops.
node_test_prelaunch() {
  if [ -n "$NODE_TEST_RESULT_DIR" ]; then return; fi
  if ! have_node; then return; fi
  NODE_TEST_RESULT_DIR=$(mktemp -d -t myco-node-tests.XXXXXX)
  trap 'rm -rf "$NODE_TEST_RESULT_DIR"' EXIT
  local f
  for f in test/*.test.js; do
    [ -f "$f" ] || continue
    local key
    key=$(basename "$f")
    (
      node "$f" > "$NODE_TEST_RESULT_DIR/$key.out" 2>&1
      echo "$?" > "$NODE_TEST_RESULT_DIR/$key.exit"
    ) &
  done
  # We deliberately do NOT `wait` here — call-sites that need a particular
  # result will block on the .exit file via node_test_result. That lets
  # the static-check phase keep ripping in the foreground while node
  # processes burn cycles in the background.
}

# Return 0 / 1 + emit pass/fail for the given test file.
# Args: <path/to/test.js> <human label>
node_test_result() {
  local f="$1" label="$2"
  if ! have_node; then skip "$label (no host node)"; return 0; fi
  node_test_prelaunch
  local key
  key=$(basename "$f")
  local exit_file="$NODE_TEST_RESULT_DIR/$key.exit"
  # Wait up to 180 s for the background runner to finish this test.
  local waited=0
  while [ ! -f "$exit_file" ]; do
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -gt 180 ]; then
      fail "$label — background runner exceeded 180s budget; re-run with 'node $f'"
      return 1
    fi
  done
  local code
  code=$(cat "$exit_file")
  if [ "$code" = "0" ]; then
    pass "$label"
    return 0
  else
    fail "$label — re-run with 'node $f' to see failures"
    return 1
  fi
}

# Variant for tests that should SKIP on failure rather than fail
# (used by agent-session.test.js — it needs real SDK creds + network
# round-trip; absence of either shouldn't red the suite).
# Args: <path/to/test.js> <pass label> <skip message>
node_test_result_or_skip() {
  local f="$1" pass_label="$2" skip_msg="$3"
  if ! have_node; then skip "$pass_label (no host node)"; return 0; fi
  node_test_prelaunch
  local key
  key=$(basename "$f")
  local exit_file="$NODE_TEST_RESULT_DIR/$key.exit"
  local waited=0
  while [ ! -f "$exit_file" ]; do
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -gt 180 ]; then
      skip "$skip_msg (background runner exceeded 180s budget)"
      return 0
    fi
  done
  local code
  code=$(cat "$exit_file" 2>/dev/null || echo "127")
  if [ "$code" = "0" ]; then
    pass "$pass_label"
  else
    skip "$skip_msg"
  fi
}

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

# bug-69: ensure server/ deps exist BEFORE node_test_prelaunch — some
# tests require modules from server/node_modules to be importable.
ensure_server_deps

# Kick off every test/*.test.js in parallel up front. Each call-site that
# would have done `if node test/foo … fi` now reads the cached exit code
# from the background runner. Wall-time savings: ~20 s on the host-side
# section (long-pole is capture-claude-session-id at ~65 s).
node_test_prelaunch

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
  app_v=$(sed -nE 's/.*app\.js\?v=([0-9]+).*/\1/p' web/public/index.html | head -n 1)
  css_v=$(sed -nE 's/.*styles\.css\?v=([0-9]+).*/\1/p' web/public/index.html | head -n 1)
  test -n "$app_v" && pass "app.js cache buster = v$app_v" || fail "app.js cache buster"
  test -n "$css_v" && pass "styles.css cache buster = v$css_v" || fail "styles.css cache buster"
}

test_pwa_icon() {
  # PWA install icon (mobile Chrome "Add to Home Screen", iOS Safari
  # apple-touch-icon, browser tab favicon) all point at /hetu.png.
  # Without these wired, installing as a Chrome app renders the
  # auto-generated SVG initial — not the brand icon the user expects.
  # Format swapped JPG → transparent PNG so the icon composites cleanly
  # against dark/light home-screen backgrounds.
  test -f web/public/hetu.png \
    && pass "web/public/hetu.png exists" \
    || fail "web/public/hetu.png missing — PWA install will fall back to SVG initial"
  grep -qF '"src": "/hetu.png' web/public/manifest.json \
    && pass "manifest.json: lists hetu.png as an install icon" \
    || fail "manifest.json: hetu.png not referenced"
  grep -qF 'rel="icon"' web/public/index.html \
    && pass "index.html: <link rel=icon> for favicon/tab" \
    || fail "index.html: <link rel=icon> missing"
  grep -qF 'rel="apple-touch-icon"' web/public/index.html \
    && pass "index.html: <link rel=apple-touch-icon> for iOS home screen" \
    || fail "index.html: apple-touch-icon missing — iOS Add to Home Screen uses default"
  # PNG magic-byte sanity: first eight bytes must be 89 50 4E 47 0D 0A 1A 0A.
  # Catches a stray JPEG or HTML at this path that would still satisfy the
  # existence check but render as a broken-image glyph in the install dialog.
  if have_node; then
    node -e "
      const b = require('fs').readFileSync('web/public/hetu.png');
      const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
      for (let i = 0; i < sig.length; i++) {
        if (b[i] !== sig[i]) throw new Error('hetu.png not a PNG (magic = ' + b.slice(0,8).toString('hex') + ')');
      }
    " && pass "hetu.png has valid PNG magic bytes" \
      || fail "hetu.png has wrong magic — install icon will render broken"
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
  # Section 7: Bash commands anchor to session wks. This rule auto-
  # injects into every spawned/resumed project's CLAUDE.md and is what
  # prevents claude from running stale `cd foo` / relative-path
  # commands that resolve against the wrong dir between turns.
  grep -qF 'Anchor every Bash command to the session workspace' web/public/best-practices-template.md \
    && pass "best-practices-template.md: §7 session-wks anchoring rule present" \
    || fail "best-practices-template.md: §7 session-wks anchoring rule missing — auto-injection won't carry it to project CLAUDE.md files"
  # Section 8: karpathy-skills-derived anti-bloat / anti-assumption
  # discipline (state assumptions before coding, surface confusion,
  # no speculative abstractions, surgical edits, numbered plan with
  # verify). Auto-injects into every project's CLAUDE.md.
  grep -qF 'Anti-bloat, anti-assumption discipline for AI-assisted edits' web/public/best-practices-template.md \
    && pass "best-practices-template.md: §8 karpathy-skills discipline rules present" \
    || fail "best-practices-template.md: §8 karpathy-skills discipline rules missing — auto-injection won't carry them to project CLAUDE.md files"
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
  node_test_result test/best-practices-inject.test.js "test/best-practices-inject.test.js (6 cases)"
  # /td /fr /bug must mirror new plan items to _myco_/plan.json — the
  # GET /artifact handler reads the on-disk file first and would
  # otherwise silently drop the in-memory-only addition on next open.
  node_test_result test/slash-todo-inject.test.js "test/slash-todo-inject.test.js (12 cases)"
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
  node_test_result test/slash-clear.test.js "test/slash-clear.test.js (4 cases)"
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
  # Regression for bug-7 (2026-05-16): agent-replay arrives on every
  # WS reconnect with the FULL session.buffer; before this fix the
  # client appended cards on top of the prior render, and the chrome-
  # batch adjacency rule folded the duplicates into the trailing batch
  # — surfacing as "16:06:43 ▸ × 10" rows repeating 2-4 times. The fix
  # wipes non-chat-msg children before processing the events loop.
  if awk '/msg.t === .agent-replay./{found=1} found && /for \(const ev of msg.events\) _appendAgentEvent/{print "OK"; exit}' web/public/app.js | grep -q '^OK$'; then
    if awk '/msg.t === .agent-replay./{found=1} found && !done && /el.remove\(\)/{print "OK"; done=1; exit}' web/public/app.js | grep -q '^OK$'; then
      pass "app.js: agent-replay wipes prior cards before re-render (no dup chrome batches on reconnect)"
    else
      fail "app.js: agent-replay handler missing the pre-render wipe — dup chrome batches will reappear on reconnect"
    fi
  fi
  # Phase 9: spawnSession no longer "branches" — agent is the only
  # mode. The const declaration is the new contract.
  grep -q "const mode = 'agent'" server/src/sessions.js \
    && pass "sessions.js: spawnSession hardcodes mode='agent' (Phase 9)" \
    || fail "sessions.js: spawnSession does not pin mode='agent'"
  node_test_result_or_skip test/agent-session.test.js "test/agent-session.test.js (6 cases — incl phase-2 menu round-trip)" "test/agent-session.test.js (skipped — SDK or auth unavailable)"
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
  pcre_match "agent-card\.agent-card-collapsed[\s\S]{0,80}agent-card-body[\s\S]{0,40}display:\s*none" web/public/styles.css \
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
  pcre_match "\.perm-modal\s*\{[\s\S]{0,200}position:\s*fixed" web/public/styles.css \
    && pass "styles.css: perm-modal is position:fixed overlay" \
    || fail "styles.css: perm-modal is position:fixed overlay"
  # Phase 2: agent events render into #chat-messages (single timeline).
  # _ensureAgentLogPane now returns the chat-messages container so each
  # tool_use / tool_result / claude-text card sits alongside chat bubbles.
  # On the first agent frame of an attach we force the chat pane open
  # and hide #terminal-wrap (which is empty for agent-mode sessions);
  # session-switch resets the latch so PTY sessions are unaffected.
  pcre_match "function _ensureAgentLogPane[\s\S]{0,400}getElementById\('chat-messages'\)" web/public/app.js \
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
  node_test_result test/artifact-sync-from-file.test.js "test/artifact-sync-from-file.test.js (5 cases)"
  node_test_result test/dedupe-context.test.js "test/dedupe-context.test.js (5 cases)"
  # One-shot migration: rewrites pre-ca9bcf1 hex-id plan items to
  # fr-N/td-N/bug-N (addedAt order). Idempotent.
  [ -x scripts/migrate-plan-ids.js ] \
    && pass "scripts/migrate-plan-ids.js present + executable" \
    || fail "scripts/migrate-plan-ids.js present + executable"
  [ ! -e migrate-plan-ids.js ] \
    && pass "migrate-plan-ids.js moved out of repo root (lives under scripts/)" \
    || fail "migrate-plan-ids.js moved out of repo root (lives under scripts/)"
  node_test_result test/migrate-plan-ids.test.js "test/migrate-plan-ids.test.js (4 cases)"
  node_test_result test/chat-routing.test.js "test/chat-routing.test.js (7 cases)"
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
  pcre_match 'class="chat-text">\$\{renderMd' web/public/app.js \
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
  # Phase 9+ (post-@myco-removal): there is no "@<word>" alias prefix
  # any more. Every non-mention chat message reaches claude via
  # session.write(); @<known-user> is the only chat-only path
  # (mention with highlight). The legacy CHAT_ALIAS_PREFIX_RE strip
  # is gone — re-adding it would suppress real text claude needs to see.
  grep -q 'session.write' server/src/attach.js && pass "session.write present in chat path" || fail "session.write missing"
  if grep -q 'CHAT_ALIAS_PREFIX_RE' server/src/attach.js; then
    fail "attach.js still references CHAT_ALIAS_PREFIX_RE — the @myco/@claude alias strip should be gone"
  else
    pass "attach.js: legacy CHAT_ALIAS_PREFIX_RE removed"
  fi
  if grep -qE "text\s*=\s*['\"]@myco" server/src/attach.js; then
    fail "attach.js still rewrites slash commands to '@myco …' — should forward bare text instead"
  else
    pass "attach.js: no '@myco /…' slash-rewrite path"
  fi
  grep -q '_isKnownChatUser' server/src/attach.js \
    && pass "attach.js: known-user check guards mention routing" \
    || fail "attach.js: known-user check guards mention routing"
  # fr-3: @all broadcast mention. Server recognizes the literal 'all'
  # target at head-of-message, stamps meta.broadcast=true, and stays
  # chat-only (no forward to claude). Client renders chat-msg-mention-all
  # and bumps the unread badge for every viewer (each viewer is a
  # recipient).
  grep -qF "if (w === 'all') return 'all'" server/src/attach.js \
    && pass "attach.js: _detectMentionTarget recognizes @all" \
    || fail "attach.js: _detectMentionTarget missing @all branch — broadcast mention won't fire"
  grep -qF 'broadcast = true' server/src/attach.js \
    && pass "attach.js: meta.broadcast=true stamped on @all mentions" \
    || fail "attach.js: missing meta.broadcast=true stamp for @all"
  grep -qF 'chat-msg-mention-all' web/public/app.js \
    && pass "app.js: renders chat-msg-mention-all class for broadcast mentions" \
    || fail "app.js: missing chat-msg-mention-all render class — @all won't be visually distinct"
  grep -qF 'chat-msg-mention-all' web/public/styles.css \
    && pass "styles.css: chat-msg-mention-all styling present" \
    || fail "styles.css: chat-msg-mention-all styling missing"
  # Plain chat (no /btw) must NOT trigger the side-channel assistant.
  # Regression guard: the old shouldAskAssistant treated any '?'-ending
  # message as an assistant trigger, making every question look like claude
  # was replying even without a /btw prefix.
  if ! have_node; then skip "shouldAskAssistant runtime (no host node)"; return; fi
  node -e "
    const { shouldAskAssistant } = require('./server/src/btw');
    const cases = [
      ['hello', false],
      ['is this on?', false],
      ['please look at this', false],
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
  pcre_match '\.claude-typing\s*\{[^}]*flex:\s*0\s+0\s+\d+px' web/public/styles.css \
    && pass "css: .claude-typing reserves a fixed-px flex slot" \
    || fail "css: .claude-typing slot isn't a fixed-px flex item — chat content will move on spinner toggles"
  pcre_match '\.claude-typing\[hidden\]\s*\{[^}]*visibility:\s*hidden' web/public/styles.css \
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
  # Commit 2d8234f shrank the rule body to just `margin: 0 0 4px 0;` —
  # the outer .chat-msg.chat-msg-menu rule already zeros out
  # background/border/padding, so the inner .chat-text only needs the
  # vertical margin and inherits the flattening implicitly. The test
  # now guards two invariants: (1) the selector still exists at all
  # (refactor-protection), and (2) the body declares NO background-
  # color or visible border that would reintroduce nested-card chrome.
  if have_node; then
    node -e "
      const css = require('fs').readFileSync('web/public/styles.css', 'utf8');
      const m = css.match(/\.chat-msg\.chat-msg-menu\s+\.chat-text\s*\{([^}]*)\}/);
      if (!m) { console.error('selector missing'); process.exit(1); }
      const body = m[1];
      const bg = body.match(/background(?:-color)?:\s*([^;]+);/);
      if (bg && !/transparent|none/i.test(bg[1])) {
        console.error('regression: opaque background in menu .chat-text: ' + bg[1].trim()); process.exit(1);
      }
      const borderProps = body.match(/border(?:-(?:top|bottom|left|right))?:\s*[^;]+;/g) || [];
      for (const prop of borderProps) {
        if (!/none|0(?:px)?(?:\s|;)/i.test(prop)) {
          console.error('regression: visible border in menu .chat-text: ' + prop); process.exit(1);
        }
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
  # Chat-only flow: when a chat message is sent, a typing indicator
  # appears in chat; assistant transcript text is buffered and posted
  # as a chat message after a quiet window so the user gets the FINAL
  # result without intermediate noise. The main pane is NOT auto-
  # switched on send.
  grep -q '_markAwaitingClaude' web/public/app.js \
    && pass "app.js: chat send marks awaiting-claude" \
    || fail "app.js: chat send marks awaiting-claude"
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
    && pass "app.js: schedules idle check after chat send" \
    || fail "app.js: schedules idle check after chat send"
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
  pcre_match "absCwd = path\.join\(userRootDir, id\)" server/src/sessions.js \
    && pass "sessions.js: spawnSession uses session id as folder name" \
    || fail "sessions.js: spawnSession does not use session id as folder"
  grep -q 'placeholder="e.g.' web/public/index.html \
    && pass "index.html: spawn-cwd input relabelled as Display name (optional)" \
    || fail "index.html: spawn-cwd input still labelled as Subdirectory"
  # Per-session memory: redirect the SDK auto-memory directory into the
  # session's own .claude/memory/ instead of the shared
  # $HOME/.claude/projects/<sanitized-cwd>/memory/. settingSources
  # MUST include 'user' (3d75081 — proxy support: SDK picks up auth
  # credentials from $HOME/.claude/settings.json for corporate
  # networks behind HTTP_PROXY). project + local stay so per-session
  # .claude/settings*.json still drives per-project config.
  grep -q "autoMemoryDirectory" server/src/agent-session.js \
    && pass "agent-session: per-session autoMemoryDirectory" \
    || fail "agent-session: autoMemoryDirectory not set"
  pcre_match "settingSources:\s*\['project',\s*'local',\s*'user'\]" server/src/agent-session.js \
    && pass "agent-session: settingSources = project+local+user (proxy auth)" \
    || fail "agent-session: settingSources missing 'user' (needed for corporate-proxy auth credentials from \$HOME/.claude/settings.json)"
  # Memory migration: existing sessions whose legacy auto-memory lived
  # at ~/.claude/projects/<encoded-cwd>/memory/ get a one-shot copy
  # into <absCwd>/.claude/memory/ on the next ensureLiveSession spawn.
  # Idempotent (skips when destination exists).
  grep -q "function _migrateLegacyMemory" server/src/sessions.js \
    && pass "sessions.js: _migrateLegacyMemory helper defined" \
    || fail "sessions.js: _migrateLegacyMemory helper missing"
  # UX Phase 3: single-column layout. The chatpane fills the main pane
  # (no longer a right-anchored sidebar with --chatpane-w).
  # NOTE: the chat column's max-width:880px cap was intentionally
  # relaxed to max-width:none in 7378ab9 ("let the chat pane use the
  # full screen width"). The dedicated guard test/chat-pane-full-width
  # .test.js now owns that assertion — do NOT re-pin 880px on the chat
  # column here. The artifact-body 880px readable-line cap below is a
  # DIFFERENT surface (fr-77) and is still in force.
  pcre_match "#chatpane\.chat-main-view\s*\{[\s\S]{0,400}inset:\s*0" web/public/styles.css \
    && pass "styles.css: chatpane fills main pane (inset:0, Phase 3)" \
    || fail "styles.css: chatpane still right-anchored sidebar"
  pcre_match "\.artifact-main-view\s+\.artifact-body[\s\S]{0,400}max-width:\s*880px" web/public/styles.css \
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
  # Proximity guard between _migrateLegacyMemory and spawnAgent inside
  # ensureLiveSession. Budget bumped from 800 → 3000 chars to absorb
  # transcript-autoheal and other future ensureLiveSession inserts;
  # the assertion intent ("both calls happen, in order, in the same
  # function") is preserved without bouncing on every code add.
  pcre_match "_migrateLegacyMemory\((rec\.absCwd|liveCwd)\)[\s\S]{0,3000}spawnAgent" server/src/sessions.js \
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
  grep -q '/build\.txt' docker/Dockerfile && pass "Dockerfile writes build.txt" || fail "Dockerfile writes build.txt"
}

test_mermaid_html_init() {
  grep -q 'mermaid.initialize' web/public/app.js && pass "mermaid init" || fail "mermaid init"
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
  pcre_match "(?s)showFilesView[^}]+files-tree-pane.*hidden.*=.*false" web/public/app.js \
    && pass "js: showFilesView resets files-tree-pane visibility" \
    || fail "js: showFilesView resets files-tree-pane visibility"
}

# Replaces the old test_deploy_add_token. The MYCO_TOKENS bearer-token system
# is gone; scripts/deploy.sh now manages the GitHub OAuth allowlist via
# --allow-github-user and OAuth client credentials via --set-oauth.
test_deploy_oauth_flags() {
  grep -q '^allow_github_user()'   scripts/deploy.sh && pass "deploy.sh: allow_github_user()"          || fail "deploy.sh: allow_github_user()"
  grep -q '^set_oauth_in_env()'    scripts/deploy.sh && pass "deploy.sh: set_oauth_in_env()"           || fail "deploy.sh: set_oauth_in_env()"
  grep -q '^ensure_allowlist_seed()' scripts/deploy.sh && pass "deploy.sh: ensure_allowlist_seed()"   || fail "deploy.sh: ensure_allowlist_seed()"
  grep -q '^warn_if_oauth_unset()' scripts/deploy.sh && pass "deploy.sh: warn_if_oauth_unset()"        || fail "deploy.sh: warn_if_oauth_unset()"
  grep -q -- '--allow-github-user)' scripts/deploy.sh && pass "deploy.sh: --allow-github-user parsed"  || fail "deploy.sh: --allow-github-user parsed"
  grep -q -- '--set-oauth)'         scripts/deploy.sh && pass "deploy.sh: --set-oauth parsed"          || fail "deploy.sh: --set-oauth parsed"
  # Regression: the token-based flags must NOT come back without an explicit
  # design decision — we removed --add-token entirely.
  ! grep -qE -- '--add-token' scripts/deploy.sh && pass "deploy.sh: --add-token removed"               || fail "deploy.sh: --add-token still referenced"
  ! grep -q 'MYCO_TOKENS' scripts/deploy.sh     && pass "deploy.sh: MYCO_TOKENS removed"               || fail "deploy.sh: MYCO_TOKENS still referenced"
  # Regression (2026-05-23): td-33 moved deploy.sh into scripts/.
  # The pre-move main() started with `cd "$(dirname "$0")"` which
  # was a no-op when the script lived at the repo root, but now
  # cds INTO scripts/ — undoing the cd-anchor near the top and
  # breaking `docker build -f docker/Dockerfile .` plus
  # `./test/test.sh`. Negative guard: that line must NOT exist
  # inside main() anymore. (The cwd anchor near line ~46 lives in
  # the top-level code BEFORE main(), so the `cd $(dirname …)`
  # pattern is fine there — only the leftover inside main() is
  # the buggy one.)
  awk '/^main\(\)/,/^}$/' scripts/deploy.sh \
    | grep -qE '^\s*cd "\$\(dirname "\$0"\)"' \
    && fail "deploy.sh main(): leftover 'cd \$(dirname \$0)' undoes the cwd anchor (bug re-introduced)" \
    || pass "deploy.sh main(): no leftover 'cd \$(dirname \$0)' (cwd anchor preserved)"
  # Regression (2026-05-16): verify_deploy used to grep `app.js?v=\d+` on
  # both source + served HTML, which broke once the server started
  # rewriting `?v=` to the URL-encoded build.txt timestamp (e.g.
  # `2026-05-16T11%3A28%3A21Z`). The greedy `\d+` then captured `2026`
  # from the year and red-flipped with "version mismatch v2026 vs v223"
  # on every otherwise-successful deploy. The fix compares the served
  # value against the freshly-baked build.txt pulled out of the running
  # container; the regex now matches the full encoded value.
  grep -qF 'docker exec $NAME cat /app/web/public/build.txt' scripts/deploy.sh \
    && pass "deploy.sh: verify_deploy compares against container build.txt" \
    || fail "deploy.sh: verify_deploy still grepping the source ?v= placeholder — will misreport after every deploy"
  grep -qF '\K[^"' scripts/deploy.sh \
    && pass "deploy.sh: verify regex captures the full encoded version (not just \\d+)" \
    || fail "deploy.sh: verify regex still uses the greedy \\d+ — will capture year prefix only"
  if grep -qF 'grep -oP '"'"'app\.js\?v=\K\d+'"'"' web/public/index.html' scripts/deploy.sh; then
    fail "deploy.sh: stale source-vs-served verify_deploy regex is back"
  else
    pass "deploy.sh: no source-vs-served regex regression"
  fi
  # Regression (2026-05-16 follow-up): the verify_deploy retry loop has
  # `set -euo pipefail` propagating grep's exit 1 (no-match during the
  # post-swap Caddy→mycod 502 race) into the `served=$(...)` assignment,
  # which set -e then turned into a silent script abort BEFORE the
  # retry could fire. The `|| true` tail keeps the loop alive — when
  # this guard red-flips, future deploys will silently exit 1 again
  # even with the URL-encoded comparison in place.
  grep -qF '| head -1 || true)' scripts/deploy.sh \
    && pass "deploy.sh: verify retry survives transient empty curl results (|| true tail)" \
    || fail "deploy.sh: verify retry will abort under pipefail when grep doesn't match — need '|| true' tail on served= assignment"
  # Regression (2026-05-16 follow-up): verify_deploy used to default to
  # `https://localhost/` under IS_LOCAL=1, which Caddy refuses (no cert
  # for localhost). The on-host mycobeta/myco recipe needed a manual
  # MYCO_VERIFY_DOMAIN= retry on every deploy. Auto-derive the verify
  # domain from MYCO_PUBLIC_ORIGIN (preferred) or Caddyfile's first
  # virtual-host header (fallback) so the recipe is one-step again.
  grep -q '^_derive_verify_domain()' scripts/deploy.sh \
    && pass "deploy.sh: _derive_verify_domain helper present" \
    || fail "deploy.sh: _derive_verify_domain helper missing — IS_LOCAL=1 verify will default to localhost and 421 under Caddy"
  grep -qF 'MYCO_PUBLIC_ORIGIN=' scripts/deploy.sh \
    && pass "deploy.sh: verify domain reads MYCO_PUBLIC_ORIGIN from .env" \
    || fail "deploy.sh: verify domain lookup missing MYCO_PUBLIC_ORIGIN — primary source not consulted"
  grep -qF 'STATE_DIR/Caddyfile' scripts/deploy.sh \
    && pass "deploy.sh: verify domain fallback consults Caddyfile" \
    || fail "deploy.sh: verify domain fallback missing Caddyfile lookup — recovery path gone"
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

# Regression guard: test_index_html_contents (test/test.sh) MUST use here-
# strings (`grep -q PAT <<<"$index"`), NOT the `echo "$index" | grep -q PAT`
# pipe form. Under `set -o pipefail` the pipe form races on glibc hosts —
# grep -q short-circuits at first match, echo's next chunked write hits
# SIGPIPE → pipefail propagates exit 141 → the assertion fails even though
# the pattern was found. Verified on mycobeta (glibc) 2026-06-05.
test_index_chatpane_uses_herestring() {
  # Locate the function block, strip comments + blank lines, then assert the
  # surviving (assertion) lines use here-strings and avoid the racy pipe
  # form. Stripping comments matters because the function-body comment
  # explains the bug and *mentions* the bad pattern — without the strip,
  # we'd flag our own warning text as a regression.
  local body
  body=$(awk '/^test_index_html_contents\(\) \{/,/^\}/' test/test.sh \
        | sed -E '/^[[:space:]]*#/d; /^[[:space:]]*$/d')
  grep -q 'grep -q .id="chatpane". <<<"\$index"' <<<"$body" \
    && pass "test.sh: test_index_html_contents uses here-string for chatpane assertion" \
    || fail "test.sh: test_index_html_contents must use here-string — see comment at test.sh test_index_html_contents()"
  ! grep -qE 'echo "\$index" \| grep -q' <<<"$body" \
    && pass "test.sh: test_index_html_contents avoids racy 'echo \"\$index\" | grep -q' pipe form" \
    || fail "test.sh: test_index_html_contents contains racy pipe form (SIGPIPE+pipefail bug on glibc) — switch to here-strings"
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
  test_index_chatpane_uses_herestring
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
  pcre_match '#chat-messages[^{]*\{[^}]*user-select:\s*text\s*!important' web/public/styles.css \
    && pass "#chat-messages re-enables user-select with !important" \
    || fail "#chat-messages re-enables user-select with !important"
  pcre_match '#chat-messages[^{]*\{[^}]*touch-callout:\s*default' web/public/styles.css \
    && pass "#chat-messages re-enables iOS touch-callout" \
    || fail "#chat-messages re-enables iOS touch-callout"
  pcre_match '#chat-messages[^{]*\{[^}]*touch-action:\s*auto' web/public/styles.css \
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
  pcre_match '<textarea[^>]*id="chat-input"' web/public/index.html \
    && pass "chat-input is a multi-line textarea" \
    || fail "chat-input is a multi-line textarea"
  grep -q "Enter sends" web/public/index.html \
    && pass "chat-input placeholder advertises Enter-to-send" \
    || fail "chat-input placeholder advertises Enter-to-send"
  pcre_match "key !== 'Enter'[\s\S]{0,400}shiftKey[\s\S]{0,200}submitChat\(\)" web/public/app.js \
    && pass "Enter sends; Shift+Enter inserts newline" \
    || fail "Enter sends; Shift+Enter inserts newline"
  pcre_match "key !== 'Enter'[\s\S]{0,200}isComposing" web/public/app.js \
    && pass "chat send guards IME composition (isComposing)" \
    || fail "chat send guards IME composition (isComposing)"
  pcre_match "key !== 'Enter'[\s\S]{0,400}chat-autocomplete" web/public/app.js \
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
  node_test_result test/artifact-myco-dir.test.js "test/artifact-myco-dir.test.js (16 cases)"
  grep -qF 'writeArtifactToFile(rec, type, artifact)' server/src/artifacts.js \
    && pass "artifacts.js: persistArtifact mirrors to disk on every mutation" \
    || fail "artifacts.js: persistArtifact missing disk mirror — _myco_/ state will go stale"
  grep -qF "MYCO_DIR = '_myco_'" server/src/artifacts.js \
    && pass "artifacts.js: _myco_ directory constant defined" \
    || fail "artifacts.js: MYCO_DIR constant missing — sharing layout unsettled"
  # When an artifact item is dispatched (manual /run or auto-quorum) the
  # text that lands in BOTH the chat history and the running Claude
  # session must carry: a title line naming the artifact type + the
  # submitter, the item body, and any per-item comments. Chat viewers
  # see who triggered what at a glance; Claude executes against the
  # full instruction (body + comments).
  #
  # Post-@myco-removal (2026-05-16): the dispatched text must NOT carry
  # an `@myco ` prefix any more — every chat message reaches claude
  # by default, and the `[run:<type>#<id>]` marker (added client-side
  # in onArtifactItemRun) is what binds the next turn_result back to
  # the item, not the @myco prefix.
  if have_node; then
    node -e "
      const a = require('./server/src/artifacts');
      // Manual run — submitter is a real user + item has id (fr-48
      // requires id for the [run:<type>#<id>] marker prefix).
      const t1 = a.buildArtifactRunText('plan', {
        id: 'fr-43',
        text: 'Wire up the /v2/orders cursor pager',
        comments: [
          { user: 'alice', text: 'don\\'t forget the limit clamp' },
          { user: 'bob',   text: 'tenant scoping at query time, please' },
        ],
      }, 'kkrazy');
      if (t1.startsWith('@myco ')) throw new Error('manual-run text must NOT start with @myco prefix (removed) — got: ' + JSON.stringify(t1));
      // fr-48 root-cause fix: must START with the [run:plan#fr-43] marker.
      if (!/^\[run:plan#fr-43\]\s+\[📋 Plan item · submitted by @kkrazy\]/.test(t1)) throw new Error('manual-run text missing the [run:plan#<id>] marker prefix (fr-48 contract) or type+submitter header — got: ' + JSON.stringify(t1));
      if (!t1.includes('Wire up the /v2/orders cursor pager')) throw new Error('manual-run text missing body');
      if (!t1.includes('- @alice: don\\'t forget the limit clamp')) throw new Error('manual-run text missing alice comment');
      if (!t1.includes('- @bob: tenant scoping at query time, please')) throw new Error('manual-run text missing bob comment');
      // Test artifact uses the 🧪 glyph + carries the test marker.
      const t2 = a.buildArtifactRunText('test', { id: 'test-1', text: 'k6 load run at 100 RPS', comments: [] }, 'kkrazy');
      if (!/^\[run:test#test-1\]\s+\[🧪 Test item · submitted by @kkrazy\]/.test(t2)) throw new Error('test title wrong glyph/label or missing marker: ' + JSON.stringify(t2));
      if (t2.includes('Comments:')) throw new Error('empty comments must NOT render a Comments: block');
      // Defensive: items without id render WITHOUT the marker prefix
      // (legacy/synthetic call sites — protects against [run:plan#undefined]).
      const t2b = a.buildArtifactRunText('plan', { text: 'no id item', comments: [] }, 'kkrazy');
      if (/\[run:plan#undefined\]/.test(t2b)) throw new Error('items without id must NOT produce [run:plan#undefined] — got: ' + JSON.stringify(t2b));
      if (!/^\[📋 Plan item · submitted by @kkrazy\]/.test(t2b)) throw new Error('id-less item must still produce a recognisable header — got: ' + JSON.stringify(t2b));
      // Quorum dispatch.
      const t3 = a.buildArtifactQuorumText('plan', {
        id: 'fr-9',
        text: 'Ship the feature',
        voters: ['alice', 'bob', 'charlie'],
        comments: [{ user: 'alice', text: 'rolling out behind a flag' }],
      });
      if (t3.startsWith('@myco ')) throw new Error('quorum text must NOT start with @myco prefix (removed) — got: ' + JSON.stringify(t3));
      if (!/^\[run:plan#fr-9\]/.test(t3)) throw new Error('quorum text missing the [run:plan#<id>] marker prefix (fr-48 contract) — got: ' + JSON.stringify(t3));
      if (!/quorum reached \\(3 voters: @alice, @bob, @charlie\\)/.test(t3)) throw new Error('quorum title missing voter list: ' + JSON.stringify(t3));
      if (!t3.includes('- @alice: rolling out behind a flag')) throw new Error('quorum text missing comment');
    " && pass "artifact run/quorum dispatch text carries [run:<type>#<id>] marker + type+submitter+comments" \
      || fail "artifact buildArtifactRunText / buildArtifactQuorumText shape wrong"
  fi
  grep -q "onArtifactVote"        web/public/app.js && pass "onArtifactVote handler"        || fail "onArtifactVote handler"
  grep -q "onArtifactComment"     web/public/app.js && pass "onArtifactComment handler"     || fail "onArtifactComment handler"
  grep -q "onArtifactItemDelete"  web/public/app.js && pass "onArtifactItemDelete handler"  || fail "onArtifactItemDelete handler"
  # fr-6 (2026-05-16): plan items are deep-linkable via `<origin>/#<id>`.
  # Each <li> carries a stable DOM id ("artifact-item-<id>"); the id chip
  # is a copy-to-clipboard affordance that ALSO updates location.hash;
  # hashchange + the artifacts-init cache hook scroll the matching item
  # into view with a brief highlight pulse.
  grep -qF 'id="artifact-item-${escHtml(it.id)}"' web/public/app.js \
    && pass "app.js: plan-item li carries stable DOM id for deep-link" \
    || fail "app.js: plan-item li missing the artifact-item-<id> attribute — deep links can't anchor"
  grep -qF 'data-deep-link-id=' web/public/app.js \
    && pass "app.js: id chip exposes data-deep-link-id" \
    || fail "app.js: id chip missing data-deep-link-id — copy-link affordance won't bind"
  grep -qF '_copyArtifactItemDeepLink' web/public/app.js \
    && pass "app.js: _copyArtifactItemDeepLink copy-to-clipboard helper present" \
    || fail "app.js: _copyArtifactItemDeepLink missing — id-chip click won't copy permalink"
  grep -qF '_focusArtifactItemFromHash' web/public/app.js \
    && pass "app.js: _focusArtifactItemFromHash hash → scroll-into-view helper present" \
    || fail "app.js: _focusArtifactItemFromHash missing — deep-link URLs won't auto-scroll"
  grep -qF "addEventListener('hashchange'" web/public/app.js \
    && pass "app.js: hashchange listener wired so paste-permalink re-focuses item" \
    || fail "app.js: no hashchange listener — pasting a deep link in the address bar won't scroll"
  grep -qF 'artifact-item-deep-link-focused' web/public/styles.css \
    && pass "styles.css: deep-link focus pulse styling present" \
    || fail "styles.css: deep-link focus pulse missing — landed item won't be visually distinguishable"
  grep -qF 'artifact-item-id-copied' web/public/styles.css \
    && pass "styles.css: id-chip copied flash styling present" \
    || fail "styles.css: id-chip copied flash missing — no copy confirmation feedback"
  # fr-7 (2026-05-16): high-signal chat events surface through the OS
  # notification center when the tab is unfocused. Two new sources
  # extend the existing _maybeNotifyMention pattern:
  #   - _maybeNotifyMenuPending — permission menus + AskUserQuestion
  #     menus (claude is BLOCKED waiting on the user).
  #   - _maybeNotifyTurnComplete — gated on ≥30s turns so the OS
  #     center doesn't fill up with "claude finished" pings for
  #     every short response.
  # Reuses the existing permission-granted gate + visibilityState
  # check via the shared _shouldFireOsNotification helper.
  grep -qF '_maybeNotifyMenuPending' web/public/app.js \
    && pass "app.js: _maybeNotifyMenuPending helper present" \
    || fail "app.js: _maybeNotifyMenuPending missing — blocking menus won't surface as OS notifications"
  grep -qF '_maybeNotifyTurnComplete' web/public/app.js \
    && pass "app.js: _maybeNotifyTurnComplete helper present" \
    || fail "app.js: _maybeNotifyTurnComplete missing — finished long turns won't surface as OS notifications"
  grep -qF '_shouldFireOsNotification' web/public/app.js \
    && pass "app.js: _shouldFireOsNotification shared gate present" \
    || fail "app.js: _shouldFireOsNotification gate missing — visibility/permission checks would be duplicated/divergent"
  grep -qF 'NOTIFY_LONG_TURN_THRESHOLD_MS' web/public/app.js \
    && pass "app.js: long-turn threshold constant defined" \
    || fail "app.js: NOTIFY_LONG_TURN_THRESHOLD_MS missing — short turns will spam the OS notification center"
  grep -qF 'requireInteraction:' web/public/app.js \
    && pass "app.js: permission-menu notification uses requireInteraction so it sticks until answered" \
    || fail "app.js: requireInteraction missing on permission-menu notification — blocking menus won't stay visible"
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
  # discussion-panel chat (rec.chat) so human-to-human notes still feed
  # Plan even when they didn't reach Claude as a user turn.
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
  # td-4: /setpat saves a per-repo PAT for the session's current
  # github or gitee remote. Auto-detects the provider from cwd — no
  # provider arg in the usage. Regressions to either of these break
  # the documented "one PAT per repo" UX.
  grep -q "names: \['setpat'\]" server/src/slashcmds.js && pass "/setpat command registered" || fail "/setpat command missing"
  grep -qF "usage: '/setpat <token>'" server/src/slashcmds.js \
    && pass "/setpat usage shows single-arg form (auto-detect provider)" \
    || fail "/setpat usage should be single-arg — provider should be auto-detected from session.cwd, not user-supplied"
  # /m: removed 2026-05-15 in the chat-routing rewrite. Plain text now
  # routes to the running Claude PTY by default, which makes /m redundant.
  # The negative assertion below (slashcmds: /m removed) lives in the
  # earlier chat-routing block — duplicating here would just whine twice.
  # /task /skip /cancel: chat-side commands that forward a natural-
  # language directive to the running Claude session via
  # ctx.session.write() in handleTaskList / handleTaskSkip (no @myco
  # rewrite — that was removed 2026-05-16). The CLAUDE.md project
  # rule (Working in this repo §3) tells Claude how to handle the
  # forwarded directives and to volunteer stale-task heads-up lines.
  grep -q "names: \['task', 'tasks'\]" server/src/slashcmds.js && pass "/task command registered" || fail "/task command missing"
  grep -q "names: \['skip'\]" server/src/slashcmds.js && pass "/skip command registered" || fail "/skip command missing"
  grep -q "names: \['cancel'\]" server/src/slashcmds.js && pass "/cancel command registered" || fail "/cancel command missing"
  grep -q 'function handleTaskList' server/src/slashcmds.js && pass "handleTaskList handler" || fail "handleTaskList handler missing"
  grep -q 'function handleTaskSkip' server/src/slashcmds.js && pass "handleTaskSkip handler" || fail "handleTaskSkip handler missing"
  grep -qF 'ctx.session.write' server/src/slashcmds.js \
    && pass "slashcmds.js: task handlers forward to claude via session.write" \
    || fail "slashcmds.js: task handlers don't forward to claude — they'd be no-ops"
  if grep -qE "text\s*=\s*['\"]@myco /(task|skip|cancel)" server/src/attach.js; then
    fail "attach.js: legacy @myco /… rewrite is back — task forwarding should be in slashcmds.handleTaskList/Skip"
  else
    pass "attach.js: no legacy @myco /task rewrite"
  fi
  grep -qF '/^\/tasks?\s*$/i' web/public/app.js \
    && pass "app.js: typing-dots arm recognizes /task" \
    || fail "app.js: typing-dots arm /task missing"
  grep -qF '/^\/(skip|cancel)\s+\d+\s*$/i' web/public/app.js \
    && pass "app.js: typing-dots arm recognizes /skip + /cancel" \
    || fail "app.js: typing-dots arm /skip+/cancel missing"
  # CLAUDE.md must document the bare-slash task-control protocol so
  # future Claude instances handle the forwarded directives consistently.
  if grep -qF '@myco /task' CLAUDE.md; then
    fail "CLAUDE.md still documents '@myco /task' — should reference bare /task"
  else
    pass "CLAUDE.md: @myco /task references removed"
  fi
  grep -qiF 'task-list etiquette' CLAUDE.md \
    && pass "CLAUDE.md: documents /task protocol (bare-slash form)" \
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
  node_test_result test/find-newest-jsonl.test.js "test/find-newest-jsonl.test.js (6 cases)"
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
  node_test_result test/transcript-parser-types.test.js "test/transcript-parser-types.test.js (21 cases)"
  # state-update broadcast paths — chat-pane ↔ PTY sync. Covers menu
  # mutation emits, artifact mutation emits, in-flight tool tracker,
  # attach snapshot frames, and client-side dispatcher wiring.
  node_test_result test/state-update.test.js "test/state-update.test.js (18 cases)"
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
  node_test_result test/active-claude-session.test.js "test/active-claude-session.test.js (8 cases)"
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
  node_test_result test/capture-claude-session-id.test.js "test/capture-claude-session-id.test.js (4 cases)"
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
  node_test_result test/persist-assistant-chat.test.js "test/persist-assistant-chat.test.js (7 cases)"
  # Regression: when a [run:plan#<id>]-tagged dispatch finishes, the
  # turn_result outcome must append a run-summary comment to the item
  # (user='claude', meta.kind='run-summary') so findings live ON the
  # item. Added with the @myco-prefix removal 2026-05-16.
  node_test_result test/plan-run-comment.test.js "test/plan-run-comment.test.js (4 cases)"
  # fr-4 regression: /td /fr /bug with >8-word body OR the /td! /fr!
  # /bug! bang variants kick off an async claude rewrite that
  # reshapes the description into a tight issue-style body. Item is
  # persisted immediately with the original text + meta.rewritePending,
  # then updated in place when claude returns. Short crisp items skip
  # the rewrite entirely. The test stubs btw.runClaudeP to control
  # the rewrite output without hitting the API.
  node_test_result test/plan-item-rewrite.test.js "test/plan-item-rewrite.test.js (5 cases)"
  # bug-9 regression: getChatHistory accepts {limit, before}; the
  # chat-history WS frame on attach caps at DEFAULT_CHAT_HISTORY_LIMIT
  # (100); GET /sessions/:id/chat/history?before= pages older windows.
  # Pins the server contract that bug-9's client load-older flow
  # depends on.
  node_test_result test/chat-history-window.test.js "test/chat-history-window.test.js (10 cases)"
  # bug-7 round 2 regression: the agent-replay WS frame must dedup
  # identical events from session.buffer before shipping. Suspected
  # upstream is _hydrateBufferFromDisk overlapping with the SDK's
  # `resume` replay on a container restart — recent events end up in
  # the buffer twice. Without dedup, the client's chrome-batch
  # adjacency rule renders them as stacked identical "▸ × N ✓ result"
  # rows (the original bug-7 symptom that 7cb8ed5 only partially
  # fixed via the post-replay wipe).
  node_test_result test/agent-replay-dedup.test.js "test/agent-replay-dedup.test.js (7 cases)"
  # bug-10 regression: multiple chrome batches with the same head
  # signature (e.g. five consecutive `× N perm asked · Bash` rows)
  # collapse into ONE row via _mergeIdenticalChromeBatches, invoked
  # from _enforceChatHistoryCap on every chat mutation. The test
  # exercises the merge math against a minimal DOM-like fake +
  # static-grep guards on the prod implementation in app.js.
  node_test_result test/chrome-batch-merge.test.js "test/chrome-batch-merge.test.js (9 cases)"
  # bug-11 regression: collapsed chrome batch rows display AGGREGATE
  # tool_result bytes across all sub-items, not just the last sub-
  # item's bytes (e.g. × 5 ✓ result · 20 bytes for 5 results of 4
  # bytes each, NOT × 5 ✓ result · 4 bytes). Locks per-batch byte
  # accumulator (dataset.toolResultBytes) + bytes-free merge sig
  # (dataset.chromeBatchSig) + label aggregation in _createChromeBatch,
  # _appendToChromeBatch, and _mergeIdenticalChromeBatches.
  node_test_result test/chrome-batch-bytes-aggregate.test.js "test/chrome-batch-bytes-aggregate.test.js (10 cases)"
  # bug-8 regression: the ▶ Run button on a plan item must be disabled
  # once the item is done, AND must carry a layer-aware verb instead
  # of the generic "Run": Bug → "Fix", Feature → "Implement",
  # Todo → "Do". Locks the runEnabled gate (now includes !it.done),
  # the new _runButtonLabel helper, and the runBtn template's use of
  # the layer-derived label.
  node_test_result test/plan-item-run-button.test.js "test/plan-item-run-button.test.js (13 cases)"
  # ryan-blues bug regression: creating a new session must not leave
  # the plan view showing stale data from the previously selected
  # session. Locks the state.artifacts cache to a { sessionId, byType }
  # shape, the loadArtifact lookup's sessionId-equality guard, the
  # artifacts-init handler tagging the cache with state.activeId, and
  # the _resetUiForNewSession reset.
  node_test_result test/plan-cache-session-isolation.test.js "test/plan-cache-session-isolation.test.js (9 cases)"
  # bug-13 regression: chrome batch messages (agent-event frames) +
  # exit notifications must reach share-link viewers, not just the
  # session owner. Locks attachViewerWebSocket to subscribe + unsub
  # to agent-event AND exit, and to ship the initial agent-replay
  # tail on attach so viewers see recent chrome batches not just
  # events going forward.
  node_test_result test/viewer-agent-events.test.js "test/viewer-agent-events.test.js (9 cases)"
  # bug-14 regression: the Stop button must invoke the SDK interrupt
  # via a dedicated {t:'interrupt'} WS frame, NOT by sending the
  # literal text "esc" through the chat-message path. The legacy path
  # persisted "esc" as a user-typed chat row + broadcast it to all
  # attached viewers — confusing UX, and made Stop appear broken when
  # the SDK abort had no immediate visible effect. Locks the new
  # interrupt frame handler in both owner + viewer attach paths +
  # the client-side _sendStopAgent rewrite.
  node_test_result test/stop-button-interrupt.test.js "test/stop-button-interrupt.test.js (8 cases)"
  # Plan tab "Open only" toggle: checkbox in plan-wrap header filters
  # out done items so the user sees only open bugs / features / todos.
  # Persisted in localStorage.myco_plan_open_only (default off).
  # Locks the HTML checkbox, app.js bindPlanOpenOnlyToggle helper +
  # boot call, the localStorage key + default-off semantics, the
  # filter application in renderArtifact, and the explicit "all done"
  # empty-state message.
  node_test_result test/plan-open-only-toggle.test.js "test/plan-open-only-toggle.test.js (9 cases)"
  # fr-56: Plan-tab type-filter chips (Bug / Feature / Todo) + fuzz-
  # search input. Type chips persist across reload
  # (localStorage.myco_plan_type_filter, default all-enabled); search
  # is state-only (resets on reload), 150ms debounced, case-insensitive
  # substring across item id + text + body. Intersects with the
  # existing "Open only" toggle. Static guards on HTML + CSS + app.js
  # bindings, plus inline behavior simulation of _filterPlanItems so
  # the substring/type/done/intersect semantics are pinned without a
  # browser.
  node_test_result test/fr-56-plan-filter-search.test.js "test/fr-56-plan-filter-search.test.js (20 cases)"
  # fr-65: per-layer "▶ N closed (tap to expand)" accordion that rolls
  # done plan items into a collapsible footer beneath each layer's open
  # items. Replaces the all-or-nothing bug-15 "Open only" toggle with
  # finer-grained per-layer control; the two interact cleanly (when
  # Open only is on, displayItems has no done items so the accordion's
  # done bucket is empty and the accordion doesn't render). Per-layer
  # expand state persisted in localStorage.myco_plan_layer_expand_<key>.
  # Static guards on the partition shape + helpers + DOM + click
  # handler + CSS, plus behavior simulation of the partition + the
  # bug-15 interaction.
  node_test_result test/fr-65-plan-layer-done-accordion.test.js "test/fr-65-plan-layer-done-accordion.test.js (12 cases)"
  # fr-64: at-a-glance status chip at the start of each plan-item row.
  # Five states derived from existing state (it.done, it.runs[],
  # state.runQueue.entries) — no schema change:
  #   ▶ running  (queue entry status==='running')
  #   ⏸ queued   (queue entry status==='pending')
  #   🟢 closed  (it.done)
  #   📌 inprogress (has runs[] but not active/done)
  #   ⚪ open    (fallthrough default)
  # Plan-only (supportsVoting branch). Static guards on helper +
  # mapping shape + render wiring + CSS; behavior simulation pins the
  # precedence (running > queued > closed > inprogress > open) +
  # defensive null-fallbacks.
  node_test_result test/fr-64-plan-item-status-chip.test.js "test/fr-64-plan-item-status-chip.test.js (16 cases)"
  # fr-62: mobile tap-target bump for plan-item action buttons. Inside
  # @media (max-width: 900px), every plan-item action button (vote,
  # comment-toggle, item-run, item-close, item-delete, item-edit,
  # comment-edit, comment-delete) gets min-height: 44px + min-width: 44px
  # per Apple HIG + Material Design. .artifact-item-actions gap widens
  # to 10px so adjacent buttons stay visually distinct at the bigger
  # tap size. Desktop styling is unchanged (no min-height on the base
  # rules). Static-grep only.
  node_test_result test/fr-62-plan-item-mobile-tap-targets.test.js "test/fr-62-plan-item-mobile-tap-targets.test.js (9 cases)"
  # fr-61: #plan-filter-row sticky at top of body scroll. CSS adds
  # position: sticky + top: 0 + opaque background + z-index. JS
  # helper _attachPlanFilterRowToBody relocates the row from being
  # a sibling of #artifact-body-plan to being its first child (so
  # sticky has a scroll-container ancestor to pin against). Called
  # after every plan-path body.innerHTML write so the row survives
  # innerHTML wipes. Static-grep only.
  node_test_result test/fr-61-plan-filter-row-sticky.test.js "test/fr-61-plan-filter-row-sticky.test.js (13 cases)"
  # fr-39: per-session admin delegation. Owners can /admin @user to
  # grant admin (multi-admin supported); admins inherit everything
  # except DELETE-session + grant/revoke admin (those stay
  # owner-only). Locks the 4 helpers in sessions.js, the WS-attach
  # gate flip from sessionBelongsToUser → isOwnerOrAdmin, the
  # DELETE route staying owner-only, and the /admin slash command +
  # owner-only handler gate.
  node_test_result test/admin-delegation.test.js "test/admin-delegation.test.js (19 cases)"
  # fr-87: per-session public/private + `/share @user @user` viewer
  # delegation. Locks the viewer-tier helpers in sessions.js, the
  # private-by-default tightening on fileApiPreamble + WS attach, the
  # listSessions widening (forUser includes viewer-shared rows) and
  # visibility metadata, and the /share owner-only slash command with
  # multi-user grant parser.
  node_test_result test/fr-87-share-slash-command.test.js "test/fr-87-share-slash-command.test.js (29 cases)"
  # fr-88: WS-disconnect blocking modal. Pre-fr-88 the #conn-overlay
  # was a floating pill that didn't intercept clicks; per user request
  # the reconnect window now upgrades to a full-viewport dimmed modal
  # blocking all interaction. Locks: showConnOverlay's new `blocking`
  # arg, the styles.css .blocking modifier (position:fixed +
  # pointer-events:auto + dim backdrop), hideConnOverlay's cleanup of
  # the .blocking class, and that ONLY the close→reconnect call site
  # passes blocking=true (initial-connect sites keep the lighter pill).
  node_test_result test/fr-88-ws-reconnect-blocking-modal.test.js "test/fr-88-ws-reconnect-blocking-modal.test.js (11 cases)"
  # fr-88r (regression): "Stuck on connecting" — user-reported symptom
  # caused by fr-87's tightened WS gate (403 on upgrade for unauthorized
  # users) interacting with fr-88's blocking modal to produce an
  # unrecoverable retry loop. Fix: track wsEverOpened per WS instance
  # plus a consecutiveHandshakeFailures counter in the outer connect()
  # closure; after 3 close-before-open events stop retrying and show a
  # non-blocking error overlay so the user can pick another session.
  node_test_result test/fr-88r-handshake-failure-stops-retry.test.js "test/fr-88r-handshake-failure-stops-retry.test.js (10 cases)"
  # fr-87r (regression): GET /sessions?all=1 bypassed fr-87's user
  # filter, leaking every owner's private sessions to every auth'd
  # user. Fix: the route now ALWAYS passes the auth'd user to
  # listSessions; ?all=1 keeps the URL shape but loses gate semantics.
  # User-reported as "i logged in as kkrazy and i can see demo001"
  # (Demo001 was owned by labxnow with no admins/viewers).
  node_test_result test/fr-87r-sessions-all-flag-leak.test.js "test/fr-87r-sessions-all-flag-leak.test.js (7 cases)"
  # bug-41: AskUserQuestion had no escape hatch — Esc just hid the
  # modal, leaving the agent stuck on the canUseTool Promise; users
  # had no way to cancel or supply free-text when no option fit.
  # Fix: auto-append synthetic Other + Cancel options to every
  # AskUserQuestion menu (server-side, _askNextSubQuestion); branch
  # on the synthetic flag in resolveMenuPick (cancel→behavior:deny,
  # freeText→answer="Other" + chat-input focus); Esc on client now
  # picks the Cancel synthetic so the agent unblocks instead of
  # silently hanging.
  node_test_result test/bug-41-askuserquestion-escape-hatch.test.js "test/bug-41-askuserquestion-escape-hatch.test.js (12 cases)"
  # fr-86: /clear new — soft-reset slash command. Existing /clear
  # (wipes rec.chat, anyone) is unchanged; /clear new is the new
  # owner+admin path that PRESERVES rec.chat + nulls sdkSessionId so
  # next message spawns a fresh Claude conversation. Graceful stop:
  # if a turn is in flight, replies "🔄 restart pending — waiting
  # for <task>" and defers the actual restart to the iteration's
  # emit('idle') hook. Broadcasts state-update chat-pane-reset
  # (distinct from chat-clear) so clients wipe visible pane while
  # history remains scrollable via load-older.
  node_test_result test/fr-86-clear-new-restart-session.test.js "test/fr-86-clear-new-restart-session.test.js (19 cases)"
  # fr-87 (the second, id-allocator reuse): Config page MVP — let
  # regular users manage their own PATs via a web modal instead of
  # typing /setpat in chat. Adds listAllPats + remove[User|Repo]Token
  # helpers, 5 /config/pats routes (auth-required, NEVER returns raw
  # token), a #config-modal in index.html, and a click handler on
  # #user-stamp that opens it (sign-out moved INTO the modal).
  # Security invariant locked in tests: GET response shape is
  # metadata-only (present + last4), never raw value.
  node_test_result test/fr-87-config-page-pats.test.js "test/fr-87-config-page-pats.test.js (17 cases)"
  # bug-43: mobile HUD + critic-select overflow. User-reported as
  # "HUD too wide on mobile and 'critic: gemini' button takes space
  # that should belong to the text input". Pure-CSS fix:
  # @media (max-width:600px) caps .composer-critic-select to 90px,
  # makes .hud-task-text max-width viewport-aware, and tightens
  # .chat-hud-task padding. Static-grep guards verify those rules
  # exist + cite bug-43 so a future restyle doesn't silently lose
  # the fix.
  node_test_result test/bug-43-mobile-hud-critic-overflow.test.js "test/bug-43-mobile-hud-critic-overflow.test.js (5 cases)"
  # bug-45: mobile HUD layout — round 2 of mobile HUD UX. bug-43
  # stopped the @media (max-width: 600px) horizontal overflow, but
  # the HUD was still hard to use on phones — text was 11–13px
  # (below iOS readable floor), the Stop button was thumb-tiny
  # (3×8px padding ≈ 22px tall, well under Apple HIG's 44px tap
  # target), and the 4-step Analysis→Writing→Verification→Critique
  # timeline horizontally-scrolled inside a 24px-tall strip so the
  # user couldn't see all 4 steps at once. Fix extends the same
  # @media block: font-size bumps (.hud-task-text → 14px, badges +
  # timeline-step + status → 12px), Stop gets min-height:36px +
  # 8px×14px padding + 13px font, timeline switches to flex-wrap:
  # wrap + overflow-x: visible so the steps reflow to 2 rows.
  # Static-grep guards lock each rule + the bug-45 marker so a
  # future restyle doesn't silently revert to "everything inherits
  # desktop values + overflow-x: auto".
  node_test_result test/bug-45-mobile-hud-layout.test.js "test/bug-45-mobile-hud-layout.test.js (26 cases)"
  # bug-44: Config page not visible on mobile pre-session. Pre-fix
  # the only Config entry was the @login chip in #status-bar at
  # the BOTTOM of the sidebar — users overlooked it and thought
  # Config was gated until a session opened. Fix: dedicated
  # #btn-config sidebar-header icon (mirrors btn-admin/btn-manual
  # pattern) that opens the same fr-87 Config modal. Hidden until
  # state.chatUser is set. Static guards lock the markup, click
  # binding, auth gate, and bug-44 marker comment.
  node_test_result test/bug-44-mobile-config-entry.test.js "test/bug-44-mobile-config-entry.test.js (5 cases)"
  # fr-87 r2: merge system-wide admin config into the user Config
  # modal for users with admin access. Adds #config-admin-section
  # (allowlist + env config) inside #config-modal, positioned between
  # PATs and Account. Show/hide driven by GET /api/admin/config 200
  # vs 403 (server-side requireAdmin gate from f71495f is the SoT).
  # IDs use config-admin- prefix to avoid collision with the
  # standalone admin pane (#admin-wrap) which is retained as a
  # parallel entry. Static guards lock structure + ordering + ID
  # uniqueness + endpoint wiring.
  node_test_result test/fr-87-r2-admin-merge.test.js "test/fr-87-r2-admin-merge.test.js (9 cases)"
  # fr-87 r3: bug-44 CSS regression + mobile-friendly Config modal.
  # The bug-44 fix added #btn-config to the sidebar header HTML but
  # the CSS sizing/hover/active rules keyed only on #btn-manual +
  # #btn-admin — the user-cog SVG rendered without dimensions and
  # collapsed to a thin sliver (the user's "vertical bar"). Fix
  # extends each rule to include #btn-config. Plus @media
  # (max-width:600px) for #config-dialog/.config-pat-form/.config-
  # pat-row so the PAT section is usable on a 360px phone.
  node_test_result test/fr-87-r3-mobile-config.test.js "test/fr-87-r3-mobile-config.test.js (7 cases)"
  # fr-87 r4: single Config icon. The user-cog #btn-config (added by
  # bug-44) was removed; the gear icon (#btn-admin) is repurposed as
  # THE Config affordance — click opens the unified Config modal
  # (PATs for everyone + admin merge for admins), visible to any
  # authed user. Hardcoded admin login-list gate moved from the
  # client-side btn-admin visibility into the server's /api/admin/
  # config 200/403 probe (which decides whether the admin SECTION
  # inside the modal renders). Standalone #admin-wrap pane is
  # orphaned but its markup is kept for now.
  node_test_result test/fr-87-r4-single-config-icon.test.js "test/fr-87-r4-single-config-icon.test.js (7 cases)"
  # fr-26: git commits authored by the session owner's GitHub identity.
  # Resolves {login, githubId} from auth-sessions.json → noreply email
  # form (<githubId>+<login>@users.noreply.github.com), injected as
  # GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL / GIT_COMMITTER_NAME /
  # GIT_COMMITTER_EMAIL into the SDK env. Env vars trump .git/config,
  # so every git invocation by the agent's Bash tool — including in
  # cloned subdirs — gets the right attribution. Locks the pure
  # buildIdentity logic (4 cases) + auth.profileByLogin export +
  # agent-session.js static-grep guards for the env-injection wiring.
  node_test_result test/fr-26-git-author-identity.test.js "test/fr-26-git-author-identity.test.js (10 cases)"
  # bug-46: /artifact/vote returned 403 for any authenticated user
  # who wasn't the session owner / admin / explicit viewer (fr-87
  # private-by-default gate). But the voters[] schema +
  # AUTO_EXECUTE_VOTE_THRESHOLD = 2 quorum design explicitly
  # supports cross-user voting as the collaborative-prioritisation
  # signal. Fix: new 'authed' tier in fileApiPreamble (server/src/
  # index.js) that requires auth but bypasses owner/admin/viewer/
  # share-token checks. /artifact/vote switched to that tier; all
  # other session endpoints stay on 'owner' or 'viewer'. Locks the
  # tier choice on the route, the existence of the 'authed' branch
  # in fileApiPreamble, and the bug-46 marker comments in both
  # files.
  node_test_result test/bug-46-vote-cross-user.test.js "test/bug-46-vote-cross-user.test.js (5 cases)"
  # bug-47: Guest users with viewer permission saw an empty File
  # Explorer because the client's authedFetch only attached the Bearer
  # token — it never appended `?s=<shareToken>`. fileApiPreamble('viewer')
  # therefore fell through every access tier and returned 401 on
  # /files, /files-changed, /files/diff, /files/reconsider. Fix
  # introduces a `_withShareToken(url)` helper in web/public/app.js
  # that appends `s=<token>` (picking `?` vs `&` automatically) when
  # state.shareToken is set, and wraps each viewer-tier file-API URL
  # with it (loadFileTree, loadPlanChangedFiles, the verdict-panel
  # discard/accept handlers, the inline-diff fetcher, and the
  # reconsider POST). Static-grep guards lock the helper definition
  # + each callsite wrapping its URL + the bug-47 marker comment.
  node_test_result test/bug-47-guest-files-share-token.test.js "test/bug-47-guest-files-share-token.test.js (6 cases)"
  # bug-47 r2: the r1 fix wired _withShareToken into the file-API
  # URLs, but state.shareToken was only set in ONE place — the
  # bootstrap path at the top of app.js that requires `?s=<token>` in
  # the page-load URL. Any subsequent visit (refresh, click a saved
  # sidebar card from a different tab) landed with state.shareToken
  # empty even though the share entry was still saved in localStorage.
  # _withShareToken became a no-op, the file-API returned 401, and the
  # File Explorer rendered empty — exactly the @kkrazy re-dispatch of
  # bug-47. The r2 fix rehydrates state.shareToken inside openSession()
  # by calling loadShareTokens() and matching `sessionId === id` so a
  # user with multiple saved shares picks the right token. For owned
  # sessions, state.shareToken is explicitly cleared. Static-grep
  # locks the loadShareTokens() call, the state.shareToken assignment,
  # the sessionId-keyed lookup, and the bug-47 marker — all inside the
  # openSession() body.
  node_test_result test/bug-47-r2-share-token-hydrate-on-open.test.js "test/bug-47-r2-share-token-hydrate-on-open.test.js (4 cases)"
  # bug-47 r3: labxnow (a logged-in user, not a share-link guest) was
  # getting 403 on the file-API on mycobeta even though the user had
  # added them as viewer/admin. Root cause: the access-tier check was
  # implemented FOUR times in server/src/sessions.js — once each in
  # isOwnerAdminOrViewer / isOwnerOrAdmin / listSessions filter, plus
  # inline inside index.js fileApiPreamble. Three of those four copies
  # contained an identical hardcoded carve-out granting global access
  # to {labxnow, kkrazy, ryan-blues} (added in f71495f as a dev-mode
  # shortcut). fileApiPreamble was the only copy WITHOUT the carve-out
  # — so labxnow could see + attach to any session via the helper-using
  # paths but got 403 on /files. The fix extracts resolveAccessTier
  # (sessionId, user) → 'owner' | 'viewer' | null as the single source
  # of truth and has all four call sites delegate to it. Carve-out
  # lives in ONE place (GLOBAL_OWNER_USERS Set). Locks: the new
  # resolveAccessTier exists + is exported, returns the 3 documented
  # values, isOwnerAdminOrViewer delegates to it, the carve-out is
  # de-duplicated, fileApiPreamble references the helper, and a
  # bug-47 r3 marker comment exists.
  node_test_result test/bug-47-r3-access-tier-unified.test.js "test/bug-47-r3-access-tier-unified.test.js (6 cases)"
  # bug-48: SDK `system` events with task-lifecycle subtypes
  # (task_started / task_progress / task_notification) were falling
  # through to the unknown_event passthrough on the client, which
  # short-circuits with a console.warn — leaving the user with no
  # visible status for things like "Deploy 533fbfe to mycodev". Per
  # @kkrazy's plan-item comment, the fix routes them through the
  # existing chrome batch (not standalone rows) "to ensure ui
  # cleaness". Server: agent-session.js _handleEvent promotes the 3
  # documented subtypes to type 'system_event' BEFORE the
  # unknown_event fallback (future SDK system subtypes still surface
  # via unknown_event, visible to devs). Client: 'system_event'
  # added to AGENT_CHROME_TYPES so it folds into the chrome batch,
  # plus _chromeEventLine + _chromeShortLabel branches render the
  # description / subtype / status. Static-grep guards lock the
  # server emission + 3-subtype coverage + ordering vs. unknown_event,
  # and the 3 client touch-points + bug-48 marker.
  node_test_result test/bug-48-system-event-chrome-batch.test.js "test/bug-48-system-event-chrome-batch.test.js (7 cases)"
  # bug-49: replace the plan-item trash button (hard-delete) with the
  # existing close affordance (.artifact-item-close → POST
  # /artifact/mark). Trash button HTML, onArtifactItemDelete handler,
  # event wiring, DELETE /artifact/item server route, and 7
  # .artifact-item-delete CSS rules all removed. fr-47 had already
  # retired the dual-purpose checkbox in favor of an explicit Close/
  # Reopen button; bug-49 finishes the lifecycle consolidation so
  # plan items have exactly one button for closing — keeps the item
  # in the array with all comments/votes/run-history (close = mark
  # done, reopen = unmark). Existing tests bug-39 / fr-62 / fr-77
  # that locked the trash button's existence updated to reflect the
  # new contract. Static-grep guards on the deleted symbols + the
  # surviving .artifact-item-close button + a bug-49 marker.
  node_test_result test/bug-49-trash-becomes-close.test.js "test/bug-49-trash-becomes-close.test.js (9 cases)"
  # close-icon: locks the icon contract on the .artifact-item-close
  # button (post-bug-49 sole lifecycle affordance for plan items).
  # Iteration history: r0 'check' (✓) — user "checkmark isn't obvious
  # close"; r1 'x' (×) — user wanted more options; r2 'check-popout'
  # (hand-rolled composite per user sketch — checkmark whose tail
  # pokes through the top-right of a closed circle, reads as "mark
  # complete with emphasis"). The reopen branch is locked at
  # 'rotate-ccw' across all iterations.
  node_test_result test/close-icon.test.js "test/close-icon.test.js (2 cases)"
  # fr-89 Phase 1: self-growing critic.md to persist effective critic
  # rules + anti-patterns across sessions. Phase 1 (per AskUserQuestion
  # — auto-growth deferred to a future dispatch) ships:
  #  · server/templates/critic.md — researched myco-shipped default
  #    (Core principles / Anti-patterns to flag / Things-NOT-to-flag
  #    calibration / Project-specific lessons section).
  #  · server/src/critique.js _loadProjectCriticRules() reads
  #    <project>/_myco_/critic.md on every critique run and APPENDS
  #    to the base systemPrompt. On first run for a project the
  #    helper seeds the file from the shipped template (per @kkrazy
  #    "myco default … replicate to all myco managed projects").
  #    After seeding the project owns the file — template updates
  #    do NOT overwrite local edits.
  #  · this project (_myco_/critic.md) is initialized with the
  #    bootstrapped copy. Locks: template exists with the documented
  #    section headers, critique.js loads + seeds + appends to the
  #    prompt + handles missing/unreadable file gracefully, this
  #    project's _myco_/critic.md exists with template content, and
  #    a fr-89 marker comment is present.
  node_test_result test/fr-89-critic-md.test.js "test/fr-89-critic-md.test.js (8 cases)"
  # fr-94 Phase 1: designate one main project per session workspace
  # for _myco_/ storage. Phase 1 (auto-detect migration of existing
  # sessions deferred to a future dispatch — per AskUserQuestion):
  #  · rec.mainProject field on the session record; resolveMycoDir
  #    (artifacts.js) honors it before falling back to legacy auto-
  #    detect.
  #  · resolveMycoDir + findProjectRoot + MYCO_DIR promoted to public
  #    exports so the three stragglers (agent-session.js,
  #    critique.js, index.js diagrams) delegate to the helper instead
  #    of hand-rolling `path.join(absCwd, '_myco_', ...)` — closes
  #    the dual-_myco_ drift where events.jsonl/critic.md/diagrams
  #    were going to session-root while plan.json went to the project
  #    subdir.
  #  · spawnSession grows opts.gitCloneUrl + opts.mainProjectName.
  #    URL → clone into <absCwd>/<inferred-name>; plain text → mkdir
  #    <absCwd>/<sanitized-name>. rec.mainProject is set + spawnAgent
  #    cwd is anchored at the subdir so process.cwd() matches the
  #    project, not the session-root wrapper.
  #  · Spawn modal grows a single "Main project" input + app.js
  #    sniffs URL vs name and forwards as gitCloneUrl / mainProjectName.
  #    This session migrated by hand: rec.mainProject = 'myco'.
  node_test_result test/fr-94-main-project.test.js "test/fr-94-main-project.test.js (13 cases — incl. r1 critique-response guards)"
  # fr-94 Phase 2: lazy migration for legacy sessions that were
  # spawned BEFORE fr-94 Phase 1 landed (no rec.mainProject set).
  # migrateMainProjectIfNeeded(rec, saveStoreFn) is called once per
  # WS attach from _attachAgentWebSocket in attach.js. It's
  # idempotent (no-op when mainProject is already set), conservative
  # (no-op when session-root itself is a `.git/`-marked repo —
  # findProjectRoot's legacy path already returns absCwd there), and
  # safe on multi-repo workspaces (logs a warning + leaves unset
  # instead of silently picking one repo over another — same
  # silent-picking failure mode Phase 1 r1 fixed for the explicit
  # case). When exactly ONE subdir contains `.git/`, sets
  # rec.mainProject = that name + persists via saveStoreFn. Locks
  # the helper definition + public export + no-op corners + scan
  # filter + multi-candidate warn + persistence + attach.js wiring
  # + fr-94 Phase 2 marker comment.
  node_test_result test/fr-94-phase-2-migrate.test.js "test/fr-94-phase-2-migrate.test.js (9 cases)"
  # fr-94 Phase 3: the gitCloneUrl branch of spawnSession no longer
  # blocks on a sync clone — _kickoffGitCloneAsync pre-creates the
  # empty project dir, returns the inferred project name immediately,
  # and a setImmediate-deferred _runGitCloneInBackground runs the
  # actual `git clone --progress` via child_process.spawn. stderr
  # lines (where --progress writes) are throttled (~500ms) and piped
  # through _emitCloneMsg, which dual-pipes via appendChatMessage
  # (persists to rec.chat for fresh-attach catch-up) AND attachMod
  # .getSession(id).emit('chat', msg) (live broadcast to already-
  # attached WS clients). rec.cloneState ∈ {pending, success, failed}
  # tracks state; rec.cloneUrl preserves the URL for diagnostics. The
  # CLAUDE.md inject is deferred until clone success — pre-clone the
  # project dir must stay empty or git clone fails on "destination
  # not empty". Locks: _kickoffGitCloneAsync defined + setImmediate
  # deferral + non-async signature, _runGitCloneInBackground using
  # child_process.spawn (not spawnSync) with --progress, stderr→
  # appendChatMessage routing, _emitCloneMsg dual-pipe semantics,
  # rec.cloneState='pending' + rec.cloneUrl on the gitCloneUrl
  # branch, CLAUDE.md inject guarded by cloneState + re-called on
  # success, and a "fr-94 Phase 3" marker comment.
  node_test_result test/fr-94-phase-3-async-clone.test.js "test/fr-94-phase-3-async-clone.test.js (7 cases)"
  # fr-94 Phase 3 r1: user-reported "the main project shouldn't be
  # optional". The spawn-modal field is now REQUIRED — every NEW
  # session must designate one main project up front so _myco_/
  # (plan.json, critic.md, events.jsonl, diagrams) has a canonical
  # home from the first event. Legacy sessions with no rec.mainProject
  # keep working via Phase 2's lazy auto-migration; the required-
  # field gate applies only to NEW spawns. Three layers locked: the
  # HTML <input> carries `required` + the <label> says "required"
  # (not "optional"), doSpawn() short-circuits empty before the POST
  # with an inline error, and POST /sessions returns 400 when neither
  # gitCloneUrl nor mainProjectName is provided (defense in depth
  # against a stale client). The guard fires BEFORE spawnSession is
  # called — no half-spawned sessions on validation failure.
  node_test_result test/fr-94-phase-3-r1-main-project-required.test.js "test/fr-94-phase-3-r1-main-project-required.test.js (5 cases)"
  # fr-92: mobile users can't access composer history since touch
  # devices have no arrow keys. Add a touchstart + touchend listener
  # on #chat-input that detects vertical swipes (|dy| >= 30px in
  # <= 600ms, single-touch only) and dispatches a synthetic
  # KeyboardEvent('keydown', {key: 'ArrowUp' | 'ArrowDown'}) so the
  # existing arrow-key handler's state-machine runs unchanged — no
  # duplication of the history-step + draft-save logic. The swipe
  # handler also positions the cursor at start (Up) / end (Down)
  # before dispatch so the existing handler's cursor-position guard
  # accepts the synthetic event. Locks: touchstart + touchend on
  # input, synthetic ArrowUp/ArrowDown KeyboardEvent dispatch, cursor
  # repositioning, distance + time thresholds, multi-touch skip, and
  # a fr-92 marker comment.
  node_test_result test/fr-92-mobile-swipe-history.test.js "test/fr-92-mobile-swipe-history.test.js (7 cases)"
  # bug-50: user-reported "critic message is not display in full".
  # Root cause: .verdict-critique had max-height: 180px capping the
  # visible critique to ~10 lines on desktop — long Gemini verdicts
  # (multiple flagged issues + diff-line citations) ended up
  # scroll-trapped inside a tiny window. Bumped max-height from
  # 180px → 60vh so most critiques fit at a glance on both desktop
  # and mobile. overflow-y: auto stays as a safety net for the rare
  # extreme case. Locks: max-height is NOT the regressing 180px,
  # max-height IS a generous viewport-relative or large-px value,
  # overflow-y: auto kept as safety net, and a bug-50 marker
  # comment exists near the rule.
  node_test_result test/bug-50-critic-message-full-display.test.js "test/bug-50-critic-message-full-display.test.js (6 cases)"
  # fr-81 r1: @kkrazy reported the remote /fr /bug /td flow shipped
  # short captures verbatim to GitHub — the word-count threshold that
  # made sense for local plan items (quick captures stay quick) was
  # also applied to remote issues, which goes to a public bug tracker
  # where Problem/Expected/Actual format is always worth the extra
  # rewrite call. Fix: in the remote branch only, set shouldRewrite =
  # true unconditionally. Local plan-item branch keeps the threshold.
  # Locks: the remote-branch shouldRewrite assignment is `= true`, the
  # local-branch shouldRewrite still uses the threshold, and a fr-81
  # marker exists.
  node_test_result test/fr-81-r1-always-rewrite-remote.test.js "test/fr-81-r1-always-rewrite-remote.test.js (3 cases)"
  # fr-81 Phase B.1: auto-promote a freshly-filed remote issue into a
  # local plan item carrying meta.remoteUrl. The user-confirmed
  # promotion model — every successful /feature or /fr @target call
  # also writes a local row tagged source='auto-promote' with the
  # remote URL stamped in meta. This creates the dedup anchor that
  # Phase B.2 (dedup at render), B.3 (close-detection mirror), and
  # B.4 (write-back-on-close) will key against. Idempotent: a second
  # call for the same remoteUrl returns the existing row. Both
  # callsites (handleRemoteIssue, handleIssue) wrap the helper in
  # try/catch so a promote failure cannot break the user-facing
  # "filed" reply. Locks: helper defined, meta.remoteUrl set on the
  # new item, idempotency find() short-circuit, source='auto-promote'
  # tag, _persistPlanArtifact persistence path, both callsites + the
  # try/catch best-effort policy.
  node_test_result test/fr-81-phase-b1-auto-promote.test.js "test/fr-81-phase-b1-auto-promote.test.js (9 cases)"
  # fr-81 Phase B.2: dedup remote issues vs local plan items. Builds
  # on Phase B.1's auto-promote anchor (meta.remoteUrl on every
  # /feature + /fr @target local row). At Plan-view render time,
  # remote-issues.getForSession scans rec.artifacts.plan.items for
  # known remoteUrls + filters the upstream fetch to drop rows
  # whose htmlUrl matches. The visible half: each local item that
  # carries meta.remoteUrl renders a 🔗 chip (artifact-item-remote)
  # linking to upstream; the Remote-issues section header shows
  # "(N linked above)" so the user can see dedup happened. Locks:
  # _collectLinkedRemoteUrls helper, getForSession dedup filter,
  # dedupedCount + linkedCount on the cached entry, server route
  # forwards both counts, client remoteChip + linked-suffix
  # rendering, CSS for both, and the end-to-end behavior via the
  # withPatchedGitHosts harness — input has 3 remotes + 2 local
  # links → output has 1 remote + dedupedCount=2, plus a backward-
  # compat no-op pass for pre-B.1 sessions.
  node_test_result test/fr-81-phase-b2-dedup.test.js "test/fr-81-phase-b2-dedup.test.js (11 cases)"
  # fr-81 Phase B.3: close-detection mirror. During the same
  # remote-issues refresh as Phase A/B.2, ALSO fetch CLOSED upstream
  # issues. For each closed remote whose URL matches a local plan
  # item's meta.remoteUrl AND the local item isn't already done,
  # flip done=true + stamp meta.closedRemotely=true +
  # meta.closedRemotelyAt=<iso>. Persists via sessions.saveStore +
  # broadcasts an artifact state-update on the live session bus so
  # attached Plan views refresh without a reload. Guarded by
  # `linkedUrls.size > 0` — no wasted closed-API call on pre-B.1
  # sessions. Idempotency: already-done items aren't re-stamped on
  # subsequent refreshes. Locks: _mirrorClosedRemoteIssues helper
  # with state='closed' fetch, the done/closedRemotely/
  # closedRemotelyAt mutations, the already-done short-circuit,
  # saveStore + state-update broadcast, the linkedUrls guard, the
  # mirroredClosedCount surface, and three end-to-end cases via
  # withPatchedDeps that monkey-patch gitHosts + sessionsMod.saveStore.
  node_test_result test/fr-81-phase-b3-close-mirror.test.js "test/fr-81-phase-b3-close-mirror.test.js (10 cases)"
  # fr-81 Phase B.4: write-back on local close. Closes the Phase B
  # loop. When the user marks a local plan item done (POST
  # /sessions/:id/artifact/mark with done=1) AND the item carries
  # meta.remoteUrl from Phase B.1's auto-promote, also send a PATCH
  # state=closed to the upstream GitHub/Gitee issue. Four guards:
  # (1) done flipped FALSE→TRUE (uncheck does NOT reopen upstream —
  # out of scope); (2) item.meta.closedUpstreamAt already set
  # (idempotency); (3) item.meta.closedRemotely (Phase B.3 mirror
  # already closed it on behalf of upstream); (4) type === 'plan'
  # only (test/arch items have no upstream). Best-effort: a
  # closeIssue failure logs but doesn't block the HTTP response —
  # local close already happened. On success, stamps
  # meta.closedUpstreamAt + re-broadcasts the plan artifact so
  # attached Plan views see the link badge update. Locks:
  # gitHosts.closeIssue (GitHub PATCH + Gitee PATCH form-encoded
  # with owner-in-path quirk same as createIssueGitee), exported
  # from git-hosts.js, returns {ok, number, url} on 2xx + {error,
  # status} otherwise, rejects missing required fields before the
  # HTTP call, _fireRemoteCloseAsync extracted from the route for
  # readability + test seam, route-level guards (beforeDone snap,
  # !beforeDone && done, no-double-fire, type=plan), and helper-
  # level "no token on file" skip with a log.
  node_test_result test/fr-81-phase-b4-write-back.test.js "test/fr-81-phase-b4-write-back.test.js (12 cases)"
  # td-33: stage-aware critic + retry button. Two-part feature:
  # (A) When the critic returns a "(call failed: …)" / missing-key /
  # error envelope, the verdict panel grows a ↻ Retry button. Click
  # → POST /sessions/:id/critique/retry → server pulls
  # rec._lastCritique (cached on every fire) + re-runs Gemini
  # against the same diff + claudeOutput + item. Idempotency-safe:
  # 404 when no critique on file. (B) Stage-aware critic via
  # sentinel text — claude announces stage boundaries in its
  # assistant text ([stage: analyze done] / [stage: code done] /
  # [stage: verify done]). agent-session.js parses them via
  # _detectStageSentinels (case-insensitive, three-stage alternation
  # only, per-turn dedup via Set), emits stage-done on the session
  # bus. attach.js subscribes + fires triggerGeminiCritique with
  # isIntermediate=true + stage name. Intermediate critiques
  # broadcast a verdict (with [Checkpoint: stage] badge) but do NOT
  # pause the run queue — pre-td-33 final-critique behavior
  # preserved. CLAUDE.md template grew a §9 "Stage-aware critic"
  # section telling claude the exact sentinel shape + when to emit.
  # Locks: triggerGeminiCritique opts param, _looksLikeCriticError
  # error-detection regex + startsWith('(') gate, rec._lastCritique
  # cache, retryLastCritique helper, !isIntermediate guard on queue
  # pause, isError + isIntermediate + isRetry + stage broadcast
  # fields, _detectStageSentinels method + per-turn _firedStages
  # dedup + emit('stage-done'), attach.js subscription + intermediate
  # critic call inheriting the dispatch-drift filter, POST /critique/
  # retry route, client ↻ Retry + Checkpoint badge rendering,
  # styles.css verdict-btn-retry + verdict-intermediate-badge +
  # verdict-title.error, and template section naming td-33.
  node_test_result test/td-33-stage-aware-critic-and-retry.test.js "test/td-33-stage-aware-critic-and-retry.test.js (22 cases — incl. r1 Gemini-critique catch: queue-pause AFTER critic + Dismiss on error)"
  # td-33 r2: critic context enrichment. User-comment from @kkrazy:
  # "should always make enough information is provided to the critic
  # for full assessment". Pre-r2, the prompt contained ONLY the diff
  # hunks — surrounding file context + plan-item iteration history
  # were invisible. The critic kept bailing with INSUFFICIENT
  # INFORMATION on changes that would have been clear with full
  # context. r2 adds two new prompt blocks. _buildFileContextBlock
  # reads each changed file's FULL current content (16 KB per-file
  # cap, 64 KB aggregate cap, truncation marker on overage; path
  # resolution mirrors attach.js — fs.readFileSync(path.join(rec
  # AbsCwd, entry.path))). Returns "" when no entries passed so
  # intermediate critiques without the plumbing fall back to pre-r2
  # behavior. _buildHistoryBlock surfaces last HISTORY_RUNS_MAX (3)
  # runs + last HISTORY_COMMENTS_MAX (5) comments, most-recent-first,
  # capped at HISTORY_BLOCK_MAX_CHARS (16 KB). basePrompt rewritten
  # to acknowledge the new context inputs (no longer claims "you can
  # ONLY see the diff"). attach.js passes opts.changedEntries at
  # BOTH invocation sites (final + stage-intermediate). rec.
  # _lastCritique caches changedEntries; retryLastCritique forwards.
  # Locks: both helpers defined, named caps, file-context read via
  # path.join(recAbsCwd, entry.path) + slice for per-file cap,
  # empty-entries fallback, runs+comments enumeration with named
  # caps via slice + reverse, ${fileContextBlock} + ${historyBlock}
  # in the userPrompt template, basePrompt rewrite + td-33 r2
  # marker, cache + retry forwarding, both attach.js callsites pass
  # changedEntries, marker comment in both touched files.
  node_test_result test/td-33-r2-critic-context-enrichment.test.js "test/td-33-r2-critic-context-enrichment.test.js (13 cases)"
  # td-33 r3: persistent 3-stage discipline directive in
  # web/public/best-practices-template.md §9. User-requested in
  # chat: "The critic should be kicked off at each stage: analyze,
  # code, test. Find a way to break the entire implementation into
  # those 3 stages" + "Make the methodology persistent" + "Auto-
  # iterate — address critic's points + re-fire stage critique up
  # to 2 times before pausing." r3 rewrites §9 with MUST directive
  # language (was descriptive "tends to move through"), adds
  # explicit done-criteria per stage (analyze: restated problem +
  # numbered plan + assumptions + ZERO source edits; code: source +
  # test + new test passes; verify: adjacent suites + test.sh
  # wiring + grep regression check), adds an auto-iterate clause
  # with a hard 2-retry cap, adds a behavioral-honesty note that
  # the auto-iterate is directive-based (not server-enforced —
  # server logs sentinels for post-hoc audit but doesn't auto-queue
  # synthetic prompts), limits scope to [run:plan#X] dispatches
  # (bare chat turns don't trigger stage critiques), and lists
  # common pitfalls (premature emission, skipping analyze on
  # "simple" tasks, mis-scoping verify). Locks: MUST directive,
  # done-criteria per stage incl. ZERO-edits during analyze + test
  # .sh wiring during verify, auto-iterate 2-cap, behavioral
  # honesty marker, all 3 sentinel shapes preserved, scope
  # limitation, pitfalls section, td-33 r3 marker comment.
  node_test_result test/td-33-r3-stage-discipline-directive.test.js "test/td-33-r3-stage-discipline-directive.test.js (8 cases)"
  # fr-95: specialized Test-Validity + Perf/Security critics with
  # cache-optimized prompt layout. Two new critic specialty modules
  # under server/src/critics/specialties/ (general + test-validity +
  # perf-security), an orthogonal axis from the model wrappers in
  # critics/{gemini,codex,custom}.js. critique.js fans out the three
  # specialties on FINAL critiques (each gets its own
  # specialty.systemSuffix appended to a shared systemPromptPrefix —
  # cache-friendly layout, stable prefix first / variable input
  # last), runs general-only on INTERMEDIATE (stage-done) critiques
  # to keep checkpoints cheap, concatenates verdicts under markdown
  # section headers, and broadcasts a single critique-review WS
  # frame with per-specialty {id, name, isError, isAgreed}. The
  # GENERAL critic still gates the run queue; specialty verdicts
  # are informational. Locks: 3 specialty modules with correct
  # exports + domain content, registry exports FINAL/INTERMEDIATE
  # lists in correct order, critique.js fan-out loop + cache-
  # friendly prompt layout + general-gates-queue contract + single
  # broadcast with specialties metadata.
  node_test_result test/fr-95-specialty-critics.test.js "test/fr-95-specialty-critics.test.js (15 cases)"
  # bug-52: critic must explain its reasoning on ✓ AGREED + user can
  # ask the critic to look into something specific via a textarea on
  # the verdict pane. Consolidates three user-reported observations:
  # (1) "when the critic agrees, should still show the reasoning of
  # the agreement with explanation" — the prompt previously told
  # Gemini to write JUST "✓ AGREED" so several runs came back as
  # bare 8-char sentinels with no reasoning. (2) "Should let user
  # decide if there is anything user want the critic to look into
  # by providing an input field." (3) "Currently it just say agreed
  # and then continue" — resolved by (1)+(2) making the verdict
  # pane worth pausing on. Fix: prompt now requires 2-4 sentences
  # of reasoning AFTER ✓ AGREED + warns against the bare-sentinel
  # shape so future prompt-tighteners don't regress. New
  # opts.userPrompt on triggerGeminiCritique (capped at 2KB) gets
  # appended as a "[USER FOLLOW-UP — give this priority]" block in
  # the user prompt. retryLastCritique + POST /critique/retry route
  # both accept + forward it. Verdict pane gains a
  # #verdict-user-prompt-input textarea between the critique body
  # and the action row; Retry button reads + JSON.stringify's it
  # into the POST body. Locks: prompt reasoning + bare-AGREED warn,
  # opts.userPrompt read + 2KB cap, USER FOLLOW-UP priority block,
  # retryLastCritique forwarding, route body forwarding, client
  # textarea + placeholder hint, retry handler reading textarea +
  # JSON Content-Type + body field, CSS for the three classes.
  node_test_result test/bug-52-critic-reasoning-and-user-prompt.test.js "test/bug-52-critic-reasoning-and-user-prompt.test.js (9 cases)"
  # bug-53 (critic-popover textarea has no clear submit affordance):
  # user-reported "When i ask question in the critic popover, not
  # sure which button to click, it's not clear how the question is
  # handled." Pre-fix the textarea was wired only to ↻ Retry on
  # error/intermediate states, and was DEAD UI on the final-verdict
  # state (no Discard/Fix/Accept button routed to /critique/retry).
  # Even on error/intermediate, "Retry" reads as "redo what just
  # happened" not "send my question." Fix: 💬 Ask Critic button in
  # the actions row on ALL 3 states, rendered FIRST so it visually
  # belongs to the textarea above. Disabled when textarea is empty
  # (live-toggled by `input` listener); enabled on non-whitespace
  # content. Same /critique/retry endpoint as bug-52's textarea
  # wiring — server-side userPrompt handling was already in place.
  # Purple/lavender visual identity (matches verdict-intermediate-
  # badge) distinguishes it from Claude's amber ⚡ Ask Claude to Fix
  # button (which routes to Claude, not the critic). Locks: button
  # HTML constant, label/icon, initial-disabled, first-position in
  # all 3 branches, input listener + trim-length toggle, click
  # handler POST to /critique/retry with userPrompt, in-flight label,
  # failure reset + alert, CSS rules for base/disabled, purple ident.
  node_test_result test/bug-53-ask-critic-button.test.js "test/bug-53-ask-critic-button.test.js (11 cases)"
  # bug-55 (verdict pane is now truly modal): user-reported "the
  # critic popover is not modal, click outside of it made the popover
  # disappear and no way to bring it back again." Pre-fix (bug-50 r2)
  # the backdrop-click + Esc were wired for `isError || isIntermediate`
  # states as an escape hatch, but the explicit ✗ Dismiss button on
  # those states already provided that path, and once outside-click
  # fired, state.critiqueReview was wiped — verdict gone forever, no
  # recovery. bug-55 removes the entire safeToDismissByBackdrop
  # branch; dismissal is now ALWAYS explicit (✗ Dismiss / ↻ Retry /
  # 💬 Ask Critic / ✗ Discard / ⚡ Ask Claude to Fix / ✓ Accept).
  # This brings the verdict pane in line with the rest of the app's
  # modal pattern (bug-31 + bug-41 already removed backdrop-dismiss
  # from the perm modal for the same reason). Locks: no
  # safeToDismissByBackdrop declaration / gate, no backdrop click
  # handler that checks e.target===panel, no document.addEventListener
  # for keydown Esc inside _renderVerdictPanel, no dead dismissPanel
  # helper, modal CSS envelope preserved (position:fixed inset:0),
  # exactly 4 state-wipe sites (one per explicit button), bug-55
  # comment block explicitly notes the bug-50 r2 supersession.
  node_test_result test/bug-55-verdict-pane-truly-modal.test.js "test/bug-55-verdict-pane-truly-modal.test.js (8 cases)"
  # bug-54 (critic popover stays open after being handled on another
  # device/user): user-reported "Critic popover stays open after being
  # handled on another device/user." Pre-fix the four resolving
  # buttons (✗ Dismiss / ✗ Discard / ⚡ Ask Claude to Fix / ✓ Accept
  # Claude) cleared LOCAL state only — other attached devices stayed
  # showing a stale verdict pane. Discard/Fix/Accept did hit the
  # server (queue/resume) but their broadcasts (runQueue/artifact)
  # didn't carry a signal the client could interpret as "clear the
  # pane." ✗ Dismiss didn't hit the server at all. Fix: new
  # POST /sessions/:id/critique/resolve route emits state-update
  # { kind: 'critique-resolved', itemId, reason }; client WS handler
  # clears state.critiqueReview + awaitingVerdict on receipt
  # (idempotent guard for the originating device's own broadcast).
  # ↻ Retry and 💬 Ask Critic don't call resolve — they re-fire,
  # which produces a fresh critique-review broadcast that naturally
  # syncs. Locks: server helper + route + viewer-gate, client WS
  # case + idempotent guard, single _broadcastCritiqueResolved
  # helper called by exactly 4 buttons (Retry/Ask Critic deliberately
  # excluded — verified by call-site count = 5: 1 decl + 4 calls).
  node_test_result test/bug-54-cross-device-verdict-sync.test.js "test/bug-54-cross-device-verdict-sync.test.js (9 cases)"
  # bug-57 (_activeRunItem cleared on first turn_result, breaking
  # 3-stage critic methodology): user-observed empirically "how come i
  # didn't see critic kicked off during implement of fr-95." Pre-fix
  # attach.js:361/381 cleared session._activeRunItem on EVERY
  # turn_result; the §9 directive's 3-stage methodology (analyze →
  # accept → code → accept → verify → accept) spans multiple turns,
  # so stages 2 + 3 fired without _activeRunItem set → stage-done
  # handler bailed → no intermediate critique. Fix: track
  # _sawStageSentinelInRun (true when stage-done fires; false on new
  # [run:plan#X] dispatch); on turn_result success, conditionally
  # clear only when no sentinel seen (legacy one-shot preserved).
  # Add clearActiveRunItem helper + POST /sessions/:id/run/done route
  # wired from verdict-pane's ✓ Accept (verify stage) + ✗ Discard via
  # _broadcastRunDone client helper. Foundational for fr-96 (state
  # machine) and bug-56 (intermediate Accept button). Locks: stage-
  # sentinel tracking on both ends, success-path conditional clear,
  # abort/fatal unconditional clear, helper signature + idempotent
  # itemId guard + queue-advance, route + viewer auth, client helper
  # called by exactly 2 buttons (discard + accept-verify), bug-57
  # marker in all 3 touched files.
  node_test_result test/bug-57-active-run-item-lifetime.test.js "test/bug-57-active-run-item-lifetime.test.js (12 cases)"
  # bug-56 (intermediate verdict pane missing ✓ Accept Stage + ⚡ Ask
  # Claude to Fix Stage buttons): with the §9 3-stage methodology
  # (analyze → accept → code → accept → verify → accept) each
  # checkpoint needs its own accept/fix paths, not just the final
  # critique. Pre-fix the intermediate pane only had ↻ Retry + ✓
  # Dismiss (+ 💬 Ask Critic from bug-53) — no way to signal "this
  # stage is good, proceed to next" or "Claude, redo this stage."
  # Fix: 2 new buttons on intermediate. Accept Stage sends Claude a
  # [stage-accept] chat message with the next-stage hint via
  # _nextStage helper ({analyze→code, code→verify, verify→null});
  # broadcasts critique-resolved('accept-stage') for cross-device
  # sync via bug-54 wiring. Fix Stage sends a [stage-fix] chat
  # message including review.critique so Claude sees the specific
  # issues. Neither calls _broadcastRunDone — only the FINAL critique
  # Accept ends the run (bug-57). CSS: accept-stage = green family
  # (matches verdict-btn-accept); fix-stage = lavender family
  # (matches verdict-btn-fix). Locks: 2 buttons in HTML, labels with
  # correct icons, both click handlers wired (sendChatMessage +
  # broadcast), neither calls _broadcastRunDone, _nextStage helper
  # encodes the 3-stage progression, CSS rules with correct color
  # families, bug-56 marker in app.js + styles.css.
  node_test_result test/bug-56-intermediate-accept-fix-stage-buttons.test.js "test/bug-56-intermediate-accept-fix-stage-buttons.test.js (11 cases)"
  # fr-96 (server-side per-plan-item stage state machine): the §9
  # 3-stage methodology (analyze → critic → user accept → code →
  # critic → user accept → verify → critic → user accept) needed a
  # PERSISTENT, OBSERVABLE state surface — pre-fr-96 the current
  # stage of a multi-stage run was implicit in chat sentinels +
  # _activeRunItem (bug-57). Fix: new server/src/stageState.js pure-
  # function module (initStageState, applyTransition, clearStageState,
  # nextStage, toBroadcastPayload) + attach.js helpers
  # (_initAndBroadcastStageState, _transitionStageState,
  # _clearAndBroadcastStageState) wired into 4 hook points: (1)
  # [run:plan#X] dispatch initializes to analyze.in_progress; (2)
  # [stage: X done] sentinel transitions to X.awaiting_verdict; (3)
  # critique broadcast transitions to X.awaiting_accept; (4)
  # clearActiveRunItem (run done / discard) clears the state.
  # critique.js's resolveCritique extended to handle reason ===
  # 'accept-stage' (advance via nextStage) + 'fix-stage' (redo same
  # stage). Broadcast: state-update kind:'plan-item-stage' with
  # { itemId, stageState: { stage, status, updatedAt } } —
  # toBroadcastPayload strips history[]. Persisted in
  # rec.artifacts.plan.items[].meta.stageState (survives container
  # restart). Client: WS handler updates state.planItemStages;
  # _rebuildPlanItemStagesFromArtifacts derives from artifact cache
  # on attach (no separate fetch — meta.stageState ships with
  # artifacts-init). _getHUDActiveStep prefers the authoritative
  # server stage state over the heuristic fallback. Locks: pure-
  # function unit tests on the state machine, all 4 hook wirings,
  # critique.js resolve branches, client WS + HUD wiring, fr-96
  # marker in all 4 touched files.
  node_test_result test/fr-96-plan-item-stage-state-machine.test.js "test/fr-96-plan-item-stage-state-machine.test.js (23 cases)"
  # td-34 (§9 directive rewrite — user-driven 5-step loop SUPERSEDES
  # td-33 r3's auto-iterate clause): empirically observed in the
  # same session that shipped fr-95 / bug-53 / bug-55 / bug-54 /
  # bug-57 / bug-56 / fr-96 that the td-33 r3 auto-iterate language
  # didn't deliver human-in-the-loop discipline — claude barreled
  # through analyze → code → verify without giving the user a
  # chance to review each checkpoint verdict. User-reported:
  # "during the process it automatically moved to next stage before
  # I accept the result of the check point verdict, it should
  # pause until I accept". td-34 replaces the auto-iterate clause
  # with the explicit pause-and-await-accept 5-step loop:
  #   1. stage → 2. stage critic → 3. next stage if accepted →
  #   4. rerun critic if follow-up question is provided →
  #   5. rerun stage if asked to fix (back to step 2)
  # Accept signal vocabulary defined: ✓ Accept Stage / ✓ Accept
  # Claude button OR chat phrases (accept/yes/looks good/proceed/
  # ship it/✓/bare stage name). Silence ≠ accept. The "no continue/
  # proceed/code keyword needed" clarification is captured AND
  # distinguished from "no signal needed" in the pitfalls. Cross-
  # refs all related items (fr-95, bug-53, bug-54, bug-55, bug-56,
  # bug-57, fr-96). 3 stages + done-criteria + sentinel grammar
  # preserved from td-33 r3 (only the progression rule changed).
  # Locks: td-34 supersession marker, 5-step loop enumeration,
  # accept-signal vocabulary, silence-not-accept rule, follow-up /
  # fix routing via buttons, cross-references, preserved stages,
  # auto-iterate clause REMOVED.
  node_test_result test/td-34-stage-directive-user-driven-progression.test.js "test/td-34-stage-directive-user-driven-progression.test.js (16 cases)"
  # bug-58 (critic verdict modal overflows chat window width):
  # user-reported "The critic verdict modal renders wider than the
  # chat window, breaking the layout. Expected: Modal width matches
  # the chat window width. Actual: Modal spans outside the chat
  # window bounds." Pre-fix the verdict pane was position:fixed
  # inset:0 (per bug-55 r2) which covered the WHOLE viewport — on
  # wide screens with sidebar chrome the backdrop extended past
  # chat-window edges. Fix: position:absolute scopes the modal to
  # the nearest positioned ancestor (#chatpane, itself
  # position:absolute inset:0) so the modal width == chat-window
  # width. Padding 5vh/5vw → 20px (vh/vw is misleading inside a
  # sub-viewport container). Content-card max-height 90vh → calc(
  # 100% - 40px) (parent-relative, accounts for the parent's 20px
  # top/bottom padding). bug-55's truly-modal contract (button-only
  # dismissal) is UNCHANGED — the dismissal wiring lives in JS, not
  # CSS. Bug-50 r2's modal-overlay shape contract is preserved
  # (still a positioned, inset:0, z-indexed centered modal — just
  # absolute instead of fixed). Locks: position:absolute (NOT fixed),
  # inset:0 + z-index preserved, pixel padding (NOT vh/vw), calc-
  # based max-height (NOT 90vh), flex centering preserved, max-width
  # 960px preserved, overflow-y:auto preserved, bug-55 JS dismissal
  # absence preserved, bug-58 marker comment with provenance.
  node_test_result test/bug-58-verdict-modal-chat-pane-scoped.test.js "test/bug-58-verdict-modal-chat-pane-scoped.test.js (8 cases)"
  # bug-61 (pause enforcement — server drops + client guards stale
  # broadcasts): user-reported "the analyze stage verdict didn't
  # pause the process, it eventually get overriden by the final
  # stage overall verdict popover." Root cause: fr-96's state
  # machine was OBSERVABLE (transitions to awaiting_accept) but not
  # ENFORCED — nothing physically stopped claude from emitting a
  # second [stage: X done] sentinel while the previous verdict was
  # still pending review, and the client's critique-review WS
  # handler replaced state.critiqueReview unconditionally. Fix: two
  # paired guards. (1) SERVER (attach.js stage-done handler): before
  # transitioning + firing the critic, check the current stageState
  # via stageStateMod.getStageState(item); if status is
  # awaiting_verdict (critic in flight) OR awaiting_accept (user
  # reviewing), DROP the sentinel + log + return — claude must wait
  # for ✓ Accept Stage / ⚡ Ask Claude to Fix Stage before another
  # sentinel can fire. (2) CLIENT (app.js critique-review WS handler):
  # race-safety net. If state.critiqueReview is already showing an
  # unresolved intermediate verdict (awaitingVerdict && critiqueReview
  # && isIntermediate && !isError), DROP incoming intermediate
  # broadcasts unless msg.isRetry is true (Retry/Ask Critic
  # explicitly allowed). Final (non-intermediate) broadcasts also
  # pass — turn_result's final critique is the run-completion
  # summary. This finally makes the §9 pause-and-await-accept
  # methodology physically real instead of directive-only. Locks:
  # server guard reads getStageState + checks both awaiting_* states
  # + short-circuits via return + sits BEFORE _transitionStageState
  # + handles undefined stageState (legacy one-shot dispatches);
  # client guard reads awaitingVerdict/critiqueReview/isIntermediate
  # + exempts isRetry + exempts !isIntermediate (finals) + exempts
  # isError + short-circuits via return; bug-61 marker in both files.
  node_test_result test/bug-61-pause-enforcement.test.js "test/bug-61-pause-enforcement.test.js (10 cases)"
  # bug-64 (final critique on turn_result overwrites unresolved
  # intermediate verdict — bug-61's pause gates were incomplete):
  # user-reported (myco4) "before the first stage (analyze) stage
  # verdict is accepted, the overall verdict is also popped up. the
  # process should be paused until an verdict is accepted." Root
  # cause: bug-61 server gate only checks stageState in the
  # stage-done handler; the FINAL critique on turn_result success
  # fires from a separate code path (attach.js:298 IIFE) that
  # didn't check stageState. Symmetrically, bug-61's client guard
  # exempted !msg.isIntermediate so the client's critique-review
  # handler replaced the intermediate verdict modal with the final
  # one. Fix: two paired guards mirroring bug-61's pattern. (1)
  # SERVER DEFER (attach.js turn_result IIFE): check stageState
  # via stageStateMod.getStageState(item) before triggerGeminiCritique;
  # if status is awaiting_verdict/awaiting_accept, stash the
  # payload (itemId/item/diff/claudeOutput/changedEntries/deferredAt)
  # in rec._deferredFinalCritique + saveStore + return. The deferred
  # fires from critique.js::resolveCritique on reason==='accept-stage'
  # via fire-and-forget triggerGeminiCritique then sets
  # rec._deferredFinalCritique = null. clearActiveRunItem (Discard /
  # verify-Accept) drops the deferred without firing. (2) CLIENT
  # BUFFER (app.js critique-review WS handler): race-safety net.
  # If currentIsUnresolvedIntermediate && !msg.isIntermediate &&
  # !msg.isRetry, stash msg in state.deferredFinalCritique + return.
  # New _replayDeferredFinalCritique() helper surfaces the buffered
  # as if just arrived; called from critique-resolved WS handler,
  # Dismiss button, Accept Stage button. Discard / Fix (final) / Fix
  # Stage explicitly drop state.deferredFinalCritique = null because
  # the deferred is stale (run abandoned / claude redoing). Accept
  # Claude (final) needs no action — by definition no buffer exists
  # when the user is acting on the final itself. Locks: server-side
  # getStageState read before triggerGeminiCritique, payload shape,
  # return short-circuit, resolveCritique accept-stage branch +
  # triggerGeminiCritique fire + null clear, clearActiveRunItem
  # null clear; client-side buffer assignment + return, replay
  # helper signature + render call, ≥3 helper call sites, ≥3
  # buffer-drop sites; bug-64 marker in all 3 files.
  node_test_result test/bug-64-final-critique-defer.test.js "test/bug-64-final-critique-defer.test.js (14 cases)"
  # bug-65 (critic verdicts are generic QA review, not problem-
  # solving validation against the plan-item): user-reported "the
  # verdict must criticize if the proposed solution actually solves
  # the fr/td/bug we are working on. right now it's just a general
  # review of the diff, the analyze result and whether it solves the
  # problem of the fr/td/bug should be our focus." User added:
  # (a) analyze stage must consider item.comments not just item.text;
  # (b) code stage must verify the diff matches the analyze plan;
  # (c) prompts must be extracted to independent files for easy review.
  # Fix: three paired changes. (1) PROMPT EXTRACTION: new
  # server/src/critics/prompts/ directory with base.md + 4 stage-{X}.md
  # files + index.js loader (fs.readFileSync, cached at require-time).
  # Specialty systemSuffix extracted to sibling .md files
  # (general.md, test-validity.md, perf-security.md) loaded by .js
  # shims. (2) PROMPT CONTENT REWRITE: basePrompt reframed from
  # "elite QA auditor" (generic) to "plan-item-driven problem-solving
  # validator" — PRIMARY criterion is now does-it-solve-the-problem.
  # Stage-aware addenda per stage (analyze: plan vs problem; code:
  # diff matches analyze plan via history + solves problem; verify:
  # regression net complete + test.sh wired + future-proof; final:
  # full-run verdict gating queue). (3) USERPROMPT RESTRUCTURE:
  # problem leads. New _buildProblemBlock(item) helper combines
  # item.text + item.comments (per user-asked "consider all of the
  # comments on the plan item"). _buildHistoryBlock no longer
  # includes comments — they moved to the problem block. Per-run
  # summary cap bumped 800→2000 chars so the analyze plan fits when
  # the code-stage critic reads it. Locks: prompts/ directory + files
  # exist; index.js exports base + 4 stage prompts; 3 specialty .md
  # files exist + .js shims load via fs.readFileSync; base.md has
  # PRIMARY+problem framing (no "elite QA" generic-review framing)
  # + ✓ AGREED + ✗ DISAGREE sentinel guidance; stage-analyze.md
  # mentions no-diff + plan + comments; stage-code.md references
  # analyze plan + PLAN ITEM HISTORY + red-flip / pre-fix check;
  # stage-verify.md requires test.sh wiring + regression simulation;
  # stage-final.md mentions queue gating; critique.js requires
  # criticPrompts loader (no inline basePrompt template); stageAddendum
  # references all 4 stage prompts; _buildProblemBlock combines text
  # + comments; _buildHistoryBlock no longer references item.comments
  # (after stripping JS comments); HISTORY_RUN_SUMMARY_CAP = 2000;
  # userPrompt interpolates ${stageAddendum} + ${problemBlock} (not
  # the pre-bug-65 "Task to accomplish: ${item.text}" inline form);
  # bug-65 markers in critique.js + 5 prompt .md files + 3 specialty
  # .md files.
  node_test_result test/bug-65-problem-solving-prompts.test.js "test/bug-65-problem-solving-prompts.test.js (18 cases)"
  # NOTE: the "bug-53" reference in the comment block below is a
  # stale label from an older HUD-stuck issue (eventually shipped
  # under a different plan-item number). It is NOT the same bug as
  # the bug-53 directly above this note.
  # bug-53: HUD active-step chip was stuck on "Analyze" most of the
  # time, only flickering between analyze/code/test. User-reported
  # under the bug-52 dispatch label (dispatch-label-drift) but it's
  # a NEW issue separate from the shipped bug-52. Two-part root
  # cause: (1) _getHUDActiveStep read only state.openToolCalls
  # (tools IN-FLIGHT now), defaulting to 'Analyze' between calls —
  # which is most of the wall-clock time. (2) The tool-progress WS
  # handler didn't call _updateTaskHUD so the chip didn't re-render
  # on tool transitions, only on unrelated state-updates. Fix:
  # state.lastToolPhase sticky tracker (set by tool-progress when
  # Edit/Write/MultiEdit or Bash opens; reset on turn_start), the
  # tool-progress handler now calls _updateTaskHUD, and
  # _getHUDActiveStep falls back to state.lastToolPhase BEFORE
  # defaulting to 'Analyze'. Locks: state init, tool-progress
  # handler verify/code assignment + _updateTaskHUD call,
  # _getHUDActiveStep lastToolPhase checks ordered BEFORE the final
  # return 'Analyze', turn_start reset in _appendAgentEvent, and a
  # bug-53 marker comment.
  node_test_result test/bug-53-hud-stuck-on-analyze.test.js "test/bug-53-hud-stuck-on-analyze.test.js (6 cases)"
  # fr-85 r8 (user comment 2026-06-02T23:15:19 from @labxnow):
  # "add copy button to the popover to copy the selected text. Keep
  # the selected text visually selected for better ux." Two-part fix:
  # (A) Copy button — new #chat-clarify-copy between input and Send,
  # navigator.clipboard.writeText on the selected SPAN TEXT (not the
  # popover question/preview), with execCommand fallback for non-
  # secure contexts. Brief "✓" confirmation then restores 📋. (B)
  # Keep selection visually — the open-time code now wraps the Range
  # in <span class="chat-clarify-anchor chat-clarify-anchor-pending">
  # AT POPOVER OPEN (was only at send before). The -pending class
  # gets a stronger background that mimics native selection. On send
  # → _sendClarify drops the -pending class (graduates to post-send
  # anchor; r4-r7 behavior preserved). On cancel → _closeClarify
  # Popover calls _unwrapClarifyAnchor to revert to plain text so no
  # visual residue remains. Locks: button id + order (input → copy →
  # send), _copyClarifySelection helper using navigator.clipboard +
  # execCommand fallback + "✓" feedback, wired in the lazy-build
  # path, open-time surroundContents using the -pending class,
  # _sendClarify drops -pending, _closeClarifyPopover unwraps on
  # cancel-without-send, _unwrapClarifyAnchor helper restores plain
  # text, .chat-clarify-anchor-pending CSS with stronger alpha than
  # the post-send anchor, #chat-clarify-copy CSS, and a marker
  # comment.
  node_test_result test/fr-85-r8-copy-and-keep-selection.test.js "test/fr-85-r8-copy-and-keep-selection.test.js (10 cases)"
  # fr-81 Phase A: the actual ingest direction. Phase 1 only handled
  # outbound (/feature, /bug write issues upstream). The user-reported
  # gap (Gemini's critique on the previous fr-94 Phase 3 diff: "this
  # is a prerequisite for the overall task of ingesting issues from
  # remote repositories") is the inbound side — Plan view PULLS open
  # GitHub / Gitee issues and renders them with a 🔗 indicator.
  # Layers: git-hosts.fetchIssues (GH + Gitee, normalized rows, PR
  # filter via isPullRequest flag), remote-issues.js cache
  # (CACHE_TTL_MS = 5 min, stale-while-revalidate, MAX_ITEMS_PER_SESSION
  # ceiling), GET /sessions/:id/remote-issues route (fileApiPreamble
  # viewer-gated), and client _loadAndRenderRemoteIssues called from
  # the three Plan render entry points (loadArtifact cached,
  # loadArtifact HTTP, refreshArtifact). Phase B deferred: dedup vs
  # locally-filed issues, close-detection mirror, write-back on
  # close.
  node_test_result test/fr-81-phase-a-remote-issues-ingest.test.js "test/fr-81-phase-a-remote-issues-ingest.test.js (16 cases — incl. r1 critique-response cache-flow tests + force-refresh wiring)"
  # 2026-06-03 critic-infrastructure root-cause fixes (paired with
  # fr-81 Phase A r1 above). Two false-positive critique loops bit
  # this session repeatedly:
  #   (1) CRITIC TRUNCATION — server/src/critics/gemini.js capped
  #       maxOutputTokens at 1024. On >40k-char diffs the model's
  #       preamble consumed the entire budget; the verdict line
  #       (✓ AGREED / flagged-issues) was NEVER WRITTEN. The
  #       run-summary surfaced the truncated preamble as if it were
  #       flagged issues. Fix: raise to 8192 (env-overridable via
  #       MYCO_CRITIC_MAX_TOKENS, floored at 4096 to prevent a
  #       regression).
  #   (2) DISPATCH-LABEL DRIFT — the critique gate fed
  #       listChangedFiles(rec.absCwd) which returns ALL dirty
  #       files. When a [run:plan#X] dispatch fired on an already-
  #       done plan item while UNRELATED WIP sat in the working
  #       tree, the critique attached the WIP to the wrong label
  #       and Gemini reported a mismatch. Fix: _snapshotRunBaseline
  #       captures dirty paths + HEAD when [run:…#id] arrives; the
  #       critique-time filter excludes pre-existing WIP; an empty
  #       filtered diff skips the Gemini call entirely.
  # Locks: critics/gemini.js CRITIC_MAX_OUTPUT_TOKENS constant + 4096
  # floor + MYCO_CRITIC_MAX_TOKENS env read; attach.js
  # _snapshotRunBaseline using execFileSync (sync — chat hot path)
  # for git rev-parse + git status --porcelain with timeouts;
  # [run:…#id] handler attaches baselineDirty + baselineHead;
  # critique gate .filter on changedInfo.entries; the "newEntries.
  # length === 0 → Skipping critique" branch; a marker comment.
  node_test_result test/critic-truncation-and-dispatch-drift.test.js "test/critic-truncation-and-dispatch-drift.test.js (8 cases)"
  # 2026-06-03 critic-key-missing root-cause fix. User-reported:
  # "why the critic is not kicked off?" Diagnosis (reproduced on live
  # mycodev): the container's /data/.env held GEMINI_API_KEY but
  # server/src/index.js had NO boot-time .env loader — only an
  # admin-config UI POST handler. Every container restart wiped
  # process.env back to whatever docker run -e set; GEMINI_API_KEY
  # went undefined; gemini.runCritique returned the literal
  # "(Gemini API key missing…)" placeholder; the critique-review
  # broadcast went out with hasDisagreement=true and a malformed
  # body. The truncation + dispatch-drift fixes shipped earlier
  # today were real but moot — without the key reaching the
  # process, no critic could ever succeed. Fix: vanilla parser
  # IIFE at the very top of index.js, parses $MYCO_STATE_DIR/.env,
  # populates process.env for unset keys (docker -e + host env still
  # win — preserves the ops escape hatch). Locks: loader IIFE
  # defined + ordered before global-agent/bootstrap, honors
  # MYCO_STATE_DIR, explicit don't-overwrite gate using `!= null`
  # (NOT `!process.env[key]` which would clobber empty-string
  # sentinels), "[boot] loaded N env var(s)" log marker, and a
  # runtime sub-process test that extracts the actual IIFE source
  # from index.js + exercises parse + quote-strip + don't-overwrite
  # against a temp .env.
  node_test_result test/boot-env-loader.test.js "test/boot-env-loader.test.js (5 cases)"
  # bug-51: user-reported "in mobile mode, the HUD doesn't reserve
  # enough space for the time ticker, causing the plan item ID to
  # wrap as the ticker widens." Root cause: .hud-task-id is a flex
  # child of .hud-task-title-wrap (also flex); as #hud-duration-text
  # grew from "1s" to "12345s" the .hud-task-status side widened and
  # the title-wrap squeezed its children. .hud-task-text was protected
  # by nowrap + ellipsis + max-width but the ID badge had no
  # protection — it wrapped to a second line on mobile widths once
  # the ticker exceeded 3-4 digits. Fix: add flex-shrink: 0 +
  # white-space: nowrap to .hud-task-id so the chip keeps its
  # natural width and never breaks lines. Squeeze still hits
  # .hud-task-text first (designed to truncate); the ID stays
  # intact.
  node_test_result test/bug-51-hud-id-no-wrap.test.js "test/bug-51-hud-id-no-wrap.test.js (3 cases)"
  # critic-gemini-calibration (2026-06-02): triggered by Gemini
  # returning 404 on the deprecated gemini-1.5-pro model name during
  # a bug-46 run-dispatch critique. Three calibrations land together:
  # (a) model bumps to gemini-2.5-flash (1.5 family is retired);
  # (b) explicit sampling overrides Gemini's chat-tuned defaults
  # (temperature 1.0 → 0.2, topP 0.95 → 0.8, maxOutputTokens 8192 →
  # 1024) — adversarial code review wants determinism + concise
  # verdicts, not creative chat; (c) system prompt carries an
  # explicit "INSUFFICIENT INFORMATION:" opt-out so broad-instruction
  # critics admit uncertainty instead of confabulating verdicts when
  # they can't tell from the diff alone. Locks the model id outside
  # the 1.5 family, sampling values within sensible review caps, the
  # opt-out clause in the prompt, and the exported `name` field
  # syncing with the actual CRITIC_MODEL.
  node_test_result test/critic-gemini-calibration.test.js "test/critic-gemini-calibration.test.js (9 cases)"
  # fr-91: add "Test" buttons next to each of the 4 admin API keys
  # in the Config modal (Anthropic / Gemini / OpenAI / Custom Critic)
  # so users can probe key validity end-to-end before relying on it
  # in real traffic (would have caught the gemini-1.5-pro 404 that
  # blocked bug-46 critic from running). Server: new POST
  # /api/admin/test-key (server/src/index.js) with requireAdmin gate,
  # 4 probe helpers (_probeAnthropicKey hits api.anthropic.com/v1/
  # models, _probeGeminiKey runs a 1-token generateContent on
  # gemini-2.5-flash via the SDK, _probeOpenAIKey hits
  # api.openai.com/v1/models, _probeCustomCriticKey hits the user-
  # supplied endpoint + /v1/models). Client: 4 buttons + inline
  # status spans (web/public/index.html), explicit FR91_BTN_IDS map
  # in app.js so a future restyle can't drift the id contract.
  # Inline warning policy: probe result rendered next to each field,
  # Save proceeds regardless of outcome.
  node_test_result test/fr-91-admin-key-test.test.js "test/fr-91-admin-key-test.test.js (9 cases)"
  # fr-88 (composer-collapse — note: distinct from the older fr-88(r)
  # blocking-modal feature that lives in app.js around line 1764+):
  # the four .composer-btn action buttons (Stop / Mic / Draw / Send)
  # in the chat composer collapse to icon-only when the textarea has
  # non-whitespace content, freeing horizontal space for the typed
  # message. Implementation: bindChatUi() in app.js toggles
  # `.composer-has-content` on #chat-form via the same `input` event
  # the existing autoResize() + _syncGuestSendState() consume; the
  # CSS rule under .composer.composer-has-content hides
  # .composer-btn-label + .composer-btn-kbd (display:none so the
  # slot fully collapses — visibility:hidden would leave a gap).
  # title + aria-label on each button stay so a11y survives. Locks
  # the label/aria markup invariants, the CSS rule, and the JS
  # input-listener wiring; the marker check is anchored ±1500 chars
  # around `composer-has-content` so the unrelated older fr-88(r)
  # comments can't satisfy it by accident.
  node_test_result test/fr-88-composer-collapse-on-input.test.js "test/fr-88-composer-collapse-on-input.test.js (30 cases)"
  # composer side-spacing: user reported "the composer field should
  # have space on the left and right hand side" — pre-fix the
  # #chat-form.composer card sat at 8px lateral margin on desktop /
  # 4px on mobile, looking edge-to-edge against the chat pane. Fix
  # bumps the values to 16px desktop / 12px mobile. Locks the
  # minimum horizontal margin on both rules + a marker comment near
  # both so a future restyle can't silently revert.
  node_test_result test/composer-side-spacing.test.js "test/composer-side-spacing.test.js (4 cases)"
  # fr-38: per-session strict-mode gate. When `/strict on`, claude-
  # bound chat messages MUST include a [run:plan#<id>] marker (the
  # user's affirmation that the turn is backed by an approved td/fr/
  # bug). Messages without the marker get a one-shot reply and do NOT
  # forward to claude. Bypasses: /btw (shouldAskAssistant), special-
  # key interrupt tokens, slash commands, mention messages. Locks the
  # isSessionStrict + setSessionStrict helpers, the _hasRunMarker
  # regex shape, the source-order invariant that the gate fires
  # BEFORE the claude-dispatch shouldAskAssistant call, and the
  # /strict slash command + owner+admin gate.
  node_test_result test/strict-mode-gate.test.js "test/strict-mode-gate.test.js (16 cases)"
  # bug-17: admin grant must propagate to already-attached WSes (the
  # readOnly flag is one-shot at attach time, so rec.admins changes
  # don't reach in-flight viewer connections without a reconnect).
  # Fix: addAdminToSession + removeAdminFromSession call
  # _kickViewerByLogin in attach.js, closing the affected user's WSes
  # so the client reconnects + re-evaluates isOwnerOrAdmin on the
  # new attach. ALSO locks handleAdmin's validation gates: reject
  # ASSISTANT_USER ('claude') + reject targets not in
  # allowed-github-users.txt (auth.isAllowed) when auth is required.
  node_test_result test/bug-17-admin-grant-propagation.test.js "test/bug-17-admin-grant-propagation.test.js (14 cases)"
  # bug-21: parallel canUseTool fires (Claude issues two tool_use blocks
  # in one assistant message) used to overwrite session.pendingMenu and
  # also trip menu.js _supersedeStaleMenus, orphaning the first menu's
  # resolver promise and deadlocking the SDK iteration. Fix moves
  # pendingMenu single-slot → pendingMenus Map<hash, menu> (with a
  # back-compat getter that returns the most-recent), drops the
  # supersede-on-broadcast trigger in menu.js broadcastMenuToChat, and
  # routes the bare-digit chat shortcut through oldestPendingMenu so
  # FIFO head-of-queue resolves first. Also adds a re-evaluate hook in
  # resolveMenuPick so an "Allow always" rule saved on menu B
  # retroactively auto-resolves any pending menu A whose (tool, input)
  # now matches the rule.
  node_test_result test/bug-21-parallel-permission-menus.test.js "test/bug-21-parallel-permission-menus.test.js (16 cases)"
  # bug-21 pattern 2 (reaper-kills-subagent-mid-flight): the 5-min
  # keepalive reaper used to call killSession unconditionally on timer
  # fire — even when an Agent (subagent) or other long-running tool was
  # still in flight (the parent stream is quiet during subagent
  # internal model-thinking, so the parent looks "idle"). Fix in
  # attach.js _onKillTimerFire: read the live AgentSession's
  # openToolCalls.size; defer reap for another 5-min grace slice
  # while > 0; SESSION_MAX_DEFER_MS = 30min hard cap so a genuinely-
  # hung tool can't indefinitely pin a session.
  node_test_result test/bug-21-keepalive-defers-while-tool-in-flight.test.js "test/bug-21-keepalive-defers-while-tool-in-flight.test.js (10 cases)"
  # fr-43: SDK best-practice — _ensureIteration wraps query() in a
  # retry loop. Recoverable errors (rate-limit, transient network
  # blips like ECONNRESET / ETIMEDOUT / EAI_AGAIN / ENOTFOUND / EPIPE,
  # 5xx-flavored upstream errors) re-spawn query() with
  # resume=sdkSessionId after exponential backoff (1s → 4s → 16s).
  # MAX_ATTEMPTS = 3. AbortError (user-initiated Stop) ALWAYS escapes
  # the retry loop immediately; non-recoverable errors (auth 4xx,
  # validation) fatal on first attempt. Emits retry_attempt events
  # for observability + fatal {reason:'retry_exhausted', attempts:3}
  # on cap.
  node_test_result test/fr-43-rate-limit-retry.test.js "test/fr-43-rate-limit-retry.test.js (21 cases)"
  # fr-44: SDK best-practice — resume-failure fallback. When the SDK
  # rejects resume=sdkSessionId because the upstream conversation is
  # gone (container restart wiped $HOME/.claude/projects/, sessionId
  # corrupted on disk, transcript file deleted under us), the initial
  # query() throws → pre-fix fatal → AgentSession dead. Post-fix:
  # _isResumeFailure(err) detects the error class, the init-err branch
  # clears this.sdkSessionId + rec.sdkSessionId (via saveStore),
  # emits resume_failed, and continues the retry loop without
  # incrementing the attempt counter — next attempt has no resume=
  # set so query() spawns a fresh SDK conversation. Multica
  # precedent: daemon/wakeup.go resolveSessionID().
  node_test_result test/fr-44-resume-failure-fallback.test.js "test/fr-44-resume-failure-fallback.test.js (16 cases)"
  # fr-45: SDK best-practice — sdkOpts validator. Hardcoded allowlist
  # of 61 SDK Options field names extracted from sdk.d.ts. Validator
  # runs at the top of every _ensureIteration attempt, logs via
  # console.error on unknown keys. Catches the next bug-14 round 2
  # (silent abortSignal vs abortController typo) before it ships:
  # SDK silently drops unknown keys, so without this gate a typo
  # lives until a user notices missing behavior in production. The
  # test pins the 9 myco-used keys' presence + asserts abortSignal
  # is NOT on the list (negative guard against a careless refactor
  # adding it back).
  node_test_result test/fr-45-sdkopts-lint.test.js "test/fr-45-sdkopts-lint.test.js (13 cases)"
  # bug-40 (user-reported): special chars in a prompt (LaTeX / unicode)
  # 400 the NEXT turn with "thinking or redacted_thinking blocks in the
  # latest assistant message cannot be modified". Root cause: the fr-55
  # lean-ctx sidecar's autonomous compaction-sync REWRITES the Anthropic
  # transcript JSONL (observed 59 MB → 305 KB + .jsonl.bak.<ts> backups),
  # breaking the immutability the API enforces on thinking blocks — every
  # resume then reloads the poisoned transcript and 400s, wedging the
  # session. Fix: (1) prevention — spawn lean-ctx with LEAN_CTX_AUTONOMY=
  # false so it stops rewriting the transcript (ctx_* tools still work);
  # (2) recovery — _isThinkingBlockError(err) classifies the 400 and the
  # init- AND stream-error branches of _ensureIteration treat it as a
  # poisoned resume (clear sdkSessionId, redeliver the in-flight turn,
  # retry fresh), mirroring fr-44's resume-failure fallback.
  node_test_result test/bug-40-thinking-block-resume.test.js "test/bug-40-thinking-block-resume.test.js (16 cases)"
  # bug-40 r2: the `claude` CLI subprocess sometimes CATCHES the API 400 and
  # surfaces it as a normal stream `result` event (subtype:'success',
  # result:<error text>) instead of throwing. bug-40's recovery only fires
  # on thrown errors → the prose-form path was a blind spot, leaving every
  # subsequent turn re-resuming the poisoned transcript (live-reproduced on
  # mycobeta's myco-beta session 2026-05-29; required manual sdkSessionId
  # clear + container restart to unwedge). Fix: shared
  # _isThinkingBlockErrorMessage(text) helper used by both the thrown-error
  # classifier and a new check inside the for-await loop that throws a
  # synthetic Error on m.type==='result' + matching m.result text, routing
  # the failure into the existing streamErr recovery branch.
  node_test_result test/bug-40-r2-prose-form-error.test.js "test/bug-40-r2-prose-form-error.test.js (11 cases)"
  # fr-46: enable edit on plan items (body text + comments) — owner+admin
  # only. Adds PATCH /sessions/:id/artifact/item and PATCH
  # /sessions/:id/artifact/comment routes in artifacts.js, both gated on
  # sessionsMod.isOwnerOrAdmin (fr-39 model). Extends DELETE comment to
  # let owner+admin delete any comment, in addition to author-self-delete.
  # Client adds pencil affordances on item cards + comment rows (gated
  # on !state.readOnly so viewers don't see them). meta.editedBy +
  # meta.editedAt stamped on edit; meta.originalText snapshotted on
  # FIRST edit only (so the very-first version stays recoverable).
  node_test_result test/fr-46-edit-plan-items.test.js "test/fr-46-edit-plan-items.test.js (24 cases)"
  # fr-47: replace the dual-purpose checkbox with explicit Close /
  # Reopen button. Pre-fix the checkbox conflated lifecycle toggle
  # (uncheck → mark done=false) with claude dispatch (check on plan
  # item → POST /artifact/run). Post-fr-48 unification the dispatch
  # path lives on ▶ Run only; the Close button is pure lifecycle
  # (POST /artifact/mark with done=1 / done=0). Negative guard that
  # the close handler does NOT route through /artifact/run.
  node_test_result test/fr-47-close-open-affordance.test.js "test/fr-47-close-open-affordance.test.js (6 cases)"
  # show-creator chip: each plan-item card surfaces "by @<addedBy>"
  # next to the id chip. Hover-title shows the addedAt timestamp.
  # Guards on it.addedBy being truthy so legacy items (filed before
  # the field was tracked) render with no chip (no "@undefined").
  node_test_result test/fr-49-show-creator.test.js "test/fr-49-show-creator.test.js (4 cases)"
  # bug-19: read-only viewer's typed message was silently dropped —
  # handleChatMessage's readOnly + !guest-OK block emitted only the
  # denial reply and returned BEFORE the user text was persisted.
  # Fix: persist + broadcast the user text tagged meta.kind='denied'
  # FIRST, then the denial reply. The user can recover what they typed
  # from chat history; other attached clients see what was tried.
  node_test_result test/bug-19-readonly-preserves-user-text.test.js "test/bug-19-readonly-preserves-user-text.test.js (5 cases)"
  # bug-19 follow-up: client-side Send-button disable. When state.readOnly
  # is true AND the typed text wouldn't pass the server's guest whitelist
  # (no @mention, no allowed slash), the Send button gets disabled +
  # the composer-blocked CSS class flips on — proactive feedback BEFORE
  # round-trip. Predicate _isGuestAllowedText mirrors GUEST_ALLOWED_CMDS
  # in attach.js handleChatMessage exactly; the test pins both ends.
  node_test_result test/bug-19-disable-send-when-blocked.test.js "test/bug-19-disable-send-when-blocked.test.js (5 cases)"
  # fr-48: per-session plan-item run-queue. Users add fr/td/bug items
  # via per-item ⊤ Queue button OR /queue slash; sequential auto-
  # dispatch via turn_result hook in attach.js _registerExternalSession.
  # Auto-pause on failure (resume via /qresume or POST /queue/resume).
  # Owner+admin only. New module server/src/runQueue.js holds pure
  # queue logic; routes in artifacts.js; 5 slash commands in
  # slashcmds.js; client renders pinned chip strip at top of chat pane
  # plus per-item button.
  node_test_result test/fr-48-run-queue.test.js "test/fr-48-run-queue.test.js (22 cases)"
  # fr-48 follow-up: unified queue dispatch — every plan-item invocation
  # (▶ Run button, POST /artifact/run, /artifact/vote auto-quorum)
  # flows through runQueue. _enqueueAndKickIfIdle in artifacts.js is
  # the shared helper; idle queue + Run click = immediate dispatch
  # (kick), busy queue = appended to tail. Claude only ever picks
  # tasks from the queue.
  node_test_result test/fr-48-unified-dispatch.test.js "test/fr-48-unified-dispatch.test.js (4 cases)"
  # fr-48 bugfix: queue slash commands (/queue /qcancel /qclear
  # /qresume) must broadcast state-update via the live session passed
  # in ctx.session — not via a lazy attach.getSession() lookup which
  # silently no-op'd under require-cycle conditions and left the chip
  # strip stale after /qcancel (user-reported regression).
  node_test_result test/fr-48-qslash-broadcast.test.js "test/fr-48-qslash-broadcast.test.js (6 cases)"
  # fr-48 bugfix: queue must see iteration_aborted + fatal as terminal
  # events too (not just turn_result), or a Stop-button interrupt /
  # rate-limit-retry-exhaust leaves the running entry stuck forever.
  # ALSO: runQueue.removeFromQueue accepts {force:true} so /qcancel
  # can recover a stuck running entry. User-reported regression.
  node_test_result test/fr-48-stuck-running-recovery.test.js "test/fr-48-stuck-running-recovery.test.js (6 cases)"
  # fr-48 bugfix (ROOT CAUSE): buildArtifactRunText +
  # buildArtifactQuorumText must prepend the [run:<type>#<id>] marker.
  # Without it, queue dispatch went through handleChatMessage with
  # text that didn't trigger the marker-parsing regex, so
  # session._activeRunItem was NEVER set on queue dispatches → terminal
  # events found null active + short-circuited → queue entries stayed
  # 'running' forever. The 72d7117 listener fix for
  # iteration_aborted/fatal was correct but USELESS without this:
  # _activeRunItem must be set to begin with.
  node_test_result test/fr-48-dispatch-marker.test.js "test/fr-48-dispatch-marker.test.js (4 cases)"
  # fr-51 (run-queue stall): two failure modes that left the queue
  # stuck on bug-13's dispatch in session myco-kkrazy-f80476dd —
  #  (1) handleQCancel removed the running head but never called
  #      peekNextPending / markRunning / buildArtifactRunText, so the
  #      queue had to be /qresume'd manually before any pending
  #      entry could dispatch. Now /qcancel auto-advances.
  #  (2) the agent-event listener short-circuited if
  #      session._activeRunItem was null/undefined, even when the
  #      queue clearly had a `running` entry waiting to be marked
  #      finished. Added belt-and-braces fallback: use the queue's
  #      running entry as the source of truth. [runQueue-diag] log
  #      fires on every fallback so the underlying _activeRunItem
  #      staleness can be root-caused in follow-up.
  #  (3) THIRD-PASS fr-51 (this commit): agent-session.js retry loop had
  #      two no-terminal-event escape paths — (a) `if (!this.alive) break`
  #      when kill() flipped alive while a stream message was in flight,
  #      bypassing AbortError; and (b) clean stream close without ever
  #      sending a `result` message. Both stranded the queue's running
  #      entry. Fix: emit iteration_aborted with stable `reason` strings
  #      (`kill_mid_stream` / `stream_closed_no_result`) on both paths so
  #      the listener can advance the queue.
  node_test_result test/fr-51-queue-advance.test.js "test/fr-51-queue-advance.test.js (12 cases)"
  # bug-12: re-entering a session via the back icon (#btn-expand)
  # used to leave the chat pane hidden on mobile — setSidebar(false)
  # on back-icon-tap cascades into setChatPane(false), and openSession's
  # re-tap early-return only re-collapsed the sidebar without restoring
  # the chat pane. Now setChatPane(true) is wired into the re-tap branch.
  node_test_result test/bug-12-reentry-restores-chatpane.test.js "test/bug-12-reentry-restores-chatpane.test.js (4 cases)"
  # fr-50: in-app file editor (CodeMirror 6) with optimistic-mtime
  # conflict prevention. Swaps the existing textarea-based editor for
  # a CM6 surface (vendored bundle at web/public/vendor/codemirror.bundle.js
  # built via `npm run build:editor`). Adds a proper 409 conflict modal
  # (Reload / Force overwrite / Cancel) replacing the old alert() on
  # ERR_MTIME_CONFLICT. Textarea fallback retained so a vendor bundle
  # hiccup doesn't take editing offline. Server route smoke verifies
  # the existing files.js writeFile mtime gate still rejects stale
  # writes with ERR_MTIME_CONFLICT → HTTP 409.
  node_test_result test/fr-50-file-editor.test.js "test/fr-50-file-editor.test.js (17 cases)"
  # fr-50 hotfix: the ✎ Edit button stayed hidden because
  # openFileInViewer called renderViewerHeader BEFORE v.content was
  # populated (state.files.viewing.content starts as the '' placeholder),
  # so the gate `editable = !viewerMode && v && v.content && !v.binary`
  # evaluated false and stamped hidden=true on #files-edit. Fix: re-call
  # renderViewerHeader(body.path) after the content lands so the gate
  # re-evaluates. Pre-existing latent bug that was masked because the
  # textarea-based editor was never actually reachable — kicking in
  # fr-50's CodeMirror swap exposed it. User-reported via console
  # diagnostic showing all gate conditions satisfied yet hidden=true.
  node_test_result test/fr-50-edit-button-visible.test.js "test/fr-50-edit-button-visible.test.js (5 cases)"
  # fr-49: /whatsnext + /next priority list. Heuristic scoring
  # (voters/comments/layer-bias/recency/run-failure) picks a top-20
  # shortlist; LLM rerank (best-effort, falls back to heuristic on
  # any failure) reorders by reading item text. Cached in
  # plan.whatsNext with a 2-hour refresh-on-read TTL. Read-only;
  # /whatsnext + /next are guest-allowed slash commands (mirror in
  # both attach.js GUEST_ALLOWED_CMDS and app.js _GUEST_ALLOWED_CMDS
  # so the Send button stays enabled for read-only viewers).
  node_test_result test/fr-49-whatsnext.test.js "test/fr-49-whatsnext.test.js (24 cases)"
  # fr-54: /git <args> pass-through to the git CLI in the session
  # workspace. Owner+admin only. Full passthrough (no allowlist, no
  # PAT auto-injection). execFile (not exec) to avoid shell-injection;
  # 60s timeout, 1MB stdout cap, GIT_TERMINAL_PROMPT=0 so creds never
  # block. Includes a shlex-style arg splitter unit test + end-to-end
  # smoke against a real tempdir git repo.
  node_test_result test/fr-54-git-passthrough.test.js "test/fr-54-git-passthrough.test.js (17 cases)"
  # fr-55: lean-ctx (Rust MCP sidecar that compresses file reads +
  # shell output before they hit the LLM context — 60 KB JS file
  # → ~250 bytes via `ctx_read --mode map`). Option A integration:
  # stdio MCP, SDK spawns one `lean-ctx mcp` per session scoped by
  # CTX_PROJECT_ROOT. Dockerfile: install lean-ctx-bin (multi-arch
  # via npm postinstall) + arch-aware Caddy. Best-practices nudge
  # teaches the agent to prefer ctx_read for context-only reads.
  node_test_result test/fr-55-lean-ctx-mcp.test.js "test/fr-55-lean-ctx-mcp.test.js (10 cases)"
  # scripts/deploy.sh post-deploy validation block: runs 5 advisory checks
  # (lean-ctx --version + PATH + log errors + /USER_MANUAL.md HTTP
  # + /vendor/codemirror.bundle.js HTTP) automatically after each
  # successful deploy. Warnings only, never aborts. --skip-post-checks
  # opts out. Static-grep guards on the function + flag + invocation.
  node_test_result test/deploy-post-deploy-checks.test.js "test/deploy-post-deploy-checks.test.js (14 cases)"
  # td-30: Plan view header + chrome icon tooltip must be the single
  # word "Plan" (was "Plan — todos extracted from session" which both
  # crowded the chrome and misled users — the view shows todos AND
  # features AND bugs, not just todos).
  node_test_result test/td-30-plan-label-single-word.test.js "test/td-30-plan-label-single-word.test.js (3 cases)"
  # Login: "Sign in with GitHub" disabled-for-now with strikethrough +
  # Soon badge until OAuth is wired up. Click + keyboard activation
  # neutralized so it can't try to navigate to /auth/github/start.
  node_test_result test/login-github-soon-badge.test.js "test/login-github-soon-badge.test.js (6 cases)"
  # bug-23 (tool_result rendered as its own claude-style bubble) was
  # REVERSED by bug-38 r2 — tool_result now folds back INTO the chrome
  # batch with tool_use + hook_allow. The original
  # test/bug-23-tool-result-bubble.test.js was removed; assert its
  # successor instead. (The dead node_test_result that used to sit here
  # made the parallel runner block on a .exit file node_test_prelaunch
  # never writes — the glob skips nonexistent files — until the 180s
  # budget tripped and reported a phantom failure on every full run.)
  node_test_result test/bug-38-r2-tool-result-fold.test.js "test/bug-38-r2-tool-result-fold.test.js"
  # bug-67: permission_request arriving with a non-consecutive seq must
  # STILL fold into the active chrome batch (not break it + spawn a new
  # one-row "× 1 perm asked · Bash" batch). The seq counter is shared
  # per-session between agent events and chat-msg appends, so a viewer
  # chat-msg or system note interleaving between tool_use and the SDK-
  # driven perm_request creates a seq gap that pre-fix closed the batch.
  # Fix: _chromeEventAlwaysFolds(ev) helper (turn_result + permission_*)
  # used by both seq gates in _appendAgentEvent. turn_result behavior
  # preserved (it had an inline short-circuit before; helper hoists it).
  node_test_result test/bug-67-perm-request-folds-into-chrome-batch.test.js "test/bug-67-perm-request-folds-into-chrome-batch.test.js (16 cases)"
  # bug-67 round 2: the round-1 always-folds helper only checked
  # whether prev IS directly the chrome batch. broadcastMenuToChat
  # appends a .chat-msg.chat-msg-menu div between the chrome batch
  # and any follow-up permission_resolved event (user's interaction
  # surface for the perm-ask), so perm_resolved still went into a
  # fresh batch. Fix adds _findChromeBatchAcrossMenus(pane) — walks
  # backward across chat-msg-menu / chat-msg-menu-collapsed cards
  # to find the underlying chrome batch. Stops at any other non-
  # chrome element (real chat-msg, assistant_text) so genuine
  # semantic breaks still split the batch.
  node_test_result test/bug-67-r2-perm-resolved-folds-across-menu-card.test.js "test/bug-67-r2-perm-resolved-folds-across-menu-card.test.js (16 cases)"
  # bug-70: chat-accept of a verdict (typing "looks good" / "the test
  # worked" / "yes" while a plan item is in awaiting_accept) must fire
  # the same advancement as the verdict-pane button. Pre-fix only the
  # button was wired; chat went to claude unchanged and the queue
  # stayed stuck in awaiting_accept (bug-66 reproduced this). Fix
  # adds _matchAcceptPhrase + _maybeHandleChatAccept in attach.js,
  # gated to skip clarify-tagged messages and routed BEFORE the
  # slash-command branch.
  node_test_result test/bug-70-chat-accept-fires-run-done.test.js "test/bug-70-chat-accept-fires-run-done.test.js (71 cases)"
  # bug-68: intermediate-stage critique passed only the LAST 2KB of
  # claude's turn text to the critic as CLAUDE'S EXPLANATION, so
  # analyze plans (which put structured sections at the HEAD) lost
  # PROPOSED SOLUTION + VERIFICATION STEPS in the tail-2KB window —
  # critic empirically said "Missing Proposed Solution" on bug-66 +
  # bug-69 + bug-68 itself. Fix flips TAIL→HEAD and bumps cap 2KB
  # →32KB at attach.js:262.
  node_test_result test/bug-68-intermediate-critique-explanation-not-truncated.test.js "test/bug-68-intermediate-critique-explanation-not-truncated.test.js (10 cases)"
  # bug-71: verdict pane was rendering Gemini's critique as
  # escHtml-escaped plain text — markdown markers (# Headings,
  # **bold**, ```code fences```) and mermaid blocks all showed as
  # literal characters. Fix replaces escHtml with renderMd + post-
  # processes the .verdict-critique container with
  # renderMermaidInContainer so mermaid blocks become SVG diagrams.
  # Same render path the assistant_text bubble uses.
  node_test_result test/bug-71-verdict-renders-markdown-mermaid.test.js "test/bug-71-verdict-renders-markdown-mermaid.test.js (12 cases)"
  # bug-69: test.sh portability — busybox grep (no PCRE) was failing
  # 26 static checks; missing server/node_modules was failing
  # test_npm_deps + 6 server-smoke tests. Fix added pcre_match() (node-
  # delegated RegExp) + ensure_server_deps() (auto-install) so test.sh
  # runs cleanly on any host with node + npm (the existing hard deps).
  # This regression test is a shell script (not node) — exercises the
  # bash-level helpers directly.
  if bash test/bug-69-test-sh-portability.test.sh > /tmp/bug69-portability.out 2>&1; then
    pass "test/bug-69-test-sh-portability.test.sh (16 cases)"
  else
    fail "test/bug-69-test-sh-portability.test.sh — re-run with 'bash test/bug-69-test-sh-portability.test.sh' to see failures"
  fi
  # bug-25: unknown_event events (server-side passthrough for SDK
  # message types myco doesn't recognize) used to leak into the
  # chat pane as literal "unknown_event" rows + JSON dumps. Now
  # _appendAgentEvent short-circuits them at the top with a
  # console.warn (events.jsonl still records for diagnostics).
  node_test_result test/bug-25-unknown-event-suppress.test.js "test/bug-25-unknown-event-suppress.test.js (7 cases)"
  # bug-24: runqueue chip strip caps finished (last 2) + running (all)
  # + pending (first 3) so busy sessions don't grow an unbounded strip.
  # Dropped counts surface as "+N earlier" / "+N more" overflow chips;
  # /qstatus still shows the full list (no data loss).
  node_test_result test/bug-24-runqueue-strip-cap.test.js "test/bug-24-runqueue-strip-cap.test.js (12 cases)"
  # bug-26: auto-scroll-to-latest respects the user's scroll position.
  # If they've scrolled up to read earlier messages, new messages no
  # longer yank them back to the bottom. Pane open + session switch
  # bypass the guard via { force: true }.
  node_test_result test/bug-26-chat-auto-scroll-suppress.test.js "test/bug-26-chat-auto-scroll-suppress.test.js (13 cases)"
  # bug-32: bug-26 follow-up. _appendAgentEvent had THREE direct
  # `pane.scrollTop = pane.scrollHeight` writes that bypassed bug-26's
  # chatUserScrolledUp guard — chrome events (canUseTool, hook_allow,
  # turn_result, etc.) and streamed assistant_text tokens yanked
  # history-reading users back to the bottom many times per second.
  # Fix: route all three sites through scrollChatToLatest(). Static
  # guards on the absence of pane.scrollTop=pane.scrollHeight in code
  # (allowing `el.scrollTop` for the unrelated log panel), the call
  # count inside _appendAgentEvent, and a behavior simulation of the
  # guard predicate across 50 streaming ticks.
  node_test_result test/bug-32-agent-event-respects-scroll.test.js "test/bug-32-agent-event-respects-scroll.test.js (9 cases)"
  # bug-27: queue chip strip scoped per-session. Client clears
  # state.runQueue + re-renders on session switch; server ships the
  # new session's queue state via _sendAttachSnapshot so the strip
  # populates immediately (not after the first queue mutation).
  node_test_result test/bug-27-queue-session-scope.test.js "test/bug-27-queue-session-scope.test.js (7 cases)"
  # bug-29: deleting the active session must wipe the Plan/Arch/Test
  # panes + artifact cache + run-queue chip strip + token meter — not
  # just close the WS + clear activeId. Same class of bug as bug-27
  # (state leaking across sessions) but on the DELETE flow instead of
  # the SWITCH flow. Static guards on the deleteSessionWithConfirm
  # cleanup block (gated on state.activeId === s.id) + a simulated
  # state-effect assertion.
  node_test_result test/bug-29-delete-clears-plan.test.js "test/bug-29-delete-clears-plan.test.js (9 cases)"
  # bug-66: deleting a session must purge its workspace dir from disk
  # (not just remove the registry entry). Static guards on the helper
  # _removeWorkspaceForDeletedSession + its call site inside
  # deleteSession + runtime assertions that the dir IS gone after
  # delete + safety guards reject paths outside userRoot AND legacy
  # non-id-shape basenames AND forged cross-user rec.
  node_test_result test/bug-66-delete-purges-workspace.test.js "test/bug-66-delete-purges-workspace.test.js (14 cases)"
  # bug-31: AskUserQuestion modal dismissal recovery. Two failure modes
  # the user reported — (a) backdrop outside-click dismissed the prompt
  # accidentally; (b) once dismissed, the chat-pane reopen affordance
  # was invisible (no badge, just whole-row clickable with no cue).
  # Fix: backdrop no longer carries data-perm-defer (dismiss is explicit
  # only — X button + Esc); active menu rows now render a visible
  # .chat-menu-reopen-hint pill ("↗ Tap to answer"). Static guards on
  # both HTML + JS + CSS layers plus a behavior simulation of the
  # state.permModalDismissed flow.
  node_test_result test/bug-31-modal-dismiss-recovery.test.js "test/bug-31-modal-dismiss-recovery.test.js (8 cases)"
  # bug-33: file viewer header is now two stacked rows — nav (back +
  # breadcrumb) on top, actions (edit/save/cancel/wrap/copy) below.
  # Actions row auto-hides via :has(button:not([hidden])) so a
  # non-editable file open keeps the minimal one-row look. Static
  # guards pin the HTML structure (two .files-view-header-row divs,
  # breadcrumb in nav row + 5 actions in actions row, every existing
  # id preserved for fr-50 tests) + the CSS (flex-column parent, 92px
  # right padding on nav row, :has auto-show, crumb ellipsis preserved).
  node_test_result test/bug-33-file-viewer-breadcrumb-row.test.js "test/bug-33-file-viewer-breadcrumb-row.test.js (9 cases)"
  # bug-34: plan-item byline timestamp now includes the date — was
  # formatChatTs (time-only, ambiguous for items days/weeks old);
  # now formatChatTsWithDate ("MMM D, YYYY, HH:MM" via toLocaleString).
  # Scope-limited to the plan-item byline; adjacent comment + Updated
  # banner timestamps deliberately still use formatChatTs (the bug-34
  # report didn't mention them). Static guards on the helper shape +
  # null-safety, the byline call site, behavior simulation on fixed
  # ISO inputs, and a negative guard that the wider formatChatTs use
  # wasn't accidentally swept (scope-creep tripwire).
  node_test_result test/bug-34-plan-item-create-time-shows-date.test.js "test/bug-34-plan-item-create-time-shows-date.test.js (10 cases)"
  # bug-39 (user-reported 2026-05-25): plan-item action-row chips +
  # buttons had drifted to inconsistent heights (font-size 0.7rem to
  # 0.85rem; vertical padding 0-2px; border-radius 3px to 12px; delete
  # button fixed 22×22 while everything else let content drive). One
  # CSS rule under .artifact-item-actions normalizes every chip /
  # button class to min-height: 22px + box-sizing: border-box +
  # display: inline-flex + align-items: center + line-height: 1 — the
  # box stretches to 22px, content vertical-centers, tall emoji glyphs
  # don't push past the declared min-height. Mobile already bumps to
  # 44px via the fr-62 tap-target rule; bug-39 fixes desktop where
  # there was no min-height before.
  node_test_result test/bug-39-action-row-uniform-height.test.js "test/bug-39-action-row-uniform-height.test.js (5 cases)"
  # bug-40 (user-reported 2026-05-25): "plan view has a width limit
  # on desktop there shouldn't be a width limit, also its header
  # should have a padding on top so that the Bug/Feature/Todo buttons
  # have space from the browser boundary." Two CSS fixes inside the
  # @media (min-width: 901px) desktop block: (1) max-width: none on
  # #artifact-body-plan (arch + test keep the 880px readable-line cap
  # since they're prose-heavy; plan items are short rows with chip
  # clusters that just leave wide unused gutters); (2) padding-top:
  # 12px on #plan-filter-row so the sticky filter chips clear the
  # browser chrome edge (mobile already reserves the chrome band via
  # artifact-main-view's padding-top, so this is desktop-only).
  node_test_result test/bug-40-plan-view-desktop-layout.test.js "test/bug-40-plan-view-desktop-layout.test.js (4 cases)"
  # bug-41 (user-reported 2026-05-25): "click outside of the askuserquestion
  # won't have opportunity to bring it back again, the askuserquestion
  # shouldn't disappear when click outside." Defense-in-depth follow-up
  # to bug-31 (which removed data-perm-defer from the backdrop in
  # index.html but left misleading visual cues): backdrop CSS now has
  # cursor: default + pointer-events: none (clicks cannot even reach
  # the handler); hint text drops "click outside to defer"; JS handler
  # comment updated. Pins exactly TWO permModalDismissed=true sites
  # (Esc + X button) so any future "outside-click dismiss" patch would
  # red-flip the test.
  node_test_result test/bug-41-perm-modal-backdrop-no-dismiss.test.js "test/bug-41-perm-modal-backdrop-no-dismiss.test.js (8 cases)"
  # fr-77 (user-reported 2026-05-25): "File explorer makes it hard to
  # see which files have changed and quickly open a diff view."
  # Implementation: split the tree pane vertically — top section is
  # the existing #files-tree (scrollable), new bottom section
  # #files-changed-section lists all git-status-changed files at the
  # project root. Click on a row opens a unified-diff view in the
  # right pane (highlight.js language-diff) instead of the normal
  # editor. New server helpers in files.js: listChangedFiles (caps
  # 500 entries; reuses _gitStatusMap) + readDiff (git diff HEAD --,
  # via safeJoin). Two new viewer-readable routes:
  # /sessions/:id/files-changed + /sessions/:id/files/diff?path=.
  # Section refreshes on showFilesView mount + after _saveFileEdit
  # (so the chip count tracks edits). Tree-collapsed mode hides the
  # new section. Diff view hides the Edit button (read-only).
  node_test_result test/fr-77-files-changed-diff.test.js "test/fr-77-files-changed-diff.test.js (25 cases)"
  # fr-78 (user-reported 2026-05-25): "Chat pane has no in-memory history,
  # so users can't quickly recall prior inputs. Up/down arrow keys cycle
  # through previously submitted messages in the current session."
  # Implementation: state.chatInputHistory (capped 200, dup-of-prev skipped),
  # state.chatHistoryIdx (null when not browsing), state.chatHistoryDraft
  # (saved when browsing starts, restored on Down past most recent).
  # ArrowUp/Down handler in bindChatUi: defers to autocomplete + IME;
  # cursor-position guard preserves multi-line nav (Up only at start, Down
  # only at end). Any non-arrow keystroke exits browsing (keeps recalled
  # text); Esc explicitly clears. Per-session reset via _resetUiForNewSession.
  node_test_result test/fr-78-chat-input-history.test.js "test/fr-78-chat-input-history.test.js (12 cases)"
  # td-31: Docker files consolidated under docker/ folder. Pins the
  # move (Dockerfile + docker-entrypoint.sh under docker/, none at
  # root), the Dockerfile's internal COPY uses the new build-context-
  # relative path, scripts/deploy.sh's `docker build` uses -f docker/Dockerfile,
  # and .dockerignore stays at the build-context root (Docker CLI only
  # honors it there).
  node_test_result test/td-31-docker-folder.test.js "test/td-31-docker-folder.test.js (8 cases)"
  # td-32: test.sh + test-browser.sh moved into test/ alongside the
  # .test.js files they run. Pins the new locations, the absence of
  # the root-level originals, the cwd-anchor `cd "$(dirname "$0")/.."`
  # in both scripts (so relative-path checks resolve from repo root),
  # scripts/deploy.sh's updated invocation, and the CLAUDE.md pre-commit rule's
  # updated path.
  node_test_result test/td-32-test-scripts-folder.test.js "test/td-32-test-scripts-folder.test.js (8 cases)"
  # td-33: deploy.sh + collect-logs.sh + install-tls.sh + install-
  # renewal-hook.sh consolidated under scripts/. Legacy non-Docker
  # server-launch trio (start.sh, myco.service, mycod) deleted because
  # the only documented + tested deploy recipe is Docker via
  # ./scripts/deploy.sh. The user-facing `myco` CLI launcher stays at
  # the repo root because server/src/index.js MYCO_BIN points there.
  node_test_result test/td-33-scripts-folder.test.js "test/td-33-scripts-folder.test.js (16 cases)"
  # td-34: Caddyfile moved into docker/ alongside Dockerfile +
  # docker-entrypoint.sh (its primary build-time consumer). Pins the
  # new location, the absence of the root-level original, the Dockerfile
  # COPY's new path, deploy.sh's updated scp source, and the preserved
  # content (myco.labxnow.ai virtual host + reverse_proxy target).
  node_test_result test/td-34-caddyfile-docker.test.js "test/td-34-caddyfile-docker.test.js (5 cases)"
  # Sidebar user-manual link: icon button beside the "+" New-session
  # button opens an in-app modal that fetches /USER_MANUAL.md (served
  # by an explicit route since the file lives at the project root)
  # and renders it via the existing renderMd → marked.parse path.
  # Esc + click-outside dismiss; content cached on first open.
  node_test_result test/sidebar-manual-link.test.js "test/sidebar-manual-link.test.js (16 cases)"
  # fr-9: file explorer surfaces git change decorators + download
  # button. Tests the server-side listDir gitStatus enrichment
  # (modified/added/untracked/dir-aggregate paths against a real
  # tempdir git repo), the /sessions/:id/file/download route + its
  # Content-Disposition contract, and the client-side renderFilesList
  # + triggerFileDownload helpers including the stopPropagation guard
  # so a download click doesn't ALSO open the file viewer.
  node_test_result test/files-git-decorators.test.js "test/files-git-decorators.test.js (12 cases)"
  # td-4: per-(user, repo) PAT storage + github/gitee provider dispatch
  # for /feature, /bug. Locks the storage shape (per-repo entry wins,
  # user-level fallback for OAuth-issued github tokens), detectHost's
  # github vs. gitee classification across SSH + HTTPS URLs, the
  # provider-specific REST payload construction (gitee uses
  # form-urlencoded + access_token field + /repos/{owner}/issues with
  # repo in the body, NOT /repos/{owner}/{repo}/issues like github),
  # /setpat's single-arg auto-detection of the session's repo, and the
  # github.js back-compat shim's user-level setToken path so the OAuth
  # callback keeps working.
  node_test_result test/gitee-host-dispatch.test.js "test/gitee-host-dispatch.test.js (31 cases)"
  # 2026-05-17 chat persistence + cross-device + ordering contract.
  # Locks the four pillars documented in CLAUDE.md → "Chat persistence
  # & cross-device consistency": (1) every device sees identical
  # state, (2) every user input + every claude reply persisted
  # indefinitely (up to MAX_CHAT_MESSAGES=100k), (3) client memory
  # frugality via byte-capped initial WS frame + load-older paginator
  # with includeAgent=1, (4) strict chronological order in rec.chat,
  # getChatHistory, and the agent-replay client handler. Touching any
  # of those interfaces without keeping this test green is a regression.
  node_test_result test/chat-persistence-contract.test.js "test/chat-persistence-contract.test.js (25 cases)"
  # Architecture doc — Project Purpose section is the canonical
  # statement of why Mycelium exists (on-top-of-project, surface
  # problems, suggest better approaches). Red-flips if someone
  # rewrites the doc and drops it.
  # Root architecture.md was rewritten to lead with "## Thesis" (the
  # 2026-05-21 doc refresh in commit 66b9dcf). The _myco_/ mirror is
  # the legacy/extractor copy and still uses the older "## Project
  # Purpose" heading — eventually it'll sync to the root rewrite. Both
  # are checked separately so each file is pinned against its current
  # canonical shape.
  grep -qF '## Thesis' architecture.md \
    && pass "architecture.md: Thesis section present (post-refresh)" \
    || fail "architecture.md: Thesis section missing — the why-myco statement is gone"
  grep -qF '## Project Purpose' _myco_/architecture.md \
    && pass "_myco_/architecture.md: Project Purpose mirror present" \
    || fail "_myco_/architecture.md: Project Purpose mirror missing — the Arch tab will fall out of sync with root"
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
  node_test_result test/transcript-watcher-safety-poll.test.js "test/transcript-watcher-safety-poll.test.js (3 cases)"
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
  pcre_match "(?i)bare-digit menu pick[\s\S]{0,2000}handleMenuPick\(sessionId" server/src/attach.js \
    && pass "attach.js: bare-digit chat shortcut routes through handleMenuPick" \
    || fail "attach.js: bare-digit chat shortcut bypasses handleMenuPick"
  # Post-bug-21 contract (fix 0eb1289): the supersede-on-broadcast
  # sweep DELIBERATELY does not run from menu.js anymore — it was the
  # cause of the parallel-canUseTool deadlock (orphaning sibling
  # resolver promises). Supersede still runs from
  # sessions.ensureLiveSession on AgentSession respawn (where the old
  # menus genuinely refer to dead resolvers from a killed process),
  # and the helper still lives in attach.js for that caller.
  grep -q "function _supersedeStaleMenus" server/src/attach.js \
    && pass "attach.js: _supersedeStaleMenus helper defined" \
    || fail "attach.js: _supersedeStaleMenus helper missing — respawn cleanup will be a no-op"
  grep -q "_supersedeStaleMenus(sessionId)" server/src/sessions.js \
    && pass "sessions.js: ensureLiveSession sweeps stale menus on respawn" \
    || fail "sessions.js: respawn no longer calls _supersedeStaleMenus — restarted agents will see ghost menu rows"
  # Negative guard against the bug-21 regression: if anyone re-adds
  # supersede-on-broadcast to menu.js, parallel canUseTool fires will
  # deadlock the SDK again (see bug-21 pattern 1 / test/bug-21-
  # parallel-permission-menus.test.js).
  grep -q "_supersedeStaleMenus" server/src/menu.js \
    && fail "menu.js: re-introduced supersede-on-broadcast — bug-21 parallel-tool deadlock is back" \
    || pass "menu.js: NO supersede-on-broadcast (bug-21 pattern 1 fix preserved)"
  # Companion regression: a respawned AgentSession has a fresh
  # _pendingPermissions map; any chat row still flagged kind=menu
  # without answered/superseded refers to a canUseTool promise that
  # no live receiver could resolve. Sweep them all .superseded so
  # the user's chat is a clean slate after a deploy/restart.
  pcre_match "respawned agent[\s\S]{0,1200}_supersedeStaleMenus" server/src/sessions.js \
    && pass "sessions.js: ensureLiveSession sweeps zombie menus on agent respawn" \
    || fail "sessions.js: ensureLiveSession does not sweep zombie menus"
  # Companion regression: a menu state-update (server confirmed pick /
  # supersede) must rebuild the client's modal queue + re-render the
  # popup, otherwise resolved menus stay visible in the modal.
  pcre_match "_applyMenuStateUpdate[\s\S]{0,2500}_rescanPendingMenuQueue\(\)[\s\S]{0,80}_renderPermModal\(\)" web/public/app.js \
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
  #
  # Distance window: 8000 chars from the function header. The handler
  # block sits a few hundred lines into _attachAgentWebSocket, and the
  # function organically grows as features land (e.g. bug-7 round 2's
  # event-dedup pushed it from ~4000 → ~4300 chars). When this red-flips
  # on a future feature, bump the window — the contract is "handler
  # lexically inside the function," not a specific offset.
  pcre_match "_attachAgentWebSocket[\s\S]{0,8000}msg\.t === 'menu-pick'" server/src/attach.js \
    && pass "attach.js: agent WS handles menu-pick frame" \
    || fail "attach.js: agent WS missing menu-pick handler"
  pcre_match "_attachAgentWebSocket[\s\S]{0,8000}msg\.t === 'menu-toggle'" server/src/attach.js \
    && pass "attach.js: agent WS handles menu-toggle frame" \
    || fail "attach.js: agent WS missing menu-toggle handler"
  pcre_match "_attachAgentWebSocket[\s\S]{0,8000}msg\.t === 'menu-submit'" server/src/attach.js \
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
  pcre_match "isMulti[^}]{0,300}checkbox: true" server/src/agent-session.js \
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
  grep -q "menu pick" server/src/attach.js && pass "bare-digit chat shortcuts to menu pick" || fail "menu-pick digit shortcut missing"
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
  # PWA install icon: must be served as image/png so Chrome's
  # manifest-icon validator accepts it. The MIME type is derived from
  # the .png extension by express.static — no explicit handler needed —
  # but it's worth pinning so a future renamed/repackaged file doesn't
  # silently regress to application/octet-stream.
  local ct
  ct=$(curl -sf -o /dev/null -w '%{content_type}' "http://127.0.0.1:$SMOKE_PORT/hetu.png" 2>/dev/null)
  [[ "$ct" == image/png* ]] && pass "hetu.png served as image/png ($ct)" || fail "hetu.png content-type wrong: $ct"
  # And manifest.json must include the icon entry once served (catches
  # a stale-bundle scenario where the Dockerfile COPY missed a layer).
  curl -sf "http://127.0.0.1:$SMOKE_PORT/manifest.json" 2>/dev/null | grep -qF '"/hetu.png' \
    && pass "manifest.json served references hetu.png" \
    || fail "manifest.json served does not include /hetu.png — install icon will fall back"
}

test_index_html_contents() {
  # Use here-strings (`grep -q PAT <<<"$index"`), NOT `echo "$index" | grep -q`.
  # Under `set -o pipefail` (line 3) the pipe form races: `grep -q` short-
  # circuits at first match, the pipe-read end closes, echo's next chunked
  # stdio write (glibc writes the 58KB index in ~4KB chunks) returns EPIPE
  # → echo exits 141 → pipefail propagates 141 → the assertion reads as
  # failure even though the pattern *was* found. The race is host-dependent
  # (mycobeta/glibc hits it; Alpine/musl writes the whole 58KB in one shot
  # and doesn't). Markers near EOF (mermaid/highlight) escape the race by
  # luck of position, but `id="chatpane"` at byte ~8855 reliably loses.
  # Here-strings dump the variable through a temp file — no pipe, no race.
  local index
  index=$(curl -sf "http://127.0.0.1:$SMOKE_PORT/" 2>/dev/null || echo "")
  grep -q 'id="chatpane"' <<<"$index" && pass "index serves chatpane" || fail "index serves chatpane"
  grep -q 'mermaid.min.js' <<<"$index" && pass "index includes mermaid script" || fail "index includes mermaid script"
  grep -q 'highlight.min.js' <<<"$index" && pass "index includes highlight script" || fail "index includes highlight script"
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
  # td-34: Dockerfile moved under docker/. The build context stays
  # at the repo root (.) so the COPY paths inside the Dockerfile
  # (server/, web/public/, USER_MANUAL.md, etc.) still resolve;
  # only the Dockerfile location itself needs -f.
  docker build -t myco-test -f docker/Dockerfile . --quiet 2>&1 && pass "Docker build" || fail "Docker build"
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
{"sessions":{"$PERSIST_SID":{"id":"$PERSIST_SID","user":"alice","cwd":"persist-test","absCwd":"/wks/alice/persist-test","claudeSessionId":null,"createdAt":"2026-01-01T00:00:00.000Z","admins":["bob"],"viewers":[]}},"dismissed":[]}
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

  # Positive (Gitee): posting a Gitee PAT for an allowlisted login mints a session.
  body=$(curl -s -X POST "http://127.0.0.1:$PERSIST_PORT/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"token":"test-gitee-token-bob"}' 2>/dev/null)
  echo "$body" | grep -q '"ok":true' && pass "PAT login: bob (Gitee allowlisted) → ok" \
    || fail "PAT login: bob (Gitee allowlisted) → ok (got: $body)"
  echo "$body" | grep -q '"login":"bob"' && pass "PAT login: Gitee returns user.login" \
    || fail "PAT login: Gitee returns user.login (got: $body)"

  # Verify stashed Gitee token in git-tokens.json on the server/container.
  docker exec "$PERSIST_NAME" cat /data/git-tokens.json | grep -q '"gitee": "test-gitee-token-bob"' \
    && pass "PAT login: Gitee token stashed in git-tokens.json" \
    || fail "PAT login: Gitee token NOT stashed (got git-tokens.json)"

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
  # cwd is already anchored to the repo root at script-top (the
  # BASH_SOURCE-based cd just under `set -euo pipefail`). The legacy
  # `cd "$(dirname "$0")"` here was a no-op when test.sh lived at the
  # repo root; after the td-32 move into test/, it would land us in
  # test/ and undo the anchor, so it was removed.
  run_static_checks
  run_feature_checks
  run_server_smoke
  test_docker_build
  run_persistence_checks
  print_summary
}

main "$@"
