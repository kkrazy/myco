// fr-86: marker-prefixed slash commands must reach the server slash
// dispatcher.
//
// Pre-fix bug (reported by kkrazy 2026-05-24): typing `/allowlist` in
// the per-item chat panel sent `[chat:plan#fr-1] /allowlist` over the
// WS chat channel. handleChatMessage recognized the marker (set
// _activeChatItem), then checked `if (text.startsWith('/'))` — that
// check failed because text starts with `[`, not `/`. So the slash
// dispatcher was skipped and the slash was forwarded to the agent as
// conversation text. The user saw NO /allowlist output because the
// server command never ran.
//
// Fix: strip the marker prefix from text into `slashText` BEFORE
// the slash check. Both [chat:…] and [run:…] markers covered.
//
// Static guards on attach.js + behavior simulation of the strip regex
// across the full marker matrix (type × layer).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

console.log('── fr-86: marker-prefixed slash routing ──');

// ──────────────────────────────────────────────────────────────────────
// Static guards: handleChatMessage strips the marker before the slash
// dispatch decision.
// ──────────────────────────────────────────────────────────────────────

t('attach.js declares a slashText variable derived from text', () => {
  // The fix uses `slashText = text.replace(<marker-regex>, '')`
  // BEFORE the `slashText.startsWith('/')` check.
  assert.ok(/const\s+slashText\s*=\s*text\.replace\s*\(/.test(ATTACH),
    'handleChatMessage must declare `const slashText = text.replace(<marker>, \'\')`');
});

t('marker-strip regex covers both [chat:…] and [run:…] prefixes', () => {
  // The strip must handle BOTH marker flavors so /run:plan#X and
  // /chat:plan#X dispatches with trailing slashes route the same way.
  // Anchor on the slashText assignment + the chunks of the marker
  // regex that MUST be present in that single statement.
  const idx = ATTACH.search(/const\s+slashText\s*=\s*text\.replace\s*\(/);
  assert.ok(idx > -1, 'slashText replace declaration must exist');
  const win = ATTACH.slice(idx, idx + 300);
  assert.ok(/chat\|run/.test(win) || /run\|chat/.test(win),
    'strip regex must include both `chat` AND `run` in the marker-flavor alternation');
  // The type group must cover every artifact layer + id prefix that
  // can legitimately appear in a marker (mirrors the marker-parse regexes).
  for (const layer of ['plan', 'test', 'arch', 'td', 'fr', 'bug']) {
    assert.ok(new RegExp('\\b' + layer + '\\b').test(win),
      'strip regex must include "' + layer + '" in the layer alternation');
  }
});

t('slash dispatch + handleChatPostfixes both consume slashText (not raw text)', () => {
  // Both branches inside the `if (slashText.startsWith('/'))` block
  // must use slashText so the dispatched command + fallback see the
  // marker-stripped form. Pre-fix would have used `text` (with marker).
  assert.ok(/slashcmds\.dispatch\s*\(\s*ctx\s*,\s*slashText\s*\)/.test(ATTACH),
    'slashcmds.dispatch must be called with slashText (marker-stripped)');
  assert.ok(/handleChatPostfixes\s*\([^)]*slashText[^)]*\)/.test(ATTACH),
    'handleChatPostfixes (fallback on unrecognized slash) must also receive slashText');
});

t('startsWith check operates on slashText, not raw text', () => {
  // The root cause of the pre-fix bug: `text.startsWith('/')` was the
  // gate. Must now be `slashText.startsWith('/')` so marker-prefixed
  // text reaches the slash check.
  assert.ok(/slashText\.startsWith\s*\(\s*['"]\/['"]\s*\)/.test(ATTACH),
    'the slash gate must read slashText.startsWith("/") — text.startsWith("/") was the bug');
});

t('strip happens AFTER appendChatMessage but BEFORE the slash check', () => {
  // Ordering: appendChatMessage persists the raw inbound message
  // (preserves the audit trail of what the user actually typed). The
  // strip+dispatch happens after. Pin via source-index ordering so
  // future refactors don't move the strip before persistence (which
  // would lose the raw form from the audit log).
  const appendIdx = ATTACH.search(/sessionsMod\.appendChatMessage\s*\(\s*sessionId\s*,\s*message\s*\)/);
  const stripIdx = ATTACH.search(/const\s+slashText\s*=/);
  const gateIdx = ATTACH.search(/slashText\.startsWith\s*\(\s*['"]\/['"]\s*\)/);
  assert.ok(appendIdx > -1 && stripIdx > -1 && gateIdx > -1,
    'all three landmarks (append, strip, gate) must exist');
  assert.ok(appendIdx < stripIdx,
    'appendChatMessage (raw audit) must come BEFORE the strip — preserves the inbound form on disk');
  assert.ok(stripIdx < gateIdx,
    'strip must come BEFORE the startsWith gate — that\'s the WHOLE fix');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation: the strip regex applied across every legal
// marker combination still resolves to the bare slash command.
// ──────────────────────────────────────────────────────────────────────

const STRIP_RE = /^\[(?:chat|run):(?:plan|test|arch|td|fr|bug)#[A-Za-z0-9_-]+\]\s*/;

t('behavior: [chat:plan#fr-1] /allowlist → /allowlist', () => {
  assert.strictEqual(
    '[chat:plan#fr-1] /allowlist'.replace(STRIP_RE, ''),
    '/allowlist',
    'marker + space + /cmd must reduce to bare /cmd');
});

t('behavior: [run:plan#bug-17] /task → /task', () => {
  assert.strictEqual(
    '[run:plan#bug-17] /task'.replace(STRIP_RE, ''),
    '/task');
});

t('behavior: every layer × type combination strips cleanly', () => {
  for (const flavor of ['chat', 'run']) {
    for (const layer of ['plan', 'test', 'arch', 'td', 'fr', 'bug']) {
      for (const id of ['fr-1', 'bug-17', 'td-22', 'fr-43_v2', 'abc-def-123']) {
        const input = `[${flavor}:${layer}#${id}] /skip 5`;
        assert.strictEqual(input.replace(STRIP_RE, ''), '/skip 5',
          `${flavor}/${layer}/${id} strip must yield bare /skip 5`);
      }
    }
  }
});

t('behavior: non-marker text passes through unchanged (no false positives)', () => {
  // The strip must NOT eat any text that doesn't start with a marker.
  // Pre-fix nothing did this transform; post-fix we need to confirm
  // the regex is properly anchored to the START of the string.
  const cases = [
    '/allowlist',                          // bare slash (chat-pane case)
    'hello world',                         // plain text
    'check [chat:plan#fr-1] inline',       // marker in middle, NOT prefix
    '  [chat:plan#fr-1] /task',            // leading whitespace before marker
    '',                                     // empty string
    '[unknown:plan#fr-1] /task',           // unknown marker flavor
  ];
  for (const input of cases) {
    const stripped = input.replace(STRIP_RE, '');
    if (input.match(/^\[(?:chat|run):(?:plan|test|arch|td|fr|bug)#[A-Za-z0-9_-]+\]\s*/)) {
      // Should have been stripped.
      assert.notStrictEqual(stripped, input, 'matching input must change: ' + JSON.stringify(input));
    } else {
      // Should pass through.
      assert.strictEqual(stripped, input,
        'non-matching input must pass through: ' + JSON.stringify(input));
    }
  }
});

t('behavior: marker-only message (no slash after) strips to empty/whitespace', () => {
  // Defensive: a marker with no trailing slash command should reduce
  // to an empty string after strip — the subsequent .startsWith('/')
  // gate then correctly returns false (it's NOT a slash command).
  const stripped = '[chat:plan#fr-1]'.replace(STRIP_RE, '');
  assert.strictEqual(stripped, '',
    'marker-only input strips to empty string (no false slash dispatch)');
  assert.strictEqual(stripped.startsWith('/'), false,
    'empty string must NOT pass the slash gate');
});

t('behavior: marker + non-slash text strips to the trailing text', () => {
  // The COMMON case for the chat panel — user typed a natural-language
  // question, panel prepended marker. Strip should give back the
  // question; .startsWith('/') correctly returns false; the dispatch
  // path falls through to the agent (correct routing for plain text).
  assert.strictEqual(
    '[chat:plan#fr-1] What does this item do?'.replace(STRIP_RE, ''),
    'What does this item do?');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
