import { describe, expect, it } from "vitest";

import { type ActionLogEntry, serializeActionLogEntry } from "../src/personal-action-log-store.js";

const base: ActionLogEntry = {
  id: "a1",
  userId: "u1",
  when: "2026-01-01T00:00:00Z",
  what: "sent objective-met notice",
  why: "standing objective met",
  result: "performed",
};

describe("serializeActionLogEntry", () => {
  it("emits the six required accountability fields", () => {
    expect(serializeActionLogEntry(base)).toEqual({
      id: "a1",
      userId: "u1",
      when: "2026-01-01T00:00:00Z",
      what: "sent objective-met notice",
      why: "standing objective met",
      result: "performed",
    });
  });

  it("includes objectiveId and detail when present (e.g. a refused action)", () => {
    expect(
      serializeActionLogEntry({ ...base, result: "refused", objectiveId: "obj-9", detail: "no recorded consent" }),
    ).toMatchObject({ result: "refused", objectiveId: "obj-9", detail: "no recorded consent" });
  });

  it("omits objectiveId and detail when absent or empty", () => {
    const out = serializeActionLogEntry({ ...base, objectiveId: "", detail: "" });
    expect(out).not.toHaveProperty("objectiveId");
    expect(out).not.toHaveProperty("detail");
  });
});
