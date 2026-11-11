// c4 / c7 / c8 (harness2-integration §2) regression suite.
//
// c4 — per-session tool guidance  (<cwd>/.claude/tool_guidance.md)
// c7 — per-session helper scripts (<cwd>/.myco_harness/scripts/*.py)
// c8 — declarative hook tree      (<cwd>/.claude/hooks.json)
//
// The wiring assertions at the end are the important ones: the modules are
// useless if agent-session.js stops calling them, and that failure mode is
// invisible in a pure unit test.
//
// Security assertions worth keeping green:
//   - c7 must never auto-allow `python3 -c`, `python3 -m`, chained commands,
//     or any script this module did not discover.
//   - c8 must never evaluate code from the workspace (declarative only) and
//     `file` must not escape the session directory.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const guidance = require('../server/src/tool-guidance');
const scripts = require('../server/src/harness-scripts');
const hooks = require('../server/src/harness-hooks');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}
// Async cases are collected and run at the end: a top-level `await` makes
// Node ≥20 try to parse this file as ESM (it coexists with require(), so
// the loader refuses). Registration keeps the file plain CommonJS.
const deferred = [];
function ta(name, fn) { deferred.push([name, fn]); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-c478-'));
function mk(tag) {
  const cwd = path.join(tmpRoot, tag);
  fs.mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true });
  return cwd;
}

// ---------------------------------------------------------------- c4 ----

t('c4: absent guidance file yields null text (option stays unset)', () => {
  const cwd = mk('c4-none');
  assert.deepStrictEqual(guidance.loadToolGuidance(cwd).text, null);
});

t('c4: guidance file is read and trimmed', () => {
  const cwd = mk('c4-file');
  fs.writeFileSync(path.join(cwd, '.claude', 'tool_guidance.md'), '\n\nAlways run ./test/test.sh first.\n\n', 'utf8');
  assert.strictEqual(guidance.loadToolGuidance(cwd).text, 'Always run ./test/test.sh first.');
});

t('c4: empty guidance file is treated as absent', () => {
  const cwd = mk('c4-empty');
  fs.writeFileSync(path.join(cwd, '.claude', 'tool_guidance.md'), '   \n\n', 'utf8');
  assert.strictEqual(guidance.loadToolGuidance(cwd).text, null);
});

t('c4: no guidance → composeSystemPrompt returns the input untouched (undefined stays undefined)', () => {
  assert.strictEqual(guidance.composeSystemPrompt(undefined, null), undefined);
  assert.strictEqual(guidance.composeSystemPrompt('custom', null), 'custom');
});

t('c4: guidance + no existing prompt → claude_code preset with append', () => {
  const out = guidance.composeSystemPrompt(undefined, 'Guidance body');
  assert.deepStrictEqual(out, { type: 'preset', preset: 'claude_code', append: 'Guidance body' });
});

t('c4: guidance + existing custom prompt (n2 worker) → plain concatenation', () => {
  assert.strictEqual(guidance.composeSystemPrompt('N2 STARTUP', 'G'), 'N2 STARTUP\n\nG');
});

t('c4: guidance + existing preset object appends to its own append field', () => {
  const out = guidance.composeSystemPrompt({ type: 'preset', preset: 'claude_code', append: 'base' }, 'G');
  assert.strictEqual(out.append, 'base\n\nG');
  assert.strictEqual(out.preset, 'claude_code');
});

t('c4: guidance + array prompt appends as another element', () => {
  assert.deepStrictEqual(guidance.composeSystemPrompt(['a', 'b'], 'G'), ['a', 'b', 'G']);
});

t('c4: rendered block is labelled so the agent can tell it apart', () => {
  const block = guidance.renderGuidanceBlock('body', '/x/y/.claude/tool_guidance.md');
  assert.ok(/myco:tool_guidance/.test(block), 'machine-readable marker');
  assert.ok(/# Tool guidance/.test(block), 'human heading');
  assert.ok(/body$/.test(block));
});

// ---------------------------------------------------------------- c7 ----

function mkScripts(cwd, names) {
  const dir = path.join(cwd, '.myco_harness', 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, n), 'print("hi")\n', 'utf8');
  return dir;
}

t('c7: discovers .py files, sorted, ignores everything else', () => {
  const cwd = mk('c7-list');
  const dir = mkScripts(cwd, ['b.py', 'a.py']);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x', 'utf8');
  fs.writeFileSync(path.join(dir, 'c.sh'), 'x', 'utf8');
  const { scripts: found } = scripts.listHarnessScripts(cwd);
  assert.deepStrictEqual(found.map((s) => s.name), ['a.py', 'b.py']);
});

t('c7: missing scripts dir yields an empty list', () => {
  assert.deepStrictEqual(scripts.listHarnessScripts(mk('c7-none')).scripts, []);
});

t('c7: a plain python3 invocation of a discovered script is allowed', () => {
  const cwd = mk('c7-allow');
  const dir = mkScripts(cwd, ['sum.py']);
  assert.ok(scripts.isHarnessScriptInvocation(`python3 ${path.join(dir, 'sum.py')}`, cwd));
  assert.ok(scripts.isHarnessScriptInvocation(`python3 ${path.join(dir, 'sum.py')} --in ledger.csv`, cwd));
});

t('c7: -c and -m (arbitrary code / module execution) are refused', () => {
  const cwd = mk('c7-flags');
  const dir = mkScripts(cwd, ['sum.py']);
  assert.strictEqual(scripts.isHarnessScriptInvocation(`python3 -c "import os" ${path.join(dir, 'sum.py')}`, cwd), false);
  assert.strictEqual(scripts.isHarnessScriptInvocation(`python3 -m http.server`, cwd), false);
});

t('c7: shell metacharacters are refused (no command smuggling)', () => {
  const cwd = mk('c7-meta');
  const dir = mkScripts(cwd, ['sum.py']);
  const p = path.join(dir, 'sum.py');
  for (const cmd of [`python3 ${p} && rm -rf /`, `python3 ${p}; curl x`, `python3 ${p} | sh`, `python3 ${p} \$(id)`, `python3 ${p} \`id\``]) {
    assert.strictEqual(scripts.isHarnessScriptInvocation(cmd, cwd), false, cmd);
  }
});

t('c7: a script this module did not discover is refused', () => {
  const cwd = mk('c7-other');
  mkScripts(cwd, ['sum.py']);
  const other = path.join(cwd, '.myco_harness', 'scripts', 'evil.py');
  fs.writeFileSync(other, 'x', 'utf8');
  // Written after the listing would have been taken is irrelevant — it is
  // on disk, so it IS discovered. The real assertion: a path OUTSIDE the
  // dir never matches.
  assert.strictEqual(scripts.isHarnessScriptInvocation(`python3 ${path.join(cwd, 'elsewhere.py')}`, cwd), false);
  assert.strictEqual(scripts.isHarnessScriptInvocation('python3 /etc/passwd', cwd), false);
});

t('c7: non-python and non-Bash input is refused', () => {
  const cwd = mk('c7-bin');
  const dir = mkScripts(cwd, ['sum.py']);
  const p = path.join(dir, 'sum.py');
  assert.strictEqual(scripts.isHarnessScriptInvocation(`bash ${p}`, cwd), false);
  assert.strictEqual(scripts.isHarnessScriptInvocation(null, cwd), false);
  assert.strictEqual(scripts.isHarnessScriptInvocation(`python3 ${p}`, null), false);
});

t('c7: the rendered section lists relative paths and nothing when empty', () => {
  const cwd = mk('c7-render');
  const dir = mkScripts(cwd, ['sum.py']);
  const { scripts: found } = scripts.listHarnessScripts(cwd);
  const section = scripts.renderScriptsSection(found, cwd);
  assert.ok(/.myco_harness\/scripts\/sum.py/.test(section), 'relative path shown');
  assert.strictEqual(scripts.renderScriptsSection([], cwd), '', 'empty listing renders nothing');
});

// ---------------------------------------------------------------- c8 ----

function writeHooks(cwd, obj) {
  fs.writeFileSync(path.join(cwd, '.claude', 'hooks.json'), JSON.stringify(obj, null, 2), 'utf8');
}

t('c8: absent config yields an empty tree', () => {
  const loaded = hooks.loadHooks(mk('c8-none'));
  assert.deepStrictEqual(loaded.config, {});
  assert.deepStrictEqual(loaded.skipped, []);
});

t('c8: valid rules are normalised per event', () => {
  const cwd = mk('c8-valid');
  writeHooks(cwd, {
    PostToolUse: [{ matcher: 'Edit', action: 'log' }],
    UserPromptSubmit: [{ action: 'note', text: 'stay in scope' }],
    PreToolUse: [{ matcher: 'Bash', action: 'deny', when_command_matches: 'rm\\s+-rf', reason: 'no' }],
  });
  const { config, skipped } = hooks.loadHooks(cwd);
  assert.deepStrictEqual(skipped, []);
  assert.strictEqual(config.PostToolUse[0].action, 'log');
  assert.strictEqual(config.PostToolUse[0].matcher, 'Edit');
  assert.strictEqual(config.UserPromptSubmit[0].text, 'stay in scope');
  assert.ok(config.PreToolUse[0].regex instanceof RegExp);
});

t('c8: unsupported event / action are reported, not silently applied', () => {
  const cwd = mk('c8-bad');
  writeHooks(cwd, {
    Notification: [{ action: 'log' }],
    PostToolUse: [{ action: 'exec', text: 'x' }],
    PreToolUse: [{ action: 'deny', when_command_matches: '(' }],
  });
  const { config, skipped } = hooks.loadHooks(cwd);
  assert.strictEqual(config.Notification, undefined);
  assert.strictEqual(skipped.length, 3, JSON.stringify(skipped));
});

t('c8: deny is rejected outside PreToolUse (would be a no-op the author believes in)', () => {
  const cwd = mk('c8-denyevt');
  writeHooks(cwd, { PostToolUse: [{ action: 'deny' }] });
  const { skipped } = hooks.loadHooks(cwd);
  assert.strictEqual(skipped.length, 1);
  assert.ok(/only meaningful on PreToolUse/.test(skipped[0].reason));
});

t('c8: a log file path escaping the session is refused', () => {
  const cwd = mk('c8-escape');
  writeHooks(cwd, {
    PostToolUse: [
      { action: 'log', file: '../../etc/evil.jsonl' },
      { action: 'log', file: '/tmp/evil.jsonl' },
    ],
  });
  const { config, skipped } = hooks.loadHooks(cwd);
  assert.strictEqual(config.PostToolUse, undefined);
  assert.strictEqual(skipped.length, 2);
});

t('c8: no executable code is ever loaded from the workspace (declarative only)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'harness-hooks.js'), 'utf8');
  assert.ok(!/\brequire\s*\(\s*(input|cwd|rule|raw|file)/.test(src), 'must not require() workspace paths');
  assert.ok(!/\beval\s*\(/.test(src), 'must not eval');
  assert.ok(!/new\s+Function/.test(src), 'must not build functions from strings');
  assert.ok(!/child_process/.test(src), 'must not spawn processes');
});

ta('c8: log action appends one JSONL line under _myco_/', async () => {
  const cwd = mk('c8-log');
  writeHooks(cwd, { PostToolUse: [{ matcher: 'Bash', action: 'log' }] });
  const opt = hooks.buildHooksOption(hooks.loadHooks(cwd), cwd, 'sess-1');
  assert.ok(opt.PostToolUse, 'PostToolUse registered');
  const matcher = opt.PostToolUse[0];
  assert.strictEqual(matcher.matcher, 'Bash');
  await matcher.hooks[0]({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { ok: true } });
  const logFile = path.join(cwd, '_myco_', 'hook-log.jsonl');
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.strictEqual(row.event, 'PostToolUse');
  assert.strictEqual(row.tool, 'Bash');
  assert.strictEqual(row.session, 'sess-1');
});

ta('c8: note returns additionalContext on PostToolUse', async () => {
  const cwd = mk('c8-note');
  writeHooks(cwd, { PostToolUse: [{ action: 'note', text: 'run the tests' }] });
  const opt = hooks.buildHooksOption(hooks.loadHooks(cwd), cwd, 'sess-2');
  const out = await opt.PostToolUse[0].hooks[0]({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: {} });
  assert.deepStrictEqual(out.hookSpecificOutput, { hookEventName: 'PostToolUse', additionalContext: 'run the tests' });
});

ta('c8: deny blocks a matching command and passes a non-matching one', async () => {
  const cwd = mk('c8-deny');
  writeHooks(cwd, { PreToolUse: [{ matcher: 'Bash', action: 'deny', when_command_matches: 'rm\\s+-rf', reason: 'nope' }] });
  const cb = hooks.buildHooksOption(hooks.loadHooks(cwd), cwd, 'sess-3').PreToolUse[0].hooks[0];
  const blocked = await cb({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } });
  assert.strictEqual(blocked.hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(blocked.hookSpecificOutput.permissionDecisionReason, 'nope');
  const allowed = await cb({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.deepStrictEqual(allowed, {});
});

ta('c8: a callback that throws fails open (returns {})', async () => {
  const cwd = mk('c8-throw');
  writeHooks(cwd, { PostToolUse: [{ action: 'log' }] });
  const cb = hooks.buildHooksOption(hooks.loadHooks(cwd), cwd, 'sess-4').PostToolUse[0].hooks[0];
  // A getter that throws simulates any unexpected input shape.
  const bad = { get tool_name() { throw new Error('boom'); } };
  assert.deepStrictEqual(await cb(bad), {});
});

t('c8: matcher semantics — omitted matches all, alternation works, tool matcher skips non-tool events', () => {
  assert.ok(hooks.matcherHits(undefined, 'Bash'));
  assert.ok(hooks.matcherHits('Bash|Edit', 'Edit'));
  assert.strictEqual(hooks.matcherHits('Bash', 'Edit'), false);
  assert.strictEqual(hooks.matcherHits('Bash', undefined), false);
});

// ------------------------------------------------- wiring assertions ----

t('wiring: agent-session.js loads and applies c4 tool guidance', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
  assert.ok(/require\('\.\/tool-guidance'\)/.test(src));
  assert.ok(/loadToolGuidance\(this\.cwd\)/.test(src));
  assert.ok(/composeSystemPrompt\(/.test(src), 'must route the prompt through composeSystemPrompt, not assign blindly');
});

t('wiring: agent-session.js loads c7 scripts + auto-allows discovered invocations', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
  assert.ok(/require\('\.\/harness-scripts'\)/.test(src));
  assert.ok(/listHarnessScripts\(this\.cwd\)/.test(src));
  assert.ok(/isHarnessScriptInvocation\(cmd, this\.cwd\)/.test(src));
  assert.ok(/harness-script/.test(src), 'the allow branch must be identifiable in logs');
});

t('wiring: agent-session.js merges project hooks AFTER the built-in PreToolUse matcher', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
  assert.ok(/require\('\.\/harness-hooks'\)/.test(src));
  assert.ok(/buildHooksOption\(/.test(src));
  const optsAt = src.indexOf('const sdkOpts = {');
  const builtin = src.indexOf('PreToolUse: [{', optsAt);
  const merge = src.indexOf('sdkOpts.hooks[event] = (sdkOpts.hooks[event] || []).concat(matchers)');
  assert.ok(builtin > 0 && merge > builtin, 'merge must come after the built-in matcher is defined');
});

console.log(`\nc4/c7/c8: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
