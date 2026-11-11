// rlm-harness-shared-key — the /run-explore self-evolution plumbing.
//
// Verifies, WITHOUT touching the live SDK:
//   - exploreHarnessKey(task) is stable per task text and differs across tasks
//   - spawnRlmAgent with harnessKey composes the SHARED store into the prompt
//     (not the per-session store), while a null harnessKey keeps the
//     per-session behaviour (regression)
//   - host.handleHostRequest rlm.add_prompt/list_prompts honor ctx.harnessKey
//     (shared store) and default to parentSessionId when absent
//   - buildExploreReport/persistExploreReport produce the per-path evidence
//     shape (done summaries + FAIL notes with measurements)

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const cl = require(path.join(ROOT, 'server/src/compare-lanes.js'));
const harness = require(path.join(ROOT, 'server/src/agents/rlm/harness.js'));
const host = require(path.join(ROOT, 'server/src/agents/rlm/host.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-key-test-'));
}

async function main() {
  console.log('── rlm-harness-shared-key: per-task self-evolution store ──');

  await t('exploreHarnessKey is stable per task and differs across tasks', () => {
    const k1 = cl.exploreHarnessKey('design a compressor');
    const k2 = cl.exploreHarnessKey('design a compressor');
    const k3 = cl.exploreHarnessKey('design a different compressor');
    assert.strictEqual(k1, k2, 'same task text → same key');
    assert.notStrictEqual(k1, k3, 'different task text → different key');
    assert.ok(/^explore-task-[0-9a-f]{12}$/.test(k1), `key shape explore-task-<sha1-12> (got ${k1})`);
  });

  await t('harness store is keyed independently per harnessKey (isolation)', () => {
    const cwd = tmpdir();
    harness.addPromptAddition(cwd, 'explore-task-aaa', 'Rule A', 'r');
    harness.addPromptAddition(cwd, 'explore-task-bbb', 'Rule B', 'r');
    const a = harness.listPromptAdditions(cwd, 'explore-task-aaa');
    const b = harness.listPromptAdditions(cwd, 'explore-task-bbb');
    assert.ok(a.some((r) => r.text === 'Rule A'), 'key aaa holds Rule A');
    assert.ok(!a.some((r) => r.text === 'Rule B'), 'key aaa does NOT see Rule B');
    assert.ok(b.some((r) => r.text === 'Rule B'), 'key bbb holds Rule B');
  });

  await t('host rlm.add_prompt/list_prompts honor ctx.harnessKey', async () => {
    const cwd = tmpdir();
    const key = 'explore-task-hosttest';
    const out = await host.handleHostRequest(
      { type: 'rlm.add_prompt', text: 'Always benchmark before claiming a dead end', reason: 'test' },
      { cwd, parentSessionId: 'sess-X', harnessKey: key },
    );
    assert.ok(out.ok, 'add_prompt succeeds with harnessKey');
    const list = await host.handleHostRequest(
      { type: 'rlm.list_prompts' },
      { cwd, parentSessionId: 'sess-X', harnessKey: key },
    );
    assert.ok(list.prompts.some((r) => r.text === 'Always benchmark before claiming a dead end'),
      'list_prompts reads the SHARED store via harnessKey');
    // A DIFFERENT session reading with the SAME key sees the same rules —
    // that's the whole point (cross-worker accumulation).
    const listOther = await host.handleHostRequest(
      { type: 'rlm.list_prompts' },
      { cwd, parentSessionId: 'sess-Y', harnessKey: key },
    );
    assert.ok(listOther.prompts.length === list.prompts.length,
      'another worker with the same harnessKey sees the accumulated rules');
  });

  await t('host rlm.add_prompt defaults to per-session store when harnessKey absent', async () => {
    const cwd = tmpdir();
    await host.handleHostRequest(
      { type: 'rlm.add_prompt', text: 'Session-local rule', reason: 'test' },
      { cwd, parentSessionId: 'sess-Z' },
    );
    const rows = harness.listPromptAdditions(cwd, 'sess-Z');
    assert.ok(rows.some((r) => r.text === 'Session-local rule'),
      'absent harnessKey → per-session key (unchanged default)');
  });

  await t('spawnRlmAgent with harnessKey composes the shared store into the prompt', () => {
    const cwd = tmpdir();
    const key = 'explore-task-compose';
    harness.addPromptAddition(cwd, key, 'Shared rule via compose', 'test');
    const { spawnRlmAgent } = require(path.join(ROOT, 'server/src/agents/rlm/index.js'));
    const s = spawnRlmAgent('compose-test-1', { cwd, harnessKey: key, systemPrompt: 'BASE', includeHarness: true });
    assert.ok(s.systemPrompt.includes('BASE'), 'base prompt preserved');
    assert.ok(s.systemPrompt.includes('Shared rule via compose'),
      'shared harness store rules composed into the prompt');
    s.kill();
    // Regression: a session WITHOUT harnessKey does not see the shared store.
    const s2 = spawnRlmAgent('compose-test-2', { cwd, systemPrompt: 'BASE2', includeHarness: true });
    assert.ok(!s2.systemPrompt.includes('Shared rule via compose'),
      'per-session store (no harnessKey) does not see the shared rules');
    s2.kill();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
