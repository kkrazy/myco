// fr-48: per-session plan-item run-queue.
//
// Data shape on the session record:
//
//   rec.runQueue = [
//     { itemId, type, status, addedAt, addedBy,
//       startedAt?, finishedAt? }
//   ]
//   rec.runQueuePaused = boolean
//
// status ∈ { pending, running, success, failed, cancelled }
//
// Lifecycle:
//   * addToQueue → pending entry appended (FIFO).
//   * caller (attach.js / queue routes) calls peekNextPending to find
//     the next dispatchable item; markRunning before dispatching;
//     markFinished after turn_result.
//   * markFinished(success=false) auto-pauses the queue so a stuck or
//     failed item doesn't cascade through every pending entry — the
//     user resumes via /qresume or POST /queue/resume after triaging.
//
// This module is pure-functional state mutation — no I/O, no event
// emission, no Express. Callers persist + broadcast.

// Terminal statuses — entries in these states are immutable history;
// the queue can be re-added (a re-run is a fresh entry) but the prior
// entry's record stays for audit.
const TERMINAL_STATUSES = new Set(['success', 'failed', 'cancelled']);

// fr-90 Phase 2: default parallel-dispatch cap. With this many slots
// open, the queue dispatches up to N concurrent entries. Each entry
// is expected to run in its own worktree (Phase 1) + the agent
// spawns Task-tool subagents with run_in_background:true (per
// CLAUDE.md etiquette) so the concurrent items don't block each
// other on the SDK's single conversation stream. Configurable per
// session via rec.runQueueMaxConcurrent — default 3 if unset.
const DEFAULT_MAX_CONCURRENT = 3;

function _ensureQueueFields(rec) {
  if (!Array.isArray(rec.runQueue)) rec.runQueue = [];
  if (typeof rec.runQueuePaused !== 'boolean') rec.runQueuePaused = false;
}

// fr-90 Phase 2: resolve the configured (or default) concurrency cap.
function maxConcurrent(rec) {
  const n = rec && Number.isInteger(rec.runQueueMaxConcurrent) ? rec.runQueueMaxConcurrent : DEFAULT_MAX_CONCURRENT;
  return Math.max(1, n);   // floor at 1 — cap=0 would deadlock the queue
}

// fr-90 Phase 2: how many entries are currently mid-dispatch.
function countRunning(rec) {
  _ensureQueueFields(rec);
  return rec.runQueue.reduce((n, e) => n + (e.status === 'running' ? 1 : 0), 0);
}

// fr-90 Phase 2: can we dispatch one more entry without violating
// the concurrency cap? Used by every "kick if idle" check to decide
// whether to advance the queue.
function canDispatchMore(rec) {
  _ensureQueueFields(rec);
  if (rec.runQueuePaused) return false;
  return countRunning(rec) < maxConcurrent(rec);
}

// Append a fresh pending entry. Throws on duplicate of a non-terminal
// entry (an itemId that's already pending or running can't be queued
// twice — would dispatch the same item back-to-back without progress).
function addToQueue(rec, itemId, type, addedBy) {
  _ensureQueueFields(rec);
  if (!itemId) throw new Error('itemId required');
  const dup = rec.runQueue.find((e) => e.itemId === itemId && !TERMINAL_STATUSES.has(e.status));
  if (dup) {
    throw new Error(`itemId ${itemId} already in queue (status=${dup.status})`);
  }
  const entry = {
    itemId,
    type: type || 'plan',
    status: 'pending',
    addedAt: new Date().toISOString(),
    addedBy: addedBy || 'unknown',
  };
  rec.runQueue.push(entry);
  return entry;
}

// Remove an entry by itemId. Default behavior refuses to remove a
// running entry (the SDK iteration may be in flight — the user
// should interrupt instead). Pass `{force:true}` to override — useful
// for stuck-running recovery when the SDK has actually been idle for
// a while but the queue state never got a terminal turn_result /
// iteration_aborted / fatal event to mark the entry done.
// Returns true on removal, false if itemId wasn't found.
function removeFromQueue(rec, itemId, opts = {}) {
  _ensureQueueFields(rec);
  const runningIdx = rec.runQueue.findIndex((e) => e.itemId === itemId && e.status === 'running');
  if (runningIdx !== -1 && !opts.force) {
    throw new Error(`itemId ${itemId} is running — cannot remove (interrupt the SDK iteration instead, or pass {force:true} for stuck-state recovery)`);
  }
  const idx = rec.runQueue.findIndex((e) => e.itemId === itemId);
  if (idx === -1) return false;
  rec.runQueue.splice(idx, 1);
  return true;
}

// Drop every PENDING entry (running + terminal stay). Returns the
// count dropped. Useful for a "stop everything" / "wipe queue" UX.
function clearQueue(rec) {
  _ensureQueueFields(rec);
  const before = rec.runQueue.length;
  rec.runQueue = rec.runQueue.filter((e) => e.status !== 'pending');
  return before - rec.runQueue.length;
}

// Find the next pending entry to dispatch. Returns null when:
//   - no pending entries
//   - queue is paused (caller must resume first)
// Does NOT mutate state — caller calls markRunning before dispatching.
function peekNextPending(rec) {
  _ensureQueueFields(rec);
  if (rec.runQueuePaused) return null;
  return rec.runQueue.find((e) => e.status === 'pending') || null;
}

// Mark a pending entry as running + stamp startedAt. Caller invokes
// this immediately before dispatching the [run:plan#<id>] marker via
// handleChatMessage, so the turn_result hook can match by id later.
function markRunning(rec, itemId) {
  _ensureQueueFields(rec);
  const entry = rec.runQueue.find((e) => e.itemId === itemId && e.status === 'pending');
  if (!entry) return false;
  entry.status = 'running';
  entry.startedAt = new Date().toISOString();
  return true;
}

// Mark a running entry as success or failed + stamp finishedAt.
// Failure auto-pauses the queue (peekNextPending returns null until
// resumed) so a stuck pattern doesn't cascade through every pending
// entry. Returns the updated entry, or null if no matching running
// entry exists.
function markFinished(rec, itemId, success) {
  _ensureQueueFields(rec);
  const entry = rec.runQueue.find((e) => e.itemId === itemId && e.status === 'running');
  if (!entry) return null;
  entry.status = success ? 'success' : 'failed';
  entry.finishedAt = new Date().toISOString();
  if (!success) rec.runQueuePaused = true;
  return entry;
}

// Force-pause the queue (no auto-advance until resumed). Idempotent.
function pauseQueue(rec) {
  _ensureQueueFields(rec);
  rec.runQueuePaused = true;
}

// Unpause. peekNextPending will surface the next pending entry on the
// next call. Idempotent.
function resumeQueue(rec) {
  _ensureQueueFields(rec);
  rec.runQueuePaused = false;
}

// Compact state summary for UI / status surfaces (/qstatus,
// state-update broadcasts, the chat-pane chip strip).
function getQueueState(rec) {
  _ensureQueueFields(rec);
  const counts = { pending: 0, running: 0, success: 0, failed: 0, cancelled: 0 };
  for (const e of rec.runQueue) {
    if (counts[e.status] !== undefined) counts[e.status]++;
  }
  return {
    entries: rec.runQueue.slice(),
    paused: rec.runQueuePaused,
    counts,
  };
}

module.exports = {
  addToQueue,
  removeFromQueue,
  clearQueue,
  peekNextPending,
  markRunning,
  markFinished,
  pauseQueue,
  resumeQueue,
  getQueueState,
  TERMINAL_STATUSES,
  // fr-90 Phase 2: parallel-dispatch helpers.
  DEFAULT_MAX_CONCURRENT,
  maxConcurrent,
  countRunning,
  canDispatchMore,
};
