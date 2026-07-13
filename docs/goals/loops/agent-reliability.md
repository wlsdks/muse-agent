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

## fire 2 · 2026-07-14 · <commit-pending>
meta: value-class=security-hardening · pkg=@muse/stores+@muse/proactivity · kind=consent-lifecycle · verdict=PASS(④b one-line fix) · firesSinceDrill=2
ratchet: testFiles +0 (extended existing) · stores 560+SECURITY / proactivity 270 · self-eval green(exit0) · fabrication 0
- **What:** Standing-objective scoped consent에 optional expiresAt(TTL). 만료된 consent는 findConsent/hasConsent에서 absent처럼 필터(중앙화, 모든 소비자 커버) → performConsentedAction fail-closed, 자격증명 미해결·HTTP 없음. proposed-action-store 선례 미러. arXiv:2605.11360(ConLeash) / OWASP ASI 2026 time-bound.
- **Why:** 부여된 consent가 영구 인가 = least-privilege 위반. 다양성 RATCHET: fire 1(agent-core/egress)과 다른 (stores+proactivity/consent-lifecycle)로 전환. 앞선 scout에서 eval:tools(covered)·P4(clean) 2 vein이 마름 → consent TTL로 pivot.
- **Review point:** ④b 독립 Opus가 MAJOR fail-open 적발 — isConsentActive가 파싱불가 expiresAt를 ACTIVE(영구인가)로 취급(선례 맹목 미러). 자격증명 게이트는 fail-close여야 → `!Number.isNaN(expiry) && …`로 수정 + SECURITY 테스트 추가(손상 timestamp는 findConsent undefined). 뮤테이션으로 load-bearing 확인(fail-open 복원 시 RED). Findings 2-6은 PASS(live enforcement로 fire 1과 범주 다름·back-compat·비-vacuous).
- **Risk:** grant call-site가 아직 expiresAt 미설정(enforcement live, 부여 UX 후속) — dormant 아님(어떤 경로로든 expiresAt 있으면 즉시 enforce). back-compat: expiresAt 없는 기존 consent는 byte-identical.
- **lesson:** 선례 미러는 위험프로파일이 같을 때만 — proposed-action의 "unparseable⇒inert"를 credential-authorization에 그대로 옮기면 fail-OPEN. 보안 게이트의 fail 방향은 항상 독립 검증하라(④b가 정확히 잡음). 그리고 scout가 vein 고갈(eval:tools·P4)을 만나면 spin/pad 말고 다른 (pkg,kind)로 즉시 전환 = fire 2가 실제로 ship한 이유.

## fire 3 · 2026-07-14 · <commit-pending>
meta: value-class=measurement-tooling · pkg=scripts/eval-harness · kind=brief-cot-ab · verdict=PASS(④b) · firesSinceDrill=3
ratchet: testFiles +0 (extended eval-harness.test) · harness det-test 41/41 · fabrication 0 · live A/B running(local, no budget)
- **What:** P3 measure-first — eval:tools에 opt-in brief-reasoning arm(MUSE_EVAL_BRIEF_COT). 순수 briefCotSystemSection + buildToolSelectionMessages(eval-harness.mjs, 유닛테스트됨), flag unset이면 message array byte-identical(deep-equal 베이스라인 테스트). 어댑터/thinking-param 무변경 — 프롬프트-프리픽스로만 측정. arXiv:2604.02155.
- **Why:** brief-CoT가 gemma4 툴선택을 돕는지 측정-우선(논문만으로 기본 안 바꿈). 다양성: fire 1(agent-core/egress)·fire 2(stores/consent)와 다른 (scripts/measurement-tooling)로 전환 — 모노컬처(security 2연속) 탈출. termination·eval:tools IrrelAcc·P4는 scout서 covered/clean 확인, C3/C4는 design-heavy-3rd-security라 defer(backlog decompose 유지).
- **Review point:** ④b Opus PASS — byte-identical-off를 실제 옛 소스와 대조 검증(eval:tools 게이트 무회귀), ON이 provider.generate 도달(fire-1 drop 아님), production reach 0. Finding 6(tautological RED-proof 테스트) 정리-삭제. 라이브 A/B는 로컬 Ollama라 예산 무관, 백그라운드 실행.
- **Risk:** finding(측정치)이 이 fire 커밋엔 미포함 — 계측 도구는 즉시 사용가능(usable now, dead infra 아님), A/B 결과는 백그라운드 완료 시 P3 doc에 기록. measure-before-build로 P3a(어댑터) premature 회피.

### fire 3 · FINDING (live A/B completed)
brief-CoT A/B measured (gemma4:12b, repeat=1): baseline(thinking-off) 374/376=99% vs brief-CoT 373/376=99% → NEUTRAL/미세 손해. 베이스라인 포화(99%)로 헤드룸 無 → thinking-off 기본값 데이터-확증, P3a 어댑터 모드 안 만듦(dead infra 회피). lesson: 논문 이득도 자기 베이스라인이 이미 포화면 transfer 안 됨 — measure-first가 premature infra를 정확히 막음.
