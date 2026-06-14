# Domain 02 — Knowledge / RAG / Recall / Notes / Perception

Repo: /Users/jinan/side-project/Muse · Verified 2026-06-14 against `apps/cli/dist/index.js` (live `--help` + read-only runs), codegraph, and test suites.

Status legend: ✅ ran live · 🧪 covered by tests · ⬜ code-only (not exercised) · ⚠️ broken/suspicious

---

## A. The grounding / citation gate — Muse's core edge (THE thing to verify)

**Verdict: REAL, deterministic, fail-close, heavily tested.** ✅🧪

The gate is `verifyGrounding(answer, matches, query, options)` in
`packages/agent-core/src/knowledge-recall.ts:992`. It is pure deterministic code (no
model call) producing a 3-way verdict from a 4-criterion rubric:

- **rubric** = `{ confidence, coverage, answerability, citationValidity }`.
  - `confidence` from `classifyRetrievalConfidence` over absolute **cosine** (CRAG-style): confident=1 / ambiguous=0.5 / none=0. `DEFAULT_CONFIDENT_AT` threshold.
  - `coverage` = fraction of ANSWER content-tokens present in the union of evidence tokens (floor `DEFAULT_COVERAGE_FLOOR = 0.5`).
  - `answerability` = fraction of QUERY tokens covered by evidence (floor `DEFAULT_ANSWERABILITY_FLOOR = 0.34`).
  - `citationValidity` = cited sources that resolve to a retrieved match; any **invalid (fabricated) citation** → ungrounded.
- **Verdict ordering (fail-close, knowledge-recall.ts:1017-1029):**
  1. `retrieval === "none"` → **ungrounded** ("no evidence retrieved")
  2. invalid citations present → **ungrounded** ("answer cites a source that was not retrieved")
  3. coverage < floor → **ungrounded** ("answer makes claims the evidence does not support")
  4. confident AND answerability ≥ floor → **grounded**
  5. otherwise → **weak** ("evidence only weakly supports")

So a fabricated citation or an answer that drifts beyond evidence is dropped by code, and weak retrieval degrades to "I'm not sure" framing rather than a confident answer. This matches the CLAUDE.md "fabrication rate = 0" contract.

Supporting layers (all deterministic, all in agent-core / recall):
- `selectBestGroundedDraft` (knowledge-recall.ts:1044) — best-of-N: only a **grounded** survivor is accepted ("weak" never), so resampling raises answered-rate without admitting fabrication. Wired to `muse ask --best-of`.
- `verifyGroundingWithReverify` — optional model-backed reverify with k-sample self-consistency (unanimous PASS), used by `groundingVerdictNotice`.
- `reportSentenceGroundedness` / `worstUnsupportedSentence` (`sentence-groundedness.ts`) — per-sentence supported/unsupported diagnostic with **polarity**, **numeric**, and **hedge-overclaim** mismatch guards (token coverage alone would miss a negated contradiction).
- Chat path parity (`apps/cli/src/chat-grounding.ts` `gateChatAnswer`): `groundingVerdictNotice`, `chatCitationPrecisionNotice` (ALCE), `chatCitationRecallNotice`, `untrustedOnlyChatNotice` (grounded≠true source-trust: flags answers resting only on `trusted:false` MCP/web data), `semanticConflictCueFromMatches` (notes disagree), `answerAssertsUnsupportedEmail`/`answerAssertsUnsupportedIdentifier` (deterministic value-drift refusal for emails/IDs/IPs).
- `packages/recall/src/verdict.ts`: `groundingVerdictNotice`, `sufficiencyAdvisory` (multi-part query coverage), `drawBestGroundedRedraft`.

**Evidence:** ~36 `commands-ask-*.test.ts` files + `chat-grounding*.test.ts` + `grounding-eval-runner.test.ts`; CLI package = **2700 tests pass** (ran live). Recall package = **271 tests pass** (ran live). `GroundingEvalCase` kinds (`answerable`/`refuse`/`drift`) encode false-refusal vs missed-fabrication as first-class.

---

## B. CLI commands — verified via live `--help` + read-only runs

### RAG / grounded answer
- **`ask [query...]`** — RAG-grounded one-shot via local model; reads stdin. ✅ (help) — Rich flag surface verified: `--top`, `--embed-model` (default `nomic-embed-text-v2-moe`), `--no-auto-reindex`, and grounding-context toggles `--no-tasks/--no-calendar/--no-reminders/--no-contacts/--no-actions`, `--shell` (opt-in shell-history grounding, redacted). Edge flags: **`--why`** (which criterion fell short + measured value vs threshold), **`--verify-claims`** (Self-RAG per-claim ISSUP, fail-open), **`--best-of <n>`** (redraw + deterministic best-grounded pick). Vision: `--image`, `--extract <fields>` (grounded structured extraction — unreadable field omitted not invented), `--to-calendar`/`--auto`/`--apply` (draft-first). 🧪 (adaptive-k, crag, mmr, fusion, litm, sufficiency, injection-guard, refusal, receipts, sources-footer, verify-claims, best-of all have dedicated tests).

### Semantic / unified recall
- **`recall <query>`** — semantic search across notes + episodes indices. ✅ — `--limit`, `--source notes|episodes|all`, `--embed-model` (default here still `nomic-embed-text` — see drift), `--json`, **`--expand`** (1-hop [[wiki-link]] GraphRAG), **`--adaptive`** (optimal-foraging marginal-value stopping rule). ⬜ live run not done (needs an index) but help + recall pkg tests cover the orchestration.
- **`find <query...>`** — deterministic local substring across tasks/reminders/contacts/calendar (NOT notes/memory — those route to `notes search`/`recall`). ✅ ran (`muse find dentist` → clean "no match" message). `--json`.

### Notes (filesystem-backed) — `notes <subcommand>`  ✅ (help) 🧪
Full subcommand set verified: `providers`, `list`, `read`, `search`, `save`, `ingest` (local file OR `--url` web page w/ SSRF guard + readability), `append`, `delete`, `rename` (rewrites all [[wiki-links]]), `fix-links`, `reindex`, `conflicts` (find own-notes contradictions, local model), `semantic`, `links`, `graph`, `review`, `recent`, `folders`, `related` (embedding neighbours), **`trails`** (co-recall stigmergy graph), **`hubs`** (k-shell core decomposition), **`bridges`** (betweenness centrality / brokerage). Knowledge-graph surface is large and deterministic. (`commands-notes*.test.ts` present.)

### Frictionless capture
- **`note [text...]`** — append one-line thought to today's inbox note + auto-index; stdin pipe (`pbpaste | muse note`) or `--voice` (mic→STT). ✅ (help). `--embed-model` default `nomic-embed-text-v2-moe`.

### Document / perception read
- **`read <path>`** — read PDF or text (.txt/.md/.log/.csv); `--ask <q>` streams grounded answer, `--save-to-notes <id>` (dir → bulk ingest a whole folder), `--json`. ✅ ran on /tmp text file (printed content correctly).
- **`show <path>`** — render image inline in terminal (iTerm2/WezTerm/Ghostty; native-viewer fallback). ⬜ (help only).
- **`glance`** — read frontmost app + window title (+ selected text w/ Accessibility). macOS only. ⬜ (help only).

### Deterministic "nature mechanism" data tools (README's selling point) — ALL EXIST + RUN ✅
- **`summarize <file>`** — Luhn 1958 extractive, verbatim, no model. ✅ ran (2-sentence extract correct, labelled "verbatim — nothing reworded").
- **`keywords <file>`** — RAKE (Rose et al. 2010) keyphrases, no model. ✅ ran (5 phrases).
- **`csv <file>`** — exact aggregates (sum/avg/min/max/count + filter), no model. ✅ ran (`--sum amount` → 1815 over 5 values).
- **`benford <file> <column>`** — Benford's-Law + Pearson χ², no model. ✅ ran (digit table printed).
- **`trend <file> <column>`** — Mann-Kendall + Sen's slope, time-ordered, no model. ✅ ran (correctly warned "<8 points unreliable").
- **`diversity <file> <column>`** — Shannon/Simpson/Pielou evenness, no model. ✅ ran (H'=0.673, Gini-Simpson=0.480, J'=0.971).
- **`on-this-day`** — date-cued recall (notes dated YYYY-MM-DD), no model. ✅ ran (graceful empty-corpus message). `--window <days>`, `--json`.
- **`anomaly`** — most-unusual-days (robust local stats, draft-first). ⬜ (listed in top-level help).

### Ambient / world-state
- **`time [place...]`** — current time by city/IANA tz. ✅ ran (`muse time tokyo` → "Sun 21:43 in tokyo (Asia/Tokyo)"). `--json`.
- **`weather [location...]`** — Open-Meteo (no key); `--days <n>` (1-16 forecast), `--json`. ⬜ (help only — skipped network).
- **`feeds`** — RSS/Atom ingest for ambient world-state. ⬜ (subcommand group).
- **`search <query...>`** — web search via `muse.search` MCP (SearXNG primary, DuckDuckGo fallback). ⬜ (help only — skipped network).

### Bulk corpus in/out
- **`ingest <file>`** — bulk-ingest exported ChatGPT/Claude `conversations.json` or `.mbox` mail into the notes corpus. ⬜ (help only — avoided large data). Distinct from `notes ingest` (single file/url).
- **`import <bundle>`** / **`export`** — backup/restore `~/.muse/*` + notes tree as tar.gz, with optional **AES-256-GCM encryption** (`--encrypt`/`--decrypt`, passphrase via `$MUSE_EXPORT_PASSPHRASE`), `--dry-run`, `--force`. ✅ (help). (Encryption-at-rest is an active per-store rollout per memory.)

---

## C. MCP package (`packages/mcp`) — loopback servers + grounding-adjacent tools

The "notes/fetch/fs servers" are loopback MCP servers (`McpManager`-managed, local-only):
- **Notes server** (`loopback-notes.ts`) exposes **6** tools: `list`, `read`, `search`, `save`, `append`, `delete` (no `head`/`get`). Backends in `notes-providers-{local,apple,notion}.ts`.
- **Fetch / web-read** (`fetch-readable-url.ts`, `loopback-fetch.ts`, `loopback-web-read.ts`, `web-readable.ts`, `web-url-guard.ts`) — readability + SSRF guard for `notes ingest --url` and web grounding (untrusted → `trusted:false`).
- **Filesystem** (`loopback-filesystem.ts`, `file-read-tool.ts`), **search** (`loopback-search.ts`), **on-this-day** (`on-this-day-tool.ts` → `on_this_day_notes`), **feeds-search** (`feeds-search-tool.ts`).
- Unified `knowledge_search` corpus assembly lives in `packages/autoconfigure/src/knowledge-corpus.ts` (`assembleKnowledgeCorpus`) — fuses notes + tasks + calendar + contacts + email + reminders + followups + objectives + feeds + episodes + user-memory into one ranked corpus, each chunk source-tagged (`task/<id>`, `event/<id>`, etc.). Opt-in (re-embeds per question).
- Ranking options (`RankKnowledgeOptions`): `hybrid` (RRF cosine+lexical), `bm25` (IDF lexical), `diversify` (MMR, `mmrLambda` default 0.5), contextual `embedText` (Anthropic contextual retrieval — embed-only, raw `text` for evidence/gate). 🧪 (mmr/fusion/litm tests).

---

## D. Doc drift (README ↔ FEATURES.md ↔ SYSTEM-MAP.md ↔ reality)

1. ✅ PARTLY FIXED 2026-06-14 — the deterministic data/text tools (`csv`/`summarize`/`keywords`/`benford`/`trend`/`diversity`/`on-this-day`) now have a dedicated section in `docs/FEATURES.md` (### 결정론적 데이터 분석 도구). They are still NOT enumerated as commands in `docs/SYSTEM-MAP.md` — remaining gap there. (`muse weather`/`muse time` likewise only in SYSTEM-MAP prose.)

2. **CORRECTED (was overstated) — NOT a quality bug.** `recall` resolves an omitted `--embed-model` to `DEFAULT_EMBED_MODEL` = `nomic-embed-text-v2-moe` at runtime (`commands-recall.ts:381-383`) — identical to `ask`/`note`. Only the `.option(...)` help-description string (`:357`) is stale (`default 'nomic-embed-text'`), and recall warns on index-model mismatch (`:313-326`). So results are NOT silently degraded; this is a cosmetic help-text fix only.

3. **CORRECTED — no discrepancy.** `ask --help` DOES list `--with-tools` (plus `--actuators`, `--best-of`, `--why`, `--verify-claims`, `--shell`). The original capture missed it; there is no doc/help gap.

4. No false claims found in the grounding/citation prose: FEATURES.md L108/231 and SYSTEM-MAP §6 (L116-117 "확신 없으면 인용 안 함 / 잘 모르겠다") accurately describe the implemented gate.

---

## E. Nothing broken
No command errored on live invocation. The "error:" lines seen during the CLI test run are intentional negative-path assertions (unknown-command / missing-arg tests), not failures — suite reported 2700/2700 pass.
