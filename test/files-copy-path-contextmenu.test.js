// td-copy-path: Files-page right-click "copy path" context menu.
// Static-grep guards pinning the client contract:
//   1. renderFilesList binds a `contextmenu` listener on each tree
//      <li> that calls _openFilesContextMenu with the entry path.
//   2. _openFilesContextMenu builds Copy relative / Copy absolute /
//      Download items; absolute path = session abs_cwd (fallback cwd)
//      joined with the relative path.
//   3. Clipboard write uses navigator.clipboard with a legacy
//      execCommand fallback (plain-HTTP LAN deployments aren't a
//      secure context).
//   4. Menu dismisses on outside click + Escape.
//   5. CSS: .files-ctx-menu / .fcx-item styles exist.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web/public/styles.css'), 'utf8');

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

// 1. Tree entries get a contextmenu listener.
t('renderFilesList binds contextmenu on li[data-name]', () => {
  assert.ok(
    /li\.addEventListener\('contextmenu'[\s\S]{0,300}_openFilesContextMenu\(/.test(APP),
    'renderFilesList must addEventListener("contextmenu") on each li and call _openFilesContextMenu(ev, path)'
  );
});

t('contextmenu handler preventDefaults the native browser menu', () => {
  const m = APP.match(/li\.addEventListener\('contextmenu',\s*\((ev)\)\s*=>\s*\{[\s\S]{0,400}?\}\);/);
  assert.ok(m, 'contextmenu listener not found on tree li');
  assert.ok(/preventDefault\(\)/.test(m[0]), 'contextmenu handler must preventDefault so the browser menu is replaced');
});

// 2. Menu items + absolute path resolution.
t('menu renders Copy relative + Copy absolute items', () => {
  assert.ok(/data-fcx="rel"/.test(APP), 'menu must contain a data-fcx="rel" Copy-relative item');
  assert.ok(/data-fcx="abs"/.test(APP), 'menu must contain a data-fcx="abs" Copy-absolute item');
});

t('absolute path prefixes the session abs_cwd (fallback cwd)', () => {
  assert.ok(
    /function _sessionAbsRoot\(\)[\s\S]{0,300}s\.abs_cwd \|\| s\.cwd/.test(APP),
    '_sessionAbsRoot must resolve s.abs_cwd || s.cwd for the active session'
  );
  assert.ok(
    /absRoot\.replace\(\/\\\/\+\$\/,\s*''\)\s*\+\s*'\/'\s*\+\s*relChild/.test(APP),
    'absolute path must be absRoot (trailing slash stripped) + "/" + relChild'
  );
});

t('download item only for files', () => {
  const m = APP.match(/isFile\s*\?[\s\S]{0,120}data-fcx="download"/);
  assert.ok(m, 'data-fcx="download" item must be gated on isFile');
});

// 3. Clipboard fallback.
t('clipboard write has a non-secure-context fallback', () => {
  assert.ok(/navigator\.clipboard/.test(APP), 'must use navigator.clipboard');
  assert.ok(/_copyTextLegacy/.test(APP) && /execCommand\('copy'\)/.test(APP),
    'must fall back to a textarea + execCommand("copy") when clipboard API is unavailable (plain HTTP)');
});

// 4. Dismissal.
t('menu dismisses on outside click and Escape', () => {
  assert.ok(/Escape/.test(APP) && /_closeFilesContextMenu/.test(APP),
    'Escape key must close the menu via _closeFilesContextMenu');
  const m = APP.match(/document\.addEventListener\('click',\s*\(e\)\s*=>\s*\{[\s\S]{0,200}closest\('#files-ctx-menu'\)/);
  assert.ok(m, 'a global click listener must close the menu when the click lands outside #files-ctx-menu');
});

// 5. CSS.
t('CSS styles .files-ctx-menu and .fcx-item', () => {
  assert.ok(/\.files-ctx-menu\s*\{/.test(CSS), '.files-ctx-menu rule missing from styles.css');
  assert.ok(/\.files-ctx-menu \.fcx-item\s*\{/.test(CSS), '.files-ctx-menu .fcx-item rule missing from styles.css');
  assert.ok(/\.files-ctx-menu\[hidden\]/.test(CSS), 'menu must be display:none when [hidden]');
});
