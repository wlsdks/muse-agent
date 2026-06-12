# Loop digest — 무인 루프가 매 fire 남기는 이해 체크포인트

> comprehension-debt 가드(harness 루프-엔지니어링 §3-2). 진안이 머지 전 읽는 곳.
> 한 fire = 4줄: 무엇 / 왜 / 리뷰지점 / 리스크. 3 fire마다 리뷰 관문.

---

## fire 1 — 2026-06-12 · 테마: TOOL expansion & hardening

- **무엇:** `muse.tasks.update` 툴에 `groundedArgs: ["notes"]` 추가 (+ 선언 검증 단위테스트).
- **왜:** update의 free-text `notes`가 anti-fabrication 경계 밖이라, 8B가 사용자가 말 안 한 notes를 지어내 디스크에 저장 가능했음(tasks add·calendar는 이미 보호). 그라운딩 엣지 확장.
- **리뷰지점:** `packages/mcp/src/loopback-tasks.ts`(update 툴 def 한 줄) + `packages/mcp/test/tasks-reminders-tool-schema.test.ts`(테스트). 게이팅 검증자(Opus)가 런타임 경로 추적해 PASS — `agent-runtime.ts:857-860`이 groundedArgs를 generic하게 적용하므로 선언으로 충분.
- **리스크:** 테스트가 *선언*만 검증(드롭 *동작*은 공유 메커니즘+상류 테스트가 보장). projection 배선 회귀는 이 테스트가 못 잡음. `title`은 의도적으로 ungrounded(rename 의도). 빌드/테스트(mcp 1655)·lint 0.

## fire 2 — 2026-06-12 · 테마: TOOL expansion & hardening

- **무엇:** `add_contact` 툴에 `groundedArgs: ["relationship"]` 추가 (+ 선언 검증 테스트).
- **왜:** contacts add의 free-text `relationship`("doctor"/"manager")가 anti-fabrication 경계 밖 — "Bob 추가해" 했는데 8B가 관계를 지어내 저장 가능. tool-arg grounding 항목의 다음 actuator(fire 1 tasks.update에 이어).
- **리뷰지점:** `packages/mcp/src/contacts-tool.ts`(한 줄) + `packages/mcp/test/contacts-tool.test.ts`. 게이팅 검증자(Opus)가 *다른 등록 경로*(직접 MuseTool, MCP loopback 아님)를 추적해 확인 — `toModelTool`(tools/index:385)이 groundedArgs를 carry, `agent-runtime:857-859`이 적용. inert 아님.
- **리스크:** fire 1과 동일(선언 테스트, 드롭 동작은 공유 메커니즘 보장). `name`은 required라 ungrounded. vision-auto(`commands-ask:2573`)는 결정적 추출 경로라 위협모델 밖. mcp 1656·lint 0.

> ⚠️ **다음 fire(fire 3) = 리뷰 관문.** 빌드 멈추고 fire 1–2 누적 다이제스트를 진안이 머지 전 읽도록 요청.

## [cognition loop] fire 1 — 2026-06-12 · 테마: agent-core 인지 강화 (메모리)

- **무엇:** `@muse/memory` recall-promotion.ts에 ACT-R base-level activation `actrActivation(ages, {decay,minAgeDays}) = ln(Σ tⱼ⁻ᵈ)` 추가 (+ 9-case positive/negative 배터리). 별 루프(TOOL 테마)와 구분되는 새 인지-테마 루프(cron 105c213f)의 첫 fire.
- **왜:** 기존 `scoreRecallHit`은 `hits·2^(-lastHitAge/half)` — 마지막 히트 recency × 빈도뿐, **spacing(분산 연습)** 을 못 잡음. ACT-R는 각 접근을 자기 시계로 감쇠·합산해 빈도+spacing을 한 공식에 담음(Anderson&Schooler 1991). 메모리(5대 테마 #1) 강화의 원칙적 코어.
- **리뷰지점:** `packages/memory/src/recall-promotion.ts`(함수 24줄, 순수·추가만) + `index.ts`(re-export) + `packages/memory/test/actr-activation.test.ts`(신규 9-case). maker=Sonnet worker / judge=Opus(나)가 **실제 코드 독립 검증** + 배터리 독립 재실행(350 memory tests green). pnpm check의 1 실패는 무관한 apps/cli "Ollama down" retrieval 플레이크 — 격리 실행 시 green(2498/2498), 내 변경(미사용 leaf)과 무관 확인.
- **리스크:** 함수만 SHIP, 아직 **미배선**(promotion 경로 미적용) — 그래서 backlog 항목 ◦ 유지(Done 아님). 다음 슬라이스가 per-access 타임스탬프 데이터-패스 + half-life 교체 A/B. grounding floor 무관(순수 랭킹 수학).
