// team-split-view — server-side contract for the dual-worker split view.
//
// Covers the three server surfaces the split view depends on:
//  1. DelmBoard.append() emits a 'change' event with the log-row shape.
//  2. TeamSession relays board changes as state-update {kind:'board'}
//     frames (event + snapshot), filtering read/wait/session noise.
//  3. TeamSession tags worker state-updates (tool-progress) with the
//     owning worker — pre-fix the two workers collided in one client slot.
//  4. boardSnapshot() exposes queue/notes/status/sessions WITHOUT the
//     `reader` field and WITHOUT appending a 'read' row to the log.
//
// The WS-frame shape consumed by web/public/app.js (_handleTeamInfoFrame /
// _applyStateUpdate kind:'board') is locked by the static checks in
// test.sh plus these unit tests.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DelmBoard } = require('../server/src/board.js');
const { TeamSession } = require('../server/src/team-session.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-split-'));
}

function makeTeam(id) {
  const dir = tmpdir();
  const cwd = path.join(dir, 'wks');
  fs.mkdirSync(cwd, { recursive: true });
  const team = new TeamSession(id, { cwd, task: 'T', eventsDir: dir });
  // Never touch the live SDK: stub writes so worker .write() is inert.
  team.workers['worker-A'].write = () => {};
  team.workers['worker-B'].write = () => {};
  return team;
}

async function main() {
  console.log('── team-split-view: board change events + team relays ──');

  await t('board append() emits change with the log-row shape', () => {
    const board = new DelmBoard({ actors: ['worker-A', 'worker-B'] });
    const changes = [];
    board.on('change', (row) => changes.push(row));
    board.reserve('worker-A', 'Parser', 'write parser');
    assert.ok(changes.length >= 2, 'reserve produced item+claim changes');
    const item = changes.find((c) => c.kind === 'item');
    assert.ok(item, 'an item change fired');
    assert.strictEqual(item.actor, 'worker-A', 'change carries actor');
    assert.ok(item.payload && item.payload.id, 'change carries payload.id');
    assert.ok(typeof item.sequence === 'number', 'change carries sequence');
  });

  await t('TeamSession relays board changes as kind:board with snapshot, filtering read/wait/session', () => {
    const team = makeTeam('tsv-relay');
    const frames = [];
    team.on('state-update', (p) => frames.push(p));
    const r = team.board.reserve('worker-A', 'Parser', 'write parser');
    team.board.done('worker-A', r.item, 'parser done');
    // A worker read produces a 'read' log row (via served()) — must NOT
    // produce a board frame.
    const before = frames.length;
    team.board.served('worker-B', 'read');
    assert.strictEqual(frames.length, before, 'read rows are filtered out');

    const boardFrames = frames.filter((f) => f.kind === 'board');
    assert.ok(boardFrames.length >= 3, 'item/claim/done/status each fired a board frame');
    const last = boardFrames[boardFrames.length - 1];
    assert.ok(last.event && last.event.actor === 'worker-A', 'frame carries the raw event');
    assert.ok(last.snapshot && Array.isArray(last.snapshot.queue), 'frame carries snapshot.queue');
    assert.ok(last.snapshot.queue.some((i) => i.state === 'done'), 'snapshot reflects done state');
    team.kill();
  });

  await t('team worker state-updates (tool-progress) carry the worker tag', () => {
    const team = makeTeam('tsv-progress');
    const frames = [];
    team.on('state-update', (p) => frames.push(p));
    team.workers['worker-A'].emit('state-update', { kind: 'tool-progress', open: [{ id: '1', name: 'Bash' }] });
    team.workers['worker-B'].emit('state-update', { kind: 'tool-progress', open: [] });
    const tp = frames.filter((f) => f.kind === 'tool-progress');
    assert.strictEqual(tp.length, 2, 'both tool-progress frames relayed');
    assert.strictEqual(tp[0].worker, 'worker-A', 'worker-A frame tagged');
    assert.strictEqual(tp[1].worker, 'worker-B', 'worker-B frame tagged');
    assert.ok(tp[0].open && tp[0].open.length === 1, 'open list preserved');
    team.kill();
  });

  await t('boardSnapshot() has no reader field and does not append a read row', () => {
    const team = makeTeam('tsv-snapshot');
    team.board.reserve('worker-A', 'Parser', 'write parser');
    const seqBefore = team.board.lastSequence;
    const snap = team.boardSnapshot();
    assert.strictEqual(snap.reader, undefined, 'no reader field on the UI snapshot');
    assert.strictEqual(team.board.lastSequence, seqBefore, 'snapshot did not append a read row');
    assert.ok(Array.isArray(snap.queue) && snap.queue.length === 1, 'queue derived');
    assert.ok(Array.isArray(snap.sessions) && snap.sessions.length === 2, 'sessions derived');
    assert.strictEqual(snap.sequence, seqBefore, 'sequence echoes lastSequence');
    team.kill();
  });

  // ---- shadow-lane wiring (/run-n2, /compare, queue ◓ button) ----
  //
  // startN2Lane must announce the lane to the client (team-info via
  // state-update) and ship the lane's board snapshots + tool-progress
  // through the same state-update channel, so the split view works for
  // ephemeral lanes exactly as it does for a persistent agent-n2
  // session. The main session is a stub EventEmitter standing in for
  // the AgentSession that owns the attached WS.

  await t('startN2Lane announces team-info + bridges board state-updates to the main session', () => {
    const events = require('events');
    const main = new events.EventEmitter();
    const frames = [];
    main.on('state-update', (p) => frames.push(p));
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });

    const cl = require('../server/src/compare-lanes');
    const rec = cl.startN2Lane({ cwd, user: 'u', task: 'Do it', dir, mainSession: main, mainSessionId: 'ms-1', laneTag: null });
    const lane = rec.lane;
    try {
      const info = frames.find((f) => f.kind === 'team-info');
      assert.ok(info, 'lane announced itself via state-update team-info');
      assert.strictEqual(info.teamLane, true, 'team-info is tagged teamLane (ephemeral lane)');
      assert.ok(Array.isArray(info.roster) && info.roster.length === 2, 'roster shipped');
      assert.ok(info.board && Array.isArray(info.board.queue), 'initial board snapshot shipped');

      // A board change on the lane must flow through the bridge with the
      // snapshot attached — this is what feeds the split view's middle
      // column while /run-n2 runs.
      lane.board.reserve('worker-A', 'Parser', 'write parser');
      const boardFrames = frames.filter((f) => f.kind === 'board');
      assert.ok(boardFrames.length >= 1, 'board change bridged as kind:board');
      assert.strictEqual(boardFrames[boardFrames.length - 1].teamLane, true, 'board frame tagged teamLane');
      assert.ok(boardFrames[boardFrames.length - 1].snapshot, 'bridged board frame carries a snapshot');
      // worker tool-progress must be bridged too (per-column status).
      lane.workers['worker-B'].emit('state-update', { kind: 'tool-progress', open: [] });
      const tp = frames.filter((f) => f.kind === 'tool-progress');
      assert.strictEqual(tp.length, 1, 'tool-progress bridged');
      assert.strictEqual(tp[0].worker, 'worker-B', 'bridged tool-progress keeps its worker tag');
    } finally {
      try { lane.kill(); } catch {}
    }
  });

  await t('startN2Lane emits team-lane-end on lane terminal', () => {
    const events = require('events');
    const main = new events.EventEmitter();
    const frames = [];
    main.on('state-update', (p) => frames.push(p));
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });

    const cl = require('../server/src/compare-lanes');
    const rec = cl.startN2Lane({ cwd, user: 'u', task: 'Do it', dir, mainSession: main, mainSessionId: 'ms-2', laneTag: null });
    const lane = rec.lane;
    try {
      assert.ok(!frames.some((f) => f.kind === 'team-lane-end'), 'no end frame before terminal');
      // Simulate the terminal signal the real flow fires on team-complete
      // / team-failed / worker turn_result.
      lane.emit('team-complete', {});
      assert.ok(frames.some((f) => f.kind === 'team-lane-end'), 'team-lane-end shipped on terminal');
    } finally {
      try { lane.kill(); } catch {}
    }
  });

  // ---- reattach handshake (refresh / session re-switch) ----
  //
  // The "buttons disappear after refresh" regression: the lane's
  // team-info is a one-shot live emit, so a client that attaches LATER
  // (page refresh, session re-switch, second device) missed it and the
  // split view never came back. The fix has three legs, each locked
  // below: lane worker events land in main.buffer (replay rebuilds the
  // columns), session._teamLane records the lane for the attach-time
  // re-announce, and _shipTeamInfoOnAttach ships the right frame
  // BEFORE the replay.

  await t('bridged lane worker events land in the main session replay buffer', () => {
    const events = require('events');
    const main = new events.EventEmitter();
    main.buffer = [];                     // AgentSession's replay ring
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const cl = require('../server/src/compare-lanes');
    const rec = cl.startN2Lane({ cwd, user: 'u', task: 'Do it', dir, mainSession: main, mainSessionId: 'ms-b', laneTag: null });
    const lane = rec.lane;
    try {
      // dispatchTask's own turn_start rows land in the buffer too —
      // count by content, not absolute length.
      const before = main.buffer.length;
      assert.ok(before >= 0, 'buffer is an array');
      // A worker event (as TeamSession._relay stamps it).
      lane.emit('agent-event', { type: 'assistant_text', content: 'hi', worker: 'worker-A', seq: 1 });
      const inBuf = main.buffer.filter((ev) => ev.worker === 'worker-A' && ev.type === 'assistant_text');
      assert.strictEqual(inBuf.length, 1, 'worker event mirrored into main.buffer for agent-replay');
      // Non-worker events (bridged single-lane events, main session
      // own events) must NOT be pushed by the team bridge.
      lane.emit('agent-event', { type: 'assistant_text', content: 'solo' });
      const solo = main.buffer.filter((ev) => ev.type === 'assistant_text' && ev.content === 'solo');
      assert.strictEqual(solo.length, 0, 'un-tagged events are not mirrored');
    } finally {
      try { lane.kill(); } catch {}
    }
  });

  await t('bridged worker events mirror RE-STAMPED (main seq) + persist to the main events.jsonl', () => {
    const events = require('events');
    const main = new events.EventEmitter();
    main.buffer = [];
    // Capture what the bridge hands to the main session's persist path —
    // in production this is AgentSession._persistEventToDisk appending to
    // <myco>/events.jsonl (which hydrate reads back on server restart).
    const persisted = [];
    main._persistEventToDisk = (ev) => persisted.push(ev);
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const cl = require('../server/src/compare-lanes');
    const rec = cl.startN2Lane({ cwd, user: 'u', task: 'Do it', dir, mainSession: main, mainSessionId: 'ms-b2', laneTag: null });
    const lane = rec.lane;
    try {
      // A worker event carrying the worker-local seq the bridge must
      // overwrite with the MAIN session's monotonic counter. dispatchTask
      // already mirrors its own worker turn_start rows — filter by
      // content, not absolute count.
      lane.emit('agent-event', { type: 'assistant_text', content: 'hi', worker: 'worker-A', seq: 1, workerSeq: 1 });
      const hit = persisted.filter((ev) => ev.content === 'hi' && ev.worker === 'worker-A');
      assert.strictEqual(hit.length, 1, 're-stamped copy persisted for post-restart replay');
      const mirrored = hit[0];
      assert.strictEqual(typeof mirrored.seq, 'number', 'mirrored event carries a main-session seq');
      assert.notStrictEqual(mirrored.seq, 1, 'main seq re-stamped — NOT the worker-local value 1 (0 = unknown-session stub is fine, prod ids are registered)');
      assert.strictEqual(mirrored.workerSeq, undefined, 'worker-local seq stripped from the mirror');
      assert.strictEqual(mirrored.worker, 'worker-A', 'worker tag preserved for column routing');
      // The buffered copy must be the SAME re-stamped shape (old bug:
      // buffer held the RAW ev with worker-local seq, so afterSeq
      // catch-up filtered it out and replay ordering broke).
      const inBuf = main.buffer.filter((ev) => ev.worker === 'worker-A' && ev.type === 'assistant_text');
      assert.strictEqual(inBuf.length, 1, 'mirrored into main.buffer');
      assert.strictEqual(inBuf[0].seq, mirrored.seq, 'buffer copy uses the SAME main seq as the persisted copy');
      // Non-worker events still skip the mirror (state signals, not pane content).
      lane.emit('agent-event', { type: 'assistant_text', content: 'solo' });
      assert.strictEqual(persisted.filter((ev) => ev.content === 'solo').length, 0, 'un-tagged events are not persisted');
    } finally {
      try { lane.kill(); } catch {}
    }
  });

  await t('startN2Lane records _teamLane on the main session; ended flips on terminal', () => {
    const events = require('events');
    const main = new events.EventEmitter();
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const cl = require('../server/src/compare-lanes');
    const rec = cl.startN2Lane({ cwd, user: 'u', task: 'Do it', dir, mainSession: main, mainSessionId: 'ms-c', laneTag: null });
    const lane = rec.lane;
    try {
      assert.ok(main._teamLane && main._teamLane.lane === lane, 'lane recorded on the main session');
      assert.strictEqual(main._teamLane.ended, false, 'lane starts live');
      lane.emit('team-complete', {});
      assert.strictEqual(main._teamLane.ended, true, 'ended flips on terminal (attach then ships team-lane-end)');
    } finally {
      try { lane.kill(); } catch {}
    }
  });

  await t('_shipTeamInfoOnAttach: live lane re-announces, ended lane ships frozen team-info{ended:true}, catch-up ships end', () => {
    const events = require('events');
    const attachMod = require('../server/src/attach.js');
    const ship = attachMod.__test ? attachMod.__test._shipTeamInfoOnAttach : null;
    assert.strictEqual(typeof ship, 'function', '_shipTeamInfoOnAttach must be exported via attach.js __test (reattach regression)');
    // The helper ships over a raw ws-like { send, readyState, OPEN } —
    // the real `ws` object carries OPEN as an instance-visible constant
    // and the helper compares against it, so the stub must too.
    function fakeWs() {
      return {
        OPEN: 1,
        readyState: 1,                    // === OPEN
        sent: [],
        send(s) { this.sent.push(JSON.parse(s)); },
      };
    }
    // Case 1: live shadow lane → state-update team-info (teamLane) BEFORE replay.
    {
      const main = new events.EventEmitter();
      const dir = tmpdir();
      const cwd = path.join(dir, 'wks');
      fs.mkdirSync(cwd, { recursive: true });
      const cl = require('../server/src/compare-lanes');
      const rec = cl.startN2Lane({ cwd, user: 'u', task: 'T', dir, mainSession: main, mainSessionId: 'ms-d', laneTag: null });
      try {
        const ws = fakeWs();
        ship(main, ws, 'ms-d', null);     // initial attach: afterSeq = null
        const info = ws.sent.find((f) => f.kind === 'team-info' || f.t === 'team-info');
        assert.ok(info, 'live lane re-announced on attach');
        assert.strictEqual(info.teamLane, true, 'reattach team-info is tagged teamLane');
        assert.ok(info.board && Array.isArray(info.board.queue), 'reattach carries a fresh board snapshot');
        // Ended-lane INITIAL attach: rebuild the frozen view — team-info
        // with ended:true (columns re-populate from the persisted
        // agent-replay that follows; the client paints the ended badge).
        rec.lane.emit('team-complete', {});
        const ws2 = fakeWs();
        ship(main, ws2, 'ms-d', null);
        const endedInfo = ws2.sent.find((f) => f.kind === 'team-info');
        assert.ok(endedInfo, 'ENDED lane re-announces team-info on initial attach (frozen-view rebuild)');
        assert.strictEqual(endedInfo.ended, true, 'ended-lane team-info carries ended:true');
        assert.strictEqual(endedInfo.teamLane, true, 'ended-lane team-info stays teamLane-scoped');
        assert.ok(endedInfo.board && Array.isArray(endedInfo.board.queue), 'ended-lane team-info ships the final board snapshot');
        assert.ok(!ws2.sent.some((f) => f.kind === 'team-lane-end'), 'initial attach of an ended lane does NOT ship team-lane-end (the info frame carries the state)');
        // Catch-up (afterSeq) on the ENDED lane: the client held the live
        // view through the disconnect and only missed the end transition.
        const ws2b = fakeWs();
        ship(main, ws2b, 'ms-d', 42);
        assert.ok(ws2b.sent.some((f) => f.kind === 'team-lane-end'), 'catch-up on an ended lane ships team-lane-end (the only missed transition)');
        // Catch-up on a LIVE lane must NOT re-ship team-info (client
        // already holds it) — build a fresh live lane for this check.
        const main2 = new events.EventEmitter();
        const rec2 = cl.startN2Lane({ cwd, user: 'u', task: 'T2', dir: path.join(dir, 'r2'), mainSession: main2, mainSessionId: 'ms-e', laneTag: null });
        try {
          const ws3 = fakeWs();
          ship(main2, ws3, 'ms-e', 42);   // catch-up reconnect
          assert.ok(!ws3.sent.some((f) => f.kind === 'team-info'), 'catch-up on a live lane skips team-info (already held)');
        } finally { try { rec2.lane.kill(); } catch {} }
      } finally {
        try { rec.lane.kill(); } catch {}
      }
    }
    // Case 2: real agent-n2 session → t:'team-info' frame shape.
    {
      const team = makeTeam('tsv-reattach-n2');
      const ws = fakeWs();
      ship(team, ws, 'tsv-reattach-n2', null);
      const info = ws.sent.find((f) => f.t === 'team-info');
      assert.ok(info, 'real agent-n2 attach ships t:team-info');
      assert.strictEqual(info.teamLane, undefined, 'real session team-info is NOT teamLane');
      assert.ok(info.board && Array.isArray(info.board.queue), 'real session team-info carries board snapshot');
      team.kill();
    }
    // Case 3: plain single-agent session with no lane → nothing shipped.
    {
      const plain = new events.EventEmitter();
      const ws = fakeWs();
      ship(plain, ws, 'ms-plain', null);
      assert.strictEqual(ws.sent.length, 0, 'plain session attach ships no team frames');
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
