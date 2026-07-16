import { errorMessage, isRecord, truncateErrorBody } from "@muse/shared";

import { MessagingProviderError } from "./errors.js";
import { readInbox } from "./inbox-store.js";
import { clampInboundLimit, clampLongPollSeconds, clampOutboundText, fetchReadWithRetry, fetchWithTimeout, retryAfterMsFromResponse, tryParseJson } from "./provider-helpers.js";
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

interface MatrixRoomSummary {
  /** MSC688 room summary — the joined-member headcount for the room. */
  readonly "m.joined_member_count"?: number;
}

interface MatrixSyncResponse extends MatrixErrorBody {
  readonly next_batch?: string;
  readonly rooms?: {
    readonly join?: Record<string, {
      readonly summary?: MatrixRoomSummary;
      readonly timeline?: { readonly events?: readonly MatrixTimelineEvent[] };
    }>;
  };
}

/**
 * A DM in Matrix is just a room with exactly the two participants (no
 * separate "DM" room type exists at the protocol level) — the
 * `m.joined_member_count` summary field is the closest signal. Absent
 * when the homeserver doesn't return room summaries for this sync
 * (older servers / certain filters); left undetermined rather than
 * guessed, per `effectiveScope`'s fail-close default.
 */
function matrixRoomScope(joinedMemberCount: number | undefined): "direct" | "shared" | undefined {
  if (joinedMemberCount === undefined) {
    return undefined;
  }
  return joinedMemberCount <= 2 ? "direct" : "shared";
}

/**
 * Matrix events are capped at 65536 bytes for the whole federation
 * PDU. Clamping the SOURCE at 16k chars keeps even an all-CJK body
 * (3 bytes/char in UTF-8) plus envelope under the cap instead of
 * having the homeserver reject the whole message with M_TOO_LARGE.
 */
const MATRIX_MAX_TEXT = 16_000;

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
    const response = await this.request("Matrix whoami request", () => fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/_matrix/client/v3/account/whoami`, {
      headers: this.authHeaders(),
      method: "GET"
    }, this.timeoutMs));
    const text = await this.readResponseText(response, "Matrix whoami");
    const parsed = tryParseJson<MatrixErrorBody & { user_id?: string }>(text);
    if (!response.ok || typeof parsed?.user_id !== "string") {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Matrix whoami failed: ${parsed?.error ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status,
        matrixRetryAfterMs(parsed)
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
    const longPoll = clampLongPollSeconds(options?.longPollSeconds, 60);
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit } } }));
    const url = `${this.baseUrl}/_matrix/client/v3/sync?timeout=${(longPoll * 1000).toString()}&filter=${filter}`
      + (since !== undefined ? `&since=${encodeURIComponent(since)}` : "");
    // The HTTP timeout must outlive the held long poll or every idle
    // sync aborts as a spurious network error.
    const readTimeoutMs = longPoll > 0
      ? Math.max(this.timeoutMs ?? 30_000, (longPoll + 15) * 1000)
      : this.timeoutMs;
    const response = await this.request("Matrix sync request", () => fetchReadWithRetry(this.fetchImpl, url, {
      headers: this.authHeaders(),
      method: "GET"
    }, { timeoutMs: readTimeoutMs }));
    const text = await this.readResponseText(response, "Matrix sync");
    const parsed = tryParseJson<MatrixSyncResponse>(text);
    if (!response.ok || typeof parsed?.next_batch !== "string" || parsed.next_batch.length === 0) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Matrix sync failed: ${parsed?.error ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status,
        matrixRetryAfterMs(parsed)
      );
    }
    const candidates = matrixSyncCandidates(parsed.rooms);
    // whoami only when something needs filtering — idle long polls
    // stay a single request.
    const ownUserId = candidates.length > 0 ? await this.resolveOwnUserId() : undefined;
    // Advance the token BEFORE filtering: events without a usable
    // body (state events, media, our own echoes) still need to be
    // acknowledged or the same batch is redelivered on every poll.
    if (this.sinceFile) {
      await writeMatrixSince(this.sinceFile, parsed.next_batch);
    }
    return candidates.flatMap((event): readonly InboundMessage[] => {
      if (event.sender === ownUserId) {
        return [];
      }
      const scope = matrixRoomScope(event.joinedMemberCount);
      return [{
        messageId: event.eventId,
        providerId: this.id,
        raw: event.raw,
        receivedAtIso: matrixTimestampToIso(event.originServerTs),
        ...(scope ? { scope } : {}),
        ...(event.sender ? { sender: event.sender } : {}),
        source: event.roomId,
        text: event.body
      }];
    });
  }

  async sendTyping(destination: string): Promise<void> {
    const userId = await this.resolveOwnUserId();
    const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(destination)}/typing/${encodeURIComponent(userId)}`;
    const response = await this.request("Matrix typing request", () => fetchWithTimeout(this.fetchImpl, url, {
      body: JSON.stringify({ timeout: 5000, typing: true }),
      headers: { ...this.authHeaders(), "content-type": "application/json" },
      method: "PUT"
    }, this.timeoutMs));
    const text = await this.readResponseText(response, "Matrix typing");
    if (!response.ok) {
      const parsed = tryParseJson<MatrixErrorBody>(text);
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Matrix typing failed: ${parsed?.error ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status,
        matrixRetryAfterMs(parsed)
      );
    }
  }

  async send(message: OutboundMessage): Promise<OutboundReceipt> {
    const outboundText = clampOutboundText(message.text, MATRIX_MAX_TEXT);
    validateOutboundMessage({ ...message, text: outboundText });
    // No sender-side field to suppress URL previews exists in the
    // Matrix spec (an `m.hint.no_preview` proposal is still open,
    // matrix-org/matrix-spec#1588) — accepted residual risk, see
    // outbound-safety.md.
    // Client-generated transaction id makes the PUT idempotent on the
    // homeserver — a retried request with the same txnId is deduplicated.
    this.txnCounter += 1;
    const txnId = message.idempotencyKey ?? `muse-${Date.now().toString()}-${this.txnCounter.toString()}`;
    const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(message.destination)}/send/m.room.message/${encodeURIComponent(txnId)}`;
    const response = await this.request("Matrix send request", () => fetchWithTimeout(this.fetchImpl, url, {
      body: JSON.stringify({ body: outboundText, msgtype: "m.text" }),
      headers: { ...this.authHeaders(), "content-type": "application/json" },
      method: "PUT"
    }, this.timeoutMs));
    const text = await this.readResponseText(response, "Matrix send");
    const parsed = tryParseJson<MatrixSendResponse>(text);
    if (!response.ok || typeof parsed?.event_id !== "string") {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Matrix send failed: ${parsed?.error ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status,
        retryAfterMsFromResponse(response, matrixRetryAfterSeconds(parsed))
      );
    }
    return {
      destination: message.destination,
      messageId: parsed.event_id,
      providerId: this.id,
      raw: parsed
    };
  }

  private async request(operation: string, invoke: () => Promise<Response>): Promise<Response> {
    try {
      return await invoke();
    } catch (cause) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `${operation} failed: ${errorMessage(cause, "network request failed")}`
      );
    }
  }

  private async readResponseText(response: Response, operation: string): Promise<string> {
    try {
      return await response.text();
    } catch (cause) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `${operation} failed with ${response.status.toString()}: unable to read response body: ${errorMessage(cause, "unknown response body failure")}`,
        response.status,
        retryAfterMsFromResponse(response)
      );
    }
  }
}

function matrixRetryAfterMs(body: MatrixErrorBody | undefined): number | undefined {
  return typeof body?.retry_after_ms === "number" && Number.isFinite(body.retry_after_ms) && body.retry_after_ms >= 0
    ? body.retry_after_ms
    : undefined;
}

function matrixRetryAfterSeconds(body: MatrixErrorBody | undefined): number | undefined {
  const retryAfterMs = matrixRetryAfterMs(body);
  return retryAfterMs === undefined ? undefined : retryAfterMs / 1000;
}

interface MatrixTextEventCandidate {
  readonly body: string;
  readonly eventId: string;
  readonly joinedMemberCount: number | undefined;
  readonly originServerTs: number | undefined;
  readonly raw: Record<string, unknown>;
  readonly roomId: string;
  readonly sender: string | undefined;
}

function matrixSyncCandidates(rooms: unknown): readonly MatrixTextEventCandidate[] {
  if (!isRecord(rooms) || !isRecord(rooms["join"])) {
    return [];
  }
  const candidates: MatrixTextEventCandidate[] = [];
  for (const [roomId, room] of Object.entries(rooms["join"])) {
    if (!isRecord(room) || !isRecord(room["timeline"]) || !Array.isArray(room["timeline"]["events"])) {
      continue;
    }
    const summary = isRecord(room["summary"]) ? room["summary"] : undefined;
    const memberCount = summary?.["m.joined_member_count"];
    const joinedMemberCount = typeof memberCount === "number" && Number.isSafeInteger(memberCount) && memberCount > 0
      ? memberCount
      : undefined;
    for (const rawEvent of room["timeline"]["events"]) {
      const candidate = matrixTextEvent(rawEvent);
      if (candidate) {
        candidates.push({ ...candidate, joinedMemberCount, roomId });
      }
    }
  }
  return candidates;
}

function matrixTextEvent(value: unknown): Omit<MatrixTextEventCandidate, "joinedMemberCount" | "roomId"> | undefined {
  if (!isRecord(value) || value["type"] !== "m.room.message" || !isRecord(value["content"])) {
    return undefined;
  }
  const content = value["content"];
  const body = content["body"];
  const eventId = value["event_id"];
  if (content["msgtype"] !== "m.text" || typeof body !== "string" || typeof eventId !== "string" || eventId.length === 0) {
    return undefined;
  }
  const originServerTs = value["origin_server_ts"];
  const sender = value["sender"];
  return {
    body,
    eventId,
    originServerTs: typeof originServerTs === "number" ? originServerTs : undefined,
    raw: value,
    sender: typeof sender === "string" ? sender : undefined
  };
}

function matrixTimestampToIso(timestamp: number | undefined): string {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    const date = new Date(timestamp);
    if (Number.isFinite(date.getTime())) {
      return date.toISOString();
    }
  }
  return new Date().toISOString();
}
