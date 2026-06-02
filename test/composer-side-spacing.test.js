// composer side-spacing — user reported the composer field looked
// edge-to-edge with the chat pane and asked for breathing room on
// both left and right.
//
// User-reported (verbatim):
//   "the composer field should have space on the left and right
//    hand side"
//
// Before this fix:
//   · Desktop `#chat-form.composer` had `margin: 4px 8px ...` (8px
//     horizontal) — the card hugged the pane edges, looked cramped.
//   · Mobile media-query override at line ~1515 dropped the
//     horizontal margin to 4px to "maximize textarea width on narrow
//     phones," which also made the card feel edge-to-edge.
//
// After: 16px horizontal on desktop, 12px on mobile. Both rules keep
// their existing top/bottom padding + safe-area handling. The bumps
// are small in absolute pixels but visible against the rounded-card
// shape (the gap between the card edge and the pane edge is now
// clearly readable).
//
// Test shape: static-grep guards on web/public/styles.css for the
// two rules. Locks the minimum horizontal margin so a future restyle
// can't silently revert.

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

console.log('── composer side-spacing ──');

// ── desktop rule (top-of-block #chat-form.composer) ──

t('web/public/styles.css desktop #chat-form.composer has lateral margin in the 8–14px range', () => {
  const css = _read('web/public/styles.css');
  // The desktop rule lives outside any @media query — find the
  // `#chat-form.composer { ... margin: ...; ... }` block that
  // contains the full `display: flex; flex-direction: row` set.
  const blockRe = /#chat-form\.composer\s*\{[^}]*display:\s*flex[^}]*\}/;
  const match = css.match(blockRe);
  assert.ok(match, 'desktop #chat-form.composer flex block must exist (anchor for the margin scan).');
  // Pull the margin declaration out of the block.
  const marginMatch = match[0].match(/margin:\s*([^;]+);/);
  assert.ok(marginMatch, 'desktop #chat-form.composer must declare a `margin:` shorthand.');
  // Shorthand is `top right bottom left` or `top horizontal bottom`.
  // The horizontal value is the SECOND token. Pixel parse.
  const parts = marginMatch[1].trim().split(/\s+/);
  const horizontalToken = parts[1] || parts[0];
  const px = parseInt(horizontalToken.match(/\d+/)?.[0] || '0', 10);
  // r3 envelope: ≥ 8px so the composer doesn't go back to looking
  // edge-to-edge (pre-r1 was 8px and the user reported it didn't
  // visibly separate), ≤ 14px so the card doesn't dominate the
  // layout (r1's 16px was reported as "too big"). 12px (the value
  // r3 settled on) sits cleanly in the middle and matches the
  // mobile override.
  assert.ok(px >= 8 && px <= 14,
    `desktop #chat-form.composer horizontal margin must be 8–14px so the composer card visibly floats away from the chat pane edges WITHOUT dominating the layout. User feedback: r1's 16px was too big, original 8px wasn't enough. Got: ${horizontalToken} → ${px}px. Margin shorthand: ${marginMatch[1]}.`);
});

// ── mobile media-query override ──

t('web/public/styles.css mobile #chat-form.composer override has ≥12px horizontal margin', () => {
  const css = _read('web/public/styles.css');
  // The mobile override is a single-line rule inside an @media block:
  //   `#chat-form.composer { margin-left: Xpx; margin-right: Xpx; }`
  // Find every such occurrence and assert the smallest is ≥ 12px.
  const re = /#chat-form\.composer\s*\{\s*margin-left:\s*(\d+)px\s*;\s*margin-right:\s*(\d+)px\s*;[^}]*\}/g;
  const matches = [...css.matchAll(re)];
  assert.ok(matches.length > 0,
    'mobile override `#chat-form.composer { margin-left: …; margin-right: … }` must exist. The desktop block uses margin shorthand; the mobile override sits inside a @media (max-width: …) block.');
  for (const m of matches) {
    const left = parseInt(m[1], 10);
    const right = parseInt(m[2], 10);
    assert.ok(left >= 12 && right >= 12,
      `mobile #chat-form.composer margin-left/right must each be ≥ 12px so the composer visibly floats away from the screen edges on phones (user-reported: "should have space on the left and right hand side"). Got: left=${left}px, right=${right}px.`);
  }
});

// ── r2: desktop @media auto-margin override must not silently
//        re-include #chat-form ──

t('web/public/styles.css desktop @media (min-width:901px) auto-margin block does NOT include #chat-form', () => {
  const css = _read('web/public/styles.css');
  // The chat-pane-fills-width @media block sets
  //   `width: 100%; max-width: none; margin-left: auto; margin-right: auto;`
  // on every direct child of #chatpane.chat-main-view that participates
  // in the column layout. If #chat-form is in that selector list, the
  // `margin-left/right: auto` overrides the base rule's `margin: 4px
  // 16px ...` lateral value — defeating r1's lateral spacing on
  // desktop (this was the r2 fix's surface). Lock the selector list to
  // exclude #chat-form so future restyles can't re-add it.
  const blockRe = /@media\s*\([^)]*min-width:\s*901px[^)]*\)\s*\{[\s\S]*?width:\s*100%[\s\S]*?margin-(left|right):\s*auto/m;
  const blockMatch = css.match(blockRe);
  assert.ok(blockMatch, 'desktop chat-pane-fills-width @media block must exist (anchor for the selector scan).');
  // Pull the selector list (everything between `@media (…) {` and the
  // first `{` of the rule that contains `width: 100%; … margin: auto`).
  const mediaIdx = blockMatch.index;
  const ruleStart = css.indexOf('{', css.indexOf('{', mediaIdx) + 1);
  const ruleSelStart = css.lastIndexOf('}', ruleStart);
  const selectorChunk = css.slice(ruleSelStart < mediaIdx ? mediaIdx : ruleSelStart, ruleStart);
  assert.ok(!/#chat-form\b/.test(selectorChunk),
    "the @media (min-width: 901px) auto-margin selector list must NOT include #chat-form — that override neutralizes the base 16px lateral margin on desktop. Composer side-spacing r2 deliberately excludes it. Selector chunk: " + selectorChunk.slice(0, 400));
});

// ── marker ──

t('a comment near the composer rules explains the side-spacing fix', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/composer.*side.spacing|side.spacing.*composer|space on the left and right|composer.*breathing room/i.test(css),
    'a comment near one of the #chat-form.composer rules must name this side-spacing fix so a future restyle understands why the margins are at 16px / 12px and not the original 8px / 4px.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
