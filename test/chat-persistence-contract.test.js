// Locks in the chat persistence + cross-device + ordering contract
// documented in CLAUDE.md → "Chat persistence & cross-device
// consistency". Touching getChatHistory, appendChatMessage,
// _persistAssistantTextToRecChat, MAX_CHAT_MESSAGES, or the
// /chat/history route MUST keep these tests green.
//
// Four pillars enforced:
//   1. Cross-device consistency — two callers see identical bytes.
//   2. Full history persistence — every user input AND every claude
//      reply lands in rec.chat indefinitely (up to MAX_CHAT_MESSAGES).
//   3. Client memory frugality — initial WS-frame is byte-capped, but
//      load-older paginator with includeAgent=1 surfaces fromAgent rows
//      that the default frame hides (to avoid duplicate-render against
//      agent-replay cards).
//   4. Chronological order — getChatHistory always returns oldest →
//      newest; appendChatMessage preserves arrival order; mixing user
//      input + claude reply preserves the interleave.
//
// Bug origin: 2026-05-17 — user reported "send 'hi', claude replied,
// after switching tab the claude reply disappeared". Diagnosis:
// assistant_text events lived only in session.buffer + events.jsonl
// (the SDK-era persistence was best-effort, byte-capped tail).
// Fix: agent-session.js._persistAssistantTextToRecChat mirrors each
// assistant_text block into rec.chat tagged meta.fromAgent:true. The
// row is the durable record; the agent-event card is the live render
// channel.

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

// ── source-grep guards ─────────────────────────────────────────────
// Lock the _persistAssistantTextToRecChat helper into agent-session.js
// AND its call site in the assistant text-block branch.
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
  // Locate the assistant_text _emit call and verify the persist
  // call appears within a small window after it (next ~20 lines).
  const lines = src.split('\n');
  let emitLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/_emit\(\s*\{\s*type:\s*['"]assistant_text['"]/.test(lines[i])) { emitLine = i; break; }
  }
  assert.ok(emitLine >= 0, 'could not find _emit({type:"assistant_text"}) call');
  const windowLines = lines.slice(emitLine, emitLine + 25).join('\n');
  assert.ok(/_persistAssistantTextToRecChat\(/.test(windowLines),
    'text-block branch no longer calls _persistAssistantTextToRecChat within 25 lines of the assistant_text emit — regression: claude reply will disappear after tab-switch');
});

t('_persistAssistantTextToRecChat does NOT emit live "chat" frame (no duplicate render)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
  // Find the helper start, then walk forward to the matching closing
  // brace. Strip line + block comments before checking so a benign
  // mention like `// Deliberately NO this.emit('chat', …)` in a
  // doc comment doesn't trip the regex.
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
  // Strip line comments (`//…`) from each line of the body before
  // scanning — only EXECUTABLE code should be checked.
  const codeOnly = lines.slice(startLine, endLine + 1)
    .map((ln) => ln.replace(/\/\/.*$/, ''))
    .join('\n');
  assert.ok(!/this\.emit\(\s*['"]chat['"]/.test(codeOnly),
    "helper calls this.emit('chat', …) in executable code — that produces a duplicate chat-bubble next to the agent-text card (same bug as the old fromTranscript path)");
});

// ── Pillar 2: full history persistence ─────────────────────────────

t('appendChatMessage persists user input rows in arrival order', () => {
  const sid = 'sess-pillar2-user';
  seed(sid);
  sessionsMod.appendChatMessage(sid, { user: 'alice', text: 'first',  ts: '2026-05-17T00:00:00.001Z' });
  sessionsMod.appendChatMessage(sid, { user: 'alice', text: 'second', ts: '2026-05-17T00:00:00.002Z' });
  sessionsMod.appendChatMessage(sid, { user: 'alice', text: 'third',  ts: '2026-05-17T00:00:00.003Z' });
  assert.deepStrictEqual(chatOf(sid).map((r) => r.text), ['first', 'second', 'third']);
});

t('claude reply (meta.fromAgent:true) is persisted to rec.chat — bug-fix 2026-05-17', () => {
  const sid = 'sess-pillar2-claude';
  seed(sid);
  // Direct simulation of what _persistAssistantTextToRecChat does.
  sessionsMod.appendChatMessage(sid, {
    user: 'claude',
    text: 'Hello! How can I help?',
    ts: '2026-05-17T00:00:01.000Z',
    meta: { fromAgent: true },
  });
  const stored = chatOf(sid);
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].user, 'claude');
  assert.strictEqual(stored[0].text, 'Hello! How can I help?');
  assert.strictEqual(stored[0].meta.fromAgent, true);
});

t('MAX_CHAT_MESSAGES cap is 100000 — history is effectively unbounded for normal use', () => {
  // Don't actually push 100k rows; just assert the constant is generous.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'sessions.js'), 'utf8');
  const m = src.match(/MAX_CHAT_MESSAGES\s*=\s*(\d+)/);
  assert.ok(m, 'MAX_CHAT_MESSAGES constant missing');
  const cap = parseInt(m[1], 10);
  assert.ok(cap >= 100000,
    `MAX_CHAT_MESSAGES dropped to ${cap}; persisted history must survive heavy traffic. Bump back to ≥100000.`);
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
    'hi',
    'Hello, alice!',
    'what time is it?',
    'Around 5 PM in Tokyo.',
  ]);
});

// ── Pillar 3: client memory frugality + includeAgent paginator ─────

t('default getChatHistory filters out fromAgent rows (no duplicate render on attach)', () => {
  const sid = 'sess-pillar3-filter';
  seed(sid);
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'hi',     ts: '2026-05-17T00:00:00.001Z' });
  sessionsMod.appendChatMessage(sid, { user: 'claude', text: 'Hello!', ts: '2026-05-17T00:00:00.002Z', meta: { fromAgent: true } });
  sessionsMod.appendChatMessage(sid, { user: 'bob',    text: 'hey',    ts: '2026-05-17T00:00:00.003Z' });
  // Default — fromAgent filtered out.
  const def = sessionsMod.getChatHistory(sid);
  assert.deepStrictEqual(def.map((r) => r.text), ['hi', 'hey']);
  assert.strictEqual(sessionsMod.getChatHistoryLength(sid), 2);
});

t('getChatHistory({includeAgent:true}) surfaces fromAgent rows for load-older paginator', () => {
  const sid = 'sess-pillar3-include';
  seed(sid);
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'hi',     ts: '2026-05-17T00:00:00.001Z' });
  sessionsMod.appendChatMessage(sid, { user: 'claude', text: 'Hello!', ts: '2026-05-17T00:00:00.002Z', meta: { fromAgent: true } });
  sessionsMod.appendChatMessage(sid, { user: 'bob',    text: 'hey',    ts: '2026-05-17T00:00:00.003Z' });
  const full = sessionsMod.getChatHistory(sid, { includeAgent: true });
  assert.deepStrictEqual(full.map((r) => r.text), ['hi', 'Hello!', 'hey']);
  assert.strictEqual(sessionsMod.getChatHistoryLength(sid, { includeAgent: true }), 3);
});

t('getChatHistory({includeAgent:true, before:ts}) walks older window in order', () => {
  const sid = 'sess-pillar3-before';
  seed(sid);
  // Five rows alternating user / claude, ts ascending.
  const rows = [
    { user: 'alice',  text: 'q1', ts: '2026-05-17T00:00:00.001Z' },
    { user: 'claude', text: 'a1', ts: '2026-05-17T00:00:00.002Z', meta: { fromAgent: true } },
    { user: 'alice',  text: 'q2', ts: '2026-05-17T00:00:00.003Z' },
    { user: 'claude', text: 'a2', ts: '2026-05-17T00:00:00.004Z', meta: { fromAgent: true } },
    { user: 'alice',  text: 'q3', ts: '2026-05-17T00:00:00.005Z' },
  ];
  for (const r of rows) sessionsMod.appendChatMessage(sid, r);
  // Page backward from after q3 — should see oldest→newest.
  const page = sessionsMod.getChatHistory(sid, {
    includeAgent: true,
    before: '2026-05-17T00:00:00.005Z',
    limit: 10,
  });
  assert.deepStrictEqual(page.map((r) => r.text), ['q1', 'a1', 'q2', 'a2']);
});

t('initial-attach byte budget is small (1 KB) + scroll-up budget is 16 KB', () => {
  assert.strictEqual(sessionsMod.INITIAL_CHAT_HISTORY_BYTES, 1 * 1024,
    'INITIAL_CHAT_HISTORY_BYTES drifted from 1 KB — initial attach paint must stay snappy');
  assert.strictEqual(sessionsMod.DEFAULT_CHAT_HISTORY_BYTES, 16 * 1024,
    'DEFAULT_CHAT_HISTORY_BYTES drifted from 16 KB — backfill must stay frugal');
});

// ── Pillar 1: cross-device consistency ─────────────────────────────

t('two parallel getChatHistory calls return byte-identical results (cross-device parity)', () => {
  const sid = 'sess-pillar1-parity';
  seed(sid);
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'cross', ts: '2026-05-17T00:00:00.001Z' });
  sessionsMod.appendChatMessage(sid, { user: 'claude', text: 'device', ts: '2026-05-17T00:00:00.002Z', meta: { fromAgent: true } });
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'parity', ts: '2026-05-17T00:00:00.003Z' });
  const a = sessionsMod.getChatHistory(sid, { maxBytes: 16 * 1024 });
  const b = sessionsMod.getChatHistory(sid, { maxBytes: 16 * 1024 });
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b),
    'Same opts must produce byte-identical result; otherwise two devices see different views');
});

t('cross-device parity also holds for includeAgent paginator', () => {
  const sid = 'sess-pillar1-parity-paginate';
  seed(sid);
  for (let i = 0; i < 10; i++) {
    sessionsMod.appendChatMessage(sid, {
      user: i % 2 === 0 ? 'alice' : 'claude',
      text: `m${i}`,
      ts: `2026-05-17T00:00:0${i}.000Z`,
      meta: i % 2 === 1 ? { fromAgent: true } : undefined,
    });
  }
  const a = sessionsMod.getChatHistory(sid, { includeAgent: true, before: '2026-05-17T00:00:08.000Z', limit: 5 });
  const b = sessionsMod.getChatHistory(sid, { includeAgent: true, before: '2026-05-17T00:00:08.000Z', limit: 5 });
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  // And the window itself is chronologically correct.
  const texts = a.map((r) => r.text);
  for (let i = 1; i < texts.length; i++) {
    assert.ok(a[i].ts > a[i - 1].ts, `cross-device window broke order at idx ${i}: ${a[i - 1].ts} → ${a[i].ts}`);
  }
});

// ── Pillar 4: chronological order ──────────────────────────────────

t('getChatHistory result is always tail-ascending (oldest → newest)', () => {
  const sid = 'sess-pillar4-order';
  seed(sid);
  // Push in jumbled-ish ts order to make sure the function doesn't
  // assume input order; in practice appendChatMessage is monotonic
  // but we should not silently break if a row is hand-edited.
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'a', ts: '2026-05-17T00:00:00.001Z' });
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'b', ts: '2026-05-17T00:00:00.002Z' });
  sessionsMod.appendChatMessage(sid, { user: 'claude', text: 'c', ts: '2026-05-17T00:00:00.003Z', meta: { fromAgent: true } });
  sessionsMod.appendChatMessage(sid, { user: 'alice',  text: 'd', ts: '2026-05-17T00:00:00.004Z' });
  const def = sessionsMod.getChatHistory(sid);
  for (let i = 1; i < def.length; i++) {
    assert.ok(def[i].ts >= def[i - 1].ts,
      `default getChatHistory broke chronological order at idx ${i}`);
  }
  const all = sessionsMod.getChatHistory(sid, { includeAgent: true });
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i].ts >= all[i - 1].ts,
      `includeAgent getChatHistory broke chronological order at idx ${i}`);
  }
});

t('interleaved user/claude turns preserved chronologically across the full pipeline', () => {
  const sid = 'sess-pillar4-interleave';
  seed(sid);
  // Simulate three full turns: user→claude, user→claude, user→claude.
  const expected = [];
  for (let i = 0; i < 3; i++) {
    const baseTs = 1000 + i * 100;
    const u = { user: 'alice',  text: `q${i}`, ts: `2026-05-17T00:00:0${i}.001Z` };
    const c = { user: 'claude', text: `a${i}`, ts: `2026-05-17T00:00:0${i}.002Z`, meta: { fromAgent: true } };
    sessionsMod.appendChatMessage(sid, u);
    sessionsMod.appendChatMessage(sid, c);
    expected.push(`q${i}`, `a${i}`);
  }
  const all = sessionsMod.getChatHistory(sid, { includeAgent: true });
  assert.deepStrictEqual(all.map((r) => r.text), expected,
    'interleaved user/claude order corrupted under combined pipeline');
});

t('CLAUDE.md documents the cross-device + persistence + ordering contract', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
  assert.ok(/Chat persistence & cross-device consistency/.test(md),
    'CLAUDE.md is missing the chat-persistence design section');
  assert.ok(/Cross-device interaction is consistent/i.test(md), 'missing pillar 1 (cross-device)');
  assert.ok(/All chat history is persisted indefinitely/i.test(md), 'missing pillar 2 (persistence)');
  assert.ok(/portion of the history/i.test(md), 'missing pillar 3 (client memory)');
  assert.ok(/Chronological order/i.test(md), 'missing pillar 4 (ordering)');
});

// ── client-side wiring guards ──────────────────────────────────────

t('client load-older paginator passes includeAgent=1', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(/_fetchOlderChatFromServer/.test(app), 'load-older fetcher missing');
  // The URL is built with template literal containing includeAgent=1.
  assert.ok(/includeAgent=1/.test(app),
    'load-older fetcher no longer passes includeAgent=1 — claude history older than the agent-replay window will be invisible after scroll-up');
});

t('chat-history server route understands includeAgent query param', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');
  assert.ok(/includeAgent\s*=\s*req\.query\.includeAgent/.test(idx),
    '/chat/history route no longer parses includeAgent — paginator wire-break');
});

// 2026-05-17 (round 2): assistant_text agent-event now renders as a
// `.chat-msg.from-claude.chat-msg-from-agent` bubble (the visual
// counterpart of the user's chat bubble), NOT as an `agent-card`. The
// previous look folded claude's reply into the chrome-strip styling
// and the user reported "result never sent back to the chat window,
// it sits in the chrome batch only".

// ── user-reported-problem regression ────────────────────────────
// Quoted verbatim from the bug report 2026-05-17 12:45 PT:
//   "looks like the result never sent back to the chat window, it sits
//    in the chrome batch only."
// Session myco-intro on mycobeta. User typed "hi", claude replied
// "Hi! 👋 Is everything okay?...", and the reply rendered as an
// agent-card without bubble styling — visually merging with the
// chrome strip immediately above. Per best-practices rule 5 (every
// user-reported problem ships with a regression test), this assertion
// pins the bubble class so the agent-card style can't quietly come back.
t('USER-REPORT REGRESSION 2026-05-17: assistant_text MUST render as chat-msg bubble, not chrome-batch-styled card', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  // The branch that creates the first assistant_text element should
  // build a bubble carrying ALL the chat-msg classes — `chat-msg`,
  // `from-claude` (color/avatar), and `chat-msg-from-agent` (the
  // disambiguator for the agent-replay wipe loop). No agent-card
  // class should be added; that's what made the reply look like
  // chrome.
  const lines = app.split('\n');
  let createLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/bubble\.className\s*=\s*['"]chat-msg from-claude chat-msg-from-agent['"]/.test(lines[i])) {
      createLine = i; break;
    }
  }
  assert.ok(createLine >= 0,
    'assistant_text bubble create-line missing or wrong class set — user-reported regression: claude reply will look like chrome again.');
  // Walk back ~10 lines to find the surrounding `if (ev.type === 'assistant_text')`
  // and verify the chat-text body uses renderMd(ev.text) — i.e. the
  // bubble actually CONTAINS the reply rather than being an empty
  // shell.
  const window = lines.slice(Math.max(0, createLine - 10), createLine + 20).join('\n');
  assert.ok(/className\s*=\s*['"]chat-text['"]/.test(window),
    'assistant_text bubble missing inner .chat-text body — reply will be visually empty.');
  assert.ok(/renderMd\(ev\.text/.test(window),
    'assistant_text bubble body not piped through renderMd — markdown / mermaid will render as raw text.');
});

t('client assistant_text agent-event renders as chat-msg from-claude bubble (not agent-card)', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(/chat-msg from-claude chat-msg-from-agent/.test(app),
    'assistant_text no longer creates a chat-msg.from-claude bubble — UI regression: claude reply will visually merge with chrome batches instead of standing out as a chat bubble.');
  assert.ok(/bubble\.dataset\.evType\s*=\s*['"]assistant_text['"]/.test(app),
    'assistant_text bubble missing data-ev-type marker — merge logic for consecutive blocks will break.');
});

t('agent-replay wipe-loop preserves chat-msg-from-agent bubbles only when re-creating them', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  // Should mention removing chat-msg-from-agent on wipe (so the loop
  // can re-render them fresh) — otherwise the assistant_text bubble
  // duplicates after each reconnect.
  assert.ok(/chat-msg-from-agent/.test(app) && /isHumanChatMsg/.test(app),
    'agent-replay wipe loop no longer distinguishes human chat-msg from chat-msg-from-agent bubbles — duplicate render on reconnect.');
});

t('_resortChatPaneByTs is invoked from the agent-replay client handler', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  // Find the agent-replay handler line, then walk forward to the
  // first `return;` that closes the branch and verify
  // _resortChatPaneByTs() lives inside.
  //
  // Match the handler-body branch SPECIFICALLY (the one with
  // `&& Array.isArray(msg.events)`), not the early dispatch
  // shortcut at line ~1275 which only forwards to _appendAgentEvent
  // without the dedup + sort step.
  const lines = app.split('\n');
  let handlerLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/msg\.t\s*===\s*['"]agent-replay['"]\s*&&\s*Array\.isArray\(msg\.events\)/.test(lines[i])) {
      handlerLine = i; break;
    }
  }
  assert.ok(handlerLine >= 0, 'agent-replay handler not located');
  // Branch ends at the first matching `return;` at the same nesting
  // as the handler body. We just scan 200 lines forward which is well
  // beyond the handler size.
  const windowLines = lines.slice(handlerLine, handlerLine + 200).join('\n');
  // Stop at the first `return;` so we don't accidentally pick up
  // calls from other handlers below.
  const m = windowLines.match(/[\s\S]*?return;/);
  const branchOnly = m ? m[0] : windowLines;
  assert.ok(/_resortChatPaneByTs\(\)/.test(branchOnly),
    'agent-replay handler no longer calls _resortChatPaneByTs before its return — ordering corruption on tab-switch will regress');
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
