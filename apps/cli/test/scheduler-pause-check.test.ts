import { describe, expect, it } from "vitest";

import { schedulerPauseCheck } from "../src/commands-doctor-checks.js";

describe("schedulerPauseCheck (doctor)", () => {
  it("warns with the since timestamp + resume hint when paused", () => {
    const out = schedulerPauseCheck({ paused: true, since: "2026-06-25T00:00:00.000Z" });
    expect(out.status).toBe("warn");
    expect(out.detail).toContain("PAUSED");
    expect(out.detail).toContain("2026-06-25T00:00:00.000Z");
    expect(out.detail).toContain("muse scheduler resume");
  });

  it("reports ok when not paused", () => {
    const out = schedulerPauseCheck({ paused: false });
    expect(out.status).toBe("ok");
    expect(out.detail).toContain("active");
  });
});
