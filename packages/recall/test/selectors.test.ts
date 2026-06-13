import { describe, expect, it } from "vitest";

import {
  augmentNoteEvidenceWithCited,
  selectFilePassages,
  selectGroundingActions,
  selectPlaybookSection,
  selectProbationSuggestion,
  topAppliedStrategy
} from "@muse/recall";

describe("selectFilePassages", () => {
  it("keeps the strongest query-overlapping passages within the budget, in file order", () => {
    const raw = "intro paragraph about cats\n\nthe vpn mtu is 1380\n\nmore filler text";
    const out = selectFilePassages(raw, "vpn mtu", 200);
    expect(out.map((p) => p.text).join(" ")).toContain("1380");
  });
});

describe("selectGroundingActions", () => {
  it("ranks action-log entries by overlap with the query", () => {
    const entries = [
      { what: "sent invoice to dana", when: "2026-06-01" },
      { what: "watered the plants", when: "2026-06-02" }
    ];
    const out = selectGroundingActions(entries, "invoice dana", 1);
    expect(out[0]!.what).toContain("invoice");
  });
});

describe("selectProbationSuggestion", () => {
  it("returns the most relevant probation entry, or undefined when none match", () => {
    const entries = [
      { id: "1", text: "prefers metric units", probation: true },
      { id: "2", text: "likes tea", probation: false }
    ];
    expect(selectProbationSuggestion(entries, "metric units")?.id).toBe("1");
    expect(selectProbationSuggestion(entries, "unrelated")).toBeUndefined();
  });
});

describe("augmentNoteEvidenceWithCited", () => {
  it("adds full text of a cited note missing from the base evidence, additively", () => {
    const base = [{ cosine: 0.4, score: 0.4, source: "a.md", text: "alpha" }];
    const out = augmentNoteEvidenceWithCited(base, ["b.md"], [
      { source: "b.md", chunks: [{ text: "beta fact" }] }
    ]);
    expect(out.some((m) => m.source === "b.md" && m.text === "beta fact")).toBe(true);
    expect(out.some((m) => m.source === "a.md")).toBe(true);
  });
  it("does not duplicate evidence already present", () => {
    const base = [{ cosine: 1, score: 1, source: "b.md", text: "beta" }];
    const out = augmentNoteEvidenceWithCited(base, ["b.md"], [{ source: "b.md", chunks: [{ text: "beta" }] }]);
    expect(out.filter((m) => m.text === "beta")).toHaveLength(1);
  });
});

describe("playbook selection", () => {
  it("returns undefined for an empty bank", () => {
    expect(selectPlaybookSection([], "anything")).toBeUndefined();
    expect(topAppliedStrategy([], "anything")).toBeUndefined();
  });
  it("renders a section / picks a top strategy when entries are relevant", () => {
    const entries = [{ text: "quote the exact source line", reward: 3 }];
    expect(topAppliedStrategy(entries, "quote source")).toBe("quote the exact source line");
  });
});
