import { truncateErrorBody } from "@muse/shared";

import { MessagingProviderError } from "./errors.js";
import { readInbox } from "./inbox-store.js";
import { clampInboundLimit, clampOutboundText, fetchReadWithRetry, fetchWithTimeout, tryParseJson } from "./provider-helpers.js";
import { readSlackAfter, writeSlackAfter } from "./slack-after-store.js";
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
  /**
   * When set, `pollUpdates` reads/writes a per-channel `ts` cursor
   * through this file (atomic tmp+rename). Without it, each
   * `pollUpdates` call is snapshot-style — the most recent `limit`
   * messages currently visible.
   */
  readonly afterFile?: string;
  /**
   * When set, `fetchInbound` reads from this persisted inbox file
   * (Phase 2.d.4 — mirrors Discord/Telegram). The Phase 2.d.3
   * polling daemon writes here, so the read API and the daemon
   * converge on the same store. When `source` is supplied alongside,
   * results are filtered to that channel id; otherwise all entries
   * are returned. Without `inboxFile`, fetchInbound stays in
   * snapshot mode and `source` remains required.
   */
  readonly inboxFile?: string;
  /** Per-request wall-clock timeout (ms). Default 30s. */
  readonly timeoutMs?: number;
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
  private readonly afterFile: string | undefined;
  private readonly inboxFile: string | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(options: SlackProviderOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.afterFile = options.afterFile;
    this.inboxFile = options.inboxFile;
    this.timeoutMs = options.timeoutMs;
  }

  describe(): MessagingProviderInfo {
    return {
      description: "Slack bot (Web API). Outbound chat.postMessage + per-channel inbound conversations.history.",
      displayName: "Slack",
      id: this.id
    };
  }

  /**
   * Read-side surface. When `inboxFile` is configured, returns the
   * persisted entries the polling daemon wrote (Phase 2.d.3+4); a
   * `source` option filters to that channel id, unset returns all.
   * When `inboxFile` isn't configured, falls through to a live
   * `conversations.history` snapshot — preserves the pre-2.d.4
   * one-shot path that the CLI/REST contract tests rely on, with
   * `source` still required in that mode.
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
    return this.fetchHistory(options, false);
  }

  /**
   * Polling-side surface for a daemon: like `fetchInbound` but
   * advances the per-channel `ts` cursor when an `afterFile` is
   * configured. Each call passes `oldest=<stored>` to Slack and
   * persists the newest `ts` back on success — so a polling tick
   * walks the channel rather than re-reading the same window.
   *
   * Without `afterFile`, behaves identically to `fetchInbound`.
   * `source` is required either way.
   */
  async pollUpdates(options?: InboundFetchOptions): Promise<readonly InboundMessage[]> {
    return this.fetchHistory(options, true);
  }

  private async fetchHistory(
    options: InboundFetchOptions | undefined,
    advanceCursor: boolean
  ): Promise<readonly InboundMessage[]> {
    const channel = options?.source?.trim();
    if (!channel || channel.length === 0) {
      throw new MessagingProviderError(
        this.id,
        "INVALID_DESTINATION",
        "Slack channel history requires `source` (channel id, e.g. C0123ABCD)"
      );
    }
    const limit = clampInboundLimit(options?.limit);
    const cursor = advanceCursor && this.afterFile
      ? await readSlackAfter(this.afterFile, channel)
      : undefined;
    const formParams: Record<string, string> = { channel, limit: limit.toString() };
    if (cursor !== undefined) {
      formParams["oldest"] = cursor;
    }
    const params = new URLSearchParams(formParams);
    const response = await fetchReadWithRetry(this.fetchImpl, `${this.baseUrl}/conversations.history`, {
      body: params.toString(),
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      method: "POST"
    }, { timeoutMs: this.timeoutMs });
    const text = await response.text();
    const parsed = tryParseJson<SlackHistoryResponse>(text);
    if (!response.ok || !parsed?.ok) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Slack conversations.history failed: ${parsed?.error ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status
      );
    }
    const messages = parsed.messages ?? [];
    // Newest-first response: advance cursor to the most recent `ts`
    // (ack everything seen, whether the entry survived the
    // text/empty filter or not).
    if (advanceCursor && this.afterFile && messages.length > 0) {
      const newest = pickNewestTs(messages);
      if (newest !== undefined) {
        await writeSlackAfter(this.afterFile, channel, newest);
      }
    }
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
    // Clamp before validation so a long message is delivered
    // truncated instead of dropped whole by
    // validateOutboundMessage's length throw (same as the
    // Telegram / Discord send path).
    const outboundText = clampOutboundText(message.text);
    validateOutboundMessage({ ...message, text: outboundText });
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/chat.postMessage`, {
      body: JSON.stringify({ channel: message.destination, text: escapeSlackText(outboundText) }),
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json; charset=utf-8"
      },
      method: "POST"
    }, this.timeoutMs);
    const text = await response.text();
    const parsed = tryParseJson<SlackPostMessageResponse>(text);
    if (!response.ok || !parsed?.ok) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Slack chat.postMessage failed: ${parsed?.error ?? (truncateErrorBody(text) || response.statusText)}`,
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
 * Slack always renders the `text` field as mrkdwn, so `&`, `<`,
 * `>` are control chars: an unescaped `<…>` is silently parsed as
 * a link / mention / `<!channel>` broadcast (a stray
 * channel-wide ping), and `&` mojibakes. Slack's documented rule
 * is to escape exactly these three (`&` first so `&lt;` isn't
 * double-escaped); everything else is literal.
 */
export function escapeSlackText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/**
 * Pick the most-recent Slack `ts` from a batch. `ts` is
 * `<epoch>.<microseconds>` — comparing as parseFloat is precise
 * enough for the cursor (Slack's own `oldest=` parameter compares
 * the same way), and avoids the lexicographic-on-string pitfall
 * for any future tooling that surfaces sub-second timestamps in a
 * different length.
 */
function pickNewestTs(messages: readonly SlackHistoryMessage[]): string | undefined {
  let best: number | undefined;
  let bestStr: string | undefined;
  for (const message of messages) {
    if (typeof message.ts !== "string" || message.ts.length === 0) {
      continue;
    }
    const parsed = Number.parseFloat(message.ts);
    if (!Number.isFinite(parsed)) {
      continue;
    }
    if (best === undefined || parsed > best) {
      best = parsed;
      bestStr = message.ts;
    }
  }
  return bestStr;
}

/**
 * Slack `ts` is `<epoch_seconds>.<microseconds>` as a string.
 * Convert to ISO-8601 with millisecond precision; falls back to
 * the raw string when parsing fails (defensive — Slack has been
 * known to ship `0` or empty in pathological cases). A finite
 * but out-of-range seconds value (corrupt / hand-edited / >Date
 * max) makes an Invalid Date whose toISOString() throws and
 * would reject the whole fetchInbound batch.
 */
export function tsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return ts;
  }
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) {
    return ts;
  }
  return date.toISOString();
}
