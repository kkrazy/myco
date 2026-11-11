// Non-interactive Claude invocation.
//
// Used by the Plan/Arch/Test extractor so extraction shares the running
// container's `claude` auth (whatever ~/.claude/ has configured — claude.ai
// subscription, or ANTHROPIC_API_KEY, or Bedrock, etc.) instead of needing
// a separate API key. Same auth path as the interactive PTY sessions
// Mycelium spawns from pty.js.
//
// Returns the model's text response, or null on any failure (timeout,
// SDK error, no text emitted). Callers must tolerate null so a
// misconfigured host degrades to an empty artifact rather than 500ing.
//
// Phase 7 of the agent-sdk-migration: was a `claude -p` subprocess
// over child_process.spawn. Now uses @anthropic-ai/claude-agent-sdk
// in-process — same auth, no PATH dep, faster (no process startup).

const DEFAULT_TIMEOUT_MS = 120000;

async function callClaudeCli({ system, userMessage, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, user, activeGw } = {}) {
  if (!userMessage) return null;
  // Task B: delegate to the shared one-shot local-claude helper so the
  // extractor can run on the session's active gateway profile (custom model)
  // like the main agent does. Null-on-failure contract is unchanged.
  return require('./local-claude').callLocalClaude({
    system,
    userMessage,
    cwd,
    user,
    activeGw,
    timeoutMs,
  });
}

module.exports = { callClaudeCli };
