import { describe, expect, it } from "vitest";

import { extractFollowupPromises, hasCommissiveForce } from "../src/index.js";

const now = new Date("2026-06-14T10:00:00.000Z");
// requireCommissive:true mirrors what the production capture hook passes.
const kinds = (text: string): string[] =>
  extractFollowupPromises(text, { now, requireCommissive: true }).map((p) => p.kind);

const kindsUngated = (text: string): string[] =>
  extractFollowupPromises(text, { now }).map((p) => p.kind);

// Speech-act commissive force (arXiv:2502.14321): a SELF-followup is a commissive
// act (the assistant commits to a future action). A descriptive time mention with
// no first-person commitment ("your meeting is tomorrow") is an illocutionary
// misfire — capturing it queues a reminder the assistant never promised.

describe("hasCommissiveForce", () => {
  it("true when a first-person commitment governs the time phrase's sentence", () => {
    const t = "I'll check the report tomorrow morning.";
    expect(hasCommissiveForce(t, t.indexOf("tomorrow"))).toBe(true);
  });

  it("true when the commitment FOLLOWS the time phrase in the same sentence", () => {
    const t = "In 30 minutes I'll ping you.";
    expect(hasCommissiveForce(t, t.toLowerCase().indexOf("in 30"))).toBe(true);
  });

  it("false for a descriptive/assertive sentence (no commitment)", () => {
    const t = "Your meeting is tomorrow at 3pm.";
    expect(hasCommissiveForce(t, t.indexOf("tomorrow"))).toBe(false);
  });

  it("does not leak a commitment from a DIFFERENT sentence", () => {
    const t = "I'll handle the deploy. Your meeting is tomorrow.";
    expect(hasCommissiveForce(t, t.indexOf("tomorrow"))).toBe(false);
  });

  it("recognises let me / remind you / I will", () => {
    expect(hasCommissiveForce("let me check at 5pm", 13)).toBe(true);
    expect(hasCommissiveForce("I will follow up in 2 days", 18)).toBe(true);
  });
});

describe("extractFollowupPromises — commissive gate (English kinds)", () => {
  it("DROPS a descriptive English time phrase (no self-commitment)", () => {
    expect(kinds("Your meeting is tomorrow at 3pm.")).toEqual([]);
    expect(kinds("The report is due in 2 days.")).toEqual([]);
  });

  it("opt-in: WITHOUT requireCommissive the pure parser still emits (contract preserved)", () => {
    // The production hook sets requireCommissive; the bare parser path is unchanged.
    expect(kindsUngated("Your meeting is tomorrow at 3pm.").length).toBeGreaterThan(0);
  });

  it("KEEPS a genuine self-followup", () => {
    expect(kinds("I'll remind you tomorrow morning.")).toContain("tomorrow-slot");
    expect(kinds("Let me check back in 30 minutes.")).toContain("relative-minutes");
    expect(kinds("In 30 minutes I'll ping you.")).toContain("relative-minutes");
  });

  it("Korean kinds remain ungated (no regression; KO commissive gate is backlogged)", () => {
    // The KO commitment '확인할게' and even a bare descriptive KO phrase still emit
    // today — the gate is English-only, mirroring the EN-only negatedBefore precedent.
    expect(kinds("내일 아침에 확인할게").length).toBeGreaterThan(0);
    expect(kinds("내일 회의가 있어").length).toBeGreaterThan(0);
  });
});
