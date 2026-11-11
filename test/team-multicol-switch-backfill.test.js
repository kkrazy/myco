// team-multicol-switch-backfill — regression for the 2026-10-31 user report:
// 切换 session 以后，多列有些 myco 打印不见了.
//
// Root cause: on a session switch back into a team (agent-n2 / run-n2)
// session, the 多列 worker columns re-populate ONLY from the events the
// 16 KB agent-replay tail happens to carry. The 单列 stream has an
// older-history fetch path (GET /sessions/:id/events, _fetchOlderAgentEvents)
// but the worker columns had none — every worker assistant_text /
// turn_result older than the replay tail silently vanished from the
// columns after the switch, even though events.jsonl / session.buffer
// still hold them server-side.
//
// The fix (web/public/app.js):
//   1. `_backfillTeamColumnsFromServer()` — one-shot per session switch:
//      fetches a window of worker-tagged events older than the oldest
//      seq in the lane colEvents caches (newest window when the caches
//      are empty), merges them into the per-lane per-worker caches, and
//      rebuilds the rows.
//   2. The agent-replay handler kicks it once the replay has seeded
//      the caches (split mode + team view active).
//   3. `_setTeamViewMode('split')` kicks it too, covering the switch
//      INTO 多列 after the session-switch landed in 单列.
//   4. `_resetUiForNewSession` re-arms the one-shot guard.
//
// Style: repo static-shape convention (fnBody slices), cf.
// test/team-stream-reattach.test.js / test/team-ended-cleanup.test.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

const APP = path.join(__dirname, '..', 'web', 'public', 'app.js');
const appJs = fs.readFileSync(APP, 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

t('_backfillTeamColumnsFromServer exists and fetches the events endpoint', () => {
  const body = fnBody(appJs, /function _backfillTeamColumnsFromServer\s*\(/);
  assert.ok(body, 'the backfill fn must exist in app.js');
  assert.ok(body.includes('/sessions/'), 'it must hit a sessions endpoint');
  assert.ok(/encodeURIComponent\(sid\)[^\n]*\/events/.test(body),
    'it must fetch GET /sessions/:id/events (same durable-history source as the 单列 backfill)');
});

t('backfill is one-shot per session switch', () => {
  const body = fnBody(appJs, /function _backfillTeamColumnsFromServer\s*\(/);
  assert.ok(/state\._teamColBackfilled/.test(body),
    'the guard flag must gate repeat fetches within one attach');
  assert.ok(/if \(state\._teamColBackfilled\) return;/.test(body),
    'an in-flight/previous backfill must short-circuit');
});

t('backfill only routes worker-tagged events into lane caches', () => {
  const body = fnBody(appJs, /function _backfillTeamColumnsFromServer\s*\(/);
  assert.ok(/ev\.worker/.test(body),
    'only worker-tagged events feed the columns (main-agent events belong to the 单列 stream)');
  assert.ok(/ev\.compareLane/.test(body),
    '/compare overlay events must be excluded (they own their own surface)');
  assert.ok(/endedLanes/.test(body),
    'retired lanes must not be resurrected by the backfill (team-ended-cleanup contract)');
  assert.ok(/_teamLaneRec\(/.test(body),
    'events land in the lane record cache keyed by ev.laneId');
});

t('backfill rebuilds the columns after merging the cache', () => {
  const body = fnBody(appJs, /function _backfillTeamColumnsFromServer\s*\(/);
  assert.ok(/_rebuildTeamColumnsFromCache\(\)/.test(body),
    'the fetched events must actually reach the DOM via a rebuild');
});

t('agent-replay kicks the backfill in split mode (the session-switch path)', () => {
  const at = appJs.indexOf("msg.t === 'agent-replay' && Array.isArray(msg.events)");
  assert.ok(at >= 0, 'agent-replay handler branch present');
  const win = appJs.slice(at, at + 20000);
  assert.ok(win.includes('_backfillTeamColumnsFromServer()'),
    'the replay handler must fire the column backfill after seeding the caches');
});

t('_setTeamViewMode fires the backfill when switching INTO 多列', () => {
  const body = fnBody(appJs, /function _setTeamViewMode\s*\(/);
  assert.ok(/_backfillTeamColumnsFromServer\(\)/.test(body),
    'switching into split mode after a 单列 session-switch must restore the missing prints');
});

t('_resetUiForNewSession re-arms the one-shot backfill guard', () => {
  const body = fnBody(appJs, /function _resetUiForNewSession\s*\(/);
  assert.ok(/state\._teamColBackfilled = false/.test(body),
    'every session switch must re-arm the backfill so the next team session can restore its prints');
});

t('backfill window is bounded (memory hygiene, mirrors TEAM_VIEW_MSG_CAP)', () => {
  assert.ok(/TEAM_COL_BACKFILL_LIMIT\s*=\s*\d+/.test(appJs),
    'the fetch limit must be a named constant');
  const body = fnBody(appJs, /function _backfillTeamColumnsFromServer\s*\(/);
  assert.ok(/TEAM_VIEW_MSG_CAP/.test(body),
    'the merged caches must still respect the per-worker cap');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
