<!-- bug-65: stage-verify critic addendum. Prepended to userPrompt
     when stage === 'verify'. Tells the critic to confirm the
     regression net is complete. -->

[STAGE: VERIFY — checkpoint critic for the verify stage]

Claude has finished the verify stage. Per §9, this means Claude has:
- Confirmed adjacent test suites are still green.
- Wired the new test into `./test/test.sh` so future runs catch the
  regression.
- Verified no grep-detectable regression in related code paths.

The diff below should include the test.sh wiring + any small
follow-up fixes that surfaced during verify.

**Your focused job at this stage:** confirm the regression net is
complete and the user's problem won't silently re-land in a future
iteration. This is the LAST checkpoint before the user signs off —
be thorough.

Specifically:
1. **Is the new test wired into `./test/test.sh`?** Grep the diff
   for a `node_test_result test/bug-XX-...` line OR equivalent
   wiring. Without this, the test doesn't run in CI.
2. **Were adjacent suites updated?** If the change touched a
   surface that another test pinned (e.g. a state-clear count, a
   regex anchor on a function name), check that the related test
   was updated. Look at the history for prior bug-X follow-up
   patterns where downstream test count-guards were bumped.
3. **Are there grep-detectable regressions in related code paths?**
   Did the fix unintentionally remove or weaken a related guard?
4. **Would a future iteration that re-broke the user-reported
   behavior be caught?** Mentally simulate: if a future PR
   accidentally re-introduced the bug, would the new test red-flip?
   If not, the test is too weak.
5. **Run-outcome stamping** — per CLAUDE.md, the plan-item should
   have a run record. If the diff or chat reflects the test command
   actually executing (not just being added to the runner), that's
   stronger evidence the user can trust.

This is the strictest critic in the 3-stage methodology — most
"looks fine, ship it" instincts should be overridden by
"would this catch the bug NEXT time too?"

If the regression net is complete, `✓ AGREED` with a summary of how
the test protects the user's specific failure mode going forward.
If gaps remain, `✗ DISAGREE` and name them.
