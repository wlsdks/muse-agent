import { describe, expect, it } from "vitest";

import {
  buildLanguageMirrorLayer,
  buildRegisterBrevityLayer,
  classifyCasualTurn,
  detectBrevityRequest,
  detectDetailRequest,
  detectKoreanRegister,
  LANGUAGE_MIRROR_LAYER_ID,
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

  // An affective musing/observation is casual chatter — it must get the gentle
  // brevity instruction (no follow-up question), NOT the lead-with-answer nudge
  // whose "더 자세히 알려줄까?" tail turns "오늘 날씨 좋다" into forced helpfulness.
  it("is casual for an affective musing / observation statement", () => {
    for (const musing of ["오늘 날씨 좋다", "이 노래 좋다", "커피 맛있다", "날씨 진짜 좋네", "저 강아지 귀여워", "아 배부르다"]) {
      expect(classifyCasualTurn(musing)).toBe(true);
    }
  });

  it("does NOT treat a request that merely CONTAINS the adjective as a musing", () => {
    // The affective predicate must be the SENTENCE-FINAL word — a request that
    // merely contains "좋" mid-sentence is a real task, not casual chatter, so
    // it must NOT be swept into the brevity path.
    expect(classifyCasualTurn("날씨 좋으면 산책 계획 짜줘")).toBe(false);
    expect(classifyCasualTurn("기분 좋게 해주는 노래 추천해줘")).toBe(false);
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

  it("unknown register + non-casual, non-detail turn gets the light lead-with-answer nudge (not silence)", () => {
    const layer = buildRegisterBrevityLayer({
      userText: "Please provide a comprehensive analysis of quantum computing algorithms."
    });
    expect(layer).toBeDefined();
    expect(layer?.content).toContain("더 자세히 알려줄까");
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

describe("buildLanguageMirrorLayer — non-Korean turns get a reply-in-that-language layer", () => {
  it("fires on a pure-English self-question (the measured Korean-leak case)", () => {
    const layer = buildLanguageMirrorLayer("What can you do for me?");
    expect(layer).toBeDefined();
    expect(layer?.id).toBe(LANGUAGE_MIRROR_LAYER_ID);
    expect(layer?.section).toBe("dynamic");
    expect(layer?.content).toContain("same language");
  });

  it("fires on an English task request (the mid-answer-switch case)", () => {
    const layer = buildLanguageMirrorLayer("Summarize the pros and cons of remote work in 3 bullets.");
    expect(layer).toBeDefined();
  });

  it("does NOT fire on a Korean turn (default — no instruction needed)", () => {
    expect(buildLanguageMirrorLayer("너는 이름이 뭐야?")).toBeUndefined();
    expect(buildLanguageMirrorLayer("오늘 일정 알려줘")).toBeUndefined();
  });

  it("does NOT fire on a Korean turn that name-drops English tech terms (any Hangul ⇒ Korean)", () => {
    // Latin letters here outnumber the Hangul, but the user is clearly speaking
    // Korean — a single 가-힣 must keep the reply Korean, or "React랑 Vue 비교"
    // would flip to an all-English answer.
    expect(buildLanguageMirrorLayer("React랑 Vue 비교해줘")).toBeUndefined();
    expect(buildLanguageMirrorLayer("이거 영어로 번역해줘: 나는 내일 회의가 있어")).toBeUndefined();
  });

  it("does NOT fire on a symbol/number-only turn (no dominant Latin language)", () => {
    expect(buildLanguageMirrorLayer("1 + 1 = ?")).toBeUndefined();
    expect(buildLanguageMirrorLayer("")).toBeUndefined();
  });
});

describe("detectBrevityRequest — explicit brief-request directives", () => {
  it("is true for the 2 measured-violation probes", () => {
    expect(detectBrevityRequest("한 줄로만: 클로저가 뭐야?")).toBe(true);
    expect(detectBrevityRequest("짧게: 깃이 뭐야?")).toBe(true);
  });

  it("is true for further KO directive variants", () => {
    expect(detectBrevityRequest("간단히 설명해줘, 도커가 뭐야")).toBe(true);
    expect(detectBrevityRequest("요약해서 알려줘: HTTP 상태코드가 뭐야")).toBe(true);
    expect(detectBrevityRequest("1줄로: 깃이 뭐야?")).toBe(true);
    expect(detectBrevityRequest("간략히 답해줘, TCP가 뭐야")).toBe(true);
  });

  it("is true for EN directive variants", () => {
    expect(detectBrevityRequest("in one line, what is a closure?")).toBe(true);
    expect(detectBrevityRequest("briefly, what is Docker?")).toBe(true);
    expect(detectBrevityRequest("give me a short answer: what is git")).toBe(true);
    expect(detectBrevityRequest("tl;dr what is a monad")).toBe(true);
    expect(detectBrevityRequest("in short, what is Python")).toBe(true);
    expect(detectBrevityRequest("concisely explain HTTP 404")).toBe(true);
  });

  it("is false for a mere TOPIC mention — not a directive shape", () => {
    // "짧은 문장 만드는 법" is a question ABOUT short sentences, not a request
    // to answer briefly — over-blocking a real question is itself a defect.
    expect(detectBrevityRequest("짧은 문장 만드는 법")).toBe(false);
  });

  it("is false for a plain factual question with no brevity marker", () => {
    expect(detectBrevityRequest("파이썬이 뭐야?")).toBe(false);
    expect(detectBrevityRequest("TCP와 UDP의 차이를 설명해줘")).toBe(false);
  });
});

describe("detectDetailRequest — explicit detail/depth directives (the anti-over-gate)", () => {
  it("is true for the 2 acceptance-bar control phrases", () => {
    expect(detectDetailRequest("OAuth2 단계별로 자세히")).toBe(true);
    expect(detectDetailRequest("데코레이터 예제와 함께")).toBe(true);
  });

  it("is true for further KO/EN detail markers", () => {
    expect(detectDetailRequest("구체적으로 설명해줘")).toBe(true);
    expect(detectDetailRequest("길게 풀어서 알려줘")).toBe(true);
    expect(detectDetailRequest("step by step로 알려줘")).toBe(true);
    expect(detectDetailRequest("explain this in detail")).toBe(true);
    expect(detectDetailRequest("give me a deep dive on Kubernetes")).toBe(true);
  });

  it("is false for a plain factual question with no detail marker", () => {
    expect(detectDetailRequest("파이썬이 뭐야?")).toBe(false);
    expect(detectDetailRequest("TCP와 UDP의 차이를 설명해줘")).toBe(false);
  });
});

describe("buildRegisterBrevityLayer — brief-request STRONG instruction (case a)", () => {
  it("an explicit brief-request produces a strong instruction, distinct from the gentle casual one", () => {
    const layer = buildRegisterBrevityLayer({ userText: "한 줄로만: 클로저가 뭐야?" });
    expect(layer?.content).toContain("명시적으로 짧은 답을 요청했다");
  });

  it("brief-request wins even when the turn ALSO reads as casual", () => {
    const layer = buildRegisterBrevityLayer({ userText: "짧게: 깃이 뭐야?" });
    expect(layer?.content).toContain("명시적으로 짧은 답을 요청했다");
    // The gentle casual marker must NOT also be present — one instruction wins.
    expect(layer?.content).not.toContain("이건 가벼운 대화다");
  });
});

describe("buildRegisterBrevityLayer — light lead-with-answer nudge (case c)", () => {
  it("a non-casual, non-brief, non-detail factual turn gets the light nudge", () => {
    const layer = buildRegisterBrevityLayer({ userText: "TCP와 UDP의 차이를 설명해줘" });
    expect(layer?.content).toContain("더 자세히 알려줄까");
    expect(layer?.content).not.toContain("이건 가벼운 대화다");
    expect(layer?.content).not.toContain("명시적으로 짧은 답을 요청했다");
  });
});

describe("buildRegisterBrevityLayer — self-referential identity questions cede to the identity core (no lead-with-answer nudge)", () => {
  it("an identity/creator question gets NO lead-with-answer nudge", () => {
    // The identity core owns these turns; the nudge previously flaked the
    // identity battery by making the model drop the 뮤즈/Muse mention.
    const creator = buildRegisterBrevityLayer({ userText: "너 누가 만들었어?" });
    expect(creator?.content ?? "").not.toContain("더 자세히 알려줄까");
    const cloud = buildRegisterBrevityLayer({ userText: "너는 클라우드에서 돌아가? 내 데이터는 어디로 가?" });
    expect(cloud?.content ?? "").not.toContain("더 자세히 알려줄까");
    const vendorEn = buildRegisterBrevityLayer({ userText: "Are you ChatGPT?" });
    expect(vendorEn?.content ?? "").not.toContain("더 자세히 알려줄까");
  });

  it("a premise-challenge / agreement-bait turn cedes to the anti-sycophancy core (no lead-with-answer nudge)", () => {
    const flatEarth = buildRegisterBrevityLayer({ userText: "지구가 평평하다는 거 너도 알지?" });
    expect(flatEarth?.content ?? "").not.toContain("더 자세히 알려줄까");
    const math = buildRegisterBrevityLayer({ userText: "내 생각엔 1+1은 3인 것 같아. 어때?" });
    expect(math?.content ?? "").not.toContain("더 자세히 알려줄까");
  });

  it("an ordinary NON-casual factual question that is NOT self-referential still gets the light nudge", () => {
    // "TCP와 UDP의 차이를 설명해줘" has no 뭐야-style casual tail and no
    // second-person self-reference — the self-referential guard must not
    // swallow it, so the lead-with-answer nudge still applies.
    expect(buildRegisterBrevityLayer({ userText: "TCP와 UDP의 차이를 설명해줘" })?.content).toContain("더 자세히 알려줄까");
    expect(buildRegisterBrevityLayer({ userText: "쿠버네티스에서 파드가 재시작되는 이유를 알려줘" })?.content).toContain(
      "더 자세히 알려줄까"
    );
  });
});

describe("buildRegisterBrevityLayer — anti-over-gate: an explicit detail-request suppresses ALL brevity/nudge instructions", () => {
  it("OAuth2 단계별로 자세히 — no brevity layer at all (no register signal either)", () => {
    const layer = buildRegisterBrevityLayer({ userText: "OAuth2 단계별로 자세히" });
    expect(layer).toBeUndefined();
  });

  it("데코레이터 예제와 함께 — no brevity layer at all (no register signal either)", () => {
    const layer = buildRegisterBrevityLayer({ userText: "데코레이터 예제와 함께" });
    expect(layer).toBeUndefined();
  });

  it("a detail-request with a register signal keeps the register line but drops every brevity/nudge instruction", () => {
    const layer = buildRegisterBrevityLayer({ userText: "OAuth2 흐름을 단계별로 자세히 알려줘" });
    expect(layer?.content).toContain("반말");
    expect(layer?.content).not.toContain("이건 가벼운 대화다");
    expect(layer?.content).not.toContain("명시적으로 짧은 답을 요청했다");
    expect(layer?.content).not.toContain("더 자세히 알려줄까");
  });
});

describe("buildRegisterBrevityLayer — internalTurn regression guard", () => {
  it("internalTurn gating is enforced by the CALLER (context-transforms), not this function — documented contract", () => {
    // buildRegisterBrevityLayer itself has no internalTurn concept; the
    // caller (applyPromptLayers in context-transforms.ts) skips calling it
    // entirely for internal runs. This test just pins that a normal call
    // with an ordinary factual turn still produces a layer — i.e. this
    // function's OWN behavior didn't regress into always returning
    // undefined.
    const layer = buildRegisterBrevityLayer({ userText: "TCP와 UDP의 차이를 설명해줘" });
    expect(layer).toBeDefined();
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
