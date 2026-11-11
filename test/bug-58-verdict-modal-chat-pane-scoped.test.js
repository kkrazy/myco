// bug-58: critic verdict modal overflows chat window width.
//
// User-reported (verbatim):
//   "The critic verdict modal renders wider than the chat window,
//    breaking the layout. Expected: Modal width matches the chat
//    window width. Actual: Modal spans outside the chat window
//    bounds."
//
// Root cause: bug-55 r2 made the verdict pane a true modal overlay
// via `position: fixed; inset: 0` which covers the WHOLE viewport.
// On wide screens with sidebar chrome (e.g. desktop with the
// artifact-tab strip open) the backdrop visibly extended past the
// chat-window edges, breaking layout.
//
// Fix: scope the modal to the chat-pane container via
// `position: absolute`. #chatpane is itself `position:absolute
// inset:0` so it's the nearest positioned ancestor — the verdict
// modal now fills the chat-pane bounds exactly (modal width ==
// chat-window width). Backdrop + content card both live within
// chat-pane bounds.
//
// Also: padding 5vh/5vw → 20px (viewport-relative units don't make
// sense inside a sub-viewport container), and content-card
// max-height 90vh → calc(100% - 40px) (parent-relative cap that
// accounts for the parent's 20px top/bottom padding).
//
// bug-55's truly-modal CONTRACT (no backdrop click dismiss, no Esc)
// is UNCHANGED — that wiring lives in app.js's _renderVerdictPanel,
// not in CSS, and is unaffected by the scoping change.
//
// Test shape: static-grep on the locked CSS surface.

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

// bug-58 test note: the bug-58 provenance comment block legitimately
// mentions "position: fixed" and "padding: 5vh 5vw" when explaining
// what was REMOVED. The strict-regex assertions below would false-
// positive on those comment mentions; strip CSS comments before
// matching. Same pattern as bug-50's _stripCssComments helper.
function _stripCssComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }

console.log('── bug-58: verdict modal scoped to chat-pane (no viewport overflow) ──');

// ── 1. The fix: position: absolute on .chat-composer-verdict-panel ──

t('styles.css: .chat-composer-verdict-panel uses position: absolute (NOT position: fixed)', () => {
  const css = _stripCssComments(_read('web/public/styles.css'));
  const at = css.search(/\.chat-composer-verdict-panel\s*\{/);
  assert.ok(at > -1, '.chat-composer-verdict-panel rule must exist.');
  const block = css.slice(at, at + 1500);
  assert.ok(/position\s*:\s*absolute/.test(block),
    '.chat-composer-verdict-panel must use position: absolute — scopes the modal to the nearest positioned ancestor (#chatpane) so the modal width matches chat-window width (bug-58).');
  // The OLD value must be GONE. Without this guard, a future merge
  // could revert to position:fixed and re-introduce the viewport-
  // overflow bug.
  assert.ok(!/position\s*:\s*fixed/.test(block),
    '.chat-composer-verdict-panel must NOT use position: fixed — that\'s the pre-bug-58 viewport-scoped form that caused the overflow.');
});

t('styles.css: .chat-composer-verdict-panel keeps inset: 0 (fills the containing block)', () => {
  const css = _read('web/public/styles.css');
  const at = css.search(/\.chat-composer-verdict-panel\s*\{/);
  const block = css.slice(at, at + 1500);
  assert.ok(/inset\s*:\s*0/.test(block),
    '.chat-composer-verdict-panel must keep inset: 0 — together with position:absolute that means "fill the nearest positioned ancestor" (which is #chatpane).');
});

// ── 2. The padding adjustment ──

t('styles.css: .chat-composer-verdict-panel uses pixel-based padding (NOT vh/vw)', () => {
  const css = _stripCssComments(_read('web/public/styles.css'));
  const at = css.search(/\.chat-composer-verdict-panel\s*\{/);
  const block = css.slice(at, at + 1500);
  // The pre-bug-58 padding was 5vh 5vw. Inside a sub-viewport
  // container, vh/vw is misleading — it computes against the
  // viewport, not the parent. 20px is parent-relative-enough.
  assert.ok(/padding\s*:\s*20px/.test(block),
    '.chat-composer-verdict-panel must use padding: 20px — pixel-based instead of the pre-bug-58 5vh/5vw which computed against the viewport.');
  assert.ok(!/padding\s*:\s*5vh\s+5vw/.test(block),
    '.chat-composer-verdict-panel must NOT use padding: 5vh 5vw — that was the pre-bug-58 viewport-relative value that became misleading inside a sub-viewport container.');
});

// ── 3. The content-card max-height adjustment ──

t('styles.css: .verdict-panel-content uses parent-relative max-height (calc(100% - 40px), NOT 90vh)', () => {
  const css = _read('web/public/styles.css');
  const at = css.search(/\.chat-composer-verdict-panel\s*>\s*\.verdict-panel-content\s*\{/);
  assert.ok(at > -1, '.verdict-panel-content rule must exist.');
  const block = css.slice(at, at + 1500);
  assert.ok(/max-height\s*:\s*calc\(\s*100%\s*-\s*40px\s*\)/.test(block),
    '.verdict-panel-content must use max-height: calc(100% - 40px) — parent-relative (accounts for the parent\'s 20px top + 20px bottom padding) instead of the pre-bug-58 90vh.');
  assert.ok(!/max-height\s*:\s*90vh/.test(block),
    '.verdict-panel-content must NOT use max-height: 90vh — that was the pre-bug-58 viewport-relative cap; inside a sub-viewport container it could either over- or under-shoot.');
});

// ── 4. Modal layout preserved (still flexbox-centered) ──

t('styles.css: .chat-composer-verdict-panel still uses display:flex + align/justify center (modal centering preserved from bug-50 r2)', () => {
  const css = _read('web/public/styles.css');
  const at = css.search(/\.chat-composer-verdict-panel\s*\{/);
  const block = css.slice(at, at + 1500);
  // The centering layout is preserved — only the positioning
  // context (viewport → chat-pane) changed.
  assert.ok(/display\s*:\s*flex/.test(block),
    '.chat-composer-verdict-panel must keep display: flex — modal-centering layout preserved (bug-50 r2).');
  assert.ok(/align-items\s*:\s*center/.test(block),
    '.chat-composer-verdict-panel must keep align-items: center.');
  assert.ok(/justify-content\s*:\s*center/.test(block),
    '.chat-composer-verdict-panel must keep justify-content: center.');
});

t('styles.css: .verdict-panel-content still uses overflow-y:auto + max-width:960px (content cap preserved)', () => {
  const css = _read('web/public/styles.css');
  const at = css.search(/\.chat-composer-verdict-panel\s*>\s*\.verdict-panel-content\s*\{/);
  const block = css.slice(at, at + 1500);
  // The card-shape contract from bug-50 r2 is preserved — only the
  // height computation context changed.
  assert.ok(/overflow-y\s*:\s*auto/.test(block),
    '.verdict-panel-content must keep overflow-y: auto so an enormous critique scrolls inside the modal.');
  assert.ok(/max-width\s*:\s*960px/.test(block),
    '.verdict-panel-content must keep max-width: 960px — the card cap from bug-50 r2.');
});

// ── 5. bug-55 truly-modal contract (button-only dismissal) preserved ──

t('app.js: bug-55 truly-modal contract preserved (no backdrop click handler, no Esc handler in _renderVerdictPanel)', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/function\s+_renderVerdictPanel\s*\(\)/);
  const body = sliceFn(src, at);
  // bug-58's CSS change is purely about the modal's positioning
  // context. The dismissal wiring lives in JS and must stay GONE
  // (bug-55 contract).
  assert.ok(!/const\s+safeToDismissByBackdrop\s*=/.test(body),
    '_renderVerdictPanel must still NOT contain safeToDismissByBackdrop (bug-55 contract preserved through bug-58 CSS-only fix).');
  assert.ok(!/panel\.addEventListener\s*\(\s*['"]click['"][\s\S]{0,200}e\.target\s*===\s*panel/.test(body),
    '_renderVerdictPanel must still NOT contain a backdrop click-dismiss handler (bug-55 contract preserved).');
  assert.ok(!/document\.addEventListener\s*\(\s*['"]keydown['"]/.test(body),
    '_renderVerdictPanel must still NOT contain an Esc-key dismiss handler (bug-55 contract preserved).');
});

// ── 6. Marker comments ──

t('a comment naming "bug-58" appears in styles.css with provenance for the position + padding + max-height changes', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/bug-58/.test(css),
    'styles.css must carry a bug-58 marker so a future restyle knows the position:absolute / pixel-padding / calc-max-height are intentional.');
  // The provenance comment block must call out the user-reported
  // overflow + the chat-pane-scoping fix so a future reader
  // understands the WHY, not just the WHAT.
  assert.ok(/overflows?\s+chat\s+window|spans?\s+outside\s+the\s+chat\s+window|scoped?\s+to\s+the\s+chat-pane/i.test(css),
    'the bug-58 provenance comment must reference the user\'s report (chat-window overflow) and the chat-pane scoping fix.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
