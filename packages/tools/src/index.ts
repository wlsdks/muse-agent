import { spawn } from "node:child_process";
import type { ModelTool } from "@muse/model";
import {
  createAlwaysApprovePolicy,
  ToolOutputSanitizer,
  type SanitizedToolOutput,
  type ToolApprovalPolicy
} from "@muse/policy";
import type { JsonObject, JsonValue } from "@muse/shared";

export type ToolRisk = "read" | "write" | "execute";
export type ToolExecutionStatus = "completed" | "blocked" | "failed";

export interface MuseToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly risk: ToolRisk;
}

export interface MuseToolContext {
  readonly runId: string;
  readonly userId?: string;
  readonly workspaceId?: string;
}

export type ToolExecutionValue = string | JsonValue;

export interface MuseTool {
  readonly definition: MuseToolDefinition;
  execute(args: JsonObject, context: MuseToolContext): Promise<ToolExecutionValue> | ToolExecutionValue;
}

export interface RunnerCommandRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface RunnerCommandResponse {
  readonly ok: boolean;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly error: string | null;
}

export interface RustRunnerToolOptions {
  readonly runnerPath?: string;
  readonly invokeRunner?: (request: RunnerCommandRequest) => Promise<RunnerCommandResponse>;
}

export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
  readonly context: MuseToolContext;
}

export interface ToolApprovalStore {
  requestApproval(input: {
    readonly runId: string;
    readonly userId: string;
    readonly toolName: string;
    readonly arguments: JsonObject;
    readonly timeoutMs?: number;
    readonly context?: JsonObject;
  }): Promise<{
    readonly approved: boolean;
    readonly reason?: string;
    readonly modifiedArguments?: JsonObject;
  }>;
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
}

export class ToolExecutor {
  private readonly approvalPolicy: ToolApprovalPolicy;
  private readonly approvalStore?: ToolApprovalStore;
  private readonly idempotencyStore?: ToolIdempotencyStore;
  private readonly registry: ToolRegistry;
  private readonly sanitizer: ToolOutputSanitizer;

  constructor(options: {
    readonly approvalPolicy?: ToolApprovalPolicy;
    readonly approvalStore?: ToolApprovalStore;
    readonly idempotencyStore?: ToolIdempotencyStore;
    readonly registry: ToolRegistry;
    readonly sanitizer?: ToolOutputSanitizer;
  }) {
    this.approvalPolicy = options.approvalPolicy ?? createAlwaysApprovePolicy();
    this.approvalStore = options.approvalStore;
    this.idempotencyStore = options.idempotencyStore;
    this.registry = options.registry;
    this.sanitizer = options.sanitizer ?? new ToolOutputSanitizer();
  }

  async execute(request: ToolCallRequest): Promise<ToolExecutionResult> {
    const tool = this.registry.get(request.name);

    if (!tool) {
      return this.failed(request, `Error: tool not found: ${request.name}`);
    }

    const argsWithRisk = { ...request.arguments, risk: tool.definition.risk };
    let executionArguments = request.arguments;
    const idempotencyKey = readIdempotencyKey(request);
    const existing = idempotencyKey ? this.idempotencyStore?.get(idempotencyKey) : undefined;

    if (existing) {
      return { ...existing, id: request.id };
    }

    if (this.approvalPolicy.requiresApproval(tool.definition.name, argsWithRisk)) {
      const approval = await this.requestApproval(request);

      if (!approval.approved) {
        return {
          id: request.id,
          name: request.name,
          output: approval.reason
            ? `Error: tool execution was not approved: ${approval.reason}`
            : "Error: tool execution requires approval",
          status: "blocked"
        };
      }

      executionArguments = approval.modifiedArguments ?? request.arguments;
    }

    try {
      const raw = await tool.execute(executionArguments, request.context);
      const output = stringifyToolOutput(raw);
      const sanitized = this.sanitizer.sanitize(request.name, output);
      const result = {
        id: request.id,
        name: request.name,
        output: sanitized.content,
        sanitized,
        status: "completed"
      } satisfies ToolExecutionResult;

      if (idempotencyKey) {
        this.idempotencyStore?.set(idempotencyKey, result);
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown tool failure";
      return this.failed(request, `Error: ${message}`);
    }
  }

  private async requestApproval(request: ToolCallRequest) {
    if (!this.approvalStore) {
      return { approved: false };
    }

    return this.approvalStore.requestApproval({
      arguments: request.arguments,
      context: {
        toolCallId: request.id,
        workspaceId: request.context.workspaceId ?? null
      },
      runId: request.context.runId,
      toolName: request.name,
      userId: request.context.userId ?? "anonymous"
    });
  }

  private failed(request: ToolCallRequest, error: string): ToolExecutionResult {
    return {
      error,
      id: request.id,
      name: request.name,
      output: error,
      status: "failed"
    };
  }
}

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

export function isWorkspaceMutationPrompt(prompt: string | undefined | null): boolean {
  if (!prompt || prompt.trim().length === 0) {
    return false;
  }

  const normalized = prompt.toLowerCase();
  return hasWorkspaceHint(normalized) && hasMutationHint(normalized) && hasMutationTargetHint(normalized);
}

export function createRustRunnerTool(options: RustRunnerToolOptions = {}): MuseTool {
  const invoke = options.invokeRunner ?? ((request) => invokeRustRunner(options.runnerPath ?? "muse-runner", request));

  return {
    definition: {
      description: "Execute an approved local command through the Muse Rust runner child process.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          args: { items: { type: "string" }, type: "array" },
          command: { type: "string" },
          cwd: { type: "string" },
          env: { additionalProperties: { type: "string" }, type: "object" },
          maxOutputBytes: { minimum: 1, type: "integer" },
          timeoutMs: { minimum: 1, type: "integer" }
        },
        required: ["command"],
        type: "object"
      },
      name: "run_command",
      risk: "execute"
    },
    async execute(args) {
      const request = parseRunnerCommandRequest(args);
      const response = await invoke(request);

      return {
        ...response,
        stderr: response.stderr.slice(0, request.maxOutputBytes ?? response.stderr.length),
        stdout: response.stdout.slice(0, request.maxOutputBytes ?? response.stdout.length)
      };
    }
  };
}

export async function invokeRustRunner(
  runnerPath: string,
  request: RunnerCommandRequest
): Promise<RunnerCommandResponse> {
  return new Promise((resolve) => {
    const child = spawn(runnerPath, [], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      resolve({
        error: error.message,
        ok: false,
        status: null,
        stderr: "",
        stdout: "",
        timedOut: false,
        truncated: false
      });
    });
    child.on("close", () => {
      const output = Buffer.concat(stdout).toString("utf8");
      const parsed = parseRunnerResponse(output);

      if (parsed) {
        resolve(parsed);
        return;
      }

      resolve({
        error: "runner returned invalid JSON",
        ok: false,
        status: null,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: output,
        timedOut: false,
        truncated: false
      });
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

export function parseRunnerCommandRequest(value: JsonObject): RunnerCommandRequest {
  const command = typeof value.command === "string" ? value.command.trim() : "";

  if (!command) {
    throw new ToolRegistryError("run_command requires a non-empty command");
  }

  return {
    args: Array.isArray(value.args) ? value.args.filter((entry): entry is string => typeof entry === "string") : undefined,
    command,
    cwd: typeof value.cwd === "string" && value.cwd.trim().length > 0 ? value.cwd : undefined,
    env: readStringRecord(value.env),
    maxOutputBytes: readPositiveInteger(value.maxOutputBytes),
    timeoutMs: readPositiveInteger(value.timeoutMs)
  };
}

function parseRunnerResponse(value: string): RunnerCommandResponse | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;

    if (!isRecord(parsed)) {
      return undefined;
    }

    return {
      error: typeof parsed.error === "string" ? parsed.error : null,
      ok: parsed.ok === true,
      status: typeof parsed.status === "number" ? parsed.status : null,
      stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
      stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
      timedOut: parsed.timedOut === true,
      truncated: parsed.truncated === true
    };
  } catch {
    return undefined;
  }
}

function readStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
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

function readIdempotencyKey(request: ToolCallRequest): string | undefined {
  const key = request.arguments.idempotencyKey ?? request.arguments.idempotency_key;
  return typeof key === "string" && key.trim().length > 0
    ? `${request.context.runId}:${request.name}:${key.trim()}`
    : undefined;
}

const workspaceHints = [
  "jira",
  "confluence",
  "bitbucket",
  "이슈",
  "티켓",
  "프로젝트",
  "페이지",
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
  "슬랙 메시지",
  "마크다운으로",
  "이메일로",
  "json으로",
  "테이블로",
  "양식으로",
  "서식으로",
  "as a slack message"
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

function stringifyToolOutput(value: ToolExecutionValue): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
