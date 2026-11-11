// RLM 热切换 (2026-11-11 用户报告: "RLM功能很少被触发，应该是开启后大量触发的")
// Root cause: `/rlm session on` 只写 rec.rlm + 广播徽标，活着的会话永远不换引擎 —
// ensureLiveSession 第一行 `if (live && live.alive) return live` 挡住了 RLM 分支。
// 用户开着页面连续聊，用的始终是 toggle 之前的 plain AgentSession。
//
// Contract (fix):
//   1. sessions.js exports applyRlmModeToLiveSession(sessionId, rec) —
//      热切换：单 agent 会话就地 arm/disarm RLM（systemPrompt + mcpServers
//      下一 iteration 生效），n2 会话置 this.rlm + 重生 worker。kill 路径
//      绝不出现（对象不换 → 已附着的 WS / lane bridge 全部继续工作）。
//   2. slashcmds handleRlm on/off 调 applyRlmModeToLiveSession。
//   3. AgentSession.setRlmMode(rlm, rec) — arm 时装 rlm MCP server + 组合
//      RLM prompt + harness；disarm 时还原 plain systemPrompt + 删 rlm
//      server。n2 worker 走同一路径（mode==='rlm' 标记）。
//   4. 首次 arm 时注入引导 turn（write 一条 "start by reading kernel
//      state"），提高模型实际调用 rlm_eval 的概率。disarm 不注入。
//   5. stats: getStats/statsLine 对 lane/child/n2-worker id 做 _mainId
//      归一（`-rlm`、`-rlm-cN`、`-cmp-*`、`-worker-A` 都归到主会话）。
//      row 落盘 `_myco_/rlm/stats-<mainId>.json`，reaper 杀会话不清零。
//   6. `/clear new` 走 ensureLiveSession 重建路径（respawn 真正尊重 rec.rlm）
//      —— handleClear new 分支改调 markSessionForRestart + 强制 respawn。
//   7. run-n2 / compare single lane 在 RLM off 时 byte-identical：
//      applyRlmModeToLiveSession 在 rlm=false 时绝不触碰 lane 逻辑。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { fnBody } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── RLM 热切换: /rlm session on 立即生效 + stats 归一 + /clear new 尊重 RLM ──');

// ── Group A: sessions.js applyRlmModeToLiveSession ──────────────────────

t('sessions.js exports applyRlmModeToLiveSession (the hot-toggle entrypoint)', () => {
  const src = _read('server/src/sessions.js');
  assert.ok(/function applyRlmModeToLiveSession\s*\(/.test(src),
    'applyRlmModeToLiveSession must be defined in sessions.js');
  assert.ok(/applyRlmModeToLiveSession,/.test(src.slice(src.indexOf('Object.assign(module.exports'))),
    'applyRlmModeToLiveSession must be exported');
});

t('applyRlmModeToLiveSession: single-agent arm calls setRlmMode(true, rec) — NO kill', () => {
  const src = _read('server/src/sessions.js');
  const body = fnBody(src, /function applyRlmModeToLiveSession\s*\(/);
  assert.ok(body, 'body locatable');
  assert.ok(/live\.setRlmMode\(\s*rlm\s*,\s*rec\s*\)/.test(body),
    'the live path must call live.setRlmMode(rlm, rec) — rlm = isRlmEffective(rec) so both arm and disarm flow through one in-place call');
  assert.ok(!/killSession\(/.test(body),
    'the hot toggle must NOT killSession — attached WS clients + lane bridges hold the object');
  assert.ok(/agent-n2/.test(body) && /_respawnWorkers/.test(body),
    'agent-n2 teams get the worker-respawn path (_respawnWorkers)');
});

t('applyRlmModeToLiveSession: off (disarm) restores the plain session without touching lanes', () => {
  const src = _read('server/src/sessions.js');
  const body = fnBody(src, /function applyRlmModeToLiveSession\s*\(/);
  assert.ok(/live\.setRlmMode\(\s*rlm\s*,\s*rec\s*\)/.test(body),
    'disarm flows the same call with rlm=false — setRlmMode restores the plain prompt + drops the rlm MCP server');
  assert.ok(!/compare-lanes/.test(body) && !/startN2Lane/.test(body) && !/startSingleLane/.test(body),
    'the toggle must never touch lane-start logic — /run-n2 + /compare read rec.rlm per run (off → plain lanes, unchanged)');
});

// ── Group B: slashcmds handleRlm wires the hot toggle ───────────────────

t('handleRlm on/off calls applyRlmModeToLiveSession (session alive → immediate effect)', () => {
  const src = _read('server/src/slashcmds.js');
  const body = fnBody(src, /function handleRlm\s*\(/);
  assert.ok(/applyRlmModeToLiveSession/.test(body),
    'handleRlm must hot-apply the toggle so an alive session switches engine without waiting for a reaper respawn');
});

// ── Group C: AgentSession.setRlmMode ────────────────────────────────────

t('AgentSession.setRlmMode arms RLM: rlm MCP server + composed prompt + first-turn nudge', () => {
  const src = _read('server/src/agent-session.js');
  assert.ok(/setRlmMode\(\s*rlm\s*,\s*rec\s*\)/.test(src) || /setRlmMode\(\s*(on|rlm)\b/.test(src),
    'AgentSession must expose setRlmMode(rlm, rec)');
  const body = fnBody(src, /setRlmMode\(\s*[^)]*\)\s*\{/);
  assert.ok(body, 'setRlmMode body locatable');
  assert.ok(/mcp\.createServer/.test(body),
    'arm must wire the rlm kernel MCP server (mcp__rlm__rlm_eval) onto this.mcpServers');
  assert.ok(/rlmPrompt\(\)/.test(body),
    'arm must compose the RLM contract prompt as the systemPrompt');
  assert.ok(/write\(/.test(body),
    'arm must inject the first-turn nudge via write() so the model starts by reading kernel state');
  assert.ok(/mode\s*=\s*'rlm'/.test(body),
    'arm must stamp session.mode = \'rlm\' (sidebar + lane badge read it)');
});

t('setRlmMode disarm restores the plain prompt and drops the rlm MCP server', () => {
  const src = _read('server/src/agent-session.js');
  const body = fnBody(src, /setRlmMode\(\s*[^)]*\)\s*\{/);
  // Disarm: restore the stashed pre-arm prompt/mode + remove the rlm
  // server key from this.mcpServers.
  assert.ok(/delete next\.rlm/.test(body),
    'disarm must remove the rlm MCP server key (delete next.rlm)');
  assert.ok(/this\._preRlmSystemPrompt/.test(body) && /this\._preRlmMode/.test(body),
    'disarm must restore the stashed pre-RLM systemPrompt + mode');
});

t('setRlmMode is idempotent (arm twice does not stack prompts or servers)', () => {
  const src = _read('server/src/agent-session.js');
  const body = fnBody(src, /setRlmMode\(\s*[^)]*\)\s*\{/);
  assert.ok(/_rlmApplied/.test(body) || /already/.test(body),
    'setRlmMode must short-circuit when the requested state is already applied');
});

// ── Group D: stats 归一 + 落盘 ───────────────────────────────────────────

t('stats.getStats/statsLine normalize lane/child/worker ids to the MAIN session id', () => {
  const src = _read('server/src/agents/rlm/stats.js');
  assert.ok(/function _mainId/.test(src), '_mainId helper exists');
  const getBody = fnBody(src, /function getStats\s*\(/);
  assert.ok(/_mainId/.test(getBody),
    'getStats must read through _mainId so /rlm <task> lane stats (id <main>-rlm) surface on the main session');
  const lineBody = fnBody(src, /function statsLine\s*\(/);
  // statsLine delegates to getStats (already normalized) — lock the
  // delegation so a future edit can't route it back to the raw row.
  assert.ok(/getStats\(/.test(lineBody),
    'statsLine must read through getStats (which normalizes via _mainId — the /rlm status line was blind to lane usage)');
  // Behavioral: a lane id and the main id must see the SAME row.
  const stats = require('../server/src/agents/rlm/stats');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-stats-norm-'));
  stats.__setStatsDirForTest(dir);
  stats.recordEval('sessX-rlm', 5, 5);           // one-shot /rlm lane usage
  stats.recordSpawn('sessX-worker-A', 'finder'); // n2 worker usage
  const main = stats.getStats('sessX');
  assert.strictEqual(main.evalCalls, 1,
    'lane usage must roll up to the main session id (getStats normalizes)');
  assert.strictEqual(main.spawns, 1,
    'n2 worker usage must roll up to the main session id');
  const line = stats.statsLine('sessX');
  assert.ok(/1 次内核调用/.test(line) && /1 次子代理/.test(line),
    'the /rlm status line must include rolled-up lane + worker usage');
  stats.dropSession('sessX');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('stats._mainId covers every lane/child/worker id shape', () => {
  const stats = require('../server/src/agents/rlm/stats');
  const f = stats._mainId;
  assert.ok(typeof f === 'function', '_mainId exported for tests');
  assert.strictEqual(f('main-rlm'), 'main', 'one-shot /rlm lane');
  assert.strictEqual(f('main-rlm-c3'), 'main', 'nested rlm child');
  assert.strictEqual(f('main-rlm-c2-rlm-c5'), 'main', 'deeply nested child');
  assert.strictEqual(f('main-cmp-single'), 'main', '/compare single lane (RLM lane uses startRlmLane → -rlm)');
  assert.strictEqual(f('main-cmp-n2-worker-A'), 'main', 'n2 lane worker');
  assert.strictEqual(f('main-worker-B'), 'main', 'RLM team worker (real agent-n2 session)');
  assert.strictEqual(f('main-cmp-team-worker-A'), 'main', 'expert team lane worker');
  assert.strictEqual(f('main-plain'), 'main-plain', 'unrelated ids pass through untouched');
});

t('stats rows survive a session kill: dropSession persists to disk, reload restores', () => {
  const stats = require('../server/src/agents/rlm/stats');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-stats-'));
  stats.__setStatsDirForTest(dir);
  stats.recordEval('persist-me', 10, 20);
  stats.recordSpawn('persist-me', 'finder');
  const before = stats.getStats('persist-me');
  assert.strictEqual(before.evalCalls, 1, 'in-memory row live');
  // kill path (spawnRlmAgent exit hook): dropSession persists the row and
  // drops it from the map — a subsequent getStats REHYDRATES from disk, so
  // the reaper kill / container restart no longer zeroes usage.
  stats.dropSession('persist-me');
  const rehydrated = stats.getStats('persist-me');
  assert.strictEqual(rehydrated.evalCalls, 1,
    'after the kill the read must come back from the persisted row — usage survives');
  assert.strictEqual(rehydrated.spawns, 1, 'spawn counter survives too');
  const onDisk = stats._loadRowFromDisk('persist-me');
  assert.strictEqual(onDisk && onDisk.evalCalls, 1,
    'the persisted row on disk carries the counts');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Group E: /clear new 尊重 rec.rlm ────────────────────────────────────

t('/clear new respawns through ensureLiveSession so rec.rlm decides the engine', () => {
  const src = _read('server/src/slashcmds.js');
  const body = fnBody(src, /function handleClear\s*\(/);
  assert.ok(/_respawnAfterClearNew|ensureLiveSession/.test(body),
    'handleClear new must force a respawn through ensureLiveSession (the only path that branches on isRlmEffective) — pre-fix the SDK conversation restarted but stayed on the SAME AgentSession, so /rlm on + /clear new still ran the plain engine');
});

// ── Group F: RLM-off 不影响 run-n2 / single（用户约束） ────────────────

t('RLM off: the toggle never touches run-n2 / single lane logic (user constraint)', () => {
  // handleRlm legitimately keeps the `/rlm <task>` one-shot lane (startRlmLane)
  // — that's an explicit user ask, not the toggle. The constraint is on the
  // TOGGLE branch (sessMatch block) + the applyRlmModeToLiveSession helper.
  const apply = fnBody(_read('server/src/sessions.js'), /function applyRlmModeToLiveSession\s*\(/);
  assert.ok(!/startN2Lane|startSingleLane|startRlmLane|stopN2Lane/.test(apply),
    'applyRlmModeToLiveSession must never start/stop lanes — /run-n2 + /compare stay self-serve');
  const slash = _read('server/src/slashcmds.js');
  const sessMatchAt = slash.search(/const sessMatch = args\.match/);
  const sessBlock = slash.slice(sessMatchAt, sessMatchAt + 2500);
  assert.ok(!/startN2Lane|startSingleLane|stopN2Lane/.test(sessBlock),
    'the /rlm session on|off branch must not touch n2/single lanes');
  // /run-n2 + /compare keep their own per-run rec.rlm reads (unchanged).
  const n2Body = fnBody(slash, /function runN2CompareLanes\s*\(/);
  assert.ok(/isRlmEffective\(rec\)/.test(n2Body),
    '/run-n2 + /compare still read the flag per run — RLM-off lanes stay plain, byte-identical');
});

t('RLM off: spawnRlmAgent stays opt-in only — plain agent path unchanged', () => {
  const src = _read('server/src/sessions.js');
  const ensureBody = fnBody(src, /async function ensureLiveSession\s*\(/);
  const plainIdx = ensureBody.indexOf('spawnAgent(sessionId');
  const rlmIdx = ensureBody.indexOf('spawnRlmAgent');
  assert.ok(plainIdx > -1 && rlmIdx > -1, 'both branches still present');
  assert.ok(/if\s*\(isRlmEffective\(rec\)\)/.test(ensureBody),
    'respawn still branches on isRlmEffective — off sessions keep the plain engine');
});

// ── Group G: 首turn引导注入 ─────────────────────────────────────────────

t('spawnRlmAgent arms the first-turn nudge (fresh RLM sessions start by reading kernel state)', () => {
  const src = _read('server/src/agents/rlm/index.js');
  assert.ok(/RLM_NUDGE/.test(src) || /reading kernel state|state\.task/.test(src),
    'the nudge prompt text must exist (teaches the model to open with rlm_eval state reads)');
  // startRlmLane already writes the task; the nudge must NOT double-write there.
  const laneBody = fnBody(src, /function startRlmLane\s*\(/);
  assert.ok(!/RLM_NUDGE/.test(laneBody),
    'startRlmLane writes the task itself — the nudge stays in the spawn path so lanes don\'t double-dispatch');
});

console.log(`\nrlm-hot-toggle: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
