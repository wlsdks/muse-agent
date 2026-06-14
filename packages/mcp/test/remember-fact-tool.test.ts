import { describe, expect, it } from "vitest";

import { createRememberFactTool } from "../src/index.js";

function fakeStore() {
  const facts: Array<[string, string, string]> = [];
  const prefs: Array<[string, string, string]> = [];
  return {
    facts,
    prefs,
    store: {
      upsertFact: (u: string, k: string, v: string) => { facts.push([u, k, v]); },
      upsertPreference: (u: string, k: string, v: string) => { prefs.push([u, k, v]); }
    }
  };
}

describe("createRememberFactTool", () => {
  it("writes a fact under the run's userId, slugifying the key", async () => {
    const { store, facts, prefs } = fakeStore();
    const tool = createRememberFactTool({ store });
    const out = await tool.execute({ key: "Home City", value: "Seoul" }, { runId: "r", userId: "stark" });
    expect(facts).toEqual([["stark", "home_city", "Seoul"]]);
    expect(prefs).toEqual([]);
    expect(out).toEqual({ kind: "fact", remembered: { home_city: "Seoul" } });
  });

  it("preserves a Korean key (the KO-default model emits 취미, not an ASCII slug)", async () => {
    const { store, facts } = fakeStore();
    const tool = createRememberFactTool({ store });
    const out = await tool.execute({ key: "취미", value: "등산" }, { runId: "r", userId: "jinan" });
    expect(facts).toEqual([["jinan", "취미", "등산"]]);
    expect(out).toEqual({ kind: "fact", remembered: { ["취미"]: "등산" } });
  });

  it("normalizes a multi-word Korean key to a snake_case slug", async () => {
    const { store, facts } = fakeStore();
    await createRememberFactTool({ store }).execute({ key: "내 취미", value: "등산" }, { runId: "r", userId: "jinan" });
    expect(facts).toEqual([["jinan", "내_취미", "등산"]]);
  });

  it("kind:'preference' routes to upsertPreference", async () => {
    const { store, prefs } = fakeStore();
    await createRememberFactTool({ store }).execute(
      { key: "reply_style", value: "concise", kind: "preference" },
      { runId: "r", userId: "stark" }
    );
    expect(prefs).toEqual([["stark", "reply_style", "concise"]]);
  });

  it("falls back to a default userId when the context has none", async () => {
    const { store, facts } = fakeStore();
    await createRememberFactTool({ store }).execute({ key: "x", value: "y" }, { runId: "r" });
    expect(facts[0]?.[0]).toBe(process.env.MUSE_USER_ID?.trim() || "default");
  });

  it("errors (no write) on missing key/value or a key with no usable chars", async () => {
    const { store, facts, prefs } = fakeStore();
    const tool = createRememberFactTool({ store });
    expect(await tool.execute({ key: "x" }, { runId: "r" })).toHaveProperty("error");
    expect(await tool.execute({ key: "!!!", value: "v" }, { runId: "r" })).toHaveProperty("error");
    expect(facts).toEqual([]);
    expect(prefs).toEqual([]);
  });

  it("the definition is a single-purpose write tool named remember_fact", () => {
    const def = createRememberFactTool({ store: fakeStore().store }).definition;
    expect(def.name).toBe("remember_fact");
    expect(def.risk).toBe("write");
    expect(def.inputSchema.required).toEqual(["key", "value"]);
  });
});
