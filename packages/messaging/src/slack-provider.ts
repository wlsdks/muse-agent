import { MessagingProviderError } from "./errors.js";
import type {
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
      description: "Slack bot (chat.postMessage, send only this iter).",
      displayName: "Slack",
      id: this.id
    };
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
    let parsed: SlackPostMessageResponse | undefined;
    try {
      parsed = text.length > 0 ? (JSON.parse(text) as SlackPostMessageResponse) : undefined;
    } catch {
      parsed = undefined;
    }
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
