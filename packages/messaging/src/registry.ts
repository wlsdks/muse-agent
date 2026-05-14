import { redactSecretsInText } from "@muse/shared";

import { MessagingProviderError } from "./errors.js";
import type {
  InboundFetchOptions,
  InboundMessage,
  MessagingProvider,
  MessagingProviderInfo,
  OutboundMessage,
  OutboundReceipt
} from "./types.js";

/**
 * In-memory registry of configured messaging providers. Mirrors the
 * `CalendarProviderRegistry` shape from `packages/calendar` so the
 * REST routes / CLI / future MCP tool can iterate over a uniform
 * surface regardless of which platforms the user has wired up.
 */
export class MessagingProviderRegistry {
  private readonly providers = new Map<string, MessagingProvider>();

  constructor(providers: Iterable<MessagingProvider> = []) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider: MessagingProvider): void {
    this.providers.set(provider.id, provider);
  }

  list(): readonly MessagingProvider[] {
    return [...this.providers.values()];
  }

  describe(): readonly MessagingProviderInfo[] {
    return this.list().map((provider) => provider.describe());
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  require(providerId: string): MessagingProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new MessagingProviderError(
        providerId,
        "PROVIDER_NOT_FOUND",
        `Messaging provider not registered: ${providerId}`
      );
    }
    return provider;
  }

  async send(providerId: string, message: OutboundMessage): Promise<OutboundReceipt> {
    // Goal 111 — credential hygiene at the dispatch chokepoint.
    // The proactive-notice loop already scrubs before calling .send(),
    // but every OTHER send caller (pattern/followup firing loops, the
    // muse.messaging.send MCP tool, `muse messaging send` CLI, the
    // watch-folder + webhook bridges, `/api/messaging/send`) hit the
    // registry directly. Centralising the scrub here means every
    // outbound surface — Telegram / Discord / Slack / LINE /
    // macOS Notification / log / libnotify — inherits the same
    // safety net. `redactSecretsInText` is a pure identity on
    // text without matches, so the proactive path's earlier scrub
    // doesn't double-flag anything.
    const scrubbed: OutboundMessage = {
      ...message,
      text: redactSecretsInText(message.text)
    };
    return this.require(providerId).send(scrubbed);
  }

  async fetchInbound(providerId: string, options?: InboundFetchOptions): Promise<readonly InboundMessage[]> {
    const provider = this.require(providerId);
    if (!provider.fetchInbound) {
      throw new MessagingProviderError(
        providerId,
        "UPSTREAM_FAILED",
        `${providerId} does not support inbound fetch yet (Phase 2 is rolling out per-provider; Telegram first)`
      );
    }
    return provider.fetchInbound(options);
  }
}
