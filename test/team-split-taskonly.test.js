// team-split-taskonly — client-side contract for the dual-column view's
// task-only printing + the 多列/单列 view-mode dropdown.
//
// Locked behaviours (UX change 2026-10-22):
//  1. _appendTeamColumnEvent filters via _isTeamColumnVisible BEFORE
//     any DOM append — tool_use / tool_result / permission chrome
//     produce NO row/card in a worker column (tasks only).
//  2. assistant_text, fatal and turn_result still render.
//  3. The layout toggle is a dropdown (#team-mode-select) inside
//     #chatpane-topctl-row — same line as the RLM switch, sibling
//     palette — visible in BOTH modes so stream mode always keeps a
//     way back to the columns. (Supersedes the old segmented
//     #team-mode-switch + stream-only floating pill.)
//
// Style: the repo's node test/*.test.js pattern — assert-based, no
// framework, runnable standalone via `node test/team-split-taskonly.test.js`.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'web', 'public');
const appJs = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

// Minimal DOM stand-in: records appendChild calls so we can assert
// which events produced visible nodes.
class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this._class = new Set();
    this.innerHTML = '';
    this.textContent = '';
    this.lastElementChild = null;
  }
  get className() { return [...this._class].join(' '); }
  set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); }
  classList = {
    add: (c) => this._class.add(c),
    remove: (c) => this._class.delete(c),
    toggle: (c, on) => { on ? this._class.add(c) : this._class.delete(c); },
    contains: (c) => this._class.has(c),
  };
  appendChild(child) { this.children.push(child); this.lastElementChild = child; return child; }
  querySelector() { return null; }
  setAttribute() {}
  addEventListener() {}
  get scrollHeight() { return 0; }
  get scrollTop() { return 0; }
  get clientHeight() { return 0; }
}

// Extract the pure functions from app.js and eval them in a sandbox
// with just enough stubs (TEAM_COL_ROW_TYPES + the DOM/document
// globals the column renderer touches).
function evalFn(src, name, extraScope) {
  const m = src.match(new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{'));
  assert.ok(m, `function ${name} found in app.js`);
  let i = m.index + m[0].length, depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  const rowTypesMatch = src.match(/const TEAM_COL_ROW_TYPES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(rowTypesMatch, 'TEAM_COL_ROW_TYPES found in app.js');
  const scope = 'const TEAM_COL_ROW_TYPES = new Set([' + rowTypesMatch[1] + ']);\n' +
    'return ' + src.slice(m.index, i);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...Object.keys(extraScope || {}), scope);
  return factory(...Object.values(extraScope || {}));
}

function main() {
  console.log('── team-split-taskonly: task-only columns + mode dropdown ──');

  const isVisible = evalFn(appJs, '_isTeamColumnVisible', {});

  t('tool_use is NOT visible in a worker column (task-only)', () => {
    assert.strictEqual(isVisible({ type: 'tool_use', name: 'Bash' }), false,
      'tool calls must not print in dual-column worker frames');
  });
  t('tool_result is NOT visible in a worker column', () => {
    assert.strictEqual(isVisible({ type: 'tool_result' }), false,
      'tool output must not print in dual-column worker frames');
  });
  t('permission_request chrome is NOT visible', () => {
    assert.strictEqual(isVisible({ type: 'permission_request' }), false,
      'SDK chrome must not print in dual-column worker frames');
  });
  t('assistant_text IS visible (the task narration)', () => {
    assert.strictEqual(isVisible({ type: 'assistant_text', text: 'x' }), true,
      'task text must keep printing in dual-column worker frames');
  });
  t('fatal IS visible (aborted worker must be seen)', () => {
    assert.strictEqual(isVisible({ type: 'fatal', error: 'x' }), true,
      'a fatal worker error must stay visible');
  });
  t('turn_result IS visible (worker final answer)', () => {
    assert.strictEqual(isVisible({ type: 'turn_result' }), true,
      'the turn result must stay visible');
  });
  t('null/undefined events are not visible', () => {
    assert.strictEqual(isVisible(null), false);
    assert.strictEqual(isVisible(undefined), false);
  });

  // _appendTeamColumnEvent honours the filter: a tool_use produces no
  // child in the column body, an assistant_text does.
  t('_appendTeamColumnEvent drops tool_use (no DOM node) but renders assistant_text', () => {
    const body = new FakeEl('div');
    // per-lane rows (2026-10-23): column ids are lane-scoped —
    // team-col-<laneKey>-<worker>. The '__default__' pseudo-lane is what
    // lane-less frames collapse onto.
    const fakeDoc = {
      getElementById: (id) => (id === 'team-col-__default__-worker-A' ? body : null),
      createElement: (tag) => new FakeEl(tag),
    };
    const no = () => {};
    const stubs = {
      document: fakeDoc,
      _teamLaneKey: (laneId) => laneId || '__default__',
      _isChromeEvent: () => false,
      _chromeEventAlwaysFolds: () => false,
      _appendToChromeBatch: no,
      _createChromeBatch: no,
      _finishChromeBatch: no,
      _attachTurnOutcomeChip: no,
      _localTs: () => '00:00',
      _workerBadge: () => '',
      _agentToolIcon: () => '',
      escHtml: (s) => String(s),
      renderMd: (s) => String(s),
      renderMermaidInContainer: () => Promise.resolve(),
      CSS: { escape: (s) => s },
      Date,
    };
    const append = evalFn(appJs, '_appendTeamColumnEvent',
      Object.assign({ _isTeamColumnVisible: isVisible }, stubs));
    append('__default__', 'worker-A', { type: 'tool_use', name: 'Bash', summary: 'ls', seq: 1, ts: null }, { fromCache: true });
    assert.strictEqual(body.children.length, 0,
      'tool_use must not append anything to the worker column');
    append('__default__', 'worker-A', { type: 'assistant_text', text: 'hello task', seq: 2, ts: null }, { fromCache: true });
    assert.strictEqual(body.children.length, 1,
      'assistant_text must append one card to the worker column');
    assert.ok(/agent-card-assistant_text/.test(body.children[0].className),
      'the appended node is an assistant_text card');
  });

  // View-mode dropdown wiring (多列/单列) — replaces the old segmented
  // switch + stream-only floating pill.
  t('mode switch is a dropdown inside the top-right control row', () => {
    assert.ok(appJs.includes("'team-mode-select'") || appJs.includes('id="team-mode-select"'),
      'team-mode-select dropdown present (id assigned in JS: sel.id = \'team-mode-select\')');
    assert.ok(/function _ensureTeamModeSelect\s*\(/.test(appJs),
      '_ensureTeamModeSelect creates the dropdown');
    assert.ok(appJs.includes('_topctlRow()') && appJs.includes('row.insertBefore(sel, rlmSel)'),
      'dropdown lives inside #chatpane-topctl-row (same line as the RLM switch; inserted before it so RLM stays rightmost — and after the 🧠 pill, so the pill\'s margin-left:auto doesn\'t strand the dropdown at the far-left edge)');
    assert.ok(appJs.includes('value="split"') && appJs.includes('value="stream"'),
      'both layout options present (listener wiring)');
  });
  t('_applyTeamViewMode drives the dropdown value', () => {
    assert.ok(/sel\.value = split \? 'split' : 'stream'/.test(appJs),
      'dropdown value tracks the current mode');
  });
  t('dropdown is visible in BOTH modes (stream mode keeps a way back)', () => {
    assert.ok(/sel\.hidden = !state\.teamView\.active/.test(appJs),
      'visibility keyed on team-view active, not the mode (old pill was stream-only)');
  });
  t('CSS styles the dropdown in the same palette family as the split view', () => {
    assert.ok(css.includes('.team-mode-select'), 'dropdown styled');
    assert.ok(/\.team-mode-select\[hidden\]\s*\{/.test(css),
      '[hidden] must actually hide the dropdown');
    assert.ok(!css.includes('.team-mode-switch'), 'old segmented switch styles removed');
    assert.ok(!css.includes('.team-ms-btn'), 'old segmented half-button styles removed');
  });
  t('old two-button team-tg styles are fully replaced', () => {
    assert.ok(!css.includes('.team-tg '), 'no leftover .team-tg base rule');
    assert.ok(!appJs.includes('team-tg-on'), 'no leftover team-tg-on class in JS');
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
