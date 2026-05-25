// fr-90 Phase 0: SessionPool data structure + affinity persistence.
//
// Phase 0 scope (this file):
//   1. Routing rules — 5 priority levels (dependsOn, mention, LRU,
//      spawn-if-under-cap, queue-if-busy)
//   2. Spawn / kill lifecycle with a mock spawnAgent injection
//   3. Idle reaper at configurable timeout
//   4. Affinity persistence to <cwd>/_myco_/session-affinity.json
//      with bootId tag (per fr-91 epoch pattern)
//   5. Cold-restart detection (isColdRestartFor)
//   6. shutdown tears down sessions + stops reaper
//
// Phase 0 does NOT wire into attach.js queue dispatch — that's Phase 1.
// Tests use a mock spawnAgent so we don't fork real claude subprocesses.
//
// Static guards on module exports + behavior simulation against an
// in-memory mock agent factory.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const sessionPoolMod = require('../server/src/sessionPool');
const { SessionPool, extractMentions, AFFINITY_FILENAME } = sessionPoolMod;

console.log('── fr-90 Phase 0: SessionPool + affinity routing ──');

// ──────────────────────────────────────────────────────────────────────
// Helpers — mock spawnAgent + tmp cwd setup
// ──────────────────────────────────────────────────────────────────────

function makeMockAgent() {
  const writes = [];
  let killed = false;
  return {
    write(text) { if (killed) throw new Error('agent killed'); writes.push(text); },
    kill() { killed = true; },
    _writes: writes,
    get killed() { return killed; },
  };
}

function makeSpawnMock() {
  const spawned = [];
  const fn = (sessionId, opts) => {
    const agent = makeMockAgent();
    spawned.push({ sessionId, opts, agent });
    return agent;
  };
  fn._spawned = spawned;
  return fn;
}

function freshTmpCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr90-pool-'));
  fs.mkdirSync(path.join(dir, '_myco_'), { recursive: true });
  return dir;
}

function makePool(opts = {}) {
  const cwd = opts.cwd || freshTmpCwd();
  return new SessionPool({
    cwd,
    parentSessionId: 'sess-parent',
    spawnAgent: opts.spawnAgent || makeSpawnMock(),
    now: opts.now,
    maxSize: opts.maxSize,
    idleTimeoutMs: opts.idleTimeoutMs,
    reapIntervalMs: opts.reapIntervalMs,
    bootId: opts.bootId,
    logger: opts.logger || { log() {}, warn() {}, error() {} },
  });
}

// ──────────────────────────────────────────────────────────────────────
// Module surface
// ──────────────────────────────────────────────────────────────────────

t('module exports SessionPool class + helpers + defaults', () => {
  assert.strictEqual(typeof SessionPool, 'function', 'SessionPool must be a class/constructor');
  assert.strictEqual(typeof extractMentions, 'function');
  assert.strictEqual(AFFINITY_FILENAME, 'session-affinity.json',
    'affinity file lives at _myco_/session-affinity.json (committable per CLAUDE.md §5)');
  assert.strictEqual(sessionPoolMod.DEFAULT_MAX_SIZE, 5);
  assert.strictEqual(sessionPoolMod.DEFAULT_IDLE_TIMEOUT_MS, 10 * 60 * 1000);
});

t('constructor requires cwd + parentSessionId', () => {
  assert.throws(() => new SessionPool({}), /cwd is required/);
  assert.throws(() => new SessionPool({ cwd: '/tmp' }), /parentSessionId is required/);
});

// ──────────────────────────────────────────────────────────────────────
// extractMentions
// ──────────────────────────────────────────────────────────────────────

t('extractMentions finds fr-N / bug-N / td-N tokens, deduped', () => {
  const txt = 'See fr-1 and bug-42, also fr-1 again. Touch td-22 too. Skip random tokens like fr-x or fr1.';
  const m = extractMentions(txt);
  assert.deepStrictEqual(m.sort(), ['bug-42', 'fr-1', 'td-22'].sort(),
    'must dedupe + only match valid layer-N tokens: ' + JSON.stringify(m));
});

t('extractMentions handles empty + nullish input', () => {
  assert.deepStrictEqual(extractMentions(''), []);
  assert.deepStrictEqual(extractMentions(null), []);
  assert.deepStrictEqual(extractMentions(undefined), []);
});

// ──────────────────────────────────────────────────────────────────────
// Routing rules — pickSession + dispatch
// ──────────────────────────────────────────────────────────────────────

t('rule 1: dependsOn affinity reuses the dep\'s session', () => {
  const pool = makePool({ maxSize: 5 });
  // First dispatch fr-1 with no relations → rule 4 (spawn).
  const r1 = pool.dispatch({ id: 'fr-1', text: 'feature A' }, '[run:plan#fr-1] body');
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.reason, 'spawn');
  // Second dispatch fr-2 dependsOn=[fr-1] → rule 1 (reuse).
  const r2 = pool.dispatch(
    { id: 'fr-2', text: 'feature B', dependsOn: ['fr-1'] },
    '[run:plan#fr-2] body');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.reason, 'dependsOn:fr-1',
    'rule 1: fr-2 must reuse fr-1\'s pool session');
  assert.strictEqual(r2.poolId, r1.poolId,
    'reused poolId matches fr-1\'s');
});

t('rule 2: text-mention affinity reuses mentioned item\'s session', () => {
  const pool = makePool({ maxSize: 5 });
  const r1 = pool.dispatch({ id: 'bug-5', text: 'baseline bug' }, 'text-bug5');
  // bug-6 mentions bug-5 in its body but doesn't dependsOn it.
  const r2 = pool.dispatch(
    { id: 'bug-6', text: 'similar to bug-5 in shape' },
    'text-bug6');
  assert.strictEqual(r2.reason, 'mention:bug-5',
    'rule 2: text-mention must route bug-6 to bug-5\'s session');
  assert.strictEqual(r2.poolId, r1.poolId);
});

t('rule 2: text-mention scans comments too', () => {
  const pool = makePool({ maxSize: 5 });
  const r1 = pool.dispatch({ id: 'fr-7', text: 'thing' }, 'text-fr7');
  // fr-8's body doesn't mention fr-7, but a comment does.
  const r2 = pool.dispatch(
    { id: 'fr-8', text: 'unrelated body',
      comments: [{ user: 'k', text: 'this is a follow-up to fr-7' }] },
    'text-fr8');
  assert.strictEqual(r2.reason, 'mention:fr-7',
    'rule 2: must scan comments for mentions');
});

t('rule 2: skips run-summary auto-comments + self-id', () => {
  const pool = makePool({ maxSize: 5 });
  pool.dispatch({ id: 'fr-9', text: 'baseline' }, 'text-fr9');
  // fr-10 has a run-summary comment that mentions fr-9 (SHOULDN'T
  // route — run-summaries are echo-y) + body mentions fr-10 itself
  // (must skip self).
  const r = pool.dispatch(
    { id: 'fr-10', text: 'fr-10 description without prior mention',
      comments: [
        { user: 'claude', meta: { kind: 'run-summary' }, text: 'See fr-9' },
      ] },
    'text-fr10');
  assert.strictEqual(r.reason, 'spawn',
    'run-summary comments must not contribute to mention routing');
});

t('rule 3: LRU free session reused when no relations', () => {
  const pool = makePool({ maxSize: 5, now: makeMonotonicClock() });
  // Spawn 2 sessions via dispatches.
  const a = pool.dispatch({ id: 'fr-1', text: 'a' }, 'text-a');
  const b = pool.dispatch({ id: 'fr-2', text: 'b' }, 'text-b');
  assert.notStrictEqual(a.poolId, b.poolId, 'two distinct pool sessions');
  // Free both via onTerminal.
  pool.onTerminal(a.poolId);
  pool.onTerminal(b.poolId);
  // Third dispatch with no relations — should reuse LRU (fr-1's
  // session, which freed first → its lastUsed is older).
  // Wait — actually `onTerminal` sets lastUsed = now(). So whichever
  // was freed FIRST has the older lastUsed (LRU). a's session went
  // free before b's, so a's session is the LRU.
  const c = pool.dispatch({ id: 'fr-3', text: 'c, unrelated' }, 'text-c');
  assert.strictEqual(c.reason, 'lru');
  assert.strictEqual(c.poolId, a.poolId, 'LRU must pick the older-freed session');
});

t('rule 4: spawn new session when no free + under maxSize', () => {
  const pool = makePool({ maxSize: 3 });
  const a = pool.dispatch({ id: 'fr-1', text: 'a' }, 'text-a');
  const b = pool.dispatch({ id: 'fr-2', text: 'b' }, 'text-b');
  const c = pool.dispatch({ id: 'fr-3', text: 'c' }, 'text-c');
  // All 3 spawned (none free, all under cap).
  assert.strictEqual(a.reason, 'spawn');
  assert.strictEqual(b.reason, 'spawn');
  assert.strictEqual(c.reason, 'spawn');
  assert.strictEqual(pool.sessions.size, 3, 'pool grew to cap');
});

t('rule 5: at-cap + all busy → queues + drains on onTerminal', () => {
  const pool = makePool({ maxSize: 2 });
  const a = pool.dispatch({ id: 'fr-1', text: 'a' }, 'text-a');
  const b = pool.dispatch({ id: 'fr-2', text: 'b' }, 'text-b');
  // Pool is at cap; both busy.
  const c = pool.dispatch({ id: 'fr-3', text: 'c' }, 'text-c');
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.reason, 'queued');
  assert.strictEqual(c.queuePos, 1);
  assert.strictEqual(pool.pendingDispatches.length, 1);
  // Free one session → onTerminal must drain pending.
  pool.onTerminal(a.poolId);
  assert.strictEqual(pool.pendingDispatches.length, 0,
    'pending must drain once a session frees');
  // fr-3 should now be busy on a's pool session (LRU of the freed one).
  assert.strictEqual(pool.affinity.get('fr-3'), a.poolId,
    'queued dispatch routed to the just-freed pool session');
});

t('rule 5: queued items preserve FIFO order', () => {
  const pool = makePool({ maxSize: 1 });
  const a = pool.dispatch({ id: 'fr-1', text: 'a' }, 'text-a');
  const b = pool.dispatch({ id: 'fr-2', text: 'b' }, 'text-b');
  const c = pool.dispatch({ id: 'fr-3', text: 'c' }, 'text-c');
  // Pool is at cap=1, fr-1 busy. fr-2 + fr-3 queued in arrival order.
  assert.strictEqual(b.reason, 'queued');
  assert.strictEqual(c.reason, 'queued');
  assert.strictEqual(pool.pendingDispatches.length, 2);
  // Free fr-1 → fr-2 should dispatch (FIFO head).
  pool.onTerminal(a.poolId);
  assert.strictEqual(pool.affinity.get('fr-2'), a.poolId,
    'fr-2 (FIFO head) dispatched first when slot freed');
  assert.strictEqual(pool.pendingDispatches.length, 1,
    'fr-3 still queued');
});

t('routing priority — dependsOn beats mention beats LRU', () => {
  const pool = makePool({ maxSize: 5 });
  // Two sessions: one for fr-1, one for fr-2.
  const r1 = pool.dispatch({ id: 'fr-1', text: 'one' }, 'text-1');
  const r2 = pool.dispatch({ id: 'fr-2', text: 'two' }, 'text-2');
  pool.onTerminal(r1.poolId);
  pool.onTerminal(r2.poolId);
  // fr-3 mentions fr-1 AND dependsOn fr-2. Rule 1 (dependsOn) wins.
  const r3 = pool.dispatch(
    { id: 'fr-3', text: 'links to fr-1', dependsOn: ['fr-2'] },
    'text-3');
  assert.strictEqual(r3.reason, 'dependsOn:fr-2',
    'dependsOn must beat mention');
  assert.strictEqual(r3.poolId, r2.poolId);
});

// ──────────────────────────────────────────────────────────────────────
// Lifecycle — spawn, dispatch, kill, shutdown
// ──────────────────────────────────────────────────────────────────────

t('dispatch writes the text to the picked session\'s agent', () => {
  const spawnMock = makeSpawnMock();
  const pool = makePool({ spawnAgent: spawnMock });
  pool.dispatch({ id: 'fr-1', text: 't' }, 'hello-fr1');
  assert.strictEqual(spawnMock._spawned.length, 1);
  assert.deepStrictEqual(spawnMock._spawned[0].agent._writes, ['hello-fr1']);
});

t('dispatch updates session.items + session.deps + affinity', () => {
  const pool = makePool();
  pool.dispatch({ id: 'fr-1', text: 't' }, 'text-1');
  pool.dispatch({ id: 'fr-2', text: 't', dependsOn: ['fr-1'] }, 'text-2');
  // Both items went to the same pool session (fr-2 reused fr-1's).
  const poolId = pool.affinity.get('fr-1');
  const sess = pool.sessions.get(poolId);
  assert.deepStrictEqual(Array.from(sess.items).sort(), ['fr-1', 'fr-2']);
  assert.ok(sess.deps.has('fr-1'), 'fr-1 recorded as a dep for the session');
});

t('shutdown kills every agent + stops reaper', () => {
  const spawnMock = makeSpawnMock();
  const pool = makePool({ spawnAgent: spawnMock });
  pool.startReaper();
  pool.dispatch({ id: 'fr-1', text: 't' }, 'text-1');
  pool.dispatch({ id: 'fr-2', text: 't' }, 'text-2');
  assert.strictEqual(spawnMock._spawned.length, 2);
  pool.shutdown();
  assert.strictEqual(spawnMock._spawned[0].agent.killed, true);
  assert.strictEqual(spawnMock._spawned[1].agent.killed, true);
  assert.strictEqual(pool.sessions.size, 0, 'sessions cleared');
  assert.strictEqual(pool._reapTimer, null, 'reaper stopped');
});

// ──────────────────────────────────────────────────────────────────────
// Reaper
// ──────────────────────────────────────────────────────────────────────

t('reaper tears down idle sessions older than idleTimeoutMs', () => {
  let t0 = 1000;
  const pool = makePool({ idleTimeoutMs: 100, now: () => t0 });
  const r = pool.dispatch({ id: 'fr-1', text: 't' }, 'text-1');
  // Free it → lastUsed = 1000.
  pool.onTerminal(r.poolId);
  // Advance clock past the timeout.
  t0 += 200;
  const reaped = pool._reapIdle();
  assert.deepStrictEqual(reaped, [r.poolId], 'idle session reaped');
  assert.strictEqual(pool.sessions.has(r.poolId), false);
});

t('reaper skips busy sessions even if old', () => {
  let t0 = 1000;
  const pool = makePool({ idleTimeoutMs: 100, now: () => t0 });
  const r = pool.dispatch({ id: 'fr-1', text: 't' }, 'text-1');
  // Don't free it → busy=true. Advance clock past timeout.
  t0 += 200;
  const reaped = pool._reapIdle();
  assert.deepStrictEqual(reaped, [], 'busy session must not be reaped');
  assert.strictEqual(pool.sessions.has(r.poolId), true);
});

t('reaper persists affinity changes (audit trail survives reap)', () => {
  let t0 = 1000;
  const cwd = freshTmpCwd();
  const pool = makePool({ cwd, idleTimeoutMs: 100, now: () => t0 });
  const r = pool.dispatch({ id: 'fr-1', text: 't' }, 'text-1');
  pool.onTerminal(r.poolId);
  t0 += 200;
  pool._reapIdle();
  // After reap, affinity STAYS — historical audit preserved.
  assert.strictEqual(pool.affinity.get('fr-1'), r.poolId,
    'affinity for fr-1 survives session reap (Phase 2 cold-restart uses this)');
  // And the file on disk reflects the latest persist.
  const j = JSON.parse(fs.readFileSync(
    path.join(cwd, '_myco_', 'session-affinity.json'), 'utf8'));
  assert.ok(j.entries['fr-1']);
  assert.strictEqual(j.entries['fr-1'].poolId, r.poolId);
});

// ──────────────────────────────────────────────────────────────────────
// Persistence — round-trip + bootId epoch
// ──────────────────────────────────────────────────────────────────────

t('persistence: round-trips affinity to disk + reloads on construction', () => {
  const cwd = freshTmpCwd();
  // Pool A — write affinity.
  const poolA = makePool({ cwd, bootId: 'boot-A' });
  const r = poolA.dispatch({ id: 'fr-1', text: 't' }, 'text-1');
  assert.strictEqual(poolA.affinity.get('fr-1'), r.poolId);
  // File on disk.
  const fileExists = fs.existsSync(path.join(cwd, '_myco_', 'session-affinity.json'));
  assert.ok(fileExists, 'affinity file must be written');
  // Pool B — same bootId → loads affinity into live map.
  const poolB = makePool({ cwd, bootId: 'boot-A' });
  assert.strictEqual(poolB.affinity.get('fr-1'), r.poolId,
    'same bootId reload should restore live affinity');
});

t('persistence: different bootId loads historical but NOT live affinity', () => {
  const cwd = freshTmpCwd();
  const poolA = makePool({ cwd, bootId: 'boot-A' });
  const r = poolA.dispatch({ id: 'fr-1', text: 't' }, 'text-1');
  // Pool B — DIFFERENT bootId → historicalAffinity only.
  const poolB = makePool({ cwd, bootId: 'boot-B' });
  assert.strictEqual(poolB.affinity.has('fr-1'), false,
    'different bootId should NOT restore live affinity (no live session to point at)');
  assert.ok(poolB.historicalAffinity.has('fr-1'),
    'different bootId DOES populate historicalAffinity for audit + cold-restart detection');
  assert.strictEqual(poolB.historicalAffinity.get('fr-1').bootId, 'boot-A');
});

t('persistence: atomic write — uses .tmp + rename', () => {
  // Defensive: a crash mid-write must not corrupt the affinity file.
  // We can't easily simulate a crash here, but we CAN verify no
  // partial file is left in the dir + that no .tmp lingers in
  // happy-path operation.
  const cwd = freshTmpCwd();
  const pool = makePool({ cwd });
  pool.dispatch({ id: 'fr-1', text: 't' }, 'text-1');
  const files = fs.readdirSync(path.join(cwd, '_myco_'));
  assert.ok(files.includes('session-affinity.json'));
  assert.ok(!files.some((f) => f.endsWith('.tmp')),
    'happy-path persist must not leave .tmp files');
});

// ──────────────────────────────────────────────────────────────────────
// isColdRestartFor — Phase 2 hook (already plumbed in Phase 0)
// ──────────────────────────────────────────────────────────────────────

t('isColdRestartFor: returns null when no affinity touches the item', () => {
  const pool = makePool();
  assert.strictEqual(
    pool.isColdRestartFor({ id: 'fr-99', text: 'fresh', dependsOn: [] }),
    null);
});

t('isColdRestartFor: detects stale dep (historical only, not live)', () => {
  const cwd = freshTmpCwd();
  // Pool A persists fr-1 affinity.
  const poolA = makePool({ cwd, bootId: 'boot-A' });
  poolA.dispatch({ id: 'fr-1', text: 't' }, 'text-1');
  // Pool B (different boot) has historicalAffinity only.
  const poolB = makePool({ cwd, bootId: 'boot-B' });
  const detect = poolB.isColdRestartFor({
    id: 'fr-2', text: 'follow-up', dependsOn: ['fr-1'],
  });
  assert.ok(detect, 'should detect cold-restart on stale dep');
  assert.strictEqual(detect.kind, 'dependsOn');
  assert.strictEqual(detect.stale, 'fr-1');
});

t('isColdRestartFor: detects stale text-mention', () => {
  const cwd = freshTmpCwd();
  const poolA = makePool({ cwd, bootId: 'boot-A' });
  poolA.dispatch({ id: 'bug-5', text: 't' }, 'text-bug5');
  const poolB = makePool({ cwd, bootId: 'boot-B' });
  const detect = poolB.isColdRestartFor({
    id: 'bug-6', text: 'mentions bug-5 in body',
  });
  assert.ok(detect);
  assert.strictEqual(detect.kind, 'mention');
  assert.strictEqual(detect.stale, 'bug-5');
});

// ──────────────────────────────────────────────────────────────────────
// snapshot — observability surface
// ──────────────────────────────────────────────────────────────────────

t('snapshot: returns read-only pool state', () => {
  const pool = makePool({ maxSize: 3 });
  pool.dispatch({ id: 'fr-1', text: 't' }, 'text-1');
  pool.dispatch({ id: 'fr-2', text: 't' }, 'text-2');
  const s = pool.snapshot();
  assert.strictEqual(s.maxSize, 3);
  assert.strictEqual(s.sessions.length, 2);
  assert.deepStrictEqual(s.sessions.map((x) => x.busy), [true, true]);
  assert.strictEqual(Object.keys(s.affinity).length, 2);
  assert.strictEqual(s.pendingDispatches, 0);
});

// ──────────────────────────────────────────────────────────────────────
// Defensive — invalid input
// ──────────────────────────────────────────────────────────────────────

t('dispatch rejects invalid item (no id)', () => {
  const pool = makePool();
  const r = pool.dispatch({ text: 'no-id' }, 'text');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid-item');
});

// ──────────────────────────────────────────────────────────────────────
// Helper — monotonic clock for LRU test
// ──────────────────────────────────────────────────────────────────────

function makeMonotonicClock(start = 1000) {
  let t = start;
  return () => { t += 1; return t; };
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
