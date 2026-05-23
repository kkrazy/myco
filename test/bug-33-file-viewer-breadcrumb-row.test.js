// bug-33 regression: the file viewer's breadcrumb path must sit on
// its own dedicated row, separate from the action icons.
//
// User report: "The file viewer path breadcrumb is cluttered by the
// icons sharing its row at the top. Expected: Breadcrumb sits on
// its own dedicated row, separate from the icons. Actual: Breadcrumb
// and icons are crammed together on the same top row."
//
// Fix shape: split #files-view-header (previously a single flex row
// with back-button + breadcrumb + spacer + 5 action buttons) into
// two stacked rows:
//   Row 1 — .files-view-header-nav: back button + #files-view-crumbs
//   Row 2 — .files-view-header-actions: 5 action buttons
//
// Row 2 auto-hides via `:has(button:not([hidden]))` when every action
// button is hidden — preserves the "minimal header" look for non-
// editable file opens. Row 1 keeps the 92px right padding so the
// breadcrumb tail isn't hidden behind the floating chrome buttons.
//
// Static guards on HTML + CSS so a future header refactor can't
// silently collapse back to a single-row layout.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const HTML = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── bug-33: file-viewer breadcrumb on its own row ──');

// ──────────────────────────────────────────────────────────────────────
// HTML structure
// ──────────────────────────────────────────────────────────────────────

t('HTML: #files-view-header has TWO child rows (nav + actions)', () => {
  // The pre-fix header was a single flex row mixing nav + crumb +
  // 5 action buttons. The fix wraps each concern in its own row.
  assert.ok(/class="files-view-header-row files-view-header-nav"/.test(HTML),
    'HTML must contain a .files-view-header-nav row holding the back button + breadcrumb');
  assert.ok(/class="files-view-header-row files-view-header-actions"/.test(HTML),
    'HTML must contain a .files-view-header-actions row holding the edit/save/cancel/wrap/copy buttons');
});

t('HTML: nav row contains back button + #files-view-crumbs', () => {
  // Extract the .files-view-header-nav div's HTML.
  const navMatch = HTML.match(/<div class="files-view-header-row files-view-header-nav">([\s\S]*?)<\/div>/);
  assert.ok(navMatch, '.files-view-header-nav must exist as a <div>');
  const nav = navMatch[1];
  assert.ok(/id="files-view-back"/.test(nav),
    'nav row must contain #files-view-back (the back-to-tree button)');
  assert.ok(/id="files-view-crumbs"/.test(nav),
    'nav row must contain #files-view-crumbs (the breadcrumb path) — separating it from the action icons is the whole point of bug-33');
});

t('HTML: actions row contains ALL FIVE action buttons', () => {
  const actionsMatch = HTML.match(/<div class="files-view-header-row files-view-header-actions">([\s\S]*?)<\/div>/);
  assert.ok(actionsMatch, '.files-view-header-actions must exist as a <div>');
  const actions = actionsMatch[1];
  for (const id of ['files-edit', 'files-edit-save', 'files-edit-cancel', 'files-wrap-toggle', 'files-copy']) {
    assert.ok(new RegExp('id="' + id + '"').test(actions),
      'actions row must contain #' + id + ' (otherwise it leaks back into the nav row, re-introducing bug-33)');
  }
});

t('HTML: breadcrumb is NOT in the actions row (would re-introduce bug-33)', () => {
  // Defensive: if a future refactor moves the breadcrumb back next to
  // the action buttons, this guard trips.
  const actionsMatch = HTML.match(/<div class="files-view-header-row files-view-header-actions">([\s\S]*?)<\/div>/);
  assert.ok(actionsMatch);
  assert.ok(!/id="files-view-crumbs"/.test(actionsMatch[1]),
    'breadcrumb #files-view-crumbs must NOT live inside .files-view-header-actions — that was the pre-bug-33 layout');
});

// ──────────────────────────────────────────────────────────────────────
// CSS structure
// ──────────────────────────────────────────────────────────────────────

t('CSS: #files-view-header is flex-column (stacks the two rows)', () => {
  // Without flex-direction: column the two rows lay out side-by-side
  // and the bug returns. Anchor the rule.
  const headerBlock = CSS.match(/#files-view-header\s*\{[\s\S]*?\}/);
  assert.ok(headerBlock, '#files-view-header rule must exist in styles.css');
  assert.ok(/flex-direction:\s*column/.test(headerBlock[0]),
    '#files-view-header must declare flex-direction: column so the two rows stack vertically');
});

t('CSS: .files-view-header-nav pushes breadcrumb BELOW the floating chrome cluster', () => {
  // bug-33 second pass: the chrome cluster has FIVE position:fixed
  // buttons (Plan / Arch / Test / Files / Chat) totaling ~210px wide.
  // The first-pass 92px right-padding only cleared 2 of them (Files
  // + Chat); the other 3 (Plan/Arch/Test) still overlapped the
  // breadcrumb (user re-filed the bug). The fix pushes the nav row
  // BELOW the chrome row entirely via a top padding equal to
  // safe-area-inset-top + ~50px (chrome top 10 + 32px button +
  // small buffer). No right padding needed — breadcrumb gets the
  // full pane width.
  const navBlock = CSS.match(/\.files-view-header-nav\s*\{[\s\S]*?\}/);
  assert.ok(navBlock, '.files-view-header-nav rule must exist');
  // Must clear the chrome from ABOVE (top padding ≥ ~42px to clear
  // the chrome button bottom edge; we use ~50 with a buffer). We
  // anchor on env(safe-area-inset-top) so iPhone-notch deploys also
  // get pushed correctly.
  assert.ok(/padding:\s*calc\(\s*env\(safe-area-inset-top[^)]*\)\s*\+\s*(?:4[5-9]|[5-9][0-9])px\s*\)/.test(navBlock[0]),
    '.files-view-header-nav must have a top padding of `calc(env(safe-area-inset-top, 0px) + ≥45px)` so the breadcrumb sits BELOW the floating chrome cluster — first-pass right-padding-only fix didn\'t clear the 3 leftmost chrome buttons (Plan/Arch/Test)');
  // Defensive: must NOT still carry the dead 92px right-padding from
  // the first-pass fix. That value pinned the wrong layout.
  assert.ok(!/padding:\s*8px\s+92px/.test(navBlock[0]),
    '.files-view-header-nav must NOT still carry the dead 92px right-padding from the first-pass bug-33 fix — the new layout pushes from above, not from the side');
});

t('CSS: .files-view-header-actions defaults to display:none + :has auto-show', () => {
  // The auto-hide makes the action row collapse to zero height when
  // no buttons are visible — keeps the header minimal for non-
  // editable file opens / fresh viewer state.
  const actionsBlock = CSS.match(/\.files-view-header-actions\s*\{[\s\S]*?\}/);
  assert.ok(actionsBlock, '.files-view-header-actions rule must exist');
  assert.ok(/display:\s*none/.test(actionsBlock[0]),
    '.files-view-header-actions must default to display:none so an empty row doesn\'t take up space');
  // The :has show-rule
  const hasRule = CSS.match(/\.files-view-header-actions:has\(button:not\(\[hidden\]\)\)\s*\{[\s\S]*?\}/);
  assert.ok(hasRule,
    'styles.css must declare `.files-view-header-actions:has(button:not([hidden])) { display: flex }` so the row appears only when at least one action button is visible');
  assert.ok(/display:\s*flex/.test(hasRule[0]),
    'the :has rule must set display: flex so the row appears');
});

t('CSS: #files-view-crumbs flex behavior unchanged (still ellipsis-shrinkable)', () => {
  // bug-33 must NOT regress the in-row crumb behavior — the path can
  // still ellipsis-shrink when the row is narrow. We re-check the
  // pre-existing rule shape so a refactor doesn't drop the ellipsis.
  const crumbBlock = CSS.match(/#files-view-crumbs\s*\{[\s\S]*?\}/);
  assert.ok(crumbBlock);
  assert.ok(/flex:\s*1/.test(crumbBlock[0]),
    '#files-view-crumbs must keep flex: 1 so it grows to fill the nav row');
  assert.ok(/min-width:\s*0/.test(crumbBlock[0]),
    '#files-view-crumbs must keep min-width: 0 so the ellipsis works inside a flex container');
  assert.ok(/overflow:\s*hidden/.test(crumbBlock[0]),
    '#files-view-crumbs must keep overflow: hidden so .crumb children can text-overflow: ellipsis');
});

// ──────────────────────────────────────────────────────────────────────
// Backwards compatibility — existing element ids must still resolve
// ──────────────────────────────────────────────────────────────────────

t('every action-button id is still present in HTML (no rename)', () => {
  // The fix moves the buttons into a wrapper div but keeps every id.
  // Other code (fr-50 edit-button visibility tests, the actual JS
  // visibility togglers) looks up these ids; renaming would break.
  for (const id of ['files-view-back', 'files-view-crumbs', 'files-edit',
                     'files-edit-save', 'files-edit-cancel',
                     'files-wrap-toggle', 'files-copy']) {
    assert.ok(new RegExp('id="' + id + '"').test(HTML),
      'HTML must still declare #' + id + ' — bug-33 must not rename or drop existing ids');
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
