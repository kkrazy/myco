// bug-40: plan view layout polish on desktop.
//
// User-reported (kkrazy 2026-05-25):
//   "the plan view has a width limit, on desktop there shouldn't be a
//    width limit, also its header should have a padding on top so that
//    the 'bug', 'feature', 'todo' buttons have space from the browser
//    boundary."
//
// Pre-fix:
//   1. The desktop rule .artifact-main-view .artifact-body { max-width:
//      880px } constrained the plan column to 880px even on wide
//      monitors. Arch (markdown prose) + Test (docs) benefit from that
//      readable-line cap; plan items are short rows with chip clusters
//      that just leave wide unused gutters.
//   2. The sticky #plan-filter-row sits at top:0 of the artifact body's
//      scroll viewport with no top padding. The artifact-main-view's
//      desktop padding-top is env(safe-area-inset-top, 0px) which
//      resolves to 0 in a normal browser. The Bug/Feature/Todo filter
//      chips visually butted against the browser chrome.
//
// Fix:
//   1. max-width: none for #artifact-body-plan on desktop (plan only —
//      arch + test keep the 880px constraint).
//   2. padding-top: 12px on #plan-filter-row on desktop.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── bug-40: plan view desktop layout ──');

// ──────────────────────────────────────────────────────────────────────
// Issue 1: max-width relaxation for plan body on desktop
// ──────────────────────────────────────────────────────────────────────

t('styles.css: bug-40 max-width relaxation for #artifact-body-plan on desktop', () => {
  // Look for the rule that sets max-width: none on the plan body
  // inside a desktop media query (min-width: 901px).
  // Match the EXISTING desktop max-width: 880px rule remains for
  // the GENERIC .artifact-main-view .artifact-body (used by arch + test).
  assert.ok(/bug-40/.test(CSS),
    'CSS must carry the bug-40 marker');
  // The override rule: #artifact-body-plan { max-width: none } in a
  // desktop @media block.
  const idx = CSS.indexOf('bug-40');
  assert.ok(idx > -1);
  const win = CSS.slice(idx, idx + 1500);
  assert.ok(/#artifact-body-plan\s*\{[\s\S]{0,200}max-width:\s*none/.test(win),
    'must set max-width: none on #artifact-body-plan to relax the 880px desktop cap');
  // And must be inside a desktop media query.
  const mediaIdx = CSS.lastIndexOf('@media', idx + win.indexOf('max-width: none'));
  const mediaWin = CSS.slice(mediaIdx, mediaIdx + 200);
  assert.ok(/min-width:\s*901px/.test(mediaWin),
    'relaxation must be desktop-scoped (min-width: 901px)');
});

t('styles.css: arch + test artifact bodies KEEP the 880px desktop cap', () => {
  // Defensive — confirm the existing rule for the GENERIC artifact body
  // (used by arch + test) is preserved. We don't want to accidentally
  // remove the readable-line cap from prose-heavy artifact views.
  assert.ok(/\.artifact-main-view\s+\.artifact-body\s*\{[\s\S]{0,400}max-width:\s*880px/.test(CSS),
    'generic .artifact-main-view .artifact-body { max-width: 880px } must still exist for arch + test');
});

// ──────────────────────────────────────────────────────────────────────
// Issue 2: top padding on plan filter row
// ──────────────────────────────────────────────────────────────────────

t('styles.css: bug-40 top padding on #plan-filter-row on desktop', () => {
  // Find the desktop #plan-filter-row block.
  const idx = CSS.search(/#plan-filter-row\s*\{[\s\S]{0,400}padding-right:\s*232px/);
  assert.ok(idx > -1, 'desktop #plan-filter-row rule with padding-right: 232px must exist (fr-61 chrome-clearance)');
  // padding-top should be in the same block.
  const blockEnd = CSS.indexOf('}', idx);
  const block = CSS.slice(idx, blockEnd);
  assert.ok(/padding-top:\s*\d+px/.test(block),
    'desktop #plan-filter-row must have padding-top so the Bug/Feature/Todo chips clear the browser chrome edge');
  // Specifically 12px per the fix.
  assert.ok(/padding-top:\s*12px/.test(block),
    'padding-top should be 12px (bug-40 default)');
});

t('styles.css: top padding is desktop-only (mobile already reserves chrome band)', () => {
  // On mobile, the artifact-main-view has padding-top: calc(env(safe-area-inset-top, 0px)
  // + var(--pane-header-h)) — that already reserves the chrome cluster's
  // vertical band. Adding padding-top to the filter row on mobile would
  // double-pad. Pin: padding-top is only inside the @media (min-width: 901px)
  // block.
  const idx = CSS.search(/#plan-filter-row\s*\{[\s\S]{0,400}padding-right:\s*232px[\s\S]{0,400}padding-top:\s*12px/);
  assert.ok(idx > -1,
    'padding-top: 12px must live inside the desktop block alongside padding-right: 232px');
  // Walk back to nearest @media.
  const mediaIdx = CSS.lastIndexOf('@media', idx);
  const mediaWin = CSS.slice(mediaIdx, mediaIdx + 200);
  assert.ok(/min-width:\s*901px/.test(mediaWin),
    'padding-top must be inside @media (min-width: 901px) — desktop only');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
