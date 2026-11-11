// team-multicol-resize — client-side contract for the 多 worker 协同
// 行排列 layout (2026-10-23 用户需求).
//
// Locked behaviours (UX change 2026-10-23):
//  1. EVERY lane (/run-n2 run) renders as its own FULL-WIDTH row inside
//     #team-rows, stacked in start order: row = [worker-A col | 共享看板
//     | worker-B col] with FIXED grid tracks — 每行占满协同区域宽度.
//  2. Rows are NOT resizable: the 2026-10-22 drag machinery
//     (.team-col-resize handles, _wireTeamColResize, _teamResizeNeighbors,
//     _applyTeamColWidths, TEAM_COL_MAX_W_FRAC/TEAM_MID_MAX_W_FRAC caps,
//     myco_team_col_w_*/myco_team_mid_w localStorage keys) is REMOVED.
//  3. Row DOM ids are lane-scoped (team-col-<lane>-<worker>,
//     team-status-<lane>-<worker>, team-mid-queue-<lane>,
//     team-mid-events-<lane>) so multiple rows coexist.
//  4. The lane picker (#team-lane-select / _refreshTeamLaneSelect /
//     _setTeamLane) is RETIRED — all lanes are on screen, nothing to pick.
//  5. >2 workers per lane still get a neutral chip class (agent-worker-x).
//
// Style: the repo's node test/*.test.js pattern — assert-based, no
// framework, runnable standalone via `node test/team-multicol-resize.test.js`.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

const PUB = path.join(__dirname, '..', 'web', 'public');
const appJs = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

console.log('── team-multicol-resize: per-lane rows, fixed widths, no resize ──');

t('_teamRoster reads state.teamView.roster with the A/B fallback', () => {
  assert.ok(/function _teamRoster\s*\(/.test(appJs),
    '_teamRoster helper must exist (roster-driven columns)');
  assert.ok(/state\.teamView\.roster/.test(appJs.slice(appJs.indexOf('function _teamRoster'), appJs.indexOf('function _teamRoster') + 400)),
    '_teamRoster must read state.teamView.roster (team-info frame payload)');
});

t('split DOM builds a #team-rows stack, not a single #team-columns triplet', () => {
  const body = fnBody(appJs, /function _ensureTeamSplitDom\s*\(/);
  assert.ok(/team-rows/.test(body),
    'the split DOM must carry a #team-rows row stack (one row per lane)');
  assert.ok(!/team-columns" id="team-columns"/.test(body),
    'no monolithic #team-columns container — rows are per-lane');
});

t('one full-width row per lane: _teamRowHtml renders workerA|看板|workerB', () => {
  const body = fnBody(appJs, /function _teamRowHtml\s*\(/);
  assert.ok(/team-row/.test(body), 'a lane renders as a .team-row');
  assert.ok(/roster\.map/.test(body),
    'worker columns are roster.map-generated inside the row');
  assert.ok(/team-columns/.test(body),
    'each row carries its own .team-columns three-cell grid');
  assert.ok(/minmax\(\$\{TEAM_COL_MIN_W\}px, 1fr\)/.test(body),
    'worker tracks are fixed minmax(TEAM_COL_MIN_W,1fr) — 合理固定宽度');
  assert.ok(/minmax\(\$\{TEAM_MID_MIN_W\}px, 320px\)/.test(body),
    'the 共享看板 track is a fixed minmax(TEAM_MID_MIN_W,320px)');
  assert.ok(/team-row-head/.test(body) && /team-row-task/.test(body),
    'each row head shows the task name (任务标注)');
  assert.ok(/team-row-badge/.test(body),
    'each row head shows the ● 运行中 / ■ 已结束 badge');
});

t('lane-scoped DOM ids: every row element names its lane', () => {
  const body = fnBody(appJs, /function _teamRowHtml\s*\(/);
  assert.ok(/team-status-/.test(body) && /team-col-/.test(body),
    'column status + body ids appear in the row template');
  assert.ok(/'team-col-' \+ _teamLaneKey/.test(appJs),
    'column body ids resolve via _teamLaneKey (team-col-<lane>-<worker>)');
  assert.ok(/team-mid-queue-/.test(body) && /team-mid-events-/.test(body),
    'board queue + feed ids are lane-scoped');
});

t('NO resize machinery: drag wiring, width persistence, caps are gone', () => {
  assert.ok(!/_wireTeamColResize/.test(appJs),
    'the drag handler _wireTeamColResize must be gone (不支持缩放)');
  assert.ok(!/_teamResizeNeighbors/.test(appJs),
    'the neighbor-compensation helper must be gone');
  assert.ok(!/_applyTeamColWidths/.test(appJs),
    'the width-restore helper must be gone');
  assert.ok(!/_applyTeamGridTracks/.test(appJs),
    'the monolithic grid-track helper must be gone (tracks live per row)');
  assert.ok(!/TEAM_COL_MAX_W_FRAC/.test(appJs) && !/TEAM_MID_MAX_W_FRAC/.test(appJs),
    'the % cap constants must be gone (no drag caps to enforce)');
  assert.ok(!/myco_team_col_w_/.test(appJs) && !/myco_team_mid_w/.test(appJs),
    'the width localStorage keys must be gone (no widths to persist)');
  assert.ok(!/team-col-resize/.test(appJs.replace(/\/\/[^\n]*team-col-resize[^\n]*/g, '')),
    'no resize handle markup may remain in app.js');
});

t('NO lane picker: _refreshTeamLaneSelect/_setTeamLane/#team-lane-select retired', () => {
  assert.ok(!/_refreshTeamLaneSelect/.test(appJs),
    '_refreshTeamLaneSelect must be gone (every lane is on screen)');
  assert.ok(!/_setTeamLane/.test(appJs),
    '_setTeamLane must be gone (no lane swapping)');
  assert.ok(!/team-lane-select/.test(appJs.replace(/\/\/[^\n]*team-lane-select[^\n]*/g, '')),
    'no #team-lane-select element may remain');
});

t('_rebuildTeamRows renders EVERY lane in start order', () => {
  const body = fnBody(appJs, /function _rebuildTeamRows\s*\(/);
  assert.ok(/_teamLanesList\(\)/.test(body),
    'rows come from the start-ordered lane registry');
  assert.ok(/for \(const l of lanes\)/.test(body),
    'EVERY lane gets a row + board + statuses (按行排列全部任务)');
  assert.ok(/team-row-' \+ _teamLaneKey\(l\.laneId\)/.test(body),
    'rows are addressable per lane for badge sync');
});

t('_renderTeamColumnStatus/_renderTeamBoardPane/_appendTeamBoardEvent are lane-scoped', () => {
  assert.ok(/function _renderTeamColumnStatus\(laneId, w\)/.test(appJs),
    'status renders take a laneId (lane-scoped element ids)');
  assert.ok(/function _renderTeamBoardPane\(laneId\)/.test(appJs),
    'board pane renders take a laneId');
  assert.ok(/function _appendTeamBoardEvent\(laneId, ev\)/.test(appJs),
    'board event feed appends take a laneId');
  assert.ok(/function _appendTeamColumnEvent\(laneId, w, ev, \{ fromCache \}\)/.test(appJs),
    'column event appends take a laneId');
});

t('_routeAgentEvent renders into the event\'s OWN lane row (no selected-lane gate)', () => {
  const body = fnBody(appJs, /function _routeAgentEvent\s*\(/);
  assert.ok(/_teamLaneKey\(evLaneId\)/.test(body),
    'the routing must resolve the event lane\'s lane-scoped column id');
  assert.ok(!/state\.teamView\.laneId !== evLaneId\) return true/.test(body),
    'no background-lane swallow — every lane row is live');
  assert.ok(/_appendTeamColumnEvent\(evLaneId, ev\.worker, ev, \{\}\)/.test(body),
    'the append call must pass the laneId');
});

t('board + tool-progress frames repaint their OWN lane row', () => {
  const boardAt = appJs.indexOf("msg.kind === 'board'");
  const boardBody = appJs.slice(boardAt, boardAt + 2400);
  assert.ok(/_renderTeamBoardPane\(laneId\)/.test(boardBody),
    'board frames repaint the frame\'s lane pane');
  assert.ok(!/_renderTeamColumnStatus\('worker-A'\)/.test(boardBody),
    'no hardcoded worker-A status repaint (roster-driven)');
  const tpAt = appJs.indexOf("msg.kind === 'tool-progress'");
  const tpBody = appJs.slice(tpAt, tpAt + 1200);
  assert.ok(/_renderTeamColumnStatus\(laneId, msg\.worker\)/.test(tpBody),
    'tool-progress repaints the frame lane\'s column status');
});

t('CSS: row stack + fixed tracks, resize handle styles removed', () => {
  assert.ok(/\.team-rows\s*\{/.test(css),
    '.team-rows row stack must be styled (vertical, scrollable)');
  assert.ok(/\.team-row\s*\{/.test(css),
    '.team-row row container must be styled');
  assert.ok(/\.team-row-head\s*\{/.test(css) && /\.team-row-task\s*\{/.test(css),
    'row head (badge + task label) must be styled');
  assert.ok(/minmax\(220px, ?1fr\) minmax\(260px, ?320px\) minmax\(220px, ?1fr\)/.test(css),
    '.team-columns default tracks = workerA|看板|workerB fixed widths (占满行宽)');
  assert.ok(!/\.team-col-resize\s*\{/.test(css),
    '.team-col-resize handle styles must be GONE (不支持缩放)');
  assert.ok(!/\.team-lane-select\s*\{/.test(css),
    '.team-lane-select picker styles must be GONE');
});

t('CSS: neutral chip + queue/event palettes for 3rd+ workers kept', () => {
  assert.ok(/\.agent-worker-x\s*\{/.test(css),
    'neutral worker chip class must stay styled (same cold-blue family)');
  assert.ok(/\.team-q-x\s*\{/.test(css),
    'neutral queue-row class must stay styled');
  assert.ok(/\.team-ev-x\s*\{/.test(css),
    'neutral board-event class must stay styled');
});

t('roster drives cache resets + lane-end removes ITS lane (no hardcoded A/B loops)', () => {
  const infoBody = fnBody(appJs, /function _handleTeamInfoFrame\s*\(/);
  assert.ok(/\(rec\.roster \|\| _teamRoster\(\)\)\.map/.test(infoBody),
    'resetCache must key colEvents/openTools off the lane roster (multi-worker safe)');
  // 2026-10-23 用户需求: 多列任务结束后面板删除 — lane-end no longer
  // freezes the row (ended badge + roster status re-render); it DELETES
  // the lane record + row (see team-multilane-ui.test.js for the full
  // deletion contract). This guard keeps the lane-SCOPED half: removal
  // must still target ITS OWN row via the laneId key, not the view.
  const endBody = fnBody(appJs, /function _handleTeamLaneEnd\s*\(/);
  assert.ok(/team-row-' \+ _teamLaneKey\(laneId\)/.test(endBody),
    'lane-end removes ITS OWN row (2026-10-23 deletion semantics), not the whole view');
});

t('no parallel bar remains (removed with the split-DOM redesign)', () => {
  assert.ok(!/team-parallel-bar|_renderTeamParallelBar|team-pb-/.test(appJs),
    'no parallel-bar JS may remain (the bar was removed from the split DOM)');
  assert.ok(!/team-parallel-bar|team-pb-/.test(css),
    'no parallel-bar CSS may remain');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
