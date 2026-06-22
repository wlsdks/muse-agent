import { describe, expect, it } from "vitest";

import { annotateNoteChunks, nearestHeading, rankKnowledgeChunks } from "./knowledge-recall.js";

const NOTE = [
  "# 오사카 여행",
  "",
  "## 준비물",
  "아스피린, 밴드, 멀티탭을 챙긴다.",
  "",
  "## 일정",
  "9월 20일 출발, 23일 귀국."
].join("\n");

describe("nearestHeading", () => {
  it("finds the closest preceding markdown heading for a chunk", () => {
    expect(nearestHeading(NOTE, "아스피린, 밴드, 멀티탭을 챙긴다.")).toBe("준비물");
    expect(nearestHeading(NOTE, "9월 20일 출발, 23일 귀국.")).toBe("일정");
  });

  it("falls back to the title heading or undefined", () => {
    expect(nearestHeading("no headings here", "no headings here")).toBeUndefined();
  });

  it("attributes the chunk's OWN section when the chunk carries an overlap prefix from the prior section", () => {
    // applyOverlap joins the previous chunk's tail to this chunk with a blank
    // line. The prefix here is from the 준비물 section but the chunk body lives
    // under 일정 — the heading must be 일정, not 준비물 (the prefix's section).
    const overlapped = ["멀티탭을 챙긴다.", "9월 20일 출발, 23일 귀국."].join("\n\n");
    expect(nearestHeading(NOTE, overlapped)).toBe("일정");
  });
});

describe("annotateNoteChunks", () => {
  it("keeps the chunk text RAW and carries the [source · heading] context in embedText", () => {
    const chunks = annotateNoteChunks("travel.md", NOTE, ["아스피린, 밴드, 멀티탭을 챙긴다."]);
    expect(chunks[0]?.text).toBe("아스피린, 밴드, 멀티탭을 챙긴다.");
    expect(chunks[0]?.embedText).toBe("[travel.md · 준비물] 아스피린, 밴드, 멀티탭을 챙긴다.");
  });
});

describe("rankKnowledgeChunks embeds embedText when present, evidence stays raw", () => {
  it("the embedder sees the annotated text; the returned match text is the raw chunk", async () => {
    const seen: string[] = [];
    const embed = (text: string): Promise<readonly number[]> => {
      seen.push(text);
      return Promise.resolve(text.includes("준비물") || text.includes("약") ? [1, 0] : [0, 1]);
    };
    const matches = await rankKnowledgeChunks("여행 약 준비물", [
      { embedText: "[travel.md · 준비물] 아스피린, 밴드", source: "travel.md", text: "아스피린, 밴드" }
    ], { embed, hybrid: true, topK: 1 });
    expect(seen).toContain("[travel.md · 준비물] 아스피린, 밴드");
    expect(matches[0]?.text).toBe("아스피린, 밴드");
  });
});
