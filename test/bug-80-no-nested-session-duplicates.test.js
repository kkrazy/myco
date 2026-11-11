// bug-80: sidebar shows the same session twice when one session's
// `cwd` lives INSIDE another session's workspace.
//
// User report (2026-06-09):
//   "Sidebar lists the same session twice — once under its bare name
//    and once under a <session directory>/<session name> path.
//    `my-kkrazy-4xf7dcac/omni-cache` is rendered as a separate entry
//    even though it is the same session as `omni-cache`."
//
// Root cause: importExistingTranscripts (sessions.js:1221) walks the
// workspace for `.claude/projects/*.jsonl` and registers a fresh
// session record for each discovered cwd it doesn't already have —
// using `cwd: userRel` (the full relative path under the user's
// workspace root, NOT the basename). It does not check whether the
// discovered cwd lives INSIDE another already-registered session's
// workspace.
//
// So a subagent (or the user) running claude from
//   /wks/<user>/<parent-id>/<sub>/
// writes a transcript there, and the next importExistingTranscripts
// auto-creates a SECOND registry entry pointing into the parent's
// workspace. Sidebar renders both with the same display name (basename
// extraction) and the user sees a duplicate.
//
// Fix (two halves):
//   1. _findEnclosingSession(absCwd, store) — helper that returns the
//      registered session record whose absCwd is a proper ancestor of
//      the given path (null if no such ancestor).
//   2. importExistingTranscripts skip-child guard — call the helper
//      before registering a discovered cwd; skip + log if non-null.
//   3. _normalizeNestedSessions(store) — boot-time scan that removes
//      entries whose absCwd lives inside another entry's absCwd.
//      Called from loadStore() on first load so existing dirty stores
//      get cleaned automatically.
//
// Test shape: static guards on sessions.js + runtime guards that wire
// up fake stores + temp filesystem layouts.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}
async function tAsync(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-80: no nested-session duplicates ──');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guards on sessions.js
// ─────────────────────────────────────────────────────────────────

const SESSIONS_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'sessions.js'), 'utf8');

t('sessions.js: _findEnclosingSession helper is defined', () => {
  assert.ok(/function\s+_findEnclosingSession\s*\(/.test(SESSIONS_JS),
    'bug-80: sessions.js must define a _findEnclosingSession(absCwd, store) helper — used by both importExistingTranscripts (skip guard) and _normalizeNestedSessions (cleanup scan) to decide whether a path lives inside another registered session\'s workspace.');
});

t('sessions.js: importExistingTranscripts calls the skip guard before registering a new entry', () => {
  const at = SESSIONS_JS.search(/async\s+function\s+importExistingTranscripts\s*\(/);
  assert.ok(at > -1, 'importExistingTranscripts must exist');
  const body = sliceFn(SESSIONS_JS, at);
  assert.ok(/_findEnclosingSession\s*\(/.test(body),
    'bug-80: importExistingTranscripts must call _findEnclosingSession on each discovered cwd before registering. Without the guard, a transcript that lives inside a parent session\'s workspace registers as a duplicate sidebar entry — exactly the bug-80 user report.');
});

t('sessions.js: _normalizeNestedSessions(store) cleanup helper is defined', () => {
  assert.ok(/function\s+_normalizeNestedSessions\s*\(/.test(SESSIONS_JS),
    'bug-80: sessions.js must define _normalizeNestedSessions(store) — the boot-time scan that removes entries whose absCwd lives inside another entry\'s absCwd. Without this, users whose stores were already polluted (like the bug-80 reporter) keep seeing duplicate sidebar entries until they manually delete them.');
});

t('sessions.js: loadStore calls _normalizeNestedSessions on first load (boot-time cleanup)', () => {
  const at = SESSIONS_JS.search(/function\s+loadStore\s*\(/);
  assert.ok(at > -1, 'loadStore must exist');
  const body = sliceFn(SESSIONS_JS, at);
  assert.ok(/_normalizeNestedSessions\s*\(/.test(body),
    'bug-80: loadStore must call _normalizeNestedSessions(store) on first load so existing polluted stores get cleaned automatically at server boot. Without this, the fix only prevents NEW duplicates — the user\'s existing duds keep showing in the sidebar.');
});

// ─────────────────────────────────────────────────────────────────
// PART B — Runtime: helper semantics + import skip + boot cleanup
// ─────────────────────────────────────────────────────────────────

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug80-'));
process.env.MYCO_WORKSPACE = path.join(TMP_ROOT, 'wks');
process.env.MYCO_STATE_DIR = path.join(TMP_ROOT, 'state');
process.env.HOME = path.join(TMP_ROOT, 'home');
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
process.on('exit', () => { try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {} });

for (const k of Object.keys(require.cache)) {
  if (/server\/src\/(sessions)\.js$/.test(k)) delete require.cache[k];
}

t('_findEnclosingSession: child path → returns the enclosing parent record', () => {
  const sessions = require('../server/src/sessions');
  const helper = sessions._findEnclosingSession;
  assert.ok(typeof helper === 'function', '_findEnclosingSession must be exported for direct test access');
  const store = {
    sessions: {
      'myco-tester-parent': { id: 'myco-tester-parent', absCwd: '/wks/tester/myco-tester-parent', user: 'tester' },
    },
  };
  const enclosing = helper('/wks/tester/myco-tester-parent/sub/dir', store);
  assert.ok(enclosing,
    'bug-80: _findEnclosingSession must return the parent record when the given path is a strict descendant of the parent\'s absCwd.');
  assert.strictEqual(enclosing.id, 'myco-tester-parent',
    'bug-80: _findEnclosingSession must return the correct enclosing parent record.');
});

t('_findEnclosingSession: same path as a registered session → returns null (not enclosing)', () => {
  const sessions = require('../server/src/sessions');
  const store = {
    sessions: {
      'myco-tester-x': { id: 'myco-tester-x', absCwd: '/wks/tester/myco-tester-x', user: 'tester' },
    },
  };
  const enclosing = sessions._findEnclosingSession('/wks/tester/myco-tester-x', store);
  assert.strictEqual(enclosing, null,
    'bug-80: a path EQUAL to a registered session\'s absCwd is the same session, not a child — _findEnclosingSession must return null. Otherwise the helper would treat every session as enclosing itself.');
});

t('_findEnclosingSession: sibling path → returns null', () => {
  const sessions = require('../server/src/sessions');
  const store = {
    sessions: {
      'myco-tester-a': { id: 'myco-tester-a', absCwd: '/wks/tester/myco-tester-a', user: 'tester' },
    },
  };
  const enclosing = sessions._findEnclosingSession('/wks/tester/myco-tester-b', store);
  assert.strictEqual(enclosing, null,
    'bug-80: a SIBLING path (same parent dir but different basename) is not enclosed — _findEnclosingSession must return null. Otherwise we\'d falsely collapse independent sessions.');
});

t('_normalizeNestedSessions: removes child entries whose absCwd lives inside another entry', () => {
  const sessions = require('../server/src/sessions');
  const normalize = sessions._normalizeNestedSessions;
  assert.ok(typeof normalize === 'function', '_normalizeNestedSessions must be exported');
  const store = {
    sessions: {
      'myco-tester-parent':   { id: 'myco-tester-parent', user: 'tester', cwd: 'myco-tester-parent',           absCwd: '/wks/tester/myco-tester-parent' },
      'myco-tester-child':    { id: 'myco-tester-child',  user: 'tester', cwd: 'myco-tester-parent/sub',       absCwd: '/wks/tester/myco-tester-parent/sub' },
      'myco-tester-sibling':  { id: 'myco-tester-sibling',user: 'tester', cwd: 'myco-tester-sibling',          absCwd: '/wks/tester/myco-tester-sibling' },
    },
  };
  const removed = normalize(store);
  assert.ok(Array.isArray(removed) && removed.includes('myco-tester-child'),
    `bug-80: _normalizeNestedSessions must remove (and report) the child entry. Got removed=${JSON.stringify(removed)}`);
  assert.ok(!store.sessions['myco-tester-child'],
    'bug-80: _normalizeNestedSessions must delete the child entry from store.sessions in place.');
  assert.ok(store.sessions['myco-tester-parent'],
    'bug-80: the parent must NOT be removed — it\'s the canonical session.');
  assert.ok(store.sessions['myco-tester-sibling'],
    'bug-80: a sibling-at-same-level entry must NOT be removed.');
});

t('_normalizeNestedSessions: no-op on a clean store (returns [])', () => {
  const sessions = require('../server/src/sessions');
  const store = {
    sessions: {
      'myco-tester-a': { id: 'myco-tester-a', user: 'tester', cwd: 'myco-tester-a', absCwd: '/wks/tester/myco-tester-a' },
      'myco-tester-b': { id: 'myco-tester-b', user: 'tester', cwd: 'myco-tester-b', absCwd: '/wks/tester/myco-tester-b' },
    },
  };
  const removed = sessions._normalizeNestedSessions(store);
  assert.deepStrictEqual(removed, [],
    'bug-80: _normalizeNestedSessions must return [] on a clean store with no nested entries.');
  assert.strictEqual(Object.keys(store.sessions).length, 2,
    'bug-80: _normalizeNestedSessions must not touch a clean store.');
});

t('loadStore: a polluted store on disk gets normalized on first load', () => {
  const STATE_FILE = path.join(process.env.MYCO_STATE_DIR, 'sessions.json');
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    sessions: {
      'myco-tester-parent':   { id: 'myco-tester-parent', user: 'tester', cwd: 'myco-tester-parent',     absCwd: path.join(process.env.MYCO_WORKSPACE, 'tester', 'myco-tester-parent') },
      'myco-tester-child':    { id: 'myco-tester-child',  user: 'tester', cwd: 'myco-tester-parent/sub', absCwd: path.join(process.env.MYCO_WORKSPACE, 'tester', 'myco-tester-parent', 'sub') },
    },
  }));
  // Re-require sessions so loadStore re-reads from disk via a fresh
  // module cache.
  for (const k of Object.keys(require.cache)) {
    if (/server\/src\/(sessions)\.js$/.test(k)) delete require.cache[k];
  }
  const sessions = require('../server/src/sessions');
  const store = sessions.loadStore();
  assert.ok(!store.sessions['myco-tester-child'],
    'bug-80: loadStore must call _normalizeNestedSessions on first load so existing polluted on-disk stores get cleaned. Pre-fix the child entry would survive the load and keep showing in the sidebar.');
  assert.ok(store.sessions['myco-tester-parent'],
    'bug-80: the parent must survive the load — only the child orphan gets removed.');
});

// ─────────────────────────────────────────────────────────────────
// PART C — importExistingTranscripts skip-child end-to-end
// ─────────────────────────────────────────────────────────────────

(async () => {
  await tAsync('importExistingTranscripts: skips transcripts whose cwd lives inside a registered session', async () => {
    // Fresh module cache + clean state dir.
    fs.rmSync(path.join(process.env.MYCO_STATE_DIR, 'sessions.json'), { force: true });
    for (const k of Object.keys(require.cache)) {
      if (/server\/src\/(sessions)\.js$/.test(k)) delete require.cache[k];
    }
    const sessions = require('../server/src/sessions');

    // Seed: parent session at /wks/tester/myco-tester-bug80parent/.
    const parentAbs = path.join(process.env.MYCO_WORKSPACE, 'tester', 'myco-tester-bug80parent');
    fs.mkdirSync(parentAbs, { recursive: true });
    const store = sessions.loadStore();
    store.sessions['myco-tester-bug80parent'] = {
      id: 'myco-tester-bug80parent',
      user: 'tester',
      cwd: 'myco-tester-bug80parent',
      absCwd: parentAbs,
      createdAt: new Date().toISOString(),
    };
    sessions.saveStore();

    // Stage a .claude/projects transcript that points at a SUB-directory
    // of the parent session's workspace — the exact bug-80 repro.
    // Claude's project-dir mangles slashes → dashes; we mirror that.
    const subAbsCwd = path.join(parentAbs, 'sub-child');
    fs.mkdirSync(subAbsCwd, { recursive: true });
    const claudeProjectsDir = path.join(process.env.HOME, '.claude', 'projects', subAbsCwd.replace(/\//g, '-'));
    fs.mkdirSync(claudeProjectsDir, { recursive: true });
    const claudeId = '00000000-0000-4000-8000-000000000080';
    const jsonlPath = path.join(claudeProjectsDir, `${claudeId}.jsonl`);
    // Minimal jsonl with a "cwd" line so readCwdFromTranscript can
    // recover the original cwd. The format is one JSON object per line.
    fs.writeFileSync(jsonlPath, JSON.stringify({ cwd: subAbsCwd, type: 'summary' }) + '\n');

    const before = Object.keys(store.sessions).length;
    const imported = await sessions.importExistingTranscripts();
    const after = Object.keys(store.sessions).length;
    assert.strictEqual(imported, 0,
      `bug-80: importExistingTranscripts must skip the child transcript (it lives inside the parent's workspace). Pre-fix it imported a new record — exactly the bug-80 duplicate. Got imported=${imported}.`);
    assert.strictEqual(after, before,
      `bug-80: store.sessions count must NOT grow when the only discovered transcript is inside an existing session's workspace. before=${before}, after=${after}.`);
  });

  console.log(`── bug-80: ${passed} passed, ${failed} failed ──`);
  process.exit(failed === 0 ? 0 : 1);
})();
