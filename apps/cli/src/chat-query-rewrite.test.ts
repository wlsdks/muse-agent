import { describe, expect, it } from "vitest";

import { buildQueryRewritePrompt, needsContextualRewrite, parseQueryRewrite, QUERY_REWRITE_RESPONSE_FORMAT } from "./chat-grounding.js";

describe("needsContextualRewrite", () => {
  it("fires only on a short anaphoric turn WITH history", () => {
    expect(needsContextualRewrite("그거 언제 바뀌었지?", 2)).toBe(true);
    expect(needsContextualRewrite("when did that change?", 2)).toBe(true);
    expect(needsContextualRewrite("그거 언제 바뀌었지?", 0)).toBe(false);
  });

  it("stays quiet on a self-contained question — no wasted inference", () => {
    expect(needsContextualRewrite("회사 와이파이 비밀번호 뭐야?", 3)).toBe(false);
    expect(needsContextualRewrite("내일 오후 3시에 회의 일정 잡아줘", 3)).toBe(false);
  });
});

describe("buildQueryRewritePrompt", () => {
  it("carries the recent turns and the message, capped", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ content: `turn ${i.toString()}`, role: i % 2 === 0 ? "user" as const : "assistant" as const }));
    const prompt = buildQueryRewritePrompt(history, "그거 언제 바뀌었지?");
    expect(prompt).toContain("그거 언제 바뀌었지?");
    expect(prompt).toContain("turn 9");
    expect(prompt).not.toContain("turn 0");
  });
});

describe("parseQueryRewrite", () => {
  it("accepts the constrained JSON and falls back on anything else", () => {
    expect(parseQueryRewrite('{"query": "회사 와이파이 비밀번호 언제 바뀌었는지"}', "fallback")).toBe("회사 와이파이 비밀번호 언제 바뀌었는지");
    expect(parseQueryRewrite("not json", "fallback")).toBe("fallback");
    expect(parseQueryRewrite('{"query": ""}', "fallback")).toBe("fallback");
    expect(parseQueryRewrite(`{"query": "${"x".repeat(300)}"}`, "fallback")).toBe("fallback");
  });

  it("the response format constrains a single string field", () => {
    expect(QUERY_REWRITE_RESPONSE_FORMAT.required).toContain("query");
  });
});
