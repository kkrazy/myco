// 2026-10-26 user report: "RLM图标出现，会把单列双列下拉框挤到左侧" —
// when the 🧠 RLM pill (#rlm-mode-badge) appears in
// #chatpane-topctl-row, the 布局 单列/双列 dropdown (#team-mode-select)
// got squeezed to the LEFT edge of the row.
//
// Root cause: .rlm-mode-badge carried `margin-right: auto`, and the badge
// sits BEFORE the dropdowns in DOM order (index.html declares it as the
// row's first child; _ensureTeamModeSelect inserts the team select before
// row.firstChild = the badge... wait, before the badge → the team select
// is actually LEFT of the badge). Either way, an auto margin on the badge's
// RIGHT absorbed all free space between the badge and the row's right
// edge, pushing every child after the badge (and with justify-content:
// flex-end, the whole right-aligned cluster) into the left remainder.
//
// Fix contract (this file locks it):
//   1. CSS: .rlm-mode-badge must NOT carry `margin-right: auto` (the
//      squeeze mechanism). It uses `margin-left: auto` instead — the
//      auto space goes to the badge's LEFT, so the badge renders next to
//      the right-aligned dropdown group and the 布局/RLM selects keep
//      their flush-right positions whether the badge is visible or not.
//   2. The row keeps justify-content: flex-end so the dropdown cluster
//      stays right-aligned.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + e.message); }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── RLM badge vs 布局 dropdown layout (2026-10-26 report) ──');

const css = _read('web/public/styles.css');
const html = _read('web/public/index.html');

t('.rlm-mode-badge does NOT use margin-right:auto (the squeeze mechanism)', () => {
  const at = css.indexOf('.rlm-mode-badge {');
  assert.ok(at >= 0, 'styles.css must declare the .rlm-mode-badge block.');
  const block = css.slice(at, css.indexOf('\n}', at));
  // Strip /* … */ comments so the block's own regression note (which
  // mentions the retired margin-right:auto) doesn't trip the guard —
  // only actual declarations matter.
  const decls = block.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/margin-right:\s*auto/.test(decls),
    'margin-right:auto on the pill absorbs all free space to its right, ' +
    'shoving the 布局 (单列/双列) dropdown to the row\'s far LEFT — ' +
    'observed: ' + block.trim().slice(0, 160));
});

t('.rlm-mode-badge pins with margin-left:auto (dropdowns keep the right edge)', () => {
  const at = css.indexOf('.rlm-mode-badge {');
  const block = css.slice(at, css.indexOf('\n}', at));
  assert.ok(/margin-left:\s*auto/.test(block),
    'the pill must use margin-left:auto so the free space lands on its ' +
    'LEFT — the pill renders next to the right-aligned dropdown cluster ' +
    'and never pushes the 布局/RLM selects left — observed: ' +
    block.trim().slice(0, 160));
});

t('the topctl row stays right-aligned (justify-content: flex-end)', () => {
  const at = css.indexOf('.chatpane-topctl-row {');
  assert.ok(at >= 0, 'base .chatpane-topctl-row block must exist.');
  const block = css.slice(at, css.indexOf('\n}', at));
  assert.ok(/justify-content:\s*flex-end/.test(block),
    'the dropdown cluster must stay flush right — observed: ' +
    block.trim().slice(0, 160));
});

t('index.html badge comment no longer documents a left pin', () => {
  // Guards against stale docs re-introducing the old geometry.
  const at = html.indexOf('id="rlm-mode-badge"');
  assert.ok(at >= 0, 'index.html must declare the #rlm-mode-badge pill.');
  const comment = html.slice(Math.max(0, at - 500), at);
  assert.ok(!/margin-right:\s*auto/.test(comment),
    'the pill\'s doc comment must not claim a margin-right:auto left-pin ' +
    '(the geometry that caused the 2026-10-26 squeeze bug).');
});

// 2026-10-26 second squeeze report: the CSS margin flip alone was NOT
// enough — _ensureTeamModeSelect inserted the 布局 select at
// row.firstChild, LEFT of the pill, so the pill's margin-left:auto
// still isolated 布局 at the far-left edge. The select must land to
// the pill's RIGHT (before #rlm-scope-select, appended fallback).
const appjs = _read('web/public/app.js');

t('app.js: _ensureTeamModeSelect inserts the 布局 select AFTER the pill', () => {
  const at = appjs.indexOf('function _ensureTeamModeSelect()');
  assert.ok(at >= 0, 'app.js must define _ensureTeamModeSelect.');
  const body = appjs.slice(at, appjs.indexOf('\n}', at));
  assert.ok(!/insertBefore\(sel,\s*row\.firstChild\)/.test(body),
    'insertBefore(sel, row.firstChild) puts 布局 LEFT of the 🧠 pill; the ' +
    'pill\'s margin-left:auto then isolates 布局 at the row\'s far-left ' +
    'edge — the exact squeeze the user re-reported after the CSS-only fix.');
  assert.ok(/insertBefore\(sel,\s*rlmSel\)/.test(body),
    'the select must be inserted before #rlm-scope-select (i.e. AFTER the ' +
    'pill) so the visible cluster reads [🧠 pill][◫ 布局][🧠 RLM] flush right.');
});

t('app.js: _updateRlmBadge keeps the pill in-row (no re-parenting escapes)', () => {
  const at = appjs.indexOf('function _updateRlmBadge()');
  assert.ok(at >= 0, 'app.js must define _updateRlmBadge.');
  const body = appjs.slice(at, appjs.indexOf('\n}', at));
  assert.ok(!/remove\(\)/.test(body) && !/appendChild/.test(body),
    '_updateRlmBadge must only toggle visibility, never move the pill — ' +
    're-parenting would drop it out of the topctl row order contract.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
