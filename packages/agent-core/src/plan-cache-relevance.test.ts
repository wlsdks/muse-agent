import { describe, expect, it } from "vitest";

import { selectPlanExemplarByRelevance } from "./plan-cache.js";
import type { CachedPlan } from "./plan-cache.js";

const PLAN: CachedPlan = {
  prompt: "회의 일정 잡아줘",
  steps: [{ args: {}, description: "add the meeting", tool: "calendar_add" }]
};
const OTHER: CachedPlan = {
  prompt: "completely unrelated topic about gardening",
  steps: [{ args: {}, description: "noop", tool: "noop" }]
};

// A toy embedder: paraphrase pair maps to the same vector, everything else orthogonal.
const vectors: Record<string, readonly number[]> = {
  "completely unrelated topic about gardening": [0, 0, 1],
  "미팅 약속 만들어줘": [1, 0, 0],
  "회의 일정 잡아줘": [1, 0, 0]
};
const embed = (text: string): Promise<readonly number[]> => {
  const vec = vectors[text];
  return vec ? Promise.resolve(vec) : Promise.reject(new Error("unknown text"));
};

describe("selectPlanExemplarByRelevance (Jaccard → embedding blend)", () => {
  it("finds the paraphrase hit the lexical overlap misses (KO particles, synonyms)", async () => {
    const picked = await selectPlanExemplarByRelevance([OTHER, PLAN], "미팅 약속 만들어줘", embed);
    expect(picked?.prompt).toBe("회의 일정 잡아줘");
  });

  it("rejects a candidate below both the lexical and cosine floors", async () => {
    const picked = await selectPlanExemplarByRelevance([OTHER], "미팅 약속 만들어줘", embed);
    expect(picked).toBeUndefined();
  });

  it("fail-open: a throwing embedder degrades to the lexical selector", async () => {
    const broken = (): Promise<readonly number[]> => Promise.reject(new Error("ollama down"));
    const lexicalHit: CachedPlan = { ...PLAN, prompt: "회의 일정 잡아줘 내일" };
    const picked = await selectPlanExemplarByRelevance([lexicalHit], "회의 일정 잡아줘", broken);
    expect(picked?.prompt).toBe("회의 일정 잡아줘 내일");
    const miss = await selectPlanExemplarByRelevance([PLAN], "미팅 약속 만들어줘", broken);
    expect(miss).toBeUndefined();
  });
});
