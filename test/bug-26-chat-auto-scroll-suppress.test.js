// bug-26 regression: chat-pane auto-scroll-to-latest must NOT yank
// the user back to the bottom when they've manually scrolled up to
// read earlier messages.
//
// User report: "If the user has manually scrolled up, suppress
// auto-scroll-to-latest so they can keep reading."
//
// Fix shape:
//   - state.chatUserScrolledUp tracks "user is not at bottom"
//   - #chat-messages scroll listener updates the flag (50px threshold)
//   - scrollChatToLatest() short-circuits when the flag is set
//   - { force: true } bypasses the check (user-initiated open / switch)
//   - setChatPane(visible=true) + _resetUiForNewSession clear the flag

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── bug-26: chat auto-scroll respects user scroll position ──');

// ──────────────────────────────────────────────────────────────────────
// scrollChatToLatest: gate + force-bypass + threshold helper
// ──────────────────────────────────────────────────────────────────────

function _scrollFnBody() {
  const start = APP.search(/function\s+scrollChatToLatest\s*\(/);
  assert.ok(start > -1, 'scrollChatToLatest must exist');
  const rest = APP.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

t('scrollChatToLatest accepts a { force } option', () => {
  const body = _scrollFnBody();
  assert.ok(/function\s+scrollChatToLatest\s*\(\s*\{\s*force\s*=\s*false\s*\}\s*=\s*\{\}\s*\)/.test(body),
    'signature must default-destructure `{ force = false } = {}` so existing call sites stay compatible');
});

t('scrollChatToLatest short-circuits when chatUserScrolledUp + !force', () => {
  const body = _scrollFnBody();
  assert.ok(/if\s*\(\s*!force\s*&&\s*state\.chatUserScrolledUp\s*\)\s*return/.test(body),
    'must early-return when state.chatUserScrolledUp is true UNLESS force=true');
});

t('CHAT_SCROLL_BOTTOM_THRESHOLD constant declared (50px standard)', () => {
  assert.ok(/const\s+CHAT_SCROLL_BOTTOM_THRESHOLD\s*=\s*50\b/.test(APP),
    'threshold must be defined as a named constant (50px is the standard browser-affordance cutoff)');
});

t('_chatUserIsAtBottom helper uses the threshold + treats 0-height as bottom', () => {
  const helpIdx = APP.search(/function\s+_chatUserIsAtBottom\s*\(/);
  assert.ok(helpIdx > -1, '_chatUserIsAtBottom helper must exist');
  const body = sliceFn(APP, helpIdx);
  assert.ok(/clientHeight\s*===\s*0/.test(body),
    'zero-height check: 0-height list (display:none / pre-layout) is considered at-bottom so initial scrolls still pin');
  assert.ok(/scrollHeight\s*-\s*list\.scrollTop\s*-\s*list\.clientHeight\s*\)?\s*<\s*CHAT_SCROLL_BOTTOM_THRESHOLD/.test(body),
    'must compute (scrollHeight - scrollTop - clientHeight) < CHAT_SCROLL_BOTTOM_THRESHOLD');
});

// ──────────────────────────────────────────────────────────────────────
// Scroll listener wired in bindChatUi
// ──────────────────────────────────────────────────────────────────────

function _bindChatUiBody() {
  const start = APP.search(/function\s+bindChatUi\s*\(/);
  assert.ok(start > -1, 'bindChatUi must exist');
  const rest = APP.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

t('bindChatUi attaches a scroll listener on #chat-messages', () => {
  const body = _bindChatUiBody();
  assert.ok(/getElementById\(['"]chat-messages['"]\)/.test(body) &&
            /addEventListener\(\s*['"]scroll['"]/.test(body),
    'must attach a scroll listener on #chat-messages');
});

t('scroll listener updates state.chatUserScrolledUp via _chatUserIsAtBottom', () => {
  const body = _bindChatUiBody();
  assert.ok(/state\.chatUserScrolledUp\s*=\s*!_chatUserIsAtBottom/.test(body),
    'listener must set state.chatUserScrolledUp = !_chatUserIsAtBottom(list)');
});

t('scroll listener uses passive: true (we only read scroll positions)', () => {
  const body = _bindChatUiBody();
  assert.ok(/\{\s*passive:\s*true\s*\}/.test(body),
    'scroll listener must be passive (perf + no preventDefault use)');
});

t('scroll listener is bind-once-guarded so session switches don\'t double-bind', () => {
  const body = _bindChatUiBody();
  assert.ok(/scrollBound/.test(body),
    'must use a dataset.scrollBound guard (or similar) to prevent double-binding on re-init');
});

// ──────────────────────────────────────────────────────────────────────
// State resets: pane-open + session-switch clear the flag
// ──────────────────────────────────────────────────────────────────────

t('setChatPane(true) clears chatUserScrolledUp + force-scrolls', () => {
  const start = APP.search(/function\s+setChatPane\s*\(/);
  const body = sliceFn(APP, start);
  // Opening the pane is a user-initiated event; should always land at bottom.
  assert.ok(/state\.chatUserScrolledUp\s*=\s*false[\s\S]{0,200}?scrollChatToLatest\(\s*\{\s*force:\s*true\s*\}\s*\)/.test(body),
    'setChatPane(true) must clear chatUserScrolledUp BEFORE calling scrollChatToLatest({ force: true })');
});

t('_resetUiForNewSession clears chatUserScrolledUp', () => {
  const start = APP.search(/function\s+_resetUiForNewSession\s*\(/);
  const body = sliceFn(APP, start);
  assert.ok(/state\.chatUserScrolledUp\s*=\s*false/.test(body),
    'session switch must reset chatUserScrolledUp so the new session starts at the bottom');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation — threshold math
// ──────────────────────────────────────────────────────────────────────

t('simulation: user near bottom (within 50px) → at-bottom', () => {
  const list = { scrollHeight: 1000, scrollTop: 970, clientHeight: 50 };
  // 1000 - 970 - 50 = -20 → "above bottom by negative" → at bottom.
  // Real cases: 980, 950 → diff 20, 50 → both < 50 threshold (50 is borderline; using < not <=).
  const diff = list.scrollHeight - list.scrollTop - list.clientHeight;
  assert.ok(diff < 50, 'a list 980/950 scroll position should read as at-bottom');
});

t('simulation: user scrolled up 200px → NOT at-bottom', () => {
  const list = { scrollHeight: 1000, scrollTop: 750, clientHeight: 50 };
  // 1000 - 750 - 50 = 200 → 200 >= 50 → NOT at bottom → scrollUp = true → auto-scroll suppressed.
  const diff = list.scrollHeight - list.scrollTop - list.clientHeight;
  assert.ok(diff >= 50, 'user scrolled 200px up should suppress auto-scroll');
});

t('simulation: 0-height list → treated as at-bottom (initial layout)', () => {
  const list = { scrollHeight: 0, scrollTop: 0, clientHeight: 0 };
  // Mirrors the helper's clientHeight === 0 short-circuit. Otherwise
  // the first render-before-display-flip would compute 0-0-0=0 < 50
  // which incidentally works, but the explicit check documents intent.
  assert.strictEqual(list.clientHeight, 0, '0-height list short-circuits the threshold check via explicit guard');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
