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
| **검증 규율** | **A** | A- | B+ | (Round2 정정) Muse만 **라이브 fabrication=0 tripwire를 매 push 게이트**(pre-push 훅 `precheck:grounding`, Ollama-의존·없으면 skip) + 최고 인프라(pass^k·LLM-judge+meta-eval·MAST seam·41 eval). **정직한 한계**: 집계 `eval:agent`는 GitHub CI 미배선(클라우드엔 로컬 Ollama 없음), ci.yml=lint+build+test뿐 → 자동 강제는 grounding subset만. openclaw QA-Lab character-eval(LLM-judge)은 **advisory·override 가능**(비-게이트). hermes 33.5k 테스트 **전부 mock·에이전트 eval 0**. Muse 우위(유일 라이브 게이트+최고 인프라)는 유지하나 A+→A로 하향(집계 미강제) |
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
- **D2-S3. 난독화 해제 확장 — NFKC+ANSI만 (S, VQ-3 확정).** 참조: hermes approval.py.
  **VQ-3 결론**: DS-2에 $IFS/라인연속/치환·comment-strip 있고 **홈경로(`~`/`$HOME`)는 이미
  RULES 패턴 내장**(:65/74/83). → 실부재 = **NFKC 유니코드 정규화 + ANSI 이스케이프 strip
  2개만** 추가(전각→반각 homograph·ECMA-48 시퀀스). 수용: 우회 페이로드 쌍(전각 rm·ANSI
  삽입)+기존 DS-2 무수정.
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
- **D3-S7. X-3 PID-재사용 kill 가드 (S) ★ (Round3 발견 — 실 안전 갭).** 참조: hermes
  `process_registry.py`(커널 start-time로 PID 재사용 검증 후 kill). **검증됨(§9 #18)**:
  Muse `stopBackgroundProcess`는 `kill(record.pid)`를 재사용 검증 없이 실행
  (`background-process-spawn.ts:104`), `reconcileBackgroundProcesses`도 `isAlive(pid)`만
  봄(:128) → 원 프로세스가 죽고 PID가 재활용되면 **무관한 유저 프로세스를 SIGTERM**.
  record엔 `startedAt`(:64) 있으나 OS start-time과 미대조. 구현: spawn 시 OS
  프로세스 start-time 캡처(macOS `ps -o lstart=`/Linux `/proc/<pid>/stat`), kill/
  reconcile 전 대조 — 불일치면 kill 금지+record `exited` 마킹(fail-close, 결정론
  가드). 수용: 재사용-시뮬 유닛(start-time 불일치→kill 안 함)+mutation. Muse
  "위험 실행은 결정론 가드" 정신 정합.

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
  금지). **참조(Round2)**: hermes `fuzzy_match.py`의 **9-전략 체인**(exact→line-trimmed
  →whitespace-norm→indent-flex→escape-norm→trimmed-boundary→block-anchor→context-aware
  →unicode-norm) + escape-drift 가드(모델이 넣은 spurious `\'`/`\"` 감지) + indent
  리페어(대체문자열 들여쓰기를 파일 실제에 맞춤). Muse는 자체 결정론 매칭으로 재설계
  (LLM 편집이 공백/이스케이프/들여쓰기 흔들림 → 단일 exact-match 50%+ 실패). 수용:
  베이스라인 +10%p·pass^3 + fuzzy 전략별 유닛.
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
- **D5-S3. capability 死코드 배선 — 명시적 에러 (S, VQ-2 확정).** 참조: openclaw compat.
  **VQ-2 결론**: `canUseNativeTools`(index.ts:292)는 死코드 + **텍스트 툴 프로토콜 자체가
  미구현**(파서 부재). gemma4는 toolCalling=true라 실사용 무영향. → 이 슬라이스 = 그 함수를
  게이트로 배선해 **toolCalling=false 모델에 조용한 실패 대신 명시적 "이 모델은 툴 호출 불가"
  에러**. 완전 텍스트 프로토콜(파서+strict 파싱)은 **별도 L로 이연**(BYO 비-툴 클라우드 쓸
  때만 필요). 수용: 케이퍼빌리티 부재 모델(mocked)이 명시 에러 받음+死코드 호출부 생김.
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
- **D6-S3. 외부-편집 drift 감지 (round-trip) (S, VQ-7 확정).** 참조: hermes `memory_tool.py`.
  **VQ-7 결론**: Muse 메모리 스토어는 이미 `withFileLock`(cross-process, memory-user-store-
  file.ts:248/…)으로 **자체 writer 간 clobber 방지됨**. → 실-갭은 **외부 편집**(수동·patch 툴·
  락 미경유 도구 append)뿐 = hermes가 정확히 잡는 케이스. 재직렬화 round-trip 해시 불일치 시
  rewrite 차단+`.bak.<ts>`(defense-in-depth). 수용: 외부-수정 시나리오 유닛(락 밖 변경→차단)+계약.
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
  그걸 `truncateUtf16Safe`로 **추출**(중복 제거) + **미안전 4곳 배선(VQ-6 확정)**:
  `recall/src/history-search.ts:206/213`(citation 스니펫), `tools/src/tool-definition-
  helpers.ts:108`(툴 설명), `autoconfigure/src/knowledge-corpus.ts:365`(요약), **+
  `voice/src/tts-truncate.ts:19/28`(TTS cap — raw slice, surrogate 가드 0 확인됨)**.
  수용: 한글/이모지/조합문자 경계 유닛+4곳 byte-identical-when-safe.
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
| **W1 (원칙 갭)** | D2-S1 seatbelt → D2-S2 토폴로지 → D1-S1/S2 루프가드 → D2-S6 승인 span+스테이징 → D3-S7 PID-가드 | 자기-원칙(결정론 가드) 유일 미달 + 루프이탈 12B 최빈사고 + PID-재사용 kill 안전갭. **경쟁사 공통 최대 약점(보안·신뢰성)이 Muse 강점 축** — 여기가 해자 |
| **W2 (신뢰성)** | D1-S3/S5 → D3-S1/S2/S4 → D1-S7 브라우저 | 컴팩션·예산·서브에이전트 안전망 + 소형모델 브라우저 신뢰성 — eval:computer-task 상승 토대 (D1-S4 삭제됨) |
| **W3 (능력·UX)** | D4-S4 → D4-S1 → D4-S2 → D7-S1 슬래시 | 신뢰성 위 커버리지 + 마찰 제거 — 각각 eval 래칫 동반 (D3-S5·D4-S5 삭제됨) |
| **W4 (라우팅·KO)** | D5-S1~S4 → D1-S6 → D2-S3/S4/S5 → D-KO-S1 UTF-16 | 모델 천장 우회 완성 + 한국어-우선 마감 (D-KO-S2 삭제됨) |
| **W5 (기억·마감)** | D-E1 eval-게이트 강제 → D6-S1~S4 → D3-S3/S6 → D2-S7 → D7-S3/S4 | 연료·consolidation·무결성·래칫·UX 마감. **D-E1이 검증규율 A→A+ 복원**(§8.5.2) (D7-S2 삭제됨) |

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

## 8.5 ★ Round 2 통합 — 경쟁사 소스 재분석 (8-Haiku + Fable 재검증)

미-스윕 영역(eval 방법론·grounding 공정사냥·프라이버시 실구현·프로액티비티·RAG
내부·로컬모델 툴콜·config/온보딩·정체성+completeness critic)을 판 결과. **포지셔닝
3중 재검증(전부 유지, 정직 정정 1건) + 신규 슬라이스 1 + 정련 참조 + false-gap 3.**

### 8.5.1 포지셔닝 적대적 재검증 결과

- **프라이버시(로컬-우선) — 검증 통과 ✅✅.** 둘 다 로컬-only **강제 전무**(hermes
  config에 `redact_pii`만·`MUSE_LOCAL_ONLY` 등가물 0; openclaw도 클라우드-우선),
  메모리/트랜스크립트/시크릿 **평문 저장**, 개인 컨텍스트가 기본으로 클라우드 모델에
  주입. Muse의 fail-close egress 게이트는 **적대적 검증에서도 유일**.
- **grounding — 검증 통과 (정직 뉘앙스) ✅.** answer-verification 게이트·abstain·
  fabrication 측정 **여전히 0**. 단 공정하게: hermes에 **미머지** `feat/web-grounding-
  citations` 브랜치(프롬프트 수준 citation 지시, 게이트 아님), openclaw에 citation
  **표시**(`tools.citations.ts`, MEMORY.md#L5-L7 소스 위치)+untrusted-content 래핑
  (`external-content.ts`, 인젝션 방어 — **Muse도 escapeSystemPromptMarkers로 보유**).
  결론: 둘 다 citation 표시+인젝션 래핑은 있으나 **claim↔source 검증 게이트는 없음**.
  Muse 결정론 게이트는 무경쟁. (경쟁사가 프롬프트-citation으로 이동 중이므로 Muse는
  결정론 우위를 계속 벌려야 함.)
- **eval — 내 주장 정정(성적표 A+→A).** §2 참조. Muse의 pre-push fabrication
  tripwire는 유일 라이브 게이트지만 **로컬 Ollama 의존 + 집계 eval:agent는 CI
  미배선**. 경쟁사 대비 우위는 유지되나 "라이브 eval이 릴리스를 게이트"는
  **부분적으로만** 참. → 신규 슬라이스 D-E1.

### 8.5.2 신규 슬라이스

- **D-E1. eval 집계 게이트 실-강제 (M) ★.** 현 상태: `precheck:grounding`(fabrication
  subset)만 pre-push 훅. `eval:agent`(tool-selection·judge·adversarial·plan-quality·
  orchestration…)는 스크립트지만 자동 강제 없음. self-eval 회귀도 수동/루프-top.
  → (a) pre-push 훅을 **eval:agent 핵심 subset**까지 확장(Ollama 있을 때, 시간 예산
  내 — precheck-grounding처럼 skip-if-unreachable), (b) self-eval 회귀 fail-close를
  **커밋 시** 자동 확인(tracked count 하락→차단), (c) GitHub CI에는 Ollama 없으니
  **결정론 부분**(eval 하네스 자체 유닛, 스코어보드 파싱, 케이스 스키마)만 배선.
  **(d) Tier-0 오염 필터(Round3, openclaw character-eval 참조)**: 배터리 실행 전
  transcript에 "backend error"/"tool failed"/"model unsupported"/"timeout" 누출
  정규식 스캔 → 인프라 실패를 **behavior 실패로 오인 말고 배제**(현 skip-if-Ollama-
  unreachable보다 세밀). 이건 "검증 규율" 성적표를 A→A+로 되돌리는 유일한 실-작업.
  수용: 훅이 실제 차단함을 증명(나쁜 케이스 주입→push 거부)+Tier-0 오염 배제 유닛+
  skip-if-no-Ollama 계약.

### 8.5.3 정련된 참조 (기존 슬라이스 강화)

- **D4-S4 ← hermes 9-전략 fuzzy_match**(escape-drift 가드·indent 리페어). §6 D4-S4 갱신됨.
- **D1-S1 ← openclaw unknown-tool 감지**(`extractUnknownToolName` 정규식·
  UNKNOWN_TOOL_THRESHOLD 10·circuit-breaker 30). 존재하지-않는 툴 반복 호출 감지를
  ping-pong 슬라이스에 병합.

### 8.5.4 false-gap (Round2 — 짓지 말 것)

- **Ollama 스키마 새니타이제이션**: `sanitizeOllamaToolSchema`가 이미 존재
  (`adapter-ollama.ts:611`, sanitizeGeminiSchema의 Ollama 아날로그, :501 배선). 완비.
- **프롬프트 제어문자 strip**: `stripUntrustedTerminalChars`가 이미 전 untrusted
  진입점(active/ambient/attachment/episodic/inbox/skills/feeds)+`escapeSystemPromptMarkers`+
  `neutralizeInjectionSpans`(recall/present.ts)에 광범위 배선. 완비.
- **doctor fix-steps**: (Round1과 동일) 이미 "run `muse X`" 수리단계 반환.

### 8.5.5 선택적 향상 (저우선 — 별도 backlog, grounding 엣지 훼손 금지)

경쟁사에 있고 Muse에 없으나 코어 아님. 채택 시 반드시 grounding-surface·fabrication=0
불변 유지: (a) **HyDE**(가설-문서 확장 후 임베딩, openclaw qmd) — recall 향상 가능,
단 Muse RAG-Fusion과 중복 검토. (b) **concept-tag 파생 + 의미 dedup**(openclaw
short-term-promotion) — faceted recall. (c) **active-hours 이진탐색 seeking**(openclaw
heartbeat) — quiet-hours가 틱을 버리지 않고 다음 활성창으로 skip(현 Muse는 틱 버림).
(d) **config loud-fail**(openclaw 원칙: 파손 config→침묵 default 금지, doctor
migration으로 명시 복구; hermes 침묵-fallback은 안티패턴). Muse config 파싱실패가
loud한지 verify-first. (e) **HRR 조합 대수 검색**(hermes holographic) — 다중-엔티티
AND·모순탐지; Muse는 이미 contradiction-detection 보유라 ROI 낮음.

---

## 8.6 Round 3 통합 — 최종 스윕 (5-Haiku + Fable 재검증)

코어 잔여(eval 내부·도메인 액추에이터·내구성/마이그레이션·성능·전체 completeness
critic)를 판 최종 바퀴. **신규 실-슬라이스 1(D3-S7 안전) + 정련 2 + Muse 강점 3
확증 + 저가치 향상 다수.**

### 8.6.1 확증된 Muse 강점 (경쟁사 대비 앞섬 — 재구축·과투자 금지)

- **도메인 액추에이터 = 해자, 갭 아님.** Muse 캘린더/리마인더/연락처/홈은
  approval-gate(no-target 거부 포함)+id-idempotency(재-add→병합, 중복 0)+타임존
  **서버 위임**(phrase 그대로, DST 안전, local 표시)+soft-fail 미러(Apple Reminders
  실패해도 Muse write 성공)+구조화 에러(candidates 제시, 절대 추측 안 함)로 **두
  경쟁사보다 명백히 견고**(둘 다 메시징-중심, idempotency·approval·구조화 피드백 부재).
- **내구성 = 완비.** atomicWriteFile+부모dir fsync·withFileMutationQueue(파일별
  직렬화)·backupVersionMismatchedStore 전부 출하. D6-S3은 **JSON 유지**가 정답
  (SQLite 도입 불필요 — hermes WAL+fallback은 SQLite 쓸 때만). 잔여 소소: 암호화
  스토어가 **키-재암호화 마이그레이션 전 백업 미생성** → `.plaintext-backup-<ts>`
  권장(키 분실 복구용, D2 암호화 경로).
- **성능 기반 = 있음.** V8 컴파일캐시·prompt stablePrefix·keep-alive·KV-quant·
  working-budget 컴팩션 전부 보유. 하트비트 캐시-웜은 **클라우드 prompt-cache용**
  이라 로컬-우선 Muse엔 저가치(스킵).

### 8.6.2 정련 (기존 슬라이스 강화)

- **D-E1 ← Tier-0 오염 필터**(openclaw character-eval). §8.5.2 갱신됨.
- **D3-S3 ← poll-vs-consumed 이중 dedup**(hermes process_registry #3): 백그라운드
  프로세스 상태를 **poll(관찰)**한 것이 자율 완료-알림을 억제하면 안 됨(관찰≠소비).
  idle-drain 계약 테스트에 이 구분 추가.
- **D6-S3 ← hermes memory_tool drift+`.bak`**(#8): 재직렬화 round-trip 불일치→쓰기
  차단+백업이 정확한 참조 구현. §6 D6-S3 그대로 유효.

### 8.6.3 저가치 향상 (별도 backlog, 저우선 — grounding 엣지 훼손 금지)

completeness critic 10건 중 Muse-적합·미커버지만 코어 아님: (a) **orphaned-pipe
드레인**(hermes #5 — 자식 종료해도 손자가 파이프 열면 poll이 영원히 running; X-3
verify-first), (b) **connection-epoch 무효화**(openclaw #6 — 재연결 후 stale async
결과 폐기; 웹콘솔/SSE verify-first), (c) **request coalescing**(openclaw #1 — 동일
리소스 동시 fetch dedupe; 웹콘솔), (d) **parallel-tool-call 유도 프롬프트**+cold-start
poll 지수백오프(성능 소형). **이미-커버**: frozen-snapshot+live-mutation(#7 =
Muse chat-ink `memoryHolder`), external-drift(#8 = D6-S3). **skip**: watch-pattern
strike-window(Muse는 watch-pattern 미채택), device-fingerprint·idempotency-dual-key
(단일사용자 저가치).

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
| 13 | Muse pre-push fabrication tripwire 존재·CI 미배선 | ✅ `.git/hooks/pre-push`→`precheck:grounding`(`install-git-hooks.sh:46`); ci.yml=lint+lint:comments+check만(eval 호출 0) |
| 14 | 경쟁사 로컬-only 강제 부재 | ✅ hermes config `redact_pii`만·openclaw 클라우드-우선, 평문 저장(양 repo) |
| 15 | 경쟁사 grounding 게이트 부재(citation 표시만) | ✅ openclaw `tools.citations.ts`(표시)·`external-content.ts`(래핑); hermes citation 브랜치 미머지; 검증 게이트 0 |
| 16 | Ollama 스키마 새니타이저 존재 | ✅ `adapter-ollama.ts:611` sanitizeOllamaToolSchema(:501 배선) → 신규 아님 |
| 17 | 프롬프트 제어문자 strip 광범위 배선 | ✅ stripUntrustedTerminalChars 7+ 진입점·escapeSystemPromptMarkers(recall/present.ts:845) |
| 18 | X-3 kill/reconcile가 PID-재사용 미검증(안전갭) | ✅ `background-process-spawn.ts:104`(kill 무검증)·:128(isAlive만) → D3-S7 정당 |
| 19 | Muse 도메인 액추에이터가 경쟁사보다 견고 | ✅ approval-gate+id-idempotency+타임존서버위임+soft-fail미러(loopback-calendar/contacts/reminders 테스트) — 갭 아님 |
| 20 | Muse 내구성 완비(atomic+queue+backup) | ✅ atomic-file-store.ts(dir fsync)·withFileMutationQueue·store-version-backup.ts — D6-S3 JSON 유지 |
| 21 | eval Tier-0 오염필터 부재(D-E1 세부) | ✅ eval-harness.mjs에 인프라-오염 사전배제 없음 → D-E1 (d) 정당 |

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

---

## 10. ★ Fable 품질 판정 + 실행 체크리스트 (2026-07-11)

### 10.1 판정: 집행 가능한 계획서인가? — **YES, 3개 조건부**

**계획서로서 통과.** 근거: (a) 활성 34 슬라이스 전부 참조(reference)/현재(verified)/
구현(Muse-설계)/수용(게이트) 4요소 완비, (b) false-gap 5 삭제·정련 4로 no-op 제거,
(c) 하중-주장 21건 file:line 스팟체크(§9), (d) 웨이브 순서가 원칙갭→신뢰성→능력→
라우팅→마감으로 논리적, (e) 비협상(grounding·fabrication=0·벤더중립·fail-close)이
모든 슬라이스에 명시. Sonnet 워커가 §10.3 체크리스트로 바로 착수 가능.

**단, 3개 조건(착수 전 반드시 처리):**

1. **L-슬라이스 3개는 단일 커밋 불가 → 서브분할 필수.** D2-S1(seatbelt)·D1-S7
   (브라우저)·D6-S1(sleep)은 각 3-4 커밋. §10.3에 서브스텝으로 분해함. "L을 한
   번에"는 리뷰 불가·롤백 불가.
2. **verify-first 항목은 착수 전 §11 큐에서 먼저 해소.** "Muse 현재"는 2026-07-11
   스냅샷 — 병행 루프가 이동시켰을 수 있고, 일부는 배선점을 아직 특정 못 함
   (D3-S2 heartbeat 호출점, D5-S3 게이트 위치 등). 큐 항목이 열린 슬라이스는
   그 항목부터.
3. **오탐-리스크 슬라이스는 near-miss 쌍 테스트가 수용의 일부.** D2-S1(정당 명령
   차단)·D2-S2(정당 heredoc 차단)·D1-S1(정당 반복 차단)은 "막아야 할 것 차단 +
   막으면 안 되는 것 통과" 양면 테스트 없이는 미완. §10.3에 명시.

### 10.2 발견된 품질 이슈 + 처리 (Fable 리뷰)

| # | 이슈 | 심각도 | 처리 |
|---|---|---|---|
| Q1 | L-슬라이스 3개가 단일 커밋 크기 아님 | 높음 | §10.3에서 서브분할 |
| Q2 | 슬라이스 간 의존성이 웨이브에만 암묵 — 명시 필요 | 중 | §10.4 의존성 표 신설 |
| Q3 | verify-first 항목이 슬라이스 본문에 흩어짐 | 중 | §11 살아있는 큐로 집약 |
| Q4 | 일부 수용 기준이 정량 아님("성능 무해") | 낮 | §11-VQ에 벤치 임계 확정 항목 |
| Q5 | W4가 9슬라이스로 과적(W3=4) | 낮 | 대부분 S라 수용 — 필요시 W4를 W4a/W4b 분할 |
| Q6 | D3-S7이 W1인데 X-3 파일을 여기서 처음 염(D3-S1/S4는 W2) | 낮 | 안전-우선 순서가 우위 — 유지, 노트만 |
| Q7 | per-슬라이스 롤백/리스크 열 없음 | 중 | §10.3 각 항목에 리스크 태그 |

### 10.3 실행 체크리스트 (웨이브별 · 슬라이스별)

착수 규칙: 위→아래 순. 각 `[ ]`는 **1 커밋**(L의 서브스텝도 각 1 커밋). 모든
슬라이스 공통 게이트 = `test:changed` → mutation-RED → lint 0/0 → (에이전트-facing
이면 eval:tools/해당 배터리 STABLE 3/3, 요청경로면 smoke:live). ⚠=오탐리스크(near-miss
쌍 테스트 필수), 🔒=fail-close 안전 슬라이스, 📈=eval 래칫 동반.

#### W1 — 원칙 갭 (보안·루프이탈·PID)
- [x] **D2-S1a** ✅ 2026-07-11 seatbelt SBPL 프로파일 생성기(`build_seatbelt_profile`+`escape_sbpl_string`, 순수·미배선) — deny-default·file-read* broad·write는 cwd/$TMPDIR/pnpm·npm·cache만·network opt-in; 인젝션 이스케이프 Fable 검증. 26 test(12신규)·clippy clean. ⏭️b에서 배선
- [x] **D2-S1b** ✅ 2026-07-11 🔒 runner `MUSE_RUNNER_SANDBOX=seatbelt` 배선(`spawn_plan`→`sandbox-exec -p`) + 실프로세스 탈출 3종 계약 테스트(cwd밖 write·~/.ssh write·network fail-close + allowNetwork opt-in, 정당명령 git/sh/node 통과). 실기기 발견 2건 반영: ①프로파일 경로 **canonicalize 필수**(/var→/private/var 심링크, 미해결시 전면 거부) ②`/dev/null`+`/dev/dtracehelper` write-data allowance 없으면 git 전멸 → 추가(+`/private/tmp` subpath). 미설정 byte-identical(스폰플랜 passthrough+`sandboxWarning` skip-serialize), canonicalize 실패 fail-close. allowNetwork는 caller-only(모델 tool-args에서 차단, 네거티브 테스트). 38 rust test(계약4·mutation-RED 검증)·clippy clean·평가자 PASS(maker≠judge)
- [x] **D2-S1c** ✅ 2026-07-11 (S1b에 합류 배송) 비-macOS `RequestedUnsupported` 폴백(비샌드박스 실행+`sandboxWarning` 표면화, 유닛테스트) + `muse doctor` `runnerSandboxPostureCheck` 3-way(off/ok·darwin active/ok·비darwin warn)
- [x] **D2-S1d** ✅ 2026-07-11 📈 eval:adversarial에 결정론 sandbox-탈출 3종 추가(실 `muse-runner` 바이너리를 seatbelt로 spawn→OS 거부를 코드 채점, 모델 거부 아님 — agent-testing #5). cwd밖 write·~/.ssh write·network 탈출; network 케이스는 `accepted` 리스너 플래그로 채점해 guard-OFF(연결 성공)면 RED(curl exit≠0만으론 가짜 통과). Ollama 무관·macOS-only(스킵≠통과), LLM 16케이스 무수정. adversarialCases 16→19 래칫, node:test 뮤테이션 락 2/2, Opus 독립평가자 guard-ON/OFF 재현 PASS
- [x] **D2-S2a** ✅ 2026-07-11 🔒⚠ 순수 토폴로지 분류기 `classifyCommandTopology(command,args)`(packages/tools) — 비-셸 command는 항상 analyzable(near-miss: `echo '$(rm -rf /)'`·`node app '$(x)'`), 셸 `-c` 스크립트의 `$(`/백틱·`<(`/`>(`·`<<`·command-position `eval`을 quote-aware(단일따옴표=리터럴)로 감지→`{analyzable:false}`. 순수·미배선(D2-S1a 선례). Opus 평가자 1차 FAIL이 2 결함 적발→수리: ①개행이 POSIX 명령구분자인데 eval 감지서 누락(false neg) ②`$((` 산술을 command-sub로 오탐(false pos, `$((1+2))`); nested `$(( $(id) ))`는 여전히 검출. 22 test(우회/near-miss 쌍·mutation-RED 양방향)·Opus 재판정 PASS. sudo/env 래퍼 우회는 VQ-15
- [x] **D2-S2b** ✅ 2026-07-11 🔒 D2-S2a 분류기를 wired 승인 게이트 `chatToolApprovalGate`에 배선(apps/cli). 발견: trust.json은 아직 런타임 미배선(`commands-trust.ts` "follow-up")이고 run_command는 이미 execute라 항상 사람에게 물음 → "auto-approve서 강등"의 live seam 부재. 정직한 실질: ①un-analyzable `run_command`는 risk가 read로 위조돼도 **절대 조용히 허용 안 됨**(read fast-path에 `&& topology.analyzable` 게이트 — 토폴로지 우회 불가 코드 불변식) ②승인 프롬프트에 "검사 불가 셸 구성(construct)" 경고 표면화(informed consent, 정당 heredoc은 사람이 승인). 무조건 거부 아님. 135 test(우회불가 불변식·경고표면·arg-hostility·mutation-RED 양방향)·Opus 평가자 PASS. 미배선 auto-approve seam은 VQ-16
- [x] **D1-S1** ✅ 2026-07-11 ⚠ ping-pong 루프가드 `tool-loop-pingpong.ts`(agent-core) — A↔B 교대(2-값)를 trailing-alternation-run로 감지(창20·warn6·block10), 서명=name+stableJson(args)+결과(휘발필드 runId/tsIso/id/ts/timestamp 재귀 strip); block→`pingPongAbortedExecution`(post-compaction 미러, 양쪽 루프 배선). stall(A,A,A)·3-값 사이클·distinct 진행은 "none"(오탐 0). 19 test+model-loop 55·mutation-RED 양방향(교대조건·volatile strip)·Opus 평가자 PASS(임계 정확·false-positive 배터리·id-strip은 args 보존이라 안전). eval:computer-task는 ambient GEMINI_API_KEY 하이재킹(VQ-17)으로 local-forced 재실행
- [x] **D1-S2** ✅ 2026-07-11 post-compaction 루프가드(창3) — `PostCompactionLoopGuard`(arm on summaryInserted, tool+args+result 서명 3연속→abort); 15/15 유닛+wiring, mutation 5 RED, 독립평가자 PASS(arming=run당1회 아키텍처 확인). ⏭️후속: plan-execute-loop 미커버(별도 슬라이스)
- [x] **D2-S6a** ✅ 2026-07-11 승인 프롬프트 위험-토큰 하이라이트 — 순수 `identifyRiskyTokens`/`emphasizeRiskyTokens`(@muse/tools, DS-2 위험어휘 재사용: 파괴 플래그 -rf/--force·민감경로 //~/.ssh//etc//dev·파괴동사 rm/dd/mkfs at 명령위치)를 `chatToolApprovalGate` detail에 배선(summarizeToolArgs의 redact+strip 뒤에만 TRUSTED ANSI bold-red 적용). 안전명령·따옴표 속 rm은 미하이라이트(오탐0), non-overlap span·offset 정확·ReDoS cap. 13 test·mutation-RED 3-way·Opus 평가자 PASS. b(write-approval 스테이징)는 별도
- [x] **D2-S6b** ✅ 2026-07-11 write-approval 스테이징 — CLI fs-write 게이트(actuator-tools/commands-ask)의 비대화형 거부를 기존 `pending-approval-store`(@muse/messaging 재사용, 신규 스토어 0)에 스테이징(`recordPendingApproval`→`~/.muse/pending-approvals.json`, `muse approvals`가 읽는 동일 파일). no-external-effect 계약: 실 createFsWriteTool 구동 e2e에서 파일 미생성+entry round-trip(isPendingApproval 통과) 검증. staging 실패는 deny 불변(try/catch), 대화형 승인경로 미영향. 29 test·mutation-RED 양방향·Opus 평가자 PASS(messaging/src 미수정 확인). CLI-write 재실행(content) 미배선=VQ-18
- [x] **D3-S7** ✅ 2026-07-11 🔒 X-3 PID-재사용 kill 가드 — background-process record에 `osStartTime`(spawn 시 OS start-time 캡처, 주입식 reader) 추가, 순수 `pidIdentityMatches`(레거시=unset→검증불가 보존, set이면 현재값과 equality). `stopBackgroundProcess`/`reconcileBackgroundProcesses` kill/reconcile 전 대조 — 불일치(재사용/소멸)면 kill 금지+record `exited`(fail-close, 신규 결과 `pid_reused`). CLI가 `ps -o lstart= -p`로 배선(BSD+GNU, /proc 회피, 실기기 검증). 13 재사용-시뮬 유닛·mutation-RED 양방향·Opus 평가자 PASS(messaging 0편집·env 0). **W1(원칙 갭) 완주**

#### W2 — 신뢰성 (컴팩션·예산·서브에이전트·브라우저)
- [x] **D1-S3** ✅ 2026-07-11 단계적 요약 — `summarizeDroppedContextInStages`+`chunkDroppedOnToolPairs`(@muse/memory, 순수): dropped를 tool-pair 경계로 청크(`role:"tool"` 앞 분할 절대금지, 오버사이즈 pair는 1청크)→청크별 summarizeDroppedContext 재사용(각 FAIL-OPEN, fallback:"")→비어있지않은 것만 병합·maxChars 캡. **부분실패=생존청크 보존**, 전실패=결정론 floor. 기존 `summarizeDroppedContext` byte-identical(additions-only). 식별자-보존 지시(UUID/경로/URL/숫자 VERBATIM)를 SUMMARIZER_SYSTEM_PROMPT에 명문화(grounding 강화). agent-runtime:578+chat-ink-core:941 양쪽 배선(1청크=단일샷 등가). 18 test(경계·부분실패·단일청크등가·mutation-RED 양방향)·Opus 평가자 PASS
- [x] **D1-S5a** ✅ 2026-07-11 예산 소진 명시(침묵중단 금지) — 도구 예산 소진(toolCallCount≥maxToolCalls) 시 최종 합성 전에 "N/M 툴콜 소진, 최선의 최종답 지금" one-shot notice를 messages에 주입(proactive: 빈-도구 호출 前, budget에만·wallclock/stall 제외 엄격 게이트). 순수 `budgetExhaustionNotice`+`BudgetExhaustionTracker`(REVERIFY_NUDGE 패턴), 양쪽 루프. 정상종료·stall·wallclock은 미주입. maxToolCalls=10 불변. 62 test·mutation-RED(게이트제거→정상종료 오탐 RED, injection제거→미주입 RED)·Opus 평가자 PASS(설계편차 proactive 정당·기존 테스트 tightening 확인)
- [x] **D1-S5b1** ✅ 2026-07-11 PTC 플랜스텝 계상 규칙 명문화(프로그래매틱=1) — run_tool_plan 1콜=1 예산슬롯(내부 N스텝 무관)이 이미 동작이나 암묵적 → agent-runtime PTC 인터셉트에 WHY주석 + 회귀락 테스트(3스텝 플랜 실행됨=effects[a,b,c] ∧ 예산 1슬롯=toolsUsed["run_tool_plan"]). 계상 동작 무변경(주석+테스트만). mutation-RED(스텝을 각 예산으로 세면 toolsUsed 길이3 RED)·Opus 평가자 PASS(행동락·주석정확성 확인). 유저-가시 변화 없어 CHANGELOG 생략
- [x] **D1-S5b2** ✅ 2026-07-11 서브에이전트 별도 하위예산 — 순수 `resolveSubAgentToolBudget(부모)`(@muse/multi-agent: max(3, floor(부모×0.5)), uncapped→5·워커는 항상 cap) + ask-decompose 워커 execute에 배선(부모 metadata.maxTools 그대로 상속 대신 sub-budget shallow-override, args.metadata 무mutation). synthesize/planner는 부모예산 유지(lead-level). 6+23 test·mutation-RED 양방향·Opus PASS. 형제-감사: orchestrator.ts/commands-board는 서버측·maxTools 관례 부재로 backlog follow-up 기록. **D1-S5 완료(b1+b2)**
- [x] **D3-S1a** ✅ 2026-07-11 서브에이전트 depth 강등 — AgentTask에 옵셔널 `depth`(부모0·서브 depth+1, omit-when-0), `resolveBoardMaxDepth(env)`(`MUSE_BOARD_MAX_DEPTH` 기본1·floor1), `expandTaskIntoSubtasks(...,maxDepth=1)`가 `(parent.depth??0)>=maxDepth`면 no-op(무한 재분해 차단; verify-first로 서브태스크 재-expand 가능 확인됨). back-compat(depth無=0·기존 no-op 가드 유지·maxDepth1도 첫 분해는 허용). CLI board expand 배선. 34 test(깊이경계 depth==maxDepth·parent+1·파싱테이블)·mutation-RED 양방향·Opus PASS. ENV.md 갱신
- [x] **D3-S1b** ✅ 2026-07-11 부모 tool-deny 상속 — 순수 `inheritParentToolDeny(parent,child)`(@muse/multi-agent: child⊆parent 교집합, child가 부모에 없는 도구 요청시 드롭, parent unrestricted면 child 유지) + ask-decompose 워커 execute에 구조적 클램프 배선(worker allowedToolNames = 부모 교집합, args.metadata 무mutation, planner/synthesize 미클램프). 8+2 test·mutation-RED 양방향(강등제거→c 유출 RED). Opus PASS+유의미성 판정: 순수불변식은 진짜, 클램프가 실 enforcement point 사전배치=defense-in-depth. ⚠caveat: 현 프로덕션 호출자는 broader set 미전달이라 프로덕션 no-op(테스트-seam으로 검증), 유저-가시 변화 0→CHANGELOG 생략. 형제: orchestrator verbatim·board top-level→backlog follow-up. **D3-S1 완료(a+b)**
- [x] **D3-S2** ✅ 2026-07-11 단일-run heartbeat 배선 — `ModelLoopRunner.heartbeat?`+`AgentRuntimeOptions.heartbeat` 주입 seam(agent-core는 multi-agent 미의존), model-loop 3 emission point(streamModelTurn text-delta·tool-call + runToolBatch genuine-exec만, progress/failureStreak와 동일 gating)에서 `emitHeartbeat`(try/catch, throw가 루프 안 깸). 신규 감지기 0(기존 detectStalled 재사용). 미배선시 byte-identical. 4+2 test(emission spy·fake-clock 스테일 감지[400ms heartbeat=비오탐, 침묵 150ms>timeout=감지])·mutation-RED 양방향·Opus PASS(deferral 정당 판정). ⚠DEFERRED=라이브 SubAgentRunRegistry 피딩(autoconfigure→multi-agent 의존 or apps/api 생성순서 재배치 = 아키텍처 결정)+stall-abort 폴러 → backlog. 유저-가시 변화 0
- [x] **D3-S4a** ✅ 2026-07-11 job 동시상한 — `muse job run`(백그라운드)이 무제한 spawn(verify-first)이던 걸 cap(`MUSE_JOBS_MAX_CONCURRENT` 기본3·≥1)으로. 순수 `resolveJobsMaxConcurrent`+`jobConcurrencyRefusal(runningCount,cap, >=cap 거부)` + `countRunningJobs`(기존 jobSummary 재사용, running만) + `startBackgroundJobOrRefuse` 배선(at-cap→stderr 명시거부+exitCode1, start 미호출; inline 무변경). 27 test(파싱·실 jsonl fixture·at-cap spy 미호출)·mutation-RED 양방향·Opus PASS. ENV.md 갱신
- [x] **D3-S4b** ✅ 2026-07-11 부모-헤드룸 요약예산 — 순수 `perChildSynthesisBudget(headroom,n)=max(2000,floor(headroom×0.5/n))`(div0/NaN/Inf/neg→floor2000) + `budgetAndSpillOutputs`(초과 자식 truncate + FULL 원본을 `~/.muse/board-spill/<taskid>-<i>.txt`로 스필[writeSpill 주입], 세그먼트에 정확한 경로 명시) + makeAgentExecutor 배선(실 fs, 답변에 스필 위치 note). boardTaskPrompt 순수 유지. `resolveBoardSynthesisHeadroom`(MUSE_BOARD_SYNTHESIS_HEADROOM 기본24000)·`boardSpillDir`(MUSE_BOARD_SPILL_DIR). 41 test(예산경계·round-trip 스필===원본·실fs 왕복)·mutation-RED 양방향(truncate제거·writeSpill스킵)·Opus PASS(데이터손실 없음 확인). ENV.md 갱신. **D3-S4 완료(a+b)**
- [x] **D1-S7a** ✅ 2026-07-11 🔒 refs는 이미 숫자 인덱스(0-based)+CSS셀렉터 모델노출 없음 → (a)의 "숫자 인덱스" 요건 기충족. 델타="refs 안정성 유닛": `resolveTarget`(browser-tools.ts) 숫자-ref 분기가 현재 스냅샷에 없는 ref(stale/ghost/환각)를 그대로 통과시켜 유령 요소로 행동하던 구멍을 fail-close로 닫음 — `describeElement(ref)`=undefined면 "call browser_read" 거부(부분 부작용 0). resolveTarget이 click/hover/type/upload 단일 해소점이라 형제 4개 일괄. 3 행동테스트(valid proceed·ghost click 거부·ghost type 거부, calls 무기록 어서)·mutation-RED 양방향(가드제거→2 RED, Opus 독립 재현)·포맷 무변경(bare numeric 유지→eval 계약 무손상). `@e` 문자열포맷·DOM stale-attr 클리어(실브라우저)는 유닛범위 밖(→VQ-19)
- [ ] **D1-S7b** step-budget+timeout 주입(actions_used N/M 표기) + 소진 유닛
- [ ] **D1-S7c** pending dialog을 스냅샷 필드로+auto-dismiss
- [ ] **D1-S7d** 🔒 page 콘텐츠 `<page>` 래핑+미디어지시 defang(인젝션 계약) + 실 e2e (→ VQ-10)

#### W3 — 능력·UX
- [ ] **D4-S4** 📈 file_edit 결정론 리페어(hermes 9-전략 fuzzy 참조·escape-drift·indent) + eval:computer-task +10%p pass^3
- [ ] **D4-S1** 📈 `muse mcp serve` 확대(read 다수+write draft-first 프록시+grounded-recall 노출) + groundedSurfaces 35→36
- [ ] **D4-S2a** macOS Photos 검색/내보내기(M)
- [ ] **D4-S2b** macOS 앱종료(S) · **D4-S2c** 다크모드(S) · **D4-S2d** 밝기/블루투스(S, Shortcuts) — 각 mac_system_set enum 확장+eval 케이스
- [ ] **D4-S2e** Apple 연락처 '쓰기'(draft-first 게이트)
- [ ] **D7-S1** 슬래시 명령 단일소스 레지스트리(chat-ink+CLI 공유) + 중복제거 증명

#### W4 — 라우팅·KO
- [ ] **D5-S1** privacy routing follow-ups(context-free 툴=로컬 명문화·KO 소유격 토큰·setup 안내) + 기존 20 계약 무수정
- [ ] **D5-S2** `resolveAuxiliaryModel(task,env)` 통합 리졸버(하위호환·local-only 게이트 통과)
- [ ] **D5-S3** canUseNativeTools 死코드→실게이트 배선(toolCalling=false→텍스트 프로토콜/명시에러) (→ VQ-2 배선점)
- [ ] **D5-S4** 명시적 `MUSE_MODEL_FALLBACKS` 체인(게이트 통과·발생 표기·미설정 byte-identical)
- [ ] **D1-S6** 턴-내 one-shot 회복 상태 통합(동작불변 리팩터)
- [ ] **D2-S3** 난독화 해제 확장(NFKC/ANSI/홈경로접기 中 실부재분만 — VQ-3 먼저)
- [ ] **D2-S4** runner stdout→모델 시크릿 마스킹(VQ-4로 미배선 확인 후) + 성능 벤치(VQ 임계)
- [ ] **D2-S5** calendar 스토어 암호화(reflections 템플릿 재사용) + 라운드트립 3종
- [ ] **D-KO-S1** ★ truncateUtf16Safe 추출 + 미안전 3곳 배선(history-search:206/213·tool-def-helpers:108·knowledge-corpus:365) (→ VQ-6 TTS)

#### W5 — 기억·마감
- [ ] **D-E1** 📈 eval 집계 실-강제(pre-push subset 확장·self-eval 커밋훅·CI 결정론분·Tier-0 오염필터) + 훅 실차단 증명 (→ VQ-12 시간예산)
- [ ] **D6-S1a** sleep-consolidation 결정론 승격 스코어(재-recall·distinct질의·반감기, LLM없음) + 유닛
- [ ] **D6-S1b** 승격을 draft 제안(proactive 카드)+**자동쓰기-없음 계약**(mutation)
- [ ] **D6-S1c** 데몬 배선(opt-in) + loop-v2 Sleep 정합
- [ ] **D6-S2** 연료 파이프라인(browsing auto-sync·recap 연결·주간 real-miss 리포트) — attended
- [ ] **D6-S3** 메모리 drift 감지(round-trip 해시→차단+.bak, JSON 유지) (→ VQ-7 시나리오)
- [ ] **D6-S4** provenance 태그(foreground vs 자율)+자율-삭제-금지 계약
- [ ] **D3-S3** 완료-이벤트 idle-drain 계약 핀(poll≠consumed 구분)
- [ ] **D3-S6** 📈 eval:orchestration 래칫(D3-S1/S2/S4 케이스·MAST 2+) pass^3
- [ ] **D2-S7** 📈 eval:adversarial 16→24+(sandbox탈출3·토폴로지3·난독화2, 결정론 가드 검증)
- [ ] **D7-S3** 스마트-테일 터미널 출력(웹콘솔) + 실브라우저 측정
- [ ] **D7-S4** desktop 반응성(경과타이머·상태반응) — attended

#### 이연 (착수 전 진안 확인)
- [ ] **D-KO-S3** i18n 정적 카탈로그 중앙화 (저우선·리팩터 리스크>이득 가능)
- [ ] **암호화 key-migration 백업** `.plaintext-backup-<ts>` (§8.6.1, 소소)

### 10.4 슬라이스 의존성 (착수 전 확인)

- **D2-S7**(adversarial 확대)은 D2-S1d·S2·S3의 케이스가 입력 → 그 슬라이스들 **후**.
- **D3-S6**(orchestration 래칫)은 D3-S1/S2/S4 완료 후.
- **D-E1**(a)는 `eval:agent` 존재 전제(✓ 있음) + 다른 eval 슬라이스가 케이스 공급.
- **D4-S1**(grounded-recall 노출)은 `streamGroundedRecall` seam 전제(✓ 있음).
- **D2-S6b**·**D6-S3**·**D-KO-S1**·**D5-S3**은 기존 심볼 재사용 → §11 VQ에서 배선점 확정 후.
- 나머지는 상호 독립(웨이브 내 순서 무관).

---

## 11. 🔍 추가 검증 필요 — 살아있는 큐 (append-only)

> **규칙**: 슬라이스 착수 전 해당 VQ를 먼저 해소(codegraph/Read/실측). 해소되면
> `[x]` + 한 줄 결론. **새 검증 필요 항목은 이 섹션 맨 아래에 계속 추가**(날짜+출처).
> 이 큐가 비면 계획의 불확실성이 0 — 그 전까지 열린 VQ가 있는 슬라이스는 그 VQ부터.

### 착수-차단 VQ (해당 슬라이스 전 필수) — ★ 2026-07-11 전량 해소 (Fable codegraph/read)
- [x] **VQ-1** (D3-S2) ✅ **배선점 = `model-loop.ts` 스트리밍 루프**: `tool-call-started`/
  `tool-call-finished` 이벤트 처리부(:802) + text-delta에서 `heartbeat(runId)` 호출.
  `runToolBatch`(:263)/`for await`(:787)가 단일 run의 툴 진행 지점. orchestrator:347은 그대로.
- [x] **VQ-2** (D5-S3) ⚠ **텍스트-프로토콜 자체가 없음**: `canUseNativeTools`(index.ts:292)는
  정의만·호출 0(死코드), **텍스트 툴 파서/폴백도 미구현**(parseTextToolCall 등 부재).
  → 계약("불가시 텍스트 프로토콜")은 게이트도 폴백도 없음. **슬라이스 재범위**: gemma4는
  toolCalling=true라 실사용 무영향 → D5-S3 = **명시적 "이 모델은 툴콜 불가" 에러로 게이트**
  (조용한 실패 제거), 완전 텍스트 프로토콜은 별도 L로 이연(BYO 비-툴 클라우드 쓸 때만 필요).
- [x] **VQ-3** (D2-S3) ✅ **실부재분 = NFKC + ANSI-strip만**: `dangerous-command.ts`에
  comment-strip·$IFS·라인연속·echo치환 있고, **홈경로(`~`/`$HOME`)는 이미 RULES 패턴에
  내장**(:65/74/83). → D2-S3 = NFKC 유니코드 정규화 + ANSI 이스케이프 strip **2개만** 추가.
- [x] **VQ-4** (D2-S4) ✅ **미배선 확정**: `runner.ts:88-100`가 stdout/stderr를 cap만 하고
  **redact 없이 반환**(:97-100 반환 객체 raw). D2-S4 정당 — 반환 직전 redactSecretsInText 통과.
- [x] **VQ-5** (D4-S3) ✅ **범위 확정**: `--with-tools`는 commands-ask.ts:609/635/726에서
  자체 actuators+agentRuntime 분기, plain 경로만 `streamGroundedRecall`(:49) 사용. →
  seam에 **prepare-only 변형**(컨텍스트+allowed-citations+게이트 반환, 생성 안 함) 신설 후
  --with-tools가 그걸 쓰고 자기 agentRuntime 구동. M 규모 유지(스트리밍 이벤트는 불필요 —
  게이트만 공유).
- [x] **VQ-6** (D-KO-S1) ✅ **미안전 확정 — TTS는 4번째 사이트**: `tts-truncate.ts:19/28`이
  raw `slice(0, maxChars)`·`slice(0, cut)` — surrogate 가드 0. → D-KO-S1 배선 대상 **4곳**
  (history-search:206/213·tool-def-helpers:108·knowledge-corpus:365 + **tts-truncate:19/28**).
- [x] **VQ-7** (D6-S3) ✅ **cross-process 락 이미 있음 → 슬라이스 재범위**: 메모리 스토어는
  `withFileLock`(cross-process `.lock`, encrypted-file.ts:113)을 write마다 사용
  (memory-user-store-file.ts:248/260/383/402 `serializeWrite→withFileLock`). → Muse 자체
  writer 간 clobber는 **이미 방지됨**. drift의 실-갭은 **외부 편집**(수동 편집·patch 툴·
  다른 도구 append — 락 미경유)뿐. D6-S3 = 외부 수정 round-trip 해시 감지(defense-in-depth,
  hermes memory_tool 정확히 이 케이스). 범위 축소·정당성 유지.
- [x] **VQ-8** (D3-S7) ✅ **이식 방법**: `ps -o lstart= -p <pid>`가 macOS(BSD)+Linux(GNU)
  둘 다 지원 → 이식 가능. spawn 시점 캡처해 record에 저장, kill/reconcile 전 재조회 대조.
  `/proc` 의존 회피(Linux-only). 불일치→kill 금지.
- [x] **VQ-9** (D2-S1) ✅ **allow-list 근거 확보**: 정당 명령이 cwd 밖 정당하게 쓰는 경로 =
  `$TMPDIR`(`/var/folders/.../T/`)·`~/Library/pnpm/store`·`~/.npm`·`~/.cache`(read/write) +
  `~/.gitconfig`·`~/.config/git`(read). seatbelt 프로파일 allow = **cwd 서브트리 + $TMPDIR
  (rw) + 위 캐시/config (캐시 rw·config ro)**. 이 목록으로 git/pnpm/tsc/node 오탐 회피.
- [x] **VQ-10** (D1-S7) ✅ **e2e 하네스 부재 확정**: browser 관련 e2e 테스트 파일 없음
  (grep 0). D1-S7d는 실 detached-Chrome 구동 테스트를 **신규 작성** 필요(슬라이스에 반영됨).
- [x] **VQ-12** (D-E1) ✅ **시간예산 확보**: precheck-grounding은 이미 배터리당 240s +
  skip-on-timeout(REPEAT 기본1). push가 수 분을 이미 허용 → eval:agent subset을 **같은
  per-battery 240s+skip 가드**로 추가, 총 push < ~5분 유지. 헤드룸 있음.

### 정량-확정 VQ (수용 기준의 숫자 채우기)
- [ ] **VQ-Q1** (D2-S4) 시크릿 마스킹 "성능 무해"의 실측 임계 — 대형 stdout(10MB cap)에서 redact 추가 지연 ms 상한 확정.
- [ ] **VQ-Q2** (D1-S1) ping-pong 창/임계(창20·warn6·block10)를 gemma4 실 트레이스로 재보정 — 제안값이 정당 반복(재시도 루프)을 오탐하는지 실측.
- [ ] **VQ-Q3** (D6-S1) sleep-consolidation 승격 스코어 임계(반감기·min-recall) — Muse ~/.muse 실데이터 기근 상태에서 의미있는 값인지(연료 VQ-7과 연동).

### 저가치·조건부 VQ (필요성부터 판정)
- [ ] **VQ-11** orphaned-pipe 드레인(X-3) — Muse detached-node spawn이 손자-파이프 hang에 실제 취약한지. 취약하면 슬라이스 승격, 아니면 폐기.
- [ ] **VQ-13** connection-epoch 무효화(웹콘솔/SSE) — 재연결 후 stale 결과 적용 레이스가 Muse 웹콘솔에 실재하는지. 실재만 슬라이스화.
- [ ] **VQ-14** request coalescing(웹콘솔 동시 fetch) — 단일사용자라 동시성 낮음, 실측 후 판정.

### 전략-레벨 오픈 질문 (진안 결정)
- [ ] **VQ-S1** eval 성적표 A→A+ 복원은 D-E1 하나에 달림 — GitHub CI에 로컬 Ollama가 없어 "라이브 게이트"는 구조적으로 pre-push 로컬 훅에 머문다. 클라우드 러너에 self-hosted Ollama를 붙일지(비용/복잡도) vs 로컬-훅으로 충분하다 볼지.
- [ ] **VQ-S2** D6(sleep-consolidation)은 연료(~/.muse 실데이터) 없이는 실효 0 — 연료 확보(D6-S2, 실사용)가 D6-S1보다 먼저여야 하는지 순서 재고.
- [ ] **VQ-S3** W4 과적(9슬라이스) — W4a(라우팅 D5)·W4b(보안마감 D2-S3/S4/S5+KO)로 분할할지.
- [ ] **VQ-19** (D1-S7a/D1-S7d) 브라우저 ref numeric-index 충돌 — refs는 스냅샷마다 0-based 재할당이고 `data-muse-ref` DOM 속성이 이전 스냅샷에서 안 지워짐. 페이지가 바뀌어 새 요소가 옛 index `3`을 물려받으면(또는 stale 속성이 남으면) 옛 `3`이 *다른* 요소로 해소될 수 있음. D1-S7a의 tool-boundary 가드는 현재 스냅샷에 없는 ref만 막지, 같은 번호가 *다른* 요소로 살아있는 경우는 못 막음 — `captureSnapshot` 시작에서 stale `data-muse-ref` 클리어(또는 generation-scoped ref) 필요, 실브라우저 e2e로 검증(D1-S7d 인접). Muse가 실제로 이 충돌에 취약한지 확인 후 슬라이스화. — 2026-07-11 D1-S7a Opus 평가자 발견
- [ ] **VQ-18** (D2-S6b) CLI fs-write 스테이징 entry는 `{path,action}`만 담아(FsWriteDraft가 content 미보유) `muse approvals approve` 재실행 불가 — 채널 경로처럼 full-args 재실행 라운드트립을 CLI에 완성하려면 게이트에 원본 쓰기 args를 스레드해야(현재는 리뷰 가능한 worklist item까지). — 2026-07-11 D2-S6b 발견
- [ ] **VQ-17** (D-E1/eval infra) `eval:computer-task`(및 다른 "LOCAL OLLAMA ONLY" 배터리?)가 로컬 모델을 강제하지 않아, ambient `GEMINI_API_KEY`가 있으면 `resolveDefaultModel`이 클라우드로 라우팅→Gemini API 에러로 죽음(정책 위반). eval 스크립트가 `MUSE_LOCAL_ONLY=true` 또는 `MUSE_DEFAULT_MODEL=ollama/…`를 명시 강제해야. testing.md의 "cloud APIs never used" 계약과 어긋남. — 2026-07-11 D1-S1 발견
- [ ] **VQ-16** (D2-S2b) auto-approve seam 부재 — `classifyCommandTopology` 강등의 완전한 형태(자동승인을 명시승인으로)는 트리거할 auto-approve 경로가 없어 미실증: trust.json(`muse trust`)은 런타임 미배선, 채널(Telegram/Slack) 경로가 execute를 무인 실행하는지 미확인. trust.json 배선 또는 채널 auto-approve 시 반드시 topology를 consult해 un-analyzable을 fail-closed. — 2026-07-11 D2-S2b 발견
- [ ] **VQ-15** (D2-S2a/b) 셸 래퍼 우회 — `classifyCommandTopology`는 `command`가 직접 셸(sh/bash/…)일 때만 판정하므로 `sudo sh -c '$(x)'`·`env X=y bash -c '…'`는 program이 sudo/env로 풀려 미검출(analyzable=true). DS-2는 CMD_START로 sudo/env 래퍼를 이미 처리 — D2-S2b 배선 시 래퍼를 벗겨 실 program을 해석하거나, 별도 형제 슬라이스로 승격할지. — 2026-07-11 D2-S2a Opus 평가자 발견

<!-- 새 VQ는 이 줄 위에 "- [ ] **VQ-N** (슬라이스) 내용 — 발견 날짜/출처" 형식으로 추가 -->
