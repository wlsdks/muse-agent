import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProvider } from "@muse/model";

import { FileBeliefProvenanceStore } from "../src/belief-provenance-store.js";
import { createUserMemoryAutoExtractHook } from "../src/memory-auto-extract.js";
import { InMemoryUserMemoryStore } from "../src/memory-user-store.js";

function extractorStub(output: string): ModelProvider {
  return {
    id: "stub",
    listModels: async () => [],
    generate: async () => ({ id: "r", model: "stub", output }),
    stream: async function* () { /* unused */ }
  };
}

const PAYLOAD = JSON.stringify({ facts: { "home city": "Seoul" }, preferences: { tone: "concise" }, vetoes: [], goals: [] });

function context(userId: string, userMessage: string, sessionId?: string) {
  return {
    input: {
      runId: "run-1",
      metadata: { userId, ...(sessionId ? { sessionId } : {}) },
      messages: [{ role: "user" as const, content: userMessage }]
    }
  };
}

describe("auto-extract belief provenance", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-ae-prov-"));
    file = join(dir, "belief-provenance.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("records provenance for each extracted fact/preference when a store is wired", async () => {
    const store = new InMemoryUserMemoryStore();
    const provenanceStore = new FileBeliefProvenanceStore(file);
    const hook = createUserMemoryAutoExtractHook({
      model: "stub",
      modelProvider: extractorStub(PAYLOAD),
      store,
      provenanceStore
    });
    await hook.afterComplete!(context("u1", "I just moved to Seoul, keep replies concise", "sess-9"), {
      id: "r", model: "stub", output: "Noted."
    });

    const fact = await provenanceStore.query("u1", "home_city");
    expect(fact[0]?.kind).toBe("fact");
    expect(fact[0]?.value).toBe("Seoul");
    expect(fact[0]?.sessionId).toBe("sess-9");
    expect(fact[0]?.evidenceExcerpt).toContain("Seoul");

    const pref = await provenanceStore.query("u1", "tone");
    expect(pref[0]?.kind).toBe("preference");
    expect(pref[0]?.value).toBe("concise");

    // The memory write still happened.
    const mem = await store.findByUserId("u1");
    expect(mem?.facts.home_city).toBe("Seoul");
  });

  it("is a no-op for provenance (but still writes memory) when no store is wired", async () => {
    const store = new InMemoryUserMemoryStore();
    const provenanceStore = new FileBeliefProvenanceStore(file);
    const hook = createUserMemoryAutoExtractHook({ model: "stub", modelProvider: extractorStub(PAYLOAD), store });
    await hook.afterComplete!(context("u1", "I live in Seoul"), { id: "r", model: "stub", output: "ok" });

    expect(await provenanceStore.query("u1")).toEqual([]);
    expect((await store.findByUserId("u1"))?.facts.home_city).toBe("Seoul");
  });
});
