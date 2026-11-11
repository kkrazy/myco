// delm-10: skill MARKET — a cross-session, cross-user store of skills.
// Complements the per-session personal store (skills.js, at
// <absRoot>/.claude/skills). The market lives in the shared state dir:
//
//   $MYCO_STATE_DIR/skill-market/store.json     — index (mode 0600)
//   $MYCO_STATE_DIR/skill-market/skills/<name>/ — skill dirs (SKILL.md + helpers)
//   $MYCO_STATE_DIR/skill-market/delete-code    — system-level delete
//                                                 verification code (mode 0600,
//                                                 auto-generated on first use)
//
// Delete policy (the security core of this feature):
//   1. The UPLOADING user may delete their own market skill any time.
//   2. Anyone proving knowledge of the system delete code may delete
//      ANY market skill (the operator escape hatch for malicious /
//      stale uploads). The code is compared with
//      crypto.timingSafeEqual (constant-time) and failed attempts are
//      throttled per user (MAX failed tries / window → 429).
// The code is NEVER exposed over any HTTP route — an operator reads it
// from the state file on the host.
//
// Errors use the same tagged-code vocabulary as skills.js:
//   ERR_BAD_INPUT / ERR_NOT_FOUND / ERR_EXISTS / ERR_OUTSIDE /
//   ERR_TOO_LARGE / ERR_PERM / ERR_FORBIDDEN (not the uploader and no
//   valid code) / ERR_THROTTLED.

const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const STATE_DIR = process.env.MYCO_STATE_DIR || path.join(os.homedir(), '.myco');
const MARKET_ROOT = path.join(STATE_DIR, 'skill-market');
const SKILLS_ROOT = path.join(MARKET_ROOT, 'skills');
const STORE_FILE = path.join(MARKET_ROOT, 'store.json');
const DELETE_CODE_FILE = path.join(MARKET_ROOT, 'delete-code');

// Same caps as the personal store (skills.js) — one shared budget.
const MAX_SKILL_BYTES = 256 * 1024;       // per file
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

// Delete-code throttle: max failed code attempts per user per window.
const CODE_FAIL_LIMIT = 10;
const CODE_FAIL_WINDOW_MS = 60 * 1000;
const codeFails = new Map();              // user → { count, windowStart }

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

function assertSkillName(name) {
  const raw = (name == null ? '' : String(name)).trim();
  if (!raw || !SKILL_NAME_RE.test(raw)) {
    throw err('ERR_BAD_INPUT', 'invalid skill name (use letters, digits, . _ -, no spaces or slashes)');
  }
  return raw;
}

// ─── store.json (index of uploads) ───

async function ensureRoots() {
  try {
    await fsp.mkdir(SKILLS_ROOT, { recursive: true });
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
}

async function loadStore() {
  try {
    const raw = await fsp.readFile(STORE_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || !j.skills) return { version: 1, skills: {} };
    return j;
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, skills: {} };
    if (e instanceof SyntaxError) return { version: 1, skills: {} };
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
}

async function saveStore(store) {
  await ensureRoots();
  // 0600 like auth-sessions.json — the index names uploaders; keep it
  // operator-readable only.
  await fsp.writeFile(STORE_FILE, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

// ─── system delete code ───

// Create the delete-code file on first use. Mode 0600, owner-only.
// Returns the code. The code is a 48-hex-char random string.
async function getDeleteCode() {
  try {
    const raw = (await fsp.readFile(DELETE_CODE_FILE, 'utf8')).trim();
    if (raw) return raw;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
      throw e;
    }
  }
  const code = crypto.randomBytes(24).toString('hex');
  await ensureRoots();
  try {
    // 'wx' — never clobber an existing code (race-safe first boot).
    await fsp.writeFile(DELETE_CODE_FILE, code + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') {
      return (await fsp.readFile(DELETE_CODE_FILE, 'utf8')).trim();
    }
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  try { fs.chmodSync(DELETE_CODE_FILE, 0o600); } catch { /* best effort */ }
  return code;
}

// Constant-time code comparison. Length mismatch burns the same path
// as a mismatch (hash both sides first so timingSafeEqual always gets
// equal-length buffers).
function codeMatches(provided, actual) {
  if (typeof provided !== 'string' || !provided) return false;
  const a = crypto.createHash('sha256').update(String(provided).trim()).digest();
  const b = crypto.createHash('sha256').update(String(actual).trim()).digest();
  return crypto.timingSafeEqual(a, b);
}

// Track failed code attempts per user; throw ERR_THROTTLED past the limit.
function noteCodeFailure(user) {
  const now = Date.now();
  let rec = codeFails.get(user);
  if (!rec || now - rec.windowStart > CODE_FAIL_WINDOW_MS) {
    rec = { count: 0, windowStart: now };
    codeFails.set(user, rec);
  }
  rec.count += 1;
}

// True when `user` is currently past the failure limit. Called BEFORE
// the code comparison so a flooded caller can't keep probing (even
// with the correct code) until the window rolls over.
function isThrottled(user) {
  const rec = codeFails.get(user);
  if (!rec) return false;
  if (Date.now() - rec.windowStart > CODE_FAIL_WINDOW_MS) {
    codeFails.delete(user);
    return false;
  }
  return rec.count >= CODE_FAIL_LIMIT;
}

function clearCodeFailures(user) {
  codeFails.delete(user);
}

// ─── safe tree copy (shared by publish + install) ───

// Copy every regular file under `src` into `dst`, refusing symlinks
// (a symlinked helper could point outside the skill dir — publish it
// and a later install would copy whatever it points at, or the SDK
// would read it at runtime), capping depth / file count / bytes.
// Returns { fileCount, size }. No-clobber: any existing file at a
// destination aborts with ERR_EXISTS (whole-dir abort).
async function copyTreeSafe(src, dst, stat, depth = 0) {
  if (depth > 6) return;                        // pathological nesting guard
  const kids = await fsp.readdir(src, { withFileTypes: true });
  for (const k of kids) {
    const ks = path.join(src, k.name);
    const kd = path.join(dst, k.name);
    if (k.isDirectory()) {
      await fsp.mkdir(kd, { recursive: true });
      await copyTreeSafe(ks, kd, stat, depth + 1);
    } else if (k.isFile()) {
      if (stat.fileCount + 1 > MAX_FILES) {
        throw err('ERR_TOO_LARGE', 'skill folder exceeds max file count');
      }
      const st = await fsp.lstat(ks);
      if (st.size > MAX_SKILL_BYTES) {
        throw err('ERR_TOO_LARGE', `file ${k.name} exceeds max size`);
      }
      if (stat.size + st.size > MAX_TOTAL_BYTES) {
        throw err('ERR_TOO_LARGE', 'skill folder exceeds max total size');
      }
      await fsp.mkdir(path.dirname(kd), { recursive: true });
      await fsp.writeFile(kd, await fsp.readFile(ks), { encoding: 'binary', mode: 0o644, flag: 'wx' });
      stat.fileCount += 1;
      stat.size += st.size;
    }
    // Symlinks / sockets / fifos are silently skipped — never copied.
  }
}

// ─── public API ───

// List every market skill. Each entry carries uploader + canDelete
// (uploader === the listing user). marketDeleteCodeConfigured is
// always true once any delete route has run — the UI uses it to offer
// the code-delete path to non-uploaders.
async function listMarket(user) {
  const store = await loadStore();
  const dirents = await fsp.readdir(SKILLS_ROOT, { withFileTypes: true }).catch((e) => {
    if (e.code === 'ENOENT') return [];
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  });
  const skills = [];
  for (const d of dirents) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const mdPath = path.join(SKILLS_ROOT, d.name, 'SKILL.md');
    let md;
    try { md = await fsp.readFile(mdPath, 'utf8'); }
    catch { continue; }               // not a skill without SKILL.md
    const meta = store.skills[d.name] || {};
    let st;
    try { st = await fsp.stat(mdPath); } catch { st = { mtimeMs: 0 }; }
    skills.push({
      name: meta.name || d.name,
      dirName: d.name,
      description: meta.description || '',
      uploader: meta.uploader || 'unknown',
      uploadedAt: meta.uploadedAt || null,
      fileCount: meta.fileCount || 1,
      size: meta.size || Buffer.byteLength(md, 'utf8'),
      mtimeMs: st.mtimeMs,
      canDelete: !!user && meta.uploader === user,
    });
  }
  skills.sort((a, b) => a.dirName.localeCompare(b.dirName));
  return { skills };
}

// Read one market skill's SKILL.md (preview before install).
async function readMarketSkill(dirName) {
  const name = assertSkillName(dirName);
  const mdPath = path.join(SKILLS_ROOT, name, 'SKILL.md');
  let md;
  try { md = await fsp.readFile(mdPath, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') throw err('ERR_NOT_FOUND', 'market skill not found');
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  const store = await loadStore();
  const meta = (store.skills[name] || {});
  // Tolerant front-matter parse (same as skills.js).
  const fm = { name: null, description: null };
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const fmRaw = m ? m[1] : md;
  const nm = /^name:\s*(.+)$/m.exec(fmRaw);
  if (nm) fm.name = nm[1].trim();
  const dm = /^description:\s*(.+)$/m.exec(fmRaw);
  if (dm) fm.description = dm[1].trim();
  return {
    name: fm.name || name,
    dirName: name,
    description: meta.description || fm.description || '',
    uploader: meta.uploader || 'unknown',
    content: md,
  };
}

// Index a freshly copied market skill dir into store.json.
async function _recordInStore(store, { dirName, name, description, user, stat }) {
  store.skills[dirName] = {
    name: name || dirName,
    description: description || '',
    uploader: user,
    uploadedAt: new Date().toISOString(),
    fileCount: stat.fileCount,
    size: stat.size,
  };
  await saveStore(store);
}

// Publish a PERSONAL skill (from a session's .claude/skills) into the
// market. Copies the whole skill dir (multi-file skills supported).
// The publishing user is recorded as the uploader — only they (or the
// system delete code) may remove it later.
async function publishFromSession(absRoot, dirName, user) {
  const srcDir = path.join(absRoot, '.claude', 'skills', assertSkillName(dirName));
  return publishFromDir(srcDir, dirName, user);
}

// Publish from an already-resolved skill dir (any store: session /
// user / global). Follows symlinked source dirs (a user/global-scoped
// skill is materialized in the session store as a symlink — the route
// resolves the real dir via _listSkillsMerged and passes it here).
async function publishFromDir(srcDir, dirName, user) {
  const name = assertSkillName(dirName);
  // The source must be a readable skill: SKILL.md present as a regular
  // file (following symlinks — a scoped skill's SKILL.md is reached
  // through the dir symlink).
  const mdPath = path.join(srcDir, 'SKILL.md');
  let md;
  try {
    const st = await fsp.stat(mdPath);   // follows symlinks
    if (!st.isFile()) throw new Error('not a file');
    md = await fsp.readFile(mdPath, 'utf8');
  } catch (e) {
    throw err('ERR_NOT_FOUND', 'personal skill not found');
  }
  const destDir = path.join(SKILLS_ROOT, name);
  await ensureRoots();
  try { await fsp.mkdir(destDir, { recursive: true }); }
  catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  const stat = { fileCount: 0, size: 0 };
  const store = await loadStore();
  if (store.skills[name]) throw err('ERR_EXISTS', 'a market skill with this name already exists');
  try {
    await copyTreeSafe(srcDir, destDir, stat);
  } catch (e) {
    // Roll back the partial copy so a failed publish doesn't leave a
    // broken dir squatting on the name.
    await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  // Front-matter for the listing.
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const fmRaw = m ? m[1] : md;
  const nm = /^name:\s*(.+)$/m.exec(fmRaw);
  const dm = /^description:\s*(.+)$/m.exec(fmRaw);
  await _recordInStore(store, {
    dirName: name,
    name: nm ? nm[1].trim() : name,
    description: dm ? dm[1].trim() : '',
    user,
    stat,
  });
  return {
    name: nm ? nm[1].trim() : name,
    dirName: name,
    description: dm ? dm[1].trim() : '',
    uploader: user,
    fileCount: stat.fileCount,
    size: stat.size,
  };
}

// Publish a skill directly (no personal copy first). Body shapes mirror
// skills.js createSkill / importSkill:
//   { name, description?, content }            — single SKILL.md / markdown
//   { name?, description?, files: [{path, content}] } — multi-file
async function publishDirect({ name, description, content, files }, user) {
  let dirName, md, stat;
  const store = await loadStore();
  await ensureRoots();

  if (Array.isArray(files) && files.length > 0) {
    if (files.length > MAX_FILES) throw err('ERR_TOO_LARGE', 'too many files in skill folder');
    let total = 0;
    const cleaned = files.map((f) => {
      if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') {
        throw err('ERR_BAD_INPUT', 'each file needs { path, content }');
      }
      const p = assertRelInside(f.path);
      total += Buffer.byteLength(f.content, 'utf8');
      return { path: p, content: f.content };
    });
    if (total > MAX_TOTAL_BYTES) throw err('ERR_TOO_LARGE', 'skill folder exceeds max total size');
    dirName = (typeof name === 'string' && name.trim()) ? assertSkillName(name) : null;
    let inner = cleaned;
    if (!dirName) {
      const tops = new Set(cleaned.map((f) => f.path.split('/')[0]));
      if (tops.size === 1 && cleaned.some((f) => f.path.includes('/'))) {
        dirName = assertSkillName([...tops][0]);
        inner = cleaned.map((f) => ({ path: f.path.split('/').slice(1).join('/'), content: f.content }));
      } else {
        const sk = inner.find((f) => f.path === 'SKILL.md');
        if (!sk) throw err('ERR_BAD_INPUT', 'cannot infer skill name — pass `name` or wrap files in a folder');
        const fmName = /^name:\s*(.+)$/m.exec(sk.content);
        if (!fmName) throw err('ERR_BAD_INPUT', 'SKILL.md front-matter has no name — pass `name`');
        dirName = assertSkillName(fmName[1].trim());
      }
    }
    if (!inner.some((f) => f.path === 'SKILL.md')) {
      throw err('ERR_BAD_INPUT', 'skill folder must contain SKILL.md at its root');
    }
    if (store.skills[dirName]) throw err('ERR_EXISTS', 'a market skill with this name already exists');
    const destDir = path.join(SKILLS_ROOT, dirName);
    await fsp.mkdir(destDir, { recursive: true });
    stat = { fileCount: 0, size: 0 };
    try {
      for (const f of inner) {
        if (Buffer.byteLength(f.content, 'utf8') > MAX_SKILL_BYTES) {
          throw err('ERR_TOO_LARGE', `file ${f.path} exceeds max size`);
        }
        const dest = path.join(destDir, f.path);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, f.content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
        stat.fileCount += 1;
        stat.size += Buffer.byteLength(f.content, 'utf8');
      }
    } catch (e) {
      await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});
      if (e.code === 'EEXIST') throw err('ERR_EXISTS', 'a market skill with this name already exists');
      throw e;
    }
    md = inner.find((f) => f.path === 'SKILL.md').content;
  } else {
    dirName = assertSkillName(name);
    if (typeof content !== 'string' || !content.trim()) {
      throw err('ERR_BAD_INPUT', 'content required');
    }
    if (store.skills[dirName]) throw err('ERR_EXISTS', 'a market skill with this name already exists');
    const desc = (typeof description === 'string' && description.trim())
      ? description.trim() : `Uploaded by ${user}`;
    const body = content.trim() + '\n';
    md = (/^---\r?\n/.test(body) && /^name:/m.test(body.split(/^---\r?\n/)[1] || ''))
      ? body
      : `---\nname: ${dirName}\ndescription: ${desc}\n---\n\n${body}`;
    if (Buffer.byteLength(md, 'utf8') > MAX_SKILL_BYTES) {
      throw err('ERR_TOO_LARGE', 'skill content exceeds max size');
    }
    const destDir = path.join(SKILLS_ROOT, dirName);
    await fsp.mkdir(destDir, { recursive: true });
    try {
      await fsp.writeFile(path.join(destDir, 'SKILL.md'), md, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') throw err('ERR_EXISTS', 'a market skill with this name already exists');
      if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
      throw e;
    }
    stat = { fileCount: 1, size: Buffer.byteLength(md, 'utf8') };
  }

  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const fmRaw = m ? m[1] : md;
  const nm = /^name:\s*(.+)$/m.exec(fmRaw);
  const dm = /^description:\s*(.+)$/m.exec(fmRaw);
  await _recordInStore(store, {
    dirName,
    name: nm ? nm[1].trim() : dirName,
    description: dm ? dm[1].trim() : (typeof description === 'string' ? description : ''),
    user,
    stat,
  });
  return {
    name: nm ? nm[1].trim() : dirName,
    dirName,
    description: dm ? dm[1].trim() : '',
    uploader: user,
    fileCount: stat.fileCount,
    size: stat.size,
  };
}

// Validate one relative import path destined for inside a skill dir
// (shared guard, same rules as skills.js assertRelInside).
function assertRelInside(pathRel) {
  const raw = String(pathRel == null ? '' : pathRel).replace(/\\/g, '/').trim();
  if (!raw || raw === '.') throw err('ERR_BAD_INPUT', 'empty file path');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw err('ERR_OUTSIDE', 'import path must be relative');
  }
  const parts = raw.split('/');
  if (parts.includes('..') || parts.includes('') || parts.some((p) => p === '.')) {
    throw err('ERR_OUTSIDE', 'import path escapes or is malformed');
  }
  return parts.join('/');
}

// Install a market skill into a session's personal store. No-clobber:
// an existing personal skill with the same dir name → ERR_EXISTS (the
// user must delete their local copy first — never silently overwrite).
async function installMarketSkill(absRoot, dirName) {
  const name = assertSkillName(dirName);
  const srcDir = path.join(SKILLS_ROOT, name);
  const mdPath = path.join(srcDir, 'SKILL.md');
  try {
    const lst = await fsp.lstat(mdPath);
    if (!lst.isFile()) throw new Error('not a file');
  } catch {
    throw err('ERR_NOT_FOUND', 'market skill not found');
  }
  const destDir = path.join(absRoot, '.claude', 'skills', name);
  // No-clobber checked UP FRONT (not via flag 'wx'): the rollback in
  // the copy path would otherwise rm -rf an existing personal skill
  // of the same name — the exact thing ERR_EXISTS exists to prevent.
  try {
    await fsp.access(path.join(destDir, 'SKILL.md'));
    throw err('ERR_EXISTS', 'a personal skill with this name already exists — delete it first');
  } catch (e) {
    if (e.code === 'ERR_EXISTS') throw e;
    // ENOENT → destination free; anything else (EACCES) still lets the
    // copy attempt below surface the real error.
  }
  try {
    await fsp.mkdir(destDir, { recursive: true });
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  const stat = { fileCount: 0, size: 0 };
  try {
    await copyTreeSafe(srcDir, destDir, stat);
  } catch (e) {
    // Roll back ONLY the dir we just created for this install. The
    // up-front collision check guarantees it held no prior skill.
    await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});
    if (e.code === 'EEXIST') throw err('ERR_EXISTS', 'a personal skill with this name already exists');
    throw e;
  }
  return { installed: true, dirName: name, fileCount: stat.fileCount, size: stat.size };
}

// Delete a market skill. Two authorized paths:
//   1. user === the recorded uploader;
//   2. `code` matches the system delete code (constant-time compare,
//      throttled on failure) — the operator/maintenance path usable by
//      anyone who knows the code.
// Anything else → ERR_FORBIDDEN. Never reveals whether the skill
// exists to a forbidden caller beyond the standard 404-vs-403 split
// the route applies.
async function deleteMarketSkill(dirName, user, code) {
  const name = assertSkillName(dirName);
  const store = await loadStore();
  const meta = store.skills[name];
  const dir = path.join(SKILLS_ROOT, name);
  let exists = false;
  try { exists = (await fsp.stat(path.join(dir, 'SKILL.md'))).isFile(); }
  catch { exists = false; }
  if (!meta && !exists) throw err('ERR_NOT_FOUND', 'market skill not found');

  const isUploader = !!user && !!meta && meta.uploader === user;
  let codeOk = false;
  if (!isUploader) {
    // Throttle check FIRST — a flooded caller can't keep probing even
    // with the correct code until the window rolls over.
    if (isThrottled(user || 'anon')) {
      throw err('ERR_THROTTLED', 'too many failed delete-code attempts — try again later');
    }
    if (typeof code === 'string' && code.trim()) {
      const actual = await getDeleteCode();
      codeOk = codeMatches(code, actual);
      if (!codeOk) noteCodeFailure(user || 'anon');
    }
    if (!codeOk) {
      // ERR_FORBIDDEN unless the skill simply isn't there.
      if (!exists && !meta) throw err('ERR_NOT_FOUND', 'market skill not found');
      throw err('ERR_FORBIDDEN', 'only the uploading user or a valid system delete code may delete a market skill');
    }
    if (user) clearCodeFailures(user);
  }

  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  if (store.skills[name]) {
    delete store.skills[name];
    await saveStore(store);
  }
  return { deleted: true, dirName: name, via: isUploader ? 'uploader' : 'code' };
}

module.exports = {
  listMarket,
  readMarketSkill,
  publishFromSession,
  publishFromDir,
  publishDirect,
  installMarketSkill,
  deleteMarketSkill,
  getDeleteCode,
  assertSkillName,
  MAX_SKILL_BYTES,
  MARKET_ROOT,
};
