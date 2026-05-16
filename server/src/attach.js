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

// Return the canonical username if `text` starts with `@<known-user>`
// (optionally followed by a body). Used by handleChatMessage to short-
// circuit chat-only mentions so they're stamped + persisted without
// being forwarded to claude.
//
// Matches `@kkrazy`, `@kkrazy hi there`, `@kkrazy, …` (trailing punct OK).
// Returns null for `@<unknown-word>` — those fall through to the
// normal chat-to-claude path. (The legacy `@myco` / `@claude`
// "talk-to-claude" prefix is gone — every chat message reaches claude
// by default; only the head-of-message mention syntax is special.)
function _detectMentionTarget(text) {
  const m = String(text || '').match(/^@([A-Za-z][\w-]{0,30})\b/);
  if (!m) return null;
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
const _sessionKillTimers = new Map();

function _scheduleSessionKill(sessionId, reason) {
  const existing = _sessionKillTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    _sessionKillTimers.delete(sessionId);
    // Only kill if STILL idle — defensive in case the timer fires
    // a hair after a reconnect cancelled it (race with setTimeout's
    // clearing semantics is rare but possible).
    const set = _sessionPresence.get(sessionId);
    if (set && set.size > 0) {
      console.log(`[keepalive] ${sessionId} grace expired but ${set.size} client(s) reattached — staying alive`);
      return;
    }
    console.log(`[keepalive] ${sessionId} grace expired (${reason || 'no clients'}) — reaping`);
    killSession(sessionId);
  }, SESSION_KEEPALIVE_GRACE_MS);
  _sessionKillTimers.set(sessionId, timer);
}

function _cancelSessionKill(sessionId) {
  const existing = _sessionKillTimers.get(sessionId);
  if (!existing) return;
  clearTimeout(existing);
  _sessionKillTimers.delete(sessionId);
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

function attachWebSocket(session, ws, opts = {}) {
  return _attachAgentWebSocket(session, ws, opts);
}

function _attachAgentWebSocket(session, ws, opts = {}) {
  const user = opts.user || null;
  const sessionId = session.sessionId;

  if (Array.isArray(session.buffer) && session.buffer.length) {
    ws.send(JSON.stringify({ t: 'agent-replay', events: session.buffer }));
  }
  console.log(`[agent-attach] ${sessionId} user=${user || 'unknown'} mode=agent replay-events=${(session.buffer || []).length} sdk-session=${session.sdkSessionId || 'none'}`);
  if (session.sdkSessionId && !session._iterating && (!session.buffer || !session.buffer.length)) {
    console.log(`[agent-resume] ${sessionId} ready to resume sdk-session=${session.sdkSessionId} on next user message`);
  }

  const history = sessionsMod.getChatHistory(sessionId);
  if (history.length) {
    ws.send(JSON.stringify({ t: 'chat-history', messages: history }));
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
// snapshot + state mutations, but does NOT forward agent-event frames
// (those carry tool inputs that may be sensitive). Viewers can post
// chat and pick menu rows — chat is the collaborative steering channel.
function attachViewerWebSocket(session, ws, opts = {}) {
  const user = opts.user || null;
  const sessionId = session.sessionId;

  const history = sessionsMod.getChatHistory(sessionId);
  if (history.length) {
    ws.send(JSON.stringify({ t: 'chat-history', messages: history }));
  }
  _sendAttachSnapshot(session, ws);

  const onChat = (message) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'chat', message }));
  };
  const onStateUpdate = (payload) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'state-update', ...payload }));
  };
  session.on('chat', onChat);
  session.on('state-update', onStateUpdate);

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
  }

  ws.on('message', handleViewerInbound);
  ws.on('close', () => {
    session.off('chat', onChat);
    session.off('state-update', onStateUpdate);
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

  handleChatPostfixes(sessionId, session, user, text, message);
}

// Non-slash routing fallthrough — separate function so the slash path
// can chain into it after dispatch() returns false.
function handleChatPostfixes(sessionId, session, user, text, message) {
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

  // Bare-digit menu pick for the most recently broadcast menu. Delegate
  // to handleMenuPick so we get BOTH effects:
  //   (1) session.resolveMenuPick — unblocks the SDK's canUseTool
  //       promise so claude can proceed
  //   (2) _markMenuChatAnswered — stamps the chat row's meta.pickedN +
  //       meta.answered and emits a state-update to all clients
  const asDigit = /^[1-9]$/.test(input) ? parseInt(input, 10) : NaN;
  if (Number.isFinite(asDigit) && session.pendingMenu) {
    const hash = session.pendingMenu.hash;
    if (hash) {
      console.log(`[chat→agent] ${user}: menu pick ${asDigit} (chat shorthand, hash=${hash.slice(-12)})`);
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
  // Re-export menu helpers so callers that historically grabbed them off
  // ptyMod continue to find them.
  handleSessionMenu: menuMod.handleSessionMenu,
  broadcastMenuToChat: menuMod.broadcastMenuToChat,
};
