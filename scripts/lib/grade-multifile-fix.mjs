/**
 * Grade an eval:multifile-fix run by its OUTCOME, not the path taken.
 *
 * agent-testing.md is explicit: grade the terminal state, not the trajectory.
 * The harness re-runs the test itself (`testPasses` is verified independently of
 * the model), so ALSO requiring the model to have called run_command (`ranTest`)
 * is redundant path-grading — it fails a correct fix where the model edited the
 * source right but never self-ran the test, under-counting real success. The
 * OUTCOME of THIS eval is "the bug is fixed (test passes) with no collateral
 * damage". `ranTest` is returned for observability/logging only and never gates
 * `ok`. (eval:edit-run-verify deliberately DOES gate on the model running the
 * test — there the run→verify chain IS the measured agentic-persistence
 * capability; this grader is only for the fix-correctness eval.)
 */
export function gradeMultifileFix({ testPasses, addIntact, stringsIntact, ranTest } = {}) {
  return {
    ok: Boolean(testPasses && addIntact && stringsIntact),
    ranTest: Boolean(ranTest)
  };
}
