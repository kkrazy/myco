// bug-53 (dispatch-label-mislabeled-as-bug-52 by the user but td-33
// already shipped bug-52): HUD status indicator was stuck on
// "Analyze" most of the time during edits + test runs.
//
// User-reported (verbatim, /run dispatch from @labxnow):
//   Problem:  The HUD status indicator does not reflect what the
//             agent is actually doing, making progress unreadable.
//   Expected: Status transitions to match the active phase (e.g.
//             editing code, running tests) in real time.
//   Actual:   Status sits on "analyze" most of the time while edits
//             are being applied and tests are running, and only
//             occasionally flickers between "analyze", "code", and
//             "test".
//
// Root cause (diagnosed in this session, from the live mycodev
// behavior):
//   1. _getHUDActiveStep() in app.js read ONLY state.openToolCalls
//      (tools IN-FLIGHT right now), then defaulted to 'Analyze'.
//      Between tool calls — which is most of the wall-clock time
//      (claude reads, writes, runs tests in sequential bursts with
//      brief gaps) — openToolCalls is EMPTY → fallback to 'Analyze'.
//   2. The tool-progress WS handler did NOT call _updateTaskHUD()
//      — it only called _renderClaudeTyping() (the typing-strip).
//      So even when openToolCalls DID change, the HUD's active-chip
//      didn't re-render until some unrelated state-update fired.
//      Result: the chip flickered occasionally + sat on whatever
//      stale value the last state-update saw.
//
// Fix:
//   1. Add state.lastToolPhase as a sticky tracker. Set to 'verify'
//      when a Bash tool opens; set to 'code' when Edit/Write/
//      MultiEdit opens AND we're not already in 'verify' this turn
//      (once we're running tests, follow-up edits are test fixes —
//      stay in 'verify'). Reset on turn_start (next turn starts
//      fresh in 'Analyze').
//   2. tool-progress handler now calls _updateTaskHUD() so the chip
//      reflects open-tool changes immediately.
//   3. _getHUDActiveStep() falls back to state.lastToolPhase (with
//      'verify' / 'code' / null priority) BEFORE defaulting to
//      'Analyze'.
//
// Test shape: static-grep on the locked surface.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── bug-53: HUD status stuck on "Analyze" between tool calls ──');

t('web/public/app.js: state.lastToolPhase is initialized in the state object', () => {
  const app = _read('web/public/app.js');
  assert.ok(/lastToolPhase\s*:\s*null/.test(app),
    'state.lastToolPhase must be initialized to null in the state object (bug-53 — sticky tracker for the HUD chip).');
});

t('web/public/app.js: tool-progress handler updates state.lastToolPhase based on open tools', () => {
  const app = _read('web/public/app.js');
  // Find the tool-progress handler — it sits inside the state-update
  // dispatcher (handleStateUpdate-style function). Slice from
  // `msg.kind === 'tool-progress'` window.
  const at = app.search(/msg\.kind\s*===\s*['"]tool-progress['"]/);
  assert.ok(at > -1, 'tool-progress handler must exist.');
  const body = app.slice(at, at + 2500);
  assert.ok(/lastToolPhase\s*=\s*['"]verify['"]/.test(body),
    'tool-progress handler must set state.lastToolPhase = "verify" when a Bash tool is open (bug-53).');
  assert.ok(/lastToolPhase\s*=\s*['"]code['"]/.test(body),
    'tool-progress handler must set state.lastToolPhase = "code" when an Edit/Write/MultiEdit tool is open (bug-53).');
});

t('web/public/app.js: tool-progress handler calls _updateTaskHUD() so the chip re-renders immediately', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/msg\.kind\s*===\s*['"]tool-progress['"]/);
  const body = app.slice(at, at + 2500);
  assert.ok(/_updateTaskHUD\s*\(\s*\)/.test(body),
    'tool-progress handler must call _updateTaskHUD() so the active-chip reflects the new open-tool set immediately (bug-53 — without this, the chip only re-rendered on unrelated state-updates).');
});

t('web/public/app.js: _getHUDActiveStep falls back to state.lastToolPhase when no tools are open', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/function\s+_getHUDActiveStep\s*\(/);
  assert.ok(at > -1, '_getHUDActiveStep must exist.');
  const body = sliceFn(app, at);
  assert.ok(/lastToolPhase\s*===\s*['"]verify['"]/.test(body),
    '_getHUDActiveStep must check state.lastToolPhase === "verify" for sticky-fallback (bug-53).');
  assert.ok(/lastToolPhase\s*===\s*['"]code['"]/.test(body),
    '_getHUDActiveStep must check state.lastToolPhase === "code" for sticky-fallback (bug-53).');
  // The fallback must come BEFORE the 'Analyze' return — otherwise
  // we never reach it.
  const verifyCheckAt = body.search(/lastToolPhase\s*===\s*['"]verify['"]/);
  const analyzeReturnAt = body.lastIndexOf("return 'Analyze'");
  assert.ok(verifyCheckAt > -1 && analyzeReturnAt > -1 && verifyCheckAt < analyzeReturnAt,
    'the lastToolPhase fallback check must appear BEFORE the final `return "Analyze"` line — otherwise the sticky-phase is unreachable (bug-53).');
});

t('web/public/app.js: turn_start agent event resets state.lastToolPhase to null', () => {
  const app = _read('web/public/app.js');
  // The reset lives in _appendAgentEvent's turn_start branch.
  const at = app.search(/function\s+_appendAgentEvent\s*\(/);
  assert.ok(at > -1, '_appendAgentEvent must exist.');
  const body = sliceFn(app, at);
  assert.ok(/turn_start[\s\S]{0,200}lastToolPhase\s*=\s*null/.test(body) ||
            /lastToolPhase\s*=\s*null[\s\S]{0,200}turn_start/.test(body),
    '_appendAgentEvent must reset state.lastToolPhase = null on turn_start so each new turn begins in "Analyze" (bug-53 — guards against a stale phase from the previous turn leaking in).');
});

t('a comment naming "bug-53" appears in app.js explaining the sticky-phase plumbing', () => {
  const app = _read('web/public/app.js');
  assert.ok(/bug-53/.test(app),
    'a comment naming "bug-53" must appear in app.js so a future restyle understands why the HUD reads state.lastToolPhase.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
