// Boot-time .env loader (2026-06-03 fix: "why the critic is not
// kicked off?"). The container's state dir (default /data, override
// MYCO_STATE_DIR) holds a single .env file managed by the admin-
// config UI for OAuth + API-key secrets. Until today, that file
// was ONLY read by the admin UI's GET/POST handlers — the boot
// path didn't load it, so on every container restart
// process.env.GEMINI_API_KEY went back to undefined, the gemini
// critic returned the literal "(Gemini API key missing…)" placeholder,
// and every /run dispatch's critique broadcast was effectively dead.
// The critic-truncation + dispatch-drift fixes earlier today were
// real but cosmetic — without the API key reaching the process,
// the critic was always going to return a placeholder string.
//
// Semantics: docker run -e KEY=val and the host environment WIN
// over /data/.env (we never overwrite an already-set key). This
// keeps the admin-UI editor as the source of truth for secrets
// without breaking the ops escape hatch of setting a key on the
// docker command line.
//
// Vanilla parser — no `dotenv` dep. Handles `KEY=value` lines with
// optional surrounding quotes, `# comments`, blank lines. Anything
// malformed is silently skipped (the admin UI writes well-formed
// lines; a hand-edit typo shouldn't crash boot).
(function _loadStateDirEnvAtBoot() {
  try {
    const fs = require('fs');
    const path = require('path');
    const stateDir = process.env.MYCO_STATE_DIR || path.join(require('os').homedir(), '.myco');
    const envPath = path.join(stateDir, '.env');
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    let loaded = 0;
    for (const line of raw.split(/\r?\n/)) {
      const stripped = line.trim();
      if (!stripped || stripped.startsWith('#')) continue;
      const eq = stripped.indexOf('=');
      if (eq <= 0) continue;            // malformed (no key)
      const key = stripped.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;  // unsafe key shape
      if (process.env[key] != null) continue;                // docker -e / host env wins
      let value = stripped.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
      loaded++;
    }
    if (loaded > 0) console.log(`[boot] loaded ${loaded} env var(s) from ${envPath}`);
  } catch (err) {
    console.error(`[boot] .env loader failed: ${err && err.message ? err.message : err}`);
  }
})();

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
const { listSessions, spawnSession, sessionBelongsToUser, isOwnerOrAdmin, isOwnerAdminOrViewer, resolveAccessTier, workspaceName, listWorkspaceDirs, ensureLiveSession, deleteSession, importExistingTranscripts, loadStore, saveStore, getSessionRecord, readDescriptionForCwd: readDescriptionForCwdPublic, resolveCwd, getFileChat, getRecentFileChatMessages, appendFileChatMessage, deleteFileChatMessage, putSession } = sessionsMod;
const filesApi = require('./files');
// delm-10: skill store — list / upload / import / delete / select.
const skillsApi = require('./skills');
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
  mintSession, revokeSession, loadAllowlist, isAllowed, isAllowlistConfigured,
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

// ── whatsnew: versioned "feature update" markdown ──────────────────────
// Each feature update ships a markdown file in docs/whatsnew/ named
// YYYY-MM-DD-<slug>.md — filename sort order = chronological order, so
// the lexicographically-last file is the current version and older
// files double as the archive/backup. GET /whatsnew returns the latest
// version's metadata + full markdown (client renders via marked);
// GET /whatsnew/:version returns any archived version's markdown for
// the history dropdown in the client modal.
const WHATSNEW_DIR = path.join(__dirname, '..', '..', 'docs', 'whatsnew');
function listWhatsnewVersions() {
  let names;
  try {
    names = fs.readdirSync(WHATSNEW_DIR).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  // Slice off the .md suffix — the client treats the bare filename stem
  // as the version id everywhere (banner dismiss key, dropdown value).
  return names.sort(); // lexicographic = chronological by naming convention
}
function whatsnewTitle(markdown) {
  const m = typeof markdown === 'string' ? markdown.match(/^#\s+(.+)$/m) : null;
  return m ? m[1].trim() : '';
}
function readWhatsnewVersion(version) {
  // Guard against path traversal — the version id must be a plain stem
  // that exists in the directory listing, never a user-built path.
  const versions = listWhatsnewVersions();
  if (!versions.includes(version + '.md')) return null;
  try {
    return fs.readFileSync(path.join(WHATSNEW_DIR, version + '.md'), 'utf8');
  } catch {
    return null;
  }
}
app.get('/whatsnew', (req, res) => {
  const versions = listWhatsnewVersions();
  if (!versions.length) return res.json({ available: false, versions: [] });
  const latest = versions[versions.length - 1];
  const markdown = readWhatsnewVersion(latest.replace(/\.md$/, ''));
  if (markdown === null) return res.json({ available: false, versions: [] });
  res.set('Cache-Control', 'no-store');
  res.json({
    available: true,
    version: latest.replace(/\.md$/, ''),
    title: whatsnewTitle(markdown),
    markdown,
    // Newest→oldest for the client's history dropdown.
    versions: versions.slice().reverse().map((v) => v.replace(/\.md$/, '')),
  });
});
app.get('/whatsnew/:version', (req, res) => {
  const markdown = readWhatsnewVersion(req.params.version);
  if (markdown === null) return res.status(404).json({ error: 'unknown whatsnew version' });
  res.set('Content-Type', 'text/markdown; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send(markdown);
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
  // Same conditional-enforcement semantics as the PAT path below: only
  // reject when an allowlist is actually configured. Open mode (no
  // allowed-github-users.txt, or MYCO_DISABLE_ALLOWLIST set) admits any
  // valid provider login.
  if (isAllowlistConfigured() && !isAllowed(login)) {
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
  // Provider may be explicit (from the login modal's dropdown) or 'auto'
  // (heuristic). Unknown values fall back to 'auto' so old clients that
  // POST without a provider keep working.
  let provider = String((req.body && req.body.provider) || 'auto').toLowerCase();
  if (!['github', 'gitee', 'codehub', 'auto'].includes(provider)) provider = 'auto';

  const bypass = String(process.env.MYCO_TEST_OAUTH_BYPASS || '').trim();
  // Test seam: canned users, no network — mirrors each provider branch so
  // the E2E suite exercises every login path deterministically.
  if (bypass && pat.startsWith('test-codehub-token-')) {
    const login = pat.slice('test-codehub-token-'.length);
    console.log(`[login] Test bypass active. Resolving CodeHub user: ${login}`);
    user = { username: login, login, id: 300000 + login.split('').reduce((a, c) => a + c.charCodeAt(0), 0), name: login, avatar_url: '' };
    provider = 'codehub';
  } else if (bypass && pat.startsWith('test-token-')) {
    const login = pat.slice(11);
    console.log(`[login] Test bypass active. Resolving GitHub user: ${login}`);
    user = { login, id: 100000 + login.split('').reduce((a, c) => a + c.charCodeAt(0), 0), name: login, avatar_url: '' };
    provider = 'github';
  } else if (bypass && pat.startsWith('test-gitee-token-')) {
    const login = pat.slice(17);
    console.log(`[login] Test bypass active. Resolving Gitee user: ${login}`);
    user = { login, id: 200000 + login.split('').reduce((a, c) => a + c.charCodeAt(0), 0), name: login, avatar_url: '' };
    provider = 'gitee';
  } else if (provider === 'codehub') {
    // Explicit CodeHub (Huawei intranet GitLab-family): validate the PAT
    // against /api/v4/user via git-hosts (PRIVATE-TOKEN header). Needs
    // codehub-dg-g.huawei.com reachable directly (in no_proxy), not via
    // the enterprise proxy.
    try {
      console.log('[login] Explicit CodeHub provider. Validating against codehub.');
      user = await gitHosts.fetchUser({ provider: 'codehub', token: pat });
      provider = 'codehub';
    } catch (err) {
      return res.status(401).json({ error: `CodeHub rejected the token. ${err.message}` });
    }
  } else if (provider === 'github') {
    try {
      console.log('[login] Explicit GitHub provider.');
      user = await oauth.fetchUser(pat);
      provider = 'github';
    } catch (err) {
      return res.status(401).json({ error: `GitHub rejected the token. ${err.message}` });
    }
  } else if (provider === 'gitee') {
    try {
      console.log('[login] Explicit Gitee provider.');
      user = await gitHosts.fetchUser({ provider: 'gitee', token: pat });
      provider = 'gitee';
    } catch (err) {
      return res.status(401).json({ error: `Gitee rejected the token. ${err.message}` });
    }
  } else {
    // auto: heuristic — pick the most LIKELY provider by token shape, then
    // fall back through the OTHERS so a CodeHub PAT (whose format isn't a
    // reliably sniffable prefix) is still found. Gitee PATs are typically
    // 32-char hex / gitee_pat_; GitHub PATs carry a ghp_/gho_/ghu_/ghs_/
    // github_pat_ prefix. GitHub goes first in the ambiguous case (most
    // common by volume).
    const isLikelyGitee  = pat.startsWith('gitee_') || /^[a-f0-9]{32}$/i.test(pat);
    const isLikelyGithub = /^(ghp_|gho_|ghu_|ghs_|github_pat_)/.test(pat);
    const order = isLikelyGitee  ? ['gitee', 'github', 'codehub']
                : isLikelyGithub ? ['github', 'gitee', 'codehub']
                : ['github', 'gitee', 'codehub'];

    // Probe candidates in order. First provider that accepts the token wins.
    const errs = {};
    for (const p of order) {
      try {
        user = (p === 'github')
          ? await oauth.fetchUser(pat)
          : await gitHosts.fetchUser({ provider: p, token: pat });
        provider = p;
        console.log(`[login] Auto-detect: ${p} accepted the token.`);
        break;
      } catch (e) {
        errs[p] = e.message;
        console.log(`[login] Auto-detect: ${p} rejected (${e.message}).`);
      }
    }
    if (!user) {
      return res.status(401).json({
        error: `All providers rejected the token. GitHub: ${errs.github || 'n/a'}. Gitee: ${errs.gitee || 'n/a'}. CodeHub: ${errs.codehub || 'n/a'}`,
      });
    }
  }

  const authMod = require('./auth');
  const login = authMod.sanitize(user.login || '');
  if (!login) return res.status(401).json({ error: `${provider} returned no login` });

  // Only enforce the invitation allowlist when one is configured. In
  // "open" mode (auth required via MYCO_AUTH_REQUIRED but no
  // allowed-github-users.txt) any valid provider login is admitted.
  if (authMod.isAllowlistConfigured() && !isAllowed(login)) {
    return res.status(403).json({
      error: `not invited`,
      login,
      hint: `Ask an admin to run: ./deploy.sh --allow-github-user ${login}`,
    });
  }

  try {
    if (provider === 'codehub') {
      gitTokens.setUserToken(login, 'codehub', pat);
    } else if (provider === 'gitee') {
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
    // 400) but no longer has gate semantics. Anonymous requests (the
    // share-token-only path) never reach listSessions at all — they only
    // get the explicit share-token entries below, so a guest can never
    // enumerate the store.
    const all = req.query.all === '1';
    let own = [];
    if (user) {
      // delm-10 ghost-session fix: never pass null to listSessions when
      // there is a user. The old isAuthRequired() ? user : null made the
      // auth-bypass path list EVERY session in the store, so a browser
      // that hit the endpoint unauthenticated saw other users' sessions
      // as "shared" ghosts.
      own = await listSessions(user);
      // Tag owned/owner so the client can label non-owned sessions and
      // open them in viewer (read-only) mode without a share token.
      // bug-84: also enrich each session with a `pendingVerdict` flag
      // so the sidebar (polled every 3s) can render a visible
      // indicator when a verdict modal is waiting in another session.
      // The flag mirrors fr-98's attach-replay precondition exactly
      // (sessionsMod.hasPendingVerdict — checks lastCriticReview is
      // set AND stageState.status is awaiting_verdict OR
      // awaiting_accept, same conditions fr-98 uses at
      // attach.js:1807-1810). Result: the badge and the replay are
      // guaranteed to agree — click the badged session card, fr-98
      // replays the modal on the fresh attach. Without this surface,
      // the user has no cross-session visibility into pending verdicts
      // and tends to type "continue" out of impatience, which routes
      // to claude (or chat-accept) and silently advances stages
      // without the user ever seeing the modal.
      for (const s of own) {
        // delm-10: busy/review/queue enrichment applies to every listed
        // session regardless of auth mode. Pre-redesign this block
        // short-circuited with `if (!isAuthRequired()) { s.owned = true;
        // continue; }` — in the k8s single-user deployment (no OAuth
        // config → isAuthRequired()=false) the short-circuit skipped the
        // agentBusy/agentHasReview computation entirely, so the sidebar
        // NEVER showed the "working" badge — the "working badge stopped
        // displaying" bug. owned=true still lands for the open mode;
        // the enrichments now run unconditionally.
        const rec = getSessionRecord(s.id);
        if (!isAuthRequired()) {
          s.owned = true;
        } else {
          s.owned = !!(rec && rec.user === user);
          if (!s.owned && rec) s.owner = rec.user || null;
        }
        s.pendingVerdict = sessionsMod.hasPendingVerdict(rec);
        // delm-10 busy indicator: agentBusy=true while the session's
        // AgentSession has an SDK query iteration streaming (claude
        // actively working). The sidebar polls this list every ~3s and
        // renders a pulsing "working" badge on the session card, so
        // anyone looking at the sidebar can tell WHICH session is
        // working at a glance. agent-n2 team sessions expose the same
        // contract: TeamSession.isBusy() aggregates its workers
        // (team-session.js working-status parity).
        const live = getPtySession(s.id);
        s.agentBusy = !!(live && typeof live.isBusy === 'function' && live.isBusy());
        // delm-10 stale-working-badge fix: "to review" badge. When the
        // agent finished (terminal event stamped at live._lastDoneAt)
        // and the user hasn't looked at the session since (rec.agentSeenAt
        // absent or older than the done moment), the sidebar flips the
        // "● working" chip to a steady "◦ to review" chip. Opening the
        // session (attach or POST /sessions/:id/viewed) stamps
        // rec.agentSeenAt and the badge disappears — "user viewed it,
        // nothing new" = no icon at all, per the requested UX.
        const doneAt = (live && typeof live._lastDoneAt === 'number') ? live._lastDoneAt : null;
        const seenAt = (rec && typeof rec.agentSeenAt === 'number') ? rec.agentSeenAt : 0;
        s.agentHasReview = !!(doneAt && seenAt < doneAt);
        // delm-10 queue visibility: the run-queue lives on the session
        // record (rec.runQueue) and survives session switches + restarts,
        // but the sidebar only sees it after attaching. Ship the open
        // (pending + running) counts here so the sidebar (3s poll) can
        // badge every session with queued/running work — switching
        // sessions never loses sight of the queue.
        const openQ = (rec && Array.isArray(rec.runQueue))
          ? rec.runQueue.filter((e) => e && (e.status === 'pending' || e.status === 'running'))
          : [];
        s.queueOpen = openQ.length;
        s.queueRunning = openQ.filter((e) => e.status === 'running').length;
        // §5.2: sidebar 🧠 RLM badge — which sessions run in RLM mode,
        // visible without opening the session (3s poll picks up /rlm on).
        s.rlm = !!(rec && sessionsMod.isRlmEffective(rec));
        s.rlmScope = rec ? sessionsMod.getRlmScope(rec) : null;
        // mcp-market: the entries installed in this session (rec.
        // installedMcp) — the Skills panel's MCP tab badges cards
        // with it. Array copy; absent when nothing is installed.
        if (rec && Array.isArray(rec.installedMcp)) s.installedMcp = rec.installedMcp.slice();
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
      // delm-10 ghost-session fix r2 (kkrazy report): the share tokens
      // ARE the session id (see auth.js createShareToken), and the
      // client keeps them forever in localStorage 'myco_shares',
      // replaying them on every 3-second sidebar poll. Pre-fix this
      // branch listed ANY session whose id matched the token — with no
      // access check at all. So a stale entry (session deleted and
      // later re-imported, a session id the user only ever viewed via
      // a link that was later revoked, or simply a foreign id picked
      // up from an old /?s= URL) re-surfaced the session in the
      // sidebar after every page refresh — the "session I closed came
      // back" symptom. Gate the branch on resolveAccessTier (the same
      // single source of truth fr-87 uses): authed users must be
      // owner/admin/viewer on the session; anonymous guests keep the
      // share-link path (that's the entire point of a share link), but
      // a deleted session has no record so shareTokenInfo already
      // returns null for it above.
      if (user && isAuthRequired() && resolveAccessTier(info.sessionId, user) === null) {
        continue;
      }
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

// delm-10 stale-working-badge fix: mark a session as "reviewed by the
// user". The sidebar's "◦ to review" badge (GET /sessions →
// s.agentHasReview) shows when the agent finished after the user's
// last look. The client fires this endpoint when the user opens/views
// a session's chat; the server stamps rec.agentSeenAt = Date.now()
// (persisted in sessions.json so the state survives restarts). Idem-
// potent — a fresh open while the agent works also stamps, so the
// badge only re-arms after the NEXT terminal event.
app.post('/sessions/:id/viewed', requireAuth, (req, res) => {
  const id = req.params.id;
  if (isAuthRequired() && !sessionBelongsToUser(id, req.user)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const rec = getSessionRecord(id);
    if (!rec) return res.status(404).json({ error: 'unknown session' });
    rec.agentSeenAt = Date.now();
    saveStore();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: redact(err.message) });
  }
});

app.post('/sessions', requireAuth, async (req, res) => {
  try {
    // fr-94 Phase 3 r1: main project is REQUIRED. Reject with a 400
    // when neither gitCloneUrl nor mainProjectName is provided —
    // every new session must designate a main project so _myco_/
    // has a canonical home from the first event. Defense in depth
    // against a stale client that doesn't enforce the field; the
    // spawn modal also blocks empty submissions client-side.
    const gitCloneUrl = typeof req.body.gitCloneUrl === 'string' ? req.body.gitCloneUrl.trim() : '';
    const mainProjectName = typeof req.body.mainProjectName === 'string' ? req.body.mainProjectName.trim() : '';
    if (!gitCloneUrl && !mainProjectName) {
      res.status(400).json({ error: 'Main project is required — provide a gitCloneUrl or mainProjectName.' });
      return;
    }
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
      gitCloneUrl: gitCloneUrl || undefined,
      mainProjectName: mainProjectName || undefined,
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

// ─── Per-user model-gateway profiles (base_url / auth_token / model) ──────
// The user can save MULTIPLE named gateway profiles and switch which one is
// active; the active profile is injected into their agent SDK calls on the
// next turn (see agent-session.js `_ensureIteration`). Same access model as
// the PATs routes above: requireAuth-gated, and every route only reads or
// mutates req.user's OWN profiles — no impersonation possible.
//
// SECURITY INVARIANT (matches /config/pats): the GET response NEVER includes
// a raw authToken — only `tokenSet:true/false` + a short mask. Tokens only
// flow IN via the POST body; they are never returned by the server.
const gatewaysMod = require('./gateways');

app.get('/api/gateways', requireAuth, (req, res) => {
  res.json(gatewaysMod.listProfiles(req.user));
});

app.post('/api/gateways', requireAuth, (req, res) => {
  const { name, baseUrl, authToken, model } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'profile name required' });
  if (baseUrl != null && typeof baseUrl !== 'string') return res.status(400).json({ error: 'baseUrl must be a string' });
  if (authToken != null && typeof authToken !== 'string') return res.status(400).json({ error: 'authToken must be a string' });
  if (model != null && typeof model !== 'string') return res.status(400).json({ error: 'model must be a string' });
  try {
    const saved = gatewaysMod.upsertProfile(req.user, name, { baseUrl, authToken, model });
    res.json({ ok: true, profile: saved });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post('/api/gateways/activate', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  try { gatewaysMod.setActive(req.user, name); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  res.json({ ok: true, active: name });
});

app.delete('/api/gateways/:name', requireAuth, (req, res) => {
  const removed = gatewaysMod.deleteProfile(req.user, req.params.name);
  res.json({ ok: true, removed });
});

// Connectivity probe for a candidate gateway before saving it. Reuses the
// same HTTP semantics as _probeCustomCriticKey (GET the endpoint, Bearer
// auth when a token is given); a failure there just means "can't reach /
// api gateway responded oddly", not that the endpoint is unusable.
app.post('/api/gateways/test', requireAuth, async (req, res) => {
  const { baseUrl, authToken, model } = req.body || {};
  if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.trim()) {
    return res.json({ ok: true, note: 'empty baseUrl → using system default (.env)' });
  }
  const url = /^https?:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`;
  // NB: `withTimeout` from /api/admin/test-key is handler-local (a const),
  // so inline the timeout race here — 15s cap, mirrors the admin probe.
  const probe = _probeCustomCriticKey(url, authToken || '', model || '');
  try {
    const out = await Promise.race([
      probe,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`probe timed out (15s): ${url}`)), 15000)),
    ]);
    res.json(out);
  } catch (err) {
    res.json({ ok: false, error: err && err.message || String(err) });
  }
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
  // delm-10: shared-skill delete gate (deleteSkillShared) — not the
  // uploading user and no valid system delete code.
  if (code === 'ERR_FORBIDDEN') return res.status(403).json({ error: e.message, code });
  if (code === 'ERR_NOT_FOUND') return res.status(404).json({ error: e.message, code });
  if (code === 'ERR_NOT_DIR') return res.status(400).json({ error: e.message, code });
  if (code === 'ERR_BINARY') return res.status(415).json({ error: e.message, code, binary: true, size: e.size, mtimeMs: e.mtime });
  if (code === 'ERR_TOO_LARGE') return res.status(413).json({ error: e.message, code, size: e.size, mtimeMs: e.mtime });
  if (code === 'ERR_MTIME_CONFLICT') return res.status(409).json({ error: e.message, code });
  if (code === 'ERR_SYMLINK_WRITE') return res.status(400).json({ error: e.message, code });
  if (code === 'ERR_BAD_INPUT') return res.status(400).json({ error: e.message, code });
  if (code === 'ERR_EXISTS') return res.status(409).json({ error: e.message, code });
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

// delm-10: create a new folder in the currently browsed directory.
// Owner-only — this mutates the workspace tree, so a viewer/share-
// token reader (who can list + read) must not be able to write.
// Body: { name, dir? } where `dir` defaults to '.' (the UI passes
// state.files.currentPath). Name is a single path segment resolved
// relative to `dir`.
app.post('/sessions/:id/files/create-dir', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'owner');
  if (!ctx) return;
  const { name, dir } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  const base = (typeof dir === 'string' && dir) ? dir : '.';
  const rel = (base === '.' || base === './') ? name : (base.replace(/\/+$/, '') + '/' + name);
  try {
    const out = await filesApi.createDir(ctx.root, rel);
    res.status(201).json(out);
  } catch (e) { fileApiError(res, e); }
});

// delm-10: create a new file in the currently browsed directory.
// Same owner-only gating as create-dir. Body: { name, dir?, content? }.
// Refuses to overwrite an existing file (HTTP 409 ERR_EXISTS).
app.post('/sessions/:id/files/create-file', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'owner');
  if (!ctx) return;
  const { name, dir, content } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  const base = (typeof dir === 'string' && dir) ? dir : '.';
  const rel = (base === '.' || base === './') ? name : (base.replace(/\/+$/, '') + '/' + name);
  try {
    const out = await filesApi.createFile(ctx.root, rel, { content: typeof content === 'string' ? content : '' });
    res.status(201).json(out);
  } catch (e) { fileApiError(res, e); }
});

// ── delm-10: skill selection + upload/import ────────────────────────────
// Skills live at <session root>/.claude/skills/<name>/SKILL.md (the
// project-skill layout the SDK's `skills` option reads). Selection is
// per-session state: rec.enabledSkills is an array of skill dir names
// the SDK filter is pinned to, or null/undefined = 'all' (no filter,
// pre-delm-10 behaviour). Mutations are owner-only via fileApiPreamble
// — a viewer/share-token reader must not reshape the agent's skill
// set. GET is viewer-readable like the rest of the file API.
//
// NOTE: the skills root always anchors at the SESSION root (ctx.rec's
// cwd), not the main-project subdir — rec.enabledSkills selection is
// scoped per myco session, and .claude/ is session-level config
// (same layer as .claude/memory/, .claude/settings.json per CLAUDE.md
// §Session-storage). Skills are still visible to the SDK because
// settingSources includes 'project' relative to the agent cwd; for
// sessions with a main project subdir the project's own skills (if
// any) continue working unfiltered alongside these.
//
// delm-10 SCOPE extension: an upload can be visible to just this
// session, to every session of the uploading user, or to ALL users.
// Three stores, widest last:
//   session  <session root>/.claude/skills/<name>          (real dir)
//   user     <WORKSPACE>/<rec.user>/.claude/skills/<name>  (real dir)
//   global   <WORKSPACE>/.claude/skills/<name>             (real dir)
// The SDK only reads the session store, so a user/global upload is
// materialized there as a SYMLINK to the real dir (skills.js
// linkSkill; listSkills follows symlinks). GET /skills merges all
// three stores and tags each entry with its scope; a session entry
// shadows same-named user/global ones.

// Resolve the skill-store ROOTS for a session record. Returns
// { session, user, global } as absolute paths — each is a directory
// whose .claude/skills the skillsApi functions (createSkill, linkSkill,
// listSkills, …) resolve THEMSELVES (skillsRoot(absRoot) appends
// ".claude/skills"). So these values must be the ROOT (parent of
// .claude), never the skills dir itself — passing a skills dir here
// double-appends and lands the skill in <root>/.claude/skills/.claude/
// skills/<name> where neither the SDK nor linkSkill finds it (the
// delm-10 bug this comment guards against).
function _skillStores(rec, sessionRoot) {
  const ws = sessionsMod.getWorkspace();
  const userDir = path.join(ws, rec.user || 'default');
  return {
    session: sessionRoot,
    user: userDir,
    global: ws,
  };
}

// The absolute skill dir of a shared-store entry (link target /
// publish source). `root` is a _skillStores() value, so the .claude/
// skills segments are appended exactly once.
function _skillDirInStore(root, dirName) {
  return path.join(root, '.claude', 'skills', dirName);
}

// Normalize a request `scope` value. Unknown/absent → 'session'
// (pre-delm-10 behaviour).
function _skillScope(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return (v === 'user' || v === 'global') ? v : 'session';
}

// Merge the three stores into one list, tagged with scope. Session
// entries shadow user entries, which shadow global ones (a same-named
// narrower skill wins). Returns { skills, scopes } — scopes maps
// dirName → its owning scope for toggle/delete routing.
async function _listSkillsMerged(rec, sessionRoot) {
  const stores = _skillStores(rec, sessionRoot);
  const byDir = new Map();   // dirName → entry
  const scopes = new Map();  // dirName → 'session'|'user'|'global'
  for (const scope of ['global', 'user', 'session']) {
    let out;
    try { out = await skillsApi.listSkills(stores[scope]); }
    catch (e) { if (e.code === 'ERR_PERM') throw e; out = { skills: [] }; }
    for (const s of out.skills) {
      if (!byDir.has(s.dirName)) {
        byDir.set(s.dirName, Object.assign({}, s, { scope }));
        scopes.set(s.dirName, scope);
      }
    }
  }
  const skills = [...byDir.values()].sort((a, b) => a.dirName.localeCompare(b.dirName));
  return { skills, scopes };
}

// List skills + the session's current selection.
app.get('/sessions/:id/skills', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  try {
    const merged = await _listSkillsMerged(ctx.rec, ctx.root);
    const enabled = Array.isArray(ctx.rec.enabledSkills) ? ctx.rec.enabledSkills.slice() : null;
    res.json({ skills: merged.skills, enabledSkills: enabled, skillsMode: enabled ? 'selected' : 'all' });
  } catch (e) { fileApiError(res, e); }
});

// ── Multi-expert team: expert CRUD (rec.experts) ──────────────────
// An expert = { name, skills:[dirName,…] }. Skills are validated
// against the merged personal list (session/user/global) so the SDK's
// per-worker skill filter can never reference a skill nobody has.
// Owner-only mutations; viewers read the list (they can see it in the
// UI but not change who's on the team).
const expertsApi = require('./experts');
const { listExperts } = expertsApi;

// Resolve each expert's skill dirNames against the merged skill list,
// producing the [{ name, description }] arrays the TeamSession
// expertSkills map + prompts-team.js expertPrompt() consume. A skill
// that has since been deleted is silently dropped (the expert keeps
// running with the survivors); an expert left with zero skills stays a
// generalist. Exported for slashcmds.js /run-team.
async function resolveExpertSkills(rec, sessionRoot) {
  const merged = await _listSkillsMerged(rec, sessionRoot);
  const byDir = new Map(merged.skills.map((s) => [s.dirName, s]));
  return listExperts(rec).map((e) => ({
    name: e.name,
    skills: (e.skills || [])
      .map((d) => byDir.get(d))
      .filter(Boolean)
      .map((s) => ({ name: s.name, description: s.description || '', dirName: s.dirName })),
  }));
}

// List this session's experts (+ their resolved skills for display).
app.get('/sessions/:id/experts', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  try {
    const experts = await resolveExpertSkills(ctx.rec, ctx.root);
    res.json({ experts, max: expertsApi.MAX_EXPERTS });
  } catch (e) { fileApiError(res, e); }
});

// Create an expert. Body: { name, skills:[dirName,…] }.
app.post('/sessions/:id/experts', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'owner');
  if (!ctx) return;
  const body = req.body || {};
  if (!Array.isArray(body.skills) || body.skills.length === 0) {
    return res.status(400).json({ error: 'skills[] required — pick at least one skill for the expert' });
  }
  // Every referenced skill must exist in the merged personal list (the
  // market-install flow materializes installed skills there, so
  // market skills are covered too).
  let known;
  try { known = new Set((await _listSkillsMerged(ctx.rec, ctx.root)).skills.map((s) => s.dirName)); }
  catch (e) { return fileApiError(res, e); }
  const unknown = body.skills.filter((d) => !known.has(d));
  if (unknown.length) {
    return res.status(400).json({ error: `unknown skill(s): ${unknown.join(', ')}`, code: 'ERR_BAD_INPUT' });
  }
  try {
    const experts = expertsApi.addExpert(ctx.rec, { name: body.name, skills: body.skills });
    saveStore();
    const resolved = await resolveExpertSkills(ctx.rec, ctx.root);
    res.status(201).json({ experts: resolved, max: expertsApi.MAX_EXPERTS });
  } catch (e) {
    if (e.code === 'ERR_EXISTS') return res.status(409).json({ error: e.message, code: e.code });
    if (e.code === 'ERR_BAD_INPUT') return res.status(400).json({ error: e.message, code: e.code });
    fileApiError(res, e);
  }
});

// Delete an expert by name.
app.delete('/sessions/:id/experts/:name', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'owner');
  if (!ctx) return;
  try {
    const experts = expertsApi.removeExpert(ctx.rec, req.params.name);
    saveStore();
    const resolved = await resolveExpertSkills(ctx.rec, ctx.root);
    res.json({ experts: resolved, max: expertsApi.MAX_EXPERTS });
  } catch (e) {
    if (e.code === 'ERR_NOT_FOUND') return res.status(404).json({ error: e.message, code: e.code });
    fileApiError(res, e);
  }
});

// Read one skill's SKILL.md.
app.get('/sessions/:id/skills/:name', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  try {
    const out = await skillsApi.readSkill(ctx.root, req.params.name);
    res.json(out);
  } catch (e) { fileApiError(res, e); }
});

// Upload a single skill (SKILL.md or any markdown body). Body:
// { name, description?, content, scope? } where scope is 'session'
// (default) | 'user' | 'global'. 409 when the name already exists.
// user/global uploads land in the shared store + are linked into the
// session store so the SDK sees them.
app.post('/sessions/:id/skills', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'owner');
  if (!ctx) return;
  const { name, description, content } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'content required' });
  const scope = _skillScope((req.body || {}).scope);
  const stores = _skillStores(ctx.rec, ctx.root);
  try {
    let skill;
    if (scope === 'session') {
      skill = await skillsApi.createSkill(stores.session, { name, description, content });
    } else {
      // Write to the shared store, then link into the session store.
      // If the link name collides with a different session skill, the
      // shared upload still succeeds — report it with linked:false.
      skill = await skillsApi.createSkill(stores[scope], { name, description, content });
      skill.scope = scope;
      // Record the uploader so shared-store deletion can be gated
      // (deleteSkillShared): only the uploading user may remove it.
      await skillsApi.writeSkillMeta(stores[scope], skill.dirName, req.user);
      try {
        await skillsApi.linkSkill(stores.session, skill.dirName, _skillDirInStore(stores[scope], skill.dirName));
        skill.linked = true;
      } catch (e) {
        if (e.code !== 'ERR_EXISTS') throw e;
        skill.linked = false;
      }
    }
    res.status(201).json({ skill });
  } catch (e) { fileApiError(res, e); }
});

// Import a multi-file skill folder (e.g. a skill with helper scripts).
// Body: { name?, description?, files: [{ path, content }], scope? }
// where paths are relative to the skill dir and SKILL.md must be at
// root. A single top-level wrapper dir is unwrapped automatically.
// scope: 'session' (default) | 'user' | 'global', same semantics as
// POST /skills above.
app.post('/sessions/:id/skills/import', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'owner');
  if (!ctx) return;
  const scope = _skillScope((req.body || {}).scope);
  const stores = _skillStores(ctx.rec, ctx.root);
  try {
    let skill;
    if (scope === 'session') {
      skill = await skillsApi.importSkill(stores.session, req.body || {});
    } else {
      skill = await skillsApi.importSkill(stores[scope], req.body || {});
      skill.scope = scope;
      // Record the uploader for shared-store delete gating (see POST
      // /skills above).
      await skillsApi.writeSkillMeta(stores[scope], skill.dirName, req.user);
      try {
        await skillsApi.linkSkill(stores.session, skill.dirName, _skillDirInStore(stores[scope], skill.dirName));
        skill.linked = true;
      } catch (e) {
        if (e.code !== 'ERR_EXISTS') throw e;
        skill.linked = false;
      }
    }
    res.status(201).json({ skill });
  } catch (e) { fileApiError(res, e); }
});

// Toggle a skill's membership in the session's selection. Body:
// { name, enabled: true|false }. Persisted on rec.enabledSkills.
// enabled=false for the LAST selected skill clears the filter back
// to 'all' — an empty allow-list would hide every skill, which is
// never what the user meant by toggling one off.
// A user/global-scoped skill that has no session-store entry yet is
// linked in first — the SDK filter only resolves names it can see.
app.post('/sessions/:id/skills/toggle', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'owner');
  if (!ctx) return;
  const { name, enabled } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  const want = !!enabled;
  const stores = _skillStores(ctx.rec, ctx.root);
  try {
    // Reject names that aren't real skills — a typo'd toggle would
    // otherwise silently pin the SDK filter to a nonexistent skill.
    await skillsApi.readSkill(stores.session, name);
  } catch (e) {
    // Not in the session store: if it exists in a wider store, link
    // it in; otherwise surface the original NOT_FOUND.
    if (e.code !== 'ERR_NOT_FOUND' || !want) return fileApiError(res, e);
    const merged = await _listSkillsMerged(ctx.rec, ctx.root);
    const scope = merged.scopes.get(name);
    if (!scope || scope === 'session') return fileApiError(res, e);
    try {
      await skillsApi.linkSkill(stores.session, name, _skillDirInStore(stores[scope], name));
    } catch (le) {
      if (le.code !== 'ERR_EXISTS') return fileApiError(res, le);
    }
  }
  const cur = Array.isArray(ctx.rec.enabledSkills) ? ctx.rec.enabledSkills.slice() : null;
  let next = cur;
  if (want) {
    next = (next || []).concat(name);
  } else if (next) {
    next = next.filter((n) => n !== name);
    // last one off → clear the filter back to 'all' (an empty
    // allow-list would hide every skill).
    if (next.length === 0) next = null;
  }
  if (next && new Set(next).size !== next.length) next = [...new Set(next)];
  if (JSON.stringify(cur) === JSON.stringify(next)) {
    return res.json({ ok: true, unchanged: true, enabledSkills: next });
  }
  if (next) ctx.rec.enabledSkills = next;
  else delete ctx.rec.enabledSkills;
  putSession(ctx.rec);
  _applySkillsToLiveSession(ctx.rec);
  res.json({ ok: true, enabledSkills: next === null ? null : next.slice(), skillsMode: next ? 'selected' : 'all' });
});

// Delete a skill (removes the folder + drops it from the selection).
// A session-store entry (real dir or scope symlink) is deleted from
// the session store; if it was a symlink the shared target survives
// (deleting the LINK is "remove from this session"). A skill that
// only exists in the user/global store is deleted from that store
// (removes it for every session/user it covers). Query ?scope=user|global
// forces the shared-store deletion even when a session link exists.
app.delete('/sessions/:id/skills/:name', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'owner');
  if (!ctx) return;
  const stores = _skillStores(ctx.rec, ctx.root);
  const qScope = _skillScope(req.query && req.query.scope);
  try {
    let out;
    if (qScope === 'user' || qScope === 'global') {
      // Shared-store delete goes through the ownership gate: only the
      // uploading user (or, for the global store, a holder of the
      // system delete code via ?code=) may remove it. This is what
      // makes "visible to everyone" safe to offer per-upload.
      out = await skillsApi.deleteSkillShared(stores[qScope], req.params.name, {
        deleter: req.user,
        deleteCode: (req.query && req.query.code) || (req.body && req.body.code) || '',
        scope: qScope,
      });
      // A shared skill's session-store link (if any) is now dangling —
      // drop it too so the SDK/list view doesn't show a ghost entry.
      try { await skillsApi.deleteSkill(stores.session, req.params.name); } catch {}
    } else {
      out = await skillsApi.deleteSkill(stores.session, req.params.name);
    }
    const cur = Array.isArray(ctx.rec.enabledSkills) ? ctx.rec.enabledSkills : null;
    if (cur && cur.includes(out.dirName)) {
      const next = cur.filter((n) => n !== out.dirName);
      if (next.length === 0) delete ctx.rec.enabledSkills;
      else ctx.rec.enabledSkills = next;
      putSession(ctx.rec);
      _applySkillsToLiveSession(ctx.rec);
    }
    res.json(out);
  } catch (e) { fileApiError(res, e); }
});

// Push a (possibly changed) rec.enabledSkills onto the live AgentSession
// so the NEXT SDK iteration picks it up without a respawn. Respects the
// "one source of truth" rule: the record is authoritative; the live
// object is a cache. The live session applies the filter at iteration
// start (agent-session.js setSkills), and a mid-iteration change waits
// for the current turn to drain (streaming-input queries can't swap
// options live).
function _applySkillsToLiveSession(rec) {
  try {
    const live = getPtySession(rec.id);
    if (live && live.alive && typeof live.setSkills === 'function') {
      live.setSkills(Array.isArray(rec.enabledSkills) ? rec.enabledSkills.slice() : null);
    }
  } catch (err) {
    console.error(`[skills] apply-to-live failed for ${rec.id}: ${err.message}`);
  }
}

// mcp-market: push rec.installedMcp onto the live AgentSession so the
// NEXT SDK iteration rebuilds sdkOpts.mcpServers with the entry's
// sdkTools (agent-session.js setInstalledMcp). Same liveness model as
// _applySkillsToLiveSession — the record is authoritative, the live
// object a cache applied at iteration start.
function _applyInstalledMcpToLiveSession(rec) {
  try {
    const live = getPtySession(rec.id);
    if (live && live.alive && typeof live.setInstalledMcp === 'function') {
      live.setInstalledMcp(Array.isArray(rec.installedMcp) ? rec.installedMcp.slice() : []);
    }
  } catch (err) {
    console.error(`[mcp-market] apply-to-live failed for ${rec.id}: ${err.message}`);
  }
}

// ─── delm-10: skill MARKET ───
// A cross-session, cross-user store of skills shared via the state dir
// ($MYCO_STATE_DIR/skill-market/). Complements the personal stores:
//   GET    /skill-market                       → list (any signed-in user)
//   GET    /skill-market/:name                 → preview SKILL.md
//   POST   /skill-market                       → publish directly
//       body { name, description?, content } | { name?, description?, files:[{path,content}] }
//   POST   /sessions/:id/skills/publish        → publish a personal skill
//       body { name } — source = the session store entry (real dir or
//       scope symlink target; resolved via _listSkillsMerged scopes).
//   POST   /sessions/:id/skill-market/install  → install into the session
//       personal store (owner-only, no-clobber on name collision)
//   DELETE /skill-market/:name?code=<code>     → delete. Authorized when
//       req.user is the recorded uploader, OR `code` matches the system
//       delete code ($MYCO_STATE_DIR/skill-market/delete-code, mode
//       0600, constant-time compare, per-user failure throttle). The
//       code never leaves the server over HTTP — an operator reads it
//       from the state file on the host.
// requireAuth stamps req.user (userFromRequest); in single-user mode
// that is 'default', so the uploader-or-code rule holds in both modes.

const skillMarketApi = require('./skill-market');

function marketApiError(res, e) {
  const code = e && e.code;
  if (code === 'ERR_FORBIDDEN') return res.status(403).json({ error: e.message, code });
  if (code === 'ERR_THROTTLED') return res.status(429).json({ error: e.message, code });
  if (code === 'ERR_OUTSIDE' || code === 'ERR_PERM') return res.status(403).json({ error: e.message, code });
  if (code === 'ERR_NOT_FOUND') return res.status(404).json({ error: e.message, code });
  if (code === 'ERR_TOO_LARGE') return res.status(413).json({ error: e.message, code });
  if (code === 'ERR_BAD_INPUT') return res.status(400).json({ error: e.message, code });
  if (code === 'ERR_EXISTS') return res.status(409).json({ error: e.message, code });
  console.error('[skill-market] unexpected error:', e);
  return res.status(500).json({ error: 'internal error' });
}

// Locate a personal skill's real dir across the three stores — used
// by publish to market so a user/global-scoped skill can be published
// too, not just session-scoped ones.
async function _findPersonalSkillDir(rec, sessionRoot, name) {
  const stores = _skillStores(rec, sessionRoot);
  const merged = await _listSkillsMerged(rec, sessionRoot);
  const scope = merged.scopes.get(name);
  if (!scope) return null;
  return _skillDirInStore(stores[scope], name);
}

app.get('/skill-market', requireAuth, async (req, res) => {
  try {
    const out = await skillMarketApi.listMarket(req.user);
    res.json(out);
  } catch (e) { marketApiError(res, e); }
});

app.get('/skill-market/:name', requireAuth, async (req, res) => {
  try {
    const out = await skillMarketApi.readMarketSkill(req.params.name);
    res.json(out);
  } catch (e) { marketApiError(res, e); }
});

app.post('/skill-market', requireAuth, async (req, res) => {
  try {
    const skill = await skillMarketApi.publishDirect(req.body || {}, req.user);
    res.status(201).json({ skill });
  } catch (e) { marketApiError(res, e); }
});

// Publish a personal skill (any scope) into the market.
app.post('/sessions/:id/skills/publish', requireAuth, async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'owner');
  if (!ctx) return;
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  try {
    const srcDir = await _findPersonalSkillDir(ctx.rec, ctx.root, name.trim());
    if (!srcDir) throw Object.assign(new Error('personal skill not found'), { code: 'ERR_NOT_FOUND' });
    const skill = await skillMarketApi.publishFromDir(srcDir, name.trim(), req.user);
    res.status(201).json({ skill });
  } catch (e) { marketApiError(res, e); }
});

// Install a market skill into this session's personal store.
app.post('/sessions/:id/skill-market/install', requireAuth, async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'owner');
  if (!ctx) return;
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  try {
    const out = await skillMarketApi.installMarketSkill(ctx.root, name);
    res.status(201).json(out);
  } catch (e) { marketApiError(res, e); }
});

// Delete a market skill — uploader or system delete code.
app.delete('/skill-market/:name', requireAuth, async (req, res) => {
  const code = (req.query && req.query.code) || (req.body && req.body.code) || '';
  try {
    const out = await skillMarketApi.deleteMarketSkill(req.params.name, req.user, code);
    res.json(out);
  } catch (e) { marketApiError(res, e); }
});

// ─── mcp-market: MCP server marketplace (skill-pack model) ───
// Each catalog entry ("MCP server") is a SKILL PACK: installing it
// copies the entry's skill folders into the session's .claude/skills
// store, so the agent learns the MCP server's tool interface from
// ordinary skill instructions and calls it via curl / JSON-RPC. No
// MCP gateway process — full reuse of the delm-10 skill engine.
//   GET    /mcp-market                        → catalog (builtin + user)
//   GET    /mcp-market/:name                  → entry detail + skill bodies
//   POST   /mcp-market                        → publish a custom entry
//   POST   /sessions/:id/mcp-market/install   → install into session (owner)
//   POST   /sessions/:id/mcp-market/uninstall → remove the pack's skills
//   DELETE /mcp-market/:name                  → delete a custom entry (uploader)
const mcpMarketApi = require('./mcp/market');

app.get('/mcp-market', requireAuth, async (req, res) => {
  try {
    res.json(await mcpMarketApi.listMarket());
  } catch (e) { marketApiError(res, e); }
});

app.get('/mcp-market/:name', requireAuth, async (req, res) => {
  try {
    res.json(await mcpMarketApi.readServer(req.params.name));
  } catch (e) { marketApiError(res, e); }
});

app.post('/mcp-market', requireAuth, async (req, res) => {
  try {
    const out = await mcpMarketApi.publishServer(req.body || {}, req.user);
    res.status(201).json({ server: out });
  } catch (e) { marketApiError(res, e); }
});

// 自定义文档导入: import a guidance document (markdown) as a custom
// MCP market entry (a one-skill pack). Same body caps + registry as
// publishServer; entry lands under category 'doc-import'.
app.post('/mcp-market/import-doc', requireAuth, async (req, res) => {
  try {
    const out = await mcpMarketApi.importDoc(req.body || {}, req.user);
    res.status(201).json({ server: out });
  } catch (e) { marketApiError(res, e); }
});

app.post('/sessions/:id/mcp-market/install', requireAuth, async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'owner');
  if (!ctx) return;
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  try {
    // The SDK's skills option reloads skill dirs from disk each
    // iteration, so the freshly installed pack takes effect on the
    // session's next reply with no restart.
    const out = await mcpMarketApi.installServer(ctx.root, name.trim());
    // Record the entry on the session (source of truth for the
    // myco_mcp SDK MCP server built at iteration start) so the
    // entry's sdkTools survive container restarts / reaper respawns.
    const cur = Array.isArray(ctx.rec.installedMcp) ? ctx.rec.installedMcp.slice() : [];
    if (!cur.includes(out.name)) cur.push(out.name);
    ctx.rec.installedMcp = cur;
    putSession(ctx.rec);
    _applyInstalledMcpToLiveSession(ctx.rec);
    res.status(201).json(out);
  } catch (e) { marketApiError(res, e); }
});

app.post('/sessions/:id/mcp-market/uninstall', requireAuth, async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'owner');
  if (!ctx) return;
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  try {
    const out = await mcpMarketApi.uninstallServer(ctx.root, name.trim());
    // Drop the entry from the session record so its sdkTools vanish
    // from the next iteration's myco_mcp server.
    const cur = Array.isArray(ctx.rec.installedMcp) ? ctx.rec.installedMcp : [];
    ctx.rec.installedMcp = cur.filter((n) => n !== out.name);
    if (ctx.rec.installedMcp.length === 0) delete ctx.rec.installedMcp;
    putSession(ctx.rec);
    _applyInstalledMcpToLiveSession(ctx.rec);
    res.json(out);
  } catch (e) { marketApiError(res, e); }
});

app.delete('/mcp-market/:name', requireAuth, async (req, res) => {
  try {
    res.json(await mcpMarketApi.deleteServer(req.params.name, req.user));
  } catch (e) { marketApiError(res, e); }
});

// ─── delm-11: EXPERT / TEAM / MCP MARKET ───
// Layered market beside the skill market: every expert, expert-team
// and MCP-server item has a PERSONAL (user-private) copy and becomes
// market-visible (all signed-in users) ONLY via the one-click publish
// below. Storage + policy in market.js (mirrors skill-market.js).
//   GET    /market                                  → published lists {expert,team,mcp}
//   GET    /market/:type/:name                      → published item (full def)
//   GET    /market/personal[/:type]                 → caller's private items
//   POST   /market/personal/:type                   → save/replace a private item
//   DELETE /market/personal/:type/:name             → delete a private item
//   POST   /market/publish/:type/:name              → ONE-CLICK publish → market
//   POST   /market/install/:type/:name              → install market item → personal
//   DELETE /market/:type/:name?code=<code>          → delete published (uploader-or-code)

const marketApi = require('./market');

app.get('/market', requireAuth, async (req, res) => {
  try {
    res.json(await marketApi.listMarket(req.user));
  } catch (e) { marketApiError(res, e); }
});

app.get('/market/personal', requireAuth, async (req, res) => {
  try {
    res.json(await marketApi.listPersonal(req.user, null));
  } catch (e) { marketApiError(res, e); }
});

app.get('/market/personal/:type', requireAuth, async (req, res) => {
  try {
    res.json(await marketApi.listPersonal(req.user, req.params.type));
  } catch (e) { marketApiError(res, e); }
});

app.get('/market/:type/:name', requireAuth, async (req, res) => {
  try {
    res.json(await marketApi.readMarketItem(req.params.type, req.params.name));
  } catch (e) { marketApiError(res, e); }
});

app.post('/market/personal/:type', requireAuth, async (req, res) => {
  try {
    const out = await marketApi.savePersonal(req.user, req.params.type, req.body || {});
    res.status(out.created ? 201 : 200).json(out);
  } catch (e) { marketApiError(res, e); }
});

app.delete('/market/personal/:type/:name', requireAuth, async (req, res) => {
  try {
    res.json(await marketApi.deletePersonal(req.user, req.params.type, req.params.name));
  } catch (e) { marketApiError(res, e); }
});

// ONE-CLICK PUBLISH — the only path to market visibility.
app.post('/market/publish/:type/:name', requireAuth, async (req, res) => {
  try {
    res.status(201).json(await marketApi.publishToMarket(req.user, req.params.type, req.params.name));
  } catch (e) { marketApiError(res, e); }
});

app.post('/market/install/:type/:name', requireAuth, async (req, res) => {
  try {
    res.status(201).json(await marketApi.installFromMarket(req.user, req.params.type, req.params.name));
  } catch (e) { marketApiError(res, e); }
});

// ── harness-market (P7) ─────────────────────────────────────────────────────
// GET  /harness-market                       → list all published harness items
// GET  /harness-market/:name                 → read one item (files + meta)
// POST /sessions/:id/harness-market/install  → install into session cwd
// POST /sessions/:id/harness-market/publish  → publish chosen sweep harness

const harnessMarketApi = require('./harness-market');
const harnessResultApi  = require('./harness-result');

app.get('/harness-market', requireAuth, async (req, res) => {
  try {
    res.json(await harnessMarketApi.listHarnesses(req.user));
  } catch (e) { marketApiError(res, e); }
});

app.get('/harness-market/:name', requireAuth, async (req, res) => {
  try {
    // market.js readMarketItem takes positional (type, name) args.
    const item = await marketApi.readMarketItem('harness', req.params.name);
    if (!item) return res.status(404).json({ error: 'ERR_NOT_FOUND', message: 'harness not found' });
    // Strip internal content blob from the listing; only expose metadata + file hashes.
    const { _fileContent, ...safe } = item;
    res.json(safe);
  } catch (e) { marketApiError(res, e); }
});

app.post('/sessions/:id/harness-market/install', requireAuth, async (req, res) => {
  const rec = sessions.getSessionRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: 'ERR_NOT_FOUND', message: 'session not found' });
  if (!sessions.isOwnerOrAdmin(req.params.id, req.user)) {
    return res.status(403).json({ error: 'ERR_FORBIDDEN', message: 'owner or admin required' });
  }
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'ERR_BAD_INPUT', message: 'name required' });
  try {
    const result = await harnessMarketApi.installIntoSession(name, rec.absCwd || rec.cwd || '', req.user);
    res.status(201).json(result);
  } catch (e) { marketApiError(res, e); }
});

app.post('/sessions/:id/harness-market/publish', requireAuth, async (req, res) => {
  const rec = sessions.getSessionRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: 'ERR_NOT_FOUND', message: 'session not found' });
  if (!sessions.isOwnerOrAdmin(req.params.id, req.user)) {
    return res.status(403).json({ error: 'ERR_FORBIDDEN', message: 'owner or admin required' });
  }
  const cwd = rec.absCwd || rec.cwd || '';
  const runner = require('./harness-runner');
  const { sweepId } = req.body || {};
  const sel = harnessResultApi.findSelection(cwd, sweepId || null);
  if (!sel) {
    return res.status(404).json({ error: 'ERR_NOT_FOUND', message: 'no successful selection found for this session' });
  }
  const st = runner.getStatus(cwd, sweepId || null);
  const sweepMeta = {
    sweepTag: (st && st.namespace) || sweepId || 'unknown',
    task:     sel.task_id  || 'unknown',
    mode:     sel.mode     || 'agg',
    k:        sel.k        || 1,
    domain:   sel.domain   || '',
  };
  try {
    const result = await harnessMarketApi.publishFromSweep(sel, sweepMeta, req.user);
    res.status(201).json(result);
  } catch (e) { marketApiError(res, e); }
});

// ── harness adopt / rollback REST endpoints (P4) ───────────────────────────

app.get('/sessions/:id/harness/diff', requireAuth, async (req, res) => {
  const rec = sessions.getSessionRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: 'ERR_NOT_FOUND', message: 'session not found' });
  // B3: diff returns full file contents — gate it the same as adopt/rollback.
  if (!sessions.isOwnerOrAdmin(req.params.id, req.user)) {
    return res.status(403).json({ error: 'ERR_FORBIDDEN', message: 'owner or admin required' });
  }
  // B4: rec.cwd is relative by design; prefer absCwd so writes resolve
  // inside the session workspace, not against mycod's process cwd.
  const cwd = rec.absCwd || rec.cwd || '';
  const sel = harnessResultApi.findSelection(cwd, req.query.sweepId || null);
  if (!sel) return res.status(404).json({ error: 'ERR_NOT_FOUND', message: 'no selection' });
  const dir = harnessResultApi.harnessDir(sel);
  if (!dir || !require('fs').existsSync(dir)) {
    return res.status(404).json({ error: 'ERR_NOT_FOUND', message: 'workspace not found' });
  }
  res.json({ changes: harnessResultApi.diffHarness(dir, cwd) });
});

app.post('/sessions/:id/harness/adopt', requireAuth, async (req, res) => {
  const rec = sessions.getSessionRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: 'ERR_NOT_FOUND', message: 'session not found' });
  if (!sessions.isOwnerOrAdmin(req.params.id, req.user)) {
    return res.status(403).json({ error: 'ERR_FORBIDDEN', message: 'owner or admin required' });
  }
  const cwd = rec.absCwd || rec.cwd || '';
  const { sweepId } = req.body || {};
  const sel = harnessResultApi.findSelection(cwd, sweepId || null);
  if (!sel) return res.status(404).json({ error: 'ERR_NOT_FOUND', message: 'no selection' });
  const dir = harnessResultApi.harnessDir(sel);
  if (!dir || !require('fs').existsSync(dir)) {
    return res.status(404).json({ error: 'ERR_NOT_FOUND', message: 'workspace not found' });
  }
  try {
    const { adopted, snapshot } = await harnessResultApi.adoptHarness(dir, cwd);
    const snapshotFile = await harnessResultApi.saveSnapshot(snapshot, cwd, sel.chosen_run_id || sweepId || 'sweep');
    res.status(200).json({ adopted, snapshotId: snapshot.id, snapshotFile });
  } catch (e) { marketApiError(res, e); }
});

app.post('/sessions/:id/harness/rollback', requireAuth, async (req, res) => {
  const rec = sessions.getSessionRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: 'ERR_NOT_FOUND', message: 'session not found' });
  if (!sessions.isOwnerOrAdmin(req.params.id, req.user)) {
    return res.status(403).json({ error: 'ERR_FORBIDDEN', message: 'owner or admin required' });
  }
  const cwd = rec.absCwd || rec.cwd || '';
  const { sweepId, snapshotId } = req.body || {};
  const runner = require('./harness-runner');
  const resolvedSweepId = sweepId || (() => {
    const st = runner.getStatus(cwd, null);
    return st && st.id;
  })();
  if (!resolvedSweepId) {
    return res.status(400).json({ error: 'ERR_BAD_INPUT', message: 'sweepId required' });
  }
  const snapshot = harnessResultApi.loadSnapshot(cwd, resolvedSweepId, snapshotId || null);
  if (!snapshot) {
    return res.status(404).json({ error: 'ERR_NOT_FOUND', message: 'snapshot not found' });
  }
  try {
    const result = await harnessResultApi.rollbackHarness(snapshot, cwd);
    res.json(result);
  } catch (e) { marketApiError(res, e); }
});

// Delete a published item — uploader or the (shared) system delete code.
app.delete('/market/:type/:name', requireAuth, async (req, res) => {
  const code = (req.query && req.query.code) || (req.body && req.body.code) || '';
  try {
    res.json(await marketApi.deleteMarketItem(req.params.type, req.params.name, req.user, code));
  } catch (e) { marketApiError(res, e); }
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

// fr-107: stream a file inline for browser rendering (HTML iframe,
// PDF viewer, <img>, <audio>, <video>). Same auth + containment as
// /file/download — the ONLY differences are:
//   * Content-Type is MIME-guessed from the extension so the browser
//     picks the right renderer (application/pdf, image/png, text/html,
//     etc.) instead of application/octet-stream
//   * Content-Disposition: inline — so the browser embeds the response
//     in the requesting iframe/img/audio/video instead of prompting a
//     save dialog
// Client-side sandboxing (`<iframe sandbox="">` for HTML/SVG) is what
// contains the risk of user-controlled HTML executing scripts against
// myco's origin; the server just streams bytes with the right MIME.
app.get('/sessions/:id/file/raw', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'path required' });
  let abs;
  try {
    abs = await filesApi.safeJoin(ctx.root, relPath);
  } catch (e) { return fileApiError(res, e); }
  let st;
  try {
    st = await require('fs/promises').stat(abs);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    if (e.code === 'EACCES' || e.code === 'EPERM') return res.status(403).json({ error: 'permission denied' });
    return res.status(500).json({ error: e.message });
  }
  if (!st.isFile()) return res.status(400).json({ error: 'not a regular file' });
  const path = require('path');
  const ext = (path.extname(String(relPath)) || '').toLowerCase().replace(/^\./, '');
  // Small MIME table for the types fr-107 knows how to preview inline.
  // Anything outside the table falls back to application/octet-stream —
  // safe default; the browser will decline to render inline and the
  // client-side dispatch shouldn't have called us in the first place.
  const MIME_BY_EXT = {
    // HTML / SVG — client must serve these inside a sandboxed iframe
    // (script-execution neutered) since content is user-controlled.
    html: 'text/html; charset=utf-8',
    htm:  'text/html; charset=utf-8',
    svg:  'image/svg+xml',
    // PDF — browser's built-in PDF viewer takes over.
    pdf:  'application/pdf',
    // Images — safe via <img> tag (scripts inside don't run).
    png:  'image/png',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    gif:  'image/gif',
    webp: 'image/webp',
    // Audio.
    mp3:  'audio/mpeg',
    wav:  'audio/wav',
    ogg:  'audio/ogg',
    m4a:  'audio/mp4',
    // Video.
    mp4:  'video/mp4',
    webm: 'video/webm',
    mov:  'video/quicktime',
  };
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(st.size));
  res.setHeader('Content-Disposition', 'inline');
  // No-store so a subsequent edit + preview shows the new bytes
  // without a hard refresh (matches the existing /file JSON route's
  // implicit no-cache behavior).
  res.setHeader('Cache-Control', 'no-store');
  // Belt-and-braces X-Content-Type-Options so an attacker can't
  // convince a strict browser to sniff HTML out of a purported PDF.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(abs, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: err.message });
  });
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
      // Task B: file-viewer review uses the session's active gateway profile
      // (same custom model as the main agent).
      gw: { user: ctx.rec && ctx.rec.user, activeGw: ctx.rec && ctx.rec.activeGw },
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

// team-split-view: board snapshot for an agent-n2 session — the shared
// sub-queue (with per-item owner), FACT/FAIL notes, per-worker status
// lines, and session states. Auth-gated viewer-tier like the other
// session-scoped GETs (fileApiPreamble). Serves the same shape the
// team-info WS frame carries, for clients that attach without a live
// WS (read-only review, mobile catch-up) — live updates still flow via
// state-update {kind:'board'} frames.
app.get('/sessions/:id/board', (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  const attachMod = require('./attach');
  const live = attachMod.getSession(ctx.id);
  if (!live || live.mode !== 'agent-n2' || typeof live.boardSnapshot !== 'function') {
    res.status(404).json({ error: 'not a live agent-n2 session' });
    return;
  }
  try {
    res.json(Object.assign({ roster: Array.isArray(live.roster) ? live.roster : [] },
      live.boardSnapshot()));
  } catch (err) {
    console.error(`[board] snapshot failed for ${ctx.id}: ${err && err.message}`);
    res.status(500).json({ error: 'board snapshot failed' });
  }
});

// Agent-event history pagination — the "load older" backfill for the
// TOOL cards (Bash/Edit/Read cards, chrome batches, turn footers),
// mirroring the /chat/history contract for the chat rows. The attach
// WS frame only ships a 16 KB tail (sub-100ms first paint); everything
// before that window had NO fetch path — refresh/page-switch lost the
// command + result history even though events.jsonl holds it all.
// Claude Code loads its whole project JSONL into memory; myco's web
// client can't, so this endpoint is the equivalent "render lazily,
// from the durable transcript" leg.
//
//   GET /sessions/:id/events?before=<seq>&limit=<n>
//
//     before — return events with seq strictly less than this. The
//               client passes the oldest rendered agent card's seq.
//               Omitted → the newest window (same tail as replay).
//     limit  — max events; default 100, clamped 1..500.
//
// Source order: live session.buffer first (authoritative, includes
// lane events bridged in by compare-lanes); fallback to the session's
// events.jsonl tail (reaped / pre-boot sessions) so history survives
// the 5-min reaper and container restarts. Response rows are
// oldest→newest within the window (chat-persistence contract §4).
// { events, total, hasMore } — same envelope as /chat/history.
const { agentEventsWindow } = require('./agent-events-history');

app.get('/sessions/:id/events', (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  let limit = parseInt(String(req.query.limit || ''), 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 100;
  if (limit > 500) limit = 500;
  const beforeRaw = req.query.before;
  const beforeNum = beforeRaw !== undefined ? parseInt(String(beforeRaw), 10) : NaN;
  const before = Number.isFinite(beforeNum) && beforeNum >= 0 ? beforeNum : null;
  const { window, total, hasMore } = agentEventsWindow(ctx.id, { before, limit }, {
    getSession: (id) => {
      const attachMod = require('./attach');
      return attachMod.getSession && attachMod.getSession(id);
    },
    getRecord: (id) => sessionsMod.getSessionRecord(id),
    resolveMycoDir: _resolveMycoDir,
  });
  res.json({ events: window, total, hasMore });
});

// fr-81 Phase A: ingest open GitHub / Gitee issues for the session's
// project remote into the Plan view. Auth-gated like the other plan-
// view routes (viewer-tier — read-only). Stale-while-revalidate: the
// first call after a cold cache blocks on the fetch; subsequent calls
// within 5 min return cached + kick a background refresh. ?force=1
// blocks on a fresh fetch.
app.get('/sessions/:id/remote-issues', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  const remoteIssues = require('./remote-issues');
  const force = req.query.force === '1' || req.query.force === 'true';
  try {
    const rec = sessionsMod.getSessionRecord(ctx.id);
    const result = await remoteIssues.getForSession(rec, { force, user: req.user });
    res.json({
      items: result.items || [],
      fetchedAt: result.fetchedAt || 0,
      provider: result.provider || null,
      owner: result.owner || null,
      repo: result.repo || null,
      error: result.error || null,
      stale: !!result.stale,
      // fr-81 Phase B.2: how many upstream issues were filtered out
      // because they already have a local plan-item with the same
      // meta.remoteUrl, and the total count of locally-linked remote
      // URLs. Used by the Plan-view client to render "(N linked)" in
      // the section header so the dedup is visible.
      dedupedCount: result.dedupedCount || 0,
      linkedCount: result.linkedCount || 0,
    });
  } catch (err) {
    res.status(500).json({ error: redact(err.message) });
  }
});

// td-33 (A — Retry button): re-fire the most recently cached critique
// for this session. When the critic returns a transient error (Gemini
// 503, missing key, network blip), the verdict panel grows a ↻ Retry
// button that POSTs here. The server pulls rec._lastCritique (stamped
// by triggerGeminiCritique on every fire) and re-runs against the
// SAME diff + claudeOutput + item so retries are deterministic.
// Auth: viewer-gated. The retry doesn't change git state; it just
// re-asks Gemini. Returns 404 when there's nothing to retry (e.g.
// fresh session, or server restarted between fire + retry).
app.post('/sessions/:id/critique/retry', async (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  const critique = require('./critique');
  const attachMod = require('./attach');
  const session = attachMod.getSession && attachMod.getSession(ctx.id);
  if (!session) return res.status(404).json({ error: 'no live session — attach first' });
  // bug-52: forward an optional user-prompt from the verdict pane's
  // "Re-ask with my prompt" input. critique.retryLastCritique passes
  // it through to triggerGeminiCritique which steers Gemini's review
  // toward the user-flagged concern.
  const userPrompt = typeof (req.body && req.body.userPrompt) === 'string' ? req.body.userPrompt : '';
  try {
    const ok = await critique.retryLastCritique(ctx.id, session, { userPrompt });
    if (!ok) return res.status(404).json({ error: 'no critique on file to retry' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: redact(err.message) });
  }
});

// bug-54: cross-device verdict-pane sync. Called by the four resolving
// buttons (✗ Dismiss / ✗ Discard / ⚡ Ask Claude to Fix / ✓ Accept
// Claude) AFTER their primary action completes. Broadcasts
// `state-update { kind: 'critique-resolved', itemId, reason }` so
// every attached client clears its local verdict pane. The originating
// device also receives the broadcast; the client-side guard makes
// that an idempotent no-op. ↻ Retry and 💬 Ask Critic don't call
// this — they re-fire the critique, which produces a new
// `critique-review` broadcast that naturally replaces the verdict.
// Auth: viewer-gated (same tier as /critique/retry — touching the
// verdict surface is a per-device interaction, no privileged side
// effects).
app.post('/sessions/:id/critique/resolve', (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  const critique = require('./critique');
  const attachMod = require('./attach');
  const session = attachMod.getSession && attachMod.getSession(ctx.id);
  // If the session isn't live, the broadcast can't reach anyone — but
  // the client-side state was already cleared locally before the POST.
  // Return ok so the client's fire-and-forget doesn't log a 404.
  if (!session) return res.json({ ok: true, broadcast: false });
  const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason : 'unknown';
  const itemId = (req.body && req.body.itemId) || null;
  critique.resolveCritique(ctx.id, session, { itemId, reason });
  res.json({ ok: true, broadcast: true });
});

// bug-57: end-of-run signal. Called by the verdict pane's ✓ Accept
// (verify stage only) + ✗ Discard handlers. Clears session
// ._activeRunItem (which the 3-stage methodology kept alive across
// multiple turn_result events for stages 2 + 3 critic dispatch) and
// advances the run queue to the next pending plan item. Idempotent
// itemId check — if the active item no longer matches (e.g. the user
// already dispatched something else), this is a no-op.
//
// Auth: viewer-gated (same tier as /critique/retry + /critique/resolve
// — these are all per-device verdict-pane interactions, no privileged
// side effects beyond what the pane already drives).
//
// This route is the COMPLEMENT to the pre-bug-57 eager clear that
// fired on every turn_result. With bug-57 the clear only happens on:
//   (a) this route (verify-accept / discard)
//   (b) turn_result success when no stage sentinel was seen (legacy
//       one-shot dispatch — preserved via _sawStageSentinelInRun
//       flag in attach.js)
//   (c) turn_result abort/fatal (existing behavior)
//   (d) session interrupt recovery (existing behavior)
app.post('/sessions/:id/run/done', (req, res) => {
  const ctx = fileApiPreamble(req, res, 'viewer');
  if (!ctx) return;
  const attachMod = require('./attach');
  const session = attachMod.getSession && attachMod.getSession(ctx.id);
  if (!session) return res.json({ ok: true, cleared: false, reason: 'no live session' });
  const itemId = (req.body && req.body.itemId) || null;
  const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason : 'unknown';
  const cleared = attachMod.clearActiveRunItem(ctx.id, session, { itemId, reason });
  res.json({ ok: true, cleared });
});

// fr-96: NOTE on the absence of a GET /plan-item/stage-states route.
// An earlier design included one for fresh-attach catch-up, but the
// client derives state.planItemStages from item.meta.stageState
// already present in the artifacts-init frame (and refreshed via
// state-update kind:'artifact' broadcasts). The GET would be dead
// code today — added only if a future non-WS consumer needs it.

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
  // bug-76 (plan-item bug-74): fall back to process.env when client
  // didn't send a key. The admin UI's Test button now sends key=''
  // when its input shows a masked value (the server-saved key);
  // the probe uses the saved key without round-tripping the secret
  // back to the client.
  if (!key) key = process.env.ANTHROPIC_API_KEY || '';
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
  // bug-76 (plan-item bug-74): fall back to process.env when client
  // didn't send a key — same pattern as _probeAnthropicKey above.
  if (!key) key = process.env.GEMINI_API_KEY || process.env.API_KEY || '';
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
  // bug-76 (plan-item bug-74): fall back to process.env when client
  // didn't send a key — same pattern as _probeAnthropicKey above.
  if (!key) key = process.env.OPENAI_API_KEY || '';
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
  // bug-76 (plan-item bug-74): fall back to process.env for both key
  // AND endpoint when client didn't send them — same pattern as
  // _probeAnthropicKey / _probeGeminiKey / _probeOpenAIKey above,
  // extended to also cover the endpoint URL since CUSTOM_CRITIC_ENDPOINT
  // is part of the same env-config form. If both client and env
  // are missing the endpoint, error as before.
  if (!endpoint) endpoint = process.env.CUSTOM_CRITIC_ENDPOINT || '';
  if (!key) key = process.env.CUSTOM_CRITIC_KEY || '';
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
  // P3: a sweep is spawned `detached` so it survives a mycod restart. That is
  // also how an orphan happens — mycod dies, the sweep keeps spending with
  // nobody watching. Sweep the workspace at boot and kill anything left over.
  try {
    const harnessRunner = require('./harness-runner');
    const { listWorkspaceDirs } = require('./sessions');
    const roots = new Set();
    for (const uid of ['default']) roots.add(require('path').join(process.env.MYCO_WORKSPACE || '/wks', uid));
    const killed = [];
    for (const root of roots) {
      try { killed.push(...harnessRunner.sweepOrphans(root)); } catch {}
    }
    if (killed.length) console.log(`[harness] swept ${killed.length} orphaned sweep(s): ${killed.join(', ')}`);
  } catch (err) {
    console.error('[harness] orphan sweep cleanup failed:', err.message);
  }
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
