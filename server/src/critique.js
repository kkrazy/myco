const fs = require('fs');
const path = require('path');
const sessionsMod = require('./sessions');
const { getCritic } = require('./critics');
// fr-95: specialty registry — orthogonal axis from the model registry
// above. See critics/specialties/index.js for the fan-out order +
// gating contract.
const { FINAL_SPECIALTIES, INTERMEDIATE_SPECIALTIES } = require('./critics/specialties');
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

// td-33 r2: surface the plan item's recent iteration history so the
// critic understands "what's been tried." A change that looks like a
// regression in isolation may be the second-best iteration after a
// prior approach was rejected — the critic should know.
// Includes:
//   · Last HISTORY_RUNS_MAX runs (most recent first) with status +
//     summary.
//   · Last HISTORY_COMMENTS_MAX comments (most recent first), trimmed
//     to ~600 chars each.
// Capped at HISTORY_BLOCK_MAX_CHARS total — overrun is truncated.
function _buildHistoryBlock(item) {
  if (!item) return '';
  const runs = Array.isArray(item.runs) ? item.runs.slice(-HISTORY_RUNS_MAX).reverse() : [];
  const comments = Array.isArray(item.comments) ? item.comments.slice(-HISTORY_COMMENTS_MAX).reverse() : [];
  if (runs.length === 0 && comments.length === 0) return '';
  const lines = [];
  lines.push(`\n\n=== PLAN ITEM HISTORY (${item.id || 'unknown id'} — last ${runs.length} run${runs.length === 1 ? '' : 's'} + last ${comments.length} comment${comments.length === 1 ? '' : 's'}) ===`);
  lines.push(`A change that looks like a regression in isolation may be the second-best iteration after a prior approach was rejected, or a follow-up to a user-reported gap. Use this history to calibrate the review.\n`);
  if (runs.length > 0) {
    lines.push(`--- Recent runs (most recent first) ---`);
    for (const r of runs) {
      const ts = r.ts || '?';
      const status = r.status || '?';
      const summary = String(r.summary || r.result || '').slice(0, 800);
      lines.push(`· [${ts}] (${status}) ${summary}`);
    }
  }
  if (comments.length > 0) {
    lines.push(`\n--- Recent comments (most recent first) ---`);
    for (const c of comments) {
      const ts = c.ts || '?';
      const user = c.user || '?';
      const text = String(c.text || '').slice(0, 600);
      lines.push(`· [${ts}] @${user}: ${text}`);
    }
  }
  let out = lines.join('\n');
  if (out.length > HISTORY_BLOCK_MAX_CHARS) {
    out = out.slice(0, HISTORY_BLOCK_MAX_CHARS) + `\n\n[...history truncated to ${HISTORY_BLOCK_MAX_CHARS} chars to fit budget]`;
  }
  return out;
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

  // Critic system prompt. Calibration notes (2026-06-02):
  //   · "INSUFFICIENT INFORMATION" opt-out: critics with broad
  //     instructions tend to rubber-stamp when they can't actually
  //     tell. The explicit out lets the critic admit uncertainty
  //     instead of confabulating a plausible-but-wrong verdict.
  //     Combined with low temperature in the model wrapper, this
  //     catches a class of hallucination the prior prompt missed.
  //   · Anti-speculation clause: the critic only sees the diff —
  //     no chat history, no full file contents, no test runs. Make
  //     that limitation explicit so it doesn't invent context.
  //   · The "✓ AGREED" sentinel stays exactly the same string —
  //     `isAgreed = critique.includes('✓ AGREED')` is the gate that
  //     decides whether the run-queue auto-advances.
  //
  // fr-95 cache-optimized layout. `basePrompt` is the STABLE PREFIX of
  // the system instruction across all three specialties in a single
  // fan-out — the bit that's identical for general / test-validity /
  // perf-security. The per-specialty `systemSuffix` (~500 chars each)
  // is appended at the TAIL of the system instruction, NOT
  // interleaved with the heavy user-prompt body. The user prompt
  // (file context + history + diff + claudeOutput + follow-up) is
  // bit-for-bit identical across the fan-out, so Gemini 2.5's prefix
  // cache hits the heavy ~10-65 KB tail on calls 2 and 3.
  const basePrompt = `You are an elite, independent QA and security auditor.
Review the provided git diff against the user's original task.
Compare Claude's changes to the original requirement.
Identify if Claude introduced bugs, security holes, ignored edge cases, or missed requirements.

td-33 r2 (user-requested context enrichment): you now have THREE inputs — (1) the diff hunks, (2) the FULL CURRENT CONTENT of each changed file (so you can see the surrounding code — imports, related functions, type usages — not just the changed lines), and (3) the plan item's recent iteration history (last few runs + comments — so you understand what's been tried). Use them together: the diff tells you WHAT changed; the file context tells you whether the change is CONSISTENT WITH THE REST OF THE FILE; the history tells you what TRADE-OFFS were already considered. You should rarely need "INSUFFICIENT INFORMATION" anymore — the context is significantly richer than the pre-r2 diff-only prompt. Reserve INSUFFICIENT INFORMATION for cases where you genuinely cannot reach a verdict (e.g. the change references an external API whose contract isn't shown).

If you agree with Claude's implementation, write "✓ AGREED" on the first line, then on the lines below give a concise 2-4 sentence explanation of WHY you agree: what the change does well, which parts of the original requirement it satisfies, and any non-blocking observations or polish suggestions worth mentioning. Do not be terse — a bare "✓ AGREED" with no reasoning is unhelpful (the user has explicitly asked the critic to show its reasoning even when approving — bug-52). If you disagree, write a clear, concise markdown list of issues/bugs and suggest corrections. Cite specific lines from the diff.`;

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

  // td-33 (B — stage-aware critic): intermediate critiques get a
  // checkpoint preamble so Gemini calibrates correctly. The end-of-
  // run critique still expects "all work done"; an intermediate one
  // is reviewing partial progress + should flag obvious issues only
  // without expecting completeness. Same INSUFFICIENT INFORMATION
  // opt-out applies either way.
  const checkpointHeader = isIntermediate
    ? `\n[CHECKPOINT REVIEW — STAGE: ${String(stage || 'unknown').toUpperCase()}]\nThis is a mid-run checkpoint, not the final review. Claude is currently working on this item — the diff reflects partial progress through the ${stage || 'current'} stage. Flag obvious issues + missing pieces; do NOT mark INSUFFICIENT INFORMATION for "work isn't done yet" because that's expected. The next stage will produce a follow-up critique.\n`
    : '';
  // bug-52: when the user typed a follow-up prompt into the verdict
  // pane's input field, surface it as a TOP-PRIORITY instruction so
  // Gemini centers its review on that concern. Without the explicit
  // "user is specifically asking" framing, the model often gives the
  // same generic review and ignores the user's question.
  const userFollowupBlock = userFollowup
    ? `\n\n[USER FOLLOW-UP — give this priority over the generic review]\nThe user has typed the following concern they want you to look into specifically:\n"${userFollowup}"\nAddress this concern explicitly in your reasoning. If the diff doesn't have enough information to answer it, say so plainly.\n`
    : '';
  // td-33 r2: build the new context blocks. opts.changedEntries is
  // passed through from attach.js's critique gate (the same list
  // listChangedFiles returns, filtered by the baseline-dirty exclusion).
  // recAbsCwd needed for absolute file resolution.
  const fileContextBlock = _buildFileContextBlock(
    opts && Array.isArray(opts.changedEntries) ? opts.changedEntries : [],
    rec && rec.absCwd
  );
  const historyBlock = _buildHistoryBlock(item);

  const userPrompt = `${checkpointHeader}
Task to accomplish: ${item.text}
Claude's explanation: ${claudeOutput}

=== Staged Git Changes ===
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
  session.emit('state-update', {
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
  });
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

module.exports = {
  triggerGeminiCritique,
  retryLastCritique,
  _looksLikeCriticError,
};
