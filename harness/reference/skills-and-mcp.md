---
title: 스킬 & 외부 도구 통합 (Skills & MCP)
audience: [개발자, AI 에이전트]
purpose: 외부 도구(MCP 서버)·자작 스킬을 하네스에 안전하게 끌어오는 규약 — 허용목록·격리·신뢰 경계
status: draft
updated: 2026-06-13
sources_basis: [호스트 .claude(예: Muse)/rules/architecture.md (MCP allowlist), 호스트 tool-calling 규약, MCP Security Best Practices 2026, OWASP secure MCP, NVIDIA sandboxing agentic workflows]
related: [tool-design.md, ../core/verification-and-guardrails.md, ../core/team-roles.md, architecture.md, ../README.md]
---

# 스킬 & 외부 도구 통합 (Skills & MCP)

> **왜 이게 빠진 칸이었나?** [architecture](architecture.md) 자가평가에서 "스킬/MCP"가 ⬜ 갭이었습니다.
> 하네스가 외부 도구를 끌어올 때 **신뢰 경계**가 없으면, 좋은 역할·게이트가 다 무력화됩니다(2026엔
> MCP 명령 주입이 CVE의 큰 비중). 호스트(예: Muse)의 실제 MCP 허용목록 정책을 근거로, 검증된 2026 보안
> 원칙과 함께 정리합니다. 말로만(코드 없음).

## 0. 한 줄 원칙

**외부에서 온 도구·스킬은 기본 불신.** 허용한 것만, 격리된 채로, 최소 권한으로 끌어오고, 그 출력은
신뢰하지 않습니다. 모델이 조종당할 수 있다고 가정하고 **도구 레이어가 위험한 곳에 닿지 못하게** 막습니다.

## 1. 무엇을 끌어오나 (두 종류)

- **외부 도구 서버(MCP)** — 다른 곳이 만든 도구를 프로토콜로 연결(예: 내 실제 크롬을 모는 도구).
- **자작 스킬** — 교정에서 스스로 써둔 절차형 스킬([team-roles](../core/team-roles.md)의 자기개선과 연결).

둘 다 "능력을 늘리되 신뢰 경계를 넘지 않게"가 핵심입니다.

## 2. 허용목록은 2단계로 (Muse의 방식)

- 어떤 외부 서버를 쓸지 **이름 허용목록**으로 통제합니다.
- **등록 시**: 허용목록에 없으면 연결 후보에서 빼고 비활성으로 표시(예외 던지지 않음 — fail-soft).
- **연결 시**: 다시 한 번 허용 여부를 확인 — 등록과 연결 사이에 정책이 바뀌어도 막힙니다.
- 빈 허용목록 = 전부 허용(opt-in 자세). 다중 MCP·공용 워크스테이션이면 **엄격 목록을 채웁니다.**
- 정확한 이름/호스트 목록이 넓은 와일드카드보다 안전합니다. allow와 deny가 겹치면 **deny 우선.**

## 3. 받은 것은 격리·불신 (untrusted)

- **받은 스킬/노하우는 사람이 승격하기 전까지 비활성 격리** — 받자마자 실행되지 않습니다.
- 위험할 수 있는 실행은 **격리 샌드박스**(시간·출력·권한 제한)에서만. 비밀(시크릿)은 에이전트가 닿는
  파일시스템 밖에 둡니다.
- 외부 도구의 **출력은 신뢰하지 않는 입력**으로 취급합니다(프롬프트 인젝션이 그 안에 올 수 있음).

## 4. 최소 권한 + 쓰기는 사람 손 (least privilege + HITL)

- 도구 접근은 필요한 만큼만(읽기/인지가 기본). 상태를 바꾸는 행동은 [verification-and-guardrails](../core/verification-and-guardrails.md)의 게이트를 거칩니다.
- 외부로 나가거나(제출·전송) 시스템을 바꾸는 외부 도구 호출은 **draft-first·사람 확인** 뒤에만.

## 5. 유출 차단 (egress)

- 기본 차단, 필요한 목적지만 허용(block-by-default egress allowlist). 데이터 반출 경로를 좁힙니다.
- 로컬-우선 자세와 맞물립니다 — 외부 도구가 내 데이터를 밖으로 빼가지 못하게.

## 6. 신뢰/불신 맥락 분리

- 신뢰된 맥락(내 데이터·계획)과 불신 맥락(외부 도구 출력)을 섞지 않습니다.
- 외부 도구가 준 텍스트를 그대로 "명령"으로 따르지 않습니다 — 가드를 거쳐 데이터로만 씁니다.

## 6.5 구조적 인젝션 방어 (프롬프트가 아니라 설계 패턴)

§3·§6의 "불신"을 **구조로** 강제하는 검증된 패턴들(2025–26) — 인젝션 방어는 지시문이 아니라
아키텍처 속성입니다:

- **치명적 삼합(lethal trifecta) 금지** — ① 사적 데이터 접근 ② 불신 콘텐츠 수신 ③ 외부 전송
  채널, 셋이 **한 에이전트/한 턴에 공존하지 않게** 설계합니다(Willison). 권한 매트릭스로 옮기면:
  불신 입력을 읽은 컨텍스트에서는 outbound 등급을 승인이 아니라 **거부**로 올립니다.
- **제어흐름은 불신 데이터를 읽기 *전에* 고정** — 신뢰된 사용자 질의에서 계획(어떤 도구를 어떤
  순서로)을 먼저 뽑고, 불신 도구 출력은 인자만 채울 뿐 **계획 자체를 다시 쓰지 못하게** 합니다
  (plan-then-execute). CaMeL이 이 방식으로 AgentDojo 과제 77%를 *증명 가능한* 보안으로 해결.
- **최소권한의 효과는 수치로 증명됨** — 도구·인자 단위 권한 정책의 결정론 강제만으로 간접
  인젝션 공격 성공률 **41.2%→2.2%**(Progent), 유틸리티 유지. 권한 *확장*은 항상 사람 승인
  (우리 draft-first와 동형).
- 과제에 맞는 **가장 약한 패턴을 고릅니다** — action-selector / plan-then-execute / LLM
  맵리듀스 / 이중 LLM(특권+격리) / code-then-execute / context-minimization 여섯 패턴 중
  유틸리티를 최소로 깎는 것(2506.08837).

## 7. 외부 도구/스킬을 들일 때 (체크리스트)

1. **허용목록에 추가**했나(이름 정확, 와일드카드 아님)?
2. 등록·연결 **양쪽에서 허용 확인**되나(정책 변경에도)?
3. 받은 스킬이 **승격 전까지 격리**되나? 위험 실행은 **샌드박스**인가?
4. **최소 권한**인가, 쓰기/전송은 **사람 확인**을 거치나?
5. **egress 차단** 기본인가? 시크릿이 에이전트 밖에 있나?
6. 도구 출력을 **불신 입력**으로 다루나(인젝션 가드)?
7. [tool-design](tool-design.md)의 도구 설계 규약(이름·스키마·위험등급)을 따르나?

## 한 줄 요약

외부 능력은 **허용한 것만 · 격리된 채로 · 최소 권한으로 · 출력은 불신**. 등록+연결 2단계 허용목록,
받은 스킬은 승격 전 격리, 쓰기/전송은 사람 손, egress 기본 차단.

---

## 출처 (검증 기반)

- 호스트 규약(예: Muse) — `.claude/rules/architecture.md` (MCP 허용목록 2단계 enforcement: 등록 시 + 연결 시 재확인, fail-soft, 빈목록=opt-in)
- 호스트 규약(예: Muse) — `.claude/rules/iteration-loop.md` (외부 MCP는 오픈소스·로컬·허용목록·read 기본, 상태변경은 draft-first)
- [MCP Security Best Practices 2026](https://www.digitalapplied.com/blog/mcp-server-security-best-practices-2026-engineering-guide) (allowlist deny-precedence·정확호스트·auth/secrets/egress)
- OWASP — [Secure MCP Server Development](https://genai.owasp.org/resource/a-practical-guide-for-secure-mcp-server-development/) (신뢰/불신 분리·쓰기 HITL)
- NVIDIA — [Sandboxing Agentic Workflows](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/) (격리 실행·블라스트 반경)
- Simon Willison — [The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) (사적 데이터+불신 콘텐츠+외부 전송의 공존 금지 — 아키텍처 속성)
- Google DeepMind — [CaMeL: Defeating Prompt Injections by Design (2503.18813)](https://arxiv.org/abs/2503.18813) (제어흐름을 신뢰 질의에서 먼저 고정 → AgentDojo 77% 증명 가능 보안)
- [Progent (2504.11703)](https://arxiv.org/abs/2504.11703) (도구·인자 단위 최소권한 DSL — 간접 인젝션 ASR 41.2%→2.2%) · [Design Patterns for Securing LLM Agents (2506.08837)](https://arxiv.org/abs/2506.08837) (6대 증명 가능 패턴)
