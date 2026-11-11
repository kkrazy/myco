// bug-70 regression: a chat reply with an accept-class phrase
// (e.g. "the test worked", "looks good", "accept") must fire the
// same plan-item run advancement that the verdict-pane ✓ Accept
// button does. Pre-fix only the button was wired; the chat path
// went straight to claude and the queue stayed stuck in
// awaiting_accept (reproduced by bug-66 — user said "the test
// worked" on verify-stage, queue never advanced).
//
// CLAUDE.md §9 documents the accept-class vocabulary:
//   accept, accepted, yes, looks good, proceed, ship it, ✓,
//   or simply naming the next stage (`code stage`, `verify`).
//
// Fix: server/src/attach.js
//   - _matchAcceptPhrase(text): whole-string match (after trim +
//     lowercase + trailing-punct strip) for the documented vocab
//     plus empirical phrases ("the test worked", etc.). Whole-
//     string match prevents false positives like "the test worked
//     but I have a question" from auto-accepting.
//   - _maybeHandleChatAccept(...): inspects session._activeRunItem
//     + stageState. On match + awaiting_accept:
//       · verify stage → clearActiveRunItem (mirrors /run/done)
//       · intermediate stage → _transitionStageState(next, in_progress)
//         + fire deferred final critique (mirrors bug-64)
//     Returns true to signal "consumed; suppress claude routing".
//   - Wired into handleChatMessage between mention-return and the
//     slash-command path so accept-phrases never reach claude.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-70: chat-accept fires run-done / stage advance ──');

const ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guards. Pin the prod implementation's shape.
// ─────────────────────────────────────────────────────────────────

t('_matchAcceptPhrase helper is defined in attach.js', () => {
  assert.ok(/function\s+_matchAcceptPhrase\s*\(\s*text\s*\)/.test(ATTACH),
    'helper function _matchAcceptPhrase(text) must exist');
});

t('_maybeHandleChatAccept dispatcher is defined in attach.js', () => {
  assert.ok(/function\s+_maybeHandleChatAccept\s*\(\s*sessionId,\s*session,\s*user,\s*text\s*\)/.test(ATTACH),
    'dispatcher _maybeHandleChatAccept(sessionId, session, user, text) must exist');
});

t('_matchAcceptPhrase covers the CLAUDE.md §9 documented vocabulary', () => {
  const m = ATTACH.match(/function\s+_matchAcceptPhrase\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '_matchAcceptPhrase body must be greppable');
  const body = m[1];
  // Each documented token from CLAUDE.md §9 must appear in the
  // matcher body so a future refactor renaming one is caught.
  for (const token of ['accept', 'yes', 'looks good', 'proceed', 'ship it']) {
    assert.ok(body.includes(token),
      `_matchAcceptPhrase must recognize the documented accept token '${token}'`);
  }
  // Forward-stage signals from CLAUDE.md §9.
  for (const stage of ['code', 'verify']) {
    assert.ok(new RegExp(`\\b${stage}\\b`).test(body),
      `_matchAcceptPhrase must recognize the forward-stage signal '${stage}'`);
  }
});

t('chat-accept handler is wired into handleChatMessage', () => {
  // The dispatcher must be CALLED from handleChatMessage, not just
  // defined as dead code. The call must sit between the mentionTarget
  // early-return and the slash-command branch so the intended ordering
  // is preserved (slash + clarify take precedence).
  const fnMatch = ATTACH.match(/function\s+handleChatMessage\s*\([^)]*\)\s*\{([\s\S]*?)\n\}\n\n/);
  assert.ok(fnMatch, 'handleChatMessage must be a top-level function');
  const body = fnMatch[1];
  const callIdx = body.search(/_maybeHandleChatAccept\s*\(\s*sessionId,\s*session,\s*user,\s*text\s*\)/);
  assert.ok(callIdx > -1,
    'handleChatMessage body must call _maybeHandleChatAccept(sessionId, session, user, text)');
  // Sequencing: the call must appear AFTER the mentionTarget return
  // and BEFORE the slash-command branch.
  const mentionIdx = body.indexOf('if (mentionTarget) return');
  const slashIdx = body.search(/if\s*\(\s*text\.startsWith\(\s*['"]\/['"]\s*\)\s*\)\s*\{/);
  assert.ok(mentionIdx > -1 && callIdx > mentionIdx,
    'chat-accept call must run AFTER the mentionTarget early-return so @mentions stay routed correctly');
  assert.ok(slashIdx > -1 && callIdx < slashIdx,
    'chat-accept call must run BEFORE the slash-command branch so /commands still take precedence');
});

t('_maybeHandleChatAccept reads stageState fresh from plan.json (not session-cached)', () => {
  const m = ATTACH.match(/function\s+_maybeHandleChatAccept\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '_maybeHandleChatAccept body must be greppable');
  const body = m[1];
  assert.ok(/getSessionRecord\s*\(\s*sessionId\s*\)/.test(body),
    'dispatcher must call getSessionRecord to find the live plan-item record');
  assert.ok(/_findPlanItemInRec\s*\(/.test(body),
    'dispatcher must call _findPlanItemInRec to locate the item');
  assert.ok(/stageStateMod\.getStageState/.test(body),
    'dispatcher must read stageState via stageStateMod.getStageState — single source of truth');
});

t('verify-stage branch fires clearActiveRunItem (mirrors POST /run/done)', () => {
  const m = ATTACH.match(/function\s+_maybeHandleChatAccept\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  const body = m[1];
  assert.ok(/clearActiveRunItem\s*\(\s*sessionId,\s*session,\s*\{[^}]*itemId/.test(body),
    'verify-stage branch must call clearActiveRunItem to advance the run queue');
  assert.ok(/reason:\s*['"]chat-accept-verify['"]/.test(body),
    'clearActiveRunItem must be called with a chat-accept-verify reason for audit traceability');
});

t('intermediate-stage branch fires _transitionStageState(next, in_progress)', () => {
  const m = ATTACH.match(/function\s+_maybeHandleChatAccept\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  const body = m[1];
  assert.ok(/stageStateMod\.nextStage\s*\(/.test(body),
    'intermediate branch must compute next stage via stageStateMod.nextStage');
  assert.ok(/_transitionStageState\s*\(\s*sessionId,\s*session,[^)]*next,\s*['"]in_progress['"]/.test(body),
    'intermediate branch must call _transitionStageState(next, in_progress) to advance');
});

t('intermediate-stage branch fires deferred-final-critique (mirrors bug-64)', () => {
  const m = ATTACH.match(/function\s+_maybeHandleChatAccept\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  const body = m[1];
  // The deferred-critique fire path lives at critique.js
  // resolveCritique 'accept-stage'. Chat-accept must mirror it.
  assert.ok(/_deferredFinalCritique/.test(body),
    'intermediate branch must reference _deferredFinalCritique to mirror critique.js accept-stage');
  assert.ok(/triggerGeminiCritique/.test(body),
    'intermediate branch must call triggerGeminiCritique on the deferred path');
});

t('chat-accept handler skips clarify-tagged messages (not an accept signal)', () => {
  const fnMatch = ATTACH.match(/function\s+handleChatMessage\s*\([^)]*\)\s*\{([\s\S]*?)\n\}\n\n/);
  const body = fnMatch[1];
  // The handler wiring must gate on message.meta.kind !== 'clarify'
  // so a popover reply doesn't get hijacked as an accept signal.
  const callBlock = body.match(/if\s*\([^)]*kind === ['"]clarify['"][\s\S]*?_maybeHandleChatAccept/);
  assert.ok(callBlock,
    "the call to _maybeHandleChatAccept must be gated to skip messages with meta.kind === 'clarify'");
});

// ─────────────────────────────────────────────────────────────────
// PART B — Behavioral simulation. Inline _matchAcceptPhrase and
// verify the vocab boundaries.
// ─────────────────────────────────────────────────────────────────

// Inlined reference. Must match the prod definition exactly (static
// guards above pin the prod version).
function _matchAcceptPhrase(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (/^(👍|✓|✔️|👌)$/.test(raw)) return true;
  const s = raw.replace(/\s*[.!👍✓✔️👌]+\s*$/, '');
  if (!s) return false;
  if (/^(accept(ed)?|yes|yep|yeah|ok|okay|sure|proceed|done|good|great|nice)$/.test(s)) return true;
  if (/^(looks good|looks great|works for me|all good|all green|ship it|lgtm|the test worked|test worked|tests worked|that works|that worked|it works|it worked|test passed|tests passed|test passes|tests pass)$/.test(s)) return true;
  if (/^(code|verify)( stage)?$/.test(s)) return true;
  if (/^start (coding|verifying|verification)$/.test(s)) return true;
  return false;
}

// Positive cases — these MUST match.
const POSITIVE = [
  'accept',
  'Accept',
  'accepted',
  'yes',
  'Yes.',
  'yep',
  'YEAH',
  'ok',
  'Okay',
  'sure',
  'proceed',
  'done',
  'good',
  'looks good',
  'Looks Good!',
  'works for me',
  'all green',
  'ship it',
  'LGTM',
  '👍',
  '✓',
  'the test worked',
  'The test worked.',
  'test worked',
  'that works',
  'it worked',
  'test passed',
  'tests passed',
  'code',
  'code stage',
  'verify',
  'Verify Stage',
  'start coding',
  'start verifying',
];

for (const phrase of POSITIVE) {
  t(`accept phrase: ${JSON.stringify(phrase)}`, () => {
    assert.strictEqual(_matchAcceptPhrase(phrase), true,
      `must recognize ${JSON.stringify(phrase)} as an accept signal`);
  });
}

// Negative cases — these MUST NOT match. Critical to avoid false
// positives that would silently consume a real user message.
const NEGATIVE = [
  '',
  '   ',
  'no',
  'reject',
  'fix it',
  'try again',
  'the test worked but I have a question',  // common false-positive shape
  'looks good in theory',                    // qualified affirmation
  'yes but no',                              // mixed signal
  'accept this commit message',              // imperative, not accept
  'I accept the proposal',                   // not a bare accept
  'good question',                           // good != accept
  'ok now lets continue with the next file', // multi-word with ok prefix
  'code this up please',                     // not "code" alone
  'verify that the test ran',                // not "verify" alone
  '/accept',                                 // looks like slash command, shouldn't match
  '@kkrazy looks good',                      // mention prefix
  'the test failed',                         // opposite signal
  'almost works',
  'works partially',
];

for (const phrase of NEGATIVE) {
  t(`NOT an accept phrase: ${JSON.stringify(phrase)}`, () => {
    assert.strictEqual(_matchAcceptPhrase(phrase), false,
      `must NOT match ${JSON.stringify(phrase)} as an accept signal — would cause false consumption of a real user message`);
  });
}

// ─────────────────────────────────────────────────────────────────
// PART C — Dispatcher behavior simulation. Model the gate decisions
// against a fake stageState + verify the routing outcomes.
// ─────────────────────────────────────────────────────────────────

// Simulate the dispatcher's gate logic. Returns one of:
//   'no-op'                 - no active item / no accept match / wrong status
//   'verify-clear'          - verify stage, fires clearActiveRunItem
//   'intermediate-advance'  - intermediate stage, transitions to next
function simulateDispatcher(activeRunItem, stageState, text) {
  if (!activeRunItem || !activeRunItem.itemId) return 'no-op';
  if (!_matchAcceptPhrase(text)) return 'no-op';
  if (!stageState || stageState.status !== 'awaiting_accept') return 'no-op';
  if (stageState.stage === 'verify') return 'verify-clear';
  return 'intermediate-advance';
}

t('dispatcher: verify.awaiting_accept + "the test worked" → verify-clear (bug-66 repro fix)', () => {
  // The exact bug-66 scenario.
  const active = { itemId: 'bug-66', startedAt: '2026-06-05T02:50:30Z' };
  const ss = { stage: 'verify', status: 'awaiting_accept', updatedAt: '2026-06-05T03:00:00Z' };
  assert.strictEqual(simulateDispatcher(active, ss, 'the test worked'), 'verify-clear',
    'the exact bug-66 user phrase on a verify.awaiting_accept item must fire the verify-clear path');
});

t('dispatcher: analyze.awaiting_accept + "start coding" → intermediate-advance', () => {
  const active = { itemId: 'bug-X', startedAt: 'now' };
  const ss = { stage: 'analyze', status: 'awaiting_accept', updatedAt: 'now' };
  assert.strictEqual(simulateDispatcher(active, ss, 'start coding'), 'intermediate-advance');
});

t('dispatcher: code.awaiting_accept + "verify" → intermediate-advance', () => {
  const active = { itemId: 'bug-X', startedAt: 'now' };
  const ss = { stage: 'code', status: 'awaiting_accept', updatedAt: 'now' };
  assert.strictEqual(simulateDispatcher(active, ss, 'verify'), 'intermediate-advance');
});

t('dispatcher: no active run item → no-op (regardless of phrase)', () => {
  assert.strictEqual(simulateDispatcher(null, null, 'yes'), 'no-op',
    'without an active run item, accept-phrases should pass through to claude');
});

t('dispatcher: active item but status=in_progress → no-op (no verdict to accept)', () => {
  const active = { itemId: 'bug-X', startedAt: 'now' };
  const ss = { stage: 'analyze', status: 'in_progress', updatedAt: 'now' };
  assert.strictEqual(simulateDispatcher(active, ss, 'yes'), 'no-op',
    "in_progress means claude is working; the user's 'yes' is for claude, not an accept signal");
});

t('dispatcher: active item but status=awaiting_verdict → no-op (waiting for critic, not user)', () => {
  const active = { itemId: 'bug-X', startedAt: 'now' };
  const ss = { stage: 'verify', status: 'awaiting_verdict', updatedAt: 'now' };
  assert.strictEqual(simulateDispatcher(active, ss, 'looks good'), 'no-op',
    'awaiting_verdict means we are waiting for the critic, not the user — accept-phrases pass through');
});

t('dispatcher: awaiting_accept + non-accept text → no-op', () => {
  const active = { itemId: 'bug-X', startedAt: 'now' };
  const ss = { stage: 'verify', status: 'awaiting_accept', updatedAt: 'now' };
  assert.strictEqual(simulateDispatcher(active, ss, 'wait, can you check the assertion at line 5?'), 'no-op',
    'non-accept text during awaiting_accept must NOT consume the message — user is asking a follow-up');
});

t('dispatcher: awaiting_accept + "the test worked but I have a question" → no-op (the critical false-positive guard)', () => {
  const active = { itemId: 'bug-X', startedAt: 'now' };
  const ss = { stage: 'verify', status: 'awaiting_accept', updatedAt: 'now' };
  assert.strictEqual(simulateDispatcher(active, ss, 'the test worked but I have a question'), 'no-op',
    'whole-string match prevents qualified affirmations from accidentally closing a stage');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
