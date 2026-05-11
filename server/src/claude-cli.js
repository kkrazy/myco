// Non-interactive Claude CLI invocation.
//
// Used by the Plan/Arch/Test extractor so extraction shares the running
// container's `claude` auth (whatever ~/.claude/ has configured — claude.ai
// subscription, or ANTHROPIC_API_KEY, or Bedrock, etc.) instead of needing
// a separate API key. Same auth path as the interactive PTY sessions
// Mycelium spawns from pty.js.
//
// Returns the model's text response, or null on any failure (binary
// missing, non-zero exit, timeout). Callers must tolerate null so a
// misconfigured host degrades to an empty artifact rather than 500ing.

const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 120000;     // 2 min — CLI startup adds overhead vs raw API
const STDERR_CAP = 600;                // bytes of stderr we keep for logging

function callClaudeCli({ system, userMessage, cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!userMessage) return resolve(null);

    // `-p <prompt>` runs Claude in print mode and exits when the response
    // ends. `--append-system-prompt` is grafted onto whatever default
    // Claude Code already uses, so we keep its base behaviour and just
    // append our extraction instructions. `--output-format text` is the
    // default but we set it explicitly so this doesn't drift if Claude
    // Code ever changes its default to stream-json.
    const args = [];
    if (system) { args.push('--append-system-prompt', system); }
    args.push('--output-format', 'text');
    args.push('-p', userMessage);

    let proc;
    try {
      proc = spawn('claude', args, {
        cwd: cwd || process.cwd(),
        env: {
          ...process.env,
          // Force non-interactive terminal so the CLI doesn't try to
          // render TUI chrome on stderr.
          TERM: 'dumb',
          NO_COLOR: '1',
          CI: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      console.error(`[claude-cli] spawn failed: ${err.message}`);
      return resolve(null);
    }

    let out = '';
    let errOut = '';
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      console.error(`[claude-cli] timed out after ${timeoutMs}ms`);
      finish(null);
    }, timeoutMs);

    proc.stdout.on('data', (d) => { out += d.toString('utf8'); });
    proc.stderr.on('data', (d) => {
      if (errOut.length < STDERR_CAP) {
        errOut += d.toString('utf8').slice(0, STDERR_CAP - errOut.length);
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[claude-cli] proc error: ${err.code || ''} ${err.message}`);
      finish(null);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error(`[claude-cli] exited ${code}; stderr: ${errOut.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
        return finish(null);
      }
      finish(out.trim() || null);
    });
  });
}

module.exports = { callClaudeCli };
