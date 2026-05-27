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

// ── Message format / send path ──────────────────────────────────────

t('app.js: r4 — _sendClarify ships via sendChatMessage with meta.kind=clarify (NOT form.requestSubmit)', () => {
  // r4 design pivot: clarify question must NOT pollute the main
  // chat window. Old r3 path injected into #chat-input + fired
  // form.requestSubmit() — that put the question into the visible
  // chat thread. New r4 path goes direct via sendChatMessage(text,
  // {meta:{kind:'clarify',...}}) which the server side filters out
  // of normal chat render via meta.kind matching.
  const idx = APP.search(/function\s+_sendClarify\s*\(/);
  assert.ok(idx > -1, '_sendClarify handler must be defined');
  const win = APP.slice(idx, idx + 4500);
  // Must call sendChatMessage with the meta arg.
  assert.ok(/sendChatMessage\([^,]+,\s*\{\s*meta:\s*\{\s*kind:\s*['"]clarify['"]/.test(win),
    '_sendClarify must call sendChatMessage(text, { meta: { kind: "clarify", ... } })');
  // Must include the selected text in meta so the server can pair
  // the eventual reply back to this anchor.
  assert.ok(/selected\b/.test(win),
    'meta must carry the selected text (selected: <range text>)');
  // Must NOT go via the chat-form submit anymore (that\'s what put
  // the question into the visible chat thread in r3).
  assert.ok(!/requestSubmit\(\)/.test(win),
    '_sendClarify must NOT call form.requestSubmit() — that polluted the main chat window in r3');
  assert.ok(!/dispatchEvent\(\s*new\s+Event\(\s*['"]submit['"]/.test(win),
    '_sendClarify must NOT synthesize a chat-form submit Event');
});

t('app.js: r4 — chat render skips clarify-tagged messages so they don\'t pollute chat', () => {
  // Both directions filtered: user's clarify question (meta.kind='clarify')
  // and claude's reply (meta.kind='clarify-reply').
  const idx = APP.search(/function\s+renderChatMessage\s*\(/);
  assert.ok(idx > -1, 'renderChatMessage must be defined');
  const win = APP.slice(idx, idx + 800);
  assert.ok(/clarify-reply/.test(win) && /clarify/.test(win),
    'renderChatMessage must early-return for messages with meta.kind="clarify" or "clarify-reply"');
});

t('app.js: r4 — appendChatMessage skips clarify-tagged messages (no state.chatMessages bloat)', () => {
  const idx = APP.search(/function\s+appendChatMessage\s*\(/);
  assert.ok(idx > -1, 'appendChatMessage must be defined');
  const win = APP.slice(idx, idx + 800);
  assert.ok(/clarify-reply/.test(win) && /clarify/.test(win),
    'appendChatMessage must early-return for clarify-tagged messages — they belong in the popover only, not state.chatMessages');
});

t('app.js: r4 — WS handler routes t=clarify-reply frames to _handleClarifyReplyFrame', () => {
  assert.ok(/msg\.t === ['"]clarify-reply['"]/.test(APP),
    'WS dispatcher must branch on msg.t === "clarify-reply"');
  assert.ok(/_handleClarifyReplyFrame\(msg\)/.test(APP) ||
            /_handleClarifyReplyFrame\(\s*msg\s*\)/.test(APP),
    'clarify-reply branch must call _handleClarifyReplyFrame');
  assert.ok(/function\s+_handleClarifyReplyFrame\s*\(/.test(APP),
    '_handleClarifyReplyFrame handler must be defined');
});

t('app.js: r4 — _clarifyState tracks questionTs so the right popover gets the reply', () => {
  // The popover-as-response-surface model means a clarify-reply WS
  // frame has to be matched back to the in-flight clarify by ts —
  // otherwise a stale frame from a closed popover could mutate a
  // new one.
  assert.ok(/_clarifyState\s*=\s*\{/.test(APP),
    '_clarifyState object must exist');
  const idx = APP.search(/function\s+_handleClarifyReplyFrame\s*\(/);
  const win = APP.slice(idx, idx + 500);
  assert.ok(/_clarifyState\.questionTs/.test(win) &&
            /payload\.questionTs/.test(win),
    'reply handler must compare payload.questionTs against _clarifyState.questionTs before rendering');
});

t('app.js: r4 — sendChatMessage accepts optional opts.meta + forwards it on the WS frame', () => {
  const idx = APP.search(/function\s+sendChatMessage\s*\(text(?:,\s*opts)?\)/);
  assert.ok(idx > -1, 'sendChatMessage(text, opts) signature must exist');
  const win = APP.slice(idx, idx + 1500);
  assert.ok(/opts\.meta/.test(win) || /opts && opts\.meta/.test(win),
    'sendChatMessage must read opts.meta');
  assert.ok(/frame\.meta\s*=/.test(win),
    'sendChatMessage must attach opts.meta onto the outbound WS frame');
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
