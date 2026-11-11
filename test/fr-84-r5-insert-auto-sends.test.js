// User report (kkrazy 2026-05-27): "click on 'insert' show sent
// directly to the chat without clicking on the 'send' button again".
//
// Before this fix the Insert button in the diagram modal only
// APPENDED the markdown to the chat input — the user then had to
// click Send (or hit Enter) to actually ship it. That two-step UX
// is friction for the dominant path (draw → send). Now Insert =
// insert + submit, one click.
//
// Implementation: after successfully appending the markdown to
// #chat-input, _diagramSave calls #chat-form's requestSubmit() so
// the existing submit handler (which calls submitChat()) runs the
// normal send path. Auto-send only fires in the SUCCESS branch of
// the save POST — failures still leave the modal open with an
// error so the user can retry or cancel.

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

console.log('── fr-84 r5: Insert auto-submits the chat form ──');

t('app.js: _diagramSave triggers a form submit after a successful insert', () => {
  const idx = APP.search(/async\s+function\s+_diagramSave\s*\(\s*\)/);
  assert.ok(idx > -1, '_diagramSave function must exist');
  const win = sliceFn(APP, idx);
  // Auto-submit goes through the form so the existing submit handler
  // (defined in the chat-init closure) runs the real send path.
  // Either requestSubmit() OR a dispatch of a submit Event are
  // acceptable shapes — pin one of them.
  assert.ok(
    /chat-form[\s\S]{0,200}requestSubmit\(\)/.test(win) ||
    /requestSubmit\(\)[\s\S]{0,200}chat-form/.test(win) ||
    /dispatchEvent\(\s*new\s+Event\(\s*['"]submit['"]/.test(win),
    '_diagramSave must trigger #chat-form submission (requestSubmit() or a synthetic submit Event) after inserting the markdown'
  );
});

t('app.js: auto-submit lives in the success path, NOT the error path', () => {
  const idx = APP.search(/async\s+function\s+_diagramSave\s*\(\s*\)/);
  const win = sliceFn(APP, idx);
  // The form submit must come AFTER input.value = ... (so the value
  // is in the textarea when submitChat reads it) and BEFORE the
  // catch / finally blocks (so failures don't auto-send anything).
  const setValueIdx = win.search(/input\.value\s*=\s*cur\s*\?/);
  const submitIdx   = win.search(/requestSubmit\(\)|dispatchEvent\(\s*new\s+Event\(\s*['"]submit['"]/);
  const catchIdx    = win.search(/\}\s*catch\s*\(/);
  assert.ok(setValueIdx > -1, 'precondition: input.value assignment must be findable');
  assert.ok(submitIdx > -1,   'precondition: form-submit call must be findable');
  assert.ok(submitIdx > setValueIdx,
    'form submit must fire AFTER input.value is set (textarea needs the markdown when submitChat reads it)');
  if (catchIdx > -1) {
    assert.ok(submitIdx < catchIdx,
      'form submit must fire BEFORE the catch block — failed saves must NOT auto-send anything');
  }
});

t('app.js: comment near the auto-submit explains WHY (so a future refactor doesn\'t strip it)', () => {
  const idx = APP.search(/async\s+function\s+_diagramSave\s*\(\s*\)/);
  const win = sliceFn(APP, idx);
  // Look for explanatory text near the requestSubmit / dispatchEvent
  // mentioning the user intent.
  const submitIdx = win.search(/requestSubmit\(\)|dispatchEvent\(\s*new\s+Event\(\s*['"]submit['"]/);
  if (submitIdx === -1) return;            // covered by the first test
  const around = win.slice(Math.max(0, submitIdx - 400), submitIdx + 200);
  assert.ok(/r5|Insert|auto-?send|send directly|without clicking/i.test(around),
    'the auto-submit line should be commented (Insert = insert+send, per user request) so a future cleanup can\'t innocently revert it');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
