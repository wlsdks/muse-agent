import { describe, expect, it } from "vitest";

import { buildUserModelSlot, slugifySlotId } from "./commands-user.js";

const NOW = new Date("2026-05-01T00:00:00Z");

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
