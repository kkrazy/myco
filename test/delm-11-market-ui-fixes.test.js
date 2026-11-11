// Regression test for the market-panel layout/logic defects (2026-10-23):
//   1. The top Publish… button publishes a SKILL (POST
//      /sessions/:id/skills/publish) no matter which market category is
//      active — in the expert/team/mcp categories that's a trap. It must
//      hide outside the skill category (rows carry their own ⇧ Publish
//      for expert/team; MCP has none).
//   2. The MCP category is a single catalog (GET /mcp-market) with no
//      personal/market split — the My / Market scope tabs are dead
//      controls there and must hide.
//   3. Editing a private draft under a NEW name used to fork it: the
//      old-named draft survived alongside the new one. The save path
//      must DELETE the old name after a successful rename save.
// Run: node test/delm-11-market-ui-fixes.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web/public/index.html'), 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

process.on('exit', (code) => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0 && code === 0) process.exitCode = 1;
});

// ─── fix 1: the skill Publish… button must hide outside the skill category ───

t('app.js: _skillsSetCat hides #skills-publish-btn outside the skill category', () => {
  const at = APP.indexOf('function _skillsSetCat');
  assert.ok(at > -1, '_skillsSetCat must exist');
  const body = APP.slice(at, APP.indexOf('\n}', at));
  assert.ok(/pub\.hidden\s*=\s*cat !== 'skill'/.test(body),
    'the Publish… button must be hidden (pub.hidden) when the category is not skill — its click handler publishes a SKILL regardless of category');
});

t('app.js: expert/team private rows still carry their own per-row Publish', () => {
  const at = APP.indexOf('function _marketRenderRow');
  assert.ok(at > -1, '_marketRenderRow must exist');
  const body = APP.slice(at, APP.indexOf('\n}', APP.indexOf('data-mkt-publish', at)) + 2);
  assert.ok(/data-mkt-publish=/.test(body),
    'hiding the top Publish… must not remove the per-row one-click Publish on expert/team drafts');
});

t('index.html: #skills-publish-btn still exists for the skill category', () => {
  assert.ok(/id="skills-publish-btn"/.test(HTML),
    'the skill-category Publish… affordance must remain in the DOM (hidden per category, not deleted)');
});

// ─── fix 2: the My / Market scope tabs must hide in the MCP category ───

t('app.js: _skillsSetTab hides both scope tabs in the MCP category', () => {
  const at = APP.indexOf('function _skillsSetTab');
  assert.ok(at > -1, '_skillsSetTab must exist');
  const body = APP.slice(at, APP.indexOf('function _skillsRefresh', at));
  assert.ok(/personal\?\.toggleAttribute\('hidden',\s*cat === 'mcp' \|\| cat === 'harness'\)/.test(body),
    '#skills-tab-personal must hide when cat === mcp or harness — both are single catalogs, no personal/market split');
  assert.ok(/market\?\.toggleAttribute\('hidden',\s*cat === 'mcp' \|\| cat === 'harness'\)/.test(body),
    '#skills-tab-market must hide when cat === mcp or harness — the tab is a dead control there');
});

// ─── fix 3: renaming a private draft must delete the old-named draft ───

t('app.js: _marketEditorSave deletes the old name after a rename save', () => {
  const at = APP.indexOf('function _marketEditorSave');
  assert.ok(at > -1, '_marketEditorSave must exist');
  const body = APP.slice(at, APP.indexOf('\n// ─', at) > -1 ? APP.indexOf('\n// ─', at) : at + 5000);
  assert.ok(/editing && editing !== name/.test(body),
    'the save path must detect a rename (editing name differs from the new name)');
  assert.ok(/\/market\/personal\/\$\{encodeURIComponent\(cat\)\}\/\$\{encodeURIComponent\(editing\)\}/.test(body),
    'after a successful rename save, the old-named draft must be DELETEd (otherwise the edit forks into two drafts)');
  assert.ok(/dlg\.dataset\.editing/.test(APP), 'the editor dialog carries the editing name in dataset.editing');
});
