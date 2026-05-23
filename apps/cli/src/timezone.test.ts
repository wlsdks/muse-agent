import { describe, expect, it } from "vitest";

import { formatTimeInZone, resolveTimezone } from "./timezone.js";

describe("resolveTimezone", () => {
  it("resolves common spoken names (case-insensitive) to IANA zones", () => {
    expect(resolveTimezone("tokyo")).toBe("Asia/Tokyo");
    expect(resolveTimezone("New York")).toBe("America/New_York");
    expect(resolveTimezone("LA")).toBe("America/Los_Angeles");
    expect(resolveTimezone("utc")).toBe("UTC");
  });

  it("accepts a raw IANA zone the platform recognises", () => {
    expect(resolveTimezone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(resolveTimezone("Europe/Paris")).toBe("Europe/Paris");
  });

  it("returns undefined for an unknown place / empty input (no guess)", () => {
    expect(resolveTimezone("Atlantis")).toBeUndefined();
    expect(resolveTimezone("Not/AZone")).toBeUndefined();
    expect(resolveTimezone("   ")).toBeUndefined();
  });
});

describe("formatTimeInZone — machine-timezone-independent, DST-correct", () => {
  it("renders the wall-clock time in the target zone", () => {
    // UTC midnight → Tokyo (UTC+9, no DST) is 09:00 the same day.
    expect(formatTimeInZone("Asia/Tokyo", new Date("2026-05-24T00:00:00Z"))).toContain("09:00");
    expect(formatTimeInZone("UTC", new Date("2026-05-24T00:00:00Z"))).toContain("00:00");
  });

  it("honours DST — London is UTC+1 (BST) in July, UTC+0 in January", () => {
    expect(formatTimeInZone("Europe/London", new Date("2026-07-01T00:00:00Z"))).toContain("01:00");
    expect(formatTimeInZone("Europe/London", new Date("2026-01-01T00:00:00Z"))).toContain("00:00");
  });
});
