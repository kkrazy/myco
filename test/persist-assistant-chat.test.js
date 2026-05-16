// Regression: claude's assistant text used to mirror into rec.chat as
// fromTranscript:true rows AND get re-emitted as 'chat' frames, which
// the chat pane rendered as a second .chat-msg bubble next to the
// agent-event assistant_text card it had already drawn. Result: every
// reply showed twice — one normal chat bubble, one agent card.
//
// Phase 9+ contract: the AgentSession buffer (persisted to
// <cwd>/_myco_/events.jsonl) is now the canonical record of
// assistant_text; agent-replay reconstitutes it on reload, the live
// 'agent-event' stream covers new replies. So:
//
//   1. persistAssistantTextToChat STILL writes fromTranscript:true
//      rows into rec.chat (historical sessions keep their shape, no
//      data migration needed) but DOES NOT emit 'chat' over the live
//      socket. Suppressing the live emit fixes the duplicate-on-
//      stream case.
//
//   2. sessions.getChatHistory FILTERS OUT fromTranscript:true rows
//      before returning, so the chat-history WS frame sent to clients
//      on attach doesn't re-render those rows as bubbles either. Fixes
//      the duplicate-on-reload case + keeps the extractor's
//      readChatTail focused on human discussion only.
//
// This test locks in both pieces against accidental revert.

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

// End-to-end: raw JSONL ExitPlanMode line → parseLine → persist → chat.
// Regression: demo010 plan generated 2026-05-14T00:04 never showed up
// in the chat pane because the plan markdown was inside an
// ExitPlanMode tool_use, not a text block. The parser now lifts
// .input.plan into assistant.text; this test pins the whole pipeline
// so a future revert (in either parser or persist) red-flips here.
t('ExitPlanMode jsonl line lands in chat via parseLine → persist', () => {
  const { parseLine } = require('../server/src/transcript');
  const sid = 'sess-pac-plan';
  seed(sid);
  const rawLine = JSON.stringify({
    type: 'assistant',
    uuid: 'plan-end-to-end-uuid',
    timestamp: '2026-05-14T00:04:51.985Z',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_plan_e2e',
          name: 'ExitPlanMode',
          input: {
            plan: '# /v2/orders — Cursor Pagination\n\n## Context\n\nKeyset query.',
            planFilePath: '/root/.claude/plans/foo.md',
          },
        },
      ],
    },
  });
  const parsed = parseLine(rawLine);
  assert.ok(parsed, 'parseLine returned null for ExitPlanMode line');
  const added = persistAssistantTextToChat(sid, [parsed]);
  assert.strictEqual(added, 1, 'plan-only assistant turn must mirror to chat');
  const chat = chatOf(sid);
  assert.strictEqual(chat.length, 1);
  assert.ok(chat[0].text.includes('# /v2/orders — Cursor Pagination'),
    'chat row missing plan markdown — got: ' + JSON.stringify(chat[0].text.slice(0, 200)));
  assert.strictEqual(chat[0].meta.transcriptUuid, 'plan-end-to-end-uuid');
});

// The live attach.js implementation IS the contract — verify the
// source file actually contains the helper and it's wired into the
// watcher callback. If a future refactor removes either, this test
// red-flips. (Helper moved from pty.js → attach.js in Phase 9 step 2.)
t('attach.js source has the persistAssistantTextToChat helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  assert.ok(/function persistAssistantTextToChat/.test(src),
    'helper definition missing from attach.js');
  assert.ok(/persistAssistantTextToChat\(sessionId, newMsgs\)/.test(src),
    'helper not invoked from the transcript watcher callback');
  assert.ok(/meta:\s*\{\s*transcriptUuid:\s*m\.uuid/.test(src),
    'helper does not stamp meta.transcriptUuid');
});

// Duplicate-render fix #1: persistAssistantTextToChat must NOT emit
// 'chat' on the live socket. The agent-event stream (assistant_text)
// is the sole live channel for claude's reply text; emitting 'chat'
// too produces a second chat-bubble next to the agent card.
t('attach.js persistAssistantTextToChat does not emit live chat frames', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  // Slice out the function body so the assertion is scoped — there
  // are other places in attach.js that legitimately emit('chat'),
  // e.g. runAssistant for @myco replies and the deny-message path.
  const m = src.match(/function persistAssistantTextToChat[\s\S]*?\n\}\n/);
  assert.ok(m, 'persistAssistantTextToChat definition not found');
  const body = m[0];
  assert.ok(!/session\.emit\(\s*['"]chat['"]/.test(body),
    "persistAssistantTextToChat still calls session.emit('chat', …) — that produces the duplicate render against the agent-event assistant_text card");
});

// Duplicate-render fix #2: getChatHistory must filter out
// fromTranscript rows so a reload doesn't re-introduce the bubble
// from rec.chat after agent-replay has already drawn the card.
t('sessions.getChatHistory filters out meta.fromTranscript rows', () => {
  const sid = 'sess-history-filter';
  seed(sid);
  // One normal user message (kept) + two fromTranscript:true rows
  // (filtered out, because agent-replay re-renders them as cards).
  sessionsMod.appendChatMessage(sid, { user: 'alice', text: 'hi' });
  sessionsMod.appendChatMessage(sid, {
    user: 'claude', text: 'reply one',
    meta: { transcriptUuid: 'u-r1', fromTranscript: true },
  });
  sessionsMod.appendChatMessage(sid, {
    user: 'claude', text: 'reply two',
    meta: { transcriptUuid: 'u-r2', fromTranscript: true },
  });
  // rec.chat retains all three (no data loss).
  const raw = sessionsMod.loadStore().sessions[sid].chat;
  assert.strictEqual(raw.length, 3, 'rec.chat should still hold all 3 rows on disk');
  // getChatHistory returns only the non-transcript row.
  const wire = sessionsMod.getChatHistory(sid);
  assert.strictEqual(wire.length, 1, 'getChatHistory should drop the fromTranscript rows');
  assert.strictEqual(wire[0].user, 'alice');
  assert.strictEqual(wire[0].text, 'hi');
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
