// Feature: file-explorer "ask about highlighted code" input.
//
// User: "in the file explorer, when highlight a piece of code, add an
// input field for me to ask about the code highlighted."
//
// The file viewer already had a selection action bar (#files-action-bar)
// with preset buttons (Explain / Find bugs / Add comment) and a
// custom-question path (askClaudeAboutSelection('ask', text)) — but no
// input wired to it. This adds a free-text input + send so the user can
// type their own question about the highlighted line range. The answer
// renders as a card in the file viewer (same pipeline as the presets).
//
// Guards:
//   1. index.html — #files-ask-input + #files-ask-send live inside
//      #files-action-bar.
//   2. app.js — the input (Enter) and send button both call
//      askClaudeAboutSelection('ask', <input value>).
//   3. app.js — onSelectionChange does NOT tear the bar down while the
//      user is focused inside it (clicking the input collapses the code
//      selection, which would otherwise hide the bar + null the anchor).
//   4. styles.css — the ask row + input have styling.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── files: ask-about-highlighted-code input ──');

t('index.html: #files-action-bar contains #files-ask-input + #files-ask-send', () => {
  const start = HTML.indexOf('id="files-action-bar"');
  assert.ok(start > -1, '#files-action-bar must exist');
  // The action bar closes at the next </div> that balances it; grab a
  // generous window and assert both new controls live within it.
  const win = HTML.slice(start, start + 1200);
  assert.ok(/id="files-ask-input"/.test(win),
    'a text input #files-ask-input must live inside #files-action-bar');
  assert.ok(/id="files-ask-send"/.test(win),
    'a send button #files-ask-send must live inside #files-action-bar');
  // The input should be a text field with a helpful placeholder.
  assert.ok(/id="files-ask-input"[^>]*placeholder=/i.test(win),
    '#files-ask-input must have a placeholder prompting the user to ask');
});

t('app.js: send button + Enter both route to askClaudeAboutSelection("ask", <value>)', () => {
  // There must be a wiring block that reads #files-ask-input and calls
  // askClaudeAboutSelection('ask', ...). We assert the call exists with
  // the 'ask' action and that it pulls the input's value.
  assert.ok(/askClaudeAboutSelection\(\s*['"]ask['"]/.test(APP),
    'app.js must call askClaudeAboutSelection("ask", ...) for the free-text question');
  // The handler must reference the input element id.
  assert.ok(/files-ask-input/.test(APP),
    'app.js must read #files-ask-input to get the typed question');
  assert.ok(/files-ask-send/.test(APP),
    'app.js must wire the #files-ask-send button');
  // Enter-to-send: a keydown/keypress handler checking for Enter near
  // the ask-input wiring.
  assert.ok(/files-ask-input[\s\S]{0,900}(['"]Enter['"]|key\s*===\s*['"]Enter['"])/.test(APP),
    'app.js must submit on Enter in #files-ask-input');
});

t('app.js: onSelectionChange bails while focus is inside the action bar', () => {
  // Clicking into the ask input collapses the code-body selection,
  // firing selectionchange. Without a guard, onSelectionChange would
  // hideActionBar() + null v.selection, destroying the anchor mid-type.
  const idx = APP.search(/function\s+onSelectionChange\s*\(/);
  assert.ok(idx > -1, 'onSelectionChange must be defined');
  const win = sliceFn(APP, idx);
  // Guard: an early return when the focused element is within
  // #files-action-bar (or specifically the ask input).
  assert.ok(
    /files-action-bar[\s\S]{0,500}(contains\(\s*document\.activeElement|activeElement)/.test(win)
      || /document\.activeElement[\s\S]{0,200}files-ask-input/.test(win),
    'onSelectionChange must early-return when focus is inside #files-action-bar so typing a question does not tear the bar down');
});

t('styles.css: ask row + input have styling', () => {
  assert.ok(/#files-ask-input\s*\{/.test(CSS),
    '#files-ask-input must have a CSS rule');
  assert.ok(/#files-ask-send\s*\{/.test(CSS),
    '#files-ask-send must have a CSS rule');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
