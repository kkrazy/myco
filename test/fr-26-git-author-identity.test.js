// fr-26: git commits authored by the session owner's GitHub identity.
//
// User-reported (verbatim, plan-item dispatch):
//   Problem: Git commits are not attributed to the current user's
//            GitHub identity, so authorship/accountability is lost.
//   Expected: `git commit` uses the current user's GitHub id (name +
//             email matching their GitHub account) as the author, so
//             every commit traces back to a real contributor.
//   Actual: Commits are made under a default/shared identity, making
//           it impossible to tell who authored a change.
//
// Scope confirmed in the prior investigation comment: Option A —
// session-owner identity (the user who spawned the session), derived
// from the data myco already has (login + githubId from auth-sessions
// .json). Email is the GitHub noreply form
// (`<githubId>+<login>@users.noreply.github.com`) — GitHub treats it
// as authoritative + never leaks a real email. Name falls back to
// `login` since the OAuth handler doesn't currently capture user.name
// (a separate B-option follow-up could fetch it later).
//
// Wiring (locked in this round):
//   - server/src/git-identity.js exports buildIdentity({login,
//     githubId, name}) → {name, email} or null.
//   - server/src/auth.js exports profileByLogin(login) — first match
//     in AUTH_SESSIONS, returns {login, githubId, name} or null.
//   - server/src/agent-session.js: GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL
//     / GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL are added to the SDK
//     query's options.env block (alongside CTX_PROJECT_ROOT +
//     LEAN_CTX_AUTONOMY). This covers ANY git invocation by the
//     agent's Bash tool — including in cloned subdirs — because env
//     vars trump .git/config.
//
// What's NOT in scope this round (anti-bloat rule 3):
//   - One-time API fetch of the user's real display name (Option B).
//   - Co-Authored-By trailers for attaching delegates (Option C).
//   - Pre-commit hook (the prior investigation argued the chicken-
//     and-egg problem makes env vars at session-spawn time the
//     correct hook point).

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

console.log('── fr-26: git author identity from session owner ──');

// ── buildIdentity pure-logic via require ──

t('git-identity.js exports buildIdentity', () => {
  const mod = require('../server/src/git-identity');
  assert.strictEqual(typeof mod.buildIdentity, 'function',
    'server/src/git-identity.js must export buildIdentity');
});

t('buildIdentity returns name + noreply email when githubId + login present', () => {
  const { buildIdentity } = require('../server/src/git-identity');
  const id = buildIdentity({ login: 'alice', githubId: 1234 });
  assert.strictEqual(id.name, 'alice',
    'name should default to login when no separate display name is available');
  assert.strictEqual(id.email, '1234+alice@users.noreply.github.com',
    'email must use the GitHub noreply form so attribution lands on the user\'s profile without leaking a real email');
});

t('buildIdentity prefers explicit name over login (forward-compat for Option B)', () => {
  const { buildIdentity } = require('../server/src/git-identity');
  const id = buildIdentity({ login: 'bob', githubId: 5678, name: 'Bob Smith' });
  assert.strictEqual(id.name, 'Bob Smith',
    'when a display name is available (Option B follow-up), buildIdentity must use it instead of the login');
  assert.strictEqual(id.email, '5678+bob@users.noreply.github.com',
    'email format must stay the noreply form regardless of name override');
});

t('buildIdentity returns null when githubId missing (caller decides fallback)', () => {
  const { buildIdentity } = require('../server/src/git-identity');
  assert.strictEqual(buildIdentity({ login: 'noid' }), null,
    'no githubId → return null. Caller can fall back to a generic identity if it wants.');
  assert.strictEqual(buildIdentity({}), null);
  assert.strictEqual(buildIdentity(null), null);
});

t('buildIdentity returns null when login missing', () => {
  const { buildIdentity } = require('../server/src/git-identity');
  assert.strictEqual(buildIdentity({ githubId: 1234 }), null,
    'no login → return null. Both fields are required to construct a valid noreply email.');
});

// ── auth.js exposes profileByLogin for the agent-session wiring ──

t('auth.js exports profileByLogin', () => {
  const auth = require('../server/src/auth');
  assert.strictEqual(typeof auth.profileByLogin, 'function',
    'server/src/auth.js must export profileByLogin(login) so agent-session can look up the session owner\'s githubId without needing their token.');
});

// ── agent-session.js injects GIT_AUTHOR_*/GIT_COMMITTER_* into SDK env ──

t('static guard: agent-session.js adds GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL to SDK env', () => {
  const src = _read('server/src/agent-session.js');
  assert.ok(/GIT_AUTHOR_NAME/.test(src),
    'agent-session.js must reference GIT_AUTHOR_NAME in the SDK query options.env block');
  assert.ok(/GIT_AUTHOR_EMAIL/.test(src),
    'agent-session.js must reference GIT_AUTHOR_EMAIL in the SDK query options.env block');
});

t('static guard: agent-session.js also adds GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL', () => {
  const src = _read('server/src/agent-session.js');
  assert.ok(/GIT_COMMITTER_NAME/.test(src),
    'agent-session.js must set GIT_COMMITTER_NAME — git uses this for the committer field, which is separate from author and also shows in `git log --format=%cn`');
  assert.ok(/GIT_COMMITTER_EMAIL/.test(src),
    'agent-session.js must set GIT_COMMITTER_EMAIL');
});

t('static guard: agent-session.js wires git-identity into the env block (calls buildIdentity OR resolveForUser)', () => {
  const src = _read('server/src/agent-session.js');
  assert.ok(/git-identity|buildIdentity|resolveForUser/.test(src),
    'agent-session.js must require server/src/git-identity (or its helper) so the env values come from the typed resolver, not hand-rolled strings.');
});

t('static guard: a comment naming fr-26 explains the env-injection wiring', () => {
  const src = _read('server/src/agent-session.js');
  assert.ok(/fr-26/.test(src),
    'agent-session.js must contain a comment naming fr-26 near the GIT_AUTHOR_* env block so future readers know why the env vars are there and don\'t silently drop them.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
