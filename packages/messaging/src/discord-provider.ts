import { truncateErrorBody } from "@muse/shared";

import { readDiscordAfter, writeDiscordAfter } from "./discord-after-store.js";
import { MessagingProviderError } from "./errors.js";
import { readInbox } from "./inbox-store.js";
import { clampInboundLimit, clampOutboundText, fetchReadWithRetry, fetchWithTimeout, retryAfterMsFromResponse, tryParseJson } from "./provider-helpers.js";
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
  /**
   * When set, `pollUpdates` reads/writes a per-channel "after"
   * cursor through this file (atomic tmp+rename). Without it,
   * each `pollUpdates` call is snapshot-style: returns the most
   * recent `limit` messages currently visible to the bot.
   */
  readonly afterFile?: string;
  /**
   * When set, `fetchInbound` reads from this persisted inbox file
   * (mirrors Telegram/LINE). The polling daemon writes here, so the
   * read API and the daemon converge on the same store. When `source`
   * is supplied alongside, results are filtered to that channel id;
   * otherwise all entries are returned. Without `inboxFile`,
   * fetchInbound stays in snapshot mode and `source` remains required.
   */
  readonly inboxFile?: string;
  /** Per-request wall-clock timeout (ms). Default 30s. */
  readonly timeoutMs?: number;
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
  private readonly afterFile: string | undefined;
  private readonly inboxFile: string | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(options: DiscordProviderOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.apiVersion = options.apiVersion ?? DEFAULT_VERSION;
    this.afterFile = options.afterFile;
    this.inboxFile = options.inboxFile;
    this.timeoutMs = options.timeoutMs;
  }

  describe(): MessagingProviderInfo {
    return {
      description: "Discord bot (REST channels API). Outbound + per-channel inbound fetch.",
      displayName: "Discord",
      id: this.id
    };
  }

  /**
   * Read-side surface. When `inboxFile` is configured, returns the
   * persisted entries the polling daemon wrote; a `source` option
   * filters to that channel id, and unset returns all. When
   * `inboxFile` isn't configured, falls through to a live snapshot
   * via `fetchMessages` — preserves the one-shot path that the
   * CLI/REST contract tests rely on, with `source` still required in
   * that mode.
   */
  async fetchInbound(options?: InboundFetchOptions): Promise<readonly InboundMessage[]> {
    if (this.inboxFile) {
      const limit = clampInboundLimit(options?.limit);
      const all = await readInbox(this.inboxFile, limit);
      const source = options?.source?.trim();
      if (!source || source.length === 0) {
        return all;
      }
      return all.filter((message) => message.source === source);
    }
    return this.fetchMessages(options, false);
  }

  /**
   * Polling-side surface for a daemon: like `fetchInbound` but
   * advances the per-channel "after" cursor when an `afterFile` is
   * configured. Each call passes `?after=<stored>` to Discord and
   * persists the newest message id back on success — so a polling
   * tick walks the channel rather than re-reading the same window.
   *
   * Without `afterFile`, behaves identically to `fetchInbound`
   * (snapshot of newest `limit`). `source` is required either way.
   */
  async pollUpdates(options?: InboundFetchOptions): Promise<readonly InboundMessage[]> {
    return this.fetchMessages(options, true);
  }

  private async fetchMessages(
    options: InboundFetchOptions | undefined,
    advanceCursor: boolean
  ): Promise<readonly InboundMessage[]> {
    const channelId = options?.source?.trim();
    if (!channelId || channelId.length === 0) {
      throw new MessagingProviderError(
        this.id,
        "INVALID_DESTINATION",
        "Discord channel messages require `source` (channel id)"
      );
    }
    const limit = clampInboundLimit(options?.limit);
    const cursor = advanceCursor && this.afterFile
      ? await readDiscordAfter(this.afterFile, channelId)
      : undefined;
    const url = `${this.baseUrl}/${this.apiVersion}/channels/${encodeURIComponent(channelId)}/messages?limit=${limit.toString()}`
      + (cursor !== undefined ? `&after=${encodeURIComponent(cursor)}` : "");
    const response = await fetchReadWithRetry(this.fetchImpl, url, {
      headers: { authorization: `Bot ${this.token}` },
      method: "GET"
    }, { timeoutMs: this.timeoutMs });
    const text = await response.text();
    if (!response.ok) {
      const errorPayload = tryParseJson<DiscordErrorResponse>(text);
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Discord channels.messages failed: ${errorPayload?.message ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status
      );
    }
    const parsed = tryParseJson<readonly DiscordChannelMessage[]>(text);
    const messages: readonly DiscordChannelMessage[] = Array.isArray(parsed) ? parsed : [];
    // Discord returns newest-first. Advance the cursor on ANY id
    // seen — even messages we filter out client-side (empty content)
    // must be ack'd or we'll re-poll them.
    if (advanceCursor && this.afterFile && messages.length > 0) {
      const newest = pickNewestId(messages);
      if (newest !== undefined) {
        await writeDiscordAfter(this.afterFile, channelId, newest);
      }
    }
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
        // `scope` intentionally omitted: the REST `/channels/:id/messages`
        // response carries no DM-vs-guild-channel signal (that lives on
        // the separate `GET /channels/:id` object, `type` 1 = DM, which
        // this per-message poll never fetches). Absent resolves to
        // "shared" via `effectiveScope` — fail-close, never guessed as 1:1.
        ...(senderName ? { sender: senderName } : {}),
        source: message.channel_id ?? channelId,
        text: message.content
      }];
    });
  }

  async send(message: OutboundMessage): Promise<OutboundReceipt> {
    // Discord's content hard-limit is 2000 — below
    // validateOutboundMessage's 4096 — so a 2001..4096-char
    // message would pass validation then be 400-dropped by the
    // API. Truncate so it's delivered instead.
    const outboundText = clampOutboundText(message.text, 2000);
    validateOutboundMessage({ ...message, text: outboundText });
    const url = `${this.baseUrl}/${this.apiVersion}/channels/${encodeURIComponent(message.destination)}/messages`;
    const response = await fetchWithTimeout(this.fetchImpl, url, {
      // `parse: []` suppresses ALL mention resolution: a literal
      // `@everyone` / `@here` / `<@id>` in agent output (a quote, a
      // code snippet) would otherwise ping the whole server. The
      // text still shows verbatim; it just doesn't notify.
      body: JSON.stringify({ allowed_mentions: { parse: [] }, content: outboundText }),
      headers: {
        authorization: `Bot ${this.token}`,
        "content-type": "application/json"
      },
      method: "POST"
    }, this.timeoutMs);
    const text = await response.text();
    const parsed = tryParseJson<DiscordMessageResponse>(text);
    if (!response.ok) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Discord sendMessage failed: ${parsed?.message ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status,
        retryAfterMsFromResponse(response)
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

/**
 * Discord snowflakes are 64-bit timestamp-encoded integers
 * serialised as decimal strings. Lexicographic compare works only
 * when lengths match; for safety pick the BigInt-max so a 19-digit
 * id never loses to a 18-digit one.
 */
function pickNewestId(messages: readonly DiscordChannelMessage[]): string | undefined {
  let best: bigint | undefined;
  let bestStr: string | undefined;
  for (const message of messages) {
    if (typeof message.id !== "string" || message.id.length === 0) {
      continue;
    }
    let asBig: bigint;
    try {
      asBig = BigInt(message.id);
    } catch {
      continue;
    }
    if (best === undefined || asBig > best) {
      best = asBig;
      bestStr = message.id;
    }
  }
  return bestStr;
}

