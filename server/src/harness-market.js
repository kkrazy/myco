// server/src/harness-market.js — P6 + P7.
//
// P6: builds a harness market item from a finished sweep's selected tree
//     and publishes it to the generic market store (market.js type='harness').
// P7: lists, installs, and validates harness items from the market.
//
// A harness item shape (stored as a market.js 'harness' item):
//   {
//     name, description,              // standard market fields
//     surface:  'myco',               // always 'myco' for now
//     files: { <rel>: <sha1> },       // harness tree, name→hash
//     sweepTag: 'myco-myco-agg2',     // namespace that produced it
//     task:     'bug-1',              // task the sweep ran on
//     mode:     'agg',                // selection mode
//     k:        2,                    // sweep k
//     domain:   'Bug',               // task domain
//     selectionWhy: '...',            // selector's stated reason
//   }
//
// On install the harness tree is written to the session cwd exactly as
// adoptHarness() in harness-result.js does: harness²'s c1..c8 layout is
// mapped onto myco's file layout.

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const fsp    = require('fs/promises');
const path   = require('path');

const marketApi = require('./market');

// Maximum total size of all harness files combined.
const MAX_HARNESS_BYTES = 256 * 1024;
// Maximum single file.
const MAX_FILE_BYTES = 64 * 1024;

// True when `rel` is a plain relative path that cannot escape the directory it
// is joined onto. Rejects the three shapes that make `path.join` leave the
// tree: an absolute path, a Windows drive/UNC prefix, and any `..` segment.
//
// Checked segment-wise rather than by resolving against a synthetic root:
// path.resolve('/chroot', 'x') returns 'C:\\chroot\\x' on Windows, so a
// startsWith('/chroot') test rejects EVERY well-formed key there.
function _isContainedRelPath(rel) {
  const norm = String(rel || '').replace(/\\/g, '/');
  if (!norm) return false;
  if (norm.startsWith('/')) return false;               // absolute
  if (/^[A-Za-z]:/.test(norm)) return false;            // windows drive
  if (norm.startsWith('//')) return false;              // UNC
  return !norm.split('/').includes('..');
}

// ── validation ─────────────────────────────────────────────────────────────

// Validate a harness tree from the market:
//   - no path traversal (a key must not escape the session root)
//   - every .py file under scripts/ must pass py_compile
//   - any hooks.json must load cleanly through loadHooks
//   - surface must be 'myco' (the only surface we install for)
//   - total size within MAX_HARNESS_BYTES (checked against _fileContent, not _content)
function validateTree(item) {
  if (item.surface && item.surface !== 'myco') {
    throw Object.assign(
      new Error(`harness surface '${item.surface}' is not 'myco'; install refused`),
      { code: 'ERR_BAD_INPUT' }
    );
  }

  // Path traversal guard: every key must be a plain relative path that cannot
  // escape the session root (no `..` segments, no absolute/drive prefixes).
  const engine = _requireEngine();
  const files = item.files || {};
  for (const rel of Object.keys(files)) {
    if (rel.includes('\0')) {
      throw Object.assign(new Error(`file key '${rel}' contains a null byte`), { code: 'ERR_BAD_INPUT' });
    }
    // The mapped destination is what actually gets written.
    const mapped = engine.mapHarnessPath(rel);
    if (!mapped) continue; // unmapped keys are silently skipped at install time
    const sentinel = mapped.startsWith('n2:'); // n2 sentinels are never written to disk
    if (sentinel) continue;
    // Check the RAW key as well as the mapped path: a hostile key like
    // `scripts/../../../../etc/cron.d/pwned` maps to a plausible-looking
    // relative path, so the key itself is the thing that has to be clean.
    if (!_isContainedRelPath(rel) || !_isContainedRelPath(mapped)) {
      throw Object.assign(
        new Error(`file key '${rel}' maps to '${mapped}' which escapes the session root`),
        { code: 'ERR_BAD_INPUT' }
      );
    }
  }

  // Size validation: use _fileContent (the installation payload), not _content.
  const content = item._fileContent || item._content || {};
  let totalBytes = 0;
  for (const [rel, text] of Object.entries(content)) {
    if (typeof text !== 'string') continue;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_FILE_BYTES) {
      throw Object.assign(
        new Error(`file ${rel} exceeds maximum size (${bytes} > ${MAX_FILE_BYTES})`),
        { code: 'ERR_TOO_LARGE' }
      );
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_HARNESS_BYTES) {
    throw Object.assign(
      new Error(`harness item exceeds maximum total size (${totalBytes} > ${MAX_HARNESS_BYTES})`),
      { code: 'ERR_TOO_LARGE' }
    );
  }
}

// ── P6: publish a sweep's chosen harness to the market ────────────────────

// Build a harness market item from a selection record + the chosen workspace.
// sweepMeta: { sweepTag, task, mode, k, domain } — all taken from the runner.
// Returns the item shape ready for publishToMarket.
async function buildFromSweep(selection, sweepMeta) {
  if (!selection || !selection.ok) {
    throw Object.assign(
      new Error('sweep has no successful selection yet'),
      { code: 'ERR_NOT_FOUND' }
    );
  }
  const wsDir = selection.chosen_run_dir
    ? path.join(selection.chosen_run_dir, 'workspace')
    : null;
  if (!wsDir || !fs.existsSync(wsDir)) {
    throw Object.assign(
      new Error(`chosen workspace not found at ${wsDir}`),
      { code: 'ERR_NOT_FOUND' }
    );
  }

  const engine  = _requireEngine();
  const files   = {};
  const content = {};

  for (const rel of _walkDir(wsDir)) {
    const norm = rel.split(path.sep).join('/');
    // Only include files that map to a known harness component.
    const mapped = engine.mapHarnessPath(norm);
    if (!mapped && norm !== 'guardrails.md') continue;
    const abs  = path.join(wsDir, rel);
    const text = _readSafe(abs);
    if (text === null) continue;
    const sha1 = crypto.createHash('sha1').update(text, 'utf8').digest('hex');
    files[norm]   = sha1;
    content[norm] = text;
  }

  const item = {
    name:         `${sweepMeta.sweepTag}/${sweepMeta.task}`,
    description:  `${sweepMeta.domain} harness for task ${sweepMeta.task} (${sweepMeta.sweepTag})`,
    surface:      'myco',
    files,
    sweepTag:     sweepMeta.sweepTag || '',
    task:         sweepMeta.task || '',
    mode:         sweepMeta.mode || '',
    k:            sweepMeta.k || 1,
    domain:       sweepMeta.domain || '',
    selectionWhy: selection.why || '',
    _content:     content,   // stripped before persisting
  };

  validateTree(item);
  return item;
}

// Publish a harness item to the market store.
// Returns the result from market.publishToMarket.
async function publishFromSweep(selection, sweepMeta, user) {
  const item = await buildFromSweep(selection, sweepMeta);

  // market.js publish flow: savePersonal first, then publishToMarket(user, type, name).
  // The personal store accepts the full harness body including _fileContent.
  await marketApi.savePersonal(user, 'harness', item);
  return marketApi.publishToMarket(user, 'harness', item.name);
}

// ── P7: install a harness from the market into a session cwd ──────────────

// Install a harness market item into a session's working directory.
// Maps the harness²'s c1..c8 tree onto myco's layout, same as adoptHarness.
// Returns { installed: [rel], snapshot }.
async function installIntoSession(itemName, cwdRoot, user) {
  // market.js readMarketItem takes positional (type, name) args.
  const raw = await marketApi.readMarketItem('harness', itemName);
  if (!raw) {
    throw Object.assign(
      new Error(`harness '${itemName}' not found in market`),
      { code: 'ERR_NOT_FOUND' }
    );
  }

  validateTree(raw);

  const content = raw._fileContent || {};
  if (Object.keys(content).length === 0) {
    throw Object.assign(
      new Error(`harness '${itemName}' has no file content stored; re-publish`),
      { code: 'ERR_BAD_INPUT' }
    );
  }

  const engine  = _requireEngine();
  const written = [];

  // Snapshot first so the user can roll back.
  const snapshot = { id: crypto.randomBytes(6).toString('hex'), ts: new Date().toISOString(), entries: [] };

  // C2 fix: collect systemprompt + guardrails first, write CLAUDE.md once.
  // The old code appended guardrails, then the alphabetical walk hit
  // systemprompt.md → CLAUDE.md and overwrote, destroying guardrails.
  let systemPromptText = null;
  let guardrailsText   = null;
  const otherEntries   = [];

  for (const [norm, text] of Object.entries(content)) {
    if (norm === 'systemprompt.md') { systemPromptText = text; continue; }
    if (norm === 'guardrails.md')   { guardrailsText   = text; continue; }
    otherEntries.push([norm, text]);
  }

  // Write CLAUDE.md once with both role + guardrails composed.
  if (systemPromptText !== null || guardrailsText !== null) {
    const claudeMd = path.join(cwdRoot, 'CLAUDE.md');
    const prior    = _readSafe(claudeMd);
    snapshot.entries.push({ dst: 'CLAUDE.md', content: prior });
    let composed   = (systemPromptText || '');
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
    await fsp.mkdir(path.dirname(claudeMd), { recursive: true });
    await fsp.writeFile(claudeMd, composed, 'utf8');
    written.push('CLAUDE.md');
  }

  // Write every other mapped component.
  for (const [norm, text] of otherEntries) {
    const mapped = engine.mapHarnessPath(norm);
    if (!mapped) continue;
    if (mapped.startsWith('n2:')) continue; // n2 sentinels are never written to disk
    const dst   = path.join(cwdRoot, mapped);
    const prior = _readSafe(dst);
    snapshot.entries.push({ dst: mapped, content: prior });
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.writeFile(dst, text, 'utf8');
    written.push(mapped);
  }

  // C1 fix: write the P8 sentinel so the next sweep can use this harness
  // as its base. Store the harness² source tree path — it must be a
  // harness²-layout dir (not the mapped myco tree) for HARNESS2_MYCO_BASE_HARNESS
  // to be usable by the Python adapter. We store the market item name here so
  // harness-runner.js can reconstruct or look up the path.
  const sentinelPath = path.join(cwdRoot, '_harness_', 'market-installed.json');
  await fsp.mkdir(path.dirname(sentinelPath), { recursive: true });
  await fsp.writeFile(sentinelPath, JSON.stringify({
    itemName,
    installedAt: new Date().toISOString(),
    installedBy: user || null,
    // harnessDir is intentionally null here: the harness was installed in
    // MAPPED form (myco layout). The next sweep will re-derive the base from the
    // installed CLAUDE.md/.claude/ tree via MycoAdapter.base_harness().
    harnessDir: null,
  }, null, 2) + '\n', 'utf8');

  return { installed: written, snapshot, itemName };
}

// ── list + describe ────────────────────────────────────────────────────────

// List all harness items visible to user (market + personal if any).
async function listHarnesses(user) {
  try {
    // market.js listMarket(user) returns an object keyed by type: {expert,team,mcp,harness}.
    const all = await marketApi.listMarket(user);
    const harnessEntries = (all && all.harness) ? all.harness : [];
    return harnessEntries.filter(i => i.type === 'harness' || !i.type);
  } catch (e) {
    if (e.code === 'ERR_BAD_INPUT') return []; // type not registered yet
    throw e;
  }
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
  validateTree,
  buildFromSweep,
  publishFromSweep,
  installIntoSession,
  listHarnesses,
};
