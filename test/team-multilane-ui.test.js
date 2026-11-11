// multi-lane run-n2 看板 — CLIENT half regression.
//
// User report (2026-10-22): "同一个 session 起多个 run-n2 是不是看板分开展示，
// 别复用同一个" + "/run-n2 单流也要表明是什么任务".
//
// REDESIGN (2026-10-23): every task (lane) renders as its OWN full-width
// row inside the 多 worker 协同 area — workerA | 共享看板 | workerB per
// row, one row per task, stacked in start order. The 2026-10-22 lane
// PICKER (#team-lane-select / _refreshTeamLaneSelect / _setTeamLane) is
// RETIRED — all lanes are on screen, there is nothing to pick.
//
// This suite locks the web client contract against app.js/styles.css:
//   1. team-info frames record a per-lane record keyed by laneId
//      (own board snapshot, own caches); every lane gets a row.
//   2. Rows stack in START order (oldest first) inside #team-rows.
//   3. Board + tool-progress + team-lane-end frames are lane-scoped
//      (no cross-lane clobber).
//   4. Bridged worker events render into their OWN lane's row.
//   5. The 单列 stream labels each /run-n2 card with its task
//      (_laneTaskBadge 「task」 chip).
//   6. The RLM switch stays the RIGHTMOST control in the topctl row.
//   7. The retired picker + its styles are GONE (no dead surface).
//
// Static + eval-based (no browser), per the repo's test conventions.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

const APP = path.join(__dirname, '..', 'web', 'public', 'app.js');
const CSS = path.join(__dirname, '..', 'web', 'public', 'styles.css');
const appJs = fs.readFileSync(APP, 'utf8');
const css = fs.readFileSync(CSS, 'utf8');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

console.log('── team-multilane-ui: 每任务一行多 lane 客户端契约 ──');

t('state.teamView carries the multi-lane surface (lanes map)', () => {
  assert.ok(/lanes: \{\}/.test(appJs),
    'teamView init must include lanes:{} (per-lane 看板 registry)');
  // Both init sites (module-level state + _resetUiForNewSession rebuild).
  const hits = appJs.match(/lanes: \{\}/g) || [];
  assert.ok(hits.length >= 2, 'both teamView init sites reset the lane registry');
});

t('team-info frames record the lane (own board + roster + caches)', () => {
  const body = fnBody(appJs, /function _handleTeamInfoFrame\s*\(/);
  assert.ok(/_teamLaneRec\(msg\.laneId, msg\.task\)/.test(body),
    'team-info records its lane (laneId + task) via _teamLaneRec');
  assert.ok(/rec\.board = msg\.board \|\| null/.test(body),
    'each lane keeps its OWN board snapshot');
  assert.ok(/rec\.roster = state\.teamView\.roster/.test(body),
    'each lane carries its roster (row columns are roster-driven)');
  assert.ok(/_rebuildTeamRows\(\)|_enterTeamView\(\)/.test(body),
    'a team-info frame (re)builds the rows — every lane is on screen');
  assert.ok(/_renderTeamBoardPane\(rec\.laneId\)/.test(body),
    'the lane\'s board pane repaints after the frame');
});

t('every task is a full-width row: one .team-row per lane, start order', () => {
  const rowsBody = fnBody(appJs, /function _rebuildTeamRows\s*\(/);
  assert.ok(/_teamLanesList\(\)/.test(rowsBody),
    'rows come from the start-ordered lane list (按顺序排列)');
  assert.ok(/rowsEl\.innerHTML = lanes\.map/.test(rowsBody) ||
    /lanes\.map\(\(l\) => _teamRowHtml\(l\)\)/.test(rowsBody),
    'every lane renders its own row (no selected-lane gate)');
  const rowBody = fnBody(appJs, /function _teamRowHtml\s*\(/);
  assert.ok(/team-row/.test(rowBody), 'a lane renders as a .team-row');
  assert.ok(/roster\.map/.test(rowBody),
    'the row\'s worker columns are roster-generated (workerA + workerB)');
  assert.ok(/team-mid-queue-\$\{escHtml\(key\)\}/.test(rowBody) &&
    /team-mid-events-\$\{escHtml\(key\)\}/.test(rowBody),
    'the row\'s 共享看板 ids are lane-scoped (rows coexist)');
  assert.ok(/grid-template-columns/.test(rowBody),
    'the row writes its own fixed grid tracks (full width, sensible widths)');
});

t('board + tool-progress frames are lane-scoped (no cross-lane clobber)', () => {
  const boardAt = appJs.indexOf("msg.kind === 'board'");
  const boardBody = appJs.slice(boardAt, appJs.indexOf("msg.kind === 'runQueue'", boardAt));
  assert.ok(/msg\.laneId/.test(boardBody),
    'the board frame handler scopes to the frame\'s lane');
  assert.ok(/_renderTeamBoardPane\(laneId\)/.test(boardBody),
    "the frame repaints ITS lane's row (every lane is on screen)");
  const tpBody = appJs.slice(appJs.indexOf("msg.kind === 'tool-progress'"), appJs.indexOf("msg.kind === 'tool-progress'") + 1600);
  assert.ok(/msg\.laneId/.test(tpBody) || /const laneId = msg\.laneId \|\| state\.teamView\.laneId/.test(tpBody),
    'tool-progress is lane-scoped too (per-column status stays per-lane)');
});

t('team-lane-end DELETES its lane row (2026-10-23: 面板删除, no freeze)', () => {
  const body = fnBody(appJs, /function _handleTeamLaneEnd\s*\(/);
  assert.ok(/msg && msg\.laneId/.test(body),
    'lane-end reads the laneId the server stamps');
  assert.ok(/delete lanes\[laneId\]/.test(body),
    'the lane record is deleted from the registry (no frozen record)');
  assert.ok(/team-row-' \+ _teamLaneKey\(laneId\)/.test(body),
    'removal targets THAT lane\'s row (other rows keep running)');
  assert.ok(/row\.remove\(\)/.test(body),
    'the finished row is physically removed from the DOM');
  assert.ok(/_rebuildTeamRows\(\)/.test(body),
    'rows re-reconcile so the 暂无任务 empty state can take over');
});

t('worker events render into their OWN lane row', () => {
  const body = fnBody(appJs, /function _routeAgentEvent\s*\(/);
  assert.ok(/ev\.laneId \|\| state\.teamView\.laneId/.test(body) ||
    /evLaneId/.test(body),
    'the event\'s laneId resolves the lane record (laneTask seeds unknown lanes)');
  assert.ok(/_appendTeamColumnEvent\(evLaneId, ev\.worker, ev, \{\}\)/.test(body) ||
    /_appendTeamColumnEvent\(evLaneId/.test(body),
    'the event renders into ITS lane\'s column (no selected-lane gate)');
  const colBody = fnBody(appJs, /function _appendTeamColumnEvent\s*\(/);
  assert.ok(/team-col-' \+ _teamLaneKey\(laneId\) \+ '-' \+ w/.test(colBody) ||
    /_teamLaneKey\(laneId\)/.test(colBody),
    'column bodies are lane-scoped (rows coexist without collisions)');
});

t('单列 stream labels each run-n2 card with its task (「task」 chip)', () => {
  const laneBody = fnBody(appJs, /function _laneTaskBadge\s*\(/);
  assert.ok(/ev\.laneTask/.test(laneBody), 'the chip reads the server-stamped laneTask');
  assert.ok(/lane-task-badge/.test(laneBody), 'the chip has the .lane-task-badge class');
  const workerBody = fnBody(appJs, /function _workerBadge\s*\(/);
  assert.ok(/_laneTaskBadge\(ev\)/.test(workerBody),
    '_workerBadge composes the lane-task chip (stream cards name their run)');
  assert.ok(/\.lane-task-badge\s*\{/.test(css), 'the chip is styled');
});

t('lane picker RETIRED: dropdown, swap fn, styles are gone', () => {
  assert.ok(!/_refreshTeamLaneSelect/.test(appJs),
    'the picker refresh fn is gone (no dead surface)');
  assert.ok(!/_setTeamLane/.test(appJs),
    'the lane swap fn is gone (all lanes are on screen — nothing to pick)');
  assert.ok(!/team-lane-select/.test(appJs),
    'the #team-lane-select dropdown markup is gone');
  assert.ok(!/\.team-lane-select\s*\{/.test(css),
    'the picker styles are gone from styles.css');
});

t('RLM switch stays the RIGHTMOST control in the topctl row', () => {
  const adopt = fnBody(appJs, /function _adoptRlmSwitchIntoTopRow\s*\(/);
  assert.ok(/appendChild\(el\)/.test(adopt),
    'the RLM select is appended LAST (rightmost) at boot');
  const modeBody = fnBody(appJs, /function _ensureTeamModeSelect\s*\(/);
  // 2026-10-26: insertBefore(sel, row.firstChild) put 布局 LEFT of the
  // margin-left:auto 🧠 pill, isolating it at the far-left edge (user
  // squeeze report). The select now goes AFTER the pill / before the
  // RLM select — RLM still rightmost, 布局 no longer past the pill.
  assert.ok(/insertBefore\(sel, rlmSel\)/.test(modeBody),
    'the 布局 dropdown inserts BEFORE the RLM select (after the pill), keeping RLM flush right without stranding 布局 left of the auto-margin pill');
  assert.ok(!/insertBefore\(sel, row\.firstChild\)/.test(modeBody),
    'inserting at row.firstChild strands the 布局 dropdown left of the pill (squeeze bug)');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
