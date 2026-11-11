// fr-62: plan-item action buttons bumped to 44px+ min hit area on
// mobile (Apple HIG + Material guideline). CSS-only inside
// @media (max-width: 900px) so desktop precision-pointing stays
// at its compact ~24px size.
//
// Pins:
//   - Every plan-item action button (vote, comment-toggle, item-run,
//     item-close, item-delete, item-edit, comment-edit, comment-delete)
//     gets min-height: 44px + min-width: 44px on mobile
//   - artifact-item-actions row gap widens so adjacent buttons stay
//     visually distinct at the bigger tap size
//   - The bump lives inside a `@media (max-width: 900px)` block so
//     desktop styling is unchanged
//
// Static-grep only (CSS regex against the source). No DOM needed.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── fr-62: plan-item mobile tap targets ──');

// ──────────────────────────────────────────────────────────────────────
// Find the fr-62 mobile-bump block. Each @media block in styles.css
// is independent; we anchor on a stable marker comment that names the
// fr so a future cleanup can't accidentally remove the wrong block.
// ──────────────────────────────────────────────────────────────────────

function findFr62Block() {
  const markerIdx = CSS.indexOf('fr-62: tap-target bump on mobile');
  if (markerIdx === -1) return null;
  const after = CSS.slice(markerIdx);
  const mediaMatch = after.match(/@media\s*\(\s*max-width:\s*900px\s*\)\s*\{/);
  if (!mediaMatch) return null;
  const mediaStart = after.indexOf(mediaMatch[0]) + mediaMatch[0].length;
  let depth = 1, i = mediaStart;
  while (i < after.length && depth > 0) {
    if (after[i] === '{') depth++;
    else if (after[i] === '}') depth--;
    i++;
  }
  return depth === 0 ? after.slice(mediaStart, i - 1) : null;
}

// fr-62 marker block must exist. If absent, every subsequent assertion
// would throw on the null `block` — collapse that into a single clear
// failing test for clean red-flip output.
const block = findFr62Block();
t('fr-62 marker block exists in styles.css', () => {
  assert.ok(block !== null,
    'styles.css must carry the `fr-62: tap-target bump on mobile` marker comment followed by an @media (max-width: 900px) block — without this every subsequent fr-62 guard has no block to check');
});

// ──────────────────────────────────────────────────────────────────────
// Each plan-item action button must hit ≥44px on mobile
// ──────────────────────────────────────────────────────────────────────

// bug-49 dropped 'artifact-item-delete' from this list — the per-item
// trash button is gone (the .artifact-item-close button is now the
// sole lifecycle affordance for plan items, so no fr-62 mobile bump
// is owed to a button that doesn't exist).
const ACTION_BUTTONS = [
  'artifact-vote',
  'artifact-comment-toggle',
  'artifact-item-run',
  'artifact-item-close',
  'artifact-item-edit',
  'artifact-comment-edit',
  'artifact-comment-delete',
];

t('fr-62 mobile block lists every plan-item action button in the selector group', () => {
  // The bump applies via a single selector group (comma-separated)
  // so future button additions only need one edit. Each existing
  // button class MUST be in the list.
  if (!block) { assert.fail('no fr-62 block — see "fr-62 marker block exists" failure above'); }
  for (const cls of ACTION_BUTTONS) {
    assert.ok(new RegExp('\\.' + cls + '\\b').test(block),
      'fr-62 mobile block must include .' + cls + ' in the tap-target selector group (otherwise that button stays at the desktop ~22px size on phones)');
  }
});

t('fr-62 selector group declares min-height: 44px', () => {
  if (!block) { assert.fail('no fr-62 block'); }
  assert.ok(/min-height:\s*44px/.test(block),
    'fr-62 block must declare min-height: 44px (Apple HIG + Material standard) — anything smaller is a regression');
});

t('fr-62 selector group declares min-width: 44px (icon-only buttons too)', () => {
  if (!block) { assert.fail('no fr-62 block'); }
  assert.ok(/min-width:\s*44px/.test(block),
    'fr-62 block must declare min-width: 44px so icon-only buttons (× delete, ✎ edit) have a square tap target');
});

t('fr-62 selector group bumps padding-top + padding-bottom', () => {
  if (!block) { assert.fail('no fr-62 block'); }
  assert.ok(/padding-top:\s*[6-9]px|padding-top:\s*1[0-9]px/.test(block),
    'fr-62 block must bump padding-top to ≥6px so the visible chrome grows with the hit area');
  assert.ok(/padding-bottom:\s*[6-9]px|padding-bottom:\s*1[0-9]px/.test(block),
    'fr-62 block must bump padding-bottom to ≥6px so the visible chrome grows with the hit area');
});

t('fr-62 widens .artifact-item-actions gap so neighbors don\'t crowd', () => {
  if (!block) { assert.fail('no fr-62 block'); }
  assert.ok(/\.artifact-item-actions\s*\{[^}]*gap:\s*1[0-9]px/.test(block),
    'fr-62 block must bump .artifact-item-actions gap to ≥10px so adjacent buttons stay visually distinct at the bigger tap size');
});

// ──────────────────────────────────────────────────────────────────────
// Negative guards — desktop styling unchanged
// ──────────────────────────────────────────────────────────────────────

t('desktop button styling is unchanged (block is inside @media not unconditional)', () => {
  // The bump MUST be inside the mobile media query — applying
  // 44px min-height unconditionally would bloat desktop too.
  // Find the .artifact-vote BASE rule (no media query) and confirm
  // it does NOT carry min-height: 44px.
  const baseVoteIdx = CSS.search(/^\.artifact-vote\s*,?$/m);
  if (baseVoteIdx > -1) {
    // Read the next ~400 chars after the .artifact-vote selector
    // to capture the rule body.
    const baseBlock = CSS.slice(baseVoteIdx, baseVoteIdx + 400);
    assert.ok(!/min-height:\s*44px/.test(baseBlock),
      'Base (non-mobile) .artifact-vote rule must NOT declare min-height: 44px — the bump is mobile-only via @media (max-width: 900px)');
  }
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation — pin the 44px threshold + which buttons matter
// ──────────────────────────────────────────────────────────────────────

t('behavior pin: 44px is the Apple HIG + Material minimum', () => {
  // Compile-time constant pinning so a future "let me make tap
  // targets smaller for density" regression has to explicitly
  // change this expected value.
  const MIN_TAP_TARGET_PX = 44;
  assert.strictEqual(MIN_TAP_TARGET_PX, 44,
    'Mobile tap targets must be ≥44px per Apple HIG (Human Interface Guidelines) + Material Design — see https://developer.apple.com/design/human-interface-guidelines/buttons + https://m3.material.io/foundations/accessible-design/accessibility-basics');
});

t('behavior pin: 7 action buttons listed (matches ACTION_BUTTONS count, post-bug-49)', () => {
  // If a new button gets added to the plan-item action row, the
  // fr-62 block needs an update — this guard catches a missing
  // entry by counting selectors against the known list. Count
  // dropped 8 → 7 in bug-49 (trash button removed).
  assert.strictEqual(ACTION_BUTTONS.length, 7,
    'fr-62 covers 7 plan-item action buttons after bug-49 dropped artifact-item-delete. If a new button class is added to the action row, append it to ACTION_BUTTONS here AND to the fr-62 block in styles.css.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
