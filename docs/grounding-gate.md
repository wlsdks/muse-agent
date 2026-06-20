---
title: 그라운딩 게이트 — Muse의 핵심 엣지, 한 흐름으로
audience: [AI 에이전트, 개발자]
purpose: Muse의 grounding+citation 게이트가 질문 하나를 어떻게 처리하는지 end-to-end로 — 멘탈 모델용
updated: 2026-06-20
related: [feature-catalog/02-knowledge-rag.md, glossary.md, SYSTEM-MAP.md]
---

# 그라운딩 게이트 — 한 흐름으로

Muse의 정체성 한 줄은 **"네 거에서 답하고, 출처를 인용하고, 모르면 모른다고 한다"**이다. 그걸
강제하는 결정적 코드가 **그라운딩 게이트**다. 이 문서는 *질문 하나가 게이트를 어떻게 통과하는지*를
한 흐름으로 보여준다(멘탈 모델용). 심볼·테스트 단위 증거는 [feature-catalog/02](feature-catalog/02-knowledge-rag.md),
용어는 [glossary](glossary.md).

> 핵심: 게이트는 **모델 호출이 아니라 결정적 코드**다(`verifyGrounding`,
> `packages/agent-core/src/knowledge-recall.ts`). 그래서 모델이 아무리 그럴듯하게 지어내도 *코드가*
> 드롭한다 — "fabrication = 0"이 부탁이 아니라 게이트인 이유.

## 흐름 (한 질문이 거치는 7단계)

```
질문 ─▶ ① 검색 ─▶ ② 신뢰도 분류 ─▶ ③ 초안 생성 ─▶ ④ 4-기준 루브릭 채점
                                                        │
                                          ⑤ 3-way 판정 (fail-close)
                                          ├─ grounded   ─▶ ⑥ 인용 붙여 제시 (+ 영수증)
                                          ├─ weak       ─▶ ⑥ "잘 모르겠다" 프레이밍
                                          └─ ungrounded ─▶ ⑦ 드롭 (답을 내보내지 않음)
```

1. **검색** — knowledge corpus(노트+할일+캘린더+메모리+에피소드…)에서 질문에 가까운 청크를 cosine으로
   가져온다. 각 청크는 소스-태그(`note/2026-06-01`, `task/42` …)를 단다.
2. **신뢰도 분류** — `classifyRetrievalConfidence`가 절대 cosine으로 `confident`(1) / `ambiguous`(0.5) /
   `none`(0)을 매긴다(CRAG식). 임계값 `DEFAULT_CONFIDENT_AT`.
3. **초안 생성** — 로컬 모델이 *검색된 근거만* 갖고 답 초안을 쓴다.
4. **4-기준 루브릭 채점**(결정적):
   - `confidence` — 위 검색 신뢰도.
   - `coverage` — 답변 내용 토큰 중 근거에 실제로 있는 비율 (바닥 `0.5`).
   - `answerability` — 질문 토큰 중 근거가 덮은 비율 (바닥 `0.34`).
   - `citationValidity` — 답이 인용한 소스가 *실제 검색된* 것인지 (위조 인용 1개면 즉시 탈락).
5. **3-way 판정** (fail-close 순서, knowledge-recall.ts):
   1. 검색 `none` → **ungrounded** ("근거 없음")
   2. 위조 인용 있음 → **ungrounded** ("검색되지 않은 소스를 인용")
   3. `coverage < 0.5` → **ungrounded** ("근거가 지지하지 않는 주장")
   4. `confident` AND `answerability ≥ 0.34` → **grounded**
   5. 그 외 → **weak**
6. **제시** — grounded면 인용(영수증)을 붙여 답한다. weak면 "잘 모르겠다" 프레이밍으로 낮춰 답한다.
7. **드롭** — ungrounded면 답을 *내보내지 않는다*. 지어낸 답이 사용자에게 닿지 않는다.

## 예시 A — grounded (근거 충분 → 인용 붙여 답)

- **노트**(`note/2026-06-10`): "치과 예약 6월 22일 오후 3시, 강남 화이트치과."
- **질문**: "치과 언제였지?"
- **채점**: 검색 confident, coverage 높음(답의 "6월 22일 오후 3시"가 근거에 그대로), answerability 충족,
  인용 valid → **grounded**.
- **출력**: "6월 22일 오후 3시 강남 화이트치과예요. [출처: note/2026-06-10]"

## 예시 B — ungrounded (근거 초과 → 드롭)

- 같은 노트, **질문**: "치과 의사 이름이 뭐였지?"
- **채점**: 근거에 의사 *이름*이 없다. 모델이 그럴듯한 이름을 지어내도 `coverage`가 바닥 아래 →
  **ungrounded** ("근거가 지지하지 않는 주장").
- **출력**: 지어낸 이름은 **드롭**. "그건 노트에 없어서 잘 모르겠어요"로 격하.

## 게이트를 떠받치는 보조 층 (전부 결정적, agent-core/recall)

- **best-of-N** (`selectBestGroundedDraft`) — 여러 초안 중 **grounded 생존자만** 채택("weak"은 안 됨) →
  fabrication 없이 답변율↑. `muse ask --best-of`.
- **문장 단위 진단** (`reportSentenceGroundedness`) — 문장별 supported/unsupported + **polarity·numeric·
  hedge-overclaim 불일치** 가드(토큰 겹침만으론 부정 모순을 놓침).
- **챗 경로 패리티** (`gateChatAnswer`) — 챗에도 같은 게이트 + 인용 정밀/재현(ALCE) + `untrustedOnly`
  (외부 `trusted:false` 소스에만 기댄 답 경고) + 값-드리프트 거부(이메일/ID/IP).
- **재검증** (`verifyGroundingWithReverify`) — 옵션: 모델-기반 k-sample 자기일관성(만장일치 PASS).

## 왜 이게 엣지인가 (grounded ≠ true)

게이트는 *주장↔소스 일치*를 본다 — **소스의 진위는 아니다.** 오염된 노트가 들어오면 "확신에 찬
그라운디드 거짓"이 가능하다(알려진 한계, [glossary](glossary.md)의 `grounded ≠ true`). 그래서 Muse는
출처 신뢰(`trusted:false`)·노트 간 모순(`semanticConflict`)·값 드리프트를 *추가로* 표시한다. 모든 새
표면(recall·proactivity·reflection·vision)은 이 게이트 아래를 지나야 하고, 그라운디드 표면 수는 절대
줄지 않는다(릴리스 게이트 `precheck:grounding`).
