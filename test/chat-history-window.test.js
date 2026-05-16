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

t('DEFAULT_CHAT_HISTORY_LIMIT is exported and equals 25', () => {
  // Lowered from 100 to 25 in round 2 (user feedback: chat pane still
  // slow on reload with 100 markdown rows). The load-older button +
  // paginated /chat/history?before= route fetch earlier windows on
  // demand, so a smaller initial window is no info loss — just faster
  // first paint. Bumping back to 100 (or anything > 50) would re-
  // introduce the sluggish-reload symptom this constant is pinned for.
  assert.strictEqual(sessionsMod.DEFAULT_CHAT_HISTORY_LIMIT, 25,
    'the WS chat-history frame default must be 25 to keep first paint fast');
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

t('attach.js wire calls chat-history with the windowed limit', () => {
  // Source-level guard against a future cleanup pass dropping the
  // limit and silently restoring the "ship all 500" behavior.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  assert.ok(src.includes('DEFAULT_CHAT_HISTORY_LIMIT'),
    'attach.js must reference DEFAULT_CHAT_HISTORY_LIMIT when sending the chat-history WS frame');
  assert.ok(/messages:\s*history,\s*total/.test(src),
    'chat-history WS frame must carry `total` so the client knows whether more exists');
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
