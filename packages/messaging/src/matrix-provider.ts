import { truncateErrorBody } from "@muse/shared";

import { MessagingProviderError } from "./errors.js";
import { readInbox } from "./inbox-store.js";
import { clampInboundLimit, clampOutboundText, fetchReadWithRetry, fetchWithTimeout, retryAfterMsFromResponse, tryParseJson } from "./provider-helpers.js";
import { readMatrixSince, writeMatrixSince } from "./matrix-since-store.js";
import type {
  InboundFetchOptions,
  InboundMessage,
  MessagingProvider,
  MessagingProviderInfo,
  OutboundMessage,
  OutboundReceipt
} from "./types.js";
import { validateOutboundMessage } from "./validate.js";

export interface MatrixProviderOptions {
  /** Homeserver base URL, e.g. `https://matrix.org`. Trailing slash tolerated. */
  readonly homeserverUrl: string;
  /** User access token (Element: Settings → Help & About → Advanced). */
  readonly accessToken: string;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * When set, `fetchInbound` reads from this persisted inbox file
   * (mirrors TelegramProvider). The sync daemon appends each
   * `pollUpdates` result to the same file, so the read API and the
   * daemon converge on the same store. Without it, `fetchInbound`
   * falls back to a live `pollUpdates` call.
   */
  readonly inboxFile?: string;
  /**
   * When set, `pollUpdates` passes `?since=<persisted next_batch>`
   * and persists the new token on success — the Matrix analogue of
   * Telegram's offset file. Without it every call is an initial
   * sync snapshot.
   */
  readonly sinceFile?: string;
  /** Per-request wall-clock timeout (ms). Default 30s. */
  readonly timeoutMs?: number;
}

interface MatrixErrorBody {
  readonly errcode?: string;
  readonly error?: string;
  /** M_LIMIT_EXCEEDED carries the wait in ms (not seconds). */
  readonly retry_after_ms?: number;
}

interface MatrixSendResponse extends MatrixErrorBody {
  readonly event_id?: string;
}

interface MatrixTimelineEvent {
  readonly type?: string;
  readonly event_id?: string;
  readonly sender?: string;
  readonly origin_server_ts?: number;
  readonly content?: { readonly msgtype?: string; readonly body?: unknown };
}

interface MatrixSyncResponse extends MatrixErrorBody {
  readonly next_batch?: string;
  readonly rooms?: {
    readonly join?: Record<string, { readonly timeline?: { readonly events?: readonly MatrixTimelineEvent[] } }>;
  };
}

/**
 * Matrix events are capped at 65536 bytes for the whole federation
 * PDU. Clamping the SOURCE at 16k chars keeps even an all-CJK body
 * (3 bytes/char in UTF-8) plus envelope under the cap instead of
 * having the homeserver reject the whole message with M_TOO_LARGE.
 */
const MATRIX_MAX_TEXT = 16_000;

/** Matrix holds `/sync` for `timeout` ms; clamp to a sane [0s, 60s]. */
function clampLongPollSeconds(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return 0;
  }
  return Math.max(0, Math.min(60, Math.trunc(raw)));
}

/**
 * Matrix channel adapter over the official Client-Server API v3 —
 * plain fetch, no SDK. Plaintext rooms only: E2EE (Olm/Megolm) is
 * NOT implemented, so encrypted rooms produce no readable inbound
 * and sends to them arrive unencrypted-unreadable for e2ee clients.
 */
export class MatrixProvider implements MessagingProvider {
  readonly id = "matrix";
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly inboxFile: string | undefined;
  private readonly sinceFile: string | undefined;
  private readonly timeoutMs: number | undefined;
  private ownUserId: string | undefined;
  private txnCounter = 0;

  constructor(options: MatrixProviderOptions) {
    this.baseUrl = options.homeserverUrl.replace(/\/+$/u, "");
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.inboxFile = options.inboxFile;
    this.sinceFile = options.sinceFile;
    this.timeoutMs = options.timeoutMs;
  }

  describe(): MessagingProviderInfo {
    return {
      description: "Matrix (Client-Server API v3 REST). Outbound + sync inbound. Plaintext rooms only — E2EE rooms are not supported.",
      displayName: "Matrix",
      id: this.id
    };
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.accessToken}` };
  }

  /**
   * Resolve (and cache) the token's own user id via `/account/whoami`.
   * Needed to drop the bot's own echoes from `/sync` (Matrix streams
   * the client's own sends back in the room timeline) and to address
   * the per-user typing endpoint.
   */
  private async resolveOwnUserId(): Promise<string> {
    if (this.ownUserId) {
      return this.ownUserId;
    }
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/_matrix/client/v3/account/whoami`, {
      headers: this.authHeaders(),
      method: "GET"
    }, this.timeoutMs);
    const text = await response.text();
    const parsed = tryParseJson<MatrixErrorBody & { user_id?: string }>(text);
    if (!response.ok || typeof parsed?.user_id !== "string") {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Matrix whoami failed: ${parsed?.error ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status
      );
    }
    this.ownUserId = parsed.user_id;
    return parsed.user_id;
  }

  async fetchInbound(options?: InboundFetchOptions): Promise<readonly InboundMessage[]> {
    if (this.inboxFile) {
      const limit = clampInboundLimit(options?.limit);
      return readInbox(this.inboxFile, limit);
    }
    return this.pollUpdates(options);
  }

  /**
   * Hit `/sync` directly. With a `sinceFile` the call passes
   * `?since=<stored>` and persists the returned `next_batch` — so a
   * polling daemon advances through the event stream rather than
   * re-running an initial sync. A daemon passes `longPollSeconds`
   * so the homeserver HOLDS the request (`timeout` ms) and returns
   * the instant an event arrives — Matrix's native real-time
   * mechanism, no websocket needed.
   */
  async pollUpdates(options?: InboundFetchOptions & { readonly longPollSeconds?: number }): Promise<readonly InboundMessage[]> {
    const limit = clampInboundLimit(options?.limit);
    const since = this.sinceFile ? await readMatrixSince(this.sinceFile) : undefined;
    const longPoll = clampLongPollSeconds(options?.longPollSeconds);
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit } } }));
    const url = `${this.baseUrl}/_matrix/client/v3/sync?timeout=${(longPoll * 1000).toString()}&filter=${filter}`
      + (since !== undefined ? `&since=${encodeURIComponent(since)}` : "");
    // The HTTP timeout must outlive the held long poll or every idle
    // sync aborts as a spurious network error.
    const readTimeoutMs = longPoll > 0
      ? Math.max(this.timeoutMs ?? 30_000, (longPoll + 15) * 1000)
      : this.timeoutMs;
    const response = await fetchReadWithRetry(this.fetchImpl, url, {
      headers: this.authHeaders(),
      method: "GET"
    }, { timeoutMs: readTimeoutMs });
    const text = await response.text();
    const parsed = tryParseJson<MatrixSyncResponse>(text);
    if (!response.ok || typeof parsed?.next_batch !== "string") {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Matrix sync failed: ${parsed?.error ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status
      );
    }
    const joined = parsed.rooms?.join ?? {};
    const events: { readonly roomId: string; readonly event: MatrixTimelineEvent }[] = [];
    for (const [roomId, room] of Object.entries(joined)) {
      for (const event of room.timeline?.events ?? []) {
        events.push({ event, roomId });
      }
    }
    const candidates = events.filter(({ event }) =>
      event.type === "m.room.message"
      && event.content?.msgtype === "m.text"
      && typeof event.content.body === "string"
      && typeof event.event_id === "string"
    );
    // whoami only when something needs filtering — idle long polls
    // stay a single request.
    const ownUserId = candidates.length > 0 ? await this.resolveOwnUserId() : undefined;
    // Advance the token BEFORE filtering: events without a usable
    // body (state events, media, our own echoes) still need to be
    // acknowledged or the same batch is redelivered on every poll.
    if (this.sinceFile) {
      await writeMatrixSince(this.sinceFile, parsed.next_batch);
    }
    return candidates.flatMap(({ event, roomId }): readonly InboundMessage[] => {
      if (event.sender === ownUserId) {
        return [];
      }
      return [{
        messageId: event.event_id!,
        providerId: this.id,
        raw: event,
        receivedAtIso: typeof event.origin_server_ts === "number"
          ? new Date(event.origin_server_ts).toISOString()
          : new Date().toISOString(),
        ...(event.sender ? { sender: event.sender } : {}),
        source: roomId,
        text: event.content!.body as string
      }];
    });
  }

  async sendTyping(destination: string): Promise<void> {
    const userId = await this.resolveOwnUserId();
    const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(destination)}/typing/${encodeURIComponent(userId)}`;
    const response = await fetchWithTimeout(this.fetchImpl, url, {
      body: JSON.stringify({ timeout: 5000, typing: true }),
      headers: { ...this.authHeaders(), "content-type": "application/json" },
      method: "PUT"
    }, this.timeoutMs);
    const text = await response.text();
    if (!response.ok) {
      const parsed = tryParseJson<MatrixErrorBody>(text);
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Matrix typing failed: ${parsed?.error ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status
      );
    }
  }

  async send(message: OutboundMessage): Promise<OutboundReceipt> {
    const outboundText = clampOutboundText(message.text, MATRIX_MAX_TEXT);
    validateOutboundMessage({ ...message, text: outboundText });
    // Client-generated transaction id makes the PUT idempotent on the
    // homeserver — a retried request with the same txnId is deduplicated.
    this.txnCounter += 1;
    const txnId = `muse-${Date.now().toString()}-${this.txnCounter.toString()}`;
    const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(message.destination)}/send/m.room.message/${txnId}`;
    const response = await fetchWithTimeout(this.fetchImpl, url, {
      body: JSON.stringify({ body: outboundText, msgtype: "m.text" }),
      headers: { ...this.authHeaders(), "content-type": "application/json" },
      method: "PUT"
    }, this.timeoutMs);
    const text = await response.text();
    const parsed = tryParseJson<MatrixSendResponse>(text);
    if (!response.ok || typeof parsed?.event_id !== "string") {
      const bodyRetrySeconds = typeof parsed?.retry_after_ms === "number" ? parsed.retry_after_ms / 1000 : undefined;
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Matrix send failed: ${parsed?.error ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status,
        retryAfterMsFromResponse(response, bodyRetrySeconds)
      );
    }
    return {
      destination: message.destination,
      messageId: parsed.event_id,
      providerId: this.id,
      raw: parsed
    };
  }
}
