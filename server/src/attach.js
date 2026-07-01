// SDK Phase 9 step 2: agent-only attach + chat plumbing.
//
// Replaces the legacy server/src/pty.js. Everything PTY-specific
// (PtySession, spawnClaude, headless xterm, menu-interceptor, wizard
// detection, replay buffer, PTY-flavored attachWebSocket /
// attachViewerWebSocket) is gone. Sessions are uniformly agent-mode
// (AgentSession from ./agent-session.js); this module is just the WS
// transport + chat routing layer on top.
//
// Public surface (consumed by index.js, sessions.js, menu.js,
// slashcmds.js, tests):
//   sessions Map (sessionId → session object) — registered via
//     _registerExternalSession when sessions.spawnSession spins up
//     an AgentSession.
//   getSession(id), killSession(id), _registerExternalSession(id, s)
//   attachWebSocket(session, ws, opts)  — owner connection
//   attachViewerWebSocket(session, ws, opts) — read-only share-link
//   handleChatMessage(sessionId, session, user, text)
//   handleMenuPick / handleMenuToggle / handleMenuSubmit — chat-pane
//     modal popup click handlers, route the click to the AgentSession's
//     resolveMenuPick/Toggle/Submit (no PTY navigation).
//   _detectMentionTarget — chat-routing test hook.
//   _supersedeStaleMenus — menu.js + sessions.js zombie cleanup.

const crypto = require('crypto');

// Late-bound: sessions.js requires this module, so destructuring at load
// time would capture undefined values from the partial export.
const sessionsMod = require('./sessions');
const { askAssistant, shouldAskAssistant, ASSISTANT_USER } = require('./btw');
const menuMod = require('./menu');
const slashcmds = require('./slashcmds');
const transcriptMod = require('./transcript');
const authMod = require('./auth');
const runQueue = require('./runQueue');
// Late-bound: requiring artifacts.js at module load time pulled
// extractor.js into the partial-load window of the
// sessions.js ↔ attach.js cycle. extractor.js destructures
// { projectsDir, encodeCwdForClaude, getChatHistory } from sessions —
// which at that point hadn't yet evaluated its module.exports
// assignment, so the destructured names were undefined. Resolve lazily
// inside _sendAttachSnapshot via this getter so the require runs AFTER
// all cycle modules have finished loading.
let _artifactsMod = null;
function getArtifactsMod() {
  if (!_artifactsMod) _artifactsMod = require('./artifacts');
  return _artifactsMod;
}

const CHAT_TEXT_LIMIT = 4000;
const ASSISTANT_SCROLLBACK_LINES = 40;
const ASSISTANT_CHAT_CONTEXT = 20;

// bug-9 round 7: separate budgets for chat-history vs agent-replay.
// The user's "1 KB initial / 16 KB rolling cap" directive was for
// CHAT history specifically — user-typed messages average 50-200
// bytes each, so 1 KB fits a reasonable handful. Agent events are
// MUCH heavier (a single tool_use with input or tool_result with
// content can be 500-1500 bytes), so 1 KB fits only 1-3 events and
// the user sees ~one chrome batch instead of meaningful claude
// activity. The agent-replay budget is bumped to 16 KB so the
// initial paint includes a useful slice of claude's recent work.
//
// session.buffer + events.jsonl on disk are NOT touched; only the
// wire frame is trimmed. Total attach payload is ~17 KB peak
// (1 KB chat-history + 16 KB agent-replay) — still well under the
// round-3 unified 256 KB.
const INITIAL_AGENT_REPLAY_BYTES = 16 * 1024;
// bug-86 (option B, 2026-06-10): minimum assistant_text events guaranteed
// on initial agent-replay attach, even when the byte budget would
// otherwise cut them off. User-reported on omni-cache session "kept
// losing the myco response in the chat pane" — logs showed
// `[agent-replay] initial byte-trim 838 → 11 events (15362 bytes, budget
// 16384)` and `[agent-replay-diag] initial shipped 1 assistant_text(s)`.
// A single tool_use/tool_result can be 5+ KB, so the 16 KB budget often
// fits only 1 assistant_text. This floor guarantees the user sees the
// last N claude replies on every fresh attach regardless of how chatty
// the intermediate tool calls were. 5 mirrors the chat-history floor
// from sessions.js.
const INITIAL_AGENT_REPLAY_MIN_ASSISTANT_TEXTS = 5;
const DEFAULT_AGENT_REPLAY_BYTES = 16 * 1024;

// sessionId → AgentSession (or any session-shaped object registered via
// _registerExternalSession). Module-level Map so getSession/attachWebSocket
// /state-update plumbing all hit the same store.
const sessions = new Map();

function _isKnownChatUser(word) {
  if (!word) return false;
  const w = word.toLowerCase();
  try {
    for (const u of authMod.listUsernames()) {
      if (String(u || '').toLowerCase() === w) return true;
    }
  } catch {}
  try {
    const allow = authMod.loadAllowlist();
    if (allow && typeof allow.has === 'function') {
      for (const u of allow) {
        if (String(u || '').toLowerCase() === w) return true;
      }
    }
  } catch {}
  return false;
}

// Return the canonical mention target if `text` starts with @<thing>
// at the head, optionally followed by a body. Used by
// handleChatMessage to short-circuit chat-only mentions so they're
// stamped + persisted without being forwarded to claude.
//
// Recognised targets:
//   - `@all` — special-cased broadcast mention. Every viewer / owner
//     attached to this session sees the row highlighted as addressed
//     to them (chat-pane unread badge bumps regardless of who they
//     are). Returns the literal lowercased string 'all'.
//   - `@<known-user>` — head-of-message mention to a specific
//     collaborator (canonical lowercased login).
//
// Returns null for `@<unknown-word>` — those fall through to the
// normal chat-to-claude path. (The legacy `@myco` / `@claude`
// "talk-to-claude" prefix is gone — every chat message reaches claude
// by default; only the head-of-message mention syntax is special.)
function _detectMentionTarget(text) {
  const m = String(text || '').match(/^@([A-Za-z][\w-]{0,30})\b/);
  if (!m) return null;
  const w = m[1].toLowerCase();
  if (w === 'all') return 'all';   // broadcast mention — see fr-3
  return _isKnownChatUser(m[1]) ? m[1] : null;
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

// Dispatch-label-drift fix (2026-06-03): capture the set of dirty
// paths + the HEAD SHA at the moment a `[run:plan#X]` dispatch
// starts. The critique gate (turn_result success path) uses the
// dirty-paths set to filter out pre-existing WIP — only changes
// made by THIS run reach Gemini.
//
// Why a fresh git invocation here rather than reusing
// listChangedFiles in files.js: listChangedFiles returns rich
// metadata (per-file diff stats) which is more than we need + is
// async. The snapshot is on the hot path of every chat message, so
// keep it synchronous + minimal. execFileSync with a 2s timeout
// bounds the worst case; failures fall through to an empty baseline
// (so the critique sees the full WIP — same as pre-fix behavior,
// no regression).
function _snapshotRunBaseline(absCwd) {
  const { execFileSync } = require('child_process');
  const dirtyPaths = new Set();
  let head = null;
  try {
    head = execFileSync('git', ['-C', absCwd, 'rev-parse', 'HEAD'], { timeout: 2000, encoding: 'utf8' }).trim();
  } catch {}
  try {
    const porcelain = execFileSync('git', ['-C', absCwd, 'status', '--porcelain'], { timeout: 2000, encoding: 'utf8' });
    // Each line is "XY <path>" where XY is a 2-char status. For rename
    // entries "R  src -> dst" we capture both src and dst.
    for (const line of porcelain.split('\n')) {
      const stripped = line.slice(3).trim();    // drop the "XY " prefix
      if (!stripped) continue;
      const arrow = stripped.indexOf(' -> ');
      if (arrow >= 0) {
        dirtyPaths.add(stripped.slice(0, arrow));
        dirtyPaths.add(stripped.slice(arrow + 4));
      } else {
        dirtyPaths.add(stripped);
      }
    }
  } catch {}
  return { dirtyPaths, head };
}

// Register a session object (currently always AgentSession from
// server/src/agent-session.js). Lets the WS attach + state-update + chat
// plumbing find it via the module-local `sessions` map and wires the
// session's 'menu' event into menuMod.handleSessionMenu so canUseTool
// fires propagate into chat-pane menu cards.
function _registerExternalSession(sessionId, session) {
  sessions.set(sessionId, session);
  if (typeof session.on === 'function') {
    session.on('menu', (menu) => menuMod.handleSessionMenu(sessionId, session, menu));
    // td-33 (B — stage-aware critic): when claude announces a stage
    // boundary via [stage: analyze|code|verify done] in its assistant
    // text, agent-session.js emits a 'stage-done' event here. We
    // snapshot the current diff + fire an INTERMEDIATE critique. The
    // critique broadcasts a verdict for the user's awareness but does
    // NOT pause the run queue (per critique.js's isIntermediate gate)
    // — pausing on every stage transition would freeze multi-step work
    // behind a sequence of approvals.
    //
    // Guards (matches the final-critique gate):
    //   · session._activeRunItem must be set (only fires during a
    //     [run:plan#X] dispatch — bare conversation turns don't get
    //     checkpoint critiques).
    //   · The dispatch-drift baseline filter from the 2026-06-03 fix
    //     applies the same way — pre-existing WIP paths are excluded
    //     so a stage critique on a no-op run doesn't fire against
    //     unrelated working-tree state.
    session.on('stage-done', async ({ stage }) => {
      try {
        const active = session._activeRunItem;
        if (!active || !active.itemId) {
          console.log(`[td-33] stage-done(${stage}) fired without active run item — skipping`);
          return;
        }
        // bug-68 (Option B addition 1): immediately echo the sentinel
        // back to chat. Pre-bug-68 the time between claude emitting
        // [stage: X done] and the critic verdict pane appearing could
        // be 10-60s+ with NO user-visible signal — the regex match
        // happened in stderr only. If the critic later skipped (empty
        // diff) or errored, the user had no idea whether the sentinel
        // was even received. The chat-pane echo closes that observability
        // gap: every detected sentinel produces a "📍 sentinel received"
        // chat row IMMEDIATELY, before the critic fires. Subsequent
        // outcomes (skip / error / verdict) appear as their own chat
        // rows — a visible timeline the user can scroll through.
        _emitSentinelReceivedNote(sessionId, session, { stage, itemId: active.itemId });
        // bug-61: pause enforcement. Pre-bug-61 the §9 methodology
        // was directive-only — claude could (and empirically DID)
        // emit a second [stage: X done] sentinel while a previous
        // stage's verdict was still pending review, which fired
        // another critic AND overwrote the user's chance to read the
        // first verdict. User-reported (verbatim):
        //   "the analyze stage verdict didn't pause the process, it
        //    eventually get overriden by the final stage overall
        //    verdict popover."
        // Fix: check the stageState BEFORE transitioning + firing the
        // critic. If we're already in awaiting_verdict (critic in
        // flight) or awaiting_accept (user reviewing verdict), DROP
        // this sentinel — claude must wait for the user to signal
        // ✓ Accept Stage / ⚡ Ask Claude to Fix Stage before another
        // sentinel can fire. The drop is one-shot — if claude later
        // wants the dropped stage to be critiqued, they re-emit the
        // sentinel after the user resolves the existing verdict.
        const recForStageCheck = sessionsMod.getSessionRecord(sessionId);
        const itemForStageCheck = _findPlanItemInRec(recForStageCheck, active.itemId);
        const curStageState = stageStateMod.getStageState(itemForStageCheck);
        if (curStageState && (curStageState.status === 'awaiting_verdict' || curStageState.status === 'awaiting_accept')) {
          console.log(`[bug-61] dropping stage-done(${stage}) for ${active.itemId} — current stageState is ${curStageState.stage}.${curStageState.status}; claude must wait for the user to signal accept-stage / fix-stage on the existing verdict first`);
          return;
        }
        // bug-57: mark that this run has emitted at least one stage
        // sentinel. The turn_result handler reads this to decide
        // whether to keep _activeRunItem alive across the next
        // turn_result (multi-stage methodology) or clear it (legacy
        // one-shot behavior). Without the flag, the eager clear on
        // every turn_result would null out _activeRunItem after the
        // analyze stage's turn ends, and stages 2 + 3 wouldn't fire
        // critiques — exactly the gap bug-57 closes.
        session._sawStageSentinelInRun = true;
        // fr-96: stage-done → status awaiting_verdict transition.
        // The critic is about to fire; once it broadcasts, the
        // next transition will be → awaiting_accept (via critique.js).
        _transitionStageState(sessionId, session, active.itemId, stage, 'awaiting_verdict');
        const rec = sessionsMod.getSessionRecord(sessionId);
        if (!rec || !rec.absCwd) {
          // bug-68 follow-up (2026-06-07): emit a chat note instead of
          // silent return. Pre-follow-up the sentinel-received note
          // appeared + then nothing — user had no signal the critic
          // wasn't going to fire. Session record missing usually means
          // the rec was reaped + the session is in a weird transition;
          // don't transition stageState here (state is unknown), just
          // tell the user.
          console.warn(`[bug-68] stage-done(${stage}) — no session record / absCwd; cannot run critic`);
          _emitCritiqueSkipNote(sessionId, session, {
            stage, itemId: active.itemId, reason: 'no-session-rec',
            message: `⚠️ Critic skipped for **${stage}** stage — session record is missing or has no working directory. The session may be transitioning (reaped + respawning). Try ▶ Run on the plan item again in a moment, or type **accept** in chat to proceed without the critic.`,
          });
          return;
        }

        // bug-68 third-wave follow-up (2026-06-07 user-reported on
        // td-35/fr-98): the ANALYZE stage by CLAUDE.md §9 contract has
        // ZERO source-file edits. Its output is claude's PLAN TEXT —
        // problem restated, numbered plan with verify clauses,
        // assumptions. Pre-follow-up the critic-fire required non-
        // empty diff → analyze always skipped → user's plan text was
        // never reviewed. User-reported verbatim: "the analyze output,
        // which might the response from claude, should be provided to
        // the critic."
        //
        // Fix: for analyze stage, if claude emitted substantial
        // assistant_text this turn, fire the real critic with the text
        // (empty diff). The critique.js stageAnalyze prompt already
        // tells the critic to evaluate the PLAN — no critique.js
        // changes needed. The 200-char threshold filters trivial
        // turns (a bare "ok" or empty re-prompt); a real analyze plan
        // is always > 500 chars.
        //
        // For CODE / VERIFY stages, the current diff-required behavior
        // stays. Those stages SHOULD produce file changes; an empty
        // diff IS a legitimate skip there. The synthetic skip-verdict
        // (c941278) covers that case.
        const claudeText = (session._currentTurnAssistantText || '').trim();
        if (stage === 'analyze' && claudeText.length >= 200) {
          console.log(`[bug-68] analyze stage: firing critic on claude's plan text (${claudeText.length} chars, no diff required per §9 analyze contract)`);
          // Find the plan item for the critique fire — same lookup as
          // the diff path below.
          const planArtifactA = rec.artifacts && rec.artifacts.plan;
          const itemA = planArtifactA && Array.isArray(planArtifactA.items)
            && planArtifactA.items.find((it) => it.id === active.itemId);
          if (itemA) {
            try {
              const { triggerGeminiCritique } = require('./critique');
              await triggerGeminiCritique(sessionId, session, itemA, '',
                claudeText.slice(0, 32000),
                { isIntermediate: true, stage, changedEntries: [] });
            } catch (err) {
              console.error(`[bug-68] analyze-text critic fire failed: ${err.message}`);
              try {
                _emitCritiqueSkipNote(sessionId, session, {
                  stage, itemId: active.itemId, reason: 'handler-exception',
                  message: `⚠️ Critic call for **analyze** stage crashed: \`${err && err.message ? err.message.slice(0, 200) : 'unknown error'}\`. Try ▶ Run on the plan item again — if the error recurs, check the server log.`,
                });
              } catch {}
            }
            return;
          }
          console.warn(`[bug-68] analyze-text critic fire — item ${active.itemId} not found in rec.artifacts.plan; falling through to diff path`);
          // Fall through to the existing diff-path so the user at least
          // sees the item-missing skip note.
        }

        const { listChangedFiles, readDiff } = require('./files');
        const changedInfo = await listChangedFiles(rec.absCwd);
        if (!changedInfo || !Array.isArray(changedInfo.entries) || changedInfo.entries.length === 0) {
          console.log(`[td-33] stage-done(${stage}) — no dirty files at this checkpoint; skipping critique`);
          // bug-68: tell the user. Pre-bug-68 the skip was stderr-only,
          // so the user saw "verdict didn't show up" with no signal
          // why. Emit a system chat note explaining the skip so the
          // user can decide whether to make actual changes + re-emit
          // the sentinel, or accept the skip and move on.
          _emitCritiqueSkipNote(sessionId, session, {
            stage, itemId: active.itemId, reason: 'no-changes',
            message: `📋 Critic skipped for **${stage}** stage — no file changes detected at this checkpoint. If you intended for this stage to produce changes, make them now and re-emit \`[stage: ${stage} done]\`. Otherwise type **accept** in chat to proceed to the next stage.`,
          });
          // bug-68 follow-up (2026-06-07): transition stageState to
          // awaiting_accept. Pre-follow-up the skip path left the item
          // at awaiting_verdict (set on sentinel detection at line ~245
          // above) — because the awaiting_accept transition lives in
          // critique.js and the critic never fired. The bug-70 chat-
          // accept handler gates on `awaiting_accept`, so typing
          // "accept" in chat silently no-op'd, and no verdict pane
          // rendered either (no broadcast). User-reported on td-35
          // verbatim: "I've never seen ✓ Accept Stage in the verdict
          // HUD either" + "the verdict modal is never shown up". With
          // the skip → awaiting_accept transition, chat-accept works
          // immediately + claude advances via bug-68's dispatch wire.
          _transitionStageState(sessionId, session, active.itemId, stage, 'awaiting_accept');
          // bug-68 follow-up (2026-06-07 second wave): also emit a
          // SYNTHETIC verdict broadcast so the client renders the
          // pane with the ✓ Accept Stage button. Chat-accept text path
          // is fine, but the user expects the visual modal.
          _broadcastSyntheticSkipVerdict(sessionId, session, {
            stage, itemId: active.itemId, reason: 'no-changes',
          });
          return;
        }
        const baselineDirty = (active.baselineDirty instanceof Set) ? active.baselineDirty : new Set();
        const newEntries = changedInfo.entries.filter((e) => !baselineDirty.has(e.path));
        if (newEntries.length === 0) {
          console.log(`[td-33] stage-done(${stage}) — only baseline-WIP paths are dirty; skipping critique`);
          // bug-68: tell the user. This is the "all dirty paths were
          // already dirty at run-start" case (the dispatch-drift filter).
          _emitCritiqueSkipNote(sessionId, session, {
            stage, itemId: active.itemId, reason: 'baseline-wip-only',
            message: `📋 Critic skipped for **${stage}** stage — all dirty paths were already modified before this run started (baseline WIP). The critic couldn't attribute any changes to this stage. If your changes for this stage haven't been made yet, make them and re-emit \`[stage: ${stage} done]\`. Otherwise type **accept** in chat to proceed to the next stage.`,
          });
          // bug-68 follow-up (2026-06-07): same fix as the no-changes
          // skip site above — transition to awaiting_accept so chat-
          // accept works + claude advances via the bug-68 dispatch wire.
          _transitionStageState(sessionId, session, active.itemId, stage, 'awaiting_accept');
          // bug-68 follow-up (2026-06-07 second wave): synthetic
          // verdict broadcast so the pane renders.
          _broadcastSyntheticSkipVerdict(sessionId, session, {
            stage, itemId: active.itemId, reason: 'baseline-wip-only',
          });
          return;
        }
        let fullDiff = '';
        for (const entry of newEntries) {
          const d = await readDiff(rec.absCwd, entry.path);
          if (d && d.diff) fullDiff += `\n--- File: ${entry.path} ---\n${d.diff}\n`;
        }
        if (!fullDiff.trim()) {
          // bug-68 follow-up (2026-06-07): all readDiff calls returned
          // empty (file added but git can't compute diff, file was a
          // binary, or similar). Same observability hole as the
          // baseline-wip-only case: tell the user + transition to
          // awaiting_accept so chat-accept works.
          console.log(`[td-33] stage-done(${stage}) — readDiff returned empty for all newEntries; skipping critique`);
          _emitCritiqueSkipNote(sessionId, session, {
            stage, itemId: active.itemId, reason: 'empty-diff',
            message: `📋 Critic skipped for **${stage}** stage — files changed but the diff is empty (possibly new files git can't diff, binary changes, or readDiff errors). Type **accept** in chat to proceed to the next stage, or re-emit \`[stage: ${stage} done]\` after making textual changes.`,
          });
          _transitionStageState(sessionId, session, active.itemId, stage, 'awaiting_accept');
          _broadcastSyntheticSkipVerdict(sessionId, session, {
            stage, itemId: active.itemId, reason: 'empty-diff',
          });
          return;
        }
        const planArtifact = rec.artifacts && rec.artifacts.plan;
        const item = planArtifact && Array.isArray(planArtifact.items)
          && planArtifact.items.find((it) => it.id === active.itemId);
        if (!item) {
          // bug-68 follow-up (2026-06-07): plan item not found in
          // rec.artifacts.plan. Pre-follow-up this returned silently.
          // bug-74 added the file-mirror fallback in
          // _findPlanItemInRec, but THIS path uses a different lookup
          // (direct .find on rec.artifacts.plan.items) — if rec.artifacts
          // is stale (e.g. plan.json was edited externally), the item
          // isn't found. Tell the user; don't transition (we can't find
          // the item to transition).
          console.warn(`[bug-68] stage-done(${stage}) — item ${active.itemId} not found in rec.artifacts.plan; cannot run critic`);
          _emitCritiqueSkipNote(sessionId, session, {
            stage, itemId: active.itemId, reason: 'item-missing',
            message: `⚠️ Critic skipped for **${stage}** stage — plan item \`${active.itemId}\` not found in the session's in-memory artifacts. The plan.json may have been edited externally + needs re-load. Try ▶ Run on the plan item again; if the issue persists, check that \`_myco_/plan.json\` contains the item.`,
          });
          return;
        }
        const { triggerGeminiCritique } = require('./critique');
        // td-33 r2: pass newEntries through so intermediate critiques
        // get the same file-context enrichment as final critiques.
        // bug-68: was `.slice(-2000)` — the TAIL-2KB truncation
        // dropped structured plan sections (Root Cause, Proposed
        // Solution, Verification Steps) that sit at the HEAD of a
        // typical analyze response, leaving the critic with only the
        // assumption block + closing sentinel. Critic verdicts
        // empirically said "Missing Proposed Solution" on bug-66 +
        // bug-69 + bug-68 itself even though the plans were fully
        // present in claude's emitted text. Flip direction to HEAD
        // and bump the cap to 32 KB so any realistic analyze plan
        // (<= 8K tokens, <= ~4000 words) fits in full. Gemini 2.5's
        // >1M-token budget makes 32 KB negligible (~$0.024/call).
        // FINAL critiques (attach.js:~416) pass ev.result directly
        // and are unaffected.
        await triggerGeminiCritique(sessionId, session, item, fullDiff,
          (session._currentTurnAssistantText || '').slice(0, 32000),
          { isIntermediate: true, stage, changedEntries: newEntries });
      } catch (err) {
        console.error(`[td-33] stage-done(${stage}) critique failed: ${err.message}`);
        // bug-68 follow-up (2026-06-07): emit a chat note for uncaught
        // exceptions in the stage-done handler. Pre-follow-up errors
        // landed in stderr only, leaving the user with the sentinel-
        // received note + nothing else. Common causes: readDiff
        // exception (corrupt git state), getSessionRecord race, an
        // error thrown by triggerGeminiCritique before its own error
        // path landed. The note doesn't transition stageState
        // (state is unknown after an exception); the user should
        // re-dispatch via ▶ Run if the issue is transient.
        try {
          const activeForNote = session._activeRunItem;
          const itemIdForNote = activeForNote && activeForNote.itemId;
          if (itemIdForNote) {
            _emitCritiqueSkipNote(sessionId, session, {
              stage, itemId: itemIdForNote, reason: 'handler-exception',
              message: `⚠️ Critic handler crashed during **${stage}** stage for \`${itemIdForNote}\`: \`${err && err.message ? err.message.slice(0, 200) : 'unknown error'}\`. The server log has the full stack trace. Try ▶ Run on the plan item again — if the error recurs, the underlying cause needs investigation (likely a git state issue, session race, or critic-pipeline bug).`,
            });
          }
        } catch (noteErr) {
          console.error(`[bug-68] follow-up handler-exception note failed: ${noteErr.message}`);
        }
      }
    });
    // Plan-item ▶ Run linkage: when the user kicks off a run via
    // the chat-pane Run button, handleChatMessage stamps
    // session._activeRunItem with the item id. On turn_result we
    // append a run record to that item (status / summary / cost /
    // turn ts) and broadcast the artifact update so all clients
    // see the linked status. One run per turn — _activeRunItem
    // clears after the outcome is stamped.
    // bug-68 (Option B addition 3): a separate agent-event listener
    // for the assistant_text → accept-ack clear hook. The terminal-
    // event listener below filters early to {turn_result,
    // iteration_aborted, fatal} — assistant_text wouldn't reach it.
    // This listener is intentionally narrow: it ONLY clears the
    // accept-ack expectation when an assistant_text arrives. Any
    // assistant_text counts as "claude picked up the dispatch" — we
    // don't need to inspect content because if claude is producing
    // output, the synthetic accept prompt reached the queue.
    session.on('agent-event', (ev) => {
      if (!ev || ev.type !== 'assistant_text') return;
      _onAssistantTextClearAckExpectation(session);
    });
    session.on('agent-event', (ev) => {
      if (!ev) return;
      // fr-48 bugfix: queue must see iteration_aborted + fatal as
      // terminal events too — not just turn_result. Pre-fix, a user-
      // initiated Stop (iteration_aborted) or fr-43 retry-exhausted
      // failure (fatal) left the queue's running entry stuck in
      // 'running' forever, blocking pending entries from advancing.
      // _advanceRunQueue's success-check evaluates subtype==='success'
      // which is false for both abort and fatal, so the entry gets
      // marked failed + queue auto-pauses (user can /qresume to
      // continue or /qcancel bug-X to drop the failed head).
      const terminalTypes = new Set(['turn_result', 'iteration_aborted', 'fatal']);
      if (!terminalTypes.has(ev.type)) return;
      // fr-51 fallback (belt-and-braces): if session._activeRunItem is
      // null/undefined when a terminal event arrives but the queue
      // clearly has a running entry, use THAT as the source of truth.
      // Pre-fix the early-return on !active left the queue stuck
      // forever in cases the original report shows (live repro:
      // bug-13 dispatched via the queue, turn_result subtype=success
      // fired, _activeRunItem was null when the listener ran → queue
      // entry stayed `running` indefinitely, 5 pending items blocked).
      // The fallback covers every scenario where _activeRunItem can be
      // lost — session re-instantiation by the 5-min reaper, a race
      // with another clear, or a dispatch path that bypassed the
      // marker regex. The [runQueue-diag] log line captures every
      // fallback occurrence so the underlying staleness can still be
      // root-caused in a follow-up pass without leaving the queue
      // broken in the meantime.
      let active = session._activeRunItem;
      if (!active || !active.itemId) {
        const rec = sessionsMod.getSessionRecord(sessionId);
        const runningEntry = rec && Array.isArray(rec.runQueue)
          && rec.runQueue.find((e) => e && e.status === 'running');
        if (runningEntry) {
          active = { itemId: runningEntry.itemId, startedAt: runningEntry.startedAt || null };
          console.log(`[runQueue-diag] ${sessionId} ${ev.type} — _activeRunItem was null; falling back to queue's running entry ${runningEntry.itemId} (fr-51 belt-and-braces)`);
        } else {
          return; // truly nothing to advance
        }
      }
      if (ev.type === 'turn_result') {
        // bug-fix (post-f71495f regression): stamp the run outcome
        // SYNCHRONOUSLY on the event tick, BEFORE any async critique
        // work. The pre-f71495f contract was "emit turn_result →
        // runs[] + run-summary comment land in rec immediately, same
        // tick as the event". f71495f's gated Gemini Critique wrapper
        // moved the stamp inside an `(async () => {})()` IIFE for the
        // success path, breaking that contract — same-tick consumers
        // (test/plan-run-comment.test.js + any real client reading
        // the store synchronously after the event) saw an empty runs[]
        // and undefined comments[0]. The fix: stamp first, kick off
        // critique afterwards. Critique never re-stamps (was already
        // double-stamping in the original happy path AND the
        // fallback — both calls hit the same artifact slot).
        try {
          _stampPlanItemRunOutcome(sessionId, active.itemId, ev, active.startedAt);
        } catch (err) {
          console.error('[plan-run] stamp outcome failed:', err.message);
        }
        const rec = sessionsMod.getSessionRecord(sessionId);
        if (ev.subtype === 'success' && active && active.itemId && rec && rec.absCwd) {
          // Async gated Gemini Critique workflow. No more stamping
          // here — that was done synchronously above. If the critique
          // fires, it takes over queue advancement (matches
          // f71495f's original intent — the return below skips the
          // _advanceRunQueue fallback). Otherwise the fallback path
          // advances normally.
          (async () => {
            try {
              const { listChangedFiles, readDiff } = require('./files');
              const changedInfo = await listChangedFiles(rec.absCwd);
              if (changedInfo && Array.isArray(changedInfo.entries) && changedInfo.entries.length > 0) {
                // Dispatch-label-drift fix (2026-06-03): filter the
                // changed-file list to exclude paths that were ALREADY
                // dirty at run-start. Only files this run actually
                // changed reach the critique. Without this filter, a
                // dispatch on an already-done plan item (e.g.
                // /run bug-51 when bug-51 is shipped) would feed
                // whatever WIP happens to sit in the working tree to
                // Gemini under the wrong label, producing fake
                // "Gemini flagged issues" notices.
                const baselineDirty = (active && active.baselineDirty instanceof Set) ? active.baselineDirty : new Set();
                const newEntries = changedInfo.entries.filter((e) => !baselineDirty.has(e.path));
                if (newEntries.length === 0) {
                  console.log(`[critique-gate] Plan item ${active.itemId} produced no run-attributable changes ` +
                    `(${changedInfo.entries.length} dirty paths were all baseline WIP; baselineHead=${active && active.baselineHead || 'unknown'}). ` +
                    `Skipping critique — there's nothing this run produced for Gemini to review.`);
                  // bug-68: surface the skip in chat so the user sees
                  // why no final verdict appeared. Mirrors the
                  // intermediate-critique skip note.
                  _emitCritiqueSkipNote(sessionId, session, {
                    stage: 'verify', itemId: active.itemId, reason: 'baseline-wip-only-final',
                    message: `📋 Final critic skipped for **${active.itemId}** — no run-attributable file changes detected (all dirty paths were modified before the run started). The run is technically complete, but if your fix isn't reflected on disk you may want to re-dispatch with **▶ Run** after making the actual changes.`,
                  });
                } else {
                  let fullDiff = '';
                  for (const entry of newEntries) {
                    const d = await readDiff(rec.absCwd, entry.path);
                    if (d && d.diff) {
                      fullDiff += `\n--- File: ${entry.path} ---\n${d.diff}\n`;
                    }
                  }
                  if (fullDiff.trim()) {
                    console.log(`[critique-gate] Plan item ${active.itemId} completed (${newEntries.length} run-attributable files, ${changedInfo.entries.length - newEntries.length} baseline-WIP excluded). Invoking Gemini Critique...`);
                    const planArtifact = rec.artifacts && rec.artifacts.plan;
                    const item = planArtifact && Array.isArray(planArtifact.items) && planArtifact.items.find(it => it.id === active.itemId);
                    if (item) {
                      // bug-64: parallel hole to bug-61's stage-done
                      // guard. bug-61 blocks subsequent stage-done
                      // sentinels when the previous verdict is
                      // unresolved, but the FINAL critique on
                      // turn_result success fires from THIS code path
                      // (not the stage-done handler) — bug-61's guard
                      // didn't cover it. Empirically the user observed:
                      //   "before the first stage (analyze) stage
                      //    verdict is accepted, the overall verdict is
                      //    also popped up. the process should be
                      //    paused until an verdict is accepted."
                      // Fix: defer the final critique if an
                      // intermediate stageState is still unresolved.
                      // Store the payload on rec._deferredFinalCritique
                      // — when the user resolves the intermediate
                      // (accept-stage / fix-stage via /critique/resolve
                      // OR clearActiveRunItem on Discard), the
                      // deferred critique fires from there. The defer
                      // is single-slot (we never have >1 unresolved
                      // intermediate thanks to bug-61's drop guard).
                      const ssCheck = stageStateMod.getStageState(item);
                      // bug-83: the 3-stage methodology (analyze →
                      // code → verify) introduces a hole in bug-64's
                      // defer semantics: bug-64 was designed for the
                      // legacy single-intermediate case. With three
                      // intermediates in series, an analyze-turn
                      // turn_result would defer the final critique
                      // (capturing the analyze-turn diff, which has no
                      // implementation yet), and the user's accept of
                      // analyze would fire that stale-data critique →
                      // "doesn't solve the problem" false negative.
                      // User-reported (bug-83): "general final QA fires
                      // before implementation lands, falsely flagging
                      // unsolved diffs."
                      //
                      // Fix: only DEFER (and only fire later) when
                      // we're at the LAST stage (verify). For
                      // analyze/code turn_results, suppress entirely
                      // — the multi-stage flow guarantees there will
                      // be a verify-stage turn_result later with the
                      // complete implementation diff, and THAT turn's
                      // gate will produce the correct deferred (or
                      // fire-now) outcome. Legacy single-shot runs
                      // (no stageState) reach triggerGeminiCritique
                      // below via the `ssCheck && …` short-circuit
                      // (ssCheck is null → both guards false → fire
                      // immediately), preserving pre-bug-83 behavior.
                      if (ssCheck && ssCheck.stage !== 'verify') {
                        console.log(`[bug-83] suppressing final critique for ${active.itemId} — current stageState is ${ssCheck.stage}.${ssCheck.status}, not at verify stage yet. Waiting for the verify-turn turn_result so the critique sees the complete implementation diff.`);
                        return;                     // queue stays paused; next turn_result will re-evaluate
                      }
                      if (ssCheck && (ssCheck.status === 'awaiting_verdict' || ssCheck.status === 'awaiting_accept')) {
                        console.log(`[bug-64] deferring final critique for ${active.itemId} — current stageState is ${ssCheck.stage}.${ssCheck.status}; will fire on resolve`);
                        rec._deferredFinalCritique = {
                          itemId: active.itemId,
                          item,                       // captured snapshot
                          diff: fullDiff,
                          claudeOutput: ev.result || '',
                          changedEntries: newEntries,
                          deferredAt: new Date().toISOString(),
                        };
                        sessionsMod.saveStore();
                        return;                     // queue stays paused until deferred fires
                      }
                      const { triggerGeminiCritique } = require('./critique');
                      // td-33 r2 (context enrichment): pass the
                      // changed entries through so the critic prompt
                      // can include each file's full current content
                      // — not just the diff hunks. User-asked: "should
                      // always make enough information is provided to
                      // the critic for full assessment."
                      await triggerGeminiCritique(sessionId, session, item, fullDiff, ev.result || '', { changedEntries: newEntries });
                      return;                       // critique took over queue advancement
                    }
                  }
                }
              }
            } catch (err) {
              console.error('[critique-gate] Error during critique generation:', err.message);
            }
            // Fallback: no critique fired — advance the queue.
            try {
              _advanceRunQueue(sessionId, session, active.itemId, ev);
            } catch (err) {
              console.error('[runQueue] auto-advance failed:', err.message);
            }
          })();
          // bug-57: keep _activeRunItem alive across multi-stage runs.
          // Only clear when the agent never emitted any [stage: X
          // done] sentinel — that's the legacy one-shot case where
          // a single turn_result completes the run. When stage
          // sentinels were emitted, _activeRunItem must survive so
          // the stage-done handler at line 192 can dispatch the
          // intermediate critique for stages 2 + 3 (those stages
          // happen in LATER turns, after this turn_result fires).
          // The clear-on-verify-accept happens via the new
          // POST /sessions/:id/run/done route (bug-57) — wired from
          // the verdict pane's ✓ Accept / ✗ Discard handlers.
          if (!session._sawStageSentinelInRun) {
            session._activeRunItem = null;
          }
          return;
        }
      } else {
        // For abort/fatal, stamp a brief synthetic "aborted"/"error"
        // run record so the plan item's chip strip reflects the
        // outcome even when the queue is what fired the terminal.
        const synthStatus = ev.type === 'iteration_aborted' ? 'aborted' : 'error';
        try {
          _stampPlanItemStatus(sessionId, active.itemId, synthStatus,
            ev.type === 'iteration_aborted' ? 'interrupted by Stop' : (ev.error || 'fatal'));
        } catch (err) {
          console.error('[plan-run] stamp status (' + ev.type + ') failed:', err.message);
        }
      }
      try {
        _advanceRunQueue(sessionId, session, active.itemId, ev);
      } catch (err) {
        console.error('[runQueue] auto-advance failed:', err.message);
      }
      session._activeRunItem = null;
    });
    session.on('exit', () => {
      setTimeout(() => {
        const cur = sessions.get(sessionId);
        if (cur === session) sessions.delete(sessionId);
      }, 250);
    });
  }
  return session;
}

// Update the running status of a plan item before a turn lands. The
// matching plan item's last `runs[]` entry is replaced (if mid-run)
// or appended (if starting). Broadcasts an artifact state-update so
// chat-pane re-renders the row's status chip.
function _stampPlanItemStatus(sessionId, itemId, status, summary) {
  const rec = sessionsMod.getSessionRecord(sessionId);
  if (!rec) return;
  const planArtifact = rec.artifacts && rec.artifacts.plan;
  if (!planArtifact || !Array.isArray(planArtifact.items)) return;
  const item = planArtifact.items.find((it) => it && it.id === itemId);
  if (!item) return;
  if (!Array.isArray(item.runs)) item.runs = [];
  item.runs.push({
    status,
    ts: new Date().toISOString(),
    summary: summary || null,
  });
  // Cap runs[] at the last 10 so a busy item doesn't bloat plan.json.
  if (item.runs.length > 10) item.runs = item.runs.slice(-10);
  sessionsMod.saveStore();
  const session = sessions.get(sessionId);
  if (session && typeof session.emit === 'function') {
    session.emit('state-update', { kind: 'artifact', artifactType: 'plan', artifact: planArtifact });
  }
}

// bug-60: extract a concise one-line summary from claude's final
// assistant text. Pre-bug-60, _stampPlanItemRunOutcome pasted up to
// 800 chars of multi-paragraph result text into the auto-comment
// body — the plan view turned into a wall of text (median 842
// chars / multiple paragraphs per comment in real plan.json data).
// Now: first non-empty line of the result, stripped of leading
// markdown / glyph chrome, whitespace-collapsed, capped at 140
// chars. The FULL text (up to 2000 chars) still lives at
// item.runs[last].result for drill-down — only the COMMENT body
// shrinks.
//
// Heuristic, not LLM-summarized: cheap, deterministic, runs inline.
// Empirically the first line of claude's wrap-up is what a user
// scanning the plan view actually wants ("Fixed X by Y.", "Shipped
// in commit abc.", etc.).
const RUN_SUMMARY_ONE_LINE_CAP = 140;
const RUN_SUMMARY_PLACEHOLDER = '(no summary — see chat timeline)';
function _extractRunOutcomeSummaryLine(rawText) {
  if (rawText == null) return RUN_SUMMARY_PLACEHOLDER;
  const s = String(rawText).trim();
  if (!s) return RUN_SUMMARY_PLACEHOLDER;
  // First non-empty line.
  let first = '';
  for (const ln of s.split(/\r?\n/)) {
    const t = ln.trim();
    if (t) { first = t; break; }
  }
  if (!first) return RUN_SUMMARY_PLACEHOLDER;
  // Strip stacked leading prefix junk so e.g. "## ✅ **Shipped** in commit"
  // → "Shipped in commit". Loop because real entries chain multiple
  // prefix layers — heading + glyph + bold + bullet are all common.
  // Cap iterations to 6 so a pathological input can't spin.
  let prev = '';
  for (let i = 0; i < 6 && prev !== first; i++) {
    prev = first;
    first = first.replace(/^[#>*\-]+\s*/, '');                      // md leaders
    first = first.replace(/^\*\*\s*/, '');                          // bold-start
    // Common claude/myco status glyphs: ✅ ❌ ⏳ ✨ ℹ 📋 🧪 🏗 ⚠
    first = first.replace(/^[✅❌⏳✨ℹ⚠📋🧪🏗]+\s*/, '');
  }
  // Drop a trailing `**` if the leading-strip ate the opening one
  // but left the close — keeps "**Shipped**" → "Shipped".
  first = first.replace(/\*\*$/, '').trim();
  // Collapse internal whitespace runs.
  first = first.replace(/\s+/g, ' ').trim();
  if (!first) return RUN_SUMMARY_PLACEHOLDER;
  if (first.length > RUN_SUMMARY_ONE_LINE_CAP) {
    first = first.slice(0, RUN_SUMMARY_ONE_LINE_CAP - 1) + '…';
  }
  return first;
}

// Append a terminal "run outcome" record to a plan item after the
// turn_result event lands. status = success / error / etc. (matches
// the agent's turn subtype). summary captures cost + duration so
// the UI chip can show e.g. "✓ done · 6.4s".
//
// ALSO appends an auto-generated "run summary" comment to item.comments
// (user='claude', meta.kind='run-summary') so the findings of a
// dispatched run live on the item itself — clicking the comment thread
// shows the per-run log inline with any human discussion. One summary
// comment per run.
//
// bug-60: the comment body is now a SINGLE LINE — `${glyph} ${oneLine}
// · ${metrics tail}`. Pre-bug-60 the body was two paragraphs (header
// then a multi-paragraph paste of outcome.result). The full result
// text (up to 2000 chars) is still preserved on item.runs[last].result
// for drill-down.
function _stampPlanItemRunOutcome(sessionId, itemId, turnResultEv, startedAt) {
  const rec = sessionsMod.getSessionRecord(sessionId);
  if (!rec) return;
  const planArtifact = rec.artifacts && rec.artifacts.plan;
  if (!planArtifact || !Array.isArray(planArtifact.items)) return;
  const item = planArtifact.items.find((it) => it && it.id === itemId);
  if (!item) return;
  if (!Array.isArray(item.runs)) item.runs = [];
  // Replace the trailing "running" placeholder with the outcome if
  // present, else append.
  const status = (turnResultEv.subtype === 'success') ? 'success' : 'error';
  const u = turnResultEv.usage || {};
  const inTok = u.input_tokens || 0;
  const outTok = u.output_tokens || 0;
  const durS = turnResultEv.durationMs != null
    ? (turnResultEv.durationMs / 1000).toFixed(1) + 's'
    : null;
  const costStr = (typeof turnResultEv.totalCostUsd === 'number')
    ? '$' + turnResultEv.totalCostUsd.toFixed(4)
    : null;
  const summary = [
    durS,
    `${inTok}→${outTok} tok`,
  ].filter(Boolean).join(' · ');
  const outcome = {
    status,
    ts: new Date().toISOString(),
    startedAt: startedAt || null,
    summary,
    result: turnResultEv.result ? String(turnResultEv.result).slice(0, 2000) : null,
  };
  const last = item.runs[item.runs.length - 1];
  if (last && last.status === 'running') {
    item.runs[item.runs.length - 1] = outcome;
  } else {
    item.runs.push(outcome);
  }
  if (item.runs.length > 10) item.runs = item.runs.slice(-10);

  // Auto-summary comment — surfaces the run's findings ON THE ITEM so a
  // teammate scanning the plan sees "what did claude actually do for
  // this todo" without leaving the Plan tab. Tagged user='claude' +
  // meta.kind='run-summary' so the UI can render it distinctively.
  //
  // bug-60: SINGLE-LINE shape. Pre-bug-60 this composed
  //   `${glyph} ${status} · ${metrics}\n\n${800-char paste of outcome.result}`
  // which median'd 842 chars and topped out around 5,000 / 60+ lines in
  // real plan.json data — clutter the user explicitly called out.
  // Now: glyph + first-line summary extracted from outcome.result +
  // inline metrics tail, total ≤ ~200 chars. The full text remains
  // available at item.runs[last].result for drill-down.
  if (!Array.isArray(item.comments)) item.comments = [];
  const glyph = status === 'success' ? '✓' : '⚠';
  const oneLineSummary = _extractRunOutcomeSummaryLine(outcome.result);
  const tailBits = [durS, costStr, `${inTok}↓/${outTok}↑`].filter(Boolean).join(' · ');
  const summaryText = `${glyph} ${oneLineSummary}${tailBits ? ` · ${tailBits}` : ''}`;
  item.comments.push({
    id: crypto.randomBytes(6).toString('hex'),
    user: 'claude',
    text: summaryText,
    ts: outcome.ts,
    meta: { kind: 'run-summary', runStartedAt: outcome.startedAt || null },
  });
  // Keep the same 50-comment cap as the manual comment-add path so a
  // chatty item doesn't bloat plan.json. Oldest dropped first.
  if (item.comments.length > 50) item.comments = item.comments.slice(-50);

  sessionsMod.saveStore();
  const session = sessions.get(sessionId);
  if (session && typeof session.emit === 'function') {
    session.emit('state-update', { kind: 'artifact', artifactType: 'plan', artifact: planArtifact });
  }
}

// fr-48: queue auto-advance. Called from the turn_result agent-event
// listener after _stampPlanItemRunOutcome. If the finished item was
// the head of the run-queue, mark it success/failed and dispatch the
// next pending entry (or pause on failure). Silently no-ops when the
// finished item wasn't queued (manual ▶ Run click — leaves the queue
// alone).
function _advanceRunQueue(sessionId, session, finishedItemId, turnResultEv) {
  const rec = sessionsMod.getSessionRecord(sessionId);
  if (!rec || !Array.isArray(rec.runQueue) || !rec.runQueue.length) return;
  // Only care if the just-finished item is the head of our queue's
  // running entry — manual ▶ Run clicks don't enter the queue.
  const runningEntry = rec.runQueue.find((e) => e.itemId === finishedItemId && e.status === 'running');
  if (!runningEntry) return;
  const success = !!(turnResultEv && (turnResultEv.subtype === 'success' || (turnResultEv.raw && turnResultEv.raw.subtype === 'success')));
  runQueue.markFinished(rec, finishedItemId, success);
  sessionsMod.saveStore();
  session.emit('state-update', { kind: 'runQueue', state: runQueue.getQueueState(rec) });
  if (!success) {
    console.log(`[runQueue] ${sessionId} ${finishedItemId} failed — queue auto-paused. Use /qresume or POST /queue/resume to continue.`);
    session.emit('chat', {
      user: ASSISTANT_USER,
      text: `⏸ run-queue paused — \`${finishedItemId}\` did not finish successfully. Use \`/qresume\` to dispatch the next pending item.`,
      ts: new Date().toISOString(),
      meta: { kind: 'runQueue-paused' },
    });
    return;
  }
  // Advance to next pending.
  const next = runQueue.peekNextPending(rec);
  if (!next) {
    console.log(`[runQueue] ${sessionId} drained — last item ${finishedItemId} done, no pending follow-ups`);
    return;
  }
  // Load the item from the artifact + dispatch.
  const planArtifact = rec.artifacts && rec.artifacts.plan;
  const item = planArtifact && Array.isArray(planArtifact.items)
    && planArtifact.items.find((it) => it && it.id === next.itemId);
  if (!item) {
    console.error(`[runQueue] ${sessionId} next item ${next.itemId} no longer exists in plan.json — auto-cancelling`);
    runQueue.removeFromQueue(rec, next.itemId);
    sessionsMod.saveStore();
    session.emit('state-update', { kind: 'runQueue', state: runQueue.getQueueState(rec) });
    // Recurse to try the one after next.
    return _advanceRunQueue(sessionId, session, finishedItemId, turnResultEv);
  }
  runQueue.markRunning(rec, next.itemId);
  sessionsMod.saveStore();
  session.emit('state-update', { kind: 'runQueue', state: runQueue.getQueueState(rec) });
  const artifactsMod = require('./artifacts');
  const dispatchText = artifactsMod.buildArtifactRunText(next.type, item, runningEntry.addedBy || 'queue');
  console.log(`[runQueue] ${sessionId} auto-dispatching ${next.itemId} (next of ${rec.runQueue.length} entries)`);
  handleChatMessage(sessionId, session, runningEntry.addedBy || 'queue', dispatchText);
}

function killSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) { try { s.kill(); } catch {} sessions.delete(sessionId); }
}

// Handle a `{t:'menu-pick', n, hash?}` frame from the client — the
// modal-popup button click. In agent-mode the resolveMenuPick callback
// on the AgentSession settles the pending SDK canUseTool promise; we
// ALSO stamp the chat row's meta.answered + meta.pickedN so a refresh
// shows the picker as resolved.
function handleMenuPick(sessionId, session, n, hash) {
  if (!Number.isFinite(n) || n < 1 || n > 9) return;
  _markMenuChatAnswered(sessionId, n, hash);
  if (!session || !session.alive) {
    console.log(`[menu-pick] ${sessionId} silent-drop: session not alive (n=${n})`);
    return;
  }
  if (typeof session.resolveMenuPick === 'function' && hash) {
    const handled = session.resolveMenuPick(hash, n);
    console.log(`[menu-pick] ${sessionId} hash=${hash.slice(-12)} n=${n} handled=${handled}`);
    return;
  }
  console.log(`[menu-pick] ${sessionId} silent-drop: no resolveMenuPick (n=${n} hash=${hash || 'none'})`);
}

// Multi-select toggle: flip checkbox <n>'s checked flag. The
// AgentSession's pending.options array is the SAME object reference as
// the chat row's menu.options, so _toggleMenuChatCheckbox's single
// in-place mutation propagates to both the persisted record AND the
// live pending entry that resolveMenuSubmit reads from later. No
// double-flip — see the 2026-05-15 test006 regression note in the old
// pty.js for the symptom this guards against.
function handleMenuToggle(sessionId, session, n, hash) {
  if (!Number.isFinite(n) || n < 1 || n > 9) return;
  if (!session || !session.alive) return;
  if (hash) {
    _toggleMenuChatCheckbox(sessionId, n, hash);
    console.log(`[menu-toggle] ${sessionId} hash=${hash.slice(-12)} n=${n}`);
  }
}

// Multi-select submit: AgentSession.resolveMenuSubmit gathers checked
// options + settles the SDK promise with comma-separated labels (the
// documented multi-select answer format).
function handleMenuSubmit(sessionId, session, hash) {
  if (!session || !session.alive) return;
  if (typeof session.resolveMenuSubmit === 'function' && hash) {
    _markMenuChatAnswered(sessionId, 0, hash, /*submit*/ true);
    const handled = session.resolveMenuSubmit(hash);
    console.log(`[menu-submit] ${sessionId} hash=${hash.slice(-12)} handled=${handled}`);
    return;
  }
  console.log(`[menu-submit] ${sessionId} silent-drop: no resolveMenuSubmit (hash=${hash || 'none'})`);
}

// Mirror assistant text from the transcript stream into rec.chat.
//
// PTY-era purpose: rec.chat was the only refresh-survivable record of
// claude's reply prose, so this helper mirrored every transcript line
// into it. Each WS attach forwarded the mirrored row as a 'chat'
// frame to live clients so they saw the reply alongside user messages.
//
// SDK-era: the AgentSession buffer (persisted to <cwd>/_myco_/events.jsonl
// and hydrated on construction) is now the canonical record of
// assistant_text; the agent-replay frame on attach reconstitutes it
// for reloads, and the live 'agent-event' frame renders new replies
// as they stream. Mirroring into rec.chat AND emitting 'chat' on top
// of that produced a second chat-bubble next to every agent_text
// card — the bug this comment now documents.
//
// Current behavior:
//   - Still persists into rec.chat with meta.fromTranscript:true, so
//     historical sessions keep their old shape on disk (no data
//     migration needed).
//   - Does NOT emit 'chat' over the live socket; the agent-event path
//     is the sole live channel for assistant text.
//   - sessions.getChatHistory filters fromTranscript rows out of the
//     chat-history frame sent on attach, so reloads don't dup either.
//
// Idempotent via meta.transcriptUuid (each jsonl entry has a stable
// uuid, multiple WS connections only land each row once).
function persistAssistantTextToChat(sessionId, newMsgs) {
  if (!Array.isArray(newMsgs) || !newMsgs.length) return;
  const store = sessionsMod.loadStore();
  const rec = store.sessions[sessionId];
  if (!rec) return;
  if (!Array.isArray(rec.chat)) rec.chat = [];
  const seen = new Set();
  for (const c of rec.chat) {
    if (c && c.meta && c.meta.transcriptUuid) seen.add(c.meta.transcriptUuid);
  }
  let mirrored = 0, skipped = 0;
  for (const m of newMsgs) {
    if (!m || m.role !== 'assistant') continue;
    if (!m.text || !m.text.trim()) { skipped++; continue; }
    if (!m.uuid) { skipped++; continue; }
    if (seen.has(m.uuid)) { skipped++; continue; }
    seen.add(m.uuid);
    const reply = {
      user: 'claude',
      text: m.text.trim(),
      ts: m.ts || new Date().toISOString(),
      meta: { transcriptUuid: m.uuid, fromTranscript: true },
    };
    sessionsMod.appendChatMessage(sessionId, reply);
    // NOTE: deliberately NOT emitting 'chat' here. The agent-event
    // stream (assistant_text) is the live channel; emitting 'chat'
    // too produces a duplicate render in #chat-messages.
    mirrored++;
  }
  if (mirrored > 0) {
    console.log(`[persist-chat] ${sessionId} mirrored=${mirrored} skipped=${skipped} (rec.chat now ${rec.chat.length}; live emit suppressed — agent-event carries assistant_text)`);
  }
}

// Stamp answered + pickedN onto a menu-broadcast chat row. When `hash`
// is provided, find the row whose `meta.menu.hash` equals it (race-free
// across multiple unanswered menus). When omitted, fall back to "latest
// unanswered". For multi-select submit: pass submit=true with n=0; the
// row gets answered=true with no pickedN, and the chat picker reads the
// per-option `checked` flags on the persisted menu to render the
// "✓ Submitted with [a, c]" summary.
function _markMenuChatAnswered(sessionId, n, hash, submit) {
  if (!sessionId) return;
  try {
    const store = sessionsMod.loadStore();
    const rec = store.sessions[sessionId];
    if (!rec || !Array.isArray(rec.chat)) return;
    for (let i = rec.chat.length - 1; i >= 0; i--) {
      const m = rec.chat[i];
      if (!m || !m.meta || m.meta.kind !== 'menu') continue;
      if (hash) {
        const mh = m.meta.menu && m.meta.menu.hash;
        if (mh !== hash) continue;
        if (m.meta.answered) return;
      } else {
        if (m.meta.answered) return;
      }
      if (!submit) {
        const opts = (m.meta.menu && m.meta.menu.options) || [];
        if (!opts.some((o) => o.n === n)) return;
        m.meta.pickedN = n;
      } else {
        m.meta.submitted = true;
      }
      m.meta.answered = true;
      sessionsMod.saveStore();
      _emitMenuStateUpdate(sessionId, m);
      console.log(`[menu-pick] ${sessionId} stamped answered=true ${submit ? 'submitted' : `pickedN=${n}`}${hash ? ' (byHash)' : ''}`);
      return;
    }
  } catch (err) {
    console.error(`[menu-pick] persist failed for ${sessionId}: ${err.message}`);
  }
}

// Walk the chat history and stamp every unanswered, unsuperseded menu
// row with meta.superseded = true. Called from menu.js before
// broadcasting a fresh menu, and from sessions.ensureLiveSession after
// respawning an agent — any chat row still flagged kind=menu without
// answered/superseded refers to a canUseTool promise that no live
// receiver can resolve, so we collapse it to a one-line resolved card.
function _supersedeStaleMenus(sessionId) {
  if (!sessionId) return;
  try {
    const store = sessionsMod.loadStore();
    const rec = store.sessions[sessionId];
    if (!rec || !Array.isArray(rec.chat)) return;
    let changed = false;
    for (let i = rec.chat.length - 1; i >= 0; i--) {
      const m = rec.chat[i];
      if (!m || !m.meta || m.meta.kind !== 'menu') continue;
      if (m.meta.answered) continue;
      if (m.meta.superseded) continue;
      m.meta.superseded = true;
      changed = true;
      _emitMenuStateUpdate(sessionId, m);
    }
    if (changed) sessionsMod.saveStore();
  } catch (err) {
    console.error(`[menu-supersede] failed for ${sessionId}: ${err.message}`);
  }
}

// Push a menu row's updated meta to every attached client. The chat
// pane locates the row by transcriptUuid (the stable per-message id
// stamped at broadcast time) and re-renders that single row in place.
function _emitMenuStateUpdate(sessionId, m) {
  if (!m || !m.meta) return;
  const session = sessions.get(sessionId);
  if (!session) return;
  const hash = (m.meta.menu && m.meta.menu.hash) || null;
  const listenerCount = typeof session.listenerCount === 'function'
    ? session.listenerCount('state-update') : 0;
  console.log(`[state-update] ${sessionId} kind=menu pickedN=${m.meta.pickedN} answered=${!!m.meta.answered} superseded=${!!m.meta.superseded} listeners=${listenerCount} hash=${hash ? hash.slice(0, 60) : 'null'}`);
  session.emit('state-update', {
    kind: 'menu',
    messageUuid: m.meta.transcriptUuid || null,
    hash,
    meta: m.meta,
  });
}

// Flip the `checked` flag on option <n> of the multi-select chat row
// matching `hash`. No "answered" stamp — the row stays interactive
// until the user hits Submit. Persisted so a reconnect/refresh sees the
// most recent UI state.
function _toggleMenuChatCheckbox(sessionId, n, hash) {
  if (!sessionId) return;
  try {
    const store = sessionsMod.loadStore();
    const rec = store.sessions[sessionId];
    if (!rec || !Array.isArray(rec.chat)) return;
    for (let i = rec.chat.length - 1; i >= 0; i--) {
      const m = rec.chat[i];
      if (!m || !m.meta || m.meta.kind !== 'menu') continue;
      const mh = m.meta.menu && m.meta.menu.hash;
      if (hash && mh !== hash) continue;
      if (m.meta.answered) return;
      const opts = (m.meta.menu && m.meta.menu.options) || [];
      const opt = opts.find((o) => o.n === n);
      if (!opt || !opt.checkbox) return;
      opt.checked = !opt.checked;
      sessionsMod.saveStore();
      _emitMenuStateUpdate(sessionId, m);
      return;
    }
  } catch (err) {
    console.error(`[menu-toggle] persist failed for ${sessionId}: ${err.message}`);
  }
}

// Watch a session's JSONL transcript and mirror assistant text into
// rec.chat (so the chat pane survives a refresh) + feed tool-progress
// ingestion. Phase 9 step 9 retired the transcript-init / transcript-
// delta / transcript-waiting WS frames — the client no longer has a
// JSONL-rendering pane. The watcher is pure server-side now.
//
// Handles the new-session race: a freshly spawned claude takes ~5s to
// write its first JSONL line, so resolveTranscriptPath returns null on
// the initial attach. The 3s poll detects when the file appears (and
// when a /resume re-exec writes to a NEW path) and rebinds.
//
// Returns a cleanup function the caller wires onto ws.on('close').
function streamTranscriptToWs(sessionId, ws) {
  let pollTimer = null;
  let unwatch = null;
  let closed = false;
  let watchingPath = null;
  const session = sessions.get(sessionId);

  function startWatching(filePath) {
    watchingPath = filePath;
    transcriptMod.readNewMessages(filePath, 0).then(({ messages, bytesRead }) => {
      if (closed) return;
      persistAssistantTextToChat(sessionId, messages);
      if (session && typeof session.ingestTranscriptForToolProgress === 'function') {
        session.ingestTranscriptForToolProgress(messages);
      }
      unwatch = transcriptMod.watchTranscript(filePath, (newMsgs) => {
        if (closed) return;
        persistAssistantTextToChat(sessionId, newMsgs);
        if (session && typeof session.ingestTranscriptForToolProgress === 'function') {
          session.ingestTranscriptForToolProgress(newMsgs);
        }
      }, { startByte: bytesRead });
    }).catch(() => {});
  }

  const initialPath = transcriptMod.resolveTranscriptPath(sessionId);
  if (initialPath) startWatching(initialPath);

  pollTimer = setInterval(() => {
    if (closed || ws.readyState !== ws.OPEN) {
      clearInterval(pollTimer); pollTimer = null; return;
    }
    const p = transcriptMod.resolveTranscriptPath(sessionId);
    if (!p || p === watchingPath) return;
    console.log(`[transcript-rebind] ${sessionId} ${watchingPath || '(none)'} -> ${p}`);
    if (unwatch) { try { unwatch(); } catch {} unwatch = null; }
    startWatching(p);
  }, 3000);

  return function cleanup() {
    closed = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (unwatch) { try { unwatch(); } catch {} unwatch = null; }
  };
}

// Owner WS attach. Streams the AgentSession's structured SDK events as
// `agent-event` frames, replays the per-session event ring on attach so
// reconnects see prior context, and routes chat / menu frames back into
// handleChatMessage / handleMenuPick(Toggle|Submit).
// Session keep-alive grace — when the last client disconnects, we
// don't kill the session immediately. The user may be in the middle
// of a transient drop (closed laptop, switched networks, refreshing
// the tab) and expect to resume where they left off. SESSION_
// KEEPALIVE_GRACE_MS gives them a 5-minute window to reconnect;
// past that the SDK process is reaped to free memory + tokens.
// Reattaching within the window cancels the pending kill.
const SESSION_KEEPALIVE_GRACE_MS = 5 * 60 * 1000;
// bug-21 pattern 2 (reaper-kills-subagent-mid-flight): when the 5-min
// timer fires with no attached clients, we used to call killSession
// unconditionally. Long-running research subagents routinely have
// multi-minute internal phases (model thinking / synthesis / sub-API
// calls) that produce no events on the parent stream, so the parent
// looks "idle" to the reaper even though work is genuinely in flight.
// Killing in that window orphans the Agent tool_use — the parent SDK
// iteration is left waiting on a tool_result that will never arrive.
//
// FIX: on timer fire, consult the live AgentSession's openToolCalls
// Map (already tracked for the chat-pane "waiting on Tool · 47s"
// indicator). If > 0, defer the reap for another grace slice. The
// SESSION_MAX_DEFER_MS hard cap below protects against a genuinely-
// hung tool indefinitely pinning a session in memory — past the cap
// we reap anyway with reason 'max-defer-exceeded'.
const SESSION_MAX_DEFER_MS = 30 * 60 * 1000;  // 30 min hard cap
const _sessionKillTimers = new Map();
const _sessionDeferState = new Map();   // sessionId → { totalDeferMs }

function _scheduleSessionKill(sessionId, reason) {
  const existing = _sessionKillTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => _onKillTimerFire(sessionId, reason), SESSION_KEEPALIVE_GRACE_MS);
  _sessionKillTimers.set(sessionId, timer);
}

// Extracted from _scheduleSessionKill so the defer path can re-arm the
// timer without duplicating the setTimeout call. Also makes the
// inspect-then-defer-or-kill decision tree easier to read.
function _onKillTimerFire(sessionId, reason) {
  _sessionKillTimers.delete(sessionId);
  // Only kill if STILL idle — defensive in case the timer fires
  // a hair after a reconnect cancelled it (race with setTimeout's
  // clearing semantics is rare but possible).
  const set = _sessionPresence.get(sessionId);
  if (set && set.size > 0) {
    console.log(`[keepalive] ${sessionId} grace expired but ${set.size} client(s) reattached — staying alive`);
    _sessionDeferState.delete(sessionId);  // fresh defer window if they later disconnect again
    return;
  }
  // bug-21 pattern 2: defer reap while in-flight tool work exists.
  const session = sessions.get(sessionId);
  const openToolCalls = (session && session.openToolCalls && session.openToolCalls.size) || 0;
  if (openToolCalls > 0) {
    const ds = _sessionDeferState.get(sessionId) || { totalDeferMs: 0 };
    ds.totalDeferMs += SESSION_KEEPALIVE_GRACE_MS;
    _sessionDeferState.set(sessionId, ds);
    if (ds.totalDeferMs >= SESSION_MAX_DEFER_MS) {
      console.log(`[keepalive] ${sessionId} max-defer-exceeded after ${ds.totalDeferMs}ms with ${openToolCalls} tool(s) still in flight — reaping anyway (likely hung tool)`);
      _sessionDeferState.delete(sessionId);
      killSession(sessionId);
      return;
    }
    console.log(`[keepalive] ${sessionId} deferring reap — ${openToolCalls} tool(s) in flight (totalDeferMs=${ds.totalDeferMs}, capMs=${SESSION_MAX_DEFER_MS})`);
    // Re-arm for another grace slice.
    const timer = setTimeout(() => _onKillTimerFire(sessionId, reason), SESSION_KEEPALIVE_GRACE_MS);
    _sessionKillTimers.set(sessionId, timer);
    return;
  }
  console.log(`[keepalive] ${sessionId} grace expired (${reason || 'no clients'}) — reaping`);
  _sessionDeferState.delete(sessionId);
  killSession(sessionId);
}

function _cancelSessionKill(sessionId) {
  const existing = _sessionKillTimers.get(sessionId);
  if (!existing) {
    _sessionDeferState.delete(sessionId);  // defensive cleanup
    return;
  }
  clearTimeout(existing);
  _sessionKillTimers.delete(sessionId);
  // bug-21 pattern 2: clear accumulated defer time so the next
  // disconnect cycle starts with a fresh 30-min cap window.
  _sessionDeferState.delete(sessionId);
  console.log(`[keepalive] ${sessionId} reaper cancelled — client reattached during grace`);
}

// Presence tracking — module-level map of sessionId → Set of attached
// client info. On every attach/detach we broadcast the current
// roster to all attached clients of that session so the chat-pane
// header can render avatar chips for who's looking. Owners and
// viewers (share-link guests) both show up; role distinguishes them.
const _sessionPresence = new Map();

function _registerPresence(sessionId, info) {
  let set = _sessionPresence.get(sessionId);
  if (!set) { set = new Set(); _sessionPresence.set(sessionId, set); }
  set.add(info);
}

function _unregisterPresence(sessionId, info) {
  const set = _sessionPresence.get(sessionId);
  if (!set) return;
  set.delete(info);
  if (set.size === 0) _sessionPresence.delete(sessionId);
}

function _presencePayload(sessionId) {
  const set = _sessionPresence.get(sessionId);
  if (!set) return [];
  const users = [];
  for (const info of set) {
    users.push({
      login: info.login || '(anon)',
      role: info.role || 'viewer',
      attachedAt: info.attachedAt,
    });
  }
  return users;
}

function _broadcastPresence(sessionId) {
  const set = _sessionPresence.get(sessionId);
  if (!set) return;
  const users = _presencePayload(sessionId);
  const frame = JSON.stringify({ t: 'presence', users });
  for (const info of set) {
    if (info.ws && info.ws.readyState === info.ws.OPEN) {
      try { info.ws.send(frame); } catch {}
    }
  }
}

// bug-17 fix: kick every WS for (sessionId, login). Used by
// sessions.addAdminToSession / removeAdminFromSession when the
// promoted/demoted user has an existing WS — closing it forces the
// client's reconnect logic to fire, and the new attach evaluates
// isOwnerOrAdmin against the freshly-mutated rec.admins, landing the
// user on the correct branch (owner vs viewer). Kicks regardless of
// role so it covers both directions (grant: kick viewer → reconnect
// as owner-branch; revoke: kick owner-branch → reconnect as viewer).
// Returns the number of WSes closed (0 on missing presence / no
// match — safe no-op).
function _kickViewerByLogin(sessionId, login) {
  const set = _sessionPresence.get(sessionId);
  if (!set || !login) return 0;
  let kicked = 0;
  for (const info of set) {
    if (info.login !== login) continue;
    try {
      if (info.ws && typeof info.ws.close === 'function') {
        info.ws.close();
        kicked++;
      }
    } catch {}
  }
  if (kicked > 0) {
    console.log(`[bug-17-kick] ${sessionId} closed ${kicked} ws for login=${login} (admin grant/revoke triggered reconnect)`);
  }
  return kicked;
}

function attachWebSocket(session, ws, opts = {}) {
  return _attachAgentWebSocket(session, ws, opts);
}

// bug-9 round 6: pre-merged timeline frame for initial attach.
// Reads `chatBytes` worth of chat-history + `eventBytes` worth of
// agent events, merges them by ts, sends as ONE chronologically-
// ordered list. Replaces the previous round-5 design where
// chat-history + agent-replay were two independent frames that
// each wiped their own pane state — that caused order corruption
// on tab-switch/reconnect because the two pane streams had to be
// post-merged client-side and a race could leave them out of
// order until the next render pass.
//
// Wire shape:
//   { t: 'timeline-init',
//     items: [ { kind: 'chat',  message: {...} }
//            , { kind: 'event', event:   {...} }
//            , … ],
//     totals: { chat: N, events: M },     // server-side totals
//     bytes:  { chat: cB, events: eB } }  // bytes actually shipped
//
// items are sorted by ts ascending (oldest first → newest last).
// The client renders them in order; live `chat` + `agent-event`
// frames continue to flow separately afterwards and naturally land
// at the end of the timeline (newer than anything in items).
function _shipTimelineInit(session, ws, sessionId, chatBytes, eventBytes, includeEvents) {
  if (ws.readyState !== ws.OPEN) return;
  // Chat slice.
  const chatHistory = sessionsMod.getChatHistory(sessionId, { maxBytes: chatBytes });
  const chatTotal = sessionsMod.getChatHistoryLength(sessionId);
  // Event slice (owner attach only). Dedup the buffer first (bug-7
  // round 2), then byte-trim to fit `eventBytes`.
  let events = [];
  let eventTotal = 0;
  if (includeEvents && Array.isArray(session.buffer) && session.buffer.length) {
    const seen = new Set();
    for (const ev of session.buffer) {
      let sig;
      try { sig = JSON.stringify(ev); } catch { sig = null; }
      if (sig && seen.has(sig)) continue;
      if (sig) seen.add(sig);
      events.push(ev);
    }
    eventTotal = events.length;
    if (eventBytes > 0 && events.length) {
      let bytes = 0;
      let keepFromIdx = events.length;
      for (let i = events.length - 1; i >= 0; i--) {
        let sz;
        try { sz = JSON.stringify(events[i]).length; } catch { sz = 0; }
        if (bytes && bytes + sz > eventBytes) break;
        bytes += sz;
        keepFromIdx = i;
      }
      events = events.slice(keepFromIdx);
    }
  }
  // Merge sorted by ts. Tagged items keep their kind so the client
  // can dispatch each to the right renderer in arrival order.
  const items = [];
  for (const m of chatHistory) if (m && m.ts) items.push({ kind: 'chat', ts: m.ts, message: m });
  for (const e of events)      if (e && e.ts) items.push({ kind: 'event', ts: e.ts, event: e });
  items.sort((a, b) => {
    if (a.ts === b.ts) return 0;
    return a.ts < b.ts ? -1 : 1;
  });
  let chatBytesShipped = 0, eventBytesShipped = 0;
  for (const it of items) {
    try {
      const sz = JSON.stringify(it).length;
      if (it.kind === 'chat') chatBytesShipped += sz; else eventBytesShipped += sz;
    } catch {}
  }
  try {
    ws.send(JSON.stringify({
      t: 'timeline-init',
      items,
      totals: { chat: chatTotal, events: eventTotal },
      bytes:  { chat: chatBytesShipped, events: eventBytesShipped },
    }));
    console.log(`[timeline-init] ${sessionId} sent ${items.length} item(s) — chat ${chatHistory.length}/${chatTotal} (${chatBytesShipped} B), events ${events.length}/${eventTotal} (${eventBytesShipped} B)`);
  } catch {}
}

// bug-9 round 4 — shared shipper for the agent-replay WS frame.
// Dedups the buffer (bug-7 round 2 backstop) and byte-trims to the
// passed-in budget. Used twice on attach: once for the small initial
// frame, once for the backfill ~200ms later. Same frame type both
// times so the client's existing wipe-and-render handler in
// _handleAgentFrame absorbs the second send transparently.
// 2026-05-17 round 5: when `afterSeq` is set, short-circuit the
// byte-budget logic and ship ONLY events with seq strictly greater
// than afterSeq. Used by the reconnect catch-up path so a brief WS
// drop doesn't force the full replay — the client already has
// everything up to its last-seen seq, just send the gap.
function _shipAgentReplay(session, ws, sessionId, maxBytes, phase, afterSeq) {
  if (!Array.isArray(session.buffer) || !session.buffer.length) return;
  if (ws.readyState !== ws.OPEN) return;
  // Dedup (bug-7 round 2).
  const seen = new Set();
  const events = [];
  let dropped = 0;
  for (const ev of session.buffer) {
    let sig;
    try { sig = JSON.stringify(ev); } catch { sig = null; }
    if (sig && seen.has(sig)) { dropped++; continue; }
    if (sig) seen.add(sig);
    events.push(ev);
  }
  if (dropped > 0 && phase === 'initial') {
    console.log(`[agent-replay] ${sessionId} dedup dropped ${dropped} duplicate event(s) from session.buffer of ${session.buffer.length} total — bug-7 backstop`);
  }
  // afterSeq catch-up mode: keep only seq > afterSeq, no byte-trim.
  if (typeof afterSeq === 'number' && afterSeq >= 0) {
    const gap = events.filter((ev) => typeof ev.seq === 'number' && ev.seq > afterSeq);
    try { ws.send(JSON.stringify({ t: 'agent-replay', events: gap, afterSeq })); } catch {}
    console.log(`[agent-replay] ${sessionId} ${phase} afterSeq=${afterSeq} → ${gap.length} event(s) (of ${events.length} in buffer)`);
    return;
  }
  // Byte-trim (bug-9 round 3, parametrized by phase).
  // bug-86 (option B): on top of the byte budget, GUARANTEE at least N
  // recent assistant_text events. Without this floor, a chatty tool-use
  // sequence between two claude replies (5+ KB of tool_use/tool_result
  // events) can push the prior assistant_text past the 16 KB budget;
  // the user sees the modal "kept losing the myco response." We compute
  // BOTH floors (byte budget + assistant_text count) and take the
  // earlier one.
  let trimmed = events;
  if (events.length && maxBytes > 0) {
    let bytes = 0;
    let keepFromIdx = events.length;
    for (let i = events.length - 1; i >= 0; i--) {
      let sz;
      try { sz = JSON.stringify(events[i]).length; } catch { sz = 0; }
      if (bytes && bytes + sz > maxBytes) break;
      bytes += sz;
      keepFromIdx = i;
    }
    // bug-86 (option B): walk further back to capture min N assistant_text
    // events if the byte-budget tail didn't already include them.
    if (INITIAL_AGENT_REPLAY_MIN_ASSISTANT_TEXTS > 0 && phase === 'initial') {
      let asstCount = 0;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i] && events[i].type === 'assistant_text') {
          asstCount++;
          if (asstCount >= INITIAL_AGENT_REPLAY_MIN_ASSISTANT_TEXTS) {
            if (i < keepFromIdx) keepFromIdx = i;
            break;
          }
        }
      }
      // If asstCount < N here, we've simply included all assistant_texts
      // the buffer has — same "at most N" semantics as the chat-history
      // floor.
    }
    if (keepFromIdx > 0) {
      trimmed = events.slice(keepFromIdx);
      console.log(`[agent-replay] ${sessionId} ${phase} byte-trim ${events.length} → ${trimmed.length} events (${bytes} bytes, budget ${maxBytes}, asst-floor=${INITIAL_AGENT_REPLAY_MIN_ASSISTANT_TEXTS})`);
    }
  }
  try { ws.send(JSON.stringify({ t: 'agent-replay', events: trimmed })); } catch {}
  // 2026-05-17 diag: log every shipped assistant_text so we can
  // verify the server is actually delivering claude replies on attach.
  // If a user reports "claude reply disappeared after tab switch" and
  // these logs DON'T list the expected text, the bug is server-side
  // (buffer hydrate / seq filter / byte trim). If the logs DO list it,
  // the bug is client-side (render path).
  try {
    const texts = trimmed.filter((e) => e.type === 'assistant_text')
      .map((e) => ({ seq: e.seq, ts: e.ts, preview: String(e.text || '').replace(/\s+/g, ' ').slice(0, 30) }));
    if (texts.length > 0) {
      console.log(`[agent-replay-diag] ${sessionId} ${phase} shipped ${texts.length} assistant_text(s): ${JSON.stringify(texts)}`);
    }
  } catch {}
}

// bug-9 round 4 — shared shipper for the chat-history WS frame.
// Reads from rec.chat via getChatHistory({maxBytes}). Used twice on
// attach: small initial frame + backfill.
//
// 2026-05-17 round 5: when `afterSeq` is set, short-circuit the
// byte-budget logic and ship ONLY rows with meta.seq strictly greater
// than afterSeq. Catch-up mode used by the reconnect path. includeAgent
// is forced true in catch-up so fromAgent assistant_text rows reach
// the client too (the live channel would have delivered them; on
// reconnect they need to arrive via chat-history).
function _shipChatHistory(ws, sessionId, maxBytes, phase, afterSeq) {
  if (ws.readyState !== ws.OPEN) return;
  let history;
  let total;
  if (typeof afterSeq === 'number' && afterSeq >= 0) {
    history = sessionsMod.getChatHistory(sessionId, { afterSeq, includeAgent: true });
    total = sessionsMod.getChatHistoryLength(sessionId, { includeAgent: true });
    try {
      ws.send(JSON.stringify({ t: 'chat-history', messages: history, total, afterSeq }));
      console.log(`[chat-history] ${sessionId} ${phase} afterSeq=${afterSeq} → ${history.length} row(s) of ${total} total`);
    } catch {}
    return;
  }
  history = sessionsMod.getChatHistory(sessionId, { maxBytes });
  if (!history.length) return;
  // 2026-05-17: send total WITH includeAgent=true so the client's
  // load-older counter starts off representing the FULL on-disk row
  // count (including fromAgent claude-reply mirrors). Without this,
  // the initial total counted only non-fromAgent rows; the first
  // load-older fetch then bumped state.chatTotal up because the
  // HTTP /chat/history?includeAgent=1 response reports the inclusive
  // total. The user reported "hiddenCount=14, after click load,
  // hiddenCount=18 — this is not right" — the count was growing
  // instead of decreasing. With the inclusive total upfront, every
  // load-older fetch monotonically decreases the count.
  total = sessionsMod.getChatHistoryLength(sessionId, { includeAgent: true });
  try {
    ws.send(JSON.stringify({ t: 'chat-history', messages: history, total }));
    console.log(`[chat-history] ${sessionId} ${phase} sent ${history.length} of ${total} message(s) (incl. fromAgent) within ${maxBytes}-byte budget`);
  } catch {}
}

function _attachAgentWebSocket(session, ws, opts = {}) {
  const user = opts.user || null;
  const sessionId = session.sessionId;
  // fr-94 Phase 2: lazy migration for legacy sessions. If this
  // session was spawned BEFORE fr-94 Phase 1 (no rec.mainProject
  // set) and there's an unambiguous project subdir, set
  // rec.mainProject + persist now. Subsequent _myco_/ resolutions
  // hit the explicit-override branch in findProjectRoot instead
  // of re-scanning the workspace dir each call. Best-effort: any
  // error is logged + swallowed; the attach flow continues.
  try {
    const rec = sessionsMod.getSessionRecord(sessionId);
    if (rec) {
      const { migrateMainProjectIfNeeded } = require('./artifacts');
      migrateMainProjectIfNeeded(rec, () => sessionsMod.saveStore());
    }
  } catch (err) {
    console.error(`[fr-94 Phase 2] migrate attempt failed for ${sessionId}: ${err && err.message ? err.message : err}`);
  }
  // 2026-05-17 round 5: catch-up mode. If the client (typically a
  // reconnecting tab) passed ?afterSeq=N, ship only events + chat
  // rows with seq strictly greater than N. Skips byte budgets
  // entirely — the gap is bounded by what was missed during the
  // disconnect window. Lossless catch-up with no duplicate render.
  const afterSeq = typeof opts.afterSeq === 'number' && opts.afterSeq >= 0 ? opts.afterSeq : null;

  if (afterSeq != null) {
    _shipAgentReplay(session, ws, sessionId, 0, 'catch-up', afterSeq);
    _shipChatHistory(ws, sessionId, 0, 'catch-up', afterSeq);
  } else {
    // bug-9 round 6.1 (revert to round-5 shape after round-6 lost
    // claude-output history rendering): keep the separate
    // chat-history + agent-replay frames. The client's existing
    // agent-replay handler arms the chat pane (state._agentChatPane
    // Armed) AND wipes stale agent cards in one step — paths that
    // _applyTimelineInit silently skipped. The order-on-tab-switch
    // concern is handled by the client-side _resortChatPaneByTs
    // defensive sort (added in round-5 and still in place).
    _shipAgentReplay(session, ws, sessionId, INITIAL_AGENT_REPLAY_BYTES, 'initial');
    _shipChatHistory(ws, sessionId, sessionsMod.INITIAL_CHAT_HISTORY_BYTES, 'initial');
  }
  console.log(`[agent-attach] ${sessionId} user=${user || 'unknown'} mode=agent replay-events=${(session.buffer || []).length} sdk-session=${session.sdkSessionId || 'none'}`);
  if (session.sdkSessionId && !session._iterating && (!session.buffer || !session.buffer.length)) {
    console.log(`[agent-resume] ${sessionId} ready to resume sdk-session=${session.sdkSessionId} on next user message`);
  }

  if (session._initSnapshot) {
    ws.send(JSON.stringify({ t: 'agent-init', snapshot: session._initSnapshot }));
  }

  _sendAttachSnapshot(session, ws);

  const onAgentEvent = (event) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ t: 'agent-event', event }));
  };
  const onChat = (message) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ t: 'chat', message }));
  };
  const onStateUpdate = (payload) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ t: 'state-update', ...payload }));
  };
  const onExit = (code) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ t: 'exit', code }));
  };
  // fr-85 r4: clarify-reply WS frame. agent-session emits this when
  // a claude assistant_text finishes responding to a clarify-tagged
  // user input. Goes to ALL attached clients (multi-viewer
  // consistency); the client matches by questionTs to decide whether
  // to render in its popover.
  const onClarifyReply = (payload) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ t: 'clarify-reply', ...payload }));
  };

  session.on('agent-event', onAgentEvent);
  session.on('chat', onChat);
  session.on('state-update', onStateUpdate);
  session.on('exit', onExit);
  session.on('clarify-reply', onClarifyReply);

  // Track this attach in the presence roster + broadcast the updated
  // list to everyone watching the session (incl. the new connection,
  // so their chatpane header paints the chips immediately).
  const presenceInfo = {
    ws,
    login: user || '(anon)',
    role: 'owner',
    attachedAt: new Date().toISOString(),
  };
  _registerPresence(sessionId, presenceInfo);
  _broadcastPresence(sessionId);
  // A client arrived — if a keep-alive reaper was pending for this
  // session (last client had disconnected within the last 5min),
  // cancel it. The session lives on.
  _cancelSessionKill(sessionId);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'ping') {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'pong' }));
      return;
    }
    if (msg.t === 'chat' && typeof msg.text === 'string' && user) {
      const text = msg.text.trim();
      // r4 (fr-85): clarify-tagged chat messages are filtered out of
      // chat render on both sides. Only meta.kind='clarify' is
      // passed through — other meta keys are ignored as a security
      // measure (prevents a client from spoofing a meta.kind='menu'
      // or similar that could trick downstream renderers).
      // r2: also pass through the client-generated questionTs so
      // the eventual clarify-reply WS frame carries the SAME ts the
      // client's popover is waiting on (the server used to generate
      // its own, which never matched + made the reply drop silently
      // on the client side).
      const opts = {};
      if (msg.meta && msg.meta.kind === 'clarify') {
        opts.meta = {
          kind: 'clarify',
          selected: String(msg.meta.selected || '').slice(0, 1000),
          questionTs: typeof msg.meta.questionTs === 'string'
            ? msg.meta.questionTs.slice(0, 64)
            : null,
        };
      }
      if (text) handleChatMessage(sessionId, session, user, text.slice(0, CHAT_TEXT_LIMIT), opts);
      return;
    }
    // bug-14: dedicated interrupt frame. The Stop button used to send
    // {t:'chat', text:'esc'} which polluted chat history with a fake
    // user-typed "esc" row AND broadcast it to other viewers. Direct
    // interrupt frame bypasses chat persistence entirely — call
    // session.interrupt() and emit a brief ack note. session.interrupt()
    // is a safe no-op when no abort controller is live.
    if (msg.t === 'interrupt' && user) {
      console.log(`[ws-frame] ${sessionId} t=interrupt user=${user}`);
      if (typeof session.interrupt === 'function') session.interrupt();
      session.emit('chat', {
        user: ASSISTANT_USER,
        text: '(interrupt sent — the in-flight Claude turn was aborted. Type your next message to continue from where the conversation left off.)',
        ts: new Date().toISOString(),
        meta: { kind: 'interrupt-ack' },
      });
      return;
    }
    if (msg.t === 'menu-pick' && Number.isFinite(msg.n)) {
      const hashTag = typeof msg.hash === 'string' ? msg.hash.slice(-12) : 'no-hash';
      console.log(`[ws-frame] ${sessionId} t=menu-pick n=${msg.n} hash=${hashTag} user=${user || '(anon)'}`);
      if (user) handleMenuPick(sessionId, session, msg.n | 0, typeof msg.hash === 'string' ? msg.hash : null);
      return;
    }
    if (msg.t === 'menu-toggle' && Number.isFinite(msg.n)) {
      const hashTag = typeof msg.hash === 'string' ? msg.hash.slice(-12) : 'no-hash';
      console.log(`[ws-frame] ${sessionId} t=menu-toggle n=${msg.n} hash=${hashTag}`);
      if (user) handleMenuToggle(sessionId, session, msg.n | 0, typeof msg.hash === 'string' ? msg.hash : null);
      return;
    }
    if (msg.t === 'menu-submit') {
      const hashTag = typeof msg.hash === 'string' ? msg.hash.slice(-12) : 'no-hash';
      console.log(`[ws-frame] ${sessionId} t=menu-submit hash=${hashTag}`);
      if (user) handleMenuSubmit(sessionId, session, typeof msg.hash === 'string' ? msg.hash : null);
      return;
    }
    if (msg.t === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
      session.resize(msg.cols, msg.rows);
    }
  });

  ws.on('close', () => {
    session.off('agent-event', onAgentEvent);
    session.off('chat', onChat);
    session.off('state-update', onStateUpdate);
    session.off('exit', onExit);
    _unregisterPresence(sessionId, presenceInfo);
    _broadcastPresence(sessionId);
    // If this was the last client, start the 5-minute grace timer.
    // Reattaching within the window cancels it; otherwise the SDK
    // process is reaped to free memory + tokens.
    if (!_sessionPresence.has(sessionId)) {
      _scheduleSessionKill(sessionId, 'owner ws closed');
    }
  });
}

// Send the per-session state snapshot to a freshly-attached WS. Used
// for BOTH attachWebSocket (owner) and attachViewerWebSocket. Lets every
// chat-pane / readonly view land at parity with the live session without
// waiting for the next on-change emit.
//
// Frame order matches the live channels so the client's existing
// handlers can replay them transparently:
//   1. claude-status — spinner + token chips + interrupt badge. Always
//      sent; status===null means "idle, clear the strip."
//   2. mode-snapshot — current mode pill (agent sessions stay 'default'
//      unless the SDK reports otherwise via _lastMode).
//   3. artifacts-init — full plan/test/arch artifacts so the artifact
//      tabs are instant on switch + always in sync. Read priority is
//      <project>/_myco_/<type>.<ext> (canonical, shared via git) then
//      in-memory rec.artifacts as fallback — same priority the GET
//      /artifact route uses (artifacts.js).
//   4. tool-progress state-update — in-flight openToolCalls so the
//      "waiting on Tool · 47s" indicator paints immediately on attach.
function _sendAttachSnapshot(session, ws) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try {
    const status = session._lastStatus || null;
    const text = status && status.text ? status.text : null;
    ws.send(JSON.stringify({ t: 'claude-status', text, status }));
  } catch {}
  try {
    ws.send(JSON.stringify({ t: 'mode-snapshot', mode: session._lastMode || 'default' }));
  } catch {}
  try {
    const sessionId = session.sessionId;
    const rec = sessionsMod.getSessionRecord(sessionId);
    if (!rec) return;
    
    // Broadcast active critic model state on connection
    if (rec.criticModel) {
      ws.send(JSON.stringify({ t: 'state-update', kind: 'critic-model-changed', modelId: rec.criticModel }));
    }

    const artifacts = {};
    for (const type of ['plan', 'test', 'arch']) {
      const fromFile = getArtifactsMod().__test.readArtifactFromFile(rec, type);
      const inMem = rec.artifacts && rec.artifacts[type];
      const picked = fromFile || inMem || null;
      if (picked) artifacts[type] = picked;
    }
    ws.send(JSON.stringify({ t: 'artifacts-init', artifacts }));

    // fr-98: replay any persisted verdict pane that's still pending.
    // The verdict broadcast at critique.js was a fire-once state-update —
    // devices that weren't attached at fire time saw a stageState of
    // awaiting_accept but no pane to render. The bug-66-style fix is to
    // persist the broadcast payload at item.meta.lastCriticReview and
    // re-ship it here on every attach, BUT only when the stageState
    // still says the verdict is pending (awaiting_verdict /
    // awaiting_accept). Resolved verdicts have lastCriticReview
    // cleared by _clearAndBroadcastStageState + resolveCritique, so
    // they never replay. Capped at 1 — the UI shows one verdict pane
    // at a time, and bug-64's intermediate-vs-final precedence rules
    // mean the most-recently-broadcast pending one is the right one.
    try {
      const planItems = (artifacts.plan && Array.isArray(artifacts.plan.items)) ? artifacts.plan.items : [];
      for (const it of planItems) {
        const review = stageStateMod.getLastCriticReview(it);
        if (!review) continue;
        const ss = stageStateMod.getStageState(it);
        if (!ss || (ss.status !== 'awaiting_verdict' && ss.status !== 'awaiting_accept')) continue;
        ws.send(JSON.stringify({
          t: 'state-update',
          ...review,
          _replayedOnAttach: true,
        }));
        console.log(`[fr-98] replayed pending critique-review on attach for item ${it.id} (stage=${ss.stage}, status=${ss.status})`);
        break; // single-verdict-pane UI; only replay the first pending one
      }
    } catch (err) {
      console.error(`[fr-98] critique-review replay on attach failed: ${err.message}`);
    }
  } catch (err) {
    console.error(`[attach-snapshot] artifacts-init failed: ${err.message}`);
  }
  try {
    if (session.openToolCalls && session.openToolCalls.size >= 0) {
      const now = Date.now();
      const open = [];
      for (const [id, info] of session.openToolCalls) {
        open.push({
          id,
          name: info.name,
          summary: info.summary,
          sinceMs: Math.max(0, now - new Date(info.ts).getTime()),
        });
      }
      ws.send(JSON.stringify({ t: 'state-update', kind: 'tool-progress', open }));
    }
  } catch {}
  // bug-27: ship this session's queue state on attach so the chip
  // strip populates immediately + can't be a stale leak from whichever
  // session the client previously had open. The client also clears
  // state.runQueue on session-switch (belt-and-braces), but pushing
  // here means the strip is correct on the FIRST frame, not after
  // the first queue mutation.
  try {
    const sessionId = session.sessionId;
    const rec = sessionsMod.getSessionRecord(sessionId);
    if (rec) {
      const state = runQueue.getQueueState(rec);
      ws.send(JSON.stringify({ t: 'state-update', kind: 'runQueue', state }));
    }
  } catch (err) {
    console.error(`[attach-snapshot] runQueue init failed: ${err.message}`);
  }
}

// Read-only share-link attach. Streams chat history + transcript +
// snapshot + state mutations + agent-event frames so viewers see the
// same chrome-batch timeline (tool calls, tool results, permission
// requests, turn results) as the owner. Viewers can post chat and
// pick menu rows — chat is the collaborative steering channel.
//
// bug-13 (2026-05-18): agent-event frames USED to be deliberately
// withheld from viewers under a "tool inputs may be sensitive" rule.
// kkrazy filed bug-13 ("Chrome batch messages are only visible to the
// session owner, not other participants — should be visible to all
// users") flipping that policy: visibility wins. Sessions with truly
// sensitive tool input shouldn't be shared via share-link in the
// first place; the share-link is the consent boundary.
function attachViewerWebSocket(session, ws, opts = {}) {
  const user = opts.user || null;
  const sessionId = session.sessionId;
  const afterSeq = typeof opts.afterSeq === 'number' && opts.afterSeq >= 0 ? opts.afterSeq : null;

  // bug-13: viewers also get the initial agent-replay tail + the
  // agent-init snapshot, mirroring the owner attach path
  // (_attachAgentWebSocket). Without these the viewer's chrome
  // batches would start blank — they'd only see events going forward
  // from the moment of attach, not the recent backfill.
  // 2026-05-17 round 5: catch-up mode honored for viewers too.
  if (afterSeq != null) {
    _shipAgentReplay(session, ws, sessionId, 0, 'catch-up', afterSeq);
    _shipChatHistory(ws, sessionId, 0, 'catch-up', afterSeq);
  } else {
    _shipAgentReplay(session, ws, sessionId, INITIAL_AGENT_REPLAY_BYTES, 'initial');
    _shipChatHistory(ws, sessionId, sessionsMod.INITIAL_CHAT_HISTORY_BYTES, 'initial');
  }
  if (session._initSnapshot) {
    ws.send(JSON.stringify({ t: 'agent-init', snapshot: session._initSnapshot }));
  }
  _sendAttachSnapshot(session, ws);

  const onChat = (message) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'chat', message }));
  };
  const onStateUpdate = (payload) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'state-update', ...payload }));
  };
  // bug-13: subscribe to agent-event + exit so viewers see chrome
  // batches + know when the session has ended. Together with the
  // pre-existing chat + state-update subscriptions, viewers now
  // receive the SAME stream of session events the owner does.
  const onAgentEvent = (event) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'agent-event', event }));
  };
  const onExit = (code) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'exit', code }));
  };
  session.on('chat', onChat);
  session.on('state-update', onStateUpdate);
  session.on('agent-event', onAgentEvent);
  session.on('exit', onExit);

  const ownerLogin = sessionsMod.getSessionRecord(sessionId)?.user || null;
  ws.send(JSON.stringify({ t: 'viewer-mode', owner: ownerLogin }));

  // Track viewer in the presence roster — role='guest' distinguishes
  // share-link viewers from the session owner in the chip cluster.
  const presenceInfo = {
    ws,
    login: user || '(anon)',
    role: 'guest',
    attachedAt: new Date().toISOString(),
  };
  _registerPresence(sessionId, presenceInfo);
  _broadcastPresence(sessionId);
  _cancelSessionKill(sessionId);   // a viewer arrived too — abort pending reap

  const stopTranscript = streamTranscriptToWs(sessionId, ws);

  function handleViewerInbound(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'ping' && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'pong' }));
    }
    if (msg.t === 'chat' && typeof msg.text === 'string' && user) {
      const text = msg.text.trim();
      // Read-only viewers route through handleChatMessage with the
      // readOnly flag so the gate inside that function (Phase 9 step 3)
      // blocks claude-bound paths and only lets through /td /fr /bug
      // + @user mentions.
      if (text) handleChatMessage(sessionId, session, user, text.slice(0, CHAT_TEXT_LIMIT), { readOnly: true });
    }
    if (msg.t === 'menu-pick' && Number.isFinite(msg.n) && user) {
      handleMenuPick(sessionId, session, msg.n | 0, typeof msg.hash === 'string' ? msg.hash : null);
    }
    if (msg.t === 'menu-toggle' && Number.isFinite(msg.n) && user) {
      handleMenuToggle(sessionId, session, msg.n | 0, typeof msg.hash === 'string' ? msg.hash : null);
    }
    if (msg.t === 'menu-submit' && user) {
      handleMenuSubmit(sessionId, session, typeof msg.hash === 'string' ? msg.hash : null);
    }
    // bug-14: viewers can also interrupt — same precedent as menu-pick
    // (viewers already affect the SDK turn by resolving permission
    // menus). Logged distinctly so audit trail shows who interrupted.
    if (msg.t === 'interrupt' && user) {
      console.log(`[ws-frame] ${sessionId} t=interrupt user=${user} (viewer)`);
      if (typeof session.interrupt === 'function') session.interrupt();
      session.emit('chat', {
        user: ASSISTANT_USER,
        text: '(interrupt sent — the in-flight Claude turn was aborted. Type your next message to continue from where the conversation left off.)',
        ts: new Date().toISOString(),
        meta: { kind: 'interrupt-ack' },
      });
    }
  }

  ws.on('message', handleViewerInbound);
  ws.on('close', () => {
    session.off('chat', onChat);
    session.off('state-update', onStateUpdate);
    // bug-13: clean up the agent-event + exit listeners too —
    // otherwise a reconnecting viewer would accumulate listeners on
    // the session and every event would multi-fire across the dangling
    // refs.
    session.off('agent-event', onAgentEvent);
    session.off('exit', onExit);
    stopTranscript();
    _unregisterPresence(sessionId, presenceInfo);
    _broadcastPresence(sessionId);
    if (!_sessionPresence.has(sessionId)) {
      _scheduleSessionKill(sessionId, 'last viewer ws closed');
    }
  });
}

// Route an inbound chat frame.
//   * `@<known-user> <body>` — stamp meta, persist, no agent forward.
//   * `/<slash-cmd>` — dispatch via slashcmds. Unknown slash commands
//     bounce back with an explanatory chat note instead of being
//     forwarded as a literal claude message (the agent would just
//     reply "Unknown command: /foo").
//   * `/btw <text>` with shouldAskAssistant → runs the side-channel
//     claude-cli via btw.askAssistant (no agent forward).
//   * Special key tokens (esc, ctrl-c) → AgentSession.interrupt(). Other
//     keys (enter, tab, …) have no SDK equivalent; we bounce them.
//   * Bare digit `1`-`9` while a pendingMenu is open → handleMenuPick
//     so the SDK promise resolves AND the chat row is stamped.
//   * EVERYTHING ELSE → session.write(body) so claude consumes it.
function handleChatMessage(sessionId, session, user, text, opts = {}) {
  const readOnly = !!opts.readOnly;
  // Phase 9 step 3: guest / share-token viewers can post discussion
  // replies (@user mentions) and add plan items (/td /fr /bug) but
  // cannot drive claude. The guard short-circuits BEFORE persistence
  // for the disallowed paths so the chat record doesn't accumulate
  // ghost claude-bound rows. Disallowed inputs get a one-shot reply
  // explaining what they can do instead.
  if (readOnly && user !== ASSISTANT_USER) {
    const cmd = text.startsWith('/') ? text.split(/\s+/)[0].toLowerCase() : '';
    const isMention = !!_detectMentionTarget(text);
    const GUEST_ALLOWED_CMDS = new Set([
      '/td', '/fr', '/bug',                  // plan-item adds
      '/help', '/me', '/whoami',
      '/task', '/tasks', '/skip', '/cancel', // task-list controls
      '/allowlist',                           // read-only view of allow/deny lists
      '/qstatus',                             // read-only run-queue inspection (fr-48)
      '/whatsnext', '/next',                  // read-only priority list (fr-49)
    ]);
    const guestOK = isMention || (cmd && GUEST_ALLOWED_CMDS.has(cmd));
    if (!guestOK) {
      // bug-19: preserve the user's typed text. Pre-fix the read-only
      // block emitted ONLY the denial reply and returned, silently
      // dropping the typed message — the viewer had no way to recover
      // what they tried to send. Now we append + broadcast the user's
      // message tagged meta.kind='denied' BEFORE the denial reply, so:
      //   * the chat record keeps every input (per the cross-device
      //     persistence contract in CLAUDE.md)
      //   * other attached clients see what the viewer tried to send
      //   * the client can visually mark denied messages (muted /
      //     strikethrough) so the user can copy their text out
      const userMsg = {
        user,
        text,
        ts: new Date().toISOString(),
        meta: { kind: 'denied', reason: 'read-only viewer' },
      };
      sessionsMod.appendChatMessage(sessionId, userMsg);
      session.emit('chat', userMsg);
      const denyMsg = {
        user: ASSISTANT_USER,
        text: '(read-only viewer — claude-routing is owner-only. You can `@<user>` to discuss, or use `/td <text>`, `/fr <text>`, `/bug <text>` to add plan items.)',
        ts: new Date().toISOString(),
      };
      sessionsMod.appendChatMessage(sessionId, denyMsg);
      session.emit('chat', denyMsg);
      console.log(`[chat-readonly] ${sessionId} ${user}: blocked '${text.slice(0,40)}…' (preserved as meta.kind=denied)`);
      return;
    }
  }
  const message = {
    user,
    text,
    ts: new Date().toISOString(),
  };
  const mentionTarget = _detectMentionTarget(text);
  if (mentionTarget && user !== ASSISTANT_USER) {
    message.meta = { kind: 'mention', mentionUser: mentionTarget };
    if (mentionTarget === 'all') message.meta.broadcast = true;
  }
  // r4 (fr-85): clarify tag — the message gets meta.kind='clarify'
  // so the client filters it out of chat render, AND `session._pending
  // Clarify` is set so the NEXT claude assistant_text reply gets
  // paired back to this question (see _persistAssistantTextToRecChat
  // in agent-session.js). The text still ships to claude via the
  // usual session.write path — claude doesn't know it's a "clarify";
  // only the routing of the resulting reply changes.
  if (opts && opts.meta && opts.meta.kind === 'clarify' && user !== ASSISTANT_USER) {
    message.meta = { kind: 'clarify', selected: String(opts.meta.selected || '') };
    // r2: prefer the client-generated questionTs (round-tripped via
    // opts.meta.questionTs) so the clarify-reply WS frame carries
    // the SAME ts the client's popover is awaiting. Fallback to
    // message.ts for legacy / out-of-band callers that don't supply
    // one — those will fail the client match check but won't crash.
    session._pendingClarify = {
      questionTs: (opts.meta.questionTs && typeof opts.meta.questionTs === 'string')
        ? opts.meta.questionTs
        : message.ts,
      selected: message.meta.selected,
    };
    // r7 (fr-85): the popover is a tight floating panel — multi-
    // paragraph essays don't fit. Wrap the user's question with a
    // forceful brevity instruction. The wrap is invisible to the user
    // (clarify rows are filtered from chat render; the popover preview
    // shows the SELECTED text, not the question), so it's a purely
    // LLM-facing instruction. r7 r2: the model kept ignoring the soft
    // nudge, so the wording is now a hard MAX and the server also
    // truncates the reply to ≤ 3 sentences in agent-session.js
    // (_capClarifyReply) as a guaranteed backstop.
    message.text = `[Clarification request — answer in 2-3 sentences MAX. Be terse: no preamble, no restating the question, no bullet lists, no headings. Plain prose only.] ${text}`;
  }
  // [run:<type>#<id>] marker: the chat-pane's ▶ Run button on a
  // plan item produces this prefix. Stash {type, id} on the
  // session so the NEXT turn_result lands a status record on the
  // matched plan item via _attachPlanRunOutcome.
  const runMatch = text.match(/\[run:(plan|test|arch|td|fr|bug)#([A-Za-z0-9_-]+)\]/);
  if (runMatch && user !== ASSISTANT_USER) {
    // Dispatch-label-drift fix (2026-06-03): snapshot HEAD + the
    // currently-dirty paths BEFORE the run begins. At critique time
    // (turn_result success path below), the critique diff is
    // filtered to EXCLUDE files that were already dirty here — only
    // changes made BY this run reach Gemini. Without this, an
    // unrelated WIP working tree (e.g. uncommitted fr-81 Phase A)
    // got attached to a dispatch on a totally different plan item
    // (e.g. bug-51 which was already shipped), producing a fake
    // "Gemini flagged issues" critique that was actually flagging
    // the unrelated WIP. The user reported this three times in one
    // session — the snapshot model makes the critique semantically
    // honest: it only ever reviews what THIS run touched.
    const rec = sessionsMod.getSessionRecord(sessionId);
    const baseline = rec && rec.absCwd ? _snapshotRunBaseline(rec.absCwd) : { dirtyPaths: new Set(), head: null };
    session._activeRunItem = {
      type: 'plan',                            // td/fr/bug all live in plan.json today
      itemId: runMatch[2],
      startedAt: new Date().toISOString(),
      baselineDirty: baseline.dirtyPaths,      // Set of path strings dirty at run-start
      baselineHead: baseline.head,             // SHA at run-start (informational; logged on critique skip)
    };
    // bug-57: reset the stage-sentinel-seen flag at run start. The
    // flag accumulates across the multi-turn run (analyze → code →
    // verify) and gets reset only when a fresh [run:plan#X] dispatch
    // overwrites _activeRunItem.
    session._sawStageSentinelInRun = false;
    _stampPlanItemStatus(sessionId, runMatch[2], 'running', null);
    // fr-96: initialize the per-plan-item stage state machine. The
    // dispatch is the [*] → analyze.in_progress transition. Persists
    // in plan.json via _initAndBroadcastStageState — survives container
    // restarts so the HUD reflects "X awaiting accept on code stage"
    // across attaches.
    _initAndBroadcastStageState(sessionId, session, runMatch[2]);
  }
  sessionsMod.appendChatMessage(sessionId, message);
  session.emit('chat', message);

  if (user === ASSISTANT_USER) return;
  if (mentionTarget) return;

  // bug-70: chat-accept handler. CLAUDE.md §9 documents that a chat
  // reply with an accept-class phrase ("accept", "yes", "looks good",
  // "ship it", "the test worked", or simply naming the next stage)
  // advances the plan-item run the same way the verdict-pane button
  // does. Pre-fix only the button was wired (POST /run/done +
  // critique.resolveCritique 'accept-stage'); the chat path went
  // straight to claude as an unrelated turn. Result: bug-66 stayed
  // stuck in awaiting_accept after the user typed "the test worked"
  // — the queue never advanced, the next plan item never dispatched.
  //
  // Behavior:
  //   - verify.awaiting_accept + accept-phrase → clearActiveRunItem
  //     (mirrors POST /sessions/:id/run/done: clear stage state +
  //     advance queue).
  //   - {analyze|code}.awaiting_accept + accept-phrase → transition
  //     to next.in_progress (mirrors critique.resolveCritique
  //     'accept-stage') + fire any deferred final critique (bug-64).
  //
  // The user's typed message is preserved in the chat record (it was
  // already persisted + broadcast above); claude routing is
  // SUPPRESSED for the accepted message so the accept signal isn't
  // misread as a fresh prompt.
  if (!text.startsWith('/') && !(message.meta && message.meta.kind === 'clarify')) {
    const acceptHandled = _maybeHandleChatAccept(sessionId, session, user, text);
    if (acceptHandled) return;
  }

  // fr-103: chat-mediated /login callback routing. When a login flow is
  // pending for this session, the NEXT chat message from the login owner
  // is the OAuth callback code — pipe it to the subprocess's stdin
  // instead of dispatching it normally. /login cancel / /login status
  // still need to flow through the slash dispatcher, so we only divert
  // NON-slash text from the login owner. Other users' chat continues to
  // route normally (so the session doesn't go dark for everyone while
  // someone runs /login).
  try {
    const claudeAuth = require('./claude-auth');
    const pending = claudeAuth.getPendingLogin(sessionId);
    if (pending && pending.owner === user && !text.startsWith('/') && text.trim()) {
      // Echo the user's text into the chat record (the SDK doesn't see
      // it — we're piping to a subprocess instead) so cross-device
      // catch-up still shows what they typed. Stamp meta.kind so the
      // client knows not to expect a claude reply for this row.
      const userMsg = {
        user,
        text,
        ts: new Date().toISOString(),
        meta: { kind: 'login-callback' },
      };
      sessionsMod.appendChatMessage(sessionId, userMsg);
      session.emit('chat', userMsg);
      const piped = claudeAuth.feedCallback(sessionId, text);
      if (!piped) {
        const replyMsg = {
          user: ASSISTANT_USER,
          text: '(login subprocess no longer accepting input — the flow may have already completed or failed. `/login status` to check.)',
          ts: new Date().toISOString(),
        };
        sessionsMod.appendChatMessage(sessionId, replyMsg);
        session.emit('chat', replyMsg);
      }
      return;
    }
  } catch (err) {
    console.error(`[fr-103] login-callback routing failed: ${err.message}`);
    // Fall through to normal handling so a broken /login plumbing
    // doesn't black-hole every chat message.
  }

  if (text.startsWith('/')) {
    const rec = sessionsMod.loadStore().sessions[sessionId];
    const absCwd = rec && rec.absCwd;
    const ctx = {
      user,
      sessionId,
      absCwd,
      session,
      reply: (replyText, opts = {}) => {
        const replyMsg = {
          user: ASSISTANT_USER,
          text: String(replyText || ''),
          ts: new Date().toISOString(),
        };
        if (opts && opts.meta) replyMsg.meta = opts.meta;
        sessionsMod.appendChatMessage(sessionId, replyMsg);
        session.emit('chat', replyMsg);
      },
    };
    slashcmds.dispatch(ctx, text).then((handled) => {
      if (handled) return;
      handleChatPostfixes(sessionId, session, user, text, message);
    });
    return;
  }

  // fr-38: strict-mode gate. In strict mode, claude-bound chat
  // messages MUST include a `[run:plan#<id>]` marker — the user's
  // affirmation that this turn is backed by an approved td/fr/bug.
  // Messages without the marker get a one-shot reply explaining how
  // to unblock + DO NOT forward to claude (no wasted tokens). The
  // gate fires AFTER mention / slash short-circuits above so user-to-
  // user chat + slash commands + `/strict` itself flow through.
  // Skipped for /btw (read-only ask-assistant flow) and for messages
  // shouldAskAssistant treats as ?-questions (also non-mutating). See
  // fr-38 comment in handleChatPostfixes for the actual marker check —
  // we delegate there so the gate also covers the slash-then-fallthrough
  // path (e.g. an unknown slash command that gets bounced to the
  // postfix handler).
  handleChatPostfixes(sessionId, session, user, text, message);
}

// fr-38: marker regex matches `[run:plan#<id>]`, `[run:td#<id>]`,
// `[run:fr#<id>]`, `[run:bug#<id>]`, `[run:test#<id>]`, `[run:arch#<id>]`
// — the same shape attach.js already parses at line ~1197 for
// run-outcome stamping. Permissive on id char set ([A-Za-z0-9_-]+) so
// the legacy hex ids still work.
function _hasRunMarker(text) {
  return /\[run:(plan|test|arch|td|fr|bug)#[A-Za-z0-9_-]+\]/.test(String(text || ''));
}

// bug-70: detect an accept-class chat phrase. WHOLE-STRING match
// (after trim + lowercase + trailing-punct strip) so a message like
// "the test worked but I have a question" does NOT auto-accept —
// only a plain affirmation does. The vocabulary mirrors CLAUDE.md
// §9's documented set plus the user's empirically-used "the test
// worked" and equivalents.
//
// Returns true only for unambiguous accept signals. Forward-stage
// shortcuts ("code", "verify", "code stage") also count as accept of
// the CURRENT awaiting_accept stage — the chat-accept handler doesn't
// honor them as JUMP-TO-STAGE; it just treats them as "yes, advance."
function _matchAcceptPhrase(text) {
  const raw = String(text || '').trim().toLowerCase();
  // Bare-emoji affirmations — match BEFORE the trailing-strip so a
  // message that's JUST an emoji (no other content) doesn't get
  // stripped to empty.
  if (/^(👍|✓|✔️|👌)$/.test(raw)) return true;
  // Strip trailing punct + emoji from messages like "looks good 👍".
  const s = raw.replace(/\s*[.!👍✓✔️👌]+\s*$/, '');
  if (!s) return false;
  // Single-word accept tokens.
  if (/^(accept(ed)?|yes|yep|yeah|ok|okay|sure|proceed|done|good|great|nice)$/.test(s)) return true;
  // Multi-word affirmations.
  if (/^(looks good|looks great|works for me|all good|all green|ship it|lgtm|the test worked|test worked|tests worked|that works|that worked|it works|it worked|test passed|tests passed|test passes|tests pass)$/.test(s)) return true;
  // Forward-stage signals — "code" / "verify" / "code stage" / etc.
  if (/^(code|verify)( stage)?$/.test(s)) return true;
  if (/^start (coding|verifying|verification)$/.test(s)) return true;
  return false;
}

// bug-70: chat-accept dispatcher. Returns true if the message was
// consumed as a stage-accept (caller should suppress claude routing);
// false otherwise.
//
// Reads stageState fresh from plan.json each call — survives
// container restarts since the state is persisted. The two branches
// mirror the verdict-pane button paths verbatim so chat-accept and
// button-accept land at the same end state (no skew).
function _maybeHandleChatAccept(sessionId, session, user, text) {
  if (!session) return false;
  const active = session._activeRunItem;
  if (!active || !active.itemId) return false;
  if (!_matchAcceptPhrase(text)) return false;
  let stageState;
  try {
    const rec = sessionsMod.getSessionRecord(sessionId);
    const item = _findPlanItemInRec(rec, active.itemId);
    stageState = stageStateMod.getStageState(item);
  } catch (err) {
    console.error(`[bug-70] chat-accept lookup failed for ${active.itemId}: ${err.message}`);
    return false;
  }
  if (!stageState || stageState.status !== 'awaiting_accept') return false;
  const stage = stageState.stage;
  console.log(`[bug-70] ${sessionId} ${user} chat-accept on ${active.itemId} stage=${stage} text=${JSON.stringify(String(text).slice(0, 60))}`);
  if (stage === 'verify') {
    // Final stage — clear + advance queue. Same path as POST /run/done.
    try {
      clearActiveRunItem(sessionId, session, { itemId: active.itemId, reason: 'chat-accept-verify' });
    } catch (err) {
      console.error(`[bug-70] chat-accept (verify) clearActiveRunItem failed: ${err.message}`);
      return false;
    }
    // bug-82: broadcast critique-resolved to ALL attached devices so
    // every connected client clears its verdict pane. The button-click
    // resolve path (critique.js resolveCritique → bug-54) already does
    // this; the chat-accept path was the missing parallel surface.
    // Without this emit, both the chat-acceptor's own device AND every
    // other attached device's verdict pane stayed open until the next
    // critique-review or a manual dismiss. The bug-54 client handler
    // (app.js critique-resolved → state.critiqueReview = null) clears
    // on any kind:'critique-resolved' payload, so the reuse is
    // server-side-only. Reason 'chat-accept-verify' distinguishes the
    // surface from the button path's 'accept-verify' in audit logs.
    session.emit('state-update', {
      kind: 'critique-resolved',
      itemId: active.itemId,
      reason: 'chat-accept-verify',
    });
    const note = {
      user: ASSISTANT_USER,
      text: `✓ accepted — plan-item run for **${active.itemId}** closed.`,
      ts: new Date().toISOString(),
      meta: { kind: 'bug-70-accept', stage: 'verify' },
    };
    sessionsMod.appendChatMessage(sessionId, note);
    session.emit('chat', note);
    // bug-68: notify claude. Pre-bug-68 the chat-accept handler ended
    // here — the run-queue advanced server-side but claude received no
    // signal that the verify stage was accepted. On a multi-item
    // queue, the next dispatch came in as a fresh [run:plan#Y]; on a
    // single-item queue, claude sat idle. Send a synthetic verify→done
    // turn so claude knows the run wrapped + can acknowledge.
    _postAcceptStagePrompt(sessionId, session, {
      itemId: active.itemId, stage: 'verify', reason: 'accept-verify',
    });
    return true;
  }
  // Intermediate stage — advance to next.in_progress (mirrors
  // critique.resolveCritique 'accept-stage') + fire any deferred
  // final critique (mirrors bug-64).
  const next = stageStateMod.nextStage(stage);
  if (!next) {
    console.warn(`[bug-70] chat-accept on intermediate stage ${stage} has no next — unexpected; no-op`);
    return false;
  }
  try {
    _transitionStageState(sessionId, session, active.itemId, next, 'in_progress');
  } catch (err) {
    console.error(`[bug-70] chat-accept (intermediate ${stage}→${next}) transition failed: ${err.message}`);
    return false;
  }
  // Mirror critique.js's bug-64 deferred-final-critique fire.
  try {
    const recForDefer = sessionsMod.getSessionRecord(sessionId);
    if (recForDefer && recForDefer._deferredFinalCritique && recForDefer._deferredFinalCritique.itemId === active.itemId) {
      const deferred = recForDefer._deferredFinalCritique;
      recForDefer._deferredFinalCritique = null;
      sessionsMod.saveStore();
      console.log(`[bug-70] firing deferred final critique for ${active.itemId} on chat-accept`);
      const { triggerGeminiCritique } = require('./critique');
      triggerGeminiCritique(sessionId, session, deferred.item, deferred.diff, deferred.claudeOutput, {
        changedEntries: deferred.changedEntries,
      }).catch((err) => console.error(`[bug-70] deferred critique fire failed: ${err.message}`));
    }
  } catch (err) {
    console.error(`[bug-70] chat-accept deferred-critique fire failed: ${err.message}`);
  }
  // bug-82: same cross-device resolve broadcast as the verify branch.
  // Mirrors critique.js resolveCritique's broadcast surface so every
  // attached device clears its verdict pane on a chat-typed accept —
  // not just the device that submitted the chat. Reason
  // 'chat-accept-stage' distinguishes the chat surface from the
  // button path's 'accept-stage' for audit logs.
  session.emit('state-update', {
    kind: 'critique-resolved',
    itemId: active.itemId,
    reason: 'chat-accept-stage',
  });
  const note = {
    user: ASSISTANT_USER,
    text: `✓ accepted — advancing **${active.itemId}** to **${next}** stage.`,
    ts: new Date().toISOString(),
    meta: { kind: 'bug-70-accept', stage, nextStage: next },
  };
  sessionsMod.appendChatMessage(sessionId, note);
  session.emit('chat', note);
  // bug-68: notify claude. Pre-bug-68 the intermediate chat-accept
  // ended here — stageState was at next.in_progress, but claude
  // received no input. User had to type "continue" manually to nudge
  // the next stage. The synthetic prompt tells claude to start the
  // next stage immediately, matching what CLAUDE.md §9 documents.
  _postAcceptStagePrompt(sessionId, session, {
    itemId: active.itemId, stage, next, reason: 'accept-stage',
  });
  return true;
}

// Non-slash routing fallthrough — separate function so the slash path
// can chain into it after dispatch() returns false.
function handleChatPostfixes(sessionId, session, user, text, message) {
  // fr-38: strict-mode gate. Block claude-bound code-change attempts
  // that lack a [run:plan#<id>] marker. Per-session opt-in via
  // `/strict on` (rec.strictMode). The gate sits AT this fallthrough
  // entry so all paths that would forward to claude pass through it —
  // including the unknown-slash bounce + the plain-text fallthrough.
  // Exceptions (intentional): /btw (read-only assistant), shouldAsk-
  // Assistant ?-question pattern (also read-only), and special-key
  // interrupt tokens further down — none of those drive code changes,
  // so the gate doesn't apply.
  //
  // isSessionStrict must be evaluated BEFORE the first
  // shouldAskAssistant(text) call below — both as the dispatch
  // predicate AND as the test-asserted source-order invariant: a
  // misordered guard could route to claude before the strict-mode
  // check fired.
  if (sessionsMod.isSessionStrict(sessionId)) {
    const looksLikeKey = /^(esc|escape|ctrl-c|\^c|enter|return|space|tab|shift-tab|shift\+tab)$/i
      .test(String(text || '').trim());
    if (!shouldAskAssistant(text) && !looksLikeKey && !_hasRunMarker(text)) {
      const blockMsg = {
        user: ASSISTANT_USER,
        text:
          '🛑 **Strict-mode is on** — this message would drive a code change but has no `[run:plan#<id>]` marker backing it.\n\n' +
          'To proceed:\n' +
          '1. Click **▶ Run** on an open plan item (auto-prepends the marker), OR\n' +
          '2. File a backing item with `/td <description>` / `/fr <description>` / `/bug <description>`, then include `[run:plan#<id>]` in your message, OR\n' +
          '3. Turn the gate off: `/strict off`.\n\n' +
          'fr-38 documents the rationale.',
        ts: new Date().toISOString(),
        meta: { kind: 'strict-mode-block' },
      };
      sessionsMod.appendChatMessage(sessionId, blockMsg);
      session.emit('chat', blockMsg);
      console.log(`[strict-mode] ${sessionId} blocked user=${user} text=${JSON.stringify(String(text || '').slice(0, 80))}`);
      return;
    }
  }
  if (shouldAskAssistant(text)) {
    runAssistant(sessionId, session, message).catch((err) => {
      console.error(`[chat-assistant] ${err.message}`);
    });
    return;
  }
  // No more @<word> alias-prefix strip — the legacy "@myco hi" /
  // "@claude hi" syntax is gone. _detectMentionTarget already short-
  // circuited @<known-user> mentions above, so what's left here is
  // body text the user wants claude to act on. Forward as-is.
  const body = text;
  if (!session.alive) {
    session.emit('chat', {
      user: ASSISTANT_USER,
      text: '(this Claude session has exited — reopen the session to continue)',
      ts: new Date().toISOString(),
    });
    return;
  }
  const input = String(body || '').trim();
  if (!input) return;

  if (input.startsWith('/')) {
    session.emit('chat', {
      user: ASSISTANT_USER,
      text: '(unknown chat command `/' + input.split(/\s+/)[0].slice(1) + '` — `/help` lists what\'s available)',
      ts: new Date().toISOString(),
    });
    return;
  }

  // Special-key tokens. Only the interrupt-style keys map cleanly to
  // SDK semantics (AbortSignal). Enter/space/tab don't exist as
  // concepts in the SDK stream — they get logged + ignored with an
  // explanatory chat note so the user understands.
  const key = input.toLowerCase();
  if (key === 'esc' || key === 'escape' || key === 'ctrl-c' || key === '^c') {
    console.log(`[chat→agent] ${user}: <interrupt:${input}>`);
    if (typeof session.interrupt === 'function') session.interrupt();
    session.emit('chat', {
      user: ASSISTANT_USER,
      text: '(interrupt sent — the in-flight Claude turn was aborted. Type your next message to continue from where the conversation left off.)',
      ts: new Date().toISOString(),
    });
    return;
  }
  const noopKeys = new Set(['enter', 'return', 'space', 'tab', 'shift-tab', 'shift+tab']);
  if (noopKeys.has(key)) {
    console.log(`[chat→agent] ${user}: <key-noop:${input}> (SDK has no terminal-key equivalent)`);
    session.emit('chat', {
      user: ASSISTANT_USER,
      text: `(\`${input}\` has no meaning in an agent-mode session — claude consumes messages, not keystrokes. Type a question / instruction instead, or \`esc\` to interrupt.)`,
      ts: new Date().toISOString(),
    });
    return;
  }

  // Bare-digit menu pick. Delegates to handleMenuPick so we get BOTH:
  //   (1) session.resolveMenuPick — unblocks the SDK's canUseTool
  //       promise so claude can proceed
  //   (2) _markMenuChatAnswered — stamps the chat row's meta.pickedN +
  //       meta.answered and emits a state-update to all clients
  //
  // bug-21: when multiple menus are pending (parallel tool calls), the
  // bare digit targets the OLDEST pending menu — head of the queue.
  // Rationale: explicit per-card button-clicks always carry their own
  // hash and remain unambiguous, but a bare digit has no hash to
  // disambiguate. FIFO is the least-surprising choice (resolve in the
  // order they appeared) and matches the order the SDK is waiting on
  // them. When 2+ are pending we also emit a chat note so the user
  // knows their digit went to the first one, not the most recent.
  const asDigit = /^[1-9]$/.test(input) ? parseInt(input, 10) : NaN;
  if (Number.isFinite(asDigit) && session.pendingMenus && session.pendingMenus.size > 0) {
    const target = session.oldestPendingMenu;
    const hash = target && target.hash;
    if (hash) {
      const totalPending = session.pendingMenus.size;
      console.log(`[chat→agent] ${user}: menu pick ${asDigit} (chat shorthand, hash=${hash.slice(-12)}, oldestOf=${totalPending})`);
      if (totalPending > 1) {
        session.emit('chat', {
          user: ASSISTANT_USER,
          text: `(picked option ${asDigit} for the OLDEST of ${totalPending} pending menus. To target a specific menu, click its button directly — the bare-digit shortcut always picks the head of the queue.)`,
          ts: new Date().toISOString(),
        });
      }
      handleMenuPick(sessionId, session, asDigit, hash);
      return;
    }
  }

  // Normal forward — pushes into the SDK streaming-input queue.
  console.log(`[chat→agent] ${user}: ${input.substring(0, 80)}`);
  session.write(input);
}

async function runAssistant(sessionId, session, lastMessage) {
  const all = sessionsMod.getChatHistory(sessionId);
  const chatHistory = all.slice(-ASSISTANT_CHAT_CONTEXT - 1, -1);
  // Agent sessions don't expose a raw PTY scrollback; we pass the
  // assistant a recent chat tail in lieu of one. The side-channel
  // claude-cli relies on it being a string, so the empty string is the
  // safe default.
  const scrollback = '';
  const cwd = sessionsMod.loadStore().sessions[sessionId]?.absCwd || null;

  const answer = await askAssistant({ cwd, chatHistory, scrollback, lastMessage });
  const reply = {
    user: ASSISTANT_USER,
    text: answer || '(no response)',
    ts: new Date().toISOString(),
  };
  sessionsMod.appendChatMessage(sessionId, reply);
  session.emit('chat', reply);
}

// fr-96: per-plan-item stage state machine helpers — wired into the
// dispatch site, stage-done handler, critique gate (via critique.js's
// resolveCritique extension), and clearActiveRunItem.
//
// Each helper:
//   1. Locates the item in rec.artifacts.plan.items
//   2. Calls the corresponding pure-function helper from stageState.js
//   3. Persists via sessionsMod.saveStore()
//   4. Broadcasts via _broadcastStageState
// Defensive: if the item doesn't exist or isn't a plan item, no-op +
// log. Race-safe — if the rec is in flux (e.g. user just cancelled
// the queue entry), the helper returns gracefully.
const stageStateMod = require('./stageState');

// bug-74: lookup with file-mirror fallback. The pre-bug-74 version
// read ONLY rec.artifacts.plan.items (the in-memory snapshot) and
// returned null on a miss — silently breaking downstream handlers
// when the item existed in _myco_/plan.json on disk but hadn't
// propagated into the in-memory rec yet.
//
// The in-memory rec.artifacts.plan can lag _myco_/plan.json after:
//   · /td|/bug|/fr in another session that shares the same project
//     dir,
//   · a hand-edit to plan.json,
//   · a migration that ran on a different session,
// — items land in the file mirror but extractor.js's transcript-
// synthesis path hasn't re-hydrated rec.artifacts since.
//
// Symptom that surfaced this (user-reported, 2026-06-06):
//   [run:plan#bug-67] dispatch → _initAndBroadcastStageState →
//   _findPlanItemInRec → null → silent "item not found" log + no-op.
//   stageState stayed null, the critic never fired, no verdict pane,
//   no advancement. "the gemini critic never showed up."
//
// Resolution order:
//   1. In-memory rec.artifacts.plan.items — cheap path, also the
//      authoritative source for mid-handler mutations that haven't
//      been persisted yet.
//   2. File mirror via readArtifactFromFile(rec, 'plan'). On hit,
//      hydrate rec.artifacts.plan so subsequent lookups in the same
//      handler chain see the item in-memory — no thrashing.
//   3. null.
//
// Defensive: the file-mirror branch is wrapped in try/catch so a
// malformed _myco_/plan.json (corrupted, mid-write, missing) never
// bubbles an exception to the caller. Failure logs + returns null.
function _findPlanItemInRec(rec, itemId) {
  if (!rec) return null;
  // Phase 1 — in-memory (cheap; honors mid-handler mutations).
  if (rec.artifacts && rec.artifacts.plan) {
    const items = rec.artifacts.plan.items;
    if (Array.isArray(items)) {
      const hit = items.find((it) => it && it.id === itemId);
      if (hit) return hit;
    }
  }
  // Phase 2 — file mirror fallback. Only reach here on in-memory
  // miss; reading disk on every successful lookup would be wasteful.
  try {
    const { readArtifactFromFile } = require('./artifacts');
    const fromFile = readArtifactFromFile(rec, 'plan');
    if (fromFile && Array.isArray(fromFile.items)) {
      const hit = fromFile.items.find((it) => it && it.id === itemId);
      if (hit) {
        // Side-effect: hydrate rec.artifacts.plan from the file
        // payload so subsequent lookups in this handler chain (and
        // the rest of this run) hit in-memory. Defensive shape —
        // never overwrite an existing rec.artifacts.plan with the
        // file copy; we only fill in what was empty.
        if (!rec.artifacts) rec.artifacts = {};
        if (!rec.artifacts.plan) rec.artifacts.plan = fromFile;
        else if (!Array.isArray(rec.artifacts.plan.items)) rec.artifacts.plan.items = fromFile.items;
        else {
          // The in-memory snapshot had items but missed our target.
          // Append the missing item rather than wholesale-replace —
          // preserving any mid-handler mutations sitting in-memory.
          rec.artifacts.plan.items.push(hit);
        }
        return hit;
      }
    }
  } catch (err) {
    console.error(`[bug-74] _findPlanItemInRec file-mirror fallback failed for ${itemId}: ${err && err.message ? err.message : err}`);
  }
  return null;
}

function _broadcastStageState(sessionId, session, itemId, stageState) {
  if (!session) return;
  const payload = stageStateMod.toBroadcastPayload(itemId, stageState);
  session.emit('state-update', { kind: 'plan-item-stage', ...payload });
}

function _initAndBroadcastStageState(sessionId, session, itemId) {
  const rec = sessionsMod.getSessionRecord(sessionId);
  const item = _findPlanItemInRec(rec, itemId);
  if (!item) {
    console.log(`[fr-96] _initAndBroadcastStageState(${sessionId}, ${itemId}) — item not found in plan.json; no-op`);
    return;
  }
  const ss = stageStateMod.initStageState(item);
  sessionsMod.saveStore();
  _broadcastStageState(sessionId, session, itemId, ss);
}

function _transitionStageState(sessionId, session, itemId, stage, status) {
  const rec = sessionsMod.getSessionRecord(sessionId);
  const item = _findPlanItemInRec(rec, itemId);
  if (!item) {
    console.log(`[fr-96] _transitionStageState(${sessionId}, ${itemId}, ${stage}, ${status}) — item not found; no-op`);
    return;
  }
  const ss = stageStateMod.applyTransition(item, stage, status);
  if (!ss) {
    console.log(`[fr-96] _transitionStageState(${sessionId}, ${itemId}, ${stage}, ${status}) — item has no stageState (race with clear?); no-op`);
    return;
  }
  sessionsMod.saveStore();
  _broadcastStageState(sessionId, session, itemId, ss);
}

function _clearAndBroadcastStageState(sessionId, session, itemId) {
  const rec = sessionsMod.getSessionRecord(sessionId);
  const item = _findPlanItemInRec(rec, itemId);
  if (!item) return;                            // already gone — no-op
  const cleared = stageStateMod.clearStageState(item);
  // fr-98: the persisted verdict (item.meta.lastCriticReview) lives in
  // the same item.meta slot as stageState — it's the content the
  // stageState's "awaiting_*" status referred to. When stageState
  // clears (verify-accept / discard), the verdict is no longer
  // pending, so it MUST also clear. The static guard
  // test_lastCriticReview_paired_with_stageState in ./test/test.sh
  // locks this pairing — every clearStageState in attach.js must be
  // adjacent to a clearLastCriticReview.
  const reviewCleared = stageStateMod.clearLastCriticReview(item);
  if (cleared || reviewCleared) {
    sessionsMod.saveStore();
    if (cleared) _broadcastStageState(sessionId, session, itemId, null);
  }
}

// bug-68 (Option B addition 1): emit a system chat note when a stage
// sentinel is received by the server. Closes the observability gap
// between claude's [stage: X done] sentinel and the eventual critic
// verdict (which can be 10-60s+ away for a real critic call). With
// this note, the user always sees "📍 received → 🤔 critic firing →
// (verdict | skip | error)" as a visible chain instead of a 10-60s
// dead air with no signal.
function _emitSentinelReceivedNote(sessionId, session, opts) {
  if (!session) return;
  const { stage, itemId } = opts || {};
  if (!stage || !itemId) return;
  try {
    const note = {
      user: ASSISTANT_USER,
      text: `📍 **${stage.charAt(0).toUpperCase() + stage.slice(1)} sentinel received** for ${itemId} — critic firing (typically 10-30s for Gemini 2.5).`,
      ts: new Date().toISOString(),
      meta: { kind: 'bug-68-sentinel-received', stage, itemId },
    };
    sessionsMod.appendChatMessage(sessionId, note);
    session.emit('chat', note);
    console.log(`[bug-68] sentinel-received note for ${itemId} stage=${stage}`);
  } catch (err) {
    console.error(`[bug-68] sentinel-received note emit failed: ${err.message}`);
  }
}

// bug-68 follow-up (2026-06-07 second wave): emit a synthetic
// critique-review BROADCAST when the critic skips for a "no real
// findings" reason. Pre-follow-up the skip path:
//   1. emitted a chat note ✓
//   2. transitioned stageState to awaiting_accept ✓
//   3. did NOT emit a critique-review broadcast ✗
// Without (3), the client's _renderVerdictPanel had nothing to render
// — state.critiqueReview stayed null. User-reported verbatim on td-35:
//   "the verdict modal is never shown up"
//   "I've never seen ✓ Accept Stage in the verdict HUD either"
// Even though chat-accept worked (typing "accept" → bug-70 picked it
// up → claude advanced via bug-68 dispatch), the user EXPECTED the
// visual pane with the Accept Stage button. This helper synthesizes a
// "✓ AGREED" verdict (isError:false, hasDisagreement:false,
// isSkipped:true marker) so the existing renderer paints a pane with
// title "✓ Gemini Approved Checkpoint (X)" + the intermediate action
// row (Dismiss / Fix Stage / Accept Stage) per bug-56.
//
// Persistence: re-uses fr-98's setLastCriticReview so the pane
// replays on every new attach for as long as stageState.status is
// awaiting_*. Clearing on accept/dismiss is handled by the existing
// _clearAndBroadcastStageState + resolveCritique chokepoints.
function _broadcastSyntheticSkipVerdict(sessionId, session, opts) {
  if (!session) return;
  const { stage, itemId, reason } = opts || {};
  if (!stage || !itemId) return;
  const isIntermediate = stage === 'analyze' || stage === 'code';
  const reasonExplain = {
    'no-changes':       'no file changes were detected at this checkpoint',
    'baseline-wip-only': 'all dirty paths were already modified before this run started (baseline WIP)',
    'empty-diff':       'files changed but the diff was empty (new files git can\'t diff, binaries, or readDiff errors)',
    // bug-90: the operator turned the critic off for this session via
    // /critic off (or the 🔕 Disable critic button on a prior error
    // verdict). The body below uses a distinct title ("🔕 Critic disabled")
    // so the audit trail can see this stage was accepted without a real
    // review — NOT a synthetic AGREED that would mislead post-hoc.
    'critic-disabled':  'the critic has been disabled for this session — /critic on to re-enable',
  }[reason] || 'no reviewable changes were attributable to this stage';
  // bug-90: title + body shift when the operator turned the critic off.
  // The other skip reasons keep the legacy "✓ AGREED — critic skipped"
  // title because they DO represent "nothing to review" — those skips
  // are diff-driven, not policy-driven. critic-disabled is policy.
  const isPolicyDisabled = reason === 'critic-disabled';
  const critiqueBody = isPolicyDisabled
    ? `## 🔕 Critic disabled\n\n` +
      `The critic was turned off for this session — ${reasonExplain}. ` +
      `Stage **${stage}** is being accepted WITHOUT a critic review.\n\n` +
      `**To proceed:** click **✓ Accept Stage** below, or type \`accept\` in chat.\n\n` +
      `*To re-enable the critic for the rest of this session, type* \`/critic on\` *in chat (or use the config admin panel).*`
    : `## ✓ AGREED — critic skipped\n\n` +
      `The **${stage}** stage produced no reviewable changes; ${reasonExplain}. ` +
      `Nothing to flag.\n\n` +
      `**To proceed:** click **✓ Accept Stage** below, or type \`accept\` in chat.\n\n` +
      `*If you intended this stage to produce changes, click **⚡ Ask Claude to Fix Stage** to redo it, or make the changes manually and re-emit* \`[stage: ${stage} done]\`*.*`;
  const broadcastPayload = {
    kind: 'critique-review',
    itemId,
    hasDisagreement: false,
    isError: false,
    isIntermediate,
    isRetry: false,
    isSkipped: true,                  // new flag — traceability + future client tweaks
    skipReason: reason,
    stage,
    critique: critiqueBody,
    diff: '',
    criticName: 'Skip',
    criticId: 'skip',
    specialties: [{ id: 'skip', name: 'Skip', isError: false, isAgreed: true }],
  };
  try {
    session.emit('state-update', broadcastPayload);
    console.log(`[bug-68] synthetic skip-verdict broadcast — itemId=${itemId}, stage=${stage}, reason=${reason}`);
  } catch (err) {
    console.error(`[bug-68] synthetic skip-verdict emit failed: ${err.message}`);
  }
  // fr-98 persistence — replay on attach.
  try {
    const rec = sessionsMod.getSessionRecord(sessionId);
    if (rec) {
      const item = _findPlanItemInRec(rec, itemId);
      if (item) {
        stageStateMod.setLastCriticReview(item, broadcastPayload);
        sessionsMod.saveStore();
      }
      // bug-75 (plan-item bug-69): ALSO update rec._lastCritique so
      // retryLastCritique reads the CURRENT skipped verdict instead of
      // stale prior-stage data. Pre-bug-75 the per-session cache only
      // got refreshed inside triggerGeminiCritique — a skip path
      // bypassed it. Result: clicking 💬 Ask Critic on a skipped
      // verdict re-fired whichever stage's critic last ran for real,
      // re-rendering THAT stage's modal (the user-reported bug-69).
      // The payload mirrors the broadcastPayload so it carries
      // isSkipped:true; retryLastCritique reads that flag and
      // short-circuits with a chat note instead of re-firing.
      rec._lastCritique = {
        itemId,
        itemSnapshot: item,
        diff: '',
        claudeOutput: '',
        isIntermediate,
        stage,
        skipped: true,
        skipReason: reason,
        firedAt: new Date().toISOString(),
      };
      sessionsMod.saveStore();
    }
  } catch (err) {
    console.error(`[bug-68] synthetic skip-verdict persist failed: ${err.message}`);
  }
}

// bug-68: emit a system chat note when a critic call is skipped.
// Pre-bug-68 these skips logged to stderr only — the user saw the
// verdict pane never open and had no signal why. Now both skip cases
// (no-changes, baseline-wip-only) explain themselves in chat so the
// user can decide their next action.
function _emitCritiqueSkipNote(sessionId, session, opts) {
  if (!session) return;
  const { stage, itemId, reason, message } = opts || {};
  if (!message) return;
  try {
    const note = {
      user: ASSISTANT_USER,
      text: message,
      ts: new Date().toISOString(),
      meta: { kind: 'bug-68-critique-skip', stage, itemId, reason },
    };
    sessionsMod.appendChatMessage(sessionId, note);
    session.emit('chat', note);
    console.log(`[bug-68] critique-skip note emitted for ${itemId} stage=${stage} reason=${reason}`);
  } catch (err) {
    console.error(`[bug-68] critique-skip note emit failed: ${err.message}`);
  }
}

// bug-68: post a synthetic user-turn to claude when the user accepts
// or fixes a stage verdict.
//
// Why this exists: pre-bug-68, the accept signal (button click or
// chat-accept phrase) transitioned stageState server-side + broadcast
// `critique-resolved` to clear the verdict pane, but it NEVER
// dispatched anything to claude. The CLAUDE.md §9 protocol document
// said "claude advances to the next stage immediately — NO additional
// `continue` / `proceed` keyword needed beyond the accept signal" but
// the implementation never wired it: claude sat idle awaiting input
// that never arrived. User-reported (verbatim, bug-68 comment):
//   "the current solution is half baked, sometimes the critic verdict
//    would show up, sometimes no, sometimes in wrong order. sometimes
//    no action after I accept the proposal."
//
// Fix: every accept path now calls this helper after the server-side
// state transition. The helper formats a structured synthetic prompt
// + calls session.write() so claude sees a normal user turn with the
// stage-advance cue. Claude reads the bracketed marker
// (`[stage-accepted: X→Y]` or `[stage-fix]`) + the plain-English
// follow-up + acts. The synthetic prompt is also mirrored into the
// chat record (system message, ASSISTANT_USER) so the user can SEE
// what was sent — the chat note + the SDK input share the same body.
//
// Reasons:
//   'accept-stage' → intermediate stage accepted; advance to next
//   'accept-verify' → verify stage accepted; run is complete
//   'fix-stage' → critic flagged issues; redo current stage with
//                 the verdict body included as context
//
// The helper is best-effort: write failures are logged + swallowed so
// a transient SDK queue issue doesn't break the surrounding accept
// flow (the server-side state already moved; the user can re-prompt
// claude with "continue" as a fallback).
function _postAcceptStagePrompt(sessionId, session, opts) {
  if (!session) return false;
  const { itemId, stage, next, reason } = opts || {};
  if (!itemId || !stage || !reason) {
    console.warn(`[bug-68] _postAcceptStagePrompt called with missing fields itemId=${itemId} stage=${stage} reason=${reason}`);
    return false;
  }
  let prompt = '';
  if (reason === 'accept-verify') {
    prompt = `[stage-accepted: verify→done] User accepted the verify stage for plan-item ${itemId}. The 3-stage run is complete. No further action needed for this item; the run-queue will advance to the next pending item if any.`;
  } else if (reason === 'accept-stage') {
    if (!next) {
      console.warn(`[bug-68] accept-stage reason but no next stage provided (stage=${stage}, itemId=${itemId})`);
      return false;
    }
    prompt = `[stage-accepted: ${stage}→${next}] User accepted the ${stage} stage. Please proceed to the ${next} stage.`;
  } else if (reason === 'fix-stage') {
    // fr-98: the verdict body lives at item.meta.lastCriticReview.
    // Include it in the synthetic prompt so claude knows exactly what
    // the critic flagged without re-reading the chat history.
    let verdictBody = '';
    try {
      const rec = sessionsMod.getSessionRecord(sessionId);
      const item = _findPlanItemInRec(rec, itemId);
      const review = stageStateMod.getLastCriticReview(item);
      if (review && typeof review.critique === 'string') {
        // Cap body at 8KB — keep claude's context bounded; the critic
        // verdict markdown is typically 2-5KB anyway.
        verdictBody = review.critique.length > 8192
          ? review.critique.slice(0, 8192) + '\n\n…(truncated; full verdict in chat history)'
          : review.critique;
      }
    } catch (err) {
      console.error(`[bug-68] fix-stage verdict body read failed: ${err.message}`);
    }
    const bodyBlock = verdictBody
      ? `\n\nCritic flagged the following issues:\n\n${verdictBody}\n\n`
      : '\n\n(Critic verdict body unavailable — check the verdict pane in chat for details.)\n\n';
    prompt = `[stage-fix] Critic flagged issues in your ${stage} stage.${bodyBlock}Please redo the ${stage} stage addressing these concerns. Re-emit \`[stage: ${stage} done]\` when finished so the critic can re-evaluate.`;
  } else {
    console.warn(`[bug-68] _postAcceptStagePrompt unknown reason=${reason} (itemId=${itemId}, stage=${stage})`);
    return false;
  }
  // Mirror into the chat record so the user can SEE what was sent.
  // The system-note speaker is ASSISTANT_USER (matching bug-70's pattern
  // for chat-accept notes), but meta.kind tags it for traceability.
  const noteText = reason === 'fix-stage'
    ? `↻ **Fix stage dispatched** — claude was prompted to redo the **${stage}** stage with the critic's flagged issues. See claude's next turn for the redo.`
    : reason === 'accept-verify'
      ? `✓ **Verify accepted** — claude was notified the run is complete; the queue will advance.`
      : `→ **${stage.charAt(0).toUpperCase() + stage.slice(1)} accepted** — claude was prompted to proceed to the **${next}** stage.`;
  try {
    const note = {
      user: ASSISTANT_USER,
      text: noteText,
      ts: new Date().toISOString(),
      meta: { kind: 'bug-68-dispatch', stage, next, reason, itemId },
    };
    sessionsMod.appendChatMessage(sessionId, note);
    session.emit('chat', note);
  } catch (err) {
    console.error(`[bug-68] chat note append failed: ${err.message}`);
  }
  // Dispatch the synthetic prompt as a user-turn to claude.
  try {
    session.write(prompt);
    console.log(`[bug-68] dispatched synthetic prompt to claude — reason=${reason}, itemId=${itemId}, stage=${stage}${next ? ', next=' + next : ''}, len=${prompt.length}`);
    // bug-68 (Option B addition 3): set an accept-ack expectation +
    // start a timeout watcher. The synthetic prompt was pushed into the
    // SDK queue, but session.write is fire-and-forget — if claude is
    // mid-tool-call, interrupted, or the SDK queue is in a weird state,
    // the message could silently fail to land. The expectation tracks
    // {stage, next, itemId, deadline}; the next assistant_text
    // satisfies + clears it (handled in _onAssistantTextClearAckExpectation).
    // If the deadline passes WITHOUT an assistant_text, _emitAcceptAckTimeoutNote
    // surfaces a "claude hasn't picked up the X accept — try typing
    // 'continue' to nudge" note so the user knows + can recover.
    _armAcceptAckExpectation(sessionId, session, { itemId, stage, next, reason });
    return true;
  } catch (err) {
    console.error(`[bug-68] session.write failed: ${err.message}`);
    return false;
  }
}

// bug-68 (Option B addition 3): accept-ack timeout machinery. The
// 3-stage workflow has a fragile boundary at step 4→5: server
// dispatches the synthetic prompt via session.write (fire-and-forget
// into the SDK queue), then waits for claude to acknowledge by
// producing the next assistant_text. If claude is mid-tool-call,
// interrupted, the SDK queue is in a weird state, or the synthetic
// prompt is unreachable for any other reason, the user sees nothing
// and the run stalls.
//
// The watcher is bounded: 90 seconds is generous for claude to start
// a new turn after an accept (typical: 1-5s for a turn_start; rarely
// past 30s even on a slow model). 90s leaves headroom without making
// a wedged session feel infinite.
//
// At most ONE expectation per session at a time. A new arm replaces
// the previous (most-recent accept wins; the prior one is no longer
// relevant if it didn't fire). _activeRunItem clear (verify-accept /
// discard) also clears the expectation.
const ACCEPT_ACK_TIMEOUT_MS = 90_000;

function _armAcceptAckExpectation(sessionId, session, opts) {
  if (!session) return;
  const { itemId, stage, next, reason } = opts || {};
  if (!itemId || !stage || !reason) return;
  // Cancel any existing timer (most-recent accept wins).
  _clearAcceptAckExpectation(session);
  const expectation = {
    itemId, stage, next, reason,
    armedAt: Date.now(),
    deadline: Date.now() + ACCEPT_ACK_TIMEOUT_MS,
  };
  expectation.timer = setTimeout(() => {
    // Re-check expectation is still set (defensive — could have been
    // cleared between deadline + this firing).
    if (session._expectingAcceptAck === expectation) {
      _emitAcceptAckTimeoutNote(sessionId, session, expectation);
      session._expectingAcceptAck = null;
    }
  }, ACCEPT_ACK_TIMEOUT_MS);
  session._expectingAcceptAck = expectation;
  console.log(`[bug-68] armed accept-ack expectation — itemId=${itemId}, stage=${stage}, reason=${reason}, timeout=${ACCEPT_ACK_TIMEOUT_MS}ms`);
}

function _clearAcceptAckExpectation(session) {
  if (!session || !session._expectingAcceptAck) return false;
  const e = session._expectingAcceptAck;
  if (e.timer) {
    try { clearTimeout(e.timer); } catch {}
  }
  session._expectingAcceptAck = null;
  return true;
}

// Called from the agent-event listener when assistant_text arrives.
// Clearing on FIRST assistant_text means claude is producing output,
// which is the cleanest "I picked up the accept" signal we have.
function _onAssistantTextClearAckExpectation(session) {
  if (!session || !session._expectingAcceptAck) return;
  const e = session._expectingAcceptAck;
  const elapsedMs = Date.now() - e.armedAt;
  console.log(`[bug-68] accept-ack satisfied by assistant_text — itemId=${e.itemId}, stage=${e.stage}, elapsed=${elapsedMs}ms`);
  _clearAcceptAckExpectation(session);
}

function _emitAcceptAckTimeoutNote(sessionId, session, expectation) {
  if (!session) return;
  try {
    const { itemId, stage, reason } = expectation;
    const nudgeHint = reason === 'accept-verify'
      ? '`continue` or `summary please`'
      : `\`continue\` or simply name the next stage (e.g. \`${expectation.next || 'code'}\`)`;
    const note = {
      user: ASSISTANT_USER,
      text:
        `⚠️ **Claude hasn't picked up the ${stage} accept** after ${ACCEPT_ACK_TIMEOUT_MS / 1000}s ` +
        `(no assistant turn started). The synthetic dispatch may have fallen into a wedged SDK queue ` +
        `(mid-tool-call, interrupted session, or restart race). ` +
        `Try typing ${nudgeHint} in chat to nudge — the same end state is reached.`,
      ts: new Date().toISOString(),
      meta: { kind: 'bug-68-ack-timeout', stage, itemId, reason, timeoutMs: ACCEPT_ACK_TIMEOUT_MS },
    };
    sessionsMod.appendChatMessage(sessionId, note);
    session.emit('chat', note);
    console.log(`[bug-68] accept-ack TIMEOUT for ${itemId} stage=${stage} — emitted nudge note`);
  } catch (err) {
    console.error(`[bug-68] accept-ack timeout note emit failed: ${err.message}`);
  }
}

// bug-57: clear the active-run-item context + optionally advance the
// run queue. Called by POST /sessions/:id/run/done (which the verdict
// pane's ✓ Accept on verify-stage + ✗ Discard buttons fire). The
// itemId match is idempotent — if the request is for a stale itemId
// that no longer matches the current _activeRunItem (e.g. user
// already dispatched something else), this is a no-op. The reason
// string is logged for audit; not persisted.
//
// Why a helper: extracting the clear out of the inline turn_result
// handler gives fr-96 a single point to attach the state-machine
// transitions to (when verify-accept → mark plan-item.meta.stageState
// = 'done', etc.). Today it's just the clear + advance; fr-96 will
// extend.
function clearActiveRunItem(sessionId, session, opts = {}) {
  if (!session) return false;
  const reqItemId = opts && opts.itemId;
  const reason = (opts && typeof opts.reason === 'string') ? opts.reason : 'unknown';
  const active = session._activeRunItem;
  if (!active || !active.itemId) {
    console.log(`[bug-57] clearActiveRunItem(${sessionId}, ${reqItemId}, ${reason}) — no active run item; no-op`);
    return false;
  }
  if (reqItemId && reqItemId !== active.itemId) {
    console.log(`[bug-57] clearActiveRunItem(${sessionId}, ${reqItemId}, ${reason}) — itemId mismatch (active=${active.itemId}); no-op`);
    return false;
  }
  console.log(`[bug-57] clearActiveRunItem(${sessionId}, ${active.itemId}, ${reason}) — clearing + advancing queue`);
  // bug-68 (Option B addition 3): clear any pending accept-ack
  // expectation. The run is ending (verify-accept / discard) — even
  // if the expectation hasn't fired, there's nothing for claude to
  // respond TO anymore. Without this clear, a stale expectation
  // could fire 30-90s later and emit a misleading "claude hasn't
  // picked up" note on a run that's already over.
  _clearAcceptAckExpectation(session);
  const finishedItemId = active.itemId;
  // bug-68: dispatch the verify-accept synthetic prompt to claude
  // BEFORE the clear runs (so the synthetic turn sees the same
  // _activeRunItem the user accepted). 'chat-accept-verify' is skipped
  // because _maybeHandleChatAccept already dispatched. 'discard' is
  // skipped because the run was ABANDONED, not accepted. 'accept-verify'
  // is the final-pane button's reason — that's the one we wire.
  if (reason === 'accept-verify') {
    try {
      _postAcceptStagePrompt(sessionId, session, {
        itemId: finishedItemId, stage: 'verify', reason: 'accept-verify',
      });
    } catch (err) {
      console.error(`[bug-68] verify-accept dispatch failed: ${err.message}`);
    }
  }
  session._activeRunItem = null;
  session._sawStageSentinelInRun = false;
  // fr-96: clear the stage-state machine. This is the
  // awaiting_accept → [*] cleared transition for the verify stage
  // (run done) OR the wherever-we-were → [*] cleared transition for
  // discard. Broadcasts the cleared state so other devices clear
  // their HUD display of "X awaiting accept on Y stage."
  _clearAndBroadcastStageState(sessionId, session, finishedItemId);
  // bug-64: clear any deferred final critique. The run is ending
  // (discard / verify-accept) — no need to fire the deferred. If
  // we left it set, the next dispatch on this rec could erroneously
  // pick it up.
  const recForDefer = sessionsMod.getSessionRecord(sessionId);
  if (recForDefer && recForDefer._deferredFinalCritique) {
    console.log(`[bug-64] clearActiveRunItem clearing pending _deferredFinalCritique for ${finishedItemId} (reason=${reason})`);
    recForDefer._deferredFinalCritique = null;
    sessionsMod.saveStore();
  }
  // Advance the queue if this item was the head running entry. The
  // turn_result handler used to fire this on every success; with
  // bug-57 we defer it to /run/done so multi-stage runs don't
  // prematurely advance to the next plan item.
  try {
    _advanceRunQueue(sessionId, session, finishedItemId, { subtype: 'success' });
  } catch (err) {
    console.error('[bug-57] _advanceRunQueue from clearActiveRunItem failed:', err.message);
  }
  return true;
}

module.exports = {
  getSession,
  killSession,
  attachWebSocket,
  attachViewerWebSocket,
  handleChatMessage,
  _registerExternalSession,
  // bug-82: exported for the regression test that wires multiple stub
  // "devices" to a session and asserts the chat-accept handler
  // broadcasts critique-resolved to all of them.
  _maybeHandleChatAccept,
  handleMenuPick,
  handleMenuToggle,
  handleMenuSubmit,
  _detectMentionTarget,
  _supersedeStaleMenus,
  // bug-17 fix: exposed so sessions.addAdminToSession +
  // removeAdminFromSession can kick the affected user's existing WS
  // and force a reconnect (the readOnly flag is one-shot at attach
  // time, so rec.admins changes don't reach in-flight viewer WSes
  // without a reconnect).
  _kickViewerByLogin,
  // bug-57: clearActiveRunItem helper — exported for the
  // POST /sessions/:id/run/done route in index.js.
  clearActiveRunItem,
  // fr-96: stage-state helpers exported for critique.js (which calls
  // _transitionStageState after broadcasting critique-review + after
  // resolving via Accept Stage / Fix Stage). Keeping the broadcast
  // helper centralized in attach.js ensures one source of truth for
  // the state-update emit shape.
  _transitionStageState,
  _clearAndBroadcastStageState,
  _findPlanItemInRec,
  // bug-60: exposed for testability. The one-line summary extractor
  // is a pure function (unit-testable in isolation); the run-outcome
  // stamper is exercised end-to-end by test/bug-60-…-test.js with a
  // synthesized rec + plan-item to assert the comment body is a
  // single line.
  _extractRunOutcomeSummaryLine,
  _stampPlanItemRunOutcome,
  // bug-68: synthetic accept-prompt dispatcher. Exported so
  // critique.resolveCritique can call the same chokepoint as
  // _maybeHandleChatAccept — both accept paths land at the same end
  // state (claude actually moves on).
  _postAcceptStagePrompt,
  // bug-75 (plan-item bug-69): synthetic skip-verdict broadcaster
  // exported for the end-to-end test that exercises the
  // "Ask Critic on a skipped verdict must not re-fire stale prior
  // stage" repro.
  _broadcastSyntheticSkipVerdict,
  // Re-export menu helpers so callers that historically grabbed them off
  // ptyMod continue to find them.
  handleSessionMenu: menuMod.handleSessionMenu,
  broadcastMenuToChat: menuMod.broadcastMenuToChat,
};
