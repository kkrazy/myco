// fr-39: per-session admin delegation. Owners can promote other users
// to admin via `/admin @user`. Admins inherit everything the owner
// can do EXCEPT:
//   - DELETE /sessions/:id stays owner-only
//   - `/admin` grant/revoke stays owner-only
//
// Contract:
//   - sessions.js exports: getSessionAdmins, isOwnerOrAdmin,
//     addAdminToSession, removeAdminFromSession.
//   - rec.admins is an array of GitHub login strings (or absent → []).
//   - addAdmin / removeAdmin are idempotent.
//   - addAdmin refuses to add the owner (redundant).
//   - WS attach gate in index.js uses isOwnerOrAdmin (not
//     sessionBelongsToUser), so admins get full attach, not readOnly.
//   - DELETE route in index.js uses sessionBelongsToUser
//     (intentionally owner-only — admins denied).
//   - /admin slash command exists in slashcmds.js with owner-only gate
//     + grant/revoke parser.
//
// This test inlines the helpers (against a fake session store) to lock
// the behavior contract, plus static-grep guards on prod source for
// the wiring sites.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ──────────────────────────────────────────────────────────────────────────
// Inlined helpers — pure logic, exercised against a fake store.

function makeStore() {
  return {
    sessions: {
      'sid-A': { id: 'sid-A', user: 'alice', admins: [] },
      'sid-B': { id: 'sid-B', user: 'bob' },           // no admins field — should treat as []
      'sid-C': { id: 'sid-C', user: 'alice', admins: ['bob', 'carol'] },
    },
  };
}

function _getRec(store, sid) { return store.sessions[sid] || null; }

function getSessionAdmins(store, sid) {
  const rec = _getRec(store, sid);
  if (!rec) return [];
  return Array.isArray(rec.admins) ? rec.admins.slice() : [];
}

function isOwnerOrAdmin(store, sid, user) {
  const rec = _getRec(store, sid);
  if (!rec || !user) return false;
  if (rec.user === user) return true;
  return Array.isArray(rec.admins) && rec.admins.includes(user);
}

function addAdminToSession(store, sid, user) {
  const rec = _getRec(store, sid);
  if (!rec || !user) return false;
  if (rec.user === user) return false;            // owner = implicit admin
  if (!Array.isArray(rec.admins)) rec.admins = [];
  if (rec.admins.includes(user)) return false;    // idempotent
  rec.admins.push(user);
  return true;
}

function removeAdminFromSession(store, sid, user) {
  const rec = _getRec(store, sid);
  if (!rec || !user) return false;
  if (!Array.isArray(rec.admins)) return false;
  const idx = rec.admins.indexOf(user);
  if (idx < 0) return false;
  rec.admins.splice(idx, 1);
  return true;
}

// ──────────────────────────────────────────────────────────────────────────

console.log('── fr-39: per-session admin delegation ──');

t('isOwnerOrAdmin: owner → true', () => {
  const s = makeStore();
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-A', 'alice'), true);
});

t('isOwnerOrAdmin: admin → true (sid-C has bob + carol)', () => {
  const s = makeStore();
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-C', 'bob'), true);
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-C', 'carol'), true);
});

t('isOwnerOrAdmin: unrelated user → false', () => {
  const s = makeStore();
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-A', 'bob'), false);
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-C', 'dave'), false);
});

t('isOwnerOrAdmin: missing admins field → only owner returns true', () => {
  const s = makeStore();
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-B', 'bob'), true);   // owner
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-B', 'alice'), false);
});

t('isOwnerOrAdmin: anon (null user) → false', () => {
  const s = makeStore();
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-A', null), false);
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-A', ''), false);
});

t('isOwnerOrAdmin: unknown session → false', () => {
  const s = makeStore();
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-NOPE', 'alice'), false);
});

t('addAdmin: grant succeeds + persists', () => {
  const s = makeStore();
  assert.strictEqual(addAdminToSession(s, 'sid-A', 'bob'), true);
  assert.deepStrictEqual(getSessionAdmins(s, 'sid-A'), ['bob']);
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-A', 'bob'), true);
});

t('addAdmin: idempotent — second grant is a no-op', () => {
  const s = makeStore();
  addAdminToSession(s, 'sid-A', 'bob');
  assert.strictEqual(addAdminToSession(s, 'sid-A', 'bob'), false);
  assert.deepStrictEqual(getSessionAdmins(s, 'sid-A'), ['bob']);
});

t('addAdmin: refuses to add the owner', () => {
  const s = makeStore();
  assert.strictEqual(addAdminToSession(s, 'sid-A', 'alice'), false);
  assert.deepStrictEqual(getSessionAdmins(s, 'sid-A'), []);
});

t('addAdmin: auto-creates admins array when absent', () => {
  const s = makeStore();
  assert.strictEqual(s.sessions['sid-B'].admins, undefined);
  assert.strictEqual(addAdminToSession(s, 'sid-B', 'alice'), true);
  assert.deepStrictEqual(getSessionAdmins(s, 'sid-B'), ['alice']);
});

t('removeAdmin: revoke succeeds + persists', () => {
  const s = makeStore();
  assert.strictEqual(removeAdminFromSession(s, 'sid-C', 'bob'), true);
  assert.deepStrictEqual(getSessionAdmins(s, 'sid-C'), ['carol']);
});

t('removeAdmin: idempotent — second revoke is a no-op', () => {
  const s = makeStore();
  removeAdminFromSession(s, 'sid-C', 'bob');
  assert.strictEqual(removeAdminFromSession(s, 'sid-C', 'bob'), false);
});

t('removeAdmin: unknown user → no-op (not an error)', () => {
  const s = makeStore();
  assert.strictEqual(removeAdminFromSession(s, 'sid-C', 'dave'), false);
  assert.deepStrictEqual(getSessionAdmins(s, 'sid-C'), ['bob', 'carol']);
});

t('owner-only delete semantics: admin must NOT pass sessionBelongsToUser', () => {
  // Simulates the DELETE /sessions/:id gate. The contract is that
  // sessionBelongsToUser is STRICT owner check — admins fail.
  const s = makeStore();
  function sessionBelongsToUser(sid, user) {
    const rec = _getRec(s, sid);
    return !!rec && rec.user === user;
  }
  assert.strictEqual(sessionBelongsToUser('sid-C', 'alice'), true,  'owner passes');
  assert.strictEqual(sessionBelongsToUser('sid-C', 'bob'),   false, 'admin (bob) MUST NOT pass — fr-39 keeps delete owner-only');
  assert.strictEqual(sessionBelongsToUser('sid-C', 'carol'), false, 'admin (carol) MUST NOT pass');
  // But isOwnerOrAdmin DOES let admins through (used by the WS attach gate)
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-C', 'bob'),   true);
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-C', 'carol'), true);
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards on the prod source.

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

t('static guard: sessions.js exports the 4 admin helpers', () => {
  const src = _read('server/src/sessions.js');
  for (const fn of ['getSessionAdmins', 'isOwnerOrAdmin', 'addAdminToSession', 'removeAdminFromSession']) {
    assert.ok(new RegExp(`function\\s+${fn}\\s*\\(`).test(src),
      `sessions.js must define function ${fn}(...)`);
    assert.ok(new RegExp(`\\b${fn}\\b`).test(src), `${fn} must be exported`);
  }
});

t('static guard: index.js WS attach uses isOwnerOrAdmin, not sessionBelongsToUser', () => {
  const src = _read('server/src/index.js');
  // The non-owner→readOnly gate must call isOwnerOrAdmin so admins
  // get full attach. Find the readOnly assignment block.
  const idx = src.indexOf('Non-owner authenticated user');
  assert.ok(idx > 0, 'index.js must keep the non-owner readOnly comment');
  // Look at ~400 chars around the block for the gate's call site.
  const window = src.slice(Math.max(0, idx - 400), idx + 400);
  assert.ok(/isOwnerOrAdmin\s*\(/.test(window),
    'WS-attach gate must call isOwnerOrAdmin(...) so admins are not demoted to readOnly');
});

t('static guard: DELETE /sessions/:id uses sessionBelongsToUser (owner-only)', () => {
  const src = _read('server/src/index.js');
  const deleteStart = src.indexOf("app.delete('/sessions/:id'");
  assert.ok(deleteStart > 0, "DELETE /sessions/:id route must exist");
  const window = src.slice(deleteStart, deleteStart + 600);
  assert.ok(/sessionBelongsToUser\s*\(/.test(window),
    'DELETE /sessions/:id must call sessionBelongsToUser (owner-only) — NOT isOwnerOrAdmin (admins must fail this gate)');
  assert.ok(!/isOwnerOrAdmin\s*\(/.test(window),
    'DELETE /sessions/:id must NOT call isOwnerOrAdmin — that would let admins delete, violating fr-39');
});

t('static guard: /admin slash command registered + handler defined', () => {
  const src = _read('server/src/slashcmds.js');
  assert.ok(/names:\s*\[\s*['"]admin['"]/.test(src), '/admin must be in COMMANDS');
  assert.ok(/function\s+handleAdmin\s*\(/.test(src), 'handleAdmin function must exist');
});

t('static guard: handleAdmin enforces owner-only', () => {
  const src = _read('server/src/slashcmds.js');
  const fnStart = src.indexOf('function handleAdmin');
  assert.ok(fnStart > 0);
  const window = src.slice(fnStart, fnStart + 2500);
  assert.ok(/rec\.user\s*!==\s*ctx\.user/.test(window),
    'handleAdmin must check rec.user !== ctx.user and reject non-owners');
  assert.ok(/owner-only/i.test(window),
    'handleAdmin must include an "owner-only" denial message so the user understands why their grant failed');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
