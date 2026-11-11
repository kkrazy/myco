// bug-19 regression: read-only viewer's chat input is silently dropped.
//
// Pre-fix flow in attach.js handleChatMessage:
//   1. readOnly + user !== ASSISTANT_USER → check guest-allowed commands
//   2. If NOT guest-OK → append + emit the denial reply, return.
//      The user's text never reaches line 1398's appendChatMessage,
//      so the typed message disappears entirely. The viewer has no
//      record of what they tried to send.
//
// Fix: in the read-only block, BEFORE emitting the denial, also
// append + emit the user's message tagged meta.kind='denied' so:
//   * The message is preserved in rec.chat (per the cross-device
//     persistence contract — every user input must persist).
//   * Other attached clients see what the viewer tried to send.
//   * The client can visually mark denied messages (e.g. muted /
//     strikethrough) so the user can see what was blocked.
//
// User's own clarification: "any message not successfully accepted by
// the chat pane should be preserved".

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const PROD_ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

console.log('── bug-19: read-only path preserves user text + denial reply ──');

// Locate the read-only block in handleChatMessage.
function _grabReadOnlyBlock(src) {
  const start = src.search(/if\s*\(\s*readOnly\s*&&\s*user\s*!==\s*ASSISTANT_USER\s*\)/);
  if (start === -1) return '';
  // Match to the closing brace of the if-block — find the next
  // `^  }$` indented brace OR ` const message = ` (start of next stmt).
  const rest = src.slice(start);
  const next = rest.search(/\n\s+const\s+message\s*=\s*\{/);
  return next === -1 ? rest : rest.slice(0, next);
}

t('read-only block exists in handleChatMessage', () => {
  const body = _grabReadOnlyBlock(PROD_ATTACH);
  assert.ok(body.length > 0, 'readOnly + !ASSISTANT_USER guard must exist');
});

t('read-only block appendChatMessage TWICE — once for the user text, once for the denial', () => {
  const body = _grabReadOnlyBlock(PROD_ATTACH);
  // The block must persist BOTH the user's text AND the denial reply.
  // Two appendChatMessage calls in the block — minimum count.
  const appends = (body.match(/sessionsMod\.appendChatMessage\s*\(/g) || []).length;
  assert.ok(appends >= 2,
    `read-only block must call appendChatMessage at least twice (once for the user text, once for the denial reply). Found ${appends}.`);
});

t('read-only block emits the user message tagged meta.kind="denied"', () => {
  const body = _grabReadOnlyBlock(PROD_ATTACH);
  // The user-message persist must carry meta.kind:'denied' so the
  // client can visually distinguish blocked messages from accepted ones.
  assert.match(body, /meta:\s*\{\s*kind:\s*['"`]denied['"`]/,
    'read-only block must tag the persisted user message with meta.kind:"denied" so the client can render it visually distinct');
});

t('read-only block persists user text BEFORE the denial reply (chronological order)', () => {
  const body = _grabReadOnlyBlock(PROD_ATTACH);
  // The user's text must hit appendChatMessage first; the denial
  // reply lands after. Otherwise the chat pane shows the denial
  // BEFORE the user's text (broken chronology).
  const deniedIdx = body.search(/kind:\s*['"`]denied['"`]/);
  const replyIdx = body.search(/(read-only viewer|denyMsg)/);
  assert.ok(deniedIdx > -1, 'denied-marker must be in the block');
  assert.ok(replyIdx > -1, 'denial-reply construction must be in the block');
  assert.ok(deniedIdx < replyIdx,
    'the denied-tagged user message must appear in source order BEFORE the denial reply construction — chat pane renders in append order');
});

t('read-only block does NOT short-circuit before persisting user text', () => {
  const body = _grabReadOnlyBlock(PROD_ATTACH);
  // Negative guard: a `return` statement before the denied-tagged
  // appendChatMessage would silently drop the user text again.
  const firstAppendIdx = body.search(/sessionsMod\.appendChatMessage/);
  const firstReturnIdx = body.search(/\breturn;/);
  assert.ok(firstAppendIdx > -1, 'at least one appendChatMessage must exist in the block');
  if (firstReturnIdx > -1) {
    assert.ok(firstAppendIdx < firstReturnIdx,
      'at least one appendChatMessage (the user-text persist) must come BEFORE any return — otherwise user text is silently dropped (bug-19 regression)');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
