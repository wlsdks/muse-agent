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

**Cadence:** session cron `caf5b755`, 20 min. **Stop:** `CronDelete caf5b755` or cmux.

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
- ◦ **Thread per-turn query relevance into the cross-block edge-place** (fire-1
  deferred): wire episode `.score` / contact match score into
  `OptionalGroundingSource.relevance` at `commands-ask.ts` so the reorder uses
  query-specific relevance, not just the fixed tier. Needs a shared 0–1 scale so
  relevance and tier don't scale-mix. (new-capability / @muse/cli+recall)
- ◦ **Grounding-quality eval under the new block order**: assert the edge-placed
  prompt order does not regress answer grounding (the judge flagged no eval
  measured this). Likely `eval:chat-grounding` / `precheck:grounding` case.
- ◦ **Importance-aware intra-cap** (fire-2 rejected #3): `capToolOutput` head+tail
  truncates regardless of which span matters; use the importance signal to keep the
  load-bearing span. Higher fabrication-floor risk — needs a relevance signal the
  tool layer lacks; design carefully. (@muse/memory)
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
