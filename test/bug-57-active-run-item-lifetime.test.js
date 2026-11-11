// bug-57: _activeRunItem cleared on first turn_result, breaking the
// 3-stage critic methodology.
//
// Pre-fix: attach.js:361/381 cleared session._activeRunItem on EVERY
// turn_result (both success + abort/fatal paths). The 3-stage
// methodology (§9 directive — analyze → user accept → code → user
// accept → verify → user accept) spans multiple turns, but the
// stage-done handler at attach.js:192 short-circuits when
// _activeRunItem is null. So critic only fired on stage 1; stages 2
// and 3 were silent. User-observed empirically: "how come i didn't
// see critic kicked off during implement of fr-95."
//
// Fix:
//   1. Track session._sawStageSentinelInRun — set true when stage-done
//      handler fires; reset false on new [run:plan#X] dispatch.
//   2. On turn_result success: clear _activeRunItem ONLY when
//      _sawStageSentinelInRun is false (legacy one-shot run).
//      Otherwise keep alive across stages.
//   3. Add clearActiveRunItem(sessionId, session, opts) helper in
//      attach.js, exported. Idempotent itemId check.
//   4. Add POST /sessions/:id/run/done route (viewer-gated) that
//      calls the helper. Wired from verdict-pane's ✓ Accept (verify
//      stage) + ✗ Discard handlers via _broadcastRunDone helper.
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

console.log('── bug-57: _activeRunItem survives multi-stage runs ──');

// ── 1. _sawStageSentinelInRun tracking ──

t('attach.js: stage-done handler sets session._sawStageSentinelInRun = true', () => {
  const src = _read('server/src/attach.js');
  // Find the stage-done subscriber.
  const at = src.search(/session\.on\s*\(\s*['"]stage-done['"]/);
  assert.ok(at > -1, 'stage-done subscriber must exist.');
  // bug-61 follow-up: window bumped 2500 → 4000. bug-61 added a
  // ~30-line guard block ABOVE the existing _sawStageSentinelInRun
  // assignment; pre-bug-61 the 2500-char window caught it.
  const body = src.slice(at, at + 4000);
  assert.ok(/session\._sawStageSentinelInRun\s*=\s*true/.test(body),
    'stage-done handler must set session._sawStageSentinelInRun = true (bug-57 — the flag the turn_result handler reads to decide whether to keep _activeRunItem alive for multi-stage runs).');
});

t('attach.js: [run:plan#X] dispatch resets session._sawStageSentinelInRun = false', () => {
  const src = _read('server/src/attach.js');
  // The dispatch site sets _activeRunItem (line ~1727) — anchor on
  // that, then check the reset follows.
  const at = src.search(/session\._activeRunItem\s*=\s*\{/);
  assert.ok(at > -1, '_activeRunItem set-site must exist.');
  const body = src.slice(at, at + 2000);
  assert.ok(/session\._sawStageSentinelInRun\s*=\s*false/.test(body),
    'the [run:plan#X] dispatch site must reset session._sawStageSentinelInRun = false (bug-57 — each new run starts with no sentinels seen).');
});

// ── 2. Conditional clear on turn_result success ──

t('attach.js: turn_result success conditionally clears _activeRunItem on !_sawStageSentinelInRun', () => {
  const src = _read('server/src/attach.js');
  // The conditional must wrap the success-path clear. Look for the
  // specific pattern.
  assert.ok(/if\s*\(\s*!session\._sawStageSentinelInRun\s*\)\s*\{[\s\S]{0,300}session\._activeRunItem\s*=\s*null/.test(src),
    'turn_result success path must conditionally clear _activeRunItem behind `if (!session._sawStageSentinelInRun) { session._activeRunItem = null; }` so multi-stage runs (sentinel seen) keep the context alive (bug-57).');
});

t('attach.js: turn_result abort/fatal path still clears _activeRunItem unconditionally', () => {
  const src = _read('server/src/attach.js');
  // The abort/fatal path appears AFTER the success-path conditional.
  // The total occurrences of `session._activeRunItem = null` should
  // be 2 (1 in success path inside the if-guard, 1 in abort/fatal
  // path unconditional). Pre-fix it was 2 unconditional; bug-57 made
  // the first one conditional.
  const clearSites = (src.match(/session\._activeRunItem\s*=\s*null/g) || []).length;
  // The clearActiveRunItem helper has another site, so we count 3
  // total: success-conditional + abort/fatal + helper.
  assert.strictEqual(clearSites, 3,
    `expected exactly 3 _activeRunItem = null sites after bug-57 (success-conditional + abort/fatal-unconditional + clearActiveRunItem helper). Got ${clearSites}.`);
});

// ── 3. clearActiveRunItem helper + export ──

t('attach.js: clearActiveRunItem(sessionId, session, opts) helper is defined + exported', () => {
  const src = _read('server/src/attach.js');
  assert.ok(/function\s+clearActiveRunItem\s*\(\s*sessionId\s*,\s*session\s*,\s*opts/.test(src),
    'clearActiveRunItem(sessionId, session, opts) helper must be declared in attach.js (bug-57 — single source of truth for the end-of-run clear).');
  // Must be exported so the index.js route can call it.
  assert.ok(/module\.exports\s*=\s*\{[\s\S]{0,3000}clearActiveRunItem/.test(src),
    'attach.js must export clearActiveRunItem (bug-57 — index.js POST /run/done calls it).');
});

t('attach.js: clearActiveRunItem performs idempotent itemId check + advances queue', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/function\s+clearActiveRunItem\s*\(/);
  const body = sliceFn(src, at);
  // Idempotency: if request itemId doesn't match the current active
  // item, no-op (return false). Without this guard, a stale request
  // could nuke an unrelated run.
  assert.ok(/reqItemId[\s\S]{0,200}!==\s*active\.itemId/.test(body),
    'clearActiveRunItem must compare requested itemId against active.itemId and no-op on mismatch (bug-57 — idempotency).');
  // Must call _advanceRunQueue so the queue moves to next pending.
  assert.ok(/_advanceRunQueue\s*\(/.test(body),
    'clearActiveRunItem must call _advanceRunQueue so the queue moves to the next pending plan item (bug-57).');
  // Must clear both flags.
  assert.ok(/session\._activeRunItem\s*=\s*null/.test(body),
    'clearActiveRunItem must set session._activeRunItem = null.');
  assert.ok(/session\._sawStageSentinelInRun\s*=\s*false/.test(body),
    'clearActiveRunItem must also reset session._sawStageSentinelInRun = false so the next dispatch starts clean.');
});

// ── 4. POST /sessions/:id/run/done route ──

t('index.js: POST /sessions/:id/run/done route exists, viewer-gated, calls clearActiveRunItem', () => {
  const src = _read('server/src/index.js');
  assert.ok(/app\.post\s*\(\s*['"]\/sessions\/:id\/run\/done['"]/.test(src),
    'index.js must declare app.post("/sessions/:id/run/done", ...) — the new route bug-57 adds.');
  const at = src.search(/app\.post\s*\(\s*['"]\/sessions\/:id\/run\/done['"]/);
  const body = src.slice(at, at + 2000);
  assert.ok(/fileApiPreamble\s*\(\s*req\s*,\s*res\s*,\s*['"]viewer['"]\s*\)/.test(body),
    '/run/done handler must auth via fileApiPreamble(req, res, "viewer") — same tier as /critique/retry + /critique/resolve (per-device verdict-pane interactions).');
  assert.ok(/attachMod\.clearActiveRunItem\s*\(/.test(body),
    '/run/done handler must call attachMod.clearActiveRunItem(...) — keeps the clear logic centralized in attach.js.');
});

// ── 5. Client wiring — Accept (verify) + Discard fire /run/done ──

t('app.js: _broadcastRunDone helper exists + POSTs to /run/done with { itemId, reason }', () => {
  const src = _read('web/public/app.js');
  assert.ok(/const\s+_broadcastRunDone\s*=/.test(src),
    'app.js must declare a _broadcastRunDone helper (bug-57 — DRY: 2 callers share one POST shape).');
  const at = src.search(/const\s+_broadcastRunDone\s*=/);
  const body = src.slice(at, at + 1500);
  assert.ok(/\/run\/done/.test(body),
    '_broadcastRunDone must POST to /run/done.');
  assert.ok(/method:\s*['"]POST['"]/.test(body),
    '_broadcastRunDone must use method: "POST".');
  assert.ok(/itemId:\s*review\.itemId/.test(body),
    '_broadcastRunDone must include itemId: review.itemId in the POST body so the server\'s idempotency check matches.');
  assert.ok(/reason/.test(body),
    '_broadcastRunDone must include `reason` in the POST body — passed by each caller (discard / accept-verify).');
});

t('app.js: Discard button calls _broadcastRunDone(\'discard\') — abandons the run', () => {
  const src = _read('web/public/app.js');
  assert.ok(/_broadcastRunDone\s*\(\s*['"]discard['"]\s*\)/.test(src),
    'Discard handler must call _broadcastRunDone(\'discard\') — abandoning the run requires clearing _activeRunItem on the server (bug-57).');
});

t('app.js: final Accept button calls _broadcastRunDone(\'accept-verify\') — ends the run', () => {
  const src = _read('web/public/app.js');
  assert.ok(/_broadcastRunDone\s*\(\s*['"]accept-verify['"]\s*\)/.test(src),
    'Final-state Accept handler must call _broadcastRunDone(\'accept-verify\') — the verify-stage accept is what completes the multi-stage run (bug-57). The reason string \'accept-verify\' anchors which Accept path fired (vs. future per-stage accept paths fr-96 may add).');
});

t('app.js: intermediate Dismiss / Retry / Ask Critic / Fix do NOT call _broadcastRunDone (they are NOT end-of-run signals)', () => {
  const src = _read('web/public/app.js');
  // bug-56 follow-up: count call-sites (with parens), not bare
  // string occurrences. bug-56's intermediate Accept-Stage + Fix-
  // Stage handler comments LEGITIMATELY mention `_broadcastRunDone`
  // in explanatory text ("NOT calling _broadcastRunDone — intermediate
  // accept does not end the run"). Those comment-mentions shouldn't
  // count against the strict guard. The actual CALL contract: only
  // 2 buttons (Discard + final Accept-verify) invoke the helper.
  const callSites = (src.match(/_broadcastRunDone\s*\(/g) || []).length;
  // The regex `_broadcastRunDone\s*\(` matches CALL syntax only —
  // `_broadcastRunDone(...)`. The declaration
  // `const _broadcastRunDone = (reason) => { … }` does NOT match
  // because the `(` after the name is preceded by `=`. So we expect:
  //   2 call sites — discard + accept-verify.
  assert.strictEqual(callSites, 2,
    `expected exactly 2 _broadcastRunDone CALL sites (discard + accept-verify). Got ${callSites}. Intermediate dismiss / retry / ask-critic / fix / accept-stage / fix-stage must NOT call run-done — those don't end the run.`);
});

// ── 6. Marker comments ──

t('a comment naming "bug-57" appears in attach.js, index.js, and app.js', () => {
  const a = _read('server/src/attach.js');
  const i = _read('server/src/index.js');
  const app = _read('web/public/app.js');
  assert.ok(/bug-57/.test(a), 'attach.js must carry a bug-57 marker (the conditional clear + clearActiveRunItem helper).');
  assert.ok(/bug-57/.test(i), 'index.js must carry a bug-57 marker (POST /run/done route).');
  assert.ok(/bug-57/.test(app), 'app.js must carry a bug-57 marker (_broadcastRunDone helper + 2 button callers).');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
