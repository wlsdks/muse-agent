/**
 * The false-done RE-PROMPT — the action half of the false-done backstop, paired
 * with {@link isUnbackedActionClaim} (the detection half). When a turn answers an
 * action request with a done-claim but ran NO actuator (an unbacked claim), this
 * re-runs the turn ONCE on a CLEAN history (the caller's `retry` thunk) and keeps
 * the re-run ONLY if it actually acted. The bound is exactly one retry — a
 * reflection-guard-compliant retry whose verifier is deterministic ({@link
 * actionToolRan}: did an actuator run this time?), never an open loop.
 *
 * Why a clean-history re-run: in a continuing session, a prior assistant turn
 * that CLAIMED a done action poisons the history — the model reads it as "already
 * done" and skips the tool while still saying it acted. The caller's `retry`
 * thunk re-issues the turn with NO prior history to clear that.
 *
 * Generic over the run result (structural `{response:{output}, toolsUsed?}`) so
 * it has NO dependency on the concrete AgentRuntime — chat-repl and the
 * eval/agent harness can BOTH compose it over the same one definition.
 */

import { actionToolRan, isUnbackedActionClaim } from "./casual-prompt.js";

export interface RunWithOutput {
  readonly response: { readonly output: string };
  readonly toolsUsed?: readonly string[];
}

export async function runResistingFalseDone<R extends RunWithOutput>(opts: {
  /** The user's request for this turn (the action-request leg). */
  readonly query: string;
  /** The turn's first result. */
  readonly firstResult: R;
  /** Re-issue the turn on a CLEAN history. Called at most ONCE, only on an unbacked claim. */
  readonly retry: () => Promise<R>;
}): Promise<R> {
  const { query, firstResult, retry } = opts;
  if (!isUnbackedActionClaim({ query, answer: firstResult.response.output, toolNames: firstResult.toolsUsed ?? [] })) {
    return firstResult;
  }
  const retried = await retry();
  // Keep the re-run only when it ACTUALLY acted — never let a second unbacked
  // "done" replace the first (the downstream notice handles a still-unbacked turn).
  return actionToolRan(retried.toolsUsed ?? []) ? retried : firstResult;
}
