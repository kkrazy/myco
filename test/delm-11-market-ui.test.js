// delm-11: layered market UI regression test.
// Locks the USER-VISIBLE contract of the redesigned market layout:
//   CATEGORY ROW — four market layers exist as buttons with their own
//     icons + labels: Skill 市场 / 专家市场 / 专家团市场 / MCP 市场.
//   PER-CATEGORY INTRO — the subtitle (#skills-subtitle) is switched
//     by _skillsSetCat via MARKET_CAT_META: each category introduces
//     ITSELF (expert/team/mcp copy), never a fixed skills-only blurb.
//   ONE-CLICK PUBLISH — private rows carry a Publish action wired to
//     POST /market/publish/:type/:name; market rows carry install +
//     delete. Publish is the ONLY path to market visibility.
//   EDITOR — the private-entry editor builds per-category fields
//     (expert prompt / team expert rows / mcp transport) and saves via
//     POST /market/personal/:type.
//   GENERIC LIST — #market-generic-list renders personal + market
//     scopes for expert/team from the /market API.
// Run: node test/delm-11-market-ui.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'web/public/index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web/public/styles.css'), 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

process.on('exit', (code) => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0 && code === 0) process.exitCode = 1;
});

// ─── category row (the market layers) ───

t('index.html: five category buttons with distinct icons + labels', () => {
  for (const [id, label] of [
    ['market-cat-skill', 'Skill 市场'],
    ['market-cat-expert', '专家市场'],
    ['market-cat-team', '专家团市场'],
    ['market-cat-mcp', 'MCP 市场'],
    // market-cat-harness joined the row with the Harness2 integration
    // (commit 533bd9a) — the market row has 5 categories now.
    ['market-cat-harness', 'Harness 市场'],
  ]) {
    assert.ok(HTML.includes(`id="${id}"`), `${id} button must exist`);
    assert.ok(HTML.includes(label), `label "${label}" must be rendered`);
  }
  // each category button carries its own svg icon (5 distinct icons:
  // skill / expert / team / mcp / harness).
  const catRow = HTML.slice(HTML.indexOf('skills-cat-row'), HTML.indexOf('class="skills-subheader"'));
  assert.strictEqual((catRow.match(/<svg/g) || []).length, 5,
    'each of the 5 category buttons must have its own icon svg');
  assert.ok(/role="tablist"/.test(catRow), 'the category row must be a tablist');
});

// ─── per-category intro switching ───

t('app.js: MARKET_CAT_META carries per-category subtitle copy', () => {
  const at = APP.indexOf('const MARKET_CAT_META');
  assert.ok(at > -1, 'MARKET_CAT_META must exist');
  const body = APP.slice(at, APP.indexOf('};', at) + 2);
  for (const key of ['skill:', 'expert:', 'team:', 'mcp:']) {
    assert.ok(body.includes(key), `MARKET_CAT_META must define the ${key} category`);
  }
  // The expert/team/mcp copy must introduce THEIR concepts, not skills.
  assert.ok(/personas|system prompt/i.test(body), 'expert intro must explain the persona concept');
  assert.ok(/roster|team/i.test(body), 'team intro must explain the team concept');
  assert.ok(/external tools/i.test(body), 'mcp intro must explain MCP servers');
});

t('app.js: _skillsSetCat switches the subtitle + affordances per category', () => {
  const at = APP.indexOf('function _skillsSetCat');
  assert.ok(at > -1, '_skillsSetCat must exist');
  const body = APP.slice(at, APP.indexOf('\n}', at));
  assert.ok(/skills-subtitle/.test(body), '_skillsSetCat must rewrite the subtitle element');
  assert.ok(/meta\.subtitle/.test(body), 'the subtitle text must come from MARKET_CAT_META');
  assert.ok(/skills-upload-btn/.test(body), 'the skill Import button must hide outside the skill category');
  assert.ok(/market-new-btn/.test(body), 'the +New create button must be category-aware');
  assert.ok(/publishHint/.test(body), 'the Publish button title must switch per category');
});

// ─── scope × category matrix ───

t('app.js: _skillsSetTab renders the category × scope panel matrix', () => {
  const at = APP.indexOf('function _skillsSetTab');
  const body = APP.slice(at, APP.indexOf('function _skillsRefresh', at));
  for (const el of ['skills-list', 'skills-market-list', 'market-generic-list', 'experts-panel-list', 'mcp-market-list']) {
    assert.ok(body.includes(el), `_skillsSetTab must toggle #${el}`);
  }
  assert.ok(/cat !== 'expert'/.test(body), 'the experts runner pane shows only on the expert category');
});

t('app.js: _skillsRefresh routes every category × scope cell', () => {
  const at = APP.indexOf('function _skillsRefresh');
  const body = APP.slice(at, APP.indexOf('\n}', at));
  assert.ok(/cat === 'mcp'\) return _mcpMarketLoad/.test(body), 'mcp → _mcpMarketLoad');
  assert.ok(/_skillsMarketLoad/.test(body), 'skill market scope → _skillsMarketLoad');
  assert.ok(/_skillsLoad/.test(body), 'skill personal scope → _skillsLoad');
  assert.ok(/_marketGenericLoad\(cat, scope\)/.test(body), 'expert/team → _marketGenericLoad(cat, scope)');
});

// ─── one-click publish (the only visibility path) ───

t('app.js: private rows carry a one-click Publish wired to /market/publish', () => {
  const at = APP.indexOf('function _marketRenderRow');
  const body = APP.slice(at, APP.indexOf('\n}', APP.indexOf('data-mkt-publish', at)) + 2);
  assert.ok(/data-mkt-publish=/.test(body), 'private rows must carry data-mkt-publish');
  assert.ok(/data-mkt-edit=/.test(body), 'private rows must carry an Edit action');
  const pubAt = APP.indexOf("data-mkt-publish");
  const bindBody = APP.slice(APP.indexOf('function _marketBindRowActions'), APP.indexOf('function _marketBindRowActions') + 4000);
  assert.ok(/\/market\/publish\/\$\{encodeURIComponent\(cat\)\}/.test(bindBody),
    'publish must POST /market/publish/:type/:name');
  assert.ok(/visible to ALL users|market\? It becomes visible/i.test(bindBody),
    'the publish confirm must state the visibility consequence');
});

t('app.js: market rows show published-only listing + install + delete', () => {
  const loadAt = APP.indexOf('function _marketGenericLoad');
  const loadBody = APP.slice(loadAt, APP.indexOf('\n}', APP.indexOf('_marketBindRowActions', loadAt)) + 2);
  assert.ok(/'\/market'/.test(loadBody) || /`\/market`/.test(loadBody), 'market scope must GET /market');
  assert.ok(/\/market\/personal\/\$\{encodeURIComponent\(cat\)\}/.test(loadBody), 'personal scope must GET /market/personal/:type');
  assert.ok(/only after their owner publishes/i.test(loadBody),
    'the market-scope empty state must explain publish-only visibility');
  assert.ok(/data-mkt-generic-install/.test(APP), 'market rows must carry an install action');
  assert.ok(/\/market\/install\/\$\{encodeURIComponent\(cat\)\}/.test(APP), 'install must POST /market/install/:type/:name');
  assert.ok(/\/market\/\$\{encodeURIComponent\(cat\)\}\/\$\{encodeURIComponent\(name\)\}\?code=/.test(APP),
    'delete-with-code must DELETE /market/:type/:name?code=');
});

// ─── the private-entry editor ───

t('app.js: editor builds per-category fields and saves to /market/personal', () => {
  const extraAt = APP.indexOf('function _marketEditorExtraHtml');
  const extra = APP.slice(extraAt, APP.indexOf('function _marketEditorOpen', extraAt));
  assert.ok(/market-editor-prompt/.test(extra), 'expert editor must have a prompt textarea');
  assert.ok(/market-editor-experts/.test(extra), 'team editor must have expert rows');
  assert.ok(/market-editor-transport/.test(extra), 'mcp editor must pick a transport');
  const saveAt = APP.indexOf('function _marketEditorSave');
  const save = APP.slice(saveAt, APP.indexOf('\n// ───', saveAt) > -1 ? APP.indexOf('\n// ───', saveAt) : saveAt + 4000);
  assert.ok(/\/market\/personal\/\$\{encodeURIComponent\(cat\)\}/.test(save),
    'save must POST /market/personal/:type');
  assert.ok(/experts\.length/.test(save), 'team save must require ≥1 expert');
  assert.ok(save.includes('https?:'), 'mcp http/sse save must validate the URL scheme');
});

t('index.html: editor dialog + generic list panes exist', () => {
  assert.ok(HTML.includes('id="market-editor-dialog"'), 'editor dialog must exist');
  assert.ok(HTML.includes('id="market-editor-extra"'), 'editor extra-fields holder must exist');
  assert.ok(HTML.includes('id="market-generic-list"'), 'the generic expert/team list pane must exist');
  assert.ok(HTML.includes('id="skills-subtitle"'), 'the subtitle must be a switchable element');
});

// ─── 2026-10-23 market-panel logic fixes ───

t('app.js: the top Publish… button is hidden outside the skill category', () => {
  // It drives _skillsMarketPublish (prompt-pick a SKILL → POST
  // /sessions/:id/skills/publish). In expert/team each private row
  // already has its own ⇧ Publish; MCP has none. A visible button
  // there publishes an unrelated SKILL — must be hidden.
  const at = APP.indexOf('function _skillsSetCat');
  const body = APP.slice(at, APP.indexOf('\n}', at));
  assert.ok(/pub\.hidden = cat !== 'skill'/.test(body),
    '_skillsSetCat must set pub.hidden = (cat !== "skill")');
});

t('app.js: the My/Market scope tabs hide in the MCP category', () => {
  // MCP is a single catalog (GET /mcp-market) with no personal/market
  // split — visible tabs there are a dead control. Harness is the same
  // shape (single GET /harness-market catalog), so both tabs hide there
  // too (delm-11 harness category).
  const at = APP.indexOf('function _skillsSetTab');
  const body = APP.slice(at, APP.indexOf('function _skillsRefresh', at));
  assert.ok(/personal\?\.toggleAttribute\('hidden', cat === 'mcp' \|\| cat === 'harness'\)/.test(body),
    '_skillsSetTab must hide the personal tab for mcp and harness');
  assert.ok(/market\?\.toggleAttribute\('hidden', cat === 'mcp' \|\| cat === 'harness'\)/.test(body),
    '_skillsSetTab must hide the market tab for mcp and harness');
});

t('app.js: editing under a new name deletes the old draft (rename ≠ fork)', () => {
  const saveAt = APP.indexOf('function _marketEditorSave');
  const save = APP.slice(saveAt, APP.indexOf('\n// ───', saveAt) > -1 ? APP.indexOf('\n// ───', saveAt) : saveAt + 4500);
  assert.ok(/const editing = String\(dlg\.dataset\.editing/.test(save),
    'save must read dlg.dataset.editing');
  assert.ok(/editing && editing !== name/.test(save),
    'save must detect a rename (editing !== name)');
  assert.ok(/market\/personal\/\$\{encodeURIComponent\(cat\)\}\/\$\{encodeURIComponent\(editing\)\}/.test(save),
    'a rename must DELETE the old draft via /market/personal/:type/:name');
});

// ─── styles ───

t('styles.css: category row + editor styles exist', () => {
  assert.ok(/\.skills-cat-row\s*\{/.test(CSS), '.skills-cat-row must be styled');
  assert.ok(/\.skills-cat\.active\s*\{/.test(CSS), 'the active category must be visually distinct');
  assert.ok(/\.market-item-detail\s*\{/.test(CSS), 'the expert/team detail line must be styled');
  assert.ok(/\.market-editor-expert-row\s*\{/.test(CSS), 'the team editor row grid must be styled');
});

t('styles.css: every list pane gets min-height:0 so it scrolls in the panel flex column', () => {
  // #skills-list had it; the sibling panes didn't — a long expert/team
  // list stretched the panel instead of scrolling.
  const at = CSS.indexOf('#skills-list,');
  assert.ok(at > -1, 'the min-height rule must cover all sibling list panes');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  for (const sel of ['#skills-list', '#skills-market-list', '#market-generic-list']) {
    assert.ok(rule.includes(sel), `${sel} must be in the min-height:0 rule`);
  }
  assert.ok(/min-height:\s*0/.test(rule), 'the rule must set min-height:0');
  const mcpAt = CSS.indexOf('.mcp-market-list {');
  const mcpRule = CSS.slice(mcpAt, CSS.indexOf('}', mcpAt));
  assert.ok(/min-height:\s*0/.test(mcpRule) && /flex:\s*1/.test(mcpRule),
    '.mcp-market-list must shrink + scroll inside the panel column');
});
