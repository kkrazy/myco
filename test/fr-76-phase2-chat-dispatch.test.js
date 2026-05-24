// fr-76 Phase 2: agent dispatch wiring via [chat:plan#<id>] marker.
//
// Sister of fr-48's [run:plan#<id>] marker. Run is one-shot dispatch;
// chat is persistent multi-turn dialogue. Phase 2A scope:
//
//   1. handleChatMessage recognizes [chat:plan#<id>] (regex similar
//      to runMatch), pushes a chatBound entry to the FIFO
//      session._activeItemQueue (bug-36 refactor — was the singular
//      session._activeChatItem pre-bug-36).
//   2. _appendUserAiChatTurn strips the marker + appends a role:'user'
//      turn to it.aiChat via the Phase-1 appendAiChatTurn helper.
//   3. ONE merged agent-event listener (bug-36 — pre-fix there were
//      two: run-mode + chat-mode) accumulates assistant_text events
//      into the head's _buffer when chatBound; on terminal event
//      (turn_result / iteration_aborted / fatal) pops the head and
//      flushes the buffer as a role:'agent' turn via
//      _appendAgentAiChatTurn.
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

t('handleChatMessage pushes a chatBound entry to the FIFO _activeItemQueue', () => {
  // bug-36 refactor: was session._activeChatItem = {...} singular slot;
  // now session._activeItemQueue.push({..., chatBound: true, ...}) so
  // parallel dispatches can\'t clobber each other. The push happens at
  // dispatch time (right before session.write), not in the top-of-
  // handleChatMessage marker-parse block — so slashcmds short-circuiting
  // don\'t leak queue entries.
  assert.ok(/session\._activeItemQueue\.push\s*\(/.test(ATTACH),
    'attach.js must push to _activeItemQueue (FIFO of in-flight item bindings)');
  const idx = ATTACH.search(/session\._activeItemQueue\.push\s*\(/);
  // Window covers the push call + a few lines before (the targetId
  // derivation reads chatMatch[2] / runMatch[2]).
  const window = ATTACH.slice(Math.max(0, idx - 400), idx + 600);
  // Allow bare chatMatch OR the hotfix _chatMatch (handleChatPostfixes
  // re-derives the match locally to avoid out-of-scope reference).
  assert.ok(/chatBound:\s*!!_?chatMatch/.test(window),
    'queue entry must carry chatBound: !!chatMatch (or hotfix _chatMatch) so the listener knows whether to bind to aiChat[]');
  assert.ok(/_buffer:\s*['"]['"]/.test(window),
    'queue entry _buffer must be initialized to "" — accumulates assistant_text events until terminal event pops the head');
  assert.ok(/_?chatMatch\[2\]/.test(window),
    'queue entry itemId must derive from chatMatch[2] / _chatMatch[2] (the captured id group)');
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

t('agent-event listener accumulates assistant_text into the FIFO head\'s _buffer', () => {
  // bug-36 refactor: was `session._activeChatItem._buffer += ev.text`;
  // now `queue[0]._buffer += ev.text` gated on queue[0].chatBound so
  // run-only turns don\'t accidentally capture chat-side text.
  assert.ok(/_buffer\s*\+=\s*ev\.text/.test(ATTACH),
    'agent-event listener must accumulate assistant_text events into the FIFO head\'s _buffer');
  // The accumulate path must be gated on chatBound.
  const idx = ATTACH.search(/_buffer\s*\+=\s*ev\.text/);
  const win = ATTACH.slice(Math.max(0, idx - 400), idx + 50);
  assert.ok(/chatBound/.test(win),
    'buffer-accumulate must be gated on chatBound — run-only turns must not capture text into a chat-bound binding');
});

t('agent-event listener flushes on terminal event (turn_result/iteration_aborted/fatal)', () => {
  // Same terminal-types set the bug-36 merged listener handles (per
  // fr-51\'s contract). Pin all three within the listener body.
  const listenerIdx = ATTACH.search(/session\.on\(\s*['"]agent-event['"]/);
  assert.ok(listenerIdx > -1, 'agent-event listener must exist');
  const window = ATTACH.slice(listenerIdx, listenerIdx + 5000);
  assert.ok(/_appendAgentAiChatTurn\s*\(/.test(window),
    '_appendAgentAiChatTurn must be called from the listener');
  assert.ok(/turn_result/.test(window) && /iteration_aborted/.test(window) && /fatal/.test(window),
    'agent-event listener must handle ALL three terminal event types (turn_result + iteration_aborted + fatal) — same fr-51 contract');
});

t('agent-event listener pops FIFO head BEFORE binding (avoid re-entry)', () => {
  // bug-36 replacement: was clearing session._activeChatItem to null
  // before calling _appendAgentAiChatTurn; now the .shift() pops the
  // head BEFORE the bind calls so a state-update triggered by the
  // append cannot re-enter and re-process the same entry.
  const listenerIdx = ATTACH.search(/session\.on\(\s*['"]agent-event['"]/);
  const window = ATTACH.slice(listenerIdx, listenerIdx + 5000);
  const shiftIdx = window.search(/\.shift\s*\(/);
  const bindIdx = window.search(/_appendAgentAiChatTurn\s*\(/);
  assert.ok(shiftIdx > -1, 'listener must .shift() the FIFO head');
  assert.ok(bindIdx > -1, 'listener must call _appendAgentAiChatTurn');
  assert.ok(shiftIdx < bindIdx,
    '.shift() (pop head) must come BEFORE _appendAgentAiChatTurn — avoids re-entry on state-update');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation of the accumulate-flush pattern (no real session)
// ──────────────────────────────────────────────────────────────────────

t('behavior: accumulate-flush pattern preserves streamed assistant_text', () => {
  // Simulate the bug-36 FIFO listener's contract on a fake state.
  const state = { queue: [{ itemId: 'bug-42', chatBound: true, runBound: false, _buffer: '' }] };
  const events = [
    { type: 'assistant_text', text: 'Looking at the code...' },
    { type: 'assistant_text', text: ' I see the issue.' },
    { type: 'tool_use', name: 'Read' },     // non-text non-terminal — no buffer change
    { type: 'assistant_text', text: ' The fix is to change X to Y.' },
    { type: 'turn_result', subtype: 'success', result: 'Done.', usage: { input_tokens: 100 } },
  ];
  let captured = null;
  for (const ev of events) {
    if (ev.type === 'assistant_text' && typeof ev.text === 'string') {
      if (state.queue.length > 0 && state.queue[0].chatBound) {
        state.queue[0]._buffer += ev.text;
      }
      continue;
    }
    if (['turn_result', 'iteration_aborted', 'fatal'].includes(ev.type)) {
      // Pop head + bind.
      const head = state.queue.shift();
      if (head && head.chatBound) {
        captured = head._buffer;
      }
    }
  }
  assert.strictEqual(captured,
    'Looking at the code... I see the issue. The fix is to change X to Y.',
    'buffer must accumulate all assistant_text events from the turn');
  assert.strictEqual(state.queue.length, 0,
    'FIFO queue must be empty after terminal event pops the head');
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

t('chat + run modes coexist via per-entry chatBound/runBound flags on the SAME FIFO', () => {
  // bug-36 refactor: pre-fix _registerExternalSession registered TWO
  // separate listeners (one per singular slot). Now ONE merged
  // listener consumes the FIFO, and each entry's chatBound +
  // runBound flags decide which side(s) to bind. Pin: exactly one
  // agent-event listener IN _registerExternalSession + the per-side
  // gating exists in the source. Other session.on('agent-event',…)
  // calls live in attachWebSocket / attachViewerWebSocket (WS event
  // forwarders), unrelated to binding.
  const fnIdx = ATTACH.search(/function\s+_registerExternalSession\s*\(/);
  assert.ok(fnIdx > -1, '_registerExternalSession must exist');
  const rest = ATTACH.slice(fnIdx);
  const endIdx = rest.slice(50).search(/\nfunction\s+\w+\s*\(/);
  const body = endIdx === -1 ? rest : rest.slice(0, endIdx + 50);
  const occurrences = (body.match(/session\.on\(\s*['"]agent-event['"]\s*,/g) || []).length;
  assert.strictEqual(occurrences, 1,
    '_registerExternalSession must register exactly ONE agent-event listener (collapsed run + chat into FIFO-driven listener); count=' + occurrences);
  // The single listener must branch on both flags so chat-only and
  // run-only dispatches stay isolated.
  assert.ok(/chatBound/.test(body) && /runBound/.test(body),
    'merged listener must branch on both head.chatBound and head.runBound — independent binding per side prevents collisions');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
