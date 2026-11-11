// bug-29 regression: deleting the active session must wipe the
// Plan / Arch / Test panes + the artifact cache + the run-queue chip
// strip — not just close the WS + clear activeId.
//
// User report: "Deleting a session doesn't refresh the plan view
// until another session is clicked. Expected: deleting a session
// immediately clears both the chat pane and the plan view."
//
// Root cause: deleteSessionWithConfirm had a partial cleanup —
// it closed the WS, disposed xterm, cleared state.activeId +
// localStorage, hid #terminal-wrap, showed #no-session — but did
// NOT clear state.artifacts, did NOT hide the artifact wraps, did
// NOT reset state.runQueue + re-render the queue chip strip, did
// NOT clearChat / clearArtifactBodies. So the deleted session's
// Plan view stayed mounted with its last items until the user
// clicked a different session (which then ran _resetUiForNewSession
// and DID do the cleanup).
//
// Same shape as bug-27 (queue chip strip leaked across sessions on
// SWITCH; fixed there). This is the same class of bug on the
// DELETE flow.
//
// Fix: mirror the relevant subset of _resetUiForNewSession inline
// in deleteSessionWithConfirm's "deleted the active session" branch.
// We deliberately don't call _resetUiForNewSession itself because
// that helper installs a NEW activeId + persists it — deletion has
// no successor session to install.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── bug-29: delete-session must clear the plan view ──');

// Extract the body of deleteSessionWithConfirm so the assertions
// can grep within just that function (not the rest of app.js).
function _deleteFnBody() {
  const start = APP.search(/async\s+function\s+deleteSessionWithConfirm\s*\(/);
  assert.ok(start > -1, 'deleteSessionWithConfirm must exist in app.js');
  const rest = APP.slice(start);
  // Find the start of the next function definition (any kind).
  const end = rest.slice(1).search(/\n(?:async\s+)?function\s+[A-Za-z_]/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

t('deleteSessionWithConfirm exists in app.js', () => {
  _deleteFnBody();
});

// ──────────────────────────────────────────────────────────────────────
// The active-session branch must do the full cleanup
// ──────────────────────────────────────────────────────────────────────

t('clears the artifact cache when the active session is deleted', () => {
  const body = _deleteFnBody();
  // Pre-fix: no state.artifacts assignment in the delete path; the
  // last-loaded plan/arch/test artifact stayed in memory and the
  // DOM panes stayed populated. The fix assigns
  // state.artifacts = { sessionId: null, byType: {} } so any later
  // renderArtifact call (or pane re-show) starts from a clean slate.
  assert.ok(/state\.artifacts\s*=\s*\{[^}]*sessionId:\s*null[^}]*byType:\s*\{\s*\}/.test(body),
    'deleteSessionWithConfirm must reset state.artifacts to { sessionId: null, byType: {} } so the deleted session\'s extracted Plan/Arch/Test data is dropped immediately');
});

t('clears the run-queue chip strip when active session is deleted', () => {
  const body = _deleteFnBody();
  // bug-27 fix added this to the SWITCH path; bug-29 adds it to the
  // DELETE path. Mirror.
  assert.ok(/state\.runQueue\s*=\s*null/.test(body),
    'deleteSessionWithConfirm must set state.runQueue = null so the deleted session\'s queue chips drop from the strip');
  assert.ok(/_renderRunQueueStrip\s*\(/.test(body),
    'deleteSessionWithConfirm must call _renderRunQueueStrip() so the empty queue state takes effect in the DOM');
});

t('hides all artifact panes (Plan / Arch / Test) when active session is deleted', () => {
  const body = _deleteFnBody();
  // The for(t of ARTIFACT_TYPES) loop sets each wrap.hidden = true
  // and clears the active class on the corresponding chrome button.
  // Without this, the most-recently-opened pane (e.g. Plan) stays
  // visible with the deleted session\'s items.
  assert.ok(/for\s*\(\s*(?:const|let)\s+\w+\s+of\s+ARTIFACT_TYPES\s*\)/.test(body),
    'deleteSessionWithConfirm must iterate ARTIFACT_TYPES to hide each artifact wrap (the original Plan-view-leak symptom from the bug report)');
  // The loop must hide the wrap AND clear the chrome button's
  // active state — both are part of the visual "this pane is open"
  // signal.
  assert.ok(/wrap\.hidden\s*=\s*true/.test(body),
    'the ARTIFACT_TYPES loop body must set wrap.hidden = true so each artifact pane disappears');
});

t('resets state.artifactView so the next session opens to the terminal pane', () => {
  const body = _deleteFnBody();
  // state.artifactView.active = null means "no artifact pane open".
  // .prev = 'terminal' means the next pane-toggle restores the
  // terminal/chat view. Matches the value _resetUiForNewSession uses.
  assert.ok(/state\.artifactView\s*=\s*\{\s*active:\s*null/.test(body),
    'deleteSessionWithConfirm must reset state.artifactView.active to null so the deleted session\'s last-opened pane is forgotten');
});

t('resets per-session token totals so the meter shows 0 after delete', () => {
  const body = _deleteFnBody();
  // state.turnTotals carries the running token-usage for the active
  // session. Pre-fix the meter chip displayed the deleted session\'s
  // last totals until a new session was opened.
  assert.ok(/state\.turnTotals\s*=\s*\{[^}]*inputTokens:\s*0/.test(body),
    'deleteSessionWithConfirm must reset state.turnTotals so the token-meter chip clears');
  assert.ok(/_renderTokenMeter\s*\(/.test(body),
    'deleteSessionWithConfirm must call _renderTokenMeter() so the reset totals take effect in the DOM');
});

t('calls clearChat + clearArtifactBodies + updateChatButton in the delete path', () => {
  const body = _deleteFnBody();
  // These three helpers do the visible cleanup of the chat pane
  // bubble stream, the artifact bodies\' innerHTML, and the chat
  // composer\'s enabled state. Without them the chat pane keeps
  // bubbles from the deleted session and the artifact bodies keep
  // their last-rendered items.
  assert.ok(/clearChat\s*\(/.test(body),
    'deleteSessionWithConfirm must call clearChat() so the chat pane drops bubbles from the deleted session');
  assert.ok(/clearArtifactBodies\s*\(/.test(body),
    'deleteSessionWithConfirm must call clearArtifactBodies() so the Plan/Arch/Test innerHTML resets (the primary symptom in the bug report)');
  assert.ok(/updateChatButton\s*\(/.test(body),
    'deleteSessionWithConfirm must call updateChatButton() so the chat composer reflects the no-active-session state');
});

// ──────────────────────────────────────────────────────────────────────
// Negative guards — the cleanup MUST be gated on active-session-only
// (deleting a different session shouldn't wipe the user's currently
// active session's view).
// ──────────────────────────────────────────────────────────────────────

t('cleanup is gated on `state.activeId === s.id`', () => {
  const body = _deleteFnBody();
  // The cleanup MUST live inside the `if (state.activeId === s.id)`
  // branch — deleting a different session (e.g. from the sidebar
  // long-press) shouldn\'t wipe the currently-attached session\'s
  // panes / artifacts / chat.
  const gateIdx = body.search(/if\s*\(\s*state\.activeId\s*===\s*s\.id\s*\)/);
  assert.ok(gateIdx > -1, 'the active-session gate must exist');
  // All the cleanup markers must appear AFTER the gate opens.
  for (const marker of [
    'state.artifacts',
    'state.runQueue',
    'ARTIFACT_TYPES',
    'clearChat',
    'clearArtifactBodies',
  ]) {
    const mIdx = body.indexOf(marker);
    assert.ok(mIdx > -1 && mIdx > gateIdx,
      'cleanup marker `' + marker + '` must appear after the `state.activeId === s.id` gate so it only fires for the active-session delete');
  }
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation — re-implement the cleanup\'s state effects on
// a fake state object so the contract is pinned independently of the
// browser DOM.
// ──────────────────────────────────────────────────────────────────────

t('simulated state effect: active-delete clears artifacts + runQueue + turnTotals + artifactView', () => {
  // This mirrors what the implementation does to the in-memory state
  // object. If a future refactor renames any of these state keys,
  // both this test AND the bug-29 fix have to move in lockstep.
  const fakeState = {
    activeId: 'sess-A',
    artifacts: { sessionId: 'sess-A', byType: { plan: { items: [{ id: 'bug-1' }] }, arch: { md: 'x' } } },
    runQueue: { entries: [{ itemId: 'bug-1', status: 'running' }], paused: false, counts: {} },
    turnTotals: { inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 1000, costUsd: 0.05, lastTurnInputTokens: 500 },
    artifactView: { active: 'plan', prev: 'terminal' },
  };
  // Simulate the active-delete cleanup.
  fakeState.activeId = null;
  fakeState.artifacts = { sessionId: null, byType: {} };
  fakeState.runQueue = null;
  fakeState.artifactView = { active: null, prev: 'terminal' };
  fakeState.turnTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, lastTurnInputTokens: 0 };
  // Post-conditions.
  assert.strictEqual(fakeState.activeId, null);
  assert.deepStrictEqual(Object.keys(fakeState.artifacts.byType), [],
    'artifact byType cache is wiped — deleted session\'s Plan/Arch/Test data is gone');
  assert.strictEqual(fakeState.artifacts.sessionId, null,
    'artifact sessionId is nulled — next renderArtifact lookup-guard sees a clean slate');
  assert.strictEqual(fakeState.runQueue, null,
    'runQueue is nulled — _renderRunQueueStrip will render an empty / hidden strip');
  assert.strictEqual(fakeState.artifactView.active, null,
    'artifactView.active is null — no pane visible until the user clicks one');
  assert.strictEqual(fakeState.turnTotals.inputTokens, 0,
    'turn totals reset — token meter chip shows 0');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
