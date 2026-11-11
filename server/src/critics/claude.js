// Local-Claude critic wrapper (Task B).
//
// The default critic runs on Google Gemini (critics/gemini.js). This plugin
// gives the critic a "走本机 claude" option: it runs the EXACT same critic
// prompt/system-instruction through the local claude (the machine's own
// ~/.claude/ auth), optionally overlaid with the session's active gateway
// profile (rec.activeGw) so a custom model applies to critiques too.
//
// Signature: runCritique(prompt, systemInstruction, opts) where
//   opts = { user, activeGw, cwd }  — gateway context threaded by
//   critique.js triggerGeminiCritique (the 3rd arg is ignored by the other
//   critics and is backward compatible).
//
// Failure surface: returns a "(local claude failed: ...)" envelope so
// critique.js `_looksLikeCriticError` (critique.js:92-99) recognises an error
// verdict and renders the ↻ Retry affordance — same shape as the Gemini
// "(Gemini call failed: ...)" sentinel.

const { callLocalClaude } = require('../local-claude');

async function runCritique(prompt, systemInstruction = '', opts = {}) {
  try {
    const text = await callLocalClaude({
      system: systemInstruction,
      userMessage: prompt,
      user: opts && opts.user,
      activeGw: opts && opts.activeGw,
      cwd: opts && opts.cwd,
      timeoutMs: 180000,          // critiques run long (large diff prompts)
    });
    if (text === null) return '(local claude returned no text)';
    return text.trim();
  } catch (err) {
    return `(local claude failed: ${err && err.message ? err.message : err})`;
  }
}

module.exports = {
  id: 'claude',
  name: '本机 Claude',
  runCritique,
};
