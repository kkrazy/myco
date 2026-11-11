//
// User report (2026-10-31): 「有时候 run-n2 任务没结束 单双列按钮就没了」
// — while a /run-n2 task was still running, the 布局 (单列/双列) dropdown
// (#team-mode-select) sometimes vanished, leaving the user with no way to
// switch layouts mid-run.
//
// Root cause: the select's visibility was only re-evaluated by the paths
// that already ran _ensureTeamModeSelect (team-info, mode apply, teardown).
// The lane-retire paths (_handleTeamLaneEnd → _retireTeamLane, and the
// ended:true attach re-announce) removed lane rows/cards but never
// re-synced the dropdown — after a retire fired (worker-level terminal,
// page refresh on an ended lane) the select kept a stale hidden flag or
// was never re-checked, so the control disappeared while the team view
// was still active and the run's transcript still streaming.
//
// The fix (all in web/public/app.js):
//   1. New helper `_syncTeamModeSelect()` — the one idempotent
//      "make the control reflect the CURRENT teamView state" call
//      (creates on demand, fixes value, refreshes the topctl row).
//   2. Both retire paths (_handleTeamLaneEnd + _retireTeamLane) call it,
//      so the dropdown survives every lane lifecycle transition.
//
// Static source-shape assertions, matching the repo's UI regression
// convention (cf. team-ended-cleanup.test.js / team-mode-ux-readouts.test.js).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

const APP = path.join(__dirname, '..', 'web', 'public', 'app.js');
const HTML = path.join(__dirname, '..', 'web', 'public', 'index.html');
const src = fs.readFileSync(APP, 'utf8');
const html = fs.readFileSync(HTML, 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

t('_syncTeamModeSelect exists and is the idempotent visibility sync', () => {
  const body = fnBody(src, /function _syncTeamModeSelect\s*\(/);
  assert.ok(/_ensureTeamModeSelect\(\)/.test(body),
    'the sync helper must delegate creation/visibility to _ensureTeamModeSelect');
  assert.ok(/sel\.value\s*=\s*state\.teamView\.mode/.test(body),
    'the sync helper must mirror the current mode into the select value');
  assert.ok(/_refreshTopctlRow\(\)/.test(body),
    'the sync helper must refresh the topctl row so it never strands a hidden strip');
});

t('_retireTeamLane re-syncs the dropdown (ended:true attach re-announce path)', () => {
  const body = fnBody(src, /function _retireTeamLane\s*\(/);
  assert.ok(/_syncTeamModeSelect\(\)/.test(body),
    '_retireTeamLane must re-sync the 布局 dropdown — the ended:true re-announce funnels here and the control must stay reachable');
});

t('_handleTeamLaneEnd re-syncs the dropdown (live lane-end path)', () => {
  const body = fnBody(src, /function _handleTeamLaneEnd\s*\(/);
  assert.ok(/_syncTeamModeSelect\(\)/.test(body),
    '_handleTeamLaneEnd must re-sync the 布局 dropdown so a mid-run retire never removes the layout control');
});

t('the select keeps its visibility keyed to teamView.active (single source of truth)', () => {
  const body = fnBody(src, /function _ensureTeamModeSelect\s*\(/);
  assert.ok(/sel\.hidden = !state\.teamView\.active/.test(body),
    'visibility stays keyed to teamView.active — every retire/teardown path flips active through the same sync');
});

t('index.html app.js cache buster bumped (stale-cache guard)', () => {
  const m = html.match(/app\.js\?v=(\d+)/);
  assert.ok(m, 'app.js must carry a ?v= cache buster');
  assert.ok(Number(m[1]) >= 266, 'app.js buster bumped to ≥266 (this fix), got ' + m[1]);
});

console.log('  ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
