// fr-94: instant Plan-view Changed-files refresh on file-mutating
// agent tool calls (Edit / Write / MultiEdit / Bash) + user-driven
// /git slash commands. Hooks ride existing channels — no fs.watch,
// no new server route. Falls through to fr-93's 30s polling for
// out-of-band changes (external editor, manual shell git).
//
// Static-shape guards on the contract.

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

console.log('── fr-94: Changed-files instant refresh hooks ──');

t('app.js: _maybeAutoRefreshOnAgentEvent + _maybeAutoRefreshOnGitCommand defined', () => {
  assert.ok(/function\s+_maybeAutoRefreshOnAgentEvent\s*\(/.test(APP),
    '_maybeAutoRefreshOnAgentEvent must be defined');
  assert.ok(/function\s+_maybeAutoRefreshOnGitCommand\s*\(/.test(APP),
    '_maybeAutoRefreshOnGitCommand must be defined');
});

t('app.js: tool-name registry covers Edit + Write + MultiEdit + Bash', () => {
  // _AUTO_REFRESH_TOOL_NAMES Set declared near the helpers.
  assert.ok(/_AUTO_REFRESH_TOOL_NAMES\s*=\s*new\s+Set\(\s*\[[^\]]*['"]Edit['"][^\]]*['"]Write['"][^\]]*['"]MultiEdit['"][^\]]*['"]Bash['"]/.test(APP),
    '_AUTO_REFRESH_TOOL_NAMES must include Edit, Write, MultiEdit, Bash');
});

t('app.js: agent-event hook only fires on tool_result (not tool_use)', () => {
  const idx = APP.search(/function\s+_maybeAutoRefreshOnAgentEvent\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/ev\.type\s*!==\s*['"]tool_result['"]/.test(win),
    'must short-circuit when ev.type !== "tool_result" (tool_use fires before the write completes)');
});

t('app.js: agent-event hook skips when Plan view not active', () => {
  const idx = APP.search(/function\s+_maybeAutoRefreshOnAgentEvent\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/state\.artifactView[\s\S]{0,80}plan/.test(win),
    'must skip refresh when state.artifactView.active !== "plan"');
});

t('app.js: agent-event hook debounces bursts (no fetch per MultiEdit tick)', () => {
  const idx = APP.search(/function\s+_maybeAutoRefreshOnAgentEvent\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/_autoRefreshDebounce/.test(win),
    'must use a debounce handle to coalesce bursts');
  assert.ok(/clearTimeout|setTimeout/.test(win),
    'must clear + re-arm a setTimeout for the debounce');
  assert.ok(/loadPlanChangedFiles\(\s*\{\s*force:\s*true/.test(win),
    'debounced callback must force-reload (bypass the 2s cache)');
});

t('app.js: _appendAgentEvent calls _maybeAutoRefreshOnAgentEvent on every event', () => {
  const idx = APP.search(/function\s+_appendAgentEvent\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/_maybeAutoRefreshOnAgentEvent\(\s*ev\s*\)/.test(win),
    '_appendAgentEvent must invoke _maybeAutoRefreshOnAgentEvent(ev) so file writes auto-refresh the list');
});

t('app.js: /git hook recognises /git + skips when Plan view not active', () => {
  const idx = APP.search(/function\s+_maybeAutoRefreshOnGitCommand\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/\/\^\\\/git\(\\s\|\$\)\/i/.test(win),
    'must match /^\\/git(\\s|$)/i (the exact /git command shape)');
  assert.ok(/state\.artifactView[\s\S]{0,80}plan/.test(win),
    'must skip refresh when Plan view is not active');
  assert.ok(/loadPlanChangedFiles\(\s*\{\s*force:\s*true/.test(win),
    'must call loadPlanChangedFiles({force:true}) after a delay');
});

t('app.js: submitChat invokes _maybeAutoRefreshOnGitCommand after a successful send', () => {
  const idx = APP.search(/function\s+submitChat\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/_maybeAutoRefreshOnGitCommand\(\s*submitted\s*\)/.test(win),
    'submitChat must call _maybeAutoRefreshOnGitCommand(submitted) so /git triggers a refresh');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
