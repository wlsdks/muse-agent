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

import { createHash } from "node:crypto";
import {
  COMPACTION_PINNED_ENTITIES_PREFIX,
  COMPACTION_SUMMARY_PREFIX,
  DEFAULT_CACHE_KEY_MAX_CHARS,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_MESSAGE_STRUCTURE_OVERHEAD,
  DEFAULT_TOKEN_CACHE_MAX_ENTRIES,
  DEFAULT_TOKEN_CACHE_TTL_MS,
  type ConversationMessage,
  type ConversationTrimOptions,
  type ConversationTrimResult,
  type TokenEstimator,
  type TokenEstimatorOptions
} from "./index.js";

interface CacheEntry {
  readonly expiresAt: number;
  readonly tokens: number;
}

export function createApproximateTokenEstimator(options: TokenEstimatorOptions = {}): TokenEstimator {
  const cacheKeyMaxChars = options.cacheKeyMaxChars ?? DEFAULT_CACHE_KEY_MAX_CHARS;
  const maxEntries = options.maxEntries ?? DEFAULT_TOKEN_CACHE_MAX_ENTRIES;
  const ttlMs = options.ttlMs ?? DEFAULT_TOKEN_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  return {
    estimate(text: string): number {
      if (text.length === 0) {
        return 0;
      }

      const key = text.length <= cacheKeyMaxChars ? text : sha256Hex(text);
      const now = Date.now();
      const cached = cache.get(key);

      if (cached && cached.expiresAt > now) {
        return cached.tokens;
      }

      const tokens = computeApproximateTokens(text);
      cache.set(key, { expiresAt: now + ttlMs, tokens });
      trimOldestCacheEntries(cache, maxEntries);
      return tokens;
    }
  };
}

export function computeApproximateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  let latinChars = 0;
  let cjkChars = 0;
  let emojiChars = 0;
  let otherChars = 0;

  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;

    if (isEmojiCodePoint(codePoint)) {
      emojiChars++;
    } else if (isCjkCodePoint(codePoint)) {
      cjkChars++;
    } else if (codePoint <= 0x7f) {
      latinChars++;
    } else {
      otherChars++;
    }
  }

  const latinTokens = Math.floor(latinChars / 4);
  const cjkTokens = Math.floor((cjkChars * 2 + 1) / 3);
  const emojiTokens = emojiChars;
  const otherTokens = Math.floor(otherChars / 3);

  return Math.max(1, latinTokens + cjkTokens + emojiTokens + otherTokens);
}

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
  const budgetTokens =
    options.maxContextWindowTokens - systemTokens - options.outputReserveTokens - toolTokenReserve;
  const messages = [...inputMessages];

  if (budgetTokens <= 0) {
    const lastUserIndex = findLastIndex(messages, (message) => message.role === "user");
    const kept =
      lastUserIndex >= 0 && messages.length > 1
        ? [messages[lastUserIndex] as ConversationMessage]
        : messages;

    return {
      budgetTokens,
      estimatedTokens: estimateConversationTokens(kept, { estimator, messageStructureOverhead }),
      messages: kept,
      removedCount: inputMessages.length - kept.length,
      summaryInserted: false
    };
  }

  const tokens = messages.map((message) => estimateMessageTokens(message, estimator, messageStructureOverhead));
  const beforeCount = messages.length;
  const originalSnapshot = [...messages];
  let totalTokens = sum(tokens);

  totalTokens = trimOldHistory(messages, tokens, totalTokens, budgetTokens);
  totalTokens -= ensureBoundaryIntegrity(messages, tokens);
  totalTokens = trimLeadingMemoryMessages(messages, tokens, totalTokens, budgetTokens);
  totalTokens -= ensureBoundaryIntegrity(messages, tokens);
  totalTokens = trimToolHistory(messages, tokens, totalTokens, budgetTokens);
  totalTokens -= removeOrphanToolResponses(messages, tokens);

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
      messageStructureOverhead
    );
  }

  return {
    budgetTokens,
    estimatedTokens: totalTokens,
    messages,
    removedCount: droppedCount,
    summaryInserted
  };
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
  messageStructureOverhead: number
): number {
  const previousSummary = messages[0]?.role === "system" && messages[0].content.startsWith(COMPACTION_SUMMARY_PREFIX)
    ? messages[0].content
    : undefined;

  if (previousSummary) {
    removeAt(messages, tokens, 0, 1);
  }

  const summary: ConversationMessage = {
    content: buildCompactionSummaryText(messages, originalSnapshot, droppedCount, previousSummary),
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
  previousSummary: string | undefined
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
  const lines = previousSummary
    ? [previousSummary, `[Additional compaction round: ${droppedCount} messages removed]`]
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

  return lines.join("\n");
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

const issueKeyPattern = /\b[A-Z][A-Z0-9]+-\d+\b/gu;
const entityNounPattern =
  /(?<noun>[가-힣A-Za-z]{2,}(?:\s+[가-힣A-Za-z0-9]{2,}){0,3})\s*(?<type>버그|이슈|기능|모듈|프로젝트|시스템|서비스|페이지|문서)/gu;
const quotedEntityPattern = /["'「『](?<term>[^"'」』\n]{2,50})["'」』]/gu;
const maxPinnedEntities = 5;

function extractPinnedEntities(messages: readonly ConversationMessage[]): readonly string[] {
  const collected = new Set<string>();

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    for (const match of message.content.matchAll(issueKeyPattern)) {
      addPinnedEntity(collected, match[0]);
    }

    if (collected.size >= maxPinnedEntities) {
      break;
    }

    for (const match of message.content.matchAll(entityNounPattern)) {
      const groups = match.groups ?? {};
      addPinnedEntity(collected, `${groups.noun?.trim() ?? ""} ${groups.type ?? ""}`);
    }

    if (collected.size >= maxPinnedEntities) {
      break;
    }

    for (const match of message.content.matchAll(quotedEntityPattern)) {
      addPinnedEntity(collected, match.groups?.term?.trim() ?? "");
    }

    if (collected.size >= maxPinnedEntities) {
      break;
    }
  }

  return [...collected].slice(0, maxPinnedEntities);
}

function addPinnedEntity(collected: Set<string>, value: string): void {
  const normalized = compactLine(value);

  if (normalized.length > 0 && collected.size < maxPinnedEntities) {
    collected.add(normalized);
  }
}

function trimOldestCacheEntries(cache: Map<string, CacheEntry>, maxEntries: number): void {
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value as string | undefined;

    if (oldestKey === undefined) {
      return;
    }

    cache.delete(oldestKey);
  }
}

function isEmojiCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  );
}

function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0x3040 && codePoint <= 0x309f) ||
    (codePoint >= 0x30a0 && codePoint <= 0x30ff)
  );
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
