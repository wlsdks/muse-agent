# capability-parity loop journal

Theme: bring Muse to hermes/openclaw-grade PEER on the 4 pure agent capabilities
they have and Muse is thin/missing on, deterministic-first, while keeping the
grounding/local moat as the floor. Source: code-level inventory of
/Users/jinan/ai/hermes-agent + /Users/jinan/ai/openclaw (studied as DATA only —
public IR mechanisms reimplemented on Muse's own primitives, never copied).
Tier1: LOCAL COMMIT ONLY, never push. Worktree /tmp/muse-capability-parity,
branch loop/capability-parity.

## fire 1 · 2026-06-23 · skill v2.0.0 · 97731bcb2
meta: value-class=new-capability · pkg=@muse/recall · kind=lexical-search-core · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1110→1118 (+8 history-search) · fabrication 0 (no grounding surface touched) · pnpm check green (was RED on a pre-existing byte-hygiene baseline regression, fixed this fire)

- 무엇: `searchHistory(query, records, opts)` in @muse/recall — a deterministic,
  Ollama-free history-search core (Gap1-S1, the biggest gap: both competitors
  have an agent-callable "find where we talked about X"; Muse's episodic recall
  was internal-only). BM25 over CJK-aware content tokens (Muse's own
  `bm25Scores`/`lexicalTokens` from @muse/agent-core — hermes FTS5 / openclaw
  BM25 studied as DATA, Cormack RRF SIGIR 2009), snippet centered on the match,
  precision floor (no token overlap → zero hits), recency tiebreak, topK cap.
  8 vitest cases. The tool wrapper (S2) + hybrid cosine fusion (S3) are later.
- 왜: Gap1 is the largest pure-agent-capability gap vs hermes/openclaw and the
  cleanest high-value slice — a fresh pure module, no shared-loop blast radius,
  fully provable deterministically (OUTCOME = the search returns the right
  ranked hits / empty on no-overlap / Korean query matches Korean records),
  reusing proven CJK-safe primitives instead of reinventing FTS.
- 리뷰지점: searchHistory is a RETRIEVAL helper — it ranks lexical matches and
  asserts nothing is true, so the fabrication=0 / grounding floor is untouched
  (a hit's snippet is a quote of stored text, not a claim). When S2 exposes this
  as an agent tool, the grounding gate still adjudicates any answer built on it.
- 리스크: lexical-only this fire (no embeddings) → a paraphrase with no shared
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

- 무엇: `createHistorySearchTool` in @muse/recall — wraps fire-1's deterministic
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
- 왜: highest-value continuation of the largest gap (Gap1) into something the
  AGENT actually uses, and diversity-correct (fire 1 = lexical-search-core in
  @muse/recall; fire 2 = tool-exposure + cross-package wiring). The runner-up
  Gap3-S1 was found STALE — episodic-recall.ts already calls
  approximateActivationBoost when recallStats is present; there is no
  useActrRanking flag, so it would have been a declaration-only no-op (the exact
  trap the ④b judge guards against).
- 리뷰지점: history_search is a RETRIEVAL tool — a hit is a quote of stored
  episode text labelled [source:ref], and a zero-token-overlap query returns an
  explicit "Nothing was found — do not invent a past discussion" rather than a
  fabricated memory. So the fabrication=0 / grounding floor is untouched; the
  grounding gate still adjudicates any answer the agent builds on a hit. OUTCOME
  was proven (not declaration): the wiring test goes through createMuseRuntimeAssembly,
  asserts the tool is in toolRegistry.list() AND executes it to return the right
  labelled hit / excludes the non-match; the eval proves the local 12B SELECTS it.
- 리스크: production records feed only `episodes` this fire (not notes/memory) —
  matches Gap1-S2's episodic scope; the hybrid cosine-fusion + broader sources
  are the explicit S3 follow-up, not a defect. New internal deps (recall→tools,
  autoconfigure→recall) are acyclic and verified by pnpm check exit 0.

note: sibling-audit found a pre-existing eval-tool-selection.mjs bug —
buildWebSearchScenario + buildUnitConvertScenario import the web/url servers as
`mcp.createSearchMcpServer` / `mcp.createWebReadMcpServer`, which live in
@muse/domain-tools and are NOT re-exported by @muse/mcp → both undefined → both
scenarios silently SKIP. Fire 2's new scenario imports correctly from
domain-tools; the two older ones are logged as a backlog ◦ to patch.
