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

function getToken(user, provider, owner, repo, alias) {
  if (!user) return null;
  const p = _normalizeProvider(provider);
  if (!p) return null;
  const store = _load();
  const entry = store[user];
  if (!entry || typeof entry !== 'object') return null;
  if (owner && repo) {
    // fr-82: when the caller explicitly asks for an alias, look up
    // ONLY that alias's slot. No silent fallback to the default or
    // user-level token — if the user said "use the labxnow alias"
    // and that alias has no PAT stored, surfacing that as null lets
    // the caller report "no such alias" rather than quietly use a
    // different identity (the foot-gun an account switcher must
    // avoid).
    if (alias) {
      const aliasKey = `${p}/${owner}/${repo}#${alias}`;
      return entry[aliasKey] || null;
    }
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

function setRepoToken(user, provider, owner, repo, token, alias) {
  if (!user || !owner || !repo || !token) throw new Error('user, owner, repo, token all required');
  const p = _normalizeProvider(provider);
  if (!p) throw new Error(`unknown provider: ${provider}`);
  if (alias && !/^[a-z0-9_-]{1,32}$/i.test(alias)) {
    throw new Error('alias must match ^[a-z0-9_-]{1,32}$');
  }
  const store = _load();
  if (!store[user] || typeof store[user] !== 'object') store[user] = {};
  // fr-82: aliased PATs live at `<provider>/<owner>/<repo>#<alias>`.
  // Un-aliased default lives at `<provider>/<owner>/<repo>` (unchanged).
  // Both can coexist for the same target — caller picks via getToken's
  // optional alias param.
  const key = alias
    ? `${p}/${owner}/${repo}#${alias}`
    : `${p}/${owner}/${repo}`;
  store[user][key] = String(token).trim();
  _persist();
}

// fr-82: list aliases stored for (user, provider, owner, repo). Used
// by /listpat + by handleRemoteIssue's "no such alias" error so the
// user can see which aliases ARE available.
function listAliases(user, provider, owner, repo) {
  if (!user) return [];
  const p = _normalizeProvider(provider);
  if (!p) return [];
  const store = _load();
  const entry = store[user];
  if (!entry || typeof entry !== 'object') return [];
  const prefix = `${p}/${owner}/${repo}#`;
  const result = [];
  for (const key of Object.keys(entry)) {
    if (key.startsWith(prefix)) result.push(key.slice(prefix.length));
  }
  return result.sort();
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

// ── bug-91: gitee login storage ────────────────────────────────────────────
//
// Gitee's HTTPS auth requires the ACTUAL gitee account login as the
// credential username (github, by contrast, ignores the username and
// accepts the sentinel "x-access-token"). We store the operator's
// gitee login here so the credential helper (scripts/git-credential-
// myco.sh) can emit the right username per provider.
//
// Storage shape (non-breaking sidecar keys next to existing token keys):
//   store[user].giteeLogin                     - user-level default
//   store[user]["gitee/<owner>/<repo>.login"]  - per-repo override
//
// The `.login` suffix (NOT `#login`) sidesteps the fr-82 alias
// convention which uses `#` — a per-repo login of "login" would
// otherwise be ambiguous with an alias literally named "login".
//
// Lookup precedence in the helper:
//   per-repo login → user-level login → myco-user (best-effort default)
//
// listAllPats + listRepos + listAliases skip these keys so they don't
// pollute the PAT inventory. The `_isLoginKey` helper below is the
// single source of truth for "is this key a login field, not a token."

function _isLoginKey(key) {
  // Bare user-level login: exact string.
  if (key === 'giteeLogin' || key === 'githubLogin') return true;
  // Per-repo login: <provider>/<owner>/<repo>.login. The `.login`
  // suffix on a repo-shaped key is the marker.
  return /^(github|gitee)\/[^/]+\/.+\.login$/.test(key);
}

// Read the gitee login for a repo push. When (owner, repo) are supplied
// the per-repo override wins; otherwise the user-level login (or null).
// Callers that want the full "resolved for the helper" behavior should
// use the shell helper's own resolution chain, which additionally falls
// back to the myco-user — this getter deliberately does NOT fall back
// there so callers can distinguish "explicitly set" from "derived".
function getGiteeLogin(user, owner, repo) {
  if (!user) return null;
  const store = _load();
  const entry = store[user];
  if (!entry || typeof entry !== 'object') return null;
  if (owner && repo) {
    const perRepoKey = `gitee/${owner}/${repo}.login`;
    if (typeof entry[perRepoKey] === 'string' && entry[perRepoKey]) {
      return entry[perRepoKey];
    }
  }
  if (typeof entry.giteeLogin === 'string' && entry.giteeLogin) {
    return entry.giteeLogin;
  }
  return null;
}

// Set the user-level gitee login (persists as store[user].giteeLogin).
// Empty / whitespace login → delete the slot (lets an operator clear
// it and fall back to myco-user).
function setGiteeLogin(user, login) {
  if (!user) throw new Error('user required');
  const trimmed = String(login || '').trim();
  const store = _load();
  if (!store[user] || typeof store[user] !== 'object') store[user] = {};
  if (!trimmed) {
    delete store[user].giteeLogin;
  } else {
    store[user].giteeLogin = trimmed;
  }
  _persist();
}

// Set a per-repo gitee login (persists as store[user]["gitee/<owner>/<repo>.login"]).
// Empty → delete the slot. Owner + repo are required. Provider is
// always "gitee" — github doesn't need a per-repo login (it uses the
// sentinel "x-access-token" username unconditionally).
function setGiteeRepoLogin(user, owner, repo, login) {
  if (!user || !owner || !repo) throw new Error('user, owner, repo all required');
  const trimmed = String(login || '').trim();
  const key = `gitee/${owner}/${repo}.login`;
  const store = _load();
  if (!store[user] || typeof store[user] !== 'object') store[user] = {};
  if (!trimmed) {
    delete store[user][key];
  } else {
    store[user][key] = trimmed;
  }
  _persist();
}

// ── Inspect ─────────────────────────────────────────────────────────────────

// fr-87: Config page helpers. The web Config modal calls listAllPats
// to render the inventory and removeRepoToken / removeUserToken when
// the user clicks Delete on a row. NEVER returns raw token values —
// only metadata (present:bool + last4) per the never-leak-the-secret
// invariant. The PUT routes in index.js still call the existing
// setUserToken / setRepoToken setters; only delete + safe-list are
// new helpers.

// Mask a raw token to metadata-only form: { present:true, last4 }.
// Defensive null returns for falsy / non-string input so route handlers
// can pass through getter results without branching.
function _maskToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  return { present: true, last4: s.slice(-4) };
}

// Returns the full PAT inventory for `user` in safe (masked) form.
// Shape:
//   { userLevel: { github: meta|null, gitee: meta|null },
//     perRepo:   [{ provider, owner, repo, alias, last4 }, ...] }
// fr-82: aliased entries surface with their alias field set; un-aliased
// entries have alias: null. The key regex correctly splits
// "github/owner/repo#alias" so the repo field stays as "repo".
function listAllPats(user) {
  if (!user) return { userLevel: { github: null, gitee: null }, perRepo: [] };
  const store = _load();
  const entry = store[user];
  if (!entry || typeof entry !== 'object') {
    return { userLevel: { github: null, gitee: null }, perRepo: [] };
  }
  const out = {
    userLevel: {
      github: _maskToken(entry.github),
      gitee:  _maskToken(entry.gitee),
    },
    perRepo: [],
  };
  for (const key of Object.keys(entry)) {
    // Skip the user-level slots themselves; only collect repo-shaped keys.
    if (key === 'github' || key === 'gitee') continue;
    // bug-91: skip gitee-login sidecar keys (user-level + per-repo).
    if (_isLoginKey(key)) continue;
    const m = key.match(/^([a-z]+)\/([^/]+)\/(.+?)(?:#(.+))?$/);
    if (!m) continue;
    const provider = _normalizeProvider(m[1]);
    if (!provider) continue;
    out.perRepo.push({
      provider,
      owner: m[2],
      repo:  m[3],
      alias: m[4] || null,
      last4: _maskToken(entry[key]).last4,
    });
  }
  out.perRepo.sort((a, b) =>
    (a.provider + '/' + a.owner + '/' + a.repo + (a.alias ? '#' + a.alias : ''))
      .localeCompare(b.provider + '/' + b.owner + '/' + b.repo + (b.alias ? '#' + b.alias : '')));
  return out;
}

// Delete the user-level OAuth-fallback PAT for `(user, provider)`.
// Idempotent: returns false if no such slot exists; never throws.
function removeUserToken(user, provider) {
  if (!user) return false;
  const p = _normalizeProvider(provider);
  if (!p) return false;
  const store = _load();
  const entry = store[user];
  if (!entry || typeof entry !== 'object') return false;
  if (!(p in entry)) return false;
  delete entry[p];
  _persist();
  return true;
}

// Delete the per-repo PAT slot for `(user, provider, owner, repo,
// alias?)`. Idempotent; never throws. Sibling aliased entries on the
// same repo are preserved.
function removeRepoToken(user, provider, owner, repo, alias) {
  if (!user || !owner || !repo) return false;
  const p = _normalizeProvider(provider);
  if (!p) return false;
  const key = alias
    ? `${p}/${owner}/${repo}#${alias}`
    : `${p}/${owner}/${repo}`;
  const store = _load();
  const entry = store[user];
  if (!entry || typeof entry !== 'object') return false;
  if (!(key in entry)) return false;
  delete entry[key];
  _persist();
  return true;
}

// Returns all repos `user` has per-repo PATs for. Useful for a future
// "show my tokens" UI; not used by handleIssue.
function listRepos(user) {
  if (!user) return [];
  const store = _load();
  const entry = store[user];
  if (!entry || typeof entry !== 'object') return [];
  const out = [];
  for (const key of Object.keys(entry)) {
    // bug-91: skip gitee-login sidecar keys (they are repo-shaped
    // but hold a login string, not a token).
    if (_isLoginKey(key)) continue;
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
  listAliases,                 // fr-82
  // fr-87: Config page helpers — safe inventory + idempotent delete.
  listAllPats,
  removeRepoToken,
  removeUserToken,
  // bug-91: gitee-login storage. The credential helper reads from
  // these; slash commands write to them.
  getGiteeLogin,
  setGiteeLogin,
  setGiteeRepoLogin,
  KNOWN_PROVIDERS,
  _resetCacheForTest,
  _tokensFile: () => TOKENS_FILE,
  _legacyTokensFile: () => LEGACY_GH_TOKENS_FILE,
  // bug-91: exposed for unit-testing the sidecar-key predicate.
  _isLoginKey,
};
