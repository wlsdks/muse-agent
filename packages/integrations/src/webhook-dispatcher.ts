/**
 * Generic webhook dispatcher + agent-lifecycle webhook hook extracted
 * from packages/integrations/src/index.ts.
 *
 * Owns the public `WebhookDispatcher` class (in-memory endpoint
 * registry, signed-payload posting via the configured `WebhookTransport`,
 * per-endpoint event-type filtering, fail-soft delivery records) and
 * the `createWebhookNotificationHook` HookStage factory that fans
 * agent-core lifecycle events (`before_start`, `after_complete`,
 * `before_tool`, `after_tool`, `on_error`) out to the dispatcher.
 *
 * Re-exported from the integrations barrel for backwards compatibility.
 */

import type { AgentRunContext, HookStage } from "@muse/agent-core";
import { createRunId, type JsonObject } from "@muse/shared";
import { createWebhookHeaders } from "./slack-signature.js";
import type {
  WebhookDelivery,
  WebhookDispatcherOptions,
  WebhookEndpoint,
  WebhookEvent,
  WebhookNotificationHookOptions,
  WebhookTransport
} from "./index.js";

export class WebhookDispatcher {
  private readonly endpoints = new Map<string, WebhookEndpoint>();
  private readonly transport: WebhookTransport;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: WebhookDispatcherOptions) {
    for (const endpoint of options.endpoints ?? []) {
      this.endpoints.set(endpoint.id, endpoint);
    }

    this.transport = options.transport;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => createRunId("webhook_event"));
  }

  register(endpoint: WebhookEndpoint): void {
    this.endpoints.set(endpoint.id, endpoint);
  }

  unregister(endpointId: string): void {
    this.endpoints.delete(endpointId);
  }

  listEndpoints(): readonly WebhookEndpoint[] {
    return [...this.endpoints.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async dispatch(
    input: Omit<WebhookEvent, "createdAt" | "id"> & { readonly id?: string }
  ): Promise<readonly WebhookDelivery[]> {
    const event: WebhookEvent = {
      createdAt: this.now(),
      id: input.id ?? this.idFactory(),
      payload: input.payload,
      runId: input.runId,
      type: input.type
    };
    const deliveries: WebhookDelivery[] = [];

    for (const endpoint of this.endpoints.values()) {
      if (!endpoint.enabled || !endpoint.events.includes(event.type)) {
        deliveries.push({ endpointId: endpoint.id, eventId: event.id, status: "skipped" });
        continue;
      }

      try {
        const body = eventToPayload(event);
        const headers = createWebhookHeaders(body, endpoint.secret);
        const response = await this.transport.post(endpoint.url, body, headers);
        deliveries.push({
          endpointId: endpoint.id,
          eventId: event.id,
          status: response.statusCode >= 200 && response.statusCode < 300 ? "delivered" : "failed",
          statusCode: response.statusCode
        });
      } catch (error) {
        deliveries.push({
          endpointId: endpoint.id,
          error: error instanceof Error ? error.message : "unknown webhook failure",
          eventId: event.id,
          status: "failed"
        });
      }
    }

    return deliveries;
  }
}

export function createWebhookNotificationHook(options: WebhookNotificationHookOptions): HookStage {
  const previewLength = Math.max(1, options.outputPreviewLength ?? 500);

  return {
    afterComplete: async (context, response) => {
      await options.dispatcher.dispatch({
        payload: {
          model: response.model,
          outputPreview: truncatePreview(response.output, previewLength),
          responseId: response.id
        },
        runId: context.runId,
        type: "after_complete"
      });
    },
    afterTool: async (context, toolCall, result) => {
      await options.dispatcher.dispatch({
        payload: {
          resultPreview: truncatePreview(result.output, previewLength),
          status: result.status,
          toolCallId: toolCall.id,
          toolName: toolCall.name
        },
        runId: context.runId,
        type: "after_tool"
      });
    },
    beforeStart: async (context) => {
      await options.dispatcher.dispatch({
        payload: runContextPayload(context),
        runId: context.runId,
        type: "before_start"
      });
    },
    beforeTool: async (context, toolCall) => {
      await options.dispatcher.dispatch({
        payload: {
          args: toolCall.arguments,
          toolCallId: toolCall.id,
          toolName: toolCall.name
        },
        runId: context.runId,
        type: "before_tool"
      });
    },
    id: options.id ?? "webhook-notification",
    onError: async (context, error) => {
      await options.dispatcher.dispatch({
        payload: errorPayload(error),
        runId: context.runId,
        type: "on_error"
      });
    }
  };
}

function eventToPayload(event: WebhookEvent): JsonObject {
  return {
    createdAt: event.createdAt.toISOString(),
    id: event.id,
    payload: event.payload,
    runId: event.runId,
    type: event.type
  };
}

function runContextPayload(context: AgentRunContext): JsonObject {
  return {
    metadata: context.input.metadata ?? {},
    model: context.input.model,
    startedAt: context.startedAt.toISOString()
  };
}

function errorPayload(error: unknown): JsonObject {
  if (error instanceof Error) {
    return {
      error: error.message,
      name: error.name
    };
  }

  return {
    error: String(error),
    name: "Error"
  };
}

function truncatePreview(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
