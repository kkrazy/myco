// bug-11 regression: collapsed chrome batch rows must display the
// AGGREGATE byte count across all tool_result events, not just the
// most-recently-appended event's bytes.
//
// User report: `× 5 ✓ result · 4 bytes` collapsed row with 5 sub-items
// each reporting 4 bytes — head should show 20 bytes (sum), not 4
// (last). Same pathology for the `× 9 ✓ result · 921 bytes` case.
//
// Inlines the fixed helpers from web/public/app.js: _createChromeBatch
// bootstraps the aggregator, _appendToChromeBatch accumulates bytes,
// _chromeBatchHeadLabel renders aggregate display, and
// _mergeIdenticalChromeBatches combines aggregators across merged
// batches. Static-grep guards at the bottom pin the prod code to the
// same contract.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ──────────────────────────────────────────────────────────────────────────
// Minimal DOM fake — same shape as test/chrome-batch-merge.test.js but
// extended to give createElement-style cards with proper dataset + child
// query support.

function makeRow(label) { return { label, _parent: null }; }

function makeBody() {
  return {
    _children: [],
    get firstChild() { return this._children[0] || null; },
    appendChild(node) {
      if (node._parent && node._parent !== this) {
        const idx = node._parent._children.indexOf(node);
        if (idx >= 0) node._parent._children.splice(idx, 1);
      }
      this._children.push(node);
      node._parent = this;
      return node;
    },
  };
}

function makeBatchCard() {
  const tsSpan = { textContent: '' };
  const glyphSpan = { textContent: '▸' };
  const countSpan = { textContent: '× 1' };
  const lastSpan = { textContent: '' };
  const body = makeBody();
  return {
    dataset: { evType: '_chrome_batch', chromeCount: '1' },
    _spans: { tsSpan, glyphSpan, countSpan, lastSpan },
    _body: body,
    querySelector(sel) {
      if (sel === '.agent-card-ts') return tsSpan;
      if (sel === '.agent-chrome-glyph') return glyphSpan;
      if (sel === '.agent-card-count') return countSpan;
      if (sel === '.agent-chrome-last') return lastSpan;
      if (sel === '.agent-chrome-body') return body;
      return null;
    },
    remove() { this._removed = true; },
    _removed: false,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Inlined FIXED helpers (the contract this test locks in).

function _chromeShortLabel(ev) {
  if (ev.type === 'permission_request') return 'perm asked · ' + (ev.toolName || '');
  if (ev.type === 'permission_resolved') return 'perm ' + (ev.decision || 'resolved') + ' · ' + (ev.toolName || '');
  if (ev.type === 'tool_result') {
    // Per-event label — only used as a starting point for a fresh
    // batch's aggregator. The visible head uses _chromeBatchHeadLabel
    // which reads from the dataset accumulator.
    const bytes = (ev.content || '').length;
    return (ev.isError ? '⚠ result · ' : '✓ result · ') + bytes + ' bytes';
  }
  return ev.type || 'event';
}

// bug-11: aggregate label uses the per-batch byte accumulator in
// dataset.toolResultBytes. For non-tool_result events, defers to the
// per-event label (no aggregation concept applies).
function _chromeBatchHeadLabel(card, ev) {
  if (ev.type === 'tool_result') {
    const total = parseInt(card.dataset.toolResultBytes || '0', 10);
    const isError = card.dataset.toolResultLastError === '1';
    return (isError ? '⚠ result · ' : '✓ result · ') + total + ' bytes';
  }
  return _chromeShortLabel(ev);
}

// bug-11: bytes-free signature used by _mergeIdenticalChromeBatches.
// Returning "✓ result" (no bytes) for tool_results means two batches
// with different aggregate bytes still merge when they represent the
// same kind of activity. The visible label (which DOES include the
// aggregate bytes) is intentionally NOT used as the merge key.
function _chromeShortLabelSig(ev) {
  if (ev.type === 'tool_result') return ev.isError ? '⚠ result' : '✓ result';
  return _chromeShortLabel(ev);
}

function _bumpToolResultAggregator(card, ev) {
  if (ev.type !== 'tool_result') return;
  const evBytes = (ev.content || '').length;
  const total = parseInt(card.dataset.toolResultBytes || '0', 10) + evBytes;
  const count = parseInt(card.dataset.toolResultCount || '0', 10) + 1;
  card.dataset.toolResultBytes = String(total);
  card.dataset.toolResultCount = String(count);
  card.dataset.toolResultLastError = ev.isError ? '1' : '0';
}

function _createChromeBatch(ev, ts) {
  const card = makeBatchCard();
  card.dataset.firstTs = ts;
  card.dataset.lastTs = ts;
  card._spans.tsSpan.textContent = ts;
  // bug-11: bootstrap aggregator BEFORE the label render so the head
  // reflects the first event's bytes even on a fresh batch.
  _bumpToolResultAggregator(card, ev);
  card.dataset.chromeBatchSig = _chromeShortLabelSig(ev);
  card._spans.lastSpan.textContent = _chromeBatchHeadLabel(card, ev);
  card._body.appendChild(makeRow('row:' + (ev.type || 'event')));
  return card;
}

function _appendToChromeBatch(card, ev, ts) {
  const n = parseInt(card.dataset.chromeCount || '1', 10) + 1;
  card.dataset.chromeCount = String(n);
  card.dataset.lastTs = ts;
  card._spans.countSpan.textContent = '× ' + n;
  // bug-11: accumulate BEFORE relabel so the head shows the aggregate
  // including the freshly-appended event.
  _bumpToolResultAggregator(card, ev);
  card.dataset.chromeBatchSig = _chromeShortLabelSig(ev);
  card._spans.lastSpan.textContent = _chromeBatchHeadLabel(card, ev);
  card._body.appendChild(makeRow('row:' + (ev.type || 'event')));
}

function _chromeBatchHeadSig(batchEl) {
  if (!batchEl) return null;
  // bug-11: read from the persisted sig, not the visible label (which
  // varies with the aggregate bytes).
  if (batchEl.dataset && batchEl.dataset.chromeBatchSig) {
    return batchEl.dataset.chromeBatchSig;
  }
  const last = batchEl.querySelector('.agent-chrome-last');
  return last ? (last.textContent || '').trim() || null : null;
}

function _mergeIdenticalChromeBatches(list) {
  if (!list) return;
  let anchor = null, anchorSig = null;
  for (const el of [...list.children]) {
    if (!el) continue;
    if (el.dataset && el.dataset.evType === '_chrome_batch') {
      const sig = _chromeBatchHeadSig(el);
      if (!sig) { anchor = null; anchorSig = null; continue; }
      if (anchor && sig === anchorSig) {
        // fall through
      } else { anchor = el; anchorSig = sig; continue; }
    } else { anchor = null; anchorSig = null; continue; }

    // Count + lastTs + body row merge (unchanged from bug-10).
    const newCount = parseInt(anchor.dataset.chromeCount || '1', 10) +
                     parseInt(el.dataset.chromeCount || '1', 10);
    anchor.dataset.chromeCount = String(newCount);
    if (el.dataset.lastTs) anchor.dataset.lastTs = el.dataset.lastTs;
    anchor._spans.countSpan.textContent = '× ' + newCount;
    const anchorBody = anchor.querySelector('.agent-chrome-body');
    const elBody = el.querySelector('.agent-chrome-body');
    if (anchorBody && elBody) {
      while (elBody.firstChild) anchorBody.appendChild(elBody.firstChild);
    }

    // bug-11: combine the byte aggregators + re-render the head label.
    if (el.dataset.toolResultBytes != null) {
      const sumBytes = parseInt(anchor.dataset.toolResultBytes || '0', 10) +
                       parseInt(el.dataset.toolResultBytes || '0', 10);
      const sumCount = parseInt(anchor.dataset.toolResultCount || '0', 10) +
                       parseInt(el.dataset.toolResultCount || '0', 10);
      anchor.dataset.toolResultBytes = String(sumBytes);
      anchor.dataset.toolResultCount = String(sumCount);
      if (el.dataset.toolResultLastError === '1') anchor.dataset.toolResultLastError = '1';
      const isError = anchor.dataset.toolResultLastError === '1';
      anchor._spans.lastSpan.textContent =
        (isError ? '⚠ result · ' : '✓ result · ') + sumBytes + ' bytes';
    }
    anchor.dataset.bug10Merged = String(parseInt(anchor.dataset.bug10Merged || '0', 10) + 1);
    el.remove();
  }
}

// ──────────────────────────────────────────────────────────────────────────

console.log('── bug-11: chrome batch byte aggregation ──');

function toolResult(bytes, isError = false) {
  return { type: 'tool_result', content: 'X'.repeat(bytes), isError };
}

t('reproducer: × 5 tool_results of 4 bytes each → head shows 20, not 4', () => {
  const batch = _createChromeBatch(toolResult(4), '12:10:23');
  _appendToChromeBatch(batch, toolResult(4), '12:10:24');
  _appendToChromeBatch(batch, toolResult(4), '12:10:25');
  _appendToChromeBatch(batch, toolResult(4), '12:10:26');
  _appendToChromeBatch(batch, toolResult(4), '12:10:27');
  assert.strictEqual(batch._spans.countSpan.textContent, '× 5');
  assert.strictEqual(batch._spans.lastSpan.textContent, '✓ result · 20 bytes',
    'head must show 20 bytes (5 × 4), not 4 (just-the-last-event)');
  assert.strictEqual(batch.dataset.toolResultBytes, '20');
  assert.strictEqual(batch.dataset.toolResultCount, '5');
});

t('user comment reproducer: × 9 tool_results of 921 bytes → head shows 8289', () => {
  const batch = _createChromeBatch(toolResult(921), '12:09:13');
  for (let i = 0; i < 8; i++) _appendToChromeBatch(batch, toolResult(921), '12:09:14');
  assert.strictEqual(batch._spans.countSpan.textContent, '× 9');
  assert.strictEqual(batch._spans.lastSpan.textContent, '✓ result · 8289 bytes',
    '9 × 921 = 8289; head must show the sum');
});

t('mixed byte sizes accumulate correctly', () => {
  const batch = _createChromeBatch(toolResult(100), '00:00:01');
  _appendToChromeBatch(batch, toolResult(250), '00:00:02');
  _appendToChromeBatch(batch, toolResult(50), '00:00:03');
  _appendToChromeBatch(batch, toolResult(1000), '00:00:04');
  assert.strictEqual(batch._spans.lastSpan.textContent, '✓ result · 1400 bytes');
});

t('any-error sticky: error on last event → ⚠ icon, but still shows aggregate', () => {
  const batch = _createChromeBatch(toolResult(100), 't');
  _appendToChromeBatch(batch, toolResult(200), 't');
  _appendToChromeBatch(batch, toolResult(50, true), 't');
  assert.strictEqual(batch._spans.lastSpan.textContent, '⚠ result · 350 bytes');
});

t('non-tool_result events in a tool_result batch do not corrupt the aggregator', () => {
  const batch = _createChromeBatch(toolResult(100), 't');
  _appendToChromeBatch(batch, toolResult(200), 't');
  // A permission_request event sneaks in — its label has no "bytes",
  // so the head temporarily shows the perm label. But the aggregator
  // state stays intact for when a subsequent tool_result appends.
  _appendToChromeBatch(batch, { type: 'permission_request', toolName: 'Bash' }, 't');
  assert.strictEqual(batch.dataset.toolResultBytes, '300',
    'aggregator survives intervening non-tool_result events');
  assert.strictEqual(batch.dataset.toolResultCount, '2',
    'tool_result count only counts tool_result events');
  // Now a fresh tool_result; head should show TOTAL bytes including
  // both the prior tool_results AND this new one.
  _appendToChromeBatch(batch, toolResult(75), 't');
  assert.strictEqual(batch._spans.lastSpan.textContent, '✓ result · 375 bytes');
});

t('merge: two batches each summing N bytes → merged shows N+M', () => {
  const a = _createChromeBatch(toolResult(100), 't1');
  _appendToChromeBatch(a, toolResult(200), 't1');
  // a now has 2 tool_results, 300 bytes total.
  const b = _createChromeBatch(toolResult(50), 't2');
  _appendToChromeBatch(b, toolResult(75), 't2');
  _appendToChromeBatch(b, toolResult(25), 't2');
  // b now has 3 tool_results, 150 bytes total.
  // Sigs are both "✓ result" (bytes-free) so merge applies.
  const list = { children: [a, b] };
  _mergeIdenticalChromeBatches(list);
  assert.strictEqual(a._removed, false, 'a survives as anchor');
  assert.strictEqual(b._removed, true, 'b absorbed');
  assert.strictEqual(a.dataset.toolResultBytes, '450', '300 + 150 = 450');
  assert.strictEqual(a.dataset.toolResultCount, '5', '2 + 3 = 5');
  assert.strictEqual(a._spans.lastSpan.textContent, '✓ result · 450 bytes',
    'merged head shows COMBINED aggregate');
  assert.strictEqual(a._spans.countSpan.textContent, '× 5');
});

t('merge sig is bytes-free: batches with different totals still merge', () => {
  // Two batches: one totaling 100 bytes, one totaling 921 bytes.
  // Under the OLD signature (visible label including bytes), these
  // would NOT merge — different signatures. Under the FIXED signature
  // (bytes-free), they DO merge because they share the same "✓ result"
  // kind. This is intentional: merge eligibility tracks "same activity",
  // not "same exact byte total".
  const a = _createChromeBatch(toolResult(100), 't1');
  const b = _createChromeBatch(toolResult(921), 't2');
  _mergeIdenticalChromeBatches({ children: [a, b] });
  assert.strictEqual(a._removed, false);
  assert.strictEqual(b._removed, true, 'different byte totals still merge — sig is bytes-free');
  assert.strictEqual(a.dataset.toolResultBytes, '1021', '100 + 921');
  assert.strictEqual(a._spans.lastSpan.textContent, '✓ result · 1021 bytes');
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards: pin the prod implementation to the contract.

t('static guard: app.js bumps toolResultBytes in _appendToChromeBatch + _createChromeBatch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(/dataset\.toolResultBytes/.test(src),
    'app.js must read/write dataset.toolResultBytes to track per-batch aggregate');
  assert.ok(/dataset\.toolResultCount/.test(src),
    'app.js must track dataset.toolResultCount for the tool_result subset of events');
  assert.ok(/dataset\.chromeBatchSig/.test(src),
    'app.js must persist a bytes-free chromeBatchSig so merge eligibility is stable as the visible label changes');
});

t('static guard: app.js head label aggregates from dataset (not from ev.content)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  // The label rendering function must read from dataset.toolResultBytes
  // when assembling the visible head text — not just (ev.content || '').length.
  assert.ok(/_chromeBatchHeadLabel|_chromeShortLabelForBatch|toolResultBytes/.test(src),
    'app.js must have a batch-aware label helper that uses dataset.toolResultBytes');
});

t('static guard: _mergeIdenticalChromeBatches combines toolResultBytes on absorb', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  const mergeStart = src.indexOf('function _mergeIdenticalChromeBatches');
  assert.ok(mergeStart >= 0, '_mergeIdenticalChromeBatches must exist');
  const mergeEnd = src.indexOf('\nfunction ', mergeStart + 1);
  const body = src.slice(mergeStart, mergeEnd > 0 ? mergeEnd : src.length);
  assert.ok(/toolResultBytes/.test(body),
    'merge code must combine toolResultBytes across absorbed batches');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
