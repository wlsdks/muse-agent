import type { MuseTool, ToolRisk } from "./index.js";
import { planToolExecutionOrder } from "./tool-definition-helpers.js";

/**
 * Marker that a tool requires the local execution mode (CLI / runner)
 * rather than the normal API-server context. The exposure policy
 * blocks tools tagged `"local"` when `localMode !== true`.
 *
 * Historically this was a `"conversation" | "workspace" | "local"`
 * union, but only `"local"` was ever read as a runtime discriminator
 * and nothing registered tools with the other two values — that was
 * multi-tenant residue. The union now carries only the value that
 * actually drives behaviour; future scopes can extend it.
 */
export type ToolExposureScope = "local";

export interface ToolExposureContext {
  readonly allowedToolNames?: readonly string[];
  readonly forbiddenToolNames?: readonly string[];
  readonly localMode?: boolean;
  readonly maxTools?: number;
  readonly prompt?: string;
  readonly recentToolNames?: readonly string[];
}

export interface ToolExposureBlock {
  readonly code:
    | "not_allowed"
    | "forbidden"
    | "local_execution_unavailable"
    | "write_without_mutation_intent"
    | "irrelevant_to_prompt"
    | "repeat_limit_exceeded"
    | "max_tool_count_exceeded";
  readonly reason: string;
  readonly toolName: string;
}

export interface ToolExposureSelection {
  readonly blocked: readonly ToolExposureBlock[];
  readonly tools: readonly MuseTool[];
}

export interface WorkspaceToolRoutingPlan extends ToolExposureSelection {
  readonly exposedToolNames: readonly string[];
  readonly mutationIntent: boolean;
  readonly plannedToolNames: readonly string[];
}

export interface ToolExposurePolicy {
  select(tools: readonly MuseTool[], context?: ToolExposureContext): ToolExposureSelection;
}

export interface DefaultToolExposurePolicyOptions {
  readonly allowWriteWithoutMutationIntent?: boolean;
  readonly maxRepeatedToolCalls?: number;
}

export class DefaultToolExposurePolicy implements ToolExposurePolicy {
  private readonly allowWriteWithoutMutationIntent: boolean;
  private readonly maxRepeatedToolCalls: number;

  constructor(options: DefaultToolExposurePolicyOptions = {}) {
    this.allowWriteWithoutMutationIntent = options.allowWriteWithoutMutationIntent ?? false;
    this.maxRepeatedToolCalls = normalizePositiveLimit(options.maxRepeatedToolCalls, 3);
  }

  select(tools: readonly MuseTool[], context: ToolExposureContext = {}): ToolExposureSelection {
    const allowed = stringSet(context.allowedToolNames);
    const forbidden = stringSet(context.forbiddenToolNames);
    const prompt = context.prompt?.trim() ?? "";
    // Tokenize the prompt ONCE (not per tool / per comparison) so keyword
    // relevance is word-boundary aware without an O(tools²·promptLen) cost.
    const promptTokens = tokenizePrompt(prompt);
    const recentCounts = countStrings(context.recentToolNames ?? []);
    const blocked: ToolExposureBlock[] = [];
    const selected: MuseTool[] = [];

    for (const tool of tools) {
      const block = this.blockReason(tool, {
        allowed,
        context,
        forbidden,
        prompt,
        promptTokens,
        recentCounts
      });

      if (block) {
        blocked.push(block);
      } else {
        selected.push(tool);
      }
    }

    const sorted = selected.sort(compareToolExposurePriority(promptTokens));
    const limit = normalizeExposureLimit(context.maxTools, sorted.length);

    if (sorted.length > limit) {
      for (const tool of sorted.slice(limit)) {
        blocked.push({
          code: "max_tool_count_exceeded",
          reason: `Tool '${tool.definition.name}' was hidden because the exposure limit was reached`,
          toolName: tool.definition.name
        });
      }
    }

    return {
      blocked,
      tools: sorted.slice(0, limit)
    };
  }

  private blockReason(tool: MuseTool, input: {
    readonly allowed: ReadonlySet<string>;
    readonly context: ToolExposureContext;
    readonly forbidden: ReadonlySet<string>;
    readonly prompt: string;
    readonly promptTokens: ReadonlySet<string>;
    readonly recentCounts: ReadonlyMap<string, number>;
  }): ToolExposureBlock | undefined {
    const name = tool.definition.name;

    if (input.allowed.size > 0 && !input.allowed.has(name)) {
      return blockTool(name, "not_allowed", `Tool '${name}' is outside the allowed tool set`);
    }

    if (input.forbidden.has(name)) {
      return blockTool(name, "forbidden", `Tool '${name}' is explicitly forbidden for this turn`);
    }

    if ((input.recentCounts.get(name) ?? 0) >= this.maxRepeatedToolCalls) {
      return blockTool(name, "repeat_limit_exceeded", `Tool '${name}' hit the repeated-call exposure limit`);
    }

    if ((tool.definition.risk === "execute" || tool.definition.scopes?.includes("local")) && input.context.localMode !== true) {
      return blockTool(name, "local_execution_unavailable", `Tool '${name}' requires local execution mode`);
    }

    if (
      tool.definition.risk === "write" &&
      !this.allowWriteWithoutMutationIntent &&
      !isWorkspaceMutationPrompt(input.prompt)
    ) {
      return blockTool(name, "write_without_mutation_intent", `Tool '${name}' requires a clear workspace mutation intent`);
    }

    if (!isToolRelevantToPrompt(tool, input.promptTokens)) {
      return blockTool(name, "irrelevant_to_prompt", `Tool '${name}' does not match the current prompt`);
    }

    return undefined;
  }
}

export function createDefaultToolExposurePolicy(options: DefaultToolExposurePolicyOptions = {}): ToolExposurePolicy {
  return new DefaultToolExposurePolicy(options);
}

export function filterToolsForContext(
  tools: readonly MuseTool[],
  context: ToolExposureContext = {},
  policy: ToolExposurePolicy = createDefaultToolExposurePolicy()
): ToolExposureSelection {
  return policy.select(tools, context);
}

export function createWorkspaceToolRoutingPlan(
  tools: readonly MuseTool[],
  context: ToolExposureContext = {},
  policy: ToolExposurePolicy = createDefaultToolExposurePolicy()
): WorkspaceToolRoutingPlan {
  const selection = filterToolsForContext(tools, context, policy);

  return {
    ...selection,
    exposedToolNames: selection.tools.map((tool) => tool.definition.name),
    mutationIntent: isWorkspaceMutationPrompt(context.prompt),
    plannedToolNames: planToolExecutionOrder(selection.tools)
  };
}

export function isWorkspaceMutationPrompt(prompt: string | undefined | null): boolean {
  if (!prompt || prompt.trim().length === 0) {
    return false;
  }

  const normalized = prompt.toLowerCase();
  return hasWorkspaceHint(normalized) && hasMutationHint(normalized) && hasMutationTargetHint(normalized);
}

/**
 * Match a hint against the (lowercased) prompt. A single ASCII word/abbrev is
 * matched as a STANDALONE token — not embedded in the middle of an English word
 * — so a short hint like "pr" (pull request), "spec", "repo", or "event" does
 * NOT substring-match "approve"/"special"/"report"/"prevent" and over-expose
 * write tools (the relevance-filter tokeniser already learned this lesson). A
 * trailing plural 's' and a directly-attached Korean particle ("PR에") still
 * match. Multi-word / hyphenated / non-ASCII (Korean) hints keep substring
 * matching — they do not collide inside other words the same way.
 */
function promptHasHint(normalized: string, hint: string): boolean {
  if (/^[a-z0-9]+$/u.test(hint)) {
    return new RegExp(`(?<![a-z])${hint}s?(?![a-z])`, "u").test(normalized);
  }
  return normalized.includes(hint);
}

function hasWorkspaceHint(normalized: string): boolean {
  return workspaceHints.some((hint) => promptHasHint(normalized, hint));
}

function hasMutationHint(normalized: string): boolean {
  if (readOnlyLookupExceptions.some((hint) => normalized.includes(hint))) {
    return false;
  }

  if (formattingContextKeywords.some((hint) => normalized.includes(hint))) {
    return false;
  }

  return mutationPatterns.some((pattern) => pattern.test(normalized))
    || koreanMutationHints.some((hint) => normalized.includes(hint));
}

function hasMutationTargetHint(normalized: string): boolean {
  return mutationTargetHints.some((hint) => promptHasHint(normalized, hint))
    || mutationTargetPatterns.some((pattern) => pattern.test(normalized));
}

function blockTool(toolName: string, code: ToolExposureBlock["code"], reason: string): ToolExposureBlock {
  return {
    code,
    reason,
    toolName
  };
}

function stringSet(values: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((values ?? []).map((value) => value.trim()).filter(Boolean));
}

/**
 * Limits are a safety boundary, so a non-finite configuration must not turn
 * `count >= limit` into a comparison that can never succeed. Invalid policy
 * options retain the documented default rather than silently disabling it.
 */
function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    // Preserve the legacy fractional behavior: a cap of 1.5 permits two
    // invocations and blocks the third because prior-call counts are integers.
    ? Math.max(1, value)
    : fallback;
}

/**
 * An explicitly supplied but invalid per-turn exposure cap fails closed. The
 * normal runtime adapter already filters metadata to finite numbers; this
 * protects direct policy consumers as well.
 */
function normalizeExposureLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function countStrings(values: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return counts;
}

/**
 * Lowercased whole-word tokens of a prompt (Unicode letters/digits; splits on
 * everything else). Word-boundary matching against these avoids the substring
 * false-positives that exposed irrelevant tools as distractors — e.g. keyword
 * "search" no longer matches "research", "ask" no longer matches "task".
 * Fewer distractors = better one-shot tool selection on the local model
 * (ITR, arXiv:2602.17046: expose the minimal relevant subset per turn).
 */
function tokenizePrompt(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length > 0) tokens.add(token);
  }
  return tokens;
}

/**
 * A prompt token matches a keyword word on an exact hit, or when the token is
 * the word plus a short inflectional suffix (plural / -ed / -ing): "lights"
 * matches "light", "locked" matches "lock". The match is anchored at the WORD
 * START and the suffix is capped, so "research" still never matches "search"
 * and "homework" never matches "home". Words under 4 chars require an exact
 * hit (so "on"/"off" don't prefix-match "online"/"office").
 */
export function tokenMatchesKeywordWord(token: string, word: string): boolean {
  if (token === word) return true;
  // Agglutinative scripts (Korean/CJK) attach particles to the stem, so the
  // keyword is a substring of one token: "마감" inside "마감인". Match by
  // containment for non-ASCII words (the original substring behaviour the
  // word-boundary rewrite regressed). ASCII keeps the word-boundary + short-
  // suffix rule so "research" never matches "search".
  if (/[^\u0000-\u007f]/u.test(word)) {
    // A single CJK character ("비") contained in an unrelated token
    // ("비밀번호") is noise, not relevance — containment needs ≥2 chars.
    return word.length >= 2 ? token.includes(word) : false;
  }
  return word.length >= 4 && token.startsWith(word) && token.length - word.length <= 3;
}

/**
 * A keyword matches when every word in it hits some prompt token — single-word
 * keywords need one hit, multi-word keywords ("pay rent") need all their words.
 */
export function keywordMatchesPromptTokens(keyword: string, promptTokens: ReadonlySet<string>): boolean {
  const words = keyword.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
  if (words.length === 0) return false;
  const hits = (word: string): boolean => {
    for (const token of promptTokens) {
      if (tokenMatchesKeywordWord(token, word)) return true;
    }
    return false;
  };
  if (words.every(hits)) return true;
  // Korean is written both spaced and unspaced for the same phrase — "이번 주"
  // and "이번주" are one word to a reader. Per-word matching cannot bridge that:
  // the second word "주" is a single character, and single-char containment is
  // refused as noise, so the spaced keyword misses the unspaced prompt entirely
  // and the tool is BLOCKED, not merely down-ranked. Retry the joined form for
  // non-ASCII keywords only, so ASCII phrases ("pay rent") keep needing all
  // their words and never collapse into a substring match.
  if (words.length > 1 && /[^\u0000-\u007f]/u.test(keyword)) {
    if (hits(words.join(""))) return true;
    // Korean attaches particles to the stem, so "살" appears as "살이야" and a
    // single-character word can never match by exact token. Containment is
    // refused for a LONE single char because it is noise ("비" inside
    // "비밀번호"), but inside a multi-word phrase every word must still hit —
    // "몇 살" needs both "몇" AND "살", which noise does not supply.
    // At least one word must be a real token match. Otherwise unrelated
    // compounds can satisfy every one-character word by containment alone
    // ("할머니가 일했다" must not satisfy the task phrase "할 일").
    if (!words.some(hits)) return false;
    return words.every((word) => {
      for (const token of promptTokens) {
        if (tokenMatchesKeywordWord(token, word) || token.includes(word)) return true;
      }
      return false;
    });
  }
  return false;
}

function isToolRelevantToPrompt(tool: MuseTool, promptTokens: ReadonlySet<string>): boolean {
  const keywords = tool.definition.keywords ?? [];

  if (keywords.length === 0 || promptTokens.size === 0) {
    return true;
  }

  return keywords.some((keyword) => keywordMatchesPromptTokens(keyword, promptTokens));
}

function compareToolExposurePriority(promptTokens: ReadonlySet<string>): (left: MuseTool, right: MuseTool) => number {
  return (left, right) => {
    // RELEVANCE first, risk only as a tiebreaker. Risk-first starved write
    // tools out of the maxTools window: every marginally-relevant read
    // (reminders.history, *.search) outranked a highly-relevant write
    // (tasks.add for "할 일에 추가해줘"), so the local model never saw the
    // action tool and FABRICATED "added it". Safety for writes is the
    // execution-time approval gate (outbound-safety), not hiding the tool —
    // hiding it just makes the model lie. An irrelevant write still scores 0
    // and sorts below a relevant read; only a write at least as relevant as
    // the competing reads now wins its slot.
    const relevance = relevanceScore(right, promptTokens) - relevanceScore(left, promptTokens);

    if (relevance !== 0) {
      return relevance;
    }

    const risk = riskPriority(left.definition.risk) - riskPriority(right.definition.risk);

    if (risk !== 0) {
      return risk;
    }

    return left.definition.name.localeCompare(right.definition.name);
  };
}

function riskPriority(risk: ToolRisk): number {
  if (risk === "read") {
    return 0;
  }

  if (risk === "write") {
    return 1;
  }

  return 2;
}

function relevanceScore(tool: MuseTool, promptTokens: ReadonlySet<string>): number {
  if (promptTokens.size === 0) {
    return 0;
  }

  return (tool.definition.keywords ?? [])
    .filter((keyword) => keywordMatchesPromptTokens(keyword, promptTokens))
    .length;
}

const workspaceHints = [
  "issue",
  "이슈",
  "ticket",
  "티켓",
  "project",
  "프로젝트",
  "page",
  "페이지",
  "document",
  "문서",
  "저장소",
  "repository",
  "repo",
  "pull request",
  "pr",
  "액션 아이템",
  "action item",
  "swagger",
  "openapi",
  "spec",
  "스펙",
  "catalog",
  "카탈로그",
  "endpoint",
  "schema",
  "엔드포인트",
  "스키마",
  // Personal-assistant write targets (post-pivot).
  "task",
  "tasks",
  "todo",
  "to-do",
  "reminder",
  "remind",
  "note",
  "notes",
  "event",
  "meeting",
  "appointment",
  "calendar",
  "할 일",
  "할일",
  "태스크",
  "노트",
  "메모",
  "일정",
  "약속",
  "회의",
  "리마인더",
  "리마인드",
  // Contacts are a first-class personal-write surface. A mutation prompt needs
  // a workspace hint AND a verb AND a target; without these, "연락처에 지안
  // 추가해줘" carries the verb and the target but no workspace, so add_contact
  // stays hidden and the model replies as though it had saved the person.
  "contact",
  "contacts",
  "address book",
  "연락처",
  "주소록",
  "전화번호",
  "번호",
  // Code/file edit targets — so a "fix the bug in the source file" task clears
  // the write-intent gate and file_edit can reach the model (it still passes the
  // relevance + approval gates before any write).
  "file",
  "source",
  "code",
  "codebase",
  "파일",
  "소스",
  "코드"
] as const;

const mutationPatterns = [
  /\bcreate\b/u,
  /\bupdate\b/u,
  /\bedit\b/u,
  /\bmodify\b/u,
  /\bchange\b/u,
  /\breassign\b/u,
  /\bassign\b/u,
  /\btransition\b/u,
  /\bapprove\b/u,
  /\bcomment\b/u,
  /\bdelete\b/u,
  /\bremove\b/u,
  /\bconvert\b/u,
  /\bwrite\b/u,
  // Personal-assistant write verbs (the gate's vocab was enterprise-only after
  // the personal pivot, so "add a task" / "set a reminder" never registered).
  /\badd\b/u,
  /\bset\b/u,
  /\bschedule\b/u,
  /\bremind\b/u,
  /\bsnooze\b/u,
  /\bcomplete\b/u,
  /\bmark\b/u,
  /\bsave\b/u,
  // Code-edit verbs (the "fix the bug" / "debug the file" task class).
  /\bfix\b/u,
  /\bdebug\b/u
] as const;

const koreanMutationHints = [
  "작성해",
  "만들어",
  "수정해",
  "업데이트해",
  "변경해",
  "재할당",
  "할당해",
  "전이해",
  "바꿔",
  "승인해",
  "코멘트해",
  "댓글 달",
  "추가해",
  "추가",
  "삭제해",
  "제거해",
  "변환해",
  "저장해",
  "저장",
  "기록해",
  "예약해",
  "리마인드",
  "고쳐"
] as const;

const readOnlyLookupExceptions = ["unassigned", "미할당"] as const;

const formattingContextKeywords = [
  "형태로",
  "포맷으로",
  "마크다운으로",
  "이메일로",
  "json으로",
  "테이블로",
  "양식으로",
  "서식으로"
] as const;

const mutationTargetHints = [
  "issue",
  "ticket",
  "comment",
  "page",
  "document",
  "attachment",
  "action item",
  "pull request",
  "branch",
  "review",
  "status report",
  "weekly status report",
  "이슈",
  "티켓",
  "코멘트",
  "댓글",
  "페이지",
  "문서",
  "첨부",
  "액션 아이템",
  "브랜치",
  "리뷰",
  "spec",
  "swagger",
  "openapi",
  "catalog",
  "endpoint",
  "schema",
  "스펙",
  "카탈로그",
  "엔드포인트",
  "스키마",
  // Personal-assistant write targets (post-pivot).
  "task",
  "tasks",
  "todo",
  "to-do",
  "reminder",
  "remind",
  "note",
  "notes",
  "event",
  "meeting",
  "appointment",
  "할 일",
  "할일",
  "태스크",
  "노트",
  "메모",
  "일정",
  "약속",
  "회의",
  "리마인더",
  "리마인드",
  // People and places the assistant writes to on the user's behalf. Without
  // these, "save Ada's number as a contact" carries a mutation VERB but no
  // recognised target, so every write tool is blocked as
  // write_without_mutation_intent and the model answers as if it had saved it.
  "contact",
  "contacts",
  "address book",
  "phone number",
  "연락처",
  "주소록",
  "전화번호",
  "번호",
  "이메일",
  "메일",
  // Code/file edit targets (paired with the workspaceHints + fix/debug verbs).
  "file",
  "source",
  "code",
  "bug",
  "function",
  "파일",
  "소스",
  "코드",
  "버그"
] as const;

const mutationTargetPatterns = [/\bpr\b/u] as const;
