import { MessagingProviderError } from "./errors.js";
import type {
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
      description: "Discord bot (REST channels API, send only this iter).",
      displayName: "Discord",
      id: this.id
    };
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
    let parsed: DiscordMessageResponse | undefined;
    try {
      parsed = text.length > 0 ? (JSON.parse(text) as DiscordMessageResponse) : undefined;
    } catch {
      parsed = undefined;
    }
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
