// delm-10 RLM mode — Recursive Language Model session mode for myco,
// modeled on Prime Intellect's prime-agent RLM harness
// (https://www.primeintellect.ai/blog/prime-agent): prompt-as-a-variable
// + programmatic recursive sub-agent calling.
//
// RLM hard implementation (myco-rlm-design.md): the old prompt-level
// `server/src/rlm-session.js` + `prompts-rlm.js` migrated into
// `server/src/agents/rlm/` and were deleted (static guard in test.sh).
//
// Contract:
//   - server/src/agents/rlm/prompt.js exports RLM_STARTUP / rlmPrompt()
//     and the prompt teaches the CONCRETE kernel API (state vars,
//     rlm_eval, rlm.spawn/collect) + both core RLM ideas.
//   - server/src/agents/rlm/index.js exports spawnRlmAgent /
//     startRlmLane / onRlmLaneTerminal / timestampedDir / ensureDir /
//     TERMINAL; spawnRlmAgent overlays the RLM prompt as systemPrompt +
//     autonomousPermission + the rlm MCP server (mcp.js).
//   - slashcmds.js registers /rlm and exports handleRlm; status is open
//     to all, on/off is owner+admin gated and persists rec.rlm;
//     /rlm <task> launches a background RLM lane.
//   - sessions.js ensureLiveSession respawns via spawnRlmAgent when
//     rec.rlm === true (and only then); agent-n2 sessions consume
//     rec.rlm through TeamSession (getOrCreateTeamSession passes it).

const assert = require('assert');
const fs = require('fs');
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

console.log('── delm-10: RLM mode (prime-agent insights) ──');

// ──────────────────────────────────────────────────────────────────────
// Group A: agents/rlm/prompt.js — the RLM contract prompt.

t('agents/rlm/prompt.js exports RLM_STARTUP + rlmPrompt() with both core RLM ideas', () => {
  const pr = require('../server/src/agents/rlm/prompt');
  assert.strictEqual(typeof pr.rlmPrompt, 'function', 'rlmPrompt must be a function');
  assert.ok(typeof pr.RLM_STARTUP === 'string' && pr.RLM_STARTUP.length > 500,
    'RLM_STARTUP must be a substantial prompt string');
  const p = pr.rlmPrompt();
  assert.strictEqual(p, pr.RLM_STARTUP, 'rlmPrompt() returns RLM_STARTUP verbatim');
  // Idea 1: prompt-as-a-variable.
  assert.ok(/prompt-as-a-variable/i.test(p),
    'prompt must teach prompt-as-a-variable (RLM idea 1)');
  // Idea 2: recursive sub-agents as function calls (the kernel API).
  assert.ok(/rlm\.spawn/.test(p) && /rlm\.collect/.test(p),
    'prompt must teach the rlm.spawn + rlm.collect kernel API (RLM idea 2, concrete)');
  // Hard implementation: the prompt teaches the kernel state contract.
  assert.ok(/state\.task/.test(p) && /state\.done/.test(p) && /state\.next/.test(p) && /state\.blockers/.test(p),
    'prompt must teach the state.task/done/next/blockers kernel variables');
  assert.ok(/rlm_eval/.test(p), 'prompt must point at the rlm_eval MCP tool (the kernel entry)');
  // It must NOT exempt the agent from project rules.
  assert.ok(/CLAUDE\.md/.test(p), 'prompt must keep CLAUDE.md conventions binding');
  // Design §8 risk 2: the kernel is not a sandbox — the prompt must say so.
  assert.ok(/not a sandbox|not\s+a\s+sandbox/i.test(p), 'prompt must declare the kernel is not a sandbox');
});

t('agents/rlm/prompt.js rlmN2Addendum declares board-contract PRECEDENCE', () => {
  const pr = require('../server/src/agents/rlm/prompt');
  assert.strictEqual(typeof pr.rlmN2Addendum, 'function', 'rlmN2Addendum must be a function');
  const a = pr.rlmN2Addendum();
  assert.ok(/WINS on conflicts/.test(a),
    'addendum must declare PRECEDENCE — board contract WINS on conflicts (§8 risk 5)');
  assert.ok(/sub-agent/i.test(a), 'addendum must cover sub-agent decomposition');
});

// ──────────────────────────────────────────────────────────────────────
// Group B: agents/rlm/index.js — the RLM facade (old rlm-session surface).

t('agents/rlm/index.js exports the lane surface + TERMINAL set', () => {
  const rs = require('../server/src/agents/rlm');
  for (const k of ['spawnRlmAgent', 'startRlmLane', 'onRlmLaneTerminal', 'timestampedDir', 'ensureDir', 'TERMINAL']) {
    assert.ok(rs[k] !== undefined, `agents/rlm must export ${k} (old rlm-session API)`);
  }
  assert.ok(rs.TERMINAL.has('turn_result') && rs.TERMINAL.has('fatal'),
    'TERMINAL must cover turn_result + fatal (mirrors compare-lanes)');
  assert.ok(rs.rlmKernelManager && rs.shutdownRlmKernel,
    'hard-impl surface: rlmKernelManager + shutdownRlmKernel must exist');
});

t('spawnRlmAgent overlays the RLM prompt + kernel MCP server', () => {
  const src = _read('server/src/agents/rlm/index.js');
  const body = fnBody(src, /function\s+spawnRlmAgent\s*\(/);
  assert.ok(body, 'spawnRlmAgent body must be locatable');
  assert.ok(/systemPrompt/.test(body) && /rlmPrompt\(\)/.test(body),
    'spawnRlmAgent must default systemPrompt to rlmPrompt()');
  assert.ok(/autonomousPermission/.test(body),
    'spawnRlmAgent must default autonomousPermission (background lanes must not hang)');
  assert.ok(/spawnAgent\(/.test(body),
    'spawnRlmAgent must reuse the existing AgentSession engine (same SDK session)');
  assert.ok(/mcp\.createServer/.test(body),
    'spawnRlmAgent must wire the rlm MCP server (rlm_eval tool) into the session');
});

t('startRlmLane delegates bridging to bridge.js (UI-only contract)', () => {
  const src = _read('server/src/agents/rlm/index.js');
  const body = fnBody(src, /function\s+startRlmLane\s*\(/);
  assert.ok(body, 'startRlmLane body must be locatable');
  assert.ok(/bridge\.bridgeRlmLane/.test(body),
    'startRlmLane must bridge via bridge.bridgeRlmLane (allocSeq + main emit live there)');
  assert.ok(/lane\.write\(task\)/.test(body),
    'startRlmLane must kick off the task via lane.write(task)');
  const bridgeSrc = _read('server/src/agents/rlm/bridge.js');
  const bridgeBody = fnBody(bridgeSrc, /function\s+bridgeRlmLane\s*\(/);
  assert.ok(/allocSeq/.test(bridgeBody),
    'bridge must re-stamp events with the MAIN session seq (sessions.allocSeq)');
  assert.ok(/mainSession\.emit\(\s*['"]agent-event['"]/.test(bridgeBody),
    'bridge must emit agent-event on the main session (chat pane bridging)');
});

// ──────────────────────────────────────────────────────────────────────
// Group C: /rlm slash command (stubbed sessions module, mirrors
// bug-90-critic-disable.test.js's stub pattern).

t('slashcmd: /rlm is registered + listed in listCommands', () => {
  const stub = {
    _rec: null, _owners: new Set(),
    getSessionRecord(_id) { return this._rec; },
    isOwnerOrAdmin(_id, user) { return this._owners.has(user); },
    saveStore() {},
    appendChatMessage() {},
    allocSeq() { return 1; },
    // RLM switch (task 2026-10-22 revision): session-level only — the stub
    // mirrors the real module's semantics (session flag governs; the
    // user-level helpers were removed).
    isRlmEffective(rec) { return !!(rec && rec.rlm === true); },
    getRlmScope(rec) {
      if (rec && rec.rlm === true) return 'session';
      return null;
    },
  };
  require.cache[require.resolve('../server/src/sessions')] = {
    exports: stub,
    id: require.resolve('../server/src/sessions'),
    filename: require.resolve('../server/src/sessions'),
    loaded: true,
  };
  require.cache[require.resolve('../server/src/permissions')] = {
    exports: { matchesPattern() { return false; } },
    id: require.resolve('../server/src/permissions'),
    filename: require.resolve('../server/src/permissions'),
    loaded: true,
  };
  delete require.cache[require.resolve('../server/src/slashcmds')];
  const slashcmds = require('../server/src/slashcmds');
  const cmds = slashcmds.listCommands();
  const rlmCmd = cmds.find((c) => c.name === 'rlm');
  assert.ok(rlmCmd, '/rlm must be in COMMANDS');
  assert.ok(/RLM/i.test(rlmCmd.summary), 'summary must describe RLM mode');
  assert.ok(/on/.test(rlmCmd.usage) && /off/.test(rlmCmd.usage),
    'usage must mention on + off variants');
});

t('/rlm status is OPEN to all users (read-only)', () => {
  const slashcmds = require('../server/src/slashcmds');
  const sessionsMod = require('../server/src/sessions');
  sessionsMod._rec = { user: 'alice' };
  sessionsMod._owners = new Set(['alice']);
  const replies = [];
  const ctx = {
    sessionId: 'sid-1', user: 'eve', args: 'status',
    reply: (m) => replies.push(String(m)),
    session: { emit() {} },
  };
  slashcmds.handleRlm(ctx);
  assert.strictEqual(replies.length, 1, 'must reply exactly once');
  assert.ok(/off/i.test(replies[0]), 'default status reply must say RLM is off');
});

t('/rlm on from owner persists rec.rlm=true + broadcasts rlm-mode-changed', () => {
  const slashcmds = require('../server/src/slashcmds');
  const sessionsMod = require('../server/src/sessions');
  sessionsMod._rec = { user: 'alice' };
  sessionsMod._owners = new Set(['alice']);
  const events = [];
  const ctx = {
    sessionId: 'sid-2', user: 'alice', args: 'on',
    reply() {},
    session: { emit: (kind, payload) => events.push({ kind, payload }) },
  };
  slashcmds.handleRlm(ctx);
  assert.strictEqual(sessionsMod._rec.rlm, true, 'rec.rlm must flip to true');
  const evt = events.find((e) => e.kind === 'state-update' &&
    e.payload && e.payload.kind === 'rlm-mode-changed');
  assert.ok(evt, 'must broadcast state-update kind:"rlm-mode-changed"');
  assert.strictEqual(evt.payload.rlm, true, 'broadcast payload must carry rlm:true');
});

t('/rlm on from non-owner viewer is REFUSED — rec.rlm unchanged', () => {
  const slashcmds = require('../server/src/slashcmds');
  const sessionsMod = require('../server/src/sessions');
  sessionsMod._rec = { user: 'alice' };
  sessionsMod._owners = new Set(['alice']);
  const replies = [];
  const ctx = {
    sessionId: 'sid-3', user: 'eve', args: 'on',
    reply: (m) => replies.push(String(m)),
    session: { emit() {} },
  };
  slashcmds.handleRlm(ctx);
  assert.ok(sessionsMod._rec.rlm === undefined,
    'rec.rlm must NOT be set for a denied user');
  assert.ok(replies.some((r) => /owner/i.test(r)), 'denial must mention the gate');
});

t('/rlm off from owner restores rec.rlm=false', () => {
  const slashcmds = require('../server/src/slashcmds');
  const sessionsMod = require('../server/src/sessions');
  sessionsMod._rec = { user: 'alice', rlm: true };
  sessionsMod._owners = new Set(['alice']);
  const ctx = {
    sessionId: 'sid-4', user: 'alice', args: 'off',
    reply() {},
    session: { emit() {} },
  };
  slashcmds.handleRlm(ctx);
  assert.strictEqual(sessionsMod._rec.rlm, false, '/rlm off must clear the flag');
});

// ──────────────────────────────────────────────────────────────────────
// Group D: sessions.js respawn wiring (static — the real ensureLiveSession
// needs the full SDK, so we lock the contract by source inspection).

t('static guard: ensureLiveSession respawns via spawnRlmAgent when RLM is effective', () => {
  const src = _read('server/src/sessions.js');
  const body = fnBody(src, /async\s+function\s+ensureLiveSession\s*\(/);
  assert.ok(body, 'ensureLiveSession body must be locatable');
  assert.ok(/isRlmEffective\(rec\)/.test(body),
    'ensureLiveSession must gate the RLM branch on isRlmEffective(rec) (session OR user scope)');
  const rlmIdx = body.indexOf('spawnRlmAgent');
  const plainIdx = body.indexOf('spawnAgent(sessionId');
  assert.ok(rlmIdx > 0, 'RLM branch must call spawnRlmAgent');
  assert.ok(plainIdx > rlmIdx,
    'the RLM branch must come BEFORE the plain spawnAgent branch so an opted-in session never spawns plain');
  const rlmBranch = body.slice(rlmIdx - 200, rlmIdx + 1400);
  assert.ok(/autonomousPermission:\s*false/.test(rlmBranch),
    'the MAIN RLM session must keep the interactive permission flow (autonomousPermission:false)');
  // Hard-impl migration: the require must point at agents/rlm.
  assert.ok(/require\('\.\/agents\/rlm'\)/.test(rlmBranch),
    "RLM branch must require('./agents/rlm') — the old rlm-session.js is deleted");
});

t('static guard: agent-n2 sessions consume rec.rlm (§5.1 gap closed)', () => {
  const src = _read('server/src/sessions.js');
  const body = fnBody(src, /async\s+function\s+getOrCreateTeamSession\s*\(/);
  assert.ok(body, 'getOrCreateTeamSession body must be locatable');
  assert.ok(/rlm:\s*isRlmEffective\(rec\)/.test(body),
    'getOrCreateTeamSession must pass the effective RLM state to TeamSession (session OR user scope; pre-fix: n2 early-return ignored /rlm)');
  const ts = _read('server/src/team-session.js');
  const spawnBody = fnBody(ts, /_spawnWorker\(actor, task, root\)\s*\{/);
  assert.ok(/rlmN2Addendum\(\)/.test(spawnBody),
    'TeamSession._spawnWorker must append rlmN2Addendum() when this.rlm is set');
});

t('static guard: existing modes untouched — agent / agent-n2 branches unchanged', () => {
  const src = _read('server/src/sessions.js');
  const body = fnBody(src, /async\s+function\s+ensureLiveSession\s*\(/);
  assert.ok(/rec\.mode\s*!==\s*'agent'\s*&&\s*rec\.mode\s*!==\s*'agent-n2'/.test(body),
    'mode migration must still only accept agent/agent-n2 (RLM is a rec.rlm flag, not a mode migration)');
  assert.ok(/getOrCreateTeamSession\(/.test(body),
    'agent-n2 team branch must still be present');
});

// ──────────────────────────────────────────────────────────────────────
// Group E: /help lists /rlm.

t('static guard: /rlm appears in the COMMANDS table before /help (discoverable)', () => {
  const src = _read('server/src/slashcmds.js');
  assert.ok(/names:\s*\[\s*['"]rlm['"]/.test(src), '/rlm must be in COMMANDS');
  assert.ok(/function\s+handleRlm\s*\(/.test(src), 'handleRlm must be defined');
  assert.ok(/handleRlm,/.test(_read('server/src/slashcmds.js').slice(-2000)) ||
    /handleRlm,/.test(src.slice(src.indexOf('module.exports'))),
    'handleRlm must be exported for unit testing');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
