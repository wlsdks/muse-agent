---
title: 하네스 설치 (Install) — 아무 프로젝트에든 까는 법
audience: [개발자, AI 에이전트]
purpose: 이 harness/ 폴더를 어떤 프로젝트에든 복사해 활성화하는 3단계
updated: 2026-06-13
---

# 하네스 설치 — 아무 프로젝트에든

**이 `harness/` 폴더 하나가 통째로 하네스입니다.** 자체완결이라(외부 의존 없음) 어떤 프로젝트에든
복사해 넣고 진입점만 가리키면 그 프로젝트의 에이전트들이 같은 방식으로 일합니다.

## 3단계

1. **복사** — 이 `harness/` 폴더를 대상 프로젝트 루트에 복사합니다. 두 가지 크기:
   ```
   # 전체 설치 (레퍼런스·러너 포함)
   cp -r harness /path/to/your-project/harness

   # 최소 설치 (T1 코어 계약 6장 — 지시-층 하네스로 충분; README §포터블 구조)
   mkdir -p /path/to/your-project/harness
   cp harness/{AGENTS,handoff-template,role-prompts,team-roles,verification-and-guardrails,permission-matrix}.md \
      /path/to/your-project/harness/
   ```
   - `runner/`는 **헤드리스 자동화·게이트 코드 강제가 필요할 때만** 가져갑니다([AGENTS.md §3.5](AGENTS.md)).
   - **측정 기록은 리셋합니다** — golden-set의 진행표와 harness-acceptance §7.5는 *이 레포의* 실측
     기록이니, 새 프로젝트에선 표를 비우고 그 프로젝트의 실측으로 다시 쌓으세요(틀은 재사용).
   - `dev-loop.md`는 호스트(예: Muse) 전용 개발 루프 — 가져가려면 당신 프로젝트의 루프로 재작성합니다.

2. **진입점 연결** — 대상 프로젝트 루트의 `AGENTS.md`(없으면 새로 만듦)에 한 줄 추가:
   ```
   ## 에이전트 운영 방식
   이 저장소의 모든 에이전트는 harness/AGENTS.md 의 운영 계약대로 일한다.
   작업 전 harness/AGENTS.md 를 먼저 읽고 그 역할·게이트·핸드오프·검증을 따른다.
   ```
   - `AGENTS.md`는 Codex·Cursor·Copilot·Windsurf·Amp·Devin 등이 **네이티브로** 읽는 교차도구 표준입니다.
   - **Claude Code는 `CLAUDE.md`만 자동 로드합니다 — `AGENTS.md`는 import하지 않으면 무시됩니다**
     (공식: [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory.md)). 그래서 같은 한 줄을
     `CLAUDE.md`에도 두거나, `CLAUDE.md` 안에 `@AGENTS.md` 한 줄로 import하세요(공식 권장; 심링크
     `ln -s AGENTS.md CLAUDE.md`는 Unix/Mac 한정).

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
