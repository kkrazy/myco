// fr-48 bugfix: prevent + recover from stuck-running queue entries.
//
// User report: /qstatus shows "bug-16 running" but claude is idle.
// Root causes:
//   1. attach.js agent-event listener only handles turn_result — when
//      the iteration aborts (Stop button) or fatals (rate-limit retry
//      exhausted), the queue's running entry stays as 'running'
//      forever because the listener short-circuits on
//      ev.type !== 'turn_result'.
//   2. runQueue.removeFromQueue refuses to remove a running entry,
//      so /qcancel has no escape hatch for the stuck state.
//
// Fixes:
//   * attach.js listener now also handles iteration_aborted + fatal,
//     calling _advanceRunQueue with the event (queue sees subtype
//     !== 'success', marks failed, auto-pauses).
//   * runQueue.removeFromQueue allows removing a running entry with a
//     `{force:true}` option. /qcancel passes force when the user
//     explicitly invokes it — the assumption is the user knows the
//     SDK isn't actually doing work for that entry (stuck-state
//     recovery). Default (no force) preserves the safety-by-default
//     behavior for callers that don't opt in.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const runQueue = require('../server/src/runQueue');

function mkRec(entries = []) {
  return { user: 'kkrazy', admins: [], runQueue: entries.slice(), runQueuePaused: false };
}

console.log('── fr-48 stuck-running recovery + iteration_aborted/fatal handling ──');

// ── runQueue: removeFromQueue accepts {force:true} for running entries ───

t('removeFromQueue: WITHOUT force, refuses running entry (existing safety)', () => {
  const rec = mkRec([{ itemId: 'bug-16', type: 'plan', status: 'running', addedAt: 't', addedBy: 'x' }]);
  assert.throws(() => runQueue.removeFromQueue(rec, 'bug-16'),
    /running|cannot remove/i, 'default removeFromQueue still throws on running entry');
  assert.strictEqual(rec.runQueue.length, 1, 'entry preserved on refusal');
});

t('removeFromQueue: WITH {force:true}, removes a stuck running entry', () => {
  const rec = mkRec([{ itemId: 'bug-16', type: 'plan', status: 'running', addedAt: 't', addedBy: 'x' }]);
  const ok = runQueue.removeFromQueue(rec, 'bug-16', { force: true });
  assert.strictEqual(ok, true);
  assert.strictEqual(rec.runQueue.length, 0, 'stuck running entry recoverable via force flag');
});

t('removeFromQueue: {force:true} on pending entry works same as default', () => {
  const rec = mkRec([{ itemId: 'bug-1', type: 'plan', status: 'pending', addedAt: 't', addedBy: 'x' }]);
  const ok = runQueue.removeFromQueue(rec, 'bug-1', { force: true });
  assert.strictEqual(ok, true);
  assert.strictEqual(rec.runQueue.length, 0);
});

t('removeFromQueue: returns false for unknown id regardless of force', () => {
  const rec = mkRec([]);
  assert.strictEqual(runQueue.removeFromQueue(rec, 'nope'), false);
  assert.strictEqual(runQueue.removeFromQueue(rec, 'nope', { force: true }), false);
});

// ── static-grep guards on attach.js listener + slashcmds.js /qcancel ─────

const PROD_ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
const PROD_SLASHCMDS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');

t('attach.js agent-event listener handles iteration_aborted + fatal as queue-terminal', () => {
  // Find the listener body around _advanceRunQueue. Should now branch
  // on multiple event types, not just turn_result.
  const idx = PROD_ATTACH.indexOf('_advanceRunQueue');
  assert.ok(idx > -1, '_advanceRunQueue call site must exist');
  const window = PROD_ATTACH.slice(Math.max(0, idx - 2000), idx + 800);
  assert.ok(/iteration_aborted/.test(window),
    'agent-event listener must reference iteration_aborted (terminal event for queue)');
  assert.ok(/fatal/.test(window),
    'agent-event listener must reference fatal (terminal event for queue)');
});

t('slashcmds.js /qcancel passes force:true so stuck-running entries are recoverable', () => {
  const start = PROD_SLASHCMDS.search(/function\s+handleQCancel\s*\(/);
  assert.ok(start > -1, 'handleQCancel must exist');
  const rest = PROD_SLASHCMDS.slice(start);
  const next = rest.slice(1).search(/\nfunction\s+/);
  const body = next === -1 ? rest : rest.slice(0, next + 1);
  assert.ok(/force:\s*true|\{\s*force:\s*true\s*\}/.test(body),
    'handleQCancel must call removeFromQueue with {force:true} so a stuck running entry can be recovered via /qcancel');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
