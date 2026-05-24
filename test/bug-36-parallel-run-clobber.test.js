// bug-36 regression: parallel /run dispatches must not clobber each
// other's responses in the per-item chat panel.
//
// User report (kkrazy 2026-05-24):
//   "Invoking /run on two plan items concurrently causes their responses
//    to clobber each other in the plan-item UI. Expected: Each plan item
//    retains its own /run response independently. Actual: The first
//    run's response is wiped out by the second run, then the second
//    run's response is also wiped out; everything ends up in the chat
//    pane instead."
//
// Root cause (pre-fix):
//   attach.js held TWO SINGULAR state slots — session._activeChatItem
//   and session._activeRunItem. Two handleChatMessage calls arriving
//   before the first turn_result both wrote to the same slot. Turn 1's
//   slot got overwritten by turn 2; the chat-mode listener buffered
//   turn 1's assistant_text into turn 2's slot; the run-mode listener
//   stamped turn 1's outcome onto turn 2's item. Both items' responses
//   ended up bound to the wrong place. fr-89's "preempt-flush" only
//   helped when the first turn's buffer was non-empty at the moment
//   the second arrived; for parallel /run with cap > 1 (fr-90 Phase 2),
//   both turns arrived in quick succession and the preempt-flush ran
//   on an empty buffer, silently dropping all binding info.
//
// Fix:
//   Replaced the singular slots with a FIFO `session._activeItemQueue`.
//   handleChatMessage pushes one entry per marker-bearing turn right
//   before session.write. A SINGLE merged agent-event listener
//   accumulates assistant_text into the head's buffer, then pops the
//   head on terminal events and binds the response/outcome to the
//   correct itemId. SDK queries are serialized per session, so events
//   arrive in dispatch order — FIFO matches the natural ordering.
//
// This test pins:
//   1. attach.js source has _activeItemQueue as a FIFO + a single
//      merged agent-event listener (NOT two slots + two listeners).
//   2. handleChatMessage pushes an entry per marker-bearing turn
//      right before session.write (not at the top of the function).
//   3. End-to-end behavior with a real EventEmitter: dispatch fr-A
//      then fr-B before fr-A's turn_result; each item gets ITS OWN
//      response in aiChat[] (no clobber).

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

console.log('── bug-36: parallel /run must not clobber responses ──');

// ──────────────────────────────────────────────────────────────────────
// Static guards on the FIFO refactor
// ──────────────────────────────────────────────────────────────────────

t('attach.js: session._activeItemQueue is the FIFO data structure', () => {
  assert.ok(/session\._activeItemQueue/.test(ATTACH),
    'attach.js must reference session._activeItemQueue (the FIFO that replaced the singular slots)');
  // The push site uses .push() not = — FIFO contract.
  assert.ok(/session\._activeItemQueue\.push\s*\(/.test(ATTACH),
    'handleChatMessage must .push() to _activeItemQueue (FIFO append)');
  // The shift site uses .shift() — pop head on terminal event.
  assert.ok(/_activeItemQueue\.shift\s*\(\s*\)/.test(ATTACH) ||
            /queue\.shift\s*\(\s*\)/.test(ATTACH),
    'agent-event listener must .shift() the FIFO head on terminal event');
});

t('attach.js: queue entries carry both chatBound + runBound flags', () => {
  // Each entry knows whether it should bind chat-side, run-side, or
  // both (the fr-89 dual-marker dispatch case). Separate flags so a
  // chat-only dispatch doesn't accidentally stamp runs[]. Allow
  // either bare chatMatch / runMatch or the hotfix _chatMatch /
  // _runMatch (handleChatPostfixes re-derives the match locally so
  // it doesn't reference handleChatMessage-scoped vars).
  assert.ok(/chatBound:\s*!!_?chatMatch/.test(ATTACH),
    'queue push must set chatBound from !!chatMatch (or hotfix _chatMatch)');
  assert.ok(/runBound:\s*!!_?runMatch/.test(ATTACH),
    'queue push must set runBound from !!runMatch (or hotfix _runMatch)');
});

t('attach.js: legacy _activeChatItem / _activeRunItem slots are gone from runtime paths', () => {
  // The legacy singular slots must not be assigned or read anywhere
  // in runtime code. We allow them in comments / commit-message
  // history references only — strip those out before checking.
  const codeOnly = ATTACH
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/session\._activeChatItem/.test(codeOnly),
    'no runtime read/write of session._activeChatItem (replaced by _activeItemQueue head)');
  assert.ok(!/session\._activeRunItem/.test(codeOnly),
    'no runtime read/write of session._activeRunItem (replaced by _activeItemQueue head)');
});

t('attach.js: ONE merged binding-listener inside _registerExternalSession (not two)', () => {
  // Pre-bug-36 there were TWO binding-listeners registered inside
  // _registerExternalSession — one for run-mode (singular slot),
  // one for chat-mode (singular slot). bug-36 collapsed both into
  // ONE merged listener that pops the FIFO head + dispatches the
  // binding(s) based on chatBound / runBound flags. Other
  // session.on('agent-event', ...) calls exist (per-WS-attach
  // forwarders in attachWebSocket / attachViewerWebSocket) — those
  // are unrelated. We narrow on _registerExternalSession's body.
  const fnIdx = ATTACH.search(/function\s+_registerExternalSession\s*\(/);
  assert.ok(fnIdx > -1, '_registerExternalSession must exist');
  // Slice to the next top-level `function` or `module.exports` so we
  // only count listeners inside this function.
  const rest = ATTACH.slice(fnIdx);
  const endIdx = rest.slice(50).search(/\nfunction\s+\w+\s*\(/);
  const body = endIdx === -1 ? rest : rest.slice(0, endIdx + 50);
  const occurrences = (body.match(/session\.on\(\s*['"]agent-event['"]\s*,/g) || []).length;
  assert.strictEqual(occurrences, 1,
    '_registerExternalSession must register exactly ONE agent-event binding-listener (was 2 pre-bug-36); count=' + occurrences);
});

t('attach.js: FIFO push happens RIGHT BEFORE session.write (not in marker block at top)', () => {
  // The push must NOT happen in the top-of-handleChatMessage marker-
  // parse block — slash commands + @mentions short-circuit before
  // session.write and would leak entries that no terminal event ever
  // pops. Push must come on the actual dispatch path.
  const writeIdx = ATTACH.search(/session\.write\s*\(\s*agentText\s*\)/);
  assert.ok(writeIdx > -1, 'session.write(agentText) call must exist');
  const pushIdx = ATTACH.search(/session\._activeItemQueue\.push\s*\(/);
  assert.ok(pushIdx > -1, 'queue push must exist');
  assert.ok(pushIdx < writeIdx,
    'the .push must come BEFORE session.write so the listener sees the entry when terminal fires');
  // The push site should NOT be inside the chatMatch-recognition
  // block at the top of handleChatMessage (which runs before the
  // slash short-circuits). Anchor: the push must be after the
  // appendChatMessage call (close to session.write).
  const appendIdx = ATTACH.search(/sessionsMod\.appendChatMessage\s*\(\s*sessionId\s*,\s*message\s*\)/);
  assert.ok(pushIdx > appendIdx,
    'the .push must be after appendChatMessage (i.e. on the dispatch path, not the early marker-parse block)');
});

t('attach.js: fr-51 fallback preserved (queue head null + rec.runQueue running → bind)', () => {
  // The fr-51 belt-and-braces fallback covers cases where the FIFO
  // entry was lost (session re-instantiation, etc.). The listener
  // must still consult rec.runQueue for a running entry when the
  // shifted head is null.
  const idx = ATTACH.search(/queue\.shift\s*\(/);
  assert.ok(idx > -1, 'queue.shift() call must exist in the listener');
  const win = ATTACH.slice(idx, idx + 2500);
  assert.ok(/runningEntry|rec\.runQueue/.test(win),
    'after shift, listener must fall back to rec.runQueue.find(running) when head is null');
  assert.ok(/\[runQueue-diag\]/.test(win),
    'fr-51 diag log line must still fire on fallback');
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end behavior simulation — the real attach.js listener picked
// up via _registerExternalSession against a temp session record.
// ──────────────────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug36-'));
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

t('behavior: two parallel chat-dispatches each land their OWN response in aiChat[]', () => {
  const sid = 'sess-bug36-1';
  seedSession(sid, [
    { id: 'fr-A', text: 'feature A', layer: 'Feature', voters: [], comments: [], aiChat: [] },
    { id: 'fr-B', text: 'feature B', layer: 'Feature', voters: [], comments: [], aiChat: [] },
  ]);
  const session = new EventEmitter();
  session.alive = true;
  attach._registerExternalSession(sid, session);

  // Simulate handleChatMessage's FIFO push for two consecutive
  // chat-marker dispatches arriving before either turn_result.
  if (!Array.isArray(session._activeItemQueue)) session._activeItemQueue = [];
  session._activeItemQueue.push({
    itemId: 'fr-A', type: 'plan', chatBound: true, runBound: false,
    startedAt: new Date().toISOString(), _buffer: '',
  });
  session._activeItemQueue.push({
    itemId: 'fr-B', type: 'plan', chatBound: true, runBound: false,
    startedAt: new Date().toISOString(), _buffer: '',
  });

  // Now stream fr-A's events, then fr-B's events. The listener must
  // bind fr-A's text to fr-A and fr-B's text to fr-B — no clobber.
  session.emit('agent-event', { type: 'assistant_text', text: 'A wrote some code' });
  session.emit('agent-event', { type: 'turn_result', subtype: 'success',
    result: 'A done', usage: { input_tokens: 100, output_tokens: 50 },
    totalCostUsd: 0.01, durationMs: 1000 });
  session.emit('agent-event', { type: 'assistant_text', text: 'B fixed a bug' });
  session.emit('agent-event', { type: 'turn_result', subtype: 'success',
    result: 'B done', usage: { input_tokens: 80, output_tokens: 40 },
    totalCostUsd: 0.008, durationMs: 900 });

  const store = sessionsMod.loadStore();
  const itemA = store.sessions[sid].artifacts.plan.items.find((i) => i.id === 'fr-A');
  const itemB = store.sessions[sid].artifacts.plan.items.find((i) => i.id === 'fr-B');
  assert.ok(Array.isArray(itemA.aiChat) && itemA.aiChat.length === 1,
    'fr-A must have exactly one aiChat turn (its own response); got ' + JSON.stringify(itemA.aiChat));
  assert.ok(Array.isArray(itemB.aiChat) && itemB.aiChat.length === 1,
    'fr-B must have exactly one aiChat turn (its own response); got ' + JSON.stringify(itemB.aiChat));
  assert.ok(/A wrote some code/.test(itemA.aiChat[0].text),
    'fr-A response must contain A\'s text, not B\'s: ' + itemA.aiChat[0].text);
  assert.ok(/B fixed a bug/.test(itemB.aiChat[0].text),
    'fr-B response must contain B\'s text, not A\'s: ' + itemB.aiChat[0].text);
  assert.strictEqual(session._activeItemQueue.length, 0,
    'queue must be empty after both terminal events popped');
});

t('behavior: two parallel run-dispatches each stamp runs[] on the correct item', () => {
  const sid = 'sess-bug36-2';
  seedSession(sid, [
    { id: 'bug-X', text: 'fix X', layer: 'Bug', voters: [], comments: [], aiChat: [] },
    { id: 'bug-Y', text: 'fix Y', layer: 'Bug', voters: [], comments: [], aiChat: [] },
  ]);
  const session = new EventEmitter();
  session.alive = true;
  attach._registerExternalSession(sid, session);

  // Push two run-bound entries to the FIFO (mimics two ▶ Run clicks
  // arriving in quick succession via the parallel-cap=3 queue).
  if (!Array.isArray(session._activeItemQueue)) session._activeItemQueue = [];
  session._activeItemQueue.push({
    itemId: 'bug-X', type: 'plan', chatBound: false, runBound: true,
    startedAt: '2026-05-24T10:00:00.000Z', _buffer: '',
  });
  session._activeItemQueue.push({
    itemId: 'bug-Y', type: 'plan', chatBound: false, runBound: true,
    startedAt: '2026-05-24T10:00:01.000Z', _buffer: '',
  });

  // X finishes first, then Y. Outcomes must land on the right items.
  session.emit('agent-event', { type: 'turn_result', subtype: 'success',
    result: 'X bug fixed', usage: { input_tokens: 200, output_tokens: 90 },
    totalCostUsd: 0.02, durationMs: 4200 });
  session.emit('agent-event', { type: 'turn_result', subtype: 'success',
    result: 'Y bug fixed', usage: { input_tokens: 180, output_tokens: 80 },
    totalCostUsd: 0.018, durationMs: 3900 });

  const store = sessionsMod.loadStore();
  const itemX = store.sessions[sid].artifacts.plan.items.find((i) => i.id === 'bug-X');
  const itemY = store.sessions[sid].artifacts.plan.items.find((i) => i.id === 'bug-Y');
  assert.ok(Array.isArray(itemX.runs) && itemX.runs.length === 1,
    'bug-X must have its own runs[] entry');
  assert.ok(Array.isArray(itemY.runs) && itemY.runs.length === 1,
    'bug-Y must have its own runs[] entry');
  assert.ok(/X bug fixed/.test(itemX.runs[0].result),
    'bug-X outcome must contain X\'s result, not Y\'s: ' + itemX.runs[0].result);
  assert.ok(/Y bug fixed/.test(itemY.runs[0].result),
    'bug-Y outcome must contain Y\'s result, not X\'s: ' + itemY.runs[0].result);
});

t('behavior: dual-marker (chat + run) entry binds BOTH sides from one queue entry', () => {
  // The fr-89 dual-marker dispatch path produces `[chat:plan#X]
  // [run:plan#X] body` — one entry with chatBound:true + runBound:true
  // should bind both runs[] and aiChat[] on the single terminal event.
  const sid = 'sess-bug36-3';
  seedSession(sid, [
    { id: 'fr-dual', text: 'dual', layer: 'Feature', voters: [], comments: [], aiChat: [] },
  ]);
  const session = new EventEmitter();
  session.alive = true;
  attach._registerExternalSession(sid, session);

  if (!Array.isArray(session._activeItemQueue)) session._activeItemQueue = [];
  session._activeItemQueue.push({
    itemId: 'fr-dual', type: 'plan', chatBound: true, runBound: true,
    startedAt: new Date().toISOString(), _buffer: '',
  });

  session.emit('agent-event', { type: 'assistant_text', text: 'dual-marker reply' });
  session.emit('agent-event', { type: 'turn_result', subtype: 'success',
    result: 'dual done', usage: { input_tokens: 50, output_tokens: 20 },
    totalCostUsd: 0.005, durationMs: 800 });

  const store = sessionsMod.loadStore();
  const item = store.sessions[sid].artifacts.plan.items.find((i) => i.id === 'fr-dual');
  assert.ok(Array.isArray(item.runs) && item.runs.length === 1,
    'dual-marker entry must stamp runs[]');
  assert.ok(Array.isArray(item.aiChat) && item.aiChat.length === 1,
    'dual-marker entry must also append aiChat[]');
  assert.ok(/dual-marker reply/.test(item.aiChat[0].text),
    'aiChat text must contain the streamed reply: ' + item.aiChat[0].text);
});

t('behavior: run-only entry does NOT pollute the previous item\'s aiChat[]', () => {
  // The classic clobber repro: dispatch fr-A as [chat:plan#fr-A]
  // (chatBound only), then before fr-A's turn_result arrives,
  // dispatch fr-B as [run:plan#fr-B] (runBound only — no chat
  // marker). fr-A's response must still land in fr-A's aiChat[];
  // fr-B's outcome must land in fr-B's runs[] without touching
  // fr-A's aiChat[].
  const sid = 'sess-bug36-4';
  seedSession(sid, [
    { id: 'fr-A', text: 'chat-only A', layer: 'Feature', voters: [], comments: [], aiChat: [] },
    { id: 'fr-B', text: 'run-only B', layer: 'Bug', voters: [], comments: [], aiChat: [] },
  ]);
  const session = new EventEmitter();
  session.alive = true;
  attach._registerExternalSession(sid, session);

  if (!Array.isArray(session._activeItemQueue)) session._activeItemQueue = [];
  session._activeItemQueue.push({
    itemId: 'fr-A', type: 'plan', chatBound: true, runBound: false,
    startedAt: new Date().toISOString(), _buffer: '',
  });
  session._activeItemQueue.push({
    itemId: 'fr-B', type: 'plan', chatBound: false, runBound: true,
    startedAt: new Date().toISOString(), _buffer: '',
  });

  session.emit('agent-event', { type: 'assistant_text', text: 'fr-A streamed answer' });
  session.emit('agent-event', { type: 'turn_result', subtype: 'success', result: 'A',
    usage: { input_tokens: 10, output_tokens: 5 }, totalCostUsd: 0.001, durationMs: 100 });
  session.emit('agent-event', { type: 'assistant_text', text: 'fr-B ignored chat text' });
  session.emit('agent-event', { type: 'turn_result', subtype: 'success', result: 'B',
    usage: { input_tokens: 10, output_tokens: 5 }, totalCostUsd: 0.001, durationMs: 100 });

  const store = sessionsMod.loadStore();
  const itemA = store.sessions[sid].artifacts.plan.items.find((i) => i.id === 'fr-A');
  const itemB = store.sessions[sid].artifacts.plan.items.find((i) => i.id === 'fr-B');
  assert.strictEqual(itemA.aiChat.length, 1, 'fr-A has its own aiChat turn');
  assert.ok(/fr-A streamed answer/.test(itemA.aiChat[0].text),
    'fr-A aiChat must contain only A\'s streamed text: ' + itemA.aiChat[0].text);
  assert.ok(!/fr-B/.test(itemA.aiChat[0].text),
    'fr-A aiChat must NOT contain any of B\'s streamed text');
  assert.ok(Array.isArray(itemB.runs) && itemB.runs.length === 1,
    'fr-B has runs[] entry');
  // fr-B aiChat[] must be empty (it was run-only — no chat binding).
  assert.ok(!Array.isArray(itemB.aiChat) || itemB.aiChat.length === 0,
    'fr-B aiChat must stay empty (run-only dispatch); got ' + JSON.stringify(itemB.aiChat));
});

t('regression: queue dispatch through handleChatMessage does NOT throw "chatMatch is not defined"', () => {
  // Hotfix on top of the bug-36 fix: the FIFO push lives inside
  // handleChatPostfixes (the fallthrough after slash/mention guards),
  // NOT inside handleChatMessage. Pre-hotfix it referenced chatMatch /
  // runMatch declared in handleChatMessage — out-of-scope by the time
  // handleChatPostfixes ran. Every queue dispatch path threw
  // `ReferenceError: chatMatch is not defined`, which the route's
  // try/catch silently logged as "[runQueue] initial dispatch failed".
  // Net effect on opti: every ▶ Run click logged an error and the
  // agent never received any text — zero progress, no symptom in the
  // UI other than the chip never advancing.
  //
  // This test calls handleChatMessage with the EXACT shape that queue
  // dispatch produces (via buildArtifactRunText) and asserts no throw +
  // a queue entry lands on the session.
  const sid = 'sess-bug36-hotfix';
  seedSession(sid, [
    { id: 'bug-99', text: 'fix the thing', layer: 'Bug', voters: [], comments: [], aiChat: [] },
  ]);
  const session = new EventEmitter();
  session.alive = true;
  session.write = () => { session._wrote = true; };
  attach._registerExternalSession(sid, session);

  // Mimic what artifacts.js line 1288 does on queue first-dispatch.
  const artifactsMod = require('../server/src/artifacts');
  const item = { id: 'bug-99', text: 'fix the thing', layer: 'Bug', comments: [] };
  const dispatchText = artifactsMod.buildArtifactRunText('plan', item, 'kkrazy');
  assert.ok(/\[run:plan#bug-99\]/.test(dispatchText), 'dispatch text must carry run marker');

  // The PRE-hotfix bug threw ReferenceError here. Post-hotfix must succeed
  // + push a queue entry.
  assert.doesNotThrow(() => {
    attach.handleChatMessage(sid, session, 'kkrazy', dispatchText);
  }, 'handleChatMessage must not throw on queue-dispatch text (the original bug-36 hotfix scope)');

  assert.ok(Array.isArray(session._activeItemQueue),
    'session._activeItemQueue must be initialized');
  assert.strictEqual(session._activeItemQueue.length, 1,
    'one entry must be pushed (the queue dispatch text carries both markers)');
  assert.strictEqual(session._activeItemQueue[0].itemId, 'bug-99');
  assert.strictEqual(session._activeItemQueue[0].runBound, true,
    'runBound must be true (dispatch text has [run:] marker)');
  assert.strictEqual(session._activeItemQueue[0].chatBound, true,
    'chatBound must be true (dispatch text has [chat:] marker per fr-89 dual-marker)');
  assert.strictEqual(session._wrote, true,
    'session.write must have been called (dispatch reached the SDK)');
});

t('behavior: FIFO queue is reset to empty when no marker entries remain', () => {
  // After the test cases above, the queue should be empty — a clean
  // post-condition guards against any subtle pop/push leak.
  const sid = 'sess-bug36-5';
  seedSession(sid, [
    { id: 'fr-only', text: 't', layer: 'Feature', voters: [], comments: [], aiChat: [] },
  ]);
  const session = new EventEmitter();
  session.alive = true;
  attach._registerExternalSession(sid, session);
  if (!Array.isArray(session._activeItemQueue)) session._activeItemQueue = [];
  session._activeItemQueue.push({
    itemId: 'fr-only', type: 'plan', chatBound: true, runBound: false,
    startedAt: new Date().toISOString(), _buffer: '',
  });
  session.emit('agent-event', { type: 'turn_result', subtype: 'success', result: 'x',
    usage: { input_tokens: 10, output_tokens: 5 }, totalCostUsd: 0.001, durationMs: 100 });
  assert.strictEqual(session._activeItemQueue.length, 0,
    'queue should be empty after the terminal event popped the only entry');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
