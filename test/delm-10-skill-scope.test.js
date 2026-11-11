// delm-10 scope extension: skill upload visibility (session / user /
// global). Locks the backend half:
//   skills.js — listSkills follows symlinks; linkSkill materializes a
//     session-store link to a shared-store dir (no-clobber, target
//     must exist); deleteSkill unlinks a symlink without touching the
//     shared target.
//   index.js — the skills routes route uploads by body.scope into the
//     three stores, merge the stores in GET /skills with a scope tag
//     (session shadows user shadows global), link shared uploads into
//     the session store, link-on-toggle for shared skills, and delete
//     session links vs shared stores via ?scope.
// Frontend scope selector is covered by delm-10-skill-scope-ui.test.js.
// Run: node test/delm-10-skill-scope.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRV = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');
const SKILLS_SRC = fs.readFileSync(path.join(ROOT, 'server/src/skills.js'), 'utf8');
const skillsApi = require(path.join(ROOT, 'server/src/skills.js'));

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

// ─── skills.js: symlink support ───

t('skills.js exports linkSkill', () => {
  assert.strictEqual(typeof skillsApi.linkSkill, 'function', 'skills.js must export linkSkill() for scope links');
});

t('listSkills follows symlinked skill dirs (shared skills visible in session store)', async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10sh-'));
  const sess = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10ss-'));
  await skillsApi.createSkill(shared, { name: 'shared-skill', content: 'x' });
  await skillsApi.linkSkill(sess, 'shared-skill', path.join(shared, '.claude', 'skills', 'shared-skill'));
  const out = await skillsApi.listSkills(sess);
  assert.strictEqual(out.skills.length, 1, 'a symlinked shared skill must appear in listSkills');
  assert.strictEqual(out.skills[0].name, 'shared-skill', 'the symlinked skill must be listed by name');
  fs.rmSync(shared, { recursive: true, force: true });
  fs.rmSync(sess, { recursive: true, force: true });
});

t('linkSkill: no-clobber (ERR_EXISTS) + missing target (ERR_NOT_FOUND)', async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10sh-'));
  const sess = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10ss-'));
  await skillsApi.createSkill(sess, { name: 'taken', content: 'x' });
  await skillsApi.createSkill(shared, { name: 'taken', content: 'y' });
  await assert.rejects(
    () => skillsApi.linkSkill(sess, 'taken', path.join(shared, '.claude', 'skills', 'taken')),
    (e) => e.code === 'ERR_EXISTS',
    'linking over an existing session skill must fail with ERR_EXISTS (never clobber)'
  );
  await assert.rejects(
    () => skillsApi.linkSkill(sess, 'ghost', path.join(shared, '.claude', 'skills', 'ghost')),
    (e) => e.code === 'ERR_NOT_FOUND',
    'linking a nonexistent shared skill must fail with ERR_NOT_FOUND'
  );
  fs.rmSync(shared, { recursive: true, force: true });
  fs.rmSync(sess, { recursive: true, force: true });
});

t('deleteSkill on a symlink drops the link, not the shared target', async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10sh-'));
  const sess = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10ss-'));
  await skillsApi.createSkill(shared, { name: 'keep-me', content: 'x' });
  const target = path.join(shared, '.claude', 'skills', 'keep-me');
  await skillsApi.linkSkill(sess, 'keep-me', target);
  const out = await skillsApi.deleteSkill(sess, 'keep-me');
  assert.ok(out.deleted, 'deleteSkill on a link must report deleted:true');
  assert.ok(!fs.existsSync(path.join(sess, '.claude', 'skills', 'keep-me')), 'the session-store link must be gone');
  assert.ok(fs.existsSync(path.join(target, 'SKILL.md')), 'the shared target dir must SURVIVE a link deletion');
  fs.rmSync(shared, { recursive: true, force: true });
  fs.rmSync(sess, { recursive: true, force: true });
});

t('skills.js listSkills skips dangling symlinks without throwing', async () => {
  const sess = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10ss-'));
  const store = path.join(sess, '.claude', 'skills');
  fs.mkdirSync(store, { recursive: true });
  fs.symlinkSync(path.join(os.tmpdir(), 'definitely-not-here-xyz'), path.join(store, 'dangling'), 'dir');
  const out = await skillsApi.listSkills(sess);
  assert.strictEqual(out.skills.length, 0, 'a dangling symlink must be skipped, not listed or thrown');
  fs.rmSync(sess, { recursive: true, force: true });
});

// ─── index.js: scope routing (static contract checks) ───

t('index.js: _skillStores resolves session/user/global stores', () => {
  assert.ok(/function _skillStores\(/.test(SRV), '_skillStores must exist (three-store layout)');
  assert.ok(/rec\.user \|\| 'default'/.test(SRV), 'user store must key off rec.user (fallback for single-user mode)');
  assert.ok(/getWorkspace\(\)/.test(SRV), 'user/global stores must anchor at sessions.getWorkspace()');
});

t('index.js: POST /skills + /skills/import accept body.scope', () => {
  for (const route of ["app.post('/sessions/:id/skills'", "app.post('/sessions/:id/skills/import'"]) {
    const at = SRV.search(new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(at > 0, `${route} route must exist`);
    const body = SRV.slice(at, at + 2200);
    assert.ok(/_skillScope\(/.test(body), `${route} must read the request scope via _skillScope`);
    assert.ok(/stores\[scope\]/.test(body), `${route} must route non-session scopes to the shared store`);
    assert.ok(/linkSkill\(/.test(body), `${route} must link shared uploads into the session store for SDK visibility`);
  }
});

t('index.js: _skillScope defaults unknown values to session', () => {
  const at = SRV.search(/function _skillScope\(/);
  assert.ok(at > 0, '_skillScope must exist');
  const body = SRV.slice(at, at + 400);
  assert.ok(/'session'/.test(body), 'default scope must be session (pre-delm-10 behaviour preserved)');
});

t('index.js: GET /skills merges stores + tags scope (session shadows wider)', () => {
  const at = SRV.search(/async function _listSkillsMerged\(/);
  assert.ok(at > 0, '_listSkillsMerged must exist');
  const body = SRV.slice(at, at + 2000);
  assert.ok(/\['global', 'user', 'session'\]/.test(body), 'merge order must be global → user → session so narrower scopes shadow wider ones');
  assert.ok(/scope\s*\)/.test(body), 'each merged entry must carry a scope tag');
  const getAt = SRV.search(/app\.get\('\/sessions\/:id\/skills'/);
  const getBody = SRV.slice(getAt, getAt + 900);
  assert.ok(/_listSkillsMerged\(/.test(getBody), 'GET /skills must serve the merged list');
});

t('index.js: toggle links shared skills in before enabling', () => {
  const at = SRV.search(/app\.post\('\/sessions\/:id\/skills\/toggle'/);
  const body = SRV.slice(at, at + 3000);
  assert.ok(/merged\.scopes\.get\(name\)/.test(body), 'toggle must consult the merged scopes map for the skill');
  assert.ok(/linkSkill\(stores\.session, name/.test(body), 'toggle must link a shared skill into the session store before pinning the SDK filter');
});

t('index.js: DELETE routes by ?scope; session links only drop the link', () => {
  const at = SRV.search(/app\.delete\('\/sessions\/:id\/skills\/:name'/);
  const body = SRV.slice(at, at + 2500);
  assert.ok(/req\.query && req\.query\.scope/.test(body), 'DELETE must accept ?scope=user|global for shared-store deletion');
  assert.ok(/stores\[qScope\]/.test(body), 'DELETE with scope must target the shared store');
  assert.ok(/deleteSkill\(stores\.session/.test(body), 'DELETE without scope must target the session store (link-safe)');
});

t('skills.js listSkills marks symlink dirs followable (static)', () => {
  assert.ok(/isSymbolicLink\(\)/.test(SKILLS_SRC), 'listSkills must explicitly admit symlinked entries (withFileTypes reports them as non-dirs)');
});

// ─── skills.js: shared-store ownership gate (deleteSkillShared) ───

t('writeSkillMeta + deleteSkillShared: uploader may delete, others get ERR_FORBIDDEN', async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10sh-'));
  await skillsApi.createSkill(shared, { name: 'owned', content: 'x' });
  await skillsApi.writeSkillMeta(shared, 'owned', 'alice');
  // Non-uploader without a code → 403-shaped ERR_FORBIDDEN.
  await assert.rejects(
    () => skillsApi.deleteSkillShared(shared, 'owned', { deleter: 'bob', deleteCode: '', scope: 'user' }),
    (e) => e.code === 'ERR_FORBIDDEN',
    'a non-uploading user must NOT be able to delete a shared skill'
  );
  // The uploader may delete their own.
  const out = await skillsApi.deleteSkillShared(shared, 'owned', { deleter: 'alice', deleteCode: '', scope: 'user' });
  assert.ok(out.deleted, 'the uploading user must be able to delete their own shared skill');
  assert.ok(!fs.existsSync(path.join(shared, '.claude', 'skills', 'owned')), 'skill dir must be gone');
  // The meta record is dropped with the skill (else a same-named
  // re-upload by someone else would inherit the old uploader).
  assert.ok(!fs.existsSync(path.join(shared, '.claude', 'skills', 'owned.skill-meta.json')),
    'the .skill-meta.json record must be removed with the skill');
  fs.rmSync(shared, { recursive: true, force: true });
});

t('deleteSkillShared: unknown uploader record locks the skill (code-only)', async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10sh-'));
  await skillsApi.createSkill(shared, { name: 'orphan', content: 'x' });
  // No writeSkillMeta call → no record → nobody is the uploader.
  await assert.rejects(
    () => skillsApi.deleteSkillShared(shared, 'orphan', { deleter: 'alice', deleteCode: '', scope: 'user' }),
    (e) => e.code === 'ERR_FORBIDDEN',
    'a missing ownership record must NOT let an arbitrary user delete the skill'
  );
  fs.rmSync(shared, { recursive: true, force: true });
});

t('deleteSkillShared: system delete code unlocks a global skill (constant-time path)', async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10sh-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10st-'));
  process.env.MYCO_SKILL_DELETE_CODE = '';   // ensure env never wins below
  delete process.env.MYCO_SKILL_DELETE_CODE;
  process.env.MYCO_STATE_DIR = stateDir;
  await skillsApi.createSkill(shared, { name: 'market', content: 'x' });
  await skillsApi.writeSkillMeta(shared, 'market', 'alice');
  // A WRONG code must not unlock (and must not throw — same 403 path).
  await assert.rejects(
    () => skillsApi.deleteSkillShared(shared, 'market', { deleter: 'bob', deleteCode: 'wrong', scope: 'global' }),
    (e) => e.code === 'ERR_FORBIDDEN',
    'a wrong system delete code must NOT delete a global skill'
  );
  // The REAL code (read from the state file the server generates)
  // unlocks even for a non-uploader — the operator escape hatch.
  const codeFile = path.join(stateDir, 'skill-market', 'delete-code');
  assert.ok(fs.existsSync(codeFile), 'the system delete code file must be generated under MYCO_STATE_DIR');
  const code = fs.readFileSync(codeFile, 'utf8').trim();
  const out = await skillsApi.deleteSkillShared(shared, 'market', { deleter: 'bob', deleteCode: code, scope: 'global' });
  assert.ok(out.deleted, 'the system delete code must unlock deletion of a global skill');
  fs.rmSync(shared, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// ─── index.js: ownership-gate wiring (static) ───

t('index.js: shared uploads record the uploader; shared DELETE goes through the gate', () => {
  for (const route of ["app.post('/sessions/:id/skills'", "app.post('/sessions/:id/skills/import'"]) {
    const at = SRV.search(new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const body = SRV.slice(at, at + 2600);
    assert.ok(/writeSkillMeta\(stores\[scope\], skill\.dirName, req\.user\)/.test(body),
      `${route} must record the uploader for shared-scope uploads (delete gate depends on it)`);
  }
  const delAt = SRV.search(/app\.delete\('\/sessions\/:id\/skills\/:name'/);
  const delBody = SRV.slice(delAt, delAt + 3000);
  assert.ok(/deleteSkillShared\(/.test(delBody), 'DELETE ?scope=user|global must go through deleteSkillShared (ownership gate)');
  assert.ok(/deleter: req\.user/.test(delBody), 'the gate must receive the requesting user as deleter');
  assert.ok(/ERR_FORBIDDEN'/.test(SRV) && /status\(403\)/.test(SRV.slice(SRV.search(/function fileApiError/), SRV.search(/function fileApiError/) + 700)),
    'fileApiError must map ERR_FORBIDDEN to 403');
});
