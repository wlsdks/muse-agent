import { detectKoreanRegister } from "@muse/agent-core";

/**
 * Register mirror (FIX B): within one channel turn, the delegation ack
 * (`inbound-ack.ts`) and the chat fast-path (`inbound-chat-reply.ts`) each
 * compose their OWN system prompt with no shared formality signal — so the
 * ack could speak 반말 ("응, 확인했어") in the same turn the full agent run
 * speaks 존댓말 ("천만에요"), a jarring register mismatch. The full-run system
 * prompt already mirrors formality correctly via agent-core's
 * `buildRegisterBrevityLayer` (`conversational-register.ts`) — this reuses
 * the SAME deterministic detector (`detectKoreanRegister`) rather than
 * reinventing a second one, so the two prompts agree by construction.
 *
 * `undefined` when the user's text carries no Korean register signal at all
 * (no Hangul, or Hangul with no ending/vocative marker — e.g. plain English,
 * or a bare noun) — English has no 반말/존댓말 distinction, so nothing is
 * threaded in that case.
 */
export function formalityInstructionLine(latestUserText: string): string | undefined {
  const register = detectKoreanRegister(latestUserText);
  if (register === "unknown") {
    return undefined;
  }
  return register === "존댓말"
    ? "Match the user's formality register: they wrote in 존댓말 (polite/formal Korean) — reply in 존댓말, not casual 반말."
    : "Match the user's formality register: they wrote in 반말 (casual Korean) — reply in 반말, not formal 존댓말.";
}
