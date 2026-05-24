// fr-65: per-layer "▶ N closed (tap to expand)" accordion that rolls
// done plan items into a collapsible footer beneath each layer's open
// items. Replaces the all-or-nothing "Open only" toggle (bug-15)
// with finer-grained per-layer control; the two interact cleanly
// — when Open only is on, displayItems has no done items, so the
// accordion's done-bucket is empty and the accordion doesn't render.
//
// State persisted per-layer in localStorage.myco_plan_layer_expand_<key>
// (default '0' = collapsed). Click toggles + re-renders the cached
// plan artifact.

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

console.log('── fr-65: plan layer done-items accordion ──');

// ──────────────────────────────────────────────────────────────────────
// app.js — render path + helpers
// ──────────────────────────────────────────────────────────────────────

t('app.js: _planLayerStorageKey sanitizes layer names for storage', () => {
  // Layer names come from the extractor (Bug / Feature / Todo / Other /
  // possibly arbitrary future values). The storage key must be safe
  // for localStorage (alphanumeric, lowercase). The helper exists as
  // a top-level function for both renderArtifact and the toggle handler.
  assert.ok(/function\s+_planLayerStorageKey\s*\(/.test(APP),
    'app.js must define _planLayerStorageKey(layer) → string for localStorage key shaping');
});

t('app.js: _readPlanLayerExpanded + _writePlanLayerExpanded helpers exist', () => {
  // Read/write pair backed by localStorage.myco_plan_layer_expand_<key>.
  assert.ok(/function\s+_readPlanLayerExpanded\s*\(/.test(APP),
    'app.js must define _readPlanLayerExpanded(layerKey) → boolean');
  assert.ok(/function\s+_writePlanLayerExpanded\s*\(/.test(APP),
    'app.js must define _writePlanLayerExpanded(layerKey, expanded) → void');
  // The persistence key must be stable for the regression-test pin
  // + cross-session compatibility (a user who toggled Bug=expanded
  // last visit should see Bug expanded on next visit).
  assert.ok(/myco_plan_layer_expand_/.test(APP),
    'app.js must persist accordion state under localStorage.myco_plan_layer_expand_<key>');
});

t('app.js: renderArtifact partitions each layer into open + done', () => {
  // Inside the layer-rendering block, each layer's items must be
  // partitioned into open (it.done falsy) + done (it.done truthy).
  // We grep for the .filter shape that does this work; anchor on
  // the layer-grouping comment that's nearby + use a 2000-char
  // window so the partition lines fall inside.
  const anchorIdx = APP.indexOf('Group plan items by layer');
  assert.ok(anchorIdx > -1, 'layer-grouping comment must exist as the anchor');
  const window = APP.slice(anchorIdx, anchorIdx + 2500);
  assert.ok(/openItems\s*=\s*items\.filter\(\(it\)\s*=>\s*!it\.done\)/.test(window),
    'each layer must extract openItems via items.filter((it) => !it.done) so the accordion can hold the done bucket separately');
  assert.ok(/doneItems\s*=\s*items\.filter\(\(it\)\s*=>\s*it\.done\)/.test(window),
    'each layer must extract doneItems via items.filter((it) => it.done) for the accordion bucket');
});

t('app.js: accordion only renders when doneItems > 0', () => {
  // If a layer has no done items, the accordion adds no value + would
  // clutter the layout. Guard pins the conditional shape.
  const fnIdx = APP.indexOf('artifact-layer-accordion');
  assert.ok(fnIdx > -1, '.artifact-layer-accordion must appear in app.js (the accordion DOM)');
  const window = APP.slice(Math.max(0, fnIdx - 500), fnIdx + 100);
  assert.ok(/doneItems\.length\s*>\s*0/.test(window),
    'accordion render must be gated on doneItems.length > 0 — no done items = no accordion');
});

t('app.js: accordion toggle button carries data-layer + aria-expanded', () => {
  // The toggle button must carry the layer key (so the click handler
  // knows which layer's state to flip) AND aria-expanded for a11y.
  assert.ok(/<button\s+class="artifact-layer-accordion-toggle"\s+data-layer="\$\{escHtml\(layerKey\)\}"/.test(APP),
    'toggle button must declare class="artifact-layer-accordion-toggle" with data-layer="<key>" so the click delegation can map back to the layer');
  assert.ok(/aria-expanded="\$\{expanded\s*\?\s*'true'\s*:\s*'false'\}"/.test(APP),
    'toggle button must set aria-expanded based on the expand state for screen-reader users');
});

t('app.js: click handler bound on .artifact-layer-accordion-toggle', () => {
  // After render, the wiring code attaches a click listener that
  // reads the layer key, flips persisted state, and re-renders the
  // cached plan artifact for instant feedback.
  assert.ok(/querySelectorAll\(\s*['"]\.artifact-layer-accordion-toggle['"]\s*\)/.test(APP),
    'the artifact-binding code must querySelectorAll(.artifact-layer-accordion-toggle) to wire the click handler');
  // Anchor on the querySelectorAll binding line (not the render-time
  // .artifact-layer-accordion-toggle DOM class), then check the
  // handler body that follows.
  const bindingIdx = APP.search(/querySelectorAll\(\s*['"]\.artifact-layer-accordion-toggle['"]\s*\)/);
  assert.ok(bindingIdx > -1, 'querySelectorAll binding must be findable');
  const handlerWindow = APP.slice(bindingIdx, bindingIdx + 800);
  assert.ok(/_writePlanLayerExpanded\s*\(/.test(handlerWindow),
    'accordion-toggle click handler must call _writePlanLayerExpanded to persist the flip');
  assert.ok(/renderArtifact\s*\(\s*['"]plan['"]/.test(handlerWindow),
    'accordion-toggle click handler must re-call renderArtifact(\'plan\', cached) so the toggle takes effect immediately');
});

// ──────────────────────────────────────────────────────────────────────
// CSS — accordion styling
// ──────────────────────────────────────────────────────────────────────

t('CSS: .artifact-layer-accordion-toggle styled', () => {
  assert.ok(/\.artifact-layer-accordion-toggle\s*\{/.test(CSS),
    'styles.css must declare .artifact-layer-accordion-toggle');
  assert.ok(/\.artifact-layer-accordion-toggle:hover/.test(CSS),
    'styles.css must declare a :hover state on .artifact-layer-accordion-toggle for affordance feedback');
});

t('CSS: .artifact-items-done dims slightly to keep focus on open items', () => {
  // Visual cue that done items are "secondary" — opacity slightly
  // below 1 so the open items above remain the primary focus.
  const doneBlock = CSS.match(/\.artifact-items-done\s*\{[\s\S]*?\}/);
  assert.ok(doneBlock, '.artifact-items-done rule must exist');
  assert.ok(/opacity:\s*0?\.[0-9]+/.test(doneBlock[0]),
    '.artifact-items-done must declare opacity < 1 to visually de-emphasize done items below open ones');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation — partition + storage-key shape pin without DOM
// ──────────────────────────────────────────────────────────────────────

function partitionLayer(items) {
  return {
    openItems: items.filter((it) => !it.done),
    doneItems: items.filter((it) => it.done),
  };
}

function storageKey(layer) {
  return String(layer || 'Other').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

t('behavior: partition splits items by done flag', () => {
  const items = [
    { id: 'bug-1', layer: 'Bug', done: false },
    { id: 'bug-2', layer: 'Bug', done: true },
    { id: 'bug-3', layer: 'Bug', done: true },
    { id: 'bug-4', layer: 'Bug', done: false },
  ];
  const { openItems, doneItems } = partitionLayer(items);
  assert.strictEqual(openItems.length, 2);
  assert.strictEqual(doneItems.length, 2);
  assert.deepStrictEqual(openItems.map((it) => it.id), ['bug-1', 'bug-4']);
  assert.deepStrictEqual(doneItems.map((it) => it.id), ['bug-2', 'bug-3']);
});

t('behavior: accordion empty when all items open (no done bucket)', () => {
  const items = [
    { id: 'fr-1', layer: 'Feature', done: false },
    { id: 'fr-2', layer: 'Feature', done: false },
  ];
  const { doneItems } = partitionLayer(items);
  assert.strictEqual(doneItems.length, 0, 'no done items → accordion does not render');
});

t('behavior: storageKey shape is alphanumeric lowercase', () => {
  assert.strictEqual(storageKey('Bug'), 'bug');
  assert.strictEqual(storageKey('Feature'), 'feature');
  assert.strictEqual(storageKey('Todo'), 'todo');
  assert.strictEqual(storageKey('Other'), 'other');
  // Unusual extractor outputs should still produce safe keys.
  assert.strictEqual(storageKey('UI/UX'), 'uiux');
  assert.strictEqual(storageKey('Backend & Infra'), 'backendinfra');
  assert.strictEqual(storageKey(null), 'other');
  assert.strictEqual(storageKey(''), 'other');
});

t('behavior: bug-15 "Open only" toggle interacts cleanly with fr-65 accordion', () => {
  // When Open only is ON, displayItems has no done items → each layer's
  // doneItems is empty → no accordion renders. fr-65 is a no-op when
  // bug-15's filter is on. Pin this so a future refactor doesn't make
  // them step on each other.
  const items = [
    { id: 'bug-1', layer: 'Bug', done: false },
    { id: 'bug-2', layer: 'Bug', done: true },
  ];
  // Simulate the bug-15 pre-filter: items.filter((it) => !it.done)
  const afterOpenOnly = items.filter((it) => !it.done);
  const { doneItems } = partitionLayer(afterOpenOnly);
  assert.strictEqual(doneItems.length, 0,
    'bug-15 Open-only filter feeds an all-open subset to the partition → done bucket is empty → accordion does not render');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
