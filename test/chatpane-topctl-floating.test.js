// 2026-10-23 user report: "chat-main-view 最上面的方框留了空间展示队列，
// 但没有队列的时候 RLM 开关和单列双列开关那行离对话框太远" — the
// chatpane's top band is reserved for the run-queue strip, so with an
// empty queue the topctl row (RLM + 单列/双列 switches) floated alone
// under the icon band, far from the chat input.
//
// Fix contract (this file locks it):
//   1. CSS: `#chatpane.no-queue-floating .chatpane-topctl-row` re-orders
//      the row to sit right above the composer (order past #chat-messages,
//      which owns flex:1) — so with no queue the switches hug the input.
//   2. JS: `_updateTopctlRowPlacement()` toggles the `no-queue-floating`
//      class on #chatpane — set ONLY when the topctl row is visible AND
//      the run-queue strip is hidden. When a queue appears the class is
//      dropped and the row returns to its reserved top band (dynamic
//      adjustment between the two states).
//   3. Both state-change paths call the placement updater: the topctl
//      row's own visibility refresh (_refreshTopctlRow) and the queue
//      strip render (_renderRunQueueStrip, both its empty and non-empty
//      branches).

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + e.message); }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── chatpane topctl floating placement (2026-10-23 report) ──');

const css = _read('web/public/styles.css');
const js = _read('web/public/app.js');

// ── CSS side ──

t('CSS declares the no-queue-floating re-order rule for the topctl row', () => {
  const m = css.match(/#chatpane\.no-queue-floating \.chatpane-topctl-row\s*\{([^}]*)\}/);
  assert.ok(m, 'styles.css must contain a `#chatpane.no-queue-floating .chatpane-topctl-row { … }` block that moves the control row adjacent to the composer when no queue strip is visible.');
  assert.ok(/order:\s*5\s*(?:;|\s*\/\*)/.test(m[1]),
    'the no-queue-floating rule must set a positive order (5) so the row renders AFTER #chat-messages (order 0, flex:1) and lands right above the composer — observed: ' + m[1].trim().slice(0, 120));
});

t('base topctl rule still keeps order:-1 for the queue-visible top band', () => {
  const m = css.match(/\.chatpane-topctl-row\s*\{([^}]*)\}/);
  assert.ok(m, 'base .chatpane-topctl-row block must exist.');
  assert.ok(/order:\s*-1/.test(m[1]),
    'with a queue strip visible the row must keep its reserved top-band slot (order:-1) — observed: ' + m[1].trim().slice(0, 120));
});

t('floating state bumps the bottom stack ABOVE the row (order is comparative)', () => {
  // With only the row at order:5 it renders BELOW the order-0 composer —
  // at the very bottom of the pane, the opposite of the fix. The status
  // row + composer must be bumped past the row (order:10) so the visual
  // order is messages → switches → status → composer.
  const m = css.match(/#chatpane\.no-queue-floating #claude-typing,\s*\n#chatpane\.no-queue-floating #chat-form,\s*\n#chatpane\.no-queue-floating #composer-verdict-pane\s*\{([^}]*)\}/);
  assert.ok(m, 'styles.css must bump #claude-typing / #chat-form / #composer-verdict-pane above the floating topctl row — flex `order` is comparative: an order:5 row alone lands BELOW the order-0 composer at the pane bottom, not above the input.');
  assert.ok(/order:\s*10/.test(m[1]),
    'the bottom stack must use a positive order greater than the row\'s order:5 — observed: ' + m[1].trim().slice(0, 120));
});

// ── JS side ──

t('app.js defines _updateTopctlRowPlacement and toggles the class on #chatpane', () => {
  assert.ok(/function\s+_updateTopctlRowPlacement\s*\(/.test(js),
    'app.js must define _updateTopctlRowPlacement() — the single placement decider.');
  const body = js.slice(js.indexOf('function _updateTopctlRowPlacement'));
  const fnEnd = body.indexOf('\n}', body.indexOf('classList.toggle'));
  const fn = body.slice(0, fnEnd);
  assert.ok(fn.includes("classList.toggle('no-queue-floating'"),
    'placement updater must toggle the `no-queue-floating` class — the exact CSS hook — on the #chatpane element.');
  assert.ok(/rowVisible\s*=\s*!!\(row && !row\.hidden\)/.test(fn),
    'placement must consider the topctl row VISIBLE (row && !row.hidden) — a hidden row must never float.');
  assert.ok(/queueVisible\s*=\s*!!\(strip && !strip\.hidden\)/.test(fn),
    'placement must consider the runqueue strip VISIBILITY (strip && !strip.hidden) — a visible queue sends the row back to the top band.');
  assert.ok(/'no-queue-floating',\s*rowVisible && !queueVisible/.test(fn),
    'class must be set ONLY when rowVisible && !queueVisible (no queue → hug the composer; queue present → top band).');
});

t('_refreshTopctlRow re-runs placement after flipping row visibility', () => {
  const at = js.indexOf('function _refreshTopctlRow()');
  assert.ok(at >= 0, '_refreshTopctlRow() must exist (row visibility entry point).');
  const body = js.slice(at, js.indexOf('\n}', at) + 2);
  assert.ok(body.includes('_updateTopctlRowPlacement()'),
    '_refreshTopctlRow must call _updateTopctlRowPlacement() after setting row.hidden — row visibility is a placement input.');
});

t('_renderRunQueueStrip re-runs placement on BOTH empty and non-empty queue branches', () => {
  const at = js.indexOf('function _renderRunQueueStrip()');
  assert.ok(at >= 0, '_renderRunQueueStrip() must exist (queue strip entry point).');
  const body = js.slice(at, js.indexOf('\n  const pausedBadge', at));
  const emptyBranch = body.slice(body.indexOf('if (!q ||'), body.indexOf('host.hidden = false;'));
  assert.ok(emptyBranch.includes('_updateTopctlRowPlacement()'),
    'the empty-queue branch (host.hidden = true) must call _updateTopctlRowPlacement() so the switches float down to the composer as soon as the queue empties.');
  const nonEmpty = body.slice(body.indexOf('host.hidden = false;'));
  assert.ok(nonEmpty.includes('_updateTopctlRowPlacement()'),
    'the non-empty branch must call _updateTopctlRowPlacement() so the switches return to the top band when a queue appears.');
});

// ── DOM shape ──

t('the topctl row is a DIRECT child of #chatpane (the class hook requires it)', () => {
  const html = _read('web/public/index.html');
  const at = html.indexOf('id="chatpane"');
  assert.ok(at >= 0, 'index.html must declare #chatpane.');
  const rowAt = html.indexOf('id="chatpane-topctl-row"', at);
  assert.ok(rowAt > at, '#chatpane-topctl-row must live inside #chatpane — the CSS `#chatpane.no-queue-floating .chatpane-topctl-row` descendant selector depends on it.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
