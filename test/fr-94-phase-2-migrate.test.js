// fr-94 Phase 2: lazy auto-migration of legacy sessions to the
// rec.mainProject field that Phase 1 introduced.
//
// Phase 1 gave NEW sessions an explicit main project (set via the
// spawn modal's "Git clone URL OR new project name" field). EXISTING
// sessions (spawned before Phase 1 landed) had no rec.mainProject —
// they relied on findProjectRoot's auto-detect fallback (scan
// rec.absCwd for the first `.git/`-marked subdir each time
// resolveMycoDir is called). That's correct but pays the scan cost
// every call, and the data model isn't uniform across sessions.
//
// Phase 2 closes that gap with a one-shot lazy migration: on every
// WS attach, if the session record has no mainProject AND there's
// exactly ONE candidate `.git/`-marked subdir under absCwd, set
// rec.mainProject + persist. Multi-candidate workspaces log a
// warning and stay unset (the legacy auto-detect path still picks
// alphabetically-first, same as before — user is told to set
// rec.mainProject explicitly to silence the warning).
//
// Test shape: static-grep guards on the helper definition + the
// attach-time call site + the export + behavior corners (no-op when
// already set; root-is-project no-op; multi-candidate warn).

const assert = require('assert');
const fs = require('fs');
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

console.log('── fr-94 Phase 2: lazy mainProject migration ──');

// ── helper definition ──

t('server/src/artifacts.js: migrateMainProjectIfNeeded(rec, saveStoreFn) helper defined', () => {
  const src = _read('server/src/artifacts.js');
  assert.ok(/function\s+migrateMainProjectIfNeeded\s*\(\s*rec\s*,\s*saveStoreFn\s*\)/.test(src),
    'artifacts.js must define `function migrateMainProjectIfNeeded(rec, saveStoreFn)` — the Phase 2 helper that caches an auto-detected mainProject onto the session record.');
});

t('server/src/artifacts.js: migrateMainProjectIfNeeded is exported as a public symbol', () => {
  const src = _read('server/src/artifacts.js');
  // Pulled out of the top-level module.exports block (NOT just __test).
  const at = src.search(/module\.exports\s*=\s*\{/);
  assert.ok(at > -1, 'module.exports block must exist.');
  const top = src.slice(at, src.indexOf('__test:', at));
  assert.ok(/\bmigrateMainProjectIfNeeded\b/.test(top),
    'migrateMainProjectIfNeeded must be in the top-level module.exports of artifacts.js so attach.js can require it without poking the __test namespace.');
});

t('migrateMainProjectIfNeeded is a no-op when rec.mainProject is already set', () => {
  const src = _read('server/src/artifacts.js');
  const at = src.search(/function\s+migrateMainProjectIfNeeded\s*\(/);
  assert.ok(at > -1, 'helper must exist.');
  const body = sliceFn(src, at);
  // Early return when rec.mainProject is truthy.
  assert.ok(/rec\.mainProject\s*&&\s*String\(rec\.mainProject\)\.trim\(\)/.test(body) ||
            /rec\.mainProject\s*&&[\s\S]{0,80}return\s+false/.test(body),
    'migrateMainProjectIfNeeded must short-circuit when rec.mainProject is already set (Phase 2 is one-shot lazy — never overwrite an explicit setting).');
});

t('migrateMainProjectIfNeeded is a no-op when session.absCwd itself contains .git/ (session IS the project)', () => {
  const src = _read('server/src/artifacts.js');
  const at = src.search(/function\s+migrateMainProjectIfNeeded\s*\(/);
  const body = sliceFn(src, at);
  // The helper must check fs.statSync(path.join(rec.absCwd, '.git'))
  // BEFORE falling into the subdir scan. When session-root IS the
  // repo, mainProject stays unset (findProjectRoot already returns
  // absCwd for this case).
  assert.ok(/fs\.statSync\s*\(\s*path\.join\s*\(\s*rec\.absCwd\s*,\s*['"]\.git['"]\s*\)/.test(body),
    'migrateMainProjectIfNeeded must check whether rec.absCwd itself is a `.git/`-marked repo BEFORE scanning subdirs — when session-root is the project, no migration is owed.');
});

t('migrateMainProjectIfNeeded scans subdirs for .git/ + filters with NESTED_SCAN_SKIP', () => {
  const src = _read('server/src/artifacts.js');
  const at = src.search(/function\s+migrateMainProjectIfNeeded\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/fs\.readdirSync\s*\(\s*rec\.absCwd/.test(body),
    'migrateMainProjectIfNeeded must scan subdirs of rec.absCwd via fs.readdirSync.');
  assert.ok(/NESTED_SCAN_SKIP/.test(body),
    'migrateMainProjectIfNeeded must apply the same NESTED_SCAN_SKIP filter as findProjectRoot (node_modules, dist, build, etc.) so it doesn\'t latch onto build artifacts.');
});

t('migrateMainProjectIfNeeded deterministically picks alphabetical-first when multiple candidates exist (bug-66 supersedes Phase 2 r0 "leave unset")', () => {
  // Pre-bug-66: multi-candidate bailed with a warn + left mainProject
  // unset, and the now-retired findProjectRoot auto-detect fallback
  // re-picked alphabetical-first on every read — so resolution was
  // non-deterministic if siblings appeared/disappeared. bug-66 makes
  // multi-candidate the deterministic case at MIGRATION time: pick
  // alphabetical-first, persist via setMainProject, and warn loudly so
  // the user knows which project was claimed. The runtime semantic
  // tests (in test/bug-66-single-main-project-anchor.test.js) lock the
  // PICK behavior; this case is the static-grep guard that the source
  // still distinguishes the multi-candidate branch + still warns.
  const src = _read('server/src/artifacts.js');
  const at = src.search(/function\s+migrateMainProjectIfNeeded\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/candidates\.length\s*>\s*1/.test(body),
    'migrateMainProjectIfNeeded must branch on `candidates.length > 1` (multi-candidate case).');
  // Warn prefix carries both Phase-2 and bug-66 markers so future
  // refactors can re-find this code path from either history entry.
  assert.ok(/console\.warn\s*\(\s*[`'"]\[fr-94 Phase 2 \/ bug-66\][\s\S]*?multiple/.test(body),
    'multi-candidate path must console.warn under the `[fr-94 Phase 2 / bug-66]` prefix so the user sees which project was deterministically claimed (bug-66 supersedes the pre-r0 "leave unset" behavior).');
  // Both branches must persist via setMainProject — the bug-66
  // chokepoint. The static guard test_no_direct_main_project_write in
  // test.sh also locks this from the other direction.
  assert.ok(/setMainProject\s*\(\s*rec\s*,/.test(body),
    'migrateMainProjectIfNeeded must persist via setMainProject(rec, …) — the bug-66 single-main chokepoint (no direct rec.mainProject = … writes).');
});

t('migrateMainProjectIfNeeded persists via the saveStoreFn callback on success', () => {
  const src = _read('server/src/artifacts.js');
  const at = src.search(/function\s+migrateMainProjectIfNeeded\s*\(/);
  const body = sliceFn(src, at);
  // saveStoreFn is invoked on the success path so the rec.mainProject
  // mutation actually lands in /data/sessions.json.
  assert.ok(/saveStoreFn\s*\(\s*\)/.test(body) || /typeof\s+saveStoreFn\s*===\s*['"]function['"][\s\S]{0,200}saveStoreFn/.test(body),
    'migrateMainProjectIfNeeded must invoke saveStoreFn() on the success path so the rec.mainProject mutation persists.');
});

// ── attach.js wires the call into _attachAgentWebSocket ──

t('server/src/attach.js: _attachAgentWebSocket calls migrateMainProjectIfNeeded', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/function\s+_attachAgentWebSocket\s*\(/);
  assert.ok(at > -1, '_attachAgentWebSocket must exist.');
  const body = sliceFn(src, at);
  assert.ok(/migrateMainProjectIfNeeded\s*\(/.test(body),
    '_attachAgentWebSocket must call migrateMainProjectIfNeeded(rec, …) so every WS attach gives a legacy session a chance to settle its mainProject (Phase 2 lazy migration).');
  // The saveStore callback must be a function passed in — verifies
  // the persistence wiring is real.
  assert.ok(/saveStore/.test(body),
    'the migrate call site must pass saveStore (so a successful migration lands in sessions.json).');
});

// ── fr-94 marker still present somewhere ──

t('a comment naming "fr-94 Phase 2" explains the lazy-migration intent', () => {
  const arts = _read('server/src/artifacts.js');
  const att = _read('server/src/attach.js');
  assert.ok(/fr-94 Phase 2/.test(arts) || /fr-94 Phase 2/.test(att),
    'a comment naming "fr-94 Phase 2" must appear in artifacts.js or attach.js so a future restyle understands why migrateMainProjectIfNeeded exists.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
