// multi-lane run-n2 看板 regression (2026-10-22 user report).
//
// "同一个 session 起多个 run-n2 是不是看板分开展示，别复用同一个"
// Pre-fix: startN2Lane overwrote mainSession._teamLane — the second
// /run-n2 clobbered the first lane's board record (one shared 看板,
// previous run's board lost). Post-fix: every lane is kept in a keyed
// registry (mainSession._teamLanes, laneId = n2-<ts>-<n>), all
// team-info / board / team-lane-end frames + bridged agent-events carry
// { laneId, task }, stopN2Lane stops EVERY live lane, and the attach
// handshake ships every lane in start order.
//
// This suite runs WITHOUT a live SDK: TeamSession workers are stubbed
// by killing the lane immediately after start (same trick
// team-split-view.test.js uses — startN2Lane spawns real AgentSessions,
// so each test kills the lane in `finally` before the SDK query fires
// or right after, treating spawn noise as harmless).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-multilane-'));
const cl = require('../server/src/compare-lanes');
const attachMod = require('../server/src/attach.js');
const ship = attachMod.__test ? attachMod.__test._shipTeamInfoOnAttach : null;

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : err)); failed++; }
}

function tmpdir() {
  return fs.mkdtempSync(path.join(tmpBase, 'run-'));
}

function fakeWs() {
  return {
    OPEN: 1,
    readyState: 1,
    sent: [],
    send(s) { this.sent.push(JSON.parse(s)); },
  };
}

async function main() {
  console.log('── team-multilane-boards: 多个 /run-n2 各自独立看板 ──');

  await t('two concurrent /run-n2 lanes are BOTH kept — keyed registry, no clobber', () => {
    const main = new EventEmitter();
    main.buffer = [];
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const r1 = cl.startN2Lane({ cwd, user: 'u', task: 'task one', dir: path.join(dir, 'l1'), mainSession: main, mainSessionId: 'ml-a', laneTag: null });
    const r2 = cl.startN2Lane({ cwd, user: 'u', task: 'task two', dir: path.join(dir, 'l2'), mainSession: main, mainSessionId: 'ml-a', laneTag: null });
    try {
      const lanes = cl.listLanes(main);
      assert.strictEqual(lanes.length, 2, 'BOTH lanes registered (pre-fix the 2nd overwrote the 1st)');
      assert.ok(r1.laneId && r2.laneId && r1.laneId !== r2.laneId, 'each lane gets a distinct laneId');
      assert.strictEqual(lanes[0].task, 'task one', 'registry preserves START order (oldest first)');
      assert.strictEqual(lanes[1].task, 'task two', 'second lane recorded with its own task');
      // The legacy newest-lane alias still points at the LAST started lane.
      assert.strictEqual(main._teamLane.laneId, r2.laneId, '_teamLane alias = newest lane (back-compat)');
    } finally {
      try { r1.lane.kill(); } catch {}
      try { r2.lane.kill(); } catch {}
    }
  });

  await t('team-info / board / team-lane-end frames + bridged events carry laneId + task', () => {
    const main = new EventEmitter();
    main.buffer = [];
    const frames = [];
    main.on('state-update', (p) => frames.push(p));
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const r1 = cl.startN2Lane({ cwd, user: 'u', task: 'alpha', dir: path.join(dir, 'a'), mainSession: main, mainSessionId: 'ml-b', laneTag: null });
    const r2 = cl.startN2Lane({ cwd, user: 'u', task: 'beta', dir: path.join(dir, 'b'), mainSession: main, mainSessionId: 'ml-b', laneTag: null });
    try {
      const infos = frames.filter((f) => f.kind === 'team-info');
      assert.strictEqual(infos.length, 2, 'each start emits its OWN team-info frame');
      assert.strictEqual(infos[0].laneId, r1.laneId, 'first team-info names lane 1');
      assert.strictEqual(infos[0].task, 'alpha', 'first team-info carries the task label');
      assert.strictEqual(infos[1].laneId, r2.laneId, 'second team-info names lane 2 (not lane 1 again)');
      assert.strictEqual(infos[1].task, 'beta', 'second team-info carries its own task');
      // A worker agent-event bridges with the lane tag so the 单列 stream
      // can label which run a card belongs to.
      r1.lane.emit('agent-event', { type: 'assistant_text', content: 'from lane 1', worker: 'worker-A', seq: 1, workerSeq: 1 });
      const tagged = main.buffer.filter((ev) => ev.content === 'from lane 1');
      assert.strictEqual(tagged.length, 1, 'lane-1 worker event mirrored into main.buffer');
      assert.strictEqual(tagged[0].laneId, r1.laneId, 'bridged event carries the laneId');
      assert.strictEqual(tagged[0].laneTask, 'alpha', 'bridged event carries the task label (单流任务标注)');
      // Terminal retires ONLY its own lane.
      r1.lane.emit('team-complete', {});
      const end = frames.filter((f) => f.kind === 'team-lane-end');
      assert.strictEqual(end.length, 1, 'one team-lane-end so far (lane 1 only)');
      assert.strictEqual(end[0].laneId, r1.laneId, 'team-lane-end names the lane it ended');
      assert.strictEqual(cl.listLanes(main).filter((r) => !r.ended).length, 1, 'lane 2 still live after lane 1 ended');
    } finally {
      try { r1.lane.kill(); } catch {}
      try { r2.lane.kill(); } catch {}
    }
  });

  await t('attach handshake ships EVERY lane (start order), each tagged laneId/task', () => {
    assert.strictEqual(typeof ship, 'function', '_shipTeamInfoOnAttach exported via attach.js __test');
    const main = new EventEmitter();
    main.buffer = [];
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const r1 = cl.startN2Lane({ cwd, user: 'u', task: 'one', dir: path.join(dir, 'o'), mainSession: main, mainSessionId: 'ml-c', laneTag: null });
    const r2 = cl.startN2Lane({ cwd, user: 'u', task: 'two', dir: path.join(dir, 't'), mainSession: main, mainSessionId: 'ml-c', laneTag: null });
    try {
      // End the FIRST lane — the handshake must still ship it as a frozen
      // record alongside the live second lane.
      r1.lane.emit('team-complete', {});
      const ws = fakeWs();
      ship(main, ws, 'ml-c', null);
      const infos = ws.sent.filter((f) => f.kind === 'team-info');
      assert.strictEqual(infos.length, 2, 'initial attach ships BOTH lanes (one frame each)');
      assert.strictEqual(infos[0].laneId, r1.laneId, 'frame 1 = the ended lane (start order)');
      assert.strictEqual(infos[0].ended, true, 'ended lane ships ended:true');
      assert.strictEqual(infos[1].laneId, r2.laneId, 'frame 2 = the live lane');
      assert.strictEqual(infos[1].ended, false, 'live lane ships ended:false');
      assert.ok(infos[0].task === 'one' && infos[1].task === 'two', 'each frame carries its own task label');
      // Catch-up (afterSeq) ships only the ended lane's end transition.
      const ws2 = fakeWs();
      ship(main, ws2, 'ml-c', 7);
      const ends = ws2.sent.filter((f) => f.kind === 'team-lane-end');
      assert.strictEqual(ends.length, 1, 'catch-up ships exactly the missed end transition');
      assert.strictEqual(ends[0].laneId, r1.laneId, 'catch-up end names the ended lane');
      assert.ok(!ws2.sent.some((f) => f.kind === 'team-info'), 'catch-up does not re-ship team-info');
    } finally {
      try { r1.lane.kill(); } catch {}
      try { r2.lane.kill(); } catch {}
    }
  });

  await t('stopN2Lane stops EVERY live lane (newest lane first) and skips ended ones', () => {
    const main = new EventEmitter();
    const frames = [];
    main.on('state-update', (p) => frames.push(p));
    const makeLane = (actors) => {
      const lane = new EventEmitter();
      lane.roster = actors;
      lane.stopped = [];
      lane.workers = {};
      for (const a of actors) lane.workers[a] = { alive: true, interrupt: () => lane.stopped.push(a) };
      return lane;
    };
    const l1 = makeLane(['worker-A', 'worker-B']);
    const l2 = makeLane(['worker-A', 'worker-B']);
    cl._registerLaneForTest(main, { lane: l1, laneId: 'n2-old', task: 'old', ended: false, roster: l1.roster });
    cl._registerLaneForTest(main, { lane: l2, laneId: 'n2-new', task: 'new', ended: false, roster: l2.roster });
    // An already-ended lane in the registry must be left alone.
    const l3 = makeLane(['worker-A']);
    cl._registerLaneForTest(main, { lane: l3, laneId: 'n2-done', task: 'done', ended: true, roster: l3.roster });
    assert.strictEqual(cl.stopN2Lane(main), true, 'live lanes existed → true');
    assert.deepStrictEqual(l2.stopped, ['worker-B', 'worker-A'], 'NEWEST lane stops first (newest worker first)');
    assert.deepStrictEqual(l1.stopped, ['worker-B', 'worker-A'], 'older lane also stops');
    assert.deepStrictEqual(l3.stopped, [], 'ended lane NOT re-stopped');
    const ends = frames.filter((f) => f.kind === 'team-lane-end');
    assert.strictEqual(ends.length, 0, 'interruptible lanes retire via their own onLaneTerminal, no zombie end frames here');
  });

  await t('/run-n2 heartbeat + completion lines name the TASK, capped to its first few words (单流任务标注)', () => {
    const src = fs.readFileSync(require.resolve('../server/src/slashcmds.js'), 'utf8');
    assert.ok(/taskLabel = `双 agent（worker-A\/B）「\$\{cl\.shortTask\(task\)\}」`/.test(src),
      'launchN2 builds a task-named progress label via cl.shortTask (用户反馈: ⏳ 打印不要把 prompt 全加上)');
    assert.ok(src.includes('✅ /run-n2 完成：双 agent 跑「${cl.shortTask(task)}」'),
      'the /run-n2 completion reply names the (shortened) task');
    const clsrc = fs.readFileSync(require.resolve('../server/src/compare-lanes.js'), 'utf8');
    assert.ok(/shortTask/.test(clsrc) && /module\.exports[\s\S]*shortTask/.test(clsrc),
      'compare-lanes exports shortTask so slashcmds can reuse it');
    // Behavior: long prompt is truncated to a prefix + ellipsis; short prompt passes through.
    const line = cl.formatProgress({
      label: `双 agent（worker-A/B）「${cl.shortTask('1.切换到远端develop分支 2.修复打印问题 3.提交 4.部署到机器上')}」`,
      startedAt: null,
      totals: { toolUse: 0, toolResult: 0, chars: 0 },
      perWorker: {},
      queue: null,
    });
    assert.ok(!line.includes('部署到机器上'),
      'a long task prompt is NOT fully embedded in the progress line');
    assert.ok(line.includes('双 agent（worker-A/B）「1.切换到远端devel'),
      'the progress line keeps the 双 agent prefix + first words of the task');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  // Always exit explicitly, even on success. This suite starts real lanes and
  // kills them in `finally`, which leaves sockets mid-teardown; the process
  // then lingers long enough for one to write into a closed peer and die on an
  // EPIPE — reported as exit=1 for a suite whose 5 cases all passed. Same
  // trick and same exit as team-split-view.test.js.
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
