import { errorMessage, truncateErrorBody } from "@muse/shared";

import { MessagingProviderError } from "./errors.js";
import { readInbox } from "./inbox-store.js";
import { clampInboundLimit, clampOutboundText, fetchWithTimeout, retryAfterMsFromResponse, tryParseJson } from "./provider-helpers.js";
import type {
  InboundFetchOptions,
  InboundMessage,
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
  /**
   * Persisted inbox path for inbound webhook events (Phase 2.b.3).
   * When set, `fetchInbound` reads from this file via
   * `@muse/messaging/readInbox`. When omitted, fetchInbound throws
   * `INVALID_DESTINATION` so the registry's "not supported" guard
   * keeps surfacing a clean error.
   */
  readonly inboxFile?: string;
  /** Per-request wall-clock timeout (ms). Default 30s. */
  readonly timeoutMs?: number;
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
  private readonly inboxFile: string | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(options: LineProviderOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.nowFn = options.now ?? (() => new Date());
    this.inboxFile = options.inboxFile;
    this.timeoutMs = options.timeoutMs;
  }

  describe(): MessagingProviderInfo {
    return {
      description: this.inboxFile
        ? "LINE Messaging API (push out, persisted webhook inbox in)."
        : "LINE Messaging API (push out; inbox needs MUSE_LINE_INBOX_FILE + webhook)",
      displayName: "LINE",
      id: this.id
    };
  }

  /**
   * Phase 2.b.3 inbound: read text events the webhook handler has
   * persisted to `inboxFile` via `appendInbound`. The file is
   * shared with `apps/api/src/messaging-webhooks-routes.ts`, so
   * what the bot received over webhook is exactly what
   * `fetchInbound` returns. When `inboxFile` isn't configured the
   * method throws so the registry's "not supported" guard keeps
   * surfacing a clean error rather than silently returning [].
   */
  async fetchInbound(options?: InboundFetchOptions): Promise<readonly InboundMessage[]> {
    if (!this.inboxFile) {
      throw new MessagingProviderError(
        this.id,
        "INVALID_DESTINATION",
        "LINE fetchInbound requires `inboxFile` (set MUSE_LINE_INBOX_FILE and run the webhook)"
      );
    }
    const limit = clampInboundLimit(options?.limit);
    return readInbox(this.inboxFile, limit);
  }

  async send(message: OutboundMessage): Promise<OutboundReceipt> {
    // Clamp before validation so a long brief / answer is delivered
    // truncated instead of dropped whole by
    // validateOutboundMessage's length throw (same as the
    // Telegram / Discord send path).
    const outboundText = clampOutboundText(message.text);
    validateOutboundMessage({ ...message, text: outboundText });
    // No link-preview-suppression field exists on the LINE text
    // message object — accepted residual risk, see outbound-safety.md.
    let response: Response;
    try {
      response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/v2/bot/message/push`, {
        body: JSON.stringify({
          messages: [{ text: outboundText, type: "text" }],
          to: message.destination
        }),
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json"
        },
        method: "POST"
      }, this.timeoutMs);
    } catch (cause) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `LINE pushMessage request failed: ${errorMessage(cause, "network request failed")}`
      );
    }
    if (!response.ok) {
      let text: string;
      try {
        text = await response.text();
      } catch (cause) {
        throw new MessagingProviderError(
          this.id,
          "UPSTREAM_FAILED",
          `LINE pushMessage failed with ${response.status.toString()}: unable to read error response: ${errorMessage(cause, "unknown response body failure")}`,
          response.status,
          retryAfterMsFromResponse(response)
        );
      }
      const parsed = tryParseJson<LineErrorResponse>(text);
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `LINE pushMessage failed: ${parsed?.message ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status,
        retryAfterMsFromResponse(response)
      );
    }
    return {
      destination: message.destination,
      messageId: `line:${this.nowFn().toISOString()}`,
      providerId: this.id
    };
  }
}
