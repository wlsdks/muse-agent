# Loop journal — recall-spine

Theme: 개인 기억/회상 비서(golden path) 강화. 진안이 척추로 선택 (2026-06-22).
Two tracks: 능력 C↑ (회상이 맞는 기억을 꺼내 정확히 인용 + GROUNDED≠TRUE 메모리 방어 + 충돌/멀티홉) · 응집도 C+↑ (golden-path 명령만 남기고 루프-생성 명령 감사 · god-file commands-ask.ts 해체).
Cron `ffe5773d` (every 20m, session-only, Tier1 no-push). Worktree `/tmp/muse-recall-spine`, branch `loop/recall-spine`.

---

## fire 1 · 2026-06-23 · skill v2.1.0 · loop/recall-spine

meta: value-class=new-capability · pkg=scripts(eval-harness) · kind=eval-new · verdict=PASS · firesSinceDrill=1
ratchet: testFiles +1 (eval-recall-quality.test.mjs, picked up by `self-eval:test`) · fabrication 0 · NEW gate `eval:recall-quality` (live baseline **3/7 = 43%**, pass^3)

- **무엇**: 측정-먼저 슬라이스 — `scripts/eval-recall-quality.mjs` (개인 USER-MEMORY 회상 golden-set) + zero-dep `scripts/eval-recall-quality.test.mjs` (scorer teeth) + `package.json` `eval:recall-quality` 등록. 노트 배터리(verify-cited-recall/verify-multihop)가 안 다루는 두 차원을 새로 측정: (1) 한국어 USER-memory(사실/선호/목표) (2) 교정-인지 temporal(stale 과거값 vs 현재값 → 현재값이 이겨야, 정체성 "교정하면 잊음"). production `rankKnowledgeChunks→classifyRetrievalConfidence`를 실제 로컬 임베딩으로 구동, Ollama-down 시 loud skip.
- **왜**: 척추의 회상 능력 숫자를 아무도 몰랐다(스코어보드는 케이스 개수만 래칫). 이제 숫자가 있다.
- **리뷰 지점 (핵심 발견)**: 라이브 baseline = **3/7**. 직접 사실 회상 4건이 전부 `"ambiguous"`로 **under-recall** — 갖고 있는 사실인데 confidence bar(cosine 0.55, 노트용 calibration)를 못 넘어 "잘 모르겠어"로 회피. correction(현재값 승리) + abstain ×2는 PASS. 냉정 진단의 "거짓말 대신 거절로 faithfulness를 산다"의 하드 데이터. **fire 2 후보**: 짧은 개인-기억 항목용 confidence bar 재보정(또는 hit@1을 confidence와 분리 측정).
- **리스크**: eval이 positive를 `confident` 요구로 채점 → "맞게 검색했지만 abstain"도 miss로 잡힘(의도된 보수성; under-recall은 유저가 체감하는 실패). fire 2에서 hit@1(top이 맞았나)을 confidence와 분리하면 갭의 원인(검색 실패 vs 확신 실패)을 더 정밀히 가를 수 있음.
- 검증: `node --test` 8/8 GREEN + MUTATION 3분기 RED 확인(독립 ④b judge가 재현) · live pass^3 3/7 · scripts/*.mjs는 eslint ignore라 lint 게이트 영향 없음 · 독립 Opus ④b judge PASS(비중복·teeth·정직한 측정 확인).
