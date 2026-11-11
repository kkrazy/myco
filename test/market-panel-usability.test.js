// test/market-panel-usability.test.js — regression suite for the
// Skills/Market panel usability fixes (the 2026-10-30 user report:
// "Import a guidance document 按钮太丑" + market 功能可用性检查).
//
// Covers the two defects fixed in this pass:
//   1. The "导入文档…" (#mcp-import-open) button in the MCP catalog
//      header reused .skill-install — a 4px-padding ghost icon style
//      scoped to list rows — and rendered as an illegible sliver.
//      It now has a dedicated #mcp-import-open style (labeled button
//      with icon) and a file-plus glyph in LUCIDE_PATHS.
//   2. The MCP catalog card's "N server tools" tag never rendered:
//      the frontend reads s.sdkTools but the server's _publicEntry
//      (server/src/mcp/market.js) omitted the field entirely.
//      _publicEntry now maps sdkTools → [{name, description}].
// Run: node test/market-panel-usability.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web/public/styles.css'), 'utf8');
const MKT = fs.readFileSync(path.join(ROOT, 'server/src/mcp/market.js'), 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

process.on('exit', (code) => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0 && code === 0) process.exitCode = 1;
});

// ─── the Import doc… button must read as a real button ───

t('app.js: #mcp-import-open no longer reuses the .skill-install ghost class', () => {
  const at = APP.indexOf('id="mcp-import-open"');
  assert.ok(at > -1, 'the import-doc button must exist in the catalog header');
  const line = APP.slice(APP.lastIndexOf('<button', at), APP.indexOf('</button>', at));
  assert.ok(!/class="skill-install"/.test(line),
    `the header button must not carry the row-scoped .skill-install class — saw: ${line}`);
  assert.ok(/导入文档/.test(line),
    `the button must carry a visible label — saw: ${line}`);
});

t('app.js: LUCIDE_PATHS defines the file-plus glyph the button uses', () => {
  const at = APP.indexOf("'file-plus'");
  assert.ok(at > -1,
    "LUCIDE_PATHS must define 'file-plus' — _lucideIcon returns '' for unknown names, which would strip the button's icon");
});

t('styles.css: #mcp-import-open has a dedicated labeled-button style', () => {
  const at = CSS.indexOf('#mcp-import-open {');
  assert.ok(at > -1, 'styles.css must style #mcp-import-open directly');
  const body = CSS.slice(at, CSS.indexOf('}', at));
  assert.ok(/padding:\s*6px 12px/.test(body),
    'the button needs real button padding (the old 4px ghost was the ugliness)');
  assert.ok(/border-radius/.test(body) && /font-weight/.test(body),
    'the button needs border-radius + font-weight so it reads as a primary affordance');
});

// ─── the "N server tools" tag must actually render ───

t('market.js: _publicEntry exposes sdkTools so the catalog tag can render', () => {
  const at = MKT.indexOf('function _publicEntry');
  assert.ok(at > -1, '_publicEntry must exist');
  const body = MKT.slice(at, MKT.indexOf('\n}', at));
  assert.ok(/sdkTools\s*:/.test(body),
    '_publicEntry must map srv.sdkTools — the frontend card reads s.sdkTools for the "N server tools" tag');
  assert.ok(!/_fileContent|params/.test(body),
    'the listing must stay small — no params internals in the public entry');
});

t('market.js: listMarket entries flow through _publicEntry (sdkTools included)', () => {
  const at = MKT.indexOf('async function listMarket');
  const body = MKT.slice(at, MKT.indexOf('\n}', at));
  assert.ok(/_publicEntry/.test(body),
    'listMarket must shape entries via _publicEntry — a raw spread of the registry would drop the new field');
});

// ─── the import dialog overlay must not be trapped by a transformed ancestor ───

t('styles.css: #skills-panel and .artifact-main-view use no transform/filter (fixed dialog stays viewport-anchored)', () => {
  // #mcp-import-dialog is position:fixed INSIDE #skills-panel. A
  // transform/filter/backdrop-filter on any ancestor (skills-panel →
  // terminal-pane → #app → body) turns fixed positioning relative to
  // that ancestor instead of the viewport. None may appear there.
  for (const sel of ['.artifact-main-view {', '#terminal-pane {', '#app {']) {
    const at = CSS.indexOf(sel);
    assert.ok(at > -1, `styles.css must define ${sel.trim()}`);
    const body = CSS.slice(at, CSS.indexOf('}', at));
    assert.ok(!/transform|filter|backdrop-filter/.test(body),
      `${sel.trim()} must not use transform/filter — it would break #mcp-import-dialog's fixed overlay`);
  }
});
