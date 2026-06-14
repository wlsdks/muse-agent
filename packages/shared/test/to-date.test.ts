import { describe, expect, it } from "vitest";

import { toDate } from "../src/index.js";

describe("toDate", () => {
  it("returns a Date instance unchanged (same reference)", () => {
    const d = new Date("2026-06-14T00:00:00.000Z");
    expect(toDate(d)).toBe(d);
  });

  it("parses an ISO string into the equivalent Date", () => {
    expect(toDate("2026-06-14T00:00:00.000Z").getTime()).toBe(
      Date.parse("2026-06-14T00:00:00.000Z")
    );
  });
});
