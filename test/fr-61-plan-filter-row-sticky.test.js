// fr-61: #plan-filter-row stays visible at the top of the plan list
// while the user scrolls through the 100+ items. position: sticky
// works because the row is relocated INTO #artifact-body-plan (the
// scrolling container, overflow-y: auto) at render-time — see
// _attachPlanFilterRowToBody in app.js. Without that relocate, the
// row is a sibling of the body and sticky has no scrolling ancestor
// to pin against (it silently behaves like static — the filter
// would scroll out of view).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── fr-61: plan filter row sticky on scroll ──');

// ──────────────────────────────────────────────────────────────────────
// CSS — sticky declaration on #plan-filter-row
// ──────────────────────────────────────────────────────────────────────

t('CSS: #plan-filter-row declares position: sticky + top: 0', () => {
  const block = CSS.match(/#plan-filter-row\s*\{[\s\S]*?\}/);
  assert.ok(block, '#plan-filter-row CSS rule must exist');
  assert.ok(/position:\s*sticky/.test(block[0]),
    '#plan-filter-row must declare `position: sticky` so it stays pinned to the top of the scrollable body while the user scrolls through plan items (the whole point of fr-61)');
  assert.ok(/top:\s*0/.test(block[0]),
    '#plan-filter-row must declare `top: 0` so sticky pins at the top of the scroll viewport');
});

t('CSS: #plan-filter-row has opaque background so items don\'t bleed through', () => {
  const block = CSS.match(/#plan-filter-row\s*\{[\s\S]*?\}/);
  assert.ok(block);
  // A transparent sticky element looks broken when items scroll past
  // underneath. Pin a background.
  assert.ok(/background:\s*var\(|background:\s*#|background-color:/.test(block[0]),
    '#plan-filter-row must declare an opaque background so plan items scrolling underneath don\'t bleed through the row');
});

t('CSS: #plan-filter-row has z-index so it stacks above scrolling items', () => {
  const block = CSS.match(/#plan-filter-row\s*\{[\s\S]*?\}/);
  assert.ok(block);
  assert.ok(/z-index:\s*[0-9]+/.test(block[0]),
    '#plan-filter-row must declare a z-index so it stacks above plan items that scroll past underneath');
});

// ──────────────────────────────────────────────────────────────────────
// JS — relocation helper
// ──────────────────────────────────────────────────────────────────────

t('app.js: _attachPlanFilterRowToBody helper exists', () => {
  // The helper moves the static-HTML #plan-filter-row into the
  // body's first-child slot so sticky has a scroll-container
  // ancestor to pin against.
  assert.ok(/function\s+_attachPlanFilterRowToBody\s*\(/.test(APP),
    'app.js must define _attachPlanFilterRowToBody(body, type) — the relocation that makes position:sticky actually work');
});

t('helper: no-op when type !== "plan"', () => {
  const start = APP.search(/function\s+_attachPlanFilterRowToBody\s*\(/);
  assert.ok(start > -1);
  const rest = APP.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  // Anchor on the early-return guard.
  assert.ok(/type\s*!==\s*['"]plan['"]/.test(body),
    'helper must early-return when type !== "plan" — the filter row only exists in the plan tab DOM');
});

t('helper: uses insertBefore(body.firstChild) to put filter row at the top', () => {
  const start = APP.search(/function\s+_attachPlanFilterRowToBody\s*\(/);
  const rest = APP.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  assert.ok(/insertBefore\s*\(\s*filterRow\s*,\s*body\.firstChild\s*\)/.test(body),
    'helper must call body.insertBefore(filterRow, body.firstChild) so the filter row is the first child of the body (top of scroll viewport)');
});

t('helper: idempotent — only re-inserts when not already first child', () => {
  // Saves a layout pass on no-op calls and avoids unnecessary DOM
  // churn during rapid re-renders.
  const start = APP.search(/function\s+_attachPlanFilterRowToBody\s*\(/);
  const rest = APP.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  // Check for the firstElementChild guard.
  assert.ok(/firstElementChild|firstChild/.test(body),
    'helper should check firstElementChild to short-circuit no-op calls');
});

// ──────────────────────────────────────────────────────────────────────
// Call sites — must be invoked after EVERY body.innerHTML write in
// the plan path, otherwise the filter row gets wiped and never re-
// attached on that render
// ──────────────────────────────────────────────────────────────────────

t('renderArtifact calls _attachPlanFilterRowToBody at every plan-path body.innerHTML write site', () => {
  // The plan path has 4 body.innerHTML writes:
  //   1. "Nothing extracted" (no items at all)
  //   2. "All N item(s) are done" (open-only with all done)
  //   3. "No items match" (fr-56 filter empty state)
  //   4. Main render with bodyHtml + Updated banner
  // Each MUST be followed by a relocate call, otherwise the filter
  // row is wiped on that render path.
  const calls = (APP.match(/_attachPlanFilterRowToBody\s*\(/g) || []).length;
  // Definition + at least 3 call sites (some empty paths may share).
  // The function definition is 1, so total ≥ 4 means ≥3 callers.
  assert.ok(calls >= 4,
    'Expected ≥4 references to _attachPlanFilterRowToBody (the function definition + at least 3 call sites in renderArtifact\'s plan path). Found ' + calls + ' — likely missing call sites mean the filter row gets wiped on some render paths.');
});

// ──────────────────────────────────────────────────────────────────────
// Pin: the filter row's static HTML is still a sibling of the body
// at page load (the helper handles the runtime move)
// ──────────────────────────────────────────────────────────────────────

t('HTML: #plan-filter-row still declared in static markup', () => {
  // The relocate helper assumes #plan-filter-row exists in the DOM
  // at page load. We pin the static declaration so a future HTML
  // refactor doesn't drop the row entirely.
  const HTML = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'public', 'index.html'), 'utf8');
  assert.ok(/id="plan-filter-row"/.test(HTML),
    'index.html must still declare <div id="plan-filter-row"> so _attachPlanFilterRowToBody has something to relocate');
});

// ──────────────────────────────────────────────────────────────────────
// fr-61 second-pass — stash-before-wipe so tab switches + session
// switches don't destroy the filter row.
//
// User reported: "The plan view filter for bug/fr/tod and search
// disappears after switch tabs." Root cause: the fr-61 first-pass
// helper ran AFTER body.innerHTML — but innerHTML had already
// destroyed the filter row (which was inside the body since the
// previous render). The post-wipe re-attach found nothing and
// returned early. Filter row gone forever.
//
// Fix: _stashPlanFilterRow() rescues the row BACK to #plan-wrap
// (its original static-HTML parent) before any body.innerHTML
// wipe. Then _attachPlanFilterRowToBody after the wipe finds the
// rescued row and re-inserts it at the body's first child.
// ──────────────────────────────────────────────────────────────────────

t('app.js: _stashPlanFilterRow helper defined', () => {
  // The detach side of the detach-set-reattach pattern.
  assert.ok(/function\s+_stashPlanFilterRow\s*\(/.test(APP),
    'app.js must define _stashPlanFilterRow() — moves the filter row back to #plan-wrap before any body.innerHTML wipe so the row survives');
});

t('app.js: _stashPlanFilterRow puts the row back into #plan-wrap (not the body)', () => {
  // Pin the destination: rescue lands at #plan-wrap (the original
  // static-HTML parent), not anywhere else.
  const start = APP.search(/function\s+_stashPlanFilterRow\s*\(/);
  assert.ok(start > -1);
  const rest = APP.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  assert.ok(/planWrap\.insertBefore\s*\(\s*filterRow\s*,\s*planBody\s*\)/.test(body),
    '_stashPlanFilterRow must call planWrap.insertBefore(filterRow, planBody) — restoring the row to the static-HTML position right before the body');
});

t('app.js: every plan-body innerHTML write is preceded by _stashPlanFilterRow', () => {
  // The bug was specifically that body.innerHTML wiped the row but
  // the post-wipe re-attach had nothing to find. With the stash
  // call right before each wipe, the row is rescued first.
  const stashCalls = (APP.match(/_stashPlanFilterRow\s*\(/g) || []).length;
  // Definition + ≥4 call sites (4 plan-path body.innerHTML writes
  // + 1 in clearArtifactBodies for session switch/delete) = ≥5
  // total. Keep some slack for future additions.
  assert.ok(stashCalls >= 5,
    'Expected ≥5 references to _stashPlanFilterRow (function definition + ≥4 call sites — one before each plan-body innerHTML wipe). Found ' + stashCalls);
});

t('app.js: clearArtifactBodies rescues the filter row before wiping (session switch / delete)', () => {
  // clearArtifactBodies is called from _resetUiForNewSession (session
  // switch) AND deleteSessionWithConfirm (active-session delete).
  // Both paths wiped the plan body and destroyed the filter row.
  const start = APP.search(/function\s+clearArtifactBodies\s*\(/);
  assert.ok(start > -1);
  const rest = APP.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  assert.ok(/_stashPlanFilterRow\s*\(/.test(body),
    'clearArtifactBodies must call _stashPlanFilterRow() before wiping each artifact body — otherwise session switches + active-session deletes destroy the plan filter row');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
