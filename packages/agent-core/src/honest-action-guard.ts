/**
 * The honest-action guard's SHARED enforcement half, paired with
 * {@link isUnbackedActionClaim} (the detection half, `casual-prompt.ts`) and
 * {@link runResistingFalseDone} (the CLI's one-shot clean-history re-prompt,
 * `false-done-reprompt.ts`). Extracted so every HTTP-facing surface — the API
 * `/chat` endpoint (buffered + streamed) and the Telegram/Matrix channel
 * reply — enforces the SAME rule the CLI chat REPL already enforces: a
 * completion claim ("일정을 등록했습니다") the model makes with NO actuator tool
 * run is a false promise and must never reach the user unmodified.
 *
 * `chat-repl.ts` keeps its own existing wiring (retry via
 * `runResistingFalseDone` + an appended heads-up line) — this module is NOT
 * spliced into `AgentRuntime.run()`'s unconditional response-filter pipeline,
 * because that pipeline is shared by every consumer including the CLI. Doing
 * the correction there would run TWICE for a CLI turn (once inside the
 * pipeline, once again via chat-repl's explicit call) and could suppress the
 * CLI's clean-history retry before it ever gets a chance to make the action
 * actually happen. Surfaces that had no wiring at all (API, channel) call
 * this module directly instead.
 */

import { isUnbackedActionClaim } from "./casual-prompt.js";
import { runResistingFalseDone, type RunWithOutput } from "./false-done-reprompt.js";

const UNBACKED_ACTION_NOTICE_EN =
  "Heads up — that wasn't actually done; no tool ran to complete it. Please ask again so I can act on it.";
const UNBACKED_ACTION_NOTICE_KO =
  "안내: 방금 요청은 실제로 처리되지 않았어요 (실행된 도구가 없어요). 다시 한번 요청해 주세요.";

/** The honest one-line notice for an unbacked action claim, EN or KO by the query's script. */
export function unbackedActionNoticeFor(query: string): string {
  return /[가-힣]/u.test(query) ? UNBACKED_ACTION_NOTICE_KO : UNBACKED_ACTION_NOTICE_EN;
}

/**
 * Enforces the honest-action rule over a turn's result: an optional bounded
 * retry ({@link runResistingFalseDone}, at most one clean-history re-run —
 * pass `retry` only where the caller can cheaply re-invoke the runtime), then
 * a DETERMINISTIC downgrade (no model call) when the (possibly re-prompted)
 * answer still claims a completed action with no actuator tool run: the
 * answer is replaced with a short honest notice instead of a confident false
 * "done". A backed action, or an answer that never claimed one, passes
 * through UNCHANGED.
 */
export async function guardAgainstUnbackedActionClaim<R extends RunWithOutput>(opts: {
  readonly query: string;
  readonly firstResult: R;
  readonly retry?: () => Promise<R>;
}): Promise<R> {
  const { query, firstResult, retry } = opts;
  const resolved = retry ? await runResistingFalseDone({ firstResult, query, retry }) : firstResult;
  if (!isUnbackedActionClaim({ answer: resolved.response.output, query, toolNames: resolved.toolsUsed ?? [] })) {
    return resolved;
  }
  return { ...resolved, response: { ...resolved.response, output: unbackedActionNoticeFor(query) } };
}
