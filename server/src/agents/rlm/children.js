// agents/rlm/children.js — server side of rlm.spawn / rlm.collect
// (design §4.2). A spawned sub-agent is a REAL AgentSession ("shadow"
// child session) — same isolation as the n2 shadow lanes: its own SDK
// transcript, its own events journal, reaper-killable. Unlike
// prime-agent we don't fork an OS process: the AgentSession isolation
// already gives transcript/event/process-level reaping, so in-process
// spawn + the ledger satisfies "real sub-agent" semantics (handles,
// depth, collection, observable roster).
//
// Hard constraints enforced HERE (host side, not by prompt):
//   - name ≤ 64 chars (mirrors prime normalize_requested_rlm_...)
//   - depth: child sessions carry RLM_DEPTH=k, MAX=3; k >= MAX →
//     DepthLimitError — recursion depth is a runtime constraint.
//   - collect folds back ONLY the answer (last assistant_text /
//     turn_result summary), never the child's transcript.

'use strict';

const path = require('path');
const { spawnAgent } = require('../../agent-session');
const ledger = require('./ledger');
const bridge = require('./bridge');

const MAX_DEPTH = 3;
const MAX_NAME_LEN = 64;

class DepthLimitError extends Error {
  constructor(depth, max) {
    super(`RLM spawn depth limit reached (depth ${depth} >= max ${max}) — flatten the work instead of recursing`);
    this.name = 'DepthLimitError';
    this.depth = depth;
    this.max = max;
  }
}

class InvalidNameError extends Error {
  constructor(name) {
    super(`RLM sub-agent name must be 1-${MAX_NAME_LEN} chars (got ${String(name).length})`);
    this.name = 'InvalidNameError';
  }
}

// Child sessions spawned by this parent, in memory: childSessionId →
// { session, name, depth, startedAt, status, answer, terminalEv }.
// The ledger is the durable roster; this map is the live handle set.
const _children = new Map();
let _seq = 0;

// Normalize + validate a spawn request (host-side parameter validation,
// design §4.2 — "参数校验在宿主侧").
function normalizeSpawnArgs({ prompt, name, model, depth }) {
  const task = String(prompt || '').trim();
  if (!task) throw new Error('rlm.spawn: prompt must be non-empty');
  let nm = name == null ? null : String(name).trim();
  if (nm != null) {
    if (nm.length < 1 || nm.length > MAX_NAME_LEN) throw new InvalidNameError(nm);
  }
  return { task, name: nm, model: model || null, depth: Number(depth) || 0 };
}

// Spawn one sub-agent. Returns { rlmChildId, name, sessionDir }.
// `ui` (optional) is a { mainSession, mainSessionId } pair for bridging
// the child's events into the chat pane — UI ONLY, never the parent's
// LLM context (bridge.js contract).
function spawnChild({ parentSessionId, cwd, prompt, name, depth = 0, model = null, user = null, ui = null }) {
  const args = normalizeSpawnArgs({ prompt, name, model, depth });
  if (args.depth >= MAX_DEPTH) throw new DepthLimitError(args.depth, MAX_DEPTH);

  const childSessionId = `${parentSessionId}-rlm-c${++_seq}`;
  const runDir = path.join(cwd, '_myco_', 'rlm', 'children');
  const sessionDir = path.join(runDir, childSessionId);
  const eventsFile = path.join(sessionDir, 'events.jsonl');

  const { spawnRlmAgent } = require('./index');
  // Depth travels via the systemPrompt suffix: the child's own kernel
  // rlm.spawn host_request carries depth+1, and the runtime check above
  // rejects anything at the cap. A null systemPrompt would skip the
  // contract — never allow that for children.
  const depthNote =
    `\n\n## RLM identity\nYou are an RLM SUB-AGENT (depth ${args.depth + 1}, max ${MAX_DEPTH}).` +
    (args.depth + 1 >= MAX_DEPTH
      ? ' You are at the depth cap — your rlm.spawn calls will fail with DepthLimitError; do the work yourself.'
      : '');
  const { rlmPrompt } = require('./prompt');
  // FIX (2026-10-23 audit): the depth note used to be appended AFTER
  // spawnRlmAgent returned — but AgentSession reads opts.systemPrompt in
  // its constructor, so a post-spawn mutation (via the nonexistent
  // `_applySystemPromptSuffix`, which silently fell back to assigning
  // session.systemPrompt) never reached the first query(). Compose the
  // contract prompt + depth note HERE so spawnRlmAgent's own
  // `opts.systemPrompt || rlmPrompt()` branch carries both.
  const session = spawnRlmAgent(childSessionId, {
    cwd,
    user: user || null,
    eventsFile,
    // Background child: never hang on an unanswered permission menu.
    autonomousPermission: true,
    systemPrompt: rlmPrompt() + depthNote,
    modelOverride: args.model,
    // children host-request routing needs the spawn context:
    rlmSpawn: { parentSessionId, depth: args.depth + 1, maxDepth: MAX_DEPTH },
  });

  const row = {
    childSessionId,
    parentSessionId,
    name: args.name || childSessionId,
    depth: args.depth + 1,
    status: 'running',
    startedAt: Date.now(),
    answer: null,
    terminalEv: null,
    session,
  };
  _children.set(childSessionId, row);
  ledger.append(cwd, {
    kind: 'spawn',
    parentSessionId,
    childSessionId,
    name: row.name,
    depth: row.depth,
  });
  // stats (task req c): one recursive sub-agent trigger.
  try { require('./stats').recordSpawn(parentSessionId, row.name); } catch {}

  // UI bridge (chat pane only): if a main session was supplied, the
  // child's agent-events roll into its pane with an rlm badge so the
  // user can watch the sub-agent work.
  if (ui && ui.mainSession && ui.mainSessionId) {
    bridge.bridgeRlmLane(session, ui.mainSession, ui.mainSessionId, 'rlm-child');
  }

  // Track terminal + answer as events arrive.
  // FIX (2026-10-23 audit): agent-session _emit ships assistant_text as
  // { type: 'assistant_text', text } — the old handler read ev.content,
  // so row.answer stayed null and rlm.collect folded back NOTHING. And
  // turn_result carries { subtype, result, usage } (no `summary` field),
  // so the foldAnswer terminal fallback never fired either.
  const TERMINAL = new Set(['turn_result', 'iteration_aborted', 'fatal']);
  session.on('agent-event', (ev) => {
    if (!ev) return;
    // stats (task req c): child events are UI-ONLY traffic — they would
    // have been context in a non-RLM run. Counted as "would-be context"
    // so collect can compute what RLM saved.
    try {
      require('./stats').recordChildEventChars(parentSessionId,
        JSON.stringify(ev || {}).length);
    } catch {}
    if (TERMINAL.has(ev.type)) {
      row.terminalEv = ev;
      row.status = ev.type === 'turn_result' ? 'done' : 'error';
    }
    const txt = ev && ev.type === 'assistant_text' ? (ev.text != null ? ev.text : ev.content) : null;
    if (typeof txt === 'string' && txt.trim()) {
      row.answer = txt; // last assistant text = the answer candidate
    }
  });

  session.write(args.task); // kick off the child's turn
  return { rlmChildId: childSessionId, name: row.name, sessionDir, depth: row.depth };
}

// Fold one child's terminal answer. ONLY the answer (last assistant
// text, or the terminal event's result text) — never the transcript.
// FIX (2026-10-23 audit): the old fallback read terminalEv.summary,
// a field turn_result never carries ({ subtype, result, usage }).
// Fall back to the SDK result text (`result`), else the subtype.
function foldAnswer(row) {
  if (row.answer && row.answer.trim()) {
    const text = row.answer.trim();
    return { answerPreview: text.slice(0, 2000), answerChars: text.length };
  }
  const ev = row.terminalEv;
  if (ev) {
    const result = (ev && typeof ev.result === 'string') ? ev.result
      : (ev && ev.result && typeof ev.result.text === 'string') ? ev.result.text : null;
    if (result && result.trim()) {
      return { answerPreview: result.slice(0, 2000), answerChars: result.length };
    }
    if (ev.type !== 'turn_result' && ev.subtype) {
      return { answerPreview: `(child ended ${ev.type}: ${ev.subtype})`, answerChars: 0 };
    }
  }
  return { answerPreview: null, answerChars: 0 };
}

// Collect: wait for the listed children to reach a terminal state
// (poll, no sleep — sub-second tick under a cap), then fold answers.
// timeoutMs = 0 means wait indefinitely (kernel side already bounds it
// via its own host_request timeout).
function collectChildren(ids, { timeoutMs = 0, intervalMs = 200, capMs = 15 * 60 * 1000 } = {}) {
  const want = new Set((ids || []).map(String));
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const rows = [...want].map((id) => _children.get(id)).filter(Boolean);
      const settled = rows.every((r) => r.status === 'done' || r.status === 'error');
      const elapsed = Date.now() - start;
      if (settled || (timeoutMs > 0 && elapsed >= timeoutMs) || elapsed >= capMs) {
        const folded = rows.map((r) => ({
          rlmChildId: r.childSessionId,
          name: r.name,
          status: r.status,
          durationMs: Date.now() - r.startedAt,
          ...foldAnswer(r),
        }));
        // stats (task req c): the folded answers are the ONLY child bytes
        // that enter the parent's context — everything else stayed UI-only.
        if (rows.length) {
          try {
            const stats = require('./stats');
            stats.recordCollect(rows[0].parentSessionId,
              folded.reduce((n, f) => n + (f.answerChars || 0), 0));
          } catch {}
        }
        resolve(folded);
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// Live roster: ledger rows (durable) merged with in-memory live state.
function listChildren() {
  const out = [];
  for (const [, r] of _children) {
    out.push({
      rlmChildId: r.childSessionId,
      parentSessionId: r.parentSessionId,
      name: r.name,
      depth: r.depth,
      status: r.status,
      startedAt: r.startedAt,
    });
  }
  return out;
}

// Delete one child: kill the session + ledger delete(reason).
function deleteChild(childSessionId, cwd, reason = 'user') {
  const row = _children.get(childSessionId);
  if (row) {
    _children.delete(childSessionId);
    try { row.session.kill(); } catch {}
    if (row.status !== 'done' && row.status !== 'error') row.status = 'error';
    if (cwd) {
      ledger.append(cwd, { kind: 'delete', reason, childSessionId, parentSessionId: row.parentSessionId, name: row.name, depth: row.depth });
    }
    return true;
  }
  return false;
}

// Teardown every child of a parent (session close path — design §8
// risk 1). reason=parent_teardown in the ledger.
function teardownChildrenOf(parentSessionId, cwd) {
  for (const [id, r] of [..._children]) {
    if (r.parentSessionId === parentSessionId) deleteChild(id, cwd, 'parent_teardown');
  }
}

module.exports = {
  spawnChild,
  collectChildren,
  listChildren,
  deleteChild,
  teardownChildrenOf,
  foldAnswer,
  normalizeSpawnArgs,
  DepthLimitError,
  InvalidNameError,
  MAX_DEPTH,
  MAX_NAME_LEN,
};
