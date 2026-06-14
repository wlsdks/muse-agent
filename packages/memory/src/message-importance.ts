/**
 * Message-importance scoring for semantic compaction
 * (Context Engineering Phase 5).
 *
 * Pure scoring function so `trimConversationMessages` can preserve
 * "important" messages over plain temporal age. Score in [0, 1]:
 *   - tool-call assistant / tool reply: +0.4 baseline (paired,
 *     usually high signal)
 *   - plain assistant turn: +0.2 (the agent's last answer is what
 *     a follow-up question references)
 *   - system / user: +0.2
 *   - message references the active task / focus: +0.3 to +0.5
 *   - decision-language hint match: +0.2
 *   - recency bonus: up to +0.1
 */

import type { ConversationMessage } from "./index.js";

export interface ImportanceContext {
  readonly activeTaskId?: string;
  readonly activeTaskTitle?: string;
  readonly currentFocus?: string;
  /** Index of this message in the full conversation, 0 = oldest. */
  readonly messageIndex: number;
  /** Total messages in the conversation. */
  readonly totalMessages: number;
}

// Multi-language decision / commitment vocabulary. Hits boost the
// score by +0.2 so a message where the user or agent committed to
// something survives the compaction pass even if no active task is
// configured.
const DECISION_HINTS = [
  // Korean — decisions / agreements / plans
  "결정", "확정", "이렇게 가자", "하자", "정했어", "정함",
  "결론", "약속", "합의", "승인", "반대", "거부",
  "채택", "보류", "포기", "방향", "계획:",
  // English — decisions / agreements / plans
  "decided", "let's go", "we'll", "we will", "agreed",
  "signed off", "concluded", "final", "approved",
  "rejected", "ship it",
  "plan:", "step 1", "step 2", "step 3",
  "tldr:", "summary:"
];

export function scoreMessageImportance(
  message: ConversationMessage,
  context: ImportanceContext
): number {
  return clampUnit(
    scoreMessageContent(message, context)
      + recencyBonus(context.messageIndex, context.totalMessages)
  );
}

/**
 * Content-only portion of the importance score — invariant across
 * iterations of `trimByImportance`'s while-loop. split this
 * out from `scoreMessageImportance` so the trim can WeakMap-cache
 * the expensive substring-search work per message and only
 * recompute the cheap recency bonus per scan. For a 1000-message
 * conversation with 100 removals this drops total substring-include
 * calls from ~2.5M to ~25k.
 *
 * Returns an unclamped intermediate score — the caller composes it
 * with `recencyBonus` and applies `clampUnit` to the sum.
 */
export function scoreMessageContent(
  message: ConversationMessage,
  context: Omit<ImportanceContext, "messageIndex" | "totalMessages">
): number {
  let score = 0.1; // base
  // Role bonus. Previously a plain assistant turn fell through
  // every branch and received 0 role bonus, which kept every plain
  // assistant message under the default threshold (0.5) — i.e. they
  // were ALL trim candidates regardless of relevance. Plain
  // assistant turns now get the same +0.2 as user/system messages.
  if (message.role === "assistant") {
    score += (message.toolCalls && message.toolCalls.length > 0) ? 0.4 : 0.2;
  } else if (message.role === "tool") {
    score += 0.4;
  } else if (message.role === "system" || message.role === "user") {
    score += 0.2;
  }
  const content = message.content.toLowerCase();
  // Minimum-length guard: a 1-char `activeTaskTitle` ("X") or a
  // 2-char `currentFocus` ("hi") would substring-match nearly
  // every message and saturate the importance score regardless of
  // relevance, the same false-positive class the tool-filter
  // min-length guard closed. Three characters preserves real signal (Korean
  // morphemes are usually 2-syllable / 6 bytes, English domain
  // words like "rag", "pii", "ttl" stay matchable) while killing
  // off pathological one/two-char triggers.
  if (matchableHint(context.activeTaskTitle) && content.includes(context.activeTaskTitle!.toLowerCase())) {
    score += 0.5;
  }
  if (matchableHint(context.activeTaskId) && content.includes(context.activeTaskId!.toLowerCase())) {
    score += 0.3;
  }
  if (matchableHint(context.currentFocus) && content.includes(context.currentFocus!.toLowerCase())) {
    score += 0.3;
  }
  for (const hint of DECISION_HINTS) {
    if (content.includes(hint)) {
      score += 0.2;
      break;
    }
  }
  return score;
}

/**
 * Recency portion — varies per iteration as messages are removed.
 * Cheap to recompute. Returns 0..0.1.
 */
export function recencyBonus(messageIndex: number, totalMessages: number): number {
  const recency = totalMessages > 1
    ? messageIndex / (totalMessages - 1)
    : 1;
  return recency * 0.1;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function matchableHint(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  return value.trim().length >= 3;
}

export const IMPORTANCE_DEFAULT_THRESHOLD = 0.5;
