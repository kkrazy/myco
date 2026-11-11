// fr-93: auto-refresh the Plan-view Changed-files section while the
// Plan tab is visible. Polling-based (NOT fs.watch) by design — fs.
// watch is unreliable on macOS-Docker bind-mounts and recursive:true
// isn't universally supported on Linux container kernels.
//
// Static-shape guards on the contract:
//   • Start/stop helpers exist + are wired into showArtifactView('plan')
//     + hideArtifactView (Plan branch).
//   • Interval cadence is 5s (matches typical agent tool-call rhythm).
//   • document.hidden / visibilitychange wiring exists so a
//     backgrounded tab doesn't waste requests.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── fr-93: Plan Changed-files auto-refresh (polling) ──');

t('app.js: _startPlanChangedFilesAutoRefresh + _stopPlanChangedFilesAutoRefresh defined', () => {
  assert.ok(/function\s+_startPlanChangedFilesAutoRefresh\s*\(/.test(APP),
    'start helper must be defined');
  assert.ok(/function\s+_stopPlanChangedFilesAutoRefresh\s*\(/.test(APP),
    'stop helper must be defined');
});

t('app.js: poll cadence is 30s (PLAN_CHANGED_FILES_POLL_MS) — safety net behind fr-94 hooks', () => {
  // fr-94 added per-event hooks (tool_result + /git submit) for ~100ms
  // refresh latency, so polling is now the safety net for OUT-OF-BAND
  // changes (external editor, git pull at the shell, etc.). 30s gives
  // a reasonable backstop without flooding the server.
  assert.ok(/PLAN_CHANGED_FILES_POLL_MS\s*=\s*30000/.test(APP),
    'PLAN_CHANGED_FILES_POLL_MS must be 30000 ms (was 5000 pre-fr-94; bumped after instant hooks landed)');
});

t('app.js: poll loop skips when document.hidden + when Plan view inactive', () => {
  const idx = APP.search(/function\s+_startPlanChangedFilesAutoRefresh\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/document\.hidden/.test(win),
    'poll tick must short-circuit when document.hidden (backgrounded tab)');
  assert.ok(/state\.artifactView[\s\S]{0,80}plan/.test(win),
    'poll tick must verify Plan view is still active (race-safe)');
  assert.ok(/loadPlanChangedFiles\(\s*\{\s*force:\s*true/.test(win),
    'poll tick must call loadPlanChangedFiles({force:true}) to bypass the 2s cache');
});

t('app.js: stop handler is idempotent (no double-clear) + clears the handle', () => {
  const idx = APP.search(/function\s+_stopPlanChangedFilesAutoRefresh\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/if\s*\(\s*!_planChangedFilesPollHandle\s*\)\s*return/.test(win),
    'stop must early-return when handle is already null');
  assert.ok(/clearInterval/.test(win),
    'stop must clearInterval');
  assert.ok(/_planChangedFilesPollHandle\s*=\s*null/.test(win),
    'stop must null the handle so a subsequent start works');
});

t('app.js: showArtifactView("plan") starts polling; non-plan branch stops it', () => {
  const idx = APP.search(/function\s+showArtifactView\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/_startPlanChangedFilesAutoRefresh\(/.test(win),
    'showArtifactView must call _startPlanChangedFilesAutoRefresh on the plan branch');
  assert.ok(/_stopPlanChangedFilesAutoRefresh\(/.test(win),
    'showArtifactView must call _stopPlanChangedFilesAutoRefresh on the non-plan branch (tab switch)');
});

t('app.js: hideArtifactView stops polling when Plan view is closing', () => {
  const idx = APP.search(/function\s+hideArtifactView\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/_stopPlanChangedFilesAutoRefresh\(/.test(win),
    'hideArtifactView must stop the poller when type === "plan"');
});

t('app.js: visibilitychange listener triggers an immediate refresh on tab focus', () => {
  // Returning user shouldn't wait up to 5s for the next interval tick.
  assert.ok(/visibilitychange/.test(APP),
    'must register a visibilitychange listener');
  const idx = APP.search(/visibilitychange/);
  const win = APP.slice(idx, idx + 800);
  assert.ok(/document\.hidden/.test(win),
    'handler must check document.hidden');
  assert.ok(/loadPlanChangedFiles\(\s*\{\s*force:\s*true/.test(win),
    'handler must call loadPlanChangedFiles({force:true}) on return');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
