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

t('app.js button label is "Close" when !it.done, "Reopen" when it.done', () => {
  // Search for both label strings in the renderItem template — should
  // be visible as literal strings in the source so the layer-aware
  // ternary is grep-able.
  assert.ok(/['"`]Close['"`]/.test(PROD_APP),
    'literal string "Close" must appear in app.js (button label for open items)');
  assert.ok(/['"`]Reopen['"`]/.test(PROD_APP),
    'literal string "Reopen" must appear in app.js (button label for done items)');
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

t('app.js: closeBtn declaration comes BEFORE the actionsRow that references it (temporal-dead-zone guard)', () => {
  // Regression guard from the 2026-05-20 "all plan items disappeared"
  // incident — moving the button into actionsRow without moving its
  // const declaration up put `${closeBtn}` in the template literal
  // BEFORE `const closeBtn = …`. const is not hoisted, so the entire
  // renderItem function threw ReferenceError + every plan item card
  // failed to render. Pin the source order so this can't recur.
  const declIdx = PROD_APP.search(/const\s+closeBtn\s*=/);
  const useIdx = PROD_APP.search(/\$\{closeBtn\}/);
  assert.ok(declIdx > -1, 'const closeBtn = … must exist');
  assert.ok(useIdx > -1, '${closeBtn} reference must exist (inside actionsRow template)');
  assert.ok(declIdx < useIdx,
    `closeBtn declaration (idx ${declIdx}) must come BEFORE any \${closeBtn} reference (first use at idx ${useIdx}) — ` +
    'const has no hoisting; out-of-order use throws ReferenceError and wipes the entire item render.');
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
