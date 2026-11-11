// fr-95: Specialty registry. Specialties are an orthogonal axis from
// model wrappers (see ../index.js for the model registry — gemini,
// codex, custom). A "critic specialty" is a pure prompt-builder: it
// contributes a {id, name, systemSuffix} record that gets appended
// to the shared system instruction. The same MODEL (rec.criticModel)
// runs every specialty in the fan-out — the only thing that changes
// is the system-instruction suffix, which keeps the heavy user-prompt
// tail bit-for-bit identical across the fan-out and gives Gemini 2.5's
// prefix cache something to reuse on calls 2 + 3.
//
// FAN-OUT ORDER:
//   1. general            — gates the run queue (its ✓ AGREED is the
//                           gate; its diff broadcast carries the
//                           hasDisagreement flag).
//   2. test-validity      — informational; never gates.
//   3. perf-security      — informational; never gates.
//
// Adding a new specialty: drop a {id, name, systemSuffix} module into
// this directory, then add it to FINAL_SPECIALTIES below. See the
// other specialty files for the systemSuffix format.

const general = require('./general');
const testValidity = require('./test-validity');
const perfSecurity = require('./perf-security');

// The ordered list that fires on every FINAL critique.
const FINAL_SPECIALTIES = [general, testValidity, perfSecurity];

// Intermediate (stage-done) critiques fire general-only to keep the
// stage methodology cheap — 3 stages × 3 specialties = 9 calls per
// plan item, which is too aggressive for a checkpoint that the user
// hasn't even seen the verdict on yet. See critique.js for the
// isIntermediate branch that uses this list.
const INTERMEDIATE_SPECIALTIES = [general];

function getSpecialty(id) {
  return FINAL_SPECIALTIES.find((s) => s.id === id) || general;
}

module.exports = {
  FINAL_SPECIALTIES,
  INTERMEDIATE_SPECIALTIES,
  getSpecialty,
  // Exported individually for ad-hoc consumers (tests, future routes).
  general,
  testValidity,
  perfSecurity,
};
