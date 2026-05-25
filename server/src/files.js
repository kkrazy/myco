// Per-session file explorer backend. Pure module — no Express coupling.
// All public functions take an `absRoot` (the session's cwd, recomputed
// per request via resolveCwd) and a relative `relPath` rooted at absRoot.
// Containment is enforced inside this module; callers must NOT rely on
// their own path joining.
//
// Errors are tagged with `code` so routes can map them to HTTP statuses:
//   ERR_OUTSIDE         — path escapes absRoot (incl. via symlink)
//   ERR_NOT_FOUND       — file/dir missing
//   ERR_NOT_DIR         — listDir called on a file
//   ERR_BINARY          — read of a binary file (caller decides what to send)
//   ERR_TOO_LARGE       — read or write over MAX_READ_BYTES
//   ERR_MTIME_CONFLICT  — write expected a different mtime
//   ERR_SYMLINK_WRITE   — write target is a symlink (rejected unconditionally)
//   ERR_PERM            — EACCES / EPERM from the underlying syscall

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_READ_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const MAX_LIST_ENTRIES = 2000;
const HEAVY_DIRS = new Set([
  'node_modules', '.git', '.venv', '__pycache__', 'dist', 'build', '.next',
]);

// fr-77: find the actual git repo root for a session workspace. Two
// supported layouts (mirrors artifacts.js findProjectRoot):
//   1. absRoot itself is a git checkout:  <absRoot>/.git exists
//   2. absRoot wraps a single project subdir whose checkout has .git:
//      <absRoot>/<subdir>/.git (e.g. /wks/labxnow/myco-labxnow-xxx/myco/.git)
// Returns { gitRoot, relPrefix } where:
//   - gitRoot is the absolute path to the dir containing .git
//   - relPrefix is the path from absRoot to gitRoot ('' if same, else
//     '<subdir>/'). Used to PREFIX paths returned by `git status` /
//     `git diff` so the UI sees paths rooted at absRoot (the same
//     namespace as listDir + the editor's safeJoin).
// Returns null when no .git is reachable from absRoot.
function _findGitRoot(absRoot) {
  // Direct hit.
  try {
    if (fs.statSync(path.join(absRoot, '.git')).isDirectory() ||
        fs.statSync(path.join(absRoot, '.git')).isFile()) {
      // .git can be a dir OR a file (gitlink for worktrees).
      return { gitRoot: absRoot, relPrefix: '' };
    }
  } catch {}
  // Nested hit: scan immediate subdirs alphabetically.
  let entries;
  try {
    entries = fs.readdirSync(absRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !HEAVY_DIRS.has(d.name))
      .map((d) => d.name)
      .sort();
  } catch { return null; }
  for (const name of entries) {
    try {
      const gp = path.join(absRoot, name, '.git');
      const st = fs.statSync(gp);
      if (st.isDirectory() || st.isFile()) {
        return { gitRoot: path.join(absRoot, name), relPrefix: name + '/' };
      }
    } catch {}
  }
  return null;
}

// fr-9: read `git status --porcelain` from a directory and return a
// Map<relpath-from-git-root, statusChar>. The status char is the
// 2-char git index+worktree code collapsed to a single user-facing
// letter:
//
//   M = modified (in worktree or staged)
//   A = added (staged but not yet committed)
//   D = deleted (in worktree or staged)
//   R = renamed
//   C = copied
//   U = unmerged
//   ? = untracked
//   ! = ignored (only shown if --ignored — we don't pass that)
//
// Tolerates non-git workspaces (returns empty Map). Cached at the
// request scope by the caller — single execFile per listDir call.
async function _gitStatusMap(absRoot) {
  // fr-77: resolve the actual git root. Pre-fix this required .git to
  // live AT absRoot — but many session layouts wrap the project in a
  // subdir (e.g. /wks/labxnow/myco-labxnow-xxx/myco/.git), and the
  // function silently returned an empty map for those. Now we descend
  // one level when needed + prefix the returned paths with the
  // subdir name so they're addressable from absRoot (the namespace
  // listDir + safeJoin use).
  const gitInfo = _findGitRoot(absRoot);
  if (!gitInfo) return new Map();
  const { gitRoot, relPrefix } = gitInfo;
  let stdout = '';
  try {
    stdout = await new Promise((resolve, reject) => {
      execFile('git', ['-C', gitRoot, 'status', '--porcelain', '-uall'],
        { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => err ? reject(err) : resolve(stdout));
    });
  } catch {
    // git not available, not a repo, timeout, etc. — degrade silently.
    return new Map();
  }
  const map = new Map();
  // Each line: "XY path" where X = index status, Y = worktree status.
  // Rename: "R  oldpath -> newpath". We map both paths to 'R' if a
  // rename, else use the more-meaningful status (worktree > index).
  for (const line of stdout.split('\n')) {
    if (!line || line.length < 4) continue;
    const idxChar = line[0];
    const wtChar = line[1];
    const rest = line.slice(3);
    let primary = ' ';
    if (idxChar !== ' ' && idxChar !== '?') primary = idxChar;
    if (wtChar !== ' ' && wtChar !== '?') primary = wtChar;
    if (idxChar === '?' && wtChar === '?') primary = '?';
    if (idxChar === '!' || wtChar === '!') primary = '!';
    if (idxChar === 'U' || wtChar === 'U') primary = 'U';
    // Rename: "R  old -> new" — both paths get 'R'.
    const arrowIdx = rest.indexOf(' -> ');
    if (idxChar === 'R' && arrowIdx >= 0) {
      const oldPath = rest.slice(0, arrowIdx);
      const newPath = rest.slice(arrowIdx + 4);
      map.set(relPrefix + oldPath, 'R');
      map.set(relPrefix + newPath, 'R');
    } else {
      map.set(relPrefix + rest, primary);
    }
  }
  return map;
}

// Compute the directory-level git status by checking if ANY child has a
// non-clean status. Walks the gitStatusMap once and returns the
// "loudest" status for entries under `dirRelPath`. Used so a parent
// dir like `src/` shows 'M' when any file inside is modified.
function _dirGitStatus(gitMap, dirRelPath) {
  if (!gitMap || gitMap.size === 0) return null;
  const prefix = dirRelPath === '.' || dirRelPath === '' ? '' : (dirRelPath + '/');
  // Priority order — show the most actionable status.
  let best = null;
  const rank = { '?': 1, '!': 0, 'M': 4, 'A': 5, 'D': 3, 'R': 6, 'C': 6, 'U': 7 };
  for (const [p, s] of gitMap) {
    if (prefix && !p.startsWith(prefix)) continue;
    if (best === null || (rank[s] || 0) > (rank[best] || 0)) best = s;
  }
  return best;
}

function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

// Resolve `relPath` against `absRoot` and assert containment. Follows
// symlinks via realpath and rejects if the target escapes the root.
// Returns the absolute resolved path.
async function safeJoin(absRoot, relPath) {
  const raw = (relPath == null ? '' : String(relPath)).trim();
  if (raw === '' || raw === '.' || raw === './') return absRoot;
  if (path.isAbsolute(raw)) throw err('ERR_OUTSIDE', 'path must be relative');
  const abs = path.resolve(absRoot, raw);
  const rel = path.relative(absRoot, abs);
  if (rel === '' ) return absRoot;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw err('ERR_OUTSIDE', 'path escapes session root');
  }
  // Symlink check: if any component is a symlink whose target escapes,
  // realpath will surface that. Don't realpath if the file doesn't exist
  // yet (e.g. write target's tmp suffix); only check when the file exists.
  let st;
  try {
    st = await fsp.lstat(abs);
  } catch (e) {
    if (e.code === 'ENOENT') return abs; // doesn't exist; treated by caller
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  if (st.isSymbolicLink()) {
    let real;
    try { real = await fsp.realpath(abs); }
    catch (e) {
      if (e.code === 'ENOENT') throw err('ERR_NOT_FOUND', 'symlink target missing');
      if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
      throw e;
    }
    const realRoot = await fsp.realpath(absRoot).catch(() => absRoot);
    const realRel = path.relative(realRoot, real);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw err('ERR_OUTSIDE', 'symlink target escapes session root');
    }
  }
  return abs;
}

async function listDir(absRoot, relPath) {
  const abs = await safeJoin(absRoot, relPath);
  let st;
  try { st = await fsp.stat(abs); }
  catch (e) {
    if (e.code === 'ENOENT') throw err('ERR_NOT_FOUND', 'directory missing');
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  if (!st.isDirectory()) throw err('ERR_NOT_DIR', 'not a directory');

  let dirents;
  try { dirents = await fsp.readdir(abs, { withFileTypes: true }); }
  catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }

  const truncated = dirents.length > MAX_LIST_ENTRIES;
  if (truncated) dirents.length = MAX_LIST_ENTRIES;

  // fr-9: enrich entries with git status. Single execFile per
  // listDir call; nonzero cost on large repos but bounded by
  // 5s timeout. Empty Map for non-git workspaces.
  const gitMap = await _gitStatusMap(absRoot);
  const relDir = path.relative(absRoot, abs) || '.';
  const relDirPrefix = relDir === '.' ? '' : (relDir + '/');

  const entries = [];
  for (const d of dirents) {
    const childAbs = path.join(abs, d.name);
    let estat;
    try { estat = await fsp.lstat(childAbs); }
    catch { continue; } // skip entries we can't stat (EACCES, races)
    let kind;
    if (d.isDirectory()) kind = 'dir';
    else if (d.isFile()) kind = 'file';
    else if (d.isSymbolicLink()) kind = 'symlink';
    else kind = 'other';
    // Git status: file → exact-path match; dir → aggregate from
    // child paths under it.
    let gitStatus = null;
    if (gitMap.size > 0) {
      const entryRelPath = relDirPrefix + d.name;
      if (kind === 'dir') {
        gitStatus = _dirGitStatus(gitMap, entryRelPath);
      } else {
        gitStatus = gitMap.get(entryRelPath) || null;
      }
    }
    entries.push({
      name: d.name,
      kind,
      size: estat.size,
      mtime: estat.mtimeMs,
      heavy: kind === 'dir' && HEAVY_DIRS.has(d.name),
      ...(gitStatus ? { gitStatus } : {}),
    });
  }
  entries.sort((a, b) => {
    if ((a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const relOut = path.relative(absRoot, abs) || '.';
  return { path: relOut, entries, truncated };
}

function looksBinary(buf) {
  if (buf.length === 0) return false;
  let nonText = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b === 9 || b === 10 || b === 13) continue;
    if (b < 0x20) nonText++;
    else if (b > 0x7e && b < 0x80) nonText++;
  }
  return nonText / buf.length > 0.3;
}

async function readFile(absRoot, relPath) {
  const abs = await safeJoin(absRoot, relPath);
  let st;
  try { st = await fsp.stat(abs); }
  catch (e) {
    if (e.code === 'ENOENT') throw err('ERR_NOT_FOUND', 'file missing');
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  if (st.isDirectory()) throw err('ERR_NOT_DIR', 'is a directory');
  if (st.size > MAX_READ_BYTES) {
    const e = err('ERR_TOO_LARGE', 'file exceeds max size');
    e.size = st.size; e.mtime = st.mtimeMs;
    throw e;
  }

  // Binary sniff first to avoid reading huge "text" files we can't render.
  let fh;
  try { fh = await fsp.open(abs, 'r'); }
  catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  try {
    const sniff = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, st.size));
    if (sniff.length > 0) await fh.read(sniff, 0, sniff.length, 0);
    if (looksBinary(sniff)) {
      const e = err('ERR_BINARY', 'binary file');
      e.size = st.size; e.mtime = st.mtimeMs;
      throw e;
    }
    // Read the whole file as UTF-8.
    const buf = Buffer.alloc(st.size);
    if (st.size > 0) await fh.read(buf, 0, st.size, 0);
    const relOut = path.relative(absRoot, abs);
    return {
      path: relOut,
      size: st.size,
      mtimeMs: st.mtimeMs,
      encoding: 'utf8',
      content: buf.toString('utf8'),
    };
  } finally {
    await fh.close().catch(() => {});
  }
}

async function writeFile(absRoot, relPath, { content, expectedMtimeMs }) {
  if (typeof content !== 'string') throw err('ERR_BAD_INPUT', 'content must be string');
  if (typeof expectedMtimeMs !== 'number' || !Number.isFinite(expectedMtimeMs)) {
    throw err('ERR_BAD_INPUT', 'expectedMtimeMs required');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) {
    throw err('ERR_TOO_LARGE', 'content exceeds max size');
  }

  const abs = await safeJoin(absRoot, relPath);

  // Existence + symlink + mtime checks.
  let st;
  try { st = await fsp.lstat(abs); }
  catch (e) {
    if (e.code === 'ENOENT') throw err('ERR_NOT_FOUND', 'file does not exist (no creates in v1)');
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  if (st.isSymbolicLink()) throw err('ERR_SYMLINK_WRITE', 'refusing to write through symlink');
  if (!st.isFile()) throw err('ERR_NOT_FOUND', 'not a regular file');
  if (Math.abs(st.mtimeMs - expectedMtimeMs) > 1) {
    throw err('ERR_MTIME_CONFLICT', 'file changed on disk');
  }

  const dir = path.dirname(abs);
  const tmp = path.join(dir, '.' + path.basename(abs) + '.myco-tmp-' + crypto.randomBytes(4).toString('hex'));
  try {
    await fsp.writeFile(tmp, content, { encoding: 'utf8', mode: 0o644 });
    try {
      await fsp.rename(tmp, abs);
    } catch (e) {
      if (e.code === 'EXDEV') {
        // Cross-device rename: fall back to copy + unlink. Not atomic but
        // shouldn't happen under /wks; log so we know if the bind-mount
        // ever crosses a filesystem.
        console.warn('[files] EXDEV on rename, falling back to non-atomic copy');
        await fsp.copyFile(tmp, abs);
        await fsp.unlink(tmp).catch(() => {});
      } else {
        throw e;
      }
    }
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }

  const newSt = await fsp.stat(abs);
  return { mtimeMs: newSt.mtimeMs, size: newSt.size };
}

// fr-77: flat list of all git-status-changed files at the project root.
// Powers the file explorer's bottom "Changed files" section. Reuses
// _gitStatusMap (so we don't re-fork git status). Returns:
//   { entries: [{path, status}], truncated: false }
// where status is the same single-letter primary code _gitStatusMap
// already returns. Sorted by path for deterministic UI render order.
// Renamed files surface as the NEW path only (the old path is implicit
// in the rename + would clutter the list).
async function listChangedFiles(absRoot) {
  const gitMap = await _gitStatusMap(absRoot);
  if (!gitMap || gitMap.size === 0) {
    return { entries: [], truncated: false };
  }
  const entries = [];
  for (const [p, s] of gitMap) entries.push({ path: p, status: s });
  // De-dup by path (rename produces both old + new — both got 'R' via
  // _gitStatusMap; keep one). And sort by path for deterministic render.
  const byPath = new Map();
  for (const e of entries) byPath.set(e.path, e);
  const out = Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
  // Cap to 500 entries to bound the response on busy worktrees. UI
  // surfaces truncated=true so the user knows to use the terminal for
  // the full picture if it hits the cap.
  const MAX = 500;
  const truncated = out.length > MAX;
  return { entries: truncated ? out.slice(0, MAX) : out, truncated };
}

// fr-77: read the unified diff for a single file relative to HEAD.
// `git diff HEAD -- <path>` covers both worktree + staged changes
// against the last commit. Path is run through safeJoin first so we
// can't escape the session root. Returns { path, diff, head, exists }
// where head = short SHA of HEAD (so the UI can show "diff vs <sha>")
// and exists = true unless the path is deleted in the worktree.
async function readDiff(absRoot, relPath) {
  // safeJoin guards traversal + symlink-escape — same shape as the
  // existing readFile / writeFile paths. The returned `relPath` stays
  // in the absRoot namespace (caller-facing); we translate to the
  // git-root namespace below for the actual git invocation.
  await safeJoin(absRoot, relPath);
  // fr-77: resolve git root (handles nested project layouts —
  // /wks/<user>/<sess>/<project>/.git instead of /wks/<user>/<sess>/.git).
  // Repo-less workspaces get an empty diff + gitless:true so the UI
  // shows an explanatory notice instead of a 500.
  const gitInfo = _findGitRoot(absRoot);
  if (!gitInfo) {
    return { path: relPath, diff: '', head: null, exists: true, gitless: true };
  }
  const { gitRoot, relPrefix } = gitInfo;
  // Strip the relPrefix (e.g. 'myco/') so we pass the git-root-relative
  // path to `git diff`. If the path doesn't start with relPrefix the
  // file lives outside the git repo — surface gitless rather than ask
  // git about a path it doesn't know.
  let gitRelPath = relPath;
  if (relPrefix && relPath.startsWith(relPrefix)) {
    gitRelPath = relPath.slice(relPrefix.length);
  } else if (relPrefix && !relPath.startsWith(relPrefix)) {
    return { path: relPath, diff: '', head: null, exists: true,
             gitless: true, note: 'file outside git repo root' };
  }
  // Short HEAD SHA. Useful for the UI to label "diff vs abc1234".
  let head = null;
  try {
    head = await new Promise((resolve, reject) => {
      execFile('git', ['-C', gitRoot, 'rev-parse', '--short', 'HEAD'],
        { timeout: 2000, maxBuffer: 64 * 1024 },
        (err, stdout) => err ? reject(err) : resolve(String(stdout).trim()));
    });
  } catch { /* fresh repo with no commits, etc. — leave head=null */ }
  // The diff itself. Use --no-color so the output is plain unified
  // diff (highlight.js can syntax-color client-side); --no-ext-diff
  // so a user's git-config'd external differ doesn't change the
  // shape; -- separates path from flags so a file named -M is safe.
  let diff = '';
  try {
    diff = await new Promise((resolve, reject) => {
      execFile('git',
        ['-C', gitRoot, 'diff', '--no-color', '--no-ext-diff', 'HEAD', '--', gitRelPath],
        { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => err ? reject(err) : resolve(String(stdout)));
    });
  } catch (e) {
    // git error (timeout, etc.) — surface a structured failure so
    // the UI can show the message rather than a generic 500.
    throw err('ERR_GIT_DIFF', 'git diff failed: ' + e.message);
  }
  // exists check: if the worktree file is gone (deleted in workdir
  // OR staged delete), surface that on the response so the UI can
  // render a "deleted" badge instead of trying to also show the
  // current source.
  let exists = true;
  try { await fsp.stat(path.join(absRoot, relPath)); }
  catch { exists = false; }
  return { path: relPath, diff, head, exists };
}

module.exports = { safeJoin, listDir, readFile, writeFile, listChangedFiles, readDiff };
