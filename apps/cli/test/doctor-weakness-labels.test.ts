import type { WeaknessEntry } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { formatWeaknesses } from "../src/commands-doctor.js";

const entry = (axis: WeaknessEntry["axis"]): WeaknessEntry => ({
  axis, count: 3, firstSeen: "2026-06-01T00:00:00.000Z", lastSeen: "2026-06-07T00:00:00.000Z", topic: "office vpn"
});

describe("formatWeaknesses — every written axis renders a friendly user-facing label (not the raw key)", () => {
  it("labels source-conflict + misgrounding (previously fell through to the raw axis key)", () => {
    const out = formatWeaknesses([entry("source-conflict"), entry("misgrounding")]);
    expect(out).toContain("your saved notes disagree");
    expect(out).toContain("answered from sources that didn't support it");
    // the raw axis keys must NOT leak to the user
    expect(out).not.toContain("source-conflict");
    expect(out).not.toContain("misgrounding");
  });

  it("still labels the pre-existing axes", () => {
    expect(formatWeaknesses([entry("grounding-gap")])).toContain("couldn't answer");
    expect(formatWeaknesses([entry("time-parse")])).toContain("misread a date/time");
  });
});

describe("formatWeaknesses — MASTERED topics are excluded from the active 'weak at' report (runtime-nudge parity)", () => {
  const at = (topic: string, pKnown?: number): WeaknessEntry => ({
    axis: "grounding-gap", count: 3, firstSeen: "2026-06-01T00:00:00.000Z", lastSeen: "2026-06-07T00:00:00.000Z", topic, ...(pKnown !== undefined ? { pKnown } : {})
  });

  it("a MASTERED topic (pKnown ≥ 0.95) does not appear; an active one does, with a mastered note in the header", () => {
    const out = formatWeaknesses([at("solved thing", 0.99), at("still stuck")]);
    expect(out).toContain("still stuck");
    expect(out).not.toContain("solved thing");
    expect(out).toContain("1 mastered");
    expect(out).toContain("1 topic");           // only the active one counted
  });

  it("ALL-mastered → an 'all resolved' line, not the empty-ledger line", () => {
    const out = formatWeaknesses([at("a", 0.99), at("b", 0.97)]);
    expect(out).toContain("no ACTIVE weak spots");
    expect(out).toContain("2 topics mastered");
    expect(out).not.toContain("a  —");           // neither topic listed
  });
});
