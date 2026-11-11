// TeamSession (server/src/team-session.js) — Delm n=2 team in one process.
//
// Verifies the orchestration container WITHOUT touching the live SDK (which
// would open a real Claude connection). We construct a TeamSession, then:
//  - check both workers exist with the right per-worker systemPrompt
//  - verify chat routing (write) goes to worker-A only, and dispatchTask
//    fans out to both workers (worker .write stubbed to spies)
//  - verify worker agent-events are relayed with a `worker` tag + team seq
//  - verify team-complete fires once the board sub-queue is fully done and
//    both workers are idle.

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { TeamSession } = require('../server/src/team-session.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-test-'));
}

async function main() {
  console.log('── team-session: dual-worker orchestration ──');

  await t('constructs two workers sharing one board with correct start prompts', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('team-1', { cwd, user: 'u', task: 'Build a CLI', eventsDir: dir });
    assert.ok(team.workers['worker-A'] && team.workers['worker-B'], 'both workers exist');
    assert.deepStrictEqual(team.board.actors, ['worker-A', 'worker-B']);
    // per-worker orchestration prompt
    assert.ok(team.workers['worker-A'].systemPrompt.includes('Establish the initial split'),
      'worker-A gets STARTUP_A');
    assert.ok(team.workers['worker-B'].systemPrompt.includes('Leave initial queue creation'),
      'worker-B gets STARTUP_B');
    team.kill();
  });

  // fix-1: n=2 workers run as autonomous background shadows — they must NOT
  // block on a chat-pane permission prompt (nobody answers a shadow-lane
  // canUseTool, so a hung Bash/Write froze the whole team).
  await t('n=2 workers run with autonomousPermission (no interactive prompts)', async () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('team-nyone', { cwd, task: 'T', eventsDir: dir });
    assert.strictEqual(team.workers['worker-A'].autonomousPermission, true, 'worker-A autonomous');
    assert.strictEqual(team.workers['worker-B'].autonomousPermission, true, 'worker-B autonomous');
    // _preToolUseHook auto-approves even a Bash call — the tool that used to
    // hang the shadow lane on an unanswered permission prompt.
    const decision = await team.workers['worker-A']._preToolUseHook({
      tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'tool-1',
    });
    assert.strictEqual(
      decision && decision.hookSpecificOutput && decision.hookSpecificOutput.permissionDecision,
      'allow',
      'autonomous worker auto-allows Bash (no interactive prompt)',
    );
    team.kill();
  });

  // fix-3: stall watchdog — no worker activity for NUDGE fires a "continue"
  // nudge; no activity past the FAIL window declares team-failed instead of
  // hanging forever. Both windows are env-overridable; the test drives
  // _stallCheck directly with the default thresholds (220min nudge / 240min
  // fail, lengthened 2026-11-05 — see the comment in team-session.js).
  await t('stall watchdog nudges idle workers, then declares team-failed', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('team-stall', { cwd, task: 'T', eventsDir: dir });
    const writes = { 'worker-A': [], 'worker-B': [] };
    team.workers['worker-A'].write = (txt) => writes['worker-A'].push(txt);
    team.workers['worker-B'].write = (txt) => writes['worker-B'].push(txt);
    const notes = [];
    const fails = [];
    team.on('chat', (c) => notes.push(c));
    team.on('team-failed', (f) => fails.push(f));

    // >220min idle, <240min → nudge once, do not fail. Liveness is per-worker
    // (a team-wide stamp let one busy worker mask a silent peer), so the test
    // moves both clocks.
    team._lastActivity = Date.now() - 225 * 60 * 1000;
    for (const a of team.roster) team._lastActivityBy[a] = Date.now() - 225 * 60 * 1000;
    team._stallNudged = false;
    team._stallCheck();
    assert.ok(notes.some((c) => c.text && c.text.includes('继续')),
      'emitted a "continue" nudge chat note');
    assert.strictEqual(fails.length, 0, 'one nudge must NOT fail the team yet');
    assert.ok(writes['worker-A'].some((w) => w.includes('Continue')), 'idle worker-A got the continue prompt');
    assert.ok(writes['worker-B'].some((w) => w.includes('Continue')), 'idle worker-B got the continue prompt');

    // Still silent past the 240min fail window, with NOTHING claimed and both
    // workers quiet → finished, not stuck: failing here would throw away a
    // completed rollout. (The old check was team-wide and fired anyway.)
    team._lastActivityBy['worker-A'] = Date.now() - 245 * 60 * 1000;
    team._lastActivityBy['worker-B'] = Date.now() - 245 * 60 * 1000;
    team._lastActivity = Date.now() - 245 * 60 * 1000;
    team._stallCheck();
    assert.strictEqual(fails.length, 1,
      'a team where every worker is quiet and holds nothing IS over — declare it');
    assert.strictEqual(fails[0].reason, 'stall', 'reason is stall');
    team.kill();
  });

  // Regression (sw-20261031-163112, $205.80 + 10366s wasted): liveness was
  // TEAM-wide, so one busy worker masked a peer that had gone silent holding a
  // claim. worker-B stopped at 18:52:51; worker-A kept emitting until 19:15:54,
  // resetting the single clock each time. When worker-A finished, the timer
  // started from zero and 485s later the team was killed — with a complete
  // sol/ and REPORT.md already on disk.
  await t('a silent worker holding a claim is nudged to CLOSE it, not to find more work', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('team-claim-stall', { cwd, task: 'T', eventsDir: dir });
    const writes = { 'worker-A': [], 'worker-B': [] };
    team.workers['worker-A'].write = (txt) => writes['worker-A'].push(txt);
    team.workers['worker-B'].write = (txt) => writes['worker-B'].push(txt);
    const fails = [];
    team.on('team-failed', (f) => fails.push(f));

    // worker-B published an item and claimed it; both workers were active
    // moments ago, then worker-B went silent while worker-A kept working.
    const pub = team.board.publish('worker-B', [{ subject: 'REPORT.md 定稿', detail: 'd' }]);
    const it = pub.items[0];
    team.board.claim('worker-B', it.id);
    team._lastActivityBy['worker-A'] = Date.now();                        // busy
    team._lastActivityBy['worker-B'] = Date.now() - 225 * 60 * 1000;      // silent (past 220min nudge window)
    team._stallNudged = false;
    team._stallCheck();

    assert.ok(writes['worker-B'].some((w) => w.includes('board.done')),
      'the stuck worker is told to close its claim — the work may already be done');
    assert.ok(!writes['worker-A'].some((w) => w.includes('Continue')),
      'the busy worker must not be interrupted');
    assert.strictEqual(fails.length, 0, 'one nudged worker is not a team failure');
    team.kill();
  });

  await t('a busy worker does not mask a stuck peer', () => {
    // The old team-wide clock made this scenario invisible for 23 minutes.
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('team-mask', { cwd, task: 'T', eventsDir: dir });
    const fails = [];
    team.on('team-failed', (f) => fails.push(f));
    const pub = team.board.publish('worker-B', [{ subject: 'H7 泛化测试', detail: 'd' }]);
    const it = pub.items[0];
    team.board.claim('worker-B', it.id);

    team._stallNudged = true;                                   // nudge already sent
    team._lastActivityBy['worker-A'] = Date.now();              // worker-A busy
    team._lastActivityBy['worker-B'] = Date.now() - 245 * 60 * 1000;  // past FAIL
    team._stallCheck();
    assert.strictEqual(fails.length, 1,
      'a worker past the fail window while still holding a claim is a stuck team');
    assert.ok(String(fails[0].stuckWorkers || '').includes('worker-B'),
      'the failure names the stuck worker so the report is diagnosable');
    team.kill();
  });

  // Regression (RLM masking, 2026-11-05): a bridged RLM sub-agent event
  // (bridge.js stamps `rlmLane`) is UI-only traffic from the worker's OWN
  // rlm.spawn children — it is NOT the worker's SDK activity. Pre-fix it
  // reset _lastActivityBy on every relay, so a dead/stuck RLM worker was
  // masked forever by its still-running children (same miss-class as the
  // busy-peer-masks-silent-peer bug above). The watchdog must only feed on
  // the worker's OWN events.
  await t('bridged RLM child events do NOT feed the stall watchdog', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('team-rlm-mask', { cwd, task: 'T', eventsDir: dir });
    const fails = [];
    team.on('team-failed', (f) => fails.push(f));
    const pub = team.board.publish('worker-B', [{ subject: 'S', detail: 'd' }]);
    const it = pub.items[0];
    team.board.claim('worker-B', it.id);

    // worker-B: silent past the FAIL window, still holding the claim.
    team._stallNudged = true;
    team._lastActivityBy['worker-A'] = Date.now();
    team._lastActivityBy['worker-B'] = Date.now() - 245 * 60 * 1000;

    // Its rlm.spawn child keeps emitting bridged events (bridge.js shape:
    // { rlmLane: 'rlm-child', ... }). Pre-fix these refreshed the clock and
    // the stuck worker was invisible; post-fix the watchdog must fire.
    team.workers['worker-B'].emit('agent-event',
      { type: 'assistant_text', text: 'child busy', rlmLane: 'rlm-child' });
    team._stallCheck();

    assert.strictEqual(fails.length, 1,
      'a stuck worker must NOT be masked by its bridged RLM child events — the watchdog must fire');
    assert.ok(String(fails[0].stuckWorkers || '').includes('worker-B'),
      'the failure still names the actually-stuck worker-B');
    team.kill();
  });

  // Control: the SAME event without the rlmLane stamp IS the worker's own
  // activity — the watchdog must reset and NOT fail the team.
  await t("a worker's own assistant_text still resets the watchdog (no rlmLane)", () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('team-rlm-ctrl', { cwd, task: 'T', eventsDir: dir });
    const fails = [];
    team.on('team-failed', (f) => fails.push(f));
    const pub = team.board.publish('worker-B', [{ subject: 'S', detail: 'd' }]);
    const it = pub.items[0];
    team.board.claim('worker-B', it.id);

    team._stallNudged = true;
    team._lastActivityBy['worker-A'] = Date.now();
    team._lastActivityBy['worker-B'] = Date.now() - 245 * 60 * 1000;
    // Own-stream assistant event (no rlmLane) → liveness, no fail.
    team.workers['worker-B'].emit('agent-event', { type: 'assistant_text', text: 'own work' });
    team._stallCheck();

    assert.strictEqual(fails.length, 0,
      "the worker's own assistant_text is real activity — no team-failed");
    team.kill();
  });

  // bug fix (worker-B panel never reacts): the FIRST user chat write acts as
  // the team's task dispatch — worker-B has no SDK iteration until something
  // writes it (no initialPrompt is passed at spawn), so on a chat-driven
  // task worker-B's panel sat blank forever. The first write fans out to
  // BOTH workers; follow-up chat stays worker-A-only (worker-B learns
  // follow-ups through the board).
  await t('first user chat dispatches to BOTH workers; follow-up chat routes to worker-A only', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('team-2', { cwd, task: 'T', eventsDir: dir });
    const writes = { 'worker-A': [], 'worker-B': [] };
    team.workers['worker-A'].write = (txt) => writes['worker-A'].push(txt);
    team.workers['worker-B'].write = (txt) => writes['worker-B'].push(txt);
    team.write('solve this task');
    assert.deepStrictEqual(writes['worker-A'], ['solve this task'], 'worker-A receives the first chat (task)');
    assert.deepStrictEqual(writes['worker-B'], ['solve this task'], 'worker-B receives the first chat so its panel/board-read startup actually runs');
    team.write('follow-up note');
    assert.deepStrictEqual(writes['worker-A'], ['solve this task', 'follow-up note'], 'worker-A receives follow-up chat');
    assert.deepStrictEqual(writes['worker-B'], ['solve this task'], 'worker-B gets no follow-up chat (learns via the board)');
    team.kill();
  });

  // A run-queue dispatch already woke every worker — a chat message after
  // that must NOT re-dispatch to worker-B.
  await t('chat after a dispatchTask stays worker-A only', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('team-2b', { cwd, task: 'T', eventsDir: dir });
    const writes = { 'worker-A': [], 'worker-B': [] };
    team.workers['worker-A'].write = (txt) => writes['worker-A'].push(txt);
    team.workers['worker-B'].write = (txt) => writes['worker-B'].push(txt);
    team.dispatchTask('[run:plan#1] Do it');
    team.write('quick note');
    assert.deepStrictEqual(writes['worker-A'], ['[run:plan#1] Do it', 'quick note'], 'worker-A gets both');
    assert.deepStrictEqual(writes['worker-B'], ['[run:plan#1] Do it'], 'worker-B got the dispatch only');
    team.kill();
  });

  await t('dispatchTask fans the task out to both workers', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('team-3', { cwd, task: 'T', eventsDir: dir });
    const writes = { 'worker-A': [], 'worker-B': [] };
    team.workers['worker-A'].write = (txt) => writes['worker-A'].push(txt);
    team.workers['worker-B'].write = (txt) => writes['worker-B'].push(txt);
    team.dispatchTask('[run:plan#7] Implement the CLI');
    assert.deepStrictEqual(writes['worker-A'], ['[run:plan#7] Implement the CLI']);
    assert.deepStrictEqual(writes['worker-B'], ['[run:plan#7] Implement the CLI']);
    team.kill();
  });

  await t('worker agent-events are relayed with a worker tag + team seq', async () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('team-4', { cwd, task: 'T', eventsDir: dir });
    const seen = [];
    team.on('agent-event', (e) => seen.push(e));
    team.workers['worker-A'].emit('agent-event', { type: 'assistant_text', text: 'a1' });
    team.workers['worker-B'].emit('agent-event', { type: 'assistant_text', text: 'b1' });
    team.workers['worker-A'].emit('agent-event', { type: 'assistant_text', text: 'a2' });
    assert.strictEqual(seen.length, 3);
    assert.strictEqual(seen[0].worker, 'worker-A');
    assert.strictEqual(seen[1].worker, 'worker-B');
    assert.strictEqual(seen[1].workerSeq, 2, 'team-wide monotonic seq');
    assert.strictEqual(team.buffer.length, 3, 'replay buffer filled');
    team.kill();
  });

  // bug-fix (worker-B 无响应): when worker-A publishes peer work while
  // worker-B is idle (no SDK iteration → board 'wake' can never reach
  // it), the TeamSession must kick the idle worker with a nudge so it
  // wakes, reads the board and claims. Pre-fix worker-B's column stayed
  // "● idle" with no content until the 5-minute stall watchdog fired.
  await t('publishing an open item kicks idle peer workers to read the board', async () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('team-kick', { cwd, task: 'T', eventsDir: dir });
    const writes = { 'worker-A': [], 'worker-B': [] };
    team.workers['worker-A'].write = (txt) => writes['worker-A'].push(txt);
    team.workers['worker-B'].write = (txt) => writes['worker-B'].push(txt);
    // Both workers idle (no SDK iteration) — the real-world state right
    // after worker-A's turn ends having published the split.
    // worker-A (as the author) publishes an open item for worker-B.
    team.board.publish('worker-A', [{ subject: 'AI时代求解器SOTA深度调研', detail: '深挖AI solver SOTA' }]);
    // The kick lands on the next tick (setImmediate in the handler).
    await new Promise((r) => setImmediate(r));
    assert.ok(writes['worker-B'].some((w) => w.includes('Read the board')),
      'idle worker-B got the board-kick nudge');
    assert.strictEqual(writes['worker-A'].filter((w) => w.includes('Read the board')).length, 0,
      'the publishing worker is not kicked');
    // Once worker-B claims the item, a further publish must not double-
    // kick worker-B while it holds the claim (one unfinished claim each).
    const item = team.board.queueState().find((i) => i.state === 'open');
    team.board.claim('worker-B', item.id);
    writes['worker-B'].length = 0;
    team.board.publish('worker-A', [{ subject: '第二个开放任务', detail: 'd' }]);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(writes['worker-B'].filter((w) => w.includes('Read the board')).length, 0,
      'a worker already holding a claim is not kicked again');
    team.kill();
  });

  await t('team-complete fires when the board sub-queue is all done and workers idle', async () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('team-5', { cwd, task: 'T', eventsDir: dir });
    // stub writes so no live SDK query happens
    team.workers['worker-A'].write = () => {};
    team.workers['worker-B'].write = () => {};
    let complete = 0;
    team.on('team-complete', () => complete++);
    // Simulate the Delm handoff: worker-A splits; both complete their items.
    const r1 = team.board.reserve('worker-A', 'Parser', 'write parser');
    const r2 = team.board.reserve('worker-B', 'Docs', 'write docs');
    team.board.done('worker-A', r1.item, 'parser done');
    // queue not empty yet -> no complete
    team.workers['worker-A'].emit('idle');
    assert.strictEqual(complete, 0, 'no complete while an item is still open');
    team.board.done('worker-B', r2.item, 'docs done');
    team.workers['worker-A'].emit('idle');
    team.workers['worker-B'].emit('idle');
    assert.strictEqual(complete, 1, 'team-complete once all items done + both idle');
    team.kill();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
