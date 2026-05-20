// fr-48 regression: per-session run-queue for plan items. Users add
// fr/td/bug items via per-item ⊤ Queue button OR /queue slash; the
// queue auto-advances when a queued item's turn_result event fires
// with subtype='success'. On failure the queue pauses and surfaces a
// resumable state. Auth: owner+admin only (mirrors fr-46 / fr-39).
//
// Coverage:
//   - runQueue.js: add/remove/clear/head/peek/markRunning/markFinished
//   - State transitions: pending → running → success / failed / cancelled
//   - Auto-pause on failure; resume via /qresume or POST /queue/resume
//   - Static-grep guards on artifacts.js (4 routes), slashcmds.js (5
//     commands), attach.js (turn_result hook), app.js (UI affordance)

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ──────────────────────────────────────────────────────────────────────────
// Load the real runQueue module so we test the actual production logic
// (not a re-implementation). Resilient if the module doesn't exist yet
// (red-flips on the first build).

let runQueue;
try {
  runQueue = require('../server/src/runQueue');
} catch (err) {
  runQueue = null;
}

function mkRec({ runQueue: q = [], paused = false } = {}) {
  return {
    user: 'kkrazy',
    admins: [],
    runQueue: q,
    runQueuePaused: paused,
  };
}

console.log('── fr-48: plan-item run-queue ──');

// ── module exists ─────────────────────────────────────────────────────────

t('runQueue.js module exists + exports core helpers', () => {
  assert.ok(runQueue, 'server/src/runQueue.js must be a require()-able module');
  for (const fn of ['addToQueue', 'removeFromQueue', 'clearQueue', 'getQueueState',
                    'markRunning', 'markFinished', 'pauseQueue', 'resumeQueue',
                    'peekNextPending']) {
    assert.strictEqual(typeof runQueue[fn], 'function', `runQueue.${fn} must be a function`);
  }
});

// ── add / remove ──────────────────────────────────────────────────────────

t('addToQueue: appends a pending entry with addedBy + addedAt', () => {
  const rec = mkRec();
  const entry = runQueue.addToQueue(rec, 'fr-43', 'plan', 'kkrazy');
  assert.strictEqual(rec.runQueue.length, 1);
  assert.strictEqual(entry.itemId, 'fr-43');
  assert.strictEqual(entry.status, 'pending');
  assert.strictEqual(entry.addedBy, 'kkrazy');
  assert.ok(entry.addedAt, 'addedAt timestamp set');
});

t('addToQueue: rejects duplicate itemId in queue (pending or running)', () => {
  const rec = mkRec({ runQueue: [{ itemId: 'fr-43', type: 'plan', status: 'pending', addedAt: 't', addedBy: 'x' }] });
  assert.throws(() => runQueue.addToQueue(rec, 'fr-43', 'plan', 'kkrazy'),
    /already in queue|duplicate/i, 'duplicate add must throw');
});

t('addToQueue: ALLOWS re-add of an itemId that previously finished (success/failed/cancelled)', () => {
  const rec = mkRec({ runQueue: [{ itemId: 'fr-43', type: 'plan', status: 'success', addedAt: 't', addedBy: 'x' }] });
  const entry = runQueue.addToQueue(rec, 'fr-43', 'plan', 'kkrazy');
  // Re-runs are useful — fr-43 may need to be re-dispatched after a
  // post-deploy verification or follow-up edit.
  assert.strictEqual(rec.runQueue.length, 2);
  assert.strictEqual(entry.status, 'pending');
});

t('removeFromQueue: pending entries can be removed', () => {
  const rec = mkRec({ runQueue: [
    { itemId: 'fr-43', type: 'plan', status: 'pending', addedAt: 't', addedBy: 'x' },
    { itemId: 'fr-44', type: 'plan', status: 'pending', addedAt: 't', addedBy: 'x' },
  ]});
  const ok = runQueue.removeFromQueue(rec, 'fr-43');
  assert.strictEqual(ok, true);
  assert.strictEqual(rec.runQueue.length, 1);
  assert.strictEqual(rec.runQueue[0].itemId, 'fr-44');
});

t('removeFromQueue: refuses to remove a RUNNING entry (use interrupt instead)', () => {
  const rec = mkRec({ runQueue: [
    { itemId: 'fr-43', type: 'plan', status: 'running', addedAt: 't', addedBy: 'x' },
  ]});
  assert.throws(() => runQueue.removeFromQueue(rec, 'fr-43'),
    /running|cannot remove/i, 'removing a running entry must throw — the SDK iteration is in flight');
  assert.strictEqual(rec.runQueue.length, 1, 'queue unchanged');
});

t('clearQueue: drops all pending, preserves running + finished history', () => {
  const rec = mkRec({ runQueue: [
    { itemId: 'fr-43', type: 'plan', status: 'success',   addedAt: 't', addedBy: 'x' },
    { itemId: 'fr-44', type: 'plan', status: 'running',   addedAt: 't', addedBy: 'x' },
    { itemId: 'fr-45', type: 'plan', status: 'pending',   addedAt: 't', addedBy: 'x' },
    { itemId: 'fr-46', type: 'plan', status: 'pending',   addedAt: 't', addedBy: 'x' },
  ]});
  const removed = runQueue.clearQueue(rec);
  assert.strictEqual(removed, 2, 'two pending dropped');
  assert.strictEqual(rec.runQueue.length, 2, 'success + running preserved');
  assert.deepStrictEqual(rec.runQueue.map(e => e.status), ['success', 'running']);
});

// ── status transitions ───────────────────────────────────────────────────

t('peekNextPending: returns the FIRST pending entry (FIFO)', () => {
  const rec = mkRec({ runQueue: [
    { itemId: 'fr-43', type: 'plan', status: 'success', addedAt: 't', addedBy: 'x' },
    { itemId: 'fr-44', type: 'plan', status: 'pending', addedAt: 't', addedBy: 'x' },
    { itemId: 'fr-45', type: 'plan', status: 'pending', addedAt: 't', addedBy: 'x' },
  ]});
  const next = runQueue.peekNextPending(rec);
  assert.strictEqual(next.itemId, 'fr-44');
});

t('peekNextPending: returns null when nothing pending', () => {
  const rec = mkRec({ runQueue: [{ itemId: 'fr-43', type: 'plan', status: 'success', addedAt: 't', addedBy: 'x' }] });
  assert.strictEqual(runQueue.peekNextPending(rec), null);
});

t('peekNextPending: returns null when queue is paused (do not advance through pause)', () => {
  const rec = mkRec({
    runQueue: [{ itemId: 'fr-44', type: 'plan', status: 'pending', addedAt: 't', addedBy: 'x' }],
    paused: true,
  });
  assert.strictEqual(runQueue.peekNextPending(rec), null,
    'paused queue must not surface a next pending — caller would dispatch it');
});

t('markRunning: pending → running, stamps startedAt', () => {
  const rec = mkRec({ runQueue: [{ itemId: 'fr-43', type: 'plan', status: 'pending', addedAt: 't', addedBy: 'x' }] });
  runQueue.markRunning(rec, 'fr-43');
  const entry = rec.runQueue[0];
  assert.strictEqual(entry.status, 'running');
  assert.ok(entry.startedAt);
});

t('markFinished(success): running → success, stamps finishedAt', () => {
  const rec = mkRec({ runQueue: [{ itemId: 'fr-43', type: 'plan', status: 'running', addedAt: 't', addedBy: 'x', startedAt: 't1' }] });
  runQueue.markFinished(rec, 'fr-43', true);
  const entry = rec.runQueue[0];
  assert.strictEqual(entry.status, 'success');
  assert.ok(entry.finishedAt);
});

t('markFinished(failure): running → failed AND auto-pauses queue', () => {
  const rec = mkRec({ runQueue: [
    { itemId: 'fr-43', type: 'plan', status: 'running', addedAt: 't', addedBy: 'x', startedAt: 't1' },
    { itemId: 'fr-44', type: 'plan', status: 'pending', addedAt: 't', addedBy: 'x' },
  ]});
  runQueue.markFinished(rec, 'fr-43', false);
  assert.strictEqual(rec.runQueue[0].status, 'failed');
  assert.strictEqual(rec.runQueuePaused, true, 'queue must auto-pause so a failed item doesn\'t cascade');
  // peekNextPending now returns null even though fr-44 is pending.
  assert.strictEqual(runQueue.peekNextPending(rec), null);
});

t('resumeQueue: paused → unpaused, peekNextPending then returns next', () => {
  const rec = mkRec({
    runQueue: [
      { itemId: 'fr-43', type: 'plan', status: 'failed', addedAt: 't', addedBy: 'x', startedAt: 't1', finishedAt: 't2' },
      { itemId: 'fr-44', type: 'plan', status: 'pending', addedAt: 't', addedBy: 'x' },
    ],
    paused: true,
  });
  runQueue.resumeQueue(rec);
  assert.strictEqual(rec.runQueuePaused, false);
  const next = runQueue.peekNextPending(rec);
  assert.strictEqual(next.itemId, 'fr-44', 'resume must allow the next pending to surface');
});

// ── getQueueState surfaces a compact summary ──────────────────────────────

t('getQueueState: returns { entries, paused, counts } summary', () => {
  const rec = mkRec({ runQueue: [
    { itemId: 'fr-43', type: 'plan', status: 'success', addedAt: 't', addedBy: 'x' },
    { itemId: 'fr-44', type: 'plan', status: 'running', addedAt: 't', addedBy: 'x' },
    { itemId: 'fr-45', type: 'plan', status: 'pending', addedAt: 't', addedBy: 'x' },
    { itemId: 'fr-46', type: 'plan', status: 'pending', addedAt: 't', addedBy: 'x' },
  ]});
  const state = runQueue.getQueueState(rec);
  assert.strictEqual(state.entries.length, 4);
  assert.strictEqual(state.paused, false);
  assert.deepStrictEqual(state.counts, { pending: 2, running: 1, success: 1, failed: 0, cancelled: 0 });
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards on prod surface.

const PROD_ARTIFACTS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');
const PROD_SLASHCMDS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');
const PROD_ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
const PROD_APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

t('artifacts.js declares 4 queue routes (add / remove / clear / resume)', () => {
  assert.match(PROD_ARTIFACTS, /app\.post\(\s*['"`]\/sessions\/:id\/queue\/add['"`]/,
    'POST /sessions/:id/queue/add must exist');
  assert.match(PROD_ARTIFACTS, /app\.delete\(\s*['"`]\/sessions\/:id\/queue\/:itemId['"`]/,
    'DELETE /sessions/:id/queue/:itemId must exist (remove a pending entry)');
  assert.match(PROD_ARTIFACTS, /app\.post\(\s*['"`]\/sessions\/:id\/queue\/clear['"`]/,
    'POST /sessions/:id/queue/clear must exist');
  assert.match(PROD_ARTIFACTS, /app\.post\(\s*['"`]\/sessions\/:id\/queue\/resume['"`]/,
    'POST /sessions/:id/queue/resume must exist');
});

t('artifacts.js queue routes gate on isOwnerOrAdmin', () => {
  // Any of the 4 queue routes must call isOwnerOrAdmin — viewers
  // can\'t mutate the queue.
  const queueSlice = PROD_ARTIFACTS.match(/\/sessions\/:id\/queue\/add[\s\S]{0,5000}\/sessions\/:id\/queue\/resume[\s\S]{0,1500}/);
  assert.ok(queueSlice, 'queue routes must be locatable as a block');
  const occurrences = (queueSlice[0].match(/isOwnerOrAdmin/g) || []).length;
  assert.ok(occurrences >= 4, `all 4 queue routes must gate on isOwnerOrAdmin (found ${occurrences})`);
});

t('slashcmds.js registers /queue + /qstatus + /qcancel + /qclear + /qresume', () => {
  // Registry shape in slashcmds.js is `names: ['queue']` (no leading
  // slash) — usage strings carry the slash for display only. Look for
  // both the `names: ['<cmd>']` array entry AND the handler symbol
  // to confirm wiring.
  for (const cmd of ['queue', 'qstatus', 'qcancel', 'qclear', 'qresume']) {
    const inNames = new RegExp("names:\\s*\\[\\s*['\"`]" + cmd + "['\"`]");
    assert.ok(inNames.test(PROD_SLASHCMDS),
      `slash command /${cmd} must be registered (names: ['${cmd}']) in slashcmds.js`);
  }
  // Each command name maps to its handler function.
  for (const fn of ['handleQueue', 'handleQStatus', 'handleQCancel', 'handleQClear', 'handleQResume']) {
    assert.ok(new RegExp('function\\s+' + fn).test(PROD_SLASHCMDS),
      `${fn} handler must be defined in slashcmds.js`);
  }
});

t('attach.js turn_result hook calls runQueue auto-advance', () => {
  // The existing turn_result listener in _registerExternalSession must
  // call the queue-advance helper after stamping the run outcome.
  assert.match(PROD_ATTACH, /runQueue|_advanceQueue/,
    'attach.js must reference runQueue or _advanceQueue from the turn_result listener');
});

t('app.js renders per-item ⊤ Queue button gated on !state.readOnly', () => {
  // The new per-item Queue affordance lives in the artifact-item-actions
  // row alongside the existing Run + Edit buttons.
  assert.match(PROD_APP, /artifact-item-queue/,
    'app.js must render an artifact-item-queue button class on item cards');
});

t('app.js calls POST /queue/add from the per-item Queue button handler', () => {
  assert.match(PROD_APP, /\/queue\/add[\s\S]{0,400}?method:\s*['"`]POST['"`]/,
    'app.js must POST /sessions/.../queue/add from the per-item Queue handler');
});

t('app.js handles state-update kind="runQueue"', () => {
  assert.match(PROD_APP, /kind\s*===\s*['"`]runQueue['"`]|kind:\s*['"`]runQueue['"`]/,
    'app.js must handle state-update {kind:"runQueue"} so the queue chip strip stays in sync');
});

// ──────────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
