import { MessagingProviderError } from "./errors.js";
import type {
  MessagingProvider,
  MessagingProviderInfo,
  OutboundMessage,
  OutboundReceipt
} from "./types.js";
import { validateOutboundMessage } from "./validate.js";

export interface LineProviderOptions {
  /** Channel access token from the LINE Developers console. */
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
  /** Optional clock for synthesising the receipt id (tests inject). */
  readonly now?: () => Date;
}

const DEFAULT_BASE_URL = "https://api.line.me";

interface LineErrorResponse {
  readonly message?: string;
  readonly details?: ReadonlyArray<{ readonly message: string; readonly property?: string }>;
}

/**
 * LINE Messaging API push endpoint. Unlike Telegram/Discord/Slack
 * it does not return a message id on success — the body is `{}`. We
 * synthesise `line:{ISO timestamp}` so the OutboundReceipt contract
 * stays uniform across providers; downstream code that needs to
 * correlate replies has to use a future webhook (Phase 2) anyway.
 */
export class LineProvider implements MessagingProvider {
  readonly id = "line";
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly nowFn: () => Date;

  constructor(options: LineProviderOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.nowFn = options.now ?? (() => new Date());
  }

  describe(): MessagingProviderInfo {
    return {
      description: "LINE Messaging API (push, send only this iter).",
      displayName: "LINE",
      id: this.id
    };
  }

  async send(message: OutboundMessage): Promise<OutboundReceipt> {
    validateOutboundMessage(message);
    const response = await this.fetchImpl(`${this.baseUrl}/v2/bot/message/push`, {
      body: JSON.stringify({
        messages: [{ text: message.text, type: "text" }],
        to: message.destination
      }),
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json"
      },
      method: "POST"
    });
    if (!response.ok) {
      const text = await response.text();
      let parsed: LineErrorResponse | undefined;
      try {
        parsed = text.length > 0 ? (JSON.parse(text) as LineErrorResponse) : undefined;
      } catch {
        parsed = undefined;
      }
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `LINE pushMessage failed: ${parsed?.message ?? (text || response.statusText)}`,
        response.status
      );
    }
    return {
      destination: message.destination,
      messageId: `line:${this.nowFn().toISOString()}`,
      providerId: this.id
    };
  }
}
