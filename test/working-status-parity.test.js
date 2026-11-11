// Working/status display regression (task 2a, 2026-10-23).
//
// Four user-visible working-status defects, each locked below:
//   1. agent-n2 team sessions never showed the sidebar "working" /
//      "to review" badges — TeamSession exposed neither isBusy() nor
//      _lastDoneAt, while GET /sessions reads both off the live session.
//   2. state.teamView.laneEnded was initialized false and NEVER set
//      true anywhere, so after a shadow lane's row was deleted the
//      composer Stop / HUD Stop kept rendering and kept sending
//      interrupts at a dead lane (gates: active && teamLane &&
//      !laneEnded).
//   3. The HUD elapsed-timer interval captured the FIRST render's
//      getElapsedStr closure — a second queued task showed the first
//      task's growing clock (stale closure).
//   4. A late claude-status frame after the turn retired could re-arm
//      the typing strip + Stop against an idle session.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const TEAM = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'team-session.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');

const { sliceFn, fnBody } = require('./_lib/fn-body');

console.log('── working-status parity (task 2a) ──');

// ── 1. TeamSession busy/review parity ─────────────────────────────

t('TeamSession declares _lastDoneAt (initialized null)', () => {
  assert.ok(/this\._lastDoneAt\s*=\s*null;/.test(TEAM),
    'TeamSession must initialize this._lastDoneAt = null — GET /sessions reads live._lastDoneAt for the "to review" badge');
});

t('TeamSession.isBusy() aggregates its workers', () => {
  const body = fnBody(TEAM, /isBusy\(\)\s*\{/);
  assert.ok(/this\.roster\.some\(/.test(body),
    'TeamSession.isBusy() must return true while ANY worker is iterating — roster.some(worker.isBusy())');
  assert.ok(/w\.isBusy\(\)/.test(body),
    'TeamSession.isBusy() must consult each worker\'s isBusy()');
});

t('TeamSession._relay stamps _lastDoneAt on terminal events', () => {
  const body = fnBody(TEAM, /_relay\(actor,\s*event\)\s*\{/);
  assert.ok(/_lastDoneAt\s*=\s*Date\.now\(\)/.test(body),
    '_relay must stamp this._lastDoneAt = Date.now() on turn_result/iteration_aborted/fatal — same contract as AgentSession._emit');
  assert.ok(/turn_result/.test(body) && /iteration_aborted/.test(body) && /fatal/.test(body),
    'the terminal-event set in _relay must match AgentSession._emit\'s (turn_result | iteration_aborted | fatal)');
});

t('GET /sessions agentBusy read stays contract-compatible with TeamSession', () => {
  assert.ok(/s\.agentBusy\s*=\s*!!\(\s*live\s*&&\s*typeof\s+live\.isBusy\s*===\s*'function'\s*&&\s*live\.isBusy\(\)\s*\)/.test(INDEX),
    'index.js must keep the guarded live.isBusy() read — now satisfied by TeamSession.isBusy() too');
});

// ── 2. laneEnded lifecycle ────────────────────────────────────────

t('_handleTeamLaneEnd sets laneEnded = true (Stop gates die with the lane)', () => {
  const body = fnBody(APP, /function _handleTeamLaneEnd\(msg\)\s*\{/);
  assert.ok(/state\.teamView\.laneEnded\s*=\s*true;/.test(body),
    'lane end must flip state.teamView.laneEnded = true — pre-fix it was never set true anywhere so Stop stayed live');
});

t('_handleTeamInfoFrame re-arms laneEnded = false for a NEW lane', () => {
  const body = fnBody(APP, /function _handleTeamInfoFrame\(msg\)\s*\{/);
  assert.ok(/laneEnded\s*=\s*false/.test(body),
    'a new (non-ended) team-info frame must reset laneEnded to false or the Stop gates stay dead after a re-run');
  assert.ok(/msg\.teamLane\s*&&\s*!msg\.ended/.test(body),
    'the reset must be gated on teamLane && !ended — an ended:true re-announce keeps laneEnded true');
});

t('the lane-running predicates still read !state.teamView.laneEnded', () => {
  assert.ok(/active && state\.teamView\.teamLane && !state\.teamView\.laneEnded/.test(APP),
    'the Stop-gate predicate shape (active && teamLane && !laneEnded) must be preserved');
});

// ── 3. HUD elapsed-timer stale closure ────────────────────────────

t('HUD timer recomputes elapsed from the CURRENT running queue entry', () => {
  const idx = APP.indexOf('_hudTimerInterval = setInterval');
  assert.ok(idx > -1, 'the HUD timer interval must exist');
  const body = APP.slice(idx, idx + 1400);
  assert.ok(/state\.runQueue/.test(body),
    'the interval callback must re-read state.runQueue — pre-fix it used the captured getElapsedStr closure and showed the previous task\'s clock');
  assert.ok(/e\.status === 'running'/.test(body),
    'the callback must find the CURRENT running entry (status === "running")');
});

// ── 4. late claude-status frame cannot resurrect a retired strip ──

t('_setClaudeStatusLine drops activity frames once the strip is fully retired', () => {
  const body = fnBody(APP, /function _setClaudeStatusLine\(text,\s*structured\)\s*\{/);
  assert.ok(/!state\.awaitingClaude\s*&&\s*!state\.claudeRunning\s*&&\s*!state\._spinnerSeen/.test(body),
    'the gate must require awaitingClaude + claudeRunning + _spinnerSeen all false before dropping a trimmed activity frame');
  assert.ok(/return;/.test(body),
    'the gate must early-return (drop the frame) instead of re-arming the strip');
});

process.on('exit', (code) => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : code;
});
