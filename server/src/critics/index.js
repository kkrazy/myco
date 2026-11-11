const gemini = require('./gemini');
const codex = require('./codex');
const custom = require('./custom');
// Task B: local-claude critic — run the same critique prompts through the
// machine's own claude (optionally on the session's active gateway profile)
// instead of Google Gemini. Selectable via the composer-critic-select
// dropdown ("⚖️ 本机 Claude") or /critic status display.
const claude = require('./claude');
// bug-90: 'none' is a first-class no-op critic id used for graceful
// degradation (set via the /critic off slash command or the 🔕 Disable
// critic button on an error verdict pane). getCritic('none') returns
// THIS plugin (not the gemini fallback); triggerGeminiCritique
// short-circuits to a synthetic skip verdict so the run advances
// without calling the real critic model.
const none = require('./none');

const critics = {
  gemini,
  codex,
  custom,
  claude,
  none,
};

function getCritic(id) {
  const normalizedId = (id || '').toLowerCase().trim();
  return critics[normalizedId] || gemini;
}

module.exports = {
  getCritic,
  critics: Object.values(critics)
};
