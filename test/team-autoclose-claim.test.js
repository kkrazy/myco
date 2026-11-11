// team-autoclose-claim (2026-10-30) — 看板 items stuck un-ticked regression.
//
// User report: "任务都完成了，界面打印完成，但共享看板任务有些还没打勾"
// (tasks all finished, the interface printed completion, but some shared-
// board items were still un-ticked). Root cause: a worker ends a SUCCESS
// turn without calling mcp__board__done — its claim stays ◐ forever and
// team-complete can never fire (queueState() sees a non-done item).
//
// Fix (server/src/team-session.js): on worker idle, _autoCloseStaleClaim
// closes any claim the worker still holds IF its last turn_result was a
// success, using a one-line summary from the turn's final text. Failed
// turns leave the claim alone (the work may be incomplete).
//
// Run: node test/team-autoclose-claim.test.js

'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { TeamSession } = require('../server/src/team-session.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-autoclose-'));
}

function makeTeam(id) {
  const dir = tmpdir();
  const cwd = path.join(dir, 'wks');
  fs.mkdirSync(cwd, { recursive: true });
  const team = new TeamSession(id, { cwd, task: 'T', eventsDir: dir });
  // stub writes so no live SDK query happens
  team.workers['worker-A'].write = () => {};
  team.workers['worker-B'].write = () => {};
  return team;
}

async function main() {
  console.log('── team-autoclose-claim: 看板 ✓ on idle after a success turn ──');

  await t('idle after a SUCCESS turn auto-closes the worker\'s stale claim', () => {
    const team = makeTeam('ac-1');
    const r = team.board.reserve('worker-A', 'Fix parser', 'write parser');
    // Simulate a finished success turn: the worker printed completion
    // but never called mcp__board__done.
    team.workers['worker-A']._lastTurnResult = {
      subtype: 'success',
      result: 'Parser fixed and all tests pass.\nLonger detail follows.',
    };
    team.workers['worker-A'].emit('idle');
    const item = team.board.queueState().find((i) => i.id === r.item);
    assert.strictEqual(item.state, 'done',
      'claim must flip to done (✓) when the worker idles after a success turn');
    assert.ok(item.summary.startsWith('auto-closed on idle: Parser fixed and all tests pass.'),
      'summary carries the auto-close prefix + first line of the turn result; got: ' + item.summary);
    team.kill();
  });

  await t('idle after a FAILED turn leaves the claim untouched', () => {
    const team = makeTeam('ac-2');
    const r = team.board.reserve('worker-A', 'Flaky fix', 'try a fix');
    team.workers['worker-A']._lastTurnResult = {
      subtype: 'error_during_execution', result: 'something broke',
    };
    team.workers['worker-A'].emit('idle');
    const item = team.board.queueState().find((i) => i.id === r.item);
    assert.strictEqual(item.state, 'claimed',
      'a failed turn must NOT auto-close — the work may be incomplete');
    team.kill();
  });

  await t('idle with no turn result yet leaves the claim untouched', () => {
    const team = makeTeam('ac-3');
    const r = team.board.reserve('worker-B', 'Early claim', 'do work');
    // no _lastTurnResult at all — turn never ended
    team.workers['worker-B'].emit('idle');
    const item = team.board.queueState().find((i) => i.id === r.item);
    assert.strictEqual(item.state, 'claimed',
      'no recorded turn result → no basis to auto-close; claim stays');
    team.kill();
  });

  await t('auto-close lets team-complete fire when the queue would otherwise stick', () => {
    const team = makeTeam('ac-4');
    let complete = 0;
    team.on('team-complete', () => complete++);
    const r1 = team.board.reserve('worker-A', 'Part 1', 'do part 1');
    const r2 = team.board.reserve('worker-B', 'Part 2', 'do part 2');
    // worker-B calls done properly; worker-A forgets (the reported bug).
    team.board.done('worker-B', r2.item, 'part 2 done');
    team.workers['worker-B']._lastTurnResult = { subtype: 'success', result: 'part 2 ok' };
    team.workers['worker-A']._lastTurnResult = { subtype: 'success', result: 'part 1 ok' };
    team.workers['worker-A'].emit('idle');
    team.workers['worker-B'].emit('idle');
    assert.strictEqual(complete, 1,
      'team-complete must fire — the forgotten done() is auto-closed, queue unblocked');
    team.kill();
  });

  await t('auto-close never fires for another worker\'s claim', () => {
    const team = makeTeam('ac-5');
    const r = team.board.reserve('worker-A', 'A owns this', 'a work');
    // worker-B goes idle with a SUCCESS turn — worker-A's claim must stay.
    team.workers['worker-B']._lastTurnResult = { subtype: 'success', result: 'b done' };
    team.workers['worker-B'].emit('idle');
    const item = team.board.queueState().find((i) => i.id === r.item);
    assert.strictEqual(item.state, 'claimed',
      'only the claim-holding worker\'s idle closes its own claim');
    assert.strictEqual(item.owner, 'worker-A', 'ownership unchanged');
    team.kill();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
