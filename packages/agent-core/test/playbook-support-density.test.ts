import { describe, expect, it } from "vitest";

import {
  isLowSupportStrategy,
  PLAYBOOK_SUPPORT_DENSITY_COSINE,
  rankPlaybookStrategiesByRelevance,
  strategySupportDensity,
  type PlaybookStrategy
} from "../src/index.js";

// CBR case-density confidence (arXiv:2504.06943): a case in a DENSE region of
// mutually-consistent neighbors is high-confidence; an ISOLATED case in a sparse
// region is a low-confidence guess. Applied to the playbook: an isolated,
// unproven, SYNTHETIC (reflected) strategy is gated from injection — but a
// grounded/manual correction (the user's real lesson) is NEVER dropped.

describe("strategySupportDensity", () => {
  it("counts neighbors at/above the cosine threshold", () => {
    const target: readonly number[] = [1, 0];
    const others: readonly (readonly number[])[] = [
      [1, 0],        // cos 1   ≥ 0.6 → neighbor
      [0.9, 0.436],  // cos ≈0.9 ≥ 0.6 → neighbor
      [0, 1],        // cos 0   < 0.6 → not
      []             // empty → not
    ];
    expect(strategySupportDensity(target, others)).toBe(2);
  });

  it("empty target vector → 0 (fail-soft)", () => {
    expect(strategySupportDensity([], [[1, 0]])).toBe(0);
  });

  it("threshold is the conservative agreeing-cosine floor", () => {
    expect(PLAYBOOK_SUPPORT_DENSITY_COSINE).toBe(0.6);
  });
});

describe("isLowSupportStrategy", () => {
  const reflected = (over: Partial<PlaybookStrategy> = {}): PlaybookStrategy => ({ origin: "reflected", reward: 0, text: "s", ...over });

  it("reflected + isolated (0 neighbors) + unproven → low support (drop)", () => {
    expect(isLowSupportStrategy(reflected(), 0)).toBe(true);
  });

  it("a GROUNDED isolated unproven correction is NEVER low support (wedge protected)", () => {
    expect(isLowSupportStrategy({ origin: "grounded", reward: 0, text: "s" }, 0)).toBe(false);
    expect(isLowSupportStrategy({ reward: 0, text: "s" }, 0)).toBe(false); // origin absent = not reflected
  });

  it("a corroborated reflected strategy (≥1 neighbor) is kept", () => {
    expect(isLowSupportStrategy(reflected(), 2)).toBe(false);
  });

  it("a PROVEN reflected strategy (positive effective reward) is kept even if isolated", () => {
    expect(isLowSupportStrategy(reflected({ reward: 4 }), 0)).toBe(false);
    expect(isLowSupportStrategy(reflected({ reinforcements: 5, decays: 0 }), 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Assembled: rankPlaybookStrategiesByRelevance (the muse-ask production ranker)
// drops an isolated reflected unproven strategy, keeps the clustered ones AND a
// grounded isolated one. Neutralizing isLowSupportStrategy (→ false) reinstates it.
// ---------------------------------------------------------------------------

// Email strategies cluster on dim0; the flight strategy is orthogonal (dim2);
// the grounded one is also orthogonal (dim3) but must survive.
const VEC = new Map<string, readonly number[]>([
  ["query about email scheduling", [1, 0, 0, 0]],
  ["email: send before noon", [1, 0, 0, 0]],
  ["email: keep it under 4 lines", [0.97, 0.24, 0, 0]],
  ["email: cc the manager", [0.95, 0.31, 0, 0]],
  ["always book the cheapest flight", [0, 0, 1, 0]], // isolated reflected unproven
  ["user prefers tea not coffee", [0, 0, 0, 1]]       // isolated GROUNDED — must survive
]);
const fakeEmbed = (t: string): Promise<readonly number[]> => Promise.resolve(VEC.get(t) ?? [0, 0, 0, 0]);

describe("rankPlaybookStrategiesByRelevance — CBR density gate (assembled)", () => {
  const bank: PlaybookStrategy[] = [
    { origin: "reflected", reward: 0, text: "email: send before noon" },
    { origin: "reflected", reward: 0, text: "email: keep it under 4 lines" },
    { origin: "reflected", reward: 0, text: "email: cc the manager" },
    { origin: "reflected", reward: 0, text: "always book the cheapest flight" },
    { origin: "grounded", reward: 0, text: "user prefers tea not coffee" }
  ];

  it("drops the isolated reflected unproven strategy; keeps clustered + grounded", async () => {
    const ranked = await rankPlaybookStrategiesByRelevance(bank, "query about email scheduling", fakeEmbed, { topK: 10 });
    const texts = ranked.map((s) => s.text);
    expect(texts).not.toContain("always book the cheapest flight"); // isolated reflected → gated
    expect(texts).toContain("user prefers tea not coffee");          // isolated GROUNDED → kept
    expect(texts).toContain("email: send before noon");              // clustered → kept
  });
});
