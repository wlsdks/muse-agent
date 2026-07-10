import { describe, expect, it } from "vitest";
import { classifyRequestPrivacy, explainRequestPrivacy, findPii, resolvePrivacyRoutedModel } from "../src/index.js";

const OFF_ENV = {} as const;
const ROUTING_ON_ENV = { MUSE_CLOUD_MODEL: "gemini/gemini-2.5-flash", MUSE_PRIVACY_ROUTING: "true" } as const;

describe("classifyRequestPrivacy — PII", () => {
  it("classifies a PII-bearing query as personal via piiDetected, even with routing signals absent", () => {
    // Synthetic test fixture — not a real person's data.
    const query = "Please process this for me: SSN 123-45-6789, email test@example.com.";
    const piiDetected = findPii(query).length > 0;
    expect(piiDetected).toBe(true);
    expect(classifyRequestPrivacy({ hasPersonalContext: false, piiDetected, query })).toBe("personal");
  });

  it("stays personal even when the query text itself has no possessive marker", () => {
    const query = "SSN 123-45-6789";
    expect(findPii(query).length).toBeGreaterThan(0);
    expect(classifyRequestPrivacy({ hasPersonalContext: false, piiDetected: true, query })).toBe("personal");
  });
});

describe("classifyRequestPrivacy — KO possessive markers", () => {
  it.each([
    "내 일정 정리해줘",
    "나의 주치의가 누구지",
    "제 이름은 뭐야",
    "저의 취미를 알려줘",
    "우리 집 주소가 뭐였지"
  ])("%s → personal", (query) => {
    expect(classifyRequestPrivacy({ hasPersonalContext: false, query })).toBe("personal");
  });

  it.each([
    "내일 날씨 어때",
    "안내문 번역해줘",
    "제안서 초안을 써줘",
    "제품 설명을 요약해줘"
  ])("%s → context-free (KO false-positive control)", (query) => {
    expect(classifyRequestPrivacy({ hasPersonalContext: false, query })).toBe("context-free");
  });
});

describe("classifyRequestPrivacy — EN possessive markers", () => {
  it.each([
    "summarize my notes",
    "what's mine here",
    "remind myself to call the bank",
    "translate this for me",
    "what's our plan for tonight"
  ])("%s → personal", (query) => {
    expect(classifyRequestPrivacy({ hasPersonalContext: false, query })).toBe("personal");
  });

  it.each([
    "summarize this article",
    "translate hello to french",
    "what's the weather in Seoul",
    "write a haiku about autumn"
  ])("%s → context-free (EN false-positive control)", (query) => {
    expect(classifyRequestPrivacy({ hasPersonalContext: false, query })).toBe("context-free");
  });
});

describe("classifyRequestPrivacy — memory values", () => {
  it("a query referencing a remembered fact is personal even with no possessive marker", () => {
    expect(
      classifyRequestPrivacy({
        hasPersonalContext: false,
        memoryValues: ["Dr. Kim"],
        query: "Dr. Kim 예약 언제야"
      })
    ).toBe("personal");
  });

  it("ignores memory values shorter than 2 characters after trim", () => {
    expect(
      classifyRequestPrivacy({
        hasPersonalContext: false,
        memoryValues: ["a", " "],
        query: "what is a good book about a cat"
      })
    ).toBe("context-free");
  });

  it("names the matched memory value in the reason", () => {
    const result = explainRequestPrivacy({
      hasPersonalContext: false,
      memoryValues: ["Dr. Kim"],
      query: "Dr. Kim 예약 언제야"
    });
    expect(result.reason).toContain("Dr. Kim");
  });
});

describe("classifyRequestPrivacy — hasPersonalContext", () => {
  it("is personal regardless of query text when hasPersonalContext is true", () => {
    expect(
      classifyRequestPrivacy({ hasPersonalContext: true, query: "translate hello to french" })
    ).toBe("personal");
  });
});

describe("explainRequestPrivacy — reasons name their signal", () => {
  it("names hasPersonalContext", () => {
    expect(explainRequestPrivacy({ hasPersonalContext: true, query: "hi" }).reason).toContain("personal context");
  });

  it("names PII", () => {
    expect(
      explainRequestPrivacy({ hasPersonalContext: false, piiDetected: true, query: "hi" }).reason
    ).toContain("PII");
  });

  it("names the query marker", () => {
    expect(
      explainRequestPrivacy({ hasPersonalContext: false, query: "summarize my notes" }).reason
    ).toContain("my");
  });
});

describe("resolvePrivacyRoutedModel — off by default (byte-identical to today)", () => {
  it("routes local when MUSE_PRIVACY_ROUTING is unset", () => {
    const result = resolvePrivacyRoutedModel({
      defaultModel: "ollama/gemma4:12b",
      env: OFF_ENV,
      hasPersonalContext: false,
      query: "translate hello to french"
    });
    expect(result).toEqual({
      model: "ollama/gemma4:12b",
      reason: "privacy routing is off (MUSE_PRIVACY_ROUTING not set)",
      route: "local"
    });
  });

  it("routes local when MUSE_CLOUD_MODEL is not configured, even with routing on", () => {
    const result = resolvePrivacyRoutedModel({
      defaultModel: "ollama/gemma4:12b",
      env: { MUSE_PRIVACY_ROUTING: "true" },
      hasPersonalContext: false,
      query: "translate hello to french"
    });
    expect(result.route).toBe("local");
    expect(result.model).toBe("ollama/gemma4:12b");
  });
});

describe("resolvePrivacyRoutedModel — MUSE_LOCAL_ONLY is absolute", () => {
  it("never routes to cloud when MUSE_LOCAL_ONLY is set, even with routing on + context-free query", () => {
    const result = resolvePrivacyRoutedModel({
      defaultModel: "ollama/gemma4:12b",
      env: { ...ROUTING_ON_ENV, MUSE_LOCAL_ONLY: "true" },
      hasPersonalContext: false,
      query: "translate hello to french"
    });
    expect(result.route).toBe("local");
    expect(result.model).toBe("ollama/gemma4:12b");
    expect(result.reason).toContain("MUSE_LOCAL_ONLY");
  });

  it("MUSE_LOCAL_ONLY wins even when the query is unambiguously context-free", () => {
    for (const query of ["what's the weather in Seoul", "translate hello to french", "write a haiku"]) {
      const result = resolvePrivacyRoutedModel({
        defaultModel: "ollama/gemma4:12b",
        env: { ...ROUTING_ON_ENV, MUSE_LOCAL_ONLY: "1" },
        hasPersonalContext: false,
        query
      });
      expect(result.route).toBe("local");
    }
  });
});

describe("resolvePrivacyRoutedModel — cloud only on (routing ON ∧ context-free)", () => {
  it("routes to MUSE_CLOUD_MODEL for a context-free query when routing is on", () => {
    const result = resolvePrivacyRoutedModel({
      defaultModel: "ollama/gemma4:12b",
      env: ROUTING_ON_ENV,
      hasPersonalContext: false,
      query: "translate hello to french"
    });
    expect(result).toEqual({
      model: "gemini/gemini-2.5-flash",
      reason: "context-free request routed to cloud (no personal-context, PII, memory, or possessive signal detected)",
      route: "cloud"
    });
  });

  it("keeps a personal query local even with routing fully on", () => {
    const result = resolvePrivacyRoutedModel({
      defaultModel: "ollama/gemma4:12b",
      env: ROUTING_ON_ENV,
      hasPersonalContext: false,
      query: "summarize my notes"
    });
    expect(result.route).toBe("local");
    expect(result.model).toBe("ollama/gemma4:12b");
    expect(result.reason).toContain("personal request kept local");
  });

  it("keeps hasPersonalContext local even with routing fully on", () => {
    const result = resolvePrivacyRoutedModel({
      defaultModel: "ollama/gemma4:12b",
      env: ROUTING_ON_ENV,
      hasPersonalContext: true,
      query: "translate hello to french"
    });
    expect(result.route).toBe("local");
  });

  it("keeps a PII-bearing query local even with routing fully on", () => {
    const query = "SSN 123-45-6789";
    const result = resolvePrivacyRoutedModel({
      defaultModel: "ollama/gemma4:12b",
      env: ROUTING_ON_ENV,
      hasPersonalContext: false,
      piiDetected: findPii(query).length > 0,
      query
    });
    expect(result.route).toBe("local");
  });
});
