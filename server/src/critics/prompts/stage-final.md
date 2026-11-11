<!-- bug-65: stage-final critic addendum. Prepended to userPrompt
     when stage is unset / 'verify' / the call is the final
     critique fired on turn_result success (not from a stage-done
     sentinel). This is the run-completion verdict that gates the
     queue. -->

[STAGE: FINAL — run-completion verdict, queue-gating critic]

All three stages (analyze → code → verify) of the §9 methodology
have completed. The diff below represents the FULL run's cumulative
output. The user is about to:
- `✓ Accept Claude` — accept the work, run completes, queue advances
- `⚡ Ask Claude to Fix` — send the verdict back to Claude for
  another iteration
- `✗ Discard` — abandon the run

**Your verdict gates the queue.** If you `✓ AGREED`, the user is
prompted to accept-or-discard. If you `✗ DISAGREE`, the queue stays
paused with the disagreement visible.

**Your focused job at this stage:** evaluate the FULL diff + test +
wiring as a coherent unit against the user-reported problem AND
the analyze plan.

Specifically:
1. **End-to-end problem coverage** — does the cumulative diff make
   the user's specific reported symptom stop happening? Mentally
   trace the user's reported scenario through the changed code.
2. **Plan-to-implementation fidelity** — does the cumulative diff
   match the analyze-stage plan (most recent entry in PLAN ITEM
   HISTORY is one of the prior stage outputs)? Flag scope creep
   or divergence.
3. **Test sufficiency for regression protection** — is the new
   test wired to test.sh AND would it have caught the original
   problem? A test that's wired but tautological is worse than
   no test.
4. **Adjacent suite consistency** — were related guards updated
   so they don't false-fail on the new shape?
5. **Run-summary integrity** — the diff should reflect what
   claude's `claudeOutput` explanation describes. If there's
   significant mismatch (claude claims to have done X but the
   diff shows Y), flag the misrepresentation.

Be thorough but not pedantic. A run that solves the user's problem
with a slightly suboptimal implementation should still get `✓
AGREED` — let the user know via "polish suggestions" comments. A
run that LOOKS clean but doesn't actually fix the user's problem
should get `✗ DISAGREE` and a clear statement of which aspect of
the problem is unaddressed.
