// n=2 worker orchestration system-prompts, faithful to Delm prompts_n2.py.
//
// Key logic (shared sub-queue lifecycle, division of labour, waiting
// discipline) is preserved from the canonical source:
//   /data/s00791175/Delm/Delm/prompts/prompts_n2.py
// Override the source with the DELM_PROMPTS_N2 env var. On load we try to
// read that file to confirm the reference still exists (and log a warning if
// it's gone); the orchestration text itself is inlined here as an idempotent,
// self-contained copy so myco runs with no hard dependency on the Delm tree.
//
// The only intentional divergence: Delm says `sh /tools/context.sh ACTION …`
// (a shell channel from a separate container). In myco the two workers are
// in-process, so the board is reached through the mcp__board__* tools instead
// — same actions, same queue semantics, no subprocess.
//
// The reusable blocks (QUEUE_POLICY / STARTUP_A / STARTUP_B /
// BOARD_COMMANDS / WAITING) live in prompts-n2-shared.js so the
// multi-expert team mode (prompts-team.js) can reuse the collaboration core
// without duplicating text. workerPrompt() output is byte-identical to the
// pre-refactor inline copy (test/n2-prompt-frozen.test.js locks it).

'use strict';

const fs = require('fs');

const {
  QUEUE_POLICY, STARTUP_A, STARTUP_B, BOARD_COMMANDS, WAITING,
} = require('./prompts-n2-shared');

const DELM_PROMPTS_N2_SOURCE = process.env.DELM_PROMPTS_N2
  || '/data/s00791175/Delm/Delm/prompts/prompts_n2.py';

// Quietly verify the canonical reference still exists at load time.
try {
  if (fs.existsSync(DELM_PROMPTS_N2_SOURCE)) {
    fs.readFileSync(DELM_PROMPTS_N2_SOURCE, 'utf8');
  } else {
    console.warn(`[prompts-n2] reference ${DELM_PROMPTS_N2_SOURCE} not found; using inlined copy`);
  }
} catch (err) {
  console.warn(`[prompts-n2] could not read ${DELM_PROMPTS_N2_SOURCE}: ${err.message}`);
}

/**
 * Build the orchestration system-prompt for one n=2 worker. actor is
 * 'worker-A' (roster index 0 -> STARTUP_A) or 'worker-B' (STARTUP_B).
 *
 * opts.startupOverride  — replaces the canonical STARTUP_A/B text (used
 *   by harness² n2 rollouts to tune collaborative strategies without
 *   forking the whole prompt). Absent → canonical defaults.
 * opts.boardGuidanceOverride — replaces the BOARD_COMMANDS + WAITING block.
 */
function workerPrompt({ task, actor, roster, workspace, startupOverride, boardGuidanceOverride }) {
  const idx = roster.indexOf(actor);
  const startup = startupOverride || (idx === 0 ? STARTUP_A : STARTUP_B);
  const boardBlock = boardGuidanceOverride || BOARD_COMMANDS;
  return [
    `You are ${actor}, one of two agents solving this task in parallel. Roster: ${roster.join(', ')}.`,
    'Minimize elapsed time to a correct, complete submission. Divide work and exchange ' +
    'findings through the shared board — it is the only connection between the two ' +
    'workers. Each worker works in the same workspace, so preserve each other\'s edits ' +
    'and rely on the board\'s apply conflict protection. The original task remains ' +
    'authoritative for both workers; queue items divide work and never replace or weaken ' +
    'its requirements. The first worker creates the initial queue: it reserves its own ' +
    'scope, then publishes actionable peer work (or states the concrete dependency ' +
    'preventing a split). After that handoff both workers can publish, reserve, and '
    + 'claim distinct work.',
    boardBlock,
    `Your initial work:\n${startup}`,
    WAITING,
    `Task workspace: ${workspace}. Never access credential files or records. Do not obtain\nhidden tests or solutions. Do not spawn extra agents.`,
  ].join('\n\n');
}

module.exports = { workerPrompt, STARTUP_A, STARTUP_B, QUEUE_POLICY, DELM_PROMPTS_N2_SOURCE };
