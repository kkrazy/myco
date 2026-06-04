// bug-55: critic-popover is now TRULY modal.
//
// User-reported (verbatim):
//   "the critic popover is not modal, click outside of it made the
//    popover disappear and no way to bring it back again"
//
// Pre-fix (bug-50 r2): backdrop-click + Esc were wired for
// `isError || isIntermediate` states as an "escape hatch" for stuck
// users. But the explicit ✗ Dismiss button on those states ALREADY
// provided that path, and once outside-click fired, the verdict was
// wiped from state — gone forever, no recovery. The escape hatch
// became a footgun.
//
// Fix: remove the safeToDismissByBackdrop branch entirely. The
// popover becomes ALWAYS modal in EVERY state; dismissal is ONLY via
// the explicit buttons (✗ Dismiss / ↻ Retry / 💬 Ask Critic /
// ✗ Discard / ⚡ Ask Claude to Fix / ✓ Accept Claude — depending on
// state). bug-31 + bug-41 already shipped the same pattern for the
// permission-prompt modal; bug-55 brings the verdict pane in line.
//
// Test shape: assert the bad code paths are GONE.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── bug-55: verdict pane is truly modal — no outside-click / Esc dismissal ──');

// ── 1. The bad code paths are GONE ──

t('app.js: _renderVerdictPanel no longer declares the safeToDismissByBackdrop gate (the bug-50 r2 wiring that bug-55 supersedes)', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/function\s+_renderVerdictPanel\s*\(\)/);
  assert.ok(at > -1, '_renderVerdictPanel must exist.');
  const body = src.slice(at, at + 20000);
  // Anchor on the CODE pattern, not the bare substring — bug-55's
  // comment block legitimately mentions "safeToDismissByBackdrop"
  // when explaining what it removed. Looking for `const
  // safeToDismissByBackdrop =` (the declaration) AND
  // `if (safeToDismissByBackdrop)` (the gate that controlled the
  // backdrop+Esc handlers) — either form would mean the wiring is
  // back. The wording in COMMENTS is harmless.
  assert.ok(!/const\s+safeToDismissByBackdrop\s*=/.test(body),
    '_renderVerdictPanel must NOT contain `const safeToDismissByBackdrop = ...` — bug-55 removed the declaration that gated backdrop dismissal on error+intermediate states.');
  assert.ok(!/if\s*\(\s*safeToDismissByBackdrop\s*\)/.test(body),
    '_renderVerdictPanel must NOT contain `if (safeToDismissByBackdrop) { ... }` — bug-55 removed the gate that registered backdrop+Esc listeners.');
});

t('app.js: _renderVerdictPanel no longer registers a backdrop click listener that dismisses the pane', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/function\s+_renderVerdictPanel\s*\(\)/);
  const body = src.slice(at, at + 20000);
  // The pre-fix pattern was:
  //   panel.addEventListener('click', (e) => {
  //     if (e.target === panel) dismissPanel();
  //   });
  // Look for the "click on panel + check e.target === panel" pattern
  // that signals backdrop-dismiss wiring.
  assert.ok(!/panel\.addEventListener\s*\(\s*['"]click['"][\s\S]{0,200}e\.target\s*===\s*panel/.test(body),
    '_renderVerdictPanel must NOT register a panel.addEventListener("click", ...) that calls dismissPanel when e.target === panel — that was the backdrop-dismiss wiring bug-55 removed.');
});

t('app.js: _renderVerdictPanel no longer registers a document keydown listener that dismisses on Escape', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/function\s+_renderVerdictPanel\s*\(\)/);
  const body = src.slice(at, at + 20000);
  // The pre-fix Esc handler called document.addEventListener inside
  // the function. Look for that specific pattern in the function body
  // (the function-LOCAL `document.addEventListener('keydown', ...)`
  // is what's banned — outside-function listeners are fine).
  assert.ok(!/document\.addEventListener\s*\(\s*['"]keydown['"]/.test(body),
    '_renderVerdictPanel must NOT register a document.addEventListener("keydown", ...) for Escape-dismiss — bug-55 removed it. Other keydown wiring on the document lives outside this function and is unaffected.');
});

t('app.js: the dismissPanel() helper that wiped state.critiqueReview from the backdrop path is gone', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/function\s+_renderVerdictPanel\s*\(\)/);
  const body = src.slice(at, at + 20000);
  // The pre-fix code had `const dismissPanel = () => { ... }` defined
  // inside _renderVerdictPanel as a backdrop+Esc shared helper. With
  // the backdrop/Esc paths gone, the helper has no callers — it must
  // be deleted to keep the function tight (per CLAUDE.md §1 — no dead
  // code).
  assert.ok(!/const\s+dismissPanel\s*=\s*\(\s*\)\s*=>/.test(body),
    '_renderVerdictPanel must NOT contain a `const dismissPanel = () =>` helper — its only callers were the backdrop click + Esc handlers, both removed by bug-55. Dead helpers age into bugs.');
});

// ── 2. Modal LAYOUT is preserved (bug-50 r2 visual envelope unchanged) ──

t('styles.css: .chat-composer-verdict-panel keeps the modal-overlay shape (position absolute|fixed + inset:0)', () => {
  const css = _read('web/public/styles.css');
  // Find the .chat-composer-verdict-panel rule.
  const at = css.search(/\.chat-composer-verdict-panel\s*\{/);
  assert.ok(at > -1, '.chat-composer-verdict-panel rule must exist.');
  const block = css.slice(at, at + 1500);
  // bug-58 follow-up: was locked to position:fixed (the bug-50 r2
  // shape) but bug-58 changed it to position:absolute so the modal
  // is scoped to the chat-pane container instead of the viewport
  // ("Critic verdict modal overflows chat window width" — the modal
  // was spanning beyond chat-window bounds on wide screens). The
  // user-visible CONTRACT bug-55 locks (truly-modal, button-only
  // dismissal, no Esc, no backdrop click) is preserved either way —
  // those live in app.js's _renderVerdictPanel, not in CSS.
  // The modal-overlay SHAPE is preserved with absolute too (both
  // create a containing-block-filling overlay; absolute is just
  // scoped to the nearest positioned ancestor instead of the
  // viewport).
  assert.ok(/position\s*:\s*(absolute|fixed)/.test(block),
    '.chat-composer-verdict-panel must keep position: absolute (post-bug-58) OR position: fixed (legacy bug-55 era) — both express the modal-overlay shape.');
  assert.ok(/inset\s*:\s*0|top\s*:\s*0[\s\S]{0,200}left\s*:\s*0/.test(block),
    '.chat-composer-verdict-panel must keep inset: 0 (or top/left/bottom/right: 0) so it fills its containing block — modal layout preserved.');
});

// ── 3. Explicit-button dismissal still works (state-wipe sites preserved) ──

t('app.js: exactly 7 state.critiqueReview wipe sites (4 final + 2 intermediate stage + 1 cross-device WS handler) — backdrop path removed', () => {
  const src = _read('web/public/app.js');
  // After bug-55, the state-wipe sites are inside the explicit button
  // click handlers, NOT inside a backdrop/Esc helper.
  // Count provenance:
  //   Pre-bug-55: 5 sites (1 in backdrop dismissPanel + 4 final buttons).
  //   bug-55 fix: 4 sites (the 4 final buttons only — backdrop path gone).
  //   bug-54 fix: 5 sites (4 final buttons + 1 critique-resolved WS handler).
  //   bug-56 fix: 7 sites (+ 2 intermediate-state buttons:
  //               ✓ Accept Stage and ⚡ Ask Claude to Fix Stage).
  // The bug-55 contract (no backdrop/Esc dismissal) is still
  // satisfied because none of the 7 sites belong to a backdrop click
  // or Esc handler.
  const wipeSites = (src.match(/state\.critiqueReview\s*=\s*null/g) || []).length;
  assert.strictEqual(wipeSites, 7,
    `expected exactly 7 state.critiqueReview = null sites (4 final buttons + 2 intermediate stage buttons + 1 critique-resolved WS handler). Got ${wipeSites}. If higher, the backdrop path may have crept back in OR another sync surface was added without updating this guard.`);
});

t('app.js: exactly 7 state.awaitingVerdict = false sites — matching the 7 critiqueReview wipes', () => {
  const src = _read('web/public/app.js');
  const awaitingSites = (src.match(/state\.awaitingVerdict\s*=\s*false/g) || []).length;
  // bug-56 follow-up: same count bump as critiqueReview — the
  // intermediate Accept Stage + Fix Stage handlers clear both
  // together.
  assert.strictEqual(awaitingSites, 7,
    `expected exactly 7 state.awaitingVerdict = false sites (4 final buttons + 2 intermediate stage buttons + 1 critique-resolved WS handler). Got ${awaitingSites}.`);
});

// ── 4. Marker comment + supersession note ──

t('app.js: a comment naming "bug-55" appears and explicitly notes the bug-50 r2 supersession', () => {
  const src = _read('web/public/app.js');
  assert.ok(/bug-55/.test(src),
    'app.js must carry a bug-55 marker so a future restyle knows the truly-modal contract is intentional.');
  // The bug-55 comment block must explicitly note that it supersedes
  // bug-50 r2 — without that, a future reader sees both bug-50 r2
  // (which assumed backdrop dismissal) and the bug-55 absence and
  // can\'t tell which is canonical.
  assert.ok(/bug-55[\s\S]{0,500}SUPERSEDES[\s\S]{0,200}bug-50\s+r2|SUPERSEDES[\s\S]{0,300}bug-50\s+r2[\s\S]{0,500}bug-55/i.test(src),
    'bug-55 comment block in app.js must explicitly note that it SUPERSEDES bug-50 r2 — otherwise a future reader sees mixed signals about whether backdrop dismissal should exist.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
