const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { listSessions, spawnSession, sessionBelongsToUser, workspaceName, listWorkspaceDirs, ensureLiveSession, deleteSession, importExistingTranscripts, loadStore } = require('./sessions');
const { attachWebSocket } = require('./pty');
const {
  AUTH_REQUIRED, userFromRequest, userFromToken,
  createShareToken, shareTokenInfo, revokeShareTokensForSession,
} = require('./auth');
const logCapture = require('./logCapture');
const { startSummaryWatcher } = require('./summarizer');

const app = express();
logCapture.init();
app.use(express.json());
app.use((req, res, next) => {
  const ua = (req.headers['user-agent'] || '').slice(0, 30);
  console.log(`${new Date().toISOString().slice(11, 19)} ${req.ip} ${req.method} ${req.url} [${ua}]`);
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  next();
});

function requireAuth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

app.use(express.static(path.join(__dirname, '../../web/public'), { etag: false, lastModified: false, maxAge: 0 }));

// Serve xterm assets from node_modules so we don't depend on a CDN
app.use('/vendor/xterm', express.static(path.join(__dirname, '../node_modules/@xterm/xterm/lib')));
app.use('/vendor/xterm-css', express.static(path.join(__dirname, '../node_modules/@xterm/xterm/css')));
app.use('/vendor/xterm-fit', express.static(path.join(__dirname, '../node_modules/@xterm/addon-fit/lib')));
app.use('/vendor/xterm-webgl', express.static(path.join(__dirname, '../node_modules/@xterm/addon-webgl/lib')));
app.use('/vendor/xterm-canvas', express.static(path.join(__dirname, '../node_modules/@xterm/addon-canvas/lib')));

app.get('/auth/check', (req, res) => {
  // Share-token viewers don't have a user; they get scoped read-only access
  // to one session. The frontend uses the returned sessionId to attach.
  const shareTok = (req.query && req.query.s) || '';
  if (shareTok) {
    const info = shareTokenInfo(shareTok);
    if (info) return res.json({ ok: true, share: true, sessionId: info.sessionId });
    return res.status(401).json({ ok: false });
  }
  const user = userFromRequest(req);
  res.json({ ok: !!user, required: AUTH_REQUIRED, user: user || null });
});

// Drop a .vscode/tasks.json into the session's cwd that auto-runs
// `myco attach <id>` in a terminal when VS Code opens the folder. Together
// with the vscode-remote URL the frontend builds, this gives a one-click
// "open folder + reattach to claude" experience (modulo the one-time VS Code
// prompts for workspace trust + "allow automatic tasks").
const MYCO_BIN = path.resolve(__dirname, '../../myco');
app.post('/sessions/:id/vscode-prep', requireAuth, (req, res) => {
  const id = req.params.id;
  if (AUTH_REQUIRED && !sessionBelongsToUser(id, req.user)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const rec = loadStore().sessions[id];
  if (!rec) return res.status(404).json({ error: 'unknown session' });
  if (!rec.absCwd || !fs.existsSync(rec.absCwd)) {
    return res.status(400).json({ error: 'session cwd missing' });
  }

  const dotVscode = path.join(rec.absCwd, '.vscode');
  const tasksPath = path.join(dotVscode, 'tasks.json');

  let doc = { version: '2.0.0', tasks: [] };
  try {
    if (fs.existsSync(tasksPath)) {
      const raw = fs.readFileSync(tasksPath, 'utf8');
      // Tolerate JSONC // comments by stripping them — tasks.json is JSONC.
      const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
      const parsed = JSON.parse(stripped);
      if (parsed && typeof parsed === 'object') {
        doc = parsed;
        if (!doc.version) doc.version = '2.0.0';
        if (!Array.isArray(doc.tasks)) doc.tasks = [];
      }
    }
  } catch (err) {
    return res.status(500).json({ error: `existing tasks.json is malformed: ${err.message}` });
  }

  const TASK_LABEL = 'myco: attach';
  const ourTask = {
    label: TASK_LABEL,
    type: 'shell',
    command: `${MYCO_BIN} attach ${id}`,
    presentation: {
      echo: false,
      reveal: 'always',
      focus: true,
      panel: 'shared',
      showReuseMessage: false,
      clear: false,
    },
    runOptions: { runOn: 'folderOpen' },
    problemMatcher: [],
  };
  const idx = doc.tasks.findIndex((t) => t && t.label === TASK_LABEL);
  if (idx >= 0) doc.tasks[idx] = ourTask;
  else doc.tasks.unshift(ourTask);

  try {
    fs.mkdirSync(dotVscode, { recursive: true });
    fs.writeFileSync(tasksPath, JSON.stringify(doc, null, 2) + '\n');
  } catch (err) {
    return res.status(500).json({ error: redact(err.message) });
  }

  res.json({ ok: true, path: tasksPath });
});

app.post('/sessions/:id/share', requireAuth, (req, res) => {
  const id = req.params.id;
  if (AUTH_REQUIRED && !sessionBelongsToUser(id, req.user)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { token, expiresAt } = createShareToken(id, req.user || 'default');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  res.json({
    url: `${proto}://${host}/?s=${encodeURIComponent(token)}`,
    expires_at: new Date(expiresAt).toISOString(),
  });
});

app.get('/sessions', requireAuth, async (req, res) => {
  try {
    res.json(await listSessions(AUTH_REQUIRED ? req.user : null));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function redact(msg) {
  // Remove absolute POSIX paths from any error message before sending it out.
  return String(msg || '').replace(/(\/[^\s'"<>]+)/g, '<path>');
}

app.post('/sessions', requireAuth, async (req, res) => {
  try {
    const { id, cwd } = await spawnSession(req.body.cwd, req.user, {
      cols: req.body.cols,
      rows: req.body.rows,
    });
    res.json({ session_id: id, cwd });
  } catch (err) {
    res.status(400).json({ error: redact(err.message) });
  }
});

app.get('/workspace', requireAuth, (req, res) => {
  res.json({
    name: workspaceName(req.user),
    entries: listWorkspaceDirs(req.user),
    user: req.user,
    // If set, frontend builds vscode-remote URLs to open folders over SSH;
    // otherwise it falls back to plain vscode://file URLs (local-only).
    vscode_host: process.env.MYCO_VSCODE_HOST || null,
  });
});

const TLS_CERT_PATH = process.env.TLS_CERT_PATH || '';
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || '';
const tlsEnabled = !!(TLS_CERT_PATH && TLS_KEY_PATH);

const server = tlsEnabled
  ? https.createServer({
      cert: fs.readFileSync(TLS_CERT_PATH),
      key: fs.readFileSync(TLS_KEY_PATH),
    }, app)
  : http.createServer(app);
const wss = new WebSocketServer({ noServer: true, clientTracking: false });

const PING_INTERVAL_MS = 30000;
const PING_TIMEOUT_MS = 10000;

function startPing(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const timer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) { clearInterval(timer); return; }
    if (!ws.isAlive) { ws.terminate(); clearInterval(timer); return; }
    ws.isAlive = false;
    ws.ping();
  }, PING_INTERVAL_MS);
  ws.on('close', () => clearInterval(timer));
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');

  // Log streaming WebSocket
  if (url.pathname === '/logs') {
    const tok = url.searchParams.get('token') || '';
    const user = AUTH_REQUIRED ? userFromToken(tok) : 'default';
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      startPing(ws);
      const unsub = logCapture.onLog((entry) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'log', ...entry }));
      });
      ws.on('close', unsub);
    });
    return;
  }

  const match = url.pathname.match(/^\/attach\/(.+)$/);
  if (!match) { socket.destroy(); return; }
  const sessionId = match[1];

  const shareTok = url.searchParams.get('s') || '';
  let readOnly = false;

  if (shareTok) {
    const info = shareTokenInfo(shareTok);
    if (!info || info.sessionId !== sessionId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    readOnly = true;
  } else {
    const tok = url.searchParams.get('token') || '';
    const user = AUTH_REQUIRED ? userFromToken(tok) : 'default';
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (AUTH_REQUIRED && !sessionBelongsToUser(sessionId, user)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  console.log(`[ws] upgrade request for session ${sessionId} readOnly=${readOnly}`);
  wss.handleUpgrade(req, socket, head, async (ws) => {
    startPing(ws);
    let session;
    try {
      session = await ensureLiveSession(sessionId);
    } catch (err) {
      console.error(`[ws] ensureLiveSession failed: ${err.message}`);
      try { ws.send(JSON.stringify({ t: 'error', message: err.message })); } catch {}
      ws.close();
      return;
    }
    attachWebSocket(session, ws, { readOnly });
  });
});

app.delete('/sessions/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  if (AUTH_REQUIRED && !sessionBelongsToUser(id, req.user)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  deleteSession(id);
  revokeShareTokensForSession(id);
  res.json({ ok: true });
});

app.get('/logs', requireAuth, (req, res) => {
  const n = Math.min(parseInt(req.query.count) || 100, 500);
  res.json(logCapture.getRecent(n));
});

const PORT = parseInt(process.env.PORT, 10) || (tlsEnabled ? 443 : 3000);
const HOST = process.env.HOST || (tlsEnabled ? '0.0.0.0' : '127.0.0.1');
const HTTP_REDIRECT_PORT = parseInt(process.env.HTTP_REDIRECT_PORT, 10) || (tlsEnabled ? 80 : 0);

server.listen(PORT, HOST, async () => {
  const proto = tlsEnabled ? 'https' : 'http';
  console.log(`mycod running at ${proto}://${HOST}:${PORT}`);
  try {
    const n = await importExistingTranscripts();
    if (n) console.log(`[migrate] imported ${n} existing transcript(s) as resumable sessions`);
  } catch (err) {
    console.error('[migrate] import failed:', err.message);
  }
  startSummaryWatcher();
});

if (tlsEnabled && HTTP_REDIRECT_PORT) {
  http.createServer((req, res) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    res.writeHead(301, { Location: `https://${host}${req.url}` });
    res.end();
  }).listen(HTTP_REDIRECT_PORT, HOST, () => {
    console.log(`http→https redirect on ${HOST}:${HTTP_REDIRECT_PORT}`);
  });
}
