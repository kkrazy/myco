// fr-76 Phase 1: per-item AI chat — server-side data model +
// persistence + routes.
//
// This commit lands the FOUNDATION. No agent wiring yet (Phase 2),
// no UI yet (Phase 3), no related-item context yet (Phase 4).
//
// Schema per turn (stored on plan items as item.aiChat[]):
//   { id, user, role: 'user'|'agent', text, ts, meta? }
//
// Routes:
//   GET  /sessions/:id/artifact/plan/:itemId/aichat ? afterTs= & limit=
//   POST /sessions/:id/artifact/plan/:itemId/aichat   body: { text }
//
// Caps:
//   AI_CHAT_TEXT_MAX     = 10000  (10× comments — chat turns can be longer)
//   AI_CHAT_PER_ITEM_MAX =   100  (tail-trim on overflow)

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ARTIFACTS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');

console.log('── fr-76 Phase 1: per-item AI chat persistence + routes ──');

// ──────────────────────────────────────────────────────────────────────
// Constants + helpers
// ──────────────────────────────────────────────────────────────────────

t('AI_CHAT_TEXT_MAX = 10000 (declared)', () => {
  assert.ok(/const\s+AI_CHAT_TEXT_MAX\s*=\s*10000/.test(ARTIFACTS_SRC),
    'artifacts.js must declare AI_CHAT_TEXT_MAX = 10000 — chat turns can be longer than 1k-char comments');
});

t('AI_CHAT_PER_ITEM_MAX = 100 (declared)', () => {
  assert.ok(/const\s+AI_CHAT_PER_ITEM_MAX\s*=\s*100/.test(ARTIFACTS_SRC),
    'artifacts.js must declare AI_CHAT_PER_ITEM_MAX = 100 — bound conversation length');
});

t('ensureAiChatField helper exists', () => {
  assert.ok(/function\s+ensureAiChatField\s*\(/.test(ARTIFACTS_SRC),
    'artifacts.js must define ensureAiChatField(item) — lazy-init item.aiChat = []');
});

t('appendAiChatTurn helper exists with tail-trim logic', () => {
  assert.ok(/function\s+appendAiChatTurn\s*\(/.test(ARTIFACTS_SRC));
  // Tail-trim on overflow: slice(-AI_CHAT_PER_ITEM_MAX) pattern, same
  // as comments' slice(-COMMENTS_PER_ITEM_MAX).
  const start = ARTIFACTS_SRC.search(/function\s+appendAiChatTurn\s*\(/);
  const body = ARTIFACTS_SRC.slice(start, start + 1500);
  assert.ok(/slice\s*\(\s*-\s*AI_CHAT_PER_ITEM_MAX\s*\)/.test(body),
    'appendAiChatTurn must tail-trim via slice(-AI_CHAT_PER_ITEM_MAX) on overflow');
});

t('getAiChatHistory helper exists with afterTs + limit support', () => {
  const start = ARTIFACTS_SRC.search(/function\s+getAiChatHistory\s*\(/);
  assert.ok(start > -1, 'getAiChatHistory must be defined');
  const body = ARTIFACTS_SRC.slice(start, start + 800);
  assert.ok(/afterTs/.test(body),
    'getAiChatHistory must accept opts.afterTs for live-tail pagination');
  assert.ok(/limit/.test(body),
    'getAiChatHistory must accept opts.limit for window-cap');
});

// ──────────────────────────────────────────────────────────────────────
// Routes registered
// ──────────────────────────────────────────────────────────────────────

t('GET /artifact/plan/:itemId/aichat route registered', () => {
  assert.ok(/app\.get\s*\(\s*['"]\/sessions\/:id\/artifact\/plan\/:itemId\/aichat['"]/.test(ARTIFACTS_SRC),
    'GET /sessions/:id/artifact/plan/:itemId/aichat must be registered');
});

t('POST /artifact/plan/:itemId/aichat route registered', () => {
  assert.ok(/app\.post\s*\(\s*['"]\/sessions\/:id\/artifact\/plan\/:itemId\/aichat['"]/.test(ARTIFACTS_SRC),
    'POST /sessions/:id/artifact/plan/:itemId/aichat must be registered');
});

t('POST route validates text length against AI_CHAT_TEXT_MAX', () => {
  const idx = ARTIFACTS_SRC.search(/app\.post\s*\(\s*['"]\/sessions\/:id\/artifact\/plan\/:itemId\/aichat/);
  const window = ARTIFACTS_SRC.slice(idx, idx + 2000);
  assert.ok(/AI_CHAT_TEXT_MAX/.test(window),
    'POST route body must check text.length against AI_CHAT_TEXT_MAX (10000)');
});

t('POST route role is fixed to "user" (agent turns come from Phase 2 attach.js)', () => {
  const idx = ARTIFACTS_SRC.search(/app\.post\s*\(\s*['"]\/sessions\/:id\/artifact\/plan\/:itemId\/aichat/);
  const window = ARTIFACTS_SRC.slice(idx, idx + 2000);
  assert.ok(/role:\s*['"]user['"]/.test(window),
    'POST route must hardcode role: "user" — agent role comes from the attach.js agent-event listener (Phase 2)');
});

// ──────────────────────────────────────────────────────────────────────
// Module exports (so attach.js Phase 2 can use the helpers)
// ──────────────────────────────────────────────────────────────────────

t('artifacts.js exports the AI chat helpers + constants', () => {
  // Resolve the module + check the exports surface.
  const artifacts = require('../server/src/artifacts.js');
  assert.strictEqual(typeof artifacts.appendAiChatTurn, 'function',
    'appendAiChatTurn must be exported for Phase 2 attach.js');
  assert.strictEqual(typeof artifacts.getAiChatHistory, 'function',
    'getAiChatHistory must be exported');
  assert.strictEqual(typeof artifacts.ensureAiChatField, 'function',
    'ensureAiChatField must be exported');
  assert.strictEqual(artifacts.AI_CHAT_TEXT_MAX, 10000);
  assert.strictEqual(artifacts.AI_CHAT_PER_ITEM_MAX, 100);
});

// ──────────────────────────────────────────────────────────────────────
// Behavior — exercise appendAiChatTurn + getAiChatHistory directly
// against a fake item, no HTTP / SDK round-trip needed
// ──────────────────────────────────────────────────────────────────────

const artifacts = require('../server/src/artifacts.js');

t('behavior: ensureAiChatField lazy-inits aiChat = []', () => {
  const item = { id: 'bug-1' };
  artifacts.ensureAiChatField(item);
  assert.deepStrictEqual(item.aiChat, []);
  // Idempotent — second call doesn't wipe existing turns.
  item.aiChat.push({ id: 'x', role: 'user', text: 'hi', ts: 't1' });
  artifacts.ensureAiChatField(item);
  assert.strictEqual(item.aiChat.length, 1);
});

t('behavior: appendAiChatTurn stamps id + defaults role to user', () => {
  const item = { id: 'bug-1' };
  const turn = artifacts.appendAiChatTurn(item, {
    user: 'kkrazy',
    text: 'why is the queue stuck?',
  });
  assert.ok(turn.id && /^[0-9a-f]{12}$/.test(turn.id),
    'appended turn must have a 12-hex id');
  assert.strictEqual(turn.role, 'user',
    'role defaults to user when omitted');
  assert.strictEqual(turn.text, 'why is the queue stuck?');
  assert.strictEqual(turn.user, 'kkrazy');
  assert.ok(turn.ts, 'ts is auto-stamped');
  assert.strictEqual(item.aiChat.length, 1);
});

t('behavior: appendAiChatTurn role coerces — only "agent" or "user"', () => {
  const item = { id: 'bug-1' };
  const a = artifacts.appendAiChatTurn(item, { user: 'k', role: 'agent', text: 'hello' });
  assert.strictEqual(a.role, 'agent');
  const b = artifacts.appendAiChatTurn(item, { user: 'k', role: 'admin', text: 'x' });
  assert.strictEqual(b.role, 'user', 'unknown role coerces to user (safe default)');
});

t('behavior: appendAiChatTurn tail-trims at AI_CHAT_PER_ITEM_MAX', () => {
  const item = { id: 'bug-1' };
  for (let i = 0; i < 105; i++) {
    artifacts.appendAiChatTurn(item, { user: 'k', text: 'turn ' + i });
  }
  assert.strictEqual(item.aiChat.length, 100,
    'overflow tail-trims to AI_CHAT_PER_ITEM_MAX = 100');
  assert.strictEqual(item.aiChat[0].text, 'turn 5',
    'oldest turns dropped first (slice(-100) on a 105-len array)');
  assert.strictEqual(item.aiChat[99].text, 'turn 104',
    'newest turn preserved at the tail');
});

t('behavior: getAiChatHistory returns full history by default', () => {
  const item = { id: 'bug-1' };
  artifacts.appendAiChatTurn(item, { user: 'k', text: 'a' });
  artifacts.appendAiChatTurn(item, { user: 'k', text: 'b' });
  artifacts.appendAiChatTurn(item, { user: 'k', role: 'agent', text: 'c' });
  const all = artifacts.getAiChatHistory(item);
  assert.strictEqual(all.length, 3);
  assert.deepStrictEqual(all.map((t) => t.text), ['a', 'b', 'c']);
});

t('behavior: getAiChatHistory respects afterTs for live tail', () => {
  const item = { id: 'bug-1' };
  artifacts.appendAiChatTurn(item, { user: 'k', text: 'a', ts: '2026-01-01T00:00:00Z' });
  artifacts.appendAiChatTurn(item, { user: 'k', text: 'b', ts: '2026-01-02T00:00:00Z' });
  artifacts.appendAiChatTurn(item, { user: 'k', text: 'c', ts: '2026-01-03T00:00:00Z' });
  const tail = artifacts.getAiChatHistory(item, { afterTs: '2026-01-01T12:00:00Z' });
  assert.strictEqual(tail.length, 2);
  assert.deepStrictEqual(tail.map((t) => t.text), ['b', 'c']);
});

t('behavior: getAiChatHistory respects limit for window-cap', () => {
  const item = { id: 'bug-1' };
  for (let i = 0; i < 10; i++) artifacts.appendAiChatTurn(item, { user: 'k', text: 't' + i });
  const last3 = artifacts.getAiChatHistory(item, { limit: 3 });
  assert.strictEqual(last3.length, 3);
  assert.deepStrictEqual(last3.map((t) => t.text), ['t7', 't8', 't9']);
});

t('behavior: meta passed through if provided', () => {
  const item = { id: 'bug-1' };
  const turn = artifacts.appendAiChatTurn(item, {
    user: 'k',
    role: 'agent',
    text: 'done',
    meta: { runId: 'r-42', tokens: 1234, costUsd: 0.01 },
  });
  assert.deepStrictEqual(turn.meta, { runId: 'r-42', tokens: 1234, costUsd: 0.01 });
});

t('behavior: aiChat is a SEPARATE array from comments (no conflation)', () => {
  // fr-76 design: per-item chat is separate from human-to-human
  // comments. Pin this so a future refactor can't accidentally
  // unify them.
  const item = { id: 'bug-1', comments: [{ id: 'c1', user: 'k', text: 'comment', ts: 't' }] };
  artifacts.appendAiChatTurn(item, { user: 'k', text: 'chat turn' });
  assert.strictEqual(item.aiChat.length, 1);
  assert.strictEqual(item.comments.length, 1,
    'comments untouched when appending to aiChat');
  assert.notStrictEqual(item.aiChat, item.comments,
    'aiChat and comments must be different arrays');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
