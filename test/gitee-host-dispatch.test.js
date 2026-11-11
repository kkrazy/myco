// td-4: Gitee support for /feature, /bug — per-(user, repo) PAT storage
// + host detection + issue dispatch + /setpat slash command.
//
// What we pin:
//   1. git-tokens.js: per-repo + user-level slots with correct precedence
//      (per-repo wins; user-level falls back). Migration from legacy
//      gh-tokens.json flat shape onto the user-level slot.
//   2. git-hosts.js detectHost: classifies github vs. gitee remotes (SSH
//      + HTTPS), returns null for unknown / no-remote dirs.
//   3. git-hosts.js createIssue: dispatches to provider-specific builders
//      (GitHub: JSON + Authorization header + /repos/{o}/{r}/issues;
//      Gitee: form-urlencoded + access_token field + /repos/{o}/issues
//      with repo in body).
//   4. /setpat slash command: takes ONE arg (the token), auto-derives
//      provider+owner+repo from session.cwd, validates via fetchUser,
//      stores via setRepoToken.
//   5. github.js back-compat shim: setToken still works for OAuth
//      callback; landed at the user-level (no slash) slot.

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function t(name, fn) {
  const run = async () => {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
  };
  t._chain = (t._chain || Promise.resolve()).then(run);
}

function freshStateDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-td4-'));
  process.env.MYCO_STATE_DIR = d;
  delete require.cache[require.resolve('../server/src/git-tokens')];
  delete require.cache[require.resolve('../server/src/git-hosts')];
  delete require.cache[require.resolve('../server/src/github')];
  delete require.cache[require.resolve('../server/src/slashcmds')];
  return d;
}

// ─── git-tokens.js ──────────────────────────────────────────────────────────

t('git-tokens: getToken returns null when nothing stored', () => {
  freshStateDir();
  const gt = require('../server/src/git-tokens');
  assert.strictEqual(gt.getToken('alice', 'github', 'o', 'r'), null);
  assert.strictEqual(gt.getToken('alice', 'github'), null);
});

t('git-tokens: per-repo PAT round-trip', () => {
  freshStateDir();
  const gt = require('../server/src/git-tokens');
  gt.setRepoToken('alice', 'github', 'kkrazy', 'myco', 'gh_repo_pat');
  gt.setRepoToken('alice', 'gitee', 'someone', 'cool', 'gt_repo_pat');
  assert.strictEqual(gt.getToken('alice', 'github', 'kkrazy', 'myco'), 'gh_repo_pat');
  assert.strictEqual(gt.getToken('alice', 'gitee', 'someone', 'cool'), 'gt_repo_pat');
  // Different repo on the same provider returns nothing (no fallback set).
  assert.strictEqual(gt.getToken('alice', 'github', 'other', 'repo'), null);
});

t('git-tokens: user-level token serves as fallback for missing per-repo entry', () => {
  freshStateDir();
  const gt = require('../server/src/git-tokens');
  gt.setUserToken('alice', 'github', 'oauth_user_level');
  // No per-repo PAT → returns the user-level token for any github repo.
  assert.strictEqual(gt.getToken('alice', 'github', 'any', 'repo'), 'oauth_user_level');
  assert.strictEqual(gt.getToken('alice', 'github', 'another', 'one'), 'oauth_user_level');
});

t('git-tokens: per-repo PAT OVERRIDES the user-level fallback', () => {
  freshStateDir();
  const gt = require('../server/src/git-tokens');
  gt.setUserToken('alice', 'github', 'oauth_default');
  gt.setRepoToken('alice', 'github', 'kkrazy', 'myco', 'specific_pat');
  // The repo with a per-repo PAT picks it; others fall through.
  assert.strictEqual(gt.getToken('alice', 'github', 'kkrazy', 'myco'), 'specific_pat');
  assert.strictEqual(gt.getToken('alice', 'github', 'kkrazy', 'other'), 'oauth_default');
});

t('git-tokens: user-level lookup (no owner/repo args) does NOT pick up per-repo entries', () => {
  freshStateDir();
  const gt = require('../server/src/git-tokens');
  gt.setRepoToken('alice', 'gitee', 'someone', 'cool', 'per_repo_only');
  // No user-level token set; calling without owner/repo must return null.
  assert.strictEqual(gt.getToken('alice', 'gitee'), null);
});

t('git-tokens: rejects unknown provider on setRepoToken / setUserToken', () => {
  freshStateDir();
  const gt = require('../server/src/git-tokens');
  assert.throws(() => gt.setRepoToken('alice', 'bitbucket', 'o', 'r', 'x'), /unknown provider/i);
  assert.throws(() => gt.setUserToken('alice', 'bitbucket', 'x'), /unknown provider/i);
});

t('git-tokens: setRepoToken requires owner+repo', () => {
  freshStateDir();
  const gt = require('../server/src/git-tokens');
  assert.throws(() => gt.setRepoToken('alice', 'github', '', 'r', 'x'), /required/i);
  assert.throws(() => gt.setRepoToken('alice', 'github', 'o', '', 'x'), /required/i);
});

t('git-tokens: setRepoToken persists across re-require + mode 0600', () => {
  const dir = freshStateDir();
  let gt = require('../server/src/git-tokens');
  gt.setRepoToken('alice', 'gitee', 'someone', 'cool', 'persisted-gitee');
  const tokFile = gt._tokensFile();
  assert.ok(fs.existsSync(tokFile), 'git-tokens.json should exist');
  assert.strictEqual((fs.statSync(tokFile).mode & 0o777), 0o600, 'should be mode 0600');
  // Simulate process restart.
  delete require.cache[require.resolve('../server/src/git-tokens')];
  gt = require('../server/src/git-tokens');
  assert.strictEqual(gt.getToken('alice', 'gitee', 'someone', 'cool'), 'persisted-gitee');
});

t('git-tokens: migrates legacy gh-tokens.json {user: token} into user-level github slot', () => {
  const dir = freshStateDir();
  fs.writeFileSync(
    path.join(dir, 'gh-tokens.json'),
    JSON.stringify({ alice: 'legacy-gh-tok' }),
    { mode: 0o600 },
  );
  const gt = require('../server/src/git-tokens');
  // Migrated token lives at the user-level (any github repo falls back).
  assert.strictEqual(gt.getToken('alice', 'github', 'any', 'repo'), 'legacy-gh-tok');
  assert.strictEqual(gt.getToken('alice', 'github'), 'legacy-gh-tok');
  // New file persisted.
  assert.ok(fs.existsSync(gt._tokensFile()));
});

t('git-tokens: listRepos returns per-repo entries (not user-level fallbacks)', () => {
  freshStateDir();
  const gt = require('../server/src/git-tokens');
  gt.setUserToken('alice', 'github', 'oauth');         // should NOT appear in listRepos
  gt.setRepoToken('alice', 'github', 'kkrazy', 'myco', 'x');
  gt.setRepoToken('alice', 'gitee', 'k', 'r', 'y');
  const repos = gt.listRepos('alice').sort((a, b) => a.repo.localeCompare(b.repo));
  assert.deepStrictEqual(repos, [
    { provider: 'github', owner: 'kkrazy', repo: 'myco' },
    { provider: 'gitee', owner: 'k', repo: 'r' },
  ]);
});

// ─── git-hosts.js detectHost ────────────────────────────────────────────────

async function makeRepoWithRemote(remoteUrl) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'myco-td4-repo-'));
  const run = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  run('init', '-q', '-b', 'main');
  run('remote', 'add', 'origin', remoteUrl);
  return root;
}

t('detectHost: github SSH form', async () => {
  freshStateDir();
  const gh = require('../server/src/git-hosts');
  const root = await makeRepoWithRemote('git@github.com:kkrazy/myco.git');
  assert.deepStrictEqual(await gh.detectHost(root), { provider: 'github', owner: 'kkrazy', repo: 'myco' });
});

t('detectHost: github HTTPS form (no .git suffix)', async () => {
  freshStateDir();
  const gh = require('../server/src/git-hosts');
  const root = await makeRepoWithRemote('https://github.com/kkrazy/myco');
  assert.deepStrictEqual(await gh.detectHost(root), { provider: 'github', owner: 'kkrazy', repo: 'myco' });
});

t('detectHost: gitee SSH form', async () => {
  freshStateDir();
  const gh = require('../server/src/git-hosts');
  const root = await makeRepoWithRemote('git@gitee.com:user-org/cool-repo.git');
  assert.deepStrictEqual(await gh.detectHost(root), { provider: 'gitee', owner: 'user-org', repo: 'cool-repo' });
});

t('detectHost: gitee HTTPS form', async () => {
  freshStateDir();
  const gh = require('../server/src/git-hosts');
  const root = await makeRepoWithRemote('https://gitee.com/user-org/cool-repo.git');
  assert.deepStrictEqual(await gh.detectHost(root), { provider: 'gitee', owner: 'user-org', repo: 'cool-repo' });
});

t('detectHost: returns null for unknown host (bitbucket)', async () => {
  freshStateDir();
  const gh = require('../server/src/git-hosts');
  const root = await makeRepoWithRemote('git@bitbucket.org:team/repo.git');
  assert.strictEqual(await gh.detectHost(root), null);
});

t('detectHost: returns null for non-git dir', async () => {
  freshStateDir();
  const gh = require('../server/src/git-hosts');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'myco-td4-nogit-'));
  assert.strictEqual(await gh.detectHost(root), null);
});

// ─── git-hosts.js createIssue dispatch ──────────────────────────────────────

function captureFetcher({ status, body }) {
  const calls = [];
  const fetcher = async (req) => { calls.push(req); return { status, body }; };
  fetcher.calls = calls;
  return fetcher;
}

t('createIssue: github uses JSON + Authorization header + /repos/{o}/{r}/issues', async () => {
  freshStateDir();
  const gh = require('../server/src/git-hosts');
  const fetcher = captureFetcher({ status: 201, body: { number: 42, html_url: 'https://github.com/x/y/issues/42' } });
  const r = await gh.createIssue({
    provider: 'github', token: 'gh_test', owner: 'x', repo: 'y',
    title: 't', body: 'b', labels: ['enhancement'],
    httpsJson: fetcher,
  });
  assert.deepStrictEqual(r, { number: 42, url: 'https://github.com/x/y/issues/42' });
  const req = fetcher.calls[0];
  assert.strictEqual(req.hostname, 'api.github.com');
  assert.strictEqual(req.path, '/repos/x/y/issues');
  assert.strictEqual(req.headers.Authorization, 'token gh_test');
  assert.deepStrictEqual(req.body.labels, ['enhancement']);
});

t('createIssue: gitee uses form-urlencoded + access_token field + /repos/{o}/issues (repo in body)', async () => {
  freshStateDir();
  const gh = require('../server/src/git-hosts');
  const fetcher = captureFetcher({ status: 201, body: { number: 7, html_url: 'https://gitee.com/x/y/issues/7' } });
  const r = await gh.createIssue({
    provider: 'gitee', token: 'gt_test', owner: 'x', repo: 'y',
    title: 'gitee title', body: 'gitee body', labels: ['enhancement', 'help wanted'],
    httpsJson: fetcher,
  });
  assert.deepStrictEqual(r, { number: 7, url: 'https://gitee.com/x/y/issues/7' });
  const req = fetcher.calls[0];
  assert.strictEqual(req.hostname, 'gitee.com');
  assert.strictEqual(req.path, '/api/v5/repos/x/issues');
  assert.strictEqual(req.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.ok(!req.headers.Authorization, 'gitee should not use Authorization header');
  const form = new URLSearchParams(req.body);
  assert.strictEqual(form.get('access_token'), 'gt_test');
  assert.strictEqual(form.get('repo'), 'y');
  assert.strictEqual(form.get('title'), 'gitee title');
  assert.strictEqual(form.get('labels'), 'enhancement,help wanted');
});

t('createIssue: surfaces error message on non-2xx', async () => {
  freshStateDir();
  const gh = require('../server/src/git-hosts');
  const fetcher = captureFetcher({ status: 422, body: { message: 'Validation failed' } });
  const r = await gh.createIssue({
    provider: 'github', token: 'x', owner: 'o', repo: 'r',
    title: 't', body: 'b', labels: [],
    httpsJson: fetcher,
  });
  assert.strictEqual(r.status, 422);
  assert.ok(/Validation failed/.test(r.error));
});

t('createIssue: rejects unknown provider', async () => {
  freshStateDir();
  const gh = require('../server/src/git-hosts');
  const r = await gh.createIssue({ provider: 'bitbucket', token: 'x', owner: 'o', repo: 'r', title: 't', body: 'b' });
  assert.ok(/unknown provider/i.test(r.error));
});

// ─── git-hosts.js fetchUser ─────────────────────────────────────────────────

t('fetchUser: github uses Authorization header + /user', async () => {
  freshStateDir();
  const gh = require('../server/src/git-hosts');
  const fetcher = captureFetcher({ status: 200, body: { login: 'alice', id: 1, name: 'Alice' } });
  const user = await gh.fetchUser({ provider: 'github', token: 'gh_test', httpsJson: fetcher });
  assert.strictEqual(user.login, 'alice');
  assert.strictEqual(fetcher.calls[0].headers.Authorization, 'token gh_test');
  assert.strictEqual(fetcher.calls[0].path, '/user');
});

t('fetchUser: gitee uses access_token query param', async () => {
  freshStateDir();
  const gh = require('../server/src/git-hosts');
  const fetcher = captureFetcher({ status: 200, body: { login: 'gitee-alice', id: 99 } });
  const user = await gh.fetchUser({ provider: 'gitee', token: 'gt_test', httpsJson: fetcher });
  assert.strictEqual(user.login, 'gitee-alice');
  assert.ok(fetcher.calls[0].path.startsWith('/api/v5/user?access_token=gt_test'));
});

t('fetchUser: throws on non-2xx with API message', async () => {
  freshStateDir();
  const gh = require('../server/src/git-hosts');
  const fetcher = captureFetcher({ status: 401, body: { message: 'Bad credentials' } });
  await assert.rejects(
    () => gh.fetchUser({ provider: 'github', token: 'bad', httpsJson: fetcher }),
    /Bad credentials/,
  );
});

// ─── github.js back-compat shim ─────────────────────────────────────────────

t('github.js back-compat: setToken lands at user-level (no slash), retrievable via getToken without repo args', () => {
  freshStateDir();
  const github = require('../server/src/github');
  const gt = require('../server/src/git-tokens');
  github.setToken('alice', 'gh_shim_token');
  assert.strictEqual(github.getToken('alice'), 'gh_shim_token');
  // And the per-repo lookup falls back through the user-level slot.
  assert.strictEqual(gt.getToken('alice', 'github', 'any', 'repo'), 'gh_shim_token');
});

t('github.js back-compat: detectRepo returns null for gitee remotes', async () => {
  freshStateDir();
  const github = require('../server/src/github');
  const root = await makeRepoWithRemote('git@gitee.com:user/repo.git');
  // Old contract: github.detectRepo returns null for non-github hosts.
  // Callers that haven't been refactored must not silently fire github
  // calls at gitee URLs.
  assert.strictEqual(await github.detectRepo(root), null);
});

t('github.js back-compat: detectRepo still resolves github remotes', async () => {
  freshStateDir();
  const github = require('../server/src/github');
  const root = await makeRepoWithRemote('git@github.com:user/repo.git');
  assert.deepStrictEqual(await github.detectRepo(root), { owner: 'user', repo: 'repo' });
});

// ─── /setpat slash command ──────────────────────────────────────────────────

function makeCtx({ args, user = 'kkrazy', absCwd = process.cwd() }) {
  const replies = [];
  return {
    user, args, absCwd,
    reply: (text) => { replies.push(text); },
    _replies: replies,
  };
}

t('/setpat: rejects empty arg', async () => {
  freshStateDir();
  const sc = require('../server/src/slashcmds');
  const ctx = makeCtx({ args: '' });
  await sc.dispatch(ctx, '/setpat');
  assert.ok(/Usage:/.test(ctx._replies[0]), `got: ${ctx._replies[0]}`);
});

t('/setpat: rejects too-short token', async () => {
  freshStateDir();
  const sc = require('../server/src/slashcmds');
  const ctx = makeCtx({ args: 'abc' });
  await sc.dispatch(ctx, '/setpat abc');
  assert.ok(/too short/i.test(ctx._replies[0]), `got: ${ctx._replies[0]}`);
});

t('/setpat: errors when session cwd has no github/gitee remote', async () => {
  freshStateDir();
  const sc = require('../server/src/slashcmds');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'myco-td4-setpat-nogit-'));
  const ctx = makeCtx({ args: 'plausible-token-abc123', absCwd: root });
  await sc.dispatch(ctx, '/setpat plausible-token-abc123');
  assert.ok(/no github\.com or gitee\.com remote/i.test(ctx._replies[0]), `got: ${ctx._replies[0]}`);
});

t('/setpat: validates token, stores per-repo, confirms login in reply', async () => {
  freshStateDir();
  const root = await makeRepoWithRemote('git@gitee.com:somebody/cool.git');
  const gh = require('../server/src/git-hosts');
  const origFetchUser = gh.fetchUser;
  gh.fetchUser = async ({ provider, token }) => ({ login: `${provider}-bob`, id: 7 });
  try {
    const sc = require('../server/src/slashcmds');
    const ctx = makeCtx({ args: 'gitee_pat_abc123def', absCwd: root });
    await sc.dispatch(ctx, '/setpat gitee_pat_abc123def');
    const reply = ctx._replies[0];
    assert.ok(/Saved gitee PAT for somebody\/cool/.test(reply), `got: ${reply}`);
    assert.ok(/gitee:gitee-bob/.test(reply), `got: ${reply}`);
    // Token landed under the per-repo slot.
    const gt = require('../server/src/git-tokens');
    assert.strictEqual(gt.getToken('kkrazy', 'gitee', 'somebody', 'cool'), 'gitee_pat_abc123def');
  } finally {
    gh.fetchUser = origFetchUser;
  }
});

t('/setpat: rejects token if provider rejects it', async () => {
  freshStateDir();
  const root = await makeRepoWithRemote('git@github.com:k/r.git');
  const gh = require('../server/src/git-hosts');
  const orig = gh.fetchUser;
  gh.fetchUser = async () => { throw new Error('Bad credentials'); };
  try {
    const sc = require('../server/src/slashcmds');
    const ctx = makeCtx({ args: 'wrong_pat_value', absCwd: root });
    await sc.dispatch(ctx, '/setpat wrong_pat_value');
    assert.ok(/rejected the token/i.test(ctx._replies[0]), `got: ${ctx._replies[0]}`);
    // Nothing should have been stored.
    const gt = require('../server/src/git-tokens');
    assert.strictEqual(gt.getToken('kkrazy', 'github', 'k', 'r'), null);
  } finally {
    gh.fetchUser = orig;
  }
});

// ─── tally ──────────────────────────────────────────────────────────────────

t._chain.then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
});
