// Add a CodeHub remote target so `/fr @codehub` (and /bug, /td) file to
// the user's OWN CodeHub repo instead of GitHub.
//
// User report: "提交一个issue到代码仓... 应该是我本地登录的那个代码仓就往那个提交，
// 怎么去找github了 其他提bug等的命令同理". `/fr @myco` had routed to the
// hardcoded GitHub `kkrazy/myco` alias. Since `@myco` is a dedicated
// github-exclusive target, the fix adds a separate `@codehub` target
// (→ codehub `s00791175/myco-test`) AND CodeHub (GitLab v4) issue support
// in git-hosts.js, which previously only handled github + gitee and would
// have returned `unknown provider` for codehub.
//
// Implementation:
//   • slashcmds.js REMOTE_TARGETS gains `codehub: {provider:'codehub',
//     owner:'s00791175', repo:'myco-test'}`; `@myco` stays github.
//   • git-hosts.js gains `_createIssueCodehub` / `_fetchIssuesCodehub` /
//     `_closeIssueCodehub` (GitLab v4 API, PRIVATE-TOKEN header) and
//     codehub cases in the createIssue / fetchIssues / closeIssue
//     dispatchers.
//   • Provider-name labels generalized via _PROVIDER_LABEL so codehub
//     reads "CodeHub" in hints/errors.
//
// Static-shape guards (slashcmds) + httpsJson-injected behavior tests
// (git-hosts) — no live HTTP.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');
const gh = require('../server/src/git-hosts');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const SRC = _read('server/src/slashcmds.js');
const GIT = _read('server/src/git-hosts.js');

console.log('── fr-codehub-target: /fr /bug /td @codehub → codehub s00791175/myco-test ──');

// ── slashcmds: target registry + labels ───────────────────────────────

t('slashcmds.js: REMOTE_TARGETS defines @codehub → codehub s00791175/myco-test (and keeps @myco github)', () => {
  const idx = SRC.search(/const\s+REMOTE_TARGETS\s*=/);
  assert.ok(idx > -1, 'REMOTE_TARGETS must be declared');
  const win = SRC.slice(idx, idx + 900);
  assert.ok(/codehub\s*:\s*\{[^}]*provider\s*:\s*['"]codehub['"]/.test(win),
    '@codehub target must map to provider:codehub');
  assert.ok(/owner\s*:\s*['"]s00791175['"]/.test(win),
    '@codehub target owner must be s00791175');
  assert.ok(/repo\s*:\s*['"]myco-test['"]/.test(win),
    '@codehub target repo must be myco-test');
  // The dedicated github alias is untouched.
  assert.ok(/myco\s*:\s*\{[^}]*provider\s*:\s*['"]github['"]/.test(win),
    '@myco target must still map to provider:github (dedicated github alias preserved)');
});

t('slashcmds.js: _PROVIDER_LABEL maps codehub → CodeHub (label source of truth)', () => {
  const idx = SRC.search(/const\s+_PROVIDER_LABEL\s*=/);
  assert.ok(idx > -1, '_PROVIDER_LABEL map must be declared');
  const win = SRC.slice(idx, idx + 300);
  assert.ok(/codehub\s*:\s*['"]CodeHub['"]/.test(win),
    '_PROVIDER_LABEL must map codehub → "CodeHub"');
  assert.ok(/github\s*:\s*['"]GitHub['"]/.test(win) && /gitee\s*:\s*['"]Gitee['"]/.test(win),
    '_PROVIDER_LABEL must keep GitHub + Gitee labels');
});

t('slashcmds.js: handleRemoteIssue resolves provider labels via _PROVIDER_LABEL (codehub no longer mislabeled)', () => {
  const idx = SRC.search(/async\s+function\s+handleRemoteIssue\s*\(/);
  assert.ok(idx > -1, 'handleRemoteIssue must be defined');
  // The label usages sit ~150 lines into the function (token-missing +
  // error branches). Use the column-0 brace-walking helper so the window
  // always covers the whole body without a hand-picked N.
  const win = sliceFn(SRC, idx);
  // The token-missing label no longer uses the hardcoded github?:Gitee ternary.
  assert.ok(!/provider\s*===\s*['"]github['"]\s*\?\s*['"]GitHub['"]\s*:\s*['"]Gitee['"]/.test(win),
    'token-missing label must NOT use the github?:Gitee ternary (must route through _PROVIDER_LABEL)');
  assert.ok(/_PROVIDER_LABEL\[target\.provider\]/.test(win),
    'handleRemoteIssue must resolve the provider label via _PROVIDER_LABEL[target.provider]');
  // CodeHub guidance appears so a missing-codehub-token hints correctly.
  assert.ok(/CodeHub profile settings/.test(win),
    'handleRemoteIssue codehub guidance must mention "CodeHub profile settings"');
});

// ── git-hosts: codehub dispatchers exist + are wired ───────────────────

t('git-hosts.js: createIssue dispatch handles codehub (previously unknown provider)', () => {
  const idx = GIT.search(/async\s+function\s+createIssue\s*\(/);
  assert.ok(idx > -1, 'createIssue must be defined');
  const win = GIT.slice(idx, idx + 500);
  assert.ok(/provider\s*===\s*['"]codehub['"]\).*_createIssueCodehub/.test(win),
    'createIssue must dispatch codehub → _createIssueCodehub');
  assert.ok(/function\s+_createIssueCodehub\s*\(/.test(GIT),
    '_createIssueCodehub must be defined');
});

t('git-hosts.js: fetchIssues dispatch handles codehub', () => {
  const idx = GIT.search(/async\s+function\s+fetchIssues\s*\(/);
  assert.ok(idx > -1, 'fetchIssues must be defined');
  const win = GIT.slice(idx, idx + 500);
  assert.ok(/provider\s*===\s*['"]codehub['"]\).*_fetchIssuesCodehub/.test(win),
    'fetchIssues must dispatch codehub → _fetchIssuesCodehub');
  assert.ok(/function\s+_fetchIssuesCodehub\s*\(/.test(GIT),
    '_fetchIssuesCodehub must be defined');
});

t('git-hosts.js: closeIssue dispatch handles codehub', () => {
  const idx = GIT.search(/async\s+function\s+closeIssue\s*\(/);
  assert.ok(idx > -1, 'closeIssue must be defined');
  const win = GIT.slice(idx, idx + 500);
  assert.ok(/provider\s*===\s*['"]codehub['"]\).*_closeIssueCodehub/.test(win),
    'closeIssue must dispatch codehub → _closeIssueCodehub');
  assert.ok(/function\s+_closeIssueCodehub\s*\(/.test(GIT),
    '_closeIssueCodehub must be defined');
});

// ── git-hosts: codehub create / fetch / close behavior (httpsJson seam) ─

t('git-hosts.js: _createIssueCodehub POSTs GitLab v4 path + PRIVATE-TOKEN and maps {iid, web_url} → {number, url}', async () => {
  let captured = null;
  const result = await gh.createIssue({
    provider: 'codehub', token: 'tok123',
    owner: 's00791175', repo: 'myco-test',
    title: 'Add magic', body: 'Need magic\n', labels: ['enhancement'],
    httpsJson: (opts) => {
      captured = opts;
      return { status: 201, body: { iid: 42, web_url: 'https://codehub-dg-g.huawei.com/s00791175/myco-test/-/issues/42' } };
    },
  });
  assert.ok(captured, 'must invoke the injected httpsJson');
  assert.strictEqual(captured.hostname, 'codehub-dg-g.huawei.com', 'must target the codehub host');
  assert.strictEqual(captured.method, 'POST', 'must POST');
  assert.ok(/api\/v4\/projects\//.test(captured.path), 'must hit GitLab v4 /api/v4/projects/...');
  assert.ok(/s00791175%2Fmyco-test/.test(captured.path), 'owner/repo must be a single urlencoded segment (s00791175%2Fmyco-test)');
  assert.ok(/\/issues$/.test(captured.path), 'path must end in /issues');
  assert.strictEqual(captured.headers['PRIVATE-TOKEN'], 'tok123', 'must send PRIVATE-TOKEN header (codehub auth)');
  assert.strictEqual(captured.body.title, 'Add magic', 'body must carry the title');
  assert.strictEqual(captured.body.description, 'Need magic\n', 'body must carry description (not `body`)');
  assert.strictEqual(captured.body.labels, 'enhancement', 'labels must be a comma-separated string');
  assert.strictEqual(result.number, 42, 'must map iid → number');
  assert.strictEqual(result.url, 'https://codehub-dg-g.huawei.com/s00791175/myco-test/-/issues/42',
    'must map web_url → url from the API response');
  assert.strictEqual(result.error, undefined, 'must succeed');
});

t('git-hosts.js: _createIssueCodehub surfaces GitLab error message + status', async () => {
  const result = await gh.createIssue({
    provider: 'codehub', token: 't', owner: 'o', repo: 'r',
    httpsJson: () => ({ status: 401, body: { message: '401 Unauthorized' } }),
  });
  assert.ok(result.error && result.status === 401, 'must return {error, status} on failure');
  assert.match(result.error, /Unauthorized/, 'error must carry the GitLab message');
});

t('git-hosts.js: _fetchIssuesCodehub GETs GitLab v4 list and normalizes a row (iid→number, description→body)', async () => {
  let captured = null;
  const result = await gh.fetchIssues({
    provider: 'codehub', token: 't', owner: 's00791175', repo: 'myco-test', state: 'open',
    httpsJson: (opts) => {
      captured = opts;
      return {
        status: 200,
        body: [{
          iid: 7, title: 'Some issue', description: 'Body text', web_url: 'https://codehub/x',
          state: 'opened', author: { username: 's00791175' },
          created_at: '2026-01-01', updated_at: '2026-01-02', labels: ['bug', 'p1'],
        }],
      };
    },
  });
  assert.ok(captured && captured.method === 'GET', 'must GET');
  assert.ok(/state=opened/.test(captured.path), 'codehub "open" must map to GitLab "opened"');
  assert.strictEqual(result.error, undefined, 'no error expected');
  assert.strictEqual(result.items.length, 1, 'one normalized item');
  const it = result.items[0];
  assert.strictEqual(it.provider, 'codehub');
  assert.strictEqual(it.number, 7, 'iid → number');
  assert.strictEqual(it.body, 'Body text', 'description → body');
  assert.strictEqual(it.htmlUrl, 'https://codehub/x');
  assert.strictEqual(it.author, 's00791175', 'author.username → author');
  assert.deepStrictEqual(it.labels, ['bug', 'p1'], 'GitLab labels already a string array');
  assert.strictEqual(it.isPullRequest, false, 'issues vs MRs are separate GitLab APIs');
});

t('git-hosts.js: _closeIssueCodehub PUTs state_event:close (GitLab convention, not state)', async () => {
  let captured = null;
  const result = await gh.closeIssue({
    provider: 'codehub', token: 't', owner: 's00791175', repo: 'myco-test', number: 7,
    httpsJson: (opts) => {
      captured = opts;
      return { status: 200, body: { iid: 7, web_url: 'https://codehub/x' } };
    },
  });
  assert.ok(captured && captured.method === 'PUT', 'must PUT (GitLab close is a PUT)');
  assert.deepStrictEqual(captured.body, { state_event: 'close' },
    'GitLab closes via state_event:"close", not state:"closed" (github convention)');
  assert.ok(/\/issues\/7$/.test(captured.path), 'path must target /issues/<iid>');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.number, 7);
});

t('git-hosts.js: createIssue/fetchIssues/closeIssue still reject other unknown providers', async () => {
  for (const [fn, args] of [
    [gh.createIssue, { provider: 'bitbucket', token: 't', owner: 'o', repo: 'r' }],
    [gh.fetchIssues, { provider: 'bitbucket', token: 't', owner: 'o', repo: 'r' }],
    [gh.closeIssue, { provider: 'bitbucket', token: 't', owner: 'o', repo: 'r', number: 1 }],
  ]) {
    const r = await fn(args);
    assert.match(String(r.error || ''), /unknown provider/, 'unknown non-codehub provider must be rejected');
  }
});

// User report: `/fr @myco` in a codehub session failed with "(no GitHub
// token on file ... kkrazy/myco)" — @myco was a hardcoded github target,
// ignoring the session's own project. Fix: @myco now follows the current
// session project (detectHost) when it resolves to a known provider.
t('slashcmds.js: handleRemoteIssue lets @myco follow the current session project', () => {
  const idx = SRC.search(/async\s+function\s+handleRemoteIssue\s*\(/);
  assert.ok(idx > -1, 'handleRemoteIssue must be defined');
  const win = sliceFn(SRC, idx);
  assert.ok(/targetName\s*===\s*['"]myco['"]/.test(win),
    '@myco must branch on targetName === "myco"');
  assert.ok(/gitHosts\.detectHost\(ctx\.absCwd\)/.test(win),
    '@myco branch must detect the session project via gitHosts.detectHost(ctx.absCwd)');
  assert.ok(/host\.provider/.test(win) && /target\s*=\s*\{\s*\.\.\.target/.test(win),
    'must override the fixed target with the detected host (spread target)');
});

// The Plan-view remote-issues header must read "CodeHub"/"Gitee"/"GitHub"
// per the project that was detected, not a hardcoded github default.
t('app.js: remote-issues labels route through _remoteProviderLabel (auto codehub/gitee/github)', () => {
  const APP = _read('web/public/app.js');
  const secIdx = APP.search(/function\s+_loadAndRenderRemoteIssues\s*\(/);
  assert.ok(secIdx > -1, 'must find _loadAndRenderRemoteIssues');
  const sec = sliceFn(APP, secIdx);
  assert.ok(/_remoteProviderLabel\(data\.provider\)/.test(sec),
    'no-token branch must label via _remoteProviderLabel(data.provider)');
  assert.ok(/_remoteProviderLabel\(data\s*&&\s*data\.provider\)/.test(sec),
    'main branch must label via _remoteProviderLabel(data && data.provider)');
  // plan-item remote link title (rendered beside each linked local item)
  assert.ok(/_remoteProviderLabel\(it\.meta\s*&&\s*it\.meta\.remoteProvider\)/.test(APP),
    'plan-item remote title must label via _remoteProviderLabel(it.meta.remoteProvider)');
  // No hardcoded gitee?:GitHub ternary may survive in the render path.
  assert.ok(!/provider\s*===\s*['"]gitee['"]\s*\?\s*['"]Gitee['"]\s*:\s*['"]GitHub['"]/.test(APP),
    'must not keep a hardcoded provider===gitee ? Gitee : GitHub ternary');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
