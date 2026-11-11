// bug-92: per-session "unanswered user question" tracker.
//
// A user's plain chat question to claude (non-slash, non-run-marker,
// non-mention, non-accept) is tracked so it is never forgotten when the
// turn fails or gets dropped while the agent is busy. The user chose
// "auto-track + auto-rerun": failed/unanswered questions are surfaced
// (state-update kind 'pending-questions') and the server re-dispatches
// them (bounded retries) after a failure.
//
// Data shape on the session record:
//
//   rec.pendingQuestions = [
//     { qid, text, user, ts, status: 'pending'|'answered'|'failed',
//       dispatchCount, answeredAt?, failedAt? }
//   ]
//
// Semantics (FIFO — claude answers questions in dispatch order):
//   * addQuestion  → a user question is about to be dispatched.
//   * markAnswered → a successful non-run turn arrived AND that turn
//     wasn't a plan-run; the earliest 'pending' entry counts as answered.
//   * markFailed   → a turn failed/aborted without answering; the
//     earliest 'pending' entry is flagged.
//   * requeue      → bump dispatchCount + flip back to 'pending' for a
//     bounded auto-rerun (cap below).
//
// Terminal 'answered' entries are kept for a bounded audit window then
// dropped so rec.pendingQuestions doesn't grow unbounded.
//
// This module is pure-functional state mutation — no I/O, no event
// emission, no Express. Callers persist (sessionsMod.saveStore) +
// broadcast.

const MAX_QUESTION_RETRIES = 2;    // per-question auto-rerun cap
const ANSWERED_KEEP = 20;          // bounded 'answered' audit window
const TERMINAL = new Set(['answered', 'failed']);

function _ensure(rec) {
  if (!Array.isArray(rec.pendingQuestions)) rec.pendingQuestions = [];
}

// Append a fresh pending question, or bump an identical one that is still
// pending (the user re-sent the same question — no duplicate row, just
// re-stamp ts so the "open" list reflects the latest ask).
function addQuestion(rec, text, user, qid) {
  _ensure(rec);
  if (!text) return null;
  const dup = rec.pendingQuestions.find((e) => e.status === 'pending' && e.text === text);
  if (dup) {
    dup.ts = new Date().toISOString();
    return dup;
  }
  const entry = {
    qid: qid || (Date.now() + '-' + (rec.pendingQuestions.length + 1)),
    text,
    user: user || 'unknown',
    ts: new Date().toISOString(),
    status: 'pending',
    dispatchCount: 1,
  };
  rec.pendingQuestions.push(entry);
  return entry;
}

// Mark the earliest 'pending' entry answered. Returns the entry or null.
function markAnswered(rec) {
  _ensure(rec);
  const idx = rec.pendingQuestions.findIndex((e) => e.status === 'pending');
  if (idx === -1) return null;
  const e = rec.pendingQuestions[idx];
  e.status = 'answered';
  e.answeredAt = new Date().toISOString();
  _trimAnswered(rec);
  return e;
}

// Mark the earliest 'pending' entry failed (didn't get answered). Returns
// the entry or null if nothing is pending.
function markFailed(rec) {
  _ensure(rec);
  const idx = rec.pendingQuestions.findIndex((e) => e.status === 'pending');
  if (idx === -1) return null;
  const e = rec.pendingQuestions[idx];
  e.status = 'failed';
  e.failedAt = new Date().toISOString();
  return e;
}

// Re-arm a failed/pending entry for another dispatch (bump dispatchCount,
// flip back to pending). Returns the entry or null if unknown qid.
function requeue(rec, qid) {
  _ensure(rec);
  const e = rec.pendingQuestions.find((x) => x.qid === qid);
  if (!e) return null;
  e.dispatchCount = (e.dispatchCount || 1) + 1;
  e.status = 'pending';
  return e;
}

// Remove a single question by qid ("单独清理"). Returns true if removed.
function removeQuestion(rec, qid) {
  _ensure(rec);
  const idx = rec.pendingQuestions.findIndex((e) => e.qid === qid);
  if (idx === -1) return false;
  rec.pendingQuestions.splice(idx, 1);
  return true;
}

// Drop every OPEN entry (pending + failed — i.e. the unanswered queue);
// answered history is kept (bounded audit window). Returns count removed.
// The "一键清空未回答" counterpart to the per-item clear.
function clearOpen(rec) {
  _ensure(rec);
  const before = rec.pendingQuestions.length;
  rec.pendingQuestions = rec.pendingQuestions.filter(
    (e) => e.status !== 'pending' && e.status !== 'failed');
  return before - rec.pendingQuestions.length;
}

// Does the entry have auto-rerun budget left?
function canRetry(e) {
  return !!e && (e.dispatchCount || 1) < MAX_QUESTION_RETRIES;
}

// Drop the oldest 'answered' entries past ANSWERED_KEEP.
function _trimAnswered(rec) {
  const answered = rec.pendingQuestions.filter((e) => e.status === 'answered');
  if (answered.length <= ANSWERED_KEEP) return;
  const excess = answered.length - ANSWERED_KEEP;
  let dropped = 0;
  rec.pendingQuestions = rec.pendingQuestions.filter((e) => {
    if (e.status === 'answered' && dropped < excess) { dropped++; return false; }
    return true;
  });
}

// Open (still-need-answering) entries: pending + failed. Failed ones are
// surfaced so a human can re-kick them (the auto-rerun covers fatal only).
function getOpen(rec) {
  _ensure(rec);
  return rec.pendingQuestions.filter((e) => e.status === 'pending' || e.status === 'failed');
}

// Compact state for the UI / broadcast / attach-ship.
function getState(rec) {
  _ensure(rec);
  const counts = { pending: 0, answered: 0, failed: 0 };
  for (const e of rec.pendingQuestions) {
    if (counts[e.status] !== undefined) counts[e.status]++;
  }
  return { list: rec.pendingQuestions.slice(), counts };
}

module.exports = {
  addQuestion,
  markAnswered,
  markFailed,
  requeue,
  removeQuestion,
  clearOpen,
  canRetry,
  getOpen,
  getState,
  MAX_QUESTION_RETRIES,
  TERMINAL,
};
