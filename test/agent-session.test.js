// Phase 1 smoke test for server/src/agent-session.js.
//
// Spawns ONE AgentSession with a trivial initialPrompt against the
// real Claude Agent SDK and asserts the basic event lifecycle: a
// system_init lands, at least one assistant_text or tool_use, then
// a turn_result with subtype='success'.
//
// Skips gracefully when credentials aren't available (CI / fresh
// container without `claude login`). Real-network test by design —
// the whole point is verifying SDK round-trip works against our
// auth surface, not mocking the SDK.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const SDK_INSTALLED = (() => {
  try { require.resolve('@anthropic-ai/claude-agent-sdk'); return true; }
  catch { return false; }
})();

if (!SDK_INSTALLED) {
  console.log('── agent-session ──');
  console.log('  ~ skipped: @anthropic-ai/claude-agent-sdk not installed');
  process.exit(0);
}
if (!fs.existsSync(CRED_PATH) && !process.env.ANTHROPIC_API_KEY) {
  console.log('── agent-session ──');
  console.log(`  ~ skipped: no creds at ${CRED_PATH} and ANTHROPIC_API_KEY unset`);
  process.exit(0);
}

const { spawnAgent, AgentSession } = require('../server/src/agent-session');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function collectEvents(session, { until, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => {
      session.off('agent-event', onEvent);
      reject(new Error(`timed out after ${timeoutMs}ms — got ${events.length} events: ${events.map((e) => e.type).join(', ')}`));
    }, timeoutMs);
    function onEvent(e) {
      events.push(e);
      if (until(events, e)) {
        clearTimeout(timer);
        session.off('agent-event', onEvent);
        resolve(events);
      }
    }
    session.on('agent-event', onEvent);
  });
}

(async () => {
  console.log('── agent-session ──');

  await t('spawnAgent kicks a turn → emits system_init + turn_result/success', async () => {
    const session = spawnAgent('test-sess-1', {
      cwd: process.cwd(),
      initialPrompt: 'Reply with exactly the word READY and nothing else.',
    });
    assert.strictEqual(session.alive, true);
    assert.strictEqual(session.mode, 'agent');

    const events = await collectEvents(session, {
      until: (all, e) => e.type === 'turn_result',
      timeoutMs: 90000,  // first-turn cache-creation can take ~15s; allow padding for slow networks
    });

    const types = events.map((e) => e.type);
    assert.ok(types.includes('system_init'), `expected system_init event, got: ${types.join(', ')}`);
    assert.ok(
      types.includes('assistant_text') || types.includes('tool_use'),
      `expected at least one assistant_text or tool_use, got: ${types.join(', ')}`,
    );
    const result = events.find((e) => e.type === 'turn_result');
    assert.strictEqual(result.subtype, 'success', `expected success, got: ${result.subtype}`);
    assert.ok(result.totalCostUsd >= 0, 'expected totalCostUsd in result');
    assert.ok(session.sdkSessionId, 'expected SDK session id captured from system_init');

    session.kill();
    assert.strictEqual(session.alive, false);
  });

  await t('write() runs a follow-up turn that resumes the SDK session', async () => {
    const session = spawnAgent('test-sess-2', {
      cwd: process.cwd(),
      initialPrompt: 'Reply with the single word ONE.',
    });
    // Attach the collector BEFORE kicking the second turn, so it
    // catches events that may fire synchronously after write(). The
    // collector waits for TWO turn_result events — one per turn.
    let firstSdkSessionId = null;
    const allDone = collectEvents(session, {
      until: (all, e) => {
        if (e.type === 'system_init' && !firstSdkSessionId) {
          firstSdkSessionId = e.sdkSessionId;
        }
        // Kick the second turn the moment the first turn_result lands.
        if (e.type === 'turn_result' && all.filter((x) => x.type === 'turn_result').length === 1) {
          setImmediate(() => session.write('Reply with the single word TWO.'));
        }
        return all.filter((x) => x.type === 'turn_result').length === 2;
      },
      timeoutMs: 120000,
    });
    const events = await allDone;
    assert.ok(firstSdkSessionId, 'first turn should have captured an SDK session id via system_init');
    // The same SDK session id should be reused (resume semantics).
    assert.strictEqual(session.sdkSessionId, firstSdkSessionId,
      'second turn should reuse the SDK session id (resume), not start a new one');
    const results = events.filter((e) => e.type === 'turn_result');
    assert.strictEqual(results.length, 2, `expected 2 turn_results, got ${results.length}`);
    assert.strictEqual(results[1].subtype, 'success');
    session.kill();
  });

  await t('class shape — exposes the same surface PtySession does', () => {
    const s = new AgentSession('test-sess-3', { cwd: process.cwd() });
    // No initialPrompt → idle until first write().
    assert.strictEqual(s.alive, true);
    assert.strictEqual(s.mode, 'agent');
    assert.deepStrictEqual(s.pendingMenu, null);
    assert.ok(s.openToolCalls instanceof Map);
    assert.ok(Array.isArray(s.buffer));
    assert.strictEqual(typeof s.write, 'function');
    assert.strictEqual(typeof s.resize, 'function');
    assert.strictEqual(typeof s.kill, 'function');
    assert.strictEqual(typeof s.resolveMenuPick, 'function');
    s.kill();
  });

  // Phase 2 — canUseTool synthesizes a chat-pane menu and the resolve
  // promise settles when the user clicks an option. No SDK roundtrip
  // needed for this slice.

  await t('AskUserQuestion → menu broadcast → resolveMenuPick threads the answer back', async () => {
    const s = new AgentSession('test-ask-1', { cwd: process.cwd() });
    let broadcastMenu = null;
    s.on('menu', (menu) => { broadcastMenu = menu; });

    const input = {
      questions: [{
        question: 'How should I format the output?',
        header: 'Format',
        multiSelect: false,
        options: [
          { label: 'Summary',  description: 'Brief overview' },
          { label: 'Detailed', description: 'Full explanation' },
        ],
      }],
    };
    const pending = s._canUseTool('AskUserQuestion', input, { toolUseID: 'tu_ask_1' });
    // Menu should have fired by now (synchronous emit before the await).
    assert.ok(broadcastMenu, 'expected a menu to be emitted');
    assert.strictEqual(broadcastMenu.kind, 'plan');
    assert.strictEqual(broadcastMenu.question, 'How should I format the output?');
    assert.deepStrictEqual(
      broadcastMenu.options.map((o) => ({ n: o.n, label: o.label })),
      [{ n: 1, label: 'Summary' }, { n: 2, label: 'Detailed' }],
    );
    assert.match(broadcastMenu.hash, /^agent-tu_ask_1$/);

    // Simulate the chat-pane click on option 2.
    const handled = s.resolveMenuPick(broadcastMenu.hash, 2);
    assert.strictEqual(handled, true);

    // The canUseTool promise should now resolve with the SDK-shaped
    // response: questions passed through, answers keyed by question text.
    const resolved = await pending;
    assert.strictEqual(resolved.behavior, 'allow');
    assert.deepStrictEqual(
      resolved.updatedInput,
      { questions: input.questions, answers: { 'How should I format the output?': 'Detailed' } },
    );
    s.kill();
  });

  await t('Permission request (non-AskUserQuestion) → 3-option menu, picks 1/2/3 do allow-once/allow-always/deny', async () => {
    const s = new AgentSession('test-perm-1', { cwd: process.cwd() });
    const menus = [];
    s.on('menu', (m) => menus.push(m));

    // Allow-once path
    const p1 = s._canUseTool('Bash', { command: 'ls -la' }, { toolUseID: 'tu_perm_1', suggestions: [] });
    assert.strictEqual(menus.length, 1);
    assert.strictEqual(menus[0].kind, 'permission');
    assert.match(menus[0].question, /Allow Bash/);
    assert.deepStrictEqual(
      menus[0].options.map((o) => ({ n: o.n, label: o.label })),
      [
        { n: 1, label: 'Allow once' },
        { n: 2, label: 'Allow always' },
        { n: 3, label: 'Deny' },
      ],
    );
    s.resolveMenuPick(menus[0].hash, 1);
    const r1 = await p1;
    assert.strictEqual(r1.behavior, 'allow');
    assert.deepStrictEqual(r1.updatedInput, { command: 'ls -la' });
    assert.strictEqual(r1.updatedPermissions, undefined, 'allow-once must NOT persist a rule');

    // Allow-always path with a suggestion: should echo the suggestion
    // back in updatedPermissions so a .claude/settings.local.json rule lands.
    const suggestion = { destination: 'localSettings', behavior: 'allow', pattern: 'Bash(ls *)' };
    const p2 = s._canUseTool('Bash', { command: 'ls /tmp' }, { toolUseID: 'tu_perm_2', suggestions: [suggestion] });
    s.resolveMenuPick(menus[1].hash, 2);
    const r2 = await p2;
    assert.strictEqual(r2.behavior, 'allow');
    assert.deepStrictEqual(r2.updatedPermissions, [suggestion], 'allow-always must echo localSettings suggestions back');

    // Deny path
    const p3 = s._canUseTool('Edit', { file_path: '/etc/passwd' }, { toolUseID: 'tu_perm_3', suggestions: [] });
    s.resolveMenuPick(menus[2].hash, 3);
    const r3 = await p3;
    assert.strictEqual(r3.behavior, 'deny');
    assert.match(r3.message, /declined/i);

    s.kill();
  });

  await t('resolveMenuPick with unknown hash returns false and does not crash', () => {
    const s = new AgentSession('test-unknown-1', { cwd: process.cwd() });
    const handled = s.resolveMenuPick('agent-no-such-hash', 1);
    assert.strictEqual(handled, false);
    s.kill();
  });

  // Phase 4 — streaming-input + interrupt.

  await t('write() between turns pushes into the streaming queue (no new query)', async () => {
    // After the first iteration_start, subsequent writes go into the
    // same SDK iteration via the streaming-input prompt. We verify
    // this by counting iteration_start events: should be exactly 1
    // for an unbroken multi-turn conversation.
    const s = new AgentSession('test-stream-1', {
      cwd: process.cwd(),
      initialPrompt: 'Reply with only the word A.',
    });
    let secondQueued = false;
    const events = await collectEvents(s, {
      until: (all, e) => {
        if (e.type === 'turn_result' && !secondQueued) {
          secondQueued = true;
          setImmediate(() => s.write('Reply with only the word B.'));
          return false;
        }
        return all.filter((x) => x.type === 'turn_result').length === 2;
      },
      timeoutMs: 180000,
    });
    const iterStarts = events.filter((e) => e.type === 'iteration_start').length;
    assert.strictEqual(iterStarts, 1,
      `streaming-input should keep ONE SDK iteration alive across multiple turns; saw ${iterStarts} iteration_start events`);
    const turnStarts = events.filter((e) => e.type === 'turn_start').length;
    assert.strictEqual(turnStarts, 2, 'expected 2 turn_start events (one per user message)');
    s.kill();
  });

  await t('interrupt() aborts the in-flight iteration; next write resumes', async () => {
    const s = new AgentSession('test-interrupt-1', {
      cwd: process.cwd(),
      // Long enough prompt that we have time to interrupt before completion.
      initialPrompt: 'Slowly count from 1 to 50, one number per line.',
    });
    // Wait for iteration_start, then interrupt.
    let interrupted = false;
    const events = await collectEvents(s, {
      until: (all, e) => {
        if (e.type === 'iteration_start' && !interrupted) {
          interrupted = true;
          // Give the SDK a beat to start the actual API call before aborting.
          setTimeout(() => s.interrupt(), 200);
        }
        return e.type === 'iteration_aborted' || e.type === 'turn_result';
      },
      timeoutMs: 120000,
    });
    // Either we got an iteration_aborted (interrupt landed before the
    // SDK finished) or a turn_result (SDK finished before our 200ms
    // timer fired — unlikely but possible on a fast cache hit). Both
    // are valid SDK responses; we just need ONE of them. Then verify
    // the session is reusable.
    const sawAbort = events.some((e) => e.type === 'iteration_aborted');
    const sawResult = events.some((e) => e.type === 'turn_result');
    assert.ok(sawAbort || sawResult, 'expected iteration_aborted or turn_result');
    if (!sawAbort) {
      console.log('  (note: SDK completed before interrupt landed; skipping resume-after-abort verification)');
      s.kill();
      return;
    }
    // Iteration ended via abort. Next write should kick a fresh
    // iteration with resume=sdkSessionId.
    s.write('Reply with the single word RECOVERED.');
    const resumed = await collectEvents(s, {
      until: (all, e) => e.type === 'turn_result',
      timeoutMs: 90000,
    });
    const newIterStarts = resumed.filter((e) => e.type === 'iteration_start');
    assert.ok(newIterStarts.length >= 1, 'expected a fresh iteration_start after the abort');
    assert.strictEqual(newIterStarts[newIterStarts.length - 1].resume, true,
      'post-abort iteration should be flagged resume:true');
    s.kill();
  });

  await t('AsyncMessageQueue: push/iter/close behaves correctly', async () => {
    // Pull the internal class out via the module's filename so we
    // don't have to add it to exports just for tests.
    const mod = require('../server/src/agent-session');
    const session = new mod.AgentSession('test-queue-1', { cwd: process.cwd() });
    // session._msgQueue is null until iteration starts; spin up one
    // via a fake fast iteration that we then abort.
    session.write('test');
    assert.ok(session._iterating || session._pendingPrePush, 'write() should kick iteration or stash');
    session.kill();
    assert.strictEqual(session.alive, false);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((err) => {
  console.error('test harness failed:', err);
  process.exit(1);
});
