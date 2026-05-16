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

function shortId() { return crypto.randomBytes(4).toString('hex'); }

function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function listSessions(forUser) {
  const all = Object.values(loadStore().sessions);
  const filtered = forUser ? all.filter((r) => r.user === forUser) : all;
  return Promise.all(filtered.map(async (r) => {
    const info = await readDescriptionForCwd(r.absCwd, r);
    // Display label preference: explicit rec.label (set on spawn) →
    // r.cwd for legacy sessions whose cwd was the user-typed name →
    // id-shortid as a last resort. The client renders s.name as the
    // session-list title.
    const displayName = r.label || r.cwd || r.id;
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
    };
  }));
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

  const record = { id, user, cwd: toRel(absCwd, user), absCwd, label, claudeSessionId: null, createdAt, mode };
  putSession(record);

  // Inject the myco best-practices template into the project's CLAUDE.md
  // BEFORE spawning claude so the new session reads them as part of its
  // project instructions. Idempotent — uses a sentinel pair so repeat
  // spawns don't duplicate, and a hand-edited section keeps the user's
  // local changes (we never rewrite an existing sentinel block).
  injectBestPracticesIntoClaudeMd(absCwd);

  const { spawnAgent } = require('./agent-session');
  const session = spawnAgent(id, { cwd: absCwd, cols, rows });
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
  // One-shot lazy migration of the SDK's auto-memory dir from the
  // pre-2026-05-15 default ($HOME/.claude/projects/<encoded-cwd>/
  // memory/) into the per-session folder (<absCwd>/.claude/memory/).
  // Runs before spawnAgent so the SDK's first read finds the migrated
  // files. Idempotent — once the destination exists we skip.
  try {
    const migrated = _migrateLegacyMemory(rec.absCwd);
    if (migrated) console.log(`[ensureLive] migrated ${migrated} memory file(s) into ${rec.absCwd}/.claude/memory/ for ${sessionId}`);
  } catch (err) {
    console.error(`[ensureLive] memory migration failed for ${sessionId}: ${err.message}`);
  }
  // Top up the project's CLAUDE.md before resume. Idempotent (no-op if
  // the sentinel already exists). Catches the case where the project
  // was set up before this feature shipped, or someone hand-deleted the
  // block — claude reads CLAUDE.md on every (re)spawn so the resumed
  // session picks up the fresh content.
  injectBestPracticesIntoClaudeMd(rec.absCwd);
  const { spawnAgent } = require('./agent-session');
  const session = spawnAgent(sessionId, {
    cwd: rec.absCwd,
    resumeSdkSessionId: rec.sdkSessionId || null,
  });
  ptyMod._registerExternalSession(sessionId, session);
  console.log(`[ensureLive] respawned agent for ${sessionId} cwd=${rec.absCwd} resume=${rec.sdkSessionId || 'none'}`);
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

function deleteSession(sessionId) {
  ptyMod.killSession(sessionId);
  removeSession(sessionId);
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
// the array exceeds this. Bumped from 200 → 500 so a multi-hour
// working session keeps its full discussion + claude-reply trail
// across restarts. At ~80 bytes per message that's ~40KB per
// session — fine to keep in sessions.json.
const MAX_CHAT_MESSAGES = 500;

// bug-9 / round 2: default initial window when no limit is requested.
// The chat-history WS frame on attach gates on this — 500 messages
// of rendered markdown (with renderMd + mermaid + turn-grouping
// passes) made the chat pane sluggish to open. Round 1 dropped it
// to 100; round 2 (after user feedback that the pane was still
// slow on reload) drops it to 25 — quarter of round 1. The load-
// older button + the paginated /chat/history?before=…&limit=… route
// fetch earlier windows on demand, so cutting the initial window
// further is no info loss; just a faster first paint.
const DEFAULT_CHAT_HISTORY_LIMIT = 25;

// Read the chat history with optional windowing.
//
//   opts.limit   max messages to return (default: full filtered list)
//   opts.before  ISO ts — return only messages strictly older than this
//                (used by the load-older paginator)
//
// Filters meta.fromTranscript:true rows before slicing — those are
// duplicates of the agent-event assistant_text stream and shouldn't
// reach the client as chat-bubbles (see the comment block below).
//
// Result is always chronologically ordered (oldest → newest within
// the returned window), matching the existing chat-history contract.
function getChatHistory(sessionId, opts) {
  opts = opts || {};
  const rec = loadStore().sessions[sessionId];
  if (!rec || !Array.isArray(rec.chat)) return [];
  // Drop assistant-text rows mirrored from the JSONL transcript
  // (meta.fromTranscript === true). The AgentSession event buffer
  // hydrated from <cwd>/_myco_/events.jsonl already replays those as
  // structured 'agent-event' (assistant_text) cards via the
  // agent-replay frame sent on attach; sending them again here as
  // generic chat-msg bubbles produces the visible duplicate observed
  // in #chat-messages (chat bubble + agent card, same text). Storage
  // is preserved in rec.chat for historical inspection / forensic
  // tooling — only the wire frame to clients is filtered.
  let filtered = rec.chat.filter((m) => !(m && m.meta && m.meta.fromTranscript === true));
  if (opts.before) {
    const beforeTs = String(opts.before);
    filtered = filtered.filter((m) => m && m.ts && String(m.ts) < beforeTs);
  }
  if (typeof opts.limit === 'number' && opts.limit > 0 && filtered.length > opts.limit) {
    filtered = filtered.slice(-opts.limit);
  }
  return filtered;
}

// Convenience: how many filtered messages exist total. Used by the
// /chat/history route so the client can render a "showing N of M"
// hint + know when there are no more older windows to fetch.
function getChatHistoryLength(sessionId) {
  const rec = loadStore().sessions[sessionId];
  if (!rec || !Array.isArray(rec.chat)) return 0;
  let n = 0;
  for (const m of rec.chat) if (!(m && m.meta && m.meta.fromTranscript === true)) n++;
  return n;
}

function appendChatMessage(sessionId, msg) {
  const store = loadStore();
  const rec = store.sessions[sessionId];
  if (!rec) return null;
  if (!Array.isArray(rec.chat)) rec.chat = [];
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
  ensureLiveSession,
  sessionBelongsToUser,
  deleteSession,
  importExistingTranscripts,
  getChatHistory,
  getChatHistoryLength,
  appendChatMessage,
  clearChatHistory,
  DEFAULT_CHAT_HISTORY_LIMIT,
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
});
