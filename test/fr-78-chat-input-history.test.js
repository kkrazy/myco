// fr-78: Up/Down arrow keys recall previously-submitted chat input.
//
// User-reported (kkrazy 2026-05-25):
//   "Chat pane has no in-memory history, so users can't quickly recall
//    prior inputs. Expected: Up/down arrow keys cycle through previously
//    submitted messages in the current session."
//
// Implementation:
//   - state.chatInputHistory: per-session in-memory array of submitted
//     messages. Capped at 200 entries; duplicates of the immediate-
//     previous entry skipped (bash readline pattern).
//   - state.chatHistoryIdx: null when not browsing; integer index into
//     history when browsing back.
//   - state.chatHistoryDraft: the in-progress text the user was typing
//     when they started browsing — restored when Down pasts the most
//     recent entry.
//   - submitChat pushes the just-sent text onto the history; resets
//     idx + draft for the next browse.
//   - input keydown ArrowUp/ArrowDown handler in bindChatUi:
//     * Defers to IME + autocomplete-open + modifier-modified keys
//     * Up only fires when cursor at start (no selection)
//     * Down only fires when cursor at end (no selection)
//     * Mid-line arrow stays as default cursor nav (no hijack)
//     * Up at oldest → bounce (no-op)
//     * Down past most recent → restore saved draft + exit browsing
//   - Any non-arrow keystroke while browsing exits browsing mode
//     (keeps recalled text; Esc explicitly clears).
//   - Per-session reset: _resetUiForNewSession clears all 3 fields
//     so a session switch starts with a fresh recall buffer.
//
// Browser-DOM behavior tests are hard to write meaningfully without
// jsdom; the existing test/*.test.js suite is pure Node. So fr-78
// tests use static source-shape guards on the key invariants:

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

console.log('── fr-78: chat input arrow-key history recall ──');

// ──────────────────────────────────────────────────────────────────────
// State fields exist + cleared on session switch
// ──────────────────────────────────────────────────────────────────────

t('app.js: _resetUiForNewSession clears chatInputHistory + chatHistoryIdx + chatHistoryDraft', () => {
  const idx = APP.search(/function\s+_resetUiForNewSession\s*\(/);
  assert.ok(idx > -1, '_resetUiForNewSession must exist');
  const win = sliceFn(APP, idx);
  assert.ok(/state\.chatInputHistory\s*=\s*\[\]/.test(win),
    'session reset must clear chatInputHistory');
  assert.ok(/state\.chatHistoryIdx\s*=\s*null/.test(win),
    'session reset must clear chatHistoryIdx');
  assert.ok(/state\.chatHistoryDraft\s*=\s*null/.test(win),
    'session reset must clear chatHistoryDraft');
});

// ──────────────────────────────────────────────────────────────────────
// submitChat pushes onto history
// ──────────────────────────────────────────────────────────────────────

t('app.js: submitChat pushes the just-sent text onto chatInputHistory', () => {
  const idx = APP.search(/function\s+submitChat\s*\(/);
  assert.ok(idx > -1);
  const win = sliceFn(APP, idx);
  assert.ok(/chatInputHistory/.test(win),
    'submitChat must touch chatInputHistory');
  assert.ok(/\.push\s*\(\s*submitted\s*\)/.test(win),
    'submitChat must .push(submitted) onto the history array');
  // Cap at 200.
  assert.ok(/200/.test(win),
    'submitChat must enforce a cap (200) on history length');
});

t('app.js: submitChat resets chatHistoryIdx + Draft after sending', () => {
  const idx = APP.search(/function\s+submitChat\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/state\.chatHistoryIdx\s*=\s*null/.test(win),
    'after send, browsing cursor must reset so next ArrowUp starts at most recent');
  assert.ok(/state\.chatHistoryDraft\s*=\s*null/.test(win),
    'saved draft must reset too — fresh send replaces any stale draft');
});

t('app.js: submitChat skips duplicate-of-previous-entry pushes (bash readline)', () => {
  const idx = APP.search(/function\s+submitChat\s*\(/);
  const win = sliceFn(APP, idx);
  // The dup check compares the last entry vs submitted.
  assert.ok(/hist\[hist\.length\s*-\s*1\]\s*!==\s*submitted/.test(win),
    'must skip when submitted matches the last history entry');
});

// ──────────────────────────────────────────────────────────────────────
// Arrow-key handler — guards + behavior
// ──────────────────────────────────────────────────────────────────────

t('app.js: ArrowUp/ArrowDown handler registered on chat input', () => {
  // Find the handler by its discriminating ArrowUp/ArrowDown check.
  const idx = APP.search(/e\.key\s*!==\s*['"]ArrowUp['"]\s*&&\s*e\.key\s*!==\s*['"]ArrowDown['"]/);
  assert.ok(idx > -1,
    'ArrowUp/ArrowDown keydown handler must exist on chat input');
});

t('app.js: ArrowUp/ArrowDown defers to autocomplete when open', () => {
  const idx = APP.search(/e\.key\s*!==\s*['"]ArrowUp['"]\s*&&\s*e\.key\s*!==\s*['"]ArrowDown['"]/);
  const win = APP.slice(idx, idx + 2500);
  assert.ok(/chat-autocomplete/.test(win),
    'handler must check the autocomplete dropdown id');
  assert.ok(/ac\s*&&\s*!ac\.hidden/.test(win),
    'handler must return early when autocomplete is open');
});

t('app.js: ArrowUp/ArrowDown defers to IME composition', () => {
  const idx = APP.search(/e\.key\s*!==\s*['"]ArrowUp['"]\s*&&\s*e\.key\s*!==\s*['"]ArrowDown['"]/);
  const win = APP.slice(idx, idx + 2500);
  assert.ok(/e\.isComposing/.test(win),
    'handler must check e.isComposing (IME composition);');
});

t('app.js: ArrowUp only fires at cursor position 0 (multi-line guard)', () => {
  const idx = APP.search(/e\.key\s*!==\s*['"]ArrowUp['"]\s*&&\s*e\.key\s*!==\s*['"]ArrowDown['"]/);
  const win = APP.slice(idx, idx + 3500);
  assert.ok(/selStart\s*!==\s*0/.test(win),
    'ArrowUp must bail when cursor is not at the start (preserves multi-line nav)');
});

t('app.js: ArrowDown only fires at cursor position == value.length', () => {
  const idx = APP.search(/e\.key\s*!==\s*['"]ArrowUp['"]\s*&&\s*e\.key\s*!==\s*['"]ArrowDown['"]/);
  const win = APP.slice(idx, idx + 3500);
  assert.ok(/selEnd\s*!==\s*value\.length/.test(win),
    'ArrowDown must bail when cursor is not at the end (preserves multi-line nav)');
});

t('app.js: ArrowUp from null index saves the current draft (chatHistoryDraft)', () => {
  const idx = APP.search(/e\.key\s*!==\s*['"]ArrowUp['"]\s*&&\s*e\.key\s*!==\s*['"]ArrowDown['"]/);
  const win = APP.slice(idx, idx + 3500);
  // Look for the chatHistoryDraft assignment in the ArrowUp branch.
  assert.ok(/state\.chatHistoryDraft\s*=\s*value/.test(win),
    'ArrowUp must save the current input as chatHistoryDraft so a later Down past most recent can restore it');
});

t('app.js: ArrowDown past most recent restores chatHistoryDraft + exits browsing', () => {
  const idx = APP.search(/e\.key\s*!==\s*['"]ArrowUp['"]\s*&&\s*e\.key\s*!==\s*['"]ArrowDown['"]/);
  const win = APP.slice(idx, idx + 4500);
  // Must read chatHistoryDraft + assign it to input.value when stepping past the end.
  assert.ok(/state\.chatHistoryDraft/.test(win),
    'ArrowDown past-most-recent must reference chatHistoryDraft');
  // After restoring, idx + draft both null'd.
  assert.ok(/state\.chatHistoryIdx\s*=\s*null/.test(win),
    'past-most-recent must reset idx to null');
});

t('app.js: any non-arrow keystroke while browsing exits browsing mode', () => {
  // There should be a SECOND keydown listener that handles "exit browsing
  // on any non-arrow content keystroke."
  //
  // fr-95 follow-up: the original anchor (the FIRST occurrence of
  // `chatHistoryIdx == null` return) was ambiguous — the primary arrow
  // handler ALSO uses that guard inside its ArrowDown branch (line
  // ~8482). The slice from THAT match's location doesn't reach the
  // Escape branch (which lives in the SECOND, non-arrow listener at
  // line ~8557). Anchor on the distinctive non-arrow-listener comment
  // instead, which is unambiguous + locally adjacent to the Escape
  // handler. The contract this test locks (the non-arrow keydown
  // listener exists + ignores arrows + handles Escape by clearing the
  // input) is unchanged.
  const commentAnchor = APP.search(/non-arrow keystroke while browsing exits browsing mode/);
  assert.ok(commentAnchor > -1,
    'a non-arrow keydown listener must exist (anchored by its docstring comment).');
  const win = APP.slice(commentAnchor, commentAnchor + 1500);
  assert.ok(/state\.chatHistoryIdx\s*==\s*null/.test(win),
    'the non-arrow listener must check state.chatHistoryIdx and bail when not browsing');
  assert.ok(/ArrowUp|ArrowDown/.test(win),
    'the listener must ignore ArrowUp/ArrowDown (handled by the primary listener)');
  assert.ok(/Escape/.test(win),
    'Escape must explicitly clear the input + exit browsing');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
