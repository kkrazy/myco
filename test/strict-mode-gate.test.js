// fr-38: per-session strict-mode gate. When on, claude-bound chat
// messages MUST include a `[run:plan#<id>]` marker. Messages without
// it are blocked at handleChatPostfixes BEFORE claude runs, with a
// one-shot reply explaining how to unblock.
//
// Contract:
//   - sessions.js exports isSessionStrict + setSessionStrict
//   - rec.strictMode = boolean (default false)
//   - setSessionStrict idempotent (returns false on no-change)
//   - attach.js has a _hasRunMarker helper matching the standard
//     [run:(plan|test|arch|td|fr|bug)#<id>] shape
//   - handleChatPostfixes gate fires AFTER mention / slash short-
//     circuits, BEFORE the claude-forward call. /btw (shouldAskAssistant)
//     and special-key tokens (esc, etc.) bypass the gate.
//   - On block: emits a strict-mode-block chat message + does NOT
//     forward to claude.
//   - /strict slash command is registered, owner+admin gated, parses
//     `on` / `off` / empty correctly.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ──────────────────────────────────────────────────────────────────────────
// Inlined helpers — exercise the gate logic.

function _hasRunMarker(text) {
  return /\[run:(plan|test|arch|td|fr|bug)#[A-Za-z0-9_-]+\]/.test(String(text || ''));
}

// Mirrors the strict-mode predicate inside handleChatPostfixes —
// returns true if the message should be BLOCKED.
function shouldBlock(strictModeOn, text, { isAskAssistant = false, looksLikeKey = false } = {}) {
  if (!strictModeOn) return false;
  if (isAskAssistant) return false;
  if (looksLikeKey) return false;
  if (_hasRunMarker(text)) return false;
  return true;
}

// ──────────────────────────────────────────────────────────────────────────

console.log('── fr-38: strict-mode gate ──');

t('gate OFF: every message passes through (no block)', () => {
  assert.strictEqual(shouldBlock(false, 'change app.js to add a button'), false);
  assert.strictEqual(shouldBlock(false, 'hi'), false);
  assert.strictEqual(shouldBlock(false, '[run:plan#bug-1] do the thing'), false);
});

t('gate ON + plain chat (no marker) → BLOCK', () => {
  assert.strictEqual(shouldBlock(true, 'change app.js to add a button'), true);
  assert.strictEqual(shouldBlock(true, 'fix the typo in line 5'), true);
});

t('gate ON + [run:plan#<id>] marker → PASS', () => {
  assert.strictEqual(shouldBlock(true, '[run:plan#bug-1] fix the bug'), false);
  assert.strictEqual(shouldBlock(true, 'do the thing [run:plan#td-3]'), false);
  assert.strictEqual(shouldBlock(true, '[run:plan#fr-39] implement delegation'), false);
});

t('gate ON + [run:bug#<id>] or [run:td#<id>] or [run:fr#<id>] → PASS (all type prefixes accepted)', () => {
  assert.strictEqual(shouldBlock(true, '[run:bug#bug-7]'), false);
  assert.strictEqual(shouldBlock(true, '[run:td#td-11]'), false);
  assert.strictEqual(shouldBlock(true, '[run:fr#fr-39]'), false);
  assert.strictEqual(shouldBlock(true, '[run:test#nope]'), false);
  assert.strictEqual(shouldBlock(true, '[run:arch#whatever]'), false);
});

t('gate ON + ? question (shouldAskAssistant=true) → PASS (read-only)', () => {
  assert.strictEqual(shouldBlock(true, 'what does this do?', { isAskAssistant: true }), false);
});

t('gate ON + key token (esc/ctrl-c/etc.) → PASS (interrupt, not a code change)', () => {
  assert.strictEqual(shouldBlock(true, 'esc', { looksLikeKey: true }), false);
  assert.strictEqual(shouldBlock(true, 'ctrl-c', { looksLikeKey: true }), false);
});

t('gate ON + permissive id chars (hex legacy ids work)', () => {
  // Pre-fr-N migration ids were hex like 695feda01a0a. Marker must
  // still accept them so legacy items can drive turns.
  assert.strictEqual(shouldBlock(true, '[run:plan#695feda01a0a] legacy'), false);
});

t('gate ON + marker with surrounding text → PASS (marker anywhere in message)', () => {
  // Bug-prone: assert the regex is not anchored to start-of-string.
  assert.strictEqual(shouldBlock(true, 'do this for me [run:plan#td-9] please'), false);
});

t('gate ON + malformed marker (no brackets) → BLOCK', () => {
  assert.strictEqual(shouldBlock(true, 'run:plan#bug-1 do the thing'), true);
  assert.strictEqual(shouldBlock(true, 'plan#bug-1'), true);
});

t('gate ON + marker for invalid type → BLOCK', () => {
  // [run:foo#bar] doesn't match — only plan|test|arch|td|fr|bug are valid types.
  assert.strictEqual(shouldBlock(true, '[run:foo#bar] do thing'), true);
});

t('setSessionStrict idempotency contract', () => {
  // Mirrors the helper. The actual sessions.js version returns false
  // when no change. Test the predicate logic on a fake rec.
  function setSessionStrict(rec, on) {
    const next = !!on;
    if ((rec.strictMode || false) === next) return false;
    rec.strictMode = next;
    return true;
  }
  const rec = {};
  assert.strictEqual(setSessionStrict(rec, false), false, 'off → off is no-op');
  assert.strictEqual(setSessionStrict(rec, true), true, 'off → on changes');
  assert.strictEqual(rec.strictMode, true);
  assert.strictEqual(setSessionStrict(rec, true), false, 'on → on is no-op (idempotent)');
  assert.strictEqual(setSessionStrict(rec, false), true, 'on → off changes');
  assert.strictEqual(rec.strictMode, false);
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards on the prod source.

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

t('static guard: sessions.js exports isSessionStrict + setSessionStrict', () => {
  const src = _read('server/src/sessions.js');
  for (const fn of ['isSessionStrict', 'setSessionStrict']) {
    assert.ok(new RegExp(`function\\s+${fn}\\s*\\(`).test(src),
      `sessions.js must define function ${fn}(...)`);
  }
  // Both exported
  assert.ok(/isSessionStrict\s*,/.test(src) || /isSessionStrict\s*$/m.test(src),
    'isSessionStrict must be exported');
  assert.ok(/setSessionStrict\s*,/.test(src) || /setSessionStrict\s*$/m.test(src),
    'setSessionStrict must be exported');
});

t('static guard: attach.js has _hasRunMarker helper with the full type set', () => {
  const src = _read('server/src/attach.js');
  assert.ok(/function _hasRunMarker/.test(src), 'attach.js must define _hasRunMarker');
  // All 6 type prefixes accepted
  assert.ok(/plan\|test\|arch\|td\|fr\|bug/.test(src),
    '_hasRunMarker must accept plan|test|arch|td|fr|bug as the type alternation');
});

t('static guard: handleChatPostfixes calls isSessionStrict + emits strict-mode-block', () => {
  const src = _read('server/src/attach.js');
  const fnStart = src.indexOf('function handleChatPostfixes');
  assert.ok(fnStart > 0, 'handleChatPostfixes must exist');
  const window = src.slice(fnStart, fnStart + 3000);
  assert.ok(/isSessionStrict\s*\(/.test(window),
    'handleChatPostfixes must call sessionsMod.isSessionStrict() to check the gate');
  assert.ok(/strict-mode-block/.test(window),
    'handleChatPostfixes must emit a meta.kind=strict-mode-block chat row when the gate fires');
  assert.ok(/_hasRunMarker\s*\(/.test(window),
    'handleChatPostfixes must call _hasRunMarker(text) to recognize the backing marker');
});

t('static guard: gate fires BEFORE the claude-forward path (shouldAskAssistant call)', () => {
  const src = _read('server/src/attach.js');
  const fnStart = src.indexOf('function handleChatPostfixes');
  const window = src.slice(fnStart, fnStart + 3000);
  // The strict-mode check + return must appear BEFORE the
  // shouldAskAssistant call that would dispatch to claude.
  const strictIdx = window.indexOf('isSessionStrict');
  const askIdx = window.search(/shouldAskAssistant\s*\(\s*text\s*\)/);
  assert.ok(strictIdx > 0 && askIdx > strictIdx,
    'strict-mode gate must run BEFORE shouldAskAssistant — otherwise a blocked turn could still dispatch to claude');
});

t('static guard: /strict slash command registered + owner+admin gated', () => {
  const src = _read('server/src/slashcmds.js');
  assert.ok(/names:\s*\[\s*['"]strict['"]/.test(src), '/strict must be in COMMANDS');
  assert.ok(/function\s+handleStrict\s*\(/.test(src), 'handleStrict function must exist');
  const fnStart = src.indexOf('function handleStrict');
  const window = src.slice(fnStart, fnStart + 2500);
  assert.ok(/isOwnerOrAdmin\s*\(/.test(window),
    'handleStrict must call isOwnerOrAdmin (admins can flip the strict gate per fr-39 inheritance)');
  assert.ok(/setSessionStrict\s*\(/.test(window),
    'handleStrict must call setSessionStrict to persist the toggle');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
