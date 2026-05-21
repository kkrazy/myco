// td-30 regression: the Plan view's header + tooltip must be the
// single word "Plan" — not the old "Plan — todos extracted from
// session" which both crowded the chrome and misled users (the view
// shows todos AND features AND bugs, not just todos).
//
// Two locations:
//   1. <button id="btn-plan" ... title="Plan">       (chrome icon tooltip)
//   2. <span class="artifact-title">Plan</span>      (artifact view header)
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

t('artifact view header is just "Plan"', () => {
  // The artifact-title span inside the plan-wrap pane.
  const m = HTML.match(/<span\s+class=["']artifact-title["'][^>]*>([^<]+)<\/span>/g) || [];
  // There may be multiple artifact-title spans (plan, arch, test);
  // narrow to the one inside plan-wrap.
  const planWrapIdx = HTML.search(/<div\s+id=["']plan-wrap["']/);
  assert.ok(planWrapIdx > -1, '#plan-wrap must exist');
  const planRegion = HTML.slice(planWrapIdx, planWrapIdx + 1500);
  const titleMatch = planRegion.match(/<span\s+class=["']artifact-title["'][^>]*>([^<]+)<\/span>/);
  assert.ok(titleMatch, 'plan-wrap must contain an .artifact-title span');
  assert.strictEqual(titleMatch[1].trim(), 'Plan',
    'Plan view header must be exactly "Plan" (was "Plan — todos extracted from session")');
});

t('the old long label is gone from index.html (no stragglers)', () => {
  // Defense-in-depth: catch any leftover copy/paste of the old string.
  assert.ok(!/todos extracted from( this)? session/.test(HTML),
    'the old "todos extracted from [this] session" string must be fully removed from index.html');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
