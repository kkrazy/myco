// bug-49: Replace plan-item trash button with close action; remove
// checkbox close path.
//
// User-reported (verbatim, plan-item dispatch from @labxnow):
//   Problem:  No visible checkbox to close a plan item, and using
//             a checkbox to close is semantically misleading.
//   Expected: The trash button should be repurposed (or replaced)
//             as a "close" button that closes the plan item; any
//             remaining checkbox-based close logic should be deleted.
//   Actual:   Checkbox affordance for closing is missing/confusing,
//             and the trash icon does not map to a close action.
//   Context:  Remove dead checkbox close code from the codebase if
//             still present.
//
// State before bug-49:
//   · The dual-purpose checkbox was already retired in fr-47 (the
//     CSS comment at styles.css:2464 spells this out). The existing
//     ".artifact-item-close" button (with check/rotate-ccw icons +
//     "Close"/"Reopen" text) is the post-fr-47 close affordance.
//   · The trash button (".artifact-item-delete") still rendered next
//     to it as a HARD DELETE (filter item out of the array entirely,
//     gone with all comments + votes + run-history). That's the
//     semantic mismatch the user is calling out.
//
// Architecture of this fix:
//   · Keep the existing .artifact-item-close button as-is — it
//     already implements the close-toggle-reopen contract via POST
//     /artifact/mark (no hard delete, all history preserved).
//   · Remove the trash button entirely: HTML, onArtifactItemDelete
//     client handler, .artifact-item-delete event wiring, and the
//     server-side DELETE /artifact/item route (the route now has no
//     caller, so CLAUDE.md §1 says delete it).
//   · Stale comments mentioning a non-existent "checkbox" close path
//     in styles.css updated to current reality.
//
// Test shape: static-grep guards across the three layers.

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

// Strip JS/CSS comments before counting symbol references — bug-49's
// trail-marker explanatory comments mention the old class names in
// prose, which would otherwise inflate the "no longer exists" counts.
function _stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

console.log('── bug-49: trash button → close, checkbox close path removed ──');

// ── client: trash button HTML + JS handler are GONE ──

t('web/public/app.js: trash button HTML (class="artifact-item-delete") is removed', () => {
  const app = _stripJsComments(_read('web/public/app.js'));
  assert.ok(!/class="artifact-item-delete"|class='artifact-item-delete'/.test(app),
    'web/public/app.js must not render a `<button class="artifact-item-delete">` anymore — bug-49 replaces the trash button with the existing .artifact-item-close close affordance.');
});

t('web/public/app.js: onArtifactItemDelete client function is removed', () => {
  const app = _stripJsComments(_read('web/public/app.js'));
  assert.ok(!/function\s+onArtifactItemDelete\s*\(|onArtifactItemDelete\s*=\s*async/.test(app),
    'web/public/app.js must not define onArtifactItemDelete anymore — bug-49 removes the hard-delete client path; the .artifact-item-close button (POST /artifact/mark) is now the only close affordance.');
});

t('web/public/app.js: .artifact-item-delete event wiring is removed', () => {
  const app = _stripJsComments(_read('web/public/app.js'));
  assert.ok(!/querySelectorAll\s*\(\s*['"`]\.artifact-item-delete['"`]/.test(app),
    'web/public/app.js must not wire click handlers to .artifact-item-delete — bug-49 deleted the button + handler.');
});

// ── server: DELETE /artifact/item route is GONE ──

t('server/src/artifacts.js: app.delete(.../artifact/item) route is removed', () => {
  const src = _stripJsComments(_read('server/src/artifacts.js'));
  assert.ok(!/app\.delete\s*\(\s*['"`][^'"`]*?\/artifact\/item['"`]/.test(src),
    "server/src/artifacts.js must not declare `app.delete('/sessions/:id/artifact/item', ...)` anymore — bug-49 removed the hard-delete endpoint; close-via-mark (POST /artifact/mark) is the only lifecycle path now.");
});

// ── CSS: .artifact-item-delete rules are GONE ──

t('web/public/styles.css: .artifact-item-delete rules are removed', () => {
  // Strip CSS comments too (same pattern as JS — block comments).
  const css = _read('web/public/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\.artifact-item-delete\b/.test(css),
    'web/public/styles.css must not contain .artifact-item-delete selectors anymore — the button is gone, so its styling must be deleted too (CLAUDE.md §1: delete code that no longer has a caller).');
});

// ── existing Close button + close handler still present ──

t('web/public/app.js: existing .artifact-item-close button still rendered (the close affordance)', () => {
  const app = _read('web/public/app.js');
  assert.ok(/class="artifact-item-close"|class='artifact-item-close'/.test(app),
    'web/public/app.js MUST still render the .artifact-item-close button — bug-49 KEEPS this button as the only close affordance after the trash button is removed.');
});

t('web/public/app.js: onArtifactItemClose handler still exists and POSTs to /artifact/mark', () => {
  const app = _read('web/public/app.js');
  const fnMatch = app.match(/async\s+function\s+onArtifactItemClose\s*\([\s\S]*?\n\}/);
  assert.ok(fnMatch, 'onArtifactItemClose must still be defined — it is the close action that replaces the deleted hard-delete handler.');
  assert.ok(/\/artifact\/mark/.test(fnMatch[0]),
    'onArtifactItemClose must POST to /artifact/mark — that is the close-by-mark contract bug-49 preserves.');
});

// ── stale checkbox-close comments cleaned up ──

t('web/public/styles.css: stale plan/test todo-list "checkboxes" comment is updated', () => {
  const css = _read('web/public/styles.css');
  // Pre-bug-49 comment: "Plan/Test todo list with checkboxes.
  // Checking a Plan item dispatches it back to the running Claude
  // session via the chat pipeline ..." — wildly inaccurate now (fr-47
  // removed the checkbox; the click on the .artifact-item-close
  // button toggles done state, doesn't dispatch). Lock the comment to
  // NOT say "with checkboxes" so a reader doesn't go hunting for a
  // checkbox that doesn't exist.
  assert.ok(!/Plan\/Test todo list with checkboxes\./.test(css),
    'styles.css must not still claim "Plan/Test todo list with checkboxes" — fr-47 removed the checkbox, bug-49 cleans up the stale comment so future readers don\'t hunt for a checkbox that doesn\'t exist.');
});

// ── marker comment ──

t('a comment naming bug-49 explains the trash-removal + close-becomes-canonical contract', () => {
  const app = _read('web/public/app.js');
  const artifacts = _read('server/src/artifacts.js');
  const css = _read('web/public/styles.css');
  const re = /bug-49/;
  assert.ok(re.test(app) || re.test(artifacts) || re.test(css),
    'a comment naming bug-49 must appear in at least one of web/public/app.js / server/src/artifacts.js / web/public/styles.css so future restyles understand why the trash button is gone.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
