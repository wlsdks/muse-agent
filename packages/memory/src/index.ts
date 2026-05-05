import { createHash } from "node:crypto";
import type { ModelMessage, ModelToolCall } from "@muse/model";

export interface TokenEstimator {
  estimate(text: string): number;
}

export interface TokenEstimatorOptions {
  readonly cacheKeyMaxChars?: number;
  readonly maxEntries?: number;
  readonly ttlMs?: number;
}

export interface ConversationMessage extends ModelMessage {
  readonly toolCalls?: readonly ModelToolCall[];
}

export interface ConversationTrimOptions {
  readonly maxContextWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly systemPrompt?: string;
  readonly toolTokenReserve?: number;
  readonly estimator?: TokenEstimator;
  readonly messageStructureOverhead?: number;
  readonly compactionThreshold?: number;
  readonly insertSummary?: boolean;
}

export interface ConversationTrimResult {
  readonly messages: readonly ConversationMessage[];
  readonly budgetTokens: number;
  readonly estimatedTokens: number;
  readonly removedCount: number;
  readonly summaryInserted: boolean;
}

type Awaitable<T> = T | Promise<T>;

export type TaskStatus = "active" | "blocked" | "completed" | "cancelled";
export type TaskPlanItemStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TaskPlanItem {
  readonly step: string;
  readonly status?: TaskPlanItemStatus;
  readonly updatedAt?: Date;
}

export interface TaskDecision {
  readonly summary: string;
  readonly reason?: string;
  readonly decidedAt?: Date;
}

export interface TaskBlocker {
  readonly description: string;
  readonly owner?: string;
  readonly createdAt?: Date;
}

export interface TaskState {
  readonly taskId: string;
  readonly sessionId: string;
  readonly userId?: string;
  readonly goal: string;
  readonly status?: TaskStatus;
  readonly plan?: readonly TaskPlanItem[];
  readonly decisions?: readonly TaskDecision[];
  readonly blockers?: readonly TaskBlocker[];
  readonly metadata?: Readonly<Record<string, string>>;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface TaskMemoryStore {
  save(state: TaskState): Awaitable<void>;
  findById(taskId: string): Awaitable<TaskState | undefined>;
  findActiveBySession(sessionId: string, userId?: string): Awaitable<TaskState | undefined>;
  clear(taskId: string): Awaitable<void>;
}

export interface TaskMemoryMaintenance {
  purgeExpired(now?: Date): Awaitable<number>;
  purgeTerminalOlderThan(cutoff: Date): Awaitable<number>;
}

export const DEFAULT_CACHE_KEY_MAX_CHARS = 2_000;
export const DEFAULT_TOKEN_CACHE_MAX_ENTRIES = 50_000;
export const DEFAULT_TOKEN_CACHE_TTL_MS = 5 * 60 * 1_000;
export const DEFAULT_MESSAGE_STRUCTURE_OVERHEAD = 20;
export const DEFAULT_COMPACTION_THRESHOLD = 3;
export const COMPACTION_SUMMARY_PREFIX = "[Conversation summary";
export const COMPACTION_PINNED_ENTITIES_PREFIX = "Pinned entities for pronoun resolution";
export const DEFAULT_TASK_MEMORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export class InMemoryTaskMemoryStore implements TaskMemoryStore, TaskMemoryMaintenance {
  private readonly tasks = new Map<string, RequiredTaskState>();
  private readonly activeTaskBySession = new Map<string, string>();
  private readonly maxTasks: number;
  private readonly retentionMs: number;

  constructor(options: { readonly maxTasks?: number; readonly retentionMs?: number } = {}) {
    this.maxTasks = Math.max(1, options.maxTasks ?? 10_000);
    this.retentionMs = Math.max(1, options.retentionMs ?? DEFAULT_TASK_MEMORY_RETENTION_MS);
  }

  save(state: TaskState): void {
    const normalized = normalizeTaskState(state);
    this.tasks.set(normalized.taskId, normalized);

    if (isActiveLike(normalized.status)) {
      this.activeTaskBySession.set(sessionKey(normalized.sessionId, normalized.userId), normalized.taskId);

      if (!normalized.userId) {
        this.activeTaskBySession.set(sessionKey(normalized.sessionId), normalized.taskId);
      }
    } else {
      this.removeActiveIndexFor(normalized.taskId);
    }

    this.trimOldest();
  }

  findById(taskId: string): TaskState | undefined {
    const state = this.tasks.get(taskId);

    if (!state || this.isExpired(state, new Date())) {
      if (state) {
        this.clear(taskId);
      }

      return undefined;
    }

    return state;
  }

  findActiveBySession(sessionId: string, userId?: string): TaskState | undefined {
    const ids = [
      userId ? this.activeTaskBySession.get(sessionKey(sessionId, userId)) : undefined,
      this.activeTaskBySession.get(sessionKey(sessionId))
    ].filter((value): value is string => Boolean(value));

    for (const id of ids) {
      const state = this.findById(id);

      if (state && isActiveLike(state.status ?? "active") && isVisibleTo(state, userId)) {
        return state;
      }
    }

    return undefined;
  }

  clear(taskId: string): void {
    this.tasks.delete(taskId);
    this.removeActiveIndexFor(taskId);
  }

  purgeExpired(now = new Date()): number {
    const ids = [...this.tasks.values()]
      .filter((state) => this.isExpired(state, now))
      .map((state) => state.taskId);

    for (const id of ids) {
      this.clear(id);
    }

    return ids.length;
  }

  purgeTerminalOlderThan(cutoff: Date): number {
    const ids = [...this.tasks.values()]
      .filter((state) => !isActiveLike(state.status) && state.updatedAt < cutoff)
      .map((state) => state.taskId);

    for (const id of ids) {
      this.clear(id);
    }

    return ids.length;
  }

  private isExpired(state: RequiredTaskState, now: Date): boolean {
    return state.updatedAt.getTime() + this.retentionMs <= now.getTime();
  }

  private trimOldest(): void {
    while (this.tasks.size > this.maxTasks) {
      const oldest = [...this.tasks.values()].sort((left, right) =>
        left.updatedAt.getTime() - right.updatedAt.getTime()
      )[0];

      if (!oldest) {
        return;
      }

      this.clear(oldest.taskId);
    }
  }

  private removeActiveIndexFor(taskId: string): void {
    for (const [key, value] of this.activeTaskBySession) {
      if (value === taskId) {
        this.activeTaskBySession.delete(key);
      }
    }
  }
}

type RequiredTaskState = Omit<
  Required<TaskState>,
  "blockers" | "decisions" | "metadata" | "plan" | "userId"
> & {
  readonly blockers: readonly TaskBlocker[];
  readonly decisions: readonly TaskDecision[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly plan: readonly TaskPlanItem[];
  readonly userId?: string;
};

function normalizeTaskState(state: TaskState): RequiredTaskState {
  const now = new Date();
  return {
    blockers: state.blockers ?? [],
    createdAt: state.createdAt ?? now,
    decisions: state.decisions ?? [],
    goal: state.goal,
    metadata: state.metadata ?? {},
    plan: state.plan ?? [],
    sessionId: state.sessionId,
    status: state.status ?? "active",
    taskId: state.taskId,
    updatedAt: state.updatedAt ?? state.createdAt ?? now,
    ...(state.userId ? { userId: state.userId } : {})
  };
}

function sessionKey(sessionId: string, userId?: string): string {
  return userId && userId.length > 0 ? `${sessionId}::${userId}` : sessionId;
}

function isActiveLike(status: TaskStatus): boolean {
  return status === "active" || status === "blocked";
}

function isVisibleTo(state: TaskState, userId: string | undefined): boolean {
  return !userId || !state.userId || state.userId === userId;
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
    return messages[1]?.role === "tool" ? 2 : 1;
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

  while (index < messages.length) {
    const message = messages[index];

    if (message?.role !== "tool") {
      index++;
      continue;
    }

    const previous = messages[index - 1];

    if (previous?.role === "assistant" && hasToolCalls(previous)) {
      index++;
      continue;
    }

    removedTokens += removeAt(messages, tokens, index, 1);
  }

  return removedTokens;
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

interface CacheEntry {
  readonly expiresAt: number;
  readonly tokens: number;
}
