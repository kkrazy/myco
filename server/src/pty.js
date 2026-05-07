const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const { EventEmitter } = require('events');

const MAX_BUFFER = 1024 * 1024;

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

    this.pty.onData((data) => {
      this._push(data);
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
    try { this.pty.resize(cols, rows); this.cols = cols; this.rows = rows; } catch {}
  }

  kill() {
    if (this.alive) {
      try { this.pty.kill(); } catch {}
      this.alive = false;
    }
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
  // Replay ring buffer first so reconnects see prior context.
  const replay = Buffer.concat(session.buffer.map((d) => Buffer.from(d, 'utf8')));
  if (replay.length) {
    ws.send(JSON.stringify({ t: 'output', data: replay.toString('base64') }));
  }

  const onData = (data) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ t: 'output', data: Buffer.from(data, 'utf8').toString('base64') }));
  };
  const onExit = (code) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ t: 'exit', code }));
  };
  session.on('data', onData);
  session.on('exit', onExit);

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
  });
}

module.exports = {
  spawnClaude,
  getSession,
  killSession,
  attachWebSocket,
};
