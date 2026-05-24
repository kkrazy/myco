// bug-35: clicking the comment chip on a plan item didn't show the
// comments.
//
// Pre-fix (post-fr-85-r2 regression): the .artifact-comment-toggle
// button was dropped in fr-85 r2 + replaced with a display-only span
// (.artifact-comment-chip). The .artifact-comments block + the inline
// .artifact-comment-form were still rendered hidden, but no UI affordance
// could un-hide them — the chip was purely decorative. User-reported by
// kkrazy 2026-05-24: "Clicking on the comment button doesnt show the
// comments".
//
// Fix:
//   1. .artifact-comment-chip carries data-id, role="button", tabindex="0"
//      → keyboard + screen-reader accessible
//   2. click + keydown(Enter/Space) handler toggles the hidden attr on
//      .artifact-comments[data-id=X], plus updates aria-expanded
//   3. inline .artifact-comment-form removed (per fr-85 r2 design,
//      /comment slash inside the chat panel is the single path for
//      adding comments — keeping the form would re-introduce two-path
//      confusion + dead-code per CLAUDE.md §1)
//
// Static guards on app.js + CSS + behavior simulation of the toggle.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── bug-35: comment chip toggle ──');

// ──────────────────────────────────────────────────────────────────────
// Chip is now interactive
// ──────────────────────────────────────────────────────────────────────

t('app.js: .artifact-comment-chip carries data-id, role="button", tabindex="0"', () => {
  // a11y essentials: keyboard + screen-reader can reach the chip.
  // Pre-fix the span had no role / tabindex, so screen readers
  // skipped it entirely and Tab navigation jumped past it.
  const idx = APP.search(/artifact-comment-chip/);
  assert.ok(idx > -1, '.artifact-comment-chip must render');
  // The chip template extends across ~200 chars — check the same
  // tag carries all three attrs.
  const win = APP.slice(idx, idx + 400);
  assert.ok(/data-id=/.test(win),
    'chip must carry data-id so the toggle handler can find the matching comments block');
  assert.ok(/role="button"/.test(win),
    'chip must carry role="button" (a11y)');
  assert.ok(/tabindex="0"/.test(win),
    'chip must carry tabindex="0" (keyboard reachable)');
});

t('app.js: click handler toggles the matching .artifact-comments[data-id=X] hidden attr', () => {
  // The handler must SELECT the matching comments block by data-id,
  // not by some unrelated heuristic — the chip + block are linked by
  // the item id, so toggling chip A must NOT affect block B.
  assert.ok(/querySelectorAll\(['"]\.artifact-comment-chip['"]\)/.test(APP),
    'app.js must bind clicks on .artifact-comment-chip');
  // The handler must select the matching .artifact-comments block.
  assert.ok(/\.artifact-comments\[data-id=/.test(APP),
    'toggle handler must select .artifact-comments[data-id="..."] to find the matching block');
  // The toggle uses setAttribute/removeAttribute on the hidden attr.
  assert.ok(/setAttribute\(['"]hidden['"]/.test(APP) && /removeAttribute\(['"]hidden['"]/.test(APP),
    'toggle handler must use setAttribute/removeAttribute on the "hidden" attr (HTML standard hide)');
});

t('app.js: chip is keyboard-activatable via Enter/Space', () => {
  // Mirrors the id-chip deep-link affordance (fr-6). Without these
  // keys, a keyboard-only user can\'t expand comments.
  const idx = APP.search(/querySelectorAll\(['"]\.artifact-comment-chip['"]\)/);
  assert.ok(idx > -1);
  const win = APP.slice(idx, idx + 1500);
  assert.ok(/keydown/.test(win),
    'chip must bind keydown for keyboard activation');
  assert.ok(/['"]Enter['"]/.test(win) && /['"] ['"]/.test(win),
    'keydown handler must accept both Enter and Space (HTML5 button activation keys)');
});

t('app.js: chip updates aria-expanded so screen readers track state', () => {
  // Critical a11y detail — without aria-expanded, a screen reader
  // user can\'t tell whether their click did anything.
  const idx = APP.search(/querySelectorAll\(['"]\.artifact-comment-chip['"]\)/);
  const win = APP.slice(idx, idx + 1500);
  assert.ok(/aria-expanded['"]\s*,\s*['"]true['"]/.test(win),
    'toggle must set aria-expanded="true" on expand');
  assert.ok(/aria-expanded['"]\s*,\s*['"]false['"]/.test(win),
    'toggle must set aria-expanded="false" on collapse');
});

// ──────────────────────────────────────────────────────────────────────
// Dead form removed
// ──────────────────────────────────────────────────────────────────────

t('app.js: inline .artifact-comment-form is no longer rendered', () => {
  // Per fr-85 r2: /comment <text> in the chat panel handles adding.
  // Keeping the inline form would re-introduce two-path confusion +
  // dead code (no toggle reaches the comments block, the form
  // inside was unreachable).
  assert.ok(!/<form\s+class="artifact-comment-form"/.test(APP),
    '<form class="artifact-comment-form"> must NOT render — comment-add lives in /comment slash inside chat panel');
  assert.ok(!/<input[^>]*class="artifact-comment-input"/.test(APP),
    '<input class="artifact-comment-input"> must NOT render — paired with the form, removed together');
});

t('app.js: .artifact-comment-form click binding removed (dead-code cleanup)', () => {
  // Per CLAUDE.md §1, querySelectorAll for an element that never
  // renders is dead code. Pin the removal.
  assert.ok(!/querySelectorAll\(['"]\.artifact-comment-form['"]\)/.test(APP),
    '.artifact-comment-form binding must be removed (form no longer rendered)');
});

// ──────────────────────────────────────────────────────────────────────
// CSS: chip reads as interactive
// ──────────────────────────────────────────────────────────────────────

t('styles.css: .artifact-comment-chip has cursor:pointer + hover affordance', () => {
  // Visual signal that the chip is clickable. Pre-fix the chip was
  // visually identical to non-interactive display chips
  // (.artifact-vote-chip is also display-only) — users had no
  // reason to try clicking.
  assert.ok(/\.artifact-comment-chip[\s\S]{0,500}cursor:\s*pointer/.test(CSS),
    '.artifact-comment-chip must declare cursor: pointer (signals interactivity)');
  assert.ok(/\.artifact-comment-chip:hover/.test(CSS),
    '.artifact-comment-chip must define :hover state (visible feedback on mouse-over)');
  assert.ok(/\.artifact-comment-chip\[aria-expanded="true"\]/.test(CSS),
    '.artifact-comment-chip[aria-expanded="true"] must define an "open" state (visual feedback when comments are shown)');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation: the toggle contract independent of source
// ──────────────────────────────────────────────────────────────────────

t('behavior: toggle flips hidden ↔ visible on each invocation', () => {
  // Simulate the handler's contract against fake DOM-like objects.
  // Pure logic — locked even if the source ever moves around.
  const block = {
    _attrs: { hidden: '' },
    hasAttribute(name) { return name in this._attrs; },
    setAttribute(name, val) { this._attrs[name] = val; },
    removeAttribute(name) { delete this._attrs[name]; },
  };
  const chip = {
    _attrs: {},
    setAttribute(name, val) { this._attrs[name] = val; },
  };
  const toggle = () => {
    const isOpen = !block.hasAttribute('hidden');
    if (isOpen) {
      block.setAttribute('hidden', '');
      chip.setAttribute('aria-expanded', 'false');
    } else {
      block.removeAttribute('hidden');
      chip.setAttribute('aria-expanded', 'true');
    }
  };
  // Starts hidden (HTML default for hidden attr).
  assert.strictEqual(block.hasAttribute('hidden'), true);
  toggle();
  assert.strictEqual(block.hasAttribute('hidden'), false, 'first toggle → visible');
  assert.strictEqual(chip._attrs['aria-expanded'], 'true');
  toggle();
  assert.strictEqual(block.hasAttribute('hidden'), true, 'second toggle → hidden');
  assert.strictEqual(chip._attrs['aria-expanded'], 'false');
  toggle();
  assert.strictEqual(block.hasAttribute('hidden'), false, 'third toggle → visible again');
});

t('behavior: chip only toggles its matching block (not a sibling item\'s)', () => {
  // If chip-fr-1 click matched .artifact-comments (no [data-id] filter),
  // it would toggle EVERY comments block on the page. The data-id
  // attr + querySelector by that id is what scopes the toggle.
  const blocks = {
    'fr-1': { _hidden: true },
    'fr-2': { _hidden: true },
    'fr-3': { _hidden: true },
  };
  const toggleByItemId = (itemId) => {
    const b = blocks[itemId];
    if (!b) return;
    b._hidden = !b._hidden;
  };
  toggleByItemId('fr-2');
  assert.strictEqual(blocks['fr-1']._hidden, true, 'fr-1 untouched');
  assert.strictEqual(blocks['fr-2']._hidden, false, 'fr-2 toggled');
  assert.strictEqual(blocks['fr-3']._hidden, true, 'fr-3 untouched');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
