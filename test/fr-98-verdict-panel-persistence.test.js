// fr-98: render verdict panel like AskUserQuestion for cross-device,
// session-restart persistence.
//
// User-reported (verbatim, plan-item dispatch from @kkrazy):
//   Problem:  The verdict panel doesn't persist consistently across
//             devices or after session restart, unlike AskUserQuestion.
//   Expected: Verdict panel renders using the same mechanism as
//             AskUserQuestion, so it remains consistent across device
//             and session restart.
//   Actual:   Verdict panel uses a different rendering path that
//             doesn't survive device switches or session restarts.
//
// Root cause (pre-fr-98):
//   critique.js fired session.emit('state-update', { kind:
//   'critique-review', … }) — a fire-once broadcast that reached only
//   currently-attached WebSocket clients. The payload was NEVER
//   persisted to disk. A new device attaching mid-pending-verdict, or
//   any device after a container restart, saw stageState =
//   awaiting_accept (fr-96 persisted that part) but no pane to render.
//   The run was paused and unresolvable.
//
// Fix (fr-98):
//   1. server/src/stageState.js — three new helpers next to the existing
//      stageState API: setLastCriticReview / clearLastCriticReview /
//      getLastCriticReview. The verdict payload is persisted at
//      item.meta.lastCriticReview in plan.json.
//   2. server/src/critique.js — after the existing fire-once broadcast,
//      call setLastCriticReview(item, payload) + sessionsMod.saveStore()
//      so the verdict is durable. Also clear in resolveCritique for
//      accept-stage / fix-stage so resolved verdicts don't replay.
//   3. server/src/attach.js — _clearAndBroadcastStageState pairs
//      clearLastCriticReview with clearStageState (single chokepoint,
//      single guard). _sendAttachSnapshot replays the persisted
//      verdict for any item whose stageState.status is awaiting_*
//      so fresh attaches (new device or post-restart) render the same
//      pane the originating device saw.
//
// Test shape: runtime unit tests against the stageState helpers +
// static-grep guards on critique.js / attach.js for the wiring.

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

console.log('── fr-98: verdict panel cross-device + session-restart persistence ──');

const stageState = require('../server/src/stageState');
const {
  setLastCriticReview,
  clearLastCriticReview,
  getLastCriticReview,
  initStageState,
  applyTransition,
} = stageState;

// ── 1. Helpers: set / clear / get round-trip ──

t('setLastCriticReview: stamps item.meta.lastCriticReview with payload + broadcastAt', () => {
  const item = { id: 'td-1' };
  const payload = {
    kind: 'critique-review',
    itemId: 'td-1',
    stage: 'analyze',
    critique: '✓ AGREED\n\nThe plan looks sound.',
    isError: false,
    isIntermediate: true,
  };
  const out = setLastCriticReview(item, payload);
  assert.ok(out, 'returns the stored payload');
  assert.strictEqual(item.meta.lastCriticReview.critique, payload.critique);
  assert.strictEqual(item.meta.lastCriticReview.stage, 'analyze');
  assert.ok(typeof item.meta.lastCriticReview.broadcastAt === 'string',
    'must stamp broadcastAt so the client can flag a replay vs. live broadcast.');
});

t('setLastCriticReview: overwrites a previous review (each broadcast supersedes the prior one)', () => {
  const item = { id: 'td-2' };
  setLastCriticReview(item, { stage: 'analyze', critique: 'first' });
  const firstStamp = item.meta.lastCriticReview.broadcastAt;
  // Sleep one ms-tick to ensure the timestamps differ. Node's Date.now
  // resolution is fine-grained enough that a no-op stamp would not change.
  const wait = Date.now() + 5;
  while (Date.now() < wait) { /* spin briefly */ }
  setLastCriticReview(item, { stage: 'code', critique: 'second' });
  assert.strictEqual(item.meta.lastCriticReview.critique, 'second',
    'second setLastCriticReview must overwrite the first — there is at most one pending verdict per item at a time.');
  assert.notStrictEqual(item.meta.lastCriticReview.broadcastAt, firstStamp,
    'overwriting must refresh broadcastAt.');
});

t('clearLastCriticReview: returns true on first clear, false (no-op) on repeat', () => {
  const item = { id: 'td-3' };
  setLastCriticReview(item, { stage: 'analyze', critique: 'x' });
  assert.strictEqual(clearLastCriticReview(item), true, 'first clear deletes + returns true');
  assert.strictEqual(item.meta.lastCriticReview, undefined,
    'lastCriticReview must be deleted (not just falsy) so the attach replay scan does not enumerate it.');
  assert.strictEqual(clearLastCriticReview(item), false, 'repeat clear is idempotent no-op');
});

t('clearLastCriticReview: no-op on items without meta (no crash)', () => {
  assert.strictEqual(clearLastCriticReview(null), false);
  assert.strictEqual(clearLastCriticReview(undefined), false);
  assert.strictEqual(clearLastCriticReview({}), false);
  assert.strictEqual(clearLastCriticReview({ meta: {} }), false);
});

t('getLastCriticReview: returns null when missing, the payload when present', () => {
  const empty = { id: 'td-4' };
  assert.strictEqual(getLastCriticReview(empty), null);
  setLastCriticReview(empty, { stage: 'verify', critique: 'final ok' });
  const got = getLastCriticReview(empty);
  assert.ok(got);
  assert.strictEqual(got.critique, 'final ok');
  assert.strictEqual(got.stage, 'verify');
});

// ── 2. Persistence layer mirrors the bug-54 broadcast payload ──

t('payload round-trip: every field the broadcast emits survives setLastCriticReview', () => {
  const item = { id: 'td-5' };
  // Mirror the exact shape critique.js:451 emits today.
  const payload = {
    kind: 'critique-review',
    itemId: 'td-5',
    hasDisagreement: true,
    isError: false,
    isIntermediate: false,
    isRetry: false,
    stage: 'verify',
    critique: '✗ DISAGREE\n\nMissing test coverage for the rollback path.',
    diff: 'diff --git a/foo.js b/foo.js\n+const x = 1;',
    criticName: 'Gemini',
    criticId: 'gemini',
    specialties: [
      { id: 'general',       name: 'General QA',     isError: false, isAgreed: false },
      { id: 'test-validity', name: 'Test Validity',  isError: false, isAgreed: true },
    ],
  };
  setLastCriticReview(item, payload);
  const got = getLastCriticReview(item);
  // Strict equality on every field of the broadcast payload — a missed
  // field on persistence means the replayed pane is missing data the
  // original render had.
  for (const k of Object.keys(payload)) {
    assert.deepStrictEqual(got[k], payload[k],
      `payload.${k} must be preserved through setLastCriticReview — replayed pane would otherwise miss this field.`);
  }
});

// ── 3. Lifecycle coupling: stageState + lastCriticReview move together ──

t('lifecycle: a pending verdict (lastCriticReview present) lines up with stageState.status awaiting_*', () => {
  // Simulate the real broadcast path's stageState + verdict pairing:
  // applyTransition takes stageState to awaiting_accept; broadcast
  // would land the verdict at the same time.
  const item = { id: 'td-6' };
  initStageState(item); // analyze.in_progress
  applyTransition(item, 'analyze', 'awaiting_verdict');
  applyTransition(item, 'analyze', 'awaiting_accept');
  setLastCriticReview(item, { stage: 'analyze', critique: 'pending verdict' });
  // The pair is what _sendAttachSnapshot looks for: review present AND
  // stageState.status in awaiting_*. Both must be truthy.
  assert.ok(getLastCriticReview(item));
  assert.strictEqual(item.meta.stageState.status, 'awaiting_accept');
});

t('lifecycle: clear on resolve drops both stageState and lastCriticReview together (replay-safe)', () => {
  const item = { id: 'td-7' };
  initStageState(item);
  applyTransition(item, 'verify', 'awaiting_accept');
  setLastCriticReview(item, { stage: 'verify', critique: 'resolved soon' });
  // verify-accept clears both via _clearAndBroadcastStageState.
  stageState.clearStageState(item);
  clearLastCriticReview(item);
  // After resolve: no replay would fire (review is null OR stageState
  // is missing — both, in this case).
  assert.strictEqual(getLastCriticReview(item), null,
    'after resolve, getLastCriticReview must return null so the attach replay loop skips this item.');
  assert.strictEqual(stageState.getStageState(item), null,
    'after resolve, stageState must also be cleared — the lifecycle moves both together.');
});

// ── 4. Wiring guards: critique.js + attach.js call the helpers ──

t('server/src/stageState.js: setLastCriticReview / clearLastCriticReview / getLastCriticReview are exported', () => {
  const src = _read('server/src/stageState.js');
  const exportAt = src.lastIndexOf('module.exports = {');
  assert.ok(exportAt > -1, 'stageState.js must have a top-level module.exports block.');
  const block = src.slice(exportAt);
  assert.ok(/\bsetLastCriticReview\b/.test(block), 'setLastCriticReview must be exported.');
  assert.ok(/\bclearLastCriticReview\b/.test(block), 'clearLastCriticReview must be exported.');
  assert.ok(/\bgetLastCriticReview\b/.test(block), 'getLastCriticReview must be exported.');
});

t('server/src/critique.js: the broadcast site ALSO calls setLastCriticReview (persistence wiring)', () => {
  const src = _read('server/src/critique.js');
  // The broadcast and persist must be in the same function — locate by
  // searching for the kind:'critique-review' emit and walking forward.
  const at = src.search(/kind:\s*['"]critique-review['"]/);
  assert.ok(at > -1, 'critique.js must still emit kind:"critique-review".');
  // Look in a generous window after the emit for the persistence call.
  const window = src.slice(at, at + 2500);
  assert.ok(/setLastCriticReview\s*\(/.test(window),
    'critique.js must call stageStateMod.setLastCriticReview(item, payload) AFTER the broadcast — without it the verdict is fire-once again (fr-98 regression).');
  assert.ok(/saveStore\s*\(\s*\)/.test(window),
    'critique.js must call sessionsMod.saveStore() after setLastCriticReview so the verdict is durable on disk.');
});

// ── 4b. fr-98 follow-up (2026-06-07): error verdicts ALSO persist ──
//
// Pre-follow-up: `if (rec && !isError)` gated the persist call, so error
// verdicts never landed in plan.json. The bug-68 critique-error chat
// note told users "click the ↻ Retry button on the verdict pane" — but
// the pane was only visible to devices attached AT BROADCAST MOMENT. A
// user re-attaching later saw the chat note + no pane + no Retry button.
// User-reported on bug-58 verbatim: "the following msg never bring up
// the verdict modal: 📍 Analyze sentinel received for bug-58 — critic
// firing (typically 10-30s for Gemini 2.5)." The investigation showed
// the critic errored twice (Gemini 503), the chat notes appeared, but
// the pane was lost on the user's re-attach because error verdicts
// were excluded from persistence.
//
// Follow-up fix: drop the `!isError` gate. ALL verdicts persist; the
// replay-on-attach gate (stageState.status === awaiting_verdict for
// errors, OR awaiting_accept for non-errors) ensures only pending
// verdicts replay.

t('server/src/critique.js: persistence does NOT gate on !isError (fr-98 follow-up — error verdicts ALSO persist for re-attach)', () => {
  const src = _read('server/src/critique.js');
  // Locate the critique-review broadcast site + the persistence block
  // that follows. The pre-follow-up gate was `if (rec && !isError)`;
  // the follow-up uses `if (rec)` only.
  const at = src.search(/kind:\s*['"]critique-review['"]/);
  assert.ok(at > -1, 'critique-review broadcast must exist.');
  const persistBlock = src.slice(at, at + 3000);
  const setAt = persistBlock.search(/setLastCriticReview\s*\(/);
  assert.ok(setAt > -1, 'setLastCriticReview call must exist after the broadcast.');
  // The 400 chars BEFORE the setLastCriticReview call must NOT
  // contain `!isError` — pre-follow-up the gate was `if (rec && !isError)`
  // immediately before the call. Post-follow-up it's `if (rec)` only.
  const before = persistBlock.slice(Math.max(0, setAt - 400), setAt);
  assert.ok(!/!\s*isError/.test(before),
    `setLastCriticReview's surrounding gate must NOT include !isError — error verdicts must also persist so the pane replays on re-attach (fr-98 follow-up, bug-58 in-the-wild repro). Found !isError in the 400 chars before the setLastCriticReview call.`);
});

t('server/src/critique.js: error chat note offers alternative recovery path (▶ Run re-dispatch)', () => {
  const src = _read('server/src/critique.js');
  // The bug-68-critique-error note must mention the ▶ Run alternative
  // since the verdict pane may not be visible (different tab, fresh
  // attach, pane was lost).
  assert.ok(/bug-68-critique-error/.test(src),
    'bug-68-critique-error chat note must exist.');
  // Find the note text — match within a reasonable window of the
  // meta.kind:'bug-68-critique-error' marker.
  const at = src.search(/bug-68-critique-error/);
  const before = src.slice(Math.max(0, at - 1500), at);
  assert.ok(/▶\s*Run/.test(before),
    "bug-68-critique-error chat note must mention `▶ Run` as the alternative recovery path — pane may not be visible on a non-chat tab / fresh attach, and the user needs a way to retry without the pane (fr-98 follow-up).");
});

t('server/src/critique.js: resolveCritique clears lastCriticReview on accept-stage / fix-stage', () => {
  const src = _read('server/src/critique.js');
  const at = src.search(/function\s+resolveCritique\s*\(/);
  assert.ok(at > -1, 'resolveCritique must exist.');
  const body = sliceFn(src, at);
  assert.ok(/clearLastCriticReview\s*\(/.test(body),
    'resolveCritique must clear lastCriticReview so the verdict does not replay on next attach after the user accepted / fixed.');
});

t('server/src/attach.js: _clearAndBroadcastStageState pairs clearLastCriticReview with clearStageState', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/function\s+_clearAndBroadcastStageState\s*\(/);
  assert.ok(at > -1, '_clearAndBroadcastStageState must exist.');
  const body = sliceFn(src, at);
  assert.ok(/clearStageState\s*\(/.test(body),
    '_clearAndBroadcastStageState must still call clearStageState.');
  assert.ok(/clearLastCriticReview\s*\(/.test(body),
    '_clearAndBroadcastStageState must ALSO call clearLastCriticReview — verify-accept and discard clear the stageState, and the verdict referring to it must clear too. This is the chokepoint the test_lastCriticReview_paired_with_stageState static guard locks.');
});

t('server/src/attach.js: _sendAttachSnapshot scans for and replays pending verdicts', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/function\s+_sendAttachSnapshot\s*\(/);
  assert.ok(at > -1, '_sendAttachSnapshot must exist.');
  const body = sliceFn(src, at);
  // Two things must be present: the read (getLastCriticReview) and the
  // replay marker (_replayedOnAttach: true on the WS frame).
  assert.ok(/getLastCriticReview\s*\(/.test(body),
    '_sendAttachSnapshot must call getLastCriticReview to find any pending verdict to replay.');
  assert.ok(/_replayedOnAttach\s*:\s*true/.test(body),
    '_sendAttachSnapshot must tag the replayed frame with _replayedOnAttach:true so the client can distinguish replays from live broadcasts if useful.');
  // Defense against accidentally replaying resolved verdicts: the
  // function must gate on stageState.status awaiting_*.
  assert.ok(/awaiting_(verdict|accept)/.test(body),
    '_sendAttachSnapshot must gate the replay on stageState.status awaiting_verdict/awaiting_accept so resolved verdicts do not ghost-replay.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
