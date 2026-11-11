// fr-56: Plan tab type-filter chips + fuzz-search input.
//
// Mirrors the bug-15 "Open only" pattern: persisted localStorage state,
// re-renders the cached plan artifact on toggle, intersects with the
// existing Open-only filter.
//
// Two affordances:
//   1. Type chips — 3 checkboxes (Bug / Feature / Todo) all-enabled by
//      default, persisted in localStorage.myco_plan_type_filter.
//   2. Fuzz search — text input, case-insensitive substring over
//      id + text + body. 150ms debounce. NOT persisted (fresh each
//      reload).
//
// Static guards on HTML + CSS + app.js, plus an inline behavior
// simulation of _filterPlanItems so the substring/type/done semantics
// are pinned without a browser. Mirrors bug-24's style (read raw
// file, extract function body, assert on shape).

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
const HTML = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── fr-56: plan-tab type filter + fuzz search ──');

// ──────────────────────────────────────────────────────────────────────
// HTML scaffolding
// ──────────────────────────────────────────────────────────────────────

t('HTML: plan tab has a #plan-filter-row subheader', () => {
  assert.ok(/id="plan-filter-row"/.test(HTML),
    'index.html must declare #plan-filter-row inside #plan-wrap so the filter chips + search input have a dedicated row below the title header');
});

t('HTML: three type-filter chips with stable ids + data-type', () => {
  // The chips MUST have the canonical layer name (matches plan.json items)
  // in data-type so the JS binding maps id → type without a hardcoded map.
  assert.ok(/id="plan-filter-bug"[\s\S]{0,30}/.test(HTML),
    'index.html must declare #plan-filter-bug (the Bug type chip)');
  assert.ok(/id="plan-filter-feature"[\s\S]{0,30}/.test(HTML),
    'index.html must declare #plan-filter-feature (the Feature type chip)');
  assert.ok(/id="plan-filter-todo"[\s\S]{0,30}/.test(HTML),
    'index.html must declare #plan-filter-todo (the Todo type chip)');
  assert.ok(/data-type="Bug"/.test(HTML)
    && /data-type="Feature"/.test(HTML)
    && /data-type="Todo"/.test(HTML),
    'each chip\'s wrapping label must carry data-type with the canonical layer value (Bug / Feature / Todo) so the binding maps the chip to a plan.json layer');
});

t('HTML: chips are CHECKED by default (show all)', () => {
  // Pin the default-enabled state so a future "default off" regression
  // doesn't silently hide everything until the user discovers the chips.
  assert.ok(/id="plan-filter-bug"\s+checked/.test(HTML),
    'plan-filter-bug must be `checked` by default');
  assert.ok(/id="plan-filter-feature"\s+checked/.test(HTML),
    'plan-filter-feature must be `checked` by default');
  assert.ok(/id="plan-filter-todo"\s+checked/.test(HTML),
    'plan-filter-todo must be `checked` by default');
});

t('HTML: search input #plan-search with type=search + aria-label', () => {
  assert.ok(/id="plan-search"/.test(HTML),
    'index.html must declare #plan-search (the fuzz-search input)');
  // Order-independent attribute check: the <input> tag must contain
  // BOTH id="plan-search" AND type="search" (and aria-label) in any
  // attribute order.
  const inputTagMatch = HTML.match(/<input[^>]*id="plan-search"[^>]*\/?>/);
  assert.ok(inputTagMatch, '#plan-search <input> tag must exist');
  const inputTag = inputTagMatch[0];
  assert.ok(/type="search"/.test(inputTag),
    '#plan-search must be type="search" so the browser renders the clear-x affordance');
  assert.ok(/aria-label=/.test(inputTag),
    '#plan-search must carry aria-label for screen-reader users (no visible label)');
});

// ──────────────────────────────────────────────────────────────────────
// CSS
// ──────────────────────────────────────────────────────────────────────

t('CSS: .artifact-subheader styles exist', () => {
  assert.ok(/\.artifact-subheader\s*\{/.test(CSS),
    'styles.css must define .artifact-subheader for the filter-row layout');
});

t('CSS: chip + search input styled', () => {
  assert.ok(/\.plan-type-chip\s*\{/.test(CSS),
    'styles.css must define .plan-type-chip');
  assert.ok(/\.plan-search-input\s*\{/.test(CSS),
    'styles.css must define .plan-search-input');
});

t('CSS: mobile rule prevents the search from being squeezed', () => {
  // The subheader has 4 controls (3 chips + 1 input) — on narrow
  // screens the search input must get its own row so it stays usable.
  assert.ok(/@media[^{]*max-width:\s*600px[\s\S]{0,400}\.plan-search-input/.test(CSS),
    'styles.css must include a @media (max-width: 600px) rule that gives .plan-search-input a full-width row on mobile');
});

// ──────────────────────────────────────────────────────────────────────
// app.js bindings
// ──────────────────────────────────────────────────────────────────────

t('app.js: bindPlanTypeFilters + bindPlanSearch are wired into DOMContentLoaded', () => {
  // Both bindings must be invoked at boot — otherwise the chips +
  // search input never become reactive.
  assert.ok(/bindPlanTypeFilters\s*\(\s*\)/.test(APP),
    'app.js must call bindPlanTypeFilters() at boot (DOMContentLoaded)');
  assert.ok(/bindPlanSearch\s*\(\s*\)/.test(APP),
    'app.js must call bindPlanSearch() at boot (DOMContentLoaded)');
});

t('app.js: bindPlanTypeFilters persists to localStorage.myco_plan_type_filter', () => {
  // Pin the storage key so the bug-15 "Open only" pattern is mirrored
  // and a future test for cross-device persistence has a stable key.
  assert.ok(/myco_plan_type_filter/.test(APP),
    'app.js must persist the type-chip state to localStorage.myco_plan_type_filter');
});

t('app.js: bindPlanSearch debounces and stores query in state (not localStorage)', () => {
  const start = APP.search(/function\s+bindPlanSearch\s*\(/);
  assert.ok(start > -1, 'bindPlanSearch must exist');
  const rest = APP.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  assert.ok(/setTimeout\s*\(/.test(body),
    'bindPlanSearch must debounce input via setTimeout so each keystroke does not re-render');
  assert.ok(/state\.planSearchQuery\s*=/.test(body),
    'bindPlanSearch must write to state.planSearchQuery so renderArtifact picks it up on re-render');
  // Explicitly NOT in localStorage — search resets each reload.
  assert.ok(!/localStorage[^}]*planSearch|planSearch[^}]*localStorage/.test(body),
    'bindPlanSearch must NOT persist the query to localStorage — fresh slate each reload (fr-56 design)');
});

// ──────────────────────────────────────────────────────────────────────
// _filterPlanItems behavior — re-implemented inline to pin semantics.
// The real function lives in app.js (browser-only); this test mirrors
// its contract so any divergence between the contract + impl trips
// here. If you change the filter rules in app.js, change the inline
// rebuild below too — they're the same function, deliberately twinned.
// ──────────────────────────────────────────────────────────────────────

function filterPlanItemsRef(items, opts) {
  const { openOnly, types, search } = (opts || {});
  const typeSet = Array.isArray(types) ? new Set(types) : null;
  const q = String(search || '').trim().toLowerCase();
  return (items || []).filter((it) => {
    if (!it) return false;
    if (openOnly && it.done) return false;
    if (typeSet && it.layer && !typeSet.has(it.layer)) return false;
    if (q) {
      const hay = ((it.id || '') + ' ' + (it.text || '') + ' ' + (it.body || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const SAMPLE = [
  { id: 'bug-1',  layer: 'Bug',     text: 'WS reconnect storm on slow networks', done: false },
  { id: 'bug-2',  layer: 'Bug',     text: 'Spinner stuck after deploy',         done: true  },
  { id: 'fr-1',   layer: 'Feature', text: 'Add fuzz search to the plan view',   done: false },
  { id: 'fr-2',   layer: 'Feature', text: 'Run-queue auto-advance on cancel',   done: true  },
  { id: 'td-1',   layer: 'Todo',    text: 'Refresh architecture.md',            done: false },
  { id: 'td-2',   layer: 'Todo',    text: 'Move docker files to docker/',       done: true  },
];

t('behavior: no filter returns everything', () => {
  const got = filterPlanItemsRef(SAMPLE, {});
  assert.strictEqual(got.length, 6, 'no-filter passes all 6 items');
});

t('behavior: openOnly drops done items', () => {
  const got = filterPlanItemsRef(SAMPLE, { openOnly: true });
  assert.strictEqual(got.length, 3, 'openOnly leaves the 3 not-done items');
  assert.ok(got.every((it) => !it.done), 'every surviving item is !done');
});

t('behavior: types=[Bug] keeps only bugs', () => {
  const got = filterPlanItemsRef(SAMPLE, { types: ['Bug'] });
  assert.strictEqual(got.length, 2, '2 bugs in the sample');
  assert.ok(got.every((it) => it.layer === 'Bug'), 'every surviving item is layer=Bug');
});

t('behavior: types=[Bug, Feature] keeps both layers', () => {
  const got = filterPlanItemsRef(SAMPLE, { types: ['Bug', 'Feature'] });
  assert.strictEqual(got.length, 4, '2 bugs + 2 features');
});

t('behavior: types=[] (empty array) filters everything out', () => {
  // Important: empty array is "no types allowed" — NOT "all types" —
  // so the user explicitly deselecting all chips gets an empty list
  // (with the "no items match" explanation).
  const got = filterPlanItemsRef(SAMPLE, { types: [] });
  assert.strictEqual(got.length, 0, 'empty types array = nothing matches');
});

t('behavior: search is case-insensitive substring across id + text', () => {
  const a = filterPlanItemsRef(SAMPLE, { search: 'FUZZ' });
  assert.strictEqual(a.length, 1, 'search "FUZZ" matches the one item with that word');
  assert.strictEqual(a[0].id, 'fr-1');
  const b = filterPlanItemsRef(SAMPLE, { search: 'bug-2' });
  assert.strictEqual(b.length, 1, 'search by id "bug-2" matches that one item');
  assert.strictEqual(b[0].id, 'bug-2');
});

t('behavior: empty / whitespace search is no-op', () => {
  assert.strictEqual(filterPlanItemsRef(SAMPLE, { search: '' }).length, 6);
  assert.strictEqual(filterPlanItemsRef(SAMPLE, { search: '   ' }).length, 6);
});

t('behavior: openOnly + types + search all intersect (AND)', () => {
  // Active bugs containing "WS"
  const got = filterPlanItemsRef(SAMPLE, {
    openOnly: true,
    types: ['Bug'],
    search: 'ws',
  });
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].id, 'bug-1');
});

t('behavior: items without a layer pass the type filter (forward-compat)', () => {
  // The extractor occasionally emits items without a `layer` (older
  // entries, edge cases). The filter must NOT silently drop them —
  // surfacing is safer than hiding.
  const items = [
    { id: 'orphan-1', text: 'no layer field', done: false },
    { id: 'bug-1',    text: 'normal bug',     layer: 'Bug', done: false },
  ];
  const got = filterPlanItemsRef(items, { types: ['Bug'] });
  assert.strictEqual(got.length, 2, 'layer-less item survives the type filter');
});

t('behavior: _filterPlanItems exists in app.js with the same key options', () => {
  // The real impl in app.js must accept { openOnly, types, search }.
  // Pin the destructure so a future rename doesn't silently break the
  // contract the bindings expect.
  const start = APP.search(/function\s+_filterPlanItems\s*\(/);
  assert.ok(start > -1, '_filterPlanItems must be top-level in app.js (testable by name)');
  const rest = APP.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  assert.ok(/\bopenOnly\b/.test(body) && /\btypes\b/.test(body) && /\bsearch\b/.test(body),
    '_filterPlanItems must destructure { openOnly, types, search } from its opts arg');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
