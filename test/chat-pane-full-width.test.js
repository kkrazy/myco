// User: "the chat pane should be allowed to be as wide as the screen."
//
// In single-pane chat mode (no artifact open) on wide screens, the chat
// column was centered at max-width: 880px for line-length readability.
// The user wants it to fill the full pane width instead. Fix: relax the
// single-pane .chat-main-view content cap to max-width: none.
//
// (The side-by-side "#terminal-pane.has-artifact …" block already used
// max-width: none — only the standalone single-pane block capped at
// 880px.)

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const CSS = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── chat pane: full-width (no 880px cap) ──');

t('the single-pane chat column rule body contains no 880px cap', () => {
  // Scoped to the chat-main-view content rule (NOT the Plan-view
  // max-width:880px at fr-77, which is a different surface and stays).
  const idx = CSS.indexOf('#chatpane.chat-main-view #chat-messages,');
  assert.ok(idx > -1, 'single-pane chat-main-view content rule must exist');
  const braceStart = CSS.indexOf('{', idx);
  const braceEnd = CSS.indexOf('}', braceStart);
  const body = CSS.slice(braceStart, braceEnd);
  assert.ok(!/880px/.test(body),
    'the chat column rule body must no longer cap at 880px');
});

t('single-pane #chatpane.chat-main-view #chat-messages sets max-width: none', () => {
  // Find the standalone single-pane rule (the one NOT prefixed with
  // #terminal-pane.has-artifact) and confirm its max-width is none.
  const idx = CSS.indexOf('#chatpane.chat-main-view #chat-messages,');
  assert.ok(idx > -1, 'single-pane chat-main-view content rule must exist');
  // The matched selector must NOT be the has-artifact sidebar variant.
  const lineStart = CSS.lastIndexOf('\n', idx);
  const selLine = CSS.slice(lineStart, idx + 60);
  assert.ok(!/has-artifact/.test(selLine),
    'sanity: matched the standalone single-pane rule, not the has-artifact sidebar one');
  // Grab the rule body and assert max-width: none.
  const braceStart = CSS.indexOf('{', idx);
  const braceEnd = CSS.indexOf('}', braceStart);
  const body = CSS.slice(braceStart, braceEnd);
  assert.ok(/max-width:\s*none/.test(body),
    'the single-pane chat column must use max-width: none so it fills the screen width');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
