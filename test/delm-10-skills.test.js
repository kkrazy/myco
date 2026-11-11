// delm-10: skill selection + upload/import regression test.
// Locks both halves of the feature:
//   SERVER — server/src/skills.js exports listSkills/readSkill/
//     createSkill/importSkill/deleteSkill with containment,
//     no-clobber, front-matter parsing + wrapper-dir unwrapping
//     (functional, run against a tmp dir); server/src/index.js
//     exposes the GET/POST/DELETE skills routes gated 'viewer' (GET)
//     / 'owner' (mutations); agent-session.js passes sdkOpts.skills
//     ('all' when no selection) and sessions.js re-seeds
//     enabledSkills at spawn/respawn.
//   CLIENT — web/public/index.html has the skills panel + upload
//     input; app.js binds them (_skillsLoad/_skillsToggle/
//     _skillsUpload); styles.css styles the panel.
// Run: node test/delm-10-skills.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web/public/index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web/public/styles.css'), 'utf8');
const SRV = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');
const SESS = fs.readFileSync(path.join(ROOT, 'server/src/sessions.js'), 'utf8');
const AGENT = fs.readFileSync(path.join(ROOT, 'server/src/agent-session.js'), 'utf8');
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

// ─── Server: skills.js functional behaviour ───

t('skills.js exports the five public fns', () => {
  for (const fn of ['listSkills', 'readSkill', 'createSkill', 'importSkill', 'deleteSkill']) {
    assert.strictEqual(typeof skillsApi[fn], 'function', `skills.js must export ${fn}()`);
  }
});

t('listSkills on a fresh workspace → empty list, no throw', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10sk-'));
  const out = await skillsApi.listSkills(root);
  assert.ok(Array.isArray(out.skills), 'listSkills must return {skills: []}');
  assert.strictEqual(out.skills.length, 0, 'fresh workspace must list zero skills');
  fs.rmSync(root, { recursive: true, force: true });
});

t('createSkill writes SKILL.md with front-matter + lists it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10sk-'));
  const s = await skillsApi.createSkill(root, { name: 'my-skill', description: 'demo', content: 'do the thing' });
  assert.strictEqual(s.dirName, 'my-skill', 'created skill must report its dir name');
  const md = fs.readFileSync(path.join(root, '.claude/skills/my-skill/SKILL.md'), 'utf8');
  assert.ok(/^---\nname: my-skill\n/.test(md), 'SKILL.md must carry the name in front-matter (SDK name match)');
  assert.ok(/description: demo/.test(md), 'SKILL.md must carry the description in front-matter');
  const out = await skillsApi.listSkills(root);
  assert.strictEqual(out.skills.length, 1, 'listSkills must see the new skill');
  assert.strictEqual(out.skills[0].name, 'my-skill', 'listed name comes from front-matter');
  fs.rmSync(root, { recursive: true, force: true });
});

t('createSkill refuses to clobber (ERR_EXISTS) + rejects bad names', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10sk-'));
  await skillsApi.createSkill(root, { name: 'a', content: 'x' });
  await assert.rejects(
    () => skillsApi.createSkill(root, { name: 'a', content: 'y' }),
    (e) => e.code === 'ERR_EXISTS',
    'duplicate skill name must fail with ERR_EXISTS (never clobber)'
  );
  await assert.rejects(() => skillsApi.createSkill(root, { name: '../esc', content: 'x' }), (e) => e.code === 'ERR_BAD_INPUT');
  await assert.rejects(() => skillsApi.createSkill(root, { name: 'a/b', content: 'x' }), (e) => e.code === 'ERR_BAD_INPUT');
  await assert.rejects(() => skillsApi.createSkill(root, { name: '.hidden', content: 'x' }), (e) => e.code === 'ERR_BAD_INPUT');
  fs.rmSync(root, { recursive: true, force: true });
});

t('importSkill unwraps a single wrapper dir + keeps helper files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10sk-'));
  const s = await skillsApi.importSkill(root, { files: [
    { path: 'pdf-report/SKILL.md', content: '---\nname: pdf-report\ndescription: make pdfs\n---\n\nsteps' },
    { path: 'pdf-report/scripts/render.js', content: 'console.log(1);' },
  ]});
  assert.strictEqual(s.dirName, 'pdf-report', 'wrapper dir name must become the skill name');
  assert.ok(fs.existsSync(path.join(root, '.claude/skills/pdf-report/scripts/render.js')),
    'nested helper files must land inside the skill dir');
  const out = await skillsApi.listSkills(root);
  assert.strictEqual(out.skills[0].fileCount, 2, 'fileCount must include helper files');
  fs.rmSync(root, { recursive: true, force: true });
});

t('importSkill: bare SKILL.md names via front-matter; missing name → ERR_BAD_INPUT', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10sk-'));
  const s = await skillsApi.importSkill(root, { files: [
    { path: 'SKILL.md', content: '---\nname: named-skill\ndescription: d\n---\n\nbody' },
  ]});
  assert.strictEqual(s.dirName, 'named-skill', 'front-matter name must be used when no wrapper dir');
  await assert.rejects(
    () => skillsApi.importSkill(root, { files: [{ path: 'SKILL.md', content: 'no front matter at all' }] }),
    (e) => e.code === 'ERR_BAD_INPUT',
    'a SKILL.md without name + without explicit name must be rejected, not silently imported'
  );
  fs.rmSync(root, { recursive: true, force: true });
});

t('importSkill rejects traversal + missing SKILL.md', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10sk-'));
  await assert.rejects(
    () => skillsApi.importSkill(root, { name: 'evil', files: [{ path: '../escape.sh', content: 'x' }] }),
    (e) => e.code === 'ERR_OUTSIDE',
    'import paths with .. must be rejected (containment)'
  );
  await assert.rejects(
    () => skillsApi.importSkill(root, { name: 'noskillmd', files: [{ path: 'helper.js', content: 'x' }] }),
    (e) => e.code === 'ERR_BAD_INPUT',
    'import without a root SKILL.md must be rejected'
  );
  fs.rmSync(root, { recursive: true, force: true });
});

t('deleteSkill removes the dir; deleting missing skill → ERR_NOT_FOUND', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delm10sk-'));
  await skillsApi.createSkill(root, { name: 'gone', content: 'x' });
  const out = await skillsApi.deleteSkill(root, 'gone');
  assert.ok(out.deleted, 'deleteSkill must report deleted:true');
  assert.ok(!fs.existsSync(path.join(root, '.claude/skills/gone')), 'skill dir must be gone from disk');
  await assert.rejects(() => skillsApi.deleteSkill(root, 'gone'), (e) => e.code === 'ERR_NOT_FOUND');
  fs.rmSync(root, { recursive: true, force: true });
});

// ─── Server: routes wired with the right access tiers ───

t('index.js routes: GET skills (viewer), POST/import/toggle/DELETE (owner)', () => {
  assert.ok(/app\.get\('\/sessions\/:id\/skills'[\s\S]{0,200}fileApiPreamble\(req, res, 'viewer'\)/.test(SRV),
    'GET /skills must exist and gate with fileApiPreamble(..., "viewer")');
  for (const [pat, tier] of [
    [/app\.post\('\/sessions\/:id\/skills'[\s\S]{0,200}fileApiPreamble\(req, res, 'owner'\)/, 'POST /skills'],
    [/app\.post\('\/sessions\/:id\/skills\/import'[\s\S]{0,200}fileApiPreamble\(req, res, 'owner'\)/, 'POST /skills/import'],
    [/app\.post\('\/sessions\/:id\/skills\/toggle'[\s\S]{0,200}fileApiPreamble\(req, res, 'owner'\)/, 'POST /skills/toggle'],
    [/app\.delete\('\/sessions\/:id\/skills\/:name'[\s\S]{0,200}fileApiPreamble\(req, res, 'owner'\)/, 'DELETE /skills/:name'],
  ]) {
    assert.ok(pat.test(SRV), `${tier} must exist and gate with fileApiPreamble(..., "owner")`);
  }
});

t('toggle route: last skill off clears filter to null ("all"); persists via putSession', () => {
  const at = SRV.search(/app\.post\('\/sessions\/:id\/skills\/toggle'/);
  assert.ok(at > 0, 'skills toggle route must exist');
  const body = SRV.slice(at, at + 3000);
  // NOTE: original pattern `/next\.length === 0\s*\n\s*next = null/`
  // can never match valid JS — an `if (…)` always closes with `)`
  // between the condition and the newline. Loosened to accept the
  // canonical one-liner `if (next.length === 0) next = null;` while
  // still proving the clear-to-null semantics.
  assert.ok(/if \(next\.length === 0\)\s*next = null/.test(body),
    'toggling off the LAST selected skill must clear enabledSkills to null (empty filter would hide every skill)');
  assert.ok(/delete ctx\.rec\.enabledSkills/.test(body), 'clearing the filter must delete the record field');
  assert.ok(/putSession\(ctx\.rec\)/.test(body), 'toggle must persist the record');
  assert.ok(/_applySkillsToLiveSession\(ctx\.rec\)/.test(body), 'toggle must push the change to the live session');
});

// ─── Server: SDK wiring ───

t('agent-session.js: sdkOpts.skills = selection or "all"; setSkills() exists', () => {
  assert.ok(/sdkOpts\.skills = \(Array\.isArray\(this\.enabledSkills\)/.test(AGENT),
    '_ensureIteration must set sdkOpts.skills from the selection');
  assert.ok(/: 'all';/.test(AGENT), 'no selection must pass "all" (SDK contract: string[] | \'all\')');
  assert.ok(/'skills'/.test(AGENT.slice(0, 4000)), "'skills' must be in SDK_OPTIONS_ALLOWLIST so fr-45 lint passes it");
  assert.ok(/setSkills\(names\)/.test(AGENT), 'AgentSession.setSkills() must exist (live toggle path)');
});

t('sessions.js: enabledSkills re-seeded at spawn + respawn', () => {
  assert.ok(/spawnAgent\(id, \{[\s\S]{0,600}enabledSkills: Array\.isArray\(record\.enabledSkills\)/.test(SESS),
    'spawnSession must forward record.enabledSkills');
  assert.ok(/const session = spawnAgent\(sessionId, \{[\s\S]{0,1200}enabledSkills: Array\.isArray\(rec\.enabledSkills\)/.test(SESS),
    'ensureLiveSession must re-seed rec.enabledSkills so the selection survives restarts');
  assert.ok(/\bputSession,\n/.test(SESS), 'putSession must be exported for the skills routes');
});

// ─── Client: panel + wiring ───

t('index.html has the skills panel + upload input', () => {
  assert.ok(/id="skills-panel"/.test(HTML), 'index.html must contain #skills-panel');
  assert.ok(/id="skills-list"/.test(HTML), 'index.html must contain #skills-list (selection checkboxes)');
  assert.ok(/id="skills-upload"/.test(HTML), 'index.html must contain #skills-upload (file input for import)');
  assert.ok(/id="skills-upload-btn"/.test(HTML), 'index.html must contain #skills-upload-btn');
});

t('app.js binds the skills UI (_skillsLoad / _skillsToggle / _skillsUpload)', () => {
  assert.ok(/async function _skillsLoad/.test(APP), '_skillsLoad must be defined');
  assert.ok(/async function _skillsToggle/.test(APP), '_skillsToggle must be defined');
  assert.ok(/async function _skillsUpload/.test(APP), '_skillsUpload must be defined');
  assert.ok(/\/skills\/toggle/.test(APP), 'app.js must POST to /sessions/:id/skills/toggle');
  assert.ok(/\/skills\/import/.test(APP) || /\/skills', \{/.test(APP), 'app.js must POST uploads to /skills or /skills/import');
});

t('app.js renders selection state from enabledSkills', () => {
  const at = APP.search(/async function _skillsLoad/);
  assert.ok(at > 0, '_skillsLoad must be defined');
  const body = APP.slice(at, at + 4000);
  assert.ok(/enabledSkills/.test(body), '_skillsLoad must read enabledSkills from the GET /skills response');
  assert.ok(/checked/.test(body), 'skill rows must render a checked state for selected skills');
});

t('styles.css styles the skills panel', () => {
  assert.ok(/#skills-panel[^{]*\{/.test(CSS), 'styles must target #skills-panel');
  assert.ok(/#skills-list[^{]*\{/.test(CSS), 'styles must target #skills-list');
});

// Regression (user report: "can't find the #btn-skills button"): the
// Skills chrome button shipped with NO positioning rules, so once
// unhidden by updateChatButton() it rendered in-flow at the top of
// #terminal-pane and was covered by the absolutely-positioned
// .artifact-main-view panes. Siblings #btn-files/plan/arch/test all
// get position:fixed + top + z-index:50 + a right-edge slot; the
// Skills button needs the same treatment to appear in the cluster.
t('styles.css positions #btn-skills in the fixed chrome cluster', () => {
  const rules = [...CSS.matchAll(/#btn-skills\s*\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(rules.length > 0, 'styles must contain #btn-skills { … } rules — without them the button renders in-flow and is covered by the main panes (invisible)');
  assert.ok(rules.some((r) => /position:\s*fixed/.test(r)), 'a #btn-skills rule must be position:fixed like the other chrome buttons');
  assert.ok(rules.some((r) => /z-index:\s*50/.test(r)), 'a #btn-skills rule must be z-index:50 to float above the main-pane views');
  assert.ok(rules.some((r) => /right:\s*calc\(/.test(r)), '#btn-skills must have a right-edge slot calc so it sits in the chrome cluster instead of stacking under #btn-test');
});
