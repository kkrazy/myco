// User reports (kkrazy 2026-05-27):
//   r1: "do not deploy to opti by default anymore, it's in production
//        use now"
//   r2: "deploy to myco.labxnow.ai, never deploy to opti.labxnow.ai
//        again" — production target moves to myco; opti is RETIRED.
//
// This pins TWO load-bearing pieces of the deployment policy in
// myco/CLAUDE.md so a future edit can't silently strip either:
//   - The explicit-ask-only rule (no auto-deploy after commits).
//   - The opti-is-retired / myco-is-production flip.
// Without these guards the next agent could revert to auto-deploying
// on every commit (now to a live production surface), or send the
// deploy to the retired opti host.

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
  // being asked.
  assert.ok(/NEVER\s+deploy\s+unless\s+the\s+user\s+explicitly\s+asks/i.test(section),
    'Deployment section must contain a "NEVER deploy unless the user explicitly asks" rule');
  // Production target = myco.labxnow.ai (flipped from opti on r2).
  assert.ok(/myco\.labxnow\.ai/.test(section) && /production/i.test(section),
    'rule must name myco.labxnow.ai as the production target');
  // opti is RETIRED — pin the retirement language so a future edit
  // can't quietly bring opti back as a default target.
  assert.ok(/opti\.labxnow\.ai/.test(section) && /RETIRED|retired|decommission/i.test(section),
    'rule must mark opti.labxnow.ai as RETIRED / decommissioned');
  // Mycobeta still covered by the same explicit-ask rule.
  assert.ok(/mycobeta\.labxnow\.ai/.test(section),
    'rule must still apply to mycobeta.labxnow.ai');
});

t('Deployment section makes clear the existing recipes do not authorize WHEN, only HOW', () => {
  const deployIdx = CLAUDEMD.indexOf('## Deployment');
  const section = CLAUDEMD.slice(deployIdx, deployIdx + 4000);
  assert.ok(/HOW.*WHEN|WHEN.*HOW/i.test(section),
    'the rule must explicitly disambiguate that the deploy recipes describe HOW to deploy, not WHEN');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
