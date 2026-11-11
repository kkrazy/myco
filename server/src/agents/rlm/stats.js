// agents/rlm/stats.js — RLM usage instrumentation (task req c, 2026-10-23).
//
// Tracks, per session, how much the two RLM core techniques are actually
// used and what they save in context:
//   - rlm_eval calls (REPL+variables kernel) + chars of code sent in and
//     result text folded back — the model-visible context traffic.
//   - rlm.spawn / rlm.collect calls (recursive sub-agents) + per collect,
//     the estimated context SAVED: a child's full transcript would have
//     entered the parent's window; only the folded answer does. Saved
//     chars = (bytes of child agent-events bridged to the UI only) −
//     (chars of the folded answer fed back to the parent).
//
// 2026-11-11 fixes ("RLM 很少被触发" report, part 3):
//   - READS normalize ids through _mainId: lane (`<main>-rlm`), child
//     (`<main>-rlm-cN`), compare-lane (`<main>-cmp-*`) and n2 worker
//     (`<main>-worker-A` / `<main>-cmp-n2-worker-B`) rows all roll up to
//     the MAIN session — pre-fix getStats/statsLine read the bare id, so
//     /rlm <task> lane usage (recorded under the shadow id) was INVISIBLE
//     in the /rlm status line.
//   - Rows PERSIST to _myco_/rlm/stats-<mainId>.json on dropSession +
//     every mutation, and reload on read — the reaper kill / container
//     restart that previously ZEROED the counters now just rehydrates.

'use strict';

const fs = require('fs');
const path = require('path');

const stats = new Map(); // mainId → row (rows are keyed by the NORMALIZED id)

// Stats dir resolution: the session workspace's _myco_/rlm. Tests point
// this at a tmp dir via __setStatsDirForTest.
let _statsDirOverride = null;
function _statsDir() {
  return _statsDirOverride || path.join(process.cwd(), '_myco_', 'rlm');
}

function _rowFile(mainId) {
  return path.join(_statsDir(), `stats-${mainId}.json`);
}

// Filesystem-safe session key (kernel ids use ':' for n2 workers).
function _safe(id) {
  return String(id).replace(/[^A-Za-z0-9._-]+/g, '_');
}

function _emptyRow() {
  return {
    evalCalls: 0,        // rlm_eval invocations (REPL+variables kernel)
    evalCodeChars: 0,    // chars of code the model sent to the kernel
    evalResultChars: 0,  // chars of results folded back into the model's context
    spawns: 0,           // rlm.spawn calls (recursive sub-agents)
    collects: 0,         // rlm.collect calls
    childEventsChars: 0, // chars of child agent-events (bridged to UI ONLY)
    answersChars: 0,     // chars of folded answers fed back to the parent
    evolutions: 0,       // Continual Harness: rlm.addPrompt additions
    lastAt: null,
  };
}

function _row(mainId) {
  let r = stats.get(mainId);
  if (!r) {
    r = _loadRowFromDisk(mainId) || _emptyRow();
    stats.set(mainId, r);
  }
  return r;
}

// Read a persisted row (test surface + _row hydration). Never throws.
function _loadRowFromDisk(mainId) {
  try {
    const raw = fs.readFileSync(_rowFile(mainId), 'utf8');
    const row = JSON.parse(raw);
    if (!row || typeof row !== 'object') return null;
    // Merge over an empty row so a partially-written file still yields a
    // well-shaped row.
    return Object.assign(_emptyRow(), row);
  } catch { return null; }
}

// Persist one row. Best-effort — stats are diagnostics, never fatal.
function _persistRow(mainId, row) {
  try {
    fs.mkdirSync(_statsDir(), { recursive: true });
    fs.writeFileSync(_rowFile(mainId), JSON.stringify(row));
  } catch {}
}

// ── hook sites ────────────────────────────────────────────────────────

// mcp.js rlm_eval: one kernel round-trip.
function recordEval(sessionId, codeChars, resultChars) {
  const id = _mainId(sessionId);
  const r = _row(id);
  r.evalCalls++;
  r.evalCodeChars += codeChars | 0;
  r.evalResultChars += resultChars | 0;
  r.lastAt = Date.now();
  _persistRow(id, r);
  _broadcast(sessionId);
  _log('eval', sessionId, `call #${r.evalCalls} code=${codeChars}ch result=${resultChars}ch`);
}

// children.js spawnChild: one recursive sub-agent spawn.
function recordSpawn(sessionId, name) {
  const id = _mainId(sessionId);
  const r = _row(id);
  r.spawns++;
  r.lastAt = Date.now();
  _persistRow(id, r);
  _broadcast(sessionId);
  _log('spawn', sessionId, `#${r.spawns} name=${name || '(unnamed)'}`);
}

// children.js answer tracker: every child agent-event is UI-ONLY traffic.
// Counted so "context saved" reflects what did NOT enter the parent.
function recordChildEventChars(sessionId, chars) {
  const r = _row(_mainId(sessionId));
  r.childEventsChars += chars | 0;
}

// children.js collectChildren: folded answers are the only child bytes
// that DO enter the parent's context.
function recordCollect(sessionId, answerChars) {
  const id = _mainId(sessionId);
  const r = _row(id);
  r.collects++;
  r.answersChars += answerChars | 0;
  r.lastAt = Date.now();
  _persistRow(id, r);
  _broadcast(sessionId);
  _log('collect', sessionId, `#${r.collects} answers=${answerChars}ch saved≈${savedChars(r)}ch`);
}

// host.js rlm.add_prompt: one Continual Harness evolution — the agent
// self-authored a durable prompt rule (harness.js store, composed back
// in on the next respawn). Counted so the UI's 进化 readout is live.
function recordEvolution(sessionId, textChars) {
  const id = _mainId(sessionId);
  const r = _row(id);
  r.evolutions++;
  r.lastAt = Date.now();
  _persistRow(id, r);
  _broadcast(sessionId);
  _log('evolve', sessionId, `#${r.evolutions} text=${textChars | 0}ch`);
}

// ── reads ─────────────────────────────────────────────────────────────

// Estimated context chars kept OUT of the parent's window by RLM:
// child transcript bytes that were bridged to the UI only, minus the
// folded-answer bytes that did enter. Floor at 0.
function savedChars(r) {
  if (!r) return 0;
  return Math.max(0, r.childEventsChars - r.answersChars);
}

// Normalize a stats-tracked id (lane `<main>-rlm`, child `<main>-rlm-cN`,
// compare lane `<main>-cmp-single|-n2|-team|-explore`, n2 worker
// `<main>-worker-A`, lane worker `<main>-cmp-n2-worker-B`) down to the
// MAIN session id. Rollup order matters: cmp-lane workers match BOTH the
// `-cmp-*` and `-worker-*` suffixes — the greedy alternation handles
// them in one pass. Unrelated ids pass through untouched.
function _mainId(sessionId) {
  return String(sessionId || '')
    .replace(/(-cmp-(single|n2|team|explore))?(-rlm(-c\d+)*)?(-worker-[A-Z]+)?(-path-\d+)?$/, '')
    // A child can itself spawn children (`…-rlm-c2-rlm-c5`): peel
    // REPEATED `-rlm(-cN)*` segments off the tail the single pass above
    // leaves behind when two spawn layers stack.
    .replace(/(-rlm(-c\d+)*)+$/, '');
}

// Public snapshot for one session — the shape the /rlm status reply and
// the rlm-stats state-update frame ship to the UI. Ids are NORMALIZED so
// lane/child/worker usage surfaces on the session the user attached to.
function getStats(sessionId) {
  const r = _row(_mainId(sessionId));
  return {
    evalCalls: r.evalCalls,
    evalCodeChars: r.evalCodeChars,
    evalResultChars: r.evalResultChars,
    evolved: r.evolutions,
    spawns: r.spawns,
    collects: r.collects,
    childEventsChars: r.childEventsChars,
    answersChars: r.answersChars,
    savedChars: savedChars(r),
    lastAt: r.lastAt,
  };
}

// Compact human-readable line for chat / tooltips. Normalized like
// getStats — the /rlm status line must see lane + child usage.
function statsLine(sessionId) {
  const s = getStats(sessionId);
  return `RLM 触发 ${s.evalCalls} 次内核调用 / ${s.spawns} 次子代理 / ${s.collects} 次回收` +
    ` / ${s.evolved} 次进化，节省上下文 ≈ ${(s.savedChars / 1024).toFixed(1)} KB`;
}

// Drop a session's row (spawnRlmAgent exit hook). The row is PERSISTED
// first — the reaper kill / restart must not zero the user's usage
// counters (the /rlm status line rehydrates from disk on next read).
function dropSession(sessionId) {
  const id = _mainId(sessionId);
  const r = stats.get(id);
  if (r) _persistRow(id, r);
  stats.delete(id);
}

// ── live UI broadcast ────────────────────────────────────────────────

// Broadcast kind:'rlm-stats' on the main session's attach-forwarded
// channel so every attached device updates the badge tooltip live.
// Called from the record* helpers; best-effort, never throws.
function _broadcast(sessionId) {
  try {
    const attachMod = require('../../attach');
    const mainId = _mainId(sessionId);
    const s = (typeof attachMod.getSession === 'function' && attachMod.getSession(mainId)) || null;
    if (s && typeof s.emit === 'function') {
      s.emit('state-update', { kind: 'rlm-stats', stats: getStats(sessionId) });
    }
  } catch {}
}

// ── logging ───────────────────────────────────────────────────────────

// Stable bracketed prefix (CLAUDE.md Diagnostics §3) so the diag loop /
// collect-logs.sh filters can pick RLM usage lines out of the log stream.
function _log(kind, sessionId, detail) {
  console.log(`[rlm-stats] ${kind} session=${sessionId} ${detail}`);
}

// Test surface: point the persistence dir at a tmp dir + read a
// persisted row back (regression: reaper kill must not zero usage).
function __setStatsDirForTest(dir) { _statsDirOverride = dir; }

module.exports = {
  recordEval, recordSpawn, recordChildEventChars, recordCollect, recordEvolution,
  getStats, statsLine, savedChars, dropSession,
  _mainId, _loadRowFromDisk, __setStatsDirForTest,
};
