// Regression: captureClaudeSessionId must REPLACE a stale claudeSessionId
// when claude code creates a new jsonl after a `--resume` respawn.
//
// Scenario:
//   1. Session was spawned originally → stored claudeSessionId = UUID_OLD.
//   2. Server restarts. ensureLiveSession respawns claude with
//      `--resume UUID_OLD`. Claude code creates a NEW jsonl (UUID_NEW)
//      and writes the live conversation there; UUID_OLD stops growing.
//   3. Pre-fix: captureClaudeSessionId saw `rec.claudeSessionId` was
//      already set and bailed (`if (!rec.claudeSessionId)`), so the
//      stored id stayed pointed at the frozen UUID_OLD. Readonly viewer
//      showed the wrong transcript; every subsequent --resume reused
//      the wrong id, creating yet another orphan jsonl.
//   4. Post-fix: `rec.claudeSessionId !== id` triggers the update, so
//      the store always tracks the file claude is actively writing to.

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cap-'));
process.env.MYCO_STATE_DIR = tmpRoot;
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
process.env.HOME = tmpRoot;       // captureClaudeSessionId derives projectsDir from os.homedir()
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });
fs.mkdirSync(path.join(tmpRoot, '.claude', 'projects'), { recursive: true });

// Re-require with the patched env so projectsDir resolves under tmpRoot.
delete require.cache[require.resolve('../server/src/sessions')];
const sessionsMod = require('../server/src/sessions');

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log('  ✓ ' + name); passed++; },
    (err) => { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; },
  );
}

function projDirFor(absCwd) {
  return path.join(tmpRoot, '.claude', 'projects', absCwd.replace(/\//g, '-'));
}

async function writeJsonl(absCwd, uuid, ageOffsetMs = 0) {
  const dir = projDirFor(absCwd);
  await fsp.mkdir(dir, { recursive: true });
  const full = path.join(dir, uuid + '.jsonl');
  await fsp.writeFile(full, '{"type":"user","cwd":"' + absCwd + '"}\n');
  if (ageOffsetMs) {
    const tm = new Date(Date.now() + ageOffsetMs);
    await fsp.utimes(full, tm, tm);
  }
  return full;
}

function seedStore(sessionId, absCwd, claudeSessionId) {
  const store = sessionsMod.loadStore();
  store.sessions = store.sessions || {};
  store.sessions[sessionId] = {
    id: sessionId,
    user: 'tester',
    cwd: '.',
    absCwd,
    claudeSessionId,
    createdAt: new Date().toISOString(),
  };
  sessionsMod.saveStore();
}

const UUID_OLD = '11111111-2222-3333-4444-555555555555';
const UUID_NEW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// captureClaudeSessionId polls every 500ms — wait long enough for one tick.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('── captureClaudeSessionId resume-replace ──');

  await t('replaces a stale claudeSessionId when a newer UUID jsonl appears', async () => {
    const sid = 'sess-cap-resume';
    const absCwd = path.join(process.env.MYCO_WORKSPACE, 'proj-a');
    fs.mkdirSync(absCwd, { recursive: true });
    // Layout: old jsonl exists (stale), new jsonl is newer.
    await writeJsonl(absCwd, UUID_OLD, -120_000);   // 2min old
    await writeJsonl(absCwd, UUID_NEW, 0);          // just now
    seedStore(sid, absCwd, UUID_OLD);

    // spawnedAtMs in the recent past so newest mtime is >= spawnedAtMs-2000.
    sessionsMod.captureClaudeSessionId(sid, absCwd, Date.now() - 1000);
    // The first tick fires at 500ms, so 1500ms is enough margin.
    await sleep(1500);

    const rec = sessionsMod.loadStore().sessions[sid];
    assert.strictEqual(rec.claudeSessionId, UUID_NEW,
      `expected ${UUID_NEW}, got ${rec.claudeSessionId}`);
  });

  await t('no-op when stored id already matches the newest jsonl', async () => {
    const sid = 'sess-cap-noop';
    const absCwd = path.join(process.env.MYCO_WORKSPACE, 'proj-b');
    fs.mkdirSync(absCwd, { recursive: true });
    await writeJsonl(absCwd, UUID_NEW, 0);
    seedStore(sid, absCwd, UUID_NEW);

    sessionsMod.captureClaudeSessionId(sid, absCwd, Date.now() - 1000);
    await sleep(1500);

    const rec = sessionsMod.loadStore().sessions[sid];
    assert.strictEqual(rec.claudeSessionId, UUID_NEW);
  });

  await t('captures from null → real UUID on fresh spawn', async () => {
    const sid = 'sess-cap-fresh';
    const absCwd = path.join(process.env.MYCO_WORKSPACE, 'proj-c');
    fs.mkdirSync(absCwd, { recursive: true });
    seedStore(sid, absCwd, null);
    // Capture starts polling; the jsonl appears mid-poll (the spawn delay).
    sessionsMod.captureClaudeSessionId(sid, absCwd, Date.now() - 100);
    await sleep(600);
    await writeJsonl(absCwd, UUID_NEW, 0);
    await sleep(1500);

    const rec = sessionsMod.loadStore().sessions[sid];
    assert.strictEqual(rec.claudeSessionId, UUID_NEW);
  });

  await t('ignores subagent jsonls under subagents/ even when newer', async () => {
    const sid = 'sess-cap-subagent';
    const absCwd = path.join(process.env.MYCO_WORKSPACE, 'proj-d');
    fs.mkdirSync(absCwd, { recursive: true });
    await writeJsonl(absCwd, UUID_OLD, -10_000);  // real session, slightly older
    // Subagent file under subagents/ with an `agent-` prefix that should
    // be rejected even though it's the newest mtime in the tree.
    const subDir = path.join(projDirFor(absCwd), 'subagents');
    await fsp.mkdir(subDir, { recursive: true });
    await fsp.writeFile(path.join(subDir, 'agent-abc.jsonl'), '');
    seedStore(sid, absCwd, UUID_OLD);

    sessionsMod.captureClaudeSessionId(sid, absCwd, Date.now() - 1000);
    await sleep(1500);

    const rec = sessionsMod.loadStore().sessions[sid];
    assert.strictEqual(rec.claudeSessionId, UUID_OLD,
      'should not have replaced with subagent id');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
