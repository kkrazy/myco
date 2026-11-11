// SDK-driven session — parallel to PtySession (server/src/pty.js).
//
// Spawned when sessions.spawnSession() is called with opts.mode='agent'.
// Wraps @anthropic-ai/claude-agent-sdk's query() and exposes a session
// interface compatible with the WS attach plumbing:
//
//   .alive, .pendingMenu, .sessionId, .mode='agent', .buffer (event ring)
//   .emit('agent-event' | 'chat' | 'state-update' | 'exit' | 'idle')
//   .write(text) — enqueue + run next turn (resumes SDK session by id)
//   .kill() — abort the in-flight iteration
//
// Phase 1 scope (this commit): minimal. canUseTool auto-denies anything
// that needs interactive approval — the chat-pane menu routing arrives
// in phase 2. Streaming-input (true multi-turn) arrives in phase 4;
// for now each .write() spawns a fresh query() with resume=sdkSessionId,
// which is one extra RTT per turn but keeps the implementation small.
//
// SDK migration is complete (Phase 9 retired the PTY driver). See
// CLAUDE.md "Code Style §2" for the SDK-only invariant.

const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { query } = require('@anthropic-ai/claude-agent-sdk');

// Per-session in-memory replay buffer cap. The buffer is hydrated
// from <cwd>/_myco_/events.jsonl on construction, so this cap is
// also the LOAD cap (last N events from disk). At ~5 events per
// turn ⇒ 5000 events ≈ 1000 turns of history.
const MAX_EVENTS = 5000;

// fr-45: hardcoded allowlist of SDK Options field names — used by
// _validateSdkOpts to catch silent-typo bugs like the bug-14 round 2
// `abortSignal: …` → should be `abortController: …`. The SDK
// silently drops unknown keys, so without this check a typo can sit
// undetected indefinitely. Extracted from
// @anthropic-ai/claude-agent-sdk/sdk.d.ts at the version pinned in
// server/package.json (61 fields as of sdk@0.3.142). Keep in sync
// across SDK minor-version bumps — the test/fr-45-sdkopts-lint
// regression checks the 9 myco-used keys are present.
const SDK_OPTIONS_ALLOWLIST = new Set([
  'abortController', 'additionalDirectories', 'agent', 'agents',
  'allowedTools', 'canUseTool', 'continue', 'cwd', 'disallowedTools',
  'toolAliases', 'tools', 'env', 'executable', 'executableArgs',
  'extraArgs', 'fallbackModel', 'enableFileCheckpointing', 'toolConfig',
  'forkSession', 'betas', 'hooks', 'onElicitation', 'persistSession',
  'sessionStore', 'sessionStoreFlush', 'loadTimeoutMs', 'includeHookEvents',
  'includePartialMessages', 'forwardSubagentText', 'thinking', 'effort',
  'maxThinkingTokens', 'maxTurns', 'maxBudgetUsd', 'taskBudget',
  'mcpServers', 'model', 'outputFormat', 'pathToClaudeCodeExecutable',
  'permissionMode', 'planModeInstructions', 'allowDangerouslySkipPermissions',
  'permissionPromptToolName', 'plugins', 'promptSuggestions',
  'agentProgressSummaries', 'resume', 'sessionId', 'resumeSessionAt',
  'sandbox', 'settings', 'managedSettings', 'settingSources', 'skills',
  'debug', 'debugFile', 'stderr', 'strictMcpConfig', 'systemPrompt',
  'title', 'spawnClaudeCodeProcess',
]);

// Disk file cap for events.jsonl. When the file grows past this
// (checked every ~100 appends), the file is rewritten in-place
// with only the last MAX_EVENTS lines. ~2 KB avg per event ⇒
// 5000 events ≈ 10 MB; we trim at 12 MB to leave headroom.
const MAX_EVENTS_FILE_BYTES = 12 * 1024 * 1024;

// Stream-idle watchdog env for the claude-code CLI child (2026-11-09,
// fec-n2-37 postmortem). The CLI has a built-in per-request watchdog:
// when a streaming response delivers no SSE chunks for the configured
// window it aborts THAT fetch and retries internally — turn untouched,
// no turn_result/iteration_aborted fires, invisible to the team lanes.
// It is what Claude Code's own --bg sessions run with; SDK-direct
// sessions (our shape) leave it OFF by default, which is how the
// 0b1beffc run sat 66 min on a hung gateway request (last event
// 06:45:46, socket death 07:51:53) with nothing to break the stall.
//
// CLAUDE_ENABLE_STREAM_WATCHDOG=1 arms it; CLAUDE_STREAM_IDLE_TIMEOUT_MS
// sets the window (the CLI clamps to a 5-min floor internally — we
// enforce a stricter 10-min floor here per the 2026-11-09 decision).
// Default 15 min: long tool calls (yosys synth, remote ssh) are NOT
// affected — the watchdog only arms while a request is IN FLIGHT —
// and a buffering gateway that legitimately holds a whole response
// gets ample headroom. On breach the cost is one internal retry, not
// a terminated turn, so a mis-sized window can't prematurely end a
// /run-n2 lane. Undocumented CLI-internal env (reverse-engineered
// from the vendored 2.1.142 binary): if a future SDK drops/renames
// it, the vars are ignored and behaviour degrades to the status quo
// (fail-open), never worse.
const STREAM_IDLE_TIMEOUT_DEFAULT_MS = 15 * 60 * 1000;    // 15 min
const STREAM_IDLE_TIMEOUT_FLOOR_MS = 10 * 60 * 1000;      // 10 min hard floor
function streamIdleWatchdogEnv() {
  const raw = Number(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS);
  const ms = Number.isFinite(raw) && raw > 0
    ? Math.max(raw, STREAM_IDLE_TIMEOUT_FLOOR_MS)
    : STREAM_IDLE_TIMEOUT_DEFAULT_MS;
  return {
    CLAUDE_ENABLE_STREAM_WATCHDOG: '1',
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: String(ms),
  };
}

// Async iterable backed by a manual push() API. Used as the SDK's
// streaming-input prompt — every user message landed via .write()
// pushes a `{type:'user', message:{role:'user', content}}` envelope
// here, the SDK consumes them in order. close() signals end-of-input.
//
// Why we need this: the SDK's query({prompt: asyncIterable}) keeps a
// single long-lived conversation open and only requires a fresh
// query() across abort boundaries. That keeps cache warm + cuts the
// per-turn round-trip cost that the Phase 1 per-turn-resume approach
// paid.
class AsyncMessageQueue {
  constructor() {
    this._queue = [];
    this._waiter = null;
    this._closed = false;
  }
  push(message) {
    if (this._closed) return;
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      w({ done: false, value: message });
    } else {
      this._queue.push(message);
    }
  }
  close() {
    this._closed = true;
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      w({ done: true, value: undefined });
    }
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this._queue.length) {
        yield this._queue.shift();
        continue;
      }
      if (this._closed) return;
      const next = await new Promise((resolve) => { this._waiter = resolve; });
      if (next.done) return;
      yield next.value;
    }
  }
}

// Truncate Claude's tool inputs to a chat-card-sized blurb.
function _summariseToolInput(name, input) {
  try {
    if (name === 'Bash') return String((input && input.command) || '').slice(0, 200);
    if (name === 'Read' || name === 'Edit' || name === 'Write') return String((input && input.file_path) || '').slice(0, 200);
    if (name === 'Glob' || name === 'Grep') {
      const q = (input && (input.pattern || input.query)) || '';
      const p = (input && input.path) ? ` in ${input.path}` : '';
      return (q + p).slice(0, 200);
    }
    if (name === 'WebFetch') return String((input && input.url) || '').slice(0, 200);
    return JSON.stringify(input || {}).slice(0, 200);
  } catch { return ''; }
}

// Reduce a structured tool_input object to the single string that
// permissions.matchesPattern compares against. Agent-mode replaces
// the pre-Phase-9 rawText regex parsing — the SDK hands us the
// structured input, so we extract the relevant field directly.
function _matchingInputFor(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  if (toolName === 'Bash') return String(toolInput.command || '');
  if (['Read', 'Edit', 'Write', 'MultiEdit'].includes(toolName)) return String(toolInput.file_path || '');
  if (['Glob', 'Grep'].includes(toolName)) return String(toolInput.pattern || toolInput.query || '');
  if (toolName === 'WebFetch') return String(toolInput.url || '');
  return '';
}

class AgentSession extends EventEmitter {
  constructor(sessionId, opts = {}) {
    super();
    this.sessionId = sessionId;                  // myco's session id
    this.mode = 'agent';
    this.alive = true;
    this.cwd = opts.cwd || process.cwd();
    // fr-26: session owner's login. Resolves the git author identity
    // (GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL etc.) injected into the SDK
    // env block below. Passed through by sessions.spawnSession +
    // ensureLiveSession from record.user. Optional — falls through to
    // no git env override when missing (default identity wins).
    this.user = opts.user || null;
    // Per-session active gateway PROFILE NAME (rec.activeGw, forwarded at
    // spawn/respawn), or null = the system .env gateway. Distinct from the
    // legacy per-user `active` in gateways.json: each session only uses a
    // profile the user explicitly opted into via `/model gw:<name>`.
    this.activeGw = opts.activeGw || null;
    // fr:model-gateway — the gateway profile name the CURRENT SDK
    // iteration was built with. base_url / auth_token are baked into
    // sdkOpts at iteration start and CANNOT change on a live streaming-
    // input query, so a `/model gw:` switch mid-iteration must make the
    // next .write() cold-start a fresh query (resume=sdkSessionId). The
    // .write() hot path compares this.activeGw against this and restarts
    // on mismatch ("切换模型没有及时生效" — the switch silently never applied
    // because the iteration lived on with the old gateway env).
    this._activeGwAtIteration = this.activeGw;
    // Set when a gateway switch is waiting for the live iteration to
    // drain; the idle hook then cold-starts a fresh iteration with the
    // new gwEnv (mirrors fr-86's _pendingRestart, but PRESERVES
    // sdkSessionId so the conversation resumes on the new gateway).
    this._pendingGwRestart = false;
    this.cols = opts.cols || 120;                // for resize compat (no-op semantically)
    this.rows = opts.rows || 30;

    // SDK session id captured from the first system/init event — used
    // to resume on subsequent turns so cache stays warm and context
    // persists across user messages. May be seeded by ensureLiveSession
    // when respawning an AgentSession after a server restart so the
    // SDK conversation picks up where the prior process left off.
    this.sdkSessionId = opts.resumeSdkSessionId || null;
    // fr-102: per-session model override. When set (string), passed to
    // the SDK as sdkOpts.model. Accepts an alias ('sonnet'/'opus'/'haiku')
    // or a full ID ('claude-sonnet-4-6'). null/undefined → SDK default.
    // Sourced from rec.modelOverride by sessions.spawnSession +
    // ensureLiveSession so the choice survives container restarts /
    // re-spawns. Mutated live by AgentSession.setModel() which also
    // calls Query.setModel on the in-flight stream (no respawn needed).
    this.modelOverride = opts.modelOverride || null;
    // delm-10: per-session skill selection (rec.enabledSkills). Array
    // of skill dir names → sdkOpts.skills pins the SDK's skill context
    // filter to exactly those. null/undefined → sdkOpts.skills 'all'
    // (no filter, pre-delm-10 behaviour). Mutated live by setSkills()
    // (skills toggle route); a mid-iteration change is applied on the
    // NEXT iteration because streaming-input options are frozen once
    // query() is invoked.
    this.enabledSkills = Array.isArray(opts.enabledSkills)
      ? opts.enabledSkills.slice() : null;
    // n=2 (TeamSession worker) extension: per-worker Delm board MCP server,
    // the worker's orchestration systemPrompt (prompts_n2.py STARTUP_A/B),
    // and its roster role ('worker-A' / 'worker-B'). All null/undefined for
    // a normal single-agent session → sdkOpts are byte-identical to n=1.
    this.workerRole = opts.workerRole || null;
    this.boardMcp = opts.boardMcp || null;
    this.systemPrompt = opts.systemPrompt || null;
    // RLM (agents/rlm): optional extra MCP servers for this session
    // (e.g. the rlm kernel server exposing mcp__rlm__rlm_eval). Merged
    // into sdkOpts.mcpServers at iteration build — same slot the lean-ctx
    // + myco + board servers use.
    this.mcpServers = opts.mcpServers || null;
    // MCP market (server/src/mcp/): catalog entry names installed in
    // this session (rec.installedMcp). Each installed entry contributes
    // (a) guidance SKILLs to the session skill store (installed by the
    // market route) and (b) real tools to the per-session `myco_mcp`
    // SDK MCP server built at iteration start. Empty array → no
    // server → sdkOpts byte-identical to pre-market behaviour.
    this.installedMcp = Array.isArray(opts.installedMcp) ? opts.installedMcp.slice() : [];
    // Research mode: knowledge bases mounted on this session (rec.knowledgeBases).
    // Empty by default → no KB MCP server, no injection, no write-back, and
    // sdkOpts stay byte-identical to a non-research session.
    this.knowledgeBases = Array.isArray(opts.knowledgeBases) ? opts.knowledgeBases.slice() : [];
    // RLM sub-agent spawn context (children.js): { parentSessionId,
    // depth, maxDepth }. Carried so the child's own kernel host_request
    // routing can enforce the recursion cap without re-deriving depth.
    this.rlmSpawn = opts.rlmSpawn || null;
    // Autonomous background lanes (/run-n2 + /compare shadow workers) set
    // this so their _preToolUseHook auto-approves EVERY tool — a background
    // team worker cannot wait on an interactive chat-pane permission prompt
    // (nobody answers it in a shadow lane, so the agent hangs forever). See
    // the _preToolUseHook gate below. Interactive single-agent sessions stay
    // false → unchanged per-tool prompting.
    this.autonomousPermission = !!opts.autonomousPermission;
    // Latest model + tool list reported by system/init; useful for the
    // attach-snapshot a freshly-connecting client should see.
    this._initSnapshot = null;
    // fr-102: handle to the in-flight SDK Query (set after query() returns
    // in _ensureIteration). Used by setModel() to call Query.setModel
    // for a live model switch (streaming-input mode, sdk.d.ts:2073).
    // Cleared to null when the iteration ends.
    this._currentQuery = null;
    // fr:model-gateway — last model value pushed to the SDK via
    // Query.setModel (live switch). Lets the gateway-profile model take
    // effect on an in-flight query without re-invoking setModel every
    // iteration with the same value. Distinct from modelOverride (that is
    // the per-session /model override; this is just an applied-marker).
    this._appliedModel = null;
    // bug-21 fix (parallel canUseTool fires): pendingMenus is a
    // Map<hash, menu> rather than a single slot. With parallel tool
    // calls the SDK fires canUseTool for BOTH tools before either is
    // resolved — a single slot would let menu B overwrite menu A
    // and orphan A's resolver promise (SDK deadlock). The Map keeps
    // each menu independently addressable until its specific hash is
    // resolved via resolveMenuPick.
    //
    // The `pendingMenu` getter below preserves the pre-bug-21
    // single-slot read shape (returns the most-recently-added menu)
    // so callers that just want "the latest active menu" keep working
    // without code changes. Bare-digit chat shortcut uses
    // oldestPendingMenu (FIFO head-of-queue) instead.
    this.pendingMenus = new Map();
    // Status / mode hooks for compatibility with attach-snapshot
    // plumbing. We populate _lastStatus minimally from result events.
    this._lastStatus = null;
    this._lastMode = 'default';
    // Tool-progress tracker mirrors PtySession.openToolCalls so the
    // chat pane's existing "waiting on Tool · 47s" indicator works
    // for agent sessions too.
    this.openToolCalls = new Map();

    // Per-session event ring buffer for reattach replay (phase 5
    // expands this with capped size + resume semantics). On spawn,
    // hydrated from <cwd>/_myco_/events.jsonl so chrome batches /
    // tool calls / claude assistant_text from a prior session
    // process survive container restart + the 5min keepalive reap.
    this.buffer = [];
    // fr-94 Phase 1: resolve _myco_/ via the shared helper so the
    // events.jsonl path honors rec.mainProject (the explicit project
    // root set at session creation) or falls back to legacy auto-
    // detect for pre-fr-94 sessions. Pre-fr-94 this hand-rolled
    // `path.join(this.cwd, '_myco_', ...)` and always wrote to
    // session-root — wrong on sessions whose actual project lives
    // in a subdirectory. Lookup is best-effort: if the rec isn't
    // available yet (e.g. spawn-time race) or resolves to null, fall
    // back to session-root so events still persist somewhere.
    let _mycoDir = null;
    try {
      const sessionsMod = require('./sessions');
      const { resolveMycoDir } = require('./artifacts');
      const rec = sessionsMod.getSessionRecord(sessionId);
      if (rec) _mycoDir = resolveMycoDir(rec);
    } catch (err) {
      console.error(`[fr-94] AgentSession could not resolve mycoDir for ${sessionId}: ${err.message}`);
    }
    // opts.eventsFile lets a TeamSession give each worker its own journal
    // (e.g. _myco_/events-workerA.jsonl) so n=2 workers don't interleave
    // lines into the single shared events.jsonl. Null for n=1 → default.
    this._eventsFileBase = opts.eventsFile || null;
    this._eventsFile = this._eventsFileBase
      || path.join(_mycoDir || path.join(this.cwd, '_myco_'), 'events.jsonl');
    this._eventAppendsSinceTrim = 0;
    this._hydrateBufferFromDisk();

    // Phase 4: streaming-input. Each .write() pushes a user message
    // into _msgQueue; the SDK reads from it as long as the iteration
    // is alive. _iterating tracks whether we're inside a query()'s
    // event loop. If aborted (.interrupt(), .kill()), the loop exits
    // and the next .write() spawns a fresh query() with resume=
    // sdkSessionId to continue the conversation.
    this._msgQueue = null;
    this._iterating = false;
    this._abortController = null;
    this._iterationDone = null;   // promise resolved when the current iteration ends
    // delm-10 stale-working-badge fix: wall-clock ms of the last terminal
    // agent event (turn_result / iteration_aborted / fatal) — i.e. the
    // moment "working" became "done". GET /sessions pairs this with the
    // record's agentSeenAt to compute the "to review" badge. Null until
    // the first terminal event of this process lifetime.
    this._lastDoneAt = null;
    // bug-40: the most-recent user turn delivered this iteration, kept so a
    // poisoned-resume recovery (resume-failure or thinking-block 400) can
    // redeliver it to the FRESH conversation — a fresh query() has no
    // transcript to replay it from. Cleared once a turn completes (result).
    this._lastUserEnvelope = null;

    // Phase 2: chat-pane menu integration. Each canUseTool fire stores
    // its resolve fn + the structured request here keyed by a hash; the
    // chat-pane menu pick (handleMenuPick in pty.js) reaches in via
    // resolveMenuPick(hash, n) to settle the pending promise so the
    // SDK iteration can continue with the user's choice.
    this._pendingPermissions = new Map();

    // Always emit a ready event so the browser's event-log pane has
    // something visible from the moment the WS attaches — otherwise a
    // fresh agent session looks dead until the user types something.
    // Lands in the per-session ring buffer so it replays on reconnect.
    setImmediate(() => {
      this._emit({
        type: 'session_ready',
        cwd: this.cwd,
        resumedFromSdkSessionId: this.sdkSessionId || null,
      });
      if (opts.initialPrompt) this.write(opts.initialPrompt);
    });
  }

  // Back-compat single-slot accessor — returns the most-recently-added
  // pending menu (Map preserves insertion order, so the last value is
  // newest). Read-only; writes must go through pendingMenus.set / .delete.
  // Used by slashcmds.handleDecide and any other consumer that just
  // wants "the latest live menu" without caring about parallel siblings.
  get pendingMenu() {
    let last = null;
    for (const m of this.pendingMenus.values()) last = m;
    return last;
  }

  // FIFO head-of-queue — the OLDEST pending menu. Used by the bare-
  // digit chat shortcut (attach.js handleChatPostfixes) when multiple
  // menus are pending so the user's "1" / "2" / "3" reply resolves the
  // first-asked menu rather than the most-recently-asked one. (Per-card
  // button clicks carry their own hash and remain unambiguous.)
  get oldestPendingMenu() {
    for (const m of this.pendingMenus.values()) return m;
    return null;
  }

  // Start (or restart, after an abort) the SDK iteration. One iteration
  // lives until either the user .kill()s us, .interrupt() is called, or
  // the SDK closes the stream. Multiple user messages (via .write())
  // share the same iteration via the streaming-input prompt.
  //
  // fr-43: wraps the SDK call in a retry loop. Recoverable errors
  // (rate-limit, transient network blips like ECONNRESET / ETIMEDOUT)
  // re-spawn query() with resume=sdkSessionId after exponential backoff.
  // Cap at MAX_ATTEMPTS = 3. AbortError (user-initiated Stop) ALWAYS
  // escapes the retry loop immediately. Non-recoverable errors (auth
  // failures, validation) fatal on the first attempt without retry.
  // delm-10 busy indicator: true while an SDK query iteration is
  // streaming (claude is actively working). GET /sessions surfaces
  // this as agentBusy so the sidebar can render a "working" badge.
  // _iterating is set true at the top of _ensureIteration and cleared
  // in its finally-drain (after turn_result lands) — the exact span
  // the user perceives as "this session is working".
  isBusy() {
    return !!this._iterating;
  }

  // team auto-close (2026-10-30): the most recent turn_result envelope
  // ({ subtype, result }) or null before the first turn ends. Read-only
  // consumer: TeamSession._autoCloseStaleClaim distinguishes success
  // turns (auto-close the claim) from failed ones (leave the claim).
  lastTurnResult() {
    return this._lastTurnResult ? Object.assign({}, this._lastTurnResult) : null;
  }

  async _ensureIteration() {
    if (!this.alive || this._iterating) return;
    this._iterating = true;

    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS = [1000, 4000, 16000];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (!this.alive) break;
      const lastAttempt = attempt === MAX_ATTEMPTS;

      // Fresh queue + controller per attempt — the prior attempt's
      // controller may have been aborted; the prior queue may have
      // been consumed by the dead stream.
      this._msgQueue = new AsyncMessageQueue();
      this._abortController = new AbortController();

      // Drain any pre-iteration writes into the fresh queue. Used by
      // .write() when no iteration was running yet, OR by interrupt's
      // restart path that needs to redeliver the in-flight user message.
      if (this._pendingPrePush && this._pendingPrePush.length) {
        for (const m of this._pendingPrePush) this._msgQueue.push(m);
        this._pendingPrePush = null;
      }

      // fr-26: git author identity for the session owner. Resolves
      // {name, email} from this.user → auth.profileByLogin →
      // git-identity.buildIdentity, then injects
      // GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL /
      // GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL into the SDK env
      // (top-level sdkOpts.env, alongside the lean-ctx mcpServer's
      // own CTX_PROJECT_ROOT + LEAN_CTX_AUTONOMY block). The SDK
      // forwards these to the claude-code child process, which means
      // every `git commit` the agent's Bash tool runs is attributed
      // to the user who spawned this session — including commits in
      // cloned subdirs, because env vars trump .git/config.
      // Returns null when the user has no githubId on file (caller
      // gates on truthy → skip the env override; git falls back to
      // .gitconfig or "Unknown <unknown@example.com>"). Failure to
      // resolve must NOT block session spawn — auth-sessions can be
      // empty in local dev, and we still want the agent to run.
      let gitEnv = null;
      try {
        if (this.user) {
          const auth = require('./auth');
          const { buildIdentity } = require('./git-identity');
          const profile = auth.profileByLogin(this.user);
          const id = profile ? buildIdentity(profile) : null;
          if (id) {
            gitEnv = {
              GIT_AUTHOR_NAME: id.name,
              GIT_AUTHOR_EMAIL: id.email,
              GIT_COMMITTER_NAME: id.name,
              GIT_COMMITTER_EMAIL: id.email,
            };
          }
        }
      } catch (err) {
        console.error(`[fr-26] git identity resolve failed for user=${this.user}: ${err.message}`);
      }

      // Per-user model-gateway override (user-set base_url / auth_token /
      // model profiles, saved via the Config → gateways UI). If the SESSION
      // actively opted into a profile via `/model gw:<name>`, overlay its
      // ANTHROPIC_* vars into the child env and prefer its model; otherwise
      // (this.activeGw is null) the system .env gateway flows through
      // process.env untouched. The choice is per-session (rec.activeGw →
      // this.activeGw, set at spawn/respawn + live by /model), read each
      // iteration so a switch takes effect on the NEXT turn.
      // Record which gateway this iteration was built with, so .write()
      // can detect a mid-iteration `/model gw:` switch and cold-start.
      this._activeGwAtIteration = this.activeGw;
      let gw = null;
      try {
        const gatewaysMod = require('./gateways');
        gw = (this.user && this.activeGw) ? gatewaysMod.getProfile(this.user, this.activeGw) : null;
      } catch (err) {
        console.error(`[agent-session] gateway resolve failed for user=${this.user} name=${this.activeGw}: ${err.message}`);
      }
      // Empty fields fall back to process.env (i.e. the system default from
      // state/.env) because we only overlay non-empty values here.
      const gwEnv = gw ? {
        ...(gw.baseUrl ? { ANTHROPIC_BASE_URL: gw.baseUrl } : {}),
        ...(gw.authToken ? { ANTHROPIC_AUTH_TOKEN: gw.authToken } : {}),
        ...(gw.model ? { ANTHROPIC_MODEL: gw.model } : {}),
      } : {};

      const sdkOpts = {
        cwd: this.cwd,
        permissionMode: 'default',
        // fr-26: top-level env passed to the spawned claude-code
        // child process. Inherits process.env first so the SDK still
        // sees ANTHROPIC_API_KEY / PATH / etc., then overlays
        // GIT_AUTHOR_* / GIT_COMMITTER_* when the session owner has a
        // resolvable GitHub identity (see gitEnv block above). The
        // user's active gateway profile (gwEnv) is overlaid before
        // gitEnv so it can point the child at a custom base_url /
        // auth_token / model. The stream-idle watchdog env overlays
        // last so an explicit operator override in $STATE_DIR/.env
        // (already in process.env here) can still win — except the
        // 10-min floor, which is enforced in streamIdleWatchdogEnv().
        env: { ...process.env, ...gwEnv, ...(gitEnv || {}), ...streamIdleWatchdogEnv() },
        // bug-14 round 2 (the 1c7ae4c WS-frame fix was correct but
        // insufficient): the SDK's documented option is `abortController`
        // (an AbortController instance), NOT `abortSignal` (an AbortSignal).
        // Pre-fix we passed `abortSignal: controller.signal`, which the
        // SDK silently ignored as an unknown field — so when
        // session.interrupt() called controller.abort(), nothing on the
        // SDK side was listening. The for-await loop stayed blocked
        // inside the SDK's tool execution until the tool finished
        // naturally (90s sleep ran to completion in the user's repro).
        // Verified against sdk.d.ts:1155-1160: `abortController?:
        // AbortController` is THE field name.
        abortController: this._abortController,
        canUseTool: (toolName, input, ctx) => this._canUseTool(toolName, input, ctx),
        // Phase 6: per-session allow-list as a PreToolUse hook. Runs BEFORE
        // canUseTool so matching rules auto-approve/auto-deny without
        // popping a chat-pane menu card. Falls through to canUseTool when
        // no rule matches.
        hooks: {
          PreToolUse: [{
            // matcher omitted ⇒ "all tools" — we always consult the
            // allow-list, then fall through if no match.
            hooks: [(input, toolUseID, ctx) => this._preToolUseHook(input, toolUseID, ctx)],
          }],
          // Research mode: auto-retrieve domain knowledge for each user
          // prompt and inject it as additionalContext. Registered only when
          // the session has mounted KBs, so non-research sessions keep the
          // exact hook set they had before.
          ...(this.knowledgeBases.length ? {
            UserPromptSubmit: [{
              hooks: [(input) => this._userPromptSubmitHook(input)],
            }],
          } : {}),
        },
        // Per-session memory + project settings: redirect the SDK's
        // auto-memory directory from the default $HOME/.claude/projects/
        // <sanitized-cwd>/memory/ into the session's own .claude/memory/.
        // Same for plansDirectory: ExitPlanMode plans land in the
        // session's .claude/plans/ instead of $HOME/.claude/plans/, so
        // each session's plan artifacts stay co-located with the
        // session's workspace. settingSources includes 'user' so the
        // SDK picks up auth credentials from $HOME/.claude/settings.json.
        // project + local remain so .claude/settings.json +
        // .claude/settings.local.json inside the session folder still
        // drive per-project config.
        settings: {
          autoMemoryEnabled: true,
          autoMemoryDirectory: path.join(this.cwd, '.claude', 'memory'),
          plansDirectory: path.join(this.cwd, '.claude', 'plans'),
        },
        settingSources: ['project', 'local', 'user'],
        // myco's own in-process MCP server exposes server-side tools
        // claude can call. Currently: mcp__myco__add_plan_items
        // appends items to plan.json. Per-session so the tool
        // handlers can scope mutations to THIS session via closure.
        //
        // fr-55: lean-ctx is a stdio MCP sidecar that compresses file
        // reads / shell output before they hit the LLM context (default
        // mode ~250× smaller than raw on a 60 KB JS file). The SDK
        // spawns one `lean-ctx mcp` process per session so each gets
        // its own cache + project-root scope. cwd=this.cwd anchors
        // relative paths the agent passes to ctx_read. If the binary
        // isn't on PATH (e.g. dev box without the Dockerfile install),
        // the SDK logs and continues — built-in Read/Bash still work,
        // so this fails OPEN, not closed.
        mcpServers: {
          myco: require('./myco-mcp').createMycoMcpServer(this.sessionId),
          'lean-ctx': {
            type: 'stdio',
            command: 'lean-ctx',
            args: ['mcp'],
            // bug-40: lean-ctx's autonomous "compaction-sync" (see its
            // src/server/compaction_sync.rs) rewrites the Anthropic
            // transcript JSONL under ~/.claude/projects/<cwd>/ when it
            // detects a compaction — shrinking the file (observed 59 MB →
            // 305 KB) and leaving <id>.jsonl.bak.<ts> backups. That
            // re-serialization changes the assistant messages byte-for-byte,
            // which breaks the immutability the Anthropic API enforces on
            // thinking / redacted_thinking blocks. The very next resume then
            // 400s: "thinking or redacted_thinking blocks in the latest
            // assistant message cannot be modified." (Prompts with special
            // chars — LaTeX backslashes, unicode — make the affected messages
            // re-serialize differently, which is why they correlate.)
            // LEAN_CTX_AUTONOMY=false disables the autonomous background
            // behaviors (incl. compaction-sync) while KEEPING the ctx_*
            // compression tools the agent uses for reads/shell/search.
            env: { ...process.env, CTX_PROJECT_ROOT: this.cwd, LEAN_CTX_AUTONOMY: 'false' },
          },
        },
      };
      // RLM kernel MCP server (agents/rlm): merged the same way as the
      // n2 board server — absent for non-RLM sessions, byte-identical.
      if (this.mcpServers) sdkOpts.mcpServers = { ...sdkOpts.mcpServers, ...this.mcpServers };
      // MCP market (server/src/mcp/): when this session has installed
      // market entries (rec.installedMcp), build the per-session
      // `myco_mcp` SDK MCP server exposing their catalog tools
      // (mcp__myco_mcp__<entry>_<tool>). No installs → createMarketMcpServer
      // returns null and sdkOpts stays untouched (byte-identical).
      if (Array.isArray(this.installedMcp) && this.installedMcp.length > 0) {
        const marketServer = require('./mcp/mcp-server').createMarketMcpServer(this.sessionId, this.installedMcp);
        if (marketServer) sdkOpts.mcpServers = { ...sdkOpts.mcpServers, myco_mcp: marketServer };
      }
      // Research mode: mount the knowledge-base MCP server. It is a thin
      // proxy to the standalone KB service (server/src/knowledge/client.js);
      // myco itself holds no index. No mounted KBs → no server → sdkOpts
      // byte-identical to a non-research session.
      if (Array.isArray(this.knowledgeBases) && this.knowledgeBases.length > 0) {
        const kbServer = require('./knowledge/mcp').createKbMcpServer(this.sessionId, this.knowledgeBases);
        if (kbServer) sdkOpts.mcpServers = { ...sdkOpts.mcpServers, myco_kb: kbServer };
      }
      if (this.sdkSessionId) sdkOpts.resume = this.sdkSessionId;
      // delm-10: skill selection. sdk.d.ts: `skills?: string[] | 'all'` —
      // the single place to turn skills on; the SDK adds the Skill tool
      // itself when this is set (adding 'Skill' to allowedTools is
      // deprecated). A selection (this.enabledSkills) pins the context
      // filter to exactly those skill names; null → 'all' so every
      // project skill stays visible (pre-delm-10 behaviour).
      sdkOpts.skills = (Array.isArray(this.enabledSkills) && this.enabledSkills.length > 0)
        ? this.enabledSkills.slice() : 'all';
      // c5 (harness2-integration §2): sub-agent surface. Load
      // <cwd>/.claude/agents/*.md into the SDK's `agents` option — the
      // one c1..c8 component this repo had no wiring for. `agents` was
      // already in SDK_OPTIONS_ALLOWLIST but never assigned, so project
      // sub-agent definitions were silently invisible to the SDK and the
      // Task tool only had its built-in general-purpose agent.
      //
      // Empty store (the common case) → sdkOpts.agents stays UNSET, so
      // sessions that ship no sub-agents are byte-identical to pre-c5.
      // loadAgents fails open: a malformed agent file is logged and
      // skipped, never fatal (a config typo must not block a session).
      const loadedAgents = require('./subagents').loadAgents(this.cwd);
      if (Object.keys(loadedAgents.agents).length > 0) {
        sdkOpts.agents = loadedAgents.agents;
        console.log(`[subagents] ${this.sessionId} loaded: ${require('./subagents').describeLoaded(loadedAgents)}`);
      }
      for (const s of loadedAgents.skipped) {
        console.error(`[subagents] ${this.sessionId} skipped ${s.file}: ${s.reason}`);
      }
      // c4 + c7 (harness2-integration §2): per-session tool guidance.
      // The guidance file (.claude/tool_guidance.md) is project steering —
      // "run this script first", "never touch that directory" — kept OUT of
      // CLAUDE.md on purpose: CLAUDE.md is the committed convention pack,
      // while guidance is per-turn runtime steering that a harness tuner
      // rewrites constantly. The c7 script listing is appended to the same
      // block so the agent knows what exists without having to `ls` for it.
      const toolGuidance = require('./tool-guidance');
      const harnessScripts = require('./harness-scripts');
      const loadedGuidance = toolGuidance.loadToolGuidance(this.cwd);
      const discoveredScripts = harnessScripts.listHarnessScripts(this.cwd).scripts;
      const guidanceParts = [];
      if (loadedGuidance.text) guidanceParts.push(loadedGuidance.text);
      const scriptsSection = harnessScripts.renderScriptsSection(discoveredScripts, this.cwd);
      if (scriptsSection) guidanceParts.push(scriptsSection);
      const guidanceBlock = guidanceParts.length
        ? toolGuidance.renderGuidanceBlock(guidanceParts.join('\n\n'), loadedGuidance.path || this.cwd)
        : null;
      if (guidanceBlock) {
        console.log(`[tool-guidance] ${this.sessionId} ${loadedGuidance.text ? 'guidance' : 'scripts only'}, ${discoveredScripts.length} script(s)`);
      }
      // c8 (harness2-integration §2): declarative hook tree from
      // .claude/hooks.json. Data, not code — see harness-hooks.js's header
      // for why loading executable hooks from a workspace would be an RCE
      // grant. Merged AFTER the built-in PreToolUse (allow/deny list)
      // matcher so a project rule can add to it but never disable it.
      const harnessHooks = require('./harness-hooks');
      const loadedHooks = harnessHooks.loadHooks(this.cwd);
      const projectHooks = harnessHooks.buildHooksOption(loadedHooks, this.cwd, this.sessionId);
      for (const [event, matchers] of Object.entries(projectHooks)) {
        sdkOpts.hooks[event] = (sdkOpts.hooks[event] || []).concat(matchers);
      }
      if (Object.keys(projectHooks).length > 0) {
        console.log(`[harness-hooks] ${this.sessionId} project hooks: ${Object.keys(projectHooks).join(',')}`);
      }
      for (const skip of loadedHooks.skipped) {
        console.error(`[harness-hooks] ${this.sessionId} skipped ${skip.where}: ${skip.reason}`);
      }
      // fr:model-gateway model resolution. The retired per-session /model
      // override is NOT honored (always purged to null; a stale value only
      // ever caused wrong-model requests). Priority:
      //   1. the ACTIVE gateway profile's `model` (per-user, gw computed
      //      above), else
      //   2. the SYSTEM default model from state/.env (ANTHROPIC_MODEL), so
      //      `default` uses the configured model (e.g. glmmoedsa) instead of
      //      the SDK's hardcoded default, else
      //   3. leave sdkOpts.model unset → the SDK picks its own default.
      if (gw && gw.model) sdkOpts.model = gw.model;
      else if (process.env.ANTHROPIC_MODEL) sdkOpts.model = process.env.ANTHROPIC_MODEL;
      // n=2 (TeamSession worker): attach the worker's per-actor Delm board
      // MCP server + orchestration systemPrompt (prompts_n2 STARTUP_A/B).
      // Null for a normal single-agent session → these lines are no-ops,
      // so n=1 behaviour is unchanged.
      if (this.boardMcp) sdkOpts.mcpServers = { ...sdkOpts.mcpServers, board: this.boardMcp };
      // c4: fold the tool-guidance block into the system prompt. Three
      // shapes matter (see tool-guidance.composeSystemPrompt): no guidance →
      // the option is left exactly as before; no existing prompt → the SDK's
      // claude_code preset with `append`, so Claude Code's built-in prompt
      // survives; an existing custom prompt (n=2 workers) → plain
      // concatenation. `undefined` back means "nothing to set".
      const composedPrompt = toolGuidance.composeSystemPrompt(
        this.systemPrompt || undefined, guidanceBlock);
      if (composedPrompt !== undefined) sdkOpts.systemPrompt = composedPrompt;

      // fr-45: lint sdkOpts keys against the SDK's documented Options
      // type. Logs (does not throw) on unknown keys — silent-typo
      // bugs like the bug-14 `abortSignal` vs `abortController`
      // mistake become visible in [sdkOpts] log lines + the
      // test/fr-45-sdkopts-lint regression catches them pre-deploy.
      this._validateSdkOpts(sdkOpts);

      let stream, initErr = null;
      try {
        stream = query({ prompt: this._msgQueue, options: sdkOpts });
        // fr-102: stash the Query handle so setModel() can call
        // Query.setModel on the live stream. Streaming-input mode is
        // required (we use AsyncMessageQueue, so we qualify). The
        // _currentQuery slot is cleared at iteration end so a stale
        // handle from a dead stream can't be invoked.
        this._currentQuery = stream;
        // fr:model-gateway — force the EFFECTIVE model (the /model session
        // override wins, else the user's active gateway profile model) onto
        // the just-created query. sdkOpts.model seeds a NEW query, but a
        // RESUMED conversation can keep its original init model; calling
        // Query.setModel here (after query() returns, when _currentQuery is
        // live) guarantees the switch even on resume. _appliedModel dedupes.
        // Effective model = active gateway profile's model, else the system
        // default ANTHROPIC_MODEL from state/.env (so `default` pushes the
        // configured model onto a resumed query, not the SDK default).
        const effModel = (gw && gw.model ? gw.model : undefined)
          || process.env.ANTHROPIC_MODEL || undefined;
        if (this._appliedModel !== effModel && typeof stream.setModel === 'function') {
          try {
            await stream.setModel(effModel || undefined);
            this._appliedModel = effModel;
            console.log(`[gateway] live setModel(${effModel || 'default'}) on session ${this.sessionId}`);
          } catch (err) {
            console.error(`[gateway] live setModel failed for ${this.sessionId}: ${err && err.message ? err.message : err}`);
            // Not fatal — the next query() carries sdkOpts.model regardless.
          }
        }
      } catch (err) {
        initErr = err;
      }

      if (initErr) {
        // fr-44: resume-failure fallback. If the SDK rejected our
        // resume=sdkSessionId because the upstream conversation is
        // gone (container restart wiped $HOME/.claude/projects/,
        // sessionId corrupted on disk, transcript file deleted under
        // us), clear sdkSessionId + retry once with a fresh session.
        // The `!!sdkOpts.resume` clause is itself the one-shot guard:
        // after clearing, the next iteration's `sdkOpts.resume = …`
        // line skips (this.sdkSessionId is null), so this branch
        // self-disables and we won't infinite-loop on repeated
        // resume-failure-flavored errors.
        // bug-40: a thinking-block-immutability 400 is also a poisoned
        // resume (the resumed transcript can't be re-sent), so it takes the
        // same fallback as fr-44's resume-failure: drop the resume + retry
        // fresh. _isThinkingBlockError is OR'd in here and on the stream
        // path below.
        if ((this._isResumeFailure(initErr) || this._isThinkingBlockError(initErr)) && !!sdkOpts.resume) {
          const prev = this.sdkSessionId;
          this._emit({
            type: 'resume_failed',
            reason: this._isThinkingBlockError(initErr) ? 'thinking_block_immutability' : 'resume_unavailable',
            prevSdkSessionId: prev,
            error: String((initErr && initErr.message) || initErr).slice(0, 200),
          });
          this.sdkSessionId = null;
          try {
            const sessionsMod = require('./sessions');
            const rec = sessionsMod.getSessionRecord && sessionsMod.getSessionRecord(this.sessionId);
            if (rec) {
              rec.sdkSessionId = null;
              sessionsMod.saveStore();
            }
          } catch (err) {
            console.error(`[agent-session] resume-fallback failed to clear rec.sdkSessionId: ${err.message}`);
          }
          // bug-40: a fresh query() has no transcript to replay the in-flight
          // user turn from, so re-stash it — the loop top drains
          // _pendingPrePush into the fresh queue at the next attempt.
          if (this._lastUserEnvelope) this._pendingPrePush = [this._lastUserEnvelope];
          // Don't count this against MAX_ATTEMPTS — the resume-failure
          // fallback is a free retry. Decrement the loop counter so
          // the next iteration is logically still attempt 1.
          attempt--;
          continue;
        }
        if (this._isRecoverable(initErr) && !lastAttempt) {
          await this._emitRetryAndWait(attempt, BACKOFF_MS, initErr);
          continue;
        }
        const isExhausted = lastAttempt && this._isRecoverable(initErr);
        this._emit({
          type: 'fatal',
          error: String((initErr && initErr.message) || initErr),
          ...(isExhausted ? { reason: 'retry_exhausted', attempts: attempt } : {}),
        });
        break;
      }

      this._emit({ type: 'iteration_start', resume: !!sdkOpts.resume, attempt });

      let streamErr = null;
      // fr-51 (third pass): track whether this iteration emitted any
      // terminal `agent-event` so the queue listener gets unblocked
      // even when the SDK never sends a `{type:'result'}` message.
      //   - killedMidStream: `kill()` flipped alive=false while a stream
      //     message was in flight; the loop breaks BEFORE AbortError
      //     propagates as a throw. Pre-fix the catch was bypassed, no
      //     terminal event fired, and any run-queue `running` entry
      //     stayed `running` forever — blocking every pending entry.
      //   - emittedTerminal: SDK closed the stream cleanly without ever
      //     sending a `result` message (rare but observed under server-
      //     side disconnect / mid-stream network blip). Same outcome.
      // Both new emits route through the existing attach.js terminal-
      // event listener, which already handles `iteration_aborted` (prior
      // fr-51 patch), so the queue marks finished + advances normally.
      let killedMidStream = false;
      let emittedTerminal = false;
      try {
        for await (const m of stream) {
          if (!this.alive) { killedMidStream = true; break; }
          this._handleEvent(m);
          if (m && m.type === 'result') emittedTerminal = true;
          // bug-40 r2: the SDK CLI sometimes catches the Anthropic 400
          // for a poisoned thinking-block resume and EMITS it as a normal
          // `result` event (subtype:'success', result:<error text>)
          // instead of throwing. Without intervention the stream closes
          // cleanly, recovery never runs, and the session stays wedged
          // — every following turn re-resumes the same poisoned
          // transcript and 400s identically. Detect the prose form here
          // and throw a synthetic so the existing
          // _isThinkingBlockError(streamErr) recovery branch (line ~505)
          // fires: drop sdkSessionId, redeliver, retry fresh.
          if (m && m.type === 'result' && this._isThinkingBlockErrorMessage(m.result)) {
            const detail = String(m.result || '').slice(0, 200);
            throw new Error(`thinking_block_immutability (prose-form result): ${detail}`);
          }
          // bug: symmetric resume-miss detection. When the SDK can't find
          // the resume= conversation ("Claude Code returned an error result:
          // No conversation found with session ID: <uuid>") it likewise EMITS
          // the failure as a normal `result` event (result:<error text>)
          // instead of throwing — so fr-44's thrown-streamErr recovery never
          // runs and the session stays wedged: every turn re-resumes the
          // same dead id and errors identically (seen after /run-n2 spawns
          // shadow workers sharing the workspace). Detect the prose form and
          // throw so the _isResumeFailure(streamErr) branch below drops the
          // resume, redelivers, and retries with a fresh conversation.
          if (m && m.type === 'result' && sdkOpts.resume && this._isResumeFailureMessage(m.result)) {
            const detail = String(m.result || '').slice(0, 200);
            throw new Error(`resume_unavailable (prose-form result): ${detail}`);
          }
        }
      } catch (err) {
        streamErr = err;
      }

      if (killedMidStream) {
        this._emit({ type: 'iteration_aborted', reason: 'kill_mid_stream' });
        break;
      }
      if (!streamErr) {
        // Stream ended cleanly. If it never emitted a `result`, the
        // run-queue listener has no terminal event to advance on —
        // emit iteration_aborted with a stable reason so the [runQueue-diag]
        // log can identify this path.
        if (!emittedTerminal) {
          this._emit({ type: 'iteration_aborted', reason: 'stream_closed_no_result' });
        }
        break;   // stream ended cleanly — done.
      }

      const isAbort = (streamErr && (streamErr.name === 'AbortError' || /aborted|abort/i.test(String(streamErr.message || ''))));
      if (isAbort) {
        this._emit({ type: 'iteration_aborted' });
        break;
      }

      // bug-40: a poisoned resume usually surfaces HERE, not at init — the
      // SDK returns a stream from query() immediately and only hits the
      // Anthropic API (which validates thinking-block immutability) once we
      // start consuming it, so the 400 throws out of the `for await` loop as
      // streamErr. Same recovery as the init path: drop the corrupted resume,
      // redeliver the in-flight user turn, and retry once with a fresh
      // conversation. The `!!sdkOpts.resume` guard is one-shot — after we
      // clear sdkSessionId the next attempt sets no resume=, so this branch
      // can't re-fire and loop. (resume-failure is folded in too, in case the
      // SDK ever surfaces it on the stream instead of at init.)
      if ((this._isResumeFailure(streamErr) || this._isThinkingBlockError(streamErr)) && !!sdkOpts.resume) {
        const prev = this.sdkSessionId;
        this._emit({
          type: 'resume_failed',
          reason: this._isThinkingBlockError(streamErr) ? 'thinking_block_immutability' : 'resume_unavailable',
          prevSdkSessionId: prev,
          error: String((streamErr && streamErr.message) || streamErr).slice(0, 200),
        });
        this.sdkSessionId = null;
        try {
          const sessionsMod = require('./sessions');
          const rec = sessionsMod.getSessionRecord && sessionsMod.getSessionRecord(this.sessionId);
          if (rec) {
            rec.sdkSessionId = null;
            sessionsMod.saveStore();
          }
        } catch (err) {
          console.error(`[agent-session] stream resume-fallback failed to clear rec.sdkSessionId: ${err.message}`);
        }
        if (this._lastUserEnvelope) this._pendingPrePush = [this._lastUserEnvelope];
        attempt--;
        continue;
      }

      if (this._isRecoverable(streamErr) && !lastAttempt) {
        await this._emitRetryAndWait(attempt, BACKOFF_MS, streamErr);
        continue;
      }

      const isExhausted = lastAttempt && this._isRecoverable(streamErr);
      this._emit({
        type: 'fatal',
        error: String((streamErr && streamErr.message) || streamErr),
        ...(isExhausted ? { reason: 'retry_exhausted', attempts: attempt } : {}),
      });
      break;
    }

    this._iterating = false;
    this._msgQueue = null;
    this._abortController = null;
    // fr-102: clear the Query handle so setModel() falls back to the
    // "between iterations" path (which mutates this.modelOverride for
    // the next iteration's sdkOpts.model). Calling setModel on a dead
    // stream would 400.
    this._currentQuery = null;
    if (this.alive) this.emit('idle');
    // fr-86: deferred-restart hook. If /clear new fired while a turn
    // was in flight, requestRestart() set this._pendingRestart=true
    // and returned a "restart pending" reply. Now that the iteration
    // is fully drained (turn_result has landed, openToolCalls is
    // empty), execute the actual restart: null sdkSessionId + broadcast
    // chat-pane-reset. Checked AFTER emit('idle') so attach.js's idle
    // listeners get a chance to settle first.
    if (this.alive && this._pendingRestart) {
      this._executeRestart();
    }
    // fr:model-gateway — deferred gateway-switch restart. The .write()
    // path stashed the next user envelope + tore down the old (old-
    // gateway) iteration when it saw this.activeGw ≠ _activeGwAtIteration.
    // Now that the iteration has fully drained, cold-start a fresh one so
    // the envelope is delivered against the NEW gateway env (resume=
    // sdkSessionId preserved — unlike _executeRestart, we do NOT null the
    // conversation). _ensureIteration re-reads this.activeGw when it
    // rebuilds gwEnv.
    if (this.alive && this._pendingGwRestart && this._pendingPrePush && this._pendingPrePush.length) {
      this._pendingGwRestart = false;
      console.log(`[gateway] ${this.sessionId} applying gateway switch (restart iteration with new env)`);
      this._ensureIteration();
    }
  }

  // fr-45: validate sdkOpts keys against the SDK_OPTIONS_ALLOWLIST.
  // Catches silent-typo bugs like bug-14 round 2 (`abortSignal` vs
  // `abortController`) — the SDK silently drops unknown keys, so
  // without this gate a typo lives until a user notices missing
  // behavior in production. Logs via console.error (loud enough to
  // catch in /loop scans + the `_myco_/logs/` capture) on every fire.
  // Does NOT throw — we'd rather have the SDK call proceed (with
  // some feature subtly broken) than crash the iteration outright.
  // The regression test surfaces typos pre-deploy.
  _validateSdkOpts(opts) {
    if (!opts || typeof opts !== 'object') return { ok: true, unknown: [] };
    const unknown = [];
    for (const k of Object.keys(opts)) {
      if (!SDK_OPTIONS_ALLOWLIST.has(k)) unknown.push(k);
    }
    if (unknown.length > 0) {
      console.error(`[sdkOpts] ${this.sessionId} UNKNOWN options (likely typos — SDK will silently drop these): ${unknown.join(', ')}`);
    }
    return { ok: unknown.length === 0, unknown };
  }

  // fr-44: classify an SDK error as "the resume= sessionId we passed
  // is no longer valid upstream." Conservative pattern set covering
  // the documented + observed phrases. The exact SDK wording isn't
  // formally specified, so new phrases observed in production should
  // be added here. When this returns true on the FIRST attempt with
  // sdkOpts.resume set, _ensureIteration clears sdkSessionId + retries
  // once with a fresh conversation (multica's resolveSessionID pattern).
  // bug: match the resume-miss wording on a PLAIN TEXT STRING so the
  // prose-form detection in the for-await loop (SDK surfaces the error as a
  // `result` event with `result:<error-text>` instead of throwing) can reuse
  // the exact same pattern — see bug-40 r2 for the analogous thinking-block
  // helper. "No conversation found with session ID: <uuid>" is the SDK's
  // real wording (ordered "no conversation found"; the older
  // "conversation not found" branch never matched it → hard fatal instead of
  // fr-44's clear-sdkSessionId-and-retry).
  _isResumeFailureMessage(text) {
    if (!text || typeof text !== 'string') return false;
    return /session not found|invalid session.?id|could not load conversation|conversation not found|no conversation found|no such session|session expired/i.test(text);
  }

  _isResumeFailure(err) {
    if (!err) return false;
    return this._isResumeFailureMessage(String((err && err.message) || ''));
  }

  // bug-40: classify the Anthropic API's thinking-block-immutability 400.
  // It fires when a resumed conversation re-sends a thinking /
  // redacted_thinking block that no longer matches the originally-signed
  // bytes — in this codebase that happens because lean-ctx's compaction-sync
  // rewrote the transcript JSONL out from under us (see the LEAN_CTX_AUTONOMY
  // note in _ensureIteration's mcpServers block). Once it fires, EVERY resume
  // reloads the same poisoned transcript and 400s identically, so the session
  // is permanently wedged unless we drop the resume. Treated as a
  // poisoned-resume alongside _isResumeFailure: clear sdkSessionId + retry
  // fresh. The prevention (LEAN_CTX_AUTONOMY=false) is the primary fix; this
  // is the defense-in-depth net for any transcript corruption that slips
  // through (a different tool, a future lean-ctx regression, manual edits).
  _isThinkingBlockError(err) {
    if (!err) return false;
    const msg = String((err && err.message) || '');
    return this._isThinkingBlockErrorMessage(msg);
  }

  // bug-40 r2 — the `claude` CLI subprocess sometimes CATCHES the API 400
  // and surfaces it as a normal `result` stream event (subtype:'success',
  // result:<error-text>) instead of throwing. Our existing
  // _isThinkingBlockError(err) only inspects thrown errors, so it never
  // fires on that path and the session stays wedged: every subsequent
  // turn re-resumes the same poisoned transcript and 400s identically,
  // never advancing recovery. This helper takes a plain text string so
  // the for-await loop can classify the prose-form error and route it
  // into the same recovery branch (by throwing a synthetic Error whose
  // message contains the matched text).
  _isThinkingBlockErrorMessage(text) {
    if (!text || typeof text !== 'string') return false;
    return /thinking or redacted_thinking blocks.*cannot be modified|must remain as they were in the original response/i.test(text);
  }

  // fr-43: classify an SDK error as retry-eligible. Conservative —
  // recognises network-level transient codes (ECONNRESET, ETIMEDOUT,
  // EAI_AGAIN, ENOTFOUND, EPIPE — both directly on `err.code` and
  // wrapped via `err.cause.code` per Node fetch's pattern) plus a
  // message-pattern fallback for rate-limit / 5xx-flavored / network /
  // timeout errors that don't carry a structured code. AbortError,
  // 4xx auth/validation errors, and model_error class failures are
  // NOT recoverable — retrying produces the same failure.
  _isRecoverable(err) {
    if (!err) return false;
    const code = err.code || (err.cause && err.cause.code);
    const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']);
    if (code && TRANSIENT_CODES.has(code)) return true;
    const msg = String((err && err.message) || '');
    if (/rate.?limit|too many requests|\b50[234]\b|fetch failed|network|timeout/i.test(msg)) return true;
    return false;
  }

  // fr-43: emit a retry_attempt event + sleep the backoff delay.
  // The event is observable by attached clients so the chat pane can
  // render "retrying (attempt 2/3)" UX in a future iteration. `attempt`
  // is the JUST-FAILED attempt; the next attempt # is attempt+1.
  async _emitRetryAndWait(attempt, backoffMs, err) {
    const baseMs = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)];
    const reason = /rate.?limit/i.test(String((err && err.message) || '')) ? 'rate_limit' : 'transient_error';
    this._emit({
      type: 'retry_attempt',
      attempt: attempt + 1,
      reason,
      retryAfterMs: baseMs,
      error: String((err && err.message) || err).slice(0, 200),
    });
    await new Promise((resolve) => setTimeout(resolve, baseMs));
  }

  // Abort the in-flight SDK iteration. Next .write() will start a fresh
  // query() with resume=sdkSessionId so the conversation continues from
  // where we left off (modulo any tool that was mid-execution when the
  // abort fired — claude code's hook/permission system handles partial
  // results gracefully).
  // fr-102: switch the session's model. Two paths:
  //   1. Live path — when an iteration is running (this._currentQuery
  //      is set) call Query.setModel on the live stream so the very
  //      next assistant turn uses the new model.
  //   2. Persistence path — always mutate this.modelOverride so the
  //      next iteration's sdkOpts.model picks up the new value (covers
  //      the "between iterations" case where there is no live Query).
  // Caller is responsible for persisting rec.modelOverride to disk.
  // modelId: alias ('sonnet'/'opus'/'haiku') or full ID; null/undefined
  // clears the override (reverts to the SDK default).
  async setModel(modelId) {
    const next = (modelId && String(modelId).trim()) || null;
    this.modelOverride = next;
    if (this._currentQuery && typeof this._currentQuery.setModel === 'function') {
      try {
        await this._currentQuery.setModel(next || undefined);
        console.log(`[fr-102] live setModel(${next || 'default'}) on session ${this.sessionId}`);
      } catch (err) {
        console.error(`[fr-102] live setModel failed for ${this.sessionId}: ${err && err.message ? err.message : err}`);
        // Don't rethrow — the next iteration will pick up
        // this.modelOverride via sdkOpts.model regardless.
      }
    } else {
      console.log(`[fr-102] queued setModel(${next || 'default'}) on session ${this.sessionId} (no live Query)`);
    }
  }

  interrupt() {
    if (!this.alive) return;
    if (this._abortController) {
      try { this._abortController.abort(); } catch {}
    }
    if (this._msgQueue) {
      try { this._msgQueue.close(); } catch {}
    }
    // Recovery for stuck-running runQueue entries (e.g. across container restarts):
    try {
      if (!this._activeRunItem) {
        const sessionsMod = require('./sessions');
        const runQueue = require('./runQueue');
        const rec = sessionsMod.getSessionRecord(this.sessionId);
        if (rec && Array.isArray(rec.runQueue)) {
          const running = rec.runQueue.find(e => e.status === 'running');
          if (running) {
            console.log(`[interrupt] auto-finishing stuck running queue item: ${running.itemId}`);
            runQueue.markFinished(rec, running.itemId, false); // marks failed + pauses queue
            sessionsMod.saveStore();
            this.emit('state-update', { kind: 'runQueue', state: runQueue.getQueueState(rec) });
          }
        }
      }
    } catch (err) {
      console.error('[interrupt] runQueue unstick failed:', err.message);
    }
  }

  // Normalise SDK events into the flatter shape the WS frame ships.
  // Two reasons: (1) the SDK's events are large structured objects with
  // nested content arrays — flattening here keeps every consumer simple;
  // (2) the field names become OUR contract instead of the SDK's, so
  // future SDK upgrades that rename fields are absorbed in one place.
  _handleEvent(m) {
    if (m.type === 'system' && m.subtype === 'init') {
      const newSdkId = m.session_id || (m.data && m.data.session_id) || this.sdkSessionId;
      if (newSdkId && newSdkId !== this.sdkSessionId) {
        this.sdkSessionId = newSdkId;
        // Persist on the rec so ensureLiveSession can resume the SDK
        // session after a server restart. Don't require sessionsMod
        // at the top of the file (would create a circular import via
        // pty.js); lazy-require here.
        try {
          const sessionsMod = require('./sessions');
          const rec = sessionsMod.getSessionRecord
            && sessionsMod.getSessionRecord(this.sessionId);
          if (rec) {
            rec.sdkSessionId = this.sdkSessionId;
            // Delm n=2: keep per-worker sessions too so a TeamSession can
            // resume each worker's transcript across a restart.
            if (this.workerRole) {
              if (!rec.sdkSessions) rec.sdkSessions = {};
              rec.sdkSessions[this.workerRole] = this.sdkSessionId;
            }
            sessionsMod.saveStore();
          }
        } catch (err) {
          console.error(`[agent-session] failed to persist sdkSessionId: ${err.message}`);
        }
      } else if (newSdkId) {
        this.sdkSessionId = newSdkId;
      }
      this._initSnapshot = {
        sdkSessionId: this.sdkSessionId,
        model: m.model || (m.data && m.data.model) || null,
        tools: m.tools || (m.data && m.data.tools) || [],
        cwd: this.cwd,
      };
      this._emit({ type: 'system_init', ...this._initSnapshot });
      return;
    }
    if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
      // Token-meter fix (2026-10-21): the SDK `result` message's
      // usage is CUMULATIVE across every API request the turn made
      // (~18 tool-iterations x a 200k context ≈ 3.6M), so using it
      // as "context-window fill" showed nonsense like "3.6M/200k".
      // Each `assistant` message carries `m.message.usage` — the
      // per-request usage of the LAST API call, whose
      // input_tokens + cache_read + cache_creation IS the current
      // context fill. Stash the latest one; the `result` branch
      // emits it as ctxFill on turn_result.
      if (m.message.usage) this._lastAssistantUsage = m.message.usage;
      for (const block of m.message.content) {
        if (block.type === 'text') {
          const txt = block.text || '';
          // fr-85 r4 r3: no per-site guard needed — _emit is now
          // gated centrally on this._pendingClarify (silent mode).
          // The emit call below is a no-op for clients during a
          // clarify; the persist call accumulates the text into the
          // pending replyText buffer, and the consolidated
          // clarify-reply fires from the result handler at turn end.
          this._emit({ type: 'assistant_text', text: txt });
          // Track per-turn accumulator so the `result` branch below
          // can dedup. Reset on turn_start; flushed on turn_result.
          this._currentTurnAssistantText = (this._currentTurnAssistantText || '') + txt;
          // bug-fix (2026-05-17): also persist into rec.chat (tagged
          // `meta.fromAgent:true`) as a durable backstop. See
          // _persistAssistantTextToRecChat for the full contract;
          // the short version is: agent-event card is the live
          // render channel, rec.chat is the forensic / paginated
          // history record, and the fromAgent rows are filtered out
          // of the default chat-history WS frame to avoid duplicate
          // renders on attach.
          this._persistAssistantTextToRecChat(txt);
          // td-33 (B — stage-aware critic): scan claude's assistant
          // text for stage-boundary sentinels emitted per the
          // critic.md / best-practices-template directive. When claude
          // says "[stage: analyze done]" / "[stage: code done]" /
          // "[stage: verify done]" mid-run, fire a `stage-done` event
          // on the session bus so attach.js can snapshot the diff +
          // trigger a mid-run checkpoint critique. Each stage is
          // emitted at most once per turn — duplicate sentinels in
          // the same text block (or in rapid sequence within a turn)
          // are deduped via this._firedStages.
          this._detectStageSentinels(txt);
        } else if (block.type === 'tool_use') {
          this.openToolCalls.set(block.id, {
            name: block.name,
            summary: _summariseToolInput(block.name, block.input),
            ts: new Date().toISOString(),
          });
          this._emit({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
          this._broadcastToolProgress();
        }
      }
      return;
    }
    if (m.type === 'user' && m.message && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (block.type === 'tool_result') {
          this.openToolCalls.delete(block.tool_use_id);
          const content = typeof block.content === 'string'
            ? block.content
            : (Array.isArray(block.content)
              ? block.content.map((c) => c.text || '').join('')
              : '');
          this._emit({
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content,
            isError: !!block.is_error,
          });
          this._broadcastToolProgress();
        }
      }
      return;
    }
    if (m.type === 'result') {
      this._lastStatus = null;  // SDK signals completion; no spinner equivalent
      // 2026-05-17 round 4: the SDK's `result` message carries `result:
      // string` — the final assistant reply. Sometimes (short single-turn
      // replies; cached fast-path responses) the reply ONLY ships here,
      // never as a separate `assistant` message with text blocks. Without
      // this branch the user sees claude's reply INSIDE the turn_result
      // chrome card body — never as a chat-msg bubble — and it doesn't
      // persist to rec.chat (so tab-switch loses it).
      //
      // Dedup contract: if the per-turn accumulator already contains
      // the result text (or extends it / is extended by it), the
      // assistant_text path already covered it — skip to avoid the
      // duplicate-render the user explicitly called out ("no duplicate
      // msg"). Otherwise emit + persist a fresh assistant_text bubble.
      const accumulated = (this._currentTurnAssistantText || '').trim();
      const resultText = String(m.result || '').trim();
      const subtype = m.subtype || '';
      // Only emit for success results (error subtype carries diagnostics,
      // not claude's reply, and would pollute the bubble stream).
      if (resultText && subtype === 'success' && !this._textCoversSubject(accumulated, resultText)) {
        // fr-85 r4 r3: no per-site guard needed — _emit is gated on
        // _pendingClarify centrally. During a clarify this is a no-op
        // for clients; the persist call accumulates into pending
        // replyText for the consolidated clarify-reply emit below.
        this._emit({ type: 'assistant_text', text: resultText });
        this._persistAssistantTextToRecChat(resultText);
      }
      // Reset the per-turn accumulator now that the turn is done so
      // the next turn starts clean.
      this._currentTurnAssistantText = '';
      // td-33 (B): clear the per-turn stage-fired set so the next turn
      // can re-fire any stage. (Within a single turn we dedup; across
      // turns it's a fresh slate — claude may re-do analyze/code/verify
      // as the conversation evolves and each pass deserves a critique.)
      this._firedStages = null;
      // bug-68: also clear the per-turn one-sentinel-only cap so the
      // next turn can fire a fresh stage. Same lifecycle as
      // _firedStages — both reset on turn_result, both restart on the
      // next assistant_text.
      this._firedStagesThisTurn = null;
      // bug-40: the turn produced a result, so the in-flight user message
      // was processed — drop it so a later recovery can't redeliver a turn
      // that's already been answered.
      this._lastUserEnvelope = null;
      // fr-85 r4 r3: flush the consolidated clarify-reply BEFORE
      // emitting turn_result. Two reasons for ordering: (a) we
      // want the popover to receive the answer atomically (one
      // WS frame with the full accumulated text), and (b) once
      // we clear _pendingClarify, the next _emit() (turn_result)
      // is no longer suppressed by the silent-mode gate — which
      // is what we want; the turn-ended chrome should reappear.
      if (this._pendingClarify) {
        try {
          this.emit('clarify-reply', {
            questionTs: this._pendingClarify.questionTs,
            // r7 r3: server-side truncation removed (user request) —
            // the prompt wrap in attach.js still asks for 2-3
            // sentences, but the reply is shipped in full so nothing
            // gets cut mid-thought.
            text: String(this._pendingClarify.replyText || '').trim(),
            ts: new Date().toISOString(),
          });
        } catch (err) {
          console.error(`[clarify-reply] ${this.sessionId} emit failed: ${err && err.message ? err.message : err}`);
        }
        this._pendingClarify = null;
      }
      // team auto-close (2026-10-30): stash the last turn_result so a
      // TeamSession idle handler can tell a SUCCESS turn from a failed
      // one when deciding whether to auto-close a stale board claim
      // (看板 ✓ vs stuck ◐). Read-only accessor below.
      this._lastTurnResult = { subtype: m.subtype, result: m.result };
      this._emit({
        type: 'turn_result',
        subtype: m.subtype,
        result: m.result,
        usage: m.usage,
        // ctxFill: the LAST API request's context-window fill
        // (input + cache_read + cache_creation tokens), not the
        // turn-cumulative usage above. See the assistant-branch
        // stash comment + _computeCtxFill for why the meter needs
        // this. Passes the cumulative result usage + numTurns so
        // the Huawei-gateway fallback (no per-request assistant
        // usage) can estimate average-request context instead of
        // shipping the impossible cumulative sum.
        ctxFill: this._computeCtxFill(m.usage, m.num_turns),
        totalCostUsd: m.total_cost_usd,
        durationMs: m.duration_ms,
        numTurns: m.num_turns,
      });
      // Research mode: mine this turn for reusable findings and write them
      // back to the mounted knowledge bases. Fire-and-forget — the turn is
      // already complete from the user's perspective, and a failed
      // extraction must never surface as an error in the conversation.
      if (this.knowledgeBases.length) {
        this._maybeWriteKnowledge(m).catch((err) => {
          console.error(`[kb-writer] ${this.sessionId} write-back failed: ${err.message}`);
        });
      }
      return;
    }
    if (m.type === 'rate_limit_event') {
      this._emit({ type: 'rate_limit', raw: m });
      return;
    }
    // bug-48: SDK `system` messages with task-lifecycle subtypes
    // (task_started / task_progress / task_notification) carry a
    // human-readable description + tool_use_id + task_id that the
    // client can fold into the chrome batch. Pre-bug-48 they fell
    // through to the unknown_event passthrough below — the client
    // short-circuited there with a console.warn, leaving the user
    // with no visible status for things like "Deploy 533fbfe to
    // mycodev" → "Copy archive to mycodev" → "completed".
    //
    // Promotion is narrowly scoped to the 3 documented subtypes so
    // future SDK system subtypes still surface via unknown_event
    // (= visible-to-devs warning). Per @kkrazy's plan-item comment:
    // "Should try to handle all event type to inform user the status,
    // but should make it as part of chrome batch to ensure ui cleaness."
    // — system_event is added to AGENT_CHROME_TYPES on the client.
    if (m.type === 'system' &&
        (m.subtype === 'task_started' ||
         m.subtype === 'task_progress' ||
         m.subtype === 'task_notification')) {
      this._emit({
        type: 'system_event',
        subtype: m.subtype,
        taskId: m.task_id,
        toolUseId: m.tool_use_id,
        description: m.description,
        status: m.status,
        raw: m,
      });
      return;
    }
    // Unknown event types — passthrough so phase 2+ can decide what to do.
    this._emit({ type: 'unknown_event', raw_type: m.type, raw: m });
  }

  // PreToolUse hook — consult this session's allow/deny list before
  // canUseTool fires. Used to be PtySession + menuMod's auto-respond
  // path; in agent mode the SDK does this for us via the hooks API.
  //
  // Returns one of:
  //   - permissionDecision='allow'  → SDK proceeds without canUseTool
  //   - permissionDecision='deny'   → SDK blocks + tells claude why
  //   - {} (pass-through)           → SDK continues to canUseTool
  //
  // The deny path also re-emits a chat note (parallel to the legacy
  // auto-respond message) so users still see WHY a tool was blocked.
  async _preToolUseHook(input /* HookInput */) {
    try {
      const toolName = input && input.tool_name;
      const toolInput = input && input.tool_input;
      const tool_use_id = input && input.tool_use_id;
      // Autonomous background lanes (/run-n2 + /compare shadow workers):
      // auto-allow EVERY tool so the team worker never blocks on an
      // unanswered chat-pane permission prompt. n=2's bash/write hang was a
      // Shadow-lane worker sitting on a canUseTool menu nobody clicks. Shadow
      // lanes operate on their own copy of the task in the session workspace,
      // so full autonomy is the intended (Delm-style) contract.
      if (this.autonomousPermission) {
        const reason = `autonomous ${this.workerRole || 'shadow'} worker — auto-allowed`;
        console.log(`[agent-hook] ${this.sessionId} PreToolUse=allow ${toolName} tool_use_id=${tool_use_id || '?'} (autonomous)`);
        this._emit({ type: 'hook_allow', toolName, tool_use_id, reason });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: reason,
          },
        };
      }
      // myco's own MCP tools (mcp__myco__*) are auto-allowed —
      // they're internal server-side mutations and the user
      // shouldn't see a permission prompt every time claude
      // appends a plan item via mcp__myco__add_plan_items.
      if (typeof toolName === 'string' && toolName.startsWith('mcp__myco__')) {
        const reason = `myco-internal MCP tool (${toolName})`;
        console.log(`[agent-hook] ${this.sessionId} PreToolUse=allow ${toolName} tool_use_id=${tool_use_id || '?'} (myco-internal)`);
        this._emit({ type: 'hook_allow', toolName, tool_use_id, reason });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: reason,
          },
        };
      }
      // MCP market tools (mcp__myco_mcp__*): auto-allowed — the user
      // explicitly installed the market entry that provides them, so
      // consent is already recorded at install time (the market UI
      // confirms before POST /mcp-market/install). Tool handlers run
      // server-side with the session's stored tokens.
      if (typeof toolName === 'string' && toolName.startsWith('mcp__myco_mcp__')) {
        const reason = `MCP market tool (${toolName})`;
        console.log(`[agent-hook] ${this.sessionId} PreToolUse=allow ${toolName} tool_use_id=${tool_use_id || '?'} (mcp-market)`);
        this._emit({ type: 'hook_allow', toolName, tool_use_id, reason });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: reason,
          },
        };
      }
      // Research mode: knowledge-base tools (mcp__myco_kb__*) are
      // read-mostly lookups against the team's own KB, plus `remember`
      // which only writes into the project's git-tracked _myco_/knowledge/.
      // Prompting for each search would make research mode unusable.
      if (this.knowledgeBases.length && require('./knowledge/hooks').isKbToolName(toolName)) {
        const reason = `knowledge base tool (${toolName})`;
        console.log(`[agent-hook] ${this.sessionId} PreToolUse=allow ${toolName} tool_use_id=${tool_use_id || '?'} (kb)`);
        this._emit({ type: 'hook_allow', toolName, tool_use_id, reason });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: reason,
          },
        };
      }
      // n=2: the Delm board MCP tools (mcp__board__*) are internal cross-
      // worker coordination — auto-allowed for the same reason as mcp__myco__.
      if (this.boardMcp && typeof toolName === 'string' && toolName.startsWith('mcp__board__')) {
        const reason = `board MCP tool (${toolName})`;
        this._emit({ type: 'hook_allow', toolName, tool_use_id, reason });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: reason,
          },
        };
      }
      // RLM kernel tools (mcp__rlm__*): auto-allowed — they're the
      // session's own persistent-namespace surface (rlm_eval etc.).
      // The kernel is NOT a sandbox (prompt says so): the code cells may
      // run Bash/Edit inside, and THOSE calls keep the normal permission
      // flow — only the rlm_eval dispatch itself is auto-allowed.
      if (typeof toolName === 'string' && toolName.startsWith('mcp__rlm__')) {
        const reason = `rlm kernel MCP tool (${toolName})`;
        this._emit({ type: 'hook_allow', toolName, tool_use_id, reason });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: reason,
          },
        };
      }
      // c7: running a script the project itself shipped under
      // .myco_harness/scripts/ is pre-approved. The matcher is strict (see
      // harness-scripts.isHarnessScriptInvocation): exact `python3
      // <discovered path>` with no shell metacharacters and no -c/-m, so this
      // cannot be used to smuggle a second command past the allow list.
      if (toolName === 'Bash') {
        try {
          const cmd = toolInput && toolInput.command;
          if (require('./harness-scripts').isHarnessScriptInvocation(cmd, this.cwd)) {
            const reason = `project harness script (${String(cmd).slice(0, 80)})`;
            console.log(`[agent-hook] ${this.sessionId} PreToolUse=allow ${toolName} tool_use_id=${tool_use_id || '?'} (harness-script)`);
            this._emit({ type: 'hook_allow', toolName, tool_use_id, reason });
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                permissionDecisionReason: reason,
              },
            };
          }
        } catch (e) {
          console.error(`[agent-hook] ${this.sessionId} harness-script check threw: ${e.message}`);
        }
      }
      const inputForMatching = _matchingInputFor(toolName, toolInput);
      // Lazy-require to dodge the pty.js → sessions.js → agent-session.js
      // import-cycle hazard.
      const sessionsMod = require('./sessions');
      const permissions = require('./permissions');
      const rec = sessionsMod.getSessionRecord
        && sessionsMod.getSessionRecord(this.sessionId);
      const decision = permissions.decide(rec, toolName, inputForMatching);

      if (decision === 'allow') {
        const reason = `myco session allow-list matched (${toolName}${inputForMatching ? '(' + inputForMatching.slice(0, 60) + ')' : ''})`;
        console.log(`[agent-hook] ${this.sessionId} PreToolUse=allow ${toolName} tool_use_id=${tool_use_id || '?'}`);
        this._emit({ type: 'hook_allow', toolName, tool_use_id, reason });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: reason,
          },
        };
      }
      if (decision === 'deny') {
        const reason = `myco session deny-list matched (${toolName}${inputForMatching ? '(' + inputForMatching.slice(0, 60) + ')' : ''})`;
        console.log(`[agent-hook] ${this.sessionId} PreToolUse=deny ${toolName} tool_use_id=${tool_use_id || '?'}`);
        this._emit({ type: 'hook_deny', toolName, tool_use_id, reason });
        // Mirror the legacy menuMod.autoRespondToMenu chat note so the
        // user knows WHY their session's deny rule fired.
        // chat-print-persistence fix (2026-11-04): also appendChatMessage
        // so the note survives refresh / reconnect (emit alone vanished).
        try {
          const ASSISTANT = 'claude';
          const txt = `🚫 auto-denied \`${toolName}(${inputForMatching || ''})\` (matched session deny list). Run \`/deny\` / \`/allow\` to mutate.`;
          const msg = { user: ASSISTANT, text: txt, ts: new Date().toISOString(), meta: { kind: 'menu-auto', verb: 'deny', toolName } };
          const sessionsMod = require('./sessions');
          if (sessionsMod.appendChatMessage) sessionsMod.appendChatMessage(this.sessionId, msg);
          this.emit('chat', msg);
        } catch {}
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        };
      }
      // 'ask' / unknown → no opinion; canUseTool will handle it.
      return {};
    } catch (err) {
      console.error(`[agent-hook] ${this.sessionId} PreToolUse threw: ${err.message}`);
      return {};
    }
  }

  // Synthesize a chat-pane menu from a canUseTool fire, broadcast it via
  // the existing 'menu' event pipeline (so menuMod.handleSessionMenu →
  // broadcastMenuToChat fires unchanged), and return a Promise that
  // resolves when the user clicks an option in the chat pane (the click
  // arrives via WS as menu-pick → pty.handleMenuPick → this session's
  // resolveMenuPick(hash, n)).
  //
  // Two flavours:
  //
  //   1. AskUserQuestion — Claude has clarifying questions for the user.
  //      input.questions[0] becomes the menu; multi-question packs are
  //      collapsed to question[0] for now (phase 3 wizard support TBD).
  //
  //   2. Any other tool — Claude wants permission to run it. We render
  //      a 3-option permission menu: [Allow once] [Allow always] [Deny].
  //      Option 2 echoes ctx.suggestions back as updatedPermissions so a
  //      .claude/settings.local.json rule lands.
  _canUseTool(toolName, input, ctx) {
    const toolUseID = (ctx && ctx.toolUseID) || ('synth-' + crypto.randomBytes(6).toString('hex'));
    const hash = 'agent-' + toolUseID;

    if (toolName === 'AskUserQuestion') {
      return this._handleAskUserQuestion(input, hash, toolUseID);
    }
    return this._handlePermissionRequest(toolName, input, ctx, hash, toolUseID);
  }

  _handleAskUserQuestion(input, hash, toolUseID) {
    const questions = Array.isArray(input && input.questions) ? input.questions : [];
    if (!questions.length) {
      // No questions to display — auto-allow with empty answers so the
      // SDK doesn't hang.
      return Promise.resolve({ behavior: 'allow', updatedInput: { questions, answers: {} } });
    }
    // Multi-question AskUserQuestion: ask sequentially. Phase 2 used to
    // broadcast only the first question and resolve the SDK promise with
    // a single-entry answers map — claude then proceeded with partial
    // input, often immediately re-issuing AskUserQuestion in a slightly
    // different shape and stranding the user mid-flow. Now each question
    // gets its own sub-hash (agent-toolUseID-q<i>) and its own modal
    // pop; resolving the LAST one assembles the full answers map and
    // settles the SDK promise.
    if (questions.length > 1) {
      console.log(`[agent-menu] ${this.sessionId} AskUserQuestion with ${questions.length} questions — asking sequentially`);
    }
    return new Promise((resolve) => {
      const shared = {
        toolUseID,
        questions,
        answers: {},
        askedIdx: 0,
        resolve,
      };
      this._askNextSubQuestion(shared);
    });
  }

  _askNextSubQuestion(shared) {
    const i = shared.askedIdx;
    const q = shared.questions[i] || {};
    const opts = Array.isArray(q.options) ? q.options : [];
    const isMulti = !!q.multiSelect;
    // Sub-hash distinguishes each question in a multi-question call so
    // the chat row + modal queue can track them separately. Single-
    // question calls still get a -q0 suffix; consumers should treat the
    // hash as opaque.
    const subHash = `agent-${shared.toolUseID}-q${i}`;
    // For multi-select, mark each option as a checkbox so the modal
    // renders toggle buttons + a Submit row. The .checked state is
    // mutated in place by the toggle handler so the chat row can
    // reflect the current selection set.
    const menuOpts = opts.map((o, k) => ({
      n: k + 1,
      label: String(o.label || ''),
      description: o.description || '',
      ...(isMulti ? { checkbox: true, checked: false } : {}),
    }));
    // bug-41: auto-append TWO synthetic options to every AskUserQuestion
    // menu — Other (free-text escape hatch) and Cancel. They satisfy the
    // SDK's promise to the model ("Users will always be able to select
    // 'Other' to provide custom text input") and give the user an
    // explicit way out when no presented option fits. Tagged with
    // `synthetic` so resolveMenuPick routes them to the freeText / deny
    // branches instead of feeding their labels back into
    // updatedInput.answers (which would surprise the model — it never
    // declared these options).
    //
    // Non-checkboxes even in multi-select mode: picking Other or Cancel
    // mid-selection short-circuits and resolves immediately rather than
    // toggling. That matches the user's intent ("get me out").
    menuOpts.push({
      n: menuOpts.length + 1,
      label: 'Other — type a custom answer',
      description: 'Pick this to type your own answer in the chat input below.',
      synthetic: 'freeText',
    });
    menuOpts.push({
      n: menuOpts.length + 1,
      label: 'Cancel',
      description: 'Cancel this question. Claude will pick a different approach.',
      synthetic: 'cancel',
    });
    const menu = {
      kind: 'plan',
      question: q.question || '',
      options: menuOpts,
      hash: subHash,
      multi: isMulti,
      // Sub-question pager hints — surfaced in chat row + modal pager.
      subQuestionIdx: i,
      subQuestionTotal: shared.questions.length,
    };
    this._pendingPermissions.set(subHash, {
      kind: 'ask',
      toolUseID: shared.toolUseID,
      questionIdx: i,
      shared,
      // Live reference to the options array — toggle handlers mutate
      // options[k].checked in place; submit gathers the final set.
      options: menuOpts,
      multi: isMulti,
    });
    this._emit({
      type: 'permission_request',
      toolName: 'AskUserQuestion',
      hash: subHash,
      toolUseID: shared.toolUseID,
      question: menu.question,
      optionCount: menu.options.length,
      subQuestionIdx: i,
      subQuestionTotal: shared.questions.length,
      multi: isMulti,
    });
    // bug-21: store in Map<hash, menu> so a second canUseTool fire (from
    // a parallel tool call) doesn't overwrite this one. resolveMenuPick /
    // resolveMenuSubmit delete the specific hash on settle.
    this.pendingMenus.set(subHash, menu);
    this.emit('menu', menu);
  }

  // delm-10: update the per-session skill selection. Called by the
  // skills toggle route (index.js _applySkillsToLiveSession) after
  // rec.enabledSkills is persisted — the record stays the single
  // source of truth; this only refreshes the live cache the next
  // _ensureIteration reads when building sdkOpts.skills.
  // No-op semantics on an in-flight iteration: streaming-input query
  // options are frozen at query() time, so the change takes effect on
  // the next turn (same liveness model as a model-override between
  // iterations).
  setSkills(names) {
    this.enabledSkills = Array.isArray(names) ? names.slice() : null;
    const applied = this.enabledSkills ? this.enabledSkills.join(', ') : '(all skills)';
    console.log(`[skills] ${this.sessionId} selection updated → ${applied}${this._iterating ? ' (applies next turn)' : ''}`);
    return { ok: true, enabledSkills: this.enabledSkills ? this.enabledSkills.slice() : null };
  }

  // MCP market: update the installed-entry list from the market
  // routes (install/uninstall). Same liveness model as setSkills —
  // streaming-input options are frozen at query() time, so the change
  // lands on the NEXT iteration. The rec is the source of truth; this
  // live cache only shapes the next _ensureIteration's mcpServers.
  setInstalledMcp(names) {
    this.installedMcp = Array.isArray(names) ? names.slice() : [];
    const applied = this.installedMcp.join(', ') || '(none)';
    console.log(`[mcp-market] ${this.sessionId} installed MCP entries → ${applied}${this._iterating ? ' (applies next turn)' : ''}`);
    return { ok: true, installedMcp: this.installedMcp.slice() };
  }

  // RLM hot toggle (2026-11-11: "/rlm on 后 RLM 很少被触发"). Arm/disarm
  // the RLM engine IN PLACE on a live session — the same liveness model
  // as setSkills/setInstalledMcp: systemPrompt + mcpServers are read at
  // every _ensureIteration, so the switch lands on the NEXT turn without
  // killing the session object. Attached WS clients, lane bridges
  // (/run-n2, /compare, /rlm <task>) and the run queue all hold THIS
  // object — killing it would deafen every attached client until they
  // reconnect, which is why the toggle is in-place instead of kill+respawn.
  //
  // rlm=true  (arm):
  //   - compose the RLM contract prompt (rlmPrompt() + Continual-Harness
  //     additions) as this.systemPrompt;
  //   - wire the per-session rlm kernel MCP server (mcp__rlm__rlm_eval)
  //     onto this.mcpServers (agents/rlm rlmKernelManager, lazy child);
  //   - stamp mode='rlm' (sidebar badge + lane UI read it);
  //   - inject ONE nudge turn so the model opens by reading kernel
  //     `state` instead of ignoring the new tools (usage-report fix:
  //     the engine change alone wasn't enough, the model needs an
  //     explicit first prompt).
  //
  // rlm=false (disarm): restore the pre-arm systemPrompt + mode, drop
  // the rlm MCP server key. The kernel child (if any) stays for its
  // remaining consumers — shutdownRlmKernel owns its lifecycle.
  //
  // Idempotent: arm-when-armed / disarm-when-plain are no-ops, so a
  // double toggle or a respawn race can't stack prompts or servers.
  setRlmMode(rlm, rec) {
    const want = rlm === true;
    if (this._rlmApplied === want) {
      console.log(`[rlm-hot] ${this.sessionId} setRlmMode(${want}) no-op (already ${want ? 'armed' : 'plain'})`);
      return { ok: true, kind: 'no-op', rlm: want };
    }
    if (want) {
      const rlmMod = require('./agents/rlm');
      const mcp = require('./agents/rlm/mcp');
      const { rlmPrompt } = require('./agents/rlm/prompt');
      const harness = require('./agents/rlm/harness');
      this._preRlmSystemPrompt = this.systemPrompt;
      this._preRlmMode = this.mode || 'agent';
      const harnessKey = (rec && rec.harnessKey) || null;
      const harnessSection = harness.composeHarnessSection(
        this.cwd, harnessKey || this.sessionId);
      this.systemPrompt = rlmPrompt() + harnessSection;
      const manager = rlmMod.rlmKernelManager(this.sessionId, {
        cwd: this.cwd,
        harnessKey,
      });
      this.mcpServers = Object.assign({}, this.mcpServers, {
        rlm: mcp.createServer({ manager, sessionId: this.sessionId }),
      });
      this.mode = 'rlm';
      this._rlmApplied = true;
      console.log(`[rlm-hot] ${this.sessionId} ARMED in-place (next turn runs the RLM kernel engine)`);
      // First-turn nudge: without an explicit opener the model routinely
      // ignores the newly-available rlm_eval tool and keeps answering from
      // the transcript — the "RLM 很少被触发" symptom. One short turn that
      // forces a state read breaks the inertia. Skipped when a turn is
      // already in flight (the queued user message becomes the opener).
      if (!this._iterating) {
        this.write(rlmMod.RLM_FIRST_TURN_NUDGE);
        console.log(`[rlm-hot] ${this.sessionId} first-turn nudge dispatched`);
      }
    } else {
      this.systemPrompt = this._preRlmSystemPrompt !== undefined
        ? this._preRlmSystemPrompt : null;
      this.mode = this._preRlmMode || 'agent';
      if (this.mcpServers) {
        const next = Object.assign({}, this.mcpServers);
        delete next.rlm;
        this.mcpServers = Object.keys(next).length ? next : null;
      }
      this._rlmApplied = false;
      console.log(`[rlm-hot] ${this.sessionId} DISARMED in-place (next turn runs the plain engine)`);
    }
    return { ok: true, kind: 'applied', rlm: want };
  }
  // Research mode: update the mounted knowledge bases from the /kb and
  // /research routes. Same liveness model as setInstalledMcp — SDK options
  // are frozen at query() time, so the change lands on the next iteration.
  setKnowledgeBases(names) {
    this.knowledgeBases = Array.isArray(names) ? names.slice() : [];
    const applied = this.knowledgeBases.join(', ') || '(none)';
    console.log(`[kb] ${this.sessionId} knowledge bases → ${applied}${this._iterating ? ' (applies next turn)' : ''}`);
    return { ok: true, knowledgeBases: this.knowledgeBases.slice() };
  }

  // UserPromptSubmit hook — research mode only. The body lives in
  // server/src/knowledge/hooks.js; this method is the SDK-facing shim.
  async _userPromptSubmitHook(input) {
    return require('./knowledge/hooks').userPromptSubmitHook(this, input);
  }

  // Turn-end knowledge write-back (research mode only). The body lives in
  // server/src/knowledge/hooks.js; this method is the call site.
  async _maybeWriteKnowledge(m) {
    return require('./knowledge/hooks').maybeWriteKnowledge(this, m);
  }

  // Multi-select toggle for AskUserQuestion. Flips the n-th option's
  // .checked state. Idempotent on the hash → no resolve, no SDK
  // unblock — the user keeps composing until they hit Submit.
  // fr-86: soft-reset the SDK conversation (keep chat history, drop
  // working memory). Called by /clear new (slashcmds.js handleClear)
  // under an owner+admin gate.
  //
  // Branches on this._iterating:
  //   - Idle  → execute immediately: null sdkSessionId via sessions
  //             helper, broadcast state-update chat-pane-reset so every
  //             attached client wipes its visible chat pane. Returns
  //             { kind: 'executed', message } so the slashcmd handler
  //             can reply with the success text.
  //   - Busy  → defer: set this._pendingRestart=true; the iteration's
  //             emit('idle') post-condition fires the actual restart
  //             once the in-flight tool/turn finishes. Returns
  //             { kind: 'pending', message } describing what we're
  //             waiting on so the user knows their command was queued.
  //
  // The waiting message NAMES the current tool when available (e.g.
  // "Bash(npm test)"), or falls back to "current turn" when openToolCalls
  // is empty (e.g., the SDK is mid-thinking-block with no tool_use yet).
  requestRestart() {
    // Idempotency: a second /clear new while one is already pending
    // shouldn't queue another or double-emit. Just reply that one is
    // already in flight.
    if (this._pendingRestart) {
      return {
        kind: 'pending',
        message: '🔄 restart already pending — still waiting for the current turn to finish',
      };
    }
    if (this._iterating) {
      this._pendingRestart = true;
      // Pick the first open tool call's name as the "current task"
      // hint. Maps to "Bash(npm test)" / "Read(/path)" via the existing
      // _summariseToolInput helper used by the tool-progress broadcast.
      let currentTask = 'current turn';
      for (const tc of this.openToolCalls.values()) {
        currentTask = tc.summary ? `${tc.name}(${tc.summary})` : tc.name;
        break;
      }
      this._emit({ type: 'restart_pending', currentTask });
      return {
        kind: 'pending',
        message: `🔄 restart pending — waiting for ${currentTask} to finish`,
      };
    }
    // Idle path: execute now.
    this._executeRestart();
    return {
      kind: 'executed',
      message: '✓ session restarted by @USER. Earlier history preserved — scroll up to load it. Claude starts fresh.',
    };
  }

  // fr-86: actual state mutation + broadcast. Called either directly
  // from requestRestart (idle path) or from the emit('idle') hook
  // (busy path completion).
  _executeRestart() {
    this._pendingRestart = false;
    try {
      const sessionsMod = require('./sessions');
      sessionsMod.markSessionForRestart(this.sessionId);
    } catch (err) {
      console.error(`[fr-86] markSessionForRestart failed for ${this.sessionId}: ${err.message}`);
    }
    // Local copy must also be nulled — _ensureIteration reads
    // this.sdkSessionId, not the on-disk record, when deciding whether
    // to pass `resume: sdkSessionId` to the SDK query().
    this.sdkSessionId = null;
    this._emit({ type: 'restart_executed' });
    // Wipe the visible chat pane on every attached client. NOT
    // chat-clear — that kind implies the server also wiped rec.chat,
    // which we explicitly did NOT do.
    try { this.emit('state-update', { kind: 'chat-pane-reset' }); } catch {}
  }

  resolveMenuToggle(hash, n) {
    const pending = this._pendingPermissions.get(hash);
    if (!pending || !pending.multi || !Array.isArray(pending.options)) return false;
    const opt = pending.options.find((o) => o.n === n);
    if (!opt || !opt.checkbox) return false;
    opt.checked = !opt.checked;
    console.log(`[agent-menu] ${this.sessionId} toggle hash=${hash.slice(-12)} n=${n} → ${opt.checked ? 'checked' : 'unchecked'}`);
    return true;
  }

  // Multi-select submit for AskUserQuestion. Gathers every .checked
  // option, joins their labels with ", " (the SDK's documented multi-
  // select answer format), and settles the SDK promise. If no options
  // were checked, the answer is the empty string — caller's choice
  // for the model to interpret as "I didn't pick anything."
  resolveMenuSubmit(hash) {
    const pending = this._pendingPermissions.get(hash);
    if (!pending || pending.kind !== 'ask' || !pending.multi || !pending.shared) return false;
    this._pendingPermissions.delete(hash);
    // bug-21: delete THIS hash from the pending-menu Map, not the whole
    // slot — sibling parallel menus stay live.
    this.pendingMenus.delete(hash);
    const shared = pending.shared;
    const i = pending.questionIdx;
    const q = shared.questions[i] || {};
    const picked = pending.options.filter((o) => o.checked).map((o) => o.label);
    const joined = picked.join(', ');
    shared.answers[q.question || ''] = joined;
    this._emit({
      type: 'permission_resolved',
      toolName: 'AskUserQuestion',
      hash,
      multi: true,
      pickedLabels: picked,
      pickedJoined: joined,
      subQuestionIdx: i,
      subQuestionTotal: shared.questions.length,
    });
    console.log(`[agent-menu] ${this.sessionId} submit hash=${hash.slice(-12)} answered="${joined}"`);
    shared.askedIdx = i + 1;
    if (shared.askedIdx < shared.questions.length) {
      this._askNextSubQuestion(shared);
      return true;
    }
    shared.resolve({
      behavior: 'allow',
      updatedInput: { questions: shared.questions, answers: shared.answers },
    });
    return true;
  }

  _handlePermissionRequest(toolName, input, ctx, hash, toolUseID) {
    const summary = _summariseToolInput(toolName, input);
    return new Promise((resolve) => {
      const menu = {
        kind: 'permission',
        question: `Allow ${toolName}${summary ? ': ' + summary : ''}?`,
        options: [
          { n: 1, label: 'Allow once', description: 'Run this single call.' },
          { n: 2, label: 'Allow always', description: 'Auto-approve matching calls in this project.' },
          { n: 3, label: 'Deny',         description: 'Block this call; Claude will choose a different approach.' },
        ],
        hash,
        // Structured target — what menuMod.handleSessionMenu feeds to
        // permissions.decide(). Pre-Phase-9 menus were PTY-scraped and
        // had to be regex-parsed to recover (tool, input); agent-mode
        // already has both structured, so we attach them directly and
        // skip the rawText round-trip entirely.
        target: { tool: toolName, input: _matchingInputFor(toolName, input) },
      };
      this._pendingPermissions.set(hash, {
        kind: 'permission',
        toolUseID,
        toolName,
        input,
        suggestions: (ctx && Array.isArray(ctx.suggestions)) ? ctx.suggestions : [],
        resolve,
      });
      this._emit({
        type: 'permission_request',
        toolName,
        hash,
        toolUseID,
        summary,
      });
      // Mirror onto the PtySession-shaped surface so the bare-digit chat
      // shortcut (pty.handleChatPostfixes → resolveMenuPick) can find
      // this menu. _handleAskUserQuestion does the same; this branch
      // missing it was the cause of the 2026-05-15 "I sent 1, still
      // stuck" incident — the chat-pane menu card was clickable, but
      // typing the digit silently queued as a user message instead of
      // resolving the canUseTool promise.
      //
      // bug-21: Map<hash, menu> so parallel canUseTool fires don't
      // overwrite each other. The bare-digit shortcut reads
      // oldestPendingMenu (FIFO head-of-queue) when multiple are
      // pending; per-card button clicks always carry the hash so they
      // remain unambiguous regardless of pending-count.
      this.pendingMenus.set(hash, menu);
      this.emit('menu', menu);
    });
  }

  // Called by pty.handleMenuPick when the user clicks an option in the
  // chat pane (or via /decide N). Resolves the corresponding canUseTool
  // promise with the SDK-shaped response.
  resolveMenuPick(hash, n) {
    const pending = this._pendingPermissions.get(hash);
    if (!pending) {
      console.log(`[agent-menu] ${this.sessionId} pick for unknown hash ${hash.slice(-12)} — ignoring`);
      return false;
    }
    this._pendingPermissions.delete(hash);
    // bug-21: delete THIS hash only — sibling parallel menus stay live in
    // the Map (their own resolveMenuPick will clear them individually).
    this.pendingMenus.delete(hash);

    if (pending.kind === 'ask') {
      const shared = pending.shared;
      const i = pending.questionIdx;
      const q = (shared && shared.questions && shared.questions[i]) || null;
      const opts = (q && q.options) || [];
      // bug-41: check the RENDERED menu first (pending.options) to
      // detect synthetic Other / Cancel picks — those n values live
      // beyond opts.length and would otherwise fall through to the
      // "invalid option" path. The synthetic flag rides on the rendered
      // option so we can branch without changing q.options (the SDK
      // would choke on options it never declared).
      const rendered = (pending.options || []).find((o) => o.n === n);
      if (rendered && rendered.synthetic === 'cancel') {
        // User wants out. Resolve the SDK canUseTool Promise with deny
        // so the model sees the cancellation and decides how to
        // proceed (typically: ask in plain prose or switch tack).
        // Stop the whole multi-question pack here — once the user
        // cancels one sub-question, asking the rest would be hostile.
        this._emit({
          type: 'permission_resolved',
          toolName: 'AskUserQuestion',
          hash,
          pickedN: n,
          decision: 'cancel',
          subQuestionIdx: i,
          subQuestionTotal: shared.questions.length,
        });
        shared.resolve({
          behavior: 'deny',
          message: 'User cancelled this question via myco chat pane (no option fit).',
        });
        return true;
      }
      if (rendered && rendered.synthetic === 'freeText') {
        // User wants to type a custom answer. Record "Other" as the
        // answer (matches the SDK convention — the model already knows
        // "Other" means "see the next user message for the freeform
        // reply"). Client-side _permOptionIsFreeText regex catches the
        // "Other —" label and focuses the chat input.
        shared.answers[q.question || ''] = 'Other';
        this._emit({
          type: 'permission_resolved',
          toolName: 'AskUserQuestion',
          hash,
          pickedN: n,
          pickedLabel: 'Other',
          subQuestionIdx: i,
          subQuestionTotal: shared.questions.length,
          synthetic: 'freeText',
        });
        shared.askedIdx = i + 1;
        if (shared.askedIdx < shared.questions.length) {
          this._askNextSubQuestion(shared);
          return true;
        }
        shared.resolve({
          behavior: 'allow',
          updatedInput: { questions: shared.questions, answers: shared.answers },
        });
        return true;
      }
      // Regular model-provided option pick (n ≤ opts.length).
      const picked = opts[n - 1];
      if (!picked) {
        if (shared) shared.resolve({ behavior: 'deny', message: 'User picked an invalid option' });
        return true;
      }
      // Accumulate this sub-question's answer.
      shared.answers[q.question || ''] = picked.label;
      this._emit({
        type: 'permission_resolved',
        toolName: 'AskUserQuestion',
        hash,
        pickedN: n,
        pickedLabel: picked.label,
        subQuestionIdx: i,
        subQuestionTotal: shared.questions.length,
      });
      shared.askedIdx = i + 1;
      if (shared.askedIdx < shared.questions.length) {
        // More questions remain — broadcast the next one. The SDK
        // promise stays pending until the final sub-question lands.
        this._askNextSubQuestion(shared);
        return true;
      }
      // Last question: settle the SDK promise with the assembled
      // answers map. updatedInput.answers maps every question text to
      // the user's picked label, exactly the shape the SDK expects.
      shared.resolve({
        behavior: 'allow',
        updatedInput: { questions: shared.questions, answers: shared.answers },
      });
      return true;
    }

    // Permission flavour: 1=allow once, 2=allow always, 3=deny.
    if (n === 3) {
      this._emit({ type: 'permission_resolved', toolName: pending.toolName, hash, pickedN: n, decision: 'deny' });
      pending.resolve({
        behavior: 'deny',
        message: 'User declined this action via myco chat pane',
      });
      return true;
    }
    const reply = { behavior: 'allow', updatedInput: pending.input };
    if (n === 2 && pending.suggestions.length) {
      // Echo SDK-provided suggestions back so the rule lands in
      // .claude/settings.local.json and future matching calls skip the
      // prompt entirely.
      const persist = pending.suggestions.filter((s) => s && s.destination === 'localSettings');
      if (persist.length) reply.updatedPermissions = persist;
    }
    this._emit({
      type: 'permission_resolved',
      toolName: pending.toolName,
      hash,
      pickedN: n,
      decision: n === 2 ? 'allow-always' : 'allow-once',
      persistedRules: (reply.updatedPermissions || []).length,
    });
    pending.resolve(reply);
    // bug-21: when "Allow always" persisted a new rule (n===2 + at
    // least one updatedPermissions entry), the rule may also match
    // any OTHER pending permission menu's (tool, input). Auto-resolve
    // those siblings so the user doesn't have to re-click the same
    // decision on every parallel menu the SDK fired in this turn.
    if (n === 2 && reply.updatedPermissions && reply.updatedPermissions.length) {
      this._reevaluatePendingAfterAllowAlways();
    }
    return true;
  }

  // bug-21: walk every still-pending permission menu after a fresh
  // allow rule was saved. For each whose (toolName, matching-input)
  // now resolves to 'allow' via permissions.decide, settle the SDK
  // promise with {behavior:'allow'} and emit permission_resolved
  // {auto:true, reason:'matched rule saved via sibling Allow always'}
  // so the chat-pane sees why the card auto-cleared. AskUserQuestion
  // sub-questions are NOT touched (pending.kind === 'ask') — they're a
  // different surface and the user must answer each explicitly.
  _reevaluatePendingAfterAllowAlways() {
    let sessionsMod, permissions, rec;
    try {
      sessionsMod = require('./sessions');
      permissions = require('./permissions');
      rec = sessionsMod.getSessionRecord && sessionsMod.getSessionRecord(this.sessionId);
    } catch (err) {
      console.error(`[agent-menu] ${this.sessionId} reevaluate failed to load deps: ${err.message}`);
      return;
    }
    if (!rec) return;
    // Snapshot — we mutate _pendingPermissions inside the loop.
    const candidates = Array.from(this._pendingPermissions.entries());
    let autoResolved = 0;
    for (const [siblingHash, sibling] of candidates) {
      if (!sibling || sibling.kind !== 'permission') continue;
      const matchingInput = _matchingInputFor(sibling.toolName, sibling.input);
      const decision = permissions.decide(rec, sibling.toolName, matchingInput);
      if (decision !== 'allow') continue;
      this._pendingPermissions.delete(siblingHash);
      this.pendingMenus.delete(siblingHash);
      this._emit({
        type: 'permission_resolved',
        toolName: sibling.toolName,
        hash: siblingHash,
        auto: true,
        reason: 'matched rule saved via sibling Allow always',
        decision: 'allow-once',
      });
      try {
        sibling.resolve({ behavior: 'allow', updatedInput: sibling.input });
        autoResolved++;
      } catch (err) {
        console.error(`[agent-menu] ${this.sessionId} reevaluate resolve threw for ${siblingHash.slice(-12)}: ${err.message}`);
      }
    }
    if (autoResolved > 0) {
      console.log(`[agent-menu] ${this.sessionId} reevaluate auto-resolved ${autoResolved} sibling menu(s) after Allow always`);
    }
  }

  _broadcastToolProgress() {
    const now = Date.now();
    const open = [];
    for (const [id, info] of this.openToolCalls) {
      open.push({
        id,
        name: info.name,
        summary: info.summary,
        sinceMs: Math.max(0, now - new Date(info.ts).getTime()),
      });
    }
    this.emit('state-update', { kind: 'tool-progress', open });
  }

  _emit(event) {
    const stamped = { ts: new Date().toISOString(), ...event };
    // delm-10 stale-working-badge fix: stamp the wall-clock moment a
    // terminal agent event lands — the exact point "working" became
    // "done". GET /sessions compares this (_lastDoneAt) against the
    // record's agentSeenAt (last user review) to decide the sidebar's
    // "to review" badge. Abort + fatal count as done too: the user
    // needs to see what happened before the interrupt/error.
    if (event && (event.type === 'turn_result' || event.type === 'iteration_aborted' || event.type === 'fatal')) {
      this._lastDoneAt = Date.now();
    }
    // Monotonic per-session sequence number. Used by the client to
    // sort chat-pane rows independently of ts (more robust under
    // clock drift / out-of-order delivery / missing ts). Same
    // counter is shared with chat-msg appends in sessions.js, so
    // chat bubbles + agent cards interleave correctly by seq.
    try {
      const sessionsMod = require('./sessions');
      if (sessionsMod.allocSeq) stamped.seq = sessionsMod.allocSeq(this.sessionId);
    } catch {}
    this.buffer.push(stamped);
    if (this.buffer.length > MAX_EVENTS) {
      this.buffer = this.buffer.slice(-MAX_EVENTS);
    }
    // Fire-and-forget disk append so chrome batches + tool calls
    // survive container restart / 5min keepalive reap. Failure is
    // logged but doesn't block the in-memory emit — clients still
    // get the live event via the agent-event listener.
    this._persistEventToDisk(stamped);
    // fr-85 r4 r3: SILENT MODE during a clarify. While
    // session._pendingClarify is set, NO agent-event broadcasts
    // reach attached clients — not assistant_text, tool_use,
    // tool_result, permission_request, chrome batch, claude-status,
    // anything. The popover stays the only user-visible surface
    // until the turn ends. Buffer + disk persist still happen so the
    // forensic record + agent-replay on later attach are intact.
    // The result-handler below emits ONE consolidated clarify-reply
    // WS frame (via this.emit('clarify-reply', ...)) when the turn
    // completes, then clears pendingClarify so subsequent turns
    // broadcast normally again.
    if (this._pendingClarify) return;
    this.emit('agent-event', stamped);
  }

  // bug-fix (2026-05-17): mirror each assistant_text block into
  // rec.chat as a `claude` chat-msg row tagged `meta.fromAgent:true`.
  //
  // Why: pre-SDK, the transcript JSONL watcher (`persistAssistantTextToChat`
  // in attach.js) recorded every assistant text block into rec.chat
  // with `meta.fromTranscript:true`. The SDK era left that path stale
  // because there's no JSONL transcript file the watcher could read —
  // claude replies now live ONLY in `session.buffer` + the
  // `<cwd>/_myco_/events.jsonl` append log. Both can be wiped
  //  (5-min reaper kills the AgentSession; events.jsonl can be deleted
  //  out from under us during workspace surgery), so a tab-switch /
  //  reload was losing claude's text if the buffer/jsonl chain broke.
  //
  // What we DO NOT do:
  //   - we do NOT emit('chat', msg) live — that would race the
  //     `agent-event` (assistant_text) frame and produce a duplicate
  //     render (chat-bubble next to the agent-text card). The card is
  //     the live channel; this function is purely the persistence backstop.
  //   - getChatHistory filters out `meta.fromAgent:true` rows by default
  //     (parallel to fromTranscript) so the chat-history WS frame sent
  //     on attach doesn't re-render them as bubbles alongside the
  //     agent-replay cards — same duplicate-avoidance contract that
  //     governs the old fromTranscript pattern.
  //
  // Net: rec.chat now keeps a durable, paginated record of claude's
  // text for forensic / future-tooling use (e.g., extractor /readChatTail,
  // future "load-claude-history" pagination). UI behavior is unchanged.
  // Returns true if `cover` already contains the meaningful content of
  // `subject` — used to dedup the SDK's `result` text against the
  // per-turn assistant_text accumulator. Whitespace + simple Markdown
  // wrapping differences are tolerated:
  //   - covered if subject is empty
  //   - covered if cover.contains(subject) (subject is a substring)
  //   - covered if subject.contains(cover) AND cover is at least 90%
  //     of subject's length (the result is just a slight extension —
  //     the accumulator basically captured the same thing)
  // Otherwise returns false → the caller should emit a fresh bubble.
  _textCoversSubject(cover, subject) {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const c = norm(cover);
    const s = norm(subject);
    if (!s) return true;
    if (!c) return false;
    if (c.includes(s)) return true;
    if (s.includes(c) && c.length >= Math.floor(s.length * 0.9)) return true;
    return false;
  }

  // Token-meter fix (2026-10-21): current context-window fill, from
  // the LAST assistant message's per-request usage. The SDK `result`
  // usage is cumulative across the whole turn (every API request),
  // which is why the old meter showed impossible values like
  // "3.6M/200k ctx". Fills = input + cache_read + cache_creation:
  // on a cached request input_tokens excludes the cached prefix, so
  // all three sum to what the model actually saw. Falls back to the
  // result usage (single-request turns, e.g. cached fast-path
  // replies with no streamed assistant message) and to 0 otherwise.
  //
  // Huawei-gateway fix (2026-10-22): on the enterprise gateway the
  // assistant messages carry NO per-request usage (verified live:
  // 0 stashes across a 3.9M-token session), so the primary path
  // above never fires and the client fallback re-derives the fill
  // from the CUMULATIVE result usage — reintroducing "3.9m/200k".
  // When no per-request usage exists, estimate the fill as the
  // cumulative result usage divided by the number of API requests
  // the turn made (numTurns from the SDK result) — the AVERAGE
  // request's context. An honest estimate that cannot exceed the
  // window, instead of a nonsense cumulative sum.
  _computeCtxFill(resultUsage, numTurns) {
    const u = this._lastAssistantUsage;
    if (u && typeof u === 'object') {
      const inTok = Number(u.input_tokens) || 0;
      const cacheR = Number(u.cache_read_input_tokens) || 0;
      const cacheC = Number(u.cache_creation_input_tokens) || 0;
      if (inTok || cacheR || cacheC) return inTok + cacheR + cacheC;
    }
    // Huawei-gateway fallback: cumulative result usage ÷ requests.
    const r = resultUsage;
    if (r && typeof r === 'object') {
      const inTok = Number(r.input_tokens) || 0;
      const cacheR = Number(r.cache_read_input_tokens) || 0;
      const cacheC = Number(r.cache_creation_input_tokens) || 0;
      const total = inTok + cacheR + cacheC;
      if (total > 0) {
        const requests = Number(numTurns) > 1 ? Number(numTurns) : 1;
        return Math.max(1, Math.round(total / requests));
      }
    }
    return null;
  }

  _persistAssistantTextToRecChat(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    const msg = {
      user: 'claude',
      text: trimmed,
      ts: new Date().toISOString(),
      meta: { fromAgent: true },
    };
    // fr-85 r4 r3: clarify accumulation. While a clarify is in
    // flight, append each persisted assistant_text chunk into the
    // pending replyText buffer — the result handler will fire ONE
    // consolidated clarify-reply WS frame at turn end (instead of
    // one frame per streaming chunk that r1 used to do). Tagging
    // the rec.chat record stays the same (audit trail), but the
    // WS emit moved to the result handler so all chunks
    // (assistant_text-block path + result-fallback path) coalesce
    // into one popover update.
    if (this._pendingClarify) {
      msg.meta.kind = 'clarify-reply';
      msg.meta.clarifyQuestionTs = this._pendingClarify.questionTs;
      this._pendingClarify.replyText =
        (this._pendingClarify.replyText || '') + trimmed + '\n';
    }
    try {
      const sessionsMod = require('./sessions');
      if (sessionsMod.appendChatMessage) {
        sessionsMod.appendChatMessage(this.sessionId, msg);
      }
    } catch (err) {
      console.error(`[persist-chat] ${this.sessionId} failed to write: ${err && err.message ? err.message : err}`);
      return;
    }
    // Deliberately NO this.emit('chat', msg) here — the agent-event
    // stream (assistant_text card) is the live render channel; emitting
    // 'chat' would produce a duplicate bubble next to the card.
    console.log(`[persist-chat] ${this.sessionId} mirrored assistant_text (${trimmed.length} chars) to rec.chat fromAgent:true${msg.meta.kind === 'clarify-reply' ? ' (clarify-reply)' : ''}`);
  }

  // td-33 (B — stage-aware critic): scan claude's assistant_text for
  // stage-boundary sentinels emitted per the critic.md +
  // best-practices-template directive. Sentinel grammar (case-
  // insensitive, whitespace-tolerant):
  //     [stage: analyze done]
  //     [stage: code done]
  //     [stage: verify done]
  //
  // The matching set is fixed at the three stages td-33 names — we
  // do NOT accept arbitrary stage strings (no speculative features;
  // claude could otherwise spam the critic with self-invented stages
  // like "[stage: think done]"). Each stage fires AT MOST ONCE PER
  // TURN — duplicates in the same text block (or across multiple
  // assistant_text blocks within the same turn) are deduped via
  // this._firedStages. The set is cleared on turn_result so the next
  // turn can re-fire any stage.
  //
  // Emits `stage-done` on the session bus with { stage }; attach.js's
  // _registerExternalSession subscribes and triggers a checkpoint
  // critique via triggerGeminiCritique({ isIntermediate: true,
  // stage }).
  _detectStageSentinels(text) {
    if (!text || typeof text !== 'string') return;
    if (!this._firedStages) this._firedStages = new Set();
    // bug-68: per-turn sentinel cap. Pre-bug-68 the dedup was per-stage
    // only — if claude emitted "[stage: analyze done] ... [stage: code
    // done]" in a single assistant_text block, BOTH fired sequentially.
    // The downstream bug-61 drop guard catches the SECOND sentinel only
    // AFTER the first one's broadcast has landed and transitioned
    // stageState; in the same-tick case, both sentinels are processed
    // before any broadcast arrives. Result was an out-of-order verdict
    // pane sequence the user reported in the bug-68 comments
    // ("sometimes in wrong order"). Fix: at most ONE stage-done per
    // turn. The _firedStagesThisTurn set is cleared on turn_result by
    // _handleEvent's result branch so the NEXT turn can fire.
    if (!this._firedStagesThisTurn) this._firedStagesThisTurn = new Set();
    if (this._firedStagesThisTurn.size > 0) {
      // Already fired one stage this turn. Log + skip any further
      // sentinels in the same text. Forces claude to do one stage per
      // turn — which matches CLAUDE.md §9's "the stage gets DONE per
      // the criteria above" cadence anyway.
      const re = /\[\s*stage\s*:\s*(analyze|code|verify)\s+done\s*\]/gi;
      let m;
      while ((m = re.exec(text)) !== null) {
        const stage = m[1].toLowerCase();
        const fired = Array.from(this._firedStagesThisTurn).join(',');
        console.log(`[bug-68] session ${this.sessionId} dropping stage-done(${stage}) — already fired this turn (${fired}). Only one stage per turn (the bug-64 defer + bug-61 drop catch the runtime case but a same-tick claude reply with two sentinels needs this lexical cap).`);
      }
      return;
    }
    // RegExp.exec in a loop gathers every match so we don't miss a
    // claude reply that announces two stages back-to-back (e.g.
    // "[stage: analyze done] ... [stage: code done]" in a single
    // text block) — BUT per bug-68 we only honor the FIRST one.
    const re = /\[\s*stage\s*:\s*(analyze|code|verify)\s+done\s*\]/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const stage = m[1].toLowerCase();
      if (this._firedStages.has(stage)) continue;
      this._firedStages.add(stage);
      this._firedStagesThisTurn.add(stage);
      console.log(`[td-33] session ${this.sessionId} fired stage-done: ${stage}`);
      try { this.emit('stage-done', { stage }); }
      catch (err) { console.error(`[td-33] stage-done emit failed: ${err.message}`); }
      // bug-68: stop after the first fire even if more sentinels are
      // in the same text block. The next turn can fire a different
      // stage; this turn is one-and-done.
      break;
    }
  }

  // Read up to the last MAX_EVENTS events from <cwd>/_myco_/
  // events.jsonl into this.buffer. Called once during construction.
  // Missing file / corrupt lines are tolerated — failure means an
  // empty buffer, same as the legacy in-memory-only behavior.
  _hydrateBufferFromDisk() {
    try {
      if (!fs.existsSync(this._eventsFile)) return;
      const raw = fs.readFileSync(this._eventsFile, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const tail = lines.slice(-MAX_EVENTS);
      const events = [];
      for (const line of tail) {
        try { events.push(JSON.parse(line)); }
        catch { /* skip malformed line */ }
      }
      if (events.length) {
        this.buffer = events;
        // Bump the sessions.js seq counter so newly-allocated seqs
        // don't collide with events persisted before the last
        // process exit. Find max seq in the hydrated buffer.
        let maxSeq = 0;
        for (const ev of events) {
          if (typeof ev.seq === 'number' && ev.seq > maxSeq) maxSeq = ev.seq;
        }
        if (maxSeq > 0) {
          try {
            const sessionsMod = require('./sessions');
            if (sessionsMod.bumpSeqAtLeast) sessionsMod.bumpSeqAtLeast(this.sessionId, maxSeq);
          } catch {}
        }
        console.log(`[events-persist] ${this.sessionId} hydrated ${events.length} event(s) from ${this._eventsFile} (maxSeq=${maxSeq})`);
      }
    } catch (err) {
      console.warn(`[events-persist] ${this.sessionId} hydrate failed: ${err.message}`);
    }
  }

  // Append one JSON-encoded event to events.jsonl (async). After
  // every 100 appends, run _maybeTrimEventsFile to keep the file
  // bounded.
  _persistEventToDisk(event) {
    try {
      const dir = path.dirname(this._eventsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const line = JSON.stringify(event) + '\n';
      fs.appendFile(this._eventsFile, line, (err) => {
        if (err) console.warn(`[events-persist] ${this.sessionId} append failed: ${err.message}`);
      });
      this._eventAppendsSinceTrim++;
      if (this._eventAppendsSinceTrim >= 100) {
        this._eventAppendsSinceTrim = 0;
        this._maybeTrimEventsFile();
      }
    } catch (err) {
      console.warn(`[events-persist] ${this.sessionId} write failed: ${err.message}`);
    }
  }

  // If events.jsonl has grown beyond MAX_EVENTS_FILE_BYTES, rewrite
  // it with only the last MAX_EVENTS lines. Synchronous rewrite is
  // fine here — runs once every ~100 events, well-amortized.
  _maybeTrimEventsFile() {
    try {
      const stat = fs.statSync(this._eventsFile);
      if (stat.size < MAX_EVENTS_FILE_BYTES) return;
      const raw = fs.readFileSync(this._eventsFile, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length <= MAX_EVENTS) return;
      const keep = lines.slice(-MAX_EVENTS);
      fs.writeFileSync(this._eventsFile, keep.join('\n') + '\n');
      console.log(`[events-persist] ${this.sessionId} trimmed ${this._eventsFile}: ${lines.length} → ${keep.length} lines`);
    } catch (err) {
      console.warn(`[events-persist] ${this.sessionId} trim failed: ${err.message}`);
    }
  }

  // --- session-interface methods (mirror PtySession) -------------------

  // Semantically the next user turn. The string is the prompt body.
  // Phase 4: pushes into the streaming-input queue so the SDK can read
  // it without needing a fresh query() per turn. If no iteration is
  // currently running (first .write(), or after an interrupt), kicks
  // one off — with resume=sdkSessionId so the conversation continues.
  write(text) {
    if (!this.alive) return;
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    const envelope = { type: 'user', message: { role: 'user', content: trimmed } };
    // bug-40: remember this turn so a poisoned-resume recovery can
    // redeliver it to a fresh conversation (cleared on the next `result`).
    this._lastUserEnvelope = envelope;
    // Reset the per-turn assistant-text accumulator (used by the
    // `result` branch in _handleEvent to dedup the SDK's final
    // result text against any text already streamed via assistant
    // messages this turn).
    this._currentTurnAssistantText = '';
    // Token-meter fix: fresh slate for the per-request usage stash —
    // each turn's ctxFill must reflect only THIS turn's assistant
    // messages, not a stale one from the previous turn.
    this._lastAssistantUsage = null;
    this._emit({ type: 'turn_start', prompt: trimmed.slice(0, 200) });
    if (this._iterating && this._msgQueue) {
      // fr:model-gateway — a `/model gw:` switch (this.activeGw changed
      // since this iteration was built with _activeGwAtIteration) cannot
      // apply to the LIVE query: base_url/auth are baked into sdkOpts at
      // iteration start. Rather than feed the new user message into the
      // old-gateway query, stash it and restart the iteration so the next
      // query cold-starts with the new gwEnv (resume=sdkSessionId keeps
      // the conversation) — "切换模型没有及时生效" / "怎么会说自己是claude".
      if (this.activeGw !== this._activeGwAtIteration) {
        if (!this._pendingPrePush) this._pendingPrePush = [];
        this._pendingPrePush.push(envelope);
        this._pendingGwRestart = true;
        if (this._abortController) { try { this._abortController.abort(); } catch {} }
        if (this._msgQueue) { try { this._msgQueue.close(); } catch {} }
        return; // the drain → idle hook cold-starts a fresh iteration
      }
      // Hot path: SDK is already iterating, just push.
      this._msgQueue.push(envelope);
      return;
    }
    // Cold start (first write, or post-abort restart): stash the
    // envelope so _ensureIteration can deliver it to the fresh queue.
    if (!this._pendingPrePush) this._pendingPrePush = [];
    this._pendingPrePush.push(envelope);
    this._ensureIteration();
  }

  // No-op for agent sessions — the SDK doesn't care about terminal size.
  // Kept for compat with attach-time resize frames sent by the existing
  // browser code.
  resize(cols, rows) {
    if (Number.isFinite(cols)) this.cols = cols;
    if (Number.isFinite(rows)) this.rows = rows;
  }

  updateCwd(newCwd) {
    this.cwd = newCwd;
    let _mycoDir = null;
    try {
      const sessionsMod = require('./sessions');
      const { resolveMycoDir } = require('./artifacts');
      const rec = sessionsMod.getSessionRecord(this.sessionId);
      if (rec) _mycoDir = resolveMycoDir(rec);
    } catch (err) {
      console.error(`[AgentSession] failed to resolve mycoDir during CWD update for ${this.sessionId}: ${err.message}`);
    }
    this._eventsFile = this._eventsFileBase
      || path.join(_mycoDir || path.join(this.cwd, '_myco_'), 'events.jsonl');
  }

  kill() {
    if (!this.alive) return;
    this.alive = false;
    if (this._abortController) {
      try { this._abortController.abort(); } catch {}
    }
    if (this._msgQueue) {
      try { this._msgQueue.close(); } catch {}
    }
    this.emit('exit', 0);
  }
}

// Convenience factory mirroring pty.spawnClaude. Returns the live
// AgentSession (alive=true, possibly mid-iteration if initialPrompt set).
function spawnAgent(sessionId, opts = {}) {
  return new AgentSession(sessionId, opts);
}

module.exports = { AgentSession, spawnAgent };
