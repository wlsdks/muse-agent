import { describe, expect, it } from "vitest";

import { type ScopedConsent, serializeConsent } from "../src/personal-consent-store.js";

const base: ScopedConsent = {
  id: "c1",
  objectiveId: "obj-1",
  scope: "send-email",
  userId: "u1",
  grantedAt: "2026-01-01T00:00:00Z",
};

describe("serializeConsent", () => {
  it("emits the required scoped-consent fields", () => {
    expect(serializeConsent(base)).toEqual({
      grantedAt: "2026-01-01T00:00:00Z",
      id: "c1",
      objectiveId: "obj-1",
      scope: "send-email",
      userId: "u1",
    });
  });

  it("includes the note when present", () => {
    expect(serializeConsent({ ...base, note: "approved for newsletters" })).toMatchObject({
      note: "approved for newsletters",
    });
  });

  it("omits the note when absent or empty", () => {
    expect(serializeConsent({ ...base, note: "" })).not.toHaveProperty("note");
    expect(serializeConsent(base)).not.toHaveProperty("note");
  });
});
