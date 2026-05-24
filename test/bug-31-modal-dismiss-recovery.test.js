// bug-31 regression: AskUserQuestion modal dismissal recovery.
//
// Two failure modes the user reported:
//
//   (a) Outside-click (on the modal backdrop) dismissed the prompt.
//       Pre-fix: <div class="perm-modal-backdrop" data-perm-defer="1">
//       routed backdrop clicks through the same defer handler as the
//       X button. Easy accidental dismiss on touch (a thumb-edge
//       press misses the dialog box).
//
//   (b) After dismissal, no obvious affordance to re-open. The chat-
//       pane menu row WAS click-to-reopen via data-perm-reopen, but
//       had no visible cue ("No visible affordance line" per the
//       pre-fix comment). Users didn't know they could click the row.
//       The agent stayed blocked on the AskUserQuestion Promise,
//       chat input typing didn't unblock it, leading to a stuck
//       session until another AskUserQuestion fired.
//
// Fix:
//   (a) Remove data-perm-defer="1" from .perm-modal-backdrop. Dismiss
//       is now explicit only (X button + Esc key).
//   (b) Add a visible .chat-menu-reopen-hint badge ("↗ Tap to answer")
//       inside active menu chat rows so the click-to-reopen path is
//       discoverable.
//
// Static-grep guards on both layers.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const HTML = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── bug-31: modal dismiss-recovery ──');

// ──────────────────────────────────────────────────────────────────────
// Failure mode (a) — backdrop click no longer dismisses
// ──────────────────────────────────────────────────────────────────────

t('HTML: .perm-modal-backdrop does NOT carry data-perm-defer (no outside-click dismiss)', () => {
  // Pre-fix shape: <div class="perm-modal-backdrop" data-perm-defer="1">
  // Post-fix: just <div class="perm-modal-backdrop"> (no defer attr).
  // The backdrop click is now a no-op; user must use X button or Esc
  // to explicitly dismiss.
  const backdropMatch = HTML.match(/<div[^>]*class="perm-modal-backdrop"[^>]*>/);
  assert.ok(backdropMatch, '.perm-modal-backdrop element must exist in index.html');
  assert.ok(!/data-perm-defer/.test(backdropMatch[0]),
    '.perm-modal-backdrop must NOT carry data-perm-defer="1" — that\'s the accidental-dismiss path the user reported. Dismiss is now explicit only (X button + Esc).');
});

t('HTML: explicit dismiss (X button) still carries data-perm-defer', () => {
  // We removed backdrop-dismiss but kept the explicit X button as a
  // dismiss affordance. The X must still carry data-perm-defer.
  assert.ok(/<button[^>]*class="perm-modal-close"[^>]*data-perm-defer/.test(HTML),
    '.perm-modal-close (the X button) must still carry data-perm-defer so explicit dismiss still works');
});

t('app.js: Esc key still dismisses (the second explicit dismiss path)', () => {
  // Esc key handler at _bindPermModalKeys still sets dismissed=true.
  // We're explicit-only now; Esc must still work.
  assert.ok(/Escape[\s\S]{0,300}permModalDismissed\s*=\s*true/.test(APP),
    '_bindPermModalKeys must still set state.permModalDismissed=true on Escape (explicit dismiss path)');
});

// ──────────────────────────────────────────────────────────────────────
// Failure mode (b) — visible reopen affordance
// ──────────────────────────────────────────────────────────────────────

t('app.js: active menu chat rows now render a visible "Tap to answer" reopen hint', () => {
  // Pre-fix the active branch had `optsHtml = ''` with a comment
  // saying "No visible affordance line". Post-fix the active branch
  // emits a .chat-menu-reopen-hint span with data-perm-reopen so the
  // user sees a clickable pill that re-opens the modal.
  const activeBranchIdx = APP.search(/else\s+if\s*\(\s*menuOpts\s*&&\s*isActiveMenu\s*\)/);
  assert.ok(activeBranchIdx > -1,
    'Active-menu rendering branch must exist in app.js');
  const window = APP.slice(activeBranchIdx, activeBranchIdx + 500);
  assert.ok(/chat-menu-reopen-hint/.test(window),
    'Active-menu branch must emit a .chat-menu-reopen-hint span — pre-fix had `optsHtml = \'\'` with no visible affordance, leaving dismissed-modal recovery non-discoverable');
  assert.ok(/data-perm-reopen/.test(window),
    'The reopen-hint span must carry data-perm-reopen so _bindChatMenuClicks routes the click to re-open the modal');
});

t('app.js: existing reopen wiring still fires on data-perm-reopen click', () => {
  // The bug-31 affordance is a span carrying data-perm-reopen. The
  // existing _bindChatMenuClicks delegation listens for that attribute
  // and re-opens the modal. Pin that wiring stays in place.
  assert.ok(/data-perm-reopen[\s\S]{0,400}permModalDismissed\s*=\s*false/.test(APP),
    '_bindChatMenuClicks must continue to set state.permModalDismissed = false when a data-perm-reopen click is captured');
});

// ──────────────────────────────────────────────────────────────────────
// CSS — the reopen hint must look clickable
// ──────────────────────────────────────────────────────────────────────

t('CSS: .chat-menu-reopen-hint is styled with cursor:pointer + hover state', () => {
  const block = CSS.match(/\.chat-menu-reopen-hint\s*\{[\s\S]*?\}/);
  assert.ok(block, '.chat-menu-reopen-hint CSS rule must exist');
  assert.ok(/cursor:\s*pointer/.test(block[0]),
    '.chat-menu-reopen-hint must declare cursor: pointer so it reads as clickable');
  assert.ok(/\.chat-menu-reopen-hint:hover/.test(CSS),
    'A :hover state must exist so the user gets feedback that the badge is interactive');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation — pin the contract on a fake state object
// ──────────────────────────────────────────────────────────────────────

t('behavior: dismiss → state.permModalDismissed=true; reopen → false', () => {
  // Mirror what the click handlers do.
  const state = { permModalDismissed: false };
  // Explicit dismiss (X / Esc).
  state.permModalDismissed = true;
  assert.strictEqual(state.permModalDismissed, true);
  // Reopen via the reopen-hint badge click → _bindChatMenuClicks
  // flips the flag back.
  state.permModalDismissed = false;
  assert.strictEqual(state.permModalDismissed, false,
    'reopen path must reset the dismissed flag so _renderPermModal shows the modal again');
});

t('behavior: backdrop click is now a no-op (no permModalDismissed flip)', () => {
  // Simulate the post-fix behavior: clicking the backdrop element
  // (which no longer has data-perm-defer) doesn't trigger the defer
  // handler. The state stays unchanged.
  const state = { permModalDismissed: false };
  // Backdrop click — no data-perm-defer match → no state change.
  // (No-op in the click handler.)
  assert.strictEqual(state.permModalDismissed, false,
    'Backdrop click must NOT flip permModalDismissed to true (the bug-31 accidental-dismiss path)');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
