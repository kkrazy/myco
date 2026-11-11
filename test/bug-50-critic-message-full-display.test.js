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
const { sliceFn } = require('./_lib/fn-body');

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

// Strip CSS comments BEFORE scanning so the explanatory bug-50 r1+r2
// comments (which describe the OLD max-height + overflow-y rules as
// part of the design rationale) don't trip the property-absence
// asserts below.
function _stripCssComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }

// ── r2: the OUTER .chat-composer-verdict-panel is now a modal overlay ──

t('web/public/styles.css r2: .chat-composer-verdict-panel is a positioned centered modal (absolute or fixed, with inset:0 + z-index)', () => {
  const css = _stripCssComments(_read('web/public/styles.css'));
  const re = /\.chat-composer-verdict-panel\s*\{[^}]*\}/;
  const block = (css.match(re) || [''])[0];
  assert.ok(block, '.chat-composer-verdict-panel rule must exist.');
  // bug-58 follow-up: was locked to position:fixed (r2's viewport-
  // wide overlay). bug-58 changed it to position:absolute so the
  // modal scopes to the chat-pane container instead of the
  // viewport (user-reported "modal overflows chat window width").
  // Both forms satisfy the r2 contract — a positioned, inset:0,
  // z-indexed modal-overlay shape — so accept either.
  assert.ok(/position\s*:\s*(absolute|fixed)/.test(block),
    '.chat-composer-verdict-panel must be position: absolute (bug-58 — chat-pane scoped) OR position: fixed (legacy r2 — viewport scoped). Both are valid modal-overlay shapes.');
  assert.ok(/inset\s*:\s*0/.test(block) || (/top\s*:\s*0/.test(block) && /left\s*:\s*0/.test(block)),
    '.chat-composer-verdict-panel must use inset: 0 (or equivalent) so the modal fills its containing block (viewport pre-bug-58, chat-pane post-bug-58).');
  assert.ok(/z-index/.test(block),
    '.chat-composer-verdict-panel must have a z-index so it floats above the chat pane.');
});

t('web/public/styles.css r2: .verdict-panel-content child holds the visual card + has max-height + internal scroll for truly enormous critiques', () => {
  const css = _stripCssComments(_read('web/public/styles.css'));
  const re = /\.verdict-panel-content\s*\{[^}]*\}|\.chat-composer-verdict-panel\s*>\s*\.verdict-panel-content\s*\{[^}]*\}/;
  const block = (css.match(re) || [''])[0];
  assert.ok(block, '.verdict-panel-content rule must exist (r2 — wrapper for the inner card).');
  // bug-58 follow-up: was locked to viewport-relative vh (90vh).
  // bug-58 changed to parent-relative calc(100% - 40px) since the
  // modal is now scoped to chat-pane (the 40px accounts for the
  // parent's 20px top + 20px bottom padding). Both express the
  // "scroll inside the modal instead of overflowing" contract; the
  // unit is just different.
  assert.ok(/max-height\s*:\s*(\d+vh|90vh|calc\([^)]*\))/.test(block),
    '.verdict-panel-content must declare a max-height (vh-based legacy OR calc()-based parent-relative post-bug-58) so an enormous critique scrolls INSIDE the modal rather than overflow.');
  assert.ok(/overflow-y\s*:\s*auto/.test(block),
    '.verdict-panel-content must declare overflow-y: auto so a truly enormous critique scrolls inside the modal.');
});

t('web/public/app.js r2: _renderVerdictPanel wraps the contents in .verdict-panel-content (modal layout — bug-55 supersedes the Esc/backdrop wiring)', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/function\s+_renderVerdictPanel\s*\(\)/);
  assert.ok(at > -1);
  const body = sliceFn(app, at);
  assert.ok(/verdict-panel-content/.test(body),
    '_renderVerdictPanel must wrap the rendered contents in a .verdict-panel-content child div (r2 — modal layout). bug-55 keeps this visual envelope; only the dismissal wiring changed.');
  // bug-55 SUPERSEDES the prior Esc/backdrop assertions: the verdict
  // pane is now truly modal — no outside-click dismiss, no Esc
  // dismiss. The stronger contract lives in
  // test/bug-55-verdict-pane-truly-modal.test.js, which asserts the
  // ABSENCE of safeToDismissByBackdrop / panel-backdrop click /
  // document-keydown Esc handlers in _renderVerdictPanel.
});

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
