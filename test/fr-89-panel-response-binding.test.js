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
// Bug B: handleChatMessage flushes + clears stale _activeChatItem
// ──────────────────────────────────────────────────────────────────────

t('attach.js: handleChatMessage preempt-flushes _activeChatItem at start of each user turn', () => {
  // The leak fix — pre-fix _activeChatItem persisted across turns
  // and the chat-mode listener kept routing assistant_text into the
  // stale item's buffer. Post-fix: at every user turn start, if
  // _activeChatItem is set, flush its buffer to aiChat[] then clear.
  // The fresh chat marker (if any) re-sets it.
  //
  // Pin the flush+clear logic anchored on the comment + the call.
  assert.ok(/preempt-flush|preempt[\s\S]{0,50}flush|fr-89 leak fix/i.test(ATTACH),
    'attach.js must explicitly comment the fr-89 leak fix / preempt-flush');
  // The cleanup must happen BEFORE the new chat marker is matched
  // (otherwise the fresh _activeChatItem just got set + immediately
  // cleared).
  const flushIdx = ATTACH.search(/session\._activeChatItem\s*=\s*null/);
  const matchIdx = ATTACH.search(/const\s+chatMatch\s*=\s*text\.match/);
  assert.ok(flushIdx > -1, 'must clear _activeChatItem to null somewhere');
  assert.ok(matchIdx > -1, 'chatMatch declaration must exist');
  assert.ok(flushIdx < matchIdx,
    'the flush+clear must come BEFORE chatMatch — otherwise the fresh chat marker gets clobbered by the cleanup');
});

t('attach.js: preempt-flush calls _appendAgentAiChatTurn with the stale buffer', () => {
  // The buffer must be salvaged, not silently dropped — preserves
  // any in-flight assistant_text from the previous turn.
  const idx = ATTACH.search(/fr-89 leak fix|preempt-flush/i);
  assert.ok(idx > -1, 'fr-89 leak fix block must exist');
  const win = ATTACH.slice(idx, idx + 1500);
  assert.ok(/_appendAgentAiChatTurn\s*\(/.test(win),
    'preempt-flush must call _appendAgentAiChatTurn to save the in-flight buffer to aiChat[]');
  assert.ok(/stale\._buffer/.test(win),
    'must read .stale._buffer (the in-flight assistant_text accumulated for the previous turn)');
});

t('attach.js: preempt-flush only fires when buffer has content (no empty turn pollution)', () => {
  const idx = ATTACH.search(/fr-89 leak fix|preempt-flush/i);
  const win = ATTACH.slice(idx, idx + 1500);
  assert.ok(/_buffer[\s\S]{0,50}\.trim\(\)/.test(win),
    'flush must guard on .trim() — empty/whitespace-only buffers don\'t create pollution turns');
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

t('behavior: preempt-flush prevents cross-item leak (state-machine simulation)', () => {
  // Simulate: turn 1 starts chat for fr-1, mid-flight a new turn 2
  // (without chat marker) arrives. Pre-fix: turn 2's assistant_text
  // would accumulate into fr-1's buffer. Post-fix: turn 2's start
  // flushes turn 1's partial buffer to aiChat[] + clears
  // _activeChatItem, so turn 2's text goes nowhere (no chat
  // marker → no aiChat binding).
  const session = { _activeChatItem: null };
  const aiChatWritten = [];   // mock: each entry = { itemId, text }
  const flushAndAppend = (itemId, ev, buffer) => aiChatWritten.push({ itemId, text: buffer });

  // Turn 1 arrives with [chat:plan#fr-1] marker.
  const startTurn = (text) => {
    // preempt-flush
    if (session._activeChatItem && session._activeChatItem._buffer
        && session._activeChatItem._buffer.trim()) {
      flushAndAppend(session._activeChatItem.itemId, { type: 'preempt' },
        session._activeChatItem._buffer);
    }
    session._activeChatItem = null;
    // re-set if marker present
    const m = text.match(/\[chat:plan#([A-Za-z0-9_-]+)\]/);
    if (m) {
      session._activeChatItem = { itemId: m[1], _buffer: '' };
    }
  };

  startTurn('[chat:plan#fr-1] hello fr-1');
  assert.strictEqual(session._activeChatItem.itemId, 'fr-1');
  // Mid-flight: agent produces partial buffer (assistant_text events).
  session._activeChatItem._buffer = 'agent partial reply';
  // Turn 2 arrives WITHOUT chat marker (e.g. a queue dispatch
  // with only [run:plan#fr-2]).
  startTurn('[run:plan#fr-2] dispatched fr-2');
  // Turn 1's partial buffer should have been flushed to fr-1's aiChat.
  assert.strictEqual(aiChatWritten.length, 1);
  assert.strictEqual(aiChatWritten[0].itemId, 'fr-1');
  assert.strictEqual(aiChatWritten[0].text, 'agent partial reply');
  // _activeChatItem is now null (no chat marker on turn 2).
  assert.strictEqual(session._activeChatItem, null,
    'no chat marker on turn 2 → _activeChatItem stays null → no leak');
});

t('behavior: preempt-flush does NOT lose data on chat→chat handoff', () => {
  // Same state machine, but turn 2 has a chat marker for a DIFFERENT
  // item. Turn 1's partial buffer must still flush to fr-1, then turn 2
  // re-binds to fr-2.
  const session = { _activeChatItem: null };
  const aiChatWritten = [];
  const startTurn = (text) => {
    if (session._activeChatItem && session._activeChatItem._buffer
        && session._activeChatItem._buffer.trim()) {
      aiChatWritten.push({ itemId: session._activeChatItem.itemId,
                           text: session._activeChatItem._buffer });
    }
    session._activeChatItem = null;
    const m = text.match(/\[chat:plan#([A-Za-z0-9_-]+)\]/);
    if (m) session._activeChatItem = { itemId: m[1], _buffer: '' };
  };
  startTurn('[chat:plan#fr-1] q1');
  session._activeChatItem._buffer = 'partial-fr1';
  startTurn('[chat:plan#fr-2] q2');
  // fr-1's buffer flushed; fr-2 freshly bound; no cross-contamination.
  assert.deepStrictEqual(aiChatWritten, [{ itemId: 'fr-1', text: 'partial-fr1' }]);
  assert.strictEqual(session._activeChatItem.itemId, 'fr-2');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
