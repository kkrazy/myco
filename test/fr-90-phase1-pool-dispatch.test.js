// fr-90 Phase 1: SessionPool wired into queue dispatch + per-pool-
// member agent-event listener (bug-37 FIFO + bind via DI bindFns).
//
// Phase 1 scope (this file):
//   1. _spawnSession installs an agent-event listener on each pool
//      member that mirrors the bug-37 FIFO + bind logic, scoped to
//      the pool member's own queue + counter.
//   2. dispatch pushes a bug-37-shaped entry onto the pool member's
//      _activeItemQueue (with chatBound / runBound from item._chatBound
//      / _runBound).
//   3. Per-pool-member listener handles turn_start counter, buffers
//      assistant_text into queue[0], and on terminal pops popCount
//      heads (max(1, pendingTurnStarts), capped at queue.length).
//   4. After popping, calls pool.onTerminal(poolId) to free the slot
//      + drain pending dispatches.
//   5. Each popped head binds via the DI bindFns
//      (stampPlanItemRunOutcome / stampPlanItemStatus /
//      advanceRunQueue / appendAgentAiChatTurn), capturing the
//      shared buffer for variant-B distribution.
//   6. attach.js handleChatPostfixes gate: when rec.sessionPoolEnabled
//      === true + has marker + item exists in plan.json, route via
//      pool.dispatch instead of parent's session.write.
//
// Tests use a mock EventEmitter-based agent so we don't fork real
// claude subprocesses. The DI bindFns are also mocked so we can
// assert the right binding calls fired on each pop.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const sessionPoolMod = require('../server/src/sessionPool');
const { SessionPool } = sessionPoolMod;

console.log('── fr-90 Phase 1: pool dispatch + per-pool listener ──');

// ──────────────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────────────

function makeMockAgent() {
  const writes = [];
  const agent = new EventEmitter();
  agent.write = (text) => { if (agent.killed) throw new Error('dead'); writes.push(text); };
  agent.kill = () => { agent.killed = true; };
  agent._writes = writes;
  return agent;
}

function makeBindFnsMock() {
  const calls = { stampOutcome: [], stampStatus: [], advance: [], appendAgent: [] };
  const fns = {
    stampPlanItemRunOutcome: (sid, id, ev, startedAt) => calls.stampOutcome.push({ sid, id, ev, startedAt }),
    stampPlanItemStatus: (sid, id, status, summary) => calls.stampStatus.push({ sid, id, status, summary }),
    advanceRunQueue: (sid, sess, id, ev) => calls.advance.push({ sid, sessPresent: !!sess, id, ev }),
    appendAgentAiChatTurn: (sid, id, ev, buf) => calls.appendAgent.push({ sid, id, ev, buf }),
    getSessionRecord: () => null,
  };
  return { fns, calls };
}

function freshTmpCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr90-p1-'));
  fs.mkdirSync(path.join(dir, '_myco_'), { recursive: true });
  return dir;
}

function makePool(opts = {}) {
  const cwd = opts.cwd || freshTmpCwd();
  const spawned = [];
  const spawnAgent = (sessionId, opts2) => {
    const agent = opts.makeAgent ? opts.makeAgent() : makeMockAgent();
    spawned.push({ sessionId, opts: opts2, agent });
    return agent;
  };
  const bindMock = opts.bindMock || makeBindFnsMock();
  const pool = new SessionPool({
    cwd,
    parentSessionId: opts.parentSessionId || 'sess-parent',
    parentSession: opts.parentSession || { emit() {}, alive: true },
    spawnAgent,
    bindFns: bindMock.fns,
    maxSize: opts.maxSize,
    logger: opts.logger || { log() {}, warn() {}, error() {} },
  });
  return { pool, spawned, bindMock };
}

// ──────────────────────────────────────────────────────────────────────
// Per-pool-member listener — bug-37 FIFO + bind
// ──────────────────────────────────────────────────────────────────────

t('listener: dispatch pushes a bug-37-shaped entry onto pool member queue', () => {
  const { pool, spawned } = makePool();
  pool.dispatch({ id: 'fr-1', text: 't' }, '[chat:plan#fr-1] [run:plan#fr-1] hi');
  const agent = spawned[0].agent;
  assert.strictEqual(agent._activeItemQueue.length, 1);
  const entry = agent._activeItemQueue[0];
  assert.strictEqual(entry.itemId, 'fr-1');
  assert.strictEqual(entry.chatBound, true, 'default chatBound true');
  assert.strictEqual(entry.runBound, true, 'default runBound true');
  assert.strictEqual(entry._buffer, '');
});

t('listener: turn_start increments pendingTurnStarts; terminal pops + resets', () => {
  const { pool, spawned } = makePool();
  pool.dispatch({ id: 'fr-1', text: 't' }, 'text-1');
  const agent = spawned[0].agent;
  agent.emit('agent-event', { type: 'turn_start', prompt: 'text-1' });
  assert.strictEqual(agent._pendingTurnStarts, 1);
  agent.emit('agent-event', { type: 'assistant_text', text: 'hello' });
  assert.strictEqual(agent._activeItemQueue[0]._buffer, 'hello');
  agent.emit('agent-event', { type: 'turn_result', subtype: 'success',
    usage: { input_tokens: 1, output_tokens: 1 }, durationMs: 10 });
  assert.strictEqual(agent._activeItemQueue.length, 0, 'head popped');
  assert.strictEqual(agent._pendingTurnStarts, 0, 'counter reset');
});

t('listener: bindFns invoked with parentSessionId + correct args', () => {
  const { pool, spawned, bindMock } = makePool({ parentSessionId: 'sess-PARENT' });
  pool.dispatch({ id: 'fr-1', text: 't' }, 'text-1');
  const agent = spawned[0].agent;
  agent.emit('agent-event', { type: 'turn_start' });
  agent.emit('agent-event', { type: 'assistant_text', text: 'reply text' });
  agent.emit('agent-event', { type: 'turn_result', subtype: 'success',
    usage: { input_tokens: 5, output_tokens: 2 }, durationMs: 100 });
  // Both run-bound and chat-bound (default true) → all four bind
  // fns should fire (stampOutcome, advance, appendAgent — stampStatus
  // skipped on turn_result).
  assert.strictEqual(bindMock.calls.stampOutcome.length, 1);
  assert.strictEqual(bindMock.calls.stampOutcome[0].sid, 'sess-PARENT',
    'binding uses PARENT sessionId, not pool member id');
  assert.strictEqual(bindMock.calls.stampOutcome[0].id, 'fr-1');
  assert.strictEqual(bindMock.calls.advance.length, 1);
  assert.strictEqual(bindMock.calls.advance[0].sessPresent, true,
    'advanceRunQueue must be passed the parent session (for state-update + auto-dispatch)');
  assert.strictEqual(bindMock.calls.appendAgent.length, 1);
  assert.strictEqual(bindMock.calls.appendAgent[0].buf, 'reply text',
    'chat binding receives the accumulated buffer');
});

t('listener: SDK batches 3 writes → 1 turn_result → distributes to ALL 3 items (variant B)', () => {
  // The exact bug-37 repro, but at the per-pool-member level. Three
  // dispatches all routed to the SAME pool member (e.g. via dependsOn
  // chain) → each turn_start counted → on the single terminal event
  // all 3 heads pop + each gets the shared buffer.
  //
  // Note: this is NOT the typical pool flow (different items usually
  // go to different pool sessions); it's a sanity check that the
  // bug-37 fix applies per-pool-member when batching does occur
  // within one pool session (a chain of related items).
  const { pool, spawned, bindMock } = makePool({ maxSize: 5 });
  pool.dispatch({ id: 'fr-1', text: 'a' }, 'text-1');
  // Force the next 2 to reuse fr-1's session via dependsOn.
  pool.dispatch({ id: 'fr-2', text: 'b', dependsOn: ['fr-1'] }, 'text-2');
  pool.dispatch({ id: 'fr-3', text: 'c', dependsOn: ['fr-1'] }, 'text-3');
  assert.strictEqual(spawned.length, 1, 'all 3 should route to one pool member');
  const agent = spawned[0].agent;
  assert.strictEqual(agent._activeItemQueue.length, 3);
  // SDK batches: 3 turn_starts + assistant_text + 1 turn_result.
  agent.emit('agent-event', { type: 'turn_start' });
  agent.emit('agent-event', { type: 'turn_start' });
  agent.emit('agent-event', { type: 'turn_start' });
  agent.emit('agent-event', { type: 'assistant_text', text: 'batched response' });
  agent.emit('agent-event', { type: 'turn_result', subtype: 'success',
    usage: { input_tokens: 10, output_tokens: 5 }, durationMs: 50 });
  // All 3 popped + each got the shared buffer.
  assert.strictEqual(agent._activeItemQueue.length, 0);
  assert.strictEqual(bindMock.calls.stampOutcome.length, 3, 'all 3 runs stamped');
  assert.strictEqual(bindMock.calls.appendAgent.length, 3, 'all 3 aiChat appended');
  for (const c of bindMock.calls.appendAgent) {
    assert.strictEqual(c.buf, 'batched response',
      'all 3 must receive the same shared buffer (variant B)');
  }
  const stampedIds = bindMock.calls.stampOutcome.map((c) => c.id).sort();
  assert.deepStrictEqual(stampedIds, ['fr-1', 'fr-2', 'fr-3']);
});

t('listener: chat-only entry (chatBound:true runBound:false) skips run bindings', () => {
  const { pool, spawned, bindMock } = makePool();
  pool.dispatch({ id: 'fr-1', text: 't', _runBound: false }, 'text');
  const agent = spawned[0].agent;
  agent.emit('agent-event', { type: 'turn_start' });
  agent.emit('agent-event', { type: 'assistant_text', text: 'chat-only reply' });
  agent.emit('agent-event', { type: 'turn_result', subtype: 'success',
    usage: { input_tokens: 1, output_tokens: 1 }, durationMs: 10 });
  assert.strictEqual(bindMock.calls.stampOutcome.length, 0,
    'chat-only must NOT stamp runs[]');
  assert.strictEqual(bindMock.calls.advance.length, 0,
    'chat-only must NOT advance run queue');
  assert.strictEqual(bindMock.calls.appendAgent.length, 1,
    'chat-only DOES append aiChat[]');
  assert.strictEqual(bindMock.calls.appendAgent[0].buf, 'chat-only reply');
});

t('listener: run-only entry (chatBound:false runBound:true) skips chat binding', () => {
  const { pool, spawned, bindMock } = makePool();
  pool.dispatch({ id: 'fr-1', text: 't', _chatBound: false }, 'text');
  const agent = spawned[0].agent;
  agent.emit('agent-event', { type: 'turn_start' });
  agent.emit('agent-event', { type: 'assistant_text', text: 'run-only output' });
  agent.emit('agent-event', { type: 'turn_result', subtype: 'success',
    usage: { input_tokens: 1, output_tokens: 1 }, durationMs: 10 });
  assert.strictEqual(bindMock.calls.stampOutcome.length, 1, 'runs stamped');
  assert.strictEqual(bindMock.calls.advance.length, 1, 'run-queue advanced');
  assert.strictEqual(bindMock.calls.appendAgent.length, 0,
    'run-only must NOT bind to aiChat[]');
});

t('listener: iteration_aborted stamps "aborted" status (not outcome)', () => {
  const { pool, spawned, bindMock } = makePool();
  pool.dispatch({ id: 'fr-1', text: 't' }, 'text');
  const agent = spawned[0].agent;
  agent.emit('agent-event', { type: 'turn_start' });
  agent.emit('agent-event', { type: 'iteration_aborted', reason: 'kill_mid_stream' });
  assert.strictEqual(bindMock.calls.stampOutcome.length, 0);
  assert.strictEqual(bindMock.calls.stampStatus.length, 1,
    'abort must stamp synthetic status');
  assert.strictEqual(bindMock.calls.stampStatus[0].status, 'aborted');
  assert.strictEqual(bindMock.calls.advance.length, 1, 'queue still advances');
});

t('listener: fatal stamps "error" status', () => {
  const { pool, spawned, bindMock } = makePool();
  pool.dispatch({ id: 'fr-1', text: 't' }, 'text');
  const agent = spawned[0].agent;
  agent.emit('agent-event', { type: 'turn_start' });
  agent.emit('agent-event', { type: 'fatal', error: 'kaboom' });
  assert.strictEqual(bindMock.calls.stampStatus.length, 1);
  assert.strictEqual(bindMock.calls.stampStatus[0].status, 'error');
});

t('listener: terminal with empty queue frees slot without binding (defensive)', () => {
  const { pool, spawned, bindMock } = makePool();
  pool.dispatch({ id: 'fr-1', text: 't' }, 'text');
  const agent = spawned[0].agent;
  // Drain the queue first (normal terminal).
  agent.emit('agent-event', { type: 'turn_start' });
  agent.emit('agent-event', { type: 'turn_result', subtype: 'success',
    usage: { input_tokens: 1, output_tokens: 1 }, durationMs: 1 });
  // Now an UNEXPECTED extra terminal — queue is empty.
  const before = bindMock.calls.stampOutcome.length;
  agent.emit('agent-event', { type: 'turn_result', subtype: 'success' });
  assert.strictEqual(bindMock.calls.stampOutcome.length, before,
    'no extra binding on empty-queue terminal');
});

// ──────────────────────────────────────────────────────────────────────
// onTerminal drains pendingDispatches via the listener path
// ──────────────────────────────────────────────────────────────────────

t('end-to-end: at-cap dispatch queues + drains automatically on pool member terminal', () => {
  const { pool, spawned } = makePool({ maxSize: 1 });
  pool.dispatch({ id: 'fr-1', text: 'a' }, 'text-a');
  const r2 = pool.dispatch({ id: 'fr-2', text: 'b' }, 'text-b');
  assert.strictEqual(r2.reason, 'queued');
  assert.strictEqual(pool.pendingDispatches.length, 1);
  // fr-1's pool member fires turn_result → onTerminal drains fr-2.
  const agent = spawned[0].agent;
  agent.emit('agent-event', { type: 'turn_start' });
  agent.emit('agent-event', { type: 'turn_result', subtype: 'success',
    usage: { input_tokens: 1, output_tokens: 1 }, durationMs: 1 });
  assert.strictEqual(pool.pendingDispatches.length, 0,
    'pendingDispatches drained after terminal');
  // fr-2 now busy on the same pool member.
  assert.strictEqual(pool.affinity.get('fr-2'), pool.affinity.get('fr-1'));
  assert.strictEqual(agent._writes[1], 'text-b', 'fr-2 text was actually written');
});

// ──────────────────────────────────────────────────────────────────────
// attach.js wiring — static guards on the pool gate
// ──────────────────────────────────────────────────────────────────────

const ATTACH_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

t('attach.js: _getOrCreatePool helper exists + is exported', () => {
  assert.ok(/function\s+_getOrCreatePool\s*\(/.test(ATTACH_SRC),
    '_getOrCreatePool must be defined');
  assert.ok(/_getOrCreatePool\b/.test(ATTACH_SRC.slice(ATTACH_SRC.lastIndexOf('module.exports'))),
    '_getOrCreatePool must be in module.exports');
});

t('attach.js: handleChatPostfixes gates pool dispatch on rec.sessionPoolEnabled', () => {
  // The gate: when rec.sessionPoolEnabled === true + has marker +
  // item exists → pool.dispatch + return (skips parent FIFO + write).
  const idx = ATTACH_SRC.search(/session\.write\(agentText\)/);
  assert.ok(idx > -1, 'session.write call must exist');
  // Window before session.write must contain the pool gate.
  const win = ATTACH_SRC.slice(Math.max(0, idx - 3000), idx);
  assert.ok(/sessionPoolEnabled/.test(win),
    'gate must read rec.sessionPoolEnabled');
  assert.ok(/pool\.dispatch\s*\(/.test(win),
    'gate must call pool.dispatch');
});

t('attach.js: pool gate wires bindFns via _getOrCreatePool', () => {
  const idx = ATTACH_SRC.search(/function\s+_getOrCreatePool\s*\(/);
  const win = ATTACH_SRC.slice(idx, idx + 2000);
  for (const fn of ['stampPlanItemRunOutcome', 'stampPlanItemStatus',
                    'advanceRunQueue', 'appendAgentAiChatTurn']) {
    assert.ok(new RegExp('\\b' + fn + '\\b').test(win),
      '_getOrCreatePool must wire ' + fn + ' into bindFns');
  }
});

t('attach.js: pool path returns early — does NOT push to parent FIFO or session.write', () => {
  // The pool gate must `return` after pool.dispatch so the legacy
  // parent FIFO push + session.write below are skipped. Otherwise
  // the dispatch would double-bind (once via pool, once via parent).
  const idx = ATTACH_SRC.search(/pool\.dispatch\s*\(/);
  assert.ok(idx > -1, 'pool.dispatch call must exist');
  const win = ATTACH_SRC.slice(idx, idx + 600);
  assert.ok(/return\s*;/.test(win),
    'pool dispatch path must return early (skip parent FIFO + write)');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
