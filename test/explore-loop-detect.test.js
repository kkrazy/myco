// explore-loop-detect — run-explore strategy-switching + interactive-step
// ledger (§5.1/§5.2 of docs/arch/agents/explore/run-explore.md). Two layers:
//   (1) ExploreLoopDetector unit behaviour — same-action loop detection
//       (>10 consecutive identical tool_use with no successful result →
//       strategy switch), cooldown, board-progress reset, step ledger,
//       report summaries + flushLedger.
//   (2) TeamSession wiring (explore lane) — a stuck explorer receives the
//       injected corrective prompt; the n2 path is untouched.
//
// The unit layer needs no SDK and performs no I/O except an explicit
// flushLedger(dir) call. The wiring layer stubs workers exactly like
// team-session.test.js / explore-lane.test.js (no live SDK connections).

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { ExploreLoopDetector } = require(path.join(ROOT, 'server/src/explore-loop-detect.js'));
const { TeamSession } = require(path.join(ROOT, 'server/src/team-session.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'explore-loop-')); }

function det(opts) { return new ExploreLoopDetector(Object.assign({ switchCooldownMs: 0, maxSwitches: 5 }, opts)); }

async function main() {
  console.log('── explore-loop-detect: strategy-switching + step ledger ──');

  // ---- unit: same-action loop detection ---------------------------------
  await t('same action repeated >= threshold with no result → strategy switch', () => {
    const d = det({ threshold: 10 });
    let first = null; let streakAtFire = 0;
    for (let i = 0; i < 12; i++) {
      const decided = d.observe('path-1', { type: 'tool_use', name: 'Read', ts: 't' + i });
      if (decided && !first) { first = decided; streakAtFire = decided.streak; }
    }
    assert.ok(first, 'a decision is emitted after 12 same-action uses');
    assert.strictEqual(first.worker, 'path-1', 'decision targets path-1');
    assert.ok(streakAtFire >= 10, `decision fires at the threshold streak (got ${streakAtFire})`);
  });

  await t('successful tool_result resets the streak (legit repeated reads not flagged)', () => {
    const d = det({ threshold: 3 });
    let decided = null;
    for (let i = 0; i < 8; i++) {
      d.observe('path-1', { type: 'tool_use', name: 'Read', ts: 't' + i });
      decided = d.observe('path-1', { type: 'tool_result', isError: false, ts: 'r' + i });
    }
    assert.strictEqual(decided, null, 'no switch when every same-action call resolves');
  });

  await t('ERROR tool_result does NOT reset the streak (repeating a failing action = stuck)', () => {
    const d = det({ threshold: 5 });
    let fired = 0;
    for (let i = 0; i < 8; i++) {
      const u = d.observe('path-1', { type: 'tool_use', name: 'mcp__board__read', ts: 't' + i });
      const r = d.observe('path-1', { type: 'tool_result', isError: true, ts: 'r' + i });
      if (u || r) fired += 1;
    }
    assert.ok(fired >= 1, 'erroring same-action loop does trigger a switch');
  });

  await t('changing action restarts the count', () => {
    const d = det({ threshold: 3 });
    let fired = 0;
    for (let i = 0; i < 2; i++) {
      const u = d.observe('path-1', { type: 'tool_use', name: 'A', ts: i });
      if (u) fired += 1;
    }
    // switch to B → count restarts at 1, NOT a loop yet
    const b1 = d.observe('path-1', { type: 'tool_use', name: 'B', ts: 9 });
    assert.strictEqual((fired + (b1 ? 1 : 0)), 0, 'a different action is NOT a loop');
    const b2 = d.observe('path-1', { type: 'tool_use', name: 'B', ts: 10 });
    const b3 = d.observe('path-1', { type: 'tool_use', name: 'B', ts: 11 }); // 3rd B → threshold
    if (b1 || b2 || b3) fired += 1;
    assert.ok(fired >= 1, 'loop on the new action is still caught');
  });

  await t('turn_result resets the streak', () => {
    const d = det({ threshold: 3 });
    for (let i = 0; i < 2; i++) d.observe('path-1', { type: 'tool_use', name: 'X', ts: i });
    d.observe('path-1', { type: 'turn_result', ts: 't' }); // completed turn = progress
    let decided = d.observe('path-1', { type: 'tool_use', name: 'X', ts: 9 }); // count=1 again
    assert.strictEqual(decided, null, 'turn_result clears the same-action streak');
  });

  await t('cooldown prevents immediate re-switch spam', () => {
    const d = det({ threshold: 2, switchCooldownMs: 60000 });
    let decided = null;
    for (let i = 0; i < 4; i++) {
      d.observe('path-1', { type: 'tool_use', name: 'L', ts: i });
      d.observe('path-1', { type: 'tool_use', name: 'L', ts: i });
      decided = d.observe('path-1', { type: 'tool_use', name: 'L', ts: i });
    }
    const switches = d.switchLog().length;
    assert.ok(switches >= 1, 'first switch fires');
    assert.strictEqual(switches, 1, 'cooldown blocks a second switch within the window');
  });

  await t('maxSwitches caps total corrections per worker', () => {
    const d = det({ threshold: 2, switchCooldownMs: 0, maxSwitches: 2 });
    // Force switches by cycling actions so each new action can loop.
    for (let round = 0; round < 6; round++) {
      const name = 'act' + (round % 3);
      for (let i = 0; i < 3; i++) d.observe('path-1', { type: 'tool_use', name, ts: round + '-' + i });
    }
    assert.ok(d.switchLog().length <= 2, `capped at maxSwitches (got ${d.switchLog().length})`);
  });

  await t('onBoardProgress clears a stuck worker streak', () => {
    const d = det({ threshold: 5 });
    for (let i = 0; i < 6; i++) d.observe('path-1', { type: 'tool_use', name: 'W', ts: i });
    d.onBoardProgress('path-1'); // posted to the board → moving, not stuck
    const decided = d.observe('path-1', { type: 'tool_use', name: 'W', ts: 99 });
    assert.strictEqual(decided, null, 'board progress resets the streak');
  });

  // ---- unit: interactive-step ledger ------------------------------------
  await t('ledger records steps and flushLedger writes steps-<actor>.jsonl', () => {
    const d = det();
    d.observe('path-1', { type: 'tool_use', name: 'Read', ts: 'a' });
    d.observe('path-1', { type: 'tool_result', isError: false, ts: 'b' });
    d.observe('path-1', { type: 'turn_result', ts: 'c', result: 'x' });
    const dir = tmpdir();
    const files = d.flushLedger(dir);
    assert.strictEqual(files.length, 1, 'one ledger file written');
    assert.ok(files[0].endsWith('steps-path-1.jsonl'), 'file named steps-<actor>.jsonl');
    const raw = fs.readFileSync(files[0], 'utf8');
    const rows = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.strictEqual(rows.length, 3, 'all 3 steps persisted');
    assert.strictEqual(rows[0].name, 'Read', 'tool name in ledger');
    assert.strictEqual(rows[1].ok, true, 'successful result recorded');
  });

  await t('reportSummaries exposes per-action call/error counts (partial-goal verification)', () => {
    const d = det();
    d.observe('path-1', { type: 'tool_use', name: 'Bash', ts: '1' });
    d.observe('path-1', { type: 'tool_result', isError: false, ts: '2' });
    d.observe('path-1', { type: 'tool_use', name: 'Bash', ts: '3' });
    d.observe('path-1', { type: 'tool_result', isError: true, ts: '4' });
    const s = d.reportSummaries()['path-1'];
    assert.ok(s, 'worker summary present');
    assert.strictEqual(s.toolUse, 2, 'two tool uses counted');
    assert.strictEqual(s.actions['Bash'].calls, 2, 'Bash called twice');
    assert.strictEqual(s.actions['Bash'].errors, 1, 'Bash errored once');
    assert.strictEqual(s.errorResults, 1, 'one error result');
  });

  // ---- integration: TeamSession explore wiring ---------------------------
  await t('stuck explore worker receives the injected strategy-switch prompt', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('exp-loop', { cwd, task: 'HardTask', eventsDir: dir, explore: true, roster: ['path-1', 'path-2'] });
    const writes = [];
    team.workers['path-1'].write = (txt) => writes.push(txt);
    // Drive 20 same-action tool_use with no result through _relay (the
    // path every worker event takes).
    for (let i = 0; i < 20; i++) {
      team._relay('path-1', { type: 'tool_use', name: 'Read', ts: 't' + i });
    }
    assert.ok(writes.length >= 1, 'a corrective prompt was injected into path-1');
    assert.ok(writes[0].includes('Strategy switch'), 'prompt tells the worker to switch strategy');
    assert.ok(writes[0].includes('HardTask'), 'prompt includes the authoritative task');
    team.kill();
  });

  await t('n2 team builds NO loop detector (n2 path untouched — §6 followup)', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('exp-n2', { cwd, task: 'T', eventsDir: dir }); // no explore
    assert.strictEqual(team.exploreLoopDetector, null, 'n2 team has no loop detector (bytes identical)');
    team.kill();
  });

  await t('explore report includes interactiveSteps + strategySwitches', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('exp-rep', { cwd, task: 'T', eventsDir: dir, explore: true, roster: ['path-1', 'path-2'] });
    team.workers['path-1'].write = () => {};
    for (let i = 0; i < 14; i++) team._relay('path-1', { type: 'tool_use', name: 'Read', ts: i });
    const cl = require(path.join(ROOT, 'server/src/compare-lanes.js'));
    const report = cl.buildExploreReport({ task: 'T', startedAt: new Date().toISOString() }, {
      lane: team,
      id: 'exp-rep', dir, harnessKey: 'explore-task-x', roster: ['path-1', 'path-2'],
      startedAt: Date.now(), endedAt: Date.now() + 1000,
    });
    assert.ok(report.summary.strategySwitches.length >= 1, 'switch log surfaced in report');
    assert.ok(report.summary.interactiveSteps && report.summary.interactiveSteps['path-1'],
      'interactive step ledger per worker surfaced in report');
    assert.strictEqual(report.summary.interactiveSteps['path-1'].toolUse, 14, 'step counts in report');
    team.kill();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
