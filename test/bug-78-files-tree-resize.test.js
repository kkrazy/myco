// bug-78: file explorer directory view not horizontally resizable,
// truncates long filenames.
//
// User report (2026-06-09):
//   "Long filenames in the file explorer directory view are truncated
//    with no way to reveal the full name. Expected: the directory view
//    panel should be expandable by dragging its edge so users can
//    widen it to see complete filenames."
//
// Root cause: #files-tree-pane (the directory tree pane in #files-wrap)
// has a fixed `width: 220px` in styles.css with only a binary collapse
// toggle (◀ button → 36px strip). No drag-resize handle exists; long
// filenames clip at the 220px boundary.
//
// Fix mirrors the existing bindChatpaneResize pattern (app.js:10979 —
// horizontal drag-resize on #chatpane with persistence via localStorage
// and a mobile no-op below 900px). The same pattern, applied to
// #files-tree-pane:
//   1. HTML: add <div id="files-tree-resize" class="files-tree-resize-
//      handle" role="separator" aria-orientation="vertical" ...>
//      as a sibling of #files-tree-pane inside #files-wrap.
//   2. CSS: change #files-tree-pane width from `220px` to
//      `var(--files-tree-w, 220px)`. Add .files-tree-resize-handle
//      ruleset (vertical strip, col-resize cursor, hover + dragging
//      states). Hide on .files-tree-collapsed + on mobile @media.
//   3. JS: bindFilesTreeResize() function — pointerdown/move/up
//      listeners, width clamp [180, 0.6*vw], persist to
//      localStorage.myco_files_tree_w, double-click resets to 220,
//      mobile no-op below 900px. Wired from bindFilesUi().
//
// Test shape: static-grep guards across the three files (no JSDOM —
// matches the bug-72 / bug-71 client-side test pattern).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-78: file explorer tree pane drag-to-resize ──');

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}
const APP_JS = _read('web/public/app.js');
const INDEX_HTML = _read('web/public/index.html');
const STYLES_CSS = _read('web/public/styles.css');

// ── 1. HTML: the resize handle element exists inside #files-wrap ──

t('index.html: #files-wrap contains a #files-tree-resize handle element', () => {
  assert.ok(/id=["']files-tree-resize["']/.test(INDEX_HTML),
    'bug-78: index.html must contain an element with id="files-tree-resize" — this is the visible drag handle. Without it, the JS bindFilesTreeResize() has nothing to wire pointer events to and the user has no affordance to grab.');
});

t('index.html: the handle carries role="separator" + aria-orientation="vertical" for accessibility', () => {
  // Find the handle element. Look for a generous window so future
  // attribute reorder doesn't break the test.
  const at = INDEX_HTML.search(/id=["']files-tree-resize["']/);
  const tagOpen = INDEX_HTML.lastIndexOf('<', at);
  const tagClose = INDEX_HTML.indexOf('>', at);
  assert.ok(tagOpen > -1 && tagClose > -1);
  const tag = INDEX_HTML.slice(tagOpen, tagClose + 1);
  assert.ok(/role=["']separator["']/.test(tag),
    'bug-78: the resize handle must carry role="separator" so screen readers announce it as a resize boundary, not a generic div.');
  assert.ok(/aria-orientation=["']vertical["']/.test(tag),
    'bug-78: the resize handle must carry aria-orientation="vertical" so screen readers know which axis the drag operates on.');
});

// ── 2. CSS: the tree pane uses a CSS variable for width + the handle has a ruleset ──

t('styles.css: #files-tree-pane width uses var(--files-tree-w, ...) so the JS can drive it via custom property', () => {
  // Locate the #files-tree-pane block.
  const idx = STYLES_CSS.search(/#files-tree-pane\s*\{/);
  assert.ok(idx > -1, '#files-tree-pane ruleset must exist');
  const block = STYLES_CSS.slice(idx, idx + 1500);
  assert.ok(/width\s*:\s*var\(\s*--files-tree-w/.test(block),
    'bug-78: #files-tree-pane.width must reference var(--files-tree-w, FALLBACK) so the JS resize handler can drive it by setting the CSS variable on the root (matches the bindChatpaneResize pattern with --chatpane-w). Pre-fix the width was a hardcoded 220px and could not be driven by JS without inline-style hacks.');
});

t('styles.css: .files-tree-resize-handle has its own ruleset with cursor:col-resize', () => {
  assert.ok(/\.files-tree-resize-handle\s*\{/.test(STYLES_CSS),
    'bug-78: .files-tree-resize-handle must have a CSS ruleset — without it the handle is unstyled and invisible.');
  // Cursor cue for the drag affordance.
  const idx = STYLES_CSS.search(/\.files-tree-resize-handle\s*\{/);
  const block = STYLES_CSS.slice(idx, idx + 800);
  assert.ok(/cursor\s*:\s*col-resize/.test(block),
    'bug-78: .files-tree-resize-handle must set cursor:col-resize so the user sees the horizontal-drag affordance on hover.');
});

t('styles.css: .files-tree-resize-handle is hidden when the tree is collapsed', () => {
  // The collapse-strip is too narrow to host a drag handle; hide it.
  // Look for a selector chain like `#files-wrap.files-tree-collapsed
  // .files-tree-resize-handle` or `#files-wrap.files-tree-collapsed
  // #files-tree-resize` with display:none / visibility:hidden.
  assert.ok(/files-tree-collapsed[\s\S]{0,200}(files-tree-resize|#files-tree-resize)[\s\S]{0,200}(display\s*:\s*none|visibility\s*:\s*hidden)|files-tree-collapsed[\s\S]{0,400}(files-tree-resize|#files-tree-resize)/.test(STYLES_CSS),
    'bug-78: when #files-wrap.files-tree-collapsed is active, the resize handle must be hidden — the 36px collapse-strip is too narrow to drag and the handle would overlap the ▶ expand button. (Lookup: any rule that targets the handle under the collapsed class.)');
});

t('styles.css: .files-tree-resize-handle is hidden on mobile (≤900px)', () => {
  // Mobile presents the files pane as an overlay; drag would conflict
  // with touch scroll. Match the bindChatpaneResize convention.
  assert.ok(/@media[^{]*max-width:\s*900px[\s\S]{0,2000}(files-tree-resize|#files-tree-resize)[\s\S]{0,200}(display\s*:\s*none|visibility\s*:\s*hidden)/.test(STYLES_CSS),
    'bug-78: a @media (max-width: 900px) block must hide the handle on mobile — drag would conflict with touch scroll on the overlay-style files pane. Matches the bindChatpaneResize mobile no-op convention.');
});

// ── 3. JS: bindFilesTreeResize() function exists + wires pointer events ──

t('app.js: bindFilesTreeResize() function is defined', () => {
  assert.ok(/function\s+bindFilesTreeResize\s*\(/.test(APP_JS),
    'bug-78: app.js must define a bindFilesTreeResize() function (mirrors bindChatpaneResize at app.js:10979). Without it, the handle element has no listeners and dragging does nothing.');
});

t('app.js: bindFilesTreeResize wires pointerdown/move/up listeners on the handle', () => {
  const at = APP_JS.search(/function\s+bindFilesTreeResize\s*\(/);
  assert.ok(at > -1);
  const body = sliceFn(APP_JS, at);
  for (const ev of ['pointerdown', 'pointermove', 'pointerup']) {
    assert.ok(new RegExp(`addEventListener\\(\\s*['"]${ev}['"]`).test(body),
      `bug-78: bindFilesTreeResize must wire ${ev} listener on the handle — that's the pointer-event trio the bindChatpaneResize pattern uses for drag-tracking.`);
  }
});

t('app.js: bindFilesTreeResize is a no-op on mobile (≤900px viewport)', () => {
  const at = APP_JS.search(/function\s+bindFilesTreeResize\s*\(/);
  const body = sliceFn(APP_JS, at);
  // Look for a window.innerWidth <= 900 (or < 900) guard in the
  // pointerdown handler.
  assert.ok(/window\.innerWidth\s*<=?\s*900/.test(body),
    'bug-78: bindFilesTreeResize must skip the drag on mobile (window.innerWidth <= 900) — matches the bindChatpaneResize convention. Without this, dragging on mobile fights touch scroll.');
});

t('app.js: bindFilesTreeResize persists width to localStorage.myco_files_tree_w', () => {
  const at = APP_JS.search(/function\s+bindFilesTreeResize\s*\(/);
  const body = sliceFn(APP_JS, at);
  assert.ok(/localStorage\.(setItem|getItem|removeItem)\(\s*['"]myco_files_tree_w['"]/.test(body) ||
            /localStorage\.myco_files_tree_w/.test(body),
    'bug-78: bindFilesTreeResize must persist the chosen width to localStorage key "myco_files_tree_w" — matches the bindChatpaneResize pattern (key "myco_chatpane_w") so the user\'s width choice survives reloads.');
});

t('app.js: bindFilesTreeResize drives the --files-tree-w CSS variable', () => {
  const at = APP_JS.search(/function\s+bindFilesTreeResize\s*\(/);
  const body = sliceFn(APP_JS, at);
  assert.ok(/--files-tree-w/.test(body),
    'bug-78: bindFilesTreeResize must set/read the --files-tree-w CSS variable — that\'s how the new width reaches the tree pane (matches the bindChatpaneResize pattern with --chatpane-w).');
});

t('app.js: bindFilesTreeResize is called from initialization (so the handle is wired when the explorer opens)', () => {
  // The call site can be either inside bindFilesUi() OR at top-level
  // init. Either is fine. Just confirm SOMEWHERE outside the function
  // definition calls it.
  const defAt = APP_JS.search(/function\s+bindFilesTreeResize\s*\(/);
  // Look for a call site that isn't the definition.
  const allCalls = [...APP_JS.matchAll(/bindFilesTreeResize\s*\(/g)];
  // First match is the definition; we need at least one more.
  assert.ok(allCalls.length >= 2,
    `bug-78: bindFilesTreeResize must be CALLED somewhere (not just defined) — without a call, the handle stays dead UI. Found ${allCalls.length} occurrence(s); need at least 2 (definition + at least one call site).`);
});

// ── 4. Marker comment for provenance ──

t('a "bug-78" comment marker appears in app.js and styles.css for provenance', () => {
  assert.ok(/bug-78/.test(APP_JS),
    'bug-78: at least one comment in app.js must name "bug-78" so a future refactor can trace these additions back to the user report.');
  assert.ok(/bug-78/.test(STYLES_CSS),
    'bug-78: at least one comment in styles.css must name "bug-78" so a future restyle can trace the new ruleset back to the user report.');
});

console.log(`── bug-78: ${passed} passed, ${failed} failed ──`);
process.exit(failed === 0 ? 0 : 1);
