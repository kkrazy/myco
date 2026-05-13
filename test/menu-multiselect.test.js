// MenuInterceptor — multi-select (checkbox) dialog handling.
//
// Claude code renders multi-select dialogs with "[ ]" / "[x]" markers
// after each numbered option's prefix. Each digit press toggles ONE
// checkbox; Enter submits the whole set. The parser must:
//   * recognise the checkbox marker
//   * strip it from the label
//   * stash {checkbox, checked} per option
//   * set menu.multi = true when ANY option carries a checkbox
//   * leave non-checkbox options (e.g. a final "Done" line) intact
//     so the chat picker can treat them as plain picks (digit+CR)
//
// Hash MUST stay stable when only the checked state changes — the chat
// row needs to keep its identity across toggle clicks so we can locate
// it to persist each toggle.

const assert = require('assert');
const { MenuInterceptor, hashMenu } = require('../server/src/menu-interceptor');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

// Minimal headless stub — same shape MenuInterceptor expects from xterm.
function fakeHeadless(text) {
  const lines = text.split('\n');
  return {
    rows: lines.length,
    buffer: {
      active: {
        viewportY: 0,
        getLine: (y) => ({ translateToString: () => lines[y] || '' }),
      },
    },
  };
}

t('multi-select dialog: every option carries a [ ]/[x] marker', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless([
    'Pick the features to enable:',
    '❯ 1. [ ] OAuth',
    '  2. [x] Allowlist',
    '  3. [ ] PAT login',
  ].join('\n')));
  assert.strictEqual(r.kind, 'newMenu');
  assert.strictEqual(r.menu.multi, true);
  assert.strictEqual(r.menu.options.length, 3);
  assert.strictEqual(r.menu.options[0].checkbox, true);
  assert.strictEqual(r.menu.options[0].checked, false);
  assert.strictEqual(r.menu.options[0].label, 'OAuth');
  assert.strictEqual(r.menu.options[1].checked, true);
  assert.strictEqual(r.menu.options[1].label, 'Allowlist');
  assert.strictEqual(r.menu.options[2].checked, false);
  assert.strictEqual(r.menu.options[2].label, 'PAT login');
});

t('checkbox variants: x / X / ✓ / ✔ / ● / * all count as checked', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless([
    'Select:',
    '❯ 1. [x] one',
    '  2. [X] two',
    '  3. [✓] three',
    '  4. [✔] four',
    '  5. [●] five',
    '  6. [*] six',
  ].join('\n')));
  assert.strictEqual(r.menu.multi, true);
  for (const o of r.menu.options) {
    assert.strictEqual(o.checked, true, `option ${o.n} (${o.label}) should be checked`);
  }
});

t('mixed dialog: checkbox options + a plain "Done" line', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless([
    'Pick the features to enable:',
    '❯ 1. [ ] OAuth',
    '  2. [ ] Allowlist',
    '  3. Done',
  ].join('\n')));
  assert.strictEqual(r.menu.multi, true);
  assert.strictEqual(r.menu.options.length, 3);
  // Checkboxes stripped, labels clean
  assert.strictEqual(r.menu.options[0].checkbox, true);
  assert.strictEqual(r.menu.options[0].label, 'OAuth');
  // Non-checkbox final option intact — UI renders as plain pick (digit+CR)
  assert.strictEqual(r.menu.options[2].checkbox, undefined);
  assert.strictEqual(r.menu.options[2].label, 'Done');
});

t('single-select dialog: no checkbox markers → multi:false', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless([
    'What would you like to do?',
    '❯ 1. Yes',
    '  2. No',
  ].join('\n')));
  assert.strictEqual(r.menu.multi, false);
  for (const o of r.menu.options) {
    assert.strictEqual(o.checkbox, undefined);
    assert.strictEqual(o.checked, undefined);
  }
});

t('hash is stable across checked-state changes', () => {
  // Same dialog, different checked sets — chat row must keep its identity.
  const empty = [
    { n: 1, label: 'OAuth',     checkbox: true, checked: false },
    { n: 2, label: 'Allowlist', checkbox: true, checked: false },
  ];
  const partial = [
    { n: 1, label: 'OAuth',     checkbox: true, checked: false },
    { n: 2, label: 'Allowlist', checkbox: true, checked: true },
  ];
  const full = [
    { n: 1, label: 'OAuth',     checkbox: true, checked: true },
    { n: 2, label: 'Allowlist', checkbox: true, checked: true },
  ];
  const q = 'Pick the features to enable:';
  assert.strictEqual(hashMenu(q, empty), hashMenu(q, partial));
  assert.strictEqual(hashMenu(q, partial), hashMenu(q, full));
});

t('checkbox detection tolerates bullet/dash between marker and "["', () => {
  // Some claude variants insert a bullet, dash, or arrow between the
  // numeric marker and the checkbox. Previous strict regex rejected
  // these and the option fell back to "plain pick" — clicking it
  // disabled the whole row. The loosened regex accepts the decoration.
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless([
    'Pick the features:',
    '❯ 1. — [ ] OAuth',
    '  2. • [x] Allowlist',
    '  3. ➜ [ ] PAT login',
  ].join('\n')));
  assert.strictEqual(r.menu.multi, true);
  assert.strictEqual(r.menu.options.length, 3);
  for (const o of r.menu.options) assert.strictEqual(o.checkbox, true, `option ${o.n} should be a checkbox`);
  assert.strictEqual(r.menu.options[0].checked, false);
  assert.strictEqual(r.menu.options[1].checked, true);
  assert.strictEqual(r.menu.options[0].label, 'OAuth');
  assert.strictEqual(r.menu.options[1].label, 'Allowlist');
});

t('detectChange returns sameMenu when only checked state changes', () => {
  const i = new MenuInterceptor();
  const before = i.detectChange(fakeHeadless([
    'Pick the features:',
    '❯ 1. [ ] OAuth',
    '  2. [ ] Allowlist',
  ].join('\n')));
  assert.strictEqual(before.kind, 'newMenu');
  // User pressed "2" in TUI — option 2 flips to checked. detectChange must
  // recognise this is the SAME dialog (not a new one) so the chat row
  // doesn't get duplicated.
  const after = i.detectChange(fakeHeadless([
    'Pick the features:',
    '❯ 1. [ ] OAuth',
    '  2. [x] Allowlist',
  ].join('\n')));
  assert.strictEqual(after.kind, 'sameMenu');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
