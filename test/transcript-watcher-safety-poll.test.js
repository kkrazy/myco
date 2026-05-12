// Regression: the transcript watcher must keep delivering new messages
// even when fs.watch goes deaf. Pre-fix, the only trigger for re-reading
// the jsonl was fs.watch firing; on overlay / bind-mount / Docker
// filesystems the watcher can silently stop emitting events even though
// the file keeps growing. Symptom: the readonly viewer freezes
// mid-stream and a page refresh is needed to recover. Post-fix, a 4s
// safety setInterval calls scheduleTick alongside fs.watch, so forward
// progress is guaranteed even if fs.watch never fires another event.

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-watcher-'));
const transcriptMod = require('../server/src/transcript');

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log('  ✓ ' + name); passed++; },
    (err) => { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; },
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('── transcript watcher safety poll ──');

  // Sanity: the source file actually wires the safety setInterval.
  await t('transcript.js defines the safetyPollTimer fallback', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'transcript.js'), 'utf8');
    assert.ok(/safetyPollTimer\s*=\s*setInterval/.test(src),
      'safetyPollTimer setInterval not found in transcript.js');
    assert.ok(/clearInterval\(safetyPollTimer\)/.test(src),
      'safetyPollTimer not cleared in unsubscribe');
    assert.ok(/dirWaitPollTimer/.test(src),
      'dirWaitPollTimer (existing directory-not-yet-present fallback) missing');
  });

  // Live test: write a real jsonl, watch it, ALWAYS receive new
  // appended messages within the safety-poll window even if fs.watch
  // doesn't fire. We can't easily force fs.watch to go deaf, so we
  // check the looser invariant: a new append + a wait of slightly more
  // than the safety-poll interval ALWAYS results in an onNewMessages
  // call. Combined with the source-grep test above, this guards the
  // fix.
  await t('append → callback fires within the safety-poll window', async () => {
    const file = path.join(tmp, 'live-' + Date.now() + '.jsonl');
    await fsp.writeFile(file, '');
    const calls = [];
    const unsub = transcriptMod.watchTranscript(file, (msgs) => {
      calls.push(msgs.length);
    }, { startByte: 0 });
    try {
      await sleep(150);
      await fsp.appendFile(file,
        JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' }, cwd: '/wks' }) + '\n',
      );
      // Wait a little longer than the safety-poll interval (4s) so
      // even on a filesystem where fs.watch missed the append, the
      // safety poll catches up.
      await sleep(4500);
      const total = calls.reduce((a, b) => a + b, 0);
      assert.ok(total >= 1, `expected at least 1 message via callback, got ${total} calls=${JSON.stringify(calls)}`);
    } finally {
      unsub();
    }
  });

  // Append-after-callback: subsequent appends must keep triggering
  // callbacks too, not just the first one. Tests that scheduleTick +
  // byteOffset progresses correctly across multiple poll cycles.
  await t('multiple appends → each surfaces via the watcher', async () => {
    const file = path.join(tmp, 'multi-' + Date.now() + '.jsonl');
    await fsp.writeFile(file, '');
    const received = [];
    const unsub = transcriptMod.watchTranscript(file, (msgs) => {
      for (const m of msgs) if (m && m.role) received.push(m.uuid || m.role);
    }, { startByte: 0 });
    try {
      await sleep(150);
      for (const uuid of ['u-a', 'u-b', 'u-c']) {
        await fsp.appendFile(file,
          JSON.stringify({ type: 'user', uuid, timestamp: new Date().toISOString(), message: { role: 'user', content: 'x' }, cwd: '/wks' }) + '\n',
        );
        await sleep(900);  // shorter than safety poll, longer than debounce
      }
      await sleep(4500);  // let the safety poll catch any missed events
      assert.ok(received.includes('u-a'), `missed u-a; got: ${received.join(',')}`);
      assert.ok(received.includes('u-b'), `missed u-b; got: ${received.join(',')}`);
      assert.ok(received.includes('u-c'), `missed u-c; got: ${received.join(',')}`);
    } finally {
      unsub();
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
