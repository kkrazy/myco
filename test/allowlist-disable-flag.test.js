// MYCO_DISABLE_ALLOWLIST — temporary open-mode switch.
//
// User request: keep allowed-github-users.txt on disk (compat with the
// old invitation mode) but let a deployment temporarily switch its
// enforcement OFF via an env flag, with deploy defaulting to OFF.
//
// Locks the regression points:
//   1. auth.isAllowlistDisabled() honors MYCO_DISABLE_ALLOWLIST with the
//      same '0'/'false'-is-OFF string semantics as MYCO_AUTH_REQUIRED.
//   2. With the flag ON, isAllowlistConfigured() is false and isAllowed()
//      admits any sanitized login even when the allowlist file exists
//      (file untouched → flip back by clearing the flag).
//   3. Both login gates (PAT + OAuth callback) are conditional on
//      isAllowlistConfigured() so open mode admits valid logins on
//      either path.
//   4. deploy.sh seeds MYCO_DISABLE_ALLOWLIST=1 on a full deploy and
//      --enforce-allowlist flips it back to 0.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-allowlist-flag-'));
process.env.MYCO_STATE_DIR = tmpState;

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');
const AUTH = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'auth.js'), 'utf8');
const DEPLOY = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'deploy.sh'), 'utf8');

// Fresh require per check so env reads are live.
function freshAuth() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(`${path.sep}server${path.sep}src${path.sep}auth.js`)) delete require.cache[k];
  }
  return require('../server/src/auth');
}

console.log('── MYCO_DISABLE_ALLOWLIST: temporary open-mode switch ──');

const AL_FILE = path.join(tmpState, 'allowed-github-users.txt');

t('isAllowlistDisabled honors the flag (1=on, 0/false/unset=off)', () => {
  const prev = process.env.MYCO_DISABLE_ALLOWLIST;
  try {
    let auth;
    delete process.env.MYCO_DISABLE_ALLOWLIST;
    auth = freshAuth();
    assert.strictEqual(auth.isAllowlistDisabled(), false, 'unset → not disabled');
    process.env.MYCO_DISABLE_ALLOWLIST = '1';
    auth = freshAuth();
    assert.strictEqual(auth.isAllowlistDisabled(), true, '1 → disabled');
    process.env.MYCO_DISABLE_ALLOWLIST = '0';
    auth = freshAuth();
    assert.strictEqual(auth.isAllowlistDisabled(), false, '0 → NOT disabled (string-0 trap)');
    process.env.MYCO_DISABLE_ALLOWLIST = 'false';
    auth = freshAuth();
    assert.strictEqual(auth.isAllowlistDisabled(), false, 'false → NOT disabled');
  } finally {
    if (prev === undefined) delete process.env.MYCO_DISABLE_ALLOWLIST; else process.env.MYCO_DISABLE_ALLOWLIST = prev;
  }
});

t('flag ON: file exists but isAllowlistConfigured()=false, isAllowed() admits everyone', () => {
  fs.writeFileSync(AL_FILE, '# seeded\nalice\n');
  try {
    const prev = process.env.MYCO_DISABLE_ALLOWLIST;
    process.env.MYCO_DISABLE_ALLOWLIST = '1';
    try {
      const auth = freshAuth();
      assert.strictEqual(auth.isAllowlistConfigured(), false,
        'flag ON → open mode even with the file present');
      assert.strictEqual(auth.isAllowed('alice'), true, 'listed user admitted');
      assert.strictEqual(auth.isAllowed('stranger'), true, 'unlisted user ALSO admitted (open mode)');
      assert.ok(fs.existsSync(AL_FILE), 'file must remain on disk untouched');
    } finally {
      if (prev === undefined) delete process.env.MYCO_DISABLE_ALLOWLIST; else process.env.MYCO_DISABLE_ALLOWLIST = prev;
    }
  } finally { fs.rmSync(AL_FILE, { force: true }); }
});

t('flag OFF: file exists → invitation mode restored, entries intact', () => {
  fs.writeFileSync(AL_FILE, '# seeded\nalice\n');
  try {
    const prev = process.env.MYCO_DISABLE_ALLOWLIST;
    process.env.MYCO_DISABLE_ALLOWLIST = '0';
    try {
      const auth = freshAuth();
      assert.strictEqual(auth.isAllowlistConfigured(), true, 'flag OFF + file → configured');
      assert.strictEqual(auth.isAllowed('alice'), true, 'listed user admitted');
      assert.strictEqual(auth.isAllowed('stranger'), false, 'unlisted user rejected');
    } finally {
      if (prev === undefined) delete process.env.MYCO_DISABLE_ALLOWLIST; else process.env.MYCO_DISABLE_ALLOWLIST = prev;
    }
  } finally { fs.rmSync(AL_FILE, { force: true }); }
});

t('both login gates are conditional on isAllowlistConfigured()', () => {
  assert.match(INDEX, /isAllowlistConfigured\(\) && !isAllowed\(login\)/,
    'PAT gate must stay conditional so open mode admits valid logins');
  const cbStart = INDEX.indexOf('/auth/github/callback');
  const cb = INDEX.slice(cbStart, INDEX.indexOf('mintSession(login', cbStart));
  assert.match(cb, /isAllowlistConfigured\(\) && !isAllowed\(login\)/,
    'OAuth callback gate must also be conditional (was an unconditional isAllowed check before)');
});

t('auth.js exports isAllowlistDisabled', () => {
  assert.match(AUTH, /module\.exports[\s\S]*isAllowlistDisabled/, 'must be exported for future gates/UI');
});

t('deploy.sh defaults enforcement OFF and offers --enforce-allowlist', () => {
  assert.match(DEPLOY, /--enforce-allowlist\)\s+ENFORCE_ALLOWLIST=1/,
    'arg parser must accept --enforce-allowlist');
  assert.match(DEPLOY, /set_allowlist_flag_in_env 1/,
    'full deploy must default MYCO_DISABLE_ALLOWLIST=1 (open mode)');
  assert.match(DEPLOY, /set_allowlist_flag_in_env 0/,
    '--enforce-allowlist must write 0 (invitation mode back on)');
  assert.match(DEPLOY, /ensure_allowlist_seed\n/,
    'file seeding must STAY (compat: entries preserved for flip-back)');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
