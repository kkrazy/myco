// td-33: stage-aware critic + retry button on error.
//
// Two-part feature, one commit. User-confirmed promotion model
// (AskUserQuestion in this session):
//   · A — Retry button: when the critic returns a "(call failed: …)"
//     envelope (Gemini 503, network blip, missing key, etc.), the
//     verdict panel grows a ↻ Retry button next to the existing
//     trio. Click → POST /sessions/:id/critique/retry → server pulls
//     rec._lastCritique + re-fires triggerGeminiCritique against
//     the same diff + claudeOutput + item.
//   · B — Stage-aware critic via sentinel text: claude announces
//     stage transitions ([stage: analyze done] / [stage: code done]
//     / [stage: verify done]) in its assistant text. The server
//     parses these in agent-session.js, emits a stage-done event,
//     and attach.js fires an INTERMEDIATE critique that broadcasts
//     a verdict but does NOT pause the run queue. Only the
//     end-of-turn critique gates queue advance — pre-td-33 behavior
//     is preserved on the final-critique path.
//
// Test shape: static-grep across all 6 touched files (critique.js,
// agent-session.js, attach.js, index.js, app.js, styles.css), plus
// unit-style tests on the sentinel regex + the error-detector.

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

console.log('── td-33: stage-aware critic + retry button on error ──');

// ── 1. Server: critique.js refactor ──

t('server/src/critique.js: triggerGeminiCritique accepts an opts parameter (isIntermediate, stage, isRetry)', () => {
  const src = _read('server/src/critique.js');
  assert.ok(/async\s+function\s+triggerGeminiCritique\s*\([^)]*opts\s*=\s*\{\s*\}/.test(src),
    'triggerGeminiCritique must take opts={} as the 6th param (Phase A — was 5 positional; td-33 adds {isIntermediate, stage, isRetry}).');
});

t('server/src/critique.js: _looksLikeCriticError helper detects "(failed)" / "(missing)" / "(error)" envelopes', () => {
  // Static-grep only — actually require()ing critique.js pulls in
  // ./critics/gemini which transitively requires @google/genai, and
  // that SDK isn't in the test-container's node_modules (it's only
  // in /app/server/node_modules of the deployed image).
  const src = _read('server/src/critique.js');
  assert.ok(/function\s+_looksLikeCriticError\s*\(/.test(src),
    '_looksLikeCriticError helper must be defined (td-33 A — the gate the Retry button keys on).');
  const at = src.search(/function\s+_looksLikeCriticError\s*\(/);
  const body = sliceFn(src, at);
  // The helper's body must reference the common SDK failure shapes
  // so a future restyle can't silently regress to "any "(...)" is
  // an error" (too broad) or "only 'failed' is an error" (too
  // narrow). The current shape uses a regex alternation across
  // failed/missing/error/invalid/timeout/rate-limit/quota plus the
  // common HTTP statuses (503, 429, 401, 400).
  for (const needle of ['failed', 'missing', 'error', '503']) {
    assert.ok(new RegExp(needle, 'i').test(body),
      `_looksLikeCriticError must list "${needle}" in its detection regex (td-33 A — covers common SDK failure shapes).`);
  }
  // Negative-side: the helper must short-circuit when the string
  // doesn't start with "(" — a real verdict like "✓ AGREED" or
  // "## Issue 1: ..." must NOT be classified as an error. Look for
  // the `startsWith('(')` gate.
  assert.ok(/startsWith\s*\(\s*['"]\(['"]\s*\)/.test(body),
    '_looksLikeCriticError must short-circuit `false` when the verdict does NOT start with "(" — otherwise a real verdict containing the word "failed" in a flagged issue would mis-classify as error.');
});

t('server/src/critique.js: rec._lastCritique cache is stamped on every fire so retry can pull it', () => {
  const src = _read('server/src/critique.js');
  // The cache is required for the Retry button to work without
  // re-shipping the full diff through the client.
  assert.ok(/rec\._lastCritique\s*=/.test(src),
    'triggerGeminiCritique must stamp rec._lastCritique = {itemId, itemSnapshot, diff, claudeOutput, ...} on every fire (td-33 A — retry pulls from this).');
  // The cached fields must include diff + claudeOutput (the inputs
  // we need to re-fire).
  const at = src.search(/rec\._lastCritique\s*=\s*\{/);
  const body = src.slice(at, at + 600);
  assert.ok(/diff/.test(body) && /claudeOutput/.test(body) && /itemSnapshot/.test(body),
    'rec._lastCritique must include diff + claudeOutput + itemSnapshot so retry has everything it needs.');
});

t('server/src/critique.js: retryLastCritique helper is defined + exported', () => {
  const src = _read('server/src/critique.js');
  assert.ok(/async\s+function\s+retryLastCritique\s*\(/.test(src),
    'retryLastCritique helper must be defined (td-33 A — server-side entry for the retry route).');
  assert.ok(/module\.exports\s*=\s*\{[\s\S]*retryLastCritique[\s\S]*\}/.test(src),
    'retryLastCritique must be exported from critique.js so index.js can wire the route.');
});

t('server/src/critique.js: isIntermediate critiques SKIP the runQueuePaused mutation + queue state-update broadcast', () => {
  const src = _read('server/src/critique.js');
  // The runQueuePaused mutation must be guarded by `!isIntermediate`
  // — otherwise every stage transition would pause the queue, which
  // would freeze multi-step work behind a sequence of approvals.
  assert.ok(/!isIntermediate/.test(src),
    'triggerGeminiCritique must guard the queue-pause + queue state-update behind `!isIntermediate` so checkpoint critiques don\'t freeze the run (td-33 B).');
});

t('server/src/critique.js: broadcast includes isError + isIntermediate + isRetry + stage so the client can render correctly', () => {
  const src = _read('server/src/critique.js');
  // The critique-review state-update payload must surface all four
  // td-33 fields. The client keys its rendering off them (Retry
  // button on isError; checkpoint badge on isIntermediate).
  for (const field of ['isError', 'isIntermediate', 'isRetry', 'stage']) {
    assert.ok(new RegExp(`\\b${field}\\b[\\s\\S]{0,80}(:|=)`).test(src),
      `critique broadcast payload must include the ${field} field so the client can branch on it (td-33).`);
  }
});

// ── 2. Server: stage-sentinel parser in agent-session.js ──

t('server/src/agent-session.js: _detectStageSentinels helper is defined + invoked on assistant_text', () => {
  const src = _read('server/src/agent-session.js');
  assert.ok(/_detectStageSentinels\s*\(/.test(src),
    '_detectStageSentinels must be defined (td-33 B — scans claude\'s assistant text for [stage: X done] sentinels).');
  // The helper must be invoked on assistant_text — look for the call
  // near the _persistAssistantTextToRecChat call (the canonical hook
  // point for new text events).
  assert.ok(/_persistAssistantTextToRecChat\([^)]+\);\s*[\s\S]{0,1500}this\._detectStageSentinels\(/.test(src),
    '_detectStageSentinels must be CALLED after _persistAssistantTextToRecChat in the assistant_text branch (the hook point where new text arrives).');
});

t('server/src/agent-session.js: sentinel regex matches the three stages (analyze, code, verify), case-insensitive', () => {
  const src = _read('server/src/agent-session.js');
  // Anchor on the METHOD DEFINITION (not the first call site — that's
  // inside the assistant_text branch ~900 lines earlier than the
  // method body).
  const at = src.search(/_detectStageSentinels\s*\(\s*text\s*\)\s*\{/);
  assert.ok(at > -1, '_detectStageSentinels method definition must exist.');
  const body = src.slice(at, at + 3500);
  // Look for an explicit alternation of the three stage names.
  assert.ok(/analyze[\s\S]{0,30}\|[\s\S]{0,30}code[\s\S]{0,30}\|[\s\S]{0,30}verify/i.test(body),
    'the sentinel regex must enumerate exactly the three stages td-33 names (analyze | code | verify) — no arbitrary stage names accepted.');
  // The regex must be case-insensitive (the `i` flag).
  assert.ok(/\/[^/]+\/[a-z]*i[a-z]*/i.test(body),
    'sentinel regex must carry the `i` flag so claude\'s case-variant emits ([Stage: Analyze Done], etc.) still parse.');
});

t('server/src/agent-session.js: sentinels are deduped within a turn via this._firedStages (Set)', () => {
  const src = _read('server/src/agent-session.js');
  assert.ok(/this\._firedStages\s*=\s*new Set\(\)/.test(src),
    '_detectStageSentinels must use a Set on the session instance to dedup stages within a turn (no double-fire if claude says [stage: code done] twice in a row).');
  // And the set must be cleared on turn boundaries.
  assert.ok(/this\._firedStages\s*=\s*null/.test(src),
    'the per-turn _firedStages set must be cleared on turn_result so the NEXT turn can re-fire any stage.');
});

t('server/src/agent-session.js: sentinel hit emits stage-done on the session bus', () => {
  const src = _read('server/src/agent-session.js');
  // Anchor on the method definition (same fix as the sentinel-regex
  // case above — the first match is the call site).
  const at = src.search(/_detectStageSentinels\s*\(\s*text\s*\)\s*\{/);
  const body = src.slice(at, at + 3500);
  assert.ok(/this\.emit\s*\(\s*['"]stage-done['"]/.test(body),
    'on a sentinel match, the helper must call this.emit("stage-done", { stage }) so attach.js\'s subscriber fires the checkpoint critique.');
});

// ── 3. Server: stage-done subscriber in attach.js ──

t('server/src/attach.js: _registerExternalSession subscribes to stage-done and dispatches an intermediate critique', () => {
  const src = _read('server/src/attach.js');
  assert.ok(/session\.on\s*\(\s*['"]stage-done['"]/.test(src),
    'attach.js must subscribe to the stage-done event in _registerExternalSession (td-33 B — the bridge from sentinel detection to critic invocation).');
});

t('server/src/attach.js: stage-done subscriber calls triggerGeminiCritique with isIntermediate: true + the stage name', () => {
  const src = _read('server/src/attach.js');
  // Find the subscriber body — it's a `session.on('stage-done', ...`
  // arrow. Search for triggerGeminiCritique in proximity.
  const at = src.search(/session\.on\s*\(\s*['"]stage-done['"]/);
  assert.ok(at > -1);
  // bug-61 follow-up: window bumped 4000 → 5500. bug-61 added a
  // ~30-line guard ABOVE the rest of the stage-done handler.
  // bug-68 Option B addition 1 follow-up: window bumped 5500 → 8500.
  // _emitSentinelReceivedNote was inserted between handler-entry +
  // the existing bug-61 guard, pushing triggerGeminiCritique further
  // down. The td-33 invariant ("stage-done subscriber calls
  // triggerGeminiCritique with isIntermediate:true") is preserved —
  // the helper insertion between handler-entry + critic-fire is
  // legitimate. 8500 chars catches both the trigger call AND its
  // isIntermediate option, which sits on a separate line ~1200 chars
  // past the function name due to the multi-line call signature.
  const body = src.slice(at, at + 8500);
  assert.ok(/triggerGeminiCritique/.test(body),
    'stage-done subscriber must call triggerGeminiCritique (td-33 B).');
  assert.ok(/isIntermediate\s*:\s*true/.test(body),
    'the call must pass `isIntermediate: true` so the critique broadcast (and queue gating) takes the checkpoint path.');
  assert.ok(/stage\b/.test(body),
    'the call must pass the stage name so the verdict can render a [Checkpoint: <stage>] badge.');
});

t('server/src/attach.js: stage-done subscriber inherits the dispatch-drift filter (baselineDirty exclusion)', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/session\.on\s*\(\s*['"]stage-done['"]/);
  // bug-61 follow-up: window bumped 4000 → 5500. bug-61 added a
  // ~30-line guard ABOVE the rest of the stage-done handler.
  // bug-68 Option B addition 1 follow-up: window bumped 5500 → 8500
  // (same reason as the sibling test above — _emitSentinelReceivedNote
  // insertion pushes baselineDirty filter further down).
  const body = src.slice(at, at + 8500);
  assert.ok(/baselineDirty/.test(body),
    'the stage-done subscriber must filter the diff against baselineDirty (matches the dispatch-drift fix from 2026-06-03; without it a checkpoint critique on an active run with unrelated WIP would see the WIP).');
});

// ── 4. Server: retry route ──

t('server/src/index.js: POST /sessions/:id/critique/retry route is registered + delegates to retryLastCritique', () => {
  const src = _read('server/src/index.js');
  assert.ok(/app\.post\(\s*['"]\/sessions\/:id\/critique\/retry['"]/.test(src),
    'POST /sessions/:id/critique/retry must be registered in index.js (td-33 A).');
  const at = src.search(/app\.post\(\s*['"]\/sessions\/:id\/critique\/retry['"]/);
  const body = src.slice(at, at + 1200);
  assert.ok(/require\s*\(\s*['"]\.\/critique['"]\s*\)/.test(body),
    'retry route must require ./critique to get retryLastCritique.');
  assert.ok(/retryLastCritique\s*\(/.test(body),
    'retry route must call critique.retryLastCritique(sessionId, session) (td-33 A).');
  // 404 when there's no live session OR nothing to retry.
  assert.ok(/res\.status\(404\)/.test(body),
    'retry route must respond 404 when there\'s no live session OR no critique on file (td-33 A — graceful fail).');
});

// ── 5. CLAUDE.md template directive for sentinel emission ──

t('web/public/best-practices-template.md: contains a section explaining the [stage: ... done] sentinels to claude', () => {
  const md = _read('web/public/best-practices-template.md');
  assert.ok(/\[stage:\s*analyze\s+done\]/i.test(md),
    'the template must show the exact [stage: analyze done] shape so claude emits the correct sentinel.');
  assert.ok(/\[stage:\s*code\s+done\]/i.test(md),
    'the template must show the exact [stage: code done] shape.');
  assert.ok(/\[stage:\s*verify\s+done\]/i.test(md),
    'the template must show the exact [stage: verify done] shape.');
  // And it must explain WHY (so claude understands when to fire).
  assert.ok(/td-33/i.test(md),
    'the template section must reference td-33 so a future restyle understands the stage-aware critic plumbing.');
});

// ── 6. Client: Retry button + Intermediate badge ──

t('web/public/app.js: _renderVerdictPanel renders ↻ Retry on review.isError', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/function\s+_renderVerdictPanel\s*\(\)/);
  assert.ok(at > -1, '_renderVerdictPanel must exist.');
  const body = sliceFn(app, at);
  assert.ok(/verdict-btn-retry/.test(body),
    '_renderVerdictPanel must render .verdict-btn-retry when review.isError (td-33 A).');
  assert.ok(/review\.isError/.test(body),
    '_renderVerdictPanel must branch on review.isError (td-33 A).');
});

t('web/public/app.js: Retry click POSTs to /sessions/:id/critique/retry', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/function\s+_renderVerdictPanel\s*\(\)/);
  // bug-71 (2026-06-05): bumped the slice budget from 12000 to
  // 16000. The bug-71 fix inserted ~21 lines INSIDE _renderVerdictPanel
  // (the renderMd swap + the renderMermaidInContainer post-processor)
  // which pushed the `authedFetch(`/sessions/${...}/critique/retry`)`
  // call from offset ~11500 to ~12053 — 53 chars past the old 12000
  // window. The window was arbitrary; this test asserts a wiring
  // CONTRACT (Retry → POST /critique/retry), not a function-size
  // constraint, so widening is the right move.
  const body = sliceFn(app, at);
  assert.ok(/\/sessions\/\$\{[^}]+\}\/critique\/retry/.test(body),
    'Retry click handler must POST to /sessions/:id/critique/retry (td-33 A wiring).');
  assert.ok(/method:\s*['"]POST['"]/.test(body),
    'the retry fetch must use method: "POST" (td-33 A).');
});

t('web/public/app.js: _renderVerdictPanel renders [Checkpoint: <stage>] badge on review.isIntermediate', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/function\s+_renderVerdictPanel\s*\(\)/);
  const body = sliceFn(app, at);
  assert.ok(/review\.isIntermediate/.test(body),
    '_renderVerdictPanel must branch on review.isIntermediate (td-33 B).');
  assert.ok(/verdict-intermediate-badge/.test(body),
    '_renderVerdictPanel must render .verdict-intermediate-badge on the checkpoint path (td-33 B).');
});

t('web/public/styles.css: .verdict-btn-retry + .verdict-intermediate-badge + .verdict-title.error styles are defined', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/\.verdict-btn-retry\s*\{/.test(css),
    '.verdict-btn-retry CSS rule must exist (td-33 A — orange/amber retry styling).');
  assert.ok(/\.verdict-intermediate-badge\s*\{/.test(css),
    '.verdict-intermediate-badge CSS rule must exist (td-33 B — checkpoint badge).');
  assert.ok(/\.verdict-title\.error\s*\{/.test(css),
    '.verdict-title.error CSS rule must exist (td-33 A — "Critic Error — Retry?" banner).');
});

// ── 6b. td-33 r1: Gemini critique catch — queue-pause moved AFTER critic runs ──

t('server/src/critique.js r1: queue-pause runs AFTER the critic returns + skips on isError (no stuck-paused queue on Gemini 503)', () => {
  const src = _read('server/src/critique.js');
  // The runQueuePaused mutation must sit AFTER the runCritique await.
  const queuePauseIdx = src.search(/rec\.runQueuePaused\s*=\s*true/);
  const runCritiqueIdx = src.search(/await\s+critic\.runCritique/);
  assert.ok(queuePauseIdx > -1 && runCritiqueIdx > -1,
    'both the queue-pause assignment and the runCritique await must exist (anchors for the ordering check).');
  assert.ok(queuePauseIdx > runCritiqueIdx,
    'rec.runQueuePaused = true must appear AFTER `await critic.runCritique(...)` so an isError verdict can skip the pause (td-33 r1 — Gemini critique catch).');
  // The pause-gate must explicitly check both flags.
  const near = src.slice(runCritiqueIdx, queuePauseIdx + 800);
  assert.ok(/if\s*\(\s*rec\s*&&\s*!isIntermediate\s*&&\s*!isError\s*\)/.test(near),
    'the pause condition must be `if (rec && !isIntermediate && !isError)` — both flags strictly excluded (td-33 r1).');
});

t('web/public/app.js r1: error path renders BOTH ↻ Retry AND ✗ Dismiss (no stuck-on-Retry state)', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/function\s+_renderVerdictPanel\s*\(\)/);
  const body = sliceFn(app, at);
  // Anchor on the actionsHtml-assignment in the isError branch (the
  // other `if (isError) {` block earlier in the function just sets
  // titleText). Slice from `actionsHtml =` to the next `actionsHtml =`
  // (which is the next branch) so we exclusively read the error-path
  // assignment.
  // bug-53 follow-up: the assignments now lead with the
  // `askCriticBtn +` constant prefix instead of an inline backtick
  // template (bug-53 added the 💬 Ask Critic button as the first
  // item in every actionsHtml branch). The contract this test
  // locks (error branch must include ↻ Retry + ✗ Dismiss) is
  // unchanged; only the assignment prefix moved. Accept either form.
  const actionsHtmlAssignments = [...body.matchAll(/actionsHtml\s*=\s*(?:`|askCriticBtn\s*\+)/g)];
  assert.ok(actionsHtmlAssignments.length >= 3,
    `expected 3 actionsHtml assignments (error / intermediate / final branches); got ${actionsHtmlAssignments.length}.`);
  // First assignment = error branch, second = intermediate, third = final.
  const errorAssignStart = actionsHtmlAssignments[0].index;
  const intermediateAssignStart = actionsHtmlAssignments[1].index;
  const errorBlockText = body.slice(errorAssignStart, intermediateAssignStart);
  assert.ok(/verdict-btn-retry/.test(errorBlockText),
    'first (error-branch) actionsHtml assignment must include verdict-btn-retry (td-33 A).');
  assert.ok(/verdict-btn-dismiss/.test(errorBlockText),
    'first (error-branch) actionsHtml assignment must ALSO include verdict-btn-dismiss so a user stuck on a persistent error can abandon the panel (td-33 r1 — Gemini critique catch).');
});

// ── 7. Marker comment ──

t('a comment naming "td-33" appears in at least 4 of the touched files', () => {
  const files = [
    'server/src/critique.js',
    'server/src/agent-session.js',
    'server/src/attach.js',
    'server/src/index.js',
    'web/public/app.js',
    'web/public/styles.css',
    'web/public/best-practices-template.md',
  ];
  let found = 0;
  for (const f of files) if (/td-33/.test(_read(f))) found++;
  assert.ok(found >= 4,
    `at least 4 of the touched files must carry a td-33 marker comment so a future restyle understands the stage-aware critic + retry plumbing — found in ${found}.`);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
