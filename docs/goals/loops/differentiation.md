# Loop journal — `differentiation` (경쟁 차별점 발굴 → edge 확장)

> Theme: discover where Muse wins **structurally** vs hermes (Nous, MIT) /
> openclaw (MIT) and widen it with a verifiable code slice each fire. Worktree
> `/tmp/muse-differentiation` (branch `loop/differentiation`, Tier1 — local
> commits only, no push). Cited research lands in
> [`docs/strategy/differentiation.md`](../../strategy/differentiation.md).

## fire 1 · 2026-06-13 · skill v1.14.0 · `2d1662df`
meta: value-class=new-capability · pkg=scripts/self-eval · kind=release-gate-ratchet · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 912 · self-eval gates +1 (egressGuards=5) · fabrication 0 · grounding ratchet untouched

- **무엇**: Muse의 2번째 해자(local-by-construction — "cloud egress refused in
  code", MUSE_LOCAL_ONLY 기본 ON)를 grounding 해자와 동급의 **결정적 self-eval
  회귀 게이트**로 승격. `countEgressGuards`(`scripts/self-eval.mjs`)가 gated
  cloud ids(`CLOUD_PROVIDER_IDS`) + fail-close `throw new LocalOnlyViolationError`
  사이트를 합산(현재 5) → `gates.egressGuards` → `detectRegressions`가 하락을
  자동 포착. RGV/grounding ratchet(`countGroundedSurfaces`) 패턴 그대로 미러.
- **왜 (어떤 경쟁 레버 대비)**: hermes/openclaw 둘 다 Ollama를 *지원*하지만
  cloud가 기본/권장(hermes 가이드는 Claude Sonnet 4.6을 best model로 명시). 그들은
  "cloud egress 가능해지면 빌드 실패"라는 게이트를 *만들 수 없다* — 자기 제품을
  막기 때문. Muse만 이 불변식을 기계적으로 방어할 수 있는 구조적 우위. (hermes의
  "Hallucination Gate"도 모델 self-prompt지 결정적 코드가 아님 — 같은 비대칭이
  grounding 해자에도 성립.)
- **리뷰지점**: TDD RED(export 없음 SyntaxError)→GREEN(12/12). OUTCOME
  falsification 독립 재현(maker≠judge, Opus judge): 직전 엔트리=5에서 cloud id
  1개 제거 → `pnpm self-eval` exit **1** + `egressGuards: 5→4`; 복원 → exit **0**.
  throw-site 삭제도 4 반환 확인. lint:pass(전체 트리). ④b Opus 적대 judge 5/5 PASS.
- **리스크/residual (비차단, 다음 슬라이스 연료)**: ① 마커 취약성 — 정규식이
  `new Set([...double-quote...])` 형식에 결합(array/single-quote 리팩터 시 0 반환).
  단 그 방향은 카운트를 *낮춰* 회귀를 loud하게 발화시키지 조용히 죽지 않음(위험한
  "약화인데 동일/상승 카운트" 방향은 없음). ② 커버리지 갭 — voice registry
  cloud-key-ignore + localhost-only embeddings 가드는 아직 미포함 → ratchet에
  편입하면 해자 커버리지 확장(backlog ◦).

## fire 2 · 2026-06-13 · skill v1.14.0 · `52d69df6`
meta: value-class=new-capability · pkg=scripts/self-eval · kind=ratchet-coverage-widen · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 912 · egressGuards 5→6 (voice guard now counted) · fabrication 0 · grounding ratchet untouched

- **무엇**: fire 1의 `countEgressGuards` ratchet을 **voice egress 가드**까지 확장.
  세 번째 마커 추가 — voice 레지스트리가 `MUSE_LOCAL_ONLY` 하에 OpenAI 키를
  `undefined`로 강제(`parseBoolean(env.MUSE_LOCAL_ONLY, true) ? undefined`)해 mic
  오디오의 cloud STT/TTS 유출을 차단하는 지점. egressSources에 `voice.ts` 추가, 값 5→6.
- **왜 (어떤 경쟁 레버 대비)**: L1 해자(local-by-construction) 커버리지 확장 —
  fire 1은 모델-라우터 egress만 게이팅했고, 마이크 오디오 경로는 또 다른 egress
  표면. cloud STT/TTS가 기본인 hermes/openclaw는 "voice 가드 사라지면 빌드 실패"
  ratchet을 만들면 자기 제품을 막는다. 같은 구조적 비대칭.
- **리뷰지점**: TDD RED(voice 마커 미카운트 fail)→GREEN(13/13). OUTCOME
  falsification 독립 재현(Opus judge, maker≠judge): prev=6에서 voice 가드 무력화
  (`true`→`false`) → `pnpm self-eval` exit **1** + `egressGuards: 6→5`; 복원 → exit 0.
  마커 오탐 0(라우터의 `if (...)` 형 `parseBoolean(MUSE_LOCAL_ONLY,true)`는 `? undefined`
  꼬리로 정확히 배제). lint:pass. ④b Opus 적대 judge 4/4 PASS.
- **리스크/residual (비차단)**: ① voice 가드를 삼항이 아닌 패턴(early-return 등)으로
  리팩터하면 count가 *낮아져* loud 회귀(의도된 fail-loud지만 마커도 함께 업데이트
  필요). ② localhost-only embeddings 가드는 여전히 미포함(그 이름의 파일을 못 찾음 —
  위치 확인 필요) → 별도 ◦로 남김.

## fire 3 · 2026-06-13 · skill v1.14.0 · `d30f9785`
meta: value-class=new-capability · pkg=scripts(@muse/memory proof) · kind=adversarial-proof-battery · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 912 · new deterministic battery eval:memory-poisoning (no Ollama) · fabrication 0 · egressGuards 6 untouched

- **무엇**: 새 결정적 적대 proof 배터리 `scripts/eval-memory-poisoning.mjs`
  (`pnpm eval:memory-poisoning`). fire 1-2의 self-eval ratchet vein을 떠나 **다른
  KIND·다른 surface**(@muse/memory 증명). 메모리 승급의 WRITE-시점 provenance 게이트
  (`dropModelAssertedValues`)가 poisoned model-asserted claim을 5회 주입마다 드롭함을,
  그리고 *같은* claim이 forged hits면 `selectPromotableMemories` frequency 게이트를
  통과함을(=경쟁사는 승급, Muse write-gate가 막음), user-stated 값은 둘 다 통과함을
  (no-collateral) 실측 증명.
- **왜 (어떤 경쟁 레버 대비)**: L2 — OpenClaw "Dreaming"(minRecallCount 3 +
  frequency score)·Hermes(FTS5+LLM summarize)는 자주 회상된 거짓 주장을 승급(GROUNDED≠TRUE
  on memory surface). 그들 frequency-promotion에 write-time provenance drop을 더하면
  "agent가 자기 답에서 학습" 기능을 죽이므로 구조적으로 못 따라온다. Muse는 그 drop이
  곧 제품이라 비용 없음.
- **리뷰지점**: 배터리 PASS 4/4. OUTCOME falsification 독립 재현(Opus judge, maker≠judge):
  `dropModelAssertedValues` 무력화(`if(!modelAsserted)`→`if(true)`)+rebuild → 배터리
  exit **1** scenario 1 ✗; 복원+rebuild → exit **0**. scenario 2가 *실제*
  `selectPromotableMemories` export를 호출(하드코딩 아님)함을 judge가 dist에서 확인.
  TS 소스 0줄 변경(순수 새 스크립트 + package.json 1줄). lint:pass · self-eval 회귀 0.
- **리스크/residual (비차단)**: ① scenario 2의 forged-hits는 실제 recall pass가 아닌
  inline 합성(결정적 unit 증명엔 적합하나, 주입이 실제 hit를 만든다까진 증명 안 함).
  ② 배터리는 dist 빌드 의존(package.json 스크립트가 처리; bare `node`는 src 편집 後
  수동 rebuild 필요). → CI 번들 편입 시 명시.

## fire 4 · 2026-06-13 · skill v1.14.0 · `ee50c9d5`
meta: value-class=new-capability · pkg=@muse/autoconfigure · kind=egress-gap-closure(fail-close) · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 914→915 · egressGuards 6→7 (embedder guard folded in) · fabrication 0 · grounding floor 강화

- **무엇**: L1 해자의 **실제 egress 갭**을 닫음. `createOllamaEmbedder`
  (`@muse/autoconfigure/context-engineering-builders.ts`)가 `OLLAMA_BASE_URL`을
  local-only 게이트 없이 따라 사용자 노트/메모리/episode **평문**을 remote
  `/api/embeddings`로 보낼 수 있었다. construction-time fail-close 추가
  (`MUSE_LOCAL_ONLY` 기본 ON + non-loopback → `throw LocalOnlyViolationError`,
  @muse/model의 `isLoopbackUrl` 재사용); 3개 호출부 + daemon 우회를 단일 chokepoint로 커버.
  새 throw를 egressGuards ratchet에 편입(6→7)해 가드 자체를 self-protect.
- **왜 (어떤 경쟁 레버 대비)**: chat 라우터는 `providerId==="ollama"`일 때만
  OLLAMA_BASE_URL을 검사 → localhost LM-Studio/openai-compatible chat + remote
  OLLAMA_BASE_URL이 **분기**해 chat 게이트를 통과하지만 embedder는 egress; daemon
  enrich 경로는 라우터를 아예 우회. architecture.md의 "embeddings localhost-only"
  주장이 remote OLLAMA_BASE_URL엔 거짓이었음. cloud-default 경쟁사는 임베딩을 외부
  API로 보내는 게 기본이라 이 fail-close를 할 구조적 동기가 없음(L1과 같은 비대칭).
- **리뷰지점**: TDD RED→GREEN. 행동 테스트 6 케이스(remote+local-only → throw
  **AND fetch 0회**=평문 미전송; loopback/미설정/localhost/opt-out 통과; remote+
  local-only=false → 실제 remote POST 확인). ④b 독립 Opus judge **5/5 PASS**:
  갭 진짜(파일:라인 확인)·가드 줄 제거 falsification 재현(fail-close 단언 2건 FAIL)·
  over-block 0·autoconfigure 519/519·불변식 *강화*. lint:pass.
- **리스크/residual (비차단)**: `muse doctor`/`evaluateLocalOnlyPosture`가 아직
  embedder의 OLLAMA_BASE_URL 로컬리티를 리포트 안 함(런타임 egress는 차단되나 doctor
  맹점) → 후속 ◦. architecture.md 주석도 이 enforcement 지점을 반영하면 좋음.

## fire 5 · 2026-06-13 · skill v1.14.0 · `54c5237f`
meta: value-class=wiring · pkg=@muse/autoconfigure · kind=posture-transparency · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 915 · egressGuards 7 (리포팅 추가, throw 아님→불변) · fabrication 0 · grounding floor 유지

- **무엇**: fire 4의 embedder fail-close를 `muse doctor` posture에 노출(L3 완성).
  `evaluateLocalOnlyPosture`(`setup-status.ts`)가 chat 라우터(`createModelProvider`)만
  재실행해 embedder base를 안 봐서 — local-only ON + **remote OLLAMA_BASE_URL**이면
  런타임은 fail-close되는데 doctor는 "🔒 ok"로 거짓 안심을 줬다. local-only ON 브랜치에
  embedder base 로컬리티 검사 추가(`isLoopbackUrl`, fire-4 가드와 동일한 base 해석) →
  off-box면 status `"fail"` + OLLAMA_BASE_URL 안내.
- **왜 (어떤 경쟁 레버 대비)**: "shows its work"를 claim-grounding에서 **정직한
  egress-posture 리포팅**으로 확장. doctor가 런타임과 갈라지지 않게(같은 base 해석) —
  cloud-default 경쟁사는 보여줄 egress posture 자체가 없다.
- **리뷰지점**: TDD RED(remote 케이스 ok→fail 안 됨)→GREEN. 분기 정확: remote 케이스가
  `MUSE_MODEL=lmstudio/llama`(LOCAL chat)라 chat 라우터는 통과하고 embedder 체크가
  발화(ollama chat이면 라우터가 먼저 throw해 무의미 — 회피). posture↔런타임 base 해석
  parity 확인. ④b 독립 Opus judge **5/5 PASS** + 체크 제거 falsification 재현.
  autoconfigure 522/522 · lint:pass · self-eval 회귀 0.
- **리스크/residual (비차단)**: posture와 런타임 가드가 base 해석을 손으로 일치시킴(두
  string 리터럴) — 향후 embedder base 해석 변경 시 둘 다 같이 움직여야 함;
  `resolveEmbedderBase()` 공유 헬퍼로 구조화하면 convention→structural(별도 ◦ 가능).

## fire 7 · 2026-06-13 · skill v1.14.0 · `e985551d`
meta: value-class=refactor · pkg=@muse/autoconfigure · kind=parity-hardening · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 922 · egressGuards 7 (불변) · fabrication 0 · grounding floor 유지

- **무엇**: fire 5 residual 해소 — fire 4 런타임 가드와 fire 5 doctor posture가 각자
  string 리터럴로 하던 embedder base 해석을 공유 헬퍼 `resolveEmbedderBase(env)`
  (`packages/autoconfigure/src/embedder-base.ts`)로 추출, 두 호출부가 그걸 쓰게 리팩터.
- **왜 (어떤 경쟁 레버 대비)**: L3 해자 *durability* — doctor↔런타임 base 해석이
  손으로 두 군데 유지되면 한쪽만 바뀌어 "doctor가 런타임과 다른 posture 리포트"하는
  drift가 가능. 공유 헬퍼로 parity를 convention→**structural**로 만들어 "shows its
  work"(정직한 egress posture)를 미래 변경에도 깨지지 않게 함.
- **리뷰지점**: behavior-preserving 리팩터 — 헬퍼 4 케이스 TDD + 기존 fire-4 가드/fire-5
  posture 스위트 그대로 green(532/532). ④b 독립 Opus judge **4/4 PASS**: 옛 런타임
  `(trimmed && len>0)?trimmed:default` ↔ 헬퍼 `?.trim()||default`가 empty/whitespace/
  undefined에서 bit-identical임을 증명, 두 호출부 모두 헬퍼 사용·인라인 잔존 0, egress
  throw 그대로·egressGuards 7 불변. lint:pass.
- **리스크/residual (비차단)**: 없음(material). 다음 fire는 local-by-construction vein을
  충분히 팠으니(L1/L3 4 fire) 다른 moat 축(grounding/"shows its work")의 새 레버로
  다양화 권장.

## fire 8 · 2026-06-13 · skill v1.14.0 · `33c3390d`
meta: value-class=new-capability · pkg=@muse/recall · kind=citation-honesty(shows-its-work) · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 922 · new battery eval:receipt-drift (no Ollama) · recall 88/88 (backward-compat) · fabrication 0 · grounding 엔진 미수정

- **무엇**: L4(다른 moat 축 = "shows its work" 인용 정직성). source receipt가 인용
  snippet을 retrieval-INDEX 복사본이 아니라 **디스크 파일 현재 내용**에 대해 검증.
  `formatSourceReceipts`(`@muse/recall`)에 backward-compat optional `diskContents`
  맵 추가 — snippet이 현재 디스크에 없으면(편집) 또는 null이면(삭제) **stale quote
  숨기고 사유 표시**(fake citation 방지). 순수 헬퍼 `snippetOnDisk`(… 절단+normalize).
  새 결정적 배터리 `scripts/eval-receipt-drift.mjs`가 REAL temp 파일로 end-to-end 증명.
- **왜 (어떤 경쟁 레버 대비)**: 경쟁사는 RAG 구조상 embedded/index 복사본에서 인용 —
  render-time 디스크 재독을 할 product 이유가 없다(throughput/breadth 피치). 노트가
  인덱싱 後 편집/삭제되면 그들 "인용"은 fake citation이 된다. Muse는 local·single-user·
  "shows its work"가 곧 제품이라 자기 노트 재독이 cheap → 구조적 edge. (AIS 원칙·
  arXiv 2409.11242 인용.)
- **리뷰지점**: TDD RED(diskContents 없을 때 drift 미감지 3 fail)→GREEN(present 27/27,
  5 신규 케이스가 실제 downgrade 동작 단언). 배터리 PASS 7/7. ④b 독립 Opus judge **4/4
  PASS** + falsification 재현(`snippetOnDisk`→`return true` → 배터리 exit 1, drift 2건
  ✗; sed 역복원→PASS). recall 88/88·cli 빌드 OK(backward-compat)·grounding 엔진 미수정.
  **함정 기록**: falsification에서 `git checkout present.ts`가 미커밋 구현을 날려 재적용함 —
  미커밋 파일엔 git checkout 금지, falsify는 sed 역적용으로.
- **리스크/residual (비차단, slice 2)**: CLI 호출자(`commands-ask.ts`)가 cited 노트의
  현재 디스크 내용을 읽어 `diskContents`를 채워야 *사용자 receipt*에 실제 작동(경로해석+
  ad-hoc `--url`/`--clipboard` 스킵이 자체 테스트 필요) → backlog ◦. 그 전까진 로직은
  라이브·검증됨이나 사용자 노출은 deferred.

## fire 9 · 2026-06-13 · skill v1.14.0 · `8dc2f44d`
meta: value-class=test-coverage(JUDGE-DRILL) · pkg=@muse/recall · kind=judge-drill · verdict=PASS · firesSinceDrill=0
ratchet: testFiles 922 · recall 89/89 · fabrication 0 · grounding 엔진 미수정

- **무엇**: 연속 allPASS 8 도달 → mandated **JUDGE-DRILL**. fire-8 `snippetOnDisk`의
  `…`-절단 처리가 end-to-end 미테스트인 실제 갭을 타깃. ① 고의 **inert** 테스트 주입
  (`toBeDefined`+`toContain("📎")` — 절단/검증과 무관하게 trivially 참) → ② ④b 독립
  Opus judge가 **FAIL** 판정(mutation으로 inert 입증: snippetOnDisk 무력화해도 통과) →
  ③ 롤백 → ④ 진짜 discriminating 테스트(faithful 절단 snippet 표시+`…` 포함 / drift 숨김+
  "changed since" 대조).
- **왜**: maker≠judge 보상통제 검증 — 같은-모델 천장(Opus)에서 verifier가 rubber stamp가
  아님을 주기적으로 증명. 부수 가치: fire-8 L4의 `…`-절단 디스크검증 경로를 락다운(실제
  커버리지 +1).
- **리뷰지점**: 드릴 양방향 입증 — inert 버전은 judge가 FAIL(snippetOnDisk `return true`
  무력화해도 PASS = 비차별) · 진짜 버전은 같은 무력화에 **FAIL**(discriminating) → sed
  복원(git checkout 금지, fire-8 함정 회피) → recall 89/89·present 28/28·lint:pass·
  self-eval 회귀 0. firesSinceDrill 0 리셋.
- **리스크/residual (비차단)**: 없음. L4 slice 2(CLI wiring)는 여전히 열린 ◦.

## fire 10 · 2026-06-13 · skill v1.14.0 · `1860c9a7`
meta: value-class=wiring · pkg=@muse/recall+apps/cli · kind=L4-live(citation-honesty) · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 926 · recall 95/95 · cli 빌드 OK · fabrication 0 · grounding 엔진 미수정

- **무엇**: L4 slice 2 — fire 8의 disk-verify 로직을 **사용자 라이브화**. 새 exported
  async 헬퍼 `buildDiskContents(answer, chunks, notesDir, verifyTargets?)`(@muse/recall)가
  cited 노트의 현재 디스크 내용을 읽어 맵 구성(present→내용·gone→null·ad-hoc→skip;
  경로해석은 `collectCitedNoteAges`와 char-identical). `commands-ask.ts` receipt 렌더
  직전에 호출해 `formatSourceReceipts` 6번째 인자로 전달.
- **왜 (어떤 경쟁 레버 대비)**: fire 8 judge가 "사용자 가치 전환 필수"로 표시한 wiring —
  이제 `muse ask`가 indexing 後 편집/삭제된 노트의 stale snippet을 **실제로 숨김**
  (fake-citation 방지가 사용자-노출). 경쟁사 cloud-RAG는 render-time 디스크 재독을 안 함.
- **리뷰지점**: TDD RED(buildDiskContents 미존재 2 fail)→GREEN(present 30/30, 2 신규가
  present/gone/ad-hoc + end-to-end drift-숨김 단언). ④b 독립 Opus judge **4/4 PASS** +
  falsification 재현(`readFile`→빈문자열 → present-내용 단언 깨짐 = 실제 파일 읽음 입증).
  recall 95/95·cli 빌드 OK·grounding 엔진 0줄·IO는 cited 노트만 재독.
- **리스크/residual (비차단)**: end-to-end drift 테스트는 빈/누락 내용도 drift 경로를
  타므로 "진짜 읽는지"는 test 1이 단독 핀(judge 관찰; test 2 이중핀은 선택 강화). L4
  네 케이스(L1/L2/L3/L4) 중 L4가 이제 완전 라이브.

## fire 11 · 2026-06-13 · skill v1.14.0 · `f5bf7362`
meta: value-class=new-capability · pkg=scripts(@muse/mcp proof) · kind=adversarial-proof-battery · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 928 · new deterministic battery eval:action-log-tamper (no Ollama) · fabrication 0 · 소유-루프 파일 미수정

- **무엇**: L5(새 축 = 감사가능성/tamper-evidence). 새 결정적 적대 배터리
  `scripts/eval-action-log-tamper.mjs`(`pnpm eval:action-log-tamper`). 모든 자율 액션
  (performed+refused)이 genesis-anchored SHA-256 해시체인으로 봉인됨을 REAL temp 파일로
  end-to-end 증명: intact verify·content-tamper 탐지·deletion/reorder 탐지·refused 체인·
  undo accountable+체인유지·no-collateral. @muse/mcp의 *이미 export된* 심볼
  (`appendActionLog`/`verifyActionLogChainFile`/`undoLoggedAction`/`readVetoes`)을
  read-only import(fire3 @muse/memory·fire8 @muse/recall 패턴).
- **왜 (어떤 경쟁 레버 대비)**: 경쟁사는 액션/mutation 이력을 평범한 mutable state로 취급 —
  hermes는 whole-skill 스냅샷-복원만(무결성 체크 없음), openclaw는 승급된 메모리 undo 불가
  (#62184 not-planned). per-action 해시체인 무결성은 throughput 제품엔 비용일 뿐이고
  "자유로운 자기-mutation" 피치와 구조적으로 상충 — single-user "조용히 못 고친다" 정체성엔
  그 체인이 곧 trust contract. (정직한 scope: tamper-EVIDENT지 tamper-PROOF 아님 — 동기있는
  공격자의 전체 재계산은 off-box anchor 필요, 소스에 out-of-scope 명시.)
- **리뷰지점**: 배터리 PASS 10/10. ④b 독립 Opus judge **4/4 PASS** + falsification 재현
  (`verifyActionLogChain` 무력화→배터리 exit 1, tamper/deletion/reorder 3건 ✗ → Edit 복원,
  git checkout 금지). REAL export 구동(mock 아님) judge가 dist 확인. mcp src/agent-core/
  recall/grounding 0줄(git status 2파일만). lint:pass·self-eval 회귀 0.
- **리스크/residual (비차단)**: 경쟁사 비교 주장(hermes 무결성 없음·openclaw #62184)은
  배터리 주석의 narrative지 실행 단언 아님(Muse 측 속성은 완전 증명). 체인 tip은 다음
  append로 봉인(append-local, 소스 명시). 선택: self-eval에 tamper-guard ratchet 편입.

## fire 12 · 2026-06-13 · skill v1.14.0 · `ad7c21cb`
meta: value-class=new-capability · pkg=scripts(@muse/policy proof) · kind=adversarial-proof-battery · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 929 · new deterministic battery eval:policy-symmetry (no Ollama) · fabrication 0 · 소유-루프 파일 미수정

- **무엇**: L6(새 축 = deterministic-safety-as-code). 새 결정적 배터리
  `scripts/eval-policy-symmetry.mjs`(`pnpm eval:policy-symmetry`). @muse/policy 가드가
  **모델-독립·언어-대칭** 코드임을 증명: injection을 EN/KO/CN 동일 탐지, zero-width/
  homoglyph/HTML-entity 난독화도 정규화(`normalizeForInjectionDetection`) 後 탐지,
  난독화 PII도 `findPii`로 탐지, `maskPii` 비파괴(원본 미변경, 새 string 반환), benign
  prose 과차단 0. @muse/policy의 이미 export된 가드 read-only import(policy 무소유).
- **왜 (어떤 경쟁 레버 대비)**: 경쟁사는 prompt-기반/모델 self-policing이거나 narrow —
  hermes 가드는 EN-focused+context-file 스코프, PII redaction은 output-only·off-by-default·
  **disk 파괴**(#5322 소스파일에 `***` 기록); openclaw는 bolt-on NeMo(stateless-single-turn
  가정). Muse는 "security는 결정적 코드, prompt 아님"(CLAUDE.md)이 정체성 → 모델 교체/언어
  비대칭에 안 깨짐. (정직 scope: 가드 *속성* 증명, 모든 라이브 표면 wiring 주장 아님 —
  L2/L4/L5처럼 code-property proof.)
- **리뷰지점**: 배터리 PASS 13/13. ④b 독립 Opus judge **4/4 PASS** + falsification 재현
  (`normalizeForInjectionDetection` no-op → 배터리 exit 1, 난독화 4건 ✗ → Edit 복원, git
  checkout 금지). EN/KO/CN 탐지·비파괴마스킹·과차단0 judge가 직접 `node -e` 재현. policy
  src/agent-core/recall/mcp/grounding 0줄(git status 2파일만). lint:pass·self-eval 회귀 0.
  zero-width은 `​` 이스케이프(raw byte 없음).
- **리스크/residual (비차단)**: 경쟁사 비교 인용(hermes #5322 등)은 narrative지 실행 단언
  아님(Muse 측 속성은 완전 증명). 가드 wiring 라이브 검증은 owned-loop 영역이라 deferred.
