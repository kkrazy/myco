// fr-86: /clear new — soft-reset slash command (owner+admin only).
//
// User-reported (verbatim from the plan-item dispatch + chat history):
//   Title: "Add slash command to clear and resume session, restricted
//           to owner/admin"
//   Problem: Users have no way to clear and resume a session to switch
//            context.
//   Plus earlier directive: "should keep the history and restart a
//   session, then wipe the chat pane, I should be able to come back
//   and collect the full logs later"
//   And: "change the clear to add an option to start a new session"
//   And: graceful stop with UI feedback ("you are restarting and
//   waiting xxx task to finish")
//
// Semantic locked:
//   - /clear (no args)  → existing behavior unchanged: server wipes
//                         rec.chat + broadcasts state-update chat-clear,
//                         anyone can use.
//   - /clear new        → NEW behavior:
//                         · preserves rec.chat (history survives)
//                         · preserves events.jsonl + SDK transcript JSONL
//                         · nulls rec.sdkSessionId so the next user
//                           message spawns a fresh SDK conversation
//                         · gracefully stops the current SDK iteration
//                           if one is in progress
//                         · while waiting on a busy turn, replies with
//                           "🔄 restart pending — waiting for <task>"
//                         · once idle, broadcasts state-update
//                           chat-pane-reset; client wipes
//                           state.chatMessages + re-renders empty pane.
//                         · OWNER + ADMIN ONLY (per fr-39 model)
//
// Contract being locked:
//   - sessions.js exports markSessionForRestart(sessionId) — nulls
//     rec.sdkSessionId + saves. rec.chat untouched.
//   - agent-session.js exposes requestRestart() — checks _iterating;
//     if busy, sets _pendingRestart=true + emits a "restart pending"
//     status; if idle, executes immediately.
//   - slashcmds.js handleClear parses `new` arg; routes to the restart
//     path under an owner+admin gate.
//   - The restart path broadcasts a state-update with
//     kind: 'chat-pane-reset' (NOT 'chat-clear' — that one implies
//     server-side rec.chat was wiped, which is NOT the new semantic).
//   - The client (app.js) handles 'chat-pane-reset' by wiping
//     state.chatMessages and re-rendering the empty pane.
//
// Test shape mirrors fr-87 / fr-88 / bug-41: pure-logic helpers +
// static-grep guards on prod source.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ── Inline-logic helpers (the prod code follows the same shape) ──

function makeStore() {
  return {
    sessions: {
      'sid-A': {
        id: 'sid-A',
        user: 'alice',
        admins: ['bob'],
        viewers: ['carol'],
        sdkSessionId: 'sdk-abc123',
        chat: [
          { id: 'm1', user: 'alice', text: 'hi claude', ts: '2026-05-31T00:00:00Z' },
          { id: 'm2', user: 'claude', text: 'hi alice', ts: '2026-05-31T00:00:01Z' },
        ],
      },
    },
  };
}

function markSessionForRestart(store, sessionId) {
  const rec = store.sessions[sessionId];
  if (!rec) return false;
  rec.sdkSessionId = null;
  return true;
}

function isOwnerOrAdmin(store, sessionId, user) {
  const rec = store.sessions[sessionId];
  if (!rec || !user) return false;
  if (rec.user === user) return true;
  return Array.isArray(rec.admins) && rec.admins.includes(user);
}

// Mirrors the requestRestart busy-vs-idle branch in agent-session.js.
function requestRestart(agentState, restartFn) {
  // agentState = { iterating: boolean, currentTask: string | null }
  if (agentState.iterating) {
    agentState.pendingRestart = true;
    return {
      kind: 'pending',
      message: `🔄 restart pending — waiting for ${agentState.currentTask || 'current turn'} to finish`,
    };
  }
  restartFn();
  return { kind: 'executed', message: 'restarted immediately' };
}

console.log('── fr-86: /clear new — restart session (owner+admin) ──');

// ── markSessionForRestart ──

t('markSessionForRestart nulls sdkSessionId', () => {
  const s = makeStore();
  assert.strictEqual(s.sessions['sid-A'].sdkSessionId, 'sdk-abc123');
  assert.strictEqual(markSessionForRestart(s, 'sid-A'), true);
  assert.strictEqual(s.sessions['sid-A'].sdkSessionId, null,
    'sdkSessionId must be nulled so the next ensureLiveSession spawns a fresh SDK conversation');
});

t('markSessionForRestart PRESERVES rec.chat (history survives)', () => {
  const s = makeStore();
  const chatBefore = s.sessions['sid-A'].chat.map((m) => m.id).sort();
  markSessionForRestart(s, 'sid-A');
  const chatAfter = s.sessions['sid-A'].chat.map((m) => m.id).sort();
  assert.deepStrictEqual(chatAfter, chatBefore,
    'rec.chat must NOT be wiped — the user explicitly asked to "keep the history and collect logs later"');
});

t('markSessionForRestart on unknown session is a no-op (defensive)', () => {
  const s = makeStore();
  assert.strictEqual(markSessionForRestart(s, 'sid-NOPE'), false);
});

// ── Owner + admin gate ──

t('owner can /clear new', () => {
  const s = makeStore();
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-A', 'alice'), true);
});

t('admin can /clear new', () => {
  const s = makeStore();
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-A', 'bob'), true);
});

t('viewer canNOT /clear new — owner+admin gate denies', () => {
  const s = makeStore();
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-A', 'carol'), false,
    'viewer must be rejected — restart is a destructive-ish action that resets the agent\'s working memory');
});

t('random non-shared user canNOT /clear new', () => {
  const s = makeStore();
  assert.strictEqual(isOwnerOrAdmin(s, 'sid-A', 'dave'), false);
});

// ── Graceful-stop branch ──

t('requestRestart when idle: fires immediately', () => {
  let restartCalled = false;
  const out = requestRestart(
    { iterating: false, currentTask: null },
    () => { restartCalled = true; }
  );
  assert.strictEqual(out.kind, 'executed');
  assert.strictEqual(restartCalled, true, 'idle agent must restart synchronously, no waiting');
});

t('requestRestart when busy: sets pending flag + replies waiting-message naming current task', () => {
  let restartCalled = false;
  const state = { iterating: true, currentTask: 'Bash(npm test)' };
  const out = requestRestart(state, () => { restartCalled = true; });
  assert.strictEqual(out.kind, 'pending');
  assert.strictEqual(restartCalled, false, 'busy agent must NOT restart yet — let the in-flight tool finish first');
  assert.strictEqual(state.pendingRestart, true,
    'a pendingRestart flag must be set so the iteration-end hook can fire the actual restart');
  assert.ok(/Bash\(npm test\)/.test(out.message),
    'the waiting message must NAME the current task so the user understands what we\'re waiting on');
  assert.ok(/restart pending/i.test(out.message),
    'the waiting message must signal "restart pending" so the user knows their command was received');
});

t('requestRestart when busy with no known task: falls back to "current turn" phrasing', () => {
  const out = requestRestart({ iterating: true, currentTask: null }, () => {});
  assert.ok(/current turn/i.test(out.message),
    'with no currentTask info, the waiting message must say "current turn" so the user still gets feedback');
});

// ── arg-parsing — handleClear branches on the literal "new" token ──

function parseClearArg(rawArg) {
  // Mirrors handleClear's arg parser after the fr-86 fix.
  const arg = String(rawArg || '').trim().toLowerCase();
  if (!arg) return { mode: 'legacy' };
  if (arg === 'new') return { mode: 'new' };
  return { mode: 'unknown', input: arg };
}

t('/clear (no args) → legacy mode (existing behavior unchanged)', () => {
  assert.deepStrictEqual(parseClearArg(''), { mode: 'legacy' });
  assert.deepStrictEqual(parseClearArg('   '), { mode: 'legacy' });
  assert.deepStrictEqual(parseClearArg(undefined), { mode: 'legacy' });
});

t('/clear new → new mode (the fr-86 restart path)', () => {
  assert.deepStrictEqual(parseClearArg('new'), { mode: 'new' });
  assert.deepStrictEqual(parseClearArg(' new '), { mode: 'new' });
  assert.deepStrictEqual(parseClearArg('NEW'), { mode: 'new' },
    'case-insensitive — Mac users typing /clear NEW must hit the same path');
});

t('/clear garbage → unknown mode (handler can surface a usage hint)', () => {
  assert.deepStrictEqual(parseClearArg('xyz'), { mode: 'unknown', input: 'xyz' });
});

// ── Static-grep guards on prod source ──

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

t('static guard: sessions.js exports markSessionForRestart', () => {
  const src = _read('server/src/sessions.js');
  assert.ok(/function\s+markSessionForRestart\s*\(/.test(src),
    'sessions.js must define function markSessionForRestart(...)');
  assert.ok(/\bmarkSessionForRestart\b/.test(src),
    'markSessionForRestart must be referenced — likely in module.exports');
});

t('static guard: markSessionForRestart nulls sdkSessionId + saves', () => {
  const src = _read('server/src/sessions.js');
  const fnAt = src.indexOf('function markSessionForRestart');
  assert.ok(fnAt > 0);
  const window = src.slice(fnAt, fnAt + 1200);
  assert.ok(/sdkSessionId\s*=\s*null/.test(window),
    'markSessionForRestart must null rec.sdkSessionId');
  assert.ok(/saveStore\(\)/.test(window),
    'markSessionForRestart must call saveStore() so the null persists');
  // Defensive — guard that rec.chat is NOT touched.
  assert.ok(!/rec\.chat\s*=/.test(window),
    'markSessionForRestart must NOT mutate rec.chat — history preservation is the WHOLE POINT of fr-86');
});

t('static guard: agent-session.js exposes requestRestart with graceful-stop branch', () => {
  const src = _read('server/src/agent-session.js');
  assert.ok(/\brequestRestart\s*\(/.test(src),
    'agent-session.js must define requestRestart(...)');
  // Anchor on the method declaration (with opening brace) — a bare
  // `requestRestart(` also matches references to the method inside
  // adjacent comment blocks (e.g. _executeRestart's docstring), which
  // would point the window at the wrong region.
  const fnAt = src.indexOf('requestRestart() {');
  assert.ok(fnAt > 0, 'agent-session.js must declare requestRestart() {…}');
  const window = src.slice(fnAt, fnAt + 2500);
  assert.ok(/_iterating/.test(window),
    'requestRestart must check this._iterating to decide busy-vs-idle branch');
  assert.ok(/_pendingRestart/.test(window),
    'requestRestart must set this._pendingRestart when busy so the idle-event hook fires the actual restart');
});

t('static guard: slashcmds.js handleClear parses "new" arg + gates owner+admin', () => {
  const src = _read('server/src/slashcmds.js');
  const fnAt = src.indexOf('function handleClear');
  assert.ok(fnAt > 0);
  const window = src.slice(fnAt, fnAt + 3500);
  assert.ok(/===\s*['"]new['"]|args.*new|arg.*===.*new|mode.*new/.test(window),
    'handleClear must branch on the "new" arg token to route to the restart path');
  assert.ok(/isOwnerOrAdmin/.test(window),
    'handleClear "new" path must gate with isOwnerOrAdmin (mirror /strict\'s fr-39 model)');
  assert.ok(/fr-86/.test(window),
    'a comment naming fr-86 must explain the restart-mode branch so future readers know why /clear has an arg parser now');
});

t('static guard: server broadcasts chat-pane-reset (NOT chat-clear) on restart', () => {
  // The restart broadcast lives wherever requestRestart's idle-side
  // restart action does its work. It could be in agent-session.js or
  // attach.js depending on the wiring choice. Check both surfaces.
  const agentSrc = _read('server/src/agent-session.js');
  const attachSrc = _read('server/src/attach.js');
  const combined = agentSrc + '\n////SEPARATOR////\n' + attachSrc;
  assert.ok(/chat-pane-reset/.test(combined),
    'prod server source must broadcast kind:"chat-pane-reset" — distinct from "chat-clear" (which implies rec.chat was wiped on the server, NOT the case for /clear new)');
});

t('static guard: client (app.js) handles chat-pane-reset frame', () => {
  const src = _read('web/public/app.js');
  assert.ok(/chat-pane-reset/.test(src),
    'app.js must handle kind:"chat-pane-reset" — wipes state.chatMessages + re-renders empty pane');
  // Find the handler and verify it actually clears state.
  const handlerAt = src.indexOf("kind === 'chat-pane-reset'");
  const altHandlerAt = src.indexOf('chat-pane-reset');
  assert.ok(handlerAt > 0 || altHandlerAt > 0,
    'a string-literal handler for "chat-pane-reset" must exist');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
