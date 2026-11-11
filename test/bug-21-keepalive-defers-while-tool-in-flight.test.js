// bug-21 (pattern 2) regression: the 5-min keepalive reaper must NOT
// kill an AgentSession that has in-flight tool work. Otherwise a
// long-running research subagent — exactly the trigger the user
// flagged as "happens often during long research tasks" — gets reaped
// during its quiet model-thinking phase, orphaning the Agent tool_use
// and leaving the parent SDK iteration waiting on a tool_result that
// will never arrive.
//
// Evidence from this session's events.jsonl (pattern 2 in the
// reopened bug-21 analysis comment, commit pending):
//
//   13:19:34  Agent dispatched ("Re-refresh architecture.md...")
//   13:19:34 → 13:26:37  ~100 sub-tool-calls, all complete
//   13:26:37 → 13:32:20  subagent silent for ~5 min (model thinking)
//   13:32:20  session_ready RESPAWN — 5-min reaper killed the
//             AgentSession mid-flight; the Agent tool_use was orphaned.
//
// Root cause: attach.js _scheduleSessionKill fires unconditionally
// when its 5-min timer elapses with no clients attached. It does NOT
// consult the AgentSession's openToolCalls Map (already tracked on
// agent-session.js for the chat-pane "waiting on Tool · 47s"
// indicator), so an in-flight subagent / long Bash / long WebFetch is
// destroyed alongside genuinely-idle sessions.
//
// Fix:
//   - On timer fire, before calling killSession(), inspect the live
//     AgentSession's openToolCalls.size.
//   - If > 0: log [keepalive] sid deferring reap — N tool(s) in flight,
//     re-schedule the kill timer for another grace slice. Track total
//     defer time on a per-session marker.
//   - Hard cap via SESSION_MAX_DEFER_MS (default 30 min): if total
//     defer time exceeds the cap, reap anyway with reason
//     'max-defer-exceeded' so a genuinely-hung tool can't indefinitely
//     pin a session in memory.
//
// Static-grep guards at the bottom anchor the fix shape onto prod
// source so a future refactor can't silently regress.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ──────────────────────────────────────────────────────────────────────────
// Inlined FIXED reaper logic. Mirrors the post-fix _scheduleSessionKill
// behavior in attach.js. Real attach.js uses module-level _sessionKillTimers
// Map + setTimeout; the test substitutes a synchronous deterministic
// "fire" function so we don't have to await timeouts in unit tests.

const KEEPALIVE_GRACE_MS = 5 * 60 * 1000;    // 5 min slice
const SESSION_MAX_DEFER_MS = 30 * 60 * 1000; // 30 min hard cap

// FAKE FIXED scheduler. Tracks:
//   - timers: sessionId → { firstScheduledAt, fires: number }
//   - deferState: sessionId → { totalDeferMs }
// fire(sessionId) simulates the timer elapsing.
function makeReaper(killFn, getOpenToolCount) {
  const timers = new Map();
  const deferState = new Map();
  const log = [];

  function schedule(sessionId, reason) {
    if (!timers.has(sessionId)) {
      timers.set(sessionId, { firstScheduledAt: Date.now(), fires: 0 });
    }
    log.push({ kind: 'schedule', sessionId, reason });
  }
  function cancel(sessionId) {
    timers.delete(sessionId);
    deferState.delete(sessionId);
    log.push({ kind: 'cancel', sessionId });
  }
  // Test helper: simulate the setTimeout firing for this session.
  function fire(sessionId) {
    const meta = timers.get(sessionId);
    if (!meta) return { action: 'noop', reason: 'not-scheduled' };
    meta.fires++;
    const open = getOpenToolCount(sessionId);
    if (open > 0) {
      const ds = deferState.get(sessionId) || { totalDeferMs: 0 };
      ds.totalDeferMs += KEEPALIVE_GRACE_MS;
      deferState.set(sessionId, ds);
      if (ds.totalDeferMs >= SESSION_MAX_DEFER_MS) {
        timers.delete(sessionId);
        log.push({ kind: 'kill', sessionId, reason: 'max-defer-exceeded', openWhenKilled: open, totalDeferMs: ds.totalDeferMs });
        killFn(sessionId, 'max-defer-exceeded');
        return { action: 'killed', reason: 'max-defer-exceeded', open };
      }
      log.push({ kind: 'defer', sessionId, open, totalDeferMs: ds.totalDeferMs });
      // Re-schedule another slice — timer stays in timers map.
      return { action: 'deferred', open, totalDeferMs: ds.totalDeferMs };
    }
    // Genuinely idle → reap.
    timers.delete(sessionId);
    deferState.delete(sessionId);
    log.push({ kind: 'kill', sessionId, reason: 'idle' });
    killFn(sessionId, 'idle');
    return { action: 'killed', reason: 'idle' };
  }
  return { schedule, cancel, fire, log, _timers: timers, _deferState: deferState };
}

// ──────────────────────────────────────────────────────────────────────────

console.log('── bug-21 (pattern 2): keepalive reaper defers while tool in flight ──');

t('reaper kills when no tools in flight (baseline)', () => {
  const killed = [];
  const r = makeReaper((sid, reason) => killed.push({ sid, reason }), () => 0);
  r.schedule('sid-1', 'no-clients');
  const res = r.fire('sid-1');
  assert.strictEqual(res.action, 'killed');
  assert.strictEqual(res.reason, 'idle');
  assert.deepStrictEqual(killed, [{ sid: 'sid-1', reason: 'idle' }]);
});

t('reaper defers when 1+ tool in flight', () => {
  const killed = [];
  let openCount = 1;
  const r = makeReaper((sid, reason) => killed.push({ sid, reason }), () => openCount);
  r.schedule('sid-1', 'no-clients');
  const res = r.fire('sid-1');
  assert.strictEqual(res.action, 'deferred');
  assert.strictEqual(res.open, 1);
  assert.strictEqual(killed.length, 0, 'must NOT kill while a tool is in flight');
});

t('reaper defers repeatedly while tools stay open', () => {
  const killed = [];
  let openCount = 2;
  const r = makeReaper((sid, reason) => killed.push({ sid, reason }), () => openCount);
  r.schedule('sid-1', 'no-clients');
  // Fire timer 3 times (=15 min); tool stays open the whole time.
  for (let i = 0; i < 3; i++) {
    const res = r.fire('sid-1');
    assert.strictEqual(res.action, 'deferred', `fire #${i+1} must defer`);
  }
  assert.strictEqual(killed.length, 0, 'never killed while tools still open');
  // Now tool finishes → next fire reaps normally.
  openCount = 0;
  const res = r.fire('sid-1');
  assert.strictEqual(res.action, 'killed');
  assert.strictEqual(res.reason, 'idle');
});

t('reaper enforces SESSION_MAX_DEFER_MS hard cap (30 min)', () => {
  const killed = [];
  // Tool stays open forever — simulates a genuinely-hung subagent.
  const r = makeReaper((sid, reason) => killed.push({ sid, reason }), () => 1);
  r.schedule('sid-1', 'no-clients');
  // Fire 6 times = 30 min of defer. Per the contract, the 6th fire
  // must reap with reason 'max-defer-exceeded'.
  let killedRes = null;
  for (let i = 0; i < 6; i++) {
    const res = r.fire('sid-1');
    if (res.action === 'killed') { killedRes = res; break; }
  }
  assert.ok(killedRes, 'hard cap must reap by 30 min even with tools open');
  assert.strictEqual(killedRes.reason, 'max-defer-exceeded');
  assert.deepStrictEqual(killed, [{ sid: 'sid-1', reason: 'max-defer-exceeded' }]);
});

t('cancelling a scheduled kill clears defer state (cleanup)', () => {
  const killed = [];
  let openCount = 1;
  const r = makeReaper((sid) => killed.push(sid), () => openCount);
  r.schedule('sid-1', 'no-clients');
  r.fire('sid-1');  // defer once
  assert.ok(r._deferState.has('sid-1'), 'defer state set after first fire');
  r.cancel('sid-1');
  assert.ok(!r._deferState.has('sid-1'), 'defer state cleared on cancel');
  assert.ok(!r._timers.has('sid-1'), 'timer cleared on cancel');
});

t('defer count resets when a client reconnects + later disconnects', () => {
  // User connects → disconnects (schedule + 3 defers = 15 min) →
  // reconnects (cancel, defer state cleared) → disconnects again
  // (fresh schedule, defer state starts from 0). Without the reset
  // we'd hit the 30-min cap too eagerly on the second disconnect
  // cycle.
  const killed = [];
  let openCount = 1;
  const r = makeReaper((sid) => killed.push(sid), () => openCount);
  r.schedule('sid-1', 'no-clients');
  r.fire('sid-1'); r.fire('sid-1'); r.fire('sid-1');  // 3 defers = 15 min
  r.cancel('sid-1');                                  // user reconnects
  r.schedule('sid-1', 'no-clients-again');            // user disconnects again
  // Fire 5 more times — still under fresh 30-min cap.
  for (let i = 0; i < 5; i++) {
    const res = r.fire('sid-1');
    assert.strictEqual(res.action, 'deferred', `fire #${i+1} after reconnect must defer (cap reset)`);
  }
  assert.strictEqual(killed.length, 0, 'no reap during fresh defer window');
});

t('the symptom from bug-21 pattern 2 (the 13:32:20 incident) does NOT recur under FIXED reaper', () => {
  // Simulate: subagent running (1 open tool — the Agent), browser tab
  // closed → 5 min later, timer fires → with the FIX, defer instead of kill.
  const killed = [];
  let agentInFlight = true;
  const r = makeReaper((sid) => killed.push(sid), () => (agentInFlight ? 1 : 0));
  r.schedule('myco-kkrazy-f80476dd', 'no-clients');
  // First fire = 5 min later (was the 13:32:20 reap in the original trace).
  const res = r.fire('myco-kkrazy-f80476dd');
  assert.strictEqual(res.action, 'deferred',
    'FIXED reaper must defer when the Agent (subagent) is still in flight');
  assert.strictEqual(killed.length, 0,
    'the 13:32:20 RESPAWN event must NOT happen under the FIXED reaper');
  // Subagent eventually finishes → next fire reaps cleanly.
  agentInFlight = false;
  const res2 = r.fire('myco-kkrazy-f80476dd');
  assert.strictEqual(res2.action, 'killed');
  assert.strictEqual(res2.reason, 'idle');
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards — anchor the fix shape on prod source.

const PROD_ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

t('attach.js declares SESSION_MAX_DEFER_MS constant', () => {
  assert.match(PROD_ATTACH, /SESSION_MAX_DEFER_MS\s*=/,
    'SESSION_MAX_DEFER_MS hard-cap constant must be declared so a hung tool can\'t pin a session forever');
});

// The reaper logic lives in either _scheduleSessionKill OR an extracted
// helper called from the setTimeout (e.g., _onKillTimerFire). Locate
// whichever function actually contains the timer-fire body.
function _grabReaperFireBody(src) {
  // Prefer an extracted helper (the post-fix shape).
  const helperStart = src.search(/function\s+_onKillTimerFire\b/);
  if (helperStart > -1) {
    const rest = src.slice(helperStart);
    const nextFn = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
    return nextFn === -1 ? rest : rest.slice(0, nextFn + 1);
  }
  // Fall back to in-line setTimeout body inside _scheduleSessionKill.
  const fnStart = src.search(/function\s+_scheduleSessionKill\b/);
  if (fnStart === -1) return '';
  const rest = src.slice(fnStart);
  const nextFn = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  return nextFn === -1 ? rest : rest.slice(0, nextFn + 1);
}

t('attach.js reaper-fire body reads openToolCalls before killing', () => {
  const body = _grabReaperFireBody(PROD_ATTACH);
  assert.ok(body.length > 0,
    'reaper-fire body must exist (either _onKillTimerFire or inline in _scheduleSessionKill)');
  assert.ok(/openToolCalls/.test(body),
    'reaper-fire body must read openToolCalls (or .size) to defer reap while tools are in flight');
  // The defer path must NOT call killSession when open > 0. The simplest
  // way to express this in static-grep is: there must be a log line OR
  // a branch that distinguishes the in-flight case. Look for 'defer' / 'in flight' / 'in-flight'.
  assert.ok(/defer/i.test(body) || /in[- ]?flight/i.test(body),
    'reaper-fire body must have a defer/in-flight branch — the keyword anchors that the reap is conditional');
});

t('attach.js reaper-fire body still reaps when openToolCalls is empty (no infinite defer)', () => {
  const body = _grabReaperFireBody(PROD_ATTACH);
  assert.ok(/killSession\s*\(/.test(body),
    'reaper-fire body must still call killSession() on the idle path — defer cannot become permanent for ordinary idle sessions');
});

// ──────────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
