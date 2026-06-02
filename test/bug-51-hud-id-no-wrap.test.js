// bug-51: plan item ID wraps in mobile HUD as time ticker grows.
//
// User-reported (verbatim, plan-item dispatch from @labxnow):
//   Problem:  In mobile mode, the HUD doesn't reserve enough space
//             for the time ticker, causing the plan item ID to
//             wrap as the ticker widens.
//   Expected: HUD layout reserves sufficient width for the growing
//             time ticker so the plan item ID stays on a single
//             line.
//   Actual:   As the time ticker grows, it squeezes the plan item
//             ID and forces it to wrap.
//
// Root cause:
//   The HUD row layout is
//     .hud-task-row (flex, justify-content: space-between)
//       .hud-task-title-wrap (flex, gap: 8px)
//         .hud-task-id   ← the chip that was wrapping
//         .hud-task-text (already nowrap + ellipsis + max-width)
//       .hud-task-status
//         #hud-duration-text   ← grows from "1s" to "10000s"
//         .hud-stop-btn
//   The status-side widens as the ticker grows. Without
//   `flex-shrink: 0` on the title-wrap children, the badge gets
//   squeezed below its natural width and wraps.
//
// Fix: add `flex-shrink: 0` + `white-space: nowrap` to .hud-task-id
// so the chip keeps its natural width and never breaks lines. The
// .hud-task-text already has `nowrap + ellipsis + max-width`, so the
// squeeze still hits the text (which truncates correctly) instead
// of the ID.
//
// Test shape: static-grep on web/public/styles.css.

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

console.log('── bug-51: HUD plan-item ID stops wrapping on mobile ──');

t('web/public/styles.css: .hud-task-id declares flex-shrink: 0', () => {
  const css = _read('web/public/styles.css');
  // Find the .hud-task-id rule block (not a descendant selector,
  // not the mobile media-query font-size override).
  const re = /\.hud-task-id\s*\{[^}]*\}/g;
  const blocks = css.match(re) || [];
  assert.ok(blocks.length > 0, '.hud-task-id rule must exist.');
  // At least one of the .hud-task-id blocks must contain flex-shrink: 0
  // so the chip refuses to be squeezed by the growing ticker on the
  // status side of the row.
  const anyHasShrink = blocks.some((b) => /flex-shrink\s*:\s*0\b/.test(b));
  assert.ok(anyHasShrink,
    '.hud-task-id must declare `flex-shrink: 0` so the chip keeps its natural width when the .hud-task-status side widens as the time ticker grows (bug-51).');
});

t('web/public/styles.css: .hud-task-id declares white-space: nowrap', () => {
  const css = _read('web/public/styles.css');
  const re = /\.hud-task-id\s*\{[^}]*\}/g;
  const blocks = css.match(re) || [];
  assert.ok(blocks.length > 0, '.hud-task-id rule must exist.');
  // Even with flex-shrink: 0, a chip that's allowed to break onto a
  // second line could still wrap inside itself if the text is long.
  // Locking white-space: nowrap removes the wrap surface entirely.
  const anyHasNowrap = blocks.some((b) => /white-space\s*:\s*nowrap\b/.test(b));
  assert.ok(anyHasNowrap,
    '.hud-task-id must declare `white-space: nowrap` so the chip text never breaks lines (bug-51).');
});

t('a comment naming bug-51 explains the no-wrap fix', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/bug-51/.test(css),
    'a comment naming bug-51 must appear near the .hud-task-id rule so a future restyle understands why flex-shrink:0 + white-space:nowrap are locked in.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
