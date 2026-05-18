// bug-14 regression: the Stop button must invoke the SDK interrupt via
// a dedicated WS frame, NOT by sending the literal text "esc" through
// the chat-message path.
//
// Pre-fix behavior: clicking Stop called sendChatMessage('esc') →
// client sent {t:'chat', text:'esc'} → server's handleChatMessage:
//   1. appendChatMessage(sid, { user, text:'esc' }) — persists "esc"
//      as a user-typed chat row in rec.chat (forever, in chat history)
//   2. session.emit('chat', message) — broadcasts to all attached
//      clients so other viewers see "user typed esc"
//   3. falls through to handleChatPostfixes' special-key handler →
//      session.interrupt()
//
// Even when interrupt fires, the chat record now contains a phantom
// "esc" user message. If interrupt has no visible effect (no in-flight
// turn to abort, or the SDK doesn't honor the abort promptly), the
// user only sees "esc" in chat and concludes the Stop button is broken.
//
// Fix shape:
//   - Client _sendStopAgent sends {t:'interrupt'} instead of {t:'chat',text:'esc'}
//   - Server (owner attach + viewer attach) handles {t:'interrupt'}:
//     - call session.interrupt() (no-op safe if no abort controller live)
//     - emit a brief assistant chat note explaining what happened
//     - NO appendChatMessage of "esc" as user-typed text
//     - log [ws-frame] t=interrupt user=<login>
//   - The legacy typed-"esc" → interrupt path in handleChatPostfixes
//     stays for users who type "esc" by hand; only the button moves
//     to the cleaner frame.
//
// This test inlines minimal mocks for the WS + AgentSession and
// static-grep-guards the prod source.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ──────────────────────────────────────────────────────────────────────────
// Inlined FIXED behavior — what the server frame-handler should do.

function makeSession() {
  const s = new EventEmitter();
  s.interrupted = 0;
  s.interrupt = function () { s.interrupted++; };
  return s;
}

function makeWs() {
  const sent = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(s) { sent.push(JSON.parse(s)); },
  };
}

// Mock of the server's chat-persistence + chat-broadcast side effects
// so we can assert that the interrupt path does NOT trigger them.
let persistedChats = [];
function mockAppendChatMessage(sid, msg) { persistedChats.push({ sid, ...msg }); }

// Simulates the FIXED inbound frame handler for `{t:'interrupt'}`.
// Mirrors what the new attach.js branch will do.
function handleInterruptFrame(sessionId, session, user) {
  if (typeof session.interrupt === 'function') session.interrupt();
  const note = {
    user: 'claude',
    text: '(interrupt sent — the in-flight Claude turn was aborted. Type your next message to continue from where the conversation left off.)',
    ts: new Date().toISOString(),
    meta: { kind: 'interrupt-ack' },
  };
  session.emit('chat', note);
  return note;
}

// ──────────────────────────────────────────────────────────────────────────

console.log('── bug-14: Stop button → dedicated interrupt frame ──');

t('FIXED behavior: interrupt frame calls session.interrupt() exactly once', () => {
  persistedChats = [];
  const session = makeSession();
  handleInterruptFrame('sid-1', session, 'kkrazy');
  assert.strictEqual(session.interrupted, 1, 'session.interrupt() called exactly once');
});

t('FIXED behavior: interrupt frame does NOT persist an "esc" user-typed chat row', () => {
  persistedChats = [];
  const session = makeSession();
  handleInterruptFrame('sid-1', session, 'kkrazy');
  const userTypedEsc = persistedChats.find(m => m.user === 'kkrazy' && m.text === 'esc');
  assert.strictEqual(userTypedEsc, undefined,
    'No chat row should be persisted with text="esc" attributed to the user — that\'s the bug-14 symptom');
});

t('FIXED behavior: interrupt frame emits an assistant ack message', () => {
  const session = makeSession();
  const emitted = [];
  session.on('chat', (m) => emitted.push(m));
  const note = handleInterruptFrame('sid-1', session, 'kkrazy');
  assert.strictEqual(emitted.length, 1, 'one chat ack emitted');
  assert.strictEqual(emitted[0].user, 'claude');
  assert.ok(/interrupt sent/i.test(emitted[0].text), 'ack text mentions interrupt');
  assert.strictEqual(emitted[0].meta && emitted[0].meta.kind, 'interrupt-ack',
    'ack carries meta.kind=interrupt-ack for client-side styling / dedup');
});

t('FIXED behavior: safe when session has no active iteration (no abort controller)', () => {
  // session.interrupt() may itself be a no-op when _abortController is
  // null; the frame handler should still complete without throwing.
  const session = new EventEmitter();
  session.interrupt = function () { /* no-op for this case */ };
  let threw = false;
  try { handleInterruptFrame('sid-1', session, 'kkrazy'); } catch { threw = true; }
  assert.strictEqual(threw, false, 'handler must not throw when interrupt is a no-op');
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards: pin the prod implementation.

t('static guard: client _sendStopAgent sends {t:"interrupt"}, NOT {t:"chat", text:"esc"}', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  const start = src.indexOf('function _sendStopAgent');
  assert.ok(start > 0, '_sendStopAgent must exist in app.js');
  const end = src.indexOf('\nfunction ', start + 1);
  const body = src.slice(start, end > 0 ? end : start + 800);
  // The fix replaces `sendChatMessage('esc')` with a direct WS send of
  // {t:'interrupt'}. Tolerate either an explicit ws.send / sendFrame
  // wrapper.
  assert.ok(/['"]interrupt['"]/.test(body),
    '_sendStopAgent must reference the literal "interrupt" frame type');
  assert.ok(!/sendChatMessage\(\s*['"]esc['"]/.test(body),
    '_sendStopAgent must NOT call sendChatMessage("esc") — that\'s the bug-14 path that pollutes chat history with a fake user-typed "esc"');
});

t('static guard: server attach.js owner WS handler has a t==="interrupt" branch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  // The owner inbound handler is inside _attachAgentWebSocket. Easier
  // grep: look for the discriminator across the whole file.
  assert.ok(/msg\.t\s*===\s*['"]interrupt['"]/.test(src),
    'attach.js must check msg.t === "interrupt" and route to session.interrupt()');
});

t('static guard: interrupt branch calls session.interrupt() (not just logs)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  // Find an "interrupt" branch and verify session.interrupt is called
  // within a small window of it.
  const idx = src.indexOf("msg.t === 'interrupt'");
  const idx2 = src.indexOf('msg.t === "interrupt"');
  const where = idx >= 0 ? idx : idx2;
  assert.ok(where > 0, 'interrupt branch must exist');
  const window = src.slice(where, where + 600);
  assert.ok(/session\.interrupt\s*\(/.test(window),
    'the interrupt branch must call session.interrupt()');
});

t('static guard: viewer attach also handles t==="interrupt" (or explicitly blocks viewers)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  const viewerStart = src.indexOf('function attachViewerWebSocket');
  assert.ok(viewerStart > 0, 'attachViewerWebSocket must exist');
  const viewerEnd = src.indexOf('\nfunction ', viewerStart + 1);
  const viewerBody = src.slice(viewerStart, viewerEnd > 0 ? viewerEnd : viewerStart + 4000);
  // Acceptable either way: viewers either handle interrupt OR explicitly
  // route it through a denial path. Both choices need an explicit
  // mention to prove the case was considered.
  assert.ok(/interrupt/i.test(viewerBody),
    'attachViewerWebSocket must mention interrupt — either to handle it or to explicitly deny viewers');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
