// fr-92: mobile swipe up/down on the composer surfaces history
// navigation since touch devices have no arrow keys.
//
// User-reported (verbatim, plan-item dispatch from @labxnow):
//   Problem:  Mobile users can't access composer history because
//             there's no arrow-key equivalent on touch devices.
//   Expected: Swipe up/down on the composer simulates up/down arrow
//             presses, surfacing previous/next history entries.
//   Actual:   Composer history is effectively unreachable on mobile
//             — no gesture is wired to the history navigation.
//   Context:  Mobile UX only; should mirror the existing desktop
//             arrow-key behavior on the composer input.
//
// Implementation notes (Test reads these so the regression catches
// future drift):
//   · Wired on the #chat-input textarea (the composer input).
//   · touchstart records the initial Y + a timestamp.
//   · touchend computes dy + elapsed. Swipe = |dy| ≥ SWIPE_MIN_PX
//     within SWIPE_MAX_MS. dy < 0 = swipe up = ArrowUp.
//   · Multi-touch is skipped (avoids fighting pinch-zoom).
//   · Before dispatching the synthetic keydown the handler moves
//     the input cursor to the extreme the existing arrow-key
//     handler checks (start for Up, end for Down) so its guard
//     accepts the swipe.
//   · The synthetic event is `new KeyboardEvent('keydown', {key,
//     bubbles: true, cancelable: true})` — the existing handler
//     above does the real work; no logic duplication.
//
// Test shape: static-grep on web/public/app.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── fr-92: mobile swipe → arrow keys for composer history ──');

t('web/public/app.js: touchstart listener registered on the composer input', () => {
  const app = _read('web/public/app.js');
  // Find the bindChatUi function and look inside for the touchstart
  // wiring on input (the local variable that resolves to #chat-input).
  const at = app.search(/function\s+bindChatUi\s*\(/);
  assert.ok(at > -1, 'bindChatUi must exist (anchor for the swipe-handler scan).');
  const body = sliceFn(app, at);
  assert.ok(/input\.addEventListener\s*\(\s*['"]touchstart['"]/.test(body),
    'bindChatUi must register a `touchstart` listener on the composer input (the start of swipe detection — fr-92).');
});

t('web/public/app.js: touchend listener registered on the composer input', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/function\s+bindChatUi\s*\(/);
  const body = sliceFn(app, at);
  assert.ok(/input\.addEventListener\s*\(\s*['"]touchend['"]/.test(body),
    'bindChatUi must register a `touchend` listener on the composer input (fires the synthetic keydown after computing dy + elapsed — fr-92).');
});

t('web/public/app.js: swipe handler dispatches synthetic ArrowUp / ArrowDown KeyboardEvents', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/function\s+bindChatUi\s*\(/);
  const body = sliceFn(app, at);
  // The handler must construct a KeyboardEvent('keydown') with
  // key:'ArrowUp' or 'ArrowDown' so the existing arrow-key handler
  // above (state-machine + draft-save semantics) runs unchanged.
  assert.ok(/new\s+KeyboardEvent\s*\(\s*['"]keydown['"]/.test(body),
    'fr-92 swipe handler must construct a synthetic `KeyboardEvent("keydown", ...)` so the existing arrow-key handler runs (no logic duplication).');
  assert.ok(/ArrowUp/.test(body) && /ArrowDown/.test(body),
    'fr-92 swipe handler must reference both `ArrowUp` and `ArrowDown` keys so swipe-up and swipe-down each route to the correct history-step branch.');
});

t('web/public/app.js: swipe handler positions cursor before dispatch so the existing handler guard accepts it', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/function\s+bindChatUi\s*\(/);
  const body = sliceFn(app, at);
  // The existing arrow-key handler guards on `selStart !== 0` for Up
  // and `selEnd !== value.length` for Down. The swipe handler must
  // move the cursor to the correct extreme BEFORE dispatching so the
  // guard accepts the synthetic event.
  // Loose match: a `selectionStart = selectionEnd = 0` AND a
  // `selectionStart = selectionEnd = input.value.length` BOTH appear
  // in the handler window — one for the Up branch, one for Down.
  assert.ok(/selectionStart\s*=\s*input\.selectionEnd\s*=\s*0\b/.test(body),
    'fr-92 swipe-up branch must set `input.selectionStart = input.selectionEnd = 0` so the existing arrow-key handler\'s cursor guard accepts the synthetic event.');
  assert.ok(/selectionStart\s*=\s*input\.selectionEnd\s*=\s*input\.value\.length/.test(body),
    'fr-92 swipe-down branch must set `input.selectionStart = input.selectionEnd = input.value.length` so the existing handler accepts it.');
});

t('web/public/app.js: swipe detection uses distance + time thresholds (not every touch fires)', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/function\s+bindChatUi\s*\(/);
  const body = sliceFn(app, at);
  // Two thresholds: SWIPE_MIN_PX (filter wobble) and SWIPE_MAX_MS
  // (filter long scrolls). Without both, a long sustained drag or a
  // tiny wobble would fire spurious history-step events.
  assert.ok(/SWIPE_MIN_PX|MIN_PX|swipe.*\d+/i.test(body),
    'fr-92 swipe detection must use a minimum vertical-distance threshold so wobble doesn\'t fire history-step events.');
  assert.ok(/SWIPE_MAX_MS|MAX_MS|swipe.*ms/i.test(body),
    'fr-92 swipe detection must use a maximum-elapsed-time threshold so long scrolls / sustained drags don\'t fire history-step events.');
});

t('web/public/app.js: swipe handler skips multi-touch (e.touches.length !== 1)', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/function\s+bindChatUi\s*\(/);
  const body = sliceFn(app, at);
  // The handler must early-return on multi-touch (pinch-zoom, two-
  // finger scroll) so it doesn't fight the user's other gestures.
  assert.ok(/e\.touches\.length\s*!==\s*1|touches\.length\s*!==\s*1/.test(body),
    'fr-92 swipe handler must skip multi-touch (touches.length !== 1) so pinch-zoom / two-finger scroll aren\'t mis-classified as swipes.');
});

t('a comment naming fr-92 explains the swipe-to-arrow plumbing', () => {
  const app = _read('web/public/app.js');
  assert.ok(/fr-92/.test(app),
    'a comment naming fr-92 must appear in app.js so a future restyle understands why the touchstart/touchend listeners exist on the composer input.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
