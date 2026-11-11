// CodeHub third login method + forced login screen.
//
// User request: "新增第三种codehub登录，登录界面现在隐藏了" — add a
// CodeHub (Huawei intranet GitLab-family) login and make the login screen
// visible. Approved plan:
//   - CodeHub PAT login validated against GitLab /api/v4/user (reuse
//     git-hosts._fetchUserCodehub), no OAuth app registration.
//   - Force login + open access via MYCO_AUTH_REQUIRED (no allowlist).
//   - Unified token input + provider dropdown (GitHub/Gitee/CodeHub).
//
// This locks the regression points statically + at the auth-gate runtime:
//   1. /auth/login honors an explicit `provider` and has a codehub branch
//      (validates via gitHosts.fetchUser provider:'codehub').
//   2. The invitation allowlist is only enforced when one is configured
//      (open mode: a valid codehub token is admitted without a GitHub
//      allowlist entry).
//   3. auth.isAuthRequired() honors MYCO_AUTH_REQUIRED, treating '0'/'false'
//      as OFF (the string-'0'-is-truthy trap would otherwise wrongly keep
//      the login screen hidden).
//   4. The login modal provides the three-way provider dropdown
//      (#login-pat-provider) with a codehub option, and doPatLogin sends it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-codehub-login-'));
process.env.MYCO_STATE_DIR = tmpState; // no allowed-github-users.txt → open mode

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');
const AUTH = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'auth.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'index.html'), 'utf8');

console.log('── codehub login: third provider + forced auth gate ──');

// Fresh require per check so isAuthRequired() reads process.env live.
function freshAuth() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(`${path.sep}server${path.sep}src${path.sep}auth.js`)) delete require.cache[k];
  }
  return require('../server/src/auth');
}

t('auth.isAuthRequired honors MYCO_AUTH_REQUIRED (1=on, 0/false=off)', () => {
  const prev = process.env.MYCO_AUTH_REQUIRED;
  try {
    delete process.env.MYCO_AUTH_REQUIRED;
    let auth = freshAuth();
    assert.strictEqual(auth.isAuthRequired(), false, 'no flag → auth not required');
    process.env.MYCO_AUTH_REQUIRED = '1';
    auth = freshAuth();
    assert.strictEqual(auth.isAuthRequired(), true, 'MYCO_AUTH_REQUIRED=1 → required (login screen shows)');
    process.env.MYCO_AUTH_REQUIRED = '0';
    auth = freshAuth();
    assert.strictEqual(auth.isAuthRequired(), false, 'MYCO_AUTH_REQUIRED=0 → NOT required (string-0 trap)');
    process.env.MYCO_AUTH_REQUIRED = 'false';
    auth = freshAuth();
    assert.strictEqual(auth.isAuthRequired(), false, 'MYCO_AUTH_REQUIRED=false → NOT required');
  } finally {
    if (prev === undefined) delete process.env.MYCO_AUTH_REQUIRED; else process.env.MYCO_AUTH_REQUIRED = prev;
  }
});

t('auth.isAllowlistConfigured() exists and is false with no allowlist file', () => {
  const auth = freshAuth();
  assert.strictEqual(typeof auth.isAllowlistConfigured, 'function', 'isAllowlistConfigured must be exported');
  assert.strictEqual(auth.isAllowlistConfigured(), false, 'tmp state has no allowed-github-users.txt → open mode');
  // With a file present it flips true.
  fs.writeFileSync(path.join(tmpState, 'allowed-github-users.txt'), '# x\nalice\n');
  try { assert.strictEqual(auth.isAllowlistConfigured(), true, 'allowlist file present → configured'); }
  finally { fs.rmSync(path.join(tmpState, 'allowed-github-users.txt'), { force: true }); }
});

t('/auth/login dispatches on an explicit codehub provider', () => {
  assert.match(INDEX, /let provider = String\(\(req\.body && req\.body\.provider\) \|\| 'auto'\)/,
    '/auth/login must read an explicit provider from the body');
  assert.match(INDEX, /provider === 'codehub'/,
    '/auth/login must have an explicit codehub branch');
  assert.match(INDEX, /gitHosts\.fetchUser\(\{ provider: 'codehub', token: pat \}\)/,
    'codehub branch validates the token via git-hosts _fetchUserCodehub (GitLab /api/v4/user)');
});

t('/auth/login allows the allowlist gate to open (isAllowlistConfigured check)', () => {
  assert.match(INDEX, /isAllowlistConfigured\(\) && !isAllowed\(login\)/,
    'allowlist gate must be conditional on isAllowlistConfigured() so open mode admits valid logins');
});

t('/auth/login test seam covers codehub (test-codehub-token-<login>)', () => {
  assert.match(INDEX, /test-codehub-token-/,
    'E2E suite needs a canned codehub bypass token shape');
});

t('login modal offers a three-way provider dropdown with codehub', () => {
  assert.match(HTML, /id="login-pat-provider"/, 'login modal must have the provider dropdown');
  assert.match(HTML, /<option value="codehub">CodeHub<\/option>/, 'provider dropdown must include CodeHub');
  assert.match(HTML, /id="login-pat-provider"/);
});

t('doPatLogin POSTs the chosen provider to /auth/login', () => {
  assert.match(APP, /login-pat-provider/, 'doPatLogin must read the provider dropdown');
  assert.match(APP, /JSON\.stringify\(\{\s*token: pat,\s*provider\s*\}/,
    'doPatLogin must send {token, provider} to /auth/login');
});

t('config modal PAT provider select includes codehub', () => {
  assert.match(HTML, /id="config-pat-provider"/, 'config modal PAT provider select exists');
  assert.match(HTML, /<option value="codehub">codehub<\/option>/, 'config PAT provider includes codehub');
});

t('auto-detect falls back to a CodeHub probe (auto provider)', () => {
  assert.match(INDEX, /isLikelyGitee  \? \['gitee', 'github', 'codehub'\]/,
    'gitee-shaped token must fall back to codehub');
  assert.match(INDEX, /\['github', 'gitee', 'codehub'\]/,
    'ambiguous/ambiguous-github-shaped token must fall back to codehub');
  assert.match(INDEX, /gitHosts\.fetchUser\(\{ provider: p, token: pat \}\)/,
    'auto-detect must probe each candidate (incl. codehub) via gitHosts.fetchUser');
  assert.match(INDEX, /All providers rejected the token\. GitHub: .*CodeHub:/,
    'auto failure must report a CodeHub attempt');
});

t('login hint links to the CodeHub PAT creation page', () => {
  assert.match(HTML, /href="https:\/\/codehub-g\.huawei\.com\/profile\/personal_access_tokens"/,
    'login hint must link the CodeHub PAT creation page');
});

if (failed) {
  console.log(`\n${failed} test(s) FAILED, ${passed} passed.`);
  process.exit(1);
}
console.log(`\n${passed} tests passed.`);
