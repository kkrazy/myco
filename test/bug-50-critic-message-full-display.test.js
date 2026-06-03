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

// bug-50 r1: the original fix (180px → 60vh + overflow-y: auto) was
// a half-measure. The user re-dispatched bug-50 with the same
// verbatim complaint — "critic message is not display in full" —
// because 60vh + overflow-y: auto STILL produced a scrollbar inside
// a clipped frame. The user's words are "display in full", i.e. no
// inner clip at all. The verdict-pane sits inside the chat-pane
// flow which scrolls naturally, so the inner cap was redundant.
//
// r1 contract: `.verdict-critique` has NO max-height (or
// max-height: none) AND NO inner overflow-y. The chat pane's
// natural scroll handles the rare extreme-length case.

// Strip CSS comments BEFORE scanning so the explanatory bug-50 r1
// comment (which describes the OLD max-height: 60vh + overflow-y:
// auto declarations as part of the design rationale) doesn't trip
// the property-absence asserts below.
function _stripCssComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }

t('web/public/styles.css: .verdict-critique has NO max-height cap (r1 — the 60vh fix still clipped; r1 lets the message flow at natural height)', () => {
  const css = _stripCssComments(_read('web/public/styles.css'));
  const re = /\.verdict-critique\s*\{[^}]*\}/;
  const block = (css.match(re) || [''])[0];
  assert.ok(block, '.verdict-critique rule must exist.');
  const mhMatch = block.match(/max-height\s*:\s*([^;]+);/);
  if (mhMatch) {
    // If the property is present, it must be `none` (explicit
    // "no cap") rather than any positive value.
    const value = mhMatch[1].trim();
    assert.ok(/^none\b/i.test(value),
      `.verdict-critique must NOT carry a positive max-height (r1 — the original 60vh fix still clipped; the message must flow at natural height). Got: ${value}`);
  }
  // Either no declaration at all, or `max-height: none`. Both
  // satisfy the r1 contract.
});

t('web/public/styles.css: .verdict-critique has NO inner overflow-y: auto (r1 — chat-pane scroll handles it naturally)', () => {
  const css = _stripCssComments(_read('web/public/styles.css'));
  const re = /\.verdict-critique\s*\{[^}]*\}/;
  const block = (css.match(re) || [''])[0];
  assert.ok(!/overflow-y\s*:\s*auto\b/.test(block),
    '.verdict-critique must NOT declare overflow-y: auto (r1 — the inner scrollbar is exactly what the user is complaining about). The chat-pane already scrolls; let it.');
  assert.ok(!/overflow-y\s*:\s*scroll\b/.test(block),
    '.verdict-critique must NOT declare overflow-y: scroll either (r1).');
});

t('a comment naming "bug-50 r1" explains why the max-height + overflow were REMOVED (not just bumped)', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/bug-50 r1/.test(css),
    'a comment naming "bug-50 r1" must appear near the .verdict-critique rule so a future restyle understands the cap was DELIBERATELY removed (not forgotten) — the user re-dispatched after the original 60vh fix because it still clipped.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
