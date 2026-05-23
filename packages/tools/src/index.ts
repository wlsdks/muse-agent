import type { ModelTool } from "@muse/model";
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
    const recentCounts = countStrings(context.recentToolNames ?? []);
    const blocked: ToolExposureBlock[] = [];
    const selected: MuseTool[] = [];

    for (const tool of tools) {
      const block = this.blockReason(tool, {
        allowed,
        context,
        forbidden,
        prompt,
        recentCounts
      });

      if (block) {
        blocked.push(block);
      } else {
        selected.push(tool);
      }
    }

    const sorted = selected.sort(compareToolExposurePriority(prompt));
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

    if (!isToolRelevantToPrompt(tool, input.prompt)) {
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
    risk: tool.definition.risk
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


function hasWorkspaceHint(normalized: string): boolean {
  return workspaceHints.some((hint) => normalized.includes(hint));
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
  return mutationTargetHints.some((hint) => normalized.includes(hint))
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

function isToolRelevantToPrompt(tool: MuseTool, prompt: string): boolean {
  const keywords = tool.definition.keywords ?? [];

  if (keywords.length === 0 || prompt.trim().length === 0) {
    return true;
  }

  const normalized = prompt.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function compareToolExposurePriority(prompt: string): (left: MuseTool, right: MuseTool) => number {
  return (left, right) => {
    const risk = riskPriority(left.definition.risk) - riskPriority(right.definition.risk);

    if (risk !== 0) {
      return risk;
    }

    const relevance = relevanceScore(right, prompt) - relevanceScore(left, prompt);

    if (relevance !== 0) {
      return relevance;
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

function relevanceScore(tool: MuseTool, prompt: string): number {
  if (prompt.trim().length === 0) {
    return 0;
  }

  const normalized = prompt.toLowerCase();
  return (tool.definition.keywords ?? [])
    .filter((keyword) => normalized.includes(keyword.toLowerCase()))
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
  "스키마"
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
  /\bwrite\b/u
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
  "삭제해",
  "제거해",
  "변환해"
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
  "스키마"
] as const;

const mutationTargetPatterns = [/\bpr\b/u] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export { createMuseTools, type MuseToolFactoryOptions } from "./muse-tools.js";

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

export { ToolExecutor } from "./executor.js";

export {
  createSkillListTool,
  createSkillReadTool,
  createSkillRunTool,
  type SkillCatalogToolEntry,
  type SkillRegistryView,
  type SkillRunOptions
} from "./muse-tools-skills.js";
