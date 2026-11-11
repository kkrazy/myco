// bug-25 regression: unknown_event events must not surface in the
// chat pane.
//
// User report: "UI renders `unknown_event` entries (with `× 2`
// dedupe badges) instead of properly handling unrecognized event
// types … leaking internal event-type names to the user."
//
// Origin: agent-session.js:669 wraps every SDK message type myco
// doesn't recognize as `_emit({ type: 'unknown_event', raw_type:
// m.type, raw: m })`. Pre-fix the client's _chromeShortLabel +
// _chromeEventLine fell through to `ev.type || 'event'` → literal
// "unknown_event" string in the chrome batch head + JSON dump in
// the expanded body.
//
// Fix: _appendAgentEvent short-circuits unknown_event at the top
// of the function — never lands in the DOM. Events still flow into
// events.jsonl for diagnostics; console.warn surfaces them to devs
// without polluting the user UI.

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
const AGENT_SESSION = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');

console.log('── bug-25: unknown_event suppression ──');

// ──────────────────────────────────────────────────────────────────────
// Origin still emits the passthrough (don't break the diagnostics path)
// ──────────────────────────────────────────────────────────────────────

t('server still emits unknown_event for unrecognized SDK message types', () => {
  // Pre-fix the server-side emit was the source of the leak. Post-fix
  // we KEEP that emit (events.jsonl needs the diagnostic record); we
  // only filter at the CLIENT render boundary.
  assert.ok(/type:\s*['"]unknown_event['"]/.test(AGENT_SESSION),
    'agent-session.js must still emit unknown_event for diagnostic visibility');
  assert.ok(/raw_type:\s*m\.type/.test(AGENT_SESSION),
    'unknown_event must carry raw_type (the SDK\'s original message type) for debugging');
});

// ──────────────────────────────────────────────────────────────────────
// Client short-circuit at the top of _appendAgentEvent
// ──────────────────────────────────────────────────────────────────────

function _appendBody() {
  const start = APP.search(/function\s+_appendAgentEvent\s*\(/);
  assert.ok(start > -1, '_appendAgentEvent must exist');
  // Window large enough to reach the chrome-routing branch (~6500
  // chars into the function — measured by where `_isChromeEvent(`
  // appears in the body).
  return sliceFn(APP, start);
}

t('_appendAgentEvent short-circuits unknown_event at the top', () => {
  const body = _appendBody();
  // Must appear BEFORE the chrome-batch routing + the
  // assistant_text merge — i.e., at the very top of the function so
  // the event never touches any render path.
  const ueIdx = body.search(/ev\.type\s*===\s*['"]unknown_event['"]/);
  assert.ok(ueIdx > -1,
    '_appendAgentEvent must check ev.type === "unknown_event"');
  // The check should be one of the first guards (before chrome-routing).
  const chromeIdx = body.search(/_isChromeEvent\s*\(/);
  assert.ok(chromeIdx > -1, 'chrome routing exists');
  assert.ok(ueIdx < chromeIdx,
    'unknown_event short-circuit must fire BEFORE chrome routing (otherwise the event reaches the chrome batch)');
});

t('the short-circuit returns without rendering', () => {
  const body = _appendBody();
  // After the type check, there must be a return; statement (not
  // fall-through). Without it the event would still render.
  const m = body.match(/ev\.type\s*===\s*['"]unknown_event['"][\s\S]{0,400}?return;/);
  assert.ok(m, 'unknown_event guard must terminate with `return;` so no render path runs');
});

t('console.warn surfaces unknown_event to devs (not silent-drop)', () => {
  const body = _appendBody();
  assert.ok(/console\.warn\(\s*['"]?\[unknown_event\]['"]?/.test(body),
    'short-circuit should console.warn with a [unknown_event] marker so devs can grep DevTools');
});

// ──────────────────────────────────────────────────────────────────────
// AGENT_CHROME_TYPES consistency — unknown_event removed
// ──────────────────────────────────────────────────────────────────────

t('AGENT_CHROME_TYPES no longer lists unknown_event', () => {
  // Pre-fix unknown_event was in the chrome set so it folded into
  // the batch. The short-circuit makes the chrome listing dead code.
  // Removing it pins the intent: unknown_event is NOT chrome.
  const setMatch = APP.match(/const\s+AGENT_CHROME_TYPES\s*=\s*new\s+Set\s*\(\s*\[[\s\S]*?\]/);
  assert.ok(setMatch, 'AGENT_CHROME_TYPES Set must exist');
  assert.ok(!/['"]unknown_event['"]/.test(setMatch[0]),
    'AGENT_CHROME_TYPES must NOT contain "unknown_event" — it short-circuits before classification anyway');
});

t('removal commented as bug-25 trail-marker', () => {
  // Defensive: future refactor that "tidies" the chrome list should
  // see a comment explaining the omission — otherwise someone will
  // re-add it thinking it's a missing entry.
  assert.ok(/bug-25.*unknown_event|unknown_event.*bug-25/i.test(APP),
    'a comment should explain the bug-25 omission to prevent a future "fix" re-adding it');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation — even if a render path is reached with an
// unknown_event, the fallback text wouldn't be user-friendly.
// (Belt-and-braces: this fires if someone removes the short-circuit
// without updating the render labels.)
// ──────────────────────────────────────────────────────────────────────

t('legacy fallback in _chromeShortLabel WOULD have shown the raw type (this is why we short-circuit)', () => {
  // Documents the pre-fix behavior so the relationship between
  // _chromeShortLabel and the short-circuit is explicit.
  const m = APP.match(/function\s+_chromeShortLabel\s*\(ev\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '_chromeShortLabel must exist');
  // The fallback at the end of the function returns ev.type or
  // 'event'. That's the leak source; our short-circuit ensures
  // unknown_event never reaches it.
  assert.ok(/return\s+ev\.type\s*\|\|\s*['"]event['"]/.test(m[0]),
    '_chromeShortLabel still has the `return ev.type || "event"` fallback (it\'s used for OTHER events). Our short-circuit at the top of _appendAgentEvent is what prevents unknown_event from reaching it.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
