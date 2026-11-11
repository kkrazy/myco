const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// SDK Phase 9: PTY driver is retired. attach.js owns the WS attach +
// chat plumbing for AgentSessions; the local name stays `ptyMod` for
// minimal-diff readability until the next pass through sessions.js.
const ptyMod = require('./attach');

// ─── workspace ───────────────────────────────────────────────────────────────

const WORKSPACE = (() => {
  const raw = (process.env.MYCO_WORKSPACE || os.homedir()).replace(/^~(?=$|\/)/, os.homedir());
  return path.resolve(raw);
})();

const STATE_DIR = process.env.MYCO_STATE_DIR || path.join(os.homedir(), '.myco');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');

function userRoot(user) { return user ? path.join(WORKSPACE, user) : WORKSPACE; }
function workspaceName(user) {
  const base = path.basename(WORKSPACE) || 'workspace';
  return user ? `${base}/${user}` : base;
}
function getWorkspace() { return WORKSPACE; }

function listWorkspaceDirs(user) {
  const root = userRoot(user);
  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}

function resolveCwd(rawCwd, user) {
  const root = userRoot(user);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  const raw = (rawCwd || '').trim();
  if (!raw) return root;
  if (raw === '~' || raw.startsWith('~/') || path.isAbsolute(raw)) {
    throw new Error(`Path must be relative to your workspace`);
  }
  const abs = path.resolve(root, raw);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is outside your workspace`);
  }
  if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
  if (!fs.statSync(abs).isDirectory()) throw new Error(`Path is not a directory`);
  return abs;
}

function toRel(abs, user) {
  const rel = path.relative(userRoot(user), abs);
  return rel === '' ? '.' : rel;
}

// ─── session store (JSON file) ──────────────────────────────────────────────

// bug-80: helper to detect "nested session" pollution. Given an
// absolute path + the current store, returns the registered session
// record whose absCwd is a STRICT ANCESTOR of the given path (i.e.
// the path lives inside that session's workspace). Returns null
// when no such ancestor exists OR when the path equals one of the
// registered session's absCwd (a path equal to itself is the same
// session, not a child). Used by both:
//   - importExistingTranscripts (skip guard): refuses to register
//     a discovered .claude/projects transcript that lives inside an
//     already-known session's workspace — the transcript is just a
//     subagent run inside the parent, not a separate session.
//   - _normalizeNestedSessions (cleanup scan): removes legacy entries
//     in the store that violate the same invariant (so existing dirty
//     stores get cleaned at server boot).
function _findEnclosingSession(absCwd, store) {
  if (!absCwd || !store || !store.sessions) return null;
  const target = path.resolve(absCwd);
  for (const rec of Object.values(store.sessions)) {
    if (!rec || !rec.absCwd) continue;
    const parentAbs = path.resolve(rec.absCwd);
    if (parentAbs === target) continue;                  // equal != enclosed
    const rel = path.relative(parentAbs, target);
    // path.relative returns '' for equal, '..' or starts-with-'..' for
    // siblings/ancestors, and a clean sub-path for descendants.
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rec;
  }
  return null;
}

// bug-84: helper that returns true when a session record has any plan
// item awaiting a verdict the user hasn't resolved yet. Mirrors the
// EXACT condition fr-98's attach-replay uses (attach.js:1807-1810) so
// the sidebar badge and the attach-replay are guaranteed to agree:
// if the badge is shown, fr-98 WILL replay the verdict on the next
// attach to that session. The check is OR across all plan items —
// any pending verdict flips the flag.
//
// Used by:
//   · GET /sessions enrichment (index.js) — surface the flag to the
//     sidebar so the user sees a "verdict pending" indicator while
//     they work in a different session, without having to remember
//     which sessions had a critic fire.
//   · Future code that wants a stateless "does this session need
//     attention?" probe — the same condition + the same export point.
//
// Returns false defensively when rec is null, has no artifacts, or
// has no plan items.
function hasPendingVerdict(rec) {
  if (!rec || !rec.artifacts || !rec.artifacts.plan) return false;
  const items = rec.artifacts.plan.items;
  if (!Array.isArray(items) || items.length === 0) return false;
  for (const it of items) {
    if (!it || !it.meta) continue;
    const lastCriticReview = it.meta.lastCriticReview;
    const stageState = it.meta.stageState;
    if (!lastCriticReview) continue;
    if (!stageState) continue;
    const s = stageState.status;
    if (s === 'awaiting_verdict' || s === 'awaiting_accept') return true;
  }
  return false;
}

// bug-80: boot-time normalization. Scans the loaded store and removes
// entries whose absCwd is enclosed by another entry's absCwd (the dirty
// state the bug-80 reporter has — see _myco_/logs and the user's repro:
// `myco-kkrazy-b6a240cf` with cwd `myco-kkrazy-4cf7dcac/omni-cache`
// living INSIDE `myco-kkrazy-4cf7dcac`'s workspace). Returns the array
// of removed ids so callers can log audit info. Idempotent: a clean
// store returns []; the next loadStore call is a no-op.
function _normalizeNestedSessions(store) {
  if (!store || !store.sessions) return [];
  const removed = [];
  // Snapshot ids first — we mutate sessions inside the loop. Order
  // doesn't matter because a CHILD-of-CHILD is also a CHILD-of-PARENT
  // (transitivity), and we test against the live store on each
  // iteration so already-deleted children don't accidentally protect
  // their grandchildren.
  for (const id of Object.keys(store.sessions)) {
    const rec = store.sessions[id];
    if (!rec || !rec.absCwd) continue;
    // Don't let an entry "enclose" itself: _findEnclosingSession
    // already excludes equal paths, but be defensive against alternate
    // forms (trailing slash, .., etc.) by resolving both sides via the
    // helper.
    const enclosing = _findEnclosingSession(rec.absCwd, store);
    if (enclosing && enclosing.id !== rec.id) {
      console.warn(`[bug-80] _normalizeNestedSessions: removing nested session ${rec.id} (absCwd=${rec.absCwd}) — enclosed by ${enclosing.id} (absCwd=${enclosing.absCwd})`);
      delete store.sessions[id];
      removed.push(id);
    }
  }
  return removed;
}

let storeCache = null;
function loadStore() {
  if (storeCache) return storeCache;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    storeCache = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    storeCache = { sessions: {} };
  }
  if (!storeCache.sessions) storeCache.sessions = {};
  if (!storeCache.dismissed) storeCache.dismissed = [];
  // bug-80: clean any nested-session pollution from the on-disk store
  // BEFORE handing it back to callers. The fix in
  // importExistingTranscripts prevents new occurrences; this scan
  // handles the existing duplicates users already see in the sidebar.
  // We save the cleaned store back to disk so the change persists
  // (otherwise loadStore would re-clean on every cold start without
  // ever flushing the file — wasteful + auditable changes don't land).
  const removedNested = _normalizeNestedSessions(storeCache);
  if (removedNested.length > 0) {
    try {
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(storeCache, null, 2));
      fs.renameSync(tmp, STATE_FILE);
      console.log(`[bug-80] loadStore: persisted normalized store after removing ${removedNested.length} nested session(s): ${removedNested.join(', ')}`);
    } catch (err) {
      console.error(`[bug-80] loadStore: failed to persist normalized store: ${err.message}`);
    }
  }
  return storeCache;
}

function saveStore() {
  if (!storeCache) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(storeCache, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function putSession(rec) { loadStore().sessions[rec.id] = rec; saveStore(); }
function removeSession(id) {
  const store = loadStore();
  const rec = store.sessions[id];
  if (rec && rec.absCwd) {
    store.dismissed = store.dismissed || [];
    if (!store.dismissed.includes(rec.absCwd)) store.dismissed.push(rec.absCwd);
  }
  delete store.sessions[id];
  saveStore();
}
function getSessionRecord(id) { return loadStore().sessions[id] || null; }

// ─── claude transcript helpers ──────────────────────────────────────────────

function projectsDir() { return path.join(os.homedir(), '.claude', 'projects'); }
function encodeCwdForClaude(cwd) { return cwd.replace(/\//g, '-'); }

// One-shot copy of legacy SDK auto-memory into the per-session
// .claude/memory/ folder. Pre-2026-05-15 the SDK pooled memory under
// $HOME/.claude/projects/<encoded-cwd>/memory/, shared across every
// session that happened to use the same cwd. With the id-as-folder
// rule + autoMemoryDirectory override, each session has its own
// .claude/memory/ — but existing sessions need their prior memory
// migrated in. Called from ensureLiveSession (agent branch) before
// spawnAgent so the SDK's first read finds the files.
//
// Idempotent. Returns the number of files copied (0 if there was
// nothing to migrate OR the destination already exists). Safe to
// call on every spawn — costs one fs.existsSync per session.
function _migrateLegacyMemory(absCwd) {
  if (!absCwd) return 0;
  const destDir = path.join(absCwd, '.claude', 'memory');
  if (fs.existsSync(destDir)) return 0;   // already migrated (or per-session from spawn)
  const srcDir = path.join(projectsDir(), encodeCwdForClaude(absCwd), 'memory');
  if (!fs.existsSync(srcDir)) return 0;   // no legacy memory for this cwd
  let entries;
  try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); }
  catch { return 0; }
  if (!entries.length) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  let count = 0;
  for (const ent of entries) {
    const sp = path.join(srcDir, ent.name);
    const dp = path.join(destDir, ent.name);
    try {
      if (ent.isFile()) {
        fs.copyFileSync(sp, dp);
        count++;
      } else if (ent.isDirectory()) {
        // Recurse one level for subfolders (the SDK doesn't nest
        // memory deeper than a directory or two — MEMORY.md plus
        // typed subdirs).
        fs.mkdirSync(dp, { recursive: true });
        for (const sub of fs.readdirSync(sp, { withFileTypes: true })) {
          if (!sub.isFile()) continue;
          fs.copyFileSync(path.join(sp, sub.name), path.join(dp, sub.name));
          count++;
        }
      }
    } catch (err) {
      console.error(`[migrate-memory] copy ${sp} → ${dp} failed: ${err.message}`);
    }
  }
  return count;
}

// Claude code keeps a per-process tracker in ~/.claude/sessions/<pid>.json:
//
//   { "pid": 27, "sessionId": "355313f5-…", "cwd": "/wks/kkrazy/myco",
//     "startedAt": 1778658106360, "status": "busy",
//     "updatedAt": 1778658560926, "kind": "interactive", ... }
//
// This is the AUTHORITATIVE current-session-id for an actively-running
// claude process, and it survives in-TUI `/resume` re-execs that
// captureClaudeSessionId is blind to (the polling window only runs for
// ~60s after spawn, and an in-process /resume doesn't trigger a new
// spawn). We use it as the primary source when resolving the transcript
// path; the polled `rec.claudeSessionId` and the "newest jsonl in dir"
// fallback both come second. If multiple `<pid>.json` files match the
// cwd (stale entries from dead processes happen), the freshest
// `updatedAt` wins — the running process is constantly heartbeating
// while dead ones froze at exit.
function _claudeSessionsDir() { return path.join(os.homedir(), '.claude', 'sessions'); }
function readActiveClaudeSessionForCwd(absCwd) {
  if (!absCwd) return null;
  const dir = _claudeSessionsDir();
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  let bestId = null;
  let bestUpdated = 0;
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    let info;
    try { info = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch { continue; }
    if (!info || info.cwd !== absCwd) continue;
    if (!isClaudeSessionId(info.sessionId)) continue;
    const updated = Number(info.updatedAt || 0);
    if (updated > bestUpdated) { bestUpdated = updated; bestId = info.sessionId; }
  }
  return bestId;
}

// Claude session-id shape (UUID v4): the basename of `<project>/<uuid>.jsonl`.
// Task-tool subagent transcripts use the shape `agent-<hex>.jsonl` and live
// under a `subagents/` subdirectory — those are NOT resumable session ids
// and must never be stored as `claudeSessionId`. Doing so causes
// `claude --resume agent-XYZ` to error and exit immediately, leaving the
// PTY blank and the chat hung (the symptom that exposed this bug).
const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isClaudeSessionId(name) { return CLAUDE_SESSION_ID_RE.test(String(name || '')); }

async function findNewestJsonl(dir, sinceMs = 0) {
  let best = null;
  async function walk(d) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        // Skip the `subagents/` directory entirely — it holds Task-tool
        // sub-conversations whose filenames (`agent-*.jsonl`) are NOT
        // resumable claude session ids.
        if (e.name === 'subagents') continue;
        await walk(full);
      } else if (e.name.endsWith('.jsonl')) {
        const base = e.name.replace(/\.jsonl$/, '');
        // Belt-and-braces: only accept canonical UUID-shaped basenames.
        // Real claude sessions are `<uuid>.jsonl`; anything else (subagent
        // leakage, partial transcripts, future variants) is excluded so a
        // bad name can never reach `claude --resume`.
        if (!isClaudeSessionId(base)) continue;
        let st;
        try { st = await fsp.stat(full); } catch { continue; }
        if (st.mtimeMs < sinceMs) continue;
        if (!best || st.mtimeMs > best.mtimeMs) best = { file: e.name, full, mtimeMs: st.mtimeMs };
      }
    }
  }
  await walk(dir);
  return best;
}

async function readFirstUserPrompt(jsonlPath) {
  try {
    const raw = await fsp.readFile(jsonlPath, 'utf8');
    for (const line of raw.split('\n').slice(0, 300)) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type !== 'user') continue;
      const c = obj.message && obj.message.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        const t = c.find((x) => x && x.type === 'text');
        if (t) text = t.text || '';
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (!text || text.startsWith('<')) continue;
      return text.length > 100 ? text.slice(0, 100) + '…' : text;
    }
    return null;
  } catch { return null; }
}

async function readCwdFromTranscript(jsonlPath) {
  try {
    const raw = await fsp.readFile(jsonlPath, 'utf8');
    for (const line of raw.split('\n').slice(0, 100)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj.cwd === 'string' && obj.cwd.startsWith('/')) return obj.cwd;
      } catch {}
    }
    return null;
  } catch { return null; }
}

async function readDescriptionForCwd(absCwd, rec) {
  const dir = path.join(projectsDir(), encodeCwdForClaude(absCwd));
  const newest = await findNewestJsonl(dir);
  if (!newest) return null;
  const firstPrompt = await readFirstUserPrompt(newest.full);
  const status = deriveStatus(newest.mtimeMs);

  // Use cached AI summary if available and fresh
  let summary = null;
  if (rec && rec.aiSummary && rec.summaryGeneratedAt) {
    const generatedAt = new Date(rec.summaryGeneratedAt).getTime();
    if (newest.mtimeMs <= generatedAt) {
      summary = rec.aiSummary;
    }
  }
  if (!summary) {
    summary = await summarizeRecentContext(newest.full);
  }

  return { description: firstPrompt, summary, status, lastActivity: newest.mtimeMs };
}

function deriveStatus(mtimeMs) {
  const ageMs = Date.now() - mtimeMs;
  if (ageMs < 30 * 60 * 1000) return 'active';       // < 30 min
  if (ageMs < 4 * 60 * 60 * 1000) return 'recent';   // < 4 hours
  if (ageMs < 24 * 60 * 60 * 1000) return 'stale';   // < 1 day
  return 'idle';                                      // >= 1 day
}

// Read the tail of the transcript to get a sense of what Claude was last doing.
// We look for the last assistant text reply — that describes the work done,
// not the ask. Falls back to the last user message if no assistant text found.
async function summarizeRecentContext(jsonlPath) {
  try {
    const raw = await fsp.readFile(jsonlPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length < 4) return null;

    // Walk backwards: prefer last assistant text, then last user text.
    let lastAssistantText = null;
    let lastUserText = null;
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 300); i--) {
      let obj;
      try { obj = JSON.parse(lines[i]); } catch { continue; }
      if (obj.type !== 'assistant' && obj.type !== 'user') continue;
      const msg = obj.message;
      if (!msg) continue;
      const role = msg.role || obj.type;
      const c = msg.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        // Pull the first text block (skip thinking/tool_use blocks).
        const t = c.find((x) => x && x.type === 'text' && x.text && x.text.trim());
        if (t) text = t.text;
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (!text || text.startsWith('<')) continue;
      if (role === 'assistant' && !lastAssistantText) lastAssistantText = text;
      if (role === 'user' && !lastUserText) lastUserText = text;
      if (lastAssistantText) break; // got what we need
    }

    const pick = lastAssistantText || lastUserText;
    if (!pick) return null;
    // Trim to a card-friendly length.
    if (pick.length > 80) return pick.slice(0, 77) + '…';
    return pick;
  } catch { return null; }
}

// After spawning claude, poll the projects dir for a new jsonl whose mtime is
// >= the spawn time and stash the id (filename minus .jsonl) so we can
// `claude --resume <id>` on later attaches.
function captureClaudeSessionId(sessionId, absCwd, spawnedAtMs) {
  const dir = path.join(projectsDir(), encodeCwdForClaude(absCwd));
  let attempts = 0;
  let prevBest = null; // track the newest file BEFORE spawn
  // Snapshot what exists before spawn
  findNewestJsonl(dir).then((r) => { prevBest = r; });

  function commit(id, source) {
    if (!isClaudeSessionId(id)) return false;
    const rec = loadStore().sessions[sessionId];
    if (!rec) return false;
    if (rec.claudeSessionId === id) return true;
    const prev = rec.claudeSessionId;
    rec.claudeSessionId = id;
    saveStore();
    console.log(`[capture] claudeSessionId=${id} for ${sessionId} (${source}${prev ? `, replaced ${prev}` : ''})`);
    return true;
  }

  const tick = async () => {
    attempts += 1;
    // SOURCE OF TRUTH (added): claude code's own active-session tracker
    // at ~/.claude/sessions/<pid>.json. When we find an entry whose
    // `cwd` matches ours, it is the authoritative current session id —
    // even if the user did an in-TUI /resume that bypasses our spawn
    // pipeline. Heuristic fallback below kicks in when claude isn't
    // running yet (the tracker file gets written shortly after start).
    const liveId = readActiveClaudeSessionForCwd(absCwd);
    if (liveId) { commit(liveId, `live tracker, attempt ${attempts}`); return; }

    const newest = await findNewestJsonl(dir);
    if (newest && newest.mtimeMs >= spawnedAtMs - 2000) {
      let id = newest.file.replace(/\.jsonl$/, '');
      if (id === 'transcript') {
        const m = newest.full.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i);
        id = m ? m[1] : id;
      }
      if (!isClaudeSessionId(id)) { if (attempts < 120) setTimeout(tick, 500); return; }
      commit(id, `newest-jsonl, attempt ${attempts}`);
      return;
    }
    if (attempts < 120) setTimeout(tick, 500);
  };
  setTimeout(tick, 500);
}

// ─── public API ──────────────────────────────────────────────────────────────

function sessionBelongsToUser(sessionId, user) {
  const rec = getSessionRecord(sessionId);
  if (!rec) return false;
  return rec.user === user;
}

// fr-39: per-session admin delegation. Owners can promote other users
// to admin via `/admin @user` (slash command in slashcmds.js). Admins
// inherit everything owner can do EXCEPT delete-session and grant/
// revoke admin (those stay owner-only — see comments at the DELETE
// route in index.js and the /admin handler in slashcmds.js).
//
// Data shape: rec.admins = [string login, ...] persisted in
// /data/sessions.json. Missing field → [] (empty list).
function getSessionAdmins(sessionId) {
  const rec = getSessionRecord(sessionId);
  if (!rec) return [];
  return Array.isArray(rec.admins) ? rec.admins.slice() : [];
}

function isOwnerOrAdmin(sessionId, user) {
  // bug-47 r3: delegate to resolveAccessTier — the carve-out + the
  // rec.user/admins/viewers ladder both live there. 'owner' tier
  // corresponds to "owner or admin" (admins are stored in rec.admins
  // and resolveAccessTier maps them to 'owner').
  return resolveAccessTier(sessionId, user) === 'owner';
}

function addAdminToSession(sessionId, user) {
  const rec = getSessionRecord(sessionId);
  if (!rec || !user) return false;
  if (rec.user === user) return false;          // owner is implicit admin; don't add a redundant entry
  if (!Array.isArray(rec.admins)) rec.admins = [];
  if (rec.admins.includes(user)) return false;  // idempotent
  rec.admins.push(user);
  saveStore();
  // bug-17 fix: kick the granted user's existing viewer WS so they
  // reconnect — the new attach evaluates isOwnerOrAdmin against the
  // freshly-mutated rec.admins and lands them on the owner branch
  // instead of the viewer-readOnly branch. Without this, the user
  // would have to manually reload the page for the grant to take
  // effect (the symptom kkrazy reported in bug-17).
  try {
    const attachMod = require('./attach');
    if (typeof attachMod._kickViewerByLogin === 'function') {
      attachMod._kickViewerByLogin(sessionId, user);
    }
  } catch (err) {
    console.error(`[bug-17-kick] addAdmin: kick failed for ${sessionId}/${user}: ${err.message}`);
  }
  return true;
}

function removeAdminFromSession(sessionId, user) {
  const rec = getSessionRecord(sessionId);
  if (!rec || !user) return false;
  if (!Array.isArray(rec.admins)) return false;
  const idx = rec.admins.indexOf(user);
  if (idx < 0) return false;                    // idempotent
  rec.admins.splice(idx, 1);
  saveStore();
  // bug-17 fix: kick the revoked admin's existing owner-branch WS
  // so they reconnect — the new attach evaluates isOwnerOrAdmin
  // against the freshly-mutated rec.admins and lands them on the
  // viewer-readOnly branch. Without this, a revoked admin would
  // keep driving claude until they reload.
  try {
    const attachMod = require('./attach');
    if (typeof attachMod._kickViewerByLogin === 'function') {
      attachMod._kickViewerByLogin(sessionId, user);
    }
  } catch (err) {
    console.error(`[bug-17-kick] removeAdmin: kick failed for ${sessionId}/${user}: ${err.message}`);
  }
  return true;
}

// fr-86: soft-reset support. markSessionForRestart nulls the SDK
// session id so the next ensureLiveSession spawn produces a FRESH
// Claude conversation (no resume, no carried-over working memory).
// rec.chat / events.jsonl / the existing SDK transcript JSONL are
// deliberately untouched — the user explicitly asked that history
// survive so they "can come back and collect the full logs later".
// Called by /clear new (slashcmds.js) under an owner+admin gate.
function markSessionForRestart(sessionId) {
  const rec = getSessionRecord(sessionId);
  if (!rec) return false;
  rec.sdkSessionId = null;
  saveStore();
  return true;
}

// fr-87: per-session viewer delegation (the read-only counterpart of
// fr-39's admin tier). Owners can share a session read-only with other
// users via `/share @user @user` (slash command in slashcmds.js).
// Viewers can READ — list the session in their sidebar, see chat +
// transcripts, attach as a read-only WS — but cannot drive claude,
// cannot edit, cannot grant/revoke admins or viewers, cannot delete.
//
// Tier ordering: owner > admin > viewer. Admin promotion supersedes
// viewer; addViewerToSession is a no-op for owner + existing admins
// (so rec.viewers[] never double-lists a user who's already higher).
//
// Data shape: rec.viewers = [string login, ...] persisted in
// /data/sessions.json. Missing field → [] (empty list).
function getSessionViewers(sessionId) {
  const rec = getSessionRecord(sessionId);
  if (!rec) return [];
  return Array.isArray(rec.viewers) ? rec.viewers.slice() : [];
}

// bug-47 r3: SINGLE source of truth for "what tier does this user
// have on this session?" Returns 'owner' | 'viewer' | null.
//
// Pre-r3, the access logic was implemented FOUR times — here in
// isOwnerAdminOrViewer (boolean) AND in isOwnerOrAdmin (boolean) AND
// in listSessions' filter (boolean) AND inline inside fileApiPreamble
// (tier-aware) in server/src/index.js. All four copies hand-rolled
// the rec.user / rec.admins / rec.viewers ladder, and three of them
// also included an identical hardcoded global carve-out (added in
// f71495f alongside the Gitee PAT work — a dev-mode shortcut so the
// project collaborators don't need explicit /share grants on every
// session). The fourth copy (fileApiPreamble) DIDN'T have the
// carve-out, so labxnow could see + attach via the helper-using
// paths but got 403 on the file-API — exactly the @kkrazy
// re-dispatch of bug-47.
//
// The carve-out maps to 'owner' tier to preserve the pre-r3
// behaviour of isOwnerOrAdmin returning true for these users (so
// they keep write access where they had it). Explicit rec.admins
// entries are also 'owner', so no double-grant edge case.
//
// To revoke the carve-out, delete the `GLOBAL_OWNER_USERS` check
// inside this function — that's the one place it lives now.
const GLOBAL_OWNER_USERS = new Set(['labxnow', 'kkrazy', 'ryan-blues']);

function resolveAccessTier(sessionId, user) {
  if (!user) return null;
  const rec = getSessionRecord(sessionId);
  if (!rec) return null;
  // Explicit ACL first — owner / admin / viewer entries take precedence.
  if (rec.user === user) return 'owner';
  if (Array.isArray(rec.admins) && rec.admins.includes(user)) return 'owner';
  if (Array.isArray(rec.viewers) && rec.viewers.includes(user)) return 'viewer';
  // Global carve-out (full owner tier — matches pre-r3 isOwnerOrAdmin
  // behaviour for these users).
  if (GLOBAL_OWNER_USERS.has(String(user).toLowerCase())) return 'owner';
  return null;
}

function isOwnerAdminOrViewer(sessionId, user) {
  // bug-47 r3: delegate to resolveAccessTier so the access rules stay
  // in ONE place. Pre-r3 this had its own inline copy of the rules +
  // the global carve-out — duplication that drifted out of sync with
  // fileApiPreamble.
  return resolveAccessTier(sessionId, user) !== null;
}

function addViewerToSession(sessionId, user) {
  const rec = getSessionRecord(sessionId);
  if (!rec || !user) return false;
  if (rec.user === user) return false;           // owner is implicit viewer; don't add a redundant entry
  if (Array.isArray(rec.admins) && rec.admins.includes(user)) return false; // admin supersedes viewer
  if (!Array.isArray(rec.viewers)) rec.viewers = [];
  if (rec.viewers.includes(user)) return false;  // idempotent
  rec.viewers.push(user);
  saveStore();
  // Mirror the bug-17 kick used by addAdmin: if the granted user has
  // a live WS to this session, kick it so the new attach evaluates
  // isOwnerAdminOrViewer against the fresh rec.viewers and lands them
  // on the read-only viewer branch instead of the rejected/no-such-
  // session branch.
  try {
    const attachMod = require('./attach');
    if (typeof attachMod._kickViewerByLogin === 'function') {
      attachMod._kickViewerByLogin(sessionId, user);
    }
  } catch (err) {
    console.error(`[fr-87-kick] addViewer: kick failed for ${sessionId}/${user}: ${err.message}`);
  }
  return true;
}

function removeViewerFromSession(sessionId, user) {
  const rec = getSessionRecord(sessionId);
  if (!rec || !user) return false;
  if (!Array.isArray(rec.viewers)) return false;
  const idx = rec.viewers.indexOf(user);
  if (idx < 0) return false;                     // idempotent
  rec.viewers.splice(idx, 1);
  saveStore();
  try {
    const attachMod = require('./attach');
    if (typeof attachMod._kickViewerByLogin === 'function') {
      attachMod._kickViewerByLogin(sessionId, user);
    }
  } catch (err) {
    console.error(`[fr-87-kick] removeViewer: kick failed for ${sessionId}/${user}: ${err.message}`);
  }
  return true;
}

// fr-38: per-session "strict mode" gate. When on, claude-bound chat
// messages MUST include a `[run:plan#<id>]` marker; messages without
// it are blocked at the handleChatMessage boundary with an
// explanatory reply (claude never runs, no tokens wasted). The marker
// is the user's affirmation that this turn is backed by an approved
// td/fr/bug. Default off. Toggle via `/strict on|off` slash command
// (owner + admin per fr-39 inheritance).
//
// Data shape: rec.strictMode = boolean, persisted in
// /data/sessions.json. Missing → false (off).
function isSessionStrict(sessionId) {
  const rec = getSessionRecord(sessionId);
  if (!rec) return false;
  return !!rec.strictMode;
}

function setSessionStrict(sessionId, on) {
  const rec = getSessionRecord(sessionId);
  if (!rec) return false;
  const next = !!on;
  if ((rec.strictMode || false) === next) return false;   // idempotent
  rec.strictMode = next;
  saveStore();
  return true;
}

function shortId() { return crypto.randomBytes(4).toString('hex'); }

function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function listSessions(forUser) {
  const all = Object.values(loadStore().sessions);
  // fr-87: include sessions where forUser is owner, admin, OR viewer.
  // Before fr-87 this was owner-only (rec.user === forUser); widening
  // it lets a shared session show up in the recipient's sidebar.
  const filtered = forUser
    ? all.filter((r) => {
        // bug-47 r3: delegate to resolveAccessTier so the carve-out +
        // the rec.user/admins/viewers ladder live in one place. The
        // pre-r3 filter hand-rolled lowercase comparisons; the shared
        // helper takes the strict-equality path the explicit ACL
        // uses, plus the lowercased carve-out check. Sidebar
        // visibility matches every other access tier downstream.
        return resolveAccessTier(r.id, forUser) !== null;
      })
    : all;
  return Promise.all(filtered.map(async (r) => {
    const info = await readDescriptionForCwd(r.absCwd, r);
    // Display label preference: explicit rec.label (set on spawn) →
    // r.cwd for legacy sessions whose cwd was the user-typed name →
    // id-shortid as a last resort. The client renders s.name as the
    // session-list title.
    const displayName = r.label || r.cwd || r.id;
    // fr-87: visibility metadata for the session-list badge. A session
    // is 'shared' if it has any admins OR viewers; otherwise 'private'.
    // viewerCount is the literal length of rec.viewers (admins are
    // tracked separately and not double-counted). isViewer is true
    // when forUser is in rec.viewers AND not in higher tiers — the
    // client uses this to disable the "drive claude" controls.
    const admins = Array.isArray(r.admins) ? r.admins : [];
    const viewers = Array.isArray(r.viewers) ? r.viewers : [];
    const visibility = (admins.length || viewers.length) ? 'shared' : 'private';
    const isOwner = forUser ? (r.user === forUser) : false;
    const isAdmin = forUser ? admins.includes(forUser) : false;
    const isViewer = !!forUser && !isOwner && !isAdmin && viewers.includes(forUser);
    return {
      id: r.id,
      name: displayName,
      label: r.label || null,            // raw friendly label (null if unset)
      cwd: r.cwd,
      abs_cwd: r.absCwd,
      description: info?.description || null,
      summary: info?.summary || null,
      status: info?.status || 'idle',
      last_activity: info?.lastActivity || null,
      created_at: r.createdAt,
      // fr-87 visibility surface
      owner: r.user,
      visibility,
      viewerCount: viewers.length,
      viewers,                            // included so owner can render tooltip without an extra fetch
      isViewer,
    };
  }));
}

// fr-94 Phase 1: derive a project-dir name from a git URL. Handles
// `https://github.com/owner/repo(.git)?`, `git@host:owner/repo(.git)?`,
// and `owner/repo` shorthand. Returns just the repo name (last
// path segment, `.git` stripped). Falls back to 'project' if the
// URL doesn't parse cleanly.
function _projectNameFromGitUrl(url) {
  const m = String(url || '').match(/[^\/:]+?(?:\.git)?$/);
  const name = m ? m[0].replace(/\.git$/, '').trim() : '';
  // Sanitize to a safe directory name — no path separators, no
  // hidden-dir prefix.
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '');
  return safe || 'project';
}

// fr-94 Phase 3: kick off an asynchronous `git clone --progress` into
// <absCwd>/<inferred-name>/ and return the inferred project name
// IMMEDIATELY so spawnSession can finish + the HTTP /sessions POST
// can respond without waiting for the clone. Clone progress + the
// final success/failure verdict stream into the session's chat pane
// via appendChatMessage (persisted to rec.chat) AND a live session-
// bus emit('chat', msg) (so any WS that's already attached renders
// the line without a refresh).
//
// Why async: Phase 1's spawnSync pinned the /sessions POST for the
// duration of the clone — gentle on tiny repos, terrible UX on
// anything bigger (mobile users sat staring at a hung spawn modal
// while a 200MB monorepo cloned over a flaky network). Phase 1 r1
// added a 2-min timeout to bound the worst case, but the user-
// reported gap was "the modal blocks at all" — Phase 3 is the real
// fix.
//
// Pre-create the empty project dir so:
//   · `git clone <url> <empty-dir>` works (git permits an existing
//     empty target).
//   · findProjectRoot(rec)'s explicit-override branch (rec.mainProject
//     set) doesn't trip on a missing directory while the clone is in
//     flight. Plan-item writes (_myco_/plan.json) land at the project
//     dir from the first iteration onward; no race.
//
// The agent's process.cwd() stays at the session-root wrapper (NOT
// the project subdir) for the gitCloneUrl branch — reanchoring the
// SDK's cwd mid-iteration is out of scope. The user can `cd
// <projectName>` once the chat message reports clone success.
//
function resolveAgentCwd(rec) {
  if (rec.mainProject && rec.cloneState !== 'pending') {
    return path.join(rec.absCwd, rec.mainProject);
  }
  return rec.absCwd;
}

// Caller contract: spawnSession sets rec.cloneState='pending' +
// rec.cloneUrl=<url> BEFORE this helper kicks off (so a chat-pane
// observer sees the field before the first progress line lands).
function _kickoffGitCloneAsync(sessionId, absCwd, gitUrl) {
  const projectName = _projectNameFromGitUrl(gitUrl);
  const projectAbs = path.join(absCwd, projectName);
  // Pre-create empty dir so findProjectRoot's exists() check passes
  // while the clone is still in flight. `git clone <url> <empty-dir>`
  // works fine.
  try { fs.mkdirSync(projectAbs, { recursive: true }); }
  catch (err) { console.error(`[fr-94 Phase 3] mkdir ${projectAbs} failed: ${err.message}`); }
  // Defer the actual spawn one tick so the caller can finish
  // putSession + spawnAgent + _registerExternalSession FIRST. That
  // way the live-emit path (_emitCloneMsg → attachMod.getSession)
  // finds the registered session for the very first progress line.
  setImmediate(() => _runGitCloneInBackground(sessionId, projectAbs, gitUrl));
  return projectName;
}

// Background driver for _kickoffGitCloneAsync. Spawns the clone,
// throttles stderr lines into chat-pane progress rows, and posts a
// final ✓/✗ verdict that mutates rec.cloneState.
function _runGitCloneInBackground(sessionId, projectAbs, gitUrl) {
  const { spawn } = require('child_process');
  const startedAt = Date.now();
  _emitCloneMsg(sessionId, `⏳ git clone ${gitUrl} → ${path.basename(projectAbs)}/ …`, 'fr-94/clone-start');
  let child;
  try {
    child = spawn('git', ['clone', '--progress', gitUrl, projectAbs], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    _markCloneFailed(sessionId, `✗ git clone could not start: ${err.message}`);
    return;
  }
  // git's --progress writes to stderr (one carriage-return-terminated
  // line per progress tick). Throttle to one chat row per ~500ms so
  // a fast clone doesn't flood the chat pane with 50 "Receiving
  // objects" updates.
  let stderrBuf = '';
  let lastEmit = 0;
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
    const parts = stderrBuf.split(/[\r\n]+/);
    stderrBuf = parts.pop() || '';
    for (const ln of parts) {
      const line = ln.trim();
      if (!line) continue;
      const now = Date.now();
      if (now - lastEmit < 500) continue;
      lastEmit = now;
      _emitCloneMsg(sessionId, `⏳ ${line}`, 'fr-94/clone-progress');
    }
  });
  // Hard SIGTERM after 10 min — same intent as Phase 1 r1's
  // synchronous-clone timeout, just enforced via process.kill since
  // the async spawn() has no built-in timeout option. Generous
  // because the user is no longer being blocked by it.
  const CLONE_HARD_TIMEOUT_MS = 600_000;
  const killer = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch {}
  }, CLONE_HARD_TIMEOUT_MS);
  child.on('exit', (code, signal) => {
    clearTimeout(killer);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (code === 0) {
      const store = loadStore();
      const rec = store.sessions[sessionId];
      if (rec) { rec.cloneState = 'success'; saveStore(); }
      // Now that the project tree exists, inject the myco best-
      // practices block into the project's CLAUDE.md (skipped in
      // spawnSession because the dir had to stay empty for git
      // clone). Best-effort: a clone that landed without a CLAUDE.md
      // is fine; the inject is idempotent so a re-spawn would catch
      // it later anyway.
      try { injectBestPracticesIntoClaudeMd(projectAbs); }
      catch (err) { console.error(`[fr-94 Phase 3] post-clone CLAUDE.md inject failed for ${sessionId}: ${err.message}`); }
      _emitCloneMsg(sessionId, `✓ Cloned ${gitUrl} in ${elapsed}s. cd ${path.basename(projectAbs)} to anchor work in the project.`, 'fr-94/clone-success');
      // Move any temporary _myco_ folder created during clone-pending to the new project subdirectory
      const tempMyco = path.join(path.dirname(projectAbs), '_myco_');
      const destMyco = path.join(projectAbs, '_myco_');
      if (fs.existsSync(tempMyco) && !fs.existsSync(destMyco)) {
        try {
          fs.renameSync(tempMyco, destMyco);
        } catch (err) {
          console.error(`[fr-94 Phase 3] failed to move _myco_ directory: ${err.message}`);
        }
      }
      try {
        const attachMod = require('./attach');
        const live = typeof attachMod.getSession === 'function' ? attachMod.getSession(sessionId) : null;
        if (live) {
          live.updateCwd(projectAbs);
        }
      } catch (err) {
        console.error(`[fr-94 Phase 3] post-clone update CWD failed for ${sessionId}: ${err.message}`);
      }
    } else {
      // bug-72: the post-failure status of the project dir is the
      // single most useful diagnostic — was the failure a network /
      // auth issue (dir genuinely empty), or did something race in
      // and populate it (the bug-72 symptom)? Probe and report.
      let dirStatus = 'project dir state unknown.';
      try {
        const entries = fs.readdirSync(projectAbs);
        if (entries.length === 0) {
          dirStatus = 'Project dir is empty.';
        } else {
          const preview = entries.slice(0, 5).join(', ');
          const more = entries.length > 5 ? `, … +${entries.length - 5}` : '';
          dirStatus = `Project dir is NOT empty (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}: ${preview}${more}). git clone refuses non-empty targets — see bug-72.`;
        }
      } catch (_err) {
        dirStatus = 'Project dir missing — pre-clone mkdir may have failed.';
      }
      _markCloneFailed(sessionId, `✗ git clone failed (exit ${code}${signal ? `, signal ${signal}` : ''}) after ${elapsed}s. ${dirStatus}`);
    }
  });
  child.on('error', (err) => {
    clearTimeout(killer);
    _markCloneFailed(sessionId, `✗ git clone error: ${err.message}`);
  });
}

// Final-state helper for the clone-failure path. Sets
// rec.cloneState='failed' + posts the error to chat. The pre-created
// project dir is left in place (empty) so resolveMycoDir still
// resolves _myco_/ correctly for plan.json / critic.md / events.jsonl.
function _markCloneFailed(sessionId, text) {
  const store = loadStore();
  const rec = store.sessions[sessionId];
  if (rec) { rec.cloneState = 'failed'; saveStore(); }
  _emitCloneMsg(sessionId, text, 'fr-94/clone-error');
}

// Persist a clone-state chat row + broadcast it live to any attached
// WS clients via the live session bus. Dual-path because:
//   · appendChatMessage persists to rec.chat → a fresh attach sees
//     the row in chat-history (catches up users who weren't watching).
//   · The attach module's session-bus emit reaches already-attached
//     viewers without waiting for a reattach.
function _emitCloneMsg(sessionId, text, kind) {
  const msg = {
    user: 'system',
    text,
    ts: new Date().toISOString(),
    meta: { kind },
  };
  try { appendChatMessage(sessionId, msg); } catch {}
  // Live broadcast — lazy require to avoid the sessions⇄attach
  // module circular at module-load time.
  try {
    const attachMod = require('./attach');
    const live = typeof attachMod.getSession === 'function' ? attachMod.getSession(sessionId) : null;
    if (live && typeof live.emit === 'function') {
      live.emit('chat', msg);
    }
  } catch {}
}

// fr-94 Phase 1: create a fresh empty project subdirectory named
// <name>. The name is sanitized to a safe slug. Returns the slug.
function _spawnViaNewDir(absCwd, rawName) {
  const safe = String(rawName || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!safe) return '';
  const projectAbs = path.join(absCwd, safe);
  try { fs.mkdirSync(projectAbs, { recursive: true }); }
  catch (err) { console.error(`[fr-94] mkdir ${projectAbs} failed: ${err.message}`); }
  return safe;
}

async function spawnSession(rawCwd, user = 'default', opts = {}) {
  const safeUser = (user || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  const id = `myco-${safeUser}-${shortId()}`;
  // Session id IS the folder name (per the 2026-05-15 product decision).
  // Predictable, collision-proof, and gives every session a clean slate
  // at /wks/<user>/<session-id>/. The rawCwd field from the spawn modal
  // is now an OPTIONAL friendly label stored on rec.label — it has no
  // path semantics. Existing sessions with arbitrary rec.cwd values
  // (e.g. "test006", "myco") keep working; only NEW spawns route
  // through the id-as-folder rule.
  const userRootDir = userRoot(user);
  if (!fs.existsSync(userRootDir)) fs.mkdirSync(userRootDir, { recursive: true });
  const absCwd = path.join(userRootDir, id);
  fs.mkdirSync(absCwd, { recursive: true });
  // Free-form display label. Empty string / whitespace → no label.
  const labelRaw = (typeof rawCwd === 'string' ? rawCwd.trim() : '');
  const label = labelRaw ? labelRaw.slice(0, 80) : null;

  const cols = clamp(opts.cols, 20, 300, 120);
  const rows = clamp(opts.rows, 10, 200, 30);
  const createdAt = new Date().toISOString();

  // SDK Phase 9 step 2: PTY driver is gone. Agent is the only spawn
  // mode. The early reject keeps a clear error if some legacy caller
  // still passes opts.mode='pty'; without it the code would silently
  // create an agent session and the caller's mental model would drift.
  if (opts.mode === 'pty') {
    throw new Error('PTY mode is retired (Phase 9). New sessions are agent-mode only. Spawn without a mode field.');
  }
  const mode = 'agent';

  // fr-94 Phase 1: opts.gitCloneUrl OR opts.mainProjectName designates
  // the session's "main project" — the subdirectory under absCwd that
  // owns _myco_/ (plan.json, critic.md, events.jsonl, diagrams, …).
  // The spawn modal collects this in a single text field; the server
  // treats it as a URL if it starts with `https://`, `git@`, etc., or
  // looks like a `owner/repo` shorthand, otherwise as a new directory
  // name. mainProject is stored on the session record and
  // resolveMycoDir(rec) in artifacts.js uses it as the project root.
  // If neither is provided, mainProject stays empty and the legacy
  // auto-detect path applies (find first subdir with .git/).
  //
  // fr-94 Phase 3: the gitCloneUrl branch no longer blocks the spawn
  // — _kickoffGitCloneAsync pre-creates the empty project dir,
  // returns the inferred project name immediately, and runs the clone
  // in the background. Progress + the final ✓/✗ verdict stream into
  // rec.chat (and live to attached WS clients). rec.cloneState
  // tracks {'pending'|'success'|'failed'}; rec.cloneUrl preserves the
  // URL for diagnostics + a future "retry clone" UX.
  let mainProject = '';
  let cloneState = null;
  let cloneUrl = null;
  if (typeof opts.gitCloneUrl === 'string' && opts.gitCloneUrl.trim()) {
    cloneUrl = opts.gitCloneUrl.trim();
    mainProject = _kickoffGitCloneAsync(id, absCwd, cloneUrl);
    cloneState = 'pending';
  } else if (typeof opts.mainProjectName === 'string' && opts.mainProjectName.trim()) {
    mainProject = _spawnViaNewDir(absCwd, opts.mainProjectName.trim());
  }

  const record = { id, user, cwd: toRel(absCwd, user), absCwd, label, claudeSessionId: null, createdAt, mode };
  // bug-66: route the seed write through artifacts.setMainProject so
  // the single-main invariant is enforced at session-birth time —
  // same chokepoint future code paths must use if they ever want to
  // designate a main project for an existing session. Lazy-require
  // dodges the sessions↔artifacts circular at module-load time.
  if (mainProject) {
    try {
      const artifacts = require('./artifacts');
      artifacts.setMainProject(record, mainProject);
    } catch (err) {
      // Fall through with a logged warning rather than aborting the
      // spawn: the project dir was JUST created by _spawnViaNewDir /
      // _kickoffGitCloneAsync above, so a failure here is either a
      // legit race (clone-pending dir staged moments earlier) or a
      // genuine bug worth surfacing. The session is still usable; the
      // user can hand-edit /data/sessions.json to recover.
      console.error(`[bug-66] setMainProject("${mainProject}") refused at spawn for ${id}: ${err && err.message ? err.message : err}`);
    }
  }
  if (cloneState) record.cloneState = cloneState;
  if (cloneUrl) record.cloneUrl = cloneUrl;
  putSession(record);

  // Inject the myco best-practices template into the project's CLAUDE.md
  // BEFORE spawning claude so the new session reads them as part of its
  // project instructions. Idempotent — uses a sentinel pair so repeat
  // spawns don't duplicate, and a hand-edited section keeps the user's
  // local changes (we never rewrite an existing sentinel block).
  // fr-94: when mainProject is set, the CLAUDE.md lives at
  // <absCwd>/<mainProject>/CLAUDE.md (the project root); otherwise at
  // session-root <absCwd>/CLAUDE.md (legacy).
  // fr-94 Phase 3: for the gitCloneUrl branch the project dir is
  // pre-created EMPTY and the clone is in flight. Injecting CLAUDE.md
  // here would make the dir non-empty and `git clone <url> <dir>`
  // would fail with "destination not empty". Skip the pre-spawn
  // inject for the clone-pending case; _runGitCloneInBackground
  // injects CLAUDE.md AFTER the clone completes (next iteration's
  // SDK options.cwd read picks it up).
  const claudeMdRoot = mainProject ? path.join(absCwd, mainProject) : absCwd;
  if (cloneState !== 'pending') {
    injectBestPracticesIntoClaudeMd(claudeMdRoot);
  }

  const { spawnAgent } = require('./agent-session');
  // fr-26: pass session owner so AgentSession can resolve GitHub
  // identity → GIT_AUTHOR_* / GIT_COMMITTER_* env for the SDK.
  // fr-94 Phase 1: when mainProject is set, the agent runs IN that
  // project subdir so tools like Edit/Read/Bash + claude's
  // process.cwd() all anchor to the actual project, not the
  // session root wrapper. claudeMdRoot computed above mirrors the
  // same choice.
  const agentCwd = resolveAgentCwd(record);
  // fr-102: forward rec.modelOverride at spawn so a record seeded with
  // a non-default model (via /model before the first turn) takes effect
  // on iteration 1. The bare-spawn case (no override seeded yet) passes
  // null and the SDK uses its default model.
  const session = spawnAgent(id, {
    cwd: agentCwd, cols, rows, user,
    modelOverride: record.modelOverride || null,
  });
  ptyMod._registerExternalSession(id, session);
  return { id, cwd: record.cwd, mode };
}

// Best-practices block written into a project's CLAUDE.md. Wrapped in
// sentinel comments so subsequent spawns (or `ensureLiveSession`) can
// detect "already present" and no-op. The template body itself is read
// from web/public/best-practices-template.md so the docs the UI banner
// shows are byte-identical to what claude reads from CLAUDE.md.
const BP_SENTINEL_START = '<!-- myco-best-practices-start -->';
const BP_SENTINEL_END = '<!-- myco-best-practices-end -->';
const BP_TEMPLATE_PATH = path.join(__dirname, '..', '..', 'web', 'public', 'best-practices-template.md');

function _readBestPracticesTemplate() {
  try {
    const md = fs.readFileSync(BP_TEMPLATE_PATH, 'utf8').trim();
    return md || null;
  } catch (err) {
    console.error(`[best-practices] template read failed (${BP_TEMPLATE_PATH}): ${err.message}`);
    return null;
  }
}

function injectBestPracticesIntoClaudeMd(absCwd) {
  if (!absCwd) return;
  const template = _readBestPracticesTemplate();
  if (!template) return;

  const claudeMdPath = path.join(absCwd, 'CLAUDE.md');
  let existing = '';
  try { existing = fs.readFileSync(claudeMdPath, 'utf8'); }
  catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[best-practices] read ${claudeMdPath} failed: ${err.message}`);
      return;
    }
  }

  // Idempotent: if the sentinel is already in the file, leave it alone
  // — we don't want to overwrite a user-edited block, and re-adding
  // an identical block on every spawn would be noise in git history.
  if (existing.includes(BP_SENTINEL_START)) return;

  const block = `${BP_SENTINEL_START}\n${template}\n${BP_SENTINEL_END}\n`;
  const newContent = existing
    ? existing.replace(/\s+$/, '') + '\n\n' + block
    : block;

  try {
    fs.writeFileSync(claudeMdPath, newContent);
    console.log(`[best-practices] injected into ${claudeMdPath}`);
  } catch (err) {
    console.error(`[best-practices] write ${claudeMdPath} failed: ${err.message}`);
  }
}

async function ensureLiveSession(sessionId) {
  const live = ptyMod.getSession(sessionId);
  if (live && live.alive) return live;
  const rec = getSessionRecord(sessionId);
  if (!rec) throw new Error(`unknown session: ${sessionId}`);

  // SDK Phase 9 step 2: every session is an AgentSession. Legacy records
  // (rec.mode unset, rec.mode='pty') are migrated in place — their
  // pre-Phase-8 claudeSessionId becomes the sdkSessionId so the SDK's
  // resume picks up the same JSONL transcript (the SDK + claude-cli
  // share the ~/.claude/projects/<enc>/<uuid>.jsonl storage).
  if (rec.mode !== 'agent') {
    rec.mode = 'agent';
    if (!rec.sdkSessionId && rec.claudeSessionId) rec.sdkSessionId = rec.claudeSessionId;
    saveStore();
    console.log(`[ensureLive] migrated ${sessionId} mode=(unset)→agent sdk=${(rec.sdkSessionId || '').slice(0,8) || 'none'}`);
  }
  const liveCwd = resolveAgentCwd(rec);
  // One-shot lazy migration of the SDK's auto-memory dir from the
  // pre-2026-05-15 default ($HOME/.claude/projects/<encoded-cwd>/
  // memory/) into the per-session folder (<absCwd>/.claude/memory/).
  // Runs before spawnAgent so the SDK's first read finds the migrated
  // files. Idempotent — once the destination exists we skip.
  try {
    const migrated = _migrateLegacyMemory(liveCwd);
    if (migrated) console.log(`[ensureLive] migrated ${migrated} memory file(s) into ${liveCwd}/.claude/memory/ for ${sessionId}`);
  } catch (err) {
    console.error(`[ensureLive] memory migration failed for ${sessionId}: ${err.message}`);
  }
  // Top up the project's CLAUDE.md before resume. Idempotent (no-op if
  // the sentinel already exists). Catches the case where the project
  // was set up before this feature shipped, or someone hand-deleted the
  // block — claude reads CLAUDE.md on every (re)spawn so the resumed
  // session picks up the fresh content.
  if (rec.cloneState !== 'pending') {
    injectBestPracticesIntoClaudeMd(liveCwd);
  }
  const { spawnAgent } = require('./agent-session');
  const session = spawnAgent(sessionId, {
    cwd: liveCwd,
    resumeSdkSessionId: rec.sdkSessionId || null,
    // fr-26: re-seed git identity on respawn.
    user: rec.user || null,
    // fr-102: re-seed the model override so a session that picked a
    // non-default model keeps it across container restarts / reaper
    // re-spawns. Without this, every respawn would silently revert to
    // the SDK default while rec.modelOverride sat stale on disk.
    modelOverride: rec.modelOverride || null,
  });
  ptyMod._registerExternalSession(sessionId, session);
  console.log(`[ensureLive] respawned agent for ${sessionId} cwd=${liveCwd} resume=${rec.sdkSessionId || 'none'}`);
  // Zombie menu cleanup. A respawned AgentSession has a fresh
  // _pendingPermissions Map (no in-flight canUseTool callbacks carry
  // across a server restart). Any chat row still flagged kind=menu
  // without answered/superseded refers to a promise that no live
  // receiver can resolve — clicking it would just log handled=false and
  // the modal queue would keep showing it forever. Stamp them all
  // .superseded so the user's chat is a clean slate after a deploy.
  try {
    if (typeof ptyMod._supersedeStaleMenus === 'function') {
      ptyMod._supersedeStaleMenus(sessionId);
      console.log(`[ensureLive] swept stale chat menus for respawned agent ${sessionId}`);
    }
  } catch (err) {
    console.error(`[ensureLive] supersede sweep failed: ${err.message}`);
  }
  return session;
}

// bug-66: Best-effort workspace purge on session delete. Removes the
// session's absCwd from disk so a subsequent create-with-same-project
// clones cleanly into an empty target. Without this, `/wks/<user>/`
// accumulates orphan `myco-<user>-<id>/` dirs forever, and any flow
// that lands at a previously-used path (respawn/reattach, future
// id-reuse) trips git clone's "destination not empty" guard.
//
// Defensive — refuses to act when:
//   · rec.absCwd is missing or not a string
//   · path is NOT strictly under userRoot(rec.user) (no traversal)
//   · basename doesn't match `myco-<rec.user>-<8 hex>` exactly
//     (the id-as-folder shape from spawnSession). Legacy hand-named
//     cwds like `test006` / `myco` are deliberately left alone.
//   · basename's user-segment doesn't match rec.user (rejects forged
//     rec whose absCwd points into another user's tree)
//
// Also best-effort drops the legacy SDK transcript mirror at
// $HOME/.claude/projects/<encoded-cwd>/ so importExistingTranscripts
// can't resurrect a deleted session's transcripts.
//
// Never throws — failures log and the caller proceeds. Auth is
// enforced by the caller (HTTP DELETE /sessions/:id is owner-only);
// this helper trusts its argument.
function _removeWorkspaceForDeletedSession(rec) {
  if (!rec || typeof rec.absCwd !== 'string' || !rec.absCwd) return;
  const user = rec.user || 'default';
  const absCwd = path.resolve(rec.absCwd);
  const root = path.resolve(userRoot(user));
  if (!absCwd.startsWith(root + path.sep)) {
    console.warn(`[bug-66] refusing to rm ${absCwd} — outside ${root}`);
    return;
  }
  const idShape = new RegExp(
    `^myco-${user.replace(/[^a-zA-Z0-9_-]/g, '')}-[0-9a-f]{8}$`
  );
  if (!idShape.test(path.basename(absCwd))) {
    console.warn(`[bug-66] refusing to rm ${absCwd} — basename not id-shape for user=${user}`);
    return;
  }
  try {
    fs.rmSync(absCwd, { recursive: true, force: true });
    console.log(`[bug-66] purged workspace ${absCwd}`);
  } catch (err) {
    console.error(`[bug-66] rm ${absCwd} failed: ${err.message}`);
  }
  // Best-effort: drop the legacy SDK transcript mirror so
  // importExistingTranscripts can't resurface deleted-session
  // transcripts. The mirror is often absent for modern sessions
  // (per-session .claude/memory/); when present, this prevents
  // a `dismissed[]` mishap from auto-reimporting later.
  try {
    const mirror = path.join(projectsDir(), encodeCwdForClaude(absCwd));
    if (fs.existsSync(mirror)) {
      fs.rmSync(mirror, { recursive: true, force: true });
      console.log(`[bug-66] purged transcript mirror ${mirror}`);
    }
  } catch (err) {
    console.error(`[bug-66] transcript mirror rm failed: ${err.message}`);
  }
}

// Caller MUST verify ownership before calling. There is no internal
// auth check — the HTTP DELETE /sessions/:id route enforces
// owner-only via sessionBelongsToUser (admins promoted via
// `/admin @user` do NOT inherit delete). New internal callers MUST
// enforce the same contract.
function deleteSession(sessionId) {
  ptyMod.killSession(sessionId);
  // bug-66: snapshot rec BEFORE removeSession drops the registry key
  // so the workspace-purge helper can see absCwd/user. Order:
  //   1. kill agent (no live writes mid-rm)
  //   2. snapshot rec
  //   3. drop registry entry (subsequent attaches 404 immediately)
  //   4. purge disk
  const rec = getSessionRecord(sessionId);
  removeSession(sessionId);
  if (rec) _removeWorkspaceForDeletedSession(rec);
}

// One-shot importer: walk ~/.claude/projects/, find transcripts whose `cwd`
// lives under <WORKSPACE>/<user>/, and create a resumable session record for
// each cwd that doesn't already have one.
async function importExistingTranscripts() {
  const root = projectsDir();
  let dirs;
  try { dirs = await fsp.readdir(root); } catch { return 0; }

  const store = loadStore();
  const haveCwds = new Set(Object.values(store.sessions).map((s) => s.absCwd));
  let imported = 0;

  for (const d of dirs) {
    const dir = path.join(projectsDir(), d);
    let stat;
    try { stat = await fsp.stat(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const newest = await findNewestJsonl(dir);
    if (!newest) continue;

    const cwd = await readCwdFromTranscript(newest.full);
    if (!cwd) continue;
    if (haveCwds.has(cwd)) continue;

    if (store.dismissed && store.dismissed.includes(cwd)) continue;

    // bug-80: skip transcripts whose cwd lives INSIDE another already-
    // registered session's workspace. These are subagent / sub-shell
    // runs of the parent session, NOT separate sessions — pre-fix they
    // got auto-registered as duplicate sidebar entries (user-reported:
    // `myco-kkrazy-4cf7dcac/omni-cache` shown alongside `omni-cache`).
    // The parent session keeps its own absCwd, so the user's view of
    // their workspace stays canonical.
    const enclosing = _findEnclosingSession(cwd, store);
    if (enclosing) {
      console.log(`[bug-80] importExistingTranscripts: skipping ${cwd} — enclosed by ${enclosing.id} (absCwd=${enclosing.absCwd})`);
      continue;
    }

    const rel = path.relative(WORKSPACE, cwd);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const segs = rel.split(path.sep).filter(Boolean);
    if (segs.length < 1) continue;
    const user = segs[0].replace(/[^a-zA-Z0-9_-]/g, '');
    if (!user) continue;
    const userRel = segs.slice(1).join('/') || '.';

    const claudeId = newest.file.replace(/\.jsonl$/, '');
    // findNewestJsonl already filters by UUID shape, but keep this guard
    // explicit so the auto-import path can never silently introduce a
    // non-resumable id (subagent leak, future schema drift).
    if (!isClaudeSessionId(claudeId)) continue;
    const id = `myco-${user}-${shortId()}`;
    store.sessions[id] = {
      id,
      user,
      cwd: userRel,
      absCwd: cwd,
      claudeSessionId: claudeId,
      createdAt: new Date(newest.mtimeMs).toISOString(),
    };
    haveCwds.add(cwd);
    imported += 1;
  }

  if (imported) saveStore();
  return imported;
}

// ─── chat ─────────────────────────────────────────────────────────────────────

// Chat history cap — older messages get trimmed (oldest first) when
// the array exceeds this. PERSISTED history is intentionally kept
// effectively-unbounded so a user scrolling back via the load-older
// button reaches ALL of their conversation, not just the recent
// window. The CLIENT-SIDE in-memory cap (MAX_CHAT_BYTES = 16 KB in
// web/public/app.js) is what gates the chat pane's memory footprint;
// older history is fetched on demand via
// GET /sessions/:id/chat/history?before=&limit=.
//
// History timeline of MAX_CHAT_MESSAGES:
//   pre-v1: 200       — short sessions only
//   v1:     500       — multi-hour sessions (~40 KB per rec.chat)
//   v2:     100_000   — current. Effectively-unbounded for normal
//                       usage (a user typing 1 msg/min would take
//                       2.3 months to hit it). At ~80 bytes / msg
//                       that's ~8 MB per session — still reasonable
//                       for sessions.json. If usage proves this is
//                       still too tight, the next step is splitting
//                       chat-history into a per-session jsonl file
//                       under <cwd>/_myco_/chat-history.jsonl so
//                       sessions.json stays small.
const MAX_CHAT_MESSAGES = 100000;

// bug-9 / round 5: tight rolling cap. Initial frame is a TINY 1 KB
// (just enough to land the user in recent context immediately); the
// chat pane holds AT MOST 16 KB in memory at any time. The user
// scrolls up to load older windows; live messages append and drop
// oldest as needed to stay under the 16 KB ceiling.
//
// History timeline of the cap (each round was user-driven tighter):
//   round 1: 100 messages              — too slow on long sessions
//   round 2: 25 messages               — better, but variable
//   round 3: 256 KB byte budget        — predictable, but heavy paint
//   round 4: 8 KB initial + 64 KB total — two-phase (perceptually
//                                         fast, but the backfill
//                                         re-render was visible)
//   round 5: 1 KB initial, 16 KB rolling cap. No auto-backfill. User
//           scrolls up to fetch more via /chat/history?before=. The
//           client-side state.chatMessages cap drops the oldest when
//           live messages would push it over 16 KB.
//
// rec.chat on disk (and the MAX_CHAT_MESSAGES=500 entry cap below)
// is unchanged — only the wire payload + in-memory client state are
// bounded.
// 2026-05-17 user-set: 8 KB initial chat-history (was 1 KB). Gives
// the user roughly 30-50 messages at first paint instead of 5-8 —
// enough to see the recent conversation context without scroll-up.
// 2026-06-10 user-set: 64 KB (was 8 KB). User-reported on omni-cache
// session "kept losing the myco response in the chat pane" — root
// cause investigation (logs `[chat-history] initial sent 49 of 220`
// + `assistant_text (2838 chars)`): claude responses are now
// multi-KB by default; an 8 KB budget fits only ~3 large replies on
// initial reattach, so each page-reload / session-switch + back / tab
// resume dropped most context from view. 64 KB (8x) lets ~24+ recent
// claude replies fit on first paint with negligible first-paint
// impact (~10-20 ms on modern bandwidth). Initial chat-history is
// still strictly a TAIL — older history loads via the "load older"
// button (/chat/history?before=). rec.chat persistence is unchanged.
const INITIAL_CHAT_HISTORY_BYTES = 64 * 1024;
const DEFAULT_CHAT_HISTORY_BYTES = 16 * 1024;
// bug-86 (option B, 2026-06-10): minimum assistant_text bubbles guaranteed
// on initial chat-history attach, even when the byte budget would
// otherwise cut them off. Companion to the 64K budget bump (option A) —
// option A makes the typical case better (most claude replies are 2-3KB);
// option B handles the pathological case (a single 80KB ./test/test.sh
// reply would have eaten the whole budget). 5 is enough for the user
// to see ~half a conversation's recent context with claude on first
// paint.
const INITIAL_CHAT_HISTORY_MIN_ASSISTANT_TEXTS = 5;

// Legacy alias — some callsites + tests still reference the old
// LIMIT constant. Keep it as a small fixed count (used by the
// paginated /chat/history?limit= route when the client wants a
// fixed-size window for "load older N"). Independent of the byte
// budget above which gates the INITIAL attach frame.
const DEFAULT_CHAT_HISTORY_LIMIT = 50;

// Read the chat history with optional windowing.
//
//   opts.maxBytes      byte budget — walk from the tail and keep adding
//                      messages as long as cumulative JSON size <= budget.
//                      Used by the chat-history WS frame on attach so the
//                      first paint is bounded regardless of message sizes.
//   opts.limit         max messages to return (count). Used by the
//                      load-older paginator when the client wants a fixed-
//                      size window.
//   opts.before        ISO ts — return only messages strictly older than
//                      this. Used by the load-older paginator.
//   opts.afterSeq      integer — return only messages with
//                      meta.seq STRICTLY greater than this. Used by
//                      the reconnect catch-up path: client passes
//                      its last-seen seq, server returns only the
//                      gap (no byte/limit truncation needed, since
//                      the gap is bounded by what was missed).
//   opts.includeAgent  boolean — when true, mirrored claude-text rows
//                      (meta.fromAgent:true / meta.fromTranscript:true)
//                      are INCLUDED in the result. Default false.
//                      Used by the load-older paginator: when the user
//                      scrolls back past the byte budget that
//                      agent-replay shipped, fromAgent rows are the
//                      ONLY surviving record of claude's older replies
//                      (agent-replay shipped only the tail bytes). The
//                      client renders them as plain chat-msg bubbles —
//                      no duplicate-render risk because the events.jsonl
//                      / session.buffer tail doesn't reach that far back.
//
// When BOTH maxBytes and limit are set, the smaller of the two
// effective windows wins (whichever produces fewer messages).
//
// Default (includeAgent=false) filters meta.fromTranscript:true AND
// meta.fromAgent:true rows before slicing — those are durable mirrors
// of the assistant_text stream that the agent-event/agent-replay
// channel already renders as cards. Surfacing them here too would
// duplicate-render (chat bubble next to agent-text card). Storage is
// preserved in rec.chat for forensic / paginated retrieval — only the
// default wire frame to clients is filtered.
//
// Result is always chronologically ordered (oldest → newest within
// the returned window), matching the existing chat-history contract.
function getChatHistory(sessionId, opts) {
  opts = opts || {};
  const rec = loadStore().sessions[sessionId];
  if (!rec || !Array.isArray(rec.chat)) return [];
  const includeAgent = !!opts.includeAgent;
  // Drop assistant-text rows mirrored from EITHER channel:
  //  - meta.fromTranscript === true (pre-SDK JSONL transcript watcher,
  //    `persistAssistantTextToChat` in attach.js)
  //  - meta.fromAgent     === true (SDK-era persistence backstop,
  //    `_persistAssistantTextToRecChat` in agent-session.js)
  // Both kinds are re-rendered as cards via the agent-event /
  // agent-replay stream on every attach. Sending them here too as
  // generic chat-msg bubbles produces the visible duplicate observed
  // in #chat-messages (chat bubble + agent card, same text). Storage
  // is preserved in rec.chat for historical inspection / forensic
  // tooling — only the wire frame to clients is filtered.
  let filtered = includeAgent
    ? rec.chat.slice()
    : rec.chat.filter((m) => !(m && m.meta && (m.meta.fromTranscript === true || m.meta.fromAgent === true)));
  if (opts.before) {
    const beforeTs = String(opts.before);
    filtered = filtered.filter((m) => m && m.ts && String(m.ts) < beforeTs);
  }
  if (typeof opts.afterSeq === 'number' && opts.afterSeq >= 0) {
    // Catch-up window: only rows with seq strictly greater than the
    // caller's last-seen seq. No byte/limit clamp afterward — the gap
    // is bounded by what was actually missed.
    filtered = filtered.filter((m) => m && m.meta && typeof m.meta.seq === 'number' && m.meta.seq > opts.afterSeq);
  }
  // Byte budget first — walks tail → head accumulating JSON-stringify
  // sizes; keeps the most-recent prefix that fits. ALWAYS keeps at
  // least one message so a single oversized row doesn't return an
  // empty window (it just costs whatever it costs — the user still
  // gets to see the most recent activity).
  //
  // bug-86 (option B, 2026-06-10): on top of the byte budget, optionally
  // GUARANTEE at least N recent assistant_text bubbles in the result.
  // Companion to the 64K initial-budget bump (option A): even if a single
  // assistant_text reply is >64K (rare but possible — full ./test/test.sh
  // output, long planning docs), the user still gets the last N replies
  // on first paint. Walks tail → head counting assistant_texts; finds
  // the earliest index that captures N of them; takes the EARLIER of
  // (byte-budget floor, assistantFloor) as the slice point. The user-
  // reported "kept losing the myco response" framed this: persistence
  // is fine; the question is which slice ships on reattach.
  let keepFromIdx = filtered.length;
  if (typeof opts.maxBytes === 'number' && opts.maxBytes > 0 && filtered.length) {
    let bytes = 0;
    for (let i = filtered.length - 1; i >= 0; i--) {
      let sz;
      try { sz = JSON.stringify(filtered[i]).length; } catch { sz = 0; }
      if (bytes && bytes + sz > opts.maxBytes) break;
      bytes += sz;
      keepFromIdx = i;
    }
  }
  // bug-86: assistant_text floor. Both fromTranscript AND fromAgent are
  // claude replies (different persistence backstops — see comment above
  // about filter logic). Count both kinds toward the guarantee.
  if (typeof opts.minAssistantTexts === 'number' && opts.minAssistantTexts > 0 && filtered.length) {
    let asstCount = 0;
    for (let i = filtered.length - 1; i >= 0; i--) {
      const m = filtered[i];
      if (m && m.meta && (m.meta.fromAgent === true || m.meta.fromTranscript === true)) {
        asstCount++;
        if (asstCount >= opts.minAssistantTexts) {
          // i is the earliest assistant_text in the guaranteed set —
          // take the earlier of (byte floor, assistant floor) so both
          // constraints are satisfied.
          if (i < keepFromIdx) keepFromIdx = i;
          break;
        }
      }
    }
    // If fewer than N assistant_texts exist in the whole history,
    // asstCount < opts.minAssistantTexts — and we naturally end up
    // including all of them (or whatever the byte budget already
    // covered). That's fine: "guarantee N" reads as "up to N if
    // they exist."
  }
  if (keepFromIdx < filtered.length) {
    filtered = filtered.slice(keepFromIdx);
  }
  if (typeof opts.limit === 'number' && opts.limit > 0 && filtered.length > opts.limit) {
    filtered = filtered.slice(-opts.limit);
  }
  return filtered;
}

// Convenience: how many filtered messages exist total. Used by the
// /chat/history route so the client can render a "showing N of M"
// hint + know when there are no more older windows to fetch.
// Count of messages getChatHistory would return for the given opts.
// `opts.includeAgent` mirrors getChatHistory's parameter — when true,
// fromAgent / fromTranscript rows count too. Used by /chat/history so
// the client knows whether to show a "load older" button.
function getChatHistoryLength(sessionId, opts) {
  opts = opts || {};
  const includeAgent = !!opts.includeAgent;
  const rec = loadStore().sessions[sessionId];
  if (!rec || !Array.isArray(rec.chat)) return 0;
  if (includeAgent) return rec.chat.length;
  let n = 0;
  // Same filter contract as getChatHistory — drop both fromTranscript
  // and fromAgent mirrors so the visible "showing N of M" matches the
  // window of rows we'd actually ship by default.
  for (const m of rec.chat) {
    if (m && m.meta && (m.meta.fromTranscript === true || m.meta.fromAgent === true)) continue;
    n++;
  }
  return n;
}

// Allocate the next monotonic sequence number for a session.
// rec.seqCounter is the per-session in-memory counter (initialized
// lazily from max(rec.chat[].meta.seq) on first call). Used to stamp
// every chat-msg + every agent-event with a strictly increasing
// integer so the client can sort by seq instead of ts (which is
// fragile under clock drift / out-of-order deliveries / missing ts).
//
// agent-events bump the counter in-memory only (no saveStore call —
// disk write per event is expensive). On respawn, the counter is
// rehydrated from max(rec.chat seq) + AgentSession._hydrateBufferFromDisk
// calls bumpSeqAtLeast(maxBufferSeq) to account for events that
// landed since the last chat-msg append.
//
// Chat-msg appends DO call saveStore (already happening for the
// rec.chat write) so the counter persists to disk every time it
// matters for cross-restart durability.
function _initSeqCounter(rec) {
  if (typeof rec.seqCounter === 'number') return;
  let max = 0;
  if (Array.isArray(rec.chat)) {
    for (const c of rec.chat) {
      const s = c && c.meta && c.meta.seq;
      if (typeof s === 'number' && s > max) max = s;
    }
  }
  rec.seqCounter = max;
}

function allocSeq(sessionId) {
  const store = loadStore();
  const rec = store.sessions[sessionId];
  if (!rec) return 0;
  _initSeqCounter(rec);
  rec.seqCounter += 1;
  return rec.seqCounter;
}

// Ensure the in-memory counter is at LEAST `minSeq`. Called by
// AgentSession after hydrating its event buffer from disk so seq
// allocations don't collide with events persisted before the last
// process exit.
function bumpSeqAtLeast(sessionId, minSeq) {
  const store = loadStore();
  const rec = store.sessions[sessionId];
  if (!rec) return 0;
  _initSeqCounter(rec);
  if (typeof minSeq === 'number' && minSeq > rec.seqCounter) rec.seqCounter = minSeq;
  return rec.seqCounter;
}

function appendChatMessage(sessionId, msg) {
  const store = loadStore();
  const rec = store.sessions[sessionId];
  if (!rec) return null;
  if (!Array.isArray(rec.chat)) rec.chat = [];
  // Stamp meta.seq if the caller didn't provide one. Live arrival
  // order = persisted seq order = render order.
  if (!msg.meta) msg.meta = {};
  if (typeof msg.meta.seq !== 'number') {
    _initSeqCounter(rec);
    rec.seqCounter += 1;
    msg.meta.seq = rec.seqCounter;
  } else {
    // Caller-provided seq — make sure the counter doesn't fall behind.
    _initSeqCounter(rec);
    if (msg.meta.seq > rec.seqCounter) rec.seqCounter = msg.meta.seq;
  }
  rec.chat.push(msg);
  if (rec.chat.length > MAX_CHAT_MESSAGES) {
    rec.chat = rec.chat.slice(-MAX_CHAT_MESSAGES);
  }
  saveStore();
  return msg;
}

// Wipe the discussion-pane chat history for a session and persist.
// Returns the number of messages removed (0 if the session is missing
// or had no chat yet). The /clear slash command pairs this with a
// `state-update { kind: 'chat-clear' }` broadcast so live clients wipe
// their local list — without that broadcast, attached panes would keep
// rendering the now-orphaned messages until reload.
function clearChatHistory(sessionId) {
  const store = loadStore();
  const rec = store.sessions[sessionId];
  if (!rec) return 0;
  const n = Array.isArray(rec.chat) ? rec.chat.length : 0;
  rec.chat = [];
  saveStore();
  return n;
}

// ─── per-file Claude threads (file viewer) ──────────────────────────────────
//
// Schema: rec.fileChats = { "<relPath>": { messages: [...], lastTouched } }
// Caps: 50 messages per file (FIFO), 50 files per session (drop oldest by
// lastTouched). Each message: { id, user, text, ts, anchor }.

const MAX_FILE_CHAT_MESSAGES = 50;
const MAX_FILES_PER_SESSION = 50;

function ensureFileChatBag(rec) {
  if (!rec.fileChats || typeof rec.fileChats !== 'object') rec.fileChats = {};
  return rec.fileChats;
}

function getFileChat(sessionId, relPath) {
  const rec = loadStore().sessions[sessionId];
  if (!rec || !rec.fileChats) return [];
  const t = rec.fileChats[relPath];
  return (t && Array.isArray(t.messages)) ? t.messages : [];
}

function getRecentFileChatMessages(sessionId, relPath, n) {
  const all = getFileChat(sessionId, relPath);
  return all.slice(-Math.max(0, n | 0));
}

function appendFileChatMessage(sessionId, relPath, msg) {
  const store = loadStore();
  const rec = store.sessions[sessionId];
  if (!rec) return null;
  const bag = ensureFileChatBag(rec);
  if (!bag[relPath]) bag[relPath] = { messages: [], lastTouched: Date.now() };
  bag[relPath].messages.push(msg);
  if (bag[relPath].messages.length > MAX_FILE_CHAT_MESSAGES) {
    bag[relPath].messages = bag[relPath].messages.slice(-MAX_FILE_CHAT_MESSAGES);
  }
  bag[relPath].lastTouched = Date.now();
  // Per-session file-count cap: drop the least recently touched file thread.
  const paths = Object.keys(bag);
  if (paths.length > MAX_FILES_PER_SESSION) {
    paths.sort((a, b) => (bag[a].lastTouched || 0) - (bag[b].lastTouched || 0));
    const toDrop = paths.slice(0, paths.length - MAX_FILES_PER_SESSION);
    for (const p of toDrop) delete bag[p];
  }
  saveStore();
  return msg;
}

function deleteFileChatMessage(sessionId, relPath, messageId) {
  const store = loadStore();
  const rec = store.sessions[sessionId];
  if (!rec || !rec.fileChats || !rec.fileChats[relPath]) return false;
  const t = rec.fileChats[relPath];
  const before = t.messages.length;
  t.messages = t.messages.filter((m) => m.id !== messageId);
  const removed = t.messages.length < before;
  if (removed) {
    if (t.messages.length === 0) delete rec.fileChats[relPath];
    else t.lastTouched = Date.now();
    saveStore();
  }
  return removed;
}

// Use Object.assign so the existing module.exports object is mutated rather
// than replaced. pty.js captures this exports object during the circular
// require, so a replacement would leave its reference pointing at the empty
// initial object.
Object.assign(module.exports, {
  WORKSPACE,
  getWorkspace,
  workspaceName,
  listWorkspaceDirs,
  listSessions,
  spawnSession,
  // fr-106: exported for the slash-command dispatcher in attach.js so
  // slash commands (/git, /feature, /setpat, etc.) inherit the same
  // project-dir cwd the SDK uses for Claude's tools. Pre-fr-106 the
  // dispatcher used rec.absCwd directly, so /git ran from the session
  // workspace wrapper even when rec.mainProject designated a project
  // subdir — forcing users to type /git -C 'main project' every time.
  resolveAgentCwd,
  // bug-80: exported for the regression test + future audit/cleanup
  // tools that want to surface "is this session enclosed by another?"
  // or run an ad-hoc cleanup.
  _findEnclosingSession,
  _normalizeNestedSessions,
  // bug-84: shared with GET /sessions enrichment + the regression
  // test. Mirrors fr-98's attach-replay precondition so the sidebar
  // badge and the replay are guaranteed to agree.
  hasPendingVerdict,
  ensureLiveSession,
  sessionBelongsToUser,
  deleteSession,
  // fr-39: per-session admin delegation
  getSessionAdmins,
  isOwnerOrAdmin,
  addAdminToSession,
  removeAdminFromSession,
  // fr-87: per-session viewer delegation (read-only counterpart of admin)
  getSessionViewers,
  isOwnerAdminOrViewer,
  // bug-47 r3: tier-aware version of isOwnerAdminOrViewer — returns
  // 'owner' | 'viewer' | null. Used by fileApiPreamble in index.js so
  // the access rules live in ONE place.
  resolveAccessTier,
  addViewerToSession,
  removeViewerFromSession,
  // fr-86: soft-reset support for /clear new (keeps rec.chat, nulls sdkSessionId)
  markSessionForRestart,
  // fr-38: per-session strict-mode gate (requires [run:plan#<id>] marker on claude-bound messages)
  isSessionStrict,
  setSessionStrict,
  importExistingTranscripts,
  getChatHistory,
  getChatHistoryLength,
  appendChatMessage,
  clearChatHistory,
  allocSeq,
  bumpSeqAtLeast,
  DEFAULT_CHAT_HISTORY_LIMIT,
  DEFAULT_CHAT_HISTORY_BYTES,
  INITIAL_CHAT_HISTORY_BYTES,
  INITIAL_CHAT_HISTORY_MIN_ASSISTANT_TEXTS,
  // exposed for summarizer + share-info
  loadStore,
  saveStore,
  projectsDir,
  encodeCwdForClaude,
  isClaudeSessionId,
  findNewestJsonl,
  readActiveClaudeSessionForCwd,
  captureClaudeSessionId,
  getSessionRecord,
  readDescriptionForCwd,
  resolveCwd,
  // file-viewer Claude threads
  getFileChat,
  getRecentFileChatMessages,
  appendFileChatMessage,
  deleteFileChatMessage,
  // best-practices injection — exposed for tests + manual back-fill
  // tools. Idempotent via the sentinel block in the target CLAUDE.md.
  injectBestPracticesIntoClaudeMd,
  // Exposed for the memory-migration regression test.
  _migrateLegacyMemory,
  // bug-66: exposed for the workspace-purge regression test.
  _removeWorkspaceForDeletedSession,
});
