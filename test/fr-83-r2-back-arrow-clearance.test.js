// fr-83 r2 — broader chrome clearance for the file-pane "<" buttons.
//
// User clarification (kkrazy 2026-05-26): "the `<` to go back to
// previous folder is overlapping with the back-to-home icon, not the
// hide the directory pane icon".
//
// r1 (fr-83 Part 1) handled the wrong `<` — it shifted
// #files-tree-collapse (the panel-hide chevron) down when the tree
// was in its 36px-strip mode + sidebar collapsed. That fixed ONE of
// three overlap cases.
//
// The user's actual report is about #files-tree-back (the "Up one
// level" chevron, visible only when you've navigated into a
// subfolder). It sits at the LEFT of #files-header in normal-tree
// state (NOT collapsed-tree). When sidebar is collapsed, the tree
// pane starts at x=0, so the back-arrow lands in the same top-left
// ~46px square as ☰ (#btn-expand). Same root cause, different button.
//
// A third sibling case: #files-view-back (Back to tree) in
// .files-view-header-nav — when sidebar collapsed + a file is open,
// it has the same collision.
//
// The fix is the mobile pattern: padding-left: 54px (= 10 +
// chrome-btn-size + 8 gap) on the headers when sidebar is collapsed.
// Mobile already does this for ALL viewports (see the @media block).
// We extend it to desktop-when-collapsed.
//
// Pre-existing fr-83 Part 1 padding-top still applies in the special
// 36px-strip case (the strip is too narrow for padding-left to
// reposition content — padding-top is the right tool there).

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

console.log('── fr-83 r2: back-arrow clearance under sidebar-collapsed ──');

// ── Confirm the three back-arrows we're protecting actually exist ──

t('html: #files-tree-back (Up one level) is a chevron-left in #files-header', () => {
  // The "Up" button — visible only when the user has navigated into a
  // subfolder (JS toggles its `hidden` attr).
  const re = /<button[^>]*id="files-tree-back"[\s\S]{0,300}?<\/button>/;
  const m = HTML.match(re);
  assert.ok(m, '#files-tree-back must exist');
  assert.ok(/m15 18-6-6 6-6/.test(m[0]),
    '#files-tree-back must be the chevron-left SVG (m15 18-6-6 6-6 path)');
});

t('html: #files-view-back (Back to tree) is a chevron-left in .files-view-header-nav', () => {
  const re = /<button[^>]*id="files-view-back"[\s\S]{0,300}?<\/button>/;
  const m = HTML.match(re);
  assert.ok(m, '#files-view-back must exist');
  assert.ok(/m15 18-6-6 6-6/.test(m[0]),
    '#files-view-back must be the chevron-left SVG');
});

// ── The fix: chrome-clearance padding-left when sidebar collapsed ──

t('css: html.sidebar-collapsed #files-header reserves padding-left for ☰ clearance', () => {
  // Apply when sidebar collapsed AND tree is in normal-width mode
  // (the 36px strip can't use padding-left — that case still uses
  // padding-top from fr-83 Part 1). Scan every rule block, find the
  // one whose selector list mentions BOTH `sidebar-collapsed` AND
  // `#files-header` AND opts out of the collapsed-tree state, and
  // verify it declares a chrome-clearance padding-left.
  const rules = CSS.match(/[^{}]+\{[^}]*\}/g) || [];
  const hit = rules.find((r) =>
    /sidebar-collapsed/.test(r) &&
    /#files-header/.test(r) &&
    /:not\(\.files-tree-collapsed\)/.test(r) &&
    /padding-left:\s*\d+px/.test(r)
  );
  assert.ok(hit, 'sidebar-collapsed + NOT collapsed-tree #files-header rule must reserve padding-left');
  const m = hit.match(/padding-left:\s*(\d+)px/);
  assert.ok(parseInt(m[1], 10) >= 46,
    `padding-left must be ≥ 46px (chrome-btn-size + 10 + a few px); got ${m[1]}px`);
});

t('css: html.sidebar-collapsed .files-view-header-nav reserves padding-left for ☰ clearance', () => {
  // Same protection for #files-view-back inside the viewer-pane
  // header — when a file is open with sidebar collapsed, viewer
  // starts at x=0 and the back-to-tree button shares the corner
  // with ☰.
  const re = /html\.sidebar-collapsed[^{]*\.files-view-header-nav\s*\{[\s\S]{0,500}?padding-left:\s*(\d+)px/;
  const m = CSS.match(re);
  assert.ok(m, 'sidebar-collapsed .files-view-header-nav must reserve padding-left');
  assert.ok(parseInt(m[1], 10) >= 46,
    `padding-left must be ≥ 46px; got ${m[1]}px`);
});

// ── Pre-existing fr-83 Part 1 collapsed-tree rule still in place ──

t('css: fr-83 Part 1 padding-top rule (collapsed-tree strip case) is still active', () => {
  // The 36px-strip case still needs the vertical shift — padding-left
  // can't work in a 36px-wide container with centered content. Don't
  // regress it.
  assert.ok(
    /html\.sidebar-collapsed[^{]*#files-wrap\.files-tree-collapsed[^{]*#files-tree-pane[^{]*#files-header\s*\{[\s\S]{0,400}padding-top:\s*calc/.test(CSS),
    'fr-83 Part 1 collapsed-tree padding-top rule must remain — strip is too narrow for padding-left'
  );
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
