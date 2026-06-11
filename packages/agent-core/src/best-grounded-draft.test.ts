import { describe, expect, it } from "vitest";

import { selectBestGroundedDraft } from "./knowledge-recall.js";
import type { KnowledgeMatch } from "./knowledge-recall.js";

const matches: readonly KnowledgeMatch[] = [
  { cosine: 1, score: 1, source: "notes/wifi.md", text: "office vpn mtu is 1380 set on june second" }
];

describe("selectBestGroundedDraft (best-of-N recall selection)", () => {
  it("picks the grounded draft and skips a fabricated one", () => {
    const drafts = [
      "the mtu is 9999 configured through the cisco fabric controller",
      "office vpn mtu is 1380 [from notes/wifi.md]"
    ];
    const best = selectBestGroundedDraft(drafts, matches, "office vpn mtu");
    expect(best?.index).toBe(1);
    expect(best?.verification.verdict).toBe("grounded");
  });

  it("prefers the higher-rubric draft among several grounded ones", () => {
    const drafts = [
      "office vpn mtu is 1380 probably cisco hardware",
      "office vpn mtu is 1380"
    ];
    const best = selectBestGroundedDraft(drafts, matches, "office vpn mtu", { coverageFloor: 0.01 });
    expect(best?.index).toBe(1);
  });

  it("returns undefined when no draft verifies grounded — weak is not accepted", () => {
    const weakMatches: readonly KnowledgeMatch[] = [
      { cosine: 0.4, score: 0.4, source: "notes/wifi.md", text: "office vpn mtu is 1380" }
    ];
    const best = selectBestGroundedDraft(["office vpn mtu is 1380"], weakMatches, "office vpn mtu");
    expect(best).toBeUndefined();
  });

  it("breaks a tie deterministically on the first draft", () => {
    const drafts = ["office vpn mtu is 1380", "office vpn mtu is 1380"];
    const best = selectBestGroundedDraft(drafts, matches, "office vpn mtu");
    expect(best?.index).toBe(0);
  });

  it("returns undefined on an empty draft set", () => {
    expect(selectBestGroundedDraft([], matches, "office vpn mtu")).toBeUndefined();
  });
});
