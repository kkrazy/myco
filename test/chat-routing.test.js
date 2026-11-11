// Regression: chat routing rewrite (2026-05-14, refreshed for the SDK
// Phase 9 step 2 attach.js rename). Plain text + @<unknown> route to
// claude by default; only @<known-user> mentions stay in chat. The
// mention-detection helper is what gates that — anything that breaks it
// sends private user-to-user notes straight to claude, which is both
// confusing and a privacy hole.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-chatroute-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

// Seed the allowlist BEFORE requiring attach.js so _isKnownChatUser
// (called transitively from _detectMentionTarget) sees them.
fs.writeFileSync(
  path.join(process.env.MYCO_STATE_DIR, 'allowed-github-users.txt'),
  '# test fixture\nkkrazy\nryan-blues\n',
);

const attach = require('../server/src/attach');
const slashcmds = require('../server/src/slashcmds');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── chat routing: @<known-user> → mention; everything else → agent ──');

t('@<known-user> at the head returns the canonical login', () => {
  assert.strictEqual(attach._detectMentionTarget('@kkrazy hey'), 'kkrazy');
  assert.strictEqual(attach._detectMentionTarget('@ryan-blues need eyes on this'), 'ryan-blues');
});

t('case-insensitive match — @KKRAZY still resolves to kkrazy', () => {
  // _isKnownChatUser lowercases on both sides; the returned value is the
  // typed casing (we don't normalise back to canonical), which is fine
  // since the client compares lowercased-username for the highlight.
  assert.ok(attach._detectMentionTarget('@KKRAZY hi'), 'expected truthy match');
});

t('@<unknown-word> does NOT resolve — falls through to agent route', () => {
  assert.strictEqual(attach._detectMentionTarget('@myco hi'), null);
  assert.strictEqual(attach._detectMentionTarget('@claude do thing'), null);
  assert.strictEqual(attach._detectMentionTarget('@asdf nope'), null);
});

t('@all is the broadcast mention — returns the literal "all" target', () => {
  // fr-3: @all addresses every viewer at once. It's a chat-only
  // mention (not forwarded to claude) and the client renders it
  // with chat-msg-mention-all + chat-msg-mention-me on every
  // viewer (each viewer is a recipient).
  assert.strictEqual(attach._detectMentionTarget('@all heads up'), 'all');
  // Case-insensitive (head-of-message is canonicalized).
  assert.strictEqual(attach._detectMentionTarget('@ALL stand-up at 10'), 'all');
  // Bare @all (no body) still resolves.
  assert.strictEqual(attach._detectMentionTarget('@all'), 'all');
  // Embedded @all is not a route hint — "tell @all the meeting…"
  // is a normal message that just happens to mention all.
  assert.strictEqual(attach._detectMentionTarget('tell @all the meeting is moved'), null);
});

t('plain text never matches a mention', () => {
  assert.strictEqual(attach._detectMentionTarget('hi there'), null);
  assert.strictEqual(attach._detectMentionTarget(''), null);
  assert.strictEqual(attach._detectMentionTarget('  '), null);
});

t('mention must be at the head of the message — embedded @user is not a route hint', () => {
  // "tell @kkrazy that …" is a normal message addressed at claude that
  // happens to mention a user. We do NOT treat it as a private DM.
  assert.strictEqual(attach._detectMentionTarget('tell @kkrazy that lunch is at noon'), null);
});

t('bare @username (no body) still resolves so user can ping without text', () => {
  assert.strictEqual(attach._detectMentionTarget('@kkrazy'), 'kkrazy');
  assert.strictEqual(attach._detectMentionTarget('@kkrazy?'), 'kkrazy');
});

t('the removed /m alias is no longer in the slash registry', () => {
  const cmds = slashcmds.listCommands();
  assert.ok(!cmds.some((c) => c.name === 'm'),
    `/m should be removed from listCommands, got: ${cmds.map((c) => c.name).join(', ')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
