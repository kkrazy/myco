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

t('app.js: popover trigger covers BOTH claude bubble (.chat-msg.from-claude .chat-text) AND agent-replay card (.agent-card-assistant_text .agent-card-md)', () => {
  // r2 fix: original v1 only matched chat-history bubbles. Claude's
  // text on first attach typically lands in an agent-replay card
  // (.agent-card-assistant_text .agent-card-md) instead — selecting
  // text there did nothing. Both surfaces are valid trigger targets.
  const startIdx = APP.search(/fr-85:\s*inline clarification popovers/i);
  assert.ok(startIdx > -1, 'fr-85 region marker comment must exist');
  const region = APP.slice(startIdx);
  // Bubble path
  assert.ok(/from-claude/.test(region),
    'trigger logic must check the .from-claude bubble path');
  assert.ok(/chat-text/.test(region),
    'bubble path must scope to .chat-text');
  // Agent-card path
  assert.ok(/agent-card-assistant_text/.test(region),
    'trigger logic must ALSO accept the agent-card .agent-card-assistant_text surface (where claude text lives in agent-replay)');
  assert.ok(/agent-card-md/.test(region),
    'agent-card path must scope to .agent-card-md (the markdown body)');
});

t('app.js: no document-level `selectionchange` listener inside the fr-85 region', () => {
  // selectionchange fires during a drag, before the user is done.
  // Opening the popover at the first selectionchange steals focus
  // from the user's drag — they think nothing happened. mouseup /
  // pointerup is the right "user finished selecting" signal.
  // The fr-85 region spans from its marker comment to the next
  // top-level `// ── ` section divider — slice that exact range so
  // we don't false-positive on unrelated selectionchange listeners
  // elsewhere in app.js (there's one for native-mobile selection
  // callout that's unrelated to clarify).
  const startIdx = APP.search(/fr-85:\s*inline clarification popovers/i);
  assert.ok(startIdx > -1, 'fr-85 region marker comment must exist');
  // Find the next top-level section divider (// ── ) after the marker.
  const after = APP.slice(startIdx);
  const endRel = after.search(/\n\/\/\s*── /);
  const region = endRel > -1 ? after.slice(0, endRel) : after.slice(0, 12000);
  assert.ok(!/document\.addEventListener\(\s*['"]selectionchange['"]/.test(region),
    'fr-85 region must NOT wire selectionchange — race condition during drag-select');
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

t('app.js: r3 — popover left + width come from #chat-messages bbox (not the selection)', () => {
  // User: "the pop up should always left align with the chat window
  // and below the content highlighted, with width the same as the
  // chat window".
  // Position formula must read #chat-messages.getBoundingClientRect()
  // for left + width; only the vertical anchor (top) still comes
  // from the selection's bbox.
  const idx = APP.search(/function\s+_openClarifyPopover\s*\(\s*\)/);
  assert.ok(idx > -1, '_openClarifyPopover must exist');
  // r3 made the function longer (chat-rect lookup + width set);
  // widen the slice past the position-set lines.
  const win = APP.slice(idx, idx + 4500);
  // Must look up #chat-messages for horizontal alignment.
  assert.ok(/getElementById\(['"]chat-messages['"]\)/.test(win) ||
            /querySelector\(['"]#chat-messages['"]\)/.test(win),
    '_openClarifyPopover must read #chat-messages for horizontal alignment');
  // Must call .getBoundingClientRect() on the chat-messages element.
  assert.ok(/\.getBoundingClientRect\(\)/.test(win),
    '_openClarifyPopover must compute the chat window\'s bbox');
  // Must explicitly set width on the popover (chat-window width, not
  // the old fixed 360 px).
  assert.ok(/(pop|popover)\.style\.width\s*=/i.test(win),
    'popover must set style.width from JS (chat-window width, not a fixed CSS value)');
  // The OLD 360-fixed POP_W constant should be gone — it pinned the
  // wrong width model. A guard against a future "let me just hardcode
  // it back" regression.
  assert.ok(!/POP_W\s*=\s*360/.test(win),
    'the fixed POP_W=360 constant must be gone — width now comes from chat-messages bbox');
});

t('app.js: r3 — vertical anchor still uses the selection\'s bottom (below the highlight)', () => {
  const idx = APP.search(/function\s+_openClarifyPopover\s*\(\s*\)/);
  const win = APP.slice(idx, idx + 4500);
  // Selection range provides `rect.bottom + scrollY` for the top.
  assert.ok(/rect\.bottom\s*\+\s*window\.scrollY/.test(win) ||
            /selRect\.bottom\s*\+\s*window\.scrollY/.test(win),
    'top position must still use the selection bbox\'s bottom (popover sits BELOW the highlight)');
});

t('css: #chat-clarify-popover no longer pins a fixed width', () => {
  // Width is now JS-driven per chat-window. CSS should NOT lock a
  // pixel width on the element — leave it loose so the JS value wins.
  // A `min-width` or `max-width` is fine; a fixed `width: <px>;` is
  // what we're guarding against.
  const idx = CSS.search(/#chat-clarify-popover\s*\{/);
  assert.ok(idx > -1, '#chat-clarify-popover rule must exist');
  const win = CSS.slice(idx, idx + 800);
  // No literal `width: 360px` (or similar pinned px) inside the base
  // rule. Match `width:` followed by a digit + px (a hard pixel pin)
  // but NOT prefixed by min-/max-.
  assert.ok(!/(?<!(min-|max-))width:\s*\d+px/.test(win),
    '#chat-clarify-popover base rule must not pin a fixed pixel width — JS sets it from chat-window bbox now');
});

t('app.js: popover closes on Escape', () => {
  const idx = APP.search(/function\s+_closeClarifyPopover\s*\(\s*\)/);
  assert.ok(idx > -1, '_closeClarifyPopover must be defined');
  // Esc handler somewhere — either in the setup or as a doc-level keydown.
  assert.ok(/['"]Escape['"]/.test(APP) && /_closeClarifyPopover/.test(APP),
    'Escape key handler must call _closeClarifyPopover');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
