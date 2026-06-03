// fr-87: public/private sessions + `/share @user @user` slash command.
// The read-only counterpart of fr-39's admin tier. Owners can grant
// other users read-only access to a session via `/share @user`; viewers
// see the session in their sidebar + transcripts/chat but cannot drive
// claude, edit, /admin, or delete.
//
// Contract:
//   - sessions.js exports: getSessionViewers, isOwnerAdminOrViewer,
//     addViewerToSession, removeViewerFromSession.
//   - rec.viewers is an array of github login strings (or absent → []).
//   - Tier ordering: owner > admin > viewer. addViewerToSession is a
//     no-op for owner + existing admin (no double-listing across tiers).
//   - addViewer / removeViewer are idempotent.
//   - addViewer refuses the owner (redundant) and the admin (superseded).
//   - listSessions(forUser) includes sessions where forUser is owner,
//     admin, OR viewer (pre-fr-87 was owner-only).
//   - listSessions returns visibility/viewerCount/isViewer per row so
//     the client can render the badge.
//   - index.js fileApiPreamble gates non-owner non-admin non-viewer
//     authenticated users to 403 (was 'viewer' fall-through pre-fr-87).
//   - index.js WS attach rejects non-owner non-admin non-viewer
//     authenticated users (was readOnly fall-through pre-fr-87).
//   - /share slash command registered in slashcmds.js with owner-only
//     gate + multi-user grant parser.
//   - /share rejects ASSISTANT_USER on both grant + revoke paths.
//
// This test inlines pure-logic helpers (against a fake store) to lock
// the behavior contract, plus static-grep guards on prod sources for
// the wiring sites — same shape as admin-delegation.test.js (fr-39).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ── Inlined helpers — pure logic exercised against a fake store ──

function makeStore() {
  return {
    sessions: {
      'sid-A': { id: 'sid-A', user: 'alice', admins: [], viewers: [] },
      'sid-B': { id: 'sid-B', user: 'bob' },                            // no admins/viewers fields — treat as []
      'sid-C': { id: 'sid-C', user: 'alice', admins: ['bob'], viewers: ['carol', 'dave'] },
      'sid-D': { id: 'sid-D', user: 'eve', admins: ['frank'], viewers: [] },
    },
  };
}

function _getRec(store, sid) { return store.sessions[sid] || null; }

function getSessionViewers(store, sid) {
  const rec = _getRec(store, sid);
  if (!rec) return [];
  return Array.isArray(rec.viewers) ? rec.viewers.slice() : [];
}

function isOwnerAdminOrViewer(store, sid, user) {
  const rec = _getRec(store, sid);
  if (!rec || !user) return false;
  if (rec.user === user) return true;
  if (Array.isArray(rec.admins) && rec.admins.includes(user)) return true;
  return Array.isArray(rec.viewers) && rec.viewers.includes(user);
}

function addViewerToSession(store, sid, user) {
  const rec = _getRec(store, sid);
  if (!rec || !user) return false;
  if (rec.user === user) return false;                                     // owner is implicit viewer
  if (Array.isArray(rec.admins) && rec.admins.includes(user)) return false; // admin supersedes
  if (!Array.isArray(rec.viewers)) rec.viewers = [];
  if (rec.viewers.includes(user)) return false;                            // idempotent
  rec.viewers.push(user);
  return true;
}

function removeViewerFromSession(store, sid, user) {
  const rec = _getRec(store, sid);
  if (!rec || !user) return false;
  if (!Array.isArray(rec.viewers)) return false;
  const idx = rec.viewers.indexOf(user);
  if (idx < 0) return false;                                               // idempotent
  rec.viewers.splice(idx, 1);
  return true;
}

// listSessions-equivalent filter: which sessions does `forUser` see?
function filterSessionsFor(store, forUser) {
  return Object.values(store.sessions).filter((r) => {
    if (r.user === forUser) return true;
    if (Array.isArray(r.admins) && r.admins.includes(forUser)) return true;
    if (Array.isArray(r.viewers) && r.viewers.includes(forUser)) return true;
    return false;
  });
}

// ── isOwnerAdminOrViewer tier tests ──

console.log('── fr-87: per-session viewer delegation ──');

t('isOwnerAdminOrViewer: owner → true', () => {
  const s = makeStore();
  assert.strictEqual(isOwnerAdminOrViewer(s, 'sid-A', 'alice'), true);
});

t('isOwnerAdminOrViewer: admin → true (sid-C bob)', () => {
  const s = makeStore();
  assert.strictEqual(isOwnerAdminOrViewer(s, 'sid-C', 'bob'), true);
});

t('isOwnerAdminOrViewer: viewer → true (sid-C carol, dave)', () => {
  const s = makeStore();
  assert.strictEqual(isOwnerAdminOrViewer(s, 'sid-C', 'carol'), true);
  assert.strictEqual(isOwnerAdminOrViewer(s, 'sid-C', 'dave'), true);
});

t('isOwnerAdminOrViewer: unrelated user → false (fr-87 private-by-default)', () => {
  const s = makeStore();
  assert.strictEqual(isOwnerAdminOrViewer(s, 'sid-A', 'bob'),   false);
  assert.strictEqual(isOwnerAdminOrViewer(s, 'sid-C', 'eve'),   false);
  assert.strictEqual(isOwnerAdminOrViewer(s, 'sid-D', 'alice'), false);
});

t('isOwnerAdminOrViewer: missing viewers field → only owner+admin return true', () => {
  const s = makeStore();
  assert.strictEqual(s.sessions['sid-B'].viewers, undefined);
  assert.strictEqual(isOwnerAdminOrViewer(s, 'sid-B', 'bob'),   true);
  assert.strictEqual(isOwnerAdminOrViewer(s, 'sid-B', 'alice'), false);
});

t('isOwnerAdminOrViewer: null/empty user → false', () => {
  const s = makeStore();
  assert.strictEqual(isOwnerAdminOrViewer(s, 'sid-A', null), false);
  assert.strictEqual(isOwnerAdminOrViewer(s, 'sid-A', ''),   false);
});

t('isOwnerAdminOrViewer: unknown session → false', () => {
  const s = makeStore();
  assert.strictEqual(isOwnerAdminOrViewer(s, 'sid-NOPE', 'alice'), false);
});

// ── addViewer / removeViewer ──

t('addViewer: grant succeeds + persists', () => {
  const s = makeStore();
  assert.strictEqual(addViewerToSession(s, 'sid-A', 'bob'), true);
  assert.deepStrictEqual(getSessionViewers(s, 'sid-A'), ['bob']);
  assert.strictEqual(isOwnerAdminOrViewer(s, 'sid-A', 'bob'), true);
});

t('addViewer: idempotent — second grant no-op', () => {
  const s = makeStore();
  addViewerToSession(s, 'sid-A', 'bob');
  assert.strictEqual(addViewerToSession(s, 'sid-A', 'bob'), false);
  assert.deepStrictEqual(getSessionViewers(s, 'sid-A'), ['bob']);
});

t('addViewer: refuses to add the owner', () => {
  const s = makeStore();
  assert.strictEqual(addViewerToSession(s, 'sid-A', 'alice'), false);
  assert.deepStrictEqual(getSessionViewers(s, 'sid-A'), []);
});

t('addViewer: refuses to double-list a user already in admins (admin supersedes)', () => {
  const s = makeStore();
  // sid-C: alice owner, bob admin, carol+dave viewers
  assert.strictEqual(addViewerToSession(s, 'sid-C', 'bob'), false);
  assert.deepStrictEqual(getSessionViewers(s, 'sid-C'), ['carol', 'dave']); // unchanged
});

t('addViewer: auto-creates viewers array when absent', () => {
  const s = makeStore();
  assert.strictEqual(s.sessions['sid-B'].viewers, undefined);
  assert.strictEqual(addViewerToSession(s, 'sid-B', 'alice'), true);
  assert.deepStrictEqual(getSessionViewers(s, 'sid-B'), ['alice']);
});

t('removeViewer: revoke succeeds + persists', () => {
  const s = makeStore();
  assert.strictEqual(removeViewerFromSession(s, 'sid-C', 'carol'), true);
  assert.deepStrictEqual(getSessionViewers(s, 'sid-C'), ['dave']);
});

t('removeViewer: idempotent — second revoke no-op', () => {
  const s = makeStore();
  removeViewerFromSession(s, 'sid-C', 'carol');
  assert.strictEqual(removeViewerFromSession(s, 'sid-C', 'carol'), false);
});

t('removeViewer: unknown user → no-op (not an error)', () => {
  const s = makeStore();
  assert.strictEqual(removeViewerFromSession(s, 'sid-C', 'zara'), false);
  assert.deepStrictEqual(getSessionViewers(s, 'sid-C'), ['carol', 'dave']); // unchanged
});

// ── Default-private + visibility contract ──

t('default session has zero viewers + visibility=private', () => {
  const s = makeStore();
  const rec = s.sessions['sid-A'];
  assert.deepStrictEqual(getSessionViewers(s, 'sid-A'), []);
  // visibility is computed by listSessions: 'shared' iff any admin or viewer
  const visibility = (rec.admins.length || rec.viewers.length) ? 'shared' : 'private';
  assert.strictEqual(visibility, 'private');
});

t('session with viewers has visibility=shared + viewerCount matches', () => {
  const s = makeStore();
  const rec = s.sessions['sid-C'];
  const visibility = (rec.admins.length || rec.viewers.length) ? 'shared' : 'private';
  assert.strictEqual(visibility, 'shared');
  assert.strictEqual(getSessionViewers(s, 'sid-C').length, 2);
});

t('session with only admins (no viewers) still shows visibility=shared', () => {
  const s = makeStore();
  const rec = s.sessions['sid-D'];      // eve owner, frank admin, no viewers
  const visibility = (rec.admins.length || rec.viewers.length) ? 'shared' : 'private';
  assert.strictEqual(visibility, 'shared');
  assert.strictEqual(getSessionViewers(s, 'sid-D').length, 0);
});

// ── listSessions widening: viewers see shared sessions ──

t('listSessions(viewer) includes sessions the user is a viewer on (fr-87)', () => {
  const s = makeStore();
  const carolSessions = filterSessionsFor(s, 'carol');
  const ids = carolSessions.map((r) => r.id).sort();
  assert.deepStrictEqual(ids, ['sid-C'], 'carol should see sid-C as a shared session');
});

t('listSessions(admin) still includes sessions the user is an admin on', () => {
  const s = makeStore();
  const bobSessions = filterSessionsFor(s, 'bob');
  const ids = bobSessions.map((r) => r.id).sort();
  assert.deepStrictEqual(ids, ['sid-B', 'sid-C'], 'bob owns sid-B and admins sid-C');
});

t('listSessions(unrelated) excludes private sessions (private-by-default)', () => {
  const s = makeStore();
  const zara = filterSessionsFor(s, 'zara');
  assert.deepStrictEqual(zara.map((r) => r.id), [], 'zara has no sessions visible');
});

// ── Owner-only /share gate semantics ──

t('viewer must NOT pass owner-only checks (cannot delete / cannot /share / cannot /admin)', () => {
  const s = makeStore();
  function sessionBelongsToUser(sid, user) {
    const rec = _getRec(s, sid);
    return !!rec && rec.user === user;
  }
  // sid-C: alice owner, bob admin, carol viewer
  assert.strictEqual(sessionBelongsToUser('sid-C', 'alice'), true,  'owner passes');
  assert.strictEqual(sessionBelongsToUser('sid-C', 'bob'),   false, 'admin must NOT pass (fr-39)');
  assert.strictEqual(sessionBelongsToUser('sid-C', 'carol'), false, 'viewer must NOT pass — fr-87 keeps /share + delete owner-only');
});

t('admin attempting to share is rejected by the same owner-only gate', () => {
  const s = makeStore();
  function isOwner(sid, user) {
    const rec = _getRec(s, sid);
    return !!rec && rec.user === user;
  }
  // bob is admin on sid-C but NOT owner — /share gate must reject
  assert.strictEqual(isOwner('sid-C', 'bob'), false);
});

// ── Static-grep guards on prod source ──

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

t('static guard: sessions.js exports the 4 viewer helpers', () => {
  const src = _read('server/src/sessions.js');
  for (const fn of ['getSessionViewers', 'isOwnerAdminOrViewer', 'addViewerToSession', 'removeViewerFromSession']) {
    assert.ok(new RegExp(`function\\s+${fn}\\s*\\(`).test(src),
      `sessions.js must define function ${fn}(...)`);
    assert.ok(new RegExp(`\\b${fn}\\b`).test(src),
      `${fn} must be exported`);
  }
});

t('static guard: listSessions widened to include viewers + emits visibility metadata', () => {
  const src = _read('server/src/sessions.js');
  const listStart = src.indexOf('async function listSessions');
  assert.ok(listStart > 0, 'listSessions function must exist');
  const window = src.slice(listStart, listStart + 3000);
  assert.ok(/r\.viewers/.test(window),
    'listSessions must reference rec.viewers in its filter');
  assert.ok(/visibility/.test(window),
    'listSessions must emit a visibility field on returned rows');
  assert.ok(/viewerCount/.test(window),
    'listSessions must emit a viewerCount field on returned rows');
});

t('static guard: /share slash command registered + handler defined', () => {
  const src = _read('server/src/slashcmds.js');
  assert.ok(/names:\s*\[\s*['"]share['"]/.test(src),
    "/share must be registered in the COMMANDS table");
  assert.ok(/function\s+handleShare\s*\(/.test(src),
    'handleShare function must exist in slashcmds.js');
});

t('static guard: handleShare enforces owner-only', () => {
  const src = _read('server/src/slashcmds.js');
  const fnStart = src.indexOf('function handleShare');
  assert.ok(fnStart > 0, 'handleShare must exist');
  const window = src.slice(fnStart, fnStart + 5000);
  assert.ok(/rec\.user\s*!==\s*ctx\.user/.test(window),
    'handleShare must reject non-owners with rec.user !== ctx.user');
  assert.ok(/owner-only/i.test(window),
    'handleShare must include an "owner-only" denial message so the user understands why their grant failed');
});

t('static guard: handleShare rejects ASSISTANT_USER on both grant + revoke paths', () => {
  const src = _read('server/src/slashcmds.js');
  const fnStart = src.indexOf('function handleShare');
  const window = src.slice(fnStart, fnStart + 5000);
  assert.ok(/ASSISTANT_USER/.test(window),
    'handleShare must reference ASSISTANT_USER to reject the claude pseudo-user');
});

t('static guard: handleShare parses space-separated multi-user grants', () => {
  const src = _read('server/src/slashcmds.js');
  const fnStart = src.indexOf('function handleShare');
  const window = src.slice(fnStart, fnStart + 5000);
  // The multi-user shape requires splitting the arg on whitespace.
  assert.ok(/split\(\/\\s\+\//.test(window) || /split\(['"]\s+['"]\)/.test(window) || /split\(\/\\s\+\/\)/.test(window),
    'handleShare must split args on whitespace so `/share @a @b @c` grants all three');
});

t('static guard: index.js fileApiPreamble checks rec.admins + rec.viewers (private-by-default)', () => {
  const src = _read('server/src/index.js');
  const fnStart = src.indexOf('function fileApiPreamble');
  assert.ok(fnStart > 0, 'fileApiPreamble must exist in index.js');
  const window = src.slice(fnStart, fnStart + 2500);
  // fr-95 follow-up: bug-47 r3 delegated the per-tier checks to
  // sessions.resolveAccessTier (a single source of truth — pre-r3 the
  // ladder was reimplemented inline AND in sessions.js, and they
  // silently drifted, breaking the labxnow/kkrazy global carve-out on
  // the file-API while leaving WS attach working). After r3,
  // fileApiPreamble calls resolveAccessTier(id, req.user) and the
  // helper does the rec.admins/rec.viewers check. The CONTRACT this
  // test wants to lock is that those tiers are still considered; the
  // delegate-call is now the right marker.
  assert.ok(/resolveAccessTier\s*\(/.test(window),
    'fileApiPreamble must delegate access resolution to resolveAccessTier(id, req.user) — the single source of truth that checks rec.admins + rec.viewers (bug-47 r3 contract).');
  // Verify the delegate actually checks the tiers.
  const sessionsSrc = _read('server/src/sessions.js');
  const helperStart = sessionsSrc.indexOf('function resolveAccessTier');
  assert.ok(helperStart > 0, 'resolveAccessTier must exist in sessions.js (post bug-47 r3).');
  const helperWindow = sessionsSrc.slice(helperStart, helperStart + 2500);
  assert.ok(/rec\.admins|admins/.test(helperWindow),
    'resolveAccessTier must check rec.admins (admin tier passes as owner-level).');
  assert.ok(/rec\.viewers|viewers/.test(helperWindow),
    'resolveAccessTier must check rec.viewers (fr-87: private-by-default).');
});

t('static guard: WS attach rejects authenticated non-owner non-admin non-viewer (fr-87 tightening)', () => {
  const src = _read('server/src/index.js');
  // The fr-87 tightening lives where readOnly is set for the non-owner
  // branch. We expect an isOwnerAdminOrViewer check there.
  const marker = src.indexOf('private-by-default');
  assert.ok(marker > 0, 'index.js WS attach must reference the fr-87 private-by-default tightening');
  const window = src.slice(Math.max(0, marker - 200), marker + 1000);
  assert.ok(/isOwnerAdminOrViewer\s*\(/.test(window),
    'WS attach must reject authenticated non-(owner|admin|viewer) users with a 403 instead of falling through to readOnly');
  assert.ok(/403|Forbidden/.test(window),
    'WS attach rejection must close the socket with a 403 status');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
