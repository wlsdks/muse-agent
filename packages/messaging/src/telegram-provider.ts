import { MessagingProviderError, MessagingValidationError } from "./errors.js";
import type {
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
      description: "Telegram bot (Bot API REST, send only this iter).",
      displayName: "Telegram",
      id: this.id
    };
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

// Re-export so callers don't have to depend on the validate module.
export { MessagingValidationError };
