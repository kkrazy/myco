// mcp-market SDK-tool layer regression test (additive to
// delm-mcp-market.test.js): locks the per-session `myco_mcp` in-process
// SDK MCP server that exposes INSTALLED entries' `sdkTools` as real
// tools (mcp__myco_mcp__<entry>_<tool>), the rec.installedMcp
// persistence on the install/uninstall routes, the agent-session
// wiring (constructor seed, setInstalledMcp live cache, iteration
// merge, preToolUse auto-allow), and sessions.js respawn seeding.
// Run: node test/delm-mcp-sdk-tools.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRV = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');
const AS = fs.readFileSync(path.join(ROOT, 'server/src/agent-session.js'), 'utf8');
const SS = fs.readFileSync(path.join(ROOT, 'server/src/sessions.js'), 'utf8');
const { builtinServers } = require(path.join(ROOT, 'server/src/mcp/builtin-servers.js'));
const mcpServer = require(path.join(ROOT, 'server/src/mcp/mcp-server.js'));

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

// ─── catalog: sdkTools declarations ───

t('builtin entries with sdkTools declare name/description/params', async () => {
  const withTools = builtinServers.filter((s) => Array.isArray(s.sdkTools));
  assert.ok(withTools.length >= 3,
    'expected ≥3 entries with sdkTools (github, gitee, web-search)');
  for (const s of withTools) {
    assert.ok(s.name && typeof s.name === 'string', `entry ${s.name}: name required`);
    for (const tt of s.sdkTools) {
      assert.ok(/^[a-z][a-z0-9_]*$/.test(tt.name), `entry ${s.name}: tool name "${tt.name}" must be snake_case`);
      assert.ok(typeof tt.description === 'string' && tt.description.length > 10,
        `entry ${s.name} tool ${tt.name}: description required`);
      assert.ok(Array.isArray(tt.params), `entry ${s.name} tool ${tt.name}: params array required`);
      for (const p of tt.params) {
        assert.ok(['string', 'number'].includes(p.type), `entry ${s.name} tool ${tt.name}: param ${p.name} type must be string|number`);
      }
    }
  }
});

t('every declared sdkTool has a matching handler', async () => {
  for (const s of builtinServers) {
    if (!Array.isArray(s.sdkTools)) continue;
    const h = mcpServer.handlers[s.name];
    assert.ok(h, `entry ${s.name} declares sdkTools but has no handlers`);
    for (const tt of s.sdkTools) {
      assert.ok(typeof h[tt.name] === 'function',
        `entry ${s.name}: handler missing for tool ${tt.name}`);
    }
  }
});

// ─── server construction ───

t('createMarketMcpServer returns null with no installed entries', async () => {
  assert.strictEqual(mcpServer.createMarketMcpServer('sess-x', []), null,
    'empty install list must produce no server (sdkOpts untouched)');
  assert.strictEqual(mcpServer.createMarketMcpServer('sess-x', null), null,
    'null install list must produce no server');
});

t('createMarketMcpServer returns null for entries without sdkTools', async () => {
  assert.strictEqual(mcpServer.createMarketMcpServer('sess-x', ['postgres', 'filesystem']), null,
    'guide-only entries (postgres/filesystem) must not produce a server');
});

// createSdkMcpServer returns { type, name, instance } — the registered
// tool names live on instance._registeredTools (verified against the
// SDK's shape; names are what the SDK prefixes mcp__myco_mcp__ with).
function _toolNames(srv) {
  return Object.keys(srv.instance._registeredTools);
}

t('createMarketMcpServer builds a server for an installed sdkTools entry', async () => {
  const srv = mcpServer.createMarketMcpServer('sess-x', ['github']);
  assert.ok(srv, 'github install must yield a myco_mcp server');
  assert.strictEqual(srv.name, 'myco_mcp', 'SDK MCP server name must be myco_mcp (tool prefix mcp__myco_mcp__)');
  const names = _toolNames(srv);
  assert.strictEqual(names.length, 4,
    `github entry must expose 4 tools (list_repos, get_file, create_issue, list_issues), got ${names.length}`);
  assert.deepStrictEqual(names.slice().sort(), ['github_create_issue', 'github_get_file', 'github_list_issues', 'github_list_repos'],
    'tool names must be <entry>_<tool> so the SDK surfaces mcp__myco_mcp__<entry>_<tool>');
});

t('server merges tools across multiple installed entries', async () => {
  const srv = mcpServer.createMarketMcpServer('sess-x', ['github', 'gitee', 'web-search']);
  const names = _toolNames(srv);
  assert.ok(names.includes('gitee_create_issue'), 'gitee tools present');
  assert.ok(names.includes('web-search_fetch_url'), 'web-search tools present (dash preserved from entry name)');
  assert.ok(names.includes('github_get_file'), 'github tools present');
});

// ─── handler behaviour (pure pieces) ───

t('_htmlToText strips tags, script/style blocks and decodes entities', async () => {
  const out = mcpServer._htmlToText(
    '<html><head><style>.a{}</style></head><body><script>evil()</script>' +
    '<h1>Title</h1><p>Hello &amp; welcome</p><p>Second para</p></body></html>');
  assert.ok(!out.includes('evil'), 'script body must be stripped');
  assert.ok(!out.includes('.a{}'), 'style body must be stripped');
  assert.ok(!/<[a-z]+>/i.test(out), 'tags must be stripped');
  assert.ok(out.includes('Hello & welcome'), 'entities must be decoded');
  assert.ok(out.includes('Title') && out.includes('Second para'), 'text content preserved');
});

// ─── index.js route persistence (static guards) ───

t('install route records rec.installedMcp + applies to live session', async () => {
  const seg = SRV.slice(SRV.indexOf("app.post('/sessions/:id/mcp-market/install'"));
  const end = SRV.indexOf("app.post('/sessions/:id/mcp-market/uninstall'");
  const body = seg.slice(0, end > 0 ? end : 4000);
  assert.ok(body.includes('installedMcp'), 'install handler must write rec.installedMcp');
  assert.ok(body.includes('putSession(ctx.rec)'), 'install handler must persist via putSession');
  assert.ok(body.includes('_applyInstalledMcpToLiveSession(ctx.rec)'), 'install handler must push to the live AgentSession');
});

t('uninstall route drops rec.installedMcp and cleans up empty arrays', async () => {
  const seg = SRV.slice(SRV.indexOf("app.post('/sessions/:id/mcp-market/uninstall'"));
  const body = seg.slice(0, 6000);
  assert.ok(body.includes('filter((n) => n !== out.name)'), 'uninstall must remove the entry from installedMcp');
  assert.ok(body.includes('delete ctx.rec.installedMcp'), 'empty installedMcp must be deleted, not left as []');
});

t('index.js defines _applyInstalledMcpToLiveSession keyed on setInstalledMcp', async () => {
  assert.ok(SRV.includes('function _applyInstalledMcpToLiveSession'),
    'helper must exist');
  const seg = SRV.slice(SRV.indexOf('function _applyInstalledMcpToLiveSession'), SRV.indexOf('function _applyInstalledMcpToLiveSession') + 700);
  assert.ok(seg.includes('live.setInstalledMcp'), 'helper must call the live session cache setter');
});

// ─── agent-session wiring (static guards) ───

t('AgentSession seeds installedMcp from opts and exposes setInstalledMcp', async () => {
  assert.ok(AS.includes('this.installedMcp = Array.isArray(opts.installedMcp)'),
    'constructor must seed installedMcp from spawn opts');
  assert.ok(/setInstalledMcp\(names\)/.test(AS),
    'setInstalledMcp live-cache setter must exist (route helper calls it)');
});

t('iteration build merges the myco_mcp market server into sdkOpts.mcpServers', async () => {
  const at = AS.indexOf('createMarketMcpServer');
  assert.ok(at > 0, 'agent-session must require mcp/mcp-server.createMarketMcpServer');
  const seg = AS.slice(at - 700, at + 400);
  assert.ok(seg.includes('sdkOpts.mcpServers'), 'the market server must merge into sdkOpts.mcpServers');
  assert.ok(seg.includes('myco_mcp: marketServer'), 'merged under the myco_mcp key (tool prefix mcp__myco_mcp__)');
});

t('preToolUse hook auto-allows mcp__myco_mcp__ tools (install-time consent)', async () => {
  const at = AS.indexOf("startsWith('mcp__myco_mcp__')");
  assert.ok(at > 0, 'hook must gate on the mcp__myco_mcp__ prefix');
  const seg = AS.slice(at - 900, at + 900);
  assert.ok(seg.includes("permissionDecision: 'allow'"),
    'matching tools must be auto-allowed');
  assert.ok(seg.includes('installed market entry') || seg.includes('installed the market entry') || seg.includes('MCP market tool'),
    'the allow reason must cite the install-time consent');
});

// ─── sessions.js respawn seeding (static guards) ───

t('sessions.js re-seeds installedMcp at every AgentSession spawn site', async () => {
  const hits = SS.split('installedMcp: Array.isArray(').length - 1;
  assert.ok(hits >= 3,
    `expected ≥3 spawn sites seeding installedMcp (spawn + rlm respawn + ensureLive respawn), found ${hits}`);
});
