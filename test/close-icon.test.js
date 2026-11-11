// close-icon — user-driven icon iteration on the .artifact-item-close
// button (the post-bug-49 sole lifecycle affordance for plan items).
//
// History on this button:
//   r0  Lucide 'check' (✓) for close — user: "checkmark isn't obvious
//       close" → r1
//   r1  Lucide 'x' (×) — user wanted more options
//   r2  Hand-rolled 'check-popout' (checkmark whose tail pokes through
//       the top-right of a closed circle, sketched by the user) —
//       reads as "mark complete with emphasis"; the closing of the
//       circle PLUS the check's pop-through tail communicates close
//       AND completion in one glyph.
//
// Fix (r2): add a 'check-popout' entry to LUCIDE_PATHS containing a
// `<circle cx=12 cy=12 r=8>` + a `<polyline points="7 12 12 17 22 2">`
// (the polyline's tail at (22,2) is well outside the r=8 circle, so
// the check visually pokes out). Swap closeIcon from _lucideIcon('x')
// to _lucideIcon('check-popout'). Reopen branch stays 'rotate-ccw'.
//
// Test shape: static-grep that LUCIDE_PATHS contains a 'check-popout'
// key with both the circle + polyline, and that the closeIcon
// ternary picks 'check-popout' for the open → close branch.

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

console.log('── close-icon r2: check-popout (hand-rolled per user sketch) ──');

t('web/public/app.js: LUCIDE_PATHS registers a "check-popout" composite (circle + polyline)', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/const\s+LUCIDE_PATHS\s*=\s*\{/);
  assert.ok(at > -1, 'LUCIDE_PATHS must exist (anchor for the icon-registry scan).');
  const body = app.slice(at, at + 4000);
  assert.ok(/['"]check-popout['"]\s*:/.test(body),
    "LUCIDE_PATHS must define a 'check-popout' entry — the hand-rolled icon the user sketched (checkmark pokes through top-right of a closed circle).");
  // The entry must include BOTH a circle and a polyline — that's the
  // popout composite. A bare polyline would be just the check; a bare
  // circle would be just an O. Anchor on the key, then look in the
  // ~400-char window that follows (the value is single-quote-wrapped
  // in LUCIDE_PATHS but contains literal `"` chars in the SVG
  // attributes, so we can't match between matching quote types
  // cleanly — proximity scan is sufficient here).
  const keyAt = body.indexOf("'check-popout'");
  assert.ok(keyAt > -1, "could not locate the check-popout key in LUCIDE_PATHS.");
  const valueWindow = body.slice(keyAt, keyAt + 400);
  assert.ok(/<circle\b/.test(valueWindow),
    "check-popout entry must contain a <circle> element (the close-ring around the check).");
  assert.ok(/<polyline\b/.test(valueWindow),
    "check-popout entry must contain a <polyline> element (the check itself).");
});

t('web/public/app.js: close button uses _lucideIcon("check-popout") for the open → close action', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/const\s+closeIcon\s*=/);
  assert.ok(at > -1, 'closeIcon ternary assignment must exist in renderItem.');
  const line = app.slice(at, app.indexOf(';', at) + 1);
  // r2: the OPEN → close branch is the `: <fallback>` half of the
  // ternary. Must call _lucideIcon('check-popout'). The DONE →
  // reopen branch stays at rotate-ccw.
  assert.ok(/_lucideIcon\s*\(\s*['"]check-popout['"]\s*\)/.test(line),
    "the closeIcon ternary must call _lucideIcon('check-popout') for the open-item branch (close-icon r2 user-sketched composite). Current line: " + line);
  assert.ok(!/_lucideIcon\s*\(\s*['"]check['"]\s*\)|_lucideIcon\s*\(\s*['"]x['"]\s*\)/.test(line),
    "the closeIcon ternary must NOT use the older 'check' or 'x' icons anymore — both were superseded by 'check-popout' in r2. Current line: " + line);
  assert.ok(/_lucideIcon\s*\(\s*['"]rotate-ccw['"]\s*\)/.test(line),
    "the closeIcon ternary must still use _lucideIcon('rotate-ccw') for the done-item (reopen) branch. Current line: " + line);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
