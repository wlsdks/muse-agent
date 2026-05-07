import type { ModelMessage, ModelResponse } from "@muse/model";
import type { JsonObject } from "@muse/shared";

/**
 * Shared internal helpers for `@muse/agent-core` submodules.
 *
 * These are intentionally private to the package (not re-exported from
 * `index.ts`). Consumers depending on stable API should use the typed
 * primitives — these helpers exist so guard / response-filter / runtime
 * submodules can share message and JSON parsing logic without circular
 * imports.
 */

export interface LlmClassificationDecision {
  readonly action: "allow" | "block";
  readonly category?: string;
  readonly reason?: string;
}

export function joinMessages(messages: readonly ModelMessage[]): string {
  return messages
    .filter((message) => message.role === "user" || message.role === "system")
    .map((message) => message.content)
    .join("\n");
}

export function joinUserMessages(messages: readonly ModelMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
}

export function parseLlmClassificationDecision(output: string): LlmClassificationDecision {
  const parsed = parseJsonObjectFromText(output);

  if (!parsed) {
    throw new Error("LLM classification guard returned an invalid decision");
  }

  const action = typeof parsed.action === "string" ? parsed.action.toLowerCase() : undefined;

  if (action === "allow") {
    return {
      action: "allow",
      category: stringField(parsed.category),
      reason: stringField(parsed.reason)
    };
  }

  if (action === "block" || action === "deny" || action === "reject") {
    return {
      action: "block",
      category: stringField(parsed.category),
      reason: stringField(parsed.reason)
    };
  }

  throw new Error("LLM classification guard returned an unknown action");
}

export function parseJsonObjectFromText(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fencedMatch = /```(?:json)?\s*([\s\S]*?)\s*```/iu.exec(trimmed);

  if (fencedMatch?.[1]) {
    candidates.push(fencedMatch[1].trim());
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");

  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Continue through fallback candidates.
    }
  }

  return undefined;
}

export function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function withResponseFilterRaw(response: ModelResponse, id: string): JsonObject {
  return {
    ...(isRecord(response.raw) ? response.raw : {}),
    museResponseFilter: { id }
  };
}
