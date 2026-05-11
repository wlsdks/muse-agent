/**
 * Message-importance scoring for semantic compaction
 * (Context Engineering Phase 5).
 *
 * Pure scoring function so `trimConversationMessages` can preserve
 * "important" messages over plain temporal age. Score in [0, 1]:
 *   - tool-call/tool-result pairs: 0.6 baseline (already paired by
 *     the trim machinery; importance just raises priority)
 *   - assistant message that contains structured plans / decisions: +0.2
 *   - user message that names the active task / current focus: +0.5
 *   - very recent messages get a small recency bump
 *   - everything else: low default
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

const DECISION_HINTS = [
  "결정", "확정", "이렇게 가자", "하자",
  "decided", "let's go", "we'll", "we will",
  "plan:", "step 1", "step 2"
];

export function scoreMessageImportance(
  message: ConversationMessage,
  context: ImportanceContext
): number {
  let score = 0.1; // base
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    score += 0.4;
  } else if (message.role === "tool") {
    score += 0.4;
  } else if (message.role === "system") {
    score += 0.2;
  } else if (message.role === "user") {
    score += 0.2;
  }
  const content = message.content.toLowerCase();
  if (context.activeTaskTitle && content.includes(context.activeTaskTitle.toLowerCase())) {
    score += 0.5;
  }
  if (context.activeTaskId && content.includes(context.activeTaskId.toLowerCase())) {
    score += 0.3;
  }
  if (context.currentFocus && content.includes(context.currentFocus.toLowerCase())) {
    score += 0.3;
  }
  for (const hint of DECISION_HINTS) {
    if (content.includes(hint)) {
      score += 0.2;
      break;
    }
  }
  const recency = context.totalMessages > 1
    ? context.messageIndex / (context.totalMessages - 1)
    : 1;
  score += recency * 0.1;
  return clampUnit(score);
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export const IMPORTANCE_DEFAULT_THRESHOLD = 0.5;
