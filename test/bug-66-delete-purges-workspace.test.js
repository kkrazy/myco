// bug-66 regression: deleting a session must purge its workspace
// directory from disk.
//
// User report (bug-66): Create → delete → create-again of a session
// for the same project fails with
//   fatal: destination path '/wks/<user>/<id>/myco' already exists
//   and is not an empty directory.
// → git clone exits 128.
//
// Root cause: deleteSession (server/src/sessions.js) only kills the
// agent + removes the registry entry from /data/sessions.json. The
// workspace dir at /wks/<user>/<id>/ stays on disk forever. Beyond
// the user's specific same-id collision, every delete chronically
// leaks a dir; `ls /wks/<user>/` already shows ~20 orphan
// `myco-<user>-*` dirs predating the fix.
//
// Fix: _removeWorkspaceForDeletedSession(rec) helper invoked from
// deleteSession AFTER the registry entry is dropped. Defensive
// guards refuse to act outside userRoot(rec.user) or when the
// basename doesn't match `myco-<rec.user>-<8 hex>` (the
// id-as-folder shape from spawnSession). Best-effort transcript-
// mirror cleanup. Never throws.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-66: delete-session must purge workspace dir ──');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guards. Cheap, run even when the rest of the
// suite can't (e.g., no docker). Pins the fix's shape so a future
// refactor can't silently remove it.
// ─────────────────────────────────────────────────────────────────

const SESSIONS_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'sessions.js'), 'utf8');

t('helper _removeWorkspaceForDeletedSession is defined in sessions.js', () => {
  assert.ok(/function\s+_removeWorkspaceForDeletedSession\s*\(\s*rec\s*\)/.test(SESSIONS_JS),
    'helper function definition must exist with signature `_removeWorkspaceForDeletedSession(rec)`');
});

t('deleteSession body calls the helper after removeSession', () => {
  // Extract the deleteSession function body.
  const m = SESSIONS_JS.match(/function\s+deleteSession\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'deleteSession must be a function declaration');
  const body = m[1];
  // Required call sequence — kill, snapshot, remove, purge.
  // Match the actual CALL sites, not prose mentions in the surrounding
  // comments (the comments above the calls reference these symbols by
  // name, so a bare indexOf finds the comment first).
  const kIdx = body.search(/ptyMod\.killSession\s*\(\s*sessionId\s*\)/);
  const snapIdx = body.search(/getSessionRecord\s*\(\s*sessionId\s*\)/);
  const removeIdx = body.search(/(?<!_)removeSession\s*\(\s*sessionId\s*\)/);
  const purgeIdx = body.search(/_removeWorkspaceForDeletedSession\s*\(\s*rec\s*\)/);
  assert.ok(kIdx > -1, 'deleteSession must call ptyMod.killSession');
  assert.ok(snapIdx > -1, 'deleteSession must snapshot rec via getSessionRecord');
  assert.ok(removeIdx > -1, 'deleteSession must call removeSession to drop the registry entry');
  assert.ok(purgeIdx > -1, 'deleteSession must call _removeWorkspaceForDeletedSession to purge disk');
  // Ordering: snapshot BEFORE removeSession (we need rec.absCwd before
  // the registry entry vanishes) and purge AFTER removeSession.
  assert.ok(snapIdx < removeIdx,
    'getSessionRecord must run BEFORE removeSession — otherwise rec.absCwd is lost');
  assert.ok(removeIdx < purgeIdx,
    '_removeWorkspaceForDeletedSession must run AFTER removeSession — registry drops first, disk last');
});

t('helper enforces the userRoot path boundary', () => {
  // The safety check must compare path.resolve(absCwd) against
  // path.resolve(userRoot(...)) + path.sep. Anything weaker (e.g.
  // bare startsWith without path.sep) lets `/wks/kkrazy-evil/...`
  // pass when the user is `kkrazy`.
  assert.ok(/path\.resolve\(\s*userRoot\(/.test(SESSIONS_JS),
    'helper must resolve userRoot for the path boundary check');
  assert.ok(/startsWith\(\s*root\s*\+\s*path\.sep\s*\)/.test(SESSIONS_JS),
    'helper must guard with `startsWith(root + path.sep)` — prefix-match without the separator is unsafe');
});

t('helper enforces the basename id-shape with user binding', () => {
  // The basename regex must bind the user segment (so a forged
  // rec where absCwd points into another user's tree is rejected).
  // We grep for the user-bound RegExp construction.
  assert.ok(/myco-\$\{user\.replace/.test(SESSIONS_JS),
    'helper must interpolate the rec.user into the basename regex so a forged rec cannot cross users');
  assert.ok(/\[0-9a-f\]\{8\}/.test(SESSIONS_JS),
    'helper must match the 8-hex shortId tail (matches the id format from spawnSession)');
});

t('helper calls fs.rmSync with recursive + force', () => {
  assert.ok(/fs\.rmSync\(\s*absCwd\s*,\s*\{[^}]*recursive:\s*true[^}]*force:\s*true[^}]*\}\s*\)/.test(SESSIONS_JS),
    'helper must rm the workspace recursively with force:true so a non-empty dir purges cleanly');
});

t('helper has try/catch wrappers — never throws', () => {
  // Extract the helper body and count try/catch blocks.
  const m = SESSIONS_JS.match(/function\s+_removeWorkspaceForDeletedSession\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'helper body must be greppable');
  const body = m[1];
  const tryCount = (body.match(/\btry\s*\{/g) || []).length;
  assert.ok(tryCount >= 2,
    'helper must have ≥2 try/catch blocks (one around fs.rmSync(absCwd), one around the transcript-mirror cleanup) so a partial failure never throws past the caller');
});

t('helper drops the legacy SDK transcript mirror best-effort', () => {
  assert.ok(/projectsDir\(\s*\)/.test(SESSIONS_JS) && /encodeCwdForClaude\(\s*absCwd\s*\)/.test(SESSIONS_JS),
    'helper must compute the legacy transcript-mirror path via projectsDir() + encodeCwdForClaude(absCwd)');
});

t('deleteSession is annotated with the owner-only caller contract', () => {
  // The JSDoc immediately above deleteSession must state the
  // owner-only contract explicitly so future internal callers know
  // they need to enforce it themselves.
  const idx = SESSIONS_JS.indexOf('function deleteSession');
  assert.ok(idx > -1);
  const preamble = SESSIONS_JS.slice(Math.max(0, idx - 600), idx);
  assert.ok(/owner-?only|verify ownership|sessionBelongsToUser/i.test(preamble),
    'deleteSession must have a comment block above it explicitly stating the owner-only caller contract');
});

// ─────────────────────────────────────────────────────────────────
// PART B — Runtime behavior. Override MYCO_WORKSPACE +
// MYCO_STATE_DIR + HOME so the sessions module operates inside a
// throwaway tempdir. Construct a fake session record via putSession
// (no real SDK spawn), then call deleteSession and assert the disk
// effect.
// ─────────────────────────────────────────────────────────────────

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug66-'));
const TMP_WKS = path.join(TMP_ROOT, 'wks');
const TMP_STATE = path.join(TMP_ROOT, 'state');
const TMP_HOME = path.join(TMP_ROOT, 'home');
fs.mkdirSync(TMP_WKS, { recursive: true });
fs.mkdirSync(TMP_STATE, { recursive: true });
fs.mkdirSync(TMP_HOME, { recursive: true });

// Env overrides MUST be set before requiring sessions.js — WORKSPACE
// is computed once at module load from process.env.MYCO_WORKSPACE.
process.env.MYCO_WORKSPACE = TMP_WKS;
process.env.MYCO_STATE_DIR = TMP_STATE;
process.env.HOME = TMP_HOME;

// Drop any prior cached require of sessions/attach so the env
// overrides take effect on this fresh require.
for (const k of Object.keys(require.cache)) {
  if (/server\/src\/(sessions|attach|agent-session|menu|btw|transcript)\.js$/.test(k)) {
    delete require.cache[k];
  }
}

const sessions = require('../server/src/sessions');

// Cleanup on process exit so a failure mid-test doesn't leave dirs
// littering /tmp.
process.on('exit', () => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

// Synthesize a session record. id-as-folder shape: `myco-<user>-<8 hex>`.
function fakeSessionRec(user = 'tester', shortId = 'deadbeef') {
  const id = `myco-${user}-${shortId}`;
  const absCwd = path.join(TMP_WKS, user, id);
  const cwd = id; // relative to user root
  fs.mkdirSync(absCwd, { recursive: true });
  return {
    id, user, cwd, absCwd,
    label: null, claudeSessionId: null,
    createdAt: new Date().toISOString(), mode: 'agent',
  };
}

t('deleteSession purges the workspace dir + clears the registry', () => {
  const rec = fakeSessionRec('tester', 'aabbccdd');
  // Populate the workspace with a "project" subdir + a marker file
  // to mimic a real clone target. The fix must purge the WHOLE
  // tree, not just the wrapper.
  const projectDir = path.join(rec.absCwd, 'myco');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'marker.txt'), 'leftover from cloned project');
  // Register in the store via the public API.
  const store = sessions.loadStore();
  store.sessions[rec.id] = rec;
  sessions.saveStore();
  // Sanity preconditions.
  assert.ok(fs.existsSync(rec.absCwd), 'precondition: workspace dir exists');
  assert.ok(fs.existsSync(projectDir), 'precondition: project subdir exists');
  assert.strictEqual(sessions.getSessionRecord(rec.id)?.id, rec.id,
    'precondition: registry entry exists');
  // The fix in action.
  sessions.deleteSession(rec.id);
  // Post-conditions.
  assert.strictEqual(sessions.getSessionRecord(rec.id), null,
    'registry entry must be gone after deleteSession');
  assert.strictEqual(fs.existsSync(rec.absCwd), false,
    'workspace dir must be removed from disk after deleteSession');
  assert.strictEqual(fs.existsSync(projectDir), false,
    'project subdir must be removed as part of the recursive purge');
  // Parent user root must NOT be wiped — the helper only targets
  // the session's own absCwd, never its parent.
  assert.strictEqual(fs.existsSync(path.join(TMP_WKS, 'tester')), true,
    'parent user-root must still exist (helper must not wipe the user\'s entire workspace)');
});

t('helper refuses absCwd outside userRoot (no traversal)', () => {
  // Forge a rec whose user is `tester` but whose absCwd points into
  // /etc. The helper must refuse — even though /etc/myco-tester-aabbccdd
  // would never naturally exist, the safety check must reject it.
  const forged = {
    id: 'myco-tester-aabbccdd',
    user: 'tester',
    absCwd: '/etc/myco-tester-aabbccdd',
  };
  // Capture warnings so we can confirm the refusal log fired.
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    sessions._removeWorkspaceForDeletedSession(forged);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(fs.existsSync('/etc'), '/etc must still exist (the refusal must short-circuit before rm)');
  assert.ok(warnings.some((w) => /refusing to rm.*outside/.test(w)),
    'helper must log a `refusing to rm ... outside` warning when absCwd is outside userRoot');
});

t('helper refuses when basename doesn\'t match id-shape (legacy hand-named cwd)', () => {
  // A pre-id-as-folder session whose absCwd is a hand-named path
  // like `test006` must be left alone — the helper only acts on
  // the `myco-<user>-<8 hex>` shape.
  const legacyAbs = path.join(TMP_WKS, 'tester', 'test006');
  fs.mkdirSync(legacyAbs, { recursive: true });
  fs.writeFileSync(path.join(legacyAbs, 'precious.txt'), 'user data — do not delete');
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    sessions._removeWorkspaceForDeletedSession({
      id: 'test006', user: 'tester', absCwd: legacyAbs,
    });
  } finally {
    console.warn = origWarn;
  }
  assert.strictEqual(fs.existsSync(legacyAbs), true,
    'legacy hand-named cwd must NOT be removed');
  assert.strictEqual(fs.existsSync(path.join(legacyAbs, 'precious.txt')), true,
    'legacy cwd contents must be preserved');
  assert.ok(warnings.some((w) => /refusing to rm.*basename not id-shape/.test(w)),
    'helper must log a `refusing to rm ... basename not id-shape` warning for legacy paths');
});

t('helper refuses when basename user-segment doesn\'t match rec.user (forged rec)', () => {
  // absCwd points into a path whose basename user-segment is
  // `alice` but rec.user is `bob`. The user-bound regex must reject.
  const aliceDir = path.join(TMP_WKS, 'bob', 'myco-alice-aabbccdd');
  fs.mkdirSync(aliceDir, { recursive: true });
  fs.writeFileSync(path.join(aliceDir, 'sentinel.txt'), 'cross-user forge');
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    sessions._removeWorkspaceForDeletedSession({
      id: 'myco-alice-aabbccdd', user: 'bob', absCwd: aliceDir,
    });
  } finally {
    console.warn = origWarn;
  }
  assert.strictEqual(fs.existsSync(aliceDir), true,
    'forged cross-user rec must NOT be removed (basename user-segment must match rec.user)');
  assert.strictEqual(fs.existsSync(path.join(aliceDir, 'sentinel.txt')), true,
    'forged cross-user contents must be preserved');
  assert.ok(warnings.some((w) => /refusing to rm.*basename not id-shape/.test(w)),
    'helper must log the basename-mismatch warning for forged cross-user rec');
});

t('helper is a no-op for missing/empty absCwd (never throws)', () => {
  // Each of these should return silently — no warning needed, just
  // an early return.
  assert.doesNotThrow(() => sessions._removeWorkspaceForDeletedSession(null));
  assert.doesNotThrow(() => sessions._removeWorkspaceForDeletedSession({}));
  assert.doesNotThrow(() => sessions._removeWorkspaceForDeletedSession({ user: 'tester' }));
  assert.doesNotThrow(() => sessions._removeWorkspaceForDeletedSession({ user: 'tester', absCwd: '' }));
  assert.doesNotThrow(() => sessions._removeWorkspaceForDeletedSession({ user: 'tester', absCwd: 123 }));
});

t('user\'s exact repro: spawn-shape → delete → fresh-spawn-shape lands an empty dir', () => {
  // The user's repro: clone target dir leftover after delete blocks
  // the re-clone. Simulated without real git spawn — we just check
  // that after deleteSession, the path is reclaimable as an empty
  // dir (mkdir succeeds, no children).
  const rec = fakeSessionRec('tester', 'cafef00d');
  const projectDir = path.join(rec.absCwd, 'myco');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'config.json'), '{"first-clone": true}');
  const store = sessions.loadStore();
  store.sessions[rec.id] = rec;
  sessions.saveStore();
  // First lifecycle: delete.
  sessions.deleteSession(rec.id);
  assert.strictEqual(fs.existsSync(rec.absCwd), false,
    'workspace dir must be gone — pre-fix this is what blocked the re-clone');
  // Second lifecycle: a new session at the SAME path (worst-case
  // collision) must land an empty dir that `git clone` would accept.
  fs.mkdirSync(rec.absCwd, { recursive: true });
  const reclaim = path.join(rec.absCwd, 'myco');
  fs.mkdirSync(reclaim, { recursive: true });
  assert.deepStrictEqual(fs.readdirSync(reclaim), [],
    're-created project dir must be empty — git clone <url> <empty-dir> succeeds');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
