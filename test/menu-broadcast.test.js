// Intensive coverage of the chat-broadcast behaviour that backs the
// TUI dialog interception: menu detection, permission decisions, and
// the @myco shortcuts when a menu is pending.
//
// Pure functions are tested directly; the @myco-shortcut path is
// exercised via handleChatMessage with a fake session.

const assert = require('assert');
const { MenuInterceptor, hashMenu } = require('../server/src/menu-interceptor');
const permissions = require('../server/src/permissions');
const ptyMod = require('../server/src/pty');

let passed = 0;
let failed = 0;
const failures = [];

function section(name) { console.log('\n── ' + name + ' ──'); }
// Tests can be either sync or async. Async tests use a `.then` chain that
// the runner awaits via the returned promise. We accumulate pending tests
// and await them at the bottom of the file before printing the summary.
const _pending = [];
function t(name, fn) {
  const exec = async () => {
    try {
      await fn();
      console.log('  ✓ ' + name);
      passed++;
    } catch (err) {
      console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err));
      failures.push({ name, err });
      failed++;
    }
  };
  _pending.push(exec());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fake xterm headless ───────────────────────────────────────────────────
// MenuInterceptor only uses headless.rows + headless.buffer.active.{viewportY,
// getLine(y).translateToString(true)}. Stub the minimum we need.
//
// MenuInterceptor now requires at least one option line to carry the
// `❯` cursor marker (the false-positive guard against numbered prose
// in claude's assistant turns). To keep these legacy fixtures terse,
// we auto-prepend `❯ ` to the FIRST option-marker line when no line
// in the input already has the cursor. Fixtures that intentionally
// test the no-cursor case (e.g. plain prose, false-positive guards)
// don't include any markers, so this is a no-op for them. The cursor
// guard itself is regression-tested in test.sh:test_chat_window.
function fakeHeadless(text) {
  const lines = text.split('\n');
  if (!lines.some((l) => l && l.includes('❯'))) {
    for (let i = 0; i < lines.length; i++) {
      if (/(?:^|\s)(?:\[\d\]|\(\d\)|\d[.)])/.test(lines[i] || '')) {
        lines[i] = lines[i].replace(/^(\s*)/, '$1❯ ');
        break;
      }
    }
  }
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

// ─── MenuInterceptor parsing ───────────────────────────────────────────────
section('MenuInterceptor — detection');

t('plan dialog with 3 options is detected as kind=plan', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless([
    'The plan is ready for review.',
    'What would you like to do?',
    '❯ 1. Yes, proceed with this plan',
    '  2. Yes, but with the following changes',
    '  3. No, keep planning',
  ].join('\n')));
  assert.strictEqual(r.kind, 'newMenu');
  assert.strictEqual(r.menu.kind, 'plan');
  assert.strictEqual(r.menu.options.length, 3);
  assert.strictEqual(r.menu.options[0].n, 1);
  assert.strictEqual(r.menu.options[0].label, 'Yes, proceed with this plan');
});

t('permission dialog detected as kind=permission', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless([
    'Allow Bash command?',
    '> git status',
    '❯ 1. Yes',
    '  2. No, suggest a different approach',
    '  3. Always allow git commands',
  ].join('\n')));
  assert.strictEqual(r.menu.kind, 'permission');
});

t('generic question stays kind=generic', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless([
    'Some context here.',
    'Pick one:',
    '  1. apple',
    '  2. banana',
  ].join('\n')));
  assert.strictEqual(r.menu.kind, 'generic');
});

t('plain text returns null', () => {
  const i = new MenuInterceptor();
  assert.strictEqual(i.detectChange(fakeHeadless('Hello world.\nNo menu here.')), null);
});

t('a single "1. foo" line is NOT a menu (false-positive guard)', () => {
  const i = new MenuInterceptor();
  assert.strictEqual(i.detectChange(fakeHeadless('Steps:\n1. install deps\nthen build it')), null);
});

t('non-contiguous options are rejected (1. then 3.)', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless([
    'Pick:',
    '1. apple',
    '',
    '',
    '',
    '3. cherry',
  ].join('\n')));
  assert.strictEqual(r, null);
});

t('out-of-order numbering is rejected (2. then 1.)', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless([
    'Pick:',
    '2. apple',
    '1. banana',
  ].join('\n')));
  assert.strictEqual(r, null);
});

t('options up to 9 captured', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless([
    'Choose one option:',
    '1. apple', '2. banana', '3. cherry', '4. date', '5. elderberry',
  ].join('\n')));
  assert.strictEqual(r.menu.options.length, 5);
});

t('parens-style options (1) accepted', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless('Pick one?\n1) apple\n2) banana'));
  assert.ok(r);
  assert.strictEqual(r.menu.options.length, 2);
});

t('bracketed options [1] accepted', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless('Pick one?\n[1] apple\n[2] banana'));
  assert.ok(r);
  assert.strictEqual(r.menu.options.length, 2);
  assert.strictEqual(r.menu.options[0].n, 1);
  assert.strictEqual(r.menu.options[0].label, 'apple');
});

t('paren-wrapped options (1) accepted', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless('Pick one?\n(1) apple\n(2) banana'));
  assert.ok(r);
  assert.strictEqual(r.menu.options.length, 2);
});

t('bracketed menu starting from a non-1 digit is still detected (viewport-cut case)', () => {
  // "[4] Type something." / "[5] Chat about this" — a real case the user
  // hit where Claude's dialog scrolled past the start of the menu and only
  // the trailing options remained on screen.
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless('What would you like to do?\n[4] Type something.\n[5] Chat about this'));
  assert.ok(r, 'expected newMenu for bracketed menu starting at 4');
  assert.strictEqual(r.menu.options.length, 2);
  assert.strictEqual(r.menu.options[0].n, 4);
  assert.strictEqual(r.menu.options[1].n, 5);
});

t('non-contiguous bracketed options ([1] then [3]) still rejected', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless('Pick:\n[1] apple\n[3] cherry'));
  assert.strictEqual(r, null);
});

t('mixed shapes in one menu (rare but supported)', () => {
  // The parser shouldn't choke if Claude mixes "[1]" and "2." across lines —
  // e.g. a quoted broadcast followed by Claude's actual rephrasing. As long
  // as the numbers are contiguous and labels >=2 chars, accept.
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless('Choose?\n[1] apple\n2. banana'));
  assert.ok(r);
  assert.strictEqual(r.menu.options.length, 2);
});

t('multiple options packed on ONE line are all extracted', () => {
  // The reported case: "[4] Type something. [5] Chat about this" — a
  // single line with two option markers. Both must be picked up.
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless('What would you like to do?\n[4] Type something. [5] Chat about this'));
  assert.ok(r, 'expected newMenu for multi-option line');
  assert.strictEqual(r.menu.options.length, 2);
  assert.deepStrictEqual(r.menu.options.map((o) => o.n), [4, 5]);
  assert.strictEqual(r.menu.options[0].label, 'Type something.');
  assert.strictEqual(r.menu.options[1].label, 'Chat about this');
});

t('three options packed on one line', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless('Pick?\n[1] apple [2] banana [3] cherry'));
  assert.ok(r);
  assert.strictEqual(r.menu.options.length, 3);
  assert.deepStrictEqual(r.menu.options.map((o) => o.n), [1, 2, 3]);
});

t('prose with embedded "[1] foo" reference but no second marker is NOT a menu', () => {
  // Single marker without a second contiguous one — should not fire.
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless('I tried [1] foo and it worked fine.\nThen ran more tests.'));
  assert.strictEqual(r, null);
});

t('marker without trailing space is NOT recognised (avoid "arr[4]access")', () => {
  // [4] must be followed by whitespace to count as an option marker.
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless('I accessed arr[4]access then arr[5]apple\nMore prose.'));
  assert.strictEqual(r, null);
});

t('marker preceded by a non-space char is NOT recognised ("v1.0" / "abc1.")', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless('Version v1. apple v2. banana some prose'));
  // No real boundary before "1." or "2." — they're glued to "v".
  assert.strictEqual(r, null);
});

t('different bullet markers (❯, >, *, •) recognised', () => {
  const i1 = new MenuInterceptor();
  assert.ok(i1.detectChange(fakeHeadless('Pick?\n❯ 1. apple\n  2. banana')));
  const i2 = new MenuInterceptor();
  assert.ok(i2.detectChange(fakeHeadless('Pick?\n* 1. apple\n* 2. banana')));
  const i3 = new MenuInterceptor();
  assert.ok(i3.detectChange(fakeHeadless('Pick?\n• 1. apple\n• 2. banana')));
});

t('label with trailing whitespace stripped', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless('Q?\n  1. apple   \n  2. banana    '));
  assert.strictEqual(r.menu.options[0].label, 'apple');
  assert.strictEqual(r.menu.options[1].label, 'banana');
});

t('empty/single-char labels are skipped (decoration guard)', () => {
  const i = new MenuInterceptor();
  // A loose "1." with no real label should not count as a menu by itself.
  const r = i.detectChange(fakeHeadless('Q?\n1. \n2. '));
  assert.strictEqual(r, null);
});

t('option numbers > 9 ignored (single-digit menus only)', () => {
  const i = new MenuInterceptor();
  // 10. is rejected at the digit-range filter; we should still pick up 1+2.
  const r = i.detectChange(fakeHeadless('Q?\n1. one\n2. two\n10. ten'));
  assert.strictEqual(r.menu.options.length, 2);
});

t('question scan finds the question line above options', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless([
    'preamble line',
    '',
    'What do you want to do?',
    '',
    '1. one',
    '2. two',
  ].join('\n')));
  assert.strictEqual(r.menu.question, 'What do you want to do?');
});

t('classification: "Always allow" option label triggers permission kind', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless([
    'Run this?',
    '1. Yes',
    '2. No',
    '3. Always allow bash commands',
  ].join('\n')));
  assert.strictEqual(r.menu.kind, 'permission');
});

t('classification: keep planning option triggers plan kind', () => {
  const i = new MenuInterceptor();
  const r = i.detectChange(fakeHeadless([
    'What would you like to do?',
    '1. Yes, proceed',
    '2. No, keep planning',
  ].join('\n')));
  assert.strictEqual(r.menu.kind, 'plan');
});

section('MenuInterceptor — state machine');

// Note: option labels must be ≥2 chars — the parser rejects 1-char labels
// as decoration (false-positive guard against numbered prose like "Step 1.").

t('repeat scan of identical dialog returns sameMenu', () => {
  const i = new MenuInterceptor();
  const blob = 'Pick?\n1. apple\n2. banana';
  const r1 = i.detectChange(fakeHeadless(blob));
  const r2 = i.detectChange(fakeHeadless(blob));
  assert.strictEqual(r1.kind, 'newMenu');
  assert.strictEqual(r2.kind, 'sameMenu');
});

t('dialog disappears between scans → cleared', () => {
  const i = new MenuInterceptor();
  i.detectChange(fakeHeadless('Pick?\n1. apple\n2. banana'));
  const r = i.detectChange(fakeHeadless('just text'));
  assert.strictEqual(r.kind, 'cleared');
});

t('different dialog after first → newMenu (not sameMenu)', () => {
  const i = new MenuInterceptor();
  i.detectChange(fakeHeadless('Pick fruit?\n1. apple\n2. banana'));
  const r = i.detectChange(fakeHeadless('Pick color?\n1. red\n2. blue'));
  assert.strictEqual(r.kind, 'newMenu');
});

t('reset() clears the cached hash so the same dialog re-fires', () => {
  const i = new MenuInterceptor();
  const blob = 'Pick?\n1. apple\n2. banana';
  i.detectChange(fakeHeadless(blob));
  i.reset();
  const r = i.detectChange(fakeHeadless(blob));
  assert.strictEqual(r.kind, 'newMenu');
});

t('no dialog and no prior state → null (not "cleared")', () => {
  const i = new MenuInterceptor();
  assert.strictEqual(i.detectChange(fakeHeadless('text')), null);
});

t('hashMenu is stable for the same inputs', () => {
  const h1 = hashMenu('Q?', [{ n: 1, label: 'a' }, { n: 2, label: 'b' }]);
  const h2 = hashMenu('Q?', [{ n: 1, label: 'a' }, { n: 2, label: 'b' }]);
  assert.strictEqual(h1, h2);
});

t('hashMenu differs across changed labels', () => {
  const h1 = hashMenu('Q?', [{ n: 1, label: 'a' }]);
  const h2 = hashMenu('Q?', [{ n: 1, label: 'b' }]);
  assert.notStrictEqual(h1, h2);
});

// ─── permissions.matchesPattern ────────────────────────────────────────────
section('permissions.matchesPattern');

const m = permissions.matchesPattern;

t('bare tool "Read" matches any input', () => {
  assert.strictEqual(m('Read', 'Read', '/x'), true);
  assert.strictEqual(m('Read', 'Read', ''), true);
});

t('bare tool does NOT match a different tool', () => {
  assert.strictEqual(m('Read', 'Edit', '/x'), false);
});

t('"Bash(git)" prefix-matches "git status"', () => {
  assert.strictEqual(m('Bash(git)', 'Bash', 'git status'), true);
});

t('"Bash(git)" does NOT match "github cli" (word boundary)', () => {
  assert.strictEqual(m('Bash(git)', 'Bash', 'github cli'), false);
});

t('"Bash(git:*)" alias of "Bash(git)"', () => {
  assert.strictEqual(m('Bash(git:*)', 'Bash', 'git log --oneline'), true);
  assert.strictEqual(m('Bash(git:*)', 'Bash', 'github'), false);
});

t('"Bash(*)" matches any bash input', () => {
  assert.strictEqual(m('Bash(*)', 'Bash', 'rm -rf /'), true);
  assert.strictEqual(m('Bash(*)', 'Bash', ''), true);
});

t('"Bash()" (empty parens) matches any', () => {
  assert.strictEqual(m('Bash()', 'Bash', 'anything'), true);
});

t('case-insensitive tool match', () => {
  assert.strictEqual(m('bash(git)', 'Bash', 'git status'), true);
  assert.strictEqual(m('Bash(git)', 'bash', 'git status'), true);
});

t('"Bash(./test.sh)" matches "./test.sh --skip-tests"', () => {
  assert.strictEqual(m('Bash(./test.sh)', 'Bash', './test.sh --skip-tests'), true);
});

t('"Bash(./test.sh)" does NOT match "./test.sh.bak"', () => {
  // Whitespace boundary: "./test.sh.bak" has no space after, so this should be false.
  assert.strictEqual(m('Bash(./test.sh)', 'Bash', './test.sh.bak'), false);
});

t('invalid pattern returns false (no crash)', () => {
  assert.strictEqual(m('not a valid pattern!', 'Bash', 'x'), false);
  assert.strictEqual(m('', 'Bash', 'x'), false);
});

t('null/undefined inputs handled', () => {
  assert.strictEqual(m(null, 'Bash', 'x'), false);
  assert.strictEqual(m('Bash', null, 'x'), false);
  assert.strictEqual(m('Bash(git)', 'Bash', null), false);   // null input never starts with "git"
});

t('input with leading whitespace still matches', () => {
  assert.strictEqual(m('Bash(git)', 'Bash', '   git status'), true);
});

t('special regex chars in pattern escaped (no injection)', () => {
  // A pattern with regex meta-chars must still prefix-match literally.
  assert.strictEqual(m('Bash(.+)', 'Bash', '.+ literal'), true);
  assert.strictEqual(m('Bash(.+)', 'Bash', 'anything'), false);
});

// ─── permissions.decide ────────────────────────────────────────────────────
section('permissions.decide');

const d = (rec, tool, input) => permissions.decide(rec, tool, input);

t('allow-list hit → allow', () => {
  assert.strictEqual(d({ allowList: ['Read'], denyList: [] }, 'Read', '/x'), 'allow');
});

t('deny-list hit → deny', () => {
  assert.strictEqual(d({ allowList: [], denyList: ['Bash(rm)'] }, 'Bash', 'rm -rf'), 'deny');
});

t('hit in BOTH allow + deny → deny wins (so user can pin a denial)', () => {
  assert.strictEqual(d({ allowList: ['Bash(*)'], denyList: ['Bash(rm)'] }, 'Bash', 'rm -rf'), 'deny');
});

t('no match → ask (no longer auto-deny)', () => {
  assert.strictEqual(d({ allowList: ['Read'], denyList: [] }, 'Bash', 'curl evil'), 'ask');
});

t('empty allow + empty deny → ask', () => {
  assert.strictEqual(d({ allowList: [], denyList: [] }, 'Bash', 'anything'), 'ask');
});

t('missing rec → ask', () => {
  assert.strictEqual(d(null, 'Bash', 'x'), 'ask');
  assert.strictEqual(d(undefined, 'Bash', 'x'), 'ask');
});

t('rec with missing lists is backfilled with defaults', () => {
  const rec = {};
  permissions.ensureSessionLists(rec);
  assert.ok(Array.isArray(rec.allowList));
  assert.ok(Array.isArray(rec.denyList));
  assert.ok(rec.allowList.includes('Read'));
});

t('addAllow + addDeny are idempotent and mutually-exclusive', () => {
  const rec = { allowList: [], denyList: [] };
  permissions.addAllow(rec, 'Bash(curl)');
  permissions.addAllow(rec, 'Bash(curl)');     // idempotent
  assert.strictEqual(rec.allowList.filter((p) => p === 'Bash(curl)').length, 1);
  permissions.addDeny(rec, 'Bash(curl)');      // flips
  assert.strictEqual(rec.allowList.includes('Bash(curl)'), false);
  assert.strictEqual(rec.denyList.includes('Bash(curl)'), true);
});

t('removePattern wipes from both lists', () => {
  const rec = { allowList: ['Bash(x)'], denyList: ['Bash(x)'] };  // weird state
  permissions.removePattern(rec, 'Bash(x)');
  assert.strictEqual(rec.allowList.includes('Bash(x)'), false);
  assert.strictEqual(rec.denyList.includes('Bash(x)'), false);
});

// ─── permissions.extractPermissionTarget ───────────────────────────────────
section('permissions.extractPermissionTarget');

const ex = permissions.extractPermissionTarget;

t('Allow Bash command? + > git status → {Bash, git status}', () => {
  const r = ex('Allow Bash command?\n> git status\n1. Yes\n2. No');
  assert.deepStrictEqual(r, { tool: 'Bash', input: 'git status' });
});

t('Edit file? recognises Edit tool', () => {
  const r = ex('Edit file?\n> /tmp/x.js\n1. Yes\n2. No');
  assert.strictEqual(r.tool, 'Edit');
  assert.strictEqual(r.input, '/tmp/x.js');
});

t('Bash command (no "Allow" prefix) still picks up Bash', () => {
  const r = ex('Bash command\n> npm install\n1. Yes\n2. No');
  assert.strictEqual(r.tool, 'Bash');
  assert.strictEqual(r.input, 'npm install');
});

t('"Run Bash command?" variant', () => {
  const r = ex('Run Bash command?\n> ls -la\n1. Yes');
  assert.strictEqual(r.tool, 'Bash');
});

t('no recognised tool name → null', () => {
  assert.strictEqual(ex('What would you like to do?\n1. a\n2. b'), null);
});

t('empty input → null (no rawText)', () => {
  assert.strictEqual(ex(''), null);
  assert.strictEqual(ex(null), null);
});

t('tool but no `>` prefix line → tool with empty input', () => {
  const r = ex('Allow Bash command?\n1. Yes\n2. No');
  assert.strictEqual(r.tool, 'Bash');
  assert.strictEqual(r.input, '');
});

t('❯ marker also matches the input line', () => {
  const r = ex('Allow Bash command?\n❯ rm -rf /\n1. Yes\n2. No');
  assert.strictEqual(r.tool, 'Bash');
  assert.strictEqual(r.input, 'rm -rf /');
});

t('Multiple tools mentioned → first match wins', () => {
  const r = ex('Allow Bash command?\nor maybe Edit?\n> echo hi\n1. Yes');
  assert.strictEqual(r.tool, 'Bash');
});

t('Write / Read / MultiEdit / Grep / Glob all recognised', () => {
  for (const tool of ['Write', 'Read', 'MultiEdit', 'Grep', 'Glob']) {
    const r = ex(`Allow ${tool} command?\n> something\n1. Yes`);
    assert.strictEqual(r && r.tool, tool, `tool=${tool} should be recognised`);
  }
});

// ─── @myco shortcut routing (integration) ─────────────────────────────────
section('@myco shortcuts when a menu is pending');

const EventEmitter = require('events');

function makeFakeSession(pendingMenu) {
  const writes = [];
  const emits = [];
  const ee = new EventEmitter();
  ee.sessionId = 'test-menu-broadcast-' + Math.random().toString(36).slice(2, 8);
  ee.alive = true;
  ee.pendingMenu = pendingMenu || null;
  ee.headless = null;             // → autoAcceptToggleBytes returns ''
  ee.write = (data) => writes.push(data);
  const origEmit = ee.emit.bind(ee);
  ee.emit = (event, ...args) => { emits.push({ event, args }); return origEmit(event, ...args); };
  return { session: ee, writes, emits };
}

const SAMPLE_MENU = {
  kind: 'permission',
  question: 'Allow Bash command?',
  options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }, { n: 3, label: 'Always allow' }],
  rawText: 'Allow Bash command?\n> echo hi\n1. Yes\n2. No\n3. Always allow',
};

t('@myco "1" with pending menu picks option 1 (no toggle, no Esc)', () => {
  const { session, writes } = makeFakeSession(SAMPLE_MENU);
  ptyMod.handleChatMessage(session.sessionId, session, 'tester', '@myco 1');
  assert.strictEqual(writes.length, 1, `expected exactly one write, got ${writes.length}: ${JSON.stringify(writes)}`);
  assert.strictEqual(writes[0], '1\r');
  assert.strictEqual(session.pendingMenu, null);
});

t('@myco "2" with pending menu picks option 2', () => {
  const { session, writes } = makeFakeSession(SAMPLE_MENU);
  ptyMod.handleChatMessage(session.sessionId, session, 'tester', '@myco 2');
  assert.strictEqual(writes[0], '2\r');
});

t('@myco "9" with no option 9 falls through to cancel+send', () => {
  const { session, writes } = makeFakeSession(SAMPLE_MENU);
  ptyMod.handleChatMessage(session.sessionId, session, 'tester', '@myco 9');
  // First write is Esc (cancel), then the input + \r (prose path), since
  // "9" isn't a valid option. After Esc clears the menu, the standard
  // toggle+send runs.
  assert.ok(writes.some((w) => w.includes('\x1b')), `expected an Esc write, got ${JSON.stringify(writes)}`);
});

t('@myco <prose> with pending menu cancels (Esc) then sends', async () => {
  const { session, writes } = makeFakeSession(SAMPLE_MENU);
  ptyMod.handleChatMessage(session.sessionId, session, 'tester', '@myco do the next task please');
  await sleep(150);  // wait for the deferred \r write
  // Esc first, then a text write, then a separate \r write.
  assert.strictEqual(writes[0], '\x1b', `first write should be Esc, got ${JSON.stringify(writes[0])}`);
  const tail = writes.slice(1).join('');
  assert.ok(tail.includes('do the next task please'), `expected text body after Esc, got ${JSON.stringify(writes)}`);
  assert.ok(writes.includes('\r'), `expected separate \\r write, got ${JSON.stringify(writes)}`);
  assert.strictEqual(session.pendingMenu, null);
});

t('@myco <prose> WITHOUT pending menu does NOT send an Esc', async () => {
  const { session, writes } = makeFakeSession(null);
  ptyMod.handleChatMessage(session.sessionId, session, 'tester', '@myco hello there');
  await sleep(150);
  for (const w of writes) {
    assert.notStrictEqual(w, '\x1b', `unexpected Esc write: ${JSON.stringify(writes)}`);
  }
  // Text + separate deferred \r — no bracketed-paste wrap.
  assert.ok(writes.some((w) => w === 'hello there'),
    `expected text write, got ${JSON.stringify(writes)}`);
  assert.ok(writes.includes('\r'), `\\r not written: ${JSON.stringify(writes)}`);
});

t('@myco "1" WITHOUT pending menu is plain text (not a digit pick)', async () => {
  const { session, writes } = makeFakeSession(null);
  ptyMod.handleChatMessage(session.sessionId, session, 'tester', '@myco 1');
  await sleep(150);
  // Without pendingMenu the shortcut shouldn't fire; the message goes
  // through the split-write path → "1" then separate "\r" after 100ms.
  assert.ok(writes.some((w) => w === '1'), `expected "1" text write, got ${JSON.stringify(writes)}`);
  assert.ok(writes.includes('\r'), `\\r not written: ${JSON.stringify(writes)}`);
  for (const w of writes) {
    assert.notStrictEqual(w, '\x1b');
  }
});

t('@myco "10" while menu pending → falls through to cancel (digit shortcut only matches 1-9)', () => {
  const { session, writes } = makeFakeSession(SAMPLE_MENU);
  ptyMod.handleChatMessage(session.sessionId, session, 'tester', '@myco 10');
  // "10" is treated as prose → Esc + normal send. NOT picked as a menu option.
  assert.strictEqual(writes[0], '\x1b');
});

t('@myco " 1 " (whitespace around digit) is still treated as a pick after trim', () => {
  const { session, writes } = makeFakeSession(SAMPLE_MENU);
  ptyMod.handleChatMessage(session.sessionId, session, 'tester', '@myco  1  ');
  // mycoMatch[1].trim() yields "1"; pure-digit branch fires.
  assert.strictEqual(writes[0], '1\r');
  assert.strictEqual(writes.length, 1);
});

t('claude-as-user (ASSISTANT_USER) chat is ignored (no PTY write)', () => {
  // The early "if (user === ASSISTANT_USER) return" guard in
  // handleChatMessage prevents self-loops. Even with a pending menu,
  // claude's own chat shouldn't trigger writes.
  const { session, writes } = makeFakeSession(SAMPLE_MENU);
  ptyMod.handleChatMessage(session.sessionId, session, 'claude', '@myco 1');
  assert.strictEqual(writes.length, 0);
  assert.deepStrictEqual(session.pendingMenu, SAMPLE_MENU);  // unchanged
});

// ─── Menu broadcasts are session-specific ─────────────────────────────────
//
// Each session has its own EventEmitter; the 'menu' listener wired in
// spawnClaude is closed over that session's id. A broadcast for session A
// must not surface in session B's chat listeners. These tests pin that
// invariant — without it the user sees "questions broadcasted to other
// sessions" in their browser.
section('Menu broadcast is session-specific');

const captureChat = (sessionObj) => {
  const chats = [];
  sessionObj.on('chat', (msg) => chats.push(msg));
  return chats;
};

const PLAN_MENU = {
  kind: 'plan',
  question: 'What would you like to do?',
  options: [
    { n: 1, label: 'Yes, proceed with this plan' },
    { n: 2, label: 'Yes, but with changes' },
    { n: 3, label: 'No, keep planning' },
  ],
  rawText: 'What would you like to do?\n1. Yes, proceed with this plan\n2. Yes, but with changes\n3. No, keep planning',
};

const PERMISSION_ASK_MENU = {
  kind: 'permission',
  question: 'Allow Bash command?',
  // "curl" intentionally isn't in DEFAULT_ALLOW — decide() falls through to 'ask'.
  options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }, { n: 3, label: 'Always allow' }],
  rawText: 'Allow Bash command?\n> curl example.com\n1. Yes\n2. No\n3. Always allow',
};

t('plan-mode broadcast lands ONLY on the originating session', () => {
  const A = makeFakeSession(null);
  const B = makeFakeSession(null);
  const aChats = captureChat(A.session);
  const bChats = captureChat(B.session);
  ptyMod.handleSessionMenu(A.session.sessionId, A.session, PLAN_MENU);
  assert.strictEqual(aChats.length, 1, 'A should receive exactly one chat broadcast');
  assert.strictEqual(bChats.length, 0, 'B must not receive A\'s broadcast');
  // Sanity: the message text reflects the menu options
  assert.ok(aChats[0].text.includes('keep planning'), 'broadcast should include menu option labels');
});

t('permission "ask" broadcast lands ONLY on the originating session', () => {
  const A = makeFakeSession(null);
  const B = makeFakeSession(null);
  const aChats = captureChat(A.session);
  const bChats = captureChat(B.session);
  ptyMod.handleSessionMenu(A.session.sessionId, A.session, PERMISSION_ASK_MENU);
  assert.strictEqual(aChats.length, 1, 'A should receive exactly one chat broadcast');
  assert.strictEqual(bChats.length, 0, 'B must not receive A\'s broadcast');
  // Permission-flavoured wording should be present
  assert.ok(/permission to run|Claude wants/i.test(aChats[0].text),
    `broadcast should use permission-tailored wording, got: ${aChats[0].text.slice(0, 100)}`);
});

t('two simultaneous broadcasts each stay on their own session', () => {
  const A = makeFakeSession(null);
  const B = makeFakeSession(null);
  const aChats = captureChat(A.session);
  const bChats = captureChat(B.session);
  ptyMod.handleSessionMenu(A.session.sessionId, A.session, PLAN_MENU);
  ptyMod.handleSessionMenu(B.session.sessionId, B.session, PERMISSION_ASK_MENU);
  assert.strictEqual(aChats.length, 1);
  assert.strictEqual(bChats.length, 1);
  assert.notStrictEqual(aChats[0].text, bChats[0].text, 'A and B should see different broadcasts');
  // Cross-check: A's chat is the plan menu, B's is the permission ask
  assert.ok(aChats[0].text.includes('keep planning'),         'A should have plan broadcast');
  assert.ok(/permission to run/i.test(bChats[0].text),        'B should have permission broadcast');
});

t('PTY writes from one session do not appear on the other (auto-respond)', () => {
  // Auto-allow path: PERMISSION_ASK_MENU's input is "curl example.com" which
  // is NOT in DEFAULT_ALLOW, so it falls through to 'ask' (broadcast). For
  // this test, use a menu whose input ('git status') matches the conservative
  // default allow list — handleSessionMenu should auto-pick option 1 on A
  // and never touch B's session.write.
  const A = makeFakeSession(null);
  const B = makeFakeSession(null);
  const ALLOWED_MENU = {
    kind: 'permission',
    question: 'Allow Bash command?',
    options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }],
    rawText: 'Allow Bash command?\n> git status\n1. Yes\n2. No',
  };
  // Make A's allowList include Bash(git). With sessionId not in the real
  // store, permissions.decide falls back to 'ask' (no rec). Force-allow by
  // giving the fake session a sessionId we'll temporarily insert into the
  // store, or just simulate the broadcast path. Simplest: rely on the 'ask'
  // path firing a broadcast on A and ensure NO write/chat reaches B.
  const aChats = captureChat(A.session);
  const bChats = captureChat(B.session);
  ptyMod.handleSessionMenu(A.session.sessionId, A.session, ALLOWED_MENU);
  assert.strictEqual(B.writes.length, 0, 'B must never receive a PTY write from A\'s menu');
  assert.strictEqual(bChats.length, 0,   'B must never receive a chat broadcast from A\'s menu');
  // A must have either a write (auto-respond) OR a chat broadcast (ask).
  assert.ok(A.writes.length > 0 || aChats.length > 0,
    'A must receive at least one side-effect for the menu fired against it');
});

t('broadcastMenuToChat directly: cross-session listeners are silent', () => {
  // Exercise the inner helper too — it's the lowest-level seam where a
  // future refactor could accidentally start leaking via a shared global
  // emitter.
  const A = makeFakeSession(null);
  const B = makeFakeSession(null);
  const aChats = captureChat(A.session);
  const bChats = captureChat(B.session);
  ptyMod.broadcastMenuToChat(A.session.sessionId, A.session, PLAN_MENU);
  assert.strictEqual(aChats.length, 1);
  assert.strictEqual(bChats.length, 0);
  // The broadcast must NOT include any reference to B's session id.
  assert.ok(!aChats[0].text.includes(B.session.sessionId),
    'broadcast should not mention any other session\'s id');
});

t('chat event payload carries the menu metadata for client-side routing', () => {
  const A = makeFakeSession(null);
  const aChats = captureChat(A.session);
  ptyMod.handleSessionMenu(A.session.sessionId, A.session, PLAN_MENU);
  const msg = aChats[0];
  assert.ok(msg.meta, 'message should carry a meta object');
  assert.strictEqual(msg.meta.kind, 'menu');
  assert.ok(msg.meta.menu, 'meta should embed the menu');
  assert.strictEqual(msg.meta.menu.options.length, 3);
});

// ─── done ──────────────────────────────────────────────────────────────────
// Wait for all async test bodies (some use sleep() to flush deferred
// session.write timers in handleChatMessage) before printing the summary.
Promise.all(_pending).then(() => {
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
