import { describe, expect, it } from "vitest";

import { summarizeFlags } from "./settings-flags.js";

describe("summarizeFlags", () => {
  it("empty → { total: 0, enabled: 0 }", () => {
    expect(summarizeFlags([])).toEqual({ total: 0, enabled: 0 });
  });

  it("mixed flags → counts only enabled ones", () => {
    expect(
      summarizeFlags([{ enabled: true }, { enabled: false }, { enabled: true }])
    ).toEqual({ total: 3, enabled: 2 });
  });

  it("all disabled → enabled 0", () => {
    expect(summarizeFlags([{ enabled: false }, { enabled: false }])).toEqual({
      total: 2,
      enabled: 0
    });
  });
});
