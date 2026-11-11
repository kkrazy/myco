// TeamSession — a Delm n=2 team inside a single myco process.
//
// One run-queue dispatch is handled by TWO parallel AgentSessions
// (worker-A / worker-B) that coordinate only through a shared DelmBoard
// (shared context + shared sub-queue), with per-worker orchestration
// prompts from prompts_n2.py (STARTUP_A / STARTUP_B). This is the
// "仅进程内" dual-worker design: no containers, no shell, no HTTP board.
//
//   user chat input -> TeamSession.write()  -> ONLY worker-A
//   runQueue task   -> TeamSession.dispatchTask() -> BOTH workers
//
// worker-B learns the task by reading the board and claiming sub-queue
// items the workers publish. The board is the single source of truth for
// the sub-queue; plan.json is a one-way display mirror written elsewhere.
//
// The TeamSession exposes the SAME event surface attach.js uses for a
// single AgentSession ('agent-event' / 'chat' / 'state-update' / 'exit' /
// 'idle'), so the WS/chat plumbing is unchanged — it just sees one session
// whose events carry a `worker` field. It aggregates a replay `buffer` and
// numbers events with a team-wide monotonic seq.

'use strict';

const { EventEmitter } = require('events');
const path = require('path');

const { AgentSession } = require('./agent-session');
const { DelmBoard } = require('./board');
const { createBoardMcpServer } = require('./board-mcp');
const { workerPrompt } = require('./prompts-n2');
const { expertPrompt } = require('./prompts-team');
const { rlmN2Addendum } = require('./agents/rlm/prompt');

const ROSTER = ['worker-A', 'worker-B'];

// Stall watchdog (n=2 backstop). The team's only liveness signal is agent-
// events arriving from either worker. If neither produces ANY event for a
// while, the team is hung (shadow-lane permission prompt nobody answers, a
// stuck board, an abandoned claim, …). We nudge once with a "continue"
// message, and — if still silent past the fail window — emit team-failed so
// runQueue marks the task failed + the user is told, instead of hanging
// forever. Overridable: MYCO_N2_STALL_NUDGE_MS / MYCO_N2_STALL_FAIL_MS.
// Defaults lengthened 2026-11-05 per user request (bench runs showed the old
// 5/8-min windows mis-flagging long-but-productive experiment tasks): a
// gateway-hot run can legitimately sit quiet far past the old windows while a
// worker grinds a long tool call. The cost — a truly dead team now takes up to
// 4h to be declared failed — is accepted for the deploy target; override with
// the env vars above to tighten it for interactive use.
const STALL_NUDGE_MS = Number(process.env.MYCO_N2_STALL_NUDGE_MS) || 220 * 60 * 1000; // first warn+nudge
const STALL_FAIL_MS = Number(process.env.MYCO_N2_STALL_FAIL_MS) || 240 * 60 * 1000;   // hard fail
const STALL_CHECK_MS = 20 * 1000;

class TeamSession extends EventEmitter {
  /**
   * @param {string} mycoSessionId  the owning myco session id
   * @param {object} opts
   * @param {string} opts.cwd       shared workspace (both workers' cwd)
   * @param {string} [opts.user]    owner login (for git identity)
   * @param {string} opts.task      the original task text (dispatch baseline)
   * @param {string} [opts.eventsDir] where to persist board journal + worker
   *                                  event journals (default <cwd>/_myco_)
   * @param {boolean} [opts.rlm]     RLM session-level overlay (/rlm on) —
   *                                  appends the RLM addendum to each
   *                                  worker's startup prompt (§5.1)
   * @param {string[]} [opts.roster]  multi-expert roster override
   *                                  (['worker-A'..'worker-N']). Default
   *                                  (absent) = the canonical n=2 roster,
   *                                  so /run-n2 behaviour is unchanged.
   * @param {object} [opts.expertSkills] multi-expert mode: map actor ->
   *                                  [{ name, description }] — the skills
   *                                  (from the skill market) that define
   *                                  that expert. Absent/null = n=2 mode
   *                                  (prompts-n2 STARTUP_A/B).
   * @param {boolean} [opts.explore] N-path exploration mode (/run-explore):
   *                                  per-worker prompts come from
   *                                  prompts-explore.js explorerPrompt()
   *                                  and workers are FORCED to run the RLM
   *                                  engine (self-evolution needs the
   *                                  rlm.addPrompt channel). Absent = the
   *                                  expertSkills/n2 resolution above.
   * @param {string} [opts.harnessKey] shared Continual-Harness store key
   *                                  (agents/rlm harness.js). Absent/null =
   *                                  per-session store (unchanged default).
   */
  constructor(mycoSessionId, { cwd, user, task, eventsDir, resumeSessions, rlm, roster, expertSkills, workerAStartup, workerBStartup, boardGuidance, explore, harnessKey } = {}) {
    super();
    this.sessionId = mycoSessionId;
    this._resumeSessions = resumeSessions || null;
    // §5.1: /rlm on for an agent-n2 session = prompt-level overlay for
    // the workers (board contract keeps precedence). Persisted on the
    // TeamSession so _spawnWorker can consult it.
    // harness2 n2 rollout: startup text overrides for worker-A/B and
    // board guidance. Absent → falls back to prompts-n2-shared.js text.
    this._workerAStartup = workerAStartup || null;
    this._workerBStartup = workerBStartup || null;
    this._boardGuidance  = boardGuidance  || null;
    this.rlm = rlm === true;
    this.mode = 'agent-n2';
    this.alive = true;
    this.cwd = cwd || process.cwd();
    this.user = user || null;
    // Multi-expert mode (专家团): opts.roster overrides the fixed n=2
    // roster and opts.expertSkills switches per-worker prompts from
    // STARTUP_A/B to the skills-defined expert prompts (prompts-team.js).
    // Both default to the canonical n=2 values so an unmodified /run-n2
    // lane is byte-identical to before.
    this.roster = Array.isArray(roster) && roster.length > 0 ? roster.slice() : ROSTER.slice();
    this.expertSkills = expertSkills || null;
    // N-path exploration mode (/run-explore): prompts from prompts-explore.js
    // + forced RLM workers (self-evolution rides on rlm.addPrompt). Absent =
    // the expertSkills / n2 resolution — /run-n2 byte-identical.
    this.explore = explore === true;
    this.harnessKey = harnessKey || null;
    // run-explore strategy-switching / loop detection (§5.1) + interactive
    // step ledger (§5.2). EXPLORE-ONLY: created lazily for explore lanes so
    // the n2 / experts / single paths carry zero extra state (n2 followup —
    // docs/arch/agents/explore/run-explore.md §6 — must get the same later).
    this.exploreLoopDetector = this.explore
      ? new (require('./explore-loop-detect').ExploreLoopDetector)()
      : null;
    const root = eventsDir || path.join(this.cwd, '_myco_');
    // Persistent run dir + authoritative task text — stashed for the
    // explore step-ledger flush (run-explore partial-goal verification)
    // and the strategy-switch prompt.
    this._eventsDir = root;
    this._taskText = task || null;

    // Single shared board — the only connection between the two workers.
    this.board = new DelmBoard({
      actors: this.roster,
      persistPath: path.join(root, 'board.jsonl'),
    });

    // Aggregated event ring for reattach replay (attach.js reads .buffer).
    this.buffer = [];
    this._seq = 0;
    this._busy = {};
    for (const actor of this.roster) this._busy[actor] = false;
    this._completed = false;
    // True once a task has reached EVERY worker (first user chat write or
    // a run-queue dispatchTask). Until then worker-B has no SDK iteration
    // at all, so a chat write must fan out (see write()).
    this._taskDispatched = false;
    // working-status parity with AgentSession: GET /sessions reads
    // live.isBusy() for the sidebar "working" badge and live._lastDoneAt
    // for the "to review" badge. Stamped in _relay on terminal events.
    this._lastDoneAt = null;

    this.workers = {};
    for (const actor of this.roster) {
      this.workers[actor] = this._spawnWorker(actor, task, root);
    }
    this.active = [];
    this._wireWorkers();
    // team-split-view: relay board activity to attached clients. The
    // board is the ONLY coordination channel between the workers, so
    // these events are what makes interaction/dependency visible in the
    // UI. read/wait/session are filtered out — they're worker-local
    // coordination noise (every board read appends a 'read' row), not
    // user-visible board state.
    this.board.on('change', (row) => this._relayBoardChange(row));
    // bug-fix (worker-B 无响应): an idle worker has NO SDK iteration
    // running, so board 'wake' events can never reach it (they only
    // resolve a pending board.read(wait) promise). When worker-A
    // publishes peer work while worker-B is idle — the canonical
    // STARTUP_A handoff — worker-B's column stays empty forever ("●
    // idle", no content) until the stall watchdog nudges it (40min default).
    // Kick idle workers directly on a new OPEN item: the nudge starts a
    // fresh SDK iteration whose first action (per the worker prompt) is
    // to read the board and claim.
    this.board.on('change', (row) => this._kickIdleWorkersOnOpenItem(row));
    // Stall watchdog state. Liveness is per-WORKER, not per-team: a single
    // team-wide stamp let one busy worker mask a peer that had gone silent.
    // Measured on sw-20261031-163112: worker-B stopped at 18:52:51 while
    // worker-A kept emitting until 19:15:54, so each of worker-A's events
    // reset the clock and worker-B's 23 minutes of silence went unseen. Only
    // once worker-A finished did the timer start, and 485 s later the whole
    // team was killed — after the work was already done.
    this._lastActivity = Date.now();
    this._lastActivityBy = {};
    for (const actor of this.roster) this._lastActivityBy[actor] = Date.now();
    this._stallNudged = false;
    this._stallWatchdog = setInterval(() => this._stallCheck(), STALL_CHECK_MS);
    if (this._stallWatchdog.unref) this._stallWatchdog.unref();
  }

  _spawnWorker(actor, task, root) {
    // Prompt resolution order (first match wins):
    //   1. explore mode        — prompts-explore.js explorerPrompt()
    //                            (roster 'path-1'..'path-N', one deep-dive
    //                            path per explorer). /run-explore only.
    //   2. multi-expert mode   — prompts-team.js expertPrompt() (skills-
    //                            defined role). /run-experts only.
    //   3. n=2                 — prompts-n2.js workerPrompt() (STARTUP_A/B
    //                            + optional harness2 startup overrides).
    // Modes 2/3 are byte-identical to before; mode 1 is additive.
    const buildPrompt = () => {
      if (this.explore) {
        const { explorerPrompt } = require('./prompts-explore');
        return explorerPrompt({
          task, actor, roster: this.roster, workspace: this.cwd,
          nPaths: this.roster.length,
        });
      }
      return this.expertSkills
        ? expertPrompt({
            task, actor, roster: this.roster, workspace: this.cwd,
            skills: this.expertSkills[actor] || [],
            nWorkers: this.roster.length,
          })
        : workerPrompt({
            task, actor, roster: this.roster, workspace: this.cwd,
            startupOverride: actor === this.roster[0] ? this._workerAStartup : this._workerBStartup,
            boardGuidanceOverride: this._boardGuidance,
          });
    };
    // P1+P2 deepening: for RLM teams the ONLY change is the worker's
    // CONSTRUCTION ENTRYPOINT — spawnRlmAgent (agents/rlm) instead of a
    // hand-wired AgentSession. TeamSession structure is untouched: the
    // board stays the sole coordination channel, claim/publish/reserve
    // semantics are unchanged, and the addendum's precedence declaration
    // still binds (board-claimed work is never delegated across the board).
    // Each RLM worker gets a REAL kernel of its own (state survives across
    // turns, rlm_eval) and is spawned at depth 1 (maxDepth 3), so sub-agents
    // the worker spawns from inside its kernel are depth-capped by the
    // runtime, not by prompt goodwill. Non-RLM teams are byte-identical to
    // before (plain AgentSession, no rlm MCP server).
    const common = {
      cwd: this.cwd,
      user: this.user,
      // Delm roster index: worker-A -> STARTUP_A (creates initial queue),
      // worker-B -> STARTUP_B (reads board, claims peer work).
      workerRole: actor,
      boardMcp: createBoardMcpServer(this.board, actor, { cwd: this.cwd }),
      eventsFile: path.join(root, `events-${actor}.jsonl`),
      // Autonomous background worker — never block on an interactive
      // permission prompt (nobody answers a shadow-lane canUseTool, so the
      // team hangs). Auto-approves all tools via _preToolUseHook.
      autonomousPermission: true,
      // Resume each worker's SDK transcript across a server restart.
      resumeSdkSessionId: (this._resumeSessions && this._resumeSessions[actor]) || null,
    };
    let w;
    // Explore workers are FORCED onto the RLM engine even when the session
    // didn't opt into RLM: the self-evolution loop (shared Continual
    // Harness) rides on the kernel's rlm.addPrompt channel, which only
    // exists for RLM agents. Board protocol keeps precedence — the n2
    // addendum already declares that — and this never affects non-explore
    // teams (their this.rlm comes from the session flag, unchanged).
    const rlmWorker = this.rlm || this.explore;
    if (rlmWorker) {
      const rlm = require('./agents/rlm');
      w = rlm.spawnRlmAgent(this.sessionId + '-' + actor, {
        ...common,
        harnessKey: this.harnessKey || undefined,
        systemPrompt: buildPrompt() +
          // §5.1: RLM overlay for n2 workers (session opted in via /rlm on).
          // The addendum declares PRECEDENCE — board contract wins on
          // conflicts — so the team protocol is never weakened. The board
          // prompt stays first; the overlay only appends.
          rlmN2Addendum(),
        // Sub-agent depth runtime enforcement: this worker is itself a
        // first-level RLM agent (depth 1); anything it spawns from inside
        // its kernel is depth 2 and hard-capped at maxDepth 3.
        rlmSpawn: { parentSessionId: this.sessionId, depth: 1, maxDepth: 3 },
      });
    } else {
      w = new AgentSession(this.sessionId, {
        ...common,
        systemPrompt: buildPrompt(),
      });
    }
    this[actor] = w;
    return w;
  }

  // Merge a worker's agent-event into the team buffer + emit it, tagged
  // with the worker. Stamps a team-wide sequential id so the chat pane's
  // cross-device resort stays correct across both workers' streams.
  _relay(actor, event) {
    if (!event) return;
    // run-explore strategy-switching: feed every event into the loop
    // detector; if an explorer is stuck repeating one action with no
    // result, inject a corrective strategy-switch prompt (no time
    // hard-limit). Explore lanes only — n2 untouched (§6 followup).
    if (this.exploreLoopDetector) {
      const decision = this.exploreLoopDetector.observe(actor, event);
      if (decision) this._applyStrategySwitch(actor, decision);
    }
    const stamped = Object.assign({}, event, { worker: actor, workerSeq: ++this._seq });
    this.buffer.push(stamped);
    if (this.buffer.length > 5000) this.buffer.splice(0, this.buffer.length - 5000);
    // Any worker activity resets the stall watchdog — team-wide for the UI
    // nudge, per-worker for the real liveness check (see the constructor).
    // EXCEPT bridged RLM sub-agent events (bridge.js stamps `rlmLane`): they
    // are UI-only traffic from the worker's OWN rlm.spawn children, not the
    // worker's SDK stream. Letting them feed the clock let a dead/stuck
    // worker be masked forever by its still-running children — the same
    // class of miss as the busy-peer-masks-silent-peer bug below (a worker
    // blocked in rlm.collect is safe: the kernel host_request caps collect
    // at 15min, far below the nudge window).
    const bridged = !!(event && event.rlmLane);
    if (!bridged) {
      this._lastActivity = Date.now();
      this._lastActivityBy[actor] = Date.now();
      this._stallNudged = false;
    }
    // working-status parity: stamp the team-wide "done moment" the same
    // way AgentSession._emit does (turn_result / iteration_aborted /
    // fatal). GET /sessions reads live._lastDoneAt to decide the
    // sidebar's "to review" badge — without this a finished agent-n2
    // session never flips the badge.
    if (event && (event.type === 'turn_result' || event.type === 'iteration_aborted' || event.type === 'fatal')) {
      this._lastDoneAt = Date.now();
    }
    this.emit('agent-event', stamped);
  }

  // run-explore loop-detection correction: write a strategy-switch prompt
  // into the stuck worker via the same write() channel the stall nudge /
  // idle kick use (least-invasive, no time hard-limit), and surface a
  // state-update so the split-view shows the switch happened. Explore
  // lanes only.
  _applyStrategySwitch(actor, decision) {
    const w = this.workers[actor];
    if (!w || !w.write) { this._maybeSwitchLedger(actor, decision); return; }
    try {
      const prompt = require('./explore-loop-detect').ExploreLoopDetector
        .switchPrompt(decision, this._taskText || null);
      this._busy[actor] = true;
      w.write(prompt);
      console.log(`[team] ${this.sessionId} strategy-switch ${actor} after ${decision.streak} same-action w/ no result`);
      this.emit('state-update', {
        kind: 'team-strategy-switch',
        worker: actor, lane: true,
        streak: decision.streak,
        text: `⚠️ ${actor} 疑似陷入循环（${decision.streak} 次相同动作无结果）→ 已注入策略切换提示`,
      });
    } catch (err) {
      console.error(`[team] ${this.sessionId} strategy-switch ${actor} failed: ${err.message}`);
    }
  }

  // Persist the interactive-step ledger / switch log for one actor (used
  // when the worker itself is gone — e.g. already killed — so the ledger
  // still lands on disk for partial-goal verification).
  _maybeSwitchLedger(actor, decision) {
    try {
      const dir = this._exploreLedgerDir();
      if (dir) this.exploreLoopDetector.flushLedger(dir);
      void actor; void decision;
    } catch {}
  }

  // Where the explore lane persists its step ledger. The lane's dir was
  // passed as eventsDir by startExploreLane — reuse it so steps land next
  // to events-<actor>.jsonl / board.jsonl.
  _exploreLedgerDir() {
    return (this._eventsDir || path.join(this.cwd, '_myco_'));
  }

  // Stall watchdog tick: no event for STALL_NUDGE_MS → nudge once with a
  // "continue" message; no event for STALL_FAIL_MS → declare team-failed so
  // the runQueue entry is marked failed + the user is told instead of the
  // team hanging silently.
  _stallCheck() {
    if (this._completed || !this.alive) return;
    const now = Date.now();

    // Which workers are silent past the nudge window? The check is per-actor:
    // a worker that finished its own items simply goes quiet, and that is
    // normal — but a worker that still HOLDS A CLAIM while quiet is stuck, so
    // only the second kind escalates to a hard failure.
    const silent = this.roster.filter(
      (a) => now - (this._lastActivityBy[a] || 0) >= STALL_NUDGE_MS);
    if (!silent.length) return;

    const queue = this.board.queueState();
    const heldBy = (a) => queue.filter((i) => i.state === 'claimed' && i.owner === a);

    if (!this._stallNudged) {
      this._stallNudged = true;
      const idle = now - this._lastActivity;
      // chat-print-persistence fix (2026-11-04): persist the stall note
      // into rec.chat too — the emit alone vanished on refresh/reconnect.
      const stallMsg = {
        user: 'claude',
        text: `⚠️ ${this.explore ? `路径探索（${this.roster.length} 路）` : '双 agent'} — ${silent.join(', ')} 已 ${Math.round(idle / 1000)}s 无进展，发送“继续”提醒，若仍无响应将标记失败…`,
        ts: new Date().toISOString(),
        meta: { kind: 'team-stall' },
      };
      try {
        const sessionsMod = require('./sessions');
        if (sessionsMod.appendChatMessage) sessionsMod.appendChatMessage(this.sessionId, stallMsg);
      } catch {}
      this.emit('chat', stallMsg);
      for (const actor of silent) {
        if (this._busy[actor]) continue;
        const held = heldBy(actor);
        this._busy[actor] = true;
        // A worker holding a claim is told to CLOSE it, not to go hunting for
        // more work: it may have finished and simply never called board.done,
        // which leaves `_maybeComplete` unable to ever fire.
        this.workers[actor].write(held.length
          ? `Continue: you still hold ${held.length} claimed item(s) — ` +
            `${held.map((i) => i.subject).join('; ')}. If that work is finished, ` +
            'call board.done for each with its summary NOW. If it is not finished, ' +
            'state exactly what is blocking you.'
          : 'Continue: read the board demanding only the currently published sub-tasks, ' +
            'claim one if open, and complete it. If you are blocked, post a board status ' +
            'naming exactly what input is missing.');
      }
      return;
    }

    // Hard failure only when a silent worker is STILL holding a claim AFTER the
    // fail window — that is a stuck team, whereas a silent worker with nothing
    // claimed has finished.
    //
    // The window matters: `silent` is measured against STALL_NUDGE_MS, so
    // filtering on it here killed the team one tick (20 s) after the nudge was
    // sent, giving the nudged worker no chance to answer. Observed on
    // sw-20261101-080841: every one of eight rollouts died with
    // `stall (idle=22s|31s|34s)` — the idle in that message is the team-wide
    // minimum (the freshest worker), while the actual trigger was a peer that
    // had been quiet for five minutes holding a claim.
    const stuck = silent.filter(
      (a) => heldBy(a).length > 0 &&
             now - (this._lastActivityBy[a] || 0) >= STALL_FAIL_MS);
    const everyoneQuiet = this.roster.every(
      (a) => now - (this._lastActivityBy[a] || 0) >= STALL_FAIL_MS);
    if (!stuck.length && !everyoneQuiet) return;

    const idleMs = now - Math.max(...this.roster.map((a) => this._lastActivityBy[a] || 0));
    console.log(
      `[team] ${this.sessionId} stall-declared after ${Math.round(idleMs / 1000)}s — ` +
      `stuck=${stuck.join(',') || 'none'} everyoneQuiet=${everyoneQuiet} — team-failed`);
    this.emit('team-failed', {
      reason: 'stall',
      itemId: this._activeRunItem && this._activeRunItem.itemId,
      idleMs,
      stuckWorkers: stuck,
    });
    this.alive = false; // stop the watchdog + future work
    for (const actor of this.roster) { try { this.workers[actor].kill(); } catch {} }
  }

  // team-split-view: ship a board event + a full derived snapshot as a
  // state-update frame. The snapshot is authoritative and idempotent to
  // re-render (the client doesn't need to replay board semantics), and
  // board event volume is small (tens of sub-task rows), so a full
  // snapshot per change is cheap and removes any client-side
  // incremental-state drift risk.
  _relayBoardChange(row) {
    if (!row || !this.alive) return;
    if (['read', 'wait', 'session'].includes(row.kind)) return;
    // run-explore: a worker that posted to the board made progress — clear
    // its same-action loop streak so legitimate publishing isn't read as a
    // stuck loop. Explore lanes only.
    if (this.exploreLoopDetector && row.actor && typeof row.actor === 'string') {
      this.exploreLoopDetector.onBoardProgress(row.actor);
    }
    this.emit('state-update', {
      kind: 'board',
      event: { sequence: row.sequence, timeNs: row.timeNs, actor: row.actor, kind: row.kind, payload: row.payload },
      snapshot: this.boardSnapshot(),
    });
  }

  // Lightweight board view for UI consumers (attach-time team-info
  // frame + per-change state-updates). board.view(reader) stamps a
  // `reader` field + a 'read' log row per call — both unwanted side
  // effects for a UI poll — so derive the same shape here without
  // touching the log.
  boardSnapshot() {
    const view = this.board.view(null);
    delete view.reader;
    return {
      queue: view.queue,
      notes: view.notes,
      status: view.status,
      sessions: view.sessions,
      sequence: view.sequence,
    };
  }

  // bug-fix (worker-B 无响应): a worker that is NOT iterating and NOT
  // blocked inside a waiting board.read() can never observe a peer's
  // publish — the board's EventEmitter 'wake' only settles pending
  // read promises, and an idle worker holds none. Detect the publish
  // ('item' + 'claim' rows) via the 'change' event and write a nudge to
  // every idle, non-author worker so it wakes, reads the board and
  // claims the open item. setImmediate: the board appends the 'item'
  // row BEFORE the author's own claim may land (reserve/publish-then-
  // claim), so re-reading queueState on the next tick picks the FINAL
  // state and the kick only fires while an item is genuinely open.
  _kickIdleWorkersOnOpenItem(row) {
    if (!row || !this.alive || this._completed) return;
    if (row.kind !== 'item' && row.kind !== 'claim') return;
    setImmediate(() => {
      if (!this.alive || this._completed) return;
      const queue = this.board.queueState();
      const openItems = queue.filter((i) => i && i.state === 'open');
      if (!openItems.length) return;
      for (const actor of this.roster) {
        if (actor === row.actor) continue;            // the publisher knows its own work
        const w = this.workers[actor];
        if (!w || !w.alive) continue;
        // Busy check mirrors AgentSession.isBusy — an iterating worker
        // will see the board on its own (its next read/wait wakes).
        if (typeof w.isBusy === 'function' && w.isBusy()) continue;
        // Skip workers already holding a claim (one unfinished claim
        // per worker — a second write would push an unwanted prompt).
        const held = queue.some((i) => i && i.state === 'claimed' && i.owner === actor);
        if (held) continue;
        console.log(`[team] ${this.sessionId} kick idle worker ${actor}: ${openItems.length} open item(s) on the board`);
        this._busy[actor] = true;
        w.write(
          'Continue: the board has new open item(s) for you. Read the board (mcp__board__read), ' +
          'claim one open item that fits your scope, and implement it in this session.'
        );
      }
    });
  }

  _wireWorkers() {
    for (const actor of this.roster) {
      const w = this.workers[actor];
      w.on('agent-event', (e) => this._relay(actor, e));
      w.on('chat', (msg) => this.emit('chat', msg));
      // team-split-view: tag tool-progress with the owning worker. Pre-fix
      // both workers' open-tool lists were relayed untagged and collided
      // client-side in the single state.openToolCalls HUD slot (last
      // event wins) — the split-view per-column status reads this tag.
      w.on('state-update', (p) => this.emit('state-update', Object.assign({}, p, { worker: actor })));
      w.on('exit', (code) => this.emit('exit', code));
      w.on('idle', () => {
        this._busy[actor] = false;
        this._maybeComplete(actor);
      });
      // 'menu' is needed by the chat-pane permission routing (attach.js
      // registers a 'menu' listener when it wires an external session).
      w.on('menu', (payload) => this.emit('menu', Object.assign({}, payload, { worker: actor })));
    }
  }

  _maybeComplete(actor) {
    if (this._completed) return;
    this._autoCloseStaleClaim(actor);
    const q = this.board.queueState();
    // Complete only after the initial split produced a queue and every
    // item is closed, and every worker is done with its current turn.
    if (q.length > 0 && q.every((i) => i.state === 'done')
        && this.roster.every((a) => !this._busy[a])) {
      this._completed = true;
      this._stopWatchdog();
      this.active.push({ actor, at: Date.now() });
      this.emit('team-complete', { queueEmpty: true, items: q.length, workers: this.roster });
    }
  }

  // Auto-close a worker's stale claim on idle. User report (2026-10-30):
  // "任务都完成了，界面打印完成，但共享看板任务有些还没打勾" — a worker
  // finishes its turn (claude prints the completion summary) but never
  // calls mcp__board__done, so the 看板 row stays ◐ claimed (never ✓)
  // and team-complete can never fire because queueState() sees a
  // non-done item. When the worker goes idle after a SUCCESS turn, any
  // claim it still holds is closed automatically with a one-line summary
  // extracted from the turn's final result text — the checkbox then
  // reflects reality. Failure turns leave the claim alone (the work may
  // be incomplete; the stall nudge / user can still drive it).
  _autoCloseStaleClaim(actor) {
    const claimed = this.board.queueState().find(
      (i) => i && i.state === 'claimed' && i.owner === actor);
    if (!claimed) return;
    const w = this.workers[actor];
    const lastResult = w && typeof w.lastTurnResult === 'function'
      ? w.lastTurnResult() : null;
    if (!lastResult || lastResult.subtype !== 'success') return;
    const summary = 'auto-closed on idle: ' +
      _oneLineSummary(lastResult.result, claimed.subject);
    try {
      this.board.done(actor, claimed.id, summary);
      console.log(`[team] ${this.sessionId} auto-closed stale claim ${claimed.id} ` +
        `for ${actor} (worker went idle after a successful turn without board done)`);
    } catch (err) {
      // Never let the auto-close break the idle path.
      console.error(`[team] ${this.sessionId} auto-close of ${claimed.id} failed: ${err.message}`);
    }
  }

  // Real-time user chat: routed to worker-A only (the other workers learn
  // work through the board). Mirrors AgentSession.write() semantics.
  //
  // bug (user report: worker-B panel never reacts): an AgentSession only
  // starts its SDK iteration on a .write() — TeamSession._spawnWorker
  // passes no initialPrompt, and nothing else ever writes worker-B outside
  // dispatchTask ([run:…] markers) or the stall nudge. So on a
  // plain chat task worker-A did all the work while worker-B's panel sat
  // blank: its "read the board, claim peer work" startup never ran.
  // Fix: the FIRST user chat write acts as the team's task dispatch — it
  // fans out to EVERY worker (worker-B then reads the board and claims the
  // peer work worker-A publishes). Follow-up chat stays worker-A-only.
  write(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    if (!this._taskDispatched) {
      this._taskDispatched = true;
      this.dispatchTask(trimmed);
      return;
    }
    const lead = this.roster[0];
    const wa = this.workers[lead];
    this._busy[lead] = true;
    wa.write(trimmed);
  }

  // Dispatch a task (e.g. a run-queue '▶ Run plan#X' item) to EVERY worker,
  // each with its own orchestration prompt (STARTUP_A/B in n=2 mode, its
  // skills-defined expert prompt in multi-expert mode). The workers then
  // split work on the board's sub-queue.
  dispatchTask(text) {
    this._completed = false; // a new task starts a fresh team cycle
    this._taskDispatched = true;
    // Reset the stall watchdog for the new task.
    this._lastActivity = Date.now();
    this._stallNudged = false;
    for (const actor of this.roster) {
      this._busy[actor] = true;
      this.workers[actor].write(text);
    }
  }

  interrupt() {
    for (const actor of this.roster) {
      try { this.workers[actor].interrupt && this.workers[actor].interrupt(); } catch {}
    }
  }

  // RLM hot toggle (sessions.js applyRlmModeToLiveSession): rebuild both
  // workers after this.rlm flipped, so the next board task runs on the
  // new engine (spawnRlmAgent overlay vs plain AgentSession). Mirrors
  // getOrCreateTeamSession's contract: capture each live worker's
  // sdkSessionId BEFORE killing so the respawn RESUMES the same SDK
  // transcript (conversation continuity), tear down the old RLM kernel
  // children if the toggle went off, then re-spawn + re-wire. The Team
  // object itself stays alive — attached clients, the board and any lane
  // bridge all keep working across the swap.
  _respawnWorkers() {
    const resume = {};
    for (const actor of this.roster) {
      const w = this.workers[actor];
      resume[actor] = (w && w.sdkSessionId) || null;
      try { w && w.kill(); } catch {}
      try { require('./agents/rlm').shutdownRlmKernel(`${this.sessionId}-${actor}`); } catch {}
    }
    this._resumeSessions = resume;
    const root = this._eventsDir || path.join(this.cwd, '_myco_');
    for (const actor of this.roster) {
      this.workers[actor] = this._spawnWorker(actor, this._taskText, root);
      this._busy[actor] = false; // fresh worker starts idle until the next dispatch
    }
    this._wireWorkers();
    this._taskDispatched = false; // the next write/dispatch fans out to BOTH fresh workers
    console.log(`[rlm-hot] ${this.sessionId} workers respawned (rlm=${this.rlm}, resume={${this.roster.map((a) => a + ':' + (resume[a] || '').slice(0, 8)).join(', ')}})`);
  }

  // working-status parity (delm-10): true while ANY worker has an SDK
  // query iteration streaming. GET /sessions surfaces this as
  // s.agentBusy so the sidebar can badge agent-n2 team sessions the
  // same way single-agent sessions are badged ("working").
  isBusy() {
    return this.roster.some((actor) => {
      const w = this.workers[actor];
      return !!(w && typeof w.isBusy === 'function' && w.isBusy());
    });
  }

  _stopWatchdog() {
    if (this._stallWatchdog) { clearInterval(this._stallWatchdog); this._stallWatchdog = null; }
  }

  kill() {
    this._stopWatchdog(); // always stop the timer, even if already marked dead
    if (!this.alive) return;
    this.alive = false;
    for (const actor of this.roster) {
      try { this.workers[actor].kill(); } catch {}
      // Tear down the worker's RLM kernel child (RLM-mode teams only).
      // The kernel id matches the worker's session id — since the
      // spawnRlmAgent switch that is "<sessionId>-<actor>".
      try {
        const rlm = require('./agents/rlm');
        rlm.shutdownRlmKernel(`${this.sessionId}-${actor}`);
      } catch {}
    }
    try { this.board.stop(); } catch {}
    // If we're torn down with an in-flight run (attach.js sets
    // _activeRunItem), signal the run-queue so the running entry can be
    // marked failed + paused rather than stuck 'running' forever.
    if (this._activeRunItem && this._activeRunItem.itemId) {
      this.emit('team-failed', { itemId: this._activeRunItem.itemId });
    }
    this.emit('exit', 0);
  }
}

// One-line summary for auto-closed claims: the turn result's first
// non-empty line, clamped to a readable length, falling back to the
// item subject when the result text is empty/unavailable.
function _oneLineSummary(resultText, fallback) {
  const line = String(resultText || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)[0] || '';
  const text = line.slice(0, 120) || `claim "${fallback}" finished`;
  return text;
}

module.exports = { TeamSession, ROSTER };
