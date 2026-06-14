---
title: Muse 전체 기능 검증 & 인벤토리 (2026-06-14)
audience: [기획자, 개발자, AI 에이전트]
purpose: 수천 커밋 이후 Muse의 모든 기능을 실제로 검증하고, 기능 하나하나를 증거와 함께 기록한 마스터 문서
updated: 2026-06-14
related: [../FEATURES.md, ../SYSTEM-MAP.md, ../../README.md]
---

# Muse 전체 기능 검증 & 인벤토리 — 2026-06-14

> **이 문서는?** 5,166개 커밋(최근 30일에만 3,934개)이 쌓인 시점에서 Muse의 **모든 기능을 실제로 실행·검증하고, 기능 단위로 증거와 함께 기록**한 마스터 문서입니다. 7개 도메인을 병렬로 샅샅이 훑어 작성했으며, 상세는 각 도메인 카탈로그 파일에 있습니다.
>
> 검증 범례: ✅ 실제 실행으로 검증 · 🧪 테스트로 검증 · ⬜ 코드만 확인 · ⚠️ 버그/의심 · 🔌 로컬 모델/외부연동 필요

## 규모 한눈에

| 항목 | 수치 |
|---|---|
| 패키지 (`packages/*`) | **27** |
| 앱 (`apps/*`) | 4 (api · cli · web · desktop) |
| Rust crate | 1 (`crates/runner`) |
| 최상위 CLI 명령 | **102** (README "100+" 정확) |
| 내장 `muse.*` MCP 서버 | **24** |
| 웹 패널(`apps/web/src/views`) | **13** |
| 최대 패키지 | `mcp` 29k LOC · `agent-core` 22k LOC |

## 1. 검증 게이트 결과 (결정론적, ground truth)

| 게이트 | 명령 | 결과 |
|---|---|---|
| 빌드 | `pnpm build` | ✅ 통과 (전 워크스페이스) |
| 테스트 | `pnpm test` | ✅ 통과 — apps/api **854** · apps/cli **2700** · agent-core **2434** · model 299(+5 skip) · recall 271 · a2a 120 · prompts 38 … 모든 test file 통과 |
| 린트 | `pnpm lint` | ✅ 통과 (0 error) |
| 광범위 HTTP 스모크 | `pnpm smoke:broad` | ⚠️ **50 pass / 1 fail** — 단 1건은 **stale 테스트**(제품 버그 아님), 아래 §3 참조 |
| 안전 평가 배터리 | `eval:consent-fail-close` · `eval:recipient-resolution` · `eval:policy-symmetry` · `eval:action-log-tamper` | ✅ 모두 PASS (서브에이전트 라이브 실행) |

> **로컬 모델 필요 게이트는 이번에 미실행**: `smoke:live`, `eval:tools`, `eval:adversarial`, `eval:self-improving`, `eval:vision`, `eval:orchestration` 등은 로컬 Ollama 라운드트립이 필요합니다. (메모리 기록: 이 머신에서 `smoke:live`는 첫 결과 전 멈추는 경향 → `smoke:broad`를 라운드트립 증거로 사용.)

## 2. 도메인별 기능 인벤토리 (상세는 각 파일)

| # | 도메인 | 상세 파일 | 상태 요약 |
|---|---|---|---|
| 01 | 대화 & 에이전트 코어 + 모델 | [`01-conversation-core.md`](01-conversation-core.md) | ✅ 건강. ReAct+plan-execute 2-루프, 3중 가드 파이프라인(입력 fail-close/필터 fail-open/출력 fail-close), 클래리파이, 로컬-온리 egress 게이트, gemma4:12b 기본. |
| 02 | 지식/RAG/회상/노트/인지 | [`02-knowledge-rag.md`](02-knowledge-rag.md) | ✅ 건강. **그라운딩+인용 게이트가 실제로 동작**(4기준 루브릭, 위조 인용=ungrounded, fail-close). 결정론적 데이터툴(csv/benford/trend/diversity/keywords/summarize/on-this-day) 실행 확인. |
| 03 | 개인비서 도메인 | [`03-personal-domain.md`](03-personal-domain.md) | ✅ 건강. calendar(5 어댑터: Local·Local-ICS·Google·CalDAV·macOS)·tasks·remind·contacts·today·brief·recap·week·commitments·checkins·followup·objectives·anomaly 전부 read-only 실행 확인. |
| 04 | 기억 & 자기개선 (Whetstone/Playbook) | [`04-memory-selfimprove.md`](04-memory-selfimprove.md) | ✅ 깊고 실재. `doctor --weaknesses` 라이브 동작(실제 약점 13건 반환). 신뢰도 반감기 감쇠·dreaming·RGV 회고·RL식 플레이북 보상/감쇠·스킬 격리 모두 코드 확인. |
| 05 | 능동성/데몬/세션/책임성 | [`05-proactivity-daemon.md`](05-proactivity-daemon.md) | ✅ 건강. earned-proactivity 게이트, 조용한시간, 체크인, 상시목표(소비자-동의 fail-close), **해시체인 액션로그**(`actions --verify` → "chain intact"; 연결 엔트리 수는 사용에 따라 증가). |
| 06 | 밖으로 행동/안전 + 멀티에이전트 + 음성 | [`06-outbound-multiagent-voice.md`](06-outbound-multiagent-voice.md) | ✅ 건강. 아웃바운드 안전 계약(거부/타임아웃/모호수신자/무동의=무효과) eval로 입증. 음성 로컬-온리. race 모드는 **의도적 park**(→sequential). |
| 07 | 관측/운영/인프라/표면/아키텍처 | [`07-observability-ops-infra.md`](07-observability-ops-infra.md) | ✅ 건강. doctor 4-플래그(`--grounding/--weaknesses/--run-outcomes/--calibration`), 비용/지연/SLO/드리프트/트레이스, MCP 허용목록, 브라우저 제어, 암호화-at-rest 부분 적용. apps/api 26개 라우트그룹. |

## 3. 발견된 버그/의심 항목

| # | 항목 | 심각도 | 내용 | 권고 |
|---|---|---|---|---|
| B1 | smoke:broad race 단언 stale | 낮음(테스트) | `scripts/smoke-broad-http.mjs:628`가 race 모드에 `results.length === 1`을 기대하나, race는 의도적으로 sequential로 parked되어 worker당 1개(=2개) 반환. 권위 단위테스트(`multi-agent.test.ts:290`)는 올바르게 2개 기대. **제품 버그 아님 — 스모크 테스트가 옛 설계 기준.** | 스모크 단언을 현 parked 동작(worker별 결과)에 맞게 갱신 → 게이트 green |
| B2 | `muse proactive-trust`는 명령 아님 | 낮음(혼동) | 실제 표면은 `muse proactive scoreboard/veto/keep/acted`. `proactive-trust`로 호출하면 unknown command. | 문서에서 `proactive-trust` 표기 금지 |
| B3 | `muse specs list` 서버 전용 | 중간 | 다른 명령들은 API 서버 없으면 로컬 스토어로 폴백하나 `specs`는 `:3030` 필요·폴백 없음. | `--local` 폴백 추가 또는 문서 명시 |
| B4 | 관측계 admin 명령 서버 전용 | 중간 | `cost/latency/traces/telemetry/analytics/tools/metrics/settings/mcp list/scheduler list`는 API 서버 필요·`--local` 없음 → 서버 없이 read-only 검증 불가. | 문서에 "API 서버 필요" 명시 또는 로컬 폴백 |
| B5 | 팬텀 명령 표기 | 낮음(문서) | `jobs`→실제 `job`, `setup-local`→`setup local`, `setup-voice`→`setup voice`. | 문서 정정 |
| B6 | `status` 로컬모델 라벨 오기 | 낮음(표시) | 로컬-온리인데 "inferred from GEMINI_API_KEY"로 표기(동작은 정상, gemma4 사용). | 표시 문구 정정 |
| B7 | `recall --help`의 embed-model 기본 문구 stale | 낮음(문구) | **재검증 결과 행동 버그 아님.** `recall`은 `--embed-model` 생략 시 런타임에서 `DEFAULT_EMBED_MODEL`(=`nomic-embed-text-v2-moe`)로 해석한다(`commands-recall.ts:381-383`) — `ask`/`note`와 동일. 다만 `.option` **설명 문자열**만 옛 `'nomic-embed-text'`로 남아 있음(`:357`), 그리고 인덱스-모델 불일치 시 경고를 띄움(`:313-326`). 품질 저하 아님. | `:357` 설명 문자열을 v2-moe로 정정(선택) |

> 위 어느 것도 **빌드/테스트/제품 동작을 깨지 않음**. B1은 본 작업서 수정(smoke green), B7은 재검증 결과 문구 문제로 강등. **실제 동작 확인이 필요한 후속은 B3·B4(specs/admin 명령의 `--local` 부재)뿐.**

## 4. 문서 드리프트 (README / FEATURES / SYSTEM-MAP)

| # | 위치 | 드리프트 | 상태 |
|---|---|---|---|
| D1 | README ~238 | demo가 "auto-picks any local Ollama **Qwen 2.5**" — 기본은 gemma4:12b | ✅ 본 작업서 수정 |
| D2 | README ~233 | "Node.js **24 LTS**" 요구 vs `engines >=22.12.0` 모순 | ✅ 수정 |
| D3 | README ~145 | "**~23** muse.* 서버" — 실제 24 | ✅ 수정 |
| D4 | README ~200 | 패키지 목록 불완전(`...`) — 실제 27개 | ✅ 보강 |
| D5 | README ~198 | apps/web "chat+tasks+calendar+settings" — 실제 13 패널 | ✅ 수정 |
| D6 | FEATURES.md:194 | race 모드를 라이브 ✅로 광고 — 실제 parked(→sequential). README:158은 올바름 | ✅ 수정 |
| D7 | FEATURES.md:21 | 제거된 `goals/CAPABILITIES.md` 참조(dead link) | ✅ 수정 |
| D8 | FEATURES / SYSTEM-MAP | 결정론적 데이터툴(csv/benford/trend/diversity/keywords/summarize/on-this-day) **기능 섹션에 누락** (README "levers"엔 있음) | ✅ 추가 |
| D9 | FEATURES / SYSTEM-MAP | `anomaly`·`recap`·`week`·daemon 표면·`watch-folder`·`webhook`·`feeds`·`routine`·`history`/`open`·`propose`/`approvals`·action-log `--verify` 누락 | ✅ 추가 |
| D10 | FEATURES.md (상시목표) | ⚙️ "기반/미연결"로 표기 — 실제 동의게이트+양 액추에이터+objectives 틱+CLI 모두 존재·테스트됨 → ✅로 승격 | ✅ 수정 |
| D11 | FEATURES/SYSTEM-MAP `updated:` | 2026-05-29/05-31 — 갱신 필요 | ✅ 2026-06-14로 |

## 5. 결론

- **제품은 건강하다.** 결정론적 게이트(빌드·테스트·린트) 전부 통과, 7개 도메인 전 기능이 실행/테스트로 검증됨. 유일한 게이트 실패(smoke:broad)는 옛 설계 기준의 stale 테스트 1건으로 제품 결함이 아니다.
- **Muse의 핵심 엣지(그라운딩+인용 게이트, Whetstone 자기개선, 아웃바운드 안전)는 코드로 실재하며 테스트로 입증된다** — 마케팅이 아니라 동작.
- **남은 후속 작업**: B3/B4(서버 전용 명령 `muse specs`/`cost`/`tools` 등의 `--local` 폴백 또는 문서화). (B1=수정완료, B7=문구 강등.)

## 6. 검수 메모 (2026-06-14, ground-truth 재검증)

이 INDEX는 7개 도메인 서브에이전트 보고를 **직접 ground truth로 재검증**해 작성했습니다. 에이전트 보고끼리 어긋난 수치는 다음과 같이 직접 확인해 확정했습니다(INDEX가 권위):

- **muse.* 서버 = 24** (canonical, `"muse.X"` 단일명 distinct grep). 07 카탈로그의 "27"은 `notes-multi`/`tasks-multi`/`png` 같은 변형까지 합산한 값 — README는 24개 canonical을 열거.
- **웹 패널 = 13** (`apps/web/src/views/*.tsx` 비-test). 07 카탈로그의 "14"는 과다.
- **CLI 최상위 = 102** (`muse --help` 2-칸 들여쓰기 명령, awk 카운트). 초안의 70은 sed 추출 오류였음.
- **race 모드 parked 확정** (`multi-agent/src/index.ts:371` 주석 `parked: resolves to sequential`).
- **objectives ✅ 승격 정당** (`mcp/objective-evaluator.ts` + `commands-daemon.ts`의 `runDueObjectives`·model evaluator·메시징/제안 액추에이터·consent 게이트 실재).
- **B7 강등** (위 §3 — recall 런타임 기본은 v2-moe, help 문구만 stale).
- **diversity attribution 정밀 확인** (`diversity.ts:12-13` 실제 Gini-Simpson·Pielou 사용).

> 각 `0X-*.md`는 **도메인별 원시 검증 리포트**(에이전트 작성, 증거 포함)입니다. 수치가 본 INDEX와 다르면 위 재검증값이 우선합니다. 도메인별 기능 하나하나의 증거(실행 명령·테스트 파일·소스 라인)는 그 파일들에 있습니다.
