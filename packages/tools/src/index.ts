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
  private readonly registry: ToolRegistry;
  private readonly sanitizer: ToolOutputSanitizer;

  constructor(options: {
    readonly approvalPolicy?: ToolApprovalPolicy;
    readonly approvalStore?: ToolApprovalStore;
    readonly registry: ToolRegistry;
    readonly sanitizer?: ToolOutputSanitizer;
  }) {
    this.approvalPolicy = options.approvalPolicy ?? createAlwaysApprovePolicy();
    this.approvalStore = options.approvalStore;
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

      return {
        id: request.id,
        name: request.name,
        output: sanitized.content,
        sanitized,
        status: "completed"
      };
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
  if (!prompt) {
    return false;
  }

  return workspaceMutationPatterns.some((pattern) => pattern.test(prompt));
}

const workspaceMutationPatterns = [
  /\b(create|update|delete|remove|assign|reassign|close|merge|deploy|send|publish)\b/i,
  /(생성|수정|삭제|제거|할당|재할당|닫아|종료|병합|배포|전송|게시|등록)/
] as const;

function stringifyToolOutput(value: ToolExecutionValue): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}
