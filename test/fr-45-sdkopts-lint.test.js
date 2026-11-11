// fr-45 regression: SDK options are passed as plain JS object keys.
// A typo in any field name is silently ignored by the SDK — no
// warning, no runtime error, just a feature that doesn\'t work.
// This is exactly how bug-14 round 2 sat undetected for ~3 weeks: we
// passed `abortSignal: controller.signal` when the documented field
// is `abortController: controller`. The SDK silently dropped the
// unknown field and Stop became a no-op until the user reported it.
//
// Fix: add a startup-time validator that checks each sdkOpts key
// against a hardcoded allowlist extracted from the SDK\'s documented
// Options type (sdk.d.ts). Unknown keys log a loud warning. In dev
// mode (NODE_ENV !== 'production') the validator throws so tests
// catch typos before they ship.
//
// This test covers:
//   - the allowlist contains all 9 sdkOpts fields myco currently uses
//   - the validator flags unknown keys (incl. the bug-14 typo)
//   - the validator accepts known keys silently
//   - the bug-14 round 2 contract still holds: abortController is
//     present in the allowlist + the source uses it correctly

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ──────────────────────────────────────────────────────────────────────────
// Inlined FIXED behavior. The prod validator lives in
// agent-session.js; the inlined version below mirrors its contract so
// we can test the validation logic independently.

// Hardcoded SDK Options allowlist — extracted from the
// @anthropic-ai/claude-agent-sdk sdk.d.ts at the version pinned in
// server/package.json. Keep this list in sync with the prod allowlist
// in agent-session.js (the static-grep guards below enforce that).
const SDK_OPTIONS_ALLOWLIST = new Set([
  'abortController', 'additionalDirectories', 'agent', 'agents',
  'allowedTools', 'canUseTool', 'continue', 'cwd', 'disallowedTools',
  'toolAliases', 'tools', 'env', 'executable', 'executableArgs',
  'extraArgs', 'fallbackModel', 'enableFileCheckpointing', 'toolConfig',
  'forkSession', 'betas', 'hooks', 'onElicitation', 'persistSession',
  'sessionStore', 'sessionStoreFlush', 'loadTimeoutMs', 'includeHookEvents',
  'includePartialMessages', 'forwardSubagentText', 'thinking', 'effort',
  'maxThinkingTokens', 'maxTurns', 'maxBudgetUsd', 'taskBudget',
  'mcpServers', 'model', 'outputFormat', 'pathToClaudeCodeExecutable',
  'permissionMode', 'planModeInstructions', 'allowDangerouslySkipPermissions',
  'permissionPromptToolName', 'plugins', 'promptSuggestions',
  'agentProgressSummaries', 'resume', 'sessionId', 'resumeSessionAt',
  'sandbox', 'settings', 'managedSettings', 'settingSources', 'skills',
  'debug', 'debugFile', 'stderr', 'strictMcpConfig', 'systemPrompt',
  'title', 'spawnClaudeCodeProcess',
]);

function validateSdkOpts(opts) {
  const unknown = [];
  for (const k of Object.keys(opts || {})) {
    if (!SDK_OPTIONS_ALLOWLIST.has(k)) unknown.push(k);
  }
  return { ok: unknown.length === 0, unknown };
}

// ──────────────────────────────────────────────────────────────────────────

console.log('── fr-45: sdkOpts lint / typed validator ──');

t('allowlist contains all 9 sdkOpts fields myco currently uses', () => {
  // These are the fields myco assembles in _ensureIteration. If any
  // of them dropped off the SDK\'s Options type, the validator would
  // start flagging legitimate usage — that\'s a bigger refactor than
  // this test\'s scope, but at least we\'d see it loudly.
  const mycoSdkOpts = [
    'cwd', 'permissionMode', 'abortController', 'canUseTool',
    'hooks', 'settings', 'settingSources', 'mcpServers', 'resume',
  ];
  for (const f of mycoSdkOpts) {
    assert.ok(SDK_OPTIONS_ALLOWLIST.has(f),
      `myco\'s sdkOpts uses "${f}" — must be in the allowlist or sdkOpts assembly is bugged`);
  }
});

t('validator: known options pass with no warnings', () => {
  const opts = {
    cwd: '/wks/test',
    permissionMode: 'default',
    abortController: new AbortController(),
    canUseTool: () => {},
    hooks: { PreToolUse: [] },
    settings: { autoMemoryEnabled: true },
    settingSources: ['project', 'local'],
    mcpServers: {},
    resume: 'abc-123',
  };
  const res = validateSdkOpts(opts);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.unknown, []);
});

t('validator: abortSignal (the bug-14 round 2 typo) is FLAGGED as unknown', () => {
  // Pre-fix this exact typo lived in agent-session.js for ~3 weeks
  // and made Stop a no-op. Validator must catch it.
  const opts = {
    cwd: '/wks/test',
    abortSignal: new AbortController().signal,  // ← THE TYPO
  };
  const res = validateSdkOpts(opts);
  assert.strictEqual(res.ok, false);
  assert.ok(res.unknown.includes('abortSignal'),
    'validator must flag abortSignal — that\'s the bug-14 typo that lost ~3 weeks of broken Stop');
});

t('validator: arbitrary typo like canUseTools (plural) is flagged', () => {
  const opts = { canUseTools: () => {} };  // ← plural typo
  const res = validateSdkOpts(opts);
  assert.strictEqual(res.ok, false);
  assert.ok(res.unknown.includes('canUseTools'));
});

t('validator: empty options object → ok=true', () => {
  const res = validateSdkOpts({});
  assert.strictEqual(res.ok, true);
});

t('validator: null/undefined opts → ok=true (defensive)', () => {
  assert.strictEqual(validateSdkOpts(null).ok, true);
  assert.strictEqual(validateSdkOpts(undefined).ok, true);
});

t('validator: mixed known + unknown reports ALL unknowns', () => {
  const opts = {
    cwd: '/wks',
    abortSignal: 'typo',
    canUseTools: 'plural typo',
    permissionMode: 'default',
    foooo: 'random typo',
  };
  const res = validateSdkOpts(opts);
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(res.unknown.sort(), ['abortSignal', 'canUseTools', 'foooo']);
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards: anchor the validator onto prod source.

const PROD_AGENT = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');

t('agent-session.js declares SDK_OPTIONS_ALLOWLIST', () => {
  assert.match(PROD_AGENT, /SDK_OPTIONS_ALLOWLIST\b/,
    'SDK_OPTIONS_ALLOWLIST must be declared at the module level so the validator can consult it');
});

t('agent-session.js allowlist contains all 9 myco-used keys', () => {
  // Each of the 9 keys myco passes to sdkOpts must appear inside the
  // allowlist (as a quoted string).
  const myco = [
    'cwd', 'permissionMode', 'abortController', 'canUseTool', 'hooks',
    'settings', 'settingSources', 'mcpServers', 'resume',
  ];
  // Locate the allowlist body for inspection.
  const idx = PROD_AGENT.indexOf('SDK_OPTIONS_ALLOWLIST');
  assert.ok(idx > -1);
  const window = PROD_AGENT.slice(idx, idx + 3500);
  for (const k of myco) {
    assert.ok(new RegExp("['\"]" + k + "['\"]").test(window),
      `allowlist must contain "${k}" — myco\'s sdkOpts assembly uses it`);
  }
});

t('agent-session.js allowlist does NOT contain the bug-14 typo "abortSignal"', () => {
  // Negative guard: if a careless refactor added abortSignal back to
  // the allowlist (thinking it\'s an SDK field), this catches it.
  const idx = PROD_AGENT.indexOf('SDK_OPTIONS_ALLOWLIST');
  const window = PROD_AGENT.slice(idx, idx + 3500);
  assert.ok(!/['"]abortSignal['"]/.test(window),
    'allowlist must NOT contain "abortSignal" — that\'s the bug-14 typo, not a real SDK field');
});

t('agent-session.js declares _validateSdkOpts helper', () => {
  assert.match(PROD_AGENT, /_validateSdkOpts\s*\(/,
    '_validateSdkOpts(opts) helper must exist — runs at the top of each _ensureIteration attempt');
});

t('agent-session.js _ensureIteration calls _validateSdkOpts before query()', () => {
  // The validator must run BEFORE query() so we catch typos before
  // the SDK call (otherwise the typo silently slides through).
  const fnStart = PROD_AGENT.search(/async\s+_ensureIteration\s*\(/);
  const rest = PROD_AGENT.slice(fnStart);
  const nextFn = rest.slice(1).search(/\n\s{2}\w[\w$]*\s*\(/);
  const body = nextFn === -1 ? rest : rest.slice(0, nextFn + 1);
  assert.ok(/_validateSdkOpts\s*\(/.test(body),
    '_ensureIteration must call _validateSdkOpts on the constructed opts');
  // Validator call should come BEFORE query() in lexical order.
  const validIdx = body.indexOf('_validateSdkOpts');
  const queryIdx = body.indexOf('query(');
  assert.ok(validIdx > -1 && queryIdx > -1, 'both calls must be present');
  assert.ok(validIdx < queryIdx,
    '_validateSdkOpts must run BEFORE query() so we catch typos before the silent-drop fires');
});

t('agent-session.js validator surfaces unknown keys via console.error or warn', () => {
  // The whole point is loud surfacing — must use console.error or
  // console.warn (not just .log which is easy to miss in production
  // log floods).
  assert.match(PROD_AGENT, /SDK_OPTIONS_ALLOWLIST[\s\S]{0,4000}?(console\.error|console\.warn|throw)/,
    'validator must log via console.error/warn or throw — silent logging defeats the whole purpose');
});

// ──────────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
