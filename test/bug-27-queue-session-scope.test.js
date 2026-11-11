// bug-27 regression: queue chip strip must stay scoped to its session.
//
// User report: "After switching sessions, the queue from the previous
// session shows up on other sessions."
//
// Two-sided fix:
//   1. Client (web/public/app.js): _resetUiForNewSession clears
//      state.runQueue + re-renders the strip so the previous
//      session's chips disappear immediately on switch.
//   2. Server (server/src/attach.js): _sendAttachSnapshot ships the
//      new session's runQueue state on attach (parallel to
//      artifacts-init) so the strip populates correctly on the FIRST
//      frame, not after the first queue mutation. Without this, an
//      idle queue would never repopulate after a switch.
//
// Belt-and-braces: each side defends against the other failing.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

console.log('── bug-27: queue UI scoped to its session ──');

// ──────────────────────────────────────────────────────────────────────
// Client: _resetUiForNewSession clears runQueue + re-renders the strip
// ──────────────────────────────────────────────────────────────────────

function _resetUiBody() {
  const start = APP.search(/function\s+_resetUiForNewSession\s*\(/);
  assert.ok(start > -1, '_resetUiForNewSession must exist');
  const rest = APP.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

t('_resetUiForNewSession sets state.runQueue = null', () => {
  const body = _resetUiBody();
  assert.ok(/state\.runQueue\s*=\s*null/.test(body),
    'session-switch must null state.runQueue so the previous session\'s chips can\'t leak');
});

t('_resetUiForNewSession re-renders the strip after clearing', () => {
  const body = _resetUiBody();
  // The clear must be followed by a _renderRunQueueStrip() call so
  // the DOM updates (strip hides) — otherwise the chip nodes stay
  // until the next state-update frame.
  assert.ok(/state\.runQueue\s*=\s*null[\s\S]{0,200}?_renderRunQueueStrip\s*\(/.test(body),
    'after nulling state.runQueue, _resetUiForNewSession must call _renderRunQueueStrip() so the DOM updates immediately (don\'t wait for the next state-update WS frame)');
});

// ──────────────────────────────────────────────────────────────────────
// Server: _sendAttachSnapshot ships runQueue state on attach
// ──────────────────────────────────────────────────────────────────────

function _snapshotBody() {
  const start = ATTACH.search(/function\s+_sendAttachSnapshot\s*\(/);
  assert.ok(start > -1, '_sendAttachSnapshot must exist');
  const rest = ATTACH.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

t('_sendAttachSnapshot ships a state-update with kind:runQueue on attach', () => {
  const body = _snapshotBody();
  assert.ok(/kind:\s*['"]runQueue['"]/.test(body),
    '_sendAttachSnapshot must include a state-update with kind:"runQueue"');
});

t('the initial runQueue frame uses runQueue.getQueueState(rec)', () => {
  const body = _snapshotBody();
  assert.ok(/runQueue\.getQueueState\(\s*rec\s*\)/.test(body),
    'must call runQueue.getQueueState(rec) so the payload shape matches what _renderRunQueueStrip expects');
});

t('initial-runQueue ship is wrapped in try/catch (don\'t kill attach on failure)', () => {
  const body = _snapshotBody();
  // The kind:'runQueue' send should sit inside a try/catch so a
  // getQueueState throw doesn't abort _sendAttachSnapshot midway.
  const m = body.match(/try\s*\{[\s\S]{0,400}?kind:\s*['"]runQueue['"][\s\S]{0,300}?\}\s*catch/);
  assert.ok(m, 'kind:runQueue send must be wrapped in try/catch — never abort _sendAttachSnapshot if getQueueState misbehaves');
});

t('runQueue module is imported (we use it directly in the snapshot)', () => {
  assert.ok(/const\s+runQueue\s*=\s*require\(['"]\.\/runQueue['"]\)/.test(ATTACH),
    'attach.js must require ./runQueue — we call runQueue.getQueueState directly in the snapshot');
});

// ──────────────────────────────────────────────────────────────────────
// Belt-and-braces — the existing chip-strip renderer must already
// handle null/empty runQueue gracefully (this isn't new, just
// pinning so a future refactor can't break the client-side clear).
// ──────────────────────────────────────────────────────────────────────

t('_renderRunQueueStrip handles null/empty runQueue (hides + clears DOM)', () => {
  const start = APP.search(/function\s+_renderRunQueueStrip\s*\(/);
  const body = sliceFn(APP, start);
  assert.ok(/!q\s*\|\|\s*!Array\.isArray\(q\.entries\)\s*\|\|\s*!q\.entries\.length/.test(body),
    '_renderRunQueueStrip must short-circuit on null / empty entries — otherwise the client-side clear would throw');
  assert.ok(/host\.hidden\s*=\s*true/.test(body),
    'short-circuit must hide the strip element');
  assert.ok(/host\.innerHTML\s*=\s*['"]['"]/.test(body),
    'short-circuit must clear innerHTML so leftover chip DOM is gone');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
