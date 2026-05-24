// Best-practices template — §1 must explicitly state the
// design principle: high cohesion + low coupling + single place for
// related responsibility + independent and test-friendly.
//
// User asked (2026-05-24) for this to be a first-class principle, not
// just a refactoring opportunity. This test pins the strengthened
// wording so a future re-extraction can't quietly drop it.
//
// Why it matters: the template is the source of truth that gets seeded
// into every new project's CLAUDE.md. If §1 drifts back to the
// pre-strengthening "Refactor opportunistically" framing, every new
// session loses the explicit design rule.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'best-practices-template.md'),
  'utf8'
);

console.log('── best-practices template: §1 design principle ──');

t('§1 heading promotes the principle (not just "refactor opportunistically")', () => {
  // The strengthened heading names the principle directly. The
  // old "Refactor opportunistically" framing was relegated to a
  // corollary inside the section.
  assert.ok(/##\s+1\.\s+High cohesion, low coupling/i.test(TEMPLATE),
    'Section 1 must lead with "High cohesion, low coupling" as the principle');
  assert.ok(/single place for related responsibility/i.test(TEMPLATE),
    'Section 1 heading must include "single place for related responsibility"');
  assert.ok(/independent\s*\+?\s*test-friendly/i.test(TEMPLATE),
    'Section 1 heading must include "independent + test-friendly" (user-requested framing)');
});

t('§1 enumerates the three components as numbered items', () => {
  // The three components are the user's explicit framing:
  //   1. High cohesion — single place
  //   2. Low coupling — narrow interfaces
  //   3. Independent + test-friendly — correctness
  // Pin each so a casual reword doesn't drop one.
  // Bullet wrappers are `**...phrase.**` — the period sits INSIDE the
  // bold markers, so allow an optional trailing punctuation char.
  assert.ok(/\*\*High cohesion[^*]*single place for all related responsibility[^*]*\*\*/i.test(TEMPLATE),
    '§1 must call out high-cohesion = single place for related responsibility');
  assert.ok(/\*\*Low coupling[^*]*narrow, named interfaces[^*]*\*\*/i.test(TEMPLATE),
    '§1 must call out low-coupling = narrow, named interfaces');
  assert.ok(/\*\*Independent and test-friendly[^*]*ensure correctness[^*]*\*\*/i.test(TEMPLATE),
    '§1 must call out independent+test-friendly = ensure correctness');
});

t('§1 keeps the refactoring corollary checklist (legacy useful content)', () => {
  // The original bullet list was useful — strengthening §1 should
  // NOT delete it, just demote it under a "Refactoring corollary"
  // sub-heading. Pin a few of the original bullets so a future
  // edit can't quietly drop them.
  assert.ok(/Refactoring corollary/i.test(TEMPLATE),
    'the legacy bullets must live under a "Refactoring corollary" sub-heading');
  assert.ok(/Split functions doing more than one thing/.test(TEMPLATE),
    'corollary must still list "split functions doing more than one thing"');
  assert.ok(/Pass dependencies in.*not import them/i.test(TEMPLATE),
    'corollary must still list "pass dependencies in, not import them globally"');
  assert.ok(/Delete code that no longer has a caller/i.test(TEMPLATE),
    'corollary must still list "delete code that no longer has a caller"');
});

t('§1 explains WHY the two properties together enable verifiability', () => {
  // The user-requested framing makes a specific causal claim:
  // low-coupling + high-cohesion together ARE what makes a codebase
  // verifiable. Pin this claim so the wording can't drift to
  // something weaker ("nice to have", "good practice").
  assert.ok(/ARE what makes a codebase verifiable/i.test(TEMPLATE),
    '§1 must state that cohesion + coupling together ARE what enables verifiable code');
  assert.ok(/isn't a nice-to-have/i.test(TEMPLATE),
    '§1 must explicitly reject the "nice-to-have" framing — it is REQUIRED for a trustworthy codebase');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
