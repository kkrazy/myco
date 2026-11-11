// whatsnew banner + modal ("功能上新") regression test.
//
// User request: "加个重要功能更新界面，最好一个 markdown 然后实时渲染，
// markdown 以前的也可以备份，每次都找最新版本的渲染，把 /model /fr @myco
// /run-n2 等功能展在页面上方（功能上新类似的字样），点击才会展开详情，
// 用户也可以选择关掉。"
//
// Contract under test (static shape — mirrors how other UI-contract
// tests in this repo work):
//   1. server: GET /whatsnew scans docs/whatsnew/*.md and serves the
//      lexicographically-latest file's markdown; GET /whatsnew/:version
//      serves archived versions. Old .md files stay in the dir as the
//      backup/history.
//   2. client: banner at top of #app announcing the latest version,
//      click opens a modal that renders the markdown via renderMd
//      (marked), with a version dropdown for archived files.
//   3. dismissal is per-version (localStorage 'myco_whatsnew_dismissed'),
//      so a NEW version id re-shows the banner.
//
// If this test fails, one of those three legs regressed.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function main() {
  const indexJs = read('server/src/index.js');
  const indexHtml = read('web/public/index.html');
  const appJs = read('web/public/app.js');
  const css = read('web/public/styles.css');

  // ── server: routes + directory scan + latest-wins ─────────────────
  // GET /whatsnew must exist and pick the lexicographically-LAST file
  // (naming convention YYYY-MM-DD-<slug>.md makes sort = chronological).
  assert.ok(/app\.get\('\/whatsnew'/.test(indexJs),
    "server must expose GET /whatsnew — the banner's data source");
  assert.ok(/app\.get\('\/whatsnew\/:version'/.test(indexJs),
    'server must expose GET /whatsnew/:version for the history dropdown');
  assert.ok(/WHATSNEW_DIR/.test(indexJs) && /docs['",\s]+whatsnew|'docs', 'whatsnew'/.test(indexJs),
    "server must scan the docs/whatsnew directory — versioned .md files are the content source");
  assert.ok(/versions\[versions\.length - 1\]/.test(indexJs),
    'latest version must be the lexicographically-last filename (files sort chronologically)');

  // Path-traversal guard: the :version route must validate against the
  // directory listing, never join a user-supplied path directly.
  {
    const at = indexJs.search(/function readWhatsnewVersion/);
    assert.ok(at !== -1, 'readWhatsnewVersion helper must exist in server/src/index.js');
    const body = indexJs.slice(at, indexJs.indexOf('\n}', at) + 2);
    assert.ok(/listWhatsnewVersions\(\)/.test(body) && /\.includes\(version \+ '\.md'\)/.test(body),
      'readWhatsnewVersion must whitelist the version against the directory listing (path-traversal guard)');
  }

  // ── content: at least one shipped version file ────────────────────
  {
    const dir = path.join(ROOT, 'docs', 'whatsnew');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    assert.ok(files.length >= 1,
      'docs/whatsnew must contain at least one .md file — the banner has nothing to announce otherwise');
    // Filename convention keeps sort == chronological; guard the prefix.
    for (const f of files) {
      assert.ok(/^\d{4}-\d{2}-\d{2}-/.test(f),
        `whatsnew file "${f}" must be named YYYY-MM-DD-<slug>.md so lexicographic sort is chronological`);
    }
  }

  // ── client markup: banner + modal + sidebar entry ─────────────────
  assert.ok(/id="whatsnew-banner"/.test(indexHtml),
    'index.html must contain the #whatsnew-banner strip (the 页面上方 announcement)');
  assert.ok(/id="whatsnew-modal"/.test(indexHtml),
    'index.html must contain the #whatsnew-modal detail dialog');
  assert.ok(/id="whatsnew-version-select"/.test(indexHtml),
    'index.html must contain the #whatsnew-version-select history dropdown');
  assert.ok(/id="btn-whatsnew"/.test(indexHtml),
    'index.html must contain the #btn-whatsnew sidebar icon — the permanent entry after banner dismissal');

  // ── client logic: per-version dismissal + marked rendering ────────
  assert.ok(/WHATSNEW_DISMISS_KEY = 'myco_whatsnew_dismissed'/.test(appJs),
    "app.js must key banner dismissal on localStorage 'myco_whatsnew_dismissed' (per-version)");
  assert.ok(/meta\.version === dismissedWhatsnewVersion\(\)/.test(appJs),
    'initWhatsnewBanner must compare the served version id against the dismissed one — a new version must re-show the banner');
  {
    const at = appJs.search(/async function renderWhatsnewVersionInto/);
    assert.ok(at !== -1, 'renderWhatsnewVersionInto must exist in app.js');
    const body = appJs.slice(at, appJs.indexOf('\n}', at) + 2);
    assert.ok(/renderMd\(/.test(body),
      'renderWhatsnewVersionInto must render markdown through the existing renderMd (marked) pipeline — no separate markdown renderer');
    assert.ok(/\/whatsnew\/' \+ encodeURIComponent\(version\)/.test(body),
      'version fetch must encodeURIComponent the version id');
  }
  assert.ok(/function dismissWhatsnewBanner/.test(appJs),
    'dismissWhatsnewBanner must exist — the user-facing ✕ "关掉" affordance');
  assert.ok(/initWhatsnewBanner\(\)/.test(appJs),
    'initWhatsnewBanner must be invoked at boot so the banner appears without user action');

  // ── styles: banner row + modal reuse ──────────────────────────────
  assert.ok(/#app\.has-whatsnew/.test(css),
    'styles.css must switch #app to column flex when the banner is visible (#app.has-whatsnew)');
  assert.ok(/#whatsnew-modal/.test(css) && /#whatsnew-dialog/.test(css),
    'styles.css must style the whatsnew modal (shares the manual modal layout)');
  assert.ok(/#whatsnew-banner \{/.test(css),
    'styles.css must style the #whatsnew-banner strip');
  // bug-44-class guard: a sidebar button whose icon isn't in the
  // .sidebar-icon-svg sizing rule collapses to a sliver.
  assert.ok(/#btn-whatsnew \.sidebar-icon-svg/.test(css),
    'styles.css must size the #btn-whatsnew sidebar icon (bug-44-class regression: unsized SVG collapses)');

  console.log('whatsnew-banner.test: all assertions passed');
}

main();
