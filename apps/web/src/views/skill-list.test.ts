import { describe, expect, it } from "vitest";

import { canAdjustReward, rewardDelta, summarizeSkills } from "./skill-list.js";

describe("rewardDelta", () => {
  it("up → 1", () => {
    expect(rewardDelta("up")).toBe(1);
  });

  it("down → -1", () => {
    expect(rewardDelta("down")).toBe(-1);
  });
});

describe("canAdjustReward", () => {
  it("reward 5 + up → false (at ceiling)", () => {
    expect(canAdjustReward(5, "up")).toBe(false);
  });

  it("reward 5 + down → true (can still decrease)", () => {
    expect(canAdjustReward(5, "down")).toBe(true);
  });

  it("reward -5 + down → false (at floor)", () => {
    expect(canAdjustReward(-5, "down")).toBe(false);
  });

  it("reward -5 + up → true (can still increase)", () => {
    expect(canAdjustReward(-5, "up")).toBe(true);
  });

  it("reward 0 + up → true", () => {
    expect(canAdjustReward(0, "up")).toBe(true);
  });

  it("reward 0 + down → true", () => {
    expect(canAdjustReward(0, "down")).toBe(true);
  });

  it("reward 4 + up → true (one step below ceiling)", () => {
    expect(canAdjustReward(4, "up")).toBe(true);
  });
});

describe("summarizeSkills", () => {
  it("empty list → all zero", () => {
    expect(summarizeSkills([])).toEqual({ total: 0, active: 0, avoided: 0 });
  });

  it("counts active vs avoided distinctly", () => {
    const out = summarizeSkills([{ avoided: false }, { avoided: true }, { avoided: false }]);
    expect(out).toEqual({ total: 3, active: 2, avoided: 1 });
  });

  it("all-avoided → active 0", () => {
    expect(summarizeSkills([{ avoided: true }, { avoided: true }])).toEqual({
      total: 2,
      active: 0,
      avoided: 2
    });
  });

  it("all-active → avoided 0", () => {
    expect(summarizeSkills([{ avoided: false }, { avoided: false }])).toEqual({
      total: 2,
      active: 2,
      avoided: 0
    });
  });
});
