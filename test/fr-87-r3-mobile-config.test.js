// fr-87 r3: mobile-friendly Config modal + bug-44 follow-up.
//
// User-reported (verbatim):
//   "There is a vertical bar right beside the config icon which brings
//    up the config page, the config icon should merge with it. Also
//    the config page should be mobile friendly for the user related
//    config"
//   + bug-44 re-dispatched: "Problem still exist" (Config page not
//     visible on mobile pre-session).
//
// Root cause for the "vertical bar"/bug-44-still-broken pair: the
// bug-44 fix (commit be3eb91) added #btn-config to the sidebar header
// HTML and wired its click handler, but the CSS rule that styles the
// sidebar icons keys ONLY on #btn-manual and #btn-admin:
//
//   #btn-manual .sidebar-icon-svg, #btn-admin .sidebar-icon-svg {
//     width: 18px; height: 18px; display: block;
//   }
//   #btn-manual:hover, #btn-admin:hover { background: ... }
//   #btn-manual:active, #btn-admin:active { transform: scale(.92); }
//
// #btn-config wasn't added to ANY of those selectors, so its SVG
// child renders at unspecified width/height (often collapsing to a
// thin sliver). That sliver is the "vertical bar" the user sees
// beside the (broken) config icon — they're the same element, just
// rendered without styles. Fix: extend each selector to include
// #btn-config.
//
// Second part of the report — "mobile friendly for user related
// config" — refers to the PAT section + Account section inside the
// Config modal. The PAT add form uses
// grid-template-columns: 90px 1fr 1fr on all viewports — cramped on
// 360px phones. The PAT row label can be long (github/owner/repo
// #alias) and clips. Fix: stack the PAT form vertically + wrap long
// labels on ≤600px.

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

console.log('── fr-87 r3: mobile config + bug-44 CSS fix ──');

// ── bug-44 CSS regression: #btn-config in the sidebar icon rules ──

t('styles.css: .sidebar-icon-svg width/height rule includes #btn-config', () => {
  const css = _read('web/public/styles.css');
  // Find the rule that sets the sidebar icon SVG's intrinsic size.
  // It must list #btn-config in its selector — otherwise the new
  // user-cog SVG renders without a defined width/height and collapses
  // to a thin sliver (the "vertical bar" the user reports).
  // We look for the literal selector — order of buttons in the
  // selector doesn\'t matter, but #btn-config must be there.
  const sizingMatch = css.match(/[^}]*\.sidebar-icon-svg\s*\{[^}]*width\s*:\s*\d+px/);
  assert.ok(sizingMatch, 'styles.css must declare a rule that sizes .sidebar-icon-svg children');
  // The selector block before the {…} body must include #btn-config.
  const selector = sizingMatch[0].split('{')[0];
  assert.ok(/#btn-config/.test(selector),
    'the .sidebar-icon-svg sizing rule\'s selector must include #btn-config so the user-cog SVG renders at 18×18 like the gear and book icons. Got selector: ' + selector.slice(0, 200));
});

t('styles.css: hover rule for sidebar-header buttons includes #btn-config', () => {
  const css = _read('web/public/styles.css');
  const hoverMatch = css.match(/[^{]*#btn-(manual|admin|config)[^{]*:hover\s*\{[^}]*background/);
  assert.ok(hoverMatch, 'styles.css must declare a :hover background rule for the sidebar header icon buttons');
  assert.ok(/#btn-config/.test(hoverMatch[0]),
    'the sidebar-header :hover rule must include #btn-config so the user-cog button has the same hover affordance as the gear and book icons.');
});

t('styles.css: :active scale rule includes #btn-config', () => {
  const css = _read('web/public/styles.css');
  const activeMatch = css.match(/[^{]*#btn-(manual|admin|config)[^{]*:active\s*\{[^}]*transform/);
  assert.ok(activeMatch, 'styles.css must declare an :active transform rule for the sidebar-header icon buttons');
  assert.ok(/#btn-config/.test(activeMatch[0]),
    'the sidebar-header :active rule must include #btn-config so the user-cog button has the same tap-feedback (scale(.92)) as the gear and book icons.');
});

// ── mobile-friendly PAT form ──

t('styles.css: .config-pat-form has a @media (max-width:600px) rule that simplifies layout', () => {
  const css = _read('web/public/styles.css');
  // Look for ANY mobile @media block that re-declares .config-pat-form
  // with a grid-template-columns override OR a flex direction change OR
  // a "1fr"-only column layout (single column).
  const mediaBlocks = [...css.matchAll(/@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)\s*\{/g)];
  let found = false;
  for (const m of mediaBlocks) {
    const bp = parseInt(m[1], 10);
    if (bp > 900) continue;
    const start = m.index;
    let depth = 0, end = start;
    for (let i = start; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const block = css.slice(start, end + 1);
    if (/\.config-pat-form\b[^}]*(grid-template-columns|flex-direction|display\s*:\s*flex|display\s*:\s*block)/m.test(block)) {
      found = true;
      break;
    }
  }
  assert.ok(found,
    'a mobile @media rule must re-declare .config-pat-form to use a single-column layout (the desktop grid-template-columns: 90px 1fr 1fr is too cramped on ≤360px phones).');
});

t('styles.css: .config-pat-row label can wrap or shrink on mobile', () => {
  const css = _read('web/public/styles.css');
  // Either the base .config-pat-label rule has word-break / overflow-
  // wrap, OR a mobile @media rule re-declares the row layout so the
  // label gets enough horizontal room.
  const baseAt = css.indexOf('.config-pat-label');
  let baseHasWrap = false;
  if (baseAt > 0) {
    const baseEnd = css.indexOf('}', baseAt);
    const body = css.slice(baseAt, baseEnd);
    baseHasWrap = /word-break|overflow-wrap|white-space\s*:\s*normal/.test(body);
  }
  let mobileOverride = false;
  const mediaBlocks = [...css.matchAll(/@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)\s*\{/g)];
  for (const m of mediaBlocks) {
    const bp = parseInt(m[1], 10);
    if (bp > 900) continue;
    const start = m.index;
    let depth = 0, end = start;
    for (let i = start; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const block = css.slice(start, end + 1);
    if (/\.config-pat-(row|label)\b/.test(block)) { mobileOverride = true; break; }
  }
  assert.ok(baseHasWrap || mobileOverride,
    'either .config-pat-label must wrap (word-break/overflow-wrap) OR a mobile @media rule must adjust .config-pat-row so a long label (github/owner/repo#alias) doesn\'t crowd the value + actions columns.');
});

t('styles.css: #config-dialog tighter padding on mobile', () => {
  const css = _read('web/public/styles.css');
  const mediaBlocks = [...css.matchAll(/@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)\s*\{/g)];
  let found = false;
  for (const m of mediaBlocks) {
    const bp = parseInt(m[1], 10);
    if (bp > 900) continue;
    const start = m.index;
    let depth = 0, end = start;
    for (let i = start; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const block = css.slice(start, end + 1);
    if (/#config-dialog\b[^}]*padding\s*:/m.test(block)) { found = true; break; }
  }
  assert.ok(found,
    'a mobile @media rule must tighten #config-dialog padding so the modal doesn\'t waste horizontal space on small viewports.');
});

// ── marker comment ──

t('a comment naming fr-87 r3 (or "mobile config" / "btn-config CSS") explains the fixes', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/fr-87\s*r3|btn-config.*styling|sidebar-icon-svg.*btn-config|bug-44.*regression/i.test(css),
    'a comment must name fr-87 r3 (or "btn-config styling" / "bug-44 regression") so a future restyle doesn\'t silently drop #btn-config from the icon CSS again.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
