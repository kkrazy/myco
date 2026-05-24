// fr-90 Phase 4: pre-dispatch path-overlap heuristic + UI chip.
//
// queueItemForRun runs _findPathOverlap against other active queue
// entries (pending/running). If this item's body+comments mention
// any of the same file paths as another active entry, the new entry
// gets stamped with entry.overlapWarning = [{itemId, paths}, ...].
// The UI surfaces "⚠ overlap × N" chip on the plan card.
// Heuristic — NOT a hard gate. Conflict surfacing on COMPLETED runs
// stays in Phase 3's wtChip.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ARTIFACTS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');
const APP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const STYLES_CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── fr-90 Phase 4: overlap heuristic + UI chip ──');

// ──────────────────────────────────────────────────────────────────────
// artifacts.js helpers
// ──────────────────────────────────────────────────────────────────────

t('artifacts.js: _extractFilePaths + _findPathOverlap defined + exported', () => {
  assert.ok(/^function\s+_extractFilePaths\s*\(/m.test(ARTIFACTS_SRC),
    '_extractFilePaths at module scope');
  assert.ok(/^function\s+_findPathOverlap\s*\(/m.test(ARTIFACTS_SRC),
    '_findPathOverlap at module scope');
  const exportsIdx = ARTIFACTS_SRC.search(/module\.exports\s*=\s*\{/);
  const win = ARTIFACTS_SRC.slice(exportsIdx, exportsIdx + 3000);
  for (const name of ['_extractFilePaths', '_findPathOverlap']) {
    assert.ok(new RegExp('\\b' + name + '\\b').test(win),
      name + ' must be in module.exports');
  }
});

t('artifacts.js: queueItemForRun runs overlap detection + stamps entry.overlapWarning', () => {
  const idx = ARTIFACTS_SRC.search(/function\s+queueItemForRun\s*\(/);
  const win = ARTIFACTS_SRC.slice(idx, idx + 4500);
  assert.ok(/_findPathOverlap/.test(win),
    'queueItemForRun must call _findPathOverlap');
  assert.ok(/entry\.overlapWarning/.test(win),
    'must stamp entry.overlapWarning on overlap');
  assert.ok(/try\s*\{[\s\S]{0,800}_findPathOverlap[\s\S]{0,400}\}\s*catch/.test(win),
    'overlap detection must be in try/catch — failure must not block dispatch');
});

// ──────────────────────────────────────────────────────────────────────
// UI chip
// ──────────────────────────────────────────────────────────────────────

t('app.js: overlapChip reads from runQueue entry overlapWarning', () => {
  assert.ok(/overlapChip/.test(APP_SRC), 'overlapChip variable must be declared');
  assert.ok(/overlapWarning/.test(APP_SRC),
    'must read from entry.overlapWarning');
  assert.ok(/artifact-item-overlap/.test(APP_SRC),
    'chip class .artifact-item-overlap must be rendered');
});

t('app.js: actionsRow renders ${overlapChip}', () => {
  const idx = APP_SRC.search(/const\s+actionsRow\s*=\s*`<div class="artifact-item-actions">/);
  const end = APP_SRC.indexOf('</div>`;', idx);
  const win = APP_SRC.slice(idx, end);
  assert.ok(/\$\{overlapChip\}/.test(win),
    'actionsRow must include ${overlapChip}');
});

t('styles.css: .artifact-item-overlap styled (orange warning palette)', () => {
  assert.ok(/\.artifact-item-overlap\b/.test(STYLES_CSS),
    'selector present');
  // Same color family as the conflicted-wt chip (orange) — visual
  // consistency for warning-class chips.
  assert.ok(/\.artifact-item-overlap[\s\S]{0,400}#f0883e/.test(STYLES_CSS) ||
            /\.artifact-item-overlap[\s\S]{0,400}rgba\(240,\s*136,\s*62/.test(STYLES_CSS),
    'overlap chip must use orange palette (matches conflicted-wt)');
  // Mobile: hide the text, keep the icon — matches other chips.
  assert.ok(/@media\s*\(\s*max-width:\s*900px\s*\)[\s\S]{0,500}\.artifact-item-overlap[\s\S]{0,100}\.btn-text[\s\S]{0,50}display:\s*none/.test(STYLES_CSS),
    'mobile @media must hide .artifact-item-overlap .btn-text');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation
// ──────────────────────────────────────────────────────────────────────

t('behavior: _extractFilePaths finds paths with /, skips bare extensions + URLs', () => {
  delete require.cache[require.resolve('../server/src/artifacts')];
  const artifacts = require('../server/src/artifacts');
  const paths = artifacts._extractFilePaths(
    'modify `server/src/attach.js` and web/public/app.js. ' +
    'Check file.js (bare — no slash, skip). ' +
    'See https://example.com/foo.js (URL, skip). ' +
    'Also touch test/fr-90-phase4.test.js'
  );
  assert.ok(paths.includes('server/src/attach.js'),
    'must find server/src/attach.js (backtick-wrapped)');
  assert.ok(paths.includes('web/public/app.js'),
    'must find web/public/app.js');
  assert.ok(paths.includes('test/fr-90-phase4.test.js'),
    'must find test paths');
  assert.ok(!paths.includes('file.js'),
    'must skip bare file.js (no slash, probably discussion)');
  assert.ok(!paths.some((p) => p.startsWith('http')),
    'must skip URLs');
});

t('behavior: _findPathOverlap detects shared paths between active entries', () => {
  delete require.cache[require.resolve('../server/src/artifacts')];
  const artifacts = require('../server/src/artifacts');
  const rec = {
    artifacts: { plan: { items: [
      { id: 'fr-1', text: 'modify server/src/attach.js and web/public/app.js', comments: [] },
      { id: 'fr-2', text: 'fix bug in server/src/attach.js', comments: [] },
      { id: 'fr-3', text: 'unrelated — touch docs/README.md', comments: [] },
    ]}},
    runQueue: [
      { itemId: 'fr-2', status: 'running' },
      { itemId: 'fr-3', status: 'pending' },
    ],
  };
  // fr-1's overlap with active fr-2 + fr-3.
  const overlaps = artifacts._findPathOverlap(rec, 'fr-1');
  assert.strictEqual(overlaps.length, 1, 'only fr-2 overlaps (fr-3 touches unrelated file)');
  assert.strictEqual(overlaps[0].itemId, 'fr-2');
  assert.deepStrictEqual(overlaps[0].paths, ['server/src/attach.js']);
});

t('behavior: _findPathOverlap returns empty when no paths in body', () => {
  delete require.cache[require.resolve('../server/src/artifacts')];
  const artifacts = require('../server/src/artifacts');
  const rec = {
    artifacts: { plan: { items: [
      { id: 'fr-1', text: 'analysis-only item, no file paths', comments: [] },
      { id: 'fr-2', text: 'touch server/src/attach.js', comments: [] },
    ]}},
    runQueue: [{ itemId: 'fr-2', status: 'running' }],
  };
  const overlaps = artifacts._findPathOverlap(rec, 'fr-1');
  assert.deepStrictEqual(overlaps, []);
});

t('behavior: _findPathOverlap skips self + terminal-status entries', () => {
  delete require.cache[require.resolve('../server/src/artifacts')];
  const artifacts = require('../server/src/artifacts');
  const rec = {
    artifacts: { plan: { items: [
      { id: 'fr-1', text: 'touch server/src/attach.js', comments: [] },
      { id: 'fr-2', text: 'also touch server/src/attach.js', comments: [] },
      { id: 'fr-3', text: 'old work on server/src/attach.js', comments: [] },
    ]}},
    runQueue: [
      { itemId: 'fr-1', status: 'pending' },   // self — must be skipped
      { itemId: 'fr-2', status: 'running' },   // active — counts
      { itemId: 'fr-3', status: 'success' },   // terminal — skipped
    ],
  };
  const overlaps = artifacts._findPathOverlap(rec, 'fr-1');
  assert.strictEqual(overlaps.length, 1, 'only fr-2 (active) counts; fr-1=self, fr-3=terminal');
  assert.strictEqual(overlaps[0].itemId, 'fr-2');
});

t('behavior: _findPathOverlap reads paths from comments too', () => {
  delete require.cache[require.resolve('../server/src/artifacts')];
  const artifacts = require('../server/src/artifacts');
  const rec = {
    artifacts: { plan: { items: [
      { id: 'fr-1', text: 'general feature work',
        comments: [{ user: 'k', text: 'oh actually we need to touch web/public/app.js' }] },
      { id: 'fr-2', text: 'fix bug in web/public/app.js', comments: [] },
    ]}},
    runQueue: [{ itemId: 'fr-2', status: 'pending' }],
  };
  const overlaps = artifacts._findPathOverlap(rec, 'fr-1');
  assert.strictEqual(overlaps.length, 1);
  assert.deepStrictEqual(overlaps[0].paths, ['web/public/app.js']);
});

t('behavior: _findPathOverlap gracefully returns [] when item missing', () => {
  delete require.cache[require.resolve('../server/src/artifacts')];
  const artifacts = require('../server/src/artifacts');
  assert.deepStrictEqual(artifacts._findPathOverlap({}, 'fr-1'), []);
  assert.deepStrictEqual(artifacts._findPathOverlap(null, 'fr-1'), []);
  assert.deepStrictEqual(
    artifacts._findPathOverlap({ artifacts: { plan: { items: [] } } }, 'fr-1'),
    []);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
