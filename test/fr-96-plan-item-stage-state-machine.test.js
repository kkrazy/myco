// fr-96: per-plan-item stage state machine.
//
// Each plan item that's been dispatched via [run:plan#X] AND has
// emitted at least one [stage: X done] sentinel carries
// item.meta.stageState = { stage, status, updatedAt, history[] }.
//
// Stage values: 'analyze' | 'code' | 'verify'
// Status values: 'in_progress' | 'awaiting_verdict' | 'awaiting_accept'
//
// Transitions (per the §9 3-stage methodology):
//   [run:plan#X] dispatch          → analyze.in_progress (NEW)
//   [stage: X done] sentinel       → X.awaiting_verdict
//   critic verdict broadcast       → X.awaiting_accept
//   ✓ Accept Stage button          → next(X).in_progress
//   ⚡ Ask Claude to Fix Stage     → X.in_progress (redo same stage)
//   ✓ Accept (verify final)        → CLEARED (run done, via /run/done)
//   ✗ Discard                      → CLEARED (run abandoned, via /run/done)
//
// Persistence: rec.artifacts.plan.items[].meta.stageState — survives
// container restart so HUD reflects state across attaches.
// Broadcast: session.emit('state-update', { kind: 'plan-item-stage',
//   itemId, stageState: { stage, status, updatedAt } }).
// HUD: _getHUDActiveStep prefers state.planItemStages[runningItemId]
// over the heuristic fallback; state.planItemStages is derived from
// item.meta.stageState in _rebuildPlanItemStagesFromArtifacts on
// every artifact-cache update.
//
// Test shape: pure-function unit tests on stageState module + static-
// grep on the wiring surface.

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

console.log('── fr-96: per-plan-item stage state machine ──');

// ── 1. stageState module — pure function unit tests ──

const stageState = require('../server/src/stageState');

t('stageState: STAGES + STATUSES constants are exported with the correct vocabularies', () => {
  assert.deepStrictEqual(stageState.STAGES, ['analyze', 'code', 'verify'],
    'STAGES must be exactly [analyze, code, verify] — the §9 3-stage methodology.');
  assert.deepStrictEqual(stageState.STATUSES, ['in_progress', 'awaiting_verdict', 'awaiting_accept'],
    'STATUSES must be exactly [in_progress, awaiting_verdict, awaiting_accept] — the per-stage lifecycle.');
});

t('stageState.nextStage: analyze → code → verify → null', () => {
  assert.strictEqual(stageState.nextStage('analyze'), 'code');
  assert.strictEqual(stageState.nextStage('code'), 'verify');
  assert.strictEqual(stageState.nextStage('verify'), null,
    'nextStage("verify") must return null — verify is the last stage; the next step is run-done (cleared).');
  assert.strictEqual(stageState.nextStage('bogus'), null);
});

t('stageState.initStageState: sets analyze.in_progress + populates history[0]', () => {
  const item = {};
  const ss = stageState.initStageState(item);
  assert.strictEqual(ss.stage, 'analyze');
  assert.strictEqual(ss.status, 'in_progress');
  assert.ok(ss.updatedAt, 'updatedAt must be set');
  assert.ok(Array.isArray(ss.history) && ss.history.length === 1,
    'history must be initialized with exactly 1 entry — the initial transition.');
  assert.strictEqual(ss.history[0].stage, 'analyze');
  assert.strictEqual(ss.history[0].status, 'in_progress');
  // Mutation contract: the item gains meta.stageState.
  assert.strictEqual(item.meta.stageState, ss);
});

t('stageState.initStageState: re-init resets state + history (re-dispatch starts fresh cycle)', () => {
  const item = {};
  stageState.initStageState(item);
  // Advance the state to verify.awaiting_accept.
  stageState.applyTransition(item, 'verify', 'awaiting_accept');
  // Now re-init — should reset to analyze.in_progress + fresh history.
  const ss = stageState.initStageState(item);
  assert.strictEqual(ss.stage, 'analyze');
  assert.strictEqual(ss.status, 'in_progress');
  assert.strictEqual(ss.history.length, 1,
    'history must be fresh after re-init — old transitions are dropped (the re-dispatch starts a fresh 3-stage cycle).');
});

t('stageState.applyTransition: advances state + appends history; same-state is a no-op', () => {
  const item = {};
  stageState.initStageState(item);
  // Advance.
  const ss1 = stageState.applyTransition(item, 'analyze', 'awaiting_verdict');
  assert.strictEqual(ss1.stage, 'analyze');
  assert.strictEqual(ss1.status, 'awaiting_verdict');
  assert.strictEqual(ss1.history.length, 2, 'history grows on real transition.');
  // No-op: same {stage, status} → don't append history, don't churn updatedAt.
  const ssCopy = JSON.stringify(item.meta.stageState);
  stageState.applyTransition(item, 'analyze', 'awaiting_verdict');
  assert.strictEqual(JSON.stringify(item.meta.stageState), ssCopy,
    'applyTransition with same {stage, status} as current must be a no-op — no history churn, no updatedAt churn.');
});

t('stageState.applyTransition: throws on invalid stage / status', () => {
  const item = {};
  stageState.initStageState(item);
  assert.throws(() => stageState.applyTransition(item, 'bogus', 'in_progress'),
    /invalid stage/, 'applyTransition must throw on unknown stage.');
  assert.throws(() => stageState.applyTransition(item, 'analyze', 'bogus'),
    /invalid status/, 'applyTransition must throw on unknown status.');
});

t('stageState.applyTransition: returns null when item has no stageState (race-safe)', () => {
  const item = {};
  // No initStageState — item.meta.stageState is undefined.
  const ss = stageState.applyTransition(item, 'analyze', 'in_progress');
  assert.strictEqual(ss, null,
    'applyTransition on an item without stageState must return null — race with a clear (e.g. user discarded between the broadcast and this transition).');
});

t('stageState.applyTransition: history caps at HISTORY_CAP (20 entries)', () => {
  const item = {};
  stageState.initStageState(item);
  // 25 transitions — should cap at 20.
  for (let i = 0; i < 25; i++) {
    const stage = ['analyze', 'code', 'verify'][i % 3];
    const status = ['in_progress', 'awaiting_verdict', 'awaiting_accept'][i % 3];
    // Make each transition unique by tweaking status pairing
    stageState.applyTransition(item, stage, status);
  }
  assert.ok(item.meta.stageState.history.length <= 20,
    `history must cap at HISTORY_CAP=20. Got ${item.meta.stageState.history.length}.`);
});

t('stageState.clearStageState: deletes item.meta.stageState (CLEARED terminal)', () => {
  const item = {};
  stageState.initStageState(item);
  assert.ok(item.meta.stageState, 'precondition: stageState exists.');
  const cleared = stageState.clearStageState(item);
  assert.strictEqual(cleared, true);
  assert.strictEqual(item.meta.stageState, undefined,
    'clearStageState must DELETE meta.stageState — items without stageState are not in a multi-stage run.');
  // Idempotent: clearing again is a no-op.
  assert.strictEqual(stageState.clearStageState(item), false);
});

t('stageState.toBroadcastPayload: strips history[] (clients don\'t need audit)', () => {
  const item = {};
  stageState.initStageState(item);
  stageState.applyTransition(item, 'code', 'in_progress');
  const payload = stageState.toBroadcastPayload('fr-96', item.meta.stageState);
  assert.strictEqual(payload.itemId, 'fr-96');
  assert.deepStrictEqual(Object.keys(payload.stageState).sort(), ['stage', 'status', 'updatedAt'],
    'toBroadcastPayload must include exactly {stage, status, updatedAt} — no history (clients only need the current state for HUD render).');
});

t('stageState.toBroadcastPayload: null stageState → payload.stageState = null (signals clear)', () => {
  const payload = stageState.toBroadcastPayload('fr-96', null);
  assert.strictEqual(payload.stageState, null,
    'toBroadcastPayload(null) must yield stageState: null in the payload — clients use this to delete their planItemStages entry.');
});

// ── 2. attach.js wiring — hooks 1 + 2 + 4 ──

t('attach.js: dispatch site initializes stage state machine (_initAndBroadcastStageState called from [run:plan#X] handler)', () => {
  const src = _read('server/src/attach.js');
  // Anchor on the dispatch site — where _activeRunItem is set.
  const at = src.search(/session\._activeRunItem\s*=\s*\{/);
  assert.ok(at > -1, '_activeRunItem set-site must exist.');
  const body = src.slice(at, at + 1500);
  assert.ok(/_initAndBroadcastStageState\s*\(/.test(body),
    'attach.js dispatch site must call _initAndBroadcastStageState — that\'s the [*] → analyze.in_progress transition (fr-96 hook 1).');
});

t('attach.js: stage-done handler transitions to awaiting_verdict (_transitionStageState called)', () => {
  const src = _read('server/src/attach.js');
  // Anchor on the stage-done subscriber.
  const at = src.search(/session\.on\s*\(\s*['"]stage-done['"]/);
  // bug-61 follow-up: window bumped 1500 → 3500. bug-61 added a
  // ~30-line guard block (stageStateMod.getStageState check + early
  // return on awaiting_verdict/awaiting_accept) ABOVE the existing
  // _transitionStageState call. The pre-bug-61 1500-char window
  // caught the call site; post-bug-61 the call sits past 1500 chars.
  // bug-68 Option B addition 1: bumped 3500 → 5500. _emitSentinelReceivedNote
  // is now called IMMEDIATELY after the active-run-item check (BEFORE
  // the bug-61 guard + _transitionStageState), pushing the transition
  // call further down. The fr-96 invariant is "transition fires from
  // the handler"; the helper insertion between handler-entry +
  // transition is legitimate (it's the user-visible "sentinel received"
  // chat note, not a state mutation).
  const body = src.slice(at, at + 5500);
  assert.ok(/_transitionStageState\s*\(\s*sessionId\s*,\s*session\s*,\s*active\.itemId\s*,\s*stage\s*,\s*['"]awaiting_verdict['"]/.test(body),
    'attach.js stage-done handler must call _transitionStageState(..., stage, "awaiting_verdict") — that\'s the in_progress → awaiting_verdict transition (fr-96 hook 2).');
});

t('attach.js: clearActiveRunItem clears stage state (_clearAndBroadcastStageState called)', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/function\s+clearActiveRunItem\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/_clearAndBroadcastStageState\s*\(/.test(body),
    'clearActiveRunItem must call _clearAndBroadcastStageState — that\'s the awaiting_accept → [*] cleared transition for verify-accept + discard (fr-96 hook 4).');
});

t('attach.js: exports _transitionStageState + _clearAndBroadcastStageState + _findPlanItemInRec (critique.js needs them)', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/module\.exports\s*=\s*\{/);
  const body = sliceFn(src, at);
  assert.ok(/_transitionStageState/.test(body),
    'attach.js must export _transitionStageState — critique.js calls it after the verdict broadcast.');
  assert.ok(/_clearAndBroadcastStageState/.test(body),
    'attach.js must export _clearAndBroadcastStageState — for completeness.');
  assert.ok(/_findPlanItemInRec/.test(body),
    'attach.js must export _findPlanItemInRec — critique.js needs it for the resolveCritique stage-transition branch.');
});

// ── 3. critique.js wiring — hook 3 (verdict broadcast → awaiting_accept) + resolveCritique extension ──

t('critique.js: after critic broadcast, transition to awaiting_accept (fr-96 hook 3)', () => {
  const src = _read('server/src/critique.js');
  // The hook must fire AFTER the session.emit('state-update',
  // kind:'critique-review') so the verdict broadcast lands first.
  const emitAt = src.search(/kind:\s*['"]critique-review['"]/);
  assert.ok(emitAt > -1, 'critique-review emit must exist.');
  // Look for the transition call within 4000 chars AFTER the emit.
  // Pre-fr-98 this was 1500 chars; fr-98 added a ~1500-char block
  // (setLastCriticReview persist + saveStore + error handler comment)
  // legitimately BETWEEN the emit and the transition. fr-98 follow-up
  // (2026-06-07) added another ~250 chars of explanatory comment when
  // dropping the !isError gate. The fr-96 contract is "transition is
  // AFTER emit", not "transition is within N chars" — 4000 keeps the
  // ordering assertion while accepting the cumulative explainer prologue.
  const after = src.slice(emitAt, emitAt + 4000);
  assert.ok(/_transitionStageState\s*\([\s\S]{0,300}['"]awaiting_accept['"]/.test(after),
    'critique.js must call attachMod._transitionStageState(..., "awaiting_accept") AFTER the critique-review emit (fr-96 hook 3).');
});

t('critique.js: resolveCritique branches on reason === "accept-stage" → next stage in_progress', () => {
  const src = _read('server/src/critique.js');
  const at = src.search(/function\s+resolveCritique\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/reason\s*===\s*['"]accept-stage['"]/.test(body),
    'resolveCritique must branch on reason === "accept-stage" — the Accept Stage button (bug-56) drives the next-stage transition.');
  assert.ok(/stageStateMod\.nextStage\s*\(/.test(body),
    'resolveCritique accept-stage branch must call stageStateMod.nextStage(cur.stage) to find the next stage in the analyze → code → verify progression.');
});

t('critique.js: resolveCritique branches on reason === "fix-stage" → same stage in_progress', () => {
  const src = _read('server/src/critique.js');
  const at = src.search(/function\s+resolveCritique\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/reason\s*===\s*['"]fix-stage['"]/.test(body),
    'resolveCritique must branch on reason === "fix-stage" — the Ask Claude to Fix Stage button (bug-56) drives the redo-same-stage transition.');
});

// ── 4. Client wiring ──

t('app.js: WS dispatcher case for kind:"plan-item-stage" updates state.planItemStages + re-renders HUD', () => {
  const src = _read('web/public/app.js');
  assert.ok(/msg\.kind\s*===\s*['"]plan-item-stage['"]/.test(src),
    'app.js WS dispatcher must branch on msg.kind === "plan-item-stage" (fr-96 broadcast).');
  const at = src.search(/msg\.kind\s*===\s*['"]plan-item-stage['"]/);
  const body = src.slice(at, at + 1000);
  assert.ok(/state\.planItemStages/.test(body),
    'plan-item-stage handler must mutate state.planItemStages.');
  // Null stageState in payload → delete the entry (clear semantics).
  assert.ok(/delete\s+state\.planItemStages/.test(body),
    'plan-item-stage handler must delete state.planItemStages[itemId] when msg.stageState is null — that\'s the clear/discard signal.');
  assert.ok(/_updateTaskHUD\s*\(\s*\)/.test(body),
    'plan-item-stage handler must call _updateTaskHUD() so the HUD reflects the new stage/status immediately.');
});

t('app.js: _getHUDActiveStep prefers authoritative server-side stage state over heuristic fallback', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/function\s+_getHUDActiveStep\s*\(\)/);
  const body = sliceFn(src, at);
  assert.ok(/state\.planItemStages/.test(body),
    '_getHUDActiveStep must read state.planItemStages — the authoritative server-side stage state (fr-96).');
  // awaiting_verdict / awaiting_accept → Critic chip
  assert.ok(/awaiting_verdict|awaiting_accept/.test(body),
    '_getHUDActiveStep must branch on awaiting_verdict / awaiting_accept to light the Critic chip.');
});

t('app.js: _rebuildPlanItemStagesFromArtifacts derives state.planItemStages from item.meta.stageState', () => {
  const src = _read('web/public/app.js');
  assert.ok(/function\s+_rebuildPlanItemStagesFromArtifacts\s*\(\)/.test(src),
    'app.js must declare _rebuildPlanItemStagesFromArtifacts — derives the planItemStages map from the cached plan items (fr-96).');
  const at = src.search(/function\s+_rebuildPlanItemStagesFromArtifacts\s*\(\)/);
  const body = sliceFn(src, at);
  assert.ok(/item\.meta\.stageState/.test(body),
    '_rebuildPlanItemStagesFromArtifacts must read item.meta.stageState (the server-persisted shape).');
  assert.ok(/state\.planItemStages\s*=/.test(body),
    '_rebuildPlanItemStagesFromArtifacts must write to state.planItemStages.');
});

t('app.js: _onArtifactsCacheUpdated calls _rebuildPlanItemStagesFromArtifacts (on every artifact-cache mutation)', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/function\s+_onArtifactsCacheUpdated\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/_rebuildPlanItemStagesFromArtifacts\s*\(\s*\)/.test(body),
    '_onArtifactsCacheUpdated must call _rebuildPlanItemStagesFromArtifacts so the HUD reflects fresh stageState on every artifacts-init + state-update kind:artifact frame.');
});

// ── 5. Marker comments + module presence ──

t('a comment naming "fr-96" appears in stageState.js, attach.js, critique.js, app.js', () => {
  const ss = _read('server/src/stageState.js');
  const a = _read('server/src/attach.js');
  const c = _read('server/src/critique.js');
  const app = _read('web/public/app.js');
  assert.ok(/fr-96/.test(ss), 'stageState.js must carry a fr-96 marker.');
  assert.ok(/fr-96/.test(a), 'attach.js must carry a fr-96 marker.');
  assert.ok(/fr-96/.test(c), 'critique.js must carry a fr-96 marker.');
  assert.ok(/fr-96/.test(app), 'app.js must carry a fr-96 marker.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
