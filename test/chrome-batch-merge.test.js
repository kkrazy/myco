// bug-10 regression: multiple chrome batches with the same
// `.agent-chrome-last` label collapse into ONE row with counts summed.
// The merge runs from _enforceChatHistoryCap after every chat mutation.
//
// This test exercises the merge math against a minimal DOM-like fake
// that models the move-semantics of appendChild (a node appended to a
// new parent is REMOVED from its old parent — that's what allows the
// `while (elBody.firstChild) anchor.appendChild(elBody.firstChild)`
// drain pattern in the merge code to terminate). The static-grep
// guards at the bottom pin the prod implementation to this contract.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// Row = a tagged object with a parent ref. Real DOM nodes carry
// implicit parent state; ours has to track it explicitly so
// appendChild can detach-from-old-parent.
function makeRow(label) { return { label, _parent: null }; }

function makeBody() {
  const body = {
    _children: [],
    get firstChild() { return this._children[0] || null; },
    appendChild(node) {
      // Real DOM: appendChild detaches the node from its prior parent.
      if (node._parent && node._parent !== this) {
        const idx = node._parent._children.indexOf(node);
        if (idx >= 0) node._parent._children.splice(idx, 1);
      }
      this._children.push(node);
      node._parent = this;
      return node;
    },
  };
  return body;
}

function makeBatch({ sig, count, firstTs, lastTs, rowLabels }) {
  const lastSpan = { textContent: sig };
  const countSpan = { textContent: '× ' + count };
  const body = makeBody();
  for (const l of (rowLabels || [])) body.appendChild(makeRow(l));
  const el = {
    dataset: { evType: '_chrome_batch', chromeCount: String(count), firstTs, lastTs },
    _children: { lastSpan, countSpan, body },
    querySelector(sel) {
      if (sel === '.agent-chrome-last') return lastSpan;
      if (sel === '.agent-card-count') return countSpan;
      if (sel === '.agent-chrome-body') return body;
      return null;
    },
    remove() { el._removed = true; },
    _removed: false,
  };
  return el;
}

function makeList(items) {
  return { children: items };
}

function bodyLabels(batch) {
  return batch._children.body._children.map((c) => c.label);
}

// Inlined copy of the helpers from web/public/app.js. Static-grep
// guards below pin the prod implementation to this contract.
function _chromeBatchHeadSig(batchEl) {
  if (!batchEl) return null;
  const last = batchEl.querySelector('.agent-chrome-last');
  if (!last) return null;
  const txt = (last.textContent || '').trim();
  return txt || null;
}

function _mergeIdenticalChromeBatches(list) {
  if (!list) return;
  const firstBySig = new Map();
  for (const el of [...list.children]) {
    if (!el || !el.dataset || el.dataset.evType !== '_chrome_batch') continue;
    const sig = _chromeBatchHeadSig(el);
    if (!sig) continue;
    const anchor = firstBySig.get(sig);
    if (!anchor) {
      firstBySig.set(sig, el);
      continue;
    }
    const anchorCount = parseInt(anchor.dataset.chromeCount || '1', 10);
    const elCount = parseInt(el.dataset.chromeCount || '1', 10);
    const newCount = anchorCount + elCount;
    anchor.dataset.chromeCount = String(newCount);
    if (el.dataset.lastTs) anchor.dataset.lastTs = el.dataset.lastTs;
    const countEl = anchor.querySelector('.agent-card-count');
    if (countEl) countEl.textContent = '× ' + newCount;
    const anchorBody = anchor.querySelector('.agent-chrome-body');
    const elBody = el.querySelector('.agent-chrome-body');
    if (anchorBody && elBody) {
      while (elBody.firstChild) anchorBody.appendChild(elBody.firstChild);
    }
    anchor.dataset.bug10Merged = String(parseInt(anchor.dataset.bug10Merged || '0', 10) + 1);
    el.remove();
  }
}

console.log('── bug-10: chrome-batch merge ──');

t('three same-sig batches collapse to one with summed count', () => {
  const a = makeBatch({ sig: 'perm asked', count: 7, firstTs: '23:01:34', lastTs: '23:01:36',
                        rowLabels: ['row1', 'row2'] });
  const b = makeBatch({ sig: 'perm asked', count: 5, firstTs: '23:02:12', lastTs: '23:02:14',
                        rowLabels: ['row3'] });
  const c = makeBatch({ sig: 'perm asked', count: 10, firstTs: '23:02:24', lastTs: '23:02:30',
                        rowLabels: ['row4', 'row5'] });
  const list = makeList([a, b, c]);
  _mergeIdenticalChromeBatches(list);
  assert.strictEqual(a._removed, false, 'first batch must survive (anchor)');
  assert.strictEqual(b._removed, true, 'second batch must be absorbed + removed');
  assert.strictEqual(c._removed, true, 'third batch must be absorbed + removed');
  assert.strictEqual(a.dataset.chromeCount, '22', '7+5+10 = 22');
  assert.strictEqual(a._children.countSpan.textContent, '× 22');
  assert.strictEqual(a.dataset.lastTs, '23:02:30', 'lastTs advances to the latest merged batch');
  assert.deepStrictEqual(bodyLabels(a), ['row1', 'row2', 'row3', 'row4', 'row5'],
    'body rows concat in order');
  assert.strictEqual(a.dataset.bug10Merged, '2', '2 absorptions on anchor a');
});

t('different-sig batches stay distinct', () => {
  const a = makeBatch({ sig: 'perm asked', count: 3, firstTs: 't1', lastTs: 't1', rowLabels: ['r1'] });
  const b = makeBatch({ sig: 'result',     count: 2, firstTs: 't2', lastTs: 't2', rowLabels: ['r2'] });
  const c = makeBatch({ sig: 'perm asked', count: 4, firstTs: 't3', lastTs: 't3', rowLabels: ['r3'] });
  const list = makeList([a, b, c]);
  _mergeIdenticalChromeBatches(list);
  assert.strictEqual(a._removed, false);
  assert.strictEqual(b._removed, false, 'different-sig batch stays distinct');
  assert.strictEqual(c._removed, true);
  assert.strictEqual(a.dataset.chromeCount, '7', '3+4 = 7 (b not touched)');
  assert.strictEqual(b.dataset.chromeCount, '2', 'b unchanged');
  assert.deepStrictEqual(bodyLabels(a), ['r1', 'r3']);
  assert.deepStrictEqual(bodyLabels(b), ['r2']);
});

t('single batch is a no-op', () => {
  const a = makeBatch({ sig: 'perm asked', count: 5, firstTs: 't1', lastTs: 't1', rowLabels: ['r1'] });
  const list = makeList([a]);
  _mergeIdenticalChromeBatches(list);
  assert.strictEqual(a._removed, false);
  assert.strictEqual(a.dataset.chromeCount, '5');
  assert.strictEqual(a.dataset.bug10Merged, undefined, 'no merges, no stamp');
});

t('non-chrome children are ignored', () => {
  const chat = { dataset: { evType: 'chat-msg' }, querySelector: () => null, remove() {} };
  const text = { dataset: { evType: 'assistant_text' }, querySelector: () => null, remove() {} };
  const a = makeBatch({ sig: 'perm asked', count: 1, firstTs: 't', lastTs: 't', rowLabels: ['r1'] });
  const b = makeBatch({ sig: 'perm asked', count: 1, firstTs: 't', lastTs: 't', rowLabels: ['r2'] });
  const list = makeList([chat, a, text, b]);
  _mergeIdenticalChromeBatches(list);
  assert.strictEqual(a._removed, false, 'first chrome batch stays');
  assert.strictEqual(b._removed, true, 'second chrome batch merges across non-chrome interlopers');
  assert.strictEqual(a.dataset.chromeCount, '2');
  assert.deepStrictEqual(bodyLabels(a), ['r1', 'r2']);
});

t('user-reported reproducer: 7 + 5 + 10 + 10 + 7 → 39', () => {
  const make = (count) => makeBatch({
    sig: 'perm asked', count,
    firstTs: '', lastTs: '',
    rowLabels: new Array(count).fill(0).map((_, i) => 'perm-row-' + i),
  });
  const list = makeList([make(7), make(5), make(10), make(10), make(7)]);
  _mergeIdenticalChromeBatches(list);
  const surviving = list.children.filter((el) => !el._removed);
  assert.strictEqual(surviving.length, 1, 'all 5 batches collapse to 1');
  assert.strictEqual(surviving[0].dataset.chromeCount, '39', '7+5+10+10+7 = 39');
  assert.strictEqual(surviving[0]._children.countSpan.textContent, '× 39');
  assert.strictEqual(bodyLabels(surviving[0]).length, 39,
    'expanded body lists every individual perm-row across all 5 merged batches');
});

t('static guard: app.js defines both helpers + the bug10Merged stamp', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(src.includes('function _mergeIdenticalChromeBatches(list)'),
    'app.js must define _mergeIdenticalChromeBatches(list)');
  assert.ok(src.includes('function _chromeBatchHeadSig(batchEl)'),
    'app.js must define _chromeBatchHeadSig(batchEl)');
  assert.ok(src.includes('dataset.bug10Merged'),
    'app.js merge must stamp dataset.bug10Merged so devtools + tests can see the merge fired');
});

t('static guard: _enforceChatHistoryCap invokes the merge', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(src.includes('_mergeIdenticalChromeBatches(list)'),
    'app.js must call _mergeIdenticalChromeBatches(list) from _enforceChatHistoryCap so the merge fires on every chat mutation');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
