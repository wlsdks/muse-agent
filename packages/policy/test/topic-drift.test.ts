import { describe, expect, it } from "vitest";
import { detectTopicDrift } from "../src/index.js";

describe("topic drift policy", () => {
  it("allows prompts that overlap with configured topic keywords", () => {
    expect(
      detectTopicDrift("Compare RAG retrieval with memory trimming", {
        allowedTopics: [
          {
            id: "muse-runtime",
            keywords: ["rag", "retrieval", "memory", "agent"]
          }
        ]
      })
    ).toMatchObject({
      allowed: true,
      matchedTopicId: "muse-runtime"
    });
  });

  it("blocks prompts that drift away from all configured topics", () => {
    expect(
      detectTopicDrift("Book flights to Paris and find hotel discounts", {
        allowedTopics: [
          {
            id: "muse-runtime",
            keywords: ["rag", "retrieval", "memory", "agent"]
          }
        ]
      })
    ).toEqual({
      allowed: false,
      bestScore: 0,
      matchedKeywords: [],
      matchedTopicId: null,
      reason: "Prompt drifted outside allowed topics: muse-runtime"
    });
  });

  it("uses Korean tokens and explicit off-topic allowances", () => {
    expect(
      detectTopicDrift("이관 작업의 다음 우선순위를 정리해줘", {
        allowedTopics: [{ id: "migration", keywords: ["마이그레이션", "이관", "우선순위"] }]
      }).allowed
    ).toBe(true);
    expect(
      detectTopicDrift("감사합니다", {
        allowedOffTopicKeywords: ["감사합니다"],
        allowedTopics: [{ id: "migration", keywords: ["마이그레이션", "이관"] }]
      }).allowed
    ).toBe(true);
  });
});
