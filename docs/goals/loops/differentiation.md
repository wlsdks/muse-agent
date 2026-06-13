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

## fire 4 · 2026-06-13 · skill v1.14.0 · `<pending-commit>`
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
