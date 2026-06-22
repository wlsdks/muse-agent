import { describe, expect, it } from "vitest";

import { type ActionVeto, serializeVeto } from "../src/personal-veto-store.js";

const base: ActionVeto = {
  id: "v1",
  objectiveId: "obj-1",
  scope: "send-email",
  userId: "u1",
  vetoedAt: "2026-01-01T00:00:00Z",
};

describe("serializeVeto", () => {
  it("emits the required veto fields", () => {
    expect(serializeVeto(base)).toEqual({
      id: "v1",
      objectiveId: "obj-1",
      scope: "send-email",
      userId: "u1",
      vetoedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("includes the reason when present", () => {
    expect(serializeVeto({ ...base, reason: "too noisy" })).toMatchObject({ reason: "too noisy" });
  });

  it("omits the reason when absent or empty", () => {
    expect(serializeVeto({ ...base, reason: "" })).not.toHaveProperty("reason");
    expect(serializeVeto(base)).not.toHaveProperty("reason");
  });
});
