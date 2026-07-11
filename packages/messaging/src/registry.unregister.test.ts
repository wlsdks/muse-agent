import { describe, expect, it } from "vitest";

import { MessagingProviderRegistry } from "./registry.js";

import type { MessagingProvider, OutboundReceipt } from "./types.js";

function stubProvider(id: string): MessagingProvider {
  return {
    describe: () => ({ description: "stub", displayName: id, id }),
    id,
    send: async () => ({ destination: "d", messageId: "m", providerId: id }) satisfies OutboundReceipt
  };
}

describe("MessagingProviderRegistry.unregister", () => {
  it("removes the provider so has() is false and send routes fail closed", () => {
    const registry = new MessagingProviderRegistry([stubProvider("telegram")]);
    expect(registry.has("telegram")).toBe(true);
    expect(registry.unregister("telegram")).toBe(true);
    expect(registry.has("telegram")).toBe(false);
  });

  it("returns false for a provider that was never registered", () => {
    const registry = new MessagingProviderRegistry();
    expect(registry.unregister("ghost")).toBe(false);
  });
});
