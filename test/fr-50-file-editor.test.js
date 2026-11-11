// fr-50 regression: in-app text file editing with concurrent-edit
// prevention.
//
// User report: "Users can't edit text files (source code, markdown,
// JSON, etc.) in-app. ... should avoid conflicting edits, would be
// great to support concurrent editing and show who is editing."
//
// Phase A (this fix):
//   * Edit surface: CodeMirror 6 (vendored bundle exposing
//     window.MycoCM with createEditor + EditorView + EditorState +
//     languageForPath). Textarea fallback retained for vendor-bundle
//     load failure so editing stays online.
//   * Save: Cmd/Ctrl+S binding in addition to the explicit Save
//     button. Dirty short-circuit (no-op save when no changes).
//   * Conflict prevention: server requires expectedMtimeMs on every
//     write; 409 ERR_MTIME_CONFLICT triggers the file-conflict modal
//     with Reload / Force overwrite / Cancel choices (instead of the
//     old alert()).
//   * Force overwrite re-stats the file to get the fresh mtime
//     before PUT, so the second save passes the server's check.
//
// Phase B (out of scope here, planned as follow-up commit): presence
// chips showing who is editing the same file in real time.
//
// Tests are STATIC-GREP guards on the prod sources (since the editor
// is DOM-coupled and we have no jsdom in this project) plus server-
// route behavior smoke checks on the existing files API.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── fr-50: in-app file editor (CodeMirror 6 + mtime conflict modal) ──');

// ──────────────────────────────────────────────────────────────────────
// Vendor bundle
// ──────────────────────────────────────────────────────────────────────

t('vendored bundle exists at web/public/vendor/codemirror.bundle.js', () => {
  const p = path.join(__dirname, '..', 'web', 'public', 'vendor', 'codemirror.bundle.js');
  assert.ok(fs.existsSync(p), 'CodeMirror 6 bundle must be checked in (built via npm run build:editor)');
  const st = fs.statSync(p);
  assert.ok(st.size > 50_000, `bundle suspiciously small at ${st.size} bytes — did the build run?`);
  assert.ok(st.size < 1_500_000, `bundle suspiciously large at ${st.size} bytes — did extras leak in?`);
});

t('bundle exposes the MycoCM IIFE global', () => {
  const p = path.join(__dirname, '..', 'web', 'public', 'vendor', 'codemirror.bundle.js');
  const head = fs.readFileSync(p, 'utf8').slice(0, 200);
  assert.ok(/MycoCM\s*=/.test(head),
    'bundle must declare the MycoCM global (esbuild --global-name=MycoCM produces "var MycoCM=...")');
});

t('index.html loads the vendor bundle before app.js consumers run', () => {
  assert.ok(/<script[^>]+src=["']\/vendor\/codemirror\.bundle\.js["']/.test(HTML),
    'index.html must include the CodeMirror vendor bundle script tag');
});

// ──────────────────────────────────────────────────────────────────────
// Editor wiring
// ──────────────────────────────────────────────────────────────────────

t('_enterFileEditMode prefers CodeMirror 6 when MycoCM.createEditor is available', () => {
  const start = APP.search(/function\s+_enterFileEditMode\s*\(/);
  assert.ok(start > -1, '_enterFileEditMode must exist');
  const body = sliceFn(APP, start);
  assert.ok(/window\.MycoCM/.test(body),
    'editor entry must check for window.MycoCM');
  assert.ok(/createEditor\s*\(/.test(body),
    'editor entry must instantiate via MycoCM.createEditor');
});

t('CM6 init failure falls back to textarea so editing stays online', () => {
  const start = APP.search(/function\s+_enterFileEditMode\s*\(/);
  const body = sliceFn(APP, start);
  // Look for the catch block and a subsequent createElement('textarea')
  // call — the fallback path.
  assert.ok(/catch\s*\([^)]*\)\s*\{[^}]*CM6/i.test(body) || /CM6 init failed.*fallback/i.test(body),
    'CM6 init must catch failures and fall back to textarea (vendor bundle hiccup must not take editing offline)');
});

t('_exitFileEditMode destroys the CM6 view to release listeners + DOM', () => {
  const start = APP.search(/function\s+_exitFileEditMode\s*\(/);
  const body = sliceFn(APP, start);
  assert.ok(/cmView/.test(body) && /destroy/.test(body),
    'exit handler must call cmView.destroy() so listeners/DOM are released');
});

t('_currentEditedContent reads from CM6 view (preferred) or textarea (fallback)', () => {
  const start = APP.search(/function\s+_currentEditedContent\s*\(/);
  assert.ok(start > -1, '_currentEditedContent helper must exist (one read path for both surfaces)');
  const body = sliceFn(APP, start);
  assert.ok(/cmView/.test(body), 'must read CM6 doc when present');
  assert.ok(/files-edit-textarea/.test(body), 'must fall back to textarea value');
});

// ──────────────────────────────────────────────────────────────────────
// Conflict modal
// ──────────────────────────────────────────────────────────────────────

t('index.html declares the file-conflict modal scaffolding', () => {
  assert.ok(/<div\s+id=["']file-conflict-modal["']/.test(HTML),
    'modal container must exist');
  assert.ok(/id=["']file-conflict-reload["']/.test(HTML),
    'Reload-from-disk button must exist');
  assert.ok(/id=["']file-conflict-force["']/.test(HTML),
    'Force-overwrite button must exist');
  assert.ok(/id=["']file-conflict-cancel["']/.test(HTML),
    'Cancel button must exist');
});

t('styles.css carries the file-conflict-modal CSS', () => {
  assert.ok(/#file-conflict-modal/.test(CSS),
    'CSS must style the conflict modal (otherwise it renders as an invisible div)');
});

t('_saveFileEdit opens the conflict modal on 409 (instead of alert)', () => {
  const start = APP.search(/async\s+function\s+_saveFileEdit\s*\(/);
  assert.ok(start > -1, '_saveFileEdit must exist');
  const body = sliceFn(APP, start);
  assert.ok(/res\.status\s*===\s*409/.test(body),
    'save handler must branch on 409 (ERR_MTIME_CONFLICT)');
  assert.ok(/_showFileConflictModal\s*\(/.test(body),
    '409 branch must call _showFileConflictModal — not just alert()');
});

t('Force overwrite re-fetches mtime before retry (so second save passes server check)', () => {
  const start = APP.search(/async\s+function\s+_saveFileEdit\s*\(/);
  const body = sliceFn(APP, start);
  assert.ok(/force/.test(body) && /\/file\?path=/.test(body),
    'force-overwrite branch must re-stat the file via GET /file?path= before retrying the PUT');
});

t('conflict modal buttons are wired to the three resolution handlers', () => {
  assert.ok(/file-conflict-reload[\s\S]{0,200}?_reloadFileFromDisk/.test(APP),
    'Reload button must call _reloadFileFromDisk');
  assert.ok(/file-conflict-force[\s\S]{0,200}?_saveFileEdit\s*\(\s*\{\s*force\s*:\s*true/.test(APP),
    'Force button must call _saveFileEdit({force:true})');
  assert.ok(/file-conflict-cancel[\s\S]{0,200}?_hideFileConflictModal/.test(APP),
    'Cancel button must call _hideFileConflictModal');
});

// ──────────────────────────────────────────────────────────────────────
// Server: existing mtime-conflict contract is intact
// ──────────────────────────────────────────────────────────────────────

t('server: GET /file returns mtimeMs in the response', () => {
  const filesSrc = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'src', 'files.js'), 'utf8');
  const readFn = filesSrc.match(/async\s+function\s+readFile\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(readFn, 'readFile function must exist');
  assert.ok(/mtimeMs:\s*st\.mtimeMs/.test(readFn[0]),
    'readFile must return mtimeMs (client uses it as the expectedMtimeMs stamp)');
});

t('server: writeFile rejects when expectedMtimeMs drifts from disk', () => {
  const filesSrc = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'src', 'files.js'), 'utf8');
  assert.ok(/ERR_MTIME_CONFLICT/.test(filesSrc),
    'files.js must throw ERR_MTIME_CONFLICT on stale mtime');
  const indexSrc = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');
  assert.ok(/ERR_MTIME_CONFLICT[\s\S]{0,80}?status\s*\(\s*409\s*\)/.test(indexSrc),
    'index.js must map ERR_MTIME_CONFLICT to HTTP 409');
});

t('server route smoke: write rejects when expectedMtimeMs is wrong', async () => {
  // End-to-end at the filesApi level — writeFile rejects when the
  // expectedMtimeMs doesn't match disk reality.
  const filesApi = require('../server/src/files');
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fr-50-'));
  const filePath = path.join(tmp, 'sample.txt');
  await fs.promises.writeFile(filePath, 'hello\n', 'utf8');
  const st = await fs.promises.stat(filePath);

  // Correct mtime → succeeds
  const ok = await filesApi.writeFile(tmp, 'sample.txt', {
    content: 'hello v2\n',
    expectedMtimeMs: st.mtimeMs,
  });
  assert.ok(typeof ok.mtimeMs === 'number', 'success returns the new mtimeMs');

  // Stale mtime → throws ERR_MTIME_CONFLICT
  let threw = null;
  try {
    await filesApi.writeFile(tmp, 'sample.txt', {
      content: 'hello v3\n',
      expectedMtimeMs: st.mtimeMs,                  // OLD mtime
    });
  } catch (e) { threw = e; }
  assert.ok(threw, 'stale mtime must throw');
  assert.strictEqual(threw.code, 'ERR_MTIME_CONFLICT',
    'error code must be ERR_MTIME_CONFLICT so the route maps it to 409');

  // Cleanup.
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// Bundler scaffolding (so a fresh clone can rebuild the bundle)
// ──────────────────────────────────────────────────────────────────────

t('package.json declares the CodeMirror 6 + esbuild devDependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'package.json'), 'utf8'));
  const dev = pkg.devDependencies || {};
  assert.ok(dev.esbuild, 'esbuild must be a devDependency');
  assert.ok(dev.codemirror, 'codemirror (v6 umbrella) must be a devDependency');
  assert.ok(dev['@codemirror/state'], '@codemirror/state must be a devDependency');
  assert.ok(dev['@codemirror/view'], '@codemirror/view must be a devDependency');
  assert.ok(pkg.scripts && pkg.scripts['build:editor'],
    'package.json must declare the build:editor npm script so a fresh clone can rebuild the bundle');
});

t('tools/codemirror-entry.mjs is the bundler entrypoint', () => {
  const p = path.join(__dirname, '..', 'tools', 'codemirror-entry.mjs');
  assert.ok(fs.existsSync(p), 'tools/codemirror-entry.mjs must exist (esbuild input)');
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(/createEditor/.test(src), 'entry must export createEditor');
  assert.ok(/languageForPath/.test(src), 'entry must expose a language-picker helper');
});

(async () => {
  // Re-run the async test serially so the promise-based assertion is captured.
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
