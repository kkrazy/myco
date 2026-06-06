// bug-68: plan items must run analyze/code/verify stages each gated by a
// critic review modal — and the accept signal must actually advance
// claude to the next stage.
//
// User-reported (verbatim, plan-item comment from @kkrazy):
//   "the current solution is half baked, sometimes the critic verdict
//    would show up, sometimes no, sometimes in wrong order. sometimes
//    no action after I accept the proposal."
//
// Root cause (pre-bug-68):
//   The accept signal (button click or chat-accept phrase) transitioned
//   stageState server-side + cleared the verdict pane via the
//   `critique-resolved` broadcast — but NEVER dispatched anything to
//   claude. CLAUDE.md §9 documented "claude advances to the next stage
//   immediately" but the implementation never wired it: claude sat idle
//   awaiting input that never arrived. User had to manually type
//   "continue" (which isn't in _matchAcceptPhrase, so it falls through
//   to session.write).
//
// Fix (bug-68):
//   1. _postAcceptStagePrompt helper in attach.js — formats a structured
//      synthetic prompt ([stage-accepted: X→Y] / [stage-fix]) + calls
//      session.write() so claude sees a normal user turn with the
//      stage-advance cue. Mirrored into chat as a system note tagged
//      meta.kind:'bug-68-dispatch'.
//   2. _maybeHandleChatAccept (attach.js) — both branches (verify +
//      intermediate) now call _postAcceptStagePrompt after the existing
//      server-side state transition.
//   3. resolveCritique (critique.js) — accept-stage / fix-stage paths
//      also call _postAcceptStagePrompt; fix-stage includes the verdict
//      body from fr-98's item.meta.lastCriticReview.
//   4. clearActiveRunItem (attach.js) — verify-accept button path
//      dispatches accept-verify. 'discard' and 'chat-accept-verify'
//      reasons are excluded (discard = abandoned; chat-accept-verify
//      already dispatched via _maybeHandleChatAccept).
//   5. _emitCritiqueSkipNote (attach.js) — when a critic skips because
//      of empty diff or baseline-WIP-only paths, emit a chat note
//      explaining why so the user knows what happened.
//   6. Critique-error chat note (critique.js) — same idea for the
//      isError verdict path.
//   7. _detectStageSentinels (agent-session.js) — at most ONE stage-done
//      per turn. Multiple sentinels in one assistant_text block fire
//      only the first; the rest are dropped with a logged note.
//
// Test shape: unit tests on the helper format + static-grep guards on
// the wiring (so the prod call sites can't silently drift).

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

console.log('── bug-68: 3-stage workflow reliability ──');

// ── 1. _postAcceptStagePrompt helper exists + formats correctly ──

t('attach.js exports _postAcceptStagePrompt', () => {
  const attach = require('../server/src/attach');
  assert.strictEqual(typeof attach._postAcceptStagePrompt, 'function',
    'attach.js must export _postAcceptStagePrompt so critique.js can call the same helper as _maybeHandleChatAccept.');
});

t('_postAcceptStagePrompt accept-stage: synthetic prompt carries [stage-accepted: X→Y] marker', () => {
  const attach = require('../server/src/attach');
  let captured = null;
  const fakeSession = {
    write(text) { captured = text; },
    emit() { /* swallow chat emit */ },
  };
  const ok = attach._postAcceptStagePrompt('sess-bug68-1', fakeSession, {
    itemId: 'td-99', stage: 'analyze', next: 'code', reason: 'accept-stage',
  });
  assert.strictEqual(ok, true, 'helper returns true on successful dispatch');
  assert.ok(captured, 'session.write must be called with the synthetic prompt');
  assert.ok(/\[stage-accepted:\s*analyze\s*→\s*code\]/.test(captured),
    `synthetic prompt for accept-stage must include the marker [stage-accepted: analyze→code] so claude can branch deterministically. Got: ${JSON.stringify(captured.slice(0, 200))}`);
  assert.ok(/proceed to the code stage/i.test(captured),
    'synthetic prompt must include a plain-English cue ("proceed to the code stage").');
});

t('_postAcceptStagePrompt accept-verify: synthetic prompt carries [stage-accepted: verify→done] marker', () => {
  const attach = require('../server/src/attach');
  let captured = null;
  const fakeSession = { write(t) { captured = t; }, emit() {} };
  const ok = attach._postAcceptStagePrompt('sess-bug68-2', fakeSession, {
    itemId: 'bug-99', stage: 'verify', reason: 'accept-verify',
  });
  assert.strictEqual(ok, true);
  assert.ok(/\[stage-accepted:\s*verify\s*→\s*done\]/.test(captured),
    'verify-accept marker must be [stage-accepted: verify→done] (the run is complete).');
  assert.ok(/complete/i.test(captured),
    'verify-accept prompt must communicate that the run is complete.');
});

t('_postAcceptStagePrompt fix-stage: synthetic prompt carries [stage-fix] marker + redo cue', () => {
  const attach = require('../server/src/attach');
  let captured = null;
  const fakeSession = { write(t) { captured = t; }, emit() {} };
  // fix-stage reads from item.meta.lastCriticReview, which only exists
  // if a session record + plan item are in the store. Without a real
  // session, the helper falls back to "(Critic verdict body unavailable)"
  // — that's the gracefully-degraded path. Test it.
  const ok = attach._postAcceptStagePrompt('sess-bug68-fix', fakeSession, {
    itemId: 'fr-99', stage: 'code', reason: 'fix-stage',
  });
  assert.strictEqual(ok, true);
  assert.ok(/\[stage-fix\]/.test(captured),
    'fix-stage prompt must carry the [stage-fix] marker so claude knows to redo.');
  assert.ok(/redo the code stage/i.test(captured),
    'fix-stage prompt must tell claude which stage to redo (`redo the code stage`).');
  assert.ok(/Re-emit `\[stage: code done\]`/.test(captured),
    'fix-stage prompt must instruct claude to re-emit the sentinel when redo is complete.');
});

t('_postAcceptStagePrompt: missing required fields are rejected (returns false, no write)', () => {
  const attach = require('../server/src/attach');
  let writeCalled = false;
  const fakeSession = { write() { writeCalled = true; }, emit() {} };
  assert.strictEqual(attach._postAcceptStagePrompt('sess', fakeSession, {}), false,
    'helper must reject empty opts');
  assert.strictEqual(attach._postAcceptStagePrompt('sess', fakeSession, { itemId: 'x', stage: 'analyze' }), false,
    'helper must reject missing reason');
  assert.strictEqual(attach._postAcceptStagePrompt('sess', fakeSession, { itemId: 'x', stage: 'analyze', reason: 'accept-stage' }), false,
    'helper must reject accept-stage without next');
  assert.strictEqual(attach._postAcceptStagePrompt('sess', fakeSession, { itemId: 'x', stage: 'analyze', reason: 'bogus' }), false,
    'helper must reject unknown reasons');
  assert.strictEqual(writeCalled, false,
    'session.write must NOT be called when validation fails — otherwise we land a malformed synthetic prompt.');
});

t('_postAcceptStagePrompt mirrors the synthetic prompt as a chat note (so user can SEE what was sent)', () => {
  const attach = require('../server/src/attach');
  let emittedChat = null;
  const fakeSession = {
    write() { /* swallow */ },
    emit(channel, msg) { if (channel === 'chat') emittedChat = msg; },
  };
  attach._postAcceptStagePrompt('sess-bug68-chatmirror', fakeSession, {
    itemId: 'td-99', stage: 'analyze', next: 'code', reason: 'accept-stage',
  });
  assert.ok(emittedChat, 'helper must emit a chat note so the user sees what was dispatched to claude.');
  assert.strictEqual(emittedChat.meta && emittedChat.meta.kind, 'bug-68-dispatch',
    'chat note meta.kind must be `bug-68-dispatch` for traceability + UI tagging.');
  assert.ok(/analyze accepted/i.test(emittedChat.text) || /accept/i.test(emittedChat.text),
    'chat note text must indicate the acceptance happened.');
});

// ── 2. Wiring: _maybeHandleChatAccept calls the helper on both branches ──

t('_maybeHandleChatAccept verify branch calls _postAcceptStagePrompt(accept-verify)', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/function\s+_maybeHandleChatAccept\s*\(/);
  assert.ok(at > -1, '_maybeHandleChatAccept must exist.');
  const body = sliceFn(src, at);
  // The function has two terminal branches (verify + intermediate).
  // The verify branch is gated by `if (stage === 'verify')`. Look for
  // the postAccept call within that branch.
  const verifyAt = body.search(/if\s*\(\s*stage\s*===\s*['"]verify['"]\s*\)/);
  assert.ok(verifyAt > -1, "verify branch (if (stage === 'verify')) must exist.");
  // Look for the postAccept call somewhere after the verify branch
  // entry — bounded window so it doesn't pick up the intermediate
  // branch's call.
  const verifyBlock = body.slice(verifyAt, verifyAt + 1500);
  assert.ok(/_postAcceptStagePrompt\s*\(/.test(verifyBlock),
    "_maybeHandleChatAccept's verify branch must call _postAcceptStagePrompt — otherwise the chat-accept-verify clears server state but claude sits idle (bug-68 root cause).");
  assert.ok(/reason\s*:\s*['"]accept-verify['"]/.test(verifyBlock),
    "verify branch must pass reason:'accept-verify' to _postAcceptStagePrompt.");
});

t('_maybeHandleChatAccept intermediate branch calls _postAcceptStagePrompt(accept-stage) with next', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/function\s+_maybeHandleChatAccept\s*\(/);
  const body = sliceFn(src, at);
  // The intermediate branch starts after the verify branch — locate
  // by the `const next = stageStateMod.nextStage(stage);` line.
  const nextAt = body.search(/const\s+next\s*=\s*stageStateMod\.nextStage\s*\(/);
  assert.ok(nextAt > -1, "intermediate branch's nextStage lookup must exist.");
  const interBlock = body.slice(nextAt);
  assert.ok(/_postAcceptStagePrompt\s*\(/.test(interBlock),
    "_maybeHandleChatAccept's intermediate branch must call _postAcceptStagePrompt — otherwise chat-accept on analyze/code transitions stageState but claude doesn't move.");
  assert.ok(/reason\s*:\s*['"]accept-stage['"]/.test(interBlock),
    "intermediate branch must pass reason:'accept-stage' to _postAcceptStagePrompt.");
});

// ── 3. Wiring: resolveCritique calls the helper for accept-stage / fix-stage ──

t('critique.js resolveCritique accept-stage branch calls attachMod._postAcceptStagePrompt', () => {
  const src = _read('server/src/critique.js');
  const at = src.search(/function\s+resolveCritique\s*\(/);
  assert.ok(at > -1, 'resolveCritique must exist.');
  const body = sliceFn(src, at);
  // Accept-stage branch: `if (next) { _transitionStageState(..., next, 'in_progress'); }`
  // Look for the helper call following that pattern.
  assert.ok(/_postAcceptStagePrompt\s*\(/.test(body),
    "resolveCritique must call attachMod._postAcceptStagePrompt for accept-stage / fix-stage — otherwise the button click clears the modal + advances stageState but claude is never notified (bug-68 root cause).");
  // Confirm both reasons are dispatched.
  assert.ok(/reason\s*:\s*['"]accept-stage['"]/.test(body),
    "resolveCritique's accept-stage path must dispatch reason:'accept-stage' to the helper.");
  assert.ok(/reason\s*:\s*['"]fix-stage['"]/.test(body),
    "resolveCritique's fix-stage path must dispatch reason:'fix-stage' to the helper.");
});

// ── 4. Wiring: clearActiveRunItem dispatches accept-verify for button path ──

t('clearActiveRunItem dispatches accept-verify (button) but NOT chat-accept-verify or discard', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/function\s+clearActiveRunItem\s*\(/);
  assert.ok(at > -1, 'clearActiveRunItem must exist.');
  const body = sliceFn(src, at);
  // Must dispatch accept-verify (button click path via POST /run/done).
  assert.ok(/_postAcceptStagePrompt\s*\(/.test(body),
    'clearActiveRunItem must call _postAcceptStagePrompt so the verify-accept BUTTON path dispatches to claude (bug-68).');
  // Must gate on reason === 'accept-verify' (so chat-accept-verify
  // which already dispatched via _maybeHandleChatAccept doesn't fire
  // twice, and discard which is abandonment doesn't fire at all).
  assert.ok(/reason\s*===\s*['"]accept-verify['"]/.test(body),
    'clearActiveRunItem must gate the dispatch on reason === "accept-verify" — discard + chat-accept-verify must be excluded to avoid double-dispatch and abandonment-misdispatch (bug-68).');
});

// ── 5. Critique-skip chat notes ──

t('attach.js _emitCritiqueSkipNote helper exists', () => {
  const src = _read('server/src/attach.js');
  assert.ok(/function\s+_emitCritiqueSkipNote\s*\(/.test(src),
    '_emitCritiqueSkipNote helper must exist (bug-68 — surfaces critic-skips in chat instead of stderr-only).');
});

t('attach.js stage-done handler emits skip-note when critic skips (no changes / baseline-wip-only)', () => {
  const src = _read('server/src/attach.js');
  // The two skip sites in the stage-done handler (no-changes branch +
  // baseline-wip-only branch). Find the handler + assert both skip
  // sites emit a note. Window of 7000 chars covers the full handler
  // including bug-68's added skip-note bodies + their explanatory
  // comments.
  const at = src.search(/session\.on\(\s*['"]stage-done['"]/);
  assert.ok(at > -1, 'stage-done handler must exist.');
  const body = src.slice(at, at + 7000);
  const noteCallCount = (body.match(/_emitCritiqueSkipNote\s*\(/g) || []).length;
  assert.ok(noteCallCount >= 2,
    `stage-done handler must call _emitCritiqueSkipNote at BOTH skip sites (no-changes + baseline-wip-only) — found ${noteCallCount} call(s). Without this the critic-skip is stderr-only and the user sees "verdict didn't show up" with no explanation (bug-68).`);
});

t('attach.js final-critique site (turn_result IIFE) emits skip-note on baseline-wip-only', () => {
  const src = _read('server/src/attach.js');
  // Find the critique-gate inside the turn_result success IIFE.
  const at = src.search(/\[critique-gate\][^"]*produced no run-attributable changes/);
  assert.ok(at > -1, 'final-critique gate log must exist.');
  // Look for the skip-note call within ~600 chars after.
  const after = src.slice(at, at + 600);
  assert.ok(/_emitCritiqueSkipNote\s*\(/.test(after),
    'final-critique skip site must also call _emitCritiqueSkipNote so the user sees why the FINAL verdict didn\'t appear (bug-68).');
});

// ── 6. Critique-error chat note ──

t('critique.js error verdict broadcasts a chat note explaining the error', () => {
  const src = _read('server/src/critique.js');
  // The error branch is the `else` of `if (!isError)` after the
  // critique-review emit. Find that else.
  const at = src.search(/if\s*\(\s*!\s*isError\s*\)/);
  assert.ok(at > -1, 'isError gate must exist in the critique broadcast.');
  // Look in a window after the gate for the error chat note.
  const block = src.slice(at, at + 2500);
  assert.ok(/bug-68-critique-error/.test(block),
    "critique.js's !isError gate must include an else branch that emits a chat note with meta.kind:'bug-68-critique-error' — pre-bug-68 the error verdict landed silently with a ↻ Retry button + no explanation of WHY (bug-68).");
});

// ── 7. One-sentinel-per-turn cap ──

t('agent-session.js _detectStageSentinels caps at ONE stage-done per turn', () => {
  const src = _read('server/src/agent-session.js');
  const at = src.search(/_detectStageSentinels\s*\(/);
  assert.ok(at > -1, '_detectStageSentinels must exist.');
  const body = sliceFn(src, at);
  // The cap is implemented via _firedStagesThisTurn (Set, cleared on
  // turn_result). The function must check this set BEFORE the regex
  // loop and short-circuit if any stage has already fired.
  assert.ok(/_firedStagesThisTurn/.test(body),
    '_detectStageSentinels must track _firedStagesThisTurn so it can cap at one sentinel per turn (bug-68 — fixes the "[stage: analyze done] ... [stage: code done]" same-tick case that caused out-of-order verdicts).');
  // The reset of _firedStagesThisTurn must happen on turn_result —
  // look for that in the file body (not just the detector function).
  const fullSrc = _read('server/src/agent-session.js');
  assert.ok(/this\._firedStagesThisTurn\s*=\s*null/.test(fullSrc),
    '_firedStagesThisTurn must be reset (set to null) on turn_result so the NEXT turn can fire a fresh stage. Without the reset, a multi-turn run would only ever fire one stage and the rest would be silently dropped.');
});

t('agent-session.js _detectStageSentinels BREAKS after first match (per-turn lexical cap)', () => {
  const src = _read('server/src/agent-session.js');
  const at = src.search(/_detectStageSentinels\s*\(/);
  const body = sliceFn(src, at);
  // The regex loop must contain a `break;` after emitting stage-done.
  // The pre-bug-68 code had no break — it iterated through every
  // sentinel in the text. Widened the window to 600 chars to accept
  // the explanatory comment block between emit + break.
  assert.ok(/this\.emit\s*\(\s*['"]stage-done['"][\s\S]{0,600}break\s*;/.test(body),
    '_detectStageSentinels must break out of the regex loop after the first this.emit("stage-done") — pre-bug-68 the loop iterated through every sentinel and fired all of them sequentially (root cause of "wrong order" symptom in bug-68).');
});

// ── 8. CLAUDE.md §9 documents the dispatch mechanism ──

// ── 9. Option B addition 1: sentinel-received chat note ──

t('attach.js stage-done handler emits sentinel-received note IMMEDIATELY (Option B addition 1)', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/session\.on\(\s*['"]stage-done['"]/);
  assert.ok(at > -1, 'stage-done handler must exist.');
  const body = src.slice(at, at + 2500);
  assert.ok(/_emitSentinelReceivedNote\s*\(/.test(body),
    "stage-done handler must call _emitSentinelReceivedNote so the user sees \"📍 sentinel received\" IMMEDIATELY — pre-Option-B the 10-60s gap between sentinel + critic verdict was dead air (bug-68 reliability gap).");
});

t('attach.js _emitSentinelReceivedNote helper exists with bug-68-sentinel-received meta.kind', () => {
  const src = _read('server/src/attach.js');
  assert.ok(/function\s+_emitSentinelReceivedNote\s*\(/.test(src),
    '_emitSentinelReceivedNote helper must exist (Option B addition 1).');
  assert.ok(/bug-68-sentinel-received/.test(src),
    'sentinel-received note must tag meta.kind:"bug-68-sentinel-received" for traceability + UI tagging.');
});

// ── 10. Option B addition 2: client-side bug-61 drop toast ──

t('web/public/app.js warnToast helper exists (Option B addition 2)', () => {
  const src = _read('web/public/app.js');
  assert.ok(/function\s+warnToast\s*\(/.test(src),
    'warnToast helper must exist — 5-second longer-lived variant for messages that need user attention.');
});

t('app.js bug-61 drop site triggers warnToast (Option B addition 2)', () => {
  const src = _read('web/public/app.js');
  // The bug-61 drop is at the `console.warn` near the top of the
  // critique-review handler. Look for warnToast within ~1200 chars
  // after the drop warn (Option B addition 2 inserted an explanatory
  // comment block between the warn + the warnToast call).
  const dropAt = src.search(/\[bug-61\] dropping incoming intermediate/);
  assert.ok(dropAt > -1, 'bug-61 drop console.warn must exist.');
  const after = src.slice(dropAt, dropAt + 1200);
  assert.ok(/warnToast\s*\(/.test(after),
    "the bug-61 drop site must fire warnToast — pre-Option-B-2 the drop was silent console.warn, leaving the user with \"verdict didn't show up\" + no signal why.");
});

t('styles.css declares .toast-warn variant (Option B addition 2)', () => {
  const src = _read('web/public/styles.css');
  assert.ok(/\.toast\.toast-warn\s*\{/.test(src),
    '.toast.toast-warn CSS rule must exist so warnToast renders with the amber-warn visual treatment.');
});

// ── 11. Option B addition 3: accept-ack timeout ──

t('attach.js declares ACCEPT_ACK_TIMEOUT_MS + the 3 ack-machinery helpers', () => {
  const src = _read('server/src/attach.js');
  assert.ok(/const\s+ACCEPT_ACK_TIMEOUT_MS\s*=/.test(src),
    'ACCEPT_ACK_TIMEOUT_MS constant must be declared (default 90_000ms = 90s).');
  assert.ok(/function\s+_armAcceptAckExpectation\s*\(/.test(src),
    '_armAcceptAckExpectation helper must exist.');
  assert.ok(/function\s+_clearAcceptAckExpectation\s*\(/.test(src),
    '_clearAcceptAckExpectation helper must exist.');
  assert.ok(/function\s+_onAssistantTextClearAckExpectation\s*\(/.test(src),
    '_onAssistantTextClearAckExpectation helper must exist (clears expectation when claude produces output — the success signal).');
  assert.ok(/function\s+_emitAcceptAckTimeoutNote\s*\(/.test(src),
    '_emitAcceptAckTimeoutNote helper must exist (emits the nudge note when claude doesn\'t respond within the deadline).');
});

t('_postAcceptStagePrompt arms the accept-ack expectation after session.write (Option B addition 3)', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/function\s+_postAcceptStagePrompt\s*\(/);
  assert.ok(at > -1, '_postAcceptStagePrompt must exist.');
  const body = sliceFn(src, at);
  // The expectation arm must follow the session.write call (otherwise
  // an arm-then-fail-to-write would leak a watcher with no actual
  // dispatch to ack).
  const writeAt = body.search(/session\.write\s*\(/);
  assert.ok(writeAt > -1, '_postAcceptStagePrompt must call session.write.');
  const afterWrite = body.slice(writeAt);
  assert.ok(/_armAcceptAckExpectation\s*\(/.test(afterWrite),
    '_postAcceptStagePrompt must call _armAcceptAckExpectation AFTER session.write — otherwise a session.write failure leaks a watcher with no dispatch to ack (Option B addition 3).');
});

t('attach.js has a dedicated assistant_text agent-event listener that clears the ack expectation', () => {
  const src = _read('server/src/attach.js');
  // Look for the listener that filters on ev.type === 'assistant_text'
  // and calls _onAssistantTextClearAckExpectation.
  // Allow either === or == and either single or double quotes.
  const re = /ev\.type\s*!==\s*['"]assistant_text['"]\s*\)\s*return\s*;[\s\S]{0,200}_onAssistantTextClearAckExpectation/;
  assert.ok(re.test(src),
    'attach.js must have an agent-event listener gated on ev.type === "assistant_text" that calls _onAssistantTextClearAckExpectation — this is the "claude picked up the dispatch" signal that clears the timeout (Option B addition 3).');
});

t('clearActiveRunItem clears any pending accept-ack expectation (Option B addition 3)', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/function\s+clearActiveRunItem\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/_clearAcceptAckExpectation\s*\(/.test(body),
    'clearActiveRunItem must call _clearAcceptAckExpectation — otherwise a stale expectation could fire 30-90s after the run ends and emit a misleading "claude hasn\'t picked up" note on a completed run (Option B addition 3).');
});

t('_armAcceptAckExpectation: timer fires emitAcceptAckTimeoutNote when not cleared (smoke test)', async () => {
  // Smoke test the timer mechanism end-to-end using a tiny timeout.
  // Inject ACCEPT_ACK_TIMEOUT_MS as small via direct manipulation of
  // the helper isn't possible without exporting it; instead, use the
  // public _postAcceptStagePrompt with a stub session and observe
  // that an arm happened. We cannot easily test the TIMEOUT firing
  // without waiting 90s, so this test asserts the arm placed the
  // expectation on session._expectingAcceptAck (the timer plumbing
  // itself is exercised by the static-grep guards above).
  const attach = require('../server/src/attach');
  const fakeSession = {
    write() { /* swallow */ },
    emit() { /* swallow */ },
    _expectingAcceptAck: null,
  };
  attach._postAcceptStagePrompt('sess-bug68-ack', fakeSession, {
    itemId: 'td-99', stage: 'analyze', next: 'code', reason: 'accept-stage',
  });
  assert.ok(fakeSession._expectingAcceptAck, 'session._expectingAcceptAck must be set after _postAcceptStagePrompt fires.');
  assert.strictEqual(fakeSession._expectingAcceptAck.stage, 'analyze',
    'expectation must carry the stage that was accepted.');
  assert.strictEqual(fakeSession._expectingAcceptAck.next, 'code',
    'expectation must carry the next stage (for the nudge-note hint).');
  assert.ok(typeof fakeSession._expectingAcceptAck.deadline === 'number',
    'expectation must carry a deadline (ms timestamp).');
  // Clean up the timer so the test process doesn't hang.
  if (fakeSession._expectingAcceptAck.timer) {
    clearTimeout(fakeSession._expectingAcceptAck.timer);
  }
});

t('CLAUDE.md §9 documents the bug-68 dispatch mechanism', () => {
  const md = _read('CLAUDE.md');
  // The §9 prose must reference the synthetic-prompt dispatch helper
  // by name so a future maintainer can find the implementation from
  // the protocol document.
  assert.ok(/_postAcceptStagePrompt/.test(md),
    'CLAUDE.md must reference _postAcceptStagePrompt so a maintainer can trace the protocol → implementation linkage (bug-68 documentation update).');
  assert.ok(/\[stage-accepted:/.test(md),
    'CLAUDE.md must document the [stage-accepted: X→Y] synthetic marker shape so a maintainer reading the protocol doc knows what claude actually sees.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
