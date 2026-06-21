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
      const suggestion = nearestToolName(request.name, this.registry.list().map((registered) => registered.definition.name));
      return this.failed(
        request,
        `Error: tool not found: ${request.name}${suggestion ? `. Did you mean '${suggestion}'? Call that exact registered name.` : ""}`
      );
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
    // Turn a raw failure into a guided hint so the model's bounded retry is
    // informed, not blind (Repairing Tool Calls via Reflection, arXiv:2510.17874).
    const hint = toolErrorHint(error);
    return {
      error,
      id: request.id,
      name: request.name,
      output: hint ? `${error}\n(hint: ${hint})` : error,
      status: "failed"
    };
  }
}

/**
 * When the model calls a name that isn't available (a small model commonly
 * HALLUCINATES an intuitive name — `node_run` for the real `run_command`), name
 * the closest available tool so the next turn can call it instead of guessing
 * blindly. Deterministic: ranks by shared snake/dot-case token overlap, requires
 * ≥1 shared token (so an unrelated miss gets NO misleading suggestion). Takes the
 * candidate NAMES (not MuseTool[]) so BOTH the executor's not-registered path AND
 * the AgentRuntime not-EXPOSED gate (which only has the active ModelTool names)
 * can share one suggester.
 */
export function nearestToolName(requested: string, names: readonly string[]): string | undefined {
  const tokenize = (name: string): Set<string> =>
    new Set(name.toLowerCase().split(/[^a-z0-9]+/u).filter((part) => part.length > 0));
  const wanted = tokenize(requested);
  if (wanted.size === 0) {
    return undefined;
  }
  let best: { name: string; score: number } | undefined;
  for (const name of names) {
    let shared = 0;
    for (const token of tokenize(name)) {
      if (wanted.has(token)) {
        shared += 1;
      }
    }
    if (shared > 0 && (!best || shared > best.score)) {
      best = { name, score: shared };
    }
  }
  return best?.name;
}

/**
 * Map a tool failure to an actionable retry hint, or undefined when none fits.
 * Deterministic (no model): auth failures won't recover on retry, transient /
 * network / rate-limit may, a not-found needs the identifier rechecked.
 */
export function toolErrorHint(error: string): string | undefined {
  const e = error.toLowerCase();
  if (/\b(401|403)\b|unauthor|forbidden|invalid (api )?key|auth\w*\s*error|auth(entication)?\s+(failed|rejected)|(token|session|credential|key)\s*(is\s+)?expired|expired\s+(token|session|credential)|re-?auth/u.test(e)) {
    return "this looks like an auth failure — retrying won't help; tell the user to re-authenticate.";
  }
  if (/\b(429|502|503|504)\b|timeout|timed out|econnrefused|enotfound|etimedout|network|fetch failed|rate.?limit|temporarily unavailable/u.test(e)) {
    return "this looks transient (network/rate-limit) — you may retry once, otherwise tell the user the service is briefly unavailable.";
  }
  if (/\b404\b|not found|no such|does not exist|unknown (id|entity|resource)/u.test(e)) {
    return "the target wasn't found — re-check the identifier/argument before retrying.";
  }
  return undefined;
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
