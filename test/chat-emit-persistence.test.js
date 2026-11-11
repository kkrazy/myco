// chat-print-persistence regression (2026-11-04).
//
// User report: "对话框所有打印信息在session没关闭之前应该都要保留…
// 部分信息也会丢失" — some printed chat rows disappeared on refresh /
// tab-switch while the session was still open.
//
// Root cause (this test's subject): several server call sites emitted a
// live `session.emit('chat', msg)` WITHOUT `sessionsMod.appendChatMessage`
// — the row reached attached clients but never landed in rec.chat, so
// the first reattach (chat-history frame reads rec.chat) dropped it.
// That's exactly "partial info lost": the note was seen live, then
// vanished.
//
// The contract (CLAUDE.md "Chat persistence & cross-device consistency"):
// every row that reaches a client as a `chat` WS frame must ALSO be
// persisted to rec.chat — rec.chat is the only refresh-survivable record.
//
// Two layers of enforcement:
//   1. BEHAVIOR: drive the REAL handleChatMessage through the fixed
//      paths (unknown slash command, exited-session note, key-noop,
//      bare-digit multi-menu note) with a stub session and assert the
//      row lands in rec.chat (via getChatHistory includeAgent) AND is
//      emitted on the session bus.
//   2. STATIC GUARD: scan every server/src/*.js call site of
//      emit('chat', X) and require an appendChatMessage (or the shared
//      _emitAndPersistChat helper) covering the same message — so a
//      future emit-only site fails the suite.
//
// Known intentional non-persisting sites are allow-listed below with
// the reason each is correct.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-chat-emit-persist-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

// Seed the allowlist BEFORE requiring attach.js so _detectMentionTarget
// doesn't false-positive on unknown users.
fs.writeFileSync(
  path.join(process.env.MYCO_STATE_DIR, 'allowed-github-users.txt'),
  '# test fixture\ns00791175\n',
);

// The sandbox has no server/node_modules (deps live in the deploy
// image), and _handleInterrupt lazy-requires compare-lanes →
// team-session → agent-session → the SDK (+ zod, …). Stub compare-lanes
// itself in the require cache — attach's `require('./compare-lanes')`
// hits the cache and never reaches the real module.
const Module = require('module');
const compareLanesPath = path.join(__dirname, '..', 'server', 'src', 'compare-lanes.js');
{
  const fake = new Module(compareLanesPath, null);
  fake.filename = compareLanesPath;
  fake.loaded = true;
  fake.exports = {
    stopN2Lane: () => false,
    laneSnapshotFor: () => null,
    startExploreLane: () => null,
  };
  require.cache[compareLanesPath] = fake;
}

const sessionsMod = require('../server/src/sessions');
const attach = require('../server/src/attach');

let passed = 0, failed = 0;
const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

console.log('── chat-emit-persistence: every live chat row must also persist ──');

function seedSession(sid, extra = {}) {
  const store = sessionsMod.loadStore();
  store.sessions = store.sessions || {};
  store.sessions[sid] = Object.assign({
    id: sid,
    user: 's00791175',
    cwd: '.',
    absCwd: process.env.MYCO_WORKSPACE,
    chat: [],
    createdAt: new Date().toISOString(),
  }, extra);
  sessionsMod.saveStore();
  return store.sessions[sid];
}

function chatOf(sid) {
  return sessionsMod.getChatHistory(sid, { includeAgent: true });
}

// Stub AgentSession — same convention as test/k8s-crash-chat-meta-init.
function makeSession(sid) {
  const s = new EventEmitter();
  s.sessionId = sid;
  s.alive = true;
  s.buffer = [];
  s.pendingMenus = new Map();
  s.openToolCalls = new Map();
  s.write = () => {};
  s.interrupt = () => true;
  s.workerRole = null;
  s.on('chat', () => {});
  return s;
}

// ── Layer 1: behavior — the fixed paths persist AND emit ──────────

t('unknown slash command: reply row lands in rec.chat AND emits live', async () => {
  const sid = 'cep-unknown-cmd';
  seedSession(sid);
  const session = makeSession(sid);
  const emitted = [];
  session.on('chat', (m) => emitted.push(m));
  // /definitely-not-a-command falls through slash dispatch → postfix
  // handler's unknown-command branch. slashcmds.dispatch is async, so
  // give the promise chain a tick.
  attach.handleChatMessage(sid, session, 's00791175', '/definitely-not-a-command xyz');
  await new Promise((r) => setTimeout(r, 30));
  const rows = chatOf(sid).filter((r) => /unknown chat command/.test(r.text || ''));
  assert.strictEqual(rows.length, 1,
    'the unknown-command note must be persisted exactly once to rec.chat (got ' + rows.length + ') — pre-fix it was emit-only and vanished on refresh');
  assert.ok(emitted.some((m) => /unknown chat command/.test(m.text || '')),
    'the unknown-command note must ALSO emit live on the session bus');
});

t('exited-session note persists (session.alive=false)', async () => {
  const sid = 'cep-session-exited';
  seedSession(sid);
  const session = makeSession(sid);
  session.alive = false;
  attach.handleChatMessage(sid, session, 's00791175', 'hello are you there');
  await new Promise((r) => setTimeout(r, 30));
  const rows = chatOf(sid).filter((r) => /session has exited/.test(r.text || ''));
  assert.strictEqual(rows.length, 1,
    'the "session has exited" note must persist to rec.chat (got ' + rows.length + ')');
});

t('key-noop note persists (`enter` has no SDK meaning)', async () => {
  const sid = 'cep-key-noop';
  seedSession(sid);
  const session = makeSession(sid);
  attach.handleChatMessage(sid, session, 's00791175', 'enter');
  await new Promise((r) => setTimeout(r, 30));
  const rows = chatOf(sid).filter((r) => /has no meaning in an agent-mode session/.test(r.text || ''));
  assert.strictEqual(rows.length, 1,
    'the key-noop note must persist to rec.chat (got ' + rows.length + ')');
});

t('typed `esc` interrupt ack persists with meta.kind=interrupt-ack', async () => {
  const sid = 'cep-esc-ack';
  seedSession(sid);
  const session = makeSession(sid);
  // _handleInterrupt gates on busy state; give it an in-flight-looking
  // session so the interrupt branch fires the ack.
  session._iterating = true;
  session.isBusy = () => true;
  attach.handleChatMessage(sid, session, 's00791175', 'esc');
  await new Promise((r) => setTimeout(r, 30));
  const acks = chatOf(sid).filter((r) => r.meta && r.meta.kind === 'interrupt-ack');
  assert.strictEqual(acks.length, 1,
    'the interrupt-ack must persist to rec.chat with meta.kind=interrupt-ack (got ' + acks.length + ') — it was emit-only pre-fix');
});

t('_emitAndPersistChat helper: persists then emits, persist failure does not block emit', async () => {
  const sid = 'cep-helper';
  seedSession(sid);
  const session = makeSession(sid);
  const emitted = [];
  session.on('chat', (m) => emitted.push(m));
  const msg = { user: 'claude', text: 'helper note', ts: new Date().toISOString() };
  attach._emitAndPersistChat(sid, session, msg);
  assert.strictEqual(chatOf(sid).filter((r) => r.text === 'helper note').length, 1,
    'helper must persist the row to rec.chat');
  assert.strictEqual(emitted.length, 1, 'helper must emit the row live');
  // Persist failure (bogus session id) must not block the live emit.
  const emitted2 = [];
  session.on('chat', (m) => emitted2.push(m));
  attach._emitAndPersistChat('no-such-session', session, { user: 'claude', text: 'x', ts: new Date().toISOString() });
  assert.strictEqual(emitted2.length, 1,
    'live emit must still fire when appendChatMessage fails (missing session record)');
});

// ── Layer 2: static guard — no emit-only chat sites in server/src ──

// Files to scan for emit('chat' call sites.
const SRC_FILES = [
  'attach.js', 'agent-session.js', 'team-session.js', 'slashcmds.js',
  'critique.js', 'menu.js', 'sessions.js',
  path.join('agents', 'rlm', 'host.js'),
];

// Call sites that intentionally do NOT appendChatMessage, with reasons.
// Keep this list SHORT — every entry needs a live-channel justification.
const ALLOWED_EMIT_ONLY = [
  // attach.js helper itself: its BODY calls appendChatMessage then
  // emits; the static scan's "same-variable" heuristic can't see
  // through the helper body, so allow the helper's own emit line.
  { file: 'attach.js', needle: 'function _emitAndPersistChat', why: 'helper body — appendChatMessage is the line above the emit' },
  // team-session worker relay: the worker AgentSession shares the MAIN
  // session's sessionId and its own emit sites persist (agent-session
  // hook-deny appends before emitting); persisting again here would
  // duplicate the row in rec.chat.
  { file: 'team-session.js', needle: "w.on('chat', (msg) => this.emit('chat', msg))", why: 'relay of a worker row already persisted at the source (shared sessionId)' },
];

function sourceOf(rel) {
  return fs.readFileSync(path.join(__dirname, '..', 'server', 'src', rel), 'utf8');
}

t('static guard: every emit(\'chat\') site in server/src persists the same message', async () => {
  const problems = [];
  for (const rel of SRC_FILES) {
    const src = sourceOf(rel);
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/\.emit\(\s*['"]chat['"]\)/.test(lines[i])) continue;
      // Skip comments.
      const beforeCode = lines[i].replace(/\/\/.*$/, '');
      if (!/\.emit\(\s*['"]chat['"]\)/.test(beforeCode)) continue;
      // Does this emit-only site have an allow-list entry?
      const allowed = ALLOWED_EMIT_ONLY.find((a) => a.file === rel && src.includes(a.needle));
      if (allowed) continue;
      // Look in a window: 12 lines above through 3 lines below for an
      // appendChatMessage / _emitAndPersistChat covering the emit.
      const window = lines.slice(Math.max(0, i - 12), i + 4).join('\n');
      if (!/appendChatMessage\s*\(|_emitAndPersistChat\s*\(/.test(window)) {
        problems.push(rel + ':' + (i + 1) + ' → ' + lines[i].trim().slice(0, 90));
      }
    }
  }
  assert.deepStrictEqual(problems, [],
    'emit-only chat sites found (each live chat row MUST also appendChatMessage):\n' + problems.join('\n'));
});

t('static guard: _emitAndPersistChat helper exists and persists before emitting', async () => {
  const src = sourceOf('attach.js');
  const at = src.indexOf('function _emitAndPersistChat');
  assert.ok(at > 0, '_emitAndPersistChat helper missing from attach.js');
  const body = src.slice(at, at + 900);
  const persistAt = body.indexOf('appendChatMessage');
  const emitAt = body.indexOf("session.emit('chat', msg)");
  assert.ok(persistAt > 0 && emitAt > persistAt,
    'helper must call appendChatMessage BEFORE the live emit');
});

t('static guard: hook-deny menu-auto note in agent-session persists', async () => {
  const src = sourceOf('agent-session.js');
  const at = src.indexOf('auto-denied');
  assert.ok(at > 0, 'hook-deny note missing from agent-session.js');
  const window = src.slice(at - 600, at + 600);
  assert.ok(/appendChatMessage/.test(window),
    'the PreToolUse hook-deny chat note must appendChatMessage (was emit-only — vanished on refresh)');
});

t('static guard: rlm progress note persists', async () => {
  const src = sourceOf(path.join('agents', 'rlm', 'host.js'));
  const at = src.indexOf('rlm-progress-note');
  assert.ok(at > 0, 'rlm progress note missing from host.js');
  const window = src.slice(at - 800, at + 400);
  assert.ok(/appendChatMessage/.test(window),
    'the rlm-progress-note must appendChatMessage (was emit-only)');
});

t('static guard: team-stall note persists', async () => {
  const src = sourceOf('team-session.js');
  const at = src.indexOf("meta: { kind: 'team-stall' }");
  assert.ok(at > 0, 'team-stall note missing from team-session.js');
  const window = src.slice(at - 900, at + 300);
  assert.ok(/appendChatMessage/.test(window),
    'the team-stall note must appendChatMessage (was emit-only)');
});

t('static guard: harness-progress note persists', async () => {
  const src = sourceOf('slashcmds.js');
  const at = src.indexOf("meta: { kind: 'harness-progress' }");
  assert.ok(at > 0, 'harness-progress note missing from slashcmds.js');
  const window = src.slice(at - 800, at + 300);
  assert.ok(/appendChatMessage/.test(window),
    'the harness-progress note must appendChatMessage (was emit-only)');
});

// ── runner ─────────────────────────────────────────────────────────

(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
})();
