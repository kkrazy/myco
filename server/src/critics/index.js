const gemini = require('./gemini');
const codex = require('./codex');
const custom = require('./custom');
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
