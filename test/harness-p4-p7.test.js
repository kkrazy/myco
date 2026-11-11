// test/harness-p4-p7.test.js — regression suite for P4 (result/adopt/rollback),
// P6 (publish from sweep), P7 (market install), and P8 (base harness env).
//
// None of these tests need a live sweep or a model call; they use a tiny fixture
// workspace and harness tree.

'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const hResult = require('../server/src/harness-result');
const hMarket = require('../server/src/harness-market');
const runner  = require('../server/src/harness-runner');

let tmpRoot;

function mkTmp(tag) {
  const d = path.join(tmpRoot, tag);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function write(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

// Build a minimal harness workspace as the sweep would produce.
function buildHarnessWs(dir, { systemprompt = '# role\n', guidance = 'use tools\n' } = {}) {
  write(dir, 'systemprompt.md', systemprompt);
  write(dir, 'tool_descriptions/tool_guidance.md', guidance);
  write(dir, 'guardrails.md', 'never push to main\n');
  write(dir, path.join('sub_agents', 'checker', 'AGENT.md'), '---\nname: checker\ndescription: checks things\n---\nbody\n');
  write(dir, path.join('scripts', 'lint.py'), 'print("ok")\n');
  return dir;
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// ── P4: diffHarness ────────────────────────────────────────────────────────

test('diffHarness reports added files when cwd is empty', () => {
  const hws = buildHarnessWs(mkTmp('h'));
  const cwd = mkTmp('cwd');
  const changes = hResult.diffHarness(hws, cwd);
  const paths = changes.map(c => c.path.split(path.sep).join('/'));
  assert.ok(paths.includes('CLAUDE.md'), 'systemprompt.md → CLAUDE.md');
  assert.ok(changes.every(c => c.status === 'added'), 'all are additions into a blank cwd');
});

test('diffHarness reports modified when content differs', () => {
  const hws = buildHarnessWs(mkTmp('h2'), { systemprompt: '# new role\n' });
  const cwd = mkTmp('cwd2');
  write(cwd, 'CLAUDE.md', '# old role\n');
  const changes = hResult.diffHarness(hws, cwd);
  const mod = changes.find(c => c.path === 'CLAUDE.md');
  assert.ok(mod, 'CLAUDE.md must appear');
  assert.strictEqual(mod.status, 'modified');
  assert.strictEqual(mod.from, '# old role\n');
  // content is the COMPOSED CLAUDE.md: role prompt + guardrails block.
  assert.ok(mod.content.startsWith('# new role\n'), 'composed content starts with the role');
  assert.ok(mod.content.includes('harness2:guardrails'), 'composed content includes the guardrails marker');
});

test('diffHarness reports nothing when cwd already matches', async () => {
  const hws = buildHarnessWs(mkTmp('h3'), { systemprompt: '# same\n', guidance: 'use tools\n' });
  const cwd = mkTmp('cwd3');
  // Adopt first to get the exact file content that adoptHarness writes,
  // then verify diffHarness sees no changes.
  await hResult.adoptHarness(hws, cwd);
  const changes = hResult.diffHarness(hws, cwd);
  assert.strictEqual(changes.length, 0, 'no diff when cwd was just adopted from this harness');
});

// ── P4: adoptHarness + rollback ─────────────────────────────────────────────

test('adoptHarness writes all mapped files into cwd', async () => {
  const hws = buildHarnessWs(mkTmp('h4'));
  const cwd = mkTmp('cwd4');
  const { adopted } = await hResult.adoptHarness(hws, cwd);
  assert.ok(fs.existsSync(path.join(cwd, 'CLAUDE.md')),          'CLAUDE.md');
  assert.ok(fs.existsSync(path.join(cwd, '.claude', 'tool_guidance.md')), 'tool_guidance');
  assert.ok(fs.existsSync(path.join(cwd, '.claude', 'agents', 'checker.md')), 'checker.md');
  assert.ok(fs.existsSync(path.join(cwd, '.myco_harness', 'scripts', 'lint.py')), 'lint.py');
  assert.ok(adopted.length > 0, 'returned list is non-empty');
});

test('adoptHarness folds guardrails into CLAUDE.md', async () => {
  const hws = buildHarnessWs(mkTmp('h5'), { systemprompt: '# role\n' });
  const cwd = mkTmp('cwd5');
  await hResult.adoptHarness(hws, cwd);
  const md = read(cwd, 'CLAUDE.md');
  assert.ok(md.includes('# role'),               'role is there');
  assert.ok(md.includes('harness2:guardrails'),   'guardrails marker');
  assert.ok(md.includes('never push to main'),    'guardrail text');
});

test('adoptHarness produces a snapshot with prior file content', async () => {
  const hws = buildHarnessWs(mkTmp('h6'), { systemprompt: '# new\n' });
  const cwd = mkTmp('cwd6');
  write(cwd, 'CLAUDE.md', '# old\n');
  const { snapshot } = await hResult.adoptHarness(hws, cwd);
  const prior = snapshot.entries.find(e => e.dst === 'CLAUDE.md');
  assert.ok(prior, 'CLAUDE.md entry in snapshot');
  assert.strictEqual(prior.content, '# old\n', 'prior content preserved');
});

test('rollbackHarness restores files to their pre-adopt state', async () => {
  const hws = buildHarnessWs(mkTmp('h7'), { systemprompt: '# new\n' });
  const cwd = mkTmp('cwd7');
  write(cwd, 'CLAUDE.md', '# original\n');
  const { snapshot } = await hResult.adoptHarness(hws, cwd);
  // File is now overwritten.
  assert.notStrictEqual(read(cwd, 'CLAUDE.md'), '# original\n', 'adopt must have changed it');
  const { restored } = await hResult.rollbackHarness(snapshot, cwd);
  assert.strictEqual(read(cwd, 'CLAUDE.md'), '# original\n', 'rollback must restore it');
  assert.ok(restored.includes('CLAUDE.md'), 'CLAUDE.md in restored list');
});

test('rollbackHarness removes files that did not exist before adoption', async () => {
  const hws = buildHarnessWs(mkTmp('h8'));
  const cwd = mkTmp('cwd8');
  // cwd starts completely empty so every file is "new".
  const { snapshot } = await hResult.adoptHarness(hws, cwd);
  assert.ok(fs.existsSync(path.join(cwd, 'CLAUDE.md')), 'must exist after adopt');
  await hResult.rollbackHarness(snapshot, cwd);
  assert.ok(!fs.existsSync(path.join(cwd, 'CLAUDE.md')), 'must be removed after rollback');
});

// ── P4: snapshot persistence ───────────────────────────────────────────────

test('saveSnapshot + loadSnapshot round-trips the snapshot', async () => {
  const cwd = mkTmp('cwdsnap');
  const snap = { id: 'abc123', ts: new Date().toISOString(), entries: [{ dst: 'CLAUDE.md', content: '# x\n' }] };
  const f = await hResult.saveSnapshot(snap, cwd, 'sw-test');
  const loaded = hResult.loadSnapshot(cwd, 'sw-test', 'abc123');
  assert.deepStrictEqual(loaded, snap);
  const snapshots = hResult.listSnapshots(cwd, 'sw-test');
  assert.ok(snapshots.length > 0, 'listSnapshots should find the saved file');
});

test('loadSnapshot returns the most recent when no id given', async () => {
  const cwd = mkTmp('cwdsnap2');
  const s1  = { id: 'aaa', ts: '2026-01-01T00:00:00Z', entries: [] };
  const s2  = { id: 'zzz', ts: '2026-01-02T00:00:00Z', entries: [] };
  await hResult.saveSnapshot(s1, cwd, 'sw-recent');
  await hResult.saveSnapshot(s2, cwd, 'sw-recent');
  const loaded = hResult.loadSnapshot(cwd, 'sw-recent', null);
  // loadSnapshot picks the alphabetically last, which is 'sw-recent-zzz.json'.
  assert.strictEqual(loaded.id, 'zzz');
});

// ── P6: harness-market buildFromSweep ──────────────────────────────────────

test('buildFromSweep extracts harness files with sha1 hashes', async () => {
  const runDir = mkTmp('rundir');
  const ws     = path.join(runDir, 'workspace');
  buildHarnessWs(ws);
  const fakeSelection = {
    ok: true,
    chosen_run_id:  'myco-agg1-bug-1-agg1',
    chosen_run_dir: runDir,
    why:            'candidate A covers the happy path',
    task_id: 'bug-1', mode: 'agg', k: 1,
  };
  const meta = { sweepTag: 'myco-myco-agg1', task: 'bug-1', mode: 'agg', k: 1, domain: 'Bug' };
  const item = await hMarket.buildFromSweep(fakeSelection, meta);
  assert.strictEqual(item.surface, 'myco', 'surface must be myco');
  assert.ok(typeof item.files === 'object' && Object.keys(item.files).length > 0, 'files map populated');
  for (const [rel, sha1] of Object.entries(item.files)) {
    assert.match(sha1, /^[0-9a-f]{40}$/, `${rel}: sha1 must be a hex string`);
  }
  assert.ok(item._content, '_content present for install');
});

test('buildFromSweep fails gracefully on a failed selection', async () => {
  const sel = { ok: false, chosen_run_id: null };
  await assert.rejects(
    () => hMarket.buildFromSweep(sel, {}),
    /no successful selection/
  );
});

// ── P7: validateTree ─────────────────────────────────────────────────────────

test('validateTree rejects an item with surface != myco', () => {
  assert.throws(
    () => hMarket.validateTree({ surface: 'opencode', files: {} }),
    /not 'myco'/
  );
});

test('validateTree accepts a well-formed myco item', () => {
  assert.doesNotThrow(() => hMarket.validateTree({ surface: 'myco', files: { 'systemprompt.md': 'abc' } }));
});

test('validateTree rejects a file that is too large', () => {
  const big = 'x'.repeat(65 * 1024);
  const item = {
    surface: 'myco',
    files:   { 'systemprompt.md': 'sha1' },
    _content: { 'systemprompt.md': big },
  };
  assert.throws(() => hMarket.validateTree(item), /exceeds maximum size/);
});

// ── P8: sweepEnv sets HARNESS2_MYCO_BASE_HARNESS ────────────────────────────

test('sweepEnv reads the market-installed sentinel and sets the base harness', () => {
  const cwd = mkTmp('cwdp8');
  const fakeHarnessDir = mkTmp('installed-harness');
  write(cwd, path.join('_harness_', 'market-installed.json'),
    JSON.stringify({ harnessDir: fakeHarnessDir }));
  const saved = process.env.HARNESS2_MYCO_BASE_HARNESS;
  delete process.env.HARNESS2_MYCO_BASE_HARNESS;
  try {
    const env = runner.sweepEnv({ cwd });
    assert.strictEqual(env.HARNESS2_MYCO_BASE_HARNESS, fakeHarnessDir,
      'sweepEnv must pass the installed harness dir as the sweep base');
  } finally {
    if (saved === undefined) delete process.env.HARNESS2_MYCO_BASE_HARNESS;
    else process.env.HARNESS2_MYCO_BASE_HARNESS = saved;
  }
});

test('sweepEnv does not override an explicit HARNESS2_MYCO_BASE_HARNESS', () => {
  const cwd = mkTmp('cwdp8b');
  write(cwd, path.join('_harness_', 'market-installed.json'),
    JSON.stringify({ harnessDir: mkTmp('installed-harness-b') }));
  const explicit = mkTmp('explicit-harness');
  const saved = process.env.HARNESS2_MYCO_BASE_HARNESS;
  process.env.HARNESS2_MYCO_BASE_HARNESS = explicit;
  try {
    const env = runner.sweepEnv({ cwd });
    assert.strictEqual(env.HARNESS2_MYCO_BASE_HARNESS, explicit,
      'an explicit env var must win over the sentinel');
  } finally {
    if (saved === undefined) delete process.env.HARNESS2_MYCO_BASE_HARNESS;
    else process.env.HARNESS2_MYCO_BASE_HARNESS = saved;
  }
});

// ── a timed-out sweep still has a readable selection ──────────────────────
//
// harness² writes selection.json during the sweep's CLOSING phase. A sweep
// killed by its wall-clock cap AFTER that point has a perfectly valid result,
// but findSelection required status === 'success' and returned null, so
// /harness diff reported "No successful selection found" over real data.
// Observed on sw-20261031-080845: 18003.6s, four delivered rollouts, agg1
// selected and written — and no diff.

function _writeSweep(cwd, id, status, { withSelection = true } = {}) {
  const dir = path.join(cwd, '_harness_', 'sweeps', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    id, status, namespace: 'myco-myco-agg1', k: 1,
    task: 'do the thing', error: 'sweep exceeded its cap',
  }), 'utf8');
  if (!withSelection) return;
  const selDir = path.join(cwd, '_runs', 'myco', 'adapt', 'myco-myco-agg1',
    'inline-task', 'selection', 'agg1');
  fs.mkdirSync(selDir, { recursive: true });
  fs.writeFileSync(path.join(selDir, 'selection.json'), JSON.stringify({
    task_id: 'inline-task', mode: 'agg', k: 1, chosen_label: 'agg1', ok: true,
    chosen_run_dir: path.join(cwd, '_runs', 'rollouts', 'agg1-1'),
  }), 'utf8');
}

function _withRunsDir(cwd, fn) {
  const prior = process.env.HARNESS2_RUNS_DIR;
  process.env.HARNESS2_RUNS_DIR = path.join(cwd, '_runs');
  try { fn(); } finally {
    if (prior === undefined) delete process.env.HARNESS2_RUNS_DIR;
    else process.env.HARNESS2_RUNS_DIR = prior;
  }
}

test('findSelection reads a selection from a TIMED-OUT sweep', () => {
  const cwd = mkTmp('timeout-sweep');
  _writeSweep(cwd, 'sw-timeout-1', 'timeout');
  _withRunsDir(cwd, () => {
    const sel = hResult.findSelection(cwd, 'sw-timeout-1');
    assert.ok(sel, 'a timeout sweep with a written selection must be readable — ' +
      'the cap fires during the closing phase, after the selection lands');
    assert.strictEqual(sel.chosen_label, 'agg1');
  });
});

test('findSelection still refuses a selectionless timeout sweep', () => {
  const cwd = mkTmp('timeout-nosel');
  _writeSweep(cwd, 'sw-timeout-2', 'timeout', { withSelection: false });
  _withRunsDir(cwd, () => {
    assert.strictEqual(hResult.findSelection(cwd, 'sw-timeout-2'), null,
      'relaxing the timeout gate must not invent a selection that is not there');
  });
});

test('findSelection refuses a failed or cancelled sweep', () => {
  const cwd = mkTmp('failed-sweep');
  _writeSweep(cwd, 'sw-failed-1', 'failed');
  _withRunsDir(cwd, () => {
    const statusFile = path.join(cwd, '_harness_', 'sweeps', 'sw-failed-1', 'status.json');
    const st = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    for (const bad of ['failed', 'cancelled']) {
      fs.writeFileSync(statusFile, JSON.stringify({ ...st, status: bad }), 'utf8');
      assert.strictEqual(hResult.findSelection(cwd, 'sw-failed-1'), null,
        `a ${bad} sweep has no trustworthy result`);
    }
  });
});



test('saveSnapshot survives a namespaced chosen_run_id', async () => {
  // /harness adopt passes sel.chosen_run_id as the snapshot stem, and harness²
  // run ids are namespaced: "myco-myco-agg1/inline-task/agg1". Joined into a
  // path, those slashes became extra segments under snapshots/, which mkdir
  // never created — adopt then failed with
  //   ENOENT: .../snapshots/myco-myco-agg1/inline-task/agg1-<hex>.json
  // on a path the user never supplied.
  const cwd = mkTmp('cwdsnap-ns');
  const snap = { id: 'deadbe', ts: new Date().toISOString(), entries: [{ dst: 'CLAUDE.md', content: '# x\n' }] };
  const namespaced = 'myco-myco-agg1/inline-task/agg1';
  const f = await hResult.saveSnapshot(snap, cwd, namespaced);
  assert.ok(fs.existsSync(f), 'saveSnapshot must actually write the file');
  assert.strictEqual(path.dirname(f), path.join(cwd, '_harness_', 'snapshots'),
    'the file must sit directly under snapshots/, not in nested dirs named after the run id');
  // Round-trip through the same id: adopt's rollback path depends on it.
  assert.deepStrictEqual(hResult.loadSnapshot(cwd, namespaced, 'deadbe'), snap);
  assert.ok(hResult.listSnapshots(cwd, namespaced).length > 0,
    'listSnapshots must find it under the same stem');
});

// ── pull: the agent's output, not the harness ──────────────────────────────

// Build a run dir the way myco-runner.js lays one out: a task dir of inputs, a
// workspace seeded from it plus the harness, and the agent's work on top.
function buildRun(root, label, { agentFiles = {}, modifySeed = null, taskDir }) {
  const runDir = path.join(root, label);
  const ws = path.join(runDir, 'workspace');
  for (const rel of ['sol_id.c', 'bench.c']) {
    write(taskDir, rel, `/* seed ${rel} */\n`);
    write(ws, rel, `/* seed ${rel} */\n`);
  }
  write(ws, 'CLAUDE.md', '# role\n');
  for (const [rel, body] of Object.entries(agentFiles)) write(ws, rel, body);
  if (modifySeed) write(ws, modifySeed, '/* seed */\n/* agent fixed it */\n');
  write(runDir, 'meta.json', JSON.stringify({
    task_dir: taskDir,
    harnessWritten: ['CLAUDE.md'],
  }, null, 2));
  return runDir;
}

test('listDeliverables separates the agent output from task inputs and harness', () => {
  const taskDir = mkTmp('pull-task');
  const root    = mkTmp('pull-runs');
  const runDir  = buildRun(root, 'myco-m1-inline-task-agg1-1', {
    taskDir,
    agentFiles: { 'sol/zcomp.c': 'int main(){return 0;}\n', 'RESULT.md': 'done\n' },
    modifySeed: 'bench.c',
  });

  const got  = hResult.listDeliverables(runDir);
  const rels = got.map(f => f.rel);

  assert.ok(rels.includes('sol/zcomp.c'), 'an agent-created file is a deliverable');
  assert.ok(rels.includes('RESULT.md'), 'an agent-created report is a deliverable');
  assert.ok(rels.includes('bench.c'),
    'a MODIFIED task input is a deliverable — a one-line fix lives here');
  assert.strictEqual(got.find(f => f.rel === 'bench.c').status, 'modified',
    'a seed that changed must be reported as modified, not added');
  assert.ok(!rels.includes('sol_id.c'),
    'an untouched task input must be excluded — it is not the agent work');
  assert.ok(!rels.includes('CLAUDE.md'),
    'the harness-written CLAUDE.md must be excluded — that is the casket, pull is the pearl');
});

test('listDeliverables skips tool state (dotfiles, _myco_, node_modules)', () => {
  const taskDir = mkTmp('pull-task2');
  const root    = mkTmp('pull-runs2');
  const runDir  = buildRun(root, 'run-a', {
    taskDir,
    agentFiles: {
      'out.txt': 'x\n',
      '.bash_history': 'ls\n',
      '_myco_/plan.json': '{}\n',
      'node_modules/pkg/index.js': 'x\n',
    },
  });
  const rels = hResult.listDeliverables(runDir).map(f => f.rel);
  assert.deepStrictEqual(rels, ['out.txt'],
    'only real output survives: dotfiles, _myco_ and node_modules are tool state');
});

test('pullDeliverables copies per run; siblingRuns lists every candidate', async () => {
  const taskDir = mkTmp('pull-task3');
  const root    = mkTmp('pull-runs3');
  const a = buildRun(root, 'run-base1', { taskDir, agentFiles: { 'sol/a.c': 'A\n' } });
  const b = buildRun(root, 'run-agg1',  { taskDir, agentFiles: { 'sol/b.c': 'B\n' } });
  const dest = mkTmp('pull-dest');

  const sibs = hResult.siblingRuns(b);
  assert.deepStrictEqual(sibs.map(p => path.basename(p)), ['run-agg1', 'run-base1'],
    'siblingRuns must return every run dir with a workspace — that is what --all compares');

  const out = await hResult.pullDeliverables(a, path.join(dest, hResult.runLabel(a)));
  assert.strictEqual(read(path.join(dest, 'run-base1'), 'sol/a.c'), 'A\n', 'agent file copied');
  assert.ok(!fs.existsSync(path.join(dest, 'run-base1', 'sol_id.c')),
    'task input must NOT be copied — pull is only the agent output');
  assert.strictEqual(out.label, 'run-base1');
  assert.deepStrictEqual(out.files.map(f => f.rel), ['sol/a.c']);
});

test('listDeliverables skips bulk output and reports it as skipped', () => {
  // A real sweep's base1 workspace carried dataset/dickens + dataset/mr (10 MB
  // each, identical in all four runs), a compiled `sol/bench` with no telling
  // extension, and a 876 KB PNG of the task. Pulling --all would have copied
  // ~40 MB of duplicated data over the ~10 KB of source worth reading.
  const taskDir = mkTmp('pull-task4');
  const root    = mkTmp('pull-runs4');
  const runDir  = buildRun(root, 'run-bulk', {
    taskDir,
    agentFiles: {
      'sol/zcomp.c': 'int main(){return 0;}\n',
      'dataset/dickens': 'x'.repeat(2 * 1024 * 1024),
      '难题.PNG': '\x89PNG-not-really-binary',
      // A real ELF header: NUL bytes abutting the magic. That is what the
      // content probe keys on — the extension carries no information here.
      'sol/bench': 'ELF     ',
    },
  });

  const kept = hResult.listDeliverables(runDir);
  assert.deepStrictEqual(kept.map(f => f.rel), ['sol/zcomp.c'],
    'only the source survives the bulk filter');
  assert.deepStrictEqual(kept.skipped.map(f => f.rel).sort(),
    ['dataset/dickens', 'sol/bench', '难题.PNG'],
    'skipped files must be reported, not silently dropped');

  const everything = hResult.listDeliverables(runDir, { all: true });
  assert.ok(everything.map(f => f.rel).includes('dataset/dickens'),
    '--all must be able to pull the bulk files when the user asks for them');
});

test('runLabel flattens a namespaced run path into one segment', () => {
  assert.strictEqual(hResult.runLabel('/x/runs/myco-a/inline-task/agg1'), 'agg1',
    'a namespaced run id must not become nested directories under the destination');
});


// ── runner ─────────────────────────────────────────────────────────────────

;(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-p4p7-'));
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ✓ ' + name);
      pass++;
    } catch (err) {
      console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err));
      fail++;
    }
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  console.log(`\nharness-p4-p7 (P4/P6/P7/P8): ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
