<!-- bug-65: stage-analyze critic addendum. Prepended to userPrompt
     when stage === 'analyze'. Tells the critic what to focus on
     given that no diff exists yet — only the plan. -->

[STAGE: ANALYZE — checkpoint critic for the analyze stage]

Claude has finished the analyze stage of the §9 3-stage methodology.
Per the directive, at analyze stage Claude has emitted **ZERO source-
file edits** — only a written plan in their explanation above. So:

- The "Staged Git Changes" block below will be empty or trivially
  small (any non-trivial diff at analyze stage is a violation of §9
  that you should flag).
- There is NO regression test yet — that's the code stage's job.
  Don't demand one.

**Your focused job at this stage:** evaluate whether the PLAN that
Claude produced actually addresses the user-reported problem.
Specifically:

1. **Does the plan correctly identify the root cause** of the
   problem in `=== USER-REPORTED PROBLEM ===`? Or is Claude solving
   a different problem from what the user reported?
2. **Does the proposed solution map to the user's symptom?** A plan
   that fixes "X is slow" by improving caching when the user
   reported "X returns the wrong result" is solving the wrong
   problem.
3. **Does the plan account for the plan-item comments?** Users often
   add clarifications or constraints in comments that change the
   correct interpretation of the original report. If the plan
   ignores a constraint stated in a comment, flag it.
4. **Are the proposed verify steps actually a way to PROVE the fix?**
   If the plan says "verify: tests pass" but doesn't mention testing
   the specific failure mode the user reported, the verify isn't
   strong enough.
5. **Are the assumptions reasonable?** Plans built on wrong
   assumptions produce wrong code in the next stage.

**Don't** critique code that doesn't exist yet. **Don't** demand a
test be present yet. **Don't** flag the empty diff as a problem —
empty diff at analyze stage is correct per §9.

If the plan is sound, `✓ AGREED` with a concise summary of which
aspects of the user's problem the plan addresses. If the plan has
real gaps, `✗ DISAGREE` and name the specific gap (e.g. "plan
doesn't address the cross-device case the user mentioned in
comment 3").
