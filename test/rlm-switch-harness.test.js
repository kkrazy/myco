// RLM switch (task 2026-10-22 revision) — RLM is switchable at SESSION
// scope only (the user-level scope was removed); the slash command drives
// that switch, and in RLM mode run-n2 / single-agent conversations must
// use the RLM core tech:
//   1) REPL+variables (persistent kernel namespace),
//   2) Continual Harness (agent self-adds prompt rules at runtime).
//
// Contract covered here:
//   - sessions.js: isRlmEffective / getRlmScope (session-level only);
//     ensureLiveSession + getOrCreateTeamSession + runN2CompareLanes read
//     isRlmEffective (not raw rec.rlm).
//   - slashcmds.js handleRlm: /rlm session on|off (legacy /rlm on|off);
//     /rlm user on|off replies with a removal notice; the broadcast
//     carries scope.
//   - Continual Harness: kernel shim rlm.addPrompt/listPrompts (child.js),
//     host routes rlm.add_prompt / rlm.list_prompts, harness.js durable
//     store (_myco_/rlm/<sid>/harness/prompt-additions.jsonl), and
//     spawnRlmAgent composes the additions into the systemPrompt.
//   - team-session.js: RLM-mode teams give each worker a real kernel MCP
//     server (mcp__rlm__ namespace) so run-n2 workers USE the RLM core.
//   - prompt.js: rlmN2Addendum teaches the kernel API; rlmPrompt teaches
//     the Continual Harness.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── RLM switch: session scope + Continual Harness ──');

// ── Group A: sessions.js — effective-mode helpers (session-level only) ──

t('sessions.js loads with the RLM switch helpers exported (user-level removed)', () => {
  // Loading sessions.js touches the real STATE_DIR only lazily (loadStore
  // on first use), so a plain require is safe in tests.
  const sessions = require('../server/src/sessions');
  assert.strictEqual(typeof sessions.isRlmEffective, 'function',
    'isRlmEffective must be exported (all read sites use it)');
  assert.strictEqual(typeof sessions.getRlmScope, 'function',
    'getRlmScope must be exported (attach frame + UI badge)');
  // User-level surface removed (2026-10-22 revision).
  assert.strictEqual(sessions.getRlmUserSetting, undefined,
    'getRlmUserSetting must be removed (user-level scope gone)');
  assert.strictEqual(sessions.setRlmUserSetting, undefined,
    'setRlmUserSetting must be removed (user-level scope gone)');
  assert.strictEqual(sessions.RLM_USER_MODES, undefined,
    'RLM_USER_MODES must be removed (user-level scope gone)');
});

t('isRlmEffective/getRlmScope are session-flag driven (user scope removed)', () => {
  const src = _read('server/src/sessions.js');
  const body = fnBody(src, /function isRlmEffective\b/);
  assert.ok(/rec\.rlm\s*===\s*true/.test(body),
    'isRlmEffective must read the session flag (rec.rlm) as the only source');
  assert.ok(!/getRlmUserSetting/.test(body),
    'isRlmEffective must NOT reference the removed user-level setting');
  const scopeBody = fnBody(src, /function getRlmScope\b/);
  assert.ok(/'session'/.test(scopeBody) && /null/.test(scopeBody),
    'getRlmScope must distinguish session | null(off)');
  assert.ok(!/'user'/.test(scopeBody),
    'getRlmScope must NOT return the removed user scope');
});

t('ensureLiveSession + getOrCreateTeamSession read isRlmEffective, not raw rec.rlm', () => {
  const src = _read('server/src/sessions.js');
  const ensureBody = fnBody(src, /async function ensureLiveSession\b/);
  assert.ok(/if\s*\(isRlmEffective\(rec\)\)/.test(ensureBody),
    'ensureLiveSession must branch on isRlmEffective(rec) so RLM-opted sessions respawn with the RLM engine');
  const teamBody = fnBody(src, /async function getOrCreateTeamSession\b/);
  assert.ok(/rlm:\s*isRlmEffective\(rec\)/.test(teamBody),
    'getOrCreateTeamSession must pass rlm: isRlmEffective(rec) so RLM reaches agent-n2 teams');
});

// ── Group B: harness.js — Continual Harness durable store ──

t('harness.js: add → list → compose round-trip with bounds', () => {
  const h = require('../server/src/agents/rlm/harness');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-harness-'));
  const row = h.addPromptAddition(dir, 'sess-x', 'Run the full suite before committing', 'broke main once');
  assert.strictEqual(row.id, 1, 'first addition gets id 1');
  const rows = h.listPromptAdditions(dir, 'sess-x');
  assert.strictEqual(rows.length, 1, 'one persisted row after one add');
  assert.strictEqual(rows[0].text, 'Run the full suite before committing');
  const sec = h.composeHarnessSection(dir, 'sess-x');
  assert.ok(sec.includes('## Self-authored harness rules') && sec.includes('Run the full suite'),
    'composed section must carry the rule text under a stable heading');
  assert.strictEqual(h.composeHarnessSection(dir, 'never-seen'), '',
    'empty store composes to empty string (fresh sessions byte-identical)');
  // n2 worker ids contain ':' — must be filesystem-safe.
  h.addPromptAddition(dir, 'sid:worker-A', 'colon rule', '');
  assert.ok(fs.existsSync(h.harnessFile(dir, 'sid:worker-A')),
    'colon-containing kernel ids must map to a safe harness file');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('harness.js: cap keeps only the newest MAX_ADDITIONS rows', () => {
  const h = require('../server/src/agents/rlm/harness');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-harness-cap-'));
  for (let i = 1; i <= h.MAX_ADDITIONS + 5; i++) h.addPromptAddition(dir, 'cap', `rule ${i}`, '');
  const rows = h.listPromptAdditions(dir, 'cap');
  assert.strictEqual(rows.length, h.MAX_ADDITIONS,
    `store must cap at MAX_ADDITIONS (${h.MAX_ADDITIONS})`);
  assert.strictEqual(rows[0].text, `rule 6`, 'oldest rows are dropped, newest kept');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Group C: kernel shim + host routes ──

t('kernel child exposes rlm.addPrompt / rlm.listPrompts shims', () => {
  const src = _read('server/src/agents/rlm/kernel/child.js');
  assert.ok(/addPrompt:\s*\(text\)\s*=>\s*hostRequest\(\{\s*type:\s*'rlm\.add_prompt'/.test(src),
    'child.js hostShim must expose addPrompt → rlm.add_prompt host_request');
  assert.ok(/listPrompts:\s*\(\)\s*=>\s*hostRequest\(\{\s*type:\s*'rlm\.list_prompts'/.test(src),
    'child.js hostShim must expose listPrompts → rlm.list_prompts host_request');
});

t('host.js routes rlm.add_prompt / rlm.list_prompts to harness.js', async () => {
  const host = require('../server/src/agents/rlm/host');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-host-'));
  const add = await host.handleHostRequest(
    { type: 'rlm.add_prompt', text: 'always cite file:line', reason: 'vague answers' },
    { cwd: dir, parentSessionId: 'host-sess' });
  assert.ok(add && add.ok === true && add.id === 1, 'add_prompt must persist + return the row id');
  const list = await host.handleHostRequest(
    { type: 'rlm.list_prompts' }, { cwd: dir, parentSessionId: 'host-sess' });
  assert.ok(list.ok && list.prompts.length === 1 && list.prompts[0].text === 'always cite file:line',
    'list_prompts returns the persisted additions');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('spawnRlmAgent composes harness additions into the systemPrompt', () => {
  const src = _read('server/src/agents/rlm/index.js');
  const body = fnBody(src, /function spawnRlmAgent\b/);
  assert.ok(/composeHarnessSection/.test(body),
    'spawnRlmAgent must call composeHarnessSection so self-authored rules survive respawns');
});

// ── Group D: team-session.js — n2 workers get the real kernel ──

t('RLM-mode TeamSession workers get a per-worker kernel MCP server', () => {
  const src = _read('server/src/team-session.js');
  const body = fnBody(src, /_spawnWorker\(actor, task, root\)/);
  // P1+P2 deepening: the per-worker kernel MCP now comes from the
  // spawnRlmAgent CONSTRUCTOR (it wires rlmKernelManager(sessionId) + the
  // rlm MCP server itself), keyed by the worker session id
  // "<sessionId>-<actor>" — not from hand-rolled wiring in _spawnWorker.
  // /run-explore widened the gate: rlmWorker = this.rlm || this.explore
  // (explore workers are FORCED onto RLM — the shared harness rides on
  // rlm.addPrompt). Both spellings must keep constructing via spawnRlmAgent.
  assert.ok(/this\.rlm\s*\|\|\s*this\.explore/.test(body) && /spawnRlmAgent\(this\.sessionId\s*\+\s*['"]-['"]\s*\+\s*actor/.test(body),
    '_spawnWorker must construct RLM workers via spawnRlmAgent("<sessionId>-<actor>") — that creates the per-worker kernel manager + rlm MCP server (rlmWorker = this.rlm || this.explore)');
  assert.ok(/rlmSpawn:\s*\{\s*parentSessionId:\s*this\.sessionId,\s*depth:\s*1,\s*maxDepth:\s*3\s*\}/.test(body),
    'RLM workers spawn at depth 1 / maxDepth 3 so sub-agents are depth-capped by the runtime');
  const killBody = fnBody(src, /kill\(\)/);
  assert.ok(/shutdownRlmKernel/.test(killBody),
    'team kill() must tear down the worker kernel children');
  assert.ok(/`\$\{this\.sessionId\}-\$\{actor\}`/.test(killBody),
    'kill() must tear down the kernel under the NEW worker id shape "<sessionId>-<actor>" (spawnRlmAgent keys the manager by session id)');
});

// ── Group E: prompts teach the core tech ──

t('rlmPrompt teaches the Continual Harness (self-authored prompt rules)', () => {
  const pr = require('../server/src/agents/rlm/prompt');
  const p = pr.rlmPrompt();
  assert.ok(/Continual Harness/.test(p) && /rlm\.addPrompt/.test(p) && /rlm\.listPrompts/.test(p),
    'RLM_STARTUP must teach rlm.addPrompt/listPrompts (runtime self-improvement)');
});

t('rlmN2Addendum teaches the concrete kernel API (run-n2 workers USE the core)', () => {
  const pr = require('../server/src/agents/rlm/prompt');
  const a = pr.rlmN2Addendum();
  assert.ok(/rlm_eval/.test(a), 'addendum must teach rlm_eval (REPL+variables)');
  assert.ok(/state\.task/.test(a), 'addendum must teach the state variables');
  assert.ok(/rlm\.addPrompt/.test(a), 'addendum must teach the Continual Harness');
  assert.ok(/rlm\.spawn/.test(a) && /rlm\.collect/.test(a),
    'addendum must teach programmatic sub-agents');
  assert.ok(/board coordination contract WINS/i.test(a),
    'board precedence must stay (team protocol never weakened)');
});

// ── Group F: slashcmds — the switch + slash stay in sync ──

t('handleRlm drives the session-level switch; /rlm user replies removal notice', () => {
  const src = _read('server/src/slashcmds.js');
  const body = fnBody(src, /function handleRlm\b/);
  assert.ok(/rlm\s+session\s+on\|off/i.test(_read('server/src/slashcmds.js')) || /session\\s\+\(on\|off\)/.test(body),
    'handleRlm must accept /rlm session on|off');
  assert.ok(/user\\s\+\(on\|off\)/.test(body),
    'handleRlm must still MATCH /rlm user on|off (to reply with the removal notice)');
  assert.ok(/移除|removed/i.test(body),
    '/rlm user on|off must reply that the user-level switch was removed');
  assert.ok(!/setRlmUserSetting/.test(body),
    'handleRlm must NOT persist through setRlmUserSetting (helper removed)');
  assert.ok(/isRlmEffective/.test(body) && /getRlmScope/.test(body),
    'status + broadcast must use the effective-mode helpers (session scope)');
});

t('runN2CompareLanes reads isRlmEffective (session switch reaches lanes)', () => {
  const src = _read('server/src/slashcmds.js');
  const body = fnBody(src, /function runN2CompareLanes\b/);
  assert.ok(/isRlmEffective\(rec\)/.test(body),
    'lane flag must use isRlmEffective so /run-n2 in RLM mode runs with the RLM engine');
});

// ── Group G: attach + UI carry the mode ──

t('attach frame ships effective rlm + scope; UI syncs from the frame', () => {
  const attachSrc = _read('server/src/attach.js');
  assert.ok(/kind:\s*'rlm-mode-changed'/.test(attachSrc) && /scope:\s*.*getRlmScope/.test(attachSrc),
    'attach snapshot must ship scope alongside the effective rlm flag');
  const appSrc = _read('web/public/app.js');
  assert.ok(/_refreshRlmSwitch\(\)/.test(appSrc),
    'the RLM switch select must sync from the rlm-mode-changed frame');
  assert.ok(!/\/api\/rlm/.test(appSrc),
    'the UI must not call the removed /api/rlm surface');
});

console.log(`── rlm-switch-harness: ${passed} passed, ${failed} failed ──`);
if (failed > 0) process.exit(1);
