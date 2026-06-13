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
});
