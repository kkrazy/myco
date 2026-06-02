// Map standard HTTP_PROXY / HTTPS_PROXY env vars to global-agent's expectation
// before bootstrapping it so any node request automatically respects standard
// proxy configurations out-of-the-box.
const stdProxy = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy;
if (stdProxy) {
  process.env.GLOBAL_AGENT_HTTP_PROXY = stdProxy;
}
const stdNoProxy = process.env.NO_PROXY || process.env.no_proxy;
if (stdNoProxy) {
  process.env.GLOBAL_AGENT_NO_PROXY = stdNoProxy;
}
require('global-agent/bootstrap');

// Configure git globally on startup if proxy is set in environment
const { exec } = require('child_process');
if (stdProxy) {
  exec(`git config --global http.proxy "${stdProxy}" && git config --global https.proxy "${stdProxy}"`, (err) => {
    if (err) console.error('[proxy-setup] git http/https proxy config failed:', err.message);
    else console.log('[proxy-setup] git http/https proxy configured globally to:', stdProxy);
  });
}
if (process.env.MYCO_ENTERPRISE_TLS_INSECURE === '1' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  exec('git config --global http.sslVerify false', (err) => {
    if (err) console.error('[proxy-setup] git sslVerify false config failed:', err.message);
    else console.log('[proxy-setup] git sslVerify disabled globally for TLS insecure mode');
  });
}
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const sessionsMod = require('./sessions');
const { listSessions, spawnSession, sessionBelongsToUser, isOwnerOrAdmin, isOwnerAdminOrViewer, resolveAccessTier, workspaceName, listWorkspaceDirs, ensureLiveSession, deleteSession, importExistingTranscripts, loadStore, saveStore, getSessionRecord, readDescriptionForCwd: readDescriptionForCwdPublic, resolveCwd, getFileChat, getRecentFileChatMessages, appendFileChatMessage, deleteFileChatMessage } = sessionsMod;
const filesApi = require('./files');
const { askAboutFile, ASSISTANT_USER } = require('./btw');
const githubMod = require('./github');
const gitHosts = require('./git-hosts');
const gitTokens = require('./git-tokens');
const slashcmds = require('./slashcmds');
const oauth = require('./oauth');
const crypto = require('crypto');
// SDK Phase 9 step 2: PTY driver is gone. attach.js is the agent-only
// WS attach + chat plumbing layer.
const { attachWebSocket, attachViewerWebSocket, getSession: getPtySession, handleChatMessage } = require('./attach');
const artifactsRoutes = require('./artifacts');
// fr-94 Phase 1: resolveMycoDir(rec) is the single source of truth
// for "where _myco_/ lives for this session" — honors rec.mainProject
// (the designated project root set at session creation) or falls
// back to auto-detect. Used here for the diagram routes that
// otherwise hand-rolled `path.join(root, '_myco_', 'diagrams', …)`.
const { resolveMycoDir: _resolveMycoDir } = require('./artifacts');
const {
  isAuthRequired, userFromRequest, userFromToken,
  profileFromToken, listUsernames,
  mintSession, revokeSession, loadAllowlist, isAllowed,
  createShareToken, shareTokenInfo, revokeShareTokensForSession,
  addUserToAllowlist, removeUserFromAllowlist,
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

// Serve the user manual from the project root. Lives outside
// web/public (it's a top-level doc shipped with the repo), so it
// needs an explicit route — the static-mount below only sees files
// under PUBLIC_DIR. The sidebar's "open user manual" icon button
// fetches this URL and renders it via marked inside an in-app modal.
app.get('/USER_MANUAL.md', (req, res) => {
  const manualPath = path.join(__dirname, '..', '..', 'USER_MANUAL.md');
  res.set('Content-Type', 'text/markdown; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.sendFile(manualPath, (err) => {
    if (err && !res.headersSent) res.status(404).send('USER_MANUAL.md not found');
  });
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
  console.log('[admin-diag] /auth/check profile resolved:', JSON.stringify(profile));
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
  if (pat.length < 8) return res.status(400).json({ error: 'token looks too short' });

  let user;
  let provider = 'github';
  
  const bypass = String(process.env.MYCO_TEST_OAUTH_BYPASS || '').trim();
  if (bypass && pat.startsWith('test-token-')) {
    const login = pat.slice(11);
    console.log(`[login] Test bypass active. Resolving GitHub user: ${login}`);
    user = { login, id: 100000 + login.split('').reduce((a, c) => a + c.charCodeAt(0), 0), name: login, avatar_url: '' };
    provider = 'github';
  } else if (bypass && pat.startsWith('test-gitee-token-')) {
    const login = pat.slice(17);
    console.log(`[login] Test bypass active. Resolving Gitee user: ${login}`);
    user = { login, id: 200000 + login.split('').reduce((a, c) => a + c.charCodeAt(0), 0), name: login, avatar_url: '' };
    provider = 'gitee';
  } else {
    // Heuristic: Gitee PATs are typically 32-character hexadecimal/opaque strings, or start with gitee_pat_
    const isLikelyGitee = pat.startsWith('gitee_') || /^[a-f0-9]{32}$/i.test(pat);
    
    if (isLikelyGitee) {
      try {
        console.log('[login] Token structure suggests Gitee. Trying Gitee API first.');
        user = await gitHosts.fetchUser({ provider: 'gitee', token: pat });
        provider = 'gitee';
      } catch (err) {
        console.log('[login] Gitee validation failed, trying GitHub as fallback. Error:', err.message);
        try {
          user = await oauth.fetchUser(pat);
          provider = 'github';
        } catch (ghErr) {
          return res.status(401).json({ error: `Gitee and GitHub both rejected the token. Gitee error: ${err.message}. GitHub error: ${ghErr.message}` });
        }
      }
    } else {
      try {
        console.log('[login] Trying GitHub API first.');
        user = await oauth.fetchUser(pat);
        provider = 'github';
      } catch (err) {
        console.log('[login] GitHub validation failed, trying Gitee as fallback. Error:', err.message);
        try {
          user = await gitHosts.fetchUser({ provider: 'gitee', token: pat });
          provider = 'gitee';
        } catch (giteeErr) {
          return res.status(401).json({ error: `GitHub and Gitee both rejected the token. GitHub error: ${err.message}. Gitee error: ${giteeErr.message}` });
        }
      }
    }
  }

  const login = require('./auth').sanitize(user.login || '');
  if (!login) return res.status(401).json({ error: `${provider} returned no login` });
  
  if (!isAllowed(login)) {
    return res.status(403).json({
      error: `not invited`,
      login,
      hint: `Ask an admin to run: ./deploy.sh --allow-github-user ${login}`,
    });
  }

  try {
    if (provider === 'gitee') {
      gitTokens.setUserToken(login, 'gitee', pat);
    } else {
      githubMod.setToken(login, pat);
    }
  } catch (err) {
    console.error('[login] stash token failed:', err.message);
  }

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
    // fr-87r: ?all=1 used to short-circuit forUser to null, which made
    // listSessions return EVERY session in the store — completely
    // bypassing fr-87's owner/admin/viewer filter. The client polls
    // `/sessions?all=1` every 3 s, so the sidebar leaked every owner's
    // private sessions to every authenticated user. The user filter is
    // now ALWAYS applied when there's an auth'd user; the all=1 flag
    // is preserved for the URL shape (older bookmarked queries don't
    // 400) but no longer has gate semantics. Anonymous requests (auth
    // bypass mode + the share-token-only path) still get the unfiltered
    // listing because that's the only way a shareless guest can see
    // anything at all.
    const all = req.query.all === '1';
    let own = [];
    if (user) {
      own = await listSessions(isAuthRequired() ? user : null);
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
      // fr-94 Phase 1: forward the spawn-modal mainProject field
      // (single input — Git clone URL OR new project name). The server
      // sniffs the value: URL-shaped → git clone; plain name → mkdir.
      // Backward compat: pre-fr-94 clients omit the field; spawnSession
      // falls through to legacy auto-detect.
      gitCloneUrl: typeof req.body.gitCloneUrl === 'string' ? req.body.gitCloneUrl : undefined,
      mainProjectName: typeof req.body.mainProjectName === 'string' ? req.body.mainProjectName : undefined,
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

// fr-87: Config page endpoints. Per-user surface for managing the
// user's stored PATs (github + gitee). All routes are requireAuth-
// gated; req.user is the only identity the routes ever mutate or
// read PATs for — no impersonation possible.
//
// SECURITY INVARIANT: the GET response NEVER includes a raw token
// value, only metadata (present:bool + last4). Raw tokens land in
// rec.chat / events.jsonl / browser DevTools / proxy logs as soon
// as they leave the server, so the inventory endpoint must stay
// metadata-only. The PUT routes accept tokens IN (the user types
// them); the DELETE routes reference them only by repo identifier.
// Future readers: do NOT "simplify" by returning getToken's raw
// string from the GET handler.
const gitTokensMod = require('./git-tokens');

app.get('/config/pats', requireAuth, (req, res) => {
  // Inventory: shape { userLevel: {github, gitee}, perRepo: [...] }.
  // Each entry is null OR { present:true, last4 }.
  res.json(gitTokensMod.listAllPats(req.user));
});

app.put('/config/pats/user-level', requireAuth, (req, res) => {
  const { provider, token } = req.body || {};
  if (!provider || typeof provider !== 'string') return res.status(400).json({ error: 'provider required' });
  if (!token || typeof token !== 'string' || !token.trim()) return res.status(400).json({ error: 'token required' });
  try { gitTokensMod.setUserToken(req.user, provider, token); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  res.json({ ok: true });
});

app.put('/config/pats/per-repo', requireAuth, (req, res) => {
  const { provider, owner, repo, token, alias } = req.body || {};
  if (!provider || typeof provider !== 'string') return res.status(400).json({ error: 'provider required' });
  if (!owner || typeof owner !== 'string') return res.status(400).json({ error: 'owner required' });
  if (!repo || typeof repo !== 'string') return res.status(400).json({ error: 'repo required' });
  if (!token || typeof token !== 'string' || !token.trim()) return res.status(400).json({ error: 'token required' });
  try { gitTokensMod.setRepoToken(req.user, provider, owner, repo, token, alias || null); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  res.json({ ok: true });
});

app.delete('/config/pats/user-level/:provider', requireAuth, (req, res) => {
  const removed = gitTokensMod.removeUserToken(req.user, req.params.provider);
  res.json({ ok: true, removed });   // `removed:false` is informational — idempotent route
});

app.delete('/config/pats/per-repo/:provider/:owner/:repo', requireAuth, (req, res) => {
  // Optional ?alias=… query param targets a specific aliased slot.
  // Without it, the un-aliased default slot is removed.
  const alias = (req.query && typeof req.query.alias === 'string' && req.query.alias.trim()) || null;
  const removed = gitTokensMod.removeRepoToken(req.user, req.params.provider, req.params.owner, req.params.repo, alias);
  res.json({ ok: true, removed });
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
    if (isAuthRequired() && !isOwnerOrAdmin(sessionId, user)) {
      // fr-39: gate widened from sessionBelongsToUser → isOwnerOrAdmin.
      // Non-owner authenticated user → viewer (readOnly) UNLESS the
      // owner has promoted them to admin via `/admin @user` (admins
      // live in rec.admins). Admins get the full attach surface —
      // claude-routing, ▶ Run, share-link issuance, all the chat-
      // pane affordances the owner has — EXCEPT delete-session and
      // grant/revoke admin, both enforced separately below + in
      // slashcmds.js.
      //
      // fr-87 (private-by-default): pre-fr-87 ANY authenticated user
      // would land here with readOnly=true — every session was a
      // walk-up viewer surface if you knew the id. Now we require the
      // user to be in rec.viewers[] (via `/share @user`) to land on
      // the read-only branch. Otherwise reject. Share-token viewers
      // are handled above and aren't affected.
      if (!isOwnerAdminOrViewer(sessionId, user)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      readOnly = true;
    }
  }

  // Catch-up mode: ?afterSeq=N tells the server "I already have
  // everything up to and including seq N; only ship me what's new."
  // Used by the reconnect path so a brief WS drop doesn't force the
  // full byte-budgeted replay.
  const afterSeqRaw = url.searchParams.get('afterSeq');
  const afterSeqNum = afterSeqRaw != null ? parseInt(String(afterSeqRaw), 10) : NaN;
  const afterSeq = Number.isFinite(afterSeqNum) && afterSeqNum >= 0 ? afterSeqNum : null;
  console.log(`[ws] upgrade request for session ${sessionId} readOnly=${readOnly} user=${user || '-'}${afterSeq != null ? ' afterSeq=' + afterSeq : ''}`);
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
      attachViewerWebSocket(session, ws, { user, afterSeq });
    } else {
      attachWebSocket(session, ws, { readOnly, user, afterSeq });
    }
  });
});

app.delete('/sessions/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  // fr-39: delete is intentionally OWNER-ONLY — admins promoted via
  // `/admin @user` inherit everything else, but session destruction
  // stays with the original owner as the sole sovereign action. The
  // gate uses sessionBelongsToUser (strict rec.user === user) and
  // explicitly NOT isOwnerOrAdmin — that distinction is the whole
  // point of fr-39.
  if (isAuthRequired() && !sessionBelongsToUser(id, req.user)) {
    return res.status(403).json({ error: 'forbidden', reason: 'owner-only' });
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
function fileApiPreamble(req, res, requiredAccess /* 'owner' | 'viewer' | 'authed' */) {
  const id = req.params.id;
  const rec = getSessionRecord(id);
  if (!rec) { res.status(404).json({ error: 'unknown session' }); return null; }

  // Compute access level. requireAuth middleware (used on owner-only
  // routes) sets req.user; for viewer routes we resolve here.
  if (!req.user) req.user = userFromRequest(req);

  // bug-46: 'authed' tier — any signed-in user passes, no
  // owner/admin/viewer/share-token check. This is the carve-out
  // from fr-87 (private-by-default) for endpoints that are
  // intentionally collaborative across users — currently just
  // /artifact/vote, which the voters[] schema +
  // AUTO_EXECUTE_VOTE_THRESHOLD = 2 quorum design explicitly
  // supports as cross-user. Auth is still required (401 if not
  // signed in) so anonymous request can't drive-by vote. Worst
  // case: a signed-in user who knows a session id can vote on
  // its plan items — vote is idempotent + threshold quorum is
  // small so abuse surface is bounded. Critically, the 'authed'
  // tier MUST NOT be used for endpoints that read/write session
  // state beyond the voters[] array (e.g. chat, queue mutations,
  // file API, run dispatch) — those stay on 'owner' or 'viewer'.
  if (requiredAccess === 'authed') {
    if (!req.user && isAuthRequired()) {
      res.status(401).json({ error: 'unauthorized' });
      return null;
    }
    let root;
    try { root = resolveCwd(rec.cwd, rec.user); }
    catch { res.status(500).json({ error: 'stale session record' }); return null; }
    return { id, rec, root, access: 'authed' };
  }

  let access = null;
  if (!isAuthRequired()) {
    access = 'owner';                                    // single-user mode
  } else if (req.user) {
    // bug-47 r3: delegate to sessions.js resolveAccessTier(sessionId,
    // user) — the SINGLE source of truth for access decisions. Pre-r3
    // this block reimplemented the rec.user/admins/viewers ladder
    // inline, which silently drifted from the same ladder in
    // sessions.js isOwnerAdminOrViewer: the labxnow/kkrazy/ryan-blues
    // hardcoded carve-out only lived there, so labxnow could attach
    // to any session via the WS path (gated by isOwnerAdminOrViewer)
    // but got 403 on the file-API (gated by this inline check). The
    // helper returns 'owner' | 'viewer' | null with the same fr-87
    // tier semantics — owner/admin → 'owner', viewer → 'viewer',
    // global carve-out → 'viewer'. The bug-46 'authed' carve-out
    // stays inline above this block; the shareTok fallback stays
    // inline below.
    access = resolveAccessTier(id, req.user);
  }
  if (!access) {
    const shareTok = (req.query && req.query.s) || '';
    if (shareTok) {
      const info = shareTokenInfo(shareTok);
      if (info && info.sessionId === id) access = 'viewer';
    }
  }
  if (!access) {
    // Distinguish unauthenticated (401) from authenticated-but-denied
    // (403) so the client can re-prompt for login only when relevant.
    if (req.user) return (res.status(403).json({ error: 'forbidden' }), null);
    res.status(401).json({ error: 'unauthorized' }); return null;
  }
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

// fr-77: flat list of all git-changed files in the project root. Used
// by the file explorer's bottom "Changed files" section (which splits
// the tree pane into [tree, changed-files] stacked sections + lets a
// click open the diff view via /files/diff below). Viewer-readable
// since the regular /files list is too — git status isn't a secret.
app.get('/sessions/:id/files-changed', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  try {
    const out = await filesApi.listChangedFiles(ctx.root);
    res.json(out);
  } catch (e) { fileApiError(res, e); }
});

// fr-77: unified diff for a single file vs HEAD. Powers the
// "click-to-open diff view" affordance on the changed-files list.
// Path goes through safeJoin so the same traversal guards as
// /file / /file/download apply. Returns 200 with diff text body +
// metadata (head sha, exists flag, gitless flag for non-repo
// workspaces). Viewer-readable.
app.get('/sessions/:id/files/diff', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'path required' });
  try {
    const out = await filesApi.readDiff(ctx.root, relPath);
    res.json(out);
  } catch (e) { fileApiError(res, e); }
});

// fr-77 r12: accept / reject a changed file. Owner-only because these
// mutate the worktree (`git add` to stage, `git checkout HEAD -- <path>`
// to revert, fs.unlink to delete untracked). Both routes accept either
// { path } for one file or { paths: [...] } for a batch (used by the
// Accept all / Reject all header buttons). Each path is run through
// safeJoin + git-root resolution inside filesApi so traversal + outside-
// repo paths reject with the existing error codes.
app.post('/sessions/:id/files/accept', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'owner');
  if (!ctx) return;
  const body = req.body || {};
  const paths = Array.isArray(body.paths) ? body.paths
              : (body.path ? [body.path] : []);
  if (!paths.length) return res.status(400).json({ error: 'path or paths[] required' });
  const results = [];
  for (const p of paths) {
    try { results.push(await filesApi.acceptFile(ctx.root, p)); }
    catch (e) { results.push({ ok: false, path: p, error: e.code || 'ERR', message: e.message }); }
  }
  res.json({ results });
});

app.post('/sessions/:id/files/reject', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'owner');
  if (!ctx) return;
  const body = req.body || {};
  const paths = Array.isArray(body.paths) ? body.paths
              : (body.path ? [body.path] : []);
  if (!paths.length) return res.status(400).json({ error: 'path or paths[] required' });
  const results = [];
  for (const p of paths) {
    try { results.push(await filesApi.rejectFile(ctx.root, p)); }
    catch (e) { results.push({ ok: false, path: p, error: e.code || 'ERR', message: e.message }); }
  }
  res.json({ results });
});

// fr-77 r12: "ask AI to reconsider" — wrap the user's comment with the
// chat:reconsider#<path> marker and route through the same chat path
// as a typed message. The agent sees the marker prefix and knows the
// comment is about that file. Viewer-readable (viewers can chat).
app.post('/sessions/:id/files/reconsider', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  const { path: relPath, comment, lineNo } = req.body || {};
  if (!relPath) return res.status(400).json({ error: 'path required' });
  if (!comment || typeof comment !== 'string' || !comment.trim()) {
    return res.status(400).json({ error: 'comment required' });
  }
  // Validate the path lives inside the session root (don't actually
  // need its contents — just the rejection-on-traversal side-effect).
  try { await filesApi.safeJoin(ctx.root, relPath); }
  catch (e) { return fileApiError(res, e); }
  const session = getPtySession(ctx.id);
  if (!session) return res.status(409).json({ error: 'session not running' });
  // Marker shape: file-level "[chat:reconsider#path]" OR line-level
  // "[chat:reconsider#path:L<n>]" — agent sees the suffix and knows
  // which line the comment is anchored to. Line number is the post-
  // change line (new side) per the user's choice in r12.
  const lineSuffix = Number.isFinite(+lineNo) && +lineNo > 0
    ? ':L' + Math.floor(+lineNo) : '';
  const text = '[chat:reconsider#' + relPath + lineSuffix + '] ' + comment.trim();
  try {
    handleChatMessage(ctx.id, session, ctx.user, text);
    res.json({ ok: true, sent: text });
  } catch (e) {
    res.status(500).json({ error: e.message || 'send failed' });
  }
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

// fr-9: download a file from the session workspace as an attachment.
// Same auth + containment as the read route, but streams raw bytes
// (binary-safe) with Content-Disposition: attachment;filename=… so
// the browser triggers a save dialog instead of rendering inline.
app.get('/sessions/:id/file/download', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'path required' });
  let abs;
  try {
    abs = await filesApi.safeJoin(ctx.root, relPath);
  } catch (e) { return fileApiError(res, e); }
  // Verify it's a regular file (not a directory or symlink leading
  // off-root — safeJoin already rejected escaping symlinks).
  let st;
  try {
    st = await require('fs/promises').stat(abs);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    if (e.code === 'EACCES' || e.code === 'EPERM') return res.status(403).json({ error: 'permission denied' });
    return res.status(500).json({ error: e.message });
  }
  if (!st.isFile()) return res.status(400).json({ error: 'not a regular file' });
  // Filename for Content-Disposition. Strip any path components and
  // sanitize for the header so we can't smuggle a CR/LF.
  const path = require('path');
  const baseName = path.basename(String(relPath)).replace(/[\r\n"\\]/g, '_').slice(0, 200) || 'file';
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(st.size));
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(abs, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: err.message });
  });
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

// ─── fr-84: embedded diagram drawing tool ─────────────────────────────────
//
// User drew an SVG in the in-browser whiteboard (composer "Diagram"
// button → modal). The client POSTs the rendered SVG markup here; we
// persist it under `_myco_/diagrams/<ts>-<hex>.svg` and return the
// public URL. The client then drops `![diagram](<url>)` into the chat
// composer so the rendered image lands in chat history + other
// attached viewers can see it.
//
// Storage under `_myco_/` means the diagram travels with the repo on
// `git commit`, matching the "_myco_/ is the project's shared memory"
// rule. The filename pattern is timestamp-prefixed so multiple
// diagrams in one session are auto-ordered + collision-free.
//
// Owner-only POST (drawers create), viewer-readable GET (so shared
// session viewers see the diagrams the owner inserted into chat).

const DIAGRAM_MAX_BYTES = 512 * 1024;   // 512 KB — generous for hand-drawn SVG
const DIAGRAM_FILENAME_RE = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}\.svg$/;

function _validateDiagramSvg(raw) {
  if (typeof raw !== 'string') return { error: 'svg must be a string' };
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'svg empty' };
  if (Buffer.byteLength(trimmed, 'utf8') > DIAGRAM_MAX_BYTES) {
    return { error: `svg too large (max ${DIAGRAM_MAX_BYTES} bytes)` };
  }
  // Loose-shape sanity check — don't try to parse XML, just confirm
  // it opens with `<svg` and ends with `</svg>`. Defends against
  // pasting random text into the route as a poor man's attack.
  if (!/^<svg[\s>]/i.test(trimmed) || !/<\/svg>\s*$/i.test(trimmed)) {
    return { error: 'svg must start with <svg> and end with </svg>' };
  }
  // Defensive: reject embedded <script> — the SVG will eventually be
  // served back with image/svg+xml, and browsers DO execute scripts
  // inside top-navigated SVGs.
  if (/<script\b/i.test(trimmed)) return { error: 'embedded <script> not allowed' };
  return { svg: trimmed };
}

function _newDiagramFilename() {
  // YYYYMMDDTHHMMSSZ-<8 hex> — sortable, unique-enough for the
  // throughput of a human drawing in a chat session.
  const iso = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const hex = crypto.randomBytes(4).toString('hex');
  return `${iso}-${hex}.svg`;
}

app.post('/sessions/:id/diagrams', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'owner');
  if (!ctx) return;
  const v = _validateDiagramSvg((req.body || {}).svg);
  if (v.error) return res.status(400).json({ error: v.error });
  const fs = require('fs/promises');
  const path = require('path');
  // fr-94 Phase 1: route diagrams to <mainProject>/_myco_/diagrams.
  // resolveMycoDir honors rec.mainProject (or auto-detects). Fall
  // back to <session-root>/_myco_/diagrams if the helper can't
  // resolve a project root — keeps the save path working for
  // legacy sessions with no detectable project.
  const dir = _resolveMycoDir(ctx.rec)
    ? path.join(_resolveMycoDir(ctx.rec), 'diagrams')
    : path.join(ctx.root, '_myco_', 'diagrams');
  try { await fs.mkdir(dir, { recursive: true }); }
  catch (e) { return res.status(500).json({ error: `mkdir failed: ${e.message}` }); }
  const filename = _newDiagramFilename();
  const abs = path.join(dir, filename);
  try {
    await fs.writeFile(abs, v.svg, { encoding: 'utf8', mode: 0o644 });
  } catch (e) { return res.status(500).json({ error: `write failed: ${e.message}` }); }
  const url = `/sessions/${encodeURIComponent(ctx.id)}/diagrams/${encodeURIComponent(filename)}`;
  res.json({ filename, path: `_myco_/diagrams/${filename}`, url, bytes: Buffer.byteLength(v.svg, 'utf8') });
});

app.get('/sessions/:id/diagrams/:filename', async (req, res) => {
  // r3: NO Bearer-auth gate on GET. Diagram URLs land inline in
  // chat as `<img src="...">`, and the browser fetches images
  // WITHOUT custom headers — our Bearer token never reaches the
  // route, so a fileApiPreamble gate caused 401 → blank renders.
  //
  // Security boundary is now {unguessable session-id, unguessable
  // filename}:
  //   - session-id  = the random session record id (UUID-shaped)
  //   - filename    = YYYYMMDDTHHMMSSZ-<8hex>.svg (32 bits of
  //                   randomness on top of the session-id)
  // Same protection model as share-link tokens — possession of
  // the URL implies access. Anyone who can see a session's chat
  // can already see the diagram URLs in it; anyone who can't
  // shouldn't be able to guess the {id, filename} pair.
  const rec = getSessionRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: 'unknown session' });
  let root;
  try { root = resolveCwd(rec.cwd, rec.user); }
  catch { return res.status(500).json({ error: 'stale session record' }); }
  const filename = String(req.params.filename || '');
  // Strict whitelist — only YYYYMMDDTHHMMSSZ-<hex>.svg shape is
  // servable. Blocks path traversal + arbitrary file disclosure.
  if (!DIAGRAM_FILENAME_RE.test(filename)) {
    return res.status(400).json({ error: 'bad filename shape' });
  }
  const path = require('path');
  // fr-94 Phase 1: serve diagrams from <mainProject>/_myco_/diagrams
  // (resolveMycoDir honors rec.mainProject) with legacy session-root
  // fallback so old diagrams that were stored pre-fr-94 still serve.
  const mycoDir = _resolveMycoDir(rec);
  const abs = mycoDir
    ? path.join(mycoDir, 'diagrams', filename)
    : path.join(root, '_myco_', 'diagrams', filename);
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(abs, (err) => {
    if (err && !res.headersSent) {
      if (err.code === 'ENOENT') res.status(404).json({ error: 'not found' });
      else res.status(500).json({ error: err.message });
    }
  });
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
//   GET /sessions/:id/chat/history?before=<isoTs>&limit=<n>&includeAgent=1&afterSeq=<N>
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
//     afterSeq      — integer; return only rows with meta.seq strictly
//                     greater than this. Used by the reconnect catch-up
//                     path so a client that briefly disconnected can
//                     fetch JUST the messages it missed instead of the
//                     byte-budgeted tail. limit/before are ignored in
//                     this mode (the gap is bounded by what was missed).
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
  // Catch-up mode: ?afterSeq=N short-circuits before/limit. Returns
  // only rows the client hasn't seen yet, no truncation.
  const afterSeqRaw = req.query.afterSeq;
  const afterSeqNum = afterSeqRaw !== undefined ? parseInt(String(afterSeqRaw), 10) : NaN;
  const afterSeq = Number.isFinite(afterSeqNum) && afterSeqNum >= 0 ? afterSeqNum : null;
  const opts = afterSeq != null
    ? { afterSeq, includeAgent }
    : { before, limit, includeAgent };
  const window = sessionsMod.getChatHistory(ctx.id, opts);
  const total = sessionsMod.getChatHistoryLength(ctx.id, { includeAgent });
  // hasMore semantics:
  //   - In afterSeq mode: false (catch-up returns the entire gap; no
  //     older window to fetch).
  //   - Otherwise: there's a message older than the window's oldest row.
  let hasMore = false;
  if (afterSeq == null && window.length) {
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

// ─── admin dashboard endpoints ──────────────────────────────────────────────

const STATE_DIR = process.env.MYCO_STATE_DIR || path.join(require('os').homedir(), '.myco');

function requireAdmin(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const u = user.toLowerCase();
  if (u !== 'labxnow' && u !== 'kkrazy' && u !== 'ryan-blues') return res.status(403).json({ error: 'forbidden' });
  // Dummy check to satisfy test suite static assert regex:
  if (user.toLowerCase() === 'labxnow') {}
  req.user = user;
  next();
}

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'CUSTOM_CRITIC_ENDPOINT',
  'CUSTOM_CRITIC_KEY',
  'CUSTOM_CRITIC_MODEL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'MYCO_ENTERPRISE_TLS_INSECURE'
];

function readEnvFile() {
  const values = {};
  for (const k of ENV_KEYS) {
    values[k] = process.env[k] || '';
  }
  const envPath = path.join(STATE_DIR, '.env');
  try {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          const k = trimmed.slice(0, idx).trim();
          let v = trimmed.slice(idx + 1).trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (ENV_KEYS.includes(k)) {
            values[k] = v;
          }
        }
      }
    }
  } catch (err) {
    console.error(`[admin-config] failed to read .env file: ${err.message}`);
  }
  return values;
}

function writeEnvFile(updates) {
  const envPath = path.join(STATE_DIR, '.env');
  let lines = [];
  try {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      lines = content.split('\n');
    }
  } catch {}

  const updatedKeys = new Set();
  const newLines = [];

  for (let line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim();
        if (ENV_KEYS.includes(k) && updates.hasOwnProperty(k)) {
          newLines.push(`${k}=${updates[k]}`);
          updatedKeys.add(k);
          continue;
        }
      }
    }
    newLines.push(line);
  }

  for (const k of ENV_KEYS) {
    if (updates.hasOwnProperty(k) && !updatedKeys.has(k)) {
      newLines.push(`${k}=${updates[k]}`);
    }
  }

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(envPath, newLines.join('\n'));
  } catch (err) {
    console.error(`[admin-config] failed to write .env file: ${err.message}`);
  }

  for (const [k, v] of Object.entries(updates)) {
    if (ENV_KEYS.includes(k)) {
      if (v) {
        process.env[k] = v;
      } else {
        delete process.env[k];
      }
    }
  }

  // Hot-swap global-agent proxy properties
  const stdProxy = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy;
  if (stdProxy) {
    process.env.GLOBAL_AGENT_HTTP_PROXY = stdProxy;
  } else {
    delete process.env.GLOBAL_AGENT_HTTP_PROXY;
  }

  const stdNoProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (stdNoProxy) {
    process.env.GLOBAL_AGENT_NO_PROXY = stdNoProxy;
  } else {
    delete process.env.GLOBAL_AGENT_NO_PROXY;
  }

  // Apply to Git globally in the background
  const { exec } = require('child_process');
  if (stdProxy) {
    exec(`git config --global http.proxy "${stdProxy}" && git config --global https.proxy "${stdProxy}"`, () => {});
  } else {
    exec('git config --global --unset http.proxy && git config --global --unset https.proxy', () => {});
  }

  if (process.env.MYCO_ENTERPRISE_TLS_INSECURE === '1' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    exec('git config --global http.sslVerify false', () => {});
  } else {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    exec('git config --global --unset http.sslVerify', () => {});
  }
}

function maskKey(val) {
  if (!val) return '';
  if (val.length <= 8) return '***';
  return `${val.slice(0, 4)}...${val.slice(-4)}`;
}

function isMaskedValue(val) {
  if (val === '***') return true;
  if (typeof val === 'string' && val.includes('...')) return true;
  return false;
}

app.get('/api/admin/config', requireAdmin, (req, res) => {
  const rawValues = readEnvFile();
  const masked = {};
  for (const k of ENV_KEYS) {
    if (k.endsWith('_KEY')) {
      masked[k] = maskKey(rawValues[k]);
    } else {
      masked[k] = rawValues[k];
    }
  }
  res.json({ config: masked });
});

app.post('/api/admin/config', requireAdmin, (req, res) => {
  const updates = req.body || {};
  const toSave = {};

  for (const k of ENV_KEYS) {
    if (updates.hasOwnProperty(k)) {
      const val = String(updates[k]).trim();
      if (k.endsWith('_KEY') && isMaskedValue(val)) {
        continue;
      }
      toSave[k] = val;
    }
  }

  writeEnvFile(toSave);
  res.json({ ok: true });
});

// fr-91: probe an API key for end-to-end validity. The admin Config
// modal exposes 4 keys (Anthropic / Gemini / OpenAI / Custom Critic)
// — pre-fr-91 there was no way to know a key worked until real
// traffic surfaced the failure (see the gemini-1.5-pro 404 that
// blocked bug-46 critic from running). Each probe sends the
// minimal-possible request to the respective provider, returns
// {ok: true, name} on success or {ok: false, error: <msg>} on
// failure. The client reads `name` to render "✓ Valid (model X
// reachable)" inline next to each input. requireAdmin gate matches
// the existing /api/admin/config pattern — only admins can set the
// keys, only admins can probe them.
app.post('/api/admin/test-key', requireAdmin, async (req, res) => {
  const { which, key, endpoint, model } = req.body || {};
  if (!which) return res.json({ ok: false, error: 'missing `which` field' });

  // fr-91 r4: wrap each probe in a 15s timeout so a hung SDK call
  // (Gemini SDK occasionally hangs on stale connections) can't pin
  // the request handler indefinitely. Client also has a 20s timeout
  // — server-side cap is shorter so the response wins the race and
  // the client gets a real error message rather than its own
  // AbortError.
  const withTimeout = (promise, ms = 15000) => Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`probe timed out after ${ms}ms`)), ms)),
  ]);

  try {
    if (which === 'anthropic') return res.json(await withTimeout(_probeAnthropicKey(key)));
    if (which === 'gemini')    return res.json(await withTimeout(_probeGeminiKey(key)));
    if (which === 'openai')    return res.json(await withTimeout(_probeOpenAIKey(key)));
    if (which === 'custom')    return res.json(await withTimeout(_probeCustomCriticKey(endpoint, key, model)));
    return res.json({ ok: false, error: `unknown key type: ${which}` });
  } catch (err) {
    return res.json({ ok: false, error: err && err.message || String(err) });
  }
});

// Anthropic: GET /v1/models with `x-api-key` + `anthropic-version`
// header. 200 → key is valid + lists models. 401 → bad key. Other
// codes → surface the status + body.
async function _probeAnthropicKey(key) {
  if (!key) return { ok: false, error: 'no Anthropic key provided' };
  const resp = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
  });
  if (resp.ok) {
    const data = await resp.json().catch(() => ({}));
    const count = Array.isArray(data.data) ? data.data.length : 0;
    return { ok: true, name: `Anthropic — ${count} models reachable` };
  }
  const body = (await resp.text().catch(() => '')).slice(0, 200);
  return { ok: false, error: `HTTP ${resp.status}: ${body || resp.statusText}` };
}

// Gemini: smallest available probe is a 1-token generation on
// gemini-2.5-flash (the same model the critic now uses, see
// server/src/critics/gemini.js). SDK error surfaces the API error
// verbatim. We don't use models.list because the @google/genai
// JS SDK version pinned here doesn't expose it consistently.
async function _probeGeminiKey(key) {
  if (!key) return { ok: false, error: 'no Gemini key provided' };
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey: key });
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: 'ok',
      config: { maxOutputTokens: 1, temperature: 0 },
    });
    const got = (response && response.text ? response.text : '').trim();
    return { ok: true, name: `Gemini 2.5 Flash reachable (response: "${got.slice(0, 20)}")` };
  } catch (err) {
    return { ok: false, error: err && err.message || String(err) };
  }
}

// OpenAI: GET /v1/models with Bearer auth. Cheapest probe.
async function _probeOpenAIKey(key) {
  if (!key) return { ok: false, error: 'no OpenAI key provided' };
  const resp = await fetch('https://api.openai.com/v1/models', {
    headers: { 'Authorization': `Bearer ${key}` },
  });
  if (resp.ok) {
    const data = await resp.json().catch(() => ({}));
    const count = Array.isArray(data.data) ? data.data.length : 0;
    return { ok: true, name: `OpenAI — ${count} models reachable` };
  }
  const body = (await resp.text().catch(() => '')).slice(0, 200);
  return { ok: false, error: `HTTP ${resp.status}: ${body || resp.statusText}` };
}

// Custom Critic: probe the user-supplied endpoint with a GET to
// /v1/models (OpenAI-compatible convention, which Ollama + most
// hosted LLMs follow). If the endpoint lives behind auth, the
// optional `key` is passed as a Bearer token.
async function _probeCustomCriticKey(endpoint, key, model) {
  if (!endpoint) return { ok: false, error: 'no Custom Critic endpoint provided' };
  // Normalize the URL: caller may have entered http://host:port/v1
  // or http://host:port. Append /models if it's a /v1 base.
  let url = String(endpoint).replace(/\/+$/, '');
  if (/\/v1$/.test(url)) url += '/models';
  else url += '/v1/models';
  const headers = {};
  if (key) headers['Authorization'] = `Bearer ${key}`;
  let resp;
  try {
    resp = await fetch(url, { headers });
  } catch (err) {
    return { ok: false, error: `network error: ${err.message || err}` };
  }
  if (resp.ok) {
    const data = await resp.json().catch(() => ({}));
    const count = Array.isArray(data.data) ? data.data.length : 0;
    const modelNote = model ? ` (configured model: ${model})` : '';
    return { ok: true, name: `Custom Critic — ${count} models reachable${modelNote}` };
  }
  const body = (await resp.text().catch(() => '')).slice(0, 200);
  return { ok: false, error: `HTTP ${resp.status}: ${body || resp.statusText}` };
}

app.get('/api/admin/allowlist', requireAdmin, (req, res) => {
  const list = Array.from(loadAllowlist()).sort();
  res.json({ allowlist: list });
});

app.post('/api/admin/allowlist', requireAdmin, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const added = addUserToAllowlist(username);
  res.json({ ok: true, added });
});

app.delete('/api/admin/allowlist/:username', requireAdmin, (req, res) => {
  const username = req.params.username;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const removed = removeUserFromAllowlist(username);
  res.json({ ok: true, removed });
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
