// fr-64: status chip at the start of each plan-item row.
//
// Renders one of five glyphs derived from existing state — no new
// schema, no server change:
//   ▶  running   — in state.runQueue.entries with status==='running'
//   ⏸  queued    — in state.runQueue.entries with status==='pending'
//   🟢 closed    — it.done truthy
//   📌 inprogress — has it.runs[] history but not currently active/done
//   ⚪ open      — fallthrough default
//
// Precedence is by activity (running > queued > closed > inprogress
// > open) so the chip surfaces the most immediately-relevant state.
//
// Plan items only (supportsVoting branch in renderArtifact). Test
// items have no queue/done lifecycle so the chip wouldn't be
// meaningful there.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── fr-64: plan-item status chip ──');

// ──────────────────────────────────────────────────────────────────────
// app.js — helpers + render wiring
// ──────────────────────────────────────────────────────────────────────

t('app.js: _planItemStatus + _planItemStatusChipHtml + _PLAN_ITEM_STATUS_MAP defined', () => {
  assert.ok(/function\s+_planItemStatus\s*\(/.test(APP),
    'app.js must declare _planItemStatus(it, runQueueEntries) → string');
  assert.ok(/function\s+_planItemStatusChipHtml\s*\(/.test(APP),
    'app.js must declare _planItemStatusChipHtml(status) → HTML string');
  assert.ok(/_PLAN_ITEM_STATUS_MAP/.test(APP),
    'app.js must declare a _PLAN_ITEM_STATUS_MAP constant — pure mapping is testable + grep-pinnable for status renames');
});

t('app.js: status map carries all 5 states with glyph + cls + label', () => {
  const mapIdx = APP.indexOf('_PLAN_ITEM_STATUS_MAP');
  assert.ok(mapIdx > -1);
  const window = APP.slice(mapIdx, mapIdx + 1200);
  for (const state of ['running', 'queued', 'closed', 'inprogress', 'open']) {
    assert.ok(new RegExp(state + ':\\s*\\{').test(window),
      `_PLAN_ITEM_STATUS_MAP must declare the '${state}' state with { glyph, label, cls }`);
  }
  // Each glyph must be present so a CSS / locale refactor can't quietly
  // drop them.
  for (const glyph of ['▶', '⏸', '🟢', '📌', '⚪']) {
    assert.ok(window.indexOf(glyph) > -1,
      `_PLAN_ITEM_STATUS_MAP must include the '${glyph}' glyph`);
  }
});

t('app.js: chip injected at the START of the meta row (before idChip)', () => {
  // Post-bug "rearrange status+id to enlarge text": status + id sit
  // inside an .artifact-item-meta wrapper that stacks ABOVE the text
  // (so text takes full row width). Order within the meta wrapper:
  // statusChip BEFORE idChip so the status glyph is still the leftmost
  // visual at-a-glance signal in the meta strip.
  assert.ok(/<div class="artifact-item-meta">\$\{statusChip\}\$\{idChip\}/.test(APP),
    'plan-item meta wrapper must contain ${statusChip}${idChip} in that order — status glyph stays leftmost in the meta strip');
  // The wrapper itself must be inside .artifact-item-row.
  assert.ok(/<div class="artifact-item-row">[\s\S]{0,200}<div class="artifact-item-meta">/.test(APP),
    '.artifact-item-meta wrapper must live inside .artifact-item-row (which is now flex-direction: column)');
});

t('app.js: chip is computed only when supportsVoting (Plan items, not Test)', () => {
  // Anchor on the `statusChip = supportsVoting ?` ternary. Without
  // this gate the chip would also try to render on Test items (which
  // have no done/queue lifecycle, so the chip would be meaningless).
  assert.ok(/statusChip\s*=\s*supportsVoting\s*\?/.test(APP),
    'statusChip must be gated on `supportsVoting ?` — chip only renders for Plan items');
});

t('app.js: chip reads runQueue from state.runQueue.entries (defensive null-fallback)', () => {
  // The chip's "running" / "queued" branches need the live queue
  // state. Pin the access pattern so a future state refactor that
  // renames .runQueue / .entries doesn't silently break the chip.
  assert.ok(/state\.runQueue\s*&&\s*state\.runQueue\.entries/.test(APP),
    'statusChip must access (state.runQueue && state.runQueue.entries) || [] so a missing queue doesn\'t throw');
});

// ──────────────────────────────────────────────────────────────────────
// CSS — chip + per-status colors
// ──────────────────────────────────────────────────────────────────────

t('CSS: .artifact-item-status-chip styled', () => {
  assert.ok(/\.artifact-item-status-chip\s*\{/.test(CSS),
    'styles.css must define .artifact-item-status-chip (the base chip rule)');
});

t('CSS: each status has its own colored border-left accent', () => {
  // The per-status visual differentiation is what makes the chip
  // useful at-a-glance. Pin that each of the 5 states has a
  // dedicated CSS rule.
  for (const cls of ['is-running', 'is-queued', 'is-closed', 'is-inprogress', 'is-open']) {
    assert.ok(new RegExp('\\.artifact-item-status-chip\\.' + cls + '\\s*\\{').test(CSS),
      `styles.css must declare .artifact-item-status-chip.${cls} so the status is color-distinguishable`);
  }
});

// ──────────────────────────────────────────────────────────────────────
// Behavior — re-implement _planItemStatus inline + pin the precedence
// ──────────────────────────────────────────────────────────────────────

function statusRef(it, runQueueEntries) {
  const entries = Array.isArray(runQueueEntries) ? runQueueEntries : [];
  const qEntry = entries.find((e) => e && e.itemId === it.id);
  if (qEntry && qEntry.status === 'running') return 'running';
  if (qEntry && qEntry.status === 'pending') return 'queued';
  if (it && it.done) return 'closed';
  if (it && Array.isArray(it.runs) && it.runs.length > 0) return 'inprogress';
  return 'open';
}

t('behavior: fresh open item → "open"', () => {
  assert.strictEqual(statusRef({ id: 'fr-1' }, []), 'open');
});

t('behavior: item.done → "closed"', () => {
  assert.strictEqual(statusRef({ id: 'fr-1', done: true }, []), 'closed');
});

t('behavior: item with runs[] but not done → "inprogress"', () => {
  assert.strictEqual(
    statusRef({ id: 'bug-1', runs: [{ status: 'success', ts: 't1' }] }, []),
    'inprogress');
});

t('behavior: in queue + pending → "queued"', () => {
  const queue = [{ itemId: 'bug-1', status: 'pending' }];
  assert.strictEqual(statusRef({ id: 'bug-1' }, queue), 'queued');
});

t('behavior: in queue + running → "running"', () => {
  const queue = [{ itemId: 'bug-1', status: 'running' }];
  assert.strictEqual(statusRef({ id: 'bug-1' }, queue), 'running');
});

t('behavior: precedence — running beats closed', () => {
  // Edge case: item was closed but re-queued and dispatched (or a
  // bug was reopened and is now running). The active state wins.
  const queue = [{ itemId: 'bug-1', status: 'running' }];
  assert.strictEqual(
    statusRef({ id: 'bug-1', done: true }, queue),
    'running',
    'running queue entry must override closed state');
});

t('behavior: precedence — queued beats closed + inprogress', () => {
  const queue = [{ itemId: 'bug-1', status: 'pending' }];
  assert.strictEqual(
    statusRef({ id: 'bug-1', done: true, runs: [{ status: 'success' }] }, queue),
    'queued',
    'queued state must override closed + inprogress');
});

t('behavior: precedence — closed beats inprogress', () => {
  // A closed item with run history → "closed" wins (it's done).
  assert.strictEqual(
    statusRef({ id: 'bug-1', done: true, runs: [{ status: 'success' }] }, []),
    'closed');
});

t('behavior: empty / missing runQueueEntries doesn\'t throw', () => {
  // Defensive: brand-new session with no queue state yet.
  assert.strictEqual(statusRef({ id: 'fr-1' }, undefined), 'open');
  assert.strictEqual(statusRef({ id: 'fr-1' }, null), 'open');
  assert.strictEqual(statusRef({ id: 'fr-1' }, []), 'open');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
