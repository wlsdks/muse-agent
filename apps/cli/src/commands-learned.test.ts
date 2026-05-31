import { describe, expect, it } from "vitest";

import { renderLearnedDigest } from "./commands-learned.js";

describe("renderLearnedDigest", () => {
  it("shows an enable hint when nothing has been learned", () => {
    const out = renderLearnedDigest({ reflections: [], skills: [], strategies: [] });
    expect(out).toContain("hasn't learned anything");
    expect(out).toContain("MUSE_PLAYBOOK_DISTILL_ENABLED");
  });

  it("lists trusted strategies/skills (reward ≥ 1, highest first) and hides neutral ones", () => {
    const out = renderLearnedDigest({
      reflections: [],
      skills: [{ name: "vpn-fix", reward: 3 }, { name: "neutral-skill", reward: 0 }],
      strategies: [
        { reward: 1, tag: "email", text: "keep emails short" },
        { reward: 4, text: "summarise in bullets" },
        { reward: 0, text: "neutral strategy" }
      ]
    });
    expect(out).toContain("Trusted strategies");
    expect(out.indexOf("summarise in bullets")).toBeLessThan(out.indexOf("keep emails short")); // +4 before +1
    expect(out).toContain("keep emails short (email)  ⟨+1⟩");
    expect(out).toContain("vpn-fix  ⟨+3⟩");
    expect(out).not.toContain("neutral strategy"); // reward 0 is neither trusted nor avoided
    expect(out).not.toContain("neutral-skill");
  });

  it("lists avoided strategies and skills (reward ≤ −4) under a distinct heading", () => {
    const out = renderLearnedDigest({
      reflections: [],
      skills: [{ name: "bad-skill", reward: -4 }],
      strategies: [{ reward: -5, text: "do the wrong thing" }]
    });
    expect(out).toContain("Learned to avoid");
    expect(out).toContain("strategy: do the wrong thing  ⟨-5⟩");
    expect(out).toContain("skill: bad-skill  ⟨-4⟩");
  });

  it("shows the most recent reflections, newest first, capped at 5", () => {
    const reflections = Array.from({ length: 7 }, (_unused, i) => ({ createdAtMs: i * 1000, insight: `insight ${i.toString()}` }));
    const out = renderLearnedDigest({ reflections, skills: [], strategies: [] });
    expect(out).toContain("insight 6  [1970-01-01]"); // newest
    expect(out).toContain("insight 2"); // 5th newest (6,5,4,3,2)
    expect(out).not.toContain("insight 1"); // beyond the cap of 5
  });
});
