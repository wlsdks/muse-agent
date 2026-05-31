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

## 6. Agent Teams (협업·상호의존 병렬)

서브에이전트가 "맡기고 한 번 보고받기"라면, **Agent Teams**는 **동료들이 서로 직접 협업**하는 모드다
(Claude Opus 4.6, 실험 기능, **v2.1.32+** — `claude --version`). 의존이 있는 병렬 작업에 쓴다.

**켜기·시작:** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 환경변수 → `/agent-team` 슬래시 명령. (실험
플래그라 기본 off.)

**구조 (서브에이전트와의 핵심 차이):**
- **리드(lead)** = 내가 대화하는 세션. 일을 쪼개고 **공유 태스크리스트**에 배정한다(= 우리 오케스트레이터).
- **팀메이트** = 각자 **독립 Claude Code 세션**(격리 컨텍스트). 프로젝트 컨텍스트는 로드하되 리드의
  대화 이력은 상속하지 않는다.
- **공유 태스크리스트** = 누구나 직접 읽고/갱신. → 우리 [handoff-template](handoff-template.md)이 그
  디스크 공유 구조에 대응(PLAN/BUILD/EVAL 칸 + 상태 로그).
- **동료 간 직접 메시지(P2P)** = 리드를 거치지 않고 서로 알린다("API 끝났어 → UI가 이어받음"). 서브에이전트
  (중앙 경유·단일 최종 메시지·P2P 없음)와 가장 다른 점.

**우리 서브에이전트를 팀메이트로 재사용 (공식 지원):** Claude Code는 `.claude/agents/` 서브에이전트
정의를 **팀메이트로도** 띄울 수 있다("harness-evaluator 타입으로 팀메이트 스폰"). 즉 우리가 만든
`harness-{planner,worker,evaluator,curator}`가 **서브에이전트로도, 에이전트 팀의 팀메이트로도** 그대로
재사용된다(정의의 `tools` 허용목록·`model` 적용, 본문은 시스템 프롬프트에 추가; 단 `skills`·`mcpServers`
frontmatter는 팀메이트로 돌 땐 미적용 — 프로젝트/유저 설정에서 로드).

**팀 품질 게이트 훅:** `TeammateIdle`(종료 직전, exit 2로 피드백 주고 계속 일 시킴)·`TaskCreated`(생성 차단)·
`TaskCompleted`(exit 2로 완료 차단+피드백)으로 우리 fail-closed 게이트 정신을 팀 레벨에서 강제할 수 있다.

**규모·충돌:** 보통 **3~5 팀메이트**(팀메이트당 5~6 태스크), 더 늘려도 조정비용↑·수확체감. **각 팀메이트가
서로 다른 파일을 소유**(같은 파일 동시 편집=덮어쓰기 금지) — 우리 서브태스크 분해 시 파일 경계로 가른다.

**한계(실험):** 인-프로세스 팀메이트는 `/resume`·`/rewind` 복원 안 됨, 한 번에 한 팀, 중첩 팀 불가,
태스크 상태 지연 가능. 강한 의존·같은 파일이면 팀보다 순차/서브에이전트가 낫다.

**언제 무엇 (의사결정):**

| 모드 | 쓸 때 | 우리 매핑 |
|---|---|---|
| **단일 세션** | 빡빡한 순차·같은 파일 편집 | 작은 작업·강한 의존 |
| **서브에이전트** | 경계 분명·"하고 보고" 반복 작업 | `.claude/agents/harness-*` (역할별 격리) |
| **Agent Teams** | 협업·상호의존 **병렬**(서로 결과를 주고받으며 진행) | `shareContext`가 필요한 다수 갈래를 병렬로 |

**비용 규율 (Anthropic 근거 — 반드시 지킬 것):** 멀티에이전트는 채팅의 **~15배 토큰**(에이전트 단독도
~4배). 그래서 **고가치·고병렬·단일 컨텍스트 초과** 작업에만 팀을 띄운다. "복잡도에 맞춰 규모 조절"
— 간단하면 1명, 복잡하면 여럿([loop-budget](loop-budget.md) 예산과 맞물림).

**위임 품질이 최대 레버리지 (Anthropic 멀티에이전트 리서치 교훈):** 리드는 각 팀메이트/서브태스크에
**목표·출력 형식·도구 안내·작업 경계**를 분명히 줘야 한다(모호하면 중복·누락). 팀메이트는 stateless라
리드의 전체 대화를 못 보므로 **상세한 작업 기술**이 필수. 우리 `run-project.mjs`의 분해 프롬프트와
[role-prompts](role-prompts.md)가 이 원칙을 따른다.

> 우리 하네스와의 관계: Agent Teams는 **런타임 기능**(파일로 정의하지 않음)이라, 우리는 그것을 *쓰는
> 규약*만 제공한다 — 공유 태스크리스트=핸드오프 양식, 만든 자≠판정하는 자=빌드 팀메이트와 평가 팀메이트
> 분리, 비용 게이트=loop-budget. 강한 의존·같은 파일이면 팀 대신 순차(`shareContext`) 권장.

## 7. Dynamic Workflows (스크립트 오케스트레이션 — 신기능)

**Dynamic Workflows**는 2026-05-28 Opus 4.8과 함께 나온 리서치 프리뷰 기능(Claude Code **v2.1.154+**).
오케스트레이션을 **대화(턴별)가 아니라 Claude가 짜는 JavaScript 스크립트**로 옮긴다. 루프·분기·중간결과는
스크립트가 들고, **각 `agent()` 호출 안의 일만 모델**이 한다. 백그라운드 런타임이 결정론적으로 실행하고
세션은 계속 응답한다.

- **트리거:** 프롬프트에 `workflow` 단어 포함 / `/effort ultracode` / 번들·저장 워크플로(`/deep-research`).
  관리 `/workflows`(일시정지·중지·저장), 저장 위치 `.claude/workflows/`(프로젝트) — `/<name>`으로 재실행.
- **한계:** 동시 16·총 **1000 에이전트/run**, 실행 중 사용자 입력 없음(에이전트 권한 프롬프트만 멈춤),
  스크립트 자체엔 fs/shell 없음(에이전트만 읽기/쓰기/실행), 세션 내 재개(완료 에이전트는 캐시).
- **하네스 결속:** 우리 [project.mjs](runner/project.mjs)의 "분해→서브태스크 구동→합성"이 바로 이
  fan-out→reduce→synthesize의 **수기 버전**이다. **대규모·반복·결정론** 오케스트레이션(코드베이스 스윕·
  대량 마이그레이션)은 Dynamic Workflows로 올리는 게 정석 — 우리 결정론 게이트 정신과 정합.

## 8. 선택 규약 — 그냥 작업 / 서브에이전트 / 팀 / 워크플로

**기본은 단일 세션.** 작업이 *독립 스레드로 분해될 때만* 다중으로 간다(Anthropic "아키텍처는 작업
구조를 따른다"). 비용: 에이전트 단독 ~4배, 멀티에이전트 리서치 ~15배 토큰 → 고가치에만.

| 상황 | 선택 | 이유 |
|---|---|---|
| 사소·단일 단계(한 파일·빠른 수정·직답) | **그냥 작업** | 한 컨텍스트로 충분; 오케스트레이션은 순수 낭비 |
| 노이즈 큰 한 서브태스크 격리·압축(라이브러리 조사·한 모듈 감사), 결과만 필요 | **서브에이전트** | 격리 컨텍스트로 요약만 회수, 부모 컨텍스트 깨끗 |
| 한 턴 안 독립 위임 몇 개(결과가 내 컨텍스트로) | **서브에이전트** | Claude 턴별 "하고 보고"에 적합 |
| 워커들이 **협업·상호 도전·결과 주고받기**(다관점 리뷰·경쟁 가설 디버깅·계층 간 계약 협상) | **에이전트 팀** | 공유 태스크리스트+P2P 필요; ~3–4배+ 비용 정당화될 때 |
| **결정론·반복·대규모** 다단계(코드베이스 버그 스윕·보안 감사·500+파일 마이그레이션), 수십~수백 에이전트 | **워크플로** | 오케스트레이션을 스크립트로(재개·재사용), 1000 에이전트/run |
| 오케스트레이션 자체를 **감사·버전관리·동일 재실행** | **워크플로** | 오케스트레이션이 재사용 산출물(`.claude/workflows/`) |
| **엄격 순차**(앞 의존) 또는 **같은 파일 동시 편집** | **그냥 작업** | 상호의존·공유상태가 병렬을 깨뜨림 → 단일 세션이 충돌·맥락손실 회피 |
| 루틴·저가치 | **그냥 작업** | 멀티에이전트 4~15배 토큰; 결과 가치가 비용을 넘을 때만 |

**우리 하네스 매핑:** 그냥작업=`runCycle` 1회 / 서브에이전트=`.claude/agents/harness-*` / 에이전트 팀=
같은 harness-* 정의를 팀메이트로 / 워크플로=`project.mjs`의 코드화·대규모는 Dynamic Workflows. 어느
모드든 **게이트·핸드오프·검증 규약은 동일**하게 얹는다.

> 버전·모델(2026-06 기준): Claude Code **v2.1.158**, 최신 모델 **Opus 4.8**. 에이전트 팀 v2.1.32+,
> Dynamic Workflows v2.1.154+. "Workflows"는 팀/서브에이전트와 **별개의 신기능**(혼동 금지).

## 출처

- Claude Code — [Subagents](https://docs.claude.com/en/docs/claude-code/sub-agents) (`.claude/agents` 형식·격리 컨텍스트·도구 권한·자동 위임)
- Claude Code — [Dynamic Workflows](https://code.claude.com/docs/en/workflows) (스크립트 오케스트레이션·v2.1.154+·16동시/1000총·`.claude/workflows/`)
- Anthropic — [Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) · [Claude Opus 4.8](https://www.anthropic.com/news/claude-opus-4-8) (2026-05-28)
- Claude Code — [Agent Teams](https://code.claude.com/docs/en/agent-teams) (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`·`/agent-team`·리드/팀메이트·공유 태스크리스트·P2P)
- Anthropic — [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (오케스트레이터-워커·멀티에이전트 ~15배 토큰·위임 품질이 최대 레버리지·복잡도에 맞춘 규모)
- Claude Code — [Hooks](https://docs.claude.com/en/docs/claude-code/hooks) (`SubagentStop` 등 결정론 라이프사이클 훅)
- [Claude Code Agent Teams & Subagents 2026 Playbook](https://www.developersdigest.tech/blog/claude-code-agent-teams-subagents-2026) (최대 10 병렬·병렬/순차·위임 1단계·디스크 통신)
