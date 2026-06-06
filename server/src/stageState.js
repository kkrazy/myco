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
//   ✓ Accept (verify-stage final)  → CLEARED (run done)
//   ✗ Discard                      → CLEARED (run abandoned)
//
// The CLEARED terminal state is represented by deleting
// item.meta.stageState (so it's distinguishable from a fresh item
// that's never been dispatched — both have undefined stageState).
//
// Item-complete = stageState was cleared on Accept-verify. The plan
// item's runs[] entries record the per-stage outcomes; stageState
// itself doesn't track "finished" — it tracks the current in-flight
// position. fr-96 v2 / td-34 may add a `finishedAt` if needed.
//
// All transitions are PURE functions on item.meta.stageState. The
// CALLER is responsible for persisting (sessionsMod.saveStore()) +
// broadcasting (session.emit('state-update', {kind:'plan-item-stage'})).
// This keeps the module testable without IO mocking.

const STAGES = ['analyze', 'code', 'verify'];
const STATUSES = ['in_progress', 'awaiting_verdict', 'awaiting_accept'];
// History cap — bounded audit trail so plan.json doesn't grow
// unbounded across many stage transitions on a single item.
const HISTORY_CAP = 20;

// Stage progression. Used by the Accept Stage button handler.
// Returns null for 'verify' — the next step after verify-accept is
// "run done" (handled by clearStageState + /run/done route).
function nextStage(stage) {
  const idx = STAGES.indexOf(stage);
  if (idx < 0 || idx === STAGES.length - 1) return null;
  return STAGES[idx + 1];
}

// Initialize stageState on a freshly-dispatched item. Called from
// attach.js's [run:plan#X] handler. If the item ALREADY has a
// stageState (e.g. user re-dispatched the same item), this resets it
// — the new dispatch starts a fresh 3-stage cycle.
function initStageState(item) {
  if (!item) return null;
  if (!item.meta) item.meta = {};
  const now = new Date().toISOString();
  item.meta.stageState = {
    stage: 'analyze',
    status: 'in_progress',
    updatedAt: now,
    history: [{ stage: 'analyze', status: 'in_progress', ts: now }],
  };
  return item.meta.stageState;
}

// Apply a transition. Validates stage + status against the allowed
// vocabularies, appends to history (capped at HISTORY_CAP), updates
// updatedAt. Returns the updated stageState, or null if the item
// has no stageState (transition can't apply — caller decides what
// to do, typically no-op).
//
// Defensive: if the requested {stage,status} matches the current
// state, no-op + return current (no spurious updatedAt churn or
// double-history entry).
function applyTransition(item, stage, status) {
  if (!item || !item.meta || !item.meta.stageState) return null;
  if (!STAGES.includes(stage)) {
    throw new Error(`[fr-96] invalid stage: ${stage}`);
  }
  if (!STATUSES.includes(status)) {
    throw new Error(`[fr-96] invalid status: ${status}`);
  }
  const cur = item.meta.stageState;
  if (cur.stage === stage && cur.status === status) {
    return cur;
  }
  const now = new Date().toISOString();
  cur.stage = stage;
  cur.status = status;
  cur.updatedAt = now;
  if (!Array.isArray(cur.history)) cur.history = [];
  cur.history.push({ stage, status, ts: now });
  if (cur.history.length > HISTORY_CAP) {
    cur.history = cur.history.slice(-HISTORY_CAP);
  }
  return cur;
}

// Clear stageState. Called from clearActiveRunItem on Accept-verify
// (run done) and Discard (run abandoned). The deletion is what
// signals "this item is no longer in a multi-stage run" — fresh
// items (never dispatched) and finished items both have undefined
// stageState; only mid-run items have a populated stageState.
function clearStageState(item) {
  if (!item || !item.meta || !item.meta.stageState) return false;
  delete item.meta.stageState;
  return true;
}

// Read accessor. Returns the current stageState or null. Trivial but
// exported so callers don't reach into item.meta directly (low
// coupling per CLAUDE.md §1).
function getStageState(item) {
  return (item && item.meta && item.meta.stageState) || null;
}

// Broadcast payload shape. Strips history[] (clients don't need the
// audit trail for HUD render). Used by attach.js when emitting
// state-update kind:'plan-item-stage'.
function toBroadcastPayload(itemId, stageState) {
  if (!stageState) return { itemId, stageState: null };
  return {
    itemId,
    stageState: {
      stage: stageState.stage,
      status: stageState.status,
      updatedAt: stageState.updatedAt,
    },
  };
}

// fr-98: per-plan-item verdict persistence.
//
// The verdict panel ("Accept Stage / Fix Stage / Ask Critic" pane that
// pops up after [stage: X done]) used to be a fire-once broadcast — only
// devices attached at broadcast time saw it. Switching devices or
// restarting the container produced an item whose stageState was
// still awaiting_accept but with no rendered pane, leaving the run
// paused with no way to resolve it.
//
// Fix: persist the broadcast payload at item.meta.lastCriticReview in
// plan.json — the same per-item slot fr-96 used for stageState. The
// _sendAttachSnapshot path in attach.js replays it on every new attach
// for any item whose stageState.status is in awaiting_verdict /
// awaiting_accept. Resolution paths (verify-accept, discard, accept-
// stage, fix-stage) call clearLastCriticReview to ensure resolved
// verdicts don't replay on next attach.
//
// Payload shape mirrors the live state-update broadcast at
// critique.js:451 — itemId, hasDisagreement, isError, isIntermediate,
// isRetry, stage, critique, diff, criticName, criticId, specialties.
// We add broadcastAt as the persistence timestamp so the client can
// flag a replay vs. a live broadcast if useful.

// Stamp the current verdict on the item. Overwrites any previous
// lastCriticReview (each stage's broadcast supersedes the prior one —
// there's at most one pending verdict per item at a time, gated by
// stageState).
function setLastCriticReview(item, payload) {
  if (!item) return null;
  if (!item.meta) item.meta = {};
  item.meta.lastCriticReview = {
    ...payload,
    broadcastAt: new Date().toISOString(),
  };
  return item.meta.lastCriticReview;
}

// Clear the persisted verdict. Called from every resolve path
// (clearActiveRunItem on verify-accept/discard, resolveCritique on
// accept-stage/fix-stage). Returns true iff anything was cleared, so
// the caller can decide whether to saveStore() — matches
// clearStageState's idempotent contract.
function clearLastCriticReview(item) {
  if (!item || !item.meta || !item.meta.lastCriticReview) return false;
  delete item.meta.lastCriticReview;
  return true;
}

// Read accessor. Returns the persisted verdict payload or null. Used by
// _sendAttachSnapshot to decide whether to replay on a fresh attach.
function getLastCriticReview(item) {
  return (item && item.meta && item.meta.lastCriticReview) || null;
}

module.exports = {
  STAGES,
  STATUSES,
  HISTORY_CAP,
  nextStage,
  initStageState,
  applyTransition,
  clearStageState,
  getStageState,
  toBroadcastPayload,
  // fr-98: verdict persistence parity with stageState.
  setLastCriticReview,
  clearLastCriticReview,
  getLastCriticReview,
};
