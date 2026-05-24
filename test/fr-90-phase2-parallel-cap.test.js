// fr-90 Phase 2: parallel concurrency on the run queue.
//
// Pre-fix: every "kick if idle" site checked `!hasRunning` — only
// dispatched when nothing was running, serializing every queue add.
// Post-fix: each site checks `runQueue.canDispatchMore(rec)` —
// dispatches when running count is below `runQueueMaxConcurrent`
// (default 3, configurable per session). Multiple items can be in
// flight concurrently; the actual parallelism happens at the
// Task-subagent layer via run_in_background: true (per CLAUDE.md
// §Code Style #3 fr-90 etiquette).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const RUN_QUEUE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'runQueue.js'), 'utf8');
const ARTIFACTS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');
const SLASHCMDS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');
const CLAUDE_MD = fs.readFileSync(
  path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');

console.log('── fr-90 Phase 2: parallel concurrency ──');

// ──────────────────────────────────────────────────────────────────────
// Static guards: runQueue helpers
// ──────────────────────────────────────────────────────────────────────

t('runQueue.js: DEFAULT_MAX_CONCURRENT constant exported', () => {
  assert.ok(/const\s+DEFAULT_MAX_CONCURRENT\s*=\s*3/.test(RUN_QUEUE_SRC),
    'DEFAULT_MAX_CONCURRENT must default to 3 (per fr-90 spec)');
  assert.ok(/DEFAULT_MAX_CONCURRENT[\s\S]{0,500}exports/.test(RUN_QUEUE_SRC + 'exports'),
    'must be in module.exports');
});

t('runQueue.js: maxConcurrent + countRunning + canDispatchMore helpers exported', () => {
  for (const name of ['maxConcurrent', 'countRunning', 'canDispatchMore']) {
    assert.ok(new RegExp(`function\\s+${name}\\s*\\(`).test(RUN_QUEUE_SRC),
      name + ' must be defined');
    const exportsIdx = RUN_QUEUE_SRC.search(/module\.exports\s*=\s*\{/);
    const win = RUN_QUEUE_SRC.slice(exportsIdx, exportsIdx + 2000);
    assert.ok(new RegExp('\\b' + name + '\\b').test(win),
      name + ' must be in module.exports');
  }
});

t('runQueue.js: maxConcurrent reads rec.runQueueMaxConcurrent (per-session override)', () => {
  const idx = RUN_QUEUE_SRC.search(/function\s+maxConcurrent\s*\(/);
  const win = RUN_QUEUE_SRC.slice(idx, idx + 500);
  assert.ok(/rec\.runQueueMaxConcurrent/.test(win),
    'maxConcurrent must read rec.runQueueMaxConcurrent (lets sessions override the default)');
  assert.ok(/Math\.max\(1/.test(win),
    'must floor at 1 (cap=0 would deadlock the queue — nothing ever dispatches)');
});

t('runQueue.js: canDispatchMore checks paused + countRunning < cap', () => {
  const idx = RUN_QUEUE_SRC.search(/function\s+canDispatchMore\s*\(/);
  const win = RUN_QUEUE_SRC.slice(idx, idx + 500);
  assert.ok(/rec\.runQueuePaused/.test(win),
    'paused queue must short-circuit canDispatchMore to false');
  assert.ok(/countRunning\(rec\)\s*<\s*maxConcurrent\(rec\)/.test(win),
    'must compare countRunning < maxConcurrent');
});

// ──────────────────────────────────────────────────────────────────────
// Static guards: dispatch sites use canDispatchMore
// ──────────────────────────────────────────────────────────────────────

t('artifacts.js: all kick sites use runQueue.canDispatchMore', () => {
  // Pre-fix: each site computed `const hasRunning = rec.runQueue.some(…)`
  // + checked `!hasRunning && !rec.runQueuePaused`. Post-fix: each
  // site calls runQueue.canDispatchMore. Pin the conversion.
  const canCount = (ARTIFACTS_SRC.match(/runQueue\.canDispatchMore\(/g) || []).length;
  assert.ok(canCount >= 2,
    'artifacts.js must call runQueue.canDispatchMore at least twice (2 kick sites)');
  // No more hasRunning-pattern kick blocks remain.
  const oldPattern = ARTIFACTS_SRC.match(/const\s+hasRunning\s*=\s*[^.]*\.runQueue\.some/g) || [];
  assert.strictEqual(oldPattern.length, 0,
    'no legacy `const hasRunning = rec.runQueue.some(...)` kick blocks may remain');
});

t('slashcmds.js: queue kick uses runQueue.canDispatchMore', () => {
  assert.ok(/runQueue\.canDispatchMore\(/.test(SLASHCMDS_SRC),
    'slashcmds.js must use runQueue.canDispatchMore for its /queue kick');
  const oldPattern = SLASHCMDS_SRC.match(/const\s+hasRunning\s*=\s*rec\.runQueue\.some/g) || [];
  assert.strictEqual(oldPattern.length, 0,
    'no legacy hasRunning kick blocks may remain in slashcmds.js');
});

// ──────────────────────────────────────────────────────────────────────
// CLAUDE.md instructs run_in_background:true for parallel subagents
// ──────────────────────────────────────────────────────────────────────

t('CLAUDE.md instructs Task({run_in_background: true}) for parallel subagent dispatch', () => {
  // Without this etiquette the parent agent blocks on each Task call
  // and the concurrent capacity goes unused. Critical instruction.
  assert.ok(/run_in_background/.test(CLAUDE_MD),
    'CLAUDE.md must reference Task({run_in_background: true})');
  assert.ok(/parallel/i.test(CLAUDE_MD),
    'CLAUDE.md must use the word "parallel" to anchor the use case');
  // Reference runQueueMaxConcurrent so the agent knows the cap exists.
  assert.ok(/runQueueMaxConcurrent/.test(CLAUDE_MD),
    'CLAUDE.md must name the runQueueMaxConcurrent setting');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation: the cap arithmetic
// ──────────────────────────────────────────────────────────────────────

t('behavior: countRunning + canDispatchMore against a fake rec', () => {
  delete require.cache[require.resolve('../server/src/runQueue')];
  const runQueue = require('../server/src/runQueue');
  // Empty queue: 0 running, can dispatch.
  const rec1 = { runQueue: [] };
  assert.strictEqual(runQueue.countRunning(rec1), 0);
  assert.strictEqual(runQueue.canDispatchMore(rec1), true);

  // 2 running, cap=3 (default): can dispatch one more.
  const rec2 = { runQueue: [
    { itemId: 'fr-1', status: 'running' },
    { itemId: 'fr-2', status: 'running' },
  ]};
  assert.strictEqual(runQueue.countRunning(rec2), 2);
  assert.strictEqual(runQueue.canDispatchMore(rec2), true);

  // 3 running, cap=3 (default): can't dispatch more.
  const rec3 = { runQueue: [
    { itemId: 'fr-1', status: 'running' },
    { itemId: 'fr-2', status: 'running' },
    { itemId: 'fr-3', status: 'running' },
  ]};
  assert.strictEqual(runQueue.countRunning(rec3), 3);
  assert.strictEqual(runQueue.canDispatchMore(rec3), false);

  // Mixed statuses: only running counts.
  const rec4 = { runQueue: [
    { itemId: 'fr-1', status: 'running' },
    { itemId: 'fr-2', status: 'success' },
    { itemId: 'fr-3', status: 'pending' },
    { itemId: 'fr-4', status: 'failed' },
  ]};
  assert.strictEqual(runQueue.countRunning(rec4), 1);
  assert.strictEqual(runQueue.canDispatchMore(rec4), true);

  // Paused: never dispatch (even with 0 running).
  const rec5 = { runQueue: [], runQueuePaused: true };
  assert.strictEqual(runQueue.canDispatchMore(rec5), false);
});

t('behavior: per-session cap override via rec.runQueueMaxConcurrent', () => {
  delete require.cache[require.resolve('../server/src/runQueue')];
  const runQueue = require('../server/src/runQueue');
  // Override to 1 (serial-only — mimics pre-fr-90-Phase-2 behavior).
  const rec = { runQueue: [{ itemId: 'fr-1', status: 'running' }], runQueueMaxConcurrent: 1 };
  assert.strictEqual(runQueue.maxConcurrent(rec), 1);
  assert.strictEqual(runQueue.canDispatchMore(rec), false,
    'with cap=1 and 1 running, can\'t dispatch more (serial behavior)');
  // Override to 5 (more parallel).
  rec.runQueueMaxConcurrent = 5;
  assert.strictEqual(runQueue.maxConcurrent(rec), 5);
  assert.strictEqual(runQueue.canDispatchMore(rec), true,
    'with cap=5 and 1 running, plenty of room');
  // Defensive: cap=0 floors to 1 (would otherwise deadlock).
  rec.runQueueMaxConcurrent = 0;
  assert.strictEqual(runQueue.maxConcurrent(rec), 1,
    'cap=0 floors to 1 — defensive against deadlock');
});

t('behavior: cap defaults to 3 when rec.runQueueMaxConcurrent unset', () => {
  delete require.cache[require.resolve('../server/src/runQueue')];
  const runQueue = require('../server/src/runQueue');
  const rec = { runQueue: [] };   // no runQueueMaxConcurrent field
  assert.strictEqual(runQueue.maxConcurrent(rec), 3);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
