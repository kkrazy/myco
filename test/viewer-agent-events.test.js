// bug-13 regression: chrome batch messages (which render from
// `agent-event` WS frames) must be visible to ALL participants in
// a session, not just the owner.
//
// Root cause (pre-fix): server/src/attach.js `attachViewerWebSocket`
// subscribed only to `session.on('chat', ...)` + `state-update`. It
// deliberately did NOT subscribe to `agent-event`, so the rich
// chrome-batch timeline (tool calls, tool results, permission
// requests, turn results) never reached share-link viewers. The
// commit comment said it was a privacy decision around tool inputs;
// the bug-13 report flips that decision — visibility wins.
//
// Fix shape (mirrored from `_attachAgentWebSocket`):
//   1. Ship the initial agent-replay tail on attach so viewers see
//      recent chrome batches (not only events going forward).
//   2. Ship session._initSnapshot via `t:'agent-init'` if present.
//   3. Subscribe to `agent-event` and forward each one as
//      `{ t:'agent-event', event }`.
//   4. Clean up the listener on close.
//
// This test uses a tiny EventEmitter + WS-fake to assert the
// behavior end-to-end, plus 4 static-grep guards pinning the prod
// implementation in attach.js to the new contract.

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
// Inlined FIXED behavior: a helper that wires an EventEmitter session
// to a WS-fake so EITHER kind of attach (owner OR viewer) forwards
// agent-event frames. The same helper backs both paths; only the
// `session.on('chat', …)` etc. listeners differ.

function makeWsFake() {
  const sent = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(s) { sent.push(JSON.parse(s)); },
    close() { this.readyState = 3; },
  };
}

function subscribeAgentEvents(session, ws) {
  const onAgentEvent = (event) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ t: 'agent-event', event }));
  };
  session.on('agent-event', onAgentEvent);
  return () => session.off('agent-event', onAgentEvent);
}

// ──────────────────────────────────────────────────────────────────────────

console.log('── bug-13: agent-event fan-out to viewers ──');

t('FIXED behavior: viewer WS receives agent-event frames after subscription', () => {
  const session = new EventEmitter();
  const ws = makeWsFake();
  subscribeAgentEvents(session, ws);
  session.emit('agent-event', { type: 'tool_use', name: 'Bash', input: { command: 'ls' } });
  assert.strictEqual(ws.sent.length, 1, 'one frame received');
  assert.strictEqual(ws.sent[0].t, 'agent-event');
  assert.strictEqual(ws.sent[0].event.type, 'tool_use');
});

t('FIXED behavior: owner + viewer BOTH receive the same event', () => {
  const session = new EventEmitter();
  const ownerWs = makeWsFake();
  const viewerWs = makeWsFake();
  subscribeAgentEvents(session, ownerWs);
  subscribeAgentEvents(session, viewerWs);
  session.emit('agent-event', { type: 'tool_result', content: 'ok', isError: false });
  assert.strictEqual(ownerWs.sent.length, 1, 'owner got the event');
  assert.strictEqual(viewerWs.sent.length, 1, 'viewer got the SAME event');
  assert.deepStrictEqual(ownerWs.sent[0], viewerWs.sent[0], 'frames are byte-identical');
});

t('FIXED behavior: close handler unsubscribes — no leak after ws closes', () => {
  const session = new EventEmitter();
  const ws = makeWsFake();
  const off = subscribeAgentEvents(session, ws);
  session.emit('agent-event', { type: 'tool_use' });
  assert.strictEqual(ws.sent.length, 1);
  off();   // simulates ws.on('close', () => session.off(...))
  ws.close();
  session.emit('agent-event', { type: 'tool_use' });
  session.emit('agent-event', { type: 'tool_result' });
  assert.strictEqual(ws.sent.length, 1, 'no further frames after unsubscribe');
});

t('FIXED behavior: closed ws is skipped without throwing', () => {
  const session = new EventEmitter();
  const ws = makeWsFake();
  subscribeAgentEvents(session, ws);
  ws.close();  // simulate browser tab closed mid-flight
  // emit should not throw; the readyState guard short-circuits
  session.emit('agent-event', { type: 'tool_use' });
  assert.strictEqual(ws.sent.length, 0, 'no frames sent on closed ws');
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards on the prod source — pin attachViewerWebSocket
// to the fixed contract.

function _viewerBody() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  const start = src.indexOf('function attachViewerWebSocket');
  assert.ok(start > 0, 'attachViewerWebSocket must exist');
  // Find the end of the function (next `\nfunction ` at module-level
  // column 0). The function grows as new WS-frame branches land (e.g.
  // bug-14 added the interrupt branch). 8000-char window leaves
  // headroom for several more such additions without false-tripping
  // the static-grep guards below.
  const slice = src.slice(start, start + 8000);
  const endIdx = slice.search(/\nfunction [a-zA-Z_]/m);
  return endIdx > 0 ? slice.slice(0, endIdx) : slice;
}

t('static guard: attachViewerWebSocket subscribes to agent-event', () => {
  const body = _viewerBody();
  assert.ok(/session\.on\(['"]agent-event['"]/.test(body),
    'viewer must `session.on("agent-event", ...)` so chrome batches reach share-link viewers');
});

t('static guard: attachViewerWebSocket forwards agent-event as `{t:"agent-event", event}` frames', () => {
  const body = _viewerBody();
  assert.ok(/JSON\.stringify\(\s*\{\s*t\s*:\s*['"]agent-event['"]/.test(body),
    'viewer must ship agent-event frames over the WS');
});

t('static guard: attachViewerWebSocket ships the initial agent-replay tail', () => {
  const body = _viewerBody();
  assert.ok(/_shipAgentReplay\s*\(/.test(body),
    'viewer must call _shipAgentReplay on attach so viewers see recent chrome batches, not only events from now on');
});

t('static guard: attachViewerWebSocket cleans up agent-event listener on close', () => {
  const body = _viewerBody();
  assert.ok(/session\.off\(['"]agent-event['"]/.test(body),
    'viewer must `session.off("agent-event", ...)` in the close handler to avoid listener leak across reconnects');
});

t('static guard: attachViewerWebSocket subscribes to + cleans up exit too', () => {
  // Comprehensive event-fan-out gate: every session event the owner
  // receives must also reach viewers. exit is the last remaining
  // session-level event (chat + state-update + agent-event were
  // already covered; exit tells the viewer the session is over).
  const body = _viewerBody();
  assert.ok(/session\.on\(['"]exit['"]/.test(body),
    'viewer must `session.on("exit", ...)` so the UI can render "session ended"');
  assert.ok(/session\.off\(['"]exit['"]/.test(body),
    'viewer must `session.off("exit", ...)` in close handler');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
