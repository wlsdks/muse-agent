import { describe, expect, it } from "vitest";

import {
  buildRegisterBrevityLayer,
  classifyCasualTurn,
  detectKoreanRegister,
  REGISTER_BREVITY_LAYER_ID
} from "../src/index.js";

describe("detectKoreanRegister — the 5 measured probes", () => {
  it("classifies each measured 반말 probe as 반말", () => {
    expect(detectKoreanRegister("야 오늘 뭐하지")).toBe("반말");
    expect(detectKoreanRegister("뭐 좀 물어볼게")).toBe("반말");
    expect(detectKoreanRegister("밥 뭐 먹을까?")).toBe("반말");
  });

  it("classifies the 존댓말 control probe as 존댓말", () => {
    expect(detectKoreanRegister("오늘 일정 알려주세요")).toBe("존댓말");
  });
});

describe("detectKoreanRegister — edge cases", () => {
  it("고마워 (반말 thanks) vs 감사합니다 (존댓말 thanks)", () => {
    expect(detectKoreanRegister("고마워")).toBe("반말");
    expect(detectKoreanRegister("감사합니다")).toBe("존댓말");
  });

  it("English-only text is unknown (no Hangul signal)", () => {
    expect(detectKoreanRegister("What time is it?")).toBe("unknown");
    expect(detectKoreanRegister("thanks")).toBe("unknown");
  });

  it("empty/whitespace-only text is unknown", () => {
    expect(detectKoreanRegister("")).toBe("unknown");
    expect(detectKoreanRegister("   ")).toBe("unknown");
  });

  it("a bare noun with no verb-ending or vocative signal is unknown", () => {
    expect(detectKoreanRegister("사과")).toBe("unknown");
  });

  it("mixed EN+KO text still classifies off the Korean ending", () => {
    expect(detectKoreanRegister("hello 오늘 뭐하지")).toBe("반말");
  });

  it("a question mark doesn't block ending detection", () => {
    expect(detectKoreanRegister("점심 뭐 먹었어?")).toBe("반말");
    expect(detectKoreanRegister("점심 드셨어요?")).toBe("존댓말");
  });

  it("a trailing 반말 predicate wins even after a polite-sounding opener", () => {
    expect(detectKoreanRegister("정말요? 그거 해줄래")).toBe("반말");
  });
});

describe("classifyCasualTurn — the measured brevity probes", () => {
  it("is casual for the two measured over-verbose probes", () => {
    expect(classifyCasualTurn("심심해")).toBe(true);
    expect(classifyCasualTurn("파이썬이 뭐야?")).toBe(true);
  });

  it("is casual for the register-defect probes too (short small talk)", () => {
    expect(classifyCasualTurn("야 오늘 뭐하지")).toBe(true);
    expect(classifyCasualTurn("뭐 좀 물어볼게")).toBe(true);
    expect(classifyCasualTurn("밥 뭐 먹을까?")).toBe(true);
  });

  it("is NOT casual for a legitimately long request, however short the sentence", () => {
    expect(classifyCasualTurn("이 코드 리뷰해줘, 500줄이야")).toBe(false);
  });

  it("the substantial-request marker wins even when the tail ALSO matches a casual pattern", () => {
    // Ends in "뭐 먹을까" (would match the casual-decision pattern on its own),
    // but names its own scale ("코드"/"500줄"/"분석") — the substantial marker
    // must override the casual tail match, not just guard the bare cases.
    expect(classifyCasualTurn("코드 500줄 분석하고 나서 뭐 먹을까")).toBe(false);
  });

  it("is NOT casual for a long/complex turn beyond the length ceiling", () => {
    const long = "이 프로젝트의 아키텍처를 처음부터 끝까지 아주 자세히 설명해줘. 특히 데이터베이스 스키마와 API 설계까지 전부 다뤄줘.";
    expect(classifyCasualTurn(long)).toBe(false);
  });

  it("is NOT casual for an empty string", () => {
    expect(classifyCasualTurn("")).toBe(false);
  });
});

describe("buildRegisterBrevityLayer", () => {
  it("반말 input produces a layer instructing 반말 mirroring", () => {
    const layer = buildRegisterBrevityLayer({ userText: "야 오늘 뭐하지" });
    expect(layer).toBeDefined();
    expect(layer?.id).toBe(REGISTER_BREVITY_LAYER_ID);
    expect(layer?.section).toBe("dynamic");
    expect(layer?.content).toContain("반말");
  });

  it("존댓말 input produces a layer instructing 존댓말", () => {
    const layer = buildRegisterBrevityLayer({ userText: "오늘 일정 알려주세요" });
    expect(layer?.content).toContain("존댓말을 유지하라");
  });

  it("unknown register with a non-casual turn adds no layer at all", () => {
    const layer = buildRegisterBrevityLayer({
      userText: "Please provide a comprehensive analysis of quantum computing algorithms."
    });
    expect(layer).toBeUndefined();
  });

  it("an explicit persona register WINS over a conflicting detected register", () => {
    // The text reads as 존댓말 (세요 ending) but persona.md says 반말 — persona wins.
    const layer = buildRegisterBrevityLayer({ personaRegister: "반말", userText: "오늘 일정 알려주세요" });
    expect(layer?.content).toContain("반말");
    expect(layer?.content).not.toContain("존댓말을 유지하라");
  });

  it("persona register fills in when detection is unknown (English text)", () => {
    const layer = buildRegisterBrevityLayer({ personaRegister: "반말", userText: "What time is it?" });
    expect(layer?.content).toContain("반말");
  });

  it("a casual turn adds the brevity instruction even with no register signal", () => {
    const layer = buildRegisterBrevityLayer({ userText: "파이썬이 뭐야?" });
    expect(layer?.content).toContain("1~2문장");
  });

  it("a non-casual, long request adds no brevity instruction (no over-gating)", () => {
    const layer = buildRegisterBrevityLayer({ userText: "이 코드 리뷰해줘, 500줄이야" });
    // No 존댓말/반말 ending signal here either ("줄이야" -> 반말 ending "야"),
    // so the register line fires but brevity must NOT.
    expect(layer?.content).not.toContain("1~2문장");
  });
});

describe("해체 endings (-해/-줘/-돼/-봐) are 반말 — the adversarial gate found these missing", () => {
  const banmal = ["심심해", "사랑해", "그거 해줘", "이거 왜 안 돼?", "한번 봐줘", "빨리 와", "이거 좀 도와줘"];
  for (const text of banmal) {
    it(`detects 반말 in "${text}"`, () => {
      expect(detectKoreanRegister(text)).toBe("반말");
    });
  }

  it("does NOT swallow 존댓말 that contains the same stems", () => {
    expect(detectKoreanRegister("이거 해주세요")).toBe("존댓말");
    expect(detectKoreanRegister("한번 봐주시겠어요?")).toBe("존댓말");
    expect(detectKoreanRegister("도와주실 수 있나요?")).toBe("존댓말");
    expect(detectKoreanRegister("안 됩니다")).toBe("존댓말");
  });
});
