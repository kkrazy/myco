// bug-37 — Stop button stays enabled after the session has aborted or
// gone idle, even though the session status shows "aborted" / there's
// no ongoing claude activity.
//
// Three corner-case holes the user asked us to close:
//
//   1. Server emits `iteration_aborted` (user-Stop, kill-mid-stream,
//      stream-closed-no-result, AbortError) but never a follow-up
//      `turn_result`. The client's _updateAgentStatusStrip only
//      retires the Stop button on `turn_result` or `fatal`. → Stop
//      stays visible after every abort path.
//
//   2. The WS `{t:'exit'}` frame (server-side kill / reaper / SDK
//      process exit) only writes to xterm — it doesn't touch
//      `state.claudeStatusKind` or `state.awaitingClaude`. → Stop
//      stays visible after the session is fully gone.
//
//   3. The 30s idle fallback `_retireClaudeTyping` clears
//      `state.awaitingClaude` but leaves `state.claudeStatusKind` and
//      `state.claudeStatusLine` at their last values. Since the
//      Stop-show predicate is `visible && kind ∈ {thinking, running,
//      awaiting}` AND `visible = awaitingClaude || !!claudeStatusLine`,
//      a stale `claudeStatusLine` keeps `visible=true` AND a stale
//      `kind='thinking'` keeps showStop=true. → Stop stays after 30s
//      of dead air.
//
// Static-grep guards because the surface is browser-only client JS;
// the runtime fix is small and the predicate it changes is searchable.

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

console.log('── bug-37: Stop button retires on every "claude is done" path ──');

t('app.js: _updateAgentStatusStrip handles iteration_aborted (clears kind + label, no grace)', () => {
  // Anchor on the function definition so we don't match unrelated
  // sites elsewhere in app.js.
  const idx = APP.search(/function\s+_updateAgentStatusStrip\s*\(/);
  assert.ok(idx > -1, '_updateAgentStatusStrip must be defined');
  const win = sliceFn(APP, idx);
  // The branch must match ev.type === 'iteration_aborted' and clear
  // both kind + line so the Stop-show predicate flips false.
  assert.ok(/ev\.type === ['"]iteration_aborted['"]/.test(win),
    'bug-37: _updateAgentStatusStrip must handle ev.type === "iteration_aborted"');
  // Within the aborted branch (slice forward from the marker), must
  // null out claudeStatusKind so showStop drops the Stop button.
  const aIdx = win.search(/ev\.type === ['"]iteration_aborted['"]/);
  const aWin = win.slice(aIdx, aIdx + 600);
  assert.ok(/state\.claudeStatusKind\s*=\s*null/.test(aWin),
    'bug-37: iteration_aborted branch must set state.claudeStatusKind = null');
  assert.ok(/state\.claudeStatusLine\s*=\s*['"]{2}/.test(aWin) ||
            /state\.claudeStatusLine\s*=\s*['"]/.test(aWin),
    'bug-37: iteration_aborted branch must clear (or replace) state.claudeStatusLine');
});

t('app.js: WS t==="exit" frame clears claudeStatusKind (session ended → nothing to stop)', () => {
  // Anchor on the WS dispatch branch for exit frames. Pre-fix the
  // branch only wrote to the xterm — leaving the button stuck.
  const idx = APP.search(/msg\.t === ['"]exit['"]/);
  assert.ok(idx > -1, 'WS exit-frame branch must exist');
  // Search forward a generous window. The dispatch may live inside an
  // else-if chain; we look for the kind/awaiting clears within ~600 chars.
  const win = APP.slice(idx, idx + 600);
  assert.ok(/state\.claudeStatusKind\s*=\s*null/.test(win) ||
            /_retireClaudeTyping\s*\(/.test(win) ||
            /_updateAgentStatusStrip\s*\(\s*\{\s*type:\s*['"]iteration_aborted['"]/.test(win),
    'bug-37: t==="exit" frame must clear claudeStatusKind (directly, via _retireClaudeTyping, or by routing through iteration_aborted)');
});

t('app.js: _retireClaudeTyping clears claudeStatusKind + claudeStatusLine (not just awaitingClaude)', () => {
  // Pre-fix this function cleared awaitingClaude but left kind+line
  // pinned at their last values. Because the Stop predicate is
  //   visible = awaitingClaude || !!claudeStatusLine
  //   showStop = visible && kind ∈ {thinking,running,awaiting}
  // a stranded line + kind kept the button visible forever.
  const idx = APP.search(/function\s+_retireClaudeTyping\s*\(/);
  assert.ok(idx > -1, '_retireClaudeTyping must be defined');
  const win = sliceFn(APP, idx);
  assert.ok(/state\.awaitingClaude\s*=\s*false/.test(win),
    'sanity: _retireClaudeTyping must still clear awaitingClaude');
  // The fix must additionally clear kind + line so the 30s idle
  // fallback truly retires the Stop button.
  assert.ok(/state\.claudeStatusKind\s*=\s*null/.test(win),
    'bug-37: _retireClaudeTyping must set state.claudeStatusKind = null');
  assert.ok(/state\.claudeStatusLine\s*=\s*['"]{2}/.test(win) ||
            /state\.claudeStatusLine\s*=\s*['"]/.test(win),
    'bug-37: _retireClaudeTyping must clear state.claudeStatusLine');
});

t('app.js: fatal branch retires the red/error strip after a grace (bug-92 — stop stays red)', () => {
  // bug-92: a fatal outcome (incl. an abort surfacing as an error
  // rather than AbortError) set claudeStatusKind='error' + awaitingClaude
  // with NO timer — the RED '.claude-typing-error' strip stayed forever
  // ("stop点了还是红色"). The fatal branch must now arm the shared
  // _agentStatusGraceTimer and null claudeStatusKind when it fires.
  const idx = APP.search(/function\s+_updateAgentStatusStrip\s*\(/);
  assert.ok(idx > -1, '_updateAgentStatusStrip must be defined');
  const win = sliceFn(APP, idx);
  const fIdx = win.search(/ev\.type === ['"]fatal['"]/);
  assert.ok(fIdx > -1, 'fatal branch must exist');
  const fWin = win.slice(fIdx, fIdx + 1000);
  assert.ok(/state\.claudeStatusKind\s*=\s*['"]error['"]/.test(fWin),
    'bug-92: fatal branch still sets claudeStatusKind = "error"');
  assert.ok(/_agentStatusGraceTimer\s*=\s*setTimeout\(/.test(fWin),
    'bug-92: fatal branch must arm _agentStatusGraceTimer so the red strip is not stuck forever');
  assert.ok(/state\.claudeStatusKind\s*=\s*null/.test(fWin) &&
            /_retireClaudeTyping\s*\(\s*\)\s*;/.test(fWin),
    'bug-92: the armed timer must null claudeStatusKind + call _retireClaudeTyping()');
});

t('app.js: _applyStateUpdate handles kind==="claude-running" and retires on idle', () => {
  // Refresh-stale-status fix: on a fresh attach the status strip is
  // rebuilt from the agent-event replay, and a replay tail ending on a
  // non-terminal event (assistant_text after an aborted turn, or a
  // chrome event older than the 16 KB replay window) wrongly leaves the
  // Stop button "running" even though the agent is idle. The server
  // ships the authoritative live-turn state via kind="claude-running";
  // the client must retire the strip when it reports idle.
  const idx = APP.search(/msg\.kind === ['"]claude-running['"]/);
  assert.ok(idx > -1, '_applyStateUpdate must handle kind === "claude-running"');
  // delm-10 widened this window: the handler now also mirrors the
  // frame into state.claudeRunning (both polarities) before the
  // idle-branch retire, so the original checks need a slightly
  // larger window to still see them.
  const win = APP.slice(idx, idx + 1200);
  assert.ok(/msg\.running === false/.test(win),
    'claude-running: must branch on running === false');
  assert.ok(/_retireClaudeTyping\s*\(\s*\)/.test(win),
    'claude-running: must call _retireClaudeTyping() when running === false so stale "stop" is cleared');
});

t('server: _sendAttachSnapshot ships an authoritative claude-running frame (refresh-stale-stop regression)', () => {
  // The client relies on this frame (sent AFTER the replay) to decide
  // whether the Stop button should actually show on a fresh attach. If
  // this ship is removed, an idle session whose replay tail is
  // non-terminal shows a phantom "stop" after F5.
  const ATTACH = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  const idx = ATTACH.search(/kind: ['"]claude-running['"]/);
  assert.ok(idx > -1, 'attach.js must ship state-update kind="claude-running"');
  const win = ATTACH.slice(idx - 900, idx + 400);
  // working-status fix (2026-10-23): the running payload prefers
  // session.isBusy() (honors agent-n2 TeamSessions, which have no
  // _currentQuery slot) and falls back to !!session._currentQuery for
  // plain AgentSessions — same busy contract as _handleInterrupt.
  assert.ok(/typeof session\.isBusy === ['"]function['"]/.test(win),
    'claude-running: running must prefer session.isBusy() — a TeamSession has no _currentQuery so the old read always reported idle');
  assert.ok(/!!session\.isBusy\(\)/.test(win) && /!!session\._currentQuery/.test(win),
    'claude-running: busy branch isBusy(), fallback branch _currentQuery (authoritative live-turn state)');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
