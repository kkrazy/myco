// fr-77: file explorer "Changed files" section + diff viewer.
//
// User-reported (kkrazy 2026-05-25):
//   "File explorer makes it hard to see which files have changed and
//    quickly open a diff view. Directory pane split into two sections,
//    with the bottom section listing all changed files and supporting
//    click-to-open diff view."
//
//   r2 comment: "on top of the file changes add a description on
//     what has changed, idea with reference to bug/td/fr."
//   r3 comment: "move the changed files to the lower portion of the
//     plan view. click on a changed file expand it, with feature to
//     collapse it."
//
// Server scope (unchanged across r1 / r2 / r3):
//   - listChangedFiles(absRoot) → { entries: [{path, status}], truncated,
//                                   mentions, recentCommits }
//     Reuses _gitStatusMap (no extra git fork). Caps entries at 500.
//   - readDiff(absRoot, relPath) → { path, diff, head, exists, gitless }
//     git diff HEAD -- <path>, with safeJoin guarding traversal.
//   - GET /sessions/:id/files-changed   (viewer-readable)
//   - GET /sessions/:id/files/diff?path=...   (viewer-readable)
//
// UI scope (r3 — relocated):
//   - #plan-changed-files-section lives inside #plan-wrap as a peer of
//     #artifact-body-plan (was: inside #files-tree-pane). Removed from
//     the Files view entirely.
//   - bindPlanChangedFilesUi binds refresh / collapse / list-click on
//     first Plan-show.
//   - Clicking a file row toggles an INLINE diff body (was: opened the
//     right-pane viewer). The diff renders as a sibling <li.pcf-diff-row>
//     inserted immediately after the clicked row. Click again to remove.
//   - showArtifactView('plan') triggers bindPlanChangedFilesUi +
//     loadPlanChangedFiles({force:false}) so the section is populated
//     when the user opens the Plan tab.
//
// Tests cover:
//   1. Server module shape — exports + signatures
//   2. listChangedFiles behavior — git-status round-trip in a temp repo
//   3. readDiff behavior — diff output for a modified file
//   4. HTTP routes registered
//   5. HTML shell present (Plan-view location)
//   6. CSS rules present + correct scoping
//   7. JS functions exist + wire to the buttons
//   8. fr-77 r2 — mentions + recent commits surfaced from server
//   9. fr-77 r3 — inline-expand behavior shape

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { sliceFn } = require('./_lib/fn-body');

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

console.log('── fr-77: Changed-files section (in Plan view, r3) + inline diff ──');

// ──────────────────────────────────────────────────────────────────────
// Server module shape (unchanged)
// ──────────────────────────────────────────────────────────────────────

t('files.js exports listChangedFiles + readDiff', () => {
  const m = require('../server/src/files');
  assert.strictEqual(typeof m.listChangedFiles, 'function');
  assert.strictEqual(typeof m.readDiff, 'function');
});

t('files.js: listChangedFiles caps at 500 entries (truncated flag)', () => {
  const idx = FILES_SRC.search(/function\s+listChangedFiles\s*\(/);
  assert.ok(idx > -1);
  const win = sliceFn(FILES_SRC, idx);
  assert.ok(/MAX\s*=\s*500/.test(win),
    'listChangedFiles must declare MAX = 500 as the entry cap');
  assert.ok(/truncated/.test(win),
    'listChangedFiles must surface a truncated flag');
});

t('files.js: readDiff guards path traversal via safeJoin', () => {
  const idx = FILES_SRC.search(/function\s+readDiff\s*\(/);
  assert.ok(idx > -1);
  const win = sliceFn(FILES_SRC, idx);
  assert.ok(/safeJoin\(absRoot,\s*relPath\)/.test(win));
});

t('files.js: readDiff uses git diff HEAD --no-color --no-ext-diff', () => {
  const idx = FILES_SRC.search(/function\s+readDiff\s*\(/);
  const win = sliceFn(FILES_SRC, idx);
  assert.ok(/--no-color/.test(win));
  assert.ok(/--no-ext-diff/.test(win));
  assert.ok(/'HEAD'/.test(win));
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

(async () => {

await tAsync('behavior: listChangedFiles returns modified + untracked + deleted files', async () => {
  const root = mkTempRepo();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello modified\n');
    fs.unlinkSync(path.join(root, 'b.txt'));
    fs.writeFileSync(path.join(root, 'c.txt'), 'new\n');
    const filesMod = require('../server/src/files');
    const out = await filesMod.listChangedFiles(root);
    assert.ok(Array.isArray(out.entries));
    const map = new Map(out.entries.map((e) => [e.path, e.status]));
    assert.strictEqual(map.get('a.txt'), 'M');
    assert.strictEqual(map.get('b.txt'), 'D');
    assert.strictEqual(map.get('c.txt'), '?');
    assert.strictEqual(out.truncated, false);
    const paths = out.entries.map((e) => e.path);
    assert.deepStrictEqual(paths, [...paths].sort(),
      'entries must be sorted by path for deterministic UI');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await tAsync('behavior: listChangedFiles returns empty entries in a clean repo (but recentCommits stays)', async () => {
  const root = mkTempRepo();
  try {
    const filesMod = require('../server/src/files');
    const out = await filesMod.listChangedFiles(root);
    assert.deepStrictEqual(out.entries, []);
    assert.strictEqual(out.truncated, false);
    assert.deepStrictEqual(out.mentions, []);
    assert.ok(Array.isArray(out.recentCommits) && out.recentCommits.length >= 1,
      'recentCommits must still surface in a clean repo (last activity context)');
    assert.strictEqual(out.recentCommits[0].subject, 'init');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await tAsync('behavior: listChangedFiles tolerates non-git workspaces (empty)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr77-nongit-'));
  try {
    fs.writeFileSync(path.join(root, 'x.txt'), 'x');
    const filesMod = require('../server/src/files');
    const out = await filesMod.listChangedFiles(root);
    assert.deepStrictEqual(out, {
      entries: [], truncated: false, mentions: [], recentCommits: [],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await tAsync('behavior: readDiff returns unified diff for a modified file', async () => {
  const root = mkTempRepo();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello modified\n');
    const filesMod = require('../server/src/files');
    const out = await filesMod.readDiff(root, 'a.txt');
    assert.strictEqual(out.path, 'a.txt');
    assert.ok(typeof out.diff === 'string' && out.diff.length > 0);
    assert.ok(/^diff --git/m.test(out.diff));
    assert.ok(/-hello$/m.test(out.diff) || /^-hello/m.test(out.diff));
    assert.ok(/\+hello modified$/m.test(out.diff) || /^\+hello modified/m.test(out.diff));
    assert.strictEqual(out.exists, true);
    assert.ok(out.head && /^[0-9a-f]{4,}$/.test(out.head));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await tAsync('behavior: readDiff signals exists=false for deleted file', async () => {
  const root = mkTempRepo();
  try {
    fs.unlinkSync(path.join(root, 'b.txt'));
    const filesMod = require('../server/src/files');
    const out = await filesMod.readDiff(root, 'b.txt');
    assert.strictEqual(out.exists, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await tAsync('behavior: readDiff signals gitless=true in non-git workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr77-nongit-'));
  try {
    fs.writeFileSync(path.join(root, 'x.txt'), 'x');
    const filesMod = require('../server/src/files');
    const out = await filesMod.readDiff(root, 'x.txt');
    assert.strictEqual(out.gitless, true);
    assert.strictEqual(out.diff, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await tAsync('behavior: NESTED repo layout — list + diff resolve via project subdir', async () => {
  const wrapper = fs.mkdtempSync(path.join(os.tmpdir(), 'fr77-nested-'));
  const inner = path.join(wrapper, 'myco');
  fs.mkdirSync(inner, { recursive: true });
  execFileSync('git', ['-C', inner, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', inner, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', inner, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(inner, 'a.txt'), 'first\n');
  execFileSync('git', ['-C', inner, 'add', '.']);
  execFileSync('git', ['-C', inner, 'commit', '-q', '-m', 'init']);
  fs.writeFileSync(path.join(inner, 'a.txt'), 'second\n');
  try {
    delete require.cache[require.resolve('../server/src/files')];
    const filesMod = require('../server/src/files');
    const list = await filesMod.listChangedFiles(wrapper);
    const paths = (list.entries || []).map((e) => e.path);
    assert.ok(paths.includes('myco/a.txt'),
      `nested-repo paths must include subdir prefix; got: ${JSON.stringify(paths)}`);
    const diff = await filesMod.readDiff(wrapper, 'myco/a.txt');
    assert.ok(diff.diff && /first/.test(diff.diff) && /second/.test(diff.diff));
    assert.strictEqual(diff.path, 'myco/a.txt');
    assert.strictEqual(diff.gitless, undefined);
  } finally {
    fs.rmSync(wrapper, { recursive: true, force: true });
  }
});

await tAsync('fr-77 r10: readDiff synthesizes an all-additions diff for untracked files', async () => {
  // Untracked (new) files don't appear in `git diff HEAD` — git only
  // diffs tracked content. Pre-r10 the inline expand showed the user
  // "(no diff)" notice. r10 falls back to `git diff --no-index
  // /dev/null <file>` to render the file's contents as additions,
  // matching the GitHub-PR-style view for a new file.
  const root = mkTempRepo();
  try {
    fs.writeFileSync(path.join(root, 'fresh.js'),
      'const x = 1;\nfunction foo() { return x; }\n');
    delete require.cache[require.resolve('../server/src/files')];
    const filesMod = require('../server/src/files');
    const out = await filesMod.readDiff(root, 'fresh.js');
    assert.strictEqual(out.path, 'fresh.js');
    assert.strictEqual(out.exists, true);
    // Synthetic diff body: must include the file header + hunk header +
    // both source lines as additions.
    assert.ok(out.diff && out.diff.length > 0,
      'synthetic diff must be non-empty for an untracked file');
    assert.ok(/diff --git a\/dev\/null b\/fresh\.js/.test(out.diff),
      'synthetic diff header must use a/dev/null b/<displayPath>');
    assert.ok(/^\+\+\+ b\/fresh\.js$/m.test(out.diff),
      '+++ header must use the display path (so language detection sees .js)');
    assert.ok(/^@@\s+-0,0\s+\+1,2\s+@@/m.test(out.diff),
      'hunk header must declare 0 lines from /dev/null + 2 lines added');
    assert.ok(/^\+const x = 1;$/m.test(out.diff),
      'each source line must appear as an addition');
    assert.ok(/^\+function foo\(\)/m.test(out.diff),
      'second source line must appear as an addition');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await tAsync('fr-77 r10: untracked diff skipped for files >1MB (size cap)', async () => {
  // The synthesizer caps at 1MB to avoid OOM on a stray log dump.
  // Files over the cap fall through to the existing empty-diff UI
  // notice rather than streaming megabytes of additions to the client.
  const root = mkTempRepo();
  try {
    const big = Buffer.alloc(1.2 * 1024 * 1024, 0x61); // 1.2MB of 'a'
    fs.writeFileSync(path.join(root, 'big.log'), big);
    delete require.cache[require.resolve('../server/src/files')];
    const filesMod = require('../server/src/files');
    const out = await filesMod.readDiff(root, 'big.log');
    assert.strictEqual(out.exists, true);
    assert.strictEqual(out.diff, '',
      'files over 1MB must skip synthesis and return empty diff');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await tAsync('behavior: readDiff rejects path traversal', async () => {
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
// fr-77 r2 — description (mentions from diff + recent commits)
// ──────────────────────────────────────────────────────────────────────

await tAsync('fr-77 r2: listChangedFiles surfaces bug/fr/td mentions from diff text', async () => {
  const root = mkTempRepo();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'),
      'hello\n// touches bug-99 and fr-100 (also td-7)\n');
    const filesMod = require('../server/src/files');
    const out = await filesMod.listChangedFiles(root);
    assert.ok(Array.isArray(out.mentions));
    assert.deepStrictEqual(out.mentions, ['bug-99', 'fr-100', 'td-7'].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await tAsync('fr-77 r2: listChangedFiles surfaces last-5 commit subjects with per-commit mentions', async () => {
  const root = mkTempRepo();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'v2\n');
    execFileSync('git', ['-C', root, 'commit', '-aqm', 'feat(fr-200): pretty diffs']);
    fs.writeFileSync(path.join(root, 'a.txt'), 'v3\n');
    execFileSync('git', ['-C', root, 'commit', '-aqm', 'fix(bug-300): handle edge case']);
    const filesMod = require('../server/src/files');
    const out = await filesMod.listChangedFiles(root);
    assert.ok(Array.isArray(out.recentCommits));
    assert.ok(out.recentCommits.length >= 3);
    assert.ok(/bug-300/.test(out.recentCommits[0].subject));
    assert.deepStrictEqual(out.recentCommits[0].mentions, ['bug-300']);
    assert.deepStrictEqual(out.recentCommits[1].mentions, ['fr-200']);
    for (const c of out.recentCommits) {
      assert.ok(/^[0-9a-f]{4,}$/.test(c.sha),
        `sha must be a short hex SHA; got ${JSON.stringify(c.sha)}`);
      assert.strictEqual(typeof c.subject, 'string');
      assert.ok(Array.isArray(c.mentions));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

t('fr-77 r2 server: _extractMentions caps at 50 entries (defense)', () => {
  const idx = FILES_SRC.search(/function\s+_extractMentions\s*\(/);
  assert.ok(idx > -1, '_extractMentions must be defined');
  const win = sliceFn(FILES_SRC, idx);
  assert.ok(/found\.size\s*>=\s*50/.test(win));
  assert.ok(/fr\|bug\|td|bug\|fr\|td|td\|fr\|bug/.test(win));
});

t('fr-77 r2 server: log parser uses NUL separator (%h%x00%s) safely', () => {
  const idx = FILES_SRC.search(/--pretty=format:%h%x00%s/);
  assert.ok(idx > -1, 'git log must use %h%x00%s');
  const win = sliceFn(FILES_SRC, idx);
  assert.ok(/line\.indexOf\('\\0'\)/.test(win),
    "parser must call indexOf('\\\\0') — NUL byte split, not newline");
});

// ──────────────────────────────────────────────────────────────────────
// HTTP routes
// ──────────────────────────────────────────────────────────────────────

t('index.js: GET /sessions/:id/files-changed route registered', () => {
  assert.ok(/app\.get\(['"]\/sessions\/:id\/files-changed['"]/.test(INDEX_SRC));
  const idx = INDEX_SRC.search(/files-changed/);
  const win = INDEX_SRC.slice(idx, idx + 800);
  assert.ok(/listChangedFiles/.test(win));
});

t('index.js: GET /sessions/:id/files/diff route registered', () => {
  assert.ok(/app\.get\(['"]\/sessions\/:id\/files\/diff['"]/.test(INDEX_SRC));
  const idx = INDEX_SRC.search(/app\.get\(['"]\/sessions\/:id\/files\/diff['"]/);
  const win = INDEX_SRC.slice(idx, idx + 800);
  assert.ok(/readDiff/.test(win));
});

// ──────────────────────────────────────────────────────────────────────
// HTML shell — fr-77 r3 location
// ──────────────────────────────────────────────────────────────────────

t('index.html: #plan-changed-files-section + list + refresh + collapse + desc present', () => {
  for (const id of [
    'plan-changed-files-section',
    'plan-changed-files-list',
    'plan-changed-files-refresh',
    'plan-changed-files-collapse',
    'plan-changed-files-count',
    'plan-changed-files-desc',
  ]) {
    assert.ok(new RegExp(`id="${id}"`).test(HTML),
      `#${id} element must exist in Plan-view section`);
  }
});

t('index.html: #plan-changed-files-section lives INSIDE #plan-wrap (Plan view)', () => {
  const planIdx = HTML.indexOf('id="plan-wrap"');
  assert.ok(planIdx > -1);
  // Walk from #plan-wrap forward looking for the section and the closing
  // </div> of plan-wrap. Section must be inside plan-wrap.
  const tail = HTML.slice(planIdx);
  const secOff = tail.indexOf('id="plan-changed-files-section"');
  const archOff = tail.indexOf('id="arch-wrap"');
  assert.ok(secOff > -1 && (archOff === -1 || secOff < archOff),
    'changed-files section must live INSIDE plan-wrap (before #arch-wrap)');
});

t('index.html: #files-changed-section is GONE from Files view (r3 relocation)', () => {
  assert.ok(!/id="files-changed-section"/.test(HTML),
    '#files-changed-section was moved to Plan view — must not remain in Files view');
  assert.ok(!/id="files-changed-list"/.test(HTML),
    '#files-changed-list must be gone from Files view');
});

// ──────────────────────────────────────────────────────────────────────
// CSS
// ──────────────────────────────────────────────────────────────────────

t('styles.css: #plan-changed-files-section has max-height + flex-direction column', () => {
  // Anchor on the line-starting standalone rule (not the combined
  // centering selector list that also contains #plan-changed-files-section).
  const m = CSS.match(/\n#plan-changed-files-section\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '#plan-changed-files-section base rule must exist');
  const block = m[0];
  assert.ok(/max-height:\s*\d+vh/.test(block),
    'must cap height with vh-relative max-height');
  assert.ok(/flex-direction:\s*column/.test(block),
    'must stack header + desc + list vertically');
});

t('styles.css: fr-77 r9 — section matches plan body desktop width (no 880 cap)', () => {
  // The section MUST share the plan body's full-width lane on desktop
  // (bug-40's max-width:none relaxation), AND must NOT appear in the
  // shared 880px-cap centering selector — at equal specificity, cascade
  // order makes the shared rule win and re-introduces the 880px cap.
  //
  // Pin 1: bug-40 relaxation covers BOTH #artifact-body-plan AND
  //        #plan-changed-files-section.
  const reBugFix = /@media\s*\(\s*min-width:\s*901px\s*\)\s*\{[\s\S]{0,400}#artifact-body-plan[\s\S]{0,80},[\s\S]{0,80}#plan-changed-files-section[\s\S]{0,200}max-width:\s*none/;
  assert.ok(reBugFix.test(CSS),
    'bug-40 desktop max-width:none relaxation must cover both #artifact-body-plan AND #plan-changed-files-section so they share the full-width lane');
  // Pin 2: the section MUST NOT appear in the shared 880px-cap rule.
  //        Strip line comments first so the cascade-order note in the
  //        adjacent comment doesn't false-positive.
  const cssNoComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const reBadCap = /\.artifact-main-view\s+\.artifact-header[\s\S]{0,400}#plan-changed-files-section[\s\S]{0,400}max-width:\s*880px/;
  assert.ok(!reBadCap.test(cssNoComments),
    'section must NOT be in the shared 880px-cap selector — cascade order would override bug-40 and re-cap at 880px');
});

t('styles.css: status colors mapped (.fc-status-M / -A / -D / -R / -U)', () => {
  for (const s of ['M', 'A', 'D', 'R', 'U']) {
    assert.ok(new RegExp('\\.fc-status-' + s + '\\b').test(CSS),
      `.fc-status-${s} color class must exist`);
  }
});

t('styles.css: description-row classes present (.fc-mention-chip + .fc-recent-line + .fc-desc-label)', () => {
  assert.ok(/\.fc-mention-chip\b/.test(CSS));
  assert.ok(/\.fc-recent-line\b/.test(CSS));
  assert.ok(/\.fc-desc-label\b/.test(CSS));
});

t('styles.css: fr-77 r3 inline-diff styles present (.pcf-diff-body + .pcf-caret)', () => {
  assert.ok(/\.pcf-diff-body\b/.test(CSS),
    '.pcf-diff-body rule must exist for the inline-expand diff body');
  assert.ok(/\.pcf-caret\b/.test(CSS),
    '.pcf-caret rule must exist for the per-row chevron');
  // Rotated caret on expand.
  assert.ok(/li\.is-expanded\s+\.pcf-caret\b[\s\S]{0,150}transform:\s*rotate\(90deg\)/.test(CSS),
    '.is-expanded li must rotate the caret 90deg');
});

t('styles.css: stale #files-changed-* rules removed (r3 relocation)', () => {
  for (const id of [
    '#files-changed-section', '#files-changed-list', '#files-changed-header',
    '#files-changed-desc', '#files-changed-refresh', '#files-changed-collapse',
    '#files-changed-count', '#files-changed-msg', '#files-changed-title',
  ]) {
    assert.ok(!CSS.includes(id),
      `${id} rule must be removed — relocated to plan-changed-files-* in r3`);
  }
});

// ──────────────────────────────────────────────────────────────────────
// JS — fr-77 r3 functions + bindings
// ──────────────────────────────────────────────────────────────────────

t('app.js: loadPlanChangedFiles + _renderPlanChangedFiles + _renderPlanChangedFilesDesc defined', () => {
  assert.ok(/async\s+function\s+loadPlanChangedFiles\s*\(/.test(APP),
    'loadPlanChangedFiles must be defined');
  assert.ok(/function\s+_renderPlanChangedFiles\s*\(/.test(APP),
    '_renderPlanChangedFiles must be defined');
  assert.ok(/function\s+_renderPlanChangedFilesDesc\s*\(/.test(APP),
    '_renderPlanChangedFilesDesc must be defined');
});

t('app.js: _togglePlanChangedFileExpand + _renderInlineDiffBody defined (inline-expand path)', () => {
  assert.ok(/async\s+function\s+_togglePlanChangedFileExpand\s*\(/.test(APP),
    '_togglePlanChangedFileExpand must be defined');
  assert.ok(/function\s+_renderInlineDiffBody\s*\(/.test(APP),
    '_renderInlineDiffBody must be defined');
});

t('app.js: bindPlanChangedFilesUi defined and idempotent (dataset.bound guard)', () => {
  assert.ok(/function\s+bindPlanChangedFilesUi\s*\(/.test(APP));
  const idx = APP.search(/function\s+bindPlanChangedFilesUi\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/dataset\.bound/.test(win),
    'bind must be guarded so re-shows of the Plan view do not double-bind');
  assert.ok(/plan-changed-files-refresh/.test(win),
    'refresh button must be bound');
  assert.ok(/plan-changed-files-collapse/.test(win),
    'collapse button must be bound');
  assert.ok(/plan-changed-files-list/.test(win),
    'list element must have a click handler bound');
});

t('app.js: showArtifactView("plan") triggers loadPlanChangedFiles + bindPlanChangedFilesUi', () => {
  const idx = APP.search(/function\s+showArtifactView\s*\(/);
  assert.ok(idx > -1);
  const win = sliceFn(APP, idx);
  assert.ok(/type\s*===\s*['"]plan['"]/.test(win),
    'showArtifactView must gate the changed-files load on type === "plan"');
  assert.ok(/bindPlanChangedFilesUi\(/.test(win),
    'showArtifactView must call bindPlanChangedFilesUi on the plan branch');
  assert.ok(/loadPlanChangedFiles\(/.test(win),
    'showArtifactView must call loadPlanChangedFiles on the plan branch');
});

t('app.js: inline-expand toggles a sibling li.pcf-diff-row (not the right pane)', () => {
  const idx = APP.search(/async\s+function\s+_togglePlanChangedFileExpand\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/createElement\(['"]li['"]\)/.test(win),
    'inline expand must create a new LI sibling for the diff body');
  assert.ok(/pcf-diff-row/.test(win),
    'the new LI must carry the .pcf-diff-row class');
  assert.ok(/is-expanded/.test(win),
    'parent row must get an is-expanded marker');
  // Collapse path: remove the sibling, drop the marker.
  assert.ok(/diffRow\.remove\(\)/.test(win),
    'collapse must remove the inline diff row');
  // Cached path skips the fetch.
  assert.ok(/_planChangedDiffCache/.test(win),
    'inline-expand must consult a per-row diff cache for instant re-expand');
});

t('app.js: inline-expand uses /files/diff endpoint (reuses readDiff route)', () => {
  const idx = APP.search(/async\s+function\s+_togglePlanChangedFileExpand\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/\/files\/diff\?path=/.test(win),
    'inline-expand must reuse the existing /files/diff endpoint');
});

t('app.js: _renderPlanChangedFiles list items carry data-fc-path + .pcf-caret', () => {
  const idx = APP.search(/function\s+_renderPlanChangedFiles\s*\(/);
  // r13 inlined SVG markup → grew the body; r16 added accepted-state
  // branches with duplicated button HTML → grew again. Slice 8kB to
  // cover.
  const win = sliceFn(APP, idx);
  assert.ok(/data-fc-path=/.test(win),
    'list items must carry data-fc-path so the click handler picks the path');
  assert.ok(/pcf-caret/.test(win),
    'each row must render a .pcf-caret chevron for the expand affordance');
});

t('app.js: _saveFileEdit success path refreshes the Plan changed-files section', () => {
  const idx = APP.search(/loadPlanChangedFiles\s*\(\s*\{\s*force:\s*true\s*\}/);
  assert.ok(idx > -1,
    '_saveFileEdit must call loadPlanChangedFiles({force:true}) on save so the chip count refreshes');
});

// ──────────────────────────────────────────────────────────────────────
// fr-77 r17 — plan-item Analysis + Implementation-Plan accordions
// ──────────────────────────────────────────────────────────────────────

t('app.js: r17 _planItemDetailsHtml emits <details> for analysis + implPlan when populated', () => {
  assert.ok(/function\s+_planItemDetailsHtml\s*\(/.test(APP),
    '_planItemDetailsHtml helper must be defined');
  const idx = APP.search(/function\s+_planItemDetailsHtml\s*\(/);
  const win = sliceFn(APP, idx);
  // Both field names referenced.
  assert.ok(/analysis/.test(win) && /implPlan/.test(win),
    'helper must read it.analysis + it.implPlan');
  // Uses <details> for native collapsible behavior.
  assert.ok(/<details/.test(win),
    'must render each section as a <details> element');
  // Summary labels are the human-friendly section names.
  assert.ok(/Analysis/.test(win) && /Implementation plan/i.test(win),
    'summary labels must be "Analysis" and "Implementation plan"');
  // Class hook on the wrapper so CSS can style.
  assert.ok(/artifact-item-section/.test(win),
    'wrapper class .artifact-item-section must be applied');
});

t('app.js: r17 plan-item render invokes _planItemDetailsHtml', () => {
  // renderItem-arrow inside the renderArtifact function references it.
  assert.ok(/\$\{_planItemDetailsHtml\(it\)\}/.test(APP),
    'renderItem must invoke _planItemDetailsHtml(it) so the sections render');
});

t('styles.css: r17 accordion summary + body styles defined', () => {
  for (const cls of [
    'artifact-item-sections',
    'artifact-item-section',
    'artifact-item-section-summary',
    'artifact-item-section-body',
  ]) {
    assert.ok(new RegExp('\\.' + cls + '\\b').test(CSS),
      `.${cls} CSS rule must be defined`);
  }
  // Collapsed marker rotates 90° when open.
  assert.ok(/artifact-item-section\[open\][\s\S]{0,200}rotate\(90deg\)/.test(CSS),
    'open <details> must rotate its caret marker 90deg');
});

// ──────────────────────────────────────────────────────────────────────
// fr-77 r18 — uniform action-button sizing + bumped comment icon
// ──────────────────────────────────────────────────────────────────────

t('styles.css: r18 action-row buttons share a fixed height (no per-button drift)', () => {
  // Single selector list covering vote / comment-toggle / run /
  // close / edit must set height + min-height. bug-49 removed the
  // trash button so the selector list now ends at .artifact-item-edit
  // instead of .artifact-item-delete; anchor accordingly.
  const re = /\.artifact-item-actions\s+\.artifact-vote[\s\S]{0,400}\.artifact-item-actions\s+\.artifact-item-edit\s*\{[\s\S]{0,400}height:\s*\d+px/;
  assert.ok(re.test(CSS),
    'r18 must declare a shared height for all action-row buttons (post-bug-49 the trailing .artifact-item-delete is gone)');
});

t('styles.css: r19 comment-toggle (+ siblings) icons match chrome 18px family', () => {
  // r18 went 14 → 16; r19 went 16 → 18 (chrome cluster's exact size).
  // The shared rule must size to 18px.
  const m = CSS.match(/\.vote-icon\s+svg[\s\S]*?\n\}/);
  assert.ok(m, '.vote-icon svg rule must exist');
  assert.ok(/width:\s*18px/.test(m[0]),
    'action-row SVG icons must be 18px (chrome cluster family, post-r19)');
});

// bug-49: the r19 "per-item delete adopts pill chrome matching
// comment-toggle" test was removed — the .artifact-item-delete button
// and its CSS base + :hover + svg rules were all deleted in bug-49
// (the new test/bug-49-trash-becomes-close.test.js asserts they're
// gone, which is now the contract).

// ──────────────────────────────────────────────────────────────────────
// fr-77 r14 / r15 / r16 — Lucide icons + Esc-to-cancel + accepted state
// ──────────────────────────────────────────────────────────────────────

t('app.js: r14 Lucide icon registry + _lucideIcon helper defined', () => {
  assert.ok(/const\s+LUCIDE_PATHS\s*=\s*\{/.test(APP),
    'LUCIDE_PATHS path registry must be defined');
  assert.ok(/function\s+_lucideIcon\s*\(/.test(APP),
    '_lucideIcon(name, cls) helper must be defined');
  // Registry must include every icon name the plan view uses.
  for (const name of ['bug', 'sparkles', 'check-square', 'thumbs-up',
                       'message-square', 'play', 'pencil', 'check',
                       'rotate-ccw', 'trash']) {
    assert.ok(new RegExp("'" + name + "'\\s*:").test(APP),
      `LUCIDE_PATHS must include '${name}'`);
  }
});

t('app.js: r14 plan-item action row uses _lucideIcon (not emoji)', () => {
  // Per-item action row builders should reference _lucideIcon for run,
  // edit, edited badge, close + reopen, comment-toggle, vote, and the
  // per-comment delete trash. Icon history on the close button:
  //   r14 → 'check' (✓), close-icon-uses-x → 'x', close-icon r2 →
  //   'check-popout' (hand-rolled composite per user sketch).
  // bug-49 removed the per-item trash button but the per-comment
  // delete still uses 'trash'.
  const idx = APP.search(/const\s+voteBlock\s*=/);
  const win = APP.slice(idx, idx + 14000);
  for (const name of ['thumbs-up', 'message-square', 'play', 'pencil',
                       'check-popout', 'rotate-ccw', 'trash']) {
    assert.ok(new RegExp("_lucideIcon\\(['\"]" + name + "['\"]").test(win),
      `plan-item action row must use _lucideIcon('${name}')`);
  }
  // Defensive: no emoji left in the action row markup. Strip line
  // comments AND block comments first — historical context comments
  // may legitimately reference the old emoji to explain the swap.
  const noComments = win.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/👍|💬|✎|↻/.test(noComments),
    'no emoji should remain in the plan-item action row code (r14 swap to SVG)');
});

t('index.html: r14 Bug/Feature/Todo filter chips use Lucide SVGs (no emoji)', () => {
  // Filter chip labels must contain inline SVGs with the chrome family
  // attributes (viewBox 24x24, stroke 1.75). The chip SVGs are big
  // (~700 bytes each) so slice generously.
  const startIdx = HTML.indexOf('id="plan-filter-row"');
  const sec = HTML.slice(startIdx, startIdx + 5000);
  assert.ok(/plan-filter-bug[\s\S]{0,800}<svg class="chip-svg"[^>]*stroke-width="1\.75"/.test(sec),
    'Bug chip must use a Lucide SVG');
  assert.ok(/plan-filter-feature[\s\S]{0,800}<svg class="chip-svg"[^>]*stroke-width="1\.75"/.test(sec),
    'Feature chip must use a Lucide SVG');
  assert.ok(/plan-filter-todo[\s\S]{0,800}<svg class="chip-svg"[^>]*stroke-width="1\.75"/.test(sec),
    'Todo chip must use a Lucide SVG');
  // No emoji remaining in the filter chip area itself (constrained to
  // just the three chip labels — the OAuth flow comment elsewhere in
  // the file is unrelated).
  const chipsOnly = sec.slice(0, sec.indexOf('plan-open-only-toggle'));
  assert.ok(!/🐞|✨|✅/.test(chipsOnly),
    'filter chips must not contain 🐞/✨/✅ emoji (r14 swap)');
});

t('styles.css: r14 SVG sizing rules for chip + btn-icon + comment icons', () => {
  assert.ok(/\.plan-type-chip\s+\.chip-svg/.test(CSS),
    'must size chip-svg in filter chips');
  assert.ok(/\.btn-icon\s+svg/.test(CSS),
    'must size svg inside .btn-icon (run/edit/close/edited badge)');
  assert.ok(/\.vote-icon\s+svg/.test(CSS),
    'must size svg inside .vote-icon');
  assert.ok(/\.artifact-comment-(edit|delete)\s+svg/.test(CSS),
    'must size svg inside comment-edit/delete buttons');
});

t('app.js: r15 _togglePcfLineComment binds Esc to dismiss + shows "Esc to cancel" hint', () => {
  const idx = APP.search(/function\s+_togglePcfLineComment\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/pcf-line-hint/.test(win),
    'per-line form must render a .pcf-line-hint');
  assert.ok(/Esc to cancel/.test(win),
    'hint text must include "Esc to cancel"');
  // Esc keydown handler on the textarea.
  assert.ok(/key\s*===\s*['"]Escape['"]/.test(win),
    'must bind keydown for Escape on the textarea');
});

t('app.js: r15 file-level reconsider form has Esc hint + handler', () => {
  // The form lives inside _renderInlineDiffBody's HTML, and the Esc
  // handler lives inside _bindDiffInteractions.
  const renderIdx = APP.search(/function\s+_renderInlineDiffBody\s*\(/);
  const renderWin = sliceFn(APP, renderIdx);
  assert.ok(/pcf-reconsider-hint/.test(renderWin),
    'file-level form must render a .pcf-reconsider-hint');
  assert.ok(/Esc to clear/.test(renderWin),
    'hint text must include "Esc to clear"');
  const bindIdx = APP.search(/function\s+_bindDiffInteractions\s*\(/);
  const bindWin = sliceFn(APP, bindIdx);
  assert.ok(/key\s*===\s*['"]Escape['"]/.test(bindWin),
    '_bindDiffInteractions must bind Escape on the file-level textarea');
});

t('app.js: r16 _planAcceptedPaths Set tracks accepted-this-session paths', () => {
  assert.ok(/_planAcceptedPaths\s*=\s*new\s+Set\(\)/.test(APP),
    '_planAcceptedPaths must be a Set');
  // _planChangedFilesAction populates it on accept success.
  const idx = APP.search(/async\s+function\s+_planChangedFilesAction\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/_planAcceptedPaths\.add/.test(win),
    'accept success must add the path to _planAcceptedPaths');
  // Refresh button clears it.
  const refreshIdx = APP.search(/plan-changed-files-refresh/);
  const refreshWin = APP.slice(refreshIdx, refreshIdx + 600);
  assert.ok(/_planAcceptedPaths\s*=\s*new\s+Set\(\)/.test(refreshWin),
    'Refresh button click must reset _planAcceptedPaths');
});

t('app.js: r16 _renderPlanChangedFiles emits .is-accepted + .pcf-accepted-badge + disabled buttons', () => {
  const idx = APP.search(/function\s+_renderPlanChangedFiles\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/_planAcceptedPaths\.has\(e\.path\)/.test(win),
    'render must check _planAcceptedPaths.has(e.path) per row');
  assert.ok(/pcf-accepted-badge/.test(win),
    'accepted rows must render a .pcf-accepted-badge');
  assert.ok(/is-accepted-state/.test(win),
    'accepted rows must render disabled .is-accepted-state buttons');
  assert.ok(/disabled/.test(win),
    'buttons must carry the HTML disabled attribute');
});

t('styles.css: r16 .is-accepted row styling + .pcf-accepted-badge + .is-accepted-state', () => {
  assert.ok(/#plan-changed-files-list\s+li\.is-accepted\b/.test(CSS),
    '.is-accepted row must have its own styling');
  assert.ok(/\.pcf-accepted-badge\b/.test(CSS),
    '.pcf-accepted-badge must be defined');
  assert.ok(/\.pcf-row-btn\.is-accepted-state\b/.test(CSS),
    '.pcf-row-btn.is-accepted-state must be defined (greyed-out look)');
});

// ──────────────────────────────────────────────────────────────────────
// fr-77 r12 — accept / reject / reconsider (file + per-line)
// ──────────────────────────────────────────────────────────────────────

t('files.js exports acceptFile + rejectFile', () => {
  const m = require('../server/src/files');
  assert.strictEqual(typeof m.acceptFile, 'function');
  assert.strictEqual(typeof m.rejectFile, 'function');
});

await tAsync('behavior: acceptFile stages a tracked-modified file (`git add`)', async () => {
  const root = mkTempRepo();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'modified\n');
    delete require.cache[require.resolve('../server/src/files')];
    const filesMod = require('../server/src/files');
    const out = await filesMod.acceptFile(root, 'a.txt');
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.action, 'accepted');
    // Verify via git status: M in index, no worktree mark.
    const st = execFileSync('git', ['-C', root, 'status', '--porcelain']).toString().trim();
    assert.ok(/^M  a\.txt$/m.test(st),
      `a.txt must be staged after accept; status was: ${JSON.stringify(st)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await tAsync('behavior: rejectFile DELETES an untracked file', async () => {
  const root = mkTempRepo();
  try {
    fs.writeFileSync(path.join(root, 'new.txt'), 'new\n');
    delete require.cache[require.resolve('../server/src/files')];
    const filesMod = require('../server/src/files');
    const out = await filesMod.rejectFile(root, 'new.txt');
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.action, 'rejected');
    assert.strictEqual(out.mode, 'deleted');
    assert.strictEqual(fs.existsSync(path.join(root, 'new.txt')), false,
      'untracked file must be removed from disk');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await tAsync('behavior: rejectFile REVERTS a tracked-modified file to HEAD', async () => {
  const root = mkTempRepo();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'modified\n');
    delete require.cache[require.resolve('../server/src/files')];
    const filesMod = require('../server/src/files');
    const out = await filesMod.rejectFile(root, 'a.txt');
    assert.strictEqual(out.mode, 'reverted');
    const txt = fs.readFileSync(path.join(root, 'a.txt'), 'utf8');
    assert.strictEqual(txt, 'hello\n',
      'tracked file must be restored to HEAD content');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await tAsync('behavior: rejectFile + ERR_NO_GIT in repo-less workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-'));
  try {
    fs.writeFileSync(path.join(root, 'x.txt'), 'x');
    delete require.cache[require.resolve('../server/src/files')];
    const filesMod = require('../server/src/files');
    let threw = false;
    try { await filesMod.rejectFile(root, 'x.txt'); }
    catch (e) { threw = true; assert.strictEqual(e.code, 'ERR_NO_GIT'); }
    assert.ok(threw, 'must throw ERR_NO_GIT for non-git workspaces');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

t('index.js: POST /sessions/:id/files/accept + /reject + /reconsider routes registered', () => {
  assert.ok(/app\.post\(['"]\/sessions\/:id\/files\/accept['"]/.test(INDEX_SRC),
    'POST /files/accept route must be registered');
  assert.ok(/app\.post\(['"]\/sessions\/:id\/files\/reject['"]/.test(INDEX_SRC),
    'POST /files/reject route must be registered');
  assert.ok(/app\.post\(['"]\/sessions\/:id\/files\/reconsider['"]/.test(INDEX_SRC),
    'POST /files/reconsider route must be registered');
});

t('index.js: accept + reject are owner-only (mutate worktree)', () => {
  // Walk each route block + assert fileApiPreamble uses 'owner'.
  for (const route of ['accept', 'reject']) {
    const idx = INDEX_SRC.search(new RegExp(`app\\.post\\(['"]\\/sessions\\/:id\\/files\\/${route}['"]`));
    assert.ok(idx > -1);
    const win = INDEX_SRC.slice(idx, idx + 500);
    assert.ok(/fileApiPreamble\([^)]*,\s*['"]owner['"]/.test(win),
      `/files/${route} must call fileApiPreamble with 'owner' role`);
  }
});

t('index.js: reconsider route emits [chat:reconsider#<path>] marker (with optional :L<n>)', () => {
  const idx = INDEX_SRC.search(/app\.post\(['"]\/sessions\/:id\/files\/reconsider['"]/);
  const win = INDEX_SRC.slice(idx, idx + 1500);
  assert.ok(/\[chat:reconsider#/.test(win),
    'must construct a [chat:reconsider#path] marker');
  assert.ok(/:L/.test(win) && /lineNo/.test(win),
    'must support optional :L<lineNo> suffix when lineNo is provided');
  assert.ok(/handleChatMessage\(/.test(win),
    'must forward via handleChatMessage to the active session');
});

t('app.js: _planChangedFilesAction (accept/reject) + _sendReconsider defined', () => {
  assert.ok(/async\s+function\s+_planChangedFilesAction\s*\(/.test(APP),
    '_planChangedFilesAction must be defined');
  assert.ok(/async\s+function\s+_sendReconsider\s*\(/.test(APP),
    '_sendReconsider must be defined');
  assert.ok(/function\s+_togglePcfLineComment\s*\(/.test(APP),
    '_togglePcfLineComment must be defined for per-line click-to-comment');
});

t('app.js: reject path asks window.confirm before destructive action', () => {
  const idx = APP.search(/async\s+function\s+_planChangedFilesAction\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/window\.confirm\(/.test(win),
    'reject must prompt window.confirm before deleting/reverting');
});

t('app.js: _renderPlanChangedFiles emits per-row accept + reject buttons when not readOnly', () => {
  const idx = APP.search(/function\s+_renderPlanChangedFiles\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/data-pcf-action=['"]accept['"]/.test(win),
    'rows must include an accept button with data-pcf-action="accept"');
  assert.ok(/data-pcf-action=['"]reject['"]/.test(win),
    'rows must include a reject button with data-pcf-action="reject"');
  // Buttons must be gated on canMutate / !state.readOnly.
  assert.ok(/state\.readOnly/.test(win) || /canMutate/.test(win),
    'per-row actions must be gated on readOnly state');
});

t('fr-77 r13: per-row + caret icons are Lucide SVGs matching the chrome cluster (stroke 1.75, viewBox 24x24)', () => {
  // The chrome cluster (#btn-files/plan/arch/test/chat) uses Lucide-
  // style inline SVGs with viewBox="0 0 24 24" stroke-width="1.75"
  // round caps + currentColor. r13 normalized the per-row Accept ✓ /
  // Reject ✕ buttons + the leading caret ▶ to the SAME family so the
  // whole UI reads as one icon system.
  const idx = APP.search(/function\s+_renderPlanChangedFiles\s*\(/);
  const win = sliceFn(APP, idx);
  // pcf-row-btn must contain SVG (not Unicode ✓/✕).
  const acceptBlock = win.slice(win.indexOf('data-pcf-action="accept"'));
  assert.ok(/<svg[^>]*viewBox="0 0 24 24"[^>]*stroke-width="1\.75"/.test(acceptBlock),
    'accept button must use a Lucide-style SVG (viewBox 24x24, stroke 1.75)');
  const rejectBlock = win.slice(win.indexOf('data-pcf-action="reject"'));
  assert.ok(/<svg[^>]*viewBox="0 0 24 24"[^>]*stroke-width="1\.75"/.test(rejectBlock),
    'reject button must use a Lucide-style SVG (viewBox 24x24, stroke 1.75)');
  // pcf-caret must contain a Lucide chevron SVG (not the ▶ char).
  assert.ok(/pcf-caret-svg[\s\S]{0,200}viewBox="0 0 24 24"[\s\S]{0,200}stroke-width="1\.75"/.test(win),
    'caret must be a Lucide-style chevron SVG, not the ▶ Unicode triangle');
  // Defensive: assert NO Unicode ✓ or ✕ characters in the row markup
  // (they crept in during r12; r13 removed them).
  const rowSection = win.slice(win.indexOf('return `<li'));
  assert.ok(!/✓|✕|▶/.test(rowSection),
    'row markup must not embed ✓/✕/▶ Unicode characters (r12 → r13 swap to SVG)');
});

t('index.html: bulk Accept all + Reject all buttons use stroke-width 1.75 (chrome family)', () => {
  // r12 shipped them at stroke-width="2" which clashed visually with
  // the chrome cluster icons (1.75). r13 normalized.
  const sec = HTML.slice(HTML.indexOf('id="plan-changed-files-section"'));
  const acceptIdx = sec.indexOf('id="plan-changed-files-accept-all"');
  const acceptBlock = sec.slice(acceptIdx, acceptIdx + 600);
  assert.ok(/stroke-width="1\.75"/.test(acceptBlock),
    'Accept-all SVG must use stroke-width="1.75" to match the chrome cluster family');
  const rejectIdx = sec.indexOf('id="plan-changed-files-reject-all"');
  const rejectBlock = sec.slice(rejectIdx, rejectIdx + 600);
  assert.ok(/stroke-width="1\.75"/.test(rejectBlock),
    'Reject-all SVG must use stroke-width="1.75" to match the chrome cluster family');
});

t('styles.css: pcf-row-btn is a square chrome-style button with sized SVG', () => {
  // Anchor on the line-starting base rule.
  const m = CSS.match(/\n\.pcf-row-btn\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '.pcf-row-btn rule must exist');
  const block = m[0];
  // Square dimensions + dark glass + subtle border = mini chrome button.
  assert.ok(/width:\s*\d+px/.test(block) && /height:\s*\d+px/.test(block),
    'pcf-row-btn must declare an explicit square width + height');
  assert.ok(/border-radius/.test(block),
    'pcf-row-btn must have border-radius (chrome family uses rounded squares)');
  // Inner SVG sized via a child selector (not the SVG's own width attr).
  assert.ok(/\.pcf-row-btn\s+\.ft-svg\s*\{[\s\S]{0,200}width:\s*\d+px/.test(CSS),
    '.pcf-row-btn .ft-svg child rule must size the icon (consistent with chrome-icon-svg)');
});

t('app.js: _highlightDiffWithLang tracks post-change line numbers (data-line-no) + clickable class', () => {
  const idx = APP.search(/function\s+_highlightDiffWithLang\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/newLineNo/.test(win),
    'must maintain a post-change line counter for per-line comment marker');
  assert.ok(/data-line-no=/.test(win),
    'must attach data-line-no to clickable lines');
  assert.ok(/pcf-line-clickable/.test(win),
    'add + context lines must get .pcf-line-clickable when !readOnly');
  assert.ok(/\\\+\(\\d\+\)/.test(win) || /\+\(\\d\+\)/.test(win),
    'must parse the +<start>,<count> segment of the @@ hunk header to seed the counter');
});

t('app.js: _renderInlineDiffBody includes the reconsider form (file-level)', () => {
  const idx = APP.search(/function\s+_renderInlineDiffBody\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/pcf-reconsider/.test(win),
    'inline diff must include a .pcf-reconsider form below the diff');
  assert.ok(/pcf-reconsider-input/.test(win),
    'reconsider form must contain a .pcf-reconsider-input textarea');
  assert.ok(/_bindDiffInteractions/.test(win),
    'must invoke _bindDiffInteractions after the innerHTML write to wire submit + per-line clicks');
});

t('app.js: _sendReconsider passes optional lineNo through to /files/reconsider', () => {
  const idx = APP.search(/async\s+function\s+_sendReconsider\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/files\/reconsider/.test(win),
    'must POST to /files/reconsider');
  assert.ok(/lineNo/.test(win),
    'must include the lineNo when provided');
});

t('index.html: header includes accept-all + reject-all buttons', () => {
  assert.ok(/id="plan-changed-files-accept-all"/.test(HTML),
    'header must include the Accept-all button');
  assert.ok(/id="plan-changed-files-reject-all"/.test(HTML),
    'header must include the Reject-all button');
});

t('styles.css: pcf-row-btn + pcf-bulk-btn + pcf-reconsider + pcf-line-comment classes defined', () => {
  for (const cls of [
    'pcf-row-btn', 'pcf-bulk-btn',
    'pcf-reconsider', 'pcf-reconsider-input', 'pcf-reconsider-send',
    'pcf-line-clickable', 'pcf-line-comment', 'pcf-line-form', 'pcf-line-input',
    'pcf-line-cancel', 'pcf-line-send',
  ]) {
    assert.ok(new RegExp('\\.' + cls + '\\b').test(CSS),
      `.${cls} CSS rule must be defined`);
  }
});

// ──────────────────────────────────────────────────────────────────────
// fr-77 r11 — visible decorator between plan items and Changed-files
// ──────────────────────────────────────────────────────────────────────

t('styles.css: fr-77 r11 — section has a visible border-top divider (>=2px, accent color, not the 8% near-invisible)', () => {
  // Anchor on the line-starting standalone rule.
  const m = CSS.match(/\n#plan-changed-files-section\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '#plan-changed-files-section base rule must exist');
  const block = m[0];
  // Border must be at least 2px (the old 1px @ 8% opacity was invisible
  // against the dark theme — users could not see where the section started).
  assert.ok(/border-top:\s*[2-9]\d*px/.test(block),
    'border-top must be ≥2px so the divider is visible (was: 1px @ 8% — invisible)');
  // And there must be breathing room above the section so it visually
  // lifts off the plan items.
  assert.ok(/margin-top:\s*\d+px/.test(block),
    'margin-top must add breathing room above the section');
});

t('styles.css: fr-77 r11 — section header has a tinted background band', () => {
  // Anchor on the line-starting standalone header rule.
  const m = CSS.match(/\n#plan-changed-files-header\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '#plan-changed-files-header rule must exist');
  const block = m[0];
  // Header must have its own background (transparent in r3-r10 → looked
  // like the rest of the section, no visible band).
  assert.ok(/background:\s*rgba/.test(block) || /background:\s*#/.test(block),
    'header must have a non-transparent background so it reads as a panel band');
});

// ──────────────────────────────────────────────────────────────────────
// fr-77 r7 — per-language syntax highlight inside the inline diff
// ──────────────────────────────────────────────────────────────────────

t('app.js: _diffLangForPath + _highlightDiffWithLang defined', () => {
  assert.ok(/function\s+_diffLangForPath\s*\(/.test(APP),
    '_diffLangForPath helper must be defined');
  assert.ok(/function\s+_highlightDiffWithLang\s*\(/.test(APP),
    '_highlightDiffWithLang helper must be defined');
});

t('app.js: _diffLangForPath reuses hljsLangForExt + handles Dockerfile/Makefile basenames', () => {
  const idx = APP.search(/function\s+_diffLangForPath\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/hljsLangForExt\s*\(/.test(win),
    'must consult the existing extension→language map');
  assert.ok(/Dockerfile/i.test(win),
    'must recognise Dockerfile basename');
  assert.ok(/Makefile/i.test(win),
    'must recognise Makefile basename');
});

t('app.js: _highlightDiffWithLang classifies meta / hunk / add / rm / ctx', () => {
  const idx = APP.search(/function\s+_highlightDiffWithLang\s*\(/);
  const win = sliceFn(APP, idx);
  for (const cls of ['pcf-diff-meta', 'pcf-diff-hunk', 'pcf-diff-add', 'pcf-diff-rm', 'pcf-diff-ctx']) {
    assert.ok(win.includes(cls),
      `line classifier must emit ${cls}`);
  }
  // Marker span + code span split — so per-line bg tint isn't
  // confused by hljs colors on the +/- character itself.
  assert.ok(/pcf-diff-marker/.test(win),
    'marker character must live in its own .pcf-diff-marker span');
  assert.ok(/pcf-diff-code/.test(win),
    'code body must live in its own .pcf-diff-code span');
  // Metadata recognition covers the common git-diff preamble lines.
  for (const prefix of ['diff --git', 'index ', '--- ', '+++ ', 'new file', 'deleted file', '@@']) {
    assert.ok(win.includes(prefix),
      `meta/hunk classifier must check for ${JSON.stringify(prefix)}`);
  }
});

t('app.js: _highlightDiffWithLang calls hljs.highlight per line with detected language', () => {
  const idx = APP.search(/function\s+_highlightDiffWithLang\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/window\.hljs\.highlight\s*\(/.test(win),
    'must call window.hljs.highlight per line for syntax tokens');
  assert.ok(/getLanguage\s*\(/.test(win),
    'must check hljs.getLanguage(lang) before highlighting (graceful fallback)');
  assert.ok(/ignoreIllegals/.test(win),
    'must pass ignoreIllegals: true so a one-line snippet does not throw');
});

t('app.js: _renderInlineDiffBody wires the per-language highlighter (not the old language-diff block)', () => {
  const idx = APP.search(/function\s+_renderInlineDiffBody\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/_highlightDiffWithLang\s*\(/.test(win),
    '_renderInlineDiffBody must call _highlightDiffWithLang');
  assert.ok(/_diffLangForPath\s*\(/.test(win),
    'must pick language via _diffLangForPath(body.path)');
  // The old code-language-diff hljs path should be GONE.
  assert.ok(!/code\.language-diff/.test(win),
    'old whole-block language-diff hljs path must be removed');
});

t('styles.css: per-line diff classes defined (.pcf-diff-line / -add / -rm / -hunk / -meta + marker + code)', () => {
  for (const cls of [
    'pcf-diff-pre', 'pcf-diff-line', 'pcf-diff-marker', 'pcf-diff-code',
    'pcf-diff-add', 'pcf-diff-rm', 'pcf-diff-ctx', 'pcf-diff-hunk', 'pcf-diff-meta',
  ]) {
    assert.ok(new RegExp('\\.' + cls + '\\b').test(CSS),
      `.${cls} CSS rule must be defined`);
  }
});

// ──────────────────────────────────────────────────────────────────────
// fr-77 r6 — per-file line-count chips (+N / −M)
// ──────────────────────────────────────────────────────────────────────

await tAsync('fr-77 r6 server: each entry carries added + removed line counts', async () => {
  const root = mkTempRepo();
  try {
    // Tracked modification: 1 line added, 1 line removed (replace contents).
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello modified\n');
    // Tracked deletion: 1 line removed.
    fs.unlinkSync(path.join(root, 'b.txt'));
    // Untracked add: 3 lines added.
    fs.writeFileSync(path.join(root, 'c.txt'), 'one\ntwo\nthree\n');
    delete require.cache[require.resolve('../server/src/files')];
    const filesMod = require('../server/src/files');
    const out = await filesMod.listChangedFiles(root);
    const byPath = new Map(out.entries.map((e) => [e.path, e]));
    const a = byPath.get('a.txt');
    const b = byPath.get('b.txt');
    const c = byPath.get('c.txt');
    assert.ok(a, 'a.txt entry present');
    assert.strictEqual(a.added, 1, `a.txt added expected 1, got ${a.added}`);
    assert.strictEqual(a.removed, 1, `a.txt removed expected 1, got ${a.removed}`);
    assert.ok(b, 'b.txt entry present');
    assert.strictEqual(b.added, 0);
    assert.strictEqual(b.removed, 1, `b.txt removed expected 1, got ${b.removed}`);
    assert.ok(c, 'c.txt entry present');
    assert.strictEqual(c.added, 3, `untracked c.txt added expected 3, got ${c.added}`);
    assert.strictEqual(c.removed, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await tAsync('fr-77 r6 server: binary file reports null added/removed (numstat -/-)', async () => {
  const root = mkTempRepo();
  try {
    // Create a tiny binary blob + commit, then modify it. git diff
    // --numstat will emit `-\t-\tbin.dat` for binaries.
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0,1,2,0,3,4,5]));
    execFileSync('git', ['-C', root, 'add', 'bin.dat']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'add bin']);
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([9,8,7,0,6,5,4,3,2,1]));
    delete require.cache[require.resolve('../server/src/files')];
    const filesMod = require('../server/src/files');
    const out = await filesMod.listChangedFiles(root);
    const bin = out.entries.find((e) => e.path === 'bin.dat');
    assert.ok(bin, 'bin.dat entry present');
    assert.strictEqual(bin.added, null,
      'binary file must report added=null so UI shows "bin" badge');
    assert.strictEqual(bin.removed, null,
      'binary file must report removed=null');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

t('app.js: _planChangedFileStatsHtml renders +N / −M chips + bin badge', () => {
  assert.ok(/function\s+_planChangedFileStatsHtml\s*\(/.test(APP),
    '_planChangedFileStatsHtml helper must be defined');
  const idx = APP.search(/function\s+_planChangedFileStatsHtml\s*\(/);
  const win = sliceFn(APP, idx);
  // Bin badge for null/null.
  assert.ok(/pcf-stats-bin/.test(win),
    'null counts must render a .pcf-stats-bin badge');
  // +N for additions; −M for removals; using minus or hyphen.
  assert.ok(/pcf-stats-add/.test(win) && /\+\$\{a\}/.test(win),
    'positive added must render as .pcf-stats-add with +N');
  assert.ok(/pcf-stats-rm/.test(win),
    'positive removed must render as .pcf-stats-rm');
  // 0/0 returns empty string (no clutter on mode-only changes).
  assert.ok(/a\s*===\s*0\s*&&\s*r\s*===\s*0[\s\S]{0,80}return\s+['"]['"]/.test(win),
    '0/0 must short-circuit to empty string');
});

t('app.js: _renderPlanChangedFiles list items include the stats chip', () => {
  const idx = APP.search(/function\s+_renderPlanChangedFiles\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/_planChangedFileStatsHtml\s*\(/.test(win),
    'row HTML must invoke _planChangedFileStatsHtml');
});

t('styles.css: .pcf-stats / .pcf-stats-add / .pcf-stats-rm / .pcf-stats-bin defined', () => {
  for (const cls of ['pcf-stats', 'pcf-stats-add', 'pcf-stats-rm', 'pcf-stats-bin']) {
    assert.ok(new RegExp('\\.' + cls + '\\b').test(CSS),
      `.${cls} CSS rule must be defined`);
  }
});

// ──────────────────────────────────────────────────────────────────────
// fr-77 r4 — vertical drag-to-resize on the Plan changed-files section
// ──────────────────────────────────────────────────────────────────────

t('index.html: #plan-changed-files-resize handle present at top of section', () => {
  assert.ok(/id="plan-changed-files-resize"/.test(HTML),
    '#plan-changed-files-resize handle must exist');
  // It must sit INSIDE the section AND before the header (top edge).
  const secIdx = HTML.indexOf('id="plan-changed-files-section"');
  const handleIdx = HTML.indexOf('id="plan-changed-files-resize"', secIdx);
  const headerIdx = HTML.indexOf('id="plan-changed-files-header"', secIdx);
  assert.ok(handleIdx > -1 && handleIdx < headerIdx,
    'resize handle must sit at the top of the section, before the header');
});

t('styles.css: .pcf-resize-handle has cursor row-resize + touch-action none', () => {
  // Anchor on the line-starting base rule (not the .is-collapsed
  // descendant selector earlier in the file).
  const m = CSS.match(/\n\.pcf-resize-handle\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '.pcf-resize-handle base rule must be defined');
  const block = m[0];
  assert.ok(/cursor:\s*row-resize/.test(block),
    'resize handle must use row-resize cursor');
  assert.ok(/touch-action:\s*none/.test(block),
    'resize handle must set touch-action:none so touch-drag does not scroll the page');
});

t('styles.css: section has fixed height (not max-height) with min/max bounds', () => {
  // Anchor on the line-starting standalone rule.
  const m = CSS.match(/\n#plan-changed-files-section\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '#plan-changed-files-section base rule must exist');
  const block = m[0];
  // r4 switched from max-height → height so the drag can grow the section.
  assert.ok(/\bheight:\s*\d+vh/.test(block),
    'section must use explicit `height` (not just max-height) so JS can override');
  assert.ok(/min-height:\s*\d+px/.test(block),
    'section must declare a min-height bound for the drag');
  assert.ok(/max-height:\s*\d+vh/.test(block),
    'section must declare a max-height bound for the drag');
});

t('styles.css: .is-collapsed hides the resize handle', () => {
  // No reason to expose a drag handle when there is nothing to resize.
  assert.ok(
    /#plan-changed-files-section\.is-collapsed\s+\.pcf-resize-handle\s*\{[\s\S]{0,80}display:\s*none/.test(CSS),
    'collapsed section must hide the resize handle');
});

t('app.js: bindPlanChangedFilesResize defined + wired into bindPlanChangedFilesUi', () => {
  assert.ok(/function\s+bindPlanChangedFilesResize\s*\(/.test(APP),
    'bindPlanChangedFilesResize must be defined');
  // Must be invoked from bindPlanChangedFilesUi so the resize wires up
  // alongside the rest of the section's bindings on first plan-show.
  const idx = APP.search(/function\s+bindPlanChangedFilesUi\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/bindPlanChangedFilesResize\(/.test(win),
    'bindPlanChangedFilesUi must call bindPlanChangedFilesResize');
});

t('app.js: resize handler uses pointer events + persists to localStorage', () => {
  const idx = APP.search(/function\s+bindPlanChangedFilesResize\s*\(/);
  assert.ok(idx > -1);
  const win = sliceFn(APP, idx);
  // Pointer events — works for both mouse + touch.
  assert.ok(/addEventListener\(['"]pointerdown['"]/.test(win),
    'must bind pointerdown on the handle');
  assert.ok(/addEventListener\(['"]pointermove['"]/.test(win),
    'must bind pointermove on the handle');
  assert.ok(/addEventListener\(['"]pointerup['"]/.test(win),
    'must bind pointerup on the handle');
  // Persistence under a specific key (so the choice survives reloads).
  assert.ok(/myco_plan_changed_h/.test(win),
    'must persist the chosen height under localStorage key myco_plan_changed_h');
  assert.ok(/localStorage\.setItem/.test(win),
    'must call localStorage.setItem on drag end');
  assert.ok(/localStorage\.getItem/.test(win),
    'must call localStorage.getItem to restore on bind');
});

t('app.js: resize clamps to MIN + viewport-fraction MAX', () => {
  const idx = APP.search(/function\s+bindPlanChangedFilesResize\s*\(/);
  const win = sliceFn(APP, idx);
  // MIN constant + Math.max/min clamp.
  assert.ok(/MIN_PX/.test(win) || /Math\.max\([^)]*\d+/.test(win),
    'must declare a MIN bound (≥60px) to keep the handle reachable');
  assert.ok(/window\.innerHeight/.test(win),
    'must derive MAX from window.innerHeight so we never grow past viewport');
  assert.ok(/Math\.min\s*\(/.test(win),
    'must clamp the new height with Math.min against the MAX');
});

t('app.js: double-click on handle resets to CSS default (clears inline height + saved value)', () => {
  const idx = APP.search(/function\s+bindPlanChangedFilesResize\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/addEventListener\(['"]dblclick['"]/.test(win),
    'must bind dblclick on the handle');
  // The dblclick handler must clear sec.style.height AND remove the
  // saved value so the next reload uses the stylesheet default.
  assert.ok(/style\.height\s*=\s*['"]['"]|style\.removeProperty\(['"]height['"]/.test(win),
    'dblclick must clear the inline height (style.height = "" or removeProperty)');
  assert.ok(/localStorage\.removeItem\([^)]*myco_plan_changed_h/.test(win) ||
            /removeItem\(\s*STORAGE_KEY\s*\)/.test(win),
    'dblclick must remove the saved value from localStorage');
});

t('app.js: stale fr-77 r1/r2 symbols removed (openFileDiffViewer / _renderDiffViewerBody / loadFilesChanged / _renderFilesChanged)', () => {
  // Comments stripped so a leftover "// see openFileDiffViewer" doesn't
  // false-positive — we want to assert the actual symbol is gone.
  const code = APP.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\bopenFileDiffViewer\b/.test(code),
    'openFileDiffViewer must be removed (r3 replaced right-pane viewer with inline expand)');
  assert.ok(!/\b_renderDiffViewerBody\b/.test(code),
    '_renderDiffViewerBody must be removed');
  assert.ok(!/\bloadFilesChanged\b/.test(code),
    'loadFilesChanged must be removed (renamed to loadPlanChangedFiles)');
  assert.ok(!/\b_renderFilesChanged\b/.test(code),
    '_renderFilesChanged must be removed (renamed to _renderPlanChangedFiles)');
  assert.ok(!/files-changed-(list|desc|count|msg|section|header|title|refresh|collapse)/.test(code),
    'all files-changed-* element IDs must be gone (renamed to plan-changed-files-*)');
});

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
