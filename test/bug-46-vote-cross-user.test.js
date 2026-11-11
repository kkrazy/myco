// bug-46: upvote on plan items returns 403 Forbidden from
// /artifact/vote endpoint.
//
// User-reported (verbatim, plan-item dispatch from @labxnow):
//   Problem: Users cannot upvote plan items — the vote request is
//            rejected by the server.
//   Expected: POST /sessions/:sessionId/artifact/vote?type=plan&
//             itemId=... succeeds and records the upvote.
//   Actual: Request returns 403 (Forbidden), so the upvote never
//           registers.
//   Context: Repro on `mycobeta.labxnow.ai`, session
//           `myco-kkrazy-f80476dd`, item `bug-7`, app version
//           2026-06-01T23:11:40Z.
//
// Root cause (traced):
//   `POST /sessions/:id/artifact/vote` (server/src/artifacts.js:619)
//   calls `fileApiPreamble(req, res, 'viewer')`. That helper
//   (server/src/index.js:786-839) enforces fr-87 (private-by-
//   default): any authenticated user who isn't the session owner,
//   isn't in rec.admins[], isn't in rec.viewers[], and didn't pass
//   a valid share token, gets 403.
//
//   The voters schema on every plan item is cross-user by design:
//   `"voters": ["kkrazy", "labxnow", ...]`, with
//   AUTO_EXECUTE_VOTE_THRESHOLD = 2 firing auto-dispatch when two
//   distinct users have upvoted. The gate is over-strict for vote
//   specifically — voting is meant to be the collaborative quorum
//   signal across users, not a private-session-owner-only action.
//
// Fix shape:
//   - Add a third requiredAccess tier 'authed' to fileApiPreamble:
//     any signed-in user passes (auth required, but no owner/
//     admin/viewer check). Returns ctx with access: 'authed'.
//   - Change `/artifact/vote` to call
//     `fileApiPreamble(req, res, 'authed')` — open to all authed
//     users.
//
// Test shape: static-grep guards on server/src/artifacts.js +
// server/src/index.js. Pure routing change so no runtime test
// needed.

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

console.log('── bug-46: vote cross-user (open to any authed user) ──');

t('server/src/artifacts.js: /artifact/vote uses the "authed" tier (not "viewer")', () => {
  const src = _read('server/src/artifacts.js');
  // Find the /artifact/vote route registration + the immediate
  // fileApiPreamble call that follows.
  const routeAt = src.search(/app\.post\(\s*['"]\/sessions\/:id\/artifact\/vote['"]/);
  assert.ok(routeAt > -1, 'POST /sessions/:id/artifact/vote route must exist in artifacts.js');
  // Walk forward to the first fileApiPreamble call after the route.
  const window = src.slice(routeAt, routeAt + 400);
  const preamble = window.match(/fileApiPreamble\s*\(\s*req\s*,\s*res\s*,\s*['"](\w+)['"]\s*\)/);
  assert.ok(preamble, 'vote route must call fileApiPreamble with an explicit tier string');
  const tier = preamble[1];
  assert.strictEqual(tier, 'authed',
    `vote route must use the "authed" tier (cross-user open) — currently uses "${tier}". bug-46: viewer-tier blocks cross-user voting which the voters[] + AUTO_EXECUTE_VOTE_THRESHOLD design explicitly supports.`);
});

t('server/src/index.js: fileApiPreamble handles a "authed" requiredAccess tier (bypasses owner/admin/viewer gate, requires auth only)', () => {
  const src = _read('server/src/index.js');
  const fnAt = src.indexOf('function fileApiPreamble');
  assert.ok(fnAt > -1, 'fileApiPreamble must exist in index.js');
  // Grab the function body (balanced braces).
  const open = src.indexOf('{', fnAt);
  let depth = 1, end = open + 1;
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(open, end);
  // The body must reference the new 'authed' tier somewhere — as a
  // string literal in a comparison or in a comment/branch.
  assert.ok(/['"]authed['"]/.test(body),
    'fileApiPreamble must reference the "authed" tier so vote / future cross-user-open endpoints can bypass the fr-87 private-by-default gate.');
});

t('server/src/index.js: the "authed" tier branch documents what it bypasses (a comment naming bug-46 explains the carve-out)', () => {
  const src = _read('server/src/index.js');
  // Search for bug-46 marker near a reference to 'authed' in the
  // fileApiPreamble function.
  const fnAt = src.indexOf('function fileApiPreamble');
  const open = src.indexOf('{', fnAt);
  let depth = 1, end = open + 1;
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(open, end);
  assert.ok(/bug-46/.test(body),
    'a comment naming bug-46 must appear inside fileApiPreamble near the "authed" tier branch so a future restyle understands why fr-87 private-by-default has this single carve-out for vote.');
});

t('server/src/artifacts.js: /artifact/comment uses the "authed" tier (cross-user comments per follow-up user ask)', () => {
  const src = _read('server/src/artifacts.js');
  // Same fix as /artifact/vote — comments are collaborative; locking
  // them owner-only blocks the obvious "@user, look at this" thread
  // pattern that makes plan items social. User: "the comment
  // function should allow anyone logged in to add."
  const routeAt = src.search(/app\.post\(\s*['"]\/sessions\/:id\/artifact\/comment['"]/);
  assert.ok(routeAt > -1, 'POST /sessions/:id/artifact/comment route must exist in artifacts.js');
  const window = src.slice(routeAt, routeAt + 400);
  const preamble = window.match(/fileApiPreamble\s*\(\s*req\s*,\s*res\s*,\s*['"](\w+)['"]\s*\)/);
  assert.ok(preamble, 'comment route must call fileApiPreamble with an explicit tier string');
  assert.strictEqual(preamble[1], 'authed',
    `comment route must use the "authed" tier — currently uses "${preamble[1]}". bug-46 follow-up: same cross-user open access as vote.`);
});

t('server/src/artifacts.js: comment naming bug-46 explains the cross-user vote intent', () => {
  const src = _read('server/src/artifacts.js');
  const routeAt = src.search(/app\.post\(\s*['"]\/sessions\/:id\/artifact\/vote['"]/);
  // Look in a 1500-char window around the route for the marker.
  const window = src.slice(Math.max(0, routeAt - 800), routeAt + 1500);
  assert.ok(/bug-46/.test(window),
    'a comment naming bug-46 must appear near the /artifact/vote handler so a future tightening understands the carve-out from fr-87.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
