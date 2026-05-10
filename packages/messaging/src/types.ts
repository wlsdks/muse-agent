/**
 * Provider-neutral messaging contract — Phase 1 (outbound only).
 *
 * Each platform adapter (Telegram / Discord / Slack / LINE) implements
 * `MessagingProvider`. The `MessagingProviderRegistry` fans out
 * `describe()` for the provider list and routes `send()` to the
 * provider id requested by the caller.
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

export interface MessagingProvider {
  readonly id: MessagingProviderId;
  describe(): MessagingProviderInfo;
  send(message: OutboundMessage): Promise<OutboundReceipt>;
}
