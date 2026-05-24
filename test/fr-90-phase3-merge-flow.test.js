// fr-90 Phase 3: worktree merge flow + auto-merge orchestration + UI chip.
//
// New MCP tool worktree_merge + mergeWorktree helper (--ff-only by
// default; conflict on diverged main). attach.js _stampPlanItemRunOutcome
// reads the queue entry's worktree info; if item.meta.autoMerge === true
// AND status === 'success', attempts the merge; annotates the runs[]
// entry with worktree.mergeStatus. UI: plan card chip surfaces branch
// + state (branched / merged / conflicted / skipped) color-coded.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const MYCO_MCP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'myco-mcp.js'), 'utf8');
const ATTACH_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
const APP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const STYLES_CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── fr-90 Phase 3: merge flow + UI chip ──');

// ──────────────────────────────────────────────────────────────────────
// MCP tool + helper
// ──────────────────────────────────────────────────────────────────────

t('myco-mcp.js: worktree_merge tool declared with itemId + optional allowNonFastForward', () => {
  assert.ok(/['"]worktree_merge['"]/.test(MYCO_MCP_SRC), 'tool name present');
  const idx = MYCO_MCP_SRC.search(/['"]worktree_merge['"]/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2500);
  assert.ok(/itemId:\s*z\.string/.test(win), 'schema requires itemId');
  assert.ok(/allowNonFastForward:\s*z\.boolean[\s\S]{0,80}\.optional/.test(win),
    'schema accepts optional allowNonFastForward flag');
});

t('myco-mcp.js: mergeWorktree helper defined + exported', () => {
  assert.ok(/^function\s+mergeWorktree\s*\(/m.test(MYCO_MCP_SRC),
    'mergeWorktree must be at module scope');
  const exportsIdx = MYCO_MCP_SRC.search(/module\.exports\s*=\s*\{/);
  const win = MYCO_MCP_SRC.slice(exportsIdx, exportsIdx + 2500);
  assert.ok(/\bmergeWorktree\b/.test(win),
    'mergeWorktree must be in module.exports');
});

t('myco-mcp.js: mergeWorktree uses --ff-only by default, accepts allowNonFastForward', () => {
  const idx = MYCO_MCP_SRC.search(/function\s+mergeWorktree\s*\(/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 3000);
  assert.ok(/--ff-only/.test(win),
    '--ff-only must be the default merge strategy (safe — refuses diverged main)');
  assert.ok(/allowNonFastForward/.test(win),
    'must respect opts.allowNonFastForward to skip --ff-only');
});

t('myco-mcp.js: mergeWorktree classifies conflict vs other failures', () => {
  const idx = MYCO_MCP_SRC.search(/function\s+mergeWorktree\s*\(/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 3500);
  assert.ok(/conflict/i.test(win),
    'conflict classification required so caller can distinguish "diverged main" from "tool failure"');
  assert.ok(/not possible to fast-forward|CONFLICT/.test(win),
    'must pattern-match git\'s conflict stderr to classify');
});

t('myco-mcp.js: mergeWorktree refuses to merge into wt-<itemId> itself', () => {
  // Defensive: if the user happens to be on the wt branch (rare),
  // git would silently no-op the merge. We surface this as a 409.
  const idx = MYCO_MCP_SRC.search(/function\s+mergeWorktree\s*\(/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 3500);
  assert.ok(/mainBranch\s*===\s*entry\.branch/.test(win),
    'must detect when checked-out branch IS the wt branch + refuse');
});

// ──────────────────────────────────────────────────────────────────────
// Auto-merge orchestration in attach.js
// ──────────────────────────────────────────────────────────────────────

t('attach.js: _stampPlanItemRunOutcome captures worktree info from queue entry', () => {
  const idx = ATTACH_SRC.search(/function\s+_stampPlanItemRunOutcome\s*\(/);
  const win = ATTACH_SRC.slice(idx, idx + 4000);
  assert.ok(/queueEntry/.test(win),
    'must look up the matching queue entry by itemId');
  assert.ok(/queueEntry\.worktree/.test(win),
    'must read queueEntry.worktree.branch (set by Phase 1)');
  assert.ok(/outcome\.worktree\s*=/.test(win),
    'must annotate the outcome with worktree info');
});

t('attach.js: auto-merge fires when item.meta.autoMerge === true + status success', () => {
  const idx = ATTACH_SRC.search(/function\s+_stampPlanItemRunOutcome\s*\(/);
  const win = ATTACH_SRC.slice(idx, idx + 4000);
  assert.ok(/item\.meta\s*&&\s*item\.meta\.autoMerge\s*===\s*true/.test(win),
    'auto-merge gate: item.meta.autoMerge === true (explicit opt-in only)');
  assert.ok(/mycoMcp\.mergeWorktree/.test(win),
    'must call mycoMcp.mergeWorktree when gate passes');
  assert.ok(/status\s*===\s*['"]success['"]/.test(win),
    'must gate on run status === "success" (don\'t merge a failed run)');
});

t('attach.js: outcome.worktree.mergeStatus enumerated correctly', () => {
  const idx = ATTACH_SRC.search(/function\s+_stampPlanItemRunOutcome\s*\(/);
  const win = ATTACH_SRC.slice(idx, idx + 4000);
  // Four possible states per the design.
  for (const state of ['branched', 'merged', 'conflicted', 'skipped']) {
    assert.ok(new RegExp(`['"]${state}['"]`).test(win),
      'mergeStatus must include "' + state + '"');
  }
});

t('attach.js: auto-merge failures are graceful (try/catch, log, branched fallback)', () => {
  const idx = ATTACH_SRC.search(/function\s+_stampPlanItemRunOutcome\s*\(/);
  const win = ATTACH_SRC.slice(idx, idx + 4000);
  // mergeWorktree must be reached inside a try block, and the
  // catch handler must log + leave mergeStatus as 'branched'
  // (graceful fallback). Loosened from a single regex to three
  // independent assertions so the window between try{ and the catch
  // can grow without busting the test.
  assert.ok(/try\s*\{[\s\S]*?mergeWorktree[\s\S]*?\}\s*catch/.test(win),
    'mergeWorktree call must be inside a try/catch — failure must not break run-stamping');
  // catch handler must set mergeStatus + log via console.warn so the
  // operator can debug.
  assert.ok(/catch\s*\([\s\S]{0,30}\)\s*\{[\s\S]{0,300}mergeStatus\s*=\s*['"]branched['"]/.test(win),
    'catch handler must fall back to mergeStatus="branched" (safe default)');
  assert.ok(/catch\s*\([\s\S]{0,30}\)\s*\{[\s\S]{0,300}console\.warn/.test(win),
    'catch handler must log via console.warn for debuggability');
});

// ──────────────────────────────────────────────────────────────────────
// UI chip
// ──────────────────────────────────────────────────────────────────────

t('app.js: wtChip template emits .artifact-item-wt span with branch name', () => {
  assert.ok(/artifact-item-wt/.test(APP_SRC),
    '.artifact-item-wt class must be rendered');
  // Reads from lastRun.worktree (which fr-90 Phase 3 added to the
  // run-outcome stamping).
  assert.ok(/lastRun\.worktree/.test(APP_SRC),
    'wtChip must read from lastRun.worktree (server-side fr-90 Phase 3 annotation)');
});

t('app.js: wtChip distinguishes 4 mergeStatus states via icon', () => {
  // Pin the 4 icons match the design.
  for (const [state, icon] of [['branched', '🔀'], ['merged', '✅'], ['conflicted', '⚠️'], ['skipped', '⏭️']]) {
    // Each state should map to its icon somewhere in the chip code.
    assert.ok(APP_SRC.includes(`${state}:`) || APP_SRC.includes(`'${state}'`),
      'mergeStatus "' + state + '" must be referenced');
    assert.ok(APP_SRC.includes(icon),
      'mergeStatus "' + state + '" icon ' + icon + ' must be present');
  }
});

t('app.js: actionsRow renders ${wtChip}', () => {
  // The chip must actually be in the plan-card actions row, not just
  // defined.
  const idx = APP_SRC.search(/const\s+actionsRow\s*=\s*`<div class="artifact-item-actions">/);
  const end = APP_SRC.indexOf('</div>`;', idx);
  const win = APP_SRC.slice(idx, end);
  assert.ok(/\$\{wtChip\}/.test(win),
    'actionsRow template must include ${wtChip}');
});

t('styles.css: .artifact-item-wt + 4 state variants styled', () => {
  assert.ok(/\.artifact-item-wt\b/.test(STYLES_CSS),
    '.artifact-item-wt selector must exist');
  for (const state of ['branched', 'merged', 'conflicted', 'skipped']) {
    assert.ok(new RegExp('\\.artifact-item-wt\\.wt-' + state).test(STYLES_CSS),
      '.artifact-item-wt.wt-' + state + ' variant must be styled');
  }
});

t('styles.css: mobile hides the branch text (icon-only on phones)', () => {
  // Matches the pattern of other action-row chips — keep mobile
  // density tight.
  assert.ok(/@media\s*\(\s*max-width:\s*900px\s*\)[\s\S]{0,500}\.artifact-item-wt[\s\S]{0,200}\.btn-text[\s\S]{0,50}display:\s*none/.test(STYLES_CSS),
    'mobile @media block must hide .artifact-item-wt .btn-text');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation: real git merge round-trip
// ──────────────────────────────────────────────────────────────────────

function setupRepoWithWtCommit() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fr90p3-test-'));
  execFileSync('git', ['-C', tmp, 'init', '-q', '-b', 'main'], { stdio: 'pipe' });
  fs.writeFileSync(path.join(tmp, 'README.md'), '# test\n');
  execFileSync('git', ['-C', tmp, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', tmp, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', tmp, 'add', 'README.md']);
  execFileSync('git', ['-C', tmp, 'commit', '-q', '-m', 'init']);
  return tmp;
}

t('behavior: mergeWorktree --ff-only succeeds after subagent commits to wt branch', () => {
  const tmpDir = setupRepoWithWtCommit();
  const sessionsMod = require('../server/src/sessions');
  const origLoad = sessionsMod.loadStore;
  const origSave = sessionsMod.saveStore;
  const fakeRec = { absCwd: tmpDir, cwd: tmpDir };
  sessionsMod.loadStore = () => ({ sessions: { 'sid': fakeRec } });
  sessionsMod.saveStore = () => {};
  try {
    delete require.cache[require.resolve('../server/src/myco-mcp')];
    const mycoMcp = require('../server/src/myco-mcp');
    // Create worktree for fr-1.
    const wt = mycoMcp.createWorktree('sid', 'fr-1');
    assert.strictEqual(wt.ok, true);
    // Simulate subagent committing a new file in the worktree.
    const wtAbsPath = path.join(tmpDir, wt.path);
    fs.writeFileSync(path.join(wtAbsPath, 'new-file.txt'), 'subagent work\n');
    execFileSync('git', ['-C', wtAbsPath, 'config', 'user.email', 'subagent@example.com']);
    execFileSync('git', ['-C', wtAbsPath, 'config', 'user.name', 'subagent']);
    execFileSync('git', ['-C', wtAbsPath, 'add', 'new-file.txt']);
    execFileSync('git', ['-C', wtAbsPath, 'commit', '-q', '-m', 'subagent change']);
    // Now merge back to main.
    const m = mycoMcp.mergeWorktree('sid', 'fr-1');
    assert.strictEqual(m.ok, true, 'ff-only merge should succeed: ' + JSON.stringify(m));
    assert.strictEqual(m.merged, true);
    // Verify the file is now on main.
    assert.ok(fs.existsSync(path.join(tmpDir, 'new-file.txt')),
      'subagent\'s file must be on main after merge');
    // Registry status updated to merged.
    const reg = mycoMcp.loadWorktrees('sid');
    assert.strictEqual(reg.worktrees['fr-1'].status, 'merged');
    assert.ok(reg.worktrees['fr-1'].mergedAt, 'mergedAt timestamp set');
  } finally {
    sessionsMod.loadStore = origLoad;
    sessionsMod.saveStore = origSave;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/src/myco-mcp')];
  }
});

t('behavior: mergeWorktree --ff-only conflicts when main has diverged', () => {
  const tmpDir = setupRepoWithWtCommit();
  const sessionsMod = require('../server/src/sessions');
  const origLoad = sessionsMod.loadStore;
  const origSave = sessionsMod.saveStore;
  sessionsMod.loadStore = () => ({ sessions: { 'sid': { absCwd: tmpDir, cwd: tmpDir } } });
  sessionsMod.saveStore = () => {};
  try {
    delete require.cache[require.resolve('../server/src/myco-mcp')];
    const mycoMcp = require('../server/src/myco-mcp');
    // Create wt for fr-1.
    const wt = mycoMcp.createWorktree('sid', 'fr-1');
    assert.strictEqual(wt.ok, true);
    // Subagent commits to wt.
    const wtAbsPath = path.join(tmpDir, wt.path);
    fs.writeFileSync(path.join(wtAbsPath, 'wt-file.txt'), 'wt work\n');
    execFileSync('git', ['-C', wtAbsPath, 'config', 'user.email', 'subagent@example.com']);
    execFileSync('git', ['-C', wtAbsPath, 'config', 'user.name', 'subagent']);
    execFileSync('git', ['-C', wtAbsPath, 'add', 'wt-file.txt']);
    execFileSync('git', ['-C', wtAbsPath, 'commit', '-q', '-m', 'wt commit']);
    // Main also gets an independent commit (divergence).
    fs.writeFileSync(path.join(tmpDir, 'main-file.txt'), 'main work\n');
    execFileSync('git', ['-C', tmpDir, 'add', 'main-file.txt']);
    execFileSync('git', ['-C', tmpDir, 'commit', '-q', '-m', 'main commit']);
    // ff-only merge should now FAIL with conflict classification.
    const m = mycoMcp.mergeWorktree('sid', 'fr-1');
    assert.strictEqual(m.ok, false, 'ff-only must fail on diverged main');
    assert.strictEqual(m.conflict, true,
      'conflict must be true (not generic failure) so caller knows it\'s recoverable');
    assert.strictEqual(m.status, 409);
    // Registry NOT marked merged (still active).
    const reg = mycoMcp.loadWorktrees('sid');
    assert.strictEqual(reg.worktrees['fr-1'].status, 'active',
      'failed merge must NOT mark registry as merged');
  } finally {
    sessionsMod.loadStore = origLoad;
    sessionsMod.saveStore = origSave;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/src/myco-mcp')];
  }
});

t('behavior: mergeWorktree rejects when registry has no entry', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr90p3-noreg-'));
  const sessionsMod = require('../server/src/sessions');
  const origLoad = sessionsMod.loadStore;
  const origSave = sessionsMod.saveStore;
  sessionsMod.loadStore = () => ({ sessions: { 'sid': { absCwd: tmpDir, cwd: tmpDir } } });
  sessionsMod.saveStore = () => {};
  try {
    delete require.cache[require.resolve('../server/src/myco-mcp')];
    const mycoMcp = require('../server/src/myco-mcp');
    const m = mycoMcp.mergeWorktree('sid', 'fr-never-created');
    assert.strictEqual(m.ok, false);
    assert.strictEqual(m.status, 404);
    assert.ok(/no worktree registered/i.test(m.error));
  } finally {
    sessionsMod.loadStore = origLoad;
    sessionsMod.saveStore = origSave;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/src/myco-mcp')];
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
