// Regression: /todo /fr /bug must persist the new plan item to BOTH
// sessions.json AND <project>/_myco_/plan.json. The GET /artifact
// handler reads the on-disk file first and falls back to rec.artifacts
// only when the file is absent — without the file write, the next
// plan-tab open re-reads the file (which doesn't have the new item)
// and silently drops what the user just added.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-slashtd-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

const sessionsMod = require('../server/src/sessions');
const slashcmds = require('../server/src/slashcmds');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function seedSession(sid) {
  const cwd = path.join(tmpRoot, 'proj-' + sid);
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });    // findProjectRoot anchor
  const store = sessionsMod.loadStore();
  store.sessions = store.sessions || {};
  store.sessions[sid] = {
    id: sid,
    user: 'kkrazy',
    cwd: '.',
    absCwd: cwd,
    chat: [],
    artifacts: {},
  };
  sessionsMod.saveStore();
  return cwd;
}

async function run(text, ctx) {
  const replies = [];
  await slashcmds.dispatch({
    user: 'kkrazy',
    sessionId: ctx.sessionId,
    absCwd: ctx.absCwd,
    reply: (m) => replies.push(m),
  }, text);
  return replies;
}

(async () => {
  console.log('── /td /fr /bug → _myco_/plan.json ──');

  await t('/td <text> writes to _myco_/plan.json', async () => {
    const sid = 'sess-td-a';
    const cwd = seedSession(sid);
    const replies = await run('/td wire up the cursor pager', { sessionId: sid, absCwd: cwd });
    assert.ok(replies.some((r) => /Todo/.test(r) && /Plan/.test(r)), 'expected confirmation reply, got: ' + JSON.stringify(replies));
    const file = path.join(cwd, '_myco_', 'plan.json');
    assert.ok(fs.existsSync(file), '_myco_/plan.json was NOT written — /todo would be silently lost on next GET');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(data.items) && data.items.length === 1, 'plan.json missing the new item');
    assert.strictEqual(data.items[0].text, 'wire up the cursor pager');
    assert.strictEqual(data.items[0].layer, 'Todo');
    assert.strictEqual(data.items[0].source, 'user');
  });

  await t('/todo (long-name alias) writes to disk', async () => {
    const sid = 'sess-td-b';
    const cwd = seedSession(sid);
    await run('/todo refactor the menu interceptor for clarity', { sessionId: sid, absCwd: cwd });
    const data = JSON.parse(fs.readFileSync(path.join(cwd, '_myco_', 'plan.json'), 'utf8'));
    assert.ok(data.items.some((it) => it.text === 'refactor the menu interceptor for clarity'),
      '/todo alias did not persist the item to plan.json');
  });

  await t('/fr writes a Feature item, /bug writes a Bug item — both land in plan.json', async () => {
    const sid = 'sess-td-c';
    const cwd = seedSession(sid);
    await run('/fr add dark-mode toggle', { sessionId: sid, absCwd: cwd });
    await run('/bug menu picker drops clicks on race', { sessionId: sid, absCwd: cwd });
    const data = JSON.parse(fs.readFileSync(path.join(cwd, '_myco_', 'plan.json'), 'utf8'));
    const layers = data.items.map((it) => it.layer).sort();
    assert.deepStrictEqual(layers, ['Bug', 'Feature']);
  });

  await t('multiple /td calls accumulate in plan.json (no overwrite)', async () => {
    const sid = 'sess-td-d';
    const cwd = seedSession(sid);
    await run('/td first item', { sessionId: sid, absCwd: cwd });
    await run('/td second item', { sessionId: sid, absCwd: cwd });
    await run('/td third item', { sessionId: sid, absCwd: cwd });
    const data = JSON.parse(fs.readFileSync(path.join(cwd, '_myco_', 'plan.json'), 'utf8'));
    assert.strictEqual(data.items.length, 3);
    assert.deepStrictEqual(
      data.items.map((it) => it.text),
      ['first item', 'second item', 'third item']
    );
  });

  await t('quoted / punctuated description preserved verbatim', async () => {
    // The original bug report: /todo with a body containing quotes,
    // commas, and example menu-option labels was being dropped. Verify
    // the full body lands intact.
    const sid = 'sess-td-e';
    const cwd = seedSession(sid);
    const body = `for selection question, there are options such as "chat about it", "type something", it will require typing a message and hit submit.`;
    await run('/todo ' + body, { sessionId: sid, absCwd: cwd });
    const data = JSON.parse(fs.readFileSync(path.join(cwd, '_myco_', 'plan.json'), 'utf8'));
    assert.strictEqual(data.items.length, 1);
    assert.strictEqual(data.items[0].text, body);
  });

  // ── per-layer prefixed ids (since 2026-05-15) ──────────────────────

  await t('new items get fr-1 / td-1 / bug-1 (per-layer counter)', async () => {
    const sid = 'sess-id-a';
    const cwd = seedSession(sid);
    await run('/fr a', { sessionId: sid, absCwd: cwd });
    await run('/td b', { sessionId: sid, absCwd: cwd });
    await run('/bug c', { sessionId: sid, absCwd: cwd });
    const data = JSON.parse(fs.readFileSync(path.join(cwd, '_myco_', 'plan.json'), 'utf8'));
    const byText = Object.fromEntries(data.items.map((it) => [it.text, it.id]));
    assert.strictEqual(byText['a'], 'fr-1');
    assert.strictEqual(byText['b'], 'td-1');
    assert.strictEqual(byText['c'], 'bug-1');
  });

  await t('counter increments per layer (fr-1, fr-2; td-1, td-2)', async () => {
    const sid = 'sess-id-b';
    const cwd = seedSession(sid);
    await run('/fr one', { sessionId: sid, absCwd: cwd });
    await run('/td two', { sessionId: sid, absCwd: cwd });
    await run('/fr three', { sessionId: sid, absCwd: cwd });
    await run('/td four', { sessionId: sid, absCwd: cwd });
    const data = JSON.parse(fs.readFileSync(path.join(cwd, '_myco_', 'plan.json'), 'utf8'));
    const byText = Object.fromEntries(data.items.map((it) => [it.text, it.id]));
    assert.strictEqual(byText['one'], 'fr-1');
    assert.strictEqual(byText['three'], 'fr-2');
    assert.strictEqual(byText['two'], 'td-1');
    assert.strictEqual(byText['four'], 'td-2');
  });

  await t('hex-id legacy items are ignored by the counter scan', async () => {
    // Seed with two pre-existing hex-id items, then add a fresh /td
    // and confirm the new id starts at td-1 (not td-3 — the legacy
    // items don't count).
    const sid = 'sess-id-c';
    const cwd = seedSession(sid);
    const store = sessionsMod.loadStore();
    const rec = store.sessions[sid];
    rec.artifacts.plan = {
      items: [
        { id: 'a1b2c3d4e5f6', text: 'legacy 1', layer: 'Todo', done: false, source: 'user' },
        { id: 'deadbeefcafe', text: 'legacy 2', layer: 'Todo', done: false, source: 'user' },
      ],
      updatedAt: null,
    };
    sessionsMod.saveStore();
    await run('/td fresh', { sessionId: sid, absCwd: cwd });
    const data = JSON.parse(fs.readFileSync(path.join(cwd, '_myco_', 'plan.json'), 'utf8'));
    const fresh = data.items.find((it) => it.text === 'fresh');
    assert.strictEqual(fresh.id, 'td-1', 'fresh /td should start at td-1 — legacy hex ids are not counted');
  });

  // ── /merge ─────────────────────────────────────────────────────────

  await t('/merge collapses N items of same layer into lowest-numbered canonical', async () => {
    const sid = 'sess-merge-a';
    const cwd = seedSession(sid);
    await run('/td first', { sessionId: sid, absCwd: cwd });
    await run('/td second', { sessionId: sid, absCwd: cwd });
    await run('/td third', { sessionId: sid, absCwd: cwd });
    const replies = await run('/merge td-1 td-2 td-3', { sessionId: sid, absCwd: cwd });
    assert.ok(replies.some((r) => /merged 3.*td-1/.test(r)), 'expected confirmation naming td-1: ' + JSON.stringify(replies));
    const data = JSON.parse(fs.readFileSync(path.join(cwd, '_myco_', 'plan.json'), 'utf8'));
    assert.strictEqual(data.items.length, 1, 'only canonical survives');
    assert.strictEqual(data.items[0].id, 'td-1');
    assert.ok(/first/.test(data.items[0].text), 'canonical retains its own body');
    assert.ok(/merged from `td-2`/.test(data.items[0].text), 'canonical includes the td-2 divider');
    assert.ok(/merged from `td-3`/.test(data.items[0].text), 'canonical includes the td-3 divider');
    assert.deepStrictEqual(data.items[0].mergedFrom, ['td-2', 'td-3'],
      'mergedFrom should list the absorbed ids');
  });

  await t('/merge refuses to cross layers', async () => {
    const sid = 'sess-merge-b';
    const cwd = seedSession(sid);
    await run('/td a', { sessionId: sid, absCwd: cwd });
    await run('/bug b', { sessionId: sid, absCwd: cwd });
    const replies = await run('/merge td-1 bug-1', { sessionId: sid, absCwd: cwd });
    assert.ok(replies.some((r) => /cannot merge across layers/i.test(r)),
      'expected rejection, got: ' + JSON.stringify(replies));
    const data = JSON.parse(fs.readFileSync(path.join(cwd, '_myco_', 'plan.json'), 'utf8'));
    assert.strictEqual(data.items.length, 2, 'both items remain');
  });

  await t('/merge with an unknown id reports it without mutating', async () => {
    const sid = 'sess-merge-c';
    const cwd = seedSession(sid);
    await run('/td only', { sessionId: sid, absCwd: cwd });
    const replies = await run('/merge td-1 td-99', { sessionId: sid, absCwd: cwd });
    assert.ok(replies.some((r) => /unknown id/i.test(r) && /td-99/.test(r)),
      'expected unknown-id reply, got: ' + JSON.stringify(replies));
    const data = JSON.parse(fs.readFileSync(path.join(cwd, '_myco_', 'plan.json'), 'utf8'));
    assert.strictEqual(data.items.length, 1);
  });

  await t('/merge re-run on already-merged canonical keeps mergedFrom additive', async () => {
    const sid = 'sess-merge-d';
    const cwd = seedSession(sid);
    await run('/td one', { sessionId: sid, absCwd: cwd });
    await run('/td two', { sessionId: sid, absCwd: cwd });
    await run('/td three', { sessionId: sid, absCwd: cwd });
    await run('/merge td-1 td-2', { sessionId: sid, absCwd: cwd });
    await run('/merge td-1 td-3', { sessionId: sid, absCwd: cwd });
    const data = JSON.parse(fs.readFileSync(path.join(cwd, '_myco_', 'plan.json'), 'utf8'));
    assert.strictEqual(data.items.length, 1);
    assert.deepStrictEqual(data.items[0].mergedFrom, ['td-2', 'td-3'],
      'mergedFrom should accumulate across multiple /merge calls');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  if (failed) process.exit(1);
})();
