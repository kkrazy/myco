// bug-17 regression: granting admin via /admin must actually elevate
// the user's existing WS — and /admin must reject the assistant user
// + non-allowlisted users.
//
// Two root causes locked in here:
//
// 1. PRIMARY: WS readOnly flag is one-shot at attach time. Branch
//    decision (attachViewerWebSocket vs _attachAgentWebSocket in
//    index.js:551) doesn't refresh when rec.admins changes later.
//    Pre-fix: granted user stayed blocked until manual page reload.
//    Fix: addAdminToSession / removeAdminFromSession call a new
//    _kickViewerByLogin(sessionId, login) in attach.js that closes
//    every WS for that login on that session. The client's WS
//    reconnect logic then opens a fresh WS, the new attach evaluates
//    isOwnerOrAdmin against the freshly-mutated rec.admins, and the
//    user lands on the correct branch.
//
// 2. SECONDARY: handleAdmin in slashcmds.js accepted targets it
//    shouldn't:
//      - ASSISTANT_USER ('claude') — meaningless to admin the agent
//      - users not in /data/allowed-github-users.txt — pollutes
//        rec.admins with names that can never authenticate
//    Fix: 2 rejection branches before addAdminToSession.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ──────────────────────────────────────────────────────────────────────────
// Inlined FIXED behaviors.

function makeWs(open = true) {
  return {
    readyState: open ? 1 : 3,
    OPEN: 1,
    closed: false,
    close() { this.closed = true; this.readyState = 3; },
  };
}

// Mirrors the FIXED _kickViewerByLogin: walks the per-session
// presence map, closes WSes whose info.login matches.
function kickByLogin(presence, sessionId, login) {
  const set = presence.get(sessionId);
  if (!set) return 0;
  let kicked = 0;
  for (const info of set) {
    if (info.login !== login) continue;
    try { info.ws && info.ws.close && info.ws.close(); kicked++; } catch {}
  }
  return kicked;
}

// Mirrors the FIXED handleAdmin validation, returns null on accept or
// a rejection reason string. (Not the full handler — just the new
// gates.)
const ASSISTANT_USER = 'claude';
function validateAdminTarget(target, opts = {}) {
  if (target === ASSISTANT_USER) return 'assistant-user';
  if (opts.authRequired && opts.isAllowed && !opts.isAllowed(target)) {
    return 'not-allowlisted';
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────

console.log('── bug-17: admin grant propagation + validation ──');

t('kick: closes WS whose login matches', () => {
  const ws = makeWs();
  const presence = new Map();
  presence.set('sid-1', new Set([{ login: 'labxnow', role: 'guest', ws }]));
  const kicked = kickByLogin(presence, 'sid-1', 'labxnow');
  assert.strictEqual(kicked, 1);
  assert.strictEqual(ws.closed, true, 'WS must be closed so client reconnects + re-evaluates isOwnerOrAdmin');
});

t('kick: spares WSes with non-matching login', () => {
  const ws1 = makeWs();
  const ws2 = makeWs();
  const presence = new Map();
  presence.set('sid-1', new Set([
    { login: 'labxnow', role: 'guest', ws: ws1 },
    { login: 'someone-else', role: 'guest', ws: ws2 },
  ]));
  kickByLogin(presence, 'sid-1', 'labxnow');
  assert.strictEqual(ws1.closed, true);
  assert.strictEqual(ws2.closed, false, 'other users\' connections must not be affected');
});

t('kick: closes MULTIPLE WSes for the same login (multi-tab / multi-device)', () => {
  const ws1 = makeWs();
  const ws2 = makeWs();
  const presence = new Map();
  presence.set('sid-1', new Set([
    { login: 'labxnow', role: 'guest', ws: ws1 },
    { login: 'labxnow', role: 'guest', ws: ws2 },
  ]));
  const kicked = kickByLogin(presence, 'sid-1', 'labxnow');
  assert.strictEqual(kicked, 2);
  assert.strictEqual(ws1.closed, true);
  assert.strictEqual(ws2.closed, true);
});

t('kick: missing presence map → safe no-op (0 kicked, no throw)', () => {
  const presence = new Map();
  const kicked = kickByLogin(presence, 'sid-NOPE', 'whoever');
  assert.strictEqual(kicked, 0);
});

t('kick: closes BOTH viewer (role=guest) AND owner-branch (role=owner) WSes for the login', () => {
  // Revoke case: previously-admin user has an owner-branch connection.
  // The kick must drop them so they reconnect as viewer.
  const ws1 = makeWs();
  const ws2 = makeWs();
  const presence = new Map();
  presence.set('sid-1', new Set([
    { login: 'labxnow', role: 'guest', ws: ws1 },
    { login: 'labxnow', role: 'owner', ws: ws2 },
  ]));
  kickByLogin(presence, 'sid-1', 'labxnow');
  assert.strictEqual(ws1.closed, true);
  assert.strictEqual(ws2.closed, true, 'must kick by login regardless of role — covers both grant + revoke directions');
});

t('validateAdminTarget: ASSISTANT_USER (claude) → reject "assistant-user"', () => {
  assert.strictEqual(validateAdminTarget('claude'), 'assistant-user');
});

t('validateAdminTarget: not in allowlist (authRequired) → reject "not-allowlisted"', () => {
  const opts = { authRequired: true, isAllowed: (login) => login === 'alice' };
  assert.strictEqual(validateAdminTarget('bob', opts), 'not-allowlisted');
});

t('validateAdminTarget: in allowlist → accept (null)', () => {
  const opts = { authRequired: true, isAllowed: (login) => login === 'bob' };
  assert.strictEqual(validateAdminTarget('bob', opts), null);
});

t('validateAdminTarget: authRequired=false → allowlist check skipped (single-user dev mode)', () => {
  // Dev mode without auth: any login is fine, no allowlist enforcement.
  const opts = { authRequired: false, isAllowed: () => false };
  assert.strictEqual(validateAdminTarget('bob', opts), null);
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards on the prod source.

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

t('static guard: attach.js exports _kickViewerByLogin', () => {
  const src = _read('server/src/attach.js');
  assert.ok(/function\s+_kickViewerByLogin\s*\(/.test(src),
    'attach.js must define _kickViewerByLogin(sessionId, login)');
  assert.ok(/_kickViewerByLogin\b/.test(src) && /module\.exports|Object\.assign\(\s*module\.exports/.test(src),
    '_kickViewerByLogin must be reachable from sessions.js (exported via module.exports)');
});

t('static guard: addAdminToSession calls _kickViewerByLogin', () => {
  const src = _read('server/src/sessions.js');
  const fnStart = src.indexOf('function addAdminToSession');
  assert.ok(fnStart > 0);
  const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
  const body = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 1500);
  assert.ok(/_kickViewerByLogin\s*\(/.test(body),
    'addAdminToSession must call _kickViewerByLogin so the granted user\'s existing viewer WS drops + reconnects as owner-or-admin');
});

t('static guard: removeAdminFromSession calls _kickViewerByLogin', () => {
  const src = _read('server/src/sessions.js');
  const fnStart = src.indexOf('function removeAdminFromSession');
  assert.ok(fnStart > 0);
  const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
  const body = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 1500);
  assert.ok(/_kickViewerByLogin\s*\(/.test(body),
    'removeAdminFromSession must call _kickViewerByLogin so the revoked admin\'s owner-branch WS drops + reconnects as viewer');
});

t('static guard: handleAdmin rejects ASSISTANT_USER target', () => {
  const src = _read('server/src/slashcmds.js');
  const fnStart = src.indexOf('function handleAdmin');
  assert.ok(fnStart > 0);
  const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
  const body = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3500);
  assert.ok(/ASSISTANT_USER/.test(body),
    'handleAdmin must reference ASSISTANT_USER to reject /admin claude');
  // Look for the actual rejection branch — `target === ASSISTANT_USER` or equivalent.
  assert.ok(/target\s*===\s*ASSISTANT_USER|ASSISTANT_USER\s*===\s*target/.test(body),
    'handleAdmin must compare target === ASSISTANT_USER and reject before addAdminToSession');
});

t('static guard: handleAdmin checks auth.isAllowed for non-allowlisted users', () => {
  const src = _read('server/src/slashcmds.js');
  const fnStart = src.indexOf('function handleAdmin');
  const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
  const body = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3500);
  assert.ok(/isAllowed\s*\(/.test(body),
    'handleAdmin must call auth.isAllowed(target) to reject non-invited users');
  assert.ok(/isAuthRequired\s*\(/.test(body),
    'handleAdmin must gate the isAllowed check on isAuthRequired (allowlist enforcement is auth-mode-only)');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
