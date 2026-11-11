// bug-91: git-credential-myco.sh hard-codes username=x-access-token,
// breaking gitee pushes.
//
// User report: gitee's HTTPS auth validates the credential username
// against the token's owning account (unlike github which ignores it).
// Pre-fix the helper wrote "username=x-access-token" for every provider,
// so gitee returned "The token username invalid" → HTTP 403 even with
// a valid token.
//
// Fix: the helper branches by provider — github still gets
// "x-access-token"; gitee gets a per-repo login override → user-level
// login override → the myco-user (best-effort default).
//
// Storage (new sidecar keys in /data/git-tokens.json, non-breaking):
//   store[user].giteeLogin                     — user-level default
//   store[user]["gitee/<owner>/<repo>.login"]  — per-repo override
//
// A new /setgiteelogin slash command writes the user-level slot.
//
// Contract tested:
//   1. git-tokens.js exports getGiteeLogin / setGiteeLogin /
//      setGiteeRepoLogin / _isLoginKey with the documented precedence
//      + non-breaking storage shape.
//   2. listAllPats + listRepos SKIP the login sidecar keys.
//   3. The shell helper emits `username=x-access-token` for github
//      (unchanged) and `username=<resolved_login>` for gitee, with
//      the correct precedence.
//   4. /setgiteelogin exists, is owner+admin gated, validates the login
//      shape, and persists via git-hosts.setGiteeLogin.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { fnBody } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── bug-91: credential-helper provider-branched username ──');

const HELPER = path.join(__dirname, '..', 'scripts', 'git-credential-myco.sh');

// ──────────────────────────────────────────────────────────────────
// Group A — git-tokens.js unit tests (isolated tmpdir state)

const TMP_TOKENS = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug91-tokens-'));
process.env.MYCO_STATE_DIR = TMP_TOKENS;
process.on('exit', () => { try { fs.rmSync(TMP_TOKENS, { recursive: true, force: true }); } catch {} });

// Fresh require so the module's STATE_DIR captures our tmpdir.
delete require.cache[require.resolve('../server/src/git-tokens')];
const gitTokens = require('../server/src/git-tokens');

t('git-tokens: getGiteeLogin returns null when nothing is stored', () => {
  gitTokens._resetCacheForTest();
  assert.strictEqual(gitTokens.getGiteeLogin('alice'), null,
    'no login stored → null (helper falls back to myco-user)');
});

t('git-tokens: setGiteeLogin persists + getGiteeLogin reads it back', () => {
  gitTokens.setGiteeLogin('alice', 'alice-work');
  gitTokens._resetCacheForTest();       // force re-read from disk
  assert.strictEqual(gitTokens.getGiteeLogin('alice'), 'alice-work',
    'user-level login must round-trip through disk');
});

t('git-tokens: setGiteeLogin with empty string DELETES the slot (fall back to default)', () => {
  gitTokens.setGiteeLogin('alice', 'alice-work');
  gitTokens.setGiteeLogin('alice', '');
  gitTokens._resetCacheForTest();
  assert.strictEqual(gitTokens.getGiteeLogin('alice'), null,
    'empty setter must clear the slot so the helper falls back to myco-user');
});

t('git-tokens: setGiteeRepoLogin persists per-repo, wins over user-level', () => {
  gitTokens.setGiteeLogin('alice', 'alice-user-level');
  gitTokens.setGiteeRepoLogin('alice', 'kkrazy', 'omni-cache', 'alice-per-repo');
  gitTokens._resetCacheForTest();
  // No owner+repo → user-level wins.
  assert.strictEqual(gitTokens.getGiteeLogin('alice'), 'alice-user-level');
  // owner+repo → per-repo wins.
  assert.strictEqual(gitTokens.getGiteeLogin('alice', 'kkrazy', 'omni-cache'), 'alice-per-repo',
    'per-repo login must override the user-level login when owner+repo supplied');
});

t('git-tokens: _isLoginKey identifies user-level + per-repo login keys', () => {
  assert.strictEqual(gitTokens._isLoginKey('giteeLogin'), true);
  assert.strictEqual(gitTokens._isLoginKey('githubLogin'), true);
  assert.strictEqual(gitTokens._isLoginKey('gitee/kkrazy/omni-cache.login'), true);
  assert.strictEqual(gitTokens._isLoginKey('github/kkrazy/myco.login'), true);
  // Real token keys must NOT match.
  assert.strictEqual(gitTokens._isLoginKey('gitee'), false, 'bare user-level token key is NOT a login key');
  assert.strictEqual(gitTokens._isLoginKey('github/kkrazy/myco'), false, 'per-repo token key without .login suffix is NOT a login key');
  assert.strictEqual(gitTokens._isLoginKey('gitee/kkrazy/omni-cache#labxnow'), false, 'fr-82 alias key (# separator) is NOT a login key');
});

t('git-tokens: listAllPats + listRepos SKIP login sidecar keys (they hold logins, not tokens)', () => {
  gitTokens._resetCacheForTest();
  // Seed alice: a token, an alias token, a user-level login, a per-repo login.
  gitTokens.setRepoToken('alice', 'gitee', 'kkrazy', 'omni-cache', 'gitee_pat_xxxx');
  gitTokens.setGiteeLogin('alice', 'alice-work');
  gitTokens.setGiteeRepoLogin('alice', 'kkrazy', 'omni-cache', 'alice-repo');
  gitTokens._resetCacheForTest();
  const inv = gitTokens.listAllPats('alice');
  // The token is there.
  const rows = inv.perRepo.filter((r) => r.provider === 'gitee' && r.owner === 'kkrazy' && r.repo === 'omni-cache');
  assert.strictEqual(rows.length, 1, 'the actual gitee token must appear in perRepo');
  // But the .login sidecar must NOT.
  const loginRows = inv.perRepo.filter((r) => (r.repo || '').endsWith('.login'));
  assert.strictEqual(loginRows.length, 0, 'no per-repo login sidecar key must appear in perRepo (they hold logins, not tokens)');
  // listRepos must also skip it.
  const repos = gitTokens.listRepos('alice');
  const badRepos = repos.filter((r) => (r.repo || '').endsWith('.login'));
  assert.strictEqual(badRepos.length, 0, 'listRepos must skip .login sidecar keys');
});

// ──────────────────────────────────────────────────────────────────
// Group B — runtime shell invocation

const TMP_HELPER = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug91-helper-'));
const STATE_DIR = path.join(TMP_HELPER, 'state');
const WKS = path.join(TMP_HELPER, 'wks');
const USER = 'kkrazyT';
const SESSION_CWD = path.join(WKS, USER, 'myco-' + USER + '-abc12345');
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(SESSION_CWD, { recursive: true });
process.on('exit', () => { try { fs.rmSync(TMP_HELPER, { recursive: true, force: true }); } catch {} });

function seedTokensFile(obj) {
  fs.writeFileSync(path.join(STATE_DIR, 'git-tokens.json'), JSON.stringify(obj), { mode: 0o600 });
}

function runHelper(stdin) {
  const env = Object.assign({}, process.env, { MYCO_STATE_DIR: STATE_DIR });
  const res = spawnSync(HELPER, ['get'], {
    cwd: SESSION_CWD,
    env,
    input: stdin,
    encoding: 'utf8',
  });
  if (res.error) throw res.error;
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

t('runtime: github host still gets username=x-access-token (unchanged behavior)', () => {
  if (!fs.existsSync(HELPER)) throw new Error('skipped — helper missing');
  seedTokensFile({ [USER]: { 'github/kkrazy/myco': 'ghp_token_abc' } });
  const stdin = 'protocol=https\nhost=github.com\npath=kkrazy/myco.git\n\n';
  const out = runHelper(stdin);
  assert.ok(out.stdout.includes('username=x-access-token\n'),
    `github must still emit x-access-token as username (github ignores it; the token IS the auth). Got:\n${out.stdout}`);
  assert.ok(out.stdout.includes('password=ghp_token_abc\n'),
    `github must emit the token as password. Got:\n${out.stdout}`);
});

t('runtime: gitee host with NO login override → username = myco-user (default)', () => {
  if (!fs.existsSync(HELPER)) throw new Error('skipped — helper missing');
  seedTokensFile({ [USER]: { 'gitee/kkrazy/omni-cache': 'gitee_pat_xyz' } });
  const stdin = 'protocol=https\nhost=gitee.com\npath=kkrazy/omni-cache.git\n\n';
  const out = runHelper(stdin);
  assert.ok(out.stdout.includes(`username=${USER}\n`),
    `gitee with NO stored login must default to the myco-user (${USER}). Got:\n${out.stdout}`);
  assert.ok(out.stdout.includes('password=gitee_pat_xyz\n'),
    `gitee must emit the token as password. Got:\n${out.stdout}`);
});

t('runtime: gitee with USER-LEVEL login override → username = that login', () => {
  if (!fs.existsSync(HELPER)) throw new Error('skipped — helper missing');
  seedTokensFile({
    [USER]: {
      'gitee/kkrazy/omni-cache': 'gitee_pat_xyz',
      giteeLogin: 'gitee-alt-login',
    },
  });
  const stdin = 'protocol=https\nhost=gitee.com\npath=kkrazy/omni-cache.git\n\n';
  const out = runHelper(stdin);
  assert.ok(out.stdout.includes('username=gitee-alt-login\n'),
    `gitee with user-level giteeLogin must use it. Got:\n${out.stdout}`);
});

t('runtime: gitee with PER-REPO login override → per-repo wins over user-level', () => {
  if (!fs.existsSync(HELPER)) throw new Error('skipped — helper missing');
  seedTokensFile({
    [USER]: {
      'gitee/kkrazy/omni-cache': 'gitee_pat_xyz',
      giteeLogin: 'gitee-user-level',
      'gitee/kkrazy/omni-cache.login': 'gitee-per-repo',
    },
  });
  const stdin = 'protocol=https\nhost=gitee.com\npath=kkrazy/omni-cache.git\n\n';
  const out = runHelper(stdin);
  assert.ok(out.stdout.includes('username=gitee-per-repo\n'),
    `gitee with a per-repo .login sidecar must win over the user-level giteeLogin. Got:\n${out.stdout}`);
});

t('runtime: gitee with per-repo .login for OTHER repo → falls back to user-level or default', () => {
  if (!fs.existsSync(HELPER)) throw new Error('skipped — helper missing');
  // Per-repo .login is scoped to a DIFFERENT repo; user-level is set.
  seedTokensFile({
    [USER]: {
      'gitee/kkrazy/omni-cache': 'gitee_pat_xyz',
      giteeLogin: 'gitee-user-level',
      'gitee/other/repo.login': 'wrong-scope-login',
    },
  });
  const stdin = 'protocol=https\nhost=gitee.com\npath=kkrazy/omni-cache.git\n\n';
  const out = runHelper(stdin);
  assert.ok(out.stdout.includes('username=gitee-user-level\n'),
    `per-repo .login for a DIFFERENT repo must NOT be picked up; user-level giteeLogin wins. Got:\n${out.stdout}`);
});

// ──────────────────────────────────────────────────────────────────
// Group C — /setgiteelogin slash command.

t('slashcmd: /setgiteelogin is registered + listed in /commands', () => {
  const stub = {
    _rec: { user: 'alice' }, _owners: new Set(['alice']),
    getSessionRecord(_id) { return this._rec; },
    isOwnerOrAdmin(_id, user) { return this._owners.has(user); },
    saveStore() {},
    appendChatMessage() {},
  };
  require.cache[require.resolve('../server/src/sessions')] = {
    exports: stub,
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
  delete require.cache[require.resolve('../server/src/slashcmds')];
  const slashcmds = require('../server/src/slashcmds');
  const cmds = slashcmds.listCommands();
  const cmd = cmds.find((c) => c.name === 'setgiteelogin');
  assert.ok(cmd, '/setgiteelogin must be in COMMANDS');
  assert.ok(/gitee/i.test(cmd.summary), 'summary must mention gitee');
});

t('/setgiteelogin from non-owner viewer is REFUSED', async () => {
  const slashcmds = require('../server/src/slashcmds');
  const sessionsMod = require('../server/src/sessions');
  sessionsMod._rec = { user: 'alice' };
  sessionsMod._owners = new Set(['alice']);
  const replies = [];
  const ctx = {
    sessionId: 'sid-1', user: 'eve', args: 'gitee-login',
    reply: (m) => replies.push(String(m)),
    session: { emit() {} },
  };
  await slashcmds.handleSetGiteeLogin(ctx);
  assert.ok(replies.some((r) => /owner/i.test(r)),
    'denial must mention the owner+admin gate');
});

t('/setgiteelogin rejects obviously-wrong input (spaces, too-long, punctuation)', async () => {
  const slashcmds = require('../server/src/slashcmds');
  const sessionsMod = require('../server/src/sessions');
  sessionsMod._rec = { user: 'alice' };
  sessionsMod._owners = new Set(['alice']);
  for (const bad of ['login with spaces', 'x'.repeat(60), 'not@allowed', 'ok/but/slashes']) {
    const replies = [];
    const ctx = {
      sessionId: 'sid-2', user: 'alice', args: bad,
      reply: (m) => replies.push(String(m)),
      session: { emit() {} },
    };
    await slashcmds.handleSetGiteeLogin(ctx);
    assert.ok(replies.some((r) => /doesn['’]t look like|too/i.test(r) || /login/i.test(r) && /invalid|expect/i.test(r)),
      `bad input "${bad}" must be rejected with an explanatory reply`);
  }
});

t('/setgiteelogin bare (no arg) prints usage + current value', async () => {
  const slashcmds = require('../server/src/slashcmds');
  const sessionsMod = require('../server/src/sessions');
  sessionsMod._rec = { user: 'alice' };
  sessionsMod._owners = new Set(['alice']);
  const replies = [];
  const ctx = {
    sessionId: 'sid-3', user: 'alice', args: '',
    reply: (m) => replies.push(String(m)),
    session: { emit() {} },
  };
  await slashcmds.handleSetGiteeLogin(ctx);
  assert.ok(replies.some((r) => /usage/i.test(r) || /--clear/i.test(r)),
    'bare invocation must show usage / --clear affordance');
});

// ──────────────────────────────────────────────────────────────────
// Group D — static guards.

t('static guard: git-credential-myco.sh branches username by provider (bug-91 fix)', () => {
  const body = _read('scripts/git-credential-myco.sh');
  // Must reference the storage keys the helper reads from.
  assert.ok(/giteeLogin/.test(body),
    'shell helper must reference `giteeLogin` (the user-level login sidecar key)');
  assert.ok(/\.login/.test(body),
    'shell helper must reference the per-repo `.login` sidecar suffix');
  // Must have a provider branch — github → x-access-token, gitee → resolved login.
  assert.ok(/x-access-token/.test(body),
    'shell helper must still emit x-access-token for github');
  // Must reference the mycoUser fallback — the derived login is the
  // final default when no override exists.
  assert.ok(/mycoUser/.test(body),
    'shell helper must fall back to mycoUser when no gitee login override is stored');
});

t('static guard: git-tokens.js exports getGiteeLogin/setGiteeLogin/setGiteeRepoLogin', () => {
  const src = _read('server/src/git-tokens.js');
  for (const fn of ['getGiteeLogin', 'setGiteeLogin', 'setGiteeRepoLogin', '_isLoginKey']) {
    assert.ok(new RegExp(`function\\s+${fn}\\s*\\(`).test(src),
      `git-tokens.js must define ${fn}`);
    assert.ok(new RegExp(`\\b${fn}\\b`).test(src),
      `git-tokens.js must export ${fn}`);
  }
});

t('static guard: listAllPats + listRepos skip the login sidecar keys', () => {
  const src = _read('server/src/git-tokens.js');
  const listAllBody = fnBody(src, /function\s+listAllPats\s*\(/);
  assert.ok(listAllBody, 'listAllPats body must be locatable');
  assert.ok(/_isLoginKey\s*\(/.test(listAllBody),
    'listAllPats must call _isLoginKey to skip login sidecar keys (they hold logins, not tokens)');
  const listReposBody = fnBody(src, /function\s+listRepos\s*\(/);
  assert.ok(listReposBody, 'listRepos body must be locatable');
  assert.ok(/_isLoginKey\s*\(/.test(listReposBody),
    'listRepos must call _isLoginKey too');
});

t('static guard: slashcmds.js exports handleSetGiteeLogin + /setgiteelogin is owner+admin gated', () => {
  const src = _read('server/src/slashcmds.js');
  assert.ok(/names:\s*\[\s*['"]setgiteelogin['"]/.test(src), '/setgiteelogin must be in COMMANDS');
  assert.ok(/function\s+handleSetGiteeLogin\s*\(/.test(src), 'handleSetGiteeLogin must be defined');
  const body = fnBody(src, /function\s+handleSetGiteeLogin\s*\(/);
  assert.ok(body, 'handleSetGiteeLogin body must be locatable');
  assert.ok(/isOwnerOrAdmin\s*\(/.test(body),
    'handleSetGiteeLogin must call isOwnerOrAdmin to gate the mutation');
  assert.ok(/setGiteeLogin\s*\(/.test(body),
    'handleSetGiteeLogin must call setGiteeLogin to persist');
});

t('static guard: git-hosts.js re-exports the gitee-login passthrough', () => {
  const src = _read('server/src/git-hosts.js');
  assert.ok(/getGiteeLogin/.test(src) && /setGiteeLogin/.test(src),
    'git-hosts.js must passthrough getGiteeLogin + setGiteeLogin so slash handlers can require ONE module');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
