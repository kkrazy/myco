const fs = require('fs');
const path = require('path');
const sessionsMod = require('./sessions');
const { getCritic } = require('./critics');
const runQueue = require('./runQueue');
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

async function triggerGeminiCritique(sessionId, session, item, diff, claudeOutput) {
  // Pause the run queue immediately so no other queue items dispatch during review
  const rec = sessionsMod.getSessionRecord(sessionId);
  if (rec) {
    rec.runQueuePaused = true;
    sessionsMod.saveStore();
  }
  
  // Broadcast queue update to clients so they know it is paused
  session.emit('state-update', { kind: 'runQueue', state: runQueue.getQueueState(rec) });

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
  const basePrompt = `You are an elite, independent QA and security auditor.
Review the provided git diff against the user's original task.
Compare Claude's changes to the original requirement.
Identify if Claude introduced bugs, security holes, ignored edge cases, or missed requirements.

You can ONLY see the diff and Claude's short explanation — no full file contents, no chat history, no test runs. If you cannot tell from those alone whether something is correct, write "INSUFFICIENT INFORMATION:" followed by what you would need to verify. Do NOT speculate or rubber-stamp.

If you agree with Claude's implementation, write: "✓ AGREED".
If you disagree, write a clear, concise markdown list of issues/bugs and suggest corrections. Cite specific lines from the diff.`;

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
  const systemPrompt = projectCriticRules
    ? `${basePrompt}\n\n=== Project-specific critic rules (from _myco_/critic.md) ===\nThese extend, but never override, the above instructions.\n\n${projectCriticRules}`
    : basePrompt;

  const userPrompt = `
Task to accomplish: ${item.text}
Claude's explanation: ${claudeOutput}

=== Staged Git Changes ===
${diff}
`;

  console.log(`[critique] Invoking critic "${critic.name}" (${critic.id}) for item ${item.id}...`);

  // Run the critique stateless completion
  const critique = await critic.runCritique(userPrompt, systemPrompt);
  const isAgreed = critique.includes('✓ AGREED');

  console.log(`[critique] "${critic.name}" critique complete for ${item.id}. Agreement=${isAgreed}`);

  // Broadcast the critique event over WebSockets with brand metadata
  session.emit('state-update', {
    kind: 'critique-review',
    itemId: item.id,
    hasDisagreement: !isAgreed,
    critique: critique,
    diff: diff,
    criticName: critic.name,
    criticId: critic.id
  });
}

module.exports = {
  triggerGeminiCritique
};
