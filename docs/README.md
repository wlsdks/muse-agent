---
title: Muse 문서 안내 (인덱스)
audience: [기획자, 개발자, AI 에이전트]
purpose: Muse 문서 집합의 단일 진입점 — 어떤 문서가 무엇을 담는지
updated: 2026-05-29
related: [SYSTEM-MAP.md, FEATURES.md, strategy/identity.md]
---

# Muse 문서 안내

Muse 문서는 "필요한 것만, 짧게, 잘 분리해서" 유지합니다. 처음이라면 **[SYSTEM-MAP](SYSTEM-MAP.md)** 한 장만 봐도 전체 윤곽이 잡힙니다.

## 제품을 이해하려면

| 문서 | 무엇 | 누구에게 |
|---|---|---|
| **[SYSTEM-MAP.md](SYSTEM-MAP.md)** | Muse 기능을 한눈에 보는 구조 지도 (말로만, 빠른 파악용) | 기획·개발 모두 / 처음 보는 사람 |
| **[FEATURES.md](FEATURES.md)** | 기능별 상세 정의 (사용자 입장에서 무엇을 어떻게) | 기획·설계 의사결정 |
| **[strategy/identity.md](strategy/identity.md)** | 제품 정체성·전략·북극성 ("왜 Muse인가") | 방향 결정 |
| **[strategy/the-edge.md](strategy/the-edge.md)** | 기능적 차별점 — "작업을 보여준다"(모든 표면의 그라운딩+인용 게이트) | 방향 결정 |
| **[privacy-and-data.md](privacy-and-data.md)** | 내 데이터는 어디 있고 무엇이 절대 안 나가나 (프라이버시 요약) | 도입 전 확인하는 사람 |

## 직접 돌려보려면

| 문서 | 무엇 |
|---|---|
| **[setup-local-llm.md](setup-local-llm.md)** | 로컬 LLM(Ollama 등)으로 Muse를 띄우는 설치 가이드 |

## 더 깊이 — 설계 노트

[`design/`](design/) 폴더에는 개별 기능의 설계 노트가 한 주제당 한 파일로 들어 있습니다. 대부분은 **이미 출시된 기능의 설계 근거(왜 그렇게 만들었나)** 기록이고, [background-review-engine](design/background-review-engine.md)이 현재 진행 중인 설계입니다. 기능의 "무엇"은 위 제품 문서를, "왜"는 여기를 보세요:

- 기억·인지: [episodic-memory](design/episodic-memory.md), [proactive-surfacing](design/proactive-surfacing.md), [pattern-detection](design/pattern-detection.md), [context-engineering-roadmap](design/context-engineering-roadmap.md)
- 능동·후속: [agent-self-followup](design/agent-self-followup.md), [reminder-firing](design/reminder-firing.md), [background-review-engine](design/background-review-engine.md)
- 채널·음성: [messaging](design/messaging.md), [line-webhook](design/line-webhook.md), [voice-mode](design/voice-mode.md), [phase-d-chat-stream-routing](design/phase-d-chat-stream-routing.md)
- 멀티에이전트·연합: [a2a-swarm](design/a2a-swarm.md)

## 에이전트 하네스 (운영 구조)

[`../harness/`](../harness/README.md) — 어떤 AI 에이전트가 들어와도 동일하게 협업하도록 하는 팀 구성·역할·핸드오프 정의(2026-05 검증된 멀티에이전트 패턴 기반). **지금 구성을 한눈에 보려면 → [구성도 & 자가평가(architecture)](../harness/architecture.md)** (한 장 다이어그램 + 12칸 자가평가 + 문서 지도). 역할 정의는 [팀 구성(team-roles)](../harness/team-roles.md).

## 자율 확장 루프 (운영)

이 문서들은 Muse를 스스로 확장하는 자율 루프의 운영 장치입니다(제품 기능 설명이 아님):

- [`EXPANSION-PLAYBOOK.md`](EXPANSION-PLAYBOOK.md) — 자율 세션 브리프
- [`goals/`](goals/) — 능력 배송 원장(CAPABILITIES)·확장 목표(OUTWARD-TARGETS)·백로그·과거 기록(archive)

---

> 정리 원칙: 한 문서에 모든 걸 몰아넣지 않습니다. 새 주제는 **작은 새 문서 + 여기 인덱스에 링크 한 줄**로 추가하고, 이미 출시돼 본문에 흡수된 거대 계획/감사 기록은 git 히스토리에 맡기고 제거합니다.
