# capability-parity loop journal

Theme: bring Muse to hermes/openclaw-grade PEER on the 4 pure agent capabilities
they have and Muse is thin/missing on, deterministic-first, while keeping the
grounding/local moat as the floor. Source: code-level inventory of
$HOME/ai/hermes-agent + $HOME/ai/openclaw (studied as DATA only —
public IR mechanisms reimplemented on Muse's own primitives, never copied).
Tier1: LOCAL COMMIT ONLY, never push. Worktree /tmp/muse-capability-parity,
branch loop/capability-parity.

## fire 1 · 2026-06-23 · skill v2.0.0 · 97731bcb2
meta: value-class=new-capability · pkg=@muse/recall · kind=lexical-search-core · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1110→1118 (+8 history-search) · fabrication 0 (no grounding surface touched) · pnpm check green (was RED on a pre-existing byte-hygiene baseline regression, fixed this fire)

- What: `searchHistory(query, records, opts)` in @muse/recall — a deterministic,
  Ollama-free history-search core (Gap1-S1, the biggest gap: both competitors
  have an agent-callable "find where we talked about X"; Muse's episodic recall
  was internal-only). BM25 over CJK-aware content tokens (Muse's own
  `bm25Scores`/`lexicalTokens` from @muse/agent-core — hermes FTS5 / openclaw
  BM25 studied as DATA, Cormack RRF SIGIR 2009), snippet centered on the match,
  precision floor (no token overlap → zero hits), recency tiebreak, topK cap.
  8 vitest cases. The tool wrapper (S2) + hybrid cosine fusion (S3) are later.
- Why: Gap1 is the largest pure-agent-capability gap vs hermes/openclaw and the
  cleanest high-value slice — a fresh pure module, no shared-loop blast radius,
  fully provable deterministically (OUTCOME = the search returns the right
  ranked hits / empty on no-overlap / Korean query matches Korean records),
  reusing proven CJK-safe primitives instead of reinventing FTS.
- Review point: searchHistory is a RETRIEVAL helper — it ranks lexical matches and
  asserts nothing is true, so the fabrication=0 / grounding floor is untouched
  (a hit's snippet is a quote of stored text, not a claim). When S2 exposes this
  as an agent tool, the grounding gate still adjudicates any answer built on it.
- Risk: lexical-only this fire (no embeddings) → a paraphrase with no shared
  content term won't match; that is the intended S3 hybrid-fusion follow-up, not
  a defect. The pre-existing byte-fix (NUL→\x00) is runtime-identical and the
  knowledge-recall-ranking suite (24/24) proves no behavior change.

note: the shared backlog's "★ capability-parity" section existed only as
UNCOMMITTED working-tree edits in the main repo (gap-scout never committed it);
my worktree branched from the committed HEAD legitimately lacked it. Per
concurrent-loop hygiene I did not entangle with that uncommitted work — the
write-back ✓ line went to the top of my worktree's backlog (append-only, low
conflict risk) and the full detail lives here.

## fire 2 · 2026-06-23 · skill v2.0.0 · 3d94f370d
meta: value-class=new-capability · pkg=@muse/recall (+@muse/autoconfigure wiring) · kind=tool-exposure · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 1111→1113 (+2: history-search-tool unit + history-search wiring) · toolCases 342→349 (+7 eval:tools golden) · fabrication 0 (retrieval tool quotes stored text, no-overlap → explicit no-match) · pnpm check exit 0 · lint exit 0 · eval:tools history-search 7/7 STABLE 3/3 live (gemma4:12b)

- What: `createHistorySearchTool` in @muse/recall — wraps fire-1's deterministic
  `searchHistory` core as the agent-callable `history_search` tool (verb_noun,
  read-risk, required `query` + optional `topK` with KO+EN example-bearing
  descriptions, a "use when / do NOT use" line disambiguating it from
  knowledge_search and the recent-activity feed). Wired into the production
  runtime tool registry (buildRuntimeToolRegistry), default-ON
  (MUSE_HISTORY_SEARCH_ENABLED) because it is pure/CJK-lexical — no Ollama cost
  unlike the embedding knowledge_search — feeding the user's episodes via
  readEpisodes, fail-soft to a no-match notice. The competitor-parity move: both
  hermes (session_search_tool FTS5) and openclaw (memory-search) have an
  agent-callable "find where we talked about X"; Muse's episodic recall was
  internal-only until now.
- Why: highest-value continuation of the largest gap (Gap1) into something the
  AGENT actually uses, and diversity-correct (fire 1 = lexical-search-core in
  @muse/recall; fire 2 = tool-exposure + cross-package wiring). The runner-up
  Gap3-S1 was found STALE — episodic-recall.ts already calls
  approximateActivationBoost when recallStats is present; there is no
  useActrRanking flag, so it would have been a declaration-only no-op (the exact
  trap the ④b judge guards against).
- Review point: history_search is a RETRIEVAL tool — a hit is a quote of stored
  episode text labelled [source:ref], and a zero-token-overlap query returns an
  explicit "Nothing was found — do not invent a past discussion" rather than a
  fabricated memory. So the fabrication=0 / grounding floor is untouched; the
  grounding gate still adjudicates any answer the agent builds on a hit. OUTCOME
  was proven (not declaration): the wiring test goes through createMuseRuntimeAssembly,
  asserts the tool is in toolRegistry.list() AND executes it to return the right
  labelled hit / excludes the non-match; the eval proves the local 12B SELECTS it.
- Risk: production records feed only `episodes` this fire (not notes/memory) —
  matches Gap1-S2's episodic scope; the hybrid cosine-fusion + broader sources
  are the explicit S3 follow-up, not a defect. New internal deps (recall→tools,
  autoconfigure→recall) are acyclic and verified by pnpm check exit 0.

note: sibling-audit found a pre-existing eval-tool-selection.mjs bug —
buildWebSearchScenario + buildUnitConvertScenario import the web/url servers as
`mcp.createSearchMcpServer` / `mcp.createWebReadMcpServer`, which live in
@muse/domain-tools and are NOT re-exported by @muse/mcp → both undefined → both
scenarios silently SKIP. Fire 2's new scenario imports correctly from
domain-tools; the two older ones are logged as a backlog ◦ to patch.

## fire 3 · 2026-06-23 · skill v2.0.0 · 189040717
meta: value-class=capability-durability · pkg=@muse/multi-agent · kind=store · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 1113→1114 · fabrication 0 · eval:orchestration PASS (no regression)

- What: Gap4-S1 — `SubAgentRunRegistry` (@muse/multi-agent), a deterministic
  in-memory store tracking the LIVE lifecycle of spawned sub-agent runs: run id,
  parent→child linkage, status (running/completed/failed/timed-out), per-run
  timeoutMs, heartbeat liveness, and stall detection (detectStalled pure read +
  markStalledAsTimedOut observable transition). 21 OUTCOME-state vitest.
- Why: openclaw `subagent-registry.ts` has a persistent run registry with
  orphan/stall recovery; Muse's lead-worker/council was in-memory with NO run
  registry, so a stalled or orphaned child run was invisible. Muse's existing
  OrchestrationHistory only records FINISHED runs for audit (mandatory
  finishedAt, no running/timed-out status, no parent-child, no heartbeat) — it
  cannot detect a live stall. This registry is the missing live-lifecycle layer
  Gap4-S2 (orphan recovery policy) builds on. Diversity: fires 1+2 were BOTH
  @muse/recall; this moves to a NEW (pkg=@muse/multi-agent, kind=store).
- Review point: pure deterministic store — no model call, no network, no fabricated
  content, injected clock for all time reads; fabrication=0 / grounding floor
  untouched. OUTCOME-graded not declaration: tests assert real state transitions,
  stall-detection results at the exact boundary, frozen-record immutability, and
  orphan-by-construction rejection (unknown parent throws). MUTATION-FIRST: stall
  `>`→`>=` boundary and heartbeat-revives-terminal both confirmed RED then GREEN.
  Clean reimplementation (9 plain fields vs openclaw's ~40-field framework
  record); openclaw already attributed in THIRD_PARTY_NOTICES.md.
- Risk: the registry is built + exported but not yet WIRED into the live
  orchestrator (MultiAgentOrchestrator still uses in-memory state) — this fire
  ships the durable store + its policy primitives (detectStalled/recovery hook);
  wiring it into the orchestrator run loop and the orphan-recovery policy are the
  explicit Gap4-S2/S4 follow-ups, not a defect. No new internal deps (the store
  is dependency-free); index.ts edit is additive re-exports only.

## fire 5 · 2026-06-23 · skill v2.0.0 · 3ac6c4a57
meta: value-class=wiring · pkg=@muse/multi-agent · kind=wiring · verdict=PASS · firesSinceDrill=5
ratchet: testFiles +2 (orchestrate-run-registry.test.ts @muse/multi-agent, server.multi-agent-runs.test.ts @muse/api) · fabrication 0 · eval:orchestration PASS pass^3 (gemma4)
- What: Wired SubAgentRunRegistry (built in fire 3 but left inert) into the live MultiAgentOrchestrator — a real run now registers the parent + each child worker run and transitions running→completed/failed/timed-out; a worker that exceeds its deadline gets a detectable timed-out record (new markTimedOut). Also wired into both apps/api orchestrate routes (JSON+SSE share prepareOrchestration) + a new live GET /api/multi-agent/runs surface.
- Why: a built-but-unwired store is exactly the "looks done but isn't live" trap this loop exists to close. Closes the inert-store risk fire 3 explicitly flagged. Side-effect only (orchestration result unchanged, a no-registry run stays backward-compatible).
- Review point: the grounding/citation path is untouched (fabrication=0 holds). OUTCOME-graded — the tests verify registry result STATE (parent/child status, parent→child relationship, activeCount, timed-out detection), not whether it was called. MUTATION-FIRST ×2 confirmed RED (my mutation: remove child complete; ④b's independent mutation: remove parent complete → both RED→GREEN). Independent Opus ④b PASS (all 7 check items backed by concrete evidence). pnpm check exit 0 (api 960 + cli 2996 pass), lint clean.
- Risk: the deadline→timed-out mapping depends on an error-message regex (`/exceeded the .* deadline/u`) — coupled to withDeadline's message format. ④b confirmed no misclassification, but changing that message string would silently break the mapping (a future sentinel error type would be more robust). A duplicate worker id within one run shares the child record (not a throw, benign).

## fire 6 · 2026-06-23 · skill v2.0.0 · fb59bd602
meta: value-class=capability · pkg=@muse/recall · kind=core-algorithm · verdict=PASS · firesSinceDrill=6
ratchet: testFiles +0 (9 tests added to existing history-search.test.ts) · fabrication 0 · deterministic gate (pnpm check exit 0; Gap1 slice = no new agent tool, so eval:tools N/A)
- What: `searchHistoryHybrid` in @muse/recall — a hybrid alongside fire 1's pure-lexical `searchHistory`. When a queryVector + record embeddings are present, fuses the BM25 lexical rank and the cosine semantic rank via fuseByReciprocalRank (Cormack, SIGIR 2009) → surfaces past records the user phrased differently from the query (paraphrases) too. Without an embedding, falls back byte-identical to lexical.
- Why: the last gap in Gap1 against openclaw's hybrid BM25+vector recall. Lexical-only misses synonyms/paraphrases; RRF fusion closes that while keeping the determinism/grounding floor intact.
- Review point: OUTCOME-graded — the headline test verifies the hybrid surfaces a record that scores 0 hits under lexical alone (not a declaration). MUTATION-FIRST: breaking `fuseByReciprocalRank([lex, cos])`→`[lex]` in one line confirmed RED on 3 (src+dist=6) → restore GREEN (470/470). Independent Opus ④b reproduced the mutation directly + all 6 checks PASS. Grounding floor: if lexical score is 0 AND cosine < minCosine, the record enters neither rank list, so it's absent from fused (fabrication 0). Pivot justification: Gap2 (skill curator) was already fully built+wired (recordUsage/curate/consolidate + live callers), Gap3-S1 stale, Gap3-S2 a fragile live-eval gate — ④b confirmed this as an honest pivot.
- Risk: the core function is shipped+exported but not yet wired into the agent-callable `history_search` tool (fire 2) — that surface is deliberately embedder-free (no Ollama cost). Turning the hybrid on for the tool needs an optional embedder injection (S3b follow-up). This fire is pure core+tests only (diversity: recall's 3rd fire, but the alternatives were disqualified by the pre-check).

## fire 7 · 2026-06-23 · skill v2.0.0 · 2a3dd61b0
meta: value-class=safety · pkg=@muse/multi-agent · kind=schema-validation · verdict=PASS · firesSinceDrill=7
ratchet: testFiles +0 (7 cases added to existing handoff-validation.test.ts) · fabrication 0 · eval:orchestration STABLE 3/3 (gemma4) · consecutivePASS≈6 (fires 1,2,3,5,6,7) — approaching the JUDGE-DRILL threshold (8 consecutive OR firesSinceDrill≥10) — if the next fire is the 8th consecutive PASS, DRILL is forced
- What: `parseHandoffPart` — a typed-schema validator (a zod-comparable deterministic parser, no new dep) for the worker→synthesizer fan-in seam. Filters buildOrchestrationResponse's completedParts through this gate, fail-close dropping a poisoned worker part that collapsed to a placeholder after neutralization (content-free yet non-blank) → synthesizer/detectConflicts/detectRedundancies can no longer consume an empty shell as a real answer. Exported INJECTION_SPAN_PLACEHOLDER from agent-core (a shared contract).
- Why: the last genuinely-open slice of Gap4, following fire 5 (worker-boundary wiring) and fire 3 (run registry). Previously only non-empty was validated — fan-in builds parts from NEUTRALIZED, not RAW, output, so a worker that is entirely an injection span passes the worker boundary and collapses to a placeholder at fan-in, flowing into synthesis (MAST FM information-withholding cascading at the second boundary). zod is named in the rule but the whole repo doesn't use zod → matched the pattern with an "or comparable" deterministic parser.
- Review point: OUTCOME-graded — 2 headline tests drive a real MultiAgentOrchestrator end-to-end to verify (1) the synthesizer receives only substantive workers (a dropped worker still reports as a completed step + in raw.workers), (2) synthesis is skipped when everything is content-free. MUTATION-FIRST: breaking the filter to `=> true` (no-op) in one line confirmed RED on both OUTCOME tests → restore GREEN (284/284). Independent Opus ④b reproduced the mutation directly + all 7 checks (behavioral·mutation·invariant·unrelated-state·dep-cycle·no-copy·gates) PASS. Over-rejection avoidance confirmed: a placeholder alongside substantive content is ACCEPTed (rejected ONLY when SOLELY a placeholder) → no real answer is lost (fabrication/grounding floor unchanged).
- Risk: placeholder-rejection is coupled to exact string equality (after trim) — if agent-core changes the INJECTION_SPAN_PLACEHOLDER string, that specific reject branch silently goes inert (the structural rejects are unaffected; now that it's a shared export, the coupling is explicit). The gate affects only the FUSION input — the audit trail (per-worker concat·status·history·registry) is entirely unchanged, so the blast radius is narrow. Diversity: @muse/multi-agent's 3rd fire, but kind=schema-validation is new (previous fires: store·wiring).

## fire 8 · 2026-06-23 · skill v2.0.0 · 0f154e109
meta: value-class=durability · pkg=@muse/multi-agent · kind=policy · verdict=PASS · firesSinceDrill=8
ratchet: testFiles +0 (5 cases added to existing subagent-run-registry.test.ts) · fabrication 0 · eval:orchestration PASS (in-process deterministic, run under MUSE_EVAL_REPEAT=3) · consecutivePASS=7 (fires 1,2,3,5,6,7,8) — fire 4 crashed, NOT counted as PASS so it does NOT extend the streak; firesSinceDrill 7→8, below the DRILL threshold (8 consecutive PASS OR firesSinceDrill≥10) → NORMAL slice this fire, DRILL forced NEXT fire if it would be the 8th consecutive PASS
- What: Added 2 deterministic orphan-recovery policies to SubAgentRunRegistry. Orphan = the parent is terminal (completed/failed/timed-out) but the child is still running — the parent will never consume that result. `detectOrphaned()` flags this (including a child registered under an already-terminal parent), ignoring the root run and already-terminal children. `recoverOrphaned(error?)` transitions an orphan to `failed` (recording finishedAt/error), semantically distinct from heartbeat-stall's `timed-out`, leaving unrelated running states unchanged.
- Why: reimplements openclaw subagent-registry's orphan-recovery mechanism (MIT, code not copied). Gap4 S2b, following fire 3 (registry), fire 5 (live wiring), fire 7 (fan-in schema) — heartbeat-stall (detectStalled) already existed, but the parent-terminated-orphan class was uncovered. Diversity: @muse/multi-agent's 4th fire, but kind=policy is new (previous: store·wiring·schema-validation, each different).
- Review point: OUTCOME-graded — 5 tests verify live data-structure STATE transitions (register→parent terminate→detect/recover→status=failed·finishedAt·error·decreased activeCount·unrelated run unchanged), not a declaration. MUTATION-FIRST: removing `&& TERMINAL_STATUSES.has(parent.status)` confirmed RED on 2 tests → restore GREEN (289/289). Independent Opus ④b reproduced that mutation directly + all 7 checks PASS with concrete evidence. Orchestrator wiring was deliberately NOT added — the parent-failure catch is unreachable for an orphan (runSequential/runParallel swallow worker errors, so children are always terminal before the parent settles), so it would be an inert no-op; ④b independently confirmed the revert was correct by tracing the code (orchestrator.ts ~230/365-430). The policy ships as a tested defensive primitive for a future scheduled sweep.
- Risk: the orphan→`failed` mapping is a semantic choice (parent-abandonment ≠ stall) — a future dedicated `orphaned` status would need an enum extension. The policy is currently not auto-invoked on any live path (needs an external supervisor / Gap3-S3's scheduled arm to call it) — an intentional separation, but note the "built-but-uncalled" label (tests prove behavior, the live trigger is a follow-up). vein-status: capability-parity is effectively dry — Gap1/2/4 complete, Gap3 leaves only stale (S1)·fragile-live-eval (S2)·large-blast-radius scheduling (S3).

## fire 9 · 2026-06-23 · skill v2.0.0 · e49e9e99c
meta: value-class=honesty-fix · pkg=@muse/recall(+autoconfigure) · kind=honesty-fix/wiring · verdict=PASS · firesSinceDrill=9 · consecutivePASS=8 (fires 1,2,3,5,6,7,8,9) — ★8 consecutive PASS reached → the next fire (10) forces JUDGE-DRILL (8-consecutive threshold met; firesSinceDrill also approaching 9→10)
ratchet: testFiles +1 (history-records-provider.test.ts @muse/autoconfigure) · fabrication 0 · eval:tools 124/124 100% PASSED (gemma4, all 7 history_search cases PASS) · pnpm check exit 0 · lint clean
- What: Fixed independent adversarial-audit finding A1 (MAJOR honesty/floor). The `history_search` tool advertised "episodes·notes·remembered facts" search, but the live records provider read only episodes, telling the user "notes/facts not found" without ever searching them (claimed-but-unsearched = a fabrication=0 violation). FIX: `buildHistoryRecords` (a new autoconfigure module) — merges episodes + notes (list+read body) + user-memory facts/preferences, each under its correct source label, per-source fail-soft. Wired into runtime-tool-registry.ts's history_search records provider.
- Why: chose the recommended (fuller-wiring) path — clean readers already exist (notesRegistry.primary()·userMemoryStore are already registry deps; knowledge_search proves the same reader-use pattern) and it fits in 1 fire. Delivers the advertised capability for real, instead of narrowing (fallback). The tool description/doc/NO_MATCH already advertised the 3 sources accurately → reality now matches (sibling-audit: all three consistent, no fix needed).
- Review point: OUTCOME-graded — 6 tests drive createHistorySearchTool e2e to verify a real NOTE returns labelled [notes:note-1], a real FACT returns labelled [memory:fact:allergy] (not a pure-function check), + per-source fail-soft (throwing notes → episodes+memory still returned) + notes/memory unconfigured → episodes-only preserved. MUTATION-FIRST: breaking resolveNoteRecords to `[]` in one line confirmed RED on 2 tests → restore GREEN. Independent Opus ④b reproduced the mutation directly + all 6 checks (advertised==searched·really-returned·mutation-RED·fabrication=0·unrelated-untouched·builds) PASS with concrete evidence.
- Risk: reading note bodies via list()+read() per note means indexing cost scales with note count (maxNoteChars=4000 truncates the body; deterministic·local like episodic embedding, no Ollama). A large note corpus carries a per-query read cost — accepted for now given the deterministic-lexical-floor priority, a follow-up caching/hybrid (A2) is the optimization opportunity. The source label is derived from the record's real source (not hardcoded), so mislabeling is impossible.
