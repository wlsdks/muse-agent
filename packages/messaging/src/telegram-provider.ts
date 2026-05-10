import { MessagingProviderError, MessagingValidationError } from "./errors.js";
import type {
  InboundFetchOptions,
  InboundMessage,
  MessagingProvider,
  MessagingProviderInfo,
  OutboundMessage,
  OutboundReceipt
} from "./types.js";
import { validateOutboundMessage } from "./validate.js";

export interface TelegramProviderOptions {
  /**
   * Bot token from @BotFather (`123456:ABC-...`). The `/bot` prefix
   * on the URL is added by the provider; pass the raw token only.
   */
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Override for tests / custom self-hosted Bot API. */
  readonly baseUrl?: string;
  /** Optional Telegram parse_mode (e.g. "MarkdownV2"). Off by default. */
  readonly parseMode?: "MarkdownV2" | "HTML";
}

const DEFAULT_BASE_URL = "https://api.telegram.org";

interface TelegramSendResponse {
  readonly ok: boolean;
  readonly description?: string;
  readonly result?: { readonly message_id: number };
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessageObject;
  readonly edited_message?: TelegramMessageObject;
  readonly channel_post?: TelegramMessageObject;
}

interface TelegramMessageObject {
  readonly message_id: number;
  readonly date: number;
  readonly text?: string;
  readonly chat: { readonly id: number; readonly username?: string; readonly title?: string };
  readonly from?: { readonly id: number; readonly username?: string; readonly first_name?: string };
}

interface TelegramGetUpdatesResponse {
  readonly ok: boolean;
  readonly description?: string;
  readonly result?: readonly TelegramUpdate[];
}

const MAX_INBOUND_LIMIT = 100;

export class TelegramProvider implements MessagingProvider {
  readonly id = "telegram";
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly parseMode: TelegramProviderOptions["parseMode"];

  constructor(options: TelegramProviderOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.parseMode = options.parseMode;
  }

  describe(): MessagingProviderInfo {
    return {
      description: "Telegram bot (Bot API REST). Outbound + one-shot inbound fetch.",
      displayName: "Telegram",
      id: this.id
    };
  }

  /**
   * One-shot fetch of recent updates via Bot API `getUpdates`. No
   * offset state is persisted — every call returns the most recent
   * `limit` updates currently visible to the bot. A future iter
   * will add a polling daemon that tracks `update_id` so messages
   * aren't re-delivered.
   *
   * Telegram caps `getUpdates` at 100 results per call regardless of
   * `limit`; we surface that ceiling rather than silently truncate.
   */
  async fetchInbound(options?: InboundFetchOptions): Promise<readonly InboundMessage[]> {
    const limit = clampInboundLimit(options?.limit);
    // `timeout=0` keeps the call short — the long-poll modes are for
    // the daemon, not this snapshot fetch.
    const url = `${this.baseUrl}/bot${this.token}/getUpdates?limit=${limit.toString()}&timeout=0`;
    const response = await this.fetchImpl(url, { method: "GET" });
    const text = await response.text();
    let parsed: TelegramGetUpdatesResponse | undefined;
    try {
      parsed = text.length > 0 ? (JSON.parse(text) as TelegramGetUpdatesResponse) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok || !parsed?.ok) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Telegram getUpdates failed: ${parsed?.description ?? (text || response.statusText)}`,
        response.status
      );
    }
    const updates = parsed.result ?? [];
    return updates.flatMap((update): readonly InboundMessage[] => {
      const message = update.message ?? update.edited_message ?? update.channel_post;
      if (!message || typeof message.text !== "string") {
        return [];
      }
      const senderUsername = message.from?.username;
      const senderName = senderUsername ?? message.from?.first_name ?? message.chat.username;
      return [{
        messageId: String(message.message_id),
        providerId: this.id,
        raw: update,
        receivedAtIso: new Date(message.date * 1000).toISOString(),
        ...(senderName ? { sender: senderName } : {}),
        source: String(message.chat.id),
        text: message.text
      }];
    });
  }

  async send(message: OutboundMessage): Promise<OutboundReceipt> {
    validateOutboundMessage(message);
    const response = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/sendMessage`, {
      body: JSON.stringify({
        chat_id: message.destination,
        text: message.text,
        ...(this.parseMode ? { parse_mode: this.parseMode } : {})
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    const text = await response.text();
    let parsed: TelegramSendResponse | undefined;
    try {
      parsed = text.length > 0 ? (JSON.parse(text) as TelegramSendResponse) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok || !parsed?.ok) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Telegram sendMessage failed: ${parsed?.description ?? (text || response.statusText)}`,
        response.status
      );
    }
    const messageId = parsed.result?.message_id;
    if (typeof messageId !== "number") {
      throw new MessagingProviderError(this.id, "UPSTREAM_FAILED", "Telegram response missing message_id");
    }
    return {
      destination: message.destination,
      messageId: String(messageId),
      providerId: this.id,
      raw: parsed.result
    };
  }
}

function clampInboundLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return 20;
  }
  return Math.max(1, Math.min(MAX_INBOUND_LIMIT, Math.trunc(raw)));
}

// Re-export so callers don't have to depend on the validate module.
export { MessagingValidationError };
