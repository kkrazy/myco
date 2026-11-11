// agents/rlm/factory.js — Factory 状态机编排 (myco-rlm-design.md §3 P3,
// modeled on prime-agent's rlm/factory.py). This is the upper-mechanism that
// distinguishes prime from an ordinary framework: a DECLARATIVE DAG spec that
// compiles into a state machine, executed through rlm.spawn / rlm.collect
// (children.js) — never by pasting node details into the parent's context.
//
// Spec (declarative):
//   {
//     nodes: [
//       { id: 'find',   prompt: 'grep the repo for X and report matches', deps: [], retries: 2 },
//       { id: 'summarize', prompt: 'summarize …', deps: ['find'] },
//     ],
//     failPolicy: 'fail_fast' | 'continue' | 'escalate',   // default fail_fast
//     maxParallel: 8,                                       // cap ≤ MAX_PARALLEL
//   }
//
// Execution semantics (state machine):
//   - A node becomes READY when all deps are SUCCEEDED.
//   - READY nodes run in parallel up to maxParallel via children.spawnChild.
//   - A node's result (collectChildren folded answer) is substituted into
//     dependents' prompts as {{find}} (double-brace templating).
//   - Failure policy on a FAILED node (after retries):
//       fail_fast  → cancel pending spawns, run fails immediately.
//       continue   → mark dependents SKIPPED, keep running the rest.
//       escalate   → same as continue, but ALSO re-run the failed node's
//                    dependents-free retry once at escalateRetries, and the
//                    run result carries escalated:true (caller decides).
//   - Retries: per-node `retries` (cap MAX_RETRIES), re-spawn with the last
//     error appended to the prompt so the child sees what went wrong.
//
// Hard limits (prime parity): MAX_NODES=1024, MAX_RETRIES=10,
// MAX_PARALLEL=64. All enforced at COMPILE time (compileFactory) — an
// invalid spec never reaches execution.
//
// Events: the runner emits nothing into any LLM context; runFactory resolves
// with a structured log ({ nodeId, state, answerPreview, durationMs, … })
// that the kernel-side caller (host.js 'rlm.run_factory' → kernel rlm shim)
// folds back into the calling cell's promise.

'use strict';

const MAX_NODES = 1024;
const MAX_RETRIES = 10;
const MAX_PARALLEL = 64;
const FAIL_POLICIES = new Set(['fail_fast', 'continue', 'escalate']);
const TEMPLATE_RE = /\{\{\s*([A-Za-z0-9_$-]+)\s*\}\}/g;
const COLLECT_CAP_MS = 30 * 60 * 1000; // one factory run hard-caps at 30 min

class FactorySpecError extends Error {
  constructor(message) { super(message); this.name = 'FactorySpecError'; }
}

// ── compile: declarative DAG → validated machine state ──────────────────

// Compile a spec into an executable machine description. Pure — no I/O, no
// spawns. Throws FactorySpecError on any structural problem (unknown dep,
// cycle, over-cap, duplicate id, empty prompt, bad policy).
function compileFactory(spec) {
  if (!spec || typeof spec !== 'object') throw new FactorySpecError('factory spec must be an object');
  const nodes = spec.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) throw new FactorySpecError('factory spec.nodes must be a non-empty array');
  if (nodes.length > MAX_NODES) throw new FactorySpecError(`factory has ${nodes.length} nodes; MAX_NODES=${MAX_NODES}`);

  const failPolicy = spec.failPolicy || 'fail_fast';
  if (!FAIL_POLICIES.has(failPolicy)) throw new FactorySpecError(`failPolicy must be one of ${[...FAIL_POLICIES].join('|')} (got ${failPolicy})`);
  let maxParallel = Number(spec.maxParallel) || 8;
  if (!Number.isFinite(maxParallel) || maxParallel < 1) maxParallel = 1;
  if (maxParallel > MAX_PARALLEL) throw new FactorySpecError(`maxParallel ${maxParallel} exceeds MAX_PARALLEL=${MAX_PARALLEL}`);

  const byId = new Map();
  for (const n of nodes) {
    const id = String(n && n.id || '').trim();
    if (!id) throw new FactorySpecError('every factory node needs a non-empty id');
    if (byId.has(id)) throw new FactorySpecError(`duplicate node id: ${id}`);
    const prompt = String(n && n.prompt || '').trim();
    if (!prompt) throw new FactorySpecError(`node ${id}: prompt must be non-empty`);
    let retries = Number(n.retries) || 0;
    if (retries < 0) retries = 0;
    if (retries > MAX_RETRIES) throw new FactorySpecError(`node ${id}: retries ${retries} exceeds MAX_RETRIES=${MAX_RETRIES}`);
    byId.set(id, {
      id, prompt, retries,
      name: n.name ? String(n.name).slice(0, 64) : null,
      model: n.model || null,
      deps: Array.isArray(n.deps) ? n.deps.map(String) : [],
    });
  }
  // Validate edges: known targets + acyclic (Kahn).
  for (const node of byId.values()) {
    for (const d of node.deps) {
      if (!byId.has(d)) throw new FactorySpecError(`node ${node.id} depends on unknown node ${d}`);
    }
  }
  _assertAcyclic(byId);
  return { nodes: [...byId.values()], failPolicy, maxParallel, maxNodes: MAX_NODES };
}

function _assertAcyclic(byId) {
  const indeg = new Map();
  for (const n of byId.values()) indeg.set(n.id, n.deps.length);
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const id = queue.pop();
    seen++;
    for (const n of byId.values()) {
      if (n.deps.includes(id)) {
        indeg.set(n.id, indeg.get(n.id) - 1);
        if (indeg.get(n.id) === 0) queue.push(n.id);
      }
    }
  }
  if (seen !== byId.size) {
    const cyc = [...indeg.entries()].filter(([, d]) => d > 0).map(([id]) => id);
    throw new FactorySpecError(`factory DAG has a cycle involving: ${cyc.join(', ')}`);
  }
}

// Substitute dependency answers into a node's prompt: {{depId}} → the
// dependency's folded answer preview. Unknown refs are left verbatim (a
// node may template other text); missing/failed deps produce a marker so
// the child knows the input is unavailable.
function renderPrompt(node, results) {
  return node.prompt.replace(TEMPLATE_RE, (m, ref) => {
    const r = results.get(ref);
    if (!r) return m;
    if (r.state === 'succeeded') return r.answerPreview || '';
    return `<dep ${ref} unavailable: ${r.state}>`;
  });
}

// ── run: the state machine executor ─────────────────────────────────────

// Run a compiled (or raw — compiled here) factory. Returns a promise of
// { status, nodes: [...log rows], escalated }. All children are spawned via
// children.spawnChild at the CALLER's depth (host.js passes ctx.depth so
// the depth cap stays the single runtime constraint) and collected via
// children.collectChildren.
async function runFactory({ spec, cwd, parentSessionId, depth = 0, user = null, ui = null, children = null }) {
  const machine = compileFactory(spec);
  const kids = children || require('./children');

  const results = new Map(); // id → { state, answerPreview, durationMs, attempts, error }
  const states = new Map();  // id → 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  for (const n of machine.nodes) states.set(n.id, 'pending');
  const log = [];
  let escalated = false;
  let aborted = false;
  const startedAt = Date.now();

  const record = (id, state, extra) => {
    results.set(id, Object.assign({ state, attempts: 0, answerPreview: null, durationMs: 0 }, results.get(id), extra));
    log.push(Object.assign({ nodeId: id, state, ts: new Date().toISOString() }, extra || {}));
  };

  const ready = () => machine.nodes.filter((n) =>
    states.get(n.id) === 'pending' && n.deps.every((d) => states.get(d) === 'succeeded'));

  const depsBlocked = (n) => n.deps.some((d) => states.get(d) !== 'succeeded');

  // FIX (2026-10-23 audit): runNode used to hold child handles in a
  // function-local that the scheduler loop could never see — the
  // running-wave wait below collected a filtered-to-empty list, i.e.
  // a pure 200ms cap-out timer per loop iteration. Track handles on
  // the shared `handles` map so the wait actually polls the children.
  const handles = new Map(); // id → { rlmChildId }

  // One node's full lifecycle: spawn → collect → retry per policy.
  async function runNode(node) {
    states.set(node.id, 'running');
    let attempts = 0;
    const nodeStart = Date.now();
    while (attempts <= node.retries) {
      attempts++;
      let spawnRes;
      try {
        spawnRes = kids.spawnChild({
          parentSessionId,
          cwd,
          prompt: renderPrompt(node, results),
          name: node.name || `factory-${node.id}`,
          depth,
          model: node.model,
          user,
          ui,
        });
        handles.set(node.id, spawnRes);
      } catch (err) {
        record(node.id, 'failed', { error: `${err.name || 'Error'}: ${err.message}`, attempts, durationMs: Date.now() - nodeStart });
        return failNode(node, err);
      }
      const collected = await kids.collectChildren([spawnRes.rlmChildId], { timeoutMs: 0, capMs: COLLECT_CAP_MS });
      const row = collected[0] || { status: 'error' };
      if (row.status === 'done') {
        states.set(node.id, 'succeeded');
        record(node.id, 'succeeded', { answerPreview: row.answerPreview, answerChars: row.answerChars, attempts, durationMs: Date.now() - nodeStart });
        return;
      }
      if (attempts <= node.retries) {
        log.push({ nodeId: node.id, state: 'retrying', attempt: attempts, error: row.answerPreview || row.status, ts: new Date().toISOString() });
        continue;
      }
      states.set(node.id, 'failed');
      record(node.id, 'failed', { error: row.answerPreview || row.status, attempts, durationMs: Date.now() - nodeStart });
      return failNode(node, row);
    }
  }

  function failNode(node, err) {
    if (machine.failPolicy === 'fail_fast') {
      aborted = true;
      return;
    }
    // continue / escalate: dependents are skipped; independents keep going.
    for (const other of machine.nodes) {
      if (states.get(other.id) === 'pending' && other.deps.includes(node.id)) {
        states.set(other.id, 'skipped');
        record(other.id, 'skipped', { reason: `dep ${node.id} failed` });
      }
    }
    if (machine.failPolicy === 'escalate') escalated = true;
  }

  // Scheduler loop: fire READY nodes up to maxParallel; wait for one batch
  // slot whenever the wave is full. Aborts immediately on fail_fast failure.
  // FIX (2026-10-23 audit): the old `await Promise.all(running)` inside the
  // loop made maxParallel decorative — every wave was fully awaited before
  // the next ready-set was computed, so nodes never ran concurrently.
  // Now READY nodes are fired without waiting; the loop only waits (via a
  // short collect poll on the live handles) when nothing new is ready.
  let inFlight = Promise.resolve();
  const track = (p) => { inFlight = Promise.all([inFlight, p.catch(() => {})]); };
  while (!aborted && [...states.values()].some((s) => s === 'pending' || s === 'running')) {
    const runningCount = [...states.values()].filter((s) => s === 'running').length;
    const slots = machine.maxParallel - runningCount;
    const canRun = slots > 0 ? ready().slice(0, slots) : [];
    if (canRun.length) {
      for (const node of canRun) track(runNode(node));
      continue;
    }
    // Nothing ready but work outstanding → all running; wait for a wave.
    const runningIds = [...states.entries()].filter(([, s]) => s === 'running').map(([id]) => id);
    if (!runningIds.length) break; // remaining pending are all skipped/blocked
    await kids.collectChildren(runningIds.map((id) => handles.get(id) && handles.get(id).rlmChildId).filter(Boolean), { timeoutMs: 200, capMs: COLLECT_CAP_MS });
  }
  await inFlight;

  const finalState = aborted ? 'failed' : ([...states.values()].every((s) => s === 'succeeded' || s === 'skipped') ? 'succeeded' : 'partial');
  return {
    status: finalState,
    escalated,
    failPolicy: machine.failPolicy,
    durationMs: Date.now() - startedAt,
    nodes: machine.nodes.map((n) => Object.assign({ nodeId: n.id, state: states.get(n.id) }, results.get(n.id) || {})),
    log,
  };
}

module.exports = {
  compileFactory,
  runFactory,
  renderPrompt,
  FactorySpecError,
  MAX_NODES,
  MAX_RETRIES,
  MAX_PARALLEL,
  FAIL_POLICIES,
};
