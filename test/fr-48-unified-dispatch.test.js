// fr-48 follow-up: unified dispatch — every plan-item invocation
// goes through the queue, not direct handleChatMessage. Per user:
// "Clicking fix/do/implement should add to the queue; claude should
// always get the task from the queue."
//
// What changes:
//   * client onArtifactItemRun → POST /queue/add (was: POST /artifact/run)
//   * server /artifact/run route enqueues instead of direct dispatch
//     (preserves the route for curl / programmatic callers — they get
//     the queue path for free)
//   * server auto-quorum vote path enqueues (same unification)
//
// The fr-48 chip strip + auto-advance + slash commands ALL stay; this
// is purely a dispatch-path consolidation.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const PROD_APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const PROD_ARTIFACTS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');

console.log('── fr-48 follow-up: unified queue dispatch ──');

t('app.js onArtifactItemRun POSTs to /queue/add (NOT /artifact/run)', () => {
  // Locate the onArtifactItemRun handler body.
  const start = PROD_APP.search(/(async\s+)?function\s+onArtifactItemRun\s*\(/);
  assert.ok(start > -1, 'onArtifactItemRun function must exist');
  const rest = PROD_APP.slice(start);
  const end = rest.slice(1).search(/\n(async\s+)?function\s+[A-Za-z_]/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  // Must reference /queue/add (the new path).
  assert.ok(/\/queue\/add/.test(body),
    'onArtifactItemRun must POST to /queue/add — that\'s the unified dispatch path');
  // Must NOT reference /artifact/run directly (we removed that direct call).
  assert.ok(!/\/artifact\/run/.test(body),
    'onArtifactItemRun must NOT POST to /artifact/run directly — every plan-item invocation goes through the queue');
});

t('artifacts.js /artifact/run route body enqueues via runQueue.addToQueue', () => {
  // Locate the POST /artifact/run handler body — bounded by the next
  // app.<verb>( declaration.
  const start = PROD_ARTIFACTS.search(/app\.post\(\s*['"`]\/sessions\/:id\/artifact\/run['"`]/);
  assert.ok(start > -1, 'POST /artifact/run route must exist');
  const rest = PROD_ARTIFACTS.slice(start);
  const next = rest.slice(1).search(/\napp\.(get|post|patch|put|delete)\(/);
  const body = next === -1 ? rest : rest.slice(0, next + 1);
  assert.ok(/runQueue\.addToQueue|addToQueue\s*\(/.test(body),
    '/artifact/run route must enqueue via runQueue.addToQueue — direct handleChatMessage dispatch is no longer allowed (every plan-item invocation flows through the queue)');
});

t('artifacts.js auto-quorum dispatch path also enqueues', () => {
  // The auto-execute / auto-quorum vote path lives in the /vote
  // handler — when an item hits the threshold, the server kicks it
  // off. Per the unification: that kick must also go through the
  // queue, not direct handleChatMessage(buildArtifactQuorumText).
  const start = PROD_ARTIFACTS.search(/app\.post\(\s*['"`]\/sessions\/:id\/artifact\/vote['"`]/);
  assert.ok(start > -1, 'POST /artifact/vote route must exist');
  const rest = PROD_ARTIFACTS.slice(start);
  const next = rest.slice(1).search(/\napp\.(get|post|patch|put|delete)\(/);
  const body = next === -1 ? rest : rest.slice(0, next + 1);
  // The vote route either calls runQueue.addToQueue directly OR
  // delegates to a shared helper that does. Either is acceptable.
  assert.ok(/runQueue|addToQueue|_enqueueAndKick/.test(body),
    '/artifact/vote auto-quorum dispatch must enqueue (not call handleChatMessage directly)');
});

t('artifacts.js exposes a shared _enqueueAndKick helper (or equivalent dedup)', () => {
  // To keep both /artifact/run and /queue/add + /artifact/vote-auto
  // honest, the enqueue+kick-if-idle logic should be factored. We
  // accept either a named helper OR multiple sites that all call
  // runQueue.addToQueue + markRunning + handleChatMessage. The risk
  // we\'re guarding against is one path drifting from the other.
  const sites = (PROD_ARTIFACTS.match(/runQueue\.addToQueue/g) || []).length;
  assert.ok(sites >= 2,
    `must have at least 2 call sites for runQueue.addToQueue (was 1 — the queue/add route; now also /artifact/run and likely auto-quorum). Found ${sites}.`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
