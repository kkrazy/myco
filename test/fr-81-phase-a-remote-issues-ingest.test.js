// fr-81 Phase A: ingest open GitHub / Gitee issues into the Plan view.
//
// User-reported (verbatim, from the fr-81 plan item — Gemini's
// critique pointed out that earlier diffs in this session shipped
// fr-94 Phase 3 (async clone) which is a PREREQUISITE for ingest but
// not the ingest itself):
//   Problem:  Plan view cannot ingest issues from remote git-
//             compatible repositories, so users can't see remote work
//             alongside local plan items.
//   Expected: Plan view pulls issues from GitHub, Gitee, or any git-
//             compatible repository and displays them with a "remote"
//             indicator.
//   Actual:   Plan view only shows local plan items; remote issues
//             are not fetched or displayed.
//
// Phase A scope (this commit):
//   1. server/src/git-hosts.js — adds fetchIssues({provider, token,
//      owner, repo, state, perPage, maxPages}) reusing the existing
//      _httpsJson + provider-strategy pattern. Normalizes GitHub +
//      Gitee responses to one shape. GitHub PRs (which surface in
//      /repos/.../issues) are flagged via isPullRequest=true so the
//      Plan view can filter them out.
//   2. server/src/remote-issues.js (NEW) — getForSession(rec) +
//      in-memory cache (CACHE_TTL_MS = 5 min) + stale-while-
//      revalidate. Token resolution via gitHosts.getToken (per-repo
//      PAT > user-level OAuth). PR rows are stripped before caching.
//   3. server/src/index.js — GET /sessions/:id/remote-issues route
//      (auth-gated via fileApiPreamble 'viewer'). ?force=1 forces a
//      fresh upstream fetch.
//   4. web/public/app.js — _loadAndRenderRemoteIssues(sid) fetches +
//      renders into #remote-issues-section at the bottom of the
//      Plan view. Three render entry points (loadArtifact cached,
//      loadArtifact HTTP, refreshArtifact) call it for type='plan'.
//   5. web/public/styles.css — .remote-issues-section visually
//      separated from local plan items by a border-top.
//
// Phase B (deferred per the run-summary): dedup vs locally-filed
// issues (needs a promotion model — /feature today doesn't stamp
// meta.remoteUrl on a local item), close-detection mirror (closed
// upstream → local item marked done), write-back-on-close (Plan-
// view close → also close the remote issue).
//
// Test shape: static-grep + a couple of unit invocations using the
// injected httpsJson test seam.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── fr-81 Phase A: remote issues ingest into Plan view ──');

// ── git-hosts.fetchIssues: GitHub branch ──

(async () => {

await ta('git-hosts.fetchIssues — GitHub: parses /repos/<o>/<r>/issues response into normalized rows + flags PRs', async () => {
  const gh = require('../server/src/git-hosts');
  const fakeHttps = async ({ hostname, path: p }) => {
    assert.strictEqual(hostname, 'api.github.com');
    assert.ok(p.startsWith('/repos/o/r/issues'), 'GitHub fetch must hit /repos/<owner>/<repo>/issues — got ' + p);
    assert.ok(/per_page=/.test(p), 'GitHub fetch must include per_page=');
    if (/page=1\b/.test(p)) {
      return { status: 200, body: [
        { number: 5, title: 'bug X', body: 'b', html_url: 'https://github.com/o/r/issues/5', state: 'open', user: { login: 'alice' }, created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T01:00:00Z', labels: [{ name: 'bug' }] },
        { number: 6, title: 'PR Y', body: '', html_url: 'https://github.com/o/r/issues/6', state: 'open', user: { login: 'bob' }, created_at: 'x', updated_at: 'y', labels: [], pull_request: {} },
      ], headers: {} };
    }
    return { status: 200, body: [], headers: {} };
  };
  const r = await gh.fetchIssues({ provider: 'github', token: 't', owner: 'o', repo: 'r', state: 'open', httpsJson: fakeHttps });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.items[0].provider, 'github');
  assert.strictEqual(r.items[0].number, 5);
  assert.deepStrictEqual(r.items[0].labels, ['bug']);
  assert.strictEqual(r.items[0].isPullRequest, false);
  assert.strictEqual(r.items[1].isPullRequest, true,
    'GitHub PRs surface in /issues — fetchIssues must flag them via isPullRequest so the Plan view can hide them.');
});

await ta('git-hosts.fetchIssues — Gitee: hits /api/v5/repos/<o>/issues with access_token + maps state', async () => {
  const gh = require('../server/src/git-hosts');
  let pathSeen = '';
  const fakeHttps = async ({ hostname, path: p }) => {
    assert.strictEqual(hostname, 'gitee.com');
    pathSeen = p;
    return { status: 200, body: [
      { number: 12, title: 'gitee thing', body: 'b', html_url: 'https://gitee.com/o/r/issues/I0', state: 'open', user: { login: 'cathy' }, created_at: 'x', updated_at: 'y', labels: ['feature'] },
    ], headers: {} };
  };
  const r = await gh.fetchIssues({ provider: 'gitee', token: 't', owner: 'o', repo: 'r', state: 'open', httpsJson: fakeHttps });
  // Gitee READ endpoint includes the repo in the path; POST /issues
  // (createIssue, in git-hosts._createIssueGitee) is the odd one out
  // — it takes owner in path + repo in form body.
  assert.ok(/^\/api\/v5\/repos\/o\/r\/issues/.test(pathSeen),
    'Gitee fetch must hit /api/v5/repos/<owner>/<repo>/issues — got ' + pathSeen);
  assert.ok(/access_token=t/.test(pathSeen),
    'Gitee fetch must pass access_token=<token> in the query string (Gitee API convention).');
  assert.ok(/state=open%2Cprogressing/.test(pathSeen),
    "Gitee fetch must map state='open' to 'open,progressing' so work-in-progress issues are included.");
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].provider, 'gitee');
  assert.strictEqual(r.items[0].isPullRequest, false,
    'Gitee issues + PRs are separate APIs; isPullRequest must always be false here.');
});

// ── remote-issues.js: cache + stale-while-revalidate ──

t('remote-issues.js exists and exports getForSession + CACHE_TTL_MS + MAX_ITEMS_PER_SESSION', () => {
  const ri = require('../server/src/remote-issues');
  assert.strictEqual(typeof ri.getForSession, 'function',
    'remote-issues.js must export getForSession as the public entry point (fr-81 Phase A).');
  assert.strictEqual(typeof ri.CACHE_TTL_MS, 'number',
    'remote-issues.js must export CACHE_TTL_MS so tests + diagnostics know the staleness window.');
  assert.ok(ri.CACHE_TTL_MS >= 60_000 && ri.CACHE_TTL_MS <= 30 * 60_000,
    `CACHE_TTL_MS must be a reasonable window (1–30 min) — got ${ri.CACHE_TTL_MS}ms.`);
  assert.strictEqual(typeof ri.MAX_ITEMS_PER_SESSION, 'number',
    'remote-issues.js must cap items per session so a huge monorepo cannot OOM the Plan view.');
});

t('remote-issues.js: getForSession with rec.absCwd=null returns a safe no-project-root error', async () => {
  const ri = require('../server/src/remote-issues');
  ri._resetCache && ri._resetCache();
  const r = await ri.getForSession({ id: 'test-1', absCwd: null }, { user: 'kkrazy' });
  // Empty + error string — caller can render a quiet skip.
  assert.deepStrictEqual(r.items, []);
  assert.ok(r.error,
    'getForSession must surface an error string when no project root is resolvable (fr-81 Phase A — clients render a quiet skip for projects without a remote).');
});

// ── remote-issues.js: cache flow (cold / warm / stale / force / cap / PR-filter / no-token) ──
//
// These tests monkey-patch the three gitHosts entry points the cache
// module calls (detectHost, fetchIssues, getToken). The originals are
// restored at the end of each block. (Phase A r1 critique response —
// the original commit only tested the no-project-root branch; the
// rest of the cache contract was unverified.)

async function withPatchedGitHosts(patch, fn) {
  const gitHosts = require('../server/src/git-hosts');
  const orig = {
    detectHost: gitHosts.detectHost,
    fetchIssues: gitHosts.fetchIssues,
    getToken: gitHosts.getToken,
  };
  Object.assign(gitHosts, patch);
  try { await fn(); }
  finally { Object.assign(gitHosts, orig); }
}

await ta('remote-issues.js: cold cache blocks on fetch and returns items', async () => {
  const ri = require('../server/src/remote-issues');
  ri._resetCache();
  let fetchCount = 0;
  await withPatchedGitHosts({
    detectHost: async () => ({ provider: 'github', owner: 'o', repo: 'r' }),
    getToken: () => 'fake-token',
    fetchIssues: async () => { fetchCount++; return { items: [{ provider: 'github', number: 1, title: 't', isPullRequest: false }], status: 200 }; },
  }, async () => {
    const r = await ri.getForSession({ id: 's-cold', absCwd: '/tmp' }, { user: 'kkrazy' });
    assert.strictEqual(fetchCount, 1, 'cold cache must call fetchIssues exactly once.');
    assert.strictEqual(r.items.length, 1);
    assert.strictEqual(r.error, null);
    assert.strictEqual(r.stale, false, 'cold cache result is fresh, not stale.');
  });
});

await ta('remote-issues.js: warm cache (within TTL) returns cached without re-fetching', async () => {
  const ri = require('../server/src/remote-issues');
  ri._resetCache();
  let fetchCount = 0;
  await withPatchedGitHosts({
    detectHost: async () => ({ provider: 'github', owner: 'o', repo: 'r' }),
    getToken: () => 'fake-token',
    fetchIssues: async () => { fetchCount++; return { items: [{ provider: 'github', number: 1, title: 't', isPullRequest: false }], status: 200 }; },
  }, async () => {
    await ri.getForSession({ id: 's-warm', absCwd: '/tmp' }, { user: 'kkrazy' });
    const r = await ri.getForSession({ id: 's-warm', absCwd: '/tmp' }, { user: 'kkrazy' });
    assert.strictEqual(fetchCount, 1, 'warm cache (within TTL) must NOT re-fetch.');
    assert.strictEqual(r.stale, false, 'warm cache result is still fresh.');
    assert.strictEqual(r.items.length, 1);
  });
});

await ta('remote-issues.js: force=true bypasses cache and waits for fresh fetch', async () => {
  const ri = require('../server/src/remote-issues');
  ri._resetCache();
  let fetchCount = 0;
  await withPatchedGitHosts({
    detectHost: async () => ({ provider: 'github', owner: 'o', repo: 'r' }),
    getToken: () => 'fake-token',
    fetchIssues: async () => {
      fetchCount++;
      return { items: [{ provider: 'github', number: fetchCount, title: 't' + fetchCount, isPullRequest: false }], status: 200 };
    },
  }, async () => {
    await ri.getForSession({ id: 's-force', absCwd: '/tmp' }, { user: 'kkrazy' });
    assert.strictEqual(fetchCount, 1);
    const r = await ri.getForSession({ id: 's-force', absCwd: '/tmp' }, { user: 'kkrazy', force: true });
    assert.strictEqual(fetchCount, 2, 'force=true must skip the cache and call fetchIssues again.');
    assert.strictEqual(r.items[0].number, 2, 'force=true must return the fresh items, not the stale cached ones.');
    assert.strictEqual(r.stale, false);
  });
});

await ta('remote-issues.js: PR rows (isPullRequest=true) are filtered out before caching', async () => {
  const ri = require('../server/src/remote-issues');
  ri._resetCache();
  await withPatchedGitHosts({
    detectHost: async () => ({ provider: 'github', owner: 'o', repo: 'r' }),
    getToken: () => 'fake-token',
    fetchIssues: async () => ({
      items: [
        { provider: 'github', number: 1, title: 'real issue', isPullRequest: false },
        { provider: 'github', number: 2, title: 'a PR', isPullRequest: true },
        { provider: 'github', number: 3, title: 'another issue', isPullRequest: false },
      ],
      status: 200,
    }),
  }, async () => {
    const r = await ri.getForSession({ id: 's-pr', absCwd: '/tmp' }, { user: 'kkrazy' });
    assert.strictEqual(r.items.length, 2,
      'PR rows must be filtered out of the cached set (Phase A spec — Plan view shows only issues).');
    assert.ok(r.items.every((it) => !it.isPullRequest),
      'no PR rows must survive the filter pass.');
  });
});

await ta('remote-issues.js: MAX_ITEMS_PER_SESSION caps the cached array', async () => {
  const ri = require('../server/src/remote-issues');
  ri._resetCache();
  const huge = [];
  for (let i = 0; i < ri.MAX_ITEMS_PER_SESSION + 200; i++) {
    huge.push({ provider: 'github', number: i + 1, title: 't' + i, isPullRequest: false });
  }
  await withPatchedGitHosts({
    detectHost: async () => ({ provider: 'github', owner: 'o', repo: 'r' }),
    getToken: () => 'fake-token',
    fetchIssues: async () => ({ items: huge, status: 200 }),
  }, async () => {
    const r = await ri.getForSession({ id: 's-cap', absCwd: '/tmp' }, { user: 'kkrazy' });
    assert.strictEqual(r.items.length, ri.MAX_ITEMS_PER_SESSION,
      `MAX_ITEMS_PER_SESSION=${ri.MAX_ITEMS_PER_SESSION} must cap the cached array so a huge monorepo cannot OOM the Plan view.`);
  });
});

await ta('remote-issues.js: no-token branch returns error="no-token" without calling fetchIssues', async () => {
  const ri = require('../server/src/remote-issues');
  ri._resetCache();
  let fetchCount = 0;
  await withPatchedGitHosts({
    detectHost: async () => ({ provider: 'github', owner: 'o', repo: 'r' }),
    getToken: () => null,    // ← key: no token on file
    fetchIssues: async () => { fetchCount++; return { items: [], status: 200 }; },
  }, async () => {
    const r = await ri.getForSession({ id: 's-no-token', absCwd: '/tmp' }, { user: 'kkrazy' });
    assert.strictEqual(r.error, 'no-token',
      'no token → error="no-token" so the client can render a "Sign in / /setpat" hint.');
    assert.strictEqual(fetchCount, 0,
      'no-token branch must short-circuit BEFORE calling fetchIssues (no point making an unauthenticated request).');
  });
});

// ── server route ──

t('server/src/index.js: GET /sessions/:id/remote-issues route is registered and delegates to remote-issues.getForSession', () => {
  const src = _read('server/src/index.js');
  assert.ok(/app\.get\(\s*['"]\/sessions\/:id\/remote-issues['"]/.test(src),
    'GET /sessions/:id/remote-issues route must be registered in index.js (fr-81 Phase A).');
  // The handler body must require ./remote-issues and call getForSession.
  const at = src.search(/app\.get\(\s*['"]\/sessions\/:id\/remote-issues['"]/);
  const body = src.slice(at, at + 1500);
  assert.ok(/require\s*\(\s*['"]\.\/remote-issues['"]\s*\)/.test(body),
    'GET /sessions/:id/remote-issues handler must require(./remote-issues) (fr-81 Phase A).');
  assert.ok(/getForSession\s*\(/.test(body),
    'GET /sessions/:id/remote-issues handler must call remoteIssues.getForSession(...) (fr-81 Phase A).');
  // Defense: must be auth-gated via fileApiPreamble.
  assert.ok(/fileApiPreamble\s*\(\s*req\s*,\s*res\s*,\s*['"]viewer['"]/.test(body),
    'GET /sessions/:id/remote-issues must use fileApiPreamble(req, res, "viewer") so unauthenticated clients are rejected (fr-81 Phase A).');
});

// ── client wiring ──

t('web/public/app.js: _loadAndRenderRemoteIssues exists and fetches /remote-issues for the Plan view', () => {
  const app = _read('web/public/app.js');
  assert.ok(/async\s+function\s+_loadAndRenderRemoteIssues\s*\(/.test(app),
    '_loadAndRenderRemoteIssues must be defined in app.js (fr-81 Phase A — client-side render of the remote-issues section).');
  // The helper must fetch the new server route.
  const at = app.search(/async\s+function\s+_loadAndRenderRemoteIssues\s*\(/);
  const body = sliceFn(app, at);
  assert.ok(/\/sessions\/\$\{[^}]+\}\/remote-issues/.test(body),
    "_loadAndRenderRemoteIssues must GET /sessions/<sid>/remote-issues (fr-81 Phase A).");
  // It must render into #remote-issues-section.
  assert.ok(/remote-issues-section/.test(body),
    '_loadAndRenderRemoteIssues must render into #remote-issues-section (fr-81 Phase A).');
});

t('web/public/app.js: the Plan render entry points call _loadAndRenderRemoteIssues', () => {
  const app = _read('web/public/app.js');
  // Each renderArtifact("plan", ...) site that's part of an entry
  // point (loadArtifact cached, loadArtifact HTTP fallback,
  // refreshArtifact) must call _loadAndRenderRemoteIssues. The call
  // count proxy: at least 3 occurrences of the helper name in app.js
  // (1 definition + 3 callsites = 4 total).
  const hits = (app.match(/_loadAndRenderRemoteIssues/g) || []).length;
  assert.ok(hits >= 4,
    `_loadAndRenderRemoteIssues must be called from the three plan render entry points (loadArtifact cached, loadArtifact HTTP, refreshArtifact) — found ${hits} references total (need >= 4: 1 defn + 3 calls).`);
});

t('web/public/app.js r1: refreshArtifact passes force:true so the Refresh button actually bypasses the cache', () => {
  // Phase A r1 critique response: the original commit's wiring called
  // _loadAndRenderRemoteIssues(sid) from refreshArtifact without a
  // force flag, so the server's stale-while-revalidate returned the
  // cached snapshot — the Refresh button looked like a no-op for
  // up to 5 min. The helper now accepts opts.force and appends
  // ?force=1 to the URL when set.
  const app = _read('web/public/app.js');
  const at = app.search(/async\s+function\s+_loadAndRenderRemoteIssues\s*\(/);
  assert.ok(at > -1, '_loadAndRenderRemoteIssues must exist.');
  const helperBody = sliceFn(app, at);
  assert.ok(/\?force=1/.test(helperBody),
    '_loadAndRenderRemoteIssues must append ?force=1 to the fetch URL when force is set (Phase A r1).');
  // And refreshArtifact must pass {force: true}.
  const refreshAt = app.search(/async\s+function\s+refreshArtifact\s*\(/);
  if (refreshAt > -1) {
    const refreshBody = sliceFn(app, refreshAt);
    assert.ok(/_loadAndRenderRemoteIssues\s*\(\s*sid\s*,\s*\{\s*force\s*:\s*true\s*\}/.test(refreshBody),
      'refreshArtifact must call _loadAndRenderRemoteIssues(sid, { force: true }) so the Refresh button does what its label promises (Phase A r1).');
  }
});

t('web/public/styles.css: .remote-issues-section + a row class are defined', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/\.remote-issues-section\s*\{/.test(css),
    '.remote-issues-section CSS rule must exist (fr-81 Phase A — visual separation from local plan items).');
  assert.ok(/\.remote-issue-row\s*\{/.test(css),
    '.remote-issue-row CSS rule must exist (fr-81 Phase A — each remote issue is rendered as one row).');
});

t('a comment naming "fr-81 Phase A" explains the ingest plumbing', () => {
  const files = [
    'server/src/git-hosts.js',
    'server/src/remote-issues.js',
    'server/src/index.js',
    'web/public/app.js',
    'web/public/styles.css',
  ];
  let found = 0;
  for (const f of files) {
    if (/fr-81 Phase A/.test(_read(f))) found++;
  }
  assert.ok(found >= 3,
    `at least 3 of the touched files must carry a "fr-81 Phase A" marker comment — found in ${found}.`);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

})();
