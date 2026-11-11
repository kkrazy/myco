// delm-10 working-view feature regression test.
//
// Locks the "session working view" as a first-class feature:
//   1. The badge markup lives in ONE named helper (renderSessionBusyBadge)
//      consumed by renderSessionList — no inline duplicates that could drift.
//   2. The exact chip labels/classes survive: 'working' (session-busy-badge)
//      and 'to review' (session-review-badge) — plain text since the
//      2026-10-22 redesign (be1be8c dropped the ●/◦ symbol prefixes).
//   3. Precedence: agentBusy wins over agentHasReview inside the helper.
//   4. The card exposes data-busy + aria-live="polite" for a11y/automation.
//   5. styles.css keeps the prefers-reduced-motion suppression for the
//      pulsing busy badge (motion-sensitive users see a static chip).
//   6. The helper's chips carry role="status" so screen readers announce.
//
// Static + tiny-eval form (no browser): sub-second standalone per §10c.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web/public/styles.css'), 'utf8');

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

// 1. Named helper exists and is consumed by the list renderer.
check('app.js defines function renderSessionBusyBadge(s)',
  /function\s+renderSessionBusyBadge\s*\(\s*s\s*\)/.test(APP));
check('renderSessionList consumes renderSessionBusyBadge (no inline duplicate)',
  /const\s+busyBadge\s*=\s*renderSessionBusyBadge\(s\)/.test(APP));

// 2. Exact labels + classes survive inside the helper body only.
// be1be8c redesigned the chips to plain lowercase text with NO leading
// symbol glyphs ('working' / 'to review', per user request) — lock the
// new shape, and lock the OLD glyph shapes OUT.
const helperAt = APP.search(/function\s+renderSessionBusyBadge/);
const helperSrc = APP.slice(helperAt, helperAt + 2000);
check('helper renders "working" chip with class session-busy-badge (2026-10-22 redesign: plain text)',
  helperSrc.includes('>working</span>') && helperSrc.includes('session-busy-badge'));
check('helper renders "to review" chip with class session-review-badge (plain text)',
  helperSrc.includes('>to review</span>') && helperSrc.includes('session-review-badge'));
check('chip labels carry no symbol-glyph prefixes (be1be8c redesign)',
  !helperSrc.includes('● working') && !helperSrc.includes('◦ to review'));

// The old inline ternary at the renderSessionList call site must be gone:
// exactly ONE occurrence of each chip markup across the whole file.
check('busy chip markup appears exactly once (helper only, no inline drift)',
  (APP.match(/session-busy-badge/g) || []).length === 1);
check('review chip markup appears exactly once (helper only, no inline drift)',
  (APP.match(/session-review-badge[^-]/g) || []).length === 1);

// 3. Precedence inside helper: agentBusy checked BEFORE agentHasReview.
const busyIdx = helperSrc.indexOf('s.agentBusy');
const reviewIdx = helperSrc.indexOf('s.agentHasReview');
check('precedence: agentBusy branch precedes agentHasReview branch',
  busyIdx !== -1 && reviewIdx !== -1 && busyIdx < reviewIdx);

// 4. data-busy attribute + aria-live on the session card.
check('session card sets li.dataset.busy from s.agentBusy',
  /li\.dataset\.busy\s*=\s*s\.agentBusy/.test(APP));
check('session card is a polite live region (aria-live="polite")',
  /setAttribute\('aria-live',\s*'polite'\)/.test(APP));

// 5. prefers-reduced-motion suppression for the pulsing busy badge.
const rmBlock = CSS.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.session-busy-badge\s*\{[^}]*animation:\s*none[^}]*\}/);
check('styles.css suppresses session-busy-badge pulse under prefers-reduced-motion',
  !!rmBlock);

// 6. role="status" on both chips (screen-reader announcement).
check('busy chip carries role="status"',
  /session-busy-badge"\s*role="status"/.test(APP));
check('review chip carries role="status"',
  /session-review-badge"\s*role="status"/.test(APP));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
