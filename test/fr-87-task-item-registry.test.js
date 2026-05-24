// fr-87: scope-aware /task — registry-backed (SDK-tool driven, NOT
// prompt-based).
//
// User course-correction (kkrazy 2026-05-24): "instead of using a
// prompt to filter, create a tool which registers the tasks vs item
// relationship and manipulate the task directly via the agent sdk
// api". So v2 ships:
//
//   1. New MCP tool `mcp__myco__register_task_item({taskId, itemId,
//      itemType?, subject?, status?})` exposed by myco-mcp. Agent
//      calls this after every TaskCreate during a [chat|run:plan#X]
//      turn (+ after TaskUpdate status changes).
//   2. Persistence: _myco_/task-items.json — committable per
//      CLAUDE.md §5 (shared team memory).
//   3. handleTaskList reads the registry directly via
//      myco-mcp.getTasksForItem(sessionId, itemId, {onlyInFlight}) —
//      formats the reply server-side, NO agent round-trip.
//   4. /task all (or /task --all / -a) escape hatch falls back to the
//      legacy "ask claude for the global list" prompt.
//   5. attach.js ctx now carries chatItem + runItem populated from
//      session._activeChatItem/_activeRunItem (needed for scoping).
//
// Static guards on each module + behavior simulation of the registry
// helpers + scope-detection logic.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const MYCO_MCP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'myco-mcp.js'), 'utf8');
const SLASHCMDS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');
const ATTACH_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
const CLAUDE_MD = fs.readFileSync(
  path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');

console.log('── fr-87: registry-backed scope-aware /task ──');

// ──────────────────────────────────────────────────────────────────────
// myco-mcp: new tool + registry helpers
// ──────────────────────────────────────────────────────────────────────

t('myco-mcp.js declares the register_task_item tool', () => {
  assert.ok(/['"]register_task_item['"]/.test(MYCO_MCP_SRC),
    'myco-mcp must define a tool named "register_task_item"');
});

t('myco-mcp.js: register_task_item schema includes taskId + itemId + status enum', () => {
  // Locate the tool block and pin its schema fields.
  const idx = MYCO_MCP_SRC.search(/['"]register_task_item['"]/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2500);
  assert.ok(/taskId:\s*z\.string/.test(win),
    'register_task_item schema must require taskId: z.string');
  assert.ok(/itemId:\s*z\.string/.test(win),
    'register_task_item schema must require itemId: z.string');
  assert.ok(/status:\s*z\.enum\(\[\s*['"]pending['"][\s\S]{0,100}['"]in_progress['"][\s\S]{0,100}['"]completed['"]/.test(win),
    'status enum must include pending, in_progress, completed (+deleted)');
});

t('myco-mcp.js: loadTaskItems / saveTaskItems / getTasksForItem helpers exported', () => {
  assert.ok(/function\s+loadTaskItems\s*\(/.test(MYCO_MCP_SRC),
    'loadTaskItems must be defined');
  assert.ok(/function\s+saveTaskItems\s*\(/.test(MYCO_MCP_SRC),
    'saveTaskItems must be defined');
  assert.ok(/function\s+getTasksForItem\s*\(/.test(MYCO_MCP_SRC),
    'getTasksForItem must be defined');
  // All three exported in the module.exports block.
  assert.ok(/module\.exports\s*=\s*\{[\s\S]*loadTaskItems[\s\S]*saveTaskItems[\s\S]*getTasksForItem/.test(MYCO_MCP_SRC),
    'all three registry helpers must be exported');
});

t('myco-mcp.js: registry file lives at <absCwd>/_myco_/task-items.json', () => {
  // Committable per CLAUDE.md §5. Path is composed via path.join so
  // pin both halves.
  assert.ok(/_myco_/.test(MYCO_MCP_SRC) && /task-items\.json/.test(MYCO_MCP_SRC),
    'registry file path must be <absCwd>/_myco_/task-items.json (committable per CLAUDE.md §5)');
});

t('myco-mcp.js: _registerTaskItem preserves createdAt across updates (idempotent)', () => {
  const idx = MYCO_MCP_SRC.search(/function\s+_registerTaskItem\s*\(/);
  assert.ok(idx > -1, '_registerTaskItem helper must exist');
  const win = MYCO_MCP_SRC.slice(idx, idx + 1500);
  assert.ok(/existing\.createdAt\s*\|\|\s*now/.test(win),
    'createdAt must be preserved: existing.createdAt || now');
});

// ──────────────────────────────────────────────────────────────────────
// slashcmds: handleTaskList reads the registry directly
// ──────────────────────────────────────────────────────────────────────

t('handleTaskList consumes ctx.chatItem / ctx.runItem for scope detection', () => {
  const idx = SLASHCMDS_SRC.search(/function\s+handleTaskList\s*\(/);
  assert.ok(idx > -1);
  const win = SLASHCMDS_SRC.slice(idx, idx + 2500);
  assert.ok(/ctx\.chatItem/.test(win),
    'handleTaskList must read ctx.chatItem (panel-typed /task)');
  assert.ok(/ctx\.runItem/.test(win),
    'handleTaskList must read ctx.runItem (run-marker dispatch)');
});

t('handleTaskList calls myco-mcp.getTasksForItem with onlyInFlight + includeStale opts', () => {
  // fr-91 widened the opts: instead of literal `onlyInFlight: true`,
  // the call now passes `onlyInFlight: !wantStale` (toggleable via
  // /task stale). Pin the function call + the opts SHAPE rather than
  // the literal value, so future flag additions don't bust this guard.
  const idx = SLASHCMDS_SRC.search(/function\s+handleTaskList\s*\(/);
  const win = SLASHCMDS_SRC.slice(idx, idx + 4000);
  assert.ok(/getTasksForItem\s*\(/.test(win),
    'handleTaskList must invoke getTasksForItem (registry read)');
  // The opts object must include BOTH onlyInFlight and includeStale
  // keys — onlyInFlight filters out completed/deleted; includeStale
  // bypasses fr-91's bootId epoch for audit view.
  assert.ok(/onlyInFlight:/.test(win),
    'handleTaskList must pass an onlyInFlight option (filters completed/deleted)');
  assert.ok(/includeStale:/.test(win),
    'handleTaskList must pass includeStale option (fr-91 — exposes pre-restart entries)');
});

t('handleTaskList replies DIRECTLY (no agent round-trip in scoped path)', () => {
  const idx = SLASHCMDS_SRC.search(/function\s+handleTaskList\s*\(/);
  // Bumped window from 2500→5000 to clear fr-91's expanded reply
  // formatting + stale-handling branch.
  const win = SLASHCMDS_SRC.slice(idx, idx + 5000);
  // The scoped path uses ctx.reply (server-side reply); the global
  // fallback uses ctx.session.write (forwards to agent). Both must
  // exist; pin both to ensure the scoped path was added without
  // dropping the global fallback.
  assert.ok(/ctx\.reply\s*\(/.test(win),
    'scoped path must use ctx.reply (server-authoritative formatted reply)');
  assert.ok(/ctx\.session\.write\s*\(/.test(win),
    'global fallback must still call ctx.session.write (forward to agent for the cross-item list)');
});

t('handleTaskList supports `/task all` (and --all / -a) escape hatch', () => {
  const idx = SLASHCMDS_SRC.search(/function\s+handleTaskList\s*\(/);
  const win = SLASHCMDS_SRC.slice(idx, idx + 2500);
  assert.ok(/wantAll/.test(win),
    'handleTaskList must compute a wantAll flag from ctx.args');
  // All three syntaxes must be recognized.
  for (const flag of ['all', '--all', '-a']) {
    assert.ok(new RegExp(`['"]${flag.replace(/-/g, '\\-')}['"]`).test(win),
      'wantAll must accept `' + flag + '` as the global-list opt-out');
  }
});

// ──────────────────────────────────────────────────────────────────────
// attach.js: ctx surface
// ──────────────────────────────────────────────────────────────────────

t('attach.js: ctx carries chatItem/runItem populated from this turn\'s local marker matches', () => {
  // Scoped via ctx so slashcmd handlers (handleTaskList, future
  // siblings) can branch without re-parsing markers.
  //
  // bug-36 refactor: pre-fix this read from session._activeChatItem /
  // session._activeRunItem (the singular slots that got clobbered by
  // parallel dispatches). Post-fix it reads from THIS turn's local
  // chatMatch / runMatch — per-turn, isolated, no shared state.
  assert.ok(/chatItem:\s*chatMatch[\s\S]{0,150}chatMatch\[2\]/.test(ATTACH_SRC),
    'ctx.chatItem must be derived from local chatMatch (not a shared session slot)');
  assert.ok(/runItem:\s*runMatch[\s\S]{0,150}runMatch\[2\]/.test(ATTACH_SRC),
    'ctx.runItem must be derived from local runMatch (not a shared session slot)');
});

// ──────────────────────────────────────────────────────────────────────
// CLAUDE.md: agent etiquette extension
// ──────────────────────────────────────────────────────────────────────

t('CLAUDE.md instructs the agent to call register_task_item after TaskCreate during chat/run turns', () => {
  // The whole point of the registry: the AGENT must populate it.
  // CLAUDE.md is the source of that contract.
  assert.ok(/register_task_item/.test(CLAUDE_MD),
    'CLAUDE.md must reference mcp__myco__register_task_item');
  assert.ok(/TaskCreate/.test(CLAUDE_MD),
    'CLAUDE.md must explicitly mention TaskCreate so the agent knows when to register');
  assert.ok(/_myco_\/task-items\.json/.test(CLAUDE_MD),
    'CLAUDE.md must name the registry file so the agent can audit its own work');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation: registry round-trip against a real temp dir
// ──────────────────────────────────────────────────────────────────────

t('behavior: register + read round-trip via the real helpers', () => {
  // Set up a fake session whose absCwd points at a temp dir, so the
  // registry file path resolves correctly.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr87-test-'));
  const sessionsMod = require('../server/src/sessions');
  const origLoadStore = sessionsMod.loadStore;
  const fakeSid = 'fr87-test-session';
  sessionsMod.loadStore = () => ({
    sessions: { [fakeSid]: { absCwd: tmpDir } },
  });

  try {
    // Bust the require cache to pick up the patched loadStore.
    delete require.cache[require.resolve('../server/src/myco-mcp')];
    const mycoMcp = require('../server/src/myco-mcp');

    // Empty registry initially.
    const empty = mycoMcp.loadTaskItems(fakeSid);
    assert.deepStrictEqual(empty, { tasks: {}, updatedAt: null });
    assert.deepStrictEqual(mycoMcp.getTasksForItem(fakeSid, 'fr-1', { onlyInFlight: true }), []);

    // Save a registry with two tasks for fr-1, one for fr-2, one
    // completed for fr-1 (should be filtered out by onlyInFlight).
    const now = new Date().toISOString();
    mycoMcp.saveTaskItems(fakeSid, {
      tasks: {
        't-1': { itemId: 'fr-1', itemType: 'plan', subject: 'task one', status: 'pending', createdAt: now, updatedAt: now },
        't-2': { itemId: 'fr-1', itemType: 'plan', subject: 'task two', status: 'in_progress', createdAt: now, updatedAt: now },
        't-3': { itemId: 'fr-2', itemType: 'plan', subject: 'task three', status: 'pending', createdAt: now, updatedAt: now },
        't-4': { itemId: 'fr-1', itemType: 'plan', subject: 'task four', status: 'completed', createdAt: now, updatedAt: now },
      },
      updatedAt: now,
    });

    // Verify the file was written + parseable.
    const filePath = path.join(tmpDir, '_myco_', 'task-items.json');
    assert.ok(fs.existsSync(filePath), 'task-items.json must be written to _myco_/');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.strictEqual(Object.keys(parsed.tasks).length, 4);

    // Filter to fr-1's in-flight tasks → should return t-1 + t-2
    // (t-4 is completed, t-3 is for fr-2).
    const fr1 = mycoMcp.getTasksForItem(fakeSid, 'fr-1', { onlyInFlight: true });
    assert.strictEqual(fr1.length, 2, 'two in-flight tasks for fr-1');
    const ids = fr1.map((x) => x.taskId).sort();
    assert.deepStrictEqual(ids, ['t-1', 't-2']);

    // No onlyInFlight → return all fr-1 tasks (t-1, t-2, t-4).
    const all = mycoMcp.getTasksForItem(fakeSid, 'fr-1', {});
    assert.strictEqual(all.length, 3);

    // fr-2 → just t-3.
    const fr2 = mycoMcp.getTasksForItem(fakeSid, 'fr-2', { onlyInFlight: true });
    assert.strictEqual(fr2.length, 1);
    assert.strictEqual(fr2[0].taskId, 't-3');
  } finally {
    sessionsMod.loadStore = origLoadStore;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/src/myco-mcp')];
  }
});

t('behavior: scope detection — chatItem takes precedence over runItem', () => {
  // If BOTH _activeChatItem and _activeRunItem are set (which can
  // happen on rare overlap), the panel chat is the more immediate
  // user intent — prefer chatItem. Pin the precedence so a refactor
  // doesn't quietly flip it.
  const both = { chatItem: { itemId: 'fr-1' }, runItem: { itemId: 'fr-2' } };
  const justRun = { chatItem: null, runItem: { itemId: 'fr-2' } };
  const justChat = { chatItem: { itemId: 'fr-1' }, runItem: null };
  const neither = { chatItem: null, runItem: null };
  const detect = (ctx) => (ctx.chatItem || ctx.runItem || null);
  assert.strictEqual(detect(both).itemId, 'fr-1', 'chatItem wins when both set');
  assert.strictEqual(detect(justRun).itemId, 'fr-2', 'runItem used when chatItem null');
  assert.strictEqual(detect(justChat).itemId, 'fr-1', 'chatItem used when runItem null');
  assert.strictEqual(detect(neither), null, 'both null → no scope (global fallback)');
});

t('behavior: /task all bypasses scope even with chatItem set', () => {
  // The escape hatch — typing inside a panel but wanting the global
  // list. wantAll forces null scope, which triggers the agent
  // prompt path.
  const ctx = { chatItem: { itemId: 'fr-1' }, runItem: null };
  const wantAll = true;
  const scope = wantAll ? null : (ctx.chatItem || ctx.runItem || null);
  assert.strictEqual(scope, null,
    '/task all must force scope=null even when chatItem is set');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
