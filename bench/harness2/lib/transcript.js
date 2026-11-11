// bench/harness2/lib/transcript.js — P1-b.
//
// Renders myco's `_myco_/events.jsonl` into the shared trajectory grammar
// (CONTRACT.md §8), which is the SAME grammar
// `harness2/substrate/opencode.py:render_events()` produces. Harness²'s
// improvement sessions read trajectories to decide "which step went wrong", so
// one reader has to work for both substrates — any divergence here shows up as
// a phantom difference in a cross-substrate comparison.
//
// Event vocabulary this consumes (emitted by server/src/agent-session.js):
//   tool_use         { name, input }           → [ACTION] name(args)
//   tool_result      { content, isError }      → [OBSERVATION] / [OBSERVATION ERROR]
//   assistant_text   { text }                  → [ASSISTANT]
//   turn_result      { subtype, result }       → [ASSISTANT] on the final text
//   fatal / resume_failed / rate_limit         → [ERROR]
//   iteration_aborted { reason }               → [ERROR]
//
// Everything else (turn_start, system_init, hook_allow, stdio, …) is dropped:
// it is myco bookkeeping, not agent behaviour, and padding the trajectory with
// it would eat the obs_trunc budget that the real evidence needs.
//
// Pure module — no myco imports, no SDK. Testable without a session.
'use strict';

const fs = require('fs');

// Byte-identical to harness2/substrate/opencode.py's _TRUNC_FMT. If these ever
// drift, a Python-side diff of the two renderers reports a difference forever.
const TRUNC_FMT = (n) => `…(+${n} chars — render truncation)`;

// core/spec.py rejects obs_trunc < 10_000 outright: "that range fabricates
// defects". We mirror the floor here so a caller cannot sneak past it by
// calling the renderer directly instead of going through the CLI.
const MIN_OBS_TRUNC = 10000;
const DEFAULT_OBS_TRUNC = 12000;
const DEFAULT_ARGS_TRUNC = 400;
const DEFAULT_MAX_CHARS = 200000;

const EMPTY = '(no parseable events in trajectory)';

function clip(s, n) {
  const str = (s === null || s === undefined) ? '' : String(s).replace(/\x00/g, '');
  if (n <= 0 || str.length <= n) return str;
  return str.slice(0, n) + TRUNC_FMT(str.length - n);
}

// tool_use.input is an object; opencode.py serialises the equivalent field with
// json.dumps(..., ensure_ascii=False), so we must NOT escape non-ASCII either —
// a Chinese file path has to render the same on both substrates.
function renderArgs(input, argsTrunc) {
  if (input === undefined || input === null) return '';
  let s;
  try {
    s = JSON.stringify(input);
  } catch {
    // Circular or otherwise unserialisable: say so rather than dropping the
    // ACTION line, which would make the trajectory claim no tool ran.
    s = '"(unserialisable input)"';
  }
  return clip(s, argsTrunc);
}

// Map one event to zero or more trajectory lines.
function renderEvent(ev, opts) {
  const { obsTrunc, argsTrunc } = opts;
  if (!ev || typeof ev !== 'object') return [];
  switch (ev.type) {
    case 'tool_use': {
      const name = (typeof ev.name === 'string' && ev.name) ? ev.name : 'tool';
      return [`[ACTION] ${name}(${renderArgs(ev.input, argsTrunc)})`];
    }
    case 'tool_result': {
      const body = clip(ev.content, obsTrunc);
      // An empty result is still a fact worth recording — "the tool returned
      // nothing" is different from "the tool was never called".
      const tag = ev.isError ? 'OBSERVATION ERROR' : 'OBSERVATION';
      return [`[${tag}] ${body}`];
    }
    case 'assistant_text': {
      const txt = clip(ev.text, obsTrunc);
      return txt.trim() ? [`[ASSISTANT] ${txt}`] : [];
    }
    case 'turn_result': {
      // The SDK repeats the last assistant block in `result`. agent-session.js
      // already emits that as a separate assistant_text, so emitting it again
      // here would double every turn's final message. Only surface a FAILED
      // turn, which has no assistant_text of its own.
      if (ev.subtype && ev.subtype !== 'success') {
        return [`[ERROR] turn ended with subtype=${ev.subtype}${ev.result ? ': ' + clip(ev.result, obsTrunc) : ''}`];
      }
      return [];
    }
    case 'iteration_aborted':
      return [`[ERROR] iteration aborted${ev.reason ? ' (' + ev.reason + ')' : ''}`];
    case 'resume_failed':
      return ['[ERROR] SDK session resume failed; a fresh conversation was started'];
    case 'rate_limit':
      return [`[ERROR] rate limited${ev.retryAfter ? ' (retry after ' + ev.retryAfter + 's)' : ''}`];
    case 'fatal':
      return [`[ERROR] ${clip(ev.message || ev.error || 'fatal error', obsTrunc)}`];
    default:
      return [];
  }
}

// Parse a JSONL buffer into lines. Defensive by design: events.jsonl is append-
// only from a live process, so the last line can be a partial write, and a
// container kill mid-append leaves a truncated record. One bad line must not
// discard the whole trajectory.
function renderEventsFromText(raw, opts = {}) {
  const obsTrunc = Number.isFinite(opts.obsTrunc) ? opts.obsTrunc : DEFAULT_OBS_TRUNC;
  const argsTrunc = Number.isFinite(opts.argsTrunc) ? opts.argsTrunc : DEFAULT_ARGS_TRUNC;
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : DEFAULT_MAX_CHARS;
  if (obsTrunc < MIN_OBS_TRUNC) {
    throw new Error(
      `obsTrunc=${obsTrunc} is in the range that fabricates defects ` +
      `(harness2 core/spec.py rejects < ${MIN_OBS_TRUNC})`);
  }

  const lines = [];
  for (const ln of String(raw || '').split(/\r?\n/)) {
    const t = ln.trim();
    if (!t.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    for (const out of renderEvent(ev, { obsTrunc, argsTrunc })) lines.push(out);
  }

  const rendered = lines.join('\n').trim();
  if (!rendered) return EMPTY;
  if (rendered.length > maxChars) {
    // Tail-truncate, matching opencode.py: the EARLY steps are what an
    // improvement session needs ("where did it start to drift"), so the end is
    // what gets dropped.
    return rendered.slice(0, maxChars) + '\n' + TRUNC_FMT(rendered.length - maxChars);
  }
  return rendered;
}

// Read + render. Returns a human-readable failure string rather than throwing,
// because a missing trajectory is a normal outcome (the rollout may have died
// before writing one) and the caller records it as evidence.
function renderEventsFile(file, opts = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return `(failed to read trajectory: ${e.message})`;
  }
  return renderEventsFromText(raw, opts);
}

// ── n2 team trajectories (D2) ─────────────────────────────────────────────
//
// A team rollout writes per-worker journals (events-worker-A.jsonl /
// events-worker-B.jsonl, agent-session.js stamps `{ts: ISO, ...event}`) plus
// the shared board journal (board.jsonl, rows
// `{sequence, timeNs: epoch-ms, actor, kind, payload}`). The old G4 fix
// concatenated the two worker streams — chronology across workers was lost,
// no line said which worker acted, and the board (claims, dones, notes,
// conflicts: the COORDINATION evidence) never rendered at all.
//
// mergeTeamEvents interleaves all three sources by timestamp into one
// additions-only extension of the §8 grammar:
//
//   [ACTION]      worker=worker-A tool=Bash input={"command":"ls"}
//   [OBSERVATION] worker=worker-B …
//   [OBSERVATION] worker=board kind=board event=done item=q-1 summary="…"
//   [ASSISTANT]   worker=worker-A …
//
// Rules, same philosophy as the single-agent renderer:
//   - worker identity comes from the SOURCE FILE, never in-band fields;
//   - dirty JSONL lines skip silently (a kill mid-append truncates the last
//     line — one bad line must not discard the trajectory);
//   - board rows are metadata, clipped by argsTrunc so they cannot eat the
//     obs_trunc budget real tool output needs;
//   - a conflict verdict on the board is an OBSERVATION, not an [ERROR] —
//     routine coordination rendered as defects would poison every reflection.
// The `tool=` marker on tagged ACTION lines distinguishes them from
// single-agent ACTION lines (which carry the bare tool name) at zero reader
// cost.

const BOARD_WORKER = 'board';

// One board row → one payload fragment: `item=q-1 summary="fixed off-by-one"`.
// Quotes in summaries are escaped so a skimming parser cannot be confused by
// an embedded double quote.
function _boardPayloadFragment(payload, argsTrunc) {
  if (!payload || typeof payload !== 'object') return '';
  const parts = [];
  const push = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    parts.push(typeof v === 'string' ? `${k}="${clip(v.replace(/"/g, "'"), argsTrunc)}"` : `${k}=${v}`);
  };
  push('item', payload.item || payload.id);
  push('subject', payload.subject);
  push('type', payload.type);
  push('verdict', payload.applied === undefined ? undefined : (payload.applied ? 'applied' : 'conflict'));
  push('summary', payload.summary || payload.text);
  if (payload.conflicts && typeof payload.conflicts === 'object' && Object.keys(payload.conflicts).length) {
    push('conflicts', Object.keys(payload.conflicts).join(','));
  }
  return parts.join(' ');
}

// Load one JSONL journal into `out` as {ts, order, render} records.
// Worker journals: agent-session events (ts ISO). Board journal: rows
// (timeNs epoch-ms). `stamp` converts a record to epoch-ms; dirty lines skip.
function _loadJournal(file, stamp, render, out, orderBase) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return; // missing journal = that source simply has nothing to say
  }
  let order = orderBase;
  for (const ln of String(raw || '').split(/\r?\n/)) {
    const t = ln.trim();
    if (!t.startsWith('{')) continue;
    let rec;
    try { rec = JSON.parse(t); } catch { continue; }
    const ms = stamp(rec);
    if (!Number.isFinite(ms)) continue;
    const lines = render(rec);
    if (!lines.length) continue;
    out.push({ ms, order: order++, lines });
  }
}

// Merge worker journals + the board journal into one chronological team
// trajectory. `workerFiles` is ordered [{file, worker}] — the order is the
// tie-break between equal timestamps, so output is deterministic.
function mergeTeamEvents(workerFiles, boardFile, opts = {}) {
  const obsTrunc = Number.isFinite(opts.obsTrunc) ? opts.obsTrunc : DEFAULT_OBS_TRUNC;
  const argsTrunc = Number.isFinite(opts.argsTrunc) ? opts.argsTrunc : DEFAULT_ARGS_TRUNC;
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : DEFAULT_MAX_CHARS;
  if (obsTrunc < MIN_OBS_TRUNC) {
    throw new Error(
      `obsTrunc=${obsTrunc} is in the range that fabricates defects ` +
      `(harness2 core/spec.py rejects < ${MIN_OBS_TRUNC})`);
  }

  const records = [];
  workerFiles.forEach(({ file, worker }, i) => {
    _loadJournal(
      file,
      (ev) => (ev && ev.ts ? Date.parse(ev.ts) : NaN),
      (ev) => renderEvent(ev, { obsTrunc, argsTrunc }).map((l) => _tagWorker(l, worker)),
      records,
      i
    );
  });
  _loadJournal(
    boardFile,
    (row) => (row && typeof row.timeNs === 'number' ? row.timeNs : NaN),
    (row) => {
      const frag = _boardPayloadFragment(row.payload, argsTrunc);
      const actor = (row.actor === BOARD_WORKER || !row.actor) ? '' : ` actor=${row.actor}`;
      return [`[OBSERVATION] worker=${BOARD_WORKER} kind=board event=${row.kind}${actor}${frag ? ' ' + frag : ''}`];
    },
    records,
    workerFiles.length
  );

  records.sort((a, b) => (a.ms - b.ms) || (a.order - b.order));
  const rendered = records.flatMap((r) => r.lines).join('\n').trim();
  if (!rendered) return EMPTY;
  if (rendered.length > maxChars) {
    return rendered.slice(0, maxChars) + '\n' + TRUNC_FMT(rendered.length - maxChars);
  }
  return rendered;
}

// `…tool=Bash input={…}` — tagged ACTION lines carry `tool=` so they stay
// distinguishable from single-agent `Bash(…)` lines while keeping the input
// payload in the same place a reader already looks.
function _tagWorker(line, worker) {
  if (line.startsWith('[ACTION] ')) {
    const m = /^(\[[^\]]+\]) (\S+)\((.*)$/s.exec(line);
    if (m) return `${m[1]} worker=${worker} tool=${m[2]} input=${m[3]}`;
  }
  return line.replace(/^\[([A-Z ]+)\] /, `[$1] worker=${worker} `);
}

module.exports = {
  renderEventsFile,
  renderEventsFromText,
  renderEvent,
  mergeTeamEvents,
  clip,
  TRUNC_FMT,
  MIN_OBS_TRUNC,
  DEFAULT_OBS_TRUNC,
  DEFAULT_ARGS_TRUNC,
  DEFAULT_MAX_CHARS,
  EMPTY,
};
