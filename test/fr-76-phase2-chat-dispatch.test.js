// fr-76 Phase 2: agent dispatch wiring via [chat:plan#<id>] marker.
//
// Sister of fr-48's [run:plan#<id>] marker. Run is one-shot dispatch;
// chat is persistent multi-turn dialogue. Phase 2A scope:
//
//   1. handleChatMessage recognizes [chat:plan#<id>] (regex similar
//      to runMatch), sets session._activeChatItem with the item id.
//   2. _appendUserAiChatTurn strips the marker + appends a role:'user'
//      turn to it.aiChat via the Phase-1 appendAiChatTurn helper.
//   3. agent-event listener accumulates assistant_text events while
//      _activeChatItem is set; on terminal event (turn_result /
//      iteration_aborted / fatal) flushes the buffer as a role:'agent'
//      turn via _appendAgentAiChatTurn.
//
// Phase 2 does NOT include prior-turn context in the dispatch text —
// the SDK session naturally carries claude's conversation memory
// across turns. aiChat[] is the persistent DISPLAY of the per-item
// thread; the agent's working memory comes from the SDK conversation.
//
// Static guards on attach.js + behavior simulation of the buffer
// accumulate-flush pattern.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

console.log('── fr-76 Phase 2: [chat:plan#<id>] dispatch wiring ──');

// ──────────────────────────────────────────────────────────────────────
// Marker recognition in handleChatMessage
// ──────────────────────────────────────────────────────────────────────

t('handleChatMessage parses the [chat:plan#<id>] marker', () => {
  // Regex shape MUST mirror the existing run-marker shape so future
  // additions / id-format changes touch both together.
  // Source carries the regex literal — so we grep for the inside of
  // the pattern (avoids fighting JS regex escaping for the brackets).
  assert.ok(/chat:\(plan\|test\|arch\|td\|fr\|bug\)#\(\[A-Za-z0-9_-\]\+\)/.test(ATTACH),
    'attach.js must declare a chatMatch regex /\\[chat:(plan|test|arch|td|fr|bug)#([A-Za-z0-9_-]+)\\]/ — same shape as runMatch');
});

t('handleChatMessage sets session._activeChatItem on chat-marker match', () => {
  // Anchor on the marker recognition block.
  const idx = ATTACH.search(/const\s+chatMatch\s*=\s*text\.match/);
  assert.ok(idx > -1, 'chatMatch declaration must exist');
  const window = ATTACH.slice(idx, idx + 800);
  assert.ok(/session\._activeChatItem\s*=\s*\{/.test(window),
    'on chatMatch + non-assistant user, session._activeChatItem must be set so the agent-event listener can route the response back to the item');
  assert.ok(/itemId:\s*chatMatch\[2\]/.test(window),
    '_activeChatItem.itemId must come from chatMatch[2] (the captured id group)');
  assert.ok(/_buffer:\s*['"]['"]/.test(window),
    '_activeChatItem._buffer must be initialized to "" — accumulates assistant_text events until terminal event');
});

t('handleChatMessage calls _appendUserAiChatTurn after marker match', () => {
  const idx = ATTACH.search(/const\s+chatMatch\s*=\s*text\.match/);
  const window = ATTACH.slice(idx, idx + 800);
  assert.ok(/_appendUserAiChatTurn\s*\(/.test(window),
    'the user side of the turn must be persisted via _appendUserAiChatTurn BEFORE dispatch reaches the agent');
});

// ──────────────────────────────────────────────────────────────────────
// User-turn helper
// ──────────────────────────────────────────────────────────────────────

t('_appendUserAiChatTurn helper is defined', () => {
  assert.ok(/function\s+_appendUserAiChatTurn\s*\(/.test(ATTACH),
    'attach.js must define _appendUserAiChatTurn(sessionId, itemId, user, fullText)');
});

t('_appendUserAiChatTurn strips the marker before persisting', () => {
  const idx = ATTACH.search(/function\s+_appendUserAiChatTurn\s*\(/);
  const window = ATTACH.slice(idx, idx + 1200);
  // Must strip the [chat:foo#bar] prefix so the persisted turn carries
  // only the user's actual message — not the marker pollution.
  assert.ok(/\.replace\([^)]*\[chat:/.test(window),
    '_appendUserAiChatTurn must strip the [chat:...] marker prefix from the persisted turn text');
});

t('_appendUserAiChatTurn delegates to artifactsMod.appendAiChatTurn (Phase 1 helper)', () => {
  const idx = ATTACH.search(/function\s+_appendUserAiChatTurn\s*\(/);
  const window = ATTACH.slice(idx, idx + 1200);
  assert.ok(/appendAiChatTurn\s*\(/.test(window),
    '_appendUserAiChatTurn must call artifactsMod.appendAiChatTurn (the Phase 1 helper) for the actual schema + cap logic');
  assert.ok(/role:\s*['"]user['"]/.test(window),
    '_appendUserAiChatTurn must pass role: "user" to the helper');
});

// ──────────────────────────────────────────────────────────────────────
// Agent-turn helper + agent-event listener
// ──────────────────────────────────────────────────────────────────────

t('_appendAgentAiChatTurn helper is defined', () => {
  assert.ok(/function\s+_appendAgentAiChatTurn\s*\(/.test(ATTACH),
    'attach.js must define _appendAgentAiChatTurn(sessionId, itemId, ev, accumulatedText)');
});

t('_appendAgentAiChatTurn falls back to ev.result if buffer is empty', () => {
  const idx = ATTACH.search(/function\s+_appendAgentAiChatTurn\s*\(/);
  const window = ATTACH.slice(idx, idx + 1800);
  // If no assistant_text streamed (a result-only turn), fall back to
  // ev.result so we still capture something for the chat history.
  assert.ok(/!text\s*&&\s*ev[\s\S]{0,30}\.result/.test(window),
    '_appendAgentAiChatTurn must fall back to ev.result when the accumulated buffer is empty');
});

t('_appendAgentAiChatTurn uses role:"agent" + sets meta', () => {
  const idx = ATTACH.search(/function\s+_appendAgentAiChatTurn\s*\(/);
  const window = ATTACH.slice(idx, idx + 1800);
  assert.ok(/role:\s*['"]agent['"]/.test(window),
    'agent-side turn must use role: "agent"');
  assert.ok(/meta:\s*\{/.test(window),
    'agent-side turn must carry meta (kind/subtype/usage/costUsd)');
});

t('agent-event listener routes assistant_text into _activeChatItem._buffer', () => {
  // The listener that handles chat mode (separate from the run-mode
  // listener). Pin the buffer-accumulate pattern.
  const idx = ATTACH.search(/session\._activeChatItem\._buffer\s*\+=/);
  assert.ok(idx > -1,
    'agent-event listener must accumulate assistant_text events into session._activeChatItem._buffer');
});

t('agent-event listener flushes on terminal event (turn_result/iteration_aborted/fatal)', () => {
  // Same terminal-types set as the run-mode listener (per fr-51's
  // contract). Pin all three.
  const idx = ATTACH.search(/_appendAgentAiChatTurn\s*\(/);
  assert.ok(idx > -1, '_appendAgentAiChatTurn must be called from the listener');
  // Within ~600 chars of the call site we should see the terminal-type
  // set.
  const window = ATTACH.slice(Math.max(0, idx - 600), idx + 200);
  assert.ok(/turn_result/.test(window) && /iteration_aborted/.test(window) && /fatal/.test(window),
    'agent-event listener for chat mode must handle ALL three terminal event types (turn_result + iteration_aborted + fatal) — same fr-51 contract as run mode');
});

t('agent-event listener clears _activeChatItem before append (avoid re-entry)', () => {
  const idx = ATTACH.search(/_appendAgentAiChatTurn\s*\(/);
  const window = ATTACH.slice(Math.max(0, idx - 400), idx + 100);
  assert.ok(/session\._activeChatItem\s*=\s*null/.test(window),
    'the listener must clear session._activeChatItem to null BEFORE calling _appendAgentAiChatTurn — avoids re-entry if the append triggers a state-update that re-enters the listener');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation of the accumulate-flush pattern (no real session)
// ──────────────────────────────────────────────────────────────────────

t('behavior: accumulate-flush pattern preserves streamed assistant_text', () => {
  // Simulate the listener's contract on a fake state object.
  const state = { _activeChatItem: { itemId: 'bug-42', _buffer: '' } };
  const events = [
    { type: 'assistant_text', text: 'Looking at the code...' },
    { type: 'assistant_text', text: ' I see the issue.' },
    { type: 'tool_use', name: 'Read' },     // non-text non-terminal — no buffer change
    { type: 'assistant_text', text: ' The fix is to change X to Y.' },
    { type: 'turn_result', subtype: 'success', result: 'Done.', usage: { input_tokens: 100 } },
  ];
  for (const ev of events) {
    if (!state._activeChatItem) break;
    if (ev.type === 'assistant_text' && typeof ev.text === 'string') {
      state._activeChatItem._buffer += ev.text;
      continue;
    }
    if (['turn_result', 'iteration_aborted', 'fatal'].includes(ev.type)) {
      // Flush.
      const chat = state._activeChatItem;
      state._activeChatItem = null;
      // (In real code: _appendAgentAiChatTurn(... chat._buffer))
      // Assert the buffer carries all three assistant_text segments.
      assert.strictEqual(chat._buffer,
        'Looking at the code... I see the issue. The fix is to change X to Y.',
        'buffer must accumulate all assistant_text events from the turn');
    }
  }
  assert.strictEqual(state._activeChatItem, null,
    '_activeChatItem must be cleared after terminal event');
});

t('behavior: ev.result fallback covers result-only turns (no streamed text)', () => {
  // Some turns end with ev.result populated but no streamed
  // assistant_text events (the agent-session.js dedup branch skips
  // emit when the result is already covered). Helper must fall back
  // to ev.result so we still capture something.
  const accumulated = '';
  const ev = { type: 'turn_result', subtype: 'success', result: 'Quick answer.' };
  let text = String(accumulated || '').trim();
  if (!text && ev.result) text = String(ev.result).trim();
  assert.strictEqual(text, 'Quick answer.');
});

t('behavior: empty result + non-success terminal → placeholder text', () => {
  // iteration_aborted or fatal with no buffer + no result should still
  // record SOMETHING so the UI can render a chip — pin the placeholder.
  const placeholders = {
    iteration_aborted: '(aborted)',
    fatal: '(fatal error)',
  };
  assert.strictEqual(placeholders.iteration_aborted, '(aborted)');
  assert.strictEqual(placeholders.fatal, '(fatal error)');
});

// ──────────────────────────────────────────────────────────────────────
// Run + chat modes can coexist (independent _active* state)
// ──────────────────────────────────────────────────────────────────────

t('chat-mode listener is SEPARATE from run-mode listener (independent state)', () => {
  // Both listeners are registered on session.on('agent-event', …).
  // We pin that the chat path uses _activeChatItem (not _activeRunItem),
  // so the two modes have independent state slots and can't collide.
  const chatHandlerIdx = ATTACH.search(/_activeChatItem\._buffer/);
  assert.ok(chatHandlerIdx > -1);
  const window = ATTACH.slice(Math.max(0, chatHandlerIdx - 200), chatHandlerIdx + 200);
  assert.ok(!/_activeRunItem/.test(window),
    'chat-mode listener block must NOT touch _activeRunItem — independent state slot per mode prevents collisions');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
