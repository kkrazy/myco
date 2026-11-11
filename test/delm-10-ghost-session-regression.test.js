// delm-10 regression: kkrazy reported that after refreshing the page
// (or coming back later), sessions that were NOT his — and sessions he
// had already deleted/closed — reappeared in the sidebar.
//
// Two root causes, both fixed and both locked here:
//
//  1. DELETED SESSIONS CAME BACK (resurrection via auto-import).
//     removeSession() only recorded rec.absCwd in dismissed[], but the
//     agent usually runs at <absCwd>/<mainProject> (resolveAgentCwd),
//     which leaves a second transcript mirror under ~/.claude/projects/.
//     importExistingTranscripts only exact-matched the transcript cwd
//     against dismissed[], so the deeper mirror re-registered the
//     deleted session on the next boot / refresh.
//     Fix: removeSession also dismisses the resolved agent cwd, and
//     importExistingTranscripts refuses any cwd UNDER a dismissed root
//     (_isUnderDismissedCwd — prefix-aware, covers subagent mirrors).
//
//  2. FOREIGN SESSIONS LEAKED (unauthenticated /sessions listing).
//     GET /sessions called listSessions(isAuthRequired() ? user : null)
//     — in auth-bypass deployments (or any moment the browser's token
//     was missing) forUser was null and listSessions(null) returns
//     EVERY session in the store, rendered as "shared" ghosts.
//     Fix: the route now always passes the resolved user.
//
// r2 (worker-B, live-verified with a booting server): two MORE leaks
// the first pass missed, both also fixed and locked here:
//
//  3. GLOBAL_OWNER_USERS carve-out. sessions.js resolveAccessTier
//     granted {'labxnow','kkrazy','ryan-blues'} owner tier on EVERY
//     session, so kkrazy's listSessions filter passed every owner's
//     sessions — the primary "sessions that aren't mine" symptom, no
//     share tokens involved at all. Fix: kkrazy removed from the Set
//     (labxnow/ryan-blues stay; bug-47 r3 deliberately preserved them).
//
//  4. UNCHECKED share-token branch. GET /sessions's ?share= loop listed
//     any session whose id matched the token with NO access check.
//     The client keeps share tokens (== session ids) forever in
//     localStorage and replays them every poll, so a deleted session
//     whose id ever matched (or a foreign id from an old /?s= URL)
//     re-appeared as shared:true after every refresh — the "session I
//     closed came back" symptom. Fix: the branch now requires
//     resolveAccessTier(sessionId, user) !== null for authed users.
//
// Test shape: runtime guards against a temp state dir (mirrors the
// bug-80 test harness) + static-grep guards on the prod sources.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fnBody, sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}
async function tAsync(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── delm-10: ghost-session regression (deleted + foreign sessions) ──');

// Isolated state + workspace per run (test.sh convention: own your state).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-delm10-ghost-'));
process.env.MYCO_STATE_DIR = path.join(TMP, 'state');
process.env.MYCO_WORKSPACE = path.join(TMP, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

const SESSIONS_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'sessions.js'), 'utf8');
const INDEX_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');
const APP_JS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

// ── PART A: static guards ───────────────────────────────────────────────────

t('sessions.js defines _isUnderDismissedCwd (prefix-aware dismissal check)', () => {
  assert.ok(/function\s+_isUnderDismissedCwd\s*\(/.test(SESSIONS_JS),
    'delm-10: sessions.js must define _isUnderDismissedCwd(cwd, store) — exact-match dismissal lets deleted sessions resurrect from deeper transcript mirrors.');
});

t('importExistingTranscripts calls _isUnderDismissedCwd before registering', () => {
  const body = fnBody(SESSIONS_JS, /async\s+function\s+importExistingTranscripts\s*\(/);
  assert.ok(/_isUnderDismissedCwd\s*\(\s*cwd\s*,\s*store\s*\)/.test(body),
    'delm-10: importExistingTranscripts must refuse transcripts under a dismissed workspace — pre-fix a deleted session\'s <absCwd>/<mainProject> mirror re-imported it on the next boot.');
});

t('removeSession dismisses the resolved agent cwd too', () => {
  const body = fnBody(SESSIONS_JS, /function\s+removeSession\s*\(/);
  assert.ok(/resolveAgentCwd\s*\(\s*rec\s*\)/.test(body),
    'delm-10: removeSession must push resolveAgentCwd(rec) into dismissed[] — the agent\'s transcript mirror lives at <absCwd>/<mainProject>, not at absCwd.');
});

t('GET /sessions never passes null to listSessions under the auth\'d branch', () => {
  const at = INDEX_JS.indexOf("app.get('/sessions'");
  assert.ok(at > -1, 'GET /sessions route must exist');
  const window = INDEX_JS.slice(at, at + 2500);
  assert.ok(/listSessions\(\s*user\b/.test(window),
    'delm-10: GET /sessions must call listSessions(user) unconditionally — listSessions(null) returns every session in the store (the foreign-session ghost leak).');
  assert.ok(!/listSessions\(\s*isAuthRequired\(\)\s*\?\s*user\s*:\s*null/.test(window),
    'delm-10: the old isAuthRequired() ? user : null ternary must be gone — the auth-bypass path leaked every owner\'s sessions.');
});

t('client drops cached share tokens for a deleted session', () => {
  const at = APP_JS.search(/async\s+function\s+deleteSessionWithConfirm\s*\(/);
  assert.ok(at > -1, 'deleteSessionWithConfirm must exist in app.js');
  const body = sliceFn(APP_JS, at);
  assert.ok(/removeShareToken/.test(body),
    'delm-10: deleteSessionWithConfirm must purge localStorage myco_shares entries pointing at the deleted session — otherwise refreshSessions keeps re-requesting the dead id and the ghost re-renders on reload.');
});

// ── PART B: runtime guards ──────────────────────────────────────────────────

const sessions = require('../server/src/sessions');

t('_isUnderDismissedCwd: true for equal, child, and deep paths; false for siblings', () => {
  const store = { dismissed: ['/wks/kkrazy/myco-kkrazy-deadbeef'] };
  assert.strictEqual(sessions._isUnderDismissedCwd('/wks/kkrazy/myco-kkrazy-deadbeef', store), true,
    'exact match must be dismissed (pre-existing behavior preserved)');
  assert.strictEqual(sessions._isUnderDismissedCwd('/wks/kkrazy/myco-kkrazy-deadbeef/myproj', store), true,
    'the <absCwd>/<mainProject> agent cwd must count as dismissed — this is the resurrection path');
  assert.strictEqual(sessions._isUnderDismissedCwd('/wks/kkrazy/myco-kkrazy-deadbeef/sub/agent', store), true,
    'deep subagent transcript cwds must count as dismissed');
  assert.strictEqual(sessions._isUnderDismissedCwd('/wks/kkrazy/other-session', store), false,
    'a sibling session must NOT be dismissed');
  assert.strictEqual(sessions._isUnderDismissedCwd('/wks/otheruser/myco-kkrazy-deadbeef', store), false,
    'a same-basename path under another user must NOT be dismissed');
  assert.strictEqual(sessions._isUnderDismissedCwd(null, store), false,
    'null cwd must be false (defensive)');
});

t('removeSession records both absCwd and the agent cwd in dismissed[]', () => {
  fs.rmSync(path.join(process.env.MYCO_STATE_DIR, 'sessions.json'), { force: true });
  const absCwd = path.join(process.env.MYCO_WORKSPACE, 'kkrazy', 'myco-kkrazy-dead0001');
  fs.mkdirSync(absCwd, { recursive: true });
  sessions.putSession({
    id: 'myco-kkrazy-dead0001', user: 'kkrazy', cwd: 'myco-kkrazy-dead0001',
    absCwd, mainProject: 'myproj', createdAt: new Date().toISOString(),
  });
  sessions.removeSession('myco-kkrazy-dead0001');
  const store = sessions.loadStore();
  assert.ok(store.dismissed.includes(absCwd), 'absCwd must be dismissed');
  assert.ok(store.dismissed.includes(path.join(absCwd, 'myproj')),
    `resolveAgentCwd(rec) (<absCwd>/myproj) must ALSO be dismissed — pre-fix the main-project transcript mirror resurrected the session. dismissed=${JSON.stringify(store.dismissed)}`);
  assert.ok(!store.sessions['myco-kkrazy-dead0001'], 'registry entry must be gone');
});

(async () => {
  // ── r2: GLOBAL_OWNER_USERS carve-out no longer includes kkrazy ──

  t('r2: GLOBAL_OWNER_USERS no longer contains kkrazy (foreign-session ghost)', () => {
    // Strip comments first — the Set's doc-comment mentions kkrazy in
    // prose (same discipline as bug-47 r3's carve-out count check).
    const stripped = SESSIONS_JS
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const m = stripped.match(/GLOBAL_OWNER_USERS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    assert.ok(m, 'GLOBAL_OWNER_USERS Set must still exist (bug-47 r3 single-source carve-out)');
    assert.ok(!/['"`]kkrazy['"`]/.test(m[1]),
      `kkrazy must NOT be in GLOBAL_OWNER_USERS — the carve-out granted him owner tier on EVERY session, so his sidebar listed other users' sessions. Set=${m[1]}`);
    assert.ok(!/['"`]labxnow['"`]/.test(m[1]),
      'labxnow must NOT be in GLOBAL_OWNER_USERS (r3 2026-10-21: carve-out retired entirely; explicit ACL (/share, /admin) is the only cross-user access path)');
    assert.ok(!/['"`]ryan-blues['"`]/.test(m[1]),
      'ryan-blues must NOT be in GLOBAL_OWNER_USERS (r3 2026-10-21: carve-out retired entirely)');
  });

  t('r2: resolveAccessTier gives kkrazy NO tier on a foreign session', () => {
    fs.rmSync(path.join(process.env.MYCO_STATE_DIR, 'sessions.json'), { force: true });
    const absCwd = path.join(process.env.MYCO_WORKSPACE, 'alice', 'myco-alice-aaaaaaaa');
    fs.mkdirSync(absCwd, { recursive: true });
    sessions.putSession({
      id: 'myco-alice-aaaaaaaa', user: 'alice', cwd: 'alice/myco-alice-aaaaaaaa',
      absCwd, createdAt: new Date().toISOString(),
    });
    assert.strictEqual(sessions.resolveAccessTier('myco-alice-aaaaaaaa', 'kkrazy'), null,
      'kkrazy has no explicit ACL grant, so with the carve-out removed he must get null tier — pre-fix he got \'owner\' and his sidebar listed alice\'s session');
    assert.strictEqual(sessions.resolveAccessTier('myco-alice-aaaaaaaa', 'alice'), 'owner',
      'sanity: the real owner still gets owner tier');
    // Explicit ACL grants still work for kkrazy (the intended path).
    const rec = sessions.getSessionRecord('myco-alice-aaaaaaaa');
    rec.viewers = ['kkrazy'];
    sessions.putSession(rec);
    assert.strictEqual(sessions.resolveAccessTier('myco-alice-aaaaaaaa', 'kkrazy'), 'viewer',
      'an explicit /share grant must still give kkrazy viewer tier');
  });

  // ── r2: share-token branch is access-gated ──

  t('r2: GET /sessions share loop gates on resolveAccessTier', () => {
    const at = INDEX_JS.indexOf("app.get('/sessions'");
    assert.ok(at > -1, 'GET /sessions route must exist');
    // Window through the END of the route handler — anchored on the
    // route's final res.json line, not a fixed char count (a 5500-char
    // window truncated mid-comment when the r2 gate explanation grew,
    // silently dropping the assertion target).
    const jsonAt = INDEX_JS.indexOf('res.json([...own, ...sharedSessions]);', at);
    const window = INDEX_JS.slice(at, jsonAt > -1 ? jsonAt + 200 : at + 12000);
    const shareLoop = window.slice(window.indexOf('shareTokenInfo'));
    assert.ok(/resolveAccessTier\s*\(\s*info\.sessionId\s*,\s*user\s*\)/.test(shareLoop),
      'the ?share= loop must require resolveAccessTier(info.sessionId, user) — pre-fix any localStorage-persisted session id was listed as shared:true on every refresh, resurrecting deleted/foreign sessions');
    assert.ok(/continue\s*;/.test(shareLoop),
      'the access check must `continue` (skip) un-authorized share entries');
  });

  await tAsync('importExistingTranscripts refuses a transcript under a dismissed workspace', async () => {
    // Fresh module cache so loadStore re-reads the state file we stage.
    fs.rmSync(path.join(process.env.MYCO_STATE_DIR, 'sessions.json'), { force: true });
    for (const k of Object.keys(require.cache)) {
      // Normalise separators first: require.cache keys are `D:\...\server\src\sessions.js`
      // on Windows, so a `/`-only pattern silently matches nothing and the stale
      // storeCache survives — the re-staged sessions.json is then never read.
      if (/server\/src\/sessions\.js$/.test(k.split(path.sep).join('/'))) delete require.cache[k];
    }
    const s = require('../server/src/sessions');
    const deadRoot = path.join(process.env.MYCO_WORKSPACE, 'kkrazy', 'myco-kkrazy-dead0002');
    fs.mkdirSync(deadRoot, { recursive: true });
    // Store: the session was deleted (only dismissed[] remains) BUT a
    // transcript mirror survives under <deadRoot>/myproj — the exact
    // residue a delete leaves behind when the mirror purge misses it.
    fs.writeFileSync(path.join(process.env.MYCO_STATE_DIR, 'sessions.json'), JSON.stringify({
      sessions: {},
      dismissed: [deadRoot],
    }));
    const store = s.loadStore();
    assert.ok(Array.isArray(store.dismissed) && store.dismissed.includes(deadRoot), 'sanity: dismissed staged');

    const agentCwd = path.join(deadRoot, 'myproj');
    fs.mkdirSync(agentCwd, { recursive: true });
    const claudeProjectsDir = path.join(process.env.HOME, '.claude', 'projects', s.encodeCwdForClaude(agentCwd));
    fs.mkdirSync(claudeProjectsDir, { recursive: true });
    const claudeId = '00000000-0000-4000-8000-0000000000d1';
    fs.writeFileSync(path.join(claudeProjectsDir, `${claudeId}.jsonl`),
      JSON.stringify({ cwd: agentCwd, type: 'summary' }) + '\n');

    const imported = await s.importExistingTranscripts();
    assert.strictEqual(imported, 0,
      `delm-10: importExistingTranscripts must NOT resurrect the deleted session from its <absCwd>/<mainProject> transcript mirror. imported=${imported}`);
    assert.strictEqual(Object.keys(store.sessions).length, 0,
      'store must stay empty — the deleted session stays deleted');
  });

  console.log(`── delm-10: ${passed} passed, ${failed} failed ──`);
  process.exit(failed === 0 ? 0 : 1);
})();
