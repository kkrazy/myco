// mcp-market UI regression test (static contract, delm pattern).
// Locks the Skills panel's MCP tab wiring in web/public:
//   HTML    — #skills-tab-mcp tab button inside the skills tablist,
//     #mcp-market-list card grid + #mcp-market-detail preview pane.
//   APP.JS  — _skillsSetTab recognizes the 'mcp' tab (toggles the
//     list/detail panes), _skillsRefresh routes 'mcp' to
//     _mcpMarketLoad, install/uninstall POST to
//     /sessions/:id/mcp-market/{install,uninstall} with {name},
//     detail GETs /mcp-market/:name, and refreshSessions mirrors
//     s.installedMcp into state.installedMcp for card badging.
//   SERVER  — GET /sessions ships s.installedMcp from rec.installedMcp
//     so the client can badge installed entries.
//   CSS     — the .mcp-card grid + tag styles exist (dark theme).
// Run: node test/delm-mcp-market-ui.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'web/public/index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web/public/styles.css'), 'utf8');
const SRV = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message || err)); failed++; }
};

process.on('exit', (code) => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0 && code === 0) process.exitCode = 1;
});

t('index.html: MCP category entry + list/detail panes in the skills panel', () => {
  // delm-11: the flat tab row became the layered CATEGORY row — the
  // MCP entry point is now the #market-cat-mcp category button.
  assert.ok(/id="market-cat-mcp"/.test(HTML),
    'the #market-cat-mcp category button must exist (MCP market entry point)');
  assert.ok(/MCP 市场/.test(HTML), 'the category button must be labeled MCP 市场');
  assert.ok(HTML.includes('id="mcp-market-list"'),
    '#mcp-market-list card grid must exist');
  assert.ok(HTML.includes('id="mcp-market-detail"'),
    '#mcp-market-detail preview pane must exist');
  // Category sits inside the category row (role=tablist).
  const catRowAt = HTML.indexOf('class="skills-cat-row" role="tablist"');
  const mcpAt = HTML.indexOf('id="market-cat-mcp"');
  assert.ok(catRowAt > -1 && mcpAt > catRowAt && mcpAt - catRowAt < 2600,
    'the MCP category must live inside the category row block');
});

t('app.js: _skillsSetCat accepts the mcp category and _skillsSetTab toggles its panes', () => {
  const at = APP.search(/function _skillsSetCat/);
  assert.ok(at > -1, '_skillsSetCat must exist');
  const catBody = APP.slice(at, APP.indexOf('\n}', at));
  assert.ok(/_skillsSetCat\(cat\)/.test(APP) || /market-cat-/.test(catBody),
    'category buttons must drive _skillsSetCat');
  const setTabAt = APP.search(/function _skillsSetTab/);
  const end = APP.indexOf('\n}', APP.indexOf('_skillsRefresh();', setTabAt));
  const body = APP.slice(setTabAt, end + 2);
  assert.ok(/cat === 'mcp'/.test(body),
    "_skillsSetTab must special-case the 'mcp' category");
  assert.ok(/mcp-market-list.*!isMcp/.test(body),
    "_skillsSetTab must toggle #mcp-market-list on the mcp category");
});

t('app.js: _skillsRefresh routes the mcp category to _mcpMarketLoad', () => {
  const at = APP.search(/function _skillsRefresh\b/);
  assert.ok(at > -1, '_skillsRefresh must exist');
  const body = APP.slice(at, at + 700);
  assert.ok(/cat === 'mcp'\) return _mcpMarketLoad\(\)/.test(body),
    "_skillsRefresh must call _mcpMarketLoad for the 'mcp' category");
});

t('app.js: install/uninstall call the mcp-market session routes with {name}', () => {
  const ins = APP.search(/async function _mcpMarketInstall/);
  assert.ok(ins > -1, '_mcpMarketInstall must exist');
  const insBody = APP.slice(ins, ins + 900);
  assert.ok(/\/mcp-market\/install/.test(insBody),
    'install must POST /sessions/:id/mcp-market/install');
  assert.ok(/JSON\.stringify\(\{ name \}\)/.test(insBody),
    'install must send { name } in the body');
  const un = APP.search(/async function _mcpMarketUninstall/);
  assert.ok(un > -1, '_mcpMarketUninstall must exist');
  const unBody = APP.slice(un, un + 900);
  assert.ok(/\/mcp-market\/uninstall/.test(unBody),
    'uninstall must POST /sessions/:id/mcp-market/uninstall');
});

t('app.js: detail previews via GET /mcp-market/:name', () => {
  const at = APP.search(/async function _mcpMarketDetail/);
  assert.ok(at > -1, '_mcpMarketDetail must exist');
  const body = APP.slice(at, at + 1200);
  assert.ok(/\/mcp-market\/\$\{encodeURIComponent\(name\)\}/.test(body),
    'detail must GET /mcp-market/:name (encoded)');
  assert.ok(/mcp-market-detail/.test(body),
    'detail must render into #mcp-market-detail');
});

t('app.js: catalog load + card render use /mcp-market and escHtml (no raw injection)', () => {
  const at = APP.search(/async function _mcpMarketLoad/);
  assert.ok(at > -1, '_mcpMarketLoad must exist');
  assert.ok(/authedFetch\('\/mcp-market'\)/.test(APP),
    'catalog load must GET /mcp-market via authedFetch');
  const rat = APP.search(/function _renderMcpMarketList/);
  const rbody = APP.slice(rat, rat + 3500);
  assert.ok(/escHtml/.test(rbody),
    'card render must escape server-provided strings with escHtml');
  assert.ok(/data-mcp-in=/.test(rbody) && /data-mcp-detail=/.test(rbody),
    'cards must carry install + detail action hooks');
});

t('app.js: refreshSessions mirrors s.installedMcp into state.installedMcp', () => {
  const at = APP.search(/async function refreshSessions/);
  assert.ok(at > -1, 'refreshSessions must exist');
  const body = APP.slice(at, at + 1800);
  assert.ok(/state\.installedMcp = \(cur && Array\.isArray\(cur\.installedMcp\)\)/.test(body),
    'refreshSessions must copy the active session record’s installedMcp into state');
});

t('index.js: GET /sessions enriches entries with s.installedMcp', () => {
  assert.ok(/s\.installedMcp = rec\.installedMcp\.slice\(\)/.test(SRV),
    'the /sessions list must ship rec.installedMcp (source for client card badging)');
});

t('styles.css: mcp card grid + security tag styles exist', () => {
  assert.ok(/\.mcp-market-list\s*\{/.test(CSS), '.mcp-market-list grid styles must exist');
  assert.ok(/\.mcp-card\s*\{/.test(CSS), '.mcp-card styles must exist');
  assert.ok(/\.mcp-tag-high/.test(CSS) && /\.mcp-tag-low/.test(CSS),
    'security-level tag variants (low/medium/high) must be styled');
});
