// bug-64: final critique on turn_result overwrites unresolved
// intermediate verdict — bug-61's pause gates are incomplete.
//
// User-reported (verbatim, observed on myco4 with §9 in CLAUDE.md):
//   "before the first stage (analyze) stage verdict is accepted,
//    the overall verdict is also popped up. the process should be
//    paused until an verdict is accepted."
//
// Root cause: bug-61 server gate only checks stageState in the
// stage-done handler (attach.js:190). The FINAL critique on
// turn_result success fires from a SEPARATE code path
// (attach.js:298 IIFE) that doesn't check stageState — empirically
// observed on myco4 where claude emitted all 3 sentinels in one
// turn, bug-61 dropped the 2nd + 3rd, then turn_result fired the
// final critique anyway. Symmetrically, bug-61's client guard
// exempts !msg.isIntermediate (finals), so the client's
// critique-review handler replaced the intermediate verdict
// modal with the final one before the user could review.
//
// Fix: two paired guards (mirrors bug-61's pattern).
//
// (1) SERVER DEFER (attach.js turn_result IIFE): before
//     triggerGeminiCritique, check stageState. If status is
//     awaiting_verdict/awaiting_accept for an intermediate stage,
//     store the payload in rec._deferredFinalCritique + return
//     (queue stays paused). The deferred fires from
//     critique.js::resolveCritique when reason === 'accept-stage'
//     (user moved forward through the intermediate verdict).
//     clearActiveRunItem drops the deferred on Discard / verify-
//     accept (run abandoned/done).
//
// (2) CLIENT BUFFER (app.js critique-review WS handler): race-
//     safety net. If a final broadcast arrives while an unresolved
//     intermediate is showing, BUFFER it in
//     state.deferredFinalCritique instead of replacing. The
//     _replayDeferredFinalCritique helper surfaces it after the
//     intermediate is resolved (Dismiss / Accept Stage / cross-
//     device critique-resolved). Buffer is DROPPED on Discard /
//     Fix (final) / Fix Stage (run abandoned or redone — deferred
//     is stale).
//
// Test shape: static-grep on the locked surface.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── bug-64: final-critique defer when intermediate is unresolved ──');

// ── 1. Server-side defer in attach.js turn_result-success IIFE ──

t('attach.js: turn_result IIFE checks stageState BEFORE triggerGeminiCritique', () => {
  const src = _read('server/src/attach.js');
  // Locate the bug-64 server-side defer block within the
  // turn_result IIFE.
  const at = src.search(/\[bug-64\] deferring final critique/);
  assert.ok(at > -1, 'attach.js must contain the bug-64 deferring log line — the marker for the server-side defer guard.');
  // The block must read stageStateMod.getStageState BEFORE storing
  // the deferred payload. Widened from 1500 → 4000 chars (§10.b
  // anti-fragility — bug-83 added ~20 lines of suppression-guard
  // comment between the getStageState call and the [bug-64] log line;
  // a future addition could push further). The contract this test
  // locks is unchanged: getStageState must be read before the defer
  // log line within the same IIFE.
  const before = src.slice(Math.max(0, at - 4000), at);
  assert.ok(/stageStateMod\.getStageState/.test(before),
    'attach.js bug-64 defer must read stageStateMod.getStageState(item) before deciding to defer (bug-64).');
});

t('attach.js: bug-64 defer condition checks awaiting_verdict OR awaiting_accept', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/\[bug-64\] deferring final critique/);
  // Same condition shape as bug-61's stage-done guard. Look at the
  // surrounding ~1000 chars for both status values.
  const window = src.slice(Math.max(0, at - 1000), at + 500);
  assert.ok(/awaiting_verdict/.test(window),
    'bug-64 defer condition must check awaiting_verdict (critic in flight).');
  assert.ok(/awaiting_accept/.test(window),
    'bug-64 defer condition must check awaiting_accept (user reviewing verdict).');
});

t('attach.js: bug-64 defer stores rec._deferredFinalCritique with itemId + item + diff + claudeOutput + changedEntries + deferredAt', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/rec\._deferredFinalCritique\s*=/);
  assert.ok(at > -1, 'attach.js must assign rec._deferredFinalCritique = {...} in the defer path.');
  const body = src.slice(at, at + 800);
  // Snapshot all the fields needed by the deferred-fire path.
  assert.ok(/itemId\s*:/.test(body), 'deferred payload must include itemId.');
  assert.ok(/item\s*[,:]/.test(body), 'deferred payload must include item (the snapshot for the critic call).');
  assert.ok(/diff\s*:/.test(body), 'deferred payload must include diff.');
  assert.ok(/claudeOutput\s*:/.test(body), 'deferred payload must include claudeOutput.');
  assert.ok(/changedEntries\s*:/.test(body), 'deferred payload must include changedEntries (for the file-context block).');
  assert.ok(/deferredAt\s*:/.test(body), 'deferred payload must include deferredAt (audit timestamp).');
});

t('attach.js: bug-64 defer short-circuits via return — does NOT call triggerGeminiCritique inline', () => {
  const src = _read('server/src/attach.js');
  // Find the defer's `rec._deferredFinalCritique = {...}` assignment.
  const at = src.search(/rec\._deferredFinalCritique\s*=\s*\{/);
  const body = src.slice(at, at + 1500);
  // The block must end with `return;` so the immediately-following
  // `triggerGeminiCritique(...)` call does NOT run.
  assert.ok(/saveStore\s*\(\s*\)\s*;\s*return\s*;/.test(body),
    'after rec._deferredFinalCritique assignment + sessionsMod.saveStore(), the defer path must `return;` — otherwise triggerGeminiCritique would still fire and the defer would be pointless.');
});

// ── 2. Resume hook in critique.js::resolveCritique ──

t('critique.js: resolveCritique fires deferred final critique on reason === "accept-stage"', () => {
  const src = _read('server/src/critique.js');
  // Locate the bug-64 marker inside resolveCritique.
  const fnAt = src.search(/function\s+resolveCritique\s*\(/);
  assert.ok(fnAt > -1, 'resolveCritique must exist.');
  const body = sliceFn(src, fnAt);
  // The bug-64 hook must branch on reason === 'accept-stage'.
  assert.ok(/reason\s*===\s*['"]accept-stage['"]/.test(body),
    'resolveCritique bug-64 hook must branch on reason === "accept-stage" (user moved forward through the intermediate verdict).');
  // It must read rec._deferredFinalCritique + fire via
  // triggerGeminiCritique with the stored fields.
  assert.ok(/rec\._deferredFinalCritique/.test(body),
    'bug-64 hook must read rec._deferredFinalCritique to check for pending deferred.');
  assert.ok(/triggerGeminiCritique\s*\([\s\S]{0,500}deferred\.item/.test(body),
    'bug-64 hook must call triggerGeminiCritique(...) with the deferred.item to fire the buffered final critique.');
});

t('critique.js: resolveCritique clears rec._deferredFinalCritique after firing', () => {
  const src = _read('server/src/critique.js');
  const fnAt = src.search(/function\s+resolveCritique\s*\(/);
  const body = sliceFn(src, fnAt);
  // The fire path must set rec._deferredFinalCritique = null before
  // (or right after) the fire so the deferred doesn't re-fire on a
  // subsequent resolve.
  assert.ok(/rec\._deferredFinalCritique\s*=\s*null/.test(body),
    'after firing the deferred, resolveCritique must clear rec._deferredFinalCritique = null + persist via saveStore so the deferred is one-shot.');
});

// ── 3. Discard / verify-accept clears the deferred ──

t('attach.js: clearActiveRunItem clears rec._deferredFinalCritique (Discard + verify-Accept paths)', () => {
  const src = _read('server/src/attach.js');
  const fnAt = src.search(/function\s+clearActiveRunItem\s*\(/);
  assert.ok(fnAt > -1, 'clearActiveRunItem must exist (bug-57).');
  const body = sliceFn(src, fnAt);
  assert.ok(/\[bug-64\][\s\S]{0,300}_deferredFinalCritique\s*=\s*null/.test(body),
    'clearActiveRunItem must clear rec._deferredFinalCritique = null on Discard / verify-Accept — the run is abandoned/done, the deferred is stale.');
});

// ── 4. Client-side buffer in critique-review WS handler ──

t('app.js: critique-review handler buffers incoming final into state.deferredFinalCritique when intermediate is unresolved', () => {
  const src = _read('web/public/app.js');
  // Locate the bug-64 client-side buffer block within critique-review.
  const at = src.search(/\[bug-64\] buffering incoming FINAL critique-review/);
  assert.ok(at > -1, 'app.js must contain the bug-64 buffering log line — the marker for the client-side buffer.');
  // The block must read the same currentIsUnresolvedIntermediate
  // flag bug-61 introduced + assign state.deferredFinalCritique.
  const before = src.slice(Math.max(0, at - 2000), at);
  assert.ok(/currentIsUnresolvedIntermediate/.test(before),
    'bug-64 client buffer must reuse the currentIsUnresolvedIntermediate flag from bug-61 (same intermediate-unresolved condition).');
  const body = src.slice(at, at + 500);
  assert.ok(/state\.deferredFinalCritique\s*=\s*msg/.test(body),
    'bug-64 buffer must assign state.deferredFinalCritique = msg to stash the incoming final.');
});

t('app.js: client buffer condition checks !msg.isIntermediate (finals only) and !msg.isRetry (retries pass through)', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/\[bug-64\] buffering incoming FINAL critique-review/);
  // Look at the if-condition right before the log line.
  const before = src.slice(Math.max(0, at - 500), at);
  assert.ok(/!\s*msg\.isIntermediate/.test(before),
    'client buffer condition must check !msg.isIntermediate (only buffer FINAL broadcasts; intermediates already handled by bug-61).');
  assert.ok(/!\s*msg\.isRetry/.test(before),
    'client buffer condition must check !msg.isRetry (user-initiated retries explicitly bypass the buffer).');
});

t('app.js: client buffer short-circuits via `return` after stashing (does NOT also fall through to render)', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/\[bug-64\] buffering incoming FINAL critique-review/);
  const body = src.slice(at, at + 600);
  assert.ok(/state\.deferredFinalCritique\s*=\s*msg\s*;\s*return\s*;/.test(body),
    'client buffer must `return;` after the assignment — without it the buffered final would also fall through to state.critiqueReview = msg, overwriting the intermediate anyway.');
});

// ── 5. _replayDeferredFinalCritique helper + call sites ──

t('app.js: _replayDeferredFinalCritique helper exists + reads state.deferredFinalCritique + renders', () => {
  const src = _read('web/public/app.js');
  assert.ok(/function\s+_replayDeferredFinalCritique\s*\(\)/.test(src),
    'app.js must declare _replayDeferredFinalCritique() helper (bug-64).');
  const at = src.search(/function\s+_replayDeferredFinalCritique\s*\(\)/);
  const body = sliceFn(src, at);
  assert.ok(/state\.deferredFinalCritique/.test(body),
    'helper must read state.deferredFinalCritique.');
  assert.ok(/state\.critiqueReview\s*=/.test(body),
    'helper must assign the buffered to state.critiqueReview (promote to current).');
  assert.ok(/_renderVerdictPanel\s*\(\s*\)/.test(body),
    'helper must call _renderVerdictPanel() to surface the replayed verdict.');
});

t('app.js: _replayDeferredFinalCritique is called from critique-resolved WS handler + Dismiss + Accept Stage button handlers', () => {
  const src = _read('web/public/app.js');
  // Count call sites — expect at least 3 (cross-device resolve WS,
  // Dismiss handler, Accept Stage handler). Other paths (Discard /
  // Fix / Fix Stage / Accept Claude) explicitly DROP the buffer
  // rather than replay, so they don't call this helper.
  const calls = (src.match(/_replayDeferredFinalCritique\s*\(\s*\)/g) || []).length;
  assert.ok(calls >= 3,
    `expected at least 3 _replayDeferredFinalCritique() call sites (critique-resolved WS + Dismiss + Accept Stage). Got ${calls}.`);
});

// ── 6. Buffer drop on Discard / Fix / Fix Stage ──

t('app.js: Discard / Fix / Fix Stage explicitly drop state.deferredFinalCritique = null (run abandoned/redone)', () => {
  const src = _read('web/public/app.js');
  // Count `state.deferredFinalCritique = null` assignments. Expected
  // sites: 3 (Discard, Fix on final, Fix Stage on intermediate).
  const drops = (src.match(/state\.deferredFinalCritique\s*=\s*null/g) || []).length;
  assert.ok(drops >= 3,
    `expected at least 3 state.deferredFinalCritique = null assignments (Discard + Fix + Fix Stage). Got ${drops}. Without these, a stale deferred could replay against the wrong run.`);
});

// ── 7. bug-64 markers in all 3 touched files ──

t('a comment naming "bug-64" appears in attach.js, critique.js, app.js', () => {
  const a = _read('server/src/attach.js');
  const c = _read('server/src/critique.js');
  const app = _read('web/public/app.js');
  assert.ok(/bug-64/.test(a), 'attach.js must carry a bug-64 marker (server-side defer + clearActiveRunItem buffer drop).');
  assert.ok(/bug-64/.test(c), 'critique.js must carry a bug-64 marker (resolveCritique deferred-fire hook).');
  assert.ok(/bug-64/.test(app), 'app.js must carry a bug-64 marker (client-side buffer + replay helper + button-handler integration).');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
