// bug-67 regression: a permission_request event arriving with a
// non-consecutive seq must still fold into the active chrome batch
// (not break it + spawn a new one-row batch).
//
// User report (bug-67):
//   "Triggering 'perm ask' interrupts the active Chrome batch and
//    spawns a new one, losing batch continuity."
//
// Root cause: _appendAgentEvent in web/public/app.js has two
// seq-consecutiveness gates that decide whether an incoming chrome
// event folds into the prev chrome batch:
//   1. pre-routing finish gate (~lines 6189-6206)
//   2. chrome-routing fold gate  (~lines 6279-6296)
// The seq counter is shared per-session between agent events and
// chat-msg appends (server/src/sessions.js allocSeq is called by
// BOTH _emit AND appendChatMessage), so any chat-msg interleaving
// between a tool_use and the SDK-driven permission_request creates
// a seq gap. Both gates then close the batch + start a new one.
//
// turn_result already had an inline short-circuit at the
// chrome-routing site. permission_request did NOT have an
// equivalent. The post-processing _mergeIdenticalChromeBatches
// (~line 7041) doesn't rescue this because the two batches have
// different signatures (e.g. "running: Bash" vs "perm asked · Bash").
//
// Fix: introduce _chromeEventAlwaysFolds(ev) helper that returns
// true for turn_result + permission_request + permission_resolved.
// Both seq gates check it first — if true, the event folds into
// the prev chrome batch regardless of seq gap. The "prev is still
// a chrome batch" check stays the gate against real semantic
// breaks (assistant_text / chat-msg rendering between).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-67: perm_request must fold into active chrome batch ──');

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guards on the prod implementation.
// ─────────────────────────────────────────────────────────────────

t('helper _chromeEventAlwaysFolds is defined in app.js', () => {
  assert.ok(/function\s+_chromeEventAlwaysFolds\s*\(\s*ev\s*\)/.test(APP),
    'helper function definition must exist with signature `_chromeEventAlwaysFolds(ev)`');
});

t('helper body lists all three always-fold event types', () => {
  const m = APP.match(/function\s+_chromeEventAlwaysFolds\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'helper body must be greppable');
  const body = m[1];
  // Each event type must be referenced as a string literal so a
  // refactor renaming one and forgetting the other is caught here.
  for (const tp of ['turn_result', 'permission_request', 'permission_resolved']) {
    assert.ok(new RegExp(`['"\`]${tp}['"\`]`).test(body),
      `helper must list '${tp}' as an always-fold event type`);
  }
});

t('pre-routing finish gate (in _appendAgentEvent) references the helper', () => {
  // Extract _appendAgentEvent body. The function is large so we use
  // a simple bracket-counter walk to find its end.
  const startIdx = APP.search(/function\s+_appendAgentEvent\s*\(/);
  assert.ok(startIdx > -1, '_appendAgentEvent must exist');
  // Slice up to a generous upper bound — the function is long but
  // not unbounded. 60k chars is far past its actual end.
  const body = sliceFn(APP, startIdx);
  // The pre-routing block sits inside `if (prevRunning) { ... }`.
  // It must invoke _chromeEventAlwaysFolds.
  const preRoutingMatch = body.match(/if\s*\(\s*prevRunning\s*\)\s*\{[\s\S]*?\n\s*\}/);
  assert.ok(preRoutingMatch, 'pre-routing finish gate must exist (the `if (prevRunning)` block)');
  assert.ok(/_chromeEventAlwaysFolds\s*\(\s*ev\s*\)/.test(preRoutingMatch[0]),
    'pre-routing finish gate must reference _chromeEventAlwaysFolds(ev) — otherwise a perm_request with a seq gap would still close the batch');
});

t('chrome-routing fold gate (in _appendAgentEvent) references the helper', () => {
  // The chrome-routing site is the second seq-check, inside the
  // `if (_isChromeEvent(ev))` block. We grep for the same helper
  // call appearing OUTSIDE the pre-routing block.
  const startIdx = APP.search(/function\s+_appendAgentEvent\s*\(/);
  const body = sliceFn(APP, startIdx);
  // Count helper references — must be ≥2 (one in each gate).
  const refs = (body.match(/_chromeEventAlwaysFolds\s*\(/g) || []).length;
  assert.ok(refs >= 2,
    'chrome-routing fold gate must ALSO call _chromeEventAlwaysFolds — found ' + refs + ' total references inside _appendAgentEvent, expected ≥2 (pre-routing + chrome-routing)');
});

t('permission_request still classified as a chrome event', () => {
  // Defense: even with the new helper, perm_request must continue
  // to live inside AGENT_CHROME_TYPES so _isChromeEvent classifies
  // it. Removing it from the set would mean perm_request lands
  // through the non-chrome path entirely.
  const m = APP.match(/const\s+AGENT_CHROME_TYPES\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]\s*\)/);
  assert.ok(m, 'AGENT_CHROME_TYPES set must exist');
  const setBody = m[1];
  assert.ok(/'permission_request'/.test(setBody),
    "'permission_request' must remain in AGENT_CHROME_TYPES so _isChromeEvent classifies it");
  assert.ok(/'permission_resolved'/.test(setBody),
    "'permission_resolved' must remain in AGENT_CHROME_TYPES");
});

t('seq-consecutive check stays in place for non-always-fold events (regression guard)', () => {
  // Negative: a future "simplify" must NOT remove the seq-check
  // path entirely. Non-perm chrome events (tool_use, tool_result,
  // hook_allow, system_event, etc.) still need the seq check to
  // detect intervening non-chrome renders.
  const startIdx = APP.search(/function\s+_appendAgentEvent\s*\(/);
  const body = sliceFn(APP, startIdx);
  assert.ok(/seqsConsecutive/.test(body),
    'seqsConsecutive variable must still exist in _appendAgentEvent — the seq gate is still authoritative for non-always-fold chrome events');
});

// ─────────────────────────────────────────────────────────────────
// PART B — Behavioral simulation. Inline the gate decisions on a
// fake "prev DOM element" object and verify the routing outcomes.
// Mirrors the chrome-batch-merge.test.js pattern.
// ─────────────────────────────────────────────────────────────────

// Inlined reference helper. Must match the prod definition exactly
// (the static guards above pin the prod version's contract).
// bug-67 r3 added tool_result to the set.
function _chromeEventAlwaysFolds(ev) {
  if (!ev || !ev.type) return false;
  return ev.type === 'turn_result'
      || ev.type === 'permission_request'
      || ev.type === 'permission_resolved'
      || ev.type === 'tool_result';
}

// Simulate the gate decision: given prev DOM dataset + incoming ev,
// return 'fold' (append to prev batch) or 'new-batch' (start fresh).
// Models the combined pre-routing + chrome-routing logic.
function simulateGate(prevDataset, ev, isChrome) {
  if (!isChrome) return 'non-chrome';   // routes through assistant_text / fresh-card paths
  if (!prevDataset || prevDataset.evType !== '_chrome_batch') return 'new-batch';
  if (_chromeEventAlwaysFolds(ev)) return 'fold';
  const prevLastSeq = prevDataset.lastSeq != null ? parseInt(prevDataset.lastSeq, 10) : null;
  const evSeq = typeof ev.seq === 'number' ? ev.seq : null;
  const seqsConsecutive = Number.isFinite(prevLastSeq) && Number.isFinite(evSeq)
    && evSeq === prevLastSeq + 1;
  return seqsConsecutive ? 'fold' : 'new-batch';
}

t('perm_request with consecutive seq folds (baseline — pre-fix behavior preserved)', () => {
  const prev = { evType: '_chrome_batch', running: 'true', lastSeq: '10' };
  const ev = { type: 'permission_request', seq: 11, toolName: 'Bash' };
  assert.strictEqual(simulateGate(prev, ev, true), 'fold',
    'perm_request with seq=prevLastSeq+1 must fold (this case worked before the fix too — guard against regression)');
});

t('perm_request with NON-consecutive seq STILL folds (bug-67 fix in action)', () => {
  // The user's report: tool_use lands at seq=10, then a chat-msg
  // or system note bumps the shared seq counter, then perm_request
  // arrives at seq=12 (gap of 2). Pre-fix this would close the
  // batch + start a new one. Post-fix the always-folds helper
  // bypasses the seq check.
  const prev = { evType: '_chrome_batch', running: 'true', lastSeq: '10' };
  const ev = { type: 'permission_request', seq: 12, toolName: 'Bash' };
  assert.strictEqual(simulateGate(prev, ev, true), 'fold',
    'perm_request with a seq gap must STILL fold — this is the core bug-67 fix');
});

t('perm_resolved with NON-consecutive seq also folds (symmetric with perm_request)', () => {
  const prev = { evType: '_chrome_batch', running: 'true', lastSeq: '15' };
  const ev = { type: 'permission_resolved', seq: 20, toolName: 'Bash', decision: 'allow' };
  assert.strictEqual(simulateGate(prev, ev, true), 'fold',
    'perm_resolved must fold the same way perm_request does — both are part of the tool-call lifecycle');
});

t('turn_result with NON-consecutive seq folds (existing behavior, preserved by helper)', () => {
  // turn_result already had an inline short-circuit. The helper
  // hoists that into one source of truth; this case must still fold.
  const prev = { evType: '_chrome_batch', running: 'true', lastSeq: '8' };
  const ev = { type: 'turn_result', seq: 22, subtype: 'success' };
  assert.strictEqual(simulateGate(prev, ev, true), 'fold',
    'turn_result must continue to fold — moving it into the helper must not regress its prior behavior');
});

t('non-always-fold chrome event with seq gap STILL breaks the batch (intended)', () => {
  // The seq-consecutive check is still authoritative for events
  // that AREN'T tied to the prev tool-call lifecycle. A tool_use
  // landing with a seq gap means something interleaved that we
  // can't see — the conservative move is still to start a fresh
  // batch.
  const prev = { evType: '_chrome_batch', running: 'true', lastSeq: '10' };
  const ev = { type: 'tool_use', seq: 12, name: 'Bash' };
  assert.strictEqual(simulateGate(prev, ev, true), 'new-batch',
    'tool_use with a seq gap must still start a new batch — the helper only relaxes the gate for perm_* + turn_result');
});

t('perm_request with prev = assistant_text card → new batch (intended semantic break)', () => {
  // If a non-chrome event renders between (assistant_text card,
  // chat-msg bubble, turn-footer), prev DOM sibling is no longer
  // a chrome batch. The helper does NOT override this — a fresh
  // batch is correct because there's a real visual gap.
  const prev = { evType: 'assistant_text', running: 'true', lastSeq: '10' };
  const ev = { type: 'permission_request', seq: 11, toolName: 'Bash' };
  assert.strictEqual(simulateGate(prev, ev, true), 'new-batch',
    'perm_request after assistant_text must start a NEW batch — the always-folds helper only kicks in when prev IS a chrome batch');
});

t('perm_request with prev = chat-msg bubble → new batch (chat-msg from viewer breaks batch)', () => {
  // A chat-msg appended to #chat-messages has neither
  // dataset.evType nor any chrome marker. The gate must treat it
  // as a semantic break.
  const prev = { evType: 'chat-msg', running: 'true', lastSeq: '10' };
  const ev = { type: 'permission_request', seq: 11, toolName: 'Bash' };
  assert.strictEqual(simulateGate(prev, ev, true), 'new-batch',
    'perm_request after a chat-msg bubble must start a new batch');
});

t('perm_request with no prev (empty pane) → new batch', () => {
  const ev = { type: 'permission_request', seq: 5, toolName: 'Bash' };
  assert.strictEqual(simulateGate(null, ev, true), 'new-batch',
    'perm_request on an empty pane must create the first batch — no prev to fold into');
});

t('_chromeEventAlwaysFolds returns false for tool_use / hook_allow / system_event / rate_limit', () => {
  // Defense: the helper must NOT silently widen to other chrome
  // types — that would over-relax the seq check and lose the
  // chronological break-detection for the bulk of chrome events.
  // bug-67 r3: tool_result MOVED into always-folds (user follow-up
  // — tool_result post-menu-card was still splitting). Updated this
  // assertion to remove tool_result; the round-2 test now covers
  // the positive case (tool_result IS in always-folds).
  assert.strictEqual(_chromeEventAlwaysFolds({ type: 'tool_use' }), false);
  assert.strictEqual(_chromeEventAlwaysFolds({ type: 'hook_allow' }), false);
  assert.strictEqual(_chromeEventAlwaysFolds({ type: 'hook_deny' }), false);
  assert.strictEqual(_chromeEventAlwaysFolds({ type: 'system_event' }), false);
  assert.strictEqual(_chromeEventAlwaysFolds({ type: 'rate_limit' }), false);
});

t('_chromeEventAlwaysFolds is a no-op for null / undefined / typeless events', () => {
  assert.strictEqual(_chromeEventAlwaysFolds(null), false);
  assert.strictEqual(_chromeEventAlwaysFolds(undefined), false);
  assert.strictEqual(_chromeEventAlwaysFolds({}), false);
  assert.strictEqual(_chromeEventAlwaysFolds({ type: '' }), false);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
