---
title: 세션 영속 (Session Persistence — 체크포인트·재개)
audience: [개발자, AI 에이전트]
purpose: 실행 상태를 체크포인트로 남겨, 멈춘/죽은 실행을 완료 단계 재실행 없이 재개
updated: 2026-06-13
---

# 세션 영속 (Session Persistence)

정통 하네스 제어플레인의 핵심 정의 중 하나 — "turn을 가로지르는 **상태 유지**", Anthropic
effective-harnesses의 "여러 컨텍스트 윈도를 가로지르는 **일관된 진행**". 긴 작업이 중간에 끊겨도
**이미 끝낸 단계(특히 비싼 에이전트 호출)를 다시 돌리지 않고 이어서** 진행하게 합니다. 관측
트레이스([observability](observability.md))가 "무슨 일이 있었나"라면, 세션 영속은 "어디서부터 다시"입니다.

## 무엇인가

[runner/session.mjs](../runner/session.mjs) (의존성 0 — fs는 Node 내장):

- **스냅샷** `snapshot({runId, phase, criteria, attempt, build, verdict})` — 재개에 필요한 최소 상태.
  계획 단계(criteria)·재시도 횟수·이미 만든 빌드를 담아 **재계획·재빌드를 건너뛸** 수 있게 함.
- `serializeSession` / `deserializeSession` — JSON 직렬화·검증(버전 `v:1`, 잘못된 건 거부).
- **스토어(주입식, 포터블)** — `createMemoryStore()`(테스트용), `createFileStore(dir)`(runId당 JSON 파일).
  호스트가 DB 스토어를 끼워도 됨(인터페이스: `save(s)`·`load(runId)`·`list()`).

## 어떻게 배선됐나

- `runCycle(task, { checkpoint })` — 각 단계(PLANNED·BUILT·EVALUATED·DONE)마다 `checkpoint(snapshot)`을
  호출. 호스트가 그걸 스토어에 저장.
- `runCycle(task, { resume: snapshot })` — 재개. **phase가 PLANNED 이상이면 플래너를 다시 안 부르고**
  저장된 criteria를 재사용하고, **빌드가 이미 있으면 워커를 건너뛰고** 평가로 바로 간다(`resumed` 이벤트 기록).
- `run.mjs`는 실행마다 `sessions/<runId>.session.json`에 체크포인트를 남긴다(gitignore된 산출물). 재개하려면
  그 스냅샷을 로드해 `resume`으로 넘기면 됨.

## 검증

[runner/session.test.mjs](../runner/session.test.mjs) — `node --test "harness/runner/*.test.mjs"`:
스냅샷 라운드트립·잘못된 스냅샷 거부 / 메모리 스토어 save·load·list / 파일 스토어 디스크 영속 /
오케스트레이터가 4단계 체크포인트 / **PLANNED 재개 시 플래너 미호출(criteria 재사용)** / **빌드 보유
재개 시 워커 미호출**. **6/6**(러너 스위트 누적 **45/45**).

## 컨텍스트 윈도를 넘는 작업 (구조적 상태 — 압축만으론 부족)

여러 컨텍스트 윈도에 걸치는 긴 작업은 체크포인트+압축으로 부족합니다(Anthropic
effective-harnesses: "compaction isn't sufficient"). 구조적 스캐폴딩을 함께 둡니다:

- **기능 목록 파일** — 끝-대-끝 기능 묶음을 구조화 파일(JSON)로 두되 **전부 '실패' 상태로
  시작** — 이른 "done" 선언을 구조로 막습니다(골든셋 진행표와 동형). 신중한 검증 후에만
  'passing' 전환.
- **진행 파일 + git 로그가 곧 핸드오프** — 새 세션은 git log와 진행 파일을 *먼저 읽고* 시작.
  작동 상태마다 커밋(복구 지점).
- **세션당 기능 하나** — 한 세션이 여러 기능을 벌리지 않게(컨텍스트·검증 둘 다를 위해).
- **첫 세션은 초기화 전담** — 환경 셋업만 하는 initializer 세션을 분리(이후 세션은 일만).

출처: Anthropic — [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (2025-11).

## 한계 / 다음

스냅샷은 단계 경계 상태까지(전체 트레이스 재구성은 아님 — 그건 관측 트레이스의 몫). 비용 누계·부분
토큰 상태의 정밀 재개는 호스트 런타임 몫. (메모리 런타임도 이후 `memory.mjs`로 코드화 —
[memory-layers §런타임](memory-layers.md).)
