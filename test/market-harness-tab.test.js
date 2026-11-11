// test/market-harness-tab.test.js — regression suite for the Harness
// market category tab (the "harness 市场怎么都不能点击" user report).
//
// Root cause of the dead tab: bindSkillsUi()'s CATS loop only bound
// ['skill','expert','team','mcp'] — #market-cat-harness existed in the
// DOM (index.html) but never received a click listener, so tapping it
// did nothing. Related panel-hygiene defects fixed in the same pass:
//   * + New… (market-new-btn) stayed visible in the harness category
//     even though harness has no /market/personal create flow — it
//     opened the expert/team/mcp editor with wrong fields.
//   * The My/Market scope tabs stayed visible in the harness category
//     even though harness is a single catalog (GET /harness-market)
//     with no personal/market split — dead controls.
//   * MARKET_CAT_META.harness lacked a subtitle, so switching to the
//     harness category left the previous category's intro showing.
// Run: node test/market-harness-tab.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'web/public/index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

process.on('exit', (code) => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0 && code === 0) process.exitCode = 1;
});

// ─── the harness category button must be CLICKABLE ───

t('app.js: the category bind loop includes harness (dead-tab fix)', () => {
  // The old code was `const CATS = ['skill', 'expert', 'team', 'mcp'];`
  // inside bindSkillsUi — the harness button rendered but never bound.
  const at = APP.indexOf('const CATS =');
  assert.ok(at > -1, 'bindSkillsUi must define a CATS array');
  const line = APP.slice(at, APP.indexOf(';', at));
  assert.ok(/'harness'/.test(line),
    `CATS must include 'harness' so #market-cat-harness gets a click listener — saw: ${line}`);
});

t('index.html: #market-cat-harness exists in the category row', () => {
  assert.ok(HTML.includes('id="market-cat-harness"'),
    'the harness category button must exist');
  assert.ok(HTML.includes('Harness 市场'),
    'the harness category label must be rendered');
});

// ─── _skillsSetCat treats harness as a first-class category ───

t('app.js: MARKET_CAT_META defines the harness intro subtitle', () => {
  const at = APP.indexOf('const MARKET_CAT_META');
  assert.ok(at > -1, 'MARKET_CAT_META must exist');
  const body = APP.slice(at, APP.indexOf('};', at) + 2);
  const hAt = body.indexOf('harness:');
  assert.ok(hAt > -1, 'MARKET_CAT_META must define a harness category');
  const hBody = body.slice(hAt, body.indexOf('},', hAt));
  assert.ok(/subtitle\s*:/.test(hBody) && /[^'"]\S/.test(hBody),
    'the harness category must carry a subtitle — without it the panel keeps the previous category\'s intro');
});

t('app.js: _skillsSetCat hides the + New… button in the harness category', () => {
  // Harness entries are published from finished sweeps (/harness
  // publish) — there is no /market/personal create flow, so the +New…
  // button there opened an editor with wrong fields.
  const at = APP.indexOf("function _skillsSetCat");
  const body = APP.slice(at, APP.indexOf('\n}', at));
  const line = (body.match(/market-new-btn[^\n]*/) || [''])[0];
  assert.ok(/cat === 'harness'/.test(line),
    `_skillsSetCat must hide #market-new-btn for harness — saw: ${line}`);
});

// ─── _skillsSetTab hides the dead scope tabs for harness ───

t('app.js: the My/Market scope tabs hide in the harness category', () => {
  // Like MCP, harness is a single catalog (GET /harness-market) with
  // no personal/market split — visible tabs are dead controls.
  const at = APP.indexOf('function _skillsSetTab');
  const body = APP.slice(at, APP.indexOf('function _skillsRefresh', at));
  assert.ok(/personal\?\.toggleAttribute\('hidden', cat === 'mcp' \|\| cat === 'harness'\)/.test(body),
    '_skillsSetTab must hide the personal scope tab for harness');
  assert.ok(/market\?\.toggleAttribute\('hidden', cat === 'mcp' \|\| cat === 'harness'\)/.test(body),
    '_skillsSetTab must hide the market scope tab for harness');
});

// ─── the refreshed chrome title ───

t('index.html: #btn-skills title introduces the whole market panel', () => {
  // The panel now hosts five markets (skills/experts/teams/MCP/
  // harness); the old "Skills — select + import skills for this
  // session" title described only the skill layer.
  const at = HTML.indexOf('id="btn-skills"');
  const tag = HTML.slice(HTML.lastIndexOf('<button', at), HTML.indexOf('>', at) + 1);
  assert.ok(/Markets/i.test(tag),
    `#btn-skills title must name the market panel — saw: ${tag}`);
  assert.ok(!/select \+ import skills/.test(tag),
    'the old skills-only title must be gone');
});
