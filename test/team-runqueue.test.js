// Delm n=2 run-queue integration (P5).
//
// Verifies the team path wired between sessions.getOrCreateTeamSession
// and attach.js's run-queue:
//   1. getOrCreateTeamSession builds + registers a TeamSession, pins
//      rec.mode='agent-n2', persists rec.sdkSessions, and wires the
//      team's run-queue terminal handling (_wireTeamRunQueue).
//   2. A `[run:plan#X]` dispatch on the team fans out to BOTH workers
//      (dispatchTask), not just worker-A (write).
//   3. team-complete (board sub-queue drained + both workers idle) is
//      the run's success terminal: it synthesizes a turn_result, stamps
//      the plan item's runs[] + run-summary comment, marks the finished
//      queue entry success, and auto-dispatching the next pending item
//      to the team.
//   4. team-failed (team torn down mid-run) marks the running entry
//      failed + auto-pauses the queue.
//
// No live SDK query happens: the workers' .write are stubbed to spies
// and the team terminal is driven by emitting team-complete/team-failed.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-run-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
const wks = process.env.MYCO_WORKSPACE;
fs.mkdirSync(wks, { recursive: true });
fs.mkdirSync(path.join(wks, '_myco_'), { recursive: true });

// Allow-list a known user so requiring attach.js (authMod) is happy.
fs.writeFileSync(
  path.join(process.env.MYCO_STATE_DIR, 'allowed-github-users.txt'),
  '# test fixture\nkkrazy\n',
);

const sessionsMod = require('../server/src/sessions');
const attach = require('../server/src/attach');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function seedSession(sid, planItems, runQueue) {
  const store = sessionsMod.loadStore();
  store.sessions = store.sessions || {};
  store.sessions[sid] = {
    id: sid,
    user: 'kkrazy',
    cwd: '.',
    absCwd: wks,
    createdAt: new Date().toISOString(),
    chat: [],
    artifacts: { plan: { items: planItems, updatedAt: null } },
    runQueue: runQueue || [],
    runQueuePaused: false,
  };
  sessionsMod.saveStore();
}

function planItem(id, text) {
  return { id, text, layer: 'Backend', done: false, voters: [], comments: [] };
}

// Build a TeamSession via getOrCreateTeamSession, then stub each worker's
// .write to a spy so no live SDK query happens and we can assert the
// fan-out / routing.
async function makeTeam(sid, rec, spies) {
  const team = await sessionsMod.getOrCreateTeamSession(sid, rec);
  team.workers['worker-A'].write = (txt) => spies['worker-A'].push(txt);
  team.workers['worker-B'].write = (txt) => spies['worker-B'].push(txt);
  return team;
}

async function main() {
  console.log('── Delm n=2 run-queue integration ──');

  await t('getOrCreateTeamSession builds a team, pins mode, persists sdkSessions', async () => {
    const sid = 'sess-team-1';
    const rec = seedSession(sid, [planItem('td-a', 'a')], []);
    const team = await sessionsMod.getOrCreateTeamSession(sid, sessionsMod.getSessionRecord(sid));
    try {
      assert.ok(team, 'team returned');
      assert.strictEqual(team.mode, 'agent-n2', 'team mode');
      assert.ok(team.workers['worker-A'] && team.workers['worker-B'], 'two workers');
      assert.strictEqual(attach.getSession(sid), team, 'registered via attach sessions map');
      const saved = sessionsMod.getSessionRecord(sid);
      assert.strictEqual(saved.mode, 'agent-n2', 'rec.mode pinned');
      assert.ok(saved.sdkSessions && 'worker-A' in saved.sdkSessions && 'worker-B' in saved.sdkSessions,
        'rec.sdkSessions has both workers');
      assert.strictEqual(team._runQueueWired, true, 'run-queue terminal wired by getOrCreateTeamSession');
      // Reuse on a second call returns the same team.
      const again = await sessionsMod.getOrCreateTeamSession(sid, saved);
      assert.strictEqual(again, team, 'reuse returns the live team');
    } finally {
      team.kill();
    }
  });

  await t('run dispatch on a team fans out to BOTH workers (dispatchTask, not write)', async () => {
    const sid = 'sess-team-2';
    const item = planItem('td-1', 'implement pager');
    seedSession(sid, [item], []);
    const spies = { 'worker-A': [], 'worker-B': [] };
    const team = await makeTeam(sid, sessionsMod.getSessionRecord(sid), spies);
    try {
      attach.handleChatMessage(sid, team, 'kkrazy', '[run:plan#td-1] implement the cursor pager');
      // Real-time chat (non-run) routes to worker-A ONLY; run dispatch
      // goes to both. Check the run dispatch hit both.
      assert.ok(spies['worker-A'].some((x) => x.includes('[run:plan#td-1]')), 'worker-A got the run dispatch');
      assert.ok(spies['worker-B'].some((x) => x.includes('[run:plan#td-1]')), 'worker-B got the run dispatch (dispatchTask)');
      assert.strictEqual(team._activeRunItem && team._activeRunItem.itemId, 'td-1', 'active run item set');
      const saved = sessionsMod.getSessionRecord(sid);
      const stamped = saved.artifacts.plan.items.find((it) => it.id === 'td-1');
      assert.ok(stamped.runs && stamped.runs[stamped.runs.length - 1].status === 'running',
        'plan item stamped running on dispatch');
    } finally {
      team.kill();
    }
  });

  // bug fix (worker-B panel never reacts): the FIRST chat write on a team
  // dispatches to BOTH workers (worker-B has no SDK iteration until it is
  // written — without this its panel sat blank on chat-driven tasks).
  // Follow-up chat routes to worker-A only.
  await t('first chat dispatches to both workers; follow-up chat routes to worker-A only', async () => {
    const sid = 'sess-team-3';
    seedSession(sid, [], []);
    const spies = { 'worker-A': [], 'worker-B': [] };
    const team = await makeTeam(sid, sessionsMod.getSessionRecord(sid), spies);
    try {
      attach.handleChatMessage(sid, team, 'kkrazy', 'solve this task');
      assert.ok(spies['worker-A'].includes('solve this task'), 'worker-A gets the task');
      assert.ok(spies['worker-B'].includes('solve this task'), 'worker-B gets the task (dispatch — its panel must start)');
      attach.handleChatMessage(sid, team, 'kkrazy', 'hello from the user');
      assert.ok(spies['worker-A'].includes('hello from the user'), 'worker-A gets follow-up chat');
      assert.ok(!spies['worker-B'].includes('hello from the user'), 'worker-B gets NO follow-up chat (learns via the board)');
    } finally {
      team.kill();
    }
  });

  await t('team-complete stamps the plan outcome and advances to the next item', async () => {
    const sid = 'sess-team-4';
    seedSession(sid, [planItem('td-1', 'one'), planItem('td-2', 'two')], [
      { itemId: 'td-1', type: 'plan', status: 'running', addedAt: new Date().toISOString(), addedBy: 'kkrazy' },
      { itemId: 'td-2', type: 'plan', status: 'pending', addedAt: new Date().toISOString(), addedBy: 'kkrazy' },
    ]);
    const spies = { 'worker-A': [], 'worker-B': [] };
    const team = await makeTeam(sid, sessionsMod.getSessionRecord(sid), spies);
    try {
      team._activeRunItem = { type: 'plan', itemId: 'td-1', startedAt: '2026-10-14T00:00:00.000Z' };
      team.emit('team-complete', { queueEmpty: true, items: 0, workers: ['worker-A', 'worker-B'] });
      const saved = sessionsMod.getSessionRecord(sid);
      const item1 = saved.artifacts.plan.items.find((it) => it.id === 'td-1');
      const lastRun = item1.runs[item1.runs.length - 1];
      assert.strictEqual(lastRun.status, 'success', 'td-1 run stamped success');
      assert.ok(item1.comments.some((c) => c.meta && c.meta.kind === 'run-summary'),
        'run-summary comment written back to plan.json (one-way mirror)');
      assert.strictEqual(saved.runQueue.find((e) => e.itemId === 'td-1').status, 'success', 'queue td-1 success');
      assert.strictEqual(saved.runQueue.find((e) => e.itemId === 'td-2').status, 'running', 'queue auto-advanced td-2');
      // The next item was dispatched to BOTH workers.
      assert.ok(spies['worker-A'].some((x) => x.includes('[run:plan#td-2]')), 'worker-A dispatched td-2');
      assert.ok(spies['worker-B'].some((x) => x.includes('[run:plan#td-2]')), 'worker-B dispatched td-2');
      assert.strictEqual(team._activeRunItem, null, 'active run cleared after terminal');
    } finally {
      team.kill();
    }
  });

  await t('team-failed marks the running entry failed + auto-pauses the queue', async () => {
    const sid = 'sess-team-5';
    seedSession(sid, [planItem('td-1', 'one')], [
      { itemId: 'td-1', type: 'plan', status: 'running', addedAt: new Date().toISOString(), addedBy: 'kkrazy' },
    ]);
    const spies = { 'worker-A': [], 'worker-B': [] };
    const team = await makeTeam(sid, sessionsMod.getSessionRecord(sid), spies);
    try {
      team._activeRunItem = { type: 'plan', itemId: 'td-1', startedAt: '2026-10-14T00:00:00.000Z' };
      team.kill(); // simulates teardown mid-run → team-failed
      const saved = sessionsMod.getSessionRecord(sid);
      assert.strictEqual(saved.runQueue.find((e) => e.itemId === 'td-1').status, 'failed', 'running entry marked failed');
      assert.strictEqual(saved.runQueuePaused, true, 'queue auto-paused on failure');
    } finally {
      try { team.kill(); } catch {}
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
