// fr-95: Test-Validity critic specialty. Fires alongside the General
// critic on every FINAL critique. Verdict is informational — does NOT
// gate the run queue (only General gates).
//
// Focus: whether the tests in the diff actually verify the BEHAVIOUR
// the user-facing change was supposed to deliver. The pre-fr-95
// pattern of "I added a static-grep on the marker string" passes
// general QA (file exists, runs clean, asserts something non-trivial)
// but can completely miss whether the test would have CAUGHT the bug
// being fixed. That's the failure mode this critic owns.
//
// Specifically tasked with calling out:
//   · Tautological tests (assert that a string contains itself; mock
//     that returns the value the assertion checks).
//   · Tests that pass on broken code (run the assertion mentally
//     against the PRE-change code — does the original failure still
//     trip the test? If yes, the test is real. If no, it's theater).
//   · Tests that test the WRONG layer (e.g. asserting a marker in a
//     source file when the user-visible bug is in the rendered UI —
//     the static-grep won't catch a re-introduction via a different
//     code path).
//   · Missing-coverage gaps: the diff fixes Bug X but the test only
//     covers the happy path; the actual failure mode that motivated
//     the bug report isn't asserted anywhere.

// bug-65: systemSuffix extracted to test-validity.md sibling (loaded
// via fs.readFileSync at module-load time). Edit test-validity.md to
// change the prompt; server restart picks up the new content. Also
// bug-63 (in flight): the "✓ AGREED is INFORMATIONAL" framing was
// REMOVED — Test Validity findings now participate in the overall
// hasDisagreement aggregation per the bug-63 flip.
const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'test-validity',
  name: 'Test Validity',
  systemSuffix: '\n' + fs.readFileSync(path.join(__dirname, 'test-validity.md'), 'utf8'),
};
