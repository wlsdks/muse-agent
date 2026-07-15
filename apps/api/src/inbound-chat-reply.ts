import { citedSourcesIn, escapeSystemPromptMarkers, neutralizeInjectionSpans } from "@muse/agent-core";
import type { ModelProvider } from "@muse/model";
import { MUSE_IDENTITY_LEAD } from "@muse/prompts";
import { setTimeout as sleepWithTimer } from "node:timers/promises";

import { formalityInstructionLine } from "./register-mirror.js";

const MAX_CHAT_REPLY_LENGTH = 400;

/** The composer's own signal that it read the message as a real request, not smalltalk — the caller must fall through to the ack + full run instead. */
export const CHAT_REPLY_PASS_SENTINEL = "PASS";

/**
 * Deterministic guard on a model-composed conversational reply — the SAME
 * hygiene family as `sanitizeAckText` (single-line, length-capped, no
 * citation marker), plus the `PASS` sentinel the system prompt uses to hand
 * a mis-routed real request back to the caller. Pure so it's unit-testable
 * without a model in the loop.
 */
export function sanitizeChatReplyText(raw: string): string | null {
  const collapsed = raw.replace(/\s*\n+\s*/g, " ").trim();
  if (collapsed.length === 0 || collapsed.length > MAX_CHAT_REPLY_LENGTH) {
    return null;
  }
  if (collapsed === CHAT_REPLY_PASS_SENTINEL) {
    return null;
  }
  // Structured citation classes ("[task: …]", "[memory: …]", …) — mirrors
  // sanitizeAckText's colon-style check (inbound-ack.ts) against the same
  // `CITATION_CLASSES` forms in `packages/agent-core/src/recall-citations.ts`.
  if (/\[[^\]]*:/.test(collapsed)) {
    return null;
  }
  // The note-verb citation form ("[from notes/rent.md]") — the same detector
  // `gateChatAnswerGrounding` runs on the real answer path.
  if (citedSourcesIn(collapsed).length > 0) {
    return null;
  }
  return collapsed;
}

const DEFAULT_CHAT_REPLY_TIMEOUT_MS = 15_000;

const CHAT_REPLY_SYSTEM_PROMPT =
  `${MUSE_IDENTITY_LEAD}, a friendly personal companion chatting casually with the ` +
  "user over a messaging channel. Reply in the SAME language the user wrote in, " +
  "in 1 to 3 short, natural sentences — a casual conversational reply, not a " +
  "formal one. Never invent facts, numbers, schedules, memories, or anything " +
  "you don't actually know, and never cite a source (no \"[from …]\" or " +
  "\"[task: …]\" markers). If the message actually asks Muse to look something " +
  "up, remember something, or DO a task (not just chat), reply with EXACTLY " +
  "the single word \"PASS\" and nothing else.";

export interface ComposeChatReplyDeps {
  readonly modelProvider: Pick<ModelProvider, "generate">;
  readonly model: string;
  /** Injectable for tests — production default is 15s. */
  readonly timeoutMs?: number;
}

export interface ThreadTurnLike {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/** The subset of `ChatGroundingSource` this module needs — kept local so it
 *  has no `@muse/recall` dependency for a single 2-field shape. */
export interface ChatPersonaSnapshotLine {
  readonly source: string;
  readonly text: string;
}

/**
 * Snapshot lines are USER-STORED memory (facts/preferences an earlier turn
 * taught Muse) reaching a model prompt AND, via the composed reply, channel
 * output — the same threat shape as the recap/digest surfaces
 * (`commands-recap.ts`, `digest-flush.ts`): a poisoned stored value could try
 * to inject an instruction or forge a grounding marker. Apply the SAME
 * `escapeSystemPromptMarkers(neutralizeInjectionSpans(...))` composition
 * those surfaces use before the line ever reaches the system prompt.
 */
function safePersonaLine(text: string): string {
  return escapeSystemPromptMarkers(neutralizeInjectionSpans(text));
}

/**
 * Threads the SAME detected-register line the delegation ack uses
 * (`register-mirror.ts`) — without it, this composer's own casual default
 * tone ("1 to 3 short, natural sentences") can drift to 반말 even on a
 * 존댓말 user turn, mismatching the full agent run's reply in the same
 * conversation.
 */
function buildChatReplySystemPrompt(personaSnapshot: readonly ChatPersonaSnapshotLine[], latestUserText: string): string {
  const registerLine = formalityInstructionLine(latestUserText);
  const base = registerLine ? `${CHAT_REPLY_SYSTEM_PROMPT} ${registerLine}` : CHAT_REPLY_SYSTEM_PROMPT;
  if (personaSnapshot.length === 0) {
    return base;
  }
  const knownLines = personaSnapshot.map((line) => `  - ${safePersonaLine(line.text)}`).join("\n");
  return (
    `${base} ` +
    "이 사실들은 알고 있는 것 — 자연스럽게 활용하되 여기 없는 사실은 언급 금지 " +
    "(these are things you already know about the user — use them naturally " +
    "where relevant, but never state a fact, name, or number that is NOT " +
    "listed here):\n" +
    `${knownLines}`
  );
}

/**
 * Builds `InboundAgentRunOptions.composeChatReply`: one short single-inference
 * call answering a conversational channel turn directly, with no tools. Fail-
 * open by design — a model error, timeout, a guard rejection, or the model's
 * own "PASS" sentinel all return `null`, never throw, so the caller always has
 * a safe fallback (ack + the full agent run — the safety net for the fast
 * path).
 */
export function createComposeChatReply(
  deps: ComposeChatReplyDeps
): (input: {
  readonly latestUserText: string;
  readonly thread: readonly ThreadTurnLike[];
  /** The owner-scope "knows-you" snapshot (`loadChatPersonaSnapshot`) —
   *  omitted/empty on a shared/group turn or when nothing is stored yet. */
  readonly personaSnapshot?: readonly ChatPersonaSnapshotLine[];
}) => Promise<string | null> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CHAT_REPLY_TIMEOUT_MS;
  return async ({ latestUserText, thread, personaSnapshot }) => {
    if (latestUserText.trim().length === 0) {
      return null;
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const fallbackTimeoutController = new AbortController();
    const timeout = (async () => {
      await sleepWithTimer(timeoutMs, null, { ref: false, signal: fallbackTimeoutController.signal });
      return null;
    })();
    try {
      const response = await Promise.race([
        deps.modelProvider.generate({
          messages: [
            { content: buildChatReplySystemPrompt(personaSnapshot ?? [], latestUserText), role: "system" },
            ...thread.map((turn) => ({ content: turn.content, role: turn.role })),
            { content: latestUserText, role: "user" as const }
          ],
          model: deps.model,
          signal: timeoutSignal,
          temperature: 0.4
        }),
        timeout
      ]);
      if (response === null) {
        return null;
      }
      return sanitizeChatReplyText(response.output);
    } catch {
      return null;
    } finally {
      fallbackTimeoutController.abort();
    }
  };
}
