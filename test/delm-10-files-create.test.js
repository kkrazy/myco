// delm-10: Files page "create file" / "create folder" regression test.
// Locks both halves of the feature:
//   SERVER — server/src/files.js exports createDir/createFile with
//     containment + no-clobber semantics (functional, run against a
//     tmp dir); server/src/index.js exposes POST
//     /sessions/:id/files/create-dir + create-file gated 'owner'.
//   CLIENT — web/public/index.html has the two header buttons;
//     app.js binds them (_filesCreatePrompt → _filesCreateEntry);
//     names are single-segment validated client-side; read-only
//     guests are blocked; styles.css styles the buttons.
// Run: node test/delm-10-files-create.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web/public/index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web/public/styles.css'), 'utf8');
const SRV = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');
const filesApi = require(path.join(ROOT, 'server/src/files.js'));

let passed = 0, failed = 0;
function t(name, fn) {
  const run = async () => {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
  };
  t._chain = (t._chain || Promise.resolve()).then(run);
}

process.on('exit', (code) => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0 && code === 0) process.exitCode = 1;
});

// ─── Server: functional behaviour on a tmp dir ───

t('files.js exports createDir + createFile', () => {
  assert.strictEqual(typeof filesApi.createDir, 'function', 'files.js must export createDir()');
  assert.strictEqual(typeof filesApi.createFile, 'function', 'files.js must export createFile()');
});

t('createDir makes a directory inside root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10-'));
  const out = await filesApi.createDir(root, 'newdir');
  assert.ok(out.created, 'createDir must report created:true');
  assert.ok(fs.statSync(path.join(root, 'newdir')).isDirectory(), 'directory must exist on disk');
  fs.rmSync(root, { recursive: true, force: true });
});

t('createFile writes an empty (or given) file; refuses to clobber', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10-'));
  const out = await filesApi.createFile(root, 'a.txt');
  assert.ok(out.created, 'createFile must report created:true');
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), '', 'default content must be empty');
  await assert.rejects(
    () => filesApi.createFile(root, 'a.txt'),
    (e) => e.code === 'ERR_EXISTS',
    'duplicate create must fail with ERR_EXISTS (never clobber)'
  );
  fs.rmSync(root, { recursive: true, force: true });
});

t('createDir duplicate → ERR_EXISTS; dir-on-file → ERR_EXISTS', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10-'));
  await filesApi.createDir(root, 'd');
  await assert.rejects(() => filesApi.createDir(root, 'd'), (e) => e.code === 'ERR_EXISTS');
  await filesApi.createFile(root, 'f.txt');
  await assert.rejects(() => filesApi.createDir(root, 'f.txt'), (e) => e.code === 'ERR_EXISTS');
  fs.rmSync(root, { recursive: true, force: true });
});

t('create* reject traversal + absolute paths + empty names', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10-'));
  await assert.rejects(() => filesApi.createDir(root, '../escape'), (e) => e.code === 'ERR_BAD_INPUT' || e.code === 'ERR_OUTSIDE');
  await assert.rejects(() => filesApi.createFile(root, '/etc/passwd-x'), (e) => e.code === 'ERR_OUTSIDE');
  await assert.rejects(() => filesApi.createDir(root, '  '), (e) => e.code === 'ERR_BAD_INPUT');
  fs.rmSync(root, { recursive: true, force: true });
});

// ─── Server: routes wired owner-only ───

t('index.js routes: POST files/create-dir + files/create-file, owner tier', () => {
  assert.ok(/app\.post\('\/sessions\/:id\/files\/create-dir'[\s\S]{0,400}fileApiPreamble\(req, res, 'owner'\)/.test(SRV),
    'create-dir route must exist and gate with fileApiPreamble(..., "owner")');
  assert.ok(/app\.post\('\/sessions\/:id\/files\/create-file'[\s\S]{0,400}fileApiPreamble\(req, res, 'owner'\)/.test(SRV),
    'create-file route must exist and gate with fileApiPreamble(..., "owner")');
});

// ─── Client: buttons + wiring ───

t('index.html has #files-new-folder + #files-new-file buttons', () => {
  assert.ok(/id="files-new-folder"/.test(HTML), 'files header must contain the new-folder button');
  assert.ok(/id="files-new-file"/.test(HTML), 'files header must contain the new-file button');
});

t('app.js binds both buttons in bindFilesUi', () => {
  assert.ok(/files-new-folder'\)\?\.addEventListener\('click', \(\) => _filesCreatePrompt\('dir'\)\)/.test(APP),
    'bindFilesUi must wire #files-new-folder → _filesCreatePrompt("dir")');
  assert.ok(/files-new-file'\)\?\.addEventListener\('click', \(\) => _filesCreatePrompt\('file'\)\)/.test(APP),
    'bindFilesUi must wire #files-new-file → _filesCreatePrompt("file")');
});

t('_filesCreateEntry POSTs to create-<kind> and refreshes the tree', () => {
  const at = APP.search(/async function _filesCreateEntry/);
  assert.ok(at > 0, '_filesCreateEntry must be defined');
  const body = APP.slice(at, at + 2200);
  assert.ok(/\/files\/create-\$\{kind\}/.test(body), 'must POST to /sessions/:id/files/create-${kind}');
  assert.ok(/loadFileTree\(state\.files\.currentPath \|\| '\.'\)/.test(body), 'must reload the tree after create');
  assert.ok(/ERR_EXISTS/.test(body), 'must surface ERR_EXISTS as a friendly message');
});

t('client validates single-segment names + blocks read-only guests', () => {
  const at = APP.search(/async function _filesCreateEntry/);
  const body = APP.slice(at, at + 1200);
  assert.ok(/name\.includes\('\/'\)/.test(body), 'names containing "/" must be rejected client-side');
  const promptAt = APP.search(/function _filesCreatePrompt/);
  const pbody = APP.slice(promptAt, promptAt + 900);
  assert.ok(/state\.readOnly/.test(pbody), '_filesCreatePrompt must guard read-only guests');
});

t('styles.css styles the new buttons', () => {
  assert.ok(/#files-new-folder[^{]*\{/.test(CSS), 'styles must target #files-new-folder');
  assert.ok(/#files-new-file[^{]*\{/.test(CSS), 'styles must target #files-new-file');
});
