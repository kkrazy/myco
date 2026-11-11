// Regression test for the user report: "对话框早期信息会丢失，部分信息也会丢失"
// (early chat messages get lost; some messages get lost) before the
// session is closed.
//
// Root cause (diagnosed 2026-11-04): the SERVER persists everything
// (rec.chat capped at 100k, synchronous saveStore per append), but the
// CLIENT silently destroyed its own history:
//   1. _capChatMessagesBytes (MAX_CHAT_BYTES=1MB) DROPPED the oldest
//      rows from state.chatMessages with no recovery path — the
//      load-older cursor keyed off state.chatMessages[0].ts, so once
//      the cap fired the user could never scroll back past the window.
//   2. _enforceChatHistoryCap's CHAT_HARD_CAP=1000 physically removed
//      the oldest DOM cards with no record — the events backfill
//      cursor (oldest rendered data-seq) moved past them, so they were
//      unfetchable.
//
// Fix contract (lossless until session close):
//   1. _capChatMessagesBytes must STASH evicted rows in
//      state.chatEvicted (never drop).
//   2. _revealOlderChat must restore from state.chatEvicted BEFORE
//      hitting the server.
//   3. The CHAT_HARD_CAP rip must record state._domRippedBelowSeq and
//      keep _eventsHasMore alive so _fetchOlderAgentEvents re-fetches
//      the ripped cards.
//   4. clearChat (session switch) must wipe both buffers.
//
// This is a static/DOM-shape test suite (app.js is a browser script
// with no module export) — the same pattern used by
// chat-persistence-contract.test.js.

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const APP = path.join(__dirname, '..', 'web', 'public', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

function sliceFnBody(source, marker) {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `marker not found: ${marker}`);
  const out = [];
  const lines = source.slice(at).split('\n');
  let seenFirst = false;
  for (const ln of lines) {
    out.push(ln);
    if (ln === '}') { seenFirst = true; break; }
  }
  assert.ok(seenFirst, `function body end not found for marker: ${marker}`);
  return out.join('\n');
}

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
  }
}

console.log('lossless-chat-cap.test.js — early/partial message loss regression');

// ── 1. the byte cap must be lossless ───
t('byte cap stashes evicted rows into state.chatEvicted instead of dropping', () => {
  const body = sliceFnBody(src, 'function _capChatMessagesBytes');
  assert.ok(/state\.chatEvicted\s*=/.test(body),
    '_capChatMessagesBytes must write to state.chatEvicted — the old code dropped evicted rows, which is the early-message-loss bug.');
  assert.ok(body.includes('evicted.concat(state.chatEvicted)'),
    'evicted rows must be PREPENDED to the stash (evicted rows are older than what is already stashed).');
  assert.ok(!/console\.log\('\[chat-cap\] dropped/.test(body),
    'the "dropped" log line must be gone — rows are no longer dropped.');
});

t('byte cap keeps the scrolled-back skip + the always-keep-one floor', () => {
  const body = sliceFnBody(src, 'function _capChatMessagesBytes');
  assert.ok(/state\._scrolledBack/.test(body),
    'the _scrolledBack skip must remain — load-older must not stash rows the user is actively viewing.');
  assert.ok(/keepFromIdx = i;/.test(body),
    'the always-keep-at-least-one floor must remain.');
});

// ── 2. the reveal path must restore from the stash first ───
t('_revealOlderChat restores from state.chatEvicted before hitting the server', () => {
  const at = src.indexOf('function _revealOlderChat');
  assert.ok(at >= 0, '_revealOlderChat missing');
  // Span from the function start to the server-fetch block — use a
  // generous window but assert on relative order instead of offsets.
  const segment = src.slice(at, src.indexOf('_fetchOlderChatFromServer').catch ? at : at + 4000);
  const evictIdx = segment.indexOf('state.chatEvicted');
  const fetchIdx = segment.indexOf('_fetchOlderChatFromServer()');
  assert.ok(evictIdx >= 0,
    '_revealOlderChat must check state.chatEvicted — otherwise stashed rows are never restorable.');
  assert.ok(fetchIdx > evictIdx,
    'the evicted-stash restore must run BEFORE the server fetch — restored rows are strictly older and must not be skipped.');
});

// ── 3. the DOM hard cap must be recoverable ───
t('CHAT_HARD_CAP rip records _domRippedBelowSeq and keeps _eventsHasMore alive', () => {
  const body = sliceFnBody(src, 'const CHAT_HARD_CAP = ');
  // sliceFnBody stops at the first column-0 "}" — for the const block
  // we need the enclosing _enforceChatHistoryCap function instead.
  const fnBody = sliceFnBody(src, 'function _enforceChatHistoryCap');
  assert.ok(fnBody.includes('_domRippedBelowSeq'),
    'the hard-cap rip must record state._domRippedBelowSeq — the ripped cards were unrecoverable, which is the partial-message-loss bug.');
  assert.ok(/state\._eventsHasMore = true/.test(fnBody),
    'the rip must keep state._eventsHasMore = true so the load-older path stays armed.');
});

t('_fetchOlderAgentEvents honors the _domRippedBelowSeq floor', () => {
  const body = sliceFnBody(src, 'async function _fetchOlderAgentEvents');
  assert.ok(body.includes('_domRippedBelowSeq'),
    '_fetchOlderAgentEvents must consume the _domRippedBelowSeq floor so ripped cards are re-fetched.');
});

// ── 4. session switch must not leak the stash ───
t('clearChat wipes state.chatEvicted and _domRippedBelowSeq', () => {
  const body = sliceFnBody(src, 'function clearChat');
  assert.ok(/state\.chatEvicted = \[\]/.test(body),
    'clearChat must reset state.chatEvicted — per-session buffer, must not leak across session switches.');
  assert.ok(/state\._domRippedBelowSeq = null/.test(body),
    'clearChat must reset state._domRippedBelowSeq.');
});

// ── 5. the load-older counter must account for stashed rows ───
t('_enforceChatHistoryCap counts evicted rows toward the load-older button', () => {
  const body = sliceFnBody(src, 'function _enforceChatHistoryCap');
  assert.ok(/evictedCount/.test(body),
    'the button counter must include evictedCount so the load-older button stays alive while stashed rows remain.');
});

t('_fetchOlderChatFromServer retire path accounts for evicted rows', () => {
  const body = sliceFnBody(src, 'async function _fetchOlderChatFromServer');
  assert.ok(/knownRows/.test(body),
    'the force-retire path must compare against chatMessages + chatEvicted (knownRows) — otherwise the button retires while stashed rows are still unshown.');
});

// ── 6. server side remains the durable backstop ───
t('server MAX_CHAT_MESSAGES stays effectively-unbounded (>= 100000)', () => {
  const sess = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'sessions.js'), 'utf8');
  const m = sess.match(/MAX_CHAT_MESSAGES = (\d+)/);
  assert.ok(m, 'MAX_CHAT_MESSAGES constant missing');
  assert.ok(parseInt(m[1], 10) >= 100000,
    `MAX_CHAT_MESSAGES must stay >= 100000 (found ${m[1]}) — shrinking it would reintroduce server-side early-message loss.`);
});

console.log(`\n${passed} passed`);
