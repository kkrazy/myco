// transcript.parseLine() — coverage for the JSONL `type` values claude
// code emits that aren't user/assistant/tool_result/ai-title. Audit of
// 70 MB of local sessions found 40+ distinct types; the parser used to
// handle 4 and silently dropped the rest. This test pins the new
// branches against fixtures lifted from real sessions so a future
// upstream rename doesn't regress them.

const assert = require('assert');
const { parseLine } = require('../server/src/transcript');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

// ─── Fixtures lifted verbatim from ~/.claude/projects/*.jsonl ────────────
// (Inlined as JSON strings — no I/O dependency at test time. If claude
// code's record schema changes upstream, just paste fresh fixtures.)

const FIX_PLAN_MODE = JSON.stringify({
  parentUuid: 'a6b2a293-6416-4fe4-a7de-b6440fbd27de',
  isSidechain: false,
  attachment: { type: 'plan_mode', reminderType: 'full', isSubAgent: false,
                planFilePath: '/root/.claude/plans/example.md', planExists: false },
  type: 'attachment',
  uuid: '44148457-67d5-4ba0-b83e-2062a3ca66c2',
  timestamp: '2026-05-11T09:08:31.951Z',
});

const FIX_PLAN_MODE_EXIT = JSON.stringify({
  attachment: { type: 'plan_mode_exit',
                planFilePath: '/root/.claude/plans/example.md', planExists: false },
  type: 'attachment',
  uuid: '7961fd85-763d-4e86-b2b7-1ac9f61ae931',
  timestamp: '2026-05-13T07:48:11.382Z',
});

const FIX_AUTO_MODE = JSON.stringify({
  attachment: { type: 'auto_mode', reminderType: 'once' },
  type: 'attachment',
  uuid: '50394c9a-e4d1-44a9-806e-f86da5d2e8b8',
  timestamp: '2026-05-13T07:48:11.382Z',
});

const FIX_COMMAND_PERMISSIONS = JSON.stringify({
  attachment: { type: 'command_permissions', allowedTools: [] },
  type: 'attachment',
  uuid: 'f6b7ceca-fd3a-40f9-b0c4-620144ecc0b8',
  timestamp: '2026-04-29T07:48:22.287Z',
});

const FIX_QUEUED_COMMAND = JSON.stringify({
  attachment: { type: 'queued_command', prompt: 'also keep saying hi', commandMode: 'prompt' },
  type: 'attachment',
  uuid: '1f5aafc9-1436-4339-9873-8316bac3ee43',
  timestamp: '2026-05-07T08:24:28.893Z',
});

const FIX_API_ERROR = JSON.stringify({
  type: 'system',
  subtype: 'api_error',
  level: 'error',
  error: { status: 429, message: 'rate limited' },
  uuid: 'err-uuid',
  timestamp: '2026-04-30T06:04:22.000Z',
});

const FIX_ASSISTANT_WITH_THINKING = JSON.stringify({
  type: 'assistant',
  uuid: '5c2a2e45-3748-4325-bfc2-cbff9af89946',
  timestamp: '2026-05-01T03:42:46.282Z',
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Let me trace through the bug step by step.' },
      { type: 'text', text: 'The fix is to handle the off-by-one in the loop.' },
    ],
  },
});

const FIX_ASSISTANT_ONLY_THINKING = JSON.stringify({
  type: 'assistant',
  uuid: 'tk-only',
  timestamp: '2026-05-01T03:42:46.282Z',
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Just reasoning, no final reply.' },
    ],
  },
});

const FIX_ASSISTANT_THINKING_REDACTED = JSON.stringify({
  // Older models / paid plans redact the visible thinking text — the
  // .thinking field is empty and the .signature carries the encrypted
  // blob. Parser must NOT emit an empty `thinking` frame in this case.
  type: 'assistant',
  uuid: 'tk-redacted',
  timestamp: '2026-05-01T03:42:46.282Z',
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '', signature: 'EpgDCl…' },
      { type: 'text', text: 'final answer text' },
    ],
  },
});

const FIX_SUB_AGENT_PLAN_MODE = JSON.stringify({
  // Sub-agent recursive attachment — parser must skip; these are
  // claude posting context to its own subagents, not user content.
  attachment: { type: 'plan_mode', isSubAgent: true,
                planFilePath: '/tmp/sub.md', planExists: false },
  type: 'attachment',
  uuid: 'sub-uuid',
  timestamp: '2026-05-11T09:08:31.951Z',
});

// ─── Attachment-typed records ─────────────────────────────────────────

t('plan_mode → entered', () => {
  const r = parseLine(FIX_PLAN_MODE);
  assert.ok(r, 'should emit a frame');
  assert.strictEqual(r.role, 'plan_mode');
  assert.strictEqual(r.state, 'entered');
  assert.strictEqual(r.uuid, '44148457-67d5-4ba0-b83e-2062a3ca66c2');
});

t('plan_mode_exit → exited', () => {
  const r = parseLine(FIX_PLAN_MODE_EXIT);
  assert.ok(r);
  assert.strictEqual(r.role, 'plan_mode');
  assert.strictEqual(r.state, 'exited');
});

t('auto_mode → entered (no explicit state field)', () => {
  const r = parseLine(FIX_AUTO_MODE);
  assert.ok(r);
  assert.strictEqual(r.role, 'auto_mode');
  assert.strictEqual(r.state, 'entered');
});

t('command_permissions → permission_change with tool list', () => {
  const r = parseLine(FIX_COMMAND_PERMISSIONS);
  assert.ok(r);
  assert.strictEqual(r.role, 'permission_change');
  assert.deepStrictEqual(r.tools, []);
});

t('queued_command → queued with prompt + mode', () => {
  const r = parseLine(FIX_QUEUED_COMMAND);
  assert.ok(r);
  assert.strictEqual(r.role, 'queued');
  assert.strictEqual(r.text, 'also keep saying hi');
  assert.strictEqual(r.mode, 'prompt');
});

t('isSubAgent attachments are skipped (claude-internal recursion noise)', () => {
  // Reason: sub-agent contexts are claude posting to itself — not user
  // content. Surfacing them would clutter the viewer's transcript.
  const r = parseLine(FIX_SUB_AGENT_PLAN_MODE);
  assert.strictEqual(r, null);
});

t('unknown attachment kind → null (silently skipped)', () => {
  const fix = JSON.stringify({
    attachment: { type: 'tools_changed', tools: [] },
    type: 'attachment', uuid: 'u', timestamp: 't',
  });
  // Reason: passive metadata; don't pollute the transcript with every
  // claude-internal book-keeping event.
  assert.strictEqual(parseLine(fix), null);
});

// ─── System-typed errors ──────────────────────────────────────────────

t('system error → error frame with kind + text', () => {
  const r = parseLine(FIX_API_ERROR);
  assert.ok(r);
  assert.strictEqual(r.role, 'error');
  assert.strictEqual(r.kind, 'api_error');
  assert.ok(r.text && r.text.includes('rate limited'));
});

t('system without level=error → null', () => {
  // Other system records (level: 'info', 'warn') don't reach this branch.
  const fix = JSON.stringify({ type: 'system', subtype: 'note', level: 'info' });
  assert.strictEqual(parseLine(fix), null);
});

// ─── Assistant message: thinking content extraction ───────────────────

t('assistant content with thinking surfaces both text AND thinking', () => {
  const r = parseLine(FIX_ASSISTANT_WITH_THINKING);
  assert.ok(r);
  assert.strictEqual(r.role, 'assistant');
  assert.ok(r.text.includes('off-by-one'));
  assert.ok(Array.isArray(r.thinking) && r.thinking.length === 1);
  assert.ok(r.thinking[0].includes('trace through'));
});

t('assistant with ONLY thinking (no text/tools) still emits frame', () => {
  const r = parseLine(FIX_ASSISTANT_ONLY_THINKING);
  assert.ok(r);
  assert.strictEqual(r.role, 'assistant');
  assert.strictEqual(r.text, '');
  assert.ok(Array.isArray(r.thinking) && r.thinking[0]);
});

t('assistant with REDACTED thinking (empty .thinking) drops the thinking field', () => {
  // Older models redact visible reasoning to a signature; empty
  // .thinking is the redaction marker. The parser must not emit an
  // empty thinking frame — there's literally nothing to render.
  const r = parseLine(FIX_ASSISTANT_THINKING_REDACTED);
  assert.ok(r);
  assert.strictEqual(r.text, 'final answer text');
  assert.ok(!r.thinking, 'no thinking array when content was redacted');
});

// ─── ExitPlanMode (plan markdown lives in tool_use.input.plan) ────────

const FIX_EXIT_PLAN_MODE = JSON.stringify({
  type: 'assistant',
  uuid: 'exit-plan-uuid',
  timestamp: '2026-05-14T00:04:51.985Z',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_plan_01',
        name: 'ExitPlanMode',
        input: {
          plan: '# /v2/orders — Cursor Pagination\n\n## Context\n\nKeyset query etc.',
          planFilePath: '/root/.claude/plans/foo.md',
        },
      },
    ],
  },
});

t('ExitPlanMode tool_use lifts plan markdown into assistant.text', () => {
  // Regression: demo010 plan generated 2026-05-14T00:04 never showed
  // in the chat pane (persistAssistantTextToChat gates on non-empty
  // text and a tool-only turn has none) and rendered as truncated
  // JSON in the readonly viewer. The plan body must be surfaced as
  // assistant text so both surfaces get the full markdown.
  const r = parseLine(FIX_EXIT_PLAN_MODE);
  assert.ok(r);
  assert.strictEqual(r.role, 'assistant');
  assert.ok(r.text.includes('# /v2/orders — Cursor Pagination'),
    'plan markdown must appear in assistant.text — got: ' + JSON.stringify(r.text.slice(0, 200)));
  // ExitPlanMode itself should NOT remain in toolCalls — it would
  // double-surface (once as the text, once as a collapsed callout).
  const planTcs = (r.toolCalls || []).filter((tc) => tc.name === 'ExitPlanMode');
  assert.strictEqual(planTcs.length, 0, 'ExitPlanMode should be lifted out of toolCalls');
});

t('ExitPlanMode + text + sibling tool_use coexist correctly', () => {
  // Edge case: claude could conceivably narrate alongside the plan,
  // or pair ExitPlanMode with another tool_use. The plan goes into
  // text; the OTHER tool_use stays in toolCalls.
  const fix = JSON.stringify({
    type: 'assistant',
    uuid: 'mixed-uuid',
    timestamp: 't',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Quick narration before the plan.' },
        { type: 'tool_use', id: 'tu1', name: 'ExitPlanMode', input: { plan: '## The Plan', planFilePath: '/x' } },
        { type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });
  const r = parseLine(fix);
  assert.ok(r);
  assert.ok(r.text.includes('## The Plan'), 'plan must appear in text');
  assert.ok(r.text.includes('Quick narration'), 'narration must coexist with plan');
  assert.strictEqual(r.toolCalls.length, 1, 'only the Bash call should remain in toolCalls');
  assert.strictEqual(r.toolCalls[0].name, 'Bash');
});

// ─── AskUserQuestion summary (readable, not 150-char JSON stub) ───────

t('AskUserQuestion summary renders questions + options as readable text', () => {
  // Regression: demo010 had 24 AskUserQuestion tool_uses whose .input
  // was a rich questions/options shape, but summarizeToolInput's generic
  // fallback collapsed each to ~150 chars of escaped JSON — unreadable
  // in the readonly viewer's tool callout. The custom branch must render
  // question text + option labels on their own lines (newlines are
  // preserved by .conv-tool-body { white-space: pre-wrap }).
  const fix = JSON.stringify({
    type: 'assistant',
    uuid: 'auq-uuid',
    timestamp: '2026-05-12T17:14:41.000Z',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_auq_01',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Pagination style?',
                header: 'Page',
                multiSelect: false,
                options: [
                  { label: 'Cursor', description: 'Opaque base64 keyset' },
                  { label: 'Offset', description: 'Legacy limit/offset' },
                ],
              },
              {
                question: 'Telemetry hooks?',
                header: 'Tel',
                multiSelect: true,
                options: [
                  { label: 'Slow-query alert', description: 'Sentry rule' },
                  { label: 'Decode counter', description: 'Prometheus' },
                ],
              },
            ],
          },
        },
      ],
    },
  });
  const r = parseLine(fix);
  assert.ok(r);
  assert.strictEqual(r.toolCalls.length, 1);
  const s = r.toolCalls[0].summary;
  // Sanity: not JSON soup
  assert.ok(!s.startsWith('{"questions":'), 'summary should not be raw JSON');
  // Both questions present
  assert.ok(s.includes('Pagination style?'), 'Q1 text missing');
  assert.ok(s.includes('Telemetry hooks?'), 'Q2 text missing');
  // Option labels present
  assert.ok(s.includes('Cursor'), 'option label Cursor missing');
  assert.ok(s.includes('Slow-query alert'), 'option label Slow-query alert missing');
  // Option descriptions joined onto their labels
  assert.ok(s.includes('Opaque base64 keyset'), 'option description missing');
  // Multi-line shape so .conv-tool-body { white-space: pre-wrap } can
  // render each question + option on its own line.
  assert.ok(s.split('\n').length >= 4, 'expected multi-line summary, got: ' + JSON.stringify(s));
});

// ─── Output-pattern coverage (Task* family, ToolSearch, EnterPlanMode) ────

t('TaskCreate / TaskUpdate / TaskOutput summarise to readable text', () => {
  // Task* tools are the most-used unhandled family in real JSONLs
  // (~650 occurrences in the local survey). Generic JSON.stringify[:150]
  // produced unreadable braces; the new branches yield human-readable
  // identifiers + status transitions.
  const mk = (toolName, input) => JSON.stringify({
    type: 'assistant',
    uuid: 'task-' + toolName,
    timestamp: '2026-05-14T07:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't' + toolName, name: toolName, input }],
    },
  });
  const r1 = parseLine(mk('TaskCreate', { subject: 'Wire chat-pane sync', description: '…' }));
  assert.ok(r1.toolCalls[0].summary.includes('Wire chat-pane sync'),
    'TaskCreate summary must use input.subject — got: ' + JSON.stringify(r1.toolCalls[0].summary));

  const r2 = parseLine(mk('TaskUpdate', { taskId: '7', status: 'completed', subject: 'tool tracker' }));
  const s2 = r2.toolCalls[0].summary;
  assert.ok(s2.includes('#7') && s2.includes('completed'),
    'TaskUpdate summary must show #id → status — got: ' + JSON.stringify(s2));

  const r3 = parseLine(mk('TaskOutput', { taskId: '12' }));
  assert.ok(r3.toolCalls[0].summary.includes('#12') && r3.toolCalls[0].summary.includes('output'),
    'TaskOutput summary must reference task id — got: ' + JSON.stringify(r3.toolCalls[0].summary));
});

t('ToolSearch + EnterPlanMode + WebSearch summarise to readable text', () => {
  const mk = (name, input) => JSON.stringify({
    type: 'assistant',
    uuid: 'misc-' + name,
    timestamp: 't',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'ts' + name, name, input }],
    },
  });
  assert.strictEqual(parseLine(mk('ToolSearch', { query: 'select:Read,Write' })).toolCalls[0].summary, 'select:Read,Write');
  assert.strictEqual(parseLine(mk('EnterPlanMode', {})).toolCalls[0].summary, '(entering plan mode)');
  assert.strictEqual(parseLine(mk('WebSearch', { query: 'Shenzhen weather' })).toolCalls[0].summary, 'Shenzhen weather');
});

t('agent-name top-level record surfaces as subagent frame', () => {
  // 183 of these in the local JSONLs; pre-fix they were silently
  // dropped. They mark subagent session-name transitions and should
  // render as inline markers in the readonly viewer.
  const fix = JSON.stringify({
    type: 'agent-name',
    agentName: 'Explore session summarization',
    sessionId: 'abc',
    uuid: 'an-uuid',
    timestamp: '2026-05-14T07:00:00.000Z',
  });
  const r = parseLine(fix);
  assert.ok(r);
  assert.strictEqual(r.role, 'subagent');
  assert.strictEqual(r.text, 'Explore session summarization');
});

t('attachment permission-mode surfaces as mode_change frame', () => {
  // 194 of these in the local JSONLs; pre-fix silently dropped.
  // Distinct from command_permissions (which carries an allow-list).
  const fix = JSON.stringify({
    type: 'attachment',
    attachment: { type: 'permission-mode', mode: 'plan' },
    uuid: 'pm-uuid',
    timestamp: '2026-05-14T07:00:00.000Z',
  });
  const r = parseLine(fix);
  assert.ok(r);
  assert.strictEqual(r.role, 'mode_change');
  assert.strictEqual(r.mode, 'plan');
});

// ─── Pre-existing branches still work (regression guards) ─────────────

t('user message branch still works after parser changes', () => {
  const fix = JSON.stringify({
    type: 'user',
    uuid: 'u1', timestamp: 't',
    message: { role: 'user', content: 'hello' },
  });
  const r = parseLine(fix);
  assert.ok(r);
  assert.strictEqual(r.role, 'user');
  assert.strictEqual(r.text, 'hello');
});

t('ai-title still works after parser changes', () => {
  const fix = JSON.stringify({ type: 'ai-title', aiTitle: 'My Session', uuid: 'u', timestamp: 't' });
  const r = parseLine(fix);
  assert.ok(r);
  assert.strictEqual(r.role, 'title');
  assert.strictEqual(r.text, 'My Session');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
