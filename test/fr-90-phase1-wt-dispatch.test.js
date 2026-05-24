// fr-90 Phase 1: serial dispatch via worktree.
//
// queueItemForRun now ALSO calls mycoMcp.createWorktree (graceful: skips
// silently if no git repo) and stores wt info on the queue entry as
// `entry.worktree = {path, branch, baseRef}`. buildArtifactRunText looks
// at rec.runQueue for the matching entry and embeds a [wt:<path>#<branch>]
// marker in the dispatch text when present. All 7 dispatch sites now
// pass `rec` so the marker is included. _appendUserAiChatTurn strips
// the [wt:...] prefix so it doesn't pollute the panel turn.
// CLAUDE.md instructs the agent to spawn a Task subagent in the wt.

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

const ARTIFACTS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');
const ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
const SLASHCMDS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');
const CLAUDE_MD = fs.readFileSync(
  path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');

console.log('── fr-90 Phase 1: serial WT dispatch ──');

// ──────────────────────────────────────────────────────────────────────
// Static guards: buildArtifactRunText + queueItemForRun + dispatch sites
// ──────────────────────────────────────────────────────────────────────

t('artifacts.js: buildArtifactRunText accepts a 4th `rec` arg', () => {
  assert.ok(/function\s+buildArtifactRunText\s*\(\s*type\s*,\s*item\s*,\s*user\s*,\s*rec\s*\)/.test(ARTIFACTS),
    'buildArtifactRunText signature must be (type, item, user, rec)');
});

t('artifacts.js: buildArtifactRunText embeds [wt:<path>#<branch>] when entry has worktree', () => {
  const idx = ARTIFACTS.search(/function\s+buildArtifactRunText\s*\(/);
  const win = ARTIFACTS.slice(idx, idx + 2500);
  assert.ok(/entry\.worktree/.test(win),
    'must read entry.worktree from rec.runQueue');
  assert.ok(/`\[wt:\$\{entry\.worktree\.path\}#\$\{entry\.worktree\.branch\}\]/.test(win),
    'must format the marker as [wt:<path>#<branch>]');
});

t('artifacts.js: queueItemForRun calls mycoMcp.createWorktree + stores on entry', () => {
  const idx = ARTIFACTS.search(/function\s+queueItemForRun\s*\(/);
  const win = ARTIFACTS.slice(idx, idx + 3500);
  assert.ok(/mycoMcp\.createWorktree/.test(win),
    'queueItemForRun must call mycoMcp.createWorktree');
  assert.ok(/entry\.worktree\s*=\s*\{/.test(win),
    'must store the worktree info on the queue entry');
});

t('artifacts.js: queueItemForRun gracefully skips when no git repo (try/catch)', () => {
  const idx = ARTIFACTS.search(/function\s+queueItemForRun\s*\(/);
  const win = ARTIFACTS.slice(idx, idx + 3500);
  assert.ok(/try\s*\{[\s\S]*?mycoMcp\.createWorktree[\s\S]*?\}\s*catch/.test(win),
    'createWorktree call must be in try/catch — failure should NOT block dispatch');
});

t('all 7 dispatch sites pass `rec` to buildArtifactRunText', () => {
  // Walk through each known call site and verify it passes a 4th
  // argument (either `rec` or `ctx.rec`).
  for (const src of [ARTIFACTS, ATTACH, SLASHCMDS]) {
    const calls = src.match(/buildArtifactRunText\s*\([^)]*\)/g) || [];
    for (const call of calls) {
      // Skip the function DEFINITION (4 params is fine — it's the
      // declaration). Defs include the word `function`.
      if (/function/.test(call)) continue;
      // Each invocation must have 4 args. The cheap check: comma count.
      const args = call.replace(/buildArtifactRunText\s*\(/, '').replace(/\)$/, '');
      const commaCount = (args.match(/,/g) || []).length;
      assert.ok(commaCount >= 3,
        `dispatch site missing the rec arg: ${call}`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────
// _appendUserAiChatTurn strips the [wt:...] marker
// ──────────────────────────────────────────────────────────────────────

t('attach.js: _appendUserAiChatTurn strips [wt:...] prefix too', () => {
  const idx = ATTACH.search(/function\s+_appendUserAiChatTurn\s*\(/);
  const win = ATTACH.slice(idx, idx + 1500);
  assert.ok(/\.replace\([^)]*wt:[^)]*\)/.test(win),
    '_appendUserAiChatTurn must strip the [wt:...] prefix added by fr-90');
});

// ──────────────────────────────────────────────────────────────────────
// CLAUDE.md instructs the agent
// ──────────────────────────────────────────────────────────────────────

t('CLAUDE.md instructs the agent to spawn a Task subagent on [wt:...] dispatches', () => {
  assert.ok(/\[wt:.*\]/.test(CLAUDE_MD),
    'CLAUDE.md must reference the [wt:...] marker');
  assert.ok(/Task[- ]tool subagent|Task subagent/i.test(CLAUDE_MD),
    'CLAUDE.md must instruct the agent to spawn a Task subagent for worktree work');
  assert.ok(/worktree/i.test(CLAUDE_MD),
    'CLAUDE.md must use the word "worktree" so the agent has the vocabulary');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation: end-to-end queueItemForRun + dispatch text
// ──────────────────────────────────────────────────────────────────────

function setupRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fr90p1-test-'));
  execFileSync('git', ['-C', tmp, 'init', '-q', '-b', 'main'], { stdio: 'pipe' });
  fs.writeFileSync(path.join(tmp, 'README.md'), '# test\n');
  execFileSync('git', ['-C', tmp, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', tmp, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', tmp, 'add', 'README.md']);
  execFileSync('git', ['-C', tmp, 'commit', '-q', '-m', 'init']);
  // Seed plan.json with one item.
  fs.mkdirSync(path.join(tmp, '_myco_'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '_myco_', 'plan.json'), JSON.stringify({
    items: [{
      id: 'fr-test', text: 'do the thing', layer: 'Feature', done: false,
      addedAt: '2026-05-24T00:00:00Z', addedBy: 'k', source: 'user',
      voters: [], comments: [],
    }],
    updatedAt: '2026-05-24T00:00:00Z',
  }, null, 2));
  return tmp;
}

t('behavior: queueItemForRun creates worktree + dispatch text carries [wt:] marker', () => {
  const tmpDir = setupRepo();
  const sessionsMod = require('../server/src/sessions');
  const origLoad = sessionsMod.loadStore;
  const origSave = sessionsMod.saveStore;
  const fakeRec = { absCwd: tmpDir, cwd: tmpDir, user: 'k', artifacts: {}, runQueue: [] };
  sessionsMod.loadStore = () => ({ sessions: { 'sid': fakeRec } });
  sessionsMod.saveStore = () => {};
  try {
    delete require.cache[require.resolve('../server/src/artifacts')];
    delete require.cache[require.resolve('../server/src/myco-mcp')];
    const a = require('../server/src/artifacts');

    // Queue fr-test.
    const r = a.queueItemForRun('sid', 'plan', 'fr-test', 'claude');
    assert.strictEqual(r.ok, true, 'queue should succeed');
    // The entry now has a worktree assignment.
    assert.ok(r.entry.worktree, 'entry must have worktree info attached');
    assert.strictEqual(r.entry.worktree.path, '_myco_/worktrees/fr-test');
    assert.strictEqual(r.entry.worktree.branch, 'wt-fr-test');
    assert.ok(r.entry.worktree.baseRef && /^[0-9a-f]{40}$/.test(r.entry.worktree.baseRef));

    // Real worktree exists on disk.
    assert.ok(fs.existsSync(path.join(tmpDir, '_myco_/worktrees/fr-test')),
      'worktree dir must exist on disk');

    // buildArtifactRunText embeds the [wt:...] marker.
    const item = fakeRec.artifacts.plan.items.find((x) => x.id === 'fr-test');
    const text = a.buildArtifactRunText('plan', item, 'k', fakeRec);
    assert.ok(text.includes('[wt:_myco_/worktrees/fr-test#wt-fr-test]'),
      'dispatch text must include the [wt:...] marker so the agent knows about the worktree');
    // The three markers should be in order: chat, run, wt.
    const chatIdx = text.indexOf('[chat:');
    const runIdx = text.indexOf('[run:');
    const wtIdx = text.indexOf('[wt:');
    assert.ok(chatIdx > -1 && chatIdx < runIdx && runIdx < wtIdx,
      'marker order: [chat:] → [run:] → [wt:]');
  } finally {
    sessionsMod.loadStore = origLoad;
    sessionsMod.saveStore = origSave;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/src/artifacts')];
    delete require.cache[require.resolve('../server/src/myco-mcp')];
  }
});

t('behavior: queueItemForRun in a NON-git dir succeeds without worktree (graceful)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr90p1-nogit-'));
  // Intentionally NO .git dir — findProjectRoot will return null,
  // so the file-mirror lookup won't find plan.json. Seed the items
  // directly on rec.artifacts.plan so findItem works without the file
  // mirror. This is exactly what happens in real non-git sessions.
  const sessionsMod = require('../server/src/sessions');
  const origLoad = sessionsMod.loadStore;
  const origSave = sessionsMod.saveStore;
  const fakeRec = {
    absCwd: tmpDir, cwd: tmpDir, user: 'k',
    artifacts: { plan: { items: [
      { id: 'fr-test', text: 't', layer: 'Feature', done: false,
        addedAt: '2026-05-24T00:00:00Z', addedBy: 'k', source: 'user',
        voters: [], comments: [] },
    ], updatedAt: '2026-05-24T00:00:00Z' } },
    runQueue: [],
  };
  sessionsMod.loadStore = () => ({ sessions: { 'sid': fakeRec } });
  sessionsMod.saveStore = () => {};
  try {
    delete require.cache[require.resolve('../server/src/artifacts')];
    delete require.cache[require.resolve('../server/src/myco-mcp')];
    const a = require('../server/src/artifacts');
    const r = a.queueItemForRun('sid', 'plan', 'fr-test', 'claude');
    // The queue add itself succeeds — graceful degradation.
    assert.strictEqual(r.ok, true, 'queue must succeed even without git');
    // No worktree attached.
    assert.ok(!r.entry.worktree, 'no worktree info when createWorktree fails');
    // Dispatch text has NO [wt:] marker.
    const text = a.buildArtifactRunText('plan', r.item, 'k', fakeRec);
    assert.ok(!text.includes('[wt:'),
      'no worktree → no [wt:] marker → legacy serial dispatch behavior');
    // But [chat:] + [run:] markers still present.
    assert.ok(text.includes('[chat:plan#fr-test]'));
    assert.ok(text.includes('[run:plan#fr-test]'));
  } finally {
    sessionsMod.loadStore = origLoad;
    sessionsMod.saveStore = origSave;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/src/artifacts')];
    delete require.cache[require.resolve('../server/src/myco-mcp')];
  }
});

t('behavior: [wt:] marker stripped by user-turn rendering', () => {
  // The strip pattern in _appendUserAiChatTurn (verified by static
  // guard above) — exercise the logic against marker permutations.
  const strip = (s) => String(s || '')
    .replace(/^\[chat:[^\]]+\]\s*/, '')
    .replace(/^\[run:[^\]]+\]\s*/, '')
    .replace(/^\[chat:[^\]]+\]\s*/, '')
    .replace(/^\[wt:[^\]]+\]\s*/, '')
    .trim();
  assert.strictEqual(
    strip('[chat:plan#fr-1] [run:plan#fr-1] [wt:_myco_/worktrees/fr-1#wt-fr-1] do the thing'),
    'do the thing');
  // Order resilience: chat first then run then wt is the canonical
  // emit order — the strip handles it correctly.
  assert.strictEqual(
    strip('[chat:plan#fr-1] [run:plan#fr-1] hello no wt'),
    'hello no wt',
    'no wt marker → no change to the rest');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
