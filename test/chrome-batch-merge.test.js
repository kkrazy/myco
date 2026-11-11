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

// 2026-05-17 ADJACENCY FIX: only merge a chrome batch into the
// previously-walked anchor when (a) they share a sig AND (b)
// nothing other than chrome batches has appeared between them.
// ANY non-chrome element (assistant_text card, chat-msg bubble,
// turn-footer) resets the anchor. Prior behavior collapsed
// across the whole pane by sig, which removed chrome batches
// between assistant_text cards and made them adjacent → the
// assistant_text merge branch in _appendAgentEvent then folded
// claude's replies into one giant card on tab-switch.
function _mergeIdenticalChromeBatches(list) {
  if (!list) return;
  let anchor = null;
  let anchorSig = null;
  for (const el of [...list.children]) {
    if (!el) continue;
    if (el.id === 'chat-load-older') continue;
    if (el.dataset && el.dataset.evType === '_chrome_batch') {
      const sig = _chromeBatchHeadSig(el);
      if (!sig) { anchor = null; anchorSig = null; continue; }
      if (anchor && sig === anchorSig) {
        // Fall through to merge below.
      } else {
        anchor = el;
        anchorSig = sig;
        continue;
      }
    } else {
      // Non-chrome element resets the anchor.
      anchor = null;
      anchorSig = null;
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

t('different-sig batches stay distinct (NON-ADJACENT same-sig is NOT merged — 2026-05-17 adjacency fix)', () => {
  // Layout: a(sig1) b(sig2) c(sig1). Under the OLD global-sig
  // algorithm, c would absorb into a despite b sitting between them.
  // Under the NEW adjacency-aware algorithm, b breaks the chain →
  // c becomes its own anchor and stays distinct.
  //
  // This is the fix for "agent reply message gets merged with
  // previous agent replies" — the chrome batch (b) representing a
  // turn_result between two assistant_text-containing batches MUST
  // prevent the surrounding chrome batches from cross-merging,
  // because if they collapse, the assistant_text cards on either
  // side become DOM-adjacent and _appendAgentEvent's merge branch
  // folds them into one card.
  const a = makeBatch({ sig: 'perm asked', count: 3, firstTs: 't1', lastTs: 't1', rowLabels: ['r1'] });
  const b = makeBatch({ sig: 'result',     count: 2, firstTs: 't2', lastTs: 't2', rowLabels: ['r2'] });
  const c = makeBatch({ sig: 'perm asked', count: 4, firstTs: 't3', lastTs: 't3', rowLabels: ['r3'] });
  const list = makeList([a, b, c]);
  _mergeIdenticalChromeBatches(list);
  assert.strictEqual(a._removed, false, 'a (anchor) survives');
  assert.strictEqual(b._removed, false, 'b (different sig) survives');
  assert.strictEqual(c._removed, false, 'c is NOT absorbed into a — b broke the chain');
  assert.strictEqual(a.dataset.chromeCount, '3', 'a unchanged (no adjacent same-sig batch)');
  assert.strictEqual(b.dataset.chromeCount, '2', 'b unchanged');
  assert.strictEqual(c.dataset.chromeCount, '4', 'c unchanged (became its own anchor)');
});

t('single batch is a no-op', () => {
  const a = makeBatch({ sig: 'perm asked', count: 5, firstTs: 't1', lastTs: 't1', rowLabels: ['r1'] });
  const list = makeList([a]);
  _mergeIdenticalChromeBatches(list);
  assert.strictEqual(a._removed, false);
  assert.strictEqual(a.dataset.chromeCount, '5');
  assert.strictEqual(a.dataset.bug10Merged, undefined, 'no merges, no stamp');
});

t('non-chrome children BREAK the merge chain (2026-05-17 adjacency fix)', () => {
  // Layout: chat-msg, chromeA(sig1), assistant_text, chromeB(sig1).
  // OLD behavior: non-chrome elements were IGNORED — chromeB merged
  // into chromeA across the assistant_text. NEW: an assistant_text
  // between two same-sig chrome batches resets the anchor so they
  // stay distinct. This is the user-reported fix — collapsing chrome
  // batches across an assistant_text removed the visual separator
  // and made consecutive assistant_text cards DOM-adjacent, which
  // _appendAgentEvent then merged into one card.
  const chat = { dataset: { evType: 'chat-msg' }, querySelector: () => null, remove() {} };
  const text = { dataset: { evType: 'assistant_text' }, querySelector: () => null, remove() { this._removed = true; }, _removed: false };
  const a = makeBatch({ sig: 'perm asked', count: 1, firstTs: 't', lastTs: 't', rowLabels: ['r1'] });
  const b = makeBatch({ sig: 'perm asked', count: 1, firstTs: 't', lastTs: 't', rowLabels: ['r2'] });
  const list = makeList([chat, a, text, b]);
  _mergeIdenticalChromeBatches(list);
  assert.strictEqual(a._removed, false, 'a stays');
  assert.strictEqual(b._removed, false, 'b NOT absorbed — assistant_text between resets anchor');
  assert.strictEqual(text._removed, false, 'assistant_text untouched');
  assert.strictEqual(a.dataset.chromeCount, '1', 'a unchanged');
  assert.strictEqual(b.dataset.chromeCount, '1', 'b unchanged (its own anchor)');
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

t('USER-REPORT REGRESSION 2026-05-17: chrome batches across assistant_text cards DO NOT merge', () => {
  // Scenario: user sends "hi", claude replies "Hi!" (turn_result label
  // = "■ success · $0.0001"). User sends another "hi", claude replies
  // "Hi!" again (turn_result label = SAME "■ success · $0.0001").
  // After tab-switch the agent-replay events loop produces:
  //   chromeA(turn_result "■ success · $0.0001")  ← turn 1 tail
  //   assistant_text card "Hi!"                    ← turn 1 reply
  //   chromeB(turn_start/system_init then turn_result "■ success · $0.0001")  ← turn 2
  //   assistant_text card "Hi!"                    ← turn 2 reply
  // Both chromeA and chromeB have the SAME .agent-chrome-last label
  // because they're both successful single-turn replies with the same
  // (tiny, identical) cost. The OLD merge globally merged chromeB
  // into chromeA, REMOVED chromeB, and the two assistant_text cards
  // became DOM-adjacent → _appendAgentEvent's "if prev is
  // assistant_text, merge" branch folded them into one card.
  // The fix: adjacency-aware merge. An assistant_text card between
  // two same-sig chrome batches BREAKS the merge — they stay distinct.
  const chromeA = makeBatch({ sig: '■ success · $0.0001', count: 1, firstTs: 't1', lastTs: 't1', rowLabels: ['turn1-result'] });
  const reply1  = { dataset: { evType: 'assistant_text' }, _removed: false, remove() { this._removed = true; } };
  const chromeB = makeBatch({ sig: '■ success · $0.0001', count: 1, firstTs: 't2', lastTs: 't2', rowLabels: ['turn2-result'] });
  const reply2  = { dataset: { evType: 'assistant_text' }, _removed: false, remove() { this._removed = true; } };
  const list = makeList([chromeA, reply1, chromeB, reply2]);
  _mergeIdenticalChromeBatches(list);
  assert.strictEqual(chromeA._removed, false, 'chromeA stays (anchor for its own segment)');
  assert.strictEqual(reply1._removed,  false, 'reply1 untouched');
  assert.strictEqual(chromeB._removed, false, 'chromeB MUST NOT be absorbed across reply1 (this is the bug)');
  assert.strictEqual(reply2._removed,  false, 'reply2 untouched');
  assert.strictEqual(chromeA.dataset.chromeCount, '1', 'chromeA count unchanged');
  assert.strictEqual(chromeB.dataset.chromeCount, '1', 'chromeB count unchanged');
});

t('static guard: load-older button is computed regardless of CHAT_VISIBLE_LIMIT (2026-05-17 fix)', () => {
  // 2026-05-17 user-report regression: the original
  // _enforceChatHistoryCap had `if (cards.length <= CHAT_VISIBLE_LIMIT)
  // return;` BEFORE the serverPending+archived load-older computation
  // — so when DOM had < 50 cards (the common case), the load-older
  // button was never created, even when the server had hundreds of
  // unfetched messages on disk. User reported: "scroll up doesn't
  // seem to trigger loading more history records" because the
  // IntersectionObserver had no button to fire against.
  //
  // Fix: drop the early return; always compute serverPending and
  // call _ensureLoadOlderButton when it's non-zero.
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  const sigIdx = src.indexOf('function _enforceChatHistoryCap');
  assert.ok(sigIdx >= 0, '_enforceChatHistoryCap not found in app.js');
  const bodyStart = src.indexOf('{', sigIdx);
  let depth = 0, i = bodyStart;
  let bodyEnd = -1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
  }
  assert.ok(bodyEnd > 0, 'could not find _enforceChatHistoryCap body end');
  const body = src.slice(sigIdx, bodyEnd + 1);
  // Old early-return pattern must be gone.
  assert.ok(!/if \(cards\.length <= CHAT_VISIBLE_LIMIT\)\s*\{[^}]*return;/.test(body),
    'CHAT_VISIBLE_LIMIT early-return is back — load-older button will be silently skipped when DOM has < 50 cards, even though server has more rows on disk. Re-introduces user-reported "scroll up doesn\'t trigger loading more history" bug.');
  // The load-older calculation must still be present.
  assert.ok(/_ensureLoadOlderButton\(list,\s*total\)/.test(body),
    '_ensureLoadOlderButton call missing — load-older button never created.');
  assert.ok(/serverPending\s*=\s*Math\.max\(0,\s*\(state\.chatTotal/.test(body),
    'serverPending computation missing — scroll-up won\'t know about server-side unfetched rows.');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
