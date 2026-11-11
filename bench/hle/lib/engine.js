// lib/engine.js — engine that REUSES myco's own source modules in-process.
//
//  - single-agent (mode 'single') -> myco's `server/src/local-claude.js`
//    `callLocalClaude` (one Claude Agent SDK query => final text).
//  - run-n2       (mode 'n2')     -> myco's `server/src/team-session.js`
//    `TeamSession` (worker-A + worker-B sharing a DelmBoard, the real
//    myco n2 machinery), driven exactly the way compare-lanes.startN2Lane
//    drives it.
//
// We do NOT reimplement the engines — we require myco's modules directly by
// absolute path. Their bare requires (@anthropic-ai/claude-agent-sdk, zod)
// resolve through NODE_PATH=<bench/hle>/node_modules (set by the launchers).
// The only code here is a thin adapter: build the task text, construct/drive
// TeamSession, and read the final answer back out of myco's own board/fs.
'use strict';

const fs = require('fs');
const path = require('path');

const MYCO_SERVER = process.env.MYCO_SRC
  || '/data/s00791175/myco-test/myco-1014/server/src';
const BENCH_ROOT = path.resolve(__dirname, '..');
// Worker workdirs live under work/<YYYYMMDDHHMMSS>/, one timestamped dir per
// server process (i.e. per test run), so all of a run's artifacts stay together.
let WORK_ROOT = path.join(BENCH_ROOT, 'work');
fs.mkdirSync(WORK_ROOT, { recursive: true });

// Local time stamp YYYYMMDDHHMMSS used for the per-run work subdir.
function runStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
       + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Point WORK_ROOT at work/<YYYYMMDDHHMMSS>/ for the current test run.
function setWorkRoot(stamp) {
  WORK_ROOT = path.join(BENCH_ROOT, 'work', stamp || runStamp());
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  return WORK_ROOT;
}

// Dir-name for a problem's worker workdir. Prefer the run's sequence number
// (n2/<seq>), falling back to the 24-hex id. A short all-numeric seq is padded
// to 4 digits so n2/0001 … n2/2500 sort in numeric order.
function dirName(seq, id) {
  const raw = String(seq || id || '');
  return /^\d+$/.test(raw) ? raw.padStart(4, '0') : raw.replace(/[^A-Za-z0-9_-]/g, '');
}

// Per-problem worker dir: work/<stamp>/<mode>/<seq>, mode = 'n2' | 'single'.
// n2 and single sit at the SAME depth under the timestamp; each problem's
// artifact dir is named by its seq.
function modeDir(mode, seq, id) {
  const d = path.join(WORK_ROOT, mode, dirName(seq, id));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Throwaway workdir for NON-persisted n2 calls (cross-judging). Landed under
// work/<stamp>/judge/ so judge transcripts (board.jsonl, transcript.txt) sit
// apart from the single/ and n2/ answer dirs instead of cluttering the run root.
function n2TempDir() {
  const j = path.join(WORK_ROOT, 'judge');
  fs.mkdirSync(j, { recursive: true });
  return fs.mkdtempSync(path.join(j, 'tmp-n2-'));
}

const MOCK = process.env.BENCH_MOCK === '1';
let _mockCounter = 0;

function requireMyco(mod) {
  return require(path.join(MYCO_SERVER, mod));
}

// ── answer prompt (used for question answering) ─────────────────────────────
const SYSTEM_ANSWER = [
  'You are answering a single exam question as precisely as possible.',
  'Output ONLY the final answer on its own line.',
  'For multiple-choice, output the matching option letter (A/B/C/D/E).',
  'For exact short-answer, output just the answer string.',
  'Do not add explanation, commentary or confidence.',
].join('\n');

// Flatten any value (SDK text block, array of blocks, object) to a single
// whitespace-collapsed line, capped for a readable transcript.
function _oneline(v, max) {
  max = max || 400;
  let s = '';
  try {
    if (Array.isArray(v)) {
      s = v.map((b) => {
        if (b && typeof b === 'object') return b.text !== undefined ? String(b.text) : JSON.stringify(b);
        return String(b);
      }).join(' ');
    } else if (v && typeof v === 'object') {
      s = JSON.stringify(v);
    } else {
      s = String(v);
    }
  } catch { s = ''; }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ── mock mode (plumbing smoke tests without touching the model) ────────────
function mockResult(questionOrPrompt) {
  _mockCounter += 1;
  const ms = 60 + (_mockCounter % 7) * 7;
  if (/You are a strict answer grader/.test(questionOrPrompt)) {
    return { ok: true, text: 'FINAL_ANSWER: MOCK\nCORRECT: yes', ms };
  }
  return { ok: true, text: `MOCK_ANSWER_${_mockCounter}`, ms };
}

// ── single-agent: reuse myco's callLocalClaude ─────────────────────────────
// Stall watchdog for the answer phase: the observed upstream failure mode is a
// stream that opens, streams only thinking_tokens system noise, and NEVER emits
// any assistant content — burning the whole timeout for nothing. When no
// assistant output arrives within HLE_STALL_MS (default 15min) we abort early
// and let run.py's retry loop have another go. Set HLE_STALL_MS=0 to disable.
//
// Default tuned 2026-10-31 from run hle-20261031192356: single's REAL successful
// latency is p50=82s / p75=117s / p95=238s / max=761s on the glmmoedsa gateway.
// The old 120s default sat BELOW p75, so every call whose first assistant
// message landed late (120s+ — still productive) was killed by the watchdog as
// a false "stall" (54/94 fails that run, ALL `no assistant output in 120000ms`).
// 900s sits above the measured max so it cannot mis-kill a producing call; the
// per-call total timeout (below) is 30min so watchdog 15min < timeout 30min.
const STALL_MS = Number(process.env.HLE_STALL_MS || 900000);

async function singleAsk(question, system, { cwd, timeoutMs, id, seq, persist }) {
  const { callLocalClaude } = requireMyco('local-claude.js');
  const start = Date.now();
  const detail = {};
  const text = await callLocalClaude({
    system: system || undefined,
    userMessage: question,
    cwd: cwd || WORK_ROOT,
    // 30min default total budget — must stay ABOVE STALL_MS (15min) or the
    // stall watchdog would fire after the call already gave up. run.py passes
    // its own --timeout (this bench ran with 86400000); this default only
    // guards callers that don't.
    timeoutMs: timeoutMs || 1800000,
    stallTimeoutMs: STALL_MS,
    detail,
  });
  if (persist && (seq || id)) {
    try {
      const d = modeDir('single', seq, id);
      fs.writeFileSync(path.join(d, 'final_answer.txt'), String(text || '').trim() + '\n');
    } catch {}
  }
  return {
    ok: !!text,
    text: text || '',
    ms: Date.now() - start,
    // surface the real failure reason (timeout / stall / sdk error) instead of
    // a bare ok:false that server.js turns into an unexplained 502
    error: text ? undefined : (detail.error || 'no output'),
  };
}

// ── run-n2: reuse myco's TeamSession ───────────────────────────────────────
function buildN2Task(question, system) {
  const prompt = system ? `${system}\n\nQUESTION:\n${question}` : question;
  return [
    'Answer the exam question below. The ONLY deliverable of this task is the single final',
    'answer, written as the content of the file `final_answer.txt` in the shared workspace',
    '(one line, just the answer string — no explanation, no label).',
    '',
    'IMPORTANT — how to write `final_answer.txt`: use a Bash command with an absolute path',
    '(e.g. `printf \'%s\\n\' "<answer>" > /abs/path/to/workspace/final_answer.txt`), NOT the',
    'Write tool. The Write tool on this host can silently redirect the file to a different',
    'directory while reporting success (observed 2026-11-02, runs hle-20261102103030 +',
    'hle-20261102143854: files written via Write landed at bench/hle-<stamp>/n2/<seq>/',
    'instead of bench/hle/work/<stamp>/n2/<seq>/). After writing, verify with',
    '`cat <abs-path>/final_answer.txt` before closing your claim.',
    '',
    'QUESTION:',
    prompt,
    '',
    'Division of work (follow the board protocol):',
    '- worker-A, as the initial queue creator: reserve ONE scope ("final answer"), solve the',
    '  question, write the answer to `final_answer.txt`, then close your claim with `done`',
    '  (summary may be the answer). This is the whole task — do not create extra queue items.',
    '- worker-B: work the same question from the original task in parallel. If your',
    '  independent answer differs from what is in `final_answer.txt`, overwrite that file',
    '  with your corrected answer. Do NOT create review/verification queue items. Publish a',
    '  status only if needed; do not wait on worker-A.',
    '',
    'Finish: the task is complete once `final_answer.txt` contains the final answer and every',
    'open queue item is closed (done).',
  ].join('\n');
}

// Read the final answer back from myco's own board (done-item summaries +
// notes) as a fallback to the marker file. `lane.board` IS myco's DelmBoard;
// we only read it, never reimplement the board.
function extractFromBoard(lane) {
  try {
    const view = (lane && lane.board && typeof lane.board.view === 'function')
      ? lane.board.view(null) : null;
    if (!view) return '';
    const cands = [];
    if (Array.isArray(view.queue)) {
      for (const it of view.queue) {
        if (it && typeof it.summary === 'string' && it.summary.trim()) cands.push(it.summary.trim());
      }
    }
    if (Array.isArray(view.notes)) {
      for (const n of view.notes) {
        const t = (n && (n.text !== undefined ? n.text : n.content)) || '';
        const i = String(t).indexOf('FINAL_ANSWER');
        if (i >= 0) {
          const seg = String(t).slice(i + 'FINAL_ANSWER'.length).replace(/^:\s*/, '').trim();
          if (seg) cands.push(seg);
        }
      }
    }
    // prefer a FINAL_ANSWER marker, else the most recent done-item summary
    for (let i = cands.length - 1; i >= 0; i--) {
      if (/^final[\s_-]*answer/i.test(cands[i]) || /^(yes|no|[A-Ea-e])\b/.test(cands[i])) return cands[i];
    }
    return cands.length ? cands[cands.length - 1] : '';
  } catch { return ''; }
}

async function n2Ask(question, system, { cwd, timeoutMs, id, seq, persist }) {
  const { TeamSession } = requireMyco('team-session.js');
  // A persisted answer lives at work/<stamp>/n2/<seq>/ (final_answer.txt is
  // the answer; transcript.txt is the worker trace). Judging / non-persisted
  // calls use a throwaway dir under work/<stamp>/judge/.
  const dir = cwd || (persist && (seq || id)
    ? modeDir('n2', seq, id)
    : n2TempDir());
  const ansFile = path.join(dir, 'final_answer.txt');
  if (persist && (seq || id)) {
    try { fs.writeFileSync(path.join(dir, 'problem_id.txt'), String(id || dirName(seq, id)) + '\n'); } catch {}
    try { fs.writeFileSync(path.join(dir, 'problem.txt'), String(id || dirName(seq, id)) + '\n\n' + String(question)); } catch {}
  }
  const task = buildN2Task(question, system);
  const sessionId = 'hle-n2-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

  const lane = new TeamSession(sessionId, {
    cwd: dir,
    user: null,
    task,
    eventsDir: dir,
    rlm: false,
  });

  // Record each worker's ACTUAL model output + tool calls to a readable
  // transcript (work/<id>/n2/transcript.txt). The events-worker-*.jsonl that
  // TeamSession writes only carry `thinking_tokens` system noise; the
  // `agent-event` stream is where the real assistant_text / tool_use /
  // tool_result / turn_result appear, stamped with which worker produced it.
  const transcriptFile = path.join(dir, 'transcript.txt');
  lane.on('agent-event', (e) => {
    try {
      const who = e.worker || '?';
      const t = e.type || 'event';
      let line = '';
      if (t === 'assistant_text') line = `[${who}][assistant] ${_oneline(e.text)}`;
      else if (t === 'tool_use') line = `[${who}][tool_use] ${String(e.name || '')} ${_oneline(e.input)}`;
      else if (t === 'tool_result') line = `[${who}][tool_result]${e.isError ? ' ERROR' : ''} ${_oneline(e.content)}`;
      else if (t === 'turn_result') line = `[${who}][turn_result] ${_oneline(e.result)}`;
      else if (t === 'system_init') line = `[${who}][model] ${String(e.model || '')} tools=[${(e.tools || []).join(',')}]`;
      else if (t === 'unknown_event') return; // thinking_tokens / system passthrough noise — no signal
    // any real model output from either worker disarms the stall watchdog —
    // the team is productive, give it the full hardTimeout budget
    if (t === 'assistant_text' || t === 'tool_use') sawWorkerOutput = true;
      else line = `[${who}][${t}]`;
      fs.appendFileSync(transcriptFile, line + '\n');
    } catch {}
  });

  const start = Date.now();
  // Answer-stability window: how long final_answer.txt must stay unchanged
  // before we trust it. Raised 2026-11-06 from 50s to 120s: the task prompt
  // tells worker-B to independently solve and OVERWRITE the answer file when
  // its result differs — a B-correction routinely lands >50s after A's first
  // write, and the old window killed the lane (and B's correction with it)
  // while the task was still in flight ("not finished, but n2 declared
  // finished" bug). Env-overridable for experiments that want it tighter.
  const GRACE_MS = Number(process.env.HLE_N2_GRACE_MS) || 120000;
  const POLL_MS = 4000;
  const hardTimeout = timeoutMs || 600000;
  // Early-abort a dead team: if NO worker has produced any model output
  // (assistant_text / tool_use) within HLE_N2_STALL_MS, both workers are stuck
  // in the upstream "streaming thinking noise forever" failure mode — kill the
  // lane now and report a stall instead of burning the full 600s. Workers that
  // DID produce output keep their full hardTimeout budget. Set HLE_N2_STALL_MS=0
  // to disable.
  //
  // Default is 300s, NOT 180s. Measured on HLE (golden_no_image, 2026-10-31):
  // a SUCCESSFUL n2 answer takes median ~298s to finish opened with an
  // ~88s fastest case, and even the first worker output (a board tool_use)
  // can be delayed past 180s when the gateway is hot. A 180s no-output window
  // killed teams that were still productively working, inflating the n2 error
  // rate; 300s sits just above the realistic first-output latency while still
  // catching a truly dead stream before TeamSession's own 4-hour stall-fail
  // (defaults raised 2026-11-05; see team-session.js).
  // (n2-stall is also classified DETERMINISTIC by bench/utils/orch.py, so
  // run.py no longer retries it and re-writes the worker dir — see that file.)
  const STALL_MS = Number(process.env.HLE_N2_STALL_MS) || 300000;

  let result = { ok: false, text: '', error: undefined };
  let settled = false;
  let failed = false;
  let lastContent = '';
  let lastChangeAt = 0;
  let sawWorkerOutput = false;

  // Return once the final answer file is written and stable (or the team
  // completes/fails), so a lingering worker doesn't force a full timeout.
  const done = new Promise((resolve) => {
    const timers = [];
    const poller = setInterval(attemptResolve, POLL_MS);
    timers.push(poller);
    const hardTimer = setTimeout(() => {
      result.ok = false;
      result.error = `n2 timeout after ${hardTimeout}ms (worker output: ${sawWorkerOutput ? 'yes' : 'none'})`;
      try { lane.kill(); } catch {}
      settle();
    }, hardTimeout);
    timers.push(hardTimer);
    const stallTimer = STALL_MS > 0 ? setTimeout(() => {
      if (sawWorkerOutput || readFile()) return;   // productive team → not a stall
      result.ok = false;
      result.error = `n2 stalled: no worker output in ${STALL_MS}ms`;
      try { lane.kill(); } catch {}
      settle();
    }, STALL_MS) : null;
    if (stallTimer) timers.push(stallTimer);

    // Premature-completion guards (bug 2026-11-06: "task not finished, but
    // n2 declared it finished"). TeamSession's team-complete fires when the
    // board queue is all-done + workers idle — it does NOT know about the
    // answer file (that contract is bench-private). A worker can finish its
    // turn, get its claim auto-closed, and complete the team BEFORE the
    // answer file exists (or with a placeholder about to be overwritten).
    // Same for 'exit': any worker's kill() emits exit, and a single exit
    // used to settle the whole question. Both events now only settle when a
    // non-empty answer is on disk; otherwise we keep waiting — the answer
    // may still land from the remaining worker / the write-verify turn, and
    // the hardTimeout is the backstop if it never does.
    lane.on('team-complete', () => { if (readFile()) settle(); });
    lane.on('team-failed', () => { failed = true; result.error = result.error || 'n2 team failed'; attemptResolve(); });
    // TeamSession forwards each worker's exit untagged (a kill() or a worker
    // process death). Count exits: a SINGLE worker exit must not end the
    // question — the other may still be writing the answer. Only when the
    // answer exists (any time) or BOTH workers are gone does exit settle.
    let exitCount = 0;
    const rosterSize = Array.isArray(lane.roster) ? lane.roster.length : 2;
    lane.on('exit', () => {
      exitCount += 1;
      if (readFile()) settle();
      else if (exitCount >= rosterSize) settle();
    });

    function settle() {
      if (settled) return;
      settled = true;
      timers.forEach((t) => clearInterval(t));
      clearTimeout(hardTimer);
      result.text = readFile();
      // a real answer file means the team WAS productive — never call it a stall
      if (result.text) result.error = undefined;
      resolve();
    }
    function readFile() {
      try { return fs.existsSync(ansFile) ? fs.readFileSync(ansFile, 'utf8').trim() : ''; }
      catch { return ''; }
    }
    function attemptResolve() {
      const content = readFile();
      if (content) {
        sawWorkerOutput = true;              // answer written → productive team
        result.text = content;
        if (content !== lastContent) { lastContent = content; lastChangeAt = Date.now(); }
        else if (failed || (Date.now() - lastChangeAt) >= GRACE_MS) settle();
      } else {
        lastContent = '';
        lastChangeAt = 0;
      }
    }
  });

  try {
    lane.dispatchTask(task);
  } catch (e) {
    try { lane.kill(); } catch {}
    return { ok: false, text: '', ms: Date.now() - start, error: String(e.message || e) };
  }

  await done;

  let ans = result.text;
  if (!ans) {
    try { if (fs.existsSync(ansFile)) ans = fs.readFileSync(ansFile, 'utf8').trim(); } catch {}
  }
  if (!ans) ans = extractFromBoard(lane);
  try { lane.kill(); } catch {}
  return { ok: result.ok || !!ans, text: ans, ms: Date.now() - start, error: ans ? undefined : result.error };
}

// ── public API ──────────────────────────────────────────────────────────────
// answer a question (mode = 'single' | 'n2')
async function answer(mode, { question, system, timeoutMs, cwd, id, seq, persist } = {}) {
  if (MOCK) {
    const m = mockResult(question);
    return { ok: m.ok, mode, answer: m.text, ms: m.ms, durationMs: m.ms, error: undefined };
  }
  const t0 = Date.now();
  const r = mode === 'n2'
    ? await n2Ask(question, system, { timeoutMs, cwd, id, seq, persist })
    : await singleAsk(question, system, { timeoutMs, cwd, id, seq, persist });
  return { ok: r.ok, mode, answer: r.text, ms: r.ms, durationMs: Date.now() - t0, error: r.error };
}

module.exports = { answer, singleAsk, n2Ask, SYSTEM_ANSWER, buildN2Task, setWorkRoot, WORK_ROOT };
