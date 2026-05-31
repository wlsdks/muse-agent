---
title: Claude Code 통합 (서브에이전트·에이전트 팀)
audience: [개발자, AI 에이전트]
purpose: 이 하네스를 Claude Code의 네이티브 서브에이전트·에이전트 팀 기능으로 실제 운용하는 법
updated: 2026-05-31
sources_basis: [Claude Code Subagents 공식 문서, Claude Code Hooks 문서, 2026-05 서브에이전트 플레이북]
related: [AGENTS.md, team-roles.md, role-prompts.md, handoff-template.md, runner/README.md]
---

# Claude Code 통합 — 서브에이전트·에이전트 팀

이 하네스는 **Claude Code 전용**입니다. 그래서 "병렬·격리 서브에이전트"를 우리가 새로 만들지 않고,
Claude Code의 **네이티브 서브에이전트**로 운용합니다. 하네스 역할은 실제 서브에이전트 파일로 존재합니다.

## 1. 실제 서브에이전트 파일 (`.claude/agents/`)

역할 프롬프트([role-prompts](role-prompts.md))를 Claude Code가 읽는 **진짜 서브에이전트**로 박았습니다
(2026 형식: `name`·`description`(자동 위임 기준)·`tools`(최소권한)·`model` + 본문 시스템 프롬프트):

| 파일 | 역할 | 도구(최소권한) | model |
|---|---|---|---|
| `.claude/agents/harness-planner.md` | 플래너(수용 기준) | Read·Grep·Glob (읽기전용) | opus |
| `.claude/agents/harness-worker.md` | 워커(빌드) | Read·Grep·Glob·Write·Edit·Bash | sonnet |
| `.claude/agents/harness-evaluator.md` | 평가자(독립 판정) | Read·Grep·Glob·Bash (쓰기 없음) | opus |
| `.claude/agents/harness-curator.md` | 큐레이터(학습) | Read·Grep·Glob·Write | haiku |

핵심: **평가자는 워커와 다른 서브에이전트**(쓰기 권한 없음)라 "만든 자 ≠ 판정하는 자"가 도구 권한으로도
강제됩니다. 메인 스레드(오케스트레이터)가 Task 도구로 이들에게 위임합니다.

## 2. 병렬 vs 순차 (의존성으로 결정)

Claude Code는 **최대 10개 서브에이전트를 병렬** 실행합니다. 우리 [project.mjs](runner/project.mjs)의
`shareContext`가 그 판단 기준과 정확히 맞물립니다:

- **독립 서브태스크 → 병렬.** 서로 결과를 안 쓰면 메인이 동시에 여러 서브에이전트로 띄운다(조사·서로 다른
  파일·독립 컴포넌트). 우리 쪽 `shareContext:false`에 해당.
- **의존 서브태스크 → 순차.** 앞 출력이 뒤 입력이면 메인이 하나씩 기다린다. 우리 `shareContext:true`
  (앞 산출→뒤 입력)에 해당 — [§서브태스크 의존](runner/README.md).

## 3. 제약과 규약 (레퍼런스 기준)

- **위임은 1단계(평평하게).** 서브에이전트는 다른 서브에이전트를 못 띄운다 — **메인 스레드만**
  오케스트레이터다. 우리 `runProject`의 오케스트레이터 = 그 메인 스레드 역할.
- **교차 통신 = 디스크.** 서브에이전트는 컨텍스트가 격리돼 직접 상태 공유가 안 된다 → **핸드오프 파일**
  ([handoff-template](handoff-template.md))이 그 디스크 채널이다(PLAN/BUILD/EVAL 칸).
- **집계는 SubagentStop 훅.** 병렬 결과 합치기·로깅은 결정론 훅 `SubagentStop`에서 한다(모델 선택이
  아니라 고정 시점). 우리 [hooks](hooks.md)의 PostToolUse 사상과 같은 결.
- **최소 권한·또렷한 description.** 각 서브에이전트는 필요한 도구만, description은 "언제 위임하는지"를
  분명히(자동 위임 정확도). 위 4개 파일이 그 규칙을 따른다.

## 4. 두 가지 운용 모드

- **세션 안(권장, 네이티브):** Claude Code 세션에서 메인 에이전트가 위 서브에이전트에 Task로 위임 →
  격리 컨텍스트·병렬·SubagentStop 집계까지 네이티브로. 하네스 규약(게이트·핸드오프)을 그 위에 적용.
- **CLI 밖(`claude -p`):** [run.mjs](runner/run.mjs)/[run-project.mjs](runner/run-project.mjs)가 역할마다
  새 `claude -p`를 띄움 — 이것도 격리 컨텍스트(서브에이전트와 같은 효과)지만 순차다. 결정론 게이트·
  트레이스·세션 영속이 필요한 자동화엔 이쪽.

## 5. 검증

서브에이전트 파일의 frontmatter 규약(name 소문자-하이픈·description·tools·model)을 구조 검증하고
([runner/README.md]의 러너 스위트와 별개), 세션 내 실제 위임은 Claude Code Task 도구로 확인합니다.

## 출처

- Claude Code — [Subagents](https://docs.claude.com/en/docs/claude-code/sub-agents) (`.claude/agents` 형식·격리 컨텍스트·도구 권한·자동 위임)
- Claude Code — [Hooks](https://docs.claude.com/en/docs/claude-code/hooks) (`SubagentStop` 등 결정론 라이프사이클 훅)
- [Claude Code Agent Teams & Subagents 2026 Playbook](https://www.developersdigest.tech/blog/claude-code-agent-teams-subagents-2026) (최대 10 병렬·병렬/순차·위임 1단계·디스크 통신)
