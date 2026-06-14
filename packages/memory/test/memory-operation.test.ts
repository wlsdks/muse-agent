import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProvider } from "@muse/model";

import { FileBeliefProvenanceStore } from "../src/belief-provenance-store.js";
import { classifyMemoryOperation } from "../src/memory-user-store.js";
import { createUserMemoryAutoExtractHook } from "../src/memory-auto-extract.js";
import { InMemoryUserMemoryStore } from "../src/memory-user-store.js";

describe("classifyMemoryOperation (Mem0 arXiv 2504.19413)", () => {
  it("ADD when the key is new", () => {
    expect(classifyMemoryOperation(undefined, "Seoul")).toBe("add");
  });
  it("NOOP when the value re-confirms (whitespace-insensitive)", () => {
    expect(classifyMemoryOperation("Seoul", "Seoul")).toBe("noop");
    expect(classifyMemoryOperation("Seoul", "  Seoul  ")).toBe("noop");
  });
  it("UPDATE when the value genuinely differs", () => {
    expect(classifyMemoryOperation("Busan", "Seoul")).toBe("update");
  });
  it("DELETE on a no-value/retraction token (EN + KO, case-insensitive)", () => {
    for (const t of ["none", "N/A", "unknown", "", "  ", "없음", "모름"]) {
      expect(classifyMemoryOperation("Seoul", t)).toBe("delete");
    }
  });
});

function extractorStub(output: string): ModelProvider {
  return {
    id: "stub",
    listModels: async () => [],
    generate: async () => ({ id: "r", model: "stub", output }),
    stream: async function* () { /* unused */ }
  };
}

function context(userId: string, userMessage: string) {
  return { input: { runId: "r1", metadata: { userId }, messages: [{ role: "user" as const, content: userMessage }] } };
}

describe("auto-extract applies Mem0 operations", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-memop-"));
    file = join(dir, "prov.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function run(store: InMemoryUserMemoryStore, payload: object): Promise<FileBeliefProvenanceStore> {
    const provenanceStore = new FileBeliefProvenanceStore(file);
    const hook = createUserMemoryAutoExtractHook({ model: "stub", modelProvider: extractorStub(JSON.stringify(payload)), store, provenanceStore });
    await hook.afterComplete!(context("u1", "msg"), { id: "r", model: "stub", output: "ok" });
    return provenanceStore;
  }

  it("NOOP: re-confirming an existing fact records NO new provenance", async () => {
    const store = new InMemoryUserMemoryStore();
    await store.upsertFact("u1", "home_city", "Seoul");
    const prov = await run(store, { facts: { home_city: "Seoul" }, preferences: {}, vetoes: [], goals: [] });
    expect(await prov.query("u1")).toEqual([]); // no re-learn event
    expect((await store.findByUserId("u1"))?.facts.home_city).toBe("Seoul");
  });

  it("UPDATE: a changed value upserts + records provenance", async () => {
    const store = new InMemoryUserMemoryStore();
    await store.upsertFact("u1", "home_city", "Busan");
    const prov = await run(store, { facts: { home_city: "Seoul" }, preferences: {}, vetoes: [], goals: [] });
    expect((await store.findByUserId("u1"))?.facts.home_city).toBe("Seoul");
    expect((await prov.query("u1", "home_city"))[0]?.value).toBe("Seoul");
  });

  it("DELETE: a retraction token forgets the key instead of storing junk", async () => {
    const store = new InMemoryUserMemoryStore();
    await store.upsertFact("u1", "home_city", "Seoul");
    await run(store, { facts: { home_city: "unknown" }, preferences: {}, vetoes: [], goals: [] });
    expect((await store.findByUserId("u1"))?.facts.home_city).toBeUndefined();
  });

  it("NOOP across key casings: re-confirming 'Home City' as 'home city' is a NOOP on InMemory (the lookup is normalized + the store now is too)", async () => {
    const store = new InMemoryUserMemoryStore();
    await store.upsertFact("u1", "Home City", "Seoul"); // a capitalized key from one path
    const prov = await run(store, { facts: { "home city": "Seoul" }, preferences: {}, vetoes: [], goals: [] });
    expect(await prov.query("u1")).toEqual([]); // re-confirmation → no new learn event (was a spurious ADD before the store normalized)
    expect(store.findByUserId("u1")?.facts.home_city).toBe("Seoul");
  });

  it("DELETE: a FACT retraction does NOT wipe a same-key PREFERENCE (namespace-scoped)", async () => {
    // facts + preferences routinely collapse to the same normalized key (pet,
    // city, name…). A "I don't have a pet" FACT retraction must not silently
    // erase the user's "I prefer dogs" PREFERENCE of the same key.
    const store = new InMemoryUserMemoryStore();
    await store.upsertFact("u1", "pet", "cat");
    await store.upsertPreference("u1", "pet", "dog");
    await run(store, { facts: { pet: "none" }, preferences: {}, vetoes: [], goals: [] });
    const mem = await store.findByUserId("u1");
    expect(mem?.facts.pet).toBeUndefined(); // the fact WAS retracted
    expect(mem?.preferences.pet).toBe("dog"); // the preference the user never retracted SURVIVES
  });
});

describe("InMemory store canonicalizes the key (parity with the File store)", () => {
  it("upsertFact stores under the NORMALIZED key so a fact doesn't fragment by store backend", () => {
    const store = new InMemoryUserMemoryStore();
    store.upsertFact("u1", "Home City", "Seoul");
    const mem = store.findByUserId("u1");
    expect(mem?.facts.home_city).toBe("Seoul"); // stored under the normalized key
    expect(mem?.facts["Home City"]).toBeUndefined(); // NOT the raw key
  });

  it("forget still finds the entry by a raw OR normalized key after normalization", () => {
    const store = new InMemoryUserMemoryStore();
    store.upsertFact("u1", "Home City", "Seoul");
    expect(store.forget("u1", "Home City")).toBe(true); // raw key resolves to the normalized entry
    expect(store.findByUserId("u1")?.facts.home_city).toBeUndefined();
  });
});

describe("forget — namespace-scoped delete (InMemory)", () => {
  it("forget(key, 'fact') deletes only the fact; forget(key, 'preference') only the preference; forget(key) both", () => {
    const seed = () => {
      const s = new InMemoryUserMemoryStore();
      s.upsertFact("u1", "pet", "cat");
      s.upsertPreference("u1", "pet", "dog");
      return s;
    };
    const factOnly = seed();
    factOnly.forget("u1", "pet", "fact");
    expect(factOnly.findByUserId("u1")?.facts.pet).toBeUndefined();
    expect(factOnly.findByUserId("u1")?.preferences.pet).toBe("dog");

    const prefOnly = seed();
    prefOnly.forget("u1", "pet", "preference");
    expect(prefOnly.findByUserId("u1")?.facts.pet).toBe("cat");
    expect(prefOnly.findByUserId("u1")?.preferences.pet).toBeUndefined();

    const both = seed();
    both.forget("u1", "pet"); // no kind → explicit /forget keeps the dual-delete
    expect(both.findByUserId("u1")?.facts.pet).toBeUndefined();
    expect(both.findByUserId("u1")?.preferences.pet).toBeUndefined();
  });
});
