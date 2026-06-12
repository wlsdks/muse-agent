---
title: 관측 (Observability — 트레이스)
audience: [개발자, AI 에이전트]
purpose: 실행의 모든 단계를 상관 ID 하나로 기록해 재현·감사·비용 집계가 되게 하는 정통 하네스 레이어
updated: 2026-06-13
---

# 관측 (Observability)

정통 5계층(메모리·도구·권한·훅·**관측**) 중 하나. 2026 합의가 공통으로 핵심으로 꼽는 레이어 —
"내 에이전트가 뭔가 이상했어"를 **재현 가능한 버그 리포트**로 바꾸고(Boris Cherny), 제어플레인의
**감사 가능한 기록(auditable records)**, Anthropic의 **재현 트레이스 + 비용**을 제공합니다.

## 무엇인가

[runner/tracer.mjs](../runner/tracer.mjs) (의존성 0):

- `createTracer({ runId, now, redact })` — 실행 단위 트레이서.
  - `.add(event, data)` — 구조화 이벤트를 기록. 모든 이벤트에 **상관 ID(runId)** + 단조 증가 `seq` + 시각 `t`.
  - `.summary()` — 이벤트별 카운트·**blocked 수**·총 소요(durationMs)·**비용 합(cost)** 롤업.
  - `.toJSON()` — `{runId, events, summary}` 직렬화(영속·대시보드용).
- `redactSecrets` — `api_key`·`authorization`·`token`·`secret`·`password`·`cookie` 키를 `[redacted]`로
  치환해 트레이스를 **안전하게 영속**(거버넌스).

## 어디에 배선됐나

- **오케스트레이터**가 이 트레이서로 모든 단계(start·plan·gate·build·evaluate·done·blocked·rebuild)를
  기록하고, `runCycle`은 `{trace, summary}`를 반환한다. 게이트 판정·역할·재시도가 한 상관 ID로 묶인다.
- **PostToolUse 훅**([hooks](hooks.md))이 트레이서에 도구 호출 결과를 흘려보낼 수 있다(관측 ⊕ 훅 합성).
- `run.mjs`는 실행 후 `last-trace.json`(`{events, summary}`)을 남기고 요약을 출력한다(민감정보 redaction 적용).

## 검증

[runner/tracer.test.mjs](../runner/tracer.test.mjs) — `node --test "harness/runner/*.test.mjs"`:
상관 ID·seq 부여 / 요약 롤업(카운트·blocked·duration·cost) / redaction / toJSON 직렬화 /
오케스트레이터가 트레이스+요약을 냄 / 훅→트레이서 합성. **6/6**(러너 스위트 누적 **39/39**).

## 한계 / 다음

지금은 **인메모리 트레이스 + JSON 영속**까지. 토큰/비용은 호스트가 `cost` 필드로 넣어주면 합산된다
(에이전트 CLI가 비용을 노출하면 배선). (세션 영속·메모리 런타임도 이후 코드로 채워짐 —
[architecture §4](architecture.md).)
