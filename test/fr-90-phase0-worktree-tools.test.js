// fr-90 Phase 0: worktree MCP tools + registry.
//
// Foundation for parallel item runs. Phase 0 ships ONLY the data-side
// helpers (loadWorktrees / saveWorktrees / listWorktrees /
// createWorktree / removeWorktree) + their MCP tool wrappers.
// Dispatch path is not touched yet (that's Phase 1). Test exercises:
//   - tool definitions + schemas
//   - registry persistence at <absCwd>/_myco_/worktrees.json
//   - real `git worktree add` + `git worktree remove` round-trip
//     against a temp git repo (no mock — git is a hard dep)
//   - _myco_/.gitignore gets the `worktrees/` entry on first create
//   - idempotency (re-create returns existing entry)

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

console.log('── fr-90 Phase 0: worktree tools + registry ──');

// ──────────────────────────────────────────────────────────────────────
// Static guards: MCP tool definitions
// ──────────────────────────────────────────────────────────────────────

t('myco-mcp.js declares worktree_create + worktree_remove + worktree_list', () => {
  for (const name of ['worktree_create', 'worktree_remove', 'worktree_list']) {
    assert.ok(new RegExp(`['"]${name}['"]`).test(MYCO_MCP_SRC),
      `myco-mcp must define tool "${name}"`);
  }
});

t('worktree_create schema requires itemId + optional branch', () => {
  const idx = MYCO_MCP_SRC.search(/['"]worktree_create['"]/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2500);
  assert.ok(/itemId:\s*z\.string/.test(win), 'itemId required');
  assert.ok(/branch:\s*z\.string[\s\S]{0,80}\.optional/.test(win), 'branch optional');
});

t('worktree_remove schema requires itemId + optional force', () => {
  const idx = MYCO_MCP_SRC.search(/['"]worktree_remove['"]/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2500);
  assert.ok(/itemId:\s*z\.string/.test(win));
  assert.ok(/force:\s*z\.boolean[\s\S]{0,80}\.optional/.test(win));
});

t('helpers loadWorktrees / saveWorktrees / listWorktrees / createWorktree / removeWorktree exported', () => {
  const exportsIdx = MYCO_MCP_SRC.search(/module\.exports\s*=\s*\{/);
  const win = MYCO_MCP_SRC.slice(exportsIdx, exportsIdx + 2500);
  for (const name of ['loadWorktrees', 'saveWorktrees', 'listWorktrees', 'createWorktree', 'removeWorktree']) {
    assert.ok(new RegExp('\\b' + name + '\\b').test(win),
      'module.exports must include ' + name);
  }
});

t('registry file path is <absCwd>/_myco_/worktrees.json', () => {
  // Pin so future refactors don't move the persistence target.
  assert.ok(/_myco_/.test(MYCO_MCP_SRC) && /worktrees\.json/.test(MYCO_MCP_SRC),
    'registry must persist at <absCwd>/_myco_/worktrees.json');
});

t('createWorktree branch defaults to wt-<itemId>', () => {
  const idx = MYCO_MCP_SRC.search(/function\s+createWorktree\s*\(/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 3000);
  assert.ok(/`wt-\$\{itemId\}`/.test(win),
    'default branch name must be wt-${itemId}');
});

t('createWorktree _myco_/.gitignore gets worktrees/ entry', () => {
  // Each worktree IS a checkout of the same repo — without ignore, the
  // worktree dir shows as untracked files in the main repo's status.
  assert.ok(/_ensureWorktreeGitignore/.test(MYCO_MCP_SRC),
    '_ensureWorktreeGitignore helper must exist');
  const idx = MYCO_MCP_SRC.search(/function\s+_ensureWorktreeGitignore\s*\(/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 1500);
  assert.ok(/worktrees\//.test(win),
    '_ensureWorktreeGitignore must append "worktrees/" to _myco_/.gitignore');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation: real git repo round-trip
// ──────────────────────────────────────────────────────────────────────

function setupTempGitRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fr90-test-'));
  execFileSync('git', ['-C', tmp, 'init', '-q', '-b', 'main'], { stdio: 'pipe' });
  // Need a real commit for `git worktree add` to have something to base on.
  fs.writeFileSync(path.join(tmp, 'README.md'), '# test repo\n');
  execFileSync('git', ['-C', tmp, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', tmp, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', tmp, 'add', 'README.md']);
  execFileSync('git', ['-C', tmp, 'commit', '-q', '-m', 'init']);
  return tmp;
}

t('behavior: createWorktree round-trip (real git, real registry, real .gitignore)', () => {
  const tmpDir = setupTempGitRepo();
  const sessionsMod = require('../server/src/sessions');
  const origLoad = sessionsMod.loadStore;
  const origSave = sessionsMod.saveStore;
  const fakeRec = { absCwd: tmpDir, cwd: tmpDir };
  sessionsMod.loadStore = () => ({ sessions: { 'sid': fakeRec } });
  sessionsMod.saveStore = () => {};
  try {
    delete require.cache[require.resolve('../server/src/myco-mcp')];
    const mycoMcp = require('../server/src/myco-mcp');

    // Empty registry initially.
    assert.deepStrictEqual(mycoMcp.loadWorktrees('sid'), { worktrees: {}, updatedAt: null });

    // Create worktree for fr-1.
    const r = mycoMcp.createWorktree('sid', 'fr-1');
    assert.strictEqual(r.ok, true, 'createWorktree should succeed: ' + JSON.stringify(r));
    assert.strictEqual(r.branch, 'wt-fr-1');
    assert.strictEqual(r.path, '_myco_/worktrees/fr-1');
    assert.strictEqual(r.status, 'active');
    assert.ok(r.baseRef && /^[0-9a-f]{40}$/.test(r.baseRef), 'baseRef should be a 40-char SHA');

    // Worktree directory exists on disk.
    const wtPath = path.join(tmpDir, '_myco_/worktrees/fr-1');
    assert.ok(fs.existsSync(wtPath), 'worktree dir must exist');
    assert.ok(fs.existsSync(path.join(wtPath, '.git')),
      'worktree dir must have a .git pointer file');
    assert.ok(fs.existsSync(path.join(wtPath, 'README.md')),
      'worktree dir must have the README.md from the main checkout');

    // git knows about it.
    const wtList = String(execFileSync('git', ['-C', tmpDir, 'worktree', 'list'], { encoding: 'utf8' }));
    assert.ok(wtList.includes('fr-1'), 'git worktree list must include the new worktree');
    assert.ok(wtList.includes('wt-fr-1') || wtList.includes('[wt-fr-1]'),
      'git worktree list must show the wt-fr-1 branch');

    // _myco_/.gitignore got the worktrees/ entry.
    const gi = fs.readFileSync(path.join(tmpDir, '_myco_', '.gitignore'), 'utf8');
    assert.ok(/worktrees\//.test(gi),
      '_myco_/.gitignore must contain worktrees/');

    // Registry has the entry.
    const reg = mycoMcp.loadWorktrees('sid');
    assert.ok(reg.worktrees['fr-1']);
    assert.strictEqual(reg.worktrees['fr-1'].branch, 'wt-fr-1');
    assert.strictEqual(reg.worktrees['fr-1'].status, 'active');

    // listWorktrees returns it.
    const entries = mycoMcp.listWorktrees('sid');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].itemId, 'fr-1');

    // Idempotent: second create returns existing.
    const r2 = mycoMcp.createWorktree('sid', 'fr-1');
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.idempotent, true);
    assert.strictEqual(r2.branch, 'wt-fr-1');

    // Remove worktree.
    const rm = mycoMcp.removeWorktree('sid', 'fr-1');
    assert.strictEqual(rm.ok, true, 'remove should succeed: ' + JSON.stringify(rm));
    assert.ok(!fs.existsSync(wtPath), 'worktree dir must be gone after remove');
    // Registry marks status removed.
    const reg2 = mycoMcp.loadWorktrees('sid');
    assert.strictEqual(reg2.worktrees['fr-1'].status, 'removed');
    assert.ok(reg2.worktrees['fr-1'].removedAt, 'removedAt timestamp set');
    // git branch wt-fr-1 STILL exists (work preserved).
    const branches = String(execFileSync('git', ['-C', tmpDir, 'branch', '--list', 'wt-fr-1'], { encoding: 'utf8' }));
    assert.ok(branches.includes('wt-fr-1'),
      'wt-fr-1 branch must still exist after worktree remove (work preserved)');
  } finally {
    sessionsMod.loadStore = origLoad;
    sessionsMod.saveStore = origSave;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/src/myco-mcp')];
  }
});

t('behavior: multiple parallel worktrees coexist (foundation for Phase 2 parallelism)', () => {
  // The whole point of Phase 0 — fr-1, fr-2, fr-3 can all have their
  // own worktrees simultaneously without colliding.
  const tmpDir = setupTempGitRepo();
  const sessionsMod = require('../server/src/sessions');
  const origLoad = sessionsMod.loadStore;
  const origSave = sessionsMod.saveStore;
  sessionsMod.loadStore = () => ({ sessions: { 'sid': { absCwd: tmpDir, cwd: tmpDir } } });
  sessionsMod.saveStore = () => {};
  try {
    delete require.cache[require.resolve('../server/src/myco-mcp')];
    const mycoMcp = require('../server/src/myco-mcp');
    for (const id of ['fr-1', 'fr-2', 'bug-17']) {
      const r = mycoMcp.createWorktree('sid', id);
      assert.strictEqual(r.ok, true, id + ' worktree should be created');
    }
    const list = mycoMcp.listWorktrees('sid');
    assert.strictEqual(list.length, 3, 'three worktrees should coexist');
    const ids = list.map((e) => e.itemId).sort();
    assert.deepStrictEqual(ids, ['bug-17', 'fr-1', 'fr-2']);
    // Each on its own branch.
    const branches = list.map((e) => e.branch).sort();
    assert.deepStrictEqual(branches, ['wt-bug-17', 'wt-fr-1', 'wt-fr-2']);
    // Each at its own path.
    for (const id of ['fr-1', 'fr-2', 'bug-17']) {
      assert.ok(fs.existsSync(path.join(tmpDir, '_myco_/worktrees', id)),
        id + ' worktree dir must exist');
    }
  } finally {
    sessionsMod.loadStore = origLoad;
    sessionsMod.saveStore = origSave;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/src/myco-mcp')];
  }
});

t('behavior: createWorktree rejects bad inputs', () => {
  delete require.cache[require.resolve('../server/src/myco-mcp')];
  const mycoMcp = require('../server/src/myco-mcp');
  const sessionsMod = require('../server/src/sessions');
  const orig = sessionsMod.loadStore;
  sessionsMod.loadStore = () => ({ sessions: {} });
  try {
    let r = mycoMcp.createWorktree('missing-sid', 'fr-1');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 404);
    assert.ok(/session not found/i.test(r.error));
  } finally {
    sessionsMod.loadStore = orig;
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
