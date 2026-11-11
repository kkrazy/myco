// mcp-market: MCP server marketplace regression test (skill-pack model).
// Locks the module end-to-end at server/src/mcp/market.js level:
//   CATALOG — builtin entries list with transport/security/skills
//     metadata; user-published entries append after the builtins.
//   READ    — readServer renders builtin skill bodies from the
//     in-memory guides; published entries read SKILL.md from disk.
//   PUBLISH — publishServer validates names, refuses duplicate /
//     builtin-name collisions (ERR_EXISTS), writes front-mattered
//     SKILL.md files under $MYCO_STATE_DIR/mcp-market/skills/<name>/.
//   INSTALL — installServer copies the pack's skills into
//     <root>/.claude/skills/, skips (not aborts) on per-skill
//     collision, is idempotent-friendly; uninstallServer removes them.
//   DELETE  — uploader-only for custom entries; builtins refused
//     (ERR_FORBIDDEN); unknown → ERR_NOT_FOUND.
//   ROUTES  — index.js exposes GET/POST /mcp-market,
//     GET /mcp-market/:name, POST /sessions/:id/mcp-market/install,
//     POST /sessions/:id/mcp-market/uninstall, DELETE /mcp-market/:name,
//     all requireAuth-gated.
// Run: node test/delm-mcp-market.test.js
// The module reads MYCO_STATE_DIR at require time, so it is set BEFORE
// the require and the whole run uses a throwaway dir.

process.env.MYCO_STATE_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'mcpmkt-'));

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRV = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');
const market = require(path.join(ROOT, 'server/src/mcp/market.js'));
const { builtinServers } = require(path.join(ROOT, 'server/src/mcp/builtin-servers.js'));

const STATE = process.env.MYCO_STATE_DIR;
const MDIR = path.join(STATE, 'mcp-market');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcpmkt-root-'));
}

// ─── catalog ───

t('catalog lists every builtin entry with transport + security metadata', async () => {
  const { servers } = await market.listMarket();
  assert.ok(Array.isArray(servers) && servers.length >= builtinServers.length,
    `catalog must list >= ${builtinServers.length} builtin entries (got ${servers.length})`);
  const gh = servers.find((s) => s.name === 'github');
  assert.ok(gh, 'github builtin entry must be in the catalog');
  assert.strictEqual(gh.transport.type, 'streamable-http',
    'github entry must document its transport type');
  assert.ok(gh.security && gh.security.level, 'github entry must carry a security level');
  assert.ok(Array.isArray(gh.skills) && gh.skills.length > 0,
    'every entry must expose at least one skill (the skill-pack model)');
  assert.ok(gh.skills.every((sk) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sk.dirName)),
    'skill dir names must be SDK-safe (no spaces/slashes)');
  for (const s of servers) {
    assert.ok(['stdio', 'streamable-http', 'sse', 'builtin'].includes(s.transport && s.transport.type),
      `entry ${s.name} transport.type must be a documented MCP transport`);
  }
});

t('builtin skill guides document tools with parameters + invocation examples', async () => {
  const gh = await market.readServer('github');
  const md = gh.skills[0].content;
  assert.ok(md.startsWith('---\nname: mcp-github\n'),
    'builtin skill body must start with SDK-parseable front matter');
  assert.ok(/## Tools/.test(md), 'guide must have a Tools section');
  assert.ok(/curl/.test(md), 'HTTP guides must show a curl invocation example');
  assert.ok(/create_issue/.test(md), 'github guide documents the create_issue tool');
  const fs2 = await market.readServer('filesystem');
  assert.ok(/jsonrpc/.test(fs2.skills[0].content),
    'stdio guides must document the JSON-RPC protocol');
});

// ─── publish ───

t('publishServer writes a custom entry + front-mattered SKILL.md to the state dir', async () => {
  const out = await market.publishServer({
    name: 'my-svc',
    displayName: 'My Service',
    description: 'test entry',
    transport: { type: 'streamable-http' },
    endpoint: 'https://svc.example.com/api',
    skills: [{ dirName: 'mcp-my-svc', description: 'svc guide', content: '# My Service\n\nUse curl.' }],
  }, 'alice');
  assert.strictEqual(out.name, 'my-svc', 'publish returns the entry name');
  const md = fs.readFileSync(path.join(MDIR, 'skills', 'my-svc', 'mcp-my-svc', 'SKILL.md'), 'utf8');
  assert.ok(md.startsWith('---\nname: mcp-my-svc\ndescription: svc guide\n---\n'),
    'SKILL.md must get front matter when the content has none');
  const { servers } = await market.listMarket();
  assert.ok(servers.some((s) => s.name === 'my-svc' && s.uploader === 'alice'),
    'published entry lists after the builtins with its uploader');
});

t('publishServer refuses duplicate + builtin-name collisions and bad input', async () => {
  await assert.rejects(
    () => market.publishServer({ name: 'my-svc', skills: [{ dirName: 'a', content: 'x' }] }, 'bob'),
    (e) => e.code === 'ERR_EXISTS', 'duplicate custom name must ERR_EXISTS');
  await assert.rejects(
    () => market.publishServer({ name: 'github', skills: [{ dirName: 'a', content: 'x' }] }, 'bob'),
    (e) => e.code === 'ERR_EXISTS', 'shadowing a builtin name must ERR_EXISTS');
  await assert.rejects(
    () => market.publishServer({ name: 'bad name!', skills: [{ dirName: 'a', content: 'x' }] }, 'bob'),
    (e) => e.code === 'ERR_BAD_INPUT', 'invalid name must ERR_BAD_INPUT');
  await assert.rejects(
    () => market.publishServer({ name: 'ok-name' }, 'bob'),
    (e) => e.code === 'ERR_BAD_INPUT', 'entry without skills must ERR_BAD_INPUT');
});

// ─── install / uninstall ───

t('installServer copies a builtin pack into .claude/skills (skill-pack model)', async () => {
  const root = tmpRoot();
  const out = await market.installServer(root, 'github');
  assert.ok(out.installed && out.skills.includes('mcp-github'),
    'install must report the copied skill dirs');
  const md = fs.readFileSync(path.join(root, '.claude', 'skills', 'mcp-github', 'SKILL.md'), 'utf8');
  assert.ok(/^---\nname: mcp-github\ndescription: /.test(md),
    'installed SKILL.md must carry SDK-parseable front matter');
});

t('installServer installs a published custom entry and skips (not aborts) on collision', async () => {
  const root = tmpRoot();
  const first = await market.installServer(root, 'my-svc');
  assert.ok(first.skills.includes('mcp-my-svc'), 'first install succeeds');
  const second = await market.installServer(root, 'my-svc');
  assert.ok(second.skipped.some((s) => s.dirName === 'mcp-my-svc' && s.reason === 'exists'),
    'second install must skip the existing skill dir instead of ERR_EXISTS');
  assert.strictEqual(second.skills.length, 0, 'no new skills on a fully-colliding install');
});

t('installServer refuses unknown entries; uninstallServer removes + is idempotent', async () => {
  const root = tmpRoot();
  await assert.rejects(() => market.installServer(root, 'nope'),
    (e) => e.code === 'ERR_NOT_FOUND', 'unknown entry must ERR_NOT_FOUND');
  await market.installServer(root, 'filesystem');
  const out = await market.uninstallServer(root, 'filesystem');
  assert.ok(out.uninstalled && out.removed.includes('mcp-filesystem'),
    'uninstall must remove the pack skill dirs');
  const again = await market.uninstallServer(root, 'filesystem');
  assert.ok(again.uninstalled, 'uninstall is idempotent (rm force)');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'skills', 'mcp-filesystem')),
    'skill dir must be gone after uninstall');
});

// ─── delete ───

t('deleteServer: uploader-only for custom entries, builtins refused', async () => {
  await assert.rejects(() => market.deleteServer('github', 'alice'),
    (e) => e.code === 'ERR_FORBIDDEN', 'builtin entries must not be deletable');
  await assert.rejects(() => market.deleteServer('my-svc', 'bob'),
    (e) => e.code === 'ERR_FORBIDDEN', 'non-uploader must get ERR_FORBIDDEN');
  await assert.rejects(() => market.deleteServer('ghost', 'alice'),
    (e) => e.code === 'ERR_NOT_FOUND', 'unknown entry must ERR_NOT_FOUND');
  const out = await market.deleteServer('my-svc', 'alice');
  assert.ok(out.deleted, 'uploader deletes their own entry');
  const { servers } = await market.listMarket();
  assert.ok(!servers.some((s) => s.name === 'my-svc'),
    'deleted entry leaves the catalog');
});

// ─── routes (static contract against index.js) ───

t('index.js wires the /mcp-market routes requireAuth-gated', async () => {
  for (const [verb, route] of [
    ['get', '/mcp-market'],
    ['get', '/mcp-market/:name'],
    ['post', '/mcp-market'],
    ['post', '/sessions/:id/mcp-market/install'],
    ['post', '/sessions/:id/mcp-market/uninstall'],
    ['delete', '/mcp-market/:name'],
  ]) {
    const re = new RegExp(`app\\.${verb}\\('${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',\\s*requireAuth`);
    assert.ok(re.test(SRV), `index.js must gate app.${verb}('${route}') behind requireAuth`);
  }
  assert.ok(SRV.includes("require('./mcp/market')"),
    'index.js must require the mcp market module');
});

t('mcp module lives in its own directory (server/src/mcp/)', async () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'server/src/mcp/market.js')),
    'server/src/mcp/market.js must exist (standalone mcp module dir)');
  assert.ok(fs.existsSync(path.join(ROOT, 'server/src/mcp/builtin-servers.js')),
    'server/src/mcp/builtin-servers.js must exist');
});
