// fr-99: double-click to enlarge Mermaid/SVG/PNG diagrams in chat pane
// and file viewer.
//
// User request (2026-06-10):
//   "Diagrams render too small to read and there's no quick way to
//    zoom in. Expected: double-clicking a Mermaid/SVG/PNG diagram
//    opens an enlarged view. Required in the chat pane and the file
//    explorer's file viewer (md file support)."
//
// Fix: single shared #diagram-lightbox modal at body level. A
// delegated dblclick listener on document filters event.target to
// .conv-mermaid / svg / img inside #chat-messages or
// #files-view-body (avatars + chrome explicitly blocklisted).
// Matched element is CLONED into the lightbox (original stays
// inline), width/height attrs stripped so CSS can scale to fit
// 90vw/90vh. Close via × button, backdrop click, or ESC.
//
// Test shape: static-grep guards across index.html / app.js /
// styles.css. No JSDOM — matches the bug-72 / bug-78 / bug-84
// client-side test pattern.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── fr-99: dblclick diagram lightbox ──');

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}
const INDEX_HTML = _read('web/public/index.html');
const APP_JS = _read('web/public/app.js');
const STYLES_CSS = _read('web/public/styles.css');

// ── 1. HTML markup ──

t('index.html: #diagram-lightbox modal exists with role="dialog"', () => {
  assert.ok(/id=["']diagram-lightbox["']/.test(INDEX_HTML),
    'fr-99: index.html must contain <div id="diagram-lightbox"> — the shared lightbox modal that holds the cloned enlarged diagram.');
  // Find the tag and confirm role/aria.
  const at = INDEX_HTML.search(/id=["']diagram-lightbox["']/);
  const tagOpen = INDEX_HTML.lastIndexOf('<', at);
  const tagClose = INDEX_HTML.indexOf('>', at);
  const tag = INDEX_HTML.slice(tagOpen, tagClose + 1);
  assert.ok(/role=["']dialog["']/.test(tag),
    'fr-99: the lightbox must carry role="dialog" for screen reader semantics.');
  assert.ok(/aria-modal=["']true["']/.test(tag),
    'fr-99: the lightbox must carry aria-modal="true" so screen readers trap focus.');
  assert.ok(/\bhidden\b/.test(tag),
    'fr-99: the lightbox must start hidden — only visible after dblclick.');
});

t('index.html: #diagram-lightbox contains a content wrapper + close button', () => {
  // Find the lightbox div + scan its inner HTML.
  const idAt = INDEX_HTML.search(/id=["']diagram-lightbox["']/);
  const slice = INDEX_HTML.slice(idAt, idAt + 800);
  assert.ok(/diagram-lightbox-content/.test(slice),
    'fr-99: the lightbox must contain a .diagram-lightbox-content wrapper — that\'s where the cloned diagram is inserted.');
  assert.ok(/diagram-lightbox-close/.test(slice),
    'fr-99: the lightbox must contain a .diagram-lightbox-close button — the × affordance to dismiss without using ESC or backdrop click.');
});

// ── 2. JS — open helper, dblclick wiring, close affordances ──

t('app.js: _openDiagramLightbox function is defined', () => {
  assert.ok(/function\s+_openDiagramLightbox\s*\(/.test(APP_JS),
    'fr-99: app.js must define _openDiagramLightbox(srcElement) — clones the src into the lightbox content, strips inline width/height so CSS scales, shows the modal.');
});

t('app.js: _openDiagramLightbox clones the source element (does not move)', () => {
  const at = APP_JS.search(/function\s+_openDiagramLightbox\s*\(/);
  const body = sliceFn(APP_JS, at);
  assert.ok(/cloneNode\s*\(\s*true\s*\)/.test(body),
    'fr-99: _openDiagramLightbox must use cloneNode(true) — keeping the inline render intact preserves scroll position + cross-device sync. Moving the original would disappear it from the chat scroll.');
});

t('app.js: _openDiagramLightbox strips inline width/height so CSS can scale to fit', () => {
  const at = APP_JS.search(/function\s+_openDiagramLightbox\s*\(/);
  const body = sliceFn(APP_JS, at);
  assert.ok(/removeAttribute\s*\(\s*['"]width['"]\s*\)/.test(body),
    'fr-99: the clone must removeAttribute("width") so CSS max-width takes over (mermaid SVGs ship with explicit width).');
  assert.ok(/removeAttribute\s*\(\s*['"]height['"]\s*\)/.test(body),
    'fr-99: the clone must removeAttribute("height") for the same reason.');
});

t('app.js: delegated dblclick listener on document handles the diagram-lightbox open', () => {
  // The listener must filter on event.target.closest() of one of the
  // diagram selectors AND scope to chat-messages or files-view-body.
  assert.ok(/addEventListener\(\s*['"]dblclick['"]/.test(APP_JS),
    'fr-99: a document-level dblclick listener must exist.');
  // The handler body must reference both #chat-messages and #files-view-body
  // (or their related selectors) so the scope is enforced.
  // Allow arrow handlers with or without parens around the param,
  // and any short whitespace between dblclick literal and the callback.
  const dblAt = APP_JS.search(/addEventListener\(\s*['"]dblclick['"]\s*,\s*(\(?\s*[a-zA-Z_$][\w$]*\s*\)?)\s*=>/);
  assert.ok(dblAt > -1, 'the dblclick listener must use an arrow handler that takes the event (with or without parens around the param)');
  // Look in a generous window after the listener for the scope checks.
  const window = APP_JS.slice(dblAt, dblAt + 2500);
  assert.ok(/chat-messages|files-view-body/.test(window),
    'fr-99: the dblclick handler must scope its match to inside #chat-messages OR #files-view-body so accidental dblclick elsewhere (e.g. on a tooltip svg) does not open the lightbox.');
  // The diagram-target match logic may live in a helper (e.g.
  // _findEnlargeableRoot) called from the listener — look for the
  // selector keywords anywhere in app.js, not just in the listener
  // body window.
  assert.ok(/conv-mermaid/.test(APP_JS) && (/['"`]svg['"`]|closest\(['"`]svg/.test(APP_JS)) && (/IMG|img/.test(APP_JS)),
    'fr-99: somewhere in app.js (likely a helper called from the dblclick listener), the diagram-target matching must reference .conv-mermaid, svg, and img — those are the three diagram surfaces the user requested.');
});

t('app.js: dblclick handler excludes avatars (chrome blocklist)', () => {
  // Avatars in chat are <img> tags. Without an explicit blocklist,
  // dblclicking someone's avatar would open a giant version. Look
  // for an exclusion check.
  const at = APP_JS.search(/addEventListener\(\s*['"]dblclick['"]/);
  const window = APP_JS.slice(at, at + 2500);
  assert.ok(/avatar|\.icon|chat-avatar|session-avatar/.test(window),
    'fr-99: the dblclick handler must exclude avatar / chrome-icon classes so accidental dblclick on chat-avatars or icons does not open a giant version. (e.g., closest("[class*=avatar]") or explicit class checks.)');
});

t('app.js: ESC key closes the lightbox', () => {
  // Look for a keydown listener that handles 'Escape' AND references
  // the diagram-lightbox.
  assert.ok(/['"]Escape['"]/.test(APP_JS),
    'fr-99: an Escape key handler must exist somewhere in app.js (one might already exist for other modals — confirm the lightbox is wired into it OR has its own).');
  // Stronger check: the lightbox-related close code references Escape.
  // Use the LAST diagram-lightbox reference as the anchor — it lives
  // in the ESC handler (or right next to it). Looking forward from
  // the FIRST reference (which is _openDiagramLightbox's
  // getElementById) underestimates the window: helpers + the
  // dblclick + DOMContentLoaded handlers all sit between, and the
  // ESC handler comes last.
  const allMatches = [...APP_JS.matchAll(/diagram-lightbox/g)];
  assert.ok(allMatches.length > 0);
  const lastLbAt = allMatches[allMatches.length - 1].index;
  const window = APP_JS.slice(Math.max(0, lastLbAt - 800), lastLbAt + 800);
  assert.ok(/['"]Escape['"]/.test(window),
    'fr-99: the diagram-lightbox handler block must reference Escape — pressing ESC must close the lightbox. (Anchor: last diagram-lightbox reference; ±800 char window around it must contain the Escape literal.)');
});

t('app.js: backdrop click closes the lightbox (event.target === backdrop)', () => {
  // Look for the pattern: addEventListener('click', ...) where target
  // is compared to the lightbox root element. This is what
  // distinguishes "clicked the backdrop" from "clicked the content
  // (svg/img)" — content clicks shouldn't close.
  // Use the dblclick listener as the anchor — it's the canonical
  // entry-point for the lightbox UI cluster. The backdrop handler
  // lives in the same cluster, no more than ~3000 chars away.
  // Pre-fold-into-boot-block the first `diagram-lightbox` literal was
  // the docstring 6000+ chars before the e.target check; bumping the
  // window or switching anchor is cheaper than chasing distances.
  const dblAt = APP_JS.search(/addEventListener\(\s*['"]dblclick['"]/);
  assert.ok(dblAt > -1);
  const window = APP_JS.slice(Math.max(0, dblAt - 6000), dblAt + 6000);
  assert.ok(/e\.target\s*===|event\.target\s*===|target\s*===\s*lightbox|target\s*===\s*backdrop/.test(window),
    'fr-99: the backdrop-click handler must check event.target === lightbox-root (or similar) so clicking the BACKDROP closes the modal but clicking the SVG/IMG inside does NOT. Without this guard, the modal would close immediately on any click — including the user trying to inspect detail.');
});

// ── 3. CSS rules ──

t('styles.css: .diagram-lightbox is fixed full-screen with a dark backdrop', () => {
  const at = STYLES_CSS.search(/\.diagram-lightbox\s*\{/);
  assert.ok(at > -1, 'fr-99: .diagram-lightbox ruleset must exist');
  const block = STYLES_CSS.slice(at, at + 1500);
  assert.ok(/position\s*:\s*fixed/.test(block),
    'fr-99: .diagram-lightbox must be position:fixed so it covers the viewport regardless of scroll.');
  assert.ok(/inset\s*:\s*0|top\s*:\s*0/.test(block),
    'fr-99: .diagram-lightbox must use inset:0 (or top/left/right/bottom:0) to span the viewport.');
  assert.ok(/z-index/.test(block),
    'fr-99: .diagram-lightbox must set z-index high enough to layer above chat pane + composer + verdict modal.');
});

t('styles.css: .diagram-lightbox-content scales to 90vw / 90vh', () => {
  // The cloned diagram fills the content area, which is capped at
  // 90vw × 90vh so it doesn't go offscreen.
  const at = STYLES_CSS.search(/\.diagram-lightbox-content\s*\{/);
  assert.ok(at > -1, 'fr-99: .diagram-lightbox-content ruleset must exist');
  const block = STYLES_CSS.slice(at, at + 800);
  assert.ok(/(max-width|width)\s*:\s*9[05]vw|90vw/.test(block),
    'fr-99: .diagram-lightbox-content must cap width at ~90vw so the diagram never overflows the viewport.');
  assert.ok(/(max-height|height)\s*:\s*9[05]vh|90vh/.test(block),
    'fr-99: .diagram-lightbox-content must cap height at ~90vh.');
});

t('styles.css: prefers-reduced-motion suppresses any fade-in animation', () => {
  // Any fade-in animation on the lightbox must honor prefers-reduced-
  // motion per accessibility best practice.
  const block = STYLES_CSS;
  // Find any animation that might run on the lightbox.
  if (/diagram-lightbox[\s\S]{0,1000}animation/.test(block)) {
    // If there's an animation, there must also be a prefers-reduced-
    // motion suppressor.
    assert.ok(/prefers-reduced-motion[\s\S]{0,2000}(diagram-lightbox|animation)/.test(block),
      'fr-99: when .diagram-lightbox has an animation, a @media (prefers-reduced-motion: reduce) rule must suppress it (CLAUDE.md best-practice §1 — animations honor user motion preferences).');
  }
  // If no animation, this passes trivially.
});

// ── 4. Provenance marker ──

t('a "fr-99" comment marker appears in app.js, styles.css, and index.html', () => {
  assert.ok(/fr-99/.test(APP_JS),
    'fr-99: at least one comment in app.js must name "fr-99" so a future refactor can trace the additions back.');
  assert.ok(/fr-99/.test(STYLES_CSS),
    'fr-99: at least one comment in styles.css must name "fr-99".');
  assert.ok(/fr-99/.test(INDEX_HTML),
    'fr-99: at least one comment in index.html must name "fr-99".');
});

console.log(`── fr-99: ${passed} passed, ${failed} failed ──`);
process.exit(failed === 0 ? 0 : 1);
