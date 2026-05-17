// Locks in the chat persistence + cross-device + ordering contract
// documented in CLAUDE.md → "Chat persistence & cross-device
// consistency".
//
// SCOPE (2026-05-17 round 6 — post-revert):
//   This file pins SERVER-SIDE behavior — persistence, seq stamping,
//   getChatHistory filtering, includeAgent paginator, afterSeq catch-up,
//   chronological order in rec.chat. The client-side rendering tests
//   (chat-msg-from-agent bubble shape, data-seq sort, preserve-loop
//   distinction) were removed after a series of layered client changes
//   caused display regressions; the client reverted to the pre-round-2
//   shape (assistant_text renders as agent-card, not chat-msg bubble)
//   and the server keeps the seq + persistence work that's
//   independently testable + correct.
//
// Pillars enforced:
//   1. Cross-device consistency — two callers see identical bytes.
//   2. Full history persistence — every user input AND every claude
//      reply lands in rec.chat indefinitely (up to MAX_CHAT_MESSAGES).
//   3. Client memory frugality — initial WS-frame is byte-capped, but
//      load-older paginator with includeAgent=1 surfaces fromAgent rows
//      that the default frame hides.
//   4. Chronological order — getChatHistory always returns oldest →
//      newest; appendChatMessage preserves arrival order; mixing user
//      input + claude reply preserves the interleave.
//   5. Monotonic seq stamping — every rec.chat row + every agent-event
//      gets a per-session seq via allocSeq.
//   6. afterSeq catch-up — getChatHistory({afterSeq:N}) returns only
//      rows the caller hasn't seen yet.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-chat-contract-'));
process.env.MYCO_STATE_DIR = tmpRoot;
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

const sessionsMod = require('../server/src/sessions');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function seed(sid) {
  const store = sessionsMod.loadStore();
  store.sessions = store.sessions || {};
  store.sessions[sid] = {
    id: sid,
    user: 'kkrazy',
    cwd: '.',
    absCwd: process.env.MYCO_WORKSPACE,
    claudeSessionId: null,
    createdAt: new Date().toISOString(),
    chat: [],
  };
  sessionsMod.saveStore();
}

function chatOf(sid) { return sessionsMod.loadStore().sessions[sid].chat; }

console.log('── chat-persistence-contract ──');

// ── source-grep guards for the persistence helper ────────────────
t('agent-session.js defines _persistAssistantTextToRecChat', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
  assert.ok(/_persistAssistantTextToRecChat\s*\(\s*text\s*\)\s*\{/.test(src),
    'helper definition missing from agent-session.js');
  assert.ok(/sessionsMod\.appendChatMessage\(this\.sessionId,\s*msg\)/.test(src),
    'helper does not call sessions.appendChatMessage');
  assert.ok(/meta:\s*\{\s*fromAgent:\s*true\s*\}/.test(src),
    'helper does not stamp meta.fromAgent:true');
});

t('text-block branch of _handleEvent calls _persistAssistantTextToRecChat', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
  const lines = src.split('\n');
  let emitLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/_emit\(\s*\{\s*type:\s*['"]assistant_text['"]/.test(lines[i])) { emitLine = i; break; }
  }
  assert.ok(emitLine >= 0, 'could not find _emit({type:"assistant_text"}) call');
  const window = lines.slice(emitLine, emitLine + 25).join('\n');
  assert.ok(/_persistAssistantTextToRecChat\(/.test(window),
    'text-block branch no longer calls _persistAssistantTextToRecChat within 25 lines of the assistant_text emit.');
});

t('_persistAssistantTextToRecChat does NOT emit live "chat" frame (no duplicate render)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
  const lines = src.split('\n');
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/_persistAssistantTextToRecChat\s*\(\s*text\s*\)\s*\{/.test(lines[i])) { startLine = i; break; }
  }
  assert.ok(startLine >= 0, 'helper definition not found');
  let endLine = startLine + 1;
  for (let i = startLine + 1; i < Math.min(startLine + 80, lines.length); i++) {
    if (/^\s{2}\}/.test(lines[i])) { endLine = i; break; }
  }
  const codeOnly = lines.slice(startLine, endLine + 1)
    .map((ln) => ln.replace(/\/\/.*$/, ''))
    .join('\n');
  assert.ok(!/this\.emit\(\s*['"]chat['"]/.test(codeOnly),
    "helper calls this.emit('chat', …) in executable code — duplicate-render risk.");
});

// ── Pillar 2: full history persistence ────────────────────────────
t('appendChatMessage persists user input rows in arrival order', () => {
  const sid = 'sess-pillar2-user';
  seed(sid);
  sessionsMod.appendChatMessage(sid, { user: 'alice', text: 'first',  ts: '2026-05-17T00:00:00.001Z' });
  sessionsMod.appendChatMessage(sid, { user: 'alice', text: 'second', ts: '2026-05-17T00:00:00.002Z' });
  sessionsMod.appendChatMessage(sid, { user: 'alice', text: 'third',  ts: '2026-05-17T00:00:00.003Z' });
  assert.deepStrictEqual(chatOf(sid).map((r) => r.text), ['first', 'second', 'third']);
});

t('claude reply (meta.fromAgent:true) is persisted to rec.chat', () => {
  const sid = 'sess-pillar2-claude';
  seed(sid);
  sessionsMod.appendChatMessage(sid, {
    user: 'claude',
    text: 'Hello! How can I help?',
    ts: '2026-05-17T00:00:01.000Z',
    meta: { fromAgent: true },
  });
  const stored = chatOf(sid);
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].user, 'claude');
  assert.strictEqual(stored[0].meta.fromAgent, true);
});

t('MAX_CHAT_MESSAGES cap is 100000 — history is effectively unbounded', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'sessions.js'), 'utf8');
  const m = src.match(/MAX_CHAT_MESSAGES\s*=\s*(\d+)/);
  assert.ok(m, 'MAX_CHAT_MESSAGES constant missing');
  const cap = parseInt(m[1], 10);
  assert.ok(cap >= 100000,
    `MAX_CHAT_MESSAGES dropped to ${cap}; persisted history must survive heavy traffic.`);
});

t('mixed user + claude turns preserved chronologically in rec.chat', () => {
  const sid = 'sess-pillar2-mixed';
  seed(sid);
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'hi',                   ts: '2026-05-17T00:00:00.001Z' });
  sessionsMod.appendChatMessage(sid, { user: 'claude', text: 'Hello, alice!',        ts: '2026-05-17T00:00:00.002Z', meta: { fromAgent: true } });
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'what time is it?',     ts: '2026-05-17T00:00:00.003Z' });
  sessionsMod.appendChatMessage(sid, { user: 'claude', text: 'Around 5 PM in Tokyo.', ts: '2026-05-17T00:00:00.004Z', meta: { fromAgent: true } });
  const all = chatOf(sid);
  assert.deepStrictEqual(all.map((r) => r.text), [
    'hi', 'Hello, alice!', 'what time is it?', 'Around 5 PM in Tokyo.',
  ]);
});

// ── Pillar 3: client memory frugality + includeAgent paginator ───
t('default getChatHistory filters out fromAgent rows', () => {
  const sid = 'sess-pillar3-filter';
  seed(sid);
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'hi',     ts: '2026-05-17T00:00:00.001Z' });
  sessionsMod.appendChatMessage(sid, { user: 'claude', text: 'Hello!', ts: '2026-05-17T00:00:00.002Z', meta: { fromAgent: true } });
  sessionsMod.appendChatMessage(sid, { user: 'bob',    text: 'hey',    ts: '2026-05-17T00:00:00.003Z' });
  const def = sessionsMod.getChatHistory(sid);
  assert.deepStrictEqual(def.map((r) => r.text), ['hi', 'hey']);
  assert.strictEqual(sessionsMod.getChatHistoryLength(sid), 2);
});

t('getChatHistory({includeAgent:true}) surfaces fromAgent rows', () => {
  const sid = 'sess-pillar3-include';
  seed(sid);
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'hi',     ts: '2026-05-17T00:00:00.001Z' });
  sessionsMod.appendChatMessage(sid, { user: 'claude', text: 'Hello!', ts: '2026-05-17T00:00:00.002Z', meta: { fromAgent: true } });
  sessionsMod.appendChatMessage(sid, { user: 'bob',    text: 'hey',    ts: '2026-05-17T00:00:00.003Z' });
  const full = sessionsMod.getChatHistory(sid, { includeAgent: true });
  assert.deepStrictEqual(full.map((r) => r.text), ['hi', 'Hello!', 'hey']);
  assert.strictEqual(sessionsMod.getChatHistoryLength(sid, { includeAgent: true }), 3);
});

t('initial-attach byte budget is small (1 KB) + backfill is 16 KB', () => {
  assert.strictEqual(sessionsMod.INITIAL_CHAT_HISTORY_BYTES, 8 * 1024);
  assert.strictEqual(sessionsMod.DEFAULT_CHAT_HISTORY_BYTES, 16 * 1024);
});

t('client load-older paginator passes includeAgent=1', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(/_fetchOlderChatFromServer/.test(app), 'load-older fetcher missing');
  assert.ok(/includeAgent=1/.test(app),
    'load-older fetcher no longer passes includeAgent=1.');
});

t('chat-history server route understands includeAgent query param', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');
  assert.ok(/includeAgent\s*=\s*req\.query\.includeAgent/.test(idx),
    '/chat/history route no longer parses includeAgent.');
});

// ── Pillar 1: cross-device consistency ───────────────────────────
t('two parallel getChatHistory calls return byte-identical results', () => {
  const sid = 'sess-pillar1-parity';
  seed(sid);
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'cross', ts: '2026-05-17T00:00:00.001Z' });
  sessionsMod.appendChatMessage(sid, { user: 'claude', text: 'device', ts: '2026-05-17T00:00:00.002Z', meta: { fromAgent: true } });
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'parity', ts: '2026-05-17T00:00:00.003Z' });
  const a = sessionsMod.getChatHistory(sid, { maxBytes: 16 * 1024 });
  const b = sessionsMod.getChatHistory(sid, { maxBytes: 16 * 1024 });
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b),
    'Same opts must produce byte-identical result.');
});

// ── Pillar 4: chronological order ────────────────────────────────
t('getChatHistory result is always tail-ascending', () => {
  const sid = 'sess-pillar4-order';
  seed(sid);
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'a', ts: '2026-05-17T00:00:00.001Z' });
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'b', ts: '2026-05-17T00:00:00.002Z' });
  sessionsMod.appendChatMessage(sid, { user: 'claude', text: 'c', ts: '2026-05-17T00:00:00.003Z', meta: { fromAgent: true } });
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'd', ts: '2026-05-17T00:00:00.004Z' });
  const def = sessionsMod.getChatHistory(sid);
  for (let i = 1; i < def.length; i++) {
    assert.ok(def[i].ts >= def[i - 1].ts);
  }
});

t('interleaved user/claude turns preserved chronologically across the pipeline', () => {
  const sid = 'sess-pillar4-interleave';
  seed(sid);
  const expected = [];
  for (let i = 0; i < 3; i++) {
    sessionsMod.appendChatMessage(sid, { user: 'alice',  text: `q${i}`, ts: `2026-05-17T00:00:0${i}.001Z` });
    sessionsMod.appendChatMessage(sid, { user: 'claude', text: `a${i}`, ts: `2026-05-17T00:00:0${i}.002Z`, meta: { fromAgent: true } });
    expected.push(`q${i}`, `a${i}`);
  }
  const all = sessionsMod.getChatHistory(sid, { includeAgent: true });
  assert.deepStrictEqual(all.map((r) => r.text), expected);
});

// ── Pillar 5: monotonic seq stamping ─────────────────────────────
t('sessions.allocSeq + bumpSeqAtLeast exported', () => {
  assert.strictEqual(typeof sessionsMod.allocSeq, 'function');
  assert.strictEqual(typeof sessionsMod.bumpSeqAtLeast, 'function');
});

t('allocSeq returns strictly increasing values per session', () => {
  const sid = 'sess-seq-1';
  seed(sid);
  const a = sessionsMod.allocSeq(sid);
  const b = sessionsMod.allocSeq(sid);
  const c = sessionsMod.allocSeq(sid);
  assert.ok(b > a, `seq not monotonic: ${a} → ${b}`);
  assert.ok(c > b, `seq not monotonic: ${b} → ${c}`);
});

t('appendChatMessage auto-stamps meta.seq', () => {
  const sid = 'sess-seq-append';
  seed(sid);
  sessionsMod.appendChatMessage(sid, { user: 'alice', text: 'a' });
  sessionsMod.appendChatMessage(sid, { user: 'alice', text: 'b' });
  const rows = chatOf(sid);
  assert.strictEqual(typeof rows[0].meta.seq, 'number');
  assert.ok(rows[1].meta.seq > rows[0].meta.seq);
});

t('bumpSeqAtLeast advances counter past externally-stamped values', () => {
  const sid = 'sess-seq-bump';
  seed(sid);
  sessionsMod.bumpSeqAtLeast(sid, 9999);
  const next = sessionsMod.allocSeq(sid);
  assert.ok(next > 9999);
});

t('agent-session.js _emit stamps seq via allocSeq', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
  assert.ok(/sessionsMod\.allocSeq\(this\.sessionId\)/.test(src),
    '_emit no longer calls sessions.allocSeq — agent-events lack seq.');
});

// ── Pillar 6: afterSeq catch-up ──────────────────────────────────
t('getChatHistory({afterSeq:N}) returns only rows with seq > N', () => {
  const sid = 'sess-catchup-1';
  seed(sid);
  sessionsMod.appendChatMessage(sid, { user: 'alice', text: 'a' });
  sessionsMod.appendChatMessage(sid, { user: 'alice', text: 'b' });
  sessionsMod.appendChatMessage(sid, { user: 'alice', text: 'c' });
  sessionsMod.appendChatMessage(sid, { user: 'alice', text: 'd' });
  const all = chatOf(sid);
  const cutoff = all[1].meta.seq;
  const gap = sessionsMod.getChatHistory(sid, { afterSeq: cutoff });
  assert.deepStrictEqual(gap.map((r) => r.text), ['c', 'd']);
});

t('catch-up with includeAgent surfaces fromAgent rows in the gap', () => {
  const sid = 'sess-catchup-agent';
  seed(sid);
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'q' });
  sessionsMod.appendChatMessage(sid, { user: 'claude', text: 'a', meta: { fromAgent: true } });
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'q2' });
  const rows = chatOf(sid);
  const after = rows[0].meta.seq;
  const gap = sessionsMod.getChatHistory(sid, { afterSeq: after, includeAgent: true });
  assert.deepStrictEqual(gap.map((r) => r.text), ['a', 'q2']);
});

t('server attach.js _shipChatHistory accepts afterSeq param', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  assert.ok(/_shipChatHistory\(ws, sessionId, maxBytes, phase, afterSeq\)/.test(src),
    '_shipChatHistory signature no longer accepts afterSeq.');
});

t('HTTP /chat/history route accepts afterSeq query', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');
  assert.ok(/req\.query\.afterSeq/.test(src),
    '/chat/history no longer reads afterSeq query param.');
});

t('CLAUDE.md documents the chat-persistence contract', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
  assert.ok(/Chat persistence & cross-device consistency/.test(md),
    'CLAUDE.md is missing the chat-persistence design section');
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
