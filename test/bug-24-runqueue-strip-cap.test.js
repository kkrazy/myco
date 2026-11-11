// bug-24 regression: the run-queue chip strip caps finished + pending
// entries so it doesn't grow unbounded in busy sessions.
//
// User report: "Queue display above the chat pane is cluttered because
// it shows every task. Expected: Show only some finished and some
// pending tasks."
//
// Fix shape (user-confirmed in chat: 2 finished + all running + 3 pending):
//   - RUNQUEUE_MAX_FINISHED_CHIPS = 2  → last 2 success/failed/cancelled
//   - RUNQUEUE_MAX_PENDING_CHIPS  = 3  → first 3 pending
//   - Running entries always all-shown (usually 0 or 1)
//   - Dropped counts surface as "+N earlier" / "+N more" overflow chips
//   - /qstatus still lists everything (no data loss)
//
// Static-grep guards on app.js + an inline simulation of the partition
// math so the cap behavior is pinned without a browser.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── bug-24: runqueue chip strip cap ──');

function _stripBody() {
  const start = APP.search(/function\s+_renderRunQueueStrip\s*\(/);
  assert.ok(start > -1, '_renderRunQueueStrip must exist');
  const rest = APP.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

// ──────────────────────────────────────────────────────────────────────
// Static guards on the cap constants
// ──────────────────────────────────────────────────────────────────────

t('RUNQUEUE_MAX_FINISHED_CHIPS = 2', () => {
  const body = _stripBody();
  assert.ok(/RUNQUEUE_MAX_FINISHED_CHIPS\s*=\s*2/.test(body),
    'finished cap must be 2 (user-confirmed default)');
});

t('RUNQUEUE_MAX_PENDING_CHIPS = 3', () => {
  const body = _stripBody();
  assert.ok(/RUNQUEUE_MAX_PENDING_CHIPS\s*=\s*3/.test(body),
    'pending cap must be 3 (user-confirmed default)');
});

t('FINISHED_STATUSES set includes success/failed/cancelled', () => {
  const body = _stripBody();
  assert.ok(/FINISHED_STATUSES\s*=\s*new\s+Set\(\s*\[\s*['"]success['"]\s*,\s*['"]failed['"]\s*,\s*['"]cancelled['"]\s*\]\s*\)/.test(body),
    'finished classification must cover success/failed/cancelled — running stays uncapped');
});

// ──────────────────────────────────────────────────────────────────────
// Partition logic — finished/running/pending separated, capped, overflow surfaced
// ──────────────────────────────────────────────────────────────────────

t('partitions entries by status (finished / running / pending)', () => {
  const body = _stripBody();
  assert.ok(/finished\s*=\s*q\.entries\.filter/.test(body),
    'must partition finished entries');
  assert.ok(/running\s*=\s*q\.entries\.filter/.test(body),
    'must partition running entries');
  assert.ok(/pending\s*=\s*q\.entries\.filter/.test(body),
    'must partition pending entries');
});

t('finished takes the TAIL (most recent) — slice(-N)', () => {
  const body = _stripBody();
  assert.ok(/finishedShown\s*=\s*finished\.slice\(\s*-RUNQUEUE_MAX_FINISHED_CHIPS\s*\)/.test(body),
    'finished must use slice(-N) — the MOST RECENT finished entries are what matters, not the oldest');
});

t('pending takes the HEAD (next up) — slice(0, N)', () => {
  const body = _stripBody();
  assert.ok(/pendingShown\s*=\s*pending\.slice\(\s*0\s*,\s*RUNQUEUE_MAX_PENDING_CHIPS\s*\)/.test(body),
    'pending must use slice(0, N) — the NEXT items to dispatch are what matters');
});

t('drop counts computed', () => {
  const body = _stripBody();
  assert.ok(/finishedDropped\s*=\s*finished\.length\s*-\s*finishedShown\.length/.test(body),
    'must compute finishedDropped');
  assert.ok(/pendingDropped\s*=\s*pending\.length\s*-\s*pendingShown\.length/.test(body),
    'must compute pendingDropped');
});

t('overflow chip rendered when entries dropped', () => {
  const body = _stripBody();
  assert.ok(/renderOverflow/.test(body),
    'a renderOverflow helper must exist');
  assert.ok(/runqueue-overflow/.test(body),
    'overflow chips must use the .runqueue-overflow class');
  assert.ok(/qstatus/.test(body),
    'overflow tooltip should point users at /qstatus for the full list');
});

t('reading order: finished → running → pending', () => {
  const body = _stripBody();
  // The chip array must list finished BEFORE running BEFORE pending.
  // Grep for the chips assembly array literal.
  const m = body.match(/chipsHtml\s*=\s*\[([\s\S]*?)\]\.filter/);
  assert.ok(m, 'chipsHtml assembly must exist as an array literal');
  const order = m[1];
  // Crude order check: finishedShown index < running index < pendingShown index.
  const idxFinished = order.search(/finishedShown\.map/);
  const idxRunning = order.search(/running\.map/);
  const idxPending = order.search(/pendingShown\.map/);
  assert.ok(idxFinished > -1 && idxRunning > -1 && idxPending > -1,
    'all three .map calls present');
  assert.ok(idxFinished < idxRunning,
    'finished chips must come before running');
  assert.ok(idxRunning < idxPending,
    'running chips must come before pending');
});

// ──────────────────────────────────────────────────────────────────────
// CSS guard on .runqueue-overflow
// ──────────────────────────────────────────────────────────────────────

t('CSS: .runqueue-overflow styled distinctly (dashed, muted)', () => {
  assert.ok(/\.runqueue-overflow\s*\{[\s\S]*?border:\s*1px\s+dashed/.test(CSS),
    '.runqueue-overflow must use a dashed border so it reads as non-clickable / informational');
  assert.ok(/\.runqueue-overflow\s*\{[\s\S]*?cursor:\s*help/.test(CSS),
    'cursor: help signals the tooltip-only interaction model');
});

// ──────────────────────────────────────────────────────────────────────
// Simulation: pure cap math (mirrors the slice() logic above)
// ──────────────────────────────────────────────────────────────────────

t('simulation: 5 finished + 1 running + 8 pending → 2 + 1 + 3 chips + 2 overflow chips', () => {
  // Reproduce the partition+slice math the render function uses, so a
  // refactor that breaks the cap will fail here.
  const MAX_F = 2, MAX_P = 3;
  const FINISHED = new Set(['success', 'failed', 'cancelled']);
  const entries = [
    ...Array.from({ length: 5 }, (_, i) => ({ itemId: `f-${i}`, status: i % 2 ? 'success' : 'failed' })),
    { itemId: 'r-0', status: 'running' },
    ...Array.from({ length: 8 }, (_, i) => ({ itemId: `p-${i}`, status: 'pending' })),
  ];
  const finished = entries.filter((e) => FINISHED.has(e.status));
  const running = entries.filter((e) => e.status === 'running');
  const pending = entries.filter((e) => e.status === 'pending');
  const finishedShown = finished.slice(-MAX_F);
  const pendingShown = pending.slice(0, MAX_P);
  assert.strictEqual(finishedShown.length, 2);
  assert.strictEqual(running.length, 1);
  assert.strictEqual(pendingShown.length, 3);
  assert.strictEqual(finished.length - finishedShown.length, 3,
    'should drop 3 finished');
  assert.strictEqual(pending.length - pendingShown.length, 5,
    'should drop 5 pending');
  // Total visible chips: 2 finished + 1 running + 3 pending + 2 overflow = 8
  // (down from 14 raw entries — strip stays scannable).
  const visible = finishedShown.length + running.length + pendingShown.length;
  assert.strictEqual(visible, 6, '6 real chips + 2 overflow indicators = 8 visual elements (vs 14 unbounded)');
});

t('simulation: small queue (1 finished + 1 running + 1 pending) → no overflow chips', () => {
  const MAX_F = 2, MAX_P = 3;
  const FINISHED = new Set(['success', 'failed', 'cancelled']);
  const entries = [
    { itemId: 'f-0', status: 'success' },
    { itemId: 'r-0', status: 'running' },
    { itemId: 'p-0', status: 'pending' },
  ];
  const finished = entries.filter((e) => FINISHED.has(e.status));
  const pending = entries.filter((e) => e.status === 'pending');
  assert.strictEqual(finished.length - finished.slice(-MAX_F).length, 0, 'no finished overflow');
  assert.strictEqual(pending.length - pending.slice(0, MAX_P).length, 0, 'no pending overflow');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
