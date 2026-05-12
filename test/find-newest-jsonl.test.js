// Regression coverage for findNewestJsonl (sessions.js + transcript.js).
//
// Bug: the recursive walker was returning Task-tool subagent transcripts
// (`<project>/subagents/agent-*.jsonl`) when their mtime happened to be the
// newest in the project tree. The basename then got stored as
// `claudeSessionId`, and `claude --resume agent-<hex>` fails because that
// id is not a UUID — leaving the PTY blank and the chat hung.
//
// These tests exercise the fixed walker against a tmp project dir that
// contains a real-uuid jsonl AND a newer subagent jsonl. The walker MUST
// return the uuid one (or null if it's the only file and it isn't a uuid).

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const sessionsMod = require('../server/src/sessions');

let passed = 0;
let failed = 0;

function t(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log('  ✓ ' + name); passed++; },
    (err) => { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; },
  );
}

async function withTmp(fn) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'myco-jsonl-'));
  try { return await fn(tmp); }
  finally { try { await fsp.rm(tmp, { recursive: true, force: true }); } catch {} }
}

async function touchJsonl(full, mtimeOffsetMs = 0) {
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, '{"type":"user","cwd":"/wks/x"}\n');
  if (mtimeOffsetMs) {
    const t = new Date(Date.now() + mtimeOffsetMs);
    await fsp.utimes(full, t, t);
  }
}

const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SUBAGENT_NAME = 'agent-abd0bdf362cb00a68';

async function main() {
  console.log('── findNewestJsonl: subagent rejection ──');

  await t('isClaudeSessionId accepts canonical UUIDs', () => {
    assert.strictEqual(sessionsMod.isClaudeSessionId(UUID_A), true);
    assert.strictEqual(sessionsMod.isClaudeSessionId(UUID_B), true);
  });

  await t('isClaudeSessionId rejects subagent ids and junk', () => {
    assert.strictEqual(sessionsMod.isClaudeSessionId(SUBAGENT_NAME), false);
    assert.strictEqual(sessionsMod.isClaudeSessionId(''), false);
    assert.strictEqual(sessionsMod.isClaudeSessionId(null), false);
    assert.strictEqual(sessionsMod.isClaudeSessionId('transcript'), false);
    assert.strictEqual(sessionsMod.isClaudeSessionId('not-a-uuid'), false);
  });

  await withTmp(async (dir) => {
    // Project layout that triggered the bug:
    //   <proj>/<uuid-a>.jsonl              (mtime: -10s)
    //   <proj>/subagents/agent-XYZ.jsonl   (mtime: now — newest)
    // Pre-fix: walker returned agent-XYZ. Post-fix: it must return uuid-a.
    await touchJsonl(path.join(dir, UUID_A + '.jsonl'), -10_000);
    await touchJsonl(path.join(dir, 'subagents', SUBAGENT_NAME + '.jsonl'), 0);

    await t('sessions.findNewestJsonl skips subagents/ even when newer', async () => {
      const newest = await sessionsMod.findNewestJsonl(dir);
      assert.ok(newest, 'expected a result');
      assert.strictEqual(newest.file, UUID_A + '.jsonl',
        `expected uuid jsonl, got ${newest.file}`);
    });
  });

  await withTmp(async (dir) => {
    // No uuid jsonl, only a subagent: walker must return null rather than
    // silently surfacing a non-resumable id.
    await touchJsonl(path.join(dir, 'subagents', SUBAGENT_NAME + '.jsonl'), 0);
    await t('sessions.findNewestJsonl returns null when only subagent jsonls exist', async () => {
      const newest = await sessionsMod.findNewestJsonl(dir);
      assert.strictEqual(newest, null);
    });
  });

  await withTmp(async (dir) => {
    // Newest-among-uuids picks the freshest valid one, even if a stale
    // subagent jsonl is technically newer.
    await touchJsonl(path.join(dir, UUID_A + '.jsonl'), -20_000);
    await touchJsonl(path.join(dir, UUID_B + '.jsonl'), -5_000);
    await touchJsonl(path.join(dir, 'subagents', SUBAGENT_NAME + '.jsonl'), 0);
    await t('sessions.findNewestJsonl picks the newest UUID even with newer subagent', async () => {
      const newest = await sessionsMod.findNewestJsonl(dir);
      assert.strictEqual(newest.file, UUID_B + '.jsonl');
    });
  });

  // The transcript-viewer copy uses the same logic in a sync flavor; if its
  // export shape changes the integration breaks silently. The CommonJS
  // import is enough to confirm wiring; behavioural parity is covered by
  // the shared isClaudeSessionId helper.
  await t('transcript.js wires findNewestJsonl via sessions.isClaudeSessionId', () => {
    const tSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'transcript.js'), 'utf8');
    assert.ok(/sessionsMod\.isClaudeSessionId/.test(tSrc),
      'transcript.js no longer references sessionsMod.isClaudeSessionId');
    assert.ok(/e\.name === 'subagents'/.test(tSrc),
      'transcript.js no longer skips the subagents/ directory');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
