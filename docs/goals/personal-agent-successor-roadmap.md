---
title: Muse personal-agent successor roadmap
audience: [owner, product, engineering, evaluation]
purpose: Continue from Core100 with bounded evidence and release-gap closure
status: active-authoritative
decision: continue-with-successor
activatedFromHead: 926c01738b9be9a8b1c3668ec61c2b66d17dce63
updated: 2026-07-29
related:
  - personal-agent-core-100-roadmap.md
  - ../development/personal-agent-qualification.md
  - ../development/ai-agent-testing-strategy.md
  - ../../harness/AGENTS.md
---

# Muse personal-agent successor roadmap

## 결정

Core100-100의 결정은 `continue-with-successor`다. 현재 background runtime은 healthy/pass지만
capability와 delivery는 `unverified`, release evidence는 `red`, organic effectiveness는
`not-proven`이다. 이를 `release-ready`로 추정하지 않는다.

Muse의 controlled continuity, encrypted restore, daemon rollback, provider-neutral runtime 기반은
다음 실험을 계속할 가치가 있고, 남은 blocker는 아래의 회복 가능한 20분 slice로 줄일 수 있다.
외부 publication, tag/release, signing, credential 사용, delivery brake 해제는 이 결정으로
허가되지 않는다.

## 실행 계약

- 각 activation의 active wall-clock은 20분, 단일 명령은 12분을 넘지 않는다.
- legacy 990분 capability battery는 실행하지 않는다. 기존 bounded shard만 집계하고 실제로
  비어 있는 shard를 한 번에 하나만 실행한다.
- source-changing BUILD WIP는 1개, read-only EVIDENCE/MONITOR WIP는 1개다.
- deterministic, controlled-live, organic-production denominator를 서로 승격하지 않는다.
- current HEAD/tree/time/input hash와 맞지 않는 artifact는 green evidence가 아니다.
- release/signature/credential/permission/process boundary는 Sol에서 시작하고 fresh evaluator가
  독립 판정한다.
- red blocker를 닫지 못한 slice는 `monitoring` 또는 `blocked`로 남기고 다음 dependency-ready
  safety/reliability slice로 이동한다.

## Authoritative execution order

| ID | lane | 20분 slice | acceptance | dependency |
| --- | --- | --- | --- | --- |
| PA-S001 | EVIDENCE | Core100의 bounded capability shard와 current qualification을 current HEAD로 inventory한다. | required axis별 `verified-current`, `stale`, `missing`, `blocked`가 exact artifact/hash와 함께 보이며 어떤 shard도 실행하지 않는다. | Core100-100 |
| PA-S002 | EVAL | PA-S001에서 `missing`인 required capability axis 하나만 frozen input으로 실행한다. | 12분 내 terminal artifact, exact denominator, skip/failure reason, HEAD/tree/input hash가 있고 다른 axis나 990분 battery를 시작하지 않는다. | PA-S001 |
| PA-S003 | RELEASE | release scanner finding을 한 `ruleId × scope` slice로 hash-only 분류한다. | matched value를 출력하지 않고 false-positive, remediation-required, owner-review를 분리하며 미분류가 남으면 gate는 red다. | Core100-097 |
| PA-S004 | OPS | scheduled·overdue followup/reminder queue를 inspect-only snapshot으로 분리한다. | pending draft, scheduled, overdue denominator와 age가 보이고 send/delete/reschedule/provider call은 0이다. | current qualification |
| PA-S005 | RELEASE | package와 signature의 현재 경계를 preflight-only로 기록한다. | reproducible candidate, detached signature, commit/tag verification 중 실제 available path와 missing authority를 분리하고 signing/tag/release effect는 0이다. | PA-S003 |
| PA-S006 | RECOVERY | fresh local package candidate 하나의 isolated install-health rollback을 검증한다. | failed health가 known-good artifact로 돌아가고 personal data digest가 같으며 실제 login/reboot나 owner profile mutation은 0이다. | PA-S005, Core100-098 |
| PA-S007 | MONITOR | Core100-099의 `nextObservationAt` 이후 새 organic snapshot만 review한다. | exact user/thread/source/window/denominator/explicit label이 없으면 `not-proven`을 유지하고 기다리지 않는다. | Core100-099 |
| PA-S008 | GOVERNANCE | 모든 applicable gate를 fresh provenance로 다시 판정한다. | `release-ready`, `continue-with-successor`, `terminate` 중 하나와 blockers/rollback을 기록하고 red/unknown을 green으로 승격하지 않는다. | PA-S001, PA-S003, PA-S004, PA-S006, PA-S007 |

PA-S002는 한 번에 한 axis만 다룬다. PA-S001에서 여러 required axis가 missing이면 동일 계약으로
순차 activation하고, 각 artifact가 independently reusable할 때만 다음 axis로 간다.

## 현재 blocker와 rollback

- capability: current qualification에 exact-provenance capability attempt가 없어 `unverified`.
- delivery: local-only/provider-lock/self-learning hold는 유지되지만 delivery brake가 engaged이고
  overdue queue가 있어 `unverified`.
- release: source/candidate scan은 complete지만 미분류 finding과 verified signature 부재로 `red`.
- organic: fresh organic-production observation과 explicit outcome label이 0이라 `not-proven`.
- install: deterministic PID/list rollback은 verified지만 package, heartbeat, login/reboot proof는 없음.

Rollback baseline은 `926c01738b9be9a8b1c3668ec61c2b66d17dce63`의 normal `origin/main`이다.
successor slice가 gate를 악화시키면 force/reset 대신 해당 verified source commit을 정상 `git revert`
후 동일 gate를 재실행한다. delivery brake, provider lock, local-only setting, self-learning hold는
새 독립 evidence와 필요한 owner authority 없이는 완화하지 않는다.

