/**
 * Provider-neutral messaging contract.
 *
 * Each platform adapter (Telegram / Discord / Slack / LINE) implements
 * `MessagingProvider`. The `MessagingProviderRegistry` fans out
 * `describe()` for the provider list and routes `send()` to the
 * provider id requested by the caller.
 *
 * Phase 1 surface is outbound-only (`send`). Phase 2 adds inbound:
 *   - `fetchInbound` (this iter) — one-shot read of the recent
 *     inbox, no offset state, no daemon. Telegram-only at landing.
 *   - polling / Socket Mode / webhook (later iters) — long-running
 *     daemon for push-style delivery.
 */

export type MessagingProviderId = "telegram" | "discord" | "slack" | "line" | string;

export interface MessagingProviderInfo {
  readonly id: MessagingProviderId;
  readonly displayName: string;
  /**
   * Free-form description rendered in `muse messaging providers`.
   * Should mention "send only" when receive support hasn't shipped yet.
   */
  readonly description: string;
  readonly local?: boolean;
}

export interface OutboundMessage {
  /**
   * Platform-native chat / channel / user id.
   *  - Telegram: chat_id (e.g. "123456789" or "@channelname")
   *  - Discord: channel id
   *  - Slack: channel id (Cxxx) or user id (Uxxx)
   *  - LINE: userId / groupId / roomId
   */
  readonly destination: string;
  readonly text: string;
}

export interface OutboundReceipt {
  readonly providerId: MessagingProviderId;
  readonly destination: string;
  /**
   * Platform-native message id when available. LINE's push API
   * doesn't return one — we synthesise `line:{ts}` so the receipt
   * is always populated.
   */
  readonly messageId: string;
  /**
   * Free-form provider payload for debugging. Routes that surface
   * this to the user should consider it advisory, not a contract.
   */
  readonly raw?: unknown;
}

export interface InboundFetchOptions {
  /** Cap on returned messages (provider may further restrict). */
  readonly limit?: number;
  /**
   * Platform-native source id to read from. Required by providers
   * that don't have a global "what came in?" endpoint:
   *   - Discord: channel id (REST `/channels/:id/messages` is per-channel)
   *   - Slack: channel id (`conversations.history` is per-channel)
   * Telegram ignores this — `getUpdates` is global to the bot.
   * LINE inbound is webhook-only and won't accept on-demand pulls.
   */
  readonly source?: string;
}

export interface InboundMessage {
  readonly providerId: MessagingProviderId;
  /** Platform-native message id (Telegram message_id, etc.). */
  readonly messageId: string;
  /** Where the message lives — chat / channel / user id. Mirrors `OutboundMessage.destination`. */
  readonly source: string;
  /** Sender display label when the platform exposes one (Telegram username, etc.). */
  readonly sender?: string;
  /** ISO-8601 timestamp; provider-supplied when available, otherwise synthesised. */
  readonly receivedAtIso: string;
  /** Plain-text body. Rich payloads (entities, media) are reserved for a future iter. */
  readonly text: string;
  /**
   * Conversation-scope hint the provider stamped when the payload made it
   * determinable ("direct" = 1:1 DM, "shared" = group/channel with other
   * humans present). Absent when the provider's fetch shape can't tell
   * (e.g. Discord's REST channel-messages endpoint). Consumers MUST run
   * this through `effectiveScope` (conversation-scope.ts) rather than
   * branch on the raw string — only the exact literal "direct" is 1:1;
   * everything else, including absent, is the safer "shared" default.
   */
  readonly scope?: "direct" | "shared";
  /** Raw provider payload for debugging. Advisory — not part of the contract. */
  readonly raw?: unknown;
}

export interface MessagingProvider {
  readonly id: MessagingProviderId;
  describe(): MessagingProviderInfo;
  send(message: OutboundMessage): Promise<OutboundReceipt>;
  /**
   * One-shot fetch of recent inbound messages. Optional — providers
   * that haven't shipped inbound yet omit this method, and the
   * registry/CLI surface a clean "not supported yet" error rather
   * than crashing.
   */
  fetchInbound?(options?: InboundFetchOptions): Promise<readonly InboundMessage[]>;
  /**
   * Optional "is typing…" presence signal shown while the agent
   * composes a reply. Cosmetic — callers must treat a failure as
   * ignorable, never as a reason to drop the reply itself.
   */
  sendTyping?(destination: string): Promise<void>;
}
