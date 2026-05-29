import type { UserModelSlot } from "@muse/memory";
import type { ModelProvider } from "@muse/model";
import { describe, expect, it } from "vitest";

import { buildUserModelSlot, inferSessionPreferences, slugifySlotId } from "./commands-user.js";

const NOW = new Date("2026-05-01T00:00:00Z");

const CORRECTION_HISTORY = [
  { role: "user", content: "summarize the meeting" },
  { role: "assistant", content: "Here is a long prose summary..." },
  { role: "user", content: "no, that's not what I asked — use bullet points" }
] as const;

function fakeProvider(output: string): ModelProvider {
  return { generate: async () => ({ output }) } as unknown as ModelProvider;
}

describe("slugifySlotId", () => {
  it("slugs a value so re-adding the same value updates in place", () => {
    expect(slugifySlotId("Concise, no fluff!")).toBe("concise-no-fluff");
    expect(slugifySlotId("   ")).toBe("slot");
  });
});

describe("buildUserModelSlot", () => {
  it("builds a preference slot with category, defaulting the id from the value", () => {
    const slot = buildUserModelSlot("preference", "bullet points", { category: "style" }, NOW);
    expect(slot).toMatchObject({ kind: "preference", value: "bullet points", id: "bullet-points", category: "style" });
  });
  it("builds schedule/veto/goal with their decorators + honours --id", () => {
    expect(buildUserModelSlot("schedule", "journal", { id: "morning", recurrence: "daily 07:00" }, NOW)).toMatchObject({ kind: "schedule", id: "morning", recurrence: "daily 07:00" });
    expect(buildUserModelSlot("veto", "no eggs", { scope: "food" }, NOW)).toMatchObject({ kind: "veto", scope: "food" });
    expect(buildUserModelSlot("goal", "ship v1", {}, NOW)).toMatchObject({ kind: "goal", value: "ship v1" });
  });
  it("rejects an out-of-range confidence", () => {
    expect(() => buildUserModelSlot("preference", "x", { confidence: "1.5" }, NOW)).toThrow(/confidence/u);
    expect(buildUserModelSlot("preference", "x", { confidence: "0.8" }, NOW).confidence).toBe(0.8);
  });
});

describe("inferSessionPreferences — detect → infer → upsert (glue; model behavior live-tested separately)", () => {
  it("upserts a categorised preference for a correction, superseding by category id", async () => {
    const saved: UserModelSlot[] = [];
    const result = await inferSessionPreferences({
      readHistory: async () => CORRECTION_HISTORY,
      modelProvider: fakeProvider("preference: prefers bullet points\ncategory: style\nconfidence: 0.8"),
      model: "qwen3:8b",
      store: { upsertUserModelSlot: async (_userId, slot) => { saved.push(slot); } },
      userId: "stark",
      now: () => NOW
    });
    expect(result.status).toBe("ok");
    expect(result.added).toEqual(["prefers bullet points (style)"]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: "pref-style", kind: "preference", value: "prefers bullet points", category: "style", confidence: 0.8 });
  });

  it("never fabricates: a NONE verdict adds nothing", async () => {
    const saved: UserModelSlot[] = [];
    const result = await inferSessionPreferences({
      readHistory: async () => CORRECTION_HISTORY,
      modelProvider: fakeProvider("NONE"),
      model: "qwen3:8b",
      store: { upsertUserModelSlot: async (_userId, slot) => { saved.push(slot); } }
    });
    expect(result.status).toBe("ok");
    expect(result.added).toEqual([]);
    expect(saved).toHaveLength(0);
  });

  it("reports no-corrections without touching the model when the chat has none", async () => {
    let called = false;
    const result = await inferSessionPreferences({
      readHistory: async () => [{ role: "user", content: "thanks, that's perfect" }],
      modelProvider: fakeProvider("preference: x\ncategory: style\nconfidence: 0.9"),
      model: "qwen3:8b",
      store: { upsertUserModelSlot: async () => { called = true; } }
    });
    expect(result).toEqual({ added: [], status: "no-corrections" });
    expect(called).toBe(false);
  });
});
