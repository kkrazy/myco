// bug-50: critic message displays in full (no longer scroll-trapped
// in a tiny 180px window).
//
// User-reported (verbatim, plan-item dispatch from @labxnow):
//   "critic message is not display in full"
//
// Root cause: .verdict-critique had `max-height: 180px` capping the
// visible critique to ~10 lines on desktop. Long Gemini verdicts
// (multiple flagged issues + diff-line citations) ended up scroll-
// trapped inside a tiny window, forcing the user to drag a thin
// inner scrollbar instead of reading the verdict at a glance.
//
// Fix: bump .verdict-critique max-height from 180px to a viewport-
// relative value (60vh) so most critiques fit on screen on both
// desktop and mobile. overflow-y: auto stays as a safety net for
// the rare extreme case (giant bullet lists with code blocks).
//
// Test shape: static-grep that .verdict-critique no longer uses
// the small 180px cap AND uses a value that's clearly larger.

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

console.log('── bug-50: critic message displays in full ──');

t('web/public/styles.css: .verdict-critique max-height is no longer the original 180px cap', () => {
  const css = _read('web/public/styles.css');
  // Locate the .verdict-critique rule body.
  const re = /\.verdict-critique\s*\{[^}]*\}/;
  const block = (css.match(re) || [''])[0];
  assert.ok(block, '.verdict-critique rule must exist (anchor for the max-height scan).');
  // The cap must be greater than the pre-fix 180px. Accept any
  // viewport-relative value (vh) OR a px value greater than 180.
  // The user's complaint won't recur as long as the cap is well
  // above the line-count of a typical critique.
  const mhMatch = block.match(/max-height\s*:\s*([^;]+);/);
  assert.ok(mhMatch, '.verdict-critique must declare a max-height (bug-50 fix uses a generous viewport-relative value; pre-fix used 180px).');
  const value = mhMatch[1].trim();
  // Reject the regressing pre-fix value verbatim.
  assert.ok(!/^180\s*px$/i.test(value),
    `.verdict-critique max-height must NOT be the pre-fix 180px cap (user-reported "critic message is not display in full"). Got: ${value}`);
  // Accept any vh value, vmax, vmin, percentage > 50%, OR px value > 400.
  const isVh = /vh\b/.test(value);
  const isVmax = /vmax\b/.test(value);
  const isPercent = /(\d+)\s*%/.test(value);
  const px = parseInt((value.match(/(\d+)\s*px/) || [])[1] || '0', 10);
  const generous = isVh || isVmax || isPercent || px > 400;
  assert.ok(generous,
    `.verdict-critique max-height must be a generous value (e.g. 60vh, 70%, or 600px+) so the full critic message fits without scrolling on typical screens. Got: ${value}`);
});

t('web/public/styles.css: .verdict-critique keeps overflow-y: auto as a safety net', () => {
  const css = _read('web/public/styles.css');
  const re = /\.verdict-critique\s*\{[^}]*\}/;
  const block = (css.match(re) || [''])[0];
  assert.ok(/overflow-y\s*:\s*auto\b/.test(block),
    '.verdict-critique must keep overflow-y: auto as a safety net for the rare extreme-length critique (giant bullet lists with code blocks). Removing it entirely would let an enormous critique push the discard/accept buttons off-screen.');
});

t('a comment naming bug-50 explains the max-height bump', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/bug-50/.test(css),
    'a comment naming bug-50 must appear near the .verdict-critique rule so a future restyle understands why the cap is 60vh rather than the original 180px.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
