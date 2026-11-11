// Working/status display regression (task 2a round 2, 2026-10-23).
//
// Three user-visible working-status defects, each locked below:
//   1. attach.js's claude-running frame read ONLY session._currentQuery,
//      so an agent-n2 TeamSession (no _currentQuery slot; each worker
//      owns its own Query) always reported running=false — the client
//      Stop gate (state.claudeRunning) dropped every interrupt for a
//      live team session. The read now prefers session.isBusy() (the
//      same contract _handleInterrupt + GET /sessions use).
//   2. openSession's same-session re-tap branch early-returned BEFORE
//      the /sessions/:id/viewed stamp, so re-opening the card while
//      still attached never cleared the sidebar "to review" chip.
//      The re-tap branch now fires the same fire-and-forget stamp.
//   3. The 30s strip-silence idle fallback retires state.claudeRunning
//      even when the session is genuinely busy (a long Agent/docker
//      tool call can be silent past 30s). The 3s refreshSessions poll
//      now re-arms claudeRunning one-directionally from the server's
//      s.agentBusy truth (busy=true resurrects; busy=false never
//      retires — terminal events own that).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const ATTACH = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

const { fnBody } = require('./_lib/fn-body');

console.log('── working-status live fixes (task 2a r2) ──');

// ── 1. claude-running frame must honor TeamSession.isBusy() ──

t('attach claude-running frame prefers session.isBusy() over _currentQuery', () => {
  const idx = ATTACH.indexOf("kind: 'claude-running'");
  assert.ok(idx > -1, 'attach.js must still ship the claude-running state-update frame');
  const body = ATTACH.slice(idx - 900, idx + 700);
  assert.ok(/typeof session\.isBusy === 'function'/.test(body),
    'the running computation must check session.isBusy() — a TeamSession has no _currentQuery so the old read always reported idle');
  assert.ok(/!!session\.isBusy\(\)/.test(body),
    'the busy branch must call session.isBusy()');
  assert.ok(/!!session\._currentQuery/.test(body),
    'the fallback branch must keep the _currentQuery read for plain AgentSessions');
  assert.ok(!/running:\s*!!session\._currentQuery/.test(body),
    'the frame payload must be the computed `running` variable, not a bare _currentQuery read');
});

// ── 2. openSession re-tap stamps /viewed (clears "to review") ──

t('openSession re-tap branch fires the /viewed stamp before returning', () => {
  const body = fnBody(APP, /function openSession\(id,\s*opts\s*=\s*\{\}\)\s*\{/);
  const retap = body.slice(0, body.indexOf('_teardownPreviousSession'));
  assert.ok(retap.length > 0, 'the re-tap early-return branch must exist before the teardown path');
  assert.ok(/\/viewed/.test(retap),
    'the same-session re-tap branch must POST /sessions/:id/viewed — pre-fix it returned early and never cleared the "to review" chip');
  assert.ok(/encodeURIComponent\(id\)/.test(retap),
    'the stamp must target the tapped session id');
});

// ── 3. refreshSessions re-arms claudeRunning from server truth ──

t('refreshSessions re-arms claudeRunning from the polled s.agentBusy', () => {
  const body = fnBody(APP, /async function refreshSessions\(\)\s*\{/);
  assert.ok(/cur\.agentBusy/.test(body),
    'refreshSessions must read the ACTIVE session\'s agentBusy from the 3s poll payload');
  assert.ok(/state\.claudeRunning = true/.test(body),
    'a busy=true poll must re-arm state.claudeRunning (self-heal after the 30s idle fallback wrongly retired it)');
  assert.ok(/!state\.claudeRunning && !state\.awaitingClaude/.test(body),
    'the re-arm must be gated on both flags being false — never fight an explicit Stop or an in-flight turn');
  assert.ok(!/state\.claudeRunning = false/.test(body),
    'the poll must be ONE-DIRECTIONAL: busy=false must NOT retire claudeRunning — only the turn\'s own terminal events retire it');
});

process.on('exit', (code) => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : code;
});
