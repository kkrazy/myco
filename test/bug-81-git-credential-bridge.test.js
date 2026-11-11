// bug-81: git push ignores token login and config-set token.
//
// User report (2026-06-09):
//   "Pushing code does not use the configured authentication token,
//    causing push failures or unexpected credential prompts. Expected:
//    push operations authenticate using the token from `token login`
//    or the token set in config. Actual: neither the token login nor
//    the config-set token is used when pushing code."
//
// Root cause: the myco token store (/data/git-tokens.json, managed by
// server/src/git-tokens.js) is server-side application state. Git
// the CLI has no awareness of it. When `git push` runs, git's
// credential resolution chain is:
//   1. credential.helper config → not set
//   2. ~/.git-credentials → doesn't exist
//   3. Interactive prompt → no terminal → "could not read Username
//      for 'https://github.com'" → push fails
//
// `/setpat <token>` updates /data/git-tokens.json, but nothing
// bridges that file to git's credential.fill protocol.
//
// Fix: ship a small git credential helper script
// (scripts/git-credential-myco.sh) that:
//   · reads git's stdin credential-fill protocol (key=value pairs)
//   · derives the myco-user from cwd (matches /wks/<user>/...)
//   · loads /data/git-tokens.json (or $MYCO_STATE_DIR/git-tokens.json)
//   · looks up token: per-repo (provider/owner/repo) first, falls
//     back to user-level (bare provider key)
//   · emits "username=x-access-token\npassword=<token>\n" on stdout
//   · emits nothing on no-match → git falls through cleanly
//
// Registered globally in docker/docker-entrypoint.sh so every
// container runs with the bridge active. After deploy, `git push`
// transparently uses whichever token /setpat / OAuth landed in
// /data/git-tokens.json.
//
// Test shape: static guards on the helper + entrypoint registration,
// plus runtime guards spawning the helper with synthesized stdin
// against a tmpdir-isolated token store.

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

console.log('── bug-81: git credential bridge (myco tokens → git push) ──');

const HELPER = path.join(__dirname, '..', 'scripts', 'git-credential-myco.sh');
const ENTRYPOINT = path.join(__dirname, '..', 'docker', 'docker-entrypoint.sh');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guards
// ─────────────────────────────────────────────────────────────────

t('scripts/git-credential-myco.sh exists', () => {
  assert.ok(fs.existsSync(HELPER),
    `bug-81: ${HELPER} must exist — this is the bridge script that lets git push authenticate via myco's token store. Without it, every push needs an inline -c credential.helper='!f() {…}; f' workaround.`);
});

t('scripts/git-credential-myco.sh is executable', () => {
  const stat = fs.statSync(HELPER);
  const mode = stat.mode & 0o777;
  assert.ok((mode & 0o111) !== 0,
    `bug-81: ${HELPER} must have an executable bit set (current mode=0${mode.toString(8)}). Git can't run a non-executable credential helper — it'll just silently produce no credentials and fall through to the interactive prompt.`);
});

t('git-credential-myco.sh body reads from stdin (git\'s credential-fill protocol)', () => {
  const body = fs.readFileSync(HELPER, 'utf8');
  // The helper must consume stdin to honor the `get` action's
  // protocol. Any of: read loop / `cat`-into-var / `mapfile` / node
  // process.stdin / etc.
  assert.ok(/read\s|cat\b|process\.stdin|\$\(\s*cat\b|stdin/.test(body),
    'bug-81: the helper must consume stdin — git\'s credential-fill protocol passes the context (protocol, host, path, …) on stdin as key=value lines. A helper that ignores stdin can\'t scope its lookup to the right host/repo.');
});

t('git-credential-myco.sh emits username + password on stdout when a token is found', () => {
  const body = fs.readFileSync(HELPER, 'utf8');
  // Look for the two output lines somewhere in the script. The
  // helper must print BOTH lines (just one is not a valid response).
  assert.ok(/username=/.test(body),
    'bug-81: the helper must emit a `username=` line on stdout — git parses this as the username for the credential. (Tokens use x-access-token as the conventional username.)');
  assert.ok(/password=/.test(body),
    'bug-81: the helper must emit a `password=` line on stdout — git parses this as the password. For a PAT, the token IS the password.');
});

t('git-credential-myco.sh looks up token from /data/git-tokens.json (or $MYCO_STATE_DIR)', () => {
  const body = fs.readFileSync(HELPER, 'utf8');
  assert.ok(/git-tokens\.json/.test(body),
    'bug-81: the helper must reference git-tokens.json — that\'s where /setpat + the OAuth callback land the token. Without this, the helper has nothing to look up.');
  assert.ok(/MYCO_STATE_DIR|\/data/.test(body),
    'bug-81: the helper must honor MYCO_STATE_DIR (or default to /data) so it finds the token file in the same place server/src/git-tokens.js does.');
});

t('git-credential-myco.sh derives myco user from cwd (per-user disambiguation)', () => {
  const body = fs.readFileSync(HELPER, 'utf8');
  assert.ok(/\/wks\//.test(body) || /WORKSPACE/.test(body) || /pwd\b/.test(body),
    'bug-81: the helper must derive the myco user from cwd (matches /wks/<user>/<session-id>/…) — without it, multi-tenant containers would use the wrong user\'s tokens.');
});

t('docker/docker-entrypoint.sh registers credential.helper to point at the script', () => {
  const ep = fs.readFileSync(ENTRYPOINT, 'utf8');
  assert.ok(/git config[\s\S]{0,200}credential\.helper/.test(ep),
    'bug-81: docker-entrypoint.sh must run `git config --global credential.helper …` so containers come up with the bridge active. Without registration, the helper script is unreachable and git falls back to interactive prompt.');
  assert.ok(/git-credential-myco/.test(ep),
    'bug-81: the registered credential.helper path must reference git-credential-myco (the helper this fix ships). Without that name, the registration could point at anything and the test wouldn\'t catch a misconfiguration.');
});

// ─────────────────────────────────────────────────────────────────
// PART B — Runtime: spawn the helper with synthesized stdin and a
// tmpdir-isolated token store
// ─────────────────────────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug81-'));
const STATE_DIR = path.join(TMP, 'state');
const WKS = path.join(TMP, 'wks');
const USER = 'kkrazyT';
const SESSION_CWD = path.join(WKS, USER, 'myco-' + USER + '-' + 'abc12345');
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(SESSION_CWD, { recursive: true });
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

function seedTokens(obj) {
  fs.writeFileSync(path.join(STATE_DIR, 'git-tokens.json'), JSON.stringify(obj), { mode: 0o600 });
}

function runHelper({ stdin, cwd = SESSION_CWD, action = 'get', env = {} }) {
  const fullEnv = Object.assign({}, process.env, { MYCO_STATE_DIR: STATE_DIR }, env);
  const res = spawnSync(HELPER, [action], {
    cwd,
    env: fullEnv,
    input: stdin,
    encoding: 'utf8',
  });
  if (res.error) throw res.error;
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

t('runtime: per-repo PAT in token store → helper returns it as the password', () => {
  if (!fs.existsSync(HELPER) || (fs.statSync(HELPER).mode & 0o111) === 0) {
    throw new Error('skipped — helper script missing (covered by static guard)');
  }
  seedTokens({
    [USER]: {
      'github/kkrazy/myco': 'ghp_per_repo_token_xyz',
      'github': 'ghp_user_level_fallback',
    },
  });
  const stdin = 'protocol=https\nhost=github.com\npath=kkrazy/myco.git\n\n';
  const out = runHelper({ stdin });
  assert.ok(out.stdout.includes('username='),
    `bug-81: helper must emit a username= line. Got stdout:\n${out.stdout}\nstderr:\n${out.stderr}`);
  assert.ok(out.stdout.includes('password=ghp_per_repo_token_xyz'),
    `bug-81: helper must emit the PER-REPO token when one exists (per the git-tokens.js precedence). Got:\n${out.stdout}`);
});

t('runtime: no per-repo token but user-level present → helper returns user-level token', () => {
  if (!fs.existsSync(HELPER) || (fs.statSync(HELPER).mode & 0o111) === 0) {
    throw new Error('skipped — helper script missing');
  }
  seedTokens({
    [USER]: {
      'github': 'ghp_user_level_only',
    },
  });
  const stdin = 'protocol=https\nhost=github.com\npath=kkrazy/myco.git\n\n';
  const out = runHelper({ stdin });
  assert.ok(out.stdout.includes('password=ghp_user_level_only'),
    `bug-81: helper must fall back to user-level token when no per-repo PAT exists. Got:\n${out.stdout}`);
});

t('runtime: no token for this user/host → helper emits NOTHING (git falls through)', () => {
  if (!fs.existsSync(HELPER) || (fs.statSync(HELPER).mode & 0o111) === 0) {
    throw new Error('skipped — helper script missing');
  }
  seedTokens({ otherUser: { github: 'ghp_xxx' } });
  const stdin = 'protocol=https\nhost=github.com\npath=kkrazy/myco.git\n\n';
  const out = runHelper({ stdin });
  assert.ok(!out.stdout.includes('password='),
    `bug-81: helper must emit NOTHING (no password= line) when no token matches — git falls through to the next helper / prompt. Found unexpected password line in:\n${out.stdout}`);
});

t('runtime: cwd outside /wks/<user>/… → helper emits NOTHING (safe fallthrough)', () => {
  if (!fs.existsSync(HELPER) || (fs.statSync(HELPER).mode & 0o111) === 0) {
    throw new Error('skipped — helper script missing');
  }
  seedTokens({ [USER]: { github: 'ghp_user_level' } });
  const stdin = 'protocol=https\nhost=github.com\npath=kkrazy/myco.git\n\n';
  const outsideCwd = TMP;   // not under /wks/<user>/…
  const out = runHelper({ stdin, cwd: outsideCwd });
  assert.ok(!out.stdout.includes('password='),
    `bug-81: when cwd doesn't match /wks/<user>/…, the helper can't disambiguate which user's tokens to use — must emit nothing (safe fallthrough). Got:\n${out.stdout}`);
});

t('runtime: gitee host → looks up under github\'s sibling provider slot', () => {
  if (!fs.existsSync(HELPER) || (fs.statSync(HELPER).mode & 0o111) === 0) {
    throw new Error('skipped — helper script missing');
  }
  seedTokens({
    [USER]: {
      'gitee/kkrazy/myco': 'gtp_gitee_pat_xyz',
    },
  });
  const stdin = 'protocol=https\nhost=gitee.com\npath=kkrazy/myco.git\n\n';
  const out = runHelper({ stdin });
  assert.ok(out.stdout.includes('password=gtp_gitee_pat_xyz'),
    `bug-81: helper must map host=gitee.com to provider=gitee and look up the per-repo slot accordingly. Without this, /setpat-stored Gitee tokens are stranded. Got:\n${out.stdout}`);
});

console.log(`── bug-81: ${passed} passed, ${failed} failed ──`);
process.exit(failed === 0 ? 0 : 1);
