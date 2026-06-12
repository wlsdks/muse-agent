---
title: 컨텍스트 압축 (Context Compaction)
audience: [개발자, AI 에이전트]
purpose: 유한한 문맥 창이 넘치지 않게 — 무엇을 언제 줄이고, 무엇을 잃지 말아야 하나
status: draft
updated: 2026-06-13
sources_basis: [Muse context-engineering-roadmap Phase 5 (importance-weighted compaction), Muse 에피소드 압축 요약, Anthropic multi-agent (subagent 1-2K token summaries), 2026 context compression governance refs]
related: [loop-budget.md, failure-modes-and-observability.md, ../core/team-roles.md, architecture.md, ../README.md]
---

# 컨텍스트 압축 (Context Compaction)

> **왜 이 칸인가?** [architecture](architecture.md) 자가평가에서 비어 있던 칸(현재 ✅). 문맥 창은 유한한데 긴 작업은
> 맥락이 계속 불어납니다 — 넘치면 모델이 한계 근처에서 소심해지거나 정보를 잃습니다([failure-modes
> §1 맥락부패](failure-modes-and-observability.md)). 또 **맥락이 곧 비용**이라([loop-budget §4]
> (loop-budget.md)) 줄이는 건 안정성과 비용 둘 다의 문제입니다. Muse는 이미 중요도 가중 압축을
> 갖췄으니(아래), 그 위에서 "무엇을·언제·어떻게 줄이나"를 규약으로 정리합니다. 말로만(코드 없음).

## 0. 한 줄 원칙

**합치기보다 줄이되, 결정을 잃지 마라.** 맥락을 무작정 통째로 들고 가지 말고, 한계 전에 미리 줄이되
**핵심 사실·사건·결정**은 보존합니다. (병렬로 나누기 전에 줄이기 — [team-roles §0]의 단일 스레드 원칙.)

## 1. 언제 줄이나 (트리거)

- **한계 전에 미리 — '덤 존' 기준으로.** 실무 데이터(~10만 개발 세션)에서 컨텍스트 창이
  **~40% 차는 시점부터** 회상·추론이 저하됩니다(Horthy "dumb zone") — 창의 절반 한참 전을
  선제 압축선으로 잡습니다.
- **주기적으로** — 도구 호출 10~15회마다 압축을 예약하면 품질을 지키며 토큰을 크게 아낍니다.
- **구조 경계에서 폴딩** — 토큰 임계가 아니라 **서브태스크 경계**에서 분기→완료 요약으로 접는
  편이 낫습니다(context-folding: active context 10× 축소에 성능 동등, 2510.11967). 우리
  [project.mjs](../runner/project.mjs)의 서브태스크 합성·1~2K 압축 반환이 그 형태입니다.
- **예산 인지** — 남은 예산이 빠듯해지면(HIGH→CRITICAL) 더 공격적으로 줄입니다([loop-budget](loop-budget.md)와 맞물림).

## 2. 무엇을 남기나 (선택적 보존)

- **중요도 가중** — 메시지마다 중요도를 매겨 **낮은 것부터** 버리고, 높은 것(활성 작업·결정·미해결)은
  남깁니다. Muse는 이 중요도 가중 압축을 실제로 지원합니다(기본은 시간순, 옵션으로 중요도순).
- **도구쌍 보존** — 도구 호출과 그 결과의 짝을 깨지 않게 유지합니다.
- **핵심만 요약** — 오래된 대화는 버리지 말고 **사건·결정·핵심 사실**로 요약해 둡니다.

## 3. 어떻게 줄이나 (기법)

- **요약(summarization)** — 지난 구간을 압축 요약으로 대체. Muse는 세션이 끝나면 압축 요약을 만들고,
  그 요약은 이후 회상(에피소드)에서 다시 검색됩니다.
- **가지치기(pruning)** — 낮은 중요도 메시지를 떨궈냄.
- **서브에이전트 압축** — 워커가 자기 격리 창에서 일하고 **1~2천 토큰의 압축 요약만** 지휘자에게
  돌려줍니다([team-roles §3]의 압축 반환과 일치 — 정보가 본류 창을 채우지 않게).
- **외부로 빼기** — 분량이 크면 대화 이력 대신 외부 파일/핸드오프 양식에 적고 링크로 가리킵니다.

## 4. 잃지 말아야 할 것 (거버넌스 — 압축의 위험)

- 압축은 **노이즈·낡음·충돌을 고쳐주지 않습니다** — 줄이기 전에 맥락 품질을 봅니다.
- 무분별한 압축은 **답을 맞게 만들던 디테일·출처를 지웁니다**. "작업을 보여준다"(인용 가능)를 깨지
  않도록, 인용 근거가 된 출처는 보존합니다([the-edge]는 SYSTEM-MAP 참고).
- 압축은 **명시적으로 예약**돼야 효과적입니다 — "알아서 잊겠지"는 품질 손실로 이어집니다.
- **압축 결과도 검증 대상입니다** — 요약이 결정·출처·앞으로의 의도(forward intent)를 보존했는지
  점검을 거친 압축이 맹목 요약보다 정확도 +8.8pp(Slipstream 2605.08580). §4.5 실측(pass^2)이
  그 점검의 수동 형태 — 압축마다 "결정·출처 보존?"을 묻고 통과해야 대체합니다.
- **컨텍스트 윈도를 넘는 장기 작업엔 압축만으론 부족합니다**(Anthropic effective-harnesses:
  "compaction isn't sufficient") — 기능 목록·진행 파일 같은 **구조적 상태**가 필요합니다 →
  [session-persistence](session-persistence.md).

## 4.5 실측 (실제 Claude Code로 압축 보존 규칙 검증, 2026-05-31)

압축의 핵심 위험은 **줄이면서 결정·출처를 같이 지우는 것**(§4 거버넌스). 잡담과 결정이 섞인 로그를
주고 압축시켜, 무엇을 남기고 무엇을 버리는지 봤습니다.

- **입력:** 날씨·점심 잡담 사이에 결정 둘이 근거와 함께 묻힌 대화 로그 — ① "배포는 매주 화 10시 고정
  (근거: 인프라팀 회의록)" ② "금요일 배포 금지(근거: 과거 장애 3건 회고)".
- **결과(2회 반복 동일):** 두 결정을 **근거(출처)까지 그대로 보존**하고, 날씨·점심 잡담은 전부 제거.
  pass^2. "줄이되 결정을 잃지 마라"와 "인용 근거 보존"이 둘 다 지켜짐.

> 의미: 압축이 문서뿐 아니라 **실제로 노이즈만 버리고 결정+출처는 남긴다**는 증거. 무분별 압축이
> 정답 디테일·출처를 지우는 위험(§4)이 실측에서 발생하지 않음. [harness-acceptance §7.5](harness-acceptance.md).

## 5. 한 줄 요약 (압축 체크리스트)

1. 한계 **전에** + **주기적**(10~15콜) + **예산 인지**로 줄이나?
2. **중요도 가중**으로 낮은 것부터, 도구쌍·결정은 보존하나?
3. 오래된 구간은 **사건·결정 요약**으로 남나(통째 폐기 아님)?
4. 서브에이전트는 **1~2K 압축 요약**만 올리나?
5. 압축이 **출처·정답 디테일**을 지우지 않나(거버넌스)?

---

## 출처 (검증 기반)

- Muse 설계 — `docs/design/context-engineering-roadmap.md` Phase 5 (중요도 가중 압축: 낮은 중요도부터 드롭, 도구쌍 보존, 기본 시간순/옵션 중요도순 — Shipped)
- Muse 제품 — SYSTEM-MAP #5/#6 (세션 압축 요약 → 에피소드 회상, 중복 기억 정리)
- Anthropic — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (서브에이전트 1~2K 토큰 압축 요약·외부 파일로 빼기)
- Atlan — [Context Compression: Techniques, Risks, Governance 2026](https://atlan.com/know/context-compression/) (요약·가지치기 6기법 + 거버넌스 위험)
- [Context compaction in agent frameworks 2026](https://dev.to/crabtalk/context-compaction-in-agent-frameworks-4ckk) (선제·주기적 압축, 예산 인지)
- Dex Horthy/HumanLayer — [RPI·dumb zone](https://linearb.io/dev-interrupted/podcast/dex-horthy-humanlayer-rpi-methodology-ralph-loop) (~10만 세션: 창 ~40%부터 성능 저하 — 의도적 선제 압축)
- [Context-Folding (2510.11967)](https://arxiv.org/abs/2510.11967) (서브태스크 경계 폴딩, active context 10×↓) · [Slipstream (2605.08580)](https://arxiv.org/abs/2605.08580) (압축 검증 +8.8pp) · Anthropic — [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (장기엔 압축만으론 부족 — 구조적 상태)
