const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const { listSessions, spawnSession, sessionBelongsToUser, workspaceName, listWorkspaceDirs, ensureLiveSession, deleteSession, importExistingTranscripts } = require('./sessions');
const { attachWebSocket } = require('./pty');
const { AUTH_REQUIRED, userFromRequest, userFromToken } = require('./auth');

const app = express();
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

app.get('/auth/check', (req, res) => {
  const user = userFromRequest(req);
  res.json({ ok: !!user, required: AUTH_REQUIRED, user: user || null });
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
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const match = url.pathname.match(/^\/attach\/(.+)$/);
  if (!match) { socket.destroy(); return; }

  const tok = url.searchParams.get('token') || '';
  const user = AUTH_REQUIRED ? userFromToken(tok) : 'default';
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const sessionId = match[1];
  if (AUTH_REQUIRED && !sessionBelongsToUser(sessionId, user)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    let session;
    try {
      session = ensureLiveSession(sessionId);
    } catch (err) {
      try { ws.send(JSON.stringify({ t: 'error', message: err.message })); } catch {}
      ws.close();
      return;
    }
    attachWebSocket(session, ws);
  });
});

app.delete('/sessions/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  if (AUTH_REQUIRED && !sessionBelongsToUser(id, req.user)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  deleteSession(id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`mycod running at http://localhost:${PORT}`);
  try {
    const n = await importExistingTranscripts();
    if (n) console.log(`[migrate] imported ${n} existing transcript(s) as resumable sessions`);
  } catch (err) {
    console.error('[migrate] import failed:', err.message);
  }
});
