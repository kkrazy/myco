// Regression: plan/test/architecture artifacts must mirror to
// <session-cwd>/_myco_/ so the project state migrates with the repo
// (commit the dir, push it, the next developer's myco session reads
// the same items + comments + arch notes).
//
// Format on disk:
//   _myco_/plan.json          { items: [{id,text,comments,voters,…}], updatedAt }
//   _myco_/test.json          { items: [{id,text,comments,…}], updatedAt }
//   _myco_/architecture.md    long-form markdown
//   _myco_/README.md          explainer (written once, never overwritten)
//
// Backward compat: a pre-_myco_ `<cwd>/architecture.md` at the project
// root is still readable as a fallback.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-art-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

const { __test } = require('../server/src/artifacts');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// Build a session rec whose absCwd is a project (has .git/ directly).
// This is the common case — session points at a real checkout.
function makeRec(name) {
  const cwd = path.join(tmpRoot, 'proj-' + name);
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  return { id: 'rec-' + name, absCwd: cwd };
}

// Build a session rec whose absCwd is a WORKSPACE (no .git/ directly),
// with the project nested one level deeper. Returns { rec, repo } so
// the test can plant files inside the repo directly.
//
// bug-66: rec.mainProject is set to projectName — pre-bug-66 the
// nested-project case relied on findProjectRoot's sibling-subdir
// auto-detect fallback, but that fallback is retired (it produced
// non-deterministic resolution on multi-repo workspaces). Production
// code now sets mainProject explicitly via spawnSession (new sessions)
// or migrateMainProjectIfNeeded (legacy sessions, on first attach).
// This helper mirrors that — the rec it returns is shaped the way
// production sees the same workspace shape.
function makeWorkspaceRec(name, projectName = 'myrepo') {
  const cwd = path.join(tmpRoot, 'wks-' + name);
  const repo = path.join(cwd, projectName);
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  return { rec: { id: 'rec-' + name, absCwd: cwd, mainProject: projectName }, repo };
}

console.log('── _myco_/ mirror ──');

t('mycoDirPath resolves to <cwd>/_myco_', () => {
  const rec = makeRec('a');
  assert.strictEqual(__test.mycoDirPath(rec), path.join(rec.absCwd, '_myco_'));
});

t('artifactFilePath maps types to plan.json / test.json / architecture.md', () => {
  const rec = makeRec('b');
  const base = path.join(rec.absCwd, '_myco_');
  assert.strictEqual(__test.artifactFilePath(rec, 'plan'), path.join(base, 'plan.json'));
  assert.strictEqual(__test.artifactFilePath(rec, 'test'), path.join(base, 'test.json'));
  assert.strictEqual(__test.artifactFilePath(rec, 'arch'), path.join(base, 'architecture.md'));
  assert.strictEqual(__test.artifactFilePath(rec, 'bogus'), null);
});

t('writeArtifactToFile creates _myco_/ and serializes plan as JSON', () => {
  const rec = makeRec('c');
  const artifact = {
    items: [
      { id: 'i1', text: 'Wire /v2/orders', comments: [{ user: 'alice', text: 'limit clamp' }], voters: ['alice'] },
    ],
    updatedAt: '2026-05-14T04:00:00.000Z',
  };
  const ok = __test.writeArtifactToFile(rec, 'plan', artifact);
  assert.strictEqual(ok, true);
  const written = fs.readFileSync(path.join(rec.absCwd, '_myco_', 'plan.json'), 'utf8');
  assert.ok(written.includes('"id": "i1"'), 'plan.json should be pretty-printed JSON');
  assert.ok(written.endsWith('\n'), 'plan.json should end with a newline (git-friendly)');
});

t('writeArtifactToFile serializes arch as plain markdown', () => {
  const rec = makeRec('d');
  const artifact = { markdown: '# Arch\n\nSome notes.\n', updatedAt: '2026-05-14T04:00:00.000Z' };
  __test.writeArtifactToFile(rec, 'arch', artifact);
  const written = fs.readFileSync(path.join(rec.absCwd, '_myco_', 'architecture.md'), 'utf8');
  assert.strictEqual(written, '# Arch\n\nSome notes.\n');
});

t('readArtifactFromFile round-trips plan.json', () => {
  const rec = makeRec('e');
  const original = {
    items: [{ id: 'p1', text: 'Step one', comments: [], voters: [] }],
    updatedAt: '2026-05-14T04:00:00.000Z',
  };
  __test.writeArtifactToFile(rec, 'plan', original);
  const back = __test.readArtifactFromFile(rec, 'plan');
  assert.ok(back);
  assert.strictEqual(back.items.length, 1);
  assert.strictEqual(back.items[0].text, 'Step one');
});

t('readArtifactFromFile returns null when file missing', () => {
  const rec = makeRec('f');
  assert.strictEqual(__test.readArtifactFromFile(rec, 'plan'), null);
});

t('readArtifactFromFile returns null on malformed JSON', () => {
  const rec = makeRec('g');
  fs.mkdirSync(path.join(rec.absCwd, '_myco_'), { recursive: true });
  fs.writeFileSync(path.join(rec.absCwd, '_myco_', 'plan.json'), '{not json');
  assert.strictEqual(__test.readArtifactFromFile(rec, 'plan'), null);
});

t('readLegacyArchFromFile reads pre-_myco_ root-level architecture.md', () => {
  const rec = makeRec('h');
  fs.writeFileSync(path.join(rec.absCwd, 'architecture.md'), '# Legacy arch\n');
  const result = __test.readLegacyArchFromFile(rec);
  assert.ok(result);
  assert.strictEqual(result.markdown, '# Legacy arch\n');
});

t('writeMycoReadmeIfMissing writes once and never overwrites', () => {
  const rec = makeRec('i');
  __test.writeArtifactToFile(rec, 'plan', { items: [], updatedAt: null });
  __test.writeMycoReadmeIfMissing(rec);
  const readmePath = path.join(rec.absCwd, '_myco_', 'README.md');
  const firstWrite = fs.readFileSync(readmePath, 'utf8');
  assert.ok(firstWrite.includes('plan.json'), 'README should explain plan.json');
  // Simulate user customising the README.
  fs.writeFileSync(readmePath, 'CUSTOM README\n');
  __test.writeMycoReadmeIfMissing(rec);
  const second = fs.readFileSync(readmePath, 'utf8');
  assert.strictEqual(second, 'CUSTOM README\n', 'must NOT overwrite user-customised README');
});

t('readArtifactFromFile returns null when _myco_/ dir does not exist', () => {
  // Sanity: the dir-absent case is the precondition for the backfill path
  // exercised by the GET handler. With the dir gone, the read returns null
  // and the handler is expected to write `stored` to disk eagerly.
  const rec = makeRec('j');
  assert.strictEqual(__test.readArtifactFromFile(rec, 'plan'), null);
  // After a write, the dir exists.
  __test.writeArtifactToFile(rec, 'plan', { items: [{ id: 'x', text: 't' }], updatedAt: '2026-05-14T00:00:00Z' });
  assert.ok(fs.existsSync(path.join(rec.absCwd, '_myco_', 'plan.json')));
});

t('findProjectRoot returns session.absCwd when it has .git directly', () => {
  const rec = makeRec('k');  // makeRec creates .git/ at absCwd
  assert.strictEqual(__test.findProjectRoot(rec), rec.absCwd);
  assert.strictEqual(__test.resolveMycoDir(rec), path.join(rec.absCwd, '_myco_'));
});

t('findProjectRoot finds nested project (<wks>/<user>/<session>/<project>)', () => {
  // Layout matches the user's spec literally:
  //   /tmp/.../wks-l/myrepo/.git/
  //   /tmp/.../wks-l/myrepo/_myco_/plan.json
  // Session points at the workspace level (wks-l); the project is the
  // inner myrepo/ (only that subdir has .git/).
  const { rec, repo } = makeWorkspaceRec('l');
  fs.mkdirSync(path.join(repo, '_myco_'), { recursive: true });
  fs.writeFileSync(path.join(repo, '_myco_', 'plan.json'), '{"items":[{"id":"a","text":"x"}],"updatedAt":null}\n');
  assert.strictEqual(__test.findProjectRoot(rec), repo);
  assert.strictEqual(__test.resolveMycoDir(rec), path.join(repo, '_myco_'));
  const r = __test.readArtifactFromFile(rec, 'plan');
  assert.ok(r);
  assert.strictEqual(r.items[0].id, 'a');
});

t('findProjectRoot returns null when no .git/ exists at cwd or any child', () => {
  // Workspace dir with no checkout anywhere. The strict spec says
  // there's no project here; the loader must skip _myco_/ entirely.
  const cwd = path.join(tmpRoot, 'empty-workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const rec = { id: 'rec-empty', absCwd: cwd };
  assert.strictEqual(__test.findProjectRoot(rec), null);
  assert.strictEqual(__test.resolveMycoDir(rec), null);
  // Downstream writes/reads are no-ops on null.
  assert.strictEqual(__test.writeArtifactToFile(rec, 'plan', { items: [] }), false);
  assert.strictEqual(__test.readArtifactFromFile(rec, 'plan'), null);
});

t('findProjectRoot skips heavy / hidden dirs while searching', () => {
  // Plant .git/ inside heavy dirs that should NOT count as a project.
  const cwd = path.join(tmpRoot, 'heavy-decoy');
  fs.mkdirSync(cwd, { recursive: true });
  for (const name of ['node_modules', 'dist', 'build', '.cache']) {
    fs.mkdirSync(path.join(cwd, name, '.git'), { recursive: true });
  }
  const rec = { id: 'rec-decoy', absCwd: cwd };
  assert.strictEqual(__test.findProjectRoot(rec), null,
    'must skip node_modules/.cache/etc. — those aren\'t real projects');
});

t('findProjectRoot returns NULL for multi-repo workspaces with no mainProject (bug-66 retires sibling-subdir auto-detect)', () => {
  // bug-66: pre-bug-66 this case asserted findProjectRoot returned
  // the alphabetical-first sibling. That auto-detect fallback is
  // retired — it produced non-deterministic resolution if siblings
  // appeared/disappeared between reads. The "deterministic
  // alphabetical-first" pick is now MIGRATION-time behavior
  // (migrateMainProjectIfNeeded persists it on first attach), not
  // RESOLUTION-time behavior. With no mainProject anchor, the
  // multi-repo workspace returns null until migration runs.
  const cwd = path.join(tmpRoot, 'multi-repo');
  fs.mkdirSync(path.join(cwd, 'aaa', '.git'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'bbb', '.git'), { recursive: true });
  const rec = { id: 'rec-multi', absCwd: cwd };
  assert.strictEqual(
    __test.findProjectRoot(rec), null,
    'bug-66: multi-repo workspace with no mainProject MUST return null — the retired auto-detect fallback used to return the alphabetical-first sibling, which caused drift across reads.'
  );
  // After Phase 2 migration (deterministic alphabetical-first pick),
  // findProjectRoot resolves via the explicit anchor.
  __test.migrateMainProjectIfNeeded(rec, () => {});
  assert.strictEqual(rec.mainProject, 'aaa', 'migration must claim alphabetical-first');
  assert.strictEqual(__test.findProjectRoot(rec), path.join(cwd, 'aaa'), 'post-migration: findProjectRoot resolves via rec.mainProject');
});

t('rec without absCwd is a no-op (no crash)', () => {
  const rec = { id: 'no-cwd' };
  assert.strictEqual(__test.mycoDirPath(rec), null);
  assert.strictEqual(__test.artifactFilePath(rec, 'plan'), null);
  assert.strictEqual(__test.writeArtifactToFile(rec, 'plan', { items: [] }), false);
  assert.strictEqual(__test.readArtifactFromFile(rec, 'plan'), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
