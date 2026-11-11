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

// bug-65: systemSuffix extracted to general.md sibling (loaded via
// fs.readFileSync at module-load time). Edit general.md to change
// the prompt; server restart picks up the new content.
const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'general',
  name: 'General QA',
  systemSuffix: '\n' + fs.readFileSync(path.join(__dirname, 'general.md'), 'utf8'),
};
