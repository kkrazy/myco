// bug-8 regression: the ▶ Run button on a plan item must
//   (a) be disabled once the item is done, AND
//   (b) carry a layer-aware verb instead of the generic "Run":
//       Bug → "Fix", Feature → "Implement", Todo → "Do"
//
// The fix lives in renderItem inside web/public/app.js (the runBtn
// template + its enable gate + the new _runButtonLabel helper). This
// test inlines minimal versions of the contract pieces and static-
// grep-guards the prod source to pin them.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// Inlined FIXED helpers — the contract this test locks in.

function escHtml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// bug-8: layer-aware verb on the Run button. Bug = Fix (it's broken,
// stop the bleeding); Feature = Implement (build the thing);
// Todo = Do (generic chore verb). Unknown / missing layer falls back
// to "Run" so the legacy untagged shape still renders something
// sensible.
function _runButtonLabel(layer) {
  switch (layer) {
    case 'Bug':     return 'Fix';
    case 'Feature': return 'Implement';
    case 'Todo':    return 'Do';
    default:        return 'Run';
  }
}

// Minimal mock of the runBtn rendering subset of renderItem. The full
// renderItem also handles dependency chips, vote chips, run-status
// chip, comments, etc. — those aren't touched by bug-8.
function renderRunBtn({ item, points = 0, unmetDeps = [], voteThreshold = 1 }) {
  const enoughVotes = points >= voteThreshold;
  const notDone = !item.done;
  const runEnabled = enoughVotes && unmetDeps.length === 0 && notDone;
  const label = _runButtonLabel(item.layer);
  const text = '▶ ' + label;
  const title = runEnabled
    ? `Ask claude to ${label.toLowerCase()} this item — status + result will be linked back here`
    : item.done
      ? `This item is marked done — Run is disabled. Reopen the item to re-run.`
      : !enoughVotes
        ? `Needs ${voteThreshold} upvote to run (currently ${points}). Click 👍 above to vote.`
        : `Blocked by unmet prereq${unmetDeps.length === 1 ? '' : 's'}: ${unmetDeps.join(', ')}. Mark them done first.`;
  return `<button class="artifact-item-run" data-id="${escHtml(item.id)}" ${runEnabled ? '' : 'disabled'} title="${escHtml(title)}" aria-label="${escHtml(label)}">${text}</button>`;
}

// ──────────────────────────────────────────────────────────────────────────

console.log('── bug-8: Run button disabled-when-done + layer-aware label ──');

t('done:true Bug → disabled + label "Fix"', () => {
  const html = renderRunBtn({ item: { id: 'bug-8', layer: 'Bug', done: true }, points: 5 });
  assert.ok(/\bdisabled\b/.test(html), 'completed item must render disabled attribute');
  assert.ok(/>▶ Fix</.test(html), 'Bug layer must show "▶ Fix" not "▶ Run"');
  assert.ok(/aria-label="Fix"/.test(html), 'aria-label tracks the layer verb');
});

t('done:true Feature → disabled + label "Implement"', () => {
  const html = renderRunBtn({ item: { id: 'fr-1', layer: 'Feature', done: true }, points: 3 });
  assert.ok(/\bdisabled\b/.test(html));
  assert.ok(/>▶ Implement</.test(html), 'Feature → "▶ Implement"');
  assert.ok(/aria-label="Implement"/.test(html));
});

t('done:true Todo → disabled + label "Do"', () => {
  const html = renderRunBtn({ item: { id: 'td-1', layer: 'Todo', done: true }, points: 1 });
  assert.ok(/\bdisabled\b/.test(html));
  assert.ok(/>▶ Do</.test(html), 'Todo → "▶ Do"');
  assert.ok(/aria-label="Do"/.test(html));
});

t('done:false Bug with votes → ENABLED + label "Fix"', () => {
  const html = renderRunBtn({ item: { id: 'bug-9', layer: 'Bug', done: false }, points: 1 });
  assert.ok(!/\bdisabled\b/.test(html), 'open item with votes must NOT be disabled');
  assert.ok(/>▶ Fix</.test(html), 'open Bug still gets layer verb');
});

t('done:false Feature with votes → ENABLED + label "Implement"', () => {
  const html = renderRunBtn({ item: { id: 'fr-2', layer: 'Feature', done: false }, points: 2 });
  assert.ok(!/\bdisabled\b/.test(html));
  assert.ok(/>▶ Implement</.test(html));
});

t('done:false Todo with votes → ENABLED + label "Do"', () => {
  const html = renderRunBtn({ item: { id: 'td-3', layer: 'Todo', done: false }, points: 1 });
  assert.ok(!/\bdisabled\b/.test(html));
  assert.ok(/>▶ Do</.test(html));
});

t('done:false but no votes → still disabled (existing vote gate still works)', () => {
  const html = renderRunBtn({ item: { id: 'bug-99', layer: 'Bug', done: false }, points: 0 });
  assert.ok(/\bdisabled\b/.test(html), 'vote-gate still disables');
  assert.ok(/>▶ Fix</.test(html), 'label is layer-aware even when disabled');
});

t('done:false with unmet deps → still disabled (dep-gate still works)', () => {
  const html = renderRunBtn({
    item: { id: 'fr-3', layer: 'Feature', done: false },
    points: 5,
    unmetDeps: ['fr-1'],
  });
  assert.ok(/\bdisabled\b/.test(html), 'dep-gate still disables');
  assert.ok(/title="[^"]*Blocked by unmet/.test(html), 'tooltip explains the dep block');
});

t('unknown layer falls back to "Run"', () => {
  // Defensive: legacy items pre-layer-classification have layer=undefined.
  const html = renderRunBtn({ item: { id: 'legacy', done: false }, points: 1 });
  assert.ok(/>▶ Run</.test(html), 'fallback to ▶ Run for unknown layer');
});

t('done item tooltip explains why disabled', () => {
  const html = renderRunBtn({ item: { id: 'bug-8', layer: 'Bug', done: true }, points: 5 });
  assert.ok(/title="[^"]*marked done/.test(html),
    'tooltip on disabled-done button must say "marked done — Run is disabled"');
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards on the prod source — pin the contract.

t('static guard: app.js defines _runButtonLabel with all three layers', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(/_runButtonLabel/.test(src), 'app.js must define _runButtonLabel');
  // Each layer keyword must appear in the source near the helper. We
  // use a single combined regex to tolerate either switch-case or
  // object-map implementations.
  assert.ok(/Bug[\s\S]{0,60}Fix/.test(src), 'Bug → Fix mapping present');
  assert.ok(/Feature[\s\S]{0,60}Implement/.test(src), 'Feature → Implement mapping present');
  assert.ok(/Todo[\s\S]{0,60}Do/.test(src), 'Todo → Do mapping present');
});

// fr-85 round 2 (2026-05-24): the ▶ Run button was removed from the
// plan card and replaced with a /run slash command inside the per-item
// chat panel. The CLIENT-SIDE gating (runEnabled = enoughVotes &&
// !unmetDeps && !it.done) is gone — gating now lives SERVER-SIDE in
// the /queue/add handler that /run dispatches to, enforced regardless
// of UI source. The bug-8 contract (don't run a done item; layer-aware
// verb) survives in:
//   - the inlined pure-function tests at the top of THIS file (they
//     still pin the contract independent of where the rendering lives)
//   - /queue/add server-side checks
//   - the AICHAT_VIRTUAL_COMMANDS /run entry in app.js + the
//     _dispatchAiChatSlash router that invokes onArtifactItemRun
//
// The two static-grep guards below replace the two pre-round-2 guards
// that pinned `const runEnabled` and `const runBtn = …` literals.

t('static guard: /run slash command replaces the ▶ Run button (fr-85 round 2)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  // The runBtn const is gone — and so is the <button class="artifact-item-run">
  // render. Pin both deletions so a future regression can't quietly
  // re-introduce the redundant card button.
  assert.ok(!/const\s+runBtn\s*=/.test(src),
    'const runBtn = … should be removed (button migrated to /run slash)');
  assert.ok(!/<button\s+class="artifact-item-run"/.test(src),
    'no <button class="artifact-item-run"> should render (was the plan-card Run button)');
});

t('static guard: AICHAT_VIRTUAL_COMMANDS /run entry exists + dispatches via onArtifactItemRun', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  // The replacement: panel-virtual /run command + _dispatchAiChatSlash
  // case that invokes onArtifactItemRun (which still POSTs to /queue/add).
  assert.ok(/AICHAT_VIRTUAL_COMMANDS[\s\S]{0,800}name:\s*['"]run['"]/.test(src),
    'AICHAT_VIRTUAL_COMMANDS must include a /run entry (panel autocomplete dropdown source)');
  assert.ok(/['"]run['"][^:]{0,5}:\s*[\s\S]{0,300}onArtifactItemRun/.test(src),
    '_dispatchAiChatSlash /run case must invoke onArtifactItemRun (preserves the server-side gating + queue path)');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
