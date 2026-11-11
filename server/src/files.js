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
//   { entries: [{path, status}], truncated, mentions, recentCommits }
// where status is the same single-letter primary code _gitStatusMap
// already returns. Sorted by path for deterministic UI render order.
// Renamed files surface as the NEW path only (the old path is implicit
// in the rename + would clutter the list).
//
// fr-77 r2 (kkrazy 2026-05-25 comment): also surface a description
// above the list:
//   - mentions: bug-N / fr-N / td-N tokens extracted from the diff
//     text of the uncommitted changes (scanned via one
//     `git diff HEAD` call, no path filter). Lets the user see
//     "what plan items did this change touch / mention?" at a glance.
//   - recentCommits: last 5 commits' [{sha, subject, mentions}].
//     The mentions array per commit gives the same bug/fr/td refs
//     extracted from the subject. Gives "what was the last activity
//     on this repo" context.
// Both are bounded + best-effort — degrade silently in non-git
// workspaces / on git errors.
async function listChangedFiles(absRoot) {
  const gitMap = await _gitStatusMap(absRoot);
  // fr-77 r2: even when the worktree is clean (gitMap empty), we still
  // want recentCommits in the description — "what was the last activity
  // on this repo" stays useful. Only non-git workspaces short-circuit
  // to fully-empty.
  const gitInfo = _findGitRoot(absRoot);
  if (!gitInfo) {
    return { entries: [], truncated: false, mentions: [], recentCommits: [] };
  }
  const entries = [];
  if (gitMap) for (const [p, s] of gitMap) entries.push({ path: p, status: s });
  const byPath = new Map();
  for (const e of entries) byPath.set(e.path, e);
  const out = Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
  const MAX = 500;
  const truncated = out.length > MAX;

  // fr-77 r2: extract mentions + recent commits using the resolved
  // git root (same _findGitRoot helper used by _gitStatusMap).
  let mentions = [];
  let recentCommits = [];
  const { gitRoot, relPrefix } = gitInfo;
  // Mentions — single `git diff HEAD` call covers all changed files.
  // Cap output at 1MB; if the diff is huge, we still scan whatever
  // came back (best-effort).
  try {
    const diffAll = await new Promise((resolve, reject) => {
      execFile('git', ['-C', gitRoot, 'diff', '--no-color', '--no-ext-diff', 'HEAD'],
        { timeout: 5000, maxBuffer: 1 * 1024 * 1024 },
        (err, stdout) => err ? reject(err) : resolve(String(stdout)));
    });
    mentions = _extractMentions(diffAll);
  } catch { /* timeout / huge diff / other — leave mentions=[] */ }
  // Recent commits — last 5. NUL-separator between record fields
  // so subjects with embedded tabs survive intact.
  try {
    const log = await new Promise((resolve, reject) => {
      execFile('git', ['-C', gitRoot, 'log', '-5', '--pretty=format:%h%x00%s'],
        { timeout: 3000, maxBuffer: 64 * 1024 },
        (err, stdout) => err ? reject(err) : resolve(String(stdout)));
    });
    for (const line of log.split('\n')) {
      const nul = line.indexOf('\0');
      if (nul < 0) continue;
      const sha = line.slice(0, nul);
      const subject = line.slice(nul + 1);
      recentCommits.push({ sha, subject, mentions: _extractMentions(subject) });
    }
  } catch { /* shallow repo with no commits / other — leave empty */ }

  // fr-77 r6: per-file line counts. `git diff --numstat HEAD` returns
  // one tab-separated row per tracked-changed file: <added>\t<removed>\t<path>.
  // Binary files show `-\t-\tpath`; surfaced as added/removed = null so
  // the UI can render a "binary" badge instead of bogus zeros. Untracked
  // files don't appear in numstat (they have no diff vs HEAD) — we
  // count them per-file from the worktree (cheap: only run if untracked
  // count is small + file is under 1MB). The map is keyed by the path
  // shape the entries[] carry (relPrefix-prepended) so a Map lookup
  // attaches the counts in O(1).
  const lineStats = new Map();
  try {
    const numstat = await new Promise((resolve, reject) => {
      execFile('git', ['-C', gitRoot, 'diff', '--numstat', '--no-color', 'HEAD'],
        { timeout: 5000, maxBuffer: 1 * 1024 * 1024 },
        (err, stdout) => err ? reject(err) : resolve(String(stdout)));
    });
    for (const line of numstat.split('\n')) {
      if (!line) continue;
      // Tab-separated: added \t removed \t path. Renames show
      // `added\tremoved\told => new` or `added\tremoved\told\0new`
      // with -z; we don't use -z here, so a "=>" path means a rename
      // and we key on the new-path segment.
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const a = parts[0], r = parts[1];
      let p = parts.slice(2).join('\t');
      const arrow = p.indexOf(' => ');
      if (arrow > -1) p = p.slice(arrow + 4);
      const added   = (a === '-') ? null : (Number.isFinite(+a) ? +a : null);
      const removed = (r === '-') ? null : (Number.isFinite(+r) ? +r : null);
      // Key the map by the entries[]-shaped path (with relPrefix).
      lineStats.set(relPrefix + p, { added, removed });
    }
  } catch { /* timeout / huge diff / other — leave lineStats empty */ }
  // Untracked files: count lines from disk. Skip files >1MB to avoid
  // OOM on a stray log dump or binary blob. status '?' is the only
  // status _gitStatusMap surfaces for untracked.
  for (const e of out) {
    if (e.status !== '?') continue;
    try {
      const abs = path.join(absRoot, e.path);
      const st = fs.statSync(abs);
      if (st.size > 1 * 1024 * 1024) { lineStats.set(e.path, { added: null, removed: 0 }); continue; }
      const txt = fs.readFileSync(abs, 'utf8');
      // Match git's "added" count for a new file: number of \n; if the
      // last char isn't \n, that final partial line counts too.
      let n = 0; for (let i = 0; i < txt.length; i++) if (txt.charCodeAt(i) === 10) n++;
      if (txt.length > 0 && txt[txt.length - 1] !== '\n') n++;
      lineStats.set(e.path, { added: n, removed: 0 });
    } catch { /* unreadable / deleted between status and stat — skip */ }
  }
  // Attach to each entry. Tracked files with no numstat hit (e.g. mode-
  // only changes) get { added: 0, removed: 0 }.
  for (const e of out) {
    const s = lineStats.get(e.path);
    if (s) { e.added = s.added; e.removed = s.removed; }
    else   { e.added = 0; e.removed = 0; }
  }

  return {
    entries: truncated ? out.slice(0, MAX) : out,
    truncated,
    mentions,
    recentCommits,
  };
}

// fr-77 r2: extract bug-N / fr-N / td-N tokens from arbitrary text,
// deduplicated + cap'd at 50 (defense against absurdly mention-heavy
// diffs). Same regex shape as sessionPool.extractMentions but local
// to files.js to avoid the cross-module dep.
function _extractMentions(text) {
  if (!text) return [];
  const re = /\b(?:fr|bug|td)-\d+\b/g;
  const found = new Set();
  let m;
  while ((m = re.exec(String(text))) !== null) {
    found.add(m[0]);
    if (found.size >= 50) break;
  }
  return Array.from(found).sort();
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
  const absPath = path.join(absRoot, relPath);
  try { await fsp.stat(absPath); }
  catch { exists = false; }
  // fr-77 r10: untracked files don't show up in `git diff HEAD` (git
  // doesn't track them), so the diff above came back empty. Render
  // them as an "all-additions" diff using `git diff --no-index` —
  // produces the same unified-diff shape (with proper @@ hunks +
  // mode header) the UI already handles. Skips when the file is
  // tracked-but-clean (a true no-op), is gone, or is too big.
  if (exists && !diff.trim()) {
    diff = await _synthDiffForUntracked(absPath, relPath) || '';
  }
  return { path: relPath, diff, head, exists };
}

// fr-77 r10: synthesize a unified-diff for an untracked file by
// asking git to diff it against /dev/null. Returns '' on any failure
// (tracked-but-clean file, too big, binary, missing git, etc.) so
// the caller falls back to the existing "no diff" UI notice.
//
// `git diff --no-index` exits with code 1 when files differ (expected
// here since /dev/null is empty), and that gets surfaced as an Error
// by execFile. We treat exit code 1 with non-empty stdout as success.
async function _synthDiffForUntracked(absFilePath, displayPath) {
  // Cap at 1MB to avoid hauling a giant log file or video into the
  // response. Caller's empty-diff UI notice covers the >1MB case.
  let st;
  try { st = await fsp.stat(absFilePath); } catch { return ''; }
  if (!st.isFile() || st.size > 1 * 1024 * 1024) return '';
  return await new Promise((resolve) => {
    execFile('git',
      ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', absFilePath],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (e, stdout) => {
        // Exit code 1 = "files differ" — that's the success path here.
        // Any stdout means git produced a diff; use it. On hard failure
        // (no stdout), fall back to '' so the caller's empty-diff notice
        // takes over.
        const out = String(stdout || '');
        if (!out) return resolve('');
        // `git diff --no-index /dev/null <abs>` emits both `a/<abs>` and
        // `b/<abs>` on the `diff --git` line (NOT a/dev/null), plus
        // `+++ b/<abs>` on the file header. Rewrite both so they show
        // the session-relative display path — the UI's syntax-highlight
        // language detection keys off the extension on the +++ line, and
        // copy/paste of the diff matches what the user is browsing.
        const rewritten = out
          .replace(/^diff --git a\/.+ b\/.+$/m,
                   'diff --git a/dev/null b/' + displayPath)
          .replace(/^\+\+\+ b\/.+$/m,
                   '+++ b/' + displayPath);
        resolve(rewritten);
      });
  });
}

// fr-77 r12: stage a single changed file. Wraps `git add <gitRelPath>`
// with the same safeJoin + _findGitRoot guards as readDiff. Returns
// { ok: true, path, action: 'accepted' } on success; throws ERR_NO_GIT
// for repo-less workspaces, ERR_GIT_ADD on git failure.
async function acceptFile(absRoot, relPath) {
  await safeJoin(absRoot, relPath);
  const gitInfo = _findGitRoot(absRoot);
  if (!gitInfo) throw err('ERR_NO_GIT', 'not a git workspace');
  const { gitRoot, relPrefix } = gitInfo;
  let gitRelPath = relPath;
  if (relPrefix && relPath.startsWith(relPrefix)) {
    gitRelPath = relPath.slice(relPrefix.length);
  } else if (relPrefix && !relPath.startsWith(relPrefix)) {
    throw err('ERR_OUTSIDE', 'file outside git repo root');
  }
  try {
    await new Promise((resolve, reject) => {
      execFile('git', ['-C', gitRoot, 'add', '--', gitRelPath],
        { timeout: 5000, maxBuffer: 64 * 1024 },
        (e) => e ? reject(e) : resolve());
    });
  } catch (e) {
    throw err('ERR_GIT_ADD', 'git add failed: ' + e.message);
  }
  return { ok: true, path: relPath, action: 'accepted' };
}

// fr-77 r12: discard a single changed file's worktree changes.
// • Untracked ('?'): delete the file from disk.
// • Staged-add (status 'A' from index alone): unstage + delete.
// • Tracked changes (M, D, U, R, C): `git checkout HEAD -- <path>` to
//   restore the HEAD version. Picks up both worktree + staged changes.
// Throws ERR_NO_GIT in repo-less workspaces. Caller is expected to
// have asked the user to confirm (it's destructive).
async function rejectFile(absRoot, relPath) {
  await safeJoin(absRoot, relPath);
  const gitInfo = _findGitRoot(absRoot);
  if (!gitInfo) throw err('ERR_NO_GIT', 'not a git workspace');
  const { gitRoot, relPrefix } = gitInfo;
  let gitRelPath = relPath;
  if (relPrefix && relPath.startsWith(relPrefix)) {
    gitRelPath = relPath.slice(relPrefix.length);
  } else if (relPrefix && !relPath.startsWith(relPrefix)) {
    throw err('ERR_OUTSIDE', 'file outside git repo root');
  }
  // Look up current status so we know whether to delete (untracked /
  // staged-add) or git-checkout (tracked changes).
  const gitMap = await _gitStatusMap(absRoot);
  const status = gitMap ? gitMap.get(relPath) : null;
  const absPath = path.join(absRoot, relPath);
  if (status === '?' || status === 'A') {
    // Untracked → just delete. Staged-add → unstage first, then delete.
    if (status === 'A') {
      try {
        await new Promise((resolve, reject) => {
          execFile('git', ['-C', gitRoot, 'reset', 'HEAD', '--', gitRelPath],
            { timeout: 5000, maxBuffer: 64 * 1024 },
            (e) => e ? reject(e) : resolve());
        });
      } catch (e) { throw err('ERR_GIT_RESET', 'git reset failed: ' + e.message); }
    }
    try { await fsp.unlink(absPath); }
    catch (e) {
      if (e.code !== 'ENOENT') throw err('ERR_DELETE', 'delete failed: ' + e.message);
    }
    return { ok: true, path: relPath, action: 'rejected', mode: 'deleted' };
  }
  // Tracked changes (M / D / R / C / U): restore the HEAD version.
  // `git checkout HEAD -- <path>` covers both worktree-modify (reverts
  // the change) and worktree-delete (recreates the file from HEAD).
  try {
    await new Promise((resolve, reject) => {
      execFile('git', ['-C', gitRoot, 'checkout', 'HEAD', '--', gitRelPath],
        { timeout: 5000, maxBuffer: 64 * 1024 },
        (e) => e ? reject(e) : resolve());
    });
  } catch (e) {
    throw err('ERR_GIT_CHECKOUT', 'git checkout failed: ' + e.message);
  }
  return { ok: true, path: relPath, action: 'rejected', mode: 'reverted' };
}

module.exports = { safeJoin, listDir, readFile, writeFile, listChangedFiles, readDiff, acceptFile, rejectFile };
