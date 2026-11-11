// bug-86 (plan-item dispatch — distinct from the internal "bug-86" tag
// used for the chat-history floor work on 2026-06-10): fr-99 diagram
// lightbox zoom was capped at the viewport because the cloned svg/img
// child had CSS `max-width: 100%` + `max-height: 86vh`. Those override
// inline width:N% from the wheel handler (max-* is a separate computed
// property from width; the browser takes min(width, max-width)). Result:
// no matter what zoom factor, the visible SVG stayed at 100% × 86vh of
// the card.
//
// User report (2026-06-11):
//   "FR-99 diagram zoom is capped at the viewport, so users cannot
//    enlarge enough to read fine details. Expected: diagram can be
//    enlarged beyond the screen/viewport size, with scrolling/panning
//    to inspect details. Actual: zoom is limited to fit-to-screen."
//
// Fix: drop the max-width + max-height caps on the child. Keep
// `width: 100%` as the BASELINE (still needed for SVGs without an
// intrinsic width — the fr-99 patch 2026-06-10 rationale: a mermaid
// flowchart with viewBox 2293×244 and no width attribute would
// otherwise render at 0×0). At 1× zoom the inline `style="width:100%"`
// matches the baseline; at >1× zoom inline overrides and the SVG
// grows past the card; the card's existing `overflow: auto` provides
// pan-via-scrollbars.
//
// Test shape: negative + positive static-grep guards on the CSS rule.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-86 (plan): diagram zoom past viewport ──');

const STYLES_CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

// Helper — extract the `.diagram-lightbox-content > svg, > img` rule body.
function _childRule() {
  // Match the selector list followed by the {...} block.
  const m = STYLES_CSS.match(/\.diagram-lightbox-content\s*>\s*svg\s*,\s*\.diagram-lightbox-content\s*>\s*img\s*\{([\s\S]*?)\n\}/);
  assert.ok(m,
    'bug-86: the `.diagram-lightbox-content > svg, > img` rule must exist (defined by fr-99 + its 2026-06-10 patch).');
  return m[1];
}

t('child rule (svg/img) does NOT cap max-width — that was the zoom-blocker', () => {
  const body = _childRule();
  // Must not have max-width: 100% (or 90% / 95% / similar viewport-tied caps).
  // A small max-width like 1px would be even weirder, so just blanket-reject
  // any `max-width` declaration in this rule.
  assert.ok(!/max-width\s*:/.test(body),
    'bug-86: the child rule must NOT contain any `max-width` declaration. Even `max-width: 100%` blocks zoom past the card (browser computes effective_width = min(inline width, max-width)). The card itself caps via its own max-width:90vw; the child must be free to grow.');
});

t('child rule (svg/img) does NOT cap max-height — that was the tall-zoom blocker', () => {
  const body = _childRule();
  assert.ok(!/max-height\s*:/.test(body),
    'bug-86: the child rule must NOT contain `max-height: …`. With max-height in place, a zoomed-in tall diagram would be clipped vertically regardless of width. The card retains its own max-height:90vh + overflow:auto so the viewport is still protected.');
});

t('child rule retains `width: 100%` as the 1x baseline', () => {
  const body = _childRule();
  assert.ok(/width\s*:\s*100%/.test(body),
    'bug-86: the child rule must KEEP `width: 100%` as the baseline. Without it, mermaid SVGs without an intrinsic width attribute render at 0×0 (fr-99 patch 2026-06-10 — the empty-card repro). The wheel handler\'s inline `style="width: NNN%"` overrides this baseline at zoom != 1.');
});

t('child rule retains `height: auto` so the viewBox aspect ratio is preserved', () => {
  const body = _childRule();
  assert.ok(/height\s*:\s*auto/.test(body),
    'bug-86: the child rule must keep `height: auto` so the SVG/img height scales from its width via the viewBox aspect ratio. Without it, the diagram would either stretch or squish on zoom.');
});

t('parent `.diagram-lightbox-content` retains `overflow: auto` — that\'s the pan mechanism', () => {
  // The parent's overflow:auto is what surfaces scrollbars when the
  // child grows past the card. The bug-86 fix relies on it.
  const m = STYLES_CSS.match(/\.diagram-lightbox-content\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '`.diagram-lightbox-content` rule must exist');
  assert.ok(/overflow\s*:\s*auto/.test(m[1]),
    'bug-86: `.diagram-lightbox-content` must keep `overflow: auto` — when zoom > 1x makes the child overflow the card, scrollbars must appear so the user can pan via dragging the scrollbars (or via the existing cursor-anchored wheel math that updates scrollTop/scrollLeft).');
});

t('parent retains `width: 90vw` so the 1x fit-to-card baseline is unchanged', () => {
  // The bug-86 fix is purely on the CHILD; the parent's 90vw width
  // (which the fr-99 patch 2026-06-10 made explicit) must stay so
  // SVGs at 1x zoom still fit the viewport horizontally.
  const m = STYLES_CSS.match(/\.diagram-lightbox-content\s*\{([\s\S]*?)\n\}/);
  assert.ok(/width\s*:\s*90vw/.test(m[1]),
    'bug-86: `.diagram-lightbox-content` must keep `width: 90vw` so the 1x zoom baseline still fits the viewport. Only the CHILD caps are removed.');
});

t('a "bug-86" comment marker appears in styles.css for provenance', () => {
  assert.ok(/bug-86/.test(STYLES_CSS),
    'bug-86: at least one comment in styles.css must name "bug-86" so a future refactor can trace the CSS removal back to the user report.');
});

console.log(`── bug-86 (plan): ${passed} passed, ${failed} failed ──`);
process.exit(failed === 0 ? 0 : 1);
