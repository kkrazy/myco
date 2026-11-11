// bench/harness2/myco-runner.js — blocking CLI that Harness²'s MycoSubstrate
// spawns once per rollout batch (see CONTRACT.md §2).
//
// TWO modes:
//
//   --dry-run   Emits a fully contract-shaped result with FAKE content and a
//               short fake trajectory. Requires no myco module, no model, no
//               MYCO_SRC. This is the stub P0 promised: the Python side can
//               develop and self-test read_trajectory() against it before the
//               real runner exists.
//
//   (default)   Runs real isolated AgentSessions. NOT IMPLEMENTED YET — P1.
//               Exits 2 with an explicit message rather than pretending.
//
// stdout is EXACTLY one line of JSON (CONTRACT.md §4). Everything else goes
// to stderr, because a second stdout line would break the parser on the
// Python side.
'use strict';

const fs = require('fs');
const path = require('path');

const CONTRACT = 1;
// Matches core/spec.py's hard floor. Truncating below this fabricates defects
// (the spec's own words), so the runner never offers a smaller default.
const MIN_OBS_TRUNC = 10000;
const DEFAULT_OBS_TRUNC = 12000;
const DEFAULT_ARGS_TRUNC = 400;
const KILL_GRACE_MS = 5000;

// ─── argument parsing ───────────────────────────────────────────────────────

const USAGE = `myco-runner --task-dir <dir> --run-id <id> --out <dir> --timeout <sec> [options]

  --task-dir    <path>   task input directory (read-only)
  --harness-dir <path>   harness tree to materialise into the session
  --run-id      <id>     unique run id ([A-Za-z0-9._-]{1,64})
  --out         <path>   output root
  --timeout     <sec>    per-rollout hard timeout
  --k           <n>      rollouts to run (default 1, max 4)
  --dry-run              emit contract-shaped fake data; needs no model
  --help                 this message
`;

function fail(msg, code = 1) {
  // Errors are contract-visible too: the Python side must see a parseable
  // JSON line even on failure (CONTRACT.md §4.1).
  emitJsonThenExit({ contract: CONTRACT, run_id: null, ok: false, runs: [], error: msg }, code);
}

function parseArgs(argv) {
  const out = { k: 1, dryRun: false, timeout: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--task-dir': out.taskDir = next(); break;
      case '--harness-dir': out.harnessDir = next(); break;
      case '--run-id': out.runId = next(); break;
      case '--out': out.outDir = next(); break;
      case '--timeout': out.timeout = Number(next()); break;
      case '--k': out.k = Number(next()); break;
      case '--obs-trunc': out.obsTrunc = Number(next()); break;
      case '--args-trunc': out.argsTrunc = Number(next()); break;
      case '--mode': out.mode = next(); break;
      case '--dry-run': out.dryRun = true; break;
      case '--help': case '-h': process.stdout.write(USAGE); process.exit(0); break;
      default:
        throw new Error(`unknown argument ${a}`);
    }
  }
  return out;
}

function validate(opts) {
  if (!opts.taskDir) throw new Error('--task-dir is required');
  if (!opts.outDir) throw new Error('--out is required');
  if (!opts.runId) throw new Error('--run-id is required');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(opts.runId)) {
    throw new Error('--run-id must match ^[A-Za-z0-9._-]{1,64}$ (it goes into a path)');
  }
  if (!Number.isInteger(opts.k) || opts.k < 1 || opts.k > 4) throw new Error('--k must be 1..4');
  if (opts.timeout !== null && (!Number.isFinite(opts.timeout) || opts.timeout <= 0)) {
    throw new Error('--timeout must be a positive number of seconds');
  }
  if (opts.obsTrunc !== undefined && opts.obsTrunc < MIN_OBS_TRUNC) {
    throw new Error(
      `--obs-trunc ${opts.obsTrunc} is in the range that fabricates defects ` +
      `(harness2 core/spec.py rejects < ${MIN_OBS_TRUNC})`);
  }
  if (!fs.existsSync(opts.taskDir) || !fs.statSync(opts.taskDir).isDirectory()) {
    throw new Error(`--task-dir does not exist or is not a directory: ${opts.taskDir}`);
  }
  if (opts.harnessDir && !fs.existsSync(opts.harnessDir)) {
    throw new Error(`--harness-dir does not exist: ${opts.harnessDir}`);
  }
}

// ─── output helpers ─────────────────────────────────────────────────────────

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Write the result line and exit only once it has actually flushed.
//
// process.exit() immediately after a stdout write TRUNCATES on a pipe:
// verified on the test host, a 900 KB line came out as exactly 65536 bytes
// (the pipe buffer). The Python side always reads this over a pipe, so an
// early exit would hand it invalid JSON with no diagnostic — the sweep dies
// with an unexplainable parse error. The write callback fires after the flush.
function emitJsonThenExit(obj, code) {
  const line = JSON.stringify(obj) + '\n';
  let exited = false;
  const done = () => { if (!exited) { exited = true; process.exit(code); } };
  process.stdout.write(line, done);
  // If the reader closed the pipe the callback may never fire; do not hang a
  // rollout batch on a dead parent.
  setTimeout(done, 5000).unref();
}

function log(msg) {
  process.stderr.write(msg + '\n');
}

function progress(fields) {
  // CONTRACT.md §5 — the only stderr format mycod parses.
  log('[progress] ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' '));
}

// Truncation marker must be byte-identical to harness2/substrate/opencode.py's
// _TRUNC_FMT, otherwise a Python-side diff of the two renderers would show a
// spurious difference forever.
function clip(s, n) {
  const str = (s === null || s === undefined) ? '' : String(s).replace(/\x00/g, '');
  if (n <= 0 || str.length <= n) return str;
  return str.slice(0, n) + `…(+${str.length - n} chars — render truncation)`;
}

// ─── dry-run ────────────────────────────────────────────────────────────────

// Writes a run directory whose SHAPE is exactly CONTRACT.md §6.1. Content is
// obviously fake, but every field a Python parser reads is present and
// correctly typed — that is the whole point of the stub.
function dryRun(opts) {
  const started = new Date();
  const runs = [];

  for (let i = 1; i <= opts.k; i++) {
    const runId = `${opts.runId}-${i}`;
    const runDir = path.join(opts.outDir, runId);
    const wsDir = path.join(runDir, 'workspace');

    progress({ stage: 'materialise', run: opts.runId, done: `${i}/${opts.k}` });
    progress({ stage: 'rollout', run: runId, state: 'start' });

    fs.mkdirSync(wsDir, { recursive: true });
    // A deliverable so §7 rule 2 reports delivered:true, letting the Python
    // side exercise the success path as well as the parse path.
    fs.writeFileSync(path.join(wsDir, 'answer.txt'), 'DRY RUN — no model was called.\n', 'utf8');

    const trajectory = [
      '[ACTION] Bash({"command":"cat task.md"})',
      '[OBSERVATION] DRY RUN — synthetic tool output so read_trajectory() has ' +
        'an [ACTION] and an [OBSERVATION] to parse.',
      '[ASSISTANT] DRY RUN — the task is reported complete.',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(runDir, 'trajectory.txt'), trajectory, 'utf8');

    // events.jsonl mirrors the real SDK event shape closely enough that a
    // future renderer can be tested against it without a live session.
    const events = [
      { type: 'system', subtype: 'init', ts: started.toISOString() },
      { type: 'assistant', text: 'DRY RUN — no model was called.', ts: started.toISOString() },
      { type: 'result', subtype: 'success', ts: started.toISOString() },
    ];
    fs.writeFileSync(
      path.join(runDir, 'events.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const finished = new Date();
    const wall = (finished - started) / 1000;
    const meta = {
      contract: CONTRACT,
      run_id: runId,
      harness_dir: opts.harnessDir ? path.resolve(opts.harnessDir) : null,
      task_dir: path.resolve(opts.taskDir),
      cwd: path.resolve(wsDir),
      model: 'DRY-RUN',
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      wall_s: Number(wall.toFixed(3)),
      timeoutHit: false,
      exitCode: 0,
      nodeVersion: process.version,
      dryRun: true,
    };
    fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(runDir, 'runner.log'), '[dry-run] no model was called\n', 'utf8');

    progress({ stage: 'rollout', run: runId, state: 'done', ok: 'true', wall: wall.toFixed(1) + 's' });

    runs.push({
      run_id: runId,
      run_dir: path.resolve(runDir),
      ok: true,
      delivered: true,
      cost_usd: 0,          // dry run genuinely spends nothing; 0 is honest here
      wall_s: Number(wall.toFixed(3)),
      turns: 1,
      error: null,
    });
  }

  progress({ stage: 'done', run: opts.runId, state: 'ok', dryRun: 'true' });
  emitJson({
    contract: CONTRACT,
    run_id: opts.runId,
    harness_dir: opts.harnessDir ? path.resolve(opts.harnessDir) : null,
    task_dir: path.resolve(opts.taskDir),
    ok: true,
    k: opts.k,
    runs,
    error: null,
  });
}

// ─── real mode (P1) ─────────────────────────────────────────────────────────

// Read the task prompt the agent is given. A task dir SHOULD carry task.md;
// anything else is a benchmark that forgot to, and guessing silently would
// make every rollout a no-op with a plausible-looking trajectory.
function readTaskPrompt(taskDir) {
  for (const name of ['task.md', 'TASK.md', 'prompt.md']) {
    const p = path.join(taskDir, name);
    if (fs.existsSync(p)) {
      const txt = fs.readFileSync(p, 'utf8').trim();
      if (txt) return txt;
    }
  }
  throw new Error(`no task prompt in ${taskDir} (expected task.md, TASK.md or prompt.md)`);
}

// Run `--k` rollouts. Concurrency is capped at PHASE_WIDTH: each rollout is a
// full AgentSession in THIS process, so the cap is about memory and gateway
// rate limits, not about correctness.
const PHASE_WIDTH = 2;

async function realRun(opts) {
  const engine = require('./lib/engine');
  const transcript = require('./lib/transcript');

  let taskPrompt;
  try {
    engine.resolveMycoSrc();                  // throws with the fix instruction
    taskPrompt = readTaskPrompt(opts.taskDir);
  } catch (e) {
    // MYCO_SRC problems are environment errors (exit 1); a task dir missing a
    // prompt is a caller error, also exit 1.
    fail(e.message, 1);
    return;
  }

  const obsTrunc = opts.obsTrunc !== undefined ? opts.obsTrunc : DEFAULT_OBS_TRUNC;
  const argsTrunc = opts.argsTrunc !== undefined ? opts.argsTrunc : DEFAULT_ARGS_TRUNC;
  // 5h default, matching HARNESS2_MYCO_ROLLOUT_TIMEOUT's default in
  // harness-runner.js and the Python adapter: the sweep's wall-clock cap is
  // derived from this value, so all three must agree. A real codec task used
  // the full hour in three separate rollouts and was still making progress.
  const timeoutSec = opts.timeout !== null ? opts.timeout : 18000;

  const indices = [];
  for (let i = 1; i <= opts.k; i++) indices.push(i);
  const results = new Array(opts.k);

  async function runOne(i) {
    const runId = `${opts.runId}-${i}`;
    const runDir = path.join(opts.outDir, runId);
    const wsDir = path.join(runDir, 'workspace');
    const eventsFile = path.join(runDir, 'events.jsonl');
    const started = new Date();

    // A re-run reuses the run id, hence this directory. `mkdirSync(recursive)`
    // does not clear it, so the previous attempt's workspace survived — with
    // its sol/ already in place, `isDelivered` returns true before the agent
    // does anything, and the sweep measures the OLD code as the new baseline.
    // Observed: sw-20261031-163112 left sol/ + REPORT.md here, and re-running
    // with the same tag would have inherited them.
    // Guard the delete: runDir must be strictly inside outDir.
    const relToOut = path.relative(opts.outDir, runDir);
    if (relToOut && !relToOut.startsWith('..') && !path.isAbsolute(relToOut)) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
    fs.mkdirSync(wsDir, { recursive: true });
    progress({ stage: 'materialise', run: runId });

    let mat = { written: [], unmapped: [] };
    let taskFiles = [];
    let outcome;
    try {
      taskFiles = engine.materialiseTask(opts.taskDir, wsDir);
      mat = engine.materialiseHarness(opts.harnessDir, wsDir);
      for (const u of mat.unmapped) {
        // A component the tuner produced but myco cannot host is a finding.
        log(`[warn] run=${runId} harness component has no myco slot: ${u}`);
      }
      progress({ stage: 'rollout', run: runId, state: 'start' });
      const n2Mode = (opts.mode || '').toLowerCase() === 'n2';
      if (n2Mode) {
        const n2Components = engine.readN2Components(opts.harnessDir);
        outcome = await engine.runRolloutN2({
          runId,
          cwd: wsDir,
          taskPrompt,
          timeoutSec,
          eventsFile,
          n2Components,
          onProgress: (p) => progress({ stage: 'rollout', run: runId, ...p }),
        });
      } else {
        outcome = await engine.runRollout({
          runId,
          cwd: wsDir,
          taskPrompt,
          timeoutSec,
          eventsFile,
          onProgress: (p) => progress({ stage: 'rollout', run: runId, ...p }),
        });
      }
    } catch (e) {
      outcome = {
        ok: false, delivered: false, turns: 0, toolCalls: 0, cost_usd: null,
        error: `runner error: ${e.message}`, timeoutHit: false,
        model: null, sdkSessionId: null,
        wall_s: Number(((Date.now() - started.getTime()) / 1000).toFixed(3)),
      };
    }

    // Render the trajectory from whatever the session managed to journal —
    // even a crashed rollout usually has the steps leading up to the crash,
    // and that is exactly the evidence an improvement session needs.
    //
    // D2: n2 mode writes per-worker event files (events-worker-A.jsonl /
    // events-worker-B.jsonl) plus the shared board journal (board.jsonl) via
    // TeamSession. The single-agent events.jsonl is never written, so the
    // single-agent renderer returns an error string for every n2 run.
    // mergeTeamEvents interleaves all three by timestamp with worker= tags,
    // so cross-worker causality and the coordination trail stay readable.
    let rendered;
    const n2Mode = (opts.mode || '').toLowerCase() === 'n2';
    try {
      if (n2Mode) {
        rendered = transcript.mergeTeamEvents(
          [
            { file: path.join(runDir, 'events-worker-A.jsonl'), worker: 'worker-A' },
            { file: path.join(runDir, 'events-worker-B.jsonl'), worker: 'worker-B' },
          ],
          path.join(runDir, 'board.jsonl'),
          { obsTrunc, argsTrunc }
        );
      } else {
        rendered = transcript.renderEventsFile(eventsFile, { obsTrunc, argsTrunc });
      }
    } catch (e) {
      rendered = `(failed to render trajectory: ${e.message})`;
    }
    fs.writeFileSync(path.join(runDir, 'trajectory.txt'), rendered + '\n', 'utf8');

    // The `turns` counter alone is the wrong gate. It counts turn_result
    // events, which only fire when the agent closes an iteration on its own —
    // a rollout killed at its timeout reaches zero turns while having done
    // real work (the observed case: 51 tool calls and edited files, recorded
    // as delivered:false, which dropped every candidate from the selection
    // pool and left the sweep with "no candidate produced an artifact").
    // A tool call is the durable proof of work, so either counter qualifies;
    // isDelivered then decides from the workspace itself whether the work
    // amounts to a deliverable.
    // A rollout that reported success has done work by definition, even when
    // no per-turn result was journalled (n2 exits through team-complete).
    const worked = outcome.ok || outcome.turns > 0 || outcome.toolCalls > 0;
    const delivered = worked
      ? engine.isDelivered(opts.taskDir, wsDir, taskFiles)
      : false;

    const finished = new Date();
    fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({
      contract: CONTRACT,
      run_id: runId,
      harness_dir: opts.harnessDir ? path.resolve(opts.harnessDir) : null,
      task_dir: path.resolve(opts.taskDir),
      cwd: path.resolve(wsDir),
      model: outcome.model,
      sdkSessionId: outcome.sdkSessionId,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      wall_s: outcome.wall_s,
      timeoutHit: outcome.timeoutHit,
      turns: outcome.turns,
      toolCalls: outcome.toolCalls || 0,
      exitCode: outcome.ok ? 0 : 1,
      nodeVersion: process.version,
      harnessWritten: mat.written,
      harnessUnmapped: mat.unmapped,
    }, null, 2) + '\n', 'utf8');

    progress({
      stage: 'rollout', run: runId, state: 'done',
      ok: String(outcome.ok), wall: outcome.wall_s + 's',
    });

    results[i - 1] = {
      run_id: runId,
      run_dir: path.resolve(runDir),
      ok: outcome.ok,
      delivered,
      cost_usd: outcome.cost_usd,
      wall_s: outcome.wall_s,
      turns: outcome.turns,
      toolCalls: outcome.toolCalls || 0,
      error: outcome.error,
    };
  }

  // Bounded-concurrency pool. Promise.all over all k at once would ignore
  // PHASE_WIDTH and start every session simultaneously.
  const queue = indices.slice();
  const workers = [];
  for (let w = 0; w < Math.min(PHASE_WIDTH, opts.k); w++) {
    workers.push((async () => {
      for (;;) {
        const i = queue.shift();
        if (i === undefined) return;
        await runOne(i);
      }
    })());
  }
  await Promise.all(workers);

  const anyOk = results.some((r) => r && r.ok);
  progress({ stage: 'done', run: opts.runId, state: anyOk ? 'ok' : 'failed' });
  // Exit explicitly: a finished AgentSession can leave SDK handles open, so
  // the event loop would not drain on its own. emitJsonThenExit flushes first
  // (see its header — a bare process.exit truncates a piped write).
  emitJsonThenExit({
    contract: CONTRACT,
    run_id: opts.runId,
    harness_dir: opts.harnessDir ? path.resolve(opts.harnessDir) : null,
    task_dir: path.resolve(opts.taskDir),
    // `ok` means "the runner completed the batch", not "the task succeeded".
    // Per-rollout success is runs[].ok (CONTRACT.md §4.1).
    ok: true,
    k: opts.k,
    runs: results.filter(Boolean),
    error: null,
  }, 0);
}

// ─── main ───────────────────────────────────────────────────────────────────

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    validate(opts);
  } catch (e) {
    fail(e.message, 1);
    return;
  }
  fs.mkdirSync(opts.outDir, { recursive: true });
  if (opts.dryRun) { dryRun(opts); return; }
  // realRun is async (it awaits live sessions). An unhandled rejection here
  // would exit 0 with no JSON on stdout, which the Python side would read as
  // a parse error with no explanation — so catch and report in-contract.
  realRun(opts).then(
    // realRun emits its own result and exits through emitJsonThenExit, so the
    // success arm is a no-op. Exiting here instead would race the stdout flush.
    () => {},
    (e) => { fail(`runner error: ${e && e.message ? e.message : e}`, 2); });
}

if (require.main === module) main();

module.exports = { CONTRACT, MIN_OBS_TRUNC, DEFAULT_OBS_TRUNC, DEFAULT_ARGS_TRUNC,
  KILL_GRACE_MS, clip, parseArgs, validate, readTaskPrompt, PHASE_WIDTH,
  emitJson, emitJsonThenExit };
