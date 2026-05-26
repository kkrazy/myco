// fr-83 — three polishes to the files-view chrome:
//
//   1. **Tree-collapse `<` vs. ☰ back-to-home collision** in the
//      sidebar-collapsed + files-tree-collapsed state. Both share the
//      top-left ~46px square — they tap-collided. Fix: shift
//      `#files-header` down by the chrome-cluster clearance (54px)
//      under that exact double-condition.
//
//   2. **Desktop top-padding bloat on #files-view-pane.** Was ~60px of
//      vertical real-estate burned to clear the chrome cluster — but
//      chrome is top-RIGHT only, not full-width. Trim desktop to just
//      safe-area-inset; restore the bigger band in the mobile @media
//      block where it's still needed. Replace pane-level top clearance
//      with header-row right-padding so right-aligned action buttons
//      can't tuck under the chrome.
//
//   3. **Edit / Save / Cancel / Wrap / Copy icon family mismatch.**
//      Were emoji+text labels (`✎ Edit`, `💾 Save`, …) with a
//      transparent text-button shell. User wants them to match the
//      top-right chrome cluster (#btn-plan / #btn-files / #btn-chat)
//      exactly: inline SVG icons (stroke 1.75, 24×24 viewBox,
//      currentColor) inside a square dark-glass button.
//
// Static-grep guards: no DOM execution. Bumps cache-buster sanity.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const HTML = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');
const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── fr-83: files-view chrome polish (collision + top space + icon family) ──');

// ─── Part 1: tree-collapse vs btn-expand collision ───────────────────

t('css: #files-header gets chrome-clearance padding-top under sidebar-collapsed + files-tree-collapsed', () => {
  // The exact double-condition selector that fixes the collision
  // without affecting any single-condition layout.
  assert.ok(
    /html\.sidebar-collapsed\s+#files-wrap\.files-tree-collapsed\s+#files-tree-pane\s+#files-header\s*\{/.test(CSS),
    'must scope the clearance to BOTH conditions (sidebar-collapsed AND files-tree-collapsed)'
  );
  // Padding value matches the chrome-cluster math used everywhere else
  // (safe-area + chrome-top + chrome-btn + small gap). Pinned to catch
  // a future refactor that drops the clearance below chrome size.
  const idx = CSS.search(/html\.sidebar-collapsed\s+#files-wrap\.files-tree-collapsed\s+#files-tree-pane\s+#files-header/);
  const win = CSS.slice(idx, idx + 400);
  assert.ok(/padding-top:\s*calc\(\s*env\(safe-area-inset-top[\s\S]{0,80}var\(--chrome-btn-size\)[\s\S]{0,40}\)/.test(win),
    'padding-top must use the chrome-cluster clearance formula (safe-area + 10 + chrome-btn-size + gap)');
});

// ─── Part 2: trim desktop top space ─────────────────────────────────

t('css: #files-view-pane default padding-top is just safe-area-inset (no chrome clearance)', () => {
  // The desktop default — find the #files-view-pane rule at the top
  // level (outside any @media block).
  const idx = CSS.search(/\n#files-view-pane\s*\{/);
  assert.ok(idx > -1, '#files-view-pane base rule must be findable');
  const win = CSS.slice(idx, idx + 1000);
  // padding-top must NOT include the chrome-cluster math at desktop
  // default — that's the bloat we're trimming.
  const ptMatch = win.match(/padding-top:\s*([^;]+);/);
  assert.ok(ptMatch, 'base rule must declare padding-top');
  assert.ok(!/--chrome-btn-size/.test(ptMatch[1]),
    'desktop padding-top must NOT include chrome-btn-size — that was the 60px bloat');
  assert.ok(/safe-area-inset-top/.test(ptMatch[1]),
    'desktop padding-top must still honor safe-area-inset-top (iPhone notch on rotated landscape)');
});

t('css: mobile @media block restores the bigger #files-view-pane padding-top', () => {
  // There are several `@media (max-width: 900px)` blocks; the one we
  // care about is the files-specific block (contains #files-wrap +
  // #files-tree-pane rules). Anchor on that landmark so we don't
  // false-positive on the first @media occurrence at the top of the
  // file (which is for a totally different surface).
  const mIdx = CSS.search(/@media\s*\(\s*max-width:\s*900px\s*\)\s*\{\s*\n\s*#files-wrap/);
  assert.ok(mIdx > -1, 'files-specific @media (max-width: 900px) block must be findable');
  const win = CSS.slice(mIdx, mIdx + 4000);
  assert.ok(/#files-view-pane\s*\{[\s\S]{0,400}padding-top:\s*calc[\s\S]{0,200}var\(--chrome-btn-size\)/.test(win),
    'mobile @media must restore #files-view-pane padding-top with chrome-cluster clearance');
});

t('css: header rows reserve right-padding to clear the chrome cluster on desktop', () => {
  // The pane no longer pushes everything down; the rows themselves
  // must reserve a chrome-shaped gap on the right so action buttons
  // can't tuck under #btn-chat.
  // Anchor on `\n.files-view-header-nav {` so we hit the actual rule
  // body, not the comment in #files-view-pane that mentions the class.
  const navIdx = CSS.search(/\n\.files-view-header-nav\s*\{/);
  const navWin = CSS.slice(navIdx, navIdx + 800);
  assert.ok(/padding-right:\s*\d+px/.test(navWin),
    '.files-view-header-nav must declare a chrome-clearance padding-right');
  const actIdx = CSS.search(/\n\.files-view-header-actions\s*\{/);
  const actWin = CSS.slice(actIdx, actIdx + 800);
  // Either padding-right or a combined shorthand that includes a
  // right value > the original 12px.
  assert.ok(/padding:\s*\d+px\s+(?:1[3-9]|[2-9]\d|\d{3,})\d*px/.test(actWin) ||
            /padding-right:\s*\d+px/.test(actWin),
    '.files-view-header-actions must reserve right-padding for chrome clearance');
});

// ─── Part 3: Lucide SVG icons for the action cluster ────────────────

t('html: action buttons (edit/save/cancel/wrap/copy) use inline SVG (not emoji+text)', () => {
  for (const id of ['files-edit', 'files-edit-save', 'files-edit-cancel', 'files-wrap-toggle', 'files-copy']) {
    const re = new RegExp(`<button[^>]*id="${id}"[\\s\\S]{0,800}?</button>`);
    const m = HTML.match(re);
    assert.ok(m, `#${id} button must be present`);
    const block = m[0];
    assert.ok(/<svg\b[\s\S]{0,1500}class="chrome-icon-svg"/.test(block),
      `#${id} must contain an inline <svg class="chrome-icon-svg"> child (chrome-family icon)`);
    // No leftover emoji/text labels that would clash with icon-only style.
    assert.ok(!/✎\s*Edit|💾\s*Save|✕\s*Cancel|⏎|📋/.test(block),
      `#${id} must not retain its emoji+text label — replaced by SVG`);
    // Tooltip stays for accessibility (matches chrome cluster pattern).
    assert.ok(/title="[^"]+"/.test(block),
      `#${id} must keep a title="…" tooltip`);
  }
});

t('css: action buttons share the chrome-family chrome (square, dark-glass, --chrome-btn-size)', () => {
  // The grouped rule that styles all 5 action buttons like chrome.
  const re = /#files-edit\s*,\s*\n\s*#files-edit-save\s*,\s*\n\s*#files-edit-cancel\s*,\s*\n\s*#files-wrap-toggle\s*,\s*\n\s*#files-copy\s*\{/;
  const idx = CSS.search(re);
  assert.ok(idx > -1, 'grouped action-button rule must list all 5 buttons');
  const win = CSS.slice(idx, idx + 700);
  assert.ok(/width:\s*var\(--chrome-btn-size\)/.test(win),
    'action buttons must size to --chrome-btn-size (same as chrome cluster)');
  assert.ok(/height:\s*var\(--chrome-btn-size\)/.test(win),
    'action buttons must square (same height as width)');
  assert.ok(/border-radius:\s*8px/.test(win),
    'border-radius:8px to match chrome buttons');
  assert.ok(/rgba\(40,\s*40,\s*40/.test(win),
    'dark-glass background to match chrome cluster (rgba(40,40,40,…))');
});

t('app.js: save flow preserves the SVG icon (no textContent wipe, uses .is-saving class)', () => {
  // Pre-fr-83 the save flow wrote `saveBtn.textContent = '… saving'`
  // which wiped the inline SVG. Pin that we now toggle a class.
  assert.ok(!/saveBtn\.textContent\s*=\s*['"]…\s*saving['"]/.test(APP),
    'must NOT set saveBtn.textContent = "… saving" — that wipes the SVG icon');
  assert.ok(!/saveBtn\.textContent\s*=\s*['"]💾\s*Save['"]/.test(APP),
    'must NOT restore the old emoji-text "💾 Save" string');
  assert.ok(/saveBtn\.classList\.add\(\s*['"]is-saving['"]\s*\)/.test(APP),
    'must add the .is-saving CSS class while save is in flight');
  assert.ok(/saveBtn\.classList\.remove\(\s*['"]is-saving['"]\s*\)/.test(APP),
    'must remove the .is-saving class when save settles (finally block)');
});

t('css: .is-saving pulses the icon (keeps it visible, signals busy)', () => {
  assert.ok(/#files-edit-save\.is-saving\s+\.chrome-icon-svg\s*\{[\s\S]{0,200}animation:/.test(CSS),
    '.is-saving must drive an animation on the SVG (pulse signal)');
  assert.ok(/@keyframes\s+files-save-pulse/.test(CSS),
    'files-save-pulse keyframes must be defined');
});

// ─── Cache busters bumped so the user gets the new CSS + JS ───────────

t('index.html: cache-busters bumped (styles.css ≥ v272, app.js ≥ v239)', () => {
  const cssM = HTML.match(/styles\.css\?v=(\d+)/);
  const jsM  = HTML.match(/app\.js\?v=(\d+)/);
  assert.ok(cssM && parseInt(cssM[1], 10) >= 272,
    `styles.css cache-buster must be >= 272 (got ${cssM && cssM[1]})`);
  assert.ok(jsM && parseInt(jsM[1], 10) >= 239,
    `app.js cache-buster must be >= 239 (got ${jsM && jsM[1]})`);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
