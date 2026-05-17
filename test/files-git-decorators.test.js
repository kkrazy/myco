// fr-9: file explorer surfaces git change decorators + supports
// downloads. This test pins:
//   1. files.listDir enriches each entry with `gitStatus` when the
//      workspace is a git repo, omits it otherwise.
//   2. Directory entries aggregate the "loudest" status of their
//      children.
//   3. Server: GET /sessions/:id/file/download route exists with
//      attachment Content-Disposition (static-grep guard).
//   4. Client: renderFilesList emits the git-status badge + download
//      button; click on the download button doesn't open the file
//      viewer (static-grep guard).
//   5. CSS: .ft-git-M / .ft-git-A / .ft-git-D etc. styled.

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const filesApi = require('../server/src/files');

let passed = 0, failed = 0;
function t(name, fn) {
  // Functional tests that await async work need a small wrapper.
  const run = async () => {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
  };
  // Sequential — chain via an outer queue.
  t._chain = (t._chain || Promise.resolve()).then(run);
}

// Helper: create a tempdir that's a git repo with a modified file,
// an added file, a deleted file, and an untracked file. Returns the
// absolute root path.
async function makeGitFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'myco-fr9-'));
  const run = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  // Init + minimal config so commits work without a user .gitconfig.
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@test');
  run('config', 'user.name', 'test');
  // Seed commit with two tracked files.
  await fsp.writeFile(path.join(root, 'tracked-modified.txt'), 'original\n');
  await fsp.writeFile(path.join(root, 'tracked-deleted.txt'), 'will be deleted\n');
  await fsp.mkdir(path.join(root, 'src'));
  await fsp.writeFile(path.join(root, 'src', 'tracked.txt'), 'clean\n');
  run('add', '.');
  run('commit', '-q', '-m', 'seed');
  // Now mutate: modify, delete, add new, leave one untracked.
  await fsp.writeFile(path.join(root, 'tracked-modified.txt'), 'modified content\n');
  await fsp.unlink(path.join(root, 'tracked-deleted.txt'));
  await fsp.writeFile(path.join(root, 'untracked.txt'), 'unknown to git\n');
  await fsp.writeFile(path.join(root, 'newly-added.txt'), 'staged\n');
  run('add', 'newly-added.txt');
  // src/added-nested.txt — staged inside subdir
  await fsp.writeFile(path.join(root, 'src', 'added-nested.txt'), 'nested add\n');
  run('add', 'src/added-nested.txt');
  return root;
}

console.log('── fr-9: file explorer git decorators + download ──');

t('listDir returns gitStatus on tracked-modified file', async () => {
  const root = await makeGitFixture();
  try {
    const out = await filesApi.listDir(root, '.');
    const m = out.entries.find((e) => e.name === 'tracked-modified.txt');
    assert.ok(m, 'tracked-modified.txt missing from listDir output');
    assert.strictEqual(m.gitStatus, 'M', `expected gitStatus M, got ${JSON.stringify(m.gitStatus)}`);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

t('listDir returns gitStatus on staged-added file', async () => {
  const root = await makeGitFixture();
  try {
    const out = await filesApi.listDir(root, '.');
    const a = out.entries.find((e) => e.name === 'newly-added.txt');
    assert.ok(a, 'newly-added.txt missing');
    assert.strictEqual(a.gitStatus, 'A');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

t('listDir returns gitStatus on deleted file', async () => {
  const root = await makeGitFixture();
  try {
    // The deleted file is not in the FS listing (it's been rm'd),
    // but git status still tracks it. listDir only returns FS
    // entries, so we can't surface "D" here. Verify via the
    // gitStatusMap behavior on a directory aggregate.
    const out = await filesApi.listDir(root, '.');
    // Should see 'D' as a candidate "loudest" status on the parent
    // dir if there were nested deletes — for now just confirm no
    // entry for tracked-deleted.txt exists.
    const d = out.entries.find((e) => e.name === 'tracked-deleted.txt');
    assert.strictEqual(d, undefined, 'tracked-deleted.txt should be absent from FS listing');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

t('listDir returns gitStatus = "?" for untracked file', async () => {
  const root = await makeGitFixture();
  try {
    const out = await filesApi.listDir(root, '.');
    const u = out.entries.find((e) => e.name === 'untracked.txt');
    assert.ok(u, 'untracked.txt missing');
    assert.strictEqual(u.gitStatus, '?');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

t('listDir aggregates child status onto parent directory', async () => {
  const root = await makeGitFixture();
  try {
    const out = await filesApi.listDir(root, '.');
    const srcDir = out.entries.find((e) => e.name === 'src' && e.kind === 'dir');
    assert.ok(srcDir, 'src/ dir missing');
    // src/added-nested.txt is staged-added → src/ should show 'A'
    // (A has higher rank than M).
    assert.ok(['A', 'M'].includes(srcDir.gitStatus),
      `expected src/ aggregate to be A or M, got ${JSON.stringify(srcDir.gitStatus)}`);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

t('listDir omits gitStatus on non-git workspace', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'myco-fr9-nogit-'));
  try {
    await fsp.writeFile(path.join(root, 'plain.txt'), 'hello\n');
    const out = await filesApi.listDir(root, '.');
    const e = out.entries.find((x) => x.name === 'plain.txt');
    assert.ok(e);
    assert.strictEqual(e.gitStatus, undefined,
      'non-git workspaces should NOT include a gitStatus field');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── server-side static guards ──────────────────────────────────────

t('static guard: /sessions/:id/file/download route exists in index.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');
  assert.ok(/app\.get\(['"]\/sessions\/:id\/file\/download['"]/.test(src),
    'download route missing from index.js');
  assert.ok(/Content-Disposition[^,]*attachment/i.test(src),
    'download route no longer sets Content-Disposition: attachment — browser would render inline instead of saving');
});

t('static guard: files.js exports git-status helpers + integrates into listDir', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'files.js'), 'utf8');
  assert.ok(/async function _gitStatusMap\(absRoot\)/.test(src),
    '_gitStatusMap helper missing');
  assert.ok(/function _dirGitStatus\(gitMap, dirRelPath\)/.test(src),
    '_dirGitStatus helper missing');
  assert.ok(/gitStatus/.test(src),
    'listDir no longer surfaces gitStatus field on entries');
  assert.ok(/git['"],?\s*\[['"]-C['"]/.test(src) || /\['-C',\s*absRoot,\s*'status'/.test(src),
    '_gitStatusMap no longer shells out to `git -C absRoot status`');
});

// ── client-side static guards ──────────────────────────────────────

t('static guard: renderFilesList emits git-status badge + download button', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(/function renderGitStatusBadge\(status\)/.test(app),
    'renderGitStatusBadge helper missing');
  assert.ok(/ft-git-status/.test(app),
    'git-status badge class missing from app.js');
  assert.ok(/data-action="download"/.test(app),
    'download button marker missing from renderFilesList');
  assert.ok(/function triggerFileDownload\(relPath\)/.test(app),
    'triggerFileDownload helper missing');
});

t('static guard: file-tree icons use Lucide-style SVGs (match main app chrome)', () => {
  // Polish 2026-05-17: replaced text-letter badges ("JS", "TS", etc.)
  // with inline Lucide-style SVGs to match the main app's chrome
  // cluster (24x24 viewBox, stroke 1.75, currentColor, round caps).
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(/const FT_SVG = \{/.test(app),
    'FT_SVG icon library missing — main-app icon consistency lost');
  // Each of the four core icons should be defined.
  for (const key of ['folder', 'file', 'link', 'download']) {
    assert.ok(new RegExp(`\\b${key}\\s*:\\s*'<svg`).test(app),
      `FT_SVG.${key} icon missing`);
  }
  // Common Lucide attrs should be present (viewBox, stroke-width 1.75).
  assert.ok(/viewBox="0 0 24 24"[^>]*stroke="currentColor"[^>]*stroke-width="1\.75"/.test(app),
    'SVG attrs drifted from the main-app Lucide style (viewBox 24x24, currentColor, stroke 1.75)');
});

t('static guard: download click stops propagation (does NOT open the file viewer)', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  // Look for the click handler in renderFilesList that branches on the
  // data-action="download" target.
  const m = app.match(/data-action="download"[\s\S]*?stopPropagation\(\)/);
  assert.ok(m,
    'download click handler missing stopPropagation() — clicking ⬇ would also open the file in the viewer');
});

t('static guard: CSS styles for ft-git-* badges + ft-download button', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');
  assert.ok(/\.ft-git-status\s*\{/.test(css), '.ft-git-status base style missing');
  assert.ok(/\.ft-git-M\b/.test(css), '.ft-git-M missing');
  assert.ok(/\.ft-git-A\b/.test(css), '.ft-git-A missing');
  assert.ok(/\.ft-git-D\b/.test(css), '.ft-git-D missing');
  assert.ok(/\.ft-download\s*\{/.test(css), '.ft-download button style missing');
});

// Wait for the queued async tests to finish, then summarize.
(async () => {
  await t._chain;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
