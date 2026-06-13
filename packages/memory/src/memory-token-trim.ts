/**
 * Token estimation + conversation trimming primitives extracted
 * from packages/memory/src/index.ts.
 *
 * Owns the public `createApproximateTokenEstimator` (cached LRU
 * estimator with optional sha256 key when text is longer than
 * `cacheKeyMaxChars`), `computeApproximateTokens` (pure
 * Latin/CJK/emoji/other code-point bucketing), `estimateConversationTokens`,
 * and `trimConversationMessages` (the multi-pass trimmer that
 * removes old history → leading memory → tool history while
 * preserving message-pair integrity, then optionally inserts a
 * `[Conversation summary: …]` system message with pinned entities
 * once the compaction threshold is met).
 *
 * Re-exported from the memory barrel for backwards compatibility.
 */

import {
  COMPACTION_PERSONA_SNAPSHOT_PREFIX,
  COMPACTION_PINNED_ENTITIES_PREFIX,
  COMPACTION_SUMMARY_PREFIX,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_MESSAGE_STRUCTURE_OVERHEAD,
  type ConversationMessage,
  type ConversationTrimOptions,
  type ConversationTrimResult,
  type TokenEstimator
} from "./index.js";
import { IMPORTANCE_DEFAULT_THRESHOLD, recencyBonus, scoreMessageContent } from "./message-importance.js";
import { extractPinnedEntities } from "./pinned-entities.js";
import {
  extractSalientFacts,
  mergeSalientFacts,
  parseKeyDetailsBlock,
  renderKeyDetailsBlock,
  stripKeyDetailsBlock
} from "./salient-facts.js";
import { createApproximateTokenEstimator } from "./token-estimator.js";

// Re-exported for backwards compatibility — the @muse/memory barrel
// keeps these names available even though their definitions now
// live in `token-estimator.ts` and `pinned-entities.ts`.
export {
  computeApproximateTokens,
  createApproximateTokenEstimator
} from "./token-estimator.js";

export function estimateConversationTokens(
  messages: readonly ConversationMessage[],
  options: {
    readonly estimator?: TokenEstimator;
    readonly messageStructureOverhead?: number;
  } = {}
): number {
  const estimator = options.estimator ?? createApproximateTokenEstimator();
  const messageStructureOverhead = options.messageStructureOverhead ?? DEFAULT_MESSAGE_STRUCTURE_OVERHEAD;
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message, estimator, messageStructureOverhead),
    0
  );
}

export function trimConversationMessages(
  inputMessages: readonly ConversationMessage[],
  options: ConversationTrimOptions
): ConversationTrimResult {
  const estimator = options.estimator ?? createApproximateTokenEstimator();
  const messageStructureOverhead = options.messageStructureOverhead ?? DEFAULT_MESSAGE_STRUCTURE_OVERHEAD;
  const toolTokenReserve = options.toolTokenReserve ?? 0;
  const systemTokens = estimator.estimate(options.systemPrompt ?? "");
  const hardBudgetTokens =
    options.maxContextWindowTokens - systemTokens - options.outputReserveTokens - toolTokenReserve;
  // The "working budget" — Anthropic + NoLiMa-style proactive
  // compaction trigger. When the caller passes `workingBudgetTokens`
  // and it's lower than the hard cap, that becomes the trim target so
  // we recompact while quality is still high. Clamped above the hard
  // budget (a working budget that exceeds the hard cap is meaningless;
  // we silently fall back to the hard cap). Clamped at zero so an
  // accidentally-negative value can't be used.
  const workingTarget =
    options.workingBudgetTokens !== undefined
      ? Math.max(0, Math.min(options.workingBudgetTokens, hardBudgetTokens))
      : undefined;
  const messages = [...inputMessages];

  if (hardBudgetTokens <= 0) {
    const lastUserIndex = findLastIndex(messages, (message) => message.role === "user");
    const kept =
      lastUserIndex >= 0 && messages.length > 1
        ? [messages[lastUserIndex] as ConversationMessage]
        : messages;

    return {
      budgetTokens: hardBudgetTokens,
      estimatedTokens: estimateConversationTokens(kept, { estimator, messageStructureOverhead }),
      messages: kept,
      removedCount: inputMessages.length - kept.length,
      summaryInserted: false,
      triggeredBy: "hard_limit"
    };
  }

  const tokens = messages.map((message) => estimateMessageTokens(message, estimator, messageStructureOverhead));
  const beforeCount = messages.length;
  const originalSnapshot = [...messages];
  let totalTokens = sum(tokens);

  // Decide which budget the trim aims at. The hard cap always wins;
  // the working budget is a softer trigger that fires when we're
  // still under the hard cap but want to recompact proactively.
  // The trim passes themselves are no-ops when total <= target so
  // calling them unconditionally is safe — that also preserves the
  // structural cleanups (boundary integrity, orphan tool removal)
  // which run on every call regardless of trigger.
  const triggeredByWorking =
    workingTarget !== undefined && totalTokens > workingTarget && totalTokens <= hardBudgetTokens;
  const triggeredByHard = totalTokens > hardBudgetTokens;
  const trimTarget = triggeredByHard
    ? hardBudgetTokens
    : triggeredByWorking
      ? (workingTarget as number)
      : hardBudgetTokens;

  if (options.compactionStrategy === "importance") {
    totalTokens = trimByImportance(messages, tokens, totalTokens, trimTarget, options);
  }
  totalTokens = trimOldHistory(messages, tokens, totalTokens, trimTarget);
  totalTokens -= ensureBoundaryIntegrity(messages, tokens);
  totalTokens = trimLeadingMemoryMessages(messages, tokens, totalTokens, trimTarget);
  totalTokens -= ensureBoundaryIntegrity(messages, tokens);
  totalTokens = trimToolHistory(messages, tokens, totalTokens, trimTarget);
  totalTokens -= removeOrphanToolResponses(messages, tokens);
  totalTokens -= removeUnansweredToolCalls(messages, tokens, estimator, messageStructureOverhead);

  const droppedCount = beforeCount - messages.length;
  const summaryInserted =
    options.insertSummary !== false &&
    droppedCount >= (options.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD);

  if (summaryInserted) {
    totalTokens += insertCompactionSummary(
      messages,
      tokens,
      droppedCount,
      originalSnapshot,
      estimator,
      messageStructureOverhead,
      options.personaSnapshot
    );
  }

  const triggeredBy: "none" | "working_budget" | "hard_limit" = triggeredByHard
    ? "hard_limit"
    : triggeredByWorking
      ? "working_budget"
      : "none";

  return {
    budgetTokens: hardBudgetTokens,
    estimatedTokens: totalTokens,
    messages,
    removedCount: droppedCount,
    summaryInserted,
    triggeredBy
  };
}

/**
 * Score-aware first pass for the importance compaction strategy.
 * Looks at the removable window (between the leading system messages
 * and the last user message) and drops low-importance messages first,
 * stopping as soon as the conversation fits the trim target. Always
 * preserves message-pair integrity by deferring to the regular
 * `trimOldHistory` pass for any structural cleanup; this pass only
 * picks LOW-score victims and never touches high-importance ones
 * until they're the only options left.
 */
function trimByImportance(
  messages: ConversationMessage[],
  tokens: number[],
  currentTokens: number,
  budgetTokens: number,
  options: ConversationTrimOptions
): number {
  if (currentTokens <= budgetTokens) {
    return currentTokens;
  }
  const threshold = options.importanceThreshold ?? IMPORTANCE_DEFAULT_THRESHOLD;
  // content-score cache. The content-dependent portion of
  // the importance score is INVARIANT for a given message across
  // every iteration of the while-loop (it doesn't depend on the
  // message's current index in the array). Only the recency bonus
  // varies as we remove messages. Splitting the scorer + caching
  // the content score drops total substring-include work from
  // O(N²·H) to O(N·H), where H is the decision-hint list length.
  // WeakMap key by message reference so the entry is GC'd along with
  // the message if it's removed.
  const contentScoreCache = new WeakMap<ConversationMessage, number>();
  const importanceContext = options.importanceContext ?? {};
  function cachedContentScore(message: ConversationMessage): number {
    const cached = contentScoreCache.get(message);
    if (cached !== undefined) {
      return cached;
    }
    const score = scoreMessageContent(message, importanceContext);
    contentScoreCache.set(message, score);
    return score;
  }
  function clampUnitLocal(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }
  let totalMessagesForScoring = messages.length;
  let totalTokens = currentTokens;
  const skipCount = firstNonSystemIndex(messages);
  // Both `protectedIndex` and `totalMessagesForScoring` MUST decrement
  // alongside each removal. Pre-iter-27 they were captured once
  // up-front, which created two coupled bugs:
  //
  //   1. `protectedIndex` stale → the for-loop guard
  //      `index < protectedIndex` kept iterating up to the original
  //      slot of the last user message, but after N removals that
  //      slot now CONTAINS the last user message (shifted left N
  //      positions). The user's current question became a victim
  //      candidate, defeating the entire purpose of the protected
  //      boundary.
  //
  //   2. `totalMessagesForScoring` stale → the recency bonus
  //      `messageIndex / (totalMessages - 1)` used the original
  //      message count, so the (now-shifted-left) user message
  //      scored as if it were near the start of the conversation —
  //      depressed by ~0.1, making it MORE attractive as a victim.
  //
  // Decrementing both after every successful removal keeps the
  // protected boundary and the recency math in lockstep with the
  // mutated array.
  let protectedIndex = Math.max(0, findLastIndex(messages, (message) => message.role === "user"));

  while (totalTokens > budgetTokens) {
    let victimIndex = -1;
    let victimScore = Infinity;
    for (let index = skipCount; index < protectedIndex; index++) {
      const message = messages[index];
      if (!message) {
        continue;
      }
      // Don't pick a tool-call assistant alone — that would orphan
      // its tool replies and break boundary integrity. The follow-up
      // `trimOldHistory` pass handles those as groups.
      if (message.role === "assistant" && hasToolCalls(message)) {
        continue;
      }
      // Don't pick a tool reply alone — same reason.
      if (message.role === "tool") {
        continue;
      }
      // combine cached content score with per-iteration
      // recency bonus. Functionally identical to the prior
      // `scoreMessageImportance` call but avoids redoing the
      // substring searches over `DECISION_HINTS` + activeTaskTitle /
      // activeTaskId / currentFocus on every outer iteration.
      const score = clampUnitLocal(
        cachedContentScore(message) + recencyBonus(index, totalMessagesForScoring)
      );
      if (score >= threshold) {
        continue;
      }
      if (score < victimScore) {
        victimScore = score;
        victimIndex = index;
      }
    }
    if (victimIndex < 0) {
      break;
    }
    totalTokens -= removeAt(messages, tokens, victimIndex, 1);
    // Victim was always at index < protectedIndex (strict loop bound),
    // so the user-message slot shifts left by exactly one. Keep both
    // counters in sync with the mutated array.
    protectedIndex--;
    totalMessagesForScoring--;
  }

  return totalTokens;
}

function trimOldHistory(
  messages: ConversationMessage[],
  tokens: number[],
  currentTokens: number,
  budgetTokens: number
): number {
  let totalTokens = currentTokens;
  const skipCount = firstNonSystemIndex(messages);
  let protectedIndex = Math.max(0, findLastIndex(messages, (message) => message.role === "user"));

  while (totalTokens > budgetTokens && messages.length > 1) {
    if (protectedIndex <= skipCount) {
      break;
    }

    const removeCount = calculateRemoveGroupSize(messages.slice(skipCount));

    if (removeCount <= 0 || skipCount + removeCount > protectedIndex) {
      break;
    }

    totalTokens -= removeAt(messages, tokens, skipCount, removeCount);
    protectedIndex -= removeCount;
  }

  return totalTokens;
}

function trimLeadingMemoryMessages(
  messages: ConversationMessage[],
  tokens: number[],
  currentTokens: number,
  budgetTokens: number
): number {
  let totalTokens = currentTokens;
  let lastUserIndex = findLastIndex(messages, (message) => message.role === "user");

  while (totalTokens > budgetTokens && messages.length > 1) {
    if (lastUserIndex < 0 || lastUserIndex >= messages.length - 1) {
      break;
    }

    if (messages[0]?.role !== "system") {
      break;
    }

    totalTokens -= removeAt(messages, tokens, 0, 1);
    lastUserIndex--;
  }

  return totalTokens;
}

function trimToolHistory(
  messages: ConversationMessage[],
  tokens: number[],
  currentTokens: number,
  budgetTokens: number
): number {
  let totalTokens = currentTokens;
  const protectedIndex = Math.max(0, findLastIndex(messages, (message) => message.role === "user"));
  const removeStartIndex = protectedIndex + 1;

  while (totalTokens > budgetTokens && messages.length > 1) {
    if (removeStartIndex > messages.length - 1) {
      break;
    }

    const removeCount = calculateRemoveGroupSize(messages.slice(removeStartIndex));

    if (removeCount <= 0 || removeStartIndex + removeCount > messages.length) {
      break;
    }

    totalTokens -= removeAt(messages, tokens, removeStartIndex, removeCount);
  }

  return totalTokens;
}

function calculateRemoveGroupSize(messages: readonly ConversationMessage[]): number {
  const first = messages[0];

  if (!first) {
    return 0;
  }

  if (first.role === "assistant" && hasToolCalls(first)) {
    return 1 + countFollowingToolResponses(first, messages.slice(1));
  }

  return 1;
}

function ensureBoundaryIntegrity(messages: ConversationMessage[], tokens: number[]): number {
  const index = firstNonSystemIndex(messages);

  if (index >= messages.length || messages[index]?.role !== "tool") {
    return 0;
  }

  return removeAt(messages, tokens, index, 1);
}

function removeOrphanToolResponses(messages: ConversationMessage[], tokens: number[]): number {
  let removedTokens = 0;
  let index = 0;
  let pendingToolCallIds: string[] = [];

  while (index < messages.length) {
    const message = messages[index];

    if (message?.role === "assistant") {
      pendingToolCallIds = (message.toolCalls ?? []).map((toolCall) => toolCall.id);
      index++;
      continue;
    }

    if (message?.role !== "tool") {
      pendingToolCallIds = [];
      index++;
      continue;
    }

    if (consumeToolResponse(message, pendingToolCallIds)) {
      index++;
      continue;
    }

    removedTokens += removeAt(messages, tokens, index, 1);
  }

  return removedTokens;
}

// Symmetric counterpart to removeOrphanToolResponses: an assistant
// tool_use whose result is missing is a provider 400 (Anthropic/OpenAI
// both reject a tool_use / tool_calls entry with no matching tool result).
// trimConversationMessages is the last sanitiser before the provider, so
// it must guarantee valid output even if history is partial (e.g. a tool
// turn interrupted mid-flight, or persisted state from a crash). Runs
// AFTER removeOrphanToolResponses, so every following tool message is
// already one of this assistant's own calls; strip any call id left
// unanswered, and drop the message if that leaves it empty.
function removeUnansweredToolCalls(
  messages: ConversationMessage[],
  tokens: number[],
  estimator: TokenEstimator,
  messageStructureOverhead: number
): number {
  let removedTokens = 0;
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (message?.role !== "assistant" || !hasToolCalls(message)) {
      index++;
      continue;
    }

    // Match answers exactly the way removeOrphanToolResponses does — by id,
    // or POSITIONALLY when a tool message carries no toolCallId — so the two
    // passes agree. A divergence here (treating an id-less-but-positionally-
    // matched answer as unanswered) would drop the assistant and re-create
    // the orphan tool_result this pass exists to prevent.
    const pending = (message.toolCalls ?? []).map((toolCall) => toolCall.id);
    for (let probe = index + 1; probe < messages.length && messages[probe]?.role === "tool"; probe++) {
      consumeToolResponse(messages[probe] as ConversationMessage, pending);
    }
    const unanswered = new Set(pending);

    const keptCalls = (message.toolCalls ?? []).filter((toolCall) => !unanswered.has(toolCall.id));
    if (keptCalls.length === (message.toolCalls?.length ?? 0)) {
      index++;
      continue;
    }

    if (keptCalls.length === 0 && message.content.trim().length === 0) {
      removedTokens += removeAt(messages, tokens, index, 1);
      continue;
    }

    const repaired: ConversationMessage =
      keptCalls.length === 0
        ? { ...message, toolCalls: undefined }
        : { ...message, toolCalls: keptCalls };
    const newTokens = estimateMessageTokens(repaired, estimator, messageStructureOverhead);
    removedTokens += (tokens[index] ?? 0) - newTokens;
    messages[index] = repaired;
    tokens[index] = newTokens;
    index++;
  }

  return removedTokens;
}

function countFollowingToolResponses(
  assistantMessage: ConversationMessage,
  followingMessages: readonly ConversationMessage[]
): number {
  const pendingToolCallIds = (assistantMessage.toolCalls ?? []).map((toolCall) => toolCall.id);
  let count = 0;

  for (const message of followingMessages) {
    if (message.role !== "tool" || !consumeToolResponse(message, pendingToolCallIds)) {
      break;
    }

    count++;
  }

  return count;
}

function consumeToolResponse(message: ConversationMessage, pendingToolCallIds: string[]): boolean {
  if (pendingToolCallIds.length === 0) {
    return false;
  }

  if (!message.toolCallId) {
    pendingToolCallIds.shift();
    return true;
  }

  const matchIndex = pendingToolCallIds.indexOf(message.toolCallId);

  if (matchIndex < 0) {
    return false;
  }

  pendingToolCallIds.splice(matchIndex, 1);
  return true;
}

function insertCompactionSummary(
  messages: ConversationMessage[],
  tokens: number[],
  droppedCount: number,
  originalSnapshot: readonly ConversationMessage[],
  estimator: TokenEstimator,
  messageStructureOverhead: number,
  personaSnapshot: string | undefined
): number {
  const previousSummary = messages[0]?.role === "system" && messages[0].content.startsWith(COMPACTION_SUMMARY_PREFIX)
    ? messages[0].content
    : undefined;

  if (previousSummary) {
    removeAt(messages, tokens, 0, 1);
  }

  const summary: ConversationMessage = {
    content: buildCompactionSummaryText(messages, originalSnapshot, droppedCount, previousSummary, personaSnapshot),
    role: "system"
  };
  const summaryTokens = estimateMessageTokens(summary, estimator, messageStructureOverhead);

  messages.unshift(summary);
  tokens.unshift(summaryTokens);
  return previousSummary
    ? summaryTokens - estimateTextTokens(previousSummary, estimator, messageStructureOverhead)
    : summaryTokens;
}

function buildCompactionSummaryText(
  messages: readonly ConversationMessage[],
  originalSnapshot: readonly ConversationMessage[],
  droppedCount: number,
  previousSummary: string | undefined,
  personaSnapshot: string | undefined
): string {
  const toolNames = unique(
    messages.flatMap((message) =>
      message.role === "assistant" ? (message.toolCalls ?? []).map((toolCall) => toolCall.name) : []
    )
  ).slice(0, 5);
  const recentTopics = originalSnapshot
    .filter((message) => message.role === "user")
    .slice(-2)
    .map((message) => compactLine(message.content).slice(0, 80));
  const pinnedEntities = extractPinnedEntities(originalSnapshot);

  // Strip both the `[Key details]` block and the `User context: ...` persona
  // block from the previous summary so successive rounds don't accumulate them.
  // After stripping, parse the previous facts and merge with freshly-extracted
  // ones — emit exactly ONE [Key details] block (duplication-proof).
  const strippedPrevious = previousSummary
    ? stripPersonaSnapshot(stripKeyDetailsBlock(previousSummary))
    : undefined;

  const previousFacts = previousSummary ? parseKeyDetailsBlock(previousSummary) : [];
  const freshFacts = extractSalientFacts(originalSnapshot);
  const mergedFacts = mergeSalientFacts(previousFacts, freshFacts);

  const lines = strippedPrevious
    ? [strippedPrevious, `[Additional compaction round: ${droppedCount} messages removed]`]
    : [`${COMPACTION_SUMMARY_PREFIX}: ${droppedCount} messages compacted]`];

  if (toolNames.length > 0) {
    lines.push(`Tools kept in recent context: ${toolNames.join(", ")}`);
  }

  if (recentTopics.length > 0) {
    lines.push(`Recent user topics: ${recentTopics.join(" / ")}`);
  }

  if (pinnedEntities.length > 0) {
    lines.push(`${COMPACTION_PINNED_ENTITIES_PREFIX}: ${pinnedEntities.join(", ")}`);
  }

  if (personaSnapshot && personaSnapshot.trim().length > 0) {
    lines.push(`${COMPACTION_PERSONA_SNAPSHOT_PREFIX}: ${personaSnapshot.trim()}`);
  }

  const keyDetailsBlock = renderKeyDetailsBlock(mergedFacts);
  if (keyDetailsBlock) {
    lines.push(keyDetailsBlock);
  }

  return lines.join("\n");
}

function stripPersonaSnapshot(summary: string): string {
  // Drop any line starting with `User context: ...` so successive
  // compactions don't accumulate stale snapshots. Keeps every other
  // line intact.
  return summary
    .split("\n")
    .filter((line) => !line.startsWith(`${COMPACTION_PERSONA_SNAPSHOT_PREFIX}: `))
    .join("\n");
}

function estimateMessageTokens(
  message: ConversationMessage,
  estimator: TokenEstimator,
  messageStructureOverhead: number
): number {
  if (message.role === "assistant") {
    const toolCallTokens = (message.toolCalls ?? []).reduce(
      (total, toolCall) => total + estimator.estimate(toolCall.name + JSON.stringify(toolCall.arguments)),
      0
    );
    return estimator.estimate(message.content) + toolCallTokens + messageStructureOverhead;
  }

  return estimator.estimate(message.content) + messageStructureOverhead;
}

function estimateTextTokens(text: string, estimator: TokenEstimator, messageStructureOverhead: number): number {
  return estimator.estimate(text) + messageStructureOverhead;
}

function removeAt(messages: ConversationMessage[], tokens: number[], index: number, count: number): number {
  let removedTokens = 0;

  for (let offset = 0; offset < count; offset++) {
    removedTokens += tokens[index] ?? 0;
    messages.splice(index, 1);
    tokens.splice(index, 1);
  }

  return removedTokens;
}

function firstNonSystemIndex(messages: readonly ConversationMessage[]): number {
  const index = messages.findIndex((message) => message.role !== "system");
  return index < 0 ? messages.length : index;
}

function hasToolCalls(message: ConversationMessage): boolean {
  return (message.toolCalls?.length ?? 0) > 0;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];

    if (item !== undefined && predicate(item)) {
      return index;
    }
  }

  return -1;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function compactLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
