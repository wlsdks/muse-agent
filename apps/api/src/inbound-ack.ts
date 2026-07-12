import { citedSourcesIn } from "@muse/agent-core";
import type { ModelProvider } from "@muse/model";

import { formalityInstructionLine } from "./register-mirror.js";

/**
 * Deterministic guard on a model-composed acknowledgment: collapses
 * newlines, trims, and rejects anything that looks like a factual claim
 * (a citation marker) or is empty / too long for a one-line ack. Pure so
 * it's unit-testable without a model in the loop.
 */
export function sanitizeAckText(raw: string): string | null {
  const collapsed = raw.replace(/\s*\n+\s*/g, " ").trim();
  if (collapsed.length === 0 || collapsed.length > 200) {
    return null;
  }
  // Structured citation classes ("[task: …]", "[memory: …]", …) — colon-style
  // source refs. Mirrors the `CITATION_CLASSES` colon-keyed forms in
  // `packages/agent-core/src/recall-citations.ts` (the gate the channel's
  // real answer path runs through) without importing every per-class regex.
  if (/\[[^\]]*:/.test(collapsed)) {
    return null;
  }
  // The note-verb form ("[from notes/rent.md]") — Muse's REAL production
  // citation marker, and the one class the colon check above misses.
  // `citedSourcesIn` is the same detector `enforceAnswerCitations` /
  // `gateChatAnswerGrounding` run on the channel's real answer
  // (`packages/agent-core/src/grounding-citations.ts`,
  // `CITATION_RE = /\[from\s+([^\]]+?)\s*\]/giu`) — reused rather than
  // re-deriving a third pattern.
  if (citedSourcesIn(collapsed).length > 0) {
    return null;
  }
  return collapsed;
}

const DEFAULT_ACK_TIMEOUT_MS = 15_000;

const ACK_SYSTEM_PROMPT =
  "Write ONE short, casual first-person sentence confirming you're on the " +
  "user's request — entirely in the SAME language they wrote in, like a " +
  "quick text, not a customer-service reply. Never start with a formal " +
  "preamble such as \"I understand that you would like me to\" or \"요청을 " +
  "확인했습니다\" — name the concrete task directly (e.g. \"I'll set a " +
  "reminder to call mom tomorrow\" / \"엄마한테 전화하라고 리마인더 해둘게\"). " +
  "End with a brief promise to report back once it's done, phrased " +
  "naturally in that SAME language and never mixed with another language " +
  "(Korean example: \"다 되면 알려줄게.\" English example: \"I'll let you " +
  "know when it's done.\"). Do not answer the request, invent any facts, " +
  "numbers, or cite any source — you are only confirming you understood.";

/**
 * The ack prompt above is written toward a CASUAL default tone ("like a
 * quick text") — with no register signal of its own, it drifts toward 반말
 * even when the user's own turn was 존댓말, a jarring mismatch against the
 * full agent run's reply (which DOES mirror register — see
 * `register-mirror.ts`). Threading the SAME detected register here keeps
 * the two replies in one turn from disagreeing on formality.
 */
function buildAckSystemPrompt(latestUserText: string): string {
  const registerLine = formalityInstructionLine(latestUserText);
  return registerLine ? `${ACK_SYSTEM_PROMPT} ${registerLine}` : ACK_SYSTEM_PROMPT;
}

export interface ComposeAckDeps {
  readonly modelProvider: Pick<ModelProvider, "generate">;
  readonly model: string;
  /** Injectable for tests — production default is 15s. */
  readonly timeoutMs?: number;
}

/**
 * Builds `InboundAgentRunOptions.composeAck`: one short single-inference
 * call restating the user's request as an acknowledgment. Fail-open by
 * design — any model error, timeout, or a guard rejection returns `null`
 * (no ack), never throws, so the main agent run always proceeds.
 */
export function createComposeAck(
  deps: ComposeAckDeps
): (input: { readonly latestUserText: string }) => Promise<string | null> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  return async ({ latestUserText }) => {
    if (latestUserText.trim().length === 0) {
      return null;
    }
    const controller = new AbortController();
    // Race a real timer, not just an AbortSignal — a fake/test model
    // provider that ignores `signal` must still fail open on timeout.
    const timeout = new Promise<null>((resolve) => {
      const timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    });
    try {
      const response = await Promise.race([
        deps.modelProvider.generate({
          messages: [
            { content: buildAckSystemPrompt(latestUserText), role: "system" },
            { content: latestUserText, role: "user" }
          ],
          model: deps.model,
          signal: controller.signal,
          temperature: 0.2
        }),
        timeout
      ]);
      if (response === null) {
        return null;
      }
      return sanitizeAckText(response.output);
    } catch {
      return null;
    }
  };
}
