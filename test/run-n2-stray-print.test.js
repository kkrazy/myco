//
// User-visible contract (2026-10-30 用户反馈): once a /run-n2 dual-agent run
// reaches its terminal (both workers done, "✅ /run-n2 完成" printed), NO
// further worker tool print may suddenly appear in the timeline — the run
// is finished; a trailing worker-A Bash(git push) tool_use/tool_result that
// drains after the terminal must not print, buffer, or persist.
//
// Pre-fix holes this locks:
//   1. server/src/compare-lanes.js `_bridge` forwarded EVERY worker
//      agent-event with no lane-end gate — a team lane's terminal signal
//      (team-complete / idle-worker turn_result) fires while the workers'
//      trailing tool events are still draining, so worker-A's final tool
//      print landed in the main timeline AFTER the completion line.
//   2. web/public/app.js `_routeAgentEvent` resolved a laneId-LESS worker
//      event to the currently-selected lane and seeded a record via
//      `_teamLaneRec` — bypassing the `endedLanes` retire guard whenever
//      the event's own lane couldn't be identified, resurrecting a
//      phantom multi-column row for a finished run.
//
// Static + runtime assertions, matching the repo's UI/lane regression
// convention (cf. team-ended-cleanup.test.js / slash-n2-compare.test.js).

const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'web', 'public', 'app.js');
const CL_FILE = path.join(ROOT, 'server', 'src', 'compare-lanes.js');
const appJs = fs.readFileSync(APP, 'utf8');
const clJs = fs.readFileSync(CL_FILE, 'utf8');

let passed = 0;
let failed = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log('  ✓ ' + name); passed++; })
    .catch((err) => { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; });
}

// ---- static source-shape locks ----

t('_bridge gates worker events on the lane terminal (stray-print fix)', () => {
  const body = fnBody(clJs, /function _bridge\s*\(/);
  assert.ok(/bridgeEnded/.test(body),
    'the bridge keeps a lane-ended flag');
  assert.ok(/onLaneTerminal\(executor,\s*true/.test(body),
    'the bridge arms the flag via the SAME onLaneTerminal channel the lane lifecycle uses');
  const gateAt = body.indexOf('bridgeEnded && ev && ev.worker');
  const emitAt = body.indexOf("mainSession.emit('agent-event'");
  assert.ok(gateAt >= 0, 'the agent-event listener returns early once the lane ended (worker-tagged events)');
  assert.ok(emitAt >= 0 && gateAt < emitAt,
    'the gate sits BEFORE the live emit');
  const bufAt = body.indexOf('mainSession.buffer.push');
  assert.ok(gateAt < bufAt, 'the gate also protects the buffer push (replay surface)');
});

t('_routeAgentEvent: laneId-less events cannot seed a record after any lane retired', () => {
  const body = fnBody(appJs, /function _routeAgentEvent\s*\(/);
  assert.ok(/!ev\.laneId && !_lanes\[evLaneId\]/.test(body),
    'a laneId-less event whose resolved lane has no live record is recognized as trailing traffic');
  assert.ok(/endedLanes/.test(body) && /Object\.keys\(state\.teamView\.endedLanes\)\.length > 0/.test(body),
    '…only when at least one lane already retired (legacy fresh-page seeding stays intact)');
  assert.ok(/return false;/.test(body.slice(body.indexOf('!ev.laneId'))),
    'the event falls through to the 单列 stream instead of seeding a phantom record');
  // The new guard must run BEFORE _teamLaneRec so no record is created.
  const guardAt = body.indexOf('!ev.laneId && !_lanes[evLaneId]');
  const recAt = body.indexOf('_teamLaneRec(evLaneId');
  assert.ok(guardAt >= 0 && recAt >= 0 && guardAt < recAt,
    'the laneId-less guard sits BEFORE _teamLaneRec');
});

// ---- runtime locks (real modules, stubbed sessions) ----

// Load compare-lanes with `_bridge` exported for the runtime check.
function loadClWithBridge() {
  const patched = clJs.replace('module.exports = {', 'module.exports = { _bridge,');
  const m = new Module(CL_FILE, null);
  m.filename = CL_FILE;
  m.paths = Module._nodeModulePaths(CL_FILE);
  m._compile(patched, CL_FILE);
  return m.exports;
}

async function main() {
  // Runtime: trailing worker tool events after the lane terminal are
  // gated — no live emit, no buffer push, no disk persist. Events BEFORE
  // the terminal still bridge. This red-flipped pre-fix (the trailing
  // tool_use/tool_result both bridged).
  await t('runtime: trailing worker tool events after lane terminal do not bridge', () => {
    const sessionsStub = { allocSeq: (() => { let n = 0; return () => ++n; })() };
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (req, ...rest) {
      if (req === './sessions') return 'sessions-stub';
      return origResolve.call(this, req, ...rest);
    };
    require.cache['sessions-stub'] = { id: 'sessions-stub', filename: 'sessions-stub', loaded: true, exports: sessionsStub };
    try {
      const cl = loadClWithBridge();
      const bridged = [];
      const persisted = [];
      const mainSession = {
        buffer: [],
        _persistEventToDisk: (ev) => persisted.push(ev),
        emit: (k, ev) => { if (k === 'agent-event') bridged.push(ev); },
      };
      const lane = new EventEmitter();
      lane.workers = { 'worker-A': { isBusy: () => false }, 'worker-B': { isBusy: () => false } };
      cl._bridge(lane, mainSession, 'sess-1', null, { laneId: 'n2-x', task: 'demo task' });

      lane.emit('agent-event', { type: 'assistant_text', content: 'done, pushing', worker: 'worker-A' });
      lane.emit('agent-event', { type: 'turn_result', subtype: 'success', worker: 'worker-A' }); // terminal (idle worker)
      lane.emit('agent-event', { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git push origin develop' }, worker: 'worker-A' });
      lane.emit('agent-event', { type: 'tool_result', tool_use_id: 't1', content: 'ok', worker: 'worker-A' });

      const stray = bridged.filter((e) => e.type === 'tool_use' || e.type === 'tool_result');
      assert.strictEqual(stray.length, 0,
        'no worker tool_use/tool_result may bridge after the lane terminal — the stray print the user saw');
      assert.ok(bridged.some((e) => e.type === 'assistant_text'),
        'pre-terminal worker events still bridge');
      assert.ok(mainSession.buffer.some((e) => e.type === 'assistant_text'),
        'pre-terminal events still reach the replay buffer');
      assert.strictEqual(persisted.filter((e) => e.type === 'tool_use' || e.type === 'tool_result').length, 0,
        'post-terminal tool events are not persisted into the main events.jsonl');
    } finally {
      Module._resolveFilename = origResolve;
      delete require.cache['sessions-stub'];
    }
  });

  // Runtime: a BUSY worker's mid-run turn_result does NOT end the lane
  // (premature-completion semantics preserved by the gate — the gate must
  // not arm on normal multi-iteration traffic).
  await t('runtime: gate does NOT arm on a busy worker\'s mid-run turn_result', () => {
    const sessionsStub = { allocSeq: (() => { let n = 0; return () => ++n; })() };
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (req, ...rest) {
      if (req === './sessions') return 'sessions-stub-2';
      return origResolve.call(this, req, ...rest);
    };
    require.cache['sessions-stub-2'] = { id: 'sessions-stub-2', filename: 'sessions-stub-2', loaded: true, exports: sessionsStub };
    try {
      const cl = loadClWithBridge();
      const bridged = [];
      const mainSession = { buffer: [], emit: (k, ev) => { if (k === 'agent-event') bridged.push(ev); } };
      const lane = new EventEmitter();
      lane.workers = { 'worker-A': { isBusy: () => true }, 'worker-B': { isBusy: () => false } };
      cl._bridge(lane, mainSession, 'sess-2', null, { laneId: 'n2-y', task: 'demo' });

      lane.emit('agent-event', { type: 'turn_result', subtype: 'success', worker: 'worker-A' }); // busy → not terminal
      lane.emit('agent-event', { type: 'tool_use', id: 't2', name: 'Edit', input: {}, worker: 'worker-A' }); // still mid-run
      assert.ok(bridged.some((e) => e.type === 'tool_use'),
        'a busy worker\'s post-turn_result tool traffic still bridges — the lane is NOT ended yet');
    } finally {
      Module._resolveFilename = origResolve;
      delete require.cache['sessions-stub-2'];
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
