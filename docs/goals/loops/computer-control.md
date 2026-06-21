# computer-control — Muse computer-control 축 강화 루프 journal

> Theme: 로컬 12B(gemma4)가 멀티스텝 컴퓨터 작업(@muse/fs file_read/grep/edit/multi_edit + run_command)을 end-to-end 신뢰성 있게 완수 + 모든 actuator 단계가 근거 게이트(read-before-edit·fabrication=0) 통과. 측정 baseline `eval:computer-task`(report-only) 올리기.
> Worktree `/tmp/muse-computer-control` · branch `loop/computer-control` (Tier2 — 매 fire push, 주기적 main rebase, **3 fire마다 main ff-merge**). retheme from core-hardening (진안-picked 2026-06-20).
> Cron `47491301` (every 20m, session-only; re-registered 2026-06-21 from ready/2-computer-control.md — prior `18d30a58` expired with its session). Stop: `CronDelete 47491301`. Convention: [README](README.md).
> NOTE: fires 1-2 docs는 동시-루프 INDEX 충돌 cascade로 rebase 대신 origin/main 리셋 후 fire 3에서 통합 재기록(히스토리 보존; fire 1-2 해시 ee635ab0/8ea83aab는 orphaned but 기록용).

## fire 42 · 2026-06-21 · skill v2.0 · 8f9066aa (stringified-JSON object/array tool-arg coercion — multi_edit edits-as-string)
meta: value-class=new-capability · pkg=@muse/tools · kind=arg-coercion/structured-repair · verdict=PASS · firesSinceDrill=5
ratchet: testFiles +0 files / +1 case (coerceToolArguments structured: positive·whitespace·already-structured·both type-mismatches·non-JSON·empty·bare-scalar) · fabrication 0 · @muse/tools 89 pass/1 skip · pnpm check exit 0 · lint 0/0 · Ollama DOWN (evals skip) · main ff-merge (fire 42 = ×3)
- 무엇: tool-calling 결정론 "repair" 절반(`tools-argument-validation.ts`의 coerceToolArguments)이 SCALAR 인자만 교정("5"→5)하고 object/array 타입 인자엔 아무것도 안 했음. 12B가 구조화 인자를 JSON 문자열로 흘리면(예: file_multi_edit의 `edits`가 `"[{...}]"`) 데이터는 맞는데 호출 실패. FIX: `coerceStructured` 추가 — 값이 비지 않은 문자열이고 JSON.parse 성공 + 파싱 타입이 선언 타입과 일치(array→Array.isArray, object→isRecord=null·array 제외)할 때만 파싱값 반환, 그 외 untouched. coerceScalar의 구조화 짝(arXiv:2509.18847). 공유 함수라 ReAct executor + plan-execute 둘 다 자동 적용.
- 왜: 다양성 — fires 40/41은 @muse/model/parse 2연속, fs는 소진. 이번은 @muse/tools/arg-coercion = fresh (pkg,kind). on-theme(멀티스텝 파일편집 multi_edit). fabrication-safe(파싱만, 데이터 발명 0). minLength 부재로 empty-required-string 대안은 inert라 기각, 구조화-coercion이 진짜 갭.
- 리뷰지점: mutation-first 확정(routing을 coerceScalar로 되돌리면 정확히 1 RED). 독립 Opus ④b judge가 fabrication=0·isRecord(null·array 제외) 타입가드·downstream(validateEnum object 스킵·required는 []/{} present로 정확)·idempotence·diversity 전부 검증 → VERDICT PASS.
- 리스크: live OUTCOME 미검증(Ollama down)이나 순수 함수라 결정론 테스트로 완전 커버. judge가 cosmetic 노트(line 23-34 module 독스트링이 scalar-only로 약간 stale, pre-existing) — 비차단, 슬라이스 집중 위해 미수정.

## fire 41 · 2026-06-21 · skill v2.0 · 83697e69 (OpenAI-family tool-call NAME sanitization — fire-11 Ollama-adapter sibling)
meta: value-class=new-capability · pkg=@muse/model · kind=provider-parse-robustness/tool-name-sanitization · verdict=PASS · firesSinceDrill=4
ratchet: testFiles +0 files / +35 lines (provider-openai-parse: 3 name-sanitization OUTCOME + 3 sanitizeToolCallName unit) · fabrication 0 · @muse/model 375 pass/5 skip · byte-hygiene 44/44 · pnpm check exit 0 · lint 0/0 · Ollama DOWN (evals skip)
- 무엇: agent-hardening fire-11이 Ollama 네이티브 어댑터에서 고친 tool-call NAME 오염(thinking 로컬모델이 `<|channel|>` 등 chat-template 마커/제어·zero-width 문자를 이름에 흘려 tool-not-found)의 OpenAI-호환 형제. compat 경로(`/v1/chat/completions` — LM Studio·OpenRouter·Ollama-compat, 같은 로컬모델 구동)는 tool-call 이름을 RAW로 파싱. FIX: `sanitizeToolCallName`(fire-11 함수)을 공유 리프 `provider-shared.ts`로 끌어올려(양 어댑터 공유) OpenAI-family 4개 NAME 파싱 사이트 전부 배선 — parseOpenAIToolCalls(compat chat=로컬 주 타깃) + Responses non-stream/stream + chat-stream materialize(델타 청크 아닌 최종 조립 지점; merge는 first-wins라 안전). cut/strip/`"unknown"`만 — 모델 미방출 이름 발명 0(fabrication=0).
- 왜: 형제-감사(fire 40이 같은 compat 경로의 ARG-drop 형제를 닫음 → 이번이 NAME 형제, 한 쌍). 다양성: @muse/model 2연속이나 8-fire 창에서 2/8(ratchet 미발동), kind는 args→name으로 구분. 4 사이트 동종 변경을 한 슬라이스로 배치(형제 누락 방지).
- 리뷰지점: mutation-first 확정(site 1 되돌리면 정확히 2 RED, clean-name은 GREEN=no-op 증명). 독립 Opus ④b judge가 스트림 merge 추적·byte-hygiene line 63 리터럴 \\u 확인·relocation git show HEAD~6 대조 → VERDICT PASS. sites 2-4(Responses=주로 클라우드)는 private materializer라 독립 OUTCOME 하네스 대신 공유 단위테스트+1줄 배선(비례적; 로컬-leak 표면은 OUTCOME 커버된 site 1에 집중).
- 리스크: byte-hygiene 함정 1회 자가적발·수정(Edit가 \\uXXXX를 raw 바이트로 디코드 → perl로 리터럴 \\u 재작성, test는 String.fromCharCode(0x200b) 사용). live OUTCOME 미검증(Ollama down)이나 순수 파서라 결정론 테스트로 완전 커버. fire 41은 3의 배수 아님 → main 머지 없음.
lesson: Edit/Write 도구는 new_string의 `\\uXXXX`를 raw 제어바이트로 디코드한다 — 소스에 리터럴 escape가 필요하면 (a) perl/sed로 후처리하거나 (b) 런타임 문자가 필요하면 String.fromCharCode를 써라. byte-hygiene 게이트가 잡기 전에 cat -v로 자가확인.

## fire 40 · 2026-06-21 · skill v2.0 · e94e45be (OpenAI-compatible parseToolArguments recovery — fire-15 Ollama-adapter sibling)
meta: value-class=new-capability · pkg=@muse/model · kind=provider-parse-robustness/sibling-audit · verdict=PASS · firesSinceDrill=3
ratchet: testFiles +1 (provider-openai-parse recovery describe, 5 mutation-valid recovery + 1 fabrication-guard) · fabrication 0 · @muse/model 369 pass/5 skip · pnpm check: @muse/auth SIGABRT(134)=box saturation (auth 61/61 isolated, zero @muse/model dep) · byte-hygiene 44/44 · lint 0/0 · Ollama DOWN (eval:computer-task/multifile-fix/edit-run-verify skip)
- 무엇: `parseToolArguments` (`provider-openai-parse.ts` — OpenAI-compatible `/v1/chat/completions` path backing LM Studio·OpenRouter·Ollama-compat) had the exact drop-on-defect bug agent-hardening fire-15 fixed in the Ollama native adapter: `catch { return {} }` silently dropped ALL of a local model's tool args when the `arguments` string carried a recoverable surface defect (markdown fence / preamble prose). FIX: lifted `recoverToolArgsJson`+`isPlainObject` from adapter-ollama into the shared leaf `provider-shared.ts` (both adapters already import it; no cycle), re-pointed the barrel export, and wired the catch branch to `recoverToolArgsJson(value)` re-guarded by `isJsonObject` (mirrors safeParseToolArgs). LOCATE-only → recovered values byte-faithful, fabrication=0 intact.
- 왜: 다양성 RATCHET — fires 35/36/38/39 all @muse/fs; this fire is @muse/model / provider-parse-robustness (different pkg+kind), closing the precise sibling fire-15 flagged. 형제-감사 완성: ollama native + openai-compat tool-arg parsers now share ONE recovery leaf.
- 리뷰지점: mutation-first confirmed (revert catch→`return {}` ⇒ exactly the 5 recovery tests RED, 13 guard/passthrough GREEN; restore ⇒ 18/18). Independent Opus ④b judge re-ran the mutation + audited fabrication/relocation/barrel/auth-attribution → VERDICT PASS.
- 리스크: live OUTCOME unvalidated (Ollama down → evals skip), but the fix is a PURE parser fully covered by deterministic mutation-verified tests — no model round-trip needed to prove parse correctness. fire 40 not a multiple of 3 → no main ff-merge this fire.

## fire 39 · 2026-06-21 · skill v2.0 · 4d85c3ba (file_edit not-found recovery action for the no-hint case; 3-fire merge)
meta: value-class=new-capability · pkg=@muse/fs · kind=reliability-nudge/message · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 1072→1072 (+2 cases fs-write-tools no-hint+hint message, mutation-valid) · fabrication 0 · @muse/fs 격리 175 · pnpm check exit 0 · lint clean · Ollama DOWN
- 무엇: old_string mismatch는 12B의 #1 edit 실패. applyEdit(file_edit+multi_edit 둘 다 backing)이 exact→fuzzy→unescape 후 실패; 복구 액션은 nearestLineHint가 close line 찾을 때만 있었음. **no-hint(gross miss=모델이 가장 길 잃은 곳)**는 bare "old_string not found: X"만 → 맹목 retry. FIX: no-hint도 `re-read with file_read + copy byte-for-byte(whitespace 포함)` 조언.
- 왜: 다양성 — 최근 35·36·38이 @muse/fs context-fit이라 다른 kind(reliability-nudge/message) 강제. file_move(clobber 이미 가드)·file_delete(approval-gated) scout=clean. edit 실패 복구가 12B 멀티스텝 신뢰성의 핵심.
- 리뷰지점: mutation-valid(suffix→""→gross-miss RED; 메시지 CONTENT 검증 "file_read"+"byte-for-byte"). ④b judge PASS — **순수 advice(라인 추측 0, ok:false 유지, match 파이프라인 byte-identical)**, advice sound(이 분기 도달=fuzzy/whitespace 이미 소진→byte-exact가 정확히 필요), 형제 multi_edit가 메시지 상속(covered), write/move는 다른 경로.
- 리스크: 낮음 — 실패 reason 문자열만(match 로직 0 변경). ④b PASS.
lesson: 복구 메시지는 *모델이 가장 길 잃은 케이스*(no-hint gross miss)에 *가장* 필요한데 종종 거기가 가장 terse — hint 있는 쉬운 케이스만 actionable한 비대칭을 감사. 형제(multi_edit)는 공유 함수(applyEdit) 통해 한 변경으로 covered.

## fire 38 · 2026-06-21 · skill v2.0 · 9fa2a6dc (file_grep output context-fit cap — fire-35 sibling)
meta: value-class=new-capability · pkg=@muse/fs+apps/cli · kind=context-fit/reliability · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1072→1072 (+1 case fs-read-tools grep cap, mutation-valid) · fabrication 0 · @muse/fs 격리 173 · @muse/cli 빌드 clean · pnpm check exit 0 · lint clean · Ollama DOWN
- 무엇: fire-35(file_read context-fit) 형제-감사 — file_grep은 미cap(200매치×500자=~100K자 ≈ 30K토큰=32K 컨텍스트 근접, read와 같은 overflow). FIX: `maxGrepOutputChars?` 옵션(기본 200K=non-agent 무영향), content 루프가 `contentChars += text.length` 누적, GREP_MAX_MATCHES OR char budget서 stop. agent가 `fileReadCharBudget`(64K) 전달.
- 왜: 형제-감사 규칙 — read 고치면 grep/list 형제도. grep worst-case(100K)가 list(60K)보다 높아 우선. Ollama down으로 measure 불가지만 200×500 정량분석으로 갭.
- 리뷰지점: mutation-valid(char clause 제거→cap 테스트 RED; default는 50개 다 반환). ④b judge PASS — non-agent 무회귀(default 200K, GREP_MAX_MATCHES 독립 cap), files-mode 무영향, **grounding 불변**(onPathRead는 scanned 파일만; truncated grep은 *더 적은* 경로→게이트 *더 엄격*), binary/ReDoS/sandbox byte-identical, soft-budget overshoot ≤ 1 match.
- 리스크: 낮음 — grep content 루프+옵션+agent 배선만(read/list/files-mode/path-safety 불변). ④b PASS. file_list(3번째 형제)는 정직히 backlog ◦(1000≈budget, 500×200 multiplier 없음).
lesson: 형제-감사는 *같은 클래스 전부*(read+grep+list) 감사 — 하나 고치면 형제의 worst-case 정량분석으로 우선순위. grounding seam은 *더 적은* 출력=*더 엄격한* 게이트(안전방향). context-fit budget(fileReadCharBudget)을 형제 도구가 공유.

## fire 37 · 2026-06-21 · skill v2.0 · d1f982e1 (JUDGE-DRILL #4 ✅ + pin timeout-message direction)
meta: value-class=test-hardening · pkg=crates/runner · kind=judge-drill · verdict=DRILL-PASS · firesSinceDrill=0(reset)
ratchet: testFiles 1072→1072 (+2 assertions cargo; 메시지 코드 불변) · fabrication 0 · crates/runner cargo 12 · pnpm check exit 0 · lint clean
- JUDGE-DRILL(연속allPASS=8): fire-34 timeout 메시지 "larger timeoutMs"→"smaller timeoutMs"(방향 역전) 주입. **cargo 12 통과** — `timeout_message_is_actionable`이 `contains("timeoutMs")`만 검사(방향 미검증, smaller·larger 둘 다 통과). ④b judge **FAIL**: 인과 추론 — 타임아웃은 *더 많은 시간 필요*인데 smaller는 retry를 *더 빨리* kill=backwards harmful(구체 trace 50ms→20ms→더 빨리 실패; MAX_TIMEOUT_MS=600K 헤드룸 있는데 반대로 유도). → 롤백(메시지 fire-34 그대로).
- 진짜 fix(드릴 교훈=test-blindness): `timeout_message_is_actionable`에 방향 pin — `contains("larger")` + `!contains("smaller")`. mutation-valid: 드릴("smaller") 재주입 시 RED(방향-flip이 contains-only 통과 불가).
- 리뷰지점: 드릴 4번째 성공 — verifier가 contains-검사 통과한 의미 오류(방향)를 *인과 추론*으로 잡음(패턴매칭 아님). 메시지 코드 불변(테스트만 하드닝).
- 리스크: 0 — 코드 동작 변경 0(드릴 롤백, 테스트 assertion 2개 추가). ④b가 드릴 FAIL.
lesson: **contains-토큰 assertion은 토큰의 *의미*(방향/polarity)에 blind** — presence 아니라 meaning을 pin. 드릴이 노출한 blindness를 닫음(방향 검증). verifier가 의미 오류를 인과 추론으로 적발=maker≠judge 4번째 드릴.

## fire 36 · 2026-06-21 · skill v2.0 · 07c04e0d (char-cap reads page cleanly — resolves fire-35 finding; 3-fire merge)
meta: value-class=new-capability · pkg=@muse/fs · kind=reliability/paging · verdict=PASS · firesSinceDrill=8
ratchet: testFiles 1072→1072 (+2 cases fs-read-tools: char-cap trim + round-trip; 1 rewritten, mutation-valid) · fabrication 0 · @muse/fs 격리 172 · pnpm check exit 0 · lint clean · Ollama DOWN
- 무엇: char-cap(maxTextChars 초과 mid-line cut)이 nextOffset을 clear해 모델이 페이징 못함(fire-35 64K cap이 자주 트리거). FIX: char-cap이 trailing partial line을 line-boundary로 TRIM + `nextOffset = start + completeLines + 1`(completeLines=capped의 newline 수=보수적, 경계 라인은 full re-read). 단일 거대 라인(newline 없음)은 nextOffset undefined(라인 페이징 불가).
- 왜: fire-35 ④b가 짚은 backlog ◦ 해소 — 64K cap이 char-cap을 흔하게 만들어 un-pageable hole이 자주 발생. 페이징 스토리 완성(line-trunc fire 24 + char-cap fire 36).
- 리뷰지점: mutation-valid(옛 clear-nextOffset로 되돌리면 trim 테스트 + 10라인 round-trip 둘 다 RED). ④b judge PASS — **페이징 루프 구동: EVERY 라인 read, NONE skipped**(boundary overlap만, gap 0), nextOffset 항상 advance(무한루프 0), char-cap이 truncated=true 유지→onFullRead 억제(grounding 불변), numbered+empty/1-line/no-trailing-newline edge 정확.
- 리스크: 낮음 — char-cap 블록만(line-trunc/grounding/grep/list 불변). ④b PASS.
lesson: ④b finding을 backlog ◦로 기록→다음 fire가 해소하는 사이클이 작동. 페이징 paging은 *모든 truncation 경로*(line+char)가 일관 nextOffset 줘야; 보수적 경계(complete-lines-only, boundary 라인 re-read)가 skip(데이터손실)보다 안전.

## fire 35 · 2026-06-21 · skill v2.0 · 26a8a105 (file_read caps to fit the model context — 200K overflow fix)
meta: value-class=new-capability · pkg=@muse/fs+apps/cli · kind=context-fit/reliability · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 1072→1072 (+2 cases fileReadCharBudget value+enforcement, mutation-valid) · fabrication 0 · @muse/fs 격리 170 · @muse/cli 격리 2827 · pnpm check exit 0 · lint clean · Ollama DOWN
- 무엇: agent가 file_read를 maxTextChars 없이 생성→200K 기본(~50K토큰)인데 numCtx=32768(DEFAULT_OLLAMA_NUM_CTX). 단일 max read가 전체 윈도 초과→런타임이 프롬프트/히스토리 silently truncate(adapter-ollama LIVE 문서: 8K 윈도가 프롬프트 통째 먹고 1토큰). FIX: 순수 `fileReadCharBudget(tokens)=max(4K, floor(tokens/2)*4)`(윈도 절반); agent가 `fileReadCharBudget(DEFAULT_OLLAMA_NUM_CTX)`=64K 전달. 큰 파일은 nextOffset 페이징.
- 왜: Ollama down으로 measure-first 불가→numCtx 확인이 갭 실증(200K>32K토큰). principled helper-derivation으로 OUTCOME-grade(judgment 회피). 다양성: crates/runner 후 fs+cli/context-fit.
- 리뷰지점: mutation-valid(/2 제거→value RED; over-budget 파일이 정확히 budget서 truncate). ④b judge PASS — **갭 REAL 확인(live-observed Ollama overflow, upstream trimming 없음)**, grounding 안전방향 보존(partial read↑, onFullRead 잘못 발화 0), grep/list 무영향, 200K default 타 caller 유지, conservative bound(DEFAULT 사용=user가 올리면 tighter일뿐 overflow 0).
- 리스크: 낮음 — agent read cap만 축소(grounding/페이징/타 caller 불변). ④b PASS. ④b가 pre-existing char-cap nextOffset-clobber edge 지적→backlog ◦.
lesson: "design-sensitive 값"처럼 보여도 *principled derivation*(numCtx의 절반)으로 만들면 arbitrary 아니고 helper로 OUTCOME-grade 가능. 갭 실증은 Ollama 없이도 *기존 코드의 live-observed 코멘트*(adapter-ollama)로 가능. measure-first 불가시 config-overflow도 정량 분석(200K vs 32K토큰)으로 실제 갭.

## fire 34 · 2026-06-21 · skill v2.0 · f349d50d (run_command timeout → actionable message; fire-23 spawn-error sibling)
meta: value-class=new-capability · pkg=crates/runner · kind=reliability-nudge · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 1072→1072 (+2 cargo: helper + E2E timeout; TS 무변경) · fabrication 0 · crates/runner cargo 12 · @muse/tools 격리 289(무회귀) · pnpm check exit 0 · lint clean · Ollama DOWN(30c 보류)
- 무엇: Rust runner가 타임아웃 시 `{timed_out:true, error:None}` — bare flag, 메시지 없음(12B가 놓침). FIX(`describe_timeout`): timeout 경로 `error`에 `"timed out after {ms}ms, killed — retry with larger timeoutMs"`(ms=effective clamped). 와이어링 `error: if timed_out {Some} else {None}`; TS는 error passthrough(무편집).
- 왜: Ollama down으로 30c 보류 → gap-scout. probe로 timeout시 error=None 실측. fire-23 spawn-error 형제(run_command 실패-메시지 family 완성). 다양성: fs/agent-core 후 crates/runner.
- 리뷰지점: mutation-valid 양쪽(helper hint 제거→RED; 와이어링 revert→**E2E RED**=실제 sleep 5+50ms 타임아웃으로 와이어링 outcome-grade). ④b judge PASS — no-weakening(timeout 경로 메시지만, timed_out/ok/kill/drainer 불변, non-timeout은 None), 정확 ms(effective clamped), E2E non-flaky(#[cfg(unix)], 50ms vs 5s 무race).
- 리스크: 낮음 — 순수 에러-메시지 추가(실행/kill 로직 0 변경). ④b PASS.
lesson: 실패 신호는 *구조적 flag*(timed_out)뿐 아니라 *액추에이터 family 일관 메시지*(error)로도 줘야 — 12B는 bare flag를 놓침. Rust 와이어링은 helper 단위테스트 + 실제 e2e(sleep+timeout) 둘 다로 OUTCOME-grade(e2e가 와이어링을 잡음).

## fire 33 · 2026-06-21 · skill v2.0 · db078c66 (file_read refuses binary-content text files; read↔grep sibling; 3-fire merge)
meta: value-class=micro-fix(real-bug) · pkg=@muse/fs · kind=correctness/reliability · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 1072→1072 (+1 case fs-read-tools, mutation-valid) · fabrication 0 · @muse/fs 격리 168 · pnpm check exit 0 · lint clean · Ollama DOWN(30c 보류)
- 무엇: 텍스트-확장자(.txt/.ts)지만 NUL 바이트 포함=binary 파일을 file_read 텍스트 브랜치가 UTF-8 디코드해 corrupted "text"(NUL 포함) 반환 → 모델 edit-poisoning. file_grep은 이미 isProbablyBinary로 skip하는데 file_read는 안 함(형제 불일치). FIX: `rawText` 후 `if isProbablyBinary→read:false`(binary 명시 reason).
- 왜: Ollama down으로 30c 보류 → gap-scout. probe로 fake.txt가 read:true+NUL 반환 실측. read↔grep 형제-완성. 다양성: agent-core/refactor 후 fs/correctness.
- 리뷰지점: mutation-valid(guard 제거→read:false+text-undefined RED). ④b judge PASS — 텍스트 브랜치만(image/PDF/DOCX 무영향, resolveFileKind가 binary .txt를 text로 라우팅해 guard LIVE 확인), **거부가 onPathRead/onFullRead 전 return=fail-closed**(refused binary가 edit 못 ground), false-positive 0(UTF-8엔 NUL 없음).
- 리스크: 낮음 — 텍스트 브랜치 guard 1개(타 kind/gate 불변). ④b PASS.
lesson: 형제 도구(read↔grep)는 같은 입력-클래스(binary) 처리가 일관해야 — grep이 skip하면 read도. 거부는 grounding 콜백 *전* return해야 fail-closed(안 읽은 파일이 edit를 ground 못함). measure-first 불가 시 probe로 실제 corrupted 동작 실측이 gap-scout.

## fire 32 · 2026-06-21 · skill v2.0 · 58d3fa0e (runResistingFalseDone — re-prompt extracted to a shared bounded-retry wrapper; decompose 30b)
meta: value-class=refactor/seam · pkg=@muse/agent-core+apps/cli · kind=refactor/seam+bounded-retry · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 1071→1072 (+1 file false-done-reprompt 4 cases, mutation-valid) · fabrication 0 · @muse/agent-core 격리 2542 · @muse/cli 격리 2827 · pnpm check exit 0 · lint clean · Ollama DOWN
- 무엇: 백스톱 ACTION 반쪽(unbacked면 clean-history 1회 재실행, 실제 행동시만 채택)이 chat-repl:634 inline → `runResistingFalseDone({query,firstResult,retry})` generic wrapper로 추출(agent-core). caller가 retry thunk 제공→AgentRuntime 의존 없음. chat-repl DRY.
- 왜: fire-30 분해 30b — re-prompt가 1개 공유 tested 정의가 돼 chat-repl + eval harness(30c)가 같은 걸 조성. reflection-guard 준수(정확히 1 retry, 결정론 verifier=actionToolRan, fail-closed). Ollama down으로 eval delta(30c)는 보류지만 wrapper 로직은 synthetic으로 완전 테스트.
- 리뷰지점: behavior-IDENTICAL(④b leg-for-leg diff; 클로저 narrowing은 const-capture; actionToolRan import 제거·isUnbackedActionClaim 유지; builds exit 0). mutation-valid(use-if-acted→always-retried면 "재실행도 실패→첫째 유지" RED).
- 리스크: 낮음 — behavior-preserving 추출(조건/재실행 로직 불변). ④b PASS. honest: eval 미조성(30c, Ollama 필요).
lesson: `&&` 가드(30a)와 그 *행동*(re-prompt, 30b)을 둘 다 generic helper로 추출하면 inline drift 제거 + 미래 caller(eval harness)의 seam. 클로저로 옮긴 optional 접근은 const-capture로 narrowing 유지. bounded-retry는 결정론 verifier+1회 cap로 reflection-guard 준수.

## fire 31 · 2026-06-21 · skill v2.0 · aabe7905 (isUnbackedActionClaim helper — false-done condition extracted; decompose 30a)
meta: value-class=refactor/seam · pkg=@muse/agent-core+apps/cli · kind=refactor/seam · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 1071→1071 (+1 case casual-prompt composition, mutation-valid) · fabrication 0 · @muse/agent-core 격리 2538 · @muse/cli 격리 2827 · pnpm check exit 0 · lint clean
- 무엇: false-done 백스톱 조건 `requestsToolAction(q) && answerClaimsAction(a) && !actionToolRan(t)`이 3곳(commands-ask:2862, chat-repl:634/698) inline 중복 → `isUnbackedActionClaim({query,answer,toolNames})` helper로 추출(3 detector가 사는 agent-core) + 3 CLI 사이트 배선 + unused import 정리.
- 왜: fire-30 분해 30a(eval-mover의 seam) — 조건이 1개 tested 정의가 돼 미래 leg 추가가 사이트 간 발산 못함. 30b(AgentRuntime re-prompt)가 같은 helper 사용. 다양성: agent-core/honesty 6연 후 refactor/seam kind.
- 리뷰지점: behavior-IDENTICAL(④b judge 10케이스 0 mismatch vs inline; askIsActionRequest@2863/2871 + chat-repl:640 actionToolRan 유지; unused만 제거; check exit 0). mutation-valid(`!` 제거→RED).
- 리스크: 낮음 — behavior-preserving 추출(조건 불변, 명명만). ④b PASS.
lesson: `&&` 합성 가드가 N곳 inline이면 drift 위험 — 1개 tested helper로 추출하면 형제 사이트 발산 방지 + 미래 배선(런타임)의 seam. import 정리는 still-used(askIsActionRequest용 requestsToolAction, post-re-prompt actionToolRan)와 unused 구분 필수.

## fire 30 · 2026-06-21 · skill v2.0 · eea41daf (file_list deterministic sort; AgentRuntime re-prompt decomposed; 3-fire merge)
meta: value-class=new-capability · pkg=@muse/fs · kind=determinism/reproducibility · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1071→1071 (+1 case fs-read-tools file_list, mutation-valid) · fabrication 0 · @muse/fs 격리 167 · pnpm check exit 0 · lint clean · Ollama DOWN(measure-first 불가)
- 무엇: file_list가 glob 순서(Node 미보장, filesystem-defined)로 반환 → 머신/pass^k 반복 간 순서 흔들림=12B 입력 flake. FIX: `matches.sort()`(canonical full-path lexicographic) 반환 전. 정직 scope: glob 루프는 limit서 break 유지 → >limit set은 glob-bound(pre-existing), ORDER만 결정론화.
- 왜: Ollama down으로 measure-first 불가→gap-scout. eval:computer-task가 pass^k라 결정론 입력이 재현성 직결. 다양성 RATCHET: agent-core/honesty 5연 후 fs/determinism로 전환.
- 리뷰지점: mutation-valid(sort 제거→RED; glob이 fixture서 sorted 아님). ④b judge PASS — count/truncated/exclude/ignore/sandbox 다 불변(정렬은 필터+cap된 배열만 reorder), 정직 scope(order≠set). AgentRuntime re-prompt(eval-mover)는 invasive+Ollama-gated+chat-repl 중복가능성으로 backlog 분해(30a 순수 helper/30b 런타임 배선/30c eval 검증).
- 리스크: 낮음 — 반환 순서만(file_read/grep/write/path-safety 불변). ④b PASS.
lesson: false-done 백스톱(25-29)은 *CLI chat* 경로를 고치지 eval(AgentRuntime 직접구동)은 별경로 — eval을 올리려면 re-prompt가 런타임층에 있어야(분해 기록). measure-first 불가시 결정론/재현성도 정당한 reliability vein. 정직 scope(order vs set)가 over-claim보다 낫다.

## fire 29 · 2026-06-21 · skill v2.0 · 0dbc38d3 (JUDGE-DRILL #3 ✅ + terse "Done." claim added safely)
meta: value-class=new-capability(+drill) · pkg=@muse/agent-core · kind=honesty/false-done · verdict=DRILL-PASS+judge#2-PASS · firesSinceDrill=0(reset)
ratchet: testFiles 1071→1071 (+3 terse positives + 7 negation negatives, mutation-valid) · fabrication 0 · @muse/agent-core 격리 2537 · pnpm check exit 0 · lint clean
- JUDGE-DRILL(firesSinceDrill=10): fire-28 `CODE_DONE_RE`에 bare `\bdone\b` 추가(terse "Done." 잡는 "개선"처럼) + "Done." 긍정테스트. **결정론 게이트 통과(2537)** — answerClaimsAction negative 코퍼스에 "done"-negation 케이스 0이라 over-match invisible. ④b judge **FAIL**: `\bdone\b`가 negation/partial/idiom/question/passive 10케이스 오탐 + **assembled 게이트 직접 구동**(code-fix req + "I'm not done yet" + 도구0 → 백스톱 FIRES = honest 진행중 답변 re-prompt) 증명. → 롤백.
- 진짜 fix(드릴 쌍둥이 교훈=test-blindness + legit 갭): (a) terse-"Done." 갭은 실재 → `TERSE_DONE_RE` whole-answer 앵커(`^…done…$`, embedded "done" 불일치) + KO 문장형 `완료`; (b) negative 코퍼스에 7 드릴 케이스 하드닝.
- 리뷰지점: mutation-valid(TERSE를 bare `\bdone\b`로 되돌리면 7 negation 전부 RED=드릴 over-match를 게이트가 잡음). ④b judge#2 PASS(terse 주장 true, negation/idiom/passive false, `완료하려면`/`완료되지` false, 2537 green).
- 리스크: 낮음 — answerClaimsAction 패턴만(classifyActionRequest/actionToolRan/wiring 불변). drill 롤백+안전 재구현. ④b#2 PASS.
lesson: **드릴의 올바른 진짜-fix는 test-blindness AND legit 갭을 둘 다 닫는 것** — judge가 가리킨 SAFE 형식(whole-answer 앵커, substring 아님)으로 기능 구현 + over-match 케이스를 negative로 추가해 나쁜 형식이 다신 silently 통과 못하게. ④b가 COMPOSED 게이트를 구동해 harm 입증=maker≠judge 3번째 드릴 작동.

## fire 28 · 2026-06-21 · skill v2.0 · 6d0f0101 (false-done backstop THIRD leg — answerClaimsAction code-fix claims; backstop now end-to-end)
meta: value-class=new-capability · pkg=@muse/agent-core · kind=honesty/false-done · verdict=PASS · firesSinceDrill=9
ratchet: testFiles 1071→1071 (+2 cases casual-prompt: code-claim positives + future/offer/advice negatives, mutation-valid) · fabrication 0 · @muse/agent-core 격리 2537 · pnpm check exit 0 · lint clean
- 무엇: 백스톱 3다리(query=classifyActionRequest[f27] && answer=answerClaimsAction && tools=!actionToolRan[f25]) 중 **answer 다리**가 code-fix 완료주장("I fixed the bug"/"수정했습니다") 미인식 → `&&` 단락으로 fires 25+27에도 백스톱이 안 걸렸음. FIX: `CODE_DONE_RE` 브랜치(1인칭 past-tense mutation 동사 EN `/iu` + KO 수정했/고쳤/편집했).
- 왜: agentic-persistence(fire 17 "모델이 편집 없이 fix 주장") 폐루프의 마지막 다리. fires 25+27이 query+tools를 고쳤어도 answer 다리 없이는 백스톱 발화 0.
- 리뷰지점: mutation-valid(브랜치 없으면 positives RED; **`/iu` 플래그 load-bearing** — "I fixed"가 `/u`선 소문자 `\bi`만 매칭돼 fail). ④b judge PASS — **full-loop 합성 검증**(code-fix req + "I fixed it" + 도구0 → 백스톱 FIRES; 실제 file_edit → not flagged). over-match 차단(future/offer/capability/advice/description 전부 false; broad past-tense는 3 호출처 AND-게이트로 scope; judge가 realistic false-pos 구성 실패, "I read/reviewed/analyzed"는 false).
- 리스크: 낮음 — answerClaimsAction 브랜치만(classifyActionRequest/actionToolRan/wiring 불변, double-gated). ④b PASS.
lesson: 다리 여럿이 `&&`로 합쳐진 가드는 *모든 다리*를 형제-감사해야 — fires 25(tools)+27(query) 고쳐도 28(answer) 없이는 전체 0 발화. full-loop를 합성-probe로 OUTCOME 검증(개별 다리 green≠전체 작동). fire 17 measure-first가 짚은 early-stop/false-done이 이제 CLI 경로서 결정론적으로 잡힌다.

## fire 27 · 2026-06-21 · skill v2.0 · 7e56df59 (false-done request-gate via STRUCTURAL signal — resolves fire-26 blocker; 3-fire merge)
meta: value-class=new-capability · pkg=@muse/agent-core · kind=honesty/false-done · verdict=PASS(judge#4) · firesSinceDrill=8
ratchet: testFiles 1071→1071 (+2 cases casual-prompt: file-positives + path-prefix/homonym negatives, mutation-valid) · fabrication 0 · @muse/agent-core 격리 2535 · pnpm check exit 0 · lint clean
- 무엇: fire-26 블로커 해소(RIGHT DESIGN 구현) — false-done 백스톱 request-side(`classifyActionRequest`)가 code-fix 미인식이라 fire-25 actuator fix에도 백스톱이 컴퓨터-제어에 안 걸림. fix: fuzzy 텍스트 분류 대신 **구조적 신호** = 쿼리에 명시적 **code-extension 파일명**(`FILE_PATH_TOKEN`=optional path + `name.<code-ext>`) 있을 때만 매칭. edit동사 START-앵커(질문 배제), KO 미러(파일명+고쳐/수정).
- 왜: code-extension 파일명은 homonym-free — 영어 단어는 `name.ts`가 아님 → code-noun homonym(fire 26)·path-prefix homonym(fire 27 1차) 둘 다 제거. precision-over-recall(파일없는 "fix the bug"/"수정해줘"는 미매칭=의도적; miss는 grounded path로 무해, false-pos는 백스톱 오발).
- 리뷰지점: mutation-valid(패턴 없으면 positives RED; token 완화시 path-prefix negatives RED). **④b judge 4회차서 PASS**(v1/v2 code-noun FAIL→v3 path-prefix FAIL→각 FAIL이 다음 설계가 닫은 실제 over-match). 잔존=진짜 .md 파일(정확) 또는 contrived "dr.py" glued-token(현실 약어는 마침표 후 공백→false). fire 25+27로 백스톱 컴퓨터-제어 완전 작동.
- 리스크: 낮음 — 분류기 패턴만(answerClaimsAction/actionToolRan/wiring 불변). ④b PASS.
lesson: **구조적/결정론 신호(code-extension 파일명)가 homonym 많은 분류에서 lexical 의도-추측을 이긴다** — 3 judge FAIL이 right design으로 수렴 = maker≠judge가 작동(no-ship fire 26이 RIGHT DESIGN 기록→fire 27 구현). fuzzy 표면은 끈질긴 적대 검증 필수.

## fire 26 · 2026-06-21 · skill v2.0 · NO-SHIP (docs-only) · ROLLBACK (code-fix request classifier — 2× judge FAIL on over-match)
meta: value-class=no-ship · pkg=@muse/agent-core(reverted) · kind=honesty/false-done · verdict=FAIL×2→ROLLBACK · firesSinceDrill=7
ratchet: testFiles 1071→1071 (코드 변경 0, 롤백) · fabrication 0 · agent-core fire-25 state 무손상(actionToolRan fs fix intact) · docs writeback만
- 무엇: fire-25 형제 — 백스톱은 `classifyActionRequest`/`requestsToolAction`로도 게이트되는데 이게 code-fix("fix the bug in add.ts"·"수정해줘") 미인식 → fire-25 actuator fix에도 백스톱이 CLI 경로서 테마에 안 걸림. `CODE_ACTION_REQUEST_RE`(edit동사+코드/파일 noun, 질문배제 앵커) 시도.
- 왜 NO-SHIP: **독립 ④b judge 2회 FAIL**(realistic over-match, regex로 회피 불가). v1=bare homonym(class/test/line/error/function이 "change my class schedule" 등 오탐). v2=homonym 제거+named-construct(`<id> class`)인데 `the <형용사> class`가 determiner 가드 우회("update the science class"·"fix the parking module" 오탐) + strong-noun도 non-code 의미("fix the variable rate mortgage"·"import tax"). ROOT: code-vs-non-code는 *의미적* disambiguation(homonym 천지)이라 lexical regex로 못 가른다.
- 리뷰지점: maker≠trip — **2 독립 judge가 realistic counter-example로 over-match 적발 = maker≠judge 보상통제가 *유기적으로* 작동**(드릴 아님). commands-ask:903 early-return이라 innocent 쿼리 mis-route가 실제 회귀 → ship 안 함이 옳음. 롤백 clean(diff 0, fire-25 무손상).
- 리스크: 0 — 롤백, 코드 변경 없음. fire-25 actuator fix 유지.
lesson: **homonym 많은 intent에 fuzzy lexical 분류기는 틀린 도구** — 2 독립 judge가 같은 over-match 클래스를 다른 경로로 잡음. 올바른 설계=request 텍스트 분류(fuzzy) 대신 *구조적 신호*: file 도구 노출 여부 OR 쿼리의 명시적 파일경로/파일명(`\w+\.<ext>`/절대·상대 경로) — 결정론+homonym-free. 백로그 블로커에 RIGHT DESIGN 기록. NO-SHIP도 정직히 저널.

## fire 25 · 2026-06-21 · skill v2.0 · ee1efde6 (false-done backstop recognises fs/run_command actuators)
meta: value-class=micro-fix(real-bug) · pkg=@muse/agent-core · kind=honesty/false-done · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 1071→1071 (+1 case casual-prompt, mutation-valid) · fabrication 0 · @muse/agent-core 격리 2533 · pnpm check exit 0 · lint clean · Ollama DOWN
- 무엇: SCOUT — false-done/persistence 백스톱이 *이미 존재+배선*됨(`answerClaimsAction`+`actionToolRan` → commands-ask:2590 flag + chat-repl:553 re-prompt). BUG: `actionToolRan`의 `ACTION_TOOL_RE`가 fs 도구 도입 전이라 `.add/.update/…`+`_action`만 인식 → `file_edit`/`file_write`/`file_multi_edit`/`file_delete`/`file_move`/`run_command` 미인식 → 실제 file_edit한 코드-fix를 "no action"으로 오독 → 정직한 "I fixed it"을 unbacked로 오탐(+chat 헛 re-prompt). FIX: 분류기에 fs/run_command arm 추가.
- 왜: 멀티스텝 *완성* 검증의 핵심 — 백스톱이 테마의 바로 그 액추에이터(fs)를 몰라 컴퓨터-제어 작업을 매번 오탐. dup 모듈 지을 뻔 했으나 scout가 기존 export 발견(answerClaimsAction/actionToolRan) → 기존 머신 수정이 정답.
- 리뷰지점: mutation-valid(RED 전; 6 mutator→true, read 3→false). ④b judge PASS — **false-positive 교정 + true-positive 보존**(actionToolRan([])===false인 진짜 false-done 여전히 발화), over-match 0(file_editor_config/run_commander/profile_edit false; `\b`+닫힌 alternation), tasks/calendar verb arm byte-identical, 2533 green. run_command(execute-risk) 포함 타당.
- 리스크: 낮음 — 분류기 정규식 1 arm 추가(claim 검출/wiring 불변). ④b PASS.
lesson: 새 capability(detector) 짓기 전 *기존 머신 scout 필수* — false-done 백스톱이 이미 완비+배선돼 있었고 진짜 갭은 "fs 액추에이터 미등록"(테마 도구가 backstop보다 늦게 생겨 분류기가 stale). 중복 회피 + 실제 버그 수정. agentic-persistence re-prompt는 *이미 존재*하며 이 fire로 컴퓨터-제어서 작동.

## fire 24 · 2026-06-21 · skill v2.0 · 7474abed (file_read nextOffset paging hint; 3-fire merge)
meta: value-class=new-capability · pkg=@muse/fs · kind=reliability-nudge(output-paging) · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 1071→1071 (+2 cases fs-read-tools paging+char-cap, mutation-valid) · fabrication 0 · @muse/fs 격리 166 · pnpm check exit 0 · lint clean · Ollama DOWN(measure-first 불가, gap-scout fallback)
- 무엇: line-truncated read가 `{truncated:true, totalLines}`만 줘서 12B가 다음 페이지 offset을 추측해야 함(큰 파일 멀티스텝 막힘). FIX: text-read 결과에 `nextOffset`(재개할 1-based 라인 `start+sliced.length+1`) 추가, line-truncated일 때만; char-cap cut은 라인 경계 부정확이라 omit(char-cap 분기가 clear=우선). 설명에 페이징 프로토콜 1줄.
- 왜: Ollama down으로 measure-first 불가 → gap-scout. reliability-nudge vein을 *에러 복구(21-23)*에서 *성공-경로 출력 가이드(페이징)*로 확장. 큰 파일은 grounding gate(full-read)도 막으니 페이징이 멀티스텝 신뢰성 직결.
- 리뷰지점: mutation-valid(nextOffset 없으면 RED; char-cap clear도 line-trunc+char-cap 케이스로 독립 pin→RED). ④b judge PASS — round-trip 페이징 gap/overlap/off-by-one 없음+마지막 페이지 stop, **GROUNDING GATE 불변**(nextOffset 순수 additive; onFullRead 여전히 start===0&&!truncated만, paged read는 onPathRead만), PDF/DOCX/image stray nextOffset 없음. judge가 char-cap 테스트 커버리지 갭 지적→백필(커밋 전).
- 리스크: 낮음 — 출력 필드 1개 additive(truncated/gate 불변), 설명 additive(eval:tools 선택 영향 미미). ④b PASS.
lesson: reliability-nudge는 *에러 경로*뿐 아니라 *성공 경로 출력*(페이징 가이드)에도 적용 — 작은 모델엔 "정수 하나 복사"가 "offset 계산"보다 신뢰성↑. ④b가 커버리지 갭(char-cap 미테스트)을 잡아 백필=judge가 defect뿐 아니라 test-완전성도 강화.

## fire 23 · 2026-06-21 · skill v2.0 · 14ca9d49 (run_command spawn-failure → actionable message; pkg pivot off @muse/fs)
meta: value-class=new-capability · pkg=crates/runner · kind=reliability-nudge · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 1071→1071 (+1 cargo test crates/runner; TS 무변경) · fabrication 0 · crates/runner cargo 10 · @muse/tools 격리 289(무회귀) · lint clean
- 무엇: Rust runner가 spawn 실패에 raw `"failed to spawn command: No such file or directory (os error 2)"` 반환 → 12B가 오타 vs 미설치 구분 불가. FIX(`describe_spawn_error`): `ErrorKind::NotFound`→`"command '<cmd>' not found — not installed or not on PATH; check the name."`, `PermissionDenied`→`"… not executable (permission denied)."`, 그외→원본 generic. `run_request` spawn Err arm에 배선; TS는 `error` 그대로 전달(무편집).
- 왜: 다양성 RATCHET — 최근 5 fire(18-22) 전부 @muse/fs라 *다른 패키지*(crates/runner) 강제. reliability-nudge vein을 run_command 액추에이터로 확장(npm/pytest 오타·미설치는 실제 멀티스텝 실패모드).
- 리뷰지점: mutation-valid(NotFound arm→generic이면 cargo RED; 복원 10 pass). ④b judge PASS — 이미 실패한 spawn의 *메시지 텍스트만*(spawn 동작/보안 불변; blank/path/env 가드 다 선행), request.command 에코(host-path leak 없음), generic fallthrough가 타 에러 verbatim 보존. TS passthrough 확인(error→모델 도달).
- 리스크: 낮음 — 순수 에러-포맷 추가(실행 경로 0 변경). honest bound: eval 바이너리는 stale copy일 수 있으나 source 정확+cargo 검증. ④b PASS.
lesson: reliability-nudge vein(actionable 에러)은 *액추에이터를 가로질러* 적용된다 — fs(read/grep/edit) 후 run_command(Rust)로 이어가며 다양성도 충족. raw OS errno(os error 2)는 fs ENOENT와 같은 dead-end 클래스; 패키지 경계 넘어 같은 교훈.

## fire 22 · 2026-06-21 · skill v2.0 · 031a414c (file_edit/multi_edit missing-file → recovery hint; fire-21 sibling completion)
meta: value-class=new-capability · pkg=@muse/fs · kind=reliability-nudge · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 1071→1071 (+1 strengthened fs-write-tools case, mutation-valid) · fabrication 0 · @muse/fs 격리 164 · pnpm check exit 0 · lint clean
- 무엇: fire 21이 file_read/grep ENOENT은 고쳤으나 **write actuator(file_edit/multi_edit)는 놓친 형제** — 존재않는 파일 편집 시 동일 raw `ENOENT … stat '/abs'`(완성-단계서 12B dead-end + abs경로 leak). FIX(공유 `refusal`에 ENOENT 분기 1개): `"no file at '<input>' — to create it use file_write; … check the path or use file_list"`. file_edit+multi_edit 둘 다(공유 editExecutor→refusal); file_write는 mkdir -p라 정당 제외.
- 왜: 멀티스텝 *완성* 단계(edit) 에러가 raw면 12B가 retry 못함. fire-21 형제-audit 미완(read/grep만, edit/multi_edit 누락)을 완성. 1 fix로 두 형제.
- 리뷰지점: mutation-valid(분기 제거→raw-errno RED; 복원→164 green). ④b judge PASS — ENOENT은 3번째 분기(PathSafetyError→ELOOP→ENOENT)라 denied/symlink/old_string-not-found/directory/existing-edit 다 자기 outcome 유지(probed); input `path` 에코(abs-leak 없음). nit: dangling-symlink는 ENOENT가 ELOOP보다 먼저라 힌트 약간 어긋나나 무회귀.
- 리스크: 낮음 — 공유 refusal에 ENOENT 분기만(분기 순서로 타 에러 불변). ④b PASS.
lesson: 형제-audit는 *actuator 클래스 전체*(read+grep+edit+multi_edit)를 enumerate해야 — fire 21이 read/grep만 고쳐 edit/multi_edit raw-ENOENT가 남았다(fire 15→16 env-family와 동형 누락). 공유 헬퍼(`refusal`)에 고치면 형제 자동 커버.

## fire 21 · 2026-06-21 · skill v2.0 · 790c76b5 (file_read/grep missing-path → recovery hint; 3-fire merge)
meta: value-class=new-capability · pkg=@muse/fs · kind=reliability-nudge · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1071→1071 (+2 cases fs-read-tools read/grep, mutation-valid) · fabrication 0 · @muse/fs 격리 164 · pnpm check exit 0 · lint clean
- 무엇: 존재 않는 직접 경로에 file_read/file_grep이 raw `ENOENT: ... stat '/abs'` 반환 → 12B 자가복구 불가 + 절대경로 leak. FIX(`isNotFoundError` code==="ENOENT"): 양 도구가 복구도구(file_list)+파일명 담은 actionable 메시지. 형제-감사: file_list는 missing cwd에 `{count:0}` 깔끔(유지). 
- 왜: fires 8-9 패턴 — 좋은 에러가 12B 멀티스텝 복구를 살림(grep→read→edit 루프서 stall 대신 file_list로 self-correct). 다양성 RATCHET이 @muse/fs 보안 집중에서 reliability KIND로 전환 요구.
- 리뷰지점: mutation-valid 양방향(raw-errno RED; grep 브랜치 revert→RED). ④b judge PASS — ENOENT-only(denied→refused·existing→read·directory→"directory"·EACCES→fall-through·malformed-regex→literal 다 불변), outcome-graded, **보너스 info-leak 감소**(input 에코, symlink-resolved `/private/var/` 안 노출). scout: file_read static 심링크 escape=resolveSafePath가 이미 차단(probe 확인)·file_list 결과 재검증=견고.
- 리스크: 낮음 — ENOENT 분기만 추가(타 에러/정상 경로 불변). ④b PASS.
lesson: 보안 surface가 thoroughly-hardened면 *같은 패키지의 다른 KIND*(reliability/error-recovery)로 가치 지속 — raw errno는 12B에 dead-end이자 info-leak; actionable 메시지(복구도구 명시)는 멀티스텝 신뢰성을 직접 올린다. 형제(read↔grep)는 같은 fire에 패치.

## fire 20 · 2026-06-21 · skill v2.0 · bb46f6f6 (JUDGE-DRILL #2 ✅ + harden ReDoS allow-corpus)
meta: value-class=test-hardening · pkg=@muse/fs · kind=judge-drill · verdict=DRILL-PASS · firesSinceDrill=0(reset)
ratchet: testFiles 1071→1071 (+6 safe-alternation cases in allows it.each) · fabrication 0 · @muse/fs 격리 162 · pnpm check exit 0 · lint clean
- JUDGE-DRILL(firesSinceDrill=10 AND 연속allPASS=8 트리거): fire-19 alternation residual을 "닫는" 그럴듯한 슬라이스 주입 — detector inner class에 `|` 추가(`[+*|]`) + `(a|aa)+` 잡힌다는 테스트. **결정론 게이트 통과(157)** — "allows" 코퍼스에 quantified-alternation 패턴이 없어 over-block이 invisible. ④b 독립 judge가 **FAIL**: `(foo|bar)+`/`(TODO|FIXME)+`/`(a|b)*` 오탐 재현 + **타이밍 sub-ms로 catastrophic 아님 증명** + fire-19 대비 regression + 테스트 blind 적발. → 롤백(detector fire-19 그대로).
- 진짜 fix(드릴 교훈=test-blindness): "allows" it.each에 안전 quantified-alternation 패턴(`(foo|bar)+`·`(TODO|FIXME)+`·`(a|b)*`·`(import|export)\s+\w+`·`(GET|POST|PUT)\s`·`(error|warn|info)+`) 추가. mutation-verified — 드릴의 `[+*|]` broadening 재적용 시 신규 테스트 RED(이전엔 invisible) = 미래 over-block을 게이트가 잡음.
- 리뷰지점: 드릴 2번째 성공 — verifier가 게이트-통과 regression을 추론+probe+**타이밍**으로 잡음(rubber-stamp 아님). detector 코드 불변(테스트만 하드닝). check exit 0.
- 리스크: 0 — 코드 동작 변경 0(드릴 롤백, 테스트 corpus 확장만). ④b가 드릴 FAIL.
lesson: **드릴의 올바른 진짜-fix는 단순 revert가 아니라 드릴이 타고 들어온 *test-blindness를 닫는 것*** — judge가 "코퍼스가 over-block에 blind"라 지적했으니, 그 클래스(safe quantified-alternation)를 allow-코퍼스에 추가해 같은 regression이 다신 invisible하지 않게. ④b judge는 *타이밍*까지 써서 "이건 catastrophic 아니다"를 실증(추론만 아니라 측정).

## fire 19 · 2026-06-21 · skill v2.0 · 99aed2ea (file_grep ReDoS guard — model regex can't hang the agent)
meta: value-class=new-capability · pkg=@muse/fs · kind=regex-safety/ReDoS · verdict=PASS · firesSinceDrill=9
ratchet: testFiles 1071→1071 (+3 cases fs-read-tools: integration + 2 it.each, mutation-valid) · fabrication 0 · @muse/fs 격리 156 · pnpm check=박스포화(apps/cli 5-64s, 격리 green) · lint clean
- 무엇: §3.6 DoS — file_grep이 모델-supplied regex를 `new RegExp(pattern,"u")`(JS 백트래킹, 타임아웃 없음)로 Muse 프로세스 IN에서 라인별 실행 → `(a+)+$`가 40자 실패 라인에서 HANG(probe 확인). FIX(`isCatastrophicGrepPattern`): nested-quantifier 형태(`(a+)+`/`(.*)*`/`(\d+){2,}`)를 compile 전 거부+"simplify" 에러. 
- 왜: 모델 regex hang은 agent를 wedge하는 실제 DoS. JS는 regex 타임아웃 없어 detect-and-reject가 dep-없는 1차 방어(compile 전 차단).
- 리뷰지점: mutation-valid(detector→false면 unit RED + integration HANG=가드 load-bearing; flags 6 catastrophic/allows 7 safe). ④b judge PASS(realistic 11 패턴 over-block 0, compile 전 실행, literal degrade 유지, grep-only). **HONEST RESIDUAL(④b 확인)**: flat-group 휴리스틱이 `((a+))+`(nested-paren)·`(a|aa)+`(alternation-overlap)는 여전히 HANG — alternation은 안전한 `(a|b)+`까지 over-block돼 깔끔히 못 잡음; complete fix=worker-timeout(모든 형태, deferred 깊은 슬라이스).
- 리스크: 낮음 — 거부 패턴 1개+에러(grep만, 안전 패턴 불변). ④b PASS.
lesson: 휴리스틱 보안가드는 **common 형태를 닫고 residual을 정직히 문서화**(④b가 nested-paren/alternation residual 확인) — over-block 회피(alternation 검출이 `(a|b)+` 오탐)와 완전성(worker-timeout)이 트레이드오프; "1차 방어+정직한 한계"가 "완벽한 척"보다 낫다. JS regex는 타임아웃 불가라 detect-and-reject가 현실적.

## fire 18 · 2026-06-21 · skill v2.0 · c204778f (fs credential deny-list — common cred/key files; 3-fire merge)
meta: value-class=new-capability · pkg=@muse/fs · kind=security/credential-deny · verdict=PASS · firesSinceDrill=8
ratchet: testFiles 1071→1071 (+2 it.each fs-path-safety, mutation-valid) · fabrication 0 · @muse/fs 격리 143 · eval:computer-task 무관(cred 미사용) · pnpm check=박스포화(web-search fuzz 9.6s, 격리 green) · lint clean
- 무엇: §3.6 credential 보호 sibling-audit — resolveSafePath(모든 fs도구 공유) deny-list가 .ssh/.env/*.pem/*secret*/id_rsa는 막으나 probe로 **.npmrc(npm토큰)·.netrc·.pgpass·.pypirc·*.pfx·*.jks** 읽기/쓰기 가능 발견(`.p12`은 "secret" 이름일때만). FIX(BASENAME leaf-only): `/^\.(npmrc|netrc|pgpass|pypirc)$/` + `/\.(p12|pfx|jks|keystore)$/`. `.key`는 Keynote 충돌로 제외(slides.key 허용 유지).
- 왜: credential-deny family도 env-family(16)처럼 미완성이었음 — probe로 흔한 cred 파일이 fs도구로 leak 가능 확인. resolveSafePath라 read/write/edit/grep/list/move/delete 전부에 적용.
- 리뷰지점: mutation-valid(8 파일 pre-slice ALLOWED→denied), over-block 0(notes/config/package.json/npmrc.md/report.p12.txt/slides.key 허용; exact-dotfile+extension-at-end anchoring), prior corpus 무회귀(143/143). ④b judge PASS. run_command(approval-gated 일반 executor)은 resolveSafePath sandbox 밖=정직히 out-of-scope.
- 리스크: 낮음 — deny 패턴 2개 추가(leaf-only, anchoring 정밀), 기존 deny/허용 불변. ④b PASS.
lesson: deny-list류(env-family 16, credential-family 18)는 **probe로 실측**해야 갭이 보인다 — "흔한 X 다 막나?"를 *문서가 아니라 코드 probe*로 확인. .key 같은 collision(Keynote)은 의식적 제외가 정직(over-block보다 niche under-block 선택).

## fire 17 · 2026-06-21 · skill v2.0 · 41f329be (run_command resource clamp; measure-first sharpens the ceiling)
meta: value-class=new-capability · pkg=@muse/tools+crates/runner · kind=resource-bound · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 1069→1069 (+1 case tools.test clamp + Rust clamp test, mutation-valid) · fabrication 0 · @muse/tools 격리 289 · crates/runner cargo 9 · eval:multifile-fix=early-stop(model-behavior) · pnpm check=박스포화(apps/api LINE 20s, 격리 green) · lint clean
- 무엇: §3.6-adjacent — `timeoutMs`/`maxOutputBytes`가 모델-supplied인데 하한(.max(1))만, 상한 cap 없음 → `timeoutMs:999_999_999`(~11.5일 hang)/`maxOutputBytes:5e9`(메모리) DoS. FIX 양 레이어(10min/10MB ceiling 동일): TS `readPositiveInteger(value,max)` Math.min, Rust `effective_timeout_ms/output_bytes` clamp(1,MAX), 스키마 `maximum:` 추가. clamp(reject 아님)이라 정당한 9분 빌드는 통과.
- 왜: 보안/grounding 렌즈(13-16) 후 **resource-bound 렌즈**로 또 실제 갭. 코드-scout(path-safety·run_command exec·file_delete)는 solid지만 resource knob가 미감사였음. 형제-감사(TS+Rust).
- 리뷰지점: mutation-valid 양 레이어(un-clamp시 RED, Rust 실제 mutate→panic 확인). ④b judge PASS(ceilings 동일, no-TDZ factory-read 스키마 상수, watchdog ≤605s bounded, prior 가드 불변). **measure-first this fire**: 모델이 이제 read(test)→grep→read(source)로 올바르게 조사하나 file_edit 전 멈춤=agentic-persistence 천장의 sharp 재확인(결정론 층 다 작동, 모델이 옳은 파일 도달, 행동만 안 함).
- 리스크: 낮음 — clamp만 추가(값-타입/env-denylist/command-parse 불변). ④b PASS.
lesson: 같은 축을 **여러 렌즈**(노출·grounding·security·resource-bound)로 보면 각 렌즈가 다른 실제 갭을 드러낸다 — "scout가 solid"는 *그 렌즈*의 소진이지 축 소진 아님. measure-first는 결정론 층 완성을 확증(모델이 옳은 파일 도달)하고 남은 천장(agentic-persistence)을 model-behavior로 격리.

## fire 16 · 2026-06-21 · skill v2.0 · 00451ce7 (env injection — whole code-injection family; fire-15 sibling-audit)
meta: value-class=new-capability · pkg=@muse/tools+crates/runner · kind=security/path-safe · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 1069→1069 (+1 case tools.test family + Rust family test, mutation-valid) · fabrication 0 · @muse/tools 격리 285 · crates/runner cargo 8 · eval:computer-task 무관(env 미사용) · pnpm check=박스포화(web-search fuzz 5s, 격리 green) · lint clean
- 무엇: fire 15 sibling-audit 완성 — 동적로더(LD_/DYLD_)는 family 1/24였음. NODE_OPTIONS(=`--require`로 node에 코드주입, Muse가 node 실행), shell(BASH_ENV/ENV/SHELLOPTS), interpreter(PERL5OPT/PYTHONSTARTUP/PYTHONPATH/RUBYOPT…), git command-exec(GIT_SSH_COMMAND/GIT_EXTERNAL_DIFF/GIT_PAGER/…+GIT_CONFIG*) 전부 통과하던 걸 `UNSAFE_ENV_EXACT` denylist로 차단. TS+Rust 양 레이어 리스트 IDENTICAL.
- 왜: fire 15가 "LD_PRELOAD 하나 찾고 dynamic-loader만 막음"=형제-감사 미완. 올바른 질문=「코드주입 env의 *전체 클래스*(per-runtime)는?」. exact-match라 NODE_ENV/GIT_DIR/PYTHONUNBUFFERED 등 legit 보존.
- 리뷰지점: mutation-valid 양 레이어(fire-15 코드는 NODE_OPTIONS 통과=RED). ④b judge PASS + GIT_CONFIG*(블록된 git-exec hooks로 가는 2차 경로)를 강한 miss로 지적→같은 슬라이스서 추가. over-block 0(exact-match), TS/Rust 동일.
- 리스크: 낮음 — env denylist 확장만(값-타입/uppercase/LD_/DYLD_/env_clear/PATH 불변). ④b PASS.
lesson: **형제-감사는 *첫 발견 멤버*가 아니라 *전체 클래스*를 enumerate해야** — fire 15는 1/24 고치고 done이라 함. ④b judge가 또 한 멤버(GIT_CONFIG)를 지적=감사가 2단계로 수렴. "denylist는 미완성이기 쉽다"의 실례; 가능하면 클래스를 한 번에.

## fire 15 · 2026-06-21 · skill v2.0 · ad6fefb5 (run_command dynamic-loader env injection blocked; 3-fire merge)
meta: value-class=new-capability · pkg=@muse/tools+crates/runner · kind=security/path-safe · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 1069→1069 (+1 case tools.test, mutation-valid) · fabrication 0 · @muse/tools 격리 284 통과 · crates/runner cargo test 7 통과 · eval:computer-task PASS(무회귀) · pnpm check=박스포화(web-search fuzz 15s, 변경패키지 격리 green) · lint clean
- 무엇: §3.6 감사 — run_command은 execFile(no shell)+path-reject지만 모델-supplied `env`가 키 *형식*만 검증돼 **LD_PRELOAD/DYLD_INSERT_LIBRARIES**(유효 대문자식별자)가 통과 → spawn 프로세스에 임의 코드 로드=execFile/path-reject 우회. FIX 양 레이어(defense-in-depth): TS readStringRecord `/^(?:LD|DYLD)_/` 드롭 + Rust is_safe_env_key `LD_`/`DYLD_` 거부(command.env의 authoritative 게이트).
- 왜: 노출/recovery/adapter/근거게이트(4-14) 다 했고, §3.6 "신뢰불가입력→command"의 마지막 미감사 표면=env 주입. 동적-로더 env는 모델-run 명령에 정당하게 불필요 → 결정론적 거부.
- 리뷰지점: mutation-valid 양 레이어(pre-fix TS는 LD_PRELOAD 유지·Rust는 true 반환=RED). ④b judge PASS(프리픽스 정밀: 트레일링 `_`라 LDFLAGS/LOAD_PATH/MY_LD_PRELOAD 보존; 양 레이어 동일 family 차단; 기존 env 가드(env_clear/PATH/형식) 불변; 정직한 scope=LD_/DYLD_ 코어). 형제-감사(TS early + Rust boundary).
- 리스크: 낮음 — env 키 denylist만 추가(args/cwd/command/값-타입필터/uppercase체크 불변). ④b PASS. Rust 변경은 cargo test로만 검증(eval 바이너리는 main copy라 미반영이나 eval은 env 미사용=무관).
lesson: "no shell이라 안전"은 부분만 — execFile은 *어느 바이너리*만 제약하지 *그 안에 주입되는 코드*(LD_PRELOAD)는 못 막음. env는 별도 공격면이고 형식검증≠의미검증. 다언어(TS+Rust) 보안 fix는 양 레이어 다 테스트(vitest+cargo).

## fire 14 · 2026-06-21 · skill v2.0 · f676d3cc (full-read gate for overwrite — grep/offset can't ground it)
meta: value-class=new-capability · pkg=@muse/fs+apps/cli · kind=grounding-gate · verdict=PASS(judge2) · firesSinceDrill=4
ratchet: testFiles 1069→1069 (+3 cases fs read/write, mutation-valid) · fabrication 0 · @muse/fs 격리 131 통과 · eval:computer-task PASS(무회귀) · pnpm check exit 0 · lint clean
- 무엇: fire-13 refine — overwrite 게이트가 `wasPathRead`(file_grep도 set)로 만족돼, grep 몇 줄 보고 file_write로 전체 overwrite=안 본 줄 손실. FIX: 더 엄격한 `wasPathFullyRead`(overwrite는 `wasPathFullyRead ?? wasPathRead`); file_read만 `onFullRead`를 **COMPLETE read에만**(`start===0 && !truncated`) 발화, file_grep 미발화. file_edit/multi_edit 불변(grep→edit 유지). CLI 2nd set 배선.
- 왜: read PRESENCE ≠ read COMPLETENESS — "전체 봤다" 게이트는 처음(start===0)부터 끝(!truncated)까지 확인해야. 테마 fabrication=0를 부분-grounding으로부터 보호.
- 리뷰지점: **maker≠judge가 REAL 슬라이스에서 작동** — ④b judge#1이 FAIL(첫 impl이 `!truncated`만 게이트 → offset:96 read가 truncated=false로 hole 재개방) → 정확한 fix(`start===0 && !truncated`)+offset 테스트 → ④b judge#2(독립) PASS(offset 닫힘, edge 전부, 무회귀, 131/131). mutation-valid(write: partial-grep→fail-close; read: complete→발화, limit/offset/grep→미발화).
- 리스크: 낮음 — overwrite 게이트만 강화(edit/create/back-compat 불변), 3 onFullRead 사이트만 정확 게이트. ④b#2 PASS.
lesson: **게이팅 verifier가 드릴 아닌 실제 슬라이스의 결함을 잡음**(judge#1이 offset boundary hole 적발)= maker≠judge 보상통제의 실전 가치. 교훈 자체: read PRESENCE≠COMPLETENESS, `!truncated`는 "뒤 내용 없음"이지 "전체 봄" 아님(offset-skip이 반례). 게이트는 boundary를 양끝 다 확인.

## fire 13 · 2026-06-21 · skill v2.0 · 982b4f06 (read-before-OVERWRITE gate on file_write — fabrication=0 hole)
meta: value-class=new-capability · pkg=@muse/fs · kind=grounding-gate · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 1068→1068 (+3 cases fs-write-tools, mutation-valid) · fabrication 0 · @muse/fs 격리 127 통과 · eval:computer-task PASS(무회귀, file_edit 경로라 무관) · pnpm check=박스포화(@muse/mcp crypto 5-55s 타임아웃, @muse/fs 격리 green) · lint clean
- 무엇: 테마 핵심 mandate("모든 actuator가 근거 게이트 통과")에서 **미감사 표면 발견** — read-before-edit가 file_edit/multi_edit(editExecutor)엔 강제되나 **file_write엔 누락**. 모델이 안 읽은 기존 파일을 file_write로 overwrite하면 silent 데이터손실+ungrounded 변경(fabrication=0 위반). FIX: `exists && wasPathRead 미충족 → fail-close`(CREATE는 read 불필요). CLI 배선 확인 production-live.
- 왜: 노출/recovery/adapter(fires 4-11)는 *도구 도달*을 고쳤지만 이건 *근거 게이트* 차원 — 테마의 두 기둥 중 후자에 실제 hole. content-mutation 도구(edit/multi_edit/write-overwrite) 전부 read-before 커버 완성.
- 리뷰지점: mutation-valid 3-case(overwrite-no-read fail-close + overwrite-with-read 허용 + create-no-read 허용 = two-sided, over-block 아님). ④b judge PASS(create/TOCTOU/approval/symlink 가드 불변, editExecutor 패리티 정확, delete/move는 content 변경 아니라 제외 타당). 형제-감사 완결.
- 리스크: 낮음 — exists&&wasPathRead 가드만 추가(create/backward-compat 불변), 다른 가드 무손상. ④b PASS.
lesson: "vein 소진"은 *축*이 아니라 *한 차원*(노출)의 소진일 수 있다 — 테마의 다른 기둥(근거 게이트)을 형제-감사하니 file_write-overwrite라는 실제 fabrication hole이 나옴. measure-first(노출)와 invariant-audit(게이트)는 다른 렌즈; 둘 다 돌려야 축을 다 봤다 할 수 있다.

## fire 12 · 2026-06-21 · skill v2.0 · c526e24d (measure-first: model-behavior ceiling confirmed; 3-fire merge)
meta: value-class=measure-first(work-list) · pkg=eval(diagnosis) · kind=ceiling-confirm · verdict=N/A · firesSinceDrill=2
ratchet: testFiles 1068→1068 · fabrication 0 · eval:multifile-fix FAIL(early-stop 모드: file_read 1회 후 자발 종료) · eval:computer-task PASS(불변) · self-eval green
- 무엇: fires 4-11(노출·recovery·adapter)이 multifile을 움직였는지 debug 재측정 → 이번 run은 **early-stop**(모델이 file_read 1회만 하고 grep/edit/run 없이 종료). 단일 eval은 grep→read→edit 3콜 통과하므로 *iteration cap 아님* — 모델이 **자발적으로** 조기 종료(SYSTEM의 persistence 라인에도 불구).
- 왜 코드 슬라이스 없음: 남은 multifile 블로커 3모드(early-stop·node_run환각·garbage명) 중 환각/garbage는 fires 9·11이 결정론 처리; **early-stop은 순수 12B model-behavior**(자발 종료, cap 아님) — tool-filter/fs/adapter로 못 고침. continuation-nudge는 reflection-guard 규칙상 verifier-backed+registry 필요한 NEW retry surface인데 "action-task vs answer-only" 판별이 fuzzy(generic 오발 위험) + agent-core 코어루프 변경 = 신중한 >1-fire 설계(15분 auto-fire 부적합).
- 리뷰지점: fire 8·12 = *코드/측정으로 확인한* 정당한 vein-상태 파악(fire 3 성급-exhaustion과 구분). clean 결정론 computer-control vein 소진 확증: 노출(4·6·7)·fs(8)·recovery(9)·adapter(11)·verifier-drill(10) 다 됨. 3-fire 머지로 fires 10·11 코드 main 안착.
- 리스크: 0 — 코드 미변경, 측정+정직 기록 + docs 머지.
lesson: 다층(노출·recovery·adapter-파싱)을 결정론적으로 다 고쳐도 12B의 *자발적 조기종료*가 멀티스텝 천장 — 이건 코드가 아니라 모델 역량/agentic-persistence 영역. 정직한 다음 후보=verifier-backed action-completion nudge(agent-core, 신중 설계) 또는 다른 테마. measure-first가 "어디까지 코드로, 어디부터 모델"의 경계를 그음.

## fire 11 · 2026-06-21 · skill v2.0 · bbc503e5 (Ollama adapter tool-call name sanitisation)
meta: value-class=new-capability · pkg=@muse/model · kind=adapter-sanitisation · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1068→1068 (+3 cases adapter-ollama.test, mutation-valid) · fabrication 0 · @muse/model 격리 328 통과 · pnpm check=박스포화 false-timeout(매 run 다른 heavy/fuzz 테스트 5-8s, 변경패키지 격리 green) · lint clean
- 무엇: fire-9 DEEPER finding #3 처리 — gemma가 harmony 채널마커(`<|channel|>`,`<|"|>`)를 tool-call NAME에 누수 → 트레일링 누수 토큰이 valid 이름을 깨뜨려(`run_command<|channel|>` → tool-not-found) registry 매칭 실패. FIX(`adapter-ollama.ts` `sanitizeToolCallName`): 첫 `<|`에서 cut + 제어/zero-width 제거, generate+stream 두 파싱 사이트 모두 적용(형제-감사).
- 왜: 노출/recovery(fires 4-9) 다 했어도 adapter가 누수 토큰을 verbatim 통과하면 valid 이름이 깨짐 — 결정론적 위생화로 corrupted-valid 이름 복구. fully-garbage(shell명령-as-name)는 cut 후에도 잔존=model-behavior(정직히 미주장).
- 리뷰지점: mutation-valid(두 사이트 revert시 둘 다 RED)+clean 이름 불변. ④b judge PASS(over-stripping 0: dots/dash/Cyrillic/단일문자 보존, bare `<` 무트리거, 순수-leak→"unknown"; byte-hygiene escaped char class). LESSON 적용: 저널에 raw ESC 바이트 넣었다가 byte-hygiene이 잡음 → charCode 필터로 `\u001b` 텍스트화.
- 리스크: 낮음 — name만 위생화, args/id/"unknown"-fallback/happy-path 불변. ④b PASS.
lesson: 다른 pkg(@muse/model)로 RATCHET 전환해 fire-9가 남긴 adapter 버그를 결정론적으로 처리 — tool-calling 신뢰성은 (노출·recovery·adapter-파싱) 다층. 박스 포화(동시 루프 多)는 full check를 매번 다른 5-8s 타임아웃으로 막으나 *변경 패키지 격리 실행*이 회귀 vs 환경을 가름. 바이트를 *서술*할 때도 escape 텍스트(raw 금지) — fire10 교훈의 재귀.

## fire 10 · 2026-06-21 · skill v2.0 · 1599c25a (JUDGE-DRILL ✅ + harden guard + byte-hygiene regression)
meta: value-class=test-hardening+regression-fix · pkg=@muse/tools+apps/cli · kind=judge-drill · verdict=DRILL-PASS · firesSinceDrill=0(reset)
ratchet: testFiles 1068→1068 (+1 robust guard tools.test) · fabrication 0 · eval:computer-task 미실행(드릴 fire) · pnpm check=박스포화 false-timeout(crypto/fuzz ~5s, 격리 통과; byte-hygiene 회귀는 수정 후 44 통과) · lint clean
- JUDGE-DRILL(firesSinceDrill=10 트리거): `nearestToolName`에 고의 결함 주입(`shared>0` 가드 제거 → 무관명도 misleading 제안) + negative 테스트를 tautology로 약화 → **결정론 게이트 통과(281)**. ④b 독립 judge가 추론으로 **FAIL**: delete_everything→run_command(위험) 재현·tautology 테스트 적발·거짓 docstring·grounding-floor 위반·정확한 롤백 권고. → git restore 롤백(executor.ts HEAD 동일 확인).
- 진짜 fix(드릴이 드러낸 약점 메움): no-misleading 속성 가드가 **단 1개**라 쉽게 약화됨 → 여러 무관명(delete_everything 등)×여러 등록도구로 "절대 'Did you mean' 안 함" robust 가드 추가. mutation-verified(드릴 결함 주입 시 신규+기존 가드 둘 다 RED).
- 회귀 fix: 동시-루프 mascot 커밋(e10ac6c2)이 `commands-logo.test.ts` L23·32에 raw ESC 바이트 → byte-hygiene 게이트가 main check 차단. raw ESC→`\u001b`(의미 동일, commands-logo 통과 확인). [[feedback_no_raw_control_bytes_in_tests]] 룰.
- 리스크: 0 코드 동작 변경(executor 불변, 테스트 추가 + 기존파일 바이트 escape만). 박스포화로 full check green은 crypto/fuzz 5s-타임아웃에 막히나 변경 파일 타겟 테스트 전부 통과.
lesson: **JUDGE-DRILL이 제 역할 입증** — 결정론 게이트(281 green)를 전부 통과한 회귀를 독립 judge가 추론+probe로 잡음(rubber-stamp 아님, maker≠judge 보상통제 작동). 드릴이 "단일 가드는 약하다"를 드러냄 → robust 가드로 하드닝(드릴→진짜fix 사이클). 박스포화(동시 루프 多)는 crypto/fuzz 테스트를 5s 타임아웃시킴 — 격리 재실행이 환경 vs 회귀를 가름.

## fire 9 · 2026-06-21 · skill v2.0 · 2d0f57ab (hallucinated-tool nearest-name suggestion; 3-fire merge)
meta: value-class=new-capability · pkg=@muse/tools · kind=tool-error-recovery · verdict=PASS · firesSinceDrill=9
ratchet: testFiles 1067→1067 (+2 cases tools.test, mutation-valid) · fabrication 0 · eval:computer-task PASS(무회귀) · eval:multifile-fix 여전히 FAIL(다중 stochastic 모드, 노출/이 fix로 미flip) · pnpm check exit 0 · lint clean
- 무엇: MUSE_TASK_DEBUG로 multifile 트레이스 → 모델이 read→read→edit로 **버그 실제 수정(test-passes=true)** 하나 테스트 실행에서 `run_command` 대신 `node_run`을 **환각** → bare "tool not found"로 stuck. FIX(`executor.ts` `nearestToolName`): not-found 시 토큰-공유 최다 등록도구 제안("Did you mean 'run_command'?"). 결정론, not-found 분기만, 실패-에러 텍스트만.
- 왜: fire 8(잘못된 old_string→nearest 줄)의 형제 — 잘못된 *도구명*→nearest 도구. 12B의 tool-name 환각 회복 보조(arXiv:2510.17874 reflection-repair 철학, 기존 toolErrorHint와 일관).
- 리뷰지점: mutation-valid(stub시 RED)+negative 가드(무관명→제안 없음). ④b judge PASS(misleading 무해=텍스트만 게이트 재강제, happy-path 불변, 결정론 tie-break). **DEEPER**: multifile은 다중 stochastic 모드(조기중단·node_run환각·garbage명+gemma `<|channel>thought` 템플릿토큰 누수) → 이 fix는 node_run만; 템플릿누수는 별도 @muse/model adapter 버그. eval의 `modelRanTest=includes("run_command")`도 brittle path-grading(outcome 채점 위반).
- 리스크: 낮음 — not-found 분기만, 실행 0(텍스트 제안), happy-path/fabrication/approval 불변. ④b PASS.
lesson: 깊은 measure-first(debug 트레이스)가 "노출 다 됐는데 왜 FAIL"을 분해 — 모델은 *수정은 성공*하나 도구명 환각(node_run)+템플릿토큰 누수로 verify 실패. 결정론 핸들(nearest-name)은 한 모드만; 나머지는 model/adapter 영역. fire 8·9 = "잘못된 입력→nearest 실제값 제안"의 형제 패턴(edit old_string·tool name).

## fire 8 · 2026-06-21 · skill v2.0 · e83287c5 (edit no-match nearest-line hint; pivot to fs/edit-repair)
meta: value-class=new-capability · pkg=@muse/fs · kind=edit-repair · verdict=PASS · firesSinceDrill=8
ratchet: testFiles 1065→1065 (+2 cases fs-write-tools, mutation-valid) · fabrication 0 · eval:computer-task PASS(무회귀) · pnpm check exit 0(LINE 웹훅 20s 타임아웃 flake=박스포화, stash-격리 854/854 통과 확인) · lint clean
- 무엇: diversity RATCHET(tool-exposure 3연속 4·6·7)로 다른 (pkg,kind) 전환 — @muse/fs 3× scout(path-safety 전 write도구·read-before-edit 형제·edit repair 모두 견고) 후 유일 갭=genuine content-miss 시 `applyEdit`이 "old_string not found"만 반환(self-correct 불가). FIX: `nearestLineHint`(shared-word overlap로 파일의 가장 가까운 줄을 에러에 첨부, threshold·120자·noise 억제). 순수/결정론, 실패-메시지 only(매칭/write 불변).
- 왜: 노출 다 고쳐도 모델이 잘못된 old_string을 주면 repair 피드백이 unhelpful → 실제 텍스트를 줘 next 시도 self-correct. 12B 멀티스텝 신뢰성에 간접 기여(repair 루프 단축). fail-closed posture 불변(no location-guess).
- 리뷰지점: mutation-valid(헬퍼 stub시 RED). ④b judge PASS(write 유발 0, noise 억제 probe, 결정론 tie-break, scope 정직). LINE 웹훅 flake는 stash-격리로 pre-existing env 타임아웃 확정(내 fs 변경 무관).
- 리스크: 낮음 — 에러 문자열만 enrich, 매칭/write/fail-close 전부 불변. ④b PASS.
lesson: 3× scout로 "코드가 이미 견고"를 *코드로 확인*하면 성급-exhaustion(fire 3) 아니라 정당한 vein-상태 파악 — fs primitives는 hardened, 남은 갭은 repair-피드백 품질(작지만 clean)뿐. **computer-control clean-deterministic vein 대부분 소진**: 노출 done(4·6·7)·fs hardened(8), 잔여 multifile 블로커는 12B model-behavior(fuzzy/stochastic, deterministic 슬라이스 아님). 다음=agentic-persistence(전용 eval예산) 또는 mandatory-bloat 리팩터(broad).

## fire 7 · 2026-06-21 · skill v2.0 · ea75ca36 (file_edit code-edit intent; EXPOSURE CHAIN COMPLETE)
meta: value-class=new-capability · pkg=@muse/tools · kind=write-intent-gate · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 1065→1065 (+1 case tools.test, mutation-valid) · fabrication 0 · file_edit 노출 fixed(probe) · eval:computer-task PASS(무회귀) · eval:multifile-fix 여전히 FAIL(노출 아닌 12B 멀티스텝) · pnpm check clean(LINE 웹훅 flaky 격리 854/854) · lint clean
- 무엇: fire 6 REMAINING(a) 처리 — file_edit(write-risk)가 `write_without_mutation_intent` 게이트의 `isWorkspaceMutationPrompt`(워크스페이스-객체 vocab만)에 막혀 code-fix 프롬프트에 미노출. FIX: 3 힌트 리스트에 code-edit vocab 추가(workspace/target += file/source/code/bug/function+KO, mutation += fix/debug, KO += 고쳐). file_edit 노출됨(probe), tasks.add는 relevance 게이트로 여전히 차단.
- 왜: 노출 체인의 마지막 조각 — fires 4(starvation)·6(keyword)·7(write-intent)로 file_grep/read/edit/run_command 전부 code-fix task에 도달가능. multifile eval은 여전히 FAIL이나 이제 순수 12B 멀티스텝(file_read만 쓰고 멈춤) — tool-filter로 못 고치는 model-behavior.
- 리뷰지점: mutation-valid 테스트(revert시 RED, 3 힌트 차원 모두 필요). ④b judge PASS + 정직한 residual: relevance 백스톱이 fix/debug엔 누수0이나 add/create 동음이의("add a function to the file")엔 tasks.add/calendar.create 누수(기존 키워드 중복, approval-gate로 bounded=노출≠쓰기) — 내 "완전 차단" 주장 과장이라 정직히 기록.
- 리스크: 낮음 — write-intent 게이트 자체 불변(vocab만 확장), pure-read는 여전히 차단, approval/path-safety/fabrication=0 불변. add/create 누수는 기존+approval-bounded.
lesson: 노출은 3층(starvation·relevance-keyword·write-intent)이고 셋 다 고쳐도 12B 멀티스텝이 별도 천장 — measure-first가 "노출 fixed인데도 FAIL"로 천장을 model-behavior로 격리. ④b가 maker의 안전주장 과장(relevance 백스톱)을 잡음 → 정직히 기록(judge가 scope-honesty도 GATE).

## fire 6 · 2026-06-21 · skill v2.0 · 0832ff97 (code-task tool keywords; multi-file exposure ↑, 3-fire merge)
meta: value-class=new-capability · pkg=@muse/tools+@muse/fs · kind=tool-relevance/keywords · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 1062→1062 (+2 cases tools.test, mutation-valid) · fabrication 0 · eval:multifile-fix exposure ↑(file_grep,context→file_read+run_command) · eval:computer-task PASS(무회귀) · pnpm check exit 0 · lint clean
- 무엇: measure-first on `eval:multifile-fix`("run the test, fix the bug") FAIL 발견 → root: `run_command`이 **키워드 0개**라 run/test 프롬프트에 relevance 0 → starved(노출조차 안 됨); file 도구도 code-fix 동사 미보유. FIX(sibling-audit): run_command + file_read/grep/edit/multi_edit에 code/run 키워드. multi-file 노출 개선(file_read+run_command 이제 노출), single-file 무회귀.
- 왜: 멀티파일 측정이 새 결정론 갭(run_command 키워드 0개=unreachable)을 드러냄 — fire 4(starvation)·fire 6(keyword)이 tool-exposure의 두 층. eval:multifile-fix 바이너리(muse-runner) main에서 복사해 언블록.
- 리뷰지점: mutation-valid 테스트(0-keyword run_command은 cap에서 탈락=RED, keyworded=생존; ④b finding-1 지적 후 cap-exercise로 수정). IrrelAcc(흔한 단어 over-fire)는 approval-gated라 harm 아님(④b)+build/script 제거로 경감. REMAINING: file_edit가 isWorkspaceMutationPrompt(워크스페이스 객체용, code-edit 미인식)에 막힘 + 12B 멀티스텝(read만 쓰고 미진행) → decompose.
- 리스크: 낮음 — 키워드 additive, write 도구 over-expose 안 됨(mutation-gate 유지), single-file 무회귀. ④b PASS.
lesson: measure-first를 *다른 eval*(multifile)로 넓히면 새 결정론 갭이 나온다 — run_command 키워드 0개는 "도구가 도달조차 못함"의 명백한 버그. ④b가 weak-test(cap 미exercise)를 잡아 mutation-valid로 교정(judge가 maker 테스트 품질도 GATE).

## fire 5 · 2026-06-20 · skill v2.0 · 0d3ef486 (top item DONE; bloat = deliberate decompose)
meta: value-class=refactor(work-list) · pkg=tools(scoping) · kind=decompose-design-sensitive · verdict=N/A · firesSinceDrill=5
ratchet: testFiles 1062→1062 · fabrication 0 · eval:computer-task PASS (fire-4 fix holds, no regression)
- 무엇: fire-4가 top ★(wrong-tool)을 결정론적으로 FIX(eval pass^3 3/3)했으니 다음 후보=잔여 bloat(time/math/regex가 domain="core"=always-on). 코드로 스코핑: 6개 time 도구가 `muse-tools-time.ts`에서 core, math/regex도 여러 파일 산재 → 6+ 파일 re-tag + keyword 커버(DEFAULT_DOMAIN_KEYWORDS에 math/time/text 부재) + 크로스-서피스 검증 필요한 **broad·design-sensitive 리팩터**.
- 왜 코드 슬라이스 없음: **현재 측정된 실패 없음**(fire-4 reserve가 eval을 PASS시킴) — measure-first 원칙상 측정 실패 없는 speculative broad 리팩터를 auto-fire에 강행 안 함. design-sensitive(어떤 유틸이 진짜 "always reachable"인가는 판단 필요) + 강등이 time/math를 필요할 때 숨길 risk → DELIBERATE decompose 기록(backlog).
- 리뷰지점: fire 3의 "premature exhaustion" 실수를 반복하지 않되(fire 4가 깊이 파면 clean fix가 나옴을 증명), 이번 bloat는 *진짜로* broad+design-sensitive+측정실패-없음임을 코드로 확인(6+파일, keyword 부재 trap). 다음 measure-first 후보=eval:multifile-fix(멀티파일 실패 탐색).
- 리스크: 0 — 코드 미변경, 정밀 decompose 기록 + fire-4 fix 회귀 0 확인.
lesson: fire 3(성급한 exhaustion)과 fire 5(정당한 decompose)의 차이 = *코드로 스코프를 확인*했는가. fire 3은 "fuzzy"라 단정(틀림), fire 5는 6+파일·keyword-trap·측정실패-없음을 실제 확인. 측정+스코프 확인이 "더 파라" vs "deliberate로 미뤄라"를 가른다.

## fire 4 · 2026-06-20 · skill v2.0 · a925a13e (DETERMINISTIC fix SHIPPED — eval flips FAIL→PASS)
meta: value-class=new-capability · pkg=@muse/agent-core · kind=tool-exposure/starvation-fix · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 1060→1060 (+3 cases tool-filter.test) · fabrication 0 · **eval:computer-task 2/2 STABLE FAIL → PASS** (model now file_grep→read→edit) · pnpm check exit 0 · lint clean
- 무엇: 진안의 "계속해줘 찾아서"로 더 깊이 파서 fires 1-3의 "fuzzy" 결론을 뒤집음 — **결정론 구조 버그 발견+수정**: always-on MANDATORY 10개(math_eval/regex_extract/time_add/context×3/skills×3)가 cap=6을 초과 → `capToolsByRelevance`의 `remaining=0` 분기가 optional 전체를 드롭 → file 도구가 *invisible*(모델이 볼 수 없음→절대 못 고침). FIX(`tool-filter.ts`): (1) positively-relevant optional에 reserve(FLOOR=3, irrelevant은 여전히 드롭) (2) FILE_PATH_RE 부스트(프롬프트에 경로 있으면 files-domain +3 → file 클러스터가 reserve 상위).
- 왜: 측정을 더 깊이(mandatory 개수+cap 생존 확인) 하니 "fuzzy 랭킹"이 아니라 "always-on clutter가 task 도구를 starve"하는 결정론 버그였음. 테마가 전제한 clean 결정론 fix가 맞았다 — 단지 fire 1-3이 진단을 충분히 깊게 안 했을 뿐.
- 리뷰지점: 결정론 단위테스트 3개(starvation rescue·irrelevant-still-dropped·path-boost all-3-files) RED-on-old. eval flip 2/2→PASS(file_grep,read,edit 사용). ④b 적응형 judge PASS(over-exposure 없음, URL false-trigger 무해, 불변식 불변). judge note 대응: **pass^3 = 3/3 STABLE PASS 확인**(durable, flaky 아님; 각 run file_grep→read→edit).
- 리스크: 낮음 — optional 재랭킹/reserve만(mandatory/recent/risk 불변), relevant만 admit. ④b PASS.
lesson: "fuzzy/exhausted" 결론은 *진단 깊이 부족*일 수 있다 — 한 겹 더 측정(mandatory 카운트+cap 생존)하니 fuzzy로 보이던 게 clean 결정론 버그였다. 진안이 "계속 찾아서"로 민 게 옳았다. measure-first는 *충분히 깊게* 해야 전제(결정론 fix 가능)를 확증한다.

## fire 3 · 2026-06-20 · skill v2.0 · 54e86fee (PRECISE root-cause + honest theme-wall, 3-fire merge)
meta: value-class=refactor(work-list) · pkg=agent-core(diagnosis) · kind=root-cause-final · verdict=N/A · firesSinceDrill=3
ratchet: testFiles 1060→1060 · fabrication 0 · eval:computer-task 2/2 STABLE FAIL (root-caused, not yet fixed)
- 무엇: decompose (c) 착수 중 **정밀 root-cause 확정**: `muse.context.*`·`muse.skills.*` 6개가 전부 **domain="core" → isMandatoryTool=true**(always-on, cap 보호). 그래서 *모든* 턴(file-fix 포함)에 20개 도구가 노출되고 그 6개가 영구 distractor. 12B가 20개(tool-calling.md ≤5-7의 3배) 중 prominent한 skills/context를 file 도구 대신 선택.
- 왜 코드 슬라이스 없음: skills/context를 core로 둔 건 *의도적 설계*(모델이 항상 skill/context 호출 가능해야 함) — mis-classification 아님. 따라서 fix는 (1) intent-classification("이건 file-task → skills 숨김") 또는 (2) path-mention 부스트(file 도구 ranking↑이나 mandatory distractor는 잔존) — **둘 다 fuzzy + OUTCOME stochastic(각 eval run ~7min×pass^k)**. 테마가 전제한 "결정론적 repair"(literal-\n·scope-default — 이미 소진)와 다른 클래스. 거대 세션 말미에 stochastic 슬라이스 강행은 marginal-value floor 위반 → 정직히 기록.
- 리뷰지점: fires 1-3가 measure-first→STABLE 확인→production-필터-확인→정밀 root-cause(mandatory core 분류)로 좁혀옴. 다음 단계는 *deliberate*(전용 시간, 적응형 judge 안전망) — auto-loop이 잘 못하는 영역. 진안에게 보고.
- 리스크: 0 — 코드 미변경, 진단 완결 + 3-fire docs 머지.
lesson: 두 테마(core-hardening, computer-control) 모두 같은 벽 — clean/deterministic 베인 소진 후 남는 건 fuzzy/stochastic/slow. auto-15min-loop은 clean 결정론 슬라이스에 최적; fuzzy-stochastic-slow 영역은 deliberate human-paced가 맞다. 측정이 이 경계를 드러낸다(전제≠라이브).

## fire 2 · 2026-06-20 · skill v2.0 · 8ea83aab (root-cause investigation, DECOMPOSE step a+b)
meta: value-class=refactor(work-list) · pkg=agent-core(investigation) · kind=root-cause-analysis · verdict=N/A · firesSinceDrill=2
ratchet: testFiles 1060→1060 · fabrication 0 · eval:computer-task 2/2 FAIL (STABLE wrong-tool)
- (a) STABLE 확인: 2/2 run 동일 wrong-tool(skills/context, file 0회). (b) production은 필터함(planForContext→capToolsByRelevance) — eval도 거침 = relevance 랭킹 갭. (fire-1의 "raw assembly 노출" 정정.)
- lesson: 새 축의 "deterministic repair" 전제가 라이브 실패와 안 맞을 수 있다 — 측정이 전제를 정정. stochastic 검증 fix는 전용 fire 예산.

## fire 1 · 2026-06-20 · skill v2.0 · ee635ab0 (measure-first diagnosis + DECOMPOSE)
meta: value-class=refactor(work-list) · pkg=scripts/eval · kind=measure-first-diagnosis · verdict=N/A · firesSinceDrill=1
ratchet: testFiles 1060→1060 · fabrication 0 · eval:computer-task 1 run FAIL (wrong-tool selection)
- 부트스트랩(worktree/install/baseline) + measure-first eval → add-버그 고치기에서 12B가 skills/context만 호출(file 0회). wrong-tool selection 발견 → ★ finding으로 backlog 정제.
- lesson: 새 루프 fire 1은 measure-first eval로 *현재* 실패를 측정해 stale backlog를 정제하는 게 정직.
