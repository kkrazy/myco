// close-icon-uses-x — user-reported icon swap.
//
// User-reported (verbatim):
//   "Replace the checkmark icon to close icon, checkmark is not
//    obvious close"
//
// State before this fix:
//   · The .artifact-item-close button (the post-bug-49 sole lifecycle
//     affordance) used Lucide 'check' (✓) for the close action and
//     'rotate-ccw' (↻) for the reopen action. The check glyph reads
//     as "mark complete", not "close" — so users land on the wrong
//     mental model when they want to close an item without marking
//     it conceptually done.
//
// Fix: swap the close-action icon from 'check' to 'x' (the standard
// close glyph). The reopen-action icon stays as 'rotate-ccw' (still
// reads cleanly as "undo close"). Adds an 'x' entry to LUCIDE_PATHS
// (web/public/app.js) since the registry didn't have one yet.
//
// Test shape: static-grep that LUCIDE_PATHS contains an 'x' key, and
// that the closeIcon ternary picks 'x' for the open → close branch.

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

console.log('── close-icon-uses-x: ✓ → × for plan-item close action ──');

t('web/public/app.js: LUCIDE_PATHS registers an "x" icon (two-stroke close glyph)', () => {
  const app = _read('web/public/app.js');
  // Find the LUCIDE_PATHS object literal + assert it has an 'x' key.
  const at = app.search(/const\s+LUCIDE_PATHS\s*=\s*\{/);
  assert.ok(at > -1, 'LUCIDE_PATHS must exist (anchor for the icon-registry scan).');
  // The registry runs ~15 lines / ~2000 chars. Look for an 'x' key
  // followed by a colon and an SVG path string within the object body.
  const body = app.slice(at, at + 3000);
  assert.ok(/['"]x['"]\s*:\s*['"`]<(path|line|polyline)/.test(body),
    "LUCIDE_PATHS must define an 'x' entry pointing at the standard Lucide x glyph (two crossing strokes). Without this, _lucideIcon('x') returns empty and the close button renders without an icon.");
});

t('web/public/app.js: close button uses _lucideIcon("x") for the open → close action', () => {
  const app = _read('web/public/app.js');
  // The closeIcon assignment lives in renderItem near the
  // .artifact-item-close button. Pre-fix:
  //   const closeIcon = it.done ? _lucideIcon('rotate-ccw') : _lucideIcon('check');
  // Post-fix:
  //   const closeIcon = it.done ? _lucideIcon('rotate-ccw') : _lucideIcon('x');
  const at = app.search(/const\s+closeIcon\s*=/);
  assert.ok(at > -1, 'closeIcon ternary assignment must exist in renderItem.');
  const line = app.slice(at, app.indexOf(';', at) + 1);
  // The OPEN → close branch is the `: <fallback>` half of the ternary.
  // Must call _lucideIcon('x'). The DONE → reopen branch (before the
  // colon) stays at rotate-ccw.
  assert.ok(/_lucideIcon\s*\(\s*['"]x['"]\s*\)/.test(line),
    "the closeIcon ternary must call _lucideIcon('x') for the open-item branch — the user reported the checkmark wasn't reading as 'close'. Current line: " + line);
  assert.ok(!/_lucideIcon\s*\(\s*['"]check['"]\s*\)/.test(line),
    "the closeIcon ternary must NOT use _lucideIcon('check') anymore — that's the icon being replaced. Current line: " + line);
  assert.ok(/_lucideIcon\s*\(\s*['"]rotate-ccw['"]\s*\)/.test(line),
    "the closeIcon ternary must still use _lucideIcon('rotate-ccw') for the done-item (reopen) branch. Current line: " + line);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
