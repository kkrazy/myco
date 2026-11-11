// delm-10 regression: the Stop button (HUD ⏹ + composer Stop + Esc)
// must only ever interrupt the session the user is ATTACHED to, and
// only while that session's agent is genuinely working.
//
// User report: "对应界面的stop按钮能不能识别当前session是否打开，
// 只管控当前session的" — the HUD Stop button rendered from
// state.runQueue's running entry with NO check that the attached
// session's agent was actually streaming, and no busy gate on the
// interrupt path. A stale/leaked running entry could offer a Stop
// that fired a no-op interrupt + a misleading ack note at an idle
// session.
//
// Contract (each side locked below):
//   1. Client: state.claudeRunning mirrors the authoritative
//      claude-running attach frame (BOTH polarities), is armed on
//      turn start (_markAwaitingClaude) and cleared on retire
//      (_retireClaudeTyping) + session switch (_resetUiForNewSession).
//   2. Client: the HUD stop button is only RENDERED when
//      state.claudeRunning is true, and its click handler re-checks.
//   3. Client: _sendStopAgent bails when !state.claudeRunning — the
//      final gate every caller (HUD / composer / Esc) passes through.
//   4. Server: the {t:'interrupt'} frame handlers (owner + viewer +
//      typed-esc chat path) drop the frame when the session's agent
//      is not busy (session.isBusy()), so a stray frame from a stale
//      client can never hit an idle session.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const ATTACH = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

console.log('── delm-10: Stop button is session-busy gated ──');

// ── 1. state.claudeRunning lifecycle ─────────────────────────────

t('state declares claudeRunning (default false)', () => {
  assert.ok(/claudeRunning:\s*false/.test(APP),
    'state must initialize claudeRunning: false — the HUD Stop button gates on it');
});

t('claude-running handler tracks BOTH polarities into state.claudeRunning', () => {
  const idx = APP.search(/msg\.kind === ['"]claude-running['"]/);
  assert.ok(idx > -1, '_applyStateUpdate must handle kind === "claude-running"');
  const body = APP.slice(idx, idx + 1200);
  assert.ok(/state\.claudeRunning\s*=\s*msg\.running === true/.test(body),
    'the handler must set state.claudeRunning = (msg.running === true) — true AND false, not just the false-branch retire');
});

t('_markAwaitingClaude arms claudeRunning (turn started on attached session)', () => {
  const idx = APP.indexOf('function _markAwaitingClaude');
  assert.ok(idx > -1, '_markAwaitingClaude must exist');
  const body = APP.slice(idx, idx + 900);
  assert.ok(/state\.claudeRunning\s*=\s*true/.test(body),
    'a turn starting on the attached session must flip claudeRunning true — the claude-running frame only ships on attach, not continuously');
});

t('_retireClaudeTyping clears claudeRunning (turn ended)', () => {
  const idx = APP.indexOf('function _retireClaudeTyping');
  assert.ok(idx > -1, '_retireClaudeTyping must exist');
  const body = APP.slice(idx, idx + 1200);
  assert.ok(/state\.claudeRunning\s*=\s*false/.test(body),
    'the single retire path must clear claudeRunning so the HUD Stop hides + late clicks no-op');
});

t('_resetUiForNewSession clears claudeRunning (no cross-session leak)', () => {
  const idx = APP.indexOf('function _resetUiForNewSession');
  assert.ok(idx > -1, '_resetUiForNewSession must exist');
  const body = APP.slice(idx, idx + 4000);
  assert.ok(/state\.claudeRunning\s*=\s*false/.test(body),
    'session switch must clear claudeRunning — the previous session\'s busy state must never offer a Stop for the new (idle) session; the new session\'s value arrives via its own claude-running attach frame');
});

// ── 2. HUD stop button is rendered + gated on busy ───────────────

function hudBody() {
  const idx = APP.indexOf('function _updateTaskHUD');
  assert.ok(idx > -1, '_updateTaskHUD must exist');
  const rest = APP.slice(idx);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

t('HUD only renders the stop button while something is working', () => {
  const body = hudBody();
  // stop-vs-run-n2 (2026-10-22): widened gate — a LIVE team lane also
  // counts as working (the /run-n2 lane's workers stream while the
  // attached session itself stays idle).
  const m = body.match(/const stopBtnHtml = \(state\.claudeRunning \|\| laneRunningHud\)/);
  assert.ok(m,
    'the hud-stop-btn HTML must be gated on state.claudeRunning OR a live team lane (laneRunningHud) — no Stop affordance when neither is working, but a running /run-n2 lane MUST show it');
  assert.ok(/stopBtnHtml\s*\}\$\{/.test(body) || /\$\{stopBtnHtml\}/.test(body),
    'the gated stopBtnHtml must be interpolated into the HUD markup');
});

t('HUD stop click handler re-checks claudeRunning before sending', () => {
  const body = hudBody();
  const m = body.match(/stopBtn\.addEventListener\('click',\s*\(\)\s*=>\s*\{[\s\S]{0,200}?if\s*\(!state\.claudeRunning\)\s*return;/);
  assert.ok(m,
    'the HUD stop click listener must bail when !state.claudeRunning — belt-and-suspenders against a stale DOM node');
});

// ── 3. _sendStopAgent final gate ─────────────────────────────────

function stopAgentBody() {
  const idx = APP.indexOf('function _sendStopAgent');
  assert.ok(idx > -1, '_sendStopAgent must exist');
  const rest = APP.slice(idx);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

t('_sendStopAgent drops the interrupt when the attached session is not working', () => {
  const body = stopAgentBody();
  // stop-vs-run-n2 (2026-10-22): the gate widened — a LIVE team lane
  // (state.teamView.active && teamLane && !laneEnded) also counts as
  // "working", because a /run-n2 lane iterates shadow workers while
  // the main session stays idle. The early return must cover BOTH
  // flags being false, still preventing a stray interrupt at a
  // genuinely idle session.
  const m = body.match(/if\s*\(!state\.claudeRunning\s*&&\s*!laneRunning\)\s*\{[\s\S]{0,300}?return;/);
  assert.ok(m,
    '_sendStopAgent must return early when neither the attached session is working (claudeRunning) nor a live team lane (laneRunning) — this is the final gate ALL stop callers (HUD button, composer Stop, Esc) pass through, so it alone guarantees the interrupt frame can only fire at something that is actually working');
  assert.ok(/const laneRunning\s*=\s*state\.teamView\.active\s*&&\s*state\.teamView\.teamLane\s*&&\s*!state\.teamView\.laneEnded;/.test(body),
    'the lane-running predicate must mirror the server\'s live _teamLane check (active && teamLane && !laneEnded)');
});

// ── 4. Server-side busy gate on the interrupt paths ──────────────

// stop-vs-run-n2 (2026-10-22): the three interrupt entry points (owner
// frame, viewer frame, typed-esc) now share ONE handler, _handleInterrupt
// in attach.js. The gate still exists — it lives INSIDE the helper
// (consults session.isBusy() AND compare-lanes.stopN2Lane's live-lane
// check) and each call site must route through it, so the assertions
// below check the call site delegates AND the helper itself carries the
// busy gate + not-busy early return.

function interruptHandlerBody() {
  const idx = ATTACH.indexOf('function _handleInterrupt');
  assert.ok(idx > -1, '_handleInterrupt must exist in attach.js (shared Stop/interrupt handler for the three entry points)');
  const rest = ATTACH.slice(idx);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

t('shared _handleInterrupt gates on session.isBusy() + live lane', () => {
  const body = interruptHandlerBody();
  assert.ok(/session\.isBusy/.test(body),
    '_handleInterrupt must consult session.isBusy() before interrupting — a stale client must not be able to fire a no-op interrupt + ack at an idle session');
  assert.ok(/stopN2Lane/.test(body),
    '_handleInterrupt must consult compare-lanes.stopN2Lane — a /run-n2 lane runs in a shadow TeamSession while the main session is idle, so isBusy() alone would drop a legitimate Stop');
  assert.ok(/if\s*\(!busy\s*&&\s*!laneStopped\)/.test(body),
    'the gate must early-return only when BOTH the session is idle and no live lane was stopped');
  assert.ok(/session\.interrupt\s*\(/.test(body),
    '_handleInterrupt must call session.interrupt() for the main iteration');
});

t('server owner interrupt branch routes through _handleInterrupt', () => {
  const idx = ATTACH.indexOf("msg.t === 'interrupt'");
  assert.ok(idx > -1, 'owner interrupt branch must exist');
  const body = ATTACH.slice(idx, idx + 900);
  assert.ok(/_handleInterrupt\(session,\s*sessionId/.test(body),
    'the owner {t:"interrupt"} handler must delegate to _handleInterrupt so the busy gate + lane stop run in ONE place');
});

t('server viewer interrupt branch routes through _handleInterrupt', () => {
  const viewerStart = ATTACH.indexOf('function attachViewerWebSocket');
  assert.ok(viewerStart > -1, 'attachViewerWebSocket must exist');
  const viewerEnd = ATTACH.indexOf('\nfunction ', viewerStart + 1);
  const viewerBody = ATTACH.slice(viewerStart, viewerEnd > 0 ? viewerEnd : viewerStart + 12000);
  const idx = viewerBody.indexOf("msg.t === 'interrupt'");
  assert.ok(idx > -1, 'viewer interrupt branch must exist');
  const win = viewerBody.slice(idx, idx + 900);
  assert.ok(/_handleInterrupt\(session,\s*sessionId/.test(win),
    'the viewer interrupt handler must delegate to _handleInterrupt too (same delm-10 rule + lane stop)');
});

t('typed-esc chat path routes through _handleInterrupt', () => {
  const idx = ATTACH.indexOf("key === 'esc'");
  assert.ok(idx > -1, 'the typed-esc special-key branch must exist');
  const body = ATTACH.slice(idx, idx + 900);
  assert.ok(/_handleInterrupt\(session,\s*sessionId/.test(body),
    'the typed "esc"/"ctrl-c" interrupt path must delegate to _handleInterrupt — same rule as the button frame');
});

// ── runtime micro-test of the server gate shape ──────────────────
// Simulates the owner interrupt branch semantics against a mock
// session, mirroring the gate added in attach.js.

function mockSession(busy) {
  const s = new EventEmitter();
  s.isBusy = () => busy;
  s.interrupted = 0;
  s.interrupt = () => { s.interrupted++; };
  return s;
}

function handleInterruptFrame(session) {
  // mirror of the gated branch
  const busy = typeof session.isBusy === 'function' ? session.isBusy() : !!session._currentQuery;
  if (!busy) return false;
  session.interrupt();
  return true;
}

t('runtime mirror: interrupt fires when busy, drops when idle', () => {
  const busySess = mockSession(true);
  assert.strictEqual(handleInterruptFrame(busySess), true, 'busy session must be interrupted');
  assert.strictEqual(busySess.interrupted, 1, 'session.interrupt() called exactly once');

  const idleSess = mockSession(false);
  const emitted = [];
  idleSess.on('chat', (m) => emitted.push(m));
  assert.strictEqual(handleInterruptFrame(idleSess), false,
    'idle session must NOT be interrupted — the delm-10 busy gate drops the frame');
  assert.strictEqual(idleSess.interrupted, 0, 'session.interrupt() must not run on an idle session');
  assert.strictEqual(emitted.length, 0,
    'no interrupt-ack chat note for a dropped frame — an ack on a no-op would make Stop look broken');
});

console.log('\n' + (failed ? `${failed} FAILED, ${passed} passed` : `all ${passed} passed`));
process.exit(failed ? 1 : 0);
