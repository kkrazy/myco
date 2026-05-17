const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const sessionsMod = require('./sessions');
const { listSessions, spawnSession, sessionBelongsToUser, workspaceName, listWorkspaceDirs, ensureLiveSession, deleteSession, importExistingTranscripts, loadStore, saveStore, getSessionRecord, readDescriptionForCwd: readDescriptionForCwdPublic, resolveCwd, getFileChat, getRecentFileChatMessages, appendFileChatMessage, deleteFileChatMessage } = sessionsMod;
const filesApi = require('./files');
const { askAboutFile, ASSISTANT_USER } = require('./btw');
const githubMod = require('./github');
const slashcmds = require('./slashcmds');
const oauth = require('./oauth');
const crypto = require('crypto');
// SDK Phase 9 step 2: PTY driver is gone. attach.js is the agent-only
// WS attach + chat plumbing layer.
const { attachWebSocket, attachViewerWebSocket, getSession: getPtySession, handleChatMessage } = require('./attach');
const artifactsRoutes = require('./artifacts');
const {
  isAuthRequired, userFromRequest, userFromToken,
  profileFromToken, listUsernames,
  mintSession, revokeSession, loadAllowlist, isAllowed,
  createShareToken, shareTokenInfo, revokeShareTokensForSession,
} = require('./auth');
const logCapture = require('./logCapture');
const { startSummaryWatcher } = require('./summarizer');

const app = express();
logCapture.init();
// 4 MiB ceiling so the file-explorer PUT can carry typical source files.
// (Default is 100 KiB which would reject anything moderately sized.)
app.use(express.json({ limit: '4mb' }));
app.use((req, res, next) => {
  const ua = (req.headers['user-agent'] || '').slice(0, 30);
  console.log(`${new Date().toISOString().slice(11, 19)} ${req.ip} ${req.method} ${req.url} [${ua}]`);
  // Cache static assets aggressively. /vendor and /fonts are content-stable;
  // own files (app.js / styles.css) ride a ?v=<n> cache buster
  // so a long max-age is safe — bumping the buster forces a refetch.
  // Everything else (HTML index, /sessions, /auth, /workspace, …) stays
  // no-store so polled state and the bootstrap doc are always fresh.
  const url = req.url;
  const longCache =
    url.startsWith('/vendor/') ||
    url.startsWith('/fonts/') ||
    // `?v=<anything>` — the indexHtml() injector replaces hard-coded
    // `?v=NNN` with build-stamp-based query strings (ISO timestamps
    // contain non-digit chars like ':' and 'T'), so a `\d+`-only match
    // would miss the auto-busted URLs and serve them no-store. Match
    // any non-empty `?v=...` value.
    /\?v=[^&]/.test(url);
  if (longCache) {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
  }
  next();
});

function requireAuth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

// Serve index.html with build-stamp cache-busters injected — `app.js?v=N`
// and `styles.css?v=N` become `?v=<build-stamp>`. The static
// `?v=<n>` literal in the file is a fallback that only matters when
// build.txt is absent (dev runs outside docker). With this dynamic
// rewrite, every deploy automatically invalidates browser caches for
// every client asset without anyone having to remember to bump the
// hard-coded version number. Bug history: an app.js change shipped to
// production with the hard-coded ?v=164 left in place, so every
// returning browser kept the cached old bundle and silently broke the
// multi-select picker (didn't know about menu.multi → rendered toggles
// as plain picks → first click disabled the whole row).
const PUBLIC_DIR = path.join(__dirname, '../../web/public');
let _cachedBuildStamp = null;
function buildStamp() {
  if (_cachedBuildStamp !== null) return _cachedBuildStamp;
  try {
    _cachedBuildStamp = fs.readFileSync(path.join(PUBLIC_DIR, 'build.txt'), 'utf8').trim();
  } catch {
    // No build.txt — dev mode. Use process start time so each restart
    // still busts the cache for in-progress development.
    _cachedBuildStamp = 'dev-' + Date.now();
  }
  return _cachedBuildStamp;
}
let _cachedIndexHtml = null;
function indexHtml() {
  if (_cachedIndexHtml !== null) return _cachedIndexHtml;
  const raw = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const stamp = encodeURIComponent(buildStamp());
  _cachedIndexHtml = raw
    .replace(/app\.js\?v=[^"'\s]+/g, `app.js?v=${stamp}`)
    .replace(/styles\.css\?v=[^"'\s]+/g, `styles.css?v=${stamp}`);
  return _cachedIndexHtml;
}
app.get(['/', '/index.html'], (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(indexHtml());
});

app.use(express.static(PUBLIC_DIR, { etag: false, lastModified: false, maxAge: 0 }));

// SDK Phase 9 step 2: xterm.js and its addons (fit/webgl/canvas) are
// no longer served — the client no longer paints a terminal. ~1.5MB
// off every cold-cache page load.
app.use('/vendor/marked', express.static(path.join(__dirname, '../node_modules/marked/lib')));
app.use('/vendor/highlight.js', express.static(path.join(__dirname, '../node_modules/highlight.js/lib')));
app.use('/vendor/highlight.js-css', express.static(path.join(__dirname, '../node_modules/highlight.js/styles')));

app.get('/auth/check', (req, res) => {
  // Share-token viewers don't have a user; they get scoped access
  // to one session. The frontend uses the returned sessionId to attach.
  const shareTok = (req.query && req.query.s) || '';
  if (shareTok) {
    const info = shareTokenInfo(shareTok);
    if (info) {
      const rec = getSessionRecord(info.sessionId);
      return res.json({
        ok: true, share: true,
        sessionId: info.sessionId,
        cwd: rec?.cwd || null,
        abs_cwd: rec?.absCwd || null,
      });
    }
    return res.status(401).json({ ok: false });
  }
  const auth = req.headers.authorization || '';
  const headerTok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const queryTok = (req.query && req.query.token) || '';
  const profile = profileFromToken(headerTok || queryTok);
  if (profile) {
    return res.json({
      ok: true, required: isAuthRequired(),
      user: profile.login,
      name: profile.name || null,
      avatar_url: profile.avatarUrl || null,
    });
  }
  res.json({ ok: false, required: isAuthRequired(), login: 'github', user: null });
});

// ─── GitHub OAuth login ─────────────────────────────────────────────────────
//
// Three routes back the GitHub-SSO login: /auth/github/start kicks the user
// off to GitHub, /auth/github/callback exchanges the auth code and (if the
// resulting login is on the allowlist) mints a myco session token, and
// /auth/logout revokes the current session.
//
// State nonces are kept in-memory; a server restart invalidates any
// in-flight login (which has to be retried). 5-minute TTL.

const PENDING_STATES = new Map(); // nonce -> { createdAt }
const STATE_TTL_MS = 5 * 60 * 1000;

function _gcStates() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [nonce, s] of PENDING_STATES) {
    if (s.createdAt < cutoff) PENDING_STATES.delete(nonce);
  }
}

app.get('/auth/github/start', (req, res) => {
  if (!oauth.isConfigured()) {
    return res.status(500).type('text/plain').send(
      'GitHub OAuth is not configured on this server. Set MYCO_GH_CLIENT_ID, ' +
      'MYCO_GH_CLIENT_SECRET, and MYCO_PUBLIC_ORIGIN in $MYCO_STATE_DIR/.env.'
    );
  }
  _gcStates();
  const nonce = crypto.randomBytes(32).toString('hex');
  PENDING_STATES.set(nonce, { createdAt: Date.now() });
  res.redirect(302, oauth.startUrl(nonce));
});

function _renderHtml(res, status, bodyHtml) {
  res.status(status).type('text/html').send(
    `<!doctype html><meta charset="utf-8"><title>myco</title>` +
    `<style>body{font:14px -apple-system,system-ui,sans-serif;background:#0d0d0d;` +
    `color:#ccc;margin:0;display:flex;align-items:center;justify-content:center;` +
    `min-height:100vh;padding:24px;text-align:center}` +
    `.card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:32px;` +
    `max-width:480px}h1{color:#7fb3ff;font-size:18px;margin:0 0 12px}` +
    `code{background:#222;padding:2px 6px;border-radius:4px;font-size:13px}` +
    `a{color:#8ab8ff}</style><div class=card>${bodyHtml}</div>`
  );
}

app.get('/auth/github/callback', async (req, res) => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  if (!code || !state) {
    return _renderHtml(res, 400, `<h1>Login failed</h1><p>Missing OAuth code/state. <a href="/">Back</a></p>`);
  }
  _gcStates();
  if (!PENDING_STATES.delete(state)) {
    return _renderHtml(res, 400, `<h1>Login failed</h1><p>OAuth state expired or invalid. <a href="/auth/github/start">Try again</a></p>`);
  }
  let tokens, user;
  try {
    tokens = await oauth.exchangeCode(code);
    user = await oauth.fetchUser(tokens.access_token);
  } catch (err) {
    console.error('[oauth] callback error:', err.message);
    return _renderHtml(res, 502, `<h1>Login failed</h1><p>GitHub said: ${escHtmlServer(err.message)}. <a href="/auth/github/start">Try again</a></p>`);
  }
  const login = require('./auth').sanitize(user.login || '');
  if (!login) {
    return _renderHtml(res, 400, `<h1>Login failed</h1><p>GitHub returned no login.</p>`);
  }
  if (!isAllowed(login)) {
    return _renderHtml(res, 403,
      `<h1>Not invited yet</h1>` +
      `<p>Hi <code>${escHtmlServer(login)}</code> — your GitHub login isn't on the allowlist.</p>` +
      `<p>Ask the admin to run:<br><code>./deploy.sh --allow-github-user ${escHtmlServer(login)}</code></p>`
    );
  }

  // Stash the OAuth access token for git/issue operations later.
  try { githubMod.setToken(login, tokens.access_token); }
  catch (err) { console.error('[oauth] stash token failed:', err.message); }

  const mycoTok = mintSession(login, {
    githubId: user.id || null,
    name: user.name || null,
    avatarUrl: user.avatar_url || null,
  });

  // Bridge: hand the new session token to the SPA via localStorage and bounce
  // to the root. Avoids needing cookies, which would require a broader rewrite
  // of authedFetch / WS ?token= handling.
  const tokJson = JSON.stringify(mycoTok);
  res.type('text/html').send(
    `<!doctype html><meta charset="utf-8"><title>Signing in…</title>` +
    `<script>try{localStorage.setItem('myco_token', ${tokJson});}catch(e){}` +
    `location.replace('/');</script>` +
    `<noscript>Login complete — JavaScript is required to continue. ` +
    `<a href="/">Open myco</a></noscript>`
  );
});

app.post('/auth/logout', (req, res) => {
  const auth = req.headers.authorization || '';
  const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const removed = revokeSession(tok);
  res.json({ ok: true, removed });
});

// PAT login: a friendlier alternative to the OAuth round-trip. The user
// pastes a GitHub Personal Access Token; we validate it by hitting
// api.github.com/user, check the resulting login against the allowlist, and
// mint a myco session — same end state as the OAuth callback path. The PAT
// itself is also stashed for /feature/bug, so a single token does double duty.
app.post('/auth/login', async (req, res) => {
  const pat = String((req.body && req.body.token) || '').trim();
  if (!pat) return res.status(400).json({ error: 'token required' });
  // Minimum sanity: real GitHub PATs are 40+ chars (classic) or 90+ chars
  // (fine-grained). Test-bypass tokens are short ("test-token-alice"); we
  // accept those too because oauth.fetchUser honors the bypass env var.
  if (pat.length < 8) return res.status(400).json({ error: 'token looks too short' });

  let user;
  try { user = await oauth.fetchUser(pat); }
  catch (err) {
    return res.status(401).json({ error: `github rejected the token: ${err.message}` });
  }
  const login = require('./auth').sanitize(user.login || '');
  if (!login) return res.status(401).json({ error: 'github returned no login' });
  if (!isAllowed(login)) {
    return res.status(403).json({
      error: `not invited`,
      login,
      hint: `Ask an admin to run: ./deploy.sh --allow-github-user ${login}`,
    });
  }

  try { githubMod.setToken(login, pat); }
  catch (err) { console.error('[login] stash token failed:', err.message); }

  const mycoTok = mintSession(login, {
    githubId: user.id || null,
    name: user.name || null,
    avatarUrl: user.avatar_url || null,
  });
  res.json({ ok: true, token: mycoTok, user: { login, name: user.name || null, avatarUrl: user.avatar_url || null } });
});

function escHtmlServer(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Drop a .vscode/tasks.json into the session's cwd that auto-runs
// `myco attach <id>` in a terminal when VS Code opens the folder. Together
// with the vscode-remote URL the frontend builds, this gives a one-click
// "open folder + reattach to claude" experience (modulo the one-time VS Code
// prompts for workspace trust + "allow automatic tasks").
const MYCO_BIN = path.resolve(__dirname, '../../myco');
app.post('/sessions/:id/vscode-prep', requireAuth, (req, res) => {
  const id = req.params.id;
  if (isAuthRequired() && !sessionBelongsToUser(id, req.user)) {
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
  if (isAuthRequired() && !sessionBelongsToUser(id, req.user)) {
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

app.get('/sessions', async (req, res) => {
  const user = userFromRequest(req);
  // Allow unauthenticated access if share tokens are provided
  if (!user && !req.query.share) return res.status(401).json({ error: 'unauthorized' });
  try {
    const all = req.query.all === '1';
    let own = [];
    if (user) {
      own = await listSessions(all ? null : (isAuthRequired() ? user : null));
      // Tag owned/owner so the client can label non-owned sessions and
      // open them in viewer (read-only) mode without a share token.
      for (const s of own) {
        if (!isAuthRequired()) { s.owned = true; continue; }
        const rec = getSessionRecord(s.id);
        s.owned = !!(rec && rec.user === user);
        if (!s.owned && rec) s.owner = rec.user || null;
      }
    }
    // Also include sessions the user has accessed via share tokens.
    const shareToks = req.query.share || [];
    const shares = Array.isArray(shareToks) ? shareToks : [shareToks];
    const sharedSessions = [];
    for (const tok of shares) {
      const info = shareTokenInfo(tok);
      if (!info) continue;
      const rec = getSessionRecord(info.sessionId);
      if (!rec) continue;
      const meta = await readDescriptionForCwdPublic(rec.absCwd, rec);
      sharedSessions.push({
        id: rec.id,
        cwd: rec.cwd,
        abs_cwd: rec.absCwd,
        description: meta?.description || null,
        summary: meta?.summary || null,
        status: meta?.status || 'idle',
        last_activity: meta?.lastActivity || null,
        created_at: rec.createdAt,
        shared: true,
        shareToken: tok,
        owner: rec.user || null,
      });
    }
    res.json([...own, ...sharedSessions]);
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
    const { id, cwd, mode } = await spawnSession(req.body.cwd, req.user, {
      cols: req.body.cols,
      rows: req.body.rows,
      // Opt into the SDK-driven driver (agent-sdk-research branch phase 1+).
      // Default unset → 'pty'. Pass {"mode":"agent"} in the POST body to spawn
      // an SDK session. PTY sessions remain the default until phase 8 flips it.
      mode: req.body.mode === 'agent' ? 'agent' : undefined,
    });
    res.json({ session_id: id, cwd, mode });
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
    const user = isAuthRequired() ? userFromToken(tok) : 'default';
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
  let user = null;

  if (shareTok) {
    const info = shareTokenInfo(shareTok);
    if (!info || info.sessionId !== sessionId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    readOnly = true;
    // Prefer the viewer's own auth identity if they provided a token.
    const viewerTok = url.searchParams.get('token') || '';
    const viewerUser = viewerTok ? userFromToken(viewerTok) : null;
    if (viewerUser) {
      user = viewerUser;
    } else {
      // Anonymous viewer: use ?name= if provided, else a generic label.
      const name = (url.searchParams.get('name') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
      user = name || 'share';
    }
  } else {
    const tok = url.searchParams.get('token') || '';
    user = isAuthRequired() ? userFromToken(tok) : 'default';
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (isAuthRequired() && !sessionBelongsToUser(sessionId, user)) {
      // Non-owner authenticated user → viewer (readOnly)
      readOnly = true;
    }
  }

  console.log(`[ws] upgrade request for session ${sessionId} readOnly=${readOnly} user=${user || '-'}`);
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
    if (readOnly) {
      // Read-only viewers see the structured transcript (clean, scrollable
      // history of user/assistant/tool messages) + a docked live terminal-
      // tail panel that surfaces interactive prompts and intermediate state
      // that never make it into the transcript JSONL.
      attachViewerWebSocket(session, ws, { user });
    } else {
      attachWebSocket(session, ws, { readOnly, user });
    }
  });
});

app.delete('/sessions/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  if (isAuthRequired() && !sessionBelongsToUser(id, req.user)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  deleteSession(id);
  revokeShareTokensForSession(id);
  res.json({ ok: true });
});

// ─── per-session file explorer API ──────────────────────────────────────────
//
// All file-API endpoints — reads, writes, and Claude-backed file-chat ops —
// accept anyone with access to the session: the owner, any authenticated
// non-owner (multi-user installs), or a valid ?s=<shareToken> client.
// Collaborators can both read and annotate code together, including running
// Explain / Find bugs / Add comment from the inline action bar. The session
// owner controls the share scope by issuing/revoking the share link.
//
// Root is recomputed per request via resolveCwd(rec.cwd, rec.user) so a
// stale rec.absCwd from a workspace move can't leak FS access.
function fileApiPreamble(req, res, requiredAccess /* 'owner' | 'viewer' */) {
  const id = req.params.id;
  const rec = getSessionRecord(id);
  if (!rec) { res.status(404).json({ error: 'unknown session' }); return null; }

  // Compute access level. requireAuth middleware (used on owner-only
  // routes) sets req.user; for viewer routes we resolve here.
  if (!req.user) req.user = userFromRequest(req);
  let access = null;
  if (!isAuthRequired()) {
    access = 'owner';                                    // single-user mode
  } else if (req.user) {
    access = (rec.user === req.user) ? 'owner' : 'viewer';
  } else {
    const shareTok = (req.query && req.query.s) || '';
    if (shareTok) {
      const info = shareTokenInfo(shareTok);
      if (info && info.sessionId === id) access = 'viewer';
    }
  }
  if (!access) { res.status(401).json({ error: 'unauthorized' }); return null; }
  if (requiredAccess === 'owner' && access !== 'owner') {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }

  let root;
  try { root = resolveCwd(rec.cwd, rec.user); }
  catch { res.status(500).json({ error: 'stale session record' }); return null; }
  return { id, rec, root, access };
}

function fileApiError(res, e) {
  const code = e && e.code;
  if (code === 'ERR_OUTSIDE' || code === 'ERR_PERM') return res.status(403).json({ error: e.message, code });
  if (code === 'ERR_NOT_FOUND') return res.status(404).json({ error: e.message, code });
  if (code === 'ERR_NOT_DIR') return res.status(400).json({ error: e.message, code });
  if (code === 'ERR_BINARY') return res.status(415).json({ error: e.message, code, binary: true, size: e.size, mtimeMs: e.mtime });
  if (code === 'ERR_TOO_LARGE') return res.status(413).json({ error: e.message, code, size: e.size, mtimeMs: e.mtime });
  if (code === 'ERR_MTIME_CONFLICT') return res.status(409).json({ error: e.message, code });
  if (code === 'ERR_SYMLINK_WRITE') return res.status(400).json({ error: e.message, code });
  if (code === 'ERR_BAD_INPUT') return res.status(400).json({ error: e.message, code });
  console.error('[files] unexpected error:', e);
  return res.status(500).json({ error: 'internal error' });
}

app.get('/sessions/:id/files', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  try {
    const out = await filesApi.listDir(ctx.root, req.query.path || '.');
    res.json(out);
  } catch (e) { fileApiError(res, e); }
});

app.get('/sessions/:id/file', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  if (!req.query.path) return res.status(400).json({ error: 'path required' });
  try {
    const out = await filesApi.readFile(ctx.root, req.query.path);
    res.json(out);
  } catch (e) { fileApiError(res, e); }
});

app.put('/sessions/:id/file', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  const { path: relPath, content, expectedMtimeMs } = req.body || {};
  if (!relPath) return res.status(400).json({ error: 'path required' });
  try {
    const out = await filesApi.writeFile(ctx.root, relPath, { content, expectedMtimeMs });
    res.json(out);
  } catch (e) { fileApiError(res, e); }
});

// Owner-only full-file edit (the in-page editor in the files
// viewer). Separate from PUT /file (which the comment-insert flow
// uses with viewer access) so guests can still annotate without
// being able to rewrite the whole file. Same filesApi.writeFile
// underneath — only the auth role differs.
app.post('/sessions/:id/file/edit', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'owner');
  if (!ctx) return;
  const { path: relPath, content, expectedMtimeMs } = req.body || {};
  if (!relPath) return res.status(400).json({ error: 'path required' });
  if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
  try {
    const out = await filesApi.writeFile(ctx.root, relPath, { content, expectedMtimeMs });
    res.json(out);
  } catch (e) { fileApiError(res, e); }
});

// ─── per-file Claude thread (file-viewer) ───────────────────────────────────
//
// Owner-only, same containment + auth model as the file API. Threads are
// per (sessionId, relPath) and persisted in the session store.

function validateFileChatPath(ctx, relPath, res) {
  if (!relPath) { res.status(400).json({ error: 'path required' }); return false; }
  // Reject anything that would escape the session root. We don't need the
  // resolved path for GET/DELETE; safeJoin throws ERR_OUTSIDE on traversal.
  return filesApi.safeJoin(ctx.root, relPath)
    .then(() => true)
    .catch((e) => { fileApiError(res, e); return false; });
}

app.get('/sessions/:id/file-chat', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  const relPath = req.query.path;
  if (!(await validateFileChatPath(ctx, relPath, res))) return;
  res.json({ messages: getFileChat(ctx.id, relPath) });
});

app.post('/sessions/:id/file-chat', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  const { path: relPath, anchor, question } = req.body || {};
  if (!relPath) return res.status(400).json({ error: 'path required' });
  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'question required' });
  }
  // Validate anchor shape if present.
  let normAnchor = null;
  if (anchor && typeof anchor === 'object') {
    const s = parseInt(anchor.startLine, 10);
    const e = parseInt(anchor.endLine, 10);
    if (Number.isFinite(s) && Number.isFinite(e) && s >= 1 && e >= s) {
      normAnchor = { startLine: s, endLine: e };
    }
  }
  // Read the file. If the file is too large or binary, we send the question
  // anyway with a stand-in (askAboutFile handles truncation).
  let fileContent = '';
  try {
    const out = await filesApi.readFile(ctx.root, relPath);
    fileContent = out.content;
  } catch (e) {
    if (e.code === 'ERR_BINARY') {
      fileContent = '(binary file — content not available)';
    } else if (e.code === 'ERR_TOO_LARGE') {
      // Read raw via fs and let askAboutFile truncate it inside the prompt.
      try {
        const fs = require('fs/promises');
        const path = require('path');
        const abs = path.resolve(ctx.root, relPath);
        // safeJoin already validated containment via validateFileChatPath above.
        fileContent = await fs.readFile(abs, 'utf8');
      } catch (e2) {
        return fileApiError(res, e2);
      }
    } else {
      return fileApiError(res, e);
    }
  }
  // Append the user message immediately (optimistic; client also shows it).
  const userMsg = {
    id: crypto.randomBytes(6).toString('hex'),
    user: 'you',
    text: question.trim(),
    ts: new Date().toISOString(),
    anchor: normAnchor,
  };
  appendFileChatMessage(ctx.id, relPath, userMsg);

  // Build prior history (most recent ~10, excluding the message we just added).
  const history = getRecentFileChatMessages(ctx.id, relPath, 11).slice(0, -1);

  let reply;
  try {
    reply = await askAboutFile({
      cwd: ctx.root,
      filePath: relPath,
      fileContent,
      anchor: normAnchor,
      history,
      question: question.trim(),
    });
  } catch (err) {
    reply = `(claude error: ${err && err.message ? err.message : 'unknown'})`;
  }
  const claudeMsg = {
    id: crypto.randomBytes(6).toString('hex'),
    user: ASSISTANT_USER,
    text: reply,
    ts: new Date().toISOString(),
    anchor: normAnchor,
  };
  appendFileChatMessage(ctx.id, relPath, claudeMsg);
  res.json({ message: claudeMsg, userMessage: userMsg });
});

app.delete('/sessions/:id/file-chat', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  const relPath = req.query.path;
  const messageId = req.query.messageId;
  if (!(await validateFileChatPath(ctx, relPath, res))) return;
  if (!messageId) return res.status(400).json({ error: 'messageId required' });
  const removed = deleteFileChatMessage(ctx.id, relPath, messageId);
  if (!removed) return res.status(404).json({ error: 'message not found' });
  res.json({ ok: true });
});

// bug-9: paginated chat-history window. The initial chat-history WS
// frame on attach is capped at sessions.DEFAULT_CHAT_HISTORY_LIMIT
// (100) to keep the chat pane snappy on long sessions. Older messages
// are fetched on demand by the client's "load older" button:
//
//   GET /sessions/:id/chat/history?before=<isoTs>&limit=<n>&includeAgent=1
//
//     before        — return messages with ts strictly less than this.
//                     The client passes the oldest currently-rendered
//                     row's ts to fetch the preceding window. Required
//                     so the same messages don't ride down twice.
//     limit         — max messages to return; default DEFAULT_CHAT_HISTORY
//                     _LIMIT, clamped to 1..500 (the on-disk cap).
//     includeAgent  — "1"/"true" to include fromAgent/fromTranscript
//                     mirrored rows (persisted claude-text history).
//                     Default OFF so the initial wire frame doesn't
//                     duplicate-render against agent-replay cards; ON
//                     for the load-older paginator so claude's older
//                     replies surface as bubbles when the user scrolls
//                     past the in-memory agent-replay byte window
//                     (events.jsonl / session.buffer only retain a
//                     bounded tail, but rec.chat is durable up to
//                     MAX_CHAT_MESSAGES).
//
// Response: { messages, total, hasMore }
//   messages — oldest→newest within the window (matches the WS frame
//              contract).
//   total    — total visible rows (with same filter the window uses);
//              client uses it to render a "showing N of M" hint.
//   hasMore  — true iff there are still older messages before the
//              returned window. Lets the client gray out the load-
//              older button when it's pulled everything.
app.get('/sessions/:id/chat/history', (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  const before = typeof req.query.before === 'string' ? req.query.before : null;
  let limit = parseInt(String(req.query.limit || ''), 10);
  if (!Number.isFinite(limit) || limit < 1) limit = sessionsMod.DEFAULT_CHAT_HISTORY_LIMIT;
  if (limit > 500) limit = 500;
  const includeAgent = req.query.includeAgent === '1' || req.query.includeAgent === 'true';
  const opts = { before, limit, includeAgent };
  const window = sessionsMod.getChatHistory(ctx.id, opts);
  const total = sessionsMod.getChatHistoryLength(ctx.id, { includeAgent });
  // hasMore = there's a message older than the window's oldest row.
  let hasMore = false;
  if (window.length) {
    const oldestTs = window[0] && window[0].ts;
    if (oldestTs) {
      const earlier = sessionsMod.getChatHistory(ctx.id, { before: oldestTs, limit: 1, includeAgent });
      hasMore = earlier.length > 0;
    }
  }
  res.json({ messages: window, total, hasMore });
});

// Plan / Arch / Test artifact routes — see server/src/artifacts.js for the
// route bodies. They need fileApiPreamble (defined above) plus the
// chat-dispatch hooks; passing them in keeps artifacts.js decoupled from
// auth/PTY plumbing.
artifactsRoutes.register(app, { fileApiPreamble, getPtySession, handleChatMessage });

// ─── autocomplete data ──────────────────────────────────────────────────────
// /commands and /users back the chat-input dropdown. /users sources the
// `@`-mention list from session-active users plus everyone on the allowlist
// (so admins-listed-but-not-yet-logged-in users still appear).

app.get('/commands', (req, res) => {
  res.json({ commands: slashcmds.listCommands() });
});

app.get('/users', requireAuth, (req, res) => {
  const merged = new Set(listUsernames());
  for (const login of loadAllowlist()) merged.add(login);
  res.json({ users: Array.from(merged).sort() });
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
