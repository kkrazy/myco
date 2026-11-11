// run-queue enhancement: per-item RERUN (↻) + per-item CANCEL (⏹ on a
// running entry). Complements the pre-existing DELETE /queue/:itemId
// (pending/terminal removal, refuses running) with:
//   - POST /queue/:itemId/rerun  — re-dispatch a failed/cancelled entry
//     as a FRESH pending entry (the prior record stays for audit), or a
//     pending entry directly; dispatched immediately when the queue is
//     idle, 409 if another entry is already running (single-slot).
//   - POST /queue/:itemId/cancel — interrupt the SDK iteration of a
//     RUNNING entry + mark it cancelled (does NOT auto-pause the queue,
//     unlike markFinished(false)); non-running entries are dropped.
//
// Coverage:
//   - runQueue.markCancelled: running → cancelled, no auto-pause
//   - static-grep guards: both new routes in artifacts.js (owner/admin
//     gated), client button classes + handlers in app.js, CSS classes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

let runQueue;
try { runQueue = require('../server/src/runQueue'); } catch (err) { runQueue = null; }

function mkRec({ runQueue: q = [], paused = false } = {}) {
  return { user: 'kkrazy', admins: [], runQueue: q, runQueuePaused: paused };
}

console.log('── run-queue: per-item rerun + cancel ──');

// ── exports ───────────────────────────────────────────────────────────────

t('runQueue.js exports markCancelled + TERMINAL_STATUSES', () => {
  assert.ok(runQueue, 'server/src/runQueue.js must be require()-able');
  assert.strictEqual(typeof runQueue.markCancelled, 'function', 'runQueue.markCancelled must be a function');
  assert.strictEqual(typeof runQueue.removeFinished, 'function', 'runQueue.removeFinished must be a function');
  assert.ok(runQueue.TERMINAL_STATUSES instanceof Set, 'TERMINAL_STATUSES must be a Set');
  assert.ok(runQueue.TERMINAL_STATUSES.has('failed'), 'failed is terminal');
  assert.ok(runQueue.TERMINAL_STATUSES.has('cancelled'), 'cancelled is terminal');
  assert.ok(runQueue.TERMINAL_STATUSES.has('success'), 'success is terminal');
  assert.ok(!runQueue.TERMINAL_STATUSES.has('pending'), 'pending is not terminal');
  assert.ok(!runQueue.TERMINAL_STATUSES.has('running'), 'running is not terminal');
});

// ── markCancelled ─────────────────────────────────────────────────────────

t('markCancelled: running → cancelled, stamps finishedAt', () => {
  const rec = mkRec({ runQueue: [
    { itemId: 'fr-43', type: 'plan', status: 'running', addedAt: 't', addedBy: 'x', startedAt: 't1' },
    { itemId: 'fr-44', type: 'plan', status: 'pending', addedAt: 't', addedBy: 'x' },
  ]});
  const entry = runQueue.markCancelled(rec, 'fr-43');
  assert.ok(entry, 'markCancelled must return the updated entry');
  assert.strictEqual(entry.status, 'cancelled');
  assert.ok(entry.finishedAt, 'finishedAt stamped on cancel');
  // The user stopped THIS task, not the whole pipeline — queue must NOT
  // auto-pause, so the next pending entry may still advance on the turn
  // that follows.
  assert.strictEqual(rec.runQueuePaused, false, 'per-item cancel must NOT auto-pause the queue');
  assert.strictEqual(runQueue.peekNextPending(rec).itemId, 'fr-44', 'next pending still surfaces');
});

t('markCancelled: no-op (null) when itemId is not running', () => {
  const rec = mkRec({ runQueue: [
    { itemId: 'fr-43', type: 'plan', status: 'pending', addedAt: 't', addedBy: 'x' },
    { itemId: 'fr-44', type: 'plan', status: 'success', addedAt: 't', addedBy: 'x' },
  ]});
  assert.strictEqual(runQueue.markCancelled(rec, 'fr-43'), null, 'pending entry untouched');
  assert.strictEqual(runQueue.markCancelled(rec, 'fr-44'), null, 'success entry untouched');
  assert.strictEqual(runQueue.markCancelled(rec, 'does-not-exist'), null, 'missing entry untouched');
  assert.strictEqual(rec.runQueue.length, 2, 'no entries added/removed');
});

t('removeFinished: wipes terminal (success/failed/cancelled), keeps running + pending', () => {
  const rec = mkRec({ runQueue: [
    { itemId: 'a', type: 'plan', status: 'success',   addedAt: 't', addedBy: 'x' },
    { itemId: 'b', type: 'plan', status: 'failed',    addedAt: 't', addedBy: 'x' },
    { itemId: 'c', type: 'plan', status: 'cancelled', addedAt: 't', addedBy: 'x' },
    { itemId: 'd', type: 'plan', status: 'running',   addedAt: 't', addedBy: 'x' },
    { itemId: 'e', type: 'plan', status: 'pending',   addedAt: 't', addedBy: 'x' },
  ]});
  const removed = runQueue.removeFinished(rec);
  assert.strictEqual(removed, 3, 'three terminal entries dropped');
  assert.deepStrictEqual(rec.runQueue.map(e => e.status), ['running', 'pending'],
    'running + pending must survive a clear-finished');
});

t('getQueueState: cancelled counted separately from failed', () => {
  const rec = mkRec({ runQueue: [
    { itemId: 'fr-43', type: 'plan', status: 'failed',    addedAt: 't', addedBy: 'x' },
    { itemId: 'fr-44', type: 'plan', status: 'cancelled', addedAt: 't', addedBy: 'x' },
    { itemId: 'fr-45', type: 'plan', status: 'pending',   addedAt: 't', addedBy: 'x' },
  ]});
  const state = runQueue.getQueueState(rec);
  assert.deepStrictEqual(state.counts, { pending: 1, running: 0, success: 0, failed: 1, cancelled: 1 });
});

// ── static-grep guards on prod surface ────────────────────────────────────

const PROD_ARTIFACTS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');
const PROD_APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const PROD_CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

t('artifacts.js declares the rerun + cancel routes (owner/admin gated)', () => {
  // rerun route + its isOwnerOrAdmin guard + markRunning dispatch.
  assert.match(PROD_ARTIFACTS, /app\.post\(\s*['"`]\/sessions\/:id\/queue\/:itemId\/rerun['"`]/,
    'POST /sessions/:id/queue/:itemId/rerun must exist');
  // cancel route + its running-entry interrupt path.
  assert.match(PROD_ARTIFACTS, /app\.post\(\s*['"`]\/sessions\/:id\/queue\/:itemId\/cancel['"`]/,
    'POST /sessions/:id/queue/:itemId/cancel must exist');
  // one-click clear-finished route (wipe terminal, keep running + pending).
  assert.match(PROD_ARTIFACTS, /app\.post\(\s*['"`]\/sessions\/:id\/queue\/clear-finished['"`]/,
    'POST /sessions/:id/queue/clear-finished must exist');
  assert.match(PROD_ARTIFACTS, /runQueue\.removeFinished\(ctx\.rec\)/,
    'clear-finished route must call runQueue.removeFinished');
  const pair = PROD_ARTIFACTS.match(/\/:itemId\/rerun[\s\S]{0,3200}\/:itemId\/cancel[\s\S]{0,1400}/);
  assert.ok(pair, 'rerun + cancel routes must be locatable as a block');
  assert.ok((pair[0].match(/isOwnerOrAdmin/g) || []).length >= 2,
    'both rerun + cancel routes must gate on isOwnerOrAdmin');
});

t('artifacts.js rerun route creates a FRESH entry for terminal statuses', () => {
  // A re-run of a terminal (failed/cancelled) entry must go through
  // addToQueue (which appends a fresh pending entry, keeping the old one
  // for audit) rather than blindly reusing markRunning on the old entry.
  // Guard on the TERMINAL_STATUSES handoff + addToQueue call in the route.
  assert.match(PROD_ARTIFACTS, /TERMINAL_STATUSES\.has\(entry\.status\)/,
    'rerun route must branch on TERMINAL_STATUSES to detect a terminal entry');
  assert.match(PROD_ARTIFACTS, /addToQueue\(ctx\.rec, entry\.itemId, entry\.type, user\)/,
    'rerun route must re-add a terminal entry as a fresh pending via addToQueue');
});

t('artifacts.js cancel route interrupts a running SDK iteration + markCancelled', () => {
  // stop-vs-run-n2 (2026-10-22): the route now ALSO stops a live
  // compare-lanes shadow lane (stopN2Lane) before interrupting the main
  // session, which pushed markCancelled past the old 1400-char window.
  const block = PROD_ARTIFACTS.match(/\/:itemId\/cancel[\s\S]{0,2000}/);
  assert.ok(block, 'cancel route must be locatable');
  assert.match(block[0], /session\.interrupt/, 'cancel route must call session.interrupt() on a running entry');
  assert.match(block[0], /stopN2Lane/, 'cancel route must stop a live n2 shadow lane (lane-dispatched runs iterate a shadow TeamSession)');
  assert.match(block[0], /markCancelled\(ctx\.rec, itemId\)/, 'cancel route must markCancelled');
});

t('app.js renders the ↻ rerun + ⏹ cancel-run buttons and calls the new endpoints', () => {
  for (const cls of ['runqueue-rerun', 'runqueue-cancel-run']) {
    assert.ok(new RegExp("classList\\.contains\\('" + cls + "'\\)|querySelectorAll\\('\\." + cls + "'\\)").test(PROD_APP)
      || PROD_APP.indexOf("'." + cls + "'") !== -1,
      `app.js must wire the .${cls} button class`);
  }
  for (const fn of ['onArtifactQueueRerun', 'onArtifactQueueCancelRunning']) {
    assert.ok(new RegExp('function\\s+' + fn).test(PROD_APP), `${fn} handler must be defined in app.js`);
  }
  assert.match(PROD_APP, /\/queue\/\$\{encodeURIComponent\(itemId\)\}\/rerun/,
    'onArtifactQueueRerun must POST /sessions/:id/queue/:id/rerun');
  assert.match(PROD_APP, /\/queue\/\$\{encodeURIComponent\(itemId\)\}\/cancel/,
    'onArtifactQueueCancelRunning must POST /sessions/:id/queue/:id/cancel');
});

t('app.js wires the one-click clear-finished button + renderChip buttons on success', () => {
  assert.ok(/function\s+onArtifactQueueClearFinished/.test(PROD_APP),
    'onArtifactQueueClearFinished handler must be defined in app.js');
  assert.match(PROD_APP, /\/queue\/clear-finished/,
    'onArtifactQueueClearFinished must POST /sessions/:id/queue/clear-finished');
  assert.match(PROD_APP, /runqueue-clear-fin/,
    'app.js must render the .runqueue-clear-fin "一键清空已结束" button');
  // Every finished status (incl. success) must be actionable: the chip
  // renderer falls through to a ↻ rerun + × delete for success/failed/
  // cancelled (user saw NO buttons on a lone success chip — fr-107).
  // Scope the search to _renderRunQueueStrip — there are multiple
  // renderChip renderers elsewhere in app.js.
  const stripAt = PROD_APP.search(/function _renderRunQueueStrip\(/);
  assert.ok(stripAt !== -1, '_renderRunQueueStrip must be locatable');
  const stripBody = PROD_APP.slice(stripAt, stripAt + 4000);
  assert.ok(stripBody.includes('runqueue-rerun') && stripBody.includes('runqueue-cancel'),
    '_renderRunQueueStrip renderChip must attach ↻ rerun + × delete on terminal entries (success/failed/cancelled)');
});

t('styles.css styles the rerun + cancel-run + clear-fin buttons', () => {
  for (const cls of ['.runqueue-rerun', '.runqueue-cancel-run', '.runqueue-clear-fin']) {
    assert.ok(PROD_CSS.indexOf(cls) !== -1, `styles.css must contain a rule for ${cls}`);
  }
});

// ──────────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
