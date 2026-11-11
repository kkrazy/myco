// delm-10 regression: the session sidebar must show an obvious visual
// indicator on the session that is CURRENTLY WORKING (agent streaming).
// Before this change the sidebar only had a small static status dot
// derived from transcript mtime — nothing distinguished "claude is
// streaming right now" from "was active 5 min ago".
//
// Contract (three layers, each asserted below):
//   1. server: AgentSession.isBusy() mirrors this._iterating (true
//      while an SDK query iteration is streaming, false otherwise).
//   2. server: GET /sessions enriches each owned session with
//      s.agentBusy from the live session's isBusy().
//   3. client: renderSessionList emits a .session-busy-badge chip
//      ("working", no symbol prefix — redesigned 2026-10-22) when
//      s.agentBusy is truthy, and styles.css
//      defines the pulsing animation with a prefers-reduced-motion
//      opt-out.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

// 1. AgentSession.isBusy mirrors _iterating. We can't run a real SDK
// query here, so we instantiate the class and flip _iterating the way
// _ensureIteration does (set true at top, cleared in the drain path).
// Skips the runtime assertions when the SDK isn't installed (same
// graceful pattern as agent-session.test.js); the static assertions
// below still run.
const SDK_INSTALLED = (() => {
  try { require.resolve('@anthropic-ai/claude-agent-sdk'); return true; }
  catch { return false; }
})();
let AgentSession = null;
if (SDK_INSTALLED) {
  ({ AgentSession } = require('../server/src/agent-session'));
} else {
  console.log('  ~ isBusy() runtime checks skipped: @anthropic-ai/claude-agent-sdk not installed');
}

if (AgentSession) {
t('isBusy() is false on a fresh session (no iteration running)', () => {
  const s = new AgentSession('myco-busy-test-1');
  assert.strictEqual(s.isBusy(), false,
    'fresh AgentSession must report not busy — isBusy() must read this._iterating, which starts false');
});

t('isBusy() is true while _iterating (agent streaming)', () => {
  const s = new AgentSession('myco-busy-test-2');
  s._iterating = true;   // what _ensureIteration does for the streaming span
  assert.strictEqual(s.isBusy(), true,
    'isBusy() must return true while _iterating — this is what GET /sessions surfaces as agentBusy');
  s._iterating = false;  // drain path (after turn_result)
  assert.strictEqual(s.isBusy(), false,
    'isBusy() must return false again once the iteration drains — the badge must disappear when claude finishes');
});
}

// 2. GET /sessions enrichment wires isBusy into s.agentBusy.
const indexSrc = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');
t('GET /sessions enriches owned sessions with s.agentBusy from the live session', () => {
  assert.ok(/s\.agentBusy\s*=\s*!!\(\s*live\s*&&\s*typeof\s+live\.isBusy\s*===\s*'function'\s*&&\s*live\.isBusy\(\)\s*\)/.test(indexSrc),
    'index.js must set s.agentBusy from the live session (getPtySession(s.id)) isBusy() — grep for "s.agentBusy" near the pendingVerdict enrichment');
});
t('GET /sessions enrichment guards against live sessions lacking isBusy', () => {
  const m = indexSrc.match(/const live = getPtySession\(s\.id\);\s*\n\s*s\.agentBusy/);
  assert.ok(m,
    'the agentBusy line must follow `const live = getPtySession(s.id);` — keeps the lookup colocated with the enrichment loop');
});

// 3. Client renders the badge + CSS pulses it.
const appSrc = fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');
t('renderSessionList emits a .session-busy-badge when s.agentBusy is set', () => {
  // a8f49c8 moved the inline `const busyBadge = s.agentBusy…` ternary
  // into the named helper renderSessionBusyBadge(s) (single markup
  // source, role=status, aria). The contract is the same: the helper
  // reads s.agentBusy and renderSessionList interpolates its result.
  assert.ok(/function renderSessionBusyBadge\(s\)\s*\{[\s\S]{0,200}?if \(s\.agentBusy\)/.test(appSrc),
    'app.js must compute the busy badge from s.agentBusy inside renderSessionBusyBadge (a8f49c8 helper — inline ternary moved here)');
  assert.ok(/const busyBadge = renderSessionBusyBadge\(s\);/.test(appSrc),
    'renderSessionList must call the helper and bind the result to busyBadge');
  assert.ok(/class="session-busy-badge"/.test(appSrc),
    'app.js must render the badge with class session-busy-badge so the CSS animation applies');
  assert.ok(/busyBadge\}\$\{sharedBadge\}/.test(appSrc) || /\$\{busyBadge\}/.test(appSrc),
    'the badge must be interpolated into the session-title HTML');
});

const cssSrc = fs.readFileSync(path.join(ROOT, 'web/public/styles.css'), 'utf8');
t('styles.css defines the pulsing .session-busy-badge with reduced-motion opt-out', () => {
  assert.ok(/\.session-busy-badge\s*\{/.test(cssSrc),
    'styles.css must define .session-busy-badge');
  assert.ok(/@keyframes session-busy-pulse/.test(cssSrc),
    'styles.css must define the session-busy-pulse keyframes — the badge must be visibly animated so "working" is obvious at a glance');
  const badgeBlock = cssSrc.slice(cssSrc.indexOf('.session-busy-badge'));
  const reducedBlock = /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.session-busy-badge\s*\{\s*animation:\s*none;?\s*\}/.test(cssSrc);
  assert.ok(reducedBlock,
    'styles.css must disable the pulse under prefers-reduced-motion (accessibility, matches the bug-84 verdict badge pattern)');
});

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall ${passed} passed`);
process.exit(failed ? 1 : 0);
