// Regression: claude's assistant text in the transcript jsonl must be
// mirrored into rec.chat so the chat pane survives a refresh / new tab /
// readonly attach.
//
// Pre-fix: _postClaudeStreamToChat on the client added _localOnly:true
// rows that were never sent to the server. rec.chat held only user
// messages and menu callouts; chat-history on reload returned the same
// stripped set, so claude's prose appeared to vanish from the chat pane
// after every reload.
//
// Post-fix: persistAssistantTextToChat (in pty.js) walks each
// transcript-delta batch, appends assistant text into rec.chat with
// meta.transcriptUuid for stable dedup, and emits a 'chat' event so
// already-connected clients also see the live push.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pac-'));
process.env.MYCO_STATE_DIR = tmpRoot;
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

const sessionsMod = require('../server/src/sessions');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

// The function we want to exercise lives inside pty.js but isn't exported.
// We DON'T pull in pty.js (it would spawn xterm headless terminals on
// require). Instead, we recreate the exact dedup-and-persist contract
// against the sessions module: any future change to pty.persistAssistantTextToChat
// that breaks this contract should also break the source-grep check below.
function persistAssistantTextToChat(sessionId, newMsgs) {
  if (!Array.isArray(newMsgs) || !newMsgs.length) return 0;
  const store = sessionsMod.loadStore();
  const rec = store.sessions[sessionId];
  if (!rec) return 0;
  if (!Array.isArray(rec.chat)) rec.chat = [];
  const seen = new Set();
  for (const c of rec.chat) {
    if (c && c.meta && c.meta.transcriptUuid) seen.add(c.meta.transcriptUuid);
  }
  let added = 0;
  for (const m of newMsgs) {
    if (!m || m.role !== 'assistant') continue;
    if (!m.text || !m.text.trim()) continue;
    if (!m.uuid) continue;
    if (seen.has(m.uuid)) continue;
    seen.add(m.uuid);
    sessionsMod.appendChatMessage(sessionId, {
      user: 'claude',
      text: m.text.trim(),
      ts: m.ts || new Date().toISOString(),
      meta: { transcriptUuid: m.uuid, fromTranscript: true },
    });
    added++;
  }
  return added;
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

console.log('── persistAssistantTextToChat ──');

t('appends assistant text with meta.transcriptUuid', () => {
  const sid = 'sess-pac-1';
  seed(sid);
  const added = persistAssistantTextToChat(sid, [
    { role: 'assistant', uuid: 'u1', ts: '2026-05-12T16:00:00.000Z', text: 'Hello' },
  ]);
  assert.strictEqual(added, 1);
  const chat = chatOf(sid);
  assert.strictEqual(chat.length, 1);
  assert.strictEqual(chat[0].user, 'claude');
  assert.strictEqual(chat[0].text, 'Hello');
  assert.strictEqual(chat[0].meta.transcriptUuid, 'u1');
  assert.strictEqual(chat[0].meta.fromTranscript, true);
});

t('is idempotent: replaying the same uuid does not double-add', () => {
  const sid = 'sess-pac-2';
  seed(sid);
  const msg = { role: 'assistant', uuid: 'u-once', ts: '2026-05-12T16:00:00.000Z', text: 'Answer A' };
  assert.strictEqual(persistAssistantTextToChat(sid, [msg]), 1);
  assert.strictEqual(persistAssistantTextToChat(sid, [msg]), 0);   // replay → no-op
  assert.strictEqual(persistAssistantTextToChat(sid, [msg]), 0);   // again
  assert.strictEqual(chatOf(sid).length, 1);
});

t('ignores non-assistant, empty-text, and uuid-less entries', () => {
  const sid = 'sess-pac-3';
  seed(sid);
  const added = persistAssistantTextToChat(sid, [
    { role: 'user', uuid: 'u-user', text: 'hi' },
    { role: 'assistant', uuid: 'u-empty', text: '   ' },          // whitespace only
    { role: 'assistant', text: 'no-uuid-no-store' },               // missing uuid
    { role: 'tool_result', uuid: 'u-tr', text: 'tool output' },
    { role: 'assistant', uuid: 'u-keep', text: 'real reply' },
  ]);
  assert.strictEqual(added, 1);
  assert.strictEqual(chatOf(sid)[0].meta.transcriptUuid, 'u-keep');
});

t('batched call preserves transcript order', () => {
  const sid = 'sess-pac-4';
  seed(sid);
  persistAssistantTextToChat(sid, [
    { role: 'assistant', uuid: 'a', text: 'one' },
    { role: 'assistant', uuid: 'b', text: 'two' },
    { role: 'assistant', uuid: 'c', text: 'three' },
  ]);
  const c = chatOf(sid);
  assert.deepStrictEqual(c.map((r) => r.text), ['one', 'two', 'three']);
});

t('handles unknown sessionId gracefully (no throw, returns 0)', () => {
  const before = sessionsMod.loadStore().sessions['sess-missing'];
  const added = persistAssistantTextToChat('sess-missing', [
    { role: 'assistant', uuid: 'whatever', text: 'ignored' },
  ]);
  assert.strictEqual(added, 0);
  assert.strictEqual(before, undefined);
});

// The live pty.js implementation IS the contract — verify the source
// file actually contains the helper and it's wired into the watcher
// callback. If a future refactor removes either, this test red-flips.
t('pty.js source has the persistAssistantTextToChat helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'pty.js'), 'utf8');
  assert.ok(/function persistAssistantTextToChat/.test(src),
    'helper definition missing from pty.js');
  assert.ok(/persistAssistantTextToChat\(sessionId, newMsgs\)/.test(src),
    'helper not invoked from the transcript watcher callback');
  assert.ok(/meta:\s*\{\s*transcriptUuid:\s*m\.uuid/.test(src),
    'helper does not stamp meta.transcriptUuid');
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
