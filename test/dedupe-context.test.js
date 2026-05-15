// Regression: dedupePlanItems' prompt enrichment must inline
// $cwd/CLAUDE.md and the auto-memory dir for the session, so the LLM
// can apply project-specific synonyms/conventions when judging "is
// this the same item as that?". This test exercises the pure context
// loader — no LLM round-trip — by seeding a fake cwd + memory dir and
// asserting _loadProjectContext returns a string with the expected
// section headers and entries.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-dedupe-ctx-'));
process.env.MYCO_STATE_DIR = path.join(tmp, 'state');
process.env.MYCO_WORKSPACE = path.join(tmp, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

// Project root: tmp/proj. Memory dir: tmp/home/.claude/projects/<enc>/memory.
// _loadProjectContext uses os.homedir() so we redirect HOME to a tmp dir.
const fakeHome = path.join(tmp, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;
// node's os.homedir() reads HOME on linux; macOS has different priority
// but tests typically run on linux/alpine. Re-require os AFTER setenv
// not needed — homedir() is computed fresh on each call.

const proj = path.join(tmp, 'proj');
fs.mkdirSync(proj, { recursive: true });

const slashcmds = require('../server/src/slashcmds');
const { _loadProjectContext } = slashcmds;

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── dedupePlanItems context loader ──');

t('returns empty string when nothing exists', () => {
  const ctx = _loadProjectContext(proj);
  assert.strictEqual(ctx, '', 'expected empty when CLAUDE.md + memory dir both absent');
});

t('inlines CLAUDE.md when present', () => {
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# My project\n\nUse "merge" and "dedupe" interchangeably.\n');
  const ctx = _loadProjectContext(proj);
  assert.match(ctx, /Project CLAUDE\.md/, 'expected CLAUDE.md section header');
  assert.match(ctx, /Use "merge" and "dedupe" interchangeably/, 'expected CLAUDE.md body');
});

t('inlines the auto-memory MEMORY.md index + linked entries', () => {
  // Encoded cwd: replace / with -, so /tmp/.../proj → -tmp-...-proj.
  const enc = proj.replace(/\//g, '-');
  const memDir = path.join(fakeHome, '.claude', 'projects', enc, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'),
    '- [Test feedback](feedback_test.md) — test entry\n');
  fs.writeFileSync(path.join(memDir, 'feedback_test.md'),
    '# Test feedback\n\nThis entry exists to verify the loader picks up linked .md files.\n');
  const ctx = _loadProjectContext(proj);
  assert.match(ctx, /Project auto-memory index/, 'expected memory index section header');
  assert.match(ctx, /memory\/feedback_test\.md/, 'expected linked feedback file inlined');
  assert.match(ctx, /Test feedback/);
});

t('caps each block at MAX_CONTEXT_BYTES (4096) with a truncation marker', () => {
  // Write a 10KB CLAUDE.md and confirm only ~4KB lands in the prompt.
  const big = 'a'.repeat(10000);
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), big);
  const ctx = _loadProjectContext(proj);
  const claudeMdMatch = ctx.match(/Project CLAUDE\.md[\s\S]+?(?=---|$)/);
  assert.ok(claudeMdMatch, 'expected CLAUDE.md section to appear');
  // Section length includes the header + the slice + the truncation marker.
  // Body slice alone is 4096 bytes; whole section is ~4150.
  assert.ok(claudeMdMatch[0].length < 5000,
    `CLAUDE.md section should be capped near 4KB, got ${claudeMdMatch[0].length}`);
  assert.match(ctx, /\(truncated\)/, 'expected truncation marker');
});

t('returns empty string for falsy cwd (no crash)', () => {
  assert.strictEqual(_loadProjectContext(null), '');
  assert.strictEqual(_loadProjectContext(''), '');
  assert.strictEqual(_loadProjectContext(undefined), '');
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
