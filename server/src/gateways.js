// Per-user model-gateway profile storage.
//
// On disk: $MYCO_STATE_DIR/gateways.json, mode 0600. Threat model matches
// git-tokens.json / auth-sessions.json (filesystem perms, no encryption).
//
// Shape:
//   {
//     "<myco-user>": {
//       "active": "<profile-name>",
//       "profiles": {
//         "<name>": { "baseUrl": "http://host:port", "authToken": "sk-…", "model": "DS-V4-0731" }
//       }
//     }
//   }
//
// Semantics:
//   - A user may save MULTIPLE named profiles and manually switch which one
//     is `active`. The active profile is injected into that user's agent SDK
//     calls (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL) on
//     the next turn — see agent-session.js `_ensureIteration`.
//   - Empty `baseUrl` means "use the system default" (state/.env). An empty
//     `authToken` is allowed too (some gateways need no auth).
//   - `authToken` is write-only: after save it is never read back as plaintext
//     (the list API returns `tokenSet: true/false` + a mask instead), and a
//     blank token on update means "keep the existing value".

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = process.env.MYCO_STATE_DIR || path.join(os.homedir(), '.myco');
const GATEWAYS_FILE = path.join(STATE_DIR, 'gateways.json');

// Profile names: keep them URL-safe + short so they work as UI keys and in
// DELETE route params without needing percent-encoding gymnastics.
const NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const MAX_PROFILES_PER_USER = 20;

let _cache = null;

function _load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(GATEWAYS_FILE, 'utf8'));
    if (!_cache || typeof _cache !== 'object') _cache = {};
  } catch {
    _cache = {};
  }
  return _cache;
}

function _persist() {
  if (!_cache) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = GATEWAYS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(_cache, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, GATEWAYS_FILE);
  try { fs.chmodSync(GATEWAYS_FILE, 0o600); } catch {}
}

function _userBucket(user) {
  if (!user) return null;
  const store = _load();
  if (!store[user] || typeof store[user] !== 'object') store[user] = { active: null, profiles: {} };
  const bucket = store[user];
  if (!bucket.profiles || typeof bucket.profiles !== 'object') bucket.profiles = {};
  return bucket;
}

// Public API for tests + routes. `_resetCache()` exists so tests can reload
// from a temp file.
function _resetCache() { _cache = null; }

// List a user's profiles for the UI. `authToken` is NEVER returned in
// plaintext — only `tokenSet` (bool) and a short `mask` for display.
function listProfiles(user) {
  const bucket = _userBucket(user);
  const out = { active: bucket.active || null, profiles: [] };
  for (const [name, p] of Object.entries(bucket.profiles)) {
    out.profiles.push({
      name,
      baseUrl: p.baseUrl || '',
      model: p.model || '',
      tokenSet: !!(p.authToken),
      mask: p.authToken ? `•••${String(p.authToken).slice(-4)}` : '',
    });
  }
  return out;
}

// The active profile object for a user, or null if none set. baseUrl empty →
// caller falls back to process.env. NOTE: this reflects the legacy per-user
// `active` pointer, which no longer drives the per-session flow — the
// session's own choice (rec.activeGw) is resolved via getProfile() below.
function getActive(user) {
  const bucket = _userBucket(user);
  const name = bucket.active;
  if (!name || !bucket.profiles[name]) return null;
  const p = bucket.profiles[name];
  return {
    name,
    baseUrl: p.baseUrl || '',
    authToken: p.authToken || '',
    model: p.model || '',
  };
}

// A named profile's raw record for the SDK overlay, independent of the
// per-user `active` pointer — returns null if the name isn't saved. This is
// what agent-session.js consumes per turn to resolve the PER-SESSION active
// gateway (rec.activeGw): a session only uses a profile the user explicitly
// opted into via `/model gw:<name>`. baseUrl empty → caller falls back to
// process.env (the system .env defaults).
function getProfile(user, name) {
  const bucket = _userBucket(user);
  if (!name || !bucket.profiles[name]) return null;
  const p = bucket.profiles[name];
  return {
    name,
    baseUrl: p.baseUrl || '',
    authToken: p.authToken || '',
    model: p.model || '',
  };
}

// Create/update a named profile. `authToken` empty keeps the existing token
// on update (write-only semantics). Returns the sanitised record for the UI.
function upsertProfile(user, name, { baseUrl, authToken, model } = {}) {
  if (!user) throw new Error('user required');
  if (!NAME_RE.test(name)) throw new Error('profile name must match ^[a-zA-Z0-9_-]{1,40}$');
  const bucket = _userBucket(user);
  if (!bucket.profiles[name] && Object.keys(bucket.profiles).length >= MAX_PROFILES_PER_USER) {
    throw new Error(`max ${MAX_PROFILES_PER_USER} profiles per user`);
  }
  const prev = bucket.profiles[name] || {};
  const next = {
    baseUrl: String(baseUrl || '').trim(),
    // Empty token on update → keep existing (write-only). On create that
    // means "no token".
    authToken: authToken ? String(authToken).trim() : (prev.authToken || ''),
    model: String(model || '').trim(),
  };
  if (next.baseUrl) {
    // Keep it a plausible absolute URL (/^https?:\/\//). Allow host:port too.
    next.baseUrl = /^https?:\/\//i.test(next.baseUrl) ? next.baseUrl : `http://${next.baseUrl}`;
  }
  bucket.profiles[name] = next;
  if (!bucket.active || !bucket.profiles[bucket.active]) bucket.active = name;
  _persist();
  return getActive(user) && bucket.profiles[name]
    ? { name, baseUrl: next.baseUrl, model: next.model, tokenSet: !!next.authToken, mask: next.authToken ? `•••${next.authToken.slice(-4)}` : '' }
    : { name, baseUrl: next.baseUrl, model: next.model, tokenSet: false, mask: '' };
}

// Set which profile is active. Returns the active name or null.
function setActive(user, name) {
  const bucket = _userBucket(user);
  if (!name || !bucket.profiles[name]) throw new Error(`no such profile: ${name}`);
  bucket.active = name;
  _persist();
  return name;
}

// Reset the active profile to the system default (active = null). Used by
// `/model gw:default` so a session can drop back to the .env gateway without
// deleting any saved profile.
function deactivate(user) {
  const bucket = _userBucket(user);
  if (bucket.active) {
    bucket.active = null;
    _persist();
  }
  return true;
}

// Delete a profile. If it was active, active reverts to null (next save
// auto-promotes). Returns true if a profile was removed.
function deleteProfile(user, name) {
  const bucket = _userBucket(user);
  if (!bucket.profiles[name]) return false;
  delete bucket.profiles[name];
  if (bucket.active === name) bucket.active = null;
  _persist();
  return true;
}

module.exports = {
  _resetCache,
  listProfiles,
  getActive,
  getProfile,
  upsertProfile,
  setActive,
  deactivate,
  deleteProfile,
};
