// bench/harness2/lib/engine.js — P1-a.
//
// Drives ONE isolated myco AgentSession for a Harness² rollout, by requiring
// myco's own `server/src/*` modules at an absolute path. Nothing under
// `server/` is modified: this is the same trick `bench/hle/lib/engine.js`
// uses to benchmark myco's engines without forking them.
//
// Isolation contract (CONTRACT.md §9) — a rollout must not touch anything the
// user's sessions can see:
//   - its own cwd (the run's workspace/), its own `_myco_/events.jsonl`
//   - `autonomousPermission: true` so no permission menu can stall it.
//     NOT `MYCO_ALLOW_ALL`: that is read from process.env by
//     permissions.decide(), so setting it would silently disable permission
//     prompts for every OTHER session in this process too.
//   - a session id that cannot collide with a real one
//
// Pure-ish module: requires myco lazily (inside run()) so that `--dry-run` and
// the unit tests can load this file without a myco checkout present.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Content hash for the delivered rule: a MODIFIED seeded file counts as a
// deliverable, and mtime alone would fire on anything that touches the file.
function sha1File(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

// Turn an emitted failure payload into a human-readable string.
//
// TeamSession emits `team-failed` with an OBJECT
// ({reason:'stall', itemId, idleMs}), while AgentSession paths emit a
// string or an Error. `String(obj)` produces the literal "[object Object]",
// which is how a stall once reached the sweep report with its real cause
// (which worker, how long idle, which board item) erased. Read the payload
// instead of stringifying it blindly.
function describeFailure(err, fallback) {
  if (err === null || err === undefined) return fallback || 'unknown failure';
  if (typeof err === 'string') return err.slice(0, 500) || (fallback || 'unknown failure');
  if (err instanceof Error) return String(err.message || err).slice(0, 500);
  if (typeof err === 'object') {
    const reason = err.reason || err.error || err.message;
    const details = [];
    if (err.itemId) details.push(`item=${err.itemId}`);
    if (typeof err.idleMs === 'number') details.push(`idle=${Math.round(err.idleMs / 1000)}s`);
    if (err.worker) details.push(`worker=${err.worker}`);
    const head = reason ? String(reason) : (() => {
      try { return JSON.stringify(err); } catch { return 'unserialisable failure payload'; }
    })();
    return (details.length ? `${head} (${details.join(', ')})` : head).slice(0, 500);
  }
  return String(err).slice(0, 500);
}

// No default. bench/hle/lib/engine.js hardcodes
// /data/s00791175/myco-test/myco-1014/server/src, which exists on exactly one
// machine; copying that default turns a missing env var into a confusing
// MODULE_NOT_FOUND deep inside a require chain.
function resolveMycoSrc() {
  const src = process.env.MYCO_SRC;
  if (!src) {
    throw new Error(
      'MYCO_SRC is not set. Point it at myco\'s server/src, e.g.\n' +
      '  MYCO_SRC=/app/server/src node bench/harness2/myco-runner.js ...');
  }
  if (!fs.existsSync(path.join(src, 'agent-session.js'))) {
    throw new Error(`MYCO_SRC=${src} does not contain agent-session.js — wrong directory?`);
  }
  return src;
}

function requireMyco(mod) {
  return require(path.join(resolveMycoSrc(), mod));
}

// Session ids for rollouts are prefixed so they are greppable in logs and can
// never be confused with a user session (which is `myco-<user>-<hex>`).
function rolloutSessionId(runId) {
  return `harness2-${runId}`;
}

// ── harness materialisation ────────────────────────────────────────────────
//
// Copy the harness tree Harness² staged into the rollout's workspace, mapping
// Harness²'s c1..c8 layout onto myco's file layout. This mapping is the one
// documented in docs/arch/harness2-c1-c8.zh.md §0 and implemented by
// subagents.js / tool-guidance.js / harness-scripts.js / harness-hooks.js.
const COMPONENT_MAP = [
  // [harness-tree relative path (prefix or exact), destination under cwd]
  ['systemprompt.md', 'CLAUDE.md'],
  ['tool_guidance.md', path.join('.claude', 'tool_guidance.md')],
  ['tool_descriptions/tool_guidance.md', path.join('.claude', 'tool_guidance.md')],
  ['hooks.json', path.join('.claude', 'hooks.json')],
  ['LongTermMEMORY.md', path.join('.claude', 'memory', 'LongTermMEMORY.md')],
];

// n2-specific component names — these stay in the harness tree but are NOT
// written to disk; instead they override prompts-n2-shared.js text at
// TeamSession construction time. mapHarnessPath returns a sentinel string so
// materialiseHarness can collect them without silently dropping them.
const N2_SENTINEL_PREFIX = 'n2:';
const N2_COMPONENT_MAP = [
  ['worker_a_startup.md',  'n2:worker_a_startup'],
  ['worker_b_startup.md',  'n2:worker_b_startup'],
  ['board_guidance.md',    'n2:board_guidance'],
];

// Directory-level mappings: <src prefix>/<rest> → <dst prefix>/<rest>
const DIR_MAP = [
  ['sub_agents', path.join('.claude', 'agents')],
  ['skills', path.join('.claude', 'skills')],
  ['scripts', path.join('.myco_harness', 'scripts')],
];

// `sub_agents/<name>/AGENT.md` is Harness²'s shape; myco reads
// `.claude/agents/<name>.md` (flat, one file per agent). Flatten on the way in
// rather than teaching subagents.js a second layout — the myco-side layout is
// the Claude Code convention and should stay canonical.
function mapHarnessPath(rel) {
  const norm = rel.split(path.sep).join('/');
  for (const [from, to] of COMPONENT_MAP) {
    if (norm === from) return to;
  }
  // n2 components: return a sentinel so materialiseHarness can collect them
  // separately without dropping them or writing them to the filesystem.
  for (const [from, sentinel] of N2_COMPONENT_MAP) {
    if (norm === from) return sentinel;
  }
  const m = /^sub_agents\/([^/]+)\/AGENT\.md$/.exec(norm);
  if (m) return path.join('.claude', 'agents', `${m[1]}.md`);
  for (const [from, to] of DIR_MAP) {
    if (norm.startsWith(from + '/')) {
      return path.join(to, ...norm.slice(from.length + 1).split('/'));
    }
  }
  return null;
}

// Read the three n2-specific prompt-override components from a harness dir.
// Returns { workerAStartup, workerBStartup, boardGuidance } — any component
// that is absent in the harness tree is returned as null so TeamSession falls
// back to the canonical prompts-n2-shared.js text.
function readN2Components(harnessDir) {
  if (!harnessDir) return { workerAStartup: null, workerBStartup: null, boardGuidance: null };
  const read = (name) => {
    try { return fs.readFileSync(path.join(harnessDir, name), 'utf8') || null; }
    catch { return null; }
  };
  return {
    workerAStartup: read('worker_a_startup.md'),
    workerBStartup: read('worker_b_startup.md'),
    boardGuidance:  read('board_guidance.md'),
  };
}

function walkFiles(root, base = '') {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(path.join(root, base), { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const rel = base ? path.join(base, e.name) : e.name;
    if (e.isDirectory()) out.push(...walkFiles(root, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

// Returns { written: [rel], unmapped: [rel], guardrails: string|null }.
// `unmapped` is reported by the runner rather than ignored: a component the
// tuner produced but myco cannot host is a real finding, not noise.
function materialiseHarness(harnessDir, cwd) {
  const result = { written: [], unmapped: [], guardrails: null };
  if (!harnessDir) return result;
  for (const rel of walkFiles(harnessDir)) {
    const norm = rel.split(path.sep).join('/');
    // n2 components (mapHarnessPath returns the 'n2:…' sentinel) are prompt
    // overrides, not files: the runner reads them separately via
    // readN2Components and injects them into the TeamSession constructor.
    // Writing them to disk (a) litters the agent's workspace with literal
    // 'n2:*' files, (b) false-positives isDelivered for every n2 rollout,
    // and (c) leaks the sentinel text into the selector's candidate
    // evidence. Skip them here.
    const mapped = mapHarnessPath(rel);
    if (typeof mapped === 'string' && mapped.startsWith(N2_SENTINEL_PREFIX)) {
      continue;
    }
    if (norm === 'guardrails.md') {
      result.guardrails = fs.readFileSync(path.join(harnessDir, rel), 'utf8');
      continue;
    }
    const dst = mapped;
    if (!dst) { result.unmapped.push(norm); continue; }
    const abs = path.join(cwd, dst);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(path.join(harnessDir, rel), abs);
    result.written.push(dst.split(path.sep).join('/'));
  }
  // c2: fold guardrails into CLAUDE.md under a marked heading so the agent can
  // tell standing rules from the role prompt, and so a reader of the workspace
  // can see where they came from.
  if (result.guardrails && result.guardrails.trim()) {
    const claudeMd = path.join(cwd, 'CLAUDE.md');
    const prior = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, 'utf8') : '';
    const block = [
      '',
      '<!-- harness2:guardrails (c2) -->',
      '## Guardrails',
      '',
      result.guardrails.trim(),
      '',
    ].join('\n');
    fs.writeFileSync(claudeMd, prior + block, 'utf8');
    result.written.push('CLAUDE.md');
  }
  return result;
}

// Copy the task inputs the agent is allowed to read. Kept separate from the
// harness copy so a task file can never be mistaken for a harness component.
// Returns name -> sha1 of what was written. The hashes are what let
// isDelivered notice a MODIFICATION, which for code work is the deliverable
// (an agent that fixes a one-line bug changes a file rather than adding one).
function materialiseTask(taskDir, cwd) {
  const written = {};
  for (const rel of walkFiles(taskDir)) {
    const norm = rel.split(path.sep).join('/');
    // DELIVERABLE is runner metadata (CONTRACT.md §7), not task content.
    // Anything the adapter keeps in the task dir is content by definition.
    if (norm === 'DELIVERABLE') continue;
    const abs = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(path.join(taskDir, rel), abs);
    try { written[norm] = sha1File(abs); } catch { written[norm] = ''; }
  }
  return written;
}

// ── one rollout ────────────────────────────────────────────────────────────

// Resolves to { ok, delivered, turns, wall_s, cost_usd, error, timeoutHit,
// model, sdkSessionId }. Never throws for an agent-side failure — a failed
// rollout is data, and Harness² records it as evidence.
async function runRollout({ runId, cwd, taskPrompt, timeoutSec, eventsFile, onProgress }) {
  const { spawnAgent } = requireMyco('agent-session.js');
  const started = Date.now();
  const sessionId = rolloutSessionId(runId);
  const progress = typeof onProgress === 'function' ? onProgress : () => {};

  const session = spawnAgent(sessionId, {
    cwd,
    user: null,
    // The isolation switch. See the module header for why this is not
    // MYCO_ALLOW_ALL.
    autonomousPermission: true,
    workerRole: 'harness2-rollout',
    // Give the rollout its own journal so it never appends into a user
    // session's events.jsonl.
    eventsFile,
  });

  const outcome = {
    ok: false, delivered: false, turns: 0, toolCalls: 0, cost_usd: null,
    error: null, timeoutHit: false, model: null, sdkSessionId: null,
  };

  await new Promise((resolve) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) outcome.error = err;
      clearTimeout(timer);
      try { session.kill(); } catch {}
      resolve();
    };

    const timer = setTimeout(() => {
      outcome.timeoutHit = true;
      finish(`timed out after ${timeoutSec}s`);
    }, Math.max(1, timeoutSec) * 1000);

    session.on('agent-event', (ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'system_init') {
        outcome.model = ev.model || null;
        outcome.sdkSessionId = ev.sdkSessionId || null;
      }
      if (ev.type === 'tool_use' && ev.name) {
        // A tool call is proof the agent actually worked. It outlives the
        // turn: a rollout killed at its timeout may have made dozens of
        // calls and left real files without ever emitting a turn_result.
        outcome.toolCalls += 1;
        progress({ tool: ev.name });
      }
      if (ev.type === 'turn_result') {
        outcome.turns += 1;
        // totalCostUsd is 0 on gateways that do not report cost. Treat 0 as
        // "unknown" rather than "free" — CONTRACT.md §4.1 says not to fill 0.
        if (typeof ev.totalCostUsd === 'number' && ev.totalCostUsd > 0) {
          outcome.cost_usd = (outcome.cost_usd || 0) + ev.totalCostUsd;
        }
        outcome.ok = ev.subtype === 'success';
        if (!outcome.ok && ev.result) outcome.error = String(ev.result).slice(0, 500);
        finish();
      }
      if (ev.type === 'fatal') finish(String(ev.message || ev.error || 'fatal'));
      if (ev.type === 'iteration_aborted') finish(`iteration aborted (${ev.reason || 'unknown'})`);
    });
    session.on('exit', () => finish(outcome.error || 'session exited before a turn result'));

    try {
      session.write(taskPrompt);
    } catch (e) {
      finish(`write failed: ${e.message}`);
    }
  });

  outcome.wall_s = Number(((Date.now() - started) / 1000).toFixed(3));
  return outcome;
}

// Run a dual-agent (run-n2) rollout using TeamSession.
// n2Components comes from readN2Components(harnessDir).
async function runRolloutN2({ runId, cwd, taskPrompt, timeoutSec, eventsFile, onProgress, n2Components }) {
  const { TeamSession } = requireMyco('team-session.js');
  const started = Date.now();
  const sessionId = rolloutSessionId(runId) + '-n2';
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const eventsDir = path.dirname(eventsFile);

  const session = new TeamSession(sessionId, {
    cwd,
    user: null,
    task: taskPrompt,
    eventsDir,
    autonomousPermission: true,
    workerAStartup: n2Components && n2Components.workerAStartup,
    workerBStartup: n2Components && n2Components.workerBStartup,
    boardGuidance:  n2Components && n2Components.boardGuidance,
  });

  const outcome = {
    ok: false, delivered: false, turns: 0, toolCalls: 0, cost_usd: null,
    error: null, timeoutHit: false, model: null, sdkSessionId: null,
  };

  await new Promise((resolve) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) outcome.error = err;
      clearTimeout(timer);
      try { session.kill(); } catch {}
      resolve();
    };

    const timer = setTimeout(() => {
      outcome.timeoutHit = true;
      finish(`timed out after ${timeoutSec}s`);
    }, Math.max(1, timeoutSec) * 1000);

    session.on('agent-event', (ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'system_init') {
        outcome.model = ev.model || outcome.model || null;
        outcome.sdkSessionId = ev.sdkSessionId || outcome.sdkSessionId || null;
      }
      if (ev.type === 'tool_use' && ev.name) {
        // Same reason as the single-agent path: a tool call proves the team
        // worked even when the rollout is killed before any turn_result.
        outcome.toolCalls += 1;
        progress({ tool: ev.name, worker: ev.worker });
      }
      if (ev.type === 'turn_result') {
        outcome.turns += 1;
        if (typeof ev.totalCostUsd === 'number' && ev.totalCostUsd > 0) {
          outcome.cost_usd = (outcome.cost_usd || 0) + ev.totalCostUsd;
        }
      }
    });

    session.on('team-complete', (result) => {
      outcome.ok = result && result.ok !== false;
      if (result && result.error) outcome.error = describeFailure(result.error, 'team reported an error');
      finish();
    });

    session.on('team-failed', (err) => {
      outcome.ok = false;
      finish(describeFailure(err, 'team failed'));
    });

    session.on('exit', () => {
      if (!settled) finish(outcome.error || 'team session exited before completing');
    });

    // Dispatch the task to start the team: this is required to initiate the
    // first turn. Without this both workers sit idle until the stall watchdog
    // fires and marks the rollout failed. (Contrast runRollout which calls
    // session.write(taskPrompt) — TeamSession uses dispatchTask so both
    // worker-A and worker-B receive the mission.)
    try {
      session.dispatchTask(taskPrompt);
    } catch (e) {
      finish(`dispatchTask failed: ${e.message}`);
    }
  });

  outcome.wall_s = Number(((Date.now() - started) / 1000).toFixed(3));
  return outcome;
}

const DELIVERED_IGNORE = new Set(['.claude', '_myco_', '.myco_harness', 'node_modules', '.git']);

function isDelivered(taskDir, cwd, taskFiles) {
  // Rule 1: an explicit DELIVERABLE pointer in the task dir.
  const pointer = path.join(taskDir, 'DELIVERABLE');
  if (fs.existsSync(pointer)) {
    const first = fs.readFileSync(pointer, 'utf8').split(/\r?\n/)[0].trim();
    if (first) return fs.existsSync(path.join(cwd, first));
    return false;
  }
  // Rule 2: any non-ignored file the agent added — OR CHANGED — beyond the task
  // inputs.
  //
  // The "changed" half is not optional for code work. Measured on the test host:
  // an agent fixed a one-line bug exactly as asked (`return "hi"` → `"hello"`),
  // the trajectory showed the edit, and this function still said false because
  // the file already existed. Every candidate then "failed to produce an
  // artifact" and the sweep died with nothing to select from.
  //
  // `taskFiles` may be a list of names (callers that only know names) or a map
  // of name -> sha1 taken at materialise time (what the runner passes, so a
  // modification is detectable without re-reading the task dir).
  const seeded = Array.isArray(taskFiles) ? new Set(taskFiles) : new Set(Object.keys(taskFiles || {}));
  const hashes = (!Array.isArray(taskFiles) && taskFiles) ? taskFiles : null;
  for (const rel of walkFiles(cwd)) {
    const norm = rel.split(path.sep).join('/');
    if (DELIVERED_IGNORE.has(norm.split('/')[0])) continue;
    if (norm === 'CLAUDE.md') continue;         // written by materialiseHarness
    if (!seeded.has(norm)) return true;         // added
    if (hashes) {
      let now;
      try { now = sha1File(path.join(cwd, rel)); } catch { continue; }
      if (now !== hashes[norm]) return true;    // modified
    }
  }
  return false;
}

module.exports = {
  resolveMycoSrc,
  requireMyco,
  rolloutSessionId,
  mapHarnessPath,
  materialiseHarness,
  materialiseTask,
  runRollout,
  runRolloutN2,
  isDelivered,
  describeFailure,
  walkFiles,
  sha1File,
  DELIVERED_IGNORE,
  readN2Components,
  N2_SENTINEL_PREFIX,
};
