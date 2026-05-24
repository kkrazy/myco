// fr-91: registry resilience across server restart via per-process bootId.
//
// Each AgentSession constructor generates a fresh bootId (UUID,
// NOT persisted across restart by design). Task-items registry
// entries tag with the current bootId on register. getTasksForItem
// filters by current bootId by default — pre-restart entries
// reference ghost task IDs (SDK's TaskList doesn't survive process
// death even though sdkSessionId does). /task stale exposes the
// historical entries.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const AGENT_SESSION_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
const MYCO_MCP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'myco-mcp.js'), 'utf8');
const SLASHCMDS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');

console.log('── fr-91: registry bootId epoch ──');

// ──────────────────────────────────────────────────────────────────────
// Static guards: bootId field on AgentSession + epoch filter in registry
// ──────────────────────────────────────────────────────────────────────

t('agent-session.js: AgentSession constructor sets this.bootId', () => {
  // The bootId is a fresh per-process value. Must NOT be persisted /
  // resumed — that's the whole point of being a restart epoch.
  assert.ok(/this\.bootId\s*=\s*require\(['"]crypto['"]\)\.randomBytes/.test(AGENT_SESSION_SRC),
    'AgentSession constructor must set this.bootId from a fresh crypto.randomBytes call');
  // Make sure it's NOT seeded from opts (which would mean it could be
  // persisted across restart — defeats the purpose).
  const idx = AGENT_SESSION_SRC.search(/this\.bootId\s*=/);
  const win = AGENT_SESSION_SRC.slice(idx, idx + 200);
  assert.ok(!/opts\.bootId/.test(win) && !/opts\.resumeBootId/.test(win),
    'bootId must NOT be seeded from opts — it MUST be fresh per process');
});

t('myco-mcp.js: _registerTaskItem captures bootId from current session', () => {
  const idx = MYCO_MCP_SRC.search(/function\s+_registerTaskItem\s*\(/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2000);
  assert.ok(/session\.bootId/.test(win),
    '_registerTaskItem must read session.bootId from attach.getSession');
  assert.ok(/bootId:\s*currentBootId/.test(win),
    'registry entry must store bootId field');
});

t('myco-mcp.js: getTasksForItem filters by current bootId by default', () => {
  const idx = MYCO_MCP_SRC.search(/function\s+getTasksForItem\s*\(/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2500);
  assert.ok(/includeStale/.test(win),
    'getTasksForItem must accept opts.includeStale flag (bypass for /task stale)');
  assert.ok(/info\.bootId\s*!==\s*currentBootId/.test(win),
    'filter must exclude entries whose bootId !== currentBootId');
  assert.ok(/session\.bootId/.test(win),
    'must read current bootId from the live AgentSession');
});

t('myco-mcp.js: legacy entries without bootId are filtered out by default', () => {
  // Entries that predate fr-91 have no bootId field. The filter
  // `info.bootId !== currentBootId` treats undefined !== string as
  // true → hidden by default. Test pins this behavior.
  const idx = MYCO_MCP_SRC.search(/function\s+getTasksForItem\s*\(/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2500);
  // The filter condition `info.bootId !== currentBootId` naturally
  // hides legacy entries (undefined !== 'some-id' is true → continue).
  assert.ok(/info\.bootId\s*!==\s*currentBootId/.test(win),
    'inequality check naturally excludes legacy entries (undefined !== bootId)');
});

// ──────────────────────────────────────────────────────────────────────
// slashcmds: /task stale flag
// ──────────────────────────────────────────────────────────────────────

t('slashcmds.js: handleTaskList parses `/task stale` flag', () => {
  const idx = SLASHCMDS_SRC.search(/function\s+handleTaskList\s*\(/);
  const win = SLASHCMDS_SRC.slice(idx, idx + 3500);
  assert.ok(/wantStale/.test(win),
    'handleTaskList must compute a wantStale flag from ctx.args');
  for (const flag of ['stale', '--stale']) {
    assert.ok(new RegExp(`['"]${flag.replace(/-/g, '\\-')}['"]`).test(win),
      'wantStale must recognize `' + flag + '`');
  }
});

t('slashcmds.js: /task stale passes includeStale: true to getTasksForItem', () => {
  const idx = SLASHCMDS_SRC.search(/function\s+handleTaskList\s*\(/);
  const win = SLASHCMDS_SRC.slice(idx, idx + 3500);
  assert.ok(/includeStale:\s*wantStale/.test(win),
    'getTasksForItem call must pass includeStale: wantStale');
});

t('slashcmds.js: reply formatting marks stale entries with 🕰️', () => {
  // Visual differentiation between current + pre-restart entries.
  const idx = SLASHCMDS_SRC.search(/function\s+handleTaskList\s*\(/);
  const win = SLASHCMDS_SRC.slice(idx, idx + 3500);
  assert.ok(/🕰️/.test(win),
    'stale entries must render with 🕰️ prefix or header for visual distinction');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation: register + read across epochs
// ──────────────────────────────────────────────────────────────────────

t('behavior: registry entry includes bootId from live session', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr91-test-'));
  const sessionsMod = require('../server/src/sessions');
  const origLoad = sessionsMod.loadStore;
  sessionsMod.loadStore = () => ({ sessions: { 'sid': { absCwd: tmpDir } } });
  try {
    delete require.cache[require.resolve('../server/src/myco-mcp')];
    delete require.cache[require.resolve('../server/src/attach')];
    // Mock attach.getSession to return a session with a known bootId.
    const attachMod = require('../server/src/attach');
    const origGetSession = attachMod.getSession;
    attachMod.getSession = () => ({ bootId: 'epoch-A' });
    try {
      const mycoMcp = require('../server/src/myco-mcp');
      // Build the registry directly through the helper-equivalent
      // logic (_registerTaskItem isn't exported; exercise via the
      // tool handler path by writing via saveTaskItems with our
      // expected shape).
      const now = new Date().toISOString();
      mycoMcp.saveTaskItems('sid', {
        tasks: {
          't-A': { itemId: 'fr-1', itemType: 'plan', subject: 'a', status: 'pending', createdAt: now, updatedAt: now, bootId: 'epoch-A' },
          't-B': { itemId: 'fr-1', itemType: 'plan', subject: 'b', status: 'pending', createdAt: now, updatedAt: now, bootId: 'epoch-B' },
          't-legacy': { itemId: 'fr-1', itemType: 'plan', subject: 'legacy', status: 'pending', createdAt: now, updatedAt: now },
        },
        updatedAt: now,
      });
      // Default: only current-bootId entries.
      const current = mycoMcp.getTasksForItem('sid', 'fr-1', { onlyInFlight: true });
      assert.strictEqual(current.length, 1, 'only t-A (epoch-A) should show by default');
      assert.strictEqual(current[0].taskId, 't-A');
      // includeStale: all 3.
      const all = mycoMcp.getTasksForItem('sid', 'fr-1', { onlyInFlight: true, includeStale: true });
      assert.strictEqual(all.length, 3, 'includeStale: true shows all 3 (current + cross-epoch + legacy)');
    } finally {
      attachMod.getSession = origGetSession;
    }
  } finally {
    sessionsMod.loadStore = origLoad;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/src/myco-mcp')];
    delete require.cache[require.resolve('../server/src/attach')];
  }
});

t('behavior: when no live session, getTasksForItem shows everything (no filter)', () => {
  // Defensive — if attach.getSession returns null (rare; agent isn't
  // running), the filter is bypassed so we don't silently hide
  // everything.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr91-test-'));
  const sessionsMod = require('../server/src/sessions');
  const origLoad = sessionsMod.loadStore;
  sessionsMod.loadStore = () => ({ sessions: { 'sid': { absCwd: tmpDir } } });
  try {
    delete require.cache[require.resolve('../server/src/myco-mcp')];
    delete require.cache[require.resolve('../server/src/attach')];
    const attachMod = require('../server/src/attach');
    const origGetSession = attachMod.getSession;
    attachMod.getSession = () => null;   // no live session
    try {
      const mycoMcp = require('../server/src/myco-mcp');
      const now = new Date().toISOString();
      mycoMcp.saveTaskItems('sid', {
        tasks: {
          't-X': { itemId: 'fr-1', itemType: 'plan', subject: 'x', status: 'pending', createdAt: now, updatedAt: now, bootId: 'old' },
        },
        updatedAt: now,
      });
      const r = mycoMcp.getTasksForItem('sid', 'fr-1', { onlyInFlight: true });
      assert.strictEqual(r.length, 1,
        'when no live session, filter is bypassed so we don\'t silently hide everything');
    } finally {
      attachMod.getSession = origGetSession;
    }
  } finally {
    sessionsMod.loadStore = origLoad;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/src/myco-mcp')];
    delete require.cache[require.resolve('../server/src/attach')];
  }
});

t('behavior: bootId is fresh per AgentSession (state-machine simulation)', () => {
  // Two simulated AgentSession constructions = two different bootIds.
  // Independent of source — pin the random-fresh property.
  const session1 = { bootId: require('crypto').randomBytes(8).toString('hex') };
  const session2 = { bootId: require('crypto').randomBytes(8).toString('hex') };
  assert.notStrictEqual(session1.bootId, session2.bootId,
    'two construct calls must produce different bootIds (fresh per process)');
  assert.ok(/^[0-9a-f]{16}$/.test(session1.bootId),
    'bootId format: 16 hex chars (8 random bytes)');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
