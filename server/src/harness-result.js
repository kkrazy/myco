// server/src/harness-result.js — P4.
//
// Reads the output of a finished Harness² sweep, shows what changed,
// and lets the user adopt the chosen harness into the live session or
// roll back a previous adoption.
//
// Vocabulary:
//   sweep dir   _harness_/sweeps/<id>/         (written by harness-runner.js)
//   result.json _harness_/sweeps/<id>/result.json  written by run_sweep
//   harness dir the chosen harness tree from the sweep
//   adoption    copying the harness tree onto the session cwd, mapping
//               harness²'s c1..c8 layout → myco's CLAUDE.md/.claude/etc.
//
// The caller (slashcmds.js /harness adopt|diff|rollback) is responsible for
// auth; nothing here checks permissions.

'use strict';

const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// ── result file ────────────────────────────────────────────────────────────

// Where run_sweep writes its sweep-level JSON.
// Format (from harness2/cli/run_sweep.py output):
//   { benchmark, substrate, k, modes, domain_order, domains:[{domain, tasks:[{task,status,…}]}], … }
// The per-task selection lives at:
//   <runs_root>/<namespace>/bug-1/selection/<mode>/selection.json
//
// We derive the namespace from the sweep status rather than the Python config
// so the Node side never re-implements harness2's namespace formula.
function readResult(cwd, id) {
  const runner = require('./harness-runner');
  const dir    = runner.sweepDir(cwd, id);
  const file   = path.join(dir, 'result.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// ── selection lookup ───────────────────────────────────────────────────────

// Find the selection record for the latest/given sweep. Returns null when
// the sweep has not produced a selection yet (still running or failed).
function findSelection(cwd, id) {
  const runner = require('./harness-runner');
  const st     = runner.getStatus(cwd, id || null);
  if (!st) return null;
  // 'timeout' is NOT a failure of the selection. harness² writes selection.json
  // during the sweep's closing phase, so a sweep that is killed by its
  // wall-clock cap AFTER that point still has a perfectly valid result on disk.
  // Observed: sw-20261031-080845 ran 18003.6s, every rollout delivered, agg1
  // selected and written — and /harness diff reported "No successful selection
  // found" purely because the status said timeout. Only treat 'failed' and
  // 'cancelled' as "no result to read".
  if (st.status !== 'success' && st.status !== 'timeout') return null;

  // run_sweep writes the namespace inside the sweep env.
  // status.json may carry it; fall back to the result file.
  const statusNs = (st.namespace || '').trim();
  const result   = readResult(cwd, id || st.id);
  const ns       = statusNs || (result && result.namespace) || null;
  if (!ns) return null;

  const roots = _runsRoots(cwd);
  const k = st.k || 1;

  // Build the task list from three sources in priority order:
  //   1. result.json domains (written by run_sweep when present)
  //   2. summary.json task_id  (always written by harness² adapt)
  //   3. The task string on the harness² inline-task name
  //
  // result.json is OPTIONAL — the sweep runner does not currently write
  // it in the myco adapter path — so (1) silently comes up empty.
  // Sources (2) and (3) are always available and give equivalent task ids.
  const tasksFromResult = (result && result.domains || []).flatMap(d => d.tasks || []);
  let taskIds = tasksFromResult.map(t => t.task);

  if (!taskIds.length) {
    // Try summary.json under adapt/<ns>/<any task dir>/summary.json, in every
    // candidate root: a sweep started before the per-session move keeps its
    // summary in the legacy tree.
    for (const runsRoot of roots) {
      const adaptNsDir = path.join(runsRoot, ns);
      try {
        const entries = fs.readdirSync(adaptNsDir);
        for (const entry of entries) {
          const summaryFile = path.join(adaptNsDir, entry, 'summary.json');
          try {
            const s = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
            if (s && s.task_id && !taskIds.includes(s.task_id)) taskIds.push(s.task_id);
          } catch {}
        }
      } catch {}
    }
  }

  // Final fallback: use status.task hashed to the harness² inline-task name
  // (the adapter always calls the task "inline-task" for user-supplied prompts).
  if (!taskIds.length) taskIds = ['inline-task'];

  // Newest layout first, then the pre-isolation tree. A sweep started before
  // the per-session move keeps writing to the old image-layer root, and its
  // selection must stay reachable until it finishes.
  for (const runsRoot of roots) {
    const found = _findSelectionUnder(runsRoot, ns, taskIds, k);
    if (found) return found;
  }
  return null;
}

function _findSelectionUnder(runsRoot, ns, taskIds, k) {
  // mode priority: parallel > agg (harness² writes "agg" for the aggregate)
  for (const mode of ['parallel', 'agg']) {
    for (const task of taskIds) {
      const sel = path.join(runsRoot, ns, task, 'selection', `${mode}${k}`, 'selection.json');
      try {
        const data = JSON.parse(fs.readFileSync(sel, 'utf8'));
        if (data && data.ok) return { ...data, _path: sel };
      } catch {}
    }
  }
  return null;
}

// Both candidate roots, newest first. Deduped: the env override and the
// per-session derivation can point at the same place.
function _runsRoots(cwd) {
  const out = [_runsRoot(cwd)];
  const legacyEnv = (process.env.HARNESS2_RUNS_DIR || '').trim();
  if (legacyEnv) {
    const p = path.join(legacyEnv, 'myco', 'adapt');
    if (!out.includes(p)) out.push(p);
  }
  const vendorRoot = path.resolve(__dirname, '..', '..', 'vendor', 'harness2');
  const legacy = path.join(vendorRoot, 'runs', 'myco', 'adapt');
  if (!out.includes(legacy)) out.push(legacy);
  return out;
}

function _runsRoot(cwd) {
  // Must agree with harness-runner.js runsRootFor(): the sweep writes there,
  // and this reads back. Keeping one derivation in harness-runner and calling
  // it here is what stops the two sides from drifting the way they did when
  // HARNESS2_RUNS_DIR was set on one side only.
  try {
    const runner = require('./harness-runner');
    if (typeof runner.runsRootFor === 'function') {
      return path.join(runner.runsRootFor(cwd), 'myco', 'adapt');
    }
  } catch { /* fall through to the legacy layout */ }
  const envDir = (process.env.HARNESS2_RUNS_DIR || '').trim();
  if (envDir) return path.join(envDir, 'myco', 'adapt');
  // Legacy: the pre-isolation image-layer tree.
  const vendorRoot = path.resolve(__dirname, '..', '..', 'vendor', 'harness2');
  return path.join(vendorRoot, 'runs', 'myco', 'adapt');
}

// ── diff ───────────────────────────────────────────────────────────────────

// Walk a harness tree (chosen run dir / workspace) and return
// { path: rel, status: 'added'|'modified'|'removed', content }
// compared to the current session cwd. Components that the harness
// engine would map to myco paths are reported under those myco paths.
function diffHarness(harnessDir, cwdRoot) {
  const engine = _requireEngine();
  const changes = [];

  // Collect systemprompt + guardrails so CLAUDE.md is compared as the
  // COMPOSED content (role + guardrails block), not the raw systemprompt
  // alone — otherwise an adopted harness always shows a "modified" CLAUDE.md.
  let systemPromptText = null;
  let guardrailsText   = null;

  for (const rel of _walkDir(harnessDir)) {
    const norm   = rel.split(path.sep).join('/');
    if (norm === 'systemprompt.md') {
      systemPromptText = _readSafe(path.join(harnessDir, rel));
      continue;
    }
    if (norm === 'guardrails.md') {
      guardrailsText = _readSafe(path.join(harnessDir, rel));
      continue;
    }
    const mapped = engine.mapHarnessPath(norm);
    if (!mapped) continue;
    const src    = path.join(harnessDir, rel);
    const dst    = path.join(cwdRoot, mapped);
    const srcTxt = _readSafe(src);
    const dstTxt = _readSafe(dst);
    if (dstTxt === null) {
      changes.push({ path: mapped, status: 'added',    content: srcTxt });
    } else if (srcTxt !== dstTxt) {
      changes.push({ path: mapped, status: 'modified', from: dstTxt, content: srcTxt });
    }
  }

  // Compose CLAUDE.md the way adoptHarness would, then compare.
  if (systemPromptText !== null || (guardrailsText && guardrailsText.trim())) {
    let composed = (systemPromptText || '');
    if (guardrailsText && guardrailsText.trim()) {
      composed += [
        '',
        '<!-- harness2:guardrails (c2) -->',
        '## Guardrails',
        '',
        guardrailsText.trim(),
        '',
      ].join('\n');
    }
    const dst = path.join(cwdRoot, 'CLAUDE.md');
    const dstTxt = _readSafe(dst);
    if (dstTxt === null) {
      changes.push({ path: 'CLAUDE.md', status: 'added', content: composed });
    } else if (composed !== dstTxt) {
      changes.push({ path: 'CLAUDE.md', status: 'modified', from: dstTxt, content: composed });
    }
  }

  return changes;
}

// ── adopt ──────────────────────────────────────────────────────────────────

// Copy the chosen harness tree onto the session cwd, mapping c1..c8 paths
// onto myco's layout. Saves a snapshot first so rollback is possible.
// Returns { adopted: [rel], snapshot }.
async function adoptHarness(harnessDir, cwdRoot) {
  const engine  = _requireEngine();
  const written = [];

  // 1. Snapshot whatever we are about to overwrite.
  const snapshot = await _snapshot(harnessDir, cwdRoot);

  // 2. Collect systemprompt and guardrails first, then write CLAUDE.md once.
  let systemPromptText = null;
  let guardrailsText   = null;
  const otherFiles     = [];

  for (const rel of _walkDir(harnessDir)) {
    const norm = rel.split(path.sep).join('/');
    if (norm === 'DELIVERABLE') continue;
    if (norm === 'systemprompt.md') {
      systemPromptText = _readSafe(path.join(harnessDir, rel)) || '';
      continue;
    }
    if (norm === 'guardrails.md') {
      guardrailsText = _readSafe(path.join(harnessDir, rel)) || '';
      continue;
    }
    otherFiles.push(rel);
  }

  // 3. Write CLAUDE.md once with both role and guardrails.
  if (systemPromptText !== null || guardrailsText !== null) {
    const claudeMd = path.join(cwdRoot, 'CLAUDE.md');
    let content    = (systemPromptText || '');
    if (guardrailsText && guardrailsText.trim()) {
      const block = [
        '',
        '<!-- harness2:guardrails (c2) -->',
        '## Guardrails',
        '',
        guardrailsText.trim(),
        '',
      ].join('\n');
      content += block;
    }
    await fsp.mkdir(path.dirname(claudeMd), { recursive: true });
    await fsp.writeFile(claudeMd, content, 'utf8');
    written.push('CLAUDE.md');
  }

  // 4. Copy every other mapped component.
  for (const rel of otherFiles) {
    const norm   = rel.split(path.sep).join('/');
    const mapped = engine.mapHarnessPath(norm);
    if (!mapped) continue;

    const src = path.join(harnessDir, rel);
    const dst = path.join(cwdRoot, mapped);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
    written.push(mapped);
  }

  return { adopted: written, snapshot };
}

// ── rollback ───────────────────────────────────────────────────────────────

// Restore files from a snapshot written by adoptHarness.
// Returns { restored: [rel], removed: [rel] }.
async function rollbackHarness(snapshot, cwdRoot) {
  const restored = [];
  const removed  = [];
  for (const { dst, content } of snapshot.entries) {
    const abs = path.join(cwdRoot, dst);
    if (content === null) {
      // File did not exist before — remove it.
      try { await fsp.rm(abs, { force: true }); removed.push(dst); }
      catch {}
    } else {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, 'utf8');
      restored.push(dst);
    }
  }
  return { restored, removed };
}

// ── snapshot helpers ───────────────────────────────────────────────────────

// Snapshot every file the adoption would overwrite (or create fresh).
// Returns { id, ts, entries: [{dst, content}] }.
// content is null when the file did not exist before.
async function _snapshot(harnessDir, cwdRoot) {
  const engine  = _requireEngine();
  const entries = [];
  const seen    = new Set();

  for (const rel of _walkDir(harnessDir)) {
    const norm   = rel.split(path.sep).join('/');
    if (norm === 'DELIVERABLE') continue;

    const targets = [];
    if (norm === 'guardrails.md') {
      targets.push('CLAUDE.md'); // we append to CLAUDE.md
    } else {
      const mapped = engine.mapHarnessPath(norm);
      if (mapped) targets.push(mapped.split(path.sep).join('/'));
    }

    for (const t of targets) {
      if (seen.has(t)) continue;
      seen.add(t);
      const abs     = path.join(cwdRoot, t);
      const content = _readSafe(abs); // null → did not exist
      entries.push({ dst: t, content });
    }
  }

  return {
    id:      crypto.randomBytes(6).toString('hex'),
    ts:      new Date().toISOString(),
    entries,
  };
}

// A snapshot's filename stem. `sweepId` is NOT always a plain sweep id:
// callers pass sel.chosen_run_id as the fallback, and harness² run ids are
// namespaced ("myco-myco-agg1/inline-task/agg1"). Joined straight into a
// filename, those slashes become extra path segments — mkdir created only
// `snapshots/`, so saveSnapshot threw
//   ENOENT: .../_harness_/snapshots/myco-myco-agg1/inline-task/agg1-<hex>.json
// and /harness adopt failed with a path the user never supplied.
// Flatten every path separator (and anything else hostile) to a dash.
function _snapshotStem(sweepId) {
  return String(sweepId || 'sweep').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'sweep';
}

// Persist a snapshot to disk and return the path.
async function saveSnapshot(snapshot, cwd, sweepId) {
  const dir  = path.join(cwd, '_harness_', 'snapshots');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${_snapshotStem(sweepId)}-${snapshot.id}.json`);
  await fsp.writeFile(file, JSON.stringify(snapshot, null, 2), 'utf8');
  return file;
}

// Load a snapshot from disk. Returns null when not found.
function loadSnapshot(cwd, sweepId, snapshotId) {
  const dir  = path.join(cwd, '_harness_', 'snapshots');
  const stem = _snapshotStem(sweepId);
  // Match either exact filename or any snapshot for this sweep.
  const want = snapshotId ? `${stem}-${snapshotId}.json` : null;
  try {
    const files = fs.readdirSync(dir);
    const cands = files.filter(f => f.startsWith(stem + '-') && f.endsWith('.json'));
    if (!cands.length) return null;
    if (want) {
      const exact = cands.find(f => f === want);
      if (!exact) return null;
      return JSON.parse(fs.readFileSync(path.join(dir, exact), 'utf8'));
    }
    // C3 fix: sort by the ts field inside the file, not the random hex suffix.
    // The snapshot id is random bytes, so lexicographic order is arbitrary and
    // routinely returns stale state instead of the most-recent snapshot.
    let best = null;
    let bestTs = '';
    for (const f of cands) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const ts = (data && data.ts) ? data.ts : '';
        if (ts > bestTs) { bestTs = ts; best = data; }
      } catch { /* skip corrupt files */ }
    }
    return best;
  } catch {
    return null;
  }
}

// List available snapshots for a sweep.
function listSnapshots(cwd, sweepId) {
  const dir = path.join(cwd, '_harness_', 'snapshots');
  const stem = _snapshotStem(sweepId);
  try {
    return fs.readdirSync(dir)
      .filter(f => f.startsWith(stem + '-'))
      .sort().reverse();
  } catch {
    return [];
  }
}

// ── format diff for display ────────────────────────────────────────────────

function formatDiff(changes) {
  if (!changes.length) return '_No harness changes would be made._';
  const lines = [`**${changes.length} change(s):**\n`];
  for (const c of changes) {
    const badge = c.status === 'added' ? '➕' : '✏️';
    lines.push(`${badge} \`${c.path}\``);
    if (c.status === 'modified' && c.from && c.content) {
      const a = (c.from.match(/\n/g) || []).length + 1;
      const b = (c.content.match(/\n/g) || []).length + 1;
      lines.push(`   _${a} → ${b} lines_`);
    }
  }
  return lines.join('\n');
}

// ── harness dir from a selection ──────────────────────────────────────────

// Given a selection record, return the path to the chosen harness tree.
// Return the harness² source tree (pre-mapping) for a selection.
// A3 fix: `chosen_run_dir/workspace` is the MAPPED myco layout; diff/adopt/
// publish all walk it expecting harness² names (systemprompt.md, sub_agents/…),
// so they always found nothing. The actual pre-mapping tree is recorded in
// each run's meta.json as `harness_dir`. Fall back to the workspace only when
// meta.json is absent (e.g. dry-run stubs that predate the meta format).
function harnessDir(selection) {
  if (!selection || !selection.chosen_run_dir) return null;
  const metaFile = path.join(selection.chosen_run_dir, 'meta.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (meta && meta.harness_dir) return meta.harness_dir;
  } catch { /* fall through */ }
  // Legacy fallback — workspace contains the mapped layout, not harness² names,
  // but this was the prior behaviour and is better than returning null entirely.
  return path.join(selection.chosen_run_dir, 'workspace');
}

// ── deliverables (the PEARL, not the casket) ──────────────────────────────

// /harness adopt installs the HARNESS. It does not copy what the agent
// actually produced, which is the whole point for someone optimising the
// algorithm rather than the scaffolding. A rollout's workspace mixes three
// kinds of file and only one of them is the agent's work:
//
//   task inputs   copied in by materialiseTask, unchanged   → noise
//   harness files copied in by materialiseHarness           → noise
//   everything else: added, or MODIFIED away from its seed  → the deliverable
//
// meta.json records the seed hashes only for whether they were written, not
// their digests, so "modified" has to be decided by comparing against the
// task dir itself (meta.task_dir), which is still on disk.
const _DELIV_IGNORE = new Set([
  '.git', '_myco_', '_harness_', 'node_modules', '.venv',
  '__pycache__', '.claude', '.myco_harness',
]);

// Not the agent's algorithm: build output and test fixtures it downloaded for
// itself. Observed in a real sweep — base1's workspace held dataset/dickens and
// dataset/mr (10 MB each, identical across all four runs) plus a 74 KB compiled
// bench and an 876 KB PNG of the task statement. Pulling all four candidates
// would have copied ~40 MB of duplicated data and binaries and buried the 10 KB
// of source that actually matters.
//
// Three signals, because no single one covers what actually shows up:
//   size        catches a 10 MB dataset | text corpus that has no binary tell
//   extension   catches PNG/PDF/archives even when they are small
//   content     catches a compiled binary with NO extension — `sol/bench` and
//               `sol/zcomp_test` are 74 KB ELF files, under any sane size
//               limit and invisible to an extension check
// The extension set is the one the Python adapter already treats as binary, so
// both sides agree on what "not readable text" means. MYCO_PULL_MAX_BYTES /
// MYCO_PULL_SKIP_EXTS widen or narrow it; pull reports every skipped file
// rather than dropping it silently.
const _PULL_BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tiff',
  '.pdf', '.docx', '.xlsx', '.pptx',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.zst',
  '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.mp3', '.wav', '.ogg', '.flac',
  '.ttf', '.woff', '.woff2', '.otf',
  '.so', '.dylib', '.dll', '.exe', '.bin', '.o', '.a',
  '.pyc', '.pyo',
]);
const _PULL_MAX_BYTES = Number(process.env.MYCO_PULL_MAX_BYTES) || 1024 * 1024;

// Files the agent produced in one rollout workspace.
// Returns [{ rel, abs, status: 'added'|'modified', bytes }].
// `opts.all` disables the size/extension filter (data and build output too).
function listDeliverables(runDir, opts = {}) {
  const engine = _requireEngine();
  const wsDir  = path.join(runDir, 'workspace');
  if (!fs.existsSync(wsDir)) return [];

  const meta = _readJson(path.join(runDir, 'meta.json')) || {};
  const seeded = _seedDigests(meta.task_dir);
  const harnessWritten = new Set(
    (meta.harnessWritten || []).map(r => String(r).split(path.sep).join('/')));

  const out = [];
  const skipped = [];
  for (const rel of engine.walkFiles(wsDir)) {
    const norm = rel.split(path.sep).join('/');
    const parts = norm.split('/');
    if (_DELIV_IGNORE.has(parts[0])) continue;
    // Dotfiles are tool state (.bashrc history, editor caches), never output.
    if (parts.some(p => p.startsWith('.'))) continue;
    if (harnessWritten.has(norm)) continue;

    const abs = path.join(wsDir, rel);
    let bytes = 0;
    try { bytes = fs.statSync(abs).size; } catch { continue; }

    if (!opts.all && _isBulk(abs, norm, bytes)) {
      skipped.push({ rel: norm, bytes });
      continue;
    }

    if (seeded.has(norm)) {
      // Present in the task dir. Identical → an input the agent never touched.
      // Different → the agent's change IS the deliverable (a one-line bug fix
      // lives here, and dropping it was the whole failure mode of the old
      // turns-only gate).
      let now = null;
      try { now = engine.sha1File(abs); } catch { continue; }
      if (now === seeded.get(norm)) continue;
      out.push({ rel: norm, abs, status: 'modified', bytes });
    } else {
      out.push({ rel: norm, abs, status: 'added', bytes });
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  // Non-enumerable so the array API stays `[file, ...]` for callers that only
  // want the file list; pull() reads it to report what it left behind.
  Object.defineProperty(out, 'skipped', { value: skipped, enumerable: false });
  return out;
}

// Build output or a bulk fixture rather than source.
function _isBulk(abs, rel, bytes) {
  if (bytes > _PULL_MAX_BYTES) return true;
  const ext = path.extname(rel).toLowerCase();
  if (ext && _PULL_BINARY_EXTS.has(ext)) return true;
  const extra = (process.env.MYCO_PULL_SKIP_EXTS || '').trim();
  if (ext && extra &&
      extra.split(',').map(e => e.trim().toLowerCase()).filter(Boolean).includes(ext)) {
    return true;
  }
  return _looksBinary(abs);
}

// A NUL byte in the first 8 KB is the classic text/binary split (git uses it).
// Cheap enough to run per file and catches ELF/Mach-O/compiled objects that
// carry no extension at all.
function _looksBinary(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return true;  // unreadable — do not pretend it is source
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// name -> sha1 for every file in the task dir (the seeds materialiseTask wrote).
function _seedDigests(taskDir) {
  const engine = _requireEngine();
  const map = new Map();
  if (!taskDir || !fs.existsSync(taskDir)) return map;
  for (const rel of engine.walkFiles(taskDir)) {
    const norm = rel.split(path.sep).join('/');
    if (norm === 'DELIVERABLE') continue;
    try { map.set(norm, engine.sha1File(path.join(taskDir, rel))); } catch { /* unreadable */ }
  }
  return map;
}

// Every run dir in the same rollouts/ directory that has a workspace.
// This is how a `pull --all` hands back all four candidates side by side,
// which is what you need to compare algorithms rather than just take the
// blind-selected one on faith.
function siblingRuns(runDir) {
  const root = path.dirname(runDir);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'workspace')))
    .map(e => path.join(root, e.name))
    .sort();
}

// File-name stem safe for a directory name. Run ids are already flat, but a
// rescued/renamed tree can carry anything, and this path is created under the
// user's session cwd.
function runLabel(runDir) {
  const base = path.basename(String(runDir || 'run'));
  return base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
}

// Copy the deliverable files of one run into `destDir`. Returns
// { label, dest, files: [{rel, status, bytes}] }.
async function pullDeliverables(runDir, destDir, opts = {}) {
  const files = listDeliverables(runDir, opts);
  const label = runLabel(runDir);
  for (const f of files) {
    const dst = path.join(destDir, f.rel);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(f.abs, dst);
  }
  return {
    label,
    dest: destDir,
    files: files.map(f => ({ rel: f.rel, status: f.status, bytes: f.bytes })),
    skipped: files.skipped || [],
  };
}

function _readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// ── private helpers ────────────────────────────────────────────────────────

function _requireEngine() {
  return require(path.join(__dirname, '..', '..', 'bench', 'harness2', 'lib', 'engine'));
}

function _walkDir(root, base = '') {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(path.join(root, base), { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const rel = base ? path.join(base, e.name) : e.name;
    if (e.isDirectory()) out.push(..._walkDir(root, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function _readSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { return null; }
}

module.exports = {
  readResult,
  findSelection,
  diffHarness,
  adoptHarness,
  rollbackHarness,
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
  formatDiff,
  harnessDir,
  listDeliverables,
  siblingRuns,
  pullDeliverables,
  runLabel,
};
