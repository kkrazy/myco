// bench/harness2/transcript.test.js — P1-b.
//
// The trajectory is the ONLY evidence a Harness² improvement session gets about
// what the agent actually did. If a tool's arguments or a tool's output go
// missing here, propose/compose degrades from "read the contrast" to "guess",
// silently. So these tests mostly assert that information SURVIVES, not just
// that the format looks right.
//
// Run: node --test bench/harness2/transcript.test.js

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const t = require('./lib/transcript');

function jsonl(...events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

test('tool_use renders as [ACTION] name(args) with the args preserved', () => {
  const out = t.renderEventsFromText(jsonl(
    { type: 'tool_use', name: 'Bash', input: { command: 'ls -la /tmp' } }));
  assert.strictEqual(out, '[ACTION] Bash({"command":"ls -la /tmp"})');
  assert.ok(out.includes('ls -la /tmp'),
    'the actual command must survive — "Bash(...)" alone tells a reader nothing');
});

test('tool_result renders as [OBSERVATION] and an error one as [OBSERVATION ERROR]', () => {
  const ok = t.renderEventsFromText(jsonl(
    { type: 'tool_result', content: 'file1\nfile2', isError: false }));
  assert.strictEqual(ok, '[OBSERVATION] file1\nfile2');
  const bad = t.renderEventsFromText(jsonl(
    { type: 'tool_result', content: 'ENOENT', isError: true }));
  assert.strictEqual(bad, '[OBSERVATION ERROR] ENOENT');
});

test('an empty tool_result still emits a line', () => {
  // "the tool returned nothing" and "the tool was never called" are different
  // facts, and the second one is the kind of defect a tuner needs to see.
  const out = t.renderEventsFromText(jsonl({ type: 'tool_result', content: '' }));
  assert.strictEqual(out, '[OBSERVATION]');
});

test('assistant_text renders as [ASSISTANT]; blank text is dropped', () => {
  assert.strictEqual(
    t.renderEventsFromText(jsonl({ type: 'assistant_text', text: 'done' })),
    '[ASSISTANT] done');
  assert.strictEqual(
    t.renderEventsFromText(jsonl({ type: 'assistant_text', text: '   ' })),
    t.EMPTY);
});

test('a successful turn_result emits nothing (its text already came as assistant_text)', () => {
  // agent-session.js emits the final block twice: once as assistant_text and
  // again inside turn_result.result. Rendering both would double every turn.
  const out = t.renderEventsFromText(jsonl(
    { type: 'assistant_text', text: 'the answer is 42' },
    { type: 'turn_result', subtype: 'success', result: 'the answer is 42' }));
  assert.strictEqual(out, '[ASSISTANT] the answer is 42');
});

test('a failed turn_result surfaces as [ERROR]', () => {
  const out = t.renderEventsFromText(jsonl(
    { type: 'turn_result', subtype: 'error_max_turns', result: 'ran out of turns' }));
  assert.ok(out.startsWith('[ERROR] turn ended with subtype=error_max_turns'));
  assert.ok(out.includes('ran out of turns'));
});

test('session-level failures surface as [ERROR]', () => {
  const cases = [
    [{ type: 'fatal', message: 'gateway 500' }, 'gateway 500'],
    [{ type: 'iteration_aborted', reason: 'kill_mid_stream' }, 'kill_mid_stream'],
    [{ type: 'resume_failed' }, 'resume failed'],
    [{ type: 'rate_limit', retryAfter: 30 }, 'rate limited'],
  ];
  for (const [ev, needle] of cases) {
    const out = t.renderEventsFromText(jsonl(ev));
    assert.ok(out.startsWith('[ERROR]'), JSON.stringify(ev));
    assert.ok(out.toLowerCase().includes(needle.toLowerCase()), JSON.stringify(ev));
  }
});

test('myco bookkeeping events are dropped', () => {
  // These exist for the chat pane, not for behaviour analysis. Keeping them
  // would eat the obs_trunc budget the real evidence needs.
  const out = t.renderEventsFromText(jsonl(
    { type: 'turn_start', prompt: 'x' },
    { type: 'system_init', model: 'GLM', tools: ['Bash'] },
    { type: 'hook_allow', toolName: 'Bash' },
    { type: 'stdio', data: 'noise' },
    { type: 'unknown_event', raw_type: 'whatever' }));
  assert.strictEqual(out, t.EMPTY);
});

test('a full turn renders in order', () => {
  const out = t.renderEventsFromText(jsonl(
    { type: 'turn_start', prompt: 'count rows' },
    { type: 'tool_use', name: 'Bash', input: { command: 'wc -l data.csv' } },
    { type: 'tool_result', content: '3 data.csv' },
    { type: 'assistant_text', text: '3 rows' },
    { type: 'turn_result', subtype: 'success', result: '3 rows' }));
  assert.deepStrictEqual(out.split('\n'), [
    '[ACTION] Bash({"command":"wc -l data.csv"})',
    '[OBSERVATION] 3 data.csv',
    '[ASSISTANT] 3 rows',
  ]);
});

test('non-ASCII survives unescaped (matches json.dumps(ensure_ascii=False))', () => {
  const out = t.renderEventsFromText(jsonl(
    { type: 'tool_use', name: 'Read', input: { file_path: '/项目/数据.csv' } }));
  assert.ok(out.includes('/项目/数据.csv'),
    'escaping non-ASCII would make the same path render differently on the two substrates');
});

test('obs_trunc clips observations with the shared marker', () => {
  const long = 'x'.repeat(10100);
  const out = t.renderEventsFromText(jsonl({ type: 'tool_result', content: long }),
    { obsTrunc: 10000 });
  assert.ok(out.includes('…(+100 chars — render truncation)'),
    'the marker must be byte-identical to opencode.py _TRUNC_FMT');
  assert.strictEqual(out.length, '[OBSERVATION] '.length + 10000 +
    '…(+100 chars — render truncation)'.length);
});

test('args_trunc clips tool arguments independently of obs_trunc', () => {
  const out = t.renderEventsFromText(jsonl(
    { type: 'tool_use', name: 'Write', input: { content: 'y'.repeat(900) } }),
    { argsTrunc: 400 });
  assert.ok(out.includes('render truncation'));
  assert.ok(out.length < 600, 'args must be clipped at 400, not at obs_trunc');
});

test('obs_trunc below the spec floor throws rather than silently truncating', () => {
  assert.throws(
    () => t.renderEventsFromText(jsonl({ type: 'tool_result', content: 'x' }), { obsTrunc: 4000 }),
    /fabricates defects/,
    'core/spec.py rejects < 10000; the renderer must not be a way around that');
});

test('max_chars tail-truncates, keeping the EARLY steps', () => {
  const many = [];
  for (let i = 0; i < 200; i++) {
    many.push({ type: 'tool_use', name: 'Bash', input: { command: `step-${i}` } });
  }
  const out = t.renderEventsFromText(jsonl(...many), { maxChars: 500 });
  assert.ok(out.includes('step-0'), 'the first step must survive — it is where drift starts');
  assert.ok(!out.includes('step-199'), 'the tail is what gets dropped');
  assert.ok(/…\(\+\d+ chars — render truncation\)$/.test(out));
});

test('malformed and partial JSONL lines are skipped, not fatal', () => {
  // events.jsonl is appended by a live process: the last line can be a partial
  // write, and a container kill mid-append leaves a truncated record.
  const raw = [
    JSON.stringify({ type: 'tool_use', name: 'Bash', input: { command: 'a' } }),
    'not json at all',
    '{"type":"tool_result","content":"partial',           // truncated
    '',
    JSON.stringify({ type: 'assistant_text', text: 'survived' }),
  ].join('\n');
  const out = t.renderEventsFromText(raw);
  assert.ok(out.includes('[ACTION] Bash'));
  assert.ok(out.includes('[ASSISTANT] survived'));
  assert.ok(!out.includes('partial'));
});

test('an empty or event-less file renders the shared sentinel', () => {
  assert.strictEqual(t.renderEventsFromText(''), t.EMPTY);
  assert.strictEqual(t.renderEventsFromText('\n\n'), t.EMPTY);
  assert.strictEqual(t.EMPTY, '(no parseable events in trajectory)',
    'must match opencode.py verbatim so both substrates report absence the same way');
});

test('a missing file reports the reason instead of throwing', () => {
  const out = t.renderEventsFile(path.join(os.tmpdir(), 'definitely-not-here.jsonl'));
  assert.ok(out.startsWith('(failed to read trajectory:'),
    'a rollout that died before journalling is normal; the caller records it as evidence');
});

test('renderEventsFile reads a real file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-traj-'));
  const f = path.join(dir, 'events.jsonl');
  fs.writeFileSync(f, jsonl(
    { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.js' } },
    { type: 'tool_result', content: 'a.js\nb.js' }), 'utf8');
  const out = t.renderEventsFile(f);
  assert.strictEqual(out, '[ACTION] Glob({"pattern":"**/*.js"})\n[OBSERVATION] a.js\nb.js');
});

test('unserialisable tool input still emits an [ACTION] line', () => {
  // Dropping the line would make the trajectory claim no tool ran.
  const circular = { type: 'tool_use', name: 'Bash', input: {} };
  circular.input.self = circular.input;
  const out = t.renderEvent(circular, { obsTrunc: 10000, argsTrunc: 400 });
  assert.strictEqual(out.length, 1);
  assert.ok(out[0].startsWith('[ACTION] Bash('));
  assert.ok(out[0].includes('unserialisable'));
});

test('a tool_use with no name degrades to "tool" rather than vanishing', () => {
  const out = t.renderEventsFromText(jsonl({ type: 'tool_use', input: { x: 1 } }));
  assert.strictEqual(out, '[ACTION] tool({"x":1})');
});
