import { truncateErrorBody } from "@muse/shared";

import { MessagingProviderError, MessagingValidationError } from "./errors.js";
import { readInbox } from "./inbox-store.js";
import { clampInboundLimit, clampOutboundText, fetchReadWithRetry, fetchWithTimeout, tryParseJson } from "./provider-helpers.js";
import { readTelegramOffset, writeTelegramOffset } from "./telegram-offset-store.js";
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
  /**
   * When set, `pollUpdates` advances through the update queue using
   * `?offset=<update_id+1>` and persists the high-watermark to this
   * file (atomic tmp+rename). Without it, every call returns the
   * most-recent snapshot — fine for one-shot inspection, wrong for a
   * polling daemon that must not reprocess messages.
   */
  readonly offsetFile?: string;
  /**
   * When set, `fetchInbound` reads from this persisted inbox file
   * (mirrors LineProvider). The Phase 2.a.3 polling daemon appends
   * each `pollUpdates` result to the same file, so the read API and
   * the daemon converge on the same store. Without it, `fetchInbound`
   * falls back to a live `pollUpdates` call — the one-shot snapshot
   * path used by CLI inspection.
   */
  readonly inboxFile?: string;
  /** Per-request wall-clock timeout (ms). Default 30s. */
  readonly timeoutMs?: number;
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

export class TelegramProvider implements MessagingProvider {
  readonly id = "telegram";
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly parseMode: TelegramProviderOptions["parseMode"];
  private readonly offsetFile: string | undefined;
  private readonly inboxFile: string | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(options: TelegramProviderOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.parseMode = options.parseMode;
    this.offsetFile = options.offsetFile;
    this.inboxFile = options.inboxFile;
    this.timeoutMs = options.timeoutMs;
  }

  describe(): MessagingProviderInfo {
    return {
      description: "Telegram bot (Bot API REST). Outbound + one-shot inbound fetch.",
      displayName: "Telegram",
      id: this.id
    };
  }

  /**
   * Read-side surface: when `inboxFile` is configured, return the
   * persisted entries the polling daemon (see `pollUpdates`) wrote.
   * When it isn't, fall through to a live `pollUpdates` call — the
   * legacy one-shot path that CLI / contract tests rely on.
   *
   * The split keeps the user-facing inbox view (web panel / REST)
   * decoupled from the offset-advancing ingestion path: the daemon
   * polls, the read API serves the cache.
   */
  async fetchInbound(options?: InboundFetchOptions): Promise<readonly InboundMessage[]> {
    if (this.inboxFile) {
      const limit = clampInboundLimit(options?.limit);
      return readInbox(this.inboxFile, limit);
    }
    return this.pollUpdates(options);
  }

  /**
   * Hit Bot API `getUpdates` directly. When the constructor was
   * given an `offsetFile`, the call passes `?offset=<stored>` and
   * persists `max(update_id) + 1` back on success — so a polling
   * daemon can advance through the queue rather than reprocessing.
   * Without `offsetFile`, behaviour is snapshot-style: every call
   * returns the most recent `limit` updates currently visible.
   *
   * Telegram caps `getUpdates` at 100 results per call regardless of
   * `limit`; we surface that ceiling rather than silently truncate.
   */
  async pollUpdates(options?: InboundFetchOptions): Promise<readonly InboundMessage[]> {
    const limit = clampInboundLimit(options?.limit);
    const offsetParam = this.offsetFile ? await readTelegramOffset(this.offsetFile) : undefined;
    // `timeout=0` keeps the call short — the long-poll modes are for
    // the daemon, not this snapshot fetch.
    const url = `${this.baseUrl}/bot${this.token}/getUpdates?limit=${limit.toString()}&timeout=0`
      + (offsetParam !== undefined ? `&offset=${offsetParam.toString()}` : "");
    const response = await fetchReadWithRetry(this.fetchImpl, url, { method: "GET" }, { timeoutMs: this.timeoutMs });
    const text = await response.text();
    const parsed = tryParseJson<TelegramGetUpdatesResponse>(text);
    if (!response.ok || !parsed?.ok) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Telegram getUpdates failed: ${parsed?.description ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status
      );
    }
    const updates = parsed.result ?? [];
    // Advance offset BEFORE filtering. Updates without a `.message`
    // (e.g. callback_query) still need acknowledgement or Telegram
    // will redeliver them on every poll until they expire.
    if (this.offsetFile && updates.length > 0) {
      const maxId = updates.reduce((acc, u) => (u.update_id > acc ? u.update_id : acc), updates[0]!.update_id);
      await writeTelegramOffset(this.offsetFile, maxId + 1);
    }
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
    // Clamp the SOURCE so the ESCAPED text Telegram receives stays
    // within its 4096 limit — escaping (MarkdownV2 \-escapes / HTML
    // entities) expands the body, so a plain clamp-then-escape could
    // still overflow and get the whole message rejected (400).
    const outboundText = clampForTelegram(message.text, this.parseMode);
    validateOutboundMessage({ ...message, text: outboundText });
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/bot${this.token}/sendMessage`, {
      body: JSON.stringify({
        chat_id: message.destination,
        text: escapeForTelegramParseMode(outboundText, this.parseMode),
        ...(this.parseMode ? { parse_mode: this.parseMode } : {})
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }, this.timeoutMs);
    const text = await response.text();
    const parsed = tryParseJson<TelegramSendResponse>(text);
    if (!response.ok || !parsed?.ok) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Telegram sendMessage failed: ${parsed?.description ?? (truncateErrorBody(text) || response.statusText)}`,
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

/**
 * Escape outbound text for the active Telegram `parse_mode`.
 * Without this, any reserved char (a `.` / `-` / `(` is in nearly
 * every message) makes Telegram reject `sendMessage` with 400
 * "can't parse entities", silently dropping the notice. Applied
 * AFTER clamp+validate; Telegram's 4096 limit counts the parsed
 * (un-escaped) length, so the backslashes don't push it over.
 */
export function escapeForTelegramParseMode(
  text: string,
  mode: "MarkdownV2" | "HTML" | undefined
): string {
  if (mode === "MarkdownV2") {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/gu, "\\$&");
  }
  if (mode === "HTML") {
    return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  }
  return text;
}

const TELEGRAM_MAX_TEXT = 4096;

/**
 * Clamp the SOURCE text so the escaped form Telegram receives never
 * exceeds its 4096-char limit. Plain text → the limit applies
 * directly. With a parse_mode, escaping expands the body (MarkdownV2
 * `\`-escapes a special char → 2x; HTML `&`→`&amp;` → up to 5x), so a
 * body that fits unescaped can still 400 once escaped. When the full
 * escaped form already fits we send it whole; otherwise we truncate
 * the source by the worst-case expansion factor so the escaped result
 * — truncation marker and all — stays within the limit. Truncating the
 * UNescaped source (then escaping) keeps the marker valid and can't
 * leave a dangling half-escape, since the cut lands on a real char
 * boundary before any `\`/entity is added.
 */
export function clampForTelegram(text: string, mode: "MarkdownV2" | "HTML" | undefined): string {
  if (!mode) {
    return clampOutboundText(text, TELEGRAM_MAX_TEXT);
  }
  if (escapeForTelegramParseMode(text, mode).length <= TELEGRAM_MAX_TEXT) {
    return text;
  }
  const worstCaseFactor = mode === "HTML" ? 5 : 2;
  return clampOutboundText(text, Math.floor(TELEGRAM_MAX_TEXT / worstCaseFactor));
}

// Re-export so callers don't have to depend on the validate module.
export { MessagingValidationError };
