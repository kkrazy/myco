// Regression: "功能上新" banner broke the overall layout (整体界面混乱).
// The banner visibility hook `#app.has-whatsnew` originally flipped
// #app to `flex-direction: column`, which STACKED the sidebar above the
// main pane — the sidebar went full-width at the top of the page and
// the terminal/chat pane dropped below it, so the whole UI looked
// shattered whenever the banner appeared.
//
// The fix replaces the column flip with a CSS grid overlay (banner
// spans a full-width top row; sidebar + main pane stay side-by-side in
// the row below) and shifts all fixed top chrome down by a shared
// `--top-strip` variable so nothing slides under the banner.
//
// This locks the fix statically (the frontend has no browser harness):
//   1. #app.has-whatsnew uses grid — and must NOT set flex-direction:column.
//   2. banner/sidebar/main grid placements exist.
//   3. --top-strip is defined, bumped by .has-whatsnew, and consumed by
//      the fixed chrome buttons + pane-header paddings.
//   4. #whatsnew-banner has a fixed height matching --top-strip.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'web/public/styles.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web/public/index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

(async () => {
  // Slice the #app.has-whatsnew RULE (anchor at the selector followed
  // by '{', so a prose comment mentioning the selector can't fool it).
  const ruleRe = /#app\.has-whatsnew\s*\{/;
  const m = CSS.match(ruleRe);
  const ruleAt = m ? m.index : -1;
  const rule = ruleAt >= 0
    ? CSS.slice(ruleAt, CSS.indexOf('}', CSS.indexOf('--top-strip', ruleAt)) + 1)
    : '';

  await t('has-whatsnew uses a grid overlay, not a column flip', () => {
    assert.ok(ruleAt >= 0, '#app.has-whatsnew rule must exist in styles.css');
    assert.ok(/display:\s*grid/.test(rule),
      '#app.has-whatsnew must switch #app to CSS grid (banner row + content row)');
    // Strip comments before asserting — prose explaining the fix
    // legitimately mentions the old flex-direction:column.
    const decls = rule.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/flex-direction:\s*column/.test(decls),
      '#app.has-whatsnew must NOT declare flex-direction:column — it stacked the sidebar above the main pane and shattered the layout (整体界面混乱)');
  });

  await t('grid placements: banner spans top row, sidebar+main share row 2', () => {
    assert.ok(/#app\.has-whatsnew\s*>\s*#whatsnew-banner\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(CSS),
      'banner must span the full-width top row (grid-column: 1 / -1)');
    assert.ok(/#app\.has-whatsnew\s*>\s*#sidebar\s*\{[^}]*grid-row:\s*2/.test(CSS),
      'sidebar must sit in the second grid row');
    assert.ok(/#app\.has-whatsnew\s*>\s*#terminal-pane\s*\{[^}]*grid-row:\s*2/.test(CSS),
      'main pane must sit in the second grid row (side-by-side with the sidebar, not below it)');
    assert.ok(/#app\.has-whatsnew\s*>\s*#sidebar\[hidden\]\s*~\s*#terminal-pane\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(CSS),
      'collapsing the sidebar must let the main pane span the full width');
  });

  await t('--top-strip shifts fixed chrome + pane headers below the banner', () => {
    // § theme system: the root palette block is now
    // `:root, :root[data-theme="dark"] { … }` — the banner-shift token
    // lives in that same block (or a later plain :root override), so
    // match both selector shapes.
    assert.ok(/:root(?:\s*,\s*:root\[data-theme="dark"\])?\s*\{[^}]*--top-strip:\s*0px/.test(CSS),
      ':root must define --top-strip: 0px (banner absent = no shift)');
    const bumped = /#app\.has-whatsnew\s*\{[^}]*--top-strip:\s*34px/.test(CSS);
    assert.ok(bumped, '#app.has-whatsnew must bump --top-strip to the banner height (34px)');
    // The 5 fixed chrome buttons (btn-expand, btn-chat, btn-files,
    // btn-plan/arch/test, btn-skills) consume --top-strip in their top calc.
    const uses = CSS.match(/top:\s*calc\(env\(safe-area-inset-top,\s*0px\)\s*\+\s*var\(--top-strip,\s*0px\)\s*\+\s*10px\)/g) || [];
    assert.ok(uses.length === 5,
      'all 5 fixed chrome button top rules must add var(--top-strip) — found ' + uses.length);
    assert.ok(/#whatsnew-banner\s*\{[^}]*height:\s*34px/.test(CSS),
      'banner needs a fixed height matching the --top-strip bump (34px)');
  });

  await t('banner markup + wiring stay intact (feature preserved)', () => {
    assert.ok(/id="whatsnew-banner"/.test(HTML), 'index.html must carry #whatsnew-banner');
    assert.ok(/id="btn-whatsnew"/.test(HTML), 'sidebar must keep the permanent #btn-whatsnew entry');
    assert.ok(/function initWhatsnewBanner/.test(APP), 'app.js must keep initWhatsnewBanner');
    assert.ok(/classList\.add\('has-whatsnew'\)/.test(APP),
      'app.js must still add the has-whatsnew class when the banner shows');
    assert.ok(/classList\.remove\('has-whatsnew'\)/.test(APP),
      'dismissWhatsnewBanner must still remove the class');
  });

  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall ${passed} passed`);
  process.exit(failed ? 1 : 0);
})();
