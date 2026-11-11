// bug-12 regression: re-entering a session via the back icon must
// leave the chat pane visible.
//
// User-reported flow (mobile, ≤900px):
//   1. User is in session A's chat — state.chatPaneVisible === true.
//   2. User taps the back icon (#btn-expand) to see the session list:
//        setSidebar(false)
//          → on mobile, line in setSidebar: setChatPane(false)
//          → state.chatPaneVisible === false (chat hidden, sidebar shown)
//   3. User taps the SAME session card to re-enter session A:
//        openSession(id) early-return branch hits (same activeId, WS open)
//        → setSidebar(true) collapses sidebar
//        → BUT no setChatPane(true) restoration
//   4. Result: neither sidebar nor chat pane visible — input deactivated.
//
// Fix: the re-tap branch in openSession() must call setChatPane(true)
// after setSidebar(true) so the user lands back in the chat pane.
//
// Test strategy: static-grep guard on the openSession re-tap branch in
// web/public/app.js. We extract the block from the function-open up to
// the first `_teardownPreviousSession()` call (the divider between
// re-tap and full-attach paths), then assert setChatPane(true) appears
// inside that window. Plus a small behavior surrogate: assert
// setChatPane(true) is the call shape that DOES re-open the pane.

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

console.log('── bug-12: re-entering a session via back icon restores the chat pane ──');

function _openSessionReentryBlock() {
  // Extract from `function openSession(id` to the first
  // `_teardownPreviousSession()` call — that's the re-tap branch.
  const start = APP.search(/function\s+openSession\s*\(/);
  assert.ok(start > -1, 'openSession must exist in app.js');
  const rest = APP.slice(start);
  const divider = rest.search(/_teardownPreviousSession\s*\(/);
  assert.ok(divider > -1, 'openSession must have the _teardownPreviousSession divider that separates re-tap from full-attach paths');
  return rest.slice(0, divider);
}

t('static guard: openSession re-tap branch calls setChatPane(true)', () => {
  // Pre-fix the re-tap branch only called setSidebar(true) — leaving
  // the chat pane hidden because setSidebar(false) earlier dismissed
  // it on mobile. Fix: explicitly setChatPane(true) so the user lands
  // back in the chat.
  const block = _openSessionReentryBlock();
  assert.ok(/setChatPane\s*\(\s*true\s*\)/.test(block),
    'the re-tap branch must call setChatPane(true) so the chat pane is restored when the user re-enters a session via the back icon');
});

t('static guard: re-tap branch references the same-id + open-WS conditions', () => {
  // Sanity: make sure the block we extracted IS the re-tap branch and
  // not some other early-return that incidentally contains
  // setChatPane(true). The re-tap branch is gated on activeId match +
  // WS readyState === OPEN.
  const block = _openSessionReentryBlock();
  assert.ok(/state\.activeId\s*===\s*id/.test(block),
    'block must be the re-tap branch (gated on activeId === id)');
  assert.ok(/readyState\s*===\s*WebSocket\.OPEN/.test(block),
    'block must be the re-tap branch (also gated on WS readyState === OPEN)');
});

t('static guard: setChatPane(true) is the canonical "show chat pane" call', () => {
  // Make sure the helper we're relying on actually un-hides the chat
  // pane. The fix's contract is: setChatPane(true) → pane.hidden=false
  // + state.chatPaneVisible=true. This pins that contract so a future
  // refactor that flips the boolean polarity (e.g. setChatPane(false)
  // meaning "show") breaks loudly.
  const setStart = APP.search(/function\s+setChatPane\s*\(/);
  assert.ok(setStart > -1, 'setChatPane must exist');
  const body = sliceFn(APP, setStart);
  assert.ok(/pane\.hidden\s*=\s*!visible/.test(body),
    'setChatPane(true) must un-hide the chat pane (pane.hidden = !visible)');
  assert.ok(/state\.chatPaneVisible\s*=\s*!!visible/.test(body),
    'setChatPane(true) must set state.chatPaneVisible=true');
});

t('behavior: simulated reentry restores chatPaneVisible to true', () => {
  // Mini-simulation of the user flow using a fake state + the same
  // helpers' polarity. Tests the fix's contract end-to-end.
  const state = { chatPaneVisible: true, activeId: 'sess-A', ws: { readyState: 1 } };
  const WebSocketOPEN = 1;
  const sidebar = { hidden: true };
  const pane = { hidden: false };
  const WINDOW_WIDTH = 700; // mobile

  function setSidebar(collapsed) {
    sidebar.hidden = collapsed;
    // Mobile: showing sidebar dismisses chat (mirrors app.js:1348).
    if (!collapsed && WINDOW_WIDTH <= 900) setChatPane(false);
  }
  function setChatPane(visible) {
    pane.hidden = !visible;
    state.chatPaneVisible = !!visible;
  }
  function openSessionReentry(id) {
    if (state.activeId === id && state.ws && state.ws.readyState === WebSocketOPEN) {
      if (WINDOW_WIDTH <= 900) {
        setSidebar(true);
        // bug-12 fix: also restore the chat pane (the back-icon path
        // dismissed it via setSidebar(false) earlier).
        setChatPane(true);
      }
      return true;
    }
    return false;
  }

  // (2) user taps back icon
  setSidebar(false);
  assert.strictEqual(pane.hidden, true, 'after back-icon tap, chat pane is hidden');
  assert.strictEqual(state.chatPaneVisible, false, 'state reflects hidden chat');

  // (3) user taps the same session card → re-tap branch
  const tookReentry = openSessionReentry('sess-A');
  assert.strictEqual(tookReentry, true, 're-tap branch handled the click');
  assert.strictEqual(state.chatPaneVisible, true, 'chat pane is visible again after fix');
  assert.strictEqual(pane.hidden, false, 'pane element un-hidden');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
