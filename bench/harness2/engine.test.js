// bench/harness2/engine.test.js — P1-a.
//
// The parts of the engine that can be tested WITHOUT a live session: the c1..c8
// path mapping, harness materialisation, task seeding, the `delivered` rule,
// and the MYCO_SRC guard. The live-session path (runRollout) needs a model and
// is covered by the integration run on the test server, not here — a unit test
// that mocked the SDK would only assert that the mock works.
//
// Run: node --test bench/harness2/engine.test.js

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engine = require('./lib/engine');

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `myco-engine-${tag}-`));
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

// ── MYCO_SRC guard ─────────────────────────────────────────────────────────

test('resolveMycoSrc refuses a missing env var and says how to fix it', () => {
  const prior = process.env.MYCO_SRC;
  delete process.env.MYCO_SRC;
  try {
    assert.throws(() => engine.resolveMycoSrc(), /MYCO_SRC is not set/);
    // The message must carry the fix. bench/hle hardcodes a path that exists on
    // one machine; without the instruction, a copier gets MODULE_NOT_FOUND from
    // deep inside a require chain.
    assert.throws(() => engine.resolveMycoSrc(), /MYCO_SRC=\/app\/server\/src/);
  } finally {
    if (prior === undefined) delete process.env.MYCO_SRC; else process.env.MYCO_SRC = prior;
  }
});

test('resolveMycoSrc refuses a directory that is not server/src', () => {
  const prior = process.env.MYCO_SRC;
  process.env.MYCO_SRC = tmp('wrong');
  try {
    assert.throws(() => engine.resolveMycoSrc(), /does not contain agent-session\.js/);
  } finally {
    if (prior === undefined) delete process.env.MYCO_SRC; else process.env.MYCO_SRC = prior;
  }
});

test('resolveMycoSrc accepts a directory that has agent-session.js', () => {
  const prior = process.env.MYCO_SRC;
  const dir = tmp('right');
  fs.writeFileSync(path.join(dir, 'agent-session.js'), '// stub\n', 'utf8');
  process.env.MYCO_SRC = dir;
  try {
    assert.strictEqual(engine.resolveMycoSrc(), dir);
  } finally {
    if (prior === undefined) delete process.env.MYCO_SRC; else process.env.MYCO_SRC = prior;
  }
});

// ── session id ─────────────────────────────────────────────────────────────

test('rollout session ids cannot collide with a user session', () => {
  const id = engine.rolloutSessionId('r-0001-1');
  assert.ok(id.startsWith('harness2-'),
    'a rollout must be greppable in logs and distinguishable from myco-<user>-<hex>');
  assert.ok(!/^myco-/.test(id));
});

// ── c1..c8 path mapping ────────────────────────────────────────────────────

test('every c1..c8 component maps to the path its myco module reads', () => {
  // These destinations are the contract between the engine and
  // subagents.js / tool-guidance.js / harness-scripts.js / harness-hooks.js.
  const cases = [
    ['systemprompt.md', 'CLAUDE.md'],
    ['tool_guidance.md', '.claude/tool_guidance.md'],
    ['tool_descriptions/tool_guidance.md', '.claude/tool_guidance.md'],
    ['hooks.json', '.claude/hooks.json'],
    ['LongTermMEMORY.md', '.claude/memory/LongTermMEMORY.md'],
    ['sub_agents/reviewer/AGENT.md', '.claude/agents/reviewer.md'],
    ['skills/ledger/SKILL.md', '.claude/skills/ledger/SKILL.md'],
    ['scripts/summarize.py', '.myco_harness/scripts/summarize.py'],
  ];
  for (const [from, to] of cases) {
    const got = engine.mapHarnessPath(from);
    assert.strictEqual(got && got.split(path.sep).join('/'), to, `mapping for ${from}`);
  }
});

test('an unrecognised component maps to null so the caller can report it', () => {
  // Silently dropping a component the tuner produced would make a sweep look
  // like it adopted something it did not.
  assert.strictEqual(engine.mapHarnessPath('plugin/audit.ts'), null);
  assert.strictEqual(engine.mapHarnessPath('whatever.txt'), null);
});

// ── materialisation ────────────────────────────────────────────────────────

test('materialiseHarness writes each component where myco reads it', () => {
  const h = tmp('harness');
  const cwd = tmp('cwd');
  write(h, 'systemprompt.md', '# role\n');
  write(h, 'tool_guidance.md', 'use the script\n');
  write(h, path.join('sub_agents', 'checker', 'AGENT.md'), '---\nname: checker\n---\nbody\n');
  write(h, path.join('scripts', 'sum.py'), 'print(1)\n');
  write(h, 'hooks.json', '{"PostToolUse":[]}');

  const r = engine.materialiseHarness(h, cwd);
  assert.deepStrictEqual(r.unmapped, []);
  assert.ok(fs.existsSync(path.join(cwd, 'CLAUDE.md')));
  assert.ok(fs.existsSync(path.join(cwd, '.claude', 'tool_guidance.md')));
  assert.ok(fs.existsSync(path.join(cwd, '.claude', 'agents', 'checker.md')));
  assert.ok(fs.existsSync(path.join(cwd, '.myco_harness', 'scripts', 'sum.py')));
  assert.ok(fs.existsSync(path.join(cwd, '.claude', 'hooks.json')));
  assert.strictEqual(read(cwd, path.join('.claude', 'agents', 'checker.md')),
    '---\nname: checker\n---\nbody\n', 'content must be copied verbatim');
});

test('guardrails.md is folded into CLAUDE.md under a marked heading', () => {
  // c2 has no distinct myco slot. Appending under a marker keeps standing
  // rules distinguishable from the role prompt for both the agent and a human
  // reading the workspace.
  const h = tmp('harness');
  const cwd = tmp('cwd');
  write(h, 'systemprompt.md', '# role\n');
  write(h, 'guardrails.md', 'never force-push\n');
  const r = engine.materialiseHarness(h, cwd);
  const md = read(cwd, 'CLAUDE.md');
  assert.ok(md.includes('# role'));
  assert.ok(md.includes('harness2:guardrails'));
  assert.ok(md.includes('never force-push'));
  assert.ok(md.indexOf('# role') < md.indexOf('never force-push'),
    'the role prompt must come first');
  assert.deepStrictEqual(r.unmapped, []);
});

test('unmapped components are reported, not dropped', () => {
  const h = tmp('harness');
  const cwd = tmp('cwd');
  write(h, path.join('plugin', 'audit.ts'), 'export default {}\n');
  const r = engine.materialiseHarness(h, cwd);
  assert.deepStrictEqual(r.unmapped, ['plugin/audit.ts']);
  assert.ok(!fs.existsSync(path.join(cwd, 'plugin')));
});

test('materialiseHarness with no harness dir is a no-op', () => {
  const cwd = tmp('cwd');
  const r = engine.materialiseHarness(null, cwd);
  assert.deepStrictEqual(r.written, []);
  assert.deepStrictEqual(r.unmapped, []);
  assert.deepStrictEqual(fs.readdirSync(cwd), []);
});

test('materialiseTask copies inputs but not the DELIVERABLE pointer', () => {
  const taskDir = tmp('task');
  const cwd = tmp('cwd');
  write(taskDir, 'task.md', 'sum the ledger\n');
  write(taskDir, 'ledger.csv', 'amount\n10\n');
  write(taskDir, 'DELIVERABLE', 'out.txt\n');
  // Returns name -> content hash: the hash is what lets isDelivered notice a
  // MODIFICATION, which for code work is the deliverable.
  const files = engine.materialiseTask(taskDir, cwd);
  assert.ok('task.md' in files);
  assert.ok('ledger.csv' in files);
  assert.ok(!('DELIVERABLE' in files), 'DELIVERABLE is runner metadata, not task content');
  assert.ok(!fs.existsSync(path.join(cwd, 'DELIVERABLE')));
  assert.match(files['ledger.csv'], /^[0-9a-f]{40}$/, 'a sha1 of what was written');
});

test('materialiseTask preserves nested task layout', () => {
  const taskDir = tmp('task');
  const cwd = tmp('cwd');
  write(taskDir, path.join('data', 'in', 'a.csv'), 'x\n');
  const files = engine.materialiseTask(taskDir, cwd);
  assert.deepStrictEqual(Object.keys(files), ['data/in/a.csv']);
  assert.strictEqual(read(cwd, path.join('data', 'in', 'a.csv')), 'x\n');
});

// ── delivered (CONTRACT.md §7) ─────────────────────────────────────────────

test('rule 1: an explicit DELIVERABLE pointer decides', () => {
  const taskDir = tmp('task');
  const cwd = tmp('cwd');
  write(taskDir, 'DELIVERABLE', 'out.txt\n');
  assert.strictEqual(engine.isDelivered(taskDir, cwd, []), false, 'absent → not delivered');
  write(cwd, 'out.txt', '42\n');
  assert.strictEqual(engine.isDelivered(taskDir, cwd, []), true);
});

test('rule 1 wins over rule 2', () => {
  // A pointer means the benchmark is precise about what counts; an unrelated
  // scratch file must not satisfy it.
  const taskDir = tmp('task');
  const cwd = tmp('cwd');
  write(taskDir, 'DELIVERABLE', 'out.txt\n');
  write(cwd, 'scratch.txt', 'noise\n');
  assert.strictEqual(engine.isDelivered(taskDir, cwd, []), false);
});

test('rule 2: a new file beyond the task inputs counts as delivered', () => {
  const taskDir = tmp('task');
  const cwd = tmp('cwd');
  write(cwd, 'task.md', 'x\n');
  assert.strictEqual(engine.isDelivered(taskDir, cwd, ['task.md']), false,
    'the seeded inputs alone are not a deliverable');
  write(cwd, 'answer.txt', '42\n');
  assert.strictEqual(engine.isDelivered(taskDir, cwd, ['task.md']), true);
});

test('rule 2: MODIFYING a seeded file counts as delivered', () => {
  // The bug that stalled the first end-to-end sweep: an agent fixed a one-line
  // bug exactly as asked, the trajectory showed the edit, and delivered was
  // false because the file already existed. Every candidate then "failed to
  // produce an artifact" and there was nothing to select from.
  const taskDir = tmp('task');
  const cwd = tmp('cwd');
  write(taskDir, 'task.md', 'change the greeting\n');
  write(taskDir, 'app.py', 'def greet():\n    return "hi"\n');
  const seeded = engine.materialiseTask(taskDir, cwd);
  assert.strictEqual(engine.isDelivered(taskDir, cwd, seeded), false,
    'an untouched copy is not a deliverable');
  write(cwd, 'app.py', 'def greet():\n    return "hello"\n');
  assert.strictEqual(engine.isDelivered(taskDir, cwd, seeded), true,
    'a changed seeded file is exactly what a code fix looks like');
});

test('rule 2 still accepts a plain name list from callers that have no hashes', () => {
  // Backwards compatible: an array of names cannot detect modification, but it
  // still detects additions.
  const taskDir = tmp('task');
  const cwd = tmp('cwd');
  write(cwd, 'task.md', 'x\n');
  assert.strictEqual(engine.isDelivered(taskDir, cwd, ['task.md']), false);
  write(cwd, 'out.txt', '42\n');
  assert.strictEqual(engine.isDelivered(taskDir, cwd, ['task.md']), true);
});

test('rule 2 ignores harness and myco bookkeeping directories', () => {
  // Writing .claude/ is materialisation, not work. Counting it would make
  // every rollout report delivered:true.
  const taskDir = tmp('task');
  const cwd = tmp('cwd');
  write(cwd, path.join('.claude', 'agents', 'a.md'), 'x\n');
  write(cwd, path.join('_myco_', 'events.jsonl'), '{}\n');
  write(cwd, path.join('.myco_harness', 'scripts', 's.py'), 'x\n');
  write(cwd, 'CLAUDE.md', '# role\n');
  assert.strictEqual(engine.isDelivered(taskDir, cwd, []), false);
});

// ── walkFiles ──────────────────────────────────────────────────────────────

test('walkFiles returns relative paths and tolerates a missing directory', () => {
  const root = tmp('walk');
  write(root, path.join('a', 'b.txt'), 'x');
  write(root, 'c.txt', 'y');
  const got = engine.walkFiles(root).map((p) => p.split(path.sep).join('/')).sort();
  assert.deepStrictEqual(got, ['a/b.txt', 'c.txt']);
  assert.deepStrictEqual(engine.walkFiles(path.join(root, 'nope')), []);
});

// ── describeFailure ────────────────────────────────────────────────────────

test('describeFailure surfaces a stall payload instead of "[object Object]"', () => {
  // TeamSession emits team-failed with an OBJECT. String(obj) used to erase
  // the reason, the board item and how long the team sat idle — the sweep
  // report showed a literal "[object Object]" and the failure was
  // uninvestigable.
  const got = engine.describeFailure({ reason: 'stall', itemId: 'item-7', idleMs: 480000 });
  assert.match(got, /stall/);
  assert.match(got, /item=item-7/);
  assert.match(got, /idle=480s/);
  assert.doesNotMatch(got, /\[object Object\]/);
});

test('describeFailure handles strings, Errors and empty payloads', () => {
  assert.strictEqual(engine.describeFailure('boom'), 'boom');
  assert.strictEqual(engine.describeFailure(new Error('kaboom')), 'kaboom');
  assert.strictEqual(engine.describeFailure(null, 'team failed'), 'team failed');
  assert.strictEqual(engine.describeFailure(undefined), 'unknown failure');
  // An object with no recognised key still yields readable JSON, never
  // "[object Object]".
  const odd = engine.describeFailure({ weird: 1 });
  assert.match(odd, /weird/);
  assert.doesNotMatch(odd, /\[object Object\]/);
});

test('describeFailure truncates a very long payload', () => {
  const got = engine.describeFailure('x'.repeat(5000));
  assert.ok(got.length <= 500, `expected <=500 chars, got ${got.length}`);
});
