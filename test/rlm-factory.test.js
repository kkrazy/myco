// RLM hard implementation — factory.js (Factory 状态机编排, P3).
// myco-rlm-design.md §3/§6 P3: declarative DAG → compiled machine,
// fail policies, hard caps, execution through children.js with a stubbed
// spawnAgent (same require.cache pattern as rlm-children.test.js).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

let passed = 0, failed = 0;
const results = [];
function t(name, fn) {
  const p = Promise.resolve().then(fn).then(() => { console.log('  ✓ ' + name); passed++; })
    .catch((err) => { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; });
  results.push(p);
}

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-factory-'));
}

// Fresh module copy (children.js/factory.js cache module-global state).
function fresh(mod) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('agents', 'rlm'))) delete require.cache[k];
  }
  return require(`../server/src/agents/rlm/${mod}`);
}

// ── compile-time validation (pure, no I/O) ──────────────────────────────

t('compileFactory rejects structural errors with FactorySpecError', async () => {
  const f = fresh('factory');
  assert.throws(() => f.compileFactory(null), (e) => e.name === 'FactorySpecError', 'null spec rejected');
  assert.throws(() => f.compileFactory({ nodes: [] }), /non-empty/, 'empty nodes rejected');
  assert.throws(() => f.compileFactory({ nodes: [{ id: 'a', prompt: 'x', deps: ['ghost'] }] }),
    /unknown node ghost/, 'unknown dep rejected');
  assert.throws(() => f.compileFactory({ nodes: [
    { id: 'a', prompt: 'x', deps: ['b'] }, { id: 'b', prompt: 'y', deps: ['a'] },
  ] }), /cycle/, 'cycle rejected');
  assert.throws(() => f.compileFactory({ nodes: [
    { id: 'a', prompt: 'x' }, { id: 'a', prompt: 'y' },
  ] }), /duplicate node id/, 'duplicate id rejected');
  assert.throws(() => f.compileFactory({ nodes: [{ id: 'a', prompt: '' }] }), /non-empty/, 'empty prompt rejected');
  assert.throws(() => f.compileFactory({ nodes: [{ id: 'a', prompt: 'x', retries: 11 }] }),
    /MAX_RETRIES/, 'retries over cap rejected');
  assert.throws(() => f.compileFactory({ nodes: [{ id: 'a', prompt: 'x' }], maxParallel: 65 }),
    /MAX_PARALLEL/, 'maxParallel over cap rejected');
  assert.throws(() => f.compileFactory({ nodes: [{ id: 'a', prompt: 'x' }], failPolicy: 'bogus' }),
    /failPolicy/, 'unknown failPolicy rejected');
});

t('compileFactory enforces MAX_NODES=1024 (prime parity) and produces a machine', async () => {
  const f = fresh('factory');
  assert.strictEqual(f.MAX_NODES, 1024, 'design §1: MAX_NODES=1024');
  assert.strictEqual(f.MAX_RETRIES, 10, 'design §1: MAX_RETRIES=10');
  assert.strictEqual(f.MAX_PARALLEL, 64, 'design §1: MAX_PARALLEL=64');
  const m = f.compileFactory({ nodes: [{ id: 'a', prompt: 'x' }, { id: 'b', prompt: 'y', deps: ['a'], retries: 2 }] });
  assert.strictEqual(m.nodes.length, 2, 'machine carries the nodes');
  assert.strictEqual(m.failPolicy, 'fail_fast', 'default policy is fail_fast');
  assert.strictEqual(m.nodes.find((n) => n.id === 'b').retries, 2, 'per-node retries preserved');
  // Over-cap node count rejected.
  const big = { nodes: [] };
  for (let i = 0; i < 1025; i++) big.nodes.push({ id: `n${i}`, prompt: 'p' });
  assert.throws(() => f.compileFactory(big), /MAX_NODES/, '1025 nodes rejected');
});

t('renderPrompt substitutes {{dep}} answers and marks unavailable deps', async () => {
  const f = fresh('factory');
  const results = new Map([
    ['ok', { state: 'succeeded', answerPreview: 'ANSWER-A' }],
    ['bad', { state: 'failed', answerPreview: null }],
  ]);
  const node = { prompt: 'use {{ok}} and {{bad}} and {{unknown}}' };
  const out = f.renderPrompt(node, results);
  assert.ok(out.includes('ANSWER-A'), 'succeeded dep answer substituted');
  assert.ok(out.includes('<dep bad unavailable: failed>'), 'failed dep marked');
  assert.ok(out.includes('{{unknown}}'), 'unknown ref left verbatim');
});

// ── execution semantics (stubbed children) ──────────────────────────────

// A fake children.js surface: spawnChild/collectChildren with scriptable
// per-node behavior. runFactory accepts `children` injection.
function fakeChildren(behavior) {
  let seq = 0;
  return {
    spawnChild({ prompt, name, depth }) {
      const key = Object.keys(behavior).find((k) => prompt.includes(k)) || '*';
      return { rlmChildId: `c-${key}-${++seq}`, name, depth };
    },
    async collectChildren(ids) {
      return ids.map((id) => {
        const parts = id.split('-');
        const key = parts[1];
        const b = (behavior[key] !== undefined && typeof behavior[key] === 'object')
          ? behavior[key] : behavior['*'];
        const attempt = Number(parts[2] || 0);
        if (b && b.failsBefore && attempt <= b.failsBefore) {
          return { rlmChildId: id, status: 'error', answerPreview: 'boom', durationMs: 1 };
        }
        return { rlmChildId: id, status: 'done', answerPreview: (b && b.answer) || 'ans', answerChars: 3, durationMs: 1 };
      });
    },
  };
}

t('runFactory executes a DAG in dependency order and templates dep answers', async () => {
  const f = fresh('factory');
  const spawned = [];
  const kids = fakeChildren({});
  kids.spawnChild = (args) => { spawned.push(args); return fakeChildren({}).spawnChild(args); };
  const out = await f.runFactory({
    spec: {
      nodes: [
        { id: 'find', prompt: 'find refs' },
        { id: 'sum', prompt: 'summarize {{find}}', deps: ['find'] },
      ],
    },
    cwd: tmpCwd(), parentSessionId: 'p1', depth: 0, children: kids,
  });
  assert.strictEqual(out.status, 'succeeded', 'two-node chain succeeds');
  assert.strictEqual(out.nodes.find((n) => n.nodeId === 'find').state, 'succeeded');
  assert.strictEqual(out.nodes.find((n) => n.nodeId === 'sum').state, 'succeeded');
  // The dependent's prompt received the folded answer of its dep.
  const sumPrompt = spawned.map((s) => s.prompt).find((p) => p.includes('summarize'));
  assert.ok(sumPrompt, 'sum node spawned');
  assert.strictEqual(spawned.map((s) => s.prompt).filter((p) => p.includes('summarize ans')).length, 1,
    'dep answer templated into dependent prompt');
});

t('runFactory fail_fast aborts; continue skips dependents; escalate flags', async () => {
  const f = fresh('factory');
  const specBase = () => ({
    nodes: [
      { id: 'a', prompt: 'alpha work' },
      { id: 'b', prompt: 'beta work dep {{a}}', deps: ['a'] },
      { id: 'c', prompt: 'gamma work' },
    ],
  });
  const boom = { 'alpha': { failsBefore: 99, answer: 'boom' }, '*': { answer: 'fine' } };

  const fast = await f.runFactory({ spec: Object.assign(specBase(), { failPolicy: 'fail_fast' }),
    cwd: tmpCwd(), parentSessionId: 'p', depth: 0, children: fakeChildren(boom) });
  assert.strictEqual(fast.status, 'failed', 'fail_fast run fails');
  assert.strictEqual(fast.nodes.find((n) => n.nodeId === 'a').state, 'failed', 'failing node marked failed');

  const cont = await f.runFactory({ spec: Object.assign(specBase(), { failPolicy: 'continue' }),
    cwd: tmpCwd(), parentSessionId: 'p', depth: 0, children: fakeChildren(boom) });
  assert.strictEqual(cont.nodes.find((n) => n.nodeId === 'b').state, 'skipped',
    'continue: dependent of failed node is skipped');
  assert.strictEqual(cont.nodes.find((n) => n.nodeId === 'c').state, 'succeeded',
    'continue: independent node still runs');
  assert.strictEqual(cont.escalated, false, 'continue does not escalate');

  const esc = await f.runFactory({ spec: Object.assign(specBase(), { failPolicy: 'escalate' }),
    cwd: tmpCwd(), parentSessionId: 'p', depth: 0, children: fakeChildren(boom) });
  assert.strictEqual(esc.escalated, true, 'escalate sets the flag for the caller to decide');
});

t('runFactory retries a failing node up to its retries budget then succeeds', async () => {
  const f = fresh('factory');
  // Fails on attempt 1 (failsBefore=1), succeeds on retry. The fake's
  // child-id suffix is the spawn ordinal, so attempt 1 fails, attempt 2
  // recovers — verifying the retry loop re-spawns and records attempts.
  const kids = fakeChildren({ 'flake': { failsBefore: 1, answer: 'recovered' } });
  const out = await f.runFactory({
    spec: { nodes: [{ id: 'flake', prompt: 'flake work', retries: 2 }], failPolicy: 'continue' },
    cwd: tmpCwd(), parentSessionId: 'p', depth: 0, children: kids,
  });
  assert.strictEqual(out.status, 'succeeded', 'flaky node recovered on retry');
  assert.strictEqual(out.nodes.find((n) => n.nodeId === 'flake').attempts, 2, 'two attempts recorded');
  assert.strictEqual(out.nodes.find((n) => n.nodeId === 'flake').answerPreview, 'recovered', 'recovered answer folded back');
  assert.ok(out.log.some((l) => l.state === 'retrying'), 'retrying events in the log');
});

t('runFactory respects maxParallel (wave scheduling)', async () => {
  const f = fresh('factory');
  let inflight = 0, peak = 0;
  const kids = fakeChildren({});
  kids.spawnChild = (a) => { inflight++; peak = Math.max(peak, inflight); return fakeChildren({}).spawnChild(a); };
  kids.collectChildren = async (ids) => {
    // Simulate work: settle after a microtask so waves overlap.
    await new Promise((r) => setImmediate(r));
    inflight -= ids.length;
    return ids.map((id) => ({ rlmChildId: id, status: 'done', answerPreview: 'ans', answerChars: 3, durationMs: 1 }));
  };
  const nodes = [];
  for (let i = 0; i < 6; i++) nodes.push({ id: `n${i}`, prompt: `task-${i}` });
  const out = await f.runFactory({ spec: { nodes, maxParallel: 2 },
    cwd: tmpCwd(), parentSessionId: 'p', depth: 0, children: kids });
  assert.strictEqual(out.status, 'succeeded', 'all nodes ran');
  assert.ok(peak <= 2, `maxParallel=2 respected (peak inflight=${peak})`);
});

t('runFactory invalid spec throws FactorySpecError (compile gate before execution)', async () => {
  const f = fresh('factory');
  let spawned = 0;
  const kids = { spawnChild: () => { spawned++; throw new Error('must not spawn'); },
                 collectChildren: async () => [] };
  await assert.rejects(
    () => f.runFactory({ spec: { nodes: [{ id: 'a', prompt: 'x', deps: ['ghost'] }] },
      cwd: tmpCwd(), parentSessionId: 'p', depth: 0, children: kids }),
    (e) => e.name === 'FactorySpecError', 'invalid spec fails before any spawn');
  assert.strictEqual(spawned, 0, 'no children spawned on invalid spec');
});

Promise.all(results).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
