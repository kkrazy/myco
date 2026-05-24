// bug-37: SDK batches multiple rapid session.write calls into a single
// turn, so N writes can produce M ≤ N turn_results. The bug-36 FIFO
// fix assumed 1:1 — popping only one head per turn_result left the
// other batched entries stranded at the head + every subsequent
// turn bound to the wrong item.
//
// Live capture from opti.labxnow.ai events.jsonl (2026-05-24 15:54):
//   58 [15:54:36] TURN_START bug-31    ← write 1
//   59 [15:54:46] TURN_START bug-32    ← write 2 (SDK still on turn 1)
//   60 [15:54:53] TURN_START bug-33    ← write 3 (SDK still on turn 1)
//   61-64       (4 assistant_text events — agent batched all 3)
//   65 [15:56:28] TURN_RESULT          ← ONE turn_result for THREE writes
//
// User-visible symptom: only bug-31 got an agent response in its panel;
// bug-32/33 panels stayed empty (their FIFO entries pushed but never
// popped). Subsequent turns then bound to the WRONG items.
//
// Fix (bug-37 variant B):
//   1. Count `turn_start` events as session._pendingTurnStarts.
//   2. On terminal event, pop max(1, pendingTurnStarts) heads (capped
//      at queue.length). Reset counter.
//   3. Distribute the SHARED agent response (queue[0]._buffer captured
//      before popping) to EVERY popped head's chat-side binding — each
//      item's panel gets a full copy of the agent's reply since the
//      SDK batched these writes into one logical turn.
//   4. assistant_text accumulates into queue[0]._buffer unconditionally
//      (no chatBound gate) so mixed batches still capture text.
//   5. _bindHeadToTerminal helper factored out — same binding logic
//      shared by the main pop-loop + the fr-51 fallback path.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

console.log('── bug-37: SDK-batched turn → distribute to all popped heads ──');

// ──────────────────────────────────────────────────────────────────────
// Source-shape guards
// ──────────────────────────────────────────────────────────────────────

t('attach.js: session._pendingTurnStarts counter tracks writes between terminals', () => {
  assert.ok(/session\._pendingTurnStarts/.test(ATTACH),
    'attach.js must declare session._pendingTurnStarts counter');
  // Counter incremented on turn_start.
  assert.ok(/turn_start[\s\S]{0,200}_pendingTurnStarts\s*\+?=/.test(ATTACH),
    'counter must be incremented on turn_start event');
  // Counter reset on terminal event.
  assert.ok(/_pendingTurnStarts\s*=\s*0/.test(ATTACH),
    'counter must be reset to 0 after the terminal-event pop');
});

t('attach.js: pop count = max(1, pendingTurnStarts), capped at queue.length', () => {
  // The pop count formula must be defensive — at least 1 (for cases
  // where the SDK fires a terminal without a preceding turn_start,
  // like the fr-51 fallback) and at most queue.length (never shift
  // beyond what\'s there).
  // Pin both Math.max + Math.min anywhere in the source — they're
  // unambiguous expressions; if they exist with these arg lists the
  // logic is correct.
  assert.ok(/Math\.max\s*\(\s*1\s*,\s*session\._pendingTurnStarts\s*\)/.test(ATTACH),
    'popCount must be at least 1 (Math.max(1, session._pendingTurnStarts))');
  assert.ok(/Math\.min\s*\(\s*popCount\s*,\s*queue\.length\s*\)/.test(ATTACH),
    'popCount must be capped at queue.length (Math.min(popCount, queue.length))');
});

t('attach.js: shared buffer captured BEFORE popping (variant B)', () => {
  // queue[0]._buffer accumulated the assistant_text. After we pop
  // queue[0], we still need the buffer for the OTHER popped heads\'
  // chat bindings. Capture it before the shift loop.
  const idx = ATTACH.search(/sharedBuffer/);
  assert.ok(idx > -1, 'sharedBuffer variable must be declared');
  // The capture must happen before the for-loop that shifts.
  const captureIdx = ATTACH.search(/const\s+sharedBuffer\s*=\s*queue\[0\]\._buffer/);
  assert.ok(captureIdx > -1,
    'sharedBuffer must be assigned from queue[0]._buffer (captured before pop)');
  // The for-loop must reference sharedBuffer for binding.
  const loopWin = ATTACH.slice(captureIdx, captureIdx + 1000);
  assert.ok(/for\s*\([\s\S]{0,200}\.shift\s*\(\s*\)[\s\S]{0,400}_bindHeadToTerminal[\s\S]{0,200}sharedBuffer/.test(loopWin),
    'for-loop must pass sharedBuffer to _bindHeadToTerminal for each popped head');
});

t('attach.js: _bindHeadToTerminal helper exists + handles all 3 bindings', () => {
  // Factored-out helper that the main pop-loop + fr-51 fallback both
  // call. Must handle:
  //   - runBound + turn_result → _stampPlanItemRunOutcome
  //   - runBound + abort/fatal → _stampPlanItemStatus
  //   - runBound (any terminal) → _advanceRunQueue
  //   - chatBound (any terminal) → _appendAgentAiChatTurn(sharedBuffer)
  const idx = ATTACH.search(/function\s+_bindHeadToTerminal\s*\(/);
  assert.ok(idx > -1, '_bindHeadToTerminal helper must be defined at module scope');
  const win = ATTACH.slice(idx, idx + 2500);
  assert.ok(/head\.runBound/.test(win), 'helper must check head.runBound');
  assert.ok(/head\.chatBound/.test(win), 'helper must check head.chatBound');
  assert.ok(/_stampPlanItemRunOutcome\s*\(/.test(win),
    'helper must call _stampPlanItemRunOutcome on turn_result');
  assert.ok(/_stampPlanItemStatus\s*\(/.test(win),
    'helper must call _stampPlanItemStatus on abort/fatal');
  assert.ok(/_advanceRunQueue\s*\(/.test(win),
    'helper must call _advanceRunQueue for run-bound heads');
  assert.ok(/_appendAgentAiChatTurn\s*\(/.test(win),
    'helper must call _appendAgentAiChatTurn for chat-bound heads');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation — the SDK-batching scenario from opti's
// events.jsonl, replayed against a real attach.handleChatMessage +
// agent-event listener.
// ──────────────────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug37-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });
fs.writeFileSync(
  path.join(process.env.MYCO_STATE_DIR, 'allowed-github-users.txt'),
  '# test fixture\nkkrazy\n');

const sessionsMod = require('../server/src/sessions');
const attach = require('../server/src/attach');
const { EventEmitter } = require('events');

function seedSession(sid, items) {
  const store = sessionsMod.loadStore();
  store.sessions = store.sessions || {};
  store.sessions[sid] = {
    id: sid,
    user: 'kkrazy',
    cwd: '.',
    absCwd: process.env.MYCO_WORKSPACE,
    createdAt: new Date().toISOString(),
    chat: [],
    artifacts: { plan: { items, updatedAt: null } },
  };
  sessionsMod.saveStore();
}

t('behavior: SDK-batched turn (3 writes → 1 turn_result) distributes to ALL 3 items', () => {
  // The actual repro from opti events.jsonl. Push 3 chat-bound
  // entries (simulating 3 parallel /run dispatches via fr-90 cap=3),
  // emit 3 turn_start events to mimic the SDK's per-write signal,
  // then ONE turn_result. All 3 items must get the agent text.
  const sid = 'sess-bug37-batch';
  seedSession(sid, [
    { id: 'bug-31', text: 'test1', layer: 'Bug', voters: [], comments: [], aiChat: [] },
    { id: 'bug-32', text: 'test2', layer: 'Bug', voters: [], comments: [], aiChat: [] },
    { id: 'bug-33', text: 'test3', layer: 'Bug', voters: [], comments: [], aiChat: [] },
  ]);
  const session = new EventEmitter();
  session.alive = true;
  attach._registerExternalSession(sid, session);

  // Simulate the 3-burst dispatch: each push + each turn_start.
  if (!Array.isArray(session._activeItemQueue)) session._activeItemQueue = [];
  for (const id of ['bug-31', 'bug-32', 'bug-33']) {
    session._activeItemQueue.push({
      itemId: id, type: 'plan', chatBound: true, runBound: true,
      startedAt: new Date().toISOString(), _buffer: '',
    });
    session.emit('agent-event', { type: 'turn_start', prompt: '[chat:plan#' + id + ']' });
  }

  // SDK emits the combined turn: assistant_text events buffering into queue[0].
  session.emit('agent-event', { type: 'assistant_text',
    text: 'Three test dispatches received. Handling all together: ' });
  session.emit('agent-event', { type: 'assistant_text',
    text: '✓ bug-31 ✓ bug-32 ✓ bug-33 — closed.' });
  // ONE terminal event for all 3 writes.
  session.emit('agent-event', { type: 'turn_result', subtype: 'success',
    result: 'all 3 closed', usage: { input_tokens: 100, output_tokens: 60 },
    totalCostUsd: 0.012, durationMs: 1500 });

  const store = sessionsMod.loadStore();
  const items = ['bug-31', 'bug-32', 'bug-33'].map(
    (id) => store.sessions[sid].artifacts.plan.items.find((i) => i.id === id));
  for (const it of items) {
    assert.ok(Array.isArray(it.runs) && it.runs.length === 1,
      it.id + ' must have a runs[] entry stamped (SDK-batched turn distributed)');
    assert.strictEqual(it.runs[0].status, 'success',
      it.id + ' run status must be success');
    assert.ok(Array.isArray(it.aiChat) && it.aiChat.length === 1,
      it.id + ' must have an aiChat[agent] entry');
    assert.ok(/Three test dispatches|bug-31.*bug-32.*bug-33/.test(it.aiChat[0].text),
      it.id + ' aiChat must carry the shared turn text: ' + it.aiChat[0].text);
  }
  assert.strictEqual(session._activeItemQueue.length, 0,
    'all 3 entries must be popped after the single terminal event');
  assert.strictEqual(session._pendingTurnStarts, 0,
    'pendingTurnStarts counter must reset to 0');
});

t('behavior: 1:1 turn_start/turn_result (no batching) — pop one head per terminal', () => {
  // Sanity: when writes are spaced out and the SDK gives 1:1, the
  // FIFO behaves identically to the bug-36 design — one head popped
  // per turn_result, no over-distribution.
  const sid = 'sess-bug37-onetoone';
  seedSession(sid, [
    { id: 'fr-A', text: 'a', layer: 'Feature', voters: [], comments: [], aiChat: [] },
    { id: 'fr-B', text: 'b', layer: 'Feature', voters: [], comments: [], aiChat: [] },
  ]);
  const session = new EventEmitter();
  session.alive = true;
  attach._registerExternalSession(sid, session);
  if (!Array.isArray(session._activeItemQueue)) session._activeItemQueue = [];

  // Push fr-A + emit turn_start + emit turn_result.
  session._activeItemQueue.push({
    itemId: 'fr-A', type: 'plan', chatBound: true, runBound: false,
    startedAt: new Date().toISOString(), _buffer: '',
  });
  session.emit('agent-event', { type: 'turn_start', prompt: '[chat:plan#fr-A]' });
  session.emit('agent-event', { type: 'assistant_text', text: 'A response' });
  session.emit('agent-event', { type: 'turn_result', subtype: 'success', result: 'A',
    usage: { input_tokens: 10, output_tokens: 5 }, totalCostUsd: 0.001, durationMs: 100 });

  // Then fr-B — separate turn.
  session._activeItemQueue.push({
    itemId: 'fr-B', type: 'plan', chatBound: true, runBound: false,
    startedAt: new Date().toISOString(), _buffer: '',
  });
  session.emit('agent-event', { type: 'turn_start', prompt: '[chat:plan#fr-B]' });
  session.emit('agent-event', { type: 'assistant_text', text: 'B response' });
  session.emit('agent-event', { type: 'turn_result', subtype: 'success', result: 'B',
    usage: { input_tokens: 10, output_tokens: 5 }, totalCostUsd: 0.001, durationMs: 100 });

  const store = sessionsMod.loadStore();
  const itemA = store.sessions[sid].artifacts.plan.items.find((i) => i.id === 'fr-A');
  const itemB = store.sessions[sid].artifacts.plan.items.find((i) => i.id === 'fr-B');
  assert.strictEqual(itemA.aiChat.length, 1, 'fr-A has its own aiChat');
  assert.ok(/A response/.test(itemA.aiChat[0].text),
    'fr-A aiChat must contain A\'s text: ' + itemA.aiChat[0].text);
  assert.ok(!/B response/.test(itemA.aiChat[0].text),
    'fr-A aiChat must NOT contain B\'s text (1:1 boundary preserved)');
  assert.strictEqual(itemB.aiChat.length, 1, 'fr-B has its own aiChat');
  assert.ok(/B response/.test(itemB.aiChat[0].text),
    'fr-B aiChat must contain B\'s text');
  assert.strictEqual(session._activeItemQueue.length, 0);
});

t('behavior: defensive — terminal with 0 turn_starts pops at least 1 (covers fr-51 fallback)', () => {
  // If the SDK fires a terminal without a preceding turn_start (e.g.
  // session re-instantiation by the reaper, dispatch path bypassed
  // marker parsing), popCount = max(1, 0) = 1 keeps the queue
  // draining instead of growing forever.
  const sid = 'sess-bug37-defensive';
  seedSession(sid, [
    { id: 'fr-X', text: 'x', layer: 'Feature', voters: [], comments: [], aiChat: [] },
  ]);
  const session = new EventEmitter();
  session.alive = true;
  attach._registerExternalSession(sid, session);
  if (!Array.isArray(session._activeItemQueue)) session._activeItemQueue = [];

  // Push entry but don\'t emit turn_start (simulates stale state).
  session._activeItemQueue.push({
    itemId: 'fr-X', type: 'plan', chatBound: true, runBound: false,
    startedAt: new Date().toISOString(), _buffer: 'buffered before terminal',
  });
  // Terminal arrives — pendingTurnStarts is 0.
  session.emit('agent-event', { type: 'turn_result', subtype: 'success', result: 'x',
    usage: { input_tokens: 5, output_tokens: 2 }, totalCostUsd: 0.0005, durationMs: 50 });

  const store = sessionsMod.loadStore();
  const itemX = store.sessions[sid].artifacts.plan.items.find((i) => i.id === 'fr-X');
  assert.strictEqual(itemX.aiChat.length, 1,
    'defensive path must still pop the head + bind (max(1, 0) = 1)');
  assert.strictEqual(session._activeItemQueue.length, 0,
    'queue empty after defensive pop');
});

t('behavior: mixed batch (run-only + chat-bound) — buffer captures + distributes correctly', () => {
  // Push 2 entries: first is run-only (no chat marker), second is
  // chat-bound. Pre-bug-37 the chatBound gate would have skipped
  // accumulating assistant_text into queue[0]\'s buffer (since
  // queue[0].chatBound=false), leaving the chat-bound head with
  // empty content. Post-bug-37: always buffer; distribute to all.
  const sid = 'sess-bug37-mixed';
  seedSession(sid, [
    { id: 'bug-R', text: 'run-only', layer: 'Bug', voters: [], comments: [], aiChat: [] },
    { id: 'bug-C', text: 'chat-bound', layer: 'Bug', voters: [], comments: [], aiChat: [] },
  ]);
  const session = new EventEmitter();
  session.alive = true;
  attach._registerExternalSession(sid, session);
  if (!Array.isArray(session._activeItemQueue)) session._activeItemQueue = [];

  // bug-R: run-only (chatBound=false)
  session._activeItemQueue.push({
    itemId: 'bug-R', type: 'plan', chatBound: false, runBound: true,
    startedAt: new Date().toISOString(), _buffer: '',
  });
  session.emit('agent-event', { type: 'turn_start', prompt: '[run:plan#bug-R]' });
  // bug-C: chat-bound (chatBound=true)
  session._activeItemQueue.push({
    itemId: 'bug-C', type: 'plan', chatBound: true, runBound: false,
    startedAt: new Date().toISOString(), _buffer: '',
  });
  session.emit('agent-event', { type: 'turn_start', prompt: '[chat:plan#bug-C]' });

  // SDK batches them — assistant_text fires while queue[0]=bug-R (run-only).
  session.emit('agent-event', { type: 'assistant_text', text: 'mixed-batch response' });
  session.emit('agent-event', { type: 'turn_result', subtype: 'success', result: 'mixed',
    usage: { input_tokens: 20, output_tokens: 10 }, totalCostUsd: 0.002, durationMs: 200 });

  const store = sessionsMod.loadStore();
  const itemR = store.sessions[sid].artifacts.plan.items.find((i) => i.id === 'bug-R');
  const itemC = store.sessions[sid].artifacts.plan.items.find((i) => i.id === 'bug-C');
  // bug-R: run-only → runs[] entry, NO aiChat (not chat-bound).
  assert.ok(Array.isArray(itemR.runs) && itemR.runs.length === 1,
    'bug-R must have runs[] stamped (it\'s run-bound)');
  assert.ok(!Array.isArray(itemR.aiChat) || itemR.aiChat.length === 0,
    'bug-R aiChat must stay empty (not chat-bound)');
  // bug-C: chat-bound → aiChat[] entry with the agent text, NO runs.
  assert.ok(Array.isArray(itemC.aiChat) && itemC.aiChat.length === 1,
    'bug-C must have aiChat[agent] entry');
  assert.ok(/mixed-batch response/.test(itemC.aiChat[0].text),
    'bug-C aiChat must contain the shared buffer text (variant B distributes despite queue[0] being run-only): ' + itemC.aiChat[0].text);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
