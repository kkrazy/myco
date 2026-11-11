// Regression for the "stale in-memory vs fresh file" bug observed on
// mycobeta 2026-05-15:
//
//   - File `<project>/_myco_/plan.json` had 46 items (canonical state,
//     last persisted by an earlier server run).
//   - sessions.json's rec.artifacts.plan in memory had 9 items
//     (stale from a previous server lifetime).
//   - Plan tab loaded items from the file (GET reads file first) — so
//     the user saw 46.
//   - User clicked Refresh / Apply on a proposal — the mutation
//     endpoint operated on rec.artifacts.plan (the 9 stale items),
//     not the 46-item file the user was looking at. Result: ids
//     didn't exist, the merge silently no-op'd, the badge never
//     appeared.
//
// Fix: at the top of every plan-mutation endpoint, call
// `_loadArtifactIntoRecFromFile(rec, type)` so rec.artifacts[type]
// gets refreshed from disk BEFORE the mutation. The file is the
// version-controlled source of truth; the in-memory copy just shadows
// it.
//
// This test seeds the same shape — fresh file vs stale in-memory —
// and asserts the helper closes the gap.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-artifact-sync-'));
process.env.MYCO_STATE_DIR = path.join(tmp, 'state');
process.env.MYCO_WORKSPACE = path.join(tmp, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

const artifacts = require('../server/src/artifacts');
const { _loadArtifactIntoRecFromFile, readArtifactFromFile, findProjectRoot } = artifacts.__test;

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── artifact sync: fresh file overrides stale in-memory ──');

t('shape 1: absCwd IS the project root, stale memory + fresh file', () => {
  const proj = path.join(tmp, 'proj1');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.mkdirSync(path.join(proj, '_myco_'), { recursive: true });
  const onDisk = { items: Array.from({ length: 46 }, (_, i) => ({ id: 'td-' + (i + 1), layer: 'Todo', text: 'item ' + i, source: 'user' })) };
  fs.writeFileSync(path.join(proj, '_myco_', 'plan.json'), JSON.stringify(onDisk));
  const rec = {
    id: 'sess-shape1',
    absCwd: proj,
    artifacts: { plan: { items: [{ id: 'old-1', layer: 'Todo', text: 'stale', source: 'user' }] } },
  };
  assert.strictEqual(rec.artifacts.plan.items.length, 1, 'pre-sync: 1 stale item in memory');
  _loadArtifactIntoRecFromFile(rec, 'plan');
  assert.strictEqual(rec.artifacts.plan.items.length, 46, 'post-sync: rec.artifacts has the file content');
  assert.strictEqual(rec.artifacts.plan.items[0].id, 'td-1');
});

t('shape 2: absCwd is a WRAPPER, project is in a subdir with .git (bug-66: requires explicit rec.mainProject)', () => {
  // This is the exact mycobeta myco-ken shape.
  // bug-66: pre-bug-66 this case relied on findProjectRoot's
  // sibling-subdir auto-detect fallback to walk one level deep + claim
  // the .git/-marked subdir. That fallback is retired (it produced
  // non-deterministic resolution on multi-repo workspaces — same rec,
  // different reads, different paths). The wrapper layout now requires
  // an explicit rec.mainProject anchor, which spawnSession seeds for
  // new sessions and migrateMainProjectIfNeeded cures for legacy ones
  // on first attach. Setting rec.mainProject = 'myco' here mirrors
  // both production paths.
  const wrap = path.join(tmp, 'wrap2');
  fs.mkdirSync(wrap, { recursive: true });
  const proj = path.join(wrap, 'myco');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.mkdirSync(path.join(proj, '_myco_'), { recursive: true });
  fs.writeFileSync(path.join(proj, '_myco_', 'plan.json'),
    JSON.stringify({ items: [
      { id: 'td-1', layer: 'Todo', text: 'real-A', source: 'user' },
      { id: 'td-2', layer: 'Todo', text: 'real-B', source: 'user' },
    ] }));
  const rec = {
    id: 'sess-shape2',
    absCwd: wrap,
    mainProject: 'myco', // bug-66: explicit anchor (no auto-detect fallback)
    artifacts: { plan: { items: [{ id: 'phantom-1', layer: 'Todo', text: 'never-existed', source: 'user' }] } },
  };
  // findProjectRoot resolves via rec.mainProject (bug-66 canonical path).
  assert.strictEqual(findProjectRoot(rec), proj, 'findProjectRoot resolves <absCwd>/<mainProject>');
  _loadArtifactIntoRecFromFile(rec, 'plan');
  assert.strictEqual(rec.artifacts.plan.items.length, 2, 'rec.artifacts now mirrors the project plan.json');
  assert.deepStrictEqual(rec.artifacts.plan.items.map((it) => it.id), ['td-1', 'td-2']);
});

t('shape 3: no file present → rec.artifacts left alone (no clobber)', () => {
  const proj = path.join(tmp, 'proj3');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  // Intentionally NO _myco_/plan.json.
  const rec = {
    id: 'sess-shape3',
    absCwd: proj,
    artifacts: { plan: { items: [{ id: 'inmem-1', layer: 'Todo', text: 'memory-only', source: 'user' }] } },
  };
  _loadArtifactIntoRecFromFile(rec, 'plan');
  assert.strictEqual(rec.artifacts.plan.items.length, 1, 'no file → in-memory state untouched');
  assert.strictEqual(rec.artifacts.plan.items[0].id, 'inmem-1');
});

t('shape 4: file write matches what the merge endpoint would see', () => {
  // End-to-end style: write 3 items to file, stale rec.artifacts has 1,
  // sync, then verify the sync-loaded items contain a /merge-able pair.
  const proj = path.join(tmp, 'proj4');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.mkdirSync(path.join(proj, '_myco_'), { recursive: true });
  fs.writeFileSync(path.join(proj, '_myco_', 'plan.json'),
    JSON.stringify({ items: [
      { id: 'td-1', layer: 'Todo', text: 'dark mode',           source: 'user' },
      { id: 'td-2', layer: 'Todo', text: 'theme switcher',      source: 'user' },
      { id: 'td-3', layer: 'Todo', text: 'unrelated build fix', source: 'user' },
    ] }));
  const rec = {
    id: 'sess-shape4',
    absCwd: proj,
    artifacts: { plan: { items: [{ id: 'stale-x', layer: 'Todo', text: 'stale only', source: 'user' }] } },
  };
  _loadArtifactIntoRecFromFile(rec, 'plan');
  const slashcmds = require('../server/src/slashcmds');
  // Should not throw — td-1 and td-2 are both in the synced state.
  const result = slashcmds.mergePlanItems(rec, ['td-1', 'td-2']);
  assert.strictEqual(result.canonical.id, 'td-1');
  assert.deepStrictEqual(result.absorbed, ['td-2']);
  assert.strictEqual(rec.artifacts.plan.items.length, 2,
    'after merge, items array has td-1 (canonical) + td-3 (untouched)');
});

t('idempotent: re-syncing when memory and file already match is a no-op', () => {
  const proj = path.join(tmp, 'proj5');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.mkdirSync(path.join(proj, '_myco_'), { recursive: true });
  const items = [{ id: 'td-1', layer: 'Todo', text: 'same', source: 'user' }];
  fs.writeFileSync(path.join(proj, '_myco_', 'plan.json'), JSON.stringify({ items }));
  const rec = {
    id: 'sess-shape5',
    absCwd: proj,
    artifacts: { plan: { items: [...items] } },
  };
  const beforeMtime = fs.statSync(path.join(proj, '_myco_', 'plan.json')).mtimeMs;
  _loadArtifactIntoRecFromFile(rec, 'plan');
  _loadArtifactIntoRecFromFile(rec, 'plan');
  const afterMtime = fs.statSync(path.join(proj, '_myco_', 'plan.json')).mtimeMs;
  assert.strictEqual(beforeMtime, afterMtime,
    'sync helper must NOT re-write the file (caller persists at end of mutation)');
  assert.strictEqual(rec.artifacts.plan.items.length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
