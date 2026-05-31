---
title: 하네스 설치 (Install) — 아무 프로젝트에든 까는 법
audience: [개발자, AI 에이전트]
purpose: 이 harness/ 폴더를 어떤 프로젝트에든 복사해 활성화하는 3단계
updated: 2026-05-31
---

# 하네스 설치 — 아무 프로젝트에든

**이 `harness/` 폴더 하나가 통째로 하네스입니다.** 자체완결이라(외부 의존 없음) 어떤 프로젝트에든
복사해 넣고 진입점만 가리키면 그 프로젝트의 에이전트들이 같은 방식으로 일합니다.

## 3단계

1. **복사** — 이 `harness/` 폴더를 대상 프로젝트 루트에 그대로 복사합니다.
   ```
   cp -r harness /path/to/your-project/harness
   ```

2. **진입점 연결** — 대상 프로젝트 루트의 `AGENTS.md`(없으면 새로 만듦)에 한 줄 추가:
   ```
   ## 에이전트 운영 방식
   이 저장소의 모든 에이전트는 harness/AGENTS.md 의 운영 계약대로 일한다.
   작업 전 harness/AGENTS.md 를 먼저 읽고 그 역할·게이트·핸드오프·검증을 따른다.
   ```
   - `AGENTS.md`는 Codex·Cursor·Copilot·Windsurf·Amp·Devin 등이 **네이티브로** 읽는 교차도구 표준입니다.
   - **Claude Code**를 쓰면 같은 한 줄을 `CLAUDE.md`에도 두거나, `CLAUDE.md`가 `AGENTS.md`를 가리키게
     하세요(많은 팀이 `CLAUDE.md` → `AGENTS.md` 심링크로 통일).

3. **프로젝트에 맞추기** — `harness/muse-mapping.md`를 복제해 **당신 프로젝트용 매핑**으로 바꿉니다
   (추상 역할 ↔ 당신의 실제 런타임/도구). 이 파일만 프로젝트마다 다르고, 나머지는 그대로 재사용.

## 확인 (활성화됐는지)

설치 후, 에이전트에게 위험한 요청(예: "제3자에게 지금 바로 메일 보내")을 시켜 보세요.
하네스가 활성화됐다면 **자동 전송 대신 초안+사람 확인(외부전송 게이트)** 으로 응답해야 합니다.
빈 수용 기준으로 판정을 시키면 **"검증 불가"로 막혀야** 합니다([harness-acceptance](harness-acceptance.md)의
실측 케이스가 그 검사들입니다).

## 무엇이 들어있나 (폴더 내용)

- **[AGENTS.md](AGENTS.md)** — 진입점(에이전트가 읽고 따르는 운영 계약). **여기부터.**
- **[README.md](README.md)** — 사람용 인덱스(읽는 순서).
- **역할·흐름** — [architecture](architecture.md) · [team-roles](team-roles.md) · [role-prompts](role-prompts.md) · [handoff-template](handoff-template.md)
- **게이트·안전** — [verification-and-guardrails](verification-and-guardrails.md) · [permission-matrix](permission-matrix.md) · [failure-modes-and-observability](failure-modes-and-observability.md)
- **토대** — [memory-layers](memory-layers.md) · [context-compaction](context-compaction.md) · [loop-budget](loop-budget.md) · [tool-design](tool-design.md) · [skills-and-mcp](skills-and-mcp.md) · [debugging-and-dx](debugging-and-dx.md)
- **검증** — [golden-set](golden-set.md) · [harness-acceptance](harness-acceptance.md) · [runner-spec](runner-spec.md)
- **프로젝트 매핑(교체용 예시)** — [muse-mapping](muse-mapping.md)
