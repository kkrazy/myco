// fr-85: inline clarification popovers on highlighted spans of a
// Claude response.
//
// User-confirmed shape (via AskUserQuestion):
//   Trigger:  select text in a claude bubble → popover anchored to
//             the selection
//   Action:   inline text input → on submit, sends
//             `[clarify: "<selected>"] <user question>` to chat
//   Response: regular new claude reply via the standard chat path;
//             the anchor span gets a subtle visual marker so the
//             user can see what got clarified
//
// Static-grep guards. Runtime selection/popover behavior belongs
// in a browser test (none in this project's runner) — these checks
// pin the structural contract a future refactor can't silently
// break.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── fr-85: inline clarification popovers on claude bubbles ──');

// ── Wiring ───────────────────────────────────────────────────────────

t('app.js: _setupChatClarify entry point exists', () => {
  assert.ok(/function\s+_setupChatClarify\s*\(\s*\)/.test(APP),
    '_setupChatClarify() must be defined');
});

t('app.js: _setupChatClarify is invoked at page init', () => {
  // Pin that the setup function gets called somewhere — not just
  // declared and orphaned.
  assert.ok(/_setupChatClarify\(\)/.test(APP),
    '_setupChatClarify() must be called (not just defined)');
});

// ── Trigger: selection inside a claude bubble ───────────────────────

t('app.js: popover trigger scopes to .chat-msg.from-claude .chat-text only', () => {
  // User messages + agent cards + menus must NOT show the popover.
  // The bubble-check helper is a sibling of _setupChatClarify; slice
  // the whole fr-85 region (between the marker comment and the end
  // of the file) and assert both the .from-claude and .chat-text
  // selectors live somewhere in there.
  const startIdx = APP.search(/fr-85:\s*inline clarification popovers/i);
  assert.ok(startIdx > -1, 'fr-85 region marker comment must exist');
  const region = APP.slice(startIdx);
  assert.ok(/from-claude/.test(region),
    'trigger logic must check for the .from-claude class so user messages + agent cards don\'t accidentally trigger');
  assert.ok(/chat-text/.test(region),
    'trigger logic must scope to .chat-text (the rendered body, not the byline/timestamps)');
});

// ── Popover markup ──────────────────────────────────────────────────

t('app.js: popover has a text input + Send button', () => {
  // Find the popover-construction helper (or open-popover function).
  // Look for the markup string that includes both an <input> /
  // <textarea> AND a "Send" / "Ask" button.
  assert.ok(/chat-clarify-popover/.test(APP),
    'popover element must use a #chat-clarify-popover id or class anchor');
  assert.ok(/chat-clarify-input/.test(APP),
    'popover must contain an input with #chat-clarify-input id');
  assert.ok(/chat-clarify-send/.test(APP),
    'popover must contain a send button with #chat-clarify-send id');
});

// ── Message format ──────────────────────────────────────────────────

t('app.js: submit builds `[clarify: "..."] <question>` and ships via chat', () => {
  // Pin the exact prefix shape so claude (and any agent on the other
  // end) can recognize the clarify intent.
  assert.ok(/\[clarify:\s*"\$\{[^}]+\}"\]/.test(APP) ||
            /\[clarify:\s*"\$\{[^}]+\}"\]\s+\$\{[^}]+\}/.test(APP),
    'submit must build a `[clarify: "<selected>"] <question>` message');
  // Routes through the same chat send path the composer uses — so
  // guest gates / history push / persistence all apply uniformly.
  // Either submitChat-via-form-submit OR direct sendChatMessage are
  // acceptable; pin one of them present in the clarify handler.
  const idx = APP.search(/function\s+_sendClarify\s*\(/);
  assert.ok(idx > -1, '_sendClarify handler must be defined');
  // Slice big enough to cover the whole function body. The actual
  // implementation can be up to ~3000 chars (the try/catch around
  // surroundContents, the composer-input assignment, the form
  // lookup, the submit-or-dispatch fallback).
  const win = APP.slice(idx, idx + 3000);
  assert.ok(
    /sendChatMessage\(/.test(win) ||
    /requestSubmit\(\)/.test(win) ||
    /dispatchEvent\(\s*new\s+Event\(\s*['"]submit['"]/.test(win),
    '_sendClarify must dispatch through the normal chat send path (sendChatMessage / form.requestSubmit / submit Event)'
  );
});

// ── Anchor marker (visual cue on the original selection) ────────────

t('css: .chat-clarify-anchor rule exists with subtle marker styling', () => {
  assert.ok(/\.chat-clarify-anchor\s*\{/.test(CSS),
    '.chat-clarify-anchor CSS rule must exist');
  // Should be a SUBTLE marker — underline / background / border-bottom.
  // Not a loud full-bg highlight.
  const idx = CSS.search(/\.chat-clarify-anchor\s*\{/);
  const win = CSS.slice(idx, idx + 400);
  assert.ok(/border-bottom|text-decoration|background/.test(win),
    'anchor marker must use border-bottom / text-decoration / background for visual cue');
});

t('app.js: selected range is wrapped in .chat-clarify-anchor on submit (visual cue)', () => {
  // After submit, the original selected text in the bubble gets
  // wrapped in a span.chat-clarify-anchor so the user can scroll back
  // and see what got clarified. surroundContents() is the standard
  // Range API for this.
  assert.ok(/chat-clarify-anchor/.test(APP),
    'submit must add a .chat-clarify-anchor class to mark the source span');
  assert.ok(/surroundContents\(/.test(APP) || /insertBefore\(/.test(APP) ||
            /appendChild\(/.test(APP),
    'wrapping the selected range must use a Range API (surroundContents) or DOM insertion');
});

// ── Cleanup behavior ────────────────────────────────────────────────

t('app.js: popover closes on Escape', () => {
  const idx = APP.search(/function\s+_closeClarifyPopover\s*\(\s*\)/);
  assert.ok(idx > -1, '_closeClarifyPopover must be defined');
  // Esc handler somewhere — either in the setup or as a doc-level keydown.
  assert.ok(/['"]Escape['"]/.test(APP) && /_closeClarifyPopover/.test(APP),
    'Escape key handler must call _closeClarifyPopover');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
