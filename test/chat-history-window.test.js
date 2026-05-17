// bug-9 regression: getChatHistory accepts { limit, before } for
// windowed reads, and getChatHistoryLength returns the total filtered
// count. The initial chat-history WS frame on attach is capped at
// DEFAULT_CHAT_HISTORY_LIMIT (25 — lowered from 100 in round 2 after
// user feedback that 100 markdown rows was still slow on first paint)
// so the chat pane opens fast on multi-hour sessions; older windows
// are fetched on demand via the new GET /sessions/:id/chat/history
// ?before=&limit= route.
//
// This file pins the server contract — the route + WS-frame call
// sites depend on it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-chw-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

const sessionsMod = require('../server/src/sessions');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function seedSession(sid, n) {
  const store = sessionsMod.loadStore();
  store.sessions = store.sessions || {};
  store.sessions[sid] = {
    id: sid, user: 'kkrazy', cwd: '.',
    absCwd: process.env.MYCO_WORKSPACE,
    createdAt: new Date().toISOString(),
    chat: [],
  };
  sessionsMod.saveStore();
  // Generate `n` messages with monotonically increasing ts strings so
  // `before` filtering is deterministic. Format: 2026-05-16T10:HH:MM:SS.
  for (let i = 0; i < n; i++) {
    const mm = String(Math.floor(i / 60)).padStart(2, '0');
    const ss = String(i % 60).padStart(2, '0');
    sessionsMod.appendChatMessage(sid, {
      user: 'alice', text: 'msg ' + i,
      ts: `2026-05-16T10:${mm}:${ss}.000Z`,
    });
  }
}

console.log('── bug-9: windowed getChatHistory + getChatHistoryLength ──');

t('INITIAL_CHAT_HISTORY_BYTES is exported and equals 8 KB', () => {
  // Round 5 was 1 KB; 2026-05-17 bumped to 8 KB (user-requested)
  // so the first paint shows ~30-50 messages of context instead of
  // 5-8. The user explicitly wants the latest conversation visible
  // at the bottom on init, so a bigger initial window pays for itself.
  assert.strictEqual(sessionsMod.INITIAL_CHAT_HISTORY_BYTES, 8 * 1024,
    'initial WS chat-history frame must cap at 8 KB so first paint shows recent context');
});

t('DEFAULT_CHAT_HISTORY_BYTES is exported and equals 16 KB', () => {
  // Round 5: total rolling cap on client-side state.chatMessages. The
  // /chat/history?before= route also caps per-fetch at this budget.
  assert.strictEqual(sessionsMod.DEFAULT_CHAT_HISTORY_BYTES, 16 * 1024,
    'chat-history rolling cap must be 16 KB');
});

t('DEFAULT_CHAT_HISTORY_LIMIT (legacy count-cap) is still exported for the /chat/history?limit= route', () => {
  // The count cap survived as a small default for paginated older-
  // window fetches via GET /sessions/:id/chat/history?limit= when
  // the client doesn't pass an explicit count. Independent of the
  // byte budget that gates the initial attach frame.
  assert.strictEqual(typeof sessionsMod.DEFAULT_CHAT_HISTORY_LIMIT, 'number');
  assert.ok(sessionsMod.DEFAULT_CHAT_HISTORY_LIMIT > 0
            && sessionsMod.DEFAULT_CHAT_HISTORY_LIMIT <= 100,
    'legacy count default should sit in a sensible range');
});

t('opts.maxBytes returns the tail prefix that fits the budget', () => {
  const sid = 'sess-chw-bytes';
  seedSession(sid, 50);
  // Each message is small (~80 bytes when stringified). A 500-byte
  // budget should fit ~6 messages.
  const tight = sessionsMod.getChatHistory(sid, { maxBytes: 500 });
  assert.ok(tight.length > 0 && tight.length < 50,
    'maxBytes should trim a fraction of the messages, got ' + tight.length);
  assert.strictEqual(tight[tight.length - 1].text, 'msg 49',
    'last element must be the most recent (msg 49)');
  // Budget large enough to fit everything — full list returned.
  const loose = sessionsMod.getChatHistory(sid, { maxBytes: 1024 * 1024 });
  assert.strictEqual(loose.length, 50, 'big budget returns everything');
});

t('opts.maxBytes always keeps at least one message even if it exceeds the budget', () => {
  const sid = 'sess-chw-bytes-min';
  seedSession(sid, 5);
  // Set the budget below the size of a single stringified message.
  const result = sessionsMod.getChatHistory(sid, { maxBytes: 1 });
  assert.strictEqual(result.length, 1,
    'a single oversized message should still be returned (most recent), not an empty window');
  assert.strictEqual(result[0].text, 'msg 4');
});

t('opts.maxBytes + opts.limit — whichever produces fewer messages wins', () => {
  const sid = 'sess-chw-bytes-limit';
  seedSession(sid, 50);
  // Tight count cap with a generous byte budget → count wins.
  const byCount = sessionsMod.getChatHistory(sid, { maxBytes: 999999, limit: 3 });
  assert.strictEqual(byCount.length, 3);
  assert.strictEqual(byCount[2].text, 'msg 49');
  // Generous count cap with a tight byte budget → bytes win.
  const byBytes = sessionsMod.getChatHistory(sid, { maxBytes: 250, limit: 9999 });
  assert.ok(byBytes.length > 0 && byBytes.length < 50,
    'byte budget should trim despite generous count limit');
});

t('no opts → returns ALL filtered messages (backward compat)', () => {
  const sid = 'sess-chw-all';
  seedSession(sid, 250);
  const all = sessionsMod.getChatHistory(sid);
  assert.strictEqual(all.length, 250, 'expected all 250, got ' + all.length);
  assert.strictEqual(all[0].text, 'msg 0');
  assert.strictEqual(all[249].text, 'msg 249');
});

t('opts.limit returns the LAST N messages, chronologically ordered', () => {
  const sid = 'sess-chw-limit';
  seedSession(sid, 250);
  const tail = sessionsMod.getChatHistory(sid, { limit: 100 });
  assert.strictEqual(tail.length, 100);
  assert.strictEqual(tail[0].text, 'msg 150', 'first of last-100 should be msg 150');
  assert.strictEqual(tail[99].text, 'msg 249', 'last of last-100 should be msg 249');
});

t('opts.before excludes messages with ts >= the cursor', () => {
  const sid = 'sess-chw-before';
  seedSession(sid, 250);
  // Cursor = msg 100's ts. Window should exclude msg 100 itself.
  const cursor = '2026-05-16T10:01:40.000Z';  // msg 100
  const before = sessionsMod.getChatHistory(sid, { before: cursor });
  assert.strictEqual(before.length, 100, 'expected 100 (msgs 0-99), got ' + before.length);
  assert.strictEqual(before[0].text, 'msg 0');
  assert.strictEqual(before[99].text, 'msg 99');
});

t('opts.before + opts.limit pages backwards N at a time', () => {
  const sid = 'sess-chw-paginate';
  seedSession(sid, 250);
  // Fetch a 50-message window strictly older than msg 200.
  const cursor = '2026-05-16T10:03:20.000Z';  // msg 200
  const win = sessionsMod.getChatHistory(sid, { before: cursor, limit: 50 });
  assert.strictEqual(win.length, 50);
  assert.strictEqual(win[0].text, 'msg 150', 'oldest of the 50-before-200 window should be msg 150');
  assert.strictEqual(win[49].text, 'msg 199', 'newest of the 50-before-200 window should be msg 199');
});

t('getChatHistoryLength returns total filtered count regardless of limit/before', () => {
  const sid = 'sess-chw-len';
  seedSession(sid, 75);
  assert.strictEqual(sessionsMod.getChatHistoryLength(sid), 75);
});

t('fromTranscript rows are excluded from BOTH length and window reads', () => {
  const sid = 'sess-chw-fromtxn';
  seedSession(sid, 10);
  // Inject 5 fromTranscript rows in between. They should be silently
  // filtered out — only the 10 user messages should be visible to
  // either accessor.
  for (let i = 0; i < 5; i++) {
    sessionsMod.appendChatMessage(sid, {
      user: 'claude', text: 'transcript ' + i, ts: '2026-05-16T11:00:0' + i + '.000Z',
      meta: { fromTranscript: true, transcriptUuid: 'u' + i },
    });
  }
  assert.strictEqual(sessionsMod.getChatHistoryLength(sid), 10,
    'fromTranscript rows must NOT count toward the filtered total');
  const all = sessionsMod.getChatHistory(sid);
  assert.strictEqual(all.length, 10);
  assert.ok(all.every((m) => !(m.meta && m.meta.fromTranscript)),
    'window must drop fromTranscript rows');
});

t('limit=0 falls through (treated as no-limit, no-op)', () => {
  const sid = 'sess-chw-zero';
  seedSession(sid, 5);
  // 0 is the only "limit set but invalid" sentinel — the route also
  // clamps to DEFAULT_CHAT_HISTORY_LIMIT. The lib-level helper just
  // returns full filtered list when limit is falsy/non-positive.
  const all = sessionsMod.getChatHistory(sid, { limit: 0 });
  assert.strictEqual(all.length, 5);
});

t('attach.js wire calls chat-history with the small INITIAL_CHAT_HISTORY_BYTES budget (round 5)', () => {
  // Source-level guards. Round 5 dropped the backfill setTimeout —
  // initial frame is the only auto-sent one; scroll-up loads more.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  assert.ok(src.includes('INITIAL_CHAT_HISTORY_BYTES'),
    'attach.js must reference INITIAL_CHAT_HISTORY_BYTES for the tiny initial frame');
  assert.ok(/_shipChatHistory/.test(src),
    'attach.js must factor the chat-history send into _shipChatHistory');
  assert.ok(/messages:\s*history,\s*total/.test(src),
    'chat-history WS frame must carry `total` so the client knows whether more exists');
  // Round-5 contract: no auto-backfill — scroll-up loads more.
  // Allow setTimeout to exist elsewhere in attach.js (the
  // SESSION_KEEPALIVE_GRACE_MS kill timer uses one), but not paired
  // with DEFAULT_*_BYTES.
  assert.ok(!/setTimeout\([^)]*\)\s*=>\s*\{[\s\S]*?DEFAULT_CHAT_HISTORY_BYTES/.test(src),
    'attach.js must NOT have a setTimeout that ships the DEFAULT chat-history budget — round-5 dropped the auto-backfill');
});

t('attach.js + app.js keep timeline-init helpers as DORMANT after the round-6.1 revert', () => {
  // Round 6 (pre-merged timeline-init) lost claude-output rendering
  // on reload because _applyTimelineInit silently bypassed the
  // state._agentChatPaneArmed setup the agent-replay handler does.
  // Round 6.1 reverted to the round-5 two-frame shape; the helpers
  // stay defined for a future, more careful attempt — but the live
  // attach path no longer invokes _shipTimelineInit.
  const sa = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  assert.ok(/function _shipTimelineInit/.test(sa),
    'attach.js must keep _shipTimelineInit dormant for a future retry');
  assert.ok(/_shipAgentReplay\(session, ws, sessionId/.test(sa),
    'attach.js must invoke _shipAgentReplay on attach (round-5 shape)');
  assert.ok(/_shipChatHistory\(ws, sessionId/.test(sa),
    'attach.js must invoke _shipChatHistory on attach (round-5 shape)');
  const ca = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(/function _applyTimelineInit/.test(ca),
    'app.js must keep _applyTimelineInit dormant for a future retry');
});

t('MAX_CHAT_MESSAGES persisted cap is effectively unbounded so scroll-up reaches the full history', () => {
  // The 1k/16k caps are CLIENT-SIDE in-memory bounds. The persisted
  // rec.chat in sessions.json should keep the entire conversation
  // so a user scrolling back via the load-older button can reach
  // any historical message, not just the recent ones.
  //
  // Use a source-grep + a functional appendChatMessage stress to
  // catch a regression that drops MAX_CHAT_MESSAGES back down.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'sessions.js'), 'utf8');
  const m = src.match(/const MAX_CHAT_MESSAGES\s*=\s*(\d+)/);
  assert.ok(m, 'sessions.js must define MAX_CHAT_MESSAGES');
  const cap = parseInt(m[1], 10);
  assert.ok(cap >= 10000,
    'MAX_CHAT_MESSAGES must be >= 10000 to keep multi-week conversation history available for scroll-up — was ' + cap + '. The user-facing client cap is 16 KB in-memory; the persisted store must outlive that by orders of magnitude.');
});

t('paginating through 2000 historical messages via opts.before walks the FULL chat', () => {
  // Functional proof that the persisted history serves big windows:
  // populate 2000 messages, then page through 200-at-a-time using
  // the same { limit, before } shape the load-older button uses.
  // Assert we reach msg-0 (the very oldest).
  const sid = 'sess-chw-big';
  seedSession(sid, 2000);
  const total = sessionsMod.getChatHistoryLength(sid);
  assert.strictEqual(total, 2000);
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  for (let i = 0; i < 50; i++) {  // cap the loop so a bug can't infinite-loop the test
    const opts = { limit: 200 };
    if (cursor) opts.before = cursor;
    const window = sessionsMod.getChatHistory(sid, opts);
    if (!window.length) break;
    pages++;
    for (const m of window) seen.add(m.text);
    cursor = window[0].ts;   // oldest of the window — next page is before this
  }
  assert.ok(pages >= 9 && pages <= 12, 'should take ~10 pages to walk 2000 messages 200 at a time, took ' + pages);
  assert.strictEqual(seen.size, 2000, 'must have walked every message — got ' + seen.size + ' of 2000');
  assert.ok(seen.has('msg 0') && seen.has('msg 1999'),
    'must reach BOTH the oldest (msg 0) and the newest (msg 1999) via pagination');
});

t('app.js has the client-side MAX_CHAT_BYTES rolling cap (1 MB after 2026-05-17 bump)', () => {
  // The server ships the initial frame capped at INITIAL_CHAT_HISTORY_BYTES
  // (8 KB), but live `chat` frames + scroll-up load-older grow the
  // client's state.chatMessages indefinitely otherwise. _capChatMessagesBytes
  // applies a rolling tail-cap so the array never exceeds MAX_CHAT_BYTES.
  // 2026-05-17 bumped from 16 KB to 1 MB (user-requested) — mobile RAM
  // handles 1 MB fine and the cap rarely fires in normal use.
  // 2026-05-17 also added state._scrolledBack to disable the cap once
  // the user has explicitly fetched older history (prevents the cap
  // from dropping the rows they just loaded).
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(/const MAX_CHAT_BYTES\s*=\s*1024\s*\*\s*1024/.test(src),
    'app.js must define MAX_CHAT_BYTES = 1024 * 1024 (1 MB)');
  assert.ok(/function _capChatMessagesBytes/.test(src),
    'app.js must define _capChatMessagesBytes helper');
  assert.ok(/if \(state\._scrolledBack\) return/.test(src),
    'app.js _capChatMessagesBytes must short-circuit when state._scrolledBack is set — otherwise scroll-up load-older infinite-loops because the cap evicts fetched rows.');
});

t('index.js has the GET /sessions/:id/chat/history route', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');
  assert.ok(/app\.get\(\s*['"]\/sessions\/:id\/chat\/history['"]/.test(src),
    'index.js must register GET /sessions/:id/chat/history');
  assert.ok(/hasMore/.test(src),
    'route response must include hasMore so the client knows when to retire the load-older button');
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
