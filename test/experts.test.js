// Experts (专家团) — regression guards for the multi-expert team feature.
//
// Covers the two halves worker-B owns:
//   1. server/src/experts.js — the rec.experts CRUD contract
//      (validation, uniqueness, cap) that POST/DELETE /sessions/:id/experts
//      and /run-experts both sit on.
//   2. the Experts UI wiring — index.html ships the Experts tab + create
//      form, app.js binds it and talks to the right endpoints with the
//      right payload shape, styles.css styles the roster.
//
// The engine half (TeamSession roster/expertSkills, prompts-team.js,
// startTeamLane, /run-experts launch) is covered by
// test/team-multi-experts.test.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const expertsApi = require('../server/src/experts.js');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web/public/index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web/public/styles.css'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

async function main() {
  console.log('── experts: CRUD contract + UI wiring ──');

  // ── experts.js CRUD ──

  await t('addExpert validates + persists {name, skills[]} on rec.experts', () => {
    const rec = {};
    const list = expertsApi.addExpert(rec, { name: 'sql-dev', skills: ['sql-migrations', 'testing'] });
    assert.deepStrictEqual(list, [{ name: 'sql-dev', skills: ['sql-migrations', 'testing'] }],
      'addExpert must return the new full list');
    assert.deepStrictEqual(rec.experts, list, 'the record itself carries the persisted list');
  });

  await t('addExpert rejects an empty name, a bad-charset name, and a duplicate', () => {
    const rec = {};
    expertsApi.addExpert(rec, { name: 'ok', skills: ['s'] });
    assert.throws(() => expertsApi.addExpert(rec, { name: '', skills: ['s'] }), /name required/,
      'empty name must throw ERR_BAD_INPUT');
    assert.throws(() => expertsApi.addExpert(rec, { name: 'bad name!', skills: ['s'] }), /may only contain/,
      'a name with spaces/! must be rejected (it becomes a worker identity)');
    assert.throws(() => expertsApi.addExpert(rec, { name: 'ok', skills: ['s'] }), /already exists/,
      'duplicate names must 409 (roster identity collision)');
  });

  await t('addExpert caps the roster (MAX_EXPERTS) and removeExpert deletes by name', () => {
    const rec = {};
    for (let i = 0; i < expertsApi.MAX_EXPERTS; i++) expertsApi.addExpert(rec, { name: `e${i}`, skills: ['s'] });
    assert.throws(() => expertsApi.addExpert(rec, { name: 'overflow', skills: ['s'] }), /too many/,
      `the roster cap (${expertsApi.MAX_EXPERTS}) must be enforced — board actors + UI columns are bounded`);
    const rest = expertsApi.removeExpert(rec, 'e0');
    assert.ok(rest.every((e) => e.name !== 'e0'), 'removeExpert drops the named expert');
    assert.throws(() => expertsApi.removeExpert(rec, 'e0'), /not found/,
      'removing an absent expert throws ERR_NOT_FOUND (route 404s)');
  });

  await t('listExperts tolerates a legacy record with no experts field', () => {
    assert.deepStrictEqual(expertsApi.listExperts({}), [], 'no rec.experts reads as an empty team');
    assert.deepStrictEqual(expertsApi.listExperts(null), [], 'null record reads as an empty team');
  });

  // ── server routes ──

  await t('index.js wires GET/POST/DELETE /sessions/:id/experts with owner gates', () => {
    assert.ok(/app\.get\('\/sessions\/:id\/experts'/.test(INDEX_SRC),
      'GET /sessions/:id/experts route must exist (the Experts tab reads the roster)');
    assert.ok(/app\.post\('\/sessions\/:id\/experts'/.test(INDEX_SRC),
      'POST /sessions/:id/experts route must exist (create expert)');
    assert.ok(/app\.delete\('\/sessions\/:id\/experts\/:name'/.test(INDEX_SRC),
      'DELETE /sessions/:id/experts/:name route must exist (remove expert)');
    // Mutations must be owner-gated — a viewer can see the team but not
    // rewrite it. (GET is viewer-readable like the skills list.)
    // Slice to the NEXT app.* route so the whole handler body is in scope.
    const routeBody = (marker) => {
      const at = INDEX_SRC.indexOf(marker);
      assert.ok(at > -1, marker + ' must exist');
      const next = INDEX_SRC.indexOf('\napp.', at + 1);
      return INDEX_SRC.slice(at, next > -1 ? next : undefined);
    };
    const postBody = routeBody("app.post('/sessions/:id/experts'");
    assert.ok(/'owner'/.test(postBody), 'POST /experts must use fileApiPreamble owner access');
    const delBody = routeBody("app.delete('/sessions/:id/experts/:name'");
    assert.ok(/'owner'/.test(delBody), 'DELETE /experts must use fileApiPreamble owner access');
    // POST persists via saveStore — the roster must survive a restart.
    assert.ok(/saveStore\(\)/.test(postBody), 'POST /experts must persist rec.experts via saveStore');
  });

  // ── UI wiring ──

  await t('index.html ships the Experts entry point + create form + run row', () => {
    // delm-11: the flat tab row became the layered CATEGORY row — the
    // expert entry point is now the #market-cat-expert category button
    // (专家市场 layer) which shows the runner below the expert list.
    assert.ok(/id="market-cat-expert"/.test(HTML), 'the 专家 category button must exist (expert entry point)');
    assert.ok(/专家市场/.test(HTML), 'the category button must be labeled 专家市场');
    assert.ok(/id="expert-name-input"/.test(HTML), 'the expert name input must exist');
    assert.ok(/id="expert-skills-picker"/.test(HTML), 'the skill multi-select picker must exist');
    assert.ok(/id="expert-create-btn"/.test(HTML), 'the create-expert button must exist');
    assert.ok(/id="experts-list"/.test(HTML), 'the roster container must exist');
    assert.ok(/id="expert-run-form"/.test(HTML), 'the start-a-task form must exist');
  });

  await t('app.js: _skillsSetCat shows the experts runner + _skillsRefresh routes to _expertsLoad', () => {
    const at = APP.indexOf('function _skillsSetCat');
    assert.ok(at > -1, '_skillsSetCat must exist');
    const setTabAt = APP.indexOf('function _skillsSetTab');
    const setTabBody = APP.slice(setTabAt, APP.indexOf('\n}', setTabAt));
    assert.ok(/experts-panel-list/.test(setTabBody), 'the expert category must toggle #experts-panel-list visibility');
    assert.ok(/cat !== 'expert'/.test(setTabBody), 'the runner pane shows only on the expert category');
    const at2 = APP.indexOf('function _skillsRefresh');
    const body2 = APP.slice(at2, APP.indexOf('\n}', at2));
    assert.ok(/_expertsLoad|_marketGenericLoad/.test(body2), '_skillsRefresh must load the expert list (generic market or roster)');
  });

  await t('app.js: create posts {name, skills:[dirName…]} and clears the picker on success', () => {
    const at = APP.indexOf('async function _expertsCreate');
    assert.ok(at > -1, '_expertsCreate must exist');
    const body = APP.slice(at, APP.indexOf('\n}\n\n// ', at) > -1 ? APP.indexOf('\n}\n\n// ', at) : at + 4000);
    assert.ok(/data-expert-skill.:checked/.test(body), 'the create must collect every CHECKED picker box');
    assert.ok(/JSON\.stringify\(\{ name, skills: picked \}\)/.test(body),
      'POST payload must be { name, skills:[dirName…] } — the exact shape POST /experts validates');
    assert.ok(/nameEl\.value = ''/.test(body), 'the form must reset after a successful create');
  });

  await t('app.js: run row sends /run-experts <task> through sendChatMessage', () => {
    const at = APP.indexOf('function _expertsRunTask');
    assert.ok(at > -1, '_expertsRunTask must exist');
    const body = APP.slice(at, APP.indexOf('\n}', at));
    assert.ok(/sendChatMessage\(`\/run-experts \$\{task\}`\)/.test(body),
      'the Run button must go through the normal chat pipeline as /run-experts <task>');
  });

  await t('app.js: read-only viewers cannot create or launch (owner-only affordances hidden)', () => {
    const at = APP.indexOf('async function _expertsLoad');
    const body = APP.slice(at, APP.indexOf('\n}\n\n// ', at));
    assert.ok(/state\.readOnly/.test(body), '_expertsLoad must hide create/run affordances for read-only viewers');
    const at2 = APP.indexOf('async function _expertsCreate');
    const body2 = APP.slice(at2, at2 + 1200);
    assert.ok(/state\.readOnly/.test(body2), '_expertsCreate must early-out for read-only viewers');
  });

  await t('styles.css styles the experts roster + create form', () => {
    for (const sel of ['#experts-panel-list', '.experts-create', '.expert-item', '.expert-skill-chip', '.expert-run-row']) {
      assert.ok(CSS.includes(sel), `styles.css must style ${sel}`);
    }
  });

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
