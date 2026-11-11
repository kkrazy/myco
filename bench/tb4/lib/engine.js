// tb4/lib/engine.js — drive myco's OWN engines to solve a Terminal-Bench task
// inside a host workspace.
//
//  - single -> a TOOL-CAPABLE single AgentSession (one claude-agent-sdk session
//    with Bash/tools, autonomousPermission auto-approve) — the same shape as
//    myco's /compare single shadow lane (compare-lanes.startSingleLane).
//    (Note: unlike HLE, TB4 is agentic/terminal — HLE's no-tool
//    `callLocalClaude` cannot run terminal commands, so single here is the
//    tool-capable variant.)
//  - n2     -> myco's TeamSession (worker-A + worker-B sharing a DelmBoard),
//    driven the same way compare-lanes.startN2Lane / hle n2Ask drive it.
//
// We do NOT reimplement the engines — we require myco's modules directly by
// absolute path (their bare requires resolve through NODE_PATH set by the
// launcher). The only code here is a thin adapter: build the task text, spawn
// the session/team, wait for completion/timeout. Verification is external (the
// task's own verifier runs against the resulting workspace), so the engine
// returns only ok/duration/error.
'use strict';

const fs = require('fs');
const path = require('path');

const MYCO_SRC = process.env.MYCO_TB4_SRC
  || path.resolve(__dirname, '..', '..', '..', 'server', 'src');

const MOCK = process.env.TB4_MOCK === '1';
let _mockCounter = 0;

function requireMyco(mod) {
  return require(path.join(MYCO_SRC, mod));
}

// system prompt for the single agent: /app paths map to the current working
// directory, work until fully done, full shell access.
const SINGLE_SYSTEM = [
  'You are an autonomous terminal operator solving a real-world engineering task.',
  'Your current working directory is the task workspace. Any path the task',
  'writes as `/app/...` refers to THIS directory (use the relative path here,',
  'NOT an absolute /app path — /app does not exist on this host).',
  'You have full shell access (Bash) and may install packages, run commands,',
  'and create/edit files as needed.',
  'Work until the task is FULLY complete. Do not stop early.',
  'When you have finished, state the result.',
].join('\n');

// Task text sent to the n2 team: prepend the /app<->cwd mapping + a completion
// marker protocol so the harness can detect when the team is done.
function buildN2Task(instruction) {
  return [
    'Solve the terminal task below by working in the shared workspace (your',
    'current working directory). NOTE: the task writes paths as `/app/...` which',
    'refer to THIS working directory — use relative paths here, not absolute /app.',
    '',
    'TASK:',
    instruction,
    '',
    'Division of work (follow the board protocol):',
    '- worker-A: reserve ONE scope ("solve the task"), work the task in the',
    '  shared workspace, and when you are confident it is FULLY complete, write a',
    '  single line `DONE` to the file `._tb4_done` in the workspace, then close',
    '  your claim with `done`.',
    '- worker-B: independently verify worker-A\'s result in the same workspace.',
    '  If you find it incomplete or incorrect, fix it, then also ensure',
    '  `._tb4_done` exists.',
    '',
    'Finish: the task is complete once `._tb4_done` exists and every open queue',
    'item is closed (done).',
  ].join('\n');
}

function mockRun() {
  _mockCounter += 1;
  return {
    ok: true,
    ms: 200 + (_mockCounter % 5) * 90,
    error: undefined,
  };
}

// ── single: tool-capable AgentSession ───────────────────────────────────────
async function singleRun(taskId, instruction, { cwd, timeoutMs } = {}) {
  if (MOCK) return mockRun();
  const { AgentSession } = requireMyco('agent-session.js');
  const eventsDir = path.join(cwd, '_myco_');
  fs.mkdirSync(eventsDir, { recursive: true });
  const session = new AgentSession(`tb4-single-${taskId}`, {
    cwd,
    user: null,
    autonomousPermission: true,   // background shadow — never block on prompts
    eventsFile: path.join(eventsDir, 'events.jsonl'),
    systemPrompt: SINGLE_SYSTEM,
  });

  const start = Date.now();
  let settled = false;
  return await new Promise((resolve) => {
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      const ok = !error;
      try { session.kill(); } catch {}
      resolve({ ok, ms: Date.now() - start, error });
    };
    // Hard cap: default 2h so 5 tasks x 2 modes stays within an 8-24h budget.
    const hardTimer = setTimeout(() => settle(`single timeout after ${timeoutMs}ms`),
                                 timeoutMs || 7200000);
    session.on('idle', () => {
      // turn fully drained -> the single agent stopped; small grace so any
      // final turn_result / text lands before we hand back to verification.
      setTimeout(() => settle(), 1500);
    });
    session.on('exit', () => settle('single exited early'));
    session.on('agent-event', (e) => {
      if (e && e.type === 'fatal') settle('single fatal: ' + String(e.error || e.reason || ''));
    });
    try {
      session.write(instruction);
    } catch (e) {
      settle('sdk init failed: ' + String(e.message || e));
    }
  });
}

// ── n2: TeamSession ─────────────────────────────────────────────────────────
async function n2Run(taskId, instruction, { cwd, timeoutMs } = {}) {
  if (MOCK) return mockRun();
  const { TeamSession } = requireMyco('team-session.js');
  const dir = cwd;
  fs.mkdirSync(dir, { recursive: true });
  const doneFile = path.join(dir, '._tb4_done');
  try { if (fs.existsSync(doneFile)) fs.unlinkSync(doneFile); } catch {}

  const task = buildN2Task(instruction);
  const sessionId = `tb4-n2-${taskId}-${Date.now()}`;
  const lane = new TeamSession(sessionId, {
    cwd: dir,
    user: null,
    task,
    eventsDir: path.join(dir, '_myco_'),
    rlm: false,
  });

  const start = Date.now();
  const POLL_MS = 4000;
  const GRACE_MS = Number(process.env.TB4_N2_GRACE_MS) || 15000;
  const STALL_MS = Number(process.env.TB4_N2_STALL_MS) || 220000;
  const hardTimeout = timeoutMs || 7200000;
  const hardTimerMs = Math.max(timeoutMs || 7200000, STALL_MS + 60000);

  let settled = false;
  let sawWorkerOutput = false;
  let lastContent = '';
  let lastChangeAt = 0;
  let idleSince = 0;

  return await new Promise((resolve) => {
    const readDone = () => {
      try { return fs.existsSync(doneFile) ? 'DONE' : ''; } catch { return ''; }
    };
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      clearTimeout(hardTimer);
      const ok = !error;
      const ms = Date.now() - start;
      try { lane.kill(); } catch {}
      resolve({ ok, ms, error });
    };
    const attemptResolve = () => {
      const content = readDone();
      if (content) {
        // marker present — settle once stable (workers finished writing it)
        sawWorkerOutput = true;
        if (content !== lastContent) { lastContent = content; lastChangeAt = Date.now(); }
        else if (Date.now() - lastChangeAt >= GRACE_MS) settle();
      } else {
        lastContent = '';
        lastChangeAt = 0;
        // no marker: if BOTH workers are idle (not iterating) for a grace
        // window, the team stopped — treat as done.
        let busy = false;
        try { busy = lane.isBusy(); } catch { busy = true; }
        if (!busy) {
          if (!idleSince) idleSince = Date.now();
          else if (Date.now() - idleSince >= GRACE_MS) settle();
        } else {
          idleSince = 0;
        }
      }
    };
    const poller = setInterval(attemptResolve, POLL_MS);
    const hardTimer = setTimeout(() => {
      settle(`n2 timeout after ${hardTimeout}ms (worker output: ${sawWorkerOutput ? 'yes' : 'none'})`);
    }, hardTimerMs);
    const stallTimer = setTimeout(() => {
      if (sawWorkerOutput || readDone()) return;
      settle(`n2 stalled: no worker output in ${STALL_MS}ms`);
    }, STALL_MS);

    lane.on('team-complete', () => settle());
    lane.on('team-failed', (e) => settle('n2 team failed: ' + String((e && e.reason) || '')));
    lane.on('exit', () => settle());
    lane.on('agent-event', () => { sawWorkerOutput = true; idleSince = 0; });

    try {
      lane.dispatchTask(task);
    } catch (e) {
      clearTimeout(hardTimer);
      clearTimeout(stallTimer);
      clearInterval(poller);
      try { lane.kill(); } catch {}
      resolve({ ok: false, ms: Date.now() - start, error: String(e.message || e) });
    }
  });
}

// ── public API ──────────────────────────────────────────────────────────────
// run a terminal task in `cwd` with `mode` = 'single' | 'n2'.
async function run(mode, { taskId, instruction, cwd, timeoutMs } = {}) {
  const r = mode === 'n2'
    ? await n2Run(taskId, instruction, { cwd, timeoutMs })
    : await singleRun(taskId, instruction, { cwd, timeoutMs });
  return { ok: r.ok, mode, ms: r.ms, error: r.error };
}

module.exports = { run, singleRun, n2Run, buildN2Task, SINGLE_SYSTEM, MYCO_SRC };
