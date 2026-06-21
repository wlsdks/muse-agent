import { InMemoryUserMemoryStore } from "@muse/memory";
import { describe, expect, it } from "vitest";

import { applyTurnLearnings, extractMemoryFromTurn, formatLearnedSummary, shouldAutoExtract, type AutoMemoryProvider } from "./chat-auto-memory.js";

describe("applyTurnLearnings", () => {
  it("cites the prior value when a fact CHANGES (correction), not double-listing it in the summary", async () => {
    const store = new InMemoryUserMemoryStore();
    store.upsertFact("u", "home_city", "Seoul");
    const { confirmation, summary } = await applyTurnLearnings(store, "u", { home_city: "Busan" }, {});
    expect(confirmation).toBe('📝 Got it — home city is now "Busan" (changed from "Seoul").');
    expect(summary).toBeUndefined();
  });

  it("summarizes a first-time fact with NO confirmation (no prior value to cite)", async () => {
    const store = new InMemoryUserMemoryStore();
    const { confirmation, summary } = await applyTurnLearnings(store, "u", { pet: "dog" }, {});
    expect(confirmation).toBeUndefined();
    expect(summary).toBe("📝 remembered: pet = dog (/forget <key> to undo)");
  });

  it("confirms a changed key AND summarizes a separate new key in the same turn", async () => {
    const store = new InMemoryUserMemoryStore();
    store.upsertFact("u", "home_city", "Seoul");
    const { confirmation, summary } = await applyTurnLearnings(store, "u", { home_city: "Busan", pet: "dog" }, {});
    expect(confirmation).toBe('📝 Got it — home city is now "Busan" (changed from "Seoul").');
    expect(summary).toBe("📝 remembered: pet = dog (/forget <key> to undo)");
  });
});

describe("shouldAutoExtract (cooldown)", () => {
  it("fires when never run, holds within the gap, fires again after it", () => {
    expect(shouldAutoExtract(undefined, 1_000)).toBe(true);
    expect(shouldAutoExtract(1_000, 1_000 + 10_000, 45_000)).toBe(false);
    expect(shouldAutoExtract(1_000, 1_000 + 45_000, 45_000)).toBe(true);
  });
});

function provider(output: string | undefined): AutoMemoryProvider {
  return { generate: async () => ({ output }) };
}

describe("extractMemoryFromTurn", () => {
  it("returns the facts/preferences the model emitted as JSON", async () => {
    const out = await extractMemoryFromTurn({
      provider: provider('{"facts":{"residence":"Busan"},"preferences":{"answer_length":"short"}}'),
      model: "m", user: "I live in Busan and prefer short answers", assistant: "Got it."
    });
    expect(out).toEqual({ facts: { residence: "Busan" }, preferences: { answer_length: "short" } });
  });
  it("empty when nothing extractable, model returns no output, or it throws", async () => {
    expect(await extractMemoryFromTurn({ provider: provider("not json"), model: "m", user: "hi", assistant: "hello" })).toEqual({ facts: {}, preferences: {} });
    expect(await extractMemoryFromTurn({ provider: provider(undefined), model: "m", user: "hi", assistant: "hello" })).toEqual({ facts: {}, preferences: {} });
    const throwing: AutoMemoryProvider = { generate: async () => { throw new Error("model down"); } };
    expect(await extractMemoryFromTurn({ provider: throwing, model: "m", user: "hi", assistant: "hello" })).toEqual({ facts: {}, preferences: {} });
  });
  it("drops non-string values", async () => {
    const out = await extractMemoryFromTurn({
      provider: provider('{"facts":{"name":"Jinan","age":33}}'),
      model: "m", user: "I'm Jinan", assistant: "ok"
    });
    expect(out.facts).toEqual({ name: "Jinan" });
  });
});

describe("formatLearnedSummary", () => {
  it("renders a one-line notice with facts + prefs, undefined when empty", () => {
    expect(formatLearnedSummary({ home_city: "Busan" }, { reply_length: "short" }))
      .toBe("📝 remembered: home_city = Busan · reply_length = short (/forget <key> to undo)");
    expect(formatLearnedSummary({}, {})).toBeUndefined();
  });
});
