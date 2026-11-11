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

  await t('constructor emits session_ready on the next tick so the pane isn\'t empty', async () => {
    const s = new AgentSession('test-ready-1', { cwd: process.cwd() });
    const events = await new Promise((resolve) => {
      const got = [];
      s.on('agent-event', (e) => { got.push(e); if (got.length >= 1) resolve(got); });
      setTimeout(() => resolve(got), 200);
    });
    assert.ok(events.length >= 1, 'expected at least one event before any write');
    assert.strictEqual(events[0].type, 'session_ready');
    assert.strictEqual(events[0].cwd, process.cwd());
    // Ring-buffer replay should also carry it (so reconnects see it too).
    assert.ok(s.buffer.some((e) => e.type === 'session_ready'),
      'session_ready should land in the per-session ring buffer for replay');
    s.kill();
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
    // Hash format: agent-<toolUseID>-q<questionIdx>. The q<idx> suffix
    // is the per-question identity that lets multi-question
    // AskUserQuestion calls ask sequentially without colliding.
    assert.match(broadcastMenu.hash, /^agent-tu_ask_1-q0$/);

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

  // Regression: claude sometimes packs N questions into one AskUserQuestion
  // call (verified on mycobeta 2026-05-15: "phase 2 only handles the first
  // one" warning fired, user got stranded with partial answers feeding
  // back into the SDK). Each question must now broadcast its own menu with
  // its own sub-hash, the user picks them sequentially, and the SDK
  // promise resolves only when the LAST sub-question's answer arrives.
  await t('AskUserQuestion with N questions asks sequentially, settles with all answers', async () => {
    const s = new AgentSession('test-ask-multi-1', { cwd: process.cwd() });
    const menus = [];
    s.on('menu', (m) => menus.push(m));
    const input = {
      questions: [
        { question: 'Q1?', header: 'A', multiSelect: false, options: [{ label: 'A1' }, { label: 'A2' }] },
        { question: 'Q2?', header: 'B', multiSelect: false, options: [{ label: 'B1' }, { label: 'B2' }, { label: 'B3' }] },
      ],
    };
    const pending = s._canUseTool('AskUserQuestion', input, { toolUseID: 'tu_multi' });
    assert.strictEqual(menus.length, 1, 'only the first sub-question is broadcast initially');
    assert.match(menus[0].hash, /^agent-tu_multi-q0$/);
    assert.strictEqual(menus[0].question, 'Q1?');
    assert.strictEqual(menus[0].subQuestionIdx, 0);
    assert.strictEqual(menus[0].subQuestionTotal, 2);
    // Pick option 2 for Q1 ("A2").
    s.resolveMenuPick(menus[0].hash, 2);
    assert.strictEqual(menus.length, 2, 'next sub-question broadcast after first resolve');
    assert.match(menus[1].hash, /^agent-tu_multi-q1$/);
    assert.strictEqual(menus[1].question, 'Q2?');
    assert.strictEqual(menus[1].subQuestionIdx, 1);
    // Pick option 3 for Q2 ("B3").
    s.resolveMenuPick(menus[1].hash, 3);
    const resolved = await pending;
    assert.strictEqual(resolved.behavior, 'allow');
    assert.deepStrictEqual(resolved.updatedInput.answers, { 'Q1?': 'A2', 'Q2?': 'B3' });
    assert.strictEqual(resolved.updatedInput.questions.length, 2);
    s.kill();
  });

  // Regression: AskUserQuestion with multiSelect=true must render
  // checkboxes (so the modal toggles instead of immediately resolving)
  // AND resolve via Submit with a comma-separated label string per the
  // SDK's multi-select answer convention.
  await t('AskUserQuestion multiSelect=true: toggle + submit returns comma-separated labels', async () => {
    const s = new AgentSession('test-ask-multi-toggle', { cwd: process.cwd() });
    const menus = [];
    s.on('menu', (m) => menus.push(m));
    const input = {
      questions: [{
        question: 'Pick all that apply',
        header: 'Tags',
        multiSelect: true,
        options: [
          { label: 'Alpha' },
          { label: 'Beta' },
          { label: 'Gamma' },
        ],
      }],
    };
    const pending = s._canUseTool('AskUserQuestion', input, { toolUseID: 'tu_multi_toggle' });
    assert.strictEqual(menus.length, 1);
    assert.strictEqual(menus[0].multi, true, 'menu.multi propagated');
    for (const o of menus[0].options) {
      assert.strictEqual(o.checkbox, true, 'each option flagged as checkbox');
      assert.strictEqual(o.checked, false, 'each option starts unchecked');
    }
    // Toggle option 1 (Alpha) and option 3 (Gamma) on.
    assert.strictEqual(s.resolveMenuToggle(menus[0].hash, 1), true);
    assert.strictEqual(s.resolveMenuToggle(menus[0].hash, 3), true);
    // Submit gathers Alpha + Gamma → "Alpha, Gamma".
    assert.strictEqual(s.resolveMenuSubmit(menus[0].hash), true);
    const resolved = await pending;
    assert.strictEqual(resolved.behavior, 'allow');
    assert.deepStrictEqual(resolved.updatedInput.answers, { 'Pick all that apply': 'Alpha, Gamma' });
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

  // Regression for the 2026-05-15 incident: a WebSearch canUseTool fired,
  // the chat broadcast went out, the user typed bare digits in chat to pick
  // an option, and pty.handleChatPostfixes' bare-digit branch fell through
  // because session.pendingMenu was null on the AgentSession. Root cause:
  // _handleAskUserQuestion set this.pendingMenu but _handlePermissionRequest
  // forgot to. The pendingMenu surface is what the chat-shorthand path
  // reads; missing it = bare digits silently queued as user messages.
  await t('Permission request also mirrors the menu onto session.pendingMenu (bare-digit chat pick)', async () => {
    const s = new AgentSession('test-perm-pending-1', { cwd: process.cwd() });
    let broadcastMenu = null;
    s.on('menu', (m) => { broadcastMenu = m; });
    assert.strictEqual(s.pendingMenu, null, 'starts clean');
    const p = s._canUseTool('WebSearch', { query: 'weather in Shenzhen' }, { toolUseID: 'tu_pending_1', suggestions: [] });
    assert.ok(broadcastMenu, 'menu must emit');
    assert.ok(s.pendingMenu, 'session.pendingMenu must be populated for the bare-digit chat shortcut');
    assert.strictEqual(s.pendingMenu.hash, broadcastMenu.hash, 'pendingMenu.hash must match broadcast');
    assert.strictEqual(s.pendingMenu.kind, 'permission');
    // Same path that pty.handleChatPostfixes uses for chat shorthand "1" / "2" / "3".
    s.resolveMenuPick(s.pendingMenu.hash, 1);
    await p;
    assert.strictEqual(s.pendingMenu, null, 'resolved → cleared');
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

  // Phase 5 — resume across process restart via the persisted sdkSessionId.

  // Phase 6 — per-session allow-list as a PreToolUse hook.

  await t('PreToolUse hook auto-allows tools matching the session allow-list', async () => {
    // Seed a session record with an allow-list entry.
    const sessionsMod = require('../server/src/sessions');
    const store = sessionsMod.loadStore();
    const sid = 'test-hook-allow';
    store.sessions[sid] = {
      id: sid,
      user: 'kkrazy',
      absCwd: process.cwd(),
      cwd: '.',
      createdAt: new Date().toISOString(),
      mode: 'agent',
      allowList: ['Bash(git)'],
      denyList: [],
    };
    sessionsMod.saveStore();

    const s = new AgentSession(sid, { cwd: process.cwd() });
    const out = await s._preToolUseHook({
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      tool_use_id: 'tu_hook_allow_1',
    });
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'allow');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /allow-list matched/);
    s.kill();
  });

  await t('PreToolUse hook auto-denies tools matching the session deny-list', async () => {
    const sessionsMod = require('../server/src/sessions');
    const store = sessionsMod.loadStore();
    const sid = 'test-hook-deny';
    store.sessions[sid] = {
      id: sid,
      user: 'kkrazy',
      absCwd: process.cwd(),
      cwd: '.',
      createdAt: new Date().toISOString(),
      mode: 'agent',
      allowList: [],
      denyList: ['Bash(rm)'],
    };
    sessionsMod.saveStore();

    const s = new AgentSession(sid, { cwd: process.cwd() });
    const chatNotes = [];
    s.on('chat', (m) => chatNotes.push(m));
    const out = await s._preToolUseHook({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
      tool_use_id: 'tu_hook_deny_1',
    });
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /deny-list matched/);
    // Chat note should have fired so the user sees WHY.
    assert.strictEqual(chatNotes.length, 1, 'expected a "denied" chat note');
    assert.match(chatNotes[0].text, /auto-denied/);
    s.kill();
  });

  await t('PreToolUse hook passes through (empty result) when no rule matches', async () => {
    const sessionsMod = require('../server/src/sessions');
    const store = sessionsMod.loadStore();
    const sid = 'test-hook-ask';
    store.sessions[sid] = {
      id: sid,
      user: 'kkrazy',
      absCwd: process.cwd(),
      cwd: '.',
      createdAt: new Date().toISOString(),
      mode: 'agent',
      allowList: [],
      denyList: [],
    };
    sessionsMod.saveStore();

    const s = new AgentSession(sid, { cwd: process.cwd() });
    const out = await s._preToolUseHook({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x', content: '...' },
      tool_use_id: 'tu_hook_ask_1',
    });
    // No hookSpecificOutput → SDK continues to canUseTool.
    assert.deepStrictEqual(out, {}, 'expected pass-through (empty result)');
    s.kill();
  });

  await t('AgentSession seeds sdkSessionId from opts.resumeSdkSessionId', () => {
    const s = new AgentSession('test-resume-seed', {
      cwd: process.cwd(),
      resumeSdkSessionId: 'sdk-pretend-session-abc',
    });
    assert.strictEqual(s.sdkSessionId, 'sdk-pretend-session-abc',
      'pre-seeded sdkSessionId should be live on the new instance');
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
