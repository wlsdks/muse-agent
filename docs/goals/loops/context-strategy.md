# Loop journal — context-strategy

**Theme:** Context engineering — assemble the *leanest sufficient* context per
model turn, never fill it indiscriminately. Strengthen + PROVE Muse's
selective-context machinery (relevance-gated tool exposure, trimming, tool-output
capping + just-in-time retrieval, importance scoring, compaction/summary, budgets).

**Autonomy:** Tier2 — dedicated branch `loop/context-strategy` in a /tmp worktree;
each fire commits AND pushes the branch + maintains a draft PR. **Every 5th fire
(5/10/15…), merge the branch into main and push main (Jinan directive 2026-06-20),
then keep working on the branch.** Floor: NO force-push, NO `--no-verify`; the
5-fire merge is ff-only (re-fetch on conflict, never force).

**Cadence:** session cron `c66c8b81`, 20 min. **Stop:** `CronDelete c66c8b81` or cmux.

---

## Candidate queue (gap-scout / web / competitor study refills)

Verified existing context-strategy seams (from codegraph, 2026-06-20):
- **Relevance-gated tool exposure** — `ToolRegistry.planForContext` /
  `filterToolsForContext` / `DefaultToolFilter`: keep the per-turn tool catalog
  small (tool-calling.md ≤5–7). Levers: domain-tag coverage gaps, keyword recall,
  `maxTools` tuning, scope-hint inference.
- **Tool-output capping + JIT retrieval** — `maxToolOutputChars` + content-addressed
  `ContextReferenceStore` + `muse.context.fetch({ ref })`. Levers: importance-aware
  cap, ref hit-rate, head+tail elision quality.
- **Tool-output importance scoring** — `scoreToolOutputImportance` / `trimToolOutput`.
- **Conversation trimming** — `trimConversationMessages` (pairing, hard budget, anchor).
- **Compaction / summary** — `ConversationSummaryStore`, activity-log gz compaction.
- **Budgets** — `StepBudgetTracker` / `systemPromptTokenBudget` / step caps.

### Open follow-ups (next-fire candidates)

- ◦ **Grounding-quality eval under the new block order**: assert the edge-placed
  prompt order does not regress answer grounding (the judge flagged no eval
  measured this). Likely `eval:chat-grounding` / `precheck:grounding` case.
- ◦ **Regression test pinning neutralize-before-anchor ordering** (fire-4 judge residual):
  no dedicated test asserts `neutralizeInjectionSpans` runs before `carveAnchorWindow`;
  structurally guaranteed + probe-proven, but a refactor could reorder silently.
  One-line ordering regression test. (@muse/agent-core)

- ◦ **`muse.context.fetch` re-fetch live e2e** under masking: confirm a masked
  observation is actually re-fetchable by the model in a real run (fire-2 proved
  the ref is recoverable from the store; the end-to-end fetch-tool round-trip is
  untested live). Mind the ref-store TTL (30 min).

---

## fire 1 · 2026-06-20 · skill v1.14.0 · 05427eb7
meta: value-class=micro-fix · pkg=@muse/recall · kind=context-assembly-hardening · verdict=PASS · firesSinceDrill=1
ratchet: testFiles +0 (extended existing) · recall 326 pass · cli 2745 pass · pnpm check exit0 · pnpm lint exit0 · fabrication 0 · eval:tools=INCONCLUSIVE (ran many cases all-PASS then crashed mid-suite, ELIFECYCLE, no FAIL/no score — environmental Ollama drop per project_smoke_live_stall, NOT a threshold fail; slice is orthogonal to tool selection so check+lint+judge are the load-bearing gates)
- **What:** Cross-block edge-placement reorder of the optional grounding blocks in
  `@muse/recall` (`optionalGroundingSections`/`present.ts`). Present blocks are now
  ordered highest-priority→HEAD+TAIL, lowest→middle via a pure stable
  `edgePlaceByPriority`, with an explicit deterministic `OPTIONAL_GROUNDING_TIER`
  fallback (tasks>reminders>calendar>memories>contacts>actions>git>shell>episodes>feeds>reflection)
  and an optional per-block `relevance?` override.
- **Why:** "Lost in the Middle" (arXiv:2307.03172) + "Attention Basin"
  (arXiv:2508.05128) — LLMs under-attend the middle of a context sequence. Muse
  already edge-places WITHIN blocks (`reorderForLongContext`) but emitted the
  CROSS-block order relevance-blind, so an answer-bearing block could sit in the
  attention dead-zone. hermes/openclaw have no deterministic grounding-aware block
  reorder (free-form summary/recency only) → this widens Muse's edge, not copies.
- **Review point:** behavior-change to the live prompt order (set-invariant,
  gate-neutral); CLI still passes no per-turn relevance so production uses the
  fixed tier (query-relevance threading deferred — see follow-up above).
- **Risk:** none to floor — reorder is a pure permutation of the SAME present
  blocks (set-equality asserted), no drop/add, no touch to selection / citation
  gate / notesFraming / verifyGrounding / the "(grounded on …)" banner. Verified
  by independent Opus judge (6/6) + mutation RED→GREEN (identity-order → edge case
  RED; drop-block → set-equality RED).

---

## fire 2 · 2026-06-20 · skill v1.14.0 · c6789315
meta: value-class=new-capability · pkg=@muse/agent-core+@muse/memory · kind=context-history-compaction · verdict=PASS · firesSinceDrill=2
ratchet: testFiles +2 (observation-mask.test.ts, observation-masking.test.ts) · memory 455 pass · agent-core 2472 pass · pnpm check exit0 · pnpm lint exit0 · fabrication 0 · self-eval green
- **What:** Stale-observation masking in the model loop. New pure
  `maskStaleToolObservations(messages, {refStore, keepLatestTurns=1})` (@muse/memory)
  rewrites PRIOR-turn `role:"tool"` message content into a
  `[observation masked: tool <name>, N chars — re-fetch via muse.context.fetch({ ref=<id> })]`
  placeholder, stashing full bytes in the existing `ContextReferenceStore`
  (sha256[:12], same scheme as `capToolOutput`). Wired before the model call in BOTH
  `executeModelLoop` and the streaming path. Latest turn kept full.
- **Why:** "The Complexity Trap" (arXiv:2508.21433, NeurIPS'25) — masking old tool
  observations matches summarization at ~half the cost; "ACON" (arXiv:2510.00615) —
  history/observation compression cuts peak tokens 26–54%. Muse's loop appended every
  prior (capped) observation into every later turn forever → unbounded mid-context
  growth (the "Lost in the Middle" dead-zone). hermes has this as OPEN issue #2046
  (unbuilt); openclaw uses free-form summary with no ref-recoverable mask → widens edge.
- **Review point:** content-preserving (full bytes re-fetchable via ref) so the
  fabrication/grounding floor is intact — masking runs on the transient `messages`
  array only; `toolResults`/`intermediateMessages` keep full bytes so citations are
  unaffected (judge check 6 confirmed). No-op when no refStore.
- **Risk:** none to floor — pure content-only map (no drop/reorder/orphan; pairing
  preserved), deterministic, no touch to capToolOutput/citation gate/verifyGrounding/
  neutralizeInjectionSpans/tool-loop limits. Independent Opus judge PASS 8/8 + 3
  mutation RED→GREEN (no-op→leaner RED; stub-ref→recoverable RED; mask-latest→latest-full RED).
  Residual: turn-boundary = contiguous tool run (current wiring correct); ref TTL 30min.

---

## fire 3 · 2026-06-20 · skill v1.14.0 · 3e3dbf8e
meta: value-class=wiring · pkg=@muse/agent-core · kind=tool-exposure-ceiling · verdict=PASS · firesSinceDrill=3
ratchet: testFiles +0 (extended existing) · agent-core 2478 pass · pnpm check exit0 · pnpm lint exit0 · fabrication 0 · self-eval green
- **What:** Default relevance-ranked tool-exposure ceiling (6) on the LIVE runtime path.
  `agent-runtime.modelTools` left `maxTools` undefined for normal chat/ask, so
  `planForContext`/`DefaultToolFilter` advertised an UNBOUNDED catalog. New
  `capToolsByRelevance` + `DEFAULT_TOOL_EXPOSURE_CEILING=6` truncate only the
  lowest-relevance OPTIONAL tail; core/untagged + `recentToolNames` (in-flight) tools
  are always retained even above the cap. Applied in the runtime when the caller
  passes no `maxTools` (explicit caller value still wins).
- **Why:** tool-calling.md #1 (≤5–7 tools/turn) was enforceable only via opt-in
  metadata; the default live path could blow past 7 on a multi-domain prompt,
  degrading one-shot selection on the 12B. Grounding: arXiv:2606.10209 (Less Context,
  Better Agents — evict low-value tool units), arXiv:2507.21428 (MemTool — dynamic
  per-turn tool-set), BFCL IrrelAcc (over-firing is as broken as under-firing).
  hermes/openclaw advertise the full tool set (openclaw's "tool budget" is per-tool
  TIME, not count) → Muse's relevance-gated count ceiling is the differentiator.
- **Review point:** cap fires on the bare live path (NOT behind the off-by-default
  MUSE_TOOL_FILTER_ENABLED — judge confirmed); soft ceiling over the optional tail only.
- **Risk:** none to floor — narrows only the advertised catalog, no touch to
  grounding/citation/recall/approval/schemas; lossless (mandatory always kept,
  highest-relevance optional always kept). Independent Opus judge PASS 9/9 + mutation
  RED→GREEN (no-cap→length RED; array-order→highest-relevance RED). Residual: a
  poorly-`keywords`-tagged optional tool ranks by input order only (acceptable for a
  soft ceiling; note for tool authors).

---

## fire 4 · 2026-06-20 · skill v2.0.0 · bf3e77cd
meta: value-class=new-capability · pkg=@muse/memory+@muse/agent-core · kind=importance-aware-cap · verdict=PASS · firesSinceDrill=4
ratchet: testFiles +0 (extended existing) · memory 464 pass · agent-core 2492 pass · pnpm check exit0 · pnpm lint exit0 · fabrication 0 · self-eval green
- **What:** Query-anchored span retention in the per-result cap. `trimToolOutput`
  (@muse/memory) gained optional `anchorTerms`; when a line in the would-be-elided
  MIDDLE matches a term, it carves a VERBATIM bounded window around that line into the
  retained text (head/tail shrink, total still ≤ maxChars). `capToolOutput` (model-loop,
  4 callsites blocking+streaming) derives anchor terms from the latest user message
  (lowercase, stop-word + <3char filter). Absent/no-match → byte-identical no-op.
- **Why:** `capToolOutput` kept head+tail and elided the whole middle regardless of
  which span the user asked about (a "what's my 3pm?" query elided the 3pm line, kept
  49 irrelevant ones). Grounding: arXiv:2510.00615 (ACON — compression's dominant
  failure is losing the span the full context succeeded on), arXiv:2307.03172 (Lost in
  the Middle — head+tail bias is right only if the kept span contains the answer).
  hermes truncates by fixed char budget with no query awareness; openclaw recency/summary
  with no per-result anchor → Muse's deterministic query-anchored cap widens the edge.
- **Review point:** the anchor is a soft retention preference within the SAME budget;
  full output stays in ContextReferenceStore (re-fetchable). SECURITY: anchor operates
  on `neutralizeInjectionSpans`-defanged content (judge proved a buried injection
  co-occurring with a query term surfaces NEUTRALIZED).
- **Risk:** none to floor — window sliced VERBATIM from real output (no synthesis,
  fabrication=0), total provably ≤ maxChars (judge checked the budget arithmetic +
  hostile probes), no-op byte-identity preserved (461 non-anchor tests green under the
  mutation). Independent Opus *adaptive* judge PASS 7/7 (budget overflow, verbatim-only,
  no-op identity, neutralize-first, determinism, no-collateral, build). Sibling audit:
  all 4 capToolOutput callsites patched; capWorkerOutput (multi-agent) intentionally
  byte-identical no-op. lesson(carry-forward): a multi-call primitive change needs the
  sibling-audit of EVERY caller enumerated, not just the touched path.

---

## fire 5 · 2026-06-20 · skill v2.0.0 · f873af9c
meta: value-class=micro-fix · pkg=@muse/agent-core · kind=tool-relevance-recall · verdict=PASS (after 1 FAIL→fix cycle) · firesSinceDrill=5
ratchet: testFiles +0 (extended existing) · agent-core 2503 pass · pnpm check exit0 · pnpm lint exit0 · fabrication 0 · self-eval green
- **What:** Inflection-aware tool-relevance matching in `tool-filter.ts`
  `keywordMatchesPrompt`/`tokenMatchesKeywordWord`, mirroring `@muse/tools`'s rule so
  `capToolsByRelevance` ranking + `DefaultToolFilter.shouldKeep` AGREE with the
  selection layer. ASCII ≥4: `startsWith && suffix≤3` (lights→light); <4 exact; CJK:
  `word.length>=2 ? token.includes : false`. One function fixes 3 callsites.
- **Why:** the cap's scorer used strict word-boundary (`\blight\b`), so "turn off the
  lights" ranked `home_state` (kw `light`) at 0 → could be evicted from the ≤6 window →
  model never sees the tool → fabricates "done." A recall/fabrication-adjacent leak that
  makes fire-3's ceiling faithful. Grounding: tool-retrieval recall (ACL 2025 Findings
  2025.findings-acl.1258), stemming/inflection IR (SS4MCT arXiv:1605.07852),
  arXiv:2606.10209/2507.21428 (fire-3 lineage). hermes/openclaw advertise full catalog,
  no two-layer match-agreement invariant → widens the differentiator.
- **Review point:** the v2 ADAPTIVE judge caught a real defect the build was green on —
  the first builder replicated the ASCII branch but DROPPED @muse/tools' CJK
  `word.length>=2` guard, so the shipped Korean keyword "할 일" (single-char words)
  over-matched unrelated Korean prompts ("할머니가 일했다") by containment — the two
  layers DISagreed on Korean (the opposite of the goal, hitting Muse's KO-recall surface).
  Fixed (1-line guard + CJK over-match regression test); final fresh judge confirmed the
  layers now agree on both the unrelated (→0) and genuine (→tasks) KO prompts.
- **Risk:** none to floor — recall-only (retains a relevant tool, never fabricates/widens
  beyond maxTools), deterministic, @muse/tools untouched, no grounding/citation/approval
  change. Verified by 3 independent Opus judges (1st FAIL=CJK divergence, final PASS) +
  MUTATION-FIRST (both ASCII and CJK tests RED on the respective 1-line reverts).
- lesson: when MIRRORING a sibling matcher/parser, copy EVERY guard (the CJK
  `length>=2` was the easy-to-miss one) AND add coverage for the non-ASCII/locale path —
  a fixed checklist misses it; the adaptive judge is what caught it. A shared-import
  (export from @muse/tools, delete the agent-core copy) would remove the drift class
  structurally → backlog follow-up.
- lesson(process): a judge sub-agent that crashes mid-run (e.g. transient 401) can leave
  an un-restored test mutation in the worktree — after any judge crash, re-check the
  touched source state before trusting the next judge's verdict.

---

## fire 6 · 2026-06-20 · skill v2.0.0 · 8c0341d9
meta: value-class=wiring · pkg=@muse/recall · kind=query-relevance-wiring · verdict=PASS (after 1 FAIL→fix cycle) · firesSinceDrill=6
ratchet: testFiles +0 (extended existing) · recall 340 pass · cli 2763 pass · pnpm check exit0 · pnpm lint exit0 · fabrication 0 · self-eval green
- **What:** Activated fire-1's dormant `relevance?` path. `present.ts` accepted a per-block
  `relevance?` but `commands-ask.ts` never supplied one → every real ask fell back to the
  fixed tier (fire-1's reorder was relevance-blind in production). New pure helper
  `optionalGroundingRelevance(tierKey, perTurnScore?)` blends normalizedTier(0.2–1.0) with
  a clamped 0–1 per-turn score (W=0.5); commands-ask threads `episodeHits[].score` into the
  episodes block. The `edgePlaceByPriority` fallback ALSO routes through the helper so every
  block shares the 0–1 scale.
- **Why:** arXiv:2410.05983 (Long-Context LLMs Meet RAG — reorder retrieved passages by
  retriever relevance at the sequence boundaries; gain grows with #passages) + 2504.07104
  (Relevance Isn't All You Need — blend, don't pure-sort) + fire-1's 2307.03172/2508.05128.
  hermes/openclaw have no deterministic relevance-ordered cross-block grounding reorder
  (openclaw MMR for memory dedup only) → widens the differentiator.
- **Review point:** only the episodes block carries a real per-turn score today (contacts'
  & memories' scores are discarded upstream → honest tier fallback, no fabricated score);
  the mechanism is general (any block setting `relevance` benefits). Blend is bounded:
  a perfect episode climbs above low-tier blocks but not above top actionable surfaces
  (tasks/reminders) — intentional.
- **Risk:** none to floor — pure arithmetic feeding the existing permutation; set-equality +
  fabrication=0 preserved; no touch to citation gate/verifyGrounding/notesFraming/banner;
  score-less turns byte-identical to fire-1. 2 independent Opus adaptive judges (1st FAILed
  on a SCALE-MIX: episodes got 0–1 but siblings used raw tier 20–100 → episodes could never
  outrank → no-op-or-regression, masked by a test that scored ALL blocks; fixed by
  normalizing the fallback + a production-mix test; final judge PASS, episodes 0.675 → head).
- lesson: when a helper normalizes ONE input, the FALLBACK for the other inputs must use the
  SAME normalization — a partial-normalization scale-mix silently makes the feature inert.
  And the test must replicate the PRODUCTION mix (only the real producer's fields scored),
  not an idealized all-scored set, or it masks the mix bug.

## fire 7 · 2026-06-20 · skill v2.0.0 · 76967b5c
meta: value-class=refactor · pkg=@muse/tools+@muse/agent-core · kind=dedup-refactor · verdict=PASS · firesSinceDrill=7
ratchet: testFiles +0 (extended existing) · tools 272 pass · agent-core 2512 pass · pnpm check exit0 · pnpm lint exit0 · fabrication 0 · self-eval green
- **What:** Shared the lexical matcher. `tokenMatchesKeywordWord` was hand-mirrored in
  `@muse/tools` (SoT) and `@muse/agent-core/tool-filter.ts`. Now `export`ed from @muse/tools
  and IMPORTED by agent-core; the local copy + its now-unused `NON_ASCII_RE` deleted. Behavior
  byte-identical (only the function's home changed). No tsconfig/dep edit (edge already existed).
- **Why:** fire 5 FAILed precisely because the two copies had drifted (agent-core dropped the
  CJK `length>=2` guard). One definition can't diverge → the drift bug class is closed
  STRUCTURALLY, not by hand. arXiv:2502.04073 (code-duplication refactoring — consolidate to
  one authoritative location); tool selection rests on lexical match (2511.01854 / 2507.21428)
  so the matcher must have ONE definition shared by the selection + exposure-ceiling layers.
  hermes/openclaw have no such two-layer matcher to share → Muse-specific edge cleanup.
- **Review point:** `keywordMatchesPrompt` + `tokenizePromptCache` stay LOCAL to agent-core
  (cache wrapper, different signature from @muse/tools' `keywordMatchesPromptTokens`) — only
  the leaf primitive is shared this fire. `tokenMatchesKeywordWord` is now public @muse/tools
  surface.
- **Risk:** none to floor — behavior-preserving refactor, no touch to gates/recall/approval/
  schemas. Independent Opus adaptive judge PASS (6/6): @muse/tools diff is the single `export`
  keyword; the DRIFT-CLOSURE proof — mutating the @muse/tools SoT CJK line now turns the
  PRE-EXISTING fire-5 agent-core test RED (impossible with the copy), restored md5-identical.
- lesson(carry-forward): the durable fix for a hand-mirrored-logic FAIL (fire 5) is to DELETE
  the mirror (share one SoT), not re-align the copies — then the drift class is impossible,
  and a mutation to the SoT propagating to the consumer's test is the structural proof.
