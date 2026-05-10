import {
  MessagingProviderError,
  MessagingValidationError,
  type MessagingProviderRegistry
} from "@muse/messaging";
import type { JsonObject, JsonValue } from "@muse/shared";

import { errorMessage, readString } from "./loopback-helpers.js";
import type { LoopbackMcpServer } from "./loopback.js";

/**
 * `muse.messaging` loopback MCP server.
 *
 * Phase 3 of the messenger plan (see `docs/design/messaging.md`).
 * Once registered, the agent can call:
 *
 *   - `muse.messaging.providers` (read) — list providers the user
 *     has wired up (Telegram / Discord / Slack / LINE).
 *   - `muse.messaging.send` (write) — push a plain-text message
 *     through one of those providers, e.g. for "remind me on
 *     Telegram when the deploy finishes" or "send this brief to
 *     Slack".
 *   - `muse.messaging.inbox` (read) — Phase 2.a one-shot snapshot of
 *     recent inbound messages on a provider that supports it
 *     (Telegram landed first; Discord/Slack/LINE follow). The agent
 *     can answer "did Stark message me this morning?" without a
 *     daemon — every call is a fresh `getUpdates`.
 *
 * The server only registers when the runtime assembly's
 * `MessagingProviderRegistry` already has at least one provider —
 * we don't want the LLM to discover a tool that always errors with
 * "no providers configured".
 */
export interface MessagingMcpServerOptions {
  readonly registry: MessagingProviderRegistry;
}

export function createMessagingMcpServer(options: MessagingMcpServerOptions): LoopbackMcpServer {
  const { registry } = options;

  return {
    description:
      "Outbound messengers (Telegram / Discord / Slack / LINE). Send plain-text messages through any configured provider.",
    name: "muse.messaging",
    tools: [
      {
        description:
          "List the messaging providers the user has wired up. Each entry has `id` (use it for `send`), " +
          "`displayName`, and a free-form `description`. Empty array means no provider is configured.",
        execute: async (): Promise<JsonObject> => {
          const providers = registry.describe();
          return { providers: providers as unknown as JsonValue };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {},
          type: "object"
        },
        name: "providers",
        risk: "read"
      },
      {
        description:
          "Fetch a one-shot snapshot of recent inbound messages from a provider that supports inbound. " +
          "`providerId` from `providers` (telegram | discord | slack at this iter — line returns a clean " +
          "'not supported yet' error). `limit` is capped at 100 (default 20). Each entry is " +
          "{ messageId, source, sender?, receivedAtIso, text }. " +
          "`source` is required for per-channel providers (discord channel id, slack channel id like C0123ABCD); " +
          "telegram ignores it. " +
          "Use this to answer 'did anyone message me?' without a daemon — every call is a fresh fetch " +
          "with no offset state, so messages may repeat across calls.",
        execute: async (args): Promise<JsonObject> => {
          const providerId = readString(args, "providerId")?.trim();
          if (!providerId) {
            return { error: "providerId is required" };
          }
          const limitRaw = args["limit"];
          const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw)
            ? Math.max(1, Math.min(100, Math.trunc(limitRaw)))
            : undefined;
          const source = readString(args, "source")?.trim();
          const opts: { limit?: number; source?: string } = {};
          if (limit !== undefined) opts.limit = limit;
          if (source && source.length > 0) opts.source = source;
          try {
            const inbound = await registry.fetchInbound(providerId, Object.keys(opts).length > 0 ? opts : undefined);
            return {
              inbound: inbound as unknown as JsonValue,
              providerId,
              total: inbound.length
            };
          } catch (error) {
            if (error instanceof MessagingProviderError) {
              return {
                error: error.message,
                providerErrorCode: error.code,
                ...(error.status !== undefined ? { upstreamStatus: error.status } : {})
              };
            }
            return { error: errorMessage(error) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            limit: {
              description: "Max messages to return. Default 20, capped at 100.",
              type: "number"
            },
            providerId: {
              description: "Provider id from `providers` (telegram or discord at this iter).",
              type: "string"
            },
            source: {
              description: "Platform-native source — Discord channel id (required for discord). Telegram ignores this.",
              type: "string"
            }
          },
          required: ["providerId"],
          type: "object"
        },
        name: "inbox",
        risk: "read"
      },
      {
        description:
          "Send a plain-text message through a configured provider. " +
          "`providerId` is one of the ids returned by `providers` (telegram | discord | slack | line). " +
          "`destination` is platform-native: chat_id for Telegram (e.g. \"@username\" or \"123456789\"), " +
          "channel id for Discord (numeric snowflake), channel/user id for Slack (Cxxx / Uxxx), " +
          "userId/groupId/roomId for LINE. " +
          "`text` is the message body (≤4096 chars). Returns the platform message id when available.",
        execute: async (args): Promise<JsonObject> => {
          const providerId = readString(args, "providerId")?.trim();
          const destination = readString(args, "destination")?.trim();
          const text = readString(args, "text");
          if (!providerId) {
            return { error: "providerId is required" };
          }
          if (!destination) {
            return { error: "destination is required" };
          }
          if (text === undefined || text.length === 0) {
            return { error: "text is required" };
          }
          try {
            const receipt = await registry.send(providerId, { destination, text });
            return {
              destination: receipt.destination,
              messageId: receipt.messageId,
              providerId: receipt.providerId
            };
          } catch (error) {
            if (error instanceof MessagingValidationError) {
              return { error: `${error.field}: ${error.message}` };
            }
            if (error instanceof MessagingProviderError) {
              return {
                error: error.message,
                providerErrorCode: error.code,
                ...(error.status !== undefined ? { upstreamStatus: error.status } : {})
              };
            }
            return { error: errorMessage(error) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            destination: {
              description:
                "Platform-native chat / channel / user id. See tool description for per-provider examples.",
              type: "string"
            },
            providerId: {
              description: "Provider id from `providers` (telegram | discord | slack | line).",
              type: "string"
            },
            text: { description: "Plain-text message body (≤4096 chars).", type: "string" }
          },
          required: ["providerId", "destination", "text"],
          type: "object"
        },
        name: "send",
        risk: "write"
      }
    ]
  };
}
