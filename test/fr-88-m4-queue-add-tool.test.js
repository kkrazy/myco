// fr-88 migration 4: /queue → mcp__myco__queue_add tool.
// Last of the 4 candidate migrations. Key invariants:
//   - shared queueItemForRun helper between HTTP route + MCP tool
//   - MCP tool does NOT kick the queue (no reentrant dispatch)
//   - HTTP route still kicks (existing flow preserved)

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

console.log('── fr-88 migration 4: mcp__myco__queue_add ──');

t('artifacts.js: queueItemForRun at module scope + exported', () => {
  assert.ok(/^function\s+queueItemForRun\s*\(/m.test(ARTIFACTS_SRC),
    'queueItemForRun must be defined at module scope');
  const exportsIdx = ARTIFACTS_SRC.search(/module\.exports\s*=\s*\{/);
  const win = ARTIFACTS_SRC.slice(exportsIdx, exportsIdx + 2500);
  assert.ok(/\bqueueItemForRun\b/.test(win), 'must be in module.exports');
});

t('artifacts.js: queueItemForRun delegates to runQueue.addToQueue', () => {
  const idx = ARTIFACTS_SRC.search(/function\s+queueItemForRun\s*\(/);
  const win = ARTIFACTS_SRC.slice(idx, idx + 1500);
  assert.ok(/runQueue\.addToQueue\s*\(/.test(win),
    'queueItemForRun must call runQueue.addToQueue (existing data-side helper)');
  assert.ok(/sessionsMod\.saveStore/.test(win),
    'must call saveStore after addToQueue');
});

t('artifacts.js: queueItemForRun returns 409 on duplicate (addToQueue throws)', () => {
  const idx = ARTIFACTS_SRC.search(/function\s+queueItemForRun\s*\(/);
  const win = ARTIFACTS_SRC.slice(idx, idx + 1500);
  assert.ok(/status:\s*409/.test(win),
    'duplicate-itemId case must return status 409 (matches HTTP route\'s pre-migration shape)');
});

t('artifacts.js: HTTP POST /queue/add delegates to queueItemForRun + keeps auth check', () => {
  const idx = ARTIFACTS_SRC.search(/app\.post\(['"]\/sessions\/:id\/queue\/add['"]/);
  const win = ARTIFACTS_SRC.slice(idx, idx + 1500);
  assert.ok(/queueItemForRun\s*\(/.test(win),
    'POST /queue/add must delegate to queueItemForRun');
  assert.ok(/isOwnerOrAdmin/.test(win),
    'POST route must keep its owner+admin auth check (helper is auth-agnostic)');
});

t('myco-mcp.js declares the queue_add tool', () => {
  assert.ok(/['"]queue_add['"]/.test(MYCO_MCP_SRC), 'tool name present');
  const idx = MYCO_MCP_SRC.search(/['"]queue_add['"]/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2500);
  assert.ok(/itemId:\s*z\.string/.test(win), 'schema requires itemId');
});

t('myco-mcp.js: queue_add handler delegates to queueItemForRun (no kick)', () => {
  const idx = MYCO_MCP_SRC.search(/['"]queue_add['"]/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2800);
  assert.ok(/queueItemForRun\s*\(\s*sessionId/.test(win),
    'handler must call artifactsMod.queueItemForRun(sessionId, …)');
  // NO handleChatMessage call (which would kick the queue) — agent
  // tool intentionally enqueue-only.
  assert.ok(!/handleChatMessage/.test(win),
    'queue_add tool must NOT call handleChatMessage (no reentrant dispatch from inside a turn)');
  // Broadcasts runQueue change so the queue-chip strip updates live.
  assert.ok(/state-update[\s\S]{0,200}runQueue/.test(win),
    'tool must broadcast state-update kind:runQueue so the chip strip updates');
});

t('myco-mcp.js: queue_add attributes the enqueue to "claude"', () => {
  const idx = MYCO_MCP_SRC.search(/['"]queue_add['"]/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2800);
  assert.ok(/['"]claude['"]/.test(win),
    'addedBy must be "claude" so the queue chip shows it was an agent self-queue');
});

t('behavior: queueItemForRun adds entry + rejects duplicate', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr88m4-test-'));
  fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '_myco_'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '_myco_', 'plan.json'), JSON.stringify({
    items: [
      { id: 'fr-test', text: 't', layer: 'Feature', done: false,
        addedAt: '2026-05-24T00:00:00Z', addedBy: 'k', source: 'user',
        voters: [], comments: [] },
      { id: 'fr-other', text: 't2', layer: 'Feature', done: false,
        addedAt: '2026-05-24T00:00:00Z', addedBy: 'k', source: 'user',
        voters: [], comments: [] },
    ],
    updatedAt: '2026-05-24T00:00:00Z',
  }, null, 2));
  const sessionsMod = require('../server/src/sessions');
  const origLoad = sessionsMod.loadStore;
  const origSave = sessionsMod.saveStore;
  const fakeRec = { absCwd: tmpDir, cwd: tmpDir, user: 'k', artifacts: {}, runQueue: [] };
  sessionsMod.loadStore = () => ({ sessions: { 'sid': fakeRec } });
  sessionsMod.saveStore = () => {};
  try {
    delete require.cache[require.resolve('../server/src/artifacts')];
    const a = require('../server/src/artifacts');
    // Add fr-test.
    let r = a.queueItemForRun('sid', 'plan', 'fr-test', 'claude');
    assert.strictEqual(r.ok, true, 'first enqueue should succeed: ' + JSON.stringify(r));
    assert.strictEqual(r.entry.status, 'pending');
    assert.strictEqual(r.entry.itemId, 'fr-test');
    assert.strictEqual(r.entry.addedBy, 'claude');
    assert.strictEqual(fakeRec.runQueue.length, 1);
    // Duplicate fr-test → 409.
    r = a.queueItemForRun('sid', 'plan', 'fr-test', 'claude');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 409, 'duplicate must return 409');
    assert.ok(/already in queue/i.test(r.error));
    // Different item works.
    r = a.queueItemForRun('sid', 'plan', 'fr-other', 'claude');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fakeRec.runQueue.length, 2);
  } finally {
    sessionsMod.loadStore = origLoad;
    sessionsMod.saveStore = origSave;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/src/artifacts')];
  }
});

t('behavior: queueItemForRun rejects validation failures', () => {
  delete require.cache[require.resolve('../server/src/artifacts')];
  const a = require('../server/src/artifacts');
  let r = a.queueItemForRun('s1', 'plan', '', 'claude');
  assert.strictEqual(r.status, 400); assert.ok(/itemId/.test(r.error));
  r = a.queueItemForRun('s1', 'zorf', 'fr-1', 'claude');
  assert.strictEqual(r.status, 400); assert.ok(/unknown type/i.test(r.error));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
