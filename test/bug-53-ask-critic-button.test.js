// bug-53: critic-popover textarea has no clear submit affordance.
//
// User-reported (verbatim):
//   "When i ask question in the critic popover, not sure which button
//    to click, it's not clear how the question is handled."
//
// Root cause: pre-bug-53, the verdict-pane's user-prompt textarea was
// wired ONLY to the `↻ Retry` button on error/intermediate states. On
// the final-verdict state (the most common — every successful
// critique lands here), the textarea was DEAD UI — none of the three
// buttons (✗ Discard / ⚡ Ask Claude to Fix / ✓ Accept Claude) routed
// the typed content to the critic. Even on error/intermediate where
// wiring existed, "↻ Retry" reads as "redo what just happened," not
// "send my question."
//
// Fix: add a `💬 Ask Critic` button to the actions row on ALL three
// states (error / intermediate / final), rendered FIRST so it sits
// visually nearest the textarea label. The button is disabled when
// the textarea is empty (trimmed), enabled when non-empty —
// live-toggled by an `input` listener. Click POSTs to the existing
// /critique/retry endpoint with { userPrompt }; server-side handling
// was already shipped in bug-52 ([USER FOLLOW-UP — give this
// priority over the generic review] block in critique.js, which
// causes the critic to address the question alongside its standard
// review).
//
// Test shape: static-grep on the locked DOM + wiring surface in
// app.js + styles.css.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── bug-53: 💬 Ask Critic button on the verdict pane (textarea now has a clear submit affordance) ──');

// ── 1. Button HTML present on all three state branches ──

t('app.js: verdict-btn-ask exists as the askCriticBtn constant inside _renderVerdictPanel', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/function\s+_renderVerdictPanel\s*\(\)/);
  assert.ok(at > -1);
  const body = sliceFn(src, at);
  // The button HTML must be a named constant (so the same string can
  // be embedded into all three actionsHtml branches without
  // copy-paste drift between them).
  assert.ok(/const\s+askCriticBtn\s*=\s*`[^`]*verdict-btn-ask[^`]*`/s.test(body),
    '_renderVerdictPanel must declare an `askCriticBtn` constant containing the verdict-btn-ask button HTML — the button is rendered in all 3 state branches, and a single constant prevents per-branch drift.');
});

t('app.js: verdict-btn-ask button label is "💬 Ask Critic" — clearly targets the critic (not Claude)', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/const\s+askCriticBtn\s*=\s*`/);
  assert.ok(at > -1);
  const body = src.slice(at, at + 800);
  // The label must clearly differentiate from "⚡ Ask Claude to Fix" —
  // the verb is the same, but the TARGET (critic vs Claude) must be
  // unambiguous in the button text.
  assert.ok(/💬\s*Ask Critic/.test(body),
    'verdict-btn-ask label must be "💬 Ask Critic" — clearly targets the critic, visually distinct from ⚡ Ask Claude to Fix (which routes to Claude, not the critic).');
});

t('app.js: verdict-btn-ask starts disabled (the affordance is visible but not active until user types)', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/const\s+askCriticBtn\s*=\s*`/);
  const body = src.slice(at, at + 800);
  // The inline `disabled` attribute in the rendered HTML is what
  // gives the user a VISIBLE cue ("this button does something with
  // the textarea above") even before they type. Without it, the
  // button would be enabled by default + a click on an empty
  // textarea would silently no-op.
  assert.ok(/<button\s+[^>]*verdict-btn-ask[^>]*disabled/.test(body),
    'verdict-btn-ask must start with `disabled` in the rendered HTML — gives the user a visible affordance ("type to enable") before they click anything.');
});

t('app.js: askCriticBtn is rendered FIRST in actionsHtml for ALL three branches (isError / isIntermediate / final)', () => {
  const src = _read('web/public/app.js');
  // Find each branch's actionsHtml assignment and check askCriticBtn
  // is the FIRST thing concatenated (so it sits leftmost in the
  // action row, immediately below the textarea label visually).
  const branches = [
    { regex: /if\s*\(\s*isError\s*\)\s*\{[\s\S]{0,2000}?actionsHtml\s*=\s*askCriticBtn\s*\+/,
      label: 'isError branch' },
    { regex: /else\s+if\s*\(\s*isIntermediate\s*\)\s*\{[\s\S]{0,2000}?actionsHtml\s*=\s*askCriticBtn\s*\+/,
      label: 'isIntermediate branch' },
    { regex: /\}\s*else\s*\{[\s\S]{0,2000}?actionsHtml\s*=\s*askCriticBtn\s*\+/,
      label: 'final (default else) branch' },
  ];
  for (const { regex, label } of branches) {
    assert.ok(regex.test(src),
      `actionsHtml in the ${label} of _renderVerdictPanel must start with \`askCriticBtn +\` — bug-53 requires the Ask Critic button to be the FIRST button (most prominent, immediately below the textarea visually) on every state.`);
  }
});

// ── 2. Live-enable wiring + click handler ──

t('app.js: input listener on #verdict-user-prompt-input live-toggles the Ask Critic button disabled state', () => {
  const src = _read('web/public/app.js');
  // The textarea must have an `input` listener that toggles
  // btnAsk.disabled based on the trimmed-length of the textarea
  // value. Without live-toggle, the user has to click the button to
  // discover whether it'd send anything — defeats the affordance.
  assert.ok(/taAsk\.addEventListener\s*\(\s*['"]input['"]/.test(src),
    'app.js must register an `input` listener on the textarea (taAsk) that drives the Ask Critic button\'s enabled state — live-toggle is what makes the disabled-when-empty affordance work.');
  assert.ok(/btnAsk\.disabled\s*=\s*taAsk\.value\.trim\(\)\.length\s*===\s*0/.test(src),
    'app.js must compute btnAsk.disabled from `taAsk.value.trim().length === 0` — empty-or-whitespace input keeps the button disabled, any real content enables it.');
});

t('app.js: Ask Critic click handler POSTs to /critique/retry with { userPrompt } body — same endpoint bug-52 uses', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/const\s+btnAsk\s*=\s*panel\.querySelector\s*\(\s*['"]\.verdict-btn-ask['"]\s*\)/);
  assert.ok(at > -1, 'app.js must query .verdict-btn-ask via panel.querySelector inside _renderVerdictPanel.');
  const body = src.slice(at, at + 3000);
  // Endpoint
  assert.ok(/\/sessions\/\$\{[^}]+\}\/critique\/retry/.test(body),
    'Ask Critic click handler must POST to /sessions/${state.activeId}/critique/retry — same endpoint the bug-52 ↻ Retry handler uses; server-side userPrompt handling was already shipped there.');
  // Body shape
  assert.ok(/body:\s*JSON\.stringify\s*\(\s*\{\s*userPrompt\s*\}\s*\)/.test(body),
    'Ask Critic click handler must send { userPrompt } as the JSON body — matches the /critique/retry route\'s server-side contract.');
  // In-flight label
  assert.ok(/💬\s*Asking…/.test(body),
    'Ask Critic click handler must update the button label to "💬 Asking…" during the in-flight request so the user sees activity feedback.');
});

t('app.js: Ask Critic click handler resets button + alerts user on failure', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/const\s+btnAsk\s*=\s*panel\.querySelector/);
  const body = src.slice(at, at + 3000);
  // Failure path must restore disabled=false + label + alert the user
  // — otherwise the button stays stuck at "💬 Asking…" forever on a
  // backend hiccup.
  assert.ok(/btnAsk\.disabled\s*=\s*false[\s\S]{0,200}?btnAsk\.textContent\s*=\s*['"`]💬\s*Ask Critic['"`]/.test(body),
    'on failure, Ask Critic click handler must reset btnAsk.disabled = false AND btnAsk.textContent = "💬 Ask Critic" so the button doesn\'t get stuck in a half-failed state.');
  assert.ok(/alert\s*\(\s*['"`]Ask Critic failed/.test(body),
    'on failure, Ask Critic click handler must alert the user with a clear "Ask Critic failed: ..." message — silent failures leave the user wondering whether their question reached the critic.');
});

// ── 3. CSS for the new button — purple identity, distinct from existing buttons + Claude's ⚡ button ──

t('styles.css: .verdict-btn-ask has its own ruleset distinct from the other verdict-btn-* classes', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/\.verdict-btn-ask\s*\{/.test(css),
    '.verdict-btn-ask rule must exist so the button has its own visual identity (vs. the default .verdict-btn shape).');
});

t('styles.css: .verdict-btn-ask:disabled rule exists — the disabled-when-empty state must visibly differ from the active state', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/\.verdict-btn-ask:disabled\s*\{/.test(css),
    '.verdict-btn-ask:disabled rule must exist — without it the button looks identical empty vs. typed, defeating the affordance.');
});

t('styles.css: .verdict-btn-ask uses purple/lavender (matches the verdict-intermediate-badge — critic-surface color identity)', () => {
  const css = _read('web/public/styles.css');
  // The intermediate-badge uses rgba(192, 132, 252, ...) — that's the
  // purple identity for "critic-related UI." Adopt the same for the
  // Ask Critic button so the user reads it as "critic territory."
  const at = css.search(/\.verdict-btn-ask\s*\{/);
  const body = css.slice(at, at + 800);
  assert.ok(/rgba\s*\(\s*192\s*,\s*132\s*,\s*252/.test(body),
    '.verdict-btn-ask must use the rgba(192, 132, 252, ...) purple — same as .verdict-intermediate-badge — so the "critic surface" color identity is consistent across the verdict pane.');
});

// ── 4. Marker comments anchor future restyles ──

t('a comment naming "bug-53" appears in app.js and styles.css', () => {
  const app = _read('web/public/app.js');
  const css = _read('web/public/styles.css');
  assert.ok(/bug-53/.test(app),
    'app.js must carry a bug-53 marker so a future restyle knows the Ask Critic button is intentional.');
  assert.ok(/bug-53/.test(css),
    'styles.css must carry a bug-53 marker so the .verdict-btn-ask ruleset has provenance.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
