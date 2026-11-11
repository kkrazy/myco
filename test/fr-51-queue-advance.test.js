// fr-51 regression: the run-queue must advance on TWO surfaces that
// currently leak past the auto-advance:
//
//   (1) /qcancel on a running head removes the entry but does NOT
//       dispatch the next pending. Live repro in events.jsonl
//       /sessions.json showed bug-13 cancelled at 20:23:57 leaving
//       bug-12..fr-49 (5 pendings) sitting idle indefinitely.
//
//   (2) When `turn_result` (or iteration_aborted / fatal) fires, the
//       agent-event listener at server/src/attach.js short-circuits if
//       session._activeRunItem is null/undefined — even when the
//       queue clearly has a `running` entry that just finished. The
//       fix: fall back to the queue's running entry as the source of
//       truth so a stale/cleared _activeRunItem can't leave the queue
//       stuck. Diagnostic log captured every time the fallback fires.
//
// These two surfaces are the user-reported failure modes from the
// bug-13 dispatch in session myco-kkrazy-f80476dd (see fr-51 comments
// for the live timeline). Both have STATIC-GREP guards on prod source
// + a few BEHAVIOR tests that exercise the underlying primitives
// against an in-memory fake rec.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const SLASHCMDS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');
const ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
const AGENT_SESSION = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');

console.log('── fr-51: run-queue must advance after /qcancel + on turn_result fallback ──');

// ──────────────────────────────────────────────────────────────────────
// Mode (1) — /qcancel auto-advance
// ──────────────────────────────────────────────────────────────────────

t('static guard: handleQCancel calls peekNextPending after the cancel', () => {
  // Extract the handleQCancel function body.
  const start = SLASHCMDS.search(/function\s+handleQCancel\s*\(/);
  assert.ok(start > -1, 'handleQCancel must exist in slashcmds.js');
  const rest = SLASHCMDS.slice(start);
  const next = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = next === -1 ? rest : rest.slice(0, next + 1);
  // The fix MUST call peekNextPending so the queue advances after the
  // cancel removes the running head. Pre-fix the function just replied
  // ✓ Cancelled and returned, leaving the queue idle indefinitely.
  assert.ok(/peekNextPending\s*\(/.test(body),
    'handleQCancel must call runQueue.peekNextPending so the cancel auto-advances to the next pending entry');
});

t('static guard: handleQCancel dispatches the next pending via buildArtifactRunText', () => {
  const start = SLASHCMDS.search(/function\s+handleQCancel\s*\(/);
  const rest = SLASHCMDS.slice(start);
  const next = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = next === -1 ? rest : rest.slice(0, next + 1);
  // The actual dispatch is markRunning + handleChatMessage(buildArtifactRunText(...))
  // — same shape handleQResume uses.
  assert.ok(/markRunning\s*\(/.test(body),
    'handleQCancel must call runQueue.markRunning on the next pending entry before dispatch');
  assert.ok(/buildArtifactRunText\s*\(/.test(body),
    'handleQCancel must construct the dispatch text via buildArtifactRunText so the [run:plan#<id>] marker is present');
  assert.ok(/handleChatMessage\s*\(/.test(body),
    'handleQCancel must invoke handleChatMessage to actually send the dispatch text into the chat path');
});

t('behavior: after removing the running head the queue exposes the next pending', () => {
  // Exercise runQueue primitives — these are the source of truth the
  // /qcancel fix builds on.
  const runQueue = require('../server/src/runQueue');
  const rec = {
    runQueue: [
      { itemId: 'bug-A', type: 'plan', status: 'running', addedAt: 't0', startedAt: 't1' },
      { itemId: 'bug-B', type: 'plan', status: 'pending', addedAt: 't0' },
      { itemId: 'bug-C', type: 'plan', status: 'pending', addedAt: 't0' },
    ],
    runQueuePaused: false,
  };
  const removed = runQueue.removeFromQueue(rec, 'bug-A', { force: true });
  assert.strictEqual(removed, true, 'force-remove of running head succeeds');
  assert.strictEqual(rec.runQueue.length, 2, 'two entries remain');
  const next = runQueue.peekNextPending(rec);
  assert.ok(next, 'next pending entry is exposed');
  assert.strictEqual(next.itemId, 'bug-B', 'first pending entry is bug-B');
});

t('behavior: paused queue does NOT surface a next pending after cancel', () => {
  // If the queue is paused (e.g. a prior failure auto-paused it),
  // /qcancel should not silently dispatch — the user must /qresume
  // explicitly. peekNextPending returns null when paused.
  const runQueue = require('../server/src/runQueue');
  const rec = {
    runQueue: [
      { itemId: 'bug-A', type: 'plan', status: 'running', addedAt: 't0', startedAt: 't1' },
      { itemId: 'bug-B', type: 'plan', status: 'pending', addedAt: 't0' },
    ],
    runQueuePaused: true,
  };
  runQueue.removeFromQueue(rec, 'bug-A', { force: true });
  assert.strictEqual(runQueue.peekNextPending(rec), null,
    'paused queue must NOT surface a next pending — /qcancel respects pause state');
});

// ──────────────────────────────────────────────────────────────────────
// Mode (2) — agent-event listener falls back to the queue's running
// entry when _activeRunItem is unexpectedly null/undefined.
// ──────────────────────────────────────────────────────────────────────

t('static guard: agent-event listener has a fallback when _activeRunItem is null', () => {
  // The listener at attach.js:140-178 used to early-return on
  // !active. The fix adds a fallback: use the queue's running entry
  // as the active id source. The static-grep guards look for the
  // fallback marker comment + a lookup of the queue's running entry.
  // We anchor on a stable marker string we add in the fix so this
  // guard isn't sensitive to formatting drift.
  assert.ok(/fr-51.*fallback|fallback.*fr-51|fr-51.*belt|belt.*fr-51/i.test(ATTACH),
    'attach.js must carry the fr-51 fallback marker so the next reviewer sees what defends the queue advance');
  // Either the listener walks rec.runQueue for status==='running', OR
  // it calls a helper that does. The simplest grep: in a 600-char
  // window around 'runningEntry' we should see _activeRunItem.
  const idx = ATTACH.search(/runningEntry|runQueue\.find\([^)]*status[^)]*running/);
  assert.ok(idx > -1, 'attach.js must look up the queue running entry as a fallback active-id source');
  const window = ATTACH.slice(Math.max(0, idx - 600), idx + 600);
  assert.ok(/_activeRunItem|activeRunItem/.test(window),
    'the queue-running-entry fallback must be wired into the _activeRunItem code path');
});

t('static guard: diag log fires when the fallback is used', () => {
  // Whenever the fallback fires (meaning _activeRunItem was lost for
  // unknown reasons), log it so we can root-cause the underlying
  // staleness in a follow-up pass. Grep for the [runQueue-diag] marker
  // mentioned in the fix's design note.
  assert.ok(/\[runQueue-diag\]/.test(ATTACH),
    'attach.js must emit a [runQueue-diag] log line when the fallback is taken so the root cause can be tracked');
});

t('behavior: queue exposes the running entry that the fallback would pick up', () => {
  // The fallback works because rec.runQueue carries a status='running'
  // entry whenever the queue dispatched something. Verify the find
  // expression used by the fallback returns the right entry.
  const rec = {
    runQueue: [
      { itemId: 'old-A', type: 'plan', status: 'success', addedAt: 't0', startedAt: 't1', finishedAt: 't2' },
      { itemId: 'now-B', type: 'plan', status: 'running', addedAt: 't3', startedAt: 't4' },
      { itemId: 'next-C', type: 'plan', status: 'pending', addedAt: 't5' },
    ],
  };
  const runningEntry = rec.runQueue.find((e) => e && e.status === 'running');
  assert.ok(runningEntry, 'running entry is findable');
  assert.strictEqual(runningEntry.itemId, 'now-B', 'fallback picks the current running head');
});

t('behavior: no running entry → fallback returns null (truly nothing to advance)', () => {
  const rec = {
    runQueue: [
      { itemId: 'old-A', type: 'plan', status: 'success', addedAt: 't0' },
      { itemId: 'next-C', type: 'plan', status: 'pending', addedAt: 't5' },
    ],
  };
  const runningEntry = rec.runQueue.find((e) => e && e.status === 'running');
  assert.strictEqual(runningEntry, undefined,
    'when nothing is running, the fallback finds nothing and the listener correctly returns');
});

t('behavior: markFinished + peekNextPending together advance the queue', () => {
  // End-to-end check on the runQueue primitives: simulate the fallback
  // path — find running entry, markFinished success, peek next pending.
  const runQueue = require('../server/src/runQueue');
  const rec = {
    runQueue: [
      { itemId: 'now-B', type: 'plan', status: 'running', addedAt: 't0', startedAt: 't1' },
      { itemId: 'next-C', type: 'plan', status: 'pending', addedAt: 't2' },
    ],
    runQueuePaused: false,
  };
  const runningEntry = rec.runQueue.find((e) => e && e.status === 'running');
  const finished = runQueue.markFinished(rec, runningEntry.itemId, true);
  assert.ok(finished, 'markFinished returned the updated entry');
  assert.strictEqual(finished.status, 'success', 'entry transitioned to success');
  assert.ok(finished.finishedAt, 'finishedAt is stamped');
  const next = runQueue.peekNextPending(rec);
  assert.ok(next, 'next pending is exposed');
  assert.strictEqual(next.itemId, 'next-C', 'queue advance reaches next-C');
});

// ──────────────────────────────────────────────────────────────────────
// Mode (3) — agent-session.js retry loop emits iteration_aborted on
// the two no-terminal-event escape paths (THIRD-PASS fr-51 fix).
// ──────────────────────────────────────────────────────────────────────
//
// Symptom this guard catches:
//   - kill() flips alive=false while a stream message is in flight; the
//     for-await loop breaks BEFORE AbortError throws → catch is bypassed
//     → no terminal event → queue's running entry stuck forever.
//   - SDK closes the stream cleanly without ever emitting a `result`
//     message → no turn_result → same outcome.
//
// Both new emits route through the existing attach.js terminal-event
// listener, which already covers `iteration_aborted`.

t('static guard: agent-session.js emits iteration_aborted when killed mid-stream', () => {
  // We pin the specific reason string `kill_mid_stream` so the
  // [runQueue-diag] tracer can identify this path post-deploy.
  assert.ok(/kill_mid_stream/.test(AGENT_SESSION),
    'agent-session.js must emit `iteration_aborted` with reason=`kill_mid_stream` when the for-await loop breaks via !this.alive — pre-fix this path emitted no terminal event and stranded the queue (fr-51 third pass)');
  // The flag MUST be set inside the for-await break path. We check
  // that the flag-set + the eventual emit both exist; the regex below
  // pairs them loosely.
  assert.ok(/killedMidStream\s*=\s*true/.test(AGENT_SESSION),
    'agent-session.js must set a `killedMidStream` flag (or equivalent) inside the for-await break path so the post-loop emit can fire on this path');
});

t('static guard: agent-session.js emits iteration_aborted on clean stream close without result', () => {
  // Reason string pinned so the diag tracer can tell the two new
  // escape paths apart.
  assert.ok(/stream_closed_no_result/.test(AGENT_SESSION),
    'agent-session.js must emit `iteration_aborted` with reason=`stream_closed_no_result` when the for-await ends naturally but no `result` message was emitted — pre-fix this path also stranded the queue (fr-51 third pass)');
  // The `emittedTerminal` tracker MUST set on `m.type === \'result\'`
  // — that\'s the only signal we have that a turn_result will emit.
  assert.ok(/emittedTerminal\s*=\s*true/.test(AGENT_SESSION),
    'agent-session.js must set an `emittedTerminal` flag (or equivalent) when _handleEvent processes a result message, so the post-loop check knows whether to synthesize iteration_aborted');
});

t('static guard: both new fr-51 emits route through _emit (not a side channel)', () => {
  // The attach.js listener subscribes to `agent-event` which is what
  // _emit publishes. If the third-pass fix wrote to a different
  // channel, the listener would never see it. Anchor: both reason
  // strings must appear in a window containing _emit({ type: ...
  // iteration_aborted ...).
  const killWindow = AGENT_SESSION.slice(
    Math.max(0, AGENT_SESSION.indexOf('kill_mid_stream') - 400),
    AGENT_SESSION.indexOf('kill_mid_stream') + 100);
  assert.ok(/_emit\s*\(\s*\{[^}]*iteration_aborted/.test(killWindow),
    '`kill_mid_stream` emit must be a `this._emit({ type: \'iteration_aborted\', ... })` call so the attach.js listener picks it up');
  const closeWindow = AGENT_SESSION.slice(
    Math.max(0, AGENT_SESSION.indexOf('stream_closed_no_result') - 400),
    AGENT_SESSION.indexOf('stream_closed_no_result') + 100);
  assert.ok(/_emit\s*\(\s*\{[^}]*iteration_aborted/.test(closeWindow),
    '`stream_closed_no_result` emit must be a `this._emit({ type: \'iteration_aborted\', ... })` call so the attach.js listener picks it up');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
