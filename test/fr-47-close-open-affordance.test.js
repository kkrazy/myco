// fr-47 regression: plan items lack an explicit close/open affordance;
// the existing checkbox conflates two semantically distinct actions:
//   - checking the box = dispatch the item to claude (POST /artifact/run)
//   - unchecking the box = mark done=false (POST /artifact/mark)
//
// Replace with a single-purpose text button:
//   - When !it.done → render "Close" button → POST /artifact/mark done=1
//   - When it.done  → render "Reopen" button → POST /artifact/mark done=0
//
// The dispatch-to-claude path now lives exclusively on the ▶ Run button
// (post fr-48 unification, ▶ Run POSTs /queue/add). The Close button
// just toggles lifecycle state — no claude dispatch.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const PROD_APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── fr-47: explicit close/open affordance (checkbox removed) ──');

t('app.js does NOT render artifact-item-checkbox in renderItem', () => {
  // The checkbox <input type="checkbox" class="artifact-item-checkbox">
  // is the conflating widget per the bug report. It must be removed.
  assert.ok(!/artifact-item-checkbox/.test(PROD_APP),
    'app.js must NOT contain artifact-item-checkbox — replaced by explicit Close/Reopen button');
});

t('app.js renderItem includes an artifact-item-close button (Close when open, Reopen when done)', () => {
  // Single button class `artifact-item-close` toggles done via
  // POST /artifact/mark. Label switches based on it.done.
  assert.match(PROD_APP, /artifact-item-close/,
    'app.js must render a button class artifact-item-close on item cards');
});

t('app.js: Close/Reopen UX still surfaces (now in /close slash toast text after fr-85 round 2)', () => {
  // Pre-fr-85-round-2: literal "Close" / "Reopen" lived in the
  // closeBtn template's data-done ternary on the plan card. After
  // round 2 the button is gone (replaced by /close slash inside the
  // chat panel) and the user-visible verbs moved into the
  // _closeItemFromPanel toast messages: "↻ Reopened <id>" and
  // "✓ Closed <id>". Pin those past-tense strings so the verbs
  // remain grep-able even after the button rendering went away.
  assert.ok(/Closed/.test(PROD_APP),
    'literal "Closed" must appear (toast confirmation after /close on an open item)');
  assert.ok(/Reopened/.test(PROD_APP),
    'literal "Reopened" must appear (toast confirmation after /close on a done item)');
});

// Helper: extract the body of onArtifactItemClose (the click
// handler function) by name. Bounded by the next function declaration.
function _grabCloseHandler(src) {
  const start = src.search(/(async\s+)?function\s+onArtifactItemClose\s*\(/);
  if (start === -1) return '';
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\n(async\s+)?function\s+[A-Za-z_]/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

t('app.js click handler POSTs to /artifact/mark (NOT /artifact/run from the toggle)', () => {
  // The fr-48 unification moved /artifact/run to the ▶ Run button
  // path (which POSTs /queue/add). Close is pure lifecycle toggle —
  // must hit /artifact/mark.
  const body = _grabCloseHandler(PROD_APP);
  assert.ok(body.length > 0, 'onArtifactItemClose function must exist');
  assert.ok(/\/artifact\/mark/.test(body),
    'onArtifactItemClose handler must POST to /artifact/mark');
});

t('app.js click handler does NOT route through /artifact/run', () => {
  // Negative guard: pre-fr-47 the checkbox toggled to /artifact/run
  // when checking a plan item (dispatching to claude). Post-fr-47 +
  // fr-48, dispatch is the ▶ Run button's job. Close must NEVER
  // dispatch.
  const body = _grabCloseHandler(PROD_APP);
  assert.ok(body.length > 0);
  assert.ok(!/\/artifact\/run/.test(body),
    'onArtifactItemClose must NOT POST to /artifact/run — that path is the ▶ Run / queue dispatch');
});

t('app.js: closeBtn const + ${closeBtn} reference both gone (fr-85 round 2 — moved to /close slash)', () => {
  // Original 2026-05-20 TDZ guard guarded an "all plan items disappeared"
  // incident caused by `${closeBtn}` being referenced before `const
  // closeBtn = …`. fr-85 round 2 removed BOTH (Close/Reopen is now
  // a /close slash command inside the chat panel that reads
  // it.done from the artifact cache via _findArtifactItem and
  // toggles via the same /artifact/mark endpoint the old button hit).
  // Invariant now: neither side exists in the source — keeps the
  // dead-code rule honest + makes the TDZ class of bug impossible.
  // The plan-card closeBtn const used to render a <button class="artifact-item-close">.
  // The panel-local `const closeBtn = panel.querySelector('.aichat-close')`
  // is a DIFFERENT variable (panel × button — unrelated scope) and stays.
  // So we pin specifically: no const closeBtn assigned to a button
  // template for .artifact-item-close, and no ${closeBtn} reference
  // (which only the plan-card actionsRow ever had).
  assert.ok(!/<button\s+class="artifact-item-close"/.test(PROD_APP),
    'no <button class="artifact-item-close"> should render (button was dropped from plan card)');
  const useIdx = PROD_APP.search(/\$\{closeBtn\}/);
  assert.strictEqual(useIdx, -1,
    '${closeBtn} should not be referenced (button no longer rendered in actionsRow)');
  // The replacement path: _closeItemFromPanel + the artifact-mark
  // endpoint must still both exist so /close works end-to-end.
  assert.ok(/function\s+_closeItemFromPanel\s*\(/.test(PROD_APP),
    '_closeItemFromPanel helper must exist (panel slash dispatcher);');
  assert.ok(/artifact\/mark/.test(PROD_APP),
    'POST /artifact/mark must still be hit (same backend, different caller)');
});

t('app.js does NOT keep the old onArtifactItemToggle (no callers after checkbox removal)', () => {
  // The pre-fr-47 onArtifactItemToggle function operated on the
  // checkbox `cb`. With the checkbox gone, the function has no
  // callers — leaving it would be dead code per BP §1 (delete code
  // that no longer has a caller — dead branches age into bugs).
  assert.ok(!/function\s+onArtifactItemToggle\s*\(/.test(PROD_APP) &&
            !/onArtifactItemToggle\s*=\s*async/.test(PROD_APP),
    'onArtifactItemToggle should be removed once the checkbox is gone (no callers, dead code)');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
