// Auth state for myco.
//
// Identity comes from GitHub OAuth (see oauth.js + the /auth/github/* routes
// in index.js). After a successful login we mint a long-lived opaque session
// token (the "myco session") that the browser keeps in localStorage and sends
// back on every request as `Authorization: Bearer <tok>` or `?token=<tok>`
// (the WebSocket attach path). Sessions persist to disk so a server restart
// doesn't kick everyone out.
//
// Two on-disk files in $MYCO_STATE_DIR:
//   auth-sessions.json     mode 0600 — { "<tok>": { login, githubId, name, avatarUrl, expiresAt } }
//   allowed-github-users.txt           one GitHub login per line, '#' comments
//
// Auth is required as soon as MYCO_GH_CLIENT_ID is set. With no OAuth config
// the server still boots (useful for local dev) but `isAuthRequired()` is
// false so userFromRequest() returns 'default' to keep single-user flows alive.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_DIR = process.env.MYCO_STATE_DIR || path.join(require('os').homedir(), '.myco');
const SESSIONS_FILE = path.join(STATE_DIR, 'auth-sessions.json');
const ALLOWLIST_FILE = path.join(STATE_DIR, 'allowed-github-users.txt');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_RENEW_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // renew if <7d left

// In-memory cache of the on-disk session table. token -> { login, githubId, name, avatarUrl, expiresAt }
const AUTH_SESSIONS = new Map();
let _loaded = false;

function sanitize(user) {
  return String(user || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
}

function _ensureDir() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
}

function _loadFromDisk() {
  AUTH_SESSIONS.clear();
  let raw;
  try { raw = fs.readFileSync(SESSIONS_FILE, 'utf8'); } catch { return; }
  let obj;
  try { obj = JSON.parse(raw); } catch { return; }
  if (!obj || typeof obj !== 'object') return;
  const now = Date.now();
  for (const [tok, info] of Object.entries(obj)) {
    if (!info || !info.login) continue;
    if (info.expiresAt && info.expiresAt < now) continue;
    AUTH_SESSIONS.set(tok, info);
  }
}

function _persistToDisk() {
  _ensureDir();
  const out = {};
  const now = Date.now();
  for (const [tok, info] of AUTH_SESSIONS) {
    if (info.expiresAt && info.expiresAt < now) continue;
    out[tok] = info;
  }
  const tmp = SESSIONS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, SESSIONS_FILE);
  try { fs.chmodSync(SESSIONS_FILE, 0o600); } catch {}
}

function _ensureLoaded() {
  if (_loaded) return;
  _loaded = true;
  _loadFromDisk();
}

// True iff some auth gate is in play. Either of these enables the gate:
//   - MYCO_GH_CLIENT_ID is set (OAuth flow available)
//   - $STATE_DIR/allowed-github-users.txt exists (PAT login available; no
//     OAuth App registration needed)
//   - MYCO_TEST_OAUTH_BYPASS is set (test seam)
// When none of these are set we fall back to the open "single-user default"
// mode used in local dev — no login required.
function isAuthRequired() {
  if (process.env.MYCO_TEST_OAUTH_BYPASS) return true;
  if (process.env.MYCO_GH_CLIENT_ID) return true;
  try { return fs.existsSync(ALLOWLIST_FILE); } catch { return false; }
}

function userFromToken(tok) {
  if (!isAuthRequired()) return 'default';
  if (!tok) return null;
  _ensureLoaded();
  const info = AUTH_SESSIONS.get(tok);
  if (!info) return null;
  if (info.expiresAt && info.expiresAt < Date.now()) {
    AUTH_SESSIONS.delete(tok);
    try { _persistToDisk(); } catch {}
    return null;
  }
  // Sliding renewal: if the session is within the renewal window, push the
  // expiry out so active users don't get logged out mid-sprint.
  if (info.expiresAt && (info.expiresAt - Date.now()) < SESSION_RENEW_THRESHOLD_MS) {
    info.expiresAt = Date.now() + SESSION_TTL_MS;
    try { _persistToDisk(); } catch {}
  }
  return info.login;
}

function userFromRequest(req) {
  if (!isAuthRequired()) return 'default';
  const auth = req.headers.authorization || '';
  const headerTok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const queryTok = (req.query && req.query.token) || '';
  return userFromToken(headerTok || queryTok);
}

// Returns the full session profile (login + display fields) for a token,
// or null. Used by /auth/check to surface name/avatar to the client.
function profileFromToken(tok) {
  if (!isAuthRequired()) return { login: 'default' };
  if (!tok) return null;
  _ensureLoaded();
  const info = AUTH_SESSIONS.get(tok);
  if (!info) return null;
  if (info.expiresAt && info.expiresAt < Date.now()) return null;
  return { login: info.login, githubId: info.githubId, name: info.name, avatarUrl: info.avatarUrl };
}

// fr-26: lookup the most-recent session profile for a login. Returns
// { login, githubId, name } or null. Used by agent-session.js to seed
// GIT_AUTHOR_* / GIT_COMMITTER_* env from the session OWNER's identity
// without needing their token (the AgentSession doesn't carry it). We
// pick the entry with the latest expiresAt so a fresh login wins over
// a stale one.
function profileByLogin(login) {
  if (!login) return null;
  _ensureLoaded();
  const safe = sanitize(login);
  if (!safe) return null;
  let best = null;
  for (const info of AUTH_SESSIONS.values()) {
    if (!info || info.login !== safe) continue;
    if (info.expiresAt && info.expiresAt < Date.now()) continue;
    if (!best || (info.expiresAt || 0) > (best.expiresAt || 0)) best = info;
  }
  if (!best) return null;
  return { login: best.login, githubId: best.githubId, name: best.name };
}

// All GitHub logins that have ever logged in (deduped, sorted). Used by the
// chat input's `@`-mention autocomplete. Combined with the allowlist by
// /users in index.js so admins-listed-but-never-logged-in users still appear.
function listUsernames() {
  _ensureLoaded();
  const set = new Set();
  for (const info of AUTH_SESSIONS.values()) {
    if (info && info.login) set.add(info.login);
  }
  return Array.from(set).sort();
}

// Mint a new session token for `login`. Returns the opaque token string.
function mintSession(login, profile = {}) {
  _ensureLoaded();
  const safeLogin = sanitize(login);
  if (!safeLogin) throw new Error('mintSession: invalid login');
  const tok = crypto.randomBytes(32).toString('hex');
  AUTH_SESSIONS.set(tok, {
    login: safeLogin,
    githubId: profile.githubId || null,
    name: profile.name || null,
    avatarUrl: profile.avatarUrl || null,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  _persistToDisk();
  return tok;
}

// Drop a session token. Returns true if the token existed.
function revokeSession(tok) {
  if (!tok) return false;
  _ensureLoaded();
  const had = AUTH_SESSIONS.delete(tok);
  if (had) _persistToDisk();
  return had;
}

// ── allowlist ────────────────────────────────────────────────────────────────

// Read the allowlist fresh on every check — admins manage it via `deploy.sh
// --allow-github-user`, which appends to the file on the host. No process
// restart should be needed for additions to take effect.
function loadAllowlist() {
  let raw;
  try { raw = fs.readFileSync(ALLOWLIST_FILE, 'utf8'); }
  catch { return new Set(); }
  const out = new Set();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const safe = sanitize(trimmed);
    if (safe) out.add(safe);
  }
  return out;
}

function isAllowed(login) {
  const safe = sanitize(login);
  if (!safe) return false;
  return loadAllowlist().has(safe);
}

// ── share tokens ────────────────────────────────────────────────────────────
// Share tokens ARE the session ID — links like /?s=<sessionId> survive
// restarts and need no extra state on disk.

function createShareToken(sessionId, owner) {
  return { token: sessionId, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 };
}

function shareTokenInfo(tok) {
  if (!tok) return null;
  const sessionsMod = require('./sessions');
  const rec = sessionsMod.getSessionRecord(tok);
  if (!rec) return null;
  return { sessionId: tok, owner: rec.user || 'default' };
}

function revokeShareTokensForSession() {}

function addUserToAllowlist(login) {
  const safe = sanitize(login);
  if (!safe) return false;
  const current = loadAllowlist();
  if (current.has(safe)) return false;
  _ensureDir();
  let existing = '';
  try { existing = fs.readFileSync(ALLOWLIST_FILE, 'utf8'); } catch {}
  const separator = (existing && !existing.endsWith('\n')) ? '\n' : '';
  fs.appendFileSync(ALLOWLIST_FILE, `${separator}${safe}\n`);
  return true;
}

function removeUserFromAllowlist(login) {
  const safe = sanitize(login);
  if (!safe) return false;
  const current = loadAllowlist();
  if (!current.has(safe)) return false;
  current.delete(safe);
  _ensureDir();
  const lines = Array.from(current).join('\n') + '\n';
  fs.writeFileSync(ALLOWLIST_FILE, lines);
  return true;
}

// Eager-load on first require so route handlers see persisted sessions
// without waiting for a request.
_ensureLoaded();

module.exports = {
  isAuthRequired,
  userFromToken,
  userFromRequest,
  profileFromToken,
  profileByLogin,
  listUsernames,
  mintSession,
  revokeSession,
  loadAllowlist,
  isAllowed,
  createShareToken,
  shareTokenInfo,
  revokeShareTokensForSession,
  sanitize,
  addUserToAllowlist,
  removeUserFromAllowlist,
};
