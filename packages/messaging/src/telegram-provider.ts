import { errorMessage, isRecord, truncateErrorBody } from "@muse/shared";

import { MessagingProviderError } from "./errors.js";
import { readInbox } from "./inbox-store.js";
import { clampInboundLimit, clampLongPollSeconds, clampOutboundText, fetchReadWithRetry, fetchWithTimeout, retryAfterMsFromResponse, tryParseJson } from "./provider-helpers.js";
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

/**
 * The autocomplete list registered via `setMyCommands`. Kept in lock-step
 * with `handleInboundSlashCommand` (apps/api/src/inbound-slash-commands.ts)
 * — that is the single source of truth for what each command DOES; this
 * is only what Telegram's client shows before the user sends anything.
 * Telegram descriptions are single-language (1-256 chars); the bilingual
 * detail lives in `/help`'s reply once the command actually runs.
 */
export const TELEGRAM_BOT_COMMANDS: readonly { readonly command: string; readonly description: string }[] = [
  { command: "new", description: "Start a fresh conversation, clearing this chat's history" },
  { command: "status", description: "Show the current model, pending approvals, and turn count" },
  { command: "model", description: "Show the current default model" },
  { command: "help", description: "List available commands" }
];

interface TelegramSendResponse {
  readonly ok: boolean;
  readonly description?: string;
  readonly result?: { readonly message_id: number };
  /** On a 429, Telegram returns the wait (seconds) in the body, not a header. */
  readonly parameters?: { readonly retry_after?: number };
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessageObject;
  readonly edited_message?: TelegramMessageObject;
  readonly channel_post?: TelegramMessageObject;
}

interface TelegramMessageObject {
  readonly message_id?: number;
  readonly date: number;
  readonly text?: string;
  readonly chat: { readonly id: number; readonly username?: string; readonly title?: string; readonly type?: string };
  readonly from?: { readonly username?: string; readonly first_name?: string };
}

/**
 * Telegram's `chat.type` is the authoritative DM/group signal when
 * present ("private" = 1:1). Falling back to the id sign covers older
 * payload shapes that omit `type`: a positive chat id is always a
 * private 1:1 chat, negative is group/supergroup, per the Bot API.
 */
function telegramChatScope(chat: { readonly id: number; readonly type?: string }): "direct" | "shared" {
  if (chat.type) {
    return chat.type === "private" ? "direct" : "shared";
  }
  return chat.id > 0 ? "direct" : "shared";
}

interface TelegramGetUpdatesResponse {
  readonly ok: boolean;
  readonly description?: string;
  readonly result?: readonly TelegramUpdate[];
  readonly parameters?: { readonly retry_after?: number };
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
  async pollUpdates(options?: InboundFetchOptions & { readonly longPollSeconds?: number }): Promise<readonly InboundMessage[]> {
    const limit = clampInboundLimit(options?.limit);
    const offsetParam = this.offsetFile ? await readTelegramOffset(this.offsetFile) : undefined;
    // `timeout=0` is the short snapshot; a daemon passes
    // `longPollSeconds` so Telegram HOLDS the request and returns the
    // instant a message arrives — the Bot API's real-time mechanism
    // (no websocket exists; webhook needs a public HTTPS endpoint).
    const longPoll = clampLongPollSeconds(options?.longPollSeconds, 50);
    const url = `${this.baseUrl}/bot${this.token}/getUpdates?limit=${limit.toString()}&timeout=${longPoll.toString()}`
      + (offsetParam !== undefined ? `&offset=${offsetParam.toString()}` : "");
    // The HTTP timeout must outlive the held long poll or every idle
    // poll aborts as a spurious network error.
    const readTimeoutMs = longPoll > 0
      ? Math.max(this.timeoutMs ?? 30_000, (longPoll + 15) * 1000)
      : this.timeoutMs;
    const response = await this.request("Telegram getUpdates request", () =>
      fetchReadWithRetry(this.fetchImpl, url, { method: "GET" }, { timeoutMs: readTimeoutMs })
    );
    const text = await this.readResponseText(response, "Telegram getUpdates");
    const parsed = tryParseJson<TelegramGetUpdatesResponse>(text);
    if (!response.ok || !parsed?.ok) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Telegram getUpdates failed: ${parsed?.description ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status,
        retryAfterMsFromResponse(response, parsed?.parameters?.retry_after)
      );
    }
    const updates: readonly unknown[] = Array.isArray(parsed.result) ? parsed.result : [];
    // Advance offset BEFORE filtering. Updates without a `.message`
    // (e.g. callback_query) still need acknowledgement or Telegram
    // will redeliver them on every poll until they expire.
    const nextOffset = nextTelegramOffset(updates);
    if (this.offsetFile && nextOffset !== undefined) {
      await writeTelegramOffset(this.offsetFile, nextOffset);
    }
    return updates.flatMap((update): readonly InboundMessage[] => {
      const message = telegramMessageFromUpdate(update);
      if (!message || typeof message.text !== "string") {
        return [];
      }
      const directMessageId = message.message_id;
      const messageId = typeof directMessageId === "number" && Number.isSafeInteger(directMessageId) && directMessageId > 0
        ? directMessageId
        : telegramUpdateId(update);
      if (messageId === undefined) {
        return [];
      }
      const receivedAtIso = telegramEpochSecondsToIso(message.date);
      if (receivedAtIso === undefined) {
        return [];
      }
      const senderUsername = message.from?.username;
      const senderName = senderUsername ?? message.from?.first_name ?? message.chat.username;
      return [{
        messageId: String(messageId),
        providerId: this.id,
        raw: update,
        receivedAtIso,
        scope: telegramChatScope(message.chat),
        ...(senderName ? { sender: senderName } : {}),
        source: String(message.chat.id),
        text: message.text
      }];
    });
  }

  async sendTyping(destination: string): Promise<void> {
    const response = await this.request("Telegram sendChatAction request", () => fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/bot${this.token}/sendChatAction`, {
      body: JSON.stringify({ action: "typing", chat_id: destination }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }, this.timeoutMs));
    const text = await this.readResponseText(response, "Telegram sendChatAction");
    const parsed = tryParseJson<TelegramSendResponse>(text);
    if (!response.ok || !parsed?.ok) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Telegram sendChatAction failed: ${parsed?.description ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status,
        retryAfterMsFromResponse(response, parsed?.parameters?.retry_after)
      );
    }
  }

  /**
   * Emoji reaction on an inbound message — the closest the Bot API
   * offers to a read receipt (there is no mark-as-read for normal
   * bots). Telegram accepts only its fixed reaction-emoji set; an
   * out-of-set emoji fails upstream and the caller treats it as
   * cosmetic.
   */
  async reactToMessage(destination: string, messageId: string, emoji: string): Promise<void> {
    const response = await this.request("Telegram setMessageReaction request", () => fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/bot${this.token}/setMessageReaction`, {
      body: JSON.stringify({
        chat_id: destination,
        message_id: Number(messageId),
        reaction: [{ emoji, type: "emoji" }]
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }, this.timeoutMs));
    const text = await this.readResponseText(response, "Telegram setMessageReaction");
    const parsed = tryParseJson<TelegramSendResponse>(text);
    if (!response.ok || !parsed?.ok) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Telegram setMessageReaction failed: ${parsed?.description ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status,
        retryAfterMsFromResponse(response, parsed?.parameters?.retry_after)
      );
    }
  }

  /**
   * Registers the slash-command autocomplete list Telegram's client UI
   * shows when a user types "/" (Bot API `setMyCommands`). Mirrors the
   * commands `handleInboundSlashCommand`
   * (apps/api/src/inbound-slash-commands.ts) actually handles — update
   * both together. Overwrites the whole list each call, so it is safe
   * to invoke more than once (the caller still runs it at most once per
   * boot to avoid a needless network round-trip).
   */
  async registerCommands(): Promise<void> {
    const response = await this.request("Telegram setMyCommands request", () => fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/bot${this.token}/setMyCommands`, {
      body: JSON.stringify({ commands: TELEGRAM_BOT_COMMANDS }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }, this.timeoutMs));
    const text = await this.readResponseText(response, "Telegram setMyCommands");
    const parsed = tryParseJson<TelegramSendResponse>(text);
    if (!response.ok || !parsed?.ok) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Telegram setMyCommands failed: ${parsed?.description ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status,
        retryAfterMsFromResponse(response, parsed?.parameters?.retry_after)
      );
    }
  }

  async send(message: OutboundMessage): Promise<OutboundReceipt> {
    // Clamp the SOURCE so the ESCAPED text Telegram receives stays
    // within its 4096 limit — escaping (MarkdownV2 \-escapes / HTML
    // entities) expands the body, so a plain clamp-then-escape could
    // still overflow and get the whole message rejected (400).
    const outboundText = clampForTelegram(message.text, this.parseMode);
    validateOutboundMessage({ ...message, text: outboundText });
    const response = await this.request("Telegram sendMessage request", () => fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/bot${this.token}/sendMessage`, {
      body: JSON.stringify({
        chat_id: message.destination,
        // Without this, a URL in the reply (including one an indirect
        // prompt injection planted to exfiltrate a secret) makes
        // Telegram's own server-side crawler fetch it to build the
        // preview — no click, no approval (EchoLeak/CamoLeak class).
        link_preview_options: { is_disabled: true },
        text: escapeForTelegramParseMode(outboundText, this.parseMode),
        ...(this.parseMode ? { parse_mode: this.parseMode } : {})
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }, this.timeoutMs));
    const text = await this.readResponseText(response, "Telegram sendMessage");
    const parsed = tryParseJson<TelegramSendResponse>(text);
    if (!response.ok || !parsed?.ok) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `Telegram sendMessage failed: ${parsed?.description ?? (truncateErrorBody(text) || response.statusText)}`,
        response.status,
        retryAfterMsFromResponse(response, parsed?.parameters?.retry_after)
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

function nextTelegramOffset(updates: readonly unknown[]): number | undefined {
  let highest = -1;
  for (const update of updates) {
    const updateId = telegramUpdateId(update);
    if (updateId === undefined || updateId >= Number.MAX_SAFE_INTEGER) {
      continue;
    }
    highest = Math.max(highest, updateId);
  }
  return highest >= 0 ? highest + 1 : undefined;
}

function telegramUpdateId(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const updateId = value["update_id"];
  return typeof updateId === "number" && Number.isSafeInteger(updateId) && updateId >= 0
    ? updateId
    : undefined;
}

function telegramMessageFromUpdate(value: unknown): TelegramMessageObject | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value["message"] ?? value["edited_message"] ?? value["channel_post"];
  if (!isRecord(candidate) || !isRecord(candidate["chat"])) {
    return undefined;
  }
  const chat = candidate["chat"];
  const chatId = chat["id"];
  const date = candidate["date"];
  const text = candidate["text"];
  if (typeof text !== "string" || typeof date !== "number" || typeof chatId !== "number" || !Number.isSafeInteger(chatId)) {
    return undefined;
  }
  const from = isRecord(candidate["from"]) ? candidate["from"] : undefined;
  const rawMessageId = candidate["message_id"];
  return {
    ...(typeof rawMessageId === "number" ? { message_id: rawMessageId } : {}),
    chat: {
      id: chatId,
      ...(typeof chat["type"] === "string" ? { type: chat["type"] } : {}),
      ...(typeof chat["username"] === "string" ? { username: chat["username"] } : {})
    },
    date,
    ...(from && (typeof from["first_name"] === "string" || typeof from["username"] === "string") ? {
      from: {
        ...(typeof from["first_name"] === "string" ? { first_name: from["first_name"] } : {}),
        ...(typeof from["username"] === "string" ? { username: from["username"] } : {})
      }
    } : {}),
    text
  };
}

function telegramEpochSecondsToIso(seconds: number): string | undefined {
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    return undefined;
  }
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
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
