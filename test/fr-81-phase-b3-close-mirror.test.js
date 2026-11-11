// fr-81 Phase B.3: close-detection mirror — when a remote issue
// closes upstream, mark the matched local plan item done.
//
// Builds on Phase B.1's auto-promote (every successful /feature +
// /fr @target writes a local row with meta.remoteUrl=<url>) and
// Phase B.2's dedup. The close-mirror runs during the same
// remote-issues refresh: for each linked local item (meta.remoteUrl
// set) whose URL appears in the upstream CLOSED-issues list AND
// the local item isn't already done, flip done=true + stamp
// meta.closedRemotely=true + meta.closedRemotelyAt=<iso ts>.
//
// Why a separate fetch from the open list: gitHosts.fetchIssues
// takes `state` as a single value. Two fetches per refresh is
// cheap (5-min cache TTL), simpler, and lets us future-tune the
// closed scan independently with a `since:` cutoff if needed.
//
// Phase B.4 (write-back-on-close: Plan-view close → close upstream)
// still deferred — ships next.
//
// Test shape: static-grep + unit-style invocation via the
// withPatchedGitHosts harness, plus a sessions-module patch that
// stubs saveStore.

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

console.log('── fr-81 Phase B.3: close-detection mirror ──');

(async () => {

// ── 1. Static-grep on the server surface ──

t('server/src/remote-issues.js: _mirrorClosedRemoteIssues helper exists and fetches state="closed"', () => {
  const src = _read('server/src/remote-issues.js');
  assert.ok(/async\s+function\s+_mirrorClosedRemoteIssues\s*\(/.test(src),
    '_mirrorClosedRemoteIssues helper must be defined (Phase B.3 — close-detection mirror).');
  const at = src.search(/async\s+function\s+_mirrorClosedRemoteIssues\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/state\s*:\s*['"]closed['"]/.test(body),
    '_mirrorClosedRemoteIssues must call gitHosts.fetchIssues with state="closed" so it sees the upstream-closed set (Phase B.3).');
});

t('server/src/remote-issues.js: mirror sets done=true, meta.closedRemotely=true, meta.closedRemotelyAt=<iso>', () => {
  const src = _read('server/src/remote-issues.js');
  const at = src.search(/async\s+function\s+_mirrorClosedRemoteIssues\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/localItem\.done\s*=\s*true/.test(body),
    'the mirror must set localItem.done = true (Phase B.3 — that\'s the visible "the issue is resolved upstream" signal).');
  assert.ok(/closedRemotely\s*=\s*true/.test(body),
    'the mirror must stamp meta.closedRemotely = true so a future filter can distinguish locally-closed from remotely-closed items (Phase B.3).');
  assert.ok(/closedRemotelyAt/.test(body),
    'the mirror must stamp meta.closedRemotelyAt with an ISO ts so the timeline shows WHEN upstream closed the issue (Phase B.3).');
});

t('server/src/remote-issues.js: mirror SKIPS items that are already done (no double-flip on subsequent refreshes)', () => {
  const src = _read('server/src/remote-issues.js');
  const at = src.search(/async\s+function\s+_mirrorClosedRemoteIssues\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/if\s*\(\s*localItem\.done\s*\)\s*continue/.test(body),
    'the mirror must short-circuit on already-done items so the next refresh after a close doesn\'t re-stamp closedRemotelyAt with a fresher timestamp (Phase B.3 — idempotency guard).');
});

t('server/src/remote-issues.js: mirror persists via sessions.saveStore + emits a plan state-update on the live session bus', () => {
  const src = _read('server/src/remote-issues.js');
  const at = src.search(/async\s+function\s+_mirrorClosedRemoteIssues\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/saveStore/.test(body),
    'the mirror must call sessions.saveStore so the closed-state survives a container restart (Phase B.3).');
  assert.ok(/emit\s*\(\s*['"]state-update['"]/.test(body),
    'the mirror must emit a state-update on the live session bus so attached Plan views refresh without a tab reload (Phase B.3).');
  assert.ok(/artifactType\s*:\s*['"]plan['"]/.test(body),
    'the state-update must carry artifactType="plan" so the chat-pane router updates the right view (Phase B.3).');
});

t('server/src/remote-issues.js: getForSession invokes the mirror ONLY when linkedUrls is non-empty (no wasted closed fetch on pre-B.1 sessions)', () => {
  const src = _read('server/src/remote-issues.js');
  // The mirror invocation guard. Loose-match a `linkedUrls.size > 0`
  // wrapper around the call.
  assert.ok(/if\s*\(\s*linkedUrls\.size\s*>\s*0\s*\)\s*\{[\s\S]{0,400}_mirrorClosedRemoteIssues/.test(src),
    'getForSession must guard the close-mirror behind `linkedUrls.size > 0` — calling fetchIssues({state:"closed"}) on every refresh against a repo with no local links is wasted API quota (Phase B.3).');
});

t('server/src/remote-issues.js: cached entry surfaces mirroredClosedCount (visible in diagnostics + future client hint)', () => {
  const src = _read('server/src/remote-issues.js');
  assert.ok(/mirroredClosedCount/.test(src),
    'the cached entry must carry mirroredClosedCount so the server route + logs can surface "N items just closed upstream" (Phase B.3).');
});

// ── 2. Unit-style end-to-end: rec with 2 linked open items, fetchIssues returns them in 'closed' state, assert mirror flips ──

const gitHosts = require('../server/src/git-hosts');
const sessionsMod = require('../server/src/sessions');
const ri = require('../server/src/remote-issues');

async function withPatchedDeps(patch, fn) {
  const orig = {
    detectHost: gitHosts.detectHost,
    fetchIssues: gitHosts.fetchIssues,
    getToken: gitHosts.getToken,
    saveStore: sessionsMod.saveStore,
  };
  Object.assign(gitHosts, patch.gitHosts || {});
  if (patch.saveStore) sessionsMod.saveStore = patch.saveStore;
  try { await fn(); }
  finally {
    Object.assign(gitHosts, orig);
    sessionsMod.saveStore = orig.saveStore;
  }
}

await ta('mirror: closed upstream → local item flips to done=true + meta.closedRemotely=true', async () => {
  ri._resetCache();
  let saveStoreCalls = 0;
  await withPatchedDeps({
    gitHosts: {
      detectHost: async () => ({ provider: 'github', owner: 'o', repo: 'r' }),
      getToken: () => 'fake-token',
      fetchIssues: async (opts) => {
        // Open fetch returns nothing (focus on the mirror).
        if (opts.state === 'open') return { items: [], status: 200 };
        // Closed fetch returns issues #5 and #9 (matching the local items).
        if (opts.state === 'closed') return {
          items: [
            { provider: 'github', number: 5, title: 'X', htmlUrl: 'https://github.com/o/r/issues/5', state: 'closed', isPullRequest: false },
            { provider: 'github', number: 9, title: 'Y', htmlUrl: 'https://github.com/o/r/issues/9', state: 'closed', isPullRequest: false },
          ], status: 200,
        };
        return { items: [], status: 200 };
      },
    },
    saveStore: () => { saveStoreCalls++; },
  }, async () => {
    const rec = {
      id: 's-mirror',
      absCwd: '/tmp',
      artifacts: {
        plan: {
          items: [
            { id: 'fr-1', text: 'local A', done: false, meta: { remoteUrl: 'https://github.com/o/r/issues/5' } },
            { id: 'fr-2', text: 'local B (no remote)',  done: false },
            { id: 'bug-1', text: 'local C', done: false, meta: { remoteUrl: 'https://github.com/o/r/issues/9' } },
          ],
        },
      },
    };
    const r = await ri.getForSession(rec, { user: 'kkrazy' });
    assert.strictEqual(r.mirroredClosedCount, 2,
      'mirroredClosedCount must report 2 (issues #5 + #9 both flipped to done).');
    // Verify the LIVE rec mutation.
    const flippedA = rec.artifacts.plan.items.find((it) => it.id === 'fr-1');
    const skippedB = rec.artifacts.plan.items.find((it) => it.id === 'fr-2');
    const flippedC = rec.artifacts.plan.items.find((it) => it.id === 'bug-1');
    assert.strictEqual(flippedA.done, true, 'fr-1 (matching #5) must flip to done=true.');
    assert.strictEqual(flippedA.meta.closedRemotely, true, 'fr-1 must stamp meta.closedRemotely=true.');
    assert.ok(flippedA.meta.closedRemotelyAt, 'fr-1 must stamp meta.closedRemotelyAt with an ISO ts.');
    assert.strictEqual(skippedB.done, false, 'fr-2 (no meta.remoteUrl) must NOT be touched.');
    assert.strictEqual(flippedC.done, true, 'bug-1 (matching #9) must flip to done=true.');
    assert.ok(saveStoreCalls >= 1, 'sessions.saveStore must be called at least once to persist the mirror.');
  });
});

await ta('mirror: already-done items are NOT re-flipped (idempotency guard)', async () => {
  ri._resetCache();
  let touched = false;
  await withPatchedDeps({
    gitHosts: {
      detectHost: async () => ({ provider: 'github', owner: 'o', repo: 'r' }),
      getToken: () => 'fake-token',
      fetchIssues: async (opts) => {
        if (opts.state === 'open') return { items: [], status: 200 };
        if (opts.state === 'closed') return {
          items: [{ provider: 'github', number: 5, title: 'X', htmlUrl: 'https://github.com/o/r/issues/5', state: 'closed', isPullRequest: false }],
          status: 200,
        };
        return { items: [], status: 200 };
      },
    },
    saveStore: () => { touched = true; },
  }, async () => {
    const originalAt = '2026-05-01T00:00:00.000Z';
    const rec = {
      id: 's-already-done',
      absCwd: '/tmp',
      artifacts: {
        plan: {
          items: [
            { id: 'fr-1', text: 'local A', done: true, meta: { remoteUrl: 'https://github.com/o/r/issues/5', closedRemotelyAt: originalAt } },
          ],
        },
      },
    };
    const r = await ri.getForSession(rec, { user: 'kkrazy' });
    assert.strictEqual(r.mirroredClosedCount, 0,
      'no flips when the matched local item is already done.');
    assert.strictEqual(rec.artifacts.plan.items[0].meta.closedRemotelyAt, originalAt,
      'closedRemotelyAt must NOT be refreshed on subsequent passes (idempotency).');
    assert.strictEqual(touched, false,
      'saveStore must NOT be called when no mirror happens (no spurious /data/sessions.json write).');
  });
});

await ta('mirror: SKIPPED entirely when no local item carries meta.remoteUrl (pre-B.1 sessions cost zero closed-API calls)', async () => {
  ri._resetCache();
  let closedFetches = 0;
  await withPatchedDeps({
    gitHosts: {
      detectHost: async () => ({ provider: 'github', owner: 'o', repo: 'r' }),
      getToken: () => 'fake-token',
      fetchIssues: async (opts) => {
        if (opts.state === 'closed') { closedFetches++; }
        return { items: [], status: 200 };
      },
    },
    saveStore: () => {},
  }, async () => {
    const rec = {
      id: 's-no-links',
      absCwd: '/tmp',
      artifacts: { plan: { items: [{ id: 'fr-1', text: 'legacy', done: false }] } },
    };
    await ri.getForSession(rec, { user: 'kkrazy' });
    assert.strictEqual(closedFetches, 0,
      'when no local item has meta.remoteUrl, the closed-state fetch must not fire (Phase B.3 guard — zero wasted API quota on pre-B.1 sessions).');
  });
});

t('a comment naming "fr-81 Phase B.3" explains the close-mirror plumbing', () => {
  const src = _read('server/src/remote-issues.js');
  assert.ok(/fr-81 Phase B\.3/.test(src),
    'a comment naming "fr-81 Phase B.3" must appear in remote-issues.js so a future restyle understands why getForSession fetches the closed list.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

})();
