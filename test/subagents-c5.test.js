// c5 (harness2-integration §2): sub-agent surface.
//
// `agents` was in SDK_OPTIONS_ALLOWLIST but never assigned, so a project
// shipping .claude/agents/*.md got no sub-agents: the SDK saw nothing and
// the Task tool only had its built-in general-purpose agent. This locks:
//   1. the loader turns Agent.md into an SDK AgentDefinition
//   2. a missing store leaves sdkOpts.agents UNSET (byte-identical)
//   3. malformed files are skipped, never fatal
//   4. agent-session.js actually assigns sdkOpts.agents
//
// Regression guard: deleting the assignment in agent-session.js makes
// test 4 fail even though the loader still works.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadAgents, parseAgentFile } = require('../server/src/subagents');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-subagents-'));

function makeCwd(tag) {
  const cwd = path.join(tmpRoot, 'proj-' + tag);
  fs.mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true });
  return cwd;
}
function writeAgent(cwd, file, text) {
  fs.writeFileSync(path.join(cwd, '.claude', 'agents', file), text, 'utf8');
}

t('front-matter parses name/description/tools/model and the body is the prompt', () => {
  const p = parseAgentFile([
    '---',
    'name: reviewer',
    'description: Reviews diffs for correctness',
    'tools: Read, Grep, Glob',
    'model: inherit',
    '---',
    '',
    'You review code.',
  ].join('\n'));
  assert.strictEqual(p.name, 'reviewer');
  assert.strictEqual(p.description, 'Reviews diffs for correctness');
  assert.deepStrictEqual(p.tools, ['Read', 'Grep', 'Glob']);
  assert.strictEqual(p.model, 'inherit');
  assert.strictEqual(p.body, 'You review code.');
});

t('tools accept the bracketed list form too', () => {
  const p = parseAgentFile('---\nname: a\ndescription: d\ntools: ["Read", "Bash"]\n---\nbody\n');
  assert.deepStrictEqual(p.tools, ['Read', 'Bash']);
});

t('a file with no front-matter is all prompt, named by its filename', () => {
  const cwd = makeCwd('bare');
  writeAgent(cwd, 'deployer.md', 'Deploy things carefully.\n');
  const { agents } = loadAgents(cwd);
  assert.ok(agents.deployer, 'agent named after the file stem');
  assert.strictEqual(agents.deployer.prompt, 'Deploy things carefully.');
  assert.strictEqual(agents.deployer.description, 'Sub-agent deployer', 'description defaults to the name');
});

t('a full agent definition lands in the SDK shape', () => {
  const cwd = makeCwd('full');
  writeAgent(cwd, 'reviewer.md', [
    '---', 'name: reviewer', 'description: Reviews diffs', 'tools: Read, Grep', '---', '',
    'You review code for correctness.',
  ].join('\n'));
  const { agents, skipped } = loadAgents(cwd);
  assert.deepStrictEqual(skipped, [], 'nothing skipped');
  assert.deepStrictEqual(agents.reviewer, {
    description: 'Reviews diffs',
    tools: ['Read', 'Grep'],
    prompt: 'You review code for correctness.',
  });
});

t('a missing store yields an empty map (sdkOpts.agents stays unset)', () => {
  const bare = path.join(tmpRoot, 'no-agents-here');
  fs.mkdirSync(bare, { recursive: true });
  const { agents, skipped } = loadAgents(bare);
  assert.deepStrictEqual(agents, {});
  assert.deepStrictEqual(skipped, []);
});

t('malformed files are skipped, never thrown (a typo must not block a session)', () => {
  const cwd = makeCwd('broken');
  writeAgent(cwd, 'empty.md', '---\nname: empty\ndescription: d\n---\n');
  writeAgent(cwd, 'badname.md', '---\nname: has spaces/and-slashes\n---\nbody\n');
  writeAgent(cwd, 'good.md', '---\nname: good\n---\nbody\n');
  const { agents, skipped } = loadAgents(cwd);
  assert.ok(agents.good, 'the valid agent still loads');
  assert.ok(!agents.empty, 'empty prompt body is skipped');
  assert.strictEqual(skipped.length, 2, 'both problems are reported, not thrown');
});

t('duplicate names keep the first and report the second', () => {
  const cwd = makeCwd('dup');
  writeAgent(cwd, 'a.md', '---\nname: same\ndescription: first\n---\nbody a\n');
  writeAgent(cwd, 'b.md', '---\nname: same\ndescription: second\n---\nbody b\n');
  const { agents, skipped } = loadAgents(cwd);
  assert.strictEqual(agents.same.description, 'first');
  assert.strictEqual(skipped.length, 1);
  assert.ok(/duplicate/.test(skipped[0].reason));
});

t('non-markdown entries in the agents dir are ignored', () => {
  const cwd = makeCwd('noise');
  fs.writeFileSync(path.join(cwd, '.claude', 'agents', 'README.txt'), 'ignore me', 'utf8');
  const { agents, skipped } = loadAgents(cwd);
  assert.deepStrictEqual(agents, {});
  assert.deepStrictEqual(skipped, []);
});

t('agent-session.js assigns sdkOpts.agents from the loader', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
  assert.ok(/sdkOpts\.agents\s*=/.test(src), 'agent-session.js must assign sdkOpts.agents');
  assert.ok(/require\('\.\/subagents'\)\.loadAgents\(this\.cwd\)/.test(src),
    'the assignment must come from subagents.loadAgents(this.cwd) — a hardcoded map would not read the project store');
});

console.log(`\nsubagents (c5): ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
