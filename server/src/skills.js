// delm-10: skill selection + upload/import backend. Pure module — no
// Express coupling, mirrors files.js's shape. All public functions take
// an `absRoot` (the session's cwd) and operate on the project-skill
// store at <absRoot>/.claude/skills/<skillName>/SKILL.md — the layout
// Claude Code's `skills` SDK option reads when settingSources includes
// 'project' (names match the SKILL.md `name` field / directory name).
//
// delm-10 scope extension: a skill store entry may be a SYMLINK to a
// dir in a wider-scope store (user-level <WORKSPACE>/<user>/.claude/
// skills or global <WORKSPACE>/.claude/skills). listSkills follows
// symlinks (readdir withFileTypes marks them non-directory), so the
// SDK — whose `skills` option only reads the session store — sees
// shared skills through the link. linkSkill() materializes that link;
// deleteSkill uses rm -rf via lstat-aware unlink so removing a linked
// entry drops the link, not the shared target.
//
// Skills in this store are ALWAYS discoverable by the SDK; per-session
// *selection* (the `skills: string[]` context filter) lives on the
// session record (rec.enabledSkills in sessions.js) and is applied by
// agent-session.js at iteration start. 'all' (no filter) is used when
// no skill has been explicitly toggled on, preserving pre-delm-10
// behaviour.
//
// Errors are tagged with `code` so routes map them to HTTP statuses
// (same vocabulary as files.js):
//   ERR_BAD_INPUT   — malformed name / content / import payload
//   ERR_NOT_FOUND   — skill missing
//   ERR_EXISTS      — skill already exists (imports are no-clobber)
//   ERR_OUTSIDE     — import entry path escapes the skill dir
//   ERR_TOO_LARGE   — content over MAX_SKILL_BYTES
//   ERR_PERM        — EACCES / EPERM from the underlying syscall

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// delm-10 deletion security. A skill uploaded to a SHARED store
// (user = personal-but-cross-session, global = marketplace) carries an
// ownership record so deletion can be gated: only the uploading user
// may delete it — or, for global (market) skills, a holder of the
// system delete code. The record lives at
// <sharedStore>/<name>.skill-meta.json (NEXT TO the skill dir, not
// inside it — listSkills' per-dir walk never sees it, and a skill's
// own content can't spoof or strip it).
const META_SUFFIX = '.skill-meta.json';

// The system delete code — ONE code for the whole instance, shared
// with the skill MARKET module (skill-market.js): the file
// $MYCO_STATE_DIR/skill-market/delete-code (mode 0600, generated on
// first use, race-safe 'wx'). skills.js reads-or-creates the very
// same file so the operator only ever manages one code. No env
// override — two code sources would mean two codes.
let _cachedCode = null;
function systemDeleteCode() {
  if (_cachedCode !== null) return _cachedCode;
  const stateDir = process.env.MYCO_STATE_DIR || path.join(require('os').homedir(), '.myco');
  const file = path.join(stateDir, 'skill-market', 'delete-code');
  const fsSync = require('fs');
  try {
    _cachedCode = fsSync.readFileSync(file, 'utf8').trim() || null;
  } catch {
    try {
      fsSync.mkdirSync(path.dirname(file), { recursive: true });
      _cachedCode = crypto.randomBytes(24).toString('hex');
      fsSync.writeFileSync(file, _cachedCode + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      console.log('[skills] generated system skill delete code at ' + file + ' (shared with the skill market)');
    } catch {
      _cachedCode = null;   // code path unavailable; uploader-only
    }
  }
  if (_cachedCode) {
    try { fsSync.chmodSync(file, 0o600); } catch { /* best effort */ }
  }
  return _cachedCode;
}

// Constant-time compare for the delete code. Length differences are
// leaked by timingSafeEqual (it throws on mismatched lengths), so hash
// both sides first — a fixed-length digest makes the comparison truly
// constant-time regardless of the submitted code's length.
function deleteCodeMatches(submitted) {
  const actual = systemDeleteCode();
  if (!actual || typeof submitted !== 'string' || !submitted) return false;
  const a = crypto.createHash('sha256').update(String(actual)).digest();
  const b = crypto.createHash('sha256').update(submitted.trim()).digest();
  return crypto.timingSafeEqual(a, b);
}

// Record the uploader of a shared-store skill. Best-effort write AFTER
// a successful create/import — a missing record degrades to "unknown
// uploader", which shared-delete treats as uploader-locked (only the
// delete code can remove it). That's the safe direction: a lost record
// can't open the skill up to deletion by others.
async function writeSkillMeta(storeRoot, dirName, uploader) {
  const file = path.join(skillsRoot(storeRoot), dirName + META_SUFFIX);
  const body = JSON.stringify({ uploader: String(uploader || 'unknown'), uploadedAt: Date.now() }) + '\n';
  try {
    await fsp.writeFile(file, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') return;   // best-effort only
  }
}

// Read a shared-store skill's uploader record. Returns
// { uploader, uploadedAt } or null when no record exists.
async function readSkillMeta(storeRoot, dirName) {
  const name = assertSkillName(dirName);
  const file = path.join(skillsRoot(storeRoot), name + META_SUFFIX);
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const j = JSON.parse(raw);
    return { uploader: String(j.uploader || 'unknown'), uploadedAt: Number(j.uploadedAt) || 0 };
  } catch {
    return null;
  }
}

const SKILLS_DIR = ['skills'];           // relative to <absRoot>/.claude
const MAX_SKILL_BYTES = 256 * 1024;      // per file (SKILL.md + helpers)
const MAX_IMPORT_FILES = 200;
const MAX_IMPORT_TOTAL_BYTES = 4 * 1024 * 1024;

// A skill name is a single filesystem-safe path segment (claude skill
// dirs use the same identifier grammar as npm-lite: letters, digits,
// dash, underscore, dot — and must not start with a dot).
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

function skillsRoot(absRoot) {
  return path.join(absRoot, '.claude', ...SKILLS_DIR);
}

// Validate a skill name; returns the trimmed name or throws ERR_BAD_INPUT.
function assertSkillName(name) {
  const raw = (name == null ? '' : String(name)).trim();
  if (!raw || !SKILL_NAME_RE.test(raw)) {
    throw err('ERR_BAD_INPUT', 'invalid skill name (use letters, digits, . _ -, no spaces or slashes)');
  }
  return raw;
}

// Validate one relative path (posix separators) destined for inside a
// skill dir: relative, no `..`, no leading `/`, no drive letters.
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

// Parse a SKILL.md body: extract the `name` + `description` from the
// YAML front-matter (tolerant — no full YAML parser needed). Returns
// { name, description } with nulls when absent.
function parseSkillFrontMatter(md) {
  const out = { name: null, description: null };
  if (typeof md !== 'string') return out;
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const fm = m ? m[1] : md;
  let nm = /^name:\s*(.+)$/m.exec(fm);
  if (nm) out.name = nm[1].trim().replace(/^["']|["']$/g, '');
  let dm = /^description:\s*(.+)$/m.exec(fm);
  if (dm) out.description = dm[1].trim().replace(/^["']|["']$/g, '');
  return out;
}

// Build a SKILL.md body from parts. If `content` already looks like a
// SKILL.md (has front-matter with a name), keep it verbatim; otherwise
// wrap the raw markdown in a minimal front-matter header.
function buildSkillMd(name, description, content) {
  const desc = (typeof description === 'string' && description.trim())
    ? description.trim() : `Imported skill: ${name}`;
  const body = (typeof content === 'string' && content.trim()) ? content.trim() + '\n' : '';
  if (/^---\r?\n/.test(body) && /^name:/m.test(body.split(/^---\r?\n/)[1] || '')) {
    return body;
  }
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}`;
}

// List every skill in the store. Each entry: { name, description,
// dir, fileCount, size, mtimeMs }. Sorted by name. Empty list when
// the skills dir doesn't exist yet (fresh workspace).
async function listSkills(absRoot) {
  const root = skillsRoot(absRoot);
  let dirents;
  try { dirents = await fsp.readdir(root, { withFileTypes: true }); }
  catch (e) {
    if (e.code === 'ENOENT') return { skills: [] };
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  const skills = [];
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    // Follow symlinks (scope links into user/global stores); plain
    // dirs pass through as before. A dangling symlink is skipped by
    // the SKILL.md read below, same as a dir without one.
    if (!d.isDirectory()) {
      if (!d.isSymbolicLink()) continue;
    }
    const mdPath = path.join(root, d.name, 'SKILL.md');
    let md;
    try { md = await fsp.readFile(mdPath, 'utf8'); }
    catch { continue; }  // a dir without SKILL.md is not a skill
    const fm = parseSkillFrontMatter(md);
    // Aggregate size + file count (bounded: no recursion past depth 3,
    // cap entries so a pathological skill can't hang the list call).
    let size = Buffer.byteLength(md, 'utf8');
    let fileCount = 1;
    try {
      const walk = async (dir, depth) => {
        if (depth > 3) return;
        const kids = await fsp.readdir(dir, { withFileTypes: true });
        for (const k of kids.slice(0, 200)) {
          if (k.name === 'SKILL.md' && depth === 0) continue;
          const kp = path.join(dir, k.name);
          if (k.isDirectory()) await walk(kp, depth + 1);
          else if (k.isFile()) {
            const st = await fsp.stat(kp);
            size += st.size;
            fileCount += 1;
          }
        }
      };
      await walk(path.join(root, d.name), 0);
    } catch { /* best-effort stats */ }
    let st;
    try { st = await fsp.stat(mdPath); } catch { st = { mtimeMs: 0 }; }
    skills.push({
      name: fm.name || d.name,
      dirName: d.name,
      description: fm.description || '',
      fileCount,
      size,
      mtimeMs: st.mtimeMs,
    });
  }
  skills.sort((a, b) => a.dirName.localeCompare(b.dirName));
  return { skills };
}

// Read one skill's SKILL.md body. Returns { name, description, content }.
async function readSkill(absRoot, dirName) {
  const name = assertSkillName(dirName);
  const mdPath = path.join(skillsRoot(absRoot), name, 'SKILL.md');
  let md;
  try { md = await fsp.readFile(mdPath, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') throw err('ERR_NOT_FOUND', 'skill not found');
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  const fm = parseSkillFrontMatter(md);
  return { name: fm.name || name, dirName: name, description: fm.description || '', content: md };
}

// Create a skill from a single SKILL.md (or raw markdown) document.
// No-clobber: an existing dir yields ERR_EXISTS. Returns the created
// skill summary (same shape as listSkills entries).
async function createSkill(absRoot, { name, description, content }) {
  const skillName = assertSkillName(name);
  const md = buildSkillMd(skillName, description, content);
  if (Buffer.byteLength(md, 'utf8') > MAX_SKILL_BYTES) {
    throw err('ERR_TOO_LARGE', 'skill content exceeds max size');
  }
  const dir = path.join(skillsRoot(absRoot), skillName);
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  const mdPath = path.join(dir, 'SKILL.md');
  try {
    await fsp.writeFile(mdPath, md, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') throw err('ERR_EXISTS', 'skill already exists');
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  const st = await fsp.stat(mdPath);
  const fm = parseSkillFrontMatter(md);
  return {
    name: fm.name || skillName,
    dirName: skillName,
    description: fm.description || '',
    fileCount: 1,
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

// Import a multi-file skill (folder upload). Payload: { name?, files:
// [{ path, content }] } — `files` paths are relative to the skill dir
// and MUST include SKILL.md (unless `name` + markdown-only, in which
// case use createSkill). No-clobber per file. Returns the created
// skill summary.
async function importSkill(absRoot, { name, description, files }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw err('ERR_BAD_INPUT', 'files array required');
  }
  if (files.length > MAX_IMPORT_FILES) {
    throw err('ERR_TOO_LARGE', 'too many files in skill folder');
  }
  let total = 0;
  const cleaned = files.map((f) => {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') {
      throw err('ERR_BAD_INPUT', 'each file needs { path, content }');
    }
    const p = assertRelInside(f.path);
    total += Buffer.byteLength(f.content, 'utf8');
    return { path: p, content: f.content };
  });
  if (total > MAX_IMPORT_TOTAL_BYTES) {
    throw err('ERR_TOO_LARGE', 'skill folder exceeds max total size');
  }

  // Infer the skill name: explicit `name` wins; else a single
  // top-level dir wrapping everything; else a SKILL.md at root is
  // named by the front-matter / falls back to error.
  let skillName = (typeof name === 'string' && name.trim()) ? assertSkillName(name) : null;
  let inner = cleaned;
  if (!skillName) {
    const tops = new Set(cleaned.map((f) => f.path.split('/')[0]));
    if (tops.size === 1 && cleaned.some((f) => f.path.includes('/'))) {
      skillName = assertSkillName([...tops][0]);
      inner = cleaned.map((f) => ({ path: f.path.split('/').slice(1).join('/'), content: f.content }));
    } else {
      const sk = inner.find((f) => f.path === 'SKILL.md');
      if (!sk) throw err('ERR_BAD_INPUT', 'cannot infer skill name — pass `name` or wrap files in a folder');
      const fm = parseSkillFrontMatter(sk.content);
      if (!fm.name) throw err('ERR_BAD_INPUT', 'SKILL.md front-matter has no name — pass `name`');
      skillName = assertSkillName(fm.name);
    }
  }
  // After unwrapping, SKILL.md must sit at the skill root.
  const hasRootSkillMd = inner.some((f) => f.path === 'SKILL.md');
  if (!hasRootSkillMd) {
    throw err('ERR_BAD_INPUT', 'skill folder must contain SKILL.md at its root');
  }

  const dir = path.join(skillsRoot(absRoot), skillName);
  const md = inner.find((f) => f.path === 'SKILL.md');
  const fm = parseSkillFrontMatter(md.content);
  if (!fm.name && !description) {
    // Stamp a front-matter on a bare SKILL.md so the SDK's name match
    // works. Preserve the body verbatim below the header.
    md.content = buildSkillMd(skillName, description, md.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim());
  }
  try {
    await fsp.mkdir(dir, { recursive: true });
    let size = 0;
    for (const f of inner) {
      const dest = path.join(dir, f.path);
      if (Buffer.byteLength(f.content, 'utf8') > MAX_SKILL_BYTES) {
        throw err('ERR_TOO_LARGE', `file ${f.path} exceeds max size`);
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, f.content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
      size += Buffer.byteLength(f.content, 'utf8');
    }
    const st = await fsp.stat(path.join(dir, 'SKILL.md'));
    return {
      name: fm.name || skillName,
      dirName: skillName,
      description: fm.description || '',
      fileCount: inner.length,
      size,
      mtimeMs: st.mtimeMs,
    };
  } catch (e) {
    if (e.code === 'EEXIST') throw err('ERR_EXISTS', 'skill already exists');
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
}

// Delete a skill directory (rm -rf of the skill folder only). A
// symlinked entry (scope link) unlinks just the link — the shared
// target dir is untouched.
async function deleteSkill(absRoot, dirName) {
  const name = assertSkillName(dirName);
  const dir = path.join(skillsRoot(absRoot), name);
  try {
    const st = await fsp.lstat(dir);
    if (st.isSymbolicLink()) {
      await fsp.unlink(dir);
    } else {
      await fsp.rm(dir, { recursive: true, force: false });
    }
  } catch (e) {
    if (e.code === 'ENOENT') throw err('ERR_NOT_FOUND', 'skill not found');
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  return { deleted: true, dirName: name };
}

// Delete a skill from a SHARED store (user / global-market) with the
// delm-10 security gate applied:
//   · `deleter` is the requesting user's login (req.user).
//   · The recorded uploader may always delete their own skill.
//   · For the GLOBAL (market) store a second escape hatch exists: the
//     system delete code (`deleteCode` param) — operator/abuse-path
//     removal of a market skill whose uploader is gone. Compared
//     constant-time; wrong code is indistinguishable from no code.
//   · No/uplost ownership record → only the delete code (global) can
//     remove it, never a same-named guess. Throws ERR_FORBIDDEN (403)
//     when neither path authorizes the delete.
// Returns { deleted: true, dirName, scope }.
async function deleteSkillShared(storeRoot, dirName, { deleter, deleteCode, scope } = {}) {
  const name = assertSkillName(dirName);
  const meta = await readSkillMeta(storeRoot, name);
  const isUploader = !!(deleter && meta && meta.uploader === deleter);
  const codeOk = scope === 'global' ? deleteCodeMatches(deleteCode) : false;
  if (!isUploader && !codeOk) {
    const why = meta
      ? (deleter ? `only the uploading user (${meta.uploader}) may delete this skill` : 'sign in as the uploading user to delete this skill')
      : 'no uploader record for this skill — use the system delete code';
    const e = err('ERR_FORBIDDEN', why);
    e.code_detail = { uploader: meta ? meta.uploader : null };
    throw e;
  }
  const out = await deleteSkill(storeRoot, name);
  // Drop the ownership record too — the skill is gone, its meta is
  // stale litter otherwise (and would poison a same-named re-upload).
  try { await fsp.rm(path.join(skillsRoot(storeRoot), name + META_SUFFIX), { force: true }); } catch {}
  return Object.assign(out, { scope: scope || null });
}

// Materialize a scope link: a symlink <sessionStore>/<dirName> →
// <targetAbsDir> so a skill uploaded to the user/global store is
// visible to the SDK (which only reads the session store). No-clobber:
// an existing entry of the same name yields ERR_EXISTS. Returns
// { linked: true, dirName, target }.
async function linkSkill(absRoot, dirName, targetAbsDir) {
  const name = assertSkillName(dirName);
  const target = path.resolve(String(targetAbsDir || ''));
  // Target must be a directory that exists (the shared store's skill).
  let tst;
  try { tst = await fsp.stat(target); }
  catch (e) {
    if (e.code === 'ENOENT') throw err('ERR_NOT_FOUND', 'skill to link not found');
    throw e;
  }
  if (!tst.isDirectory()) throw err('ERR_BAD_INPUT', 'link target is not a directory');
  const linkPath = path.join(skillsRoot(absRoot), name);
  try {
    await fsp.mkdir(path.dirname(linkPath), { recursive: true });
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  try {
    await fsp.symlink(target, linkPath, 'dir');
  } catch (e) {
    if (e.code === 'EEXIST') throw err('ERR_EXISTS', 'skill already exists');
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  return { linked: true, dirName: name, target };
}

module.exports = {
  skillsRoot,
  assertSkillName,
  parseSkillFrontMatter,
  listSkills,
  readSkill,
  createSkill,
  importSkill,
  deleteSkill,
  linkSkill,
  // delm-10 deletion security
  writeSkillMeta,
  readSkillMeta,
  deleteSkillShared,
  deleteCodeMatches,
  systemDeleteCode,
  MAX_SKILL_BYTES,
};
