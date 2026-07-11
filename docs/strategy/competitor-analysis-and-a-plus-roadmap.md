# Muse vs openclaw · hermes — 완전 분석·평가·A+ 도출 로드맵

> **작성**: Fable 5 (분석·계획 전담). **집행**: Sonnet 워커 (슬라이스 단위).
> **일자**: 2026-07-11. 이 문서는 이전의 산발적 계획/평가 문서
> (a-plus-plan 초안, agent-performance-levers, frontier-research, maturity-review)를
> **흡수·대체하는 단일 정본**이다. 향후 이 라인의 갱신은 이 파일에 한다.
>
> **방법론**: (1) 3-에이전트 나란히 프로파일(Muse·openclaw·hermes, 독립 실행),
> (2) **18-Haiku 정밀 스윕**(1차 7 메커니즘 + 2차 11 심층: 능력 전수조사·UX·
> 음성/비전·브라우저·프롬프트·세션/i18n·웹평판·경쟁사 자체문서), (3) **Fable
> 소스 스팟체크 12건 전부 일치 확인**, (4) 웹 평판 리서치. 경쟁사 클론 HEAD
> 2026-07-07 기준(hermes `aaeba213d`, openclaw `2fe39692ad0`).

---

## 0. 라이선스 — reference 사용은 합법 (확인 완료)

두 경쟁사 실제 `LICENSE` 파일 직접 확인:

- **hermes-agent**: MIT License, Copyright (c) 2025 Nous Research (`pyproject.toml` `license = "MIT"`)
- **openclaw**: MIT License, Copyright (c) 2026 OpenClaw Foundation (`package.json` `"license": "MIT"`)

MIT는 **코드 복사조차** (저작권·라이선스 고지만 유지하면) 허용한다. Muse의
방침은 그보다 보수적이다 — **아이디어·메커니즘·상수 근거만 reference로 참조하고
구현은 Muse 자체 설계·네이밍으로 재작성**한다. verbatim 복사가 없으므로 MIT의
고지 의무조차 발생하지 않는다. 이는 이미 backlog의 40+ 슬라이스가 지켜온
방식("reference-only, MIT/Apache-attributed, NO verbatim copy")이며, 본 로드맵의
모든 슬라이스에 동일하게 적용된다. **진안의 "배끼지 말고 레퍼런스로"는 정확히
이 방침과 일치하며, 법적으로 안전하다.**

---

## 1. 한 줄 결론

**Muse는 "범용 에이전트 인프라"로는 두 경쟁자 아래(종합 B+)지만, 스스로 고른
세 축 — 결정론 grounding·검증된 자기학습·라이브-모델 검증 규율 — 에서는 둘 다
명확히 앞서며, 그 세 축은 두 경쟁자가 코드로도·커뮤니티 호평으로도·자체 문서
로도 투자 흔적이 없는 무주공산이다.** 따라잡는 게임에서는 지고 있고, 자기
게임에서는 이미 이기고 있다. 이 로드맵은 **세 엣지를 절대 희생하지 않으면서**
B-차원(agent loop·security·orchestration·tools·model posture)을 A+로 올린다.

---

## 2. 3-에이전트 차원별 성적표

| 차원 | Muse | openclaw | hermes | 근거 요점 |
|---|:---:|:---:|:---:|---|
| 에이전트 루프 | B+ | **A** | **A** | 셋 다 컴팩션·리트라이·체크포인트·abort 보유. openclaw 툴루프감지 820L·컴팩션 플래너 별도 워커, hermes 3k-LOC 압축기. Muse는 전 메커니즘 존재하나 예산이 작음(maxToolCalls 10 vs hermes 90/서브50) |
| 메모리·자기학습 | **A-** | B+ | **A** | hermes: Curator+스킬 자기저작 실배선·기본-on(가지치기). Muse: Whetstone BKT·playbook RL·correction-decay — **유일하게 '교정하면 잊는' 정직 학습**이나 연료(실사용) 기근. openclaw: dreaming 3단계 깊게 구현됐지만 **기본 OFF** |
| 도구·생태계 | B | **A+** | A | openclaw 149 확장·25+채널·52 프로바이더, hermes 103 툴·20채널·MCP 양방향. Muse ~96 툴+MCP 클라이언트+브라우저+macOS 심층 — 단일사용자 스코프로 **의도적 미확장**(채널 10/13 skip 판정) |
| 오케스트레이션 | B | **A** | A- | openclaw SQLite task-flow·서브에이전트 레지스트리·crond. hermes delegate 3.4k-LOC·비동기 위임·하트비트. Muse Kanban+병렬분해+합성 — 개인 스코프엔 완결이나 단일 GPU라 병렬은 환상 |
| **Grounding·정직성** | **A+** | D | D+ | **비교 불가 격차.** Muse 35개 표면 결정론 게이트·fabrication=0 릴리스 게이트·GROUNDED≠TRUE 완화. openclaw 프롬프트 경고뿐(프로파일러: "가장 계측 안 된 차원"). hermes X-search 한 곳의 citation 체크가 전부 |
| 보안 | B+ | A- | **A** | hermes tirith 외부검증 바이너리+hardline+상시 security 드럼비트. openclaw 감사엔진 90파일+CodeQL+opt-in Docker 샌드박스. Muse fail-close draft-first·인젝션 배터리·egress 게이트는 원칙 준수하나 **runner가 env_clear+timeout+출력캡뿐, OS 샌드박스 없음** |
| **검증 규율** | **A+** | A- | B+ | Muse만 **라이브 모델 eval이 릴리스를 게이트**(41 eval 스크립트, pass^k, 뮤테이션 문화). openclaw 6.9k 테스트+71 live+mantis 시나리오. hermes 33.5k 테스트지만 **전부 mock — 라이브 품질 게이트 부재** |
| 모델 포스처 | B+ | A | A | 둘 다 성숙한 멀티모델 라우터. Muse 로컬 gemma4:12b 기본+BYO 클라우드+**프라이버시-계층 라우팅(경쟁사 둘 다 이 축 자체가 없음)** |

**종합**: Muse ≈ **B+** (범용), 선택 엣지 **A+**. openclaw ≈ 멀티채널 게이트웨이
표준급(폭 A+, 정직성 D). hermes ≈ 보안·자기개선 루프가 가장 잘 닫힌 개인
에이전트(보안 A, 라이브검증 부재).

### 규모의 진실 (공정성)

- 최근 3주 커밋: openclaw **6,160**(최다 기여자 혼자 2,585 + 봇 576),
  hermes **3,041**(~130/일). 둘은 팀+자동화가 붙은 **제품**, Muse는 1인 프로젝트다.
  절대 폭으로 붙는 건 성립하지 않는다.
- 그런데 둘 다 최근 커밋의 **절반 이상이 `fix`**(openclaw 54%, hermes 52%) —
  **폭이 스스로를 잡아먹는 유지비**가 드러난다(openclaw UTF-16 절단 버그가 12개
  모듈 반복). Muse의 "깊이 우선·채널 skip" 판정은 사후적으로 옳았다.

---

## 3. 경쟁사 능력 전수조사 — 무엇이 있고 무엇이 호평받는가

18-스윕이 캔 능력 지도. **참조용**(무주공산 확인 + 아이디어 도출), 채택분은 §6.

### 3.1 hermes-agent (Python, ~103 툴, 1,936 테스트파일)

- **자기개선 루프(crown jewel)**: 스킬 자기저작(create/edit/patch/delete + AST
  감사 + provenance) + **Curator**(7일 주기 fork, 결정론 stale→archive 가지치기 +
  opt-in LLM consolidation, tar.gz 스냅샷/rollback). 웹 호평 1위: "20+ 스킬 쌓이면
  40% 빠름", "몇 주 전 세부사항을 기억해 마법 같다".
- **메모리**: 8 백엔드(2 first-party: Holographic HRR·Hindsight KG; 6 API 래퍼).
  drift 감지(round-trip 해시), per-turn consolidation 예산, frozen-snapshot+
  live-state, provenance ContextVar(foreground vs 자율 쓰기 구분). **한계(웹
  비판)**: 메모리 2,200자·유저 1,375자 캡 → ~20 엔트리. 한글엔 특히 치명.
- **오케스트레이션**: delegate 3.4k-LOC(leaf/orchestrator 역할·동시성 캡 3·
  용량초과 거부·하트비트 스테일 idle450s/in-tool1200s), async 완료를 **큐로만→
  idle 윈도우 드레인**(mid-LLM 삽입 없음), 부모-헤드룸 요약 예산(×0.5/n, floor
  2000자, 초과분 파일 스필).
- **신뢰성**: iteration budget(부모90/서브50, PTC 환불), jittered backoff(5s→120s
  decorrelated), stream stale 180s·reasoning floor 600s, error 20-분류 taxonomy,
  turn-retry one-shot 상태(같은 처방 이중적용 방지), message-sequence 복구.
- **보안(crown jewel)**: tirith 외부 바이너리(SHA-256+cosign, homograph/pipe-to-
  interpreter/terminal injection 스캔) + approval.py hardline(12 무조건차단) +
  셸 난독화 해제(NFKC·ANSI·$IFS·라인연속·홈경로접기·subshell 앵커) + OSV MAL-*.
  **로컬 exec 자체엔 OS 샌드박스 없음**(Docker/Modal/SSH/Daytona는 opt-in 백엔드).
- **툴/미디어**: multi-backend 실행 추상화, checkpoint(git 스냅샷/rollback),
  fuzzy_match 9전략(패치 안전), PTC(RPC 마샬링), 브라우저(AX-tree @eN refs·CDP
  supervisor·lightpanda→Chrome 폴백·camoufox 안티탐지), computer-use(SOM/vision/ax),
  voice(적응형 무음감지·Whisper 환각필터), vision(네이티브 fast-path·CPU-바운드).
- **웹 일상 사용처**: 아침 브리핑(cron), 티켓 다이제스트, 코드리뷰, 가족 WhatsApp
  비서. **웹 비판**: 무제한 셸(샌드박스 없음, CVE-2026-7396 path-traversal),
  1-2 tok/s 오버헤드(직접 호출 45 tok/s 대비), 64K 토큰 최소요구.

### 3.2 openclaw (TypeScript, 149 확장, 6,892 테스트파일)

- **멀티채널 게이트웨이(crown jewel)**: 24+ 채널(WhatsApp·Telegram·Slack·Discord·
  Signal·iMessage·Matrix·…) + 52 프로바이더. gateway가 인증·라우팅·HTTP tool-invoke
  프론트. 웹 호평 1위: "이미 쓰는 채널에서 답한다", 비개발자 자연어 사용.
- **메모리 "dreaming"**: 3단계(light 6h·deep nightly·REM weekly) 승격 스코어(빈도·
  관련성·다양성·최근성 반감기 14d·min-recall 3·health<0.35 복구모드). **기본 OFF**.
  LanceDB 하이브리드(BM25+vector), active-memory(회상 서브에이전트, 서킷브레이커).
- **스킬 워크숍**: proposal 라이프사이클(pending→apply/reject/quarantine/stale 30d),
  콘텐츠 스캐너(critical→차단), support 파일 32개/1MB 캡.
- **에이전트 루프**: compaction 플래너(별도 워커, 40% 청크·1.2 안전마진), tool-loop
  감지(창30·warn10·crit20·ping-pong·no-progress·휘발성ID 스트리핑), post-compaction
  루프가드(창3), compaction safety timeout 180s, context-engine quarantine(64엔트리).
- **보안**: exec-authorization-plan(셸 토폴로지 분석, heredoc/동적실행 거부),
  exec-auto-reviewer(모델 리스크 triage — **allow-once/ask만 가능, deny·우회 불가**),
  dangerous-tools(게이트웨이 HTTP 15툴 deny), plugin-trust(공급망 pinning/SRI),
  secret-mask, **opt-in Docker 샌드박스**(cap-drop·seccomp·AppArmor·리소스캡).
- **오케스트레이션**: 서브에이전트(깊이4 role 강등·상속 deny·target policy),
  task-flow SQLite, cron isolated-agent(fresh context), ACPX(Agent Client Protocol),
  codex-supervisor, delivery 백프레셔(soft25/hard50).
- **UX**: command palette(Cmd+K 90+항목), exec-approval 모달(위험부위 span 하이라이트),
  device pairing(QR/토큰), Logbook(주기 스크린샷→작업 타임라인), Phone Control
  (arm/disarm 고위험), Canvas(비주얼 워크스페이스), companion 앱(Win/mac/iOS/Android).
- **웹 일상 사용처**: 이메일 자동화(7AM 워크플로), PR 모니터링, CRM 통화 로깅.
  **웹 비판(심각)**: 2026-03 CVE 홍수(4일 9건·CVSS 9.9 권한상승), 미인증 공개
  인스턴스 63%, ClawHub 스킬 17% 악성 코드, 공급망(unvetted npm), "격일로 깨짐".

### 3.3 Muse가 이미 동급 이상인 것 (2차 스윕이 역-확인 — 재구축 금지)

- **스킬 저작/큐레이션**: Muse authored-skill-store가 이미 utility-aware
  eviction(TinyLFU)·write-time subsumption(Voyager)·quarantine+리스크스캔·스냅샷
  링+롤백·병합 semantic-coverage 게이트 보유 → openclaw workshop / hermes Curator
  대비 **A급 parity**.
- **PTC**: hermes code_execution RPC 마샬링 = Muse `run_tool_plan`이 이미 커버.
- **프롬프트 stable-prefix**: `@muse/prompts`가 stablePrefix+stable/dynamic 섹션+
  priority 보유 → cache-boundary 개념 존재.
- **cost 추적**: `muse cost` 로컬(`~/.muse/token-usage.jsonl`)+admin 양쪽.
- **비전 파이프라인**: gemma4 비전·whisper STT·KSS TTS 배선 완료.
- **에러 taxonomy·retry·backoff·stream-idle·tool-dedup·위험명령 게이트(DS-2)·
  파국명령 fail-close(TX-6)·resume 멱등성** 등 신뢰성 다수는 backlog에서 이미 출하.

---

## 4. 포지셔닝 삼각검증 — Muse의 세 엣지가 무주공산

가장 중요한 발견. **세 독립 소스가 같은 결론에 수렴**했다:

| 소스 | openclaw | hermes |
|---|---|---|
| 독립 프로파일러(코드) | grounding "가장 계측 안 된 차원", 프롬프트뿐 | grounding X-search 한 곳 빼면 부재 |
| 웹 평판(커뮤니티) | #1 비판=보안(CVE·미인증·17% 악성스킬), #2=신뢰성("격일로 깨짐") | #1 비판=무제한 셸·샌드박스 없음; 메모리 2200자 |
| **경쟁사 자체 문서** | **grounding/citations·privacy-first/local-only·eval/검증 3종 모두 문서 부재** | **동일 3종 모두 부재** |

경쟁사 자체-문서 마이닝(hermes README/docs 355파일 + openclaw docs 699파일)
결과: 양측 모두 grounding·프라이버시-우선·eval 프레임워크를 **crown-jewel로도
문서 섹션으로도 제시하지 않는다.**

→ **Muse의 세 엣지(결정론 grounding·로컬-우선 프라이버시·라이브 eval 게이트)는
경쟁사가 "안 만든" 게 아니라 "문서로 내세울 것조차 없는" 무주공산이다.** 이는
로드맵 방향을 바꾸지 않고 **확신**을 준다: B-차원을 A+로 올리되 세 엣지를 절대
희생하지 말 것. 그리고 **경쟁사 최대 약점(보안·신뢰성)이 정확히 Muse 강점 축**
이므로 W1(보안)·W2(신뢰성)를 먼저 두는 순서가 확정된다.

> 주의: 웹 평판의 구체 수치(스타 수·CVE 번호)는 미검증 커뮤니티 vibes로 취급하고
> **방향성만** 채택한다. 경쟁사 실코드가 뒷받침하는 사실("로컬 exec OS 샌드박스
> 부재")만 하중-주장에 쓴다.

---

## 5. Muse의 정직한 강·약점

**진짜 강점 3 (방어 가능한 이유 포함)**:
1. **결정론 grounding 게이트 — 카테고리 유일.** 35개 표면 결정론(non-LLM-judged)
   fail-close, fabrication=0 릴리스 게이트. 게이트웨이 제품은 처리량·채널이 우선
   이라 사후에 35개 표면에 결정론 게이트를 소급 설치하는 건 Muse가 3개월 걸린
   일 — **모방 비용이 가장 큰 자산.**
2. **검증 규율이 곧 품질의 증거.** hermes는 33.5k 테스트가 있어도 "모델이 실제로
   일을 해내는가"를 재는 게이트가 없다. Muse는 tool-selection 371·adversarial·
   plan-quality가 실 로컬모델로 릴리스를 막는다. 소형 모델을 쓰기 때문에 생긴
   규율이 우위가 됐다.
3. **학습의 정직성.** hermes Curator는 "스킬을 늘리는" 루프, Muse Whetstone+
   correction-decay는 "**틀림을 줄이는**" 루프. 'Learns you' 포지셔닝과 유일하게
   일치.

**진짜 약점 3 (냉정하게)**:
1. **모델 천장이 모든 B등급의 공통 원인.** 멀티스텝 신뢰성(eval:computer-task
   ~50-66%), 툴콜 예산 10, 병렬 환상 — 로컬 12B의 물리 한계.
2. **runner 샌드박스 부재는 자기-원칙 위반급 갭.** "위험 실행은 crates/runner
   경유"가 계약인데 그 runner가 env_clear+timeout+출력캡뿐. Muse의 비협상("가드는
   결정론 코드")에 유일하게 못 미치는 지점.
3. **연료 기근.** 학습 기계는 다 지었는데 ~/.muse가 사실상 비어 있음(7/7 발견).
   위 A등급들이 아직 "실험실 A"라는 뜻.

---

## 6. A+ 도출 — 우리가 해야 할 것 (전 차원 슬라이스 큐)

각 슬라이스: **참조**(reference-only, 아이디어 도출) · **Muse 현재**(2026-07-11
검증) · **구현**(Muse 자체 설계) · **수용**(검증 게이트). 크기 (S/M/L).

### 6.0 워커 계약 (모든 슬라이스 공통 — 어기면 무효)

1. **VERIFY-FIRST.** 착수 전 Muse 코드에서 현 상태 확인(codegraph). 병행 루프가
   먼저 출하했으면 **no-op 판정 후 ⏭️ 표기**하고 다음으로. "Muse 현재"는
   2026-07-11 스냅샷일 뿐이다.
2. **검증 사다리.** 최좁은 단위테스트 → mutation-RED → `pnpm test:changed` →
   lint 0/0. 에이전트-facing(툴/프롬프트/어댑터)은 `eval:tools`/해당 라이브 배터리,
   신규 라이브 케이스는 **STABLE 3/3** 선검증. 요청/응답 경로는 `smoke:live`.
3. **maker≠judge.** 슬라이스 후 독립 평가자(별도 서브에이전트)가 PASS/FAIL,
   FAIL은 구체 위반 명시.
4. **비협상.** agent-core 벤더중립 · 가드는 fail-close 결정론 코드(보안≠프롬프트) ·
   outbound draft-first · **grounded-surface 수·fabrication=0 절대 불변** · 주석은
   WHY만 · 신규 내부의존성은 package.json+tsconfig references 양쪽.
5. **경쟁사 코드는 이해용 참조.** 열어서 메커니즘 이해 후 Muse 패턴/네이밍으로
   재설계. 상수는 로컬 12B·단일 GPU에 재보정하고 근거를 테스트에 남길 것.

### 6.0.1 ★ Round 1 적대적 검증 결과 (2026-07-11, 5-Haiku + Fable 재검증) — 워커 필독

계획의 모든 "Muse 현재/갭" 주장을 실코드로 반증 시도했다. **false-gap 5건(계획이
"없다"고 했으나 실재 → 삭제), 정련 4건.** 워커는 아래 삭제 슬라이스를 절대 짓지
말 것(no-op이거나 기존 안전결정 위반).

**삭제 (⏭️ 실재 확인 — 짓지 말 것):**
- **D1-S4 (preflight 컴팩션)**: `workingBudgetTokens`가 이미 배선됨 —
  `runtime-wiring.ts:126-129`(`maxContextWindowTokens × DEFAULT_WORKING_BUDGET_RATIO`,
  env `MUSE_LLM_WORKING_BUDGET_TOKENS`) + `chat-ink-core.ts:905`. 창 사용률 %-임계
  사전 컴팩션이 **기본 on**. 잔여(선택): 컴팩션 발생을 유저에게 표기하는지만 확인.
- **D4-S5 (history-search 툴)**: `history_search` MuseTool이 이미 존재
  (`packages/recall/src/history-search-tool.ts:20/40`, risk:read). 코어+툴 완결.
- **D3-S5 (background_process start/stop 툴)**: `background_list`(read-only)는 이미
  에이전트-facing(`domain-tools/src/background-list-tool.ts:20`), start/stop/logs는
  **의도적 CLI-전용**("state-changing exec must stay user-initiated" — outbound-
  safety). 에이전트 노출은 기존 안전결정 위반이라 **하지 말 것**.
- **D7-S2 (doctor fix-steps)**: 각 체크가 이미 "run `muse X`" 수리단계 반환
  (`commands-doctor-checks.ts:61/64/79/220/226`). 완비.
- **D-KO-S2 (CJK 검색)**: `recall-lexical.ts:44-53`가 이미 Hangul/Han/Hiragana/
  Katakana 음절-레벨 토큰 + NFC·전각→반각 정규화. `searchHistory`가 이걸 사용. 완비.

**정련 (실-갭이나 범위 축소):**
- **D3-S2 (하트비트)**: stale-detection 레지스트리(heartbeat/detectStalled/
  markStalledAsTimedOut, `subagent-run-registry.ts:100/174/185`)는 이미 존재하나
  **호출부가 orchestrator worker-settle 1곳뿐**(`orchestrator.ts:347`). 실-갭은
  딱 하나: **단일 장기 run**(챗/ask 주경로, 멀티워커 아님)이 run 중 heartbeat 미방출.
  → 슬라이스 = 기존 detectStalled **재사용** + agent-runtime 툴루프가 tool-start마다
  heartbeat 호출(신규 감지기 짓지 말 것).
- **D5-S3 (toolCalling 폴백)**: 단순 "미배선"이 아니라 **死코드** —
  `canUseNativeTools`(`packages/model/src/index.ts:292`)가 정의됐으나 **호출부 0**.
  계약(architecture.md:38)만 있고 런타임 미배선. 슬라이스는 그 함수를 실제
  게이트로 배선.
- **D-KO-S1 (UTF-16)**: safe 패턴이 이미 `truncateErrorBody`(`shared/src/index.ts:257-260`)에
  존재 → 그걸 공유 헬퍼로 추출 + **정확한 미안전 3곳 배선**: `history-search.ts:206/213`
  (스니펫), `tool-definition-helpers.ts:108`(툴 설명), `knowledge-corpus.ts:365`(요약).
- **D2-S6 (write-approval 스테이징)**: `pending-approval-store.ts`가 **채널 경로엔
  이미 존재**(`~/.muse/pending-approvals.json`, `{id,tool,arguments,draft,expiresAt}`).
  CLI 로컬 쓰기만 동기(`actuator-tools.ts:262`). → 기존 스토어 **재사용**해 CLI 경로 확장.

**전량 확정(짓기 정당) — 특히 D2 보안 7슬라이스 전부 false-gap 0**: runner OS
샌드박스 부재(`crates/runner/src/main.rs`: env_clear+timeout+cap만)·DS-2에 NFKC/ANSI/
홈경로 부재·토폴로지 AST 부재·run_command 시크릿 미-redaction(`runner.ts:88-103`,
실제 유출 확인)·승인 span 하이라이트 부재·calendar 평문(`calendar/src/local-provider.ts:202`).
나머지 D1(S1/S2/S3/S5/S6/S7)·D3(S1/S3/S4/S6)·D4(S1/S2/S3/S4)·D5(S1/S2/S4/S5)·
D6·D7(S1/S3/S4)도 실-갭 확정.

### D1 — Agent loop (B+ → A+)

> **Muse 현재**: maxToolCalls 10·wallclock 300s(`agent-runtime.ts:284-288`).
> no-progress 스톨감지+tool-failure-streak. 컴팩션: 결정론 `[Key details]` floor +
> opt-in aux 요약(CMP-2 완결) + anti-resume + stale-image 스트립. stream idle-timeout·
> 요청비례 타임아웃·retry-after·decorrelated jitter·에러분류기 전부 출하.
> **갭**: ping-pong 감지·post-compaction 루프가드·단계적 요약·식별자보존·preflight·
> one-shot 회복·예산 가시화·브라우저 소형모델 신뢰성.

- **D1-S1. Ping-pong + 휘발성-ID 스트리핑 루프감지 (M).** 참조: openclaw
  `tool-loop-detection.ts`(창30·warn10·crit20·A↔B 교대·send결과 messageId/ts 제거).
  Muse `tool-loop-progress.ts`는 동일-출력 스톨만. 자매 모듈 `tool-loop-pingpong.ts`,
  서명 SHA256(tool+안정화 args), 결과해시에서 Muse 툴 휘발필드(runId/tsIso/id) 제거,
  창/임계 12B 재보정(창20·warn6·block10 제안), CRITICAL은 blockedToolResult 합류.
  수용: 교대루프 유닛5+(진짜진행 통과)·mutation·eval:computer-task 회귀 없음.
- **D1-S2. Post-compaction 루프가드 (S).** 참조: openclaw `post-compaction-loop-
  guard.ts`(창3). Muse 부재(anti-resume는 프롬프트뿐). 컴팩션턴(summaryInserted) 후
  3-call 창 무장, 결정론 기본on. 수용: 시나리오 유닛+mutation.
- **D1-S3. 단계적 요약 + 식별자 보존 (M).** 참조: openclaw `summarizeInStages()` +
  hermes 요약예산(min 2000tok·ratio0.20·상한10K). Muse `summarizeDroppedContext`는
  1회 요약(600자)→초과 시 통째 실패. tool-pair 경계 청크→청크별 aux 요약→병합,
  전단계 FAIL-OPEN, **"불투명 식별자(UUID/경로/URL/숫자) 원문 보존" 지시 명문화**
  (grounding 강화 겸). 수용: 경계 유닛+부분실패 보존+mutation·기존 CMP-2 무수정.
- **D1-S4. ⏭️ 삭제(FALSE-GAP).** 컴팩션 preflight는 `workingBudgetTokens`로 이미
  기본 배선(§6.0.1). 잔여(선택, 최소): 컴팩션 발생을 유저에게 1줄 표기하는지 확인,
  없으면 display-only 티끌 슬라이스.
- **D1-S5. 이터레이션 예산 재설계 + 가시화 (M).** 참조: hermes `iteration_budget.py`
  (부모90/서브50·PTC 환불). Muse maxToolCalls=10(호출수만). (a) PTC 플랜스텝 계상
  규칙 명문화(프로그래매틱=1). (b) 서브에이전트(보드)는 별도 하위예산. (c) 소진
  중단 시 "예산 한도(N/M)" 명시 — **침묵 중단 금지**. 기본값 10은 12B 실증치라
  불변(상향은 eval:computer-task로만). 수용: 계상·소진메시지 유닛+mutation.
- **D1-S6. 턴-내 one-shot 회복 상태 (S).** 참조: hermes `turn_retry_state.py`.
  Muse는 개별회복 산재. 턴 상태 객체로 통합(이중 재시도 구조적 불가), 동작불변
  리팩터. 수용: 회복분기 각 1회 보장 유닛.
- **D1-S7. 브라우저 refs + step-budget + dialog-inline + 인젝션 defang (L).** 참조:
  hermes `browser_tool.py`(AX-tree @eN·dialog을 snapshot 인라인·lightpanda폴백),
  openclaw `browser-tool.actions.ts`(compact ai 스냅샷·timeout 주입·stale-tab 복구·
  page vision 라우팅). Muse는 puppeteer detached-Chrome(ambiguous fail-close) 보유.
  (a) 스냅샷을 **숫자 인덱스 @e1…** 반환(CSS 셀렉터 생성 금지 — 12B 불가), (b)
  action당 timeout+task별 step 카운터(하드캡·근접경고·답변에 `actions_used N/M`),
  (c) pending dialog을 스냅샷 필드로+서버측 auto-dismiss, (d) **page 콘텐츠 `<page>`
  래핑+미디어지시 defang**(인젝션 방어 — 브라우저는 untrusted 최대 통로). 수용:
  refs 안정성·step소진·dialog-inline·인젝션 defang 계약("ignore above" 무력화)+
  eval:computer-task 회귀없음. browser는 실 e2e 필요(조립경로 몰면 거짓 — 교훈).

### D2 — Security (B+ → A+)

> **Muse 현재**: runner `env_clear()`(시크릿 유출 원천차단 — hermes 블록리스트보다
> 강함)+timeout상한+출력캡, **OS 샌드박스 없음**. 위험명령 게이트 DS-2(quote-aware
> 정규화·$IFS·라인연속·치환·앵커)+TX-6 파국명령 fail-close. 승인 시크릿마스킹·
> OSV MAL-*·암호화 다수스토어(잔여 calendar)·인젝션 배터리·egress fail-close.
> **재조정**: hermes도 로컬 exec엔 OS 샌드박스 없음(Docker는 opt-in). openclaw만
> opt-in Docker. Muse 갭은 "표준 미달"이 아니라 "**opt-in 격리 백엔드 부재**".

- **D2-S1. runner seatbelt 샌드박스 (opt-in) (L) ★최우선.** 참조: openclaw
  `sandbox/*`(cap-drop·리소스캡·네트워크모드·env새니타이즈, Docker기반). Muse는
  macOS-우선이라 **seatbelt(`sandbox-exec` 프로파일)**가 정답 — 데몬/의존성0.
  `crates/runner` `MUSE_RUNNER_SANDBOX=seatbelt` opt-in: 기본 deny-write, 허용=cwd
  이하+$TMPDIR, 네트워크는 요청 플래그로만, `~/.ssh`·`~/.muse` 등 민감경로 읽기도
  거부. 프로파일 문자열 코드생성(요청별 cwd 삽입·이스케이프검증), 실프로세스
  Rust 유닛(탈출 3종 실패·허용 write 성공·네트워크 차단). 비-macOS는 "unsupported
  →기존동작+경고". `muse doctor` 포스처체크. 수용: 실행계약 5+·기존 runner 무수정·
  미설정 byte-identical·**eval:adversarial에 탈출시도 케이스 추가**.
- **D2-S2. 셸 토폴로지 분석 fail-close (M).** 참조: openclaw `exec-authorization-
  plan.ts`(heredoc·동적실행 "분석불가"로 거부)+hermes 서브셸 앵커. Muse DS-2는
  문자열 패턴 레벨 — `$(...)`/백틱/heredoc 안 파국명령은 앵커가 놓칠 수 있음.
  `parseRunnerCommandRequest` 앞단 토폴로지 패스: 치환/heredoc/eval 감지→**파국검사
  불가→승인 필수 강등**(무조건 거부 아님·정당 heredoc 존중), quote-aware(DS-2
  오탐 교훈). 수용: 우회 클래스별 차단+near-miss 통과 쌍·mutation-RED.
- **D2-S3. 난독화 해제 확장 — NFKC+ANSI+홈경로접기 (S).** 참조: hermes approval.py.
  Muse DS-2에 $IFS/라인연속/치환은 있음 — NFKC/ANSI/홈접기 **verify-first**, 없으면
  추가. 수용: 우회 페이로드 쌍+기존 DS-2 무수정.
- **D2-S4. runner 출력 시크릿 마스킹 (S).** 참조: openclaw secret-mask. Muse
  `redactSecretsInText`가 runner stdout→모델 경로에 배선됐는지 **verify-first**,
  미적용이면 run_command 결과 반환 직전 통과. 수용: 배선 유닛+대형출력 성능무해.
- **D2-S5. 암호화-at-rest 잔여 calendar (S).** backlog "LAST encryption item".
  reflections/belief-provenance 검증 템플릿 재사용. 수용: 라운드트립 3종+format-
  preserving.
- **D2-S6. exec 승인 span 하이라이트 + write-approval 스테이징 (M, 정련됨).** 참조:
  openclaw `exec-approval.ts`(위험부위 span)+hermes `write_approval.py`. (a) 승인
  프롬프트에서 위험 토큰(파괴 플래그·민감경로) 하이라이트 — 현 `summarizeToolArgs`
  (`chat-ink-core.ts`)는 clip+redact만, 하이라이트 없음(§6.0.1). DS-2 분류기 재사용·
  시크릿 마스킹 유지. (b) 스테이징은 **기존 `pending-approval-store.ts` 재사용** —
  채널 경로엔 이미 존재(`~/.muse/pending-approvals.json`), CLI 로컬 쓰기만 동기
  (`actuator-tools.ts:262`)이므로 그 스토어를 CLI 경로로 확장(신규 스토어 금지).
  수용: 하이라이트 위치·스테이징 no-external-effect 계약(승인 전 절대 미실행)·mutation.
- **D2-S7. eval:adversarial 확대 16→24+ (M).** 신규: 샌드박스 탈출3·토폴로지 우회3·
  난독화2 — 전부 **결정론 가드가 막는 걸 코드로 검증**(모델 거부 의존 금지).

### D3 — Orchestration (B → A+)

> **Muse 현재**: `@muse/multi-agent` 보드(의존성게이트·재시도사유·zombie reclaim
> 30분·병렬분해+합성·REVIEW 파킹·read-only executor), X-3 백그라운드 레지스트리
> (S1-S6·crash reconcile·cap50), 스케줄러 graceful drain+pause. race모드는 의도적
> sequential 폴백(정직 문서화 — 단일 GPU).

- **D3-S1. 서브에이전트 역할 강등 + 상속 tool-deny (M).** 참조: openclaw
  `subagent-capabilities.ts`(깊이≥max→leaf·부모 deny 상속)+hermes(max_spawn_depth1).
  Muse 보드는 flat. expand가 재-expand 가능한지 **verify-first**(무한분해 위험).
  태스크에 depth 필드·`MUSE_BOARD_MAX_DEPTH`기본1, 도달 시 expand 거부, executor
  read-only 게이트에 부모 deny 상속(구조·프롬프트 아님). 수용: 깊이경계·상속 유닛+
  mutation(강등제거→RED).
- **D3-S2. 런타임 하트비트 — 단일-run 배선 (S, 정련됨).** 참조: hermes
  `_heartbeat_loop`. **주의(§6.0.1)**: stale-detection 레지스트리(heartbeat/
  detectStalled/markStalledAsTimedOut)는 이미 존재하나 호출부가 orchestrator
  worker-settle 1곳뿐. 실-갭 = **단일 장기 run**이 run 중 heartbeat 미방출. 신규
  감지기 금지 — **기존 detectStalled 재사용** + agent-runtime 툴루프가 tool-start/
  delta마다 `heartbeat(runId)` 호출(in-tool 스테일→abort+사유). 수용: fake-clock
  유닛(단일 run 스테일 감지)+정상 장기스트림 비오탐.
- **D3-S3. 완료-이벤트 idle-드레인 계약 핀 (S).** 참조: hermes async_delegation
  (완료 큐→idle 윈도우만 드레인·교대/캐시 보존). Muse jobCompletions/proactive
  폴링이 사실상 이 패턴 — "생성 중 삽입 불가" **계약 테스트 부재**, verify-first 후
  핀. 수용: busy 중 완료이벤트 미삽입 계약.
- **D3-S4. 용량 거부 + 부모-헤드룸 요약예산 (M).** 참조: hermes(cap3 초과 async
  거부·헤드룸×0.5/n·floor2000·파일스필). Muse `/job` 상한 verify-first·합성 예산
  산식 없음. (a) job 동시상한(기본3·초과 명시거부), (b) `boardTaskPrompt` 합성에
  헤드룸비례 per-child 예산+`~/.muse/board-spill/` 스필+답변에 경로 명시. 수용:
  상한거부·예산경계 유닛+스필 왕복.
- **D3-S5. ⏭️ 삭제(FALSE-GAP + 안전결정 위반).** `background_list`(read-only)는
  이미 에이전트-facing, start/stop/logs는 **의도적 CLI-전용**(outbound-safety —
  §6.0.1). 에이전트에 start/stop 노출은 기존 결정 위반이라 **하지 말 것**.
- **D3-S6. eval:orchestration 래칫 (S).** D3-S1~S4 라이브 케이스 편입 pass^3, MAST
  상위 실패모드(스텝반복·종료미인지) 2+ 포함.

### D4 — Tools (B → A+, 단일사용자 스코프의 A+)

> **A+ 재정의**: 149 확장 추격이 아니라 — 개인비서 macOS 빌드가능 목록 잔여0 +
> 모든 툴 12B 원샷 선택검증 + 외부 에이전트에게 안전한 MCP 서버.

- **D4-S1. `muse mcp serve` 확장 (M).** 참조: hermes `mcp_serve.py`(자신을 MCP
  서버로). Muse는 read-only 3툴만. read 계열 확대(recall/notes·캘린더·태스크·
  browsing) + write는 **draft-first 프록시**(외부요청→Muse 승인큐 파킹·자동실행
  불가) + **grounded recall 노출 = 엣지의 수출**(외부도 인용-게이트 답 수신).
  수용: MCP 계약(stdio 왕복)+write-파킹 no-external-effect+grounded-recall 인용
  게이트. groundedSurfaces 35→36.
- **D4-S2. macOS 커버리지 잔여 (S×4).** backlog 07-07 맵: Photos·앱종료·다크모드·
  밝기/블루투스(Shortcuts) + Apple 연락처 '쓰기'(draft-first). mac_system_set enum
  확장 우선(신규툴 신설 금지·혼동쌍 방지)+eval 케이스.
- **D4-S3. `muse ask --with-tools` seam 리트로핏 (M).** backlog 07-10 (a): prepare-
  only seam 진입점→레거시 조립 탈출·commands-ask.ts LOC 음수. 수용: cli ask 무수정+
  seam parity.
- **D4-S4. computer-control 신뢰성 — file_edit 결정론 리페어 (M).** eval:computer-
  task ~50-66% 주범이 multi-step 편집. 실패 시 결정론 재정렬/재시도 1회(모델 재추론
  금지). 수용: 베이스라인 +10%p·pass^3.
- **D4-S5. ⏭️ 삭제(FALSE-GAP).** `history_search` MuseTool이 이미 존재
  (`history-search-tool.ts:20`, risk:read — §6.0.1). 잔여(선택): hermes session_search의
  앵커±윈도우/bookend 스크롤을 기존 툴에 옵션으로 더할지 — 저우선.

### D5 — Model posture (B+ → A+)

> **Muse 현재**: privacy-tiered routing이 chat 양 표면(단발+Ink) 완비 — **경쟁사
> 둘 다 이 축 자체가 없음**. MUSE_VISION_MODEL/MUSE_AUX_COMPACTION 개별노브·DS-21
> 컨텍스트 프로브·BYO-key 4종.

- **D5-S1. privacy routing follow-ups 완결 (M).** (b) context-free 툴 사용의 클라우드
  결정=**"no" 명문화**(툴은 개인데이터 통로→로컬 고정이 원칙), (c) personaPreamble
  nuance 문서화, (d) KO 구어 소유격(내꺼/제꺼) 토큰(오탐 쌍) + `muse setup cloud`
  안내단계. 수용: 각 유닛+기존 20 계약 무수정.
- **D5-S2. auxiliary.<task> 모델피닝 일반화 (M).** 참조: hermes `auxiliary.<task>`
  (태스크별 모델+폴백). Muse 개별노브는 단편. `resolveAuxiliaryModel(task,env)` 단일
  리졸버(하위호환), 태스크 compaction/vision/rewrite/judge/embedding-rescue,
  **로컬-우선 불변**(aux도 privacy 게이트 통과·개인컨텍스트 태스크는 클라우드 금지).
  수용: 리졸버·하위호환·local-only 게이트 유닛.
- **D5-S3. capability 死코드 배선 (S, 정련됨).** 참조: openclaw compat 플래그.
  **주의(§6.0.1)**: `canUseNativeTools`(`model/src/index.ts:292`)가 정의됐으나
  **호출부 0 = 死코드**. 계약(architecture.md:38 "네이티브 툴콜 불가→텍스트 프로토콜")만
  있고 런타임 미배선 → toolCalling=false 모델은 조용히 실패. 그 함수를 실제 게이트로
  배선(false→텍스트 툴 프로토콜 폴백 또는 명시적 미지원 에러). 수용: 케이퍼빌리티
  부재 모델 계약(mocked)+死코드 호출부 생김 확인.
- **D5-S4. 명시적 fallback chain (M).** 참조: openclaw allowlist+fallback(오타 조기
  거부). Muse 원칙("숨은 재시도 금지"): 폴백은 **명시 설정**(`MUSE_MODEL_FALLBACKS`)
  일 때만·각 폴백도 privacy/local-only 게이트·발생을 답변 1줄 표기. 수용: 체인워크·
  게이트 유닛·미설정 byte-identical.
- **D5-S5. 클라우드 라이브 왕복 실증 1회 (attended, S).** 진안 키로 privacy-routing
  실왕복(context-free ☁️·개인 로컬고정) 기록.

### D6 — Memory (A- → A+, 연료가 본질)

- **D6-S1. Sleep-consolidation (opt-in) (L).** 참조: openclaw dreaming 승격스코어
  (6요소·반감기14d·health<0.35 복구) — **기본 OFF까지 모방 말 것**. Muse식: episodic
  →durable 승격을 **결정론 스코어**(재-recall·distinct질의·최근성 반감기·LLM없음)로
  후보선정, 승격은 **draft 제안**(proactive "오래 기억할까요?")·**자동쓰기 금지**
  (교정-망각 원칙). loop-v2 Sleep daemon 정합. 수용: 스코어 유닛+제안카드+자동쓰기
  없음 계약(mutation).
- **D6-S2. 연료 파이프라인 점검 (S, attended).** browsing auto-sync 실기기 on +
  proactive/recap 연결(backlog99) + 주간 real-miss 리포트(`muse doctor --flywheel`,
  scout-signals 재사용).
- **D6-S3. 메모리 drift 감지 (round-trip) (S).** 참조: hermes `memory_tool.py`
  (재직렬화 해시 불일치→쓰기차단+`.bak`). Muse 스토어는 atomic이나 **다중 프로세스
  (CLI/데몬/루프) 동시편집** 오염 verify-first(main-worktree hazards 동류). 수용:
  오염 시나리오 유닛+차단 계약.
- **D6-S4. provenance 태그 — foreground vs 자율 (S).** 참조: hermes ContextVar. 자율
  큐레이션이 **유저-지시** 사실 삭제 못 하게 origin 태그. authored-skill-store는
  이미 성숙(§3.3) — 메모리 facts에도 같은 보호 verify-first. 수용: 자율-삭제-금지
  계약(mutation).

### D7 — UX (신규 차원): 헤드리스를 "쓰기 좋은" 도구로

> Muse는 Ink TUI + macOS 데스크톱(Muse.app, Swift) + 웹 콘솔 3표면. A+ = 일상
> 마찰이 경쟁사 수준으로 낮음.

- **D7-S1. 슬래시 명령 단일소스 레지스트리 (M).** 현재 `SLASH_COMMANDS`가 chat-ink
  단독(commander CLI와 분리). hermes COMMAND_REGISTRY처럼 name·desc·category·aliases·
  platform-gate 1-엔트리가 CLI help·챗 autocomplete·(미래)채널 구동. 수용: 레지스트리
  유닛+양쪽 반영+중복제거 증명.
- **D7-S2. ⏭️ 삭제(FALSE-GAP).** doctor 체크가 이미 "run `muse X`" 수리단계 반환
  (§6.0.1). 완비.
- **D7-S3. 스마트-테일 터미널 출력 (S).** 참조: hermes terminal-output(마운트 하단
  점프·하단근처만 tailing·위로읽으면 방해없음). 웹 콘솔 스트리밍 뷰에 적용. 수용:
  스크롤 로직 유닛+실브라우저 측정(testing.md UI 규칙).
- **D7-S4. desktop 반응성 (S, attended).** Muse.app에 스트리밍 경과타이머+상태반응
  (성공/에러 시각신호). hermes activity-timer·status-dot 참조. 실기기 검증(attended).

### D-KO — 한국어/CJK (신규 차원): 진안-우선 언어의 A+

> Muse는 한국어-우선. 경쟁사는 i18n을 UI번역으로 다루나 **CJK 텍스트 안전성**은
> openclaw가 UTF-16 버그를 3주간 12모듈에서 잡는 중(반면교사). hermes 2200자
> 메모리 한계는 CJK에 특히 치명(한글 1자=여러 토큰).

- **D-KO-S1. UTF-16 안전 절단 헬퍼 추출 + 미안전 3곳 배선 (S) ★ (정련됨).** 참조:
  openclaw `utf16-slice.ts`. **주의(§6.0.1)**: safe 패턴이 이미
  `truncateErrorBody`(`shared/src/index.ts:257-260`, lone high-surrogate 드롭)에 존재.
  그걸 `truncateUtf16Safe`로 **추출**(중복 제거) + **정확한 미안전 3곳 배선**:
  `recall/src/history-search.ts:206/213`(citation 스니펫), `tools/src/tool-definition-
  helpers.ts:108`(툴 설명), `autoconfigure/src/knowledge-corpus.ts:365`(요약). TTS
  cap도 확인. 수용: 한글/이모지/조합문자 경계 유닛+3곳 byte-identical-when-safe.
- **D-KO-S2. ⏭️ 삭제(FALSE-GAP).** `recall-lexical.ts:44-53`가 이미 Hangul/Han/
  Hiragana/Katakana 음절-레벨 토큰+NFC·전각→반각 정규화. `searchHistory` 사용(§6.0.1).
  cross-lingual recall(ask-cross-lingual.ts, v2-moe prefix)도 배선 완료. 완비.
- **D-KO-S3. i18n 정적 메시지 카탈로그 (M, 저우선).** 현재 KO/EN이 `/[가-힣]/`
  인라인 분기 다수. dotted-key 카탈로그 중앙화는 유지보수↑지만 **저우선**(인라인이
  동작하고 진안 언어 KO 고정이라 다국어 압력 낮음·리팩터 리스크>이득 가능).

---

## 7. 웨이브 순서 (권장)

| 웨이브 | 슬라이스 | 이유 |
|---|---|---|
| **W1 (원칙 갭)** | D2-S1 seatbelt → D2-S2 토폴로지 → D1-S1/S2 루프가드 → D2-S6 승인 span+스테이징 | 자기-원칙(결정론 가드) 유일 미달 + 루프이탈 12B 최빈사고. **경쟁사 공통 최대 약점(보안·신뢰성)이 Muse 강점 축** — 여기가 해자 |
| **W2 (신뢰성)** | D1-S3/S5 → D3-S1/S2/S4 → D1-S7 브라우저 | 컴팩션·예산·서브에이전트 안전망 + 소형모델 브라우저 신뢰성 — eval:computer-task 상승 토대 (D1-S4 삭제됨) |
| **W3 (능력·UX)** | D4-S4 → D4-S1 → D4-S2 → D7-S1 슬래시 | 신뢰성 위 커버리지 + 마찰 제거 — 각각 eval 래칫 동반 (D3-S5·D4-S5 삭제됨) |
| **W4 (라우팅·KO)** | D5-S1~S4 → D1-S6 → D2-S3/S4/S5 → D-KO-S1 UTF-16 | 모델 천장 우회 완성 + 한국어-우선 마감 (D-KO-S2 삭제됨) |
| **W5 (기억·마감)** | D6-S1~S4 → D3-S3/S6 → D2-S7 → D7-S3/S4 | 연료·consolidation·무결성·래칫·UX 마감 (D7-S2 삭제됨) |

각 웨이브 종료 = `pnpm self-eval` green + 해당 eval 래칫 수치 상승 + CHANGELOG
[Unreleased] 갱신. 슬라이스당 1 커밋(Conventional Commits).

---

## 8. Non-goals (재도출 금지 — 근거 포함)

- **채널 스프롤**(Telegram/Discord/… 게이트웨이): 심사 10/13 skip. 경쟁사 fix-비율
  52-54%가 폭의 유지비를 실증. openclaw CVE 홍수·미인증 인스턴스가 폭의 대가.
- **멀티테넌트/게이트웨이 릴레이·과금**: off-strategy 50건 기각 유지.
- **tirith-식 외부 바이너리 보안 의존**: 공급망+플랫폼 부담. Muse는 in-repo 결정론
  가드 + OSV 조회(출하)로 동등 커버.
- **LLM-판단이 최종 결정인 보안 게이트**: openclaw exec-auto-reviewer는 "ask로만
  강등" 구조라 참조가치는 있으나 Muse 비협상("보안=결정론 코드") 위반이라 미도입.
- **구독 OAuth 재사용 / banking / 자율 발송**: 영구 경계 유지.
- **리더보드 추격 / 프런티어 모델 종속**: best-OSS-agent 리뷰 결론 — 증명은 게이트
  on-vs-off DELTA.
- **hermes 2200자식 하드 메모리 캡**: 웹에서 실제 비판받는 안티패턴. Muse는 압축·
  episodic로 대응(캡 아님).

---

## 9. 부록 — 근거 검증 로그 (Fable 직접 스팟체크, 2026-07-11)

| # | 주장(스윕) | 검증 |
|---|---|---|
| 1 | hermes iteration_budget 90/50 + execute_code refund | ✅ `agent/iteration_budget.py:1-28` |
| 2 | openclaw post-compaction-loop-guard window=3 | ✅ `post-compaction-loop-guard.ts:15` |
| 3 | openclaw exec-authorization-plan heredoc/dynamic 거부 | ✅ `src/infra/exec-authorization-plan.ts:101-103` |
| 4 | hermes tool budget 100K/200K + 창비례 0.15 | ✅ `tools/budget_config.py:17-75` |
| 5 | openclaw dreaming half-life14d·min-recall3·health0.35 | ✅ `dreaming.ts:40-47` |
| 6 | openclaw 루프감지 30/10/20 | ✅ `tool-loop-detection.ts:39-49` |
| 7 | hermes stream stale180s·reasoning floor600s | ✅ `reasoning_timeouts.py:7-72` |
| 8 | Muse `muse cost` 로컬+admin 양쪽 | ✅ `commands-cost.ts:12-23` + admin 라우트 |
| 9 | Muse prompts stablePrefix/stable-dynamic 보유 | ✅ `packages/prompts/src/index.ts:33-162` |
| 10 | Muse UTF-16 범용 헬퍼 부재(툴-arg만) | ✅ shared surrogate 언급 1곳(:255)·범용 slice 없음 → D-KO-S1 정당 |
| 11 | Muse SLASH_COMMANDS chat-ink 단독 | ✅ `chat-ink.ts:69`만 정의 → D7-S1 정당 |
| 12 | 라이선스 MIT×2 | ✅ hermes `LICENSE`(Nous 2025)·openclaw `LICENSE`(Foundation 2026) |

**Muse-측 확정 팩트**: runner `env_clear()`+timeout-only(`crates/runner/src/main.rs:101`),
`maxToolCalls=10`/`maxRunWallclockMs=300s`(`agent-runtime.ts:284-288`), no-progress
감지 보유·ping-pong 부재(`tool-loop-progress.ts`), `muse mcp serve` read-only 3툴
(`commands-mcp-serve.ts`), authored-skill-store 성숙(eviction/subsumption/quarantine/
snapshot/coverage-gate).

**경쟁사 자체-문서 3중검증**(§4): hermes README/docs 355파일 + openclaw docs 699파일
마이닝 결과, 양측 모두 grounding/citations·privacy-first/local-only·eval/verification을
crown-jewel로도 문서섹션으로도 미제시. 스윕 원문(메커니즘 카탈로그 전체·18에이전트)은
세션 산출물로만 존재 — 이 문서가 채택분의 정본이며, 미채택 메커니즘 재검토는 다음
delta-scout 주기에.
