// bug-32 regression: agent-event auto-scroll must respect the user's
// scroll position — same contract as bug-26 for chat-message scroll.
//
// User report: "Chat pane keep scroll to the latest msg as they come
// making it difficult for user who are reading the history"
//
// bug-26 already fixed the chat-message auto-scroll path
// (scrollChatToLatest gated on state.chatUserScrolledUp), but the
// _appendAgentEvent code path had THREE direct
// `pane.scrollTop = pane.scrollHeight` writes that bypassed the
// guard entirely. Every chrome event (canUseTool, hook_allow,
// hook_deny, system_init, turn_result, etc.) and every streamed
// assistant_text token yanked the user back to bottom even when
// they had scrolled up to read history. Live ticker traffic
// (turn_result + assistant_text streaming) hits these paths many
// times per second during an active turn, making history-reading
// impossible until the turn ended.
//
// Fix: replace each direct `pane.scrollTop = pane.scrollHeight` in
// _appendAgentEvent with `scrollChatToLatest()` — same DOM target
// (`pane` resolves to #chat-messages via _ensureAgentLogPane), but
// now honors the bug-26 chatUserScrolledUp guard.
//
// Static guards on app.js: no direct pane.scrollTop=pane.scrollHeight
// writes remain in the file, _appendAgentEvent body calls
// scrollChatToLatest, and a behavior simulation of the guard logic
// pins the predicate's contract.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP_RAW = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
// Strip JS comments so the scrollTop scans don't false-positive on
// historical explanations / docstrings. Handle // line comments and
// /* … */ block comments. Naive but sufficient for our scan targets
// (we never embed scrollTop= literals inside strings in app.js).
function _stripComments(src) {
  // Block comments first (non-greedy), then line comments.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const APP = _stripComments(APP_RAW);

console.log('── bug-32: agent-event auto-scroll respects scroll position ──');

// ──────────────────────────────────────────────────────────────────────
// Top-level guards: no rogue `pane.scrollTop = pane.scrollHeight`
// writes anywhere in the file. The only allowed direct
// list.scrollTop = list.scrollHeight writes live inside the
// scrollChatToLatest helper itself.
// ──────────────────────────────────────────────────────────────────────

t('no `pane.scrollTop = pane.scrollHeight` writes remain (bypassed bug-26 guard pre-fix)', () => {
  // Count actual occurrences in CODE (not comments). The fix replaced
  // all three sites in _appendAgentEvent with scrollChatToLatest().
  // The only surviving mention is in a comment explaining the fix.
  const codeLines = APP.split('\n').filter((line) => {
    // Drop lines that are clearly comments (the historical mention
    // we deliberately kept to anchor the fix's rationale).
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
    return /pane\.scrollTop\s*=\s*pane\.scrollHeight/.test(line);
  });
  assert.strictEqual(codeLines.length, 0,
    'No `pane.scrollTop = pane.scrollHeight` writes should remain in code — they bypass the bug-26 chatUserScrolledUp guard. Found: ' + JSON.stringify(codeLines));
});

t('chat-pane direct `pane.scrollTop = pane.scrollHeight` writes are eliminated', () => {
  // The bug-32-relevant footgun is `pane.scrollTop=pane.scrollHeight`
  // — that's what `_appendAgentEvent` did pre-fix (and `pane` resolves
  // to #chat-messages via _ensureAgentLogPane). Other variable names
  // (`list` inside scrollChatToLatest, `el` inside renderLogEntries
  // for the log panel, etc.) are legitimate. The scan runs against
  // the comment-stripped source so the bug-32 explanatory comments
  // don't false-positive.
  const paneWrites = [...APP.matchAll(/pane\.scrollTop\s*=\s*pane\.scrollHeight/g)];
  assert.strictEqual(paneWrites.length, 0,
    'No `pane.scrollTop = pane.scrollHeight` writes should exist in code — every chat-pane auto-scroll-to-bottom must route through scrollChatToLatest so the bug-26 chatUserScrolledUp guard fires. Found ' + paneWrites.length + ' occurrences.');
});

t('scrollChatToLatest contains exactly two `list.scrollTop = list.scrollHeight` writes (sync + rAF)', () => {
  // Pin the helper's shape: it does the actual scroll on `list`
  // (which is `document.getElementById('chat-messages')`). Two writes:
  // one synchronous + one inside requestAnimationFrame, so the scroll
  // works for both already-laid-out + just-flipped-from-hidden cases.
  const start = APP.search(/function\s+scrollChatToLatest\s*\(/);
  assert.ok(start > -1, 'scrollChatToLatest must exist');
  const rest = APP.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  const listWrites = (body.match(/list\.scrollTop\s*=\s*list\.scrollHeight/g) || []).length;
  assert.strictEqual(listWrites, 2,
    'scrollChatToLatest must contain exactly 2 `list.scrollTop = list.scrollHeight` writes (sync + rAF for both already-laid-out and 0-height paths). Found ' + listWrites);
});

// ──────────────────────────────────────────────────────────────────────
// Confirm _appendAgentEvent uses scrollChatToLatest at each site
// ──────────────────────────────────────────────────────────────────────

t('_appendAgentEvent body calls scrollChatToLatest (not pane.scrollTop directly)', () => {
  const start = APP.search(/function\s+_appendAgentEvent\s*\(/);
  assert.ok(start > -1, '_appendAgentEvent must exist');
  const rest = APP.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  // The function had 3 auto-scroll sites pre-fix; each must now be a
  // scrollChatToLatest() call.
  const calls = (body.match(/scrollChatToLatest\s*\(/g) || []).length;
  assert.ok(calls >= 3,
    '_appendAgentEvent must call scrollChatToLatest at all three auto-scroll sites (chrome-batch path, assistant_text-merge path, default-append path). Found ' + calls + ' calls.');
  // And no direct pane.scrollTop writes inside the body.
  assert.ok(!/pane\.scrollTop\s*=\s*pane\.scrollHeight/.test(body.replace(/\/\/[^\n]*\n/g, '\n')),
    '_appendAgentEvent must NOT contain `pane.scrollTop = pane.scrollHeight` in non-comment code — that bypasses the bug-26 guard');
});

// ──────────────────────────────────────────────────────────────────────
// Guard predicate contract (same shape bug-26 pinned for chat msgs)
// ──────────────────────────────────────────────────────────────────────

t('scrollChatToLatest still respects the chatUserScrolledUp guard', () => {
  const start = APP.search(/function\s+scrollChatToLatest\s*\(/);
  assert.ok(start > -1, 'scrollChatToLatest must exist');
  const rest = APP.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  // The guard line: `if (!force && state.chatUserScrolledUp) return;`
  // Without this the bug-26 contract is dead.
  assert.ok(/if\s*\(\s*!force\s*&&\s*state\.chatUserScrolledUp\s*\)\s*return/.test(body),
    'scrollChatToLatest must early-return when !force AND state.chatUserScrolledUp — this is the bug-26 guard that bug-32 now also routes through');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation — model the guard's contract on a fake state.
// If the predicate changes shape, both the impl + the test rebuild
// have to move in lockstep.
// ──────────────────────────────────────────────────────────────────────

function fakeScrollChatToLatest(state, list, { force = false } = {}) {
  // Mirror the impl: short-circuit on the guard, otherwise pin to bottom.
  if (!force && state.chatUserScrolledUp) return false;
  list.scrollTop = list.scrollHeight;
  return true;
}

t('simulated: user scrolled up → agent event arrives → scroll suppressed', () => {
  const state = { chatUserScrolledUp: true };
  const list = { scrollTop: 200, scrollHeight: 2000, clientHeight: 600 };
  const scrolled = fakeScrollChatToLatest(state, list);
  assert.strictEqual(scrolled, false, 'guard fires — scroll was suppressed');
  assert.strictEqual(list.scrollTop, 200, 'user\'s scroll position is preserved');
});

t('simulated: user at bottom → agent event arrives → scroll keeps them pinned', () => {
  const state = { chatUserScrolledUp: false };
  const list = { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 };
  const scrolled = fakeScrollChatToLatest(state, list);
  assert.strictEqual(scrolled, true, 'guard did not fire — scroll proceeded');
  assert.strictEqual(list.scrollTop, list.scrollHeight, 'user pinned to latest');
});

t('simulated: force=true bypasses the guard even when user has scrolled up', () => {
  // Used by session-switch and pane-open paths — those legitimately
  // need to scroll regardless of where the user was.
  const state = { chatUserScrolledUp: true };
  const list = { scrollTop: 200, scrollHeight: 2000, clientHeight: 600 };
  const scrolled = fakeScrollChatToLatest(state, list, { force: true });
  assert.strictEqual(scrolled, true, 'force=true wins');
  assert.strictEqual(list.scrollTop, list.scrollHeight, 'force-scroll pinned to latest');
});

t('simulated: streaming assistant_text tokens during history-read → all suppressed', () => {
  // Repro of the live bug: agent is streaming assistant_text token-by-
  // token; each tick hits _appendAgentEvent's assistant_text-merge
  // path. Pre-fix every tick yanked the user. Post-fix every tick
  // honors the guard and the user stays put.
  const state = { chatUserScrolledUp: true };
  const list = { scrollTop: 200, scrollHeight: 2000, clientHeight: 600 };
  let suppressed = 0;
  for (let i = 0; i < 50; i++) {
    list.scrollHeight += 20;   // simulate growing content
    const ok = fakeScrollChatToLatest(state, list);
    if (!ok) suppressed++;
  }
  assert.strictEqual(suppressed, 50, 'all 50 streaming ticks suppressed');
  assert.strictEqual(list.scrollTop, 200, 'user\'s read position never moved');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
