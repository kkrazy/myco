// resizable-columns — client-side contract for the /compare overlay
// column drag-resize (2026-10-22): "每个框最好都能鼠标进行拉大或者
// 拉小，横向宽度" applied to the /compare overlay columns, plus the
// localStorage persistence of the width.
//
// 2026-10-23 update (行排列 redesign): the TEAM-SPLIT side of this
// contract was RETIRED — the multi-worker 协同 view now renders one
// full-width row per task ([workerA | 共享看板 | workerB]) with FIXED
// track widths and NO drag handles (用户需求: 不支持缩放). The /compare
// overlay columns keep their drag-resize. The team side is now guarded
// by test/team-multicol-resize.test.js (locks the no-resize contract).
//
// Static source-shape assertions (same style as the other web-contract
// tests — no browser needed, sub-second):
//   1. /compare overlay: the 单 agent column ships .cmp-col-resize;
//      _wireCmpColResize binds the drag; width persists under
//      myco_cmp_col_w_single and restores via _applyCmpColWidth.
//   2. Grid tracks use minmax() so an explicit column width can
//      actually shrink/expand within the container.
//   3. The team view stays resize-FREE (regression guard: the retired
//      team drag machinery must not quietly come back).
//
// Style: the repo's node test/*.test.js pattern — assert-based, no
// framework, runnable standalone via `node test/resizable-columns.test.js`.

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

function main() {
  console.log('── resizable-columns: /compare drag-resize; team rows resize-FREE ──');

  t('team view is resize-FREE (2026-10-23 行排列: 不支持缩放)', () => {
    assert.ok(!/function _wireTeamColResize\s*\(/.test(appJs),
      'the team drag handler must stay retired (rows have fixed widths)');
    assert.ok(!/myco_team_col_w_/.test(appJs) && !/myco_team_mid_w/.test(appJs),
      'no team width persistence keys may remain');
    assert.ok(!/\.team-col-resize\s*\{/.test(css),
      'no team resize-handle styles may remain');
  });

  t('/compare overlay: the 单 agent column ships a resize handle', () => {
    assert.ok(appJs.includes('cmp-col-resize'),
      'cmp markup must include the handle (drag-resize is requested for the compare view too)');
    assert.ok(/_wireCmpColResize\(root\.querySelector\('\.cmp-col-resize'\)\)/.test(appJs),
      'the overlay wires its handle at build time');
  });

  t('/compare drag persists + restores its width', () => {
    assert.ok(/function _wireCmpColResize\s*\(/.test(appJs), 'wire function exists');
    assert.ok(/setPointerCapture\(ev\.pointerId\)/.test(appJs),
      'pointer capture keeps the drag alive even when the cursor leaves the handle');
    assert.ok(/localStorage\.setItem\(_cmpColWidthKey\(\)/.test(appJs),
      'dragged cmp width must persist');
    assert.ok(/function _applyCmpColWidth\s*\(/.test(appJs),
      'restore function exists');
    assert.ok(/_applyCmpColWidth\(\)/.test(appJs),
      'the restore runs when the overlay is (re)built');
  });

  t('grid tracks allow width overrides (minmax, not fixed 1fr)', () => {
    const teamTracks = /grid-template-columns:\s*minmax\(220px,\s*1fr\)/.test(css) ||
      /minmax\(\$\{TEAM_COL_MIN_W\}px,\s*1fr\)/.test(appJs);
    assert.ok(teamTracks,
      'the team row grid must use minmax tracks (fixed floors, flexible 1fr — 行内占满宽度)');
    assert.ok(/\.cmp-columns\s*\{[\s\S]*?grid-template-columns:\s*minmax\(180px,\s*1fr\)\s*minmax\(180px,\s*1fr\)/.test(css),
      'the cmp grid must use minmax tracks on BOTH columns');
  });

  t('resize handles are hit-targets (cursor + hover affordance)', () => {
    assert.ok(/\.cmp-col-resize\s*\{[\s\S]*?cursor:\s*ew-resize/.test(css),
      'the cmp handle must show the ew-resize cursor');
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
