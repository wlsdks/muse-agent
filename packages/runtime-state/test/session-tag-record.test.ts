import { describe, expect, it } from "vitest";

import { type CreateSessionTagInput, createSessionTagRecord } from "../src/session-tags.js";

const NOW_MS = Date.parse("2026-02-02T00:00:00Z");

const options = () => {
  let n = 0;
  return { now: () => NOW_MS, idFactory: () => `tag-${n++}` };
};
const input = (overrides: Partial<CreateSessionTagInput> = {}): CreateSessionTagInput => ({
  label: "important",
  sessionId: "s1",
  createdBy: "u1",
  ...overrides,
});

describe("createSessionTagRecord", () => {
  it("applies defaults (now/idFactory), trims the label, and omits an absent comment", () => {
    expect(createSessionTagRecord(input({ label: "  important  " }), options())).toEqual({
      createdAt: NOW_MS,
      createdBy: "u1",
      id: "tag-0",
      label: "important", // trimmed
      sessionId: "s1",
    });
  });

  it("honours an explicit id, createdAt, and comment", () => {
    expect(
      createSessionTagRecord(
        input({ id: "fixed", createdAt: 1_735_689_600_000, comment: "a note" }),
        options(),
      ),
    ).toMatchObject({ id: "fixed", createdAt: 1_735_689_600_000, comment: "a note" });
  });

  it("omits an empty-string comment", () => {
    expect(createSessionTagRecord(input({ comment: "" }), options())).not.toHaveProperty("comment");
  });

  it("rejects blank identity fields and invalid timestamps", () => {
    for (const override of [
      { createdBy: " " },
      { id: " " },
      { label: " " },
      { sessionId: " " },
      { createdAt: Number.NaN },
      { createdAt: Number.POSITIVE_INFINITY },
      { createdAt: -1 },
      { createdAt: 1.5 },
    ]) {
      expect(() => createSessionTagRecord(input(override), options())).toThrow(TypeError);
    }
  });
});
