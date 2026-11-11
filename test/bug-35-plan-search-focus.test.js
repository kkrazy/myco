// bug-35: Plan-view search field loses focus before the user finishes typing.
//
// User-reported (kkrazy 2026-05-25):
//   "Plan view search field loses focus before the user finishes typing,
//    breaking incremental filtering. Expected: search field stays focused
//    while filtering as the user types. Actual: focus is dropped mid-typing,
//    forcing the user to click back into the field."
//
// Root cause:
//   The 150ms debounced input handler in bindPlanSearch fires
//   renderArtifact('plan', cached). renderArtifact's plan path calls
//   _stashPlanFilterRow (insertBefore moves #plan-filter-row OUT of body
//   into #plan-wrap) then body.innerHTML = newContent then
//   _attachPlanFilterRowToBody (insertBefore moves it back IN). Each
//   insertBefore-move detaches+reattaches the element to the new parent;
//   browsers drop focus from any focused descendant on the detach step.
//   The #plan-search input lives inside that row, so the debounced
//   search re-render kicked focus out — the user's next keystroke
//   landed outside the field.
//
// Fix:
//   Two helpers:
//     _capturePlanSearchFocus() → { start, end } | null
//     _restorePlanSearchFocus(snap) → void
//   renderArtifact's plan branch calls _capturePlanSearchFocus once at
//   the top, then _restorePlanSearchFocus(snap) right after EACH of the
//   three _attachPlanFilterRowToBody sites (empty-items / no-match /
//   normal-render). Helpers are gated on document.activeElement ===
//   #plan-search so they don't steal focus when the user is elsewhere.
//
// Browser-DOM behavior is hard to assert in pure-Node tests (no jsdom),
// so the guards are static-source-shape checks on the focus-preservation
// invariant.

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

console.log('── bug-35: plan search input focus survives re-render ──');

// ──────────────────────────────────────────────────────────────────────
// Helpers defined + correctly shaped
// ──────────────────────────────────────────────────────────────────────

t('app.js: _capturePlanSearchFocus helper defined', () => {
  assert.ok(/function\s+_capturePlanSearchFocus\s*\(/.test(APP),
    '_capturePlanSearchFocus must be defined as a function');
});

t('app.js: _restorePlanSearchFocus helper defined', () => {
  assert.ok(/function\s+_restorePlanSearchFocus\s*\(/.test(APP),
    '_restorePlanSearchFocus must be defined as a function');
});

t('app.js: _capturePlanSearchFocus gates on activeElement === #plan-search', () => {
  // The capture must check document.activeElement so we don't refocus
  // when the user is typing elsewhere.
  const idx = APP.search(/function\s+_capturePlanSearchFocus\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/plan-search/.test(win),
    'capture must reference the plan-search element id');
  assert.ok(/document\.activeElement/.test(win),
    'capture must check document.activeElement so we only restore for the search case');
  assert.ok(/selectionStart/.test(win) && /selectionEnd/.test(win),
    'capture must record selectionStart + selectionEnd so the caret returns to the right offset');
});

t('app.js: _restorePlanSearchFocus calls .focus() + setSelectionRange', () => {
  const idx = APP.search(/function\s+_restorePlanSearchFocus\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/\.focus\s*\(\s*\)/.test(win),
    'restore must call input.focus() to put the cursor back');
  assert.ok(/setSelectionRange/.test(win),
    'restore must call setSelectionRange to restore the caret position');
  // Null snap → no-op.
  assert.ok(/if\s*\(\s*!snap\s*\)\s*return/.test(win),
    'restore must early-return when snap is null (no-op for the unfocused case)');
});

// ──────────────────────────────────────────────────────────────────────
// renderArtifact wires the helpers at the right call sites
// ──────────────────────────────────────────────────────────────────────

// Slice from renderArtifact's opening brace to the next top-level
// `function` declaration — covers the entire body without bleeding
// into adjacent helpers.
function _renderArtifactBody() {
  const idx = APP.search(/function\s+renderArtifact\s*\(/);
  if (idx < 0) return '';
  // Find next top-level function declaration (starts at column 0).
  const tail = APP.slice(idx + 30);
  const nextFn = tail.search(/\nfunction\s+\w+\s*\(/);
  if (nextFn < 0) return APP.slice(idx);
  return APP.slice(idx, idx + 30 + nextFn);
}

t('app.js: renderArtifact captures focus once at the top of the plan branch', () => {
  const win = _renderArtifactBody();
  assert.ok(win.length > 0, 'renderArtifact must exist');
  // Capture must happen exactly once (so we don't lose the original
  // pre-stash state to a later capture during the same render).
  const matches = win.match(/_capturePlanSearchFocus\s*\(/g) || [];
  assert.strictEqual(matches.length, 1,
    `renderArtifact must call _capturePlanSearchFocus exactly once at the top of the plan branch; found ${matches.length}`);
  // And it must be gated on type === 'plan' (no-op for arch/test).
  const capIdx = win.indexOf('_capturePlanSearchFocus');
  const around = win.slice(Math.max(0, capIdx - 80), capIdx + 80);
  assert.ok(/type\s*===\s*['"]plan['"]/.test(around),
    'capture must be gated on type === "plan" (no-op for arch/test artifacts)');
});

t('app.js: renderArtifact restores focus after every _attachPlanFilterRowToBody', () => {
  // Strip line comments so we don't double-count occurrences inside
  // `// _restorePlanSearchFocus(snap)`-style explanatory comments.
  const win = _renderArtifactBody().replace(/\/\/[^\n]*/g, '');
  // Pair count: there should be exactly 3 attach sites (empty path,
  // no-match path, normal-render path) and each one must be followed
  // by a _restorePlanSearchFocus call.
  const attachMatches = (win.match(/_attachPlanFilterRowToBody\s*\(/g) || []).length;
  const restoreMatches = (win.match(/_restorePlanSearchFocus\s*\(/g) || []).length;
  assert.strictEqual(attachMatches, 3,
    `renderArtifact must have exactly 3 _attachPlanFilterRowToBody call sites; found ${attachMatches}`);
  assert.strictEqual(restoreMatches, 3,
    `renderArtifact must restore focus after each attach (3 total); found ${restoreMatches}`);
  // Adjacency check: every restore call must appear after an attach
  // call, within ~150 chars of it (same exit block).
  const attachRe = /_attachPlanFilterRowToBody\([^)]*\)\s*;[\s\S]{0,200}_restorePlanSearchFocus/g;
  const pairs = (win.match(attachRe) || []).length;
  assert.strictEqual(pairs, 3,
    `each _attachPlanFilterRowToBody must be IMMEDIATELY followed (within 200 chars) by _restorePlanSearchFocus; found ${pairs} adjacent pairs`);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
