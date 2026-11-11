// bug-90: "no-op" critic — graceful degradation when the real critic
// model errors. Selected via `rec.criticModel = 'none'` (set by the
// /critic off slash command or the 🔕 Disable critic button on an
// error verdict pane).
//
// The plugin is recognised by the registry but its runCritique should
// NEVER be called — `triggerGeminiCritique` short-circuits at the top
// when the resolved criticId is 'none', emits a synthetic skip verdict
// via `_broadcastSyntheticSkipVerdict` (existing bug-68 plumbing), and
// transitions the stage state machine to `awaiting_accept` directly.
//
// The `disabled: true` marker lets unit tests + the slash handler tell
// "is this the no-op plugin" without string-comparing the id. The
// runCritique fallback below is a guardrail — if some future refactor
// forgets the short-circuit, the call still resolves with a clear
// error rather than hanging or 500ing.

module.exports = {
  id: 'none',
  name: 'Critic disabled',
  disabled: true,
  async runCritique() {
    throw new Error('[bug-90] runCritique called on the no-op critic — short-circuit in triggerGeminiCritique was bypassed (regression?)');
  },
};
