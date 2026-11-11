<!-- bug-65: stage-code critic addendum. Prepended to userPrompt
     when stage === 'code'. Tells the critic to FIRST check the
     diff against claude's analyze-stage plan (in history), THEN
     check it against the user's problem. -->

[STAGE: CODE — checkpoint critic for the code stage]

Claude has finished the code stage. Per §9, this means Claude has:
- Edited production source per the plan from the analyze stage.
- Written a regression test that would have caught the original
  problem.
- Confirmed the new test passes locally.

The diff below should reflect all three. The full adjacent-suite
green check is the verify stage's job; don't demand it here.

**Your focused job at this stage:** verify that the diff implements
the analyze-stage plan AND solves the user-reported problem.

### First check: does the diff match the analyze-stage plan?

**Read the most recent entry in `=== PLAN ITEM HISTORY ===` below.**
That's the run summary from claude's analyze-stage turn — i.e. the
plan claude proposed. The code-stage diff must implement THAT plan,
not a different one.

Specifically:
1. **Scope match** — does the diff change the files / functions /
   modules the plan said it would? If the plan said "fix the
   stage-done handler in attach.js" but the diff also touches
   unrelated CSS, flag the scope creep (CLAUDE.md §8.4 — surgical
   edits trace to the request).
2. **Solution match** — does the diff implement the SOLUTION the
   plan described? If the plan said "add a guard in path X" but
   the diff adds it in path Y, flag the divergence.
3. **Assumption-driven changes** — if the plan listed assumptions,
   did any of them turn out wrong as Claude implemented? If so,
   did Claude flag them? An unflagged invalidated assumption is a
   correctness risk.

### Second check: does the diff solve the user-reported problem?

After confirming the diff matches the plan, re-check against the
problem statement in `=== USER-REPORTED PROBLEM ===`:

1. **Behavioral fix** — does the diff actually change the behavior
   the user reported as broken? Or does it just reorganize code
   without addressing the symptom?
2. **Test catches the user's failure mode** — would the new test
   have red-flipped against the PRE-FIX code? Does it cover the
   SPECIFIC failure mode reported, or only an adjacent happy path?
   A test that passes both before and after the fix is theater
   (see Test Validity critic for the deeper dive).
3. **Cross-device / cross-user / cross-platform** — if the user's
   report mentioned a specific environment (a different browser, a
   different role, an older session), does the diff cover that
   environment too?

If diff + test cohere with both plan and problem, `✓ AGREED` with a
brief account of why you trust the fix. If either check fails,
`✗ DISAGREE` and state which check + the specific gap.
