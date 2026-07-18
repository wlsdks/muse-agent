# Muse dev backlog — the living ledger

  - USER-SIM FUEL (2026-07-12, Haiku 페르소나 3종 × 실파이프라인 시뮬레이션 -> Opus 아티팩트-우선 교차감사; 도구 scripts/channel-sim.mjs; 상세 감사는 세션 기록):
- [done] prio=5 :: false-done 리마인더 — fix-wave (요일·절대날짜 룰 + 미예약 시 결정론 정직 caveat; 라이브 재프로브로 8/5 followup 실생성 확인)
- [done] prio=5 :: 자모 인사 오라우팅 — fix-wave (HANGUL_RE 자모 블록 + ㅎㅇ/ㅂㅂ/ㄱㅅ 패턴; ㅎㅇ->casual 3ms 재확인)
- [done] prio=5 :: 호칭 접미사 — fix-wave (VOCATIVE_SUFFIX 3패턴 공통; 고마워 뮤즈->4ms canned)
- [done] prio=5 :: 장문 기억요청 팩트 유실 — fix-wave (결정론 팩트 백스톱, 순자 케이스 rescue pin)
  - · [MED] 채널 주간집계가 schedule/tasks 스토어 미참조(userModel.schedule 항상 빈 배열 — 채널 풀런이 일정성 발화를 영속화 안 함).
- [done] prio=3 :: 레지스터 불일치 — fix-wave (기존 detectKoreanRegister 재사용, ack+chat 프롬프트에 미러 라인)
- [done] prio=1 :: 휘발성 사실·미요청 self-followup — fix-wave (ephemeral 가드 + korean-* commissive 게이트 봉쇄)
  - · ephemeral 가드 고유명사 오탐 — "오늘의집"/"내일배움카드"류 고유명사 value가 시효성으로 오분류돼 durable 승격 거부됨(LOW-MODERATE); 토큰 뒤 시간표현 동반 요구로 정밀화 (fix-wave 판정자 후속).
- [done] :: 백스톱 날짜 캘린더 검증 — 다음달 31일->4월 31일류 불가능 날짜 durable 저장 차단(drop-not-guess, N1 판정자 REQUIRED 트윅; 검출기 buildValid 선례 미러).
  - · 시뮬 인프라 개선 — per-turn route+reply 풀 로그 캡처(스레드 12msg 캡이 감사 증거를 자름); 페르소나-로테이션 시뮬 루프는 진안 지시 시 등록.
- [done] prio=5 :: N1 — 예약 성공이 모델 복창 코인플립이었던 문제(follow-up-capture-hook이 response.output만 스캔) 해소: `inbound-agent-run.ts`가 rememberIntent 턴마다 `extractFollowupPromises(latestUserText, {requireCommissive:false})`로 유저 원문에서 직접 추출 + `upsertFollowup`으로 결정론 예약(agentRuntime.run() 이후, 캐비엇 체크 이전 — before/after 카운트가 신규 followup을 자연히 인식). 어시스턴트 자기복창이 같은 분(minute)에 이미 예약했으면 스토어 재조회로 중복 스킵(hook 자체엔 across-call dedup 없음을 확인 후 채택한 설계). 성공 시 코드 부착 확인 에코(" M월 D일 알림 잡아뒀어" / EN "Reminder set for …") — persisted followup의 resolved 날짜에서만 생성, 모델 텍스트 아님. 캐비엇은 유저측 추출도 실패했을 때만.
- [done] prio=3 :: N1b — 반복 요청("매일 아침 8시", "수요일마다 6시")이 잘못된 1회성으로 캡처되던 문제: `followup-detector.ts`에 매일|매주|매달|…마다 recurrence-marker 가드 추가, 같은 문장에서 마커가 발견되면 해당 시간 매치 전체를 드롭(완전한 반복지원은 큐로 이관 — 잘못된 1회 예약보다 무예약이 낫다는 판단). 정상 캐비엇으로 대체.
- [done] prio=3 :: N5b — daughter_birthday 등 백스톱 팩트가 "다음달 N일" 상대표현 그대로 저장되어 스테일해지던 문제: `memory-fact-backstop.ts`가 추출 시점(anchor=now)에 절대 "M월 N일"로 해석 후 저장("N월 N일" 형은 이미 절대라 그대로 통과, 해석 실패시만 원문 유지).
  - · [MED->백로그] 완전한 반복 리마인더 지원 — N1b는 스코프상 반복을 완전히 SUPPRESS만 함(무예약 + 정직 캐비엇); "매일/매주/매달/N요일마다" 실제 반복 스케줄 자체는 미착수 — followups 스토어에 recurrence rule 필드 + firing daemon 재스케줄 로직 필요.
  - · [LOW] N3b — 레지스터(존댓말/반말) 판정 로직의 register 문자열 typo (wave-2 감사 발견, 정확 위치·재현은 감사 세션 기록 참조 — 이번 슬라이스 미착수, 사용자 체감 영향 낮음으로 판단해 큐 이관).
  - · [LOW] N5a — 메모리 팩트 백스톱이 노이즈성("junk") 팩트를 승격시키는 케이스 (wave-2 감사 발견, 재현 상세는 감사 세션 기록) — 이번 슬라이스 미착수, 패턴 정밀화 필요.
  - · [LOW] N5c — false-done 캐비엇 중복 트리거 가능 엣지 (wave-2 감사 발견, 재현 상세는 감사 세션 기록) — 이번 슬라이스 미착수; N1 도입으로 return 경로가 단일화돼 재현 여부 재확인 필요.

  - RESPONSE-EXPERIENCE (2026-07-12, 진안 직접 요청 — 20m 자율루프 `response-experience`의 전용 큐; 어시스턴트 응답 경험을 계속 더 좋게. 기반: 채널 대화 리듬(잡담 fast-path·복창 ack·인용 완료보고)·개입 예산+다이제스트·원터치 veto, 전부 main 머지됨):
- [done] :: 캔드 casual 응답 한국어 패리티 — response-experience fire 1 (CASUAL_RESPONSES_KO + containsHangul, CLI·채널 양표면)
- [done] :: 프로액티브 알림 근거 한 줄 — pattern-firing 몫: `pattern-detector.ts`의 `buildMatch`/`buildWeeklyTaskMatch`가 이미 근거절을 결정론으로 내장(`(N edits across M days)` / `(N times across M weeks)`, bucket.matches/distinctDays·distinctWeeks에서 verbatim 도출, 모델 호출 없음) — response-experience fire 2에서 확인, mutation-first pin 테스트로 못박음(packages/memory/test/pattern-detector.test.ts 2개 + packages/proactivity/test/pattern-firing-compose.test.ts 1개 강화). ambient/commitment는 미착수 — 아래 두 줄로 이관.
- [done] :: 프로액티브 알림 근거 한 줄 — ambient 몫 — response-experience fire 4 (매칭 [field,pattern] verbatim 절, knowledge-trigger는 의도적 무절)
- [done] :: 프로액티브 알림 근거 한 줄 — commitment-checkin 몫 — response-experience fire 5 (createdAt->due 기준 결정론 나이 절; 근거 3부작 pattern·ambient·commitment 완성)
- [done] :: 체크인 나이 절을 절대 날짜로 — response-experience fire 7 (지연-불변 절대날짜, 이전-연도 pin, staleness 클래스 제거)
- [done] :: pattern 알림 LLM-합성(Phase-D) 경로 근거 절 보존 — response-experience fire 13 (post-compose 결정론 가드: 카운트 미포함 합성문에 fallback 절 verbatim 부착)
- [done] :: 위임 ack 중복 억제 — response-experience fire 3 (ackAlreadySent 사이드카, at-most-once delivered ack)
- [done] :: digest 라인 injection-span 중화 — 조사 결과 5개 unasked 루프 중 pattern-firing(match.suggestion ← note/task 시그널 verbatim), commitment-checkin(title=checkin.commitment ← 유저 발화 커밋먼트), ambient-notice(knowledge-trigger enrich() ← 지식corpus 라인)가 USER-STORED 텍스트를 큐에 verbatim 적재함을 확인(ambient rule.message 자체는 소유자설정이나 enrich() 결과는 아님) — B1 "이미 게이트 통과"는 fabrication 불변식이지 injection 불변식이 아니었음. 컴파일 시점(`formatDigestItemLine`, packages/proactivity/digest-flush.ts — flush와 `muse digest list` 양쪽이 공유하는 단일 렌더 시임)에 recap.ts와 동일 조합(`escapeSystemPromptMarkers(neutralizeInjectionSpans(text))`)을 적용; 큐 저장은 verbatim 유지(감사용). 순수 헬퍼 `escapeSystemPromptMarkers`/`stripGroundingFences`/`sanitizeFenceLabel`을 `@muse/recall`에서 `@muse/agent-core`로 이관(이미 거기 있던 `neutralizeInjectionSpans`와 합류 — proactivity가 recall의 무거운 문서파서 의존 없이 재사용 가능; recall은 재-export로 기존 호출부 무변경) + proactivity package.json/tsconfig 참조 추가. **FOLLOW-UP COMPLETE (2026-07-18):** 확인된 direct-send 잔여 중 pattern-firing(합성/fallback과 digested live broker 포함), commitment-checkin, ambient-notice(stateful rule+enrich, standalone knowledge, legacy tick)의 즉시 전달 `text`에만 같은 중화 조합을 적용했다. 원본 저장 텍스트와 digest queue는 여전히 verbatim이고 digest 렌더가 큐 출력의 유일 중화 시임이며, titles·IDs·policy·state transitions·retries·locks·budgets는 미변경이다. 즉 저장 재작성이나 모든 proactivity input의 trust를 주장하지 않는다. 원 digest slice 테스트: proactivity(`digest-flush.test.ts` +5) + cli(`commands-digest.test.ts` +1) + agent-core(이관된 `prompt-escape.test.ts` 6개, 위치만 이동). RED->GREEN mutation-first 확인, 빌드+lint 그린; direct-send follow-up은 해당 공개 루프 테스트와 raw-vs-delivery 불변식으로 검증.
- [done] :: digest-sent cross-process 레이스 완화 — response-experience fire 10 (withDigestLock: O_EXCL+nonce+no-spin, mark-after-send 유지, 두-데몬 시뮬레이션 pin)
- [done] :: 리마인더 이중 전송 레이스 — response-experience fire 11: `digest-lock.ts`를 일반화(`withProcessLock(lockPath, fn, staleMs?)`가 신규 코어, `withDigestLock`은 그 위 얇은 래퍼로 fire-10 호출부/테스트 무변경 additive) + `runDueReminders`의 select->send->mark 전체를 `${file}.firing.lock`(api·cli 데몬이 동일하게 도출하는 그 reminders 파일 경로) 하에서 실행하도록 재구성(내부 `runDueRemindersUnderLock`). lock-held는 `{delivered:0, due:0, errors:[], fired:[], outcome:"lock-held"}`(신규 optional 필드, 기존 호출부 전부 무변경 — 로그 게이트가 delivered>0∥errors.length>0/due>0라 자연히 무소음), 락 획득 자체 실패는 fail-open(잠금 없이 fn 실행 + lockError 프리픽스 에러). 테스트: `packages/proactivity/test/reminder-firing-lock.test.ts`(신규 5개 — 두-데몬 동시경쟁 delivered=1 총계 확인, 성공/실패 후 락 해제, stale 락 breaking, live 락 short-circuit). RED(cp-backup 원본 복원) 확인 시 3/5 FAIL(경쟁·stale·live), 픽스 복원 후 5/5 GREEN. 호출부 감사: `reminder-tick.ts`(api)·`commands-remind.ts`·`commands-daemon-register.ts`(cli)·`mcp.test.ts` 전부 새 optional `outcome` 필드에 안전(toMatchObject 또는 미참조). 빌드(stores/proactivity/api/cli)+`test:changed --uncommitted`+lint 전부 그린.
- [done] :: 체크인 이중 전송 레이스 — response-experience fire 12 (withProcessLock 채택, 두-데몬 시뮬레이션 pin)
- [done] :: 이중 전송 레이스 전량 봉합 — big-turn (followup:14, objectives:15, pattern·proactive-notices: big-turn B) — withProcessLock 템플릿 7/7 사이트 완성; 잔여는 background-exit(CLI 단일 콜러, 구조적 레이스 불가 판정)뿐
  - · background-exit 잠재 레이스 — 현재 cli 단일 콜러 + mark-before-send 관례(크래시 시 드롭 위험)라 우선순위 낮음; api 콜러 추가 시 같은 클래스 합류 (fire 12 스윕 노트).
- [done] :: withProcessLock 하트비트 횡단 보강 — response-experience fire 17 (staleMs/3 mtime 하트비트+foreign-nonce 가드, 6개 락 사이트 전부 상속)
- [done] :: 채널 대화형 fast-path — big-turn A: classifyChannelIntent 3중 게이트(위임신호0+대화신호1+·80자↓, 회상-의문형은 위임 강제 — 판정자 적대 프로브 27입력 누수 0) -> composeChatReply 단일 추론(PASS 센티널·인용 거부·15s·fail-open->풀 파이프라인) -> 인용-스트립 백스톱 게이트(한계 정직 문서화+BOUNDARY pin); 순서 pairing->approval->veto->casual->CHAT->ack->run; eval:channel-rhythm 20/20 ×3; MUSE_CHANNEL_CHAT 기본 on.
- [done] :: 잡담 개인화+스냅샷 grounding — deep-turn: loadChatPersonaSnapshot(owner-1:1 전용, 공유챗 봉인, ≤10줄·중화·fail-open) -> chat 프롬프트+게이트 evidence 동시 주입; 인젝션 프로브 8종 중화 확인; eval 개인화 3케이스 pass^3. 한계 정직 명세: 게이트는 인용-기반만(무인용 발명은 여전히 통과 — no-facts 프롬프트+보수 분류기가 실방어).
- [done] :: eval 개인화 KO 양성 케이스 취약 — 순수 잡담형으로 교체(동일 슬라이스)
- [done] :: 라이브 배터리 부하-강건화 — eval-harness 공유 시임: 인프라-null/transport-throw 1회 재시도+`infra-* (2x)` 라벨+flake 카운트 라인(9개 배터리 전부 혜택, semantic 실패는 무재시도 — 판정자 확인 "FAIL을 PASS로 못 뒤집음"); 발굴 보너스: throw된 timeout이 무라벨 semantic으로 위장하던 2차 갭 봉합
- [done] :: digest-lock EACCES 코너 — response-experience fire 19 (stat-프로브: exists->contended[win32 보존], ENOENT/stat-err->fail-open; 드릴 스펙 1:1)
- [done] :: ack 카피/톤 개선 — response-experience fire 16 (관측-진단 기반 프롬프트 재작성: 격식 preamble 금지·동일언어 마무리 약속, 판별력 검증된 token-set 스코어러 pin)

- [open] 2026-07-18 kind=fix src=probe prio=3 for=improve-muse :: builder 코파일럿 — 빈 create 패널을 수동으로 연 뒤 첫 요청 시 blank form이 revision currentDraft로 투영돼 400("currentDraft.name must be a non-empty string"). 픽스 방향: 폼이 비어있으면(이름/프롬프트 공백) currentDraft 생략(fresh 턴) 또는 서버가 blank-draft를 fresh로 강등. 발견: builder-evolution fire 16 라이브 e2e.
- [open] 2026-06-29 :: COMPETITOR-PARITY loop (2026-06-29, Jinan: study openclaw + hermes, fill Muse's gaps in BIG chunks). Journal deleted 2026-07-18 (loop closed; git history). Candidate · gaps (each fire VERIFIES vs Muse first — freshness guard — then reimplements the pattern, MIT/Apache-attributed, NO verbatim copy): plugin-SDK/extension-contract (openclaw plugin-sdk) · context-compression depth (hermes context_engine.py) · A2A/ACP interop depth (openclaw acp-core). Big-chunk units (a capability + tests + wiring + docs together), not single slices.

- [rejected] :: **B3** multi-agent on a single GPU is a *phantom* (no true parallelism) — a hardware
 limit; the value is context-isolation+decomposition, already built. Not code-fixable.
- [rejected] :: **B5** local-12B one-shot tool-calling has load-amplified flakiness (eval:tools ~99%,
 KO followup.cancel / time_diff) — a model-capacity limit the deterministic harness
 mitigates but can't erase. Not code-fixable on a fixed model.
- [decision] :: **A2** reranker (Qwen3-Reranker-0.6B candidate, KO-MTEB-strong) — a real stretch but
 needs a model pull + an A/B eval proving the delta; human-gated (model choice).
- [decision] :: **A3** generic graph DSL + automatic full-state durability/time-travel (langgraph-style)
 — low priority for a single-user local agent (no arbitrary multi-agent topologies).
- [decision] :: **A4** async-announce non-polling sub-agent completion — deferred, low value on one GPU.

The one remaining FRONTIER (open, hard, high-value): full **source VERACITY** (GROUNDED≠TRUE)
— impossible to fully solve under local-first (no external oracle); A1 corroboration is the
realistic partial hedge. Deeper veracity needs a human/product call, not an autonomous slice.

- [open] 2026-07-02 :: chat REPL(Ink) ESC->AbortController 배선 — DS-1(8ccf4b92) 잔여 (상세: backlog-archive.md delta-scout 2026-07-02)
- [open] 2026-07-17 kind=fix src=probe prio=2 for=improve-muse :: 크로스링구얼 인용정밀 false-flag — EN 답변이 KO 노트를 인용하면(또는 역) lexical coverage가 번역을 못 봐 경고 발화(라이브 재현; KO-KO 교착어미 클래스는 stem-prefix로 해결됨). 임베딩/의미 기반 support 판정 필요 — 문장별 embed 레이턴시 트레이드오프 설계 포함.
- [open] 2026-07-17 kind=fix src=probe prio=3 for=improve-muse :: 한국어 인용정밀 검사 false-flag — citation-precision(lexical token coverage 0.5)이 한국어 교착어미를 못 맞춰("주문하고" vs "주문,") KO 답변+KO 노트의 올바른 패러프레이즈 인용에 경고 발화(라이브 재현). 한국어 토큰 정규화(어간/조사 스트립) 또는 임베딩-지원 support 판정 필요.
- [open] 2026-07-17 kind=test src=audit prio=3 for=improve-muse :: eval:knows-me 배터리 미구현 — 구 LEARNING-LOOP-PLAN.md(2026-07-18 삭제, git history) §D의 유일한 미출하 항목(knowsMeRepeatFree/Delta/Prospective; "Muse가 나를 배웠나"를 측정하는 게이트). 레포 전체에 심볼 0건, 이 레코드가 유일한 추적점 (2026-07-17 md 전수조사에서 발굴).

## Open — [scout 2026-07-17] rival hardening tricks (->improve-muse)

- [open] :: config-plane credential-egress audit (->improve-muse): hermes blocked cron `base_url` overrides that exfiltrated provider credentials (v0.18.0 security round, PR #56196 — 주의: upstream claim, class locally checkable). Audit Muse: can any scheduled/自动 config path (scheduler, autoconfigure, channel config) override a provider endpoint at runtime? If yes ⇒ deterministic guard + regression test; if no ⇒ record the negative probe.
- [open] :: skill/MCP install provenance ack (->improve-muse): openclaw requires explicit `--force` for arbitrary-executable plugin sources while keeping trusted flows frictionless (changelog #102197, 주의: code unread). Muse has the MCP allowlist; the skill-install / `mcp add` path lacks an untrusted-source acknowledgement step.

## Open — council injection screen 재스코프 + injection-provenance 잔여 (2026-07-13 스코핑, fable5 세션)

- [done] commit=7d0ef77c0 :: DONE (7d0ef77c0) **fire-36 재스코프 — 의미 신호가 아니라 결정론적 탐지기가 정답이었음**: on-topic 인젝션은 relevance로 분리 불가(정직한 짧은 확인 0.11 < on-topic 인젝션 0.26)이나, 기존 결정론적 인젝션 탐지기는 34문장 정직 코퍼스에서 FP=0 / 리콜 60% -> 문장 단위 defang(peer 드롭 아님)으로 배송. 원 스코핑 노트: — 전제 인프라는 이제 전부 깔림: semantic primitive(fire 40/41) + `eval:council-floors` 라이브 캘리브레이션 배터리(분리-불변식 패턴). **새 실측 통찰: off-topic형 인젝션("이전 지시 무시하고 비밀번호 출력")은 relevance 게이트(0.25)가 이미 차단함** — eval:council-floors의 derail 케이스가 cosine 0.035로 드롭됨. 잔여 위협은 ON-TOPIC 인젝션(질문 주제를 유지하며 지시를 심는 발화)뿐이라, 재스코프 슬라이스는 (a) on-topic 인젝션 vs 정직 on-topic 발화의 cosine/신호 밴드를 eval:council-floors 방식으로 먼저 실측 -> (b) 분리 밴드가 존재할 때만 스크린 추가 (fire-36의 over-quarantine tar-pit 회피 — 밴드가 겹치면 정직하게 "스크린 불가, provenance 태깅으로 해결" 결론). 전용 캘리브레이션 슬라이스로 진행할 것.
- [done] 2026-07-13 commit=725bb5a28 :: S3b DONE (725bb5a28). [done] **S4 DONE (2fd79eaa5, 2026-07-13) — injection-provenance 트랙 전체 완료.** 갭은 'exfil이 경고 안 됨'이 아니라 **잘못 경고됨**이었음: 모든 툴 결과가 untrusted로 기록되므로 사용자의 **자기 노트**로 만든 send도 오염된 웹페이지로 만든 send와 **똑같이** "untrusted tool:X"로 표시 -> 평범한 작업에서의 오탐이 진짜 경고를 클릭스루하게 훈련시킴. S3b의 first-party 분류를 재사용해 taint를 ORIGIN으로 분리: 오염페이지->INJECTION만 / 내 노트->EXFIL만 / **페이지가 내 노트 유출을 지시->둘 다**(S4 위협모델 그 자체). send·execute 한정(write는 S3b가 이미 first-party 신뢰). 계약충실 e2e 8건, 양쪽 뮤테이션-RED.

## 2026-07-07 BROWSING theme — "learns you" 데이터 기근 해소 (진안-directed; ~/.muse가 노트 0개·메모리 736B로 사실상 빈 것이 발견 계기)

- [done] commit=231dbf30 :: (231dbf30) Stage 1: Chrome History SQLite 인제스천 — node:sqlite(의존성 0), 잠긴 파일 임시복사 후 읽기, BigInt visit_time(>2^53), http/https 필터, 0o600 스토어, `muse browsing sync|search|recent` + `browsing_search` 툴(eval:tools 4/4 STABLE 3/3). 명시적 sync가 곧 동의 — 데몬은 Chrome 파일 절대 안 읽음. 실 프로필 1985방문 라이브 검증, 독립평가 7/7 PASS. ToS/정책 검토 완료(문제없음 — Firefox import 선례, 평문 파일, 암호화 우회 없음).
- [done] commit=41b03ac8 :: (41b03ac8) Stage 2: ask grounded-recall 통합 — 12번째 인용 마커 `[browsing: <hostname>]`(exact-match, false-KEEP 불가), CJK-aware 렉시컬 선택, feeds와 바이트 동일 인젝션 이스케이프, untrustedBrowsingMatch(trusted:false) ask+verdict 양경로, 영수증. gemma4 라이브 라운드트립 빌더+평가자 이중 검증. groundedSurfaces 플로어 유지(30).
- [done] commit=2d4d490d :: (2d4d490d) Stage 3a: 데몬 opt-in 자동 sync — MUSE_BROWSING_AUTO_SYNC(기본 off), 60분 스로틀, sync 코어 @muse/recall로 추출(커맨드/데몬 공유). consent pin(기본값에서 Chrome 접근 0회, 스파이 seam=프로덕션 경로) 뮤테이션 검증. 독립평가 7/7 PASS.
- [done] commit=39fd8506 :: (39fd8506) Stage 3b: cross-lingual 임베딩 recall — sync 시 타이틀 임베딩(v2-moe, search_query:/search_document: 프리픽스 필수), 하이브리드 선택(렉시컬∪코사인≥0.18), KO질의->EN타이틀 라이브 STABLE 3/3 + negative A/B 증명. merge-clobber 리스크 평가자 조사로 반증(strict cursor + 병합후 재임베딩). fail-soft 전방위.
- [done] commit=b28511d6 :: (b28511d6) Stage 4: feeds cross-lingual — 인제스트 시 타이틀 임베딩 + recency 베이스 위 rescue 암(렉시컬∪코사인≥0.18, no-vec ⇒ 바이트 동일 회귀핀), 쿼리 임베딩 ask당 1회 feeds/browsing 공유. RSS 특유 merge-clobber(매 refresh 동일 id 재수신 -> 임베딩 전멸 위험)를 title-동일 캐리포워드로 해소(5×-refresh 안정성 핀, 뮤테이션 RED 확인). KO질의->윈도우 밖 EN 헤드라인 `[feed:]` 인용 라이브 STABLE 2/2 + negative A/B. 독립평가 8/8 PASS.
- [done] commit=644fc899 :: (644fc899) Stage 5: verify-browsing-recall(4케이스) + verify-feed-crosslingual(3케이스, negative A/B 영구화) 라이브 배터리 — 실제 파이프라인(진짜 builder/normalizer/게이트) 구동, pass^4(빌더 3/3 + 평가자 1회), groundedSurfaces 래칫 30->32. 독립평가 7/7 PASS.
- [open] :: 잔여 후보: 스토어 sidecar 분리 검토(browsing ~21MB@2000 — 커지면); `--json` grounded 블록 패리티(feeds/browsing 둘 다 빠짐) [decision]진안 결정; 브라우징/피드 테마 -> proactive/recap 연결("요즘 X 많이 보시네요").
- [done] commit=50b0a319 :: (50b0a319) (1) vision 한글 커버리지 — 측정이 가설을 뒤집음: gemma4 6/6+5/5(한글 전승) vs qwen3-vl 4/6(이벤트 스키마 빈출력, 한영 공통 3/3) -> **기본값 유지**, 한글 픽스처 2종 영구 게이트화 + MUSE_VISION_MODEL 노브(fail-soft) 배송. 생태계 리서치도 수렴(openclaw 로컬 기본값=gemma4, /v1 경로 툴콜링 열화 경고 -> Ollama 네이티브 유지 확정). qwen3.5는 Ollama mmproj/툴콜 템플릿 성숙 시 재평가.
  - NEXT-THEME 후보 (2026-07-07 갭스카우트, 상세는 세션 보고): (2) iMessage chat.db 인제스천([decision]진안 이연 — 재제안 금지, 진안이 다시 열 때까지); [done](3) 한국어 voice 기본값 — DONE(4c06b3cf, v0.2.15); [done] 온보딩 데이터 위저드 — DONE(abc4da38, v0.2.17): muse setup data, 동의 기본 NO+뮤테이션 핀, MUSE_* 하이드레이션 부재 확인 후 export 블록 방식(정직), 온보딩 힌트 연결; (4) macOS 연락처 임포트 + 온보딩 임포트 위저드(S); [done](5) 캘린더 쓰기 — **CONVERGED/이미 전량 배송** (2026-07-07 검증: 전 provider createEvent + CLI add/edit/delete + muse.calendar.add 게이트 + eval 13/13 pass^3 한국어 포함 + deny-무효과 계약테스트 — 갭스카우트가 낡은 "read-only" 문자열에 속음, cee1459d로 문자열만 수정. 재제안 금지); (6) 프라이버시-계층 클라우드 라우팅(개인 컨텍스트 주입 ask는 무조건 로컬, 무주입 일반 질문만 옵트인 클라우드 — ask-tier-models 인프라 재사용).

## macOS 커버리지 맵 (2026-07-07 스카우트, 진안 directive "맥에서 왠만한 건 다 되게 — 정책 안에서")

스코어보드: 비서-관련 26개 능력 중 **보유 16 / 빌드가능 7 / 정책제외·이연 3**. 정책 필터 실코드 확인: osascript Apple-Events 자동화 허용(퍼베이시브 사용 중), Tier-3 제외 = System Events 키입력/클릭 퍼페티어링만(읽기는 허용), 쓰기는 MUSE_MACOS_ACTUATORS 게이트.

빌드가능 순위(비서 가치순): [done](1) Apple Reminders — 진안 결정 "Muse 스토어+Apple 미러(단방향)"로 해소(068d2c70, v0.2.13): MUSE_APPLE_REMINDERS_MIRROR opt-in, 모델-facing 툴 신설 없음(혼동쌍 0), 인젝션 5-페이로드 뮤테이션 검증, 3개 생성 지점 훅(이중발사 없음 감사), fail-soft. Notes 미러도 같은 패턴 적용 예정 [done](2) Apple Notes 미러 — DONE(f80090c1, v0.2.14): 의도적 생성만 미러(ingest/일일인박스/append/overwrite 제외 — Notes.app 스팸 방지), 2층 이스케이프(HTML+AppleScript) 각각 뮤테이션 검증, recall 코퍼스 바이트 불변 증명, 기존 AppleNotesProvider와 이중쓰기 없음 평가자 추적. 주의:후속: 실기기에서 `<br>` 렌더 확인 1회 필요(Automation 권한 필요라 자동화 불가) [done](3) Focus/DND — DONE(0e259570, v0.2.15): mac_system_set enum 확장(신규 툴 없음), Shortcuts 키스톤, KO 로케일 실캡처 기반 미존재 감지+셋업 안내, eval 48/48 pass^3(볼륨 confusable 포함), doctor 체크. 한국어 voice 기본값도 동시 배송(4c06b3cf — 다국어 whisper 기본+레거시 폴백, KSS 라이선스 명문화, doctor 가이드) [done](4) Apple 연락처 임포트 — DONE(0477d981, v0.2.16): C0 구분자 페이로드(주입면 0), split-before-strip, 가산적 병합(사용자 필드 불변, 멱등), 연도없는 생일->실 resolveUpcomingBirthdays 통합테스트, TCC fail-soft 라이브 증명. 잔여: Apple 연락처 '추가'(쓰기)는 별도 미착수 (5) Photos 검색/내보내기(M) (6) 앱 종료(S) (7) 다크모드(S, 스크립팅 프로퍼티라 Tier-3 아님) (8) 밝기/블루투스(S, Shortcuts).

정책제외 명문화(재검토 방지): AirDrop 전송(공식 경로 없음->Tier-3 필요->제외) · 임의 앱 UI 퍼페티어링(Tier-3) · 자율 발송(draft-first만) · banking(영구) · brew 임의 설치(runner 경유 필수). 이연: iMessage 읽기(진안 결정, FDA 필요).

## capability-parity — hermes/openclaw 대비 순수 에이전트 역량 갭 (2026-06-23 gap-scout, 코드레벨 비교)

Theme: Muse를 hermes/openclaw 급 peer로. grounding/local 해자는 floor로 유지하고, 둘 다 가졌는데 Muse가 얇거나 없는 **순수 에이전트 역량 4개**를 결정론-우선으로 메운다. (소스: /Users/jinan/ai/hermes-agent, /Users/jinan/ai/openclaw 코드레벨 인벤토리.)

> **경쟁사 teardown (그들이 실제로 뭘 하는지)**: [`competitor-teardown.md`](competitor-teardown.md) — 2026-06-23 **20-테마 exhaustive 소스 분석 + completeness critic**이 openclaw/hermes를 **실제 420개 distinct 파일 열어** 작동방식을 해부 (260 capability, 테마별 비교 teardown + 아키텍처 cross-cutting 8 + critic이 놓칠 뻔한 역량 10). "외부 경쟁사가 뭘 하는지" 이해용.
>
> **전체 기회 카탈로그 (231개)**: [`growth-backlog.md`](growth-backlog.md) — 위 teardown에서 도출한 Muse 개발 기회. 모든 근거 파일경로 경쟁사 레포 실재 기계검증(폐기 0), 참조-전용 + Muse 자체 구현방식 + verify 게이트. 아래 Gap 1–4는 1차 착수 완료 슬라이스, 나머지는 카탈로그에서 우선순위로 픽.
>
> **Muse-적합 심사 (231개 독립판정)**: [`judgment-lens.md`](judgment-lens.md) — build 121 / maybe 59 / skip 51 (off-strategy 50 = 멀티테넌트·클라우드·채널스프롤은 단일사용자 로컬 Muse에 부적합). 빌드 착수는 여기 build·core·strengthens 항목부터.

### [done] 빌드 착수 — capability-parity build (build 큐에서 순차 진행)

- [done] :: **결정론적 tool-result 요약을 truncation 마커에 적재** (CMP: deterministic pre-LLM tool-result summarization) — `d6ffa8997`. 잘린 도구결과가 `[truncated …]` 대신 코드유도 1줄 요약(`terminal: exit 0 · 120 lines`, `search: 37 results`)을 보여줌 -> "shows its work" 강화. `@muse/memory` 순수함수 `summarizeToolResult`(토큰단위 분류) + `capToolOutput` 배선; 12 unit + 2 wiring 테스트, mutation-verified, lint 0. hermes `context_compressor.py` 패턴 참조-전용.
- [done] :: **envelope-aware 토큰 카운팅** (CMP: envelope-aware token budget) — `b5aad64e4`. `estimateMessageTokens`가 병렬 tool 호출 N개를 message overhead 1개로 과소계상하던 버그 수정 — tool 호출/결과마다 wire-envelope 8토큰 부과 -> 멀티툴 턴 예산 정직 계상, 트림 적기 발동(silent overflow 방지). 매직버짓 테스트 1개 재교정(97->113=trio 실제크기) + delta 테스트 2개; mutation-verified; @muse/memory 599 + @muse/agent-core 2623 green, lint 0. hermes `context_compressor.py` 참조-전용.
- [done] :: **결정론적 에러 분류기 + 기본 retry 정책** (REL: error taxonomy) — `751dbe68a`. `classifyError`가 임의 에러를 회복-관련 분류(auth/rate_limit/overloaded/server_error/timeout/network/context_overflow/content_policy/model_not_found/bad_request/unknown) + recovery hints로 결정론 매핑(HTTP status+메시지 패턴, LLM/IO 없음). `retry()` 기본정책으로 배선 -> 명백 영구에러는 즉시 fail-fast(전엔 전 attempt 소진), transient/unknown은 retryable 유지(기존 동작 보존), 명시적 retryable은 override. 12+2 테스트, mutation-verified; @muse/resilience 38 + agent-core 2623 + scheduler 91 + autoconfigure 632 green, lint 0. hermes `error_classifier.py` 참조-전용.
  - [skipped] **skill curator 라이프사이클** — already-covered: @muse/skills `authored-skill-store.ts`가 이미 lastUsedAt·quarantine·auto-archive(stale)·cap-by-archiving·restore 보유 -> no-op 회피, 빌드 안 함.
- [done] :: **컴팩션 시 stale 인라인 이미지 스트립** (CMP-2: media stripping) — `b83dac2a7`. 비전 턴의 multi-MB base64 이미지가 매 턴 재전송되던 문제(추정기 카운트도 안 됨) — `stripStaleImageAttachments`가 마지막 user 메시지 이전 턴의 인라인 이미지 바이트를 제거하고 `[image omitted: <mime> ~<KB>]` 플레이스홀더로 대체(현재 턴 이미지·URL ref은 보존). `trimConversationMessages` 구조 pre-pass로 배선(매 호출, boundary-integrity처럼), no-op 시 원본 반환. 5 테스트, mutation-verified; @muse/memory 604 + agent-core 2623 green, lint 0. openclaw/hermes 참조-전용.
  - [skipped] **추가 already-covered 확인**: tool-call 정확서명 dedup(`ToolCallDeduplicator` 보유, mutation-safe), dangerous-path/secret-file(`fs-path-safety.ts`), secret/PII redaction(`@muse/policy`), 모순탐지(`agent-core/contradiction-detection.ts`), leading think-strip(`provider-shared.ts`, 의도적 leading-only) -> no-op 회피.
- [done] :: **classifier가 중첩 provider 에러 unwrap** (REL-10: nested-metadata extraction) — `1f041825e`. classifyError가 top-level `.message`만 봐서 래핑된 에러(OpenRouter `metadata.raw`=상류 에러 JSON 문자열, OpenAI `{error:{message}}`)의 실제 원인을 못 봄 -> 래핑된 rate-limit/context-overflow가 `unknown` 오분류. `extractMessage`가 중첩 에러 텍스트도 surface(join)해 reason 패턴이 진짜 에러를 매칭. 비중첩은 byte-identical. 4 테스트, mutation-verified; @muse/resilience 58 + agent-core 2630 green, lint 0. hermes 참조-전용. (BYO-cloud 경로 가치; local Ollama는 비중첩이라 무영향.)
- [done] :: **누출된 grounding-fence를 답변 출력에서 스크럽** (MEM-1: streaming context-fence scrub) — `f057851af`. gemma4가 프롬프트의 grounding 블록 fence(`<<memory N>>`·`<<note>>`·`<<end>>`)를 답변에 ECHO하면 내부 recall 비계가 유저에게 노출됨(스트리밍 citation 게이트는 `[from]`/`[memory:]` 영수증만 스크럽, `<<…>>` 경계는 안 함). `stripGroundingFences`(결정론 출력위생, 프롬프트 아닌 코드; 정밀 문법으로 `1 << 2`·`cout << note`·`<<TODO>>`는 보존) 추가 + `muse ask` 스트림표시·버퍼답변(citation 게이트 전) 양쪽 배선 -> 누출 fence가 터미널/히스토리/episodic에 안 남음. 5 테스트, mutation-verified; @muse/recall 500 + @muse/cli 3003 + byte-hygiene 45 green, lint 0. hermes 참조-전용.
- [done] :: **aux-model 압축 코어 프리미티브** (CMP-2 core) — `8aa3117e4`. 컴팩션 요약은 결정론(`[Key details]` salient facts)이 FLOOR. CMP-2는 드롭된 메시지를 값싼 aux 모델(2차 로컬 Ollama)이 요약하는 옵션 레이어 추가. 이번엔 model-AGNOSTIC 코어 프리미티브 `summarizeDroppedContext(dropped, summarizer, {fallback, maxChars})` 출하 — summarizer 주입식(벤더 SDK 미참조), throw/empty/무-summarizer/무-drop 전부 결정론 fallback으로 FAIL-OPEN(CMP-1 원칙, 컴팩션 절대 안 멈춤). [skipped] 런타임 배선(sync prepareModelRequest 컴팩션 지점에 async aux 호출)은 다음 슬라이스(의도적, hot-path async 리팩터). 6 테스트, mutation-verified; @muse/memory 617 + byte-hygiene 45 green, lint 0. hermes 참조-전용.
- [done] :: **트리머가 compacted-away 메시지 노출** (CMP-2 enabler) — `e1a0c73c8`. CMP-2 aux 요약은 드롭된 메시지가 필요하나 trim은 `removedCount`만 보고해 호출부가 다중-pass trim 너머로 dropped를 재유도해야 했음(취약). `ConversationTrimResult.dropped`(입력 중 retained 집합에 없는 메시지, 참조-동등 diff; kept-but-repaired는 포함될 수 있으나 요약엔 무해) 추가, 컴팩션 없으면 빈 배열. -> summarizeDroppedContext를 런타임에 배선할 때 호출부가 diff 재구성 불필요. additive(기존 소비자 무영향, agent-core 2630 green). 2 테스트, mutation-verified(predicate 반전->RED); @muse/memory 619 + byte-hygiene 45 green, lint 0.
- [done] :: **CMP-2 런타임 배선 (CMP-2 COMPLETE)** — `75760bec1`. 프리미티브+dropped-노출을 런타임이 실제 사용. opt-in `AgentRuntimeOptions.contextSummarizer`(+`contextSummaryMaxChars` 기본 600): 컴팩션 발생 턴(summaryInserted)에 드롭된 메시지를 주입 aux 모델이 요약->`augmentCompactionSummary`가 결정론 `[Conversation summary …]` 블록에 `[Dropped-context summary: …]`로 APPEND(결정론 [Key details] floor 보존, aux는 라벨된 추가분). 비협상 준수: model-AGNOSTIC(summarizer 주입), FAIL-OPEN(empty/error->결정론 요약 그대로), OPT-IN(미설정->aux 호출 없음->기존 2630 테스트 byte-identical). 5 테스트(3 pure + 2 wired-integration through AgentRuntime.run w/ capturing provider), mutation-verified(helper append 제거->pure+wired RED); @muse/agent-core 2635 + byte-hygiene 45 green, lint 0. [skipped] CLI/서버가 로컬 Ollama aux summarizer를 주입하면 실사용 활성화(어댑터 wiring은 후속).
- [done] :: **CMP-2 실사용 활성화 (assembled runtime, opt-in) — CMP-2 전부 완료** — `8ac5a49fb`. `createModelDroppedContextSummarizer`(Muse `ModelProvider` 추상->`DroppedContextSummarizer`, 같은 로컬모델 2차 호출로 드롭된 턴 요약)를 autoconfigure가 `MUSE_AUX_COMPACTION` 켜질 때 런타임 contextSummarizer로 주입. 기본 OFF(컴팩션 턴 추가 호출 지연). 비협상: model-AGNOSTIC(팩토리가 ModelProvider 받음, 벤더 SDK 아님; CLI가 로컬 Ollama 주입), fail-open은 summarizeDroppedContext에(provider throw->결정론 fallback), opt-in default-off->autoconfigure 632 무변. 3 팩토리 테스트, mutation-verified(transcript 제거->RED); @muse/agent-core 2638 + @muse/autoconfigure 632 + byte-hygiene 45 green, lint 0. **CMP-2 4슬라이스 完: 프리미티브+dropped노출+런타임배선+활성화.**
- [done] :: **run_command 파국 명령 fail-close 가드** (TX-6, Muse식=거부) — `0f56a84c3`. run_command는 risk:execute(승인 게이트)지만 auto-approve/자율 모드가 게이트를 우회할 수 있고, 일부 명령은 비가역이라 모델 판단만으로 절대 실행 불가여야 함. `classifyDangerousCommand`가 좁고 명확한 파국 집합(루트/홈/루트글롭 재귀삭제·fork bomb·raw-device dd/redirect·mkfs·wipefs)을 결정론 탐지, `parseRunnerCommandRequest`가 runner 호출 전에 코드에서 거부(fail-close, "가드는 결정론 코드"). 오탐 방지로 범위 타이트: 상대경로 `rm -rf ./build`·`ls /`·`cat /etc/hosts`·이미지간 dd는 통과(평소 execute 승인 게이트로). command+args 분리형도 full-line 재구성으로 탐지. 9 테스트, mutation-verified(분류기 무력화->RED); @muse/tools 306 + byte-hygiene 45 green, lint 0. hermes 참조-전용.
- [done] :: **세션 crash-detection 마커** (SES-3/10 foundation) — `01d9467a9`. 챗 세션 턴은 END-of-session 파이프라인에서 장기기억으로 flush되는데 프로세스가 먼저 죽으면 flush 안 돼 턴 유실. `markSessionStart`(부팅 시 atomic 마커)·`markSessionCleanExit`(정상 종료 시 제거)·`detectUncleanShutdown`(마커 잔존=직전 크래시 -> 호출부가 유실 턴 복구 가능). atomic write(half-marker 손상 방지)·결정론·corrupt/missing->clean. 5 테스트, mutation-verified(clean-exit no-op->RED); @muse/stores 354 + byte-hygiene 45 green, lint 0. [skipped] CLI 라이프사이클 배선은 후속(챗 부팅/종료 경로, 신중 요). hermes 참조-전용.
- [done] :: **SES 마커를 챗 REPL 라이프사이클에 배선** (SES-3 wiring) — `481f602ab`. 마커를 실사용화: REPL 부팅 시 `beginSessionWithCrashCheck`가 직전 세션 마커 잔존(클린 종료 안 함=크래시) 탐지 후 이번 start 기록, 클린 종료 시 `endSessionClean` 제거. 직전 크래시 감지 시 1줄 notice(턴은 last-chat.jsonl에 이미 durable이라 정보성). detect-before-mark 순서 유지. 라이프사이클 로직은 얇은 주입 seam(session-recovery.ts)으로 Ink 런타임 없이 단위테스트; REPL 호출은 .catch-guarded(인접 appendSessionBoundary 패턴). [skipped] stranded 턴 re-flush 복구는 후속. 4 테스트, mutation-verified(탐지 제거->RED); @muse/cli 3007 + byte-hygiene 45 green, lint 0.
- [done] :: **텍스트에서 SSRF-안전 bare-URL 추출** (WEB-5) — `884431ee7`. web-url-guard는 주어진 URL만 검증(assertPublicHttpUrlSync), 자유 텍스트에서 URL 추출은 없었음. `extractPublicHttpUrls`가 prose 속 http(s) URL(마크다운 링크 타깃 포함, 닫는 괄호/대괄호에서 멈춤)을 찾아 끝 문장부호 strip·순서보존 dedup 후 SSRF 가드 통과분만 유지 — 주입된 `169.254.169.254` 메타데이터 lure·localhost·non-http는 드롭. 순수·동기(DNS無), 기존 가드 재사용(중복X). 6 테스트, mutation-verified(필터 우회->RED); @muse/domain-tools 781 + byte-hygiene 45 green, lint 0. hermes 참조-전용.
- [done] :: **텍스트에서 이미지 소스(URL+로컬경로) 추출** (MED-12) — `d75ba283f`. `muse ask --image`는 명시 경로만 받음, 텍스트에서 이미지 ref 추출 없었음. `extractImageSources`가 이미지 URL(SSRF-safe `extractPublicHttpUrls` 재사용+이미지확장자 필터, loopback/metadata lure 자격없음) + 보수적 로컬경로(`/`·`~/`·`./`·`../` 접두 + 이미지확장자만, prose의 맨 파일명은 첨부로 안 봄) 반환. 순수·동기·FS 미접근(호출부가 fs-path-safety로 게이트 후 로드). vision auto-route 기반. 6 테스트, mutation-verified(확장자 필터 제거->RED); @muse/domain-tools 787 + byte-hygiene 45 green, lint 0. hermes 참조-전용.
- [done] :: **긴 TTS 텍스트 문장경계 cap** (MED-2) — `ee7843a4a`. TTS 엔진에 넘기는 텍스트 길이 제한 없었음 — 멀티페이지 답변 전체를 합성(느림·무의미·수분 분량). `truncateForTts`가 가능하면 문장종결(. ! ?) 경계, 아니면 단어 경계, 아니면 hard cut으로 자르고 가청 '(truncated)' 큐 추가. 순수·맞으면 byte-identical. synthesizeWithPersona+Fallback에 배선(기본 8000자 cap)->레지스트리가 무한 blob 전달 안 함, 짧은 답변 불변. 6 테스트, mutation-verified(cap 무력화->3 RED); @muse/voice 141 + byte-hygiene 45 green, lint 0. hermes 참조-전용.
- [done] :: **파국 명령 가드에 루트 재귀 chmod/chown 추가** (TX-6 확장) — `2cacedcd9`. TX-6 파국 집합 완성: 루트/홈 트리(`/`·`/*`·`~`·`$HOME`) 대상 `chmod -R`/`chown -R`도 `parseRunnerCommandRequest`에서 fail-close(rm/dd/mkfs와 함께). world-writable/소유권 재배정된 시스템 트리는 sudo/SSH 깨지고 재실행으로 복구불가, 루트엔 정당한 에이전트 용도 없음. rm 규칙과 동일 타이트 타깃: 상대 `chmod -R 755 ./dist`·`chmod +x ./script.sh`·`chown -R me ./project`는 통과(평소 execute 승인). 8 신규 케이스(sudo 접두 포함), mutation-verified(chmod 규칙 차단->RED); @muse/tools 306 + byte-hygiene 45 green, lint 0. hermes 참조-전용.
- [done] :: **게이트된 이미지-첨부 후보 리졸버** (MED-12 후속) — `96e7d8012`. `resolveImageAttachmentCandidates`가 extractImageSources를 주입된 2-게이트(path-safety + 존재)로 합성해 auto-attach가 안전히 로드할 로컬 이미지경로만 반환. 둘 다 필수: prose의 미해결 경로/민감디렉토리 경로는 드롭. 순수(fs+safety 주입)라 후보목록 결정론·미검증 경로 절대 안 읽음; 실제 `--auto-image` 배선(fs-path-safety+existsSync)은 얇은 후속. 3 테스트, mutation-verified(safety 게이트 제거->2 RED); @muse/domain-tools 790 + byte-hygiene 45 green, lint 0. hermes 참조-전용.
- [done] :: **run_command 실패를 모델이 읽는 kind로 분류** (TX-11) — `11291cbc4`. 실패한 run_command가 raw stderr만 반환 -> 소형 로컬모델은 수정 대신 맹목 재시도. `classifyRunnerFailure`가 실패결과를 안정 kind(permission/not_found/timeout/network/out_of_memory/generic)로 결정론 매핑, 성공은 undefined(happy-path 무noise). run_command 결과에 failureKind 포함 -> tool 결과가 모델에 JSON 직렬화(stringifyToolOutput)되므로 모델이 카테고리 봄(non-inert, telemetry 아님). additive optional, 성공경로 byte-identical. 8 테스트(순수+fake runner 배선), mutation-verified(not-failed 강제->4 RED); @muse/tools 312 + byte-hygiene 45 green, lint 0. hermes 참조-전용.
  - **X-3 백그라운드 프로세스 레지스트리 (멀티-슬라이스, 진안-pick "크게")** — 백엔드 4슬라이스 완료, @muse/stores:
  - S1 `1692478ae` crash-safe 레지스트리 store(atomic+file-lock JSON, register/update/remove/get, corrupt->empty, id 멱등) — 6 테스트, mutation-verified, 360 green.
  - S2 `1e3e3ad63` spawn+track 오케스트레이션(spawner·danger-classifier 주입식; 파국명령 거부시 미spawn; exit->exited/failed 기록) — 6 테스트, mutation-verified(거부 제거->RED), 366 green.
  - S3 `6226de1cc` crash-recovery reconcile(재시작 시 PID 죽은 running->exited, isAlive 주입) — 4 테스트, mutation-verified, 370 green.
  - S4 `d5555470c` 실 Node spawner(detached+unref, shell, 출력->logFile) — 3 real-process 테스트, mutation-verified, 373 green.
  - S5a `e7f214979` read-only `muse bg` CLI(list/logs<id>) — 레지스트리 유저-가시화, read-only라 모델선택 검증 불요; `MUSE_BACKGROUND_PROCESSES_FILE` 오버라이드. pure presenter + 실 Command 하네스(fake io+temp store) 5 테스트, mutation-verified; @muse/cli 3012 green.
  - S5c `69d8af944` `muse bg stop <id>` — `stopBackgroundProcess`(kill 주입식, PID 시그널+killed 기록, kill throw 시도 terminal 처리, not_found/already_done) + CLI 배선(실 process.kill). 유저-개시 kill이라 저위험, read+stop 유저 surface 완성. 5 테스트(helper+CLI glue), mutation-verified(kill 스킵->RED); @muse/stores 377 + @muse/cli 3013 green.
  - S5d `3df34e5d4` `muse bg run -- <command>` — 실 node spawner + classifyDangerousCommand 가드 + 레지스트리 배선(거부시 미시작·시작시 detached 기록). 유저-개시 가드된 exec(run_command 동급). `--`로 플래그 명령줄 통과. 2 테스트(가드 거부·실 node -e 시작), SAFE mutation(성공메시지; 가드는 실spawner라 안 깸—거부로직은 S2 fake-spawner mutation으로 검증); @muse/cli 3015 green. **X-3 유저 surface 완성(run/list/logs/stop). 남음=agent-facing MuseTool+eval:tools(attended).**
  - S6 `82f490851` 레지스트리 self-bound(`capBackgroundProcesses`: running 전부 유지 + terminal 최대 50개, 오래된 종료부터 드롭, register마다 적용) — 무한증식 방지(cache/episode eviction 패턴). 3 테스트, mutation-verified(cap 무력화->2 RED); @muse/stores 380 green.
- [done] :: **auto-image 첨부 오케스트레이션** (MED-12, pre-flag) — `22c2d345d`. `loadAutoImageAttachments`가 게이트된 후보 리졸버+이미지 로더 합성(메시지 속 path-safe+존재 이미지ref 로드, 로드실패는 skip해 ask 안 깸). 리졸버·로더 주입식->FS 없이 단위테스트. `muse ask --auto-image`의 검증된 코어; 플래그 배선(임의 유저경로용 path-safety 게이트 + vision smoke:live)은 attended. 3 테스트, mutation-verified(resolve 무력화->2 RED); @muse/cli 3018 green. (WEB-5->MED-12->리졸버->이 오케스트레이션으로 비전테마 로직 완성; 남은 건 플래그+live-verify attended.)
- [done] :: **스케줄러 in-flight run 추적 + graceful shutdown drain** (CRON-9) — `72d109c12`. 스케줄러가 run을 fire-and-forget -> destroy()는 미래 스케줄만 취소, 실행중 run은 고아("running" 영속·작업 반토막). `ActiveRunTracker`(settle 시 auto-forget, timeout까지 drain) + `DynamicScheduler.shutdown(timeoutMs)`(스케줄 중지+in-flight 대기, destroy보다 우선) + `activeRunCount()`. additive(destroy 불변). 5 테스트(injected sleep, 실타이머 없음), mutation-verified(drain 강제 drained->RED); @muse/scheduler 98 + byte-hygiene 45 green, lint 0. hermes 참조-전용.
- [done] :: **스케줄러 일시정지 kill-switch** (CRON) — `6577abd33`. 자율 스케줄 발화(프로액티브·백그라운드 cron)에 대한 유저 kill-switch, learning-pause 패턴 미러. `scheduler-pause-store`(`~/.muse/scheduler-paused.json`, corrupt시 fail-open) + `DynamicScheduler`의 옵션 `isPaused()` 게이트가 cron-발화 run은 일시정지중 skip하되 수동 trigger는 실행(명시 의도 우선; 새 `automatic` 플래그로 구분, 여기서 dryRun은 preview 의미). opt-in(미설정->never paused->byte-identical). 4 store + 3 게이트 테스트(콜백-발화 fake), 둘 다 mutation-verified; @muse/scheduler 101 + @muse/stores 384 + byte-hygiene 45 green, lint 0. hermes 참조-전용.
- [done] :: **스케줄러 pause kill-switch end-to-end 배선** (CRON) — `cadb02a21`. `defaultSchedulerPauseFile`(CLI·데몬 공유 경로) + autoconfigure가 `isPaused: () => isSchedulerPaused(...)`를 DynamicScheduler에 전달(실행중 데몬이 재시작 없이 honor) + `muse scheduler pause|resume|pause-status` 토글. cron-발화는 pause중 skip, 수동 trigger는 실행. 3 CLI 테스트(Command 하네스+temp 파일), mutation-verified(pause가 false 기록->RED); @muse/cli 3021 + @muse/autoconfigure 632 + byte-hygiene 45 green, lint 0. **CRON pause kill-switch 완성.**
- [done] :: **muse doctor에 scheduler-pause 노출** (CRON) — `aae407ceb`. 일시정지된 스케줄러가 "고장"으로 안 보이게(자율잡 조용히 미발화 신호화): doctor `scheduler` 체크가 pause중 warn(since+resume 힌트), 아니면 ok. 순수 `schedulerPauseCheck(state)`+공유 pause 파일 읽어 push. read-only. 2 테스트, mutation-verified(paused status 반전->RED); @muse/cli 3023 + byte-hygiene 45 green, lint 0. (pause: CLI 설정->데몬 honor->doctor 가시화 루프 완결.)
- [done] 2026-06-25 :: **muse doctor에 실패한 백그라운드 프로세스 노출** (X-3 visibility) — `b724555bb`. 크래시한 dev server/watch를 유저가 모르고 지나치지 않게: doctor `background` 체크가 status=failed면 warn(`muse bg logs <id>` 힌트), 아니면 running 수 보고. 순수 `backgroundProcessCheck(records)` + X-3 store 읽어 push. read-only. 3 테스트, mutation-verified(failed 필터 무력화->RED); @muse/cli 3026 + byte-hygiene 45 green, lint 0. (이 슬라이스부터 ledger는 feat 커밋에 합침 — 진안 2026-06-25: 백로그 커밋 과다.)
- [done] :: **muse bg prune — 끝난 프로세스 + 로그파일 정리** (X-3) — `d5f16c8f8`. cap은 record 수만 bound, 로그파일(`~/.muse/bg-logs/`)은 orphan->디스크 무한증식. `pruneTerminalBackgroundProcesses`(terminal record 제거+반환, running 보존) + `muse bg prune`이 반환된 record의 logFile 삭제+보고. 유저-개시 명시 정리, running 절대 안 건드림. 1 helper + 1 CLI 테스트(로그삭제 확인), mutation-verified(write-back 무력화->RED); @muse/stores 385 + @muse/cli 3027 + byte-hygiene 45 green, lint 0.
- [done] :: **muse bg list 가동시간(uptime) 표시** (X-3 polish) — `228765755`. running 프로세스에 compact uptime(`pid N, up 3m`/`2h`/`1d`) 표시 — dev server가 얼마나 떠 있는지 모니터링. 순수 `formatUptime(startedAt, now)`(분/시/일, 미파싱·미래 시작은 빈문자) + presenter에 now 주입. 5 테스트(uptime 포맷+list 표시), mutation-verified(분->시 경계 무력화->RED); @muse/cli 3030 + byte-hygiene 45 green, lint 0.
  - [skipped] S5b(남음, attended): agent-facing `background_process` MuseTool(start/stop) + CLI/autoconfigure 배선(classifyDangerousCommand·node spawner·부팅 reconcile 주입) + eval:tools 로컬모델 선택 검증(tool-calling.md "delivered" 게이트, 로컬 Ollama 필요).
- [done] :: **캐시키 프롬프트 정규화** (PC-4) — `4bb10e305`. buildCacheKey가 user/system 프롬프트를 RAW 해시해서 줄바꿈(CRLF/LF)·trailing 공백만 다른 동일 프롬프트가 캐시 미스. `normalizeCacheText`(CRLF->LF·라인끝 공백 strip·trim)를 양쪽에 적용 + scope fingerprint의 toolNames 중복제거. 라인끝/문자열끝 공백만 건드림(의미 내용 불변), 진짜 다른 프롬프트는 여전히 구분. 7 테스트, mutation-verified(정규화 무력화->4 RED); @muse/cache 22 + agent-core 2638 + byte-hygiene 45 green, lint 0. hermes 참조-전용.
  - 주의: **"SAFE 큐 소진" 정정 (성급했음)** — 앞선 sweep 결론은 스팟체크만으로 "다 covered"라 단정한 오판. judgment prio=5 core 47개 재검토 결과 MEM-1 등 미구현 genuine 항목 다수 확인. TCR-10/I18N-2/CMP-5(envelope counting)/keep_alive는 실제 covered, TX-9(spotlight)는 "보안=코드, 프롬프트 아님" 비협상 위반이라 스킵이 맞음. 그러나 MEM-1(이번 출하)·CMP-2 aux-model 압축·SES crash-recovery·X-3 process-registry·MEM-4/5 등은 attended로 진행 가능. 진안 지시(2026-06-24)로 risk-OK 모드 재개.
- [done] :: **decorrelated-jitter 백오프(opt-in)** (REL-9: decorrelated jitter) — `2e2cb09dd`. retry 백오프가 attempt-지수+대칭 jitterRatio만 있었음 -> AWS decorrelated jitter(`computeDecorrelatedRetryDelay`: next∈[initial, prev*3], maxDelay 캡, attempt간 carry) 추가, `jitter:"decorrelated"` opt-in. 공유 백엔드(로컬 Ollama)에 동시 재시도(background-review+proactivity+턴)를 비동기화. additive(기본동작 byte-identical, retry-after 우선 유지). 4 테스트, mutation-verified; @muse/resilience 54 + agent-core 2630 green, lint 0. AWS 백오프 가이던스 참조.
- [done] :: **멀티프로바이더 TTS 폴백 체인** (MED-3: TTS fallback) — `b6ad8d6d9`. 보이스가 단일 프로바이더 디스패치만 있고 폴백 없음 -> primary TTS 실패(바이너리 없음/일시오류) 시 다른 백엔드 있어도 전체 실패. `synthesizeWithFallback`이 등록순(또는 지정 ids)으로 시도해 첫 성공 반환, 전부 실패시에만 각 시도 실패 명시하며 throw. 결정론·local-first 복원력. 5 테스트, mutation-verified; @muse/voice 135 + byte-hygiene 45 green, lint 0. hermes 참조-전용.
- [done] :: **Ollama 실패 메시지에 모델명 명시** (BIL-9 core: error model attribution) — `1b9794083`. 비-404 Ollama 실패(500/transport)가 상태+본문만 보고 어느 모델인지 안 알려줌 -> 로컬에 여러 모델 깔린 경우 디버깅 난항. `buildNativeError`가 모든 메시지에 모델 id prefix(`Ollama /api/chat [gemma4:12b] failed with 500…`), 404 pull-hint 유지. local-first 진단. 1 신규 + 2 기존 404테스트 신포맷 갱신(동작동일·hint유지), mutation-verified; @muse/model 396 + byte-hygiene 45 green, lint 0. hermes 참조-전용.
- [done] :: **컴팩션 요약에 anti-resume 지시** (PC-7: compaction continuity) — `696c58184`. 컴팩션 후 소형 로컬모델이 이미 끝낸 작업을 재시도하는 문제 -> `[Conversation summary …]` 끝에 결정론적 큐("EARLIER turns — 이미 완료; 최신 메시지부터 이어가고 재실행 말 것") 1회 추가 + 라운드 누적 방지(stripResumeDirective). 2 테스트, mutation-verified; @muse/memory 611 + agent-core 2630 green, lint 0. hermes/openclaw 참조-전용.
  - [skipped] **이번 fire 추가 already-covered**: no-progress 루프감지(`ToolLoopProgressTracker.stalled()` + tool-failure-streak), per-subagent 예산(각 worker가 AgentRuntime maxToolCalls run + MAX_SUBTASKS), 3-tier 프롬프트/stable-prefix(`@muse/prompts` stable/dynamic section + stablePrefix + priority). **주의: SAFE 로컬-fit 큐 사실상 소진** — 남은 고가치는 deferred(aux-model 압축·session 상태머신·background-process 레지스트리)로 attended 리뷰 필요.
- [done] :: **복구된 tool-args의 lone UTF-16 surrogate 정화** (TCR-3: surrogate sanitization) — `0fd28e48e`. 바이트레벨 로컬모델이 미쌍 surrogate(lone high/low)를 tool-arg에 흘리면 JSON.parse는 통과하나 downstream UTF-8 인코딩(fetch body/재전송) 손상·다음 provider 거부. `sanitizeLoneSurrogates`(pairing-aware: 진짜 이모지 쌍 보존, surrogate 없으면 byte-identical) 추가 + `recoverToolArgsJson`이 복구객체의 모든 문자열 키/값을 deep-walk해 U+FFFD로 정화. 8 테스트, mutation-verified; @muse/model 395 + byte-hygiene 45 green, lint 0. hermes `message_sanitization` 참조-전용.
- [done] :: **grounding-block fence 라벨 위조방지** (provenance integrity, deferred에서 안전화) — `e00d30882`. 그라운딩 블록 빌더가 memory KEY(+contact id)를 fence 헤더(`<<memory N — KEY>>`·`[memory: KEY]`)와 renderMemoryFact topic에 UNescaped 삽입 -> 오염/auto-extract된 키가 newline+`<<end>>`로 fence 경계 위조 + 가짜 grounded 항목 주입 가능(GROUNDED≠TRUE 구멍). `sanitizeFenceLabel`(control/newline/DEL/angle-bracket만 제거; 실식별자엔 없는 문자) 추가·적용. 정상 키는 byte-identical, citation 게이트는 token-overlap이라 정당 인용 불약화. 3 테스트, mutation-verified; @muse/recall 495 + byte-hygiene 45 green, lint 0. grounding 엣지 강화. (이전에 sensitive로 보류했으나 token-overlap 매칭 확인으로 안전 입증.)
- [done] :: **URL 쿼리파라미터 시크릿 리댁션** (SEC-1: url credential redaction) — `26ae28d90`. `redactSecretsInText`가 userinfo·벤더토큰 형태는 잡았지만 쿼리파라미터 VALUE로 실린 시크릿(presigned `?X-Amz-Signature=`, 일반 `?api_key=`/`?access_token=`/`?token=`)은 값이 알려진 형태가 아니면 통과 -> 로그·proactive·메모리·tool출력에 누출. 민감 KEY 매칭 후 값 리댁션(가변길이 lookbehind로 param명 보존). additive(리댁션만 추가), redactSecretsInText에 합류돼 모든 호출처에서 즉시 적용. 1 테스트, mutation-verified; @muse/shared 45 + agent-core 2630 green, lint 0. hermes/openclaw 참조-전용.
  - **byte-hygiene 회귀 수정** — `7250b9c19`. 에이전트생성 competitor-teardown.md의 NUL바이트(U+0000)가 @muse/shared repo-byte-hygiene 게이트(goal-227) 위반 -> `+`로 치환, 45 green 복구. (이번 fire는 회귀수정 우선 + SEC-1 동반.)
- [done] :: **터미널 배경 감지 + dim 대비 가드** (UX-3: terminal theme/contrast) — `5c0fc7cd9`. CLI 색출력이 NO_COLOR/TTY는 보지만 배경을 무시 -> 라이트 테마에서 `dim`(회색)이 거의 안 보임. `detectTerminalBackground`(COLORFGBG 파싱: rxvt fg;;bg 포함, 마지막 필드=배경, 7/9-15=light·0-6/8=dark) 추가 + colorize가 KNOWN light 배경에선 dim을 평문으로. additive(COLORFGBG 없으면 unknown->byte-identical, dim만 영향). 8 테스트, mutation-verified; @muse/cli 3003 green, lint 0. openclaw 참조-전용.
- [done] :: **웹검색 결과 canonical-URL 디둡** (WEB: search result dedup) — `c4fa62149`. DDG HTML이 같은 URL을 반복 -> parseDuckDuckGoHtml이 원시 매치를 max로 잘라 중복이 결과 슬롯 차지(로컬모델 컨텍스트 낭비). 이제 전체 수집->canonical URL(host 소문자·fragment/trailing-slash 제거·path+query 보존으로 ?id=1≠?id=2)로 디둡->max 컷 = max개 distinct. searxng 경로도 동일 적용. 3 테스트, mutation-verified; @muse/domain-tools 775 green, lint 0. openclaw/hermes 참조-전용. (WEB-1 풀 멀티클라우드 레지스트리는 로컬-first에 sprawl이라 미채택; searxng->ddg 폴백으로 이미 충분.)
- [done] :: **TTS 페르소나 레이어(요청 우선 precedence)** (MED-2: TTS persona) — `d79acb810`. 보이스에 per-provider defaultVoice + per-request override만 있고 일관된 "Muse 목소리" 페르소나 없음. `TtsPersona`(provider+voice/format/speed 기본값) + 순수 `resolveTtsPersona`(per-call 필드가 항상 우선, 페르소나는 빈칸만 채움) + registry `synthesizeWithPersona`(페르소나가 provider 선택, 없으면 primary). 결정론·local-first. 7 테스트, mutation-verified; @muse/voice 130 green, lint 0. hermes 참조-전용. CLI 채택은 후속.
- [done] :: **cron 잡 retry에 영구에러 fail-fast** (CRON-1: error-classified cron retry) — `9fb488208`. 스케줄러 dispatch retry 루프가 모든 실패를 maxRetryCount만큼 맹목 재시도(고정 딜레이) -> 영구에러(잘못된 tool명·model-not-found·auth·검증)도 전 attempt 소진. 이제 catch마다 `ErrorClassifier`(@muse/resilience)로 분류 -> 영구에러는 즉시 break, transient/unknown은 기존대로 끝까지 재시도. 앞서 출하한 classifier 재사용. 2 테스트(영구->1회/transient->풀카운트), mutation-verified; @muse/scheduler 93 green, lint 0. hermes 참조-전용.
  - [skipped] **already-covered (이번 fire)**: cron 재진입 가드(scheduler-locks "another instance holds lock" skip), retry 인프라(retryOnFailure/maxRetryCount/retryDelayMs), 모델ID tag 보존(parseModelName), recall 다양성(hybrid-MMR=MEM-7 개념dedup 대체). 주의:보류: SES-* 세션상태머신/크래시복구(hermes 게이트웨이 멀티세션 기능, 로컬 단일사용자 fit 의문), PRV-2/3 카탈로그·클라우드 failover(로컬 fit 낮음).
- [done] :: **요청 크기 비례 모델콜 타임아웃** (PRV-10: request-scaled timeout) — `f3d91d36c`. 모델콜 타임아웃이 요청 크기와 무관하게 고정 120s -> 큰 컨텍스트의 정당하게-느린 로컬 생성이 중도 kill됨. `scaleRequestTimeout(base, tokens)`가 큰 요청에 한해 상향(base*추정, 10분 캡), 작은 요청은 base 유지(byte-identical), base<=0(타임아웃 없음 관례) 통과. model-invocation 타임아웃 seam에 char/4 추정으로 배선. 6 테스트, mutation-verified; @muse/resilience 50 + agent-core 2630 green, lint 0. hermes 참조-전용.
- [done] :: **결정론적 tool-call 사전실행 미들웨어(veto 게이트)** (TX-9: tool pre-call middleware) — `5a77e1374`. beforeTool 훅은 관찰전용(반환 무시)이라 실행 전 도구호출을 정책으로 막을 seam이 없었음. `ToolCallMiddleware` 체인이 실행 직전 호출을 veto 가능(이유는 모델에 tool result로 노출; 예: 제한 서브에이전트 tool allowlist, 파괴적 도구 금지). block-only(arg 재작성은 dedup서명·conflict가드 desync) + empty-default byte-identical(2628 베이스라인 불변). AgentRuntime 옵션->runner->per-call 게이트, 기존 blockedToolResult 경로 합류. 5 unit+2 wiring 테스트, mutation-verified; @muse/agent-core 2630 green, lint 0. hermes 참조-전용.
  - [skipped] **추가 already-covered (이번 fire 조사)**: 메시지 시퀀스/orphan-pair 복구(`memory-token-trim` ensureBoundaryIntegrity/removeOrphan*가 매 trim 호출 무조건 실행), tool-arg 강제변환(`coerceToolArguments`/`coerceEnumArguments`/`groundToolArguments`), 모델ID 정규화(`parseModelName`), leading think-strip(의도적 leading-only). 주의:보류(민감/큰): MEM-2 출력 fence-scrub(citation 게이트 정확성 위험·CLI 답변경로), grounding-block key forgery 방지(citation copy-exact 요구로 위험), CMP-1 aux-model compression(컴팩션 경로 LLM호출·교차절단). attended 리뷰 권장.
- [done] :: **server-advised retry-after 백오프 준수** (REL: rate-limit-aware backoff) — `12858334c`. `classifyError`에 결정론적 `retryAfterMs` 추출 추가(retryAfter/retry_after(초)·retryAfterMs(ms) 필드, `retry-after` 헤더(객체/get()/Map), 메시지 패턴 "try again in 2s"/"resets in 3m"/"wait 500ms"). `retry()`가 retry-after 있으면 블라인드 지수백오프 대신 그 시간만큼 대기(maxDelayMs 또는 60s로 캡 -> 비정상값 행 방지), 없으면 기존 동작. rate-limited 프로바이더를 요청한 윈도우만큼만 백오프. 6 테스트, mutation-verified; @muse/resilience 44 + agent-core 2623 green, lint 0. hermes 참조-전용.
- [done] :: **컨텍스트-윈도우 스케일 tool-output 예산** (REL-6: context-scaled budget) — `49353323b`. per-tool 캡이 모델 윈도우와 무관하게 고정 8k였음(작은 로컬 윈도우를 한 번에 삼킴). `scaleToolOutputBudget(windowTokens, cap)`이 윈도우의 ~10%로 축소(설정값 천장 절대 안 넘김·floor 보장·윈도우 미상이면 no-op). autoconfigure에서 이미 계산된 contextWindow로 배선. 5 테스트, mutation-verified; @muse/memory 609 + @muse/autoconfigure 632 green, lint 0. hermes 참조-전용.

### Gap 1 — 에이전트가 호출 가능한 자기 과거 검색 (가장 큰 갭; 둘 다 있고 Muse만 없음)
hermes `session_search_tool.py`(FTS5 trigram, CJK), openclaw `memory-search.ts`(FTS5 + 하이브리드 BM25+vector+MMR). Muse는 episodic recall이 내부용일 뿐 "전에 X 얘기한 대화/메모 찾아줘"를 에이전트가 호출할 도구가 없음.
- [done] :: S1 (fire 1): 결정론 CJK-aware lexical history-search 코어(`searchHistory` in @muse/recall, BM25). DONE.
- [done] :: S2 (fire 2): 코어를 에이전트-호출 도구(`history_search`)로 노출 + 런타임 레지스트리 배선 + eval:tools 골든 케이스. DONE.
- [done] :: S3 (fire 6): 하이브리드(lexical BM25 RRF + cosine) 랭킹 — `searchHistoryHybrid` in @muse/recall (queryVector+record embeddings 있으면 두 랭크리스트를 fuseByReciprocalRank로 fusion, 없으면 byte-identical lexical fallback; minCosine floor로 precision 보존, 둘 다 못 맞추면 빈 결과=fabrication 0). 9 OUTCOME vitest(파라프레이즈가 lexical은 0 hit인데 hybrid가 surfacing) + 1줄 mutation RED-confirmed. Opus (4)b PASS. — capability-parity fire 6

### Gap 2 — skill curator 라이프사이클 (현재 quarantine만 있음)
hermes `curator.py`(usage 추적·stale/archive 자동전이·consolidation·백업), openclaw `workshop/service.ts`(proposal->scan->apply/quarantine/rollback). Muse는 `AuthoredSkillStore` risk-scan + quarantine만 있고 라이프사이클 없음.
- [open] :: S1: skill usage 사이드카(use_count·last_activity·view_count) 결정론 store + vitest. MUTATION-FIRST.
- [done] 2026-06-27 :: S2: stale->archive 자동전이 — DONE (freshness-guard 2026-06-27): `authored-skill-store.ts` has lastUsedAt + auto-archive(stale) + cap-by-archiving + restore (line 289), and the curator daemon runs periodic stale-skill auto-archive (`08827dd75`). The whole Gap-2 lifecycle (S1 usage sidecar / S2 stale-archive) is covered (cf. line 39).
- [open] :: S3: 중복 authored-skill consolidation(겹침 탐지->umbrella 병합 제안, draft-first, 자동 활성 금지).

### Gap 3 — scheduled multi-phase dreaming + inert 역량 배선
openclaw 3-phase dreaming(Light/Deep/REM, temporal decay, health 회복). Muse는 조각만 있고 세션-끝 훅 only + 핵심 inert.
- [open] :: S1 (가장 빠른 ROI, 2줄급): ACT-R `recallActivation`을 `StoreBackedEpisodicRecallProvider.resolve()`에 배선(`useActrRanking:true` 전달) — 이미 테스트된 함수가 episodic 랭킹에 안 쓰임. OUTCOME 검증(랭킹 변화) + eval:multihop.
- [open] :: S2: multi-hop recall default-ON 평가 후 플립(이미 40%->80% 측정됨, MUSE_RECALL_SECOND_HOP) — eval:multihop pass^k 확인 후.
- [open] :: S3: 결정론 consolidation을 스케줄 daemon arm으로(세션-끝 only -> 주기적), promotion/decay 게이트 재사용. health-기반 회복 트리거(openclaw 패턴) 차용.
- [open] :: S4: background-review default-ON 검토(MUSE_BACKGROUND_REVIEW_ENABLED) — fail-soft·write-gated면 플립, pass^k.

### Gap 4 — sub-agent 오케스트레이션 내구성 (Ollama 필요 슬라이스는 박스 quiet할 때)
openclaw `subagent-registry.ts`(persistent run registry·async announce non-polling·orphan recovery). Muse lead-worker+council은 in-memory, registry/announce/recovery 없음.
- [done] :: S1 (fire 3): persistent sub-agent run registry store(`SubAgentRunRegistry`, @muse/multi-agent) — live run lifecycle (run id·parent->child·status·timeout·heartbeat·stall detection), distinct from FINISHED-run-audit OrchestrationHistory; orphan-by-construction rejected, frozen records, pure detectStalled + markStalledAsTimedOut. 21 OUTCOME-state vitest, 2 mutations RED-confirmed. Opus (4)b PASS. — capability-parity fire 3
- [done] :: S2 (fire 5): wire SubAgentRunRegistry into the LIVE MultiAgentOrchestrator (closes the inert-store risk fire 3 flagged) — a real run now registers parent + each child worker run and transitions them running->completed/failed/timed-out end-to-end; also threaded into apps/api orchestrate routes + new GET /api/multi-agent/runs live surface. Opus (4)b PASS. — capability-parity fire 5
- [done] :: S2b — capability-parity fire 8: deterministic orphan-recovery policy on SubAgentRunRegistry (`detectOrphaned` flags a running child whose parent reached a terminal status — incl. a child registered against an already-terminal parent — ignoring root runs + already-terminal children; `recoverOrphaned` transitions orphans to `failed` with finishedAt/error, distinct from heartbeat-stall `timed-out`, leaving unrelated running state untouched). 5 OUTCOME-state vitest, 1-line mutation RED-confirmed. Orchestrator wiring deliberately NOT added (parent-failure catch is unreachable for orphans: runSequential/runParallel swallow worker errors -> children always terminal before parent settles), so it ships as a tested defensive primitive for a future scheduled sweep. Opus (4)b PASS.
- [done] :: S3 — capability-parity fire 7: typed 핸드오프 스키마(`parseHandoffPart`)를 worker->synthesizer fan-in seam에 강제 — neutralize 후 placeholder로 붕괴한 poisoned 워커 파트를 fail-close 드롭해 synthesizer/conflict/redundancy fan-in 미소비; 워커 status·history·raw.workers 불변. eval:orchestration STABLE 3/3, Opus (4)b PASS.
- [open] :: S4 (Ollama): async announce(non-polling) 완료 경로 — 박스 quiet할 때 eval:decomposition.

### 주의: Audit follow-ups (2026-06-23 진안-요청 독립 적대 점검, fires 1-8 vs 코드; pnpm check exit 0이나 완전성 갭 발견)
독립 Opus 리뷰어 2명이 라이브 동작은 맞으나 "지어졌으나 안 쓰임(inert)" + honesty 과장을 찾음. 라이브·정상: lexical history_search(end-to-end, 기본 ON), registry parent/child 등록+completed/failed 전이(오케스트레이터+/runs 공유), typed handoff fail-close. 갭:
- [done] :: **A1** (honesty/floor): history_search records provider가 광고대로 3 소스(episodes+notes+memory) 실검색 — `buildHistoryRecords`(per-source fail-soft) 배선, 실 NOTE/FACT가 [notes:]/[memory:] 라벨로 반환됨을 e2e 입증(mutation-RED) — capability-parity fire 9
- [done] :: **A2 (was MAJOR, inert) — SHIPPED `b67a511ba`**: `searchHistoryHybrid` wired into the `history_search` tool via an opt-in embedder seam (query embed + per-record embed, `MUSE_HISTORY_SEARCH_HYBRID` default-off, lexical fallback byte-identical). Deterministic OUTCOME tests + mutation-verified. (Live eval:tools semantic-hit verification still attended.)
- [done] :: **A3 + A5 + A7 (were MAJOR/inert + trap + test-gap) — SHIPPED `ca2ba3113`**: per-worker deadline threaded from the HTTP route into the orchestrator (`MUSE_MULTI_AGENT_WORKER_TIMEOUT_MS`, opt-in); parent-run heartbeat refreshed on each worker-settle (defuses the A5 false-timeout trap); A7 HTTP integration test (POST /orchestrate -> GET /runs asserts parent+child registration/transition). Mutation-verified both. The heartbeat/detectStalled async-liveness sublayer stays the primitive for the future detached-worker model (A6), honestly disclosed.
- [open] :: **A4 (MINOR)**: `history_search` vs `knowledge_search` corpus 겹침(둘 다 episodes+memory) — 모델이 올바로 고르는지 `eval:tools` 골든 케이스 없음(tool-calling.md 요구). FIX: "find that conversation about X" 프롬프트 골든 추가.
- [open] :: **A5 (MINOR, latent trap)**: A3 수정 시 — `markStalledAsTimedOut`-on-read(multi-agent-routes.ts:106)가 heartbeat 없으면 wall-clock-since-start로 건강한 run을 timed-out 처리. timeout 배선 전 반드시 실제 heartbeat 호출자 먼저.
- [open] :: **A6 (NIT)**: orphan-recovery(fire 8 S2b)는 현 동기 오케스트레이터에선 구조상 도달 불가(honestly disclosed). async/detached 워커 모델 도입 전까지 dead-but-tested. async announce(S4) 도입 시 함께 라이브화.
- [open] :: **A7 (test gap)**: `/api/multi-agent/runs` 라우트 테스트가 빈-레지스트리 shape만 검증 — 실제 오케스트레이션을 HTTP로 돌린 뒤 /runs 읽는 통합 테스트 없음.

- [done] :: capability-parity Gap1-S2 — capability-parity fire 2: exposed fire-1's `searchHistory` as the agent-callable `history_search` tool (verb_noun, read-risk, rich schema w/ KO+EN examples, "use when / do NOT use" disambiguating from knowledge_search + the recent-activity feed) in @muse/recall, wired into the production runtime tool registry (MUSE_HISTORY_SEARCH_ENABLED default-ON, deterministic so no Ollama cost; feeds episodes via readEpisodes, fail-soft to no-match). 8 unit + 2 OUTCOME wiring vitest (tool present in registry + executes returning a [source:ref] hit; absent when disabled); 3 mutations RED-confirmed. eval:tools golden scenario 7/7 STABLE 3/3 live on gemma4:12b. Opus (4)b judge PASS. (detail: docs/goals/loops/capability-parity.md fire 2)
- [open] :: STALE backlog item Gap3-S1 ("wire recallActivation / pass useActrRanking:true into StoreBackedEpisodicRecallProvider.resolve") — ALREADY DONE in current code: resolve() at episodic-recall.ts:529-535 already calls approximateActivationBoost when recallStats is present; there is no useActrRanking flag and nothing to wire. Building it would be a config-only no-op. De-prioritize / re-scope Gap3 to S2 (multi-hop default-ON flip) or S3 (scheduled consolidation arm). (found capability-parity fire 2 scout)
- [open] :: pre-existing eval-tool-selection.mjs bug: buildWebSearchScenario + buildUnitConvertScenario import the web-search server as `mcp.createSearchMcpServer` / `mcp.createWebReadMcpServer`, but those live in @muse/domain-tools (mcp re-exports neither -> both are undefined -> both scenarios silently SKIP via their catch). Fire 2's new history scenario imports correctly from @muse/domain-tools; the two older scenarios should be patched the same way to stop silently skipping. (found capability-parity fire 2 sibling-audit)
- [done] :: capability-parity Gap1-S1 — capability-parity fire 1: deterministic CJK-aware lexical history-search core (`searchHistory` in @muse/recall, BM25 over Muse's own primitives, snippet centered on match, recency tiebreak) — the agent-callable "find where we talked about X" gap vs hermes/openclaw. 8 mutation-verified vitest; also fixed a pre-existing byte-hygiene baseline regression (raw NUL byte at knowledge-ranking.ts:202 -> \x00 escape). Opus (4)b judge PASS. (detail: docs/goals/loops/capability-parity.md fire 1)
- [done] :: file_list truncated-flag accuracy — computer-control fire 59: file_list reported truncated=true when a dir had EXACTLY `limit` matches (it broke + flagged at `>= limit`), so the model chased a non-existent next page. Fixed by collecting one past the limit (sentinel) to distinguish complete (==limit->false) from cut (>limit->true). @muse/fs 182 vitest pass; mutation-verified; Opus (4)b judge PASS (traced 0/<L/==L/==L+1/>>L). Shipped under box load~35 via narrow per-pkg vitest (full pnpm check still load-blocked). (detail: docs/goals/loops/computer-control.md fire 59)
- [done] :: run_command in-band truncation marker — computer-control fire 58: a truncated stdout/stderr stream now carries a self-labelled `[muse: output truncated…]` marker so the local 12B SEES (in the text) that output is partial, instead of reading a cut log as the whole thing. Per-stream (Rust runner), guarded by `truncated`, bool field preserved. cargo 15 pass (real-bash integration test); mutation-verified; Opus (4)b judge PASS (traced TS consumer — no break). Shipped under box load~40 as a cargo-only-verifiable slice. (detail: docs/goals/loops/computer-control.md fire 58)
  - 주의: BLOCKER (now spans 55/56/57): computer-control (5)c main-merge of fires 55/56/57 DEFERRED (fire 57, ×3) — `pnpm check` failed all 3 attempts, but as box SATURATION (18 diverse tests across 5 files all "Test timed out in 5000ms" in isolation = the concurrent-loop saturation class, not assertion failures; agent-core's own 2589 tests pass, and the fire-56 nudge is one-shot-proven so it can't hang). Fires 55/56/57 are safe on origin/loop/computer-control; retry the main-merge next ×3 fire (60) when the box is quieter. NOT a real regression in this loop's work.
- [done] :: run_command UTF-8 truncation integrity — computer-control fire 57: the Rust runner caps stdout/stderr at a BYTE boundary, so a truncated multibyte char became U+FFFD (�) via from_utf8_lossy — the model reads that as corruption in a verify log. Added trim_partial_utf8_tail (bounded ≤3 pops, truncated-only) so truncated output stays clean valid UTF-8. cargo 14 pass; mutation-verified; Opus (4)b judge PASS (its non-blocking note on over-trim/perf folded in same fire). (detail: docs/goals/loops/computer-control.md fire 57)
- [done] :: re-verification nudge (MECHANISM) — computer-control fire 56 (also the JUDGE-DRILL): ReverifyNudgeTracker wired into BOTH executeModelLoop + executeStreamingModelLoop — when the model finishes after an unverified edit (run-intent task, execute tool live), inject REVERIFY_NUDGE once and re-prompt to re-run. Deterministically proven by a scripted-provider behavioral test (nudge injected + re-prompt happens; not on verified/no-intent; one-shot, no infinite loop) + 12 helper unit tests; mutation-verified; Opus (4)b judge PASS. JUDGE-DRILL: an inert (unwired) version was built first and the independent judge correctly FAILed it. (detail: docs/goals/loops/computer-control.md fire 56)
- [open] :: CONFIRM eval:reverify-fix FAIL->PASS on a CLEAN (unsaturated) box — fire 56 shipped the deterministically-proven nudge MECHANISM, but the end-to-end 12B flip could not be measured (concurrent-loop saturation timed the eval out at >560s/case). Re-run `MUSE_EVAL_REPEAT=3 pnpm eval:reverify-fix` when the box is quiet; if the 12B still doesn't re-run after the nudge, the next lever is nudge SALIENCE/wording (user-message already used; consider a more imperative phrasing) — NOT a blind retry loop. [fire 57: re-attempted, still timed out >420s/case — box remains saturated by concurrent loops; the mechanism stays deterministically proven, the e2e flip stays pending a quiet box.]
- [done] :: eval:reverify-fix re-verification battery — computer-control fire 55: a harder probe where the test exits on its FIRST failure (hiding bug 2 until bug 1 is fixed + re-run). Discrimination verified deterministically (neither/only-reported-fixed->FAIL, both->PASS). Standalone red-probe (not in any gate). 12B FAILs 1/1 — surfaced the re-verification gap above. Opus (4)b judge PASS. (detail in docs/goals/loops/computer-control.md fire 55)
- [open] :: pick-evals.mjs:41 greedy regex — `/...|reverify|.../i` matches eval file PATHS by substring and mis-routes "reverify" to the grounding batteries (semantically wrong; this eval is computer-task re-verification, not grounding). Pre-existing greedy-regex artifact (not introduced by fire 55); only over-runs skip-or-pass local batteries so low-harm. Tighten the rule to anchor grounding-specific paths. (noted by fire 55 (4)b judge)
- [done] :: muse status privacy posture line — cli-excellence fire 1
- [done] :: muse --help / non-TTY first-screen local-first quickstart block — cli-excellence fire 2
- [done] :: first-screen taglines aligned to learns-you/local-first identity via single MUSE_TAGLINE const (--help + REPL banner) — cli-excellence fire 3
- [done] :: chat REPL HUD local-only posture badge ( local / 주의: cloud) — cli-excellence fire 4
- [done] :: `muse --version` pre-framework fast path (~500ms->~90ms) + version 0.0.0->0.1.0 single-source — cli-excellence fire 5
- [done] :: `muse notes reindex` honest empty-state when 0 markdown found (vs misleading "Done. 0 embedded") — cli-excellence fire 6
- [done] :: unknown-command discovery on-ramp (no close match -> Popular commands, registry-intersected) — cli-excellence fire 7
- [done] :: muse status dashboard timestamps humanized (raw UTC ISO -> "3h ago"/local datetime; --json raw kept) — cli-excellence fire 8
- [done] :: REPL splash polish: tagline 2-space aligned + stray cyan rule removed + mascot slimmed 64->56 cols (Jinan-directed) — cli-excellence fire 9
- [done] :: no-model first-run identity-led onboarding screen (wired; JUDGE-DRILL caught the inert version) — cli-excellence fire 10
- [done] :: muse doctor --local warnings scannable (주의: marker, not neutral ·) — cli-excellence fire 11
- [done] :: muse notes reindex [i/N] progress position (responsiveness) — cli-excellence fire 12
- [done] :: muse --help command list sorted alphabetically (scannable, configureHelp) — cli-excellence fire 13
- [done] :: muse --help command GROUPING into categories — DONE cli-excellence fires 20-21 (core + long-tail, 9 ordered headings)
- [done] :: muse doctor default summary timestamp humanized (fire-8 sibling) — cli-excellence fire 14
- [done] :: muse remind list flags overdue pending reminders (주의: overdue) — cli-excellence fire 15
- [done] :: chat-repl in-chat reminder list overdue marker (parity with remind list) — cli-excellence fire 16
- [done] :: muse tasks list flags overdue tasks (주의: overdue) — cli-excellence fire 17
- [done] :: eval:two-edit-fix completeness battery — computer-control fire 54: a harder multi-step eval (2 edits across 2 files; test passes only if BOTH bugs fixed) that catches a stop-after-one-edit model. Mirrors eval-multifile-fix harness; OUTCOME-graded; discrimination verified deterministically (one-edit->FAIL, both->PASS). 12B PASSes 1/1 live (cross-file 2-edit completeness confirmed — cumulative effect of fires 47/49/51). Opus (4)b judge PASS. Kept standalone (pass^1); promote into eval:multistep once pass^k-confirmed. REMAINING flywheel directions: wrong-first-fix re-iterate eval (naive first edit insufficient -> must re-read+re-edit), or theme repoint if the vein is exhausted. (detail in docs/goals/loops/computer-control.md fire 54)

- [done] :: eval:multistep regression-lock aggregator — computer-control fire 53: bundles the 3 multi-step evals (computer-task/multifile-fix/edit-run-verify) into one gate (pnpm eval:multistep) so their fires-40-51 FAIL->PASS gains can't silently rot; mirrors eval:self-improving (Ollama-skip->exit0, any-fail->exit1, MUSE_EVAL_REPEAT passthrough for pass^k). Live ALL PASS 3/3; Opus (4)b judge PASS. Done backlog direction (1). REMAINING next directions: (2) harder multi-step fixture (2-edit cross-file / wrong-first-fix re-iterate) to keep raising the bar; (3) theme repoint if the deterministic vein is exhausted (agent-core well over-mined; consider a fresh sub-area or repoint). (detail in docs/goals/loops/computer-control.md fire 53)

  - MILESTONE (computer-control fire 52): ALL THREE multi-step evals now PASS — eval:computer-task, eval:multifile-fix (fires 47 not-exposed-suggestion + 49 step-repetition nudge), AND eval:edit-run-verify (fire 51 run_command exposure reserve, OUTCOME-validated fire 52 with model-ran-test=true). The theme's headline goal (local-12B multi-step computer-task reliability) is substantially achieved; the deterministic veins (fs/tools/agent-core tool-call boundary + exposure, fires 40-51) are heavily worked. NEXT DIRECTIONS (for the next fire / async review — agent-core well is well-mined, prefer a DIFFERENT (pkg,kind)): (1) make both hard evals pass^k CI-regression-locked (currently pass^1 observed, Ollama-only); (2) add a HARDER multi-step fixture (2-edit cross-file / cascading-test-break / wrong-first-fix-then-re-iterate) to keep raising the bar; (3) consider a theme repoint if the deterministic vein is genuinely exhausted. The per-mechanism regression protection is already CI-gated via the unit tests shipped in fires 40-51.

- [done] :: run-intent execute-tool exposure reserve — computer-control fire 51: eval:edit-run-verify FAILed with test-passes=true but model-ran-test=false — the model fixed the bug but never ran run_command to verify, because capToolsByRelevance starved run_command: the FILE_PATH-boosted file cluster filled all 3 relevantReserve slots (run_command rank 4 -> dropped, not advertised). Added RUN_INTENT_RE + a dedicated reserve for the top relevant execute-risk tool on a run/test/build prompt (fire-4's file-reserve sibling). Deterministic exposure fix; 2 mutation-verified tests; @muse/agent-core 2573 green; Opus (4)b judge PASS. OUTCOME flip unconfirmed (run_command now exposed; 12B selection stochastic). (detail in docs/goals/loops/computer-control.md fire 51)

- [done] :: MILESTONE (computer-control fire 50): eval:multifile-fix PASSing (2/2, Ollama up) after fires 47 (not-exposed tool suggestion) + 49 (step-repetition nudge) lifted local-12B multi-step reliability. A done record, not open work — the agent-core not-exposed/model-loop + deterministic file-op veins are mined out; · residual: re-measure eval:edit-run-verify pass^k to confirm fire 50's command-as-name recovery held.

- [done] :: command-as-name -> execute-tool recovery — computer-control fire 50 (fire-47 sibling): the 12B sometimes emits a whole command line as the tool name (`node --exec "…"`, measured in eval:edit-run-verify); token-overlap can't match run_command. The not-exposed gate now routes a command-shaped name (has whitespace) to the active execute tool ("call 'run_command' with the command in its arguments"). 2 mutation-verified integration tests; @muse/agent-core 2571 green; Opus (4)b judge PASS. (detail in docs/goals/loops/computer-control.md fire 50)

- [done] :: multi-step STEP-REPETITION nudge — computer-control fire 49: a MUSE_TASK_DEBUG trace revealed the real failure is STEP REPETITION (MAST arXiv:2503.13657), not pure early-stop — the 12B re-reads the SAME files in a loop (file_read test->math->test->math…) and never edits (the eval's deduped `tools=[file_read]` hid it). The model-loop's deduplicator returned the cached result on an identical repeat with no signal. Now `withRepetitionNudge` appends a "you repeated — take the next action" cue to the MODEL-FACING tool message on a duplicate (both blocking+streaming loops; trace/metrics untouched; dedup's write-invalidation means a legit post-edit re-read is NOT flagged). Deterministic, no re-run loop (not a reflection-guard surface). 1 mutation-verified test; @muse/agent-core 2569 green; Opus (4)b judge PASS. OUTCOME (eval flip) inconclusive across stochastic runs — ships on delivery merits. (detail in docs/goals/loops/computer-control.md fire 49)

  - NEXT (multi-step EARLY-STOP — the no-tool-at-all variant; step-REPETITION now addressed fire 49): NOTE — fire 49's trace showed the dominant mode was REPETITION (re-read loop), now nudged. The remaining variant is the model returning a final answer with NO further tool after a read (genuine early-stop). The re-prompt decomposition (48a/b/c) below still applies to that variant; re-measure both evals after fire 49's nudge to see if repetition was the main driver before investing in the invasive re-prompt. Original decomposition (dual-eval evidence fire 48):
 with Ollama up, BOTH harder multi-step evals FAIL via early-stop/repetition — `eval:multifile-fix` AND `eval:edit-run-verify` each ran `tools=[file_read]` then the 12B STOPPED without editing/running (the buggy fn left unchanged). The deterministic tool-call veins (fires 40-47: arg recovery, name sanitize, coercion, path/grep/run_command hints, not-exposed suggestion) are largely exhausted; early-stop is model-behavior and the dominant remaining blocker. The fix is the fire-12 action-completion re-prompt, but it is genuinely >1 fire and must NOT be rammed (fire-12: "not auto-fodder"; reflection-guard: a retry surface needs a calibrated verifier + no mis-fire). DECOMPOSED loop-sized sub-slices:
  - (48a) DETECTOR — the existing `isUnbackedActionClaim` = `requestsToolAction(query) && answerClaimsAction(answer) && !actionToolRan(toolNames)` does NOT cover early-stop (the model STOPS without CLAIMING done -> `answerClaimsAction` false). Need a precise `actionRequiredButNoneTaken(query, toolNames)` = `requestsToolAction(query) && !actionToolRan(toolNames)` (drops the claim requirement), built with a HEAVY adversarial FP corpus: answer-only/advice/read-only queries ("what does X do?", "summarize X", "read X") must NOT fire. Pure predicate, Ollama-free, mutation-first. The precision of `requestsToolAction` is the whole ballgame — measure its FP rate on real traces before any wiring.
  - (48b) CONSOLIDATE — `runResistingFalseDone` is currently wrapped around the run ONLY on the chat-repl path (fire 32); the eval/server path (AgentRuntime.run) has no re-prompt. Decide the architecture: move the bounded re-prompt INTO AgentRuntime.run and have chat-repl delegate (NO double re-prompt). reflection-guard registry already points at false-done-reprompt.ts (fire 45) — the wrapper stays, its call site moves. Touches the shared core loop (server+CLI) -> highest blast radius; do on a NON-main-merge fire with chat-repl regression tests.
  - (48c) WIRE + VALIDATE — wire (48a)'s detector into (48b)'s re-prompt (bounded 1, verifier = a write/execute tool ran after), then validate the eval delta with pass^k (k≥3, both evals) now that Ollama is up. Ship only if eval improves AND the FP corpus stays clean AND Opus (4)b judge PASS.

- [done] :: AgentRuntime not-exposed gate suggests the nearest active tool — computer-control fire 47: a hallucinated tool name (`node_run` for `run_command`) hit AgentRuntime.executeToolCall's "not exposed" gate (checked before the executor), which returned a bare error — fire-9's nearestToolName only covered the executor's not-registered path. Generalized+exported nearestToolName (takes names) and wired it into the not-exposed gate so the model self-corrects. 4 unit + 2 integration (mutation-verified) tests; @muse/tools 96 / agent-core 133 green; Opus (4)b judge PASS. (detail in docs/goals/loops/computer-control.md fire 47)

- [done] :: file_grep truncated-result narrowing hint — computer-control fire 46 (post JUDGE-DRILL): a capped grep returned `truncated:true` with no guidance, so the 12B paged blindly / concluded off a partial match set. The grep tool now adds a `hint` to its truncated return (both files+content modes) telling the model to pass a more specific pattern (and a glob if none was given). Only on truncation (no pollution of a complete result); static guidance string (fabrication 0). 3 mutation-verified OUTCOME tests; @muse/fs 62 green; Opus (4)b judge PASS. (The fire's JUDGE-DRILL first injected an INERT unwired version which the verifier correctly FAILED — detail in docs/goals/loops/computer-control.md fire 46.)

- [done] :: learning-surfacing fire 1: `projectRecentlyLearned` (`@muse/memory/recently-learned.ts`) — deterministic, source-cited projection of "what Muse recently learned about you" from the append-only `factHistory` (each item cites `updated from "X" on DATE`; CODE selects, not the 8B; fabrication 0). Foundation for CLI/web surfaces to consume. 6 mutation-verified tests; @muse/memory 505 green; full build green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 1)
- [done] :: learning-surfacing fire 2: `renderRecentlyLearnedLines` (`@muse/memory/recently-learned.ts`) — deterministic presentation of fire-1's projection: humanises the key, ALWAYS embeds the source citation, and OMITS forgotten facts (`currentValue` undefined) so only currently-held, sourced learnings reach a surface. 4 mutation-verified tests; @muse/memory 513 green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 2)
- [done] :: learning-surfacing fire 3: `muse memory show` now prints a "Recently learned about you:" section — `readLocalMemory` computes it via `projectRecentlyLearned`->`renderRecentlyLearnedLines`, `formatMemoryShow` renders each cited line (`@muse/cli`, commands-memory.ts + human-formatters.ts). First user-facing surface where the user SEES cited learnings; local/file path only (API lacks factHistory -> absent, honest). 2 mutation-verified tests; @muse/cli 2861 green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 3)
- [done] :: learning-surfacing fire 4: `summarizeRecentlyLearned` (`@muse/memory/recently-learned.ts`) — compact one-line form (most-recent cited learning + "(+N more)") for space-constrained surfaces (status/today); reuses `renderRecentlyLearnedLines` so it inherits the forgotten-filter + citation (forgotten facts don't inflate the count), undefined when empty. 4 mutation-verified tests; @muse/memory 519 green; independent Opus (4)b judge PASS (value confirmed genuine, not inert). (detail in docs/goals/loops/learning-surfacing.md fire 4)
- [done] :: learning-surfacing fire 5: `muse status` now shows a compact "recently learned: <cited one-liner>" — new `readRecentlyLearnedLine(memoryFile, userId)` helper (typed-store read -> `projectRecentlyLearned`->`summarizeRecentlyLearned`), added to the status snapshot `persona.recentlyLearned` + human render. Second user-facing surface (daily-driver dashboard). 2 mutation-verified tests; @muse/cli 2869 green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 5)
- [done] :: learning-surfacing fire 6: recency window — `projectRecentlyLearned` gains an optional `sinceMs` lower bound (drops learnings older than it), and `muse status` wires a 30-day window so "recently learned" is truthfully recent (a months-old supersession no longer shows when changes are rare). Backward-compatible (no bound -> all, so `memory show` unaffected); `nowMs` injectable for deterministic tests. Mutation-verified in BOTH @muse/memory + @muse/cli; 523/21 green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 6)
- [done] :: learning-surfacing fire 7: preference learning — `FactSupersession` gains a `scope` ("fact"|"preference"), InMemory + File `upsertPreference` record preference CHANGES as supersessions, and `projectRecentlyLearned` resolves currentValue from the right store by scope. `muse memory show` + `muse status` now surface preference/veto/goal changes too (not just facts), for free. (4)b judge CAUGHT a File-store scope-not-persisting bug (the InMemory-only e2e test gave false confidence) -> fixed all 3 disk round-trip sites + added a write->fresh-read round-trip test (teeth confirmed); re-judge PASS. @muse/memory 529 green; @muse/cli surfaces 59 green. (detail in docs/goals/loops/learning-surfacing.md fire 7)
- [done] :: learning-surfacing fire 8: kind-aware citation verb — `formatSource` now says "changed from" (a mind-change / contradict) vs "refined from" (an elaboration / refine) vs "updated from" (legacy/absent), surfacing the `kind` field that's been computed since fire 1 but never shown — the user now sees HOW their model evolved. Real-formatSource-path ripple updated (projection + 2 status assertions); render/summarize literals are explicit sample sources (don't call formatSource). 1 new mutation-verified test (all three verbs); @muse/memory 531 + @muse/cli surfaces 50 green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 8)
- [open] :: learning-surfacing: remaining surfaces — (a) `muse today` one-liner (OWNED by `loop/surfaces` via commands-today.ts -> coordinate/dedup, do NOT touch unilaterally); (b) web self-improvement view "learned about you" section (@muse/web — also surfaces-adjacent). Same `project->summarize`/`render` invariant (deterministic, cited, fabrication 0).
- [done] 2026-06-27 :: learning-surfacing correction-confirmation surface — DONE (freshness-guard 2026-06-27): `chat-auto-memory.ts` builds the cited " Got it — home city is now Busan, changed from Seoul" confirmation from `selectNewSupersessions`, surfaced via `chat-ink-run.ts`. The identity-resonant "교정 후 확인" surface is live. Sub-slices below for the record:
- [done] :: (a) — learning-surfacing fire 10: `createUserMemoryAutoExtractHook` gains an optional `onLearned(supersessions)` callback that fires after the writes with only the entries recorded THIS turn — via a pure cap-robust `selectNewSupersessions(before, after)` diff (content identity, not position). Fail-open (outer+inner try/catch; no read when unsubscribed). Added the hook's FIRST test (changed-fact fires / first-time-fact does not). 6 cases mutation-verified (2 mutations); @muse/memory 543 green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 10)
- [done] :: (b) — learning-surfacing fire 11: `formatLearnedConfirmation(learned, memory)` -> " Got it — home city is now \"Busan\" (changed from \"Seoul\")." Deterministic + cited (current value from the store, prior from the recorded entry); scope-aware (preference vs fact); skips a since-removed value; undefined when nothing confirmable. Extracted the kind-verb into a shared `changeVerb` (fire-8 sibling-audit; formatSource reuses it, behaviour-preserving). Tested pure + END-TO-END through the hook (onLearned -> formatLearnedConfirmation -> line). 5 mutation-verified cases; @muse/memory 553 green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 11)
  - · (c) RE-DECOMPOSED (fire 12 discovery): the assumed single seam is wrong — there are TWO auto-memory paths. `createUserMemoryAutoExtractHook` (with fire-10 `onLearned`) is wired by `@muse/autoconfigure` (index.ts:825) into the AgentRuntime -> used by `muse ask` / the API, NOT by chat. `chat-ink.ts` has its OWN path: `autoLearn` (chat-ink.ts:1009, an internal closure) calls `extractMemoryFromTurn` + `memoryStore.upsertFact/Preference` + `formatLearnedSummary` (" remembered: …", no prior-value citation). So:
- [done] :: (c1) — learning-surfacing fire 13: chat now CITES the prior value the moment a fact/preference is corrected — " Got it — home city is now \"Busan\" (changed from \"Seoul\")." Extracted `applyTurnLearnings(store, userId, facts, preferences)` into `chat-auto-memory.ts` (snapshot factHistory -> upserts -> `selectNewSupersessions` [fire 10] -> `formatLearnedConfirmation` [fire 11]; a changed key shows ONLY in the confirmation, not double-listed in the "remembered" summary); `chat-ink.ts`'s `autoLearn` calls it. Finally lands fire-10/11 in PRODUCTION; breaks the @muse/memory monoculture. 3 mutation-verified cases; @muse/cli 2890 green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 13)
  - 불가 (c2) MOOT (fire 14 finding): `muse ask` sets `skipUserMemoryAutoExtract: true` (commands-ask.ts:2181) — recall surfaces deliberately do NOT auto-extract (to avoid distilling the model's own assertions as user facts). So an `ask` turn never learns/corrects -> there is nothing to confirm. The agent-core hook's `onLearned` (fire 10) only fires for non-recall agent runs (API/server), which have no CLI render. Dropped — not worth the autoconfigure plumbing for zero CLI value.
- [done] :: learning-surfacing fire 14: `muse recap` (the proactive evening digest) now surfaces a cited " Recently learned about you" section — `composeEveningRecap` renders it, `gatherEveningRecap` computes it (`FileUserMemoryStore.findByUserId(resolveMemoryUserId)` -> `projectRecentlyLearned`(30-day window) -> `renderRecentlyLearnedLines` -> `safeRecapText` injection-neutralized, fail-soft). Distinct from the volatile-belief confirm-nudge (informative vs action). The theme's literal "Muse shows what it learned FIRST, unprompted". 2 mutation-verified cases; @muse/cli 2892 green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 14)
- [done] :: learning-surfacing fire 15: closes the FIRST-TIME-LEARNING gap — every prior surface only showed CHANGES (a recorded supersession); a brand-new fact records none, so it was never surfaced. New `selectRecentlyLearnedFacts(provenance, {now, withinDays, maxResults})` (@muse/memory, sibling of `selectVolatileBeliefs`) selects keys first learned within the window AND stable (`distinctValueCount === 1`), cited by the recorded `firstSeen`; `muse recap` appends them to the recentlyLearned section (CHANGES first, first-learnings after) from the provenance it already reads. Three-way distinct (changes/volatile/first-learned mutually exclusive on distinctValueCount -> no double-count). New test file `belief-provenance-store.test.ts` (4 mutation-verified cases); @muse/memory 47 + recap 33 green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 15)
- [done] :: learning-surfacing fire 16: sibling-audit — `muse brief` (the MORNING digest) now surfaces a cited " Lately about you — <line>" beat, the sibling of the evening recap's section (fire 14) and the status line (fire 5). New `brief-learned.ts` (`formatBriefLearnedLine` = `summarizeRecentlyLearned` + injection-neutralize), wired into the brief action's beat chain from the `userMemory` it already reads (fail-soft, 30-day window). New test file `brief-learned.test.ts` (3 mutation-verified: cited line / forgotten->undefined / `<<end>>` neutralized); @muse/cli 2895 green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 16)
- [done] :: learning-surfacing fire 17: HONEST ATTRIBUTION on the first-learned recap lines — "(you told me · DATE)" for a USER-stated fact vs "(I noticed · DATE)" for one Muse auto-inferred. `RecentlyLearnedFact` gained `source`, carried from `FactProvenance.source`; new `formatFirstLearned` (@muse/memory) does the attribution wording; `muse recap` uses it. Trust calibration — the user can target corrections at inferences. "you told me" can't be fabricated (source="user" only when a confirmation was genuinely user-stated). 3 mutation-verified cases; @muse/memory 572 + recap 33 green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 17)
- [done] :: learning-surfacing fire 18: surfaces the FORGETS half of the identity — `muse recap` now has a " Forgotten at your correction" section (the user sees "FORGETS the moment you correct it" took effect). New `selectRecentlyForgotten` (@muse/memory) selects keys whose NEWEST belief-provenance event is a `retraction` (explicit forget, via `recordRetraction` from chat `/forget` + `muse memory forget`) within the window — a re-`set` clears it (newest-event-wins, same rule as `keysWithActiveRetraction`) — cited by the retraction date. Distinct kind from the LEARNED surfaces (retraction markers, not factHistory). 3 mutation-verified cases + 2 recap render cases; @muse/memory 578 + recap 35 green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 18)
- [done] :: learning-surfacing fire 19: sibling-audit — the canonical `muse memory show` ("what I know about you") now also shows a "Forgotten at your correction:" section, the sibling of fire 18's recap-forgotten and fire 3's memory-show-learned. `readLocalMemory` computes it via `selectRecentlyForgotten(readBeliefProvenance(...), 365d)`; `formatMemoryShow` renders it after the learned section (fail-soft, non-empty-only). The primary memory surface is now honest both ways (learned + forgotten). 2 mutation-verified render cases; @muse/cli human-formatters 31 green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 19)
- [done] :: learning-surfacing fire 20: JUDGE-DRILL (firesSinceDrill hit 10) — injected a bad slice (formatFirstLearned hardcoded to "you told me", fabricating user-attribution for auto-inferred facts, with the test rubber-stamped green); the independent Opus (4)b judge FAILED it with 5 concrete violations (non-deterministic constant / fabrication / test rubber-stamp / docstring contradiction / exact fix), proving the verifier isn't a rubber-stamp; rolled back clean. Then the real slice: `muse status` now shows a compact "recently forgotten: <line>" (new `readRecentlyForgottenLine`, the sibling of fire 5's learned line) — forgotten is now on ALL 3 daily surfaces (recap, memory show, status). 3 mutation-verified cases; @muse/cli status 24 green; independent Opus (4)b judge PASS on the real slice. (detail in docs/goals/loops/learning-surfacing.md fire 20)
- [done] :: learning-surfacing fire 21: honesty fix on the DEEPEST citation surface — `muse memory why <key>` was resurfacing the STALE pre-forget value for a key you had Muse FORGET (deriveFactProvenance excludes retraction markers, so it rebuilt the dropped fact), i.e. the "show your work" surface lied about a forgotten fact. `formatBeliefWhy` now checks `keysWithActiveRetraction` first and renders "(you had me forget \"key\" on DATE — I no longer hold it)" instead; a re-`set` after a retraction reopens it (normal provenance). +normalizeMemoryKey at the call-site so it's robust for all keys. 3 mutation-verified cases; @muse/cli commands-memory 12 green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 21)
- [done] :: learning-surfacing fire 22: deepest provenance — `muse memory why <changed-key>` now shows the VALUE PATH ("value path: Seoul (2026-06-10) -> Busan (2026-06-20)"), not just "changed 2× (volatile)". New pure `beliefValueTimeline` (@muse/memory; excludes retractions, collapses consecutive re-confirmations, oldest->newest) + `formatBeliefWhy` renders it when distinctValueCount > 1. The user sees HOW their belief evolved, each step a recorded entry (cited, no model). 4 mutation-verified cases; @muse/memory 584 + commands-memory 13 green; independent Opus (4)b judge PASS. (detail in docs/goals/loops/learning-surfacing.md fire 22)
  - 주의: BLOCKED (fire 17 finding): the web/API "learned about you" surface is MOOT until the SERVER-side user-memory store records `factHistory` — the compat store (`compat-user-memory-store.ts` / `toUserMemoryResponse`) carries facts/preferences/recentTopics but NOT factHistory (fire 3's note re-confirmed), so `projectRecentlyLearned` over it is always empty. Unblocking = a foundation slice (server store records supersessions on upsert, e.g. reusing `collectFactSupersessions`) before any @muse/web view; that store is infra/surfaces-adjacent.

- [done] :: eval:multifile-fix grades OUTCOME not path — computer-control fire 45 (fire-9 residual): the eval gated on `modelRanTest` (toolsUsed.includes("run_command")) alongside `testPasses`, but the harness verifies `testPasses` independently via runTest(), so requiring the model to self-run was redundant path-grading that under-counted correct fixes (agent-testing.md). Extracted pure `gradeMultifileFix` (scripts/lib/), ranTest now observational-only; 6 mutation-verified node:test cases. eval:edit-run-verify keeps its run-gate intentionally (run->verify is its measured capability). (detail in docs/goals/loops/computer-control.md fire 45)

- [done] :: reflection-guard registry drift — computer-control fire 45 regression: fire 32's extraction of runResistingFalseDone removed chat-repl's `const actNow` marker; registry repointed to packages/agent-core/src/false-done-reprompt.ts (verifier pairing intact). LESSON: a refactor that moves a retry/verifier symbol must also update the reflection-guard registry marker — add to the extraction sibling-audit checklist.

- [open] :: run_command `maxOutputBytes` is named BYTES but the tool slices with `.slice()` (UTF-16 code units), so a multi-byte (Korean/emoji) output under-counts vs the byte budget — pre-existing naming/semantic mismatch (noted computer-control fire 44). Low priority: either rename to maxOutputChars or do true Buffer-byte truncation that never splits a multi-byte char. Gate: `pnpm --filter @muse/tools test`.

- [done] :: run_command silent-truncation flag — computer-control fire 44: the run_command tool re-sliced output by the model's `maxOutputBytes` but kept `truncated` from the runner, so a cap that cut the log left `truncated=false` and the model read partial output as complete. Now `truncated: response.truncated || capTruncated` (set when the cap actually shortened either stream; never flips a real true->false). 3 mutation-verified tests; @muse/tools 92 green; Opus (4)b judge PASS (detail in docs/goals/loops/computer-control.md fire 44).

- [done] :: path-refusal self-correction hint — computer-control fire 43: the fs sandbox's `outside_roots` refusal (`resolveSafePath`, @muse/fs) named no allowed root, so a 12B picking a bad path retried blindly. It now appends `Allowed roots: <roots>. Retry with a path under one of these.` (outside_roots branch only; deny-list/secret refusals stay opaque). Surfaced to the model via refusalResult. 2 mutation-verified tests (names-roots + deny-list-opacity); @muse/fs 39 green; Opus (4)b judge PASS (detail in docs/goals/loops/computer-control.md fire 43).

- [done] :: stringified-JSON object/array tool-arg coercion — computer-control fire 42: the deterministic arg-repair (`coerceToolArguments`, @muse/tools) only coerced scalar args; a 12B emitting a structured arg as a JSON string (file_multi_edit's `edits` as `"[{...}]"`) failed despite correct data. New `coerceStructured` losslessly parses a string arg back to its declared object/array shape ONLY when JSON.parse succeeds AND the type matches (fabrication=0 — parses, invents nothing; mismatch/non-JSON untouched). Shared fn -> covers ReAct executor + plan-execute. 9-assertion mutation-verified test; @muse/tools 89 green; Opus (4)b judge PASS (detail in docs/goals/loops/computer-control.md fire 42).

- [done] :: OpenAI-family tool-call NAME sanitization — computer-control fire 41: the OpenAI-compatible `/v1/chat/completions` path (LM Studio/OpenRouter/Ollama-compat) parsed tool-call names RAW, the unaudited sibling of agent-hardening fire-11's Ollama-adapter `sanitizeToolCallName`. Lifted that function to the shared `provider-shared.ts` leaf and wired all 4 OpenAI-family name-parse sites (parseOpenAIToolCalls + Responses non-stream/stream + chat-stream materialize). Local model leaking a chat-template marker (`run_command<|channel|>`) into a name now resolves instead of tool-not-found; fabrication=0 (cut/strip/"unknown" only). Pairs with fire 40's arg-drop sibling on the same path. 6 mutation-verified tests; @muse/model 375 green; Opus (4)b judge PASS (detail in docs/goals/loops/computer-control.md fire 41).

- [done] :: evening-recap derived-context neutralization: gatherEveningRecap wraps all 14 untrusted free-text segments (belief value/key, titles, names, topics) with neutralizeInjectionSpans+escapeSystemPromptMarkers before the digest is sent off-box — closes the OWASP ASI06/ASI07 summary-exfil hole (doctrine P5) — context-strategy fire 21 (detail in docs/goals/loops/context-strategy.md)

- [done] :: stale-fact caution propagated to the chat persona (buildMusePersona staleKeys + chat-repl staleFactKeys) — full ask↔chat mark-parity (contested/provisional/stale); fire-16 deferred chat-side done (doctrine P3 #3) — context-strategy fire 20 (detail in docs/goals/loops/context-strategy.md)

- [done] :: conversation-trim summary overshoot fixed: trimConversationMessages reconciles against the HARD budget after inserting the compaction summary (re-trims removable history; summary + last user turn never dropped) — context-strategy fire 19 (detail in docs/goals/loops/context-strategy.md)

- [done] :: URL-guard filename carve-out (bare filename like report.txt no longer false-refused; zip/mov gTLDs stay guarded) + JUDGE-DRILL passed (verifier caught a wired-but-inert + tautological-test slice) — context-strategy fire 18 (detail in docs/goals/loops/context-strategy.md)

- [done] :: exemplar selection precision: stop-word down-weighting in @muse/prompts scorer (function-word-only query no longer injects an off-topic few-shot demo into the 12B window; doctrine P1/P4; arXiv:2506.03100) — context-strategy fire 17 (detail in docs/goals/loops/context-strategy.md)

- [done] :: stale-fact point-of-use caution in <<memory>> grounding block (staleFactKeys via classifyFactFreshness; contested->provisional->stale precedence) — months-stale fact no longer asserted as confident (doctrine P3 #3; SSGM arXiv:2603.11768) — context-strategy fire 16 (detail in docs/goals/loops/context-strategy.md)

- [done] :: malformed-base64 image attachment dropped at the Ollama adapter seam — no silently-dropped image yielding a confident text-only 'vision' answer (arXiv:2404.18930) — grounded-vision fire 7 (`a68647b0`)

- [done] :: vision extraction primitive schema-required fail-close — extractStructuredFromImage rejects a hollow/missing-required extraction at the source (no partial result downstream; AppWorld arXiv:2407.18901) — grounded-vision fire 5 (`2f3e933a`)

- [done] :: vision input gate magic-byte content check — loadImageAttachment fail-closes on non-image bytes + ships sniffed mimeType (MLLM input-integrity arXiv:2404.18930) — grounded-vision fire 1 (`a670dec5`)
- [done] :: chat-ink readImage shared the vision input-integrity gap — `muse chat --image` now content-sniffs via the shared leaf (readImageAttachment), fail-close on non-image bytes (arXiv:2404.18930) — grounded-vision fire 2 (`ae37c354`)
- [done] :: vision field-level partial-apply — drop un-grounded OPTIONAL fields + apply grounded core, fail-close only on a REQUIRED field (no un-grounded value persisted; arXiv:2404.18930) — grounded-vision fire 3 (`0f301103`)
- [done] :: vision weak-numeric grounding guard — a bare short (≤3-digit) numeric value can't ground a field on a coincidental digit match (discount %/clock time); strictly stricter, no over-drop (arXiv:2404.18930) — grounded-vision fire 4 (`5b66ce16`)
- [done] :: vision amount-field-role grounding — a `total` grounds only on a currency-anchored run; closes the $2026-as-total leak AND repairs the fire-4 $40 over-drop (arXiv:2404.18930) — grounded-vision fire 6 (`f3ca1cb0`)
- [done] :: repo byte-hygiene: commands-logo.test.ts raw ESC bytes — already resolved on origin/main (raw-ESC count 0, @muse/shared byte-hygiene gate green); stale note cleared — cli-excellence fire 5
- [open] :: vision contact partial-apply degenerate-action notice: when a contact's name is grounded but its only email/phone is dropped, dropUnverifiedOptional recomposes to route:none/fields:{} and the apply path prints a misleading `[done] Done:{added:false}` (the contacts store fail-closes so there's NO write — cosmetic only). Detect the degenerate (no required method left) and print a clear "couldn't apply — no grounded contact method" instead. Gate: `pnpm --filter @muse/cli test`. (grounded-vision fire-3 judge residual)
- [done] :: URL/domain grounding-value guard on the sync chat gate (answerAssertsUnsupportedUrl -> abstain) — closes the fabricated-link class the number/email/identifier guards miss (doctrine P2; Netcraft phishing-URL harm) — context-strategy fire 15 (detail in docs/goals/loops/context-strategy.md)

- [done] :: orchestrate-path worker output neutralized (buildOrchestrationResponse both fan-ins) — completes fire-13's ASI07 hole; tracked results keep raw for trace fidelity (doctrine P5) — context-strategy fire 14 (detail in docs/goals/loops/context-strategy.md)

- [done] :: sub-agent worker output neutralized at the lead-worker fan-in (runOne neutralizeInjectionSpans) — blocks inter-agent injection/forged-citation propagation (doctrine P5, OWASP ASI07) — context-strategy fire 13 (detail in docs/goals/loops/context-strategy.md)

- [done] :: episodic-fade reinstatement-on-reaccess: a faded session re-engaged recently (live recallStats) is exempted from FADE_PENALTY — never silently down-rank a still-recalled source (doctrine P3/P4; mem0 decay-unless-reaccessed) — context-strategy fire 12 (detail in docs/goals/loops/context-strategy.md)

- [done] :: durable/provisional/contested fact-caution PARITY on chat persona (buildMusePersona marks volatile/once-seen facts like ask does; doctrine P3 consolidation-spine sub-slice 1) — context-strategy fire 11 (detail in docs/goals/loops/context-strategy.md)
- [done] :: RESOLVED (agent-hardening fire 12, `2f62ee0f`): single-marker dependent decomposition — a request with ONE sequencing marker + a real cross-step dependency ("노트를 검색한 뒤 그 결과를 요약해줘") now fans out (was dropped to single-agent by the `sequencing >= 2` gate, starving the sequenced-threading). Done the structurally-sound (split-first) way the fire-11 blocker prescribed: new `singleMarkerDependentSplit` helper splits on the ordered marker FIRST (`extractSequencedSteps`), then runs the existing `listHasBackReference` on the split clauses (items[1..]); wired as a `sequencing >= 1 && singleMarkerDependentSplit` gate rule. STABLE-0 new-rule FP on a 31-case adversarial benign corpus incl. the fire-11 mention-of-a-step class; independent Opus (4)b judge PASS (0/22 over-fires on its own corpus). REMAINING (conservative under-fire, low priority): a sentence-INITIAL KO marker ("먼저 …하고 그 결과를 …") leaves the marker at clause position 0 so the split yields 1 clause and the rule can't admit it — a future fire could add a leading-marker-aware split if real traffic shows the miss matters. Also latent (pre-existing, fire-11-noted): "step 1"/"next," each in BOTH SEQUENCING_SIGNALS and the back-ref set -> a benign "Next, what did step 1 say?" double-counts to seq=2 and trips the EXISTING `sequencing>=2` rule.
- [done] :: RESOLVED (agent-hardening fire 14, `4db07c35`): MARKER-LESS dependent two-step decomposition — the no-ordered-marker half of the MAST gap (fire 12 closed the single-marker half). "오늘 매출을 집계해. 그 결과를 정리해." / "Pull the list. Use those results to draft a note." carry a real cross-step dependency but had NO ordered marker, so they ran BLIND on a single agent (step 2 acts ON step 1's absent output -> fabricated result the per-subtask grounding gate can't catch). FIX: new `sentenceSplitDependentTwoStep` SPLITS on sentence boundaries (`.。!！?？`), then requires `listHasBackReference` in a NON-interrogative TAIL clause (act-ON "그 결과를 정리해" fires; ask-ABOUT "그 결과는 어땠어?" excluded); gated `signals.sequencing === 0` so it's strictly additive (marker requests still owned by the marker path). Wired into BOTH shouldDecompose + decomposeRequestWithKind (gate↔split consistent -> lead-worker threads step 1 output into step 2, e2e-probe confirmed). STABLE-0 new-rule FP: maker 16-note + independent Opus (4)b judge's own 22-note KO+EN benign corpus, both zero over-fires; (4)b judge re-ran all mutations (force-false->4 RED, drop-`?`-guard->1 RED) VERDICT PASS. REMAINING (low priority): a 3+-sentence dependent CHAIN only threads the 2-step shape today (each tail clause still gets prior context, but the helper's name reflects the 2-step framing); a sentence-INITIAL marker case is still owned by the fire-12 path. eval:orchestration + eval:decomposition PASS live.
- [done] :: RESOLVED (agent-hardening fire 15, `96da29f2`): one-shot tool-calling reliability — the Ollama adapter's `safeParseToolArgs` returned `{}` on any `JSON.parse` failure of a STRING-typed `tool_calls[].function.arguments`, silently dropping ALL of a local model's tool arguments when the emitted string carried a recoverable surface-form defect (a markdown ``` fence, leading/trailing preamble prose). gemma4:12b then fired the tool argument-less despite SELECTING correctly AND filling args. FIX: new pure `recoverToolArgsJson` (`packages/model/src/adapter-ollama.ts`) — on parse failure it (a) strips a markdown fence + reparses, then (b) runs a STRING-AWARE balanced-brace scan to extract the outermost `{...}` (a `}` inside a string value never terminates early) + reparses, returning the object only if it's a plain object else `undefined` (caller keeps `{}`). LOCATE-only — never rewrites token contents, so recovered values are byte-faithful (STABLE-0 fabrication: `"not json"`, arrays, scalars, Python literals, single-quoted JSON all stay `{}`). Diversifies off the saturated @muse/tools arg-coercion seam (f9/f10/f13): different pkg (@muse/model), different layer (provider response parse, not post-validation coercion). Selection-neutral. MUTATION-FIRST: neuter -> 6 recovery tests RED, 14-case FP corpus GREEN; independent Opus (4)b judge's own 50+-case adversarial corpus (cross-object splice / nested hijack / brace-in-string) found zero fabricated values — VERDICT PASS. REMAINING (deferred, low priority): the OpenAI-compatible adapters (`adapter-openai.ts`) parse tool-arg strings via their own path; a future fire could audit whether they share this drop-on-defect class (the OpenAI Responses/chat shape rarely wraps args in prose, so lower traffic). [done] RESOLVED — computer-control fire 40: `parseToolArguments` (`provider-openai-parse.ts`, the OpenAI-compatible `/v1/chat/completions` path backing LM Studio/OpenRouter/Ollama-compat) HAD the same `catch { return {} }` drop bug; now recovers via the shared `recoverToolArgsJson` leaf (lifted from adapter-ollama into `provider-shared.ts`, behavior-identical, both adapters import it). 5 mutation-verified recovery cases + fabrication guard; @muse/model 369 green; Opus (4)b judge PASS (detail in docs/goals/loops/computer-control.md fire 40).

- [done] :: content-free grounding-header guard: optionalGroundingSections drops present:true blocks with empty body (no citable-looking header backing nothing; doctrine P2/P4) + JUDGE-DRILL passed (verifier caught an inert unwired-helper slice) — context-strategy fire 10 (detail in docs/goals/loops/context-strategy.md)

- [done] :: memory-fact value now wrapper-marker-escaped (escapeSystemPromptMarkers in renderMemoryFact) — closes the <<memory>> block breakout/forged-citation vector (OWASP ASI06, doctrine principle 5) — context-strategy fire 9 (detail in docs/goals/loops/context-strategy.md)

- [done] :: selectFilePassages per-source char-budget overshoot fixed (fit-before-admit + top-1 floor; AdaGReS arXiv:2512.25052) — context-strategy fire 8 (detail in docs/goals/loops/context-strategy.md)

- [done] :: shared the lexical matcher (tokenMatchesKeywordWord exported from @muse/tools, agent-core copy deleted) — closes the fire-5 drift bug class structurally; arXiv:2502.04073 — context-strategy fire 7 (detail in docs/goals/loops/context-strategy.md)

- [done] :: query-relevance threaded into the cross-block edge-place — fire-1's dormant relevance? path activated (episode recall score blended with tier on a shared 0-1 scale; arXiv:2410.05983) — context-strategy fire 6 (detail in docs/goals/loops/context-strategy.md)
- [done] :: NL tool-SELECTION parser skips a negation-led tool mention — "don't use X, use Y" / KO "X은 쓰지 말고 Y" no longer resolves to the REJECTED tool X (MAST reasoning-action mismatch, arXiv:2503.13657); earliest NON-negated mention wins, all-negated -> no tool; affirmative path + eval:tools:nl 7/7 unmoved — agent-hardening fire 13 (`7880ab64`, detail in docs/goals/loops/agent-hardening.md)

- [done] :: JUDGE-DRILL (fire 10) — confirmed the (4)b independent Opus judge CATCHES a deliberately vacuous (declaration-only) test for a tool-arg-repair slice; then shipped the real slice: numeric tool-arg coercion accepts an explicitly-signed-positive value ("+5" -> 5) so a one-shot call from the local model executes — agent-hardening fire 10 (`8cec8359`, detail in docs/goals/loops/agent-hardening.md)
- [done] :: k-sample self-consistency consensus for the per-claim RGV judge (verifyGroundingPerClaim, --verify-claims) — fewer false-drops, fail-open, unanimous-NO still drops (Self-Consistency arXiv:2203.11171) — paper-grounded fire 5 (`2a46383e`)

- [open] 2026-07-13 :: S5 egress-authorization 잔여 (C1/C2 SHIPPED 2026-07-13, Opus 2회 리뷰 통과·실측 검증): **C3** = 공유 `assertEgressAuthorized` chokepoint를 loopback-fetch/web-download/browser-nav/feeds에 배선(직접 tool.execute 호출자·daemon feed sync를 caller-origin으로 커버; 현재 agent-run tool-call 경로만 게이트됨). **C4** = (1) 비-URL 문자열 잎(header 값 등)에 `argDerivesFromCorpus` WARN 레이어 유지 — URL 규칙이 못 보는 exfil 채널; (2) `muse.search` query는 차단 아닌 감사(action-log)만; (3) outbound-safety.md에 egress 규칙+정직한 한계 기록. **MINOR 잔여**: confirm 판정이 read 툴에서 무음 통과(fan-out 캡이 유일 방벽) — UX상 surface 여부 결정 필요; 다음 턴 트랜스크립트에 옛 compaction 요약이 non-assistant role로 남으면 assistant-작문 URL 세탁 가능(compaction 저장 포맷 확인 필요). **honest limits**(닫히지 않음): 링크-선택 채널(캡으로 bound만), 외부 MCP 서버 자체 egress(allowlist가 통제), scheme-less host 인자(DNS 서브도메인 exfil).
- [open] 2026-07-13 :: lethal-trifecta NETWORK-sink taint gate (2026-07-13 원칙 서베이, docs/strategy/agent-principles-2026.md): outbound-safety는 send를, LOCAL_ONLY는 모델 egress를 막지만 web_fetch/browse GET은 자유 — 컨텍스트에 untrusted 콘텐츠가 든 턴의 fetch URL에 컨텍스트-유래 토큰이 실리면 (attacker.com/?q=<private>) "읽기"로 위장한 exfil. 기존 injection-provenance taint를 네트워크 싱크까지 확장(태인트 시 allowlist/param-strip). Willison lethal-trifecta + Anthropic egress-control 근거.
- [open] :: approval-rate 계측 (approval fatigue, Anthropic 93% rubber-stamp 근거): 게이트 클래스별 approve/deny를 action log에 집계 + muse doctor 노출; >90% 승인 클래스는 프롬프트 추가가 아니라 pre-approved 안전 클래스 확장 신호.
- [done] :: Fixed eval:judge grounding-tier k≥5 (agent-testing.md k≥5) — agent-reliability fire 7: per-scenario `minRepeat` 메커니즘(floor를 3 위로만 raise, Math.max 클램프) 추가 + eval:judge=minRepeat:5+기본5. 라이브 STABLE 5/5 선검증(15/15 케이스 각 5/5, gemma4:12b) 후 올림 — floor가 5로 강제되니 fail-closed. (4)b PASS. DOC TENSION(LOW): dev-loop.md §"grounding/safety엔 MUSE_EVAL_REPEAT=3 자동"는 이제 eval:judge와 불일치(=3이면 eval:judge hard-fail, k≥5 doctrine상 의도된 fail-closed) — pick-evals가 eval:judge를 라우팅 안 해 자동경로는 안 걸림, 사람이 =3 붙일 때만; dev-loop.md 정정은 별도.
- [done] :: Fixed consent TTL/expiry — agent-reliability fire 2 (standing consent에 expiresAt; 만료/손상 timestamp는 fail-CLOSED로 인가 거부; ConLeash arXiv:2605.11360). 잔여: grant call-site가 아직 expiresAt를 세팅 안 함(enforcement primitive는 live, 부여 UX는 후속).
- [done] :: P4 tool-use-tax 감사 CLEAN — agent-reliability fire 2 (arXiv:2605.00136): tool 스키마에 모델-precompute 인자(*Iso/duration/offset/epoch) 부재 — tool-time-field lesson이 이미 스윕. Muse는 순수계산을 툴로 우회 안 함(음성 확증).
- [open] :: eval:tools over-invocation/IrrelAcc는 이미 촘촘(fire 2 확인, EXHAUSTED vein): 인사·감사·순수생성·키워드함정·리포트·단위언급·명절·musing 커버. 새 no-tool 케이스 추가는 padding — 하지 말 것.
- [done] :: Fixed egress advisory audit-sink (surfacing SEAM) — agent-reliability fire 4: executeToolCall이 egress 판정(confirm/deny — 지금껏 read 경로서 보이지 않던 non-user-initiated fetch)을 주입 `egressAdvisorySink`로 넘기고, autoconfigure assembly가 action-log에 append(surface된 OUTCOME=파일 엔트리로 E2E 검증, fire-1 lesson). agent-core는 model-agnostic 유지(sink 주입). (4)b fix: egress 엔트리는 gateClass 생략(approval-rate 텔레메트리 오염 방지)+URL은 redactSecretsInText+500캡(시크릿-모양 토큰이 recall->cloud 역-exfil 방지). 이제 C4의 confidentiality-warn·search-audit이 이 sink로 surface 가능.
- [done] :: Fixed S5 C4-a confidentiality WARN (audit-sink 위 재개) — agent-reliability fire 6: 비-URL 잎(header 값 등)이 first-party 코퍼스의 ≥2 연속-토큰 스팬(사용자가 안 친)을 실으면 egressAdvisorySink로 "confidentiality" 감사(fire 1 롤백분, 이제 fire 4 surface 있음). de-noise=멀티-토큰 스팬(fire 1의 단일-단어 .some 노이즈 해결). `sharesPrivateSpan`+`collectNonUrlStringLeaves`. end-to-end action-log 파일 검증. (4)b PASS. residual(문서화): 단일 opaque 시크릿(무구분자 1토큰)은 2-gram 불가라 미탐(URL은 fire-4 redaction 커버); stopword 2-gram("application json")은 가끔 spurious 1줄(warn-only). 하드닝=stopword/entropy 필터(minSpan 올리기 아님).
- [open] :: S5 C4-b muse.search query 감사: 나가는 검색어(web_search류 external, muse.search는 로컬이라 저가치)를 egressAdvisorySink로 기록 — 어느 툴이 query를 egress하나 판별이 fuzzy(값-형태 URL처럼)라 스코프 주의. OUTCOME=action-log 엔트리. (C3 chokepoint=직접 tool.execute/daemon은 대개 trusted-origin이라 저가치 재평가; agent-run은 C1/C2 커버.)
- [open] :: (fire 6 (4)b residual) C4-a de-noise 하드닝: stopword/entropy 필터를 `sharesPrivateSpan` n-gram에 — 감사로그 노이즈가 실제로 나타나면. + 단일 opaque 시크릿 in 비-URL 잎 커버(현재 미탐, niche).
- [done] :: Fixed P3 brief-CoT 툴콜 A/B (arXiv:2604.02155) — agent-reliability fire 3: MEASURED baseline(thinking-off) 374/376=99% vs brief-CoT 373/376=99% (gemma4:12b, repeat=1) = NEUTRAL/미세 손해. 베이스라인이 이미 99% 포화라 헤드룸 無 -> thinking-off 기본값 데이터-확증, **P3a(어댑터 모드) 안 만듦(dead infra 회피)**. opt-in arm은 모델 스왑/harder golden set 재측정용으로 유지. 계측도구=measure-first가 production 변경 전에 잡음. detail=agent-research-findings-2026.md P3.
- [open] :: S5 C4(a) NO-SHIP (agent-reliability fire 1, Opus (4)b FAIL — 롤백됨): 비-URL 잎 exfil WARN을 *계산해서 게이트 입력*에 실었으나 **어느 게이트 표면도 read-risk 경로에서 non-blocking egressWarning을 렌더 안 함**(channel-approval-gate/chat-ink-core/commands-board 모두 read면 allowed:true 조기반환, egressWarning은 deny 경로서만 소비) -> headline(read-class fetch)이 사용자에게 무경고 = 미전달(agent-testing.md #1). LESSON: 보안 슬라이스는 계산-only가 아니라 **surface된 OUTCOME을 채점**해야 하고 **compute->surface end-to-end 한 슬라이스**로 스코프할 것. 재작업 스펙: (1) read-path 게이트 ≥1곳에 advisory 렌더(차단 아님)+표면 검증 테스트, (2) `.some` 단일토큰 매치는 노이즈(application/json/mozilla가 노트와 겹치면 상시 경고=rubber-stamp) -> high-entropy/멀티토큰-스팬 신호로 강화 후 surface, (3) 그때 backlog/doc은 "seam wired" 아닌 실제 "closes gap"로만 마킹. 설계 재사용 가능: collectNonUrlLeaves(@muse/tools, collectUrlsFromValue의 complement) + argDerivesFromCorpus 재사용은 건전했음(사이클 없음, WARN-never-block airtight 확인). URL+시크릿 한 문자열 잎은 skip되는 한계는 문서화 유지.
- [open] :: position-sensitivity LIVE battery (`eval:position` candidate): the Lost-in-the-Middle mitigations (within-block `reorderForLongContext`, cross-block `edgePlaceByPriority`, span retention) are all verified deterministically (permutation/set-equality/mutation) but never MEASURED on gemma4:12b — a needle-at-position grounded-recall probe (same fixture note planted at head/middle/tail of a k-chunk context, grounded-answer rate per position, reorder ON vs OFF A/B) would prove the delta the mitigations claim and catch a model swap that changes the position curve. LOCAL OLLAMA ONLY, MUSE_EVAL_REPEAT≥3.
- [done] 2026-07-13 :: API ask route now passes `extras.refineChunks` — the web console's ask had NO near-dup dedup and NO Lost-in-the-Middle reorder (CLI-only since the @muse/recall extraction); wiring pinned by ask-routes.extras.test.ts (2026-07-13 session)
- [done] :: inflection-aware tool-relevance matching — capToolsByRelevance ranking now agrees with the @muse/tools selection layer (lights->light kept past the cap; CJK 할 일 over-match fixed) — context-strategy fire 5 (detail in docs/goals/loops/context-strategy.md)

- [done] :: query-anchored span retention in the per-result cap (ACON arXiv:2510.00615 / Lost-in-the-Middle arXiv:2307.03172; keeps the load-bearing middle span the query needs, verbatim, neutralize-first) — context-strategy fire 4 (detail in docs/goals/loops/context-strategy.md)
- [done] :: default relevance-ranked tool-exposure ceiling on the live runtime path (Less-Context-Better-Agents arXiv:2606.10209 / MemTool arXiv:2507.21428; enforces tool-calling.md ≤5-7, lossless tail-drop) — context-strategy fire 3 (detail in docs/goals/loops/context-strategy.md)
- [done] :: stale-observation masking in the model loop (The-Complexity-Trap arXiv:2508.21433 / ACON arXiv:2510.00615; ref-recoverable, fixes unbounded multi-turn context growth) — context-strategy fire 2 (detail in docs/goals/loops/context-strategy.md)
- [done] :: cross-block grounding-block edge-placement (Lost-in-the-Middle arXiv:2307.03172 / Attention-Basin arXiv:2508.05128) — context-strategy fire 1 (detail in docs/goals/loops/context-strategy.md)
- [done] :: RGV recall gate ignored the conformal-calibrated MUSE_GROUNDING_MIN_COSINE (KnowNo arXiv:2307.01928) — paper-grounded fire 1 (`b415f08f`)
- [done] :: whetstone misgrounding axis was blind on the CHAT surface (ASK-only); chat now records it (ALCE arXiv:2305.14627) — paper-grounded fire 2 (`1ee899bf`)
- [done] :: web Tasks 체크박스 버튼(open/done)이 aria-label 없어 스크린리더에 이름 없는 "button" — TaskCheckbox 추출 + aria-label — surfaces fire 53 (`4a337c3b`)
- [done] :: desktop 음성모델 다운로드 % 버블 truncation("99%" 고착)·sub-1% "0%" 노이즈·no-clamp("101%") + NaN trap — downloadProgressBubble(round+clamp+≥1%, NaN-safe) — surfaces fire 54 (`2a756c0a`)
- [done] :: web Dashboard tool-accuracy `Math.round(x*100)`이 극값 붕괴(0.999->"100%" 거짓 완벽·0.004->"0%") — formatAccuracyPct(비극단 보장) — surfaces fire 55, fire 54의 크로스-표면 형제 (`7b2f708c`)
- [done] :: cli "1 notes"/"1 entries" 복수 하드코딩(notes folders·feeds list·history 헤더 3곳, count=1) — 공유 `pluralize` 헬퍼 추출 후 라우팅 — surfaces fire 56 ((4)b judge가 형제 2개 적발->배칭) (`4f4894e7`)
- [done] :: web MCP 서버 관리 콘솔 — McpServersView(목록·상태·connect/disconnect, API 기존 완비) — surfaces fire 57, 진안 "웹에서 다 관리" 요청 1번째 (`05c219ba`)
- [done] :: 자기강화 대시보드 **API 토대** — `GET /api/self-improvement/weaknesses`(whetstone 약점원장 read-only, shapeWeaknesses 정렬) — surfaces fire 58; NEXT=웹 뷰가 이 API 소비 (`f9f1ddca`)
  - **웹 관리/자기강화 콘솔 로드맵** (진안 요청 "openclaw/hermes처럼 웹에서 MCP·설정·스킬·자기강화 다 관리"). MCP 콘솔(fire 57 done)에 이어 surfaces 루프가 fire별 배송:
- [done] :: web 자기강화 대시보드 (whetstone 약점원장 *읽기*) — `SelfImprovementView`가 fire 58의 `GET /api/self-improvement/weaknesses` 소비, 축 라벨·숙달도%·hint read-only 렌더; 형제 `formatProbabilityPct` 공유(Dashboard 위임)·`NavKeys.test` leader-key 가드 — surfaces fire 59 ((4)b judge가 NAV key="g"↔leader 충돌 FAIL->fix) (`deda3d6c`)
- [done] :: playbook 전략 API — read-only `GET /api/self-improvement/playbook` (shapePlaybook: reward DESC·probation/reward 정규화, ~/.muse/playbook.json, fire 58 weaknesses 미러) — surfaces fire 60 (`e778da32`); NEXT=웹 뷰가 이 API 소비(weaknesses 옆 "전략" 섹션)
- [done] :: web 학습된 전략 섹션 — `SelfImprovementView`가 fire 60 playbook API 소비, active/probation 정직 구분(strategyStatusLabel·summarizeStrategies)·tag·origin·reward 렌더 — surfaces fire 61 (JUDGE-DRILL: judge#1이 honesty-역전 나쁜슬라이스 FAIL->fix->judge#2 PASS) (`2624028e`)
- [done] :: reflections API — read-only `GET /api/self-improvement/reflections`(shapeReflections: listReflections recency정렬·sourceCount=sourceIds.length grounding신호, autoconf resolveReflectionsFile) — surfaces fire 69 (JUDGE-DRILL: judge#1이 sourceCount필드-conflate FAIL->fix->judge#2 PASS) (`c5bf5484`); NEXT=웹 reflections 섹션
- [done] :: web reflections 섹션 — `SelfImprovementView`에 fire 69 reflections API 소비(insight·supportCount·sourceCount, summarizeReflections grounded=sourceCount>0) — surfaces fire 70 (`feb85e9e`); 자기강화 콘솔 3 read 섹션 완성
- [done] :: FIXED (cross-loop 회귀): `packages/memory/recently-learned.ts:127` raw NUL(0x00) 3개 -> ` `(byte-hygiene 게이트 복구, 전 루프 unblock) — surfaces fire 70
- [done] :: CLI resolver 통일(형제) — `resolveAuthoredSkillsDir`/`resolveSkillRewardsFile`/`resolveReflectionsFile` 모두 autoconfigure 공유본 위임(하드코딩 리터럴 제거, gate-asymmetry 청산) — surfaces fire 71
  - · web 자기강화 대시보드 (나머지) — eval 스코어보드 *읽기* (dev-INFRA라 개인 콘솔 노출 여부 재검토; weaknesses+playbook+reflections done)
  - · web 스킬 컨트롤 — skills 목록 + reward/curate/author (신규 API + 웹):
- [done] :: skills 목록 API — read-only `GET /api/self-improvement/skills` (shapeSkills: authored 스킬+reward 병합, reward DESC·name ASC, avoided=isSkillAvoided; autoconfigure `resolveSkillRewardsFile` 신설) — surfaces fire 62 (`cffe2d94`); NEXT=웹 뷰가 이 API 소비(새 Skills 뷰/nav)
- [done] :: web Skills 뷰 — `SkillsView`(자체 nav key "j") fire 62 skills API 소비, 이름·설명·source·reward·avoided 배지(정직신호) read-only 렌더; summarizeSkills 헬퍼 — surfaces fire 63 (`a1f44f18`); reward/curate/author 액션은 후속
- [done] :: skill reward API (상태변경) — `POST /api/self-improvement/skills/:name/reward` (parseRewardDelta·auth·adjustSkillReward, 무효->400 no-op, smoke 누적+부작용0 증명) — surfaces fire 64, 첫 웹콘솔 write 라우트 (`e55867d7`); NEXT=Skills 뷰에 thumbs up/down 버튼이 이 라우트 호출
- [done] :: web Skills reward 버튼 — `SkillsView` / 버튼이 fire 64 POST reward 라우트 호출(useMutation+invalidate `["skills"]`); canAdjustReward로 [-5,5] 경계 no-op 차단 — surfaces fire 65 (`0e082ec8`); 스킬 컨트롤 read+write end-to-end 완성
  - · web Skills curate/author — 스킬 활성/비활성·세션에서 스킬 작성(authorSkillsFromSession 기존) 웹 노출 (상태변경, 후속)
- [done] :: CLI 스킬 resolver 통일(형제) — autoconfigure 공유본 위임 완료 — surfaces fire 71
  - · web 설정/daemon 토글 — proactivity·episodic·skill학습·watch daemon on/off:
- [done] :: daemon-flags read API — `GET /api/settings/daemon-flags`(shapeDaemonFlags: 6 플래그 effective on/off, parseBoolean 데몬과 동일 resolver, settings-routes.ts) — surfaces fire 67 (`668c4df5`); NEXT=웹 Settings 뷰가 소비
- [done] :: web Settings 데몬 카드 — `SettingsView`에 "Background daemons" 카드(fire 67 daemon-flags API 소비, label+on/off 배지, summarizeFlags "N of M enabled") — surfaces fire 68 (`2433dbfb`); 설정 콘솔 읽기-side 완성
  - · 토글 write (DECOMPOSED — fire 73 Opus 분석): 데몬 플래그 on/off는 **아키텍처 브리지** 필요. 근본 원인: 모든 플래그 read-site가 `parseBoolean(env.X)`를 **assembly/startup 시점**에 읽고 runtime-settings store를 안 봄(server.ts:103·autoconf:1091에 store는 있으나 미연결). runtime PUT만으론 inert(데몬이 env만 봄)=정직성 위반("on" 표기하나 실제 off). loop-sized 슬라이스:
   - · S1: 브리지 seam `resolveEffectiveFlag(key, env, runtimeSettings)`(runtime override > env > default) 순수+테스트
   - · S2: read-site를 per-request/재평가로 바꿀 수 있는 첫 플래그 선정(startup-only 아닌 것) + 그 read-site를 S1 경유로 배선(이게 "데몬이 토글을 honor"의 핵심, 아키텍처 변경)
   - · S3: `PUT /api/settings/daemon-flags/:key`가 runtime-settings에 override write(auth·bool 검증·contract-faithful 라운드트립) + fire-67 GET이 effective(override 반영) 보고 — **S2와 같은 fire에**(없으면 inert/거짓표기)
   - · S4+: 나머지 플래그 read-site 점진 배선(플래그당 1 fire, honor 확인 후에만 GET이 그 플래그 override 반영)
   - 주의: S3를 S2 없이 단독 출하 금지(정직성). 첫 honest 슬라이스 = S1+S2+S3 한 플래그 end-to-end.
  - BLOCKER-HIGH(공유 main 회귀, 비-surfaces): `@muse/autoconfigure` runtime-assembly e2e가 **HANG**(`runtime-assembly-e2e/cache-e2e/streaming-e2e`·`autoconfigure.test`·`background-review-wiring`, 60s timeout도 미완=진짜 행, saturation 아님). origin/main 머지된 타루프 agent-run 회귀 추정(agent-core logprobs `792a408a` / execute-tool reserve `232f04e9` / model 변경). **전 루프 pnpm check + API 조립 차단**. agent-core/model/multi-agent 오너가 bisect+fix 필요(surfaces 도메인 아님). 발견 surfaces fire 75.
  - 주의: FLAKY(공유, 비-surfaces): `@muse/model/src/web-search-policy.test.ts > property fuzz > never throws…`가 ~1/3 비결정 실패(격리 2/3 통과) — 모든 루프 merge-to-main을 간헐 차단. @muse/model 오너/test-hygiene 루프가 fuzz 생성기 seed 고정 필요
- [done] :: web MCP allowlist 보안 섹션 (읽기) — `McpServersView`가 `GET /api/mcp/security` 소비, 허용목록·도구출력 상한 표시; summarizeAllowlist의 빈목록=unrestricted 정직신호 — surfaces fire 66 (`eac90550`)
- [done] :: web MCP allowlist 편집 — `McpServersView` Security 섹션 add/remove 컨트롤이 `PUT /api/mcp/security` 호출(addToAllowlist/removeFromAllowlist, effective 정책 read-modify-write로 allowedStdioCommands+maxToolOutputLength 보존) — surfaces fire 72 (judge가 stdio-clobber 적발->shaper/타입에 allowedStdioCommands 노출+보존으로 fix) (`a3a357a9`)
  - · web MCP 서버 add/remove (config) — 서버 자체 등록/삭제(allowlist 아닌 서버 config CRUD) 후속
- [done] :: Playbook eviction PEVI-parity (PEVI arXiv:2012.15085): `retainPlaybookEntries` now ranks bank-overflow survival on the Wilson-LCB `retentionUtility` (inline-replicated `rankingUtility`, NOT the rolled-back `effectiveStrategyReward` shrinkage), so a thin-but-lucky strategy no longer evicts a battle-tested one; no-tally falls back byte-identically to clampReward(reward) — self-improvement fire 1
- [done] :: chat resolves a topic's grounding-gap on a GROUNDED SUCCESS (`isChatGroundedSuccess` + `chatResolveWeakness`, BKT mastery, ask-parity) so a now-answered recurring gap stops nudging — self-improvement fire 4 `9f2f484b`
- [done] :: doctor `WEAKNESS_AXIS_LABEL` friendly labels for source-conflict + misgrounding (user-facing `formatWeaknesses`) — self-improvement fire 5 `1bde1536`
- [done] :: ACT-R spacing guard on memory PROMOTION (`selectPromotableMemories.minDistinctAccessDays`, default 2): a single-session burst doesn't graduate into the always-on persona; PROMOTE-side sibling of fire-3 fade floor — self-improvement fire 6 `8b12d589`
- [done] :: Self-consistency WRITE-admission gate on distilled strategies (`distillConsistentStrategy`, conformal-abstention arXiv:2405.01563 + ReasoningBank MaTTS 2509.25140): k=3 drafts, bank the medoid only if they AGREE (mean Jaccard ≥0.5) — extends fabrication=0 from read->learning-write — self-improvement fire 8 `b467b9c3`
- [done] :: FOLLOW-UP DONE (self-improvement fire 10 JUDGE-DRILL): `distillConsistentStrategy.onReject(agreement)` telemetry fires on the disagreement-reject path (read-only) so the 0.5 floor's false-reject rate is measurable — `af25e7c2`. [done] NEXT DONE (fire 12): `distillSessionCorrections` consumes it -> `DistillResult.lowConsistencyRejected` observable from a real session — `66d153e4`.
- [done] :: Salience-weighted eviction for the REFLECTION store (Generative Agents arXiv:2304.03442): `scoreReflectionRetention`/`selectRetainedReflections` (@muse/mcp reflections-store) trim cap-overflow by recency+salience(min(1,support/5)) not pure recency, so a high-support recurring insight isn't evicted for a thinner newer one; equal-support -> legacy recency — self-improvement fire 11 `c9e7fe4b`
- [done] :: FOLLOW-UP closed: `selectReflectionsForRecall` (salience+recency, reusing scoreReflectionRetention) now orders the ask-grounding recall surface, so a RETAINED high-support old insight actually reaches the top-K injected prompt; `listReflections` stays newest-first for display. — self-improvement fire 23 `602b675b`
- [done] :: Skill write-time body-subsumption dedup (Voyager arXiv:2305.16291): `writeOrPatch` now skips authoring a draft whose PROCEDURE-body is a subset (directional containment ≥0.85) of an existing skill — the name/desc Jaccard never inspected the body, so fresh-named near-dups slipped through to the curator's idle merge. Directional (superset never suppressed), fail-open, non-destructive. — self-improvement fire 24 `35bd3dd9`
  - · NIT (judge fire 24, low-prob): `consolidate`'s umbrella write routes through `writeOrPatch`, so an umbrella could in principle be subsumption-skipped against an unrelated surviving skill and then mis-reported as merged. Near-zero (umbrellas are supersets -> low containment) + non-destructive; if it ever bites, add a `writeOrPatch(draft, {skipSubsumption:true})` opt for the consolidate path.
- [done] :: Cross-session check-in auto-discharge (π-Bench arXiv:2605.14678): `selectDischargedCommitments` (@muse/agent-core) cancels a STANDING scheduled check-in when the user reports it done in a later session (marker AND cosine ≥ existing COMMITMENT_DISCHARGE_COSINE) — the in-session filter only saw one conversation. Wired into BOTH scan seams (CLI `scanSessionCheckins` + daemon `scanCommitmentsFromTurns`, discharge before the no-commitment early-return). Conservative, fail-soft, no new threshold. — self-improvement fire 25 `04661584`
- [done] :: Doctor `formatWeaknesses` excludes MASTERED topics (`!isMasteredWeakness` + "· N mastered" note) — runtime-nudge mastery parity, no more nagging a fixed topic — self-improvement fire 13 `e7656eb8`
- [done] :: Write-time NOVELTY gate on episodic memory (Mem0 NOOP arXiv:2504.19413 + SAGE arXiv:2605.30711): `isEpisodeNovelVsRecent` in `captureEndOfSessionEpisode` drops a near-dup session (token-Jaccard ≥0.8 vs 10 most-recent); embedder-free, fail-open, subtractive — self-improvement fire 14 `fd2a3516`
- [done] :: Utility-aware authored-skill eviction (SkillOps arXiv:2605.13716 + TinyLFU arXiv:1512.00727): `rankSkillsForEviction` makes `enforceCap` evict lowest-utility (never-used before ever-used, ties LRU) not FIFO-by-age; degrades to FIFO with no usage data (no regression) — self-improvement fire 15 `1f86f39c`
- [done] :: RESOLVED (agent-hardening fire 16, `0304823e`): **Memory factHistory refine-vs-contradict LABELING** (Mem0 arXiv:2504.19413; Zep arXiv:2501.13956). Both decomposed halves shipped in one cohesive slice. (a) `FactSupersession.kind?: "refine"|"contradict"` set by the EXISTING `classifyValueChange` (token-subset) in `collectFactSupersessions`; File store serialize/deserialize round-trips it (deserialize validates the enum, drops corrupt); back-compat (absent on legacy -> "was" framing). (b) `buildFactTimeline`/renderer (commands-memory.ts) carries `kind` into `FactTimelineEntry.previous[]` and prints "refined from" / "changed from" / "was". STRICTLY ADDITIVE (previousValue byte-faithful, kind DERIVED not invented — fabrication 0); conservative-safe (a real flip is ALWAYS "contradict" by the strict subset check; case-only + KO token-disjoint refinements fall to "contradict" = over-warn, never hide). Sibling-audit: muse-persona/chat-ink read only key/previousValue/replacedAt (invisible to the new field). MUTATION-FIRST RED ×2 (neuter classifier->3 refine tests RED; drop render kind-propagation->carry test RED). Independent Opus 4.8 (4)b judge (own 15-case KO+EN corpus, mutation re-run, scope audit) VERDICT PASS. @muse/memory 484/484 + @muse/cli 2814/2814 + lint clean.
- [done] :: Self-consistency write gate on the IDLE distiller (`distillQueuedCorrections`, @muse/autoconfigure) — sibling parity with the sync path; the default-on autonomous learner now draws k=3 drafts and banks only on agreement (was single one-shot draft). arXiv:2405.01563 — self-improvement fire 17 `1fd3fb8b`
  - **EFFICACY AUDIT findings (fire 17, 3 Opus audits, codegraph-verified)** — answering "is self-improvement REAL / are the mechanisms correct?". HEALTHY+live-default: whetstone ledger, Mem0 auto-extract + belief-provenance (File store), Playbook ranking (rankingUtility Wilson-LCB, no regression), skill select/usage/eviction. Open findings ranked:
- [done] :: ->partial **Cross-turn "experience-helps" — DETERMINISTIC retrieval proof** (the audit's #1, landable half): `experience-recall-cross-session.test.ts` proves an experience persisted in session 1 is RECALLED by a fresh provider in session 2 (file is the only link -> InMemory fails it), with empty-store/unrelated-query negatives. CI-gated, no Ollama, mutation-verified. — self-improvement fire 22 `6a99f621`
- [done] :: DONE (LIVE answer-quality delta): `verify-experience-delta.mjs` (eval:self-improving battery) — PRIMED session 2 recalls a session-1 fact from the file-backed store ("you live in busan."), EMPTY abstains ("i'm not sure") on the same question; the in-process runtime works on the box (only the HTTP server stalled). Empty arm asserts no-fabrication -> reinforces the floor. STABLE 3/3 maker + 3/3 judge w/ on-disk store inspection. groundedSurfaces 28->29. — self-improvement fire 27 `bf8e9083`
   - · small follow-up: userId-isolation negative (a save under a different user must not leak across users) — defensive privacy test, deterministic.
  - · **Episodic capture INERT for the default agent** — `captureEndOfSessionEpisode` early-returns unless `MUSE_EPISODIC_MEMORY_ENABLED` (default false), so ALL its write gates (outcome/grounding/salience + fire-14 NOVELTY) never fire for default users; the persona block that reads the episodes file always sees empty. Decide: flip default-on (it's fail-soft + write-gated so it won't store junk; privacy is local-only by construction) OR stop counting it as a default capability. Pre-verify pass^3 end-to-end (episode lands + surfaces next session).
- [done] :: Summary-store recall INERT in CLI — added `FileConversationSummaryStore` (@muse/memory) + defaulted the no-DB factory to it (PERSIST=false escapes to in-memory); summaries now persist across CLI processes so cross-session recall works + fade/promotion get fuel. Mutation-verified 2-process. — self-improvement fire 19 `932c3020`
- [done] :: FileTaskMemoryStore — in-progress task state (goal/plan/decisions/blockers) now persists across CLI processes; wrap-delegate-persist over InMemoryTaskMemoryStore (rebuilds active-session index, preserves timestamps so retention isn't reset), nested Dates round-trip, factory defaults no-DB to File (PERSIST=false escape). Mutation-verified cross-session. — self-improvement fire 21 `4926fce8`
- [done] :: CORRECTION: fire-17 wrongly rejected audit Finding "buildPlaybookProvider drops origin" as a hallucination — it was REAL (searched @muse/agent-core, but the fn lives in @muse/autoconfigure). Fixed fire 18 `7b860f8e`: origin now carried through `buildPlaybookProvider` (runtime/--with-tools/API) AND `selectPlaybookSection`/`topAppliedStrategy` (@muse/recall, default `muse ask` path) — reflected ranking penalty + CBR gate live again on all three. — self-improvement fire 18
- [done] 2026-07-02 :: **Playbook reinforcement-credit by INJECTED-ID set** (fire-26 ESCALATED, landed as ONE attended slice 2026-07-02 — all 3 seams together, exactly the "dedicated block" the escalation asked for): `applyPlaybook` records `metadata.playbookInjectedIds` (PlaybookStrategy.id added; both provider projections carry id) -> runtime surfaces it on `AgentRunResult` + stream `done` -> chat REPL persists per-session (`playbook-injections.jsonl`, `forwardRecordingInjections` passthrough) -> `moveReward` restricts credit to the recorded set (empty intersection = NOTHING moves, fail-closed; absent record = legacy cosine, byte-equivalent — 12 existing tests pinned on that arm). OUTCOME-verified: headline test proves a correction decays the ACTUALLY-injected strategy while the cue-nearest never-injected bystander stays untouched; mutation RED both seams; gate testFiles 1196->1197, agent-core 2741 + cli distill/injections 23 green, lint 0.
  - 불가 REJECTED (fire 26 verify-the-rationale) **BKT-Forget time-decay of a mastered weakness** (scout pick, pyBKT arXiv:2105.00385): the `lastResolved` field IS dead (written weakness-ledger.ts:447, never read) and the seam is empty — BUT the mechanism is SEMANTICALLY WRONG for this domain. A "mastered" weakness = Muse reliably GROUNDS the topic (≠ a student's decaying skill); Muse's grounding doesn't erode with idleness, so time-decay would re-NAG a resolved topic with NO evidence of regression. Genuine regression is ALREADY caught (a new failure -> `recordWeakness`->`bktUpdate(false)`->pKnown drops->re-surfaces). So the "one-way ratchet bug" framing is false (idle ≠ regression). Same reason it was rejected at fire 14. Don't re-pick.
- [open] :: Cross-package Playbook parity test: eviction's inline Wilson-LCB (packages/mcp) hand-mirrors agent-core's `rankingUtility`/`wilsonInterval`; a same-(r,d)->same-utility test spanning both packages would fail-close on silent drift if agent-core's formula changes (judge-flagged residual risk from paper-grounded fire 4; the shipped eviction code is self-improvement's equal implementation).
- [done] 2026-07-03 :: due-date-reasoning regression RESOLVED WITHOUT A CODE CHANGE (2026-07-03 re-verify) — the 2026-07-02 finding ("'not due for ~a week?'" answering the wrong task, 2× identical) no longer reproduces: STABLE 4/4 clean on gemma4:12b today. Both dates in the fixture (tomorrow, +10 days) are computed relative to `new Date()` at run time, so the SPECIFIC calendar dates differ day-to-day — the prior failure likely depended on a date/weekday combination the model handled worse (e.g. a date crossing a month boundary, or a specific day-of-week framing) rather than a stable capability gap. LESSON: a live-eval "2× identical" run on ONE calendar day is not yet `pass^k` across REAL condition variance when the fixture's inputs are date-relative — a battery with a `new Date()`-derived fixture should log the actual computed dates on failure so a future re-run can distinguish "same failure, still broken" from "different dates, coincidentally resolved." Not adding artificial date-pinning now (would just trade one narrow untested path for another); re-open if it recurs with the actual failing dates captured.
- [open] 2026-07-02 :: Test-hermeticity: 2 tests fail on a lived-in box (verified pre-existing on clean main 2026-07-02, PASS on clean HOME/CI): `autoconfigure.test.ts` "respects MUSE_LLM_WORKING_BUDGET_TOKENS=0" (assembly reads real `~/.muse` state -> prompt exceeds the 200-token cap -> hard_limit not none) and `commands-daemon.test.ts` "does NOT decay when correction does NOT contradict" (seeded reward 3->2 — an extra decay leaks in from real box state). Fix = inject a hermetic HOME/env into both.

- [done] :: performConsentedAction followed redirects with the Bearer credential attached (credential-exfil, gap-scout DONE): `consented-action.ts` fetched with the default `redirect:"follow"`, but the host-binding guard vets only the ORIGINAL url — so a 3xx from the consented host pointing elsewhere had `fetch` auto-re-issue the request WITH `Authorization: Bearer <credential>` to an un-consented host (irreversible scoped-credential exfil; outbound-safety.md rule 5). web-action.ts already closed this with `redirect:"manual"`; the credential-carrying consent path hadn't. Fixed: `redirect:"manual"` + fail-close on any 3xx (refuse, credential never re-sent). Verified: @muse/mcp 1853 tests (+1 acceptance: a 302->evil host yields performed:false, fetch called exactly once on the consented host, the Bearer token never reaches evil.example.net) + full check + lint green.
- [done] :: performConsentedAction action-log omission — core-hardening fire 2 (rule 4: every outbound, sent OR refused, records a reviewable entry). Added opt-in `actionLogFile?`/`now?`/`idFactory?` + a `log()` helper appending one rationale-bearing `ActionLogEntry` before ALL 7 return branches (veto/no-consent/invalid-url/host-mismatch/timeout-or-transport-failed/redirect/performed); credential never logged, body secret-scrubbed+capped; absent file ⇒ no log (back-compat). Mirrors web-action.ts. OUTCOME-verified (@muse/mcp 1860 tests + Opus (4)b PASS).
- [done] :: Gemini/Anthropic adapters lose .retryable on a transport-level fetch rejection (gap-scout DONE): both called `this.fetchImpl(...)` with NO try/catch, so a connection-level failure (ECONNREFUSED/DNS = a raw `TypeError` with no HTTP status) escaped untyped — the OpenAI-compatible + Ollama paths wrap it into `ModelProviderError(retryable:true)` but these two cloud adapters didn't. architecture.md: "ModelProviderError.retryable is the source of truth" — the same blip was then classified inconsistently (api server `isRetryableUpstreamError`->false=permanent; agent-core catch-all->true). Fixed by lifting the wrapper into a shared exported `fetchOrThrowAsProviderError` in `provider-base.ts` (one source of truth for transport-error shaping) and calling it from all three adapters (OpenAI-compat refactored to delegate; Gemini + Anthropic wrapped). Ref: MDN fetch (network error -> TypeError, no status). Verified: @muse/model 318 tests (+2: a rejecting fetch yields ModelProviderError retryable:true for each cloud adapter) + full check + lint green. (Note: only reachable under MUSE_LOCAL_ONLY=false, but the adapter contract must hold regardless.)
- [done] :: ReAct path enum/const argument enforcement (gap-scout DONE): the default `muse ask`/chat ReAct loop (`agent-runtime.ts` `executeToolCall`) coerced types + checked required args but did NOT enforce closed-vocabulary `enum`/`const` constraints — only the plan-execute path did (`validateEnumArguments`), so an 8B fabricating an out-of-schema enum value (`to:"base64"` for an enum of binary/octal/decimal/hex) reached the handler (crash, or a write/actuator running a meaningless mode) — a `tool-calling.md` #3 + same-runtime (`cli-product.md`) inconsistency. Fixed by wiring the existing `validateEnumArguments` into the ReAct path right after the required-arg check, fail-close: an out-of-enum value returns a `blockedToolResult` (the model self-corrects within `maxToolCalls`), the handler is never invoked. Ref: BFCL AST argument-value checks (gorilla.cs.berkeley.edu). Verified: agent-core 2436 tests (+2: out-of-enum blocked & handler-never-invoked, valid-enum executes) + full check + lint green.
- [done] :: ask failure-trace observability (capability-boost fire 6 retry -> DONE): `commands-ask.ts` now defines a fail-soft `writeAskFailureLog(errorMessage)` and calls it from all 3 ask failure paths (`--with-tools` runtime-missing, the agent-run catch, the chat-only stream-error) — each reuses the already-tested `buildAskRunLog({ success:false, grounded:null, errorMessage, … })` and `return`s BEFORE the end-of-run success trace, so there's no double-write. A failed `muse ask` now leaves a `success:false` run-log trace, so `scout-signals` / doctor failRate can finally see ask failures (chat-repl already did). Verified: build + lint green, cli suite green, and a fire-6 payload-contract test in program-helpers.test.ts pins the exact emitted shape (success:false + non-empty error + grounded:null + empty response/tools). Honest bound: the 3 call sites are wiring over a tested builder (the ask mega-command has no integration harness in-repo); the builder + payload contract are unit-tested, the wiring is build-verified.

- [done] 2026-06-07 :: vision write-path grounding gate (capability-boost fire 5 retry -> DONE): `vision-actions.ts` now runs an INDEPENDENT evidence transcription (a separate `describeImage` pass) and a deterministic `gateVisionAction`/`fieldIsGrounded` over every extracted field — a value not confirmable in the evidence lands in `action.unverified`, is flagged in the draft, and the `--apply` path REFUSES the autonomous write while unverified is non-empty (code gate, not a prompt). The 3 fire-5 defects are fixed: (a) digit grounding requires only ≥4-length runs (year/amount/phone-block) so a worded-month date ("June 7" ⇒ "2026-06-07" via the year) and a country-code phone are NOT false-dropped, with a word/entity (incl. CJK) majority fallback for text; (b) empty/failed evidence fails CLOSED (every field unverified), matching the text precedent; (c) false-drop regression tests landed (worded-month date, country-code phone, separator amount, CJK). Verified: 9 new unit tests + `eval:vision` asserts the gate doesn't over-drop the real fixtures' headline fields — STABLE 3/3 on gemma4:12b; full check + lint green.

[done] (freshness guard, 2026-07-03) poisoned-source fires 13-15 blocker resolved — fires
13-18 (FINAL) all merged to main (86746f93 etc.), superseded.

## Open — Muse edge hardening (WIDENED loop theme, 진안-directed 2026-06-20 after fire 8)

The grounding/injection sub-theme below is essentially COMPLETE (fires 1-7 + SSRF/curator/recall already built). 진안 widened the loop to four surfaces — **memory-integrity · self-development · orchestration · grounding-floor** — keeping the grounding edge as the maintained floor. Candidates below are GAP-SCOUT-VERIFIED open (Opus, codegraph-checked — three named items [skill curator, playbook RL, ask->orchestration wiring] were confirmed ALREADY BUILT and are NOT listed). Pick the top by value.

> **VEIN STATUS (core-hardening fire 11, honest exhaustion of CLEAN 1-fire core-edge slices THIS session).** Fires 1-10 shipped verified hardening across all 6 touched (pkg,kind): grounding-floor (agent-core injection ×2), local-tool-calling (model Ollama-schema), orchestration (multi-agent re-synthesis), anti-fabrication (agent-core gate-total), memory-integrity (memory noop + recall source-conflict), outbound-safety (mcp consented-log) — plus 2 verifier-catches (fire 6 KO-injection 68% FP, fire 10 drill). REMAINING core-edge items are NOT clean 1-fire: (a) source-conflict ADDRESS_LABELS home/street = marginal additive (fire-10 residual, low value); (b) groundToolArguments deep-nesting = speculative no-caller (fire-7 residual); (c) KO injection act-as/output-clamp = needs LARGE benign corpus + heuristic (fire-6 blocker, >1 fire); (d) source-conflict comma list-vs-value general case = >1-fire redesign; (e) self-development BKT/whetstone resolution = agent-core-cognition LOOP territory, not core-hardening 1-fire; (f) doctor weakness-selector consistency = design-choice ("honest dump, not nag"), not a bug. NEXT high-value moves are DELIBERATE >1-fire decomposes or a retheme — 진안 to choose (pause / pick a decompose / retheme). Auto-firing will otherwise produce thin/exhaustion fires.

- [done] :: (G1) **Surface the `source-conflict` weakness axis for remediation** — DONE (competitor-grounding fire 9, self-development): `source-conflict` (the user's OWN saved notes disagree — written to the ledger since fire 5 but read by NO selector) is now user-remediable: `USER_REMEDIABLE_AXES = {grounding-gap, source-conflict}` in `selectRemediableWeaknesses`, `RemediableWeakness` carries its `axis`, and new `remediationHint(axis, topic)` renders the DIFFERENT fix per axis ("add a note about X" vs "your saved notes about X disagree — reconcile them"). The evening recap (`commands-recap.ts`) renders each via its hint under an axis-agnostic header. OUTCOME-verified end-to-end (a source-conflict ledger entry -> gatherEveningRecap -> reconcile copy, NOT "add a note") + Opus (4)b judge PASS 6/6 (verified EXHAUST: of the 7 axes, only 4 are production-WRITTEN and all 4 now read by a selector — source-conflict was the lone written-but-unread). RESIDUAL ·: doctor `WEAKNESS_AXIS_LABEL` lacks friendly labels for source-conflict/misgrounding (safe `?? axis` fallback today — cosmetic).
- [done] :: (G2) **Unify the injection neutralizers — give the live-surface neutralizer policy's evasion-decoding** — DONE (competitor-grounding fire 10, grounding-floor; this fire was also the JUDGE-DRILL). BOTH chokepoints now match against `@muse/policy`'s `normalizeForInjectionDetection` (entity-decode + NFKC + zero-width-strip + homoglyph-fold + diacritical-strip): `isMemoryInjection` (atomic facts) + `neutralizeInjectionSpans` (ALL tool/MCP/sub-agent output via capToolOutput + the two plan-execute paths + note/episode/feed prose). So a homoglyph-`іgnore` / `&#105;gnore` injection in tool output / recall prose is now neutralized. KEY DESIGN: `neutralizeInjectionSpans` uses a clean-text FAST PATH — if the normalized form has no injection it returns the ORIGINAL byte-identical, so normalization's diacritical/NFKC collateral is paid ONLY on injection-containing (untrusted) text; clean accents/fullwidth recall content is never mangled. Judge verified NO fast-path false-negative (normalization only ADDS matchability for the ASCII patterns -> superset). OUTCOME-verified end-to-end (capToolOutput + note-chunk homoglyph neutralized; clean accented byte-identical) + Opus (4)b judge PASS 6/6. Closes T1-c-resid ii.
- [done] :: (G3) **Per-fact provenance (firstSeen / lastConfirmed / confirmCount / freshness)** — DONE (competitor-grounding fire 11, memory-integrity). STALE-finding corrected: NO risky `facts`-store migration was needed — the per-fact provenance DATA already exists in the append-only `BeliefProvenance` log (`@muse/memory/belief-provenance-store.ts`: `learnedAt` written on every learn, by auto-extract + `muse memory set`). New `deriveFactProvenance(entries)` aggregates the log per key -> `{firstSeen=min, lastConfirmed=max, confirmCount, source=user-outranks-auto, value=at-latest}`; new `classifyFactFreshness({lastConfirmed,now,agingDays=30,staleDays=90})` -> fresh/aging/stale. Wired end-to-end into `muse memory why <key>` (renders "confirmed N× since <firstSeen> · <freshness>"). OUTCOME-verified + Opus (4)b judge PASS 6/6 (mutation-tested). UNBLOCKS G4.
- [done] :: (G4) **Memory-promotion gate — durable user-fact promotion from gated recurrent confirmation** — DONE (competitor-grounding fire 12, memory-integrity). New `selectPromotableFacts(provenance, {now, minConfirmCount=3, recentDays=90, isInjection?})` (mirrors `selectPromotableMemories`): a fact earns DURABLE status iff NOT injection-flagged AND (`source==="user"` [user truth outranks inference, immediate] OR (`confirmCount≥3` AND recent)). FAIL-CLOSE: an injection-flagged value is NEVER promoted however often confirmed; the `isInjection` check is dependency-injected (CLI passes the real `isMemoryInjection`) so @muse/memory stays agent-core-free. Pure (selects, never promotes-in-place — no partial side-effects). Wired into `muse memory why <key>` ("· durable" / "· provisional"). OUTCOME-verified (5 gate cases + the end-to-end fail-close via the wired detector) + Opus (4)b judge PASS 6/6. Consumes G3's `deriveFactProvenance`.
- [done] :: (G4-followup) **Tie durable-vs-provisional to GROUNDING** — DONE (competitor-grounding fire 14, memory-integrity + grounding-floor). New pure `provisionalFactKeys(matchedKeys, provenance, {now, isInjection?, normalizeKey?})` (@muse/memory) = matched facts KNOWN in the provenance log but NOT durable (a key with no provenance entry is UNKNOWN, not over-marked). `buildMemoryContextBlock(facts, {provisionalKeys})` (@muse/recall) renders a provisional fact with " (unconfirmed — learned once, not yet re-confirmed)". `muse ask` (commands-ask.ts) loads the belief-provenance log, derives, computes provisional keys (real `isMemoryInjection` + `normalizeMemoryKey`), passes them — FAIL-SOFT (no provenance ⇒ no mark). So a once-seen auto-extract (possible mis-extraction) is grounded cautiously, not asserted as confirmed (GROUNDED != TRUE on the source side). OUTCOME-verified end-to-end (log -> provisional -> annotated block; injection value marked AND defanged = defense-in-depth) + Opus (4)b judge PASS 7/7. (Honest scope: deterministic marking + prompt signal — not a claim the 8B fully obeys the tag.)
  - ⊘ (G5) **Chat-path auto-orchestration parity with `ask`** — DEFERRED (competitor-grounding fire 13, Opus orchestration scout). Verified genuinely-unbuilt (chat-repl.ts has ZERO decompose refs), BUT a POOR FIT: chat is a STREAMING continuous-companion REPL; `runDecomposedAgentAsk` is a non-streaming BATCH (N subtask runs + 1 synthesis, sequential on one GPU) -> bolting it in = a multi-second silent mid-conversation stall = UX regression on the exact surface built for liveness. The "don't fork behavior" non-negotiable is ALREADY satisfied at the ENGINE level (both surfaces share `agentRuntime`); decomposition is an ask-specific PRESENTATION concern, not core behavior. Defer, don't build.
- [done] :: (G6) **Subtask deduplication gate (MAST #3: no duplicated sub-agent work)** — DONE (competitor-grounding fire 13, orchestration). The Opus scout verified this was the ONE genuinely-open MAST gap (the other 4 — typed hand-off, bounded termination, failure-propagation, context-isolation — already enforced+tested). New `dedupeSubtasks` in `lead-worker.ts` (normalized-text keep-first, re-id, drop-empty) applied in `runLeadWorkerTask` AFTER both subtask sources (structural `decomposeRequest` + model `planner`) and before fan-out -> one chokepoint covers both AND the ask path (runDecomposedAgentAsk -> runLeadWorkerTask). ALSO fixed `parsePlannerLines` (the dedup surfaced it): the old `^[-*•\d.)\s]+` ate the leading `1` from `1분기 정리` -> `분기 정리`, MANUFACTURING identical subtasks; precise `^(?:[-*•]|\d+[.)])\s*` preserves `1분기`. OUTCOME-verified (duplicate planner subtask -> execute called once; distinct unaffected; markers stripped, 1분기 kept) + Opus (4)b judge PASS 6/6. Residual ·: structural-source dup covered-by-construction but not directly tested.

### Refill batch 2 (gap-scout fire 15, codegraph-verified open; G1-G6 + follow-ups all [done])
- [done] :: (H1) **Fan-in objective-satisfaction verifier for the live `ask` decomposition (maker≠judge)** — DONE (competitor-grounding fire 15, orchestration). The CLI ask synthesis was a shallow self-report (MAST "done-by-self-report"); the server had `verifyFinalAnswer` but the CLI path did not. New deterministic `verifySynthesisCoverage(finalAnswer, executions)` (@muse/multi-agent): a COMPLETED non-empty sub-task whose salient tokens are ENTIRELY absent from the synthesis is flagged dropped (conservative — a paraphrase passes). `LeadWorkerDeps.verifySynthesis?` + `LeadWorkerResult.synthesisIncomplete` (fail-soft); wired in `runDecomposedAgentAsk`; `muse ask` surfaces "주의: some sub-results may be missing" instead of returning confident-incomplete. OUTCOME-verified + Opus (4)b judge PASS 6/6. (Flag-only originally.)
- [done] :: (H1-followup) auto re-synthesis — core-hardening fire 5 (orchestration): `runLeadWorkerTask` now does ONE verifier-gated re-synthesis when the first synthesis drops a sub-result. Refactored to a `runSynthesis` helper; the retry prompt NAMES the dropped sub-results (`reinforceSynthesisRequest`, not a bare "try again") and is accepted ONLY if it was itself VERIFIED and drops STRICTLY FEWER results — so a retry can never worsen the answer, and an errored-verifier retry never clears the flag (no false completeness). Registered in `scripts/reflection-guard.test.mjs` (external verifier = `verifySynthesisCoverage`, arXiv 2510.18254). OUTCOME-verified (@muse/multi-agent 123 tests + ask-decompose wiring 4-vs-5-run cases + eval:orchestration PASS + Opus (4)b PASS).
- [done] :: (H2) **Value-volatility signal in the durable-promotion gate** — DONE (competitor-grounding fire 16, memory-integrity; fixes a flaw in the builder's OWN fire-12 gate). `FactProvenance` gains `distinctValueCount` (`deriveFactProvenance`: `new Set(group.map(e=>e.value.trim())).size`). `selectPromotableFacts`' AUTO branch now requires `distinctValueCount === 1` (stable) on top of confirmCount≥3 + recent — so a belief the auto-extractor gave CONFLICTING values for (address X->Y->Z, distinctValueCount 3) no longer auto-promotes as durable (it was the INVERSE signal: re-confirmation of a CHANGING belief). A USER-stated fact still promotes regardless of flips (latest = their truth). The provisional chain is AUTOMATIC (volatile -> not durable -> `provisionalFactKeys` -> "(unconfirmed)" in grounding, fire 14). `muse memory why` shows "value changed N× (volatile)". OUTCOME-verified + Opus (4)b judge PASS 5/5 (the chosen distinctValueCount metric is MORE conservative/fail-safe than a current-value-run alternative, which would auto-promote a previously-contradicted value — riskier for the grounding floor). UNBLOCKS H4.
  - (H3) **Cross-lingual source-conflict detection** — Hangul-labelled subset DONE (competitor-grounding fire 18 = JUDGE-DRILL, grounding-floor). `LABELLED_VALUE` was `[A-Za-z]`-only -> a Hangul-labelled field ("주소: 서울" vs "주소: 부산") never parsed and a Korean source-conflict was silently missed. FIX: label class -> `[\p{L}][\p{L}\p{N} ]` (BOTH chars Unicode) + Korean PROSE_LABELS (참고/참조/메모/예시/요약/주의/비고). Korean conflict now DETECTED, agreement/prose excluded, ASCII unchanged (superset). Opus (4)b judge PASS 5/5 (false-positive = parity with already-accepted English prose; all guards hold). **Remaining (· H3b, DEFERRED):** EMBEDDING-backed semantic pass — prose contradictions + EN↔KO SEMANTIC field matching ("주소"≡"address"), needs embeddings (reuse `detectEvidenceContradictions` topic-sim -> `contestedOutcome`).
- [done] :: (H4) **Surface volatile beliefs in the recap (close the H2 loop)** — DONE (competitor-grounding fire 17, self-development). New pure `selectVolatileBeliefs(provenance, {now, recentDays=90, minDistinctValues=2, maxResults=3})` (@muse/memory) = recently-active AUTO beliefs the extractor keeps flipping (distinctValueCount ≥ 2); a USER-stated belief is excluded (their latest is already deliberate truth). The evening recap (`commands-recap.ts`) renders " These keep changing — confirm the current value" with a RUNNABLE `muse memory set <kind> <key> <value>` nudge. Closes the monitor->detect->remediate loop: H2 demotes a volatile belief to provisional -> H4 nudges the user -> `muse memory set` re-states it user-source -> `selectPromotableFacts` promotes it durable. OUTCOME-verified (volatile auto surfaced, stable/user/stale excluded; end-to-end written-log -> recap nudge) + Opus (4)b judge PASS 5/5 (judge caught a malformed nudge command missing `<kind>` -> fixed in-fire so the command actually runs).

### Refill batch 3 (gap-scout fires 19-37)
- [done] :: (Z1) **Thread a TRUNCATION partiality notice into the synthesis prompt (close a fan-out GROUNDED≠TRUE leak) + JUDGE-DRILL** — competitor-grounding fire 37 (orchestration). When the lead-worker fan-out truncates the sub-task list to MAX_SUBTASKS (8), the dropped items never execute (not in `executions`, so `verifySynthesisCoverage` can't flag them). Before this fix, the synthesis prompt was identical to the untruncated path — the model presented the 8 survivors as a COMPLETE answer to an N-item (e.g. 11) request: a GROUNDED≠TRUE leak in the answer TEXT (the channel the user reads), the MAST "unaware of termination" failure for truncation-dropped subtasks. FIX: `truncatedSynthesisRequest(request, dropped)` appends an explicit partiality directive (`[부분 응답 — …${dropped}개가 처리되지 않았다…누락이 있음을 반드시 명시하라]`, mirrors the sibling `reinforceSynthesisRequest`); first synthesis + the re-synthesis retry base both carry it when truncated (sibling). ask-decompose `buildSynthesisPrompt` already embeds the engine-supplied request, so it reaches the model. This fire was the JUDGE-DRILL: a planted INERT version (helper returned the request unchanged + a test that only re-checked the pre-existing `truncated` flag) was caught FAIL by the independent Opus judge (live-captured the bare synthesis request), rolled back; the real fix went PASS 5/5 (dist-captured the directive end-to-end, mutation-proven — reverting to the inert helper turns 2 tests RED, sibling re-synthesis verified truncation-aware). multi-agent 171 / cli 2802.
- [done] :: (Y1) **Scope the session-end playbook reward loop to INJECTABLE strategies (no fabricated reward attribution)** — competitor-grounding fire 36 (self-development). The session-end reward loop `moveReward` (chat-distill-corrections.ts) credited/decayed a strategy chosen by cue-similarity against the ENTIRE bank — including ones NEVER injected this session (probation guesses, avoided/stale). So a PROBATION strategy (recorded but never injected by contract) could be silently REINFORCED by a cue-similar approval — a fabricated reward attribution that corrupts future ranking via experience-following (arXiv:2505.16067). The decay daemon already scoped to `bank.filter(isInjectableStrategy)` but the session loop didn't = inconsistency. FIX: the credit candidate pool now filters `isInjectableStrategy(e) && !isStaleStrategy(e, nowMs)` — EXACTLY the injection ranker's filter (playbook.ts:686), so "creditable" ≡ "injectable" (neither looser=bug-persists nor stricter=under-credits). OUTCOME + mutation verified (dist: probation strategy NOT credited even when most cue-similar; injectable still rewarded->1; graduated-off-probation still creditable) + Opus (4)b judge PASS 5/5 (filter byte-identical to ranker, no under-crediting). · FOLLOW-UP (deferred big one): crediting the WRONG injectable strategy when several are cue-similar still needs injected-strategy-ID threading through run->session-log->distill. Plus the gate-recovery sub-commit (raw ESC bytes -> `\u001b` in the goddess loop's commands-logo.test.ts, which was blocking pnpm check for ALL loops).
- [done] :: (X1) **Date-drift gate on the ASK path (the INVERSE of fire 31 — close the gate-asymmetry, de-dup monthDayKeys)** — competitor-grounding fire 35 (grounding-floor). The CHAT hard gate catches a drifted month-day date (fire 31), but the ASK value guard `answerAssertsUnsupportedValue` (agent-core) only caught bare digits/emails/named-entities — month names are stoplisted and a drifted day digit ("14") is waved through when any "14" appears elsewhere in evidence. So `muse ask` (the wedge surface) surfaced a wrong calendar/renewal/deadline date as grounded. FIX: `monthDayKeys` (ISO+prose+KO, case-sensitive months) moved INTO @muse/agent-core + exported; `answerAssertsUnsupportedValue` checks month-day drift FIRST, then strips date expressions before the bare-number check (so a date's day isn't re-judged as a loose number — no false-fire when the same day appears only inside an ISO date). Feeds the EXISTING fail-OPEN escalation (flag->one judge pass->demote only if the judge agrees; a judge error never refuses). chat-grounding deleted its private copy + imports the shared one (de-dup, kills the divergence that opened the asymmetry). OUTCOME + mutation verified (dist: prose/KO drift->ungrounded; judge-throw->grounded fail-open; ISO↔prose-equivalent correct date->no escalation) + Opus (4)b judge PASS 5/5 (fail-open preserved, no false-fire, chat date gate still 11/96 pass after de-dup, byte-clean). lesson: a guard duplicated across two surfaces (chat monthDayKeys + ask) is where a gate-asymmetry hides — share ONE copy in the lowest common package so both surfaces can't diverge.
- [done] :: (W1) **Contested-fact caution on the CHAT persona path (close the gate-asymmetry — fire 20/21 pattern, for memory point-of-use)** — competitor-grounding fire 34 (memory-integrity). The `ask` path renders a contested-fact caution (a value that FLIPPED across confirmations -> "(value has changed before — confirm it's current)", refinement-aware so Seoul->Seoul-Gangnam doesn't count), but the CHAT persona (`buildMusePersona`, the system prompt fed to the model on EVERY chat turn) had NO contested caution — only a value-blind `(previously X)` note. So in chat (Muse's primary continuous-companion surface) the model asserted a value Muse itself knew was volatile. FIX: `buildMusePersona` gains `contestedKeys?` (caution takes precedence over the value-blind note); derived from the belief-provenance store + wired on BOTH chat persona callers — the Ink chat (chat-ink) AND the one-shot `muse chat` (chat-repl), fail-soft. OUTCOME + mutation verified (dist: contested->caution; stable->byte-identical to before — zero over-firing on the every-turn prompt; refinement-aware; precedence) + Opus (4)b judge PASS 5/5. 형제: ask's persona left un-wired (its grounding block already carries the caution — redundant); brief/proactive are non-grounded greeting/notification surfaces — honestly out of scope.
- [done] :: (V1) **Surface fan-out trust signals on `muse ask --json` + the run-log (GROUNDED≠TRUE leak on the machine surface)** — competitor-grounding fire 33 (orchestration). The decomposition (lead-worker fan-out) trust signals — `subtaskConflicts` (sub-answers contradicted), `synthesisIncomplete` (a completed sub-result dropped), truncation (capped at MAX_SUBTASKS) — were surfaced ONLY on human STDERR (gated `!options.json`), NOT in the `--json` payload or run-log. So a downstream agent/script got a confident `answer` + `groundedVerdict:"grounded"` with ZERO indication the fan-out self-contradicted / dropped a result / was truncated — the leak on the one surface that can't read a banner. FIX: `LeadWorkerResult.truncated` STRUCTURED flag (was reason-string-only); `DecomposedAskResult.truncated`; pure `decompositionJsonFields` helper -> a `decomposition` block emitted ONLY for a decomposed run (no single-run noise; empty arrays omitted), wired into BOTH the --json payload AND `buildAskRunLog` (so a fan-out failure no longer logs as a clean success — feeds the error-analysis flywheel). OUTCOME + mutation verified (dist: decomposed->block with conflicts/incomplete/truncated; single-run->no key; run-log carries it) + Opus (4)b judge PASS (both machine surfaces wired, no third surface — api/SSE don't decompose, truncated no-drift, floor untouched). · FOLLOW-UP (judge-noted, non-blocking): a command-level integration test that parses real decomposed `muse ask --json` stdout to mutation-pin the wiring (currently helper-level mutation only).
- [done] :: Wire `detectFanInConflicts` into the API orchestrate routes (production parity) — multi-agent fire 1 (`embed` threaded via `createGateEmbedder`, both `/orchestrate` + `/orchestrate/stream`, contract-faithful HTTP test). FOLLOW-UP (cosmetic, judge note): `SseStreamArgs.options` type omits `detectConflicts`/`verifyFinalAnswer` — flows at runtime via structural erasure, guarded by the stream test, but a future options-picking refactor could silently drop it; widen the type when that file is next touched.
- [done] :: Decomposed lead-worker all-failed = honest-empty (fabrication floor) — multi-agent fire 2 (gap-scout): `runLeadWorkerTask` now short-circuits BEFORE synthesis when `completed === 0`, returning `finalAnswer: ""` instead of synthesizing a confident answer from zero grounded sub-tasks. Closes the inconsistency vs the single-agent path (already `""`) and the orchestrator fan-out (already throws `No worker completed`). MAST proceed-despite-failure guard.
- [done] :: Expose structured `conflicts`/`verification` in the API orchestrate response DTO — multi-agent fire 3: the routes mapped only `response:{id,model,output}`, dropping `response.raw` — so the consumer got only the human 주의: text line, never the structured coordination signal. Added `readOrchestrationSignals(raw)` (defensive narrowing) spread into BOTH POST `/orchestrate` and the `/orchestrate/stream` done frame. Completes fire 1's stated HTTP acceptance (`raw.conflicts populated`). MAST: don't withhold the coordination failure from the caller.
- [done] 2026-07-03 :: **decomposed all-failed `muse ask` printing a BLANK answer — FIXED (2026-07-03, no harness needed).** Confirmed the bug was real: `answerIsRefusal("")` is `false` (substring match against a non-empty string), so the blank `decomposed.answer` skipped every honest-refusal UX too, not just the print. Fix landed at the caller (`commands-ask.ts`), not the seam — `decomposedAnswerOrRefusal()` (new pure fn, `ask-decompose.ts`) converts an empty/whitespace-only answer into a marker-bearing "I'm not sure — none of the sub-tasks…" string BEFORE it reaches `collectedAnswer`, so `refusalAnswer` downstream is correctly `true` and citation-strip/warm-close/opt-in-tip all fire. The seam's own `runDecomposedAgentAsk` + its `ask-decompose.test.ts` "returns an empty answer" contract test are untouched. No command-level harness was needed — the fix is a pure unit-testable function; mutation-check RED confirmed, independent evaluator PASS. 3 new tests.
- [done] :: Neutralize the SEQUENTIAL worker-to-worker handoff (Prompt Infection / OWASP ASI07) — multi-agent fire 5 (gap-scout, arXiv:2410.07283): in `MultiAgentOrchestrator` sequential mode, a prior worker's output (`addWorkerResultMessage`) and a failed worker's error (`addHandoffMessage`) were threaded RAW into the NEXT worker's SYSTEM-role prompt — only the fan-IN (synthesis) and the lead-worker `runOne` neutralized. A poisoned worker's embedded instruction / forged `[from system]` citation reached the next worker with system authority. Both funnels now wrap `neutralizeInjectionSpans` (the same fan-in funnel); raw tracked result untouched (trace fidelity). Mutation-first + 2 behavioral tests (output + error), independent Opus (4) judge PASS (reverted-wrapping drill). Parallel mode N/A (no worker-to-worker threading).
- [done] :: Persist coordination outcomes (conflicts/verification) in the orchestration history — multi-agent fire 6: the fan-in computed `conflicts` + the objective-coverage `verification` verdict but `OrchestrationHistoryEntry` only stored counts/status, so a past run's "workers disagreed" / "answer incomplete" was LOST (not queryable). Added `conflicts?`/`verificationSatisfied?` to the entry; reordered `MultiAgentOrchestrator.run` success path to build the response BEFORE `recordHistory` (extract from `response.raw`; also makes `finishedAt`/`durationMs` cover synthesis); exposed both in `GET /orchestrations/:runId` (the persisted twin of fire 3's live signal). Mutation-first + 3 package tests (store-query) + 1 HTTP round-trip (POST->GET). Independent Opus (4) judge PASS (confirmed the reorder can't skip recordHistory — buildOrchestrationResponse is fail-soft, can't throw on the success path).
- [done] :: Redundancy (step-repetition) detection at the lead-worker fan-in — multi-agent fire 7 (paper-grounded, arXiv:2503.13657 MAST FM-1.3 = 15.7% of failures + arXiv:2511.10650): the COMPLEMENT of the contradiction detector. New `detectRedundantPairs(texts, embed)` in agent-core (same-topic cosine≥0.86 AND near-identical token sets Jaccard≥0.9 — INVERTS the neither-subset gate) -> `detectSubtaskRedundancies` (multi-agent, twin of detectSubtaskConflicts) -> `deps.detectRedundancies` wired into `runLeadWorkerTask` + `LeadWorkerResult.subtaskRedundancies` field -> LIVE in `runDecomposedAgentAsk` (ask-decompose deps, mirrors detectConflicts) + `DecomposedAskResult.subtaskRedundancies`. Calibration-safe: Q1/Q2-style distinct values (Jaccard~0.2) + elaborations (~0.5) NOT flagged, only near-verbatim echo (~1.0); SURFACE-ONLY (advisory, never drops/blocks). 7 detector tests + engine + live-CLI tests, mutation-first verified, independent Opus (4) judge PASS (did the calibration math). FOLLOW-UPS (sibling-audit, deferred): (a) the orchestrator FAN-OUT twin `detectFanInRedundancy` in `buildOrchestrationResponse` (mirror detectFanInConflicts); (b) surface `subtaskRedundancies` in the `commands-ask.ts` god-file stderr (mirror the subtaskConflicts 주의: line ~2207 — low-risk 2-line but god-file untestable, see fire-4 blocker). NOTE: a pre-existing FLAKY property-fuzz test `packages/model/src/web-search-policy.test.ts` (another loop's, b2081275) intermittently fails `pnpm check` (passed 3/4 here) — not mine; the local-speed/model loop owns it.
- [done] :: Orchestrator FAN-OUT redundancy twin (fire-7 sibling completion) — multi-agent fire 8: brought fire-7's redundancy detector to the production API orchestrate path (mirrors fire 1's conflict wiring). New `detectFanInRedundancy(parts, embed)` (workerId-keyed twin of detectFanInConflicts) -> `OrchestrationRunOptions.detectRedundancies` -> `buildOrchestrationResponse` appends an "ℹ Workers produced near-identical answers" advisory + records `raw.redundancies` (faithful mirror of the conflict block, advisory-only) -> wired at BOTH POST routes (embed already threaded). Mutation-first (advisory string break -> RED); orchestrator + detector-unit + API-route tests incl. the conflict-vs-redundancy distinction (identical workers -> redundancy advisory, NOT 주의: disagree). Independent Opus (4) judge PASS. REMAINING FOLLOW-UPS (deferred, judge-noted): (a) persist `redundancies` in `OrchestrationHistoryEntry` + GET exposure (the f6/f3 twins — redundancy is advisory/lower-stakes so currently response-`raw`-only, not history-queryable); (b) the `commands-ask.ts` god-file stderr surfacing of `subtaskRedundancies` (fire-7 carryover).
- [done] :: Persist redundancies in the orchestration history + GET exposure — multi-agent fire 9 (closes fire-8's judge-noted gap): added `redundancies?` to `OrchestrationHistoryEntry`, recorded `raw.redundancies` in the success-path `recordHistory` (mirror of fire-6 conflicts), exposed in `GET /orchestrations/:runId`. So a past duplicated-work run is now queryable, not just in the live `raw`. Mutation-first (package store-query RED + GET-mapping mutation RED); package + HTTP POST->GET tests incl. the conflict-vs-redundancy distinction. Opus (4) judge PASS. **THEME MATURING NOTE (judge + builder agreement): after 9 fires the multi-agent orchestration coordination guards are comprehensive (conflict/redundancy detection + persistence + exposure both paths, injection neutralization, fabrication-on-all-failed, bounded termination, observability). The HIGH-VALUE single-fire vein is thin — the next fire should PIVOT to a fresh (pkg,kind)/different surface (or 진안 may repoint the theme). Remaining in-theme: god-file `subtaskRedundancies` surfacing (untestable), calibration-risky MAST modes (semantic task-derailment).**
- [done] :: Reasoning-action alignment on the SEQUENCED handoff (MAST FM-2.6, #2 mode @ 13.2%, arXiv:2503.13657) — multi-agent fire 10 (paper-grounded scout, theme-pivot kind): new pure `verifySequencedDependencyUse(executions)` flags a completed sequenced downstream step whose output shares ZERO content tokens with EVERY same-script upstream output (ran "blind"). Wired into runLeadWorkerTask (sequenced-only) -> LeadWorkerResult.reasoningActionGaps -> DecomposedAskResult pass-through. Mutation-first; pure-fn + engine-live + CLI tests. Opus (4) judge PASS but CALIBRATION WARNING (judge-measured): the LEXICAL zero-overlap bar over-fires on legitimate paraphrase/classify/decide downstreams (6/6 generic transforms flagged) — conservative-RECALL, ADVISORY-ONLY (caption only, NO gate/re-synthesis/block). · FOLLOW-UP (REQUIRED before any non-advisory use): harden to SEMANTIC similarity (embedder cosine, mirror detectRedundantPairs); do NOT wire reasoningActionGaps into a gate/warning until then. Doc comment carries the warning in-code.
- [decision] :: THEME-EXHAUSTION (multi-agent fire 11, honest no-ship): after 10 ships the orchestration theme's clean high-value single-fire vein is EXHAUSTED across BOTH surfaces (lead-worker fan-out: conflict + redundancy detection/persistence/exposure, injection neutralization, fabrication-on-all-failed, bounded termination, FM-2.6 alignment; council debate: consensus/conformity/progress/echo/outlier/off-topic/unfaithful/dissent/abstention — all wired) + the evals + units. Remaining · are all DEFERRED: council cross-lingual consensus (low-impact efficiency, no floor violation, + calibration-heavy cross-lingual embeddings — loop already uses semantic consensus so the residual is the finicky embedder-prefix problem), RAG-Fusion LLM-decomposition (LLM-based, calibration-risky), god-file CLI surfacings (untestable), FM-2.6 semantic-harden (advisory-only so not urgent; semantic cosine doesn't fix transform-type FPs anyway). RECOMMENDATION (async, for 진안): REPOINT the theme to a fresh axis. No source committed this fire.
- [done] :: JUDGE-DRILL + derived coordinationHealthy flag — multi-agent fire 12 (mandatory drill, firesSinceDrill->10): deliberately injected a HARDCODED `coordinationHealthy: true` bad slice (ignoring the real fan-in signals) + a vacuous `expect(true).toBe(true)` test -> it passed build/lint/check but the independent Opus (4) judge correctly FAILed it (hardcoded-not-derived, false doc, zero mutation-sensitivity, honesty-floor violation). VERIFIER PROVEN CALIBRATED. Then the REAL fix: `coordinationHealthy = !subtaskConflicts && !subtaskRedundancies && !reasoningActionGaps && !synthesisIncomplete` (a derived machine-readable fan-in-health boolean on the decomposed LeadWorkerResult). Behavioral tests (clean->true, conflict/redundancy->false), mutation-first verified, 2nd judge PASS. · follow-up: surface in `muse ask --json`/API (currently engine-only, unconsumed). firesSinceDrill RESET to 0.
- [done] :: Complete the `muse ask --json` trust-signal block — multi-agent fire 14 (real gap the fire-11/13 'exhausted' claim MISSED): `decompositionJsonFields` serialized only subtaskConflicts + synthesisIncomplete, OMITTING `subtaskRedundancies` (fire 7) + `reasoningActionGaps` (fire 10) — a --json/run-log machine consumer was BLIND to worker-duplication + blind-step coordination failures (GROUNDED≠TRUE-adjacent). Added both to DecompositionTrustSignals + emitted (empty-array guarded). Mutation-first, judge PASS (verified both --json + run-log go through the one function). LESSON: don't declare a theme exhausted without auditing the SERIALIZATION/EXPOSURE layers — a result-object signal must be traced to EVERY surface that emits it. · still deferred: the HUMAN stderr surfacing of redundancies/reasoningActionGaps (god-file, untestable).
- [done] :: Complete the HUMAN stderr exposure of fan-in signals — multi-agent fire 15 (symmetric twin of fire 14's --json fix): `muse ask` warned on conflicts but was blind to REDUNDANCY. Extracted pure testable `decompositionStderrNotes` surfacing conflict (byte-identical) + redundancy. CALIBRATION: deliberately keeps `reasoningActionGaps` --json-only (fire-10 measured it over-fires 6/6 transforms -> too noisy for a human 주의:). Mutation-first, judge PASS (verified byte-identical conflict line). Exposure layer now complete for the precise signals.
- [done] :: (U1) **Close the misgrounding-resolution half of the whetstone BKT loop** — competitor-grounding fire 32 (self-development). The weakness ledger learn-loop was ASYMMETRIC: `recordWeakness` lowered BKT mastery for all 7 axes on a miss, but `recordWeaknessResolved` raised it for `grounding-gap` ONLY — so a `misgrounding` (the GROUNDED≠TRUE core failure: answered but the cited source didn't support it) accumulated monotonically and NEVER resolved, and `selectDevFixableWeaknesses`->`muse doctor` (mastery-blind) nagged a fixed topic forever. FIX: new `GROUNDED_SUCCESS_RESOLVABLE_AXES = {grounding-gap, misgrounding}` (both learned away by a later grounded success; actuator axes time-parse/wrong-tool/unbacked-action + user-action source-conflict correctly NOT auto-resolved); `selectDevFixableWeaknesses` gains `!isMasteredWeakness` (parity with the recap selector). The existing ask/chat resolve call-sites already gate on grounded-success, so a misgrounding turn can't resolve itself — only a LATER grounded answer does. OUTCOME + mutation verified (dist: misgrounding resolves to mastered + drops off doctor; time-parse/source-conflict not resolved; no false-resolution) + Opus (4)b judge PASS 5/5 (floor untouched — pKnown never read by the abstain gate; 3 selectors now consistently mastery-aware, formatWeaknesses honest-historical correctly not filtered).
- [done] :: (T1) **Chat date-drift gate covers PROSE/Korean dates (close the calendar-date fabrication hole)** — competitor-grounding fire 31 (grounding-floor). The hard chat gate `answerAssertsUnsupportedDate` compared ISO dates only, but the calendar grounding block renders month-name dates ("September 14, 2026") via toLocaleString, so a drifted prose calendar/deadline date passed as grounded. FIX: `monthDayKeys` extracts a script-neutral month-day key from ISO + English prose ("September 14"/"Sep 14") + Korean ("9월 14일"); year is dropped (the number guard owns it). MODAL-VERB fix (caught by the (4)b judge mid-fire): "may" is matched CASE-SENSITIVELY (initial-cap) so the modal "you may 3 …" isn't a false-refusal (the ask path stoplists "may" for the same reason). OUTCOME + mutation verified (dist: prose/KO/"May 5" drift -> abstain; modal "may"/ISO↔prose-equiv/month-only -> no false-refusal) + Opus (4)b judge PASS (re-judged after the modal fix). · FOLLOW-UP: the ASK path (`answerAssertsUnsupportedValue`) stoplists month names and has NO date-drift coverage — a separate slice (different mechanism: value-escalation, not this guard).
- [done] :: (S1) **Forget durability: a forgotten fact must not silently resurface (user > auto authority)** — competitor-grounding fire 30 (memory-integrity). `forget` was a pure key-drop with NO tombstone, so the auto-extractor (which only sees the CURRENT stored value) re-classified a forgotten fact as "add" (current=undefined) and SILENTLY re-persisted the value the user just deleted — an inference overriding an explicit user retraction ("forget that doesn't stick", against "Tell it everything. It can't tell anyone."). FIX: `BeliefProvenance.retraction?` marker (no value; deriveFactProvenance SKIPS it -> fire 16/22 confirmCount/value/distinctValueCount invariants preserved); `keysWithActiveRetraction` (newest-event-is-retraction, a later re-`set` clears it); `recordRetraction` helper; auto-extract `applyOp` suppresses an add/update on a retracted key (fail-open); BOTH user-forget sites (CLI `memory forget` + in-chat `/forget`) wired via the shared helper (형제-감사). OUTCOME + mutation verified (dist: forgotten home_city NOT resurfaced, a different key still writes, a user re-statement reopens it — no over-suppression) + Opus (4)b judge PASS 5/5. clear-all/dreaming-purge are bulk/internal (not targeted user retractions) — correctly out of scope.
- [done] :: (R1) **Fan-in source-leak: an ungrounded sub-task's sources must not grade the answer** — competitor-grounding fire 29 (orchestration). In the `muse ask` decomposition path every sub-task's retrieved sources were merged BEFORE its output was judged, so a sub-task that retrieved `secret.md` then REFUSED (gated ungrounded, output withheld) still left `secret.md` in the evidence the synthesized answer was graded against + the Sources footer — a GROUNDED≠TRUE seam (the answer could be marked grounded on / cite a source no surviving sub-task used). FIX: `SubtaskExecution.sources?` STATUS-LINKED (runOne threads `produced.sources` into all returns — completed/ungrounded/failed); `ask-decompose` stops eager-merging, derives `mergedSources` from ONLY `status==="completed"` executions ∪ the synthesis run's own sources. OUTCOME + mutation verified (dist: refused subtask's secret.md DROPPED; completed actions.md + synth.md KEPT; single-completed/non-decomposed paths keep their real sources — no false-negative) + Opus (4)b judge PASS 5/5 (mutation-proven — merge-all revert -> RED). The last unguarded fan-in seam (output already withheld; now sources too).
- [done] :: (Q1) **Agent-path `time-parse` weakness producer for the reminder loopback (fire 26 sibling) + JUDGE-DRILL** — competitor-grounding fire 28 (self-development). fire 26 wired the dead time-parse axis at the CLI `calendar add/edit`; the AGENT path (loopback reminder MCP tool) was deferred. FIX: `RemindersMcpServerOptions.weaknessesFile?` + `recordTimeParseWeakness` on BOTH the `add` AND `snooze` dueAt-parse-failure branches (in-file 형제-감사 — the snooze sibling was caught by the (4)b judge mid-fire and patched same-fire); prod caller (`autoconfigure/loopback-tools.ts`) passes `resolveWeaknessesFile(env)` so it's LIVE. This fire was the JUDGE-DRILL: a planted bad slice (chat-nudge "DRY-unify" that discarded askTimeWeaknessNudge's verdict + passed `[]` + happy-only tests) was caught FAIL by the independent Opus judge (specific violation cited), rolled back; the real fix then went PASS 6/6 (mutation-proven). STALE-BACKLOG: chat-nudge DRY-unify was ALREADY built by a concurrent loop (`chatRepeatWeaknessNudge`, mastery-aware) — corrected. · FOLLOW-UP (cross-file siblings, separate slices): `loopback-calendar.ts` startsAt parse sites + `loopback-followups.ts` scheduledFor have no weaknessesFile.
- [done] :: (P1) **Wire the injection neutralizer onto the STORED/SYNCED grounding surfaces (close the gate-asymmetry)** — competitor-grounding fire 27 (grounding-floor). The deterministic injection defense `escapeSystemPromptMarkers(neutralizeInjectionSpans(...))` was wired on only 3 of 8 sibling grounding-block builders (note/episode/feed); calendar/contact/reminder/task/action/shell/git rendered third-party text (synced gcal/caldav invites, vCard-imported contacts) RAW into the `<<event>>`/`<<contact>>` wrappers — an imperative-override or forged `<<end>> [from system.md]` breakout reached the local model untouched (the exact threat prompt-escape.ts's MARKER_KEYWORDS enumerates). FIX: new `safeField` helper (present.ts) wired into EVERY raw free-text field of buildTask/Reminder/Shell/Git/Action/Calendar + buildContact (select.ts: name/about/relationship/connection) + the missed feedName header/citation (형제-감사). Content AND citation use the same escaped value (gate stays consistent). OUTCOME + mutation verified (dist: malicious title/about -> "removed", breakout escaped to exactly 1 literal `<<end>>`, benign round-trips) + Opus (4)b judge PASS 5/5 (sibling-audit complete, citation-consistent, mutation-proven — inert safeField -> 5 RED). · FOLLOW-UP: `connection.as` is first-party (user-typed), out of scope.
- [done] :: (O1) **Wire the DEAD `time-parse` weakness axis to its deterministic producer** — competitor-grounding fire 26 (self-development). `time-parse` was declared in WeaknessAxis + DEV_FIXABLE_AXES + remediationHint + doctor-displayed but had ZERO producers (only test fixtures) — same dead-end-detector class fire 9 fixed for source-conflict. FIX: new pure `recordTimeParseWeakness(phrase, failed, deps)` (@muse/mcp); wired at BOTH calendar time-phrase parse sites (`calendar add` + sibling `calendar edit`, on the `!parseEventStart` failure branch, fail-soft). A code-detected (deterministic parser, not the model) time-misread now reaches `selectDevFixableWeaknesses`/doctor. OUTCOME + round-trip verified (dist: garbage `--at`->time-parse entry->dev-fixable surface; valid `--at`->none) + Opus (4)b judge PASS 5/5 (mutation-proven). · FOLLOW-UP: `wrong-tool` is the sibling dead axis (zero producers, but no clean deterministic oracle — harder); loopback-reminder `parseReminderDueAt` (agent path, lacks env/weaknessesFile).
- [done] :: (N1) **Runtime weakness nudge on the ASK path (close the learn->apply loop at point-of-use)** — DONE (competitor-grounding fire 24, self-development). A confirmed recurring weakness was surfaced ONLY in the once-a-day recap, not at the moment the user hits the same wall again via `muse ask`. STALE-BACKLOG: the CHAT path ALREADY surfaces an inline KO/EN runtime nudge (chat-repl.ts:693, count≥2) — the scout over-stated "ask/chat"; the real gap was ASK-only. FIX: new pure `askTimeWeaknessNudge(entries, topic)` (@muse/mcp — a recurring USER-REMEDIABLE weakness on the asked topic, count≥2, not mastered, highest-count axis; reuses USER_REMEDIABLE_AXES + remediationHint + BKT); `commands-ask` reads the ledger after recording + surfaces a KO/EN axis-aware " …" stderr cue (deterministic user-facing, NOT a prompt — respects security≠prompt; floor untouched). OUTCOME-verified (dist: recurring->nudge, single-ask/dev-fixable/mastered/different-topic->none) + Opus (4)b judge PASS 5/5. [done] FOLLOW-UP DONE (self-improvement fire 2): chat's hard-coded nudge unified onto the shared `askTimeWeaknessNudge` + extracted `renderAskTimeNudge` — chat now surfaces source-conflict reconcile wording + BKT mastery suppression at ask-parity, wording can't drift; ask output byte-identical. · NEXT (judge nit): chat doesn't `recordWeaknessResolved` on a grounded success (ask does) so a closed gap keeps nudging until BKT mastery — wire grounded-success resolution into the chat path.
- [done] :: (J2) **Cross-subtask conflict reconciliation on the fan-in** — DONE (competitor-grounding fire 23, orchestration). `verifySynthesisCoverage` checks each sub-task is REPRESENTED but nothing checked the sub-answers are mutually CONSISTENT — when worker A says "deadline Tuesday" and worker B "Wednesday", the synthesis concatenated an internally-inconsistent answer (both individually passed groundingGate -> the fan-in passed a self-contradicting claim = GROUNDED≠TRUE fabrication). The contradiction primitive existed (`detectEvidenceContradictions`) but was applied only to source NOTES. FIX: EXTRACTED `detectPairwiseContradictions(texts, embed, opts)` shared core (@muse/agent-core, ONE detector for evidence + fan-in layers, no policy drift); new `detectSubtaskConflicts(executions, embed)` (@muse/multi-agent); `LeadWorkerDeps.detectConflicts?` + `LeadWorkerResult.subtaskConflicts?`; `ask-decompose` threads embed + wires it; `muse ask` surfaces "주의: sub-results disagree — verify before trusting". OUTCOME-verified (dist: contradicting flagged + named, consistent/elaboration/different-topic/failed->[], fail-soft) + Opus (4)b judge PASS 5/5 (extraction byte-identical — all 17 pre-existing contradiction tests pass; reuse + real wiring). Scout confirmed chat is single-turn BY DESIGN (no orchestration-parity gap). · FOLLOW-UP runner-up: remediationHint reaches only the recap, not the ask/chat runtime prompt (weakness learn->apply loop open at runtime — needs deterministic-not-prompt design).
- [done] :: (M1) **Contested-fact (volatile-value) caution on the recall/ask hot path** — DONE (competitor-grounding fire 22, memory-integrity). `selectVolatileBeliefs` (a fact whose value FLIPPED across confirmations, distinctValueCount≥2) was consulted ONLY in the once-a-day recap — never on the ask hot path. So a fact confirmed 5× with an oscillating value got the WRONG provisional caution "(unconfirmed — learned once)" (factually wrong + understates the risk). FIX: `buildMemoryContextBlock` gains `contestedKeys?` rendering "(value has changed before — confirm it's current)" with PRECEDENCE over the once-seen mark; new pure `contestedFactKeys(matchedKeys, provenance, opts)` (@muse/memory, mirrors provisionalFactKeys, lifts the recap's top-3 cap so ALL matched volatile keys flag); `commands-ask` computes + passes it from the already-loaded provenance. OUTCOME-verified (dist: a 3×-flipped fact -> "changed before", NOT "learned once") + Opus (4)b judge PASS 5/5 (judge caught the top-3-cap edge -> fixed in-fire). Scout confirmed memory consolidation/decay (Mem0 ADD/UPDATE/NOOP/DELETE + ACT-R) ALREADY BUILT — STALE-BACKLOG. · FOLLOW-UP (L escalation): write-time refinement-vs-contradiction NLI reconciliation (Mem0 UPDATE semantics).
- [done] :: (L1) **Faithfulness gate on the proactive Phase D notice (close the GROUNDED≠TRUE asymmetry on the PUSH surface)** — DONE (competitor-grounding fire 21, proactivity/grounding-floor). Same gate-asymmetry pattern as K1: the proactive daemon synthesized a heads-up by running the local 8B at T=0.4 over `item.factSheet`, and that free prose reached the user as an UNASKED push (higher-trust) through only length/JSON filters — a wrong time / invented location pushed verbatim. FIX: new shared `buildGroundingReverify(provider, model)` (@muse/agent-core — the canonical one-shot judge, works on a narrow no-structured-output provider via the free-text YES/NO fallback); `synthesizeNoticeText` gains `reverify?` and FAILS CLOSE to the verbatim store-grounded `item.text` on NO/throw/empty-evidence; BOTH live callers (`commands-proactive`, `proactive-tick`) wired; proactive surface added to the reflection-guard registry. VISION confirmed ALREADY gated (classifyVisionAction->fieldIsGrounded — STALE-BACKLOG-correct, no gap). OUTCOME-verified (dist: unfaithful->item.text, faithful->kept, throw->item.text, empty->no judge) + Opus (4)b judge PASS 5/5 (both callers really gated; fail-close target safe). · FOLLOW-UP: consolidate fire-20 `buildModelGroundingReverify` onto the shared `buildGroundingReverify` (minor pre-existing duplication; responseFormat tradeoff).
- [done] :: (K1) **Faithfulness verifier on the live in-chat reflection (close the GROUNDED≠TRUE asymmetry)** — DONE (competitor-grounding fire 20, self-development/memory-integrity). The OFFLINE dreaming path (`synthesizeReflections`->`verifyReflectionsGrounding`) re-checks each cross-session insight against its cited episodes; the LIVE in-chat path (`synthesizeReflection`, used by `/reflect` + the morning brief) had NO verifier — a confabulated "I've noticed you keep …" observation reached the chat raw. FIX: `synthesizeReflection` gains `reverify?: GroundingReverify` (FAIL-CLOSE: judge NO / throw / empty-evidence -> drop the insight); `buildModelGroundingReverify` reuses the SAME exported reverify primitives the offline path uses; `chat-ink.ts reflectInsight` (the choke point for BOTH user-facing surfaces) builds + passes it; the in-chat surface ADDED to `reflection-guard.test.mjs` REFLECTION_SURFACES (was absent — CLAUDE.md-pinned rule). OUTCOME-verified (dist: reject->drop, accept->keep, throw->drop, empty->no judge) + Opus (4)b judge PASS 5/5 (live path REALLY gated, faithful reuse). · FOLLOW-UP: a live `verify-reflection.mjs` negative-entailment case (deferred — box saturated; deterministic gate fully proven). STALE-BACKLOG note: H3b's semantic-PROSE conflict is ALREADY BUILT (`detectEvidenceContradictions`, Mem0 arXiv:2504.19413, wired ask+chat); cross-lingual EN↔KO is a DELIBERATE precision-first fail-open (same-script guard, fire-28/36/39 lesson) — not a clean slice.
- [done] :: (J1) **Dependency-aware sequenced decomposition** — DONE (competitor-grounding fire 19, orchestration). MAST reasoning-action mismatch: `extractSequencedSteps` split an ordered request ("먼저 X … 그 다음 Y") into sub-tasks but EVERY step ran in ISOLATED context — a sequenced step 2 that should act on step 1's RESULT ran BLIND. FIX: `decomposeRequestWithKind -> {subtasks, sequenced}` (sequenced only for ordered splits; numbered/bullet/planner = independent); `LeadWorkerDeps.execute(subtask, priorContext?)` threads the COMPLETED prior steps' outputs forward for sequenced splits (fail-close: failed/blank not threaded; independent stays isolated); `ask-decompose` prepends "이전 단계 결과:" to the worker message. OUTCOME-verified (dist probe: sequenced->step2 sees step1, independent/planner->isolated, blank-prior->not threaded) + Opus (4)b judge PASS 5/5. · FOLLOW-UP: a live `verify-decomposition.mjs` dependent-sequence case (deferred — box saturated; the deterministic threading mechanism is fully proven). Scout assessed memory/self-dev/grounding-floor as saturated this round.

### [done] verified ALREADY-BUILT (do NOT re-scout — gap-scout fires 8+15): skill curator (curate/consolidate/held-out gate, @muse/skills) · playbook reward/decay RL (PEVI LCB ranking, agent-core/playbook.ts) · ask->sub-agent orchestration (runDecomposedAgentAsk fully wired) · per-subtask grounding gate + dedupeSubtasks + typed handoff validation (lead-worker) · cross-store memory↔note conflict cue (conflict.ts) · server-path verifyFinalAnswer (index.ts — but NOT the CLI path = H1) · injection neutralizer fully applied across all surfaces (grounding-floor saturated).

## Open — @muse/recall extraction (codebase-quality loop)

- [done] :: Relocate RecallHit into @muse/recall + move buildAskConnections — codebase-quality fire 9
- [open] :: **Move `selectGraphConnections` + `NoteLinkGraph`** — needs NoteLinkGraph + resolveNoteId/noteLinkView/linkExpandRefs relocated from apps/cli/src/notes-links.ts (own multi-step). Defer until the notes-link graph types have a package home.
- [open] :: **Split notes-links.ts (graph-query vs link-editing) -> graph subset to @muse/recall** — notes-links.ts is pure (only dep levenshteinDistance, now @muse/shared) but TIGHTLY COUPLED: graph-query (NoteLinkGraph/noteLinkView/resolveNoteId/linkExpandRefs/linkedFromResults — what selectGraphConnections needs) shares internals (extractWikiLinks/noteLinkKey/buildNoteLinkGraph) with link-EDITING (planLinkFixes/rewriteWikiLinkReferences/auditNoteGraph, used by commands-notes). Clean split is a dedicated decompose; LOWER priority than Phase 3 (selectGraphConnections is a CLI --connect footer, not the recall pipeline). — codebase-quality fire 11 defer

- [open] :: **Phase 3: `runGroundedRecall` pipeline + API route** — the contract closer (extract registerAskCommand pipeline behind a seam, wire apps/api ask route, CLI↔API parity test). Design-sensitive; small verified steps only.


> 주의: BLOCKER (codebase-quality fire 5, 2026-06-13): `apps/cli/src/commands-daemon.test.ts` 28/71 FAILED on main (proactive: fired N/N, message length, dest dedup). PRE-EXISTING + EXTERNAL — present with my fire-5 changes stashed; my slice is comment-only in packages/*. Belongs to the concurrent **tool-hardening** loop (daemon/proactive domain, auto-pushes main). NOT fixed here (cross-loop collision risk). main has a real daemon regression to resolve.


> The ONE compounding artifact the dev loop reads FIRST. Resurrected after the
> docs reset deleted it (which forced every session to re-discover "what to build"
> with expensive scout subagents and throw the answer away). The `improve-muse` (hardening
> lines) / `grow-muse` (capability lines) skills pick from here when `self-eval` is green; every fire appends
> the chosen slice + the candidates it rejected + the source, so a direction is
> researched ONCE, not re-paid each session. Keep it pruned: move shipped items to
> DONE, drop dead ones. This file is the antidote to the treadmill.
>
> Priority: = do next · · = ready · [decision] = blocked (reason noted).
> Each item: **what** — why (source) — the smallest verifiable slice.
>
> **Logging convention (loop-creator v1.14.0+):** this file is a **lean shared QUEUE** — open
> `·`/``/`[decision]` items + a one-line `[done] Fixed` dedup ledger (below). **Per-fire Done DETAIL lives in the
> per-loop journal** `docs/goals/loops/<slug>.md`, NOT here. Going-forward Done write-back = move the
> picked `·` to a `[done] Fixed` one-liner; the full story is the journal entry. (The verbose `[done]->Done`
> blocks below are pre-v1.14.0 history — kept for dedup, condensable when loops are paused. Convention:
> [`loops/README.md`](loops/README.md).)

- [done] :: repo byte-hygiene: commands-logo.test.ts raw ESC bytes — already resolved on origin/main (raw-ESC count 0, @muse/shared byte-hygiene gate green); stale note cleared — cli-excellence fire 5
## TOOL theme — open (CLI-only capabilities lacking an agent tool)

- [done] 2026-07-13 :: RESOLVED (ac0111cb0, 2026-07-13) — per-field grounding modes landed in `groundToolArguments` (`name:mode` entries: domain-aware `email`, literal-@ `handle`, numeric-component `date`); add_contact now grounds all five identifier args and mac_contact_add's email is domain-verified. Original finding: **`email`/`handle`/`birthday` were NOT cleanly groundable under the ANY-token mechanism (add_contact grounded ONLY `phone`).** `email`/`handle` local-part (`bob@…`, `@bob`) = the contact NAME which is in the utterance -> a fabricated domain false-grounds via the name token (false protection). `birthday` reformats (MM-DD) -> brittle false-drop. A real fix needs per-field matching (e.g. domain-aware email grounding) in `groundToolArguments` — that lives in @muse/agent-core (concurrent agent-core-enhance loop's hot package); defer until it quiets or 진안 prioritizes. Phone is done (fire 65).


- [decision] 2026-07-12 :: **VEIN THINNING (fire 61) — the cold MCP/tool surfaces are verified correct/covered; remaining candidates are description-only or need 진안.** An adversarial Opus scout swept the cold surfaces (MCP external-tool projection + ToolOutputSanitizer 50k cap/injection-defang, messaging send-gate, official-MCP preset registry, history/context/followups/reminders/notes loopback servers) — all sound. Structural tool-hardening targets (DefaultToolFilter, capToolOutput) live in @muse/agent-core (hot — concurrent loop). Remaining: (a) description-only nits (notes-multi/tasks-multi missing `domain` tag; followup snooze `id` example) — avoid-list; (b) [done] RESOLVED (1712f5e6f, 2026-07-12): `riskFromMcpAnnotations` now defaults annotation-less external MCP tools to gated `write` (fail-closed per MCP spec), covered by packages/mcp/test/risk-from-annotations.test.ts; official presets still re-stamp via `withOfficialMcpRisk`. Next fires: pivot toward the productivity/calendar surface once those loops quiet, or 진안 decides the MCP-risk posture.

- [done] :: **RESOLVED (fire 56) — Korean faithfulness 0/4 was a BATTERY bug, not a grounding regression.** `verify-faithfulness-rate.mjs` hardcoded the LEGACY embedder `nomic-embed-text` (EN-centric v1, ~50% KO hit@1) instead of the PRODUCTION default `DEFAULT_EMBED_MODEL = nomic-embed-text-v2-moe` (100% KO). So the battery measured a Korean "coverage gap" the product never ships — with v2-moe the same battery scores hangul faithfulness 4/4, false-refusal 0/12, PASS. Fixed by using DEFAULT_EMBED_MODEL. `precheck:grounding` now exits 0 -> pushes unblocked. (fire-55's ca7b1863 suspect was correctly disproved.)
- [decision] :: `math_eval` robustness — VERIFIED NOT A BUG (fire 52): both evaluateArithmetic copies (tools + mcp) reject malformed input by throwing->error (no crash); commas are intentionally stripped. No slice. (closes the fire-51 LANE-A candidate)
- [done] 2026-07-03 :: (freshness guard, 2026-07-03) daemon test regression resolved — `commands-daemon.test.ts` (71 tests) passes clean on current main; superseded by an intervening commit.

- [done] :: RESOLVED (fire 10 re-check): the fire-9 core-edge regression — add_contact dropping a user-stated phone, bisected to `5ec47842` — is FIXED on main (both `actuator-tools.test.ts` phone cases pass again). test-hygiene fire 9's blocker surfaced it; the owning loop repaired it.
- [done] :: **`packages/tools` src+test double-run — ALL 4 overlapping pairs DONE** (helpers fire 11, time fire 12, text fire 13, data fire 15). Each was two INDEPENDENT suites; kept the fuller side, migrated the lesser's unique cases first (the (4)b judge caught real losses on time/text/data — humans miss the bidirectional uniques). Remaining src-only test files (`muse-tools-regex`) have no test/ twin, so they don't double-run — no action needed.

## test-hygiene theme — open (low-quality/flaky tests to fix, coverage gaps to fill)

- [done] 2026-07-03 :: (freshness guard, 2026-07-03) reflection-guard registry drift resolved — `node --test scripts/reflection-guard.test.mjs` passes clean on current main.

- [done] :: DONE (fire 14) **FIX flaky-boundary: `@muse/messaging pending-approval-store "caps to 200"`** — 205 sequential disk records (~3s, flaked at 5028ms under load) -> rewritten as one `fs.writeFile` seed of e0..e203 + one record of e204 (3040ms->73ms), same assertions, mutation-pinned (cap slice + cap removal both caught).

- [open] :: **machine-load timeouts under concurrent loops** — with ~6 loop worktrees running vitest at once, *trivial* tests (`@muse/agent-core sanitizeFollowupSummary` — a one-line `.replace`; `@muse/mcp` plan-cache `caps at MAX_PLAN_CACHE_ENTRIES`) hit the 5000ms vitest default and time out under CPU starvation, reddening full `pnpm check`. NOT a test-quality issue (functions are linear) — an environment/oversubscription artifact (plan-cache passes in 1.3s isolated). Candidate slice: raise the global vitest `testTimeout` (e.g. 5000->15000ms) in the shared vitest config so concurrent-loop load can't manufacture false failures — weigh against masking a *real* future slowdown. (observed test-hygiene fire 2)

### Full-suite AUDIT findings (4-agent review, 2026-06-13 — ranked PRUNE + ADD fuel)

**PRUNE — duplicate / double-running tests (highest value: real redundancy):**
- [open] :: **`packages/a2a` double-run — partially closed (fire 4)** — deleted the 5 truly-subsumed `src/` dup tests (peer-config·receive-quarantine·signing·council-wire·handler), migrating 2 unique SECURITY cases (council-wire same-length-non-hex catch; peer-config blank-secretEnv guard) into the twins first. REMAINING: `src/agent-card.test.ts` (unique DataPart-envelope coverage) + `src/transport.test.ts` still co-run with their `test/` siblings — close structurally with a `vitest.config.ts` OR migrate agent-card/transport's unique cases into `test/` then delete. (audit a2a — partial)
- [open] :: **`packages/tools` src/test twins** — `src/muse-tools-{data,helpers,text,time}.test.ts` duplicate richer `test/` counterparts (vitest.config excludes `dist/**` but not `src/**`). KEEP `src/muse-tools-regex.test.ts` (no `test/` twin — migrate, don't delete). (audit tools)
- [open] :: **`packages/model` src dupes** — `src/index.test.ts` (type-only asserts, compile-time-guaranteed) + `src/provider-base.test.ts` (`isRetryableHttpStatus` re-covered by `test/is-retryable-http-status.test.ts`). MIGRATE `src/provider-wire.test.ts` to `test/` (high-value, no twin — don't delete). (audit model)
- [open] :: **`packages/autoconfigure`** — `src/response-filters.test.ts` (⊂ `test/response-filters.test.ts`), `src/provider-utils.test.ts` (mostly ⊂ test/ — but verify `stringField` has a `test/` home first). (audit autoconfigure)
- [open] :: **`@muse/agent-core` constant tautologies** — `followup-detector.test.ts:20`, `followup-llm-detector.test.ts:148`, `sentence-groundedness.test.ts:101` assert `CONST === <math literal>` (no behavior, no cross-module parity); behavior already pinned by sibling tests. PRUNE. (audit agent-core)
- [open] :: **`@muse/agent-core` duplicate describe blocks** — `agent-runtime.test.ts` `validatePlan` (299–382) ⊂ `plan-execute-validation.test.ts`; `StepBudgetTracker` (149–195) ⊂ `step-budget.test.ts`. PRUNE the agent-runtime copies. (audit agent-core)
- [open] :: **`@muse/mcp`** — `test/loopback-helpers.test.ts` ⊂ the fuller `src/loopback-helpers.test.ts` (delete the weaker `test/` one); `mcp.test.ts` has a few `toBeDefined()`-only lines redundant with the assertion right after. (audit mcp)

**ADD — genuinely uncovered high-value (security / grounding first):**
  - 불가 FALSE POSITIVE (fire 6): `createCitationStreamFilter` is NOT in agent-core and is NOT untested — it lives in `apps/cli/src/citation-stream.ts` and HAS `apps/cli/src/citation-stream.test.ts`. The audit agent grepped only `packages/agent-core/test/`. (lesson: verify audit claims before trusting the package/path)
- [done] :: DONE (fire 5) **`assertPublicHttpUrlSync` SSRF sync gate** — covered: file://·malformed·localhost·metadata.internal·127.0.0.1·[::1]·169.254 all blocked, public https passes; each guard clause mutation-pinned.
- [done] :: **`groundToolArguments` nested-object branch** — core-hardening fire 7 (agent-core, anti-fabrication floor): the fabrication gate handled only string + string[]; a nested OBJECT value passed through UNTOUCHED, so a fabricated `meta.note` rode past the gate and would persist. Added a nested-object branch (clean each fabricated STRING leaf via the same isGrounded test, keep grounded + non-string leaves, same partial-vs-empty `dropped` contract as the array branch; `!Array.isArray` guard so a mixed array isn't corrupted into an index-keyed object — sibling-audit catch). Gate now total over value shapes. Mutation-first + Opus (4)b PASS (probed mixed-array/null/Date/aliasing, no corruption). HONEST CAVEAT: no tool marks an object-valued grounded arg today (every real groundedArgs is a string or `tags` string[]) — pre-closes the shape-hole before a tool ships one. RESIDUAL ·: one level deep (array-of-objects + object-in-object not recursed; deferred until a real nesting caller).
- [open] :: **tool-failure-streak: LIMIT tuning** (agent-core) — TOOL_FAILURE_STREAK_LIMIT=3 is a fixed default not yet tuned on a real failing-tool corpus (needs a live battery; smoke:live stalls). Streaming-seam coverage now DONE (fire 56). (agent-core-cognition fire 42 caveat)
- [open] :: **reflection-dedup: REFLECTION_DEDUP_COSINE tuning on a real paraphrase corpus** (agent-core) — fire 43 set the collapse floor to 0.86 by reasoning, not measurement; tune against real `muse reflections` paraphrase pairs (too low -> distinct insights over-merge; too high -> paraphrases survive). Also consider applying the same semantic collapse at episode/note recall presentation, not just the offline dream. (agent-core-cognition fire 43 caveat)
- [open] :: **playbook credit: DEFAULT_PLAYBOOK_CREDIT_COSINE tuning + asymmetric decay floor** (agent-core) — fire 45 set the semantic credit floor to 0.55 by reasoning; tune on a real cue/strategy corpus. Memory-R2 alternate B (deferred): require a correction (decay) to clear a HIGHER cosine floor than an approval (reinforce) — a wrong decay of a grounded strategy is costlier than a missed reinforce (asymmetric precision). Also alternate A: have applyPlaybook record the actually-injected strategy ids in run metadata so moveReward credits the real culprit set rather than re-deriving by similarity (bigger cross-package wiring). (agent-core-cognition fire 45 caveat)
- [open] :: **HIGH-VALUE (blocked): cross-lingual recall for action-log + memory-fact grounding selectors** — selectGroundingActions/selectMemoryFacts (packages/recall/src/select.ts) rank PURELY by lexical token overlap, so a Korean query "내가 Bob한테 이메일 보냈었나?" against an English action-log entry scores 0 -> the true entry never grounds -> false "I'm not sure" on Muse's actual KO user. Add a hybrid max(lexical, cosine(queryVec, entryVec)) arm (queryVec + embed already in scope at the registerAskCommand caller; mirrors rankEpisodeHits) — strictly additive, fail-soft. BLOCKED: select.ts is in @muse/recall, actively rewritten by the codebase-quality extraction loop (race) — do when that loop pauses or coordinate. Grounds CLIR (arXiv:2511.19324). (scouted agent-core-cognition fire 47)
- [open] :: **DRY the two preference-upsert loops** — inferPreferencesFromTurns (autoconfigure) and inferSessionPreferences (cli) now BOTH carry the belief-revision supersession logic (fires 47+49) duplicated; a future refactor could have the CLI delegate to the package-level core. Lower priority (both work + tested). DEFAULT_PREFERENCE_SUPERSEDE_MAX=6 untuned. (agent-core-cognition fire 49)
- [done] :: `createLlmClassificationInputGuard` owns its fail-close (security/agent-core): the LLM input guard called provider.generate + parse with no try/catch, so a classifier outage or unparseable verdict THREW — failing closed only incidentally via the pipeline's generic catch, which leaked the raw provider error (internal host/IP) into the GuardBlockedError reason + metrics + monitor and used a generic GUARD_ERROR code. Now the guard owns its fail-close: catches -> returns a clean `{allowed:false, code:"LLM_CLASSIFICATION_UNAVAILABLE", reason:"input classifier unavailable; failing closed"}` (no leak, distinct code, not reliant on pipeline catch). (4)b PASS 5/5 (info-leak traced real, behavioral delta confirmed). — tool-hardening fire 133
- [done] :: DONE (fire 8) **`createToolResultQualityAuditFilter` empty-remainder branch** — `rest.length===0` (apology IS the whole output) pinned; filter no longer turns an apology-only answer into an empty result header. Filter branch coverage complete.
  - AUDIT FALSE-POSITIVES verified (don't re-scout): `createCitationStreamFilter` (in apps/cli, already tested — fire 6); `SchedulerExecutionError` throw-conditions (scheduler dispatcher timeout/retry/clamp all covered in scheduler.test.ts — fire 8); `groundToolArguments` nested-object branch (function only handles string + string-array, no nested-object traversal exists; 20 cases already cover string/array — fire 8).
- [open] :: **`formatDueLocal`/`relativeDueHint` (mcp/local-due-format.ts)** — today/tomorrow/in-N-days/NaN branches untested (drives task `dueAtLocal` shown to the model). (audit mcp)
- [open] :: **`muse config show` (cli/commands-config.ts)** — user-facing read path, zero tests (only set/unset tested); `loadImageAttachment` + `muse auth rotate-jwt` command-wiring also uncovered. (audit cli)
- [open] :: **`SchedulerExecutionError` (scheduler) + `withFileLock` stale-lock-steal (mcp/encrypted-file.ts) + `KyselyMcpServerStore` CRUD** — exported, no direct test (Kysely needs Testcontainers or an honest "integration-only" note). (audit mcp/scheduler)

> AUDIT VERDICT: suite is broadly HEALTHY (policy/recall/memory cleanest; security paths well-covered). Rot concentrates in (1) `src/`+`test/` double-running in a2a/tools/model, (2) a few constant tautologies + promoted-then-not-pruned duplicate blocks in agent-core. Biggest real gap: the streaming citation gate. ~15 PRUNE + ~10 ADD items -> the loop now has genuine PRUNE fuel (fires 1-3 were add/fix/add because no prune candidate had been scouted yet).

## GROUNDING INTEGRITY theme — open

- [decision] :: VEIN MOSTLY EXHAUSTED (fire 19; note fire 20 found a real paper-grounded hole via the new-arXiv escape-hatch, so occasional value remains), 2nd consecutive clean scout): the deterministic grounding/self-improvement hardening vein is mined out — axis A (provenance, empty-evidence fail-close ×3 gates, conflict, citation precision+recall, date-drift), axis B reliability (reward/decay/probation/graduation/BKT/polarity/persistence), axis C (judge gates + 2 judge-drills) all shipped + densely tested. NEXT high-value requires a value-class PIVOT (retrieval/recall quality; learned-state UX surfacing) or a fresh open-arXiv mechanism — recommend 진안 repoint the theme or wind down (CronDelete 8ed88aa8). The loop will otherwise honestly produce small/no-op fires.

- [open] :: VEIN STATUS (fire 16): the deterministic grounded≠true fail-open vein is effectively exhausted (precision/recall/groundedness triad complete; all 3 judge gates empty-evidence-closed; provenance+conflict+date guards shipped). Next high-value moves are NOT more fail-open hunting but: (a) track citation precision/recall + faithfulness as a `muse doctor --grounding` / self-eval metric over a fixture corpus; (b) pivot value-class to retrieval QUALITY (recall@k / rerank) or chat-surface parity of the ask cues; (c) honest wind-down. Pick one next fire.


- [done] :: untrusted-only provenance firing now CITATION-INDEPENDENT (ask AND chat) — competitor-grounding fire 40 (grounding-floor). The untrusted-source cue fired only when the model emitted `[from <src>]` (`groundedOnUntrustedOnly`/`untrustedOnlySentences` both require citations; `groundedOnUntrustedOnly` returns false on `cited.length===0`), yet `verifyGrounding` accepts zero-citation answers — so a grounded-but-non-citing answer resting entirely on poisonable tool data got NO warning. Added the deterministic `evidenceIsUntrustedOnly(matches)` (@muse/agent-core: pool non-empty + every match `trusted===false`) ORed into BOTH notices, so the cue fires on structurally tool-only grounding even when the 8B skips the marker. Conservative-safe: a single trusted note -> silent (mixed is the per-claim guard's job); a notes answer can NEVER trip it (trusted-absent ≠ false). Non-answer guards on both surfaces (ask: empty + `answerIsRefusal`; chat: empty + abstention). Opus (4)b judge PASS 7/7 (3 mutations; no false-positive on the notes safety cue). · RESIDUAL (deferred, live-measurement): the production firing-RATE via `eval:grounding-delta` on a `--with-tools` poisoned-source case — now bounded below by the deterministic structural fire, so the citation-dependence risk is closed; measuring the remaining citing-path rate is a separate live-eval slice.
- [done] :: broaden source-conflict value extraction — core-hardening fire 10 (@muse/recall, memory-integrity; this fire was the JUDGE-DRILL). The list-vs-value problem (fire-9 analysis) is solved by LABEL-GATING instead of a global widen: the regex now allows commas (`[^\n.;]+`) but `fieldsOf` truncates at the first comma for EVERY field EXCEPT `ADDRESS_LABELS` (address/addr/location/주소/주소지/위치/소재지/거주지) — so an address keeps its internal comma (`12 Baker St, London` vs `…Paris` now CONFLICTS, was missed) while a benign comma-list (items/tags/attendees/ingredients) is byte-for-byte unchanged (0 new false-positives, proven by (4)b equivalence test). OUTCOME + mutation verified (EN+KO address conflict caught, 3 benign-list guards stay non-conflicting; @muse/recall 338 tests + Opus (4)b adaptive judge PASS). RESIDUAL ·: ADDRESS_LABELS omits `home`/`street`/`address line` (same false-negative direction, additive later); a single-line `address: …, x other: y` swallows the trailing field into the address value (cosmetic — conflict still surfaces, only mislabelled).

## Open — differentiation (vs hermes/openclaw — `differentiation` loop)

- [decision] :: **fresh non-contended axis VEIN EXHAUSTED (fire 16)** — after 7 levers (L1–L7) + 6 CI-defended batteries, a research pass found no genuinely new non-contended axis; the one fresh competitor weakness (self-authored-skill admission, hermes #25833 / openclaw plaintext Dreaming) is ALREADY closed in Muse (scanSkillBodyForRisks->quarantine, deterministic draft reject, execute-gating) so it's an L2+L6 extension, not a new lever. The differentiation thesis is comprehensive. Future fires: widen/consolidate existing levers, or 진안 may retheme the loop. (differentiation fire 16)
- [open] :: **(hand-off -> agent-core/skill-authoring loop) `validateSkillToolReferences`** — the one genuine gap Muse lacks (Hermes #25833 dangling-reference half): validate a self-authored skill body references only tools in the live registry. Touches `packages/skills` + skill-review = owned-loop territory, not the differentiation loop's. Source: differentiation fire 16 scout.

## Open — tool-mcp-browser axis C (browser)

- [open] 2026-06-12 :: BLOCKER (scout finding, fire 23) **browser vein 고갈 — same-origin iframe piercing is ALREADY shipped (no gap).** captureSnapshot's element-walk (puppeteer-controller.ts ~363) descends into same-origin iframe `contentDocument` (like shadow roots), assigns the same `data-muse-ref` scheme across frames under the BROWSER_ELEMENT_CEILING cap, and `try/catch`-skips cross-origin frames without crashing; resolveRef iterates `page.frames()` so an iframe-embedded control is both observed AND clickable. Shipped 2026-06-12 by commit 178c953a (`feat(browser): observation completeness — same-origin iframe piercing + element paging`), with the live smoke already in `scripts/smoke-browser.mjs` step 7 (real `srcdoc` iframe button observed + clickable cross-frame; RED-able by reverting the walk). The 3 candidate axis-C gaps the fire-21 scout flagged are now ALL closed: select (fire 21), file upload (fire 22), same-origin iframe read (178c953a). Recommend repointing the theme or winding down axis C (CronDelete the loop) — further C fires will honestly produce small/no-op work. (fire 23 made NO code change per the honest-stop rule.)

- [open] :: (scout finding, fire 21) browser `<select>` dropdown selection is ALREADY handled — browser_type on a role=combobox/<select> grounds the text to an option via matchOption (fail-close: unmatchable option refused, options listed), confirmed in puppeteer-controller.ts type(). NOT a gap; future scouts skip it. **Browser micro-fix vein is thinning** (fires 1/4/6/9/11/13/15/16/17/18 covered ambiguity/non-typeable/link-url/nav-status/prompt/CDP-timeout/wait/linkCount/fill-form; select handled). Remaining candidate distinct C gaps to verify next: same-origin iframe read · file upload · a real CDP error-surfacing edge. If next 2 scouts also come up clean, rotate value-class per EXHAUSTION. (fire 21 deferred its code slice — API was rate-limiting subagent dispatch, so an independent (4)b judge couldn't run; no unverified code committed.)

- [done] 2026-07-03 :: (2026-07-03, eaee9691) doctor posture allowlist mismatch fixed — `describeOfficialMcpPosture` now mirrors `assembleMcpStack`'s turnkey auto-add (`enabled && credentialPresent`), so an eligible preset is never falsely reported "blocked". Documents the one unmodeled mcp.json-override edge case. Mutation-checked + independent-evaluator PASS. 11 tests (2 flipped/added).


- [done] 2026-07-03 :: (2026-07-03, 9fe88bcd) credential-file whitespace trim fixed at the shared root — `stringField` (provider-utils.ts) now trims + rejects whitespace-only, fixing all 4 real call sites at once (MCP token, model API key, suggestedModel, messaging bot token), not just the MCP case. Mutation-checked + independent-evaluator PASS. 662 tests. Native OS-keychain backend remains open (separate, bigger design piece).

## Open — computer-control multi-step reliability (진안-directed 2026-06-16, axis (1)+(2))

Direction picked by 진안: make Muse "control the computer" well. The PRIMITIVES already
exist (`@muse/fs`: file_read/list/grep/write/edit/multi_edit/delete/move, all gated +
path-safe; `run_command` via crates/runner; browser track). The real bottleneck is the
LOCAL 12B completing a MULTI-STEP computer task end-to-end, not more primitives.

- [done] 2026-06-16 :: ->Done **file_grep no-path default scoped to home -> dead-ends a narrowed sandbox** (2026-06-16,
 measure-first finding from the new eval:computer-task) — `fs-read-tools.ts:361` defaulted the
 search scope to `homedir()` when `path` was omitted. Fine for personal recall (roots=home), but
 when roots are narrowed to a workspace/project the home default falls OUTSIDE roots -> REFUSED, and
 gemma4 (which routinely omits the optional `path`) retried 3× then gave up — never reaching the
 file. FIX: default scope = first configured root when `roots` is set, else homedir() (recall
 default preserved). TDD RED->GREEN (`fs-read-tools.test.ts` "defaults the scope to a configured
 root"), fs 93/93, lint 0. This alone flipped eval:computer-task from 0/1 -> PASS.
- [done] 2026-06-16 :: ->Done **file_edit literal-`\n` repair -> eval:computer-task 1-2/3 -> pass^5 5/5** (2026-06-16) —
 DIAGNOSED deterministically (`applyEdit` repro): gemma4 DOUBLE-ESCAPES newlines, emitting the two
 chars `\` `n` in its tool-call JSON instead of a real newline, so a multi-line `old_string` matched
 neither exact NOR the existing Codex-style fuzzy fallback (`findFuzzyBlock` splits on real `\n`, so a
 literal-`\n` string is one un-splittable line) -> `not found`, and 12B recovery was inconsistent. FIX
 (`fs-write-tools.ts`): extracted the exact+line-block match into `matchAndReplace`; when it misses,
 `unescapeWhitespace` un-escapes literal `\n`/`\r`/`\t` in old AND new together and retries ONCE —
 adopted only when the repaired form actually matches (a verbatim backslash-n in source is caught by
 the exact pass first, so it's never rewritten; no location guessing). tool-calling.md rule 7
 "validate + repair deterministically". TDD RED->GREEN (repair + verbatim-no-rewrite), fs 95/95,
 repro 4/4, lint 0. Live: `MUSE_EVAL_REPEAT=5 eval:computer-task` = **5/5** (was ~1-2/3). Per 진안:
 eval STAYS report-only (NOT in eval:agent CI bundle) — it's a measurement, not a gate.
- [done] 2026-06-16 :: ->Done (2) **read-before-edit grounding gate** (2026-06-16) — the actuator analog of "every claim
 cites a source": `file_edit`/`file_multi_edit` FAIL-CLOSE on a target this run never `file_read`
 (Muse mutates only a file it has actually seen — codex edits freely). Deterministic + fail-close +
 back-compat: `FsReadToolsOptions.onPathRead(canonicalPath)` fills a per-run set on every successful
 read; `FsWriteToolsOptions.wasPathRead(canonicalPath)` is checked in `editExecutor` right after the
 safe-path resolve; BOTH optional ⇒ unset = no gate (every existing caller/test unchanged). Keyed on
 the resolved canonical path so read and edit agree. Wired in production (`commands-ask.ts`: shared
 `fsReadPaths` Set across the fs read+write tools) and live in `eval:computer-task`. file_write
 (create) is intentionally NOT gated; only mutate-existing is. TDD: fs **100/100** (fail-close when
 unread, applies when read, canonical-key, onPathRead fires on success / not on failed read), CLI
 tsc 0, lint 0. Live `MUSE_EVAL_REPEAT=3 eval:computer-task` = **3/3** — the gate does NOT break the
 completion path (model reads before editing). NOTE: still report-only per 진안 (not in eval:agent).
- [done] :: **wrong-tool selection on the file-fix task — FIXED (computer-control fire 4) as a clean DETERMINISTIC structural bug, NOT the fuzzy ranking fires 1-3 concluded.** Deeper measure-first found the real cause: 10 always-on MANDATORY tools (math_eval/regex_extract/time_add/math.evaluate/context×3/skills×3) alone EXCEED `DEFAULT_TOOL_EXPOSURE_CEILING=6`, so `capToolsByRelevance`'s `remaining=max(0,6−10)=0` branch dropped the ENTIRE optional tail — file_read/grep/edit went INVISIBLE (2/2 STABLE FAIL). FIX (`tool-filter.ts`): reserve up to `RELEVANT_OPTIONAL_FLOOR=3` slots for positively-relevant optional tools (irrelevant still dropped) + a `FILE_PATH_RE` boost so the file cluster tops the reserve. OUTCOME: eval:computer-task 2/2 STABLE FAIL -> pass^3 3/3 PASS. Deterministic unit tests + Opus (4)b judge PASS. RESIDUAL ·: the always-on bloat itself (time/math/regex as `domain:"core"` across 6+ files) is a BROAD design-sensitive refactor needing keyword coverage + cross-surface verify — NO current measured failure (fire-4 reserve makes eval PASS), so deliberate, not auto-fire.
- [done] :: **code-task tool keywords — run_command was unreachable for run/test tasks (computer-control fire 6).** measure-first on `eval:multifile-fix` ("run the test, fix the bug"): `run_command` (domain="system") had **ZERO keywords** -> scored 0 -> starved under the cap; file tools missed code-fix verbs. FIX (sibling-audit): run_command keywords `run/command/execute/shell/test/compile/실행/명령/테스트/빌드`; file_read/grep/edit/multi_edit += `code/source/bug/fix`. OUTCOME: multi-file exposure improved (file_read + run_command now reach the model); eval:computer-task stays PASS. Mutation-valid test (run_command wins a CAPPED slot only with keywords) + Opus (4)b judge PASS (IrrelAcc = approval-gated selection-noise, not harm; write tools NOT over-exposed). · REMAINING (see fire 7).
- [done] :: **file_edit unreachable for code-edit intent — FIXED (computer-control fire 7).** The write-tool gate (`write_without_mutation_intent`, `packages/tools/src/index.ts`) blocks write tools unless `isWorkspaceMutationPrompt` is true, but its vocab was workspace-OBJECTS only (issue/task/note) -> a code-fix prompt ("fix the bug in the source file") scored false -> file_edit BLOCKED. FIX: added code-edit vocab to the 3 hint lists — workspaceHints/mutationTargetHints += file/source/code/bug/function (+KO), mutationPatterns += fix/debug, koreanMutationHints += 고쳐. OUTCOME (probe): file_edit now exposed for code-fix prompts; single-file eval PASS (no regression). Mutation-valid test (RED on revert, needs all 3 hint dims) + Opus (4)b judge PASS. **EXPOSURE CHAIN NOW COMPLETE (fires 4·6·7): file_grep/read/edit/run_command all reachable for a code-fix task.** HONEST RESIDUAL ((4)b-flagged): the relevance-gate backstop excludes unrelated workspace writes for fix/debug prompts (0 leak) but NOT for `add`/`create` homonyms ("add a function to the file" leaks tasks.add/calendar.create — PRE-EXISTING keyword overlap, bounded by the draft-first approval gate so exposure≠write; narrow those tools' add/create keywords if it bites). · REMAINING (multi-file still FAILs): purely **12B multi-step reliability** — even with ALL tools exposed the model uses only file_read and stops (NOT exposure; a model-behavior / agentic-persistence problem, not tool-filter).
- [done] :: **file_edit no-match error gives a nearest-line hint so the 12B can self-correct (computer-control fire 8).** A 3× scout confirmed @muse/fs is well-hardened (path-safety on all write tools incl. file_move from+to; read-before-edit on both edit tools via shared editExecutor; sophisticated edit repair: exact + whitespace-fuzzy line-block + double-escape un-escape, all uniqueness-fail-closed). The one gap: on a GENUINE content miss (not whitespace — fuzzy bridges that), `applyEdit` returned only `old_string not found: <80 chars>` with no path to self-correct. FIX (`fs-write-tools.ts` `nearestLineHint`): rank the file's lines by shared-word overlap with old_string's first line; if the best shares ≥max(2,⌈words/2⌉) words, append `Closest line in the file is "<line>" — copy the exact text`. Pure/deterministic, FAILURE-message only (never changes which edit applies or causes a write — fail-closed posture intact), noise-suppressed (unrelated miss -> no hint, bounded 120 chars). Mutation-valid test (RED with helper stubbed) + Opus (4)b judge PASS. · COMPUTER-CONTROL CLEAN-DETERMINISTIC VEINS NOW LARGELY EXHAUSTED: exposure chain done (4·6·7), fs primitives hardened (8); the remaining multi-file blocker is **12B multi-step behavior** (model uses only file_read) — a fuzzy/stochastic agentic-persistence problem, NOT a deterministic tool/fs slice. Next deliberate candidates: agentic-persistence prompt tuning (stochastic, dedicated eval budget) or the 10-mandatory bloat refactor (broad, design-sensitive).
- [done] :: **hallucinated tool name gets a nearest-registered-tool suggestion so the 12B self-corrects (computer-control fire 9).** A deeper measure-first trace of eval:multifile-fix (MUSE_TASK_DEBUG) found the model CAN multi-step (read->read->edit, fixing the bug so test-passes=true) but FAILS to run the test because it HALLUCINATES a tool name (`node_run`) instead of the registered `run_command` — and the bare `Error: tool not found: node_run` left it stuck. FIX (`packages/tools/src/executor.ts` `nearestToolName`): on a not-found tool, suggest the registered tool sharing the most snake/dot-case tokens (≥1 required) — `node_run` -> `. Did you mean 'run_command'? Call that exact registered name.`. Deterministic, only on the not-found branch (no happy-path cost), text-only in a failed-call error (re-enters all gates; no execution). Mutation-valid test (RED with helper stubbed; negative guard: unrelated name -> no suggestion) + Opus (4)b judge PASS. · DEEPER FINDING (multifile is stochastic, multiple 12B failure modes, NOT flipped by this fix): (1) early-stop after file_read; (2) `node_run` hallucination (THIS fix helps); (3) **garbage tool name with leaked gemma chat-template tokens** (`node --exec … <|channel>thought`) — [done] PARTIALLY ADDRESSED computer-control fire 11: `adapter-ollama.ts` `sanitizeToolCallName` cuts a tool-call name at the first `<|` template marker + strips control/zero-width chars (both generate AND stream parse sites), so a name corrupted by a TRAILING leaked token (`run_command<|channel|>` -> `run_command`) now resolves instead of failing tool-not-found. mutation-valid (revert -> both tests RED) + Opus (4)b judge PASS (no over-stripping of clean/dotted/dashed/Cyrillic names; byte-hygiene escaped char class). A FULLY-garbage base (shell-command-as-name) survives the cut and stays unresolvable — that's model-behavior, not adapter parsing. Also: eval:multifile-fix's `modelRanTest = toolsUsed.includes("run_command")` is brittle path-grading (won't credit a correct fix that ran via another command) — agent-testing.md says grade OUTCOME (test-passes), a separate eval-correctness cleanup.
- [open] :: **DELIBERATE (not auto-fire) — multifile ceiling is 12B model-behavior, confirmed computer-control fire 12 measure-first.** With exposure (4·6·7), error-recovery (9), and adapter sanitisation (11) all fixed, a re-measured run hit the **early-stop** mode: the model calls file_read ONCE then voluntarily stops (no grep/edit/run) despite the SYSTEM persistence lines — NOT an iteration cap (the single-file eval does grep->read->edit). The remaining modes are model-behavior, not deterministic tool/fs/adapter gaps — the clean deterministic computer-control veins are exhausted. Candidate for DELIBERATE work (needs design, NOT a 15-min auto-fire): a **verifier-backed action-completion nudge** in agent-core — when the model returns a final answer with NO state-changing tool called on a task that required action, re-prompt ONCE. BLOCKER: per reflection-guard.md any new retry surface needs a deterministic verifier + registry entry, and "action-task vs answer-only" classification is fuzzy (a generic nudge mis-fires on legitimate answer-only turns) — a careful core-loop change, not auto-loop fodder.
- [done] :: **read-before-OVERWRITE grounding gate on file_write — closed a fabrication=0 hole (computer-control fire 13).** The read-before-edit invariant (Muse only mutates content it has actually read) was enforced on file_edit/file_multi_edit (shared editExecutor) but NOT on file_write — which CREATES or fully OVERWRITES a file. So a model could `file_write`-overwrite an EXISTING file with content it never read (silent data loss + ungrounded mutation, violating the fabrication=0 floor the theme requires on every actuator). FIX (`fs-write-tools.ts` createFileWriteTool): `if (exists && options.wasPathRead && !options.wasPathRead(safe))` fail-close — overwrite of an existing unread file is refused; CREATING a new file needs no read (nothing to ground); back-compat (wasPathRead undefined -> gate skipped). LIVE in production (CLI `commands-ask.ts:1500` wires `wasPathRead` into `createFsWriteTools`). Mutation-valid 3-case test (overwrite-no-read fail-close + overwrite-with-read allowed + create-no-read allowed) + Opus (4)b judge PASS (no over-block, create path + symlink/TOCTOU/approval guards untouched, editExecutor parity exact). Sibling-audit: read-before-edit applies to CONTENT-mutating tools (edit/multi_edit/write-overwrite); file_delete/move are not content mutations (own guards) — content-mutation coverage now complete. Shows the computer-control theme is NOT fully exhausted: the grounding-gate dimension ("every actuator passes the gate") had an unaudited surface.
- [done] :: **a PARTIAL grep/offset read must not ground a whole-file overwrite (computer-control fire 14 — refines fire 13).** fire-13's overwrite gate was satisfied by `wasPathRead`, which file_grep ALSO sets (so the grep->edit loop works) — but grep shows only matched lines, so a model could grep a file then `file_write`-overwrite it, silently dropping every unseen line. FIX: a stricter `wasPathFullyRead` (file_write-overwrite checks `wasPathFullyRead ?? wasPathRead`); `file_read` fires a new `onFullRead` ONLY on a COMPLETE read (`start === 0 && !truncated` — NOT an offset-skipped tail, NOT a limit/maxTextChars-truncated read), file_grep never fires it. file_edit/multi_edit unchanged (grep->edit intentionally still allowed). CLI wires a second `fsFullReadPaths` set. Mutation-valid tests (write: partial-grep->fail-close, full->allowed; read: complete fires onFullRead, limit/offset/grep do NOT). **maker≠judge worked on a REAL slice**: (4)b judge #1 FAILed it — the first impl gated `onFullRead` on `!truncated` alone, which an OFFSET-only read (offset:96 -> lines 96-100, truncated=false) wrongly satisfied, re-opening the hole via offset; fixed to `start===0 && !truncated` + an offset test; (4)b judge #2 (independent) PASS (offset hole closed, all edge cases correct, no regression, 131/131). LESSON: read PRESENCE ≠ read COMPLETENESS — a grounding gate that means "saw the whole file" must check the read STARTED at the top AND reached the end, not just "not truncated".
- [done] :: **run_command dynamic-loader env injection blocked (computer-control fire 15, §3.6 security).** The Rust runner spawns `Command::new(cmd).args(args)` (no shell -> no shell injection) and rejects path commands — but the model-supplied `env` map was validated only by KEY FORMAT (uppercase identifier), so `LD_PRELOAD` / `LD_LIBRARY_PATH` / `LD_AUDIT` (glibc) and `DYLD_INSERT_LIBRARIES` / `DYLD_*_PATH` (macOS dyld) — all valid identifiers — passed through and would load ARBITRARY CODE into the spawned process, escaping the no-shell + path-reject guards (a real code-exec / sandbox-escape from untrusted model input). FIX at BOTH layers (defence-in-depth, sibling-audit): TS `runner.ts` `readStringRecord` drops keys matching `/^(?:LD|DYLD)_/`; Rust `is_safe_env_key` rejects `LD_`/`DYLD_` prefixes (the authoritative gate on `command.env(...)`). Precise (trailing `_` -> keeps `LDFLAGS`/`LOAD_PATH`/`MY_LD_PRELOAD`). Mutation-valid both layers (TS 284, Rust `cargo test` 7) + Opus (4)b judge PASS (no over-block, both layers block the same family, prior env guards intact, honest scope = the well-known LD_/DYLD_ core, not every conceivable env vector). Distinct (pkg=@muse/tools+crates/runner, kind=security/path-safe) — the §3.6 untrusted-input->command threat the theme mandates.
- [done] :: **run_command env injection — the WHOLE code-injection family (computer-control fire 16, sibling-audit of fire 15).** fire 15 blocked only the dynamic loader (LD_/DYLD_) but that was 1 of ~24 family members — `NODE_OPTIONS` (=`--require`/`--import` runs arbitrary code in `node`, the runtime Muse actually shells out to), shell startup (`BASH_ENV`/`ENV`/`SHELLOPTS`), interpreter opt/path injection (`PERL5OPT`/`PERL5LIB`, `PYTHONSTARTUP`/`PYTHONPATH`, `RUBYOPT`/`RUBYLIB`), and git command-exec hooks (`GIT_SSH_COMMAND`/`GIT_EXTERNAL_DIFF`/`GIT_PAGER`/`GIT_PROXY_COMMAND`/… + `GIT_CONFIG*` which point git at an attacker config that re-sets `core.sshCommand`/`core.pager`) all still passed. FIX: `UNSAFE_ENV_EXACT` denylist (the exact family) + the LD_/DYLD_ prefix, at BOTH layers (TS `isUnsafeEnvKey` + Rust `is_safe_env_key`), lists IDENTICAL. Exact-match precision keeps legit `NODE_ENV`/`GIT_DIR`/`GIT_AUTHOR_*`/`PYTHONUNBUFFERED`. Mutation-valid (TS 285, Rust `cargo test` 8) + Opus (4)b judge PASS — the judge flagged `GIT_CONFIG*` as the strongest remaining miss (2nd path to the blocked git-exec hooks) and it was added in the same slice. LESSON: a sibling-audit must enumerate the FULL class, not the first member found — fire 15 fixed 1/24 and called it done; the right question at LD_PRELOAD was "what is the WHOLE family of code-injection env vars," per-runtime.
- [done] :: **run_command resource knobs clamped — unbounded timeout/output DoS (computer-control fire 17).** `timeoutMs`/`maxOutputBytes` are model-supplied tool-schema fields with only a LOWER bound (≥1) — so `timeoutMs:999_999_999` (~11.5 days) wedges the runner and `maxOutputBytes:5e9` buffers unbounded output into memory. FIX (both layers, identical ceilings 10min/10MB): TS `readPositiveInteger(value, max)` clamps via `Math.min`; Rust `effective_timeout_ms`/`effective_max_output_bytes` via `clamp(1, MAX)`; the inputSchema also gained `maximum:` (defence-in-depth + model guidance). A legitimate 9-minute build (540_000ms) passes unclamped; clamp (not reject) keeps the command running, just bounded. Mutation-valid (TS 289 + Rust `cargo test` 9; both go RED on un-clamping) + Opus (4)b judge PASS (TS/Rust ceilings identical, no TDZ on the factory-read schema consts, watchdog bounded ≤605s, prior guards intact). Distinct (kind=resource-bound) from the env-injection fires. NOTE — measure-first this fire (multifile eval, all of fires 4-16 in place): the model now investigates correctly (file_read test -> file_grep -> file_read source) but STOPS before file_edit — a SHARPER characterization of the agentic-persistence ceiling than fire 12 (the deterministic exposure/recovery/grounding layers all work; the model reaches the right files; it just does not follow through to the edit). The remaining multifile blocker stays the deliberate verifier-backed action-completion nudge (agent-core core-loop, not auto-fire).
- [done] :: **fs credential deny-list — common credential/key-store files (computer-control fire 18, §3.6 sibling-audit).** The fs path sandbox (resolveSafePath, shared by ALL @muse/fs tools) denied .ssh/.aws/.env/*.pem/*secret*/*credential*/*token*/id_rsa, but a probe found common credential leaves STILL readable/writable: `.npmrc` (npm auth token), `.netrc` (login), `.pgpass` (postgres pw), `.pypirc` (PyPI token), and key-store containers `*.pfx`/`*.jks` (`.p12` was caught only when the name also held "secret"). FIX (DEFAULT_DENY_BASENAME_PATTERNS, leaf-only): `/^\.(npmrc|netrc|pgpass|pypirc)$/` + `/\.(p12|pfx|jks|keystore)$/`. `.key` deliberately EXCLUDED (collides with Apple Keynote — `slides.key` stays allowed; `.pem` already covers real key material). Mutation-valid (8 files ALLOWED pre-slice -> denied; over-block probes clean: notes.txt/config.yaml/package.json/npmrc.md/report.p12.txt all stay allowed) + Opus (4)b judge PASS (exact-dotfile + extension-at-end anchoring, no regression to the prior corpus, 143/143). Out of scope (honest): run_command is the general approval-gated executor, NOT the resolveSafePath sandbox — its file access is a separate model. Distinct (kind=security/credential-deny).
- [done] :: **file_grep ReDoS guard — a model regex can no longer hang the agent (computer-control fire 19, §3.6).** file_grep compiles a MODEL-supplied pattern with `new RegExp(pattern,"u")` (JS backtracking engine, NO timeout) and runs it line-by-line IN Muse's Node process — a confirmed probe: `(a+)+$` on a 40-char failing line HANGS forever (ReDoS, wedges the agent). FIX (`fs-read-tools.ts` `isCatastrophicGrepPattern`): reject the classic nested-quantifier form `/\([^()]*[+*][^()]*\)(?:[*+]|\{\d+,\})/` (an unbounded quantifier on a group whose body also has one — `(a+)+`/`(.*)*`/`(\d+){2,}`) BEFORE compiling, with a clear "simplify it" error so the model retries. Mutation-valid (unit it.each flags 6 catastrophic / allows 7 safe incl. `(abc)+`/`a{2,5}`/`a+b+c+`; detector->false makes the unit tests RED and the integration test HANG = the guard is load-bearing) + Opus (4)b judge PASS (ZERO over-block on 11 realistic 12B grep patterns; runs before compileGrepPattern; malformed-`(`-to-literal degradation intact; grep-only). HONEST RESIDUAL ((4)b-confirmed): the FLAT-group heuristic still misses `((a+))+` (nested parens) and `(a|aa)+` (alternation-overlap) — both still hang. Alternation can NOT be cleanly detected (would over-block safe `(a|b)+`); the complete fix is a worker-thread + kill-timeout (catches ALL forms regardless of shape) — a deferred deeper slice. The common 12B-emittable form is closed. Distinct (kind=regex-safety/ReDoS).
- [done] :: **JUDGE-DRILL #2 + harden the ReDoS allow-corpus (computer-control fire 20).** firesSinceDrill=10 / 8-consecutive-PASS triggered the mandatory drill. Injected a plausible "improvement" — close fire-19's alternation-overlap residual by adding `|` to the detector's inner class (`[+*|]`) + a test asserting `(a|aa)+` is now flagged. ALL deterministic gates passed (157 green) because the existing "allows" corpus had NO quantified-alternation pattern. The independent Opus (4)b judge FAILED it with concrete evidence: `(foo|bar)+`/`(TODO|FIXME)+`/`(a|b)*`/`(error|warn|info)+` are now wrongly rejected (TIMED sub-millisecond on a 50K failing line -> NOT catastrophic; non-overlapping alternation is linear), a fresh regression vs fire-19, and the test corpus is BLIND to it. Rolled back (detector unchanged from fire-19). REAL FIX (the drill's lesson): hardened the "allows" it.each with the safe quantified-alternation patterns the drill exploited (`(foo|bar)+`, `(TODO|FIXME)+`, `(a|b)*`, `(import|export)\s+\w+`, `(GET|POST|PUT)\s`, `(error|warn|info)+`) — mutation-verified: re-applying the drill's `[+*|]` broadening now turns those tests RED, so a future over-block of safe alternation is caught by the gate (it was invisible before). LESSON: the drill's 2nd success shows the verifier catches a gate-passing regression by REASONING+PROBING+TIMING; and the right post-drill fix is to close the test-blindness the drill rode in on, not just revert.
- [done] :: **file_read/file_grep missing-path -> actionable recovery hint, not a raw ENOENT (computer-control fire 21).** A non-existent DIRECT path returned a raw Node errno — `{error:"ENOENT: no such file or directory, stat '/abs/path'"}` — which dead-ends the 12B (can't self-correct off an errno) AND leaks an absolute host path. FIX (`isNotFoundError` = code==="ENOENT"): both tools now return an actionable message naming the recovery tool — file_read `"no file at '<input>' — check the path, or use file_list (e.g. pattern \"**/<basename>\") to locate it"`; file_grep `"no path '<scope>' to search — … use file_list to find the right directory"`. Sibling-audit: file_list on a missing cwd already returns a clean `{count:0,paths:[]}` (left as-is — an empty list is a clear non-leaking signal). KIND = reliability/error-recovery (not security). Mutation-valid both (RED on raw-errno; grep branch revert -> RED) + Opus (4)b judge PASS: ENOENT-only intercept (denied->still refused, existing->reads, directory->"directory", EACCES->falls through to the real error, malformed-regex->still literal-degrades), outcome-graded, and a BONUS info-leak reduction (message echoes the model's own `input`, not the symlink-resolved `/private/var/...` the old errno leaked). Helps the multi-step grep->read->edit loop recover instead of stalling. Distinct (kind=reliability-nudge, like fires 8-9).
- [done] :: **file_edit/file_multi_edit missing-file -> actionable hint (computer-control fire 22, fire-21 sibling completion).** fire 21 fixed file_read/file_grep ENOENT but MISSED the write actuators — file_edit/multi_edit on a non-existent file returned the SAME raw `ENOENT … stat '/abs'` errno (dead-ends the 12B at the COMPLETION step + leaks the resolved host path). FIX (one branch in the shared `refusal` helper, code==="ENOENT"): both tools now return `"no file at '<input>' — to create it use file_write; to edit an existing file, check the path or use file_list to find it."`. Covers file_edit AND file_multi_edit (shared editExecutor->refusal); file_write is correctly EXCLUDED (it mkdir -p's its parent, never hits this — (4)b verified it auto-creates). Mutation-valid (branch removed -> RED with the raw errno; restored -> 164 green) + Opus (4)b judge PASS: ENOENT is the 3rd branch (PathSafetyError refusal -> ELOOP symlink -> ENOENT -> generic), so denied-path/symlink/old_string-not-found/directory/existing-edit all keep their own outcome (probed); uses the model's input `path` not the resolved abs (no leak). One non-blocking nit (a dangling symlink hits ENOENT before ELOOP -> slightly-off hint, but no regression vs the old raw errno). Distinct (kind=reliability-nudge).
- [done] :: **run_command spawn failure -> actionable message (computer-control fire 23, reliability-nudge on a DIFFERENT package).** The Rust runner (`crates/runner`) returned a raw `"failed to spawn command: No such file or directory (os error 2)"` when a command could not be spawned — the 12B can't tell a typo from an uninstalled tool. FIX (`describe_spawn_error(command, error)`): `ErrorKind::NotFound` -> `"command '<cmd>' not found — it is not installed or not on PATH; check the name."`, `ErrorKind::PermissionDenied` -> `"command '<cmd>' is not executable (permission denied)."`, everything else -> the original generic message (unchanged). Wired into `run_request`'s spawn `Err` arm; TS passes `error` through to the model unchanged (no TS edit). Mutation-valid (NotFound arm -> generic makes the cargo test RED; restored -> 10 passed) + Opus (4)b judge PASS: pure error-text formatting AFTER an already-failed spawn (zero change to what spawns or the security posture — blank/path/env guards all precede it), names the model's own `request.command` (no host-path leak), generic fallthrough preserves every other error verbatim. Diversity: pkg=crates/runner (off the @muse/fs streak), kind=reliability-nudge. Honest bound: the eval binary may be a stale copy, but the source is correct + cargo-tested.
- [done] :: **file_read paging hint `nextOffset` — the model pages a long file deterministically (computer-control fire 24).** A line-truncated text read returned `{truncated:true, totalLines}` with NO continuation guidance, so the 12B had to GUESS the offset to read the next page of a long file. FIX: the text-read result now carries `nextOffset` = the 1-based line to resume at (`start + sliced.length + 1`) when LINE-truncated; OMITTED on a char-cap cut (`text.length > maxTextChars`) since a mid-line cut has no clean line offset (the char-cap branch clears it — char-cap wins). Description gained "a truncated result returns `nextOffset`; pass it back as `offset` to read the next page." Mutation-valid (no-nextOffset -> RED; the char-cap clear is independently pinned by a line-truncated+char-capped case -> RED when removed) + Opus (4)b judge PASS: round-trip paging has NO gap/overlap/off-by-one and the final page stops (truncated:false, no nextOffset); GROUNDING GATE UNCHANGED (nextOffset is purely additive — `onFullRead` still fires only on `start===0 && !truncated`, a paged read fires onPathRead only, never grounds an overwrite); PDF/DOCX/image returns gain no stray nextOffset. Distinct (kind=reliability-nudge, output-paging — the success path, vs the error-recovery nudges of fires 21-23).
- [done] :: **false-done backstop recognises the fs/run_command actuators (computer-control fire 25).** SCOUT FINDING: the agentic-persistence/false-done machinery ALREADY EXISTS and is WIRED — `answerClaimsAction` (detects "I fixed it") + `actionToolRan` (did a state-changing actuator run?) gate a flag in `commands-ask.ts:2590` and a RE-PROMPT in `chat-repl.ts:553`. BUG: `actionToolRan`'s `ACTION_TOOL_RE` predated the @muse/fs tools, recognising only `.add/.update/.delete/…` verb tools + `_action`, so `file_edit`/`file_write`/`file_multi_edit`/`file_delete`/`file_move`/`run_command` were NOT counted — a REAL file_edit on a code-fix task was misread as "no action ran", so the backstop FALSELY flagged an honest "I fixed it" as unbacked (and chat would spuriously re-prompt). FIX: added `|\b(?:file_(?:edit|write|multi_edit|delete|move)|run_command)\b` to the classifier. Mutation-valid (RED before; 6 mutators -> true, file_read/grep/list stay false) + Opus (4)b judge PASS: false-positive fixed (real file_edit no longer flagged) AND true-positive PRESERVED (a genuine false-done with actionToolRan([])===false still fires); no over-match on adversarial names (file_editor_config/run_commander/profile_edit all false); the existing tasks/calendar/memory verb arm byte-identical; 2533 agent-core tests green. Distinct (kind=honesty/false-done, pkg=@muse/agent-core). NOTE: this means the persistence re-prompt machinery exists and now WORKS for computer-control — narrowly avoided building a duplicate (scout caught the existing exports).
- [done] :: **false-done backstop REQUEST-side gate now recognises code-fix via a STRUCTURAL signal — RESOLVED by fire 27 (fire-26 blocker closed).** (fire-26 NO-SHIP history kept for the lesson:) Sibling of fire 25: the backstop is also gated by `classifyActionRequest`/`requestsToolAction`, which recognise reminder/task/calendar/email intents but NOT computer-control code-fix requests ("fix the bug in add.ts", "수정해줘") — so even with fire 25's actuator fix, the backstop NEVER ENGAGES for the theme on the CLI ask/chat path. ATTEMPTED a `CODE_ACTION_REQUEST_RE` (edit verb + code/file noun, START-anchored to exclude questions). TWO independent Opus (4)b judges FAILED it for OVER-MATCH that a lexical regex cannot avoid: v1 — bare homonyms (`change my class schedule`/`correct the error on my invoice`/`fix the line at the pharmacy`/`change the function next Friday` all -> true); v2 (homonyms removed, named-construct `<id> class` kept) — `the <adjective> class` defeats the determiner guard (`update the science class`/`change the spin class`/`fix the parking module`/`update the training module` -> true) + strong-noun non-code senses (`fix the variable rate mortgage`/`update the import tax`/`debug my code word` -> true). ROOT CAUSE: code-vs-non-code is a SEMANTIC disambiguation (is X a code identifier? is this a code context?), not a lexical one — homonyms (class/test/line/error/function/variable/import/code/syntax/typo) all have common non-code senses, so any verb+noun regex mis-routes innocent personal-assistant queries at commands-ask:903 (early return to a "needs --with-tools" guide). RIGHT DESIGN (deliberate, next): gate on a STRUCTURAL signal, not request text — engage the code-fix backstop only when (a) the run had FILE TOOLS exposed/available, or (b) the query contains an explicit file path / filename token (`\w+\.<code-ext>` or an absolute/relative path). Those are deterministic + homonym-free. Rolled back clean (agent-core back to fire-25 state; actionToolRan fs fix intact). LESSON: two independent judges catching realistic over-match = the maker≠judge control working as designed (organic, not a drill) — a fuzzy lexical classifier on homonym-heavy intent is the wrong tool; reach for a structural/deterministic signal.
- [done] :: **false-done backstop engages for computer-control code-fix requests — STRUCTURAL signal (computer-control fire 27, resolves the fire-26 blocker; completes fire 25).** Fire 25 taught the backstop's ACTION side (actionToolRan) to recognise fs actuators; this slice does the REQUEST side the right way — after fire 26's lexical attempt failed 3 independent judges on homonyms, `classifyActionRequest` now matches a code-fix request ONLY when the query carries an explicit CODE-EXTENSION FILENAME (`FILE_PATH_TOKEN` = optional path prefix + `name.<code-ext>` for ~40 code/config extensions). START-anchored on an edit verb (so questions like "how do I fix add.ts" stay false); KO mirror (filename + 고쳐/수정/…). The code-extension filename is homonym-free — no ordinary English word is `name.ts`, which kills BOTH the code-noun homonyms (fix the variable rate mortgage) AND the path-prefix homonyms (update my app/website) that broke fire 26 + the first fire-27 attempt. Deliberate precision-over-recall: a fileless "fix the bug" / bare "수정해줘" does NOT match (a miss costs nothing on the grounded path; a false positive would mis-trigger the backstop + the commands-ask:903 "needs --with-tools" guide). Mutation-valid (positives RED without the patterns; the path-prefix negatives RED if the token is relaxed) + Opus (4)b judge PASS on the 4th review (after v1/v2 code-noun FAIL + v3 path-prefix FAIL — each found a real over-match the next design closed): residual is only genuine .md files (correct) or contrived glued-token "dr.py"-style collisions (real abbreviations keep their post-period space -> false). Together with fire 25 the false-done backstop now fully works for computer-control on the CLI ask/chat path. Distinct (kind=honesty/false-done, pkg=@muse/agent-core). LESSON: a structural/deterministic signal (a code-extension filename) beats lexical intent-guessing on homonym-heavy classification — and 3 judge FAILs converging on the right design IS maker≠judge working.
- [done] :: **false-done backstop THIRD leg — answerClaimsAction recognises code-fix completion claims (computer-control fire 28, completes the backstop end-to-end).** The backstop ANDs three legs (query=classifyActionRequest [fire 27] && answer=answerClaimsAction && tools=!actionToolRan [fire 25]). `answerClaimsAction` recognised only reminder/task/calendar promises, NOT "I fixed the bug" / "수정했습니다" — so even with fires 25+27 the `&&` short-circuited and the backstop NEVER fired for a real computer-control false-done. FIX: a `CODE_DONE_RE` branch — a FIRST-PERSON PAST-TENSE mutation verb (fixed/edited/updated/changed/… case-insensitive `/iu`) OR a KO completion (수정했/고쳤/편집했/…). FULL-LOOP now composes (Opus (4)b judge verified end-to-end): code-fix request + "I fixed it" claim + NO actuator -> backstop FIRES (the false-done is caught/re-prompted); + a real file_edit -> NOT flagged. Mutation-valid (positives RED without the branch; the `/iu` flag is load-bearing — "I fixed" failed under `/u` because `i` only matched lowercase). Over-match contained: future ("I will fix")/offer ("shall I fix")/capability ("I can fix")/advice ("you should edit")/description ("the function returns…") all FALSE (past-tense anchor), and the broad past-tense match ("I changed my mind") only matters when the QUERY was already an action request (all 3 call sites AND-gate it) — the judge could not construct a realistic honest-answer end-to-end false-positive (legitimate "I read/reviewed/analyzed add.ts" stay false). fires 25+27+28 = the false-done/agentic-persistence backstop now works end-to-end for computer-control on the CLI ask/chat path (the fire-17 "model claims a fix without editing" failure mode is now caught). Distinct (kind=honesty/false-done, pkg=@muse/agent-core, the 3rd leg).
- [done] :: **JUDGE-DRILL #3 [done] + terse "Done." claim added safely (computer-control fire 29).** firesSinceDrill=10 triggered the mandatory drill. Injected a plausible "improvement" — add bare `\bdone\b` to CODE_DONE_RE so a terse "Done." reply counts as a completion claim, with a "Done."/"Done!" positive test. ALL deterministic gates passed (2537 green) because the answerClaimsAction negative corpus had NO "done"-negation case. The independent Opus (4)b judge FAILED it with concrete evidence: `\bdone\b` flags negations/partials/idioms/questions/passive ("I'm not done yet", "I'm almost done", "this isn't done", "well done!", "are you done?", "done automatically by the framework", and the worst "I'm done looking but I haven't fixed it") — and it DROVE THE ASSEMBLED GATE (code-fix query + "I'm not done yet" + no tool -> backstop FIRES -> re-prompts an HONEST in-progress answer), a precision regression on the safety-critical path. Rolled back. REAL FIX (the drill's twin lessons — test-blindness + a legit gap): (a) the terse-"Done." gap IS real, so added `TERSE_DONE_RE = /^\s*(?:all\s+)?(?:done|완료…)\s*[.!…]*\s*$/iu` — a WHOLE-ANSWER anchor (matches "Done."/"All done." but NOT embedded "done"), plus `완료` for the KO sentence form; (b) hardened the negative corpus with the 7 drill cases. Mutation-valid: reverting TERSE to bare `\bdone\b` turns all 7 hardened negatives RED (the over-match the drill rode in on is now caught) + Opus (4)b judge#2 PASS (terse claim true, every negation/idiom/passive false, `완료하려면`/`완료되지` false, 2537 green). LESSON: a drill's right real-fix can close BOTH a test-blindness AND a legit feature gap — implement the feature with the SAFE form (whole-answer anchor, not substring) the judge pointed to, and add the over-match cases as negatives so the bad form can never pass silently. The verifier drove the COMPOSED gate to prove harm — maker≠judge working (3rd drill).
- [done] :: **file_list returns a DETERMINISTIC (sorted) order (computer-control fire 30).** `file_list` returned matched paths in `glob` iteration order, which Node leaves filesystem/implementation-defined — the same cwd could list files in a different order across machines or pass^k eval repeats, a flaky input for the local model. FIX: `matches.sort()` (lexicographic by full canonical path) before returning. Honestly scoped: the glob loop still breaks at `limit`, so a >limit cwd's SET stays the glob-bounded first `limit` (pre-existing truncation) — only the returned ORDER is made deterministic (documented in a comment + the backlog). Mutation-valid (removing the sort turns the test RED — glob does NOT already return sorted order on the fixture) + Opus (4)b judge PASS: count/truncated/exclude/ignore/sandbox all unchanged (the sort only reorders the already-filtered, already-capped array); reproducible across machines; honest scoping (order not set). Distinct (kind=determinism/reproducibility, pkg=@muse/fs).
- [open] :: **BLOCKER / DECOMPOSE (computer-control fire 30): false-done RE-PROMPT in the AgentRuntime loop (to move the eval, not just the CLI chat).** fires 25/27/28/29 made the false-done backstop work END-TO-END on the CLI ask/chat path (chat-repl re-prompts a claimed-but-unbacked fix). BUT the `eval:computer-task` harness drives `AgentRuntime` DIRECTLY (createMuseRuntimeAssembly + the fs tools), bypassing chat-repl — so the eval does NOT benefit from the re-prompt, and the fire-17 early-stop (model investigates then stops before editing) still caps the eval. To move the eval, the detection (classifyActionRequest + answerClaimsAction + !actionToolRan — all built + tested) must drive a BOUNDED (max 1) re-prompt INSIDE the AgentRuntime run loop, reflection-guard-compliant (verifier = did an actuator run after the re-prompt). DEFERRED here because: (a) it touches the AgentRuntime core loop (shared server+CLI — invasive, highest blast radius), (b) Ollama is down on the loop box so the end-to-end eval effect can't be validated this fire, (c) it may duplicate/should-consolidate the chat-repl re-prompt (architecture decision: re-prompt at the runtime layer vs the CLI layer). Loop-sized sub-slices: (30a [done] fire 31) extracted `isUnbackedActionClaim({query, answer, toolNames})` in agent-core composing the 3 detectors, unit-tested + wired to the 3 existing CLI sites (DRY, behavior-preserving, the seam); (30b [done] fire 32) extracted `runResistingFalseDone` — a shared, generic, bounded-1-retry wrapper (clean-history re-run, verifier=actionToolRan) tested with synthetic results; chat-repl DRY'd to it; (30c) validate the real eval delta once Ollama is up (consolidate vs chat-repl). Needs 진안/Ollama for (30c).
- [done] :: **runResistingFalseDone — false-done re-prompt extracted to a shared bounded-retry wrapper (computer-control fire 32, decompose 30b).** The ACTION half of the backstop (the clean-history re-run on an unbacked claim) was INLINE in chat-repl:634. Extracted to `runResistingFalseDone({query, firstResult, retry})` in agent-core: if `isUnbackedActionClaim`, call the caller's `retry` thunk ONCE and keep the re-run only if `actionToolRan(retried)` (else keep the first — a 2nd unbacked never replaces the 1st). Generic over `{response:{output}, toolsUsed?}` (no AgentRuntime dependency), so chat-repl AND the eval/agent harness (30c) compose ONE definition. Reflection-guard-compliant: bounded to exactly one retry, deterministic verifier (did an actuator run), fail-closed. chat-repl DRY'd to it (behavior-IDENTICAL — Opus (4)b judge leg-for-leg diff; const-capture for the closure narrowing; actionToolRan removed from imports, isUnbackedActionClaim retained; builds exit 0). Mutation-valid (4 synthetic cases; `actionToolRan?retried:first`->`retried` makes the "re-run also fails->keep first" case RED). Honest bound: the EVAL does NOT compose it yet — 30c (wire the harness + validate the eval delta) needs Ollama. Distinct (kind=refactor/seam+bounded-retry, pkg=@muse/agent-core+apps/cli).
- [done] :: **file_read refuses a binary-content text file instead of returning corrupted text (computer-control fire 33).** A text-EXTENSION file (`.txt`/`.ts`/…) can actually be BINARY (a NUL byte). file_read's TEXT branch decoded its bytes as UTF-8 and returned NUL-containing "text" — corrupted, edit-poisoning content the model could try to mutate. file_grep already SKIPS binary files via `isProbablyBinary` (a NUL byte); file_read did NOT (sibling inconsistency). FIX: after `rawText = data.toString("utf8")`, `if (isProbablyBinary(rawText)) return {read:false, reason: "looks like a binary file (contains a NUL byte), not text — …"}`. The guard is in the TEXT branch only (image/PDF/DOCX/directory/unsupported untouched) and returns BEFORE onPathRead/onFullRead — so a refused binary read is fail-closed (cannot ground a later edit/overwrite). Mutation-valid (removing the guard -> the read:false + text-undefined asserts flip RED) + Opus (4)b judge PASS: no regression (PNG vision read, real text read, PDF-with-NUL-extract all still read; verified resolveFileKind routes a binary .txt to the text branch so the guard is LIVE); no false-positive (UTF-8 source/markdown/Korean never embeds a NUL; a UTF-16 file was already garbled, so a clear refusal beats corruption); the read↔grep binary handling now matches. Distinct (kind=correctness/reliability, pkg=@muse/fs).
- [done] :: **run_command timeout -> actionable message (computer-control fire 34, fire-23 spawn-error sibling).** When a command exceeded its timeout the Rust runner killed it and returned `{timed_out:true, ok:false, error:None}` — a bare flag the local 12B can miss, with NO message. FIX (`describe_timeout(ms)`): on the timeout path `error` now carries `"command timed out after {ms}ms and was killed — it may be hanging; retry with a larger timeoutMs or a more targeted command."` (`ms` = the EFFECTIVE clamped timeout, not the raw request). Wired into the success-path RunnerResponse (`error: if timed_out { Some(...) } else { None }`); TS passes `error` through (no TS edit). Mutation-valid BOTH ways: dropping the "timeoutMs" hint -> the helper test RED; reverting the wiring to `error:None` -> the END-TO-END test RED (a real `sleep 5` killed at 50ms through `run_request` must surface the message) + Opus (4)b judge PASS: no-weakening (only the error string on the timeout path — timed_out/ok/kill/drainers unchanged; a non-timeout command gets NO spurious timeout error), correct ms (effective clamped value), non-flaky E2E (#[cfg(unix)], 50ms vs 5s no race). cargo 12 tests. Diversity: pkg=crates/runner (off @muse/fs/agent-core), kind=reliability-nudge — completes the run_command failure-message family (spawn-error fire 23 + timeout fire 34).
- [done] :: **file_read caps to fit the model context — a 200K read no longer overflows the 12B window (computer-control fire 35).** The agent created its fs read tools with NO `maxTextChars`, defaulting to `DEFAULT_MAX_TEXT_CHARS = 200KB` (~50K tokens) — but the local model's context is `DEFAULT_OLLAMA_NUM_CTX = 32768` tokens, so ONE max file_read exceeds the WHOLE window and the runtime silently truncates the prompt/history (adapter-ollama documents this LIVE: an 8K window ate the whole prompt -> 1 output token). FIX: pure `fileReadCharBudget(contextTokens) = max(4K, floor(tokens/2)*4)` (HALF the window at ~4 chars/token) in @muse/fs; the agent passes `maxTextChars: fileReadCharBudget(DEFAULT_OLLAMA_NUM_CTX)` (= 64K). Larger files page via the fire-24 nextOffset. Mutation-valid (dropping the /2 -> the value test RED; an over-budget file truncates at exactly the budget) + Opus (4)b judge PASS: the gap is real (confirmed via the live-observed Ollama overflow, no upstream trimming layer), the derivation is principled (a read can never dominate the context), grounding preserved in the SAFE direction (more reads become partial->truncated, onFullRead never wrongly fires), file_grep/file_list unaffected, the 200K default intact for non-agent callers, conservative bound (uses DEFAULT num_ctx -> only tighter if the user raised it, never overflows). Distinct (kind=context-fit/reliability, pkg=@muse/fs+apps/cli).
- [done] :: **file_edit not-found gives a recovery action even with NO close line (computer-control fire 39).** old_string mismatch is the local 12B's most common edit failure. applyEdit (backing file_edit AND file_multi_edit) tries exact -> fuzzy line-block -> unescape-whitespace, then fails; the failure reason carried the recovery action ("read the file and copy the exact text") ONLY when nearestLineHint found a close line. The NO-HINT case (a gross miss — exactly when the model is MOST lost) got a bare `old_string not found: <snippet>` it would only blindly retry. FIX: the no-hint branch now also advises `" — re-read the file with file_read and copy the exact current text (old_string must match byte-for-byte, including whitespace)"`. Mutation-valid (reverting the suffix to "" -> the gross-miss test RED; tests assert the MESSAGE CONTENT — "file_read" + "byte-for-byte" — not just ok===false) + Opus (4)b judge PASS: pure ADVICE (never guesses/names a line; still ok:false, no mutation), the match pipeline is byte-identical at runtime (real + fuzzy matches still work, no real match newly reported not-found), the advice is SOUND (by this branch fuzzy/whitespace tolerance was already exhausted, so byte-exact IS what's needed — not over-stated), sibling file_multi_edit inherits the message (covered by one change; file_write/file_move are genuinely different paths). Distinct (kind=reliability-nudge/message, pkg=@muse/fs) — off the recent context-fit slices.
- [done] :: **char-cap reads now page cleanly — RESOLVED fire 36 (was a fire-35 (4)b finding).** When a no-`limit` read's leading lines exceed maxTextChars, the char-cap path clears `nextOffset` (a mid-line cut has no clean line boundary), so the model can't page by that field — it must re-issue with explicit `offset`/`limit` (the tool description says so, and that yields a clean nextOffset). Fire 35's lower 64K cap makes this trigger more often. Candidate: on a char-cap, return a `nextOffset` = the FIRST FULLY-CONTAINED line after the cut (round down to a line boundary) so the model still gets deterministic paging without a partial line. Low-risk, testable; validate the rounding never re-reads/skips a line. RESOLVED: the char-cap path now TRIMS the trailing partial line to a clean boundary and sets `nextOffset = start + completeLines + 1` (completeLines = newlines in the capped slice — conservative, so the boundary line is re-read in FULL, never skipped); a single line longer than the cap (no newline) keeps nextOffset undefined (can't page by line). Mutation-valid (reverting to the old clear-nextOffset -> both the trim test AND a 10-line round-trip test go RED) + Opus (4)b judge PASS: drove the paging loop — EVERY line read, NONE skipped (overlap-at-boundary only, never a gap), nextOffset always advances (no infinite loop), char-cap still sets truncated=true so onFullRead stays suppressed (grounding gate intact), numbered-mode + empty/1-line/no-trailing-newline edges all correct. Distinct (kind=reliability/paging, pkg=@muse/fs) — the right follow-up to fire 35's 64K cap that made char-cap frequent.
- [done] :: **JUDGE-DRILL #4 [done] + pin the timeout-message DIRECTION (computer-control fire 37).** 8-consecutive-PASS triggered the mandatory drill. Injected a plausible wording tweak — the run_command timeout message's "retry with a LARGER timeoutMs" -> "SMALLER timeoutMs". ALL cargo gates passed (12 green) because `timeout_message_is_actionable` asserted only `contains("timeoutMs")` — blind to the advice DIRECTION (both "smaller" and "larger" contain the token). The independent Opus (4)b judge FAILED it by REASONING about the causal direction: the message fires precisely because the command exceeded its budget (needed MORE time), so advising a SMALLER timeout kills the retry SOONER — backwards, harmful guidance the 12B would follow into a dead-end (concrete trace: 50ms timeout -> "retry smaller" -> 20ms -> fails faster; MAX_TIMEOUT_MS=600K headroom exists, the advice steers away from it). Rolled back (message unchanged from fire 34). REAL FIX (the drill's lesson — test-blindness): hardened `timeout_message_is_actionable` to pin the DIRECTION — `assert!(msg.contains("larger"))` + `assert!(!msg.contains("smaller"))`. Mutation-valid: re-injecting the drill ("smaller timeoutMs") now turns the test RED (the direction-flip can no longer pass a contains-only check). LESSON: a contains-token assertion is blind to the SEMANTICS of the token (direction/polarity) — pin the meaning, not just the presence. The verifier caught a backwards-advice regression by causal reasoning, not pattern-matching — maker≠judge working (4th drill).
- [done] :: **file_grep output caps to fit the model context — fire-35 sibling (computer-control fire 38).** fire 35 capped file_READ to half the 32K-token window; file_GREP was the un-capped sibling — a broad content grep returns up to GREP_MAX_MATCHES=200 × up to 500 chars = ~100K chars, which can dominate a small context (silently dropping the prompt/history, the same overflow file_read had). FIX: a `maxGrepOutputChars?` option (default DEFAULT_MAX_TEXT_CHARS=200K -> non-agent callers UNCHANGED); the content loop accumulates `contentChars += text.length` and stops (truncated) on EITHER the 200-match cap OR the char budget. The agent passes `fileReadCharBudget(DEFAULT_OLLAMA_NUM_CTX)` (64K). Mutation-valid (removing the char clause -> the cap test RED; default returns all 50) + Opus (4)b judge PASS: non-agent grep unchanged (probed — default returns all, GREP_MAX_MATCHES still independently caps), files-mode unaffected (no contentChars), grounding NOT weakened (onPathRead fires only for genuinely-scanned files; a truncated grep marks FEWER paths -> the read-before-edit gate only gets STRICTER, never accepts an un-reached file), binary-skip/ReDoS/sandbox byte-identical, soft-budget overshoot ≤ one match (acceptable). Distinct (kind=context-fit/reliability, pkg=@muse/fs+apps/cli).
- [open] :: **file_list 1000-path default — the THIRD fire-35 sibling (computer-control fire 38 (4)b note).** file_list's no-`limit` default returns up to MAX_LIST_RESULTS=1000 canonical paths ≈ 60-70K chars ≈ the agent context budget. Honestly acceptable to leave for now (the (4)b judge agreed): 1000 bare paths is ON THE ORDER of the budget, not a gross multiple like file_read's 200K; list output is paths-only (no per-match 500-char line content -> no 500×200 multiplier that makes grep the sharp overflow); and the model can pass a smaller `limit`. Candidate if a real trace shows overflow: a context-fit default `limit` for the agent (derive from fileReadCharBudget / a typical path length), like fires 35/38. Low-priority.
- [done] :: **isUnbackedActionClaim helper — false-done condition extracted to ONE shared, tested definition (computer-control fire 31, decompose 30a).** The backstop condition `requestsToolAction(query) && answerClaimsAction(answer) && !actionToolRan(toolNames)` was INLINED at 3 sites (commands-ask:2862, chat-repl:634/698) — a drift risk (add a leg at one site, the others diverge). Extracted to `isUnbackedActionClaim({query, answer, toolNames})` in agent-core (where the 3 detectors live), wired all 3 CLI sites to it, cleaned the now-unused imports (kept requestsToolAction in commands-ask for askIsActionRequest@2861, kept actionToolRan in chat-repl for the post-re-prompt check@640). Behavior-IDENTICAL (Opus (4)b judge: 0 mismatches on 10 cases vs the inlined form; askIsActionRequest@2863/2871 + chat-repl:640 intact; only unused imports removed; pnpm check exit 0). Mutation-valid (dropping the `!` on actionToolRan -> RED). This is the SEAM for 30b (the AgentRuntime re-prompt will compose the same one definition). Distinct (kind=refactor/seam, pkg=@muse/agent-core+apps/cli).
- [open] :: NEXT (2) **edit RATIONALE citation (softer follow-up)** — the path + the read-before-edit gate are
 now grounded; a remaining nicety is citing WHY (the file/error line) in the agent's change summary.
 Lower value than the gate (the gate is the hard guarantee); pick up only if the surface needs it.
- [done] 2026-06-16 :: ->Done (1) **run_command (EXECUTE path) first ever end-to-end verification + hardening** (2026-06-16) —
 the execute half of computer-control was UNVERIFIED: the `muse-runner` Rust binary wasn't even built
 and no eval existed. Built it (`cargo build --release` -> `target/release/muse-runner`, workspace
 target). New `scripts/eval-run-command.mjs` (+ `eval:run-command`): live gemma4 must RUN a fixture
 Node script via run_command and report the unique token it prints (terminal-state / grounded — a
 fabricated "I ran it" can't pass; skips if Ollama OR the binary is absent). FIRST run found the real
 failure: the 12B packed the whole line into `command` (`"node /abs/report.mjs"`) -> runner rejects
 ("command must be an executable name, not a path"), 0/1. FIX (both tool-calling.md levers): (1)
 schema — `command`/`args`/`cwd`/`timeoutMs` got example-bearing descriptions + a use-when/not-when
 line (rule 3/4); (2) deterministic repair in `parseRunnerCommandRequest` — when `command` carries
 whitespace and no explicit args (and no quotes), tokenize into executable + args (rule 7). TDD:
 tools 272/273 (split when no args / multi-flag / NOT when args given / NOT when quoted), build 0,
 lint 0. Live `MUSE_EVAL_REPEAT=3 eval:run-command` = **3/3** (the schema fix alone made the model
 emit `command:"node", args:[path]` correctly; repair is the backstop). Report-only per 진안.
 PRE-EXISTING wiring confirmed: `createRunnerTools` gates run_command behind `MUSE_RUNNER_ENABLED` +
 `MUSE_RUNNER_PATH` (default "muse-runner" on PATH) — so production needs that env + the built binary.
- [done] :: ->Measured (1) **edit->run->verify LOOP baseline = ~33% (gemma4 coherence CEILING, not a deterministic
 bug)** (2026-06-16) — new `scripts/eval-edit-run-verify.mjs` (+ `eval:edit-run-verify`): a failing
 test, model must FIND (grep/read) -> FIX (file_edit, read-before-edit gate wired) -> RUN (run_command)
 to confirm, graded TERMINAL-STATE (harness re-runs the test -> exit 0) + no-collateral + model-ran-
 test. pass^3 = **1/3**. Failure modes (debug-confirmed, NOT arg-quality — 0 bad-option): run 1 ran
 the test once, saw FAIL, then STOPPED without editing (premature termination); run 3 used NO tools
 at all (no-op). This is the MAST small-model failure class (step-stop / unaware-of-termination), the
 binding multi-step-coherence limit on a 4-tool autonomous loop — NOT a deterministic patch target.
 Honest reading: the three SINGLE capabilities (find/fix, edit-repair, execute) are each solid (5/5,
 3/3); the COMPOSED autonomous loop is at the model's ceiling. GOOD news surfaced: the model used
 `cwd` correctly and the run_command arg-split held (the earlier fixes carried). Eval kept report-only.
- [done] :: ->Done (1) **edit->run->verify loop 1/3 -> 3/3 via an agentic-persistence prompt (the ceiling was a
 PROMPT gap, not the model)** (2026-06-16) — investigation flipped the read: (a) the existing
 decomposition machinery (`runLeadWorkerTask`) is the WRONG shape — it fans out INDEPENDENT subtasks
 and synthesizes, but the loop is a SEQUENTIAL DEPENDENT pipeline (edit needs read's finding), so a
 worker in its own clean context can't carry it; (b) the production `--with-tools` system prompt was
 recall-tuned ("Keep it concise — 2–4 sentences") with NO multi-step guidance, so the model quit after
 the first tool call. FIX: added two GENERAL agentic-persistence lines to the withTools branch of the
 ask system prompt (`commands-ask.ts`) — "when a task needs several steps, keep taking the next action
 until done; if a command/test fails, fix it and re-run to confirm before answering". Conditional, so
 a single-tool ask is unaffected. MEASURED FIRST in the eval (isolated lever) then aligned the eval's
 system lines to the SHIPPED wording: `MUSE_EVAL_REPEAT=3 eval:edit-run-verify` = **3/3** both times
 (was 1/3). CLI tsc 0, lint 0. NOT a brittle hack — general agent guidance, the same persistence every
 harness uses. Report-only eval per 진안.
  - FRONTIER FOUND (1) **multi-file loop = 0/3 — a general shell (run_command) makes the 12B abandon the
 structured file tools** (2026-06-16, `scripts/eval-multifile-fix.mjs` + `eval:multifile-fix`, a
 RED ceiling-probe). Harder fixture: a buggy `multiply` among add/subtract/divide across src/ files,
 where `add` and `multiply` share `return a + b;` so a bare edit is AMBIGUOUS. With the SHIPPED
 persistence prompt, pass^3 = **0/3** — the model runs the test, greps to locate the file, then
 reaches for SHELL idioms via run_command to inspect/navigate (`cat src/math.mjs`, `ls -l`,
 `find . -R`) — flailing on cwd/relative paths — and NEVER reaches a successful file_edit. TWO general
 prompt nudges were tried and IGNORED (persistence; an explicit "inspect with file_read, not the
 shell" line) — so this is a tool-SELECTION bias, not a prompt-tweakable gap, and it also bypasses the
 read-before-edit gate (the model "reads" via `cat`). The simpler one-file loop stays 3/3; the gap is
 specifically the general-shell-vs-structured-file-tools competition on a small model. REAL LEVERS
 (design decisions, NOT another prompt line): (a) tool DISCIPLINE — don't expose a general shell
 alongside the file tools for an edit task, or split by phase; (b) sandbox run_command's cwd to the
 workspace + deny file-content shell utils (cat/ls/find) so file_read/file_grep are the only inspect
 path; (c) DECOMPOSE — a "locate+fix" sub-step (file tools only) then a "run the test" sub-step. Pick
 one with 진안 — each is a real slice, and the probe is the gate that proves it.
  - lever (a) phase-scoped tools SHIPPED + lever-adjacent grep-read fix -> **0/3 -> 2/3** (2026-06-17,
  진안-picked lever (a)). `GeneralShellPhaseGate` (packages/agent-core/src/general-shell-phase.ts,
  wired into BOTH model-loop activeTools filters): when the tool set has BOTH a general shell
  (run_command) AND a structured file-write tool (file_edit/…), the shell is available initially
  (run the failing test), WITHHELD during the locate+fix phase (after a shell use, until a write
  LANDS), and RE-ARMED after a landed write (confirm). Engages only when both classes are present
  -> run_command-alone (execute eval) + one-file loop (3/3) do NOT regress. Unit 10/10 + loop wiring
  2/2 + agent-core 2446 green. The live trace PROVED the shell-cannibalization (cat/ls/find) is GONE
  — the model now stays on file_grep/file_read/file_edit and writes CORRECT scoped fixes. But the
  probe then exposed a second blocker: the model inspects via content-mode `file_grep` (not
  file_read), so the read-before-edit gate refused every (correct) edit. Fixed in @muse/fs: a
  content-mode grep marks the files it returned content from as READ (consistent with file_read,
  which already marks a path read after an offset/limit PARTIAL view) — files-mode (no content
  shown) does NOT. Wired in production via createFsReadTools (not probe-only); fs 102 green (+2).
  - edit-integrity gate + file_grep regex robustness SHIPPED (2026-06-17). Two MORE deterministic
  dead-end classes eliminated: (1) `checkEditIntegrity` (packages/fs/src/edit-integrity.ts, opt-in
  via FsWriteToolsOptions.checkEditIntegrity, ON in commands-ask + eval) fail-closes file_edit on a
  DESTRUCTIVE edit — deleting a top-level definition (the `multiply -> ""` botch) or unbalancing
  ()[]{} (string/comment-stripped, regression-only) — turning a silent corruption into a guided
  retry; (2) `compileGrepPattern` (fs-read-tools.ts) makes file_grep NEVER throw — a small model's
  invalid regex (a lone `}` fatal under /u, double-escaped `\\`) was crashing every grep and the
  model looped on it without ever editing; now it degrades strict-u -> no-flag -> LITERAL substring.
  fs 122 green (+22). Both PROVEN by traces: no more emptied-function corruption, no more
  "invalid regular expression" dead-end.
  - 주의: RESIDUAL = a 12B MULTI-STEP-COHERENCE CEILING, not a deterministic bug (pass^5 = **3/5**, was
  0/3). With every FIXABLE dead-end removed, the remaining failures are model-reliability on the
  DELIBERATELY-ambiguous fixture (add & multiply share `return a + b;`): mode B — file_edit with an
  ambiguous old_string that matches both -> no-op (run 3); mode C — the model greps, ALREADY HAS the
  buggy line in hand, but never constructs the file_edit and gives up after ~5 grep steps (run 5,
  debug3). gemma4 degrades after 2-3 dependent steps (tool-calling.md). NOT closeable by another
  write-path gate without OVERFITTING the fixture. The genuine next lever is (c) DECOMPOSE — a
  constrained "now produce the file_edit" sub-step with only the edit tool + the file in context
  (tool-calling.md #1/#5: fewer competing options per turn) — a BIG slice that may still not be
  deterministic. Candidate marginal lever for mode B only: actionable ambiguous-match refusal
  (occurrence line numbers + "add the enclosing `function` line"). Probe stays RED report-only.
- [open] :: secondary: `run_command` args-packing repair (split a single `args` element like `-e "x"` that
 carries a flag+value) — observed once, model recovered, low priority until it actually fails a run.

## Open — TOOL expansion & hardening (loop theme, 진안-directed 2026-06-12)

The loop's standing focus: EXPAND Muse's own tool surface + HARDEN the existing tools.
- [done] :: ->Done **muse.episode list/search `total` lied (post-slice count)** (EXPANSION gap-scout runner-up; shipped fire 22) —
 list/search computed `[...].sort().slice(0, limit)` then returned `total: <sliced>.length`, so `total` was the
 POST-limit count (50 episodes, limit 10 -> total:10) not the real store/match size — misleading the model about how
 many episodes exist. The sibling reminders.list does it right (total=pre-slice, shown=post-slice). FIX: sort first,
 `shownList = sorted.slice(0,limit)`, return `shown` + `total = scoped.length` (list) / `matches.length` (search,
 matches now pre-slice). Mirrors reminders. TDD 2 (3 eps, limit 2 -> total 3, shown 2) RED->GREEN; an existing test that
 incidentally asserted the buggy `limited.total===1` updated to total:3 + shown:1 (Fable-5 judged the change
 legitimate — incidental characterization, reminders convention is the repo standard). mcp 1718, check 0, lint 0.
 RESIDUAL (non-blocking, one-field follow-up): the llm-judge search branch returns `total: matches.length` (the judge
 caps in code, so there's no pre-slice total) but lacks `shown` for cross-mode consistency.
- [done] :: ->Closed (not a bug) **@muse/model web-search-policy.test "property fuzz"** — investigated in fire 23: the "fuzz" is
 a DETERMINISTIC exhaustive nested loop over a FIXED corpus (enabledOpts × overrideOpts × maxUsesOpts × envWebSearch ×
 envMaxUses), NOT a randomized fast-check property — it runs the exact same ~10k combinations every time, so it is
 input-stable (ran 6× isolated, all 322/322 pass). The single fire-22 failure was ENVIRONMENTAL (slow ~10k iterations
 timing out under the heavy concurrent full-`pnpm check` load, same class as the chat-grounding/playbook-store env
 flakes), not a latent decideWebSearchPolicy edge. No seed to pin, no counterexample exists. Closed.
- [done] :: ->Done **muse.search DuckDuckGo redirect was DOUBLE-DECODED** (EXPANSION gap-scout, fire 23; data-integrity +
 fail-open-to-crash) — `decodeDuckDuckGoRedirect` (loopback-search.ts:369) did `decodeURIComponent(params.get("uddg"))`,
 but `URLSearchParams.get` ALREADY percent-decodes once. So a literal `%20` in a result URL (DDG sends `%2520`) got
 corrupted to a space, and a bare `%` in a target (`https://sale.com/100%-off`) made the second decode THROW
 `URIError: URI malformed`. `parseDuckDuckGoHtml` runs in muse.search's execute() AFTER the fetch try/catch closes
 (loopback-search.ts:191), so the URIError escaped -> the whole search call crashed on an attacker-influenceable result
 URL. FIX: drop the redundant decode (`return target ? target : raw;`). TDD 2 (literal-`%20`-survives-intact +
 never-throws-on-bare-`%`) RED->GREEN; the existing redirect tests used single-pass-decoded uddg values so the second
 decode was idempotent there (which masked the bug). mcp 1720, check 0, lint 0. Fable-5 PASS (RED re-confirmed by
 stashing src only; no legit double-encoded path exists — DDG encodes the target once with encodeURIComponent).
- [done] :: ->Done **muse.regex had NO catastrophic-backtracking (ReDoS) guard** (EXPANSION gap-scout; judge-drill target) —
 test/match/replace compiled a user pattern and ran it SYNCHRONOUSLY on up to 50k chars with only a length cap, so a
 nested-unbounded-quantifier pattern ((a+)+, (.*)*, …) HUNG the whole agent process (a sync regex run can't be timed
 out on the main thread; the scout had to SIGKILL it). regex_extract already guards this; the loopback surface never
 got it (same-class-different-surface miss). FIX: export the proven `hasNestedUnboundedQuantifier` from @muse/tools +
 reject in compile() before new RegExp (one guard covers all three tools). TDD 6 catastrophic shapes ×3 tools rejected
 + benign not-rejected, RED->GREEN; mcp 1716, check 0, lint 0. Fable-5 PASS. Also the v1.11.2 JUDGE FAILURE DRILL: a
 narrow `includes("+)+")` guard + non-discriminating test was planted FIRST; the verifier correctly FAILED it (caught
 (.*)*/([a-z]+)*/([a-z]+){2,} slipping through + the non-discriminating test) -> rolled back -> real fix applied. Judge
 drill 2/2 (fire 10 json.query + fire 21 regex).
- [decision] :: **'this weekend' on a Saturday resolves to TODAY (possibly past) — NOT a clean bug (semantic, needs 진안)** —
 loopback-relative-time.ts:477 `delta = (6-getDay()+7)%7` gives 0 on Sat (today) but 6 on Sun (next Sat, skipping
 today). Whether "this weekend" on Sat/Sun means today or next weekend is genuinely ambiguous (like text.stats), and
 the existing weekend test uses a Wednesday reference so the edge is untested-not-documented. Deferred to 진안.
- [done] :: ->Done **add_contact silently DUPLICATED on re-add** (EXPANSION gap-scout, live) — the tool's description
 promises "Add (or update)", but execute always did `id: idFactory()` + save, so a re-add of an existing NAME got
 a fresh id and APPENDED (the store's addContact is id-idempotent only). The duplicate then made the name resolve
 AMBIGUOUS forever (find_contact returns candidates, never a person) — breaking outbound-safety rule 3 (recipient
 must resolve unambiguously) AND remove_contact was equally ambiguous (can't clean up by name). FIX: an optional
 `contacts?` reader on ContactsAddToolDeps; on an exact case-insensitive name match, reuse the existing id + merge
 (new field wins, unmentioned preserved) so an id-idempotent save REPLACES. Wired through BOTH production seams —
 autoconfigure (already addContact-idempotent) + commands-ask vision-auto (CHANGED from a raw read+append
 `writeContacts` to the store's addContact + reader, so it's now id-idempotent + queued). TDD 3 (re-add reuses id +
 merges; case-insensitive; no-reader back-compat) RED->GREEN; mcp 1703, check 0, lint 0. Fable-5 PASS (back-compat
 intact, both seams live). RESIDUAL (non-blocking, separate): exact-name-only match (an ALIAS re-add could still
 duplicate); commands-ask read->save isn't atomic across the merge window (only the save is queued).
- [done] :: ->Done **loopback-crypto base64/hex decode of non-UTF-8 bytes emitted U+FFFD silently** (gap-scout runner-up;
 shipped fire 20) — a valid-FORMAT base64/hex whose decoded BYTES aren't valid UTF-8 (binary, e.g. 0xFF) had
 `toString("utf8")` silently replace them with U+FFFD — garbled text, no error, against the tool's "decode back to
 UTF-8" contract. FIX: a `decodeBytesAsUtf8` helper re-encodes the decoded string and compares to the original
 bytes (valid UTF-8 round-trips exactly; a lossy one doesn't) -> `{error: non-UTF-8 (binary) bytes}`. Both base64
 and hex use it; the format-validation error paths are unchanged (distinct). TDD (base64 "/w=="=0xFF + hex "ff"
 -> error; emoji/héllo/empty still round-trip) RED->GREEN; mcp 1709, check 0, lint 0. Fable-5 PASS (no valid-UTF-8
 false-reject — emoji/NUL/BOM/literal-U+FFFD all empirically accepted).
- [done] :: ->Done **web_download silently clobbered an existing file** (EXPANSION gap-scout, live) — wrote bytes with a
 plain `writeFile(path, bytes)` (flag "w"), so downloading a name that already exists in the user's Downloads
 dir SILENTLY OVERWROTE the unrelated existing file (irreversible data loss, not even flagged) — AppWorld
 "collateral damage" class, against the module's own fail-closed-disk promise. FIX: a new `writeNonClobbering`
 helper dedupes like a browser (`name (1).ext`, `(2)`, …) using the `wx` flag (atomic exists-check+create, no
 TOCTOU); a real write error (EACCES/ENOSPC) is re-thrown -> surfaces, never looped; bounded at 1000. TDD
 (pre-existing report.pdf intact + new bytes at "report (1).pdf") RED->GREEN; mcp 1698, check 0, lint 0.
 Fable-5 PASS (5 concurrent -> 5 unique files; fresh-dir original name unchanged; no-ext/dotfile/multi-dot edges).
- [done] :: ->Done **web_download buffered the ENTIRE response body before the size-cap check** (gap-scout runner-up;
 shipped fire 17) — `Buffer.from(await response.arrayBuffer())` then `> maxBytes`, so a multi-GB / never-ending
 body filled RAM despite the 50MB cap (memory-exhaustion DoS). FIX: a Content-Length pre-check (reject before
 reading if declared > cap) + a streamed `getReader()` read that aborts (`reader.cancel()`) the moment the
 accumulated size crosses the cap — the server can lie about/omit CL, so the streamed abort is the real defense;
 a no-body fallback still caps via arrayBuffer. TDD (instrumented 20×100B stream, cap 250B -> aborts after ~3
 chunks, nothing written) RED->GREEN; mcp 1700, check 0, lint 0. Fable-5 PASS (under-cap byte-identical, no false
 reject on absent/garbage CL).
- [done] :: ->Done **FLAKY cli chat-grounding.test "fails soft when retrieval throws" — made hermetic (fire 18)** — failed `pnpm check` transiently
 in fires 16 AND 17 (~5s, Ollama-timing dependent), passes on isolated re-run. Not a loop-slice regression but a
 real flaky gate. NEEDS: make the test hermetic (it should fail-soft without a live/slow Ollama path) — small fix
 but on the chat-grounding surface, separate from the TOOL theme; flag to 진안 / a chat-grounding fire. RESOLVED: added an optional injectable `searchRecall` DI seam to
 groundChatTurn/retrieveChatGrounding (production default = real recall); the test now injects a sync-throwing
 recall + MUSE_CHAT_AUTO_REINDEX=0 -> NO network, runs in ms (was ~5s), and asserts `called===true` (strictly
 stronger). Fable-5 PASS (production unchanged, fail-soft still exercised). cli 2530, check 0 first-try, lint 0.
- [done] :: ->Done **muse.tasks.update lost-update TOCTOU** (gap-scout runner-up; shipped fire 16) — built a WHOLE stale
 snapshot (`{...tasks[index]}`) outside the write queue and wrote it back inside mutateTasks, so two concurrent
 updates to DIFFERENT fields lost-update (last-writer-wins on the whole object). FIX: build a field-level DELTA
 (sets/clears) and re-apply it onto the FRESH `current[i]` inside the mutate callback (mirror `complete`); single-
 update semantics 1:1 unchanged. TDD (two concurrent updates to title + notes both persist in tasks.json) RED->GREEN;
 mcp 1699, check 0, lint 0. Fable-5 PASS (reproduced RED in a /tmp worktree). RESIDUAL (acceptable, pre-existing):
 a partial dueAt reschedule still anchors to the stale existing-due, so a due-move RACE on the SAME field is
 last-writer-wins (the cross-field lost-update is fixed); same class as `complete`'s resolve-outside-queue.
- [done] :: ->Done **muse.url.parse query map prototype pollution** (EXPANSION gap-scout, live) — the query map was a
 prototype-bearing `{}`, so an attacker-controlled URL `?__proto__=a` hit the Object.prototype SETTER (param
 vanished + the object's prototype polluted before serialization) and `?constructor=c` collided with the
 inherited Object constructor (corrupted to an array via the dedup). Same class as the fire-4 json.merge
 __proto__ fix, unfixed on the URL surface. FIX (1 line): `const query = Object.create(null)` — null-prototype
 map, so __proto__/constructor land as plain own DATA keys and the `existing === undefined` dedup works for
 every key. TDD 1 (__proto__=a -> own "a", constructor=c -> "c", x="1") RED->GREEN; mcp 1696, check 0, lint 0.
 Fable-5 PASS (dedup string/array shapes preserved, JSON serializes null-proto own keys, no downstream consumer).
- [decision] :: **muse.text.stats whitespace->zero — NOT a clean bug (documented behavior, needs 진안)** — `stats("  ")` returns
 `{characters:0, lines:0, words:0}` but an existing test (mcp.test.ts "treats whitespace as zero") DOCUMENTS this as
 intended. Unlike encode_query's incidental "[object Object]", the whitespace->zero is a named design choice — changing
 it alters documented behavior. Deferred to 진안: is whitespace-only meant to count as zero, or report factual chars/lines?
- [done] :: ->Done **muse.url.encode_query encoded a nested object as "[object Object]"** (gap-scout runner-up; shipped fire 14) —
 `String(raw)` coerced a nested object/array value to the literal "[object Object]" — a silently-corrupt query param.
 FIX: an isScalar guard returns `{error: must be string/number/boolean}` for a non-scalar value or array item (scalars,
 scalar arrays, null/undefined skipping unchanged). TDD (nested-object value + object-in-array -> error; scalar control
 encodes) RED->GREEN; updated an existing unit that incidentally characterized the "[object Object]" output (Fable-5
 judged the change legitimate — the test's intent was scalars). mcp 1697, check 0, lint 0.
- [done] :: ->Done **muse.calendar.add mis-anchored a time-only endsAt** (EXPANSION gap-scout, live EN+KO) — `add`
 resolved `endsAt` with `parseIsoDate(endsAtRaw)` whose default anchor is now(today), so a bare time-of-day
 end ("4pm"/"오후 4시") for a NOT-today event resolved against TODAY while startsAt resolved to tomorrow ->
 the LocalCalendarProvider INVALID_TIME_RANGE guard rejected it ("endsAt must be at or after startsAt").
 The sibling `update` already anchors a time-only end to the event day (`anchorFor`); `add` never did. FIX
 (1 expr): anchor a time-only endsAt to the resolved START's day — `isTimeOnlyPhrase(endsAtRaw) ?
 parseIsoDate(endsAtRaw, () => startOfLocalDay(startsAt)) : parseIsoDate(endsAtRaw)`. Date-bearing/ISO/absent
 endsAt unchanged. TDD 2 (EN "tomorrow 3pm"+"4pm", KO "다음 주 월요일 오후 3시"+"오후 4시" -> end on start's
 day 16:00, no error) RED->GREEN via a registry mirroring the provider guard; mcp 1694, check 0, lint 0.
 Fable-5 PASS (no regression on other endsAt shapes; guard untouched).
- [done] :: ->Done **muse.calendar.update cross-day move anchored a time-only endsAt to the OLD day** (gap-scout runner-up; shipped fire 12) —
 update's `anchorFor` uses `resolved.event.startsAt` (the original day), so "move it to Monday, ending 5pm"
 lands the end on the original day, not Monday. FIX: anchor the time-only endsAt to `newStartsAt` when the
 start moved. 1 expr + 1 test. (Sibling of the add fix above.)
- [open] :: **relative-time "this weekend" asked ON a Saturday resolves to today 09:00 (possibly past)** (runner-up) —
 loopback-relative-time.ts:~477 delta `% 7` = 0 with no roll-forward (unlike the bare-weekday handler that
 forces delta=7). FIX: roll forward to next Saturday when today is already Sat. 1 line + 1 test.
- [done] :: ->Done **muse.math.evaluate silently truncated a malformed multi-dot number** (EXPANSION gap-scout) —
 `parseNumber` scans a literal by greedily consuming digits AND dots, then did `Number.parseFloat(literal)`:
 `parseFloat("1.2.3")` returns 1.2 (stops at the 2nd dot, NOT NaN), so the NaN guard never fired and
 `evaluate("1.2.3 * 100")` silently returned 120. The math tool's WHOLE contract is an exact digit the
 local 8B can't compute, and this is the shared core behind the muse.math MCP tool AND the muse ask /
 chat-repl arithmetic fast-paths — a wrong digit flows into a user answer with NO model in the loop.
 FIX: one line, `Number.parseFloat(literal)` -> strict `Number(literal)` (Number("1.2.3")=NaN -> existing
 `invalid number literal` throw; "5."/".5"/integers/decimals still parse — node-verified no valid number
 regresses; "1..2" also now rejected). TDD 1 (multi-dot -> error + 5./.5 controls) RED->GREEN; mcp 1687,
 check 0, lint 0. Fable-5 verifier PASS (no valid-input regression, reaches ask/chat fast-path). Matches
 code-style.md "strict Number() not parseFloat".
- [done] :: ->Done **muse.json.query walked the prototype chain** (EXPANSION gap-scout runner-up; shipped fire 10) — path resolution uses
 `segment.key in cursor` so a path like `constructor`/`__proto__` on a plain object returns `found:true`
 with an inherited (often function) value that JSON-serialization silently drops to `{found:true}` (no
 value), and `__proto__` leaks Object.prototype. FIX: `Object.hasOwn(cursor, segment.key)` (own-property
 only). Sibling of the fire-4 __proto__ merge fix. 1 line + 1 test.
- [done] :: ->Done **atomicWriteFile leaked its tmp on failure** (EXPANSION gap-scout runner-up) — `atomicWriteFile`
 (the shared sidecar-store write primitive) opened `<file>.tmp-<pid>-<uuid>`, wrote+fsync+closed it, then
 `fs.rename(tmp, file)`. On ANY failure after the tmp was opened (writeFile/sync error OR the rename
 failing), the tmp was orphaned -> `*.tmp-*` litter accumulating in every sidecar dir (memory/tasks/
 reminders/action-log/…). FIX: wrap open->write->rename->chmod in try/catch; on failure
 `fs.rm(tmp,{force:true}).catch(()=>undefined)` then rethrow the ORIGINAL error (rm errors swallowed, never
 substituted; force no-ops if open never created the tmp). TDD 1 behavioral (target=directory -> rename
 throws -> assert rejection AND zero `.tmp-` entries) RED->GREEN; mcp 1681, check 0, lint 0. Fable-5 verifier
 PASS (swapped HEAD source to reproduce RED; no cross-writer race — rm targets only this call's UUID tmp).
- [done] :: ->Done **muse.fs.stat lied about symlinks** (EXPANSION gap-scout runner-up) — the tool's description
 promises "Symlinks are reported as kind=symlink without following", but it called `fsLib.stat` (which
 FOLLOWS the link), so `entryKind`'s `isSymbolicLink()` was always false -> a symlink was ALWAYS reported
 as its target's kind, never `symlink`. The contract was unsatisfiable. FIX: added an optional `lstat?`
 to the injectable fs seam + wired real `node:fs/promises` lstat into the default; the stat tool now
 calls `(fsLib.lstat ?? fsLib.stat)(decision.resolved)` (lexical path -> lstat sees the link). The
 realpath-escape guard still runs first (unchanged), so no path guard was weakened. TDD 1 behavioral
 (lstat->isSymbolicLink -> kind=symlink, vs stat-follow -> file) RED->GREEN; mcp 1680, check 0, lint 0.
 Fable-5 verifier PASS (sandbox-compiled HEAD reproduced RED). RESIDUAL: read/list still FOLLOW symlinks
 on the lexical path (by design — realpath guard prevents escape; a symlink-swap TOCTOU window remains,
 separate slice). Runner-up still OPEN: `atomicWriteFile` leaks `*.tmp-*` on a write/rename failure (no
 unlink on the error path — accumulates litter in sidecar store dirs).
- [done] :: ->Done **muse.json.merge prototype-pollution** (EXPANSION gap-scout, Fable-5) — `deepMerge` did
 `result[key] = …` for every key of model-supplied `overrides`; model args arrive via JSON.parse, which
 makes `"__proto__"` an OWN data key, so `result["__proto__"] = …` hit the Object.prototype SETTER and
 HIJACKED the merged object's prototype (silently injected inherited fields like `isAdmin`, dropped the
 key). FIX: special-case `key === "__proto__"` — read any existing own value via
 `Object.getOwnPropertyDescriptor`, deep-merge, write back via `Object.defineProperty` as an own
 enumerable data prop (never the setter); other keys unchanged. Verifier confirmed `__proto__` is the
 ONLY setter vector here (constructor/prototype create plain own props, no pollution) and the guard
 recurses to every depth. TDD 1 behavioral (JSON.parse'd `__proto__` overrides -> prototype intact +
 no injected field + key preserved as data) RED->GREEN; mcp 1679, check 0, lint 0. Fable-5 verifier PASS.
  - **ask error-path run-log trace (#6/#7) — DECOMPOSED (v1.11.2 decompose-on-defer)**: writeRunLog(success:true)
 was inline at the END of the ~2000-line `muse ask` action (commands-ask.ts:3734) with NO enclosing
 try/catch, so a thrown run left no trace (error-analysis fuel lost) + Ctrl-C logged success:true. Same
 pattern in chat-repl. Split into loop-sized slices with exact seams:
- [done] :: ->Done **6a — pure `buildAskRunLog` builder (the shared seam)**: extracted the inline cli.local payload
  into `buildAskRunLog(params)` in program-helpers.ts (next to writeRunLog), supporting BOTH success and a
  FAILURE shape (`success:false` + `error`). Wired the live success path (commands-ask.ts:3734) to it
  (not inert). TDD 3 (success payload + readResponseSuccess lifts true; FAILURE payload lifts false + carries
  error; confidence/error omitted when absent) RED->GREEN. cli 2528, check 0, lint 0.
  - · **6b — wrap the ask run in a failure-logging seam (THE fix, dedicated fire)**: extract the 1842 action
  body into a nested `async function runAskAction(queryParts, options)` (closure vars stay in scope) and
  register `.action(async (q,o)=>{ try { await runAskAction(q,o) } catch(e){ await writeRunLog(.., buildAskRunLog({..success:false, errorMessage:String(e)})); throw e } })`. RED: a thrown ask run writes a
  success:false entry. SIZING: the body-extraction is a big MECHANICAL (~2000-line) move — behavior-identical,
  verify with the full ask suite BEFORE adding the catch; warrants its own focused fire (or human-paired), not
  bundled. 6a already provides the payload so the catch is one-liner.
  - · **6c — #7 Ctrl-C/abort does NOT log success:true**: once 6b's catch exists, an AbortError/SIGINT reaching
  it logs success:false (or skips), never success:true. RED: simulate abort -> assert no success:true entry. Small.
- [done] :: ->Done **6d — chat-repl failure trace**: `createTuiChatSubmitter` wrote a run-log only on the happy
  path; a thrown runner left no trace. Added an injectable `runChat` param (default = real local/remote
  dispatch) + a try/catch that writes a `success:false` entry (response {error, success:false}) best-effort
  then re-throws the original error. TDD 2 (throwing runner -> success:false trace + re-throw; success path
  unchanged) RED->GREEN. cli 2530, check 0, lint 0. Fable-5 PASS (success path byte-identical, no double-log).
  Note: done independently of 6b (chat handler is a small fn, no 2000-line extraction needed).
- [decision] :: **calendar credential encryption-at-rest — DEFERRED (architectural cost)**: `FileCalendarCredentialStore`
 stores caldav passwords / google tokens plaintext (0600). The proven envelope lives in `@muse/memory`,
 but `@muse/mcp`->`@muse/calendar` already, and `@muse/memory` pulls `@muse/db`+`@muse/model` — encrypting
 the lean calendar package would bloat its dep graph (and the desktop binary). Needs a shared low-level
 crypto seam or a key-provider injection decision (Jinan-level), not an autonomous fire.
- [done] :: ->Done **notes-family tool-selection coverage + sharpened save/append not-when** (per-tool not-when
 audit follow-up): `muse.notes` save/append had ZERO not-when clauses and were ABSENT from eval:tools.
 RED baseline (live gemma4, 3 runs) caught a real save-vs-append confusion (KO "write to a note" ->
 notes.append 0/3 instead of notes.save). FIX: sharpened save (=CREATE/REPLACE a note FILE) + append
 (=ADD to an EXISTING note) descriptions with use-when/NOT-when (both NOT a to-do/reminder) +
 `buildNotesScenario` (6 cases: 3 positive notes-file + 3 disambiguation task/reminder must NOT route
 to a note tool). GREEN 12/12 STABLE 3/3; Fable-5 verifier PASS (discriminating + registered + not
 over-fit). mcp 1678·check 0·lint 0. REMAINING per-tool not-when targets: messaging/episodes/context.
- [done] :: ->Done **SSRF-guard test fallout swept (web_action consumers)** — the earlier always-async
 assertPublicHttpUrl hardening correctly broke 4 tests that used non-resolvable reserved-TLD hosts
 (`*.test`) as fake public URLs -> guard refused them, no fetch fired. Threaded an OPTIONAL
 `lookup?: HostLookup` DI seam through `buildActuatorTools` + `approvePendingApproval` (runActuatorByName
 already had it); the 4 tests (cli×2, api×2) now inject a fake PUBLIC resolver. Production omits lookup ->
 real node:dns/promises -> guard intact (Fable-5 verifier confirmed: seam is caller-controlled, not
 model-facing; no SSRF hole). check 0·lint 0.
- [done] :: ->Done **scout raw-NUL byte-hygiene regression** — `run-log-analysis.ts:85` had a literal raw NUL
 delimiter (`${kind}\x00${topic}`) from an earlier fire, FAILING the @muse/shared byte-hygiene gate on
 main (caught by `pnpm check`, missed by quick self-eval). Replaced with the u+0000 escape (byte-identical
 runtime value; key is Map-only, never split). shared byte-hygiene 30/30.
- [done] :: ->Done **web_download post-redirect SSRF re-check** (EXPANSION-scouted): the SSRF guard ran only
 on the INITIAL url, so a public URL redirecting to a private/link-local host (169.254.169.254
 metadata, 127.0.0.1) was followed and WRITTEN TO DISK. Now re-applies assertPublicHttpUrl to the
 final `response.url` AFTER fetch, BEFORE any write (mirrors loopback-web-read + fetch-readable-url —
 web_download was the only fetch path missing it). Behavioral test (redirect->private = refused +
 nothing written) RED->GREEN; Opus security-grade verifier PASS. mcp 1668·lint 0.
- [done] :: ->Done **SSRF DNS-rebinding closed** — the web fetch tools (web_download, web_action) had a
 `deps.lookup ? async : sync` bypass: with no lookup wired (production), the SYNC guard ran, catching
 only LITERAL private IPs, not a public hostname that *resolves* to a private IP (rebinding). Fix:
 drop the bypass, always call `assertPublicHttpUrl` (its defaultLookup = node:dns/promises resolves +
 checks) — so the no-lookup production path now catches rebinding. Hermetic tests: injected
 privateLookup->refused + a dns-stubbed no-lookup test that the verifier confirmed discriminates the
 fix (reverting the bypass makes it fail). web_action fixed too. (loopback-web-read was already
 correct.) mcp 1670·lint 0. Note: this fire FAILED first (test proved NXDOMAIN not rebinding) ->
 test fixed -> re-verified PASS.
Every slice ships its eval/test and never weakens the grounding floor. Ranked:

- [done] :: ->Done **mac wifi_status read** (capability-scout): "am I on WiFi? / what network?" was unanswerable
 — `mac_system_set` could TOGGLE wifi but there was no READ (write/read asymmetry). Added a
 `wifi_status` shell-read source to the wired `mac_app_read` (networksetup -listallhardwareports ->
 device, -getairportnetwork -> {connected, network}), reusing parseWifiDevice. read-only (no
 -setairportpower). Behavioral parse tests (connected+disconnected) + eval read-vs-write disambig
 (EN+KO). macos 85·lint 0, Opus-verified. SCOUT NOTE: surface now broadly capable; remaining
 capability gaps are niche/live-only (running_apps, ip_address) -> recommend a theme switch next.

- [done] :: ->Done **mac_screenshot arbitrary-write closed** (EXPANSION-scout): the `path` arg went straight to
 `screencapture -x <path>` with no validation — a model/injection could overwrite ANY writable file
 (e.g. ~/.ssh/authorized_keys) with PNG bytes. Fix: allowlist (~/Desktop, ~/Downloads, tmp), `~`
 expand, basename, parent-dir realpath check, AND full-target realpath (a symlink AT an allowed path
 pointing outside is refused — mirrors the loopback-filesystem fix). fail-closed, runner never called
 on refusal. 6 behavioral tests (abs-path/traversal/outside-parent/symlink-at-target -> refused,
 allowed/default -> ok). FAIL->fix->re-PASS: the first gate caught a SILENT symlink-at-target residual
 (the prior fire had just closed that exact class) -> closed it + tested -> re-verified. macos 83·lint 0.

- [done] :: ->Done **loopback-filesystem symlink-escape closed** (EXPANSION-scout runner-up): the MCP
 filesystem server's allowlist checked paths LEXICALLY only — a symlink inside an allowed root
 pointing outside (/allowed/x -> /etc/passwd) passed and was read/listed/statted. Fix: a 2nd gate in
 checkAllowed realpath-resolves the path AND the roots (symmetric, handles macOS /var->/private/var)
 and refuses if the real path escapes (fail-closed on throw/ENOENT); applied to read/list/stat. 8
 behavioral tests (escape->error, normal->content, dangling->refused). Verifier confirmed production
 always wires the default realpath (the optional dep is test-only, no skip-hole). mcp 1678·lint 0.
 (file_read already had a realpath guard; this was the MCP-server variant's gap.)

- [done] :: ->Dropped (NOISE, fire 6) **browser-read ungrounded ×7** — the scout's first hit turned out to
 be dev-test NOISE: 7 traces from the 2026-06-11 browser-testing session, all EMPTY answers
 (ans_len 0, tools []) — a no-op the gate correctly marked ungrounded, NOT a real grounding miss.
 Fix went to the SCOUT instead (fire 6): exclude empty-answer non-answers, so the board is now
 clean. Lesson: an ungrounded EMPTY answer ≠ actionable work.

EXPAND (new reach):
- [done] :: ->Done **browser_look — describe the current browser page visually (local vision)** — browser_read
 returns DOM text + elements, so a VISUAL page (chart, graph, map, diagram, image, a rendered error
 dialog) was invisible to the model. New browser_look captures the page (controller.screenshotBase64,
 added to the BrowserController interface) and describes it with the local vision model (injected
 describeImage; the CLI binds it via the same screenVision holder as mac_screen_read — omitted when no
 model). Completes "vision everywhere": screen (mac_screen_read) · local image (file_read) · image URL
 (web_read) · browser page (browser_look). Sharpened browser_read with a not-when line (visual content
 -> browser_look) so the model doesn't default to text-read. TDD 4 (well-formed, capture+describe+mime,
 question passthrough, vision-error); eval:tools browser scenario 9/9 STABLE 3/3 (browser_look vs
 browser_read on chart/graph prompts); eval:browser-agent 1/1 (act-path untouched); LIVE — a real
 Chrome page captured and described via gemma4, no error. browser 41, full eval:tools 138/139 (1
 known synthetic flake), check 0, lint 0.
- [done] :: ->Done **web_read describes IMAGE URLs via local vision** — web_read read HTML and PDF URLs but
 rejected image content-types ("not a readable text page"), even though file_read reads LOCAL images
 via vision. Now an image/* response is read as bytes (10MB cap) and described by an injected
 describeImage callback (autoconfigure binds it from the assembly's gemma4 in buildLoopbackTools —
 @muse/mcp stays model-free); absent model ⇒ refused as before. HTML/PDF paths unchanged. Completes
 the symmetry: file_read (local text/pdf/docx/image) ↔ web_read (URL html/pdf/image). TDD 3 (image
 via injected vision + mime, refuse-without-vision, HTML still text); an existing non-readable test
 moved to application/zip so it still exercises that path; LIVE — a real image URL routed through
 web_read's vision path returned a description (no error). mcp 1648 + autoconfigure 505, check 0,
 lint 0, precheck:grounding pass^2.
- [done] :: ->Done **file_read reads IMAGE files via local vision** — file_read classified .png/.jpg/etc. as
 "unsupported" even though Muse has local vision (describeImage, already used by mac_screen_read). Now
 an image FileKind (extension + magic-byte sniff: PNG/JPEG/GIF/WEBP) routes the bytes to an injected
 describeImage callback (the CLI binds it to the assembly's gemma4 via the same lazy holder as
 mac_screen_read; @muse/mcp stays model-free); absent callback ⇒ refused as before. imageMimeType
 derives the MIME from extension then magic. Magic-detected images win over a misleading extension.
 TDD 5 (classify/sniff/route-via-vision/refuse-without-vision/vision-error); eval:file-read image
 round-trip (routed + mime + refuse-without-vision); LIVE — a real Chrome-rendered receipt PNG read
 by gemma4 returned "CAFE MUSE / Latte x2 9,000 / Total 9,000 KRW". file_read is now read-any-file
 (text/pdf/docx/image). mcp 1645, full eval:tools 137/137, check 0, lint 0.
- [done] :: ->Done **web_read reads PDF URLs (not just HTML)** — `isReadableContentType` rejected
 application/pdf, so "summarize this report.pdf link" failed with "not a readable text page". Now a
 PDF content-type response is read as bytes (10MB cap) and extracted via the same pdfjs already used
 by file_read (injectable `extractPdfText`, default lazy pdfjs); HTML still routes through the text
 extractor. One-step "summarize this PDF link" instead of download-then-read. TDD 2 (PDF via injected
 extractor, HTML still uses text path); LIVE — a real Chrome-generated PDF fetched through web_read's
 pdfjs path returns the body text. mcp 1640, check 0, lint 0.
- [done] :: ->Done **web search wired into the default agent (muse.search)** — `muse.search` (web search, zero-config
 DuckDuckGo fallback, SearXNG when MUSE_SEARXNG_URL is set) existed + was tested but was ONLY reachable
 behind the opt-in MUSE_LOOPBACK_MCP_ENABLED flag, so by default the agent could not answer fresh-web
 questions. Added it to the always-on buildLoopbackTools bundle (MUSE_SEARCH_ENABLED opt-out), gave the
 tool KO+EN keywords + use-when/not-when + an example schema (it had none, so it ranked 0 under the diet
 cap). TDD 3 (bundle present / default-on / opt-out) + eval:tools web-search scenario 4/4 STABLE 3/3
 (muse.search vs knowledge_search vs web_read); LIVE: `muse ask --with-tools` searched the web and
 answered with puppeteer 25.1.0. autoconfigure 505, full eval:tools 135/135, check 0, lint 0.
- [done] :: ->Done **browser: uncapped deterministic matching, capped display** — scan/match cap raised
 50->150 (BROWSER_MAX_ELEMENTS), model-facing display capped at 40 (BROWSER_DISPLAY_ELEMENTS) with a
 truncated/shownElements/totalElements + "showing N of M" hint (no silent caps). click/type/find
 resolve against the FULL set (matcher is code), so a target past #40 still acts. TDD 3 cases
 (display cap + true total + match-beyond-cap + small-page-not-truncated); smoke:browser long-page
 case (71st element reachable past the 40 display cap); eval:tools browser 7/7 ×3, eval:browser-agent
 3/3, check 0, lint 0.
- [done] :: ->Done **browser: same-origin iframe piercing (observe + act)** — the snapshot walk now descends
 into same-origin iframe contentDocuments (like shadow roots; cross-origin throws -> skipped), so
 embedded forms/checkout/widgets are visible. The act path went frame-aware: `locateRef` finds the
 puppeteer Frame holding a ref (main doc incl. shadow via pierce/, else a child frame) and
 click/type use `frame.locator` — so a click/type on an element INSIDE an iframe acts in its own
 frame, not the main one. smoke:browser gains a same-origin srcdoc-iframe case (button listed +
 clicked inside the frame, text flips Paid); eval:browser-agent 3/3 (act-path refactor no
 regression); browser unit 37, check 0, lint 0. Cross-origin iframes stay out (CDP needs per-frame
 contexts — honest scope).
- [done] :: ->Done **file_read: .docx (Word) extraction** — `docx` FileKind + lazy mammoth (extractRawText,
 injectable like extractPdfText); routes by extension since a .docx is a zip (sniffs unsupported).
 Description gains the Word cue. TDD 4 cases (classify/resolve/route/description); eval:file-read
 generates a REAL .docx at runtime (self-contained minimal-zip writer via node:zlib crc32/deflate —
 no committed binary) -> mammoth extracts -> tool round-trip; eval:tools file scenario 6/6 STABLE 3/3
 (KO '계약서 워드 파일' -> file_read), full 131/131; check 0, lint 0. Follow-up: .xlsx — see the [decision] dep-decision blocker in HARDEN.
- [done] :: ->Done **web_download — save a file from a URL to Downloads** — chose the URL-based design over
 browser-element download (no controller interface change, no live Chrome, fully deterministic
 verification). New `web_download` tool: SSRF-guarded (loopback/internal refused via the shared
 assertPublicHttpUrl), 50MB size cap, basename-only filename (`safeDownloadName` — no path escape).
 The write-side companion to file_read; file_read then reads/summarizes what was saved. Wired
 default-on under --with-tools next to file_read. TDD 9 (safeDownloadName 3 + tool 6: well-formed,
 download+write, SSRF refuse, non-http refuse, size cap no-write, filename sanitize); eval:tools
 web scenario 6/6 STABLE 3/3 (web_download vs web_read vs search vs knowledge_search); LIVE — a real
 http server's file fetched and written to disk with matching bytes. mcp 1638, full eval:tools
 137/137, check 0, lint 0.
- [done] :: ->Done **mac: read Calendar.app / Notes.app / Reminders.app** — all three shipped as SOURCES on
 the already-wired `mac_app_read` tool (`reminders` incomplete items+due, `calendar` today's events,
 `notes` recent titles) — not new tools, keeps the exposed set small (tool-calling.md). Each:
 reachable in the model-facing app enum (verifier confirmed), behavioral parse test (fake osascript
 runner), eval:tools golden cases (EN+KO). risk=read (snippets never mutate). The earlier INERT
 separate-tool attempt was rolled back; done the COMPLETE way (extend wired tool + eval). So
 "what's on my calendar today / what reminders do I have / what notes" works locally.

HARDEN (make existing tools more reliable):
- [done] :: ->Done **regex_extract ReDoS guard** — the tool ran a model/untrusted-supplied regex with no
 backtracking protection; a nested-quantifier pattern like `(a+)+$` against just 50 chars hung the
 whole agent for ~90s (measured by the RED test). JS regex can't be timed out on the main thread,
 so added `hasNestedUnboundedQuantifier` (the safe-regex star-height heuristic, escape-aware proper
 paren matching) and reject the pattern BEFORE compile. Catches the common catastrophic class
 ((a+)+, (.*)*, ([a-z]+){2,}); overlapping-alternation ReDoS ((a|ab)+) is out of scope (still
 bounded by the 100k input cap) — documented honestly. TDD 5 (flags nested shapes, accepts ordinary
 patterns the model writes, escaped parens, tool rejects-not-hangs, normal extract still works);
 tools 242, byte-hygiene 30, check 0, lint 0.
- [done] :: ->Done **muse.search snippet length cap** — result snippets were sanitized but not LENGTH-bounded, so a
 SearXNG/DDG engine returning a full paragraph × up to 10 rows blew the local 8B's context. Added a 280-char
 word-boundary cap (`capSnippet`) on both the DDG and SearXNG paths; titles/urls untouched. A search result is
 for TRIAGE (pick a URL to read), not the full text. TDD 1 (long snippet capped, short snippet + title intact);
 mcp 1629, byte-hygiene 30, check 0, lint 0.
- [done] :: ->Done **web_read readability — strip nav/footer boilerplate** — extractReadableText dropped
 script/style/head but kept <nav> menus and <footer> (copyright/link farms), so a "summarize this
 URL" answer grounded on site chrome, not the article. Added nav|footer to the element-strip regex
 (HTML5 boilerplate by definition). TDD 1 (nav+footer dropped, article kept); live on a realistic
 article shape (nested footer>nav handled) — only the article body survives. mcp 1628, byte-hygiene
 30, check 0, lint 0.
- [done] :: ->Done **browser_open scheme guard (no local-file read via file://)** — browser_open passed any
 URL straight to page.goto, so `file:///etc/passwd` (or chrome://, view-source:, javascript:, data:)
 would load+return arbitrary local files — a broader local read than file_read's allowlisted,
 symlink-guarded path, and a prompt-injection exfil vector. Now `normalizeBrowserUrl` accepts only
 http(s) (bare host -> https; host:port preserved) and refuses every other scheme. TDD 4 cases;
 eval:browser-agent migrated to a loopback http server (was file://) and still 3/3; smoke unaffected
 (uses the controller directly). mcp/browser 37, check 0, lint 0.
- [done] :: ->Done **command_injection pattern over-fired on legit loopback URLs** — dropped the bare `http`
 trigger so the pattern requires a command VERB (curl|wget|fetch) near an internal host. "open
 http://localhost:3000 in the browser" / "내 dev 서버 http://127.0.0.1:8080 열어줘" no longer trip the
 input guard (it was blocking the whole turn); curl/wget/fetch-toward-internal still fire. TDD 3
 false-positive + 3 true-positive cases; eval:browser-agent reverted off the [::1] workaround back
 to 127.0.0.1 and still 3/3 (proves the guard fix end-to-end); policy 129, byte-hygiene 30, check 0,
 lint 0, precheck:grounding pass^2.
- [done] :: ->Done **file_read symlink-escape guard** — the absolute-path check was LEXICAL only: a file
 lexically inside the roots could be a symlink to /etc/passwd, and readFile followed it. Now
 realpath-verifies the target (and the roots — /tmp is itself a symlink on macOS) before reading;
 a link resolving outside the roots is refused, a realpath error refuses. Optional fsImpl.realpath
 (default node realpath; a fake fs with no symlinks is a no-op so existing tests are unchanged).
 TDD 3 cases (candidate-link escape, absolute-path-link escape, identity still reads) + eval:file-read
 REAL symlink round-trip (a link under Downloads -> outside is refused, target content not returned);
 mcp 1627, check 0, lint 0.
- [decision] :: **file_read .xlsx — BLOCKED on a dep decision (needs 진안)** — the maintained npm xlsx reader
 is exceljs (~21MB unpacked) and SheetJS `xlsx` on npm is the old CVE-flagged build. A 21MB dep or a
 fragile hand-rolled OOXML parser is too much to adopt autonomously; surface the choice. (.docx
 shipped via mammoth ~2MB, which was proportionate.)
- [open] :: **per-tool not-when audit** — PROGRESS (loop fire): the `followup` tools (list/cancel/snooze)
 were the ONLY personal-tool family with ZERO not-when clauses -> added "use when / NOT when"
 disambiguating them from tasks/reminders (followup = agent auto-captured thread, not a user item)
 + buildFollowupScenario in eval-tool-selection.mjs (6 positive + 4 disambiguation cases). Verifier
 confirmed the disambig cases are discriminating + wired. Other families (tasks/reminders/calendar)
 already have not-when. REMAINING: spot-audit any other tool families that lack it.
- [done] :: ->Done **muse.status.notes_index promised "size" but never returned it** (EXPANSION gap-scout, fire 24;
 tool-contract output drift) — the tool description says "Returns relative path + size — no contents. Use this as a
 discovery surface before deciding to embed/search", but `execute` mapped each file to `{ name }` ONLY — `size` was
 silently absent, so the model couldn't use size (the embedding-cost signal the description sells) to decide what to
 embed. FIX: map to `{ name, size: await fileSize(pathJoin(dir, e.name)) }` reusing the pre-existing `fileSize` helper
 (returns `number | undefined`, swallows a TOCTOU-delete so one racing file can't blank the index); map became
 `Promise.all`. TDD 1 (2 .md files of 5 + 6 bytes -> each entry's size === byte length) RED(size undefined)->GREEN; mcp
 1721, check 0 (all pkgs green), lint 0. Fable-5 PASS (RED re-confirmed by stashing src; total/error-path untouched; no
 other test pinned the old `{name}`-only shape — the tool output was previously untested). Picked over the tasks.search
 total runner-up for KIND diversity (fire 22 was the episode total-post-slice, same KIND).
- [open] :: **muse.tasks.search `total` is post-slice (capped at 50)** (EXPANSION gap-scout fire-24 runner-up; misleading-value,
 diversity-deferred) — `loopback-tasks.ts:406-411`: matches are `…sort().slice(0,50)` then `total: matches.length`, so
 `total` caps at 50 not the true match count — and unlike the SAME file's `list` tool (which reports pre-slice `total`
 + `shown`), search is internally inconsistent and has no `shown`. Distinct from the contested followups.total: here
 `list` vs `search` in ONE module disagree. Only test uses 2 tasks (total 1/0), so the cap is undocumented. FIX: pre-
 slice `total = filtered.length`, return the 50-cap slice + add `shown`. Slice: 1 file + 1 test (51 matching tasks ->
 total 51, shown 50). NOT this fire (same KIND as the fire-22 episode total fix — pick a different KIND first).
- [done] :: ->Done **bare day-of-month roll silently overflowed to a WRONG date** (EXPANSION gap-scout, fire 25;
 data-integrity / silent-wrong-value) — `resolveRelativeTimePhrase`'s `dayOfMonthMatch` branch
 (loopback-relative-time.ts:537-541) rolled a past/absent day forward with a SINGLE `new Date(y, month+1, dom)` and no
 re-validation, so a short +1 month overflowed: "the 31st" late on Jan 31 -> `new Date(2026,1,31)` = Feb 31 -> silently
 **March 3** (not March 31); "the 30th"->Mar 2, "the 29th"->Mar 1. The file's own comment promised "the next month that
 has it". That wrong date persisted into a reminder/task. FIX: bounded loop (ahead 1..12) advancing month-by-month,
 re-checking `getDate()===dom && getTime()>reference` each step, `return getDate()===dom ? finiteDate : undefined`. TDD
 3 (the 31st/30th/29th @ Jan, each -> March same-day) RED(getDate 3≠31)->GREEN; relative-time file 44/44, mcp 1722, check
 0 (all pkgs), lint 0. Fable-5 PASS (RED re-confirmed by stashing src; loop terminates, returns first future occurrence,
 final guard rejects nothing valid; no existing test documented the overflow).
- [done] :: ->Done **relative-time SIBLING year-roll overflows** (fire 26; completes the fire-25 date-overflow class) — both
 +1-year roll sites skipped re-validation: (A) `resolveAbsoluteMonthDate` (loopback-relative-time.ts:230-236) and (B)
 the Korean `koAbsDate` roll (~750-758) — "feb 29" / "2월 29일" asked in a leap year AFTER it passed (ref 2028-06-01)
 rolled into the non-leap next year where `new Date(2029,1,29)` silently became **Mar 1, 2029** (a date the user never
 asked for, persisted into a reminder/task). FIX: re-check the rolled date's month/day and return undefined (fail-safe)
 instead of a wrong date — consistent with the file's reject-don't-roll philosophy for impossible dates. TDD 3 (en + ko
 feb-29 -> undefined; mar-5 valid-roll -> 2027 no-regression guard) RED(both gave 2029-03-01)->GREEN; relative-time 47/47,
 mcp 1725, check 0 (all pkgs), lint 0. Fable-5 PASS (RED re-confirmed by stashing src; both are the ONLY two +1-year
 roll sites; getMonth-only suffices for B since day≤31 pre-validated; 413 tests across 3 files green). NOTE: returns
 undefined rather than finding the next leap year (2032) — a fail-safe minimal fix; next-leap resolution is a separate
 enhancement if 진안 wants it.
- [done] :: ->Done **muse.math#evaluate silently failed on a valid tab/newline expression** (EXPANSION gap-scout, fire 27;
 input-validation / whitelist↔tokenizer contract drift) — `SAFE_MATH_PATTERN = /^[\s\d+\-*/().,%]+$/u` (line 13) admits
 ALL whitespace, but the tokenizer's `skip()` only advanced over a literal space `" "`. So a contract-valid `"2 *\t3"`
 or a pasted multi-line `"1000\n+ 2000"` passed the whitelist, then the tab/newline stalled the cursor and the parser
 threw "expected number" / "trailing characters" — the math fast-path (also behind `muse ask`'s exact-arithmetic
 route) silently rejecting input its own contract accepts. FIX: `skip()` advances over any `\s` (`/\s/u.test(...)`),
 aligning the tokenizer with the whitelist. TDD 1 ("2 *\t3"->6, "1000\n+ 2000"->3000, "(1 +\n2)*3"->9) RED("expected
 number")->GREEN; mcp 1726, check 0 (all pkgs), lint 0. Fable-5 PASS (RED re-confirmed by stashing src; "1 2"/"1\t2"
 still error — no number concatenation; whitelist unchanged so no new chars reachable, no injection; 364 math/file
 tests green). KIND deliberately non-date after two date-overflow fires.
- [done] :: ->Done **mac_say argv flag-injection** (EXPANSION gap-scout, fire 28; argument injection / fail-open option
 parsing) — `mac_say` built `argv = voice ? ["-v", voice, text] : [text]`, passing the user's `text` as the first
 positional with NO `--` option terminator. A text of "-0" / "--version" was reparsed by `say` as a flag (live: `say
 "-0"` -> exit 1 "invalid option"), so a user asking Muse to speak a dash-leading string silently failed. FIX:
 `["-v", voice, "--", text]` / `["--", text]` — `say` supports `--` (independently live-verified by the Fable-5 judge:
 `say -- "-0"` -> exit 0; mdfind/pbcopy do NOT, so the guard stays say-specific). TDD: leading-dash "-0"/"--version" ->
 argv carries `--` before the text, spoke:true; the existing argv assertion updated (incidental characterization, no
 masked regression). macos 95/95, check 0 (all pkgs), lint 0. Fable-5 PASS (runner seam contract-faithful; voice not a
 vector — consumed as the `-v` value, no shell). KIND security (argv injection), fresh surface.
- [done] :: ->Done **muse.notes.save TOCTOU clobber** (fire 29; data-integrity / TOCTOU) — save did stat-then-writeFile, so a
 concurrent create landing between the stat and `nodeWriteFile(..., "utf8")` (flag `w`) was silently CLOBBERED under
 overwrite:false. FIX: write create-exclusive under !overwrite (`{ encoding: "utf8", flag: "wx" }`) so a stale probe +
 concurrent create yields EEXIST -> "already exists" error instead of a clobber; added an injectable `probeExists` option
 (defaults to the prior stat-based check, byte-identical) so the TOCTOU window is deterministically testable. TDD 2
 (injected absent-probe + real pre-existing file -> "already exists" + content unchanged; overwrite:true still replaces)
 RED(reverting wx -> file clobbered to "CLOBBER")->GREEN; mcp 1728, check 0 (all pkgs), lint 0. Fable-5 PASS
 (contract-faithful real-fs write, only the probe injected; EEXIST mapping scoped to !overwrite so EACCES still surfaces
 as "cannot write note"; atomic guarantee is in `wx`, not the probe). KIND TOCTOU, fresh surface.
- [open] :: **mac_spotlight_search argv-injection (fire-28 rejected, recorded)** — `mac_spotlight_search` (macos-tools.ts:1439)
 has the SAME leading-dash argv-injection as mac_say (fixed fire 28), BUT `mdfind` rejects `--` (`mdfind -- q` ->
 "Unknown option"), so there's no one-line terminator fix — needs query-rewriting/escaping logic (a real ·, not
 trivial). KIND security (argv injection).
- [done] :: ->Done **muse.fs read corrupted multi-byte UTF-8 at the truncation edge** (EXPANSION gap-scout, fire 30;
 encoding round-trip / byte-boundary) — `read` truncated with `buffer.subarray(0, maxBodyBytes).toString("utf8")`,
 cutting mid-character whenever the 64KB cap lands inside a multi-byte sequence. Korean is 3 bytes/char, so the cap
 lands mid-char ~2/3 of the time -> the agent ingested a U+FFFD replacement char at the truncation tail of every large
 Korean note (the tool promises "Reads a UTF-8 text file"). FIX: new exported pure helper `utf8SafeSliceEnd(buffer,
 maxBytes)` backs the cut off to the previous UTF-8 char boundary (walks back over 10xxxxxx continuation bytes); read
 wires it in. TDD 6 helper unit (fits/Korean-mid/exact-boundary/4-byte-emoji/ASCII-unchanged/non-positive) + 1 e2e
 (fake-fs "가나다라" maxBodyBytes:8 -> "가나", no U+FFFD) RED(reverting wiring -> "가나�")->GREEN; mcp 1735, check 0
 (all pkgs), lint 0. Fable-5 PASS (RED re-confirmed; helper fuzzed 2000+ cases vs an optimal-prefix oracle — never
 over-shoots the cap, never over-trims a fitting char, longest valid prefix; ASCII test stays green). KIND
 encoding-boundary, fresh surface — directly fixes garbled tails in 진안's Korean notes.
- [done] :: ->Done **loopback-fetch readBodyWithCap U+FFFD at the truncation tail** (fire 31; encoding-boundary + the ~10-fire
 JUDGE FAILURE DRILL) — `readBodyWithCap` decoded the truncating chunk with a NON-streaming `decoder.decode(head)`,
 flushing a partial multi-byte sequence at the cap to U+FFFD (a Korean body got "가나�"). KEY: the correct fix is NOT
 `utf8SafeSliceEnd(head)` as this · originally guessed — that helper treats `head` as a standalone buffer and misreads
 leading continuation bytes when an earlier full chunk left pending bytes in the STREAMING decoder. The right fix is
 `decoder.decode(head, { stream: true })` + never flushing on the truncated branch (the `if (!truncated)` guard already
 skips the flush), so the partial char straddling the cap is buffered and dropped. TDD 2 ("가나다라" cap 8 -> "가나";
 "가나" cap 2 -> "") RED("가나�")->GREEN; mcp 1737, check 0 (all pkgs), lint 0. JUDGE DRILL: an inert slice (comment-only
 code change + a declaration-only test asserting just truncated:true/length>0) was planted FIRST; the Fable-5 verifier
 correctly FAILED it (traced result.body="가나�", flagged the test as declaration-only, AND independently derived the
 stream-flag fix) -> rolled back -> real fix applied + PASS. Judge drill 3/3 (fire 10 json.query, fire 21 regex, fire 31
 fetch). Optional follow-up (verifier note): a multi-chunk-stream test would pin the cross-chunk decoder-state case
 (currently proven ad hoc, not by a committed test).
- [done] :: ->Done **muse.url.encode_query encoded null/undefined ARRAY items as "null"/"undefined"** (EXPANSION gap-scout,
 fire 32; contract-output-drift / inconsistent null handling) — the array branch guard
 `if (item !== null && item !== undefined && !isScalar(item)) return error` let a null/undefined item FALL THROUGH to
 `search.append(key, String(item))`, so `{tags:["a",null,"b"]}` emitted a corrupt `tags=a&tags=null&tags=b`. The SCALAR
 branch one line below explicitly skips null/undefined (and a unit test pins that skip as the contract) — so the array
 branch was internally inconsistent. FIX: `if (item === null || item === undefined) continue;` before the object check,
 matching the scalar branch. TDD (`["a",null,undefined,"b"]` -> `tags=a&tags=b`; nested-object-in-array still rejected;
 falsy-but-valid `[0,false,""]` -> `v=0&v=false&v=` still encode — strict null/undefined skip only) RED(`tags=null...`)
 ->GREEN; mcp 1738, check 0 (all pkgs), lint 0. Fable-5 PASS (RED re-confirmed by stashing src; nested object AND array
 still rejected; 0/false/"" still encode; no test pinned the old corrupt output). KIND contract-drift, fresh surface.
- [done] :: ->Done **performConsentedAction let caller headers override the consent-gated credential** (EXPANSION gap-scout,
 fire 33; SECURITY — credential-override / fail-open on the outbound-safety seam) — the fetch headers were
 `{ authorization: \`Bearer ${credential}\`, ...(body?{content-type}), ...request.headers }` with the caller's
 `request.headers` spread LAST, so `request.headers.authorization: "Bearer attacker"` silently REPLACED the
 consent-gated token, and the case-variant `{ Authorization: ... }` produced two own keys that `new Headers()` merges
 into the corrupt `"Bearer svc-token, Bearer attacker"`. Violates outbound-safety.md's "Security is code, not a prompt"
 — the scoped credential is supposed to be the only Bearer that leaves. FIX: strip every caller header whose
 `.toLowerCase() === "authorization"` (`callerHeaders`) before spreading, so the code-owned token is unstrippable;
 non-auth headers (content-type, x-custom) still forward. TDD (lowercase + capitalized override attempts ->
 `new Headers(init.headers).get("authorization") === "Bearer svc-token"`; x-custom still passes) RED("Bearer attacker")
 ->GREEN; mcp 1739, check 0 (playbook-store flake re-run green), lint 0. Fable-5 PASS (RED re-confirmed by stashing src;
 all case variants covered; whitespace/Unicode keys are invalid header names -> fail-closed via try/catch, not a bypass;
 consent/veto gates untouched). KIND security, fresh surface.
- [done] :: ->Done **performConsentedAction: request.url destination-binding (credential-exfil guard)** (fire 34; SECURITY —
 fire-33 verifier finding) — `request.url` was fully caller-controlled with nothing tying it to the consent, so the
 scoped Bearer token could be sent to ANY url (`https://attacker.example/...`). DESIGN (verified: performConsentedAction
 + recordConsent have NO production callers — unwired P5-b3 primitive; trust-correct source = the consent RECORD set at
 grant time, NOT the caller's url, and NOT a non-existent service->host registry): `ScopedConsent` gained an OPTIONAL
 `allowedHost`; `performConsentedAction` refuses (fail-closed, no HTTP) when a consent's `allowedHost` is set and
 `new URL(request.url).host` differs OR the url is unparseable; added `findConsent` (returns the record; `hasConsent`
 delegates). TDD (consent bound to api.test + url to evil.example -> refused, 0 HTTP; unparseable url -> refused) RED
 (neutralize the check -> token reaches evil.example)->GREEN; mcp 1741, check 0 (all pkgs), lint 0. Fable-5 PASS —
 including the userinfo bypass `https://api.test@evil.example/` -> `host` resolves to `evil.example` -> correctly
 refused; `host` (incl. port) is stricter than `hostname` (fail-closed-safe). KIND security, fresh surface.
- [open] :: **performConsentedAction: make allowedHost MANDATORY / fail-closed-on-absence (fire-34 follow-up)** — the
 destination-binding is currently enforce-WHEN-PRESENT (optional), so a consent without `allowedHost` still sends the
 token to any url. Once the (future) grant flows that call `recordConsent` all populate `allowedHost`, flip it: make
 the field required (or treat absence as refuse) so the binding is fail-closed by construction, not opt-in. Slice =
 require allowedHost in `isScopedConsent` + refuse on absence in performConsentedAction + update the duplicate test
 corpus (consent literals live in BOTH src/*.test.ts and test/*.test.ts — ~10 sites). Gated on grant-flow wiring
 existing first (no production caller today).
- [done] :: ->Done **muse.history.recent returned an EMPTY feed for a fractional limit < 1** (EXPANSION gap-scout, fire 35;
 boundary-condition / silent-failure) — `clampLimit` (loopback-history.ts:34) checked `raw <= 0` BEFORE truncating, so
 `limit: 0.5` passed the guard then `Math.trunc(0.5) === 0` -> `Math.min(cap, 0) === 0` -> the activity feed sliced to
 empty, so "what did I do last night?" with a model-emitted fractional limit silently answered "nothing happened"
 (`{entries: [], total: 0}`). 0 and negatives already correctly took the fallback (20). FIX: truncate BEFORE the
 positivity check so a sub-1 fractional joins 0/negatives in taking the fallback (self-consistent with history's own
 contract — NOT the proactive sibling's clamp-to-1, which has a different undefined->store-default contract). Exported
 `clampLimit` for direct unit testing. TDD 5 unit (0.5/0.999->20, 0/-5->20, 2.9->2, 1.5->1, 50->50, 500->200 cap,
 string/NaN/Inf->20) + 1 e2e (recent({limit:0.5}).total === recent({}).total, not 0) RED(0.5->empty)->GREEN; mcp 1747,
 check 0 (all pkgs), lint 0. Fable-5 PASS (RED reproduced "expected 0 to be 5"; exact 1.0->1 boundary verified; valid
 integer limits unchanged; export not in barrel — no collision). KIND boundary, fresh surface.
- [done] :: ->Done **browser_read `find` pagination was a dead-end / loop trap** (EXPANSION gap-scout, fire 36;
 contract-output-drift) — the tool description promises "A long page reports total + hasMore/nextOffset; pass offset to
 read the next batch", and the no-find branch (snapshotToJson) honours it, but the FIND branch did
 `matched.slice(0, BROWSER_MAX_ELEMENTS)` (always from 0, ignoring the documented `offset` arg) and returned only
 `{ hasMore: true }` with NO `nextOffset`. So when >50 elements matched, the local 8B was told hasMore, followed the
 protocol (`find` + `offset`), and got the SAME first 50 back forever — a loop trap. FIX: align the find branch with
 snapshotToJson — clamp offset, slice `[start, start+MAX)`, emit `offset`/`hasMore`/`nextOffset`. TDD (60 matches:
 find->50 + nextOffset:50; find+offset:50->10, offset:50, ref continuity) RED(force start=0 -> offset:50 returned the
 first 50 again)->GREEN; browser 58, check 0 (all pkgs), lint 0. Fable-5 PASS (RED re-confirmed; past-end clamps to
 empty, negative clamps to 0, contiguous pages no dupes/skips, filterElements order-stable; only consumer is the CLI
 tool registration — opaque JSON to the model). KIND contract-drift, fresh surface (browser). Minor pre-existing nit
 (out of scope): the find branch names the count `matched` while no-find uses `total`.
- [done] :: ->Done **dismissPattern lost-update race (user veto could be silently dropped)** (EXPANSION gap-scout, fire 37;
 lost-update / concurrent RMW missing serialisation) — `dismissPattern` did an UNSERIALISED read->append->write on
 patterns-fired.json while its sibling `recordPatternFired` already wraps the identical RMW in `withFileMutationQueue`.
 Concurrent in-process dismissals/fires read the same snapshot -> last write clobbers the rest -> a lost dismissal means
 Muse keeps suggesting a pattern the user explicitly vetoed (learned-avoidance dropped — the trust failure proactivity
 exists to avoid); same-ms writes also crashed on the `tmp-${pid}-${Date.now()}` rename (ENOENT). FIX: wrap the body in
 the per-file queue (mirrors recordPatternFired); deleted a stale JSDoc that falsely claimed "the daemon is the only
 writer… we accept that [clobber] trade". TDD (Promise.all of 12 dismiss + 13 fire on one file -> all 25 present, all 12
 dismissals survive) RED(revert queue -> ENOENT/lost record)->GREEN; mcp 1748, check 0 (messaging pending-approval flake
 unrelated, isolated 17/17), lint 0. Fable-5 PASS (read inside critical section; no nested-queue deadlock; non-flaky).
- [open] :: **patterns-fired (and sibling stores) lack CROSS-PROCESS write serialisation (fire-37 verifier finding)** —
 `withFileMutationQueue` serialises only WITHIN one process, but the motivating race is the CLI `muse pattern dismiss`
 vs the proactive daemon — TWO OS processes writing the SAME patterns-fired.json. Atomic rename prevents corruption but
 NOT a cross-process clobber (a dismissal landing between the daemon's read and write is still lost). This is
 pre-existing and shared by every store on the queue. FIX (if it ever bites): a file lock (lockfile / flock) around the
 RMW. Slice = a cross-process lock primitive + wire the patterns-fired RMWs + a two-process race test (spawn). Larger;
 gated on whether single-user concurrency is real enough to justify the complexity.
- [done] :: ->Done **writeFollowupLlmBudget hand-rolled write (same-ms ENOENT crash + orphaned tmp)** (EXPANSION gap-scout,
 fire 38; resource-leak / race-induced crash) — `writeFollowupLlmBudget` hand-rolled `tmp-${pid}-${Date.now()}` then
 open/write/sync/rename with NO catch-cleanup, while the SAME package's `atomicWriteFile` already fixes exactly this
 class (randomUUID tmp + fsync + 0o600 + orphan cleanup) and the module already imports `withFileMutationQueue` from it.
 Two same-ms writers -> identical tmp -> the slower rename ENOENT-crashes; any write/rename failure orphans the tmp
 (UNCONDITIONALLY real, independent of concurrency). FIX: replace the body with `atomicWriteFile(file, payload)` (byte-
 identical payload, same fsync/0o600 durability). TDD (frozen Date.now -> 2 concurrent writes both resolve + no `.tmp-`
 orphan) RED(ENOENT rename on `budget.json.tmp-<pid>-1700000000000`)->GREEN; mcp 1749, check 0 (all pkgs), lint 0.
 Fable-5 PASS (durability preserved; both defects closed; the one production caller composes inside its queue). The
 collision is defense-in-depth (writeFollowupLlmBudget is a public export) but the orphan defect was unconditionally
 real. KIND resource-leak, fresh surface.
- [open] :: **appendReminderHistory hand-rolls the same tmp write (fire-38 runner-up)** — `personal-reminder-history-store.ts`
 (~line 64-68) hand-rolls `tmp-${pid}-${Date.now()}` with NO fsync and no leak cleanup. Same one-line `atomicWriteFile`
 adoption. Lower urgency: it sits inside the mutation queue so the in-process collision is unreachable and the fsync gap
 isn't behaviorally testable — but adopting the shared primitive removes the orphan-on-failure leak + the fsync gap.
 Slice: swap to atomicWriteFile + a no-orphan-on-injected-failure test (or accept it's covered by the primitive's tests).
- [open] :: **cleanupFollowupTempFiles is dead-wired (fire-37/38 runner-up, NOT a crisp fix)** — `personal-followups-store.ts`
 `cleanupFollowupTempFiles` docstring claims "Called by readFollowups" but has ZERO production callers (only a test), so
 crash-orphaned followup tmp files accumulate forever. The naive wiring (call it from readFollowups) is NOT objectively
 correct — readFollowups runs unqueued from the list tool, so cleanup could unlink an in-flight atomicWriteFile tmp
 before its rename and kill a concurrent write; the safe fix needs an mtime age-gate whose threshold is a judgment call.
 Real leak but needs a design decision — record, don't auto-pick.
- [done] :: ->Done **active objective with an unparseable nextEvalAt was silently frozen forever** (EXPANSION gap-scout, fire 39;
 silent-failure / NaN-poisoned date comparison) — the `due` filter was
 `o.status === "active" && (!o.nextEvalAt || Date.parse(o.nextEvalAt) <= nowMs)`; a non-ISO nextEvalAt makes
 `Date.parse` -> NaN, `NaN <= nowMs` -> false, and `!o.nextEvalAt` is false (truthy string), so the objective is EXCLUDED
 from `due` on EVERY tick forever — never evaluated, never escalated (contradicts the module's "never silently dropped"
 contract; the same file already guards this exact NaN-poison class for maxPerTick). Reachable via a hand-edited /
 foreign-written objectives.json (isStandingObjective never validates nextEvalAt). FIX: fail-open to evaluation when
 unparseable (`!Number.isFinite(nextMs) || nextMs <= nowMs`); the backoff path then rewrites a valid ISO (self-heal).
 TDD (nextEvalAt:"not-a-date" -> evaluated once, retried, persisted nextEvalAt now parseable === nowMs+1000)
 RED(excluded -> evaluated 0)->GREEN; mcp 1750, check 0 (all pkgs), lint 0. Fable-5 PASS (future-valid still excluded so
 cooldown intact; no legitimate non-ISO sentinel — "never" is status not a magic string; self-heals after one eval).
 KIND silent-failure, fresh surface.
- [open] :: **append-only stores silently DESTROY a forward-version entry on the next write (fire-39 runner-up)** —
 `appendActionLog` (personal-action-log-store.ts:212-221) and `addObjective`/`patchObjective`
 (personal-objectives-store.ts:97-130) round-trip through a validation-FILTERING read (`readActionLog`/`readObjectives`
 flatMap-drop entries failing `isActionLogEntry`/`isStandingObjective`), so any stored entry a newer schema wrote (e.g.
 a forward `result` value or unknown field) is permanently ERASED by the next unrelated append — violating the
 documented "APPEND-ONLY… preserved verbatim / never silently destroyed (quarantine)" contract. FIX needs a RAW-read
 path for the write (read+append+write on the raw array, validate only on the READ-for-consumers path) — bigger than
 one filter line. Slice: add a raw passthrough reader + wire the append/patch RMWs + a forward-compat test (seed an
 entry with an extra field, append another, assert the first survives byte-identical). Two stores share the KIND+shape.
 BLOCKERS (fire-40 eval, NOT a clean single fix — needs a design decision): (a) the action-log is a HASH-CHAIN
 (`prevHash: chainTipHash(existing)`), so preserving an unvalidatable forward-version entry breaks the typed
 chain-hash computation — raw preservation + chain integrity conflict; (b) "corrupt entry (drop is correct)" vs
 "forward-version entry (preserve)" are INDISTINGUISHABLE to `isActionLogEntry`, so preserve-unknown also re-persists
 genuine garbage — a real preserve-vs-drop judgment, not a mechanical fix. The objectives store (no hash chain) is the
 cleaner first target IF the preserve-unknown policy is decided. 진안 input on the policy + chain handling.
- [done] :: ->Done **muse.calendar.update silently dropped an unparseable startsAt/endsAt and reported success** (EXPANSION
 gap-scout, fire 40; missing-validation) — `resolvedStartsAt = startsAtRaw ? parseIsoDate(...) : undefined` returns
 undefined for an unresolvable phrase, then the spread `...(newStartsAt ? {startsAt} : {})` omitted the move and
 `update` called `registry.updateEvent` + returned `{event}` SUCCESS — so "move my dentist to flurbsday" reported done
 while nothing moved. The sibling `add` already errors on this exact condition; a parseable start + unparseable end
 also moved the start but left the end (end-before-start risk). FIX: error (mirroring `add`) when a raw startsAt/endsAt
 was PROVIDED but parses to undefined, BEFORE updateEvent (omitted args unaffected; valid phrases still parse). TDD
 (startsAt:"flurbsday" -> error + updateEvent NOT called; valid-start + endsAt:"flurbsday" -> error + no call — the
 τ-bench no-partial-side-effect property) RED(remove guards -> updateEvent called, success)->GREEN; mcp 1752, check 0
 (all pkgs), lint 0. Fable-5 PASS (omitted untouched, newEndsAt fallback algebraically identical, no partial state).
 KIND missing-validation, fresh surface. (Side effect, per the slice's intent: an empty-string "" startsAt/endsAt now
 errors too, consistent with `add`.)
- [open] :: **calendar.add silently coerces an unparseable endsAt to start+60min (fire-40 runner-up)** — `add`'s endsAt
 fallback (`(endsAtRaw && isTimeOnlyPhrase ? ... : parseIsoDate(endsAtRaw)) ?? new Date(startsAt+60min)`) means a
 PROVIDED-but-unparseable endsAt silently becomes a 1-hour default instead of erroring — the same family as the update
 fix. Lower urgency (endsAt is optional with a sensible default, vs update's success-while-noop), and erroring needs to
 preserve the omitted-endsAt->default path. Slice: error only when `endsAtRaw !== undefined && parse === undefined` +
 test. Also (fire-40 verifier nit): a non-string startsAt (numeric epoch) is silently ignored via readString->undefined
 on BOTH add and update — string-but-unparseable is fixed, wrong-TYPE is not; fold into the same slice if worth it.
- [done] :: ->Done **appendReminderHistory persisted secrets to the plaintext audit log unscrubbed** (EXPANSION gap-scout,
 fire 41; SECRET-LEAK / data-integrity) — `appendReminderHistory` appended the raw `entry` to reminder-history.json
 while the SIBLING proactive-history store deliberately scrubs at the persist chokepoint
 (`redactSecretsInText(title/text/error)`). So a reminder "rotate key sk-proj-…" is DELIVERED scrubbed (the delivery
 path scrubs only the copy it SENDS) but ARCHIVED VERBATIM; `error` can also quote an upstream response body (e.g. a
 Telegram bot token). FIX: scrub `text` + `error` at the chokepoint (`{ ...entry, text: redactSecretsInText(text),
 ...(error ? { error: redactSecretsInText(error) } : {}) }`) — exact parity with the proactive sibling, so every caller
 inherits it. TDD (text with sk-proj key + error with telegram token -> read-back has `[redacted-openai-key]` /
 `[redacted-telegram-bot-token]`, raw tokens absent) RED(raw entry -> plaintext key persisted)->GREEN; mcp 1753, check 0
 (all pkgs), lint 0. Fable-5 PASS (text+error = full secret-bearing set; destination non-secret by the messaging
 contract; chokepoint inherited by both call sites). KIND secret-leak, fresh surface — directly on Muse's "it can't
 tell anyone" identity.
- [open] :: **reminder daemon prints raw error strings to daemon.out.log (fire-41 verifier finding; secret-leak)** —
 `runDueReminders` returns raw `errors` strings (reminder-firing-loop.ts:~140 — the same upstream error that can quote
 a Telegram/Slack token), and the daemon prints them to stdout, which the macOS LaunchAgent persists to
 `daemon.out.log` (commands-daemon.ts:~486). Reminder TEXT is not echoed there (only error strings), but a
 token-quoting send failure archives the raw token in that log. FIX: apply `redactSecretsInText` at the daemon's
 error-print seam (and/or scrub the `errors` array in the summary). Slice: 1 wrap + 1 test (a secret-bearing error ->
 the printed/returned string is redacted). Fresh surface (daemon stdout).
- [done] :: ->Done **commitment check-ins lost-update / stale-snapshot write** (EXPANSION gap-scout, fire 42; data-integrity /
 lost-update) — `appendCheckins` did an UNQUEUED read->append->write, and `runDueCheckins` read `all` (snapshot), awaited
 multi-second network sends, then wrote `all.map(...)` (the STALE pre-send snapshot) — so a check-in appended (chat-turn
 hook) or cancelled DURING the send window was clobbered: a fresh check-in vanished, a CANCELLED nudge RESURRECTED and
 re-fired (trust failure — the user silenced it). Siblings (followups/objectives) use `withFileMutationQueue`; this
 store predates the pattern. FIX: wrap `appendCheckins` in the per-file queue; make the fired-status write re-read the
 FRESH store inside the queue and patch ONLY the fired ids, not the stale `all`. TDD (registry.send appends a check-in
 mid-send -> it survives + the fired one is marked; 2 concurrent appendCheckins both persist) RED(stale write clobbers +
 ENOENT)->GREEN; mcp 1773, check 0 (all pkgs), lint 0. Fable-5 PASS (re-read inside queue, patch-by-id, cancel-not-
 resurrected by construction, no deadlock — send loop OUTSIDE the queue; scope honest: fixes IN-PROCESS races,
 cross-process CLI-cancel-vs-daemon is the existing file-lock ·). KIND lost-update, fresh surface.
- [open] :: **commitment-checkin keeps a bespoke writeFileAtomic (pid+Date.now tmp) (fire-42 verifier nit)** — the store's local
 `writeFileAtomic` (line ~226) still uses `${file}.tmp-${pid}-${Date.now()}` instead of the shared `atomicWriteFile`
 (randomUUID + orphan cleanup). The queue masks the in-process collision on the fixed paths, but the CLI's direct
 `writeCheckins` (cancel/snooze, unqueued + cross-process) can still hit the same-ms ENOENT + orphan. FIX: adopt
 `atomicWriteFile`. Joins the appendReminderHistory tmp-write · (same one-line swap, resource-leak KIND).
- [done] :: ->Done **proactive-notice firedKey separator-injection collision (a real notice silently suppressed)** (EXPANSION
 gap-scout, fire 43; dedup / key-collision) — `firedKey` built the dedup key as `${kind} ${id} ${startIso}` (space-join
 of free-form fields). `id` is a provider event / task id (untrusted, can contain spaces), so two DISTINCT
 {kind,id,startIso} tuples collide on one key (id="a b"+startIso="X" vs id="a"+startIso="b X" both -> "calendar a b X");
 the dedup `seen.has(key) -> continue` then SILENTLY SUPPRESSES a legitimate second proactive notice — violating the
 module's own "fires at most once per {kind,id,startIso} tuple" contract. FIX: `JSON.stringify([kind,id,startIso])`
 (unambiguous; JSON escapes field boundaries — injective). In-memory key (rebuilt each run from the entries sidecar),
 so NO persisted migration. TDD: unit (collision pair -> distinct keys; same tuple -> same key) + e2e (crafted colliding
 sidecar entry -> runDueProactiveNotices fires the new event, summary.fired===1) RED(space-join -> suppressed,
 fired=0)->GREEN; mcp 1776, check 0 (all pkgs), lint 0. Opus PASS (JSON injective incl. quote/bracket injection;
 entries-not-keys persisted so backward-compatible; reachable — calendar event ids are provider-reported/untrusted).
 KIND dedup, fresh surface. (Fable-5 was unavailable this fire; scout + judge ran on Opus 4.8 per the fallback.)
- [done] :: ->Done **objective verdict parser leaked a NESTED outcome -> FALSE autonomous `met`** (EXPANSION gap-scout, fire 44;
 parsing-bug / safety — false-positive completion) — `balancedJsonCandidates` (objective-evaluator.ts:79-110) pushed
 every balanced `{...}` span starting at every `{` WITHOUT advancing past a consumed span, so a NESTED object was
 re-extracted as its own candidate. `parseObjectiveVerdict` takes the LAST candidate with a recognized `outcome`, so
 `{"plan":{"outcome":"met"},"note":"not yet"}` leaked the inner `{"outcome":"met"}` -> returned `met` — the one outcome
 the module promises "never a false met" (it's autonomous: `runDueObjectives` calls `act()` + flips status:done on a
 `met` verdict). FIX: after pushing a balanced span ending at `j`, set `i = j` so only TOP-LEVEL objects are verdict
 candidates; a nested-only outcome is ambiguous ⇒ the conservative `unmet`. TDD (nested-only met -> unmet; nested-in-
 array -> unmet; top-level unmet + nested met -> unmet) RED(remove i=j -> false met)->GREEN; mcp 1778, check 0 (all pkgs),
 lint 0. Opus PASS (separate top-level objects still both extracted; brace-in-string/escaped-quote unaffected; the
 evaluator SYSTEM_PROMPT demands a TOP-LEVEL `{outcome,reason}` so a nested-only reply is off-spec -> unmet is correct,
 not a dropped legit verdict). KIND parsing-bug, fresh surface — directly on the fabrication=0 / autonomous-safety edge.
- [done] :: ->Done **runDueFollowups fired an arbitrary file-order slice, starving the most-overdue followup** (EXPANSION
 gap-scout, fire 45; sort-ordering + the ~10-fire JUDGE FAILURE DRILL) — the due selection was
 `all.filter(scheduled && scheduledFor<=now).slice(0, max)` with NO sort, so when a backlog exceeds `maxPerTick` (a
 daemon catching up after downtime), the FILE-FIRST commitments fire and the genuinely most-overdue self-followup is
 deferred tick after tick. The sibling `compareFollowupsByScheduledFor` (soonest-first) existed but was never applied.
 FIX: `.sort(compareFollowupsByScheduledFor)` before `.slice(0, max)` (soonest-scheduledFor = most-overdue for past
 times). TDD (3 distinct-due followups, oldest written LAST, maxPerTick:1 -> fired[0].id==="fu_oldest" + the other two
 stay scheduled) RED(no sort -> fires file-first "fu_recent")->GREEN; mcp 1779, check 0 (all pkgs), lint 0. JUDGE DRILL:
 an inert slice (comment-only code + a test asserting just `delivered===1`) was planted FIRST; the Opus verifier
 correctly FAILED it (empirically probed fired[0].id==="fu_recent", flagged the test as count-only, derived the sort
 fix) -> rolled back -> real fix + PASS. Judge drill 4/4 (fire 10 json.query, 21 regex, 31 fetch, 45 followups). KIND
 sort-ordering, fresh surface. (Fable-5 unavailable; scout + both judge passes ran on Opus 4.8 per the fallback.)
- [done] :: ->Done **runDueObjectives left backoffBaseMs/backoffMaxMs un-NaN-guarded -> objective spins every tick** (EXPANSION
 gap-scout, fire 46; missing-validation / NaN-poison) — `maxPerTick`/`maxAttempts` are `Number.isFinite`-guarded (the
 file's own comment names this class) but `const base = options.backoffBaseMs ?? DEFAULT; const cap = options.backoffMaxMs
 ?? DEFAULT` used bare `??`, which does NOT catch NaN/Infinity. A non-finite backoff -> `delay = Math.min(cap, NaN*…) =
 NaN` -> `new Date(nowMs + NaN).toISOString()` throws RangeError -> the sibling-protecting catch swallows it -> the
 objective never gets a new nextEvalAt and re-evaluates EVERY tick forever (backoff defeated, the exact failure the
 comment claims to prevent). FIX: mirror the guard — `Number.isFinite(base) ? base : DEFAULT` for BOTH base and cap. TDD
 (backoffBaseMs:NaN -> retried + valid nextEvalAt = nowMs+60_000, not errored; backoffMaxMs:NaN -> also guarded) RED(bare
 ?? -> RangeError, retried empty)->GREEN; mcp 1780, check 0 (all pkgs), lint 0. Opus PASS (NaN/Inf/undefined caught,
 finite incl 0 preserved, base+cap symmetric; verifier nit "cap not independently tested" addressed with a cap-NaN
 case). KIND missing-validation; same file + NaN-poison class as fire 39 (nextEvalAt) — completes the file's guard
 symmetry. (Fable-5 unavailable; scout + judge on Opus 4.8.)
- [open] :: **tool-arg grounding coverage** — extend `groundedArgs` (the deterministic anti-fabrication
 boundary) to every actuator persisting model-named free-text; one behavioral drop test each.
 DONE: `tasks.add` (notes/tags), `tasks.update` (notes), `add_contact` (relationship), `calendar`
 (location/notes), `followup.cancel` (reason) — each Opus-verifier-traced to the runtime grounding.
 REMAINING: spot-audit other update/edit paths' optional free-text (reminders has none fabricable —
 text=user-stated, dueAt=time, recurrence=enum).
- [done] :: ->Done **content-sniff over extension** — file_read now classifies by CONTENT
 (`sniffFileKind`/`resolveFileKind`): `%PDF` magic always wins (a mislabeled `.txt`-that-is-a-PDF
 routes to the extractor), an extensionless download with text bytes reads (extension-only refused
 it), a NUL/binary blob is still refused. Extension stays the fast path; the sniff is the
 correction. Also fixed classifyFileKind's no-dot bug (`split('.').pop()` returned the whole name).
 TDD 10 cases (sniff + resolve + 2 tool integration); eval:file-read gains the no-ext + mislabeled
 real-file round-trips; mcp 1616, check 0, lint 0.
- [done] :: ->Done **web_action URL vetting (SSRF guard)** — the existing assertPublicHttpUrl guard protected
 muse.web.read (READ) but NOT web_action (state-changing SUBMIT — the higher-risk tool was the
 unguarded path). Wired it in BEFORE the approval gate/any HTTP. Split the guard into a sync half
 (assertPublicHttpUrlSync: protocol + literal loopback/private/link-local IP + blocked host — always
 on, no DNS) and the async DNS-rebinding layer (opt-in via deps.lookup), so literal SSRF
 (127.0.0.1, 169.254.169.254 metadata, file://) is always blocked and the happy path needs no
 resolver. TDD 4 SSRF cases + injected-private-resolver (DNS-rebinding); web_action selection
 unaffected (eval:tools actuator scenario), mcp 1620, check 0, lint 0, precheck:grounding pass^2.

## Open — 2026-06-10 full-feature audit (3 reviewers; VERIFIED findings -> fix queue)

FIXED already: actuator non-TTY fail-close (d7112db9) · hybrid-MMR scale bug · write-run cache
replay (this commit). Remaining, severity order:

- [done] :: ->Done **Ink chat output gate** — finalizeGatedChatAnswer (the ONE shared post-stream pipeline:
 gate->reverify->citation strips->receipt) now runs on the Ink surface AND chat-repl was refactored
 onto it so the surfaces cannot drift again; groundingFor returns matches; render test pins that
 a fabricated answer is gated before display AND before history commit. (CLI audit #1, HIGH)
- [done] :: ->Done **calendar↔reminder lifecycle link on EVERY surface** — helpers moved to
 @muse/mcp (event-reminder-link.ts), wired into the MCP update/delete executors (results carry
 remindersShifted/remindersRemoved) AND the API DELETE route; CLI re-exports. BONUS: a fired
 reminder rescheduled into the future resets to pending (audit CLI #3) while a still-past shift
 never instant-re-fires. 5/5 incl. loopback integration + no-partial-side-effect. (both audits, HIGH)
- [done] :: ->Done (reminders) **Reminders store unserialized RMW -> serialized via mutateReminders** — the
 daemon firing loop read the reminders once then wrote its in-memory copy per delivery, CLOBBERING a
 reminder a chat `add` wrote after the tick started (the reported daemon-vs-chat lost write). Added
 `mutateReminders(file, fn)` = read->fn->write under the cross-process `withFileLock`; converted EVERY
 RMW site (add, snooze, fire, delete in loopback-reminders + the firing loop's per-delivery write,
 which now re-reads current and marks fired by id, merging with concurrent adds). TDD 3 (two
 concurrent adds both persist, mutate returns+persists, serial sequence keeps all); mcp 1651, check
 0, lint 0. FOLLOW-UP: the TASKS store has the same shape — apply mutateTasks next.
- [done] :: ->Done (tasks) **Tasks store unserialized RMW -> serialized via mutateTasks** — same fix as
 reminders: `mutateTasks(file, fn)` = read->fn->write under the cross-process `withFileLock`;
 converted EVERY RMW site (add/complete/update/delete in loopback-tasks). mutate-tasks.test.ts
 proves two concurrent adds both persist (lost-update gone). mcp build + 1654 tests green, lint 0.
 (stores audit #2, tasks half — completes the reminders FOLLOW-UP)
- [done] :: ->Done **Calendar store + credential store: corrupt file -> silent full wipe** — both
 `LocalCalendarProvider.readAll` and `FileCalendarCredentialStore.readAll` returned empty on
 JSON-parse-failure OR schema-mismatch, and the next atomic write then overwrote the corrupt-but-
 recoverable original — permanent data loss. Adopted the sibling reminders-store posture via a shared
 `corrupt-quarantine.ts` (`quarantineCorruptStore` = best-effort rename to `<file>.corrupt-<ts>`),
 called on all 4 corrupt branches; writes were already atomic (tmp->rename). TDD 3 (corrupt JSON +
 schema-mismatch quarantined with original bytes preserved; credential corrupt quarantined) RED 3/3 ->
 GREEN; calendar 152, check 0, lint 0. Fable-5 verifier PASS (ENOENT/transient-IO not quarantined,
 predicate unchanged so strictly safer, rename preserves 0600, concurrency-safe). RESIDUAL (out of
 slice): local-provider's per-entry `isPersistedEvent` flatMap still silently drops INDIVIDUAL corrupt
 events from an otherwise-valid array — a partial-loss path (logs nothing); separate slice.
- [done] :: ->Done **toolGrounded blanket bypass** — fixed; keys on non-empty toolGroundingSources, value checks
 always-on, single-source helper shared run()+stream. See the Done entry up top. (CLI audit #4)
- [done] :: ->Done **Chat-only users never get the embedder migration** (CLI audit #5) —
 `refreshStaleNotesIndexForChat` gated re-embed on CONTENT staleness only and returned early when
 notes were unchanged, so a chat-only user (the desktop companion never runs `muse ask`, the only
 other reindex trigger) kept ranking v2-moe query vectors against a legacy v1 index forever
 (cross-model cosine noise above the 0.5 floor). FIX: read the index model BEFORE the staleness
 gate; re-embed on `modelStale || contentStale`, where `notesIndexNeedsModelMigration` =
 `resolveIndexModel(existing, requested) !== existing` (legacy->default migrates; custom/default/none
 unflagged so no every-turn loop). Made the fn exported + deps-injectable (isStale/reindex/
 readIndexModel) for an Ollama-free OUTCOME test. TDD 5 (1 helper unit + 4 DI behavioral: legacy-fresh
 reindexes to default, default/custom-fresh don't, content-stale still does) RED->GREEN; cli 2525,
 check 0, lint 0. Fable-5 verifier PASS. RESIDUAL (separate slice): if the embedder is DOWN during a
 model-mismatch rebuild, `reindexNotes` drops prior-entry carry-forward -> saves an empty index until
 notes change / manual reindex (fail-close: zero hits -> refusal, not fabrication; pre-existing path).
- [open] :: **ask error paths skip the run-log trace** (failed runs are exactly the error-analysis fuel) +
 Ctrl-C still runs the verdict pipeline and logs success:true. try/finally + success:false entries.
 (CLI audit #6/#7)
- [open] :: smaller: ~~correction-polarity regex unanchored ("NOT CONTRADICT"->contradict decay)~~ [done]DONE
 (2026-06-13 fire 17: core de-negation existed; HARDENED to cover contraction auxiliaries
 WON'T/CANNOT/WOULDN'T/SHOULDN'T/COULDN'T + 0-2 intervening words "NOT A CONTRADICTION"/"DOESN'T
 REALLY CONTRADICT"; conservative-by-design over-strip = fail toward no-decay; 99 agent-core green) ·
 ~~enforceAnswerCitations whitespace rewrite on clean answers~~ [done]DONE (fire 18: cleanup gated on stripped.length>0 — clean answers verbatim, code blocks preserved; 1732 green) ·
 ~~casual-prompt 말해줘 over-match suppresses source blocks~~ [done]DONE (fire 20: removed 말해줘 from isCasualPromptText social regex — "내 일정 말해줘" etc are recall imperatives, were wrongly classed casual -> source footer suppressed; Fable-judge PASS, agent-core 1741 green) · ~~dedup memoizes write results~~ [done]DONE (fire 19: real bug was stale-READ-after-write — a memoized read went stale after an intervening write in-loop; fix = mutating record invalidates read entries, keeps write entries/anti-double-write; Fable-judge PASS, agent-core 1738 green) ·
 ~~groundToolArguments partial-array reported as dropped~~ [done]DONE (fire 21: partial-array clean now keeps survivors WITHOUT reporting the arg in `dropped` — dropped = fully-removed args only, per the contract; .args cleaning unchanged; Fable-judge PASS, agent-core 1746 green) · consented-action header override ·
 web_action URL vetting · encryption coverage (calendar credentials!). (audit LOW/MED tail)

## Open — refilled 2026-06-09 (gap-finding scout, clean autonomous slices)

## Open — frontier research pass 2026-06-10 (3 fresh tracks; full table -> docs/strategy/frontier-research-2026-06.md)

KEY UNLOCK (first-hand verified): Ollama 0.30.6 native API exposes `logprobs`/`top_logprobs`
for gemma4 — token-level confidence is no longer blocked (`<|channel>` marker tokens must be
excluded when scoring).

- [done] :: ->Done **F1 logprob instrumentation** (shipped, independent-evaluator PASS — see Done).
- [done] :: ->measured **F2 BM25 promotion: NO DELTA** — bm25Scores + RRF already existed
 (knowledge-recall.ts, env `MUSE_RECALL_BM25`); A/B on the embedder-ab corpus AND a targeted
 exact-string identifier probe (ERR codes, license key, IP, model tag) both saturate 100%
 with bm25 on OR off — the default lexical-overlap arm already handles identifier tokens.
 Default stays off (no unverified win); revisit only if real-trace misses provide
 discriminating cases. Contextual chunk annotation (Anthropic slice 2) remains a candidate.
- [done] :: ->Done **F3 KnowNo conformal tool selection (offline)** — `pnpm eval:conformal-tools`:
 MCQA top_logprobs + leave-one-out conformal at α=0.1 over the 14-case time family ->
 coverage 13/14 (92.9% ≥ 90% target), wrong-but-confident 0, unnecessary clarifies 0
 (docs/benchmarks/RESULTS-conformal-tools.md). Runtime wiring (set>1 ⇒ clarify-directive)
 is the follow-up once a larger calibration set exists.
- [done] :: ->Done **ACT-R base-level activation for recall ranking** — frequency×spacing activation over the
 access logs now drives promotion RANKING (not the single recency half-life). (T2-1)
 [DONE 2026-06-12, cognition loop fire 1–3 + 진안 review-gate decision: RANKING-ONLY; the
 gate-scale migration (ACT-R driving eligibility, needs log-scale threshold recalibration + A/B)
 was deliberately NOT pursued — ranking lift is captured, gate stays on the scale-safe plain score.]
 — [in progress 2026-06-12, cognition loop] fire 1: `actrActivation(accessAgesDays,{decay,minAgeDays})`
 = `ln(Σ tⱼ⁻ᵈ)` + 9-case battery SHIPPED in `@muse/memory` (recall-promotion.ts). fire 2: the DATA
 FOUNDATION — `personal-recall-hits-store.ts` now logs a bounded `recentAccessMs` per memory (cap 20,
 tolerant migration of old records, garbage-sanitizing read). fire 3: WIRED — `recallActivation` +
 opt-in `useActrRanking` on selectPromotable/selectForgettable ranks by ACT-R (frequency×spacing)
 while the eligibility GATE stays on the plain recency score (scale-safe); enabled at the `muse memory
 consolidate`/promote call sites. [decision] REMAINING (review-gate decision): a measured A/B on whether ACT-R
 should also drive the eligibility GATE (needs threshold recalibration to the log scale) before
 graduating — ordering is live now, gate-migration is the open call. Then this item -> Done.
- [done] :: ->Done **ACE deterministic playbook delta-merge** — itemized deterministic deltas replace the
 LLM-rewrite first pass + an anti-collapse invariant test (+10.6% AppWorld for the pattern). (T1-1)
 [DONE 2026-06-12, cognition loop fire 4: `deltaMergePlaybookStrategies` (whitespace-dedup +
 token-coverage subsumption + non-transitive anti-collapse GUARD) was already implemented & wired
 ahead of the LLM merge; the MISSING piece — a DIRECT anti-collapse invariant battery — was added
 (7 cases incl. the non-vacuous property "if it returns a survivor, that survivor token-covers EVERY
 input", so a learned strategy is never silently dropped). Test-only; agent-core 1691 green.]
- [done] :: ->Done **Multi-group/multivalid conformal UQ for abstention** — pooled abstention calibration
 over an EN-only corpus silently loses its coverage guarantee on the Korean subgroup (the exact
 failure of arXiv:2407.21057, Liu & Wu). [DONE 2026-06-13, cognition loop fire 29:
 `calibrateAbstentionByGroup` (per-`dominantScriptFamily` conformal tau, pooled fallback for thin
 groups) in conformal.ts + additive `groups`/`calibration`/`groupCoverageViolations` in
 `scoreGroundingEval` + per-group rows & 주의: violation render in grounding-eval-runner; made LIVE by
 adding a Korean subgroup (12 answerable + 4 must-refuse + 12 grounded notes) to the production
 `GROUNDING_EVAL_CORPUS` — `muse doctor --grounding` now renders latin+hangul groups (judge v1 FAIL
 caught it inert on the EN-only corpus; v2 PASS proved live on real Ollama). Additive measurement
 only, verdict/threshold unchanged (fabrication-floor safe).]
- [open] :: **Per-group abstention threshold at serve time** — `calibrateAbstentionByGroup` now MEASURES the
 per-script-family gap; the follow-up is to SERVE the per-group tau (route a Korean query through the
 hangul threshold, not pooled) once the per-group calibration set is large enough to trust. (next)
- [done] :: ->Done **MemoryBank Ebbinghaus forgetting loop — close the inert fade seam** — fade was COMPUTED
 (`selectForgettable`) but applied nowhere (report-only across 3 surfaces, arXiv:2305.10250 Zhong et
 al. AAAI 2024). [DONE 2026-06-13, cognition loop fire 30: `muse memory consolidate` writes `plan.fade`
 keys to `~/.muse/memory-fade.json`; the default-ON `StoreBackedEpisodicRecallProvider.resolve` reads
 it and down-ranks faded sessions ×FADE_PENALTY=0.5 (post-minScore-gate, ranking-only, never deletes);
 re-recalled memories auto-reinstate via consolidate overwrite + lastHitMs reset. Judge PASS: session-key
 identity holds end-to-end, counterfactual robust, fail-open 3 layers, fabrication floor intact.]
- [done] :: **MemoryBank fade importance term** — `selectForgettable` gains `importanceHitsFloor` (default 8): a memory with ≥ floor LIFETIME recall hits resists fading even when idle+decayed (frequency consolidation, MemoryBank arXiv:2305.10250). AND-conjoined (only more conservative), default reaches daemon+manual consolidate, non-destructive. — self-improvement fire 3
- [done] :: ->Done **ReConcile consensus-gated council rounds** — `muse swarm council` ran a fixed round count
 blind to convergence (MAST step-repetition + termination-unawareness, arXiv:2309.13007 Chen/Saha/Bansal
 ACL 2024). [DONE 2026-06-13, cognition loop fire 31: `hasCouncilConsensus` (every member's mean pairwise
 Jaccard support ≥ DEFAULT_COUNCIL_AGREE_AT=0.16) added to the debate loop condition; `--rounds` default
 bumped 1->2 (required — the loop is dormant at 1) so an agreed panel stops at round 1 and only a contested
 panel spends the (previously dormant) debate round, bounded by the unchanged cap 3. Single gather-closure
 seam -> the assembled-path test drives the real production loop. Judge PASS: both counterfactuals
 non-vacuous, refactor behavior-preserving, floor-safe (gate only shortens; dedupe/screen/id-gate/reverify
 unchanged).]
- [open] :: **Council cross-lingual consensus (KO/EN agreeing panel)** — `hasCouncilConsensus` uses Jaccard token
 overlap, so a genuinely-agreeing KO+EN panel scores support ~0 -> falsely "diverged" -> wastes one bounded
 round (no floor violation; cap holds). Same CJK hazard family as fire-28's outlier screen. Needs an
 embedding-based cross-lingual similarity to fix both. (judge-flagged fire 31)
- [open] :: **Stabilize mcp playbook-store weighted-eviction test flake** — `playbook-store.test.ts:309`
 (recordPlaybookStrategy weighted eviction, added fire 27) times out at the 5000ms per-test default under
 full-suite parallel load; passes 1696/1696 in isolation. Raise the per-test timeout or reduce its async
 file-write count. (judge-flagged fire 31; same family as the cli chat-grounding concurrency flake)
- [done] :: ->Done **BKT weakness resolution — close the Whetstone loop** — the weakness ledger was append-only
 (nothing recorded a gap got FIXED), so `muse recap` nagged about already-remediated grounding gaps for
 30 days (arXiv:2105.00385 Bayesian Knowledge Tracing, pyBKT EDM'21). [DONE 2026-06-13, cognition loop
 fire 32: `WeaknessEntry.pKnown` BKT mastery estimate raised by the grounding gate's own SUCCESS verdicts
 (`muse ask` grounded non-action -> `recordWeaknessResolved`); `selectRemediableWeaknesses` drops mastered
 (pKnown≥0.95) entries. One grounded answer does NOT clear a weakness (needs 3 — slip/guess noise, pass^k
 spirit). Judge PASS: writer default-ON, reader = the selector recap reads, BKT math recomputed exact,
 both counterfactuals non-vacuous, answer path byte-identical, legacy entries unaffected.]
- [open] :: **Doctor weakness nudge uses a different selector** — `muse doctor`'s fuel/--weaknesses nudge calls
 `selectDevFixableWeaknesses` (DEV_FIXABLE_AXES excludes grounding-gap), so BKT mastery (fire 32) doesn't
 affect it, and doctor's raw `formatWeaknesses` inventory still lists mastered topics (honest dump, not a
 nag). If desired, apply `!isMasteredWeakness` to the doctor inventory view too. (judge-flagged fire 32)
- [open] :: **Whetstone resolution — remaining axes & decay** — fire 32 closed grounding-gap resolution only.
 Remainder: dev-axis resolution (clear `unbacked-action`/`wrong-tool` when the tool later succeeds);
 chat-path resolution (needs chat's wrong-value check as the success signal — chat has no grounded label);
 BKT+Forget P(F)>0 mastery decay for long-idle topics (pairs with fire 30's fade); surface the stored
 `hint` in the recap nudge line. (fire 32 remainder, arXiv:2105.00385)
- [done] :: ->Done **MemRL two-phase value-aware playbook retrieval** — `scoreStrategy` blended RAW unbounded
 token-overlap relevance with a bounded ±2.5 reward, so fire-27's Memp tallies vanished on verbose
 queries and leaked past relevance on sparse ones (arXiv:2601.03192 MemRL, Zhang et al. 2026). [DONE
 2026-06-13, cognition loop fire 33: two-phase `rankEligible` — Phase A relevance gates eligibility
 (relevanceOnly>minScore, k1=2·topK), Phase B z-score-normalized `0.5·rel̂+0.5·Q̂−reflected` re-ranks
 among candidates so utility can never lift an off-topic strategy into the prompt. scoreStrategy removed;
 both lexical + embed rankers rewired. Judge PASS via real revert: raw blend fails the verbose-include,
 sparse-exclude, and applyPlaybook-render tests. Selection-only, floor untouched.]
- [done] :: **Playbook recency-floor score-scale mix** — FIXED fire 58 (this exact bug): fillers now scored
 minSelectedScore−rank, strictly below every Phase-B pick. (judge-flagged fire 33 -> agent-core-cognition fire 58)
- [open] :: **MemRL remainder** — (a) Q-update EMA `Q ← Q + α(r−Q)` as an alternative to net tallies in
 adjustPlaybookReward; (b) close the bandit loop with automatic per-turn reinforcement from turn outcome
 (today reward writes are manual CLI + correction-decay only — the real cold-start fix); (c) λ sensitivity
 A/B (eval:playbook-rank) before tuning off the paper's 0.5; (d) tuned δ for the cosine channel.
 (fire 33 remainder, arXiv:2601.03192)
- [done] :: ->Done **Compaction-fidelity: salient detail retention** — conversation compaction dropped
 numbers/dates/decisions, duplicated the summary each round, and wiped a designed-but-dead StructuredFact
 field (arXiv:2511.17208 Zhou & Han, non-compressive detail retention). [DONE 2026-06-13, cognition loop
 fire 34: `salient-facts.ts` extracts VERBATIM NUMERIC/DECISION/ENTITY facts from user/assistant turns only
 (tool excluded), merges newest-wins into one `[Key details]` block in the compaction summary, and persists
 them instead of wiping. PROVABLY non-truncating: numeric = maximal-token-or-drop via a complete
 continuation-char set (digits∪separators∪scale-words∪Sino-Korean numerals, 4-way boundary guard); decision
 = fit-or-drop (no mid-sentence cut that would invert a Korean sentence-final negation). 5 adversarial judge
 FAIL rounds hardened the floor before PASS. Floor-strengthening (the chat number-value gate regains the
 true value post-compaction), additive, answer path byte-identical.]
- [open] :: **Faithful KO numeric parser for salient facts** — fire 34's regex extractor DROPS (safely) what it
 can't parse faithfully: Latin-unit numbers (`42 people`), and KO multi-segment compounds (`3억 5천만원` =
 350,000,000, space-separated). A real Korean numeral parser (arabic + hangul numerals 영일이…, compound
 scales 천/만/억/조, spacing) would extract these whole. Until then they're omitted, not truncated.
 (fire 34 remainder, arXiv:2511.17208)
- [open] :: **Compaction legacy-line dedup** — fire 34 deduped only the `[Key details]` block; the legacy
 "Tools kept / Recent user topics / [Pinned entities]" lines still accumulate one copy per compaction round
 in `buildCompactionSummaryText`. Strip-and-re-emit them the same way. (fire 34 remainder)
- [done] :: ->Done **RAG-Fusion compound-query retrieval** — headline `muse ask` embedded the question once, so a
 compound question blended between topics and dropped one answer chunk at topK=3 (half-answer/false-refusal
 on a fully-covered corpus). [DONE 2026-06-13, cognition loop fire 35: `splitCompoundQuery` deterministically
 splits KO/EN coordinated questions into 2–3 clauses (each ≥2 content tokens, else []); `diversifyAskChunks`
 fuses each clause's cosine ranking into the existing RRF (arXiv:2402.03367 RAG-Fusion). Pure selection over
 the user's own chunks — per-chunk score stays full-query cosine so confidence is never inflated; fail-open;
 byte-identical when not compound. Judge PASS via real revert (non-vacuity test fails when fusion ignored).]
- [open] :: **Fusion must-refuse verdict assertion** — `commands-ask-fusion.test.ts`'s must-refuse-compound case
 asserts only per-chunk score equality, not the `classifyRetrievalConfidence` verdict (the judge verified the
 verdict invariant manually; it's deterministic given unchanged scores). Add the explicit `verdict` assertion
 for defense-in-depth. (judge-flagged fire 35, low priority)
- [open] :: **RAG-Fusion remainder** — (a) LLM-backed decomposition (full RQ-RAG, arXiv:2404.00610) for implicit
 compounds the deterministic splitter misses, gated like chat's `needsContextualRewrite`; (b) port the
 knowledge-recall second-hop PRF to the headline ask path for sequential bridge-entity questions; (c) extend
 the multi-hop A/B battery with compound-question joint@K cases to measure the live delta. (fire 35 remainder)
- [decision] :: **Council hand-off injection quarantine — DEFERRED on detector calibration (fire 36)** — the
 MECHANISM is sound and was built + judge-confirmed (screenCouncilInfection at the council hand-off,
 fail-close all-infected->null, non-inert on the live `muse swarm council` path, cuts the Prompt-Infection
 self-replication channel before the round-2 debate digest / synthesis — arXiv:2410.07283 Lee & Tiwari
 2024). The BLOCKER is detector CALIBRATION: reusing `@muse/policy`'s `sharedInjectionPatterns` (tuned for
 hostile USER input) to screen fluent MODEL reasoning over-quarantines honest/dissenting peers — across 4
 adversarial judge rounds, FPs surfaced in `environment_extraction` (`env` in "envision"), `credential_extraction`
 (`token`+"give"), `prompt_override` (bare "from now on"), `sandbox_escape` ("without an approval check"),
 `cross_user_access` ("another" matches unanchored `other`), `training_data_extraction` ("print internal
 context"), and `role_override`'s debug-mode subpattern ("enable debug mode for this test"). Over-quarantine =
 silently dropping an honest peer = unacceptable (corrupts deliberation, subtle censorship). Whack-a-mole on
 subpatterns did not converge (each round found a new FP). PATH FORWARD (dedicated slice): build a council-LOCAL,
 prose-safe pattern set anchored to literal-attack token SEQUENCES (not single common words), empirically
 calibrated against a LARGE corpus of (legitimate model reasoning, genuine injection) pairs; the survived-all-4-rounds
 clean families are a starting core (korean_role_override, korean_prompt_extraction, multilingual_prompt_leak,
 punctuation_obfuscation, tool_spoofing, few_shot_poisoning, history_poisoning, command_injection, plus role_override
 MINUS its debug-mode subpattern, system_delimiter for literal control tokens). Reuse the screenCouncilInfection
 mechanism design (it passed). (fire 36 deferred — mechanism done, calibration is the work.)
- [done] :: ->Done **ISR-LLM pre-execution plan validation + repair** — the runtime plan gate validated only
 step-count + tool-registered, not arguments, so a plan with a later missing-arg step executed earlier
 (possibly writing) steps first -> partial side effects + dead run (arXiv:2308.13724 ISR-LLM). [DONE
 2026-06-13, cognition loop fire 37: `validatePlan` gains `toolSchemas` and flags missing-required-args
 (reusing validateRequiredToolArguments/coerceToolArguments at plan time) + exact-duplicate steps;
 `dedupeExactSteps`; `streamPlanExecute` dedupes -> validates -> one verifier-backed repair round
 (PLAN_REPAIR_MAX_ROUNDS=1, re-call generatePlan with the validator errors, re-validate) -> else throws.
 Judge PASS via real revert (no-partial-side-effects test fails 6 ways without the arg-check); registered
 in reflection-guard. Validation runs before any tool executes; back-compat preserved.]
- [open] :: **Plan-validation remainder** — (a) `plan-repaired` PlanExecuteStreamEvent so eval:plan-quality/traces
 can count runtime repair rate (deferred — strict event union needs downstream changes); (d) plan-cache
 hygiene — cache the REPAIRED plan, never the invalid original.
 (fire 37 remainder, arXiv:2308.13724) — NEW sub-items from fire 8: (e) tighten the still-open false-negative
 classes (bare `$N` and bare `{{N}}` dropped as currency/template-ambiguous -> undetected); (f) wire backward-ref
 SUBSTITUTION (LLMCompiler Task Fetching Unit — resolve `{{step1.output}}` to the prior step's output, not just validate);
 (g) extend write-precondition to non-string args (empty array / `{}` on a write — fire 21 covered string args).
- [done] :: Plan-validation remainder (b) ordering/dependency validation — agent-core-cognition fire 8
- [done] :: Plan-validation remainder (c) write-step precondition checks (ISR-LLM arXiv:2308.13724) — a write/execute step with an unfilled-placeholder arg is rejected before any tool runs (no partial side-effect) — agent-core-cognition fire 21
- [done] :: Playbook staleness re-probation gate (SSGM arXiv:2603.11768) — a once-reinforced strategy gone cold (>120d, sparse) is withheld from injection until re-reinforced — agent-core-cognition fire 22
- [done] :: Correction-distillation gist gate (SIB arXiv:2603.01455 + ReasoningBank 2509.25140) — a near-verbatim restatement of the correction (cosine ≥0.92) is dropped before playbook promotion, completing the support gate into a [0.50,0.92) grounded-AND-abstracted band — agent-core-cognition fire 23
- [done] :: Episodic near-duplicate consolidation-merge (Mem0 arXiv:2504.19413) — a near-identical lower-ranked episode (cosine ≥0.92) is collapsed before the CAR cutoff so a distinct episode advances into the freed recall slot — agent-core-cognition fire 24
- [done] :: Council cross-peer echo collapse (Talk-Isn't-Cheap arXiv:2509.05396 + MAST 2503.13657) — distinct peers emitting identical reasoning are collapsed (after the outlier screen, before synthesis) so a Sybil/echo can't double-weight a voice or inflate the consensus label — agent-core-cognition fire 25
- [done] :: Playbook pessimistic Wilson-LCB ranking (PEVI arXiv:2012.15085) — strategies rank by the lower confidence bound (point − uncertainty), so a proven strategy outranks a lucky-but-thin one; avoidance gate structurally isolated (keys on clampReward, not the LCB) — agent-core-cognition fire 26
- [done] :: Plan-cache retrieval-exemplar toolset-fit gate (RAP arXiv:2402.03610) — a cached plan referencing a tool not registered in the current turn is withheld as a cache miss, so a stale exemplar can't seed an unbuildable plan that fails validation and burns the repair round — agent-core-cognition fire 27
- [done] :: Correction seed-informativeness gate (NEMORI arXiv:2508.03341) — a contentless correction (all-marker-no-directive: "no", "별로야", "redo") no longer seeds a confident grounded playbook strategy (short-circuits before the model call) — agent-core-cognition fire 28
- [open] :: **Correction-informativeness remainder** — (a) tune DIRECTIVE_RESIDUAL_FLOOR (2) on a real correction corpus (a single-content-token directive like "no, table" is currently dropped — subtractive + re-correctable so safe, but a tuning param); (b) semantic informativeness signal (embed correction vs marker-only baseline) if token-residual proves too coarse; (c) parity gate on the detectApprovals/inferPreferenceFromCorrection twin. (fire 28 remainder, arXiv:2508.03341)
- [open] :: **Plan-exemplar fit remainder** — (a) extend the fit-check to step ARGS (a passing exemplar can still reference a stale entity id / miss a required arg under the current schema — surfaces at validatePlan's arg-check, not this gate); (b) emit a plan-exemplar-rejected stream event for eval:plan-quality telemetry (deferred — strict event-union change); (c) live A/B: does toolset-fit filtering raise one-shot plan validity on the plan-quality battery. (fire 27 remainder, arXiv:2402.03610)
- [open] :: **Playbook LCB-ranking remainder** — (a) tune PLAYBOOK_PEVI_LAMBDA / Wilson z (1.96 default) on a real reinforcement corpus via eval:playbook-rank A/B (pessimism strength is a principled default, not empirically fit); (b) `effectiveStrategyReward` is now dead production code (only the test point-estimate oracle / revert-target uses it) — remove or mark test-only; (c) carry the LCB into the @muse/recall non-embed selectPlaybookSection path (concurrent-owned, defer). (fire 26 remainder, arXiv:2012.15085)
- [open] :: **Council echo-collapse remainder** — (a) 불가 WONTFIX/INERT (agent-core-cognition fire 55): wiring collapseEchoUtterances into the `hasCouncilConsensusSemantic` early-exit gate is INERT — that gate is EVERY-member (`supports.every(s => s >= agreeAt)`), so a single dissenter already blocks agreement and collapsing IDENTICAL echoes can never raise a member above the floor or flip the agreed/diverged verdict (verified: an echo-panel test passed both with and without the collapse). The 1524(a) premise (a duplicated panel inflates consensus -> premature stop) assumed a MEDIAN/majority gate; under the every-member gate it cannot. Do NOT re-attempt (a). (b) near-duplicate semantic echo collapse still open but needs the deferred live KO/EN battery. (fire 25 remainder, arXiv:2509.05396)
- [open] :: **Episodic consolidation remainder** — (a) tune EPISODIC_CONSOLIDATION_THRESHOLD (0.92, Mem0 constant) on real nomic-embed distributions; (b) text-concatenation merge (carry the lower-ranked dup's complementary detail into the kept slot — Mem0's full UPDATE, LLM-free string merge — vs the current slot-freeing-only collapse); (c) a robust assembled-path discriminator that isolates consolidation from lateral-inhibition (currently geometrically fragile: CAR's cliff floor proj×0.5 and a dup's inhibited score proj−0.5·cos are close at cos≈0.92-1.0; the isolated binding is carried by the pure-helper counterfactual). (fire 24 remainder, arXiv:2504.19413)
- [open] :: **Distillation gist-gate remainder** — tune DEFAULT_STRATEGY_VERBATIM_CEILING (0.92) on real nomic-embed distributions (chosen from synthetic fixtures; a short correction's valid concise generalization could score ≥0.92 and be dropped — subtractive + re-distillable so safe-direction, but untuned); calibrate against eval:self-improving / verify-pattern-suggestion. (fire 23 remainder, arXiv:2603.01455)
- [open] :: **Playbook staleness-gate remainder** — tune PLAYBOOK_STALE_AFTER_DAYS (120) + the tally<3 sparsity bar on real reinforcement-interval data (chosen from SSGM framing + synthetic fixtures; a rarely-triggered useful/seasonal strategy could be withheld until re-reinforced — reversible + re-distillable so safe-direction, but untuned). Optionally a `muse doctor` "N strategies withheld as stale" surface. (fire 22 remainder, arXiv:2603.11768)
- [done] :: Playbook temporal reward discounting (Discounted-UCB arXiv:0805.3415) — agent-core-cognition fire 9
- [open] :: **Playbook recency-discount remainder** — (a) carry recency anchors into the `@muse/recall` non-embed
 `selectPlaybookSection` path too (this slice scoped to the agent-runtime applyPlaybook path); (b) tune
 PLAYBOOK_RECENCY_HALF_LIFE_DAYS (30) via A/B vs the daemon's 30-day decay step. (fire 9 remainder, arXiv:0805.3415)
- [done] :: Playbook recency-discount remainder (c) wire nowMs into the cli embed-rank path (+extract testable module) — agent-core-cognition fire 10
- [done] :: JUDGE-DRILL (firesSinceDrill≥10): injected inert reinforcementVelocity -> independent Opus judge correctly FAILed it -> rolled back — agent-core-cognition fire 10
- [done] :: a2a council per-peer straggler timeout (MAST arXiv:2503.13657 termination) — hung peer no longer blocks the whole council — agent-core-cognition fire 11
- [done] :: Commitment semantic near-duplicate collapse (SemDeDup arXiv:2303.09540) — daemon no longer schedules duplicate check-ins for one loop — agent-core-cognition fire 12
- [done] :: Set-level semantic sufficiency advisory (Sufficient Context arXiv:2411.06037) — multi-part ask names the uncovered part instead of fabricating it — agent-core-cognition fire 13
- [done] :: Outcome-conditioned plan-cache storage (Agent Workflow Memory arXiv:2409.07429) — cache records only succeeded steps, never teaches the model a failed tool sequence — agent-core-cognition fire 14
- [open] :: **Plan-cache exemplar-quality remainder** — (a) live A/B: does success-filtering raise one-shot plan validity? (plan-quality battery, needs a live eval); (b) annotate per-step success in renderPlanExemplar for a richer exemplar signal. (fire 14 remainder, arXiv:2409.07429)
- [open] :: **Context-sufficiency remainder** — (a) tune coverAt (0.55=DEFAULT_CONFIDENT_AT) on a REAL nomic multi-part corpus (tests use synthetic orthogonal vectors; real-world discriminating power unproven); (b) feed coveredFraction into classifyRetrievalConfidence as a set-level demotion (confident->ambiguous when insufficient) — a GATING change, needs its own floor proof; (c) wire the advisory into the `muse chat` grounding path (chat-grounding.ts), currently ask-only. (fire 13 remainder, arXiv:2411.06037)
- [open] :: **Commitment dedup remainder** — (a) tune COMMITMENT_DEDUP_COSINE (0.86) on a REAL nomic-embed-text-v2-moe corpus (current tests use synthetic stub vectors; the threshold's discriminating power is unproven on real embeddings — A/B like eval:embedder-ab); (b) wire collapseNearDuplicateCommitments into the chat-ink.ts recap-count path (currently over-counts open loops) and the `muse commitments scan` list; (c) staleness/expiry pass for old commitments + cross-session dedup vs already-tracked tasks. (fire 12 remainder, arXiv:2303.09540)
- [open] :: **a2a council timeout remainder** — (a) wire an env override `MUSE_A2A_COUNCIL_TIMEOUT_MS` (needs A2AEnv widened in transport.ts) + thread `timeoutMs` through the commands-swarm requestReasoning closure; (fire 11 remainder)
- [done] :: Council consensus-weighted contributor ordering (Roundtable Policy arXiv:2509.16839) — highest-consensus reasoning leads the synthesis prompt — agent-core-cognition fire 15
- [done] :: Plan-step normalized near-duplicate collapse (Mem0 arXiv:2504.19413) — case/whitespace/numeric-format duplicate steps no longer waste budget or double-act a write — agent-core-cognition fire 16
- [done] :: Playbook small-bank injection-time near-duplicate suppression (arXiv:2510.17940 + MMR 2502.09017) — same-lesson paraphrases no longer both injected on the common ≤topK path — agent-core-cognition fire 17
- [done] :: Episodic-recall adaptive cluster-transition cutoff (CAR arXiv:2511.14769) — episodic recall cuts a low-relevance tail at a sharp cliff instead of always padding to topK — agent-core-cognition fire 18
- [done] :: Council weak-consensus advisory (ConfMAD arXiv:2509.14034, guardrail 2511.07784) — surfaces "the council barely agreed" instead of emitting a low-consensus synthesis silently — agent-core-cognition fire 19
- [done] :: Council consensus-floor correct-by-construction + fire-19 caveat (a) MOOT — agent-core-cognition fire 20 [councilMemberSupportsSemantic never throws (per-member catch -> support 0) -> the fallback catch is unreachable and the cosine floor was already always correct on the embed path; refactored to tie supportFloor to the realised support computation anyway]
- [done] :: JUDGE-DRILL (firesSinceDrill≥10): injected a floor-weakening plant (weak-consensus -> suppress the answer, violating advisory-only / consensus≠truth) -> independent Opus judge correctly FAILed it -> rolled back — agent-core-cognition fire 20
- [open] :: **Council consensus-advisory remainder** — tune the two floors (0.5 cosine / 0.16 Jaccard, reused from ReConcile) on a real council support distribution (needs a live KO/EN council battery; smoke:live stalls). (fire 19 remainder (b), arXiv:2509.14034)
- [open] :: **Episodic adaptive-cutoff remainder** — (a) tune EPISODIC_CLUSTER_DROP_RATIO (0.5, conservative ≥50%-cliff-only — 33% drops survive) on a real episode corpus; (b) measure the live recall benefit against real nomic embeddings (the assembled test isolates the cutoff with hand-built orthogonal vectors; real-embedder behavior unmeasured); (c) CAR's full clustering variant (k-means/silhouette over the score vector) vs this single-transition approximation. (fire 18 remainder, arXiv:2511.14769)
- [open] :: **Playbook injection-dedup remainder** — (a) tune PLAYBOOK_INJECT_DEDUP_THRESHOLD (0.8) on a real strategy corpus (chosen from token math, not empirical); (b) semantic-embedding dedup to catch cross-lingual / heavily-reworded paraphrases the Jaccard signal misses (async/latency tradeoff vs the sync per-turn path); (c) the sibling recency-floor score-scale-mix ordering fix (backlog "Playbook recency-floor score-scale mix"). (fire 17 remainder, arXiv:2510.17940)
- [open] :: **Plan near-dup collapse remainder** — (a) if a case-SENSITIVE-identifier write tool is ever added to plan-execute (e.g. write_file{path}), drop case-folding for that field (trim+numeric only) — today's write tools are all NL content so case-folding is safe; (b) the genuinely-semantic case (different words, same intent) -> embedding cosine, a separate higher-floor-risk slice; (c) feed the near-dup collapse count into a plan-deduped stream event for eval:plan-quality. (fire 16 remainder, arXiv:2504.19413)
- [open] :: **Council ordering remainder** — (a) live eval: does consensus-ordering improve gemma4's synthesis quality? (ordering is wired + order-only; the 8B quality delta is the paper's hypothesis, unmeasured here); (b) surface per-utterance support as a `[peerId|conf=0.82]` prompt annotation (richer signal, risk-bearing); (c) council-level "weak consensus" advisory when top support < floor. (fire 15 remainder, arXiv:2509.16839)
- [done] :: ->Done **Self-consistency consensus for the grounding reverify judge** — the live default-on
 `verifyGroundingWithReverify` decided weak->grounded upgrades on a SINGLE high-variance judge sample
 (arXiv:2510.27106 Rating Roulette: LLM judges "almost arbitrary in the worst case"). [DONE 2026-06-13,
 cognition loop fire 38: `judgeConsensus` (unanimous fail-close, length>0 && every-YES) + `reverifySamples`
 (clamp 1–5, default 1) k-sample the judge in all 3 branches; CLI live sites pass k=3 (arXiv:2203.11171
 Self-Consistency). Strictly more conservative — can only convert a single-sample PASS->FAIL on disagreement,
 never admit a new grounded verdict (judge PASS, proven across all 3 branches via real revert). Fabrication=0
 strengthened; default-1 byte-identical back-compat.]
- [open] :: **Reverify consensus remainder** — (a) CI-SC confidence-weighted early-exit consensus (arXiv:2511.12309)
 to cut samples once the outcome is decided; (b) extend k-sample consensus to the `--verify-claims` per-claim
 judge (`verifyGroundingPerClaim`, same single-sample shape); (c) adaptive k by band width (wider weak margin
 ⇒ more samples). (fire 38 remainder, arXiv:2510.27106 / 2203.11171)
- [decision] :: **Council question-relevance gate — DEFERRED on lexical-signal unfitness (fire 39)** — the MECHANISM
 is sound (screenOffTopicUtterances inside synthesizeCouncilAnswer, deny-only, majority-cap, fail-open,
 cross-script guard, non-inert + judge-confirmed live on the synthesis prompt path; MAST FM-2.3/FM-3.2,
 arXiv:2503.13657). The BLOCKER is the SIGNAL: a lexical question↔reasoning token-overlap false-drops honest
 SAME-SCRIPT paraphrase/synonym peers (judge: 5/5 realistic on-topic KO+EN peers dropped; the damning case —
 a correct paraphrase "임대료 125만원" dropped while a literal-echo peer with the WRONG number "월세 130만원"
 kept, because it mimicked surface tokens). Korean agglutinative tokenization makes synonyms share 0 tokens by
 construction. Dropping an honest/dissenting voice is a real harm even though downstream gates protect
 fabrication=0. The cross-SCRIPT case is already guarded (dominantScriptFamily) but same-script paraphrase is not.
- [done] :: ->PARTIAL **ROOT-CAUSE semantic-similarity primitive for the council path** — [DONE peer↔peer half,
 2026-06-13 cognition loop fire 40: `councilMemberSupportsSemantic` (mean pairwise embedding cosine) replaces
 Jaccard token-overlap in `screenCouncilOutliers` when an embedder is injected (arXiv:2507.14649 Cleanse);
 embedder wired into the live `muse swarm council` synthesis path; COSINE_ABS_FLOOR=0.4; fail-open to Jaccard.
 This UNBLOCKS the two deferred council screens — the embed seam + cosine-support primitive now exist on the path.]
 REMAINING follow-ons (now thin, reuse the primitive):
- [done] :: ->Done **fire-39 question-relevance gate, semantic version** — [DONE 2026-06-13 cognition loop fire 41:
  `screenOffTopicUtterancesSemantic` (cosine question↔reasoning < QUESTION_RELEVANCE_FLOOR=0.3) in
  synthesizeCouncilAnswer; semantic cosine keeps KO-paraphrase + cross-lingual on-topic peers (fixes the
  fire-39 lexical false-drop), drops genuine off-topic; deny-only, fail-open, no lexical fallback. Judge PASS
  via real revert. Backlog: tune floor on live KO/EN battery; strengthen the CLI assembled-path test (vacuous
  on revert — masked by downstream consensus-outlier; the agent-core reason==='off-topic' test is the clean proof).]
  - · **fire-36 injection-quarantine, re-scoped** — semantic-divergence signal or a council-local prose-safe detector
  instead of the chat-guard lexical patterns.
  - · **semantic hasCouncilConsensus (fire 31)** — fire 40 left consensus on Jaccard; give it cosine support too (cosine-calibrated agreeAt).
- [done] :: **discriminating cross-lingual fix test** — DONE fire 59: a 5-peer mixed EN/KO panel (3 EN + legit KO + deceptive KO) with a multilingual-embedder stub proves screenCouncilOutliers' semantic precomputedSupports KEEP the legit ko-peer that lexical Jaccard excludes, while still quarantining the deceptive one; revert-proof reds exactly this test. — agent-core-cognition fire 59
  - · **tune COSINE_ABS_FLOOR on a live KO/EN council battery** — 0.4 is a best-guess default (smoke:live stalls; unvalidated on real nomic distributions). (fire 40)
- [open] :: **Reflection-schedule guard** — one test enumerating retry/reflection call-sites, asserting
 each is verifier-backed (85.36% same-mistake repetition without one, arXiv 2510.18254). (T1-10)
  - (queued behind fuel/prereqs: sleep-time compute · Mem0 UPDATE op · AWM workflow mining ·
 conformal factuality back-off · Bayesian-surprise digest ranking (SDT half SHIPPED — see Done))
  - 불가 blocked, recorded: SEPs / DoLa / contrastive decoding (need hidden states / decode-time
 intervention; Ollama logprobs are observational only).

## Open — agent-performance levers (ranked research pass 2026-06-10)

Full ranked list + sources: [`docs/strategy/agent-performance-levers.md`](../strategy/agent-performance-levers.md).
Levers #1 (multilingual embedder, SHIPPED — KO hit@1 50%->100%), #3 (KV posture + prefix
ordering, SHIPPED) and #2's mechanism+measurement are in Done below. Next from the list:

- [open] :: **Tool-exemplar production wiring — gated on real-trace failures** — the mechanism
 (`selectToolExemplars`/`renderToolExemplarSection`) + the eval:tools A/B arm shipped; the
 golden set is near-saturated, so the lift must be demonstrated on REAL failing prompts.
 When labeled traces accumulate misses, extract an exemplar bank from successful traces and
 wire injection into the runtime tool path; promote on a measured eval:tools + replay win.
- [open] :: **Local reranker on recall top-8** (lever #4) — Ollama has no rerank API; yes/no-logit
 workaround, flag-gated, A/B on the embedder-ab corpus + grounding battery.
- [open] :: **`format` constraint on the non-reverify judge paths** — reverify judge DONE (see Done);
 remaining: llmJudge (eval-harness), correction-polarity, preference-inference.
- [open] :: **source-trust live battery** — the marker + trusted bit shipped (see Done); remaining: a
 live `--with-tools` battery asserting the external-provenance heading appears on a
 web-grounded answer and NOT on a notes-grounded one.
  - 불가 rejected this refill: "expose `muse notes graph/links`" (ALREADY exist — the -rag split
 trap again); "desktop lazy index load" (FALSIFIED — no startup parse); "REPL query-embedding
 cache" (near-zero hit rate; the real latency lever was prefix reuse, now shipped).

## Open — grounding edge (the maintained floor -> frontier)

- [open] 2026-06-09 :: **(follow-up) SQuAD drift arm — STABILIZE before optimizing** — a fire (2026-06-09)
 TRIED the obvious sharpen (pick drift answers with NO lexical overlap so coverage fully
 fails) and it made Δ WORSE: +0.63 -> +0.13 (gate-ON catch 5/8 -> 1/8). Reverted. The real
 finding: the SQuAD drift catch is HIGH-VARIANCE — the gate-ON path runs verifyGroundingWithReverify
 (a stochastic gemma reverify), so a single-run Δ on 8 cases is not stable, and the lexical-coverage
 hypothesis does not dominate the catch. So the right next step is STABILITY first: run the SQuAD
 arm at MUSE_EVAL_REPEAT≥3 (pass^k) and/or grow to 20-30 cases to get a stable number, THEN optimize.
 (Rejected: the disjoint-drift sharpen, as an unverified — in fact negative — win.)
- [decision] 2026-06-10 :: ->[done] **Source-trust segregation — DECIDED 2026-06-10 (option B, per the standing
 decide-and-do directive) and the core shipped** (see Done): tool-derived citations live on the
 VerifiedSource/response-filters path, so the provenance marker went THERE (the sources block
 heading now names itself external/tool-fetched), plus `trusted:false` on the ask path's tool
 evidence so `groundedOnUntrustedOnly` has real input. Remaining: the live battery (Open above).
 Original framing kept below for context:
 `KnowledgeMatch.trusted` provenance bit + the pure detector `groundedOnUntrustedOnly` (flags a
 grounded answer resting ONLY on untrusted sources), agent-core, 4 tests. REMAINING — RE-SCOPED
 2026-06-09 (a fire found the naive wiring target wrong): tool-output does NOT become a
 `KnowledgeMatch` — it produces `VerifiedSource` (tool-output-evidence.ts) consumed by the
 response-filters path, SEPARATE from the grounding evidence set (`KnowledgeMatch` today comes only
 from the user's own notes, i.e. always trusted). So `groundedOnUntrustedOnly` has no untrusted input
 in the CURRENT graph — it is a forward-looking guard. Correct sub-slices: (1) DECIDE the design —
 merge tool-output INTO the grounding set with `trusted:false` (architectural), OR mark trust on the
 VerifiedSource/response-filters path where tool-derived citations actually live; (2) surface a marker
 when a cited claim rests only on untrusted provenance; (3) a live battery. Start with (1)'s decision.
 Below is the original framing (kept for context):
 NAMED (see Done: grounded-not-true.test.ts locks that a false-but-source-supported answer
 is "grounded", while a fabricated citation is still caught). The user's OWN false note is
 unfixable by design ("it's yours"), but an UNTRUSTED source (hostile/allowlisted MCP
 tool-output, per architecture.md) being treated as ground-truth IS fixable. Slice: tag
 evidence provenance (user-note vs tool-output) through the recall->gate path and surface a
 distinct verdict/marker when a grounded answer rests ONLY on untrusted tool-output, so the
 user knows the citation is not their own data. Source-veracity is impossible on a fixed 12B;
 source-TRUST segregation is not. (tool-output-evidence.ts already treats tool output as
 untrusted — thread that signal into verifyGrounding's evidence set.)
- [open] :: **(follow-up) measure --best-of's answered-rate lift on a drift-prone corpus** —
 the mechanism shipped (see Done 2026-06-10) but its LIVE adoption path never fired in 3
 adversarial attempts (gemma4 + the gate are robust enough that a natural first-draft
 verdict failure is rare on a clean corpus — itself a positive finding). When labeled
 `ungrounded` traces accumulate from real usage, replay those queries with --best-of 3
 and report the adoption rate; promote the flag to default-on only with that number.

## Open — dev-loop fuel & measurement (makes the loop compound)

- [open] :: **(follow-up) outcome labels for the remaining cli.local surfaces** — `muse ask` now
 labels every trace (see Done 2026-06-10); still `grounded:null`: ask `--json` mode and
 `--image` (the verdict doesn't run there by design), and `muse chat --local` (the chat
 gate is the sync NUMBER-only check, a different verdict shape). Label chat-local when
 the error-analysis fuel from ask proves insufficient — don't build ahead of need.
- [decision] :: **`error-analysis.mjs` — cluster `.muse/runs` failures into a ranked taxonomy**
 — the missing ANALYZE half. BLOCKED on the instrumentation above (no labels = no
 Pareto; clustering a passing-looking corpus with the same 8B is maker=judge theater).
 Defer until ~20-30 real labeled failures exist. Source: eval-driven-dev research
 (Husain/Yan; Google "every user report -> permanent test case").
- [open] :: **Split the eval scoreboard into TRAJECTORY vs FINAL-RESPONSE axes** (Google ADK:
 EXACT/IN_ORDER/ANY_ORDER match modes + separate final-response score) so a regression
 localizes to path-vs-answer. Pure refactor of `scripts/eval-harness.mjs`.
- [done] :: ->Done **`hallucinations_v1`-style per-sentence groundedness** — finer than the answer-level
 gate: labels each sentence supported/unsupported so the fuel names WHICH sentence was
 un-groundable. Source: Google ADK eval criteria.
 [DONE 2026-06-12, cognition loop fire 5+6: labeler + LIVE-wired into the ask grounding-gap
 fuel HINT. fire 6 added `worstUnsupportedSentence` + wired it so a grounding-gap weakness
 records the worst un-groundable sentence as its ledger `hint`. LIVE-PROVEN on the assembled
 CLI: "광합성 화학 반응식" -> hint named the exact ungrounded formula sentence; abstains ->
 hint named the refusal sentence. Realized via the real-usage weakness-fuel path (better than
 the originally-imagined eval:self-improving surface); "contradictory" label (NLI) stays deferred.]
 — [fire 5] the LABELER shipped:
 `reportSentenceGroundedness(answer, evidence, floor?)` in `@muse/agent-core`
 (`sentence-groundedness.ts`) — pure, reuses the gate's `lexicalTokens` + the
 `splitPreservingSentencePunctuation` splitter; per-sentence supported/unsupported by
 token-coverage ≥ floor (0.5), reports unsupportedCount + unsupportedFraction. Diagnostic
 only (no gate verdict changed). 9-case battery. NEXT: WIRE into eval:self-improving's
 report so a miss names the sentence; "contradictory" label needs NLI (non-deterministic,
 deferred — supported/unsupported is the deterministic core).

## Open — dev-loop hardening (from the 2026-06-08 will-it-work review)

- [open] :: **Extend `groundedCases` to ALL battery corpora** — the `groundedCases` ratchet
 SHIPPED for the grounding corpus (see Done: a dropped case there now fails self-eval).
 Remaining: extend the count to the other golden sets (eval:tools, adversarial, plan-quality)
 whose cases live in their own files, so a dropped case in ANY battery regresses. Source: must-fix #3.
- [open] :: **Backlog refill is the autonomy ceiling** — write-back records the provenance of
 the consumed item but does NOT mint net-new actionable work, so autonomy lasts ~the
 seed length (~7 fires) then degrades to gap-scout. The durable refill is error-analysis,
 which is BLOCKED on trace outcome-logging (the fuel accrues from Jinan USING Muse, not
 from dev fires). Not a single slice — a standing truth: when OPEN runs low, a refill
 fire (gap-scout or a human direction) is itself the work. Source: review honest-ceiling.

## Open — agent core

- [done] 2026-06-13 :: ->Done **Council consensus-outlier screen (MoA deception robustness, arXiv:2503.05856)** — [2026-06-13,
 cognition loop fire 28, PAPER-GROUNDED, Fable scout+judge] An A2A council peer is an EXTERNAL untrusted
 agent; a deceptive/off-topic peer's reasoning flowed straight into `synthesizeCouncilAnswer`'s synthesis
 prompt and the reverify judge then PASSED it (the lie IS the cited evidence — GROUNDED≠TRUE at the
 council hand-off). Added pure `screenCouncilOutliers` (per-member mean pairwise Jaccard support over
 CJK-aware `lexicalTokens`; quarantine below absFloor AND relFloor×median, panel≥3, majority-preserving
 cap floor((n-1)/2)), run inside `synthesizeCouncilAnswer` after dedupe (prompt + validPeerIds from `kept`;
 `CouncilAnswer.excludedPeers`). Subtractive on untrusted input; reverify/id-gate/floor unchanged.
 Scout avoided the DEAD `orchestrateAnswer` seam (zero prod callers) -> wired the LIVE council. Fable judge
 FAILed v1 (inline `\w+` tokenizer ASCII-only -> broken for Korean, Muse's primary language: deceptive
 Korean peer never screened) -> fixed to CJK-aware `lexicalTokens` + jaccard(∅)->0 + Korean tests
 (counterfactual: 9 tests fail on the old tokenizer). agent-core 1815 green.
- [open] :: **Council screen: cross-lingual similarity** — the fire-28 outlier screen uses lexical Jaccard, so a
 legitimate minority-LANGUAGE peer among a different-language majority has structurally-0 token overlap and
 is wrongly quarantined (documented limitation). Homogeneous-language panels (the common case) + the
 security-critical deceptive-peer case work. FIX needs an embedding-based cross-lingual similarity fallback
 (or a script-disjoint exception) — deferred (needs the embedder at the council seam).

- [done] 2026-06-13 :: ->Done **Evidence-tallied playbook lifecycle (Memp, arXiv:2508.06433)** — [2026-06-13, cognition
 loop fire 27, PAPER-GROUNDED, Fable scout+judge] Playbook reward was a clamped NET scalar that
 conflated "never used" with "used 10× / 5↑5↓"; deprecation needed a near-pure losing streak;
 probation graduated on a single net-positive bump. Applied Memp's update regimen (public preprint;
 reimplemented): per-entry outcome TALLIES (`reinforcements`/`decays`) + `wilsonInterval` +
 `effectiveStrategyReward` (evidence-damped; legacy-identical without a tally) + `planStrategyLifecycle`
 (deprecate when wilsonUpper<0.4 & n≥5; graduate when probation & wilsonLower>0.5 & n≥3). Wired
 END-TO-END: `adjustPlaybookReward` (store) writes the tallies; the 4 production projections
 (`buildPlaybookProvider` + 3 commands-ask mappers) now CARRY them; `scoreStrategy`/`isAvoidedStrategy`/
 `isInjectableStrategy` consume them on the live `applyPlaybook` ranking path. Fable judge FAILed v1
 (the lifecycle was INERT — projections stripped the tallies) -> completed the wiring + an assembled-path
 test (confident-bad {0,8} excluded THROUGH the real provider; counterfactual proves the stripped
 projection let it through). Playbook = prompt-ranking only (floor untouched). agent-core 1805 + autoconfigure 509 + cli 2528 green.

- [done] 2026-06-13 :: ->Done **Multi-aspect verifier vote on the MoA fallback (BoN-MAV, arXiv:2502.20379)** — [2026-06-13,
 cognition loop fire 26, PAPER-GROUNDED, Fable scout+judge] When the MoA aggregator threw/returned empty,
 `orchestrateAnswer` blindly picked the `"thorough"` proposal — even if off-topic while another was on-point;
 no candidate was ever verified ("Bo-n" without "MAV"). Applied BoN-MAV (public CC-BY; reimplemented): NEW
 `verifier-vote.ts` — `aggregateVerifierVotes` (binary aspect votes, AggScore=approvals/count, argmax,
 deterministic tie-break, NaN-guarded) + `DEFAULT_ASPECT_VERIFIERS` (on-topic/substantive/non-hedging —
 relative ranking, NEVER abstains). Wired into the aggregator-failure fallback only (happy path byte-identical;
 no grounding/citation/abstention semantics touched). Fable judge PASS — reverted-to-HEAD proved the delta
 non-vacuous (off-topic thorough vs on-topic skeptic -> skeptic). agent-core 1786 green.

- [done] 2026-06-13 :: ->Done **Associative recall via Personalized PageRank (HippoRAG 2, arXiv:2502.14802)** — [2026-06-13,
 cognition loop fire 25, PAPER-GROUNDED, Fable scout+judge] Muse recall was isolated (cosine+BM25+ACT-R)
 with zero graph/spreading-activation structure. Applied HippoRAG 2 (public ICML 2025 preprint;
 reimplemented, no code copied): NEW `packages/agent-core/src/associative-recall.ts` — `buildNoteLinkGraph`
 (undirected weighted note graph, edge weight Σ 1/df(sharedToken), df===N excluded) + `personalizedPageRank`
 (deterministic power iteration, damping 0.5, dangling->teleport, mass-conserving). Wired opt-in into
 `rankKnowledgeChunksWithHop` (`associative?` flag): seed PPR with primaries, append top **PPR>0**
 graph-reachable bridges via the fire-22 query-relative-cosine fail-safe path (max-2, primaries
 byte-identical, flag-off no-op). Floor-safe (no verdict change). Fable judge FAILed v1 (missing PPR>0
 floor -> appended unrelated PPR-0 notes; vacuous integration test) -> remediated (PPR>0 floor + a
 non-vacuous test: bridge absent flag-off / present flag-on via the token chain / unrelated excluded,
 counterfactual-verified). agent-core 1772 green. NEXT: synonym edges + wire into CLI ask after a live multi-hop battery.

- [done] 2026-06-13 :: ->Done **No needless judge escalation on sentence-opener connectives** — [2026-06-13, cognition loop
 fire 24, Fable-scout runner-up] `answerAssertsUnsupportedValue` flagged sentence-initial capitalized
 connectives ("However"/"Based"/"Therefore"/"Additionally", all absent from LEXICAL_STOPWORDS) as
 named entities -> a needless value-escalation judge pass (wasted local inference) whenever an answer
 opened a sentence that way. Added `SENTENCE_OPENER_STOPLIST` to the named-entity filter; genuine
 wrong-entity/number/email drift detection is structurally untouched (preserved). Fable judge FAILed
 the first attempt (positive tests were vacuous — used a THROWING judge that the fail-open escalation
 swallowed); remediated to `async () => false` so the verdict differs, and counterfactual-verified
 (revert src -> the 3 opener tests now FAIL). agent-core 1760 green.

- [done] 2026-06-13 :: ->Done **Second-hop retrieval no longer inflates CRAG confidence** — [2026-06-13, cognition loop
 fire 22, Fable-scout-found] `rankKnowledgeChunksWithHop` appended hop "bridge" matches carrying a
 SEED-relative cosine, but `KnowledgeMatch.cosine` is contractually "cosine to the QUERY" (the CRAG
 confidence signal). An inflated bridge (a near-duplicate note ~0.95 to the seed but ~0.48 to the
 query) flipped a weak retrieval to "confident" -> suppressed the LOW-confidence warning + defeated
 the proactive stay-quiet gate + could fire phantom clarifications. FIX: recompute each appended
 bridge's cosine against the ORIGINAL query (embed query once via options.embed — cache hit in
 prod; prefer the chunk's embedText for the consistent space); FAIL-SAFE to cosine:0 on any embed
 error (a bridge must never RAISE confidence). Verdict logic untouched (input repair, IMMUTABLE-CORE
 safe). Fable judge reverted-to-HEAD to PROVE the regression bites (0.9997->"confident" pre-fix,
 0.48->"ambiguous" post). agent-core 1753 green.

- [done] :: **Wrong-case enum arg repair (one-shot tool-calling reliability)** — agent-hardening fire 9
 (`686d76b4`, @muse/tools, tool-calling-reliability/arg-correctness): a small local model emits a
 closed-vocabulary (enum/const) value with the right MEANING but the wrong surface form ("HEX" for
 ["binary","octal","decimal","hex"], " octal ", "Turn_Off"); strict-equality `validateEnumArguments`
 then rejected it, burning a retry round or failing the call (Structured Reflection arXiv:2509.18847 —
 a right value in the wrong surface form invalidates an otherwise-correct call). `coerceToolArguments`
 already repairs right-value/wrong-TYPE args; this adds the missing enum counterpart `coerceEnumArguments`
 — rewrites a STRING enum/const arg to the schema's canonical spelling ONLY when, after trim(), it
 matches an allowed string choice case-insensitively AND matches EXACTLY ONE such choice. Wired into
 BOTH gates that run `validateEnumArguments` (ReAct agent-runtime + plan-execute, sibling-audit 2/2).
 Conservative/subtractive: ambiguous case-fold match, already-canonical, non-string value/choice, and
 unconstrained free-text props are never rewritten (21-value STABLE-0 FP corpus). Selection unperturbed
 (no tool name/desc/schema changed). MUTATION-FIRST RED on ambiguity guard + match logic + the
 agent-runtime wiring; @muse/tools 275 + agent-core 2512 green; eval:tools all visible cases PASS live
 on gemma4:12b; independent Opus (4)b judge PASS (3 mutations RED->GREEN, FP-safe, never invents a value).
 Diversifies cleanly off f5/f6 (recall-dedup), f7 (orchestration), f8 (memory) — a DIFFERENT pkg×kind.

- [done] :: **Engine-path near-duplicate bridge dedup** — agent-hardening fire 6 (`96cf6933`, agent-core,
 recall-quality): closed the deferred `· 1d-sibling-audit` from fire 5. `rankKnowledgeChunksWithHop`
 (secondHop) and `appendAssociativeBridges` (associative) appended up to 2 hop/PPR bridges to the
 primary ranking with NO near-duplicate check, so a chunk near-identical to a primary (same fact
 across two notes, or a bridge adjacent to a seed) padded the small model's grounding window. Fire 5
 fixed only the CLI/recall ask path (`dedupNearDuplicateChunks`, @muse/recall); the ENGINE had the
 same class gap. New `dropNearDuplicateAdditions` drops a bridge whose cosine to an already-kept
 chunk ≥ 0.985, wired into BOTH callsites (sibling-audit 2/2). AUGMENT-never-displace (primary
 untouched) + FAIL-OPEN (degenerate vec / embed failure -> kept; dropped only on a CONFIRMED match).
 Mutation-first RED confirmed (no-op -> drop test fails); one inflation-suite fixture loosened
 0.99974->0.970 to keep A′ a real bridge (query-relative-cosine invariant preserved), the ≥0.985 drop
 covered by a dedicated new test. eval:multihop hit@4 60%->80% (no regression). Independent Opus (4)b
 judge PASS (7/7, re-ran the mutation itself). agent-core 2494 green.

- [done] 2026-06-12 :: ->Done **MoA orchestrator: honest contributor attribution** — [2026-06-12, cognition loop fire 7,
 multi-agent #3] the MoA aggregate path set `contributors = all proposers`, but the field is
 documented as "ids the synthesized answer ACTUALLY drew on" and the aggregator discards off-topic
 proposals — a MAST reasoning-action-mismatch (the audit trail over-claimed). Added
 `attributeContributors(merged, proposals, floor=0.4)` (a proposer counts only when the merge
 lexically covers ≥floor of its tokens; fallback to all if none clear it) wired into the multi-merge
 return only. Other return paths (single / single-survivor / aggregator-empty) were already correct.
 agent-core 1708 green incl. a non-vacuous regression (3 proposers, merge echoes 2 -> exactly 2 credited).

- [done] 2026-06-12 :: ->Done **A2A council: typed + length-bounded response boundary** — [2026-06-12, cognition loop
 fire 8, multi-agent #3] the council REQUEST hand-off had a typed `parseCouncilRequest`, but the
 RESPONSE (the direction that flows into the initiator's LOCAL synthesis) was an inline ad-hoc check
 with NO length bound — a buggy/compromised allowlisted peer could flood local synthesis context
 (the wire's "bounded compute" goal wasn't enforced on the accepting side). Added a symmetric
 `parseCouncilResponse` + `MAX_COUNCIL_REASONING_CHARS` (truncate over-long reasoning at the trust
 seam) wired into `requestCouncilReasoning`. fromPeerId is carried-through (NOT a rejection reason —
 the judge caught + relaxed an over-strict draft that would have dropped legitimate reasoning when a
 peer's selfPeerId is unset, which handler.ts emits as ""). a2a 141 green.

- [done] 2026-06-12 :: ->Done **Council synthesis: one member, one voice (per-peer dedup)** — [2026-06-12, cognition loop
 fire 9, multi-agent #3] `synthesizeCouncilAnswer` fed raw utterances into the synthesis without
 deduping by peer — a duplicate peerId (dup registry entry, or the initiator's selfId colliding with
 a peer id, both reachable via `gatherCouncil`) double-weighted that member (MAST duplicated-work,
 skews a deliberation). Added pure `dedupeUtterancesByPeer` (last-wins, order-preserving) applied at
 the synthesis boundary. agent-core 1712 green incl. a prompt-capture integration (dup peer -> the
 synthesis prompt shows the LAST reasoning once, 2 members not 3).

- [done] 2026-06-13 :: ->Done **Background memory consolidation (sleep daemon)** — [DONE 2026-06-13, cognition loop
 fires 10-12+16, background #5] `consolidationPlan` (recall promote/fade) only ran on the manual `muse
 memory consolidate` CLI — the daemon consolidates the PLAYBOOK but never MEMORY. fire 10 shipped
 the brake-first gate `shouldConsolidateMemory({nowMs,lastRunMs,newHitsSinceLastRun,…})` in
 `@muse/memory` (run only when ≥minNewHits material AND ≥minIntervalMs since last run — non-straining;
 10-case battery). fire 11: `planMemoryConsolidationTick(records, state, options)` — the pure
 decide-and-run unit: counts recall records re-engaged since lastRunMs (the new material), gates on
 the brake, and only then DELEGATES to consolidationPlan, returning {ran, plan?, nextState} (lastRunMs
 advanced only when it ran). 7-case battery (incl. plan==consolidationPlan delegation + both brakes).
 fire 12: WIRED into the daemon — `runMemoryConsolidationTick` (sibling fn, testable) reads recall
 hits -> planMemoryConsolidationTick -> logs promote/fade, registered as a daemon tick next to
 playbookConsolidateTick (MUSE_SELFLEARN_ENABLED-gated, fail-soft, in-closure lastRunMs). Background
 memory consolidation now RUNS on the daemon schedule (brake-gated). fire 16: promotion-PERSISTENCE
 — `runMemoryConsolidationTick` gains an optional `persist` dep; the daemon binds it to the existing
 `promoteRecalledMemories` (idempotent: clears prior PROMOTED_FACT_ + writes the current top-N into
 the persona; non-destructive, never touches real user facts, never outbound) behind a DEDICATED
 opt-in flag `MUSE_SLEEP_PROMOTE` (default OFF ⇒ report-only preserved). So with the flag on, the
 daemon graduates the most recall-useful memories into the always-on persona in the background,
 brake-gated. cli 2520 green (persist-on-brake-pass, not-on-fail/disabled, fail-soft on throw).
 (ACT-R ranking from T2-1 feeds the selection via useActrRanking.) #5 thread COMPLETE.

- [done] 2026-06-12 :: ->Done **MoA fan-out: no duplicated sub-agent work (dedupe roles by id)** — [2026-06-12, cognition
 loop fire 13, sub-agents #4] `orchestrateAnswer` ran every role as a parallel proposer without
 deduping by id — duplicate-id roles ran a redundant sub-agent (wasted inference) AND yielded dup-id
 proposals that corrupt fire-7's `attributeContributors`/`contributors`. Added pure `dedupeRolesById`
 (first-wins, order-preserving) at the roleList resolution. MAST "no duplicated sub-agent work".
 agent-core 1718 green incl. an integration (2 dup-id roles + 1 -> exactly 2 proposals, unique ids).
 DEFAULT_ROLES path unaffected (distinct ids -> no-op).

- [done] 2026-06-12 :: ->Done **MoA fan-out: empty proposer output -> failedRoles (failure surfacing)** — [2026-06-12,
 cognition loop fire 14, sub-agents #4] `orchestrateAnswer` kept EVERY fulfilled proposer as a
 proposal, even one returning empty/whitespace text (a degraded sub-agent that didn't throw) —
 polluting the aggregator candidate list + inflating proposals.length. Now a fulfilled-but-empty
 proposal falls into `failedRoles` like a throw (MAST "failure propagation surfaces"). One-condition
 change (`&& outcome.value.text.trim().length > 0`); fail-close/single-survivor/aggregate/onProposal
 unchanged. agent-core 1722 green (empty->failedRoles, whitespace, all-empty fail-close, regression).

- [done] 2026-06-13 :: ->Done **MoA aggregator failure resilience** — [2026-06-13, cognition loop fire 15, sub-agents #4]
 the proposers run under allSettled (resilient) but the AGGREGATOR call was unguarded — a flaky
 local-model aggregator throw REJECTED the whole orchestration, discarding every successful
 proposer's work. Wrapped `aggregate()` in try/catch -> a throw becomes an empty merge -> the EXISTING
 fallback returns the best proposal (the "thorough" one). MAST graceful-degradation / don't-lose-
 sub-agent-work. agent-core 1725 green (throws->resolves-with-proposal, empty->fallback, success->merged).

- [done] 2026-06-13 :: ->Done **Weakness-ledger bounded growth** — [2026-06-13, cognition loop fire 23, Fable-scout
 runner-up] `writeWeaknesses` wrote all rows uncapped (unlike recall-hits' 5000-trim) -> the ledger
 grew without bound as novel topic rows accrued. Added `MAX_WEAKNESS_ENTRIES=2000` trim: on overflow
 keep what the selectors surface (count desc, then recency), evict stale one-offs; under the cap =
 verbatim/unreordered. mcp 1683 green; Fable-judge PASS (under-cap order-pin non-vacuous, evictions genuine).

## Blocked / deferred

- [decision] :: **Grammar-constrained tool-call decoding** — INFEASIBLE on Ollama today: `format`
 (schema->grammar) and `tools` are NOT composable (Ollama #6002). Revisit when #6002
 lands or accept an inference-stack change. Existing `groundToolArguments` already
 covers the fabricated-value class.

## Rejected directions (do NOT re-derive these)

- [rejected] :: 불가 **Chase general agentic leaderboards (SWE-bench Verified / τ²-bench / BFCL) as the
 "best" claim.** A fixed ~12B local model loses by construction (best open-weight
 SWE-bench ~80% on 200B+ MoE; BFCL 8-14B ~66% vs ~88% frontier). Own the architectural
 grounding-DELTA niche instead — the one claim a bigger model can't beat by swapping in.
 (2026-06-08 review, 3 adversarial critics concurred.)
- [rejected] :: 불가 **Build the error-analysis analyzer before instrumenting outcome-logging.** No fuel
 (labels) exists yet; building the pipeline first is infrastructure for a flywheel with
 no gas. Instrument first (above), analyze later.

## Open — browser control (low-spec model drives Chrome; track started 2026-06-11)

- [done] :: ->Done **ask --with-tools tool-set diet** — maxTools 10 default (MUSE_ASK_MAX_TOOLS, 0/off
 uncaps); relevance-sorted top-N. MEASURED side win: browse turn 93s -> 42s (smaller tool
 schemas = less prompt eval). Found+fixed en route: 1-char CJK keyword containment ("비" ranked
 weather on 비밀번호 prompts -> exact-only) and weather's calendar words (내일/주말) outranking
 reminders.add. Probes: browse->browser_open, recall->grounded cite, reminder plan->reminders.add
 first; eval:tools 125/125. Follow-up below.
- [done] :: ->Done **muse.* loopback keywords** — recall family keyworded (notes×6, tasks.search,
 reminders.search/history, episode.search; calendar/tasks-CRUD/reminders-CRUD already had them
 in a different def position — the audit's "no keywords" claim was PARTIALLY wrong). Plan probes:
 노트->muse.notes.search 1st, 지난번 대화->episode.search 1st, 할일 검색->tasks.search 1st.
 Still bare (low-traffic tail, fine): context/messaging/followup/pattern/status/skills.
- [done] 2026-07-13 :: **ROOT CAUSE FOUND (2026-07-13, fable5): Ollama's DEFAULT config defeats its own prompt cache.** The ~90s/turn is not a Muse problem — it is that the KV prefix cache never hits, so EVERY turn and EVERY tool-loop round re-pays the full prompt-eval. Measured (identical 1.6K-token prompt ×4): Ollama default = 2402/2406/2425/2427ms (no cache at all, even on a byte-identical repeat); `OLLAMA_NUM_PARALLEL=1` = 3163/**75**/**69**/**66**ms — **~40x** on a warm prefix. Muse's stable-prefix architecture was already correct; the runtime config was killing it. Shipped: `muse doctor` now MEASURES this (sends the same prefix twice, compares Ollama's own `prompt_eval_duration`) and names the fix; documented in setup-local-llm.md.
 · 불가 **DISPROVEN: `MUSE_OLLAMA_NUM_BATCH` does nothing.** The old hypothesis ("a larger batch attacks the prompt-eval cost") is false on this hardware — measured flat and slightly WORSE at larger batches (unset 6488ms / 512: 6159 / 1024: 6477 / 2048: 6855 / 4096: 7076ms on a 4.4K-token prompt). Do not default it on; do not re-propose it.
 · · Residual (real, smaller): prompt SIZE itself. gemma4:12b evaluates ~650 tok/s cold, so a 10K-token prompt is ~15s cold even with the cache — a prompt diet under `--with-tools` still pays off on the FIRST turn of a session.
- [open] :: **cascade routing C2/C3 (decomposed local-speed fire 3; FrugalGPT arXiv:2305.05176)** — fire 3
 shipped C1: the escalation-decision primitive `shouldEscalateToHeavy(confidence, threshold)` +
 `planTieredRun` optional `priorConfidence`/`escalateThreshold` (a fast-classified task with a KNOWN
 low fast-pass mean-logprob escalates to heavy; absent = unchanged, byte-identical). REMAINING:
 · **C2-core (execution primitive) — DONE fire 5** `runCascade({fast,heavy,run,confidenceOf,threshold})`
 (@muse/multi-agent cascade-run.ts): runs fast -> escalates ONCE to heavy on low/unmeasurable confidence,
 bounded (MAST no-loop). Model-agnostic via injected run/confidenceOf (package idiom). REMAINING:
 · **C2b-plumbing (agent-run logprobs) — DONE fire 10** `AgentRunInput.logprobs`/`topLogprobs` now thread
 through BOTH runtime seams (loopRequest + streamLoopRequest) to `ModelRequest.logprobs`, and round-trip
 back via `AgentRunResult.response.logprobs`. So an AGENT run can now be confidence-scored
 (`summarizeTokenConfidence`) — the prerequisite the agent path lacked (the direct ask path at
 commands-ask.ts:2870 already had logprobs). REMAINING:
 · **C2b-wiring — DONE fire 11** `createCascadeWorker` (apps/api) bridges runCascade(5) + agent-run
 logprobs(10) + summarizeTokenConfidence: a FAST-classified worker runs the fast model with `logprobs:true`,
 scores confidence, and escalates ONCE to heavy on low/unmeasurable confidence. Wired OPT-IN into
 `buildTieredOrchestration` via `MUSE_TIERED_CASCADE` (default off -> plan byte-identical). Cascade is now
 LIVE in the orchestration path. REMAINING: also wire `muse ask --tiered` single-query path (commands-ask.ts).
 · **C3 (live eval) — DONE fire 13** `eval:cascade` (scripts/eval-cascade.mjs + pure `lib/cascade-eval.mjs`
 scoreCascadeEval, node:test'd 8 cases). The GATE LOGIC (escalate iff low-confidence — a weak fast answer
 never silently kept; a confident one never needlessly escalated) is mutation-proven in the UNIT layer.
 LIVE-MEASURED latency on this box (fast=qwen3:8b / heavy=qwen3.6:35b-a3b): cascade **23.9% faster** (12970ms
 vs 17045ms). HONEST CAVEAT ((4) judge): escalation was 0% (qwen3:8b confident on the whole set at threshold
 −1.0), so only the latency-win-on-confident-queries arm was exercised LIVE; the escalate->heavy arm was not
 triggered, and the runner's live `gateCorrect` is self-consistency (escalation derived from the same
 predicate the scorer re-checks), NOT an independent measurement — the gate's adversarial proof is the unit
 tests. LOCAL-OLLAMA-ONLY skip when down. REMAINING (·): a hard prompt / lower threshold that actually
 triggers live escalation to exercise the heavy arm end-to-end. The cascade vein (C1 decision · C2
 execution+logprobs · C2b orchestration wiring · C3 latency proof) is otherwise complete; `ask --tiered`
 single-query surface still remains.
- [done] :: **doctor: surface the Muse-side speed env — DONE local-speed fire 6** — `museSpeedEnvCheck` +
 `readMuseSpeedEnv` (apps/cli) report the Muse-PROCESS speed env (`MUSE_OLLAMA_NUM_BATCH` fire-2 lever,
 `MUSE_OLLAMA_NUM_CTX`, `MUSE_OLLAMA_KEEP_ALIVE`) on every `muse doctor`, with a concrete num_batch
 tuning hint when unset — so the shipped lever is discoverable, not invisible. Advisory (always ok);
 distinct surface from `ollamaPerfPostureCheck` (server launchctl env).
- [done] :: **doctor: MUSE_OLLAMA_NUM_PREDICT in museSpeedEnvCheck — DONE local-speed fire 8** — `readMuseSpeedEnv`
 + `museSpeedEnvCheck` now also report `MUSE_OLLAMA_NUM_PREDICT` (the fire-7 default-generation cap), so the
 doctor speed-env posture is complete (num_batch/num_ctx/keep_alive/num_predict). Consistency fix — fire 7
 added the env, the fire-6 check had omitted it.
- [open] :: **doctor: warn when flash is ON but the model arch is NOT flash-attention-capable** — even with
 OLLAMA_FLASH_ATTENTION=1, KV quant falls back to f16 unless the model is on Ollama's FA allowlist
 (gemma3/qwen3/… per ollama/ollama#13337; gemma4 status unverified). Hard to encode (version-fragile
 allowlist) — deferred; would need to query Ollama's supported-arch list at runtime, not hardcode.
 (scouted local-speed fire 4)
- [done] :: **local-speed sibling adapter knobs — DONE fire 12** `MUSE_OLLAMA_NUM_THREAD` (CPU threads) +
 `MUSE_OLLAMA_NUM_GPU` (GPU layer offload) now wire opt-in to Ollama `num_thread`/`num_gpu` (same
 omit-by-default pattern as num_batch — wire byte-identical when unset). KEY: `num_gpu=0` (CPU-only) is
 a VALID opt-in, so the adapter validates `>= 0` and autoconfigure uses `parseNonNegativeInteger` (the
 test caught that `parseInteger` rejects 0). num_thread keeps `> 0`. Completes the Ollama adapter
 speed-knob family (num_ctx/num_batch/num_predict/keep_alive/num_thread/num_gpu). Per-box win still
 needs `bench:local` (C3-style) measurement.
- [done] :: **model warmup on server start — DONE fire 14** `MUSE_WARMUP_MODEL` (apps/api `warmUpModelIfConfigured`)
 fires a tiny fire-and-forget generate at server startup so the FIRST user request is warm — keep_alive only
 keeps the model resident BETWEEN requests, so the first request after a start otherwise pays the full cold
 load (tens of seconds for a 12B). Opt-in (default off -> startup byte-identical), fail-soft (a warmup error
 never blocks server start). SIBLING ·: surface MUSE_WARMUP_MODEL in `museSpeedEnvCheck` (doctor) like
 num_batch/num_predict, and a per-box cold-start delta measurement.
- [done] :: ->Done **injection-pattern cross-span tightening** — the EN role_override family + 2 KO
 role_override + 1 KO extraction regexes used unbounded `.*`/`/s`, so three unrelated words from
 DIFFERENT sentences combined into a false hit (live repro: "disregard the noise … finally …
 assembly instructions" -> role_override, with `all` matching the substring inside "fin**all**y").
 Bounded the inter-token spans to `.{0,50}` (EN) / `.{0,30}` (KO, denser script) and word-boundary-
 anchored `all`. TDD: 3 cross-span false-positive cases (EN + KO) + a true-positive-preserved case;
 all 127 policy tests green incl. the multilingual battery (true positives intact), agent-core
 guards 1622, byte-hygiene 30, precheck:grounding pass^2. Real injections keep trigger->target->noun
 within a clause, so detection is unchanged; only the cross-sentence false combinations are killed.

- [done] :: ->Done **same-origin iframe piercing** — the snapshot walk descends into same-origin
 iframe `contentDocument` (like shadow roots); cross-origin throws on access and is
 honestly skipped. Ref resolution searches EVERY frame (`page.frames()`), so an
 iframe-embedded control is both visible AND clickable. Real-Chrome smoke (local http,
 same-origin iframe button): button appears in the snapshot + cross-frame click succeeds.
- [done] :: ->Done **empirical real-web hardening (probe -> fix -> lock)** — a gap-probe of 7 real
 patterns on puppeteer-core 25.1.0 / Node 24 surfaced 3 bugs, all fixed + locked in
 smoke:browser (now 12 scenarios): (1) a JS dialog (confirm/alert/prompt) BLOCKED the
 page -> the next action hung to the timeout; now auto-accepted (the act was draft-first
 approved upstream) + reported in the snapshot `dialog` field. (2) content inserted by
 setTimeout/fetch AFTER a click was missed (networkidle returns instantly with no
 network) -> a MutationObserver-based `settleDom` waits for the DOM to go quiet (fast on
 static pages, capped). (3) disabled controls were listed (wasted clicks) -> skipped in the
 walk. Verified: unit 36, smoke 12/12 exit 0, eval:browser-agent PASS.
- [done] :: ->Done **new-tab following + autocomplete** (probe batch 2) — a target=_blank link /
 window.open popup spawned a tab the controller never followed (it kept observing the
 stale opener; window.open even hung 8s). Fix: arm a `targetcreated` listener BEFORE the
 click/submit (checking pages() after races and misses it) and adopt the new tab, within
 a 500ms window so a normal no-new-tab click isn't taxed (2943ms -> 1446ms). Autocomplete
 (type -> suggestion) already works via the DOM-stable settle. Locked: smoke 13 (new tab
 followed) + 14 (autocomplete observed); unit 36, eval:browser-agent PASS.
- [done] :: ->Done **repeated-control targeting** (probe batch 3, click/select) — a per-row
 "Add to cart" / repeated "View" was DEDUPED to one entry, so the model could never
 target the 2nd (product lists, tables, search results — a huge real-web class). Fix:
 (a) dedup now collapses only TRULY redundant LINKS — same text AND same href (a
 responsive nav rendered twice); distinct buttons/actions are kept. (b) matcher gained
 ORDINAL targeting ("the second Add to cart", "2nd View", "last") that picks the Nth
 among equally-matched controls in DOM order — guarded so a literal label that starts
 with an ordinal word ("First name") is never mis-stripped (only applies when `rest`
 truly has >1 match). Custom (non-native) dropdowns + tabs already worked (settle).
 Locked: matcher unit +5, smoke 15 (repeated buttons distinct + ordinal->Banana), agent
 battery PASS.
- [done] :: ->Done **browser_hover** (probe batch 4) — hover-triggered dropdown navs / tooltips were
 invisible (the submenu only renders on :hover/mouseover). New read-risk `browser_hover`
 tool grounds a target (the menu label) and moves the pointer over it, then re-observes —
 the pointer STAYS, so a nested submenu item stays clickable (moving to it keeps :hover).
 Also added `[aria-haspopup]` to the snapshot selector so explicit (possibly non-link)
 menu triggers are listed. Locked: unit +2, eval 10/10 STABLE 3/3 (hover->browser_hover,
 not click), smoke 16 (hover reveals Billing then clicks it), agent PASS. (Limit: a hover
 trigger that's a bare non-interactive `<div>` without aria-haspopup still isn't listed.)
- [done] :: ->Done **form-control labels** (probe batch 5) — a radio/checkbox/labeled input was
 named by its `value`/`name` attr ("pro"), NOT its VISIBLE label ("Pro plan"), so the
 model — which refers to controls by their label — couldn't target them. Fix: a form
 control's name now resolves its accessible label (aria-labelledby -> `<label for>` ->
 wrapping `<label>`) before falling back to value/placeholder. Also added `[role=option]`
 / `[role=switch]` to the snapshot selector (custom listboxes/toggles with JS-delegated
 handlers, no inline onclick). Verified: radio->"Pro plan", input->"Email address",
 checkbox->"I agree to terms" all targetable + actionable; range sliders already settable
 via type/fill. Locked: smoke 17, unit 43, agent PASS.
- [done] :: ->Done **browser_key** (probe batch 6) — no keyboard action meant a modal/dropdown with
 no visible close control could not be dismissed, and keyboard-driven UIs were unreachable.
 New read-risk `browser_key` tool presses Escape / Enter / Tab / arrows, then settles +
 re-observes (Enter wrapped in the new-tab follow). Verified: a modal opened by a button
 and closable only by Escape is dismissed; Tab fires its handler. Locked: smoke 18, eval
 11/11 STABLE 3/3 (Escape->browser_key, not click), unit 46, agent PASS.
- [done] :: ->Done **multi-step agent reliability** (the frontier) — eval:browser-agent was a single
 1-2-step task; added a genuine multi-step scenario (open -> search -> CLICK the result ->
 read the DETAIL page -> answer the stock count that appears ONLY there). gemma4:12b carries
 the full chain STABLE 3/3 (terminal state = ended on the detail page; grounded answer = the
 "7 units" that's unreachable without clicking; fabricating or stopping at the results fails).
 Proves low-spec multi-step web autonomy is reliable, not just one-shot. The battery is now a
 scenarios[] array — add a scenario per new capability.
- [open] :: **more real-web probes** — native file upload (`<input type=file>` -> CDP uploadFile +
 path arg/tool), cross-origin iframe (per-frame contexts — scope honestly), drag-and-drop;
 and harder multi-step chains (3-4 clicks, a form fill across pages).
- [done] :: ->Done **browser_scroll** — the snapshot only saw rendered DOM, so below-the-fold /
 lazy-loaded content (infinite feeds, long lists) was invisible. New read tool scrolls
 (down/up/top/bottom) + settles + re-observes. Unit (enum + reject-unknown + scrolls);
 eval 9/9 STABLE 3/3 (scroll EN+KO); real-Chrome smoke: a button lazy-appended on scroll
 is absent before and present after scroll('bottom'). Completes the observation-
 completeness trio with iframe + paging.
- [done] :: ->Done **element paging past the 50 cap** — no more silent truncation. The controller
 collects up to BROWSER_ELEMENT_CEILING (200) so grounding matches the WHOLE set in code;
 every tool RESPONSE shows ≤BROWSER_MAX_ELEMENTS (50) and reports `total` +
 `hasMore`/`nextOffset`; `browser_read` gained an `offset` arg to page. Unit: 50-cap +
 total/nextOffset + offset-reads-the-rest; smoke: 61 elements returned (not capped at 50).
- [done] :: ->Done **agent-level multi-step live battery** — `pnpm eval:browser-agent`: gemma4 drives
 open->type+submit on a local fixture shop (file://, no network) and answers from the rendered
 result; graded on TERMINAL STATE (the page records the query it actually received — a
 fabricated "I searched" cannot pass) + answer must carry the name+price that only render
 post-search. 3/3 STABLE. Built it the hard way: (1) matcher bug — "search box" landed on the
 'Search' BUTTON (substring 60 > shared-words 35); type-intent now prefers ANY matching
 typeable element. (2) harness initially omitted metadata.localMode -> runtime hid the
 execute-risk type/click and gemma FABRICATED a result ("Wireless Mouse Pro $29.99") —
 recorded evidence that the gate-less raw model invents on tool failure; the ask path's
 verdict gate is the standing protection. (3) launchDetached probe window 10s->30s (a fresh
 profile's cold start exceeded 10s under load — "slow" misread as "missing").

## RUNNER SEATBELT (roadmap W1 D2-S1)
- [done] 2026-07-11 :: D2-S1b+c 2026-07-11 — MUSE_RUNNER_SANDBOX=seatbelt 배선(canonicalize 필수·/dev/null allowance 실기기 발견), 탈출3종 실프로세스 계약+mutation-RED, doctor 포스처; 다음 = D2-S1d(eval:adversarial 샌드박스-탈출 케이스, D2-S7 합류 가능)
- [done] 2026-07-11 :: D2-S1d 2026-07-11 — eval:adversarial 결정론 sandbox-탈출 3종(실 바이너리 spawn·OS거부 코드채점·adversarialCases 16->19); 다음 = D2-S2(셸 토폴로지 fail-close)
- [done] 2026-07-11 :: D2-S2a 2026-07-11 — 셸 토폴로지 순수 분류기 classifyCommandTopology(치환/heredoc/eval 감지, 비-셸=analyzable near-miss); Opus가 개행-eval false-neg+산술 false-pos 잡음->수리; 다음 = D2-S2b(approval-downgrade 배선), VQ-15(sudo/env 래퍼)
- [done] 2026-07-11 :: D2-S2b 2026-07-11 — 토폴로지 분류기를 chatToolApprovalGate에 배선(un-analyzable run_command은 read위조로도 silent-allow 불가 + 프롬프트 경고); trust.json 미배선이라 full auto-approve 강등은 VQ-16; 다음 = D1-S1(ping-pong 루프감지)
- [done] 2026-07-11 :: D1-S1 2026-07-11 — ping-pong 루프가드(A↔B 교대 감지, 창20/warn6/block10, 휘발필드 strip, block->abort 양쪽 루프 배선); stall/3-cycle/distinct=none 오탐0; 다음 = D2-S6a(승인 프롬프트 위험토큰 하이라이트). VQ-17: eval:computer-task가 ambient GEMINI_API_KEY로 클라우드 하이재킹
- [done] 2026-07-11 :: D2-S6a 2026-07-11 — 승인 프롬프트 위험-토큰 하이라이트(identifyRiskyTokens/emphasizeRiskyTokens, DS-2 어휘 재사용, redact 뒤 TRUSTED ANSI); 안전명령 오탐0; 다음 = D2-S6b(write-approval 스테이징, pending-approval-store 재사용)
- [done] 2026-07-11 :: D2-S6b 2026-07-11 — write-approval 스테이징(CLI fs-write 비대화형 거부->기존 pending-approval-store 기록, messaging src 미수정, no-external-effect e2e); 다음 = D3-S7(PID-재사용 kill 가드). VQ-18: CLI-write 재실행(content) 미배선
- [done] 2026-07-11 :: D3-S7 2026-07-11 — PID-재사용 kill 가드(osStartTime 캡처+pidIdentityMatches, 불일치->kill 금지 fail-close, CLI ps 배선); W1 완주. 다음 = W2 D1-S3(단계적 요약)
- [done] 2026-07-11 :: D1-S3 2026-07-11 — 단계적 요약(tool-pair 경계 청크->청크별 FAIL-OPEN->병합, 부분실패 생존 보존, 식별자 VERBATIM 지시); 기존 CMP-2 무수정. 다음 = D1-S5(이터레이션 예산 재설계)
- [done] 2026-07-11 :: D1-S5a 2026-07-11 — 예산 소진 명시 notice(침묵중단 금지, budget-only 게이트, proactive 주입); maxToolCalls 불변. 다음 = D1-S5b(PTC 계상+서브에이전트 하위예산)
- [done] 2026-07-11 :: D1-S5b1 2026-07-11 — PTC=1 예산슬롯 규칙 명문화+회귀락(주석+행동락 테스트, 계상 무변경); 다음 = D1-S5b2(서브에이전트 하위예산)
- [open] :: D1-S5b2 sibling-audit follow-up: `packages/multi-agent/src/orchestrator.ts`'s `withSelectedWorker` / `SupervisorAgent.run` spread the parent `AgentRunInput.metadata` UNCHANGED into every fanned-out worker — the same inheritance bug class `resolveSubAgentToolBudget` fixes in ask-decompose — but this engine has no established `maxTools` convention wired in yet (that lives in apps/cli's `resolveAskMaxTools`), and its real caller (`/api/multi-agent/orchestrate`) is server-side (`apps/api`, out of this slice's scope — `commands-orchestrate.ts` is just the HTTP client, no local worker execution). Separately, `commands-board.ts`'s `makeAgentExecutor` runs each board task via `agentRuntime.run` with NO `metadata`/`maxTools` at all — uncapped by default, a different (bigger) gap than an inheritance bug since dispatch is one task at a time, not a fan-out. Neither was trivial/in-scope here; flagging both for a follow-up slice.
- [done] 2026-07-11 :: D1-S5b2 2026-07-11 — 서브에이전트 별도 하위예산(resolveSubAgentToolBudget, 워커 sub-budget vs 부모, ask-decompose 배선); D1-S5 완료. 다음 = D3-S1(서브에이전트 depth 강등)
- [done] 2026-07-11 :: D3-S1a 2026-07-11 — 보드 depth 강등(depth 필드·MUSE_BOARD_MAX_DEPTH 기본1·ceiling서 expand 거부, 무한 재분해 차단); 다음 = D3-S1b(부모 tool-deny 상속)
- [done] 2026-07-11 :: D3-S1b 2026-07-11 — `inheritParentToolDeny` (packages/multi-agent, pure intersection clamp) wired into ask-decompose's worker `execute` path so a worker's effective `allowedToolNames` is structurally clamped to the parent's — never broadened even if a future path tried to hand it more; synthesis/planner stay unclamped (lead-level). 8 pure + 2 wiring tests, 2 mutation-guard-offs RED, independent evaluator. SIBLING-AUDIT: `orchestrator.ts`'s `SupervisorAgent.run`/`withSelectedWorker`/`runSequential`/`runParallel` all spread `...currentInput.metadata` / `...input.metadata` UNCHANGED into every worker — so `allowedToolNames` already flows through verbatim (no broadening bug today), but it's an unenforced CONVENTION, not a structural clamp like this slice's — a follow-up could route it through `inheritParentToolDeny` too for defense-in-depth. `commands-board.ts`'s `makeAgentExecutor` has no parent-metadata concept at all (board tasks are the top-level run, not a fanned-out child of a restricted parent) — out of scope for this clamp; relevant only if/when board `expand` sub-tasks start running under an inherited parent allowlist.
- [done] 2026-07-11 :: D3-S1b 2026-07-11 — 부모 tool-deny 상속(inheritParentToolDeny child⊆parent 구조클램프, ask-decompose 워커 배선); D3-S1 완료. 주의:defense-in-depth(프로덕션 현재 no-op). 다음 = D3-S2(런타임 하트비트)
- [done] 2026-07-11 :: D3-S2 2026-07-11 — 단일-run heartbeat emission seam(model-loop 3 point, 기존 detectStalled 재사용, fake-clock 유닛); 라이브 레지스트리 피딩은 아키텍처 결정이라 deferred(backlog). 다음 = D3-S4(용량 거부+헤드룸 예산)
- [done] 2026-07-11 :: D3-S4a 2026-07-11 — job 동시상한(MUSE_JOBS_MAX_CONCURRENT 기본3, at-cap 명시거부, 무제한 spawn 차단); 다음 = D3-S4b(부모-헤드룸 요약예산+스필)
- [done] 2026-07-11 :: D3-S4b 2026-07-11 — 보드 합성 헤드룸 예산+파일스필(per-child ×0.5/n floor2000, 초과분 ~/.muse/board-spill/ 왕복); D3-S4 완료. 다음 = D1-S7a(브라우저 AX-tree 숫자 refs)
- [done] 2026-07-11 :: D1-S7a 2026-07-11 — 브라우저 ref 안정성 가드(resolveTarget 숫자-ref fail-close: 현재 스냅샷에 없는 ghost/stale/환각 ref -> "call browser_read" 거부, click/hover/type/upload 단일 해소점 일괄, 부분부작용 0); refs 이미 numeric이라 포맷 무변경. 형제 VQ-19(DOM stale-attr 충돌, 실브라우저). 다음 = D1-S7b(step-budget+timeout 주입)
- [done] 2026-07-11 :: D1-S7b1 2026-07-11 — 브라우저 액션-예산 결정 코어(순수 agent-core: guardBrowserAction, isBudgetExhausted `used>=max` 경계정확, near-cap warning, actions_used N/M label); 행동 시퀀스+경계 mutation-RED. 코어-only 미배선(b2 배선). ※fire 18 JUDGE-DRILL 진짜-fix. 다음 = D1-S7b2(buildBrowserTools 배선+bounded-task 통합)
- [done] 2026-07-11 :: D1-S7b2 2026-07-11 — 액션-예산 배선(createBrowserActionTracker per-task 공유->click/type/fill fail-close 소진거부+actions_used N/M+MUSE_BROWSER_MAX_ACTIONS 기본30); byte-identical when absent, mutation-RED 양방향, Opus 8축 PASS. 형제 미배선: upload/key(Enter)/open counting. 다음 = D1-S7c(pending dialog 스냅샷 필드+auto-dismiss)
- [open] 2026-07-11 :: 형제(D1-S7b) — 액션-예산을 upload/key(Enter)/open(navigation) 툴로 확장 counting(현재 click/type/fill만). BrowserUploadToolDeps/BrowserKeyToolDeps에 actionBudget 추가·조건부(key는 Enter만) — 2026-07-11 D1-S7b2 형제감사
- [done] 2026-07-11 :: D1-S7c 2026-07-11 — 브라우저 JS-dialog fail-close 처분(순수 dialog-policy.ts: confirm/prompt/unknown->dismiss, alert/beforeunload->accept; registerDialogHandler 배선); 페이지-발 confirm/prompt auto-commit 차단, 12 test·mutation-RED 양방향·Opus PASS. 다음 = D1-S7d(page 콘텐츠 <page> 래핑+미디어 defang, 실 e2e)
- [done] 2026-07-12 :: D1-S7d1 2026-07-12 — 결정론 page-content 인젝션 guard(순수 page-content-guard.ts: `<page>` 래핑+break-out escape+`](` media defang+"ignore above" 중화; snapshotToJson/elementsJson 배선). 11+2 test·mutation-RED 양방향·Opus 위협모델 PASS. 다음 = D1-S7d2(실 detached-Chrome e2e, 악성 픽스처)
- [done] 2026-07-12 :: D1-S7d2 2026-07-12 — 실 headless-Chrome 인젝션 e2e(scripts/eval-browser-injection.mjs, pnpm eval:browser-injection, 모델-free): 악성 픽스처->실 controller.open->툴출력 defanged+wrapped 9/9 라이브 PASS·mutation-kill 검증·Opus 지적 2건(tautological 경계·슬라이스마커) 수정. **D1-S7(브라우저 신뢰성 L) 완주**. 다음 = D4-S4(file_edit 결정론 리페어)
- [done] 2026-07-12 :: D4-S4 2026-07-12 — file_edit 결정론 리페어 강화(indent-preserve: fuzzy 매칭 시 파일 실제 들여쓰기로 re-base + escape-drift 확장 `\"`/`\'`/`\\`, fail-close 가드); 53 test·mutation-RED 양방향·Opus PASS·eval:computer-task 회귀-STABLE. 다음 = D4-S1(muse mcp serve 확대)
- [open] 2026-07-12 :: 형제(D4-S4) — hermes fuzzy 미추가 전략: whitespace-collapse relaxation·first/last-line 앵커링(interior fuzzy). case-insensitive는 소스 손상 위험이라 영구 제외 — 2026-07-12 D4-S4 형제감사
- [done] 2026-07-12 :: D4-S1a 2026-07-12 — `muse mcp serve` write draft-first 프록시(propose_action: 외부 제안->PendingApproval 큐 파킹 source "mcp-serve", 실행경로0, blank->fail-close); no-external-effect 계약·16 test·mutation-RED 양방향·Opus 위협모델 PASS. 후속 VQ-20(raw-draft spoofing). 다음 = D4-S1b(grounded-recall을 grounded surface로 등록, groundedSurfaces +1)
- [done] 2026-07-12 :: D4-S1b 2026-07-12 — 이미-성립: verify-mcp-serve-grounding.mjs가 `muse mcp serve` 최초커밋 cc1fdde81에서 배터리+release-gate 등록 완료(groundedSurfaces 이미 카운트=38). 라이브 4/4 PASS 실증·Opus 정직-accounting PASS(중복 날조 안 함). 다음 = D4-S1c(read 확대: 캘린더·태스크 read + stdio 왕복)
- [done] 2026-07-12 :: D4-S1c1 2026-07-12 — `muse mcp serve` calendar_read 툴(from/to ISO->LocalCalendarProvider.listEvents 위임, 양-bound pass-through 구조적 보장, fail-close missing/NaN/`to<=from`->source 미호출); 19 test·mutation-RED 양방향·Opus PASS. ※fire 26 JUDGE-DRILL 진짜-fix. 다음 = D4-S1c2(태스크 read 툴)
- [done] 2026-07-12 :: D4-S1c2 2026-07-12 — `muse mcp serve` tasks_read 툴(status open/done/all->LocalFileTasksProvider.list 위임, status pass-through·invalid->fail-close source 미호출); 23 test·mutation-RED 양방향·Opus PASS. 다음 = D4-S1c3(실 stdio subprocess 왕복 계약)
- [done] 2026-07-12 :: D4-S1c3 2026-07-12 — MCP 실 stdio subprocess 왕복 계약(verify-mcp-stdio-contract.mjs, pnpm mcp:stdio-contract): 실 muse mcp serve spawn->initialize->tools/list(6)->tasks_read seed round-trip+status 필터, InMemory 아닌 실 wire, 라이브 ALL PASS·mutation-RED·Opus 재실행 PASS. MCP_SERVE_INSTRUCTIONS 6툴 정확화. **D4-S1 완주**. 다음 = D4-S2a(macOS Photos 검색/내보내기)
- [done] 2026-07-12 :: D4-S2a 2026-07-12 — macOS 사진 검색(mac_spotlight_search imagesOnly 확장, 신규툴0, injection-safe 후-필터·이미지 확장자, byte-identical default); 3 test·mutation-RED·Opus 8축 PASS. Photos.app 딥 export=VQ-21. eval:tools timeout(가산변경, 결정론게이트 판정). 다음 = D4-S2b(mac_system_set enum: 앱종료)
- [done] 2026-07-12 :: D4-S2b 2026-07-12 — macOS 앱종료(mac_system_set quit_app enum+app param, osascript tell-to-quit, 공유 escapeAppleScript 인젝션-safe backslash-first, blank->fail-close osascript 미호출); 4 test·mutation-RED 양방향·Opus 위협모델 PASS. 신규툴0. 다음 = D4-S2c(다크모드 enum)
- [done] 2026-07-12 :: D4-S2c 2026-07-12 — macOS 다크모드(mac_system_set dark_mode_on/off parameterless enum, 고정 System Events osascript, 인젝션 표면0); 3 test·mutation-RED·Opus PASS. 신규툴0. 다음 = D4-S2d(블루투스/밝기 Shortcuts enum)
- [done] 2026-07-12 :: D4-S2d 2026-07-12 — macOS 블루투스(mac_system_set bluetooth_on/off, focus 패턴 named Shortcut·argv 인젝션無, MUSE_BLUETOOTH_*_SHORTCUT env+doctor check 완전배선); 5+4 test·mutation-RED·Opus PASS. 신규툴0. 밝기=D4-S2d2. 다음 = D4-S2e(Apple 연락처 쓰기 draft-first)
- [done] 2026-07-12 :: D4-S2e 2026-07-12 — Apple 연락처 쓰기 draft-first(mac_contacts_write, message-send 미러: gate 강제 deny/throw->osascript 0, action-log, escapeAppleScript, buildContactsApprovalGate non-interactive fail-close, armed-lockstep); 6+3 test·mutation-RED 양방향·eval:tools 골든3·Opus outbound-safety PASS. ※fire 34 JUDGE-DRILL 진짜-fix. **D4-S2 완주(a·b·c·d·e)**. 다음 = D7-S1(슬래시 명령 단일소스 레지스트리)
- [done] 2026-07-12 :: D7-S1a 2026-07-12 — 슬래시 명령 단일소스 레지스트리(slash-command-registry.ts, 27 엔트리 name·desc·category·platforms; chat SLASH_COMMANDS를 slashCommandsForPlatform("chat")로 파생, 하드코딩 제거·byte-identical); Set-uniqueness dedup 증명+플랫폼게이트 6 test·mutation-RED 양방향·Opus PASS. CLI-help 반영=D7-S1b. 다음 = D7-S1b
- [done] 2026-07-12 :: D7-S1b 2026-07-12 — 레지스트리 `cli` 태그를 실제 CLI surface(COMMAND_STUBS 매니페스트)와 cross-check해 drift 락킹; 발견 jobs·pref·reflect 3개 오태깅->cliName? 추가(reflect->reflections)·jobs·pref chat-only 정정; drift-lock 4 test(실 매니페스트 대조·투영·chat 27 불변)·mutation-RED 양방향·Opus PASS. 비차단: cli 투영 소비자 미배선. **D7-S1 완주(a·b)**. 다음 = D4-S2d2(밝기, top-to-bottom 첫 미체크)
- [done] 2026-07-12 :: D4-S2d2 2026-07-12 — macOS 밝기(mac_system_set `brightness` enum, value-passing): value 0–100 clamp+round->named Shortcut에 stdin input 전달(`--input-path -`, mac_shortcut_run 선례); MUSE_BRIGHTNESS_SHORTCUT env+setupMessage+doctor check(단일 shortcut 미러). 9+4 test·mutation-RED 양방향·Opus PASS(stdin 값전달 실검증·argv-not-shell). **D4-S2 완전 종료(a·b·c·d·d2·e)**. 다음 = D5-S1(privacy routing follow-ups)
- [done] 2026-07-12 :: D5-S1 2026-07-12 — privacy routing follow-ups(3파트, additive·20 계약 무수정): (b) usesTools 결정론 신호(툴-요청->로컬 고정, 정책층 codification·route-flip 유닛) (c) personaPreamble nuance 문서화 (d) KO 내꺼/제꺼 토큰(오탐 제거/안내 방어)+`muse setup cloud` privacy-routing 안내단계(action stdout 실배선). policy +12·cli +3 유닛·mutation-RED·Opus PASS. 다음 = D5-S2(resolveAuxiliaryModel 통합 리졸버)
- [done] 2026-07-12 :: D5-S2 2026-07-12 — resolveAuxiliaryModel(task,env) 통합 리졸버(autoconfigure, additive·미배선): precedence MUSE_AUX_<TASK>_MODEL > legacy(MUSE_VISION_MODEL·MUSE_RECALL_EMBED_MODEL) > session; 로컬-우선 fail-close 게이트(personal-context/local-only면 cloud aux 거부->session, keptLocalForPrivacy). 11 유닛·mutation-RED 양방향·docs:env 5·Opus PASS(locality 실검증·resolveVisionModel 무변경). 콜사이트 마이그레이션=follow-up. 다음 = D5-S3(canUseNativeTools 死코드 배선)
- [done] 2026-07-12 :: D5-S3 2026-07-12 — canUseNativeTools 死코드->실게이트(VQ-2): AgentRuntime 요청경로에 assertModelCanUseTools 배선, tools 노출+capability-부재 모델->명시적 ModelToolCallingUnsupportedError(조용한 무시 대신). fail-open(tools0·미지·listModels-throw->무차단)+per-instance 캐시. 6 behavioral(run 경로)·mutation-RED 양방향·Opus PASS. 텍스트 프로토콜 파서=별도 L 이연. 다음 = D5-S4(MUSE_MODEL_FALLBACKS 명시 체인)
- [done] 2026-07-12 :: D5-S4 2026-07-12 — resolveModelFallbackChain(env,isPersonalContext?) 명시 fallback 체인 리졸버(autoconfigure, additive·미배선): MUSE_MODEL_FALLBACKS 설정 시에만 순차 체인, 미설정->빈 체인(byte-identical, 숨은 재시도 없음); 각 cloud 폴백 fail-close 게이트(local-only/personal->drop). 10 유닛·mutation-RED 양방향·docs:env·Opus PASS(locality 실검증·negative control). 체인->ModelFallbackStrategy 구성+답변 마커=follow-up(runtime-assembly HANG 리스크). 다음 = D1-S6(턴-내 one-shot 회복 상태 통합)
- [done] 2026-07-12 :: D1-S6a 2026-07-12 (JUDGE-DRILL) — OneShotRecoveryState 프리미티브(agent-core): claim(branch) 첫 claim만 true·이후 false->회복분기 턴당 최대1회(이중재시도 구조적 불가). 4 유닛(guaranteed-once·guarded-body 1회)·mutation-RED·index export. 드릴: 고의결함(claim 항상 true+hollow) 주입->Opus (4)b 정확 FAIL->롤백->진짜 fix PASS(게이트 신뢰성 재확인). model-loop 배선=D1-S6b. 다음 = D2-S3(난독화 확장)
- [done] 2026-07-12 :: D2-S3 2026-07-12 () — 난독화 해제 확장(VQ-3): dangerous-command DS-2에 NFKC(전각 ｒｍ->rm)+ANSI strip(ECMA-48) 2벡터를 파이프라인 front 추가(clean ASCII no-op=기존 무수정). DETECTION-only(executor 원본 실행). 9 신규+27 기존 무수정 36/36·mutation-RED 양방향·Opus PASS(우회 프로빙·ReDoS-safe·quote-awareness). ※baseline-repair: foreign apps/api WIP env로 envInventory red->docs:env 재생성. 다음 = D2-S4(runner stdout 시크릿 마스킹)
- [done] 2026-07-12 :: D2-S4 2026-07-12 () — subprocess 출력->모델 시크릿 마스킹(VQ-4): redactSecretsInText를 run_command(runner.ts) + 형제 skill_run(muse-tools-skills.ts) 반환 stdout/stderr 2 sink에 배선(둘 다 raw 유출됐음). truncation은 pre-redact 길이로 계산(무결). 대형출력 256KB<250ms(17.7ms 실측). 5 신규 test·mutation-RED 양방향·Opus PASS(제3형제 없음 확인). 다음 = D2-S5(calendar 암호화)
- [done] 2026-07-12 :: D2-S5 2026-07-12 () — calendar 스토어 암호화-at-rest("LAST encryption item"): memory AES-256-GCM envelope를 @muse/calendar in-package mirror(heavy dep 회피, node:crypto만; MUSE_MEMORY_KEY 재사용+MUSE_CALENDAR_ENCRYPT opt-in). local-provider read(자동감지 decrypt, wrong-key는 quarantine 밖 throw=fail-closed)+write(format-preserving). 4 라운드트립·mutation-RED 양방향·docs:env·Opus PASS(per-enc random iv/salt·no plaintext leak·ciphertext 파괴無). 암호화-at-rest 큐 완료. 다음 = D-KO-S1(truncateUtf16Safe 추출+배선)
- [done] 2026-07-12 :: D-KO-S1 2026-07-12 — truncateUtf16Safe/sliceUtf16Safe 추출(shared, truncateErrorBody 위임 byte-identical)+미안전 4곳 배선(recall/history-search 206·213, tools/tool-def 108, autoconfigure/knowledge-corpus 365, voice/tts-truncate 19·28). 한글/이모지/ZWJ 경계 유닛+byte-identical-when-safe·mutation-RED 양방향·Opus PASS. 배치(진안 지시 5슬라이스) 마지막. 다음 = D-E1(eval 집계 실-강제)
- [done] 2026-07-12 :: D1-S6b 2026-07-12 — already-satisfied(독립 Opus NO_TARGET): 5개 턴-내 회복 분기 전부 이미 at-most-once(false-done 단일호출·reverify tracker·post-compaction/ping-pong 터미널 return·repair 단일패스). 강제 배선=무동작변경 인위적 리팩터라 skip; OneShotRecoveryState는 미래 회복분기용 프리미티브. 코드변경 0(honest). 다음 = D-E1(eval 집계 실-강제)
- [done] 2026-07-12 :: D-E1a 2026-07-12 — Tier-0 오염 필터(VQ-21): eval-harness runEvalSuite가 배터리 observed에 인프라-실패 누출(backend-error/tool-failed/model-unsupported/timeout) 감지 시 total서 제외(behavior 실패 오인 방지). over-exclusion 금지(진짜 behavior 실패는 카운트 유지)·비오염 byte-identical. 4 유닛·mutation-RED 양방향·Opus PASS(over-exclusion SAFE·정밀성). D-E1 분해 a(done)/b(pre-push 확장·훅 실차단 증명, 공유인프라 이연)/c(self-eval 커밋훅+CI). 다음 = D-E1b 또는 D6-S1a
- [done] 2026-07-12 :: D6-S1a 2026-07-12 [REVERTED] — sleep-consolidation 승격 스코어는 recall-promotion.ts(scoreRecallHit+selectPromotableMemories)에 이미 있었음. 내 consolidation-score.ts는 중복 재구현 -> revert(독립 Opus REDUNDANT). lesson: 빌드 전 codegraph 기존구현 확인.
- [done] 2026-07-12 :: D6-S1b 2026-07-12 [REVERTED] — draft-first 제안. 기존 MUSE_SLEEP_PROMOTE 데몬이 opt-in auto-promote(persona write)라 로드맵 draft-first와 충돌 -> 진안 전략결정: 현상유지(opt-in 동의·reversible). 내 consolidation-proposal.ts(inert·미배선) -> revert. D6-S1c는 이미 배선(daemon-selflearn-ticks). 다음 = D-E1c 또는 D6-S3
- [done] 2026-07-12 :: D6-S3 2026-07-12 (무결성) — 메모리 외부-편집 drift 감지(VQ-7): FileUserMemoryStore가 락 안 read->write 사이 외부편집(수동·patch·락-미경유)을 compare-and-swap로 차단. read()가 raw 반환->write가 재읽기·불일치면 .bak.<ts>(복사) + MemoryExternalEditError throw로 clobber 차단. raw 비교라 plaintext/encrypted 모두. 4 write경로 배선. 외부편집 절대 clobber/삭제 안 함. opt-in(expected 없으면 byte-identical). 6 신규+47 무수정 53/53·mutation-RED 양방향·Opus PASS(never-clobber·no false-positive). ※codegraph로 미구현 사전확인함(교훈 적용). 다음 = D-E1c 또는 D6-S4
- [done] 2026-07-12 :: D6-S4 2026-07-12 (무결성, TEST-ONLY) — 자율-삭제-금지 계약: verify-first(독립 Opus)로 불변 이미 구조적 성립 확인(provenance source auto|user 존재·자율 fade 비파괴적 rank-down·자율 forget은 recalled-* synthetic만·실삭제는 user-트리거). 갭=핀 부재->mutation 계약 테스트 신설(가드 신설 X). 실 store에 user 사실 seed+non-vacuous tick(promote+fade 발화)->user 사실 잔존 검증. mutation-RED 양방향(recalled- scope 제거->RED)·프로덕션 무변경·Opus PASS. 다음 = D-E1c 또는 D6-S5.
- [open] :: [FOLLOWUP-BUG] promoteRecalledMemories `recalled-*` cleanup 무효: normalizeMemoryKey가 `-->_` 폴딩해 `recalled-N`이 `recalled_N`으로 저장, cleanup의 `key.startsWith("recalled-")`(commands-memory.ts:674)가 미매칭->매 promote마다 stale synthetic 사실 무한축적(under-deletion). fix: PROMOTED_FACT_PREFIX를 `recalled_`로 하거나 cleanup을 정규화-후 비교. user 사실 무관(D6-S4 발견).
- [done] 2026-07-12 :: D3-S3 2026-07-12 — 완료-이벤트 idle-drain 계약 핀+narrow 갭 fix(poll≠consumed): chat-ink tick이 idle을 tick 시작에만 체크->async fetch 후 삽입 직전 미체크 갭(busy 플립 시 생성 중 삽입). selectDrainedProactiveTurns 순수추출(busy면 [])+삽입 직전 idle 재체크+seen-marking을 consume 후로 이동(busy-deferred 미손실->다음 poll 재출현). 5 순수+1 통합 유닛·mutation-RED 양방향·기존 59 무수정·Opus PASS. hermes async_delegation. 다음 = D3-S6 또는 D2-S7.

- [done] :: credential_extraction 인젝션 오탐(비밀번호 관리 팁 차단) 수정 — prompt-system fire 6
- [done] :: 언어 미러링: 비-한국어 입력에 그 언어로 답하는 결정론 PromptLayer(buildLanguageMirrorLayer) — prompt-system fire 7

- [done] :: 정체성 primacy 코드 강제(caller priority clamp) — prompt-system fire 8 (감사 갭5)
- [open] :: [감사갭1·높음] 캐시 경계 죽은 기능: MUSE_CACHE_BOUNDARY 마커가 매 턴 모델에 전송되나 splitPromptCacheBoundary/strip 소비 어댑터 0 -> anthropic/gemini cache_control 배치·Ollama strip 배선, 정적 preamble을 안정 프리픽스로 이동 (prompt-system 감사)
- [open] :: [감사갭2·전략] "Learns you" 학습 user-model 동적 레이어: 현재 폼-미러링(반말/영어)만, 누적 학습(말투·약어·선호)을 memory/recall서 per-turn 블록으로 조립하는 게 빠짐 (hermes Honcho 대응)
- [open] :: [감사갭3·중] 인젝션 provenance/taint 레이어: 툴출력 유래 토큰을 untrusted 마킹·액추에이터 인자 도달 금지(정적 regex 스캐너 보완, IFC 방향)
- [open] :: [감사갭4·싸다] check:prompt-seam을 GitHub CI(.github/workflows/ci.yml)에 배선 — 현재 lint/check만, 정체성 게이트가 로컬 self-eval에만 (Ollama 불필요)

- [done] :: drift-lint 브로드닝(패러프레이즈 정체성 문자열 포착, 리터럴 2개->매처) — prompt-system fire 9 (감사 A#3)

- [done] :: 주민등록번호(RRN) 평문저장 차단 — secret-persistence 가드 national-id 패턴 (prompt-system fire 13)
- [done] :: eval:adversarial 결정론-가드 카테고리 확대(topology-bypass·obfuscation, 10->19 케이스) — a-plus-roadmap fire 55 (D2-S7)
- [done] :: eval:orchestration 래칫: MAST step-repetition·unaware-of-termination + 용량거부 라이브 pass^3 — a-plus-roadmap fire 56 (D3-S6)
- [done] :: 웹 채팅 스마트-테일 스크롤(위로 읽는 중 yank 없음, 하단근처만 tail) + 실브라우저 측정 — a-plus-roadmap fire 57 (D7-S3)
- [done] :: calendar 암호화 전 plaintext 백업(키 분실 복구용 `.plaintext-backup-<ts>`, 형제-감사=calendar 유일 갭) — a-plus-roadmap fire 58
- [done] :: [audit] dangerous-command 루트-와이프 우회 마감: `rm -rf --no-preserve-root /`(GNU rm이 순수 `rm -rf /`는 거부->이게 진짜 파괴형)·doas 래퍼·chmod/chown 인터스퍼스 long-flag — 공유 `FLAGS`(short|long) 토큰; 40 test·mutation-RED·false-positive 0·Opus PASS
- [done] :: [audit] 웹 채팅 스마트-테일 OFF-래치 수정: 스트리밍 follow smooth->auto(smooth 중간 scroll 이벤트가 빠른 스트림서 stick=false 래치->미회복); 실브라우저 확인(auto=1이벤트·distance0)
- [done] :: [audit] `MUSE_EVAL_REPEAT=0/NaN`이 eval:orchestration 게이트를 0회 실행으로 무력화 -> finite/min≥1 floor
- [open] :: [audit-followup] calendar 크로스-프로세스 파일 락(inline O_EXCL, `FileUserMemoryStore.withFileLock` 미러): 백업-레이스 ciphertext·백업 read IO-error fail-open·기존 unlocked lost-update 동시 마감(auditor TOP FIX, 락 테스트 포함)
- [done] :: [audit] dangerous-command verb-split + 래퍼 우회 마감: (b) quote/backslash(`\rm`·`'rm'`·`r''m`·`rm -r\f`) `stripShellQuoting`(공백 포함 인용은 미-unwrap->`git commit -m "rm -rf /"` 보존)·(c) 래퍼 command/exec/nohup/nice/ionice/timeout/time/xargs/setsid/stdbuf CMD_START 추가; 43 test·mutation-RED·false-positive 0(68 legit)·ReDoS ≤6.5ms·Opus PASS
- [open] :: [audit-followup] dangerous-command 잔여(a): FLAGS/R-clause 백트래킹 tighten(손수 8KB `-R`-반복 ~231ms 다항식, R-clause atomic화); 이중-래퍼(`command command rm`)·`nice -c batch rm`는 기존 비커버(신규 아님)
- [open] :: [audit·정직한 한계] dangerous-command는 **의도적으로 좁은 fail-close 백스톱**(1차 방어=run_command 승인 게이트). 정규식은 원리상 쉘 난독화 완벽차단 불가(docstring 명시). 남은 표면(재현 확인, 미차단): 변수 치환 `X=rm; $X -rf /`·`eval rm -rf /`·`find / -delete`·`> /etc/passwd`·`rm -rf $HOME/../..` traversal·`rm -rf /home`(설계상 스코프外=/·~·$HOME만). 이들 차단은 미니 쉘파서 필요(false-positive 리스크↑)—백스톱 철학상 diminishing-returns. 닫으려면 진안 명시 요청 시 변수-치환 리졸버부터
- [open] :: [audit-followup] multi-agent: `selectWorkers` `workerIds` 미-dedup(반복 벡터)·용량 silent-drop `droppedWorkerIds` 신호 부재·termination 케이스 `SubAgentRunRegistry` `timed-out` 미검증
- [done] commit=a83542ae8 :: [보안감사·fable5发굴] MUSE_LOCAL_ONLY이 CLI 임베딩 경로 미게이트 -> `muse ask/recall/note`가 원격 OLLAMA_BASE_URL로 개인텍스트 egress(라이브 재현). fix: recall `embed()`에 fail-close `classifyProviderLocality` 게이트(a83542ae8)·15 test·mutation-RED
- [done] commit=8190f5066 :: [보안감사·fable5발굴] zero-width/control로 `escapeSystemPromptMarkers` 우회(`<<en[ZWSP]d>>` 생존) + `browsing` 클래스 MARKER_KEYWORDS 누락 -> fence/citation 위조. fix: stripInjectionEvasionChars 선행+browsing 추가(8190f5066)·9 test·mutation-RED
- [done] commit=1712f5e6f :: [보안감사·fable5발굴] 주석없는 외부 MCP 도구 `risk:"read"` 기본값->승인게이트 스킵(자율 아웃바운드). fix: fail-close `write` 기본값, readOnlyHint:true만 read(1712f5e6f)·유닛+통합 test·mutation-RED
- [open] :: [보안감사·fs clean] fable5 파일시스템/샌드박스 스카우트: `resolveSafePath`(realpath+deny+O_NOFOLLOW)·id->filename 새니타이저·seatbelt SBPL 전부 견고, 재현가능 escape 0(clean). 아웃바운드 승인게이트 나머지 경로도 fail-close 확인
- [open] :: [보안 sweep-2 계획] fable5 5-스카우트 심층 감사 -> 13 findings(2 HIGH: grounding-reverify raw evidence·runner PATH override; 5 MED; 나머지 LOW/INFO), 전부 trace/repro 검증. 우선순위 계획: docs/strategy/security-sweep-2-plan.md. P0=그라운딩판정자 sanitize+PATH strip, P1=API auth fail-close·크레덴셜 암호화·feed SSRF·zip-bomb cap
- [open] :: [선행·타루프] byte-hygiene 실패: packages/shared/test/utf16-safe.test.ts:43 raw byte (D-KO-S1 e287c94f6) — D-KO-S1 소유자 수리

- [done] :: credential_extraction 과차단(도어락 잠김 self-help 차단) 수정 — forgot/unlock veto (prompt-system fire 16)

- [done] :: apps/cli lint 회귀 수리(prefer-const·no-useless-assignment) — prompt-system fire 17
- [open] :: [선행·CRITICAL·타루프] colorize가 NO_COLOR/non-TTY/plain 모드서 ANSI emit — 7 테스트 실패(tty-color·muse-banner·program), CLI/code-quality 루프 소유

- [done] :: CI에 check:prompt-seam+check:secret-guard-coverage 배선(정체성/시크릿 해자 사람PR 강제) — prompt-system fire 19 (감사 갭4)

## A+ 로드맵 — 남은 3개 감사 갭 (2026-07-12, 진안 승인: 순차 전부 + 캐시 클라우드까지)
리서치 종합 아티팩트: 3-갭 구현 계획 (Opus 리서처 A/B/C, arXiv+openclaw/hermes 소스 근거).
- [done] 2026-07-13 :: **[1순위·해자] 인젝션 provenance — 트랙 전체 완료 (2026-07-13).** S1/S2/S3 [done] · S3b [done] (725bb5a28, write-risk 싱크 + first-party 분류) · S4 [done] (2fd79eaa5, confidentiality 축 — exfil을 injection과 분리 명명).
  - **[2순위·전략] 학습 user-model** (Honcho式 2층, honesty-wall이 차별점; Mem0 라우터 2504.19413, 개인화-오염 2601.11000) — Muse ~70% 보유.
  - S1 · 공유 런타임 레이어 승격(recall/user-model-layer.ts, buildMusePersona 리프트, runtime-assembly 배선->전 surface)
  - S2 · per-turn top-K 관련성 + provenance 태그 + IrrelAcc 네거티브
  - S3 · communication-style 누적기(memory/communication-style.ts, "style" 슬롯, Mem0 ADD/UPDATE/NOOP)
  - S4 · 정직성 하드닝 + 크로스세션 라이브 eval(pass^3) + 날조 가드 + grounding 게이트 격리
  - 주의: **[3순위] 캐시 인지 배치 — 전제가 틀렸음 (2026-07-13 실측으로 반증).** 이 항목은 "gemma4는 SWA라 **로컬 프롬프트 캐시가 원천 불가**(#21468)"라는 전제 위에 세워졌고, 그래서 클라우드 `cache_control`로 우회하려 했다. **실측 결과 로컬 캐시는 완벽히 작동한다** — 동일 1.6K 프롬프트 4회: Ollama 기본값 2402/2406/2425/2427ms(캐시 전무) vs `OLLAMA_NUM_PARALLEL=1` 3163/**75**/**69**/**66**ms(**~40배**). 캐시를 죽인 건 SWA가 아니라 **Ollama 기본 병렬-슬롯 설정**이었고, Muse의 stable-prefix 설계는 처음부터 옳았다. 조치: `muse doctor`가 이를 직접 측정해 경고(b11e38daf) + setup-local-llm.md 문서화. **클라우드 cache_control 슬라이스는 불필요해졌으므로 보류** — 로컬에서 이미 40배를 공짜로 얻는다. (진안이 클라우드 라우팅을 별도로 원할 때만 재개.)
역할: 계획=Fable/Opus, 구현=Opus(설계/red)·Sonnet(정형), 슬라이스마다 라이브검증+독립 Opus 게이트+commit/push.
- [done] 2026-07-13 :: DONE (725bb5a28, 2026-07-13) injection-provenance S3b — write-risk sinks covered. first-party classification landed as a haystack BROADENING for the write class only (TaintLedger.recordFirstParty/firstPartyHaystack; muse.notes./tasks./calendar./reminders./episode./followup./pattern./history. + knowledge_search/find_contact/recall_facts/today_brief, fail-closed default), never a ledger narrowing — so send/execute keep the strict user-messages-only haystack and are byte-unchanged (a note can quote a poisoned page). Gate keys on risk==='write' (no name allowlist) over WRITE_SINK_ARG_NAMES. 4 contract-faithful enforcement tests (poisoned page -> fact = ZERO write w/ and w/o gate; own note -> task NOT flagged; user-typed fact NOT flagged), both halves mutation-RED. eval:adversarial 41/41. **Remaining: S4 (confidentiality/exfil axis).**
- [done] :: [보안 sweep-2] #7 runner 타임아웃 kill이 프로세스 트리 무시 -> 백그라운드 그랜드차일드(`sh -c "sleep 300 &"`) orphan 생존 + stdout 파이프 write-end 보유로 drainer join이 child exit 이후에도 wedge. fix: `process_group(0)`(unix)로 child를 자신의 그룹 리더화 + child 리핑 후(정상종료·타임아웃킬·wait에러 전부) `kill -KILL -<pgid>`로 그룹 전체 스윕(신규 dep 없음, 기존 sandbox-exec 셸아웃 패턴 재사용) + drain join을 mpsc `recv_timeout`으로 bound(잔존 파이프 보유자가 있어도 자체 타임아웃 못 넘음). mutation-first 테스트(fix 전 실패 확인: 2s wedge+orphan 마커파일 생성 / fix 후 통과) + 기존 39개 전부 pass, clippy clean. docs/strategy/security-sweep-2-plan.md 갱신.
  - DEFER (2026-07-15, 실사용 갭 시리즈 S8) 웨이크워드/연속 음성 — 평가만 하고 보류. 근거: Porcupine은 macOS/Swift SDK로 온디바이스 가능하나 무료여도 Picovoice AccessKey 필수(로컬 기능에 벤더 키 의존), openWakeWord는 ONNX 사이드카 필요(Swift NSPanel 앱에 부자연), 상시 마이크는 Observe 원칙(가시·일시정지·검사가능) 추가 요구, 이미 배선된 글로벌 핫키(Ctrl+Option+Space) 대비 체감 이득 소폭. 데스크톱 컴패니언 다음 이터레이션에서 재평가; 그때는 openWakeWord 사이드카 또는 BYO Picovoice 키 + 상시 마이크 인디케이터/pause 필수.
- [done] 2026-07-16 :: [source-quality] Rust runner request-env execution boundary (2026-07-16) — `env_clear` baseline에서 request environment가 Git/Cargo/Rustup/OpenSSH의 executable, helper, toolchain, or config-discovery path를 재선택하지 못하도록 exact/prefix/suffix deny를 강화. 44 runner contracts + build 및 독립 runtime review PASS.
- [decision] :: Builder "도구 실행" (mcp_tool) 흐름 피커는 v1에서 `risk==="read"` 도구만 노출(fail-close, `readRiskToolOptions`) — 무인 스케줄 실행에 write/execute 도구를 허용할지, 허용한다면 어떤 승인/2차 확인 UX를 요구할지는 진안 결정 필요 (builder-evolution fire 2).
