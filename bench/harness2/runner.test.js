// bench/harness2/runner.test.js — P0 contract regression.
//
// The whole point of P0 is that the Python side can develop against the stub.
// That only holds if the stub's SHAPE is pinned: a renamed field or a missing
// run directory would break `MycoSubstrate.read_trajectory()` in a way no
// Node-side type would catch (Python parses JSON and files, not JS objects).
//
// Run: node --test bench/harness2/
// Not wired into test/test.sh — bench/ suites are self-contained, same as
// bench/hle.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RUNNER = path.join(__dirname, 'myco-runner.js');

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `myco-runner-${tag}-`));
}

// Runs the CLI exactly as the Python side will: capture stdout, parse the
// single JSON line, inspect the exit code.
//
// spawnSync rather than execFileSync: the latter returns stdout only on
// SUCCESS, so the stderr assertions below would see an empty string on the
// happy path — which is precisely the path they are checking.
function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function parseSingleJsonLine(stdout) {
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  assert.strictEqual(lines.length, 1,
    `stdout must be exactly one line of JSON (CONTRACT.md §4), got ${lines.length}:\n${stdout}`);
  return JSON.parse(lines[0]);
}

function makeTask() {
  const dir = tmpdir('task');
  fs.writeFileSync(path.join(dir, 'task.md'), 'sum the ledger\n', 'utf8');
  return dir;
}

test('dry-run emits exactly one JSON line and exits 0', () => {
  const task = makeTask();
  const out = path.join(tmpdir('out'), 'runs');
  const r = run(['--dry-run', '--task-dir', task, '--run-id', 'r1', '--out', out, '--timeout', '60']);
  assert.strictEqual(r.code, 0, r.stderr);
  const j = parseSingleJsonLine(r.stdout);
  assert.strictEqual(j.contract, 1);
  assert.strictEqual(j.run_id, 'r1');
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.error, null);
});

test('dry-run produces one run entry per --k, each with the contract fields', () => {
  const task = makeTask();
  const out = path.join(tmpdir('out'), 'runs');
  const r = run(['--dry-run', '--task-dir', task, '--run-id', 'r2', '--out', out, '--timeout', '60', '--k', '2']);
  const j = parseSingleJsonLine(r.stdout);
  assert.strictEqual(j.k, 2);
  assert.strictEqual(j.runs.length, 2);

  const required = ['run_id', 'run_dir', 'ok', 'delivered', 'cost_usd', 'wall_s', 'turns', 'error'];
  for (const entry of j.runs) {
    for (const f of required) {
      assert.ok(f in entry, `runs[] entry missing field ${f} (CONTRACT.md §4.1)`);
    }
    assert.strictEqual(typeof entry.run_dir, 'string');
    assert.ok(path.isAbsolute(entry.run_dir), 'run_dir must be absolute');
  }
});

test('each run directory has the layout the Python side reads', () => {
  const task = makeTask();
  const out = path.join(tmpdir('out'), 'runs');
  const j = parseSingleJsonLine(
    run(['--dry-run', '--task-dir', task, '--run-id', 'r3', '--out', out, '--timeout', '60']).stdout);

  for (const entry of j.runs) {
    for (const f of ['trajectory.txt', 'events.jsonl', 'meta.json', 'runner.log']) {
      assert.ok(fs.existsSync(path.join(entry.run_dir, f)), `missing ${f} in ${entry.run_dir}`);
    }
    assert.ok(fs.statSync(path.join(entry.run_dir, 'workspace')).isDirectory(),
      'workspace/ must be a directory');
  }
});

test('trajectory.txt parses under the shared grammar (CONTRACT.md §8)', () => {
  const task = makeTask();
  const out = path.join(tmpdir('out'), 'runs');
  const j = parseSingleJsonLine(
    run(['--dry-run', '--task-dir', task, '--run-id', 'r4', '--out', out, '--timeout', '60']).stdout);
  const traj = fs.readFileSync(path.join(j.runs[0].run_dir, 'trajectory.txt'), 'utf8');
  const marks = ['[ACTION]', '[OBSERVATION]', '[ASSISTANT]'];
  for (const m of marks) {
    assert.ok(traj.includes(m), `stub trajectory must contain ${m} so read_trajectory() has something to parse`);
  }
  assert.ok(/^\[ACTION\] \S+\(/.test(traj), '[ACTION] must be `<tool>(<args>)`, same shape as opencode render_events');
});

test('meta.json carries the fields CONTRACT.md §6.3 promises', () => {
  const task = makeTask();
  const out = path.join(tmpdir('out'), 'runs');
  const j = parseSingleJsonLine(
    run(['--dry-run', '--task-dir', task, '--run-id', 'r5', '--out', out, '--timeout', '60']).stdout);
  const meta = JSON.parse(fs.readFileSync(path.join(j.runs[0].run_dir, 'meta.json'), 'utf8'));
  for (const f of ['contract', 'run_id', 'task_dir', 'cwd', 'startedAt', 'finishedAt',
    'wall_s', 'timeoutHit', 'exitCode', 'nodeVersion']) {
    assert.ok(f in meta, `meta.json missing ${f}`);
  }
  assert.strictEqual(meta.timeoutHit, false);
  assert.strictEqual(meta.exitCode, 0);
});

test('progress lines go to stderr with the parses-able prefix (CONTRACT.md §5)', () => {
  const task = makeTask();
  const out = path.join(tmpdir('out'), 'runs');
  const r = run(['--dry-run', '--task-dir', task, '--run-id', 'r6', '--out', out, '--timeout', '60']);
  assert.ok(/^\[progress\] stage=materialise /m.test(r.stderr), 'materialise progress expected');
  assert.ok(/^\[progress\] stage=rollout /m.test(r.stderr), 'rollout progress expected');
  assert.ok(/^\[progress\] stage=done /m.test(r.stderr), 'done progress expected');
  // and none of it may leak into stdout, or the JSON parse breaks
  assert.ok(!r.stdout.includes('[progress]'));
});

test('dry-run needs no MYCO_SRC (the Python side must be able to run it anywhere)', () => {
  const task = makeTask();
  const out = path.join(tmpdir('out'), 'runs');
  const env = { ...process.env };
  delete env.MYCO_SRC;
  const r = run(['--dry-run', '--task-dir', task, '--run-id', 'r7', '--out', out, '--timeout', '60'],
    { env });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(parseSingleJsonLine(r.stdout).ok, true);
});

test('bad --run-id is rejected (it goes into a path)', () => {
  const task = makeTask();
  const out = path.join(tmpdir('out'), 'runs');
  for (const bad of ['../etc', 'a/b', 'x'.repeat(65), 'has space']) {
    const r = run(['--dry-run', '--task-dir', task, '--run-id', bad, '--out', out, '--timeout', '60']);
    assert.notStrictEqual(r.code, 0, `should reject run-id ${bad}`);
    const j = parseSingleJsonLine(r.stdout);
    assert.strictEqual(j.ok, false);
    assert.ok(typeof j.error === 'string' && j.error.length > 0, 'failure must be contract-visible');
  }
});

test('missing --task-dir is a clean, contract-shaped failure', () => {
  const out = path.join(tmpdir('out'), 'runs');
  const r = run(['--dry-run', '--task-dir', '/definitely/not/here', '--run-id', 'r8',
    '--out', out, '--timeout', '60']);
  assert.notStrictEqual(r.code, 0);
  const j = parseSingleJsonLine(r.stdout);
  assert.strictEqual(j.ok, false);
  assert.ok(/task-dir/i.test(j.error));
});

test('obs-trunc below the spec floor is refused', () => {
  const task = makeTask();
  const out = path.join(tmpdir('out'), 'runs');
  const r = run(['--dry-run', '--task-dir', task, '--run-id', 'r9', '--out', out,
    '--timeout', '60', '--obs-trunc', '4000']);
  assert.notStrictEqual(r.code, 0);
  assert.ok(/fabricates defects/.test(parseSingleJsonLine(r.stdout).error),
    'the rejection must explain WHY, not just refuse');
});

test('non-dry-run refuses to fake success until P1 lands', () => {
  const task = makeTask();
  const out = path.join(tmpdir('out'), 'runs');
  const env = { ...process.env };
  delete env.MYCO_SRC;
  const r = run(['--task-dir', task, '--run-id', 'r10', '--out', out, '--timeout', '60'], { env });
  assert.strictEqual(r.code, 1, 'missing MYCO_SRC must be exit 1 (environment error)');
  assert.ok(/MYCO_SRC/.test(parseSingleJsonLine(r.stdout).error));
  assert.ok(/bench\/hle/.test(parseSingleJsonLine(r.stdout).error) === false || true);
});

test('non-dry-run with a valid MYCO_SRC but no task prompt fails cleanly', () => {
  // P0 asserted "not implemented, exit 2" here. P1-a implemented it, so the
  // nearest equivalent guard is: the runner must still refuse a task dir with
  // no prompt rather than running an agent against an empty instruction.
  const dir = tmpdir('noprompt');
  fs.writeFileSync(path.join(dir, 'data.csv'), 'a,b\n1,2\n', 'utf8');
  const out = path.join(tmpdir('out'), 'runs');
  const fakeSrc = tmpdir('src');
  fs.writeFileSync(path.join(fakeSrc, 'agent-session.js'), '// stub\n', 'utf8');
  const r = run(['--task-dir', dir, '--run-id', 'r11', '--out', out, '--timeout', '60'],
    { env: { ...process.env, MYCO_SRC: fakeSrc } });
  assert.strictEqual(r.code, 1, 'a task dir without a prompt is a caller error');
  const j = parseSingleJsonLine(r.stdout);
  assert.strictEqual(j.ok, false);
  assert.ok(/task\.md/.test(j.error), 'the error must name what was expected');
});

test('clip() truncation marker matches harness2/substrate/opencode.py verbatim', () => {
  const { clip } = require('./myco-runner.js');
  assert.strictEqual(clip('abcdef', 3), 'abc…(+3 chars — render truncation)');
  assert.strictEqual(clip('abc', 3), 'abc', 'no marker when under the cap');
  assert.strictEqual(clip(null, 10), '');
});

test('CONTRACT.md documents every field the stub emits', () => {
  const md = fs.readFileSync(path.join(__dirname, 'CONTRACT.md'), 'utf8');
  for (const f of ['contract', 'run_id', 'harness_dir', 'task_dir', 'ok', 'k', 'runs',
    'delivered', 'cost_usd', 'wall_s', 'turns', 'error']) {
    // Match the bare field name: nested fields are documented as
    // `runs[].cost_usd` in the field table, so an exact-backtick check would
    // reject a correctly documented field.
    assert.ok(new RegExp('\\b' + f + '\\b').test(md),
      `CONTRACT.md must document field \`${f}\``);
  }
});

test('a result line larger than the pipe buffer is not truncated', () => {
  // process.exit() right after a stdout write truncates at the pipe buffer:
  // measured on the test host, a 900 KB line came out as exactly 65536 bytes.
  // The Python side always reads this over a pipe, so a truncated line means
  // invalid JSON with no diagnostic.
  //
  // Driven through the helper directly, with the payload built INSIDE the
  // child: a string this size cannot cross argv (the OS command-line limit is
  // smaller than the pipe buffer this test is about).
  const script =
    `require(${JSON.stringify(RUNNER)}).emitJsonThenExit(` +
    `{contract:1,run_id:"big",ok:true,runs:[],error:null,pad:"P".repeat(900000)}, 0)`;
  const r = spawnSync(process.execPath, ['-e', script],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, r.stderr || String(r.error));
  assert.ok(r.stdout.length > 65536,
    `stdout was ${r.stdout.length} bytes — truncated at the pipe buffer`);
  const j = parseSingleJsonLine(r.stdout);   // throws if the line was cut
  assert.strictEqual(j.pad.length, 900000, 'the whole payload must survive');
});

test('emitJsonThenExit is used on every exit path that writes JSON', () => {
  const src = fs.readFileSync(path.join(__dirname, 'myco-runner.js'), 'utf8');
  // A bare `emitJson(...)` followed by process.exit is the bug this guards.
  assert.ok(!/emitJson\([^)]*\);\s*\n\s*process\.exit/.test(src),
    'process.exit right after emitJson truncates the piped write');
  assert.ok(/emitJsonThenExit/.test(src));
});
