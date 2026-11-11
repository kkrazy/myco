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
const { sliceFn } = require('./_lib/fn-body');

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
  const win = sliceFn(APP, idx);
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
  //
  // f71495f refactored the skip-check out of renderChatMessage into a
  // helper `_shouldSkipMessageRender(m)`. Behaviour is preserved — the
  // function still skips clarify rows — but the literal 'clarify'
  // string moved from renderChatMessage's body into the helper. This
  // guard now accepts EITHER pattern:
  //   (a) renderChatMessage's window contains the literal clarify
  //       check (legacy in-function shape), OR
  //   (b) renderChatMessage calls _shouldSkipMessageRender AND that
  //       helper contains the clarify check (post-f71495f delegation).
  // The semantic contract — "clarify-tagged messages are filtered" —
  // is what's being locked, not a specific code shape.
  const idx = APP.search(/function\s+renderChatMessage\s*\(/);
  assert.ok(idx > -1, 'renderChatMessage must be defined');
  const win = sliceFn(APP, idx);
  const directHasClarify = /clarify-reply/.test(win) && /clarify/.test(win);
  if (directHasClarify) return;                                     // legacy shape: in-function check passes

  // Delegation shape: renderChatMessage calls a skip helper that
  // contains the clarify check.
  const callsHelper = /_shouldSkipMessageRender\s*\(/.test(win);
  assert.ok(callsHelper,
    'renderChatMessage must skip clarify-tagged messages — either by an in-function check OR by calling a helper like _shouldSkipMessageRender(m).');
  const helperAt = APP.search(/function\s+_shouldSkipMessageRender\s*\(/);
  assert.ok(helperAt > -1, '_shouldSkipMessageRender helper must be defined when renderChatMessage delegates to it');
  const helperWin = sliceFn(APP, helperAt);
  assert.ok(/clarify-reply/.test(helperWin) && /clarify/.test(helperWin),
    '_shouldSkipMessageRender must check meta.kind for "clarify" and "clarify-reply" — that\'s where renderChatMessage now delegates the skip decision after f71495f.');
});

t('app.js: r4 — appendChatMessage skips clarify-tagged messages (no state.chatMessages bloat)', () => {
  const idx = APP.search(/function\s+appendChatMessage\s*\(/);
  assert.ok(idx > -1, 'appendChatMessage must be defined');
  const win = sliceFn(APP, idx);
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
  const win = sliceFn(APP, idx);
  assert.ok(/_clarifyState\.questionTs/.test(win) &&
            /payload\.questionTs/.test(win),
    'reply handler must compare payload.questionTs against _clarifyState.questionTs before rendering');
});

t('app.js: r4 — sendChatMessage accepts optional opts.meta + forwards it on the WS frame', () => {
  const idx = APP.search(/function\s+sendChatMessage\s*\(text(?:,\s*opts)?\)/);
  assert.ok(idx > -1, 'sendChatMessage(text, opts) signature must exist');
  const win = sliceFn(APP, idx);
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
  // r4 refactor: the position-compute code moved out of
  // _openClarifyPopover into a dedicated _clarifyReposition helper
  // (so it can be called on scroll/resize too). Pin the contract
  // there instead.
  const idx = APP.search(/function\s+_clarifyReposition\s*\(\s*\)/);
  assert.ok(idx > -1, '_clarifyReposition must exist');
  const win = sliceFn(APP, idx);
  // Must look up #chat-messages for horizontal alignment.
  assert.ok(/getElementById\(['"]chat-messages['"]\)/.test(win) ||
            /querySelector\(['"]#chat-messages['"]\)/.test(win),
    '_clarifyReposition must read #chat-messages for horizontal alignment');
  // Must call .getBoundingClientRect() (on chat-messages AND on the anchor).
  assert.ok(/\.getBoundingClientRect\(\)/.test(win),
    '_clarifyReposition must compute the chat window\'s bbox');
  // Must explicitly set width on the popover (chat-window width).
  assert.ok(/(pop|popover)\.style\.width\s*=/i.test(win),
    'popover must set style.width from JS (chat-window width)');
  // The OLD 360-fixed POP_W constant should be gone.
  assert.ok(!/POP_W\s*=\s*360/.test(win),
    'the fixed POP_W=360 constant must be gone — width comes from chat-messages bbox');
});

t('app.js: r3 — vertical anchor still uses the anchor bbox\'s bottom (below the highlight)', () => {
  // Same r4 relocation — anchor-bottom-driven top now lives in
  // _clarifyReposition.
  const idx = APP.search(/function\s+_clarifyReposition\s*\(\s*\)/);
  const win = sliceFn(APP, idx);
  assert.ok(/rect\.bottom\s*\+\s*window\.scrollY/.test(win) ||
            /selRect\.bottom\s*\+\s*window\.scrollY/.test(win),
    'top position must use the anchor bbox\'s bottom (popover sits BELOW the highlight)');
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

t('app.js: r4 — popover follows chat scroll (re-positions on #chat-messages scroll + window resize)', () => {
  // User: "when I scroll the popover should scroll together with the
  // main chat until I click 'x' to close it". Without this the popover
  // sits at its initial absolute position while the chat scrolls
  // underneath — looks visually broken.
  // Pin: there's a scroll listener attached to #chat-messages AND a
  // resize listener (window or document) for viewport-size changes.
  // Both must call a reposition helper that re-reads the anchor bbox.
  assert.ok(/function\s+_clarifyReposition\s*\(/.test(APP),
    '_clarifyReposition helper must be defined (re-reads anchor bbox + updates popover style.top/left)');
  // Pin that the scroll listener is wired and the handler is named
  // so the close path can detach it cleanly (anonymous handlers
  // can\'t be removeEventListener\'d).
  assert.ok(/addEventListener\(\s*['"]scroll['"][\s\S]{0,200}_clarifyReposition/.test(APP) ||
            /chat-messages[\s\S]{0,300}addEventListener\(\s*['"]scroll['"][\s\S]{0,200}_clarify/.test(APP),
    'must add a scroll listener on #chat-messages that triggers _clarifyReposition');
  assert.ok(/addEventListener\(\s*['"]resize['"][\s\S]{0,200}_clarifyReposition/.test(APP) ||
            /window\.addEventListener\([\s\S]{0,100}resize[\s\S]{0,200}_clarify/.test(APP),
    'must add a window resize listener too (viewport resize moves the anchor)');
});

t('app.js: r4 — close removes the scroll + resize listeners (no leak when × clicked)', () => {
  const idx = APP.search(/function\s+_closeClarifyPopover\s*\(\s*\)/);
  assert.ok(idx > -1, '_closeClarifyPopover must be defined');
  const win = sliceFn(APP, idx);
  assert.ok(/removeEventListener\(\s*['"]scroll['"]/.test(win),
    '_closeClarifyPopover must removeEventListener("scroll", ...)');
  assert.ok(/removeEventListener\(\s*['"]resize['"]/.test(win),
    '_closeClarifyPopover must removeEventListener("resize", ...)');
});

t('app.js: r5 — popover has a dedicated input row (input + send + close in one flex row)', () => {
  // User: "move the -> and x to the same line as the input field".
  // Pin the markup shape so the input row is a single container that
  // CSS can flex-row, with the input expanding and the two buttons
  // staying fixed-size on the right.
  assert.ok(/chat-clarify-input-row/.test(APP),
    'popover markup must include a .chat-clarify-input-row wrapper around the input + send + close buttons');
});

t('css: r5 — popover stacks preview ON TOP, input row BELOW (always column-flex)', () => {
  // Was: row-flex with preview / input / send / close as siblings.
  // Now: column-flex always — preview full-width on top, input row
  // (input + send + close) below.
  const idx = CSS.search(/#chat-clarify-popover\s*\{/);
  assert.ok(idx > -1, '#chat-clarify-popover rule must exist');
  const win = CSS.slice(idx, idx + 1500);
  assert.ok(/flex-direction:\s*column/.test(win),
    '#chat-clarify-popover must be flex-direction:column (preview on top, input row below)');
  // Input row itself must be row-flex so the buttons sit beside the input.
  assert.ok(/\.chat-clarify-input-row\s*\{[\s\S]{0,400}flex-direction:\s*row/.test(CSS) ||
            /\.chat-clarify-input-row\s*\{[\s\S]{0,400}display:\s*flex/.test(CSS),
    '.chat-clarify-input-row must be flex (default row) so input + send + close sit on one line');
});

t('css: r5 — preview is full-width (no narrow max-width cap)', () => {
  // Was: max-width 100px → preview only showed ~10-15 chars before
  // ellipsis. User: "the title should occupy the entire space to
  // show as much of the selected text as possible, right now it
  // shows a very short text".
  const previewIdx = CSS.search(/\.chat-clarify-preview\s*\{/);
  assert.ok(previewIdx > -1, '.chat-clarify-preview rule must exist');
  const win = CSS.slice(previewIdx, previewIdx + 500);
  assert.ok(!/max-width:\s*100px/.test(win),
    'preview must NOT cap at 100px (was the bug — only ~15 chars visible)');
});

t('app.js: r5 — preview truncation bumped to ≥ 200 chars (was 60)', () => {
  // The JS truncate cap was 60 chars; user wants more. Match anything
  // >= 200 (no hard upper bound) so the preview shows ~one or two
  // sentences.
  const m = APP.match(/selectedText\.length\s*>\s*(\d+)\s*\?\s*selectedText\.slice\(\s*0\s*,\s*(\d+)/);
  assert.ok(m, 'truncate logic must be findable');
  const lengthCap = parseInt(m[1], 10);
  assert.ok(lengthCap >= 200,
    `preview truncate length cap must be ≥ 200 (got ${lengthCap}) so a one-or-two-sentence selection fits without ellipsis`);
});

t('app.js: r5 — anchor out of chat-messages viewport hides popover (re-shows on scroll back)', () => {
  // User: "the popover should stay even if it's scrolled out of view,
  // it should come back when I scroll back to the same location".
  // _clarifyReposition must compare the anchor's rect against the
  // chat-messages container's rect and toggle visibility — NOT close
  // the popover. State stays alive; only the visibility flips.
  const idx = APP.search(/function\s+_clarifyReposition\s*\(\s*\)/);
  assert.ok(idx > -1, '_clarifyReposition must exist');
  const win = sliceFn(APP, idx);
  // Must compute the chat-messages bbox AND compare it to the anchor bbox.
  // (chatRect is already read for left/width; now also used for visibility.)
  assert.ok(/visibility/.test(win),
    'reposition must toggle popover.style.visibility based on anchor in/out of chat viewport');
  // The compare uses anchor bottom > chat top AND anchor top < chat bottom
  // (some form of intersection test). Loose-anchor: just look for both
  // sides of the comparison together.
  assert.ok(/(chatRect|chatList|chatBox)\.(top|bottom)/.test(win),
    'must read chat-messages bbox top/bottom for the visibility check');
});

t('app.js: r5 — no auto-close on outside click (popover only closes on × / Esc)', () => {
  // User: "clicking on the chat composer shouldn't dissolve the
  // popover either". Pattern from prior rounds (scroll-persistent,
  // viewport-persistent): the popover is persistent state, only
  // explicit dismissal closes it. The doc-level mousedown handler
  // that closed on outside-click is the wrong default for this UX.
  // Anchor on the fr-85 region so we don't false-positive on
  // unrelated document mousedown handlers in app.js.
  const startIdx = APP.search(/fr-85:\s*inline clarification popovers/i);
  assert.ok(startIdx > -1, 'fr-85 region marker comment must exist');
  const after = APP.slice(startIdx);
  const endRel = after.search(/\n\/\/\s*── /);
  const region = endRel > -1 ? after.slice(0, endRel) : after.slice(0, 20000);
  // Negative-guard: no document-level mousedown handler that calls
  // _closeClarifyPopover. (Esc keydown + × click stay.)
  assert.ok(
    !/document\.addEventListener\(\s*['"]mousedown['"][\s\S]{0,800}_closeClarifyPopover/.test(region),
    'fr-85 region must NOT close the popover on outside-click — only × button and Esc dismiss'
  );
});

t('app.js: r6 — popover width is inset from the chat-messages bbox (visible side spacing)', () => {
  // User: "the width should leave some spacing". r5 set
  // width = chatRect.width flush, which put the popover edges right
  // up against the chat-window edges. r6 insets by a horizontal margin
  // (≥ 8 px each side) so the popover floats inside the chat-window
  // padding instead of butting against it.
  const idx = APP.search(/function\s+_clarifyReposition\s*\(\s*\)/);
  assert.ok(idx > -1, '_clarifyReposition must be defined');
  const win = sliceFn(APP, idx);
  // Width must subtract a positive horizontal-margin literal (not
  // chatRect.width on its own). Accept any explicit subtraction.
  assert.ok(
    /chatRect\.width\s*-\s*(?:\d+|[A-Za-z_$][\w$]*\s*\*\s*2|2\s*\*\s*[A-Za-z_$][\w$]*)/.test(win),
    'r6: width must be chatRect.width minus a horizontal margin (was flush chatRect.width)'
  );
  // Left must add the same margin so the popover is centered inside
  // the chat-messages box (not just narrower on the right side).
  assert.ok(
    /chatRect\.left\s*\+\s*window\.scrollX\s*\+\s*(?:\d+|[A-Za-z_$][\w$]*)/.test(win),
    'r6: left must be chatRect.left + scrollX + margin (offset matching the width inset)'
  );
});

t('css: r6 — popover background stands out from the chat surface', () => {
  // User: "make the popover background stand out a bit more". Visual
  // distinguishability is hard to assert pixel-perfectly, so the
  // surrogate is: the bg-color must NOT be the prior near-black
  // rgba(28, 30, 34, …) — it must be lifted to a lighter neutral, AND
  // there must be a stronger border / shadow signal so the popover
  // reads as a floating panel rather than a flat extension of the
  // chat background.
  const idx = CSS.search(/#chat-clarify-popover\s*\{/);
  assert.ok(idx > -1, '#chat-clarify-popover rule must exist');
  // Comments + multi-line shadow push the rule body past ~800; slice big.
  const win = CSS.slice(idx, idx + 1500);
  // Negative guard: the prior near-black bg should be gone.
  assert.ok(
    !/background:\s*rgba\(\s*28\s*,\s*30\s*,\s*34\s*,/.test(win),
    'r6: bg must NOT remain rgba(28, 30, 34, …) — lift to a lighter neutral so it stands out'
  );
  // Positive guard: a background declaration is still present.
  assert.ok(/background:\s*rgba?\(/.test(win),
    'r6: popover must still set an explicit background-color');
  // Positive guard: shadow / border still applied so the panel reads as elevated.
  assert.ok(/box-shadow:/.test(win),
    'r6: popover must keep box-shadow (elevation cue)');
  assert.ok(/border:\s*1px\s+solid\s+rgba\(/.test(win),
    'r6: popover must keep a colored border (panel edge)');
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
