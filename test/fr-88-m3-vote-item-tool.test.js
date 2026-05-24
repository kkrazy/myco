// fr-88 migration 3: /upvote → mcp__myco__vote_item tool.
// Same fr-87-shape pattern. Key invariant: MCP tool does NOT trigger
// auto-quorum dispatch (HTTP route does — social-signal path).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ARTIFACTS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');
const MYCO_MCP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'myco-mcp.js'), 'utf8');

console.log('── fr-88 migration 3: mcp__myco__vote_item ──');

t('artifacts.js: toggleVote at module scope + exported', () => {
  assert.ok(/^function\s+toggleVote\s*\(/m.test(ARTIFACTS_SRC),
    'toggleVote must be defined at module scope');
  const exportsIdx = ARTIFACTS_SRC.search(/module\.exports\s*=\s*\{/);
  const win = ARTIFACTS_SRC.slice(exportsIdx, exportsIdx + 2500);
  assert.ok(/\btoggleVote\b/.test(win), 'module.exports must include toggleVote');
});

t('artifacts.js: toggleVote validates type/arch/itemId/user + returns action', () => {
  const idx = ARTIFACTS_SRC.search(/function\s+toggleVote\s*\(/);
  const win = ARTIFACTS_SRC.slice(idx, idx + 2000);
  assert.ok(/ARTIFACT_TYPES\.includes\(type\)/.test(win), 'validates type');
  assert.ok(/type\s*===\s*['"]arch['"]/.test(win), 'rejects arch');
  assert.ok(/!itemId/.test(win), 'rejects empty itemId');
  assert.ok(/!user/.test(win), 'rejects empty user');
  assert.ok(/action:\s*['"]added['"]/.test(win) && /action:\s*['"]removed['"]/.test(win) ||
            /action\s*=\s*['"]added['"]/.test(win) && /action\s*=\s*['"]removed['"]/.test(win),
    'must return action: added | removed');
});

t('artifacts.js: HTTP POST /artifact/vote delegates to toggleVote + KEEPS auto-fire', () => {
  const idx = ARTIFACTS_SRC.search(/app\.post\(['"]\/sessions\/:id\/artifact\/vote['"]/);
  const win = ARTIFACTS_SRC.slice(idx, idx + 1200);
  assert.ok(/toggleVote\s*\(/.test(win),
    'POST /artifact/vote must delegate to toggleVote');
  assert.ok(/autoFireIfQuorum/.test(win),
    'POST route must KEEP autoFireIfQuorum (social-signal path); tool skips it');
});

t('myco-mcp.js declares the vote_item tool', () => {
  assert.ok(/['"]vote_item['"]/.test(MYCO_MCP_SRC), 'tool name present');
  const idx = MYCO_MCP_SRC.search(/['"]vote_item['"]/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2500);
  assert.ok(/itemId:\s*z\.string/.test(win), 'schema requires itemId');
});

t('myco-mcp.js: vote_item handler delegates to toggleVote with author "claude"', () => {
  const idx = MYCO_MCP_SRC.search(/['"]vote_item['"]/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2500);
  assert.ok(/toggleVote\s*\(\s*sessionId/.test(win),
    'handler must call artifactsMod.toggleVote(sessionId, …)');
  assert.ok(/['"]claude['"]/.test(win), 'author fixed to "claude"');
  assert.ok(/state-update/.test(win), 'broadcasts state-update');
});

t('myco-mcp.js: vote_item does NOT call autoFireIfQuorum (tool skips social-signal path)', () => {
  const idx = MYCO_MCP_SRC.search(/['"]vote_item['"]/);
  // Look at the entire vote_item tool block — find where the next
  // tool starts (or end of tools array) and check no autoFireIfQuorum
  // appears inside.
  const win = MYCO_MCP_SRC.slice(idx, idx + 2500);
  assert.ok(!/autoFireIfQuorum/.test(win),
    'vote_item must NOT call autoFireIfQuorum (auto-quorum dispatch is the HTTP route\'s social-signal path)');
});

t('behavior: toggleVote add → remove → add round-trip', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr88m3-test-'));
  fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '_myco_'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '_myco_', 'plan.json'), JSON.stringify({
    items: [{ id: 'fr-test', text: 't', layer: 'Feature', done: false,
              addedAt: '2026-05-24T00:00:00Z', addedBy: 'k', source: 'user',
              voters: [], comments: [] }],
    updatedAt: '2026-05-24T00:00:00Z',
  }, null, 2));
  const sessionsMod = require('../server/src/sessions');
  const origLoad = sessionsMod.loadStore;
  const origSave = sessionsMod.saveStore;
  const fakeRec = { absCwd: tmpDir, cwd: tmpDir, user: 'k', artifacts: {} };
  sessionsMod.loadStore = () => ({ sessions: { 'sid': fakeRec } });
  sessionsMod.saveStore = () => {};
  try {
    delete require.cache[require.resolve('../server/src/artifacts')];
    const a = require('../server/src/artifacts');
    // Add vote.
    let r = a.toggleVote('sid', 'plan', 'fr-test', 'claude');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action, 'added');
    assert.deepStrictEqual(r.item.voters, ['claude']);
    // Re-vote → removed.
    r = a.toggleVote('sid', 'plan', 'fr-test', 'claude');
    assert.strictEqual(r.action, 'removed');
    assert.deepStrictEqual(r.item.voters, []);
    // Different user adds.
    r = a.toggleVote('sid', 'plan', 'fr-test', 'kkrazy');
    assert.strictEqual(r.action, 'added');
    assert.deepStrictEqual(r.item.voters, ['kkrazy']);
    // claude adds too → now both.
    r = a.toggleVote('sid', 'plan', 'fr-test', 'claude');
    assert.strictEqual(r.action, 'added');
    assert.strictEqual(r.item.voters.length, 2);
  } finally {
    sessionsMod.loadStore = origLoad;
    sessionsMod.saveStore = origSave;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/src/artifacts')];
  }
});

t('behavior: toggleVote rejects validation failures', () => {
  delete require.cache[require.resolve('../server/src/artifacts')];
  const a = require('../server/src/artifacts');
  let r = a.toggleVote('s1', 'plan', '', 'u');
  assert.strictEqual(r.status, 400); assert.ok(/itemId/.test(r.error));
  r = a.toggleVote('s1', 'plan', 'fr-1', '');
  assert.strictEqual(r.status, 400); assert.ok(/user/.test(r.error));
  r = a.toggleVote('s1', 'arch', 'fr-1', 'u');
  assert.strictEqual(r.status, 400); assert.ok(/arch/i.test(r.error));
  r = a.toggleVote('s1', 'zorf', 'fr-1', 'u');
  assert.strictEqual(r.status, 400); assert.ok(/unknown type/i.test(r.error));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
