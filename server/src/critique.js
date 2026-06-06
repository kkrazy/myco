const fs = require('fs');
const path = require('path');
const sessionsMod = require('./sessions');
const { getCritic } = require('./critics');
// fr-95: specialty registry — orthogonal axis from the model registry
// above. See critics/specialties/index.js for the fan-out order +
// gating contract.
const { FINAL_SPECIALTIES, INTERMEDIATE_SPECIALTIES } = require('./critics/specialties');
// bug-65: critic prompts are now loaded from .md files in
// critics/prompts/ for easy review (no JS escape noise). The loader
// caches on first require. See critics/prompts/index.js + the
// sibling .md files.
const criticPrompts = require('./critics/prompts');
const runQueue = require('./runQueue');

// td-33 r2: context enrichment caps. User-reported (verbatim):
// "should always make enough information is provided to the critic
// for full assessment". The pre-r2 prompt contained ONLY the diff
// hunks — surrounding file context, prior iteration history, and
// the file's relationship to nearby code were invisible. This drove
// the critic to bail with INSUFFICIENT INFORMATION on changes that
// would have been clear with full context. r2 adds two new prompt
// blocks (FULL FILE CONTEXT + PLAN ITEM HISTORY) inside firm caps
// so the prompt doesn't blow up the model's context window.
const FILE_CONTEXT_MAX_PER_FILE = 16_000;   // per-file cap (chars)
const FILE_CONTEXT_TOTAL_CAP    = 64_000;   // aggregate cap across all files
const HISTORY_RUNS_MAX          = 3;        // most recent runs to include
const HISTORY_COMMENTS_MAX      = 5;        // most recent comments
const HISTORY_BLOCK_MAX_CHARS   = 16_000;   // safety cap on the history block
// fr-94 Phase 1: delegate _myco_/ path resolution to the shared
// helper in artifacts.js. The helper honors rec.mainProject (the
// explicit project root set at session creation) and falls back
// to auto-detection. Pre-fr-94 this file hand-rolled
// `path.join(absCwd, '_myco_', 'critic.md')` which always wrote to
// session-root — wrong on sessions whose actual project lives in
// a subdirectory.
const { resolveMycoDir } = require('./artifacts');

// fr-89: load the project's _myco_/critic.md so its content can be
// appended to the critic's system prompt. On the first critique run
// for a project (file missing), seed it from the myco-shipped default
// at server/templates/critic.md so the critic always has a baseline
// of project-relevant rules + anti-patterns. The file is project-
// owned after seeding — myco template updates do NOT overwrite local
// edits. To reset to the default, delete `_myco_/critic.md` and
// trigger another critic run.
//
// Returns the file's content as a string, or '' if the load failed
// (the critique still runs, just without the project-specific rules
// — graceful degradation).
function _loadProjectCriticRules(rec) {
  // fr-94 Phase 1: resolveMycoDir(rec) honors rec.mainProject (the
  // designated project root for this session) or falls back to the
  // legacy auto-detect (look for .git/ in absCwd or one subdir
  // deep). Pre-fr-94 this hand-rolled `path.join(absCwd, '_myco_',
  // ...)` and always wrote to session-root — wrong on sessions
  // whose actual project lives in a subdirectory.
  const mycoDir = resolveMycoDir(rec);
  if (!mycoDir) {
    console.warn('[fr-89] no project root resolvable for this session — skipping critic.md');
    return '';
  }
  const rulesPath = path.join(mycoDir, 'critic.md');
  try {
    if (!fs.existsSync(rulesPath)) {
      const templatePath = path.join(__dirname, '..', 'templates', 'critic.md');
      if (fs.existsSync(templatePath)) {
        fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
        fs.copyFileSync(templatePath, rulesPath);
        console.log(`[fr-89] seeded ${rulesPath} from myco default template`);
      } else {
        console.warn('[fr-89] myco-shipped default critic.md template missing — running critique without project rules');
        return '';
      }
    }
    return fs.readFileSync(rulesPath, 'utf8');
  } catch (err) {
    console.error(`[fr-89] failed to load project critic.md: ${err && err.message ? err.message : err}`);
    return '';
  }
}

// td-33: critic-error detection. When the SDK returns an envelope like
// "(Gemini call failed: ...)" / "(Gemini API key missing...)" / etc.,
// the critique payload is unusable and we want to surface a ↻ Retry
// affordance instead of a malformed verdict. The wrappers consistently
// emit a parenthesised "(X failed: ...)" or "(X error: ...)" shape;
// the same pattern catches missing-key sentinels too. Any string that
// fits is broadcast with isError=true so the client renders the retry
// button + skips the run-queue-pause logic (a verdict that never
// happened can't gate a queue advance).
function _looksLikeCriticError(critique) {
  const s = String(critique || '').trim();
  if (!s) return true;                              // empty verdict = error
  // The wrappers prefix with "(": "(Gemini call failed: ...)",
  // "(Gemini API key missing...)", "(no Gemini key provided)", etc.
  if (!s.startsWith('(')) return false;
  return /failed|missing|error|invalid|timeout|rate.?limit|quota|503|429|401|400/i.test(s);
}

// td-33 r2: build a FULL FILE CONTEXT block from the list of changed
// entries. Reads each file from disk + caps per-file at
// FILE_CONTEXT_MAX_PER_FILE and aggregate at FILE_CONTEXT_TOTAL_CAP.
// Returns an empty string when no entries are passed (intermediate
// critiques fired by stage-done don't have the changed-entries plumbing
// today; they fall back to the pre-r2 behavior of diff-only context).
//
// File-path resolution mirrors attach.js: entry.path is relative to
// the git root (which _findGitRoot may resolve to a sub-dir of
// rec.absCwd for fr-94 sessions where mainProject is set). path.join
// of rec.absCwd + entry.path gives the absolute path in either case.
function _buildFileContextBlock(changedEntries, recAbsCwd) {
  if (!Array.isArray(changedEntries) || changedEntries.length === 0) return '';
  if (!recAbsCwd) return '';
  const parts = [];
  let totalChars = 0;
  let included = 0;
  let truncated = 0;
  for (const entry of changedEntries) {
    if (!entry || !entry.path) continue;
    if (totalChars >= FILE_CONTEXT_TOTAL_CAP) break;
    let content = '';
    try { content = fs.readFileSync(path.join(recAbsCwd, entry.path), 'utf8'); }
    catch { continue; }                     // file deleted / unreadable — skip
    const origLen = content.length;
    if (origLen > FILE_CONTEXT_MAX_PER_FILE) {
      content = content.slice(0, FILE_CONTEXT_MAX_PER_FILE)
        + `\n\n[...truncated, ${origLen - FILE_CONTEXT_MAX_PER_FILE} of ${origLen} chars omitted to stay under the per-file cap]`;
      truncated++;
    }
    if (totalChars + content.length > FILE_CONTEXT_TOTAL_CAP) {
      const room = Math.max(0, FILE_CONTEXT_TOTAL_CAP - totalChars);
      if (room <= 200) break;                  // not worth a tiny tail
      content = content.slice(0, room) + `\n\n[...truncated to fit aggregate budget]`;
    }
    parts.push(`--- File: ${entry.path} (${origLen} chars) ---\n${content}`);
    totalChars += content.length;
    included++;
  }
  if (parts.length === 0) return '';
  const header = `\n\n=== FULL FILE CONTEXT (current contents of the ${included} file${included === 1 ? '' : 's'} changed above${truncated > 0 ? `; ${truncated} truncated to fit budget` : ''}) ===\nUse this to evaluate the change against the surrounding code — imports, related functions, type usages, etc. — not just the diff hunks. The DIFF block above is still the primary signal for "what changed"; this block is the BACKGROUND so you can tell whether the change is consistent with the rest of the file.\n`;
  return header + parts.join('\n\n');
}

// td-33 r2: surface the plan item's recent run history so the
// critic understands "what's been tried" + (critical for bug-65
// code-stage critique) what the PREVIOUS stage's claude output was.
// The most recent entry == the analyze-stage plan when this is the
// code-stage critique; the most recent two == analyze + code plans
// when this is the verify-stage critique.
//
// bug-65: moved item.comments out of this block (they're not "what
// was tried" — they're user discussion + clarifications belonging
// with the problem statement). Comments now go into _buildProblemBlock
// at the top of userPrompt.
// bug-65: bumped per-run summary cap 800 → 2000 chars so the
// previous stage's plan fits without truncation (analyze plans can
// easily exceed 800).
//
// Includes:
//   · Last HISTORY_RUNS_MAX runs (most recent first) with status +
//     summary up to HISTORY_RUN_SUMMARY_CAP chars each.
// Capped at HISTORY_BLOCK_MAX_CHARS total — overrun is truncated.
const HISTORY_RUN_SUMMARY_CAP = 2000;          // bug-65: was 800 (inline)
function _buildHistoryBlock(item) {
  if (!item) return '';
  const runs = Array.isArray(item.runs) ? item.runs.slice(-HISTORY_RUNS_MAX).reverse() : [];
  if (runs.length === 0) return '';
  const lines = [];
  lines.push(`\n\n=== PLAN ITEM HISTORY (${item.id || 'unknown id'} — last ${runs.length} run${runs.length === 1 ? '' : 's'}, most recent first) ===`);
  lines.push(`The most recent entry is claude's PREVIOUS stage output in this multi-turn run. For code-stage critique, the previous run is the analyze-stage plan; use this to verify the diff implements that plan. A change that looks like a regression in isolation may be the second-best iteration after a prior approach was rejected, or a follow-up to a user-reported gap. Use this history to calibrate the review.\n`);
  lines.push(`--- Recent runs (most recent first) ---`);
  for (const r of runs) {
    const ts = r.ts || '?';
    const status = r.status || '?';
    const summary = String(r.summary || r.result || '').slice(0, HISTORY_RUN_SUMMARY_CAP);
    lines.push(`· [${ts}] (${status}) ${summary}`);
  }
  let out = lines.join('\n');
  if (out.length > HISTORY_BLOCK_MAX_CHARS) {
    out = out.slice(0, HISTORY_BLOCK_MAX_CHARS) + `\n\n[...history truncated to ${HISTORY_BLOCK_MAX_CHARS} chars to fit budget]`;
  }
  return out;
}

// bug-65: build the USER-REPORTED PROBLEM block that leads the user
// prompt. Combines item.text (the original problem statement) +
// item.comments (user discussion + clarifications, which often
// contain critical refinements to the original report). The critic
// must evaluate claude's work against this combined problem
// statement, not just the original item.text.
//
// Comments are surfaced most-recent first up to HISTORY_COMMENTS_MAX
// (the existing td-33 r2 cap, preserved). Each comment is trimmed
// to a reasonable per-comment cap to keep the block bounded.
const PROBLEM_COMMENT_CAP_PER_ENTRY = 800;
function _buildProblemBlock(item) {
  if (!item) return '';
  const lines = [];
  lines.push(`=== USER-REPORTED PROBLEM (the criterion for your verdict) ===`);
  lines.push(`Plan item: ${item.id || 'unknown'}${item.layer ? ` (${item.layer})` : ''}`);
  lines.push(``);
  lines.push(`User's report:`);
  lines.push(String(item.text || '(no text on this plan item)'));
  const comments = Array.isArray(item.comments) ? item.comments.slice(-HISTORY_COMMENTS_MAX).reverse() : [];
  if (comments.length > 0) {
    lines.push(``);
    lines.push(`User discussion + clarifications (plan-item comments, most recent first):`);
    for (const c of comments) {
      const ts = c.ts || '?';
      const user = c.user || '?';
      const text = String(c.text || '').slice(0, PROBLEM_COMMENT_CAP_PER_ENTRY);
      lines.push(`· [${ts}] @${user}: ${text}`);
    }
  }
  lines.push(``);
  lines.push(`YOUR JOB: evaluate whether Claude's work below solves THIS problem, taking the full discussion context into account.`);
  return lines.join('\n');
}

async function triggerGeminiCritique(sessionId, session, item, diff, claudeOutput, opts = {}) {
  // td-33: opts.isIntermediate flags a stage-checkpoint critique fired
  // mid-run (claude announced [stage: analyze done] / [stage: code
  // done] / [stage: verify done] in its assistant text). Intermediate
  // critiques broadcast for the user's awareness but do NOT pause the
  // run queue — pausing on every stage transition would freeze
  // multi-step work behind a sequence of approvals. Only the FINAL
  // critique (the one fired on turn_result success) gates queue
  // advance, matching pre-td-33 behavior.
  const isIntermediate = !!(opts && opts.isIntermediate);
  const stage = (opts && opts.stage) || null;
  const isRetry = !!(opts && opts.isRetry);
  // bug-52: optional follow-up prompt the user types into the verdict
  // pane's input field. Append to the critic's user-prompt so Gemini
  // looks into the specific concern the user flagged on top of the
  // standard review. Empty/whitespace inputs are ignored. Capped at
  // 2 KB to keep the prompt budget under control.
  const userFollowupRaw = (opts && typeof opts.userPrompt === 'string') ? opts.userPrompt.trim() : '';
  const userFollowup = userFollowupRaw.slice(0, 2048);

  const rec = sessionsMod.getSessionRecord(sessionId);
  // td-33 r1 (Gemini critique catch — 2026-06-03): the original
  // ordering paused the queue BEFORE running the critic. That meant
  // a critic-error result (Gemini 503, missing key, etc.) left the
  // queue paused with only a ↻ Retry button — if retries kept
  // failing, the user was stuck. The pause now happens AFTER the
  // critic returns, gated on `!isError` so error verdicts don't
  // freeze the queue. The window between turn_result and the pause
  // is small (one Gemini API call, ~5-60s) and harmless: the
  // critique gate in attach.js returns early on triggerGeminiCritique
  // success so _advanceRunQueue isn't called during that window.

  // td-33 (A — retry support): cache the inputs on rec so the ↻ Retry
  // button can re-fire this exact critique without round-tripping the
  // full diff back through the client. Cache is overwritten on each
  // fire (we only support retrying the MOST RECENT critique — older
  // ones are out of scope per "no speculative features").
  if (rec) {
    rec._lastCritique = {
      itemId: item && item.id,
      itemSnapshot: item,
      diff,
      claudeOutput,
      isIntermediate,
      stage,
      // td-33 r2: cache the changed-entries list so a Retry uses the
      // same file-context enrichment as the original fire.
      changedEntries: opts && Array.isArray(opts.changedEntries) ? opts.changedEntries : [],
      firedAt: new Date().toISOString(),
    };
    sessionsMod.saveStore();
  }

  // Resolve critic plugin dynamically (default to rec.criticModel, then env, then gemini)
  const criticId = (rec && rec.criticModel) || process.env.MYCO_CRITIC_MODEL || 'gemini';
  const critic = getCritic(criticId);

  // bug-65: the basePrompt now lives in
  // server/src/critics/prompts/base.md and is loaded via the
  // criticPrompts loader. The framing has shifted from "elite QA
  // auditor" (generic code review) to "plan-item-driven problem-
  // solving validator" — the PRIMARY criterion is now "does Claude's
  // work solve the user-reported problem?", with code quality /
  // security / test sufficiency as secondary criteria. See base.md
  // for the full content + the bug-65 plan item for the user
  // report that motivated the rewrite.
  //
  // fr-95 cache-optimized layout is preserved: `basePrompt` is the
  // STABLE PREFIX of the system instruction across all three
  // specialties in a single fan-out. The per-specialty `systemSuffix`
  // (also loaded from sibling .md files per bug-65) appends at the
  // TAIL. The user prompt (problem block + claudeOutput + diff +
  // file context + history + follow-up) is bit-for-bit identical
  // across the fan-out, so Gemini 2.5's prefix cache hits the heavy
  // tail on calls 2 and 3.
  //
  // The "✓ AGREED" sentinel string is preserved exactly — detection
  // (`critique.includes('✓ AGREED')`) still works. Disagreement now
  // is explicitly signaled with "✗ DISAGREE" too (bug-65 + bug-63).
  const basePrompt = criticPrompts.base;

  // fr-89: append project-specific critic rules from
  // <project>/_myco_/critic.md to the base system prompt. The file
  // is seeded from the myco default template on first run for a
  // project; project-owned thereafter (user edits don't get clobbered
  // on subsequent runs).
  // fr-94 Phase 1: _loadProjectCriticRules now takes the full `rec`
  // so it can call resolveMycoDir(rec) — that helper honors
  // rec.mainProject (the designated project root for this session)
  // or falls back to legacy auto-detect.
  const projectCriticRules = rec ? _loadProjectCriticRules(rec) : '';
  // fr-95: `systemPromptPrefix` is the stable head shared across every
  // specialty in the fan-out. The variable specialty.systemSuffix gets
  // appended per call below — the prefix stays bit-for-bit identical
  // so prefix-caching at the model layer (Gemini 2.5 implicit) hits
  // on calls 2 + 3 of the fan-out.
  const systemPromptPrefix = projectCriticRules
    ? `${basePrompt}\n\n=== Project-specific critic rules (from _myco_/critic.md) ===\nThese extend, but never override, the above instructions.\n\n${projectCriticRules}`
    : basePrompt;

  // bug-65: stage-aware addendum. The pre-bug-65 checkpoint preamble
  // (td-33 B) was a generic "mid-run checkpoint" header — useful for
  // calibrating expectations, but didn't tell the critic WHAT to
  // focus on per stage. The new stageAddendum loads the per-stage
  // prompt from .md (server/src/critics/prompts/stage-{X}.md) which
  // tells the critic precisely what to evaluate at this checkpoint:
  //   · analyze stage: evaluate the PLAN against the problem
  //     (no diff exists yet)
  //   · code stage: verify the diff implements the analyze plan
  //     (read the PREVIOUS run summary in history) AND solves
  //     the user's problem
  //   · verify stage: confirm regression net is complete; test
  //     wired to test.sh; would catch a future re-introduction
  //   · final (turn_result success, non-intermediate): full-run
  //     verdict gating queue advance
  // Each addendum is also stage-specific about what NOT to demand
  // (e.g. "don't demand a test at analyze stage").
  let stageAddendum;
  if (isIntermediate) {
    const stageLc = String(stage || 'unknown').toLowerCase();
    if (stageLc === 'analyze') stageAddendum = criticPrompts.stageAnalyze;
    else if (stageLc === 'code') stageAddendum = criticPrompts.stageCode;
    else if (stageLc === 'verify') stageAddendum = criticPrompts.stageVerify;
    else stageAddendum = criticPrompts.stageFinal;       // unknown intermediate → safest is final framing
  } else {
    stageAddendum = criticPrompts.stageFinal;
  }
  // bug-52: when the user typed a follow-up prompt into the verdict
  // pane's input field, surface it as a TOP-PRIORITY instruction so
  // Gemini centers its review on that concern. Without the explicit
  // "user is specifically asking" framing, the model often gives the
  // same generic review and ignores the user's question.
  const userFollowupBlock = userFollowup
    ? `\n\n[USER FOLLOW-UP — give this priority over the generic review]\nThe user has typed the following concern they want you to look into specifically:\n"${userFollowup}"\nAddress this concern explicitly in your reasoning. If the diff doesn't have enough information to answer it, say so plainly.\n`
    : '';
  // td-33 r2: build the file-context block. opts.changedEntries is
  // passed through from attach.js's critique gate (the same list
  // listChangedFiles returns, filtered by the baseline-dirty
  // exclusion). recAbsCwd needed for absolute file resolution.
  const fileContextBlock = _buildFileContextBlock(
    opts && Array.isArray(opts.changedEntries) ? opts.changedEntries : [],
    rec && rec.absCwd
  );
  const historyBlock = _buildHistoryBlock(item);
  // bug-65: build the problem block (item.text + item.comments).
  // Comments moved from history block (where td-33 r2 placed them)
  // to here because they are user-discussion that refines the
  // problem statement, not "what's been tried."
  const problemBlock = _buildProblemBlock(item);

  // bug-65: userPrompt restructure. The PROBLEM now leads (it's the
  // criterion against which everything else is judged). The
  // stageAddendum precedes the problem block to tell the critic
  // what kind of evaluation they're doing this turn. Claude's
  // explanation, diff, file context, and history follow as
  // supporting evidence. The user follow-up block (bug-52) stays
  // at the end as the highest-priority steerable.
  const userPrompt = `${stageAddendum}

${problemBlock}

=== CLAUDE'S EXPLANATION (this turn) ===
${claudeOutput}

=== STAGED GIT CHANGES ===
${diff}
${fileContextBlock}${historyBlock}${userFollowupBlock}`;

  const label = isIntermediate ? `intermediate-${stage}` : 'final';

  // fr-95: specialty fan-out. Intermediate critiques run general-only
  // (cost containment — 3 stages × 3 specialties = 9 calls per plan
  // item is too noisy at checkpoints). Final critiques fan out across
  // all three specialties. The GENERAL specialty always runs first
  // because its verdict gates the run queue — its isAgreed result
  // decides whether the queue pauses (specialty critics are
  // INFORMATIONAL by design).
  const specialties = isIntermediate ? INTERMEDIATE_SPECIALTIES : FINAL_SPECIALTIES;
  const sectionVerdicts = [];
  let generalIsError = false;
  let generalIsAgreed = false;
  for (const specialty of specialties) {
    const systemPromptForSpecialty = systemPromptPrefix + specialty.systemSuffix;
    console.log(`[critique] Invoking critic "${critic.name}" (${critic.id}) — specialty=${specialty.id} for item ${item.id} (${label}${isRetry ? ', retry' : ''})...`);
    const verdict = await critic.runCritique(userPrompt, systemPromptForSpecialty);
    const specialtyIsError = _looksLikeCriticError(verdict);
    const specialtyIsAgreed = !specialtyIsError && verdict.includes('✓ AGREED');
    console.log(`[critique] "${critic.name}" specialty=${specialty.id} complete for ${item.id} (${label}). Agreement=${specialtyIsAgreed} isError=${specialtyIsError}`);
    sectionVerdicts.push({ specialty, verdict, isError: specialtyIsError, isAgreed: specialtyIsAgreed });
    if (specialty.id === 'general') {
      generalIsError = specialtyIsError;
      generalIsAgreed = specialtyIsAgreed;
    }
  }

  // Concatenate verdicts under section headers for the single broadcast.
  // Single-specialty (intermediate) runs render flat — no header — so
  // the pre-fr-95 verdict pane behavior is preserved at checkpoints.
  let critique;
  if (sectionVerdicts.length === 1) {
    critique = sectionVerdicts[0].verdict;
  } else {
    critique = sectionVerdicts
      .map(({ specialty, verdict }) => `## ${specialty.name} critic\n\n${verdict}`)
      .join('\n\n---\n\n');
  }

  // Queue gating + error surface follows the GENERAL critic only. A
  // perf-security flag is informational; a general-critic flag is the
  // one that pauses the queue.
  const isError = generalIsError;
  const isAgreed = generalIsAgreed;

  // td-33 r1: pause the run queue NOW (only for non-error, non-
  // intermediate critiques). Error verdicts intentionally leave the
  // queue free so the user isn't trapped by a 503-retry loop.
  if (rec && !isIntermediate && !isError) {
    rec.runQueuePaused = true;
    sessionsMod.saveStore();
    session.emit('state-update', { kind: 'runQueue', state: runQueue.getQueueState(rec) });
  }

  // Broadcast the critique event over WebSockets with brand metadata.
  // td-33: isError lets the client render a ↻ Retry button; isIntermediate
  // lets the client render a [Checkpoint: <stage>] badge + skip the
  // run-queue-pause-banner. The diff is included so a future client
  // could expose "diff at checkpoint" if useful.
  // fr-95: `specialties` carries per-specialty isAgreed/isError so a
  // future client can render per-section badges; today's pane just
  // displays the concatenated markdown body.
  const broadcastPayload = {
    kind: 'critique-review',
    itemId: item.id,
    hasDisagreement: !isAgreed,
    isError,
    isIntermediate,
    isRetry,
    stage,
    critique: critique,
    diff: diff,
    criticName: critic.name,
    criticId: critic.id,
    specialties: sectionVerdicts.map(({ specialty, isError: e, isAgreed: a }) => ({
      id: specialty.id,
      name: specialty.name,
      isError: e,
      isAgreed: a,
    })),
  };
  session.emit('state-update', broadcastPayload);

  // fr-98: persist the verdict payload at item.meta.lastCriticReview
  // so a fresh attach (new device, post-restart) sees the same pane
  // the originating device saw. Without this the verdict was a fire-
  // once broadcast — every device that wasn't attached at fire time
  // ended up with stageState=awaiting_accept but no pane to render,
  // leaving the run un-resolvable.
  //
  // Cleared on every resolve path (verify-accept / discard via
  // clearActiveRunItem → _clearAndBroadcastStageState; accept-stage /
  // fix-stage via resolveCritique below) so resolved verdicts don't
  // ghost-replay on next attach. Skipped on error verdicts because
  // the matching stageState transition is also skipped (the user
  // hasn't seen a real verdict yet — see the fr-96 block below).
  if (rec && !isError) {
    try {
      const stageStateMod = require('./stageState');
      const attachMod = require('./attach');
      const refreshedItem = attachMod._findPlanItemInRec(rec, item.id) || item;
      stageStateMod.setLastCriticReview(refreshedItem, broadcastPayload);
      sessionsMod.saveStore();
    } catch (err) {
      console.error(`[fr-98] persist lastCriticReview failed for ${item.id}: ${err.message}`);
    }
  }

  // fr-96: critic verdict broadcast → awaiting_accept transition.
  // Only fires on non-error verdicts (error keeps the previous
  // status — the user hasn't seen a real verdict yet, so the state
  // machine shouldn't advance). For intermediate critiques, the
  // stage in opts.stage is the stage being reviewed. For final
  // critiques, stage falls back to 'verify' since the final critique
  // fires after [stage: verify done] (in the 3-stage methodology) or
  // after a one-shot turn_result (legacy — no stageState exists, so
  // applyTransition is a no-op anyway).
  if (!isError) {
    try {
      const attachMod = require('./attach');
      const transitionStage = stage || 'verify';
      attachMod._transitionStageState(sessionId, session, item.id, transitionStage, 'awaiting_accept');
    } catch (err) {
      console.error(`[fr-96] critique broadcast → awaiting_accept failed: ${err.message}`);
    }
  } else {
    // bug-68: surface the critic-error in chat. Pre-bug-68 the error
    // broadcast landed (isError:true) but the user saw a verdict pane
    // with a ↻ Retry button + no explanation of why the error
    // occurred (Gemini 503, malformed output, etc.) — and from the
    // user's POV "the critic didn't show up" because it didn't
    // produce a real verdict. The system note tells them clearly:
    // "the critic call errored; click ↻ Retry to try again."
    try {
      const note = {
        user: 'system',
        text: `⚠️ Critic call for **${item.id}** (${stage || 'final'} stage) errored. The verdict pane shows a ↻ Retry button — click it to re-fire the critic. If the error persists, check the server log for the underlying cause (Gemini 503 / quota / malformed response).`,
        ts: new Date().toISOString(),
        meta: { kind: 'bug-68-critique-error', stage: stage || 'final', itemId: item.id },
      };
      sessionsMod.appendChatMessage(sessionId, note);
      session.emit('chat', note);
      console.log(`[bug-68] critique-error note emitted for ${item.id} stage=${stage || 'final'}`);
    } catch (err) {
      console.error(`[bug-68] critique-error note emit failed: ${err.message}`);
    }
  }
}

// td-33 (A — retry support): re-fire the most recently cached
// critique inputs for this session. Returns true on success, false
// when there's nothing to retry (e.g. server restarted + cache lost,
// or no critique has ever fired on this session). The retried
// critique broadcasts with isRetry=true so the client can render a
// "retrying…" → fresh verdict transition.
//
// bug-52: opts.userPrompt is the optional follow-up prompt the user
// typed into the verdict pane's input field. When set, the next
// critique is steered to address that specific concern. Caller
// (the /critique/retry route) passes it through from the request body.
async function retryLastCritique(sessionId, session, opts = {}) {
  const rec = sessionsMod.getSessionRecord(sessionId);
  if (!rec || !rec._lastCritique) return false;
  const last = rec._lastCritique;
  if (!last.itemSnapshot || !last.itemId) return false;
  await triggerGeminiCritique(sessionId, session, last.itemSnapshot, last.diff, last.claudeOutput, {
    isIntermediate: last.isIntermediate,
    stage: last.stage,
    isRetry: true,
    userPrompt: opts && typeof opts.userPrompt === 'string' ? opts.userPrompt : '',
    // td-33 r2: pass through the cached changedEntries so retries
    // get the same file-context enrichment as the original fire.
    changedEntries: Array.isArray(last.changedEntries) ? last.changedEntries : [],
  });
  return true;
}

// bug-54: broadcast that the verdict pane has been resolved so every
// device attached to this session clears its own copy of the pane.
// Pre-fix the four "resolving" buttons (✗ Dismiss / ✗ Discard /
// ⚡ Ask Claude to Fix / ✓ Accept Claude) cleared LOCAL state only —
// other devices stayed showing a now-stale verdict pane until a
// fresh critique-review broadcast landed (which might never happen
// for a Dismiss or after a successful Accept). User-reported:
//   "Critic popover stays open after being handled on another
//    device/user"
//
// The broadcast carries the itemId + a short `reason` string for
// audit/debug. No server-side persistent state changes — clients
// simply clear their pane on receipt. The originating device also
// receives its own broadcast; the client-side guard (only clear if
// awaitingVerdict or critiqueReview is truthy) makes this an
// idempotent no-op there.
//
// The ↻ Retry and 💬 Ask Critic buttons do NOT call this — they
// RE-FIRE the critique, which produces a new `critique-review`
// broadcast that naturally replaces the old verdict on every device.
function resolveCritique(sessionId, session, opts = {}) {
  if (!session) return false;
  const reason = (opts && typeof opts.reason === 'string') ? opts.reason : 'unknown';
  const itemId = (opts && opts.itemId) || null;
  session.emit('state-update', {
    kind: 'critique-resolved',
    itemId,
    reason,
  });
  // fr-96: button-driven stage-state transitions. The Accept Stage /
  // Fix Stage buttons (intermediate verdict pane, bug-56) send a
  // reason that drives the state machine forward. For the other
  // reasons (dismiss/discard/fix/accept on final), the appropriate
  // transitions fire elsewhere:
  //   discard / accept (verify-stage final) → clearStageState fires
  //     via clearActiveRunItem when /run/done route hits (bug-57).
  //   dismiss → no state-machine change. The user wanted to close
  //     the pane without a decision; state stays at awaiting_accept.
  //   fix (final) → no state-machine change here either. The button
  //     dispatches a re-prompt to Claude; the next [stage: X done]
  //     sentinel will land the next transition.
  if (itemId && (reason === 'accept-stage' || reason === 'fix-stage')) {
    try {
      const attachMod = require('./attach');
      const stageStateMod = require('./stageState');
      const rec = sessionsMod.getSessionRecord(sessionId);
      const item = attachMod._findPlanItemInRec(rec, itemId);
      const cur = stageStateMod.getStageState(item);
      // fr-98: clear the persisted verdict regardless of stageState
      // race — the user has acted on this verdict (accept or fix),
      // so it should NOT replay on the next attach. The fr-96
      // transition below moves stageState forward; clearing
      // lastCriticReview here is the matching half of the bug-54
      // cross-device sync, just for the persisted slot.
      // bug-68: fix-stage needs the verdict body to dispatch to
      // claude — capture it BEFORE clearing.
      let savedReview = null;
      if (item && reason === 'fix-stage') {
        savedReview = stageStateMod.getLastCriticReview(item);
      }
      if (item && stageStateMod.clearLastCriticReview(item)) {
        sessionsMod.saveStore();
      }
      // bug-68: restore the verdict for the fix-stage prompt so
      // _postAcceptStagePrompt can read it. We only need the
      // critique body field; the rest of the payload is irrelevant
      // to claude's redo prompt. Restored temporarily so the helper
      // can read it; the saveStore above already persisted the
      // cleared state, and the helper's read does not re-save.
      if (item && reason === 'fix-stage' && savedReview) {
        if (!item.meta) item.meta = {};
        item.meta.lastCriticReview = savedReview;
      }
      if (!cur) {
        // Race: item has no stageState (cleared by another path).
        // No-op (the verdict clear above already landed).
      } else if (reason === 'accept-stage') {
        // Advance to next stage. nextStage('verify') returns null;
        // a verify-stage accept-stage button shouldn't normally
        // fire (verify Accept routes through the final pane, not
        // intermediate). Defensive: if next is null, no-op.
        const next = stageStateMod.nextStage(cur.stage);
        if (next) {
          attachMod._transitionStageState(sessionId, session, itemId, next, 'in_progress');
          // bug-68: notify claude. Pre-bug-68 the button accept
          // ended here — the modal closed + stageState advanced, but
          // claude received no input. User had to type "continue".
          attachMod._postAcceptStagePrompt(sessionId, session, {
            itemId, stage: cur.stage, next, reason: 'accept-stage',
          });
        }
      } else {
        // Fix Stage — redo current stage. Same stage, back to
        // in_progress.
        attachMod._transitionStageState(sessionId, session, itemId, cur.stage, 'in_progress');
        // bug-68: dispatch the critic's flagged-issues body to claude
        // as a synthetic turn so claude knows what to redo. Without
        // this, the modal closed + stageState reset to in_progress
        // but claude received nothing and sat idle.
        attachMod._postAcceptStagePrompt(sessionId, session, {
          itemId, stage: cur.stage, reason: 'fix-stage',
        });
      }
      // bug-68: re-clear the temporarily-restored lastCriticReview
      // for fix-stage now that the helper has consumed it. Otherwise
      // a future attach would replay a verdict that the user has
      // already acted on. saveStore again so disk matches memory.
      if (item && reason === 'fix-stage' && savedReview) {
        stageStateMod.clearLastCriticReview(item);
        sessionsMod.saveStore();
      }
    } catch (err) {
      console.error(`[fr-96] resolveCritique → stageState transition (${reason}) failed: ${err.message}`);
    }
  }
  // bug-64: fire any deferred final critique. The turn_result-success
  // IIFE in attach.js may have deferred the final critique because an
  // intermediate verdict was still unresolved at the time. Now that
  // the user has resolved an intermediate (accept-stage / fix-stage /
  // accept on the final pane), check rec._deferredFinalCritique and
  // fire it if present. This is what makes the user see the
  // sequence "intermediate verdict → review → accept → final
  // verdict" instead of the buggy "intermediate verdict overwritten
  // by final before review."
  //
  // We only fire on accept-stage — the natural "user reviewed +
  // moved on" signal. Other reasons:
  //   - fix-stage: user wants the stage redone; the deferred final
  //     should stay pending until the redone stage is also accepted.
  //   - dismiss: pane closed without decision; don't fire.
  //   - discard: handled by clearActiveRunItem which clears the
  //     deferred (run abandoned).
  //   - accept (final pane): the final critique is the one being
  //     accepted, so no deferred needs to fire.
  if (reason === 'accept-stage') {
    try {
      const rec = sessionsMod.getSessionRecord(sessionId);
      if (rec && rec._deferredFinalCritique && rec._deferredFinalCritique.itemId === itemId) {
        const deferred = rec._deferredFinalCritique;
        rec._deferredFinalCritique = null;
        sessionsMod.saveStore();
        console.log(`[bug-64] firing deferred final critique for ${itemId} (deferred at ${deferred.deferredAt})`);
        // Fire-and-forget — don't await. The resolveCritique caller
        // (the /critique/resolve route) shouldn't block on the
        // critic's API call.
        triggerGeminiCritique(sessionId, session, deferred.item, deferred.diff, deferred.claudeOutput, {
          changedEntries: deferred.changedEntries,
        }).catch((err) => {
          console.error(`[bug-64] deferred final critique fire failed: ${err.message}`);
        });
      }
    } catch (err) {
      console.error(`[bug-64] resolveCritique deferred-fire check failed: ${err.message}`);
    }
  }
  return true;
}

module.exports = {
  triggerGeminiCritique,
  retryLastCritique,
  resolveCritique,
  _looksLikeCriticError,
};
