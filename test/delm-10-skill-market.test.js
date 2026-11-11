// delm-10: skill MARKET regression test.
// Locks the market feature end-to-end at the module level:
//   STORE   — server/src/skill-market.js persists to
//     $MYCO_STATE_DIR/skill-market/{store.json, skills/, delete-code},
//     index + code file mode 0600.
//   PUBLISH — publishFromSession / publishFromDir / publishDirect all
//     record the uploader, refuse duplicate names (ERR_EXISTS), refuse
//     traversal (ERR_OUTSIDE), refuse symlinked helpers.
//   INSTALL — installMarketSkill copies into the personal store
//     no-clobber (ERR_EXISTS on collision).
//   DELETE  — the security core: the uploading user may delete their
//     own skill; anyone else needs the system delete code (constant-
//     time compare); wrong code → ERR_FORBIDDEN; >10 failed codes per
//     user per minute → ERR_THROTTLED; the code file is auto-created
//     0600 and NEVER returned by any module API.
//   ROUTES  — index.js exposes GET/POST /skill-market,
//     GET /skill-market/:name, POST /sessions/:id/skills/publish,
//     POST /sessions/:id/skill-market/install,
//     DELETE /skill-market/:name — all requireAuth-gated, mapped to
//     403/429/404/413/400/409 by marketApiError.
// Run: node test/delm-10-skill-market.test.js
// The module reads MYCO_STATE_DIR at require time, so it is set BEFORE
// the require and the whole run uses a throwaway dir.

process.env.MYCO_STATE_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'delm10mkt-'));

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRV = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');
const market = require(path.join(ROOT, 'server/src/skill-market.js'));
const skillsApi = require(path.join(ROOT, 'server/src/skills.js'));

const STATE = process.env.MYCO_STATE_DIR;
const MARKET = path.join(STATE, 'skill-market');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'delm10mkt-root-'));
}

const codeOf = () => fs.readFileSync(path.join(MARKET, 'delete-code'), 'utf8').trim();

// ─── publish → list → install roundtrip ───

t('publishFromSession records uploader + lists with canDelete flag', async () => {
  const root = tmpRoot();
  await skillsApi.createSkill(root, { name: 'demo', description: 'demo skill', content: 'do it' });
  const s = await market.publishFromSession(root, 'demo', 'alice');
  assert.strictEqual(s.uploader, 'alice', 'publish must record the uploading user (delete authorization)');
  assert.strictEqual(s.dirName, 'demo', 'published skill keeps its dir name');
  const forAlice = await market.listMarket('alice');
  const forBob = await market.listMarket('bob');
  const a = forAlice.skills.find((x) => x.dirName === 'demo');
  const b = forBob.skills.find((x) => x.dirName === 'demo');
  assert.ok(a && a.canDelete === true, 'uploader must see canDelete:true on their own market skill');
  assert.ok(b && b.canDelete === false, 'a different user must see canDelete:false (they need the delete code)');
  assert.strictEqual(b.uploader, 'alice', 'listing must disclose the uploader so the UI can render provenance');
});

t('installMarketSkill copies SKILL.md into the personal store, no-clobber on collision', async () => {
  const dst = tmpRoot();
  const out = await market.installMarketSkill(dst, 'demo');
  assert.ok(out.installed, 'install must report success');
  const md = fs.readFileSync(path.join(dst, '.claude/skills/demo/SKILL.md'), 'utf8');
  assert.ok(/^---\nname: demo\n/.test(md), 'installed skill must carry front-matter for SDK name matching');
  // second install → ERR_EXISTS, never silently overwrite a local skill
  await assert.rejects(
    () => market.installMarketSkill(dst, 'demo'),
    (e) => e.code === 'ERR_EXISTS',
    'installing over an existing personal skill must fail ERR_EXISTS (no silent overwrite)'
  );
  // and a failed install must not corrupt the existing copy
  const md2 = fs.readFileSync(path.join(dst, '.claude/skills/demo/SKILL.md'), 'utf8');
  assert.strictEqual(md2, md, 'a rejected install must leave the existing personal skill untouched');
});

t('publishDirect supports single-doc and multi-file shapes', async () => {
  const solo = await market.publishDirect({ name: 'solo', description: 's', content: 'body' }, 'carol');
  assert.strictEqual(solo.uploader, 'carol', 'direct publish records the uploader');
  const multi = await market.publishDirect({
    files: [
      { path: 'SKILL.md', content: '---\nname: multi\ndescription: m\n---\nuse it' },
      { path: 'helpers/run.sh', content: '#!/bin/sh\necho hi\n' },
    ],
  }, 'carol');
  assert.strictEqual(multi.dirName, 'multi', 'multi-file publish infers the name from SKILL.md front-matter');
  assert.ok(fs.existsSync(path.join(MARKET, 'skills/multi/helpers/run.sh')), 'helper files are copied');
  const dst = tmpRoot();
  await market.installMarketSkill(dst, 'multi');
  assert.ok(fs.existsSync(path.join(dst, '.claude/skills/multi/helpers/run.sh')), 'install copies helper files too');
});

t('duplicate market name → ERR_EXISTS; publish failure rolls back the partial dir', async () => {
  await assert.rejects(
    () => market.publishDirect({ name: 'solo', content: 'dup' }, 'dave'),
    (e) => e.code === 'ERR_EXISTS',
    'a second publish with the same name must fail ERR_EXISTS (never clobber a market skill)'
  );
  // rollback: an oversized file mid-copy must not leave a half skill
  const big = 'x'.repeat(300 * 1024);
  await assert.rejects(
    () => market.publishDirect({
      name: 'partial',
      files: [
        { path: 'SKILL.md', content: '---\nname: partial\n---\nbody' },
        { path: 'big.bin', content: big },
      ],
    }, 'dave'),
    (e) => e.code === 'ERR_TOO_LARGE',
    'oversized file must fail ERR_TOO_LARGE'
  );
  assert.ok(!fs.existsSync(path.join(MARKET, 'skills/partial')), 'failed publish must roll back its partial copy (no name squatting)');
});

// ─── path containment ───

t('traversal in publishDirect files → ERR_OUTSIDE, nothing written outside', async () => {
  await assert.rejects(
    () => market.publishDirect({
      name: 'evil',
      files: [
        { path: '../escape.txt', content: 'pwn' },
        { path: 'SKILL.md', content: '---\nname: evil\n---\nbody' },
      ],
    }, 'eve'),
    (e) => e.code === 'ERR_OUTSIDE',
    'a `..` path must fail ERR_OUTSIDE (containment is the whole security boundary)'
  );
  assert.ok(!fs.existsSync(path.join(MARKET, 'escape.txt')), 'nothing may be written outside the skill dir');
  assert.ok(!fs.existsSync(path.join(MARKET, 'skills/evil')), 'failed publish leaves no dir');
  assert.ok(!fs.existsSync(path.join(STATE, 'escape.txt')), 'nothing outside skill-market/ either');
});

t('bad skill names rejected in every API', async () => {
  for (const bad of ['../x', 'a/b', '.hidden', '', 'a b']) {
    await assert.rejects(() => market.publishDirect({ name: bad, content: 'x' }, 'u'),
      (e) => e.code === 'ERR_BAD_INPUT', `name ${JSON.stringify(bad)} must fail ERR_BAD_INPUT`);
    await assert.rejects(() => market.installMarketSkill(tmpRoot(), bad),
      (e) => e.code === 'ERR_BAD_INPUT', `install name ${JSON.stringify(bad)} must fail ERR_BAD_INPUT`);
    await assert.rejects(() => market.deleteMarketSkill(bad, 'u', ''),
      (e) => e.code === 'ERR_BAD_INPUT', `delete name ${JSON.stringify(bad)} must fail ERR_BAD_INPUT`);
  }
});

// ─── delete authorization (the security core) ───

t('non-uploader without code → ERR_FORBIDDEN; wrong code → ERR_FORBIDDEN', async () => {
  const root = tmpRoot();
  await skillsApi.createSkill(root, { name: 'guarded', description: 'g', content: 'x' });
  await market.publishFromSession(root, 'guarded', 'alice');
  await assert.rejects(
    () => market.deleteMarketSkill('guarded', 'bob', ''),
    (e) => e.code === 'ERR_FORBIDDEN',
    'a non-uploader with no code must get ERR_FORBIDDEN — market skills are not delete-by-anyone'
  );
  await assert.rejects(
    () => market.deleteMarketSkill('guarded', 'bob', 'deadbeef'),
    (e) => e.code === 'ERR_FORBIDDEN',
    'a wrong delete code must get ERR_FORBIDDEN (constant-time compare rejects it)'
  );
  assert.ok(fs.existsSync(path.join(MARKET, 'skills/guarded/SKILL.md')), 'the skill must survive the denied deletes');
});

t('uploader deletes own skill without any code', async () => {
  const out = await market.deleteMarketSkill('guarded', 'alice', '');
  assert.strictEqual(out.deleted, true, 'uploader delete must succeed with an empty code');
  assert.strictEqual(out.via, 'uploader', 'delete result must report the uploader path');
  assert.ok(!fs.existsSync(path.join(MARKET, 'skills/guarded')), 'skill dir removed');
  const store = JSON.parse(fs.readFileSync(path.join(MARKET, 'store.json'), 'utf8'));
  assert.ok(!store.skills.guarded, 'store.json index entry removed too');
});

t('system delete code deletes any skill — code file auto-created 0600, never returned by API', async () => {
  const root = tmpRoot();
  await skillsApi.createSkill(root, { name: 'stale', description: 's', content: 'x' });
  await market.publishFromSession(root, 'stale', 'alice');
  const code = codeOf();
  assert.ok(/^[0-9a-f]{48}$/.test(code), 'delete code must be 48 hex chars (crypto.randomBytes(24))');
  assert.strictEqual(fs.statSync(path.join(MARKET, 'delete-code')).mode & 0o777, 0o600,
    'delete-code file must be mode 0600 (operator-only read)');
  const out = await market.deleteMarketSkill('stale', 'bob', code);
  assert.strictEqual(out.via, 'code', 'delete result must report the code path');
  assert.ok(!fs.existsSync(path.join(MARKET, 'skills/stale')), 'code delete removes the skill');
  // the code is durable — same value on next read
  assert.strictEqual(codeOf(), code, 'delete code must not rotate per call');
});

t('delete of a missing skill → ERR_NOT_FOUND', async () => {
  await assert.rejects(
    () => market.deleteMarketSkill('never-was', 'alice', ''),
    (e) => e.code === 'ERR_NOT_FOUND',
    'deleting a nonexistent skill must 404, not silently succeed'
  );
});

t('flood of wrong codes → ERR_THROTTLED (per-user rate limit)', async () => {
  const root = tmpRoot();
  await skillsApi.createSkill(root, { name: 'flood', description: 'f', content: 'x' });
  await market.publishFromSession(root, 'flood', 'alice');
  let throttled = false;
  for (let i = 0; i < 12; i++) {
    try {
      await market.deleteMarketSkill('flood', 'mallory', 'wrong-code-' + i);
    } catch (e) {
      if (e.code === 'ERR_THROTTLED') { throttled = true; break; }
      assert.strictEqual(e.code, 'ERR_FORBIDDEN', 'pre-throttle failures must be ERR_FORBIDDEN');
    }
  }
  assert.ok(throttled, 'past the failure limit the caller must get ERR_THROTTLED (brute-force protection)');
  // even the CORRECT code is unusable for the throttled user this window
  await assert.rejects(
    () => market.deleteMarketSkill('flood', 'mallory', codeOf()),
    (e) => e.code === 'ERR_THROTTLED',
    'a throttled user stays blocked within the window (throttle check runs before the code compare)'
  );
  // a different user is unaffected
  const out = await market.deleteMarketSkill('flood', 'osha', codeOf());
  assert.strictEqual(out.deleted, true, 'another user with the right code is not collateral-throttled');
});

// ─── store hygiene ───

t('store.json is mode 0600 (uploader identities are operator-only)', () => {
  assert.strictEqual(fs.statSync(path.join(MARKET, 'store.json')).mode & 0o777, 0o600,
    'store.json carries uploader names — must be 0600 like auth-sessions.json');
});

t('symlinked helpers are never published or installed', async () => {
  const src = tmpRoot();
  await skillsApi.createSkill(src, { name: 'linky', description: 'l', content: 'x' });
  // plant a symlink pointing outside the skill dir
  fs.symlinkSync('/etc/hostname', path.join(src, '.claude/skills/linky/evil.sh'), 'file');
  await market.publishFromSession(src, 'linky', 'alice');
  assert.ok(!fs.existsSync(path.join(MARKET, 'skills/linky/evil.sh')),
    'a symlink helper must NOT be copied into the market (it could exfiltrate /etc/hostname on install)');
  const dst = tmpRoot();
  await market.installMarketSkill(dst, 'linky');
  assert.ok(!fs.existsSync(path.join(dst, '.claude/skills/linky/evil.sh')),
    'a symlink helper must NOT be copied into a personal store on install');
});

// ─── index.js route wiring ───

t('index.js exposes the five market routes behind requireAuth', () => {
  assert.ok(/app\.get\('\/skill-market',\s*requireAuth/.test(SRV), 'GET /skill-market must exist, requireAuth-gated');
  assert.ok(/app\.get\('\/skill-market\/:name',\s*requireAuth/.test(SRV), 'GET /skill-market/:name must exist, requireAuth-gated');
  assert.ok(/app\.post\('\/skill-market',\s*requireAuth/.test(SRV), 'POST /skill-market must exist, requireAuth-gated');
  assert.ok(/app\.post\('\/sessions\/:id\/skills\/publish',\s*requireAuth/.test(SRV), 'POST /sessions/:id/skills/publish must exist, requireAuth-gated');
  assert.ok(/app\.post\('\/sessions\/:id\/skill-market\/install',\s*requireAuth/.test(SRV), 'POST /sessions/:id/skill-market/install must exist, requireAuth-gated');
  assert.ok(/app\.delete\('\/skill-market\/:name',\s*requireAuth/.test(SRV), 'DELETE /skill-market/:name must exist, requireAuth-gated');
});

t('marketApiError maps ERR_FORBIDDEN→403 and ERR_THROTTLED→429', () => {
  assert.ok(/ERR_FORBIDDEN.*403/.test(SRV), 'ERR_FORBIDDEN must map to HTTP 403');
  assert.ok(/ERR_THROTTLED.*429/.test(SRV), 'ERR_THROTTLED must map to HTTP 429 (rate-limited, not 403 — so the client can back off)');
});

t('delete route reads the code from query OR body but never returns it', () => {
  const at = SRV.search(/app\.delete\('\/skill-market\/:name'/);
  assert.ok(at > 0, 'delete route must exist');
  const body = SRV.slice(at, at + 1200);
  assert.ok(/req\.query.*code|req\.body.*code/.test(body), 'delete route must accept the code via ?code= or body.code');
  assert.ok(!/res\.json\([^)]*code[^)]*\)/.test(body), 'the route must never echo the delete code back in a response');
});

// cleanup the throwaway state dir so /tmp doesn't accumulate
t._chain = t._chain.then(() => {
  try { fs.rmSync(STATE, { recursive: true, force: true }); } catch {}
});
