import { ToolExecutor, ToolRegistry } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { createRememberFactTool, type RememberFactStore } from "../src/remember-fact-tool.js";

// τ-bench-style terminal-state eval (agent-eval gap B) on a REAL built-in tool:
// drive remember_fact through the REAL ToolExecutor over a contract-faithful
// store and assert the WORLD STATE (what the store received), not the path —
// plus the safety property that an invalid call mutates NOTHING.
function harness() {
  const facts: [string, string, string][] = [];
  const preferences: [string, string, string][] = [];
  const store: RememberFactStore = {
    upsertFact: (userId, key, value) => { facts.push([userId, key, value]); },
    upsertPreference: (userId, key, value) => { preferences.push([userId, key, value]); },
  };
  const executor = new ToolExecutor({ registry: new ToolRegistry([createRememberFactTool({ store })]) });
  const run = (args: Record<string, unknown>, userId = "jinan") =>
    executor.execute({ arguments: args, context: { runId: "r", userId }, id: "c", name: "remember_fact" });
  return { facts, preferences, run };
}

describe("remember_fact — terminal state through the real ToolExecutor", () => {
  it("persists a fact to the store with the resolved user id", async () => {
    const h = harness();
    const result = await h.run({ key: "dentist", value: "Dr. Kim" });
    expect(result.status).toBe("completed");
    expect(result.output).toContain("dentist");
    expect(result.output).toContain("Dr. Kim");
    expect(h.facts).toEqual([["jinan", "dentist", "Dr. Kim"]]);
    expect(h.preferences).toEqual([]);
  });

  it("routes a preference to upsertPreference, not upsertFact", async () => {
    const h = harness();
    await h.run({ key: "reply style", kind: "preference", value: "concise" });
    expect(h.preferences).toEqual([["jinan", "reply_style", "concise"]]);
    expect(h.facts).toEqual([]);
  });

  it("normalizes the key to a snake_case slug via the store's canonical normalizer", async () => {
    const h = harness();
    await h.run({ key: "home city", value: "Seoul" });
    await h.run({ key: "Favorite-Drink!", value: "tea" });
    expect(h.facts.map(([, k]) => k)).toEqual(["home_city", "favorite_drink"]);
  });

  it("preserves a Korean key end-to-end through the real ToolExecutor (KO-default model)", async () => {
    const h = harness();
    const result = await h.run({ key: "취미", value: "등산" });
    expect(result.status).toBe("completed");
    expect(h.facts).toEqual([["jinan", "취미", "등산"]]);
    expect(h.preferences).toEqual([]);
  });

  it("uses the context user id (isolating different users' stores)", async () => {
    const h = harness();
    await h.run({ key: "city", value: "Seoul" }, "user-a");
    await h.run({ key: "city", value: "Busan" }, "user-b");
    expect(h.facts).toEqual([["user-a", "city", "Seoul"], ["user-b", "city", "Busan"]]);
  });

  describe("invalid input mutates NOTHING (no partial side effect)", () => {
    it("writes nothing when value is missing", async () => {
      const h = harness();
      const result = await h.run({ key: "dentist" });
      expect(result.output).toContain("needs both");
      expect(h.facts).toEqual([]);
      expect(h.preferences).toEqual([]);
    });

    it("writes nothing when the key has no letters or digits", async () => {
      const h = harness();
      const result = await h.run({ key: "!!!", value: "x" });
      expect(result.output).toContain("must contain");
      expect(h.facts).toEqual([]);
      expect(h.preferences).toEqual([]);
    });
  });
});
