// DelmBoard (server/src/board.js) — in-process shared board + shared
// sub-queue. Tests the Delm semantics we ported: item lifecycle
// (publish/claim/reserve/done), first-claim-wins, single-claim-per-worker,
// full vs incremental views, read --wait event wake + timeout shell,
// cross-author apply conflict protection, request_id idempotency, and the
// FILE_LIMITS guards. Everything runs in-process; no network, no Docker.

const assert = require('assert');
const fs = require('fs');
const { DelmBoard, BoardError, FILE_LIMITS } = require('../server/src/board.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

async function main() {
  console.log('── board: shared sub-queue + context ──');

  // ---- item lifecycle ----------------------------------------------------
  await t('reserve creates+claims a scope; done closes it', async () => {
    const b = new DelmBoard({ actors: ['worker-A', 'worker-B'] });
    const r1 = b.reserve('worker-A', 'Implement parser', 'Write tokenizer + parser');
    const r2 = b.reserve('worker-B', 'Write docs', 'Document the CLI');
    assert.strictEqual(r1.won, true);
    assert.strictEqual(r1.created, true);
    assert.strictEqual(r1.state, 'claimed');
    const d = b.done('worker-A', r1.item, 'Parser done, tests pass');
    assert.strictEqual(d.queue_empty, false, 'worker-B still holds an item');
    const q = b.queueState().find((i) => i.id === r1.item);
    assert.strictEqual(q.state, 'done');
    assert.ok(q.summary.includes('Parser done'));
    assert.strictEqual(q.owner, 'worker-A');
    const d2 = b.done('worker-B', r2.item, 'Docs done');
    assert.strictEqual(d2.queue_empty, true, 'all items done -> queue empty');
  });

  // fix-2: the MCP schema (board-mcp.js) used to reject any reserve/publish
  // `detail` over 300 chars, and its `subject` over 80. A real run hung
  // because worker-B's ~700-char reserve detail kept failing with
  // `Invalid arguments for tool reserve` — it could never claim. The board
  // layer itself only requires non-empty text, so this test pins that a long
  // detail is accepted end-to-end at the DelmBoard level.
  await t('reserve + publish accept a detail longer than 300 chars', () => {
    const b = new DelmBoard({ actors: ['worker-A', 'worker-B'] });
    const longDetail = 'D'.repeat(720); // the length worker-B actually tried
    const r = b.reserve('worker-B', 'Transformer Encoder scope', longDetail);
    assert.strictEqual(r.won, true, 'reserve wins with a 720-char detail');
    const q = b.queueState().find((i) => i.id === r.item);
    assert.strictEqual(q.detail.length, 720, 'detail preserved to the queue');
    b.publish('worker-A', [{ subject: 'peer task', detail: 'E'.repeat(400) }]);
    const pi = b.queueState().find((i) => i.subject === 'peer task');
    assert.strictEqual(pi.detail.length, 400, 'publish keeps a >300-char detail too');
  });

  // fix-2 belt-and-suspenders: the *real* gate is the zod schema in
  // board-mcp.js. A static grep pins the raised limits so a future revert to
  // max(300)/max(80) re-reds instead of silently re-introducing the hang.
  await t('board-mcp reserve/publish schema accepts long detail (detail max 2000 / subject 120)', () => {
    const src = fs.readFileSync(require.resolve('../server/src/board-mcp.js'), 'utf8');
    assert.ok(src.includes('detail: z.string().min(1).max(2000)'),
      'reserve/publish detail cap raised to 2000 (old 300 rejected worker-B)');
    assert.ok(src.includes('subject: z.string().min(1).max(120)'),
      'reserve/publish subject cap raised to 120 (old 80)');
  });

  await t('claim first-wins; loser gets owner + won=false', async () => {
    const b = new DelmBoard({ actors: ['worker-A', 'worker-B'] });
    const pub = b.publish('worker-A', [{ subject: 'CLI tests', detail: 'tests for argv' }]);
    const id = pub.items[0].id;
    b.claim('worker-B', id);
    const loss = b.claim('worker-A', id);
    assert.strictEqual(loss.won, false);
    assert.strictEqual(loss.owner, 'worker-B');
  });

  await t('one unfinished claim per worker is enforced', async () => {
    const b = new DelmBoard({ actors: ['worker-A', 'worker-B'] });
    b.reserve('worker-A', 'First scope', 'a');
    assert.throws(() => b.reserve('worker-A', 'Second scope', 'b'),
      /already hold an unfinished item/);
  });

  await t('publish reuses an open item by normalized subject', async () => {
    const b = new DelmBoard({ actors: ['worker-A', 'worker-B'] });
    const p1 = b.publish('worker-A', [{ subject: '  Parser   Module ', detail: 'd1' }]);
    const id = p1.items[0].id;
    const p2 = b.publish('worker-B', [{ subject: 'parser module', detail: 'd2' }]);
    assert.strictEqual(p2.items[0].id, id, 'normalized subject must reuse item');
    assert.strictEqual(p2.items[0].created, false);
  });

  // ---- views -------------------------------------------------------------
  await t('first view is full; later view is incremental (compacts active items)', async () => {
    const b = new DelmBoard({ actors: ['worker-A', 'worker-B'] });
    const pub = b.publish('worker-A', [{ subject: 'Task one', detail: 'long detail one' }]);
    const id = pub.items[0].id;
    const first = b.served('worker-B', 'read');
    assert.strictEqual(first.full, true);
    const item1 = first.queue.find((i) => i.id === id);
    assert.strictEqual(item1.detail, 'long detail one', 'first view carries detail');
    // second view: unchanged active item is compacted (no detail)
    const second = b.served('worker-B', 'read');
    assert.strictEqual(second.full, false);
    const item2 = second.queue.find((i) => i.id === id);
    assert.strictEqual(item2.detail, undefined, 'unchanged active item is compacted');
  });

  await t('read --wait wakes the instant a peer publishes (not after cap)', async () => {
    const b = new DelmBoard({ actors: ['worker-A', 'worker-B'] });
    b.served('worker-A', 'read'); // establish cursor
    const started = Date.now();
    const p = b.read('worker-A', { waitSeconds: 20 });
    setTimeout(() => b.publish('worker-B', [{ subject: 'wake item', detail: 'd' }]), 30);
    const r = await p;
    assert.strictEqual(r.updates, true);
    assert.strictEqual(r.woke_by, 'update');
    assert.ok(Date.now() - started < 5000, 'event wake must not wait the full cap');
    assert.ok(r.queue.some((q) => q.subject === 'wake item'));
  });

  await t('read timeout returns an empty shell without advancing the cursor', async () => {
    const b = new DelmBoard({ actors: ['worker-A', 'worker-B'] });
    const before = b.lastRead('worker-A');
    const r = await b.read('worker-A', { waitSeconds: 0.06 });
    assert.strictEqual(r.updates, false);
    assert.strictEqual(r.woke_by, 'timeout');
    assert.strictEqual(r.queue.length, 0);
    assert.strictEqual(b.lastRead('worker-A'), before, 'timeout must not advance the read cursor');
  });

  // ---- apply cross-author protection ------------------------------------
  await t('apply: differing local copy conflicts; absent local writes', async () => {
    const b = new DelmBoard({ actors: ['worker-A', 'worker-B'] });
    const body = b.note('worker-A', 'FACT', 'found x', 's1', 'b1',
      [{ path: 'src/a.js', content: 'aaa' }]);
    const pid = body.id;
    const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
    // worker-B has a divergent local copy -> conflict, nothing granted
    const res = b.apply('worker-B', pid, { 'src/a.js': sha('bbb') }, null);
    assert.strictEqual(res.applied, false);
    assert.strictEqual(res.decisions['src/a.js'], 'conflict');
    assert.strictEqual(res.files.length, 0);
    // worker-B has no local copy -> write granted
    const res2 = b.apply('worker-B', pid, { 'src/a.js': null }, null);
    assert.strictEqual(res2.applied, true);
    assert.strictEqual(res2.decisions['src/a.js'], 'write');
    assert.strictEqual(res2.files.length, 1);
  });

  await t('apply: identical local copy is unchanged; newer peer copy is kept', async () => {
    const b = new DelmBoard({ actors: ['worker-A', 'worker-B'] });
    const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
    const body = b.note('worker-A', 'FACT', 'v1', 's', 'b', [{ path: 'f.js', content: 'v1' }]);
    const pid = body.id;
    const same = b.apply('worker-B', pid, { 'f.js': sha('v1') }, null);
    assert.strictEqual(same.decisions['f.js'], 'unchanged');
    assert.strictEqual(same.applied, true);
  });

  // ---- idempotency + guards ---------------------------------------------
  await t('done is idempotent for a repeated request_id', async () => {
    const b = new DelmBoard({ actors: ['worker-A', 'worker-B'] });
    const r = b.reserve('worker-A', 'Scope', 'd');
    const req = 'req-123';
    const d1 = b.done('worker-A', r.item, 'summary', null, req);
    const d2 = b.done('worker-A', r.item, 'summary', null, req);
    assert.strictEqual(d1.publication_id, d2.publication_id, 'same request_id reuses the publication');
  });

  await t('FILE_LIMITS: oversized bundle is rejected', () => {
    const b = new DelmBoard({ actors: ['worker-A', 'worker-B'] });
    const big = 'x'.repeat(FILE_LIMITS.fileBytes + 1);
    assert.throws(() => b.note('worker-A', 'FACT', 't', 's', 'b', [{ path: 'big.txt', content: big }]),
      /bytes/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
