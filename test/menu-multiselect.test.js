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
const {
  MULTI_SELECT_CURSOR_RE, SUBMIT_ROW_RE,
  TOOL_INVOCATION_RE, CORNER_BLOCK_RE,
  STATUS_TOKEN_TRAILER_RE, STATUS_INTERRUPT_RE, EFFORT_CHIP_RE,
} = require('../server/src/pty-patterns');

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

// ─── Submit nav patterns — _findSubmitNavCount inputs ─────────────────
// The arrow-burst that drives "click Submit" is only safe when the
// cursor finder lands on the active option row (not a stray ❯ in the
// breadcrumb/redraw residue) and the Submit finder lands on the actual
// Submit row (not a footer hint that happens to end in "submit"). Both
// failures inflate the cursor→Submit row delta and overshoot, wrapping
// the cursor in claude's TUI and resolving the wrong row.

t('MULTI_SELECT_CURSOR_RE matches ❯ on a checkbox option line', () => {
  assert.ok(MULTI_SELECT_CURSOR_RE.test('❯ 1. [✔] Security'));
  assert.ok(MULTI_SELECT_CURSOR_RE.test('❯ 1. [ ] Observability'));
  assert.ok(MULTI_SELECT_CURSOR_RE.test('❯ 3. [x] CI/CD'));
});

t('MULTI_SELECT_CURSOR_RE rejects a stray ❯ without a checkbox on the same line', () => {
  // Plan-mode wizard breadcrumb places ❯ on the active step — the
  // pre-fix code latched onto this and inflated cursor→Submit by 10+
  // rows.
  assert.ok(!MULTI_SELECT_CURSOR_RE.test('←  ☒ Feature ❯ ☐ Stack  →'));
  // Single-select cursor row has ❯ but no [ ]/[x] checkbox.
  assert.ok(!MULTI_SELECT_CURSOR_RE.test('❯ 1. Submit answers'));
  // Help hint at the bottom of a dialog occasionally uses ❯ as a
  // pointer; should not be mistaken for an option cursor.
  assert.ok(!MULTI_SELECT_CURSOR_RE.test('❯ Use the arrow keys to navigate'));
});

t('SUBMIT_ROW_RE matches a bare Submit-row label only', () => {
  assert.ok(SUBMIT_ROW_RE.test('Submit'));
  assert.ok(SUBMIT_ROW_RE.test('     Submit'));
  assert.ok(SUBMIT_ROW_RE.test('Submit   '));
  // Alt labels claude has been observed cycling through for the
  // final-action row across releases.
  assert.ok(SUBMIT_ROW_RE.test('Done'));
  assert.ok(SUBMIT_ROW_RE.test('  Continue  '));
});

t('SUBMIT_ROW_RE rejects footer hints that end in "submit"', () => {
  // This was the LAST-match-wins bug: a footer hint sits BELOW the
  // real Submit row, so the loose pattern stole submitRow and the nav
  // burst overshot by however many lines separated them.
  assert.ok(!SUBMIT_ROW_RE.test('Tab/Arrow keys to navigate · Enter to submit'));
  assert.ok(!SUBMIT_ROW_RE.test('Press Enter to Submit'));
  // The wizard's final-step option "Submit answers" must not be
  // mistaken for the multi-select Submit row.
  assert.ok(!SUBMIT_ROW_RE.test('1. Submit answers'));
  assert.ok(!SUBMIT_ROW_RE.test(' ● Submit and continue'));
});

// ─── TUI surface regexes added 2026-05-13 ──────────────────────────────
// Five new patterns from the local-sessions survey: tool invocation
// header, corner-glyph status block, and three status-bar trailers
// (token throughput, interrupt-state, effort chip). The first two
// are exported for future server-side consumers; the last three feed
// _extractStatus() in pty.js.

t('TOOL_INVOCATION_RE matches `● Bash(cmd)` / `● Read(path)` / display-form tools', () => {
  assert.ok(TOOL_INVOCATION_RE.test('● Bash(npm test)'));
  assert.ok(TOOL_INVOCATION_RE.test('● Read(/wks/kkrazy/myco/server/src/pty.js)'));
  assert.ok(TOOL_INVOCATION_RE.test('● Web Search("Shenzhen weather")'));
  assert.ok(TOOL_INVOCATION_RE.test('● Agent(Map myco architecture for diagram)'));
  // Captures: tool name (group 1) + argument blob (group 2).
  const m = TOOL_INVOCATION_RE.exec('● Bash(npm test)');
  assert.strictEqual(m[1], 'Bash');
  assert.strictEqual(m[2], 'npm test');
  // Indented continuation in a chain.
  assert.ok(TOOL_INVOCATION_RE.test('    ● Agent(do something)'));
});

t('TOOL_INVOCATION_RE rejects prose mentions of the same shape', () => {
  // Without the ● glyph this is just prose ("Run Bash(npm test)").
  assert.ok(!TOOL_INVOCATION_RE.test('Bash(npm test)'));
  // ● glyph but no parens — not a tool invocation header.
  assert.ok(!TOOL_INVOCATION_RE.test('● Some heading'));
});

t('CORNER_BLOCK_RE matches the labelled corner-glyph variants claude renders', () => {
  assert.ok(CORNER_BLOCK_RE.test('⎿  Error: Exit code 127'));
  assert.ok(CORNER_BLOCK_RE.test('⎿  Tip: Use /memory to view…'));
  assert.ok(CORNER_BLOCK_RE.test('⎿  Note: only the first 5 entries'));
  assert.ok(CORNER_BLOCK_RE.test('⎿  Warning: file looks binary'));
  assert.ok(CORNER_BLOCK_RE.test('⎿  Result: 3 files changed'));
  // "Did N <thing> in Xs" is the only no-colon shape claude uses.
  assert.ok(CORNER_BLOCK_RE.test('⎿  Did 1 search in 4s'));
});

t('CORNER_BLOCK_RE rejects free-form text with the label words mid-line', () => {
  // No corner glyph at start.
  assert.ok(!CORNER_BLOCK_RE.test('Error: this is just prose'));
  // Corner glyph + unknown label.
  assert.ok(!CORNER_BLOCK_RE.test('⎿  random string'));
  // The label needs to be at the start of the body, not mid-text.
  assert.ok(!CORNER_BLOCK_RE.test('something  ⎿  Error: x'));
});

t('STATUS_TOKEN_TRAILER_RE matches inline token throughput chips', () => {
  assert.ok(STATUS_TOKEN_TRAILER_RE.test('✽ Cerebrating for 12s · ↓ 3.4k tokens'));
  assert.ok(STATUS_TOKEN_TRAILER_RE.test('↑ 4.2k tokens'));
  assert.ok(STATUS_TOKEN_TRAILER_RE.test('↓ 800 tokens'));     // no unit suffix
  // Group capture: direction + count + scale.
  const m = STATUS_TOKEN_TRAILER_RE.exec('✽ Working for 47s · ↓ 7.6k tokens');
  assert.strictEqual(m[1], '↓');
  assert.strictEqual(m[2], '7.6');
  assert.strictEqual(m[3], 'k');
});

t('STATUS_TOKEN_TRAILER_RE rejects no-arrow prose', () => {
  // "4.2k tokens" without the up/down arrow is just a number — not a
  // status chip. Without this rejection the parser would over-count.
  assert.ok(!STATUS_TOKEN_TRAILER_RE.test('Used 4.2k tokens'));
});

t('STATUS_INTERRUPT_RE matches the dot-separated interrupt trailer', () => {
  assert.ok(STATUS_INTERRUPT_RE.test('· esc to interrupt'));
  assert.ok(STATUS_INTERRUPT_RE.test('✽ Working · esc to interrupt'));
  // Case insensitive (claude has been observed capitalizing Esc).
  assert.ok(STATUS_INTERRUPT_RE.test('· Esc to Interrupt'));
});

t('STATUS_INTERRUPT_RE rejects "esc to interrupt" without the dot bullet', () => {
  // Dialog hint footers use sentence punctuation; the spinner-bar
  // trailer is the dot variant. Distinguishes the two surfaces.
  assert.ok(!STATUS_INTERRUPT_RE.test('press esc to interrupt'));
});

t('EFFORT_CHIP_RE matches the bottom-right effort indicator', () => {
  assert.ok(EFFORT_CHIP_RE.test('◉ xhigh · /effort'));
  assert.ok(EFFORT_CHIP_RE.test('◉ medium'));
  const m = EFFORT_CHIP_RE.exec('◉ high · /effort');
  assert.strictEqual(m[1], 'high');
});

t('EFFORT_CHIP_RE rejects the glyph alone or with unrelated content', () => {
  assert.ok(!EFFORT_CHIP_RE.test('◉'));
  assert.ok(!EFFORT_CHIP_RE.test('plain prose'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
