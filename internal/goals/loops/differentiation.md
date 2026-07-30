# Loop journal — `differentiation` (discover competitive differentiation → widen the edge)

> Theme: discover where Muse wins **structurally** vs hermes (Nous, MIT) /
> openclaw (MIT) and widen it with a verifiable code slice each fire. Worktree
> `/tmp/muse-differentiation` (branch `loop/differentiation`, Tier1 — local
> commits only, no push). Cited research lands in
> [`../../../docs/strategy/positioning/differentiation.md`](../../../docs/strategy/positioning/differentiation.md).

## fire 1 · 2026-06-13 · skill v1.14.0 · `2d1662df`
meta: value-class=new-capability · pkg=scripts/self-eval · kind=release-gate-ratchet · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 912 · self-eval gates +1 (egressGuards=5) · fabrication 0 · grounding ratchet untouched

- **What**: Promotes Muse's 2nd moat (local-by-construction — "cloud egress refused in
  code", MUSE_LOCAL_ONLY default ON) to a **deterministic self-eval
  regression gate** on par with the grounding moat. `countEgressGuards`(`scripts/self-eval.mjs`)
  sums gated
  cloud ids(`CLOUD_PROVIDER_IDS`) + fail-close `throw new LocalOnlyViolationError`
  sites (currently 5) → `gates.egressGuards` → `detectRegressions`
  automatically catches a drop. Mirrors the RGV/grounding ratchet(`countGroundedSurfaces`) pattern exactly.
- **Why (vs which competitive lever)**: Both hermes/openclaw *support* Ollama, but
  cloud is the default/recommended (the hermes guide names Claude Sonnet 4.6 as the best model). They
  *can't build* the gate "build fails if cloud egress becomes possible" —
  it would block their own product. Only Muse has the structural advantage of being able to mechanically
  defend this invariant. (hermes's
  "Hallucination Gate" is also a model self-prompt, not deterministic code — the same asymmetry
  holds for the grounding moat too.)
- **Review point**: TDD RED(no export SyntaxError)→GREEN(12/12). OUTCOME
  falsification independently reproduced (maker≠judge, Opus judge): from a prior entry=5, removing
  1 cloud id → `pnpm self-eval` exit **1** + `egressGuards: 5→4`; restore → exit **0**.
  Deleting a throw-site also confirmed to return 4. lint:pass(whole tree). ④b Opus adversarial judge 5/5 PASS.
- **Risk/residual (non-blocking, fuel for the next slice)**: ① marker fragility — the regex is
  coupled to the `new Set([...double-quote...])` shape (an array/single-quote refactor returns 0).
  But that direction *lowers* the count, firing the regression loudly rather than dying silently (the dangerous
  "weakened but same/higher count" direction doesn't exist). ② coverage gap — the voice registry
  cloud-key-ignore + localhost-only embeddings guards are not yet included → folding them into the ratchet would
  expand moat coverage (backlog ◦).

## fire 2 · 2026-06-13 · skill v1.14.0 · `52d69df6`
meta: value-class=new-capability · pkg=scripts/self-eval · kind=ratchet-coverage-widen · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 912 · egressGuards 5→6 (voice guard now counted) · fabrication 0 · grounding ratchet untouched

- **What**: Extends fire 1's `countEgressGuards` ratchet to **the voice egress guard**.
  Adds a third marker — the point where the voice registry forces the OpenAI key to
  `undefined` under `MUSE_LOCAL_ONLY`(`parseBoolean(env.MUSE_LOCAL_ONLY, true) ? undefined`), blocking
  mic audio's cloud STT/TTS leak. Adds `voice.ts` to egressSources, value 5→6.
- **Why (vs which competitive lever)**: Expands L1-moat (local-by-construction) coverage —
  fire 1 only gated model-router egress; the mic audio path is another egress
  surface. hermes/openclaw, where cloud STT/TTS is the default, would block their own product by building the
  "build fails if the voice guard disappears" ratchet. Same structural asymmetry.
- **Review point**: TDD RED(voice marker uncounted, fail)→GREEN(13/13). OUTCOME
  falsification independently reproduced (Opus judge, maker≠judge): from prev=6, disabling the voice guard
  (`true`→`false`) → `pnpm self-eval` exit **1** + `egressGuards: 6→5`; restore → exit 0.
  Marker false positives 0 (the router's `if (...)`-form `parseBoolean(MUSE_LOCAL_ONLY,true)` is
  correctly excluded by its `? undefined` tail). lint:pass. ④b Opus adversarial judge 4/4 PASS.
- **Risk/residual (non-blocking)**: ① refactoring the voice guard into a non-ternary pattern (e.g. early-return)
  would *lower* the count, a loud regression (intended fail-loud, but the marker must be
  updated too). ② the localhost-only embeddings guard is still not included (couldn't find a file by that name —
  needs a location check) → left as a separate ◦.

## fire 3 · 2026-06-13 · skill v1.14.0 · `d30f9785`
meta: value-class=new-capability · pkg=scripts(@muse/memory proof) · kind=adversarial-proof-battery · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 912 · new deterministic battery eval:memory-poisoning (no Ollama) · fabrication 0 · egressGuards 6 untouched

- **What**: A new deterministic adversarial proof battery `scripts/eval-memory-poisoning.mjs`
  (`pnpm eval:memory-poisoning`). Leaves the fire 1-2 self-eval ratchet vein for a **different
  KIND·different surface**(@muse/memory proof). Empirically proves that the WRITE-time provenance gate
  of memory promotion (`dropModelAssertedValues`) drops a poisoned model-asserted claim on every 5 injections,
  that *the same* claim passes the `selectPromotableMemories` frequency gate if it has forged hits
  (=a competitor would promote it, Muse's write-gate blocks it), and that a user-stated value passes both
  (no-collateral).
- **Why (vs which competitive lever)**: L2 — OpenClaw's "Dreaming"(minRecallCount 3 +
  frequency score)·Hermes(FTS5+LLM summarize) promote a frequently-recalled false claim (GROUNDED≠TRUE
  on the memory surface). Adding write-time provenance drop to their frequency-promotion would kill
  the "the agent learns from its own answers" feature, so they structurally can't follow. For Muse, that drop
  *is* the product, so it's free.
- **Review point**: battery PASS 4/4. OUTCOME falsification independently reproduced (Opus judge, maker≠judge):
  disabling `dropModelAssertedValues`(`if(!modelAsserted)`→`if(true)`)+rebuild → battery
  exit **1** scenario 1 ✗; restore+rebuild → exit **0**. The judge confirmed in dist that scenario 2 calls the
  *actual* `selectPromotableMemories` export (not hardcoded).
  0 lines of TS source changed (pure new script + 1 line in package.json). lint:pass · self-eval regression 0.
- **Risk/residual (non-blocking)**: ① scenario 2's forged-hits are inline synthesis, not an actual recall pass
  (fine for a deterministic unit proof, but doesn't prove that injection produces an actual hit).
  ② the battery depends on a dist build (the package.json script handles it; bare `node` requires a
  manual rebuild after editing src). → note explicitly if folded into a CI bundle.

## fire 4 · 2026-06-13 · skill v1.14.0 · `ee50c9d5`
meta: value-class=new-capability · pkg=@muse/autoconfigure · kind=egress-gap-closure(fail-close) · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 914→915 · egressGuards 6→7 (embedder guard folded in) · fabrication 0 · grounding floor strengthened

- **What**: Closes a **real egress gap** in the L1 moat. `createOllamaEmbedder`
  (`@muse/autoconfigure/context-engineering-builders.ts`) could follow `OLLAMA_BASE_URL`
  with no local-only gate, sending the user's **plaintext** notes/memory/episode content to a remote
  `/api/embeddings`. Added a construction-time fail-close
  (`MUSE_LOCAL_ONLY` default ON + non-loopback → `throw LocalOnlyViolationError`,
  reusing @muse/model's `isLoopbackUrl`); covers 3 call sites + a daemon bypass through a single chokepoint.
  Folds the new throw into the egressGuards ratchet(6→7) to self-protect the guard itself.
- **Why (vs which competitive lever)**: The chat router only checks OLLAMA_BASE_URL when
  `providerId==="ollama"` → localhost LM-Studio/openai-compatible chat + a remote
  OLLAMA_BASE_URL **diverge**, passing the chat gate while the embedder still egresses; the daemon
  enrich path bypasses the router entirely. architecture.md's "embeddings localhost-only"
  claim was false for a remote OLLAMA_BASE_URL. cloud-default competitors send embeddings to an external
  API by default, so they have no structural motive to build this fail-close (same asymmetry as L1).
- **Review point**: TDD RED→GREEN. 6 behavior test cases(remote+local-only → throw
  **AND fetch called 0 times**=plaintext not sent; loopback/unset/localhost/opt-out pass through; remote+
  local-only=false → an actual remote POST confirmed). ④b independent Opus judge **5/5 PASS**:
  confirmed the gap was real (file:line check)·reproduced falsification by removing the guard line (2 fail-close
  assertions FAIL)·over-block 0·autoconfigure 519/519·the invariant *strengthened*. lint:pass.
- **Risk/residual (non-blocking)**: `muse doctor`/`evaluateLocalOnlyPosture` doesn't yet
  report the embedder's OLLAMA_BASE_URL locality (runtime egress is blocked but there's a doctor
  blind spot) → follow-up ◦. Would also be good for the architecture.md comment to reflect this enforcement point.

## fire 5 · 2026-06-13 · skill v1.14.0 · `54c5237f`
meta: value-class=wiring · pkg=@muse/autoconfigure · kind=posture-transparency · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 915 · egressGuards 7 (reporting added, not a throw→unchanged) · fabrication 0 · grounding floor maintained

- **What**: Exposes fire 4's embedder fail-close in `muse doctor` posture (L3 complete).
  `evaluateLocalOnlyPosture`(`setup-status.ts`) only re-runs the chat router(`createModelProvider`)
  and never looks at the embedder base — with local-only ON + a **remote OLLAMA_BASE_URL**, the
  runtime fail-closes but doctor gave a false "🔒 ok" reassurance. Added an embedder-base locality check
  (`isLoopbackUrl`, the same base resolution as the fire-4 guard) to the local-only ON branch →
  status `"fail"` + OLLAMA_BASE_URL guidance when off-box.
- **Why (vs which competitive lever)**: Extends "shows its work" from claim-grounding to **honest
  egress-posture reporting**. Keeps doctor from diverging from the runtime (same base resolution) —
  cloud-default competitors don't have an egress posture to show at all.
- **Review point**: TDD RED(remote case ok→doesn't fail)→GREEN. Branch is precise: the remote case uses
  `MUSE_MODEL=lmstudio/llama`(LOCAL chat), so the chat router passes and the embedder check
  fires (with ollama chat, the router would throw first, making it moot — avoided). Confirmed
  parity between posture↔runtime base resolution. ④b independent Opus judge **5/5 PASS** + reproduced falsification
  by removing the check. autoconfigure 522/522 · lint:pass · self-eval regression 0.
- **Risk/residual (non-blocking)**: posture and the runtime guard keep base resolution in sync by hand (two
  string literals) — a future change to embedder base resolution must move both together;
  structuring it as a shared `resolveEmbedderBase()` helper would make parity convention→structural(possible separate ◦).

## fire 7 · 2026-06-13 · skill v1.14.0 · `e985551d`
meta: value-class=refactor · pkg=@muse/autoconfigure · kind=parity-hardening · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 922 · egressGuards 7 (unchanged) · fabrication 0 · grounding floor maintained

- **What**: Resolves fire 5's residual — extracts the embedder base resolution that the fire 4 runtime guard
  and fire 5 doctor posture each did with their own string literal into a shared helper `resolveEmbedderBase(env)`
  (`packages/autoconfigure/src/embedder-base.ts`), and refactors both call sites to use it.
- **Why (vs which competitive lever)**: L3-moat *durability* — if doctor↔runtime base resolution is
  maintained by hand in two places, one side can drift out of sync, causing "doctor reports a posture different
  from the runtime." Makes parity convention→**structural** via a shared helper, so "shows its
  work"(honest egress posture) doesn't break on future changes.
- **Review point**: a behavior-preserving refactor — 4 helper cases via TDD + the existing fire-4 guard/fire-5
  posture suite stays green(532/532). ④b independent Opus judge **4/4 PASS**: proved the old runtime
  `(trimmed && len>0)?trimmed:default` ↔ the helper `?.trim()||default` are bit-identical on empty/whitespace/
  undefined, both call sites use the helper·0 inline remnants, egress
  throw unchanged·egressGuards 7 unchanged. lint:pass.
- **Risk/residual (non-blocking)**: none (material). The local-by-construction vein has been dug
  enough (L1/L3, 4 fires) — recommend diversifying the next fire into a new lever on a different moat axis
  (grounding/"shows its work").

## fire 8 · 2026-06-13 · skill v1.14.0 · `33c3390d`
meta: value-class=new-capability · pkg=@muse/recall · kind=citation-honesty(shows-its-work) · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 922 · new battery eval:receipt-drift (no Ollama) · recall 88/88 (backward-compat) · fabrication 0 · grounding engine unmodified

- **What**: L4(a different moat axis = "shows its work" citation honesty). Verifies the source receipt's
  cited snippet against the **current on-disk file content**, not a retrieval-INDEX copy.
  Adds a backward-compat optional `diskContents`
  map to `formatSourceReceipts`(`@muse/recall`) — if the snippet is no longer on disk(edited) or is null(deleted),
  **hides the stale quote and shows the reason**(prevents fake citation). A pure helper
  `snippetOnDisk`(…truncation+normalize). A new deterministic battery `scripts/eval-receipt-drift.mjs`
  proves it end-to-end with REAL temp files.
- **Why (vs which competitive lever)**: Competitors' RAG architecture cites from an embedded/index copy —
  they have no product reason to re-read disk at render time (a throughput/breadth pitch). If a note is
  edited/deleted after indexing, their "citation" becomes a fake citation. For Muse, local·single-user·
  "shows its work" is the product itself, so re-reading its own notes is cheap → a structural edge. (AIS principle·
  citing arXiv 2409.11242.)
- **Review point**: TDD RED(drift undetected when diskContents is absent, 3 fail)→GREEN(present 27/27,
  5 new cases assert actual downgrade behavior). Battery PASS 7/7. ④b independent Opus judge **4/4
  PASS** + reproduced falsification(`snippetOnDisk`→`return true` → battery exit 1, 2 drift cases
  ✗; sed reverse-restore→PASS). recall 88/88·cli build OK(backward-compat)·grounding engine unmodified.
  **Pitfall recorded**: during falsification, `git checkout present.ts` wiped the uncommitted implementation and it had to be reapplied —
  never `git checkout` an uncommitted file; falsify via reverse-applying sed instead.
- **Risk/residual (non-blocking, slice 2)**: for this to actually take effect on the *user receipt*, the CLI caller
  (`commands-ask.ts`) needs to read the cited note's current disk content and populate `diskContents`
  (path resolution + skipping ad-hoc `--url`/`--clipboard` needs its own tests) → backlog ◦. Until then the logic is
  live·verified but user exposure is deferred.

## fire 9 · 2026-06-13 · skill v1.14.0 · `8dc2f44d`
meta: value-class=test-coverage(JUDGE-DRILL) · pkg=@muse/recall · kind=judge-drill · verdict=PASS · firesSinceDrill=0
ratchet: testFiles 922 · recall 89/89 · fabrication 0 · grounding engine unmodified

- **What**: reached 8 consecutive allPASS → mandated **JUDGE-DRILL**. Targets a real gap — fire-8
  `snippetOnDisk`'s `…`-truncation handling was untested end-to-end. ① injected a deliberately **inert** test
  (`toBeDefined`+`toContain("📎")` — trivially true regardless of truncation/verification) → ② the ④b independent
  Opus judge returned **FAIL**(proved inert via mutation: passes even with snippetOnDisk disabled) →
  ③ rolled back → ④ a genuinely discriminating test(faithful truncated snippet shown+`…` included / drift hidden+
  contrasted with "changed since").
- **Why**: verifies the maker≠judge compensating control — periodically proves the verifier isn't a rubber stamp
  even at a same-model ceiling(Opus). Side value: locks down fire-8 L4's `…`-truncation disk-verify path (actual
  coverage +1).
- **Review point**: the drill proved both directions — the inert version, judge FAIL(still PASSes even with
  `snippetOnDisk`→`return true` disabled = non-discriminating) · the real version **FAIL**s on the same
  disabling(discriminating) → restored via sed(no git checkout, avoiding the fire-8 pitfall) →
  recall 89/89·present 28/28·lint:pass·self-eval regression 0. firesSinceDrill reset to 0.
- **Risk/residual (non-blocking)**: none. L4 slice 2(CLI wiring) remains an open ◦.

## fire 10 · 2026-06-13 · skill v1.14.0 · `1860c9a7`
meta: value-class=wiring · pkg=@muse/recall+apps/cli · kind=L4-live(citation-honesty) · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 926 · recall 95/95 · cli build OK · fabrication 0 · grounding engine unmodified

- **What**: L4 slice 2 — makes fire 8's disk-verify logic **live for users**. A new exported
  async helper `buildDiskContents(answer, chunks, notesDir, verifyTargets?)`(@muse/recall) reads
  the current disk content of cited notes and builds a map(present→content·gone→null·ad-hoc→skip;
  path resolution is char-identical to `collectCitedNoteAges`). Called just before receipt render in
  `commands-ask.ts` and passed as the 6th argument to `formatSourceReceipts`.
- **Why (vs which competitive lever)**: the wiring the fire 8 judge flagged as "required to convert user value" —
  now `muse ask` **actually hides** a stale snippet from a note edited/deleted after indexing
  (fake-citation prevention is now user-exposed). Competitor cloud-RAG doesn't re-read disk at render time.
- **Review point**: TDD RED(buildDiskContents doesn't exist, 2 fail)→GREEN(present 30/30, 2 new cases
  assert present/gone/ad-hoc + end-to-end drift-hiding). ④b independent Opus judge **4/4 PASS** +
  reproduced falsification(`readFile`→empty string → the present-content assertion breaks = proves an actual file read).
  recall 95/95·cli build OK·grounding engine 0 lines·IO only re-reads cited notes.
- **Risk/residual (non-blocking)**: since the end-to-end drift test also takes the drift path for empty/missing
  content, "actually reads" is pinned solely by test 1(judge's observation; test 2's double-pin is an optional strengthening).
  Of the four L-cases(L1/L2/L3/L4), L4 is now fully live.

## fire 11 · 2026-06-13 · skill v1.14.0 · `f5bf7362`
meta: value-class=new-capability · pkg=scripts(@muse/mcp proof) · kind=adversarial-proof-battery · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 928 · new deterministic battery eval:action-log-tamper (no Ollama) · fabrication 0 · owning-loop files unmodified

- **What**: L5(a new axis = auditability/tamper-evidence). A new deterministic adversarial battery
  `scripts/eval-action-log-tamper.mjs`(`pnpm eval:action-log-tamper`). Proves end-to-end with REAL temp files that
  every autonomous action(performed+refused) is sealed with a genesis-anchored SHA-256 hash chain:
  intact-verify·content-tamper detection·deletion/reorder detection·refused chain·
  undo accountable+chain preserved·no-collateral. Read-only imports @muse/mcp's *already-exported* symbols
  (`appendActionLog`/`verifyActionLogChainFile`/`undoLoggedAction`/`readVetoes`)(the fire3 @muse/memory·fire8
  @muse/recall pattern).
- **Why (vs which competitive lever)**: competitors treat action/mutation history as plain mutable state —
  hermes only does whole-skill snapshot-restore(no integrity check), openclaw can't undo a promoted memory
  (#62184 not-planned). Per-action hash-chain integrity is pure cost for a throughput product and
  structurally conflicts with the "free self-mutation" pitch — for a single-user "can't quietly get fixed"
  identity, that chain *is* the trust contract. (Honest scope: tamper-EVIDENT, not tamper-PROOF —
  a motivated attacker's full recomputation needs an off-box anchor, stated as out-of-scope in the source.)
- **Review point**: battery PASS 10/10. ④b independent Opus judge **4/4 PASS** + reproduced falsification
  (disabling `verifyActionLogChain`→battery exit 1, 3 tamper/deletion/reorder cases ✗ → restored via Edit,
  no git checkout). Driven by REAL exports(not mocks), the judge confirmed in dist. mcp src/agent-core/
  recall/grounding 0 lines(git status shows only 2 files). lint:pass·self-eval regression 0.
- **Risk/residual (non-blocking)**: the competitor-comparison claim(hermes has no integrity·openclaw #62184)
  is narrative in the battery comment, not an executed assertion(Muse's own property is fully proven). The chain
  tip is sealed by the next append(append-local, stated in the source). Option: fold a tamper-guard ratchet into self-eval.

## fire 12 · 2026-06-13 · skill v1.14.0 · `ad7c21cb`
meta: value-class=new-capability · pkg=scripts(@muse/policy proof) · kind=adversarial-proof-battery · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 929 · new deterministic battery eval:policy-symmetry (no Ollama) · fabrication 0 · owning-loop files unmodified

- **What**: L6(a new axis = deterministic-safety-as-code). A new deterministic battery
  `scripts/eval-policy-symmetry.mjs`(`pnpm eval:policy-symmetry`). Proves @muse/policy's guards are
  **model-independent, language-symmetric** code: detects injection identically across EN/KO/CN, also detects
  zero-width/homoglyph/HTML-entity obfuscation after normalization(`normalizeForInjectionDetection`), detects
  obfuscated PII via `findPii`, `maskPii` is non-destructive(original unchanged, returns a new string), 0
  over-blocking of benign prose. Read-only imports @muse/policy's already-exported guards(policy unowned by this loop).
- **Why (vs which competitive lever)**: competitors are prompt-based/model self-policing, or narrow —
  hermes's guard is EN-focused+context-file scoped, and its PII redaction is output-only·off-by-default·
  **destructive on disk**(#5322 writes `***` into the source file); openclaw is a bolt-on NeMo(assumes
  stateless-single-turn). For Muse, "security is deterministic code, not a prompt"(CLAUDE.md) is identity →
  doesn't break under a model swap/language asymmetry. (Honest scope: proves the guard's *property*, not a claim
  that every live surface is wired — a code-property proof like L2/L4/L5.)
- **Review point**: battery PASS 13/13. ④b independent Opus judge **4/4 PASS** + reproduced falsification
  (making `normalizeForInjectionDetection` a no-op → battery exit 1, 4 obfuscation cases ✗ → restored via Edit,
  no git checkout). EN/KO/CN detection·non-destructive masking·0 over-blocking directly reproduced by the judge
  via `node -e`. policy src/agent-core/recall/mcp/grounding 0 lines(git status shows only 2 files). lint:pass·self-eval
  regression 0. zero-width is `` -escaped(no raw bytes).
- **Risk/residual (non-blocking)**: competitor-comparison citations(hermes #5322 etc.) are narrative, not
  an executed assertion(Muse's own property is fully proven). Live verification of guard wiring is
  owned-loop territory, so deferred.

## fire 13 · 2026-06-13 · skill v1.14.0 · `56399f81`
meta: value-class=new-capability · pkg=scripts/self-eval · kind=differentiation-proof-ratchet · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 930 · self-eval +1 gate (differentiationBatteries=4) + eval:differentiation bundle · fabrication 0 · existing gate regression 0

- **What**: a consolidation — *mechanically defends* the 4 differentiation proof batteries from fires 3/8/11/12.
  Adds `countDifferentiationBatteries`(counts the battery-header marker "Differentiation proof battery")
  + a `gates.differentiationBatteries`(=4) gate to `scripts/self-eval.mjs`, and an `eval:differentiation`
  bundle(runs all 4 batteries in one go) to `package.json`. Same pattern as the egressGuards/groundedSurfaces
  ratchets — `detectRegressions` fails self-eval if a battery is deleted.
- **Why**: the batteries proving 6 levers(L1-L6) were runnable but had no CI gate, so they could be silently
  deleted. Turns "differentiation proof never disappears" into a self-eval invariant, pinning the edge evidence
  itself as a regression-first floor(applying "PROVE it / grounded-surface count never drops" to the differentiation
  batteries).
- **Review point**: TDD RED(no export)→GREEN(self-eval unit 14/14). OUTCOME falsification
  (mv'd 1 battery away → `pnpm self-eval` exit **1** `differentiationBatteries: 4→3`; restored → 0).
  The `eval:differentiation` bundle actually runs all 4 batteries·all PASS. ④b independent Opus judge
  **4/4 PASS**(directly confirmed the bundle really works·existing gate regression 0). lint:pass·git status
  shows 3 files·owning-loop 0 lines.
- **Risk/residual (non-blocking)**: the marker can also match a string literal, but the direction is
  *over-count*, so there's no floor weakening(judge's observation). The differentiation vein has gotten thick, so
  next is either a fresh L7 or another consolidation.

## fire 14 · 2026-06-13 · skill v1.14.0 · `5fbe73ea`
meta: value-class=new-capability · pkg=scripts(@muse/mcp proof) · kind=adversarial-proof-battery · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 931 · differentiationBatteries 4→5 (auto-counted by the fire-13 ratchet) · fabrication 0 · owning-loop files unmodified

- **What**: L7(a new axis = outbound draft-first/fail-close). A new deterministic battery
  `scripts/eval-consent-fail-close.mjs`(`pnpm eval:consent-fail-close`). Drives @muse/mcp's
  `performConsentedAction` with a contract-faithful fetch fake(no real network) to prove that
  **a 3rd-party outbound action fail-closes**: all 5 vectors(no-consent/scope-mismatch/host-mismatch/
  veto/timeout) produce *0 external effects*(0 fetch calls=no credential leak), and only a recorded scope+host
  matched consent gets sent via Bearer. The fire-13 ratchet auto-counts 4→5.
- **Why (vs which competitive lever)**: competitors' value proposition is *autonomy* — hermes/openclaw
  act on the world by model judgment. A recorded scoped-consent fail-close gate is an off-brand cost for a
  throughput product, but for a single-user "a wrong autonomous send is a bug you can't roll back"(outbound-safety.md)
  identity, it *is* the contract itself. Structural asymmetry.
- **Review point**: battery PASS 11/11. ④b independent Opus judge **4/4 PASS** + reproduced falsification
  (host-binding guard `if(...)`→`if(false)` → battery exit 1, a host-mismatch fetches to an evil host=
  credential leak → restored via Edit). The judge confirmed the real decision chain(veto→no-consent→host-bind→fetch)
  passes through. mcp src byte-clean(git status shows 2 files). lint:pass·self-eval differentiationBatteries=5.
- **Risk/residual (non-blocking)**: the battery proves the *consented-action seam*; ambiguous-recipient
  (P13 contacts clarify) is a separate seam and not included(a different rule in outbound-safety). Room for
  L7 expansion later.

## fire 15 · 2026-06-13 · skill v1.14.0 · `ff109c97`
meta: value-class=new-capability · pkg=scripts(@muse/mcp proof) · kind=adversarial-proof-battery(L7-widen) · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 935 · differentiationBatteries 5→6 (auto via the fire-13 ratchet) · fabrication 0 · owning-loop files unmodified

- **What**: L7 widening(outbound-safety rule 3 = a recipient is *resolved*, never *guessed*). A new
  deterministic battery `scripts/eval-recipient-resolution.mjs`(`pnpm eval:recipient-resolution`). Drives
  @muse/mcp's `resolveContact`: a single match→resolved(identifier=actual address), **multiple matches→ambiguous
  (all candidates, no best-guess)**, no-match/empty→unknown, a relationship("manager") is not
  an identifier. Closes fire 14's residual.
- **Why (vs which competitive lever)**: a wrong autonomous send is an outbound mistake that can't be rolled
  back. Competitor autonomy-first sends "message Alex" autonomously by best-match(the wrong Alex). Muse lets
  the user pick the recipient via ambiguous→clarify. Same axis as L7, a different vector(non-overlapping).
- **Review point**: battery PASS 9/9. ④b independent Opus judge 4/4 PASS + reproduced falsification
  (`if (pool.length === 1)`→`>= 1`(best-guess) → battery exit 1, 2 ambiguous cases ✗ → restored via Edit).
  mcp src 0 lines(git status shows 2 files). lint:pass · self-eval differentiationBatteries=6.
- **Risk/residual (non-blocking)**: actually firing the clarify-directive is agent-core wiring(not included,
  focused on proving the seam). Next is either a fresh axis or an honest thinning judgment.

## fire 16 · 2026-06-13 · skill v1.14.0 · `1f4b4b1d`
meta: value-class=research(EXHAUSTION) · pkg=docs · kind=vein-exhaustion-record · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 939 · differentiationBatteries 6 (unchanged) · fabrication 0 · no code slice (an honest exhaustion)

- **What**: an EXHAUSTION verdict. The Opus scout(WebSearch+repo audit) honestly reports **genuinely no new,
  non-thin differentiation axis** after 7 levers. The only fresh competitor weakness found(self-authored-skill
  admission: hermes #25833 has zero write-time validation·#7072 Skills Guard bypass, openclaw's Dreaming lacks
  plaintext vetting) is **already closed by Muse**(`scanSkillBodyForRisks`→quarantine·
  `skillDraftConstraintViolations` reject·execute-gating·`validateUmbrellaCoverage`) →
  an *already-built* extension of L2+L6, not a new L8. Records vein-status in the differentiation ledger.
- **Why**: forcing an 8th lever while already holding 7 would be an honesty violation(manufacturing a weak
  lever is forbidden). Confirming that this axis is *already defended* is itself the deliverable — it proves the
  differentiation thesis is comprehensive.
- **Review point**: directly grep-verified the scout's claims — confirmed `scanSkillBodyForRisks`/quarantine/
  `skillDraftConstraintViolations`/`validateUmbrellaCoverage` actually exist, confirmed the absence of
  `validateSkillToolReferences`(the only gap, but it's packages/skills+agent-core owning-loop territory).
  Sources cited from scout WebSearch(Repello threat model·hermes #25833/#7072·openclaw privacy guides).
- **Risk/residual**: recommends handing off gap candidate #1(skill tool-reference integrity, #25833
  dangling-ref) to the agent-core/skill-authoring owning-loop backlog. The differentiation loop continues to the
  next fire, but absent a new strong axis, consider widening/consolidation or have Jinan consider a theme retheme.
