// Regression: k8s pod CrashLoopBackOff on 7.242.106.252 (2026-10-23).
// The pod's myco container died with:
//
//   /app/server/src/attach.js:2466
//     if (user !== ASSISTANT_USER) message.meta.fromUserInput = true;
//                                       ^
//   TypeError: Cannot set properties of undefined (setting 'fromUserInput')
//       at handleChatMessage (...)
//
// Root cause: the Delm n=1 input-history provenance fix (770634d)
// stamped `message.meta.fromUserInput` on the canonical user-typed
// path, but `message.meta` was never initialized for plain user rows —
// only the mention / clarify branches assigned `message.meta` later.
// A single ordinary chat message (no mention, no clarify) threw and
// the uncaught exception killed the whole Node server → the pod
// crash-looped on every restart (11+ restarts).
//
// Fix: initialize `message.meta` (empty object) at construction so
// every later `message.meta.<key>` / `Object.assign` write is safe.
//
// These tests exercise the REAL handleChatMessage with a stub session
// (same convention as test/team-runqueue.test.js) so the crash path —
// a plain non-mention, non-clarify user message — is executed
// end-to-end, plus a static guard pinning the meta-init line.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-k8s-crash-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

// Seed the allowlist BEFORE requiring attach.js so _detectMentionTarget's
// _isKnownChatUser check sees the fixture user (no mention false-positives).
fs.writeFileSync(
  path.join(process.env.MYCO_STATE_DIR, 'allowed-github-users.txt'),
  '# test fixture\ns00791175\n',
);

const sessionsMod = require('../server/src/sessions');
const attach = require('../server/src/attach');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── k8s crash fix: handleChatMessage must not throw on plain user rows ──');

function seedSession(sid) {
  const store = sessionsMod.loadStore();
  store.sessions = store.sessions || {};
  store.sessions[sid] = {
    id: sid,
    user: 's00791175',
    cwd: '.',
    absCwd: process.env.MYCO_WORKSPACE,
    createdAt: new Date().toISOString(),
    chat: [],
  };
  sessionsMod.saveStore();
}

// Minimal AgentSession stand-in: enough surface for handleChatMessage to
// persist the row, emit 'chat', and route to claude via .write (stubbed).
function stubSession() {
  const s = new EventEmitter();
  s.buffer = [];
  s.written = [];
  s.write = (txt) => s.written.push(txt);
  return s;
}

async function main() {
  await t('handleChatMessage: plain user message does NOT throw (the CrashLoopBackOff repro)', async () => {
    const sid = 'k8s-crash-plain';
    seedSession(sid);
    const session = stubSession();
    // Pre-fix this exact call threw:
    //   TypeError: Cannot set properties of undefined (setting 'fromUserInput')
    // and killed the server process. It must complete normally.
    attach.handleChatMessage(sid, session, 's00791175', '你好，今天天气怎么样');
    const rows = sessionsMod.getChatHistory(sid, {});
    assert.ok(Array.isArray(rows) && rows.length >= 1,
      `the plain user row must be persisted (got ${rows.length} rows) — pre-fix the process died before appendChatMessage`);
    const row = rows[rows.length - 1];
    assert.strictEqual(row.user, 's00791175', 'row carries the typing user');
    assert.ok(row.meta && row.meta.fromUserInput === true,
      'row must carry meta.fromUserInput:true — the flag the crash was trying to stamp');
  });

  await t('handleChatMessage: slash command does NOT throw on the uninitialized-meta path', async () => {
    const sid = 'k8s-crash-slash';
    seedSession(sid);
    const session = stubSession();
    // Slash rows go through the same message construction before the
    // startsWith('/') branch — they hit the fromUserInput stamp too.
    attach.handleChatMessage(sid, session, 's00791175', '/tasks');
    const rows = sessionsMod.getChatHistory(sid, {});
    assert.ok(rows.length >= 1, 'slash row persisted without crashing the server');
  });

  await t('attach.js: message.meta is initialized before the fromUserInput stamp', () => {
    // Static guard — pins the fix's shape so a future refactor can't
    // silently reintroduce the undefined-meta write (CLAUDE.md §10f).
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
    const at = src.search(/function\s+handleChatMessage\s*\(/);
    assert.ok(at > -1, 'handleChatMessage must exist');
    const rest = src.slice(at);
    const body = rest.slice(0, rest.indexOf('\n}'));
    const initAt = body.search(/if\s*\(\s*!message\.meta\s*\)\s*message\.meta\s*=\s*\{\s*\}/);
    const stampAt = body.search(/message\.meta\.fromUserInput\s*=\s*true/);
    assert.ok(initAt > -1,
      'handleChatMessage must initialize message.meta to {} before any meta write — this is the crash fix');
    assert.ok(stampAt > -1,
      'the fromUserInput stamp must still exist (delm-1 provenance)');
    assert.ok(initAt < stampAt,
      'the meta init must come BEFORE the fromUserInput stamp, else the stamp writes to undefined');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  if (failed) process.exit(1);
}

main();
