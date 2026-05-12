const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const { EventEmitter } = require('events');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { MenuInterceptor } = require('./menu-interceptor');
const permissions = require('./permissions');
// Late-bound: sessions.js requires this module, so destructuring at load
// time would capture undefined values from the partial export.
const sessionsMod = require('./sessions');
const { askAssistant, shouldAskAssistant, ASSISTANT_USER } = require('./btw');
const { stripAnsi, tailLines } = require('./text-utils');
const menuMod = require('./menu');
const slashcmds = require('./slashcmds');
const transcriptMod = require('./transcript');

const MAX_BUFFER = 1024 * 1024;
const CHAT_TEXT_LIMIT = 4000;
const ASSISTANT_SCROLLBACK_LINES = 40;
const ASSISTANT_CHAT_CONTEXT = 20;

class PtySession extends EventEmitter {
  constructor(sessionId, ptyProcess) {
    super();
    this.sessionId = sessionId;
    this.pty = ptyProcess;
    this.buffer = [];
    this.bufferSize = 0;
    this.alive = true;
    this.cols = ptyProcess.cols;
    this.rows = ptyProcess.rows;

    // Server-side headless terminal emulator. We mirror every PTY byte
    // through it so we can hand viewers a clean, layout-resolved snapshot
    // of the current visible screen — alt-screen, cursor positioning,
    // wraparound and clears all collapse into plain text per row.
    // allowProposedApi exposes the buffer reading API; logLevel:'off'
    // silences xterm's chatty info logs.
    this.headless = new HeadlessTerminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: 1000,
      allowProposedApi: true,
      logLevel: 'off',
    });

    // Detects when Claude shows a TUI menu (plan-finalization etc.) so we
    // can forward it to the discussion panel. The session caches the most
    // recent fired menu in `pendingMenu` so the /decide slash command knows
    // which dialog the user is responding to.
    this.menuInterceptor = new MenuInterceptor();
    this.pendingMenu = null;
    this._menuDebounce = null;

    this.pty.onData((data) => {
      this._push(data);
      try { this.headless.write(data); } catch {}
      // Debounce menu detection — wait until the alt-screen render settles
      // before reading it, otherwise we'd scan partially-painted dialogs.
      if (this._menuDebounce) clearTimeout(this._menuDebounce);
      this._menuDebounce = setTimeout(() => this._checkMenu(), 250);
      this.emit('data', data);
    });
    this.pty.onExit(({ exitCode }) => {
      this.alive = false;
      this.emit('exit', exitCode);
    });
  }

  _checkMenu() {
    this._menuDebounce = null;
    if (!this.headless) return;
    const change = this.menuInterceptor.detectChange(this.headless);
    // Debug: when MYCO_MENU_DEBUG=1, dump the headless visible text on
    // every detectChange call so we can correlate what the scanner sees
    // with what claude is actually rendering. Throttled to one dump per
    // 3s per session to keep logs readable.
    if (process.env.MYCO_MENU_DEBUG === '1') {
      const now = Date.now();
      if (!this._lastMenuDump || now - this._lastMenuDump > 3000) {
        this._lastMenuDump = now;
        let snap = '';
        try { snap = this.getVisibleText().slice(-1200); } catch (e) { snap = `(getVisibleText threw: ${e.message})`; }
        const tag = change ? change.kind : 'noChange';
        console.log(`[menu-debug] ${this.sessionId} scan=${tag} headless tail:\n${snap}\n[menu-debug end]`);
      }
    }
    if (!change) return;
    if (change.kind === 'newMenu') {
      this.pendingMenu = change.menu;
      this.emit('menu', change.menu);
    } else if (change.kind === 'cleared') {
      this.pendingMenu = null;
      this.emit('menu-cleared');
    }
  }

  _push(data) {
    this.buffer.push(data);
    this.bufferSize += data.length;
    while (this.bufferSize > MAX_BUFFER && this.buffer.length > 1) {
      const removed = this.buffer.shift();
      this.bufferSize -= removed.length;
    }
  }

  write(data) {
    if (this.alive) this.pty.write(data);
  }

  resize(cols, rows) {
    if (!this.alive) return;
    try {
      this.pty.resize(cols, rows);
      this.cols = cols;
      this.rows = rows;
      try { this.headless.resize(cols, rows); } catch {}
      this.emit('resize', { cols, rows });
    } catch {}
  }

  // Read the headless terminal's currently-visible screen as plain text.
  // One line per row of the active buffer (alt-screen-aware), trailing
  // whitespace stripped per row, blank rows preserved up to the last
  // non-empty one (so a "Y/n" prompt with empty rows below it doesn't
  // grow into pages of blank space).
  getVisibleText() {
    const buf = this.headless.buffer.active;
    const rows = this.headless.rows;
    const lines = [];
    for (let i = 0; i < rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      if (!line) { lines.push(''); continue; }
      lines.push(line.translateToString(true).replace(/\s+$/, ''));
    }
    // Trim trailing blank rows for compactness.
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.join('\n');
  }

  kill() {
    if (this.alive) {
      try { this.pty.kill(); } catch {}
      this.alive = false;
    }
    try { this.headless.dispose(); } catch {}
    this.headless = null;
    this.buffer = [];
    this.bufferSize = 0;
    this.removeAllListeners();
  }
}

const sessions = new Map(); // sessionId -> PtySession

function buildClaudeArgs({ resumeId } = {}) {
  // --permission-mode acceptEdits sets Claude's mode at spawn time so file
  // edits go through unattended (Bash and other tool permissions still flow
  // through our menu interceptor / per-session allow list). Doing it at
  // spawn replaces the old runtime Shift+Tab auto-toggle which relied on
  // pattern-matching banner text in the headless terminal and could land
  // in the wrong mode if Claude's UI strings drifted or a frame was
  // mid-render. State is correct by construction now.
  //
  // (--dangerously-skip-permissions is rejected when running as root, which
  // is our container user. acceptEdits has no such restriction.)
  const args = ['--permission-mode', 'acceptEdits'];
  if (resumeId) args.push('--resume', resumeId);
  return args;
}

function spawnClaude(sessionId, { cwd, resumeId, cols = 120, rows = 30 }) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  const args = buildClaudeArgs({ resumeId });
  const proc = pty.spawn('claude', args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'vscode',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'C.UTF-8',
    },
  });
  const wrapped = new PtySession(sessionId, proc);
  sessions.set(sessionId, wrapped);
  wrapped.on('menu', (menu) => menuMod.handleSessionMenu(sessionId, wrapped, menu));
  wrapped.on('exit', () => {
    setTimeout(() => {
      const cur = sessions.get(sessionId);
      if (cur === wrapped) sessions.delete(sessionId);
    }, 250);
  });
  return wrapped;
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function killSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) { s.kill(); sessions.delete(sessionId); }
}

// Wire transcript messages from a session's JSONL file to a websocket.
// Handles the new-session race: a freshly spawned Claude takes ~5s to
// write its first JSONL line, so resolveTranscriptPath returns null on
// the initial attach. We send transcript-waiting, then poll every 2s
// until the path resolves, then stream transcript-init followed by
// transcript-delta on every appended message.
//
// Returns a cleanup function the caller wires onto ws.on('close').
// Both attachWebSocket (owner) and attachViewerWebSocket (viewer) use
// this — previously only the viewer path polled, which left owners on
// fresh sessions without any transcript stream at all.
function streamTranscriptToWs(sessionId, ws) {
  let pollTimer = null;
  let unwatch = null;
  let closed = false;

  function startWatching(filePath) {
    transcriptMod.readNewMessages(filePath, 0).then(({ messages, bytesRead }) => {
      if (closed || ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ t: 'transcript-init', messages, bytes: bytesRead }));
      unwatch = transcriptMod.watchTranscript(filePath, (newMsgs) => {
        if (!closed && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ t: 'transcript-delta', messages: newMsgs }));
        }
      });
    }).catch(() => {});
  }

  const initialPath = transcriptMod.resolveTranscriptPath(sessionId);
  if (initialPath) {
    startWatching(initialPath);
  } else {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'transcript-waiting' }));
    pollTimer = setInterval(() => {
      if (closed || ws.readyState !== ws.OPEN) { clearInterval(pollTimer); pollTimer = null; return; }
      const p = transcriptMod.resolveTranscriptPath(sessionId);
      if (p) { clearInterval(pollTimer); pollTimer = null; startWatching(p); }
    }, 2000);
  }

  return function cleanup() {
    closed = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (unwatch) { unwatch(); unwatch = null; }
  };
}

function attachWebSocket(session, ws, opts = {}) {
  const readOnly = !!opts.readOnly;
  const user = opts.user || null;
  const sessionId = session.sessionId;

  // Replay ring buffer first so reconnects see prior context.
  const replay = Buffer.concat(session.buffer.map((d) => Buffer.from(d, 'utf8')));
  if (replay.length) {
    ws.send(JSON.stringify({ t: 'output', data: replay.toString('base64') }));
  }

  // Replay chat history so a returning client sees the discussion.
  const history = sessionsMod.getChatHistory(sessionId);
  if (history.length) {
    ws.send(JSON.stringify({ t: 'chat-history', messages: history }));
  }

  // Owners also receive the structured transcript so they can flip to a
  // "preview as viewer" mode in the UI without re-fetching. The helper
  // handles the new-session race (JSONL not yet written).
  const stopTranscript = streamTranscriptToWs(sessionId, ws);

  const onData = (data) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ t: 'output', data: Buffer.from(data, 'utf8').toString('base64') }));
  };
  const onExit = (code) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ t: 'exit', code }));
  };
  const onChat = (message) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ t: 'chat', message }));
  };
  session.on('data', onData);
  session.on('exit', onExit);
  session.on('chat', onChat);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    // Liveness probe — clients send this on visibility-visible to detect a
    // silently-dead WS (mobile background suspension, NAT timeout). Allowed
    // for read-only viewers too; pong reveals nothing they couldn't infer.
    if (msg.t === 'ping') {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'pong' }));
      return;
    }
    if (msg.t === 'chat' && typeof msg.text === 'string') {
      // Read-only / unauthenticated viewers can read chat but not post.
      if (readOnly || !user) return;
      const text = msg.text.trim();
      if (!text) return;
      handleChatMessage(sessionId, session, user, text.slice(0, CHAT_TEXT_LIMIT));
      return;
    }
    if (readOnly) return; // share-link viewers can watch but not type / resize
    if (msg.t === 'input' && typeof msg.data === 'string') {
      session.write(Buffer.from(msg.data, 'base64').toString('utf8'));
    } else if (msg.t === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
      session.resize(msg.cols, msg.rows);
    }
  });

  ws.on('close', () => {
    session.off('data', onData);
    session.off('exit', onExit);
    session.off('chat', onChat);
    stopTranscript();
  });
}

function attachViewerWebSocket(session, ws, opts = {}) {
  const user = opts.user || null;
  const sessionId = session.sessionId;

  // Chat relay (same as owner connection)
  const history = sessionsMod.getChatHistory(sessionId);
  if (history.length) {
    ws.send(JSON.stringify({ t: 'chat-history', messages: history }));
  }
  const onChat = (message) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'chat', message }));
  };
  session.on('chat', onChat);

  // viewer-mode includes the owner login so the client can render a
  // "Read-only — owned by @kkrazy" badge above the transcript.
  const ownerLogin = sessionsMod.getSessionRecord(sessionId)?.user || null;
  ws.send(JSON.stringify({ t: 'viewer-mode', owner: ownerLogin }));

  // Note: the live PTY snapshot panel was removed at user request — viewers
  // see only the structured transcript below. The server still runs every
  // PTY byte through a headless xterm (PtySession.headless) for auto-mode
  // detection in handleChatPostfixes, but no per-snapshot WS frames are
  // sent to viewers.

  // Stream structured transcript via the shared helper — handles the
  // new-session race where the JSONL file doesn't exist yet.
  const stopTranscript = streamTranscriptToWs(sessionId, ws);

  function handleViewerInbound(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'ping' && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'pong' }));
    }
    if (msg.t === 'chat' && typeof msg.text === 'string' && user) {
      const text = msg.text.trim();
      // Viewers (read-only) get the same chat surface as the owner, including
      // @myco to address the running Claude session — chat is the
      // collaborative steering channel and viewers can participate.
      if (text) handleChatMessage(sessionId, session, user, text.slice(0, CHAT_TEXT_LIMIT));
    }
  }

  ws.on('message', handleViewerInbound);
  ws.on('close', () => {
    session.off('chat', onChat);
    stopTranscript();
  });
}

function handleChatMessage(sessionId, session, user, text /* opts = {} */) {
  const message = {
    user,
    text,
    ts: new Date().toISOString(),
  };
  sessionsMod.appendChatMessage(sessionId, message);
  session.emit('chat', message);

  // Don't reply to claude's own messages — would loop forever if claude's
  // response happened to end in '?'.
  if (user === ASSISTANT_USER) return;

  // (Note: the old proactive Shift+Tab auto-toggle that fired on every
  // human chat is removed. Claude now starts in accept-edits at spawn
  // via --permission-mode acceptEdits, so we don't need to nudge the
  // mode at runtime — and the old detection-then-toggle was fragile
  // because pattern-matching the headless terminal could misread state
  // and end up toggling INTO plan mode instead of accept-edits.)

  // Registered slash commands (/feature, /bug, /help, …) are handled by
  // the slashcmds dispatcher. /btw is intentionally NOT in the registry —
  // it's the existing claude-in-chat trigger handled below by btw.js.
  if (text.startsWith('/')) {
    const rec = sessionsMod.loadStore().sessions[sessionId];
    const absCwd = rec && rec.absCwd;
    const ctx = {
      user,
      sessionId,
      absCwd,
      session,                          // for /decide and future PTY-writing commands
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
      // If not a known slash command, fall through to the @myco / /btw paths
      // synchronously. (Async fall-through is awkward; for /btw the existing
      // shouldAskAssistant path below picks it up because parseCommand
      // returned null for /btw specifically.)
      if (handled) return;
      handleChatPostfixes(sessionId, session, user, text, message);
    });
    return;
  }

  handleChatPostfixes(sessionId, session, user, text, message);
}

// The non-slash routing — kept as a separate function so the slash path
// can fall through after dispatch().
function handleChatPostfixes(sessionId, session, user, text, message) {
  // @myco → send the message to the running Claude PTY session. Open to all
  // chat participants (owner + read-only viewers), since the chat is the
  // collaborative steering channel for the session.
  // [\s\S] (not .) so a multi-line @myco message — now reachable via the
  // discussion panel's textarea — captures all lines, not just the first.
  const mycoMatch = text.match(/^@myco\s+([\s\S]+)/i);
  if (mycoMatch) {
    if (!session.alive) {
      // Used to silently drop here — viewers' @myco messages would
      // disappear into the void with no feedback. Echo a warning so the
      // sender knows the PTY is gone and to reattach.
      session.emit('chat', {
        user: ASSISTANT_USER,
        text: '(this Claude session has exited — reopen the session to continue)',
        ts: new Date().toISOString(),
      });
      return;
    }
    const input = mycoMatch[1].trim();
    if (input) {
      // Reject Claude's interactive slash-commands. They aren't meaningful
      // when delivered via chat — Claude responds "Unknown command: /<x>"
      // which then sticks in the transcript and confuses every viewer.
      if (input.startsWith('/')) {
        session.emit('chat', {
          user: ASSISTANT_USER,
          text: '(slash commands like `/' + input.split(/\s+/)[0].slice(1) + '` only work in the interactive Claude CLI, not via @myco in chat)',
          ts: new Date().toISOString(),
        });
        return;
      }
      // Special key tokens — let viewers respond to Claude's interactive
      // prompts (y/n confirmations, "press Enter to continue", etc.) without
      // a real terminal. The token is written verbatim, no trailing CR.
      const SPECIAL_KEYS = {
        enter: '\r',
        return: '\r',
        esc: '\x1b',
        escape: '\x1b',
        'ctrl-c': '\x03',
        '^c': '\x03',
        space: ' ',
        tab: '\t',
        'shift-tab': '\x1b[Z',
        'shift+tab': '\x1b[Z',
      };
      const specialBytes = SPECIAL_KEYS[input.toLowerCase()];
      if (specialBytes !== undefined) {
        console.log(`[chat→pty] ${user}: <key:${input}>`);
        session.write(specialBytes);
        return;
      }
      // If a TUI menu is open in Claude (plan-mode "what next" or a
      // permission ask that fell through to /decide), short-circuit two
      // common shapes of @myco message so the user doesn't get stuck:
      //
      //   * @myco <digit>  → treat as a direct option pick (same effect
      //     as /decide N). Most users type "1" / "2" naturally and don't
      //     discover /decide.
      //   * @myco <anything else> → cancel the menu first with Esc, then
      //     send the new instruction. The user's intent is "do this new
      //     thing"; leaving the stale menu around just wedges Claude.
      const pendingMenu = session.pendingMenu;
      if (pendingMenu) {
        const asDigit = /^[1-9]$/.test(input) ? parseInt(input, 10) : NaN;
        if (Number.isFinite(asDigit) && pendingMenu.options.find((o) => o.n === asDigit)) {
          console.log(`[chat→pty] ${user}: menu pick ${asDigit} (via @myco shorthand)`);
          session.write(String(asDigit) + '\r');
          session.pendingMenu = null;
          return;
        }
        console.log(`[chat→pty] ${user}: cancelling pending menu (Esc) before new instruction`);
        session.write('\x1b');
        session.pendingMenu = null;
        // Surface what we did so the user understands the menu went away.
        sessionsMod.appendChatMessage(sessionId, {
          user: ASSISTANT_USER,
          text: '(cancelled the pending menu so I can act on your new instruction. Use `/decide <n>` next time if you wanted to answer it.)',
          ts: new Date().toISOString(),
        });
        session.emit('chat', {
          user: ASSISTANT_USER,
          text: '(cancelled the pending menu so I can act on your new instruction. Use `/decide <n>` next time if you wanted to answer it.)',
          ts: new Date().toISOString(),
        });
        // fall through to the normal toggle + send below
      }
      // No mode-toggle preamble — Claude is in accept-edits mode from spawn
      // (--permission-mode acceptEdits) and tool-approval gaps are handled
      // by the menu interceptor + per-session allow list.
      //
      // Split the write into TWO PTY operations: the text first, then the
      // trailing \r after a short delay. When everything ships as one
      // chunk (or when wrapped in bracketed-paste markers), Claude Code's
      // TUI input editor sometimes treats the bundle as
      // multi-line-paste-with-Enter-inside-the-paste, leaving the prompt
      // typed in the input but never submitted. Mobile is hit hardest
      // because WS frames arrive bunched on slower networks; viewers
      // (read-only) hit the same path. The 100ms gap lets the input
      // buffer settle (cursor at end, no pending paste state) before the
      // submit keystroke lands. session.alive is re-checked at the
      // timeout boundary so a session that died between the two writes
      // doesn't throw.
      //
      // The "leading newline" appearance we previously chased via paste-
      // wrapping turned out to be Claude Code's OWN TUI input layout
      // (physical-keyboard typing produces the same look), not something
      // our PTY writes cause. So no leading-newline regression from this
      // split.
      console.log(`[chat→pty] ${user}: ${input.substring(0, 80)}`);
      session.write(input);
      setTimeout(() => {
        if (session && session.alive) session.write('\r');
      }, 100);
    }
    return;
  }

  if (shouldAskAssistant(text)) {
    runAssistant(sessionId, session, message).catch((err) => {
      console.error(`[chat-assistant] ${err.message}`);
    });
  }
}

async function runAssistant(sessionId, session, lastMessage) {
  // Snapshot context BEFORE invoking — chatHistory excludes lastMessage so
  // it's not duplicated (we pass it separately as the prompt target).
  const all = sessionsMod.getChatHistory(sessionId);
  const chatHistory = all.slice(-ASSISTANT_CHAT_CONTEXT - 1, -1); // exclude latest
  const buffer = session.buffer.join('');
  const scrollback = tailLines(stripAnsi(buffer), ASSISTANT_SCROLLBACK_LINES);
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

// Read the bottom rows of the session's headless terminal and decide what
// mode Claude Code's TUI is in. Claude Code paints a status hint at the
// bottom of its alt-screen: something like "auto-accept edits on" when in
// accept-edits mode, "plan mode on" when in plan mode, and no mode label
// when in default. Returns a string we use to map → number of Shift+Tab
// presses needed to land in 'accept'. 'unknown' falls back to no-op.
function detectClaudeMode(session) {
  if (!session || !session.headless) return 'unknown';
  try {
    const buf = session.headless.buffer.active;
    const rows = session.headless.rows;
    // Inspect the last ~8 visible rows — the mode hint is anchored at
    // the bottom of the TUI, near the input prompt.
    const tail = [];
    for (let i = Math.max(0, rows - 8); i < rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      if (line) tail.push(line.translateToString(true));
    }
    const blob = tail.join('\n').toLowerCase();
    let mode;
    // Patterns updated to match Claude Code's actual status bar variants:
    // ⏵⏵ auto-accept edits on (shift+tab to cycle)
    // ⏸ plan mode on (shift+tab to cycle)
    // (no mode label) → default mode
    if (/accept edits|auto-accept|auto edit/i.test(blob)) mode = 'accept';
    else if (/plan mode/i.test(blob)) mode = 'plan';
    else mode = 'default';
    // Log the detected mode + a tiny tail snippet so we can confirm the
    // patterns are matching reality. Short enough not to flood logs.
    console.log(`[auto-mode] detected=${mode} tail=${JSON.stringify(blob.slice(-160))}`);
    return mode;
  } catch { return 'unknown'; }
}

// Bytes to send to land in accept-edits mode given the current detected
// mode. Claude Code cycles default → accept → plan → default on Shift+Tab,
// so getting from each starting mode takes 0/1/2 presses.
const SHIFT_TAB = '\x1b[Z';
function autoAcceptToggleBytes(session) {
  switch (detectClaudeMode(session)) {
    case 'accept':  return '';                        // already there
    case 'default': return SHIFT_TAB;                 // 1 cycle: default → accept
    case 'plan':    return SHIFT_TAB + SHIFT_TAB;     // 2 cycles: plan → default → accept
    default:        return '';                        // unknown → don't risk a stray toggle
  }
}

module.exports = {
  spawnClaude,
  getSession,
  killSession,
  attachWebSocket,
  attachViewerWebSocket,
  handleChatMessage,
  // Re-exported for menu-broadcast.test.js — the live implementations now
  // live in menu.js; this surface stays so the test contract (and any
  // outside caller that pulls the menu helpers off ptyMod) keeps working.
  handleSessionMenu: menuMod.handleSessionMenu,
  broadcastMenuToChat: menuMod.broadcastMenuToChat,
};
