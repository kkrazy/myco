// bug-66: enforce single main project per session; anchor plan +
// memory to main-project/_myco_.
//
// User-reported (verbatim, plan-item dispatch from @kkrazy):
//   Problem:  Sessions can accumulate multiple "main" projects when
//             added via `+`, and project memory/plan paths are not
//             consistently anchored under `main-project/_myco_`.
//   Expected: Each session has exactly one main project. Plan is
//             read from `main-project/_myco_/plan.json`, and
//             `main-project/_myco_` is the canonical root for
//             project memory.
//   Actual:   Adding via `+` permits multiple main projects per
//             session, and plan/memory locations drift away from
//             `main-project/_myco_`.
//
// What this guards (after bug-66 lands):
//
//   1. `setMainProject(rec, name)` is the ONLY function allowed to
//      write `rec.mainProject`. It throws if `rec.mainProject` is
//      already set to a different value (the single-main invariant),
//      throws on empty names, and throws if the resolved
//      `<absCwd>/<name>` doesn't exist as a directory.
//   2. `findProjectRoot(rec)` NEVER falls back to the legacy
//      sibling-subdir auto-detect scan. Either `rec.mainProject`
//      anchors the resolution, or `rec.absCwd` itself is a checkout,
//      or the function returns null — no third "alphabetical-first
//      sibling" path that could drift between reads.
//   3. `migrateMainProjectIfNeeded` is deterministic on multi-
//      candidate legacy workspaces: it picks alphabetical-first and
//      persists via `setMainProject` (instead of bailing with a
//      warning that left the resolver guessing on every call).
//   4. `artifactFilePath(rec, 'plan')` resolves to
//      `<absCwd>/<rec.mainProject>/_myco_/plan.json` — the canonical
//      plan-memory anchor. This is the end-to-end witness that the
//      bug-66 contract is intact.
//   5. `spawnSession` routes its seed write through
//      `setMainProject` (static-grep guard — the only `rec.mainProject =`
//      / `record.mainProject =` assignment lives in artifacts.js'
//      `setMainProject` body; sessions.js' spawn path calls it
//      instead of writing the field directly).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function _mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bug66-'));
}
function _rmTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('── bug-66: single main project + _myco_ anchor ──');

const artifacts = require('../server/src/artifacts');
const { setMainProject, findProjectRoot, migrateMainProjectIfNeeded } = artifacts.__test;
const { artifactFilePath } = artifacts.__test;

// ── 1. setMainProject chokepoint: single-main invariant ──

t('setMainProject: sets rec.mainProject when unset + dir exists', () => {
  const tmp = _mkTmp();
  try {
    fs.mkdirSync(path.join(tmp, 'foo'));
    const rec = { id: 'rec1', absCwd: tmp };
    const out = setMainProject(rec, 'foo');
    assert.strictEqual(out, 'foo', 'returns the trimmed name on success');
    assert.strictEqual(rec.mainProject, 'foo', 'mutates rec.mainProject');
  } finally { _rmTmp(tmp); }
});

t('setMainProject: same-name re-set is an idempotent no-op (does not throw)', () => {
  const tmp = _mkTmp();
  try {
    fs.mkdirSync(path.join(tmp, 'foo'));
    const rec = { id: 'rec-idem', absCwd: tmp, mainProject: 'foo' };
    const out = setMainProject(rec, 'foo');
    assert.strictEqual(out, 'foo', 'idempotent re-set returns the name');
    assert.strictEqual(rec.mainProject, 'foo', 'rec.mainProject still "foo"');
  } finally { _rmTmp(tmp); }
});

t('setMainProject: THROWS when rec.mainProject is already set to a DIFFERENT value (bug-66 single-main invariant)', () => {
  const tmp = _mkTmp();
  try {
    fs.mkdirSync(path.join(tmp, 'foo'));
    fs.mkdirSync(path.join(tmp, 'bar'));
    const rec = { id: 'rec-dup', absCwd: tmp, mainProject: 'foo' };
    assert.throws(
      () => setMainProject(rec, 'bar'),
      /already set|single-main/i,
      'setMainProject must refuse to overwrite an existing rec.mainProject — that is the core single-main invariant bug-66 enforces.'
    );
    assert.strictEqual(rec.mainProject, 'foo', 'failed throw must leave rec.mainProject unchanged');
  } finally { _rmTmp(tmp); }
});

t('setMainProject: throws on empty / whitespace name', () => {
  const tmp = _mkTmp();
  try {
    const rec = { id: 'rec-empty', absCwd: tmp };
    assert.throws(() => setMainProject(rec, ''), /non-empty/i);
    assert.throws(() => setMainProject(rec, '   '), /non-empty/i);
    assert.throws(() => setMainProject(rec, null), /non-empty/i);
    assert.strictEqual(rec.mainProject, undefined, 'rec.mainProject must not be set on any failed call');
  } finally { _rmTmp(tmp); }
});

t('setMainProject: throws when the resolved directory does not exist', () => {
  const tmp = _mkTmp();
  try {
    const rec = { id: 'rec-missing', absCwd: tmp };
    assert.throws(
      () => setMainProject(rec, 'doesnotexist'),
      /does not exist|not a directory/i,
      'setMainProject must defend against anchoring _myco_/ at a non-existent path (ghost writes are silent corruption).'
    );
  } finally { _rmTmp(tmp); }
});

t('setMainProject: throws when rec.absCwd is missing', () => {
  assert.throws(() => setMainProject({ id: 'no-cwd' }, 'foo'), /absCwd is required/i);
});

// ── 2. findProjectRoot: NO legacy auto-detect fallback ──

t('findProjectRoot: returns <absCwd>/<mainProject> when mainProject is set and dir exists', () => {
  const tmp = _mkTmp();
  try {
    const projDir = path.join(tmp, 'alpha');
    fs.mkdirSync(projDir);
    fs.mkdirSync(path.join(projDir, '.git'));
    const rec = { id: 'rec-fpr1', absCwd: tmp, mainProject: 'alpha' };
    assert.strictEqual(findProjectRoot(rec), projDir);
  } finally { _rmTmp(tmp); }
});

t('findProjectRoot: returns null when mainProject is set but dir is missing (Phase 1 r1; preserved by bug-66)', () => {
  const tmp = _mkTmp();
  try {
    const rec = { id: 'rec-fpr2', absCwd: tmp, mainProject: 'ghost' };
    assert.strictEqual(findProjectRoot(rec), null, 'missing mainProject dir must skip the mirror, not fall through to auto-detect.');
  } finally { _rmTmp(tmp); }
});

t('findProjectRoot: returns absCwd when session.absCwd itself is a checkout (no mainProject)', () => {
  const tmp = _mkTmp();
  try {
    fs.mkdirSync(path.join(tmp, '.git'));
    const rec = { id: 'rec-fpr3', absCwd: tmp };
    assert.strictEqual(findProjectRoot(rec), tmp, '"the session IS the project" legacy layout must still resolve.');
  } finally { _rmTmp(tmp); }
});

t('findProjectRoot: NO sibling-subdir auto-detect — returns NULL when mainProject is unset and absCwd is not a checkout (bug-66)', () => {
  // Before bug-66: findProjectRoot would scan absCwd for the
  // alphabetical-first .git/-marked subdir and return that. That
  // produced non-deterministic resolution on multi-repo workspaces
  // (same rec, different reads, different paths). bug-66 retires
  // the fallback — the result here is null, not "<absCwd>/sibling".
  const tmp = _mkTmp();
  try {
    fs.mkdirSync(path.join(tmp, 'sibling-alpha'));
    fs.mkdirSync(path.join(tmp, 'sibling-alpha', '.git'));
    fs.mkdirSync(path.join(tmp, 'sibling-beta'));
    fs.mkdirSync(path.join(tmp, 'sibling-beta', '.git'));
    const rec = { id: 'rec-fpr4', absCwd: tmp };
    assert.strictEqual(
      findProjectRoot(rec),
      null,
      'bug-66 retires the sibling-subdir auto-detect fallback — findProjectRoot must return null here, NOT a sibling path (drift cause).'
    );
  } finally { _rmTmp(tmp); }
});

// ── 3. migrateMainProjectIfNeeded: deterministic on multi-candidate ──

t('migrateMainProjectIfNeeded: no candidates → no-op (returns false; mainProject stays unset)', () => {
  const tmp = _mkTmp();
  try {
    const rec = { id: 'rec-mig1', absCwd: tmp };
    assert.strictEqual(migrateMainProjectIfNeeded(rec), false);
    assert.strictEqual(rec.mainProject, undefined);
  } finally { _rmTmp(tmp); }
});

t('migrateMainProjectIfNeeded: one candidate → sets mainProject to that name, persists', () => {
  const tmp = _mkTmp();
  try {
    fs.mkdirSync(path.join(tmp, 'solo'));
    fs.mkdirSync(path.join(tmp, 'solo', '.git'));
    const rec = { id: 'rec-mig2', absCwd: tmp };
    let saved = 0;
    const out = migrateMainProjectIfNeeded(rec, () => { saved++; });
    assert.strictEqual(out, true, 'returns true when a value was set');
    assert.strictEqual(rec.mainProject, 'solo');
    assert.strictEqual(saved, 1, 'saveStoreFn must fire exactly once on success');
  } finally { _rmTmp(tmp); }
});

t('migrateMainProjectIfNeeded: MULTIPLE candidates → DETERMINISTICALLY picks alphabetical-first + persists (bug-66)', () => {
  // Before bug-66: this branch bailed with a warning and left
  // rec.mainProject unset, so the retired auto-detect kept
  // re-resolving every read. Now: pick "alpha" (alphabetical-
  // first), persist, log loudly. Re-runs from the same rec are
  // no-ops (the value sticks).
  const tmp = _mkTmp();
  try {
    fs.mkdirSync(path.join(tmp, 'beta'));
    fs.mkdirSync(path.join(tmp, 'beta', '.git'));
    fs.mkdirSync(path.join(tmp, 'alpha'));
    fs.mkdirSync(path.join(tmp, 'alpha', '.git'));
    fs.mkdirSync(path.join(tmp, 'gamma'));
    fs.mkdirSync(path.join(tmp, 'gamma', '.git'));
    const rec = { id: 'rec-mig3', absCwd: tmp };
    const out = migrateMainProjectIfNeeded(rec, () => {});
    assert.strictEqual(out, true, 'bug-66: multi-candidate must now MIGRATE (deterministic pick), not bail.');
    assert.strictEqual(
      rec.mainProject,
      'alpha',
      'bug-66: alphabetical-first ("alpha") must win over beta/gamma so resolution is deterministic across reads.'
    );
    // A second call against the same rec is a no-op (value sticks).
    const again = migrateMainProjectIfNeeded(rec, () => {});
    assert.strictEqual(again, false, 'idempotent: rec.mainProject already set → no-op');
    assert.strictEqual(rec.mainProject, 'alpha');
  } finally { _rmTmp(tmp); }
});

t('migrateMainProjectIfNeeded: session.absCwd itself is a checkout → no-op (findProjectRoot covers this case)', () => {
  const tmp = _mkTmp();
  try {
    fs.mkdirSync(path.join(tmp, '.git'));
    fs.mkdirSync(path.join(tmp, 'inner'));
    fs.mkdirSync(path.join(tmp, 'inner', '.git'));
    const rec = { id: 'rec-mig4', absCwd: tmp };
    assert.strictEqual(migrateMainProjectIfNeeded(rec), false, '"session IS the project" → migration must not claim a sub-project.');
    assert.strictEqual(rec.mainProject, undefined);
  } finally { _rmTmp(tmp); }
});

// ── 4. End-to-end witness: plan.json lives at <absCwd>/<mainProject>/_myco_/plan.json ──

t('artifactFilePath(rec, "plan") resolves to <absCwd>/<mainProject>/_myco_/plan.json (bug-66 canonical anchor)', () => {
  const tmp = _mkTmp();
  try {
    fs.mkdirSync(path.join(tmp, 'my-project'));
    const rec = { id: 'rec-e2e', absCwd: tmp, mainProject: 'my-project' };
    const planPath = artifactFilePath(rec, 'plan');
    assert.strictEqual(
      planPath,
      path.join(tmp, 'my-project', '_myco_', 'plan.json'),
      'bug-66 canonical anchor: plan.json MUST live at <absCwd>/<mainProject>/_myco_/plan.json — no drift, no auto-detect.'
    );
  } finally { _rmTmp(tmp); }
});

t('artifactFilePath(rec, "plan") returns null when mainProject is unset AND absCwd is not a checkout (no drift fallback)', () => {
  const tmp = _mkTmp();
  try {
    fs.mkdirSync(path.join(tmp, 'sibling'));
    fs.mkdirSync(path.join(tmp, 'sibling', '.git'));
    const rec = { id: 'rec-e2e2', absCwd: tmp };
    assert.strictEqual(
      artifactFilePath(rec, 'plan'),
      null,
      'bug-66: with no mainProject anchor, plan path must be null — NOT silently routed to a sibling subdir.'
    );
  } finally { _rmTmp(tmp); }
});

// ── 5. Static-grep guard: spawnSession routes through setMainProject ──

t('server/src/sessions.js: spawnSession does NOT write rec.mainProject / record.mainProject directly (must call artifacts.setMainProject)', () => {
  const src = _read('server/src/sessions.js');
  // The only legitimate direct write was the seed line at the end of
  // spawnSession (record.mainProject = mainProject). bug-66 routes
  // that through artifacts.setMainProject(record, mainProject).
  // Any bare assignment regresses the chokepoint.
  //
  // Allow rec.mainProject / record.mainProject as READS (typeof,
  // truthy checks, etc.) — only `=` assignments are forbidden.
  const lines = src.split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*\/\//.test(ln)) continue; // ignore comments
    // Match `record.mainProject =` or `rec.mainProject =` (but not
    // `==`, `===`, or attribute accesses inside string literals).
    if (/\b(rec|record)\.mainProject\s*=(?!=)/.test(ln)) {
      offenders.push(`  line ${i + 1}: ${ln.trim()}`);
    }
  }
  assert.strictEqual(
    offenders.length, 0,
    'bug-66: sessions.js must NOT write rec/record.mainProject directly — route through artifacts.setMainProject so the single-main invariant holds. Offenders:\n' + offenders.join('\n')
  );
});

t('server/src/sessions.js: spawnSession actually calls artifacts.setMainProject (chokepoint adoption witness)', () => {
  const src = _read('server/src/sessions.js');
  const at = src.search(/async\s+function\s+spawnSession\s*\(/);
  assert.ok(at > -1, 'spawnSession must exist in sessions.js');
  const body = sliceFn(src, at);
  assert.ok(
    /artifacts\s*\.\s*setMainProject\s*\(/.test(body) ||
    /\.\s*setMainProject\s*\(\s*record\s*,/.test(body),
    'spawnSession must call artifacts.setMainProject(record, mainProject) so the seed write goes through the single-main chokepoint (bug-66).'
  );
});

t('server/src/artifacts.js: setMainProject is exported (top-level + __test)', () => {
  const src = _read('server/src/artifacts.js');
  // Find the top-level `module.exports = {`. Everything up to the
  // matching close brace is the export block.
  const exportAt = src.lastIndexOf('module.exports = {');
  assert.ok(exportAt > -1, 'artifacts.js must have a top-level module.exports block.');
  const exportBlock = src.slice(exportAt);
  assert.ok(
    /\bsetMainProject\b/.test(exportBlock),
    'artifacts.js must export setMainProject so external callers (sessions.js, future add-project paths) can route through the chokepoint.'
  );
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
