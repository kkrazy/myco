// Shared prompt blocks for the n=2 team (prompts-n2.js) and the
// multi-expert team (prompts-team.js). prompts-n2.js re-exports these so
// its existing exports (QUEUE_POLICY, STARTUP_A, STARTUP_B, …) stay
// byte-identical — /run-n2 behaviour is unchanged.
//
// This module holds the reusable collaboration core (queue policy, board
// access rules, waiting discipline). It has no logic of its own.

'use strict';

// Delm prompts_n2.py QUEUE_POLICY (verbatim intent).
const QUEUE_POLICY = `Queue items are for required implementation, repair of a demonstrated defect,
or a concrete unanswered question needed to implement the solution. Do not
create separate verification, testing, review, reproduction, or solution-checker
assignments, including at a peer's request. This rule applies to queue items
created with publish or reserve. Diagnosis and measurements needed to choose or
repair an implementation remain allowed. A checker that is itself the requested
product is implementation.

Name each item's output, available inputs, shared interface and first usable dependency.
Prefer complementary outputs that both workers can implement independently. Preserve
required public behavior, interfaces and side effects. Reuse compatible components.
Do not invent work just to occupy a peer. Keep subject concise and keep detail under
~600 characters — the board tool accepts longer text, but overly long details bloat
context and slow peers.`;

// Delm prompts_n2.py STARTUP_A — the first worker in the roster (worker-A).
const STARTUP_A = `Inspect the task and existing files to choose the simplest approach that can satisfy
all stated requirements and identify complementary, reusable implementation outputs.
Read the board and incorporate useful peer findings. Establish the initial split:
reserve your scope and publish actionable, nonoverlapping work for your peer, with
available inputs, interfaces and the first usable dependency. Do not wait to complete
a whole-task plan before publishing useful work and implementing your part in this
same session. If no independent item is clear yet, state your scope and the unresolved
dependency so your peer can help resolve it. Add remaining work only as needed.`;

// Delm prompts_n2.py STARTUP_B — the second worker in the roster (worker-B).
const STARTUP_B = `Explore the actual entry point and environment in which the submitted solution runs.
Establish which files, dependencies and service state are available in a fresh invocation.
Share concrete findings that change the implementation or expose a missing prerequisite.
Leave initial queue creation to the first worker in the roster; meanwhile do useful
environment preparation and answer concrete questions that unblock implementation.
As soon as an actionable item is available, claim it and implement in this same session.
After this initial handoff, you can also reserve distinct required work.
Do not wait for a complete initial plan or keep exploring once you have enough
information to begin useful work.`;

const BOARD_COMMANDS = `Board access: use the mcp__board__* tools — there is no shell context.sh in myco.
- read: first view is complete; later views are incremental. Use read with wait>0 to
  block (at most 25s) until a peer publishes or ends; use the optional "for" to wait
  for a specific item/publication. Read the board at startup, before a new subproblem,
  before final integration, and before submitting.
- status: state a changed question, configuration, dependency or scope.
- publish: publish open items (does not claim). Matching subjects reuse existing items.
- claim: first claim wins; a loss names the owner. One unfinished claim per worker.
- reserve: atomically create and claim one scope if your claim slot is free.
- done: finish your claim with results, affected files, limitations, and checks already
  obtained; optionally attach reusable text files from the workspace or /tmp.
- note: FACT (finding supported by observations) or FAIL (contradicted approach).
  State scope and reproducible evidence.
- expand: show an attachment's diff against the task original (full for new files).
- apply: copy a peer's attachments over compatible local copies (cross-author conflict
  protection: identical = unchanged, identical to original/older peer = write,
  divergent local edit or newer peer version = conflict — nothing written).
Read the board before starting, before a new implementation subproblem or substantial
diagnostic hypothesis, before final integration, and before submitting. Choose a new
diagnostic after receiving the view, not in the invocation that first requests it.`;

const WAITING = `Waiting: do useful independent implementation, integration or diagnosis when available.
Wait only for a specific required input from a starting or running peer when none remains.
Name the missing input in status. Never use sleep, repeated polling, duplicate checks or
paperwork to fill a gap. Never wait for an ended peer.

The queue:
${QUEUE_POLICY}
After the initial handoff, claim an existing item when it fits; otherwise reserve a
distinct required implementation scope. Respect the returned owner. Ownership covers an
output, not a fixed algorithm. Publish a needed component when a peer can implement it
independently, stating its interface, inputs and nonoverlapping scope while continuing
your part. Report concrete defects through scoped FAIL notes. To hand off incomplete
work, close the claim with its remaining scope and reusable files. Keep completed items
closed. There is no global plan-closure step.

Validation and completion: derive necessary checks from the original task, not the queue
summary. Preserve required public behavior, interfaces and side effects. Before
submitting, read the board and address published corrections relevant to your final
local solution. Once applicable evidence supports satisfying all requirements and no
relevant failure remains, preserve that candidate and submit. A peer still working does
not block a complete local submission.`;

module.exports = { QUEUE_POLICY, STARTUP_A, STARTUP_B, BOARD_COMMANDS, WAITING };
