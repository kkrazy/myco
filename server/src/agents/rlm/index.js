// agents/rlm — RLM (Recursive Language Model) hard implementation facade.
// (myco-rlm-design.md §3: this module replaces the old delm-10
// prompt-level `server/src/rlm-session.js` + `prompts-rlm.js`, which were
// migrated here and deleted — run_static_checks guards against their
// require-sites coming back.)
//
// Public surface (signature-compatible with the old rlm-session.js):
//   spawnRlmAgent(sessionId, opts)  — AgentSession with the RLM contract
//                                     prompt (prompt.js) + the rlm_eval
//                                     MCP tool wired to a per-session
//                                     kernel manager.
//   startRlmLane({...})             — one-shot background RLM lane,
//                                     bridged into the main chat pane.
//   onRlmLaneTerminal(lane, cb)     — terminal-event helper.
//   timestampedDir / ensureDir      — run-dir helpers.
//   TERMINAL                        — terminal agent-event types.
//
// Plus the hard-implementation extras:
//   rlmKernelManager(sessionId, opts) — per-session ReplKernelManager
//                                     (kernel/manager.js), created lazily
//                                     and torn down with the session.
//   rlmMcpServer(...)               — mcp.js MCP server exposing rlm_eval
//                                     to the SDK session.

'use strict';

const path = require('path');
const fs = require('fs');
const { spawnAgent } = require('../../agent-session');
const { rlmPrompt } = require('./prompt');
const mcp = require('./mcp');

// Per-session kernel managers (design §4.1: one kernel child process per
// RLM session). Keyed by sessionId; shutdown on session teardown.
const _kernelManagers = new Map();

// Live AgentSessions spawned via spawnRlmAgent, keyed by sessionId.
// children.js child sessions and team workers are NOT in attach's
// sessions map (they're never WS-attached directly), so the hostHandler
// must resolve them HERE — otherwise the recursion depth chain breaks
// (every spawn looks like depth 0) and MAX_DEPTH never triggers.
const _rlmSessions = new Map();

// RLM first-turn nudge (2026-11-11 "RLM 很少被触发" fix, part 4): a
// freshly-armed RLM session has new tools (mcp__rlm__rlm_eval) but the
// model routinely ignores them and answers from the transcript. One
// short opener turn forces the kernel state read and breaks the inertia.
// Exported so AgentSession.setRlmMode (hot arm) can write it without a
// circular import; spawnRlmAgent consumers that already dispatch their
// own opener (startRlmLane writes the task, children.js writes the task,
// TeamSession dispatches) do NOT use it — the task prompt is the opener.
const RLM_FIRST_TURN_NUDGE =
  'You are now running with the RLM kernel engine (persistent variables via rlm_eval + programmatic sub-agents via rlm.spawn/collect). ' +
  'Start now by calling rlm_eval to read the kernel `state` object (initialize state.task from our conversation so far if it is empty), ' +
  'then proceed with the current work using the kernel to park intermediate results. Reply briefly confirming state.task.';

function registerRlmSession(sessionId, session) { _rlmSessions.set(sessionId, session); }
function getRlmSession(sessionId) { return _rlmSessions.get(sessionId) || null; }
function _dropRlmSession(sessionId) { _rlmSessions.delete(sessionId); }

// Get (or lazily create) the kernel manager for a session. The manager is
// created WITHOUT spawning the child — the child spawns on first execute
// so a session that never calls rlm_eval pays nothing. The kernel's
// host_request channel (rlm.spawn / collect / … calls from inside cells)
// routes through host.js (design §4.2).
function rlmKernelManager(sessionId, opts = {}) {
  let m = _kernelManagers.get(sessionId);
  if (!m) {
    const ReplKernelManager = require('./kernel/manager').ReplKernelManager;
    const host = require('./host');
    const cwd = opts.cwd || process.cwd();
    // Optional SHARED Continual-Harness store key (e.g. the /run-explore
    // lane's 'explore-task-<hash>'). When set, rlm.add_prompt/list_prompts
    // (host.js) read+write THAT store instead of the per-session one, so
    // a whole team of workers — and every future run of the same task —
    // accumulates self-authored rules together. Absent = per-session key
    // (sessionId), the unchanged default.
    const harnessKey = opts.harnessKey || null;
    // hostHandler: kernel cell code called an rlm.* shim → host.js
    // router → children.js / chat pane. Depth derives from the session's
    // rlmSpawn context (children.js spawns with depth+1; design §4.2).
    const hostHandler = (data) => {
      let rec = null, mainSession = null;
      try {
        const sessionsMod = require('../../sessions');
        rec = typeof sessionsMod.getSessionRecord === 'function'
          ? sessionsMod.getSessionRecord(sessionId) : null;
      } catch {}
      try {
        const attachMod = require('../../attach');
        mainSession = typeof attachMod.getSession === 'function'
          ? attachMod.getSession(sessionId) : null;
      } catch {}
      // Children/n2 workers are not in attach's map — resolve them from
      // the RLM session registry (fix: depth chain must not break at the
      // first un-attached layer, or every spawn resets to depth 0 and
      // MAX_DEPTH can never trigger).
      if (!mainSession) mainSession = getRlmSession(sessionId);
      const depth = (mainSession && mainSession.rlmSpawn && mainSession.rlmSpawn.depth) || 0;
      return host.handleHostRequest(data, {
        parentSessionId: sessionId,
        cwd,
        user: (rec && rec.user) || null,
        depth,
        mainSession,
        harnessKey,
        // ui: bridge spawned child events into the main chat pane —
        // mainSession emits are the attach-forwarded channel. UI ONLY
        // (bridge.js contract), never the parent's LLM context.
        ui: mainSession ? { mainSession, mainSessionId: sessionId } : null,
      });
    };
    m = new ReplKernelManager(Object.assign({ sessionId, hostHandler }, opts));
    _kernelManagers.set(sessionId, m);
  }
  return m;
}

// Drop a session's kernel manager (flush + kill the child). Called from
// session teardown paths; safe to call repeatedly.
function shutdownRlmKernel(sessionId) {
  const m = _kernelManagers.get(sessionId);
  if (!m) return false;
  _kernelManagers.delete(sessionId);
  try { m.shutdown(); } catch {}
  return true;
}

// Spawn an AgentSession configured as an RLM session. Same signature
// as spawnAgent plus the RLM overlay; a null `prompt` skips the
// systemPrompt (used by tests).
function spawnRlmAgent(sessionId, opts = {}) {
  // Optional shared harness key (/run-explore): one store per TASK, not
  // per session — workers + future runs of the same task all read/write
  // the same self-authored rules. Null = per-session store (default).
  const harnessKey = opts.harnessKey || null;
  const manager = rlmKernelManager(sessionId, {
    cwd: opts.cwd || process.cwd(),
    harnessKey,
  });
  // Continual Harness (task req 2: agent self-improves by dynamically
  // adding prompt to itself). The harness store lives next to the kernel
  // run dirs; compose the agent's own accumulated rules into its prompt
  // on every (re)spawn so additions persist across restarts. With a
  // shared harnessKey the composed rules are the TASK's accumulated set.
  const harness = require('./harness');
  const harnessSection = opts.includeHarness === false
    ? '' : harness.composeHarnessSection(opts.cwd || process.cwd(), harnessKey || sessionId);
  const rlmOpts = Object.assign({}, opts, {
    systemPrompt: opts.systemPrompt === null
      ? null
      : (opts.systemPrompt || rlmPrompt()) + harnessSection,
    // Background RLM lanes must not hang forever on an unanswered
    // permission menu card (mirrors compare-lanes startSingleLane).
    autonomousPermission: opts.autonomousPermission !== undefined ? opts.autonomousPermission : true,
    // The rlm MCP server exposes the rlm_eval / rlm_snapshot / rlm_restore
    // tools the prompt teaches. Reuses the myco-mcp.js in-process pattern.
    mcpServers: Object.assign({}, opts.mcpServers, {
      rlm: mcp.createServer({ manager, sessionId }),
    }),
  });
  const session = spawnAgent(sessionId, rlmOpts);
  // RLM hot-toggle contract: a session BORN via spawnRlmAgent is already
  // armed — stamp _rlmApplied so a later setRlmMode(true) is a no-op
  // (never stack a second rlm MCP server / re-compose the prompt).
  session._rlmApplied = true;

  // Track the live session so the kernel hostHandler can resolve its
  // rlmSpawn depth even though child/lane sessions never enter attach's
  // sessions map (fix: recursion depth chain must not break at the
  // first un-attached layer).
  registerRlmSession(sessionId, session);
  // Lifecycle contract (kernel/manager.js): a killed session must never
  // leak its kernel child process. TeamSession.kill already calls
  // shutdownRlmKernel for its workers; this exit hook covers EVERY
  // spawnRlmAgent consumer — children.js sub-agents, /rlm lanes, and
  // single-agent RLM sessions.
  session.on('exit', () => {
    _dropRlmSession(sessionId);
    shutdownRlmKernel(sessionId);
    // stats (task req c): drop the per-session usage row so the map
    // can't grow unbounded across a long server lifetime.
    try { require('./stats').dropSession(sessionId); } catch {}
  });
  return session;
}

// Run ONE task through a background RLM lane bridged into the main
// session's chat pane (same bridge pattern as compare-lanes.js
// startSingleLane, with an `rlmLane` tag the frontend can badge).
// Design §3: the bridge lives in bridge.js — child-agent events feed
// the UI only, never the parent agent's LLM context.
function startRlmLane({ cwd, user, task, dir, mainSession, mainSessionId, laneTag = 'rlm' }) {
  const shadowId = `${mainSessionId}-rlm`;
  const eventsFile = path.join(dir, 'events.jsonl');
  const lane = spawnRlmAgent(shadowId, { cwd, user, eventsFile });
  lane.mode = 'rlm';
  const bridge = require('./bridge');
  bridge.bridgeRlmLane(lane, mainSession, mainSessionId, laneTag);
  lane.write(task); // kicks off _ensureIteration -> query()
  return { lane, id: shadowId, eventsFile, dir, startedAt: Date.now() };
}

function timestampedDir(cwd, tag) {
  const root = path.join(cwd, '_myco_', 'rlm');
  const run = `${new Date().toISOString().replace(/[:.]/g, '-')}-${tag}`;
  return path.join(root, run);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Terminal agent-event types for one RLM lane run (mirrors
// compare-lanes TERMINAL — used by the /rlm handler to notice the
// lane finished and tell the user).
const TERMINAL = new Set(['turn_result', 'iteration_aborted', 'fatal']);

function onRlmLaneTerminal(lane, cb) {
  lane.on('agent-event', (ev) => {
    if (ev && TERMINAL.has(ev.type)) cb(ev);
  });
}

module.exports = {
  spawnRlmAgent,
  startRlmLane,
  onRlmLaneTerminal,
  timestampedDir,
  ensureDir,
  TERMINAL,
  rlmKernelManager,
  shutdownRlmKernel,
  RLM_FIRST_TURN_NUDGE,
};
