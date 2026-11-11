// Relabel the assistant's DISPLAYED name from "claude"/"Claude" to
// "myco" on every response surface.
//
// User: "make the response bubble from claude, labeled 'claude' to
// 'myco'." Confirmed scope = everywhere a response is labelled: the
// file-viewer reply cards, the chat-pane agent card, the main chat
// bubble author name, and the "…is thinking" / "Delete this … reply?"
// strings.
//
// IMPORTANT: this is a DISPLAY-only relabel. The data key stays
// `claude` — `m.user === 'claude'` matching and ASSISTANT_USER_NAME =
// 'claude' must be UNCHANGED, or persisted records + server payloads
// stop matching.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── relabel assistant display name claude → myco ──');

t('agent-event card label reads "myco" (not "claude")', () => {
  // The .agent-card-claude CLASS may stay (it's a style hook); only the
  // visible text changes.
  assert.ok(/agent-card-claude">myco</.test(APP),
    'the assistant_text agent card must label the speaker "myco"');
  assert.ok(!/agent-card-claude">claude</.test(APP),
    'the agent card must NOT still label the speaker "claude"');
});

t('file-viewer reply + pending cards read "💬 myco" (not "💬 Claude")', () => {
  assert.ok(/💬 myco/.test(APP),
    'renderClaudeCard / renderPendingCard headers must read "💬 myco"');
  assert.ok(!/💬 Claude/.test(APP),
    'no file-viewer card header may still read "💬 Claude"');
});

t('clarify popover busy text reads "myco is thinking…"', () => {
  assert.ok(/myco is thinking/.test(APP),
    'the clarify popover busy state must say "myco is thinking…"');
  assert.ok(!/['"]claude is thinking/.test(APP),
    'the clarify busy text must not still say "claude is thinking"');
});

t('delete-confirm dialog reads "Delete this myco reply?"', () => {
  assert.ok(/Delete this myco reply/.test(APP),
    'the file-card delete confirm must say "myco"');
  assert.ok(!/Delete this Claude reply/.test(APP),
    'the delete confirm must not still say "Claude"');
});

t('main chat bubble maps the claude author name to "myco" at render', () => {
  // The chat bubble shows escHtml(m.user). For claude rows the DISPLAY
  // must map to "myco". We assert a 'claude' ? 'myco' display mapping
  // exists (the data field m.user stays 'claude').
  assert.ok(/===\s*['"]claude['"]\s*\?\s*['"]myco['"]/.test(APP),
    'the chat bubble author render must map m.user === "claude" → "myco" for display');
});

t('DATA KEY unchanged — ASSISTANT_USER_NAME + m.user === "claude" stay', () => {
  // The relabel must NOT touch the matching key, or persisted records
  // + server payloads (user:"claude") stop matching.
  assert.ok(/const\s+ASSISTANT_USER_NAME\s*=\s*['"]claude['"]/.test(APP),
    'ASSISTANT_USER_NAME must remain "claude" (data key, not display)');
  assert.ok(/m\.user === ['"]claude['"]/.test(APP),
    'the fromClaude check (m.user === "claude") must remain for styling/routing');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
