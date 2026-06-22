import { describe, expect, it } from "vitest";

import { createWorldTimeTool, formatTimeInZone, resolveTimezone } from "../src/index.js";

describe("resolveTimezone", () => {
  it("maps aliases (case-insensitive) and raw IANA zones; undefined for unknown", () => {
    expect(resolveTimezone("tokyo")).toBe("Asia/Tokyo");
    expect(resolveTimezone("New York")).toBe("America/New_York");
    expect(resolveTimezone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(resolveTimezone("Atlantis")).toBeUndefined();
    expect(resolveTimezone("  ")).toBeUndefined();
  });
});

describe("formatTimeInZone — DST-correct, machine-tz-independent", () => {
  it("renders the wall-clock in the zone", () => {
    expect(formatTimeInZone("Asia/Tokyo", new Date("2026-05-24T00:00:00Z"))).toContain("09:00");
    expect(formatTimeInZone("Europe/London", new Date("2026-07-01T00:00:00Z"))).toContain("01:00"); // BST
    expect(formatTimeInZone("Europe/London", new Date("2026-01-01T00:00:00Z"))).toContain("00:00");
  });
});

describe("createWorldTimeTool — agent tool", () => {
  const tool = createWorldTimeTool({ now: () => new Date("2026-05-24T00:00:00Z") });

  it("is read-risk and returns the resolved zone + time for a place", async () => {
    expect(tool.definition.risk).toBe("read");
    const out = await tool.execute({ place: "Tokyo" }, { runId: "r1" }) as { zone?: string; time?: string };
    expect(out.zone).toBe("Asia/Tokyo");
    expect(out.time).toContain("09:00");
  });

  it("returns an error (not a guess) for an unknown place or empty input", async () => {
    expect(await tool.execute({ place: "Atlantis" }, { runId: "r2" })).toMatchObject({ error: expect.stringContaining("unknown place") });
    expect(await tool.execute({ place: "" }, { runId: "r3" })).toMatchObject({ error: expect.stringContaining("required") });
  });
});
