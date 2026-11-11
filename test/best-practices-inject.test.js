// Regression: spawnSession / ensureLiveSession inject the myco
// best-practices template into the target project's CLAUDE.md so
// every session managed by myco picks up the same conventions.
// The injection is idempotent via a sentinel pair, preserves any
// pre-existing CLAUDE.md content, and survives hand-edits.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bp-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

const { injectBestPracticesIntoClaudeMd } = require('../server/src/sessions');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function makeProject(name) {
  const cwd = path.join(tmpRoot, 'proj-' + name);
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

const TEMPLATE_BODY = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'best-practices-template.md'),
  'utf8'
).trim();

console.log('── best-practices CLAUDE.md injection ──');

t('writes a fresh CLAUDE.md when none exists', () => {
  const cwd = makeProject('a');
  injectBestPracticesIntoClaudeMd(cwd);
  const claudeMd = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
  assert.ok(claudeMd.includes('<!-- myco-best-practices-start -->'), 'start sentinel missing');
  assert.ok(claudeMd.includes('<!-- myco-best-practices-end -->'), 'end sentinel missing');
  assert.ok(claudeMd.includes(TEMPLATE_BODY), 'template body missing');
});

t('appends sentinel block when CLAUDE.md exists', () => {
  const cwd = makeProject('b');
  const existing = '# My Project\n\nSome project-specific instructions.\n';
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), existing);
  injectBestPracticesIntoClaudeMd(cwd);
  const after = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
  assert.ok(after.startsWith('# My Project'), 'pre-existing header was clobbered');
  assert.ok(after.includes('Some project-specific instructions.'), 'pre-existing body lost');
  assert.ok(after.includes('<!-- myco-best-practices-start -->'), 'sentinel block not appended');
  // Block goes AFTER existing content
  const headerIdx = after.indexOf('# My Project');
  const startIdx = after.indexOf('<!-- myco-best-practices-start -->');
  assert.ok(headerIdx < startIdx, 'block must be appended, not prepended');
});

t('idempotent: second call leaves the file unchanged', () => {
  const cwd = makeProject('c');
  injectBestPracticesIntoClaudeMd(cwd);
  const first = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
  injectBestPracticesIntoClaudeMd(cwd);
  const second = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
  assert.strictEqual(first, second, 'second injection mutated the file — should be a no-op');
});

t('hand-edited block is preserved (we never rewrite an existing sentinel)', () => {
  const cwd = makeProject('d');
  injectBestPracticesIntoClaudeMd(cwd);
  // Simulate a user hand-editing the injected block.
  const original = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
  const customised = original.replace(
    /<!-- myco-best-practices-start -->[\s\S]*?<!-- myco-best-practices-end -->/,
    '<!-- myco-best-practices-start -->\nCUSTOMISED BY USER\n<!-- myco-best-practices-end -->'
  );
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), customised);
  injectBestPracticesIntoClaudeMd(cwd);
  const after = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
  assert.ok(after.includes('CUSTOMISED BY USER'), 'user customisation was clobbered');
});

t('no-op when absCwd is empty / falsy', () => {
  // Just must not throw.
  injectBestPracticesIntoClaudeMd('');
  injectBestPracticesIntoClaudeMd(null);
  injectBestPracticesIntoClaudeMd(undefined);
});

t('appended block survives re-injection across a CLAUDE.md edit elsewhere', () => {
  // User adds new project-specific content AFTER the sentinel block;
  // re-injection should still no-op (sentinel present → idempotent).
  const cwd = makeProject('e');
  injectBestPracticesIntoClaudeMd(cwd);
  const original = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
  const edited = original + '\n\n## Extra section added by user\n\nMore content.\n';
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), edited);
  injectBestPracticesIntoClaudeMd(cwd);
  const after = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
  assert.ok(after.includes('## Extra section added by user'), 'user-added section after the block was lost');
  assert.ok(after.includes('More content.'), 'extra content was clobbered');
  // Sentinel block must still appear exactly once.
  const matches = after.match(/<!-- myco-best-practices-start -->/g) || [];
  assert.strictEqual(matches.length, 1, 'duplicate sentinel blocks — idempotency broken');
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
