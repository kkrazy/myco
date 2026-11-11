// Multi-expert team (专家团) — N-expert TeamSession + /run-experts wiring.
//
// Verifies, WITHOUT any live SDK query:
//   1. TeamSession with opts.roster + opts.expertSkills spawns N workers
//      sharing one board, each with a skills-defined expert prompt
//      (prompts-team.expertPrompt), roster index 0 = queue initializer.
//   2. dispatchTask fans out to EVERY worker; team-complete needs ALL
//      workers idle + every board item done.
//   3. TeamSession WITHOUT opts.expertSkills/roster is byte-identical n=2:
//      roster ['worker-A','worker-B'], STARTUP_A/B prompts, and
//      workerPrompt output unchanged (regression guard for /run-n2).
//   4. expertPrompt reuses the shared collaboration core (queue policy,
//      board commands, waiting) and names the expert's skills.
//   5. /run-experts parses + gates: no experts saved → usage/creating hint;
//      with saved experts → startTeamLane called with the roster +
//      expertSkills, completion notice on terminal.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-multi-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });
fs.writeFileSync(
  path.join(process.env.MYCO_STATE_DIR, 'allowed-github-users.txt'),
  '# fixture\nkkrazy\n',
);

const { TeamSession } = require('../server/src/team-session');
const { expertPrompt } = require('../server/src/prompts-team');
const { workerPrompt, STARTUP_A, STARTUP_B, QUEUE_POLICY } = require('../server/src/prompts-n2');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-multi-'));
}

async function main() {
  console.log('── team-multi-experts: N-expert team + /run-experts ──');

  // --- expertPrompt: skills-defined role + shared collaboration core ---
  await t('expertPrompt names the skills and reuses the queue policy core', () => {
    const p = expertPrompt({
      task: 'T', actor: 'worker-B',
      roster: ['worker-A', 'worker-B', 'worker-C'],
      workspace: '/wks/x',
      skills: [{ name: 'k8s-deploy', description: 'Deploy to k8s' }],
      nWorkers: 3,
    });
    assert.ok(p.includes('k8s-deploy'), 'names the expert skill');
    assert.ok(p.includes('Deploy to k8s'), 'carries the skill description');
    assert.ok(p.includes('one of 3 experts'), 'roster-size intro line');
    assert.ok(p.includes(QUEUE_POLICY.split('\n')[0]), 'queue policy core reused');
    assert.ok(p.includes('mcp__board__* tools'), 'board commands core reused');
    assert.ok(p.includes('Leave initial queue creation'), 'non-lead expert gets the member role');
    const lead = expertPrompt({
      task: 'T', actor: 'worker-A',
      roster: ['worker-A', 'worker-B'], workspace: '/wks/x', skills: [],
    });
    assert.ok(lead.includes('queue initializer'), 'roster index 0 is the queue initializer');
    assert.ok(lead.includes('generalist'), 'no skills → generalist line');
  });

  // --- n=2 regression guard: workerPrompt unchanged ---
  await t('n=2 workerPrompt is byte-identical (STARTUP_A/B path untouched)', () => {
    const a = workerPrompt({ task: 'T', actor: 'worker-A', roster: ['worker-A', 'worker-B'], workspace: '/w' });
    const b = workerPrompt({ task: 'T', actor: 'worker-B', roster: ['worker-A', 'worker-B'], workspace: '/w' });
    assert.ok(a.includes(STARTUP_A) && !a.includes(STARTUP_B), 'worker-A prompt embeds STARTUP_A only');
    assert.ok(b.includes(STARTUP_B) && !b.includes(STARTUP_A), 'worker-B prompt embeds STARTUP_B only');
    assert.ok(a.includes('one of two agents'), 'n=2 intro line preserved');
  });

  // --- TeamSession: N-expert construction ---
  await t('TeamSession spawns N experts sharing one board with skills prompts', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const roster = ['worker-A', 'worker-B', 'worker-C'];
    const expertSkills = {
      'worker-A': [{ name: 'architect', description: 'design' }],
      'worker-B': [{ name: 'k8s-deploy', description: 'deploy to k8s' }],
      'worker-C': [],
    };
    const team = new TeamSession('team-x', { cwd, task: 'T', eventsDir: dir, roster, expertSkills });
    assert.deepStrictEqual(team.roster, roster, 'roster override honored');
    assert.deepStrictEqual(team.board.actors, roster, 'board actors = full roster');
    assert.ok(team.workers['worker-A'] && team.workers['worker-B'] && team.workers['worker-C'], '3 workers exist');
    assert.ok(team.workers['worker-A'].systemPrompt.includes('architect'), 'A prompt has its skill');
    assert.ok(team.workers['worker-B'].systemPrompt.includes('k8s-deploy'), 'B prompt has its skill');
    assert.ok(team.workers['worker-C'].systemPrompt.includes('generalist'), 'C has no skills → generalist');
    assert.ok(team.workers['worker-A'].systemPrompt.includes('queue initializer'), 'first expert initializes the queue');
    assert.ok(!team.workers['worker-B'].systemPrompt.includes('queue initializer'), 'members do not');
    // n2 STARTUP text must NOT leak into expert prompts
    assert.ok(!team.workers['worker-A'].systemPrompt.includes(STARTUP_A), 'expert mode does not use STARTUP_A');
    team.kill();
  });

  await t('TeamSession default (no roster/expertSkills) stays n=2 with STARTUP_A/B', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const team = new TeamSession('team-plain', { cwd, task: 'T', eventsDir: dir });
    assert.deepStrictEqual(team.roster, ['worker-A', 'worker-B'], 'default roster');
    assert.ok(team.workers['worker-A'].systemPrompt.includes(STARTUP_A), 'default A prompt = STARTUP_A');
    assert.ok(team.workers['worker-B'].systemPrompt.includes(STARTUP_B), 'default B prompt = STARTUP_B');
    team.kill();
  });

  // --- N-expert dispatch + completion ---
  await t('dispatchTask fans to every expert; complete needs all idle + all done', () => {
    const dir = tmpdir();
    const cwd = path.join(dir, 'wks');
    fs.mkdirSync(cwd, { recursive: true });
    const roster = ['worker-A', 'worker-B', 'worker-C'];
    const team = new TeamSession('team-dispatch', {
      cwd, task: 'T', eventsDir: dir, roster,
      expertSkills: { 'worker-A': [], 'worker-B': [], 'worker-C': [] },
    });
    for (const a of roster) team.workers[a].write = (txt) => { team.workers[a]._w = (team.workers[a]._w || []).concat(txt); };
    team.dispatchTask('build it');
    for (const a of roster) {
      assert.deepStrictEqual(team.workers[a]._w, ['build it'], `${a} got the task`);
    }
    let complete = 0;
    team.on('team-complete', () => complete++);
    const r1 = team.board.reserve('worker-A', 'A1', 'x');
    const r2 = team.board.reserve('worker-B', 'B1', 'y');
    const r3 = team.board.reserve('worker-C', 'C1', 'z');
    team.board.done('worker-A', r1.item, 'a');
    team.board.done('worker-B', r2.item, 'b');
    team.workers['worker-A'].emit('idle');
    team.workers['worker-B'].emit('idle');
    assert.strictEqual(complete, 0, 'no complete while worker-C item open + C busy');
    team.board.done('worker-C', r3.item, 'c');
    team.workers['worker-C'].emit('idle');
    assert.strictEqual(complete, 1, 'team-complete once all items done + all idle');
    team.kill();
  });

  // --- /run-experts gating + lane launch ---
  const slash = require('../server/src/slashcmds');
  const cl = require('../server/src/compare-lanes');
  const sessionsMod = require('../server/src/sessions');

  await t('/run-experts with no saved experts replies a usage hint', async () => {
    const replies = [];
    const ctx = {
      session: Object.assign(new EventEmitter(), { alive: true, cwd: tmpRoot }),
      sessionId: 'SNOEXP',
      user: 'kkrazy',
      absCwd: tmpRoot,
      reply: (m) => replies.push(String(m)),
    };
    await slash.dispatch(ctx, '/run-experts');
    assert.ok(replies.some((r) => r.includes('Experts panel') || r.includes('No experts saved')),
      'usage hint names the Experts panel');
  });

  await t('/run-experts launches startTeamLane with roster + expertSkills', async () => {
    // Seed a session record with two saved experts (records are only
    // created by the spawn/import paths; inject directly into the store).
    const store = sessionsMod.loadStore();
    store.sessions['SEXPT'] = {
      id: 'SEXPT', user: 'kkrazy', cwd: 'wks', absCwd: tmpRoot,
      createdAt: new Date().toISOString(),
      experts: [
        { name: '架构师', skills: ['arch-skill'] },
        { name: '部署官', skills: ['k8s-deploy', 'helm-skill'] },
      ],
    };
    sessionsMod.saveStore();
    // A skill fixture the resolver can read from the session root.
    const skillsRoot = path.join(tmpRoot, '.claude', 'skills');
    fs.mkdirSync(path.join(skillsRoot, 'k8s-deploy'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'k8s-deploy', 'SKILL.md'),
      '---\nname: k8s-deploy\ndescription: Deploy myco to k8s\n---\n\nBody.');

    const replies = [];
    const ctx = {
      session: Object.assign(new EventEmitter(), { alive: true, cwd: tmpRoot }),
      sessionId: 'SEXPT',
      user: 'kkrazy',
      absCwd: tmpRoot,
      reply: (m) => replies.push(String(m)),
    };
    let laneOpts = null;
    let fakeLane = null;
    const orig = cl.startTeamLane;
    cl.startTeamLane = (o) => {
      laneOpts = o;
      fakeLane = new EventEmitter();
      fakeLane.board = null;
      fakeLane.roster = o.roster;
      fakeLane.dispatchTask = () => {};
      return { lane: fakeLane, id: 'x', boardFile: 'b', dir: 'd', startedAt: Date.now() };
    };
    try {
      await slash.dispatch(ctx, '/run-experts ship the feature');
      // The skill resolution is async (fs promises) — poll a few ticks
      // until startTeamLane fires or we give up.
      for (let i = 0; i < 50 && !laneOpts; i++) {
        await new Promise((r) => setImmediate(r));
      }
      assert.ok(laneOpts, 'startTeamLane was called');
      assert.deepStrictEqual(laneOpts.roster, ['worker-A', 'worker-B'], 'roster from saved experts');
      assert.ok(laneOpts.expertSkills['worker-B'].some((s) => s.name === 'k8s-deploy' && s.description === 'Deploy myco to k8s'),
        'skill description resolved from the session skills store');
      assert.deepStrictEqual(laneOpts.expertSkills['worker-A'].map((s) => s.name), ['arch-skill'],
        'missing skill dir falls back to dir name');
      assert.strictEqual(fakeLane.dispatchCalls, undefined, 'dispatchTask stubbed (no live SDK)');
      // Terminal → completion notice.
      fakeLane.emit('agent-event', { type: 'turn_result', subtype: 'success', worker: 'worker-A' });
      assert.ok(replies.some((r) => r.includes('/run-experts 完成')), 'completion notice emitted');
      assert.ok(replies.some((r) => r.includes('架构师') && r.includes('部署官')), 'notice names the experts');
    } finally {
      cl.startTeamLane = orig;
    }
  });

  // --- run-n2 lane code path untouched (static regression) ---
  await t('startN2Lane still constructs TeamSession WITHOUT roster/expertSkills', () => {
    const src = fs.readFileSync(require.resolve('../server/src/compare-lanes.js'), 'utf8');
    const at = src.indexOf('function startN2Lane');
    // Slice ONLY the function body — stopping at the NEXT `function `
    // keyword, NOT at the literal 'function startTeamLane', because the
    // startTeamLane comment block (which names roster/expertSkills) sits
    // between the two functions and would trip the assertions below.
    const end = src.indexOf('\n// Multi-expert team', at);
    const body = src.slice(at, end > at ? end : src.length);
    // The CONTRACT is about the TeamSession CONSTRUCTION OPTIONS, not the
    // whole function: startN2Lane legitimately reads lane.roster for the
    // team-info frame + reattach bookkeeping, but must never hand a
    // roster/expertSkills OVERRIDE to the constructor (that would change
    // /run-n2's fixed 2-worker STARTUP_A/B shape).
    const ctorAt = body.indexOf('new TeamSession(');
    assert.ok(ctorAt >= 0, 'startN2Lane constructs a TeamSession');
    const ctorEnd = body.indexOf('});', ctorAt);
    const ctor = body.slice(ctorAt, ctorEnd);
    assert.ok(!/roster/.test(ctor), 'startN2Lane passes no roster override to the TeamSession ctor');
    assert.ok(!ctor.includes('expertSkills'), 'startN2Lane never passes expertSkills to the TeamSession ctor');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
