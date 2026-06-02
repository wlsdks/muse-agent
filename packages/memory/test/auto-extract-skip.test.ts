import { describe, expect, it } from "vitest";
import type { ModelProvider } from "@muse/model";

import { createUserMemoryAutoExtractHook, readSkipAutoExtract } from "../src/memory-auto-extract.js";
import { InMemoryUserMemoryStore } from "../src/memory-user-store.js";

function extractorStub(output: string): ModelProvider {
  return {
    id: "stub",
    listModels: async () => [],
    generate: async () => ({ id: "r", model: "stub", output }),
    stream: async function* () { /* unused */ }
  };
}

const PAYLOAD = JSON.stringify({ facts: { wireguard_default_mtu: "1420" }, preferences: {}, vetoes: [], goals: [] });

function context(metadata: Record<string, unknown>, userMessage: string) {
  return {
    input: {
      runId: "run-1",
      metadata,
      messages: [{ content: userMessage, role: "user" as const }]
    }
  };
}

describe("user-memory auto-extract — skip flag for read/recall surfaces (no provenance fabrication)", () => {
  it("readSkipAutoExtract is true ONLY when the metadata flag is explicitly set", () => {
    expect(readSkipAutoExtract(context({ skipUserMemoryAutoExtract: true, userId: "u1" }, "q"))).toBe(true);
    expect(readSkipAutoExtract(context({ userId: "u1" }, "q"))).toBe(false);
    expect(readSkipAutoExtract(context({ skipUserMemoryAutoExtract: false, userId: "u1" }, "q"))).toBe(false);
  });

  it("does NOT author memory when the run opted out (a `muse ask` recall turn)", async () => {
    const store = new InMemoryUserMemoryStore();
    const hook = createUserMemoryAutoExtractHook({ model: "stub", modelProvider: extractorStub(PAYLOAD), store, extractionCooldownMs: 0 });
    await hook.afterComplete!(
      context({ skipUserMemoryAutoExtract: true, userId: "u1" }, "what is the standard MTU for WireGuard?"),
      { id: "r", model: "stub", output: "The standard default MTU for WireGuard is 1420 bytes." }
    );
    const mem = await store.findByUserId("u1");
    expect(mem).toBeUndefined();
  });

  it("STILL authors memory on a normal (chat) turn — the skip is the only behavior change", async () => {
    const store = new InMemoryUserMemoryStore();
    const hook = createUserMemoryAutoExtractHook({ model: "stub", modelProvider: extractorStub(PAYLOAD), store, extractionCooldownMs: 0 });
    await hook.afterComplete!(
      context({ userId: "u1" }, "remember the wireguard default mtu is 1420"),
      { id: "r", model: "stub", output: "Noted." }
    );
    const mem = await store.findByUserId("u1");
    expect(mem?.facts.wireguard_default_mtu).toBe("1420");
  });
});
