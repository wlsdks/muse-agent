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

export interface SlackProviderOptions {
  /** Bot user OAuth token, e.g. `xoxb-...`. */
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://slack.com/api";

interface SlackPostMessageResponse {
  readonly ok: boolean;
  readonly ts?: string;
  readonly channel?: string;
  readonly error?: string;
}

interface SlackHistoryMessage {
  readonly ts: string;
  readonly type?: string;
  readonly subtype?: string;
  readonly user?: string;
  readonly bot_id?: string;
  readonly username?: string;
  readonly text?: string;
}

interface SlackHistoryResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly messages?: readonly SlackHistoryMessage[];
}

export class SlackProvider implements MessagingProvider {
  readonly id = "slack";
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(options: SlackProviderOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  describe(): MessagingProviderInfo {
    return {
      description: "Slack bot (Web API). Outbound chat.postMessage + per-channel inbound conversations.history.",
      displayName: "Slack",
      id: this.id
    };
  }

  /**
   * One-shot fetch of recent messages from a single channel via
   * Slack's `conversations.history` endpoint. Like Discord, Slack
   * is per-channel (no global "what's incoming" stream), so the
   * caller MUST pass the channel id as `options.source`. The
   * Real-time Messaging / Socket Mode push delivery lands in
   * Phase 2.b.
   *
   * Slack returns each message's `ts` (an epoch-seconds string with
   * microsecond precision); we surface that both as the receipt id
   * AND parse it into ISO-8601 for `receivedAtIso`. Bot messages
   * (subtype="bot_message" or no `user`) are kept — the LLM may want
   * to read its own outgoing trail too.
   */
  async fetchInbound(options?: InboundFetchOptions): Promise<readonly InboundMessage[]> {
    const channel = options?.source?.trim();
    if (!channel || channel.length === 0) {
      throw new MessagingProviderError(
        this.id,
        "INVALID_DESTINATION",
        "Slack fetchInbound requires `source` (channel id, e.g. C0123ABCD)"
      );
    }
    const limit = clampInboundLimit(options?.limit);
    const params = new URLSearchParams({ channel, limit: limit.toString() });
    const response = await this.fetchImpl(`${this.baseUrl}/conversations.history`, {
      body: params.toString(),
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      method: "POST"
    });
    const text = await response.text();
    const parsed = tryParseJson<SlackHistoryResponse>(text);
    if (!response.ok || !parsed?.ok) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Slack conversations.history failed: ${parsed?.error ?? (text || response.statusText)}`,
        response.status
      );
    }
    const messages = parsed.messages ?? [];
    return messages.flatMap((message): readonly InboundMessage[] => {
      if (typeof message.text !== "string" || message.text.length === 0) {
        return [];
      }
      const senderId = message.username ?? message.user ?? message.bot_id;
      return [{
        messageId: message.ts,
        providerId: this.id,
        raw: message,
        receivedAtIso: tsToIso(message.ts),
        ...(senderId ? { sender: senderId } : {}),
        source: channel,
        text: message.text
      }];
    });
  }

  async send(message: OutboundMessage): Promise<OutboundReceipt> {
    validateOutboundMessage(message);
    const response = await this.fetchImpl(`${this.baseUrl}/chat.postMessage`, {
      body: JSON.stringify({ channel: message.destination, text: message.text }),
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json; charset=utf-8"
      },
      method: "POST"
    });
    const text = await response.text();
    const parsed = tryParseJson<SlackPostMessageResponse>(text);
    if (!response.ok || !parsed?.ok) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Slack chat.postMessage failed: ${parsed?.error ?? (text || response.statusText)}`,
        response.status
      );
    }
    if (!parsed.ts) {
      throw new MessagingProviderError(this.id, "UPSTREAM_FAILED", "Slack response missing ts");
    }
    return {
      destination: parsed.channel ?? message.destination,
      messageId: parsed.ts,
      providerId: this.id,
      raw: parsed
    };
  }
}

/**
 * Slack `ts` is `<epoch_seconds>.<microseconds>` as a string.
 * Convert to ISO-8601 with millisecond precision; falls back to
 * the raw string when parsing fails (defensive — Slack has been
 * known to ship `0` or empty in pathological cases).
 */
function tsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return ts;
  }
  return new Date(seconds * 1000).toISOString();
}
