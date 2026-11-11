// c4 (harness2-integration §2): per-session tool guidance.
//
// The web GUI builds myco's project instructions from CLAUDE.md plus the
// server-global INTERACTION_RULES.md, which is a HISTORICAL TUI archive
// (its own header says so, and test.sh pins it as such) — nothing loads
// it at runtime, and nothing lets a single project override the tool
// guidance its agent sees. Harness²'s c4 component is exactly that slot:
// a per-session, per-project text block that tells the agent how to use
// ITS tools (which script to run, which file to read first, what not to
// touch), separately from the identity/role prompt in CLAUDE.md.
//
// Contract: `<agent cwd>/.claude/tool_guidance.md`, plain markdown, read
// on every iteration so an edit takes effect on the next turn without
// restarting the session. Absent file → the option is left exactly as it
// was (byte-identical to pre-c4), so projects that don't opt in see no
// change at all.
//
// It is deliberately NOT written into CLAUDE.md: CLAUDE.md is the
// project's convention pack (identity, process, "how we work"), which is
// committed and reviewed; tool guidance is per-session runtime steering
// that Harness² rewrites constantly. Mixing them would put experiment
// churn into git.
//
// Pure module — no Express coupling, mirrors skills.js / subagents.js.

const fs = require('fs');
const path = require('path');

const GUIDANCE_REL = path.join('.claude', 'tool_guidance.md');
const MAX_GUIDANCE_BYTES = 64 * 1024;

function guidancePath(cwd) {
  return path.join(cwd, GUIDANCE_REL);
}

// Returns { text, path } where text is null when the file is absent,
// empty, or unreadable. Never throws — guidance is a config file, and a
// broken one must not block a turn (same fail-open stance as
// subagents.loadAgents).
function loadToolGuidance(cwd) {
  if (!cwd || typeof cwd !== 'string') return { text: null, path: null };
  const file = guidancePath(cwd);
  let raw;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return { text: null, path: file };
    if (st.size > MAX_GUIDANCE_BYTES) {
      console.error(`[tool-guidance] ${file} is ${st.size} bytes (> ${MAX_GUIDANCE_BYTES}) — ignored`);
      return { text: null, path: file };
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[tool-guidance] cannot read ${file}: ${e.message}`);
    return { text: null, path: file };
  }
  const text = raw.trim();
  if (!text) return { text: null, path: file };
  return { text, path: file };
}

// Compose the SDK's `systemPrompt` option from (optional) existing prompt
// + (optional) tool guidance.
//
// Three cases, and the shape matters:
//   1. no guidance            → return `existing` untouched (undefined
//                               stays undefined → SDK default prompt)
//   2. guidance + no existing → { type:'preset', preset:'claude_code',
//                               append: guidance } — keep Claude Code's
//                               built-in prompt and append, which is what
//                               the SDK documents for exactly this use
//   3. guidance + existing    → plain string concatenation. A caller that
//                               already set a full custom prompt (n=2
//                               TeamSession workers, prompts-n2 STARTUP_A/B)
//                               owns the prompt; we only extend it.
//
// Returning `undefined` for case 1 is load-bearing: sdkOpts must not gain
// a `systemPrompt` key just because this module ran.
function composeSystemPrompt(existing, guidance) {
  if (!guidance) return existing;
  if (existing === undefined || existing === null) {
    return { type: 'preset', preset: 'claude_code', append: guidance };
  }
  if (typeof existing === 'string') {
    return `${existing}\n\n${guidance}`;
  }
  if (Array.isArray(existing)) {
    return existing.concat([guidance]);
  }
  if (existing && typeof existing === 'object' && existing.type === 'preset') {
    // Preset object already in play — append to its own append field.
    const prior = existing.append ? `${existing.append}\n\n` : '';
    return { ...existing, append: prior + guidance };
  }
  // Unknown shape: prefer keeping the caller's prompt untouched over
  // guessing at a merge. Loud, because silently dropping guidance is the
  // kind of bug that takes a day to find.
  console.error('[tool-guidance] unknown existing systemPrompt shape — guidance appended as array element');
  return [existing, guidance];
}

// Wrap a guidance body so the agent can tell project steering apart from
// the base prompt. Harness²'s own components use the same "labelled
// block" convention, and an unlabelled paragraph at the end of a long
// system prompt reads as part of it.
function renderGuidanceBlock(text, sourceFile) {
  const label = sourceFile ? path.basename(path.dirname(path.dirname(sourceFile))) : 'project';
  return [
    '<!-- myco:tool_guidance (c4) — project-owned tool guidance, read fresh every turn -->',
    `# Tool guidance for this project (${label})`,
    '',
    text,
  ].join('\n');
}

module.exports = {
  loadToolGuidance,
  composeSystemPrompt,
  renderGuidanceBlock,
  guidancePath,
  GUIDANCE_REL,
  MAX_GUIDANCE_BYTES,
};
