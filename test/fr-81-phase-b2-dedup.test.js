// fr-81 Phase B.2: dedup remote issues vs local plan items.
//
// Builds on Phase B.1's auto-promote (every successful /feature +
// /fr @target writes a local plan item carrying meta.remoteUrl=<url>).
// At Plan-view render time, remote-issues.getForSession scans the
// session's plan items for known remoteUrls + filters the upstream
// fetch to drop rows whose htmlUrl matches — so the user doesn't see
// the same issue twice (once as a local row, once in the Remote
// section below).
//
// The visible half of dedup is a 🔗 chip on each local item that
// carries meta.remoteUrl. Clicking opens the upstream issue in a
// new tab. Without the chip, dedup would silently hide remote rows
// + the user would have no way to navigate to upstream from the
// local row.
//
// Phase B.3 (close-detection mirror) + B.4 (write-back-on-close)
// still deferred — each dispatches separately.
//
// Test shape: static-grep across server/client + a unit-style
// invocation of the dedup filter against a stub plan.

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

console.log('── fr-81 Phase B.2: dedup remote issues vs local plan items ──');

// ── server: filter pass in remote-issues.js ──

t('server/src/remote-issues.js: _collectLinkedRemoteUrls helper exists and reads rec.artifacts.plan.items[].meta.remoteUrl', () => {
  const src = _read('server/src/remote-issues.js');
  assert.ok(/function\s+_collectLinkedRemoteUrls\s*\(/.test(src),
    '_collectLinkedRemoteUrls helper must be defined (Phase B.2 — collects local meta.remoteUrls for dedup).');
  const at = src.search(/function\s+_collectLinkedRemoteUrls\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/rec\.artifacts\.plan\.items/.test(body),
    '_collectLinkedRemoteUrls must read rec.artifacts.plan.items.');
  assert.ok(/meta\.remoteUrl/.test(body),
    '_collectLinkedRemoteUrls must look at meta.remoteUrl on each item (the anchor Phase B.1 sets).');
});

t('server/src/remote-issues.js: getForSession applies the dedup filter when linkedUrls is non-empty', () => {
  const src = _read('server/src/remote-issues.js');
  const at = src.search(/_collectLinkedRemoteUrls/);
  assert.ok(at > -1);
  // The filter call is in the body of getForSession before the
  // cache entry is built. Search for the linkedUrls.has filter pattern.
  assert.ok(/linkedUrls\.has\s*\(\s*it\.htmlUrl\s*\)/.test(src),
    'getForSession must filter `issuesOnly.filter(it => !linkedUrls.has(it.htmlUrl))` (dedup pass — Phase B.2).');
});

t('server/src/remote-issues.js: cached entry carries dedupedCount + linkedCount so the client can render a visible hint', () => {
  const src = _read('server/src/remote-issues.js');
  assert.ok(/dedupedCount\s*:/.test(src),
    'the cached entry must include dedupedCount (count of remote rows filtered out — Phase B.2).');
  assert.ok(/linkedCount\s*:/.test(src),
    'the cached entry must include linkedCount (total number of locally-linked remote URLs — Phase B.2).');
});

t('server/src/index.js: GET /sessions/:id/remote-issues forwards dedupedCount + linkedCount to the client', () => {
  const src = _read('server/src/index.js');
  const at = src.search(/app\.get\(\s*['"]\/sessions\/:id\/remote-issues['"]/);
  assert.ok(at > -1);
  const body = src.slice(at, at + 1500);
  assert.ok(/dedupedCount\s*:/.test(body),
    'GET /sessions/:id/remote-issues must forward dedupedCount on the response.');
  assert.ok(/linkedCount\s*:/.test(body),
    'GET /sessions/:id/remote-issues must forward linkedCount on the response.');
});

// ── server: dedup behavior end-to-end via the public API ──

(async () => {

await ta('remote-issues.js: dedup filters remote rows whose htmlUrl matches a local plan item meta.remoteUrl', async () => {
  const ri = require('../server/src/remote-issues');
  const gitHosts = require('../server/src/git-hosts');
  ri._resetCache();
  const orig = {
    detectHost: gitHosts.detectHost,
    fetchIssues: gitHosts.fetchIssues,
    getToken: gitHosts.getToken,
  };
  gitHosts.detectHost = async () => ({ provider: 'github', owner: 'o', repo: 'r' });
  gitHosts.getToken = () => 'fake-token';
  gitHosts.fetchIssues = async () => ({
    items: [
      { provider: 'github', number: 5, title: 'remote-issue A', htmlUrl: 'https://github.com/o/r/issues/5', isPullRequest: false },
      { provider: 'github', number: 7, title: 'remote-issue B', htmlUrl: 'https://github.com/o/r/issues/7', isPullRequest: false },
      { provider: 'github', number: 9, title: 'remote-issue C', htmlUrl: 'https://github.com/o/r/issues/9', isPullRequest: false },
    ],
    status: 200,
  });
  try {
    // rec has TWO local items linked to upstream issues #5 and #9.
    // Issue #7 has no local link.
    const rec = {
      id: 's-dedup',
      absCwd: '/tmp',
      artifacts: {
        plan: {
          items: [
            { id: 'fr-1', text: 'local A', meta: { remoteUrl: 'https://github.com/o/r/issues/5' } },
            { id: 'bug-1', text: 'local C', meta: { remoteUrl: 'https://github.com/o/r/issues/9' } },
            { id: 'td-1', text: 'plain local, no remote', meta: {} },
          ],
        },
      },
    };
    const r = await ri.getForSession(rec, { user: 'kkrazy' });
    assert.strictEqual(r.items.length, 1,
      'dedup must keep exactly the ONE remote row that has no local meta.remoteUrl match (issue #7).');
    assert.strictEqual(r.items[0].number, 7,
      'the surviving remote row must be issue #7 (the only one without a local link).');
    assert.strictEqual(r.dedupedCount, 2,
      'dedupedCount must report 2 (issues #5 + #9 folded into local rows).');
    assert.strictEqual(r.linkedCount, 2,
      'linkedCount must report 2 (the count of locally-linked remote URLs).');
  } finally {
    Object.assign(gitHosts, orig);
  }
});

await ta('remote-issues.js: no local meta.remoteUrl → dedup is a no-op (backward compat with pre-Phase-B.1 sessions)', async () => {
  const ri = require('../server/src/remote-issues');
  const gitHosts = require('../server/src/git-hosts');
  ri._resetCache();
  const orig = {
    detectHost: gitHosts.detectHost,
    fetchIssues: gitHosts.fetchIssues,
    getToken: gitHosts.getToken,
  };
  gitHosts.detectHost = async () => ({ provider: 'github', owner: 'o', repo: 'r' });
  gitHosts.getToken = () => 'fake-token';
  gitHosts.fetchIssues = async () => ({
    items: [
      { provider: 'github', number: 5, title: 'remote-issue A', htmlUrl: 'https://github.com/o/r/issues/5', isPullRequest: false },
      { provider: 'github', number: 7, title: 'remote-issue B', htmlUrl: 'https://github.com/o/r/issues/7', isPullRequest: false },
    ],
    status: 200,
  });
  try {
    // Legacy session: plan items have no meta.remoteUrl yet. Dedup
    // should be a no-op — both remote rows survive.
    const rec = {
      id: 's-no-dedup',
      absCwd: '/tmp',
      artifacts: { plan: { items: [{ id: 'fr-1', text: 'legacy' }] } },
    };
    const r = await ri.getForSession(rec, { user: 'kkrazy' });
    assert.strictEqual(r.items.length, 2, 'both remote rows must pass through when no local item carries meta.remoteUrl.');
    assert.strictEqual(r.dedupedCount, 0, 'dedupedCount must be 0 (no dedup happened).');
    assert.strictEqual(r.linkedCount, 0, 'linkedCount must be 0 (no locally-linked URLs).');
  } finally {
    Object.assign(gitHosts, orig);
  }
});

// ── client: 🔗 chip on local items + linked-suffix in the section header ──

t('web/public/app.js: local-item renderItem builds a remoteChip from it.meta.remoteUrl and slots it into .artifact-item-meta', () => {
  const app = _read('web/public/app.js');
  // The renderItem function body is ~15kB. Use a generous 20kB
  // window — the next function definition after renderItem closes
  // is well past that.
  const at = app.search(/const renderItem\s*=\s*\(it\)\s*=>/);
  assert.ok(at > -1, 'renderItem must exist.');
  const body = app.slice(at, at + 20000);
  assert.ok(/remoteChip/.test(body),
    'renderItem must build a remoteChip variable from it.meta.remoteUrl (Phase B.2 — the visible half of dedup).');
  assert.ok(/it\.meta[\s\S]{0,200}remoteUrl/.test(body),
    'renderItem must consult it.meta.remoteUrl to decide whether to show the chip.');
  assert.ok(/artifact-item-meta">\$\{statusChip\}\$\{idChip\}\$\{remoteChip\}/.test(body),
    'the .artifact-item-meta row must include ${remoteChip} alongside the existing statusChip + idChip slots.');
});

t('web/public/app.js: the remoteChip is an <a target="_blank"> link (so a tap opens upstream in a new tab without leaving myco)', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/const renderItem\s*=\s*\(it\)\s*=>/);
  const body = app.slice(at, at + 20000);
  assert.ok(/target="_blank"[\s\S]{0,200}rel="noopener noreferrer"/.test(body) ||
            /class="artifact-item-remote"[\s\S]{0,200}target="_blank"/.test(body),
    'the remoteChip <a> must use target="_blank" rel="noopener noreferrer" (security + UX — open upstream in a new tab without leaking opener).');
});

t('web/public/app.js: _loadAndRenderRemoteIssues surfaces "(N linked above)" suffix in the Remote-issues section header when data.linkedCount > 0', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/async\s+function\s+_loadAndRenderRemoteIssues\s*\(/);
  assert.ok(at > -1);
  const body = sliceFn(app, at);
  assert.ok(/linkedCount/.test(body),
    '_loadAndRenderRemoteIssues must read data.linkedCount to render the visible-dedup hint (Phase B.2).');
  assert.ok(/linked above/.test(body),
    "_loadAndRenderRemoteIssues must surface a 'linked above' suffix so the user can see dedup happened (Phase B.2).");
});

t('web/public/styles.css: .artifact-item-remote + .remote-issues-linked rules are defined', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/\.artifact-item-remote\s*\{/.test(css),
    '.artifact-item-remote CSS rule must exist (Phase B.2 — chip styling).');
  assert.ok(/\.remote-issues-linked\s*\{/.test(css),
    '.remote-issues-linked CSS rule must exist (Phase B.2 — linked-suffix styling).');
});

t('a comment naming "fr-81 Phase B.2" explains the dedup plumbing', () => {
  const files = [
    'server/src/remote-issues.js',
    'server/src/index.js',
    'web/public/app.js',
    'web/public/styles.css',
  ];
  let found = 0;
  for (const f of files) {
    if (/fr-81 Phase B\.2/.test(_read(f))) found++;
  }
  assert.ok(found >= 3,
    `at least 3 of the touched files must carry a "fr-81 Phase B.2" marker comment — found in ${found}.`);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

})();
