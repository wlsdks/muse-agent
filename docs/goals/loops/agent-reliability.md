# agent-reliability loop journal

Theme: agent-reliability 로드맵을 논문 근거로 계속 강화. cron `a1382000` (매시 :07, 세션 스코프). Tier1 (로컬 커밋, no push). Branch wlsdks/agent-reliability.

Queue: docs/strategy/agent-research-findings-2026.md (P1✓ P2✓ P3→) + docs/goals/backlog.md S5 egress 잔여(C3, C4) → self-scout.

---

## fire 1 · 2026-07-14 · NO-SHIP (rollback)
meta: value-class=security-hardening · pkg=@muse/agent-core+@muse/tools · kind=egress-confidentiality · verdict=FAIL(④b) · firesSinceDrill=1
ratchet: testFiles +0 (rolled back) · self-eval green(exit0, adversarialCases=35) · fabrication 0 · no commit of code

- **What:** S5 C4(a) 시도 — egress-candidate 콜의 비-URL 문자열 잎(header 값 등)에 confidentiality WARN. Sonnet 빌드: collectNonUrlLeaves(@muse/tools) + checkEgressConfidentiality(argDerivesFromCorpus 재사용) + executeToolCall 배선. mutation-first RED 확인됨, agent-core 1111/tools 244 green.
- **Why NO-SHIP:** 독립 Opus ④b가 MAJOR FAIL 판정 — 경고를 계산해 게이트 *입력*에 실었으나 세 게이트(channel/chat/board) 전부 read-risk면 allowed:true 조기반환하고 egressWarning을 deny 경로서만 소비 → headline(read-class fetch)이 사용자에게 무경고. 테스트는 게이트-입력 필드를 검사해 그 공백을 가림. backlog는 "SHIPPED"로 과대주장.
- **Review point:** 코드 자체는 건전(사이클 없음, WARN-never-block airtight, mutation-proven at seam) — efficacy+overclaim FAIL이지 로직 버그 아님. 롤백 후 재작업 스펙을 backlog에 기록(surface + de-noise + honest 마킹).
- **Risk:** 없음(전부 롤백, 트리 clean, self-eval green 유지).
- **lesson:** 보안/기능 슬라이스는 계산-only가 아니라 **surface된 OUTCOME**을 채점한다(게이트 입력 필드 assert = vacuous). 그리고 compute→surface를 **한 슬라이스로 end-to-end** 스코프하라 — seam만 배선하면 "미전달"(agent-testing.md #1)이고, 독립 judge가 정확히 그걸 잡는다. ④b maker≠judge 게이트가 제값을 함.
