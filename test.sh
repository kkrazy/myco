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
  for f in src/index.js src/pty.js src/sessions.js src/transcript.js src/auth.js src/btw.js src/oauth.js src/text-utils.js; do
    [ -r "server/$f" ] || missing="$missing $f"
  done
  [ -z "$missing" ] && pass "Server JS files readable" || fail "Server JS files (missing:$missing)"
}

test_text_utils() {
  if ! have_node; then skip "text-utils runtime (no host node)"; return; fi
  # Regression: stripAnsi, tailLines, formatChat live in text-utils.js and
  # are consumed by both btw.js (prompt build) and pty.js (scrollback feed
  # for /btw). A regression that swallows ANSI escapes incorrectly or
  # mis-tails would silently feed the assistant garbage.
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
    // pty.js still gets them through the module
    const p = require('./server/src/pty');
    if (typeof p.spawnClaude !== 'function') throw new Error('pty.js failed to load');
  " && pass "text-utils.js: stripAnsi/tailLines/formatChat" \
    || fail "text-utils.js: stripAnsi/tailLines/formatChat"
}

test_frontend_files() {
  for f in web/public/app.js web/public/styles.css web/public/index.html web/public/keyboard.js; do
    test -f "$f" && pass "$f exists" || fail "$f missing"
  done
}

test_pty_patterns() {
  # CLAUDE.md rule: every regex that matches claude's PTY/TUI output
  # lives in server/src/pty-patterns.js. Consumer files reference the
  # named constants; they don't inline the patterns.
  test -f server/src/pty-patterns.js && pass "pty-patterns.js exists" || fail "pty-patterns.js missing"
  if have_node; then
    node -e "
      const p = require('./server/src/pty-patterns');
      const want = [
        'MENU_OPT_MARKER_RE','MENU_LABEL_GAP_RE','MENU_QUESTION_TAIL_RE','MENU_QUESTION_VERB_RE',
        'MENU_KIND_PERMISSION_RE','MENU_KIND_PLAN_RE','TRUST_DIALOG_RE',
        'PERMISSION_TOOL_RE','PERMISSION_INPUT_RE',
        'MODE_ACCEPT_RE','MODE_PLAN_RE','MODE_BYPASS_RE',
        'SPINNER_DURATION_RE','SPINNER_RUNNING_RE',
        'WELCOME_BANNER_RE','LIMIT_WARNING_RE','TUI_KEY_HINT_RE',
      ];
      for (const k of want) {
        if (!(p[k] instanceof RegExp)) throw new Error('missing pattern export: ' + k);
      }
      // Marker pattern: well-formed + claude-malformed YES, decimals NO.
      const re = p.MENU_OPT_MARKER_RE;
      re.lastIndex = 0; if (!re.exec(' 1. Yes'))   throw new Error('marker missed \"1. Yes\"');
      re.lastIndex = 0; if (!re.exec(' 2.Yes'))    throw new Error('marker missed claude-malformed \"2.Yes\"');
      re.lastIndex = 0; if (re.exec('v1.0'))       throw new Error('marker should NOT match \"v1.0\"');
      re.lastIndex = 0; if (re.exec('I have 3.5')) throw new Error('marker should NOT match \"3.5\"');
      // Permission tool: catches both API form AND display form (with space).
      // Caller (permissions.extractPermissionTarget) trims leading whitespace
      // first, so we mirror that here.
      const ptr = p.PERMISSION_TOOL_RE;
      let m = 'Web Search(\"x\")'.match(ptr);
      if (!m || !/web ?search/i.test(m[1])) throw new Error('PERMISSION_TOOL_RE missed display-form \"Web Search\": ' + JSON.stringify(m));
      m = 'WebSearch(\"x\")'.match(ptr);
      if (!m || !/web ?search/i.test(m[1])) throw new Error('PERMISSION_TOOL_RE missed API-form \"WebSearch\": ' + JSON.stringify(m));
      m = 'Allow Bash command?'.match(ptr);
      if (!m || m[1].toLowerCase() !== 'bash') throw new Error('PERMISSION_TOOL_RE missed \"Allow Bash\": ' + JSON.stringify(m));
      // Trust dialog recognizer.
      if (!p.TRUST_DIALOG_RE.test('Quick safety check: Is this a project you created or one you trust?')) throw new Error('TRUST_DIALOG_RE missed safety-check phrasing');
      if (!p.TRUST_DIALOG_RE.test('Do you trust the files in this folder?')) throw new Error('TRUST_DIALOG_RE missed canonical phrasing');
      // Spinner — DURATION variants (-ing only). Tightened to exclude
      // past-tense '-ed for Ns' shapes because those linger above the
      // input prompt AFTER claude is idle and kept the typing dots
      // alive forever (reported as '✻ Brewed for 1m 25s' stuck on
      // screen). The -ed shape is captured separately by SPINNER_DONE_RE.
      const durSamples = ['✻ Working for 12s · esc to interrupt', '✦ Thinking for 3s …',
                          '✻ Cerebrating for 25s', '· Cerebrating for 1m 5s'];
      for (const s of durSamples) {
        if (!p.SPINNER_DURATION_RE.test(s)) throw new Error('SPINNER_DURATION_RE missed: ' + s);
      }
      if (p.SPINNER_DURATION_RE.test('We worked for 12 hours')) throw new Error('SPINNER_DURATION_RE matched prose');
      // Done-with-phase samples must match SPINNER_DONE_RE but NOT the
      // running/duration regexes (that's the whole point of the split).
      const doneSamples = ['✻ Baked for 15s', '✻ Brewed for 51s', '✻ Cooked for 13s',
                           '✻ Churned for 4s', '✻ Brewed for 1m 25s'];
      for (const s of doneSamples) {
        if (!p.SPINNER_DONE_RE.test(s)) throw new Error('SPINNER_DONE_RE missed: ' + s);
        if (p.SPINNER_RUNNING_RE.test(s) || p.SPINNER_DURATION_RE.test(s)) {
          throw new Error('Done-phase line wrongly matched as running: ' + s);
        }
      }
      // Spinner — RUNNING variants (no duration yet, claude is currently in that phase).
      const runSamples = ['✽ Moonwalking…', '· Thundering…', '✽ Crunching', '✻ Working'];
      for (const s of runSamples) {
        if (!p.SPINNER_RUNNING_RE.test(s)) throw new Error('SPINNER_RUNNING_RE missed: ' + s);
      }
      // MODE_ACCEPT_RE must now also recognise the post-plan-confirm 'auto mode'.
      if (!p.MODE_ACCEPT_RE.test('⏵⏵ auto mode on (shift+tab to cycle)')) throw new Error('MODE_ACCEPT_RE missed \"auto mode\"');
      if (!p.MODE_ACCEPT_RE.test('⏵⏵ accept edits on')) throw new Error('MODE_ACCEPT_RE missed \"accept edits\"');
      // Weekly-limit notice surfaced in the status bar.
      if (!p.LIMIT_WARNING_RE.test('You\\'ve used 76% of your weekly limit · resets May 15, 3am (UTC)')) throw new Error('LIMIT_WARNING_RE missed weekly-limit notice');
      // TUI key-hint lines (in-dialog instruction text).
      const hints = ['Enter to confirm · Esc to cancel', 'ctrl-g to edit in Vim · ~/.claude/plans/foo.md',
                     'shift+tab to approve with this feedback', 'Tab/Arrow keys to navigate', 'esc to interrupt'];
      for (const h of hints) {
        if (!p.TUI_KEY_HINT_RE.test(h)) throw new Error('TUI_KEY_HINT_RE missed: ' + h);
      }
      if (p.TUI_KEY_HINT_RE.test(' real prose about shift in a story.')) throw new Error('TUI_KEY_HINT_RE matched prose');
      // Welcome banner.
      if (!p.WELCOME_BANNER_RE.test('Welcome back Ken!')) throw new Error('WELCOME_BANNER_RE missed \"Welcome back\"');
      // Question verbs widened.
      if (!p.MENU_QUESTION_VERB_RE.test('Are you sure you want to continue?')) throw new Error('MENU_QUESTION_VERB_RE missed \"are you sure\"');
      if (!p.MENU_QUESTION_VERB_RE.test('Would you like me to proceed?')) throw new Error('MENU_QUESTION_VERB_RE missed \"would you like\"');
      // Permission target normalisation: extractPermissionTarget must
      // canonicalise \"Web Search\" → \"WebSearch\" so the result feeds
      // allow/deny patterns directly.
      const perms = require('./server/src/permissions');
      const tgt = perms.extractPermissionTarget('  Web Search(\"weather\")\n  Claude wants to search the web for:\n  weather');
      if (!tgt || tgt.tool !== 'WebSearch') throw new Error('extractPermissionTarget did not normalise \"Web Search\" → \"WebSearch\": ' + JSON.stringify(tgt));
      // MENU_LABEL_GAP_RE: 6+ consecutive whitespace chars cuts trailing
      // TUI chrome (box-drawing frame from a side panel) off option labels.
      // Regression: chat-pane picker showed labels like
      //   '[1] Single container ┌────────────────────────────┐'
      // because the wide alignment gap was collapsed by \\s+ → ' ' and
      // the frame got glued onto the label.
      const gap = p.MENU_LABEL_GAP_RE;
      if (!gap.test('foo      bar')) throw new Error('MENU_LABEL_GAP_RE missed 6 spaces');
      if (gap.test('foo     bar')) throw new Error('MENU_LABEL_GAP_RE matched only 5 spaces (should require >5)');
      // End-to-end through MenuInterceptor with a fake headless buffer.
      const { MenuInterceptor } = require('./server/src/menu-interceptor');
      const optRows = [
        'What would you like to do?',
        '❯ 1. Single container          ┌────────────────────────────┐',
        '  2. Multi container           │  status: ready             │',
        '  3. Sidecar pattern           └────────────────────────────┘',
      ];
      const fakeHeadless = {
        rows: optRows.length,
        buffer: { active: {
          viewportY: 0,
          getLine: (y) => ({ translateToString: () => optRows[y] || '' }),
        }},
      };
      const mi = new MenuInterceptor();
      const ev = mi.detectChange(fakeHeadless);
      if (!ev || ev.kind !== 'newMenu') throw new Error('MenuInterceptor failed to detect chrome-padded menu: ' + JSON.stringify(ev));
      const labels = ev.menu.options.map((o) => o.label);
      const expected = ['Single container', 'Multi container', 'Sidecar pattern'];
      for (let i = 0; i < expected.length; i++) {
        if (labels[i] !== expected[i]) {
          throw new Error('Option ' + (i + 1) + ' label not trimmed at gap. got=' + JSON.stringify(labels[i]) + ' want=' + JSON.stringify(expected[i]));
        }
      }
    " && pass "pty-patterns: required constants + enriched matchers" \
      || fail "pty-patterns: required constants + enriched matchers"
  else
    skip "pty-patterns runtime (no host node)"
  fi
  # Consumers must require from pty-patterns and not inline the same
  # regexes locally — otherwise the centralisation is decorative.
  grep -q "require('./pty-patterns')" server/src/menu-interceptor.js \
    && pass "menu-interceptor imports from pty-patterns" \
    || fail "menu-interceptor imports from pty-patterns"
  grep -q "require('./pty-patterns')" server/src/permissions.js \
    && pass "permissions imports from pty-patterns" \
    || fail "permissions imports from pty-patterns"
  grep -q "require('./pty-patterns')" server/src/pty.js \
    && pass "pty imports from pty-patterns" \
    || fail "pty imports from pty-patterns"
  # No inline TUI regex copies left in the three migrated files.
  ! grep -qE "approve\.\*tool|approve\.\*bash" server/src/menu-interceptor.js \
    && pass "menu-interceptor no longer inlines kind-classifier regex" \
    || fail "menu-interceptor no longer inlines kind-classifier regex"
  ! grep -qE "Bash\|Edit\|Write\|Read\|MultiEdit" server/src/permissions.js \
    && pass "permissions no longer inlines tool-name regex" \
    || fail "permissions no longer inlines tool-name regex"
  ! grep -qE "accept edits\|auto-accept" server/src/pty.js \
    && pass "pty no longer inlines status-bar mode regex" \
    || fail "pty no longer inlines status-bar mode regex"
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
  # Regression: mermaid.render leaks an error <div id="dmermaid-…"> when
  # parse fails (the "Syntax error in text, mermaid version X" SVG).
  # renderMermaidInContainer must clean those temp/orphan nodes so they
  # don't stack up at the bottom of the read-only viewer's page.
  grep -q "document.getElementById('d' + id)" web/public/app.js \
    && pass "mermaid temp-div orphan cleanup" \
    || fail "mermaid temp-div orphan cleanup"
  # Regression: read-only viewer's user messages must go through renderMd
  # too. Earlier they used textContent and rendered markdown literally
  # ("1. step", **bold**, ```code```).
  grep -Pzoq "m.role === 'user'[\s\S]*?textEl.innerHTML = renderMd" web/public/app.js \
    && pass "user-role transcript messages rendered as markdown" \
    || fail "user-role transcript messages rendered as markdown"
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
  # Regression: tool_result output renders as markdown (file content with
  # markdown, code blocks, etc.) instead of one wall of plain text.
  grep -q "body.innerHTML = renderMd(rest)" web/public/app.js \
    && pass "tool_result body rendered as markdown" \
    || fail "tool_result body rendered as markdown"
  # Regression: transcript is capped to last N messages so very long
  # sessions don't accumulate thousands of DOM turns.
  grep -q "TRANSCRIPT_RENDER_CAP" web/public/app.js \
    && pass "transcript-render cap defined" \
    || fail "transcript-render cap defined"
  # Regression: Plan/Arch/Test panels must be wiped on session switch so
  # the previous session's extracted content doesn't linger.
  grep -q "function clearArtifactBodies" web/public/app.js \
    && pass "clearArtifactBodies() defined" \
    || fail "clearArtifactBodies() defined"
  grep -q "clearArtifactBodies()" web/public/app.js \
    && pass "clearArtifactBodies() called from openSession" \
    || fail "clearArtifactBodies() called from openSession"
  grep -q 'function openSession' web/public/app.js && pass "openSession" || fail "openSession"
  grep -q 'function renderTranscriptMessages' web/public/app.js && pass "renderTranscriptMessages" || fail "renderTranscriptMessages"
}

test_at_myco_chat_handler() {
  grep -q '@myco' server/src/pty.js && pass "@myco handler" || fail "@myco handler"
  grep -q 'session.write' server/src/pty.js && pass "PTY write for @myco" || fail "PTY write"
  # Regression: the @myco prompt MUST be submitted with a bare \r so Claude
  # Code's input editor fires submit. We split the text and the \r into two
  # PTY writes (text first, then a deferred \r) — bundling them caused the
  # editor to treat it as multi-line-paste-with-Enter-inside and never submit.
  # See the chat→pty branch around session.write(input) + setTimeout → '\r'.
  grep -qF "session.write('\\r')" server/src/pty.js \
    && pass "@myco submits with bare \\r (deferred)" \
    || fail "@myco submits with bare \\r (deferred)"
  grep -qF "input + '\\n\\r'" server/src/pty.js \
    && fail "@myco still uses '\\n\\r' (regression — should be bare \\r)" \
    || pass "@myco no longer uses '\\n\\r'"
  # Regression: chat prefix is generalised. Any @<word> prefix routes
  # the message body to claude UNLESS <word> matches a known username
  # (so @kkrazy stays a real mention; @generate / @claude / @myco all
  # route to PTY). Demo010 surfaced the old "@myco only" miss.
  grep -q 'CHAT_TO_PTY_PREFIX_RE' server/src/pty.js \
    && pass "pty.js: generalised @<word> prefix" \
    || fail "pty.js: generalised @<word> prefix"
  grep -q '_isKnownChatUser' server/src/pty.js \
    && pass "pty.js: known-user check guards mention routing" \
    || fail "pty.js: known-user check guards mention routing"
  # Regression: the @myco capture regex must use [\s\S] so multi-line chat
  # messages (now reachable via the discussion textarea + Ctrl/⌘+Enter)
  # don't get truncated to the first line by the `.` shorthand.
  # The chat-to-PTY regex must use [\s\S] (not .) so a multi-line
  # @<word> message — reachable via the discussion textarea — captures
  # all lines, not just the first.
  grep -qF '[\s\S]+' server/src/pty.js \
    && pass "chat-to-PTY regex captures multi-line input" \
    || fail "chat-to-PTY regex captures multi-line input"
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

test_new_session_readonly() {
  # Regression: a freshly spawned session has no JSONL transcript for
  # ~5 seconds while Claude initialises. Two bugs used to make this
  # awkward — pty.js attachWebSocket (owner) resolved the transcript
  # path ONCE at attach, so new owners never got transcript-init /
  # transcript-delta; and openSession landed owners on an empty xterm
  # instead of the readonly conv pane. The fixes wire both ends:
  #   - server: shared streamTranscriptToWs() polls until the JSONL
  #     appears, then init+watch (used by owner AND viewer paths).
  #   - client: doSpawn passes { startInReadonly: true } to openSession.
  grep -q 'function streamTranscriptToWs' server/src/pty.js \
    && pass "pty.js: streamTranscriptToWs helper" \
    || fail "pty.js: streamTranscriptToWs helper"
  # attachWebSocket and attachViewerWebSocket should BOTH call the helper.
  test "$(grep -c 'const stopTranscript = streamTranscriptToWs(' server/src/pty.js)" = "2" \
    && pass "pty.js: both attach paths use streamTranscriptToWs" \
    || fail "pty.js: both attach paths use streamTranscriptToWs"
  # Regression: streamTranscriptToWs does readNewMessages(0) for the
  # init send AND watchTranscript for live updates. Without passing
  # bytesRead as startByte to watchTranscript, the watcher's own
  # initial read from byte 0 fires onNewMessages with the full
  # transcript a second time — every message renders TWICE on the
  # client until the user scrolls past them. The fix passes startByte
  # so the watcher picks up exactly where the init read finished.
  grep -q 'startByte: bytesRead' server/src/pty.js \
    && pass "pty.js: watchTranscript receives startByte to avoid replay" \
    || fail "pty.js: watchTranscript receives startByte to avoid replay"
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
  # Regression: appendChatMessage and _postClaudeStreamToChat must NOT
  # do a full innerHTML rebuild on every new row. The original
  # implementation called renderChatPane(true) on each append, which
  # wiped and rebuilt the entire chat DOM (re-parsing markdown and
  # re-rendering mermaid for every prior row) on every streamed Claude
  # text block — visible as the chat pane flashing/reloading entire
  # history during a live turn. Switch to incremental _appendChatMessageDom.
  grep -qF '_appendChatMessageDom(message)' web/public/app.js \
    && pass "app.js: incremental chat append helper defined" \
    || fail "app.js: missing _appendChatMessageDom helper"
  grep -qF '_appendChatMessageDom(row)' web/public/app.js \
    && pass "app.js: _postClaudeStreamToChat uses incremental append" \
    || fail "app.js: streaming claude path still does a full chat rebuild"
  # Negative guard: neither hot append path should reference renderChatPane.
  # (renderChatPane is still allowed in applyChatHistory + clearChat — the
  # full-rebuild events.)
  if awk '/^function appendChatMessage\(/,/^}$/' web/public/app.js | grep -q 'renderChatPane('; then
    fail "app.js: appendChatMessage still calls renderChatPane (causes full rebuild on every chat frame)"
  else
    pass "app.js: appendChatMessage does not trigger full chat rebuild"
  fi
  if awk '/^function _postClaudeStreamToChat\(/,/^}$/' web/public/app.js | grep -q 'renderChatPane('; then
    fail "app.js: _postClaudeStreamToChat still calls renderChatPane (causes full rebuild on every streamed text block)"
  else
    pass "app.js: _postClaudeStreamToChat does not trigger full chat rebuild"
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
  grep -Pzoq '\.claude-typing\s*\{[^}]*flex:\s*0\s+0\s+30px' web/public/styles.css \
    && pass "css: .claude-typing reserves a permanent 30px flex slot" \
    || fail "css: .claude-typing slot isn't a fixed 30px flex item — chat content will move on spinner toggles"
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
  grep -q 'chat-menu-opt' web/public/app.js \
    && pass "app.js: chat message renders inline menu buttons" \
    || fail "app.js: chat message renders inline menu buttons"
  grep -q '_findLastMenuMessageIdx' web/public/app.js \
    && pass "app.js: only latest menu message is clickable" \
    || fail "app.js: only latest menu message is clickable"
  # Regression: pending-menu callout clicks go through a dedicated
  # WS frame, NOT through chat — the user shouldn't see `/decide N`
  # messages cluttering the discussion when they click [1]/[2] on the
  # readonly view's trust/plan/permission callout. See handleMenuPick
  # in pty.js and sendMenuPick in app.js.
  grep -qF 'sendMenuPick(n, hash)' web/public/app.js \
    && pass "app.js: option click uses sendMenuPick(n, hash)" \
    || fail "app.js: option click uses sendMenuPick(n, hash)"
  grep -q "msg.t === 'menu-pick'" server/src/pty.js \
    && pass "pty.js: handles menu-pick WS frame" \
    || fail "pty.js: handles menu-pick WS frame"
  grep -q 'function handleMenuPick' server/src/pty.js \
    && pass "pty.js: handleMenuPick helper" \
    || fail "pty.js: handleMenuPick helper"
  # Negative guard: the callout must not fall back to a chat /decide send.
  grep -q 'sendChatMessage(\`/decide' web/public/app.js \
    && fail "app.js: callout still sends /decide via chat (regression)" \
    || pass "app.js: callout no longer routes through chat"
  grep -q '\.chat-menu-opt' web/public/styles.css \
    && pass "styles.css: .chat-menu-opt styling" \
    || fail "styles.css: .chat-menu-opt styling"
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
  grep -q '_markMenuChatAnswered' server/src/pty.js \
    && pass "pty.js: menu-pick persists answered on rec.chat" \
    || fail "pty.js: menu-pick persists answered on rec.chat"
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
  # flex-slot design uses `flex: 0 0 30px` (same visual outcome, gives
  # the flex parent an explicit basis that won't grow/shrink). Either
  # spelling counts as "fixed".
  if grep -qE 'flex:\s*0\s+0\s+30px|height:\s*30px' web/public/styles.css; then
    pass "css: claude-typing has fixed slot dimensions (no reflow on status update)"
  else
    fail "css: claude-typing missing fixed height — status updates will reflow chat"
  fi
  grep -qF '.claude-typing-label' web/public/styles.css \
    && pass "css: claude-typing-label has overflow-ellipsis rules" \
    || fail "css: claude-typing-label not styled"
  grep -q "this\\.emit('claude-status'" server/src/pty.js \
    && pass "pty.js: emits claude-status on headless change" \
    || fail "pty.js: emits claude-status on headless change"
  grep -q "_extractStatusLine" server/src/pty.js \
    && pass "pty.js: _extractStatusLine reads spinner from headless" \
    || fail "pty.js: _extractStatusLine reads spinner from headless"
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
  grep -q '_onTranscriptDeltaForChat' web/public/app.js \
    && pass "app.js: transcript-delta routed into chat" \
    || fail "app.js: transcript-delta routed into chat"
  grep -q 'CLAUDE_IDLE_MS' web/public/app.js \
    && pass "app.js: idle-timeout constant defined" \
    || fail "app.js: idle-timeout constant defined"
  grep -q '_postClaudeStreamToChat' web/public/app.js \
    && pass "app.js: streams assistant text to chat" \
    || fail "app.js: streams assistant text to chat"
  # Regression: each assistant text message must be appended as its own
  # chat row (streaming UX), not buffered into one final post. The 2s
  # debounce-then-buffer pattern was too aggressive — it fired after
  # the FIRST assistant text and ignored everything claude said
  # afterward (tool_result and subsequent summary text). Now we post
  # each text on arrival and only retire the typing dots after
  # CLAUDE_IDLE_MS of complete silence.
  grep -qE 'm\.role === .assistant.|role === .assistant.' web/public/app.js \
    && pass "app.js: handles assistant-role transcript messages" \
    || fail "app.js: handles assistant-role transcript messages"
  grep -q '_scheduleClaudeIdleCheck' web/public/app.js \
    && pass "app.js: schedules idle check on transcript activity" \
    || fail "app.js: schedules idle check on transcript activity"
  # Regression: _onTranscriptDeltaForChat must NOT gate on
  # state.awaitingClaude. Claude often thinks silently for 30–60s
  # before producing transcript output. The earlier 8s idle timer
  # retired awaitingClaude=false and the post-text path was then
  # dropping the eventual reply entirely (real bug filed against
  # demo010 "generate sample source code" → claude's "Generated 4
  # sample files…" never reached chat). _onClaudeIdle still keeps
  # its own gate (that one is correct — only fires when dots are up).
  awk '/^function _onTranscriptDeltaForChat\(/,/^\}/' web/public/app.js | \
    grep -qE 'if \(!state\.awaitingClaude\) return' \
    && fail "app.js: _onTranscriptDeltaForChat still gates on awaitingClaude (regression)" \
    || pass "app.js: _onTranscriptDeltaForChat posts text regardless of awaiting state"
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
  # The grace timer must cancel when fresh transcript activity arrives,
  # otherwise a momentary mid-turn spinner gap would yank the dots
  # while claude is still streaming.
  awk '/^function _onTranscriptDeltaForChat\(/,/^\}/' web/public/app.js | \
    grep -q '_spinnerStopTimer' \
    && pass "app.js: transcript activity cancels pending spinner-stop retirement" \
    || fail "app.js: transcript activity does not cancel spinner-stop retirement"
  # Negative guard: doSpawn must NOT auto-switch new sessions to readonly.
  grep -qF 'openSession(body.session_id, { startInReadonly: true })' web/public/app.js \
    && fail "doSpawn auto-switched new sessions to readonly (regression)" \
    || pass "doSpawn no longer auto-switches new sessions to readonly"
  # Safety net: if a brand-new session lands on the readonly view and
  # neither a menu callout nor any transcript content arrives within
  # READONLY_FALLBACK_MS, auto-flip back to the live xterm so the user
  # is never trapped on a "Waiting for session to start…" screen (e.g.
  # when the spawn cwd is already trusted by Claude, so no menu fires).
  grep -q 'READONLY_FALLBACK_MS' web/public/app.js \
    && pass "app.js: readonly-fallback watchdog defined" \
    || fail "app.js: readonly-fallback watchdog defined"
  grep -q '_armReadonlyFallback' web/public/app.js \
    && pass "app.js: armReadonlyFallback wired from openSession" \
    || fail "app.js: armReadonlyFallback wired from openSession"
  grep -q '_cancelReadonlyFallback' web/public/app.js \
    && pass "app.js: cancelReadonlyFallback on menu/transcript/teardown" \
    || fail "app.js: cancelReadonlyFallback on menu/transcript/teardown"
}

test_chat_user_capture() {
  grep -q 'body.user' web/public/app.js && pass "chatUser capture" || fail "chatUser capture"
  grep -q 'from-self' web/public/app.js && pass "self chat alignment" || fail "self chat alignment"
}

test_session_switching_clears_panes() {
  grep -q "conversation-wrap.*hidden.*true" web/public/app.js && pass "pane clear on switch" || fail "pane clear on switch"
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
  test_pty_patterns
  test_cache_busters
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
  grep -qF "[persist-chat-emit]" server/src/pty.js \
    && pass "pty.js: persistAssistantTextToChat logs WS listener count" \
    || fail "pty.js: [persist-chat-emit] diagnostic missing — can't diagnose silent-broadcast"
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
  # Regression: Claude is spawned with --permission-mode acceptEdits so we
  # don't need a fragile runtime Shift+Tab auto-toggle to nudge it into
  # accept mode (that detection could misread state and toggle INTO plan).
  grep -q "'--permission-mode', 'acceptEdits'" server/src/pty.js \
    && pass "claude spawned with --permission-mode acceptEdits" \
    || fail "claude spawned with --permission-mode acceptEdits"
  grep -q 'auto-toggle on discussion' server/src/pty.js \
    && fail "the runtime auto-toggle came back (we removed it for spawn-time mode set)" \
    || pass "runtime auto-toggle removed (acceptEdits is set at spawn)"
  # Regression: --dangerously-skip-permissions was removed because Claude
  # CLI refuses it when running as root. Tool-permission dialogs now flow
  # through MenuInterceptor → permissions.decide → auto-allow / auto-deny.
  grep -q "'--dangerously-skip-permissions'" server/src/pty.js \
    && fail "--dangerously-skip-permissions came back (claude CLI refuses it under root)" \
    || pass "--dangerously-skip-permissions removed (refused under root)"
  test -f server/src/permissions.js && pass "permissions.js exists" || fail "permissions.js missing"
  test -f server/src/menu.js && pass "menu.js exists" || fail "menu.js missing"
  # Menu dialogs flow PTY → menu.handleSessionMenu → permissions.decide.
  # The dispatch lives in menu.js (factored out of pty.js); pty.js just
  # wires the EventEmitter hook.
  grep -q "permissions.decide" server/src/menu.js && pass "menu.js uses permissions.decide" || fail "menu.js uses permissions.decide"
  grep -q "menuMod.handleSessionMenu" server/src/pty.js && pass "pty.js delegates menu events to menu.js" || fail "pty.js delegates menu events to menu.js"
  grep -q "extractPermissionTarget" server/src/permissions.js && pass "permissions exports extractPermissionTarget" || fail "permissions exports extractPermissionTarget"
  grep -q "names: \['allow'" server/src/slashcmds.js && pass "/allow command registered" || fail "/allow missing"
  grep -q "names: \['deny'" server/src/slashcmds.js && pass "/deny command registered" || fail "/deny missing"
  grep -q "names: \['allowlist'" server/src/slashcmds.js && pass "/allowlist command registered" || fail "/allowlist missing"
  # Plan-item shortcuts — /fr (feature), /td (todo, also /todo), /bug.
  # Each appends a row to rec.artifacts.plan.items with a fixed layer.
  grep -q "names: \['fr'\]" server/src/slashcmds.js && pass "/fr command registered" || fail "/fr command missing"
  grep -q "names: \['td', 'todo'\]" server/src/slashcmds.js && pass "/td command registered (alias /todo)" || fail "/td command missing"
  grep -q "names: \['bug'\]" server/src/slashcmds.js && pass "/bug command registered" || fail "/bug command missing"
  # /m: typing-friendly alias for @myco. The rewrite happens in
  # pty.handleChatMessage BEFORE the slash dispatch, so the existing
  # @myco pipeline (special keys, menu-pick shortcuts, prose
  # handling, etc.) is the single source of truth. The slashcmds
  # registration only fires when the user types bare "/m" with no
  # body — handler emits a usage reply.
  grep -q "names: \['m'\]" server/src/slashcmds.js && pass "/m alias registered" || fail "/m alias missing"
  grep -q "function handleMAlias" server/src/slashcmds.js && pass "handleMAlias usage reply" || fail "handleMAlias usage reply"
  grep -qE "text\.match\(/\^\\\\/m" server/src/pty.js \
    && pass "pty.js: /m rewrites to @myco before slash dispatch" \
    || fail "pty.js: /m rewrites to @myco before slash dispatch"
  grep -qF '/^\/m\s+\S/i' web/public/app.js \
    && pass "app.js: typing-dots arm recognizes /m" \
    || fail "app.js: typing-dots arm recognizes /m"
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
  grep -qF "text.match(/^\/tasks?\s*$/i)" server/src/pty.js \
    && pass "pty.js: /task rewrites to @myco /task" \
    || fail "pty.js: /task rewrite missing"
  grep -qF "text.match(/^\/(skip|cancel)\s+(\d+)\s*$/i)" server/src/pty.js \
    && pass "pty.js: /skip + /cancel rewrite to @myco" \
    || fail "pty.js: /skip + /cancel rewrite missing"
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
  grep -q "function readArchFromFile" server/src/artifacts.js \
    && pass "artifacts: readArchFromFile helper" \
    || fail "artifacts: readArchFromFile helper"
  grep -q "function writeArchToFile" server/src/artifacts.js \
    && pass "artifacts: writeArchToFile helper" \
    || fail "artifacts: writeArchToFile helper"
  grep -q "readArchFromFile(ctx.rec)" server/src/artifacts.js \
    && pass "artifacts: GET arch reads from file first" \
    || fail "artifacts: GET arch reads from file first"
  grep -q "writeArchToFile(ctx.rec, artifact.markdown)" server/src/artifacts.js \
    && pass "artifacts: refresh arch writes file" \
    || fail "artifacts: refresh arch writes file"
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
      const tgt = p.extractPermissionTarget('Allow Bash command?\n> git status\n1. Yes\n2. No');
      if (tgt.tool !== 'Bash' || tgt.input !== 'git status') throw new Error('extractPermissionTarget failed: ' + JSON.stringify(tgt));
    " && pass "permissions.matchesPattern + decide + extract" \
      || fail "permissions.matchesPattern + decide + extract"
  else
    skip "permissions runtime (no host node)"
  fi
  # Regression: TUI-menu interception is wired so plan-mode dialogs (and
  # any other numbered menu Claude displays) reach the web GUI via chat.
  test -f server/src/menu-interceptor.js && pass "menu-interceptor.js exists" || fail "menu-interceptor.js missing"
  grep -q "MenuInterceptor" server/src/pty.js && pass "PtySession uses MenuInterceptor" || fail "PtySession uses MenuInterceptor"
  grep -q "broadcastMenuToChat" server/src/pty.js && pass "pty has broadcastMenuToChat" || fail "pty has broadcastMenuToChat"
  grep -q "names: \['decide'" server/src/slashcmds.js && pass "/decide command registered" || fail "/decide command missing"
  # Intensive coverage: 65 cases across MenuInterceptor parse + state machine,
  # permissions.matchesPattern / decide / extractPermissionTarget, and the
  # @myco-shortcut routing when a TUI menu is pending. Lives in a dedicated
  # file because the case list is too long for an inline `node -e` block.
  if have_node; then
    if node test/menu-broadcast.test.js >/dev/null 2>&1; then
      pass "test/menu-broadcast.test.js (65 cases)"
    else
      fail "test/menu-broadcast.test.js — re-run with 'node test/menu-broadcast.test.js' to see failures"
    fi
  else
    skip "test/menu-broadcast.test.js (no host node)"
  fi
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
  # Regression for the menu-pick race condition: when two menus are
  # broadcast in quick succession (parallel tool calls, rapid dialog
  # turnover) the user's click on the older callout must NOT answer
  # the newer menu in the TUI. Hash-validated picks land on the right
  # row; stale picks drop the PTY write.
  if have_node; then
    if node test/menu-pick-race.test.js >/dev/null 2>&1; then
      pass "test/menu-pick-race.test.js (12 cases)"
    else
      fail "test/menu-pick-race.test.js — re-run with 'node test/menu-pick-race.test.js' to see failures"
    fi
  else
    skip "test/menu-pick-race.test.js (no host node)"
  fi
  # Regression: multi-select dialog detection. Claude code renders
  # "<n>. [ ] label" / "<n>. [x] label" for toggleable options; each
  # digit press flips one checkbox and Enter submits. Parser must mark
  # menu.multi=true, strip "[ ]"/"[x]" from labels, expose per-option
  # {checkbox, checked}, leave non-checkbox lines (e.g. final "Done")
  # alone, and keep the hash stable across checked-state changes so the
  # chat row keeps its identity across toggle clicks.
  if have_node; then
    if node test/menu-multiselect.test.js >/dev/null 2>&1; then
      pass "test/menu-multiselect.test.js (21 cases)"
    else
      fail "test/menu-multiselect.test.js — re-run with 'node test/menu-multiselect.test.js' to see failures"
    fi
  else
    skip "test/menu-multiselect.test.js (no host node)"
  fi
  # Regression: parseLine() in transcript.js used to recognise only 4 of
  # the 40+ JSONL `type` values claude code emits. The expanded parser
  # surfaces thinking content, plan/auto-mode transitions, framework
  # errors, command-permission changes, and queued slash commands so
  # readonly viewers see the same narrative the owner does in their TUI.
  if have_node; then
    if node test/transcript-parser-types.test.js >/dev/null 2>&1; then
      pass "test/transcript-parser-types.test.js (17 cases)"
    else
      fail "test/transcript-parser-types.test.js — re-run with 'node test/transcript-parser-types.test.js' to see failures"
    fi
  else
    skip "test/transcript-parser-types.test.js (no host node)"
  fi
  # Regression: the PTY mode-change observer must emit ONLY on
  # transitions, not on every periodic safety scan. First scan
  # establishes baseline silently — otherwise every owner reconnect
  # would produce a spurious "entered default" pill on the viewer.
  if have_node; then
    if node test/pty-mode-change.test.js >/dev/null 2>&1; then
      pass "test/pty-mode-change.test.js (6 cases)"
    else
      fail "test/pty-mode-change.test.js — re-run with 'node test/pty-mode-change.test.js' to see failures"
    fi
  else
    skip "test/pty-mode-change.test.js (no host node)"
  fi
  # Each new TUI regex must be exported from pty-patterns.js and (when
  # applicable) consumed by pty.js. Sentinels here so a future revert
  # to inlined regex shapes trips the static check.
  for re in TOOL_INVOCATION_RE CORNER_BLOCK_RE STATUS_TOKEN_TRAILER_RE STATUS_INTERRUPT_RE EFFORT_CHIP_RE; do
    grep -qF "$re" server/src/pty-patterns.js \
      && pass "pty-patterns.js: $re defined" \
      || fail "pty-patterns.js: $re missing — readonly viewer status decomposition will lose this dimension"
  done
  for re in STATUS_TOKEN_TRAILER_RE STATUS_INTERRUPT_RE EFFORT_CHIP_RE; do
    grep -qF "$re" server/src/pty.js \
      && pass "pty.js: imports $re for _extractStatus" \
      || fail "pty.js: $re not consumed — status chip will be empty"
  done
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
  # Mode-change WS frame must be wired in both attach handlers (owner +
  # viewer) so the readonly viewer also receives live transition pills.
  grep -qF "session.on('mode-change'" server/src/pty.js \
    && pass "pty.js: mode-change WS handler wired" \
    || fail "pty.js: mode-change handler missing — viewer pills will lag by JSONL flush latency"
  grep -qF "_onLiveModeChange" web/public/app.js \
    && pass "app.js: _onLiveModeChange handler defined" \
    || fail "app.js: _onLiveModeChange missing — live mode-change frames will be dropped"
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
  # Regression: streamTranscriptToWs used to call resolveTranscriptPath
  # ONCE at attach time and pin the watcher to that file. Even with the
  # live-tracker fix, a mid-connection claude /resume re-exec writes to
  # a NEW <id>.jsonl while the watcher keeps reading the stale path.
  # Symptom: transcript view and chat sidebar both freeze at the
  # pre-re-exec content — only a page refresh recovers (re-runs
  # resolveTranscriptPath at the fresh attach). The fix polls
  # resolveTranscriptPath every 3s and rebinds when it changes.
  grep -qF '[transcript-rebind]' server/src/pty.js \
    && pass "pty.js: streamTranscriptToWs rebinds watcher when live jsonl path changes" \
    || fail "pty.js: streamTranscriptToWs no longer rebinds — mid-session re-execs lose transcript-delta"
  grep -qF 'MENU_CHECKBOX_RE' server/src/pty-patterns.js \
    && pass "pty-patterns.js: MENU_CHECKBOX_RE defined" \
    || fail "pty-patterns.js: MENU_CHECKBOX_RE missing — multi-select detection won't work"
  grep -qF 'function handleMenuToggle' server/src/pty.js \
    && pass "pty.js: handleMenuToggle defined" \
    || fail "pty.js: handleMenuToggle missing"
  grep -qF 'function handleMenuSubmit' server/src/pty.js \
    && pass "pty.js: handleMenuSubmit defined" \
    || fail "pty.js: handleMenuSubmit missing"
  grep -qF "msg.t === 'menu-toggle'" server/src/pty.js \
    && pass "pty.js: WS frame menu-toggle wired" \
    || fail "pty.js: WS frame menu-toggle not wired"
  grep -qF "msg.t === 'menu-submit'" server/src/pty.js \
    && pass "pty.js: WS frame menu-submit wired" \
    || fail "pty.js: WS frame menu-submit not wired"
  # menu-toggle MUST send digit only (no CR) — sending '\r' here would
  # submit prematurely and fail the multi-select.
  if awk '/^function handleMenuToggle\(/,/^}$/' server/src/pty.js | grep -qF 'session.write(String(n));'; then
    pass "pty.js: handleMenuToggle writes digit only (no CR)"
  else
    fail "pty.js: handleMenuToggle writes wrong byte sequence (should be just the digit)"
  fi
  # And it must NOT include the CR-suffix form used by single-select.
  if awk '/^function handleMenuToggle\(/,/^}$/' server/src/pty.js | grep -qF "session.write(String(n) + '\\r')"; then
    fail "pty.js: handleMenuToggle includes CR — would submit on every checkbox click"
  else
    pass "pty.js: handleMenuToggle has no CR (matches multi-select toggle semantics)"
  fi
  # handleMenuPick must SKIP the trailing CR when the plan-mode
  # interview wizard tab bar is visible — the wizard auto-commits on
  # digit alone and the CR leaks to the next screen, landing on Cancel
  # or skipping a question. Verified live on mycobeta demo010
  # (2026-05-13): a 4-question wizard had its Q2 (Database) silently
  # skipped because Q1's "\r" advanced past it, and the final
  # question's "\r" landed on the Submit tab's Cancel → wizard
  # returned "user rejected". Sentinel the gate function so a future
  # refactor doesn't reintroduce the always-CR shape.
  grep -qF '_isWizardActive(session)' server/src/pty.js \
    && pass "pty.js: handleMenuPick gates trailing CR on _isWizardActive" \
    || fail "pty.js: handleMenuPick no longer wizard-aware — extra CR will leak"
  grep -qF 'function _isWizardActive' server/src/pty.js \
    && pass "pty.js: _isWizardActive helper defined" \
    || fail "pty.js: _isWizardActive missing — wizard gate broken"
  # Regression: the plan-mode interview wizard has TWO variants. SIMPLE
  # auto-commits on digit (drop trailing CR — R-02). RICH expands each
  # option inline ("n to add notes", "Tab to switch questions") and
  # requires Enter to commit (KEEP trailing CR). Verified mycobeta
  # demo010 (2026-05-13): "Which architecture" rich-wizard click sent
  # bare "1" → cursor moved, wizard never advanced. Now distinguished
  # by WIZARD_RICH_FOOTER_RE.
  grep -qF 'WIZARD_RICH_FOOTER_RE' server/src/pty-patterns.js \
    && pass "pty-patterns.js: WIZARD_RICH_FOOTER_RE defined" \
    || fail "pty-patterns.js: WIZARD_RICH_FOOTER_RE missing — rich wizard picks won't commit"
  grep -qF 'function _detectWizard' server/src/pty.js \
    && pass "pty.js: _detectWizard distinguishes simple vs rich wizard" \
    || fail "pty.js: _detectWizard missing — simple/rich variants not separated"
  # INTERACTION_RULES.md is the single-source-of-truth for claude code
  # TUI ⇄ myco contract — every rule maps to a regex/handler + a test +
  # a sentinel in this file. When you discover a new failure mode on
  # mycobeta, add a numbered rule there so future-you (and the next
  # AI working in this repo) doesn't repeat the diagnostic from scratch.
  [ -f server/src/INTERACTION_RULES.md ] \
    && pass "INTERACTION_RULES.md present (single source of truth for TUI rules)" \
    || fail "server/src/INTERACTION_RULES.md missing — future rule changes risk regressing R-01..R-12 silently"
  grep -qF 'R-01' server/src/INTERACTION_RULES.md 2>/dev/null \
    && pass "INTERACTION_RULES.md uses stable R-NN numbering" \
    || fail "INTERACTION_RULES.md: rule numbering scheme broken"
  # handleMenuToggle must flip opt.checked exactly ONCE per click.
  # _toggleMenuChatCheckbox mutates the persisted record (which shares
  # the same object reference as pending.options[i] because
  # broadcastMenuToChat doesn't clone). Re-applying `opt.checked =
  # !opt.checked` in handleMenuToggle ITSELF used to double-flip — net
  # zero — so the chat picker's UI never moved and the menu-multi
  # diagnostic always logged the initial state. Verified live on
  # mycobeta demo010 (2026-05-13): "select 2 of 4" logged "unchecked"
  # for both clicks. Sentinel the lone _toggleMenuChatCheckbox call
  # AND the absence of an opt.checked toggle inside handleMenuToggle.
  if awk '/^function handleMenuToggle\(/,/^}$/' server/src/pty.js | grep -qE '^[[:space:]]*opt\.checked\s*=\s*!opt\.checked'; then
    fail "pty.js: handleMenuToggle re-flips opt.checked AFTER _toggleMenuChatCheckbox — net zero, chat UI lies, server/TUI diverge"
  else
    pass "pty.js: handleMenuToggle flips opt.checked exactly once (no double-flip)"
  fi
  # menu-submit must navigate to the "Submit" row before pressing Enter —
  # claude's multi-select dialog has a separate Submit element below
  # the numbered options. Plain CR on the cursor's current position
  # just operates on a checkbox row. Earlier the navigation used a
  # blind 12-arrow over-send which wrapped on some Ink builds (cursor
  # ended back at option 1, Enter submitted option 1 only). Current
  # impl reads the headless to find the exact cursor→Submit distance
  # AND paces arrows ~30ms apart so the TUI processes them serially.
  grep -qF '_findSubmitNavCount' server/src/pty.js \
    && pass "pty.js: handleMenuSubmit reads headless to compute exact nav distance" \
    || fail "pty.js: handleMenuSubmit no longer computes precise nav count"
  if awk '/^function handleMenuSubmit\(/,/^}$/' server/src/pty.js | grep -qF 'setTimeout(tick'; then
    pass "pty.js: handleMenuSubmit paces arrows with setTimeout (no rapid-burst)"
  else
    fail "pty.js: handleMenuSubmit sends arrows as a burst — TUI may debounce them into one event"
  fi
  # Regex now lives in pty-patterns.js (per CLAUDE.md: all TUI-output
  # regexes belong in one place). Pre-fix the cursor scan latched onto
  # the FIRST `❯` in the viewport — which could be the wizard
  # breadcrumb's step pointer, NOT the option cursor. Inflated
  # cursor→Submit by 10+ rows and the paced down-arrow burst wrapped
  # the cursor in claude's TUI.
  grep -qF 'MULTI_SELECT_CURSOR_RE' server/src/pty-patterns.js \
    && pass "pty-patterns.js: MULTI_SELECT_CURSOR_RE defined" \
    || fail "pty-patterns.js: MULTI_SELECT_CURSOR_RE missing — Submit nav may latch onto stray ❯"
  grep -qF 'MULTI_SELECT_CURSOR_RE' server/src/pty.js \
    && pass "pty.js: handleMenuSubmit anchors cursor on a checkbox-bearing line" \
    || fail "pty.js: handleMenuSubmit not using MULTI_SELECT_CURSOR_RE — stray ❯ will overshoot Submit"
  grep -qF 'SUBMIT_ROW_RE' server/src/pty-patterns.js \
    && pass "pty-patterns.js: SUBMIT_ROW_RE defined" \
    || fail "pty-patterns.js: SUBMIT_ROW_RE missing"
  grep -qF 'SUBMIT_ROW_RE' server/src/pty.js \
    && pass "pty.js: SUBMIT_ROW_RE locates the Submit/Done row" \
    || fail "pty.js: SUBMIT_ROW_RE missing — footer hint text may be mistaken for Submit"
  # Plan-mode interview wizard labels its per-question submit row "Next",
  # not "Submit". Verified 2026-05-13 on mycobeta demo010 — the Features
  # multi-select's submit row was an indented "Next" below option 5
  # "Type something". Without `next` in the alternation, the nav burst
  # fell back to the 6-row default, the cursor wrapped past Next, and
  # claude received Enter on a checkbox row — interpreted as decline.
  grep -qE "submit\|done\|continue\|finish\|ok\|next" server/src/pty-patterns.js \
    && pass "pty-patterns.js: SUBMIT_ROW_RE includes 'next' label (per-question wizard submit row)" \
    || fail "pty-patterns.js: SUBMIT_ROW_RE missing 'next' — wizard multi-select submit will land on the wrong row"
  grep -qF 'function sendMenuToggle' web/public/app.js \
    && pass "app.js: sendMenuToggle defined" \
    || fail "app.js: sendMenuToggle missing"
  grep -qF 'function sendMenuSubmit' web/public/app.js \
    && pass "app.js: sendMenuSubmit defined" \
    || fail "app.js: sendMenuSubmit missing"
  grep -qF 'chat-menu-toggle' web/public/app.js \
    && pass "app.js: multi-select renders chat-menu-toggle buttons" \
    || fail "app.js: multi-select rendering missing chat-menu-toggle class"
  grep -qF 'chat-menu-submit' web/public/app.js \
    && pass "app.js: multi-select renders Submit button" \
    || fail "app.js: multi-select Submit button missing"
  grep -qF '.chat-menu-opt.chat-menu-toggle' web/public/styles.css \
    && pass "css: multi-select toggle styling present" \
    || fail "css: multi-select toggle styling missing"
  grep -qF '.chat-menu-submit' web/public/styles.css \
    && pass "css: multi-select Submit styling present" \
    || fail "css: multi-select Submit styling missing"
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
  grep -qF 'function persistAssistantTextToChat' server/src/pty.js \
    && pass "pty.js: persistAssistantTextToChat defined" \
    || fail "pty.js: persistAssistantTextToChat missing"
  grep -qF "persistAssistantTextToChat(sessionId, newMsgs)" server/src/pty.js \
    && pass "pty.js: transcript watcher mirrors assistant text into rec.chat" \
    || fail "pty.js: transcript watcher does not mirror assistant text"
  grep -qF 'meta: { transcriptUuid: m.uuid, fromTranscript: true }' server/src/pty.js \
    && pass "pty.js: persisted chat rows carry meta.transcriptUuid for dedup" \
    || fail "pty.js: persisted chat rows missing meta.transcriptUuid"
  # Client dedup: when chat-history already has a row with the same
  # uuid, the live transcript-delta path skips it so we don't render
  # the same reply twice on a reconnect.
  grep -qF 'c.meta.transcriptUuid === m.uuid' web/public/app.js \
    && pass "app.js: transcript-delta dedups against chat-history" \
    || fail "app.js: transcript-delta dedup against chat-history missing"
  grep -qF '_postClaudeStreamToChat(m.text.trim(), m.uuid)' web/public/app.js \
    && pass "app.js: live chat rows stamp transcriptUuid for dedup" \
    || fail "app.js: live chat rows missing transcriptUuid stamp"
  # Regression: appendChatMessage (the 'chat' WS frame handler) must
  # dedup by meta.transcriptUuid. Without this, the SAME assistant text
  # arriving via transcript-delta first and then the server's 'chat'
  # push from persistAssistantTextToChat rendered twice in the chat
  # pane (observed on mycobeta demo010 as identical "claude 01:17"
  # rows duplicated back-to-back).
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
  # Regression: SPINNER_RUNNING_RE used to match both -ing and -ed
  # verbs, so done-with-phase lines ("✻ Brewed for 1m 25s") kept the
  # typing indicator alive long after claude went idle. Reported by
  # the user as the dots refusing to stop. New regexes require -ing
  # (active) and split out SPINNER_DONE_RE for the past tense shape.
  if have_node; then
    if node test/spinner-regex.test.js >/dev/null 2>&1; then
      pass "test/spinner-regex.test.js (19 cases)"
    else
      fail "test/spinner-regex.test.js — re-run with 'node test/spinner-regex.test.js' to see failures"
    fi
  else
    skip "test/spinner-regex.test.js (no host node)"
  fi
  grep -qF 'SPINNER_DONE_RE' server/src/pty-patterns.js \
    && pass "pty-patterns.js: SPINNER_DONE_RE exported for past-tense phase lines" \
    || fail "pty-patterns.js: SPINNER_DONE_RE not defined"
  if have_node; then
    node -e "
      const { SPINNER_RUNNING_RE, SPINNER_DURATION_RE } = require('./server/src/pty-patterns');
      const stuck = '✻ Brewed for 1m 25s';
      if (SPINNER_RUNNING_RE.test(stuck) || SPINNER_DURATION_RE.test(stuck)) {
        process.exit(1);
      }
    " >/dev/null 2>&1 \
      && pass "pty-patterns: '✻ Brewed for 1m 25s' no longer treated as running" \
      || fail "pty-patterns: stuck-indicator regex still matches done-phase summary"
  fi
  # Fix 1: periodic safety scan. The 250ms data-event debounce alone
  # misses rapid back-to-back menus because it keeps resetting during
  # a busy turn — a fixed-cadence scan guarantees no menu lives on
  # screen longer than ~750ms without being hashed.
  grep -qF 'setInterval(() => this._checkMenu(), 750)' server/src/pty.js \
    && pass "pty.js: periodic 750ms menu safety scan" \
    || fail "pty.js: periodic menu safety scan missing"
  grep -qF '_periodicMenuScan' server/src/pty.js \
    && pass "pty.js: periodic-scan timer field exists for cleanup" \
    || fail "pty.js: _periodicMenuScan field missing"
  grep -qF 'clearInterval(this._periodicMenuScan)' server/src/pty.js \
    && pass "pty.js: periodic-scan timer cleared on pty exit" \
    || fail "pty.js: periodic-scan timer not cleared on exit"
  # Quick wire-level checks for the hash field carrying end-to-end.
  grep -qF 'data-hash="${escHtml(menuHash)}"' web/public/app.js \
    && pass "app.js: menu buttons stamp data-hash" \
    || fail "app.js: menu buttons missing data-hash stamp"
  grep -qF 'btn.dataset.hash' web/public/app.js \
    && pass "app.js: click handler reads hash from button" \
    || fail "app.js: click handler not reading hash"
  grep -qF "sendMenuPick(n, hash)" web/public/app.js \
    && pass "app.js: sendMenuPick accepts hash arg" \
    || fail "app.js: sendMenuPick signature missing hash"
  grep -qF 'function handleMenuPick(sessionId, session, n, hash)' server/src/pty.js \
    && pass "pty.js: handleMenuPick accepts hash" \
    || fail "pty.js: handleMenuPick signature missing hash"
  grep -qF 'pending.hash !== hash' server/src/pty.js \
    && pass "pty.js: handleMenuPick validates hash against pendingMenu" \
    || fail "pty.js: handleMenuPick hash validation missing"
  grep -qF '_markMenuChatAnswered' server/src/pty.js \
    && pass "pty.js: renamed persist helper (_markMenuChatAnswered)" \
    || fail "pty.js: persist helper not renamed"
  if have_node; then
    node -e "
      const { MenuInterceptor } = require('./server/src/menu-interceptor');
      function fake(text) {
        const lines = text.split('\n');
        return { rows: lines.length, buffer: { active: { viewportY: 0, getLine: (y) => ({ translateToString: () => lines[y] || '' }) }}};
      }
      const i = new MenuInterceptor();
      const plan = 'The plan is ready.\nWhat would you like to do?\n❯ 1. Yes, proceed with this plan\n  2. No, keep planning';
      const r = i.detectChange(fake(plan));
      if (!r || r.kind !== 'newMenu') throw new Error('expected newMenu, got ' + JSON.stringify(r));
      if (r.menu.kind !== 'plan') throw new Error('expected kind=plan, got ' + r.menu.kind);
      if (r.menu.options.length !== 2) throw new Error('expected 2 options, got ' + r.menu.options.length);
      const r2 = i.detectChange(fake(plan));
      if (!r2 || r2.kind !== 'sameMenu') throw new Error('expected sameMenu on repeat, got ' + JSON.stringify(r2));
      const r3 = i.detectChange(fake('boring text no menu'));
      if (!r3 || r3.kind !== 'cleared') throw new Error('expected cleared, got ' + JSON.stringify(r3));
    " && pass "MenuInterceptor parses plan dialog + dedupes + clears" \
      || fail "MenuInterceptor parses plan dialog + dedupes + clears"
  else
    skip "MenuInterceptor parser (no host node)"
  fi
  # Regression: Claude Code's trust-folder dialog on first-run renders
  # near the TOP of a tall alt-screen (~33+ rows on Android phones). The
  # interceptor used to scan only the bottom 16 rows and miss it entirely,
  # leaving the user stuck on "Waiting for session to start…" because no
  # menu broadcast ever fired. _scan now walks the entire visible
  # viewport.
  if have_node; then
    node -e "
      const { MenuInterceptor } = require('./server/src/menu-interceptor');
      // Trust dialog at rows 5-19 of a 40-row terminal — options at
      // rows 17-18, well above the old bottom-16 (rows 24-39) window.
      const rows = 40;
      const lines = new Array(rows).fill('');
      lines[5]  = ' Accessing workspace:';
      lines[7]  = ' /wks/kkrazy/Demo003';
      lines[9]  = ' Quick safety check: Is this a project you trust?';
      lines[12] = ' Claude Code will be able to read, edit, and execute files here.';
      lines[14] = ' Security guide';
      lines[16] = ' ❯ 1. Yes, I trust this folder';
      lines[17] = '   2. No, exit';
      lines[19] = ' Enter to confirm';
      const fake = {
        rows,
        buffer: { active: { viewportY: 0, getLine: (y) => lines[y] != null ? ({ translateToString: () => lines[y] }) : null }},
      };
      const r = (new MenuInterceptor()).detectChange(fake);
      if (!r || r.kind !== 'newMenu') throw new Error('trust dialog at top: expected newMenu, got ' + JSON.stringify(r));
      if (r.menu.options.length !== 2) throw new Error('trust dialog options: expected 2, got ' + r.menu.options.length);
      if (!/trust this folder/i.test(r.menu.options[0].label)) throw new Error('option 1 label wrong: ' + r.menu.options[0].label);
    " && pass "MenuInterceptor finds trust dialog at top of tall viewport" \
      || fail "MenuInterceptor finds trust dialog at top of tall viewport"
  else
    skip "MenuInterceptor trust-dialog (no host node)"
  fi
  # Regression: claude code's WebSearch-permission dialog renders option 2
  # WITHOUT a space after the dot ("2.Yes, and don't ask again for Web
  # Search"). The previous /(?=\s)/ lookahead rejected this marker, the
  # scanner found only one option (n=1), and the menu was missed entirely.
  # The fix is /(?!\d)/ — still blocks decimals like "3.5" but allows a
  # letter to immediately follow the dot.
  if have_node; then
    node -e "
      const { MenuInterceptor } = require('./server/src/menu-interceptor');
      const lines = [];
      lines.push(' Tool use');
      lines.push('');
      lines.push('   Web Search(\"Shenzhen weather\")');
      lines.push('   Claude wants to search the web for: Shenzhen weather');
      lines.push('');
      lines.push(' Do you want to proceed?');
      lines.push(' ❯ 1. Yes');                                       // option 1 (well-formed)
      lines.push('  2.Yes, and don\\'t ask again for Web Search');   // option 2 (no space after dot)
      const rows = 20;
      while (lines.length < rows) lines.push('');
      const fake = {
        rows,
        buffer: { active: { viewportY: 0, getLine: (y) => lines[y] != null ? ({ translateToString: () => lines[y] }) : null }},
      };
      const r = (new MenuInterceptor()).detectChange(fake);
      if (!r || r.kind !== 'newMenu') throw new Error('expected newMenu for malformed 2.Yes, got ' + JSON.stringify(r));
      if (r.menu.options.length !== 2) throw new Error('expected 2 options, got ' + r.menu.options.length);
      if (r.menu.options[1].n !== 2) throw new Error('expected option 2, got ' + r.menu.options[1].n);
      if (!/yes/i.test(r.menu.options[1].label)) throw new Error('option 2 label wrong: ' + r.menu.options[1].label);
      // Decimals must NOT match — guard against the regex relaxation
      // accidentally allowing 'i have 3.5 reasons' as a menu marker.
      const proseLines = [' I have 3.5 reasons to refactor this.', ' Section 2.0 has details.'];
      while (proseLines.length < rows) proseLines.push('');
      const fake2 = {
        rows,
        buffer: { active: { viewportY: 0, getLine: (y) => proseLines[y] != null ? ({ translateToString: () => proseLines[y] }) : null }},
      };
      const r2 = (new MenuInterceptor()).detectChange(fake2);
      if (r2 && r2.kind === 'newMenu') throw new Error('decimals should NOT match as menu markers: ' + JSON.stringify(r2));
    " && pass "MenuInterceptor handles missing-space-after-dot + rejects decimals" \
      || fail "MenuInterceptor handles missing-space-after-dot + rejects decimals"
  else
    skip "MenuInterceptor missing-space (no host node)"
  fi
  # Regression: claude code's ultraplan-interview dialog has multi-line
  # option descriptions plus a horizontal divider between option 4 and
  # option 5. The old "gap ≤ 2 lines between markers" rule rejected it
  # entirely. After bumping MENU_MAX_OPTION_GAP_LINES and joining
  # continuation lines, all 6 options should be detected and their
  # descriptions folded into the label.
  if have_node; then
    node -e "
      const { MenuInterceptor } = require('./server/src/menu-interceptor');
      const lines = [];
      lines.push(' What kind of sample task should this plan be for?');
      lines.push('');
      lines.push(' ❯ 1. Add a hello-world script');
      lines.push('      Create a tiny script in the working');
      lines.push('      directory');
      lines.push('   2. Add a README stub');
      lines.push('      Create a minimal README.md');
      lines.push('   3. No-op demo plan');
      lines.push('      Don\\'t actually change anything — just');
      lines.push('      demonstrate the flow');
      lines.push('   4. Type something.');
      lines.push('────────────────────────────────────────────');
      lines.push('   5. Chat about this');
      lines.push('   6. Skip interview and plan immediately');
      const rows = 30;
      while (lines.length < rows) lines.push('');
      const fake = {
        rows,
        buffer: { active: { viewportY: 0, getLine: (y) => lines[y] != null ? ({ translateToString: () => lines[y] }) : null }},
      };
      const r = (new MenuInterceptor()).detectChange(fake);
      if (!r || r.kind !== 'newMenu') throw new Error('ultraplan dialog: expected newMenu, got ' + JSON.stringify(r));
      if (r.menu.options.length !== 6) throw new Error('expected 6 options, got ' + r.menu.options.length);
      // Labels are intentionally single-line (we no longer fold the
      // description continuations — TUI key hints kept bloating
      // labels with 'shift+tab to approve / ctrl-g to edit in Vim …').
      // Make sure each option's label is just the first-line text and
      // doesn't contain a description's text.
      if (r.menu.options[0].label !== 'Add a hello-world script') throw new Error('option 1 label changed shape: ' + r.menu.options[0].label);
      if (/working directory/i.test(r.menu.options[0].label)) throw new Error('option 1 leaks description into label');
      if (r.menu.options[2].label !== 'No-op demo plan') throw new Error('option 3 label changed shape: ' + r.menu.options[2].label);
      // Options 5 and 6 (across the divider) must still be present.
      if (!/chat about this/i.test(r.menu.options[4].label)) throw new Error('option 5 missing: ' + r.menu.options[4].label);
      if (!/skip interview/i.test(r.menu.options[5].label)) throw new Error('option 6 missing: ' + r.menu.options[5].label);
    " && pass "MenuInterceptor parses ultraplan-style menu (single-line labels + divider)" \
      || fail "MenuInterceptor parses ultraplan-style menu (single-line labels + divider)"
  else
    skip "MenuInterceptor ultraplan (no host node)"
  fi
  # Regression: a claude assistant plan body that contains numbered
  # bullet points (1., 2., 3., …) must NOT be detected as a menu, even
  # if the bullets are contiguously numbered. The signal that
  # distinguishes a real TUI menu from prose is the `❯` cursor on the
  # selected option's line. Without this guard, claude's own plans
  # popped a "🤔 Claude is waiting on a decision" callout asking the
  # user to "pick" a plan bullet.
  if have_node; then
    node -e "
      const { MenuInterceptor } = require('./server/src/menu-interceptor');
      // Plan body with numbered bullets, no cursor — must be rejected.
      const plan = [
        ' Heres the plan:',
        '',
        ' 1. Database — notification schema',
        ' 2. Message bus — Redis pub/sub',
        ' 3. Worker consumes events → persists',
        ' 4. WS Gateway — JWT auth on upgrade',
        ' 5. Client SDK — exponential backoff reconnect',
        ' 6. Inbox UI — list + unread badge',
      ];
      const rows = 30;
      while (plan.length < rows) plan.push('');
      const fakePlan = { rows, buffer: { active: { viewportY: 0,
        getLine: (y) => plan[y] != null ? ({ translateToString: () => plan[y] }) : null }}};
      const r = (new MenuInterceptor()).detectChange(fakePlan);
      if (r && r.kind === 'newMenu') throw new Error('plan bullet body falsely detected as menu: ' + JSON.stringify(r));
      // Same content with cursor on one bullet → should detect.
      const planWithCursor = plan.slice();
      planWithCursor[5] = ' ❯ 4. WS Gateway — JWT auth on upgrade';
      const fakeMenu = { rows, buffer: { active: { viewportY: 0,
        getLine: (y) => planWithCursor[y] != null ? ({ translateToString: () => planWithCursor[y] }) : null }}};
      const r2 = (new MenuInterceptor()).detectChange(fakeMenu);
      if (!r2 || r2.kind !== 'newMenu') throw new Error('cursor-marked menu rejected: ' + JSON.stringify(r2));
    " && pass "MenuInterceptor rejects bullet-prose without ❯ cursor" \
      || fail "MenuInterceptor rejects bullet-prose without ❯ cursor"
  else
    skip "MenuInterceptor cursor-guard (no host node)"
  fi
  # Regression (demo010 04:24): assistant turn renders a plan body
  # containing numbered bullets (1..6) followed by claude code's real
  # plan-confirmation menu (1..4 with ❯ cursor). Old code collected
  # ALL options [1..6, 1..4] and bailed at the 6→1 discontinuity, so
  # the active menu was never broadcast. Splitting into runs and
  # picking the cursored one fixes it.
  if have_node; then
    node -e "
      const { MenuInterceptor } = require('./server/src/menu-interceptor');
      const lines = [];
      // Plan body — numbered prose, NO cursor:
      lines.push(' 1. Database — notification schema');
      lines.push(' 2. Message bus — Redis pub/sub');
      lines.push(' 3. Worker — consumes events');
      lines.push(' 4. WS Gateway — JWT auth');
      lines.push(' 5. Client SDK — reconnect/backoff');
      lines.push(' 6. Inbox UI — list + unread badge');
      lines.push('');
      lines.push(' ---');
      lines.push(' Files to Create / Modify');
      lines.push('');
      lines.push(' - .github/workflows/ci.yml');
      lines.push('');
      lines.push(' Claude has written up a plan and is ready to execute. Would you like to proceed?');
      lines.push('');
      // Real menu — cursored:
      lines.push(' ❯ 1. Yes, and use auto mode');
      lines.push('   2. Yes, manually approve edits');
      lines.push('   3. No, refine with Ultraplan on Claude Code on the web');
      lines.push('   4. Tell Claude what to change');
      lines.push('      shift+tab to approve with this feedback');
      const rows = 50;
      while (lines.length < rows) lines.push('');
      const fake = { rows, buffer: { active: { viewportY: 0,
        getLine: (y) => lines[y] != null ? ({ translateToString: () => lines[y] }) : null }}};
      const r = (new MenuInterceptor()).detectChange(fake);
      if (!r || r.kind !== 'newMenu') throw new Error('expected newMenu for cursored bottom run, got ' + JSON.stringify(r));
      if (r.menu.options.length !== 4) throw new Error('expected 4 options (the real menu), got ' + r.menu.options.length + ': ' + JSON.stringify(r.menu.options.map(o=>o.n)));
      if (r.menu.options[0].n !== 1) throw new Error('expected first option n=1, got ' + r.menu.options[0].n);
      if (!/auto mode/i.test(r.menu.options[0].label)) throw new Error('option 1 label wrong: ' + r.menu.options[0].label);
      // The plan bullets must not appear in the labels.
      for (const o of r.menu.options) {
        if (/database|redis pub|client sdk|inbox ui/i.test(o.label)) throw new Error('plan bullet leaked into option label: ' + o.label);
      }
    " && pass "MenuInterceptor picks cursored run when prose bullets are above" \
      || fail "MenuInterceptor picks cursored run when prose bullets are above"
  else
    skip "MenuInterceptor mixed-runs (no host node)"
  fi
  grep -q "handleChatMessage" server/src/pty.js && pass "handleChatMessage in pty.js" || fail "handleChatMessage in pty.js"
  grep -q "handleChatMessage" server/src/index.js && pass "handleChatMessage imported by /run route" || fail "handleChatMessage imported"
  # Regression: while a TUI menu is pending in the session, an @myco
  # message must not just blindly inject text on top of it. A pure digit
  # picks that option; anything else cancels (Esc) the menu first.
  grep -q "menu pick" server/src/pty.js && pass "@myco digit shortcuts to menu pick" || fail "@myco digit shortcut missing"
  grep -q "cancelling pending menu" server/src/pty.js && pass "@myco cancels pending menu for new instructions" || fail "@myco menu-cancel missing"
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
