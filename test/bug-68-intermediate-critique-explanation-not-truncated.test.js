// bug-68 regression: intermediate stage critiques must NOT truncate
// claude's plan body before passing it to the critic as
// `CLAUDE'S EXPLANATION (this turn)`.
//
// User report (bug-68 + bug-66 r2 + bug-69 r1 critic disagreements):
//   "Analyze stage emits no written plan in CLAUDE'S EXPLANATION
//    section" — even though the plan WAS in claude's emitted text,
//    the critic only saw the assumption-block tail.
//
// Root cause: server/src/attach.js ~line 262 in the
// `session.on('stage-done', …)` handler passed claudeOutput as
//   (session._currentTurnAssistantText || '').slice(-2000)
// — the LAST 2 KB of accumulated turn text. Structured plans put
// their head content (Problem Restated, Root Cause, Proposed
// Solution, Verification Steps) at the START of the response and
// the sentinel + closing prose at the END, so a TAIL-2 KB slice on
// a 5 KB plan dropped exactly the sections the critic specifically
// evaluates.
//
// Final critiques (attach.js:~416) pass `ev.result` (the SDK's
// turn_result final text) directly — they're not affected.
//
// Fix: flip direction TAIL → HEAD and bump cap 2 KB → 32 KB. Any
// realistic analyze plan (<= 8K tokens, <= ~4000 words) now fits in
// full. Gemini 2.5's >1M-token context makes the 30 KB delta
// negligible.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-68: intermediate-critique explanation must not truncate plan body ──');

const ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
const CRITIQUE = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'critique.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guards on the prod code paths.
// ─────────────────────────────────────────────────────────────────

t('intermediate-critique call site uses _currentTurnAssistantText', () => {
  // The buffer name itself is the contract — if a future refactor
  // renames it, this test breaks loudly so the rename is paired
  // with the regression guard.
  assert.ok(/_currentTurnAssistantText/.test(ATTACH),
    'attach.js must reference session._currentTurnAssistantText for the intermediate-critique claudeOutput');
});

t('the slice() call near _currentTurnAssistantText is HEAD direction (slice(0, …)) not TAIL (slice(-…))', () => {
  // The exact failing shape: `slice(-2000)` after the buffer name.
  // It MUST NOT appear in the file anymore.
  const tailPattern = /_currentTurnAssistantText[^)]*\)\.slice\s*\(\s*-/;
  assert.ok(!tailPattern.test(ATTACH),
    'attach.js still has a TAIL-direction slice on _currentTurnAssistantText. The bug-68 fix flipped this to HEAD (slice(0, N)). A TAIL slice drops the plan body, which is the exact bug.');
});

t('slice cap is at least 16000 (defensive floor)', () => {
  // Extract the cap from the matched slice call. If a future
  // "save tokens" change pushes it back below 16 KB, the analyze
  // plan body starts getting clipped again — this guard catches
  // that.
  const m = ATTACH.match(/_currentTurnAssistantText[^)]*\)\.slice\s*\(\s*0\s*,\s*(\d+)\s*\)/);
  assert.ok(m, 'attach.js must contain a HEAD slice on _currentTurnAssistantText with the shape `.slice(0, <cap>)`');
  const cap = parseInt(m[1], 10);
  assert.ok(cap >= 16000,
    `slice cap is ${cap}, must be >= 16000 to fit a realistic analyze plan. The bug-68 fix uses 32000.`);
});

t('triggerGeminiCritique consumer wiring still expects the field (critique.js)', () => {
  // Sanity-check the receiving end: critique.js must still place
  // the value into a `CLAUDE'S EXPLANATION` block. If that template
  // is renamed or removed, the fix above wires data into a
  // dead slot.
  assert.ok(/CLAUDE'S EXPLANATION \(this turn\)/.test(CRITIQUE),
    "critique.js must still emit the `CLAUDE'S EXPLANATION (this turn)` block so the bug-68 fix actually surfaces in the critic prompt");
  assert.ok(/\$\{claudeOutput\}/.test(CRITIQUE),
    'critique.js must still interpolate ${claudeOutput} into the critic user prompt');
});

t('FINAL critique still passes ev.result (unaffected by bug-68)', () => {
  // Defense: the final-critique path passes ev.result directly
  // (no slice). That code must not have been touched by bug-68 —
  // accidentally applying the slice to the final path would
  // shrink the verdict's view of claude's final answer.
  assert.ok(/triggerGeminiCritique\(\s*sessionId,\s*session,\s*item,\s*fullDiff,\s*ev\.result\b/.test(ATTACH),
    'attach.js final-critique call site must still pass ev.result (not a sliced buffer) — bug-68 should only touch the intermediate path');
});

// ─────────────────────────────────────────────────────────────────
// PART B — Behavioral simulation: prove HEAD-32KB retains plan body
// where TAIL-2KB would have dropped it.
// ─────────────────────────────────────────────────────────────────

// Synthesize a 5 KB analyze response with the structured-plan shape
// we actually use. Markers chosen to match the exact text the
// critic looks for ("PROPOSED SOLUTION", "VERIFICATION STEPS").
function makeSyntheticAnalyze() {
  // Total length ~8000 chars. PROPOSED SOLUTION header lands at
  // offset ~3000 — well outside the slice(-2000) tail window (which
  // covers [6000, 8000)). This proves the truncation drops the
  // head section. VERIFICATION STEPS lands at ~6500 inside the
  // tail; we don't assert on its absence pre-fix, only on its
  // presence post-fix.
  const pad = (n, label) => `${label}: ` + 'x'.repeat(n - label.length - 2);
  return [
    '## Analyze stage',
    '',
    '### Problem restated',
    pad(1400, 'problem-detail'),                  // 30–1430
    '',
    '### Root cause (evidence)',
    pad(1300, 'root-cause-detail'),               // 1430–2730
    '',
    '### PROPOSED SOLUTION',                      // ~2760 — outside TAIL-2000 window
    pad(1500, 'proposed-detail'),
    '',
    '### Assumptions',                            // padding to push total length
    pad(1500, 'assumptions-detail'),
    '',
    '### VERIFICATION STEPS',                     // ~6300 — inside tail; not asserted absent
    pad(1500, 'verify-detail'),
    '',
    'Zero source edits this stage.',
    '',
    '[stage: analyze done]',
  ].join('\n');
}

t('synthesized analyze plan is large enough for the regression to fire', () => {
  const text = makeSyntheticAnalyze();
  assert.ok(text.length >= 3500,
    `synthetic plan is ${text.length} chars; must be >= 3500 to push PROPOSED SOLUTION + VERIFICATION STEPS past the old 2000-char tail window`);
  // Sanity: both markers exist in the source.
  assert.ok(text.includes('PROPOSED SOLUTION'));
  assert.ok(text.includes('VERIFICATION STEPS'));
});

t('pre-fix slice(-2000) DROPS the plan body (proves the bug is real)', () => {
  // The exact pre-fix slicing.
  const text = makeSyntheticAnalyze();
  const oldSliced = text.slice(-2000);
  // PROPOSED SOLUTION is at offset ~2150 — its end is well before
  // the start of the tail-2000 window for a ~4000-char plan.
  // Pre-fix the critic would NOT see this marker.
  assert.ok(!oldSliced.includes('PROPOSED SOLUTION'),
    'PROPOSED SOLUTION should be absent from the TAIL-2000 slice (this is the bug). If this assertion fails the synthetic plan is wrong.');
  // Same for VERIFICATION STEPS — its header is at ~3070; the
  // tail window starts at len-2000. For a ~4000-char plan, the
  // tail starts at ~2000, so VERIFICATION STEPS header IS in the
  // tail. To make the test crisp, the synthetic plan is sized so
  // PROPOSED SOLUTION header is unambiguously outside.
});

t('post-fix slice(0, 32000) RETAINS both PROPOSED SOLUTION and VERIFICATION STEPS', () => {
  const text = makeSyntheticAnalyze();
  const newSliced = text.slice(0, 32000);
  assert.ok(newSliced.includes('PROPOSED SOLUTION'),
    'post-fix HEAD-32KB slice must retain PROPOSED SOLUTION marker — this is the core bug-68 fix');
  assert.ok(newSliced.includes('VERIFICATION STEPS'),
    'post-fix HEAD-32KB slice must retain VERIFICATION STEPS marker');
  // The sentinel may or may not survive depending on plan length;
  // for a 5KB plan it does. The critic doesn't NEED the sentinel
  // (the server already detected it to fire the critique), but
  // retaining it costs nothing.
});

t('32KB cap is sufficient for any realistic analyze plan', () => {
  // Generate a deliberately bloated 30KB plan and confirm it
  // survives the cap.
  const bloat = 'PROPOSED SOLUTION marker at start.\n' +
    'x'.repeat(28000) + '\nVERIFICATION STEPS marker near end.\n';
  const sliced = bloat.slice(0, 32000);
  assert.ok(sliced.includes('PROPOSED SOLUTION marker at start'));
  assert.ok(sliced.includes('VERIFICATION STEPS marker near end'),
    "32KB cap should retain a marker placed at offset ~28000 — if this fails the cap doesn't accommodate verbose plans");
});

t('40KB+ plans get capped (defensive bound holds)', () => {
  // Confirm the cap actually bounds — a 50KB plan should be
  // truncated, not crash.
  const huge = 'A'.repeat(50000) + 'TAIL-SENTINEL';
  const sliced = huge.slice(0, 32000);
  assert.strictEqual(sliced.length, 32000,
    'cap must bound: 50 KB input → 32 KB output');
  assert.ok(!sliced.includes('TAIL-SENTINEL'),
    'tail sentinel at offset 50000 must NOT appear in slice(0, 32000) — cap is enforced');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
