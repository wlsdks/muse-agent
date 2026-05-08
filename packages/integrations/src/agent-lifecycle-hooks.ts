/**
 * Agent-lifecycle integration hooks extracted from
 * packages/integrations/src/index.ts.
 *
 * Owns four HookStage factories that bridge agent-core's lifecycle
 * into product-side capture surfaces:
 *
 *   - `createToolResponseSummaryHook`: forwards each completed tool
 *     call's output preview + optional JSON item count to the
 *     `onSummary` callback (e.g. for tool-call dashboards / search).
 *   - `createRagIngestionCaptureHook`: on agent run completion,
 *     evaluates the captured Q/A pair against the
 *     `RagIngestionCapturePolicy` and persists eligible candidates
 *     to the `RagIngestionCaptureCandidate` store (PENDING when the
 *     policy requires review, INGESTED otherwise).
 *   - `createFeedbackMetadataCaptureHook`: snapshots channel/domain/
 *     intent/sessionId/templateId/userId metadata + the run's Q/A
 *     into the configured feedback store on each completed run.
 *   - `createUserMemoryInjectionHook`: looks up the
 *     `userId`-keyed user memory on `beforeStart` and prepends a
 *     "Relevant user memory:" system message so the agent can lean
 *     on prior facts/preferences/recent topics.
 *
 * Re-exported from the integrations barrel for backwards compatibility.
 */

import type { HookStage } from "@muse/agent-core";
import type { ModelMessage } from "@muse/model";
import type { JsonObject, JsonValue } from "@muse/shared";
import type {
  FeedbackMetadataCaptureHookOptions,
  RagIngestionCaptureHookOptions,
  RagIngestionCapturePolicy,
  ToolResponseSummaryHookOptions,
  UserMemoryInjectionHookOptions,
  UserMemoryInjectionMemory
} from "./index.js";

export function createToolResponseSummaryHook(options: ToolResponseSummaryHookOptions): HookStage {
  const previewLength = Math.max(1, options.previewLength ?? 500);

  return {
    afterTool: async (context, toolCall, result) => {
      if (result.status !== "completed") {
        return;
      }

      await options.onSummary({
        ...(countJsonItems(result.output) !== undefined ? { itemCount: countJsonItems(result.output) } : {}),
        outputPreview: truncatePreview(result.output, previewLength),
        runId: context.runId,
        status: result.status,
        toolCallId: toolCall.id,
        toolName: toolCall.name
      });
    },
    id: options.id ?? "tool-response-summary"
  };
}

export function createRagIngestionCaptureHook(options: RagIngestionCaptureHookOptions): HookStage {
  return {
    afterComplete: async (context, response) => {
      const policy = await options.policyStore.getOrNull();

      if (!policy?.enabled) {
        return;
      }

      const query = firstUserMessage(context.input.messages);
      const channel = metadataString(context.input.metadata, "channel");
      const sessionId = metadataString(context.input.metadata, "sessionId");
      const userId = metadataString(context.input.metadata, "userId") ?? options.userIdFallback;

      if (!userId || !isEligibleRagCandidate(query, response.output, channel, policy)) {
        return;
      }

      await options.candidateStore.save({
        ...(channel ? { channel } : {}),
        query,
        response: response.output,
        runId: context.runId,
        ...(sessionId ? { sessionId } : {}),
        status: policy.requireReview ? "PENDING" : "INGESTED",
        userId
      });
    },
    id: options.id ?? "rag-ingestion-capture"
  };
}

export function createFeedbackMetadataCaptureHook(options: FeedbackMetadataCaptureHookOptions): HookStage {
  return {
    afterComplete: async (context, response) => {
      const query = firstUserMessage(context.input.messages);

      if (query.length === 0 || response.output.trim().length === 0) {
        return;
      }

      await options.feedbackStore.save({
        ...selectMetadata(context.input.metadata, [
          "channel",
          "domain",
          "intent",
          "sessionId",
          "templateId",
          "userId"
        ]),
        model: response.model,
        query,
        response: response.output,
        runId: context.runId,
        timestamp: context.startedAt.toISOString()
      });
    },
    id: options.id ?? "feedback-metadata-capture"
  };
}

export function createUserMemoryInjectionHook(options: UserMemoryInjectionHookOptions): HookStage {
  const maxEntries = Math.max(1, options.maxEntries ?? 12);

  return {
    beforeStart: async (context) => {
      const userId = metadataString(context.input.metadata, "userId");

      if (!userId) {
        return;
      }

      const memory = await options.memoryStore.findByUserId(userId);
      const memoryMessage = memory ? renderUserMemoryMessage(memory, maxEntries) : undefined;

      if (!memoryMessage) {
        return;
      }

      const input = context.input as {
        messages: readonly ModelMessage[];
      };
      input.messages = [memoryMessage, ...context.input.messages];
    },
    id: options.id ?? "user-memory-injection"
  };
}

function truncatePreview(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function countJsonItems(value: string): number | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;

    if (Array.isArray(parsed)) {
      return parsed.length;
    }

    if (isJsonRecord(parsed)) {
      const firstArray = Object.values(parsed).find(Array.isArray);
      return firstArray?.length;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function firstUserMessage(messages: readonly { readonly content: string; readonly role: string }[]): string {
  return messages.find((message) => message.role === "user")?.content.trim() ?? "";
}

function isEligibleRagCandidate(
  query: string,
  response: string,
  channel: string | undefined,
  policy: RagIngestionCapturePolicy
): boolean {
  if (query.trim().length < policy.minQueryChars || response.trim().length < policy.minResponseChars) {
    return false;
  }

  if (policy.allowedChannels.length > 0 && (!channel || !policy.allowedChannels.includes(channel))) {
    return false;
  }

  const combined = `${query}\n${response}`;
  return !policy.blockedPatterns.some((pattern) => pattern.length > 0 && new RegExp(pattern, "iu").test(combined));
}

function selectMetadata(metadata: JsonObject | undefined, keys: readonly string[]): JsonObject {
  const selected: Record<string, JsonValue> = {};

  for (const key of keys) {
    const value = metadata?.[key];

    if (typeof value === "string" && value.trim().length > 0) {
      selected[key] = value;
    }
  }

  return selected as JsonObject;
}

function renderUserMemoryMessage(memory: UserMemoryInjectionMemory, maxEntries: number): ModelMessage | undefined {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(memory.facts)) {
    if (value.trim().length > 0) {
      lines.push(`- Fact ${key}: ${value}`);
    }
  }

  for (const [key, value] of Object.entries(memory.preferences)) {
    if (value.trim().length > 0) {
      lines.push(`- Preference ${key}: ${value}`);
    }
  }

  for (const topic of memory.recentTopics ?? []) {
    if (topic.trim().length > 0) {
      lines.push(`- Recent topic: ${topic}`);
    }
  }

  if (lines.length === 0) {
    return undefined;
  }

  return {
    content: ["Relevant user memory:", ...lines.slice(0, maxEntries)].join("\n"),
    role: "system"
  };
}

function metadataString(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
