import {
  MessagingProviderError,
  type MessagingProviderRegistry
} from "@muse/messaging";
import type { JsonObject, JsonValue } from "@muse/shared";

import { errorMessage, readString } from "@muse/mcp";
import type { LoopbackMcpServer, LoopbackMcpToolDefinition } from "@muse/mcp";
import { sendMessageWithApproval, type MessageApprovalGate } from "./message-send.js";

/**
 * Outbound-safety fail-close: a third-party send wired with the action log (the
 * production agent path) but NO draft-first approval gate must NOT auto-send —
 * the agent could draft the wrong recipient/content. With no confirmation
 * channel to deliver the draft, the send does not happen (outbound-safety.md
 * Rule 1/2). The gated `muse messaging send` CLI is the confirmed path; the
 * agent tool sends only when a real approval gate is explicitly wired.
 */
const DENY_WITHOUT_CONFIRMATION: MessageApprovalGate = () => ({
  approved: false,
  reason: "no draft-first confirmation channel is wired for the agent — review and send via `muse messaging send`"
});

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
/**
 * Agent-triggered "poll now" closure. When supplied to
 * `createMessagingMcpServer`, the `poll_now` tool is registered so
 * the LLM can request an off-cadence pull on a configured provider
 * — useful for "let me check Telegram right now" without waiting
 * for the next daemon tick.
 *
 * The closure dispatches to the provider's `pollUpdates` and writes
 * each new message to the daemon-shared inbox file, so the next
 * `inbox` call returns the freshly-ingested entries. Returns the
 * count for the LLM to acknowledge.
 *
 * Optional because not every runtime has the inbox-file plumbing
 * available (e.g. the MCP-only paths in tests). When omitted, the
 * tool simply isn't registered — same pattern as the empty-registry
 * branch.
 */
interface PollNowDispatcher {
  (providerId: string, source?: string): Promise<{ ingested: number }>;
}

/**
 * Iterates every pollable provider in the registry (Telegram + each
 * configured channel for Discord / Slack). Skips LINE (webhook-fed).
 * Returns per-provider ingestion counts plus any per-provider errors
 * so a single bad channel doesn't black out the rest.
 */
interface PollAllDispatcher {
  (): Promise<{
    readonly ingestedByProvider: Readonly<Record<string, number>>;
    readonly errors: readonly { readonly providerId: string; readonly message: string }[];
  }>;
}

export interface MessagingMcpServerOptions {
  readonly registry: MessagingProviderRegistry;
  readonly pollNow?: PollNowDispatcher;
  readonly pollAll?: PollAllDispatcher;
  /**
   * When both `actionLogFile` and `userId` are supplied, the `send`
   * tool routes through `sendMessageWithApproval` so every outbound
   * message is recorded (outbound-safety Rule 4) and an optional
   * `approvalGate` adds draft-first defense-in-depth. Omitted in
   * lightweight test/MCP-only paths, which keep the direct send.
   */
  readonly actionLogFile?: string;
  readonly userId?: string;
  readonly approvalGate?: MessageApprovalGate;
}

export function createMessagingMcpServer(options: MessagingMcpServerOptions): LoopbackMcpServer {
  const { registry, pollNow, pollAll, actionLogFile, userId, approvalGate } = options;

  const pollAllTool: LoopbackMcpToolDefinition[] = pollAll ? [{
    description:
      "Pull every wired provider in one call: Telegram (global) + each channel configured in " +
      "MUSE_DISCORD_POLL_CHANNELS / MUSE_SLACK_POLL_CHANNELS. LINE is webhook-fed and skipped. " +
      "Returns `{ ingestedByProvider: { telegram: 2, discord: 1, … }, errors: [...] }` — a single " +
      "bad channel doesn't black out the rest. Use this for 'any new messages anywhere?' " +
      "without making N separate poll_now calls.",
    execute: async (): Promise<JsonObject> => {
      try {
        const result = await pollAll();
        return {
          errors: result.errors as unknown as JsonValue,
          ingestedByProvider: result.ingestedByProvider as unknown as JsonValue
        };
      } catch (error) {
        return { error: errorMessage(error) };
      }
    },
    inputSchema: {
      additionalProperties: false,
      properties: {},
      type: "object"
    },
    domain: "messaging",
    name: "poll_all",
    risk: "write" as const
  }] : [];

  const pollNowTool: LoopbackMcpToolDefinition[] = pollNow ? [{
    description:
      "Trigger a poll on a per-channel/per-provider inbound source right now, bypassing the " +
      "daemon's cadence. Useful for 'check Telegram now' or 'pull Slack #ops latest' on demand. " +
      "Appends any new messages to the same inbox file the daemon writes, so a subsequent " +
      "`inbox` call returns them. `providerId` is one of `telegram` (source ignored), `discord` " +
      "(source = channel id, REQUIRED), `slack` (source = channel id like C0123ABCD, REQUIRED). " +
      "LINE is not pollable (it's webhook-fed); call `inbox` directly instead.",
    execute: async (args): Promise<JsonObject> => {
      const providerId = readString(args, "providerId")?.trim();
      if (!providerId) {
        return { error: "providerId is required" };
      }
      const source = readString(args, "source")?.trim();
      try {
        const result = await pollNow(providerId, source && source.length > 0 ? source : undefined);
        return { ingested: result.ingested, providerId };
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
        providerId: {
          description: "Provider id from `providers` (telegram | discord | slack).",
          type: "string"
        },
        source: {
          description:
            "Platform-native source — Discord channel id (required for discord), Slack channel " +
            "id like C0123ABCD (required for slack). Telegram ignores this.",
          type: "string"
        }
      },
      required: ["providerId"],
      type: "object"
    },
    domain: "messaging",
    name: "poll_now",
    risk: "write" as const
  }] : [];

  return {
    description:
      "Outbound messengers (Telegram / Discord / Slack / LINE). Send plain-text messages through any configured provider.",
    name: "muse.messaging",
    tools: [
      ...pollAllTool,
      ...pollNowTool,
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
        domain: "messaging",
        name: "providers",
        risk: "read"
      },
      {
        description:
          "Fetch a one-shot snapshot of recent inbound messages from a provider that supports inbound. " +
          "All four shipped providers (telegram | discord | slack | line) now implement it; LINE reads " +
          "from a webhook-persisted inbox file (Phase 2.b). `limit` is capped at 100 (default 20). Each " +
          "entry is { messageId, source, sender?, receivedAtIso, text }. " +
          "`source` is required for per-channel providers (discord channel id, slack channel id like " +
          "C0123ABCD); telegram and LINE ignore it. " +
          "Use this to answer 'did anyone message me?' without a daemon — Telegram/Discord/Slack hit a " +
          "fresh REST call (so messages may repeat across calls), LINE reads the persisted webhook inbox.",
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
        domain: "messaging",
        name: "inbox",
        risk: "read"
      },
      {
        description:
          "Send a plain-text message through the user's configured messenger. " +
          "OMIT `providerId` to use your single configured channel (it's resolved automatically); only set it " +
          "(to one of telegram | discord | slack | line) if you have MULTIPLE messengers configured. " +
          "`destination` is platform-native: chat_id for Telegram (e.g. \"@username\" or \"123456789\"), " +
          "channel id for Discord (numeric snowflake), channel/user id for Slack (Cxxx / Uxxx), " +
          "userId/groupId/roomId for LINE. " +
          "`text` is the message body (≤4096 chars). Returns the platform message id when available.",
        execute: async (args): Promise<JsonObject> => {
          const requested = readString(args, "providerId")?.trim();
          const destination = readString(args, "destination")?.trim();
          const text = readString(args, "text");
          if (!destination) {
            return { error: "destination is required" };
          }
          if (text === undefined || text.length === 0) {
            return { error: "text is required" };
          }
          // Resolve the channel from config instead of failing on the model's
          // guess: a single-user box usually has ONE messenger and the model
          // needn't know its id (it was observed guessing "telegram", which a
          // Slack/Discord/LINE user doesn't have). An explicit REGISTERED id is
          // honoured; a single configured provider is used; multiple + a
          // missing/unknown id → ASK (never guess among several). This RESOLVES
          // the provider from config rather than guessing (outbound-safety); the
          // draft-first gate below still shows the user the exact {provider,
          // destination, text}, so any provider/destination mismatch is caught
          // at confirm.
          const registered = registry.list();
          let providerId: string;
          if (requested && registry.has(requested)) {
            providerId = requested;
          } else if (registered.length === 1) {
            providerId = registered[0]!.describe().id;
          } else if (registered.length === 0) {
            return { error: "no messaging provider is configured — set one up first" };
          } else {
            const ids = registered.map((provider) => provider.describe().id).join(", ");
            return { error: `providerId must be one of your configured messengers: ${ids}${requested ? ` (got "${requested}")` : ""}` };
          }
          // Outbound-safety: when wired with an action log, record every
          // send (and honour an optional draft-first gate) instead of
          // transmitting silently — the gap this tool had vs email_send.
          if (actionLogFile && userId) {
            const outcome = await sendMessageWithApproval({
              actionLogFile,
              approvalGate: approvalGate ?? DENY_WITHOUT_CONFIRMATION,
              destination,
              providerId,
              registry,
              text,
              userId
            });
            if (outcome.sent) {
              return { destination: outcome.destination, messageId: outcome.messageId, providerId };
            }
            return { error: outcome.detail, ...(outcome.reason === "denied" ? { refused: true } : {}) };
          }
          // Fail-closed (outbound-safety.md): a third-party send is only allowed
          // through the approval gate + action log. When the server was built
          // WITHOUT that wiring (no actionLogFile/userId), refuse rather than
          // transmit unguarded — a wrong autonomous send can't be rolled back, so
          // a missing gate is a refusal, never a silent send.
          return {
            error: "messaging send is not configured for safe delivery (no approval gate / action log) — refusing to send unguarded",
            refused: true
          };
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
              description: "Optional — OMIT to use your single configured messenger (resolved automatically). Set it (telegram | discord | slack | line) only with multiple messengers configured.",
              type: "string"
            },
            text: { description: "Plain-text message body (≤4096 chars).", type: "string" }
          },
          required: ["destination", "text"],
          type: "object"
        },
        domain: "messaging",
        name: "send",
        risk: "write"
      }
    ]
  };
}
