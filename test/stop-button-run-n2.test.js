// stop-button-run-n2 — regression test for "the Stop button cannot stop
// a /run-n2 run".
//
// Pre-fix defect chain (verified by reading the code):
//   1. /run-n2 spawns a SHADOW TeamSession (compare-lanes startN2Lane)
//      parked on mainSession._teamLane. The MAIN session never
//      iterates — its isBusy()/_currentQuery stay false the whole run.
//   2. The Stop button's WS interrupt frame was dropped by the delm-10
//      busy gate (attach.js) because it only looked at the MAIN
//      session's busy state. Same for the typed-esc chat path and the
//      viewer interrupt path.
//   3. Client-side, _sendStopAgent + the HUD stop button gate on
//      state.claudeRunning (false during a lane run) so the frame was
//      never even sent.
//
// Post-fix contract:
//   - compare-lanes.stopN2Lane(mainSession) interrupts a live lane's
//     workers in reverse roster order and returns true; returns false
//     with no live lane; forces lane-ended + team-lane-end when no
//     worker is interruptible (never leaves a zombie lane).
//   - attach.js _handleInterrupt passes the gate when a live lane
//     exists even if the main session is idle, stops the lane FIRST,
//     then interrupts the main iteration if one is also live.
//   - client _sendStopAgent sends the frame while a lane is running.
//
// Runs entirely on stubbed sessions — never touches the live SDK.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const cl = require('../server/src/compare-lanes.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// A session-shaped stand-in for the MAIN AgentSession: only the
// surface stopN2Lane/_handleInterrupt touch (isBusy, interrupt,
// _teamLane, emit).
function makeMain() {
  const s = new EventEmitter();
  s.isBusy = () => false; // idle main — exactly the /run-n2 situation
  s.interrupted = 0;
  s.interrupt = () => { s.interrupted++; };
  s._teamLane = null;
  return s;
}

// A lane-shaped stand-in: workers with observable interrupt().
function makeLane(actors) {
  const lane = new EventEmitter();
  lane.roster = actors;
  lane.interruptOrder = [];
  lane.workers = {};
  for (const a of actors) {
    lane.workers[a] = {
      alive: true,
      interrupt: () => lane.interruptOrder.push(a),
    };
  }
  return lane;
}

// A lane whose workers are all dead — the "nothing interruptible"
// branch must still retire the lane (no zombie HUD).
function makeDeadLane(actors) {
  const lane = new EventEmitter();
  lane.roster = actors;
  lane.workers = {};
  for (const a of actors) lane.workers[a] = { alive: false, interrupt: () => {} };
  return lane;
}

async function main() {
  console.log('── stop-button-run-n2: Stop must reach a /run-n2 lane ──');

  await t('stopN2Lane returns false when no lane is parked on the session', () => {
    const main = makeMain();
    assert.strictEqual(cl.stopN2Lane(main), false, 'no _teamLane → false, nothing stopped');
    assert.strictEqual(cl.stopN2Lane(null), false, 'null session → false, no throw');
  });

  await t('stopN2Lane interrupts live lane workers in REVERSE roster order and returns true', () => {
    const main = makeMain();
    const lane = makeLane(['worker-A', 'worker-B']);
    cl._registerLaneForTest(main, { lane, laneId: 'n2-t1', task: 'a', ended: false, roster: lane.roster });
    assert.strictEqual(cl.stopN2Lane(main), true, 'live lane → true (something stopped)');
    assert.deepStrictEqual(lane.interruptOrder, ['worker-B', 'worker-A'],
      'workers must stop newest-spawned first: worker-B before worker-A');
  });

  await t('stopN2Lane ignores an already-ended lane (idempotent — a frozen record must not be re-stopped)', () => {
    const main = makeMain();
    const lane = makeLane(['worker-A', 'worker-B']);
    cl._registerLaneForTest(main, { lane, laneId: 'n2-t2', task: 'a', ended: true, roster: lane.roster });
    assert.strictEqual(cl.stopN2Lane(main), false, 'ended lane → false');
    assert.deepStrictEqual(lane.interruptOrder, [], 'no worker interrupted on an ended lane');
  });

  await t('stopN2Lane retires the lane (ended + team-lane-end) when no worker is interruptible — no zombie lane', () => {
    const main = makeMain();
    const lane = makeDeadLane(['worker-A', 'worker-B']);
    const rec = { lane, laneId: 'n2-t3', task: 'a', ended: false, roster: lane.roster };
    cl._registerLaneForTest(main, rec);
    const frames = [];
    main.on('state-update', (p) => frames.push(p));
    assert.strictEqual(cl.stopN2Lane(main), true, 'lane record existed → true');
    assert.strictEqual(rec.ended, true, 'laneRec.ended flipped so reattach freezes, not re-announces live');
    const end = frames.find((f) => f.kind === 'team-lane-end');
    assert.ok(end && end.teamLane === true, 'team-lane-end state-update emitted so the split view retires');
    assert.strictEqual(end.laneId, 'n2-t3', 'team-lane-end names the lane it retires (multi-lane)');
  });

  await t('_handleInterrupt passes the delm-10 gate for an idle main session WITH a live lane, and stops the lane', () => {
    // attach.js is not an easy direct require (side effects); lock the
    // gate composition instead: a live lane alone must make the
    // combined predicate true, and stopN2Lane must have been called
    // BEFORE the main interrupt (lane first, then main iteration).
    const main = makeMain();
    const lane = makeLane(['worker-A', 'worker-B']);
    cl._registerLaneForTest(main, { lane, laneId: 'n2-t4', task: 'a', ended: false, roster: lane.roster });
    const order = [];
    lane.workers['worker-B'].interrupt = () => order.push('lane:B');
    lane.workers['worker-A'].interrupt = () => order.push('lane:A');
    main.interrupt = () => order.push('main');
    // Mirror of attach.js _handleInterrupt body.
    const laneStopped = cl.stopN2Lane(main);
    const busy = main.isBusy();
    const acted = busy || laneStopped;
    assert.strictEqual(acted, true, 'gate must pass: lane live even though main is idle');
    if (acted && busy) main.interrupt();
    assert.deepStrictEqual(order, ['lane:B', 'lane:A'],
      'lane workers stopped first; main iteration NOT interrupted (main was idle)');
  });

  await t('_handleInterrupt composition: busy main AND live lane → lane first, then main', () => {
    const main = makeMain();
    main.isBusy = () => true; // main iterating while a lane also runs
    const lane = makeLane(['worker-A', 'worker-B']);
    cl._registerLaneForTest(main, { lane, laneId: 'n2-t5', task: 'a', ended: false, roster: lane.roster });
    const order = [];
    lane.workers['worker-B'].interrupt = () => order.push('lane:B');
    lane.workers['worker-A'].interrupt = () => order.push('lane:A');
    main.interrupt = () => order.push('main');
    const laneStopped = cl.stopN2Lane(main);
    const busy = main.isBusy();
    if (!(busy || laneStopped)) throw new Error('gate must pass');
    if (busy) main.interrupt();
    assert.deepStrictEqual(order, ['lane:B', 'lane:A', 'main'],
      'multiple concurrent runs stop in order: lane (newest worker first), then main iteration');
  });

  await t('_handleInterrupt composition: idle main, no lane → gate drops (no stray interrupt at an idle session)', () => {
    const main = makeMain();
    const laneStopped = cl.stopN2Lane(main);
    const busy = main.isBusy();
    assert.strictEqual(busy || laneStopped, false, 'gate must drop');
    assert.strictEqual(main.interrupted, 0, 'main.interrupt never called');
  });

  await t('attach.js: all three interrupt entry points route through _handleInterrupt (static)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
    const uses = (src.match(/_handleInterrupt\(/g) || []).length;
    assert.ok(uses >= 4, `expected >=4 _handleInterrupt call sites (helper def + owner frame + viewer frame + chat-esc), found ${uses}`);
    // The old duplicated busy-gate blocks must be gone from the frame
    // handlers (the chat-esc path keeps its own "(nothing to stop" note).
    assert.ok(!/t=interrupt dropped — session not working/.test(src),
      'old delm-10 drop logs must be gone (superseded by _handleInterrupt)');
    assert.ok(src.includes('stopN2Lane'), 'attach.js must call compare-lanes stopN2Lane');
  });

  await t('app.js: _sendStopAgent gate + HUD + composer Stop recognize a live team lane (static)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
    // _sendStopAgent gate: laneRunning mirror of the server's live-lane check.
    assert.ok(/laneRunning = state\.teamView\.active && state\.teamView\.teamLane && !state\.teamView\.laneEnded/.test(src),
      '_sendStopAgent must count a live team lane as "working"');
    const laneGateUses = (src.match(/state\.claudeRunning && !laneRunning/g) || []).length;
    assert.ok(laneGateUses >= 1, `the busy gate must be claudeRunning OR laneRunning (found ${laneGateUses})`);
    // HUD Stop button renders while a lane runs.
    assert.ok(/state\.claudeRunning \|\| laneRunningHud/.test(src),
      'HUD Stop button must render while a lane runs');
    // Composer Stop shows while a lane runs.
    assert.ok(/laneRunningComposer/.test(src),
      'composer Stop must show while a lane runs');
  });

  await t('artifacts.js: queue cancel-running stops a live lane too (static)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');
    assert.ok(/stopN2Lane/.test(src),
      'queue cancel-running must stop the shadow lane, not just main session.interrupt()');
  });

  console.log(`── stop-button-run-n2: ${passed} passed, ${failed} failed ──`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
