// server/src/harness-runner.js regression suite (P3).
//
// A sweep is a DETACHED child process that spends real model budget. Every
// failure mode here is expensive in a way ordinary bugs are not, so the tests
// focus on the ones that lose money or strand state:
//
//   - an orphan that survives a mycod restart and keeps spending   (R1)
//   - a status file stuck on "running" with a dead pid              (UI lies)
//   - cancel that kills the Python parent but not its runners       (partial kill)
//   - a start that silently reuses a dead sweep                     (no work, no error)
//
// The child is a fixture script speaking the CONTRACT.md §5 progress protocol,
// driven through HARNESS2_SWEEP_CMD. That indirection is real functionality, not
// a test hook: the sweep is Python and the myco bench adapter is P5 work, so
// until then an operator points this at whatever sweep exists.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNNER = path.join(__dirname, '..', 'server', 'src', 'harness-runner');

let tmpRoot;
let fixtureDir;

function freshCwd(tag) {
  const d = path.join(tmpRoot, tag);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// A fixture "sweep": emits progress lines, optionally writes a result, then exits.
function writeFixture(name, { exitAfterMs = 150, exitCode = 0, result = true } = {}) {
  const file = path.join(fixtureDir, `${name}.js`);
  fs.writeFileSync(file, [
    "const fs = require('fs'); const path = require('path');",
    "const out = process.argv[2];",
    "process.stderr.write('[progress] stage=materialise run=fx done=1/1\\n');",
    "process.stderr.write('[progress] stage=rollout run=fx-1 state=start\\n');",
    "process.stderr.write('[progress] stage=rollout run=fx-1 state=done ok=true\\n');",
    `setTimeout(() => {`,
    result ? `  try { fs.writeFileSync(path.join(out, 'result.json'), '{"ok":true}\\n'); } catch {}` : '',
    `  process.stderr.write('[progress] stage=done run=fx state=ok\\n');`,
    `  process.exit(${exitCode});`,
    `}, ${exitAfterMs});`,
  ].join('\n'), 'utf8');
  return file;
}

// A fixture that hangs until killed.
function writeHangingFixture() {
  const file = path.join(fixtureDir, 'hang.js');
  fs.writeFileSync(file, [
    "const fs = require('fs'); const path = require('path');",
    "const out = process.argv[2];",
    "fs.writeFileSync(path.join(out, 'started.txt'), String(process.pid));",
    "process.stderr.write('[progress] stage=rollout run=hang-1 state=start\\n');",
    'setInterval(() => {}, 1000);',
  ].join('\n'), 'utf8');
  return file;
}

function useFixture(file, cwd) {
  // {dir} is substituted by shell-free splitting in sweepArgv, so the out dir has
  // to travel as an argument; the runner appends none, hence the wrapper below.
  process.env.HARNESS2_SWEEP_CMD = `${process.execPath} ${file} ${file}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(pred, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    if (pred()) return true;
    if (Date.now() - started > timeoutMs) return false;
    await sleep(50);
  }
}

const tests = [];

// ── sweep environment ──────────────────────────────────────────────────────

test('sweepEnv points the adapter at the session project and a usable model', () => {
  // Found live: /harness run from the panel died in preflight because
  // run_sweep refuses to start without HARNESS2_SOLVER_MODEL, and nothing in
  // mycod's env supplies it. The panel path has to work without the operator
  // exporting variables by hand, or the feature only ever runs from a shell.
  const saved = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    HARNESS2_SOLVER_MODEL: process.env.HARNESS2_SOLVER_MODEL,
    HARNESS2_JUDGE_MODEL: process.env.HARNESS2_JUDGE_MODEL,
  };
  try {
    delete process.env.HARNESS2_SOLVER_MODEL;
    delete process.env.HARNESS2_JUDGE_MODEL;
    process.env.ANTHROPIC_MODEL = 'GLM';
    const env = require(RUNNER).sweepEnv({ cwd: '/wks/u/sess' });
    assert.strictEqual(env.HARNESS2_MYCO_PROJECT, '/wks/u/sess',
      'the task source is the session project, not the repo root');
    assert.strictEqual(env.HARNESS2_SOLVER_MODEL, 'local/GLM',
      'validate_models needs a provider/id pair; a bare id is rejected');
    assert.strictEqual(env.HARNESS2_JUDGE_MODEL, 'local/GLM',
      'require_ready(judge=True) demands a judge model even though myco never grades');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('sweepEnv never overwrites a model the operator set', () => {
  const saved = process.env.HARNESS2_SOLVER_MODEL;
  try {
    process.env.HARNESS2_SOLVER_MODEL = 'openrouter/some-other-model';
    assert.strictEqual(require(RUNNER).sweepEnv({}).HARNESS2_SOLVER_MODEL,
      'openrouter/some-other-model',
      'an explicit choice must survive the default');
  } finally {
    if (saved === undefined) delete process.env.HARNESS2_SOLVER_MODEL;
    else process.env.HARNESS2_SOLVER_MODEL = saved;
  }
});
function test(name, fn) { tests.push([name, fn]); }

// ── pure helpers ────────────────────────────────────────────────────────────

test('parseProgress reads the contract grammar and ignores what it does not match', () => {
  const r = require(RUNNER);
  assert.deepStrictEqual(r.parseProgress('[progress] stage=rollout run=r1-1 tool=Bash'),
    { stage: 'rollout', run: 'r1-1', tool: 'Bash' });
  assert.strictEqual(r.parseProgress('Traceback (most recent call last):'), null);
  assert.strictEqual(r.parseProgress('[progress]'), null);
  assert.strictEqual(r.parseProgress(''), null);
});

test('isAlive distinguishes a live pid from a dead one', () => {
  const r = require(RUNNER);
  assert.strictEqual(r.isAlive(process.pid), true, 'our own pid is alive');
  assert.strictEqual(r.isAlive(0), false);
  assert.strictEqual(r.isAlive(-1), false);
  assert.strictEqual(r.isAlive(NaN), false);
});

test('sweepArgv defaults to the vendored module and honours the override', () => {
  const r = require(RUNNER);
  const saved = process.env.HARNESS2_SWEEP_CMD;
  delete process.env.HARNESS2_SWEEP_CMD;
  try {
    const argv = r.sweepArgv({ task: 't', k: 2, mode: 'parallel' });
    assert.strictEqual(argv[1], '-m');
    assert.strictEqual(argv[2], 'harness2.cli.run_sweep');
    assert.ok(argv.includes('--bench') && argv.includes('myco'));
    assert.ok(argv.includes('2'), 'k reaches the sweep');
  } finally {
    if (saved !== undefined) process.env.HARNESS2_SWEEP_CMD = saved;
  }
});

test('a path with spaces survives both accepted override forms', () => {
  // Found while writing this suite: a naive whitespace split turns a Windows
  // interpreter path into the string "C:/Program", so the sweep never starts.
  // Invisible on Linux, where node lives at /usr/bin/node.
  const r = require(RUNNER);
  const saved = process.env.HARNESS2_SWEEP_CMD;
  try {
    process.env.HARNESS2_SWEEP_CMD = '"C:/Program Files/nodejs/node.exe" s.js --x {task}';
    assert.deepStrictEqual(
      r.sweepArgv({ task: 'my task', k: 1, mode: 'parallel' }),
      ['C:/Program Files/nodejs/node.exe', 's.js', '--x', 'my task'],
      'quoted form keeps the path whole and the substituted task as ONE argument');

    process.env.HARNESS2_SWEEP_CMD = '["node","s.js","{task}"]';
    assert.deepStrictEqual(
      r.sweepArgv({ task: 'my task', k: 1, mode: 'parallel' }),
      ['node', 's.js', 'my task'],
      'the JSON form is exact, no quoting rules involved');
  } finally {
    if (saved === undefined) delete process.env.HARNESS2_SWEEP_CMD;
    else process.env.HARNESS2_SWEEP_CMD = saved;
  }
});

test('splitQuoted honours quotes and rejects an unclosed one', () => {
  const r = require(RUNNER);
  assert.deepStrictEqual(r.splitQuoted('a "b c" d'), ['a', 'b c', 'd']);
  assert.deepStrictEqual(r.splitQuoted("a 'b c'"), ['a', 'b c']);
  assert.deepStrictEqual(r.splitQuoted('   '), []);
  assert.throws(() => r.splitQuoted('a "unclosed'), /unclosed/);
});

test('sweep ids sort chronologically', () => {
  const r = require(RUNNER);
  const a = r.newSweepId();
  assert.ok(/^sw-\d{8}-\d{6}$/.test(a), a);
});

// ── lifecycle ───────────────────────────────────────────────────────────────

test('a sweep that exits 0 is recorded as success with its progress', async () => {
  const r = require(RUNNER);
  const cwd = freshCwd('ok');
  const fx = writeFixture('ok');
  process.env.HARNESS2_SWEEP_CMD = `${process.execPath} ${fx} ${path.join(cwd, '_harness_', 'sweeps')}`;
  // The fixture needs its own out dir, which the runner does not pass; point it
  // at the sweeps root so result.json sits beside status.json.
  fs.mkdirSync(path.join(cwd, '_harness_', 'sweeps'), { recursive: true });

  const started = r.startSweep({ cwd, task: 'count rows', k: 1 });
  assert.ok(started.id, 'an id is returned immediately');
  const done = await waitFor(() => {
    const st = r.getStatus(cwd, started.id);
    return st && st.status !== 'running';
  });
  assert.ok(done, 'sweep reached a terminal state');
  const st = r.getStatus(cwd, started.id);
  assert.strictEqual(st.status, 'success', JSON.stringify(st));
  assert.strictEqual(st.task, 'count rows');
  assert.ok(st.wallS >= 0);
  delete process.env.HARNESS2_SWEEP_CMD;
});

test('a non-zero exit is recorded as failed and keeps the stderr tail', async () => {
  const r = require(RUNNER);
  const cwd = freshCwd('fail');
  fs.mkdirSync(path.join(cwd, '_harness_', 'sweeps'), { recursive: true });
  const fx = path.join(fixtureDir, 'fail.js');
  fs.writeFileSync(fx, [
    "process.stderr.write('[progress] stage=rollout run=f-1 state=start\\n');",
    "process.stderr.write('Traceback (most recent call last):\\nValueError: boom\\n');",
    'process.exit(3);',
  ].join('\n'), 'utf8');
  process.env.HARNESS2_SWEEP_CMD = `${process.execPath} ${fx} x`;

  const started = r.startSweep({ cwd, task: 'x', k: 1 });
  await waitFor(() => {
    const st = r.getStatus(cwd, started.id);
    return st && st.status !== 'running';
  });
  const st = r.getStatus(cwd, started.id);
  assert.strictEqual(st.status, 'failed');
  assert.strictEqual(st.exitCode, 3);
  // Without the tail the pane says "failed" and nobody can tell why.
  assert.ok(st.stderrTail && st.stderrTail.includes('ValueError: boom'),
    'the last stderr is kept for diagnosis');
  delete process.env.HARNESS2_SWEEP_CMD;
});

test('a second start in the same directory reuses the running sweep', async () => {
  const r = require(RUNNER);
  const cwd = freshCwd('reuse');
  fs.mkdirSync(path.join(cwd, '_harness_', 'sweeps'), { recursive: true });
  const fx = writeHangingFixture();
  process.env.HARNESS2_SWEEP_CMD = `${process.execPath} ${fx} ${path.join(cwd, '_harness_', 'sweeps')}`;

  const a = r.startSweep({ cwd, task: 'first', k: 1 });
  assert.strictEqual(a.reused, false);
  const b = r.startSweep({ cwd, task: 'second', k: 1 });
  assert.strictEqual(b.reused, true, 'must not spend a second budget');
  assert.strictEqual(b.id, a.id);
  r.cancelSweep(cwd);
  await waitFor(() => { const st = r.getStatus(cwd, a.id); return st && st.status !== 'running'; });
  delete process.env.HARNESS2_SWEEP_CMD;
});

test('cancel kills the sweep and records it as cancelled', async () => {
  const r = require(RUNNER);
  const cwd = freshCwd('cancel');
  fs.mkdirSync(path.join(cwd, '_harness_', 'sweeps'), { recursive: true });
  const fx = writeHangingFixture();
  process.env.HARNESS2_SWEEP_CMD = `${process.execPath} ${fx} ${path.join(cwd, '_harness_', 'sweeps')}`;

  const started = r.startSweep({ cwd, task: 'slow', k: 1 });
  const pid = started.pid;
  assert.ok(await waitFor(() => r.isAlive(pid), 4000), 'the fixture started');

  const res = r.cancelSweep(cwd);
  assert.strictEqual(res.cancelled, true, JSON.stringify(res));
  assert.ok(await waitFor(() => !r.isAlive(pid), 6000), 'the process is gone');
  const st = r.getStatus(cwd, started.id);
  assert.ok(['cancelled', 'failed'].includes(st.status), `got ${st.status}`);
  delete process.env.HARNESS2_SWEEP_CMD;
});

test('cancel with nothing running says so instead of failing silently', () => {
  const r = require(RUNNER);
  const cwd = freshCwd('cancel-none');
  const res = r.cancelSweep(cwd);
  assert.strictEqual(res.cancelled, false);
  assert.ok(/no running sweep/.test(res.reason));
});

test('a status file left on "running" with a dead pid is reported as failed', () => {
  // This is the orphan case seen from the read side: mycod died, the status file
  // still says running. A spinner that never resolves is worse than the truth.
  const r = require(RUNNER);
  const cwd = freshCwd('deadpid');
  const id = 'sw-20260101-000000';
  const dir = path.join(cwd, '_harness_', 'sweeps', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    id, status: 'running', pid: 999999, task: 'x',
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }), 'utf8');

  const st = r.getStatus(cwd, id);
  assert.strictEqual(st.status, 'failed');
  assert.ok(/gone/.test(st.error));
});

test('latestSweepId replaces a stale "running" record', () => {
  const r = require(RUNNER);
  const cwd = freshCwd('stale');
  const id = 'sw-20260101-000001';
  const dir = path.join(cwd, '_harness_', 'sweeps', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    id, status: 'running', pid: 999999, startedAt: '', updatedAt: '',
  }), 'utf8');

  assert.strictEqual(r.latestSweepId(cwd, { runningOnly: true }), null,
    'a dead pid is not a running sweep');
  const after = r.getStatus(cwd, id);
  assert.strictEqual(after.status, 'failed');
});

test('sweepOrphans kills a live orphan and records why', () => {
  // R1: `detached` is what lets a sweep survive a mycod restart, and that is
  // exactly how one keeps spending with nobody watching.
  const r = require(RUNNER);
  const cwd = freshCwd('orphan');
  const id = 'sw-20260101-000002';
  const dir = path.join(cwd, '_harness_', 'sweeps', id);
  fs.mkdirSync(dir, { recursive: true });
  const child = require('child_process').spawn(process.execPath,
    ['-e', 'setInterval(() => {}, 1000);'], { detached: true, stdio: 'ignore' });
  child.unref();
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    id, status: 'running', pid: child.pid, startedAt: '', updatedAt: '',
  }), 'utf8');

  const killed = r.sweepOrphans(cwd);
  assert.deepStrictEqual(killed, [id]);
  const st = r.getStatus(cwd, id);
  assert.strictEqual(st.status, 'cancelled');
  assert.ok(/orphaned/.test(st.error));
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
});

test('sweepOrphans marks a dead orphan failed without inventing a kill', () => {
  const r = require(RUNNER);
  const cwd = freshCwd('orphan-dead');
  const id = 'sw-20260101-000003';
  const dir = path.join(cwd, '_harness_', 'sweeps', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    id, status: 'running', pid: 999999, startedAt: '', updatedAt: '',
  }), 'utf8');
  assert.deepStrictEqual(r.sweepOrphans(cwd), []);
  assert.strictEqual(r.getStatus(cwd, id).status, 'failed');
});

test('sweepOrphans ignores finished sweeps', () => {
  const r = require(RUNNER);
  const cwd = freshCwd('orphan-done');
  const id = 'sw-20260101-000004';
  const dir = path.join(cwd, '_harness_', 'sweeps', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    id, status: 'success', pid: 999999, startedAt: '', updatedAt: '',
  }), 'utf8');
  assert.deepStrictEqual(r.sweepOrphans(cwd), []);
  assert.strictEqual(r.getStatus(cwd, id).status, 'success');
});

test('the wall-clock cap stops a sweep that never returns', async () => {
  const r = require(RUNNER);
  const cwd = freshCwd('cap');
  fs.mkdirSync(path.join(cwd, '_harness_', 'sweeps'), { recursive: true });
  const fx = writeHangingFixture();
  process.env.HARNESS2_SWEEP_CMD = `${process.execPath} ${fx} ${path.join(cwd, '_harness_', 'sweeps')}`;

  // The supervisor polls every POLL_MS, so a 1s cap still takes one tick.
  const started = r.startSweep({ cwd, task: 'wedge', k: 1, wallCapS: 1 });
  const hit = await waitFor(() => {
    const st = r.getStatus(cwd, started.id);
    return st && st.status === 'timeout';
  }, 20000);
  assert.ok(hit, 'a wedged sweep is stopped rather than left burning');
  const st = r.getStatus(cwd, started.id);
  assert.ok(/wall-clock/.test(st.error || ''));
  delete process.env.HARNESS2_SWEEP_CMD;
});

test('formatStatus renders every terminal state without a spinner', () => {
  const r = require(RUNNER);
  assert.ok(/No harness sweep/.test(r.formatStatus(null)));
  for (const s of ['running', 'success', 'failed', 'cancelled', 'timeout']) {
    const out = r.formatStatus({ id: 'sw-x', status: s, task: 't', wallS: 3 });
    assert.ok(out.includes(s), s);
    assert.ok(out.includes('sw-x'));
  }
  const failed = r.formatStatus({ id: 'sw-y', status: 'failed', error: 'boom', stderrTail: 'ValueError' });
  assert.ok(failed.includes('boom'));
  assert.ok(failed.includes('ValueError'), 'the diagnosis reaches the pane');
});

test('a sweep with no pid still produces a usable status', () => {
  const r = require(RUNNER);
  const cwd = freshCwd('nopid');
  const id = 'sw-20260101-000005';
  const dir = path.join(cwd, '_harness_', 'sweeps', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    id, status: 'success', pid: null, wallS: 12, startedAt: '', updatedAt: '',
  }), 'utf8');
  const st = r.getStatus(cwd, id);
  assert.strictEqual(st.status, 'success');
  assert.strictEqual(st.pid, null);
});

// ── wiring ──────────────────────────────────────────────────────────────────

test('/harness is registered and gated to owner+admin', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');
  assert.ok(/names: \['harness'\]/.test(src), '/harness must be registered');
  assert.ok(/function _requireHarnessAuth/.test(src), 'it spends budget and writes .claude/, so it needs the same gate as /queue');
  assert.ok(/isOwnerOrAdmin/.test(src.slice(src.indexOf('_requireHarnessAuth'), src.indexOf('function handleHarness')))
    || /_requireHarnessAuth\(ctx\)/.test(src), 'the gate must actually be called');
  for (const verb of ['run', 'status', 'cancel']) {
    assert.ok(src.includes(`'${verb}'`), `the ${verb} verb must be handled`);
  }
});

test('boot-time orphan cleanup is wired into index.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');
  assert.ok(/sweepOrphans/.test(src), 'a restart is what creates orphans, so startup must sweep them');
});

// ── runner ──────────────────────────────────────────────────────────────────

(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-harness-runner-'));
  fixtureDir = path.join(tmpRoot, 'fixtures');
  fs.mkdirSync(fixtureDir, { recursive: true });

  let pass = 0, fail = 0;
  const saved = process.env.HARNESS2_SWEEP_CMD;
  try {
    for (const [name, fn] of tests) {
      const before = process.env.HARNESS2_SWEEP_CMD;
      try {
        await fn();
        console.log('  ✓ ' + name);
        pass++;
      } catch (err) {
        console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err));
        fail++;
      } finally {
        if (before === undefined) delete process.env.HARNESS2_SWEEP_CMD;
        else process.env.HARNESS2_SWEEP_CMD = before;
      }
    }
  } finally {
    if (saved === undefined) delete process.env.HARNESS2_SWEEP_CMD;
    else process.env.HARNESS2_SWEEP_CMD = saved;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
  console.log(`\nharness-runner (P3): ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();

test('the default wall cap is derived from k and the rollout timeout', () => {
  const r = require(RUNNER);
  // Regression: a flat 2-hour cap equalled the whole 4-rollout budget, so a
  // sweep that saturated even one rollout had ZERO budget left for its
  // improvement sessions and was killed mid-flight with result.json never
  // written. The cap must therefore be derived, never a constant.
  const perRollout = r.ROLLOUT_TIMEOUT_S;
  const k1 = r.defaultWallCapS(1);
  const k2 = r.defaultWallCapS(2);
  assert.ok(k1 > 4 * perRollout,
    `k=1 cap must exceed the 4-rollout budget (${4 * perRollout}s), got ${k1}`);
  assert.ok(k2 > k1, 'a larger k must get a larger cap');
  assert.strictEqual(k1, 4 * 1 * perRollout + 60 * 60);
  assert.strictEqual(k2, 4 * 2 * perRollout + 60 * 60);
  // Degenerate input must not produce a cap that kills the sweep instantly.
  assert.ok(r.defaultWallCapS(0) >= 4 * perRollout);
  assert.ok(r.defaultWallCapS(undefined) >= 4 * perRollout);
});

test('rollout timeout is configurable and feeds the derived cap', () => {
  const prior = process.env.HARNESS2_MYCO_ROLLOUT_TIMEOUT;
  process.env.HARNESS2_MYCO_ROLLOUT_TIMEOUT = '600';
  try {
    // A fresh require so the module-level constant is recomputed.
    delete require.cache[require.resolve(RUNNER)];
    const r = require(RUNNER);
    assert.strictEqual(r.ROLLOUT_TIMEOUT_S, 600);
    assert.strictEqual(r.defaultWallCapS(1), 4 * 1 * 600 + 60 * 60);
  } finally {
    if (prior === undefined) delete process.env.HARNESS2_MYCO_ROLLOUT_TIMEOUT;
    else process.env.HARNESS2_MYCO_ROLLOUT_TIMEOUT = prior;
    delete require.cache[require.resolve(RUNNER)];
  }
});

test('sessionScope isolates every user and session', () => {
  const r = require(RUNNER);
  // harness² names everything from (benchmark, substrate, mode, k), so every
  // session's sweep would otherwise be `myco-myco-agg1` in one shared tree:
  // two users overwrite each other's rollouts and selection.json.
  const a = r.sessionScope('/wks/alice/myco-alice-aaa111/proj');
  const b = r.sessionScope('/wks/bob/myco-bob-bbb222/proj');
  const a2 = r.sessionScope('/wks/alice/myco-alice-ccc333/proj');

  assert.deepStrictEqual(a, { user: 'alice', session: 'myco-alice-aaa111' });
  assert.notDeepStrictEqual(a, b, 'two users must not share a scope');
  assert.notDeepStrictEqual(a, a2, 'two sessions of one user must not share a scope');

  // Windows-style separators reach the same conclusion: the derivation must
  // not depend on path.sep, or a POSIX cwd inspected on a Windows host
  // collapses to one segment and everything falls back to `default`.
  // NOTE: doubled backslashes — a single `\w` / `\a` in a JS string literal is
  // an (ignored) escape, which silently ate the separators and made this
  // assertion test nothing.
  assert.deepStrictEqual(
    r.sessionScope('C:\\wks\\alice\\myco-alice-aaa111\\proj'),
    { user: 'alice', session: 'myco-alice-aaa111' });
});

test('runsRootFor and sweepTagFor differ per session', () => {
  const r = require(RUNNER);
  const a = '/wks/alice/myco-alice-aaa111/proj';
  const b = '/wks/bob/myco-bob-bbb222/proj';
  assert.notStrictEqual(r.runsRootFor(a), r.runsRootFor(b),
    'each session needs its own runs tree');
  assert.notStrictEqual(r.sweepTagFor(a), r.sweepTagFor(b),
    'each session needs its own namespace tag');
  // A tag becomes a path segment and a run-id segment: schedule.validate_tag
  // rejects a leading `s<digits>` (it would spell a seed), and this org's
  // logins look exactly like that.
  assert.ok(!/^s\d/.test(r.sweepTagFor('/wks/s00791175/myco-s00791175-x1/p')),
    'the tag must not start with a seed-looking token');
});

test('a cwd outside /wks still gets a stable non-shared scope', () => {
  const r = require(RUNNER);
  const s = r.sessionScope('/some/random/dir');
  assert.strictEqual(s.user, 'default');
  assert.strictEqual(s.session, 'dir');
  assert.ok(r.runsRootFor('/some/random/dir').length > 0);
});
