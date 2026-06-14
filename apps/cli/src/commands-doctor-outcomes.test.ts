import { describe, expect, it } from "vitest";

import { formatRunOutcomes } from "./commands-doctor-outcomes.js";

describe("formatRunOutcomes", () => {
  it("reports the no-graded-runs case when nothing is labelled", () => {
    const out = formatRunOutcomes({
      labelled: 0,
      failRate: 0,
      grounded: 0,
      abstain: 0,
      ungrounded: 0,
      topFailingTopics: []
    });
    expect(out).toContain("no graded runs yet");
  });

  it("renders the fail-rate head with the grounded/abstain/ungrounded split", () => {
    const out = formatRunOutcomes({
      labelled: 4,
      failRate: 0.25,
      grounded: 3,
      abstain: 0,
      ungrounded: 1,
      topFailingTopics: []
    });
    expect(out).toContain("4 graded runs");
    expect(out).toContain("fail-rate 25%");
    expect(out).toContain("3 grounded");
    expect(out).not.toContain("top failing topics");
  });

  it("appends the top failing topics when present", () => {
    const out = formatRunOutcomes({
      labelled: 2,
      failRate: 0.5,
      grounded: 1,
      abstain: 0,
      ungrounded: 1,
      topFailingTopics: [{ topic: "vpn", count: 2 }]
    });
    expect(out).toContain("top failing topics");
    expect(out).toContain("vpn");
    expect(out).toContain("2×");
  });
});
