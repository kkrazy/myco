// User report (kkrazy 2026-05-27): "do not deploy to opti by default
// anymore, it's in production use now".
//
// This pins the explicit-ask-only deployment rule in myco/CLAUDE.md so
// a future edit can't silently strip it. If the rule disappears the
// next agent could go back to auto-deploying on every commit, which
// would now hit a production surface.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const CLAUDEMD = fs.readFileSync(
  path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');

console.log('── CLAUDE.md: opti is production, no default deploy ──');

t('Deployment section starts with an explicit-ask-only rule', () => {
  // Find the Deployment section header, slice through the next ##.
  const deployIdx = CLAUDEMD.indexOf('## Deployment');
  assert.ok(deployIdx > -1, '## Deployment section must exist');
  const nextSection = CLAUDEMD.indexOf('\n## ', deployIdx + 5);
  const section = CLAUDEMD.slice(deployIdx, nextSection > -1 ? nextSection : undefined);
  // Must explicitly state that the agent does not deploy without
  // being asked. Anchored loosely on "explicitly" + "opti" so a
  // reasonable rewording still passes.
  assert.ok(/NEVER\s+deploy\s+unless\s+the\s+user\s+explicitly\s+asks/i.test(section),
    'Deployment section must contain a "NEVER deploy unless the user explicitly asks" rule');
  assert.ok(/opti\.labxnow\.ai/.test(section) && /production/i.test(section),
    'rule must name opti.labxnow.ai as the production surface so the why is obvious');
  // Same prohibition extends to myco/mycobeta (they all share the
  // production-or-near-production stakes).
  assert.ok(/myco\.labxnow\.ai/.test(section) && /mycobeta\.labxnow\.ai/.test(section),
    'rule must apply to all three hosts (opti, myco, mycobeta)');
});

t('Deployment section makes clear the existing recipes do not authorize WHEN, only HOW', () => {
  const deployIdx = CLAUDEMD.indexOf('## Deployment');
  const section = CLAUDEMD.slice(deployIdx, deployIdx + 4000);
  assert.ok(/HOW.*WHEN|WHEN.*HOW/i.test(section),
    'the rule must explicitly disambiguate that the deploy recipes describe HOW to deploy, not WHEN');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
