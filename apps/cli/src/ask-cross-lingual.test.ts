import { reportSentenceGroundedness } from "@muse/agent-core";
import type { ActionLogEntry } from "@muse/stores";
import { describe, expect, it, vi } from "vitest";

import { crossLingualUnsupportedFraction, rescueActionsCrossLingual, rescueMemoryCrossLingual } from "./ask-cross-lingual.js";

describe("crossLingualUnsupportedFraction — semantic faithfulness for the misgrounding probe (KO answer vs EN evidence)", () => {
  // deterministic embedder: a deadline-topic sentence → [1,0]; anything else → [0,1].
  const faithEmbed = vi.fn(async (t: string): Promise<readonly number[]> => (/마감|deadline/u.test(t) ? [1, 0] : [0, 1]));

  it("rescues a cross-lingually SUPPORTED sentence (high cosine) and counts a fabricated one (low cosine)", async () => {
    const report = reportSentenceGroundedness("마감일은 삼월. 예산은 백만원.", ["The deadline is in March."]);
    const frac = await crossLingualUnsupportedFraction({ report, evidence: ["The deadline is in March."], embed: faithEmbed, floor: 0.5 });
    expect(frac).toBe(0.5); // s1 (마감↔deadline) rescued, s2 (예산, fabricated) counted → 1/2
  });

  it("returns 0 when every assertive sentence is cross-lingually supported", async () => {
    const report = reportSentenceGroundedness("마감일은 삼월.", ["The deadline is in March."]);
    expect(await crossLingualUnsupportedFraction({ report, evidence: ["The deadline is in March."], embed: faithEmbed, floor: 0.5 })).toBe(0);
  });

  it("pays ZERO embedding cost when no assertive sentence is lexically unsupported", async () => {
    const report = reportSentenceGroundedness("The cat sat on the mat.", ["The cat sat on the mat."]);
    const before = faithEmbed.mock.calls.length;
    expect(await crossLingualUnsupportedFraction({ report, evidence: ["The cat sat on the mat."], embed: faithEmbed, floor: 0.5 })).toBe(0);
    expect(faithEmbed.mock.calls.length).toBe(before);
  });
});

// Deterministic "embedder": manager/매니저 → [1,0], dentist/치과 → [1,0], else [0,1].
const embedFn = vi.fn(async (t: string): Promise<readonly number[]> =>
  /매니저|manager|치과|dentist/u.test(t) ? [1, 0] : [0, 1]
);

const memory = { facts: { manager: "Dana Kim", project: "Apollo launch" }, preferences: {} };

describe("rescueMemoryCrossLingual", () => {
  it("rescues an EN fact for a KO query that scored lexical-0", async () => {
    const out = await rescueMemoryCrossLingual(memory, "매니저", new Set(["매니저"]), embedFn);
    expect(out.map((f) => f.key)).toEqual(["manager"]);
  });

  it("returns nothing for an empty store (no embed calls)", async () => {
    const calls = embedFn.mock.calls.length;
    const out = await rescueMemoryCrossLingual({ facts: {}, preferences: {} }, "매니저", new Set(["매니저"]), embedFn);
    expect(out).toEqual([]);
    expect(embedFn.mock.calls.length).toBe(calls); // speed guard: did not embed
  });
});

describe("rescueActionsCrossLingual", () => {
  const entries = [
    { what: "booked the dentist appointment", when: "2026-06-01T00:00:00Z" },
    { what: "renewed the gym membership", when: "2026-06-02T00:00:00Z" }
  ] as unknown as ActionLogEntry[];

  it("rescues an EN action for a KO query via cosine", async () => {
    const out = await rescueActionsCrossLingual(entries, "치과 예약", embedFn);
    expect(out.length).toBe(1);
    expect(out[0]!.what).toContain("dentist");
  });

  it("returns nothing for no entries", async () => {
    expect(await rescueActionsCrossLingual([], "치과", embedFn)).toEqual([]);
  });
});
