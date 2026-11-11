// User-reported (kkrazy 2026-05-26):
//   "after sending cmd like the following: /fr @myco Users miss chat
//    events that require their attention when the browser tab isn't
//    focused., the '@myco' visual stays in the chat field, it should
//    be removed once the msg/cmd is sent"
//
// Root cause: `submitChat()` (web/public/app.js) clears the textarea
// via `input.value = ''` after sending. Programmatic value assignment
// does NOT fire the `input` event, so the listener that rebuilds the
// `#composer-chips` host (`_renderComposerChips()`) never re-runs and
// the chip rendered from the pre-send value lingers visually.
//
// Same root cause for the history-browsing Esc-clear branch (Esc
// while recalling chat history clears the input but leaves stale
// chips behind).
//
// Static-grep guard: every site that programmatically clears
// `#chat-input` MUST call `_renderComposerChips()` immediately after
// so the chip pane reflects the (now empty) value. If a future
// refactor adds a new clear site without the chip-rebuild call, this
// test fails.

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

console.log('── bug: composer @-chip lingers after send ──');

t('app.js: _renderComposerChips helper exists + reads from #chat-input', () => {
  assert.ok(/function\s+_renderComposerChips\s*\(\s*\)/.test(APP),
    '_renderComposerChips helper must be defined');
  const idx = APP.search(/function\s+_renderComposerChips\s*\(\s*\)/);
  const win = sliceFn(APP, idx);
  assert.ok(/getElementById\(['"]chat-input['"]\)/.test(win),
    'helper must read from #chat-input to know what chips to render');
  assert.ok(/getElementById\(['"]composer-chips['"]\)/.test(win),
    'helper must mount chips into #composer-chips');
});

t('app.js: submitChat clears input.value AND calls _renderComposerChips', () => {
  // The send path. After clearing the textarea, the chip pane must be
  // rebuilt — programmatic .value = '' doesn't fire `input`.
  const idx = APP.search(/function\s+submitChat\s*\(/);
  assert.ok(idx > -1, 'submitChat function must exist');
  // Slice from submitChat through its closing brace area. The clear
  // and the chip-rebuild call must both live inside this function.
  const win = sliceFn(APP, idx);
  assert.ok(/input\.value\s*=\s*['"]['"]/.test(win),
    'submitChat must clear input.value after a successful send');
  assert.ok(/_renderComposerChips\(\)/.test(win),
    'submitChat must call _renderComposerChips() after clearing the input ' +
    '(programmatic .value= does NOT fire the input event)');
  // Anchor ordering: the chip-rebuild must come AFTER the clear, not
  // before. A pre-clear call would rebuild from the still-populated
  // value and leave the chip behind.
  const clearIdx = win.search(/input\.value\s*=\s*['"]['"]/);
  const rebuildIdx = win.search(/_renderComposerChips\(\)/);
  assert.ok(clearIdx > -1 && rebuildIdx > -1 && rebuildIdx > clearIdx,
    '_renderComposerChips() must be called AFTER input.value = ""');
});

t('app.js: Esc-while-browsing-history clear also rebuilds chips', () => {
  // The Esc-during-recall branch in the keydown handler. Same root
  // cause — programmatic .value='' leaves chips stale.
  // Anchor: the comment "Esc exits browsing AND clears the input".
  const idx = APP.search(/Esc exits browsing AND clears the input/);
  assert.ok(idx > -1, 'Esc-clear branch comment must be findable');
  // Slice the branch body — small window since the branch is a few
  // lines (state reset + input.value='' + autoResize + return).
  const win = APP.slice(idx, idx + 500);
  assert.ok(/input\.value\s*=\s*['"]['"]/.test(win),
    'Esc branch must clear input.value');
  assert.ok(/_renderComposerChips\(\)/.test(win),
    'Esc branch must call _renderComposerChips() after clearing the input');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
