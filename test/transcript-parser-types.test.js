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
