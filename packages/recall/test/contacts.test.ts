import { describe, expect, it } from "vitest";

import { contactGroundingEvidence, contactMatchScore, formatContactBirthday } from "@muse/recall";
import type { Contact } from "@muse/mcp";

const dana: Contact = {
  name: "Dana Lee",
  relationship: "manager",
  email: "dana@example.com",
  aliases: ["D"],
  birthday: "1990-03-14"
};

describe("formatContactBirthday", () => {
  it("renders MM-DD without a year", () => {
    expect(formatContactBirthday("03-14")).toBe("March 14");
  });
  it("renders YYYY-MM-DD with the year", () => {
    expect(formatContactBirthday("1990-03-14")).toBe("March 14, 1990");
  });
  it("returns undefined for absent or malformed values", () => {
    expect(formatContactBirthday(undefined)).toBeUndefined();
    expect(formatContactBirthday("99-99")).toBeUndefined();
  });
  it("rejects an out-of-range month/day at the LOWER bound (no garbage ' 15' / 'March 0' birthday)", () => {
    // "99-99" exercises the UPPER bound (month>12, day>31); these hit the LOWER
    // guard (month<1, day<1). Without it, month 00 would index BIRTHDAY_MONTHS[-1]
    // → a blank month (" 15"), and day 00 → "March 0" — a garbage date rendered
    // into the grounding block. The guard drops them to undefined (no fabricated date).
    expect(formatContactBirthday("00-15")).toBeUndefined();
    expect(formatContactBirthday("2026-00-15")).toBeUndefined();
    expect(formatContactBirthday("03-00")).toBeUndefined();
  });
});

describe("contactGroundingEvidence", () => {
  it("includes the name and every rendered field", () => {
    const ev = contactGroundingEvidence(dana);
    expect(ev).toContain("Dana Lee");
    expect(ev).toContain("manager");
    expect(ev).toContain("dana@example.com");
    expect(ev).toContain("March 14, 1990");
  });
});

describe("contactMatchScore", () => {
  it("counts query tokens matching the contact's fields", () => {
    expect(contactMatchScore(dana, new Set(["dana"]))).toBeGreaterThan(0);
  });
  it("is zero for an empty query and for a non-matching query", () => {
    expect(contactMatchScore(dana, new Set())).toBe(0);
    expect(contactMatchScore(dana, new Set(["xylophone"]))).toBe(0);
  });
  it("accumulates one point per matching token across fields (score is the count, not capped at 1)", () => {
    // "Dana Lee" → {dana, lee}; relationship "manager" → {manager}: all three hit.
    expect(contactMatchScore(dana, new Set(["dana", "lee", "manager"]))).toBe(3);
  });
  it("matches a query token that only appears in an alias", () => {
    const withAlias: Contact = { name: "Bob", aliases: ["sparky"] };
    expect(contactMatchScore(withAlias, new Set(["sparky"]))).toBe(1);
  });
});
