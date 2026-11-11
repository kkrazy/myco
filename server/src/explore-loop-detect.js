// explore-loop-detect.js — run-explore strategy-switching / loop detection.
//
// Purpose: run-explore (foraging) workers can deadlock by repeating the SAME
// action with no productive result — the agent goal content is invisible to
// the lane layer (it's captured inside the n2/engine), so the lane cannot
// tell "making progress toward the goal" from "stuck in place". We cannot
// add a time hard-limit (it kills slow-but-real exploration — measured n2
// p90 latency ~676s). So we detect a *same-action* loop structurally and
// inject a strategy-switch prompt (deny was the alternative; inject-prompt
// is the existing, least-invasive lane mechanism — same channel as the
// stall nudge / idle kick).
//
// Two responsibilities (design doc docs/arch/agents/explore/run-explore.md
// §5.1 + §5.2):
//   1. **Loop detection** — consecutive identical tool_use (same action)
//      that accumulates ≥ threshold (default 10) occurrences with NO
//      successful (non-error) tool_result / turn_result in between →
//      decide a strategy switch for that worker.
//   2. **Interactive-step ledger** — record each worker's normalized
//      interactive steps (tool_use / tool_result / turn_result) + counts,
//      persistable to <dir>/steps-<actor>.jsonl, so that even when the goal
//      is unreachable the lane can verify PARTIAL goal achievement (which
//      actions happened, how many, how many erred) and surface it in the
//      explore report.
//
// Pure in-memory state (no I/O at construction). Persistence happens ONLY
// via flushLedger() / reportSummaries(), which the lane/report path calls —
// so a TeamSession constructed in a test with a stub worker never touches
// disk and never needs a live SDK.
//
// This module is wired in team-session.js ONLY for explore lanes
// (this.explore). The n2 path is byte-identical (see the n2 followup —
// docs/arch/agents/explore/run-explore.md §6: n2 must get the SAME
// mechanism later; NOT implemented here).

'use strict';

const fs = require('fs');
const path = require('path');

// Default same-action loop threshold: an action repeated this many times
// with no successful result is treated as stuck. Overridable via env.
const DEFAULT_LOOP_THRESHOLD = 10;

// Cooldown between strategy-switch injections per worker (ms) — avoid
// spamming one stuck worker with corrective prompts every event.
const DEFAULT_SWITCH_COOLDOWN_MS = 60 * 1000;

// Which events are terminal *progress* signals that clear a same-action
// streak (a successful result or a finished turn means the agent is moving).
const PROGRESS_EVENTS = new Set(['turn_result', 'iteration_aborted']);

class ExploreLoopDetector {
  /**
   * @param {object} [opts]
   * @param {number} [opts.threshold]     same-action repeat count before a
   *                                      strategy switch (default 10)
   * @param {number} [opts.switchCooldownMs] min ms between switches per worker
   * @param {number} [opts.maxSwitches]   hard cap on switches per worker
   *                                      (belt-and-braces; not a time limit)
   */
  constructor(opts = {}) {
    this.threshold = Number(opts.threshold) ||
      Number(process.env.MYCO_EXPLORE_LOOP_THRESHOLD) || DEFAULT_LOOP_THRESHOLD;
    this.switchCooldownMs = Number(opts.switchCooldownMs) || DEFAULT_SWITCH_COOLDOWN_MS;
    this.maxSwitches = Number(opts.maxSwitches) || 5;
    /** @type {Map<string, Object>} per-worker runtime state */
    this._workers = new Map();
    /** @type {Map<string, Object[]>} per-worker normalized step ledger */
    this._steps = new Map();
    /** @type {Object[]} ordered switch-log (worker, at, streak, reason) */
    this._switchLog = [];
  }

  _worker(worker) {
    let w = this._workers.get(worker);
    if (!w) {
      w = {
        lastAction: null,        // last tool name seen
        lastActionResolved: true,// did the current action produce a result?
        streak: 0,               // consecutive same-action w/ no result
        lastSwitchAt: 0,
        switches: 0,
      };
      this._workers.set(worker, w);
    }
    return w;
  }

  _stepsOf(worker) {
    let list = this._steps.get(worker);
    if (!list) { list = []; this._steps.set(worker, list); }
    return list;
  }

  /**
   * Feed one per-worker agent-event (already tagged with the worker id).
   *
   * @param {string} worker actor id, e.g. 'path-1'
   * @param {object} ev      the agent-event from TeamSession._relay
   * @returns {null|object}  a strategy-switch decision:
   *   { worker, streak, at } — OR null when nothing to switch.
   *   The caller applies the correction (inject a prompt via worker.write).
   */
  observe(worker, ev) {
    if (!ev) return null;
    this._recordStep(worker, ev);

    const w = this._worker(worker);
    if (ev.type === 'tool_use') {
      const key = String((ev && ev.name) || '');
      // Same action AND still unresolved (no successful result since the
      // previous firing) → the streak grows. Any change of action, or a
      // resolve that cleared the flag (set below), restarts the count.
      if (key && key === w.lastAction && !w.lastActionResolved) {
        w.streak += 1;
      } else {
        w.lastAction = key;
        w.lastActionResolved = false;
        w.streak = key ? 1 : 0;
      }
      return this._maybeSwitch(worker, w);
    }

    if (ev.type === 'tool_result') {
      // A SUCCESSFUL result = the action produced output → the agent moved.
      // An ERROR result = "no result" → the streak survives a failed attempt
      // (repeating a failing action is exactly the stuck pattern).
      if (!ev.isError) this._resetStreak(w);
      return null;
    }

    if (PROGRESS_EVENTS.has(ev.type)) {
      this._resetStreak(w);
      return null;
    }

    return null;
  }

  _recordStep(worker, ev) {
    const steps = this._stepsOf(worker);
    const step = { t: ev.ts || new Date().toISOString(), type: ev.type };
    if (ev.type === 'tool_use') step.name = ev.name;
    if (ev.type === 'tool_result') { step.ok = !ev.isError; }
    if (ev.type === 'turn_result') { step.done = true; }
    steps.push(step);
    // Cap the in-memory ledger so a long run can't grow unboundedly; the
    // persisted jsonl (flushLedger) keeps the full history.
    if (steps.length > 200000) steps.splice(0, steps.length - 200000);
  }

  _resetStreak(w) {
    w.streak = 0;
    w.lastAction = null;
    w.lastActionResolved = true;
  }

  /**
   * Signal that the given worker made progress on the board (published a
   * path item, claimed, done, or a FACT/FAIL/status note). A worker that
   * posted to the board is NOT stuck — clear its same-action streak.
   *
   * @param {string} worker actor id
   */
  onBoardProgress(worker) {
    if (!worker) return;
    const w = this._workers.get(worker);
    if (w) this._resetStreak(w);
  }

  _maybeSwitch(worker, w) {
    if (w.streak < this.threshold) return null;
    if (w.switches >= this.maxSwitches) return null;   // progressive cooldown cap
    const now = Date.now();
    if (now - w.lastSwitchAt < this.switchCooldownMs) return null; // per-worker cooldown
    w.switches += 1;
    w.lastSwitchAt = now;
    const decision = { worker, streak: w.streak, at: now };
    this._switchLog.push({ ...decision, atISO: new Date(now).toISOString() });
    // Reset so the next switch needs a fresh loop, not the same one.
    this._resetStreak(w);
    return decision;
  }

  /**
   * Take the corrective prompt text for a detected loop. The lane writes
   * this into the worker to make it switch strategy (no time hard-limit).
   *
   * @param {object} decision from observe()
   * @param {string} [task]   the original task text (for the prompt)
   * @returns {string}        injected prompt text
   */
  static switchPrompt(decision, task) {
    const d = decision || {};
    return [
      `⚠️ Strategy switch (loop detection): you have repeated the same action ` +
        `${d.streak || 'many'} times without producing a result. Stop repeating it.`,
      `Read the board (mcp__board__read) and post a status/none note naming exactly ` +
        `what input is missing or which direction is blocked.`,
      `Then change strategy: pick a DIFFERENT action or a different sub-goal and make ` +
        `one concrete, measurable step toward it. Do NOT retry the same action again.`,
      task ? `Original task (authoritative): ${String(task).replace(/\s+/g, ' ').trim()}` : null,
    ].filter(Boolean).join('\n');
  }

  /**
   * Persist the per-worker step ledger as JSONL under a run dir. No-op (and
   * disk-free) when no steps were ever observed. Returns written paths.
   *
   * @param {string} dir  run directory (e.g. the explore lane's dir)
   * @returns {string[]}  written files
   */
  flushLedger(dir) {
    if (!dir || this._steps.size === 0) return [];
    const written = [];
    for (const [worker, steps] of this._steps) {
      const file = path.join(dir, `steps-${String(worker).replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, steps.map((s) => JSON.stringify(s)).join('\n') + '\n');
      fs.renameSync(tmp, file);
      written.push(file);
    }
    return written;
  }

  /**
   * Normalized per-worker summary for the explore report: how many
   * interactive steps, per-action call/error counts, and switch history —
   * the raw material for "verify partial goal achievement even when the
   * goal is invisible".
   *
   * @returns {Object<string,Object>} keyed by worker id
   */
  reportSummaries() {
    const out = {};
    for (const [worker, w] of this._workers) {
      const stats = this._workerStats(worker);
      out[worker] = {
        threshold: this.threshold,
        lastAction: w.lastAction,
        streak: w.streak,
        switches: w.switches,
        steps: stats.steps,
        toolUse: stats.toolUse,
        toolResult: stats.toolResult,
        errorResults: stats.errorResults,
        turns: stats.turns,
        actions: stats.actions,
      };
    }
    return out;
  }

  _workerStats(worker) {
    const steps = this._steps.get(worker) || [];
    const actions = {};
    let toolUse = 0, toolResult = 0, errors = 0, turns = 0;
    for (const s of steps) {
      if (s.type === 'tool_use') {
        toolUse += 1;
        const n = s.name || '?';
        actions[n] = actions[n] || { calls: 0, errors: 0 };
        actions[n].calls += 1;
      } else if (s.type === 'tool_result') {
        toolResult += 1;
        if (!s.ok) errors += 1;
      } else if (s.type === 'turn_result') {
        turns += 1;
      }
    }
    // Attribute error results to the action that most recently fired: we
    // don't track tool_use_id here, so approximate by carrying the last
    // action name forward.
    let lastActionName = null;
    for (const s of steps) {
      if (s.type === 'tool_use') lastActionName = s.name;
      else if (s.type === 'tool_result' && !s.ok && lastActionName) {
        actions[lastActionName] = actions[lastActionName] || { calls: 0, errors: 0 };
        actions[lastActionName].errors += 1;
      }
    }
    return {
      steps: steps.length,
      toolUse,
      toolResult,
      errorResults: errors,
      turns,
      actions,
    };
  }

  switchLog() { return this._switchLog.slice(); }

  reset() { this._workers.clear(); this._steps.clear(); this._switchLog.length = 0; }
}

module.exports = { ExploreLoopDetector, DEFAULT_LOOP_THRESHOLD, PROGRESS_EVENTS };
