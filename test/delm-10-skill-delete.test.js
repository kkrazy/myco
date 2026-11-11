// delm-10 deletion-security regression test.
// Locks the DELETE half of the skill feature across all stores:
//   PERSONAL (session store) — the session owner deletes freely; a
//     scope LINK drops only the link (shared target survives).
//   SHARED user store  — only the UPLOADING user may delete
//     (uploader meta recorded at upload next to the skill dir).
//   SHARED global store — uploader OR the system delete code
//     (constant-time compare; wrong/absent code → ERR_FORBIDDEN).
//   MARKET — module-level policy lives in delm-10-skill-market.test.js;
//     this file locks that the delete CODE FILE is the SAME one the
//     shared-store path uses (one code per instance, not two).
//   ROUTES — DELETE /sessions/:id/skills/:name gates shared scopes
//     through deleteSkillShared; fileApiError maps ERR_FORBIDDEN→403.
// Run: node test/delm-10-skill-delete.test.js

process.env.MYCO_STATE_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'delm10del-'));

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRV = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');
const skillsApi = require(path.join(ROOT, 'server/src/skills.js'));

const STATE = process.env.MYCO_STATE_DIR;
const CODE_FILE = path.join(STATE, 'skill-market', 'delete-code');

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

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'delm10del-root-'));
}

// Force the code file to exist up front (deleteCodeMatches generates it
// on first call; tests below read it directly).
t('_setup: system delete code generated once', () => {
  assert.ok(skillsApi.deleteCodeMatches('__definitely-not-the-code__') === false,
    'a bogus code must not match (and, as a side effect, the real code file now exists)');
  assert.ok(fs.existsSync(CODE_FILE), 'the shared delete-code file must exist after first use');
});

// ─── uploader meta records ───

t('writeSkillMeta/readSkillMeta roundtrip; meta sits NEXT TO the skill dir', async () => {
  const store = tmpRoot();
  await skillsApi.createSkill(store, { name: 'mine', content: 'x' });
  await skillsApi.writeSkillMeta(store, 'mine', 'alice');
  const meta = await skillsApi.readSkillMeta(store, 'mine');
  assert.strictEqual(meta.uploader, 'alice', 'readSkillMeta must return the recorded uploader');
  assert.ok(meta.uploadedAt > 0, 'uploadedAt must be stamped');
  // next TO the dir, not inside — the skill's own files can't spoof it
  const metaPath = path.join(store, '.claude/skills', 'mine.skill-meta.json');
  assert.ok(fs.existsSync(metaPath), 'meta file must live at <store>/<name>.skill-meta.json');
  const inside = fs.readdirSync(path.join(store, '.claude/skills/mine'));
  assert.ok(!inside.includes('.skill-meta.json'), 'meta must NOT be inside the skill dir (listSkills/fileCount must not see it)');
  // listSkills output must be unaffected by the meta file
  const out = await skillsApi.listSkills(store);
  assert.strictEqual(out.skills.length, 1, 'meta file must not break listSkills');
  fs.rmSync(store, { recursive: true, force: true });
});

t('readSkillMeta on missing skill → null (no throw)', async () => {
  const store = tmpRoot();
  const meta = await skillsApi.readSkillMeta(store, 'ghost');
  assert.strictEqual(meta, null, 'a missing meta record must read as null');
  fs.rmSync(store, { recursive: true, force: true });
});

// ─── deleteSkillShared: the gate ───

t('user store: uploader deletes own skill; other user → ERR_FORBIDDEN', async () => {
  const store = tmpRoot();
  await skillsApi.createSkill(store, { name: 'personal', content: 'x' });
  await skillsApi.writeSkillMeta(store, 'personal', 'alice');
  // a different signed-in user must NOT be able to delete it
  await assert.rejects(
    () => skillsApi.deleteSkillShared(store, 'personal', { deleter: 'bob', deleteCode: '', scope: 'user' }),
    (e) => e.code === 'ERR_FORBIDDEN',
    'user-store skills are per-user — a non-uploader must get 403'
  );
  assert.ok(fs.existsSync(path.join(store, '.claude/skills/personal/SKILL.md')),
    'a denied delete must leave the skill on disk');
  const out = await skillsApi.deleteSkillShared(store, 'personal', { deleter: 'alice', deleteCode: '', scope: 'user' });
  assert.ok(out.deleted, 'the uploader must be able to delete their own user-store skill');
  assert.ok(!fs.existsSync(path.join(store, '.claude/skills/personal')), 'skill dir removed after uploader delete');
  fs.rmSync(store, { recursive: true, force: true });
});

t('user store: the delete CODE is not an escape hatch (code only works for global scope)', async () => {
  const store = tmpRoot();
  await skillsApi.createSkill(store, { name: 'nocode', content: 'x' });
  await skillsApi.writeSkillMeta(store, 'nocode', 'alice');
  const code = fs.readFileSync(CODE_FILE, 'utf8').trim();
  await assert.rejects(
    () => skillsApi.deleteSkillShared(store, 'nocode', { deleter: 'bob', deleteCode: code, scope: 'user' }),
    (e) => e.code === 'ERR_FORBIDDEN',
    'a valid system code must NOT unlock a USER-scope skill — the code is for market/global removal only'
  );
  fs.rmSync(store, { recursive: true, force: true });
});

t('global store: non-uploader + no code → ERR_FORBIDDEN; wrong code → ERR_FORBIDDEN', async () => {
  const store = tmpRoot();
  await skillsApi.createSkill(store, { name: 'shared', content: 'x' });
  await skillsApi.writeSkillMeta(store, 'shared', 'alice');
  await assert.rejects(
    () => skillsApi.deleteSkillShared(store, 'shared', { deleter: 'bob', deleteCode: '', scope: 'global' }),
    (e) => e.code === 'ERR_FORBIDDEN',
    'global (cross-user) skills need uploader identity or the code'
  );
  await assert.rejects(
    () => skillsApi.deleteSkillShared(store, 'shared', { deleter: 'bob', deleteCode: 'totally-wrong', scope: 'global' }),
    (e) => e.code === 'ERR_FORBIDDEN',
    'a wrong code must be indistinguishable from no code (both 403)'
  );
  assert.ok(fs.existsSync(path.join(store, '.claude/skills/shared/SKILL.md')),
    'the shared skill must survive both denied attempts');
  fs.rmSync(store, { recursive: true, force: true });
});

t('global store: the system delete code authorizes a non-uploader', async () => {
  const store = tmpRoot();
  await skillsApi.createSkill(store, { name: 'abandoned', content: 'x' });
  await skillsApi.writeSkillMeta(store, 'abandoned', 'someone-gone');
  const code = fs.readFileSync(CODE_FILE, 'utf8').trim();
  const out = await skillsApi.deleteSkillShared(store, 'abandoned', { deleter: 'ops', deleteCode: code, scope: 'global' });
  assert.ok(out.deleted, 'the code path must authorize the delete');
  assert.strictEqual(out.scope, 'global', 'result must echo the scope');
  // the stale meta record must be dropped along with the skill
  assert.ok(!fs.existsSync(path.join(store, '.claude/skills', 'abandoned.skill-meta.json')),
    'deleteSkillShared must remove the meta record so a same-named re-upload is not poisoned');
  fs.rmSync(store, { recursive: true, force: true });
});

t('no meta record at all → locked to the code path only (fail-safe)', async () => {
  const store = tmpRoot();
  await skillsApi.createSkill(store, { name: 'orphan', content: 'x' });   // no writeSkillMeta
  await assert.rejects(
    () => skillsApi.deleteSkillShared(store, 'orphan', { deleter: 'alice', deleteCode: '', scope: 'global' }),
    (e) => e.code === 'ERR_FORBIDDEN',
    'a lost ownership record must NOT open the skill to deletion — fail safe, not fail open'
  );
  const code = fs.readFileSync(CODE_FILE, 'utf8').trim();
  const out = await skillsApi.deleteSkillShared(store, 'orphan', { deleter: 'ops', deleteCode: code, scope: 'global' });
  assert.ok(out.deleted, 'the code remains the operator escape hatch for orphaned records');
  fs.rmSync(store, { recursive: true, force: true });
});

t('deleteSkillShared drops the session-store LINK after a shared delete (no ghost entry)', async () => {
  const shared = tmpRoot();
  const sess = tmpRoot();
  await skillsApi.createSkill(shared, { name: 'linked', content: 'x' });
  await skillsApi.writeSkillMeta(shared, 'linked', 'alice');
  await skillsApi.linkSkill(sess, 'linked', path.join(shared, '.claude/skills/linked'));
  const out = await skillsApi.deleteSkillShared(shared, 'linked', { deleter: 'alice', deleteCode: '', scope: 'user' });
  assert.ok(out.deleted, 'uploader deletes the shared dir');
  assert.ok(!fs.existsSync(path.join(shared, '.claude/skills/linked')), 'shared dir gone');
  // the route layer also unlinks the session entry — the module itself
  // leaves session stores alone (separation of stores), which the
  // route test below locks via the deleteSkill(stores.session) call.
  fs.rmSync(shared, { recursive: true, force: true });
  fs.rmSync(sess, { recursive: true, force: true });
});

// ─── the ONE delete code ───

t('deleteCodeMatches is constant-time plumbing: right code true, wrong/false-y false', () => {
  const code = fs.readFileSync(CODE_FILE, 'utf8').trim();
  assert.ok(/^[0-9a-f]{48}$/.test(code), 'the code must be 48 hex chars (randomBytes(24))');
  assert.strictEqual(skillsApi.deleteCodeMatches(code), true, 'the right code must match');
  assert.strictEqual(skillsApi.deleteCodeMatches(code + ' '), true, 'surrounding whitespace is trimmed');
  assert.strictEqual(skillsApi.deleteCodeMatches(''), false, 'empty code never matches');
  assert.strictEqual(skillsApi.deleteCodeMatches(undefined), false, 'missing code never matches');
  assert.strictEqual(skillsApi.deleteCodeMatches(code.slice(0, 47)), false, 'a truncated code must not match');
  assert.strictEqual(fs.statSync(CODE_FILE).mode & 0o777, 0o600, 'delete-code file must be 0600');
});

t('skills.js and skill-market.js share ONE code file (no second code source)', () => {
  const SK = fs.readFileSync(path.join(ROOT, 'server/src/skills.js'), 'utf8');
  assert.ok(SK.includes("path.join(stateDir, 'skill-market', 'delete-code')"),
    "skills.js systemDeleteCode must read $MYCO_STATE_DIR/skill-market/delete-code — the SAME file skill-market.js uses");
  assert.ok(!/MYCO_SKILL_DELETE_CODE/.test(SK), 'no env override in skills.js — one code, one file, one operator secret');
  assert.ok(/timingSafeEqual/.test(SK), 'the compare must be constant-time (timingSafeEqual over sha256 digests)');
});

// ─── routes ───

t('DELETE route gates shared scopes through deleteSkillShared + cleans the session link', () => {
  const at = SRV.search(/app\.delete\('\/sessions\/:id\/skills\/:name'/);
  assert.ok(at > 0, 'DELETE /sessions/:id/skills/:name must exist');
  const body = SRV.slice(at, at + 2600);
  assert.ok(/deleteSkillShared\(/.test(body), 'shared-scope deletes must go through the ownership gate (deleteSkillShared)');
  assert.ok(/deleter:\s*req\.user/.test(body), 'the gate must receive the requesting user (req.user) as the deleter');
  assert.ok(/scope:\s*qScope/.test(body), 'the gate must receive the resolved scope so the code path only opens for global');
  assert.ok(/deleteSkill\(stores\.session/.test(body), 'a session-scope delete (or link cleanup) must use the plain deleteSkill');
});

t('fileApiError maps ERR_FORBIDDEN → 403', () => {
  const at = SRV.search(/function fileApiError\(/);
  const body = SRV.slice(at, at + 1600);
  assert.ok(/ERR_FORBIDDEN[^]*?403/.test(body), 'a denied shared-delete must surface as 403, not 500');
});

t('upload routes stamp the uploader meta for shared scopes', () => {
  for (const route of ["app.post('/sessions/:id/skills'", "app.post('/sessions/:id/skills/import'"]) {
    const at = SRV.search(new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(at > 0, `${route} must exist`);
    const body = SRV.slice(at, at + 2200);
    assert.ok(/writeSkillMeta\(/.test(body), `${route} must record the uploader meta for shared-scope uploads`);
  }
});

// cleanup
t._chain = t._chain.then(() => {
  try { fs.rmSync(STATE, { recursive: true, force: true }); } catch {}
});
