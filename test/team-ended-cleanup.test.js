// team-ended-cleanup — 已结束的多列任务必须清理 (2026-10-26 user report:
// "界面bug，已经结束的多列对话框，没有清理").
//
// User-visible contract: once a /run-n2 (or /compare n2 leg / queue ◓)
// multi-column run ends, its 多列 面板/row must be removed and must NEVER
// come back — not after the live end transition, and crucially NOT after a
// page refresh / reconnect re-ships the run.
//
// The pre-fix hole this locks was exactly the refresh path:
//   server/src/attach.js re-announces an ended shadow lane as
//   `team-info {ended:true}` on a FULL attach (not team-lane-end — that
//   only ships on catch-up). The client's _handleTeamInfoFrame re-seeded /
//   FROZE that lane as an "■ 已结束" row, and the agent-replay that follows
//   re-routed every worker event through _routeAgentEvent → _teamLaneRec →
//   _rebuildTeamRows, so the ended row stuck around forever — "没有清理".
//
// The fix (all in web/public/app.js):
//   1. `_retireTeamLane(laneId)` is the ONE place that deletes a finished
//      lane's record + row + 单列 board card, AND remembers the laneId in
//      `state.teamView.endedLanes`.
//   2. `_handleTeamLaneEnd` (live end) and `_handleTeamInfoFrame{ended:true}`
//      (attach re-announce) both funnel through it — so a refreshed page
//      cleans the finished run instead of freezing it.
//   3. `_routeAgentEvent` short-circuits events for an `endedLanes` laneId
//      (no record/row re-creation) — the event still falls through to the
//      单列 stream so the run's transcript stays visible there.
//   4. `_rebuildTeamRows` never draws a retired lane (defensive).
//
// Static + eval-based source-shape assertions, matching the repo's UI
// regression convention (cf. team-multilane-ui.test.js / team-stream-board.test.js).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

const APP = path.join(__dirname, '..', 'web', 'public', 'app.js');
const appJs = fs.readFileSync(APP, 'utf8');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

console.log('── team-ended-cleanup: 已结束的多列任务必须清理 ──');

t('teamView init carries endedLanes (both init sites)', () => {
  const hits = appJs.match(/endedLanes:\s*\{\}/g) || [];
  assert.ok(hits.length >= 2,
    'both teamView init sites must reset endedLanes:{} (module level + _resetUiForNewSession)');
});

t('_retireTeamLane deletes + remembers the lane as ended', () => {
  const body = fnBody(appJs, /function _retireTeamLane\s*\(/);
  assert.ok(/function _retireTeamLane\s*\(laneId\)/.test(body),
    'the shared retire helper exists and takes the laneId');
  assert.ok(/endedLanes\[laneId\]\s*=\s*true/.test(body),
    'the laneId is remembered in endedLanes (a late/replayed event cannot resurrect it)');
  assert.ok(/delete lanes\[laneId\]/.test(body),
    'the lane record leaves the registry (no frozen record)');
  assert.ok(/team-row-' \+ _teamLaneKey\(laneId\)[\s\S]*\.remove\(\)/.test(body),
    'the lane row is physically removed');
  assert.ok(/team-stream-board-' \+ _teamLaneKey\(laneId\)[\s\S]*\.remove\(\)/.test(body),
    'the 单列 board card is retired with the lane');
  assert.ok(/_rebuildTeamRows\(\)/.test(body),
    'rows re-reconcile so the 暂无任务 empty state can take over');
});

t('_handleTeamLaneEnd delegates to _retireTeamLane', () => {
  const hook = fnBody(appJs, /function _handleTeamLaneEnd\s*\(/);
  assert.ok(/msg && msg\.laneId/.test(hook),
    'lane-end reads the laneId the server stamps');
  assert.ok(/retireTeamLane\(laneId\)/.test(hook),
    'the live end transition retires the lane through the shared helper');
});

t('ended-lane attach re-announce RETIRES instead of freezing (the reported bug)', () => {
  const body = fnBody(appJs, /function _handleTeamInfoFrame\s*\(/);
  assert.ok(/msg\.ended && state\.teamView\.teamLane/.test(body),
    'the ended:true attach handshake must be recognized (shadow-lane scoped)');
  assert.ok(/_retireTeamLane\(/.test(body) && /\['__default__'\]\)/.test(body) ||
    /_retireTeamLane\(endedLaneId\)/.test(body),
    'an ended lane is retired (record + row deleted), NOT re-seeded/frozen');
  // The ended branch must return before the normal seeding path, which is
  // what used to re-create the frozen row.
  assert.ok(/_retireTeamLane[\s\S]{0,200}return;/.test(body),
    'the ended branch returns after retiring — it must NOT fall through to seed a frozen row');
});

t('_routeAgentEvent never resurrects a retired lane (replay/late events)', () => {
  const body = fnBody(appJs, /function _routeAgentEvent\s*\(/);
  assert.ok(/endedLanes[\s\S]{0,80}evLaneId/.test(body),
    'routing checks the endedLanes set for the event\'s laneId');
  // The guard must come BEFORE _teamLaneRec, so a replay event for an ended
  // lane cannot re-create its record/row; and it must let the event fall
  // through (return false) to the 单列 stream.
  assert.ok(/if \(state\.teamView\.endedLanes && state\.teamView\.endedLanes\[evLaneId\]\) return false;/.test(body),
    'events for a retired lane short-circuit to the single stream only');
  const recAt = body.indexOf('_teamLaneRec(evLaneId');
  const guardAt = body.indexOf('endedLanes[evLaneId]) return false');
  assert.ok(guardAt >= 0 && (recAt < 0 || guardAt < recAt),
    'the ended guard is placed BEFORE _teamLaneRec so no record is re-created');
});

t('_rebuildTeamRows filters retired lanes (defensive net)', () => {
  const body = fnBody(appJs, /function _rebuildTeamRows\s*\(/);
  assert.ok(/endedLanes/.test(body),
    'row reconciliation must skip lanes remembered as ended');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
