# A+ 계획 — B등급 차원 전부 A+로 (2026-07-11)

> **작성**: Fable 5 (계획 전담). **집행**: Sonnet 워커 (슬라이스 단위).
> **근거**: 2026-07-11 3-프로파일 평가(Muse/openclaw/hermes 독립 에이전트) +
> **18-Haiku 정밀 스윕**(1차 7 + 2차 11; 경쟁사 클론 HEAD 2026-07-07) + Fable
> 소스 스팟체크 11건 전부 일치 확인 + 웹 평판 리서치 + 경쟁사 자체-문서 마이닝.
> 경쟁사 참조는 전부 **reference-only** (MIT/Apache 존중, verbatim 복사 금지,
> Muse 자체 설계로 재구현).
>
> 평가 결론 요약: Muse는 grounding(A+)·검증규율(A+)·학습정직성(A-)에서 유일 우위,
> agent loop(B+)·tools(B)·orchestration(B)·security(B+)·model posture(B+)가 격차.
> §2-6이 그 다섯 차원을 A+로 올리는 1차 큐, **§11이 2차 심층 스윕에서 나온
> 추가 슬라이스 + 신규 차원(D7 UX·D-KO 한국어)** + **포지셔닝 삼각검증**이다.
> §11을 반드시 함께 읽어라 — 웨이브 표(§8)는 §11 슬라이스까지 반영해 갱신됐다.

---

## 0. 워커 계약 (모든 슬라이스 공통 — 어기면 슬라이스 무효)

1. **VERIFY-FIRST (freshness guard).** 슬라이스 착수 전 반드시 Muse 코드에서 해당
   능력의 현재 상태를 확인하라 (codegraph_search/context). 이 문서의 "Muse 현재"
   란은 2026-07-11 검증이지만, 병행 루프가 먼저 출하했을 수 있다. 이미 커버돼
   있으면 **no-op 판정 후 문서의 해당 슬라이스에 ⏭️ 표기**하고 다음 슬라이스로.
   (전례: skill-curator, tool-dedup 등 다수가 no-op 회피됨 — backlog.md 참조.)
2. **검증 사다리.** 가장 좁은 단위 테스트 → mutation-RED 증명 → `pnpm test:changed`
   → lint 0/0. 에이전트-facing 변경(툴/프롬프트/어댑터)은 `eval:tools` 또는 해당
   라이브 배터리, 신규 라이브 케이스는 **STABLE 3/3** 사전 검증. 요청/응답 경로
   변경은 `smoke:live`(로컬 Ollama 전용).
3. **maker≠judge.** 슬라이스 완료 후 독립 평가자(별도 서브에이전트)가 수용 기준
   대비 PASS/FAIL. FAIL은 구체적 위반 명시 필수.
4. **비협상 (CLAUDE.md).** agent-core 벤더-중립 · 가드는 fail-close 결정론 코드
   (프롬프트로 보안 금지) · outbound는 draft-first · grounded-surface 수 절대
   하락 금지 · 주석은 WHY만(마커 금지) · 신규 내부 의존성은 package.json+tsconfig
   references 양쪽.
5. **경쟁사 코드 취급.** 파일 경로는 이해용 참조다. 열어서 메커니즘을 이해하되
   Muse의 기존 패턴/네이밍으로 새로 설계하라. 수치 상수는 Muse 환경(로컬 12B,
   단일 GPU)에 맞게 재보정하고 근거를 테스트에 남겨라.

---

## 1. A+의 정의 (측정 가능한 종료 기준)

A+는 "경쟁사 흉내"가 아니라 **Muse의 포지셔닝(단일 사용자 · 로컬-우선 ·
grounding 엣지) 안에서 그 차원이 더 이상 약점이 아니게 되는 상태**다.

| 차원 | 현재 | A+ 종료 기준 (측정치) |
|---|---|---|
| D1 Agent loop | B+ | 루프 이탈 사고 0: post-compaction/ping-pong/no-progress 3계층 가드 전부 존재+뮤테이션 검증. 컴팩션이 요약 실패·초과 크기에서도 결정론 폴백으로 절대 안 멈춤. 예산이 유저에게 보임("shows its work"). `eval:computer-task` ≥85% (현 ~50-66%) |
| D2 Security | B+ | 위험 exec에 **opt-in OS 샌드박스**(macOS seatbelt) 존재. 셸 토폴로지 분석이 heredoc/치환을 승인 전 결정론 거부. 암호화-at-rest 잔여 큐 0. 자체 레드팀 배터리(eval:adversarial) 케이스 확대 16→24+ 전부 green |
| D3 Orchestration | B | 서브에이전트에 역할 강등·상속 deny·하트비트 스테일 감지·용량 거부가 전부 존재. 크래시 후 보드/백그라운드 작업 유실 0 (재기동 reconcile 검증). `eval:orchestration` 케이스 확대 + pass^3 |
| D4 Tools | B | "개인 비서 필요 능력" 커버리지 맵의 빌드가능 항목 0 잔여 + 모든 신규 툴 eval:tools 원샷 선택 검증(371→420+ 케이스). `muse mcp serve`로 외부 에이전트가 Muse를 안전하게(read-only+draft-first) 쓸 수 있음 |
| D5 Model posture | B+ | privacy-tiered routing follow-up 전부 완료 + auxiliary.<task> 모델 피닝 일반화 + capability-선언 기반 자동 우회(비전/툴콜 불가 모델) + 명시적 fallback chain(숨은 재시도 금지 준수). 클라우드 라이브 왕복 1회 실증 |
| (보너스) D6 Memory | A- | 연료 문제 해소가 본질: 실사용 트레이스에서 real-miss가 주간 단위로 축적되고, sleep-consolidation이 opt-in으로 존재 |

---

## 2. D1 — Agent loop: B+ → A+

**Muse 현재 (검증됨)**: `maxToolCalls` 기본 10, `maxRunWallclockMs` 300s
(`agent-runtime.ts:284-288`). no-progress 스톨 감지(`tool-loop-progress.ts`) +
tool-failure-streak 보유. 컴팩션: 결정론 `[Key details]` floor + opt-in aux 요약
(CMP-2 완결) + anti-resume 지시 + stale-image 스트립. 스트림 idle-timeout(R1),
요청비례 타임아웃, retry-after 준수, decorrelated jitter, 에러 분류기 전부 출하됨.

**갭 (경쟁사 대비 부재 확인)**: ping-pong 감지, post-compaction 루프가드,
단계적 요약(초과 크기), 식별자-보존 요약 지시, 컴팩션 사전(preflight) 트리거,
반복-회복 one-shot 상태, 예산 가시화.

### D1-S1. Ping-pong + 휘발성-ID 스트리핑 루프 감지 (M)
- **참조**: openclaw `src/agents/tool-loop-detection.ts` (HISTORY=30, WARN=10,
  CRIT=20; A→B→A→B 교대 + 결과해시 안정성; send-류 결과에서 messageId/ts 등
  휘발 키 제거 후 해시).
- **Muse 현재**: `tool-loop-progress.ts`는 동일-출력 스톨만 봄. 교대 패턴과
  휘발성-ID 정규화 없음.
- **구현**: `packages/agent-core/src/tool-loop-progress.ts` 확장 또는 자매 모듈
  `tool-loop-pingpong.ts`. 서명 = SHA256(tool + 안정화 args); 결과 해시에서
  Muse 툴의 휘발 필드(runId, tsIso, id 등) 제거. 로컬 12B에 맞게 창/임계 재보정
  (창 20, warn 6, block 10 제안 — 테스트에 근거 명시). CRITICAL은 기존
  blockedToolResult 경로로 합류(모델에게 이유가 보이게).
- **수용**: 교대 루프 유닛 5+ (진짜 진행 케이스는 통과), mutation-RED,
  agent-core green. eval:computer-task 회귀 없음.

### D1-S2. Post-compaction 루프가드 (S)
- **참조**: openclaw `post-compaction-loop-guard.ts` (window=3: 컴팩션 직후 동일
  tool+args+result 3회 반복 = 컴팩션이 루프를 못 끊음 → abort).
- **Muse 현재**: 부재. anti-resume 지시(696c58184)는 프롬프트 완화일 뿐 가드가 아님.
- **구현**: agent-core 컴팩션 발생 턴(summaryInserted) 후 3-call 창 무장.
  결정론, 기본 on.
- **수용**: 컴팩션-후-반복 시나리오 유닛 + mutation(창 무력화→RED).

### D1-S3. 초과 크기 트랜스크립트의 단계적 요약 (M)
- **참조**: openclaw `compaction.ts summarizeInStages()` (토큰-균등 청크 →
  청크별 요약 → 병합 재요약; 청크 실패 시 부분 보존 + oversized 폴백),
  hermes `context_compressor.py` (요약 예산: min 2000tok, ratio 0.20, 상한 10K).
- **Muse 현재**: `summarizeDroppedContext`는 드롭 전체를 1회 요약(maxChars 600).
  드롭이 aux 모델 창을 넘으면 통째 실패→결정론 폴백만.
- **구현**: `@muse/memory` — 드롭 메시지를 tool-pair 경계 보존 청크로 나눠
  청크별 aux 요약 후 병합. 전 단계 FAIL-OPEN(부분 성공 보존, 전체 실패 시 기존
  결정론 폴백 그대로). **"불투명 식별자(UUID/경로/URL/숫자)는 원문 그대로 보존"
  지시를 요약 프롬프트에 명문화** (openclaw identifier-preservation 참조) — 이건
  grounding 엣지 강화이기도 함(요약이 인용 가능한 사실을 왜곡하지 않게).
- **수용**: 청크 경계 유닛 + 부분실패 보존 + mutation. 기존 CMP-2 테스트 무수정 green.

### D1-S4. 컴팩션 preflight 트리거 (M)
- **참조**: hermes `context_compressor.py:953` (창 사용률 ≥50% 트리거, 소형 창은
  75%로 자동 상향, 퇴화 케이스 85% floor).
- **Muse 현재**: trim은 요청 조립 시 한도 초과에 반응(reactive). 사전 트리거 없음.
- **구현**: `prepareModelRequest` 경로에 사용률 기반 사전 컴팩션 결정(결정론,
  임계는 창 크기별 테이블 — gemma4 262K 실측치 DS-21 재사용). 컴팩션 발생을
  사용자에게 1줄 표기(shows its work).
- **수용**: 임계 경계 유닛(49%/51%), 소형 창 상향, byte-identical-below-threshold 핀.

### D1-S5. 이터레이션 예산 재설계 + 가시화 (M)
- **참조**: hermes `iteration_budget.py` (부모 90 / 서브에이전트 50, execute_code
  는 소비분 **환불**, 스레드-세이프 consume/refund).
- **Muse 현재**: maxToolCalls=10 (툴 호출 수만), PTC(run_tool_plan)는 플랜 내부
  스텝이 예산에 어떻게 계상되는지 불명확.
- **구현**: (a) PTC 플랜 스텝의 예산 계상 규칙 명문화+테스트 (hermes refund
  개념 — 프로그래매틱 호출은 1로 계상). (b) 서브에이전트(보드 executor)는 별도
  하위 예산. (c) 예산 소진으로 멈출 때 "예산 한도 도달(N/M)"을 답변에 명시 —
  침묵 중단 금지.
- **수용**: 계상 유닛 + 소진-메시지 유닛 + mutation. 기본값 변경은 하지 말 것
  (10은 12B에 실증된 값 — 상향은 eval:computer-task로만 정당화).

### D1-S6. 턴-내 one-shot 회복 상태 (S)
- **참조**: hermes `turn_retry_state.py` (OAuth 갱신/포맷 회복/이미지 축소 등
  회복 분기별 1회-시도 플래그 — 같은 처방 이중 적용 방지).
- **Muse 현재**: 개별 회복(빈 답변 재시도, 스키마 재프롬프트 1회)이 산재.
- **구현**: agent-core 턴 상태 객체로 통합(추가 회복 분기가 생길 때 이중 재시도
  구조적으로 불가). 동작 변화 없는 리팩터 + 회복 분기 각 1회 보장 테스트.

---

## 3. D2 — Security: B+ → A+

**Muse 현재 (검증됨)**: runner = `crates/runner/src/main.rs` 523L,
`env_clear()`(시크릿 유출 원천 차단 — hermes 블록리스트보다 강함) + 타임아웃
상한 + 출력 캡. **OS 샌드박스 없음.** 위험명령 게이트 DS-2(quote-aware 정규화,
$IFS, 라인연속, echo/printf 치환, 커맨드-포지션 앵커) + TX-6 파국명령 fail-close
(rm/dd/mkfs/chmod-R 루트). 승인 프롬프트 시크릿 마스킹, OSV MAL-*(DS-14),
암호화-at-rest 다수 스토어(잔여: calendar), 인젝션 배터리, egress fail-close.

**중요 재조정**: hermes도 **로컬 실행엔 OS 샌드박스 없음**(Docker/Modal은 opt-in
백엔드). openclaw만 opt-in Docker(cap-drop/seccomp). 따라서 Muse의 갭은
"업계 표준 미달"이 아니라 "**opt-in 격리 백엔드의 부재**"다.

### D2-S1. runner seatbelt 샌드박스 (opt-in) (L) ★최우선
- **참조**: openclaw `src/agents/sandbox/*` (cap-drop, 리소스 캡, 네트워크 모드,
  env 새니타이즈; 단 Docker 기반). Muse는 macOS-우선이므로 **seatbelt
  (`sandbox-exec` 프로파일)** 가 맞는 선택 — 데몬/의존성 0.
- **구현**: `crates/runner` — `MUSE_RUNNER_SANDBOX=seatbelt` opt-in. 프로파일:
  기본 deny-write, 허용 = cwd 이하 + `$TMPDIR`; 네트워크는 요청 플래그로만 허용
  (`allowNetwork`); `/Users/*/.ssh`·`~/.muse` 등 민감 경로는 읽기도 거부.
  프로파일 문자열은 코드-생성(요청별 cwd 삽입, 이스케이프 검증). Rust 유닛으로
  실프로세스 검증(cwd 밖 write 실패, 허용 write 성공, 네트워크 차단).
  macOS 외 플랫폼은 명시적 "unsupported → 기존 동작+경고".
  `muse doctor`에 샌드박스 포스처 체크 추가.
- **수용**: 실행-계약 테스트 5+ (탈출 시도 3종 실패 포함), 기존 runner 테스트
  무수정 green, 미설정 시 byte-identical. **eval:adversarial에 sandbox-탈출
  시도 케이스 추가.**

### D2-S2. 셸 토폴로지 분석 — heredoc/치환/동적실행 fail-close (M)
- **참조**: openclaw `src/infra/exec-authorization-plan.ts` (파이프라인/체인을
  개별 명령으로 분해, heredoc·dynamic-executable은 "분석 불가"로 거부),
  hermes 서브셸 앵커 재구성.
- **Muse 현재**: DS-2 정규화는 강력하나 문자열 패턴 레벨. `$(...)`/백틱 치환·
  heredoc 안의 파국 명령은 앵커가 놓칠 수 있음.
- **구현**: `@muse/tools` `parseRunnerCommandRequest` 앞단에 토폴로지 패스:
  명령 치환/heredoc/eval·source-of-variable 실행을 감지하면 **파국 검사 불가 →
  승인 필수로 강등**(fail-close, 무조건 거부는 아님 — 정당한 heredoc 사용 존중).
  quote-aware(따옴표 안 문자열은 제외 — DS-2 오탐 교훈 재사용).
- **수용**: 우회 시도 클래스별 차단+near-miss 쌍(정당 사용 통과) 테스트,
  mutation-RED.

### D2-S3. 난독화 해제 확장 — NFKC + ANSI 스트립 + 홈경로 접기 (S)
- **참조**: hermes approval.py (전각→반각 NFKC, ECMA-48 시퀀스 제거,
  `/home/x/.ssh`→`~/.ssh` 접기로 절대경로 우회 차단).
- **Muse 현재**: DS-2에 $IFS/라인연속/치환 해석은 있음 — NFKC/ANSI/홈접기는
  **verify-first** (없으면 추가).
- **수용**: 우회 페이로드 쌍 테스트 + 기존 DS-2 스위트 무수정 green.

### D2-S4. runner 출력 시크릿 마스킹 (S)
- **참조**: openclaw secret-mask (6-16자 "X...Y", >16자 8+8 정책; 제어문자 선제거).
- **Muse 현재**: `redactSecretsInText`(@muse/shared)가 로그/메모리 경로에 배선.
  **runner stdout→모델 경로에 적용되는지 verify-first.** 미적용이면 run_command
  결과 반환 직전에 통과시키기 (모델 컨텍스트로의 시크릿 유입 차단).
- **수용**: 배선 유닛 + 성능 무해(대형 출력 벤치 1회).

### D2-S5. 암호화-at-rest 잔여 큐 소진: calendar 스토어 (S)
- **Muse 현재**: backlog에 "LAST encryption queue item: calendar" 명시.
  reflections/belief-provenance에서 검증된 per-store 템플릿 재사용.
- **수용**: 라운드트립 3종(envelope/평문부재/wrong-key throw) + format-preserving.

### D2-S6. eval:adversarial 확대 16→24+ (M)
- 신규 케이스: S1 샌드박스 탈출 3종, S2 토폴로지 우회 3종, S3 난독화 2종.
  전부 **결정론 가드가 막는 것을 코드로 검증** (모델 거부에 의존 금지 —
  agent-testing.md §5).

---

## 4. D3 — Orchestration: B → A+

**Muse 현재 (검증됨)**: `@muse/multi-agent` 보드(의존성-게이트, 재시도-사유,
zombie reclaim 30분, 병렬 분해+합성, REVIEW 파킹, read-only executor 게이트),
X-3 백그라운드 프로세스 레지스트리(S1-S6, crash reconcile, cap 50), 스케줄러
graceful drain + pause kill-switch. fan-in conflict 표면화(detectFanInConflicts).
"race" 모드는 의도적 sequential 폴백(정직 문서화됨 — 단일 GPU).

### D3-S1. 서브에이전트 역할 강등 + 상속 tool-deny (M)
- **참조**: openclaw `subagent-capabilities.ts` (depth ≥ maxSpawnDepth → leaf
  강등, leaf는 위임 툴셋 제거+부모 deny 상속), hermes delegate_tool
  (`max_spawn_depth` 기본 1 = flat).
- **Muse 현재**: 보드 executor는 flat(깊이 개념 없음). expand가 만든 서브태스크가
  다시 expand를 부를 수 있는지 **verify-first** — 가능하다면 무한 분해 위험.
- **구현**: `@muse/multi-agent` — 태스크에 depth 필드, `MUSE_BOARD_MAX_DEPTH`
  기본 1. depth 도달 시 expand 거부(leaf). executor의 read-only 게이트에 부모
  deny 상속 규칙 추가(부모가 못 쓰는 툴을 자식이 쓰지 못하게 — 상속은 구조,
  프롬프트 아님).
- **수용**: 깊이 경계 유닛 + 상속 유닛 + mutation(강등 제거→RED).

### D3-S2. 런타임 하트비트 스테일 감지 (M)
- **참조**: hermes delegate_tool `_heartbeat_loop` (30s 폴링; idle 450s /
  in-tool 1200s 스테일 판정 → 상위 타임아웃 발화 유도).
- **Muse 현재**: 보드 레벨 30분 reclaim만(작업이 죽은 뒤에야). 실행 **중**
  스테일(모델 응답 오는데 진전 없음)은 wallclock 300s가 유일.
- **구현**: agent-core run에 activity tracker(마지막 툴 시작/델타 수신 시각).
  `AgentRuntimeOptions.staleAfterMs`(idle 기본 300s는 wallclock과 중복이므로
  **툴-실행-중 스테일**에 집중: in-tool 600s 기본, 개별 툴 타임아웃과 별개의
  총합 가드). 스테일 시 abort + 사유 명시.
- **수용**: fake-clock 유닛 + 정상 장기 스트림 비오탐 핀.

### D3-S3. 완료-이벤트 idle-드레인 계약 명문화 (S)
- **참조**: hermes async_delegation (완료는 큐로만; CLI가 **idle 윈도우에만**
  드레인 → mid-LLM 삽입 없음, 메시지 교대·캐시 무결성 보존).
- **Muse 현재**: 챗의 jobCompletions/proactive 폴링이 사실상 이 패턴 — 그러나
  "생성 중 삽입 불가"가 **계약 테스트로 핀 안 됨**. verify-first 후 핀만 추가.
- **수용**: busy 중 완료 이벤트가 스트림에 끼어들지 않는 계약 테스트.

### D3-S4. 용량 거부(reject-at-capacity) + 부모-헤드룸 요약 예산 (M)
- **참조**: hermes (cap 3 초과 async 위임은 큐잉 없이 **거부** — 폭주 모델이
  무한 적재 불가; 부모 창 헤드룸×0.5/n 요약 예산, floor 2000자, 초과분
  파일 스필+head/tail).
- **Muse 현재**: 보드 run은 순차(용량 문제 없음)나 `/job` 백그라운드는 상한
  **verify-first**. 서브태스크 결과 합성 시 부모 컨텍스트 예산 산식 없음.
- **구현**: (a) job 동시 상한(기본 3, 초과 시 명시 거부 메시지). (b)
  `boardTaskPrompt` 합성 입력에 헤드룸-비례 per-child 예산 + 초과분
  `~/.muse/board-spill/` 파일 스필 + 답변에 스필 경로 명시(shows its work).
- **수용**: 상한 거부 유닛 + 예산 산식 경계 유닛 + 스필 왕복.

### D3-S5. X-3 완결: agent-facing background_process 툴 (S5b, attended) (M)
- **Muse 현재**: backlog에 명시된 잔여 — 유저 surface(run/list/logs/stop)는
  완성, 모델-facing MuseTool 미출하.
- **구현**: `background_process` 단일 툴(start/stop/logs/list action enum,
  tool-calling.md 규칙: verb_noun·use-when/not-when·예시 있는 스키마).
  classifyDangerousCommand 가드 + 시작은 execute-risk 승인 게이트.
  watch-pattern은 **이번엔 제외**(스코프 절제 — 서킷브레이커까지 가면 L).
- **수용**: eval:tools 골든 케이스 4+(선택+인자+무관-노콜) STABLE 3/3, 로컬
  Ollama 라이브.

### D3-S6. eval:orchestration 래칫 (S)
- D3-S1~S4 각각의 라이브/시나리오 케이스를 eval:orchestration에 편입, pass^3.
  MAST 상위 실패모드(스텝 반복·종료 미인지) 케이스 최소 2종 포함.

---

## 5. D4 — Tools: B → A+ (단일-사용자 스코프의 A+)

**A+ 재정의**: 149개 확장 추격이 아니라 — "개인 비서가 macOS에서 해야 할 일의
빌드가능 목록 잔여 0 + 모든 툴이 12B 원샷 선택 검증 + 외부 에이전트에게 Muse가
안전한 MCP 서버".

### D4-S1. `muse mcp serve` 확장 (M)
- **참조**: hermes `mcp_serve.py`(자신을 MCP 서버로 노출 — 양방향 MCP).
- **Muse 현재**: read-only 툴 3개만 노출(commands-mcp-serve.ts).
- **구현**: 노출 세트 확대 — read 계열(recall/notes 검색, 캘린더/태스크 조회,
  browsing 검색) + write는 **draft-first 프록시**(외부 에이전트가 요청하면
  Muse 승인 큐에 파킹, 자동 실행 절대 불가 — outbound-safety §2). grounded
  recall을 노출하면 **외부 에이전트도 인용-게이트된 답을 받는다** = 엣지의
  수출. 노출 툴마다 명시적 allowlist(기본 read-only).
- **수용**: MCP 계약 테스트(stdio 왕복) + write-파킹 no-external-effect 계약 +
  grounded-recall 노출 경로 인용 게이트 검증. groundedSurfaces 35→36 래칫.

### D4-S2. macOS 커버리지 잔여 소진 (S×4)
- backlog 07-07 맵의 빌드가능 잔여: ⑤ Photos 검색/내보내기(M) ⑥ 앱 종료(S)
  ⑦ 다크모드(S) ⑧ 밝기/블루투스(S, Shortcuts 키스톤). 각각 기존 패턴
  (mac_system_set enum 확장 우선, 신규 툴 신설 금지 — 혼동쌍 방지) + eval 케이스.
- Apple 연락처 '쓰기'(추가)는 draft-first 게이트로 별도 S.

### D4-S3. `muse ask --with-tools` seam 리트로핏 (M)
- backlog 07-10 follow-up (a): prepare-only seam 진입점(컨텍스트+게이트 조립만,
  생성은 밖) → --with-tools가 레거시 조립 탈출, commands-ask.ts LOC 음수 전환.
- **수용**: cli ask 스위트 무수정 green + seam parity 테스트.

### D4-S4. computer-control 신뢰성: file_edit 결정론 리페어 (M)
- 메모리 기록(project_computer_control_axis)의 NEXT. eval:computer-task
  ~50-66%의 주범이 multi-step 파일 편집 — 편집 실패 시 결정론 재정렬/재시도
  1회(모델 재추론 금지, tool-calling.md §7).
- **수용**: eval:computer-task 베이스라인 대비 +10%p 이상, pass^3.

### D4-S5. 히스토리-검색 툴 완결 (Gap 1 잔여) (S)
- `searchHistory` 코어(S1 완료)를 에이전트 툴로 노출 + eval:tools 케이스.
  hermes session_search(FTS5, 앵커 ±윈도우, bookend) 참조 — Muse는 기존 BM25
  코어 재사용, 창/북엔드만 추가.

---

## 6. D5 — Model posture: B+ → A+

**Muse 현재 (검증됨)**: privacy-tiered routing이 chat 양 표면(단발+Ink) 완비 —
**경쟁사 둘 다 이 축 자체가 없음**(라우팅 스윕 확인: 민감도-기반 라우팅 0).
MUSE_VISION_MODEL/MUSE_AUX_COMPACTION 개별 노브, DS-21 컨텍스트 실측 프로브,
BYO-key 어댑터 4종.

### D5-S1. privacy routing follow-ups 완결 (M)
- (b) context-free 툴 사용의 클라우드 결정: **결정은 "no"로 명문화** — 툴은
  개인 데이터 통로(캘린더/노트)이므로 툴 필요 턴은 로컬 고정이 원칙에 맞음.
  결정 근거를 privacy-routing.ts 주석+테스트로 핀. (c) personaPreamble 분류
  제외 nuance 문서화. (d) KO 구어 소유격(내꺼/제꺼) 토큰 추가(표준 토큰만,
  오탐 쌍 테스트). + `muse setup cloud` 위저드에 privacy-routing 안내 단계.
- **수용**: 각 항목 유닛 + 기존 20 계약 무수정.

### D5-S2. auxiliary.<task> 모델 피닝 일반화 (M)
- **참조**: hermes `auxiliary.<task>` config(압축/비전/세션검색/전사 태스크별
  모델+폴백 체인) — Muse의 MUSE_AUX_COMPACTION/MUSE_VISION_MODEL은 이 패턴의
  단편.
- **구현**: `@muse/autoconfigure`에 `resolveAuxiliaryModel(task, env)` 단일
  리졸버(기존 env 노브는 하위호환 유지). 태스크: compaction/vision/rewrite/
  judge/embedding-rescue. **로컬-우선 불변**: aux도 privacy 게이트 통과(개인
  컨텍스트를 다루는 태스크는 클라우드 aux 금지 — classifyRequestPrivacy 재사용).
- **수용**: 리졸버 유닛 + 하위호환 byte-identical 핀 + local-only 게이트 유닛.

### D5-S3. capability-선언 기반 자동 우회 (S)
- **참조**: openclaw ModelCatalog compat 플래그(비전 없음→스트립/라우팅).
- **Muse 현재**: `resolveVisionModel` 폴백 존재. toolCalling=false 모델 처리
  (텍스트 프로토콜 폴백)는 architecture.md에 계약만 — **verify-first** 실배선
  여부 확인, 빠졌으면 케이퍼빌리티 체크→명시 폴백 배선.
- **수용**: 케이퍼빌리티 부재 모델 계약 테스트(mocked).

### D5-S4. 명시적 fallback chain (M)
- **참조**: openclaw allowlist+fallback 배열(설정 오타는 조기 거부, 폴백은
  allowlist 안에서만).
- **Muse 원칙 정합**: "숨은 재시도 금지" — 폴백은 **명시 설정**(`MUSE_MODEL_FALLBACKS`
  콤마 목록)일 때만, 각 폴백도 privacy/local-only 게이트 통과, 폴백 발생을
  답변에 1줄 표기(shows its work).
- **수용**: 체인 워크 유닛 + 게이트 통과 유닛 + 미설정 byte-identical.

### D5-S5. 클라우드 라이브 왕복 실증 1회 (attended, S)
- 진안 키로 privacy-routing 실왕복(context-free 턴 ☁️ 확인 + 개인 턴 로컬 고정
  확인) 기록 → `docs/goals/` 실증 로그. (자동화 아님 — 사용자 세션 1회.)

---

## 7. D6 — Memory: A- → A+ (연료가 본질)

### D6-S1. Sleep-consolidation (opt-in) (L)
- **참조**: openclaw dreaming 승격 스코어(빈도/관련성/다양성/최근성 6요소,
  반감기 14d, min-recall 3, health<0.35 복구 모드) — 단 **기본 OFF인 것까지
  모방하지 말 것**: Muse는 작게 시작해 기본 ON 가능한 결정론 버전.
- **Muse식 재설계**: episodic→durable 승격을 **결정론 스코어**(재-recall 횟수,
  distinct 질의 수, 최근성 반감기 — LLM 없음)로 후보 선정, 승격은 **draft로
  제안**(proactive 카드 "이거 오래 기억할까요?") — 자동 쓰기 금지(교정-망각
  원칙과 충돌 방지). loop-v2의 Sleep daemon 설계와 정합.
- **수용**: 스코어 유닛 + 제안-카드 경로 + 자동-쓰기-없음 계약(mutation).

### D6-S2. 연료 파이프라인 점검 (S, attended)
- browsing auto-sync(MUSE_BROWSING_AUTO_SYNC) 실기기 on + proactive/recap 연결
  슬라이스(backlog 99 잔여) + 주간 real-miss 리포트(`muse doctor --flywheel`
  같은 1-화면 요약, scout-signals 재사용).

---

## 8. 웨이브 순서 (권장)

| 웨이브 | 슬라이스 | 이유 |
|---|---|---|
| **W1 (원칙 갭)** | D2-S1 seatbelt → D2-S2 토폴로지 → D1-S1/S2 루프가드 → **D2-S7 exec 승인 span 하이라이트** | 자기 원칙(결정론 가드) 대비 유일한 미달 + 루프 이탈은 12B 최빈 사고. 보안-비판이 경쟁사 공통 최대 약점(§11.1) — 여기가 해자 |
| **W2 (신뢰성)** | D1-S3/S4/S5 → D3-S1/S2/S4 → **D1-S7 브라우저 refs+step-budget** | 컴팩션·예산·서브에이전트 안전망 + 소형모델 브라우저 신뢰성 — eval:computer-task 상승의 토대 |
| **W3 (능력)** | D4-S4 → D4-S1 → D3-S5 → D4-S2/S5 → **D7-S1 슬래시 단일소스 · D7-S2 write-approval 스테이징** | 신뢰성 위에 커버리지 + UX 마찰 제거 — 각각 eval:tools/UX 래칫 동반 |
| **W4 (라우팅·KO)** | D5-S1~S4 → D1-S6 → D2-S3/S4/S5 → **D-KO-S1 UTF-16 안전 슬라이스 · D-KO-S2 CJK 세션검색** | 모델 천장 우회 완성 + 한국어-우선 마감(경쟁사 hermes 2200자 한계가 반면교사) |
| **W5 (기억·마감)** | D6-S1/S2 → D3-S3/S6 → D2-S6 → **D7-S3 doctor fix-steps · D7-S4 desktop 반응성** | 연료·consolidation·래칫·UX 마감 |

각 웨이브 종료 = `pnpm self-eval` green + 해당 eval 래칫 수치 상승 확인 +
CHANGELOG [Unreleased] 갱신. 슬라이스당 1 커밋(Conventional Commits).
D1-S7·D2-S7·D7·D-KO 슬라이스의 상세 계약은 §11에 있다.

---

## 9. Non-goals (재도출 금지 — 근거 포함)

- **채널 스프롤** (Telegram/Discord/... 게이트웨이): 심사 10/13 skip. 경쟁사
  fix-비율 52-54%가 폭의 유지비를 실증.
- **멀티테넌트/게이트웨이 릴레이·과금**: off-strategy 50건 기각 유지.
- **tirith-식 외부 바이너리 보안 의존**: 공급망+플랫폼 부담. Muse는 in-repo
  결정론 가드 + OSV 조회(이미 출하)로 동등 커버.
- **LLM-판단이 최종 결정인 보안 게이트**: openclaw exec-auto-reviewer는
  "ask로만 강등 가능" 구조라 참조 가치는 있으나, Muse 비협상("보안은 결정론
  코드")상 도입하지 않음. 결정론 게이트가 이미 그 역할.
- **구독 OAuth 재사용 / banking / 자율 발송**: 기존 영구 경계 유지.
- **리더보드 추격 / 프런티어 모델 종속**: best-OSS-agent 리뷰 결론 유지 —
  증명은 게이트 on-vs-off DELTA.

---

## 10. 부록 — 근거 검증 로그 (2026-07-11, Fable 직접 스팟체크)

| # | 주장 (Haiku 스윕) | 검증 |
|---|---|---|
| 1 | hermes iteration_budget 90/50 + execute_code refund | ✅ `agent/iteration_budget.py:1-28` |
| 2 | openclaw post-compaction-loop-guard window=3 | ✅ `post-compaction-loop-guard.ts:15` |
| 3 | openclaw exec-authorization-plan heredoc/dynamic 거부 | ✅ `src/infra/exec-authorization-plan.ts:101-103` |
| 4 | hermes tool budget 100K/200K + 창비례 0.15 | ✅ `tools/budget_config.py:17-75` |
| 5 | openclaw dreaming half-life 14d·min-recall 3·health 0.35 | ✅ `dreaming.ts:40-47` |
| 6 | openclaw 루프감지 30/10/20 상수 | ✅ `tool-loop-detection.ts:39-49` |
| 7 | hermes stream stale 180s·reasoning floor 600s | ✅ `reasoning_timeouts.py:7-72` |

Muse-측 확정 팩트: runner `env_clear()`+timeout-only(`crates/runner/src/main.rs:101`),
`maxToolCalls=10`/`maxRunWallclockMs=300s`(`agent-runtime.ts:284-288`),
no-progress 감지 보유·ping-pong 부재(`tool-loop-progress.ts`),
`muse mcp serve` read-only 3툴(`commands-mcp-serve.ts`).

스윕 원문(메커니즘 카탈로그 전체)은 세션 산출물로만 존재 — 이 문서의 슬라이스가
채택분이며, 미채택 메커니즘의 재검토는 다음 delta-scout 주기에.

---

## 11. 2차 심층 스윕 통합 (11-Haiku 부대 + 웹평판 + 자체-문서 마이닝)

1차 7-스윕이 B-차원의 메커니즘을 캤다면, 2차 11-스윕은 **능력 전수조사(툴 103·
확장 149)·UX·음성/비전·브라우저·프롬프트·세션/i18n·웹평판·경쟁사 자체문서**를
훑어 (a) 포지셔닝을 삼각검증하고 (b) 신규 슬라이스 + 두 신규 차원(D7 UX·D-KO
한국어)을 발굴했다. Fable 스팟체크로 하중-주장 4건 추가 검증(부록 §10 확장).

### 11.1 포지셔닝 삼각검증 — Muse의 세 엣지가 경쟁사 공통 공백임이 3중 확인됨

가장 중요한 발견. **세 독립 소스가 같은 결론에 수렴**했다:

| 소스 | openclaw | hermes |
|---|---|---|
| 독립 프로파일러(코드) | grounding "가장 계측 안 된 차원", 프롬프트뿐 | grounding X-search 한 곳 빼면 부재 |
| 웹 평판(커뮤니티) | #1 비판=보안(CVE 홍수·미인증 공개 인스턴스·17% 악성 스킬), #2=신뢰성("격일로 깨짐") | #1 비판=무제한 셸·샌드박스 없음; 메모리 2200자 한계 |
| **경쟁사 자체 문서(README/docs)** | **grounding/citations·프라이버시-우선/로컬-only·eval/검증 프레임워크 3종 모두 문서에서 부재** | **동일 3종 모두 부재** |

→ **Muse의 세 엣지(결정론 grounding·로컬-우선 프라이버시·라이브 eval 게이트)는
경쟁사가 "안 만든" 게 아니라 "문서로 내세울 것조차 없는" 무주공산이다.** 이건
계획의 방향을 바꾸는 게 아니라 **확신을 준다**: B-차원을 A+로 올리되, 세 엣지를
절대 희생하지 말 것(모든 슬라이스가 grounding-surface·fabrication=0·eval 래칫을
지키는 이유). 그리고 경쟁사 최대 약점(보안·신뢰성)이 정확히 Muse의 강점 축이므로
**W1(보안)·W2(신뢰성)를 먼저** 두는 웨이브 순서가 재확인됐다.

주의: 웹 평판의 구체 수치(스타 수·CVE 번호)는 미검증 커뮤니티 vibes로 취급하고
**방향성만** 채택했다(경쟁사 실코드가 뒷받침하는 "로컬 exec 샌드박스 부재"는
1차 스윕이 직접 확인한 사실).

### 11.2 기존 차원 추가 슬라이스 (2차 발굴)

#### D1-S7. 브라우저 refs + step-budget + dialog-inline (소형모델 신뢰성) (L)
- **참조**: hermes `browser_tool.py`(AX-tree `@e5` 숫자 refs·CDP supervisor로
  dialog을 snapshot에 인라인·lightpanda→Chrome 폴백), openclaw
  `browser-tool.actions.ts`(compact `ai` 스냅샷 max 12K·timeout 주입·stale-tab
  1-tab 복구·page 콘텐츠 vision 라우팅).
- **Muse 현재**: puppeteer detached-Chrome(ambiguous-target fail-close) 보유
  (project_browser_control). 그러나 소형모델 신뢰성 3종(숫자-refs·step-budget·
  dialog-inline)은 **verify-first**.
- **구현**: (a) 스냅샷을 AX-tree 숫자 인덱스(`@e1`…)로 반환 — CSS 셀렉터 생성
  금지(12B가 못 함). (b) action당 timeout 주입 + task별 step 카운터(하드캡,
  근접 시 경고, 답변에 `actions_used N/M` 표기). (c) pending dialog을 스냅샷
  필드로(별도 툴 왕복 없음), 서버측 auto-dismiss. (d) **page 콘텐츠를 `<page>`
  블록으로 래핑 + 미디어 지시 defang** — 인젝션 방어(보안-as-code, 브라우저는
  untrusted 입력의 최대 통로).
- **수용**: refs 안정성 유닛 + step-budget 소진 유닛 + dialog-inline + 인젝션
  defang 계약(page의 "ignore above" 무력화) + eval:computer-task 회귀 없음.
  browser는 실 e2e 필요(project_browser_control 교훈: 조립된 경로를 몰면 거짓).

#### D2-S7. exec 승인 span 하이라이트 + write-approval 스테이징 (M)
- **참조**: openclaw `exec-approval.ts`(위험 부분—경로/메타문자—인라인 span
  마킹 + host/agent/session 메타 + allow-once/always/deny + 타임아웃 카운터),
  hermes `write_approval.py`(pending을 디스크에 스테이징 → 유저가 나중에 승인).
- **Muse 현재**: outbound draft-first 게이트 보유. 그러나 승인 프롬프트가 위험
  **부위를 시각적으로** 짚어주는지, 백그라운드 쓰기를 **비차단 스테이징**하는지
  verify-first.
- **구현**: (a) 승인 프롬프트에서 명령의 위험 토큰(파괴적 플래그·민감경로)을
  하이라이트(DS-2 분류기 재사용, 시크릿은 마스킹 유지). (b) 자율/데몬 쓰기를
  `~/.muse/pending/`에 스테이징 → `muse pending`/챗에서 나중 승인(어느
  인터페이스서든). draft-first 원칙 강화(승인 피로 감소).
- **수용**: 하이라이트 위치 유닛 + 스테이징 no-external-effect 계약(승인 전
  절대 실행 안 됨, outbound-safety §2) + mutation.

#### D1-S3 보강 (식별자 보존은 grounding 강화). §2 D1-S3에 이미 반영됨 —
openclaw identifier-preservation + hermes 요약 예산(min 2000tok·ratio 0.20·
상한 10K)을 상수 근거로 명시. **재확인만**, 신규 슬라이스 아님.

#### D6 보강 (메모리 무결성). hermes `memory_tool.py`의 두 패턴을 D6에 추가:
- **D6-S3. 메모리 drift 감지 (round-trip) (S)**: 외부 편집/자매프로세스 append로
  스토어가 오염되면 rewrite가 바이트 유실 → 재직렬화 해시 불일치 시 쓰기 차단 +
  `.bak.<ts>`. Muse 스토어는 atomic write지만 **다중 프로세스(CLI/데몬/루프)
  동시 편집** 시나리오는 verify-first(main-worktree git hazards 메모리와 동류
  위험). 수용: 오염 시나리오 유닛 + 차단 계약.
- **D6-S4. provenance 태그 — foreground vs 자율 쓰기 (S)**: 자율 큐레이션이
  **유저-지시** 사실/스킬을 삭제 못 하게 origin 태그(hermes ContextVar 패턴).
  Muse authored-skill-store는 이미 성숙(§11.3) — 메모리 facts에도 같은 보호가
  있는지 verify-first. 수용: 자율-삭제-금지 계약(mutation).

### 11.3 이미-커버 확인 (no-op 회피 — 2차 스윕이 확인해준 Muse 강점)

2차 스윕이 "경쟁사에 있다"고 본 것 중 **Muse가 이미 동급 이상**인 것들. 워커는
이걸 다시 짓지 말 것:

- **스킬 저작/큐레이션**: Muse authored-skill-store가 이미 utility-aware
  eviction(TinyLFU)·write-time subsumption(Voyager)·quarantine+리스크스캔·
  스냅샷 링+롤백·병합 semantic-coverage 게이트 보유 → openclaw skill-workshop /
  hermes Curator 대비 **A급 parity**. (스윕이 실수로 Muse를 분석해 역-확인됨.)
- **프롬프트 stable-prefix**: `@muse/prompts`가 이미 stablePrefix + stable/dynamic
  섹션 + priority 보유 → 명시적 cache-boundary 개념 존재. 로컬 KV 캐시 최적화의
  토대는 있음(미세 최적화만 후보).
- **cost 추적**: `muse cost`가 로컬(`~/.muse/token-usage.jsonl`)+admin 양쪽
  보유. quarter-hourly 버킷은 폴리시(저우선).
- **비전 파이프라인**: gemma4 비전·whisper STT·KSS TTS 이미 배선. hermes의
  적응형 무음감지·Whisper 환각필터·네이티브 fast-path는 **D7/폴리시 후보**(코어
  아님).
- **PTC(programmatic tool calling)**: hermes code_execution의 RPC 마샬링은 Muse
  run_tool_plan(PTC)이 이미 커버(backlog PROGRAMMATIC TOOL CALLING COMPLETE).

### 11.4 D7 — UX (신규 차원): 헤드리스 에이전트를 "쓰기 좋은" 도구로

경쟁사 UX가 앞선 영역(hermes 82 슬래시·floating pet·마스터-디테일; openclaw
command palette·exec 승인 모달). Muse는 Ink TUI + macOS 데스크톱(Muse.app,
Swift) + 웹 콘솔 3표면. A+ 기준 = **일상 사용 마찰이 경쟁사 수준으로 낮음**.

- **D7-S1. 슬래시 명령 단일소스 레지스트리 (M)**: 현재 `SLASH_COMMANDS`가
  chat-ink 단독(commander CLI와 분리). hermes COMMAND_REGISTRY처럼 name·desc·
  category·aliases·platform-gate 1-엔트리가 CLI help·챗 autocomplete·(미래)채널을
  구동하는 단일소스로. 수용: 레지스트리 유닛 + 챗/CLI 양쪽 반영 + 중복 제거 증명.
- **D7-S2. write-approval 비차단 스테이징** — D2-S7과 통합(위 참조).
- **D7-S3. `muse doctor` fix-steps 강화 (S)**: 진단이 플랫폼별 **복사-가능
  수리 단계**를 번호목록으로(hermes doctor 패턴). Muse doctor는 체크 다수 보유 —
  각 실패에 actionable fix 라인 붙었는지 verify-first. 수용: fix-step 렌더 유닛.
- **D7-S4. desktop 반응성 (S, attended)**: Muse.app에 (a) 스트리밍 중 경과
  타이머, (b) 상태 반응(성공/에러 시각 신호) — hermes activity-timer·status-dot
  참조. 데스크톱 companion(project_desktop_companion)의 UX 완성도 상향. 실기기
  검증 필요(attended).
- **D7-S5. 스마트-테일 터미널 출력 (S)**: 마운트 시 하단 점프, 유저가 하단
  근처일 때만 tailing, 위로 읽으면 방해 안 함(hermes terminal-output). 웹 콘솔의
  스트리밍 뷰에 적용. 수용: 스크롤 로직 유닛(react-testing) + 실브라우저 측정
  (testing.md UI 규칙).

### 11.5 D-KO — 한국어/CJK (신규 차원): 진안-우선 언어의 A+

Muse는 한국어-우선(메모리 user_identity). 경쟁사는 i18n을 UI 번역으로 다루지만
**CJK 텍스트 안전성**은 openclaw가 UTF-16 버그를 3주간 12모듈에서 잡는 중
(반면교사). hermes 메모리 2200자 한계는 CJK에 특히 치명(한글 1자=여러 토큰).

- **D-KO-S1. UTF-16 안전 슬라이스/절단 헬퍼 (S) ★**: openclaw
  `normalization-core/utf16-slice.ts`(`sliceUtf16Safe`/`truncateUtf16Safe` —
  surrogate-pair 경계 안전). Muse는 툴-arg sanitization 한 곳만 surrogate-aware
  (TCR-3). **범용 헬퍼가 @muse/shared에 없음** → 답변/요약/노트/TTS 절단이 한글·
  이모지를 깨뜨릴 수 있음. 의존성-0 헬퍼 추가 + 절단 호출부(TTS cap·요약 maxChars·
  citation 스니펫) 배선. 수용: 한글/이모지/조합문자 경계 유닛 + 기존 절단 호출부
  byte-identical-when-safe.
- **D-KO-S2. CJK-aware 세션/히스토리 검색 (S)**: D4-S5(히스토리 툴)에 CJK
  토크나이제이션 확인 — Muse는 cross-lingual recall(nomic-v2-moe prefix)·CJK
  lexical 이미 보유(project_cross_lingual_recall). hermes session_search FTS5는
  CJK trigram. **Muse BM25 코어가 CJK를 trigram/음절로 다루는지 verify-first**,
  약하면 보강. 수용: KO 질의→KO/EN 히스토리 hit@1 골든셋.
- **D-KO-S3. i18n 정적 메시지 카탈로그 (M, 저우선)**: 현재 KO/EN 분기가 코드
  인라인(`/[가-힣]/` 분기 다수). hermes/openclaw처럼 dotted-key 카탈로그로
  중앙화하면 유지보수↑ — 단 **저우선**(현 인라인이 동작하고, 리팩터 리스크>이득
  까지 갈 수 있음). 진안 언어가 KO 고정이라 다국어 확장 압력이 낮음.

### 11.6 부록 확장 — 2차 스팟체크 (Fable 직접)

| # | 주장(2차 스윕) | 검증 |
|---|---|---|
| 8 | Muse `muse cost` 로컬+admin 양쪽 | ✅ `commands-cost.ts:12-23`(로컬 리포트)+admin 라우트 |
| 9 | Muse prompts stablePrefix/stable-dynamic 보유 | ✅ `packages/prompts/src/index.ts:33-162` |
| 10 | Muse UTF-16 범용 헬퍼 부재(툴-arg만) | ✅ shared는 surrogate 언급 1곳(:255), 범용 slice 없음 → D-KO-S1 정당 |
| 11 | Muse SLASH_COMMANDS chat-ink 단독(CLI와 분리) | ✅ `chat-ink.ts:69`만 정의 → D7-S1 정당 |
| 12 | Muse 데스크톱 companion 존재(Swift) | ✅ `apps/desktop/Muse.app`·`Sources/MuseDesktop*` |

경쟁사 자체-문서 3중 확인(§11.1)의 근거: hermes README/docs 355파일 마이닝 +
openclaw docs 699파일 마이닝 결과, 양측 모두 grounding/citations·privacy-first/
local-only·eval/verification 프레임워크를 **crown-jewel로도 문서 섹션으로도
제시하지 않음**. (스윕 원문은 세션 산출물.)
