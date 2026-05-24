// fr-88 migration 2: /close → mcp__myco__set_item_done tool.
// Same fr-87-shape pattern as migration 1.

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

console.log('── fr-88 migration 2: mcp__myco__set_item_done ──');

t('artifacts.js: setItemDone is defined at module scope + exported', () => {
  assert.ok(/^function\s+setItemDone\s*\(/m.test(ARTIFACTS_SRC),
    'setItemDone must be defined at module scope');
  const exportsIdx = ARTIFACTS_SRC.search(/module\.exports\s*=\s*\{/);
  const win = ARTIFACTS_SRC.slice(exportsIdx, exportsIdx + 2000);
  assert.ok(/\bsetItemDone\b/.test(win),
    'module.exports must include setItemDone');
});

t('artifacts.js: setItemDone validates type/arch/itemId', () => {
  const idx = ARTIFACTS_SRC.search(/function\s+setItemDone\s*\(/);
  const win = ARTIFACTS_SRC.slice(idx, idx + 1500);
  assert.ok(/ARTIFACT_TYPES\.includes\(type\)/.test(win), 'validates type');
  assert.ok(/type\s*===\s*['"]arch['"]/.test(win), 'rejects arch');
  assert.ok(/!itemId/.test(win), 'rejects empty itemId');
});

t('artifacts.js: setItemDone returns { ok, item, artifact } for broadcast', () => {
  const idx = ARTIFACTS_SRC.search(/function\s+setItemDone\s*\(/);
  const win = ARTIFACTS_SRC.slice(idx, idx + 1500);
  assert.ok(/return\s*\{\s*ok:\s*true[\s\S]{0,200}artifact/.test(win),
    'success return must include artifact for broadcast');
});

t('artifacts.js: HTTP POST /artifact/mark delegates to setItemDone', () => {
  const idx = ARTIFACTS_SRC.search(/app\.post\(['"]\/sessions\/:id\/artifact\/mark['"]/);
  const win = ARTIFACTS_SRC.slice(idx, idx + 1000);
  assert.ok(/setItemDone\s*\(/.test(win),
    'POST /artifact/mark must delegate to setItemDone');
});

t('myco-mcp.js declares the set_item_done tool with itemId + done schema', () => {
  assert.ok(/['"]set_item_done['"]/.test(MYCO_MCP_SRC), 'tool name present');
  const idx = MYCO_MCP_SRC.search(/['"]set_item_done['"]/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2500);
  assert.ok(/itemId:\s*z\.string/.test(win), 'schema requires itemId: z.string');
  assert.ok(/done:\s*z\.boolean/.test(win), 'schema requires done: z.boolean');
});

t('myco-mcp.js: set_item_done handler delegates to artifactsMod.setItemDone', () => {
  const idx = MYCO_MCP_SRC.search(/['"]set_item_done['"]/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2500);
  assert.ok(/artifactsMod\.setItemDone|setItemDone\s*\(\s*sessionId/.test(win),
    'handler must call artifactsMod.setItemDone (shared backend)');
  assert.ok(/state-update/.test(win), 'handler must broadcast state-update');
});

// Behavior simulation: round-trip via the real helper.
t('behavior: setItemDone flips done + persists to plan.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr88m2-test-'));
  fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '_myco_'), { recursive: true });
  const planPath = path.join(tmpDir, '_myco_', 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify({
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
    const artifactsMod = require('../server/src/artifacts');
    // Close it.
    let r = artifactsMod.setItemDone('sid', 'plan', 'fr-test', true);
    assert.strictEqual(r.ok, true, 'close should succeed');
    assert.strictEqual(r.item.done, true);
    let parsed = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.strictEqual(parsed.items[0].done, true, 'mirror file reflects done=true');
    // Reopen.
    r = artifactsMod.setItemDone('sid', 'plan', 'fr-test', false);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.item.done, false);
    parsed = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.strictEqual(parsed.items[0].done, false, 'mirror file reflects done=false');
  } finally {
    sessionsMod.loadStore = origLoad;
    sessionsMod.saveStore = origSave;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/src/artifacts')];
  }
});

t('behavior: setItemDone rejects unknown type / missing itemId / arch', () => {
  delete require.cache[require.resolve('../server/src/artifacts')];
  const a = require('../server/src/artifacts');
  let r = a.setItemDone('s1', 'plan', '', true);
  assert.strictEqual(r.status, 400);
  assert.ok(/itemId/i.test(r.error));
  r = a.setItemDone('s1', 'zorf', 'fr-1', true);
  assert.strictEqual(r.status, 400);
  assert.ok(/unknown type/i.test(r.error));
  r = a.setItemDone('s1', 'arch', 'fr-1', true);
  assert.strictEqual(r.status, 400);
  assert.ok(/arch/i.test(r.error));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
