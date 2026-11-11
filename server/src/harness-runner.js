// server/src/harness-runner.js — P3.
//
// Starts a Harness² sweep as a DETACHED CHILD PROCESS of mycod and tracks it.
//
// Why a child process and not an in-process require:
//   one sweep is dozens of model calls over minutes to hours. mycod is a single
//   Node process serving every attached client; running a sweep inside it would
//   freeze every session pane. The sweep is also Python, so a process boundary
//   is the only option anyway.
//
// Why detached + pidfile:
//   `detached` lets the sweep outlive a mycod restart (a sweep that has already
//   spent money should not die because the web server bounced), but that is
//   exactly what makes an ORPHAN possible: mycod dies, the sweep keeps burning
//   the gateway with nobody watching. So every sweep gets a pidfile under
//   _harness_/sweeps/, and `sweepOrphans()` runs at boot to kill anything left
//   behind. R1 in the plan's risk table is this exact failure.
//
// State lives on disk, not in memory: `_harness_/sweeps/<id>/` holds the pidfile,
// the result JSON, and a status file the pane re-reads after a restart. In-memory
// state would be lost on the restart that orphans need to survive.
//
// Contract with the UI (slashcmds.js): reply() strings, plus getStatus() for reads.

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ASSISTANT_USER = 'claude';

// Per-rollout timeout the harness² adapter enforces (MycoAdapter.timeout).
// Kept here as well because the sweep's wall-clock cap has to be derived FROM
// it — the two must move together or the supervisor kills a sweep that is
// still legitimately inside its own rollout budget.
//
// 1800s was too tight, then 3600s still cut real work off: a codec-sized task
// hit the hour mark three times in one sweep (base1/dom1 at 3600.06s, inv1 at
// 2961s) with 138-251 tool calls apiece — it was making progress, not stuck.
// Five hours matches what the workload actually asks for. Override per sweep
// with HARNESS2_MYCO_ROLLOUT_TIMEOUT (seconds).
const ROLLOUT_TIMEOUT_S = Number(process.env.HARNESS2_MYCO_ROLLOUT_TIMEOUT) || 18000;
// One sweep runs 4 rollout labels (base, inv, dom, agg) × k rollouts each,
// plus ~3 improvement/proposer sessions that are model calls with no rollout
// bound of their own.
const ROLLOUTS_PER_LABEL = 4;
const IMPROVEMENT_BUDGET_S = 60 * 60;

// A sweep's wall-clock cap. The old flat 2 hours was SHORTER than the sweep's
// own rollout budget: 4 labels × 1800s = 7200s is exactly the cap, so a sweep
// that saturated even one rollout had no room left for the improvement
// sessions and was killed mid-flight with result.json never written.
// Derive it from the ACTUAL per-rollout timeout this sweep runs with, so a
// caller who raises the rollout bound via /harness run --timeout gets a cap
// that still covers 4 × k rollouts. An explicit wallCapS or
// MYCO_HARNESS_WALL_CAP_S still wins.
function defaultWallCapS(k = 1, rolloutTimeoutS = ROLLOUT_TIMEOUT_S) {
  const kk = Math.max(1, Number(k) || 1);
  const perRollout = Math.max(1, Number(rolloutTimeoutS) || ROLLOUT_TIMEOUT_S);
  const rollouts = ROLLOUTS_PER_LABEL * kk * perRollout;
  return rollouts + IMPROVEMENT_BUDGET_S;
}

// How often the supervisor checks the child and appends progress to the pane.
const POLL_MS = 5000;

// ── on-disk layout ─────────────────────────────────────────────────────────

function sweepsRoot(cwd) {
  return path.join(cwd, '_harness_', 'sweeps');
}

function sweepDir(cwd, id) {
  return path.join(sweepsRoot(cwd), id);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// Sweep ids are time-ordered so a directory listing sorts chronologically.
function newSweepId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `sw-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

// ── process liveness ───────────────────────────────────────────────────────

// `process.kill(pid, 0)` throws ESRCH for a dead pid and EPERM for one we may
// not signal — EPERM means it exists, so it counts as alive.
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ── sweep command resolution ───────────────────────────────────────────────

// Which interpreter and args run a sweep.
//
// `HARNESS2_SWEEP_CMD` overrides the whole argv (space-separated). That exists
// for two real reasons: the sweep is Python and may live outside the image
// during development, and the myco *bench adapter* it needs is P5 work — until
// then there is no `--bench myco` to pass, so the default argv cannot run. An
// operator can point this at a fixture sweep (see the tests) or at a wrapper.
function sweepArgv(opts) {
  const override = (process.env.HARNESS2_SWEEP_CMD || '').trim();
  if (override) {
    // Two accepted forms. A JSON array is exact; a plain string is split with
    // quote awareness because a naive whitespace split breaks any path with a
    // space in it — "C:\Program Files\nodejs\node.exe" would arrive as the
    // interpreter "C:\Program". That failure is invisible on Linux (where node
    // lives at /usr/bin/node) and fatal on Windows, which is how it was found.
    let parts;
    if (override.startsWith('[')) {
      try {
        const parsed = JSON.parse(override);
        if (!Array.isArray(parsed) || !parsed.length) throw new Error('empty array');
        parts = parsed.map(String);
      } catch (e) {
        throw new Error(`HARNESS2_SWEEP_CMD is not a valid JSON array: ${e.message}`);
      }
    } else {
      parts = splitQuoted(override);
    }
    return parts.map((part) => part.replace('{task}', opts.task));
  }
  // Inside the image: PYTHONPATH=/app/vendor/harness2 makes the module resolve.
  return [
    process.env.HARNESS2_PYTHON || 'python3',
    '-m', 'harness2.cli.run_sweep',
    '--bench', 'myco',
    '--substrate', 'myco',
    '--k', String(opts.k),
    '--mode', opts.mode,
  ];
}

// Split a command string on whitespace, honouring single/double quotes so a path
// with spaces survives. Not a shell: no expansion, no operators — the value is
// argv, and anything that looks like shell syntax is passed through literally.
function splitQuoted(str) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of str) {
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (quote) throw new Error(`HARNESS2_SWEEP_CMD has an unclosed ${quote} quote`);
  if (has) out.push(cur);
  return out;
}

// The sweep inherits mycod's environment, which is what makes a rollout
// authenticated: the entrypoint loaded ANTHROPIC_* into PID 1, so any process
// mycod spawns has them. A `docker exec` does not — that pitfall cost a full
// debugging cycle during P1 and is why this file never builds its own env from
// scratch.
function sweepEnv(opts = {}) {
  const env = { ...process.env };
  // The myco bench adapter needs to know WHICH project's plan.json is the task
  // source, and the answer is the session's project dir — not the process cwd,
  // which is the repo root. Passing it here is what makes `/harness run` mean
  // "tune against THIS session's backlog".
  if (opts.cwd) {
    env.HARNESS2_MYCO_PROJECT = opts.cwd;
    // The adapter builds a MycoSubstrate, which resolves the runner through the
    // same variables the module itself uses.
    if (!env.HARNESS2_MYCO_RUNNER) {
      env.HARNESS2_MYCO_RUNNER = path.join('/app', 'bench', 'harness2', 'myco-runner.js');
    }
    if (!env.MYCO_SRC) env.MYCO_SRC = path.join('/app', 'server', 'src');
    // P5+: pass the inline task text so any project dir works without a
    // pre-built _myco_/plan.json. When set, the adapter synthesizes a single
    // task item from this text instead of reading plan.json.
    if (opts.task) env.HARNESS2_MYCO_TASK = opts.task;
    // n2 rollout mode: pass the flag to substrate/myco.py which forwards it
    // to myco-runner.js as --mode n2. Default is the standard single-agent mode.
    if (opts.rolloutMode === 'n2') env.HARNESS2_MYCO_ROLLOUT_MODE = 'n2';
    // Per-session isolation (see sessionScope): without these two, every
    // session's sweep shares the namespace `myco-myco-agg1` and one runs tree,
    // so concurrent users overwrite each other's rollouts and selection.
    env.HARNESS2_RUNS_DIR = runsRootFor(opts.cwd);
    env.HARNESS2_SWEEP_TAG = sweepTagFor(opts.cwd);
    // Per-sweep rollout timeout from `/harness run --timeout`. Both sides read
    // this variable (harness-runner derives the wall cap from it, the Python
    // adapter bounds each rollout by it), so setting it here keeps them in
    // step for a single sweep without touching the deployment default.
    if (opts.rolloutTimeoutS) {
      env.HARNESS2_MYCO_ROLLOUT_TIMEOUT = String(Math.max(60, Math.floor(opts.rolloutTimeoutS)));
    }
  }
  // `run_sweep` refuses to start without these, before any money is spent:
  // validate_models() wants HARNESS2_SOLVER_MODEL (a provider/id pair, because the
  // validator was written for OpenCode) and require_ready(judge=True) wants
  // HARNESS2_JUDGE_MODEL. The myco adapter never judges — its score() is None by
  // design — but the judge model still enters the namespace identity, so it has to
  // be a real value. Both default to the model myco itself is serving, which is the
  // only model this host actually has. A caller that knows better overrides them.
  //
  // A4 fix (second half): do NOT prefix with `local/` when ANTHROPIC_MODEL already
  // contains a `/` (provider-prefixed form like `glm53/GLM-5.3`). Prepending `local/`
  // to an already-slashed value produces `local/glm53/GLM-5.3`, which is a different
  // shape that nothing in the Python side recognises, making construction fail on every
  // gateway host. Pass the model id verbatim in that case; `claude_local` now accepts
  // any form after the spec.py guard was relaxed.
  const model = env.ANTHROPIC_MODEL || 'default';
  const solverModel = model.includes('/') ? model : `local/${model}`;
  if (!env.HARNESS2_SOLVER_MODEL) env.HARNESS2_SOLVER_MODEL = solverModel;
  if (!env.HARNESS2_JUDGE_MODEL)  env.HARNESS2_JUDGE_MODEL  = solverModel;

  // P8: if a harness has been installed from the market into this session, pass its
  // directory as the base harness for the next sweep. This lets tuning start from a
  // known-good baseline rather than the bare defaults.
  // Only set if not already overridden by the caller.
  if (!env.HARNESS2_MYCO_BASE_HARNESS && opts.cwd) {
    const baseHarness = _findInstalledBaseHarness(opts.cwd);
    if (baseHarness) env.HARNESS2_MYCO_BASE_HARNESS = baseHarness;
  }

  return env;
}

// ── progress parsing ───────────────────────────────────────────────────────

// Lines the runner/loop write to stderr, per CONTRACT.md §5, plus the sweep's
// own free-form lines. Parsing is deliberately loose: a progress line that does
// not match is ignored rather than treated as an error, because the sweep's
// stderr is also where tracebacks go and a broken progress line must not stop
// the sweep from being reported.
function parseProgress(line) {
  const m = /^\[progress\]\s+(.*)$/.exec(line.trim());
  if (!m) return null;
  const fields = {};
  for (const part of m[1].split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return Object.keys(fields).length ? fields : null;
}

// ── per-session isolation ──────────────────────────────────────────────────
//
// harness² names everything from (benchmark, substrate, mode, k) — so EVERY
// session's sweep is `myco-myco-agg1`, and every session's rollouts, harness
// trees and selection.json land in one shared tree under the image
// (/app/vendor/harness2/runs). Two people running `/harness run` at once
// overwrite each other's workspaces, and a later sweep tunes against the
// earlier one's trajectories — even though neither consented to share.
//
// Fix: give each session its own runs root AND its own namespace tag. The
// runs root moves to $MYCO_DATA (bind-mounted, survives a container swap)
// instead of the image layer, so results also stop vanishing on redeploy.
function _sanitizeScope(s) {
  return String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'x';
}

// Session scopes derive from the workspace layout /wks/<user>/<session-id>/…,
// which sessions.js guarantees for every session created since 2026-05-15.
// A cwd outside that shape still gets a stable (if coarser) scope rather than
// silently sharing the global tree.
function sessionScope(cwd) {
  // Split on BOTH separators, not path.sep: a POSIX cwd string is inspected on
  // a Windows host (and vice versa) in tests and in cross-mounted setups, and
  // path.sep then matches nothing — the whole path collapsed into one segment
  // and every session fell back to the same `default` scope.
  const parts = String(cwd || '').split(/[\\/]+/).filter(Boolean);
  const wksAt = parts.indexOf('wks');
  if (wksAt >= 0 && parts.length > wksAt + 2) {
    return { user: _sanitizeScope(parts[wksAt + 1]), session: _sanitizeScope(parts[wksAt + 2]) };
  }
  return { user: 'default', session: _sanitizeScope(parts[parts.length - 1] || 'shared') };
}

// Where this session's harness² state lives. One directory per (user, session)
// under the bind-mounted data root.
function runsRootFor(cwd) {
  const base = process.env.MYCO_DATA || '/data';
  const { user, session } = sessionScope(cwd);
  return path.join(base, 'harness2-runs', user, session);
}

// The namespace tag. validate_tag() rejects a tag starting with `s<digits>`
// (it would spell a seed segment), and real logins here look like
// `s00791175` — so the tag never starts with the raw user name.
//
// LENGTH IS A CORRECTNESS CONCERN, not cosmetics: the tag becomes part of the
// namespace, the namespace becomes part of every run id, and myco-runner.js
// rejects a run id over 64 chars (`^[A-Za-z0-9._-]{1,64}$`) because the id is a
// path. Session ids are `myco-<user>-<8 hex>`, so the naive tag produced
//
//   myco-myco-agg1-sess-t59900502-myco-t59900502-9cfbc953-inline-task-base1  (71)
//
// and every rollout died in argv parsing before the model was called. A full
// sweep ran ~7 minutes burning proposer calls against empty trajectories.
//
// Use the session's short suffix (the 8-hex discriminator is what makes it
// unique; the `myco-<user>-` prefix is repeated in the namespace already), and
// cap the user segment so an unusual login cannot push it back over the limit.
function sweepTagFor(cwd) {
  const { user, session } = sessionScope(cwd);
  const suffix = String(session || '').split('-').pop().slice(0, 12) || 'x';
  return `sess-${String(user).slice(0, 24)}-${suffix}`;
}

function _globalRunsRoot() {
  // Pre-isolation layout, still used when no cwd is available.
  return path.resolve(__dirname, '..', '..', 'vendor', 'harness2', 'runs');
}

// ── the runner ─────────────────────────────────────────────────────────────

// One live sweep per session directory. The map is an optimisation only: the
// pidfile on disk is the authority, so a restart does not lose track.
const LIVE = new Map();

function statusFile(cwd, id) { return path.join(sweepDir(cwd, id), 'status.json'); }
function pidFile(cwd, id) { return path.join(sweepDir(cwd, id), 'run.pid'); }

function readStatus(cwd, id) {
  return readJson(statusFile(cwd, id), null);
}

function updateStatus(cwd, id, patch) {
  const prior = readStatus(cwd, id) || {};
  const next = { ...prior, ...patch, updatedAt: new Date().toISOString() };
  writeJson(statusFile(cwd, id), next);
  return next;
}

const TERMINAL = new Set(['success', 'failed', 'cancelled', 'timeout']);

function isTerminal(status) {
  return TERMINAL.has(status);
}

// Start a sweep. Returns { id, reused } — `reused` means one was already
// running in this directory and no second one was started.
//
// `rolloutTimeoutS` bounds ONE rollout (and therefore the whole sweep's cap).
// Omitted → HARNESS2_MYCO_ROLLOUT_TIMEOUT or the module default.
function startSweep({ cwd, task, k = 1, mode = 'parallel', wallCapS, onProgress, rolloutMode, rolloutTimeoutS }) {
  if (!cwd) throw new Error('startSweep needs a cwd (the session project dir)');
  const live = LIVE.get(cwd);
  if (live && isAlive(live.pid) && !isTerminal(live.status)) {
    return { id: live.id, reused: true };
  }

  const id = newSweepId();
  const dir = sweepDir(cwd, id);
  fs.mkdirSync(dir, { recursive: true });

  const argv = sweepArgv({ task, k, mode });
  const [bin, ...args] = argv;
  const logFile = path.join(dir, 'sweep.log');
  const log = fs.openSync(logFile, 'a');

  const child = spawn(bin, args, {
    cwd,
    env: sweepEnv({ cwd, task, rolloutMode, rolloutTimeoutS }),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Allows mycod to exit without waiting on the sweep; the pidfile is what keeps
  // it findable afterwards.
  child.unref();

  if (child.pid) fs.writeFileSync(pidFile(cwd, id), String(child.pid) + '\n', 'utf8');

  const startedAt = Date.now();
  // Derived from k and the per-rollout timeout so the cap can never be
  // smaller than the rollout work the sweep is entitled to do. An explicit
  // wallCapS argument or MYCO_HARNESS_WALL_CAP_S still wins.
  const capS = wallCapS
    || (Number(process.env.MYCO_HARNESS_WALL_CAP_S) || 0)
    || defaultWallCapS(k);
  let lastReported = '';
  let pendingTail = '';

  updateStatus(cwd, id, {
    id,
    status: 'running',
    task,
    k,
    mode,
    pid: child.pid || null,
    startedAt: new Date().toISOString(),
    wallCapS: capS,
    argv,
    cwd,
  });

  const handle = { id, pid: child.pid, status: 'running', cwd };
  LIVE.set(cwd, handle);

  function appendLog(chunk) {
    try { fs.writeSync(log, chunk); } catch { /* disk full or closed */ }
  }

  // stderr carries [progress] lines; stdout carries the sweep's own JSON, which
  // is not needed here (the result file is read from disk) but is logged so a
  // failure is diagnosable.
  //
  // A1 fix: Python run_sweep.py writes `sweep <namespace>: …` to stdout on the
  // very first print before rollouts start. Parse that line to capture the
  // namespace and persist it into status.json immediately — findSelection() in
  // harness-result.js needs it to locate selection.json under the runs tree.
  let stdoutBuf = '';
  let namespaceCaptured = false;
  child.stdout.on('data', (buf) => {
    const text = buf.toString();
    appendLog(text);
    if (!namespaceCaptured) {
      stdoutBuf += text;
      // Format: `sweep <namespace>: <N> domain(s) in parallel…`
      const m = /^sweep\s+([^\s:]+):/m.exec(stdoutBuf);
      if (m) {
        namespaceCaptured = true;
        updateStatus(cwd, id, { namespace: m[1].trim() });
      }
    }
  });
  child.stderr.on('data', (buf) => {
    const text = buf.toString();
    appendLog(text);
    pendingTail = (pendingTail + text).slice(-8192);
    for (const line of text.split(/\r?\n/)) {
      const p = parseProgress(line);
      if (!p) continue;
      const summary = `${p.stage || '?'} ${p.run || ''}`.trim();
      // Collapse repeats: a sweep emits one line per tool call and forwarding
      // each would flood the pane (R6 in the plan's risk table).
      if (summary === lastReported) continue;
      lastReported = summary;
      if (typeof onProgress === 'function') onProgress(p);
    }
  });

  const finish = (status, extra = {}) => {
    if (isTerminal(handle.status)) return;      // cancel and timeout can race
    handle.status = status;
    const patch = {
      status,
      finishedAt: new Date().toISOString(),
      wallS: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      ...extra,
    };
    if (status !== 'success' && pendingTail) {
      // The last 2 KB of stderr is usually the traceback; without it the pane
      // says "failed" and nobody can tell why.
      patch.stderrTail = pendingTail.slice(-2000);
    }
    updateStatus(cwd, id, patch);
    // What the diff page actually needs is a SELECTION, not result.json:
    // run_sweep never writes result.json in the myco adapter path, so the old
    // check reported resultPresent:false on every sweep, including successful
    // ones. Report whether a selection.json exists for this sweep's namespace.
    patch.resultPresent = _selectionExists(cwd, id);
    writeJson(statusFile(cwd, id), { ...readStatus(cwd, id), ...patch });
    try { fs.closeSync(log); } catch {}
    LIVE.delete(cwd);
    if (typeof onProgress === 'function') onProgress({ stage: 'done', status });
  };

  child.on('error', (err) => {
    appendLog(`spawn error: ${err.message}\n`);
    finish('failed', { error: `cannot start sweep: ${err.message}` });
  });
  child.on('exit', (code, signal) => {
    if (handle.status === 'cancelled') { finish('cancelled'); return; }
    if (handle.status === 'timeout') { finish('timeout'); return; }
    if (code === 0) finish('success', { exitCode: 0 });
    else finish('failed', { exitCode: code, signal: signal || null });
  });

  // Wall-clock supervisor. `detached` means nothing else will stop a sweep that
  // has wedged, and a wedged sweep holds the gateway budget.
  const timer = setInterval(() => {
    if (isTerminal(handle.status)) { clearInterval(timer); return; }
    if (Date.now() - startedAt > capS * 1000) {
      // Do NOT set handle.status here. finish() opens with an isTerminal guard
      // so the exit handler cannot overwrite a cancel; pre-setting the status
      // would make that guard swallow the timeout and leave the record stuck on
      // "running" — a spinner that never resolves, over a process that is gone.
      killGroup(cwd, id, child.pid);
      finish('timeout', { error: `sweep exceeded its ${capS}s wall-clock cap` });
    }
  }, POLL_MS);
  timer.unref();

  return { id, reused: false, pid: child.pid };
}

// Kill the sweep and everything it started. `detached` puts the child in its own
// process group, so the NEGATIVE pid reaches the runner processes it spawned —
// killing only the Python parent would leave rollouts running.
function killGroup(cwd, id, pid) {
  const target = pid || Number((readFileSafe(pidFile(cwd, id)) || '').trim());
  if (!Number.isInteger(target) || target <= 0) return false;
  try {
    process.kill(-target, 'SIGTERM');
  } catch {
    try { process.kill(target, 'SIGTERM'); } catch { return false; }
  }
  // Escalate if it ignores SIGTERM. A sweep mid-model-call can take a moment.
  const escalate = setTimeout(() => {
    if (!isAlive(target)) return;
    try { process.kill(-target, 'SIGKILL'); } catch {
      try { process.kill(target, 'SIGKILL'); } catch {}
    }
  }, 5000);
  escalate.unref();
  return true;
}

function readFileSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function cancelSweep(cwd) {
  const live = LIVE.get(cwd);
  const id = live ? live.id : latestSweepId(cwd, { runningOnly: true });
  if (!id) return { cancelled: false, reason: 'no running sweep' };
  const st = readStatus(cwd, id);
  if (st && isTerminal(st.status)) return { cancelled: false, reason: `already ${st.status}` };
  if (live) live.status = 'cancelled';
  const ok = killGroup(cwd, id, st && st.pid);
  if (ok) updateStatus(cwd, id, { status: 'cancelled', finishedAt: new Date().toISOString() });
  return { cancelled: ok, id };
}

// Newest sweep id, or null. `runningOnly` also checks the pid is alive, so a
// sweep whose mycod died is not reported as running.
function latestSweepId(cwd, { runningOnly = false } = {}) {
  const root = sweepsRoot(cwd);
  let names;
  try { names = fs.readdirSync(root); } catch { return null; }
  const ids = names.filter((n) => n.startsWith('sw-')).sort().reverse();
  for (const id of ids) {
    if (!runningOnly) return id;
    const st = readStatus(cwd, id);
    if (st && st.status === 'running') {
      if (isAlive(st.pid)) return id;
      // Recorded as running but the process is gone: mycod died or the sweep
      // was killed externally. Say so rather than leaving it 'running' forever.
      updateStatus(cwd, id, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: 'sweep process disappeared (orphaned by a mycod restart, or killed externally)',
      });
    }
  }
  return null;
}

function getStatus(cwd, id) {
  const target = id || latestSweepId(cwd);
  if (!target) return null;
  const st = readStatus(cwd, target);
  if (!st) return null;
  // A status file that says "running" alongside a dead pid is the orphan case;
  // report it honestly instead of a spinner that never resolves.
  if (st.status === 'running' && !isAlive(st.pid)) {
    return { ...st, status: 'failed', error: st.error || 'sweep process is gone' };
  }
  return st;
}

// Boot-time cleanup (R1). Anything still running gets killed: it survived a
// mycod restart, which means nobody is watching its spend, and its pane state is
// stale anyway.
function sweepOrphans(cwd) {
  const root = sweepsRoot(cwd);
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  const killed = [];
  for (const id of names.filter((n) => n.startsWith('sw-'))) {
    const st = readStatus(cwd, id);
    if (!st || st.status !== 'running') continue;
    if (!isAlive(st.pid)) {
      updateStatus(cwd, id, {
        status: 'failed', finishedAt: new Date().toISOString(),
        error: 'orphaned: the sweep process was gone at startup',
      });
      continue;
    }
    killGroup(cwd, id, st.pid);
    updateStatus(cwd, id, {
      status: 'cancelled', finishedAt: new Date().toISOString(),
      error: 'orphaned by a mycod restart; killed at startup to stop unattended spend',
    });
    killed.push(id);
  }
  return killed;
}

// ── formatting for the chat pane ───────────────────────────────────────────

const GLYPH = { running: '⚙', success: '✓', failed: '⚠', cancelled: '✗', timeout: '⏱' };

// Does this sweep have a selection.json on disk? Used for status.resultPresent,
// which the UI reads to decide whether a diff is available. Best-effort: an
// unreadable runs tree is reported as "no result", never as an error.
function _selectionExists(cwd, id) {
  try {
    const st = readStatus(cwd, id);
    if (!st || !st.namespace) return false;
    const runsRoot = path.join(runsRootFor(cwd), 'myco', 'adapt');
    const nsDir = path.join(runsRoot, st.namespace);
    const k = st.k || 1;
    for (const task of fs.readdirSync(nsDir)) {
      for (const mode of ['parallel', 'agg']) {
        const sel = path.join(nsDir, task, 'selection', `${mode}${k}`, 'selection.json');
        if (fs.existsSync(sel)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function formatStatus(st) {
  if (!st) {
    return 'No harness sweep for this session yet. `/harness run <task>` starts one.';
  }
  const g = GLYPH[st.status] || '?';
  const parts = [`${g} **Sweep \`${st.id}\`** — ${st.status}`];
  if (st.task) parts.push(`task: ${st.task}`);
  if (st.wallS !== undefined) parts.push(`${st.wallS}s`);
  if (st.pid) parts.push(`pid ${st.pid}`);
  if (st.error) parts.push(`\n_${st.error}_`);
  if (st.stderrTail) parts.push('\n```\n' + st.stderrTail.trim().split('\n').slice(-8).join('\n') + '\n```');
  if (st.status === 'running') parts.push('\n_`/harness cancel` stops it._');
  return parts.join(' · ').replace(' · \n', '\n');
}

module.exports = {
  startSweep,
  cancelSweep,
  getStatus,
  latestSweepId,
  sweepOrphans,
  formatStatus,
  parseProgress,
  isAlive,
  sweepArgv,
  splitQuoted,
  sweepsRoot,
  sweepDir,
  sweepEnv,
  newSweepId,
  defaultWallCapS,
  sessionScope,
  runsRootFor,
  sweepTagFor,
  ROLLOUT_TIMEOUT_S,
  POLL_MS,
  TERMINAL,
};

// P8: find an installed harness from the market in this session's workspace.
// A harness installed from the market lands at .claude/agents/*.md, .claude/tool_guidance.md,
// etc. We also leave a sentinel marker so we can detect it cheaply.
function _findInstalledBaseHarness(cwd) {
  // Marker written by harness-market.installIntoSession (see bench/harness2 CONTRACT.md §8).
  // If a sweep previously installed a market harness, we can use it as the base
  // harness for the next sweep so tuning starts from that known-good point.
  const sentinel = path.join(cwd, '_harness_', 'market-installed.json');
  try {
    const data = JSON.parse(require('fs').readFileSync(sentinel, 'utf8'));
    // data.harnessDir should be an absolute path written at install time.
    if (data && data.harnessDir && require('fs').existsSync(data.harnessDir)) {
      return data.harnessDir;
    }
  } catch {}
  return null;
}
