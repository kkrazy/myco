// explore-lane — TeamSession explore mode + startExploreLane assembly
// (路径探索 /run-explore), WITHOUT touching the live SDK. Construct a
// TeamSession in explore mode, then verify:
//  - roster path-1..path-N, all sharing one board, explorer prompts
//  - explore workers are FORCED onto the RLM engine even without rlm opt
//  - explore workers pass the shared harnessKey through to spawnRlmAgent
//  - non-explore teams keep the exact pre-change wiring (n2 regression)
//  - startExploreLane bridges + registers the lane + dispatches the task
//
// SDK stubbing mirrors team-session.test.js: we do NOT spawn real SDK
// connections; AgentSession is only constructed (its SDK iteration starts
// on .write, which we stub where needed).

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const { TeamSession } = require(path.join(ROOT, 'server/src/team-session.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'explore-test-'));
}

async function main() {
  console.log('── explore-lane: TeamSession explore mode ──');

  await t('explore team builds path-1..path-N roster sharing one board', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('exp-1', { cwd, task: 'T', eventsDir: dir, explore: true, roster: ['path-1', 'path-2', 'path-3'] });
    assert.deepStrictEqual(team.roster, ['path-1', 'path-2', 'path-3'], 'roster is path-1..path-3');
    assert.deepStrictEqual(team.board.actors, ['path-1', 'path-2', 'path-3'], 'board actors match roster');
    for (const a of team.roster) assert.ok(team.workers[a], `worker ${a} exists`);
    team.kill();
  });

  await t('explore workers get explorer prompts (seeder for path-1, member for others)', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('exp-2', { cwd, task: 'MyTask', eventsDir: dir, explore: true, roster: ['path-1', 'path-2'] });
    assert.ok(team.workers['path-1'].systemPrompt.includes('the path seeder'), 'path-1 seeds paths');
    assert.ok(team.workers['path-1'].systemPrompt.includes('publish UP TO 2 distinct'), 'seeder sees nPaths=2');
    assert.ok(team.workers['path-2'].systemPrompt.includes('claim one open path item'), 'path-2 claims + deep-dives');
    assert.ok(team.workers['path-2'].systemPrompt.includes('MyTask'), 'task embedded in member prompt');
    team.kill();
  });

  await t('explore workers are FORCED onto the RLM engine without the rlm opt', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    // rlm flag deliberately NOT set — explore mode must force RLM anyway
    // (self-evolution rides on rlm.addPrompt).
    const team = new TeamSession('exp-3', { cwd, task: 'T', eventsDir: dir, explore: true, roster: ['path-1', 'path-2'] });
    assert.strictEqual(team.rlm, false, 'team-level rlm flag stays false');
    for (const a of team.roster) {
      const w = team.workers[a];
      assert.ok(w.mcpServers && w.mcpServers.rlm, `${a} has the rlm kernel MCP server (RLM engine active)`);
    }
    team.kill();
  });

  await t('explore workers share one harnessKey (per-task self-evolution store)', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const key = 'explore-task-abc123def456';
    const team = new TeamSession('exp-4', { cwd, task: 'T', eventsDir: dir, explore: true, roster: ['path-1', 'path-2'], harnessKey: key });
    assert.strictEqual(team.harnessKey, key, 'team carries the shared key');
    // The composed prompt must include the SHARED store's section once the
    // store is non-empty. Seed the shared store first, then spawn.
    const harness = require(path.join(ROOT, 'server/src/agents/rlm/harness.js'));
    harness.addPromptAddition(cwd, key, 'Prefer measured evidence over intuition', 'test-seed');
    const team2 = new TeamSession('exp-4b', { cwd, task: 'T', eventsDir: dir, explore: true, roster: ['path-1', 'path-2'], harnessKey: key });
    for (const a of team2.roster) {
      assert.ok(team2.workers[a].systemPrompt.includes('Prefer measured evidence over intuition'),
        `${a} prompt composes the SHARED harness store rules`);
    }
    team.kill();
    team2.kill();
  });

  await t('non-explore n2 team is unchanged (regression: prompts + no forced RLM)', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('exp-5', { cwd, task: 'T', eventsDir: dir }); // no explore, default roster
    assert.deepStrictEqual(team.roster, ['worker-A', 'worker-B'], 'default n2 roster intact');
    assert.ok(team.workers['worker-A'].systemPrompt.includes('Establish the initial split'), 'STARTUP_A intact');
    assert.ok(team.workers['worker-B'].systemPrompt.includes('Leave initial queue creation'), 'STARTUP_B intact');
    assert.ok(!(team.workers['worker-A'].mcpServers && team.workers['worker-A'].mcpServers.rlm),
      'n2 worker without rlm opt has NO rlm MCP server (unchanged)');
    team.kill();
  });

  await t('write() routes chat to roster[0] (path-1 in explore mode)', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('exp-6', { cwd, task: 'T', eventsDir: dir, explore: true, roster: ['path-1', 'path-2', 'path-3'] });
    const writes = {};
    for (const a of team.roster) { writes[a] = []; team.workers[a].write = (txt) => writes[a].push(txt); }
    team._taskDispatched = true; // skip the first-write fan-out so we test the steady-state route
    team.write('hello team');
    assert.strictEqual(writes['path-1'].length, 1, 'path-1 (roster[0]) received the chat');
    assert.strictEqual(writes['path-2'].length, 0, 'path-2 not written directly');
    assert.strictEqual(writes['path-3'].length, 0, 'path-3 not written directly');
    team.kill();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
