// Feature regression: Plan tab "Open only" checkbox filters out done
// items so the user sees only open bugs / features / todos.
//
// Contract:
//   - HTML has a `<input type="checkbox" id="plan-open-only-toggle">`
//     inside the plan-wrap header.
//   - app.js defines bindPlanOpenOnlyToggle() and calls it from the
//     DOMContentLoaded boot path.
//   - The toggle persists in localStorage under key 'myco_plan_open_only'
//     ('1' = on, '0' = off). Default off.
//   - renderArtifact reads the toggle and filters items: when on,
//     only items with !done are passed to the layer-grouping +
//     per-item render.
//   - When all items are filtered out by the toggle, the body shows
//     an explicit "All N item(s) are done. Uncheck Open only…"
//     message rather than the generic empty state.
//
// This test inlines the filter logic against a fixture artifact and
// static-grep-guards the prod source on every contract bullet.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ──────────────────────────────────────────────────────────────────────────
// Inlined filter logic — the contract the prod code must satisfy.

function applyOpenOnlyFilter(items, openOnlyOn) {
  if (!openOnlyOn) return items;
  return items.filter((it) => !it.done);
}

// ──────────────────────────────────────────────────────────────────────────

console.log('── feature: Plan tab "Open only" toggle ──');

t('toggle OFF: all items pass through (3 open + 2 done = 5 shown)', () => {
  const items = [
    { id: 'bug-1',  layer: 'Bug',     done: false },
    { id: 'bug-2',  layer: 'Bug',     done: true  },
    { id: 'fr-1',   layer: 'Feature', done: false },
    { id: 'td-1',   layer: 'Todo',    done: true  },
    { id: 'td-2',   layer: 'Todo',    done: false },
  ];
  const out = applyOpenOnlyFilter(items, false);
  assert.strictEqual(out.length, 5);
});

t('toggle ON: only !done items pass through (3 open shown, 2 done hidden)', () => {
  const items = [
    { id: 'bug-1',  layer: 'Bug',     done: false },
    { id: 'bug-2',  layer: 'Bug',     done: true  },
    { id: 'fr-1',   layer: 'Feature', done: false },
    { id: 'td-1',   layer: 'Todo',    done: true  },
    { id: 'td-2',   layer: 'Todo',    done: false },
  ];
  const out = applyOpenOnlyFilter(items, true);
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.map((x) => x.id).sort(), ['bug-1', 'fr-1', 'td-2']);
});

t('toggle ON with all done: returns empty array (caller renders explicit message)', () => {
  const items = [
    { id: 'bug-1', layer: 'Bug', done: true },
    { id: 'fr-1',  layer: 'Feature', done: true },
  ];
  const out = applyOpenOnlyFilter(items, true);
  assert.strictEqual(out.length, 0);
});

t('toggle ON preserves item order within the filtered subset', () => {
  const items = [
    { id: 'a', done: false },
    { id: 'b', done: true },
    { id: 'c', done: false },
    { id: 'd', done: true },
    { id: 'e', done: false },
  ];
  const out = applyOpenOnlyFilter(items, true);
  assert.deepStrictEqual(out.map((x) => x.id), ['a', 'c', 'e']);
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards on prod.

t('static guard: index.html has the plan-open-only-toggle checkbox in plan-wrap', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'index.html'), 'utf8');
  // Locate the plan-wrap block; assert the toggle lives inside it.
  const planWrapIdx = src.indexOf('id="plan-wrap"');
  assert.ok(planWrapIdx > 0, 'plan-wrap div must exist in index.html');
  // Find the next id="..." block start to scope the window. 4000 chars
  // is comfortably above plan-wrap's typical size.
  const window = src.slice(planWrapIdx, planWrapIdx + 4000);
  assert.ok(/id="plan-open-only-toggle"/.test(window),
    'plan-wrap must contain <input id="plan-open-only-toggle">');
  assert.ok(/Open only/.test(window),
    'the toggle label must say "Open only" so the user knows what it does');
});

t('static guard: app.js defines bindPlanOpenOnlyToggle + calls it from boot', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(/function bindPlanOpenOnlyToggle\(/.test(src),
    'app.js must define bindPlanOpenOnlyToggle()');
  // Boot path: DOMContentLoaded handler must invoke it.
  const domStart = src.indexOf("addEventListener('DOMContentLoaded'");
  assert.ok(domStart > 0, 'DOMContentLoaded handler must exist');
  const domEnd = domStart + 600;
  const domWindow = src.slice(domStart, domEnd);
  assert.ok(/bindPlanOpenOnlyToggle\(\s*\)/.test(domWindow),
    'bindPlanOpenOnlyToggle() must be called from the DOMContentLoaded boot block');
});

t('static guard: localStorage key + default-off semantics', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(/['"]myco_plan_open_only['"]/.test(src),
    'app.js must read/write localStorage key "myco_plan_open_only"');
  // Default off: getItem(...) || "0"  → "0" === "1" is false → off.
  // We accept either explicit `|| "0"` or an equivalent ternary.
  const offDefault = /getItem\(['"]myco_plan_open_only['"]\)\s*\|\|\s*['"]0['"]/;
  assert.ok(offDefault.test(src),
    'default state must be OFF (getItem(...) || "0") so the feature is opt-in');
});

t('static guard: renderArtifact applies the filter when the toggle is on', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  const fnStart = src.indexOf('function renderArtifact');
  assert.ok(fnStart > 0, 'renderArtifact must exist');
  // 8000 chars covers the whole function plus margin (~6000 lines today).
  const fnWindow = src.slice(fnStart, fnStart + 8000);
  // Filter is applied via .filter((it) => !it.done) (or equivalent
  // negated done check). Pin the negation to ensure we filter OUT
  // done items, not IN them.
  assert.ok(/filter\(\s*\(?\s*(it|item|i)\s*\)?\s*=>\s*!\s*(it|item|i)\.done/.test(fnWindow),
    'renderArtifact must filter items via !it.done when openOnly is on');
  assert.ok(/displayItems|filtered|openOnly/.test(fnWindow),
    'renderArtifact must produce a variable carrying the filtered list (displayItems/filtered/openOnly)');
});

t('static guard: explicit "all done" empty-state message exists', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(/All\s+\$\{?\s*items\.length\s*\}?\s+item\(s\)\s+are\s+done/i.test(src)
         || /All\s+\${items\.length}\s+item\(s\)\s+are\s+done/i.test(src),
    'when the filter hides every item, body must show the explicit "All N item(s) are done. Uncheck Open only…" message — not the generic empty state');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
