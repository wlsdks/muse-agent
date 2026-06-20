import type { ModelTool } from "@muse/model";
import { isRecord } from "@muse/shared";
import type { SanitizedToolOutput } from "@muse/policy";
import type { JsonObject, JsonValue } from "@muse/shared";

export type ToolRisk = "read" | "write" | "execute";
export type ToolExecutionStatus = "completed" | "blocked" | "failed";

export interface MuseToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly risk: ToolRisk;
  readonly dependsOn?: readonly string[];
  readonly keywords?: readonly string[];
  readonly scopes?: readonly ToolExposureScope[];
  /**
   * Context Engineering Phase 4: feature domain tag used by
   * `DefaultToolFilter` to filter the tool catalog by user-prompt
   * keywords. Suggested values:
   *   "messaging" | "calendar" | "tasks" | "notes" | "system" | "core"
   * "core" tools are always advertised. Untagged tools fall back to
   * the prefix-based heuristic in `inferDomain`.
   */
  readonly domain?: string;
  /**
   * Optional free-text argument names that must be GROUNDED in the user's
   * utterance. The runtime drops any such arg the model fabricated (an 8B
   * invents a calendar `location`/`notes` the user never said). Muse-side
   * metadata; never sent to the provider (only `inputSchema` is).
   */
  readonly groundedArgs?: readonly string[];
}

export interface MuseToolContext {
  readonly runId: string;
  readonly userId?: string;
}

export type ToolExecutionValue = string | JsonValue;

export interface MuseTool {
  readonly definition: MuseToolDefinition;
  execute(args: JsonObject, context: MuseToolContext): Promise<ToolExecutionValue> | ToolExecutionValue;
}


export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
  readonly context: MuseToolContext;
}

export interface ToolExecutionResult {
  readonly id: string;
  readonly name: string;
  readonly status: ToolExecutionStatus;
  readonly output: string;
  readonly sanitized?: SanitizedToolOutput;
  readonly error?: string;
}

export interface ToolIdempotencyStore {
  get(key: string): ToolExecutionResult | undefined;
  set(key: string, result: ToolExecutionResult): unknown;
}

export interface ToolDescriptionIssue {
  readonly code: "missing_description" | "missing_input_schema" | "ambiguous_risk" | "duplicate_name" | "unknown_dependency" | "undescribed_parameter";
  readonly message: string;
  readonly toolName: string;
}

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

export class ToolRegistry {
  private readonly tools = new Map<string, MuseTool>();

  constructor(tools: Iterable<MuseTool> = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: MuseTool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new ToolRegistryError(`Duplicate tool registered: ${tool.definition.name}`);
    }

    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): MuseTool | undefined {
    return this.tools.get(name);
  }

  list(): readonly MuseTool[] {
    return [...this.tools.values()];
  }

  toModelTools(): readonly ModelTool[] {
    return this.list().map((tool) => toModelTool(tool));
  }

  selectForContext(context: ToolExposureContext = {}, policy: ToolExposurePolicy = createDefaultToolExposurePolicy()): ToolExposureSelection {
    return policy.select(this.list(), context);
  }

  planForContext(context: ToolExposureContext = {}, policy: ToolExposurePolicy = createDefaultToolExposurePolicy()): WorkspaceToolRoutingPlan {
    return createWorkspaceToolRoutingPlan(this.list(), context, policy);
  }
}

export class DefaultToolExposurePolicy implements ToolExposurePolicy {
  private readonly allowWriteWithoutMutationIntent: boolean;
  private readonly maxRepeatedToolCalls: number;

  constructor(options: DefaultToolExposurePolicyOptions = {}) {
    this.allowWriteWithoutMutationIntent = options.allowWriteWithoutMutationIntent ?? false;
    this.maxRepeatedToolCalls = Math.max(1, options.maxRepeatedToolCalls ?? 3);
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
    const limit = context.maxTools === undefined ? sorted.length : Math.max(0, Math.trunc(context.maxTools));

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

export { coerceToolArguments, coerceEnumArguments, validateRequiredToolArguments, type ToolArgumentValidation } from "./tools-argument-validation.js";

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

// ToolExecutor lives in `./executor.ts` (lifted out so the
// tool-execution loop stays in one cohesive module). Re-exported
// at the bottom of this file so the `@muse/tools` barrel keeps
// working without import-site edits.

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRegistryError";
  }
}

export function toModelTool(tool: MuseTool): ModelTool {
  return {
    description: shortenToolDescription(tool.definition.description),
    inputSchema: tool.definition.inputSchema,
    name: tool.definition.name,
    risk: tool.definition.risk,
    ...(tool.definition.groundedArgs ? { groundedArgs: tool.definition.groundedArgs } : {})
  };
}

export function validateToolDefinitions(tools: readonly MuseTool[]): readonly ToolDescriptionIssue[] {
  const issues: ToolDescriptionIssue[] = [];
  const seen = new Set<string>();
  const names = new Set(tools.map((tool) => tool.definition.name));

  for (const tool of tools) {
    const { definition } = tool;

    if (seen.has(definition.name)) {
      issues.push({
        code: "duplicate_name",
        message: `Duplicate tool name: ${definition.name}`,
        toolName: definition.name
      });
    }
    seen.add(definition.name);

    if (definition.description.trim().length < 12) {
      issues.push({
        code: "missing_description",
        message: `Tool '${definition.name}' needs a concrete user-facing description`,
        toolName: definition.name
      });
    }

    if (!isRecord(definition.inputSchema) || definition.inputSchema.type !== "object") {
      issues.push({
        code: "missing_input_schema",
        message: `Tool '${definition.name}' must expose an object input schema`,
        toolName: definition.name
      });
    } else if (isRecord(definition.inputSchema.properties)) {
      // tool-calling.md rule 3: every parameter the local model fills
      // needs a concrete description, or it guesses the argument.
      for (const [param, schema] of Object.entries(definition.inputSchema.properties)) {
        const description = isRecord(schema) ? schema.description : undefined;
        if (typeof description !== "string" || description.trim().length === 0) {
          issues.push({
            code: "undescribed_parameter",
            message: `Tool '${definition.name}' parameter '${param}' needs a description (an example helps the local model fill it)`,
            toolName: definition.name
          });
        }
      }
    }

    if (!["read", "write", "execute"].includes(definition.risk)) {
      issues.push({
        code: "ambiguous_risk",
        message: `Tool '${definition.name}' has an unsupported risk level`,
        toolName: definition.name
      });
    }

    for (const dependency of definition.dependsOn ?? []) {
      if (!names.has(dependency)) {
        issues.push({
          code: "unknown_dependency",
          message: `Tool '${definition.name}' depends on unknown tool '${dependency}'`,
          toolName: definition.name
        });
      }
    }
  }

  return issues;
}

export function planToolExecutionOrder(tools: readonly MuseTool[]): readonly string[] {
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const temporary = new Set<string>();
  const permanent = new Set<string>();
  const ordered: string[] = [];

  for (const tool of tools) {
    visitTool(tool.definition.name, byName, temporary, permanent, ordered);
  }

  return ordered;
}

export function shortenToolDescription(text: string, maxChars = 200): string {
  if (text.trim().length === 0) {
    return text;
  }

  const firstParagraph = text.split(/\n\s*\n/u)[0]?.trim() ?? "";

  if (firstParagraph.length <= maxChars) {
    return firstParagraph;
  }

  return `${firstParagraph.slice(0, Math.max(0, maxChars - 1))}...`;
}

function visitTool(
  name: string,
  byName: ReadonlyMap<string, MuseTool>,
  temporary: Set<string>,
  permanent: Set<string>,
  ordered: string[]
): void {
  if (permanent.has(name)) {
    return;
  }

  if (temporary.has(name)) {
    throw new ToolRegistryError(`Tool dependency cycle detected at: ${name}`);
  }

  const tool = byName.get(name);

  if (!tool) {
    return;
  }

  temporary.add(name);

  for (const dependency of tool.definition.dependsOn ?? []) {
    visitTool(dependency, byName, temporary, permanent, ordered);
  }

  temporary.delete(name);
  permanent.add(name);
  ordered.push(name);
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
function keywordMatchesPromptTokens(keyword: string, promptTokens: ReadonlySet<string>): boolean {
  const words = keyword.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
  if (words.length === 0) return false;
  return words.every((word) => {
    for (const token of promptTokens) {
      if (tokenMatchesKeywordWord(token, word)) return true;
    }
    return false;
  });
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
  "리마인드"
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
  /\bsave\b/u
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
  "리마인드"
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
  "리마인드"
] as const;

const mutationTargetPatterns = [/\bpr\b/u] as const;


export { createMuseTools, hasNestedUnboundedQuantifier, type MuseToolFactoryOptions } from "./muse-tools.js";

/**
 * Rust runner integration. Implementation lives in `./runner.ts`
 * (lifted out so the runner-protocol code stays cohesive). Re-exported
 * here so the `@muse/tools` barrel and existing tests keep working
 * without import-site edits.
 */
export {
  attachReadStreamErrorAbsorber,
  createRustRunnerTool,
  invokeRustRunner,
  parseRunnerCommandRequest,
  runnerWatchdogMs,
  writeRunnerStdin,
  type RunnerCommandRequest,
  type RunnerCommandResponse,
  type RustRunnerToolOptions
} from "./runner.js";

export { ToolExecutor, toolErrorHint } from "./executor.js";

export {
  createSkillListTool,
  createSkillReadTool,
  createSkillRunTool,
  type SkillCatalogToolEntry,
  type SkillRegistryView,
  type SkillRunOptions
} from "./muse-tools-skills.js";

export {
  normalizeToolName,
  extractCandidateNames,
  tallyPeakedness,
  recommendRename,
  formatCalibrationReport,
  type PeakednessRow,
  type RenameCandidate,
  type RenameDecisionInput,
  type RenameDecision,
  type CalibrationResult
} from "./tool-name-calibration.js";

export {
  parseNaturalLanguageToolSelection,
  type NlToolSelection
} from "./nl-tool-selection.js";
