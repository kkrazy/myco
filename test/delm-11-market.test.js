// delm-11: EXPERT / TEAM / MCP market regression test.
// Locks the layered-market feature at the module level:
//   PERSONAL — savePersonal/listPersonal/readPersonal/deletePersonal
//     persist per-user private items under
//     $MYCO_STATE_DIR/market/personal/<user>/<type>/<name>.json;
//     personal items are NEVER visible via listMarket.
//   VALIDATE — expert needs prompt; team needs experts[{name,role}];
//     mcp needs transport stdio(command)|http/sse(url); bad type/name
//     → ERR_BAD_INPUT.
//   PUBLISH  — publishToMarket is the ONLY path to market visibility
//     (one-click publish); duplicate name → ERR_EXISTS; the published
//     index store/<type>.json records uploader (0600).
//   INSTALL  — installFromMarket copies market→personal no-clobber.
//   DELETE   — uploader may delete; other users need the SHARED system
//     delete code ($MYCO_STATE_DIR/skill-market/delete-code — same
//     file as the skill market); wrong code → ERR_FORBIDDEN.
//   ROUTES   — index.js exposes GET /market, GET/POST
//     /market/personal(/:type), GET /market/:type/:name, DELETE
//     /market/personal/:type/:name, POST /market/publish/:type/:name,
//     POST /market/install/:type/:name, DELETE /market/:type/:name —
//     all requireAuth-gated.
// Run: node test/delm-11-market.test.js

process.env.MYCO_STATE_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'delm11mkt-'));

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRV = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');
const market = require(path.join(ROOT, 'server/src/market.js'));

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

const throwsCode = async (code, fn) => {
  try { await fn(); } catch (e) { assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return e; }
  throw new Error(`expected ${code} but call succeeded`);
};

const codeOf = () => fs.readFileSync(CODE_FILE, 'utf8').trim();

// ─── personal store ───

t('savePersonal expert persists a private item per user+type', async () => {
  const out = await market.savePersonal('alice', 'expert', {
    name: 'db-expert',
    description: 'database tuning expert',
    prompt: 'You are a database performance expert. Answer with SQL first.',
  });
  assert.strictEqual(out.created, true, 'first save must be created=true');
  const file = path.join(STATE, 'market', 'personal', 'alice', 'expert', 'db-expert.json');
  assert.ok(fs.existsSync(file), 'personal expert file must exist');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.prompt.includes('database performance'), true, 'prompt persisted verbatim');
});

t('listPersonal returns items per type and per user only', async () => {
  await market.savePersonal('alice', 'mcp', {
    name: 'weather', description: 'weather lookup', transport: 'http', url: 'https://mcp.example.com/weather',
  });
  await market.savePersonal('bob', 'expert', {
    name: 'code-reviewer', description: 'reviews code', prompt: 'You review code.',
  });
  const alice = await market.listPersonal('alice', null);
  assert.strictEqual(alice.expert.length, 1, 'alice has 1 expert');
  assert.strictEqual(alice.mcp.length, 1, 'alice has 1 mcp');
  assert.strictEqual(alice.team.length, 0, 'alice has no teams');
  const bob = await market.listPersonal('bob', 'expert');
  assert.strictEqual(bob.expert.length, 1, 'bob has 1 expert');
  assert.strictEqual(bob.expert[0].name, 'code-reviewer', "bob's expert is his own — alice's must not leak");
});

t('personal items are NOT visible in the market list before publish', async () => {
  const all = await market.listMarket('bob');
  assert.deepStrictEqual(all.expert, [], 'unpublished expert must not appear in market');
  assert.deepStrictEqual(all.mcp, [], 'unpublished mcp must not appear in market');
  assert.deepStrictEqual(all.team, [], 'unpublished team must not appear in market');
});

// ─── validation ───

t('expert without prompt → ERR_BAD_INPUT', async () => {
  await throwsCode('ERR_BAD_INPUT', () => market.savePersonal('alice', 'expert', { name: 'x', description: 'no prompt' }));
});

t('team without experts → ERR_BAD_INPUT; valid team persists experts', async () => {
  await throwsCode('ERR_BAD_INPUT', () => market.savePersonal('alice', 'team', { name: 't1', description: 'empty team' }));
  await market.savePersonal('alice', 'team', {
    name: 'db-squad',
    description: 'database expert team',
    experts: [{ name: 'db-expert', role: 'tuning' }, { name: 'dba', role: 'operations' }],
  });
  const mine = await market.listPersonal('alice', 'team');
  assert.strictEqual(mine.team[0].experts.length, 2, 'team experts persisted');
});

t('mcp stdio requires command; http/sse require url', async () => {
  await throwsCode('ERR_BAD_INPUT', () => market.savePersonal('alice', 'mcp', { name: 'm1', transport: 'stdio' }));
  await throwsCode('ERR_BAD_INPUT', () => market.savePersonal('alice', 'mcp', { name: 'm2', transport: 'http', url: 'ftp://bad' }));
  const out = await market.savePersonal('alice', 'mcp', {
    name: 'fs-server', description: 'filesystem MCP', transport: 'stdio',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    env: { ROOT: '/tmp' },
  });
  assert.strictEqual(out.item.command, 'npx', 'stdio command persisted');
  assert.strictEqual(out.item.args.length, 3, 'args persisted');
});

t('unknown type / bad name → ERR_BAD_INPUT', async () => {
  await throwsCode('ERR_BAD_INPUT', () => market.savePersonal('alice', 'widget', { name: 'x' }));
  await throwsCode('ERR_BAD_INPUT', () => market.savePersonal('alice', 'expert', { name: 'has/slash', prompt: 'p' }));
});

// ─── one-click publish ───

t('publishToMarket makes the item visible to all users with canDelete flag', async () => {
  const out = await market.publishToMarket('alice', 'expert', 'db-expert');
  assert.strictEqual(out.published, true, 'publish succeeds');
  const asBob = await market.listMarket('bob');
  assert.strictEqual(asBob.expert.length, 1, 'published expert visible to bob');
  assert.strictEqual(asBob.expert[0].uploader, 'alice', 'uploader recorded');
  assert.strictEqual(asBob.expert[0].canDelete, false, 'bob cannot delete alice item');
  const asAlice = await market.listMarket('alice');
  assert.strictEqual(asAlice.expert[0].canDelete, true, 'alice can delete her own item');
  const store = JSON.parse(fs.readFileSync(path.join(STATE, 'market', 'store', 'expert.json'), 'utf8'));
  assert.ok(store.items['db-expert'], 'store index records the item');
});

t('duplicate publish → ERR_EXISTS', async () => {
  // alice already published 'db-expert' above; bob's same-named
  // personal item must NOT be publishable over it.
  await market.savePersonal('bob', 'expert', { name: 'db-expert', description: 'mine too', prompt: 'x' });
  await throwsCode('ERR_EXISTS', () => market.publishToMarket('bob', 'expert', 'db-expert'));
});

t('readMarketItem returns the full published definition', async () => {
  const item = await market.readMarketItem('expert', 'db-expert');
  assert.strictEqual(item.uploader, 'alice', 'meta merged from store');
  assert.ok(item.prompt.length > 0, 'full definition readable');
});

t('publishing a non-existent personal item → ERR_NOT_FOUND', async () => {
  await throwsCode('ERR_NOT_FOUND', () => market.publishToMarket('alice', 'expert', 'ghost'));
});

// ─── install ───

t('installFromMarket copies into the personal store no-clobber', async () => {
  // publish a dedicated item for install (bob may hold colliding
  // personal copies from earlier cases)
  await market.savePersonal('alice', 'mcp', {
    name: 'installable-mcp', description: 'for install', transport: 'sse', url: 'https://mcp.example.com/sse',
  });
  await market.publishToMarket('alice', 'mcp', 'installable-mcp');
  const out = await market.installFromMarket('bob', 'mcp', 'installable-mcp');
  assert.strictEqual(out.installed, true, 'install succeeds');
  const mine = await market.readPersonal('bob', 'mcp', 'installable-mcp');
  assert.strictEqual(mine.url, 'https://mcp.example.com/sse', 'definition copied');
  await throwsCode('ERR_EXISTS', () => market.installFromMarket('bob', 'mcp', 'installable-mcp'));
});

// ─── delete ───

t('non-uploader without code → ERR_FORBIDDEN; with the shared code → deleted', async () => {
  await throwsCode('ERR_FORBIDDEN', () => market.deleteMarketItem('expert', 'db-expert', 'bob', ''));
  // force-create the code file (created lazily on first code attempt)
  await market.getDeleteCode();
  await market.deleteMarketItem('expert', 'db-expert', 'bob', codeOf());
  const all = await market.listMarket('alice');
  assert.deepStrictEqual(all.expert.filter((e) => e.name === 'db-expert'), [], 'item gone after code-delete');
});

t('shared delete-code file is the SAME file the skill market uses', async () => {
  const skillMarket = require(path.join(ROOT, 'server/src/skill-market.js'));
  const a = await market.getDeleteCode();
  const b = await skillMarket.getDeleteCode();
  assert.strictEqual(a, b,
    'both markets must read $MYCO_STATE_DIR/skill-market/delete-code — one code, one policy');
});

// ─── routes (static contract on index.js) ───

t('index.js exposes the full market route set, requireAuth-gated', async () => {
  const routes = [
    [/app\.get\('\/market',\s*requireAuth/, 'GET /market'],
    [/app\.get\('\/market\/personal',\s*requireAuth/, 'GET /market/personal'],
    [/app\.get\('\/market\/personal\/:type',\s*requireAuth/, 'GET /market/personal/:type'],
    [/app\.get\('\/market\/:type\/:name',\s*requireAuth/, 'GET /market/:type/:name'],
    [/app\.post\('\/market\/personal\/:type',\s*requireAuth/, 'POST /market/personal/:type'],
    [/app\.delete\('\/market\/personal\/:type\/:name',\s*requireAuth/, 'DELETE /market/personal/:type/:name'],
    [/app\.post\('\/market\/publish\/:type\/:name',\s*requireAuth/, 'POST /market/publish/:type/:name'],
    [/app\.post\('\/market\/install\/:type\/:name',\s*requireAuth/, 'POST /market/install/:type/:name'],
    [/app\.delete\('\/market\/:type\/:name',\s*requireAuth/, 'DELETE /market/:type/:name'],
  ];
  for (const [re, label] of routes) {
    assert.ok(re.test(SRV), `${label} must exist in index.js, requireAuth-gated`);
  }
});

t('GET /market/personal/:type is registered BEFORE /market/:type/:name (route precedence)', async () => {
  const iPersonal = SRV.indexOf("app.get('/market/personal/:type'");
  const iType = SRV.indexOf("app.get('/market/:type/:name'");
  assert.ok(iPersonal > -1 && iType > -1, 'both routes exist');
  assert.ok(iPersonal < iType, 'personal route must match first or /market/personal/expert is shadowed');
});

t('market.js requires the shared delete-code path (no second code source)', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/src/market.js'), 'utf8');
  assert.ok(src.includes("path.join(STATE_DIR, 'skill-market', 'delete-code')"),
    'market.js must read the SAME delete-code file as skill-market.js');
});
