const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const { EventEmitter } = require('events');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
// Late-bound: sessions.js requires this module, so destructuring at load
// time would capture undefined values from the partial export.
const sessionsMod = require('./sessions');
const { askAssistant, shouldAskAssistant, stripAnsi, tailLines, ASSISTANT_USER } = require('./btw');
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

    this.pty.onData((data) => {
      this._push(data);
      try { this.headless.write(data); } catch {}
      this.emit('data', data);
    });
    this.pty.onExit(({ exitCode }) => {
      this.alive = false;
      this.emit('exit', exitCode);
    });
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
  const args = [];
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
  });
}

function attachViewerWebSocket(session, ws, opts = {}) {
  const user = opts.user || null;
  const sessionId = session.sessionId;
  let unwatch = null;

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

  // Stream structured transcript (clean content from Claude's JSONL)
  const transcriptPath = transcriptMod.resolveTranscriptPath(sessionId);
  if (!transcriptPath) {
    ws.send(JSON.stringify({ t: 'transcript-waiting' }));
    const pollInterval = setInterval(() => {
      if (ws.readyState !== ws.OPEN) { clearInterval(pollInterval); return; }
      const p = transcriptMod.resolveTranscriptPath(sessionId);
      if (p) { clearInterval(pollInterval); streamTranscript(p); }
    }, 2000);
    ws.on('close', () => { clearInterval(pollInterval); session.off('chat', onChat); if (unwatch) unwatch(); });
    ws.on('message', handleViewerInbound);
    return;
  }

  streamTranscript(transcriptPath);

  function streamTranscript(filePath) {
    transcriptMod.readNewMessages(filePath, 0).then(({ messages, bytesRead }) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ t: 'transcript-init', messages, bytes: bytesRead }));
      unwatch = transcriptMod.watchTranscript(filePath, (newMsgs) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ t: 'transcript-delta', messages: newMsgs }));
        }
      });
    }).catch(() => {});
  }

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
    if (unwatch) unwatch();
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
  const mycoMatch = text.match(/^@myco\s+(.+)/i);
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
      // Auto-mode: every chat-sent prompt should run without Claude
      // pausing for permission. Detect the current Claude Code mode from
      // the headless terminal's bottom rows and prepend the right number
      // of Shift+Tab presses so we land on "auto-accept edits" before
      // the actual text is sent. Claude Code cycles modes:
      //   default → accept-edits → plan → default
      const toggle = autoAcceptToggleBytes(session);
      console.log(`[chat→pty] ${user}: ${input.substring(0, 80)}${toggle ? ' (+auto-toggle)' : ''}`);
      session.write(toggle + input + '\r');
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
    if (/accept edits|auto-accept/.test(blob)) return 'accept';
    if (/plan mode/.test(blob)) return 'plan';
    return 'default';
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
};
