/**
 * Stale tool-observation masking (The Complexity Trap,
 * arXiv:2508.21433 — masking old tool observations matches
 * summarization at ~half the cost; ACON, arXiv:2510.00615 —
 * history/observation compression cuts peak tokens 26-54%).
 *
 * In a multi-turn react loop the `messages` array grows without
 * bound: every prior turn's (already-capped) tool output stays at
 * full size in every subsequent model call. This pure helper rewrites
 * the array so `role:"tool"` messages from PRIOR turns become a
 * compact placeholder, while the most-recent turn's tool outputs stay
 * full. The full original bytes are stashed in the supplied
 * `ContextReferenceStore` (content-addressed) and the placeholder
 * surfaces `ref=<id>` so nothing is dropped — every masked
 * observation is re-fetchable via `muse.context.fetch({ ref })`. The
 * fabrication floor is intact: a masked source is referenced, never
 * deleted.
 *
 * Deterministic by construction — no LLM, no Math.random, no clock.
 * Content-addressed via the same sha256-prefix scheme model-loop's
 * truncation path uses, so the same content always yields the same
 * ref id (and re-masking an already-masked message is a stable
 * no-op).
 */

import { createHash } from "node:crypto";

import type { ContextReferenceStore } from "./context-reference-store.js";

interface MaskableMessage {
  readonly role: string;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly unknown[];
}

export interface MaskStaleToolObservationsOptions {
  /** Ref store the original bytes are stashed in. When absent, the helper is a no-op. */
  readonly refStore?: ContextReferenceStore;
  /**
   * How many of the most-recent tool-observation turns stay at full
   * size. Default 1 (conservative — only the latest turn's tool
   * outputs are kept full; all earlier ones are masked).
   */
  readonly keepLatestTurns?: number;
}

export interface MaskStaleToolObservationsResult<T extends MaskableMessage> {
  readonly messages: T[];
  readonly maskedCount: number;
}

const PLACEHOLDER_PREFIX = "[observation masked:";

function isToolMessage(message: MaskableMessage): boolean {
  return message.role === "tool";
}

function isAlreadyMasked(content: string): boolean {
  return content.startsWith(PLACEHOLDER_PREFIX);
}

function refIdFor(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function placeholderFor(toolName: string, content: string, ref: string): string {
  return `${PLACEHOLDER_PREFIX} tool ${toolName}, ${content.length} chars — re-fetch via muse.context.fetch({ ref=${ref} })]`;
}

/**
 * Index of the latest `keepLatestTurns` tool-observation turns'
 * messages. A "turn" of tool observations is a maximal contiguous run
 * of `role:"tool"` messages; the most-recent runs are protected. Any
 * `role:"tool"` message NOT in this set is stale and eligible for
 * masking.
 */
function protectedToolIndices(
  messages: readonly MaskableMessage[],
  keepLatestTurns: number
): ReadonlySet<number> {
  const runs: number[][] = [];
  let current: number[] | undefined;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message && isToolMessage(message)) {
      if (!current) {
        current = [];
        runs.push(current);
      }
      current.push(i);
    } else {
      current = undefined;
    }
  }
  const keep = Math.max(0, keepLatestTurns);
  const protectedRuns = keep > 0 ? runs.slice(-keep) : [];
  return new Set(protectedRuns.flat());
}

export function maskStaleToolObservations<T extends MaskableMessage>(
  messages: readonly T[],
  options: MaskStaleToolObservationsOptions = {}
): MaskStaleToolObservationsResult<T> {
  const refStore = options.refStore;
  // No ref store → the masked bytes would not be re-fetchable, which
  // would breach the no-source-dropped floor. Be a strict no-op so
  // existing callers without ref infra are unaffected.
  if (!refStore) {
    return { messages: [...messages], maskedCount: 0 };
  }

  const keepLatestTurns = options.keepLatestTurns ?? 1;
  const keepSet = protectedToolIndices(messages, keepLatestTurns);

  let maskedCount = 0;
  const rewritten = messages.map((message, index) => {
    if (!isToolMessage(message) || keepSet.has(index)) {
      return message;
    }
    if (isAlreadyMasked(message.content)) {
      // Idempotent: a placeholder is left exactly as-is (its bytes are
      // already in the store from the first mask).
      return message;
    }
    const toolName = message.name ?? "unknown";
    const ref = refIdFor(message.content);
    refStore.put({
      content: message.content,
      id: ref,
      originalLength: message.content.length,
      source: toolName
    });
    maskedCount += 1;
    return { ...message, content: placeholderFor(toolName, message.content, ref) };
  });

  return { messages: rewritten, maskedCount };
}
