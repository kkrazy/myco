// codehub credential support (Huawei intranet GitLab-family).
//
// User report (local-docker deploy): `git clone https://codehub-dg-g.huawei.com/
// <user>/<repo>.git` fails from a session. Two root causes surfaced:
//   1. the container cannot RESOLVE the intranet host (fixed at the docker
//      layer with `--add-host` — NOT covered here; it is infra, not code),
//   2. git has no credential for the private codehub repo: myco's credential
//      helper only served github.com / gitee.com, so it emitted nothing for
//      codehub and git fell through to a non-interactive Username prompt.
//
// This test locks the CODE changes that make a codehub credential resolvable
// and emittable:
//   - git-credential-myco.sh maps `codehub-dg-g.huawei.com` → provider `codehub`
//     and emits `username=<myco-user>` (codehub validates the username against
//     the PAT's owning account, like gitee) + the stored PAT as password.
//   - git-tokens.js knows `codehub` as a provider (KNOWN_PROVIDERS) so
//     setRepoToken/getToken round-trip codehub PAT slots.
//   - git-hosts.js detectHost recognizes the codehub host and fetchUser has a
//     codehub branch (GitLab /api/v4/user, best-effort) for /setpat validation.
//
// NOTE: consistent with the rest of this file's sibling tests, keep any
// comment prose APOSTROPHE-FREE — the helper's node body is embedded in a
// single-quoted shell string, and a stray apostrophe terminates the quote
// (bug-91's comments avoid them for exactly this reason).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── codehub credential support ──');

const HELPER = path.join(__dirname, '..', 'scripts', 'git-credential-myco.sh');

// ──────────────────────────────────────────────────────────────────
// Group A — git-tokens.js accepts codehub as a real provider.

const TMP_TOKENS = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-codehub-tokens-'));
process.env.MYCO_STATE_DIR = TMP_TOKENS;
process.on('exit', () => { try { fs.rmSync(TMP_TOKENS, { recursive: true, force: true }); } catch {} });
delete require.cache[require.resolve('../server/src/git-tokens')];
const gitTokens = require('../server/src/git-tokens');

t('git-tokens: codehub is a KNOWN_PROVIDERS, so setRepoToken accepts it', () => {
  gitTokens._resetCacheForTest();
  gitTokens.setRepoToken('alice', 'codehub', 's00791175', 'myco-test', 'codehub_pat_abc');
  gitTokens._resetCacheForTest();
  assert.strictEqual(gitTokens.getToken('alice', 'codehub', 's00791175', 'myco-test'),
    'codehub_pat_abc',
    'per-repo codehub PAT must round-trip through the store');
});

t('git-tokens: codehub user-level fallback works', () => {
  gitTokens._resetCacheForTest();
  gitTokens.setUserToken('alice', 'codehub', 'codehub_user_level_token');
  gitTokens._resetCacheForTest();
  assert.strictEqual(gitTokens.getToken('alice', 'codehub'), 'codehub_user_level_token',
    'bare codehub provider key must serve as the user-level fallback');
});

t('git-tokens: unknown provider still rejected (no creep)', () => {
  assert.throws(() => gitTokens.setRepoToken('alice', 'not-a-provider', 'o', 'r', 'x'),
    /unknown provider/,
    'unregistered providers must still throw');
});

// ──────────────────────────────────────────────────────────────────
// Group B — runtime shell helper emits a codehub credential.

const TMP_HELPER = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-codehub-helper-'));
const STATE_DIR = path.join(TMP_HELPER, 'state');
const WKS = path.join(TMP_HELPER, 'wks');
const USER = 's00791175';
const SESSION_CWD = path.join(WKS, USER, 'myco-' + USER + '-abc12345');
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(SESSION_CWD, { recursive: true });
process.on('exit', () => { try { fs.rmSync(TMP_HELPER, { recursive: true, force: true }); } catch {} });

function seedTokensFile(obj) {
  fs.writeFileSync(path.join(STATE_DIR, 'git-tokens.json'), JSON.stringify(obj), { mode: 0o600 });
}

function runHelper(stdin, cwd) {
  const env = Object.assign({}, process.env, { MYCO_STATE_DIR: STATE_DIR });
  const res = spawnSync(HELPER, ['get'], { cwd: cwd || SESSION_CWD, env, input: stdin, encoding: 'utf8' });
  if (res.error) throw res.error;
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

t('runtime: codehub host with a stored PAT → username=myco-user + password=PAT', () => {
  if (!fs.existsSync(HELPER)) throw new Error('skipped — helper missing');
  seedTokensFile({ [USER]: { 'codehub/s00791175/myco-test': 'codehub_pat_abc' } });
  const stdin = 'protocol=https\nhost=codehub-dg-g.huawei.com\npath=s00791175/myco-test.git\n\n';
  const out = runHelper(stdin);
  assert.ok(out.stdout.includes(`username=${USER}\n`),
    `codehub must emit the myco-user (${USER}) as username (codehub validates the username against the PAT owner). Got:\n${out.stdout}`);
  assert.ok(out.stdout.includes('password=codehub_pat_abc\n'),
    `codehub must emit the stored PAT as password. Got:\n${out.stdout}`);
});

t('runtime: codehub with USER-LEVEL token → emitted as password', () => {
  if (!fs.existsSync(HELPER)) throw new Error('skipped — helper missing');
  seedTokensFile({ [USER]: { codehub: 'codehub_user_level_token' } });
  const stdin = 'protocol=https\nhost=codehub-dg-g.huawei.com\npath=s00791175/myco-test.git\n\n';
  const out = runHelper(stdin);
  assert.ok(out.stdout.includes(`username=${USER}\n`),
    `user-level codehub token must still emit the myco-user username. Got:\n${out.stdout}`);
  assert.ok(out.stdout.includes('password=codehub_user_level_token\n'),
    `user-level codehub token must be emitted as password. Got:\n${out.stdout}`);
});

t('runtime: non-codehub host unaffected (github still x-access-token)', () => {
  if (!fs.existsSync(HELPER)) throw new Error('skipped — helper missing');
  seedTokensFile({ [USER]: { 'github/kkrazy/myco': 'ghp_token_abc' } });
  const stdin = 'protocol=https\nhost=github.com\npath=kkrazy/myco.git\n\n';
  const out = runHelper(stdin);
  assert.ok(out.stdout.includes('username=x-access-token\n'),
    `github must still emit x-access-token, never the codehub path. Got:\n${out.stdout}`);
});

// bug-92: the session reaper can delete the workspace while a git op is
// in flight, so git's cwd no longer matches /wks/<user>/. Pre-fix the
// helper gave up (emit nothing) there → git failed with "could not read
// Username" in ~0.2s despite a valid codehub token on file. Post-fix the
// helper falls back to a store-wide scan and emits a credential whenever
// every matching entry collapses to a single distinct token.
t('runtime: reaped session cwd (not /wks/<user>/) still emits codehub cred via store-wide fallback', () => {
  if (!fs.existsSync(HELPER)) throw new Error('skipped — helper missing');
  seedTokensFile({ [USER]: { 'codehub/s00791175/myco-test': 'codehub_pat_abc', codehubLogin: USER } });
  const stdin = 'protocol=https\nhost=codehub-dg-g.huawei.com\npath=s00791175/myco-test.git\n\n';
  const out = runHelper(stdin, TMP_HELPER); // TMP_HELPER root — no /wks/ segment, simulates reaped cwd
  assert.ok(out.stdout.includes(`username=${USER}\n`),
    `reaped-cwd fallback must still emit the codehub username (${USER}). Got:\n${out.stdout}`);
  assert.ok(out.stdout.includes('password=codehub_pat_abc\n'),
    `reaped-cwd fallback must still emit the stored PAT as password. Got:\n${out.stdout}`);
});

// bug-92 guard: the store-wide fallback MUST NOT guess when multiple
// users hold distinct tokens (whose identity would we use? emit nothing).
t('runtime: ambiguous multi-user store with no cwd → emits nothing (no guess)', () => {
  if (!fs.existsSync(HELPER)) throw new Error('skipped — helper missing');
  seedTokensFile({
    [USER]:         { 'codehub/s00791175/myco-test': 'tok_a' },
    'someone-else': { 'codehub/s00791175/myco-test': 'tok_b' },
  });
  const stdin = 'protocol=https\nhost=codehub-dg-g.huawei.com\npath=s00791175/myco-test.git\n\n';
  const out = runHelper(stdin, TMP_HELPER);
  assert.strictEqual(out.stdout, '',
    `ambiguous multi-user store must emit nothing (distinct tokens). Got:\n${out.stdout}`);
});

// ──────────────────────────────────────────────────────────────────
// Group C — static guards: detectHost maps codehub, fetchUser branches,
// helper maps the host string, KNOWN_PROVIDERS includes codehub.

t('static guard: git-hosts.js detectHost maps codehub-dg-g.huawei.com → provider codehub', () => {
  const src = _read('server/src/git-hosts.js');
  assert.ok(/codehub-dg-g\.huawei\.com/.test(src),
    'HOST_REGEX / detection must mention the codehub host');
  assert.ok(/'codehub'/.test(src) || /"codehub"/.test(src),
    'detectHost / fetchUser must reference the codehub provider string');
});

t('static guard: git-hosts.js fetchUser has a codehub branch', () => {
  const src = _read('server/src/git-hosts.js');
  assert.ok(/provider === ['"]codehub['"]/.test(src),
    'fetchUser must route codehub to _fetchUserCodehub');
  assert.ok(/function\s+_fetchUserCodehub\s*\(/.test(src),
    '_fetchUserCodehub must be defined (GitLab-style /api/v4/user best-effort)');
});

t('static guard: git-credential-myco.sh maps codehub host → codehub provider + myco-user username', () => {
  const body = _read('scripts/git-credential-myco.sh');
  assert.ok(/codehub-dg-g\.huawei\.com/.test(body),
    'shell helper must recognize the codehub host in its host→provider mapping');
  assert.ok(/provider === ['"]codehub['"]/.test(body),
    'shell helper must branch on the codehub provider');
  // bug-92 refactor: codehub username now resolves through the stored
  // login chain (codehubLogin → owning account), never x-access-token.
  // Guard the user-level login override the resolution reads.
  assert.ok(/codehubLogin/.test(body),
    'shell helper must resolve the codehub credential username from the stored codehub login override');
});

t('static guard: git-tokens.js KNOWN_PROVIDERS includes codehub', () => {
  const src = _read('server/src/git-tokens.js');
  assert.ok(/KNOWN_PROVIDERS\s*=\s*new Set\(\[[^\]]*'codehub'/.test(src),
    'KNOWN_PROVIDERS must include codehub so setRepoToken/getToken accept it');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
