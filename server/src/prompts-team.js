// Multi-expert team orchestration system-prompts (专家团 mode).
//
// Based on prompts-n2.js (Delm prompts_n2.py): the CORE collaboration logic
// — queue policy, board access rules, waiting discipline, validation — is
// reused VERBATIM from prompts-n2.js. What changes is the ROLE definition:
// instead of the fixed STARTUP_A / STARTUP_B prompts (A creates the queue,
// B claims), each expert in the roster is defined by its SKILLS (chosen
// from the skill market when the expert was created). The first expert in
// the roster still plays the "creates the initial queue" role (STARTUP_A's
// coordination duty), because the board protocol needs exactly one queue
// initializer; every expert carries its skills as its specialty.
//
// /run-n2 (TeamSession without opts.experts) keeps using prompts-n2.js
// STARTUP_A/B byte-identically — this module is only consulted when
// TeamSession is constructed with per-worker `skills`.

'use strict';

const {
  QUEUE_POLICY, BOARD_COMMANDS, WAITING, STARTUP_A, STARTUP_B,
} = require('./prompts-n2-shared');

// Role text for the queue-initializing expert (roster index 0). Keeps
// STARTUP_A's coordination duty (establish the initial split) and adds the
// expert's own skills as its specialty.
const EXPERT_LEAD = `You are the first expert in the roster — the queue initializer. Inspect the
task and existing files to choose the simplest approach that can satisfy all
stated requirements and identify complementary, reusable implementation
outputs. Read the board and incorporate useful peer findings. Establish the
initial split: reserve your own scope, then publish actionable, nonoverlapping
work for the other experts, with available inputs, interfaces and the first
usable dependency. Do not wait to complete a whole-task plan before
publishing useful work and implementing your part in this same session. If
no independent item is clear yet, state your scope and the unresolved
dependency so a peer can help resolve it. Add remaining work only as needed.`;

// Role text for every other expert: claim + implement, don't create the
// initial queue (STARTUP_B's discipline generalized from "one peer" to N).
const EXPERT_MEMBER = `Explore the actual entry point and environment relevant to your specialty.
Establish which files, dependencies and service state are available in a
fresh invocation. Share concrete findings that change the implementation or
expose a missing prerequisite. Leave initial queue creation to the first
expert in the roster; meanwhile do useful preparation within your specialty
and answer concrete questions that unblock implementation. As soon as an
actionable item is available, claim it and implement in this same session.
After the initial handoff, you can also reserve distinct required work. Do
not wait for a complete initial plan or keep exploring once you have enough
information to begin useful work.`;

/**
 * Build the orchestration system-prompt for one multi-expert worker.
 *
 * @param {object} p
 * @param {string} p.task     the original task text
 * @param {string} p.actor    roster id, e.g. 'worker-A'
 * @param {string[]} p.roster full roster
 * @param {string} p.workspace
 * @param {Array<{name:string, description:string}>} [p.skills]
 *        the expert's skills (from the skill market). Empty/absent → the
 *        expert is a generalist (no specialty paragraph).
 * @param {number} [p.nWorkers] roster size (used in the intro line).
 */
function expertPrompt({ task, actor, roster, workspace, skills, nWorkers }) {
  const idx = roster.indexOf(actor);
  const skillList = Array.isArray(skills) ? skills : [];
  const skillLines = skillList.length
    ? skillList.map((s) => `- ${s.name}${s.description ? ': ' + s.description : ''}`).join('\n')
    : '- (generalist — no specific skills assigned)';
  const specialty = `Your specialty — the skills that define you as an expert (prefer work that
matches them, and bring their discipline to everything you do):
${skillLines}`;
  return [
    `You are ${actor}, one of ${nWorkers || roster.length} experts solving this task in parallel as a team. Roster: ${roster.join(', ')}.`,
    'Minimize elapsed time to a correct, complete submission. Divide work and exchange ' +
      'findings through the shared board — it is the only connection between the ' +
      'experts. Each expert works in the same workspace, so preserve each other\'s edits ' +
      'and rely on the board\'s apply conflict protection. The original task remains ' +
      'authoritative for every expert; queue items divide work and never replace or ' +
      'weaken its requirements. The first expert creates the initial queue: it reserves ' +
      'its own scope, then publishes actionable peer work (or states the concrete ' +
      'dependency preventing a split). After that handoff every expert can publish, ' +
      'reserve, and claim distinct work.',
    specialty,
    BOARD_COMMANDS,
    `Your initial work:\n${idx === 0 ? EXPERT_LEAD : EXPERT_MEMBER}`,
    WAITING,
    `Task workspace: ${workspace}. Never access credential files or records. Do not obtain\nhidden tests or solutions. Do not spawn extra agents.`,
  ].join('\n\n');
}

module.exports = { expertPrompt, EXPERT_LEAD, EXPERT_MEMBER };
