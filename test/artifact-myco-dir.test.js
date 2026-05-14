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

function makeRec(name) {
  const cwd = path.join(tmpRoot, 'proj-' + name);
  fs.mkdirSync(cwd, { recursive: true });
  return { id: 'rec-' + name, absCwd: cwd };
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

t('resolveMycoDir finds _myco_ at session cwd directly', () => {
  const rec = makeRec('k');
  fs.mkdirSync(path.join(rec.absCwd, '_myco_'), { recursive: true });
  fs.writeFileSync(path.join(rec.absCwd, '_myco_', 'plan.json'), '{"items":[],"updatedAt":null}\n');
  assert.strictEqual(__test.resolveMycoDir(rec), path.join(rec.absCwd, '_myco_'));
});

t('resolveMycoDir finds nested project _myco_ one level deeper', () => {
  // Layout: /tmp/.../proj-l/myrepo/_myco_/  — the session points at
  // the parent of the actual git checkout, mirroring the user's
  // /wks/kkrazy/myco2/myco/ pattern.
  const rec = makeRec('l');
  const repo = path.join(rec.absCwd, 'myrepo');
  fs.mkdirSync(path.join(repo, '_myco_'), { recursive: true });
  fs.writeFileSync(path.join(repo, '_myco_', 'plan.json'), '{"items":[{"id":"a","text":"x"}],"updatedAt":null}\n');
  const resolved = __test.resolveMycoDir(rec);
  assert.strictEqual(resolved, path.join(repo, '_myco_'));
  // readArtifactFromFile should follow through.
  const r = __test.readArtifactFromFile(rec, 'plan');
  assert.ok(r);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].id, 'a');
});

t('resolveMycoDir skips node_modules / .git / build during nested scan', () => {
  const rec = makeRec('m');
  // Plant decoys in heavy / hidden dirs that should be skipped.
  for (const name of ['node_modules', '.git', 'dist', 'build']) {
    fs.mkdirSync(path.join(rec.absCwd, name, '_myco_'), { recursive: true });
    fs.writeFileSync(path.join(rec.absCwd, name, '_myco_', 'plan.json'), '{"items":[{"id":"DECOY"}],"updatedAt":null}\n');
  }
  // No real project _myco_/ exists, and no direct _myco_/ at root —
  // resolver must NOT latch onto a decoy; falls back to the default
  // write target (session-root _myco_/).
  const resolved = __test.resolveMycoDir(rec);
  assert.strictEqual(resolved, path.join(rec.absCwd, '_myco_'));
});

t('resolveMycoDir prefers direct hit over nested hit', () => {
  // If BOTH layouts exist, the session-root _myco_/ wins — it's the
  // explicit signal that the user intended this session's cwd to be
  // the project root.
  const rec = makeRec('n');
  fs.mkdirSync(path.join(rec.absCwd, '_myco_'), { recursive: true });
  fs.writeFileSync(path.join(rec.absCwd, '_myco_', 'plan.json'), '{"items":[{"id":"DIRECT"}],"updatedAt":null}\n');
  fs.mkdirSync(path.join(rec.absCwd, 'subproj', '_myco_'), { recursive: true });
  fs.writeFileSync(path.join(rec.absCwd, 'subproj', '_myco_', 'plan.json'), '{"items":[{"id":"NESTED"}],"updatedAt":null}\n');
  const r = __test.readArtifactFromFile(rec, 'plan');
  assert.ok(r);
  assert.strictEqual(r.items[0].id, 'DIRECT', 'direct hit must win when both layouts exist');
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
