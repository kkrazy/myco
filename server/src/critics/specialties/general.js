// fr-95: General-purpose critic specialty. This is the pre-fr-95
// baseline focus — broad QA + security audit. It still gates the
// run queue (`✓ AGREED` here decides whether the queue auto-advances).
// The two new specialties (test-validity, perf-security) run alongside
// but only inform — they do NOT participate in queue gating, so a
// user-visible disagreement on perf/security won't freeze multi-item
// runs behind a pause.
//
// Specialty modules contribute ONLY a focus suffix to the system
// instruction — the model wrapper (gemini/codex/custom) is unchanged,
// and the heavy user-prompt tail (diff + file context + history) is
// identical across the fan-out. That identical-tail shape is what
// gives Gemini 2.5's prefix cache something to reuse across the three
// sequential calls in a single fan-out — calls 2 + 3 hit cache on
// the user prompt and only need to process the small specialty-suffix
// delta on the system prompt.

module.exports = {
  id: 'general',
  name: 'General QA',
  systemSuffix: `
=== SPECIALTY FOCUS: GENERAL QA + SECURITY AUDIT ===
You are the GENERAL critic of the fan-out. Cover the broad surface:
correctness, requirements coverage, edge-cases, security holes the
other specialties don't already own (auth, injection, info-leak that
isn't a perf problem). Defer perf-regressions to the Perf/Security
critic and test-correctness to the Test-Validity critic — don't
duplicate their work, but DO flag anything they would miss.

Your verdict gates the run queue: ✓ AGREED here means "this change is
ready"; anything else pauses the queue and surfaces a Retry. Be
deliberate — false-positive disagreement is expensive.`,
};
