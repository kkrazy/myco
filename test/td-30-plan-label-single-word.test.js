// td-30 regression: the Plan view's identifier must be the single
// word "Plan" — not the old "Plan — todos extracted from session"
// which both crowded the chrome and misled users (the view shows
// todos AND features AND bugs, not just todos).
//
// Locations the label can live (originally TWO, now ONE after the
// header was removed per user feedback):
//   1. <button id="btn-plan" ... title="Plan">     (chrome icon tooltip)
//   2. <div id="plan-wrap" aria-label="Plan">      (accessible region label)
//
// The legacy artifact-title <span> was deleted along with the rest
// of the .artifact-header inside plan-wrap (user-requested cleanup).
// aria-label on the wrap preserves the screen-reader-friendly region
// name without the visible chrome.
//
// Static-grep guards on web/public/index.html.

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

console.log('── td-30: Plan view header is a single word ──');

t('chrome icon tooltip is just "Plan"', () => {
  // Find the btn-plan element; assert title="Plan" (exact).
  const m = HTML.match(/<button\s+id=["']btn-plan["'][^>]*>/);
  assert.ok(m, '#btn-plan must exist');
  assert.ok(/\btitle=["']Plan["']/.test(m[0]),
    'btn-plan title must be exactly "Plan" (was "Plan — todos extracted from this session")');
});

t('plan-wrap carries aria-label="Plan" (accessible region name)', () => {
  // The visible .artifact-title <span> inside plan-wrap was removed
  // per user feedback ("remove the plan header and the refresh
  // button"). The accessible name moves to an aria-label on the
  // wrap itself so screen readers still announce the region
  // correctly. Exact-string match — the old marketing label
  // "Plan — todos extracted from session" must not creep back here.
  const m = HTML.match(/<div\s+id=["']plan-wrap["'][^>]*>/);
  assert.ok(m, '#plan-wrap must exist');
  assert.ok(/aria-label=["']Plan["']/.test(m[0]),
    '#plan-wrap must declare aria-label="Plan" — visible title was removed; the aria-label preserves the region name for assistive tech');
});

t('the old long label is gone from index.html (no stragglers)', () => {
  // Defense-in-depth: catch any leftover copy/paste of the old string.
  assert.ok(!/todos extracted from( this)? session/.test(HTML),
    'the old "todos extracted from [this] session" string must be fully removed from index.html');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
