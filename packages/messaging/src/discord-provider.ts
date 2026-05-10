import { MessagingProviderError } from "./errors.js";
import { clampInboundLimit, tryParseJson } from "./provider-helpers.js";
import type {
  InboundFetchOptions,
  InboundMessage,
  MessagingProvider,
  MessagingProviderInfo,
  OutboundMessage,
  OutboundReceipt
} from "./types.js";
import { validateOutboundMessage } from "./validate.js";

export interface DiscordProviderOptions {
  /** Bot token from the Discord Developer Portal (no `Bot ` prefix). */
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Override for tests or proxied API endpoints. */
  readonly baseUrl?: string;
  /** API version (default v10). */
  readonly apiVersion?: string;
}

const DEFAULT_BASE_URL = "https://discord.com/api";
const DEFAULT_VERSION = "v10";

interface DiscordMessageResponse {
  readonly id?: string;
  readonly message?: string;
  readonly code?: number;
}

interface DiscordChannelMessage {
  readonly id: string;
  readonly channel_id?: string;
  readonly content?: string;
  readonly timestamp?: string;
  readonly author?: { readonly id?: string; readonly username?: string; readonly global_name?: string };
}

interface DiscordErrorResponse {
  readonly message?: string;
  readonly code?: number;
}

export class DiscordProvider implements MessagingProvider {
  readonly id = "discord";
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly apiVersion: string;

  constructor(options: DiscordProviderOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.apiVersion = options.apiVersion ?? DEFAULT_VERSION;
  }

  describe(): MessagingProviderInfo {
    return {
      description: "Discord bot (REST channels API). Outbound + per-channel inbound fetch.",
      displayName: "Discord",
      id: this.id
    };
  }

  /**
   * One-shot fetch of recent messages from a single channel via the
   * `GET /channels/:id/messages?limit=N` REST endpoint. Discord
   * doesn't have a global "what's incoming?" stream like Telegram's
   * `getUpdates`, so the caller MUST pass the channel id as
   * `options.source`.
   *
   * Discord caps `limit` at 100; we surface that ceiling rather than
   * silently truncate. Long-poll / Gateway streaming for push-style
   * delivery lands in Phase 2.b.
   */
  async fetchInbound(options?: InboundFetchOptions): Promise<readonly InboundMessage[]> {
    const channelId = options?.source?.trim();
    if (!channelId || channelId.length === 0) {
      throw new MessagingProviderError(
        this.id,
        "INVALID_DESTINATION",
        "Discord fetchInbound requires `source` (channel id)"
      );
    }
    const limit = clampInboundLimit(options?.limit);
    const url = `${this.baseUrl}/${this.apiVersion}/channels/${encodeURIComponent(channelId)}/messages?limit=${limit.toString()}`;
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Bot ${this.token}` },
      method: "GET"
    });
    const text = await response.text();
    if (!response.ok) {
      const errorPayload = tryParseJson<DiscordErrorResponse>(text);
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Discord channels.messages failed: ${errorPayload?.message ?? (text || response.statusText)}`,
        response.status
      );
    }
    const parsed = tryParseJson<readonly DiscordChannelMessage[]>(text);
    const messages: readonly DiscordChannelMessage[] = Array.isArray(parsed) ? parsed : [];
    return messages.flatMap((message): readonly InboundMessage[] => {
      if (typeof message.content !== "string" || message.content.length === 0) {
        return [];
      }
      const senderName = message.author?.global_name ?? message.author?.username;
      return [{
        messageId: message.id,
        providerId: this.id,
        raw: message,
        receivedAtIso: message.timestamp ?? new Date().toISOString(),
        ...(senderName ? { sender: senderName } : {}),
        source: message.channel_id ?? channelId,
        text: message.content
      }];
    });
  }

  async send(message: OutboundMessage): Promise<OutboundReceipt> {
    validateOutboundMessage(message);
    const url = `${this.baseUrl}/${this.apiVersion}/channels/${encodeURIComponent(message.destination)}/messages`;
    const response = await this.fetchImpl(url, {
      body: JSON.stringify({ content: message.text }),
      headers: {
        authorization: `Bot ${this.token}`,
        "content-type": "application/json"
      },
      method: "POST"
    });
    const text = await response.text();
    const parsed = tryParseJson<DiscordMessageResponse>(text);
    if (!response.ok) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Discord sendMessage failed: ${parsed?.message ?? (text || response.statusText)}`,
        response.status
      );
    }
    if (!parsed?.id) {
      throw new MessagingProviderError(this.id, "UPSTREAM_FAILED", "Discord response missing message id");
    }
    return {
      destination: message.destination,
      messageId: parsed.id,
      providerId: this.id,
      raw: parsed
    };
  }
}

