// fr-89: bind dispatched-action responses back to the panel + prevent
// cross-item chat leak.
//
// Two bugs, reported together by kkrazy 2026-05-24:
//
// Bug A — actions don't return to panel: pre-fix, typing /run in
// fr-1's chat panel triggered POST /queue/add which queue-dispatched
// with text starting `[run:plan#fr-1] ...`. Only the run-mode listener
// fired (session._activeRunItem was set). The chat-mode listener
// (fr-76 Phase 2) was idle because no [chat:plan#fr-1] marker was
// present, so the agent's assistant_text events never landed in the
// item's aiChat[]. Result: the panel that triggered the action saw
// nothing.
//
// Bug B — chat leak across items: pre-fix, session._activeChatItem
// was set on chat-marker arrival but only cleared on terminal event.
// If a non-chat user turn (or a chat turn for a DIFFERENT item)
// interleaved before terminal, the stale _activeChatItem kept
// accumulating the next turn's assistant_text into the wrong item's
// buffer.
//
// Fixes:
//   1. buildArtifactRunText + buildArtifactQuorumText now prepend BOTH
//      `[chat:<type>#<id>]` AND `[run:<type>#<id>]` markers, so the
//      chat-mode listener binds the response to aiChat[] alongside
//      the run-mode listener stamping runs[].
//   2. handleChatMessage now flushes + clears session._activeChatItem
//      at the START of every user turn (preempt-flush any in-flight
//      buffer to aiChat[]); the fresh chat marker (if present)
//      re-sets it. Turn-scoped, not session-scoped.
//   3. _appendUserAiChatTurn now strips BOTH chat AND run marker
//      prefixes so the persisted user turn carries neither.
//
// Static guards on artifacts.js + attach.js + behavior simulation
// of the dual-marker output + the preempt-flush ordering.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ARTIFACTS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');
const ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

console.log('── fr-89: panel response binding + chat leak ──');

// ──────────────────────────────────────────────────────────────────────
// Bug A: dispatch text carries BOTH markers
// ──────────────────────────────────────────────────────────────────────

t('artifacts.js: buildArtifactRunText output carries [chat:] + [run:] markers', () => {
  const artifacts = require('../server/src/artifacts');
  const item = { id: 'fr-89', text: 'test', layer: 'Feature' };
  const text = artifacts.buildArtifactRunText('plan', item, 'kkrazy');
  assert.match(text, /\[chat:plan#fr-89\]/,
    '[chat:plan#fr-89] must be present so the chat-mode listener binds the response to fr-89\'s aiChat[]');
  assert.match(text, /\[run:plan#fr-89\]/,
    '[run:plan#fr-89] must still be present so the run-mode listener stamps fr-89\'s runs[] (fr-48 contract)');
});

t('artifacts.js: buildArtifactQuorumText also carries both markers', () => {
  const artifacts = require('../server/src/artifacts');
  const item = { id: 'fr-89', text: 'test', voters: ['alice', 'bob'] };
  const text = artifacts.buildArtifactQuorumText('plan', item);
  assert.match(text, /\[chat:plan#fr-89\]/);
  assert.match(text, /\[run:plan#fr-89\]/);
});

t('artifacts.js: chat marker precedes run marker (consistent order)', () => {
  const artifacts = require('../server/src/artifacts');
  const item = { id: 'fr-89', text: 't', layer: 'Feature' };
  const text = artifacts.buildArtifactRunText('plan', item, 'k');
  const chatIdx = text.indexOf('[chat:');
  const runIdx = text.indexOf('[run:');
  assert.ok(chatIdx > -1 && runIdx > -1);
  assert.ok(chatIdx < runIdx,
    '[chat:] should appear before [run:] in the output — consistent order makes the strip + recognition regexes simpler');
});

t('artifacts.js: dual-marker output still matches BOTH marker-parse regexes used in attach.js', () => {
  const artifacts = require('../server/src/artifacts');
  const item = { id: 'bug-17', text: 't', layer: 'Bug' };
  const text = artifacts.buildArtifactRunText('plan', item, 'kkrazy');
  // Mirror the exact regexes in attach.js handleChatMessage.
  const RUN_RE = /\[run:(plan|test|arch|td|fr|bug)#([A-Za-z0-9_-]+)\]/;
  const CHAT_RE = /\[chat:(plan|test|arch|td|fr|bug)#([A-Za-z0-9_-]+)\]/;
  const r = text.match(RUN_RE);
  const c = text.match(CHAT_RE);
  assert.ok(r, 'run regex must match dual-marker text');
  assert.ok(c, 'chat regex must match dual-marker text');
  assert.strictEqual(r[2], 'bug-17');
  assert.strictEqual(c[2], 'bug-17');
});

// ──────────────────────────────────────────────────────────────────────
// Bug B: chat leak / clobber — superseded by bug-36 FIFO refactor
// ──────────────────────────────────────────────────────────────────────
//
// fr-89's "preempt-flush" was a partial fix that only helped when the
// stale buffer was non-empty at the moment a new turn arrived. It
// missed the parallel-/run case (fr-90 Phase 2 cap > 1) where two
// dispatches arrived in quick succession and both turns' bindings
// landed on the wrong item. bug-36 replaced the singular slots with a
// FIFO `session._activeItemQueue`; the per-turn isolation is now
// structural, not flush-based. See test/bug-36-parallel-run-clobber.test.js
// for the regression guards. Below we re-assert the contract fr-89
// originally protected — different mechanism, same invariant:
// each turn's response binds to its own item.

t('attach.js: bug-36 FIFO replaces the fr-89 singular-slot + preempt-flush pair', () => {
  // The FIFO queue is the new mechanism; the singular slots are gone.
  assert.ok(/session\._activeItemQueue/.test(ATTACH),
    'attach.js must use session._activeItemQueue (bug-36 FIFO)');
  // Comments / commit history may still mention the legacy names;
  // strip comment lines before checking the runtime code shape.
  const codeOnly = ATTACH.split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/session\._activeChatItem/.test(codeOnly),
    'singular session._activeChatItem must be gone from runtime code (replaced by FIFO)');
  assert.ok(!/session\._activeRunItem/.test(codeOnly),
    'singular session._activeRunItem must be gone from runtime code (replaced by FIFO)');
});

t('attach.js: agent-event listener pops FIFO head + binds via chatBound/runBound flags', () => {
  // The listener must shift() the head on terminal events and
  // dispatch to the chat-side and run-side handlers based on the
  // entry's flags. Pin both the shift + the flag-driven branches.
  const idx = ATTACH.search(/session\.on\(\s*['"]agent-event['"]/);
  assert.ok(idx > -1, 'agent-event listener must exist');
  const win = ATTACH.slice(idx, idx + 4000);
  assert.ok(/\.shift\s*\(/.test(win), 'listener must .shift() the FIFO head');
  assert.ok(/head\.chatBound|chatBound\)/.test(win),
    'listener must branch on head.chatBound for chat-side binding');
  assert.ok(/head\.runBound|runBound\)/.test(win),
    'listener must branch on head.runBound for run-side binding');
});

t('attach.js: assistant_text only accumulates into the head\'s buffer when chatBound', () => {
  // Run-only turns must NOT capture assistant_text into a buffer that
  // gets bound to a chat item somewhere else — that was the original
  // clobber. Pin the chatBound gate around the buffer-accumulate path.
  const idx = ATTACH.search(/_activeItemQueue/);
  const win = ATTACH.slice(idx, idx + 4000);
  // Match e.g. `if (queue.length > 0 && queue[0].chatBound) { ... _buffer += ev.text` etc.
  assert.ok(/chatBound[\s\S]{0,80}_buffer\s*\+=/.test(win),
    'assistant_text buffer-accumulate must be gated on head.chatBound — otherwise run-only turns clobber the head\'s buffer');
});

// ──────────────────────────────────────────────────────────────────────
// _appendUserAiChatTurn handles dual-marker input
// ──────────────────────────────────────────────────────────────────────

t('attach.js: _appendUserAiChatTurn strips BOTH chat AND run marker prefixes', () => {
  // Queue dispatches now produce `[chat:plan#X] [run:plan#X] body`.
  // The persisted user turn should show only `body`, not the markers.
  const idx = ATTACH.search(/function\s+_appendUserAiChatTurn\s*\(/);
  const win = ATTACH.slice(idx, idx + 1500);
  assert.ok(/\.replace\([^)]*chat:[^)]*\)/.test(win),
    'must strip [chat:...] prefix');
  assert.ok(/\.replace\([^)]*run:[^)]*\)/.test(win),
    'must strip [run:...] prefix (added in fr-89 for dual-marker output)');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation — pure logic, source-independent
// ──────────────────────────────────────────────────────────────────────

t('behavior: dual-marker strip yields the bare body text', () => {
  // The strip-both pattern handles either order (chat-first or
  // run-first) so the persisted user turn is clean.
  const stripBoth = (s) => String(s || '')
    .replace(/^\[chat:[^\]]+\]\s*/, '')
    .replace(/^\[run:[^\]]+\]\s*/, '')
    .replace(/^\[chat:[^\]]+\]\s*/, '')
    .trim();
  assert.strictEqual(
    stripBoth('[chat:plan#fr-1] [run:plan#fr-1] hello there'),
    'hello there');
  assert.strictEqual(
    stripBoth('[run:plan#fr-1] [chat:plan#fr-1] hello'),
    'hello');
  assert.strictEqual(stripBoth('plain text no marker'), 'plain text no marker');
  assert.strictEqual(stripBoth('[chat:plan#fr-1] only chat'), 'only chat');
  assert.strictEqual(stripBoth('[run:plan#fr-1] only run'), 'only run');
});

t('behavior: FIFO queue isolates per-turn bindings (state-machine simulation)', () => {
  // bug-36 replacement for fr-89's preempt-flush simulation. The new
  // design: each turn pushes one entry to a FIFO queue; terminal
  // events pop the head + bind. Two interleaved dispatches each
  // bind to their own item — no clobber.
  const queue = [];
  const aiChatWritten = [];   // mock: { itemId, text }
  const runsWritten = [];     // mock: { itemId, result }
  const dispatch = (chatId, runId) => {
    queue.push({
      itemId: chatId || runId,
      chatBound: !!chatId,
      runBound: !!runId,
      _buffer: '',
    });
  };
  const onText = (txt) => {
    if (queue.length > 0 && queue[0].chatBound) queue[0]._buffer += txt;
  };
  const onTerminal = (ev) => {
    if (queue.length === 0) return;
    const head = queue.shift();
    if (head.runBound) runsWritten.push({ itemId: head.itemId, result: ev.result });
    if (head.chatBound) aiChatWritten.push({ itemId: head.itemId, text: head._buffer });
  };

  // Dispatch fr-1 (chat), then fr-2 (run), then events for both.
  dispatch('fr-1', null);
  dispatch(null, 'fr-2');
  onText('text for fr-1');
  onTerminal({ type: 'turn_result', result: 'fr-1 done' });
  onText('text for fr-2 (run-only, should not be captured)');
  onTerminal({ type: 'turn_result', result: 'fr-2 done' });

  // Each item bound to its own response/outcome.
  assert.strictEqual(aiChatWritten.length, 1, 'one aiChat write (fr-1 only)');
  assert.strictEqual(aiChatWritten[0].itemId, 'fr-1');
  assert.strictEqual(aiChatWritten[0].text, 'text for fr-1',
    'fr-1 aiChat must carry fr-1\'s text, not fr-2\'s');
  assert.strictEqual(runsWritten.length, 1, 'one runs write (fr-2 only)');
  assert.strictEqual(runsWritten[0].itemId, 'fr-2');
  assert.strictEqual(runsWritten[0].result, 'fr-2 done');
  assert.strictEqual(queue.length, 0, 'queue empty after both pops');
});

t('behavior: FIFO preserves chat→chat handoff without losing data', () => {
  // Two chat dispatches for DIFFERENT items in quick succession. Each
  // turn\'s buffer binds to its own item. No cross-contamination.
  const queue = [];
  const aiChatWritten = [];
  const dispatch = (id) => queue.push({ itemId: id, chatBound: true, runBound: false, _buffer: '' });
  const onText = (txt) => { if (queue.length > 0 && queue[0].chatBound) queue[0]._buffer += txt; };
  const onTerminal = () => {
    if (queue.length === 0) return;
    const head = queue.shift();
    if (head.chatBound) aiChatWritten.push({ itemId: head.itemId, text: head._buffer });
  };
  dispatch('fr-1');
  dispatch('fr-2');
  onText('partial-fr1');
  onTerminal();
  onText('answer-fr2');
  onTerminal();
  assert.deepStrictEqual(aiChatWritten, [
    { itemId: 'fr-1', text: 'partial-fr1' },
    { itemId: 'fr-2', text: 'answer-fr2' },
  ]);
  assert.strictEqual(queue.length, 0);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
