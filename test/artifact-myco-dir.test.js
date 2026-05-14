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
