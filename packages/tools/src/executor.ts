import { ToolOutputSanitizer } from "@muse/policy";

import type {
  ToolCallRequest,
  ToolExecutionResult,
  ToolExecutionValue,
  ToolIdempotencyStore,
  ToolRegistry
} from "./index.js";

/**
 * `ToolExecutor` plus its two private helpers, lifted from
 * `packages/tools/src/index.ts` so the tool-execution loop sits in
 * one cohesive module: registry lookup, idempotency-store check,
 * sanitiser pass, error wrapping. Re-exported from `index.ts` so
 * the `@muse/tools` barrel and the 4 import sites
 * (`packages/tools/test/tools.test.ts`,
 * `packages/agent-core/src/index.ts:115,193,295,333`) stay
 * byte-identical without import-site edits.
 */

export class ToolExecutor {
  private readonly idempotencyStore?: ToolIdempotencyStore;
  private readonly registry: ToolRegistry;
  private readonly sanitizer: ToolOutputSanitizer;

  constructor(options: {
    readonly idempotencyStore?: ToolIdempotencyStore;
    readonly registry: ToolRegistry;
    readonly sanitizer?: ToolOutputSanitizer;
  }) {
    this.idempotencyStore = options.idempotencyStore;
    this.registry = options.registry;
    this.sanitizer = options.sanitizer ?? new ToolOutputSanitizer();
  }

  async execute(request: ToolCallRequest): Promise<ToolExecutionResult> {
    const tool = this.registry.get(request.name);

    if (!tool) {
      return this.failed(request, `Error: tool not found: ${request.name}`);
    }

    const idempotencyKey = readIdempotencyKey(request);

    const existing = idempotencyKey ? this.idempotencyStore?.get(idempotencyKey) : undefined;
    if (existing) {
      return { ...existing, id: request.id };
    }

    try {
      const raw = await tool.execute(request.arguments, request.context);
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

function readIdempotencyKey(request: ToolCallRequest): string | undefined {
  const key = request.arguments.idempotencyKey ?? request.arguments.idempotency_key;
  return typeof key === "string" && key.trim().length > 0
    ? `${request.context.runId}:${request.name}:${key.trim()}`
    : undefined;
}

function stringifyToolOutput(value: ToolExecutionValue): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}
