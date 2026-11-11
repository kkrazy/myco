// fr-81 Phase B.4: write-back on local close — when the user marks a
// local plan item done AND the item carries meta.remoteUrl (set by
// Phase B.1's auto-promote), also close the upstream GitHub/Gitee
// issue.
//
// Completes the Phase B closure loop:
//   · B.1: /feature & /fr @target auto-create local rows with
//     meta.remoteUrl.
//   · B.2: Plan view dedupes remote rows that have a local link.
//   · B.3: upstream-closed → local-done mirror.
//   · B.4: local-done → upstream-close write-back.   ← THIS COMMIT
//
// Skip rules (the four guards on the write-back call):
//   · done flipped the OTHER direction (uncheck) → skip.
//   · item.meta.closedUpstreamAt already set → skip (idempotency).
//   · item.meta.closedRemotely is true → skip (Phase B.3 mirror
//     already closed it on behalf of upstream; no need to re-fire).
//   · no token on file for the user/provider/repo → skip with a log.
//
// Best-effort: a write-back failure logs but doesn't block the HTTP
// response. The local close already happened.

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

console.log('── fr-81 Phase B.4: write-back on local close ──');

(async () => {

// ── 1. git-hosts.closeIssue: GitHub PATCH + Gitee PATCH ──

t('server/src/git-hosts.js: closeIssue is defined + dispatched in module.exports', () => {
  const src = _read('server/src/git-hosts.js');
  assert.ok(/async\s+function\s+closeIssue\s*\(/.test(src),
    'closeIssue must be defined (Phase B.4).');
  assert.ok(/module\.exports\s*=\s*\{[\s\S]*?\bcloseIssue\b/.test(src),
    'closeIssue must be exported from git-hosts.js.');
});

t('server/src/git-hosts.js: _closeIssueGithub uses PATCH /repos/<o>/<r>/issues/<N> with body {state: "closed"}', () => {
  const src = _read('server/src/git-hosts.js');
  const at = src.search(/async\s+function\s+_closeIssueGithub\s*\(/);
  assert.ok(at > -1, '_closeIssueGithub must exist.');
  const body = sliceFn(src, at);
  assert.ok(/method\s*:\s*['"]PATCH['"]/.test(body),
    'GitHub close must use HTTP PATCH (REST convention).');
  assert.ok(/\/repos\/\$\{[^}]+\}\/\$\{[^}]+\}\/issues\/\$\{[^}]+\}/.test(body),
    'GitHub close path must be /repos/<owner>/<repo>/issues/<number>.');
  assert.ok(/state\s*:\s*['"]closed['"]/.test(body),
    'GitHub close body must include {state: "closed"}.');
});

t('server/src/git-hosts.js: _closeIssueGitee uses PATCH /api/v5/repos/<owner>/issues/<N> (owner-only path; repo in form body)', () => {
  const src = _read('server/src/git-hosts.js');
  const at = src.search(/async\s+function\s+_closeIssueGitee\s*\(/);
  assert.ok(at > -1);
  const body = sliceFn(src, at);
  assert.ok(/method\s*:\s*['"]PATCH['"]/.test(body),
    'Gitee close must use HTTP PATCH.');
  assert.ok(/\/api\/v5\/repos\/\$\{[^}]+\}\/issues\/\$\{[^}]+\}/.test(body),
    'Gitee close path must be /api/v5/repos/<owner>/issues/<number> (mirrors the createIssueGitee quirk: owner in path, repo in form body).');
  assert.ok(/state.*=.*closed|set\s*\(\s*['"]state['"]\s*,\s*['"]closed['"]/.test(body),
    'Gitee close form body must set state=closed.');
});

// ── 2. closeIssue unit-style invocation with httpsJson seam ──

await ta('git-hosts.closeIssue (GitHub): on 200 returns {ok:true, number, url}', async () => {
  const gh = require('../server/src/git-hosts');
  const fakeHttps = async ({ method, path: p, body }) => {
    assert.strictEqual(method, 'PATCH');
    assert.ok(p.endsWith('/repos/o/r/issues/42'));
    assert.deepStrictEqual(body, { state: 'closed' });
    return { status: 200, body: { number: 42, html_url: 'https://github.com/o/r/issues/42', state: 'closed' }, headers: {} };
  };
  const r = await gh.closeIssue({ provider: 'github', token: 't', owner: 'o', repo: 'r', number: 42, httpsJson: fakeHttps });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.number, 42);
});

await ta('git-hosts.closeIssue (GitHub): on non-2xx returns {error, status}', async () => {
  const gh = require('../server/src/git-hosts');
  const fakeHttps = async () => ({ status: 404, body: { message: 'Not Found' }, headers: {} });
  const r = await gh.closeIssue({ provider: 'github', token: 't', owner: 'o', repo: 'r', number: 9999, httpsJson: fakeHttps });
  assert.strictEqual(r.ok, undefined);
  assert.strictEqual(r.error, 'Not Found');
  assert.strictEqual(r.status, 404);
});

t('git-hosts.closeIssue: rejects missing required fields BEFORE making an HTTP call', () => {
  const gh = require('../server/src/git-hosts');
  return gh.closeIssue({ provider: 'github' }).then((r) => {
    assert.ok(r.error && /requires/.test(r.error),
      'closeIssue must short-circuit with a clear error when token/owner/repo/number are missing — no point making a malformed HTTP call.');
  });
});

// ── 3. artifacts.js /artifact/mark hook ──

t('server/src/artifacts.js: _fireRemoteCloseAsync helper exists', () => {
  const src = _read('server/src/artifacts.js');
  assert.ok(/function\s+_fireRemoteCloseAsync\s*\(/.test(src),
    '_fireRemoteCloseAsync helper must be defined (Phase B.4 — extracted from the route for readability + test seam).');
});

t('server/src/artifacts.js: /artifact/mark fires the write-back ONLY when done is flipping FALSE→TRUE', () => {
  const src = _read('server/src/artifacts.js');
  // Find the /artifact/mark route body.
  const at = src.search(/app\.post\(\s*['"]\/sessions\/:id\/artifact\/mark['"]/);
  assert.ok(at > -1, '/artifact/mark route must exist.');
  const body = src.slice(at, at + 3500);
  // Must capture beforeDone BEFORE the mutation.
  assert.ok(/beforeDone\s*=\s*!!item\.done/.test(body),
    'the route must snapshot beforeDone = !!item.done BEFORE mutating so the write-back guard knows the previous state (Phase B.4).');
  // The fire condition must include `!beforeDone && done`.
  assert.ok(/!\s*beforeDone\s*&&\s*done/.test(body),
    'the write-back must only fire when done flips FALSE→TRUE (`!beforeDone && done`) — un-checking must NOT reopen the upstream (Phase B.4).');
});

t('server/src/artifacts.js: write-back skips items that already have meta.closedUpstreamAt (idempotency) OR meta.closedRemotely (Phase B.3 already closed it)', () => {
  const src = _read('server/src/artifacts.js');
  const at = src.search(/app\.post\(\s*['"]\/sessions\/:id\/artifact\/mark['"]/);
  const body = src.slice(at, at + 3500);
  assert.ok(/!item\.meta\.closedUpstreamAt/.test(body),
    'write-back guard must check !item.meta.closedUpstreamAt (idempotency — don\'t re-PATCH on every subsequent mark).');
  assert.ok(/!item\.meta\.closedRemotely/.test(body),
    'write-back guard must check !item.meta.closedRemotely — if Phase B.3 already mirrored an upstream close, no need to write-back.');
});

t('server/src/artifacts.js: write-back only applies to type="plan" (test/arch items have no upstream)', () => {
  const src = _read('server/src/artifacts.js');
  const at = src.search(/app\.post\(\s*['"]\/sessions\/:id\/artifact\/mark['"]/);
  const body = src.slice(at, at + 3500);
  assert.ok(/type\s*===\s*['"]plan['"]/.test(body),
    'write-back guard must include `type === "plan"` so a test-artifact done-toggle doesn\'t accidentally PATCH a github issue.');
});

t('server/src/artifacts.js: _fireRemoteCloseAsync stamps meta.closedUpstreamAt on success + skips with a log when no token is on file', () => {
  const src = _read('server/src/artifacts.js');
  const at = src.search(/function\s+_fireRemoteCloseAsync\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/closedUpstreamAt\s*=\s*new Date\(\)\.toISOString\(\)/.test(body),
    'on closeIssue success, the helper must stamp meta.closedUpstreamAt with an ISO ts (Phase B.4 — used by B.3\'s "already closed" guard).');
  assert.ok(/no token on file/.test(body),
    'when getToken returns null, the helper must skip with a "no token on file" log so the user can diagnose missing-PAT failures (Phase B.4).');
});

// ── 4. Marker comment ──

t('a comment naming "fr-81 Phase B.4" explains the write-back plumbing', () => {
  const files = ['server/src/git-hosts.js', 'server/src/artifacts.js'];
  let found = 0;
  for (const f of files) if (/fr-81 Phase B\.4/.test(_read(f))) found++;
  assert.ok(found >= 2,
    `at least 2 of the touched files must carry a "fr-81 Phase B.4" marker comment — found in ${found}.`);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

})();
