import type { WeaknessEntry } from "@muse/mcp";
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
