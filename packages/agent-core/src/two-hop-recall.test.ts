import { describe, expect, it } from "vitest";

import { rankKnowledgeChunksWithHop } from "./knowledge-recall.js";

// Toy space: query hits A; A's text is close to B; B shares no signal with the query.
const VEC: Record<string, readonly number[]> = {
  "민서는 마케팅팀 팀장이다": [0.1, 1, 0],
  "사피엔스 추천해준 사람이 무슨 팀이야": [1, 0.05, 0],
  "사피엔스는 민서가 추천해준 책이다": [1, 0.3, 0],
  "오늘 회의에서 추천 도서 이야기를 했다": [0.85, 0.02, 0.1],
  "오늘 점심은 김치찌개": [0, 0, 1]
};
const embed = (text: string): Promise<readonly number[]> => Promise.resolve(VEC[text] ?? [0, 0, 0.01]);

const notes = [
  { source: "rec.md", text: "사피엔스는 민서가 추천해준 책이다" },
  { source: "minseo.md", text: "민서는 마케팅팀 팀장이다" },
  { source: "meeting.md", text: "오늘 회의에서 추천 도서 이야기를 했다" },
  { source: "lunch.md", text: "오늘 점심은 김치찌개" }
];

describe("rankKnowledgeChunksWithHop (deterministic pseudo-relevance second hop)", () => {
  it("surfaces the bridging note the raw query misses", async () => {
    const flat = await rankKnowledgeChunksWithHop("사피엔스 추천해준 사람이 무슨 팀이야", notes, { embed, hybrid: true, topK: 2 });
    expect(flat.map((m) => m.source)).toContain("rec.md");
    const hopped = await rankKnowledgeChunksWithHop("사피엔스 추천해준 사람이 무슨 팀이야", notes, { embed, hybrid: true, secondHop: true, topK: 3 });
    expect(hopped.map((m) => m.source)).toContain("rec.md");
    expect(hopped.map((m) => m.source)).toContain("minseo.md");
  });

  it("without secondHop behaves exactly like the base ranking", async () => {
    const base = await rankKnowledgeChunksWithHop("사피엔스 추천해준 사람이 무슨 팀이야", notes, { embed, hybrid: true, topK: 2 });
    expect(base.map((m) => m.source)).not.toContain("minseo.md");
  });
});
