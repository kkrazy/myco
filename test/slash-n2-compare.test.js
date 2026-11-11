// Delm agent-n2 slash commands + compare lanes (feature #2/#3).
//
// Verifies, WITHOUT any live SDK query:
//   1. /run-n2   → spawns a dual-agent lane (startN2Lane) + dispatchTask to
//      both workers; events are NOT tagged `compareLane` so they render in
//      the main timeline with worker badges.
//   2. /compare  → spawns BOTH a single-agent lane (startSingleLane,
//      `write`) and a dual-agent lane (startN2Lane, `dispatchTask`); events
//      carry `compareLane` for the dual-column overlay.
//   3. The compare report builds + persists on lane-terminal (worker
//      turn_result counts as terminal even for the team lane) and the
//      in-chat reply shows per-lane metrics without crashing when there is
//      no single lane (/run-n2 path, summary.single === null).
//   4. compare-lanes.buildCompareReport handles a null single lane and
//      measures tool_use / output chars from the shadow events journals.
//   5. Regression: the sessions.js MYCO_N2 global gate treats '0'/'false'
//      as OFF (a bare truthiness check would wrongly upgrade every default
//      single session — process.env values are strings and '0' is truthy).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-slash-n2-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });
fs.writeFileSync(
  path.join(process.env.MYCO_STATE_DIR, 'allowed-github-users.txt'),
  '# fixture\nkkrazy\n',
);

const slash = require('../server/src/slashcmds');
const cl = require('../server/src/compare-lanes');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// A fake shadow lane: an EventEmitter (so onLaneTerminal can register +
// fire) plus recorded dispatch/write calls and journal paths.
function fakeN2Lane(dir) {
  const l = new EventEmitter();
  l.dispatchCalls = [];
  l.writeCalls = [];
  l.dispatchTask = (txt) => l.dispatchCalls.push(txt);
  l.write = (txt) => l.writeCalls.push(txt);
  l.dir = dir;
  l.id = 'S1-cmp-n2';
  l.boardFile = path.join(dir, 'board.jsonl');
  l.eventsFile = path.join(dir, 'events.jsonl');
  return l;
}
function fakeSingleLane(dir) {
  const l = new EventEmitter();
  l.writeCalls = [];
  l.write = (txt) => l.writeCalls.push(txt);
  l.dir = dir;
  l.id = 'S1-cmp-single';
  l.eventsFile = path.join(dir, 'events.jsonl');
  return l;
}

function jotEvents(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

function makeCtx(replies) {
  const mainSession = new EventEmitter();
  mainSession.alive = true;
  mainSession.cwd = tmpRoot;
  return {
    session: mainSession,
    sessionId: 'S1',
    user: 'kkrazy',
    absCwd: tmpRoot,
    reply: (m) => replies.push(String(m)),
  };
}

async function main() {
  // --- turn worker turn_result into terminal for a TEAM lane ---
  // 2026-10-29 premature-completion fix: a worker's turn_result is ONLY
  // terminal for the lane when the worker's SDK session is also finished
  // (busy probe). Otherwise it's normal mid-run per-turn traffic (stall
  // nudges / idle kicks / follow-up writes each end with a turn_result)
  // and must NOT complete the lane — that was the "✅ /run-n2 完成 弹出时
  // 任务其实还没跑完" bug. Plain stub lanes without isBusy keep the old
  // behaviour (worker terminal = lane terminal).
  await t('onLaneTerminal treats worker turn_result as terminal even for a team', () => {
    const l = new EventEmitter();
    let fired = 0;
    cl.onLaneTerminal(l, /* isTeam */ true, () => { fired += 1; });
    l.emit('agent-event', { type: 'tool_use', name: 'Bash' });        // not terminal
    assert.strictEqual(fired, 0, 'mid-run tool_use must NOT fire terminal');
    l.emit('agent-event', { type: 'turn_result', subtype: 'success', worker: 'worker-A' });
    assert.strictEqual(fired, 1, 'worker turn_result must fire terminal for team lane');
  });

  // --- premature-completion regression (2026-10-29 user report) ---
  // A team lane whose worker is STILL BUSY must not complete on that
  // worker's per-turn turn_result — the canonical pre-fix failure was
  // "✅ /run-n2 完成" popping while both agents were mid-run.
  await t('onLaneTerminal: busy worker turn_result does NOT complete a team lane (premature-completion fix)', () => {
    const l = new EventEmitter();
    const busyWorker = { isBusy: () => true };
    const idleWorker = { isBusy: () => false };
    l.workers = { 'worker-A': busyWorker, 'worker-B': idleWorker };
    let fired = 0;
    const seen = [];
    cl.onLaneTerminal(l, /* isTeam */ true, (ev) => { fired += 1; seen.push(ev && ev.type); });
    // worker-A is mid-iteration and lands a per-turn turn_result — NOT terminal.
    l.emit('agent-event', { type: 'turn_result', subtype: 'success', worker: 'worker-A' });
    assert.strictEqual(fired, 0, 'a BUSY worker\'s mid-run turn_result must NOT fire terminal (premature ✅ /run-n2 完成 bug)');
    // Mid-run non-terminal events still ignored, as before.
    l.emit('agent-event', { type: 'assistant_text', content: 'x', worker: 'worker-A' });
    assert.strictEqual(fired, 0, 'non-terminal events never fire cb');
    // The team-level drain signal is the authoritative completion.
    l.emit('team-complete', { queueEmpty: true, items: 2 });
    assert.strictEqual(fired, 1, 'team-complete fires the terminal callback');
    // team-failed also reaches the terminal callback (teardown path).
    const l2 = new EventEmitter();
    let fired2 = 0;
    cl.onLaneTerminal(l2, true, () => { fired2 += 1; });
    l2.emit('team-failed', { reason: 'stall' });
    assert.strictEqual(fired2, 1, 'team-failed fires the terminal callback');
    // A worker that has genuinely finished (not busy) still completes via its
    // own terminal event — keeps Stop/abort semantics (iteration_aborted while
    // the worker's iteration is fully torn down).
    const l3 = new EventEmitter();
    l3.workers = { 'worker-A': idleWorker };
    let fired3 = 0;
    cl.onLaneTerminal(l3, true, () => { fired3 += 1; });
    l3.emit('agent-event', { type: 'fatal', error: 'boom', worker: 'worker-A' });
    assert.strictEqual(fired3, 1, 'an IDLE worker\'s fatal event still fires terminal');
  });

  // --- whole-roster guard (2026-11-06 /run-n2 user report) ---
  // "还没结束，但 n2 识别任务状态结束了": a worker-level terminal from a
  // DEAD worker (kill_mid_stream / fatal) used to end the lane immediately —
  // workerFinished probed ONLY the event's own worker. One reaped/crashed
  // worker printed "✅ /run-n2 完成" while its sibling was mid-iteration.
  // The fix requires the WHOLE roster quiet before a worker-level terminal
  // completes the lane.
  await t('onLaneTerminal: a dead worker does NOT end the lane while a sibling is still working', () => {
    const l = new EventEmitter();
    const deadWorker = { isBusy: () => false, alive: false };   // killed — not busy
    const busyWorker = { isBusy: () => true, alive: true };     // sibling mid-iteration
    l.workers = { 'worker-A': deadWorker, 'worker-B': busyWorker };
    l.roster = ['worker-A', 'worker-B'];
    let fired = 0;
    cl.onLaneTerminal(l, true, () => { fired += 1; });
    // worker-A killed mid-stream → iteration_aborted is TERMINAL and A's own
    // probe passes (dead → not busy) — but B is still working: NO terminal.
    l.emit('agent-event', { type: 'iteration_aborted', reason: 'kill_mid_stream', worker: 'worker-A' });
    assert.strictEqual(fired, 0,
      'a single dead worker must NOT end the lane while a sibling is mid-iteration (premature ✅ /run-n2 完成 bug, 2026-11-06)');
    // Same for a fatal from the dead worker.
    l.emit('agent-event', { type: 'fatal', error: 'gateway 400 x3', worker: 'worker-A' });
    assert.strictEqual(fired, 0,
      'a dead worker\'s fatal must NOT end the lane while a sibling works');
    // The sibling finishes → its turn_result finds the whole roster quiet →
    // the lane completes via the LAST worker's terminal (normal path).
    busyWorker.isBusy = () => false;
    l.emit('agent-event', { type: 'turn_result', subtype: 'success', worker: 'worker-B' });
    assert.strictEqual(fired, 1,
      'the last worker to drain completes the lane — a genuinely-finished team still completes');
  });

  // Control: lanes without a roster/workers map (plain single-lane
  // EventEmitters, back-compat) keep the old worker-terminal semantics.
  await t('onLaneTerminal: plain lane without roster keeps legacy worker-terminal behaviour', () => {
    const l = new EventEmitter();
    let fired = 0;
    cl.onLaneTerminal(l, true, () => { fired += 1; });
    l.emit('agent-event', { type: 'turn_result', subtype: 'success', worker: 'worker-A' });
    assert.strictEqual(fired, 1,
      'no roster → wholeTeamQuiet is a no-op → legacy semantics preserved');
  });

  // --- buildCompareReport with a NULL single lane (the /run-n2 path) ---
  await t('buildCompareReport handles null single lane (no crash, verdict n2)', () => {
    const dir = path.join(tmpRoot, 'n2only');
    jotEvents(path.join(dir, 'events-worker-A.jsonl'), [
      { type: 'tool_use', name: 'Bash' },
      { type: 'assistant_text', content: 'hello, dual world' },
    ]);
    jotEvents(path.join(dir, 'events-worker-B.jsonl'), [
      { type: 'tool_use', name: 'Edit' },
    ]);
    jotEvents(path.join(dir, 'board.jsonl'), [{ s: 1 }, { s: 2 }]);
    const n2 = fakeN2Lane(dir);
    const report = cl.buildCompareReport({ task: 't', startedAt: 'ts' }, null, n2);
    assert.strictEqual(report.summary.single, null, 'no single lane → summary.single is null');
    assert.strictEqual(report.summary.verdict, cl.N2, 'no single lane → verdict is n2');
    assert.strictEqual(report.summary.n2.toolUse, 2, 'counts tool_use across both worker journals');
    assert.ok(report.summary.n2.outputChars > 0, 'counts assistant_text output chars');
    assert.strictEqual(report.summary.n2.boardEvents, 2, 'counts board journal rows');
  });

  // --- buildCompareReport with both lanes measures + picks a winner ---
  await t('buildCompareReport measures both lanes and picks winner', () => {
    const sdir = path.join(tmpRoot, 'cmp-single');
    jotEvents(path.join(sdir, 'events.jsonl'), [{ type: 'tool_use', name: 'Bash' }]);
    const ndir = path.join(tmpRoot, 'cmp-n2');
    jotEvents(path.join(ndir, 'events-worker-A.jsonl'), [{ type: 'tool_use', name: 'Bash' }]);
    jotEvents(path.join(ndir, 'events-worker-B.jsonl'), []);
    jotEvents(path.join(ndir, 'board.jsonl'), [{ s: 1 }]);
    const single = fakeSingleLane(sdir);
    const n2 = fakeN2Lane(ndir);
    const report = cl.buildCompareReport({ task: 't', startedAt: 'ts' }, single, n2);
    assert.strictEqual(report.summary.single.toolUse, 1, 'measures single lane');
    assert.strictEqual(report.summary.n2.toolUse, 1, 'measures n2 lane');
    assert.strictEqual(report.summary.verdict, cl.N2, 'tie tool traffic → n2 wins (more coverage)');
  });

  // --- /run-n2: a single dual lane, no compareLane tag on the events ---
  await t('/run-n2 spawns a dual lane + dispatchTask, no compareLane tag', async () => {
    const replies = [];
    const ctx = makeCtx(replies);
    let n2 = null;
    let singleCalls = 0;
    const origN2 = cl.startN2Lane;
    const origSingle = cl.startSingleLane;
    cl.startN2Lane = (o) => { n2 = fakeN2Lane(path.join(tmpRoot, 'rn2')); n2.laneTag = o.laneTag; n2.dispatchTask(o.task); return { lane: n2, id: n2.id, boardFile: n2.boardFile, dir: n2.dir }; };
    cl.startSingleLane = () => { singleCalls += 1; throw new Error('single must NOT spawn for /run-n2'); };
    try {
      await slash.dispatch(ctx, '/run-n2 my dual task');
      assert.ok(n2, 'startN2Lane was called');
      assert.deepStrictEqual(n2.dispatchCalls, ['my dual task'], 'dispatchTask fans out the task');
      assert.strictEqual(n2.laneTag, null, '/run-n2 passes laneTag=null → events render in main timeline');
      assert.strictEqual(singleCalls, 0, 'no single lane for /run-n2');
      // The /run-n2 lane is bridged with laneTag null → no compareLane field.
      const bridged = Object.assign({}, { type: 'turn_start', seq: 1, workerSeq: 2, worker: 'worker-A' });
      assert.strictEqual(bridged.compareLane, undefined, 'lanes carry worker + NO compareLane for /run-n2');
      // Drive the terminal: the team-level drain signal. Post-fix a
      // mid-run worker turn_result no longer completes the lane (see the
      // premature-completion regression above). /run-n2 is dual-agent
      // ONLY — no compare/analysis report, just a completion line.
      n2.emit('team-complete', { queueEmpty: true, items: 1 });
      assert.ok(!replies.some((r) => r.includes('对比') || r.includes('报告')),
        '/run-n2 must NOT emit a compare/analysis report');
      assert.ok(replies.some((r) => r.includes('/run-n2 完成')), 'a /run-n2 completion notice is emitted');
    } finally {
      cl.startN2Lane = origN2;
      cl.startSingleLane = origSingle;
    }
  });

  // --- /compare: SEQUENTIAL (single → n2), no dual-column overlay ---
  await t('/compare runs single then n2 sequentially with no compareLane panel', async () => {
    const replies = [];
    const ctx = makeCtx(replies);
    let single = null;
    let n2 = null;
    const origN2 = cl.startN2Lane;
    const origSingle = cl.startSingleLane;
    cl.startSingleLane = (o) => {
      single = fakeSingleLane(path.join(tmpRoot, 'cmp2-single'));
      single.laneTag = o.laneTag;
      single.write(o.task);
      return { lane: single, id: single.id, eventsFile: single.eventsFile, dir: single.dir };
    };
    cl.startN2Lane = (o) => {
      n2 = fakeN2Lane(path.join(tmpRoot, 'cmp2-n2'));
      n2.laneTag = o.laneTag;
      n2.dispatchTask(o.task);
      return { lane: n2, id: n2.id, boardFile: n2.boardFile, dir: n2.dir };
    };
    try {
      await slash.dispatch(ctx, '/compare dual vs single');
      assert.deepStrictEqual(single.writeCalls, ['dual vs single'], 'single lane gets the task via write');
      assert.strictEqual(single.laneTag, null, 'single lane is NOT tagged for an overlay (no panel)');
      assert.strictEqual(n2, null, 'dual lane deferred until single completes (sequential)');
      // Drive the single lane to terminal → n2 launches.
      single.emit('agent-event', { type: 'turn_result', worker: undefined });
      assert.ok(n2, 'n2 lane launched AFTER single completed (sequential)');
      assert.strictEqual(n2.laneTag, null, 'dual lane is NOT tagged for an overlay (no panel)');
      assert.deepStrictEqual(n2.dispatchCalls, ['dual vs single'], 'dual lane gets the task via dispatchTask');
      // Drive n2 to terminal → the report builds once.
      n2.emit('team-complete', { queueEmpty: true, items: 1 });
      const reportLine = replies.find((r) => r.includes('对比'));
      assert.ok(reportLine, 'a compare report reply is emitted');
      assert.ok(/单 agent：/.test(reportLine), 'report shows the single lane');
      assert.ok(/双 agent：/.test(reportLine), 'report shows the dual lane');
      assert.ok(/运行 /.test(reportLine), 'report includes a runtime comparison');
    } finally {
      cl.startN2Lane = origN2;
      cl.startSingleLane = origSingle;
    }
  });

  // --- A-1: single lane progress line (tools + output, no queue) ---
  await t('formatProgress single lane shows label + tool/output counts', () => {
    const line = cl.formatProgress({
      label: '单 agent',
      startedAt: null,
      totals: { toolUse: 5, toolResult: 5, chars: 320 },
      perWorker: {},
      queue: null,
    });
    assert.ok(line.includes('单 agent 进行中'), 'labels the lane');
    assert.ok(line.includes('工具 5'), 'reports tool count');
    assert.ok(line.includes('输出 320 字符'), 'reports output char count');
    assert.ok(!line.includes('子任务'), 'no board section when getQueue is null');
  });

  // --- A-2: dual-agent line surfaces per-worker activity + board queue ---
  await t('formatProgress dual lane surfaces per-worker tools + board sub-queue', () => {
    const line = cl.formatProgress({
      label: '双 agent',
      startedAt: null,
      totals: { toolUse: 0, toolResult: 0, chars: 0 },
      perWorker: { 'worker-A': { toolUse: 4, toolResult: 4, chars: 100 }, 'worker-B': { toolUse: 3, toolResult: 3, chars: 90 } },
      queue: [
        { id: 'q1', subject: 'build.sh', state: 'done', owner: 'worker-A' },
        { id: 'q2', subject: 'tests', state: 'claimed', owner: 'worker-B' },
        { id: 'q3', subject: 'deploy', state: 'open' },
      ],
    });
    assert.ok(line.includes('A:4 次'), 'shows worker-A tool count');
    assert.ok(line.includes('B:3 次'), 'shows worker-B tool count');
    assert.ok(line.includes('待领 1 / 进行中 1 / 完成 1'), 'summarizes board queue by state');
    assert.ok(line.includes('build.sh[done:A]'), 'samples a queue item with owner');
  });

  // --- A-1 wiring: /compare emits an IMMEDIATE single-agent progress line and,
  // after the single lane terminates, the dual lane surfaces board counts. ---
  await t('/compare streams live progress lines (single start + dual board queue)', async () => {
    const replies = [];
    const ctx = makeCtx(replies);
    let single = null;
    let n2 = null;
    const fakeBoardQueue = [
      { id: 'q1', subject: 'parse', state: 'done', owner: 'worker-A' },
      { id: 'q2', subject: 'render', state: 'claimed', owner: 'worker-B' },
    ];
    const origN2 = cl.startN2Lane;
    const origSingle = cl.startSingleLane;
    cl.startSingleLane = (o) => {
      single = fakeSingleLane(path.join(tmpRoot, 'prog-single'));
      single.write(o.task);
      return { lane: single, id: single.id, eventsFile: single.eventsFile, dir: single.dir };
    };
    cl.startN2Lane = (o) => {
      n2 = fakeN2Lane(path.join(tmpRoot, 'prog-n2'));
      // Give the fake team lane a board so getQueue() has live queue state.
      n2.board = { queueState: () => fakeBoardQueue };
      n2.dispatchTask(o.task);
      return { lane: n2, id: n2.id, boardFile: n2.boardFile, dir: n2.dir };
    };
    try {
      await slash.dispatch(ctx, '/compare progress');
      assert.ok(replies.some((r) => r.includes('单 agent 进行中')), 'immediate single-agent progress line (A-1)');
      assert.ok(replies.some((r) => r.includes('双 agent（worker-A/B）') || r.includes('双 agent 阶段')), 'describes both phases up front');
      // Single lane produces activity then reaches terminal -> n2 launches with
      // an immediate line that surfaces the board sub-queue.
      single.emit('agent-event', { type: 'tool_use', name: 'Bash' });
      single.emit('agent-event', { type: 'turn_result', worker: undefined });
      assert.ok(n2, 'dual lane launched after single completes');
      single.emit('agent-event', { type: 'assistant_text', content: 'extra after terminal' });
      // 2026-10-22 task-labeled heartbeat: launchN2 names the TASK in the
      // progress label (用户反馈: 打印要表明是什么任务), so the dual line
      // reads `⏳ 双 agent（worker-A/B）「<task>」 进行中` — the leading
      // `双 agent` prefix + 「task」 must both be present.
      const dualLine = replies.find((r) => /双 agent（worker-A\/B）?「/.test(r) && r.includes('进行中'));
      assert.ok(dualLine, 'an immediate dual-agent progress line is emitted (A-1)');
      assert.ok(/子任务 待领 0 \/ 进行中 1 \/ 完成 1/.test(dualLine), 'dual line surfaces board queue counts (A-2): ' + dualLine);
      assert.ok(dualLine.includes('render[claimed:B]'), 'dual line samples a claimed queue item with its owner');
      n2.emit('team-complete', { queueEmpty: true, items: 2 });
      assert.ok(replies.some((r) => r.includes('对比')), 'report still builds after the lanes stream progress');
    } finally {
      cl.startN2Lane = origN2;
      cl.startSingleLane = origSingle;
    }
  });

  // --- regression: report must NOT embed the live lane (circular 'root') ---
  // The old buildCompareReport put the raw `n2` object (which holds the live
  // TeamSession, whose DelmBoard has a `root` property closing a cycle) into
  // the report, so persistCompareReport's JSON.stringify threw "Converting
  // circular structure to JSON … property 'root' closes the circle". The
  // report must keep only serializable metadata + timing.
  await t('buildCompareReport is JSON-safe and carries per-lane timing', () => {
    const sdir = path.join(tmpRoot, 'circ-single');
    jotEvents(path.join(sdir, 'events.jsonl'), [{ type: 'tool_use', name: 'Bash' }]);
    const ndir = path.join(tmpRoot, 'circ-n2');
    jotEvents(path.join(ndir, 'events-worker-A.jsonl'), [{ type: 'tool_use', name: 'Edit' }]);
    jotEvents(path.join(ndir, 'board.jsonl'), [{ s: 1 }]);
    const single = fakeSingleLane(sdir); single.startedAt = 1000; single.endedAt = 4000;
    const n2 = fakeN2Lane(ndir); n2.startedAt = 4000; n2.endedAt = 7000;
    const report = cl.buildCompareReport({ task: 't', startedAt: 'ts' }, single, n2);
    assert.strictEqual(report.n2.lane, undefined, 'report must NOT embed the live lane (circular-root fix)');
    assert.strictEqual(report.n2.dir, ndir, 'serializable metadata (dir) is kept');
    assert.strictEqual(report.timing.single, 3000, 'single duration = endedAt - startedAt');
    assert.strictEqual(report.timing.n2, 3000, 'n2 duration = endedAt - startedAt');
    assert.doesNotThrow(() => JSON.stringify(report), 'report serializes without a circular error');
  });

  // --- persistCompareReport writes a file under <cwd>/_myco_/compare ---
  await t('persistCompareReport writes JSON under <cwd>/_myco_/compare', () => {
    const file = cl.persistCompareReport(tmpRoot, { hello: 'world', summary: { verdict: cl.N2 } });
    assert.ok(fs.existsSync(file), 'report file exists: ' + file);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(parsed.summary.verdict, cl.N2, 'round-trips the report');
  });

  // --- full-text hover (用户需求: 截断行鼠标放上去可以看到全部内容) ---
  // formatProgress with a fullText builder returns {line, full}: the line
  // stays truncated (first few words), the FULL task prompt + complete queue
  // ride in .full for the caller to stamp as meta.fullText.
  await t('formatProgress fullText keeps the line short but returns the full content', () => {
    const longTask = '1.切换到远端develop分支 2.修复完成后commit提交 3.推送到远端 4.k8s部署';
    const out = cl.formatProgress({
      label: `双 agent（worker-A/B）「${cl.shortTask(longTask)}」`,
      startedAt: null,
      totals: { toolUse: 0, toolResult: 0, chars: 0 },
      perWorker: {},
      queue: [
        { id: 'q1', subject: 'commit', state: 'done', owner: 'worker-A' },
        { id: 'q2', subject: 'deploy', state: 'open' },
        { id: 'q3', subject: 'verify', state: 'claimed', owner: 'worker-B' },
        { id: 'q4', subject: 'report', state: 'open' },
      ],
      fullText: ({ queue }) => `任务：${longTask}\n子任务（${queue.length}）：\n${queue.map((i) => `  · ${i.subject} [${i.state}]`).join('\n')}`,
    });
    assert.ok(out && typeof out === 'object', 'with fullText the return is {line, full}');
    assert.ok(!out.line.includes('k8s部署'), 'the truncated line must NOT embed the full prompt');
    assert.ok(out.full.includes(longTask), 'the full prompt IS in .full (hover tooltip content)');
    assert.ok(out.full.includes('report'), 'the FULL queue (beyond the 3-item line sample) is in .full');
    // Without fullText the legacy shape (plain string) is preserved.
    const legacy = cl.formatProgress({
      label: '单 agent', startedAt: null,
      totals: { toolUse: 1, toolResult: 1, chars: 10 }, perWorker: {}, queue: null,
    });
    assert.strictEqual(typeof legacy, 'string', 'without fullText formatProgress still returns a plain string (back-compat)');
  });

  // --- /run-n2 completion + heartbeat lines carry meta.fullText ---
  await t('/run-n2 completion + heartbeat replies carry meta.fullText for hover', async () => {
    const replies = [];
    const metas = [];
    const ctx = makeCtx(replies);
    ctx.reply = (m, opts) => { replies.push(String(m)); if (opts && opts.meta) metas.push(opts.meta); };
    let n2 = null;
    const origN2 = cl.startN2Lane;
    const origSingle = cl.startSingleLane;
    const longTask = '你好，今天天气怎么样，你的心情怎么样，请问还有什么可以帮您';
    cl.startN2Lane = (o) => {
      n2 = fakeN2Lane(path.join(tmpRoot, 'rn2-full'));
      n2.board = { queueState: () => [{ id: 'q1', subject: 'answer', state: 'done', owner: 'worker-A' }] };
      n2.dispatchTask(o.task);
      return { lane: n2, id: n2.id, boardFile: n2.boardFile, dir: n2.dir };
    };
    cl.startSingleLane = () => { throw new Error('no single lane for /run-n2'); };
    try {
      await slash.dispatch(ctx, `/run-n2 ${longTask}`);
      // Immediate first heartbeat line: truncated text + meta.fullText.
      const hbIdx = replies.findIndex((r) => r.includes('双 agent（worker-A/B）'));
      assert.ok(hbIdx >= 0, 'heartbeat line emitted');
      assert.ok(!replies[hbIdx].includes('还有什么可以帮您'), 'heartbeat line keeps the task truncated');
      assert.ok(metas.some((mt) => mt.fullText && mt.fullText.includes(longTask)),
        'heartbeat meta.fullText carries the FULL task prompt');
      n2.emit('team-complete', { queueEmpty: true, items: 1 });
      const doneIdx = replies.findIndex((r) => r.includes('/run-n2 完成'));
      assert.ok(doneIdx >= 0, 'completion line emitted');
      assert.ok(metas.some((mt) => mt.fullText && mt.fullText.includes(longTask)),
        'completion meta.fullText carries the FULL task prompt for hover');
    } finally {
      cl.startN2Lane = origN2;
      cl.startSingleLane = origSingle;
    }
  });

  // --- client renders the tooltip: renderChatMessage stamps title + class ---
  await t('app.js renderChatMessage stamps title tooltip for meta.fullText rows', () => {
    const src = fs.readFileSync(require.resolve('../web/public/app.js'), 'utf8');
    assert.ok(src.includes("m.meta.fullText === 'string'"),
      'renderChatMessage reads meta.fullText (hover content must come from the server-stamped meta)');
    assert.ok(/cls \+= ' chat-msg-fulltext';/.test(src),
      'meta.fullText rows get the chat-msg-fulltext class (CSS affordance hook)');
    assert.ok(/rowAttrs \+= ` title="\$\{escHtml\(fullText\)\}"`;/.test(src),
      'the full content is stamped as a native title tooltip on the row');
    const css = fs.readFileSync(require.resolve('../web/public/styles.css'), 'utf8');
    assert.ok(css.includes('.chat-msg.chat-msg-fulltext'),
      'styles.css has the chat-msg-fulltext hover affordance rule');
  });

  // --- regression: MYCO_N2='0' must not upgrade sessions to agent-n2 ---
  await t('sessions.js MYCO_N2 gate treats 0/false as OFF (not truthy)', () => {
    const src = fs.readFileSync(require.resolve('../server/src/sessions.js'), 'utf8');
    assert.ok(
      src.includes("['0', 'false']"),
      'sessions.js ensureLiveSession gate must exclude 0/false from the MYCO_N2 check so default sessions stay single-agent',
    );
  });

  if (failed) {
    console.log(`\n${failed} test(s) FAILED, ${passed} passed.`);
    process.exit(1);
  }
  console.log(`\n${passed} tests passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
