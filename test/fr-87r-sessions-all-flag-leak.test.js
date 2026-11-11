// fr-87r (regression): GET /sessions?all=1 was bypassing fr-87's
// listSessions filter, leaking every user's private sessions to every
// authenticated user.
//
// User-reported symptom (verbatim): "i logged in as kkrazy and i can
// see demo001" — observed on opti.labxnow.ai, where Demo001 (owned by
// labxnow, no admins, no viewers) was nonetheless appearing in
// kkrazy's sidebar.
//
// Root cause:
//   - The client's refreshSessions() always sends ?all=1 (single source
//     of truth for the sidebar refresh poll, fires every 3 s).
//   - The GET /sessions route in index.js did:
//       own = await listSessions(all ? null : (isAuthRequired() ? user : null));
//     i.e. when all=1, forUser was null. listSessions(null) returns
//     EVERY session in the store, completely defeating fr-87's
//     owner/admin/viewer filter.
//   - Pre-fr-87 this was harmless because every authenticated user
//     could attach to every session as readOnly anyway. Post-fr-87
//     the WS gate enforces strict private-by-default — but the
//     sidebar still rendered every session, so a non-authorized user
//     could SEE the existence + name + label of every session before
//     hitting the 403 on click.
//
// Contract being locked:
//   - GET /sessions NEVER calls listSessions(null) when there's an
//     authenticated user. The user-filter always applies (so the
//     owner+admin+viewer rule fr-87 added is the single source of
//     truth for sidebar visibility).
//   - listSessions(forUser) filters to sessions where forUser is in
//     {rec.user, rec.admins, rec.viewers}. Unrelated sessions never
//     appear in the result.
//
// Test shape: pure-logic helper that mirrors listSessions's filter +
// static-grep guards on the prod route.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// Mirror of listSessions's filter (sessions.js), exercised against
// a fake store to lock the behavior.
function filterFor(store, forUser) {
  return store.sessions.filter((r) => {
    if (forUser === null || forUser === undefined) return true;   // legacy "show everything" path — must NOT be reachable from the auth'd HTTP route
    if (r.user === forUser) return true;
    if (Array.isArray(r.admins) && r.admins.includes(forUser)) return true;
    if (Array.isArray(r.viewers) && r.viewers.includes(forUser)) return true;
    return false;
  });
}

function makeStore() {
  return {
    sessions: [
      { id: 'sid-labxnow', user: 'labxnow', label: 'Demo001', admins: [], viewers: [] },
      { id: 'sid-ryan',    user: 'ryan-blues', label: 'opti-demo', admins: [], viewers: [] },
      { id: 'sid-clionx',  user: 'clionx', label: 'wks/clionx/test', admins: [], viewers: [] },
      { id: 'sid-shared',  user: 'labxnow', label: 'Public-ish', admins: ['kkrazy'], viewers: ['ryan-blues'] },
    ],
  };
}

console.log('── fr-87r: GET /sessions?all=1 must not bypass the user filter ──');

t('user-filter on: each owner sees only own sessions (+ shared-to-them)', () => {
  const store = makeStore();
  // labxnow owns 2 sessions (Demo001 + Public-ish), is in 0 admin/viewer lists
  const labxnowVisible = filterFor(store, 'labxnow').map(s => s.id).sort();
  assert.deepStrictEqual(labxnowVisible, ['sid-labxnow', 'sid-shared']);

  // kkrazy owns nothing, but is admin on sid-shared
  const kkrazyVisible = filterFor(store, 'kkrazy').map(s => s.id).sort();
  assert.deepStrictEqual(kkrazyVisible, ['sid-shared'],
    'kkrazy is NOT owner of labxnow\'s private Demo001; must be filtered out');

  // ryan-blues owns 1 + is viewer on sid-shared
  const ryanVisible = filterFor(store, 'ryan-blues').map(s => s.id).sort();
  assert.deepStrictEqual(ryanVisible, ['sid-ryan', 'sid-shared']);
});

t('user-filter OFF (null) leaks every session — THIS PATH MUST NOT BE REACHABLE FROM THE AUTHED HTTP ROUTE', () => {
  const store = makeStore();
  const everything = filterFor(store, null).map(s => s.id).sort();
  assert.deepStrictEqual(everything, ['sid-clionx', 'sid-labxnow', 'sid-ryan', 'sid-shared'],
    'filterFor(null) returns everything — that\'s the legacy "show all" path. It\'s INTENTIONALLY broken to demonstrate the leak; the regression test then locks that the HTTP route never reaches this path.');
});

t('THE BUG: passing all=1 must NOT translate into listSessions(null) when there is an auth\'d user', () => {
  // Direct port of the route's resolution logic. The FIXED behavior:
  // the user filter is ALWAYS applied when there's a user, regardless
  // of all=1.
  function resolveForUser(authedUser, isAllFlag) {
    // POST-FIX shape: never pass null when there's a user.
    if (authedUser) return authedUser;
    return null;                                                // unauth + share-token-only path
  }
  // Auth'd user with all=1 → still filtered to themselves
  assert.strictEqual(resolveForUser('kkrazy', true),  'kkrazy');
  assert.strictEqual(resolveForUser('kkrazy', false), 'kkrazy');
  // Anonymous (share-token only) path remains null — share-token
  // matching is independent of the user filter.
  assert.strictEqual(resolveForUser(null, true),  null);
  assert.strictEqual(resolveForUser(null, false), null);
});

t('integration: with the FIXED resolver, kkrazy never sees labxnow\'s Demo001', () => {
  const store = makeStore();
  function resolveForUser(authedUser, isAllFlag) {
    if (authedUser) return authedUser;
    return null;
  }
  const kkrazyAll = filterFor(store, resolveForUser('kkrazy', true)).map(s => s.id).sort();
  assert.ok(!kkrazyAll.includes('sid-labxnow'),
    `kkrazy with all=1 must NOT see sid-labxnow (Demo001) — got ${kkrazyAll.join(',')}`);
  // Sanity: kkrazy still sees what they're allowed to see (the admin-shared one).
  assert.ok(kkrazyAll.includes('sid-shared'),
    'kkrazy IS in sid-shared.admins, must still see it');
});

// ── Static-grep guards on prod source ──

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

t('static guard: GET /sessions route never calls listSessions(null) under the auth\'d branch', () => {
  const src = _read('server/src/index.js');
  const routeStart = src.indexOf("app.get('/sessions'");
  assert.ok(routeStart > 0, 'GET /sessions route must exist in index.js');
  // Window covers the route handler body.
  const window = src.slice(routeStart, routeStart + 1500);
  // The buggy form was:  listSessions(all ? null : (isAuthRequired() ? user : null));
  // The fixed form must NOT have `all ? null` (which routes the auth'd
  // path into the everyone-can-see-everything branch).
  assert.ok(!/listSessions\(\s*all\s*\?\s*null/.test(window),
    `GET /sessions must NOT call listSessions(all ? null ...) — that bypasses fr-87's filter when the client sends ?all=1. Use the authenticated user as forUser unconditionally.`);
});

t('static guard: route resolves forUser from the auth\'d user (not from all flag)', () => {
  const src = _read('server/src/index.js');
  const routeStart = src.indexOf("app.get('/sessions'");
  const window = src.slice(routeStart, routeStart + 1500);
  // The fixed form passes the user (or null only when there is no user).
  // Accept either `listSessions(user)` or `listSessions(isAuthRequired() ? user : null)`
  // or `listSessions(user || null)` — any form that ALWAYS prefers the
  // auth\'d user when present.
  assert.ok(
    /listSessions\(\s*user\b/.test(window)
    || /listSessions\(\s*isAuthRequired\(\)\s*\?\s*user\s*:\s*null\s*\)/.test(window)
    || /listSessions\(\s*(?:user\s*\|\|\s*null|isAuthRequired\(\)\s*&&\s*user)/.test(window),
    'GET /sessions must call listSessions with the authenticated user, not with the result of the all=1 short-circuit.');
});

t('static guard: code comment cites fr-87r / sessions?all=1 leak so future readers know the trap', () => {
  const src = _read('server/src/index.js');
  const routeStart = src.indexOf("app.get('/sessions'");
  const window = src.slice(routeStart, routeStart + 2000);
  assert.ok(/fr-87r|all=1|all\s*flag/i.test(window),
    'The GET /sessions route must include a comment naming fr-87r or the all=1 trap so the next reader understands why the user filter is unconditional. Without this, someone "cleaning up" the unconditional pass might re-introduce the leak.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
