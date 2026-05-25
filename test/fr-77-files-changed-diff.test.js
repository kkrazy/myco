// fr-77: file explorer "Changed files" section + diff viewer.
//
// User-reported (kkrazy 2026-05-25):
//   "File explorer makes it hard to see which files have changed and
//    quickly open a diff view. Directory pane split into two sections,
//    with the bottom section listing all changed files and supporting
//    click-to-open diff view."
//
// Server scope:
//   - listChangedFiles(absRoot) → { entries: [{path, status}], truncated }
//     Reuses _gitStatusMap (no extra git fork). Caps at 500 entries.
//   - readDiff(absRoot, relPath) → { path, diff, head, exists, gitless }
//     git diff HEAD -- <path>, with safeJoin guarding traversal.
//   - GET /sessions/:id/files-changed   (viewer-readable)
//   - GET /sessions/:id/files/diff?path=...   (viewer-readable)
//
// UI scope:
//   - #files-tree-pane split vertically: top = #files-tree (existing),
//     bottom = #files-changed-section (new)
//   - JS loadFilesChanged() fetches + renders the bottom list, with
//     refresh button + collapse chevron; click opens openFileDiffViewer.
//   - openFileDiffViewer renders unified diff (highlight.js
//     language-diff) into the right pane with a "diff vs <head>"
//     header chip. Edit button hidden in diff mode.
//   - Tree-collapsed CSS hides the changed-files section (no room).
//   - loadFilesChanged auto-fires on showFilesView mount + after a
//     successful _saveFileEdit (so the chip count refreshes when an
//     edit changes a file's git status).
//
// Tests cover:
//   1. Server module shape — exports + signatures
//   2. listChangedFiles behavior — git-status round-trip in a temp repo
//   3. readDiff behavior — diff output for a modified file
//   4. HTTP routes registered
//   5. HTML shell present
//   6. CSS rules present + correct scoping
//   7. JS functions exist + wire to the buttons

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}
async function tAsync(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const FILES_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'files.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');
const HTML = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');
const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── fr-77: changed-files section + diff viewer ──');

// ──────────────────────────────────────────────────────────────────────
// Server module shape
// ──────────────────────────────────────────────────────────────────────

t('files.js exports listChangedFiles + readDiff', () => {
  const m = require('../server/src/files');
  assert.strictEqual(typeof m.listChangedFiles, 'function',
    'listChangedFiles must be exported as a function');
  assert.strictEqual(typeof m.readDiff, 'function',
    'readDiff must be exported as a function');
});

t('files.js: listChangedFiles caps at 500 entries (truncated flag)', () => {
  // Pin the cap so future "raise the limit" patches show up explicitly.
  const idx = FILES_SRC.search(/function\s+listChangedFiles\s*\(/);
  assert.ok(idx > -1);
  const win = FILES_SRC.slice(idx, idx + 1500);
  assert.ok(/MAX\s*=\s*500/.test(win),
    'listChangedFiles must declare MAX = 500 as the entry cap');
  assert.ok(/truncated/.test(win),
    'listChangedFiles must surface a truncated flag');
});

t('files.js: readDiff guards path traversal via safeJoin', () => {
  const idx = FILES_SRC.search(/function\s+readDiff\s*\(/);
  assert.ok(idx > -1);
  const win = FILES_SRC.slice(idx, idx + 2000);
  assert.ok(/safeJoin\(absRoot,\s*relPath\)/.test(win),
    'readDiff must call safeJoin to reject path-traversal attacks');
});

t('files.js: readDiff uses git diff HEAD --no-color --no-ext-diff', () => {
  const idx = FILES_SRC.search(/function\s+readDiff\s*\(/);
  const win = FILES_SRC.slice(idx, idx + 3000);
  assert.ok(/--no-color/.test(win),
    '--no-color so the response is plain text');
  assert.ok(/--no-ext-diff/.test(win),
    '--no-ext-diff so a user git-config\'d external differ doesn\'t change the shape');
  assert.ok(/'HEAD'/.test(win),
    'diff vs HEAD (not staging/working-tree split)');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior — round-trip against a real temp git repo
// ──────────────────────────────────────────────────────────────────────

function mkTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr77-'));
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'world\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init']);
  return root;
}

tAsync('behavior: listChangedFiles returns modified + untracked + deleted files', async () => {
  const root = mkTempRepo();
  try {
    // Modify a.txt, delete b.txt, add a new untracked c.txt.
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello modified\n');
    fs.unlinkSync(path.join(root, 'b.txt'));
    fs.writeFileSync(path.join(root, 'c.txt'), 'new\n');
    const filesMod = require('../server/src/files');
    const out = await filesMod.listChangedFiles(root);
    assert.ok(Array.isArray(out.entries), 'entries must be an array');
    const map = new Map(out.entries.map((e) => [e.path, e.status]));
    assert.strictEqual(map.get('a.txt'), 'M',
      'a.txt should be M (modified); got ' + map.get('a.txt'));
    assert.strictEqual(map.get('b.txt'), 'D',
      'b.txt should be D (deleted); got ' + map.get('b.txt'));
    assert.strictEqual(map.get('c.txt'), '?',
      'c.txt should be ? (untracked); got ' + map.get('c.txt'));
    assert.strictEqual(out.truncated, false);
    // Sorted by path.
    const paths = out.entries.map((e) => e.path);
    assert.deepStrictEqual(paths, [...paths].sort(),
      'entries must be sorted by path for deterministic UI');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

tAsync('behavior: listChangedFiles returns empty in a clean repo', async () => {
  const root = mkTempRepo();
  try {
    const filesMod = require('../server/src/files');
    const out = await filesMod.listChangedFiles(root);
    assert.deepStrictEqual(out, { entries: [], truncated: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

tAsync('behavior: listChangedFiles tolerates non-git workspaces (empty)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr77-nongit-'));
  try {
    fs.writeFileSync(path.join(root, 'x.txt'), 'x');
    const filesMod = require('../server/src/files');
    const out = await filesMod.listChangedFiles(root);
    assert.deepStrictEqual(out, { entries: [], truncated: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

tAsync('behavior: readDiff returns unified diff for a modified file', async () => {
  const root = mkTempRepo();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello modified\n');
    const filesMod = require('../server/src/files');
    const out = await filesMod.readDiff(root, 'a.txt');
    assert.strictEqual(out.path, 'a.txt');
    assert.ok(typeof out.diff === 'string' && out.diff.length > 0,
      'diff must be a non-empty string for a modified file');
    assert.ok(/^diff --git/m.test(out.diff),
      'diff output must contain a `diff --git` header');
    assert.ok(/-hello$/m.test(out.diff) || /^-hello/m.test(out.diff),
      'diff must show the removed line');
    assert.ok(/\+hello modified$/m.test(out.diff) || /^\+hello modified/m.test(out.diff),
      'diff must show the added line');
    assert.strictEqual(out.exists, true);
    assert.ok(out.head && /^[0-9a-f]{4,}$/.test(out.head),
      'head must be a short SHA; got ' + out.head);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

tAsync('behavior: readDiff signals exists=false for deleted file', async () => {
  const root = mkTempRepo();
  try {
    fs.unlinkSync(path.join(root, 'b.txt'));
    const filesMod = require('../server/src/files');
    const out = await filesMod.readDiff(root, 'b.txt');
    assert.strictEqual(out.exists, false,
      'deleted file must have exists: false');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

tAsync('behavior: readDiff signals gitless=true in non-git workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr77-nongit-'));
  try {
    fs.writeFileSync(path.join(root, 'x.txt'), 'x');
    const filesMod = require('../server/src/files');
    const out = await filesMod.readDiff(root, 'x.txt');
    assert.strictEqual(out.gitless, true,
      'non-git workspace must surface gitless:true');
    assert.strictEqual(out.diff, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

tAsync('behavior: readDiff rejects path traversal', async () => {
  const root = mkTempRepo();
  try {
    const filesMod = require('../server/src/files');
    let threw = false;
    try { await filesMod.readDiff(root, '../escape.txt'); }
    catch (e) { threw = true; assert.ok(/escape|OUTSIDE/i.test(e.message || ''), e.message); }
    assert.ok(threw, '../escape must throw');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────
// HTTP routes
// ──────────────────────────────────────────────────────────────────────

t('index.js: GET /sessions/:id/files-changed route registered', () => {
  assert.ok(/app\.get\(['"]\/sessions\/:id\/files-changed['"]/.test(INDEX_SRC),
    'files-changed route must be registered');
  // And must call listChangedFiles.
  const idx = INDEX_SRC.search(/files-changed/);
  const win = INDEX_SRC.slice(idx, idx + 800);
  assert.ok(/listChangedFiles/.test(win),
    'files-changed handler must call listChangedFiles');
});

t('index.js: GET /sessions/:id/files/diff route registered', () => {
  assert.ok(/app\.get\(['"]\/sessions\/:id\/files\/diff['"]/.test(INDEX_SRC),
    'files/diff route must be registered');
  // Anchor on the actual app.get() line, not the first substring
  // match (which lands in a comment higher up).
  const idx = INDEX_SRC.search(/app\.get\(['"]\/sessions\/:id\/files\/diff['"]/);
  const win = INDEX_SRC.slice(idx, idx + 800);
  assert.ok(/readDiff/.test(win),
    'files/diff handler must call readDiff');
});

// ──────────────────────────────────────────────────────────────────────
// HTML shell
// ──────────────────────────────────────────────────────────────────────

t('index.html: #files-changed-section + list + refresh + collapse buttons present', () => {
  assert.ok(/id="files-changed-section"/.test(HTML),
    '#files-changed-section element must exist');
  assert.ok(/id="files-changed-list"/.test(HTML),
    '#files-changed-list ul must exist');
  assert.ok(/id="files-changed-refresh"/.test(HTML),
    'refresh button must exist');
  assert.ok(/id="files-changed-collapse"/.test(HTML),
    'collapse button must exist');
  assert.ok(/id="files-changed-count"/.test(HTML),
    'count chip must exist (aria-live updates)');
});

t('index.html: section sits INSIDE #files-tree-pane (split-pane structure)', () => {
  // Anchor: the bottom section is rendered as a sibling of #files-tree
  // within #files-tree-pane.
  const paneIdx = HTML.indexOf('id="files-tree-pane"');
  assert.ok(paneIdx > -1);
  const paneEnd = HTML.indexOf('</div>', HTML.indexOf('id="files-changed-section"', paneIdx));
  const inside = HTML.slice(paneIdx, paneEnd);
  assert.ok(/files-tree-pane/.test(inside) && /files-changed-section/.test(inside),
    'changed-files section must live inside files-tree-pane');
});

// ──────────────────────────────────────────────────────────────────────
// CSS
// ──────────────────────────────────────────────────────────────────────

t('styles.css: #files-tree-pane is flex container; #files-tree scrolls itself', () => {
  // Pre-fix the pane had `overflow-y: auto` which conflicted with the
  // nested scrolls. fr-77 changed it to `overflow: hidden` so the two
  // stacked sections each scroll independently.
  const idx = CSS.indexOf('#files-tree-pane {');
  assert.ok(idx > -1);
  const blockEnd = CSS.indexOf('}', idx);
  const block = CSS.slice(idx, blockEnd);
  // Strip comments.
  const noComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/overflow:\s*hidden/.test(noComments),
    '#files-tree-pane must use overflow: hidden (children scroll)');
  // And #files-tree itself has overflow-y: auto.
  const treeIdx = CSS.indexOf('#files-tree-pane #files-tree {');
  assert.ok(treeIdx > -1, '#files-tree-pane #files-tree rule must exist');
});

t('styles.css: #files-changed-section has max-height + flex-direction column', () => {
  const idx = CSS.indexOf('#files-changed-section {');
  assert.ok(idx > -1);
  const blockEnd = CSS.indexOf('}', idx);
  const block = CSS.slice(idx, blockEnd);
  assert.ok(/max-height:\s*\d+vh/.test(block),
    'must cap height with vh-relative max-height');
  assert.ok(/flex-direction:\s*column/.test(block),
    'must stack header + list vertically');
});

t('styles.css: tree-collapsed mode hides the changed-files section', () => {
  assert.ok(/#files-wrap\.files-tree-collapsed\s+#files-changed-section\s*\{[\s\S]{0,80}display:\s*none/.test(CSS),
    'when tree pane is collapsed to a thin strip, the changed section must hide too');
});

t('styles.css: status colors mapped (.fc-status-M / -A / -D / -R / -U)', () => {
  for (const s of ['M', 'A', 'D', 'R', 'U']) {
    assert.ok(new RegExp('\\.fc-status-' + s + '\\b').test(CSS),
      `.fc-status-${s} color class must exist`);
  }
});

// ──────────────────────────────────────────────────────────────────────
// JS
// ──────────────────────────────────────────────────────────────────────

t('app.js: loadFilesChanged + openFileDiffViewer functions exist', () => {
  assert.ok(/function\s+loadFilesChanged\s*\(/.test(APP),
    'loadFilesChanged must be defined');
  assert.ok(/function\s+openFileDiffViewer\s*\(/.test(APP),
    'openFileDiffViewer must be defined');
  assert.ok(/function\s+_renderFilesChanged\s*\(/.test(APP),
    '_renderFilesChanged helper must be defined');
  assert.ok(/function\s+_renderDiffViewerBody\s*\(/.test(APP),
    '_renderDiffViewerBody helper must be defined');
});

t('app.js: showFilesView calls loadFilesChanged so the section refreshes on open', () => {
  const idx = APP.search(/function\s+showFilesView\s*\(/);
  assert.ok(idx > -1);
  const win = APP.slice(idx, idx + 1500);
  assert.ok(/loadFilesChanged\s*\(/.test(win),
    'showFilesView must call loadFilesChanged on mount');
});

t('app.js: refresh / collapse / list-click handlers bound in bindFilesUi', () => {
  const idx = APP.search(/function\s+bindFilesUi\s*\(/);
  const win = APP.slice(idx, idx + 3000);
  assert.ok(/files-changed-refresh/.test(win),
    'refresh button must be bound');
  assert.ok(/files-changed-collapse/.test(win),
    'collapse button must be bound');
  assert.ok(/files-changed-list/.test(win),
    'list element must have a click handler bound');
  assert.ok(/data-fc-path/.test(win) || /data-fc-path/.test(APP),
    'list items carry data-fc-path so the click handler picks the path');
});

t('app.js: _saveFileEdit refreshes the changed list on success', () => {
  // Anchor on the saveFileEdit success path; the loadFilesChanged
  // call should fire right after _exitFileEditMode.
  const idx = APP.search(/_exitFileEditMode\s*\(\)\s*;\s*\n[\s\S]{0,400}loadFilesChanged/);
  assert.ok(idx > -1,
    '_saveFileEdit success path must call loadFilesChanged({force:true}) so the chip count refreshes');
});

t('app.js: openFileDiffViewer hides the Edit button (no edit on diff)', () => {
  const idx = APP.search(/function\s+_renderDiffViewerBody\s*\(/);
  const win = APP.slice(idx, idx + 2500);
  assert.ok(/files-edit['"]?\)[\s\S]{0,80}hidden\s*=\s*true/.test(win),
    'diff view must hide the Edit button — diff is read-only');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
