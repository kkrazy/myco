// bug-12: re-entering a session via the back-icon must re-show the chat pane.
//
// Repro: user opens session → taps back-icon (`btn-expand` → setSidebar(false)
// → on mobile, line in setSidebar() closes setChatPane(false)) → taps the
// same session card again. The openSession early-return at line 1153
// previously did `setSidebar(true)` only — it never re-showed the chat pane.
// Net effect: chat was invisible / "deactivated" until the user manually
// tapped the chat button. The fix adds an unconditional `setChatPane(true)`
// inside the early-return branch.
//
// These tests lock the early-return shape against future regressions:
//   1. The early-return branch exists (state.activeId === id && WS open).
//   2. It calls setChatPane(true) — the actual bug-12 fix.
//   3. Pure string check: the early-return block (between the `if (state.activeId
//      === id …` predicate and its closing `return;`) contains
//      `setChatPane(true)`.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

// Find the openSession function body.
const fnMatch = APP_JS.match(/function openSession\(id[^)]*\)\s*\{([\s\S]*?)\n\}/);
const fnBody = fnMatch ? fnMatch[1] : '';

t('openSession function exists', () => {
  assert.ok(fnMatch, 'function openSession(...) { ... } not found in app.js');
});

t('early-return branch on same session + live WS exists', () => {
  // Predicate shape — matches `state.activeId === id && state.ws &&
  // state.ws.readyState === WebSocket.OPEN`.
  assert.ok(
    /if\s*\(\s*state\.activeId\s*===\s*id\s*&&\s*state\.ws\s*&&\s*state\.ws\.readyState\s*===\s*WebSocket\.OPEN\s*\)/.test(fnBody),
    'openSession early-return predicate (same session + live WS) is missing',
  );
});

t('early-return branch calls setChatPane(true) — bug-12 fix', () => {
  // Extract just the early-return block.
  const blockMatch = fnBody.match(/if\s*\(\s*state\.activeId\s*===\s*id\s*&&[^)]*\)\s*\{([\s\S]*?)return;\s*\}/);
  assert.ok(blockMatch, 'could not isolate the early-return block of openSession');
  const block = blockMatch[1];
  assert.ok(
    /setChatPane\s*\(\s*true\s*\)/.test(block),
    'early-return branch does NOT call setChatPane(true) — re-tapping the same session after a back-icon nav will leave the chat pane hidden (bug-12 will recur).\n\n' +
    'Block content:\n' + block,
  );
});

t('bug-12 fix references the bug id in a comment (so future hands know why)', () => {
  // Encourage commit discipline: the fix has a comment naming bug-12.
  const blockMatch = fnBody.match(/if\s*\(\s*state\.activeId\s*===\s*id\s*&&[^)]*\)\s*\{([\s\S]*?)return;\s*\}/);
  const block = blockMatch ? blockMatch[1] : '';
  assert.ok(
    /bug-12/i.test(block),
    'early-return block does not reference bug-12 in a comment — without context the next refactor may delete the setChatPane(true) line.',
  );
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
