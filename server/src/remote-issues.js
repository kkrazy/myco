// fr-81 Phase A: cache layer + session-aware fetcher for remote
// GitHub / Gitee issues displayed alongside local plan.json items
// in the Plan view.
//
// Two layers:
//   · In-memory cache, keyed by sessionId. 5-min TTL.
//   · Stale-while-revalidate semantics: getForSession returns the
//     cached snapshot immediately when present (even if stale) and
//     kicks off an async refresh in the background. The next call
//     gets the fresh result. This keeps the Plan view paint fast.
//
// We deliberately do NOT persist the issue list to /data/sessions.json
// — issues come back identical from upstream on every fetch (we don't
// learn anything by storing them), and they'd bloat the registry. The
// cache lives in memory and warms back up on the first attach after
// a server restart.
//
// Token resolution: defers to gitTokens (per-repo PAT > user-level
// OAuth). If no token is on file we skip the fetch and return an
// empty list with `error: 'no-token'` so the client can show a
// "Sign in / /setpat" hint.
//
// Phase B (deferred per the fr-81 dispatch's run-summary):
//   · Dedup vs local plan items that were promoted to remote via
//     /feature or /bug — needs a promotion model first (today
//     /feature does not stamp meta.remoteUrl on a local item).
//   · Close-detection mirror — when a remote issue closes upstream,
//     mark the matched local item done.
//   · Write-back: Plan-view close → also close the remote issue.

const gitHosts = require('./git-hosts');
const { resolveMycoDir, findProjectRoot } = require('./artifacts');
const path = require('path');
// fr-81 Phase B.3: close-detection mirror needs to mutate + persist
// rec.artifacts.plan + broadcast a state-update. Lazy-require to
// avoid a sessions⇄remote-issues circular at module-load time.
let _sessionsMod = null;
function _sessions() {
  if (!_sessionsMod) _sessionsMod = require('./sessions');
  return _sessionsMod;
}

// 5-minute TTL — long enough that opening a session ~immediately
// after a plan tab refresh re-uses the cache; short enough that a
// new issue filed upstream shows up within "feels live" UX.
const CACHE_TTL_MS = 5 * 60 * 1000;

// Hard cap on items returned per session. Defensive — a 50k-issue
// monorepo could otherwise OOM the chat pane. The Plan view paginates
// at this ceiling.
const MAX_ITEMS_PER_SESSION = 500;

// sessionId → { fetchedAt: ms, items: [...], provider, owner, repo,
//               error: string|null, refreshing: bool }
const _cache = new Map();

function _now() { return Date.now(); }

function _readEntry(sessionId) {
  return _cache.get(sessionId) || null;
}

function _writeEntry(sessionId, entry) {
  _cache.set(sessionId, entry);
}

function isStale(entry) {
  if (!entry || !entry.fetchedAt) return true;
  return (_now() - entry.fetchedAt) >= CACHE_TTL_MS;
}

// Resolve the project's git root from the session record so detectHost
// reads the correct `git remote get-url origin`. After fr-94, the
// project may live at <absCwd>/<rec.mainProject>/ — findProjectRoot
// returns that path. Falls back to absCwd if no mainProject is set.
function _projectRootForRec(rec) {
  if (!rec) return null;
  try {
    const root = findProjectRoot(rec);
    if (root) return root;
  } catch {}
  return rec.absCwd || null;
}

// Look up the token for (user, provider, owner, repo) via the same
// path /feature + /bug use. Returns the token string or null.
function _resolveToken({ user, provider, owner, repo }) {
  try {
    const t = gitHosts.getToken({ user, provider, owner, repo });
    return (t && typeof t === 'string') ? t : null;
  } catch { return null; }
}

// Returns the current cache entry (may be stale). When stale or
// missing, kicks off an async refresh. Callers get back what's
// cached immediately + can re-fetch in a few seconds to see the
// fresh result. `force=true` skips the cache and waits for the fresh
// fetch.
async function getForSession(rec, { force = false, user = null } = {}) {
  if (!rec || !rec.id) return { items: [], error: 'no-session', fetchedAt: 0, stale: true };
  const sessionId = rec.id;
  const cached = _readEntry(sessionId);
  if (!force && cached && !isStale(cached)) {
    return { ...cached, stale: false };
  }
  if (force) {
    // Caller wants a fresh fetch — block on it.
    return await _refreshNow(rec, { user });
  }
  // Stale-while-revalidate: return cached (if any), kick a background
  // refresh. Skip if a refresh is already in flight to avoid
  // duplicate API calls.
  if (cached && !cached.refreshing) {
    cached.refreshing = true;
    _writeEntry(sessionId, cached);
    setImmediate(() => {
      _refreshNow(rec, { user }).catch(() => {});
    });
    return { ...cached, stale: true };
  }
  if (cached) return { ...cached, stale: true };
  // Cold cache: block on the first fetch.
  return await _refreshNow(rec, { user });
}

async function _refreshNow(rec, { user }) {
  const sessionId = rec.id;
  const projectRoot = _projectRootForRec(rec);
  if (!projectRoot) {
    const entry = { fetchedAt: _now(), items: [], provider: null, owner: null, repo: null, error: 'no-project-root', refreshing: false };
    _writeEntry(sessionId, entry);
    return { ...entry, stale: false };
  }
  let host;
  try { host = await gitHosts.detectHost(projectRoot); }
  catch { host = null; }
  if (!host) {
    const entry = { fetchedAt: _now(), items: [], provider: null, owner: null, repo: null, error: 'no-remote', refreshing: false };
    _writeEntry(sessionId, entry);
    return { ...entry, stale: false };
  }
  const { provider, owner, repo } = host;
  const token = _resolveToken({ user: user || rec.user, provider, owner, repo });
  if (!token) {
    const entry = { fetchedAt: _now(), items: [], provider, owner, repo, error: 'no-token', refreshing: false };
    _writeEntry(sessionId, entry);
    return { ...entry, stale: false };
  }
  let result;
  try {
    result = await gitHosts.fetchIssues({ provider, token, owner, repo, state: 'open' });
  } catch (err) {
    const entry = { fetchedAt: _now(), items: [], provider, owner, repo, error: `fetch-threw: ${err.message}`, refreshing: false };
    _writeEntry(sessionId, entry);
    return { ...entry, stale: false };
  }
  const items = Array.isArray(result.items) ? result.items.slice(0, MAX_ITEMS_PER_SESSION) : [];
  // Filter out PR rows from GitHub's /issues response so the Plan view
  // shows only true issues. (Gitee already returns issues-only.)
  const issuesOnly = items.filter((it) => !it.isPullRequest);
  // fr-81 Phase B.2: dedup vs the local plan. After Phase B.1's auto-
  // promote, every /feature + /fr @target also writes a local plan
  // item carrying meta.remoteUrl=<the issue URL>. Here we use that
  // anchor to filter out remote rows that already have a local
  // representation — without this, the Plan view would show the same
  // issue twice (once as a local plan-item, once in the Remote
  // section below). dedupedCount is surfaced on the response so the
  // client can log it / show a "(N linked)" hint without re-deriving
  // the math.
  const linkedUrls = _collectLinkedRemoteUrls(rec);
  const deduped = linkedUrls.size > 0
    ? issuesOnly.filter((it) => !linkedUrls.has(it.htmlUrl))
    : issuesOnly;
  // fr-81 Phase B.3: close-detection mirror. If any local plan items
  // are linked to remote URLs (via Phase B.1's meta.remoteUrl) AND
  // those upstream issues have since been closed, flip the local
  // items to done. Best-effort: a closed-fetch failure logs but
  // doesn't break the open-issues render path above.
  let mirroredClosedCount = 0;
  if (linkedUrls.size > 0) {
    try {
      mirroredClosedCount = await _mirrorClosedRemoteIssues({
        sessionId, rec, provider, token, owner, repo,
      });
    } catch (err) {
      console.error(`[fr-81 Phase B.3] close-mirror failed for ${sessionId}: ${err.message}`);
    }
  }
  const entry = {
    fetchedAt: _now(),
    items: deduped,
    provider, owner, repo,
    error: result.error || null,
    status: result.status,
    refreshing: false,
    dedupedCount: issuesOnly.length - deduped.length,
    linkedCount: linkedUrls.size,
    mirroredClosedCount,
  };
  _writeEntry(sessionId, entry);
  return { ...entry, stale: false };
}

// fr-81 Phase B.3: fetch CLOSED upstream issues for (provider, owner,
// repo). For each closed issue whose htmlUrl matches a local plan
// item's meta.remoteUrl AND the local item isn't already done, mark
// the local item done + stamp meta.closedRemotely + closedRemotelyAt.
// Persist + broadcast a state-update so attached chat panes refresh
// the Plan view.
//
// Why a SEPARATE fetch from the open one: gitHosts.fetchIssues takes
// `state` as a single value (we use 'open' or 'closed'). Doing two
// fetches per refresh is cheap relative to the 5-min cache TTL and
// keeps the code paths clean (open list pagination vs. closed
// scanning have different semantics — closed can be MUCH larger
// historically; we cap at the same MAX_ITEMS for safety but a
// future optimisation could narrow the closed scan to a `since:`
// timestamp from the most recent refresh).
async function _mirrorClosedRemoteIssues({ sessionId, rec, provider, token, owner, repo }) {
  let closedResult;
  try {
    closedResult = await gitHosts.fetchIssues({ provider, token, owner, repo, state: 'closed' });
  } catch {
    return 0;
  }
  if (!closedResult || !Array.isArray(closedResult.items)) return 0;
  // Build URL → closed-issue map for O(1) lookup.
  const closedByUrl = new Map();
  for (const it of closedResult.items) {
    if (it && it.htmlUrl) closedByUrl.set(it.htmlUrl, it);
  }
  if (closedByUrl.size === 0) return 0;
  // Mirror in-place. The plan-item mutation is safe because Node is
  // single-threaded and saveStore + state-update emit happen
  // synchronously after this function returns.
  let mirrored = 0;
  const items = (rec.artifacts && rec.artifacts.plan && Array.isArray(rec.artifacts.plan.items))
    ? rec.artifacts.plan.items : [];
  for (const localItem of items) {
    const url = localItem && localItem.meta && localItem.meta.remoteUrl;
    if (!url) continue;
    if (localItem.done) continue;
    const closed = closedByUrl.get(url);
    if (!closed) continue;
    localItem.done = true;
    if (!localItem.meta) localItem.meta = {};
    localItem.meta.closedRemotely = true;
    localItem.meta.closedRemotelyAt = new Date().toISOString();
    mirrored++;
  }
  if (mirrored === 0) return 0;
  // Persist + broadcast.
  rec.artifacts.plan.updatedAt = new Date().toISOString();
  try { _sessions().saveStore(); }
  catch (err) { console.error(`[fr-81 Phase B.3] saveStore failed: ${err.message}`); }
  try {
    const attachMod = require('./attach');
    const live = typeof attachMod.getSession === 'function' ? attachMod.getSession(sessionId) : null;
    if (live && typeof live.emit === 'function') {
      live.emit('state-update', { kind: 'artifact', artifactType: 'plan', artifact: rec.artifacts.plan });
    }
  } catch {}
  console.log(`[fr-81 Phase B.3] mirrored ${mirrored} closed remote issue(s) → done for ${sessionId}`);
  return mirrored;
}

// fr-81 Phase B.2: build a Set of remote URLs that are already
// represented as local plan items. Used by getForSession to skip
// duplicate rendering in the Remote-issues section. Local items
// without meta.remoteUrl (the manually-typed /fr /td /bug rows)
// contribute nothing here — they're invisible to dedup.
function _collectLinkedRemoteUrls(rec) {
  const out = new Set();
  if (!rec || !rec.artifacts || !rec.artifacts.plan || !Array.isArray(rec.artifacts.plan.items)) return out;
  for (const it of rec.artifacts.plan.items) {
    const url = it && it.meta && it.meta.remoteUrl;
    if (typeof url === 'string' && url) out.add(url);
  }
  return out;
}

// Test hook: clear the cache so unit tests can run with a known state.
function _resetCache() { _cache.clear(); }

module.exports = {
  getForSession,
  isStale,
  CACHE_TTL_MS,
  MAX_ITEMS_PER_SESSION,
  _resetCache,
};
