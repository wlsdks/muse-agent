import { describe, expect, it } from "vitest";

import { rankPlaybookStrategies, type PlaybookStrategy } from "../src/index.js";

// A blank-text strategy with a HIGH reward would otherwise rank FIRST and become
// the surfaced "applied strategy" (topAppliedStrategy reads ranked[0].text directly,
// bypassing renderPlaybookSection's empty-text filter). The gate must drop it from
// the ranked OUTPUT, not just the rendered block.
describe("rankPlaybookStrategies — drops empty-text strategies from the ranked output", () => {
  it("a high-reward BLANK strategy is excluded (never the top applied strategy)", () => {
    const bank: PlaybookStrategy[] = [
      { text: "   ", reward: 5 }, // would rank first on reward without the gate
      { text: "prefer bullet points", reward: 1 },
      { text: "keep it short", reward: 1 }
    ];
    const ranked = rankPlaybookStrategies(bank, "how should you answer");
    // Neutralizing dropEmptyTextStrategies puts "   " back at ranked[0] → RED.
    expect(ranked.map((s) => s.text)).not.toContain("   ");
    expect(ranked[0]?.text.trim().length ?? 0).toBeGreaterThan(0);
  });

  it("non-blank strategies are untouched", () => {
    const bank: PlaybookStrategy[] = [
      { text: "prefer bullet points", reward: 2 },
      { text: "keep it short", reward: 1 }
    ];
    const ranked = rankPlaybookStrategies(bank, "how should you answer");
    expect(ranked.map((s) => s.text).sort()).toEqual(["keep it short", "prefer bullet points"]);
  });
});
