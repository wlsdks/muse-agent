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

  /** Remove a provider so sends to it fail closed (PROVIDER_NOT_FOUND). */
  unregister(providerId: string): boolean {
    return this.providers.delete(providerId);
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
        `Messaging provider not registered: ${providerId}${registeredHint([...this.providers.keys()])}`
      );
    }
    return provider;
  }

  async send(providerId: string, message: OutboundMessage): Promise<OutboundReceipt> {
    // Credential scrub at the single dispatch chokepoint so every
    // outbound surface inherits it (most callers hit the registry
    // directly, not via the proactive loop's earlier scrub).
    // redactSecretsInText is idempotent, so double-scrub is safe.
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

function registeredHint(ids: readonly string[]): string {
  return ids.length > 0 ? ` (registered: ${ids.join(", ")})` : " (none registered)";
}
