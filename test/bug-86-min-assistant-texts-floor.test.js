// bug-86 (option B follow-up to 2026-06-10 omni-cache investigation):
// guarantee at least N recent assistant_text bubbles ship on initial
// attach, even when the byte budget would otherwise cut them off.
//
// User report context: "the local session omni-cache kept losing the
// myco response in the chat pane." Logs showed:
//   [agent-replay] initial byte-trim 838 → 11 events (15362 bytes,
//   budget 16384)
//   [agent-replay-diag] initial shipped 1 assistant_text(s)
// → a chatty tool_use sequence between two claude replies ate the
// 16 KB budget, leaving only 1 assistant_text in the initial replay.
//
// Option A (separate commit): bumped INITIAL_CHAT_HISTORY_BYTES from
// 8K → 64K so the typical case fits ~24 recent bubbles instead of 3.
// Option B (this work): assistant_text floor — even when bytes alone
// would cut them off, walk further back to include the last N (5)
// assistant_text events / fromAgent chat rows.
//
// Two surfaces guard the same contract:
//   · server/src/attach.js _shipAgentReplay — the agent-event stream
//     (claude's assistant_text events are rendered as cards). Floor
//     constant: INITIAL_AGENT_REPLAY_MIN_ASSISTANT_TEXTS.
//   · server/src/sessions.js getChatHistory — the chat-bubble stream
//     (only fires when includeAgent:true; default filter drops
//     fromAgent rows). Floor opt: minAssistantTexts. Constant:
//     INITIAL_CHAT_HISTORY_MIN_ASSISTANT_TEXTS.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-86: minimum assistant_text floor on initial replay ──');

const SESSIONS_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'sessions.js'), 'utf8');
const ATTACH_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────
// PART A — static guards on the constants + wiring
// ─────────────────────────────────────────────────────────────────

t('sessions.js: INITIAL_CHAT_HISTORY_MIN_ASSISTANT_TEXTS constant defined + exported', () => {
  assert.ok(/INITIAL_CHAT_HISTORY_MIN_ASSISTANT_TEXTS\s*=\s*\d+/.test(SESSIONS_JS),
    'bug-86: INITIAL_CHAT_HISTORY_MIN_ASSISTANT_TEXTS constant must be defined.');
  // Must appear in the module.exports block.
  const exp = SESSIONS_JS.match(/Object\.assign\(module\.exports[\s\S]*?\}\);/);
  assert.ok(exp && /INITIAL_CHAT_HISTORY_MIN_ASSISTANT_TEXTS/.test(exp[0]),
    'bug-86: INITIAL_CHAT_HISTORY_MIN_ASSISTANT_TEXTS must be exported so tests and (future) callers can reference the same floor.');
});

t('sessions.js: getChatHistory honors opts.minAssistantTexts', () => {
  // The byte-budget block + the assistant_text floor must both run
  // in getChatHistory so callers can pass minAssistantTexts alongside
  // maxBytes and get both constraints satisfied.
  const at = SESSIONS_JS.search(/function\s+getChatHistory\s*\(/);
  assert.ok(at > -1, 'getChatHistory must exist in sessions.js');
  const slice = SESSIONS_JS.slice(at, at + 4000);
  assert.ok(/opts\.minAssistantTexts/.test(slice),
    'bug-86: getChatHistory must read opts.minAssistantTexts. Without it, callers can\'t enforce the floor — single-oversize-reply windows still cut off prior assistant_texts.');
  assert.ok(/fromAgent|fromTranscript/.test(slice),
    'bug-86: the floor logic must check meta.fromAgent (or fromTranscript) — both shapes are claude-reply mirrors per the existing filter contract.');
});

t('attach.js: INITIAL_AGENT_REPLAY_MIN_ASSISTANT_TEXTS constant defined', () => {
  assert.ok(/INITIAL_AGENT_REPLAY_MIN_ASSISTANT_TEXTS\s*=\s*\d+/.test(ATTACH_JS),
    'bug-86: INITIAL_AGENT_REPLAY_MIN_ASSISTANT_TEXTS constant must be defined in attach.js (sibling of INITIAL_AGENT_REPLAY_BYTES).');
});

t('attach.js: _shipAgentReplay walks events for assistant_text floor after byte-trim', () => {
  const at = ATTACH_JS.search(/function\s+_shipAgentReplay\s*\(/);
  assert.ok(at > -1, '_shipAgentReplay must exist');
  const slice = ATTACH_JS.slice(at, at + 5000);
  assert.ok(/INITIAL_AGENT_REPLAY_MIN_ASSISTANT_TEXTS/.test(slice),
    'bug-86: _shipAgentReplay must reference the floor constant so the byte-trim is augmented (not replaced) by the assistant_text guarantee.');
  // Must match against event.type === 'assistant_text'.
  assert.ok(/type\s*===?\s*['"]assistant_text['"]/.test(slice),
    'bug-86: _shipAgentReplay floor logic must filter on event.type === "assistant_text" (the claude-reply event type per the SDK event stream).');
});

t('attach.js: assistant_text floor only fires on phase=initial (not catch-up)', () => {
  // afterSeq catch-up mode already returns early before the byte-trim
  // block — but the assistant_text floor inside the byte-trim must
  // ALSO be guarded so a future refactor doesn't fire it on catch-up
  // (which has no byte budget by design).
  const at = ATTACH_JS.search(/function\s+_shipAgentReplay\s*\(/);
  const slice = ATTACH_JS.slice(at, at + 5000);
  assert.ok(/phase\s*===?\s*['"]initial['"]/.test(slice),
    'bug-86: the assistant_text floor must be gated to phase === "initial" so catch-up mode (afterSeq) is unaffected.');
});

// ─────────────────────────────────────────────────────────────────
// PART B — runtime: prove getChatHistory's minAssistantTexts actually
// walks back when the byte budget would cut off claude replies.
// (We test getChatHistory directly because it has the cleanest API;
// the agent-replay variant uses the same pattern + the static guards
// above lock the wiring.)
// ─────────────────────────────────────────────────────────────────

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug86-'));
process.env.MYCO_WORKSPACE = path.join(TMP_ROOT, 'wks');
process.env.MYCO_STATE_DIR = path.join(TMP_ROOT, 'state');
process.env.HOME = path.join(TMP_ROOT, 'home');
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
process.on('exit', () => { try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {} });

for (const k of Object.keys(require.cache)) {
  if (/server\/src\/(sessions|attach|stageState|critique|artifacts)\.js$/.test(k)) {
    delete require.cache[k];
  }
}

function seedSession(sid) {
  const sessions = require('../server/src/sessions');
  const rec = { id: sid, user: 'tester', cwd: sid, absCwd: '/tmp/' + sid, chat: [] };
  // Build a chat: 10 assistant_text bubbles interleaved with chunky
  // user msgs. Each assistant_text is small (~200 chars).
  // The byte budget will only fit a couple of them; we want to prove
  // the floor walks back to include 5.
  let seq = 1;
  for (let i = 0; i < 10; i++) {
    rec.chat.push({
      user: 'kkrazy',
      text: 'x'.repeat(2000),  // big user msg — eats byte budget
      ts: '2026-06-10T20:00:0' + i + '.000Z',
      meta: { seq: seq++ },
    });
    rec.chat.push({
      user: 'claude',
      text: 'assistant reply #' + i + ' — short, but flagged fromAgent so the filter knows',
      ts: '2026-06-10T20:00:0' + i + '.500Z',
      meta: { seq: seq++, fromAgent: true },
    });
  }
  const store = sessions.loadStore();
  store.sessions[sid] = rec;
  sessions.saveStore();
  return sessions;
}

t('runtime: getChatHistory({maxBytes:5KB, includeAgent:true, minAssistantTexts:5}) returns ≥5 assistant_texts', () => {
  const sessions = seedSession('bug86test1');
  // 5KB budget without the floor would only fit ~2 of the 2KB user
  // msgs (those are kept first because they\'re the most recent). With
  // includeAgent:true + minAssistantTexts:5, the result must contain
  // at least 5 fromAgent rows.
  const result = sessions.getChatHistory('bug86test1', {
    maxBytes: 5 * 1024,
    includeAgent: true,
    minAssistantTexts: 5,
  });
  const asstCount = result.filter((m) => m.meta && m.meta.fromAgent === true).length;
  assert.ok(asstCount >= 5,
    `bug-86: getChatHistory must guarantee ≥5 assistant_text rows when minAssistantTexts:5 is set, regardless of byte budget. Got ${asstCount}. Result length: ${result.length}.`);
});

t('runtime: getChatHistory honors floor when fewer than N exist (returns all available)', () => {
  // Edge case: minAssistantTexts > total assistant_texts in history.
  // Should return all of them without erroring.
  const sessions = require('../server/src/sessions');
  const sid = 'bug86test2';
  const store = sessions.loadStore();
  store.sessions[sid] = {
    id: sid, user: 'tester', cwd: sid, absCwd: '/tmp/' + sid,
    chat: [
      { user: 'kkrazy', text: 'hi', ts: '2026-06-10T20:00:00Z', meta: { seq: 1 } },
      { user: 'claude', text: 'hello', ts: '2026-06-10T20:00:01Z', meta: { seq: 2, fromAgent: true } },
    ],
  };
  sessions.saveStore();
  const result = sessions.getChatHistory(sid, {
    maxBytes: 5 * 1024,
    includeAgent: true,
    minAssistantTexts: 100,
  });
  // Should return whatever's there (2 messages) without error.
  assert.strictEqual(result.length, 2,
    'bug-86: minAssistantTexts:100 with only 1 assistant_text available must return all available rows — "at most N if they exist."');
});

t('runtime: getChatHistory floor is a NO-OP when byte budget already covers N', () => {
  // When the byte budget naturally fits N+ assistant_texts, the floor
  // logic shouldn't expand the window unnecessarily.
  const sessions = require('../server/src/sessions');
  const sid = 'bug86test3';
  const store = sessions.loadStore();
  store.sessions[sid] = {
    id: sid, user: 'tester', cwd: sid, absCwd: '/tmp/' + sid,
    chat: [],
  };
  for (let i = 0; i < 20; i++) {
    store.sessions[sid].chat.push({
      user: 'claude', text: 'reply ' + i,
      ts: '2026-06-10T20:00:0' + (i % 10) + '.' + i + 'Z',
      meta: { seq: i + 1, fromAgent: true },
    });
  }
  sessions.saveStore();
  // 100KB budget easily fits all 20 tiny replies. minAssistantTexts:5
  // should not change the result.
  const result = sessions.getChatHistory(sid, {
    maxBytes: 100 * 1024,
    includeAgent: true,
    minAssistantTexts: 5,
  });
  assert.strictEqual(result.length, 20,
    'bug-86: when byte budget naturally accommodates more than N assistant_texts, the floor is a no-op — all rows that fit by budget should still ship.');
});

console.log(`── bug-86: ${passed} passed, ${failed} failed ──`);
process.exit(failed === 0 ? 0 : 1);
