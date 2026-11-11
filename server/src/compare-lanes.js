// Compare / dual-agent lanes for the Delm agent-n2 feature.
//
// A plain myco session owns exactly ONE live session object (single
// AgentSession or TeamSession). To run a second, independent execution
// stream against the SAME chat pane without mutating the main session's
// mode, we spin up "shadow" executors under their own shadow session ids
// and bridge their agent-events back into the main session's WS pipeline
// (re-stamped with the main session's sequential `seq`, plus a
// `compareLane` tag). The frontend uses `compareLane` + `worker` to split
// the timeline into lanes / tag worker-A / worker-B.
//
// Shadow ids are never written into the session store, so they don't show
// up in `listSessions` and are not auto-respawnd by ensureLiveSession.
// Shadow AgentSessions write their journals to an isolated
// `<cwd>/_myco_/compare/<run>/` dir so they never pollute the main
// session's `events.jsonl`.

const path = require('path');
const fs = require('fs');
const { TeamSession } = require('./team-session');
const { spawnAgent } = require('./agent-session');
const sessionsMod = require('./sessions');

const SINGLE = 'single';
const N2 = 'n2';

// ---- multi-lane registry (2026-10-22) ----
//
// User report: 同一个 session 起多个 /run-n2 时所有 run 复用同一条
// lane 记录 (`mainSession._teamLane = …` overwrote the previous lane) —
// 看板/列被后启动的 run 抢占, 前一个 run 的 board 记录直接丢失。
// The registry keeps EVERY lane (live + ended) keyed by a stable
// `laneId` so the client can show one 看板 per run (picker / sequential
// list) instead of one shared board. `mainSession._teamLane` is kept as
// a BACK-COMPAT alias for the NEWEST lane record (stopN2Lane + the
// delm-10 busy-gate + old tests read it); the keyed set lives in
// `mainSession._teamLanes` (a plain object so test stubs + JSON-ish
// inspection keep working, insertion-ordered = 启动顺序).
const LANE_PREFIX = 'n2';

// Create + register a lane record. Returns the record; also refreshes
// the `_teamLane` alias to the newest lane.
function _registerLane(mainSession, rec) {
  if (!mainSession) return rec;
  if (!mainSession._teamLanes || typeof mainSession._teamLanes !== 'object') {
    mainSession._teamLanes = {};
  }
  mainSession._teamLanes[rec.laneId] = rec;
  mainSession._teamLane = rec; // newest lane wins the legacy alias
  return rec;
}

// Every registered lane record, in START order (oldest first) — the
// client's sequential picker + the attach handshake both consume this.
function listLanes(mainSession) {
  if (!mainSession || !mainSession._teamLanes) return [];
  return Object.values(mainSession._teamLanes);
}

// Stable lane id: `n2-<ISO ts>` — unique per start (startN2Lane is
// called once per /run-n2, and the ISO string also matches the
// timestamped journal dir so a lane is traceable to its artifacts).
let _laneSeq = 0;
function _newLaneId(tag) {
  _laneSeq += 1;
  return `${LANE_PREFIX}-${new Date().toISOString().replace(/[:.]/g, '-')}-${_laneSeq}`;
}

// A small emitter-like bridge: forward one stream's agent-events into the
// main session (which drives the attached WS), tagging each with the lane
// and re-stamping a main-session sequential seq so the pane's
// cross-device resort stays correct. `worker` (set by TeamSession._relay)
// is preserved so the frontend can badge worker-A / worker-B.
// `meta` (laneId/task) is stamped onto every bridged event so the 单列
// stream can label which run a card belongs to, and the 多列 view can
// route an event to its own lane's columns.
function _bridge(executor, mainSession, mainSessionId, lane, meta) {
  // Stray-print fix (user report 2026-10-29/30): a team lane's terminal
  // signal (team-complete / team-failed, or a genuinely-finished worker's
  // turn_result/aborted/fatal) can fire while the workers' TRAILING tool
  // events are still draining — an autonomous worker's final Bash(git
  // push) tool_use/tool_result arrive after the "✅ /run-n2 完成" line
  // and print into the timeline as a sudden, unexpected worker-A tool
  // print ("A/B 都完成了，突然出来一个 A 的工具打印"). Gate the bridge:
  // once the lane's terminal fires, worker agent-events are no longer
  // live-emitted, buffered or persisted into the MAIN session surface.
  // The worker's own journal (events-worker-*.jsonl under the run dir)
  // keeps the full forensic record, and the lane's team-lane-end state
  // transition still ships, so nothing durable is lost.
  // Scope: /run-n2 + team lanes (the shadow-lane split view). A /compare
  // overlay lane (lane truthy) renders into its own dual-column overlay
  // whose lifecycle is owned by the compare report, and its single-lane
  // sibling is a plain AgentSession — neither hits this gate.
  let bridgeEnded = false;
  const isTeamLane = !lane || executor instanceof TeamSession;
  if (isTeamLane) {
    onLaneTerminal(executor, true, () => { bridgeEnded = true; });
  }
  executor.on('agent-event', (ev) => {
    if (bridgeEnded && ev && ev.worker) return;
    if (!ev) return;
    const out = Object.assign({}, ev, { compareLane: lane });
    if (meta && meta.laneId) {
      out.laneId = meta.laneId;
      // task label trimmed client-side; keep the full task for tooltips
      if (meta.task) out.laneTask = meta.task;
    }
    // /run-n2 passes a falsy lane so its events render in the MAIN
    // timeline with worker badges only, not the compare overlay.
    if (!lane) delete out.compareLane;
    // Re-stamp with the MAIN session's monotonic seq (single ordering key
    // across both lanes + the main stream). Drop the worker-local seq/team
    // counter — the frontend sorts by `seq` only.
    delete out.seq;
    delete out.workerSeq;
    out.seq = sessionsMod.allocSeq(mainSessionId);
    // team-split-view reattach (frozen-view fix): the SAME re-stamped
    // copy must feed the main session's replay surface — buffer.push
    // (in-memory ring, cap 5000 like AgentSession._emit's MAX_EVENTS)
    // AND _persistEventToDisk (main events.jsonl, hydrates back into
    // the buffer on server restart). Pre-fix the bridge had TWO
    // 'agent-event' listeners: this one re-stamped + live-emitted, a
    // second one pushed the RAW ev (worker-local seq) into the buffer
    // without persisting. Consequences: ?afterSeq=N catch-up filtered
    // the buffered copies out (their seq was below N), initial replay
    // interleaved small worker seqs into the main ordering, and a
    // server restart lost the mirror entirely (nothing on disk).
    // Scope: only /run-n2 (lane falsy) worker-tagged events — the
    // split-view record the user wants preserved. /compare overlay
    // lanes (lane truthy) own their own events, and lane-level team
    // signals (team-complete etc.) are state, not pane content.
    if (!lane && ev.worker && Array.isArray(mainSession.buffer)) {
      mainSession.buffer.push(out);
      if (mainSession.buffer.length > 5000) mainSession.buffer.splice(0, mainSession.buffer.length - 5000);
      if (typeof mainSession._persistEventToDisk === 'function') mainSession._persistEventToDisk(out);
    }
    mainSession.emit('agent-event', out);
  });
  // Menu events (permission routing) must reach the main pane intact.
  executor.on('menu', (m) => mainSession.emit('menu', m));
  // team-split-view (shadow-lane wiring): a TeamSession lane's
  // state-updates (board snapshots + worker-tagged tool-progress) must
  // reach the main pane too, or the split view's middle column + column
  // headers stay frozen while the lane runs. The main session is a plain
  // AgentSession — re-emit its 'state-update' so attach.js's existing
  // onStateUpdate forwarder ships the frame. Tag board frames with
  // teamLane so the client can scope the (ephemeral) lane board apart
  // from a real agent-n2 session board if both ever coexist.
  if (executor && typeof executor.boardSnapshot === 'function') {
    executor.on('state-update', (p) => {
      if (!p) return;
      const out = Object.assign({}, p, { teamLane: true });
      // multi-lane: tag board frames with their lane so the client can
      // keep one 看板 per run instead of the last-started lane clobbering
      // the shared board.
      if (meta && meta.laneId) out.laneId = meta.laneId;
      mainSession.emit('state-update', out);
    });
  }
  return executor;
}

function timestampedDir(cwd, tag) {
  const root = path.join(cwd, '_myco_', 'compare');
  const run = `${new Date().toISOString().replace(/[:.]/g, '-')}-${tag}`;
  return path.join(root, run);
}

// Single-agent shadow lane: an isolated AgentSession that writes the SAME
// task via `write()`. Produces its own events-*.jsonl under `dir`.
//
// `laneTag` defaults to SINGLE but /compare now passes null so its single-
// lane events render in the MAIN timeline (worker badges, no dual-column
// overlay) — the "no compare panel" behaviour.
function startSingleLane({ cwd, user, task, dir, mainSession, mainSessionId, laneTag = SINGLE }) {
  const shadowId = `${mainSessionId}-cmp-single`;
  const eventsFile = path.join(dir, 'events.jsonl');
  // autonomousPermission: the /compare single lane is a background shadow — it
  // must not hang on an unanswered chat-pane permission prompt either. See
  // AgentSession._preToolUseHook.
  const lane = spawnAgent(shadowId, { cwd, user, eventsFile, autonomousPermission: true });
  const bridged = _bridge(lane, mainSession, mainSessionId, laneTag);
  lane.write(task); // kicks off _ensureIteration -> query()
  return { lane, id: shadowId, eventsFile, dir, startedAt: Date.now() };
}

// Dual-agent (agent-n2) shadow lane: an isolated TeamSession. dispatchTask
// fans the task out to worker-A + worker-B (shared in-memory DelmBoard).
// Worker events carry `worker` from TeamSession._relay.
function startN2Lane({ cwd, user, task, dir, mainSession, mainSessionId, laneTag = N2, rlm }) {
  const shadowId = `${mainSessionId}-cmp-n2`;
  const laneId = _newLaneId('n2');
  const laneMeta = { laneId, task };
  const lane = new TeamSession(shadowId, {
    cwd,
    user,
    task,
    eventsDir: dir,
    // §5.1: a lane fired while the session is in RLM mode runs its
    // workers with the RLM addendum (lane reads rec.rlm per run).
    rlm: rlm === true,
  });
  // laneTag controls whether bridged events carry `compareLane`: N2 for
  // /compare (dual-column overlay), null for /run-n2 (main timeline with
  // worker badges only).
  const bridged = _bridge(lane, mainSession, mainSessionId, laneTag, laneMeta);
  // team-split-view (shadow-lane wiring): announce the lane to the client
  // with the SAME frame shape attach.js ships for a real agent-n2 session,
  // so _handleTeamInfoFrame enters split mode and seeds the board pane
  // with one code path. teamLane:true lets the client distinguish the
  // ephemeral lane (single run, ends with the lane) from a persistent
  // agent-n2 session. laneId + task let the client keep THIS run's 看板
  // separate from other concurrently-running lanes.
  mainSession.emit('state-update', {
    kind: 'team-info',
    mode: 'agent-n2',
    teamLane: true,
    laneId,
    task: String(task || ''),
    roster: lane.roster,
    board: lane.boardSnapshot(),
  });
  // team-split-view reattach: remember the lane on the main session so a
  // LATER attach (page refresh, session re-switch, second device) can
  // re-announce it before shipping agent-replay — the live emit above
  // only reaches clients attached at that instant. `ended` flips on
  // terminal so the reattach path announces a FINISHED lane as
  // team-lane-end instead (covers "lane finished while the tab was
  // disconnected"). Guarded because some callers hand us a bare
  // EventEmitter (tests) without own-property slots.
  // multi-lane: the record is keyed in `_teamLanes` (every lane kept,
  // start order) and `_teamLane` stays as the newest-lane alias.
  const laneRec = { lane, laneId, task: String(task || ''), ended: false, roster: lane.roster, startedAt: Date.now() };
  _registerLane(mainSession, laneRec);
  // On lane terminal, tell the client to retire THIS lane's split view —
  // a NEW /run-n2 (or a real team session attach) opens its own board
  // instead of stacking runs on the same one.
  onLaneTerminal(lane, true, () => {
    laneRec.ended = true;
    mainSession.emit('state-update', { kind: 'team-lane-end', teamLane: true, laneId, task: laneRec.task });
  });
  lane.dispatchTask(task);
  return { lane, id: shadowId, laneId, boardFile: path.join(dir, 'board.jsonl'), dir, startedAt: laneRec.startedAt };
}

// Multi-expert team (专家团) shadow lane: an isolated TeamSession with an
// ARBITRARY roster (worker-A..worker-N) where each worker's role is defined
// by its skills (chosen from the skill market) instead of STARTUP_A/B.
// Reuses the SAME bridge / split-view wiring as startN2Lane. `roster` +
// `expertSkills` (actor -> [{name, description}]) are resolved by the
// caller (slashcmds handleRunExperts) from the session's saved experts.
function startTeamLane({ cwd, user, task, dir, mainSession, mainSessionId, roster, expertSkills, rlm }) {
  const shadowId = `${mainSessionId}-cmp-team`;
  const laneId = _newLaneId('team');
  const laneMeta = { laneId, task };
  const lane = new TeamSession(shadowId, {
    cwd,
    user,
    task,
    eventsDir: dir,
    roster,
    expertSkills,
    rlm: rlm === true,
  });
  // laneTag null — events render in the MAIN timeline with worker badges,
  // same as /run-n2.
  _bridge(lane, mainSession, mainSessionId, null, laneMeta);
  mainSession.emit('state-update', {
    kind: 'team-info',
    mode: 'agent-n2',
    teamLane: true,
    laneId,
    task: String(task || ''),
    roster: lane.roster,
    board: lane.boardSnapshot(),
  });
  const laneRec = { lane, laneId, task: String(task || ''), ended: false, roster: lane.roster, startedAt: Date.now() };
  _registerLane(mainSession, laneRec);
  onLaneTerminal(lane, true, () => {
    laneRec.ended = true;
    mainSession.emit('state-update', { kind: 'team-lane-end', teamLane: true, laneId, task: laneRec.task });
  });
  lane.dispatchTask(task);
  return { lane, id: shadowId, laneId, boardFile: path.join(dir, 'board.jsonl'), dir, startedAt: laneRec.startedAt };
}

// ---- Stop-lane (Stop button / esc against a running lane) ----
//
// The Stop button's interrupt frame routes to the MAIN session's
// session.interrupt(), but a /run-n2 lane runs in a SHADOW TeamSession
// the main session never iterates — so pre-fix, Stop could never reach
// the lane's workers (delm-10's busy gate dropped the frame outright
// because the main session was idle). This helper is the bridge: given
// the main session it aborts the LIVE lane's workers and retires the
// split view, whether or not the main session itself is iterating.
//
// Ordering contract for "multiple things running at once" on one session:
//   1. The lane's workers stop FIRST, newest-spawned worker first
//      (reverse roster order) — the lane is the user-visible foreground
//      activity (split view) and must visibly stop before anything else.
//   2. The MAIN session's own in-flight iteration (if any) is then
//      interrupted by the caller.
//   3. The lane's own terminal flow (onLaneTerminal fires on each
//      worker's iteration_aborted) flips _teamLane.ended and ships
//      team-lane-end, so the split view retires through the SAME path
//      a natural finish uses — no divergent teardown state machine.
//
// Returns true when a live lane was found and stopped, false when
// there was nothing to stop (caller skips the lane ack note).
// multi-lane (2026-10-22): with several concurrent /run-n2 runs on one
// session, Stop stops EVERY live lane — newest-started lane first, so
// the user-visible foreground run stops before older background runs,
// mirroring the per-lane "newest worker first" rule. Each stopped lane
// retires its own split view via a laneId-tagged team-lane-end frame.
function stopN2Lane(mainSession) {
  if (!mainSession) return false;
  // multi-lane registry first; fall back to the legacy `_teamLane` alias
  // so a session stubbed with the old single-lane shape (tests, older
  // callers) still stops. The alias holds the NEWEST lane, and
  // listLanes is authoritative once _registerLane ran.
  let lanes = listLanes(mainSession).filter((r) => r && r.lane && !r.ended);
  if (!lanes.length && mainSession._teamLane && !mainSession._teamLane.ended) {
    lanes = [mainSession._teamLane];
  }
  if (!lanes.length) return false;
  for (const laneRec of lanes.slice().reverse()) {
    const lane = laneRec.lane;
    // Reverse roster order — newest-spawned worker (worker-B) stops
    // first, mirroring "stop the most recent work first" so a resumed
    // run always has the senior worker's state to fall back on.
    const roster = Array.isArray(lane.roster) ? lane.roster.slice().reverse() : [];
    let stoppedAny = false;
    for (const actor of roster) {
      try {
        const w = lane.workers && lane.workers[actor];
        if (w && typeof w.interrupt === 'function' && w.alive) {
          w.interrupt();
          stoppedAny = true;
        }
      } catch {}
    }
    // Belt-and-braces: if no worker was interruptible (already drained,
    // stubbed in tests), still mark the lane ended + retire the split
    // view so Stop never leaves a zombie lane in the HUD. The
    // onLaneTerminal callback usually flips `ended` itself on the real
    // interrupt path; the direct set covers stubbed lanes whose terminal
    // never fires.
    if (!stoppedAny) {
      laneRec.ended = true;
      try { mainSession.emit('state-update', { kind: 'team-lane-end', teamLane: true, laneId: laneRec.laneId, task: laneRec.task }); } catch {}
    }
  }
  return true;
}

// ---- End-of-run bookkeeping ----

const TERMINAL = new Set(['turn_result', 'iteration_aborted', 'fatal']);
const TEAM_TERMINAL = new Set(['team-complete', 'team-failed']);

// worker-level terminal event counts for BOTH single and team lanes — a
// team's worker produces such events via TeamSession._relay. A team
// worker's turn_result ONLY ends the lane when the worker's SDK session is
// also dead (AgentSession.turn_result/iteration_aborted/kill()) — a mid-run
// per-turn turn_result is NORMAL multi-iteration traffic (a team dispatches
// follow-up writes: stall nudges, idle kicks, /run-n2 chat follow-ups on
// worker-A), and firing cb there completes the lane before the work is
// done (user report: "有时候双agent都还没完成任务，就弹出 ✅ /run-n2 完成").
// Team lanes therefore ALSO listen for the team-level team-complete /
// team-failed signals — the authoritative drain signals — and a
// worker-level terminal only fires cb when the worker is genuinely gone.
function onLaneTerminal(lane, isTeam, cb) {
  // A worker's terminal event + "is the worker really finished?" probe.
  // Default: finished (back-compat for plain single-lane EventEmitters /
  // AgentSession lanes without isBusy). A live TeamSession passes the
  // worker's own AgentSession, so we probe IT, not the team.
  const workerFinished = (ev) => {
    const w = ev && ev.worker && lane.workers && lane.workers[ev.worker];
    return !w || typeof w.isBusy !== 'function' || !w.isBusy();
  };
  // Premature-completion guard (bug 2026-11-06, /run-n2 user report
  // "还没结束，但 n2 识别任务状态结束了"): a worker-level TERMINAL
  // (turn_result / iteration_aborted(kill_mid_stream) / fatal) used to end
  // the lane as soon as THAT worker looked done — but a single worker's
  // death (reaper kill, crash, gateway fatal) must NOT end the lane while
  // a SIBLING is still mid-iteration. The probe now requires the WHOLE
  // roster to be quiet: the event's own worker done AND every other
  // worker not busy. A genuinely-finished team still completes normally —
  // the last worker to drain fires the terminal with all peers idle.
  const wholeTeamQuiet = (ev) => {
    if (!lane.workers || !lane.roster) return true; // plain lane — no siblings
    return lane.roster.every((a) => {
      const w = lane.workers[a];
      return !w || typeof w.isBusy !== 'function' || !w.isBusy() || !w.alive;
    });
  };
  const check = (ev) => {
    if (!ev || !TERMINAL.has(ev.type)) return;
    if (isTeam && !workerFinished(ev)) return; // mid-run per-turn result — keep waiting
    if (isTeam && !wholeTeamQuiet(ev)) return;  // a sibling is still working — keep waiting
    return cb(ev);
  };
  lane.on('agent-event', check);
  if (isTeam) lane.on('team-complete', cb).on('team-failed', cb);
}

function _countJsonl(file) {
  if (!file || !fs.existsSync(file)) return { toolUse: 0, toolResult: 0, chars: 0 };
  let toolUse = 0;
  let toolResult = 0;
  let chars = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'tool_use') toolUse += 1;
      else if (ev.type === 'tool_result') toolResult += 1;
      else if (ev.type === 'assistant_text' && typeof ev.content === 'string') chars += ev.content.length;
    } catch {}
  }
  return { toolUse, toolResult, chars };
}

// Deterministic metrics for one lane measured on its own journals.
function measureLane(eventsFiles, boardFile) {
  let toolUse = 0;
  let toolResult = 0;
  let chars = 0;
  for (const f of eventsFiles) {
    const m = _countJsonl(f);
    toolUse += m.toolUse;
    toolResult += m.toolResult;
    chars += m.chars;
  }
  const boardRows = boardFile && fs.existsSync(boardFile)
    ? fs.readFileSync(boardFile, 'utf8').split('\n').filter((l) => l.trim()).length
    : 0;
  return { toolUse, toolResult, outputChars: chars, boardEvents: boardRows };
}

function buildCompareReport(run, single, n2) {
  const s = single ? measureLane([single.eventsFile], null) : null;
  const t = measureLane(
    [path.join(n2.dir, 'events-worker-A.jsonl'), path.join(n2.dir, 'events-worker-B.jsonl')],
    n2.boardFile,
  );
  // Verdict is a deterministic heuristic: whichever side produced more
  // combined tool traffic + output wins. With no single lane (/run-n2),
  // the dual-agent side is always reported.
  const winner = single && t.toolUse + t.outputChars < s.toolUse + s.outputChars ? SINGLE : N2;
  return {
    task: run.task,
    startedAt: run.startedAt,
    // Only serializable lane METADATA lands in the report. The raw `n2`
    // object also carries `lane` (a live TeamSession whose DelmBoard has
    // a `root` property closing a cycle) — embedding it made
    // persistCompareReport's JSON.stringify throw "Converting circular
    // structure to JSON … property 'root' closes the circle". The per-lane
    // metrics live in `summary`; keep just id/boardFile/dir for traceability.
    n2: { id: n2.id, boardFile: n2.boardFile, dir: n2.dir },
    // Wall-clock per lane (set by the /compare + /run-n2 handlers when each
    // lane reaches a terminal state). Sequential /compare gives each lane
    // its own clean duration.
    timing: {
      single: single && single.startedAt && single.endedAt ? single.endedAt - single.startedAt : null,
      n2: n2 && n2.startedAt && n2.endedAt ? n2.endedAt - n2.startedAt : null,
    },
    summary: {
      single: s,
      n2: t,
      verdict: winner,
    },
  };
}

// ---- Live progress heartbeat (A-1 + A-2) ----
//
// While a lane runs, periodically push a one-line status into the main chat
// pane so the user sees it is alive and, for the n=2/team lane, how far the
// shared board's sub-queue has progressed — instead of the previous dead-silent
// gap between "started" and "finished". Works for both a single AgentSession
// and a TeamSession (both emit 'agent-event'; a TeamSession's events carry
// `worker`).

function shortOwner(owner) {
  return String(owner || '').replace(/^worker-/, '');
}

// Cap a task prompt to its first few words for the progress-heartbeat label —
// the full prompt is already in the chat record; the heartbeat line only needs
// enough to identify the run (用户反馈: ⏳ 双 agent 打印不要带整个 prompt).
const TASK_LABEL_MAX_CHARS = 12;
function shortTask(task) {
  const s = String(task || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length <= TASK_LABEL_MAX_CHARS ? s : `${s.slice(0, TASK_LABEL_MAX_CHARS)}…`;
}

// Emit-on-meaningful-change: report on the FIRST tick, then only when the
// lane produced a *real* jump in activity (a board/queue transition, a
// tool-call burst, or a chunk of new output) — tiny per-tick drifts are
// swallowed so a busy team doesn't spam one line every interval. Or after a
// long quiet stretch (LIVENESS_MS) so a lane that is silently reasoning still
// keeps the user informed it is running.
const PROGRESS_INTERVAL_MS = 30000;          // was 15000 — fewer chat lines per run
const PROGRESS_LIVENESS_MS = 45000;
const MIN_TOOL_DELTA = 3;     // don't print for fewer than 3 new tool calls
const MIN_CHARS_DELTA = 400;  // …or fewer than 400 chars of new output

// Count one agent-event into totals + per-worker buckets.
function countProgressEvent(ev, totals, perWorker) {
  if (!ev) return;
  if (ev.type === 'tool_use') totals.toolUse += 1;
  else if (ev.type === 'tool_result') totals.toolResult += 1;
  else if (ev.type === 'assistant_text' && typeof ev.content === 'string') totals.chars += ev.content.length;
  if (ev.worker) {
    const w = perWorker[ev.worker] || (perWorker[ev.worker] = { toolUse: 0, toolResult: 0, chars: 0 });
    if (ev.type === 'tool_use') w.toolUse += 1;
    else if (ev.type === 'tool_result') w.toolResult += 1;
    else if (ev.type === 'assistant_text' && typeof ev.content === 'string') w.chars += ev.content.length;
  }
}

// Build the one-line status string. Pure, so unit tests can assert its shape.
// `fullText` (optional) never affects the returned line — it is returned as
// `full` so callers can stamp it on the chat message as meta.fullText for
// the client to render as a hover tooltip (user request: the truncated
// progress line shows the task's first few words; hovering reveals ALL of
// it — full task prompt + the complete queue list).
function formatProgress({ label, startedAt, totals, perWorker, queue, fullText }) {
  const el = startedAt ? ` · ${((Date.now() - startedAt) / 1000).toFixed(0)}s` : '';
  let line = `⏳ ${label} 进行中${el}`;
  const workers = Object.keys(perWorker).sort();
  if (workers.length) {
    line += ` · ${workers.map((w) => `${shortOwner(w)}:${perWorker[w].toolUse} 次`).join('  ')}`;
  } else {
    line += ` · 工具 ${totals.toolUse} · 输出 ${totals.chars} 字符`;
  }
  if (queue && Array.isArray(queue)) {
    const open = queue.filter((i) => i.state === 'open').length;
    const claimed = queue.filter((i) => i.state === 'claimed').length;
    const done = queue.filter((i) => i.state === 'done').length;
    const sample = queue.slice(0, 3)
      .map((i) => `${i.subject}[${i.state}${i.owner ? ':' + shortOwner(i.owner) : ''}]`)
      .join(' · ');
    line += ` · 子任务 待领 ${open} / 进行中 ${claimed} / 完成 ${done}`;
    if (sample) line += `（${sample}${queue.length > 3 ? '…' : ''}）`;
  }
  return fullText ? { line, full: fullText({ label, queue }) } : line;
}

// Start the heartbeat for one lane. `getQueue` returns the live board queue
// (e.g. `() => teamSession.board.queueState()`) or null for a single lane.
// Returns a stop() that clears the interval and detaches the listener (call it
// on lane terminal so we never reply after the lane finished).
function startProgressHeartbeat({ lane, label, startedAt, reply, getQueue, fullText, intervalMs = PROGRESS_INTERVAL_MS }) {
  const totals = { toolUse: 0, toolResult: 0, chars: 0 };
  const perWorker = {};
  const onEv = (ev) => countProgressEvent(ev, totals, perWorker);
  lane.on('agent-event', onEv);

  // Emit only on meaningful progress: a board/queue transition, a tool-call
  // burst (>= MIN_TOOL_DELTA) or a chunk of new output (>= MIN_CHARS_DELTA).
  // Otherwise, fall back to a LIVENESS_MS liveness ping so a silent-but-alive
  // lane still reports. lastShown tracks the snapshot we last PRINTED, so
  // small per-tick drifts never each produce a chat line.
  let first = true;
  let lastShown = { toolUse: 0, chars: 0, queueSig: '' };
  let lastEmitAt = 0;
  const emit = () => {
    const queue = getQueue ? getQueue() : null;
    const queueSig = getQueue ? JSON.stringify((queue || []).map((i) => [i.id, i.state])) : '';
    const now = Date.now();
    const stale = now - lastEmitAt >= PROGRESS_LIVENESS_MS;
    const meaningful = first
      || queueSig !== lastShown.queueSig
      || totals.toolUse - lastShown.toolUse >= MIN_TOOL_DELTA
      || totals.chars - lastShown.chars >= MIN_CHARS_DELTA;
    lastEmitAt = now;
    if (!meaningful && !stale) return;
    if (meaningful) {
      first = false;
      lastShown.toolUse = totals.toolUse;
      lastShown.chars = totals.chars;
      lastShown.queueSig = queueSig;
    }
    if (typeof reply === 'function') {
      const out = formatProgress({ label, startedAt, totals, perWorker, queue, fullText });
      // When fullText is supplied the caller wants the FULL content available
      // on hover: reply with the truncated line as the chat text and the full
      // content as meta.fullText (rendered as a title tooltip by the client).
      if (out && typeof out === 'object') {
        reply(out.line, { meta: { kind: 'full-text', fullText: out.full } });
      } else {
        reply(out);
      }
    }
  };
  if (typeof reply === 'function') emit(); // immediate first line — no "dead" start

  const timer = setInterval(emit, intervalMs);
  return () => { clearInterval(timer); lane.removeListener('agent-event', onEv); };
}

// Persist the compare report under <cwd>/_myco_/compare/.
function persistCompareReport(cwd, report) {
  const dir = path.join(cwd, '_myco_', 'compare');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

// ---- N-path exploration lane (/run-explore) ----
//
// An isolated TeamSession in explore mode: roster 'path-1'..'path-N',
// explorer prompts (prompts-explore.js), FORCED RLM workers, and a SHARED
// per-task Continual-Harness key so self-authored rules accumulate across
// workers AND across future runs of the same task. Reuses the SAME
// bridge / split-view / lane-registry wiring as startTeamLane.

// Stable shared-harness key for one task text: 'explore-task-<sha1-12>'.
// Same task → same key → same accumulated self-evolution store.
function exploreHarnessKey(task) {
  const sha = require('crypto').createHash('sha1').update(String(task || '')).digest('hex');
  return `explore-task-${sha.slice(0, 12)}`;
}

function startExploreLane({ cwd, user, task, dir, mainSession, mainSessionId, nPaths }) {
  const shadowId = `${mainSessionId}-cmp-explore`;
  const laneId = _newLaneId('explore');
  const laneMeta = { laneId, task };
  const roster = [];
  for (let i = 1; i <= nPaths; i += 1) roster.push(`path-${i}`);
  const lane = new TeamSession(shadowId, {
    cwd,
    user,
    task,
    eventsDir: dir,
    roster,
    explore: true,
    harnessKey: exploreHarnessKey(task),
  });
  // laneTag null — events render in the MAIN timeline with worker badges
  // (frontend workerClass falls through to the generic class for 'path-*').
  _bridge(lane, mainSession, mainSessionId, null, laneMeta);
  mainSession.emit('state-update', {
    kind: 'team-info',
    mode: 'agent-n2',
    teamLane: true,
    laneId,
    task: String(task || ''),
    roster: lane.roster,
    board: lane.boardSnapshot(),
  });
  const laneRec = { lane, laneId, task: String(task || ''), ended: false, roster: lane.roster, startedAt: Date.now() };
  _registerLane(mainSession, laneRec);
  onLaneTerminal(lane, true, () => {
    laneRec.ended = true;
    mainSession.emit('state-update', { kind: 'team-lane-end', teamLane: true, laneId, task: laneRec.task });
  });
  lane.dispatchTask(task);
  return {
    lane, id: shadowId, laneId, roster,
    boardFile: path.join(dir, 'board.jsonl'),
    dir, startedAt: laneRec.startedAt,
    harnessKey: exploreHarnessKey(task),
  };
}

// Build the end-of-run exploration report from the lane's own journals +
// board. Per-path outcome = its queue items' done summaries + FAIL notes
// (a dead end is closed with done + FAIL note carrying measurements, so
// the report can show WHY each path lost, with evidence).
function buildExploreReport(run, explore) {
  const board = explore.lane.board;
  const queue = board ? board.queueState() : [];
  const notes = board ? (board.view(null).notes || []) : [];
  const fails = notes.filter((n) => n && n.type === 'FAIL');
  const perPath = explore.roster.map((actor) => {
    const items = queue.filter((i) => i.owner === actor);
    return {
      actor,
      items: items.map((i) => ({ id: i.id, subject: i.subject, state: i.state, summary: i.summary || null })),
    };
  });
  const t = measureLane(
    explore.roster.map((a) => path.join(explore.dir, `events-${a}.jsonl`)),
    explore.boardFile,
  );
  // run-explore interactive-step ledger + strategy-switch log (§5.1/§5.2).
  // Generated from the live TeamSession's ExploreLoopDetector — feeds
  // partial-goal verification even when the agent goal is invisible to the
  // lane layer. Files: <dir>/steps-<actor>.jsonl (normalized step ledger).
  let interactiveSteps = {};
  let strategySwitches = [];
  const lane = explore.lane;
  if (lane && lane.exploreLoopDetector) {
    try {
      lane.exploreLoopDetector.flushLedger(explore.dir);
      interactiveSteps = lane.exploreLoopDetector.reportSummaries();
      strategySwitches = lane.exploreLoopDetector.switchLog().map((s) => ({
        worker: s.worker, streak: s.streak, at: s.atISO,
      }));
    } catch (err) {
      console.error(`[explore] ledger flush failed: ${err.message}`);
    }
  }
  return {
    task: run.task,
    startedAt: run.startedAt,
    explore: { id: explore.id, dir: explore.dir, harnessKey: explore.harnessKey, roster: explore.roster },
    timing: {
      explore: explore.startedAt && explore.endedAt ? explore.endedAt - explore.startedAt : null,
    },
    summary: {
      paths: perPath,
      failNotes: fails.map((n) => ({ actor: n.actor, type: n.type, scope: n.scope, text: n.text })),
      metrics: t,
      queue: queue.map((i) => ({ id: i.id, subject: i.subject, state: i.state, owner: i.owner })),
      // run-explore strategy-switching (§5.1) + interactive steps (§5.2):
      // per-path action counts/errors + loop switches → verifiable partial
      // goal progress without needing the agent goal itself.
      interactiveSteps,
      strategySwitches,
    },
  };
}

// Persist the exploration report under <cwd>/_myco_/explore/.
function persistExploreReport(cwd, report) {
  const dir = path.join(cwd, '_myco_', 'explore');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

module.exports = {
  SINGLE,
  N2,
  startSingleLane,
  startN2Lane,
  startTeamLane,
  startExploreLane,
  buildExploreReport,
  persistExploreReport,
  exploreHarnessKey,
  stopN2Lane,
  onLaneTerminal,
  buildCompareReport,
  persistCompareReport,
  timestampedDir,
  formatProgress,
  shortTask,
  startProgressHeartbeat,
  // multi-lane registry (2026-10-22): attach handshake + tests consume
  listLanes,
  // Test-only alias onto _registerLane — stubbed sessions in
  // stop-button-run-n2.test.js seed the registry directly instead of
  // spinning a real SDK lane.
  _registerLaneForTest: _registerLane,
};
