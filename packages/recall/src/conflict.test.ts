import { describe, expect, it } from "vitest";

import { detectSourceConflict, formatSourceConflictWarning } from "./conflict.js";
import type { RecallHit } from "./hit.js";

const hit = (ref: string, snippet: string, score = 0.7): RecallHit => ({ ref, score, snippet, source: "notes" });

describe("detectSourceConflict — evidence-vs-evidence contradiction (grounded≠true)", () => {
  it("flags two sources giving different values for the same labelled field", () => {
    const a = hit("wifi-old.md", "WiFi password: hunter2");
    const b = hit("wifi-new.md", "wifi password: swordfish99");
    const conflicts = detectSourceConflict([a, b]);
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0]!;
    expect(c.field).toBe("wifi password");
    expect([c.valueA, c.valueB].sort()).toEqual(["hunter2", "swordfish99"]);
    expect([c.a.ref, c.b.ref].sort()).toEqual(["wifi-new.md", "wifi-old.md"]);
  });

  it("does NOT flag two sources that AGREE on the same field (no false conflict)", () => {
    const a = hit("a.md", "Office address: 12 Baker Street");
    const b = hit("b.md", "office ADDRESS: 12 Baker Street");
    expect(detectSourceConflict([a, b])).toEqual([]);
  });

  it("ignores case/whitespace differences in the value (same fact, not a conflict)", () => {
    const a = hit("a.md", "Capital: Paris");
    const b = hit("b.md", "capital:  paris ");
    expect(detectSourceConflict([a, b])).toEqual([]);
  });

  it("returns [] for unrelated hits (no shared labelled field)", () => {
    const a = hit("a.md", "The meeting is on Tuesday.");
    const b = hit("b.md", "Remember to water the plants.");
    expect(detectSourceConflict([a, b])).toEqual([]);
  });

  it("does NOT flag two differing values within the SAME hit (only cross-source conflicts)", () => {
    const a = hit("a.md", "port: 8080\nport: 9090");
    expect(detectSourceConflict([a])).toEqual([]);
  });

  it("returns [] for fewer than two hits", () => {
    expect(detectSourceConflict([])).toEqual([]);
    expect(detectSourceConflict([hit("a.md", "key: value")])).toEqual([]);
  });

  it("does NOT flag common prose prefixes with different following text (Note:/TODO:/Summary: are not attributes)", () => {
    expect(detectSourceConflict([
      hit("a.md", "Note: call the dentist"),
      hit("b.md", "note: water the plants")
    ])).toEqual([]);
    expect(detectSourceConflict([
      hit("a.md", "TODO: ship the release"),
      hit("b.md", "todo: review the PR")
    ])).toEqual([]);
  });

  it("does NOT parse a clock time as a labelled field (no garbage 'meeting at 9' conflict)", () => {
    expect(detectSourceConflict([
      hit("a.md", "Meeting at 9:30 with Sam"),
      hit("b.md", "Meeting at 9:45 with Sam")
    ])).toEqual([]);
  });
});

describe("formatSourceConflictWarning — user-facing surfacing of evidence conflicts", () => {
  it("renders a warning naming the field, both values, and both source refs", () => {
    const warning = formatSourceConflictWarning([
      hit("wifi-old.md", "WiFi password: hunter2"),
      hit("wifi-new.md", "wifi password: swordfish99")
    ]);
    expect(warning).toBeDefined();
    expect(warning).toContain("Your sources disagree");
    expect(warning).toContain("wifi password");
    expect(warning).toContain("hunter2");
    expect(warning).toContain("swordfish99");
    expect(warning).toContain("wifi-old.md");
    expect(warning).toContain("wifi-new.md");
  });

  it("returns undefined when sources agree (no warning rendered)", () => {
    expect(formatSourceConflictWarning([
      hit("a.md", "Capital: Paris"),
      hit("b.md", "capital: paris")
    ])).toBeUndefined();
  });
});
