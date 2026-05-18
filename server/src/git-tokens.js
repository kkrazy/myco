// Per-(user, repo) Git-host token storage.
//
// On disk: $MYCO_STATE_DIR/git-tokens.json, mode 0600. Threat model
// matches auth-sessions.json (filesystem perms, no encryption).
//
// Shape:
//   {
//     "<myco-user>": {
//       "<provider>":                "<user-level-token>",       // optional; OAuth-issued, fallback for any repo on that provider
//       "<provider>/<owner>/<repo>": "<per-repo-PAT>"            // primary slot — set via /setpat
//     }
//   }
//
// Why this shape:
//   - The user-facing rule is "one PAT per repo" (per td-4 design).
//     Keys with a slash hold the per-repo PAT.
//   - The GitHub OAuth login flow mints a single user-level access_token
//     before any session is attached, so it has no repo context. We store
//     it at the bare provider key (no slash) and treat it as a FALLBACK
//     when no per-repo PAT exists. This keeps the OAuth UX working
//     without forcing /setpat on every github repo.
//   - At lookup time the per-repo PAT wins; the user-level fallback only
//     fires if there's no per-repo entry. So at most ONE token is in
//     effect per repo at any moment, which honors the "one PAT per repo"
//     constraint semantically.
//
// Back-compat: the pre-td-4 layout was gh-tokens.json {user: token} —
// flat per-user GitHub token. We migrate it on first load into
//   {user: {github: token}}
// (i.e. user-level fallback under the bare 'github' key).

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = process.env.MYCO_STATE_DIR || path.join(os.homedir(), '.myco');
const TOKENS_FILE = path.join(STATE_DIR, 'git-tokens.json');
const LEGACY_GH_TOKENS_FILE = path.join(STATE_DIR, 'gh-tokens.json');

const KNOWN_PROVIDERS = new Set(['github', 'gitee']);

let _cache = null;

function _migrateFromLegacyIfPresent() {
  // Only run if the new file doesn't exist yet.
  try { fs.accessSync(TOKENS_FILE, fs.constants.F_OK); return null; }
  catch {}
  let raw;
  try { raw = fs.readFileSync(LEGACY_GH_TOKENS_FILE, 'utf8'); } catch { return null; }
  let flat;
  try { flat = JSON.parse(raw); } catch { return null; }
  if (!flat || typeof flat !== 'object') return null;
  const migrated = {};
  for (const [user, token] of Object.entries(flat)) {
    if (!user || typeof token !== 'string' || !token) continue;
    // Legacy tokens were user-level GitHub OAuth tokens — land them at
    // the bare 'github' key as the fallback for any github repo.
    migrated[user] = { github: token };
  }
  return migrated;
}

function _load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    if (!_cache || typeof _cache !== 'object') _cache = {};
  } catch {
    _cache = _migrateFromLegacyIfPresent() || {};
    if (Object.keys(_cache).length > 0) {
      try { _persist(); } catch {}
    }
  }
  return _cache;
}

function _persist() {
  if (!_cache) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = TOKENS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(_cache, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, TOKENS_FILE);
  try { fs.chmodSync(TOKENS_FILE, 0o600); } catch {}
}

function _normalizeProvider(provider) {
  const p = String(provider || '').toLowerCase();
  return KNOWN_PROVIDERS.has(p) ? p : null;
}

// ── Lookup ──────────────────────────────────────────────────────────────────
//
// getToken(user, provider, owner, repo)  → per-repo first, then user-level
// getToken(user, provider)               → user-level only (for OAuth flows)
//
// Returns null if no token found. The (owner, repo) variant is the normal
// path called from /feature, /bug — it picks up the per-repo override if
// the user has set one, otherwise falls back to their OAuth-issued
// user-level token (github only; gitee has no OAuth, so no fallback).

function getToken(user, provider, owner, repo) {
  if (!user) return null;
  const p = _normalizeProvider(provider);
  if (!p) return null;
  const store = _load();
  const entry = store[user];
  if (!entry || typeof entry !== 'object') return null;
  if (owner && repo) {
    const repoKey = `${p}/${owner}/${repo}`;
    if (entry[repoKey]) return entry[repoKey];
  }
  return entry[p] || null;
}

// ── Setters ─────────────────────────────────────────────────────────────────
//
// setRepoToken(user, provider, owner, repo, token)  → per-repo (PRIMARY API)
// setUserToken(user, provider, token)               → user-level (OAuth/back-compat)
//
// Per-repo is what /setpat hits. User-level is what the OAuth callback
// + the legacy github.setToken shim hit.

function setRepoToken(user, provider, owner, repo, token) {
  if (!user || !owner || !repo || !token) throw new Error('user, owner, repo, token all required');
  const p = _normalizeProvider(provider);
  if (!p) throw new Error(`unknown provider: ${provider}`);
  const store = _load();
  if (!store[user] || typeof store[user] !== 'object') store[user] = {};
  store[user][`${p}/${owner}/${repo}`] = String(token).trim();
  _persist();
}

function setUserToken(user, provider, token) {
  if (!user || !token) throw new Error('user and token required');
  const p = _normalizeProvider(provider);
  if (!p) throw new Error(`unknown provider: ${provider}`);
  const store = _load();
  if (!store[user] || typeof store[user] !== 'object') store[user] = {};
  store[user][p] = String(token).trim();
  _persist();
}

// ── Inspect ─────────────────────────────────────────────────────────────────

// Returns all repos `user` has per-repo PATs for. Useful for a future
// "show my tokens" UI; not used by handleIssue.
function listRepos(user) {
  if (!user) return [];
  const store = _load();
  const entry = store[user];
  if (!entry || typeof entry !== 'object') return [];
  const out = [];
  for (const key of Object.keys(entry)) {
    const m = key.match(/^([a-z]+)\/([^/]+)\/(.+)$/);
    if (!m) continue;
    const provider = _normalizeProvider(m[1]);
    if (!provider) continue;
    out.push({ provider, owner: m[2], repo: m[3] });
  }
  return out;
}

// Test-only: drop the in-memory cache so tests can re-exercise the load
// path after writing the file directly.
function _resetCacheForTest() { _cache = null; }

module.exports = {
  getToken,
  setRepoToken,
  setUserToken,
  listRepos,
  KNOWN_PROVIDERS,
  _resetCacheForTest,
  _tokensFile: () => TOKENS_FILE,
  _legacyTokensFile: () => LEGACY_GH_TOKENS_FILE,
};
