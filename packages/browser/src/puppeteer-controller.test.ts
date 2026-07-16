import { describe, expect, it } from "vitest";

import { normalizeBrowserTimeout } from "./puppeteer-controller.js";

describe("normalizeBrowserTimeout", () => {
  it("falls back for invalid timer values and clamps Node timer overflow", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeBrowserTimeout(value, 15_000)).toBe(15_000);
    }
    expect(normalizeBrowserTimeout(Number.MAX_SAFE_INTEGER, 15_000)).toBe(2_147_483_647);
  });
});
