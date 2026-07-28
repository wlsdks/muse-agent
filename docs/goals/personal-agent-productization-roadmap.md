---
title: Muse personal-agent productization roadmap
audience: [owner, product, engineering, evaluation]
purpose: Move Muse from an advanced engineering alpha to a qualified, useful, evidence-backed daily personal agent
status: historical-reference
updated: 2026-07-28
related:
  - personal-agent-core-100-roadmap.md
  - personal-agent-acceptance-plan.md
  - daily-use-hardening-plan.md
  - attunement-implementation-plan.md
  - ../strategy/attunement.md
  - ../development/personal-agent-qualification.md
  - ../development/agent-capability-baseline.md
  - ../development/ai-agent-testing-strategy.md
  - competitor-teardown.md
---

# Muse personal-agent productization roadmap

> **2026-07-28 owner-directed replan:** 새 작업 activation과 다음 작업 선택은
> [`personal-agent-core-100-roadmap.md`](personal-agent-core-100-roadmap.md)가 권위 문서다.
> 이 300-task 문서는 완료된 source를 재구현하지 않기 위한 legacy 요구사항과 ID 이력으로만
> 유지한다. 특히 990분 worst-case의 Task 059–060은 실행하지 않고 Core100의 bounded
> qualification shard 004–010으로 대체한다.

## 목적

이 문서는 Muse의 강한 기술 기반을 실제로 매일 신뢰할 수 있는 개인 에이전트로 전환하기 위한
의존성 순서형 프로그램 지도다. 현재 구현되어 있는 기능을 다시 만드는 목록이 아니다. 이미 존재하는
기능도 현재 환경에서 증거가 stale하거나 fail-closed gate가 닫혀 있으면, 해당 계약을 다시 증명하는
작업으로 포함한다.

최종적으로 증명하려는 것은 다음 한 문장이다.

> Muse는 한 사용자의 삶과 일을 정확한 출처로 이어주고, 도움이 되었는지를 명시적으로 배우며,
> 권한을 몰래 확대하지 않은 채 안정적으로 매일 실행된다.

## 현재 출발점 — 2026-07-25 일회성 스냅샷

이 수치는 roadmap의 영구 진실이 아니다. Task 001이 새 실행마다 현재 증거로 교체한다.

- CodeGraph 강제 전체 재인덱싱 완료: 3,673 files, 43,015 nodes, 118,449 edges.
- TS7 typecheck 통과.
- `@muse/agent-core` 3,370 tests, `@muse/attunement` 191 tests 통과.
- Web unit 670 tests와 real Chromium 128 tests 통과.
- API boot 통과.
- `pnpm qualify:personal-agent`는 `not-qualified`: 2 failed, 1 unverified.
- resident background runtime은 stale/crash-looping으로 판정됐고 heartbeat와 live identity가 검증되지 않았다.
- delivery-safety는 local-only, self-learning hold, provider lock 증거가 닫히지 않았으며 overdue
  follow-up 26개와 reminder 5개가 보고됐다.
- CLI smoke의 10개 기능 항목은 통과했지만 프로세스가 스스로 종료되지 않았다.
- Browser smoke는 JavaScript confirm 수락 후 제목 전환 계약에서 실패했다.
- 최신 기록 capability aggregate는 10/11이며 corrected-fact freshness가 실패 축이다.
- organic personal effectiveness는 명시적으로 `NOT_PROVEN`이다.

상충하는 과거 스냅샷보다 현재의 read-only qualification 결과가 우선한다. 예를 들어
`daily-use-hardening-plan.md`의 2026-07-22 resident 상태가 green이어도, 2026-07-25 qualification이
red라면 프로그램은 red에서 시작한다.

## 운영 규칙

### 우선순위

- **P0:** 다음 단계 진입을 막는 안전·정확성·운영 blocker.
- **P1:** 매일 쓸 수 있는 가치와 복구 가능성을 만드는 필수 기능.
- **P2:** 차별화와 제한된 자율성을 검증하는 기능.
- **P3:** 생태계, 확장, 공개 배포 최적화.

이 priority는 기본적으로 **phase-local**이다. 뒤 phase의 P0가 현재 ready queue의 P1보다 먼저 실행된다는
뜻이 아니다. Task 001–012가 current evidence로 최대 다섯 개의 `Global P0` ready queue를 만들며,
현재 피해·release blocker·dependency-ready 순으로 소비한다.

### 진행 규칙

1. 작업 번호는 장기 참조를 위한 stable ID다. 숫자 순서대로 무조건 실행하지 않고 아래
   authoritative execution order와 현재 gate 상태로 다음 작업을 선택한다.
2. 한 번에 한 개의 좁은 slice만 BUILD 상태로 둔다. 시간이 필요한 organic collection, soak,
   cohort는 별도 EVIDENCE/MONITOR lane 하나에서 병행할 수 있으며 source를 동시에 수정하지 않는다.
3. 각 작업은 명시된 산출물과 검증 증거가 모두 있어야 닫힌다.
4. maker와 evaluator를 별도 agent context와 역할로 분리한다. 모델 이름만 바꾸거나 같은 context에서
   두 역할을 이어서 수행한 것은 독립 평가가 아니다. 별도 evaluator가 없으면 완료가 아니라
   `미분리 자기평가`다.
5. deterministic, controlled-live, organic-production evidence를 서로 승격하지 않는다.
6. factual interaction receipt는 feedback, permission, policy promotion이 아니다.
7. 외부 전송, 데이터 삭제, 권한 확대, 자동화 활성화는 owner preview와 별도 permission gate 뒤에만 둔다.
8. 각 phase exit gate는 표에 적힌 특정 promotion/behavior만 막는다. red인 organic·optional gate가
   무관한 security, reliability, repair 작업까지 막는 전역 waterfall로 사용되어서는 안 된다.
9. source/behavior를 바꾼 slice는 영향 범위 테스트, `pnpm test:changed`, 독립 평가를 통과한 뒤
   task 단위로 commit하고 정상 upstream에 push한다.
10. docs/evidence/ledger/status만 바뀐 기록 작업은 task마다 commit/push하지 않는다. 아래 batching
    규칙에 따라 자연스러운 checkpoint에서 묶는다.
11. 이 문서는 프로그램 지도다. 세부 실행 기록은 커밋 본문과 기존 active ledger에 남기고 이 문서를
    세션 로그처럼 무한히 늘리지 않는다.

### 커밋·푸시 규칙

이 장기 목표는 300개 task를 실행하더라도 기록만 늘리는 작은 commit을 매번 만들지 않는다.
commit 경계는 task 번호가 아니라 **제품 동작이 바뀌었는가**로 결정한다.

- **task 완료 직후 commit+push:** runtime/source code, test, executable script, build/package 설정,
  dependency, schema/migration, user-visible UI/문구, security policy/hook처럼 제품 동작·검증 계약을
  바꾼 경우. 관련 문서와 evidence summary는 같은 commit에 포함할 수 있다.
- **나중에 batch commit:** roadmap 체크, dated status, read-only 측정 결과, evidence narrative,
  ledger 기록, 설명 보정처럼 제품 동작을 바꾸지 않는 기록-only 변경. task마다 push하지 않는다.
- **mixed change:** source/behavior 변경과 기록 변경이 한 slice에 함께 있으면 source 변경으로 간주한다.
  해당 구현을 설명하는 기록만 같은 commit에 넣고, 무관한 누적 기록은 섞지 않는다.
- **기록 batch checkpoint:** phase exit, 다음 source-code commit, branch/worktree 전환 전, rebase/merge 전,
  장기 세션 handoff 전, release-readiness 실행 전 중 가장 먼저 오는 시점에 관련 기록을 하나로 정리한다.
- **검증:** source commit은 required test와 evaluator PASS 뒤에만 만든다. docs-only batch는 link,
  ledger format, whitespace, claim freshness를 검사한다.
- **push:** 현재 task branch 또는 검증된 local `main`의 configured `origin` upstream으로 정상 push한다.
  `--no-verify`, force/force-with-lease, alternate remote/refspec, tag/release는 이 규칙이 허용하지 않는다.
- **실패:** hook, auth, protection, unresolved divergence가 발생하면 저장소 standing authorization의
  한도 안에서 안전한 fetch/rebase를 최대 한 번 재시도하고, 해결되지 않으면 push를 멈추고 보고한다.
- **사용자 변경 보호:** 다른 작업의 dirty change를 임의로 commit, discard, rewrite하지 않는다.

### 작업 활성화와 중복 방지 규칙

300개 checkbox는 “300개 기능이 모두 없다”는 뜻이 아니다. task를 BUILD로 열기 전에 현재 HEAD의
CodeGraph, tests, qualification artifact, 기존 문서를 확인하고 다음 상태 중 하나를 기록한다.

| 상태 | 의미 | 실행 |
| --- | --- | --- |
| `missing` | acceptance를 담당하는 구현이 없음 | 필요한 최소 slice만 설계·구현 |
| `partial` | 계약 일부만 구현됐거나 현재 blocker가 있음 | 존재하는 구현을 보존하고 missing delta만 수정 |
| `built-unverified` | 구현은 있으나 fresh evidence가 없음 | 재구현 금지; 검증·운영 복구만 수행 |
| `verified-current` | 현재 HEAD/artifact에서 acceptance 충족 | 코드 변경 없이 기록-only 완료 처리 |
| `monitoring` | organic collection, soak, cohort처럼 시간이 필요 | EVIDENCE/MONITOR lane에서 관찰; BUILD lane을 막지 않음 |
| `blocked` | owner decision, credential, hardware, elapsed time이 필요 | blocker와 재개 조건을 기록하고 다른 ready work 선택 |
| `deferred` | 가치가 있으나 현재 promotion 범위 밖 | 구현하지 않음 |
| `rejected` | mission, safety, evidence상 하지 않기로 결정 | 재유도 금지; 새 evidence가 있을 때만 재검토 |
| `superseded` | 앞선 task가 acceptance를 완전히 충족 | 중복 구현 금지; 대체 task와 current proof를 연결 |

활성화 header에는 최소한 `Task ID`, `상태`, `lane`, `유형(FIX|BUILD|TEST|OPS|EVAL|DOC)`,
`크기(S|M|L)`, `현재 구현 symbol/file`, `missing delta`, `검증`, `commit 경계`, `maker
model/effort`, `선택 사유`, `evaluator model/effort`, `escalation trigger`를 적는다.

- 현재 source가 acceptance를 이미 만족하면 checkbox를 이유로 새 abstraction이나 두 번째 store를 만들지 않는다.
- 뒤 task가 앞 task와 같은 acceptance를 반복하면 고유한 domain/recurrence delta를 한 문장으로
  증명해야 한다. 새 delta가 없으면 뒤 task를 `superseded`로 닫는다.
- 한 task가 L-size이면 번호를 늘리지 않고 내부 commit-sized slice로 쪼갠다. 각 slice는 독립
  acceptance와 evaluator를 가지며 최종 task gate에서 합친다.
- 코드에 없는 문제를 추측해 구현하지 않는다. `built-unverified`와 `partial` 판정은 current source와
  failing evidence를 함께 가리켜야 한다.

### 공통 Definition of Done

모든 작업은 별도 설명이 없더라도 다음 조건을 만족해야 한다.

- acceptance criteria가 구현 전에 적혀 있다.
- 정상, 실패, 취소, 재시도, 오래된 상태 중 영향받는 경계를 검증한다.
- 영속 포맷을 건드리면 호환성, 손상 입력, 백업·복구를 검증한다.
- UI를 건드리면 필요한 journey를 실제 Chromium에서 검증한다.
- 외부 효과를 건드리면 draft-first, idempotency, dedupe, explicit authority를 검증한다.
- 문서와 사용자 노출 계약이 실제 동작과 일치한다.
- evaluator가 acceptance criteria별로 `PASS | FAIL`과 재현 근거를 남긴다.

## 실행 파동

| Wave | 작업 | 목표 | 다음 단계 진입 조건 |
| --- | ---: | --- | --- |
| A — Truthful core | 001–060 | 현재 런타임·전송·표면·기억을 정직하게 qualification | runtime, delivery, surface, recall gate 모두 green |
| B — Trusted daily loop | 061–096 | Continuity, 보안, 자원 경계를 매일 사용 가능한 수준으로 닫기 | organic audit 전제와 24h 운영 soak 통과 |
| C — Attuned experience | 097–120 | onboarding과 Observe/timing을 수동·shadow부터 검증 | owner-reviewed controlled cohort 통과 |
| D — Competitive product | 121–144 | 선택적 경쟁력 확장, 배포 정리, 출시 판정 | release readiness 독립 PASS |
| E — Durable personal OS | 145–216 | 출시 운영, 장기 memory, 생활 도메인, computer control, communication, planning | 실제 개인 workflow의 multi-date audit |
| F — Governed adaptation | 217–252 | skill learning, multi-agent, model routing을 통제된 품질 향상으로 연결 | baseline 대비 held-out improvement |
| G — Ubiquitous and compounding | 253–300 | device 확장, 상시 평가, ecosystem, 반복 가치 운영 | G0–G24 fresh review와 다음 cycle 승인 |

## Authoritative execution order

아래 순서가 task 번호보다 우선한다. task ID는 재번호화하지 않는 참조이고, 활성화 시 current status와
missing delta로 실제 작업량을 결정한다.

### 실행 lane

| Lane | WIP | 용도 | 선택 규칙 |
| --- | ---: | --- | --- |
| INCIDENT | 필요 시 1 | 데이터 손상, unapproved effect, resident 폭주처럼 현재 피해를 막는 작업 | 다른 lane을 중단하고 exact containment부터 |
| BUILD | 1 | source/behavior를 바꾸는 ready slice | current Global P0, dependency-ready, measurable acceptance 순 |
| EVIDENCE/MONITOR | 1 | organic collection, 24h soak, 30일 dogfood, controlled cohort | source를 수정하지 않고 BUILD와 병행 |
| MAINTENANCE | 예약 1 | weekly/monthly/quarterly review, dependency/security upkeep | BUILD를 방해하지 않는 owner cadence에 실행 |
| HORIZON | 0 | optional channel, voice, multi-agent, plugin expansion | promotion gate와 owner need가 생길 때만 다른 lane으로 승격 |

### 실제 권장 순서

| Stage | BUILD lane | 병행 EVIDENCE/MONITOR | Exit/다음 선택 |
| --- | --- | --- | --- |
| 0. Reconcile | 001–012를 실행해 각 task를 상태 분류 | 없음 | current Global P0와 ready queue 5개 확정 |
| 1. Truthful core | 013–060 중 `missing|partial` delta만 수정 | 024·048·060 pass^k evidence | G1–G4 fresh green |
| 2. Safety/resource | 073–096을 실행; G5를 기다리지 않음 | 084 review, 096 24h soak | G6–G7 green |
| 3. Daily product | 061–067, 097–108, positioning 121 | 068–072 organic collection | G8 green; G5는 독립 promotion gate |
| 4. Release minimum | 133–140과 current release blockers | 141–143 dogfood/readiness | G5가 red면 engineering alpha만, green이면 144 personal-agent release |
| 5. Controlled proactivity | 109–120 중 owner-approved shadow/cohort | timing labels와 negative outcomes | G9가 허용한 범위만 promotion |
| 6. Selective competition | 122–132 중 owner need와 baseline 이득이 있는 것만 | competitor delta review | G10은 release를 막지 않는 optional gate |
| 7. Durable personal OS | 145–216을 incident·organic need 순으로 선택 | G12–G17 audits | 해당 domain promotion만 허용 |
| 8. Governed adaptation | 217–252; learning→multi-agent→provider 순 | held-out paired evidence | G18–G20 scope별 green |
| 9. Device/eval/ecosystem | 253–288 중 accepted platform/plugin scope만 | journey/quarterly qualification | G21–G23 scope별 green |
| 10. Recurring cycle | failure evidence에서 289–300 실행 | monthly/quarterly monitoring | G24에서 successor 또는 종료 결정 |

### 이 로드맵을 실행하는 Codex 모델 정책

이 절은 **Muse 제품 안에서 사용자의 작업을 어느 provider/model로 보낼지** 정하는 Task 242가 아니다.
이 300-task 개발 프로그램을 수행하는 Codex agent의 모델과 reasoning effort를 정한다. 기준은
2026-07-25의 공식 [Codex Models](https://learn.chatgpt.com/docs/models) 지침이다. 공식 역할은
Sol=복잡하고 개방적인 고가치 작업, Terra=일상적인 범용 작업, Luna=정답 형태가 명확한 반복
작업이다. effort는 필요한 결과를 내는 가장 낮은 수준에서 시작하되, Muse의 source 변경은 일반적인
채팅보다 실패 비용이 크므로 아래 기본값을 따른다. 이 절의 짧은 이름은 각각
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` exact model ID를 뜻한다.

#### 한 줄 결론

- **300-task 목표 전체를 한 세션에 맡길 controller라면 `gpt-5.6-sol / high`를 사용한다.**
- **이미 활성화된 안전한 S/M-size 구현 slice의 worker라면 `gpt-5.6-terra / high`로 충분하다.**
- **Luna는 필수 경로가 아니다.** 명확하고 반복 가능한 read-only/record 작업에만 사용하며, 사용할 수
  없으면 `gpt-5.6-terra / medium`으로 대체한다.
- 모델을 고르지 못하겠거나 표의 조건이 충돌하면 더 강한 쪽인 `Sol / high`를 선택한다.

따라서 “Terra high에게 이 문서 전체를 주고 계속 돌린다”는 운영은 권장하지 않는다. Terra high는
작업자가 될 수 있지만, 다음 task 선택·범위 절단·고위험 판단·gate 평가는 Sol high controller가
맡아야 한다. 비용을 줄이고 싶으면 Sol은 매 task의 모든 코딩을 하지 않고 activation과 독립
evaluation에만 쓰고, 조건을 통과한 BUILD slice를 Terra high에 넘긴다.

#### 모델·effort 판정표

| 모델·effort | 사용 조건 | 대표 작업 | 금지·승급 조건 |
| --- | --- | --- | --- |
| `Luna / low` 또는 `Luna / medium` | 입력·출력 schema와 정답 판정이 고정된 low-risk 반복 작업 | status 표 변환, ledger 형식 검사, 정해진 필드 추출, 링크 목록 정리 | source/behavior 변경, task 선택, 원인 추론, acceptance 작성, gate 판정에는 사용하지 않는다. 조금이라도 판단이 필요하면 Terra로 승급 |
| `Terra / medium` | read-heavy이고 결론 형식이 정해진 current-state 수집 | CodeGraph/file inventory, test log 분류, evidence normalization, 이미 정한 검증 명령 실행 | 새 설계나 blocker 우선순위 판단이 생기면 Terra high 또는 Sol high로 승급 |
| `Terra / high` | activation header가 완성된 S-size 또는 M-size 구현이고 missing delta·acceptance·검증 명령이 명확하며 아래 high-risk boundary가 없음 | 좁은 FIX/BUILD/TEST, 기존 module 보강, deterministic regression test, bounded UI journey 수정 | L-size, 계약 모호성, cross-package policy/effect 변경, 예기치 않은 두 번째 subsystem 실패, 1회 `no-progress`가 생기면 Sol high로 승급 |
| `Sol / high` | 프로그램 제어, open-ended planning, L-size 분해, architecture, high-risk source, 독립 평가, release 판단 | Task 001–012, Global P0 선택, security/permission/effect 설계, migration, concurrency, root-cause, gate evaluator | hardest security/release proof 또는 Sol high에서도 1회 `no-progress`이면 Sol xhigh 검토 |
| `Sol / xhigh` | 실패 비용이 매우 크고 여러 경계를 동시에 증명해야 하는 제한된 평가 | deep security review, credential/exfiltration threat scan, release provenance·rollback 최종 gate, 반복되는 cross-system corruption | 일상 worker 기본값으로 사용하지 않는다. 범위와 종료 조건 없이 Max/Ultra로 올리지 않는다 |

앱의 **Light / Medium / High / Extra High** 표시는 CLI의 `low / medium / high / xhigh`에 대응해서
읽는다. `max`는 한 agent가 풀기 어려운 최상 난도 문제에만 owner가 명시적으로 선택한다. `ultra`는
subagent 실행을 포함할 수 있으므로 이 로드맵의 자동 기본값이 아니며, owner가 병렬 agent 작업을
명시적으로 요청하고 쓰기 충돌 없는 독립 단위가 있을 때만 사용한다.

#### high-risk boundary

다음 중 하나라도 건드리면 크기가 S여도 Terra에서 시작하지 않고 `Sol / high`로 시작한다.

- 외부 전송, 삭제, 금전·구매, 계정 변경, 사용자 대신 약속하는 효과
- approval, permission, guard, hook, policy, credential, secret, provider egress
- PostgreSQL/file 영속 schema, migration, backup/restore, 암호화, data retention
- Rust runner, sandbox, process ownership, daemon lifecycle, scheduler lock, concurrency/idempotency
- browser upload/download, computer control, clipboard/screen/audio capture
- self-learning activation, skill/plugin 설치, prompt/policy의 자기 변경
- multi-agent authority, handoff, shared state, provider/model fallback
- release qualification, artifact provenance, signing, tag, rollback, publication

high-risk task의 구현자가 Sol이었다는 사실만으로 평가는 독립적이지 않다. 동일 모델을 써도 **새 agent
context**가 handoff와 current diff만 읽고 검증해야 한다. source/behavior·phase gate·release 작업의
기본 evaluator는 `Sol / high`, 보안·release 최종 gate는 `Sol / xhigh`다. docs/evidence-only
low-risk 작업은 별도 `Terra / medium|high` evaluator로 충분하다.

#### stage별 기본 route

| Stage | controller/plan | 기본 worker | 독립 evaluator |
| --- | --- | --- | --- |
| 0. Reconcile, 001–012 | `Sol / high` | read-only 수집만 `Terra / medium` | Task 012는 새 context의 `Sol / high` |
| 1. Truthful core, 013–060 | `Sol / high`가 ready slice 확정 | 안전한 S/M은 `Terra / high`; lifecycle·root-cause는 `Sol / high` | task는 `Sol / high`; G1–G4도 `Sol / high` |
| 2. Safety/resource, 073–096 | `Sol / high` | deterministic probe/test는 `Terra / high`; policy·runner·concurrency는 `Sol / high` | 보안 G6은 `Sol / xhigh`, 자원 G7은 `Sol / high` |
| 3. Daily product, 061–072·097–108·121 | `Sol / high`가 G5와 BUILD를 분리 | bounded adapter/UI는 `Terra / high`; organic record는 `Luna / medium` 또는 `Terra / medium` | G5·G8은 `Sol / high` |
| 4. Release minimum, 133–144 | `Sol / high` | packaging/test fix는 `Terra / high`, provenance·rollback은 `Sol / high` | Task 143–144는 새 context의 `Sol / xhigh` |
| 5. Controlled proactivity, 109–120 | `Sol / high` | 승인된 bounded shadow 구현만 `Terra / high` | G9는 `Sol / high` |
| 6. Selective competition, 122–132 | `Sol / high`가 채택 기준 고정 | bounded experiment는 `Terra / high`, 자료 정규화는 `Luna / medium` | G10 채택 판단은 `Sol / high` |
| 7. Durable personal OS, 145–216 | `Sol / high`가 domain별 slice 절단 | 일반 S/M은 `Terra / high`; high-risk boundary는 `Sol / high` | G11–G17은 `Sol / high`, security 포함 시 `xhigh` |
| 8. Governed adaptation, 217–252 | `Sol / high` | 고정된 adapter/test는 `Terra / high`; learning·authority·fallback은 `Sol / high` | G18–G20은 `Sol / high`, activation/security는 `xhigh` |
| 9. Device/eval/ecosystem, 253–288 | `Sol / high` | bounded platform adapter는 `Terra / high`; permission/plugin은 `Sol / high` | G21–G23은 `Sol / high`, plugin security는 `xhigh` |
| 10. Recurring cycle, 289–300 | `Sol / high`가 failure evidence로 다음 cycle 결정 | 정형 report는 `Luna / medium` 또는 `Terra / medium`; repair는 위험도 표 적용 | Task 299–300은 새 context의 `Sol / high` |

#### 새 세션의 기계적 실행 순서

새 agent는 아래 순서를 바꾸지 않는다.

1. `AGENTS.md`, `harness/AGENTS.md`, 이 문서의 운영 규칙·authoritative order·모델 정책을 읽는다.
2. current HEAD, dirty worktree, 현재 gate artifact의 HEAD/time/input provenance를 확인한다.
3. fresh하고 완료된 G0 activation artifact가 없으면 `Sol / high`로 Stage 0의 001–012부터 실행한다.
4. G0가 fresh하면 current stage의 Global P0 ready queue에서 dependency-ready 첫 slice 하나만 고른다.
5. CodeGraph와 failing/fresh evidence로 상태와 missing delta를 판정한다. `verified-current`나
   `superseded`면 BUILD를 열지 않는다.
6. activation header의 모든 필드를 채운 뒤 위 판정표로 maker와 evaluator를 정한다. 조건 충돌 또는
   모르는 위험은 `Sol / high`로 판정한다.
7. maker는 한 BUILD slice만 수행하고 required checks와 handoff를 남긴다. EVIDENCE/MONITOR는 source를
   수정하지 않는다.
8. 별도 context의 evaluator가 acceptance별 `PASS | FAIL`을 재현한다. 같은 context의 자기검사는
   `미분리 자기평가`이고 gate를 열지 못한다.
9. `FAIL`이면 blocker를 한 묶음으로 반환한다. 1회 `no-progress` 또는 high-risk 발견 시 위 규칙대로
   승급하고, 반복 budget을 넘기면 `blocked`와 재개 조건을 기록한다.
10. `PASS`이면 source/behavior 변경만 task 단위 commit+push한다. 기록-only 변경은 batch checkpoint로
    넘기고 WIP를 0으로 만든 다음 authoritative order에서 다음 slice를 고른다.

활성화 기록은 다음 형태를 사용한다.

```md
Task ID:
상태:
lane / 유형 / 크기:
현재 구현 symbol/file:
missing delta:
acceptance / 검증:
commit 경계:
maker model / effort:
선택 사유:
evaluator model / effort:
escalation trigger:
```

#### availability와 fallback

- 현재 Codex surface에서 정확한 모델이나 effort가 보이지 않으면 조용히 다른 모델을 사용하지 말고
  activation header에 `unavailable`과 대체 이유를 기록한다.
- Luna 미노출은 blocker가 아니다. `Luna / low|medium` 작업은 `Terra / medium`으로 대체한다.
- Terra 미노출이면 일반 작업도 `Sol / medium|high`로 대체한다.
- Sol이 미노출이면 Terra high로 low-risk S/M 구현은 계속할 수 있지만, 프로그램 재계획, high-risk
  boundary, phase/release gate는 `blocked: Sol-class independent review unavailable`로 둔다.
- model availability와 공식 권장은 바뀔 수 있으므로 Task 001의 environment snapshot에서 exact
  model ID와 effort 옵션을 다시 기록한다. 문서의 역할 계약을 조용히 약화해서는 안 된다.

### Release label 경계

- **Engineering alpha:** G0–G4와 G6–G8이 green이고 organic effectiveness는 `NOT_PROVEN`으로 명시한다.
- **Evidence-backed personal-agent release:** 위 조건에 G5 organic audit와 121 positioning contract,
  133–143 release evidence가 추가로 green이어야 Task 144를 실행한다.
- G9 proactive timing, G10 competitor expansion, voice/mobile, multi-agent, plugin은 첫 personal-agent
  release의 필수 선행조건이 아니다.

### 2026-07-25 current-source activation hints

이 표는 current source를 재구현하지 않기 위한 dated hint다. 영구 status가 아니며 Task 001이 current
HEAD와 fresh runtime evidence로 다시 판정한다.

| Task | 현재 보이는 구현 | 시작 상태 힌트 | 실제로 해야 할 일 |
| --- | --- | --- | --- |
| 003 | [`personal-agent-qualification.ts`](../../apps/cli/src/personal-agent-qualification.ts)에 source/artifact/runtime/delivery schema와 fail-closed aggregate가 존재 | `built-unverified` | 새 report system을 만들지 말고 missing provenance delta만 확인 |
| 013–017 | [`resident-daemon-status.ts`](../../packages/runtime-state/src/resident-daemon-status.ts)에 stable command, PID/heartbeat/orphan state가 존재 | `built-unverified|partial` | live crash-loop 원인과 current mismatch를 좁혀 기존 module을 보강 |
| 025–035 | [`personal-agent-qualification-probes.ts`](../../apps/cli/src/personal-agent-qualification-probes.ts)에 local-only, lock, brake, hold, backlog observation이 존재 | `built-unverified|partial` | 두 번째 safety layer를 만들지 말고 persisted/live red state를 복구 |
| 037–048 | Browser confirm 실패와 CLI post-PASS hang이 current smoke에서 재현됨 | `partial` | 최소 failing path와 owned-process cleanup만 수정 |
| 049–060 | [`episodic-recall.ts`](../../packages/agent-core/src/episodic-recall.ts) 등 recall substrate가 있으나 corrected-fact axis가 red | `partial` | candidate retention/freshness missing delta만 수정 |
| 061–066 | [`continuity-preparation.ts`](../../packages/attunement/src/continuity-preparation.ts) 등 Pack/store/reducer substrate가 존재 | `built-unverified|partial` | normal-chat seam과 store parity를 먼저 확인하고 없는 adapter만 구현 |
| 073–084 | [`policy`](../../packages/policy), [`secrets`](../../packages/secrets), [`runner`](../../crates/runner) 기반이 존재 | `built-unverified|partial` | current threat case별 enforced gap만 구현 |

### 반복처럼 보이는 task의 고유 delta

아래 later task는 earlier task를 다시 구현하지 않는다. later-only delta가 current source에 이미 있으면
later task를 `superseded`로 닫는다.

| IDs | earlier contract | later-only delta |
| --- | --- | --- |
| 033 → 200 | 모든 outbound의 generic draft/approval primitive | communication payload·recipient·account를 묶은 one-shot final confirmation |
| 034 → 202 | effect ID 기반 generic retry/dedupe | channel provider의 accepted/delivered/unknown receipt reconciliation |
| 128 → 221 | 첫 skill candidate의 held-out activation gate | 여러 skill/version이 공유하는 immutable regression registry와 baseline comparison |
| 131 → 229 → 240 | multi-agent를 열지 결정하는 사전 go/no-go | accepted family의 baseline artifact → 최종 paired benchmark/adopt decision |
| 132 → 292 | 첫 competitor baseline과 fit lens | 이후 분기별 delta-only 재평가; baseline teardown 반복 금지 |
| 142 → 289 | 첫 30일 personal-value release 판정 | release 이후 recurring north-star trend와 prune/experiment decision |
| 143 → 299 | 첫 HEAD-bound release-readiness | 다음 cycle마다 current G0–G23 freshness를 다시 묶는 recurring gate |
| 211 → 232 | 사용자 project를 다음 session으로 넘기는 Continuity handoff | supervisor→subagent 사이의 typed, least-authority handoff |

---

## Phase 0 — 프로그램 기준선과 증거 계약

**진입 조건:** 없음.

**Exit gate G0:** 현재 상태, 증거 클래스, 작업 소유권, 검증 명령과 WIP 규칙이 한 번의 read-only
preflight로 재현된다.

- [ ] **001. 현재 qualification 기준선을 새로 고정한다.** — `P0`
  - **이유:** 문서의 과거 green 스냅샷과 현재 red 실행을 섞으면 잘못된 작업 순서가 나온다.
  - **산출물:** 현재 HEAD, artifact digest, 실행 시각, 환경, 세 축의 qualification 결과를 가진 fresh report.
  - **검증:** `pnpm qualify:personal-agent`를 read-only로 실행하고 source/artifact provenance를 확인한다.
  - **선행:** 없음.

- [ ] **002. 상충하는 상태 문서의 우선순위를 명문화한다.** — `P0`
  - **이유:** 2026-07-22 resident green과 2026-07-25 crash-looping 같은 모순을 사람이 해석하지 않게 해야 한다.
  - **산출물:** “현재 명령 결과 > provenance-valid report > dated narrative” 우선순위와 stale 표시 규칙.
  - **검증:** 서로 다른 날짜의 두 fixture에서 최신이지만 provenance-invalid인 보고서가 선택되지 않는지 확인한다.
  - **선행:** 001.

- [ ] **003. qualification report의 provenance 계약을 강화한다.** — `P0`
  - **이유:** 다른 checkout, 오래된 build, 이전 daemon의 증거가 현재 합격으로 재사용되면 안 된다.
  - **산출물:** HEAD, dirty state, input hash, build digest, runtime identity, generated-at/expiry 필드.
  - **검증:** HEAD·artifact·시간·runtime identity 중 하나만 바꾼 네 사례가 모두 stale/unverified로 닫힌다.
  - **선행:** 001–002.

- [ ] **004. 프로그램 scorecard를 결과 중심으로 정의한다.** — `P0`
  - **이유:** 테스트 수나 tool call 수가 개인적 유용성으로 오인되는 것을 막아야 한다.
  - **산출물:** runtime, delivery safety, recall, Continuity, privacy, resource, onboarding, organic value의 gate 표.
  - **검증:** synthetic-only fixture가 organic effectiveness나 autonomy promotion을 green으로 만들지 못한다.
  - **선행:** 002–003.

- [ ] **005. evidence class와 promotion rule을 단일 타입으로 고정한다.** — `P0`
  - **이유:** `deterministic`, `controlled-live`, `organic-production`을 문구만으로 구분하면 drift가 생긴다.
  - **산출물:** immutable `dataOrigin`, independent `executionEvidence`, freshness, denominator 계약.
  - **검증:** origin 또는 execution evidence가 없는 기록은 qualification 집계에서 제외된다.
  - **선행:** 004.

- [ ] **006. receipt, outcome, permission, policy change를 별도 ledger로 재확인한다.** — `P0`
  - **이유:** task 완료가 “Muse가 도움됨”이나 향후 자동화 동의로 승격되는 것이 가장 위험한 오류다.
  - **산출물:** 네 상태의 명시적 연결 규칙과 금지된 자동 변환 표.
  - **검증:** task completion만 있는 fixture가 feedback·permission·promotion을 하나도 생성하지 않는다.
  - **선행:** 005.

- [ ] **007. 각 phase용 acceptance slice 템플릿을 고정한다.** — `P0`
  - **이유:** 144개 작업이 “구현했다”는 주장만 남기지 않게 해야 한다.
  - **산출물:** WHAT, WHY, PASS 기준, 범위 밖, 검증 명령, evidence accounting, rollback 필드.
  - **검증:** 필수 필드가 빈 handoff가 PLAN gate를 통과하지 못한다.
  - **선행:** 004–006.

- [ ] **008. maker/evaluator 역할과 권한을 phase별로 배정한다.** — `P0`
  - **이유:** 동일 세션 자기평가는 조용한 데이터·권한 오류를 놓치기 쉽다.
  - **산출물:** runtime, store, security, UI, release별 worker/evaluator와 read/write 권한표.
  - **검증:** evaluator가 build 대화 없이 artifact와 acceptance criteria만으로 판정할 수 있다.
  - **선행:** 007.

- [ ] **009. 위험 등급별 검증 깊이를 지정한다.** — `P0`
  - **이유:** 모든 변경에 full suite를 돌리거나 고위험 변경을 unit test만으로 닫는 두 극단을 피해야 한다.
  - **산출물:** pure code, UI, persistent store, permission/send, release의 test matrix.
  - **검증:** 대표 변경 다섯 개를 입력하면 요구되는 deterministic/browser/corruption/live/evaluator gate가 결정된다.
  - **선행:** 007–008.

- [ ] **010. dependency graph와 BUILD/EVIDENCE lane WIP를 고정한다.** — `P0`
  - **이유:** 눈에 띄는 확장이 blocker보다 먼저 진행되는 것과 장기 evidence 대기가 전체 개발을 멈추는 것을 함께 막아야 한다.
  - **산출물:** G0–G24 scope별 DAG, BUILD WIP=1, EVIDENCE/MONITOR WIP=1, incident preemption.
  - **검증:** runtime red에서 optional 확장은 선택되지 않고 organic monitoring 중에도 ready security fix는 실행 가능하다.
  - **선행:** 004, 009.

- [ ] **011. canonical 검증 명령 카탈로그를 만든다.** — `P0`
  - **이유:** 사람마다 다른 명령과 옵션을 사용하면 pass 결과를 비교할 수 없다.
  - **산출물:** typecheck, affected tests, real-browser, smoke, qualification, pre-push의 명령·예산·side effect 표.
  - **검증:** 각 명령의 timeout, 예상 artifact, skip 조건, 실패 보존 경로가 문서화된다.
  - **선행:** 009–010.

- [ ] **012. G0 기준선 review를 독립적으로 통과시킨다.** — `P0`
  - **이유:** 잘못된 기준선 위에서 실행하면 이후의 모든 green이 무효다.
  - **산출물:** G0 `PASS | FAIL`, blocker 묶음, 상태·lane·유형·크기·missing delta가 있는 Global P0 ready queue 최대 다섯 개.
  - **검증:** evaluator가 001–011을 새 checkout에서 재현하고 이미 구현된 acceptance가 BUILD queue에 중복 선택되지 않았는지 확인한다.
  - **선행:** 001–011.

---

## Phase 1 — resident runtime을 하나의 진실로 만들기

**진입 조건:** G0 green.

**Exit gate G1:** 실제 owner macOS profile의 안정된 entrypoint에서 정확히 한 resident writer가 실행되고,
artifact·PID·heartbeat·process identity가 서로 다른 writer generation의 pass^3에서 일치한다.
자연스러운 OS/session restart가 발생하면 같은 관찰을 운영 evidence로 추가하지만 강제 재부팅이나 별도
macOS 사용자 계정은 G1 또는 owner-scoped personal-agent release의 선행조건이 아니다.

- [ ] **013. macOS resident artifact와 모든 Muse process를 read-only inventory한다.** — `P0`
  - **이유:** 오래된 checkout과 임시 test runner가 실제 daemon처럼 남아 있을 수 있다.
  - **산출물:** plist, launchd registration, PID/PPID, cwd, executable realpath, start time, heartbeat의 bounded report.
  - **검증:** artifact-only, process-only, duplicate, orphan, healthy 다섯 fixture를 구분한다.
  - **선행:** 012.

- [ ] **014. stable CLI entrypoint 판정을 fail-close로 고정한다.** — `P0`
  - **이유:** tmp, test runner, 삭제된 worktree entrypoint에서 resident를 설치하면 다음 재시작에 깨진다.
  - **산출물:** canonical realpath와 허용된 package/release origin 검사.
  - **검증:** `/tmp`, test output, missing path, moved worktree가 설치 전 거부된다.
  - **선행:** 013.

- [ ] **015. stale·orphan·duplicate process 분류를 하나의 health module로 통합한다.** — `P0`
  - **이유:** `daemon --status`, doctor, qualification이 서로 다른 진실을 말하면 복구가 위험하다.
  - **산출물:** 공통 resident health result와 reason-code enum.
  - **검증:** 세 표면이 같은 fixture에 byte-equivalent 상태와 reason을 반환한다.
  - **선행:** 013–014.

- [ ] **016. 동시에 두 resident writer가 활성화되지 못하게 한다.** — `P0`
  - **이유:** task, reminder, outcome, delivery store에 split-brain 쓰기가 발생할 수 있다.
  - **산출물:** process identity가 포함된 single-writer lease와 dead-owner fencing.
  - **검증:** 동시 기동 두 개 중 하나만 writer가 되고 loser는 외부 효과 없이 종료된다.
  - **선행:** 015.

- [ ] **017. heartbeat freshness와 단조성 계약을 완성한다.** — `P0`
  - **이유:** 살아 있는 PID만으로 event loop와 scheduled work의 생존을 증명할 수 없다.
  - **산출물:** owner-only heartbeat receipt, generation, last-progress, expected cadence.
  - **검증:** frozen clock, stale generation, PID reuse, partial write가 healthy로 판정되지 않는다.
  - **선행:** 015–016.

- [ ] **018. crash-loop 원인을 reason-coded terminal state로 남긴다.** — `P0`
  - **이유:** 현재 qualification의 `crash-looping`만으로는 고칠 수 있는 원인이 부족하다.
  - **산출물:** bounded recent failures, exit class, last stable point, redacted diagnostic link.
  - **검증:** config, store corruption, provider auth, port collision, uncaught exception을 구분한다.
  - **선행:** 017.

- [ ] **019. resident restart에 bounded backoff와 circuit breaker를 적용한다.** — `P0`
  - **이유:** 지속 실패가 CPU·로그·외부 효과 폭주로 번지는 것을 막아야 한다.
  - **산출물:** restart budget, exponential backoff, open/half-open 상태, owner-visible reset.
  - **검증:** 반복 실패가 한도 뒤 멈추고 성공 probe 뒤에만 half-open에서 복구된다.
  - **선행:** 018.

- [ ] **020. repair plan과 execution을 분리한다.** — `P0`
  - **이유:** process 종료, plist 교체, 재등록은 정확한 owner preview 없이 실행하면 안 된다.
  - **산출물:** read-only repair plan, exact targets, reversible steps, explicit apply command.
  - **검증:** preview는 무변경이며 stale target이 apply 전에 바뀌면 전체 작업을 거부한다.
  - **선행:** 013–019.

- [ ] **021. resident install·upgrade를 idempotent하게 만든다.** — `P0`
  - **이유:** 같은 버전 재설치나 upgrade 중단이 중복 plist와 process를 만들면 안 된다.
  - **산출물:** versioned install receipt, atomic replace, previous artifact backup.
  - **검증:** install 재실행, 중간 crash, downgrade 거부, rollback fixture가 모두 결정적으로 동작한다.
  - **선행:** 014, 020.

- [ ] **022. uninstall·disable의 데이터 보존 경계를 정의한다.** — `P0`
  - **이유:** resident 제거와 개인 데이터 삭제는 전혀 다른 권한이어야 한다.
  - **산출물:** service-only removal, preserve-data 기본값, 별도 destructive data command.
  - **검증:** uninstall fixture에서 notes/tasks/memory/Attunement bytes가 바뀌지 않는다.
  - **선행:** 020–021.

- [ ] **023. 실제 owner macOS profile에서 contained activation을 수행한다.** — `P0`
  - **이유:** fixture나 개발 foreground process에서만 성공하고 실제 owner LaunchAgent domain에서 실패하는
    resident는 일상 runtime의 기준선이 아니다.
  - **산출물:** 안정된 entrypoint, local-only, log provider, delivery brake, self-learning hold 상태의
    설치·기동 evidence와 개인 store 보존 digest.
  - **검증:** 현재 owner profile에서 install→start→heartbeat→status→stop→start를 실행하고 외부 전송 0,
    정확히 한 writer, store bytes 불변을 확인한다. 별도 macOS 사용자/VM profile은 요구하지 않는다.
  - **선행:** 013–022.

- [ ] **024. resident health를 서로 다른 writer generation의 pass^3로 qualification한다.** — `P0`
  - **이유:** 한 번의 green은 launchd timing과 PID 재사용 경계를 증명하지 못한다.
  - **산출물:** 세 번의 독립 writer generation이 포함된 fresh G1 report.
  - **검증:** 매 실행에서 artifact, PID, executable, generation, heartbeat, single writer가 모두 일치한다.
    OS/session restart는 자연스럽게 발생할 때 추가 수집하는 non-blocking 운영 evidence다.
  - **선행:** 023.

---

## Phase 2 — delivery safety와 오래된 backlog를 닫기

**진입 조건:** G1 green.

**Exit gate G2:** local-only·provider lock·delivery brake·self-learning hold가 persisted state와 live process에
일치하고, 오래된 reminder/follow-up이 owner action 없이 전송·삭제·재예약되지 않는다.

- [ ] **025. `local-only`를 resident 재시작 가능한 영속 정책으로 만든다.** — `P0`
  - **이유:** shell 환경변수에만 있는 containment는 재부팅 뒤 사라질 수 있다.
  - **산출물:** owner-only persisted setting, resolved live value, provenance.
  - **검증:** restart 후에도 유지되고 invalid value는 network-open이 아니라 fail-close가 된다.
  - **선행:** 024.

- [ ] **026. delivery provider lock을 persisted configuration과 live adapter에 동시에 적용한다.** — `P0`
  - **이유:** 설정은 `log`인데 runtime이 Telegram 같은 다른 provider를 잡는 drift를 막아야 한다.
  - **산출물:** allowed provider set, resolved adapter identity, mismatch reason.
  - **검증:** 다른 provider injection이 dispatch 전에 차단되고 qualification에 정확히 보고된다.
  - **선행:** 025.

- [ ] **027. delivery brake를 모든 outbound 경로의 공통 fail-close gate로 만든다.** — `P0`
  - **이유:** reminder, follow-up, proactive, channel-specific 경로 중 하나라도 우회하면 containment가 깨진다.
  - **산출물:** 하나의 brake decision API와 channel-independent audit receipt.
  - **검증:** 알려진 모든 outbound caller가 brake-on fixture에서 send 호출 0을 기록한다.
  - **선행:** 026.

- [ ] **028. qualification 기간 동안 self-learning hold를 강제한다.** — `P0`
  - **이유:** runtime 복구 중 skill/memory policy가 동시에 바뀌면 원인과 결과를 분리할 수 없다.
  - **산출물:** persisted hold, status 표시, proposal 생성과 apply의 별도 제어.
  - **검증:** hold 상태에서 active skill/policy write는 0이고 명시적 memory fact 경로만 기존 계약대로 동작한다.
  - **선행:** 025–027.

- [ ] **029. overdue reminder backlog를 변경 없이 재집계한다.** — `P0`
  - **이유:** 현재 보고된 5개가 실제 store와 일치하는지, 오래된 수치인지 확인해야 한다.
  - **산출물:** exact ID, age band, state, source digest의 read-only inventory.
  - **검증:** inventory 전후 reminder store bytes가 동일하다.
  - **선행:** 027.

- [ ] **030. overdue follow-up backlog를 변경 없이 재집계한다.** — `P0`
  - **이유:** 현재 보고된 26개가 자동 발송 후보가 되지 않도록 먼저 분류해야 한다.
  - **산출물:** exact ID, intended effect, age, recipient presence, eligibility reason의 bounded inventory.
  - **검증:** read path가 send, reschedule, dismiss, recipient resolution을 호출하지 않는다.
  - **선행:** 027.

- [ ] **031. backlog triage preview를 item 및 bounded batch 단위로 만든다.** — `P0`
  - **이유:** owner가 무엇이 바뀌는지 모른 채 과거 항목을 일괄 처리하면 안 된다.
  - **산출물:** retain, dismiss, explicit snooze, draft digest의 exact before/after preview.
  - **검증:** invalid item 하나가 섞인 batch는 어떤 mutation도 만들지 않는다.
  - **선행:** 029–030.

- [ ] **032. triage mutation에 immutable receipt와 idempotency를 적용한다.** — `P0`
  - **이유:** retry가 동일 reminder를 두 번 이동하거나 두 번 dismiss하면 안 된다.
  - **산출물:** operation ID, source version, chosen action, result digest receipt.
  - **검증:** 같은 operation replay가 byte-stable 결과와 동일 receipt를 반환한다.
  - **선행:** 031.

- [ ] **033. 모든 third-party send를 draft-first로 표준화한다.** — `P0`
  - **이유:** 기능별 approval 문구가 달라지면 자동 발송 우회가 생긴다.
  - **산출물:** recipient, channel, payload hash, expiry가 있는 draft와 explicit approve step.
  - **검증:** draft 생성만으로 provider send가 호출되지 않고 stale draft 승인이 거부된다.
  - **선행:** 027, 032.

- [ ] **034. outbound retry와 dedupe를 effect 기준으로 고정한다.** — `P0`
  - **이유:** timeout 뒤 성공 여부를 모를 때 중복 메시지를 보낼 수 있다.
  - **산출물:** effect ID, provider receipt, ambiguous terminal state, manual reconciliation path.
  - **검증:** success-before-ack, timeout, provider duplicate, restart replay fixture에서 최대 한 효과만 생긴다.
  - **선행:** 033.

- [ ] **035. doctor와 qualification이 동일한 delivery-safety result를 소비하게 한다.** — `P0`
  - **이유:** UI는 safe인데 qualification은 unsafe인 상태 차이를 사람이 해석하게 두면 안 된다.
  - **산출물:** local-only, lock, brake, hold, backlog, pending drafts의 공통 projection.
  - **검증:** 동일 fixture에 CLI/API/status/qualification의 reason code가 일치한다.
  - **선행:** 025–034.

- [ ] **036. zero-unapproved-send fault campaign으로 G2를 닫는다.** — `P0`
  - **이유:** 정상 경로 테스트만으로 외부 효과 안전성을 주장할 수 없다.
  - **산출물:** restart, stale config, backlog, retry, partial receipt, provider failure를 포함한 fault report.
  - **검증:** 모든 case에서 unapproved send 0, silent delete 0, silent reschedule 0이며 evaluator가 PASS한다.
  - **선행:** 025–035.

---

## Phase 3 — Browser, CLI, API, Web 표면의 terminal reliability

**진입 조건:** G2 green.

**Exit gate G3:** 현재 확인된 browser confirm 회귀와 CLI 종료 hang이 닫히고, 같은 개인 작업이
CLI/API/Web에서 동일한 terminal state를 만들며 핵심 smoke가 pass^3로 종료된다.

- [ ] **037. Browser JavaScript confirm 실패를 최소 재현한다.** — `P0`
  - **이유:** 전체 smoke 실패를 바로 수정하면 dialog lifecycle과 test timing을 혼동할 수 있다.
  - **산출물:** confirm을 열고 accept한 뒤 title 또는 DOM terminal state를 확인하는 최소 fixture.
  - **검증:** 수정 전 동일 assertion이 결정적으로 red이고 실패 trace가 보존된다.
  - **선행:** 036.

- [ ] **038. dialog open→decision→page continuation lifecycle을 수정한다.** — `P0`
  - **이유:** accept API 성공과 실제 page continuation은 별도 계약이다.
  - **산출물:** pending dialog ownership, exact decision ack, post-dialog navigation/DOM settle 처리.
  - **검증:** accept와 dismiss가 각기 기대한 page state를 만들고 이중 decision을 거부한다.
  - **선행:** 037.

- [ ] **039. dialog 경로에 adversarial browser test를 추가한다.** — `P0`
  - **이유:** alert, confirm, prompt, nested frame, navigation 직전 dialog가 서로 다른 timing을 가진다.
  - **산출물:** 네 dialog family와 disconnect/cancel/race cases.
  - **검증:** 잘못된 dialog 종류·stale dialog ID·timeout은 성공으로 보고되지 않는다.
  - **선행:** 038.

- [ ] **040. browser smoke의 자원 정리와 timeout 계약을 고친다.** — `P0`
  - **이유:** 실패 후 Chromium이나 server가 남으면 다음 검증이 오염된다.
  - **산출물:** top-level `finally`, owned-child registry, bounded shutdown, artifact retention.
  - **검증:** pass, assertion failure, Ctrl-C, timeout 네 경로 뒤 owned process와 temp profile이 남지 않는다.
  - **선행:** 037–039.

- [ ] **041. CLI smoke의 “10 PASS 후 미종료”를 최소 재현한다.** — `P0`
  - **이유:** 기능 성공과 process lifecycle 성공을 분리해 원인을 찾아야 한다.
  - **산출물:** active handles/requests와 child process ancestry를 출력하는 diagnostic fixture.
  - **검증:** 테스트 항목 완료 후 남는 정확한 handle 또는 child가 식별된다.
  - **선행:** 036.

- [ ] **042. CLI child process ownership과 teardown을 수정한다.** — `P0`
  - **이유:** stream, scheduler, MCP, API child 중 하나가 종료되지 않으면 자동화가 영원히 대기한다.
  - **산출물:** 명시적 owner, abort propagation, graceful timeout, forced-owned-child fallback.
  - **검증:** 정상·실패·signal 경로 모두 지정 시간 안에 exit하고 unrelated process는 건드리지 않는다.
  - **선행:** 041.

- [ ] **043. CLI terminal-state와 exit-code 계약을 명령군별로 통일한다.** — `P0`
  - **이유:** 사람이 읽는 PASS 문구와 automation이 받는 exit code가 다르면 gate가 거짓말한다.
  - **산출물:** success, user error, policy block, unverified, internal failure의 exit-code 표.
  - **검증:** 대표 CLI 명령이 stdout/stderr/JSON mode와 일관된 code를 반환한다.
  - **선행:** 042.

- [ ] **044. API boot와 readiness를 분리한다.** — `P0`
  - **이유:** port가 열렸다는 사실이 stores, provider, resident dependency가 준비됐다는 뜻은 아니다.
  - **산출물:** liveness, readiness, degraded reason, no-model/no-network health projection.
  - **검증:** dependency failure 중 liveness는 유지되고 readiness만 정확한 reason으로 red가 된다.
  - **선행:** 043.

- [ ] **045. Web real-browser test의 overlapping `act()` 경고를 제거한다.** — `P1`
  - **이유:** exit 0이어도 비동기 경고는 실제 race와 flaky journey의 전조일 수 있다.
  - **산출물:** user-event 기준 await 경계와 query invalidation settle 계약.
  - **검증:** 128개 browser test가 console warning 0으로 반복 통과한다.
  - **선행:** 044.

- [ ] **046. 핵심 개인-agent journey를 real Chromium으로 묶는다.** — `P1`
  - **이유:** component test만으로 setup→chat→source→Continuity→outcome 연결을 증명할 수 없다.
  - **산출물:** local-only setup, grounded answer, Pack review, explicit outcome, held delivery journey.
  - **검증:** 각 journey가 visible terminal state와 persisted effect를 함께 채점한다.
  - **선행:** 039–045.

- [ ] **047. 동일 작업의 CLI/API/Web parity contract를 만든다.** — `P1`
  - **이유:** adapter별 독자 구현은 permission, error, store semantics drift를 만든다.
  - **산출물:** 공통 operation matrix와 canonical digest/reason projection.
  - **검증:** 같은 fixture에서 세 surface의 allowed effect와 store digest가 일치한다.
  - **선행:** 043–046.

- [ ] **048. surface smoke를 clean process에서 pass^3로 qualification한다.** — `P0`
  - **이유:** 한 번의 green은 lifecycle race와 leaked child를 닫지 못한다.
  - **산출물:** Browser, CLI, API, Web의 세 번 연속 독립 report.
  - **검증:** 각 run이 timeout 없이 exit 0이며 owned process·port·temp profile 누수가 0이다.
  - **선행:** 037–047.

---

## Phase 4 — corrected-fact recall과 memory observability

**진입 조건:** G3 green.

**Exit gate G4:** 최신 교정 사실 2/2, 일반 positive와 absent-fact abstention이 모두 유지되고 전체
11-axis capability battery가 fresh provenance로 pass^3를 달성한다.

- [ ] **049. corrected-fact 실패를 고정된 최소 corpus로 재현한다.** — `P0`
  - **이유:** live battery 전체를 반복하면 후보 retention과 ranking 원인을 분리하기 어렵다.
  - **산출물:** old fact, explicit correction, unrelated distractor, query가 있는 deterministic fixture.
  - **검증:** 현재 실패가 candidate/rank/policy 중 어느 단계인지 trace로 식별된다.
  - **선행:** 048.

- [ ] **050. adaptive-k/MMR 전에 old·current correction pair를 보존한다.** — `P0`
  - **이유:** 최신성과 모순 정책이 비교하기 전에 후보가 제거되면 교정을 선택할 수 없다.
  - **산출물:** correction-aware candidate retention과 bounded expansion rule.
  - **검증:** 2/2 correction case가 통과하고 ordinary top-1 ranking이 유지된다.
  - **선행:** 049.

- [ ] **051. freshness·supersession policy를 versioned deterministic reducer로 만든다.** — `P0`
  - **이유:** 모델 prompt에만 “최신 것을 선호”를 맡기면 재현성과 undo가 없다.
  - **산출물:** timestamp, explicit correction link, confidence, source authority의 우선순위.
  - **검증:** clock tie, out-of-order import, duplicate correction, weak inference cases가 고정 결과를 낸다.
  - **선행:** 050.

- [ ] **052. contradiction과 tombstone을 검색 결과에서 명시적으로 처리한다.** — `P0`
  - **이유:** 삭제·철회된 사실이 embedding 유사도만으로 다시 살아나면 안 된다.
  - **산출물:** active, superseded, disputed, deleted 상태와 recall eligibility.
  - **검증:** tombstoned fact가 answer evidence에 나오지 않고 disputed fact는 불확실성으로 표시된다.
  - **선행:** 051.

- [ ] **053. absent-fact abstention floor를 강화한다.** — `P0`
  - **이유:** correction recall을 높이면서 없는 사실을 지어내는 회귀가 생길 수 있다.
  - **산출물:** minimum support, contradiction-aware abstention, source citation requirement.
  - **검증:** 기존 absent 8/8과 새로운 near-match adversarial cases가 모두 abstain한다.
  - **선행:** 050–052.

- [ ] **054. 자동 memory extraction에 reason-coded terminal outcomes를 추가한다.** — `P0`
  - **이유:** fail-open extraction이 조용히 계속 실패하면 사용자는 Muse가 배우고 있다고 오해한다.
  - **산출물:** `learned`, `nothing_new`, `policy_rejected`, `model_error`, `schema_error`, `store_error`, `timeout`.
  - **검증:** 각 injected failure가 대화를 막지 않으면서 정확한 terminal reason을 기록한다.
  - **선행:** 053.

- [ ] **055. memory learning health를 doctor/status에 bounded projection한다.** — `P1`
  - **이유:** raw trace를 열지 않고도 최근 성공과 연속 실패를 판단할 수 있어야 한다.
  - **산출물:** last success, consecutive failure, fixed-size reason counts, freshness.
  - **검증:** 오래된 성공이 현재 healthy로 보이지 않고 counter가 무한히 자라지 않는다.
  - **선행:** 054.

- [ ] **056. ephemeral·private·policy-rejected turn의 비저장을 재검증한다.** — `P0`
  - **이유:** observability를 추가하면서 금지된 원문이 diagnostic store로 새어 나갈 수 있다.
  - **산출물:** allowed metadata와 forbidden payload의 explicit schema.
  - **검증:** private fixtures의 prompt, answer, secret marker가 memory와 diagnostic bytes 어디에도 없다.
  - **선행:** 054–055.

- [ ] **057. owner가 memory를 inspect·correct·forget·undo할 수 있게 한다.** — `P1`
  - **이유:** 잘못 배운 사실을 고칠 사용자 경로가 없으면 장기 개인화가 위험하다.
  - **산출물:** exact memory ID 기반 preview와 versioned mutation receipt.
  - **검증:** correction과 forget은 idempotent하고 undo 범위·expiry가 명확하며 fuzzy target을 거부한다.
  - **선행:** 051–056.

- [ ] **058. memory conflict를 사용자에게 actionable하게 보여준다.** — `P1`
  - **이유:** “학습 점수”보다 어떤 두 사실이 충돌하며 무엇을 선택할지가 중요하다.
  - **산출물:** exact sources, current policy choice, keep/correct/forget action이 있는 conflict view.
  - **검증:** action 없는 vanity card가 없고 선택 전에는 active policy가 자동 변경되지 않는다.
  - **선행:** 052, 057.

- [ ] **059. 11-axis capability report를 clean snapshot에서 재생성한다.** — `P0`
  - **이유:** focused correction green만으로 전체 agent capability를 합격시킬 수 없다.
  - **산출물:** exact source/artifact provenance를 가진 fresh 11/11 후보 report.
  - **검증:** correction, ordinary positives, abstention, safety, browser, tool selection 등 모든 required axis가 실행된다.
  - **선행:** 049–058.

- [ ] **060. capability aggregate 11/11 strict pass^3로 G4를 닫는다.** — `P0`
  - **이유:** 비결정적 모델·browser 경로는 한 번 통과로 충분하지 않다.
  - **산출물:** 동일 계약의 독립 세 실행과 evaluator 판정.
  - **검증:** 세 번 모두 11/11, skip 0, unverified 0, provenance match이며 quality floor가 낮아지지 않는다.
  - **선행:** 059.

---

## Phase 5 — normal chat에서 Personal Continuity를 닫고 organic evidence 수집하기

**진입 조건:** G4 green.

**Exit gate G5:** normal chat에서 exact-source Continuity loop가 명시적 사용자 권한으로 닫히고, life와
work의 자연스러운 return moment가 여러 날짜에 걸쳐 독립 감사 가능한 수준으로 수집된다. 자동 timing은
여전히 held 상태다.

- [ ] **061. main chat에 최소한의 Continuity tool seam을 노출한다.** — `P1`
  - **이유:** 현재 CLI/Web 전용 흐름은 개인 에이전트의 주된 대화 경험과 분리돼 있다.
  - **산출물:** thread select/create, exact link, Pack preview/open, explicit outcome의 auditable tools.
  - **검증:** tool schema만으로 허용된 effect와 금지된 auto-link/outcome을 구분할 수 있다.
  - **선행:** 060.

- [ ] **062. life/work thread 선택과 생성을 명시적 사용자 행위로 유지한다.** — `P1`
  - **이유:** 대화 주제를 자동으로 인생 영역에 귀속하면 잘못된 개인 inference가 영속화된다.
  - **산출물:** suggested draft와 explicit confirm이 분리된 thread binding.
  - **검증:** 사용자의 선택 없이 thread, kind, link가 store에 생성되지 않는다.
  - **선행:** 061.

- [ ] **063. chat에서 exact local task와 note를 안전하게 연결한다.** — `P1`
  - **이유:** fuzzy name search로 잘못된 개인 항목을 연결하면 Continuity의 근거 가치가 사라진다.
  - **산출물:** canonical ID copy/select, bounded projection, link preview.
  - **검증:** ambiguous prefix, renamed/deleted item, duplicate title은 mutation 전에 거부된다.
  - **선행:** 061–062.

- [ ] **064. Pack preview와 delivery open을 분리한다.** — `P1`
  - **이유:** timing 평가나 화면 미리보기가 실제 delivery receipt로 기록되면 효과 데이터가 오염된다.
  - **산출물:** mutation-free preview와 explicit open authority.
  - **검증:** preview 반복은 store bytes를 바꾸지 않고 open만 단 하나의 delivery를 만든다.
  - **선행:** 063.

- [ ] **065. outcome은 네 개의 explicit 값만 chat에서 기록한다.** — `P1`
  - **이유:** 침묵, task 완료, conversation sentiment를 hidden feedback으로 해석하면 안 된다.
  - **산출물:** `used | adjusted | ignored | rejected` 선택과 optional owner note.
  - **검증:** timeout·task receipt·assistant guess가 outcome을 생성하지 않는다.
  - **선행:** 064.

- [ ] **066. CLI/API/Web/Chat이 하나의 Attunement store와 reducer를 사용하게 한다.** — `P0`
  - **이유:** chat용 두 번째 store가 생기면 evidence와 policy가 갈라진다.
  - **산출물:** 공통 application service와 surface adapter parity.
  - **검증:** 같은 exact operation sequence가 모든 surface에서 동일 digest와 projection을 만든다.
  - **선행:** 061–065.

- [ ] **067. 현재 organic outcome·interaction coverage를 read-only로 다시 계산한다.** — `P1`
  - **이유:** 문서에 남은 0/10, 6/10 같은 날짜별 스냅샷을 실행 계획에 그대로 사용할 수 없다.
  - **산출물:** life/work별 eligible outcome, exact receipt, distinct UTC/local dates, exclusion reasons.
  - **검증:** report 생성 전후 Attunement와 task store bytes가 동일하다.
  - **선행:** 066.

- [ ] **068. 부족한 life return moment를 자연 사용으로 수집한다.** — `P1`
  - **이유:** 같은 세션 grocery fixture는 넓은 일상 복귀 가치를 증명하지 못한다.
  - **산출물:** 서로 다른 실제 주제와 날짜의 exact-linked Pack 및 explicit outcomes.
  - **검증:** agent-operated, synthetic, controlled replay가 organic denominator에서 제외된다.
  - **선행:** 067.

- [ ] **069. life/work exact interaction receipt를 여러 날짜에 걸쳐 수집한다.** — `P1`
  - **이유:** outcome만으로 실제 다음 단계가 진행됐는지 corroborate할 수 없다.
  - **산출물:** 각 kind 최소 계약량과 날짜 coverage를 가진 strict exact receipt report.
  - **검증:** receipt는 usefulness, feedback, consent, promotion으로 집계되지 않는다.
  - **선행:** 067–068.

- [ ] **070. negative outcome을 원인별로 독립 review한다.** — `P1`
  - **이유:** ignored/rejected/adjusted가 없거나 무시되면 positive-only vanity metric이 된다.
  - **산출물:** wrong source, too much detail, bad timing, weak next step, unwanted help의 taxonomy.
  - **검증:** 각 분류가 exact delivery와 owner-authored outcome에 연결되고 모델 추측은 별도 표시된다.
  - **선행:** 068–069.

- [ ] **071. evidence가 지지하는 bounded display-policy change만 적용한다.** — `P1`
  - **이유:** outcome을 근거로 source, permission, recipient, action scope까지 확대하면 안 된다.
  - **산출물:** form, detail, suggestion threshold, suppression 중 하나만 바꾸는 versioned reducer change.
  - **검증:** outcome N→allowed policy delta→Pack N+1 golden test와 reset/undo idempotency가 통과한다.
  - **선행:** 070.

- [ ] **072. organic Continuity evidence를 독립 감사하고 G5를 닫는다.** — `P1`
  - **이유:** 숫자 threshold만 통과해도 natural timing과 domain diversity가 부족할 수 있다.
  - **산출물:** eligibility, exactness, dates, diversity, negatives, receipt/outcome 분리를 검토한 audit.
  - **검증:** evaluator가 raw records를 sample하고 `PASS | FAIL`; PASS여도 automatic delivery 권한은 생성하지 않는다.
  - **선행:** 061–071.

---

## Phase 6 — privacy, permission, sandbox, untrusted-input 경계

**진입 조건:** G4 green. G5 organic evidence는 EVIDENCE/MONITOR lane에서 병행할 수 있고, red 상태가
이 phase의 security·privacy repair를 막지 않는다.

**Exit gate G6:** 개인 데이터 저장과 도구 실행의 owner boundary가 repair 가능하고, injection·SSRF·shell·
store corruption fault에서 권한 확대나 민감정보 유출이 없다는 독립 security 판정을 받는다.

- [ ] **073. 모든 개인 데이터와 효과의 permission matrix를 최신화한다.** — `P0`
  - **이유:** 기능이 늘면서 read, local write, process, network, external send 경계가 drift할 수 있다.
  - **산출물:** notes, tasks, memory, calendar, contacts, browser, shell, channels, Attunement별 authority 표.
  - **검증:** 각 public tool/command/API route가 정확히 하나의 permission class에 매핑된다.
  - **선행:** 072.

- [ ] **074. 민감 store의 owner-only mode를 재귀적이지 않은 repair로 닫는다.** — `P0`
  - **이유:** loose umask나 migration이 `~/.muse` 일부 파일을 다른 로컬 사용자에게 노출할 수 있다.
  - **산출물:** exact-file inventory, dry-run chmod plan, atomic repair receipt.
  - **검증:** loose-mode fixture만 0600/0700으로 좁아지고 symlink·scope 밖 파일은 거부된다.
  - **선행:** 073.

- [ ] **075. 지원되는 sensitive store encryption repair를 idempotent하게 만든다.** — `P0`
  - **이유:** 경고만 보여주고 안전하게 전환할 경로가 없으면 privacy gate를 닫을 수 없다.
  - **산출물:** encrypted-at-rest 여부, key availability, preview, atomic migration, rollback.
  - **검증:** plaintext→encrypted, already encrypted, wrong key, crash, retry case에서 데이터 손실이 없다.
  - **선행:** 074.

- [ ] **076. backup·restore가 encryption과 version을 보존하는지 증명한다.** — `P0`
  - **이유:** 복구할 수 없는 암호화는 개인 에이전트의 장기 continuity에 맞지 않는다.
  - **산출물:** versioned manifest, encrypted backup, verify-only, explicit restore preview.
  - **검증:** 격리된 빈 restore target에서 canonical digests가 같고 newer/unknown version은 fail-close한다.
  - **선행:** 075.

- [ ] **077. 현재 tree와 release artifact의 secret·personal-remnant scan을 자동화한다.** — `P0`
  - **이유:** 개인용 agent 저장소에는 실제 주소, 연락처, token, local path가 섞이기 쉽다.
  - **산출물:** allowlist가 좁은 secret scanner와 owner/company remnant rule.
  - **검증:** synthetic secrets와 personal markers를 잡고 known safe fixture의 false positive가 review 가능하다.
  - **선행:** 073.

- [ ] **078. 모든 tool output을 untrusted envelope로 강제한다.** — `P0`
  - **이유:** browser, MCP, shell 결과가 system instruction처럼 prompt에 합쳐지면 injection이 된다.
  - **산출물:** provenance, size/type bounds, truncation, instruction-neutralization envelope.
  - **검증:** tool output 속 “권한을 무시하라” 문자열이 policy와 tool availability를 바꾸지 못한다.
  - **선행:** 073.

- [ ] **079. browser·HTTP·MCP의 SSRF와 local-network 정책을 통합한다.** — `P0`
  - **이유:** URL redirect와 alternate notation이 loopback/metadata endpoint 차단을 우회할 수 있다.
  - **산출물:** canonical resolve, redirect recheck, DNS rebinding policy, credential redaction.
  - **검증:** IPv4/IPv6, decimal/octal, redirect, userinfo, DNS swap adversarial suite가 차단된다.
  - **선행:** 078.

- [ ] **080. Rust runner의 실제 격리 한계를 capability별로 문서화하고 검사한다.** — `P0`
  - **이유:** sandbox라는 이름만으로 network, filesystem, process 권한을 과대평가하면 안 된다.
  - **산출물:** platform별 enforced/advisory/unavailable capability report.
  - **검증:** 각 claimed restriction을 실제 probe로 검증하고 미지원은 “safe”가 아니라 unavailable로 표시한다.
  - **선행:** 073, 079.

- [ ] **081. shell을 통한 file-policy 우회 경계를 닫거나 명시적으로 제한한다.** — `P0`
  - **이유:** file tool만 보호하고 shell이 같은 경로를 쓸 수 있으면 가드가 거짓말한다.
  - **산출물:** safe-root enforcement, command approval, container requirement 또는 explicit unsupported contract.
  - **검증:** `>` redirection, heredoc, symlink, subprocess, script interpreter의 scope escape가 성공하지 않는다.
  - **선행:** 080.

- [ ] **082. cross-surface prompt-injection fault suite를 운영한다.** — `P0`
  - **이유:** browser만 안전해도 note, calendar, MCP, email-like content가 우회 경로가 될 수 있다.
  - **산출물:** source별 direct/indirect injection corpus와 expected terminal state.
  - **검증:** 각 case에서 secret disclosure 0, permission expansion 0, unapproved tool effect 0을 기록한다.
  - **선행:** 078–081.

- [ ] **083. security audit log의 tamper·size·privacy 경계를 검증한다.** — `P1`
  - **이유:** 무한 raw log는 새 개인정보 저장소가 되고, 수정 가능한 log는 감사 증거가 아니다.
  - **산출물:** bounded retention, integrity chain 또는 immutable receipt, redaction, export/forget policy.
  - **검증:** truncation, partial write, clock rollback, log injection에서 손상이 감지되고 secret marker는 없다.
  - **선행:** 074–082.

- [ ] **084. 독립 adversarial security review로 G6를 닫는다.** — `P0`
  - **이유:** 보안 구현자가 자기 threat model만 평가하면 blind spot이 남는다.
  - **산출물:** permission, privacy, injection, SSRF, runner, outbound의 bundled findings와 판정.
  - **검증:** high/critical blocker 0, medium은 owner가 명시적으로 accept하거나 다음 P0로 남는다.
  - **선행:** 073–083.

---

## Phase 7 — resource governance, performance, provider neutrality

**진입 조건:** G6 green.

**Exit gate G7:** foreground chat이 우선권을 유지하고 background work는 CPU·memory·thermal·queue·retry
budget 안에서 동작하며, 24시간 soak 동안 crash-loop, starvation, unbounded growth가 없다.

- [ ] **085. hard admission state matrix를 완성한다.** — `P0`
  - **이유:** active user, idle, low headroom, thermal pressure를 문장으로만 구분하면 workload마다 다르게 행동한다.
  - **산출물:** state input, unavailable semantics, allowed light/heavy work, cancel/defer decision 표.
  - **검증:** injected state별로 시작 가능한 workload가 정확히 고정된다.
  - **선행:** 084.

- [ ] **086. thermal·battery·memory pressure의 platform별 source를 검증한다.** — `P1`
  - **이유:** macOS thermal만 있고 battery나 다른 platform이 inferred되면 잘못된 admission이 된다.
  - **산출물:** macOS/Windows/Linux별 supported/unavailable probe와 timeout.
  - **검증:** probe failure와 unknown future value가 permissive success로 바뀌지 않는다.
  - **선행:** 085.

- [ ] **087. foreground/background model concurrency budget을 전체 provider 경로에 적용한다.** — `P0`
  - **이유:** 일부 auxiliary call이 coordinator를 우회하면 foreground latency와 local model 안정성이 깨진다.
  - **산출물:** lease owner, priority queue, maximum waiter, timeout, cancellation reason.
  - **검증:** foreground가 queued background보다 먼저 실행되고 bypass provider call이 탐지된다.
  - **선행:** 085.

- [ ] **088. 실제 KV-cache와 model resident memory를 측정한다.** — `P1`
  - **이유:** token window만으로 로컬 모델의 실제 memory pressure를 알 수 없다.
  - **산출물:** provider/model별 observed resident delta, unavailable 표시, safety margin.
  - **검증:** measurement overhead가 bounded이고 추정값은 measured로 표시되지 않는다.
  - **선행:** 086–087.

- [ ] **089. embedding과 indexing에 batch·memory·resume budget을 추가한다.** — `P1`
  - **이유:** 현재 open 상태인 embedding budget이 background responsiveness를 무너뜨릴 수 있다.
  - **산출물:** bounded batch, checkpoint, immutable generation publish, explicit full-reindex override.
  - **검증:** cancel/restart 후 중복 publish 없이 마지막 complete checkpoint에서 재개한다.
  - **선행:** 085, 088.

- [ ] **090. browser work에 page·action·wallclock·memory budget을 통합한다.** — `P1`
  - **이유:** model loop budget과 별개인 browser session이 무한 페이지·popup·download로 확장될 수 있다.
  - **산출물:** per-run browser budget과 terminal `budget_exhausted` state.
  - **검증:** popup storm, redirect loop, huge page, stalled navigation이 명시적 한도에서 종료된다.
  - **선행:** 040, 085.

- [ ] **091. cancellation settlement를 uncooperative provider까지 추적한다.** — `P0`
  - **이유:** 사용자가 취소해도 physical request가 계속 실행되며 lease를 풀면 실제 concurrency가 초과된다.
  - **산출물:** logical cancel, physical settlement, retained lease, late-result discard 계약.
  - **검증:** 취소 후 두 번째 request가 물리적으로 겹치지 않고 late result가 store에 반영되지 않는다.
  - **선행:** 087.

- [ ] **092. foreground starvation과 background starvation을 모두 측정한다.** — `P1`
  - **이유:** foreground 우선만 강화하면 consolidation과 sync가 영원히 실행되지 않을 수 있다.
  - **산출물:** bounded fairness cursor, maximum defer age, owner-visible held reason.
  - **검증:** 지속 foreground fixture에서도 policy가 허용한 최소 background progress 또는 명시적 held 상태가 나온다.
  - **선행:** 087, 091.

- [ ] **093. provider-neutral usage·cost ledger를 정규화한다.** — `P1`
  - **이유:** provider별 token과 cache semantics가 달라 비용 비교가 왜곡될 수 있다.
  - **산출물:** input/output/cache/tool/estimated/unknown 필드와 pricing source freshness.
  - **검증:** unknown price는 0원으로 집계되지 않고 local provider는 비용·자원 지표를 구분한다.
  - **선행:** 087.

- [ ] **094. local-model cold/warm 성능을 반복 측정한다.** — `P1`
  - **이유:** 한 번의 warm run으로 prompt cache와 daily responsiveness를 주장할 수 없다.
  - **산출물:** multiple-attempt median/p95, time-to-first-token, total latency, cache hit evidence.
  - **검증:** cold/warm 분류가 실제 cache state에 묶이고 quality·grounding gate가 동일하다.
  - **선행:** 088, 093.

- [ ] **095. constrained-resource recovery fault campaign을 실행한다.** — `P0`
  - **이유:** low memory·thermal 상태에서 defer한 뒤 recovery가 영원히 멈추거나 한꺼번에 폭주할 수 있다.
  - **산출물:** pressure→defer→recover→re-admit trace와 queue bounds.
  - **검증:** 압박 중 heavy start 0, foreground responsive, 복구 후 cadence 안에 bounded progress가 일어난다.
  - **선행:** 085–094.

- [ ] **096. resident 24시간 soak와 resource G7을 닫는다.** — `P0`
  - **이유:** queue leak, heartbeat drift, memory growth, retry storm은 짧은 test에서 잘 보이지 않는다.
  - **산출물:** 24h CPU/RSS/queue/heartbeat/workload summary와 exact failures.
  - **검증:** crash-loop 0, unbounded growth 0, budget breach 0, foreground SLO 유지, evaluator PASS.
  - **선행:** 085–095.

---

## Phase 8 — 설치 후 10분 안에 첫 가치에 도달하는 UX

**진입 조건:** G7 green.

**Exit gate G8:** 실제 owner가 격리된 빈 Muse state에서 provider와 local/cloud 경계를 이해하고, 10분
안에 첫 source-backed answer와 첫 user-invoked Continuity Pack을 완료하며 실패 시 스스로 repair할 수 있다.

- [ ] **097. Muse의 golden owner journey와 성공 시간을 정의한다.** — `P1`
  - **이유:** 기능별 wizard를 연결해도 사용자가 어떤 가치를 언제 얻는지 모르면 onboarding이 끝나지 않는다.
  - **산출물:** install→privacy choice→provider→local source→first answer→first Pack journey.
  - **검증:** 각 단계의 terminal state, 최대 시간, 실패 복구, forbidden hidden action이 측정 가능하다.
  - **선행:** 096.

- [ ] **098. owner-scoped macOS installer 경로를 하나로 통합한다.** — `P1`
  - **이유:** source checkout과 여러 setup 명령은 개인용 제품의 진입 장벽이 높다.
  - **산출물:** signed 또는 개발단계의 clearly labeled package, stable CLI/app path, version receipt.
  - **검증:** 현재 owner의 격리된 빈 Muse state에서 Node/pnpm 지식 없이 설치가 끝나고 임시 checkout
    경로가 남지 않는다.
  - **선행:** 021–024, 097.

- [ ] **099. 첫 실행에서 local-only와 cloud egress를 명시적으로 선택하게 한다.** — `P0`
  - **이유:** provider를 고르는 행위가 어떤 데이터가 기기를 떠나는지 자동으로 설명하지 않는다.
  - **산출물:** data-flow preview, local-only 기본값, per-provider egress summary, change path.
  - **검증:** 선택 전 cloud request 0이며 선택 결과가 persisted policy와 live runtime에 일치한다.
  - **선행:** 025, 073, 098.

- [ ] **100. provider setup을 credential-safe diagnostic과 연결한다.** — `P1`
  - **이유:** auth 실패를 일반 model error로 보여주면 사용자가 위험한 재설정을 반복한다.
  - **산출물:** provider discovery, secret input, redacted verify, model capability summary.
  - **검증:** logs/trace/UI에 credential marker가 없고 invalid auth가 actionable reason을 낸다.
  - **선행:** 077, 093, 099.

- [ ] **101. first chat의 zero-data 상태를 유용하게 만든다.** — `P1`
  - **이유:** 개인 데이터가 없는 첫 화면에서 빈 dashboard나 과도한 설정이 나오면 가치가 전달되지 않는다.
  - **산출물:** local demo source 또는 사용자가 선택한 첫 note/task를 만드는 guided path.
  - **검증:** fixture 데이터와 user data가 명확히 구분되고 demo가 memory/organic evidence로 집계되지 않는다.
  - **선행:** 100.

- [ ] **102. 첫 source-backed answer까지의 경로를 측정한다.** — `P1`
  - **이유:** Muse의 핵심 차별화는 일반 chat이 아니라 exact personal grounding이다.
  - **산출물:** source 선택, cited answer, source inspect, correction action.
  - **검증:** 10분 budget 안에 완료되고 source가 없으면 unsupported claim을 생략한다.
  - **선행:** 101.

- [ ] **103. 첫 user-invoked Continuity Pack을 onboarding에 연결한다.** — `P1`
  - **이유:** 사용자가 Attunement 가치를 별도 CLI 문서를 읽어야만 발견해서는 안 된다.
  - **산출물:** life/work thread 선택, exact link, Pack open, outcome 설명의 thin journey.
  - **검증:** 자동 thread/link/outcome은 0이고 preview와 delivery가 분리된다.
  - **선행:** 061–066, 102.

- [ ] **104. 기본 status를 “다음 안전한 행동” 중심으로 정리한다.** — `P1`
  - **이유:** token·turn·activity 수치는 개인적 가치가 아니라 diagnostics다.
  - **산출물:** held actions, pending review, runtime health, evidence gap, exact repair action cards.
  - **검증:** action 없는 card를 제거하고 0/unverified를 success처럼 표시하지 않는다.
  - **선행:** 035, 055, 067, 103.

- [ ] **105. 주요 red 상태에 preview-first repair wizard를 제공한다.** — `P1`
  - **이유:** doctor가 문제만 설명하고 고칠 안전한 경로가 없으면 매일 사용할 수 없다.
  - **산출물:** resident, permission mode, encryption, provider auth, held backlog별 exact plan.
  - **검증:** preview는 무변경, stale target은 apply 거부, destructive step은 별도 확인을 요구한다.
  - **선행:** 020, 031, 074–076, 100, 104.

- [ ] **106. keyboard, screen-reader, contrast, reduced-motion 접근성을 검증한다.** — `P1`
  - **이유:** 개인 도구는 반복 사용되므로 작은 접근성 결함이 누적 마찰이 된다.
  - **산출물:** core journey의 semantic labels, focus order, status announcement, motion fallback.
  - **검증:** automated a11y와 keyboard-only real-browser journey가 함께 통과한다.
  - **선행:** 103–105.

- [ ] **107. 한국어·영어 핵심 계약과 오류 표현을 정리한다.** — `P2`
  - **이유:** permission, held, unverified, draft 같은 단어가 번역마다 다른 의미가 되면 안전성이 약해진다.
  - **산출물:** canonical terms, locale fallback, no-dead-string check.
  - **검증:** 두 locale에서 같은 action/permission semantics와 terminal state가 표시된다.
  - **선행:** 104–106.

- [ ] **108. owner onboarding을 격리된 빈 state의 독립 pass^3로 검증해 G8을 닫는다.** — `P1`
  - **이유:** 개발자 기억에 의존한 한 번의 성공은 설치 경험 증거가 아니다.
  - **산출물:** 서로 격리된 owner-state 실행 세 개의 completion time, blockers, recovery actions, final state.
  - **검증:** 세 번 모두 10분 내 first cited answer와 Pack, unapproved egress/send 0, evaluator PASS.
  - **선행:** 097–107.

---

## Phase 9 — Observe, rhythm, timing, adaptation을 shadow부터 열기

**진입 조건:** G8 green이며 G5 organic audit도 계속 green.

**Exit gate G9:** Observe는 명시적 consent·pause·forget 경계 안에서만 작동하고, timing은 shadow와
owner-reviewed local/log-only cohort를 통과한다. 어떤 PASS도 지속 자율 권한을 자동 부여하지 않는다.

- [ ] **109. Observe consent를 category와 duration별 explicit grant로 만든다.** — `P0`
  - **이유:** “관찰 허용” 한 번으로 모든 앱·데이터·기간을 포괄하면 개인용 trust가 무너진다.
  - **산출물:** category, source, retention, purpose, expiry가 있는 versioned grant.
  - **검증:** grant가 없는 category event는 수집·영속되지 않고 scope 확대는 새 승인을 요구한다.
  - **선행:** 108.

- [ ] **110. Observe inspect·pause·resume·forget을 owner action으로 닫는다.** — `P0`
  - **이유:** 사용자는 무엇이 기록되는지 보고 즉시 중단·삭제할 수 있어야 한다.
  - **산출물:** live state, bounded ledger view, pause reason, exact forget preview와 receipt.
  - **검증:** pause 후 새 event 0, forget은 target만 지우며 resume이 이전 scope를 넓히지 않는다.
  - **선행:** 109.

- [ ] **111. O1 category-only collector의 data minimization을 증명한다.** — `P0`
  - **이유:** 초기 timing 연구에 window title, content, keystroke 원문은 필요하지 않다.
  - **산출물:** allowed category/timestamp schema와 forbidden payload scanner.
  - **검증:** synthetic secret/title/content marker가 raw store, trace, report에 남지 않는다.
  - **선행:** 109–110.

- [ ] **112. Observe export·retention·corruption recovery를 완성한다.** — `P1`
  - **이유:** 장기 rhythm 데이터는 새로운 민감 store이므로 수명과 복구가 명확해야 한다.
  - **산출물:** bounded retention, owner export, partial-write quarantine, version migration.
  - **검증:** expired data는 정책대로 제거되고 corrupt record는 전체 ledger를 열지 못하게 하지 않는다.
  - **선행:** 111.

- [ ] **113. rhythm feature를 offline read-only 분석으로만 시작한다.** — `P2`
  - **이유:** 충분한 데이터 전에 실시간 policy와 결합하면 false pattern이 행동으로 번진다.
  - **산출물:** stable focus/category transitions, time windows, uncertainty가 있는 local analysis.
  - **검증:** 분석 실행이 delivery, task, outcome, permission store를 바꾸지 않는다.
  - **선행:** 112.

- [ ] **114. friction hypothesis를 evidence와 반증 조건을 가진 proposal로 만든다.** — `P2`
  - **이유:** 반복 전환을 곧바로 “사용자가 막혔다”고 해석하면 잘못된 심리 추론이 된다.
  - **산출물:** observed facts, bounded hypothesis, alternative explanations, falsifier, no-action 기본값.
  - **검증:** 동일 observation에 여러 설명이 가능하면 confident fact로 저장되지 않는다.
  - **선행:** 113.

- [ ] **115. timing reducer를 shadow-only로 replay한다.** — `P2`
  - **이유:** 실제 알림 전에 언제 `silent | digest | offer`를 선택했을지 검토해야 한다.
  - **산출물:** input snapshot, policy version, decision, cooldown reason의 mutation-free shadow ledger.
  - **검증:** shadow 실행이 delivery open 또는 channel send를 하나도 만들지 않는다.
  - **선행:** 113–114.

- [ ] **116. timing false-positive와 false-negative를 owner review로 채점한다.** — `P2`
  - **이유:** offer 수나 click 수만으로 적절한 타이밍을 평가할 수 없다.
  - **산출물:** should-offer, should-stay-silent, too-early, too-late, wrong-thread review set.
  - **검증:** owner label과 shadow decision이 exact timestamp/policy input에 연결된다.
  - **선행:** 115.

- [ ] **117. cooldown·suppression·focus-boundary policy를 보수적으로 조정한다.** — `P2`
  - **이유:** 초기 proactivity에서는 도움 누락보다 반복 방해의 신뢰 비용이 더 크다.
  - **산출물:** deterministic cooldown, rejection suppression, stable-focus minimum, daily cap.
  - **검증:** repeated event storm과 rejected thread가 repeated offer를 만들지 않는다.
  - **선행:** 116.

- [ ] **118. 단일 low-risk local/log-only cohort의 exact preview를 만든다.** — `P2`
  - **이유:** broad channel delivery 전에 payload, timing, target, brake를 owner가 한 번에 검토해야 한다.
  - **산출물:** cohort membership, proposed Pack, schedule window, resource state, abort criteria.
  - **검증:** preview 생성은 delivery 0이며 cohort 밖 항목이나 unavailable source가 포함되면 거부된다.
  - **선행:** 117.

- [ ] **119. owner-confirmed controlled timing cohort를 실행한다.** — `P2`
  - **이유:** shadow 정확성과 실제 interruption 비용은 다르다.
  - **산출물:** 각 proposal의 exact delivery, explicit outcome, timing review, resource/safety receipt.
  - **검증:** unapproved send 0, budget breach 0, reminder quarantine 위반 0, 모든 proposal에 review state가 있다.
  - **선행:** 118 및 owner의 cohort 승인.

- [ ] **120. G9 promotion review에서 지속 자동화 권한을 별도로 판정한다.** — `P0`
  - **이유:** 한 cohort PASS가 ongoing autonomy를 자동 생성해서는 안 된다.
  - **산출물:** continue shadow, repeat cohort, narrow grant, reject 중 하나의 owner decision과 expiry.
  - **검증:** decision이 없거나 evidence가 stale하면 runtime은 user-invoked/held 상태를 유지한다.
  - **선행:** 109–119.

---

## Phase 10 — OpenClaw·Hermes와 다른 방식으로 경쟁력 확장

**진입 조건:** G9가 최소 shadow PASS이며 G1–G8이 계속 green.

**Exit gate G10:** “기능 수 따라잡기”가 아니라 exact personal grounding·accountable adaptation을 강화하는
확장만 선택됐고, 추가 channel/skill/subagent가 기존 safety와 daily-value gate를 악화시키지 않는다.

- [ ] **121. Muse의 positioning contract를 한 문장과 세 proof로 고정한다.** — `P1`
  - **이유:** OpenClaw를 channel 수로, Hermes를 self-improvement 속도로 쫓으면 Muse의 강점이 흐려진다.
  - **산출물:** exact-source continuity, explicit outcome learning, no-silent-permission-expansion의 product contract.
  - **검증:** README, onboarding, status, release notes의 claims가 현재 증거보다 넓지 않다.
  - **선행:** 120.

- [ ] **122. channel 확장 기준을 사용 빈도·효과·보안 비용으로 정의한다.** — `P2`
  - **이유:** “20+ channels” parity는 단일 사용자 제품에 불필요한 유지보수와 공격면을 만든다.
  - **산출물:** owner usage, notification fit, draft/approval support, maintenance cost scorecard.
  - **검증:** 점수가 낮은 channel은 구현 backlog가 아니라 rejected/deferred decision으로 남는다.
  - **선행:** 121.

- [ ] **123. 가장 가치 높은 한 channel을 golden adapter로 완성한다.** — `P2`
  - **이유:** 여러 얕은 adapter보다 한 개의 reliable inbound/outbound/dedupe/approval 경로가 중요하다.
  - **산출물:** setup, health, inbound identity, draft, approve, delivery receipt, retry, revoke journey.
  - **검증:** duplicate webhook, reconnect, token revoke, ambiguous send가 exact terminal state를 만든다.
  - **선행:** 033–035, 122.

- [ ] **124. 모든 channel에 공통 conformance suite를 적용한다.** — `P2`
  - **이유:** adapter별로 recipient, thread, attachment, retry semantics가 drift할 수 있다.
  - **산출물:** capability declaration과 required/unsupported behavior suite.
  - **검증:** unsupported 기능은 silent fallback하지 않고, 모든 outbound는 공통 approval/dedupe gate를 지난다.
  - **선행:** 123.

- [ ] **125. MCP discovery·install·permission UX를 제품 수준으로 만든다.** — `P2`
  - **이유:** 강한 MCP 기반이 있어도 사용자가 trust와 capability를 이해하지 못하면 실사용 가치가 낮다.
  - **산출물:** server identity, tool diff, requested permissions, local/remote transport, health/revoke view.
  - **검증:** server/tool 변경은 재승인을 요구하고 untrusted metadata가 policy 설명을 바꾸지 못한다.
  - **선행:** 073, 078, 121.

- [ ] **126. skill lifecycle을 proposal-first로 통일한다.** — `P2`
  - **이유:** Hermes처럼 빠른 self-edit를 그대로 복제하면 Muse의 accountable adaptation 강점을 잃는다.
  - **산출물:** observe→draft→test→review→activate→rollback 상태 머신.
  - **검증:** self-learning hold와 review 전에는 active skill bytes가 바뀌지 않는다.
  - **선행:** 028, 120, 125.

- [ ] **127. correction에서 skill/memory proposal을 생성하되 자동 적용하지 않는다.** — `P2`
  - **이유:** 반복 교정을 학습하는 가치는 크지만 대화 한 번으로 durable behavior를 바꾸면 위험하다.
  - **산출물:** exact source, proposed diff, expected benefit, risk, expiry가 있는 proposal.
  - **검증:** sensitive/private turn은 proposal을 만들지 않고 duplicate correction은 dedupe된다.
  - **선행:** 054–058, 126.

- [ ] **128. held-out evaluation을 통과한 proposal만 owner에게 제시한다.** — `P2`
  - **이유:** training example에 맞춘 skill이 일반 작업을 망가뜨릴 수 있다.
  - **산출물:** train/held-out 분리, behavioral rubric, regression budget, rollback checkpoint.
  - **검증:** held-out 실패가 activate action을 disabled하고 기존 active behavior를 유지한다.
  - **선행:** 127.

- [ ] **129. session crash recovery와 resume pending을 일상 journey로 검증한다.** — `P1`
  - **이유:** OpenClaw·Hermes의 실용성은 긴 작업이 중단돼도 복귀하는 운영 경험에서 나온다.
  - **산출물:** checkpoint identity, pending effect reconciliation, exact resume preview.
  - **검증:** crash-before/after-effect, corrupt checkpoint, version mismatch에서 중복 효과 없이 복구 또는 거부한다.
  - **선행:** 096, 121.

- [ ] **130. voice·mobile companion은 evidence-based go/no-go로 결정한다.** — `P3`
  - **이유:** 매력적인 표면이지만 현재 사용자의 return moment를 실제로 줄이지 않으면 큰 우회다.
  - **산출물:** concrete owner journeys, latency/privacy constraints, existing surface로 해결 가능한지 비교.
  - **검증:** 최소 두 개의 반복되는 organic need가 없으면 구현하지 않는 결정이 기록된다.
  - **선행:** 072, 121.

- [ ] **131. subagent 확장은 single-agent 대비 결과 이득을 먼저 증명한다.** — `P2`
  - **이유:** multi-agent는 token, conflict, permission surface를 크게 늘린다.
  - **산출물:** bounded task family, single-agent baseline, supervisor trial, cost/quality/failure comparison.
  - **검증:** held-out 결과와 pass^k가 명확히 개선되지 않으면 기본 경로로 승격하지 않는다.
  - **선행:** 060, 084, 096.

- [ ] **132. 분기별 competitor delta review로 G10을 유지한다.** — `P3`
  - **이유:** 한 번의 teardown을 영구 현재 상태처럼 사용하면 잘못된 parity 작업이 생긴다.
  - **산출물:** 공식 release/doc 기준 OpenClaw·Hermes delta, Muse fit, adopt/reject/defer decision.
  - **검증:** 경쟁 기능마다 user problem, safety fit, evidence gate가 없으면 backlog에 넣지 않는다.
  - **선행:** 121–131.

---

## Phase 11 — repository 신뢰, 배포, 30일 가치 검증, 출시

**진입 조건:** release label에 따라 다르다. Engineering alpha는 G0–G4와 G6–G8이 green이어야 한다.
Evidence-backed personal-agent release는 추가로 G5, Task 121, 133–143이 green이어야 한다.
G9 proactive timing과 G10 competitor expansion은 이 phase의 필수 선행조건이 아니다.

**Exit gate G11:** 설치·저장소·release artifact가 하나의 신뢰 가능한 경로를 가리키고, 30일 daily-use
evidence와 release-readiness가 독립 PASS를 받는다. 공개 배포는 현재 증거보다 넓은 claim을 하지 않는다.

- [ ] **133. package metadata를 canonical `muse-agent` repository로 교정한다.** — `P1`
  - **이유:** 현재 package metadata가 예전 `wlsdks/Muse`를 가리켜 discovery와 issue provenance가 갈라진다.
  - **산출물:** repository, homepage, bugs, source install 링크의 단일 canonical target.
  - **검증:** package tarball과 README의 모든 canonical link가 같은 현재 repository를 가리킨다.
  - **선행:** 121.

- [ ] **134. 예전 repository의 archive·redirect·history 정책을 정한다.** — `P1`
  - **이유:** 서로 다른 README와 과장 claim이 남으면 사용자와 검색엔진이 잘못된 제품을 본다.
  - **산출물:** canonical notice, migration link, issue handling, private/public history safety 결정.
  - **검증:** old entrypoint에서 current install과 current claims까지 한 번에 이동할 수 있다.
  - **선행:** 133 및 owner의 repository-state 결정.

- [ ] **135. README claim을 shipped·experimental·roadmap·not-proven으로 분리한다.** — `P1`
  - **이유:** 구현 존재와 개인적 효과 증명을 같은 표현으로 쓰면 신뢰를 잃는다.
  - **산출물:** “works today”, boundaries, current qualification, Attunement status, comparison claim 표.
  - **검증:** 각 강한 claim이 fresh report 또는 code contract에 연결되고 absolute safety claim이 없다.
  - **선행:** 121, 133–134.

- [ ] **136. install·upgrade·repair·backup·uninstall 문서를 golden path로 통합한다.** — `P1`
  - **이유:** 운영 경로가 여러 문서에 흩어지면 실제 장애에서 위험한 명령을 추측하게 된다.
  - **산출물:** platform별 commands, expected state, rollback, preserve-data 경계.
  - **검증:** fresh reader가 문서만으로 격리된 owner-state journey를 완료하고 destructive ambiguity가 없다.
  - **선행:** 021–024, 075–076, 098, 133.

- [ ] **137. version·CHANGELOG·migration contract를 release artifact에 묶는다.** — `P1`
  - **이유:** HEAD와 최신 tag가 다를 때 어떤 store/runtime 계약이 설치되는지 명확해야 한다.
  - **산출물:** semver decision, Keep-a-Changelog entry, migration compatibility, minimum runtime.
  - **검증:** built binary/package의 version, tag candidate, changelog, migration version이 일치한다.
  - **선행:** 136.

- [ ] **138. macOS signed artifact와 Gatekeeper path를 검증한다.** — `P1`
  - **이유:** source checkout이 아닌 일상 제품은 설치 출처와 변조 여부를 증명해야 한다.
  - **산출물:** signed app/CLI/installer, entitlements inventory, notarization 또는 명시적 pre-release
    boundary와 현재 owner의 installed-candidate lifecycle receipt.
  - **검증:** 현재 owner profile에서 signature, quarantine, first launch가 유효하고 격리된 candidate
    install→start→heartbeat→status→stop→start에서 single writer, artifact·PID·generation·heartbeat
    일치와 외부 전송 0을 확인한다.
  - **선행:** 098, 137.

- [ ] **139. release provenance, SBOM, secret scan, dependency audit를 생성한다.** — `P0`
  - **이유:** 개인 데이터와 shell/browser 권한을 가진 agent는 공급망 출처가 특히 중요하다.
  - **산출물:** source commit, reproducible build inputs, checksums, SBOM, vulnerability/secret reports.
  - **검증:** artifact checksum이 provenance와 일치하고 high/critical finding은 release를 막는다.
  - **선행:** 077, 084, 137–138.

- [ ] **140. telemetry와 crash reporting을 privacy-first opt-in으로 정한다.** — `P1`
  - **이유:** 제품 개선을 위해 personal prompts와 source contents를 자동 수집하면 Muse의 가치 제안과 충돌한다.
  - **산출물:** default-off 또는 명시적 opt-in, allowed fields, local inspect/export/delete, retention.
  - **검증:** opt-out fixture에서 network event 0이고 opt-in payload에 content/secret marker가 없다.
  - **선행:** 073–084, 138.

- [ ] **141. 30일 owner dogfood를 고정된 운영 규칙으로 수행한다.** — `P1`
  - **이유:** 며칠의 집중 테스트는 일상 복귀, 장기 memory, daemon drift를 증명하지 못한다.
  - **산출물:** daily health, real return moments, failures, repairs, held actions, explicit outcomes의 bounded journal.
  - **검증:** synthetic/agent-operated 행은 별도 표시되고 missing days와 disabled periods도 denominator에 남는다.
  - **선행:** 024, 036, 060, 072, 084, 096, 108, 120.

- [ ] **142. 30일 evidence로 personal-value scorecard와 kill criteria를 판정한다.** — `P1`
  - **이유:** 기능이 많아도 resume time, correction cost, unwanted interruption이 개선되지 않으면 가치가 없다.
  - **산출물:** time-to-resume, exact-source success, corrected-fact retention, used/adjusted/ignored/rejected,
    unwanted-send/interruption, repair burden의 evidence-class-aware report.
  - **검증:** denominator, dates, missingness, negatives가 명시되고 technical metrics가 usefulness로 승격되지 않는다.
  - **선행:** 141.

- [ ] **143. immutable release-readiness gate를 독립 실행한다.** — `P0`
  - **이유:** green local tests만으로 stale artifact나 organic blocker를 덮고 release하면 안 된다.
  - **산출물:** HEAD/time/input-hash-bound runtime, delivery, recall, security, resource, onboarding, organic,
    packaging report와 138의 owner-scoped installed-candidate lifecycle receipt.
  - **검증:** required 축 하나라도 failed/unverified/stale이거나 138의 lifecycle receipt가 current
    signed candidate와 일치하지 않으면 aggregate는 FAILED이며 tag/release를 막는다.
  - **선행:** 133–142.

- [ ] **144. 첫 evidence-backed personal-agent release와 회고를 완료한다.** — `P1`
  - **이유:** release는 코드 업로드가 아니라 설치 가능한 artifact와 정직한 claim의 운영 사건이다.
  - **산출물:** approved version, immutable tag, published artifact, install verification, rollback plan,
    post-release incident/value review.
  - **검증:** tag가 정확한 approved commit을 가리키고 격리된 owner-state install·upgrade·rollback이 통과하며,
    organic value는 142가 증명한 범위로만 서술된다.
  - **선행:** 143 PASS와 owner의 release 범위 결정.

---

## Phase 12 — post-release reliability와 incident recovery

**진입 조건:** G11 green으로 첫 evidence-backed release가 설치 가능하다.

**Exit gate G12:** 실제 설치된 release의 health·update·rollback·incident path가 검증되고, 장애가
개인 데이터 손상이나 중복 외부 효과로 확대되지 않는다.

- [ ] **145. 설치된 release의 runtime health receipt를 version에 묶는다.** — `P0`
  - **이유:** source checkout green과 사용자가 실행하는 signed artifact의 상태는 다를 수 있다.
  - **산출물:** installed version, artifact checksum, resident identity, config generation, heartbeat가 있는 receipt.
  - **검증:** upgrade 전후 receipt가 정확히 바뀌고 다른 artifact의 health를 현재 release로 인정하지 않는다.
  - **선행:** 144.

- [ ] **146. crash-free session과 resident uptime을 privacy-safe하게 집계한다.** — `P1`
  - **이유:** 개별 crash report만으로 일상 안정성이 개선되는지 판단하기 어렵다.
  - **산출물:** local bounded counters, version window, denominator, opted-in export path.
  - **검증:** prompt/source content 없이 crash-free rate와 unknown/missing interval을 구분한다.
  - **선행:** 140, 145.

- [ ] **147. incident severity와 owner-facing response contract를 만든다.** — `P0`
  - **이유:** daemon 중단과 데이터 손상·잘못된 전송을 같은 방식으로 처리하면 위험하다.
  - **산출물:** SEV taxonomy, containment first action, evidence preservation, recovery owner, escalation threshold.
  - **검증:** 대표 incident가 하나의 severity와 실행 가능한 runbook에 매핑된다.
  - **선행:** 145–146.

- [ ] **148. release rollback을 data-compatible하고 effect-safe하게 만든다.** — `P0`
  - **이유:** binary만 되돌려도 새 schema나 pending delivery가 구버전과 충돌할 수 있다.
  - **산출물:** compatibility preflight, pending-effect brake, previous artifact restore, post-rollback health check.
  - **검증:** rollback 중 crash와 incompatible store fixture가 데이터 변경 전에 fail-close한다.
  - **선행:** 137–139, 147.

- [ ] **149. migration 실패를 forward-fix 또는 restore로 결정하는 정책을 만든다.** — `P0`
  - **이유:** 자동 재시도와 downgrade가 손상 범위를 키울 수 있다.
  - **산출물:** migration journal, last-safe checkpoint, reversible/irreversible classification, owner preview.
  - **검증:** partial migration, checksum mismatch, disk-full, old binary 실행이 결정적 terminal state를 만든다.
  - **선행:** 076, 137, 148.

- [ ] **150. privacy-safe support bundle을 생성한다.** — `P1`
  - **이유:** 장애 분석을 위해 전체 `~/.muse`를 공유하게 만들면 안 된다.
  - **산출물:** allowlisted diagnostics, redaction manifest, exact preview, local archive, expiry.
  - **검증:** seeded secret·prompt·contact·calendar content가 bundle에 없고 누락 필드는 명시된다.
  - **선행:** 077, 083, 147.

- [ ] **151. stable·candidate update channel과 downgrade 경계를 분리한다.** — `P1`
  - **이유:** 실험 release가 일상 resident에 자동 설치되면 organic evidence와 데이터가 오염된다.
  - **산출물:** explicit channel selection, signed manifest, minimum/maximum compatible store version.
  - **검증:** candidate opt-in 없이 stable 사용자가 prerelease를 받지 않는다.
  - **선행:** 137–149.

- [ ] **152. release cohort와 rollout pause를 owner-controlled하게 만든다.** — `P1`
  - **이유:** 단일 사용자라도 desktop, CLI, daemon artifact가 동시에 바뀌면 원인 분리가 어렵다.
  - **산출물:** component rollout order, health checkpoint, pause/resume, rollback trigger.
  - **검증:** 한 component 실패 시 나머지 rollout이 멈추고 mixed-version support 상태가 표시된다.
  - **선행:** 145, 151.

- [ ] **153. resident canary를 외부 효과 없는 synthetic probe로 만든다.** — `P1`
  - **이유:** 실제 reminder나 message로 daemon 생존을 시험하면 사용자에게 부작용이 생긴다.
  - **산출물:** no-model/no-network/no-send canary와 expected trace.
  - **검증:** canary는 heartbeat·scheduler·store read만 확인하고 personal outcome에 집계되지 않는다.
  - **선행:** 145–152.

- [ ] **154. regression을 release→commit→artifact까지 자동 bisect 가능하게 만든다.** — `P2`
  - **이유:** 빠른 개발에서 문제가 시작된 version을 수동 추측하면 복구가 늦어진다.
  - **산출물:** versioned reports, artifact provenance query, deterministic reproducer entrypoint.
  - **검증:** 알려진 injected regression의 최초 bad artifact를 오염 없는 fixture에서 찾는다.
  - **선행:** 003, 139, 153.

- [ ] **155. reliability SLO와 error budget을 개인 사용 가치에 맞게 정의한다.** — `P1`
  - **이유:** uptime만 높고 resume·send·memory가 실패하면 개인 에이전트는 유용하지 않다.
  - **산출물:** resident freshness, successful safe resume, duplicate effect, recovery burden의 SLO.
  - **검증:** denominator와 missing time이 명시되고 budget 초과가 feature rollout을 자동 hold한다.
  - **선행:** 142, 146, 154.

- [ ] **156. post-release incident drill로 G12를 닫는다.** — `P0`
  - **이유:** 문서화된 rollback과 support path가 실제 설치 환경에서 작동하는지 증명해야 한다.
  - **산출물:** crash-loop, migration failure, bad update, ambiguous send의 drill report.
  - **검증:** data loss 0, duplicate external effect 0, bounded recovery time, evaluator PASS.
  - **선행:** 145–155.

---

## Phase 13 — 장기 personal memory를 시간·모순·망각까지 다루기

**진입 조건:** G12 green이고 G4 corrected recall이 계속 green이다.

**Exit gate G13:** 사실·선호·episode·strategy가 출처와 시간 범위를 가진 채 저장·검색·교정·망각되고,
장기 사용에서도 오래된 정보가 최신 진실을 덮지 않는다.

- [ ] **157. personal memory source taxonomy를 canonical schema로 만든다.** — `P1`
  - **이유:** user statement, inferred pattern, imported note, task receipt의 권위가 서로 다르다.
  - **산출물:** source class, authority, consent, retention, allowed use 필드.
  - **검증:** source가 없는 memory는 active recall과 policy learning에 들어가지 않는다.
  - **선행:** 051–058, 156.

- [ ] **158. 시간 범위를 가진 사실을 first-class로 지원한다.** — `P1`
  - **이유:** 주소, 직장, 선호는 “항상 참”이 아니라 특정 기간에만 참일 수 있다.
  - **산출물:** valid-from/to, recorded-at, observed-at, uncertainty semantics.
  - **검증:** 과거 시점 질문과 현재 질문이 같은 사실 history에서 다른 정확한 답을 낸다.
  - **선행:** 157.

- [ ] **159. preference strength와 evolution을 explicit evidence로 모델링한다.** — `P1`
  - **이유:** 한 번의 선택을 영구 선호로 저장하면 개인화가 오히려 불편해진다.
  - **산출물:** stated/observed, strength, scope, repetition, contradiction, expiry가 있는 preference.
  - **검증:** single weak observation은 durable strong preference로 승격되지 않는다.
  - **선행:** 157–158.

- [ ] **160. episodic·semantic·procedural memory 경계를 분리한다.** — `P1`
  - **이유:** 한 사건, 지속 사실, 실행 전략은 검색과 망각 정책이 달라야 한다.
  - **산출물:** store/interface separation과 cross-reference 규칙.
  - **검증:** episode 삭제가 독립적으로 확인된 semantic fact나 approved skill을 자동 삭제하지 않는다.
  - **선행:** 157–159.

- [ ] **161. entity alias와 동일인 충돌을 owner-confirmed하게 해결한다.** — `P1`
  - **이유:** 같은 이름의 사람·프로젝트를 자동 병합하면 개인 정보가 잘못 연결된다.
  - **산출물:** exact entity IDs, candidate alias proposal, merge/split preview, undo receipt.
  - **검증:** ambiguous name은 자동 merge되지 않고 split 후 이전 links가 정확히 복구된다.
  - **선행:** 160.

- [ ] **162. memory confidence를 calibrated support로 계산한다.** — `P2`
  - **이유:** 모델 confidence 숫자는 실제 정확도와 일치하지 않을 수 있다.
  - **산출물:** source authority, recency, corroboration, contradiction을 사용한 deterministic support bands.
  - **검증:** held-out correction corpus에서 high-support false claim 비율이 정한 floor를 넘지 않는다.
  - **선행:** 158–161.

- [ ] **163. recall 결과에 “왜 기억했는지”를 bounded하게 설명한다.** — `P1`
  - **이유:** 사용자가 잘못된 기억을 교정하려면 선택 근거와 source를 확인할 수 있어야 한다.
  - **산출물:** chosen source, freshness, supersession, omitted-conflict reason의 safe projection.
  - **검증:** 설명이 raw private turn이나 hidden prompt를 노출하지 않고 실제 reducer 결정과 일치한다.
  - **선행:** 162.

- [ ] **164. memory consolidation을 apply가 아닌 proposal로 만든다.** — `P2`
  - **이유:** 여러 episode를 하나의 durable fact로 요약할 때 의미 왜곡 가능성이 있다.
  - **산출물:** source set, proposed summary, conflicts, reversible apply action.
  - **검증:** proposal 조회는 store를 바꾸지 않고 source 하나가 사라지면 stale로 닫힌다.
  - **선행:** 160–163.

- [ ] **165. forgetting과 decay를 목적·위험별로 분리한다.** — `P1`
  - **이유:** 오래됐다는 이유로 안전상 중요한 veto나 correction까지 사라지면 안 된다.
  - **산출물:** retain, decay rank, archive, delete, never-auto-delete classes.
  - **검증:** explicit veto·permission revocation·security event는 generic age decay 대상이 아니다.
  - **선행:** 157–164.

- [ ] **166. 개인 ontology를 user-visible link graph로 제한한다.** — `P2`
  - **이유:** hidden personality profile보다 사람이 검사할 수 있는 exact 관계가 더 신뢰할 만하다.
  - **산출물:** person/project/place/topic 관계, source links, merge/split/forget controls.
  - **검증:** unsupported 관계는 그래프에 추가되지 않고 inference는 fact와 다른 표시를 가진다.
  - **선행:** 161–165.

- [ ] **167. memory·notes·contacts·tasks 간 conflict를 transactionally 감지한다.** — `P1`
  - **이유:** store마다 같은 개인 사실이 다르게 남으면 source 선택이 비결정적이 된다.
  - **산출물:** cross-store conflict cue, read snapshot, owner resolution, no-hidden-write rule.
  - **검증:** concurrent change fixture에서 stale resolution이 거부되고 어떤 store도 부분 적용되지 않는다.
  - **선행:** 161, 166.

- [ ] **168. 장기 correction/forget/recovery suite로 G13을 닫는다.** — `P0`
  - **이유:** 단기 fixture는 수개월의 시간 변화와 compaction/migration 상호작용을 잡지 못한다.
  - **산출물:** simulated multi-month corpus와 consented organic audit sample.
  - **검증:** current fact precision, historical query, abstention, forget completeness, no-resurrection을 evaluator가 판정한다.
  - **선행:** 157–167.

---

## Phase 14 — tasks, calendar, reminders, contacts, notes의 생활 loop

**진입 조건:** G13 green이고 각 personal store의 privacy gate가 유지된다.

**Exit gate G14:** 개인 도메인들이 따로 존재하는 저장소가 아니라, exact authority와 explicit action으로
일일·주간 계획 및 복귀를 돕는 하나의 검증된 생활 loop로 작동한다.

- [ ] **169. 대화에서 task intent를 draft로 capture한다.** — `P1`
  - **이유:** 사용자가 “해야겠다”고 말한 모든 문장을 자동 task로 만들면 noise가 된다.
  - **산출물:** title, due ambiguity, source turn, proposed list, explicit create action.
  - **검증:** 질문·가정·타인 task는 자동 생성되지 않고 confirm 전 store write가 0이다.
  - **선행:** 066, 168.

- [ ] **170. vague task를 실행 가능한 next action으로 명확화한다.** — `P1`
  - **이유:** “여행 준비” 같은 항목은 Continuity next step으로 바로 사용하기 어렵다.
  - **산출물:** bounded clarification, optional decomposition draft, original intent link.
  - **검증:** 사용자 답 없이 세부 행동이나 deadline을 invent하지 않는다.
  - **선행:** 169.

- [ ] **171. calendar free/busy와 event detail 권한을 분리한다.** — `P0`
  - **이유:** 일정 가능성만 필요한 도구가 제목·참석자·메모까지 읽을 필요는 없다.
  - **산출물:** availability-only capability와 explicit detail-read capability.
  - **검증:** free/busy tool output에 private event content가 없고 provider fallback이 일어나지 않는다.
  - **선행:** 073, 168.

- [ ] **172. exact calendar occurrence 기반 preparation Pack을 만든다.** — `P1`
  - **이유:** 병원·미팅·여행 전에 필요한 note/task를 정확히 이어주는 것이 실질적 가치다.
  - **산출물:** occurrence ID, user-linked sources, read-only context, one optional next action.
  - **검증:** recurring series의 다른 occurrence와 섞이지 않고 Pack open만 delivery를 만든다.
  - **선행:** 064, 171.

- [ ] **173. reminder lifecycle을 create→snooze→fire→ack→expire로 명시한다.** — `P1`
  - **이유:** 오래된 pending과 새 reminder가 같은 상태로 쌓이면 backlog가 반복된다.
  - **산출물:** versioned state machine, exact time zone, receipt, idempotent transitions.
  - **검증:** DST, clock rollback, restart, duplicate fire, stale snooze가 중복 전달을 만들지 않는다.
  - **선행:** 029–032, 171.

- [ ] **174. contacts를 recipient가 아닌 관계 context로 안전하게 사용한다.** — `P1`
  - **이유:** 관계 기억은 유용하지만 연락처 조회가 곧 전송 권한이 되어서는 안 된다.
  - **산출물:** exact contact ID, bounded relationship facts, no-recipient projection.
  - **검증:** name fuzzy match와 contact context만으로 draft recipient가 자동 결정되지 않는다.
  - **선행:** 161, 171.

- [ ] **175. note capture와 grounded retrieval의 round trip을 닫는다.** — `P1`
  - **이유:** note를 저장해도 나중에 정확히 찾고 수정·삭제하지 못하면 개인 지식 기반이 아니다.
  - **산출물:** source-aware create, cited recall, exact edit, conflict detection, forget path.
  - **검증:** concurrent edit와 renamed file에서 lost update 없이 canonical source가 유지된다.
  - **선행:** 167–174.

- [ ] **176. user-invoked daily review를 actionable하게 만든다.** — `P1`
  - **이유:** 단순 통계가 아니라 오늘의 held item, exact commitments, safe next action이 필요하다.
  - **산출물:** today events/tasks/reminders, pending reviews, one owner-chosen focus.
  - **검증:** overdue count만으로 자동 reschedule/send하지 않고 모든 card에 source/action이 있다.
  - **선행:** 169–175.

- [ ] **177. weekly review를 계획과 learning review로 분리한다.** — `P1`
  - **이유:** 지난 활동량을 개인적 성과나 학습 성공으로 오인하지 않아야 한다.
  - **산출물:** completed/open transitions, explicit outcomes, unresolved conflicts, next-week drafts.
  - **검증:** token/tool-call 수는 diagnostics로만 남고 usefulness는 explicit outcome만 사용한다.
  - **선행:** 176.

- [ ] **178. follow-up을 exact commitment에서 draft한다.** — `P1`
  - **이유:** 대화나 event 후 해야 할 연락을 기억하는 것은 유용하지만 잘못된 recipient 전송은 위험하다.
  - **산출물:** commitment source, recipient candidate, due window, draft content, explicit approve.
  - **검증:** exact commitment나 recipient authority가 없으면 draft조차 actionable send로 승격되지 않는다.
  - **선행:** 033–034, 174, 177.

- [ ] **179. personal status에서 daily/weekly loop의 막힘을 설명한다.** — `P1`
  - **이유:** store별 화면을 돌아다니지 않고 무엇을 검토해야 하는지 알아야 한다.
  - **산출물:** source conflict, stale reminder, pending draft, missing outcome, held automation의 action cards.
  - **검증:** status 조회는 mutation-free이며 action target이 stale하면 실행을 거부한다.
  - **선행:** 104, 176–178.

- [ ] **180. 생활 도메인 loop의 multi-date organic audit로 G14를 닫는다.** — `P1`
  - **이유:** 개별 tool 테스트가 실제 일상 계획과 복귀 가치를 증명하지 않는다.
  - **산출물:** task/calendar/note/reminder/contact를 포함한 distinct real journeys와 negative outcomes.
  - **검증:** exact-source success, correction burden, unwanted effects, time-to-resume를 독립 평가한다.
  - **선행:** 169–179.

---

## Phase 15 — web research, browser action, computer control의 안전한 실행

**진입 조건:** G14 green이고 Browser/runner security gate가 fresh green이다.

**Exit gate G15:** Muse가 최신 정보를 조사하고 browser/computer 작업을 실행하되, 페이지·파일·인증·
외부 효과의 경계를 유지하며 critical journey를 pass^k로 완료한다.

- [ ] **181. browsing archive를 explicit opt-in과 per-site retention으로 운영한다.** — `P1`
  - **이유:** 전체 browsing history 상시 수집은 Attunement에 필요하지 않은 민감 데이터다.
  - **산출물:** enable scope, site/category exclusions, inspect, pause, forget, retention.
  - **검증:** opt-out와 private-site fixture의 visit가 archive에 기록되지 않는다.
  - **선행:** 109–112, 180.

- [ ] **182. web search의 freshness와 citation contract를 provider-neutral하게 만든다.** — `P1`
  - **이유:** 최신 정보 질문에서 오래된 결과를 현재 사실처럼 답하면 안 된다.
  - **산출물:** query time, result date, source URL, provider provenance, unsupported/unknown state.
  - **검증:** stale-conflict corpus에서 최신 authoritative source가 선택되거나 명시적으로 abstain한다.
  - **선행:** 060, 181.

- [ ] **183. page extraction을 content type과 trust boundary별로 분리한다.** — `P1`
  - **이유:** HTML, PDF, image, download를 같은 parser와 prompt 경계로 처리하면 injection과 누락이 생긴다.
  - **산출물:** type detection, bounded extraction, source offsets, untrusted envelope.
  - **검증:** malformed, huge, encrypted, prompt-injected documents가 안전한 terminal state를 낸다.
  - **선행:** 078, 182.

- [ ] **184. browser action 전에 inspect→plan→effect preview를 강제한다.** — `P0`
  - **이유:** 페이지를 보자마자 click/fill하면 stale DOM과 잘못된 계정에서 행동할 수 있다.
  - **산출물:** observed target identity, planned steps, effect class, revalidation point.
  - **검증:** DOM 변경과 navigation 뒤에는 old target handle을 재사용하지 않는다.
  - **선행:** 039–040, 183.

- [ ] **185. form fill과 submit을 별도 권한으로 분리한다.** — `P0`
  - **이유:** 입력 준비와 외부 제출은 위험도가 다르다.
  - **산출물:** field-level preview, secret masking, submit effect summary, explicit confirmation.
  - **검증:** fill 승인만으로 submit/navigation이 발생하지 않고 hidden field도 preview에 포함된다.
  - **선행:** 184.

- [ ] **186. download를 quarantine와 provenance 검사 뒤에만 노출한다.** — `P0`
  - **이유:** 웹에서 받은 실행 파일·문서가 즉시 shell이나 parser로 이어지면 위험하다.
  - **산출물:** content hash, source URL, MIME/signature check, safe filename, quarantine state.
  - **검증:** executable mismatch, path traversal, overwrite, oversized download가 차단된다.
  - **선행:** 079, 183–185.

- [ ] **187. file upload에 exact path·content·destination preview를 요구한다.** — `P0`
  - **이유:** 잘못된 파일이나 민감 파일을 외부 사이트에 올리는 것은 되돌리기 어렵다.
  - **산출물:** canonical file identity, size/type, destination origin, redaction warning, explicit approve.
  - **검증:** symlink swap, file mutation, origin change가 upload 직전 재검증에서 거부된다.
  - **선행:** 073, 185–186.

- [ ] **188. browser authentication과 account identity를 effect에 묶는다.** — `P0`
  - **이유:** 여러 계정이 로그인된 상태에서 다른 사용자·조직으로 행동할 수 있다.
  - **산출물:** observed account indicator, uncertainty, required owner selection, session expiry.
  - **검증:** account identity가 확인되지 않은 send/purchase/admin effect는 실행되지 않는다.
  - **선행:** 184–187.

- [ ] **189. computer control을 accessibility tree 우선으로 만든다.** — `P1`
  - **이유:** pixel 좌표만으로 macOS 앱을 조작하면 window 이동·해상도·locale에 취약하다.
  - **산출물:** semantic element identity, window/app scope, coordinate fallback reason.
  - **검증:** window 이동과 scale 변화에서도 target이 유지되고 ambiguous element는 거부된다.
  - **선행:** 080–082, 188.

- [ ] **190. multi-step computer action에 checkpoint와 recovery를 넣는다.** — `P1`
  - **이유:** 중간 실패 뒤 처음부터 재실행하면 중복 입력·저장·전송이 발생한다.
  - **산출물:** step state, observed postcondition, resumable/non-resumable effect classification.
  - **검증:** crash/restart 후 마지막 verified checkpoint에서 재개하거나 안전하게 중단한다.
  - **선행:** 129, 189.

- [ ] **191. web/computer action을 personal thread와 exact provenance로 연결한다.** — `P1`
  - **이유:** 수행한 행동이 어떤 사용자 목표와 권한에서 나왔는지 나중에 확인할 수 있어야 한다.
  - **산출물:** thread, source request, action plan, effect receipts, outcome 분리.
  - **검증:** action receipt만으로 helpful outcome이나 future permission이 생성되지 않는다.
  - **선행:** 066, 184–190.

- [ ] **192. critical browser/computer journey pass^k로 G15를 닫는다.** — `P0`
  - **이유:** action 성공률이 낮으면 안전하더라도 실용적인 개인 에이전트가 아니다.
  - **산출물:** research, form draft, download, upload preview, desktop workflow의 terminal-state graders.
  - **검증:** strict pass^k, duplicate effect 0, wrong-account effect 0, injection fault suite PASS.
  - **선행:** 181–191.

---

## Phase 16 — communication을 정확한 recipient와 draft-first로 연결하기

**진입 조건:** G15 green이고 delivery safety가 fresh green이다.

**Exit gate G16:** inbound context와 recipient identity가 정확히 연결되고, 모든 outbound communication은
draft·review·approve·reconcile을 거쳐 중복이나 잘못된 수신자 없이 완료된다.

- [ ] **193. recipient identity를 contact와 channel account에 exact하게 묶는다.** — `P0`
  - **이유:** 같은 이름·별칭·주소가 여러 사람이나 계정에 대응할 수 있다.
  - **산출물:** canonical contact ID, channel-specific address, verification source, expiry.
  - **검증:** fuzzy name이나 대화 문맥만으로 recipient를 확정하지 않는다.
  - **선행:** 174, 192.

- [ ] **194. channel account와 workspace identity를 effect 전에 표시한다.** — `P0`
  - **이유:** 개인 Slack, 회사 Slack, 여러 email account에서 잘못된 발신 주체를 선택할 수 있다.
  - **산출물:** provider, account, workspace, destination, observed authority의 send preview.
  - **검증:** identity가 unknown/stale이면 draft는 유지되지만 approve/send는 disabled된다.
  - **선행:** 123–124, 193.

- [ ] **195. communication draft에 source와 unsupported claim 표시를 넣는다.** — `P1`
  - **이유:** 개인 agent가 사실을 꾸며 메시지에 넣으면 사용자 관계에 직접 피해가 생긴다.
  - **산출물:** cited source snippets, user-authored facts, uncertain placeholders, editable draft.
  - **검증:** source가 없는 날짜·약속·금액·상태는 자동 확정 문장으로 생성되지 않는다.
  - **선행:** 163, 193–194.

- [ ] **196. tone preference를 recipient·context별 explicit rule로 제한한다.** — `P1`
  - **이유:** 한 대화의 말투를 모든 관계에 일반화하면 부적절한 메시지가 된다.
  - **산출물:** scope, source, examples, prohibited style, expiry가 있는 tone profile.
  - **검증:** 업무와 가족 fixture가 서로의 tone preference를 가져오지 않는다.
  - **선행:** 159, 195.

- [ ] **197. attachment와 quoted history를 별도 review surface로 만든다.** — `P0`
  - **이유:** 본문만 승인하고 민감 attachment나 긴 대화 history가 함께 전송될 수 있다.
  - **산출물:** exact attachment hash, quoted range, redaction warning, total payload preview.
  - **검증:** file mutation, hidden attachment, excessive quote, private marker가 send 전에 차단된다.
  - **선행:** 187, 195.

- [ ] **198. inbound thread context를 bounded하고 untrusted하게 처리한다.** — `P0`
  - **이유:** 과거 메시지의 injection과 긴 thread가 system policy나 최신 intent를 덮을 수 있다.
  - **산출물:** participant identity, selected turns, truncation reason, untrusted envelope.
  - **검증:** quoted injection이 tool 권한과 recipient를 바꾸지 못하고 omitted context가 표시된다.
  - **선행:** 078, 193–197.

- [ ] **199. inbound triage를 label/draft 수준으로만 자동화한다.** — `P1`
  - **이유:** 읽지 않음 처리·보관·답장 같은 mutation을 초기 분류와 결합하면 오판 비용이 커진다.
  - **산출물:** urgency/category/confidence proposal, owner review, no-mutation default.
  - **검증:** triage 조회만으로 read state, archive, task, reply가 바뀌지 않는다.
  - **선행:** 198.

- [ ] **200. 모든 outbound send에 final owner confirmation을 유지한다.** — `P0`
  - **이유:** communication은 Muse의 장기 목표에서도 자동 전송보다 사용자 신뢰가 우선이다.
  - **산출물:** immutable payload hash, recipient/account identity, expiry, one-shot approval.
  - **검증:** draft 수정·recipient 변경·expiry 뒤에는 기존 승인을 재사용하지 않는다.
  - **선행:** 033–034, 193–199.

- [ ] **201. scheduled send를 approval expiry와 delivery brake에 묶는다.** — `P0`
  - **이유:** 승인한 메시지도 시간이 지나면 내용과 수신 맥락이 낡을 수 있다.
  - **산출물:** scheduled-at, approval valid-until, revalidation, cancel, held reason.
  - **검증:** expiry, account change, brake-on, clock jump에서 send가 발생하지 않는다.
  - **선행:** 173, 200.

- [ ] **202. ambiguous delivery status를 provider receipt와 reconcile한다.** — `P0`
  - **이유:** timeout 뒤 재전송하면 중복 메시지가 생길 수 있다.
  - **산출물:** pending/accepted/delivered/failed/unknown 상태와 manual reconciliation path.
  - **검증:** success-before-ack와 restart replay에서 동일 effect ID가 최대 한 번만 전송된다.
  - **선행:** 034, 201.

- [ ] **203. reply 이후 결과를 communication receipt와 별도 outcome으로 기록한다.** — `P1`
  - **이유:** 메시지가 전달됐다는 사실이 목표 달성이나 도움됨을 의미하지 않는다.
  - **산출물:** delivery receipt, optional user outcome, follow-up commitment의 분리된 links.
  - **검증:** provider delivered event만으로 used outcome이나 future send permission이 생성되지 않는다.
  - **선행:** 178, 202.

- [ ] **204. wrong-recipient·duplicate·injection red-team으로 G16을 닫는다.** — `P0`
  - **이유:** communication failure는 되돌리기 어려워 정상 journey보다 적대 검증이 중요하다.
  - **산출물:** alias collision, account drift, attachment swap, prompt injection, ambiguous ack campaign.
  - **검증:** wrong-recipient 0, unapproved send 0, duplicate effect 0, evaluator PASS.
  - **선행:** 193–203.

---

## Phase 17 — 목표·프로젝트·실행을 truth-preserving plan으로 운영하기

**진입 조건:** G16 green이고 normal chat Continuity가 유지된다.

**Exit gate G17:** Muse가 사용자의 목표를 bounded plan과 checkpoint로 전환하고, 실제 완료와 막힘을
추측하지 않은 채 긴 작업을 안전하게 재개한다.

- [ ] **205. personal work/project state를 thread와 분리된 canonical domain으로 고정한다.** — `P1`
  - **이유:** 대화 thread, Continuity thread, project 실행 상태를 같은 ID로 쓰면 권한과 수명이 섞인다.
  - **산출물:** project ID, goal, status, owner, source, linked threads/tasks의 명시적 관계.
  - **검증:** project 삭제·완료가 linked evidence와 outcome을 암묵적으로 변경하지 않는다.
  - **선행:** 066, 180, 204.

- [ ] **206. goal decomposition을 실행 전 draft로 만든다.** — `P1`
  - **이유:** 모델이 만든 하위 목표를 바로 task나 tool action으로 실행하면 scope가 확대될 수 있다.
  - **산출물:** assumptions, subtasks, dependencies, unknowns, owner-editable plan.
  - **검증:** confirm 전 task creation과 tool execution이 0이다.
  - **선행:** 170, 205.

- [ ] **207. plan에 acceptance criteria와 kill condition을 필수화한다.** — `P1`
  - **이유:** “잘 해줘” 계획은 완료를 과장하고 끝없이 확장되기 쉽다.
  - **산출물:** measurable outcome, non-goals, stop/kill criteria, evidence method.
  - **검증:** 기준이 비어 있거나 모순인 plan은 active execution으로 전환되지 않는다.
  - **선행:** 007, 206.

- [ ] **208. next action을 exact dependency와 readiness에서 선택한다.** — `P1`
  - **이유:** 보기 쉬운 작업을 우선해 실제 blocker를 건너뛰면 프로젝트가 진전되지 않는다.
  - **산출물:** ready/blocked reason, required authority, cost/risk, one chosen action.
  - **검증:** unmet dependency와 owner decision이 있는 task는 runnable로 표시되지 않는다.
  - **선행:** 205–207.

- [ ] **209. blocker와 decision을 first-class state로 만든다.** — `P1`
  - **이유:** 실패를 무한 retry하거나 사용자 결정이 필요한 문제를 자동 추측하면 안 된다.
  - **산출물:** blocker type, evidence, owner question, retry eligibility, resolved-by receipt.
  - **검증:** 동일 blocker가 새 evidence 없이 반복될 때 no-progress로 종료된다.
  - **선행:** 208.

- [ ] **210. execution checkpoint에 plan version과 effect boundary를 묶는다.** — `P0`
  - **이유:** plan 수정 후 오래된 checkpoint를 재개하면 이미 취소된 행동을 실행할 수 있다.
  - **산출물:** plan digest, completed steps, pending effects, resume compatibility.
  - **검증:** plan mismatch, corrupt checkpoint, ambiguous effect에서 자동 resume하지 않는다.
  - **선행:** 129, 207–209.

- [ ] **211. session handoff를 source-backed Continuity Pack으로 만든다.** — `P1`
  - **이유:** 긴 작업 재개 시 모델 요약만 믿으면 결정과 blocker가 사라질 수 있다.
  - **산출물:** goal, verified progress, exact artifacts, decisions, blockers, one next action.
  - **검증:** unsupported completion claim은 제외되고 original source를 inspect할 수 있다.
  - **선행:** 064, 210.

- [ ] **212. plan 단계마다 tool·time·cost budget을 설정한다.** — `P1`
  - **이유:** 전체 run budget만 있으면 한 subtask가 자원을 모두 소비할 수 있다.
  - **산출물:** per-step attempt, wallclock, model, browser, external-effect budgets.
  - **검증:** budget exhaustion이 명시적 terminal state를 만들고 다음 step으로 성공 처리되지 않는다.
  - **선행:** 087–095, 207.

- [ ] **213. progress projection을 verified effect에서만 계산한다.** — `P0`
  - **이유:** agent가 “완료했다”고 말한 것과 실제 file/task/API 상태는 다를 수 있다.
  - **산출물:** planned, attempted, verified, blocked, rolled-back 상태와 evidence link.
  - **검증:** tool error와 unverifiable output이 completed percentage를 높이지 않는다.
  - **선행:** 208–212.

- [ ] **214. irreversible·user-visible step 앞에 review gate를 둔다.** — `P0`
  - **이유:** 긴 plan 초기에 받은 포괄 승인으로 나중의 위험한 효과를 실행하면 안 된다.
  - **산출물:** just-in-time preview, exact target/effect, plan context, approval expiry.
  - **검증:** target 또는 payload가 바뀌면 재승인을 요구하고 금융/결제는 영구 거부한다.
  - **선행:** 073, 200, 213.

- [ ] **215. project outcome을 completion receipt와 분리해 review한다.** — `P1`
  - **이유:** task를 모두 닫아도 사용자의 실제 목표가 달성되지 않았을 수 있다.
  - **산출물:** verified deliverables, owner acceptance, adjusted/rejected outcome, residual work.
  - **검증:** task count만으로 project success나 playbook reward가 생성되지 않는다.
  - **선행:** 203, 213–214.

- [ ] **216. multi-session real project audit로 G17을 닫는다.** — `P1`
  - **이유:** 짧은 synthetic plan은 장기 resume, drift, owner decision의 현실적 비용을 못 잡는다.
  - **산출물:** 여러 날짜의 실제 프로젝트 2개 이상과 실패·조정 사례.
  - **검증:** completion truth, resume accuracy, duplicate effect, budget, owner burden을 독립 평가한다.
  - **선행:** 205–215.

---

## Phase 18 — self-learning과 skill/playbook을 proposal-first로 운영하기

**진입 조건:** G17 green이고 organic outcome이 충분하며 self-learning hold 해제는 별도 승인됐다.

**Exit gate G18:** Muse가 경험에서 개선 proposal을 만들 수 있지만, held-out 검증·사용자 review·rollback
없이는 active behavior를 바꾸지 않는다.

- [ ] **217. learning candidate의 source와 목적을 immutable하게 묶는다.** — `P0`
  - **이유:** 어떤 경험에서 왜 규칙이 생겼는지 없으면 잘못된 학습을 되돌릴 수 없다.
  - **산출물:** source runs/outcomes, proposed behavior, scope, expected benefit, expiry.
  - **검증:** unclassified receipt나 model self-critique만으로 candidate가 생성되지 않는다.
  - **선행:** 127–128, 216.

- [ ] **218. memory correction과 procedural skill proposal을 분리한다.** — `P0`
  - **이유:** “내 이름은…” 같은 사실 교정이 tool 실행 전략을 바꾸면 안 된다.
  - **산출물:** semantic fact, preference, prompt/playbook, executable skill의 distinct pipelines.
  - **검증:** 각 candidate가 다른 permission·evaluation·activation gate를 사용한다.
  - **선행:** 157–168, 217.

- [ ] **219. skill diff를 quarantine filesystem에서만 생성한다.** — `P0`
  - **이유:** 생성 중인 code/instruction이 active skill search path에 보이면 즉시 행동이 변한다.
  - **산출물:** isolated candidate directory, manifest, requested tools/permissions, checksum.
  - **검증:** candidate build/test 동안 active skill registry와 runtime prompt digest가 변하지 않는다.
  - **선행:** 126–128, 218.

- [ ] **220. skill별 deterministic contract tests를 자동 생성·검토한다.** — `P1`
  - **이유:** 자연어 skill은 성공 예시만 있으면 과도하게 넓은 입력에 작동할 수 있다.
  - **산출물:** positive, boundary, forbidden-effect, malformed-input examples와 grader.
  - **검증:** generated test 자체가 source requirement와 permission boundary를 약화하지 않는지 review한다.
  - **선행:** 219.

- [ ] **221. held-out regression set과 baseline 비교를 강제한다.** — `P0`
  - **이유:** 학습한 사례만 좋아지고 일반 성능이 나빠지는 overfit을 막아야 한다.
  - **산출물:** immutable split, baseline artifact, quality/safety/cost deltas.
  - **검증:** held-out safety regression 하나라도 있으면 activate gate가 닫힌다.
  - **선행:** 220.

- [ ] **222. playbook reward와 decay를 explicit outcome에만 연결한다.** — `P1`
  - **이유:** completion이나 agent confidence를 reward로 쓰면 잘못된 전략이 강화된다.
  - **산출물:** eligible outcomes, lower-confidence bound, negative weight, time decay.
  - **검증:** receipt-only와 controlled replay가 production ranking을 올리지 않는다.
  - **선행:** 006, 215, 221.

- [ ] **223. competing skills와 policy conflict를 활성화 전에 해결한다.** — `P1`
  - **이유:** 같은 trigger에 서로 다른 instructions가 적용되면 비결정적 행동이 된다.
  - **산출물:** trigger overlap, permission mismatch, precedence proposal, owner decision.
  - **검증:** unresolved conflict가 있는 candidate는 active registry에 들어가지 않는다.
  - **선행:** 219–222.

- [ ] **224. activation·revoke·rollback을 versioned transaction으로 만든다.** — `P0`
  - **이유:** partial activation이나 실패한 rollback은 prompt와 tool registry를 불일치시킨다.
  - **산출물:** active generation, atomic switch, previous version, health probe, rollback receipt.
  - **검증:** crash와 concurrent activation에서 정확히 한 generation만 visible하다.
  - **선행:** 223.

- [ ] **225. user preference가 safety/system policy를 덮지 못하게 한다.** — `P0`
  - **이유:** “항상 바로 보내” 같은 선호를 학습해 approval gate가 약해질 수 있다.
  - **산출물:** policy precedence, non-learnable constraints, rejected-proposal reason.
  - **검증:** adversarial preference corpus가 permission, send, payment, retention guard를 바꾸지 못한다.
  - **선행:** 073, 159, 224.

- [ ] **226. imported/community skill을 untrusted quarantine로 처리한다.** — `P0`
  - **이유:** 외부 skill은 code, prompt injection, hidden network effect를 포함할 수 있다.
  - **산출물:** provenance, signature/checksum, static permission scan, sandbox test, explicit install preview.
  - **검증:** import만으로 code execution·network·active registration이 발생하지 않는다.
  - **선행:** 125, 219–225.

- [ ] **227. background curation을 resource admission과 owner schedule에 묶는다.** — `P1`
  - **이유:** self-improvement가 foreground 작업과 privacy expectation을 침해하면 안 된다.
  - **산출물:** idle-only claim, model budget, candidate cap, pause/resume, no-auto-activate.
  - **검증:** resource pressure·owner pause·hold 상태에서 model curation start가 0이다.
  - **선행:** 085–096, 217–226.

- [ ] **228. learning audit와 rollback drill로 G18을 닫는다.** — `P0`
  - **이유:** candidate 품질뿐 아니라 잘못 활성화된 behavior를 찾고 되돌릴 수 있어야 한다.
  - **산출물:** source→candidate→tests→approval→activation→outcomes chain과 revoke drill.
  - **검증:** silent activation 0, held-out regression 0, rollback 후 baseline digest 복원, evaluator PASS.
  - **선행:** 217–227.

---

## Phase 19 — multi-agent를 단일 agent보다 나을 때만 사용하기

**진입 조건:** G18 green이고 task family별 single-agent baseline이 존재한다.

**Exit gate G19:** decomposition·handoff·permission·budget·cancellation이 검증되고, 선택된 task family에서
multi-agent가 single-agent보다 held-out 결과를 실질적으로 개선한다.

- [ ] **229. multi-agent 후보 task마다 single-agent baseline을 고정한다.** — `P0`
  - **이유:** 비교 기준 없이 agent 수를 늘리면 비용과 복잡성만 증가해도 성공처럼 보인다.
  - **산출물:** outcome quality, pass^k, cost, latency, tool/effect count baseline.
  - **검증:** 같은 artifact, rubric, budget, held-out set으로 반복 측정한다.
  - **선행:** 131, 228.

- [ ] **230. decomposition gate가 실제 독립 subtask만 허용하게 한다.** — `P1`
  - **이유:** 강하게 결합된 작업을 병렬화하면 서로 다른 암묵적 결정을 만든다.
  - **산출물:** shared-state, ordering, context dependency, mergeability 판정.
  - **검증:** 결합 fixture는 single-agent/serial plan으로 남고 독립 fixture만 fan-out된다.
  - **선행:** 206–209, 229.

- [ ] **231. agent 역할과 writable scope를 최소화한다.** — `P0`
  - **이유:** 모든 subagent가 전체 filesystem과 tool 권한을 가지면 blast radius가 커진다.
  - **산출물:** role, inputs, allowed paths/tools/effects, output schema, expiry.
  - **검증:** scope 밖 write/tool call은 runtime에서 차단되고 advisory prompt에만 의존하지 않는다.
  - **선행:** 073, 230.

- [ ] **232. handoff를 typed artifact와 exact source links로 제한한다.** — `P1`
  - **이유:** 자유 형식 요약이 decision, uncertainty, provenance를 잃을 수 있다.
  - **산출물:** goal, inputs, assumptions, decisions, artifacts, blockers, verification schema.
  - **검증:** required field나 source가 없는 handoff는 downstream 실행을 시작하지 않는다.
  - **선행:** 007, 211, 231.

- [ ] **233. message bus에 idempotency와 causal ordering을 적용한다.** — `P0`
  - **이유:** retry와 out-of-order delivery가 subtask를 중복 실행하거나 stale decision을 적용할 수 있다.
  - **산출물:** message ID, correlation/causation IDs, sequence, dedupe window, terminal ack.
  - **검증:** duplicate, delayed, reordered, restart replay에서 effect가 정확히 한 번만 반영된다.
  - **선행:** 231–232.

- [ ] **234. shared state mutation을 optimistic concurrency와 merge gate로 보호한다.** — `P0`
  - **이유:** 두 agent가 같은 file/store를 덮어쓰면 조용한 데이터 손상이 생긴다.
  - **산출물:** base version, conflict result, owner/lead merge decision, atomic publish.
  - **검증:** concurrent incompatible edits가 자동 last-write-wins되지 않는다.
  - **선행:** 233.

- [ ] **235. subagent별 token·time·tool·effect budget을 강제한다.** — `P1`
  - **이유:** 하나의 subagent가 전체 orchestration budget을 소비하거나 tool loop에 빠질 수 있다.
  - **산출물:** per-agent and aggregate budget, cancellation, budget-exhausted result.
  - **검증:** child budget 초과가 sibling과 supervisor를 무제한 연쇄 retry시키지 않는다.
  - **선행:** 212, 233–234.

- [ ] **236. delegation이 permission을 증폭하지 못하게 한다.** — `P0`
  - **이유:** supervisor가 없는 권한을 subagent 조합으로 획득하면 안 된다.
  - **산출물:** authority intersection, non-delegable effects, approval ownership.
  - **검증:** child들의 권한 합집합이 parent authority를 넘지 않고 external send는 owner gate를 유지한다.
  - **선행:** 073, 214, 231–235.

- [ ] **237. cancellation과 orphan subagent를 resident health에 포함한다.** — `P0`
  - **이유:** supervisor 종료 뒤 child가 계속 tool을 실행하면 invisible background effect가 된다.
  - **산출물:** process/task ownership, cooperative abort, lease expiry, orphan fencing.
  - **검증:** supervisor crash와 user cancel 뒤 새 child effect가 0이고 late result는 discarded된다.
  - **선행:** 016, 091, 235–236.

- [ ] **238. evaluator를 maker agent와 context·권한에서 분리한다.** — `P0`
  - **이유:** 같은 agent가 자기 output을 채점하면 self-preference와 shared assumption이 남는다.
  - **산출물:** read-only evaluator role, artifact-only input, fixed rubric, independent trace.
  - **검증:** evaluator가 maker scratch/context 없이 재현하고 write/effect tool이 없다.
  - **선행:** 008, 232, 237.

- [ ] **239. remote/hosted subagent는 local-first threat model을 통과할 때만 연다.** — `P2`
  - **이유:** source와 personal data가 외부 sandbox로 이동할 수 있다.
  - **산출물:** data classification, upload manifest, secrets exclusion, retention/deletion, explicit opt-in.
  - **검증:** local-only profile에서는 remote dispatch 0이고 approved subset 밖 file이 전송되지 않는다.
  - **선행:** 073–084, 236–238.

- [ ] **240. held-out multi-agent benchmark로 G19를 닫는다.** — `P1`
  - **이유:** architecture가 안전해도 single-agent보다 결과가 낫지 않으면 기본 사용 가치가 없다.
  - **산출물:** task-family별 paired baseline, quality/cost/latency/failure deltas, adopt/reject decision.
  - **검증:** strict pass^k와 material improvement가 없는 family는 single-agent가 기본으로 유지된다.
  - **선행:** 229–239.

---

## Phase 20 — provider/model 품질·fallback·비용을 한 계약으로 운영하기

**진입 조건:** G19 green이며 multi-agent 여부와 무관한 canonical agent contract가 유지된다.

**Exit gate G20:** provider 변경, fallback, compaction, streaming, structured output, multimodal 입력에서도
동일한 safety·grounding·message-integrity floor가 유지되고 비용·성능 선택이 재현 가능하다.

- [ ] **241. provider capability registry를 runtime probe와 version에 묶는다.** — `P1`
  - **이유:** 문서상 지원과 실제 endpoint의 tool/stream/schema/context 지원이 다를 수 있다.
  - **산출물:** model ID, provider, capabilities, limits, probe time, source, unknown fields.
  - **검증:** probe 실패를 unsupported와 구분하고 stale capability는 routing에 사용하지 않는다.
  - **선행:** 093–094, 240.

- [ ] **242. task-model routing을 explicit policy와 owner override로 만든다.** — `P1`
  - **이유:** 자동 모델 선택이 data egress, 비용, latency, tool support를 몰래 바꿀 수 있다.
  - **산출물:** task requirements, allowed providers, local/cloud boundary, rationale, override.
  - **검증:** local-only profile에서 cloud model이 선택되지 않고 unsupported capability는 fail-close한다.
  - **선행:** 099–100, 241.

- [ ] **243. fallback을 error taxonomy와 effect boundary에 맞게 제한한다.** — `P0`
  - **이유:** tool effect 후 모델 fallback이 전체 turn을 재실행하면 중복 행동이 생길 수 있다.
  - **산출물:** retryable/non-retryable/ambiguous errors, safe replay boundary, fallback budget.
  - **검증:** effect-before-error fixture가 이전 tool call을 재실행하지 않고 checkpoint에서 이어진다.
  - **선행:** 034, 210, 242.

- [ ] **244. provider credential rotation과 auth-profile fallback을 격리한다.** — `P0`
  - **이유:** 다른 계정 credential로 자동 전환하면 비용·데이터·조직 경계가 바뀔 수 있다.
  - **산출물:** profile identity, allowed scope, expiry, explicit rotation, redacted health.
  - **검증:** unauthorized profile fallback 0, logs/trace에 secret 0, revoked profile 즉시 차단.
  - **선행:** 077, 100, 243.

- [ ] **245. context compaction을 decision·authority·tool-pair 보존 계약으로 강화한다.** — `P0`
  - **이유:** 긴 session 압축에서 승인 범위나 tool 결과가 빠지면 잘못된 재실행이 생긴다.
  - **산출물:** preserved decisions, source refs, pending effects, message pairs, uncertainty.
  - **검증:** adversarial long-run에서 approval 확대, orphan tool result, lost correction이 없다.
  - **선행:** 210–213, 241.

- [ ] **246. prompt-prefix cache를 provider별로 측정·무효화한다.** — `P1`
  - **이유:** cache 최적화가 stale policy나 skill generation을 재사용하면 안전성이 깨진다.
  - **산출물:** prefix digest, policy/skill/model version, hit evidence, invalidation rules.
  - **검증:** policy·permission·skill 변경 후 old cache가 사용되지 않고 warm latency 이득이 재현된다.
  - **선행:** 094, 224, 245.

- [ ] **247. structured-output repair를 schema-safe하고 bounded하게 만든다.** — `P0`
  - **이유:** JSON repair가 의미를 추측하거나 validation을 우회할 수 있다.
  - **산출물:** parse/validate/repair attempt budget, original/repair trace, terminal schema error.
  - **검증:** malformed security decision과 tool arguments는 guessed success로 복구되지 않는다.
  - **선행:** 241–246.

- [ ] **248. streaming tool-call 조립과 message repair를 provider-neutral하게 검증한다.** — `P0`
  - **이유:** chunk 순서, duplicate delta, partial arguments가 message-pair integrity를 깨뜨릴 수 있다.
  - **산출물:** stream state machine, call identity, partial/cancel/error terminal states.
  - **검증:** reordered/duplicated/truncated stream corpus에서 invalid tool execution이 0이다.
  - **선행:** 247.

- [ ] **249. image/audio/document 입력의 provenance와 budget을 통합한다.** — `P1`
  - **이유:** multimodal attachment가 context budget과 privacy 경계를 우회할 수 있다.
  - **산출물:** source hash, type, size/token estimate, egress policy, extraction confidence.
  - **검증:** unknown size, unsupported type, hidden metadata, private attachment가 dispatch 전에 처리된다.
  - **선행:** 183, 197, 241–248.

- [ ] **250. 완전 offline local-model path를 기능·품질별로 qualification한다.** — `P1`
  - **이유:** local adapter가 존재해도 memory, tool, embedding, voice 중 cloud fallback이 남을 수 있다.
  - **산출물:** blocked-network run, model/embedding/STT/TTS dependencies, unavailable feature disclosure.
  - **검증:** network-denied 환경에서 hidden egress 0이고 지원 journey는 terminal grader를 통과한다.
  - **선행:** 099, 242, 249.

- [ ] **251. quality·latency·cost·privacy Pareto report를 task family별로 만든다.** — `P2`
  - **이유:** 하나의 “best model” 대신 개인 작업마다 다른 tradeoff가 있다.
  - **산출물:** fixed task sets, pass^k, median/p95, estimated/actual cost, egress class.
  - **검증:** unknown price와 failed run을 제외하지 않고 owner가 routing policy를 재현할 수 있다.
  - **선행:** 241–250.

- [ ] **252. cross-provider qualification으로 G20을 닫는다.** — `P0`
  - **이유:** adapter별 green unit test가 전체 agent contract 보존을 증명하지 않는다.
  - **산출물:** supported provider/model matrix와 capability-specific PASS/FAIL/UNAVAILABLE.
  - **검증:** safety, grounding, tool integrity, compaction, cancellation floor가 모든 advertised path에서 유지된다.
  - **선행:** 241–251.

---

## Phase 21 — macOS·Windows·Linux·mobile·voice를 capability-aware하게 연결하기

**진입 조건:** G20 green이고 각 platform의 privacy/permission 모델이 문서화됐다.

**Exit gate G21:** 플랫폼과 디바이스가 지원하지 않는 기능을 추측하지 않고, pairing·voice·handoff가
명시적 권한과 capability descriptor 안에서 동작한다.

- [ ] **253. cross-platform runtime contract와 차이를 단일 matrix로 만든다.** — `P1`
  - **이유:** macOS에서 검증된 launchd·permission 동작을 Windows/Linux에 그대로 주장하면 안 된다.
  - **산출물:** service, filesystem, secrets, notifications, thermal, sandbox, browser capability matrix.
  - **검증:** unsupported/unknown을 safe success로 표시하지 않고 platform-specific tests에 연결한다.
  - **선행:** 024, 080, 086, 252.

- [ ] **254. Windows resident service의 artifact/runtime truth를 구현·검증한다.** — `P1`
  - **이유:** registration만으로 live runtime을 증명할 수 없다는 기존 한계를 닫아야 한다.
  - **산출물:** stable entrypoint, service identity, PID/heartbeat, single writer, repair plan.
  - **검증:** register-only, stale process, duplicate, restart, update scenarios가 G1과 같은 semantics를 가진다.
  - **선행:** 013–024, 253.

- [ ] **255. Linux service의 systemd/user-session 경계를 구현·검증한다.** — `P2`
  - **이유:** system/user service 혼동과 headless 환경 차이가 credential·notification scope를 바꿀 수 있다.
  - **산출물:** supported unit model, stable path, environment allowlist, health/repair.
  - **검증:** logout, reboot, missing display, stale unit에서 hidden duplicate resident가 없다.
  - **선행:** 013–024, 253.

- [ ] **256. macOS desktop app과 CLI/daemon의 single-state contract를 닫는다.** — `P1`
  - **이유:** app, menu bar, CLI가 별도 설정·resident를 만들면 사용자가 실제 상태를 알 수 없다.
  - **산출물:** shared runtime settings, health, deep links, one repair path, window restoration.
  - **검증:** app/CLI 동시 실행과 update에서 두 resident writer나 conflicting setting이 생기지 않는다.
  - **선행:** 024, 098, 145, 253.

- [ ] **257. mobile companion을 read/review-first 최소 surface로 제한한다.** — `P2`
  - **이유:** 작은 화면에서 모든 tool 실행과 설정을 복제하면 권한 오류와 UX 복잡성이 커진다.
  - **산출물:** status, Pack review, draft approve/reject, explicit limited actions.
  - **검증:** mobile만으로 새 broad permission, self-learning activation, financial effect를 만들 수 없다.
  - **선행:** 104, 120, 200, 253.

- [ ] **258. device pairing을 mutual verification과 revoke로 보호한다.** — `P0`
  - **이유:** pairing code 탈취나 stale device가 personal data와 approval에 접근할 수 있다.
  - **산출물:** short-lived challenge, device identity, owner confirmation, capability grant, revoke.
  - **검증:** replay, expired challenge, cloned identity, revoked device가 session을 만들지 못한다.
  - **선행:** 073–084, 257.

- [ ] **259. capability descriptor handshake를 versioned fail-close로 만든다.** — `P0`
  - **이유:** 디바이스가 지원하지 않는 action을 server가 가능한 것으로 가정하면 잘못된 fallback이 생긴다.
  - **산출물:** supported actions/data classes, versions, limits, unavailable reasons.
  - **검증:** unknown future capability와 version mismatch가 자동 downgrade effect로 이어지지 않는다.
  - **선행:** 241, 253–258.

- [ ] **260. clipboard·file handoff를 one-shot explicit transfer로 제한한다.** — `P0`
  - **이유:** clipboard와 nearby files 상시 동기화는 민감 정보 유출 경로가 된다.
  - **산출물:** selected payload, source/destination device, preview, expiry, transfer receipt.
  - **검증:** background clipboard scraping 0, symlink/file mutation 재검증, revoke 후 transfer 0.
  - **선행:** 187, 258–259.

- [ ] **261. voice 입력을 push-to-talk와 visible listening state로 시작한다.** — `P1`
  - **이유:** always-listening은 개인 환경에서 큰 privacy·오탐 비용이 있다.
  - **산출물:** explicit start/stop, live indicator, local buffer, cancel-before-send.
  - **검증:** indicator가 꺼진 상태에서 audio capture 0이고 cancel한 utterance가 model/memory로 가지 않는다.
  - **선행:** 099, 253.

- [ ] **262. STT/TTS provider와 audio retention을 명시적으로 선택하게 한다.** — `P0`
  - **이유:** 음성 데이터의 cloud egress와 저장 여부를 사용자가 알아야 한다.
  - **산출물:** local/cloud provider, transcript/audio retention, egress preview, forget action.
  - **검증:** local-only profile에서 cloud audio request 0이고 raw audio가 기본 영속되지 않는다.
  - **선행:** 241–252, 261.

- [ ] **263. voice interruption·barge-in·accessibility를 terminal state로 다룬다.** — `P1`
  - **이유:** 말을 끊거나 인식이 불확실할 때 tool effect가 계속 진행되면 위험하다.
  - **산출물:** listening/thinking/speaking/cancelled/needs-confirmation state와 accessible alternatives.
  - **검증:** barge-in과 low-confidence command에서 external/tool effect가 confirmation 없이 실행되지 않는다.
  - **선행:** 261–262.

- [ ] **264. cross-device real journey audit로 G21을 닫는다.** — `P1`
  - **이유:** pairing과 개별 기능 test만으로 실제 continuity handoff를 증명할 수 없다.
  - **산출물:** desktop→mobile review, mobile revoke, voice draft, offline fallback journeys.
  - **검증:** wrong-device disclosure 0, unauthorized effect 0, capability drift 0, evaluator PASS.
  - **선행:** 253–263.

---

## Phase 22 — 상시 evaluation, fault injection, drift canary

**진입 조건:** G21 green이며 advertised surfaces와 providers가 확정됐다.

**Exit gate G22:** 결과와 경로를 채점하는 versioned evaluation system이 model·provider·platform·release
drift를 탐지하고, synthetic 결과를 organic value로 오인하지 않는다.

- [ ] **265. golden journey catalog를 실제 개인 실패 family에서 구성한다.** — `P0`
  - **이유:** 편리한 synthetic prompt만으로는 corrected memory, wrong recipient, stale daemon을 잡지 못한다.
  - **산출물:** runtime, memory, Continuity, browser, communication, project, device journey set.
  - **검증:** 각 journey가 관찰된 실패 또는 명시적 high-risk contract에 연결된다.
  - **선행:** 142, 156, 168, 180, 192, 204, 216, 264.

- [ ] **266. terminal-state grader를 outcome-first로 만든다.** — `P0`
  - **이유:** assistant 문구가 그럴듯해도 실제 effect와 store state가 틀릴 수 있다.
  - **산출물:** final state, artifact digest, external effects, abstention, owner-visible result grader.
  - **검증:** 말로 “완료”했지만 effect가 없는 fixture를 실패로 판정한다.
  - **선행:** 265.

- [ ] **267. ordering이 계약인 곳에만 trace invariant를 추가한다.** — `P1`
  - **이유:** 모든 내부 step을 고정하면 구현 개선을 막고 brittle eval이 된다.
  - **산출물:** approval-before-send, guard-before-tool, checkpoint-before-resume 같은 최소 invariants.
  - **검증:** 결과-equivalent refactor는 통과하고 안전 ordering 위반만 실패한다.
  - **선행:** 266.

- [ ] **268. fault injection catalog를 I/O boundary별로 완성한다.** — `P0`
  - **이유:** network timeout, disk full, process death, clock shift, corrupt data는 정상 test에서 드물다.
  - **산출물:** model, store, browser, process, channel, device, scheduler fault controls.
  - **검증:** 각 critical boundary에 deterministic failure와 expected terminal state가 있다.
  - **선행:** 265–267.

- [ ] **269. mutation testing을 핵심 reducer와 guard에 적용한다.** — `P1`
  - **이유:** green test가 실제로 잘못된 policy 변화를 잡는지 확인해야 한다.
  - **산출물:** selected safety/attunement/recall/runtime mutations와 killed/survived report.
  - **검증:** known off-by-one, inverted guard, missing freshness, duplicate effect mutations가 모두 잡힌다.
  - **선행:** 268.

- [ ] **270. 비결정적 journey에 strict pass^k와 seed accounting을 적용한다.** — `P0`
  - **이유:** 평균 성공률이 높아도 사용자가 중요한 작업에서 한 번 실패하면 신뢰가 깨진다.
  - **산출물:** required k, seeds/models, all-pass rule, abort/missing semantics.
  - **검증:** 한 번의 fail·skip·unverified도 strict gate를 green으로 만들지 못한다.
  - **선행:** 265–269.

- [ ] **271. eval pollution과 train/test leakage를 탐지한다.** — `P0`
  - **이유:** golden answer가 prompt, memory, generated skill에 들어가면 성능이 거짓으로 상승한다.
  - **산출물:** dataset fingerprints, runtime isolation, memory reset, skill registry snapshot.
  - **검증:** seeded leakage가 preflight에서 발견되고 canonical report publish를 막는다.
  - **선행:** 217–228, 265–270.

- [ ] **272. model/provider/release drift canary를 versioned 비교한다.** — `P1`
  - **이유:** 같은 model 이름과 API가 시간이 지나며 behavior를 바꿀 수 있다.
  - **산출물:** baseline artifact, current result, material delta, auto-hold threshold.
  - **검증:** known changed fixture가 rollout 전에 감지되고 organic history를 다시 쓰지 않는다.
  - **선행:** 241–252, 270–271.

- [ ] **273. security regression corpus를 실제 exploit family로 유지한다.** — `P0`
  - **이유:** generic injection 문장만으로 새로운 tool/channel/device 경계를 보호할 수 없다.
  - **산출물:** injection, SSRF, path escape, wrong-recipient, permission amplification, secret leak cases.
  - **검증:** 새 capability는 대응 corpus case 없이는 advertised security gate를 통과하지 못한다.
  - **선행:** 082–084, 204, 236, 258, 272.

- [ ] **274. technical·controlled·organic evidence dashboard를 물리적으로 분리한다.** — `P0`
  - **이유:** 많은 synthetic pass를 실제 개인 가치처럼 보이게 만드는 시각적 혼동을 막아야 한다.
  - **산출물:** separate panels/stores, immutable origin, denominators, promotion-disabled labels.
  - **검증:** synthetic-only dataset이 organic graph, percentage, autonomy status를 렌더링하지 않는다.
  - **선행:** 004–006, 142, 265–273.

- [ ] **275. evaluation 자체에 time·model·compute budget을 둔다.** — `P1`
  - **이유:** 300개 roadmap을 지속 검증하면서 evaluator가 일상 runtime을 방해할 수 있다.
  - **산출물:** change-tier selection, preflight estimate, resource admission, cancel/resume, partial-unverified result.
  - **검증:** budget 부족 시 축을 조용히 skip하지 않고 canonical report를 unverified로 남긴다.
  - **선행:** 085–096, 265–274.

- [ ] **276. quarterly full qualification으로 G22를 닫는다.** — `P1`
  - **이유:** 개별 release gate만으로 장기 model·platform·personal-data drift를 놓칠 수 있다.
  - **산출물:** versioned full battery, previous delta, open blockers, claims allowed/withdrawn.
  - **검증:** independent evaluator가 fresh source/artifact/live evidence로 PASS/FAIL을 판정한다.
  - **선행:** 265–275.

---

## Phase 23 — plugin ecosystem과 외부 기여를 permission-first로 열기

**진입 조건:** G22 green이고 core capability/security contracts가 versioned됐다.

**Exit gate G23:** plugin과 외부 기여가 설치 전 capability·permission·provenance를 드러내고,
core safety floor와 사용자 데이터를 우회하지 않은 채 호환성 검증을 통과한다.

- [ ] **277. plugin manifest에 identity·version·capability·permission을 필수화한다.** — `P0`
  - **이유:** 이름과 code만 있는 plugin은 어떤 데이터와 효과를 요구하는지 알 수 없다.
  - **산출물:** signed identity 선택, entrypoints, tools/skills/apps, requested permissions, data egress, compatibility.
  - **검증:** unknown field/version, undeclared entrypoint, missing permission이 install preflight를 막는다.
  - **선행:** 073, 125, 252, 276.

- [ ] **278. plugin install·upgrade·disable 대신 revoke/uninstall lifecycle을 만든다.** — `P0`
  - **이유:** 단순 disabled 상태는 code·data·credential·background process가 남았는지 불명확하다.
  - **산출물:** exact diff preview, explicit install, versioned grant, revoke, data retention choice, uninstall receipt.
  - **검증:** revoke 즉시 tool/effect authority가 사라지고 uninstall이 user data를 기본 삭제하지 않는다.
  - **선행:** 277.

- [ ] **279. plugin 실행을 declared scope와 sandbox policy에 묶는다.** — `P0`
  - **이유:** core가 안전해도 plugin이 shell/network/filesystem을 직접 사용하면 경계가 우회된다.
  - **산출물:** per-plugin safe roots, network allowlist, secret handles, process limits, audit events.
  - **검증:** undeclared read/write/network/process와 symlink/path escape가 runtime에서 차단된다.
  - **선행:** 080–081, 277–278.

- [ ] **280. plugin compatibility matrix와 contract suite를 제공한다.** — `P1`
  - **이유:** Muse API 변화가 plugin을 조용히 오동작시키면 user store와 effect가 손상될 수 있다.
  - **산출물:** supported core versions, tool schema tests, lifecycle tests, migration checks.
  - **검증:** incompatible plugin은 load되지 않고 exact reason과 upgrade/rollback path를 제공한다.
  - **선행:** 277–279.

- [ ] **281. public SDK/API를 semver와 deprecation window로 관리한다.** — `P1`
  - **이유:** 내부 package 구조를 그대로 ecosystem contract로 노출하면 안전한 변경이 어려워진다.
  - **산출물:** minimal stable interfaces, compatibility policy, deprecation telemetry, removal gate.
  - **검증:** breaking fixture가 CI에서 탐지되고 deprecated path 제거 전 usage/alternative가 확인된다.
  - **선행:** 137, 280.

- [ ] **282. 세 개의 reference plugin으로 최소 contract를 검증한다.** — `P2`
  - **이유:** 문서만으로 notes-like local, read-only remote, draft-effect plugin의 차이를 검증하기 어렵다.
  - **산출물:** local read/write, remote read-only, draft-first effect examples와 tests.
  - **검증:** reference plugin이 privileged internal import 없이 공개 SDK만 사용한다.
  - **선행:** 277–281.

- [ ] **283. plugin developer quickstart를 threat model과 함께 작성한다.** — `P1`
  - **이유:** “Hello world”만 제공하면 개발자가 permission과 untrusted-output 경계를 놓친다.
  - **산출물:** scaffold, manifest, tests, permission rationale, safe storage, publish checklist.
  - **검증:** 새 checkout에서 quickstart plugin이 build/test/install-preview까지 재현된다.
  - **선행:** 282.

- [ ] **284. plugin doctor와 support bundle을 core diagnostics에 통합한다.** — `P1`
  - **이유:** plugin failure를 core crash로 오인하거나 전체 personal data를 공유하지 않게 해야 한다.
  - **산출물:** loaded version, health, denied capability, crash count, redacted logs, isolate action.
  - **검증:** plugin diagnostic에 secret/user content가 없고 unhealthy plugin만 격리할 수 있다.
  - **선행:** 150, 278–283.

- [ ] **285. OpenClaw·Hermes 등 외부 설정 import를 preview-only migration으로 제한한다.** — `P2`
  - **이유:** 경쟁 제품의 넓은 권한과 channel 설정을 그대로 가져오면 Muse 정책이 약해질 수 있다.
  - **산출물:** supported subset, source provenance, permission remap, skipped/unsafe items, explicit apply.
  - **검증:** import만으로 credential copy, external send, skill activation, daemon start가 발생하지 않는다.
  - **선행:** 121, 226, 277–284.

- [ ] **286. security disclosure와 vulnerable-plugin response 절차를 만든다.** — `P0`
  - **이유:** 외부 code ecosystem에서는 취약점 접수·격리·사용자 통지가 지연될 수 있다.
  - **산출물:** private report channel, severity, affected-version query, revoke/advisory, patch SLA.
  - **검증:** simulated vulnerable plugin을 식별하고 설치 차단·기존 revoke 안내까지 drill한다.
  - **선행:** 147, 273, 277–285.

- [ ] **287. external contribution에 test·license·provenance·review gate를 적용한다.** — `P1`
  - **이유:** 기능 기여가 공급망·라이선스·개인 정보 fixture 위험을 가져올 수 있다.
  - **산출물:** contributor checklist, required tests, DCO/license policy, generated-code/source declaration.
  - **검증:** missing provenance, forbidden fixture data, bypassed hook이 merge gate를 통과하지 않는다.
  - **선행:** 139, 265–276, 281–286.

- [ ] **288. bounded ecosystem pilot으로 G23을 닫는다.** — `P1`
  - **이유:** reference plugin만으로 실제 third-party 개발 경험과 permission 이해를 증명할 수 없다.
  - **산출물:** 소수 pilot plugins, install/revoke journeys, developer feedback, incidents, adopt/hold decisions.
  - **검증:** undeclared effect 0, core regression 0, revoke completeness PASS, evaluator review.
  - **선행:** 277–287.

---

## Phase 24 — 가치·안전·복잡도를 계속 재평가하는 운영 루프

**진입 조건:** G23 green이며 roadmap 001–288의 current/stale 상태가 구분돼 있다.

**Exit gate G24:** Muse의 다음 cycle이 organic value, failure evidence, security, maintenance cost에 근거해
승인되고, 가치가 없는 기능은 추가가 아니라 보류·축소·삭제된다.

- [ ] **289. north-star value review를 분기마다 실행한다.** — `P1`
  - **이유:** 기능·test·commit 증가가 실제 개인적 도움 증가를 의미하지 않는다.
  - **산출물:** time-to-resume, exact answer success, correction burden, unwanted interruption, owner trust review.
  - **검증:** denominator·dates·negative outcomes·missing data가 있고 technical activity는 분리된다.
  - **선행:** 142, 276, 288.

- [ ] **290. weekly failure triage를 severity와 recurrence로 정렬한다.** — `P1`
  - **이유:** 새 기능 아이디어가 반복 장애보다 먼저 선택되는 것을 막아야 한다.
  - **산출물:** current incidents, repeated faults, user friction, evidence gaps, next narrow slice.
  - **검증:** high-risk recurrent failure가 열린 상태에서 unrelated expansion을 active WIP로 선택하지 않는다.
  - **선행:** 147, 155, 289.

- [ ] **291. monthly memory·privacy·permission audit를 수행한다.** — `P0`
  - **이유:** 장기 개인화는 데이터와 권한이 조용히 누적되는 위험이 있다.
  - **산출물:** store growth, stale facts, unresolved conflicts, active grants, revoked remnants, retention actions.
  - **검증:** audit 조회는 무변경이며 delete/revoke는 exact preview와 별도 authority를 요구한다.
  - **선행:** 073–084, 157–168, 258, 278, 289.

- [ ] **292. quarterly competitor delta를 Muse fit lens로 재평가한다.** — `P3`
  - **이유:** OpenClaw·Hermes의 새 기능을 반사적으로 복제하지 않고 실제 사용자 문제에 연결해야 한다.
  - **산출물:** official change, user need, Muse edge, security/maintenance cost, adopt/reject/defer.
  - **검증:** owner problem과 measurable gate가 없는 parity item은 active roadmap에 들어가지 않는다.
  - **선행:** 132, 289.

- [ ] **293. retention·export·forget completeness를 정기 검증한다.** — `P0`
  - **이유:** 새 store, plugin, device가 forget/export 범위에서 빠질 수 있다.
  - **산출물:** data inventory, export coverage, delete/tombstone semantics, backups/derived-index handling.
  - **검증:** seeded identity가 active, archive, index, cache, device, plugin store에서 정책대로 사라진다.
  - **선행:** 076, 112, 165, 260, 278, 291.

- [ ] **294. dependency·secret·supply-chain maintenance cycle을 운영한다.** — `P0`
  - **이유:** 장기 resident agent는 dependency 취약점과 credential drift에 계속 노출된다.
  - **산출물:** version updates, vulnerability triage, credential expiry, SBOM delta, rollback plan.
  - **검증:** high/critical unresolved finding이 release/update를 막고 automated update도 full gate를 지난다.
  - **선행:** 139, 244, 286, 293.

- [ ] **295. accessibility·localization regression을 핵심 journey에 유지한다.** — `P1`
  - **이유:** 새 surface와 문구가 keyboard, screen reader, locale safety semantics를 깨뜨릴 수 있다.
  - **산출물:** supported locale/a11y matrix, golden screenshots where useful, semantic journey tests.
  - **검증:** permission/held/unverified 의미가 locale별로 같고 keyboard-only path가 지속 통과한다.
  - **선행:** 106–107, 256–264, 288.

- [ ] **296. latency·memory·cost budget trend를 release별로 비교한다.** — `P1`
  - **이유:** 기능이 누적되면서 first response와 resident resource가 서서히 악화될 수 있다.
  - **산출물:** fixed hardware/profile baseline, median/p95, RSS/CPU, model cost, material-regression threshold.
  - **검증:** 환경·model·cache 차이가 명시되고 threshold 초과가 release gate를 hold한다.
  - **선행:** 088–096, 146, 251, 294.

- [ ] **297. 하중을 받지 않는 feature·rule·adapter를 정기적으로 prune한다.** — `P1`
  - **이유:** 300개 roadmap은 복잡도를 영구 보존하는 명분이 되어서는 안 된다.
  - **산출물:** usage/evidence, safety load, maintenance cost, migration/removal proposal.
  - **검증:** active dependency와 user data export가 확인되기 전 삭제하지 않고 removal 후 dead path가 없다.
  - **선행:** 289–296.

- [ ] **298. 다음 30일 organic experiment를 하나만 선택한다.** — `P1`
  - **이유:** 여러 제품 가설을 동시에 열면 어떤 변화가 가치를 만들었는지 알 수 없다.
  - **산출물:** hypothesis, target journey, baseline, success/kill criteria, safety hold, evidence plan.
  - **검증:** experiment 외 behavior/permission은 유지되고 결과가 나쁘면 자동 확장하지 않는다.
  - **선행:** 289–297.

- [ ] **299. 반복 release-readiness를 current HEAD와 evidence에 다시 묶는다.** — `P0`
  - **이유:** 첫 release의 PASS는 다음 cycle의 code, model, data, plugin 상태를 보증하지 않는다.
  - **산출물:** G0–G23 freshness, source/artifact hash, experiment outcome, unresolved blockers의 aggregate.
  - **검증:** failed/unverified/stale gate 하나라도 있으면 release와 autonomy expansion을 막는다.
  - **선행:** 276, 288, 298.

- [ ] **300. roadmap을 evidence로 갱신하고 다음 cycle을 승인한다.** — `P1`
  - **이유:** 300번은 개발 종료가 아니라, 완료·기각·새 실패를 반영해 다음 목표를 더 작고 정확하게 만드는 지점이다.
  - **산출물:** completed/removed/deferred summary, remaining blockers, next numbered successor roadmap 또는 종료 결정.
  - **검증:** 기록-only 변경은 batch 규칙으로 정리되고, 새 task는 owner problem·acceptance·gate가 있을 때만 추가된다.
  - **선행:** 289–299와 owner의 다음 cycle 결정.

---

## Phase exit gate 요약

| Gate | 반드시 참이어야 하는 상태 | 실패 시 금지되는 다음 행동 |
| --- | --- | --- |
| G0 | provenance와 evidence accounting 재현 가능 | 구현 착수 |
| G1 | 정확히 한 resident writer, fresh heartbeat, pass^3 | delivery 활성화 |
| G2 | local-only/lock/brake/hold 일치, unapproved send 0 | backlog/자동 전송 확대 |
| G3 | Browser/CLI/API/Web terminal reliability pass^3 | 개인 journey claim |
| G4 | capability 11/11 strict pass^3 | personal-agent qualification claim |
| G5 | multi-date life/work organic Continuity audit PASS | proactive timing |
| G6 | privacy/security adversarial review PASS | MCP/channel/tool 권한 확대 |
| G7 | 24h resource soak PASS | background autonomy 확대 |
| G8 | clean onboarding 10분 journey pass^3 | broad acquisition/public claim |
| G9 | shadow 및 owner-reviewed cohort PASS | ongoing autonomous delivery |
| G10 | 확장이 Muse positioning과 safety를 유지 | parity 목적 기능 추가 |
| G11 | HEAD-bound release readiness PASS | tag, artifact publication, release |
| G12 | installed release incident/rollback drill PASS | 다음 update rollout |
| G13 | temporal/conflicting/forgotten memory audit PASS | 장기 개인화 확대 |
| G14 | personal-domain multi-date organic audit PASS | 생활 자동화 확대 |
| G15 | browser/computer critical journey strict pass^k | 더 넓은 computer action |
| G16 | wrong-recipient·duplicate·injection communication audit PASS | communication surface 확대 |
| G17 | multi-session project truth/resume audit PASS | 장기 자율 실행 확대 |
| G18 | proposal-first learning과 rollback audit PASS | self-learning activation 확대 |
| G19 | multi-agent가 paired baseline을 material하게 개선 | multi-agent 기본화 |
| G20 | cross-provider agent contract qualification PASS | provider 자동 routing 확대 |
| G21 | cross-device privacy/capability audit PASS | device/voice 권한 확대 |
| G22 | versioned full evaluation과 drift canary PASS | claims·release 확대 |
| G23 | plugin permission/revoke ecosystem pilot PASS | public ecosystem 확대 |
| G24 | value·risk·maintenance 기반 다음 cycle 승인 | successor roadmap·release cycle |

## 매 slice 종료 체크리스트

- [ ] acceptance criteria와 범위 밖이 구현 전에 고정됐다.
- [ ] exact affected tests와 boundary test가 실행됐다.
- [ ] 실패·취소·재시도·stale·corrupt 중 영향받는 경계가 검증됐다.
- [ ] store/effect 전후 digest 또는 명시적 receipt가 남았다.
- [ ] controlled·synthetic·organic evidence가 섞이지 않았다.
- [ ] 사용자 노출 문구가 현재 증거보다 강하지 않다.
- [ ] 별도 evaluator가 acceptance criteria별 PASS/FAIL을 기록했다.
- [ ] `pnpm test:changed`와 해당 typecheck가 통과했다.
- [ ] source/behavior 변경이면 pre-push hook을 skip하지 않고 task 단위 commit+push를 완료했다.
- [ ] 기록-only 변경이면 task별 commit을 만들지 않고 다음 batch checkpoint를 명시했다.
- [ ] 다음 slice를 열기 전에 WIP가 다시 0이 됐다.

## 현재 300-task cycle을 닫을 수 있는 조건

다음 항목을 모두 만족해야 이 roadmap cycle을 닫고 Muse를 “지속 검증되는 개인용 AI agent”라고
부를 수 있다. Task 300은 제품 개발의 영구 종료가 아니라 다음 cycle을 evidence로 재설계하는
checkpoint다.

1. G0–G24가 모두 현재 scope에서 fresh green이거나, 명시적으로 rejected/de-scoped된 gate는
   owner decision과 사용자 영향 없는 제거 증거를 가진다.
2. resident와 delivery safety는 여러 재시작과 24시간 이상 실행에서 유지된다.
3. corrected-fact recall을 포함한 11-axis capability가 strict pass^3다.
4. life/work Continuity가 여러 날짜의 organic outcome과 exact receipt로 독립 감사됐다.
5. Observe와 timing은 owner가 승인한 범위 밖에서 작동하지 않는다.
6. 설치 후 첫 source-backed value까지 10분 이내 journey가 pass^3다.
7. external send, deletion, permission expansion에는 draft/preview와 explicit authority가 있다.
8. release artifact, source commit, documentation, package metadata, provenance가 하나의 version을 가리킨다.
9. OpenClaw·Hermes보다 기능 수가 적더라도 Muse의 세 proof가 실제로 성립한다:
   exact personal grounding, explicit outcome adaptation, no silent permission expansion.
10. long-term memory, personal domains, browser/computer, communication, project execution이 exact source와
    permission boundary를 유지한다.
11. self-learning과 multi-agent는 held-out baseline improvement 없이 기본 경로로 승격되지 않는다.
12. plugin·device·provider 확장은 revoke, rollback, unavailable semantics를 가진다.
13. organic evidence가 부족하거나 나쁘면 기능을 더 여는 대신 held/reject/kill 결정을 내릴 수 있다.
14. 기록-only 변경은 batch되고 source/behavior 변경만 task별 검증·commit·push 규칙을 따른다.
15. Task 300에서 다음 cycle의 목표 또는 종료 결정이 owner에게 다시 승인된다.
