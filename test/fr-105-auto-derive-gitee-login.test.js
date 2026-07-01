// fr-105: auto-derive the gitee login from /setpat's validated
// fetchUser response, so /setgiteelogin is optional in the common
// case where the token was set via /setpat.
//
// Contract:
//   - handleSetPat's fetchUser call already returns { login } — that
//     value is the operator's actual gitee account name.
//   - After a successful gitee token save, handleSetPat now stores
//     profile.login into rec.giteeLogin via git-hosts.setGiteeLogin —
//     BUT ONLY when git-hosts.getGiteeLogin returns null (nothing
//     explicitly set by the operator yet). An existing operator-set
//     value from a prior explicit /setgiteelogin is sacred.
//   - Github tokens do NOT trigger the auto-store (github ignores the
//     credential username; the sentinel x-access-token is fine as-is).
//   - The confirmation reply gains one extra sentence when the
//     auto-store fires; unchanged otherwise (so github callers + the
//     "operator already set login" path see no reply-shape drift).
//
// Test shape: stub git-hosts.js and sessions.js so handleSetPat's
// lookup / setter calls land on our mocks. This keeps the test
// deterministic and file-system-free.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      throw new Error('async tests use the promise pattern below, not direct-await inside sync t()');
    }
    console.log('  ✓ ' + name); passed++;
  } catch (err) {
    console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err));
    failed++;
  }
}

// Async tests share the module-level gitHostsStub state, so they MUST
// run sequentially — otherwise a mid-flight `await` inside handleSetPat
// lets the NEXT test reset the stub and cross-contaminate the calls.
// Queue them here and let the tail-of-file runner drain in order.
const _pendingAsync = [];
function tAsync(name, fn) {
  _pendingAsync.push({ name, fn });
}
async function _drainAsync() {
  for (const { name, fn } of _pendingAsync) {
    try {
      await fn();
      console.log('  ✓ ' + name); passed++;
    } catch (err) {
      console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err));
      failed++;
    }
  }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── fr-105: auto-derive gitee login from /setpat ──');

// ──────────────────────────────────────────────────────────────────
// Group A: handleSetPat behavior with stubbed dependencies.
//
// We stub sessions, permissions, and git-hosts so handleSetPat's
// lookups hit our controlled fakes. Reload slashcmds after the stubs
// are in place so its lazy `require` calls resolve to them.

const sessionsStub = {
  _rec: { user: 'alice', absCwd: '/wks/alice/sess-1' },
  _owners: new Set(['alice']),
  getSessionRecord(_id) { return this._rec; },
  isOwnerOrAdmin(_id, user) { return this._owners.has(user); },
  saveStore() {},
  appendChatMessage() {},
};
require.cache[require.resolve('../server/src/sessions')] = {
  exports: sessionsStub,
  id: require.resolve('../server/src/sessions'),
  filename: require.resolve('../server/src/sessions'),
  loaded: true,
};
require.cache[require.resolve('../server/src/permissions')] = {
  exports: { matchesPattern() { return false; } },
  id: require.resolve('../server/src/permissions'),
  filename: require.resolve('../server/src/permissions'),
  loaded: true,
};

// git-hosts stub — tests populate the return values from fetchUser +
// track calls to setRepoToken / getGiteeLogin / setGiteeLogin.
const gitHostsStub = {
  _host: { provider: 'gitee', owner: 'kkrazy', repo: 'omni-cache' },
  _fetchUserResult: { login: 'kkrazy' },
  _existingGiteeLogin: null,          // returned by getGiteeLogin
  _setRepoTokenCalls: [],
  _setGiteeLoginCalls: [],
  async detectHost(_absCwd) { return this._host; },
  async fetchUser({ provider, token }) {
    if (this._fetchUserThrows) throw new Error(this._fetchUserThrows);
    return this._fetchUserResult;
  },
  setRepoToken(user, provider, owner, repo, token, alias) {
    this._setRepoTokenCalls.push({ user, provider, owner, repo, token, alias: alias || null });
  },
  getGiteeLogin(user) { return this._existingGiteeLogin; },
  setGiteeLogin(user, login) {
    this._setGiteeLoginCalls.push({ user, login });
    // Mirror the real setter's side effect for lookup consistency
    // within the same test run.
    this._existingGiteeLogin = login;
  },
  _resetForTest() {
    this._host = { provider: 'gitee', owner: 'kkrazy', repo: 'omni-cache' };
    this._fetchUserResult = { login: 'kkrazy' };
    this._fetchUserThrows = null;
    this._existingGiteeLogin = null;
    this._setRepoTokenCalls = [];
    this._setGiteeLoginCalls = [];
  },
};
require.cache[require.resolve('../server/src/git-hosts')] = {
  exports: gitHostsStub,
  id: require.resolve('../server/src/git-hosts'),
  filename: require.resolve('../server/src/git-hosts'),
  loaded: true,
};

delete require.cache[require.resolve('../server/src/slashcmds')];
const slashcmds = require('../server/src/slashcmds');

function makeCtx(overrides) {
  const replies = [];
  const ctx = {
    sessionId: 'sid-1',
    user: 'alice',
    args: 'a-valid-token-12345',
    absCwd: '/wks/alice/sess-1',
    reply: (m) => replies.push(String(m)),
    ...(overrides || {}),
  };
  ctx._replies = replies;
  return ctx;
}

tAsync('/setpat <gitee-token>: auto-stores gitee login from fetchUser response', async () => {
  gitHostsStub._resetForTest();
  gitHostsStub._fetchUserResult = { login: 'kkrazy' };
  gitHostsStub._existingGiteeLogin = null;   // no prior override
  const ctx = makeCtx();
  await slashcmds.handleSetPat(ctx);
  assert.strictEqual(gitHostsStub._setRepoTokenCalls.length, 1,
    'setRepoToken must be called exactly once for the successful save');
  assert.strictEqual(gitHostsStub._setGiteeLoginCalls.length, 1,
    'setGiteeLogin must be called ONCE with the auto-derived login');
  assert.strictEqual(gitHostsStub._setGiteeLoginCalls[0].login, 'kkrazy',
    'auto-derived login must be profile.login from fetchUser');
  assert.strictEqual(gitHostsStub._setGiteeLoginCalls[0].user, 'alice',
    'setGiteeLogin must be scoped to the current session user');
});

tAsync('/setpat <gitee-token>: reply mentions the auto-stored gitee login', async () => {
  gitHostsStub._resetForTest();
  gitHostsStub._fetchUserResult = { login: 'kkrazy' };
  gitHostsStub._existingGiteeLogin = null;
  const ctx = makeCtx();
  await slashcmds.handleSetPat(ctx);
  const joined = ctx._replies.join('\n');
  assert.ok(/gitee login/i.test(joined),
    'reply must mention that a gitee login was auto-stored');
  assert.ok(/kkrazy/.test(joined),
    'reply must include the auto-stored login value so the user can see it');
});

tAsync('/setpat <gitee-token>: an EXISTING giteeLogin is preserved (operator-set is sacred)', async () => {
  gitHostsStub._resetForTest();
  gitHostsStub._fetchUserResult = { login: 'kkrazy' };
  // Operator previously ran /setgiteelogin with a specific value that
  // MUST NOT be overwritten by the auto-derive.
  gitHostsStub._existingGiteeLogin = 'operator-choice';
  const ctx = makeCtx();
  await slashcmds.handleSetPat(ctx);
  assert.strictEqual(gitHostsStub._setGiteeLoginCalls.length, 0,
    'setGiteeLogin must NOT be called when an existing value is already stored (operator-set wins)');
  // Reply should NOT mention the auto-store since it didn't fire.
  const joined = ctx._replies.join('\n');
  assert.ok(!/Also saved gitee login/i.test(joined),
    'reply must NOT mention an auto-store that never happened');
});

tAsync('/setpat <github-token>: no auto-store on the github path (github ignores the username)', async () => {
  gitHostsStub._resetForTest();
  gitHostsStub._host = { provider: 'github', owner: 'kkrazy', repo: 'myco' };
  gitHostsStub._fetchUserResult = { login: 'kkrazy' };
  gitHostsStub._existingGiteeLogin = null;
  const ctx = makeCtx();
  await slashcmds.handleSetPat(ctx);
  assert.strictEqual(gitHostsStub._setGiteeLoginCalls.length, 0,
    'github /setpat must NOT touch giteeLogin — github uses the x-access-token sentinel, no login needed');
});

tAsync('/setpat <gitee-token>: when profile.login is missing/empty, no auto-store (defensive)', async () => {
  gitHostsStub._resetForTest();
  gitHostsStub._fetchUserResult = { login: '' };     // gitee-shaped response missing login
  gitHostsStub._existingGiteeLogin = null;
  const ctx = makeCtx();
  await slashcmds.handleSetPat(ctx);
  assert.strictEqual(gitHostsStub._setGiteeLoginCalls.length, 0,
    'must not persist an empty login (would clobber the mycoUser fallback with junk)');
});

tAsync('/setpat <gitee-token>: setGiteeLogin failure does NOT abort the ✓ Saved confirmation', async () => {
  gitHostsStub._resetForTest();
  gitHostsStub._fetchUserResult = { login: 'kkrazy' };
  gitHostsStub._existingGiteeLogin = null;
  // Make setGiteeLogin throw — the PAT is already saved by this point,
  // so a login-store failure should be non-fatal (logged, not raised).
  gitHostsStub.setGiteeLogin = function(user, login) {
    throw new Error('simulated persistence failure');
  };
  const ctx = makeCtx();
  await slashcmds.handleSetPat(ctx);
  const joined = ctx._replies.join('\n');
  assert.ok(/Saved gitee PAT/.test(joined),
    'the ✓ Saved confirmation must still fire — the PAT is safely stored even if the login sidecar failed');
});

// ──────────────────────────────────────────────────────────────────
// Group B: static guards on the prod source.

t('static guard: handleSetPat auto-stores gitee login on the gitee path only', () => {
  const src = _read('server/src/slashcmds.js');
  const body = fnBody(src, /async\s+function\s+handleSetPat\s*\(/);
  assert.ok(body, 'handleSetPat body must be locatable');
  // The auto-store must be gated on provider === 'gitee' AND
  // getGiteeLogin returning null (nothing stored).
  assert.ok(/host\.provider\s*===\s*['"]gitee['"]/.test(body),
    'auto-store must be gitee-only');
  assert.ok(/getGiteeLogin\s*\(/.test(body),
    'auto-store must probe existing giteeLogin before writing (guard against clobber)');
  assert.ok(/setGiteeLogin\s*\(/.test(body),
    'auto-store must call setGiteeLogin to persist the auto-derived login');
  // Existence guard: the fr-105 comment must reference the plan item.
  assert.ok(/fr-105/.test(body),
    'the auto-store block must carry an fr-105 marker so future readers know why');
});

t('static guard: auto-store is defensive against fetchUser failures + empty login', () => {
  const src = _read('server/src/slashcmds.js');
  const body = fnBody(src, /async\s+function\s+handleSetPat\s*\(/);
  // The auto-store must be wrapped in try/catch so a persistence
  // failure doesn't crash the ✓ Saved confirmation (the PAT is already
  // stored by this point).
  const startIdx = body.search(/fr-105/);
  assert.ok(startIdx > 0, 'fr-105 block must be locatable');
  const window = body.slice(startIdx, startIdx + 2500);
  assert.ok(/try\s*\{/.test(window),
    'auto-store must live inside a try block');
  assert.ok(/catch/.test(window),
    'auto-store must catch failures so the confirmation still fires');
  // Empty-login defense — profile.login might be missing on
  // non-happy-path responses.
  assert.ok(/profile\s*&&\s*profile\.login|profile\.login\s*&&|&&\s*profile\.login/.test(window),
    'auto-store must guard against a missing/empty profile.login value');
});

// Drain the queued async tests sequentially, then print + exit.
_drainAsync().then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
