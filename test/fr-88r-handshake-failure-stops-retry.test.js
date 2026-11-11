// fr-88r (regression): "Stuck on connecting" — a WS that never completes
// its handshake (typically because the server rejected the upgrade with
// HTTP 403 from fr-87's tightened gate) must NOT trigger the blocking
// reconnect modal in an infinite loop.
//
// User-reported symptom (verbatim): "Opti stuck on connecting" — observed
// on opti.labxnow.ai after the fr-87 + fr-88 deploy. Root cause:
//   - Pre-fr-87: any authenticated user got read-only WS attach.
//   - Post-fr-87: non-owner non-admin non-viewer authenticated users get
//     HTTP 403 at the WS upgrade.
//   - Post-fr-88: the WS close handler unconditionally shows the BLOCKING
//     reconnect modal and re-attempts on the same id — which 403s again.
//   - Combined: the user sees "Reconnecting…" forever; the modal blocks
//     all interaction; only a manual page reload escapes.
//
// Contract being locked:
//   - The connect() closure tracks `wsEverOpened` per WS instance.
//   - An outer scope counter `consecutiveHandshakeFailures` survives
//     reconnects.
//   - On `open`: wsEverOpened=true; consecutiveHandshakeFailures=0;
//     reconnectDelay reset.
//   - On `close`:
//       - If wsEverOpened === false → consecutiveHandshakeFailures++.
//       - Once consecutiveHandshakeFailures reaches 3, STOP the retry
//         loop: show a NON-blocking error overlay and null
//         state.activeId so further setInterval(refreshSessions) ticks
//         don't reopen the same session.
//   - A successful open after some handshake failures resets the
//     counter so a later transient drop doesn't inherit those failures.
//
// Test shape mirrors fr-87/fr-88: pure-logic helper + static-grep guards.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ── Pure-logic helper that mirrors the prod close-handler control flow
// without spinning up a real WebSocket. ──

const MAX_HANDSHAKE_FAILURES = 3;

function makeWsLoop() {
  // Mirrors the relevant fields in the prod connect closure:
  //   - consecutiveHandshakeFailures (outer-closure counter)
  //   - state.activeId
  //   - overlay shown / blocking / kind
  const ctx = {
    state: { activeId: 'sess-A' },
    consecutiveHandshakeFailures: 0,
    overlay: { shown: false, text: '', kind: null, blocking: false },
    reconnectsScheduled: 0,
    stopped: false,
  };

  function onOpen() {
    ctx.consecutiveHandshakeFailures = 0;
    ctx.overlay.shown = false;
  }

  function onClose(wsEverOpened, id) {
    if (ctx.state.activeId !== id) return;
    if (!wsEverOpened) {
      ctx.consecutiveHandshakeFailures++;
      if (ctx.consecutiveHandshakeFailures >= MAX_HANDSHAKE_FAILURES) {
        // Give up: show non-blocking error, null activeId so the
        // setInterval reopen path is disabled until the user picks a
        // new session.
        ctx.overlay = { shown: true, text: 'Cannot connect', kind: 'error', blocking: false };
        ctx.state.activeId = null;
        ctx.stopped = true;
        return;
      }
    }
    // Schedule another reconnect attempt with the blocking modal.
    ctx.overlay = { shown: true, text: 'Reconnecting', kind: null, blocking: true };
    ctx.reconnectsScheduled++;
  }

  return { ctx, onOpen, onClose };
}

console.log('── fr-88r: handshake-failure stops the retry loop ──');

t('three close-without-open events stop the retry loop', () => {
  const { ctx, onClose } = makeWsLoop();
  // Simulate 3 consecutive WS upgrades that close without ever opening
  // (the fr-87 403 path).
  onClose(false, 'sess-A');
  onClose(false, 'sess-A');
  onClose(false, 'sess-A');
  assert.strictEqual(ctx.stopped, true, 'loop must stop after 3 handshake failures');
  assert.strictEqual(ctx.state.activeId, null, 'activeId must be nulled so setInterval reopen does not re-trigger');
  assert.strictEqual(ctx.overlay.text, 'Cannot connect');
  assert.strictEqual(ctx.overlay.kind, 'error');
  assert.strictEqual(ctx.overlay.blocking, false, 'final error overlay must NOT block interaction (user needs to pick another session)');
});

t('first two close-without-open events still try to reconnect (transient-friendly)', () => {
  const { ctx, onClose } = makeWsLoop();
  onClose(false, 'sess-A');
  assert.strictEqual(ctx.stopped, false);
  assert.strictEqual(ctx.consecutiveHandshakeFailures, 1);
  assert.strictEqual(ctx.overlay.text, 'Reconnecting');
  assert.strictEqual(ctx.overlay.blocking, true);

  onClose(false, 'sess-A');
  assert.strictEqual(ctx.stopped, false);
  assert.strictEqual(ctx.consecutiveHandshakeFailures, 2);
});

t('successful open resets the handshake-failure counter', () => {
  const { ctx, onOpen, onClose } = makeWsLoop();
  onClose(false, 'sess-A');
  onClose(false, 'sess-A');
  assert.strictEqual(ctx.consecutiveHandshakeFailures, 2);
  onOpen();
  assert.strictEqual(ctx.consecutiveHandshakeFailures, 0,
    'a successful open must reset the counter so a later transient drop does not inherit handshake failures');
  // After the reset, another two failures should NOT trigger the stop.
  onClose(false, 'sess-A');
  onClose(false, 'sess-A');
  assert.strictEqual(ctx.stopped, false);
});

t('close-after-open (transient drop after a successful session) does NOT count as handshake failure', () => {
  const { ctx, onClose } = makeWsLoop();
  onClose(true, 'sess-A');                 // wsEverOpened=true: transient
  onClose(true, 'sess-A');
  onClose(true, 'sess-A');
  assert.strictEqual(ctx.consecutiveHandshakeFailures, 0,
    'transient drops post-open must NOT increment the handshake-failure counter');
  assert.strictEqual(ctx.stopped, false);
  assert.strictEqual(ctx.overlay.text, 'Reconnecting');
  assert.strictEqual(ctx.overlay.blocking, true);
});

t('session switch (activeId !== id) does not increment the counter', () => {
  const { ctx, onClose } = makeWsLoop();
  ctx.state.activeId = 'sess-B';            // user switched
  onClose(false, 'sess-A');                 // close for the OLD session
  assert.strictEqual(ctx.consecutiveHandshakeFailures, 0,
    'a close on a stale session id must NOT increment the counter or schedule reconnects');
  assert.strictEqual(ctx.reconnectsScheduled, 0);
});

// ── Static-grep guards on prod source ──

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

t('static guard: connect closure declares wsEverOpened', () => {
  const src = _read('web/public/app.js');
  const connectStart = src.indexOf('function connect()');
  assert.ok(connectStart > 0, 'app.js must contain function connect()');
  const window = src.slice(connectStart, connectStart + 6000);
  assert.ok(/let\s+wsEverOpened\s*=\s*false/.test(window),
    'connect() must declare `let wsEverOpened = false` so the close handler can distinguish handshake failure from transient drop');
});

t('static guard: open handler sets wsEverOpened=true', () => {
  const src = _read('web/public/app.js');
  const openAt = src.indexOf("ws.addEventListener('open'");
  assert.ok(openAt > 0);
  const window = src.slice(openAt, openAt + 600);
  assert.ok(/wsEverOpened\s*=\s*true/.test(window),
    "the WS 'open' handler must set wsEverOpened = true");
});

t('static guard: close handler increments consecutiveHandshakeFailures + bails after 3', () => {
  const src = _read('web/public/app.js');
  const closeAt = src.indexOf("ws.addEventListener('close'");
  assert.ok(closeAt > 0);
  const window = src.slice(closeAt, closeAt + 1500);
  assert.ok(/consecutiveHandshakeFailures/.test(window),
    'close handler must reference consecutiveHandshakeFailures to track repeated handshake failures');
  assert.ok(/>=\s*(3|MAX_HANDSHAKE_FAILURES)\b/.test(window),
    'close handler must bail after >= 3 consecutive handshake failures (3 attempts is enough to rule out transient network glitches; the literal 3 may live in a named constant like MAX_HANDSHAKE_FAILURES which the test accepts equally)');
  assert.ok(/state\.activeId\s*=\s*null/.test(window),
    'bailout path must null state.activeId so the setInterval(refreshSessions) reopen path is disabled');
});

t('static guard: bailout overlay is NON-blocking + kind=error', () => {
  const src = _read('web/public/app.js');
  const closeAt = src.indexOf("ws.addEventListener('close'");
  const window = src.slice(closeAt, closeAt + 1500);
  // Look for the bailout call to showConnOverlay (the OTHER call is the
  // Reconnecting path which is blocking).
  const errorCallMatch = window.match(/showConnOverlay\([^)]*['"]error['"][^)]*\)/);
  assert.ok(errorCallMatch,
    "bailout must call showConnOverlay with kind='error' so the pill renders red");
  assert.ok(!/showConnOverlay\([^)]*['"]error['"][^)]*,\s*true\s*\)/.test(window),
    'bailout overlay must NOT be blocking (user needs to click another session to recover)');
});

t('static guard: open handler resets consecutiveHandshakeFailures', () => {
  const src = _read('web/public/app.js');
  const openAt = src.indexOf("ws.addEventListener('open'");
  const window = src.slice(openAt, openAt + 600);
  assert.ok(/consecutiveHandshakeFailures\s*=\s*0/.test(window),
    "the WS 'open' handler must reset consecutiveHandshakeFailures to 0 so a later transient drop does not inherit handshake failures");
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
