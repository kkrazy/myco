// team-split-view / refresh-history: agent-event pagination source.
// The attach WS frame ships only a 16 KB tail (sub-100ms first paint
// contract); this module is the durable "load older" backfill behind
// GET /sessions/:id/events — the Claude-Code-equivalent "render
// lazily from the full transcript" leg for a web client that can't
// hold the whole JSONL in memory.
//
// Source order per session:
//   1. live session.buffer (authoritative — includes lane events
//      compare-lanes bridged into it),
//   2. disk fallback: the last 5000 lines of <mycoDir>/events.jsonl
//      (same tail AgentSession._hydrateBufferFromDisk loads), so a
//      reaped / pre-boot / pre-deploy session still serves history.
//
// Windows are oldest→newest within the slice (chat-persistence
// contract §4) and carry { events, total, hasMore } — the same
// envelope shape as /chat/history so the client paginates both with
// one interaction.

'use strict';

const fs = require('fs');
const path = require('path');

// Keep in sync with AgentSession.MAX_EVENTS (agent-session.js). Read
// as a literal here so requiring agent-session (which spawns SDK
// machinery) stays out of this hot, test-imported module.
const MAX_EVENTS = 5000;

function agentEventsWindow(sessionId, { before, limit }, deps = {}) {
  const getSession = deps.getSession || (() => null);
  const getRecord = deps.getRecord || (() => null);
  const resolveMycoDir = deps.resolveMycoDir || (() => null);
  let events = [];
  const session = getSession(sessionId);
  if (session && Array.isArray(session.buffer) && session.buffer.length) {
    events = session.buffer.slice();
  } else {
    events = readEventsJsonlTail(sessionId, { getRecord, resolveMycoDir });
  }
  const withSeq = events.filter((e) => e && typeof e.seq === 'number');
  const total = withSeq.length;
  const pool = before != null ? withSeq.filter((e) => e.seq < before) : withSeq;
  const window = pool.slice(-limit);
  let hasMore = false;
  if (window.length) {
    const oldestSeq = window[0].seq;
    hasMore = pool.some((e) => e.seq < oldestSeq);
  }
  return { window, total, hasMore };
}

// Disk fallback for a reaped / pre-boot session. Malformed lines are
// skipped, not fatal — a truncated final line (container killed
// mid-append) must not cost the whole history.
function readEventsJsonlTail(sessionId, { getRecord, resolveMycoDir }) {
  try {
    const rec = getRecord(sessionId);
    if (!rec) return [];
    const mycoDir = resolveMycoDir(rec) || (rec.cwd ? path.join(rec.cwd, '_myco_') : null);
    if (!mycoDir) return [];
    const file = path.join(mycoDir, 'events.jsonl');
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const out = [];
    for (const line of lines.slice(-MAX_EVENTS)) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  } catch (err) {
    console.error(`[events-history] ${sessionId} jsonl tail read failed: ${err && err.message}`);
    return [];
  }
}

module.exports = { agentEventsWindow, readEventsJsonlTail, MAX_EVENTS };
