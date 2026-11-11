// delm-10 scope/market UI regression test. Locks the frontend half of
// the skill-visibility feature (web/public):
//   index.html — upload-visibility <select> (session/user/global), the
//     My-skills / Market tabs, the Publish affordance, both list
//     containers.
//   app.js — _skillsSetTab/_skillsRefresh tab switching; scope badge in
//     _renderSkillsList + scope-routed delete confirm; _skillsUpload
//     sends payload.scope from the selector; market load/install/
//     publish/delete flows incl. the code-prompt fallback on 403.
//   styles.css — scope badge + tab + publish styling exists.
// Run: node test/delm-10-skill-scope-ui.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web/public/index.html'), 'utf8');
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

// ─── index.html: the visibility selector + tabs ───

t('index.html: skills-scope-select offers session/user/global', () => {
  const at = HTML.indexOf('id="skills-scope-select"');
  assert.ok(at > -1, 'the Skills panel must carry the #skills-scope-select upload-visibility selector');
  const seg = HTML.slice(at, at + 400);
  assert.ok(/value="session"/.test(seg), 'selector must offer scope=session (default)');
  assert.ok(/value="user"/.test(seg), 'selector must offer scope=user (all my sessions)');
  assert.ok(/value="global"/.test(seg), 'selector must offer scope=global (all users)');
});

t('index.html: scope tabs + both list containers exist', () => {
  assert.ok(/id="skills-tab-personal"/.test(HTML), 'My-skills tab button required');
  assert.ok(/id="skills-tab-market"/.test(HTML), 'Market tab button required');
  assert.ok(/id="skills-market-list"/.test(HTML), 'the market list container must exist');
  assert.ok(/id="skills-list"/.test(HTML), 'the personal list container must still exist');
});

t('index.html: Publish affordance present', () => {
  assert.ok(/id="skills-publish-btn"/.test(HTML), 'the Publish… button (personal → market) must exist');
});

// ─── app.js: tab switching ───

t('app.js: _skillsSetTab toggles containers + aria state', () => {
  assert.ok(/function _skillsSetTab/.test(APP), '_skillsSetTab must exist');
  const body = APP.slice(APP.indexOf('function _skillsSetTab'), APP.indexOf('function _skillsRefresh'));
  assert.ok(/skills-tab-personal/.test(body) && /skills-tab-market/.test(body), 'both tabs must be driven');
  assert.ok(/toggleAttribute\('hidden'/.test(body), 'tab switch must hide/show the list containers');
  assert.ok(/aria-selected/.test(body), 'tab switch must update aria-selected for a11y');
});

t('app.js: refresh button reloads the ACTIVE tab', () => {
  const body = APP.slice(APP.indexOf('function _skillsRefresh'));
  assert.ok(/_skillsMarketLoad/.test(body), '_skillsRefresh must delegate to the market loader on the market tab');
});

// ─── app.js: skills view keeps the chat pane visible (side-by-side) ───
// Regression: opening the Skills panel (incl. the Market tab) used to
// cover the chatpane full-pane because _updateMainPaneLayout never set
// .has-artifact for #skills-panel — unlike files/plan/arch/test, so
// chat never shrank into its right-sidebar layout. The pane must drive
// has-artifact so #terminal-pane.has-artifact CSS applies (chatpane
// right sidebar + #skills-panel right edge stops at --chatpane-w).

t('app.js: _updateMainPaneLayout counts the skills panel for has-artifact', () => {
  const at = APP.indexOf('function _updateMainPaneLayout');
  assert.ok(at > -1, '_updateMainPaneLayout must exist');
  const end = APP.indexOf('\n}', at);
  const body = APP.slice(at, end);
  assert.ok(/skills-panel/.test(body),
    'the Skills panel must feed the .has-artifact toggle, else opening Skills/Market covers the chatpane instead of sharing the pane with it (side-by-side like files/plan/arch/test)');
  assert.ok(/classList\.toggle\('has-artifact'/.test(body),
    'the toggle itself must stay — the CSS side-by-side layout depends on it');
});

t('app.js: showSkillsView re-runs the layout after unhiding the panel', () => {
  const at = APP.indexOf('function showSkillsView');
  assert.ok(at > -1, 'showSkillsView must exist');
  const end = APP.indexOf('\n}', at);
  const body = APP.slice(at, end);
  assert.ok(/_updateMainPaneLayout\(\)/.test(body),
    'showSkillsView must call _updateMainPaneLayout after unhiding #skills-panel so .has-artifact lands on the same tick');
  assert.ok(/setChatPane\(true\)/.test(body),
    'showSkillsView must keep chat visible on desktop (setChatPane(true)), same as files/plan/arch/test');
});

// ─── app.js: scope badges + scope-routed delete ───

t('app.js: _renderSkillsList renders a scope badge per row', () => {
  const at = APP.indexOf('function _renderSkillsList');
  const body = APP.slice(at, APP.indexOf('async function _skillsToggle'));
  assert.ok(/skill-scope/.test(body), 'rows must render a .skill-scope badge');
  assert.ok(/s\.scope/.test(body), 'the badge must come from the merged GET /skills scope field');
});

t('app.js: delete confirm differentiates shared scopes', () => {
  const at = APP.indexOf('function _renderSkillsList');
  const body = APP.slice(at, APP.indexOf('async function _skillsToggle'));
  assert.ok(/data-scope=/.test(body), 'the delete button must carry the row scope (data-scope)');
  assert.ok(/ALL USERS/.test(body), 'global delete must warn it affects every user');
  assert.ok(/ALL YOUR sessions/.test(body), 'user delete must warn it affects the user store');
});

t('app.js: _skillsDelete sends ?scope= for shared stores', () => {
  const at = APP.indexOf('async function _skillsDelete');
  const body = APP.slice(at, APP.indexOf('// ─── delm-10: skill MARKET tab'));
  assert.ok(/\?scope=/.test(body), '_skillsDelete must route shared deletes via ?scope=');
  assert.ok(/scope === 'user' \|\| scope === 'global'/.test(body), 'only user|global scopes append the query param');
  // Deletion-security UX: a 403 on a GLOBAL skill is the "not the
  // uploader" signal — the UI must offer the system delete code
  // prompt (same UX as the market tab), never on session/user scope.
  assert.ok(/first\.status !== 403 \|\| scope !== 'global'/.test(body),
    'only a global-scope 403 falls through to the code prompt (session/user 403s are plain errors)');
  assert.ok(/window\.prompt/.test(body), 'a global 403 must prompt for the system delete code');
  assert.ok(/scope=global&code=/.test(body), 'the retry must carry scope=global + the code');
});

// ─── app.js: upload visibility ───

t('app.js: _skillsUpload reads the selector and sends payload.scope', () => {
  const at = APP.indexOf('async function _skillsUpload');
  const end = APP.indexOf('// ─── delm-10: skill MARKET tab');
  const body = APP.slice(at, end);
  assert.ok(/skills-scope-select/.test(body), '_skillsUpload must read #skills-scope-select');
  assert.ok(/payload\.scope = scope/.test(body), 'the chosen scope must be sent in the import payload');
});

t('app.js: showSkillsView hides the selector for read-only guests', () => {
  const at = APP.indexOf('function showSkillsView');
  const body = APP.slice(at, APP.indexOf('function _skillsSetTab'));
  assert.ok(/skills-scope-select/.test(body), 'showSkillsView must toggle the selector visibility');
  assert.ok(/state\.readOnly/.test(body), 'the toggle must be driven by state.readOnly (owner-only uploads)');
});

// ─── app.js: market flows ───

t('app.js: market load renders uploader + install/delete buttons', () => {
  const at = APP.indexOf('function _renderMarketList');
  const body = APP.slice(at, APP.indexOf('async function _skillsMarketInstall'));
  assert.ok(/s\.uploader/.test(body), 'market rows must show the uploader (who may delete)');
  assert.ok(/data-mkt-install/.test(body), 'market rows need an Install button (owner installs into session)');
  assert.ok(/data-mkt-del/.test(body), 'market rows need a Delete button');
});

t('app.js: market delete falls back to the system-code prompt on 403', () => {
  const at = APP.indexOf('async function _skillsMarketDelete');
  const end = APP.indexOf('// Publish one of MY skills');
  const body = APP.slice(at, end);
  assert.ok(/status !== 403/.test(body), 'the uploader path is tried first (no code) and 403 triggers the code prompt');
  assert.ok(/window\.prompt/.test(body), 'a non-uploader must be prompted for the system delete code');
  assert.ok(/code=/.test(body), 'the code must be sent to the DELETE route');
});

t('app.js: market install posts to the install route with the session id', () => {
  const at = APP.indexOf('async function _skillsMarketInstall');
  const body = APP.slice(at, APP.indexOf('async function _skillsMarketDelete'));
  assert.ok(/\/skill-market\/install/.test(body), 'install must POST /sessions/:id/skill-market/install');
});

// ─── styles.css ───

t('styles.css: scope badges + tabs + publish are styled', () => {
  assert.ok(/\.skill-scope-session/.test(CSS) && /\.skill-scope-user/.test(CSS) && /\.skill-scope-global/.test(CSS),
    'each scope badge needs a distinct class so users can tell the stores apart at a glance');
  assert.ok(/\.skills-tab/.test(CSS), 'the scope tabs need styling');
  assert.ok(/\.skills-publish/.test(CSS), 'the Publish button needs styling');
  assert.ok(/#skills-scope-select/.test(CSS), 'the visibility selector needs styling');
});
