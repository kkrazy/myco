// bug-61: stage critic verdict doesn't actually pause the agent —
// subsequent stage sentinels overwrite the modal before the user
// can review.
//
// User-reported (verbatim):
//   "the analyze stage verdict didn't pause the process, it
//    eventually get overriden by the final stage overall verdict
//    popover."
//
// Root cause: fr-96's state machine is OBSERVABLE (status
// transitions to awaiting_accept) but not ENFORCED. Nothing
// server-side stops claude from emitting the next [stage: X done]
// sentinel, and the client's critique-review WS handler replaces
// state.critiqueReview unconditionally on each broadcast.
//
// Fix: two paired guards.
//
// (1) SERVER ENFORCEMENT (attach.js stage-done handler): before
//     transitioning + firing the critic, check the current
//     stageState. If status is 'awaiting_verdict' (critic in flight)
//     OR 'awaiting_accept' (user reviewing verdict), DROP the new
//     sentinel + log it. Claude must wait for the user to signal
//     ✓ Accept Stage / ⚡ Ask Claude to Fix Stage on the existing
//     verdict before another sentinel can fire.
//
// (2) CLIENT GUARD (app.js critique-review WS handler): race-safety
//     net. If state.critiqueReview is already showing an unresolved
//     intermediate verdict, do NOT replace with a new intermediate
//     broadcast. Retry broadcasts (msg.isRetry: true) and error-
//     verdict replacements remain allowed — those are the user's
//     explicit ↻ Retry / 💬 Ask Critic flows.
//
// This finally makes the §9 pause-and-await-accept methodology
// physically real instead of directive-only.
//
// Test shape: static-grep on the locked surface in attach.js +
// app.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── bug-61: pause enforcement — server drops + client guards stale broadcasts ──');

// ── 1. Server-side enforcement (attach.js stage-done handler) ──

t('attach.js: stage-done handler checks current stageState BEFORE transitioning + firing the critic', () => {
  const src = _read('server/src/attach.js');
  // Locate the stage-done subscriber.
  const at = src.search(/session\.on\s*\(\s*['"]stage-done['"]/);
  assert.ok(at > -1, 'stage-done subscriber must exist.');
  const body = src.slice(at, at + 5000);
  // The bug-61 guard must READ the current stageState before the
  // _transitionStageState call (which moves to awaiting_verdict).
  assert.ok(/stageStateMod\.getStageState/.test(body),
    'stage-done handler must call stageStateMod.getStageState(...) to read the current state BEFORE transitioning (bug-61).');
  // The guard's condition must check both awaiting_verdict + awaiting_accept.
  assert.ok(/awaiting_verdict/.test(body) && /awaiting_accept/.test(body),
    'stage-done handler\'s bug-61 guard must check both awaiting_verdict (critic in flight) AND awaiting_accept (user reviewing) — both states mean the previous verdict isn\'t yet resolved.');
});

t('attach.js: bug-61 guard short-circuits via `return` (drops the sentinel) when stageState is unresolved', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/session\.on\s*\(\s*['"]stage-done['"]/);
  const body = src.slice(at, at + 5000);
  // The guard must be a hard return — drop the sentinel entirely,
  // do NOT transition, do NOT fire the critic. Without the return
  // the dropped sentinel would still call _transitionStageState +
  // build the diff + fire the critic, defeating the pause.
  assert.ok(/\[bug-61\][\s\S]{0,400}return\s*;/.test(body),
    'stage-done handler\'s bug-61 guard must `return;` after logging the drop — that\'s what physically stops the second critic from firing.');
});

t('attach.js: bug-61 guard is positioned BEFORE the _transitionStageState call (so the drop short-circuits the transition)', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/session\.on\s*\(\s*['"]stage-done['"]/);
  const body = src.slice(at, at + 5000);
  // Within the handler body, the bug-61 guard's `return` must appear
  // BEFORE the _transitionStageState(..., 'awaiting_verdict') call.
  // If the guard ran AFTER the transition, the transition would
  // already have moved the state machine forward — the drop would
  // be too late.
  const bug61At = body.search(/\[bug-61\]/);
  const transitionAt = body.search(/_transitionStageState\s*\([\s\S]{0,200}['"]awaiting_verdict['"]/);
  assert.ok(bug61At > -1 && transitionAt > -1);
  assert.ok(bug61At < transitionAt,
    'bug-61 guard must appear BEFORE the _transitionStageState(..., "awaiting_verdict") call so the drop short-circuits the transition. Got bug-61 at ' + bug61At + ', transition at ' + transitionAt + '.');
});

t('attach.js: bug-61 guard short-circuits gracefully when stageState is undefined (legacy one-shot dispatches)', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/session\.on\s*\(\s*['"]stage-done['"]/);
  const body = src.slice(at, at + 5000);
  // The guard condition must be `if (cur && (cur.status === ...))` —
  // the leading truthy-check on `cur` means items without stageState
  // (legacy one-shot dispatches or items that haven't been initialized
  // via [run:plan#X]) FALL THROUGH to the existing transition + fire.
  // Without the truthy-check the guard would crash on undefined.
  assert.ok(/if\s*\(\s*curStageState\s*&&[\s\S]{0,200}awaiting/.test(body),
    'bug-61 guard must wrap the awaiting_* check in `if (curStageState && ...)` so legacy one-shot dispatches (no stageState) fall through to the existing transition + fire — not blocked.');
});

// ── 2. Client-side guard (app.js critique-review WS handler) ──

t('app.js: critique-review WS handler guards against overwriting an unresolved intermediate verdict', () => {
  const src = _read('web/public/app.js');
  // Locate the critique-review WS handler branch.
  const at = src.search(/msg\.kind\s*===\s*['"]critique-review['"]/);
  assert.ok(at > -1, 'critique-review WS handler must exist.');
  const body = src.slice(at, at + 2500);
  // The bug-61 guard reads from state.critiqueReview to check whether
  // an unresolved intermediate verdict is already showing.
  assert.ok(/state\.awaitingVerdict[\s\S]{0,300}state\.critiqueReview[\s\S]{0,300}isIntermediate/.test(body),
    'critique-review handler must read state.awaitingVerdict + state.critiqueReview + isIntermediate to compute whether the current verdict is unresolved + intermediate (bug-61).');
});

t('app.js: client guard EXEMPTS retry broadcasts (msg.isRetry — user explicitly clicked ↻ Retry or 💬 Ask Critic)', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/msg\.kind\s*===\s*['"]critique-review['"]/);
  const body = src.slice(at, at + 2500);
  // The guard must allow retry broadcasts through — those are the
  // user's EXPLICIT request to refresh the verdict (via ↻ Retry or
  // 💬 Ask Critic buttons, bug-53 + td-33 r1). Without the exemption,
  // a retry would be silently dropped and the user would think the
  // button didn't work.
  assert.ok(/!\s*msg\.isRetry/.test(body),
    'client guard must check `!msg.isRetry` so retry broadcasts (↻ Retry / 💬 Ask Critic) bypass the guard and replace the current verdict.');
});

t('app.js: client guard EXEMPTS final (non-intermediate) broadcasts so the final critique on turn_result can fire', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/msg\.kind\s*===\s*['"]critique-review['"]/);
  const body = src.slice(at, at + 2500);
  // The guard's condition must check msg.isIntermediate so final
  // critiques pass. The final critique fires on turn_result success
  // and IS supposed to replace any in-flight intermediate verdict —
  // that's the run-completion summary the user wants to see.
  assert.ok(/msg\.isIntermediate/.test(body),
    'client guard must check msg.isIntermediate so final (non-intermediate) critiques are NOT dropped — the final critique on turn_result is the run-completion summary.');
});

t('app.js: client guard EXEMPTS error broadcasts so a Retry on a broken verdict can replace it', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/msg\.kind\s*===\s*['"]critique-review['"]/);
  const body = src.slice(at, at + 2500);
  // The "currentIsUnresolvedIntermediate" check must guard on
  // !state.critiqueReview.isError so an error verdict can still be
  // replaced by a fresh broadcast (typically the Retry the user
  // clicked on the error pane).
  assert.ok(/state\.critiqueReview\.isError/.test(body),
    'client guard must check state.critiqueReview.isError so an existing error verdict can be replaced by a fresh broadcast (the Retry / Ask Critic flow on an error verdict).');
});

t('app.js: client guard short-circuits via `return` when blocking — does NOT overwrite state.critiqueReview', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/msg\.kind\s*===\s*['"]critique-review['"]/);
  const body = src.slice(at, at + 2500);
  // The guard's drop path must use `return` so the subsequent
  // state.critiqueReview = msg assignment doesn't run. Without the
  // return, the guard would only log + still overwrite.
  // bug-68 Option B addition 2: bumped 400 → 1200 char window. The
  // pre-Option-B drop was console.warn + return on adjacent lines.
  // Option B addition 2 inserts a try/warnToast/catch block between
  // them (explanatory comment + try { warnToast(...) } catch). The
  // bug-61 invariant ("guard returns; doesn't overwrite") is
  // unchanged — the assertion just needs the wider window to find
  // the return after the new toast call.
  assert.ok(/\[bug-61\][\s\S]{0,1200}return\s*;/.test(body),
    'client guard must `return;` after logging the drop — without it the subsequent state.critiqueReview = msg assignment would still run + clobber the current verdict.');
});

// ── 3. bug-61 markers in both touched files ──

t('a comment naming "bug-61" appears in attach.js and app.js', () => {
  const a = _read('server/src/attach.js');
  const app = _read('web/public/app.js');
  assert.ok(/bug-61/.test(a), 'attach.js must carry a bug-61 marker for the server-side stage-done guard.');
  assert.ok(/bug-61/.test(app), 'app.js must carry a bug-61 marker for the client-side critique-review guard.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
