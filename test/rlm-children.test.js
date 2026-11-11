// RLM hard implementation — children.js (spawn / collect / depth /
// fold). myco-rlm-design.md §4.2 / §7: spawn writes the ledger, depth
// >= MAX throws DepthLimitError, collect folds ONLY the answer (never
// the transcript). The real spawn needs the SDK, so spawnAgent is
// stubbed via require.cache (same pattern as rlm-mode.test.js Group C).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-children-'));
}

// Stub agents/rlm's spawnAgent dependency (agent-session.js) with a
// fake that records the opts and returns an EventEmitter-ish session.
function stubSpawnAgent() {
  const calls = [];
  const modPath = require.resolve('../server/src/agent-session');
  function FakeSession(sessionId, opts) {
    EventEmitter.call(this);
    this.sessionId = sessionId;
    this.spawnOpts = opts;
    this.systemPrompt = opts.systemPrompt || null;
    this.writes = [];
    this.killed = false;
    this.alive = true;
  }
  require('util').inherits(FakeSession, EventEmitter);
  FakeSession.prototype.write = function (text) { this.writes.push(text); };
  FakeSession.prototype.kill = function () { this.killed = true; this.alive = false; };
  const stub = { AgentSession: FakeSession, spawnAgent: (id, opts) => { const s = new FakeSession(id, opts); calls.push(s); return s; }, __calls: calls };
  require.cache[modPath] = { exports: stub, id: modPath, filename: modPath, loaded: true };
  return stub;
}

// children.js caches _children module-globally — load a FRESH copy per
// test by clearing the module from the cache.
function freshChildren() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('agents', 'rlm'))) delete require.cache[k];
  }
  return require('../server/src/agents/rlm/children');
}

console.log('── RLM hard impl: children (spawn/collect/depth) ──');

t('spawnChild validates: empty prompt rejected, name >64 rejected', () => {
  const children = freshChildren();
  assert.throws(() => children.normalizeSpawnArgs({ prompt: '   ' }),
    /non-empty/, 'empty prompt rejected');
  assert.throws(() => children.normalizeSpawnArgs({ prompt: 'x', name: 'n'.repeat(65) }),
    (e) => e.name === 'InvalidNameError', '65-char name rejected');
  assert.deepStrictEqual(
    children.normalizeSpawnArgs({ prompt: ' find refs ', name: ' finder ' }),
    { task: 'find refs', name: 'finder', model: null, depth: 0 },
    'normalize trims prompt + name');
});

t('spawnChild at depth >= MAX_DEPTH throws DepthLimitError (runtime recursion cap)', () => {
  stubSpawnAgent();
  const children = freshChildren();
  const cwd = tmpCwd();
  assert.throws(
    () => children.spawnChild({ parentSessionId: 'p', cwd, prompt: 'x', depth: children.MAX_DEPTH }),
    (e) => e.name === 'DepthLimitError' && e.depth === children.MAX_DEPTH,
    'depth 3 spawn must throw DepthLimitError (MAX_DEPTH=3 hard constraint)');
  assert.strictEqual(children.MAX_DEPTH, 3, 'design §4.2: depth cap is 3');
});

t('spawnChild spawns a shadow AgentSession, writes the ledger, and dispatches the task', () => {
  const stub = stubSpawnAgent();
  const children = freshChildren();
  const cwd = tmpCwd();
  const r = children.spawnChild({ parentSessionId: 'p1', cwd, prompt: 'grep the repo', name: 'finder', depth: 0 });
  assert.ok(r.rlmChildId.startsWith('p1-rlm-c'), `child id derives from parent (${r.rlmChildId})`);
  assert.strictEqual(r.name, 'finder');
  const sess = stub.__calls[0];
  assert.ok(sess, 'a session was spawned');
  assert.strictEqual(sess.spawnOpts.eventsFile.includes(r.rlmChildId), true,
    'child writes its own events journal (isolated)');
  assert.strictEqual(sess.spawnOpts.autonomousPermission, true,
    'background child auto-approves tools (never hang on a permission menu)');
  assert.strictEqual(sess.writes.length, 1, 'task dispatched via write()');
  assert.strictEqual(sess.writes[0], 'grep the repo', 'the spawn prompt is the task');
  // Ledger row.
  const ledger = require('../server/src/agents/rlm/ledger');
  const rows = ledger.readAll(cwd);
  assert.strictEqual(rows.length, 1, 'spawn wrote exactly one ledger row');
  assert.strictEqual(rows[0].kind, 'spawn');
  assert.strictEqual(rows[0].childSessionId, r.rlmChildId);
  assert.strictEqual(rows[0].depth, 1, 'child depth = parent depth + 1');
});

t('collect folds ONLY the answer — last assistant_text, never the transcript', () => {
  stubSpawnAgent();
  const children = freshChildren();
  const cwd = tmpCwd();
  const r = children.spawnChild({ parentSessionId: 'p1', cwd, prompt: 'task', depth: 0 });
  const sess = require.cache[require.resolve('../server/src/agent-session')].exports.__calls[0];
  // Child stream: tools + texts + terminal.
  sess.emit('agent-event', { type: 'tool_use', name: 'Bash' });
  sess.emit('agent-event', { type: 'assistant_text', content: 'first partial' });
  sess.emit('agent-event', { type: 'assistant_text', content: 'FINAL ANSWER: 42 refs found' });
  sess.emit('agent-event', { type: 'turn_result', subtype: 'success' });
  return children.collectChildren([r.rlmChildId], { timeoutMs: 0, intervalMs: 10, capMs: 2000 }).then((res) => {
    assert.strictEqual(res.length, 1, 'one result per id');
    const out = res[0];
    assert.strictEqual(out.status, 'done', 'turn_result → done');
    assert.ok(out.answerPreview.startsWith('FINAL ANSWER'), 'fold keeps the LAST assistant text');
    assert.strictEqual(out.answerPreview.includes('tool_use'), false,
      'collect NEVER folds tool events (transcript stays out of the parent context)');
    assert.strictEqual(out.answerPreview.includes('first partial'), false,
      'earlier partial texts are dropped — only the final answer folds');
    assert.ok(Number.isFinite(out.durationMs), 'duration measured');
    console.log('  ✓ (async) collect folds ONLY the answer — last assistant_text, never the transcript');
    passed++; failed -= 0;
  }).catch((err) => { console.log('  ✗ async collect — ' + err); failed++; });
});

// The async test above runs its assertions in a promise; keep the
// process alive long enough for it to settle before printing totals.
setTimeout(() => {
  // 2026-10-23 audit regressions: answer capture reads the REAL
  // agent-session payload ({type:'assistant_text', text}) — the old
  // handler read ev.content and folded back NOTHING on live sessions.
  t('answer capture reads ev.text (real agent-session assistant_text payload)', () => {
    stubSpawnAgent();
    const children = freshChildren();
    const cwd = tmpCwd();
    const r = children.spawnChild({ parentSessionId: 'p1', cwd, prompt: 'task', depth: 0 });
    const sess = require.cache[require.resolve('../server/src/agent-session')].exports.__calls[0];
    sess.emit('agent-event', { type: 'assistant_text', text: 'REAL PAYLOAD ANSWER' });
    sess.emit('agent-event', { type: 'turn_result', subtype: 'success' });
    return children.collectChildren([r.rlmChildId], { timeoutMs: 0, intervalMs: 10, capMs: 2000 }).then((res) => {
      assert.strictEqual(res[0].status, 'done', 'turn_result → done');
      assert.ok(res[0].answerPreview && res[0].answerPreview.includes('REAL PAYLOAD ANSWER'),
        'collect must fold the assistant_text.text payload (regression: old code read ev.content and lost it)');
      console.log('  ✓ (async) answer capture reads ev.text payload');
    });
  });

  // Regression: foldAnswer's terminal fallback used terminalEv.summary
  // (a field turn_result never carries). It must fall back to the SDK
  // result text so an error-status child still folds a usable answer.
  t('foldAnswer terminal fallback reads turn_result.result, not the nonexistent .summary', () => {
    const children = freshChildren();
    const row = { answer: null, terminalEv: { type: 'turn_result', subtype: 'success', result: 'SDK RESULT TEXT' } };
    const folded = children.foldAnswer(row);
    assert.strictEqual(folded.answerPreview, 'SDK RESULT TEXT',
      'turn_result.result is the terminal fallback answer (regression: old code read .summary)');
    const none = children.foldAnswer({ answer: null, terminalEv: null });
    assert.strictEqual(none.answerPreview, null, 'no answer + no terminal → null');
  });

  // Regression: the depth note used to be appended AFTER spawnRlmAgent
  // returned via a nonexistent _applySystemPromptSuffix — the child's
  // first query() never saw it. It must arrive composed in the
  // systemPrompt the AgentSession constructor receives.
  t('spawnChild composes the depth note INTO the child systemPrompt (pre-query)', () => {
    const stub = stubSpawnAgent();
    freshChildren();
    const cwd = tmpCwd();
    const children = require('../server/src/agents/rlm/children');
    children.spawnChild({ parentSessionId: 'p1', cwd, prompt: 'task', depth: 0 });
    const sess = stub.__calls[0];
    assert.ok(sess.spawnOpts.systemPrompt.includes('RLM SUB-AGENT'),
      'depth identity composed into systemPrompt (regression: old post-spawn suffix never reached query())');
    assert.ok(sess.spawnOpts.systemPrompt.includes('depth 1'),
      'depth note names the child depth');
    assert.ok(sess.spawnOpts.systemPrompt.includes('rlm_eval'),
      'RLM contract prompt (rlm_eval teaching) is still present alongside the note');
  });

  // stats (task req c): spawn + collect feed the usage counters, and
  // savedChars estimates the context the parent never saw.
  t('stats: spawn/collect counted, savedChars ≥ 0 and reflects UI-only traffic', () => {
    stubSpawnAgent();
    freshChildren();
    const stats = require('../server/src/agents/rlm/stats');
    const children = require('../server/src/agents/rlm/children');
    const cwd = tmpCwd();
    const r = children.spawnChild({ parentSessionId: 'p1', cwd, prompt: 'task', depth: 0 });
    const sess = require.cache[require.resolve('../server/src/agent-session')].exports.__calls[0];
    sess.emit('agent-event', { type: 'tool_use', name: 'Bash' });
    sess.emit('agent-event', { type: 'assistant_text', text: 'ANSWER 30ch....................' });
    sess.emit('agent-event', { type: 'turn_result', subtype: 'success' });
    return children.collectChildren([r.rlmChildId], { timeoutMs: 0, intervalMs: 10, capMs: 2000 }).then(() => {
      const s = stats.getStats('p1');
      assert.strictEqual(s.spawns, 1, 'one spawn recorded');
      assert.strictEqual(s.collects, 1, 'one collect recorded');
      assert.ok(s.childEventsChars > 0, 'child events counted as UI-only traffic');
      assert.ok(s.savedChars >= 0, 'saved chars floored at 0');
      assert.ok(typeof stats.statsLine('p1') === 'string' && stats.statsLine('p1').includes('RLM'),
        'statsLine renders a human-readable summary');
      console.log('  ✓ (async) stats counters + savedChars');
    });
  });

  // timeout path: collect with a short timeout returns status running
  t('collect timeout: unsettled children come back with status running', () => {
    stubSpawnAgent();
    const children = freshChildren();
    const cwd = tmpCwd();
    const r = children.spawnChild({ parentSessionId: 'p1', cwd, prompt: 'task', depth: 0 });
    // no events → child never settles
    return children.collectChildren([r.rlmChildId], { timeoutMs: 50, intervalMs: 10, capMs: 1000 }).then((res) => {
      assert.strictEqual(res[0].status, 'running', 'timeout returns running (not done/error)');
      assert.strictEqual(res[0].answerPreview, null, 'no answer yet');
      console.log('  ✓ (async) collect timeout: unsettled children come back with status running');
    });
  });

  t('deleteChild kills the session + writes a ledger delete(reason=user)', () => {
    stubSpawnAgent();
    const children = freshChildren();
    const cwd = tmpCwd();
    const r = children.spawnChild({ parentSessionId: 'p1', cwd, prompt: 'task', depth: 0 });
    const sess = require.cache[require.resolve('../server/src/agent-session')].exports.__calls[0];
    assert.strictEqual(children.deleteChild(r.rlmChildId, cwd, 'user'), true, 'delete returns true for a live child');
    assert.strictEqual(sess.killed, true, 'session killed');
    const ledger = require('../server/src/agents/rlm/ledger');
    const rows = ledger.readAll(cwd);
    assert.strictEqual(rows.length, 2, 'spawn + delete rows');
    assert.strictEqual(rows[1].kind, 'delete');
    assert.strictEqual(rows[1].reason, 'user');
    assert.strictEqual(children.deleteChild('nope', cwd), false, 'unknown id → false');
  });

  t('teardownChildrenOf deletes only that parent\'s children (reason=parent_teardown)', () => {
    stubSpawnAgent();
    const children = freshChildren();
    const cwd = tmpCwd();
    const a = children.spawnChild({ parentSessionId: 'pa', cwd, prompt: 't', depth: 0 });
    const b = children.spawnChild({ parentSessionId: 'pb', cwd, prompt: 't', depth: 0 });
    children.teardownChildrenOf('pa', cwd);
    const roster = children.listChildren();
    assert.ok(roster.some((c) => c.rlmChildId === b.rlmChildId), 'other parent\'s child survives');
    assert.ok(!roster.some((c) => c.rlmChildId === a.rlmChildId), 'parent pa child deleted');
    const ledger = require('../server/src/agents/rlm/ledger');
    const del = ledger.readAll(cwd).filter((x) => x.kind === 'delete');
    assert.strictEqual(del.length, 1);
    assert.strictEqual(del[0].reason, 'parent_teardown');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}, 400);
