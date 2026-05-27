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
});
