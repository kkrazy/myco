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

// Register a session object (currently always AgentSession from
// server/src/agent-session.js). Lets the WS attach + state-update + chat
// plumbing find it via the module-local `sessions` map and wires the
// session's 'menu' event into menuMod.handleSessionMenu so canUseTool
// fires propagate into chat-pane menu cards.
function _registerExternalSession(sessionId, session) {
  sessions.set(sessionId, session);
  if (typeof session.on === 'function') {
    session.on('menu', (menu) => menuMod.handleSessionMenu(sessionId, session, menu));
    // Plan-item ▶ Run linkage: when the user kicks off a run via
    // the chat-pane Run button, handleChatMessage stamps
    // session._activeRunItem with the item id. On turn_result we
    // append a run record to that item (status / summary / cost /
    // turn ts) and broadcast the artifact update so all clients
    // see the linked status. One run per turn — _activeRunItem
    // clears after the outcome is stamped.
    session.on('agent-event', (ev) => {
      if (!ev || ev.type !== 'turn_result') return;
      const active = session._activeRunItem;
      if (!active) return;
      try {
        _stampPlanItemRunOutcome(sessionId, active.itemId, ev, active.startedAt);
      } catch (err) {
        console.error('[plan-run] stamp outcome failed:', err.message);
      }
      // fr-48: queue auto-advance. If the just-finished item is the
      // head of the run-queue, mark its outcome + dispatch the next
      // pending entry (or pause on failure).
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
  if (!Array.isArray(item.comments)) item.comments = [];
  const glyph = status === 'success' ? '✓' : '⚠';
  const headerBits = [`${glyph} ${status}`, durS, costStr,
    `${inTok}↓/${outTok}↑`].filter(Boolean).join(' · ');
  const resultBody = outcome.result
    ? (outcome.result.length > 800 ? outcome.result.slice(0, 797) + '…' : outcome.result)
    : '_(no final assistant text — see the chat timeline for the per-tool detail)_';
  const summaryText = `${headerBits}\n\n${resultBody}`;
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
    if (keepFromIdx > 0) {
      trimmed = events.slice(keepFromIdx);
      console.log(`[agent-replay] ${sessionId} ${phase} byte-trim ${events.length} → ${trimmed.length} events (${bytes} bytes, budget ${maxBytes})`);
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

  session.on('agent-event', onAgentEvent);
  session.on('chat', onChat);
  session.on('state-update', onStateUpdate);
  session.on('exit', onExit);

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
      if (text) handleChatMessage(sessionId, session, user, text.slice(0, CHAT_TEXT_LIMIT));
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
    const artifacts = {};
    for (const type of ['plan', 'test', 'arch']) {
      const fromFile = getArtifactsMod().__test.readArtifactFromFile(rec, type);
      const inMem = rec.artifacts && rec.artifacts[type];
      const picked = fromFile || inMem || null;
      if (picked) artifacts[type] = picked;
    }
    ws.send(JSON.stringify({ t: 'artifacts-init', artifacts }));
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
    ]);
    const guestOK = isMention || (cmd && GUEST_ALLOWED_CMDS.has(cmd));
    if (!guestOK) {
      const denyMsg = {
        user: ASSISTANT_USER,
        text: '(read-only viewer — claude-routing is owner-only. You can `@<user>` to discuss, or use `/td <text>`, `/fr <text>`, `/bug <text>` to add plan items.)',
        ts: new Date().toISOString(),
      };
      sessionsMod.appendChatMessage(sessionId, denyMsg);
      session.emit('chat', denyMsg);
      console.log(`[chat-readonly] ${sessionId} ${user}: blocked '${text.slice(0,40)}…' (not mention/whitelisted slash)`);
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
  // [run:<type>#<id>] marker: the chat-pane's ▶ Run button on a
  // plan item produces this prefix. Stash {type, id} on the
  // session so the NEXT turn_result lands a status record on the
  // matched plan item via _attachPlanRunOutcome.
  const runMatch = text.match(/\[run:(plan|test|arch|td|fr|bug)#([A-Za-z0-9_-]+)\]/);
  if (runMatch && user !== ASSISTANT_USER) {
    session._activeRunItem = {
      type: 'plan',                            // td/fr/bug all live in plan.json today
      itemId: runMatch[2],
      startedAt: new Date().toISOString(),
    };
    _stampPlanItemStatus(sessionId, runMatch[2], 'running', null);
  }
  sessionsMod.appendChatMessage(sessionId, message);
  session.emit('chat', message);

  if (user === ASSISTANT_USER) return;
  if (mentionTarget) return;

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

module.exports = {
  getSession,
  killSession,
  attachWebSocket,
  attachViewerWebSocket,
  handleChatMessage,
  _registerExternalSession,
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
  // Re-export menu helpers so callers that historically grabbed them off
  // ptyMod continue to find them.
  handleSessionMenu: menuMod.handleSessionMenu,
  broadcastMenuToChat: menuMod.broadcastMenuToChat,
};
