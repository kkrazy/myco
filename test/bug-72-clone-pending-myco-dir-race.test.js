// bug-72 regression: during the clone-pending window of an async
// git-clone spawn, `_myco_/` writes must NOT land inside the pre-
// created (empty) project subdir — otherwise `git clone <url> <dir>`
// fails with "destination not empty".
//
// User report (mycobeta, 2026-06-06):
//   ⏳ git clone https://github.com/kkrazy/myco.git → myco/ …
//   ⏳ fatal: destination path '/wks/kkrazy/myco-kkrazy-6dd7618d/myco'
//      already exists and is not an empty directory.
//   ✗ git clone failed (exit 128) after 0.0s.
//
// Root cause: `_kickoffGitCloneAsync` (server/src/sessions.js) pre-
// creates the empty project subdir and DEFERS the actual `git clone`
// via setImmediate so spawnSession can return immediately. In the gap,
// `spawnAgent` constructs the AgentSession, which calls
// `resolveMycoDir(rec)` → `findProjectRoot(rec)`. Pre-fix,
// findProjectRoot saw rec.mainProject='myco' AND the (empty) subdir
// existing → returned `<absCwd>/myco/`. The agent's _eventsFile then
// pointed at `<absCwd>/myco/_myco_/events.jsonl`. The first
// _persistEventToDisk call did `mkdirSync(<absCwd>/myco/_myco_)` → the
// supposedly-empty project dir was now non-empty. setImmediate fires,
// git refuses, exit 128.
//
// Fix: `findProjectRoot` returns null when `rec.cloneState === 'pending'`
// — even if `rec.mainProject` is set AND the subdir exists. Callers
// fall back: AgentSession's `_eventsFile` resolves to
// `<this.cwd>/_myco_/events.jsonl`, and `this.cwd` is
// `resolveAgentCwd(rec)` which is the wrapper `rec.absCwd` during
// clone-pending (the f3528b8 fix). So wrapper-level `_myco_/` collects
// the pre-clone events, and `_runGitCloneInBackground`'s post-success
// rename (`path.dirname(projectAbs)/_myco_` → `projectAbs/_myco_`) —
// which until this fix was dead code — finally moves the dir into the
// freshly-cloned project subdir as f6a7ab8 originally intended.
//
// Test shape: static guard on the early-return + runtime asserts on
// findProjectRoot / resolveMycoDir for the four state combinations
// (pending+subdir, pending+no-subdir, success+subdir, no-cloneState+
// subdir). Sub-second, framework-standard, runnable as
// `node test/bug-72-clone-pending-myco-dir-race.test.js`.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-72: clone-pending must NOT populate the project subdir with _myco_/ ──');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guards. Cheap, lock the fix's shape so a future
// refactor can't silently remove it.
// ─────────────────────────────────────────────────────────────────

const ARTIFACTS_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');

t('findProjectRoot returns null early when rec.cloneState === \'pending\'', () => {
  // Extract the findProjectRoot function body via the same convention
  // bug-66's helper uses — top-level `function foo(…) { … }` with the
  // closing brace on its own line at column 0.
  const m = ARTIFACTS_JS.match(/function\s+findProjectRoot\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'findProjectRoot must be a top-level function declaration');
  const body = m[1];
  // The clone-pending early return must appear BEFORE the
  // rec.mainProject branch — otherwise the mainProject return wins
  // and the bug remains. We grep by source-position: the cloneState
  // check must come before the first `rec.mainProject` token.
  const cloneIdx = body.search(/rec\.cloneState\s*===?\s*['"]pending['"]/);
  const mainProjIdx = body.search(/rec\.mainProject/);
  assert.ok(cloneIdx > -1,
    'findProjectRoot must check rec.cloneState === \'pending\' (bug-72 — race during async clone)');
  assert.ok(mainProjIdx > -1,
    'findProjectRoot must still reference rec.mainProject (fr-94 Phase 1 contract)');
  assert.ok(cloneIdx < mainProjIdx,
    'the cloneState check must come BEFORE the mainProject branch — otherwise mainProject returns the empty subdir and the bug-72 race fires');
  // And the cloneState check must `return null` — not fall through.
  // Grab the snippet between the cloneState check and the next
  // statement boundary; assert it contains `return null`.
  const after = body.slice(cloneIdx, cloneIdx + 200);
  assert.ok(/return\s+null/.test(after),
    'the cloneState check must `return null` so callers fall back to the wrapper-level _myco_/');
});

// ─────────────────────────────────────────────────────────────────
// PART B — Runtime asserts. No SDK spawn — just call findProjectRoot
// / resolveMycoDir with synthesized recs and assert the result.
// ─────────────────────────────────────────────────────────────────

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug72-'));
process.on('exit', () => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

const artifacts = require('../server/src/artifacts');

// Synthesize an rec at `<TMP_ROOT>/<id>/` with optional mainProject
// (subdir created empty) + optional cloneState.
function fakeRec({ id = 'myco-tester-cafef00d', mainProject = null, cloneState = null, createSubdir = true } = {}) {
  const absCwd = path.join(TMP_ROOT, id);
  fs.mkdirSync(absCwd, { recursive: true });
  if (mainProject && createSubdir) {
    fs.mkdirSync(path.join(absCwd, mainProject), { recursive: true });
  }
  const rec = { id, user: 'tester', absCwd };
  if (mainProject) rec.mainProject = mainProject;
  if (cloneState) rec.cloneState = cloneState;
  return rec;
}

t('findProjectRoot returns null when cloneState=\'pending\' even with mainProject set and the empty subdir existing (the actual bug)', () => {
  const rec = fakeRec({ id: 'myco-tester-aabbccdd', mainProject: 'myco', cloneState: 'pending' });
  // Sanity: the subdir IS there (so the pre-fix code path that
  // returned it would otherwise win).
  assert.strictEqual(fs.statSync(path.join(rec.absCwd, 'myco')).isDirectory(), true,
    'sanity: pre-created project subdir exists');
  assert.strictEqual(artifacts.findProjectRoot(rec), null,
    'findProjectRoot must return null during clone-pending so callers fall back to the wrapper — otherwise _myco_/ lands inside the supposedly-empty project subdir and git clone fails with exit 128');
});

t('resolveMycoDir is null when cloneState=\'pending\' (downstream of findProjectRoot)', () => {
  const rec = fakeRec({ id: 'myco-tester-11223344', mainProject: 'myco', cloneState: 'pending' });
  assert.strictEqual(artifacts.resolveMycoDir(rec), null,
    'resolveMycoDir is the path the AgentSession uses for events.jsonl — it MUST be null during clone-pending so AgentSession\'s fallback (`<this.cwd>/_myco_`) routes events to the wrapper');
});

t('findProjectRoot returns the project subdir AFTER clone success (sanity — no regression)', () => {
  // Same shape, cloneState='success' — should return the project
  // subdir. This is what happens immediately after
  // _runGitCloneInBackground sets rec.cloneState='success' +
  // calls AgentSession.updateCwd(projectAbs).
  const rec = fakeRec({ id: 'myco-tester-55667788', mainProject: 'myco', cloneState: 'success' });
  // The subdir + a .git inside (simulating the successful clone).
  fs.mkdirSync(path.join(rec.absCwd, 'myco', '.git'), { recursive: true });
  const root = artifacts.findProjectRoot(rec);
  assert.strictEqual(root, path.join(rec.absCwd, 'myco'),
    'post-clone-success: findProjectRoot must resume returning the project subdir so _myco_/ lands at the right place from the next iteration onward');
});

t('findProjectRoot honors mainProject when cloneState is not set (legacy / non-clone spawn — sanity)', () => {
  // _spawnViaNewDir() (mainProjectName branch) does NOT set
  // cloneState. The mainProject contract must still work.
  const rec = fakeRec({ id: 'myco-tester-99aabbcc', mainProject: 'myproj' });
  // .git is required for the legacy auto-detect; mainProject
  // override doesn't need it — just an existing dir.
  const root = artifacts.findProjectRoot(rec);
  assert.strictEqual(root, path.join(rec.absCwd, 'myproj'),
    'no cloneState + mainProject set + subdir exists → mainProject branch wins (legacy / new-dir spawn unchanged)');
});

t('findProjectRoot stays sane when label, mainProject, and the id all happen to be "myco" (user-asked scenario)', () => {
  // The user reported repro at /wks/kkrazy/myco-kkrazy-6dd7618d/myco
  // — three layers (id starts with "myco-", mainProject="myco", and
  // label="myco" was set on the spawn modal). The fix must not be
  // sensitive to any of those name overlaps; it gates only on
  // rec.cloneState. Pin that.
  const id = 'myco-kkrazy-6dd7618d';
  const absCwd = path.join(TMP_ROOT, id);
  fs.mkdirSync(path.join(absCwd, 'myco'), { recursive: true });
  // Pending phase — must be null regardless of the name overlap.
  assert.strictEqual(
    artifacts.findProjectRoot({ id, user: 'kkrazy', absCwd, label: 'myco', mainProject: 'myco', cloneState: 'pending' }),
    null,
    'pending phase: must return null even when label === mainProject === id-prefix === "myco"');
  // Post-clone-success: the project subdir is the answer, regardless
  // of the lexical overlap with the wrapper basename and the label.
  assert.strictEqual(
    artifacts.findProjectRoot({ id, user: 'kkrazy', absCwd, label: 'myco', mainProject: 'myco', cloneState: 'success' }),
    path.join(absCwd, 'myco'),
    'success phase: must return the project subdir — path.dirname / basename logic must not confuse the wrapper basename `myco-kkrazy-<hash>` with the project subdir `myco`');
});

t('findProjectRoot returns null when cloneState=\'pending\' even WITHOUT mainProject set (defensive)', () => {
  // Edge case: a clone-pending rec where mainProject hasn't been
  // populated yet (shouldn't happen via spawnSession, but defensive
  // against future callers). The pending guard must short-circuit
  // before the legacy auto-detect scan.
  const rec = fakeRec({ id: 'myco-tester-deadbeef', cloneState: 'pending', mainProject: null, createSubdir: false });
  assert.strictEqual(artifacts.findProjectRoot(rec), null,
    'cloneState=\'pending\' must short-circuit before any scan — defensive against a future caller that sets cloneState without mainProject');
});

// ─────────────────────────────────────────────────────────────────
// PART C — End-to-end intent check on the AgentSession constructor
// path: events.jsonl path must NOT be inside the project subdir
// during clone-pending. We don't spawn the SDK (too heavy for a
// node-test budget) — we just lock the static shape of the
// AgentSession's events-file resolution to the helper we just
// fixed, so a future refactor that bypasses resolveMycoDir doesn't
// silently reintroduce the race.
// ─────────────────────────────────────────────────────────────────

const AGENT_SESSION_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');

t('AgentSession resolves _eventsFile via resolveMycoDir with a wrapper fallback', () => {
  // The two call sites — constructor + updateCwd — both compute
  // _mycoDir via resolveMycoDir(rec) and fall back to
  // path.join(this.cwd, '_myco_'). If a future refactor inlines a
  // direct `path.join(this.cwd, mainProject, '_myco_')`, bug-72
  // would silently regress. Grep both sites.
  const resolveCalls = (AGENT_SESSION_JS.match(/resolveMycoDir\s*\(\s*rec\s*\)/g) || []).length;
  assert.ok(resolveCalls >= 2,
    `AgentSession must call resolveMycoDir(rec) at BOTH the constructor and the updateCwd path — found ${resolveCalls}, expected ≥2`);
  const fallbacks = (AGENT_SESSION_JS.match(/_mycoDir\s*\|\|\s*path\.join\(\s*this\.cwd\s*,\s*['"]_myco_['"]\s*\)/g) || []).length;
  assert.ok(fallbacks >= 2,
    `AgentSession must fall back to path.join(this.cwd, '_myco_') when resolveMycoDir returns null — found ${fallbacks}, expected ≥2 (constructor + updateCwd)`);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
