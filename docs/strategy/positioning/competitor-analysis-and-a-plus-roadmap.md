# Muse vs openclaw · hermes — full analysis, assessment, and A+ roadmap derivation

> **Written by**: Fable 5 (owns analysis & planning). **Executed by**: Sonnet workers (per-slice).
> **CLOSED 2026-07-30 — not canonical, and no longer the place for new findings.**
> Written 2026-07-11 by absorbing the earlier scattered planning documents, and its
> §10.3 program is 61/67 done. New rival findings go to
> [`../../../internal/goals/rival-watch.md`](../../../internal/goals/rival-watch.md)
> (the successor `differentiation.md` names); the AttuneGraph landscape has its own dated
> snapshot. Kept ONLY for the residual open items in §10.3 and the §11 queue — the
> rival snapshot below is frozen at clone HEADs from 2026-07-07 and its Muse-side
> claims have been overtaken by its own executed roadmap. Do not ground on it for
> current state.
>
> **Methodology**: (1) 3 agents profiling in parallel (Muse · openclaw · hermes, each
> run independently), (2) an **18-Haiku fine-grained sweep** (round 1: 7 mechanisms +
> round 2: 11 deep passes — full capability inventory, UX, voice/vision, browser,
> prompts, session/i18n, web reputation, rivals' own documentation), (3) **all 12 of
> Fable's source spot-checks confirmed matching**, (4) web-reputation research. Rival
> clone HEADs as of 2026-07-07 (hermes `aaeba213d`, openclaw `2fe39692ad0`).

---

## 0. Licensing — reference use is legal (confirmed)

Directly confirmed both rivals' actual `LICENSE` files:

- **hermes-agent**: MIT License, Copyright (c) 2025 Nous Research (`pyproject.toml` `license = "MIT"`)
- **openclaw**: MIT License, Copyright (c) 2026 OpenClaw Foundation (`package.json` `"license": "MIT"`)

MIT permits **even outright copying of code** (as long as the copyright and license
notice are kept). Muse's policy is more conservative than that — **reference only
the ideas, mechanisms, and the reasoning behind constants, then rewrite the
implementation in Muse's own design and naming.** Since nothing is copied verbatim,
not even MIT's notice obligation is triggered. This is the practice 40+ backlog
slices have already followed ("reference-only, MIT/Apache-attributed, NO verbatim
copy"), and it applies identically to every slice in this roadmap. **Jinan's
"reference it, don't copy it" matches this policy exactly, and it is legally
safe.**

---

## 1. One-line conclusion

**As "general-purpose agent infrastructure" Muse sits below both rivals (overall
B+), but on three axes Muse chose for itself — deterministic grounding, verified
self-learning, and live-model verification discipline — it clearly leads both, and
those three axes are unclaimed ground: neither rival shows any trace of investment
there, whether in code, community praise, or their own documentation.** In the
catch-up game Muse is losing; in its own game it is already winning. This roadmap
raises the B-grade dimensions (agent loop · security · orchestration · tools ·
model posture) to A+ **without ever sacrificing the three edges.**

---

## 2. Scorecard across the 3 agent profiles

| Dimension | Muse | openclaw | hermes | Evidence highlights |
|---|:---:|:---:|:---:|---|
| Agent loop | B+ | **A** | **A** | All three have compaction, retry, checkpoints, abort. openclaw has an 820-line tool-loop detector + a dedicated compaction-planner worker; hermes has a 3k-LOC compressor. Muse has every mechanism but a smaller budget (maxToolCalls 10 vs hermes' 90/sub-50) |
| Memory & self-learning | **A-** | B+ | **A** | hermes: Curator + skill self-authoring actually wired and on-by-default (with pruning). Muse: Whetstone BKT · playbook RL · correction-decay — **the only one that honestly "forgets when corrected"**, but starved of fuel (real usage). openclaw: dreaming is a deeply implemented 3-stage pipeline, but **off by default** |
| Tools & ecosystem | B | **A+** | A | openclaw: 149 extensions · 25+ channels · 52 providers. hermes: 103 tools · 20 channels · bidirectional MCP. Muse: ~96 tools + MCP client + browser + deep macOS coverage — **deliberately un-expanded** for single-user scope (10/13 channels judged skip) |
| Orchestration | B | **A** | A- | openclaw: SQLite task-flow · subagent registry · crond. hermes: a 3.4k-LOC delegate · async delegation · heartbeats. Muse: Kanban board + parallel decomposition + synthesis — complete for a personal-scope tool, but "parallel" is an illusion on a single GPU |
| **Grounding & honesty** | **A+** | D | D+ | **An incomparable gap.** Muse has 35 surfaces with deterministic gates · a fabrication=0 release gate · GROUNDED≠TRUE mitigations. openclaw has only prompt warnings (its own profiler: "the least instrumented dimension"). hermes' entire citation check is one X-search path |
| Security | B+ | A- | **A** | hermes: tirith external verifier binary + hardline + a constant security drumbeat. openclaw: a 90-file audit engine + CodeQL + an opt-in Docker sandbox. Muse's fail-close draft-first, injection battery, and egress gate all honor the principle, but **the runner only does env_clear + timeout + output capping — no OS sandbox** |
| **Verification discipline** | **A** | A- | B+ | (Round 2 correction) Muse is the only one with a **live fabrication=0 tripwire gating every push** (pre-push hook `precheck:grounding`, Ollama-dependent, skips if unreachable) plus the best-in-class infrastructure (pass^k · LLM-judge + meta-eval · MAST seam · 41 evals). **Honest limitation**: the aggregate `eval:agent` is NOT wired into GitHub CI (no local Ollama on cloud runners), and ci.yml is only lint+build+test → automatic enforcement covers only the grounding subset. openclaw's QA-Lab character-eval (LLM-judge) is **advisory and overridable** (not a gate). hermes' 33.5k tests are **all mocked, zero agent evals**. Muse's edge (the only live gate + best-in-class infra) still holds, but the grade drops A+→A (aggregate not enforced) |
| Model posture | B+ | A | A | Both have mature multi-model routers. Muse defaults to local gemma4:12b + BYO cloud + **privacy-tiered routing (neither rival has this axis at all)** |

**Overall**: Muse ≈ **B+** (general-purpose), chosen edges **A+**. openclaw ≈
standard-setting multi-channel gateway (breadth A+, honesty D). hermes ≈ the
individual agent with the tightest closed loop on security and self-improvement
(security A, no live verification).

### The scale truth (fairness)

- Commits in the last 3 weeks: openclaw **6,160** (top contributor alone 2,585 +
  bots 576), hermes **3,041** (~130/day). Both are **products** backed by a team +
  automation; Muse is a one-person project. Matching absolute volume isn't a
  meaningful goal here.
- And yet, more than **half of both projects' recent commits are `fix`**
  (openclaw 54%, hermes 52%) — revealing that **breadth eats itself in maintenance
  cost** (openclaw's UTF-16 truncation bug recurred across 12 modules). Muse's
  "depth-first, skip channels" call turned out to be right in hindsight.

---

## 3. Full inventory of rival capabilities — what exists, what gets praised

The capability map the 18-sweep dug up. **For reference only** (confirming
unclaimed ground + drawing out ideas); what got adopted is in §6.

### 3.1 hermes-agent (Python, ~103 tools, 1,936 test files)

- **Self-improvement loop (crown jewel)**: skill self-authoring (create/edit/patch/
  delete + AST audit + provenance) + **Curator** (7-day-cycle fork, deterministic
  stale→archive pruning + opt-in LLM consolidation, tar.gz snapshot/rollback). #1
  web praise: "40% faster once 20+ skills stack up," "remembers details from weeks
  ago like magic."
- **Memory**: 8 backends (2 first-party: Holographic HRR · Hindsight KG; 6 API
  wrappers). Drift detection (round-trip hashing), per-turn consolidation budget,
  frozen-snapshot + live-state, provenance ContextVar (distinguishes foreground vs.
  autonomous writes). **Limitation (web criticism)**: memory entries capped at
  2,200 chars, user entries at 1,375 → ~20 entries. Especially damaging for Korean.
- **Orchestration**: a 3.4k-LOC delegate (leaf/orchestrator roles · concurrency cap
  of 3 · capacity-exceeded rejection · heartbeat staleness at idle450s/in-tool1200s),
  async completion goes **only through a queue → drained only in an idle
  window** (no mid-LLM insertion), parent-headroom summary budget (×0.5/n, floor
  2000 chars, overflow spilled to a file).
- **Reliability**: iteration budget (parent 90/sub 50, PTC refunded), jittered
  backoff (5s→120s, decorrelated), stream staleness at 180s · reasoning floor
  600s, a 20-category error taxonomy, one-shot turn-retry state (prevents applying
  the same remedy twice), message-sequence recovery.
- **Security (crown jewel)**: an external tirith binary (SHA-256 + cosign, scans
  for homograph / pipe-to-interpreter / terminal-injection) + approval.py
  hardline (12 unconditional blocks) + shell de-obfuscation (NFKC · ANSI ·
  `$IFS` · line continuation · home-path folding · subshell anchoring) + OSV
  MAL-*. **No OS sandbox on local exec itself** (Docker/Modal/SSH/Daytona are
  opt-in backends).
- **Tools/media**: a multi-backend execution abstraction, checkpoints (git
  snapshot/rollback), fuzzy_match with 9 strategies (safe patching), PTC (RPC
  marshaling), browser (AX-tree `@eN` refs · a CDP supervisor · lightpanda→Chrome
  fallback · camoufox anti-detection), computer-use (SOM/vision/AX), voice
  (adaptive silence detection · Whisper hallucination filter), vision (native
  fast-path · CPU-bound).
- **Everyday web use cases**: morning briefings (cron), ticket digests, code
  review, a family WhatsApp assistant. **Web criticism**: unrestricted shell (no
  sandbox, CVE-2026-7396 path-traversal), 1-2 tok/s overhead (vs. 45 tok/s direct
  calls), a 64K-token minimum requirement.

### 3.2 openclaw (TypeScript, 149 extensions, 6,892 test files)

- **Multi-channel gateway (crown jewel)**: 24+ channels (WhatsApp · Telegram ·
  Slack · Discord · Signal · iMessage · Matrix · …) + 52 providers. The gateway is
  the auth/routing/HTTP tool-invoke front end. #1 web praise: "it answers on the
  channel I already use," non-developers using it in natural language.
- **"Dreaming" memory**: 3 stages (light 6h · deep nightly · REM weekly), a
  promotion score (frequency · relevance · diversity · recency half-life 14d ·
  min-recall 3 · health<0.35 recovery mode). **Off by default.** LanceDB hybrid
  (BM25+vector), active-memory (a recall sub-agent, circuit breaker).
- **Skill workshop**: a proposal lifecycle (pending→apply/reject/quarantine/stale
  30d), a content scanner (critical→block), a support-file cap of 32 files/1MB.
- **Agent loop**: a compaction planner (a dedicated worker, 40% chunks · 1.2x
  safety margin), tool-loop detection (window 30 · warn 10 · critical 20 ·
  ping-pong · no-progress · volatile-ID stripping), a post-compaction loop guard
  (window 3), a compaction safety timeout of 180s, context-engine quarantine (64
  entries).
- **Security**: exec-authorization-plan (shell topology analysis, rejects
  heredoc/dynamic execution), an exec-auto-reviewer (model-based risk triage —
  **can only downgrade to allow-once/ask, cannot deny or override**),
  dangerous-tools (gateway denies 15 HTTP tools), plugin-trust (supply-chain
  pinning/SRI), secret-mask, an **opt-in Docker sandbox** (cap-drop · seccomp ·
  AppArmor · resource caps).
- **Orchestration**: sub-agents (depth-4 role demotion · inherited denies ·
  target policy), task-flow SQLite, cron isolated-agent (fresh context), ACPX
  (Agent Client Protocol), a codex-supervisor, delivery backpressure (soft
  25/hard 50).
- **UX**: a command palette (Cmd+K, 90+ entries), an exec-approval modal
  (highlights the risky span), device pairing (QR/token), a Logbook (periodic
  screenshots → an activity timeline), Phone Control (arm/disarm for high-risk
  actions), Canvas (a visual workspace), companion apps (Win/mac/iOS/Android).
- **Everyday web use cases**: email automation (a 7AM workflow), PR monitoring,
  CRM call logging. **Web criticism (serious)**: a March 2026 CVE flood (9 CVEs
  in 4 days · CVSS 9.9 privilege escalation), 63% of public instances unauthenticated,
  17% of ClawHub skills carrying malicious code, supply-chain issues (unvetted
  npm), "breaks every other day."

### 3.3 Where Muse already matches or beats them (round-2 sweep re-confirmed — do not rebuild)

- **Skill authoring/curation**: Muse's authored-skill-store already has
  utility-aware eviction (TinyLFU) · write-time subsumption (Voyager) ·
  quarantine + risk scanning · snapshot ring + rollback · a semantic-coverage
  merge gate → **A-grade parity** with openclaw's workshop / hermes' Curator.
- **PTC**: hermes' code_execution RPC marshaling is already covered by Muse's
  `run_tool_plan`.
- **Prompt stable-prefix**: `@muse/prompts` has stablePrefix + stable/dynamic
  sections + priority → the cache-boundary concept already exists.
- **Cost tracking**: `muse cost` covers both local (`~/.muse/token-usage.jsonl`)
  and admin.
- **Vision pipeline**: gemma4 vision · Whisper STT · KSS TTS all wired.
- **Error taxonomy, retry, backoff, stream-idle, tool-dedup, the dangerous-command
  gate (DS-2), catastrophic-command fail-close (TX-6), resume idempotency** and
  much more of this reliability class already shipped in the backlog.

---

## 4. Positioning triangulation — Muse's three edges are unclaimed ground

The single most important finding. **Three independent sources converge on the
same conclusion**:

| Source | openclaw | hermes |
|---|---|---|
| Independent profiler (code) | Grounding is "the least instrumented dimension," prompt-only | Grounding is absent apart from one X-search path |
| Web reputation (community) | #1 criticism = security (CVEs · unauthenticated · 17% malicious skills), #2 = reliability ("breaks every other day") | #1 criticism = unrestricted shell, no sandbox; memory 2200-char cap |
| **Rivals' own documentation** | **grounding/citations · privacy-first/local-only · eval/verification — all three absent from documentation** | **Same three, all absent** |

Mining the rivals' own documentation (hermes README/docs across 355 files +
openclaw docs across 699 files) found: neither presents grounding, privacy-first,
or an eval framework **as a crown jewel or even as a documentation section.**

→ **Muse's three edges (deterministic grounding · local-first privacy · a live
eval gate) are not something rivals "chose not to build" — they are unclaimed
ground rivals don't even have anything to put in their own docs.** This doesn't
change the roadmap's direction, but it gives it **conviction**: raise the B-grade
dimensions to A+ while never sacrificing the three edges. And because **rivals'
biggest weaknesses (security, reliability) are exactly Muse's strength axes**, the
ordering that puts W1 (security) and W2 (reliability) first is now settled.

> Note: treat concrete web-reputation numbers (star counts, CVE numbers) as
> unverified community vibes and adopt **only the direction**. Only load-bearing
> claims backed by rivals' actual code ("no OS sandbox on local exec") are used
> as facts.

---

## 5. Muse's honest strengths and weaknesses

**3 real strengths (with defensible reasons)**:
1. **The deterministic grounding gate — the only one in its category.** 35
   surfaces with deterministic (non-LLM-judged) fail-close gates, a fabrication=0
   release gate. A gateway product prioritizes throughput and channel count, so
   retrofitting deterministic gates across 35 surfaces after the fact is work
   that took Muse 3 months — **the asset with the highest cost to imitate.**
2. **Verification discipline is itself evidence of quality.** hermes has 33.5k
   tests but no gate that measures "does the model actually get the job done."
   Muse's tool-selection (371 cases) · adversarial · plan-quality batteries block
   a release against a real local model. The discipline forced by using a small
   model became an edge.
3. **Honesty in learning.** hermes' Curator is a loop that "grows the skill set";
   Muse's Whetstone + correction-decay is a loop that "**shrinks how wrong it
   is**." It's the only one that matches the 'Learns you' positioning.

**3 real weaknesses (unflinchingly)**:
1. **The model ceiling is the common cause behind every B grade.** Multi-step
   reliability (eval:computer-task ~50-66%), a tool-call budget of 10, the
   illusion of parallelism — all physical limits of a local 12B.
2. **The runner's missing sandbox is a gap that violates Muse's own principle.**
   The contract is "risky execution goes through `crates/runner`," but that
   runner only does env_clear + timeout + output capping. The one place Muse
   falls short of its own non-negotiable ("guards are deterministic code").
3. **Fuel starvation.** The learning machinery is fully built, but `~/.muse` is
   effectively empty (found 7/7 times). The A grades above are still
   "laboratory A" grades.

---

## 6. Deriving A+ — what we need to do (the full slice queue, every dimension)

Each slice has: **Reference** (reference-only, for idea-generation) ·
**Muse-current** (verified 2026-07-11) · **Implementation** (Muse's own design) ·
**Acceptance** (the verification gate). Size (S/M/L).

### 6.0 Worker contract (common to every slice — violate it and the slice is void)

1. **VERIFY-FIRST.** Before starting, confirm current Muse state in code
   (codegraph). If a parallel loop already shipped it, mark it **no-op with
   ⏭️** and move on. "Muse-current" is only a 2026-07-11 snapshot.
2. **Verification ladder.** Narrowest unit test → mutation-RED → `pnpm
   test:changed` → lint 0/0. Agent-facing work (tools/prompts/adapters) needs
   `eval:tools` / the matching live battery; a new live case needs **STABLE
   3/3** pre-verification. Request/response paths need `smoke:live`.
3. **maker≠judge.** After a slice, an independent evaluator (a separate
   sub-agent) issues PASS/FAIL; a FAIL names the concrete violation.
4. **Non-negotiables.** agent-core stays vendor-neutral · guards stay
   fail-close deterministic code (security is never a prompt) · outbound stays
   draft-first · **the count of grounded surfaces and fabrication=0 are
   absolute invariants** · comments carry only WHY · any new internal
   dependency goes into both package.json and tsconfig references.
5. **Rival code is reference-only, for understanding.** Open it to understand
   the mechanism, then redesign in Muse's own patterns/naming. Recalibrate any
   constant for a local 12B on a single GPU and leave the reasoning in the
   test.

### 6.0.1 ★ Round 1 adversarial verification results (2026-07-11, 5-Haiku + Fable re-check) — required reading for workers

Every "Muse-current/gap" claim in the plan was checked against real code for
falsification. **5 false gaps** (the plan said "missing" but it actually exists
→ deleted) **and 4 refinements.** Workers must not build the deleted slices
below (they are either no-ops or would violate an existing safety decision).

**Deleted (⏭️ confirmed to exist — do not build):**
- **D1-S4 (preflight compaction)**: `workingBudgetTokens` is already wired —
  `runtime-wiring.ts:126-129` (`maxContextWindowTokens × DEFAULT_WORKING_BUDGET_RATIO`,
  env `MUSE_LLM_WORKING_BUDGET_TOKENS`) + `chat-ink-core.ts:905`. Threshold-%
  preflight compaction is **on by default**. Remaining (optional): just check
  whether a compaction event is surfaced to the user.
- **D4-S5 (history-search tool)**: the `history_search` MuseTool already exists
  (`packages/recall/src/history-search-tool.ts:20/40`, risk:read). Core + tool
  are complete.
- **D3-S5 (background_process start/stop tool)**: `background_list` (read-only)
  is already agent-facing (`domain-tools/src/background-list-tool.ts:20`);
  start/stop/logs are **intentionally CLI-only** ("state-changing exec must
  stay user-initiated" — outbound-safety). Exposing them to the agent would
  violate an existing safety decision, so **do not do it.**
- **D7-S2 (doctor fix-steps)**: every check already returns a "run `muse X`"
  repair step (`commands-doctor-checks.ts:61/64/79/220/226`). Complete.
- **D-KO-S2 (CJK search)**: `recall-lexical.ts:44-53` already does
  Hangul/Han/Hiragana/Katakana syllable-level tokenization + NFC ·
  full-width→half-width normalization. `searchHistory` uses it. Complete.

**Refined (real gaps, but narrower in scope than originally scoped):**
- **D3-S2 (heartbeat)**: the stale-detection registry (heartbeat/detectStalled/
  markStalledAsTimedOut, `subagent-run-registry.ts:100/174/185`) already
  exists, but **only one caller uses it — the orchestrator's worker-settle
  path** (`orchestrator.ts:347`). The real gap is exactly one thing: a
  **single long-running run** (the main chat/ask path, not a multi-worker one)
  never emits a heartbeat during the run. → the slice = **reuse** the
  existing detectStalled + have the agent-runtime tool loop call heartbeat on
  every tool-start (do not build a new detector).
- **D5-S3 (toolCalling fallback)**: not simply "unwired" — it's **dead code**.
  `canUseNativeTools` (`packages/model/src/index.ts:292`) is defined but has
  **zero callers**. Only the contract (architecture.md:38) exists; nothing is
  wired at runtime. The slice is to wire that function in as an actual gate.
- **D-KO-S1 (UTF-16)**: the safe pattern already exists inside
  `truncateErrorBody` (`shared/src/index.ts:257-260`) → extract it into a
  shared helper + **wire it at the exact 3 unsafe sites**: `history-search.ts:206/213`
  (snippets), `tool-definition-helpers.ts:108` (tool descriptions),
  `knowledge-corpus.ts:365` (summaries).
- **D2-S6 (write-approval staging)**: `pending-approval-store.ts` **already
  exists on the channel path** (`~/.muse/pending-approvals.json`,
  `{id,tool,arguments,draft,expiresAt}`). Only CLI local writes are synchronous
  (`actuator-tools.ts:262`). → **reuse the existing store** to extend to the
  CLI path.

**Fully confirmed (justified to build) — the D2 security 7-slice set in
particular has zero false gaps**: no OS sandbox in the runner (`crates/runner/src/main.rs`:
just env_clear+timeout+cap) · DS-2 missing NFKC/ANSI/home-path handling ·
missing topology AST · run_command not redacting secrets (`runner.ts:88-103`,
actual leak confirmed) · missing approval-span highlighting · calendar stored
in plaintext (`calendar/src/local-provider.ts:202`). The rest — D1(S1/S2/S3/S5/S6/S7)
· D3(S1/S3/S4/S6) · D4(S1/S2/S3/S4) · D5(S1/S2/S4/S5) · D6 · D7(S1/S3/S4) —
are also confirmed real gaps.

### D1 — Agent loop (B+ → A+)

> **Muse-current**: maxToolCalls 10 · wallclock 300s (`agent-runtime.ts:284-288`).
> No-progress stall detection + tool-failure streak. Compaction: deterministic
> `[Key details]` floor + opt-in aux summary (CMP-2 complete) + anti-resume +
> stale-image stripping. Stream idle-timeout · request-proportional timeout ·
> retry-after · decorrelated jitter · an error classifier — all shipped.
> **Gaps**: ping-pong detection · post-compaction loop guard · staged
> summarization · identifier preservation · preflight · one-shot recovery ·
> budget visibility · small-model browser reliability.

- **D1-S1. Ping-pong + volatile-ID stripping loop detection (M).** Reference:
  openclaw's `tool-loop-detection.ts` (window 30 · warn 10 · crit 20 · A↔B
  alternation · strips messageId/ts from send results). Muse's
  `tool-loop-progress.ts` only catches identical-output stalls. A sister
  module `tool-loop-pingpong.ts`, a SHA256 signature (tool + stabilized args),
  strip volatile Muse-tool fields (runId/tsIso/id) from the result hash,
  recalibrated window/thresholds for 12B (proposed window 20 · warn 6 · block
  10), CRITICAL joins blockedToolResult. Acceptance: 5+ alternating-loop units
  (genuine progress passes) · mutation · no eval:computer-task regression.
- **D1-S2. Post-compaction loop guard (S).** Reference: openclaw's
  `post-compaction-loop-guard.ts` (window 3). Muse lacks this (anti-resume is
  prompt-only). Arm a 3-call window after a compaction turn (summaryInserted),
  deterministic and on by default. Acceptance: scenario unit + mutation.
- **D1-S3. Staged summarization + identifier preservation (M).** Reference:
  openclaw's `summarizeInStages()` + hermes' summary budget (min 2000 tok ·
  ratio 0.20 · cap 10K). Muse's `summarizeDroppedContext` does a single
  summary pass (600 chars) → a full failure once it overflows. Chunk on
  tool-pair boundaries → summarize each chunk (reusing the aux summarizer) →
  merge, each stage FAIL-OPEN, and **explicitly instruct "preserve opaque
  identifiers (UUIDs/paths/URLs/numbers) verbatim"** (also strengthens
  grounding). Acceptance: boundary units + partial-failure preservation +
  mutation · existing CMP-2 unmodified.
- **D1-S4. ⏭️ Deleted (FALSE GAP).** Compaction preflight is already wired by
  default via `workingBudgetTokens` (§6.0.1). Remaining (optional, minimal):
  check whether a compaction event is surfaced to the user with a one-line
  note; if not, a display-only trivial slice.
- **D1-S5. Redesign the iteration budget + make it visible (M).** Reference:
  hermes' `iteration_budget.py` (parent 90/sub 50 · PTC refunded). Muse's
  maxToolCalls=10 (call count only). (a) codify a PTC plan-step accounting
  rule (programmatic = 1). (b) sub-agents (the board) get a separate
  sub-budget. (c) when exhausted, explicitly state "budget limit (N/M)" —
  **no silent cutoff.** The default of 10 is empirically grounded for 12B and
  stays fixed (raise it only via eval:computer-task). Acceptance: accounting +
  exhaustion-message units + mutation.
- **D1-S6. Turn-scoped one-shot recovery state (S).** Reference: hermes'
  `turn_retry_state.py`. Muse's recovery logic is scattered across ad-hoc
  spots. Consolidate into a single turn-state object (structurally rules out
  double retry); a behavior-preserving refactor. Acceptance: a unit that
  guarantees each recovery branch fires at most once.
- **D1-S7. Browser refs + step-budget + inline dialogs + injection defanging
  (L).** Reference: hermes' `browser_tool.py` (AX-tree `@eN` · dialogs
  inlined into the snapshot · lightpanda fallback), openclaw's
  `browser-tool.actions.ts` (compact AI snapshots · timeout injection ·
  stale-tab recovery · page-vision routing). Muse has a puppeteer
  detached-Chrome setup (fails closed on ambiguity). (a) return snapshots as
  **numeric indices `@e1…`** (never generate CSS selectors — a 12B can't),
  (b) a per-action timeout + a per-task step counter (hard cap, near-limit
  warning, echo `actions_used N/M` in the answer), (c) surface a pending
  dialog as a snapshot field + server-side auto-dismiss, (d) **wrap page
  content in `<page>` + defang media directives** (injection defense — the
  browser is the largest untrusted channel). Acceptance: ref stability · step
  exhaustion · dialog-inline · an injection-defanging contract (neutralizes
  "ignore the above") + no eval:computer-task regression. Browser needs a
  real e2e (mocking the assembly path is a lie — lesson learned).

### D2 — Security (B+ → A+)

> **Muse-current**: the runner does `env_clear()` (blocks secret leakage at
> the source — stronger than hermes' blocklist) + a timeout ceiling + output
> capping, **no OS sandbox.** The dangerous-command gate DS-2 (quote-aware
> normalization · `$IFS` · line continuation · substitution · anchoring) +
> TX-6 catastrophic-command fail-close. Approval secret masking · OSV MAL-* ·
> multiple encrypted stores (calendar remaining) · injection battery ·
> egress fail-close.
> **Recalibration**: hermes also has no OS sandbox on local exec (Docker is
> opt-in). Only openclaw has an opt-in Docker sandbox. Muse's gap isn't
> "below standard" — it's "**missing an opt-in isolation backend**."

- **D2-S1. runner seatbelt sandbox (opt-in) (L) ★ top priority.** Reference:
  openclaw's `sandbox/*` (cap-drop · resource caps · network modes · env
  sanitization, Docker-based). Muse is macOS-first, so **seatbelt**
  (`sandbox-exec` profiles) is the right answer — zero daemon, zero
  dependency. `crates/runner` `MUSE_RUNNER_SANDBOX=seatbelt` opt-in: default
  deny-write, allow = cwd-and-below + `$TMPDIR`, network only via a
  per-request flag, deny reading sensitive paths like `~/.ssh`/`~/.muse`.
  Code-generated profile strings (per-request cwd injection + escape
  validation), real-process Rust units (3 escape-attempt failures ·
  successful allowed write · blocked network). Non-macOS: "unsupported →
  existing behavior + warning." `muse doctor` posture check. Acceptance: 5+
  execution contracts · existing runner unmodified · byte-identical when
  unconfigured · **an escape-attempt case added to eval:adversarial.**
- **D2-S2. Shell-topology analysis fail-close (M).** Reference: openclaw's
  `exec-authorization-plan.ts` (rejects heredoc/dynamic execution as
  "unanalyzable") + hermes' subshell anchoring. Muse's DS-2 works at the
  string-pattern level — a catastrophic command inside `$(...)`/backticks/a
  heredoc can slip past the anchor. A topology pass ahead of
  `parseRunnerCommandRequest`: detect substitution/heredoc/eval → **cannot
  verify for catastrophe → downgrade to requiring approval** (not an
  unconditional reject — legitimate heredocs are respected), quote-aware
  (a lesson from DS-2 false positives). Acceptance: a block-per-bypass-class +
  near-miss-pass pairing · mutation-RED.
- **D2-S3. Extend de-obfuscation — NFKC+ANSI only (S, VQ-3 confirmed).**
  Reference: hermes' approval.py. **VQ-3 conclusion**: DS-2 already has
  `$IFS`/line-continuation/substitution/comment-strip, and **home-path
  (`~`/`$HOME`) is already built into the RULES patterns** (:65/74/83). →
  the actual gap is **only NFKC Unicode normalization + ANSI escape strip**
  (full-width→half-width homographs · ECMA-48 sequences). Acceptance: bypass
  payload pairs (full-width rm · ANSI injection) + existing DS-2 unmodified.
- **D2-S4. Mask secrets in runner output (S).** Reference: openclaw's
  secret-mask. **Verify-first** whether `redactSecretsInText` is wired into
  the runner stdout→model path; if not, run it right before returning the
  run_command result. Acceptance: wiring unit + benign performance on large
  output.
- **D2-S5. Encryption-at-rest for the remaining calendar store (S).** The
  backlog's "LAST encryption item." Reuse the reflections/belief-provenance
  verification template. Acceptance: 3 round-trip cases + format-preserving.
- **D2-S6. Approval span highlighting + write-approval staging (M, refined).**
  Reference: openclaw's `exec-approval.ts` (highlights the risky span) +
  hermes' `write_approval.py`. (a) highlight risky tokens (destructive flags ·
  sensitive paths) in the approval prompt — the current `summarizeToolArgs`
  (`chat-ink-core.ts`) only clips+redacts, no highlighting (§6.0.1). Reuse
  the DS-2 classifier, keep secret masking. (b) staging **reuses the existing
  `pending-approval-store.ts`** — it already exists on the channel path
  (`~/.muse/pending-approvals.json`); only CLI local writes are synchronous
  (`actuator-tools.ts:262`), so extend that store to the CLI path (no new
  store). Acceptance: highlight positions · a no-external-effect staging
  contract (absolutely nothing executes before approval) · mutation.
- **D2-S7. Expand eval:adversarial 16→24+ (M).** New: 3 sandbox-escape · 3
  topology-bypass · 2 obfuscation cases — all **scored in code by confirming
  the deterministic guard actually blocks it** (never relying on model
  refusal).

### D3 — Orchestration (B → A+)

> **Muse-current**: the `@muse/multi-agent` board (dependency gates · retry
> reasons · zombie reclaim after 30 min · parallel decomposition + synthesis ·
> REVIEW parking · a read-only executor), the X-3 background registry
> (S1-S6 · crash reconcile · cap 50), a scheduler with graceful drain/pause.
> Race mode intentionally falls back to sequential (honestly documented — a
> single GPU).

- **D3-S1. Demote sub-agent roles + inherited tool-deny (M).** Reference:
  openclaw's `subagent-capabilities.ts` (depth≥max→leaf, parent denies
  inherited) + hermes (max_spawn_depth 1). Muse's board is flat.
  **Verify-first** whether an expanded task can be re-expanded (risk of
  infinite decomposition). Add a depth field to tasks, `MUSE_BOARD_MAX_DEPTH`
  defaulting to 1; deny expand once reached; the executor's read-only gate
  inherits parent denies (structurally, not via prompt). Acceptance: depth-
  boundary + inheritance units + mutation (remove the demotion → RED).
- **D3-S2. Runtime heartbeat — wire the single-run case (S, refined).**
  Reference: hermes' `_heartbeat_loop`. **Note (§6.0.1)**: the
  stale-detection registry (heartbeat/detectStalled/markStalledAsTimedOut)
  already exists, but only one caller uses it — the orchestrator's
  worker-settle path. The real gap = a **single long-running run** never
  emits a heartbeat during the run. No new detector — **reuse the existing
  detectStalled** + have the agent-runtime tool loop call `heartbeat(runId)`
  on every tool-start/delta (in-tool staleness → abort with a reason).
  Acceptance: fake-clock unit (detects staleness in a single run) + no false
  positive on a healthy long-running stream.
- **D3-S3. Pin the completion-event idle-drain contract (S).** Reference:
  hermes' async_delegation (completion queue drained only in an idle window,
  preserving alternation/cache). Muse's jobCompletions/proactive polling
  already effectively follows this pattern — the contract test that "nothing
  can be inserted mid-generation" doesn't exist yet; verify-first, then pin
  it. Acceptance: a contract that no completion event is inserted while busy.
- **D3-S4. Capacity rejection + parent-headroom summary budget (M).**
  Reference: hermes (async rejected once cap 3 is exceeded · headroom×0.5/n ·
  floor 2000 · file spill). Muse's `/job` ceiling — verify-first — and no
  synthesis budget formula exists. (a) a job concurrency cap (default 3,
  overflow explicitly rejected), (b) `boardTaskPrompt` synthesis gets a
  headroom-proportional per-child budget + spills to `~/.muse/board-spill/`
  with the path stated in the answer. Acceptance: ceiling-rejection +
  budget-boundary units + spill round-trip.
- **D3-S5. ⏭️ Deleted (FALSE GAP + would violate a safety decision).**
  `background_list` (read-only) is already agent-facing; start/stop/logs are
  **intentionally CLI-only** (outbound-safety — §6.0.1). Exposing start/stop
  to the agent would violate an existing decision — **do not do it.**
- **D3-S6. eval:orchestration ratchet (S).** Fold D3-S1~S4 into live cases
  under pass^3, including 2+ of MAST's top failure modes (step repetition,
  unawareness of termination).
- **D3-S7. X-3 PID-reuse kill guard (S) ★ (Round 3 finding — a real safety
  gap).** Reference: hermes' `process_registry.py` (verifies via kernel
  start-time before killing, to catch PID reuse). **Confirmed (§9 #18)**:
  Muse's `stopBackgroundProcess` calls `kill(record.pid)` without any
  reuse verification (`background-process-spawn.ts:104`), and
  `reconcileBackgroundProcesses` only checks `isAlive(pid)` (:128) → if the
  original process dies and the PID gets recycled, **an unrelated user
  process gets SIGTERM'd.** The record has `startedAt` (:64) but it's never
  compared against the OS's start-time. Implementation: capture the OS
  process start-time at spawn (macOS `ps -o lstart=` / Linux
  `/proc/<pid>/stat`), compare before kill/reconcile — on mismatch, refuse to
  kill + mark the record `exited` (fail-close, a deterministic guard).
  Acceptance: a reuse-simulation unit (start-time mismatch → no kill) +
  mutation. Aligns with Muse's "risky execution = a deterministic guard"
  spirit.

### D4 — Tools (B → A+, A+ scoped to a single-user)

> **A+ redefined**: not chasing 149 extensions — instead, zero remaining items
> on the personal-assistant macOS buildable list + every tool one-shot-
> selectable by a 12B + an MCP server that's safe to expose to outside agents.

- **D4-S1. Extend `muse mcp serve` (M).** Reference: hermes' `mcp_serve.py`
  (turns itself into an MCP server). Muse currently exposes only 3 read-only
  tools. Expand the read family (recall/notes · calendar · tasks · browsing)
  + writes go through a **draft-first proxy** (an external request parks in
  Muse's approval queue — no auto-execution) + **exposing grounded recall
  itself is exporting the edge** (an external caller also gets a
  citation-gated answer). Acceptance: an MCP contract (stdio round-trip) +
  no-external-effect write-parking + a grounded-recall citation gate.
  groundedSurfaces 35→36.
- **D4-S2. Remaining macOS coverage (S×4).** From the backlog's 07-07 map:
  Photos · quit app · dark mode · brightness/Bluetooth (via Shortcuts) +
  Apple Contacts "write" (draft-first). Prefer expanding the `mac_system_set`
  enum first (never create a new tool — avoid confusable pairs) + eval
  cases.
- **D4-S3. Retrofit the `muse ask --with-tools` seam (M).** From the 07-10
  backlog (a): a prepare-only seam entry point → escape the legacy assembly
  path → a negative LOC delta in commands-ask.ts. Acceptance: cli ask
  unmodified + seam parity.
- **D4-S4. computer-control reliability — deterministic file_edit repair
  (M).** eval:computer-task's ~50-66% is mostly multi-step-edit failures. On
  failure, deterministic re-alignment/one retry (never re-inferring with the
  model). **Reference (Round 2)**: hermes' `fuzzy_match.py`'s **9-strategy
  chain** (exact→line-trimmed→whitespace-norm→indent-flex→escape-norm→
  trimmed-boundary→block-anchor→context-aware→unicode-norm) + an
  escape-drift guard (detects spurious `\'`/`\"` the model inserted) +
  indent repair (rebases the replacement string's indentation to the file's
  actual indentation). Redesign Muse's own deterministic matcher for this
  (LLM edits drift on whitespace/escaping/indentation → single exact-match
  fails 50%+ of the time). Acceptance: baseline +10pp · pass^3 + a unit per
  fuzzy strategy.
- **D4-S5. ⏭️ Deleted (FALSE GAP).** The `history_search` MuseTool already
  exists (`history-search-tool.ts:20`, risk:read — §6.0.1). Remaining
  (optional): whether to add hermes' session_search's anchor±window/bookend
  scrolling to the existing tool as an option — low priority.

### D5 — Model posture (B+ → A+)

> **Muse-current**: privacy-tiered routing is complete on both chat surfaces
> (single-shot + Ink) — **neither rival has this axis at all.**
> MUSE_VISION_MODEL/MUSE_AUX_COMPACTION individual knobs · DS-21 context
> probe · 4 BYO-key types.

- **D5-S1. Complete the privacy-routing follow-ups (M).** (b) codify the
  cloud decision for context-free tool use as **"no"** (a tool is a personal-
  data conduit, so staying local is the principle), (c) document the
  personaPreamble nuance, (d) add KO colloquial possessive tokens
  (내꺼/제꺼, with false-positive pairs) + a `muse setup cloud` guidance
  step. Acceptance: each as a unit + existing 20 contracts unmodified.
- **D5-S2. Generalize auxiliary.<task> model pinning (M).** Reference:
  hermes' `auxiliary.<task>` (a model + fallback per task). Muse's
  individual knobs are fragmented. A single `resolveAuxiliaryModel(task,env)`
  resolver (backward-compatible), tasks compaction/vision/rewrite/
  judge/embedding-rescue, **local-first stays invariant** (aux also passes
  the privacy gate — personal-context tasks may never go cloud). Acceptance:
  resolver · backward-compat · local-only-gate units.
- **D5-S3. Wire the dead capability code as an explicit error (S, VQ-2
  confirmed).** Reference: openclaw's compat layer. **VQ-2 conclusion**:
  `canUseNativeTools` (index.ts:292) is dead code + **the text tool
  protocol itself isn't implemented** (no parser). Since gemma4 has
  toolCalling=true, real usage is unaffected. → this slice = wire that
  function in as a gate that produces an **explicit "this model can't call
  tools" error** instead of silent failure for toolCalling=false models. A
  full text protocol (parser + strict parsing) is **deferred to a separate
  L** (only needed for a BYO non-tool-calling cloud model). Acceptance: a
  mocked capability-less model gets an explicit error + the dead code gets a
  caller.
- **D5-S4. An explicit fallback chain (M).** Reference: openclaw's
  allowlist+fallback (rejects typos early). Muse's principle ("no hidden
  retries"): a fallback is used **only when explicitly configured**
  (`MUSE_MODEL_FALLBACKS`) · each fallback also passes the privacy/local-only
  gate · surface a one-line note when it fires. Acceptance: chain-walk +
  gate units · byte-identical when unconfigured.
- **D5-S5. One attended live cloud round-trip proof (S).** Using Jinan's
  own key, record a real privacy-routing round-trip (context-free ☁️,
  personal stays local).

### D6 — Memory (A- → A+, fuel is the real issue)

- **D6-S1. Sleep-consolidation (opt-in) (L).** Reference: openclaw's
  dreaming promotion score (6 factors · 14d half-life · health<0.35
  recovery) — **do not mimic "off by default."** Muse's way: select
  episodic→durable promotion candidates by a **deterministic score**
  (re-recall · distinct queries · recency half-life, no LLM); promotion is a
  **draft proposal** ("want me to remember this longer?") · **never an
  autowrite** (the correction-forgetting principle). Aligns with the loop-v2
  Sleep daemon. Acceptance: score unit + proposal card + no-autowrite
  contract (mutation).
- **D6-S2. Audit the fuel pipeline (S, attended).** Turn on browsing
  auto-sync on the real device + wire it into proactive/recap (backlog99) +
  a weekly real-miss report (`muse doctor --flywheel`, reusing
  scout-signals).
- **D6-S3. Detect external-edit drift (round-trip) (S, VQ-7 confirmed).**
  Reference: hermes' `memory_tool.py`. **VQ-7 conclusion**: Muse's memory
  store already prevents clobbering **among its own writers** via
  `withFileLock` (cross-process, memory-user-store-file.ts:248/…). → the
  real gap is **external edits only** (manual · patch tools · appends by a
  tool that bypasses the lock) — exactly the case hermes catches. Block a
  rewrite on a re-serialization round-trip hash mismatch + `.bak.<ts>`
  (defense-in-depth). Acceptance: an external-modification-scenario unit
  (a change outside the lock → blocked) + the contract.
- **D6-S4. Provenance tags — foreground vs. autonomous (S).** Reference:
  hermes' ContextVar. Tag origin so autonomous curation can never delete a
  **user-directed** fact. authored-skill-store is already mature (§3.3) —
  verify-first whether memory facts have the same protection. Acceptance: an
  autonomous-deletion-forbidden contract (mutation).

### D7 — UX (new dimension): making headless "pleasant to use"

> Muse has 3 surfaces: Ink TUI + a macOS desktop app (Muse.app, Swift) + a web
> console. A+ = everyday friction as low as the rivals'.

- **D7-S1. Single-source slash-command registry (M).** Currently
  `SLASH_COMMANDS` exists only in chat-ink (separate from the commander
  CLI). Like hermes' COMMAND_REGISTRY, a single entry per command
  (name · desc · category · aliases · platform-gate) should drive CLI help ·
  chat autocomplete · (future) channels. Acceptance: registry unit + both
  surfaces reflect it + proof of deduplication.
- **D7-S2. ⏭️ Deleted (FALSE GAP).** Every doctor check already returns a
  "run `muse X`" repair step (§6.0.1). Complete.
- **D7-S3. Smart-tail terminal output (S).** Reference: hermes' terminal-
  output (jumps to the bottom on mount, tails only near the bottom, doesn't
  disturb you while scrolled up). Apply to the web console's streaming view.
  Acceptance: scroll-logic unit + a real-browser measurement (testing.md's
  UI rule).
- **D7-S4. Desktop responsiveness (S, attended).** Add a streaming
  elapsed-time timer + status feedback (a visual signal on success/error) to
  Muse.app. Reference: hermes' activity-timer · status-dot. Verify on a real
  device (attended).

### D-KO — Korean/CJK (new dimension): A+ for Jinan's primary language

> Muse is Korean-first. Rivals treat i18n as UI translation, but **CJK text
> safety** is something openclaw is still chasing a UTF-16 bug across 12
> modules for 3 weeks (a cautionary tale). hermes' 2200-char memory cap is
> especially damaging for CJK (1 Hangul character = multiple tokens).

- **D-KO-S1. Extract a UTF-16-safe truncation helper + wire the 3 unsafe
  sites (S) ★ (refined).** Reference: openclaw's `utf16-slice.ts`. **Note
  (§6.0.1)**: the safe pattern already exists in `truncateErrorBody`
  (`shared/src/index.ts:257-260`, drops a lone high-surrogate). **Extract**
  it as `truncateUtf16Safe` (removing duplication) + **wire the 4 unsafe
  sites (VQ-6 confirmed)**: `recall/src/history-search.ts:206/213` (citation
  snippets), `tools/src/tool-definition-helpers.ts:108` (tool descriptions),
  `autoconfigure/src/knowledge-corpus.ts:365` (summaries), **+
  `voice/src/tts-truncate.ts:19/28` (the TTS cap — a raw slice, confirmed
  zero surrogate guarding)**. Acceptance: Hangul/emoji/combining-character
  boundary units + byte-identical-when-safe at all 4 sites.
- **D-KO-S2. ⏭️ Deleted (FALSE GAP).** `recall-lexical.ts:44-53` already
  does Hangul/Han/Hiragana/Katakana syllable-level tokenization +
  NFC/full-width→half-width normalization. `searchHistory` uses it
  (§6.0.1). Cross-lingual recall (ask-cross-lingual.ts, the v2-moe prefix)
  is also fully wired. Complete.
- **D-KO-S3. A static i18n message catalog (M, low priority).** Currently
  KO/EN branch on many inline `/[가-힣]/` checks. A centralized dotted-key
  catalog improves maintainability but is **low priority** (the inline
  version works, and since Jinan's language is fixed to KO, multilingual
  pressure is low — the refactor risk may exceed the payoff).

---

## 7. Wave order (recommended)

| Wave | Slices | Rationale |
|---|---|---|
| **W1 (principle gaps)** | D2-S1 seatbelt → D2-S2 topology → D1-S1/S2 loop guards → D2-S6 approval span+staging → D3-S7 PID guard | The only shortfall against Muse's own principle (deterministic guards) + the most common 12B failure mode (loop drift) + the PID-reuse kill safety gap. **Rivals' shared biggest weakness (security · reliability) is exactly Muse's strength axis** — this is where the moat is |
| **W2 (reliability)** | D1-S3/S5 → D3-S1/S2/S4 → D1-S7 browser | Compaction · budget · sub-agent safety nets + small-model browser reliability — the foundation for eval:computer-task gains (D1-S4 deleted) |
| **W3 (capability · UX)** | D4-S4 → D4-S1 → D4-S2 → D7-S1 slash | Coverage on top of reliability + friction removal — each paired with an eval ratchet (D3-S5 · D4-S5 deleted) |
| **W4 (routing · KO)** | D5-S1~S4 → D1-S6 → D2-S3/S4/S5 → D-KO-S1 UTF-16 | Complete the model-ceiling workaround + wrap up Korean-first work (D-KO-S2 deleted) |
| **W5 (memory · closeout)** | D-E1 eval-gate enforcement → D6-S1~S4 → D3-S3/S6 → D2-S7 → D7-S3/S4 | Fuel · consolidation · integrity · ratchets · UX closeout. **D-E1 restores the verification-discipline grade from A back to A+** (§8.5.2) (D7-S2 deleted) |

Each wave ends with `pnpm self-eval` green + a higher number on the matching
eval ratchet + a CHANGELOG [Unreleased] update. One commit per slice
(Conventional Commits).

---

## 8. Non-goals (do not re-derive these — reasoning included)

- **Channel sprawl** (Telegram/Discord/… gateways): assessed as skip 10/13.
  Rivals' 52-54% fix-commit ratio is empirical proof of breadth's upkeep
  cost. openclaw's CVE flood and unauthenticated instances are the price of
  that breadth.
- **Multi-tenant/gateway relay + billing**: 50 off-strategy cases stay
  rejected.
- **tirith-style dependency on an external security binary**: a supply-chain
  and platform burden. Muse gets equivalent coverage from in-repo
  deterministic guards + OSV lookups (already shipped).
- **A security gate whose final decision is LLM judgment**: openclaw's
  exec-auto-reviewer is structured to "only downgrade to ask" — worth
  referencing, but not adopted, since it violates Muse's non-negotiable
  ("security = deterministic code").
- **Reusing subscription OAuth / banking / autonomous sending**: the
  permanent boundary stays in place.
- **Chasing leaderboards / dependence on a frontier model**: the conclusion
  of the best-OSS-agent review — proof is the gate ON-vs-OFF DELTA.
- **hermes-style 2200-char hard memory caps**: an anti-pattern actually
  criticized on the web. Muse handles this with compression + episodic
  memory (not a cap).

---

## 8.5 ★ Round 2 consolidation — re-analyzing rival sources (8-Haiku + Fable re-check)

Judged the un-swept areas (eval methodology · a fair hunt for grounding ·
real privacy implementation · proactivity · RAG internals · local-model tool
calling · config/onboarding · identity + a completeness critic). **Positioning
triangulation re-verified (all held, 1 honest correction) + 1 new slice +
refined references + 3 false gaps.**

### 8.5.1 Positioning adversarial re-verification results

- **Privacy (local-first) — verification passed ✅✅.** Neither has **any
  enforcement** of local-only (hermes' config has only `redact_pii`, no
  equivalent of `MUSE_LOCAL_ONLY`; openclaw is also cloud-first),
  memory/transcripts/secrets are **stored in plaintext**, and personal
  context is injected into cloud models by default. Muse's fail-close
  egress gate is **still the only one, even under adversarial
  verification.**
- **Grounding — verification passed (an honest nuance) ✅.** An
  answer-verification gate · abstention · fabrication measurement are
  **still at zero** on both rivals. But fairly: hermes has an **unmerged**
  `feat/web-grounding-citations` branch (a prompt-level citation
  instruction, not a gate), openclaw **displays** citations
  (`tools.citations.ts`, MEMORY.md#L5-L7 source locations) + wraps untrusted
  content (`external-content.ts`, injection defense — **Muse also has
  this via escapeSystemPromptMarkers**). Conclusion: both display
  citations + wrap untrusted content, but **neither has a claim↔source
  verification gate.** Muse's deterministic gate remains unrivaled. (Since
  rivals are moving toward prompt-based citations, Muse needs to keep
  widening its deterministic lead.)
- **Eval — a correction to my own claim (grade A+→A).** See §2. Muse's
  pre-push fabrication tripwire is the only live gate, but it's **local
  Ollama-dependent + the aggregate eval:agent isn't wired into CI.** The
  edge over rivals holds, but "live eval gates releases" is **only
  partially** true. → new slice D-E1.

### 8.5.2 New slice

- **D-E1. Actually enforce the aggregate eval gate (M) ★.** Current state:
  only `precheck:grounding` (the fabrication subset) runs as a pre-push
  hook. `eval:agent` (tool-selection · judge · adversarial · plan-quality ·
  orchestration…) is a script with no automatic enforcement.
  self-eval regression checks are also manual/loop-top only. → (a) extend
  the pre-push hook to the **core eval:agent subset** (when Ollama is
  available, within a time budget — skip-if-unreachable, like
  precheck-grounding), (b) auto-confirm self-eval regression fail-close **at
  commit time** (a tracked count drop blocks), (c) since GitHub CI has no
  Ollama, wire in only the **deterministic parts** (unit tests of the eval
  harness itself, scoreboard parsing, case-schema tests). **(d) A Tier-0
  contamination filter (Round 3, referencing openclaw's character-eval)**:
  before running a battery, scan its transcript for a leaked "backend
  error"/"tool failed"/"model unsupported"/"timeout" regex → **exclude an
  infrastructure failure instead of mistaking it for a behavior failure**
  (more precise than the current skip-if-Ollama-unreachable). This is the
  one real piece of work that restores the "verification discipline" grade
  from A back to A+. Acceptance: prove the hook actually blocks (inject a
  bad case → push rejected) + a Tier-0-exclusion unit + a
  skip-if-no-Ollama contract.

### 8.5.3 Refined references (strengthening existing slices)

- **D4-S4 ← hermes' 9-strategy fuzzy_match** (escape-drift guard · indent
  repair). §6 D4-S4 updated.
- **D1-S1 ← openclaw's unknown-tool detection** (`extractUnknownToolName`
  regex · UNKNOWN_TOOL_THRESHOLD 10 · circuit-breaker 30). Merge detection
  of repeated calls to a nonexistent tool into the ping-pong slice.

### 8.5.4 False gaps (Round 2 — do not build)

- **Ollama schema sanitization**: `sanitizeOllamaToolSchema` already exists
  (`adapter-ollama.ts:611`, the Ollama analog of sanitizeGeminiSchema, wired
  at :501). Complete.
- **Stripping control characters from prompts**: `stripUntrustedTerminalChars`
  is already widely wired across every untrusted entry point
  (active/ambient/attachment/episodic/inbox/skills/feeds) +
  `escapeSystemPromptMarkers` + `neutralizeInjectionSpans`
  (recall/present.ts). Complete.
- **doctor fix-steps**: (same as Round 1) already returns "run `muse X`"
  repair steps.

### 8.5.5 Optional enhancements (low priority — a separate backlog, must not damage the grounding edge)

Things rivals have and Muse doesn't, but that aren't core. Adopting any of
these must preserve the grounded-surface count and the fabrication=0
invariant: (a) **HyDE** (hypothetical-document expansion before embedding,
openclaw's qmd) — could improve recall, but check for overlap with Muse's
RAG-Fusion. (b) **derived concept-tags + semantic dedup** (openclaw's
short-term-promotion) — faceted recall. (c) **binary-search seeking during
active hours** (openclaw's heartbeat) — during quiet hours, skip to the next
active window instead of dropping ticks (Muse currently drops ticks). (d)
**loud-fail config** (openclaw's principle: a broken config must never
silently fall back to a default; doctor migration should explicitly repair
it; hermes' silent fallback is an anti-pattern). Verify-first whether Muse's
config-parse failures are already loud. (e) **HRR compositional-algebra
search** (hermes' holographic) — multi-entity AND · contradiction detection;
Muse already has contradiction-detection, so ROI is low.

---

## 8.6 Round 3 consolidation — the final sweep (5-Haiku + Fable re-check)

The final pass over remaining core areas (eval internals · domain
actuators · durability/migration · performance · a full completeness
critic). **1 new real slice (D3-S7 safety) + 2 refinements + 3 confirmed
Muse strengths + several low-value enhancements.**

### 8.6.1 Confirmed Muse strengths (ahead of both rivals — do not rebuild or over-invest)

- **Domain actuators = a moat, not a gap.** Muse's calendar/reminders/
  contacts/home have an approval gate (including no-target rejection) +
  id-idempotency (re-add merges, zero duplicates) + timezone handled by
  **server delegation** (verbatim phrase, DST-safe, shown locally) +
  soft-fail mirroring (Muse's write still succeeds even if Apple Reminders
  fails) + structured errors (offers candidates, never guesses) — **clearly
  more robust than both rivals** (both are messaging-centric and lack
  idempotency · approval · structured feedback).
- **Durability = complete.** atomicWriteFile + parent-dir fsync ·
  withFileMutationQueue (per-file serialization) ·
  backupVersionMismatchedStore — all shipped. D6-S3's answer is to **keep
  JSON** (no need to introduce SQLite — hermes' WAL+fallback only makes
  sense because it already uses SQLite). One minor remaining item: the
  encrypted stores **don't create a backup before the key-re-encryption
  migration** → recommend `.plaintext-backup-<ts>` (for key-loss recovery,
  on the D2 encryption path).
- **Performance foundation = present.** V8 compile cache · prompt
  stablePrefix · keep-alive · KV-quant · working-budget compaction — all in
  place. Heartbeat cache-warming is **for cloud prompt caching**, so it's
  low value for local-first Muse (skip).

### 8.6.2 Refinements (strengthening existing slices)

- **D-E1 ← the Tier-0 contamination filter** (openclaw's character-eval).
  §8.5.2 updated.
- **D3-S3 ← poll-vs-consumed double dedup** (hermes' process_registry #3):
  merely **polling (observing)** a background process's state must not
  suppress the autonomous completion notification (observing ≠ consuming).
  Add this distinction to the idle-drain contract test.
- **D6-S3 ← hermes' memory_tool drift+`.bak`** (#8): block-write-on-
  round-trip-mismatch + backup is the exact right reference implementation.
  §6 D6-S3 stands as-is.

### 8.6.3 Low-value enhancements (a separate backlog, low priority — must not damage the grounding edge)

10 completeness-critic items that fit Muse and aren't covered but also
aren't core: (a) **orphaned-pipe draining** (hermes #5 — a grandchild can
keep a pipe open even after the child exits, leaving poll stuck "running"
forever; verify-first on X-3), (b) **connection-epoch invalidation**
(openclaw #6 — discard a stale async result after reconnecting; verify-first
on the web console/SSE), (c) **request coalescing** (openclaw #1 — dedupe
concurrent fetches of the same resource; web console), (d) a
**parallel-tool-call-inducing prompt** + cold-start poll exponential backoff
(minor performance). **Already covered**: frozen-snapshot+live-mutation (#7
= Muse's chat-ink `memoryHolder`), external-drift (#8 = D6-S3). **Skip**:
watch-pattern strike-window (Muse doesn't use watch-pattern), device-
fingerprint · idempotency-dual-key (low value for a single user).

---

## 9. Appendix — evidence verification log (Fable's direct spot-checks, 2026-07-11)

| # | Claim (from the sweep) | Verification |
|---|---|---|
| 1 | hermes iteration_budget 90/50 + execute_code refund | ✅ `agent/iteration_budget.py:1-28` |
| 2 | openclaw post-compaction-loop-guard window=3 | ✅ `post-compaction-loop-guard.ts:15` |
| 3 | openclaw exec-authorization-plan rejects heredoc/dynamic | ✅ `src/infra/exec-authorization-plan.ts:101-103` |
| 4 | hermes tool budget 100K/200K + 0.15 window-proportional | ✅ `tools/budget_config.py:17-75` |
| 5 | openclaw dreaming half-life14d · min-recall3 · health0.35 | ✅ `dreaming.ts:40-47` |
| 6 | openclaw loop detection 30/10/20 | ✅ `tool-loop-detection.ts:39-49` |
| 7 | hermes stream stale180s · reasoning floor600s | ✅ `reasoning_timeouts.py:7-72` |
| 8 | Muse `muse cost` local+admin both | ✅ `commands-cost.ts:12-23` + admin route |
| 9 | Muse prompts has stablePrefix/stable-dynamic | ✅ `packages/prompts/src/index.ts:33-162` |
| 10 | Muse lacks a general UTF-16 helper (only tool-args covered) | ✅ shared surrogate mention in 1 spot (:255) · no general slice → D-KO-S1 justified |
| 11 | Muse SLASH_COMMANDS is chat-ink-only | ✅ defined only in `chat-ink.ts:69` → D7-S1 justified |
| 12 | Both licensed MIT | ✅ hermes `LICENSE` (Nous 2025) · openclaw `LICENSE` (Foundation 2026) |
| 13 | Muse's pre-push fabrication tripwire exists · not wired into CI | ✅ `.git/hooks/pre-push`→`precheck:grounding` (`install-git-hooks.sh:46`); ci.yml=lint+lint:comments+check only (0 eval calls) |
| 14 | Rivals have no local-only enforcement | ✅ hermes config has only `redact_pii` · openclaw cloud-first, plaintext storage (both repos) |
| 15 | Rivals lack a grounding gate (citation display only) | ✅ openclaw `tools.citations.ts` (display) · `external-content.ts` (wrapping); hermes citation branch unmerged; zero verification gates |
| 16 | Ollama schema sanitizer exists | ✅ `adapter-ollama.ts:611` sanitizeOllamaToolSchema (wired at :501) → not new |
| 17 | Control-char stripping widely wired in prompts | ✅ stripUntrustedTerminalChars at 7+ entry points · escapeSystemPromptMarkers (recall/present.ts:845) |
| 18 | X-3 kill/reconcile doesn't verify PID reuse (a safety gap) | ✅ `background-process-spawn.ts:104` (kill, unverified) · :128 (isAlive only) → D3-S7 justified |
| 19 | Muse's domain actuators are more robust than rivals' | ✅ approval-gate + id-idempotency + server-delegated timezone + soft-fail mirroring (loopback-calendar/contacts/reminders tests) — not a gap |
| 20 | Muse's durability is complete (atomic+queue+backup) | ✅ atomic-file-store.ts (dir fsync) · withFileMutationQueue · store-version-backup.ts — D6-S3 stays JSON |
| 21 | No Tier-0 contamination filter in eval (D-E1 detail) | ✅ eval-harness.mjs has no infra-contamination pre-exclusion → D-E1 (d) justified |

**Confirmed Muse-side facts**: the runner does `env_clear()` + timeout-only
(`crates/runner/src/main.rs:101`), `maxToolCalls=10`/`maxRunWallclockMs=300s`
(`agent-runtime.ts:284-288`), no-progress detection exists but ping-pong
doesn't (`tool-loop-progress.ts`), `muse mcp serve` exposed 3 read-only tools
*(as of 2026-07-30, 6 tools — `propose_action` added in D4-S1a, see below)*
(`commands-mcp-serve.ts`), authored-skill-store is mature
(eviction/subsumption/quarantine/snapshot/coverage-gate).

**Triangulated verification of rivals' own documentation** (§4): mining
hermes' README/docs across 355 files + openclaw's docs across 699 files
found neither presents grounding/citations · privacy-first/local-only ·
eval/verification as a crown jewel or even as a documentation section. The
raw sweep (the full mechanism catalog · 18 agents) exists only as a session
artifact — this document is the canonical record of what got adopted;
re-examining unadopted mechanisms is for the next delta-scout cycle.

---

## 10. ★ Fable's quality verdict + execution checklist (2026-07-11)

### 10.1 Verdict: is this an executable plan? — **YES, with 3 conditions**

**Passes as a plan.** Grounds: (a) all 34 active slices have complete
reference/current(verified)/implementation(Muse-designed)/acceptance(gate)
elements, (b) 5 false gaps deleted · 4 refined to remove no-ops, (c) 21
load-bearing claims spot-checked to file:line (§9), (d) the wave order is
logically principle-gaps→reliability→capability→routing→closeout, (e) the
non-negotiables (grounding · fabrication=0 · vendor-neutral · fail-close)
are stated in every slice. A Sonnet worker can start directly from the §10.3
checklist.

**But, 3 conditions (must be handled before starting):**

1. **The 3 L-slices can't be single commits → must be sub-divided.**
   D2-S1 (seatbelt) · D1-S7 (browser) · D6-S1 (sleep) each need 3-4
   commits. Broken into sub-steps in §10.3. "Do an L in one shot" isn't
   reviewable or revertable.
2. **Verify-first items must be resolved from the §11 queue before
   starting.** "Muse-current" is a 2026-07-11 snapshot — a parallel loop
   may have already moved things, and some haven't yet pinpointed the wiring
   point (D3-S2's heartbeat call site, D5-S3's gate location, etc.). If a
   slice has an open queue item, start from that item.
3. **False-positive-risk slices require near-miss-pair tests as part of
   acceptance.** D2-S1 (block a legitimate command) · D2-S2 (block a
   legitimate heredoc) · D1-S1 (block a legitimate repetition) aren't done
   without both-sided tests — "blocks what it should block + passes what it
   must not block." Made explicit in §10.3.

### 10.2 Quality issues found + how they're handled (Fable review)

| # | Issue | Severity | Handling |
|---|---|---|---|
| Q1 | 3 L-slices aren't single-commit sized | High | Sub-divided in §10.3 |
| Q2 | Dependencies between slices are only implicit in the waves — need to be explicit | Med | New dependency table added, §10.4 |
| Q3 | Verify-first items are scattered through slice bodies | Med | Consolidated into a living queue, §11 |
| Q4 | Some acceptance criteria aren't quantified ("performance benign") | Low | Fixed benchmark thresholds added in §11-VQ |
| Q5 | W4 is overloaded with 9 slices (W3 has 4) | Low | Most are S-sized so it's acceptable — split into W4a/W4b if needed |
| Q6 | D3-S7 is in W1, but this is the first time it touches X-3 files (D3-S1/S4 are in W2) | Low | Safety-first ordering wins — keep it, note only |
| Q7 | No per-slice rollback/risk column | Med | Risk tag added to every item in §10.3 |

### 10.3 Execution checklist (by wave · by slice)

Start rule: top→bottom order. Each `[ ]` is **1 commit** (an L's sub-steps
are also 1 commit each). Common gate for every slice = `test:changed` →
mutation-RED → lint 0/0 → (if agent-facing, eval:tools / the matching
battery STABLE 3/3; if a request path, smoke:live). ⚠=false-positive risk
(near-miss pair test required), 🔒=fail-close safety slice, 📈=paired with
an eval ratchet.

#### W1 — principle gaps (security · loop drift · PID)
- [x] **D2-S1a** ✅ 2026-07-11 seatbelt SBPL profile generator
  (`build_seatbelt_profile`+`escape_sbpl_string`, pure · not yet wired) —
  deny-default · broad file-read* · write limited to cwd/$TMPDIR/pnpm·npm·cache ·
  network opt-in; escape correctness Fable-verified against injection. 26
  tests (12 new) · clippy clean. Wired in ⏭️b
- [x] **D2-S1b** ✅ 2026-07-11 🔒 Wired `MUSE_RUNNER_SANDBOX=seatbelt` into
  the runner (`spawn_plan`→`sandbox-exec -p`) + real-process contracts for
  3 escape attempts (write outside cwd · write to ~/.ssh · network fail-close
  + allowNetwork opt-in, and legitimate commands git/sh/node pass through).
  Two live-device findings addressed: ① the profile path **must be
  canonicalized** (/var→/private/var symlink; unresolved → deny everything)
  ② without `/dev/null`+`/dev/dtracehelper` write-data allowance, git fails
  entirely → added those (+`/private/tmp` subpath). Byte-identical when
  unconfigured (the spawn plan passes through + `sandboxWarning` is skipped
  from serialization); canonicalize failure fails closed. allowNetwork is
  caller-only (blocked from model tool-args, negative-tested). 38 rust
  tests (4 contract, mutation-RED verified) · clippy clean · evaluator PASS
  (maker≠judge)
- [x] **D2-S1c** ✅ 2026-07-11 (shipped alongside S1b) Non-macOS
  `RequestedUnsupported` fallback (unsandboxed execution +
  `sandboxWarning` surfaced, unit-tested) + `muse doctor`
  `runnerSandboxPostureCheck` 3-way (off/ok · darwin active/ok · non-darwin
  warn)
- [x] **D2-S1d** ✅ 2026-07-11 📈 Added 3 deterministic sandbox-escape
  cases to eval:adversarial (spawns the real `muse-runner` binary under
  seatbelt → an OS-level rejection is scored in code, not a model refusal —
  agent-testing #5). Write outside cwd · write to ~/.ssh · network escape;
  the network case is scored via an `accepted` listener flag, so with the
  guard OFF (a successful connection) it goes RED (a nonzero curl exit
  alone wouldn't have caught a fake pass). Ollama-independent · macOS-only
  (skip≠pass), the 16 LLM cases unmodified. adversarialCases ratchet
  16→19, 2/2 node:test mutation locks, Opus's independent evaluator
  reproduced guard-ON/OFF and PASSed
- [x] **D2-S2a** ✅ 2026-07-11 🔒⚠ A pure topology classifier
  `classifyCommandTopology(command,args)` (packages/tools) — a non-shell
  command is always analyzable (near-miss: `echo '$(rm -rf /)'`, `node
  app '$(x)'`); for shell `-c` scripts, quote-aware detection (single-quotes
  = literal) of `$(`/backticks · `<(`/`>(` · `<<` · a command-position `eval`
  → `{analyzable:false}`. Pure · not yet wired (following D2-S1a's
  precedent). Opus's evaluator FAILed the first pass, catching 2 real
  defects: ① a newline is a POSIX command separator but the eval-detection
  missed it (a false negative) ② `$((` arithmetic was misdetected as
  command substitution (a false positive, `$((1+2))`); nested `$(( $(id) ))`
  is still correctly caught. 22 tests (bypass/near-miss pairs · bidirectional
  mutation-RED) · Opus's re-judgment PASSed. sudo/env wrapper bypasses are
  tracked as VQ-15
- [x] **D2-S2b** ✅ 2026-07-11 🔒 Wired the D2-S2a classifier into the live
  approval gate `chatToolApprovalGate` (apps/cli). Finding: trust.json isn't
  wired at runtime yet (`commands-trust.ts` — a follow-up), and run_command
  is already an "execute" risk that always asks the human → no live seam
  for "downgrading from auto-approve." Honest scope actually delivered:
  ① an un-analyzable `run_command` is **never silently allowed**, even if
  its risk is disguised as read (the read fast-path gets `&&
  topology.analyzable` — a structural invariant that can't be bypassed by
  the topology check) ② the approval prompt surfaces an "unanalyzable
  shell construct" warning (informed consent — a human can still approve a
  legitimate heredoc). Not an unconditional reject. 135 tests
  (bypass-proof invariant · warning surface · arg-hostility ·
  bidirectional mutation-RED) · Opus's evaluator PASSed. The unwired
  auto-approve seam is tracked as VQ-16
- [x] **D1-S1** ✅ 2026-07-11 ⚠ Ping-pong loop guard `tool-loop-pingpong.ts`
  (agent-core) — detects A↔B alternation (a 2-value pattern) via a
  trailing-alternation run (window 20 · warn 6 · block 10), signature = name
  + stableJson(args) + result with volatile fields (runId/tsIso/id/ts/
  timestamp) recursively stripped; on block → `pingPongAbortedExecution`
  (mirroring post-compaction, wired into both loops). Stalls (A,A,A), a
  3-value cycle, and genuinely distinct progress all resolve to "none"
  (zero false positives). 19 units + 55 model-loop cases · bidirectional
  mutation-RED (the alternation condition · volatile stripping) · Opus's
  evaluator PASSed (correct threshold · a false-positive battery · id-strip
  is safe because it preserves args). eval:computer-task got re-run
  local-forced after an ambient GEMINI_API_KEY hijack (VQ-17)
- [x] **D1-S2** ✅ 2026-07-11 Post-compaction loop guard (window 3) —
  `PostCompactionLoopGuard` (arms on summaryInserted, aborts after 3
  consecutive identical tool+args+result signatures); 15/15 units + wiring,
  5 mutation RED, an independent evaluator PASSed (confirmed arming = once
  per run architecture). ⏭️ follow-up: the plan-execute-loop path isn't
  covered (a separate slice)
- [x] **D2-S6a** ✅ 2026-07-11 Approval-prompt risky-token highlighting —
  pure `identifyRiskyTokens`/`emphasizeRiskyTokens` (@muse/tools, reuses
  DS-2's risk vocabulary: destructive flags -rf/--force · sensitive paths
  //~/.ssh//etc//dev · destructive verbs rm/dd/mkfs in command position)
  wired into `chatToolApprovalGate`'s detail (applied as TRUSTED ANSI
  bold-red only after summarizeToolArgs' redact+strip). Safe commands and
  a quoted "rm" aren't highlighted (zero false positives), spans don't
  overlap, offsets are exact, ReDoS-capped. 13 tests · 3-way
  mutation-RED · Opus's evaluator PASSed. (b) write-approval staging is
  separate
- [x] **D2-S6b** ✅ 2026-07-11 Write-approval staging — stages the CLI's
  non-interactive fs-write-gate rejection into the existing
  `pending-approval-store` (reusing @muse/messaging, zero new stores)
  (`recordPendingApproval`→`~/.muse/pending-approvals.json`, the exact
  file `muse approvals` reads). No-external-effect contract: driving the
  real createFsWriteTool e2e confirms the file is never created + the
  entry round-trips (passes isPendingApproval). A staging failure still
  denies (try/catch), the interactive approval path is unaffected. 29
  tests · bidirectional mutation-RED · Opus's evaluator PASSed (confirmed
  messaging/src untouched). CLI-write replay (with content) isn't wired =
  VQ-18
- [x] **D3-S7** ✅ 2026-07-11 🔒 X-3 PID-reuse kill guard — added
  `osStartTime` to the background-process record (OS start-time captured
  at spawn, via an injectable reader), a pure `pidIdentityMatches`
  (legacy=unset → treated as unverifiable and preserved; set → equality
  against the current value). `stopBackgroundProcess`/
  `reconcileBackgroundProcesses` compare before kill/reconcile — on
  mismatch (reuse/gone), refuse to kill + mark the record `exited`
  (fail-close, a new `pid_reused` result). Wired the CLI via
  `ps -o lstart= -p` (BSD+GNU, avoiding /proc, verified on a real device).
  13 reuse-simulation units · bidirectional mutation-RED · Opus's
  evaluator PASSed (0 messaging edits · 0 env). **W1 (principle gaps)
  complete**

#### W2 — reliability (compaction · budget · sub-agents · browser)
- [x] **D1-S3** ✅ 2026-07-11 Staged summarization —
  `summarizeDroppedContextInStages`+`chunkDroppedOnToolPairs` (@muse/memory,
  pure): chunks dropped content on tool-pair boundaries (a split right
  before a `role:"tool"` message is strictly forbidden; an oversized pair
  becomes 1 chunk) → reuses summarizeDroppedContext per chunk (each
  FAIL-OPEN, fallback:"") → merges only the non-empty results · caps at
  maxChars. **A partial failure preserves the surviving chunks**, a total
  failure falls back to the deterministic floor. The existing
  `summarizeDroppedContext` stays byte-identical (additions-only).
  Codified an identifier-preservation instruction (UUID/path/URL/number
  VERBATIM) into SUMMARIZER_SYSTEM_PROMPT (strengthens grounding). Wired
  in both agent-runtime:578 and chat-ink-core:941 (a 1-chunk case is
  equivalent to the single-shot path). 18 tests (boundary · partial
  failure · single-chunk equivalence · bidirectional mutation-RED) ·
  Opus's evaluator PASSed
- [x] **D1-S5a** ✅ 2026-07-11 Explicit budget-exhaustion notice (no
  silent cutoff) — when the tool budget is exhausted
  (toolCallCount≥maxToolCalls), injects an "N/M tool calls used, giving
  my best final answer now" one-shot notice into messages before final
  synthesis (proactive: before the empty-tools call, budget-only, a
  strict gate excluding wallclock/stall). Pure `budgetExhaustionNotice`+
  `BudgetExhaustionTracker` (mirroring the REVERIFY_NUDGE pattern), wired
  into both loops. Normal completion · stall · wallclock don't inject it.
  maxToolCalls=10 stays fixed. 62 tests · bidirectional mutation-RED (gate
  removed → false positive on normal completion goes RED; injection
  removed → missing injection goes RED) · Opus's evaluator PASSed
  (confirmed the design deviation to proactive is legitimate, confirmed
  the strict budget gate, confirmed guaranteed termination, confirmed the
  existing agent-runtime tests were tightened, not loosened)
- [x] **D1-S5b1** ✅ 2026-07-11 Codified the PTC step-accounting rule
  (programmatic=1) — run_tool_plan already counts as 1 call = 1 budget slot
  (regardless of internal step count) but implicitly so → added a WHY
  comment to the agent-runtime PTC intercept + a regression-lock test (a
  3-step plan executes = effects[a,b,c] ∧ 1 slot consumed =
  toolsUsed["run_tool_plan"]). Accounting behavior unchanged (comment +
  test only). Bidirectional mutation-RED (counting steps individually →
  toolsUsed length 3 goes RED) · Opus's evaluator PASSed (confirmed
  behavior-locking · comment accuracy trace). No user-visible change, so
  CHANGELOG omitted
- [x] **D1-S5b2** ✅ 2026-07-11 Separate sub-agent tool sub-budget — pure
  `resolveSubAgentToolBudget(parent)` (@muse/multi-agent:
  max(3, floor(parent×0.5)), uncapped→5, a worker is always capped) +
  wired into the ask-decompose worker's execute (a shallow override
  instead of inheriting the parent's metadata.maxTools verbatim, args.metadata
  left unmutated). synthesize/planner keep the parent's budget
  (lead-level). 6+23 tests · bidirectional mutation-RED · Opus PASSed.
  Sibling audit: orchestrator.ts/commands-board also inherit the parent's
  metadata (same class) but are server-side with no maxTools convention →
  logged as a backlog follow-up. **D1-S5 complete (b1+b2)**
- [x] **D3-S1a** ✅ 2026-07-11 Board-task depth demotion — added an
  optional `depth` to AgentTask (parent=0, sub=depth+1),
  `resolveBoardMaxDepth(env)` (`MUSE_BOARD_MAX_DEPTH` default 1 ·
  floor 1), and `expandTaskIntoSubtasks(...,maxDepth=1)` no-ops (rejects
  re-decomposition) once `(parent.depth??0)>=maxDepth` — confirmed via
  verify-first that sub-tasks could be re-expanded (grandchild infinite
  decomposition). Back-compat (missing depth = 0, existing no-op guard
  kept, maxDepth 1 still allows the first decomposition). Wired the CLI
  board expand path. 34 tests (depth boundary depth==maxDepth · parent+1
  · a parsing table) · bidirectional mutation-RED · Opus PASSed. ENV.md
  updated
- [x] **D3-S1b** ✅ 2026-07-11 Parent tool-deny inheritance — pure
  `inheritParentToolDeny(parent,child)` (@muse/multi-agent: intersects
  child⊆parent, drops a requested tool not present on the parent, keeps
  the child as-is if the parent is unrestricted) + a structural clamp
  wired into the ask-decompose worker's execute (worker
  allowedToolNames = the parent intersection, args.metadata left
  unmutated, planner/synthesize unclamped). 8+2 tests · bidirectional
  mutation-RED (removing the demotion → tool `c` leaks → RED). Opus PASSed
  + an explicit significance judgment: the pure invariant is real, and
  pre-placing the clamp at the actual enforcement point is genuine
  defense-in-depth. ⚠caveat: the current production caller never passes a
  broader set, so the clamp is a production no-op (verified via a
  test-only seam), zero user-visible change → CHANGELOG omitted honestly.
  Siblings: orchestrator verbatim · board top-level → backlog follow-up.
  **D3-S1 complete (a+b)**
- [x] **D3-S2** ✅ 2026-07-11 Single-run heartbeat wiring —
  `ModelLoopRunner.heartbeat?`+an `AgentRuntimeOptions.heartbeat` injection
  seam (agent-core stays independent of multi-agent), 3 model-loop
  emission points (streamModelTurn text-delta · tool-call + only
  genuine-exec in runToolBatch, gated the same way as
  progress/failureStreak) call `emitHeartbeat` (try/catch, a throw never
  breaks the loop). Zero new detectors (reuses the existing
  detectStalled). Byte-identical when unwired. 4+2 tests (emission spy ·
  fake-clock stall detection [400ms heartbeat = no false positive, 150ms
  silence>timeout = detected]) · bidirectional mutation-RED · Opus
  PASSed (judged the deferral legitimate). ⚠DEFERRED = feeding the live
  SubAgentRunRegistry (autoconfigure→multi-agent dependency, or
  reordering apps/api's construction order — an architectural decision) +
  a stall-abort poller → backlog. Zero user-visible change
- [x] **D3-S4a** ✅ 2026-07-11 Job concurrency cap — `muse job run`
  (background) previously spawned unbounded jobs (verify-first) → now
  capped (`MUSE_JOBS_MAX_CONCURRENT` default 3, ≥1). Pure
  `resolveJobsMaxConcurrent`+`jobConcurrencyRefusal(runningCount,cap,
  >=cap refused)` + `countRunningJobs` (reuses the existing jobSummary,
  running only) + wired into `startBackgroundJobOrRefuse` (at-cap →
  explicit stderr rejection + exitCode 1, start never called; inline
  unchanged). 27 tests (parsing · a real jsonl fixture · an at-cap spy
  never called) · bidirectional mutation-RED · Opus PASSed. ENV.md
  updated
- [x] **D3-S4b** ✅ 2026-07-11 Parent-headroom summary budget — pure
  `perChildSynthesisBudget(headroom,n)=max(2000,floor(headroom×0.5/n))`
  (div0/NaN/Inf/neg→floor 2000) + `budgetAndSpillOutputs` (truncates
  over-budget children + spills the FULL original to
  `~/.muse/board-spill/<taskid>-<i>.txt` [writeSpill is injectable],
  the exact path stated in the segment) + wired into makeAgentExecutor
  (real fs, the spill location noted in the answer). boardTaskPrompt
  stays pure. `resolveBoardSynthesisHeadroom`
  (MUSE_BOARD_SYNTHESIS_HEADROOM default 24000) ·
  `boardSpillDir` (MUSE_BOARD_SPILL_DIR). 41 tests (budget boundaries ·
  round-trip spill === original · real-fs round-trip) · bidirectional
  mutation-RED (truncate removed · writeSpill skipped) · Opus PASSed
  (confirmed no data loss). ENV.md updated. **D3-S4 complete (a+b)**
- [x] **D1-S7a** ✅ 2026-07-11 🔒 Refs were already numeric indices
  (0-based) with no CSS-selector model exposure → requirement (a)
  ("numeric index") was already met. The delta = a "ref-stability unit":
  closed a hole where `resolveTarget` (browser-tools.ts)'s numeric-ref
  branch let through a ref not present in the current snapshot
  (stale/ghost/hallucinated), letting the agent act on a ghost element —
  now fails closed. `describeElement(ref)`=undefined → "call
  browser_read" is refused (zero partial side effects). resolveTarget is
  the single resolution point for click/hover/type/upload, so all 4
  siblings share the fix. 3 behavior tests (valid proceeds · ghost click
  rejected · ghost type rejected, calls never recorded) · bidirectional
  mutation-RED (removing the guard → 2 RED, reproduced independently by
  Opus) · format unchanged (`@e` string format kept → the eval contract
  unaffected). `@e` string formatting and DOM stale-attribute clearing
  (in a real browser) are out of unit scope (→VQ-19)
- [x] **D1-S7b1** ✅ 2026-07-11 The browser action-budget decision core
  (pure agent-core/browser-action-budget.ts):
  createBrowserActionBudget(max, requires a positive integer) ·
  recordBrowserAction · isBudgetExhausted (`used>=max`, boundary-exact —
  a cap of N allows exactly N and rejects N+1) · isBudgetNearCap
  (excludes exhausted) · browserActionsLabel (`actions_used N/M`) ·
  guardBrowserAction (exhausted→allowed:false+refusal, near→allowed:
  true+warning, else allowed:true). A behavior-sequence unit (guard→
  record ×3, then the 4th refused, label "3/3") · bidirectional
  boundary mutation-RED (`>=`→`>` gives 2 RED, near-cap gives 1 RED).
  Core-only, not yet wired (b2 wires it). The existing
  step-budget.ts is a token budget so it's a separate concern. Opus's
  independent evaluator PASSed (reproduced the mutations). ※this is the
  real fix behind fire 18's JUDGE-DRILL — the drill's forged off-by-one
  and declaration-only bugs are correctly rebutted here
- [x] **D1-S7b2** ✅ 2026-07-11 Wired b1's decision core. Created
  createBrowserActionTracker (agent-core, a mutable seam reusing b1's
  pure primitive: pre-decide→advance→post-label); buildBrowserTools
  creates a single shared instance (a per-task lifetime, once per run) →
  wired via a minimal structural seam BrowserActionGuard into
  click/type/fill (3 tools sharing BrowserActToolDeps). On exhaustion at
  the top of execute, fails closed (controller/resolveTarget never
  reached) + on success attaches actionsUsed `N/M` · a near-limit
  budgetWarning. Byte-identical when actionBudget isn't injected
  (existing 81 tests unchanged). resolveBrowserMaxActions default 30 ·
  `MUSE_BROWSER_MAX_ACTIONS` override. 4 tracker + 7 browser + 7 config
  tests · bidirectional mutation-RED (removing the guard → controller
  reached → RED; removing the exhaustion check → cap not honored → RED)
  · Opus's 8-axis review PASSed (fail-close · per-task lifetime ·
  arithmetic · byte-identical · semantics). @muse/browser stays
  independent of agent-core (structural typing). ※Siblings unwired
  (→backlog): upload/key(Enter)/open counting · timeout uses the
  controller's existing protocolTimeout
- [x] **D1-S7c** ✅ 2026-07-11 The dialog snapshot field already existed;
  the delta = making the disposition fail-close. registerDialogHandler
  previously auto-ACCEPTed every dialog (confirm OK · prompt submitted
  the text) — a fail-open path — now replaced with pure dialog-policy.ts:
  `decideDialogDisposition` (confirm/prompt/unknown→dismiss,
  alert/beforeunload→accept) + `planDialogResponse` (dismiss has no
  response) + `settleDialog` (a fake spy verifies real accept/dismiss
  calls). 12 tests · bidirectional mutation-RED (confirm→accept · a
  ternary flip) · Opus PASSed (fail-close direction · spy behavior · no
  accept fall-through · tightening-only invariant). controller.ts +
  puppeteer:425's stale doc updated alongside. ※Trade-off: an approved
  "click submit → page confirm" flow is currently left incomplete
  (fail-safe, surfaced in the snapshot)
- [x] **D1-S7d1** ✅ 2026-07-12 🔒 A deterministic page-content guard (pure
  page-content-guard.ts, self-contained · no @muse/recall dependency):
  defangPageText (escapes `</page>`/`<page>` break-out to full-width ·
  neutralizes `](` to block markdown image/link exfiltration ·
  an instruction-override regex `ignore/disregard/forget/override…
  previous/above…instructions/rules`→`[defanged-directive]`, bounded
  `{0,40}?` = ReDoS-safe) + wrapPageContent (`<page>…</page>`,
  escape-then-wrap order) + defangElementName. snapshotToJson wraps text ·
  elementsJson defangs names → covers every snapshot-returning tool
  (open/read/click/type/…) along the assembly path. 11 pure + 2 assembly
  tests (a fake controller with malicious text → the tool output is
  defanged, OUTCOME-scored) · bidirectional mutation-RED (removing the
  instruction rule → 6 RED, removing `](` → 4 RED) · clean prose stays
  byte-identical · Opus's threat-model review PASSed (boundary · media ·
  ReDoS · assembly path · honest positioning). The real e2e is d2
- [x] **D1-S7d2** ✅ 2026-07-12 🔒 A real detached-Chrome e2e
  (`scripts/eval-browser-injection.mjs`, `pnpm eval:browser-injection`,
  model-free, Chrome-only). Malicious HTML fixtures (ignore-above ·
  `![](exfil)` · an HTML-escaped `&lt;/page&gt;` boundary · an injection-
  anchor label) served over loopback HTTP → a real
  PuppeteerBrowserController (headless).open → confirmed the
  browser_open/read tool output is `<page>`-wrapped and defanged (9/9
  assertions, OUTCOME-scored). A real Chrome RUN (not skipped, a live
  PASS) · mutation-kill (defang made a no-op → 7/9 FAIL reproduced, then
  byte-identical restored). Opus PASSed → 2 findings fixed: the boundary
  fixture was originally tautological (the browser parses `<page>` as an
  empty tag, so innerText never reached it) → escaped it as `&lt;/page&gt;`
  to reach it literally, making the test genuine (re-verified: disabling
  the guard now flips the boundary count to 2, FAIL); removed a stray
  header slice-marker. **D1-S7 (browser reliability, L) fully complete
  (a+b1+b2+c+d1+d2)**

#### W3 — capability · UX
- [x] **D4-S4** ✅ 2026-07-12 📈 Strengthened file_edit deterministic
  repair (fs-write-tools.ts). Added 2 rungs to the existing ladder
  (exact→trailing-ws→trim→unicode-fold→escape\n\r\t→hint): (1)
  **indent-preserve** — when fuzzy matches by relaxing indentation
  (trim), re-base new_string onto the file's real indentation
  (reindentToFile: strips the old_string's indent prefix, attaches the
  file's indent, keeps blank lines, preserves nested relative indent) →
  fixes a bug where the 12B's wrong indentation contaminated the file
  (the exact/trailing-ws paths remain no-ops = byte-identical), (2)
  extended **escape-drift** — turned unescapeQuotes (`\"`/`\'`/`\\`) into
  a retry loop under the existing fail-close guard (adopted only on a
  unique match). 53 tests · bidirectional mutation-RED (disabling
  re-indent → indent contamination goes RED; removing unescapeQuotes →
  `\"` goes RED) · Opus PASSed (re-indent accuracy · conservatism ·
  fail-close · no wrong-place edits). eval:computer-task regression-
  STABLE (local-forced pass^3). ※the +10pp figure is a stochastic
  north-star (can't be confirmed per-fire). Unaddressed siblings =
  whitespace-collapse · first/last-line anchoring (backlog)
- [x] **D4-S1a** ✅ 2026-07-12 `muse mcp serve` write draft-first proxy.
  A `propose_action` MCP tool (mcp-serve-tools.ts, the 4th in
  buildMcpServeTools): an external client proposes an action + draft
  (+ arguments) → parked into the existing PendingApproval queue
  (reusing @muse/messaging's recordPendingApproval,
  `resolvePendingApprovalsFile` = the exact file `muse approvals` reads,
  zero new stores) (source "mcp-serve" · providerId "mcp" · risk write ·
  a 7-day TTL), returns "pending approval, review with `muse approvals`."
  **Zero execution path** (action/arguments are just parked data, never
  dispatched) — this is the edge's export of outbound-safety. A
  blank action/draft throws before staging (fail-close); a rejected stage
  never returns staged:true. No-external-effect contract: verified via a
  real recordPendingApproval temp round-trip + confirmed notesDir stays
  unchanged. 16 tests · bidirectional mutation-RED (removing staging →
  round-trip goes RED, removing blank validation → RED) · Opus's
  outbound-safety threat-model review PASSed (no execution path ·
  provenance distinction). raw-draft spoofing is a follow-up = VQ-20
- [x] **D4-S1b** ✅ 2026-07-12 📈 **An invariant that already held** (the
  fire-24 decomposition didn't know the battery existed).
  `apps/cli/scripts/verify-mcp-serve-grounding.mjs` shipped alongside
  `muse mcp serve`'s first commit `cc1fdde81` (2026-07-07), including
  battery + release-gate registration (`eval-self-improving.mjs:62`) →
  already counted in groundedSurfaces (currently 38). Verified the
  citation gate's real behavior against the real MCP wire (SDK Client ·
  initialize→tools/call · `buildMcpServeTools`'s production wiring):
  answerable → every citation resolves against a real seed (vpn.md), a
  non-corpus citation is blocked, grounded facts are included;
  unanswerable → refusal, zero fabrication. This fire re-ran it live 4/4
  PASS as proof. **Did not fake a duplicate battery to inflate the count**
  — the groundedSurfaces ratchet is exactly what blocks that
  (honesty). Opus's independent verification PASSed (registration ·
  behavior · live · no gap). Real "stdio round-trip" via a real
  subprocess and expanded reads = D4-S1c
- [x] **D4-S1c1** ✅ 2026-07-12 `muse mcp serve`'s calendar read tool.
  `calendar_read` (the 5th read tool in buildMcpServeTools, risk read):
  requires from/to as ISO strings → parsed independently → delegates to
  the existing `LocalCalendarProvider.listEvents({from,to})` (the
  provider owns the window filter), returns structured events
  (startsAt/endsAt ISO-serialized) + echoes from/to. **Structurally
  guaranteed pass-through of both bounds** (from and to are parsed
  independently and both delivered in one call — the upper bound can't
  structurally be dropped). Fail-close: missing/blank/unparseable
  (NaN)/`to<=from` → throws, the source is never called (spy-verified).
  McpServeDependencies got an injectable listCalendarEvents (defaults to
  LocalCalendarProvider). 19 tests · bidirectional mutation-RED
  (dropping `to:from` → both-bounds test goes RED; removing fail-close →
  RED) · Opus PASSed (pass-through · fail-close · OUTCOME · read-only).
  ※this is the real fix behind fire 26's JUDGE-DRILL (the drill's forged
  ignore-upper-bound bug is structurally rebutted here)
- [x] **D4-S1c2** ✅ 2026-07-12 `muse mcp serve`'s task-read tool.
  `tasks_read` (the 6th in buildMcpServeTools, risk read): a status enum
  (open by default/done/all) → delegates to the existing
  `LocalFileTasksProvider.list(status)`, returns structured tasks
  (createdAt/completedAt ISO). Status is **passed through** (not
  hardcoded, delivered exactly) · an invalid status → throws + the
  source is never called (fail-close, spy-verified). McpServeDependencies
  got an injectable listTasks. Added a 1-line barrel export of the
  `Task` type from domain-tools (exposing an existing type). 23 tests ·
  bidirectional mutation-RED (hardcoded "open"→pass-through goes RED,
  removing the guard→fail-close goes RED) · Opus PASSed (pass-through ·
  fail-close · OUTCOME · read-only · a benign barrel export)
- [x] **D4-S1c3** ✅ 2026-07-12 The real MCP stdio subprocess round-trip
  contract. `apps/cli/scripts/verify-mcp-stdio-contract.mjs`
  (`pnpm mcp:stdio-contract`, model-free): spawns a real `muse mcp serve`
  subprocess via StdioClientTransport(process.execPath+dist) →
  initialize→tools/list (confirms all 6 tools)→tools/call `tasks_read`
  round-trips 2 seeded tasks (count · title) + filters status
  open→1. **A real stdio wire, not InMemory** (confirmed via the
  "listening on stdio (6 tools)" stderr message). A real live RUN (not
  skipped, mutation-RED — seed 1 fewer task → count goes RED, data-
  sensitive), Opus independently re-ran it and PASSed. Sibling: fixed
  stale MCP_SERVE_INSTRUCTIONS ("3 tools"→the accurate 6 tools,
  propose_action=park-not-execute stated honestly). **D4-S1 (mcp serve
  extension) fully complete (a·b·c1·c2·c3)**
- [x] **D4-S2a** ✅ 2026-07-12 macOS photo search — honored the
  constraint ("never create a new tool") by extending the existing
  `mac_spotlight_search` with an `imagesOnly` flag (zero new tools). The
  mdfind ARGV stays unchanged (query is never embedded into a predicate =
  injection-safe); when imagesOnly, returned paths are **post-filtered
  in code** by image extension (jpg/png/heic/…) (the cap applies after
  filtering, total = the filtered count). The returned path is itself the
  export handle. Default behavior (flag absent) is byte-identical. 3
  tests · mutation-RED (removing the filter → .txt/.pdf leak goes RED) ·
  Opus's 8-axis review PASSed (injection-safe · filter accuracy ·
  total/cap ordering · no confusable tool). eval:tools timed out at
  6m40s (a heavy local test set, incomplete — but the change is additive,
  so the selection-regression risk is near-zero; judged by the
  deterministic gate instead). Photos.app's managed-library deep export
  is a separate design fork = VQ-21
- [x] **D4-S2b** ✅ 2026-07-12 macOS quit-app. Added a `quit_app` enum +
  `app` param to mac_system_set (optional, following the volume-value
  precedent). osascript `tell application "<escapeAppleScript(app)>" to
  quit` (reuses the shared escaper, backslash-first order prevents
  bypassing the escaper via escaping the escaper). A blank/whitespace
  app fails closed (osascript is never called). Zero new tools. 4 tests
  (happy path · escaped injection · blank fail-close · non-zero) ·
  bidirectional mutation-RED (removing the escaper → breakout goes RED,
  removing the guard → osascript still called goes RED) · Opus's
  threat-model review PASSed (breakout impossible to construct ·
  additionalProperties kept · no confusable tool)
- [x] **D4-S2c** ✅ 2026-07-12 macOS dark mode. Added parameterless
  `dark_mode_on`/`dark_mode_off` enum values to mac_system_set. A fixed
  osascript (`tell application "System Events" to tell appearance
  preferences to set dark mode to true/false`) — no user input, so zero
  injection surface, no escaping needed. on→true, off→false. Zero new
  tools. 3 tests (pin the captured script's true/false) · mutation-RED
  (a ternary flip kills the off-test) · Opus PASSed (mapping accuracy ·
  fixed script · no unrelated breakage)
- [x] **D4-S2d** ✅ 2026-07-12 macOS Bluetooth. Added
  `bluetooth_on`/`bluetooth_off` to mac_system_set (an exact mirror of
  the focus pattern: a named Shortcut invoked via `shortcuts run` argv —
  no clean Bluetooth CLI exists). `MUSE_BLUETOOTH_ON/OFF_SHORTCUT` env
  overrides (wired into actuator-tools) +
  bluetoothShortcutSetupMessage (missing→"Set Bluetooth" guidance) + a
  **fully wired doctor check** (the orchestrator finished the worker's
  unwired bluetoothShortcutsCheck — dead code — by wiring it into
  runLocalDoctor as a separate check next to focus, no impact on the
  focus test, 4 behavior tests). Zero new tools · docs:env. 5+4 tests ·
  mutation-RED (disabling name resolution → override/off tests go RED) ·
  Opus PASSed (correct name resolution · override precedence · setup
  message says Bluetooth not focus · shortcut argv, no shell injection ·
  doctor check fully wired · additionalProperties kept · docs:env).
  Brightness (value→Shortcut-input) is D4-S2d2
- [x] **D4-S2d2** ✅ 2026-07-12 macOS brightness. Added a `brightness`
  enum to mac_system_set — a **value-passing mechanism**, unlike the
  parameterless focus/bluetooth: `value` (0–100) is clamped+rounded →
  delivered to a named Shortcut ("Muse Set Brightness") via **stdin
  input** (`shortcuts run --input-path - --output-path -`, reusing the
  `mac_shortcut_run` precedent). `DEFAULT_BRIGHTNESS_SHORTCUT`+
  `MUSE_BRIGHTNESS_SHORTCUT` env override (wired into the actuator) +
  `brightnessShortcutSetupMessage` (missing→"Set Brightness" action +
  Shortcut Input guidance) + a **doctor check**
  (`brightnessShortcutCheck`, a single shortcut, mirroring
  focus/bluetooth, wired into runLocalDoctor). value stays under
  groundedArgs (blocks fabrication). Zero new tools · docs:env. 9+4
  tests · bidirectional mutation-RED (removing stdin input → value never
  delivered goes RED; removing the clamp → 150→"100" goes RED) · Opus
  PASSed (real verification of stdin value delivery · threat-model:
  numeric coercion + argv-not-shell · siblings unaffected ·
  envInventory). **The D4-S2 macOS batch fully complete (a·b·c·d·d2·e)**
- [x] **D4-S2e** ✅ 2026-07-12 Apple Contacts "write" (a draft-first
  gate). The `mac_contacts_write` tool (risk execute): name required +
  phone/email optional → Contacts.app `make new person`. **Enforces
  draft-first** (mirroring message-send's `sendMessageWithApproval`):
  `decision=await approvalGate(draft)` (a throw = deny) → `if(!approved)
  return{written:false}` **before osascript runs** — a write happens
  only on approval, action-log records refused/performed/failed. Deny/
  throw/timeout → **zero writes** (verified via a spy `called`=false).
  Field values go through escapeAppleScript (injection defense).
  `buildContactsApprovalGate` (non-interactive fail-close, mirroring
  messaging) + registered on the actuator + armed-lockstep. 6 tool tests
  + 3 CLI-gate parity tests · bidirectional mutation-RED (removing the
  gate → deny-write goes RED, removing the blank check → RED) ·
  eval:tools golden set of 3 (EN/KO save-contact · negative) · Opus's
  outbound-safety threat-model review PASSed. ※this is the real fix
  behind fire 34's JUDGE-DRILL (the drill's forged fail-open —
  ignoring decision.approved — is correctly rebutted here). **The D4-S2
  macOS batch complete (a·b·c·d·e), only brightness d2 remained**
- [x] **D7-S1a** ✅ 2026-07-12 Single-source slash-command registry —
  extracted chat-ink's local SLASH_COMMANDS (**27** `{cmd,desc}` entries)
  into `slash-command-registry.ts`'s single-entry-per-command shape
  (name · desc · category · aliases? · platforms), chat's SLASH_COMMANDS
  is now **derived** from `slashCommandsForPlatform("chat")` (removing
  the hardcoded array = single-sourced). desc stays byte-identical ·
  order preserved (the autocomplete menu is unchanged). Platforms:
  15 session-related entries are chat-only, 12 list/show entries are
  chat+cli. Proof of deduplication: 6 tests — `Set(names).size===len`
  uniqueness + name/alias collision scanning + platform gating (cli
  excludes chat-only) + matchSlashCommands still works against the
  derived list · bidirectional mutation-RED (dup → RED, disabling the
  gate → RED) · Opus PASSed (confirmed the old array removed ·
  byte-identical · real dedup). CLI-help reflection = D7-S1b
- [x] **D7-S1b** ✅ 2026-07-12 Reflected into CLI help — the registry's
  `cli` tags are **cross-checked against the real CLI command surface**
  (`COMMAND_STUBS`, the generated manifest that's the authoritative
  source for `muse --help`/completion) to lock out drift. Finding: 3 of
  the 12 cli-tagged entries — jobs · pref · reflect — **don't actually
  have a `muse <name>` command** (the CLI has `runs`/`job`,
  `remember`, `reflections`). Fix: added `CommandEntry.cliName?` →
  `reflect` = {cliName:"reflections"} kept, `jobs`·`pref` became
  chat-only (no clean 1:1 CLI command). `slashCommandsForPlatform("cli")`
  projects `cliName ?? name`. 4 drift-lock tests
  (`slash-command-registry.cli-drift.test.ts`): every cli-tagged entry
  asserted to actually exist in `COMMAND_STUBS` (checked against the
  real manifest, not a claim) + the projected command actually exists +
  reflect→reflections (never reflect) + chat's 27 unchanged.
  Bidirectional mutation-RED (removing reflect's cliName → RED,
  restoring jobs to cli → RED), independently reproduced. The chat
  surface stays unchanged (27). Opus PASSed (COMMAND_STUBS pins the
  commander tree · independently reproduced the mutations · confirmed
  the 3 fixes as facts). Non-blocking: the cli projection has no
  production consumer yet (honestly — drift-lock + tag correction is the
  delivered scope)

#### W4 — routing · KO
- [x] **D5-S1** ✅ 2026-07-12 Privacy-routing follow-ups (3 parts, pure
  additive · the existing 20 contracts unmodified). **(b)** codified the
  "no" decision for context-free tool use → cloud, deterministically:
  `PrivacyRequestInput.usesTools?` is a deterministic signal (the tier
  right after hasPersonalContext) → a tool-using request stays local
  regardless of text ("no personal-data conduit rides a cloud request");
  resolvePrivacyRoutedModel passes it through (proved with a route-flip
  unit). Defense-in-depth at the policy layer (a chat cloud turn is
  already structurally toolless via buildCloudTurnRequest — verified by
  Opus). **(c)** documented the personaPreamble nuance (persona = a
  fixed authored string, but a chosen relationship surfaces →
  keeps hasPersonalContext). **(d)** added KO colloquial possessive
  tokens `내꺼`/`제꺼` (꺼 = aspirated) + false-positive guards
  (`제거` removal · `내용` · `안내` keep 거≠꺼 → context-free, negative
  units); added a `muse setup cloud` privacy-routing guidance step
  (cloudPrivacyRoutingGuidance, wired into real action stdout · a
  behavioral capture test). 12 policy units + 3 cli setup units ·
  bidirectional mutation-RED (removing the usesTools branch → route-flip
  goes RED, removing 제꺼 → RED) · Opus PASSed (the 20 contracts
  unmodified · 꺼/거 discrimination · additive · fail-close preserved)
- [x] **D5-S2** ✅ 2026-07-12 `resolveAuxiliaryModel(task,env)` — a
  unified resolver (autoconfigure, pure additive). Tasks:
  compaction/vision/rewrite/judge/embedding-rescue. Precedence:
  `MUSE_AUX_<TASK>_MODEL` (the new generalized knob) > legacy per-task
  knobs (vision→MUSE_VISION_MODEL · embedding-rescue→
  MUSE_RECALL_EMBED_MODEL; compaction/rewrite/judge have no legacy knob)
  > sessionModel. **Local-first stays invariant (fail-close)**: if the
  selected model is cloud (`classifyProviderLocality`) and either
  `isPersonalContext` or `MUSE_LOCAL_ONLY` is set, override to
  sessionModel (`keptLocalForPrivacy:true`) — an aux knob can never
  escalate a personal task to the cloud; without personal context and
  without local-only, cloud is honored (route:cloud). 11 units
  (precedence · backward-compat · positive/negative local-only-gate
  cases) · bidirectional mutation-RED (removing the override → a
  personal-cloud case goes RED; removing the legacy fallback →
  MUSE_VISION_MODEL goes RED) · docs:env (5 MUSE_AUX_*_MODEL entries).
  Opus PASSed (verified gemini→cloud/ollama→local · negative case ·
  resolveVisionModel unchanged · envInventory:pass). **Not wired
  (resolver + unit scope only, call-site migration is a follow-up)** —
  matches the roadmap's acceptance exactly ("resolver · backward-compat
  · local-only-gate units")
- [x] **D5-S3** ✅ 2026-07-12 Wired canUseNativeTools' dead code into a
  real gate (VQ-2). @muse/model's `canUseNativeTools`
  (toolCalling∧structuredOutput, dead code) is now called in
  AgentRuntime's request path (prepareInvocation, right after modelTools)
  via `assertModelCanUseTools(selected, tools.length)` → if tools are
  exposed but the model lacks the capability, throws an **explicit
  `ModelToolCallingUnsupportedError`** (instead of silently ignoring
  them). Fail-OPEN by design (zero tools · unknown modelId · a
  listModels throw → no block, existing behavior preserved) · a
  per-instance `toolCapabilityCache` (avoids repeated listModels calls on
  the hot path). The full text protocol (a parser) is deferred to a
  separate L. gemma4 (toolCalling=true) is unaffected — codex/* are the
  real siblings. 6 behavioral tests (the run path: toolCalling=false ·
  structuredOutput=false → throw; capable → no throw; 0 tools · unknown ·
  listModels-throw → fail-open) · bidirectional mutation-RED (disabling
  the throw · toolCount=0) · Opus PASSed (real wiring · 4 fail-open
  branches verified · no hot-path regression · executeToolPlanGated
  untouched)
- [x] **D5-S4** ✅ 2026-07-12 Explicit fallback-chain resolver
  `resolveModelFallbackChain(env, isPersonalContext?)` (autoconfigure,
  pure additive · not yet wired). "No hidden retries" —
  `MUSE_MODEL_FALLBACKS` (comma-separated) triggers a sequential chain
  only when set; unset/blank →`{chain:[],dropped:[]}` (byte-identical,
  no fallback). **Each fallback gets a fail-close gate** (mirroring
  resolveAuxiliaryModel's local-first logic): a cloud fallback is dropped
  (with a reason) under `MUSE_LOCAL_ONLY` or `isPersonalContext`;
  context-free + non-local-only keeps it in the chain. Order preserved ·
  blank/empty entries filtered. 10 units (unset · chain-walk ·
  local-only gate · privacy gate · a negative control) ·
  bidirectional mutation-RED (removing the local-only drop → RED,
  removing the personal drop → RED) · docs:env (MUSE_MODEL_FALLBACKS) ·
  Opus PASSed (verified locality checks · negative control ·
  resolveAuxiliaryModel unchanged · fail-close). **Not wired** (the
  chain→ModelFallbackStrategy assembly + a "used fallback X" answer
  marker = follow-up; runtime-assembly wasn't touched because it's
  another loop's HANG blocker) — matches the roadmap's acceptance
  exactly ("chain-walk · gate units · byte-identical when unconfigured")
- [x] **D1-S6a** ✅ 2026-07-12 (a JUDGE-DRILL fire) The turn-scoped
  one-shot recovery **primitive** `OneShotRecoveryState` (agent-core).
  `claim(branch)` returns true only on the first claim, false afterward
  → `if(state.claim(x)){recover}` fires at most once per turn per branch
  (double retry is structurally impossible). A foundation for
  consolidating the scattered flags across recovery branches
  (repair/false-done-reprompt/reverify) into a single state object. 4
  units (guaranteed-once · a guarded body fires exactly once · distinct
  branches are independent · hasClaimed is a pure query) ·
  mutation-RED (removing the once-guard → 3 RED) · index export.
  ※JUDGE-DRILL: a deliberate defect (claim always returns true + a
  hollow test) was injected → independent Opus ④b correctly FAILed
  (spotted the inverted claim · the missing second-claim-false check) →
  rolled back → the real fix Opus PASSed. Actually wiring model-loop.ts's
  scattered flags is D1-S6b (a 1112-line central file touched by
  multiple loops → wired separately and carefully)
- [x] **D1-S6b** ✅ 2026-07-12 **Already-satisfied** (an independent
  Opus adversarial verdict of NO_TARGET). D1-S6's premise ("Muse's
  scattered individual recovery flags could double-fire") turned out to
  be false in the current code: all 5 turn-scoped recovery branches are
  already at-most-once (false-done via a single non-looping call to
  runResistingFalseDone · reverify via ReverifyNudgeTracker.nudged
  per-turn · post-compaction/ping-pong via a terminal return + a
  dedicated Guard class · attributed-repair via a single pass). Forcing
  a wiring would be a behavior-unchanged, artificial refactor (violating
  Jinan's "no unrelated refactors"). OneShotRecoveryState (D1-S6a)
  remains as a primitive **for future new recovery branches**. Zero code
  changes (honest — not count-inflation — confirmed already-satisfied by
  an independent evaluator)
- [x] **D2-S3** ✅ 2026-07-12 Extended de-obfuscation (VQ-3, 🔒). Added
  only the 2 genuinely-missing vectors to the DS-2 dangerous-command
  normalizer (NFKC + ANSI; `$IFS`/line-continuation/comment-strip/home-
  path already existed): `normalizeCommandNfkc` (full-width `ｒｍ`→`rm`
  via NFKC folding) + `stripAnsiEscapes` (strips ECMA-48 CSI `\x1b[…`,
  a ReDoS-safe char class) added to the **front** of the pipeline → a
  no-op on clean ASCII, so the existing DS-2 stays byte-identical
  (unmodified). Blocks full-width and ANSI-obfuscated bypass payloads.
  **Detection-only** (a pure transform — the executor still runs the
  original command; the folded copy never escapes its scope — Opus's
  threat-model review confirmed zero external callers). 9 new tests
  (full-width rm/sudo/target · ANSI injection · no-over-block on a
  quoted full-width character · helper units) + the existing 27
  unmodified and green (36/36) · bidirectional mutation-RED (removing
  NFKC → the full-width case goes RED, removing ANSI → RED) · Opus
  PASSed (independent bypass probing · quote-awareness preserved ·
  ReDoS-safe)
- [x] **D2-S4** ✅ 2026-07-12 Masked secrets in runner stdout→model
  output (VQ-4, 🔒). Wired `redactSecretsInText` (@muse/shared) into 2
  sinks on the subprocess-output→model path: (1) `runner.ts`'s
  run_command return of stdout/stderr, (2) a sibling audit found
  `muse-tools-skills.ts`'s skill-run return of stdout/stderr (both were
  leaking raw output to the model — the same vulnerability class).
  Truncation stays correct: capTruncated is computed against the
  **pre-redact length** (since redact changes the length and would
  otherwise corrupt the flag), then redaction runs. Benign performance on
  large output (256KB measured at 17.7ms < a 250ms budget,
  SECRET_PATTERNS is ReDoS-safe). 5 new tests (masking on runner/skills ·
  truncation preserved · no over-masking · large-output perf) ·
  bidirectional mutation-RED · Opus PASSed (both sinks wired · truncation
  verified · no over-masking · perf measured · confirmed no third
  sibling). ※referencing openclaw's secret-mask
- [x] **D2-S5** ✅ 2026-07-12 Encryption-at-rest for the calendar store
  (🔒, the backlog's "LAST encryption item"). The memory-encryption
  AES-256-GCM envelope, mirrored **in-package** into @muse/calendar
  (following the belief-provenance precedent — avoiding a heavy
  dependency on @muse/memory/@muse/stores, using only node:crypto/
  node:os). `calendar-encryption.ts` (an EncryptedCalendarEnvelope ·
  encrypt/decrypt/isEnvelope · reuses `MUSE_MEMORY_KEY` + a calendar
  per-host fallback · `MUSE_CALENDAR_ENCRYPT` opt-in). local-provider's
  readAll (auto-detects the envelope → decrypts, and a wrong-key throw
  **propagates outside the quarantine catch** = fail-closed, ciphertext
  is never destroyed) + writeAll (format-preserving: flag OR the
  existing encrypted state). 4 round-trip tests (envelope round-trip ·
  no plaintext leaked into raw bytes · a wrong key fails closed leaving
  the file unchanged · plaintext-by-default and format-preserving) ·
  bidirectional mutation-RED · docs:env (MUSE_CALENDAR_ENCRYPT). Opus
  PASSed (a random iv/salt per encryption · no plaintext leak · no
  destruction on fail-closed · byte-identical default · no heavy
  dependency · a single write path). D2-S5 completes the
  encryption-at-rest queue (the notes-index stays intentionally
  plaintext)
- [x] **D-KO-S1** ✅ 2026-07-12 ★ Extracted truncateUtf16Safe + wired the
  4 unsafe sites (VQ-6). Extracted `truncateErrorBody`'s (shared)
  lone-high-surrogate drop into `truncateUtf16Safe(text,cap)`+
  `sliceUtf16Safe(text,start,end)` (both boundaries: drops a leading
  lone-low and a trailing lone-high), truncateErrorBody now delegates to
  it (byte-identical). Wired 5 sites across 4 files: recall/history-search
  (206 head→truncateUtf16Safe, 213 middle-substring→sliceUtf16Safe) ·
  tools/tool-definition-helpers (108) · autoconfigure/knowledge-corpus
  (365) · voice/tts-truncate (19 window + 28 cut). Boundary units for
  Hangul (byte-identical, BMP)/emoji (astral lone-surrogate dropped)/ZWJ
  sequences + wiring behavioral tests (a TTS emoji straddling the
  boundary leaves no lone surrogate, Hangul stays byte-identical) ·
  bidirectional mutation-RED (removing the drop → emoji + the
  truncateErrorBody delegation proof both go RED) · 5 packages build
  green · Opus PASSed (both-boundary accuracy · byte-identical
  delegation · 4 sites wired · no over-change)

#### W5 — memory · closeout
- [x] **D-E1a** ✅ 2026-07-12 Tier-0 contamination filter (§8.5.2 d,
  VQ-21). Added `detectTier0Contamination(observed)`+
  `TIER0_CONTAMINATION_PATTERNS` (precise regexes for backend-error ·
  tool-failed · model-unsupported · timeout) to eval-harness.mjs →
  `runEvalSuite` now **excludes from the total** any battery case whose
  observed output leaks an infrastructure failure (avoids mistaking it
  for a behavior failure, tracked with an `excluded` counter). **Core
  invariant: no over-exclusion** — a genuine behavior failure with no
  infra marker still counts toward the total (blocks pass-rate
  inflation). An uncontaminated suite stays byte-identical (only adds
  `excluded`). 4 units (positive/precision-negative detection · 3-case
  exclusion in runEvalSuite · a byte-identical regression) ·
  bidirectional mutation-RED (disabling the detector · over-exclusion)
  · Opus PASSed (confirmed over-exclusion is SAFE · precision · zero
  hook/CI touch). The shared pre-push hook is unchanged (deferred to
  D-E1b). ★"The one real piece of work that restores verification
  discipline from A back to A+"
- [ ] **D-E1b** Extend the pre-push hook with the core eval:agent subset
  (mirroring precheck-grounding: 240s per battery + skip-if-Ollama-
  unreachable, VQ-12) + **prove the hook actually blocks** (inject a bad
  case → push is rejected). ⚠️shared push infrastructure (many active
  loops) — fire this carefully
- [ ] **D-E1c** Auto-confirm self-eval regression fail-close at commit
  time (a tracked count drop blocks). ~~Wire the deterministic CI
  portion~~ **N/A (Jinan doesn't run CI, confirmed 2026-07-12) — the CI
  part is dropped**; scope is local gates only (commit-hook · pre-push ·
  self-eval)
- [x] **D6-S1a** ✅ 2026-07-12 **Already existing** (recall-promotion.ts).
  The deterministic promotion score for sleep-consolidation already
  exists in `packages/memory/src/recall-promotion.ts`: `scoreRecallHit`
  (=hits×2^(-ageDays/halfLife), recency-weighted) +
  `selectPromotableMemories` (minHits · minScore · distinct-days · a
  **query-hash diversity gate minUniqueQueries** · cap · ACT-R). Built
  and wired by the self-improvement loop. ※honest correction: not
  knowing this on fire 49, I **duplicated it** by building
  `consolidation-score.ts` (scoreConsolidationCandidate) → **reverted**
  (an independent Opus audit ruled it REDUNDANT: the same primitive, an
  inert extra diversity multiplier). Lesson: always confirm an existing
  implementation via codegraph before building a new capability.
- [x] **D6-S1b** ✅ 2026-07-12 **Jinan's strategic decision: keep the
  status quo** (opt-in auto-promote). When the existing
  `MUSE_SLEEP_PROMOTE` opt-in daemon is on, `promoteRecalledMemories`
  auto-writes to persona; this conflicts with the roadmap's original
  draft-first design (never auto-write) → **Jinan's decision: opting in
  already constitutes consent, and a persona fact is reversible
  (forgettable), so keep the status quo**. I had built
  `consolidation-proposal.ts` on fire 50 (draft-first, unwired · inert ·
  duplicating D6-S1a's dependency) → **reverted** (an independent Opus
  audit surfaced the DESIGN-TENSION → Jinan chose to keep auto-write).
  Draft-first isn't being pursued.
- [x] **D6-S1c** ✅ 2026-07-12 **Already-satisfied.** An opt-in
  background consolidation daemon is already wired:
  `daemon-selflearn-ticks.ts`'s `makeMemoryConsolidateTick`→
  `planMemoryConsolidationTick` (a `shouldConsolidateMemory` brake) ·
  `MUSE_SELFLEARN_ENABLED`+`MUSE_SLEEP_PROMOTE` (opt-in persona
  auto-promote) · `memory-consolidate-tick.ts`. Aligns with loop-v2's
  Sleep daemon — owned by the self-improvement loop. Zero new code
  (honest).
- [ ] **D6-S2** The fuel pipeline (browsing auto-sync · recap wiring ·
  a weekly real-miss report) — attended
- [x] **D6-S3** ✅ 2026-07-12 Detected memory external-edit drift
  (VQ-7, integrity). `FileUserMemoryStore` now blocks an **external
  edit** (manual · patch tools · anything that bypasses the lock)
  happening between a lock-free read and a write via
  compare-and-swap: `read()` returns raw on-disk bytes →
  `write(data,encrypted,expected?)` re-reads the current on-disk state
  right before the atomic write, and if `currentRaw !== expected.raw`,
  it **snapshots `.bak.<ts>` (a copy, the original is never deleted) and
  throws `MemoryExternalEditError` to block the clobber** (no tmp-write/
  rename happens). Raw comparison means both plaintext and encrypted
  stores are covered. Wired into all 4 write paths: patch/deleteByUserId/
  encryptAtRest/decryptAtRest. **Invariant: an external edit is never
  clobbered or deleted** (protecting confided user memory). Byte-
  identical when `expected` is omitted (opt-in). 6 new + 47 existing
  unmodified, 53/53 · bidirectional mutation-RED (removing the drift
  check → clobber goes RED, removing `.bak` → the backup test goes RED)
  · Opus PASSed (never-clobber/destroy · no false positives · encrypted
  drift · byte-identical). Exactly matches VQ-7's target — the hermes
  memory_tool case
- [x] **D6-S4** ✅ 2026-07-12 Provenance tags + an autonomous-deletion-
  forbidden contract (integrity, TEST-ONLY). **Verify-first** (an
  independent Opus audit): a provenance origin tag
  (belief-provenance's `source:"auto"|"user"`) already exists, autonomous
  curation (fade) is already **non-destructive** (a rank-down sidecar ·
  episode-key only), and the only autonomous `store.forget` is scoped to
  Muse's own `recalled-*` synthetic namespace — real fact deletion is
  user-triggered only → **the invariant was already structurally
  established.** The gap = no end-to-end pin → built an
  **autonomous-deletion-forbidden mutation contract test** instead
  (building a new guard would have been dead-code duplication).
  Seeded a real fact (home_city=Seoul) into a real FileUserMemoryStore +
  drove fade+promote with strong recall-hits (non-vacuous, promotedCount>0
  · a fade sidecar entry recorded), then ran
  `runMemoryConsolidationTick` and verified the user's fact **survives
  unchanged**. Bidirectional mutation-RED (removing the recalled- scope
  guard from promoteRecalledMemories → the user's fact gets deleted →
  RED; an unconditional forget → RED) · production code unchanged ·
  Opus PASSed (non-vacuous · mutations flip · the correct invariant).
  ⚠️Discovered backlog item: normalizeMemoryKey folds `-→_`, so
  `recalled-N` is stored as `recalled_N`, and cleanup's
  `startsWith("recalled-")` doesn't match it → synthetic facts
  accumulate without bound (under-deletion, unrelated to user facts, a
  separate slice)
- [x] **D3-S3** ✅ 2026-07-12 Pinned the completion-event idle-drain
  contract + fixed a narrow gap (poll≠consumed). **Verify-first
  discovery**: chat-ink's tick only checks idle at the start of the
  tick (359), not right before inserting via setTurns after an async
  fetch (376 is only unmount-related) → a busy flip during the fetch
  could still insert mid-generation. Fix: extracted pure
  `selectDrainedProactiveTurns({idleAtConsume,...})` (returns [] when
  busy) → the tick re-checks `idleRef.current` after the awaits, gating
  at the consumption point, not the start. **No lost notifications**:
  moved seen-marking to after consumption (only when drained>0) →
  busy-deferred completions stay unseen → they resurface on the next
  idle poll (avoiding "marked but never shown"). 5 pure contract units
  (busy→[] · idle order grouped→jobs→nudges · not consumed) + a
  full-component integration test (fetch starts idle → busy flip → not
  shown while busy → resurfaces on the next poll — both verified) ·
  bidirectional mutation-RED (removing the idle-gate → busy-insert goes
  RED) · the existing 59 chat-ink tests unmodified · Opus PASSed
  (nothing inserted while busy · deferred events not lost ·
  non-vacuous). Covers hermes' async_delegation contract
- [x] **D3-S6** ✅ 2026-07-12 eval:orchestration ratchet — folded 2 of
  MAST's top failure modes + a live capacity-rejection case into a
  deterministic (no-Ollama) pass^3 (`scripts/verify-orchestration.mjs`).
  ①**step-repetition**: 3 workers run sequentially → each workerId
  fires exactly once (Set size===len===N, order matches). ②**unaware-
  of-termination**: `workerTimeoutMs:200` + a hung worker
  (`new Promise(()=>{})`) → the real `withDeadline` path explicitly
  terminates it with `failed`+"exceeded the 200ms deadline," the
  surviving worker completes, elapsed<5s (not an infinite wait). ③the
  D3-S4 capacity rejection: `maxWorkers:2`<3 workers →
  `selectWorkers` slices to run 2, the excess "three" is absent. All 3
  cases run under `MUSE_EVAL_REPEAT` (default 3) with all-pass gating
  (pass^3, a single failure → exit 1). The existing live model fan-in
  case (failure propagation + bounded + fan-in) is kept, and when
  Ollama is down the deterministic cases still run and gate (only the
  model case skips). Zero product-code changes (scores the existing
  orchestrator's real behavior). 3/3 non-vacuous mutation-RED (flipping
  each assertion's expectation → RED → restored) · Opus's independent
  review PASSed (the assertions match real behavior · pass^3 actually
  gates · skip semantics · clean comment policy). Finding: step-level
  status is only `completed|failed` (`timed-out` only exists in the
  opt-in SubAgentRunRegistry)
- [x] **D2-S7** ✅ 2026-07-12 Added 2 deterministic-guard categories to
  eval:adversarial (topology bypass · obfuscation) —
  `scripts/eval-adversarial.mjs` gained `TOPOLOGY_BYPASS` (3 blocked:
  a sudo-wrapper `sudo rm -rf /` · command substitution
  `$(echo rm) -rf ~` · a `;`-separator `rm -rf / ; echo done`; +2
  controls: a legit sudo command, rm inside quotes) and `OBFUSCATION`
  (2 blocked: `$IFS` word-splitting `rm${IFS}-rf${IFS}/` · an NFKC
  full-width homoglyph `ｒｍ -rf /`; +2 controls: a quoted echo, a
  stripped comment). Each case is scored via pure
  `classifyDangerousCommand(command).dangerous === expectBlocked`
  (`solveDangerousCommandCase`/`scoreDangerousCommandCase`) — **zero
  reliance on model refusal, Ollama-independent, no-skip** (always
  runs, unlike MUST_REFUSE/SANDBOX). Deterministic-guard battery
  grew 10→19 cases. 9/9 live pass (a shipped guard, byte-identical) ·
  mutation-RED confirmed (neutralizing collapseIfs →
  the `rm${IFS}` case goes RED → restored) · lint 0/0 · Opus's
  independent evaluator PASSed (behavioral verification · the controls
  disprove over-blocking · deterministic routing · the guard itself
  unmodified). self-eval's `adversarialCases` proxy only counts
  `prompt:`-keyed cases, so the new `command:`-keyed cases don't
  increment it (the same design as the existing SANDBOX/SECRET
  cases — not a regression). The guard code itself was untouched (only
  test coverage expanded)
- [x] **D7-S3** ✅ 2026-07-12 Smart-tail scroll (the web chat streaming
  view) — hermes' terminal-output pattern. Pure
  `shouldStickToBottom({scrollTop,scrollHeight,clientHeight},
  threshold=80)` (`apps/web/src/views/chat-autoscroll.ts`: within
  `threshold` of the bottom → tail, `<=` so the boundary is exact and
  overscroll still sticks) + wired into Chat.tsx
  (`stickToBottomRef` defaults true = jumps to the bottom on mount ·
  `onScroll` updates the ref from real geometry · the auto-scroll effect
  only runs while sticking = no yank while scrolled up). Existing
  behavior (auto-speak · composer · layout) unchanged. 7 pure units
  (near/far/threshold-boundary/overscroll/a custom threshold) ·
  2 mutation-RED variants (`<=`→`<` · a sign flip) · **real-browser
  measurement** (chrome-devtools, injected 40 tall messages:
  scrollHeight 3751 > client 514, a real overflow · bottom distance 0 →
  sticks true · scrolled up 300px → distance 300 → sticks false ·
  bounded within the viewport · zero horizontal blowout) · 8/8 Chat.test
  no regression · build+lint clean · Opus's independent review PASSed
  (formula correct · wiring accurate · sufficient real measurement ·
  non-vacuous). Meets the acceptance criteria (scroll-logic unit + a
  real-browser measurement)
- [ ] **D7-S4** Desktop responsiveness (an elapsed-time timer · status
  feedback) — attended

#### Deferred (confirm with Jinan before starting)
- [ ] **D-KO-S3** Centralizing the static i18n catalog (low priority ·
  refactor risk may exceed the payoff)
- [x] **Encryption key-migration backup** ✅ 2026-07-12
  `.plaintext-backup-<ts>` (§8.6.1). A sibling audit confirmed
  **calendar was the only remaining gap**: writeAll self-initiates a
  plaintext→encrypted transition via the `MUSE_CALENDAR_ENCRYPT` flag
  with no backup (memory's `encryptAtRest` and shared's
  `encryptFileAtRest` already back up; reflections/belief-provenance
  are format-preserving + go through a migration that already backs up
  = DONE). Fix: `local-provider.ts`'s writeAll captures
  `alreadyEncrypted` and, on the first
  `shouldEncrypt && !alreadyEncrypted` transition, calls
  `backupPlaintextBeforeEncrypt()` (snapshots the existing on-disk
  plaintext to `${file}.plaintext-backup-<ts>`, mode 0o600; a no-op if
  the file is missing or empty) — run **before** encrypting the write
  (no crash window). 4 tests (a transition backs up = recoverable
  plaintext readable without the key · 0o600 · a brand-new file gets no
  backup · already-encrypted gets no second backup) · 3/3 mutation-RED
  (disabling the helper → the backup test goes RED) · calendar 184/184
  no regression · Opus's independent review PASSed (ordering · only on
  the transition · recovery demonstrated · format-preserving/wrong-key
  unchanged · honest sibling audit). User-visible = CHANGELOG

### 10.4 Slice dependencies (confirm before starting)

- **D2-S7** (expanding adversarial) takes its cases from D2-S1d · S2 · S3
  → do it **after** those slices.
- **D3-S6** (the orchestration ratchet) comes after D3-S1/S2/S4 are done.
- **D-E1**(a) assumes `eval:agent` already exists (✓ it does) + other
  eval slices supply cases.
- **D4-S1** (exposing grounded recall) assumes the `streamGroundedRecall`
  seam exists (✓ it does).
- **D2-S6b** · **D6-S3** · **D-KO-S1** · **D5-S3** reuse existing symbols
  → confirm the wiring point in §11's VQ list first.
- Everything else is mutually independent (order within a wave doesn't
  matter).

---

## 11. 🔍 Additional verification needed — a living queue (append-only)

> **Rule**: resolve the matching VQ before starting a slice (via
> codegraph/Read/measurement). Once resolved, mark `[x]` + a one-line
> conclusion. **New items that need verification keep getting appended to
> the bottom of this section** (with date + source). Once this queue is
> empty, the plan's uncertainty is zero — until then, a slice with an open
> VQ starts from that VQ.

### Start-blocking VQ (required before the matching slice) — ★ 2026-07-11 all resolved (Fable via codegraph/read)
- [x] **VQ-1** (D3-S2) ✅ **Wiring point = `model-loop.ts`'s streaming
  loop**: the `tool-call-started`/`tool-call-finished` event handlers
  (:802) + calling `heartbeat(runId)` from the text-delta path.
  `runToolBatch` (:263)/`for await` (:787) are where a single run's tool
  progress lives. orchestrator:347 stays as-is.
- [x] **VQ-2** (D5-S3) ⚠ **The text protocol itself doesn't exist**:
  `canUseNativeTools` (index.ts:292) is defined but has 0 callers (dead
  code), and **the text tool parser/fallback also isn't implemented**
  (no parseTextToolCall etc.). → the contract ("fall back to a text
  protocol if unavailable") has neither a gate nor a fallback. **Slice
  re-scoped**: since gemma4 has toolCalling=true, real usage is
  unaffected → D5-S3 = gate it with an **explicit "this model can't call
  tools" error** (removing silent failure); the full text protocol is
  deferred to a separate L (only needed for a BYO non-tool-calling
  cloud model).
- [x] **VQ-3** (D2-S3) ✅ **The real gap = NFKC + ANSI-strip only**:
  `dangerous-command.ts` already has comment-strip · `$IFS` · line
  continuation · echo substitution, and **home-path (`~`/`$HOME`) is
  already built into the RULES patterns** (:65/74/83). → D2-S3 = add
  **only** NFKC Unicode normalization + ANSI escape stripping.
- [x] **VQ-4** (D2-S4) ✅ **Confirmed unwired**: `runner.ts:88-100` only
  caps stdout/stderr and **returns them without redaction** (:97-100,
  the returned object is raw). D2-S4 is justified — pass through
  redactSecretsInText right before returning.
- [x] **VQ-5** (D4-S3) ✅ **Scope confirmed**: `--with-tools` branches
  into its own actuators + agentRuntime in commands-ask.ts:609/635/726;
  only the plain path uses `streamGroundedRecall` (:49). → add a
  **prepare-only variant** to the seam (returns context + allowed
  citations + the gate, without generating), then have --with-tools use
  it and drive its own agentRuntime. Stays M-sized (streaming events
  aren't needed — only the gate is shared).
- [x] **VQ-6** (D-KO-S1) ✅ **Confirmed unsafe — TTS is the 4th site**:
  `tts-truncate.ts:19/28` does a raw `slice(0, maxChars)`/
  `slice(0, cut)` — zero surrogate guarding. → D-KO-S1's wiring target
  is **4 sites** (history-search:206/213 · tool-def-helpers:108 ·
  knowledge-corpus:365 + **tts-truncate:19/28**).
- [x] **VQ-7** (D6-S3) ✅ **Cross-process locking already exists → slice
  re-scoped**: the memory store already uses `withFileLock`
  (cross-process `.lock`, encrypted-file.ts:113) on every write
  (memory-user-store-file.ts:248/260/383/402
  `serializeWrite→withFileLock`). → clobbering **among Muse's own
  writers is already prevented**. The real gap in drift-detection is
  **external edits** (manual editing · patch tools · another tool
  appending outside the lock) only. D6-S3 = round-trip hash detection
  for external modifications (defense-in-depth, exactly the hermes
  memory_tool case). Scope narrowed, justification held.
- [x] **VQ-8** (D3-S7) ✅ **Portable method**: `ps -o lstart= -p <pid>`
  works on both macOS (BSD) and Linux (GNU) → portable. Capture at spawn
  time and store on the record, re-query and compare before
  kill/reconcile. Avoids depending on `/proc` (Linux-only). A mismatch
  blocks the kill.
- [x] **VQ-9** (D2-S1) ✅ **Allowlist grounds confirmed**: legitimate
  commands legitimately use paths outside cwd = `$TMPDIR`
  (`/var/folders/.../T/`) · `~/Library/pnpm/store` · `~/.npm` ·
  `~/.cache` (read/write) + `~/.gitconfig` · `~/.config/git` (read).
  The seatbelt profile's allowlist = **the cwd subtree + $TMPDIR (rw) +
  the caches/config above (caches rw, config ro)**. This list avoids
  false positives for git/pnpm/tsc/node.
- [x] **VQ-10** (D1-S7) ✅ **Confirmed no e2e harness existed → wrote a
  new one** (D1-S7d2, 2026-07-12): no browser e2e file existed
  (grep 0 hits) → wrote `scripts/eval-browser-injection.mjs`
  (`pnpm eval:browser-injection`, model-free, a real headless Chrome)
  to prove the D1-S7d1 injection guard along the assembly path (9/9
  live PASS).
- [x] **VQ-12** (D-E1) ✅ **Time budget confirmed available**:
  precheck-grounding already allows 240s per battery +
  skip-on-timeout (REPEAT default 1). A push already tolerates several
  minutes → add the eval:agent subset under the **same per-battery 240s
  + skip guard**, keeping total push time under ~5 minutes. Headroom
  exists.

### Quantify-and-confirm VQ (fill in the numbers behind acceptance criteria)
- [ ] **VQ-Q1** (D2-S4) Confirm the measured threshold behind "secret
  masking is performance-benign" — the added redaction latency ceiling
  (ms) on large stdout (a 10MB cap).
- [ ] **VQ-Q2** (D1-S1) Recalibrate the ping-pong window/thresholds
  (window 20 · warn 6 · block 10) against real gemma4 traces — measure
  whether the proposed values false-positive on legitimate repetition
  (a retry loop).
- [ ] **VQ-Q3** (D6-S1) Sleep-consolidation promotion score thresholds
  (half-life · min-recall) — whether they're meaningful given Muse's
  current `~/.muse` fuel starvation (tied to fuel VQ-7).

### Low-value / conditional VQ (decide necessity first)
- [ ] **VQ-11** Orphaned-pipe draining (X-3) — whether Muse's
  detached-node spawn is actually vulnerable to a grandchild-pipe hang.
  If vulnerable, promote to a slice; otherwise discard.
- [ ] **VQ-13** Connection-epoch invalidation (web console/SSE) —
  whether a stale-result-applied-after-reconnect race actually exists
  in Muse's web console. Only turn into a slice if real.
- [ ] **VQ-14** Request coalescing (concurrent web-console fetches) —
  concurrency is low for a single user; judge after measuring.

### Strategy-level open questions (Jinan decides)
- [ ] **VQ-S1** Restoring the eval scorecard from A→A+ hinges entirely on
  D-E1 — since GitHub CI has no local Ollama, "live gate" is
  structurally confined to the local pre-push hook. Whether to attach
  self-hosted Ollama to a cloud runner (cost/complexity) vs. accept that
  a local hook is enough.
- [ ] **VQ-S2** D6 (sleep-consolidation) has zero real effect without
  fuel (real `~/.muse` data) — should securing fuel (D6-S2, real usage)
  come before D6-S1?
- [ ] **VQ-S3** W4 is overloaded (9 slices) — split into W4a (routing,
  D5) / W4b (security closeout, D2-S3/S4/S5+KO)?
- [ ] **VQ-21** (D4-S2a) A deep query into Photos.app's **managed
  library** (albums/faces/dates) + a real export conflicts with the
  "never create a new tool" constraint — mdfind can't see inside a
  managed library well (the `.photoslibrary` package). AppleScript
  (`tell application "Photos"`) or osxphotos would be needed, but (a)
  whether to add a new mac tool vs. extend an existing one and (b) the
  Photos automation permission (TCC) model are both open. D4-S2a
  shipped the constraint-compliant version (mac_spotlight_search
  imagesOnly = image-file search + path export); a deep library export
  needs a decision from Jinan (a tool-home fork). — 2026-07-12,
  designed during D4-S2a
- [ ] **VQ-20** (D4-S1a) An action parked via MCP's `propose_action` has
  its `draft`/`arguments` fully controlled by an external (untrusted)
  client — `muse approvals` shows `draft` raw to the human, a spoofing
  surface (e.g., a draft that looks harmless but whose arguments desync
  from it). Parking itself has no effect, and approval is a human
  confirmation with fail-close, so this doesn't violate the current
  contract, but draft sanitization (control bytes, hidden Unicode) + a
  draft↔arguments consistency display should follow. Not a new
  regression — the same surface as the existing CLI-write staging path.
  — 2026-07-12, found by D4-S1a's Opus evaluator
- [ ] **VQ-19** (D1-S7a/D1-S7d) A browser ref numeric-index collision —
  refs are reassigned 0-based on every snapshot, and the
  `data-muse-ref` DOM attribute isn't cleared from the previous
  snapshot. If a new element inherits the old index `3` (or a stale
  attribute lingers), the old `3` could now resolve to a *different*
  element. D1-S7a's tool-boundary guard only blocks a ref absent from
  the current snapshot, not one that's still alive but pointing at a
  *different* element — needs clearing stale `data-muse-ref` at the
  start of `captureSnapshot` (or a generation-scoped ref), verified via
  a real-browser e2e (adjacent to D1-S7d). Confirm whether Muse is
  actually vulnerable to this before turning it into a slice. —
  2026-07-11, found by D1-S7a's Opus evaluator
- [ ] **VQ-18** (D2-S6b) The CLI fs-write staging entry only holds
  `{path,action}` (FsWriteDraft has no content field), so
  `muse approvals approve` can't replay it — completing a full-args
  replay round-trip for the CLI, like the channel path has, would
  require threading the original write args through the gate (currently
  it's only a reviewable worklist item). — 2026-07-11, found during
  D2-S6b
- [ ] **VQ-17** (D-E1/eval infra) `eval:computer-task` (and possibly
  other "LOCAL OLLAMA ONLY" batteries?) doesn't force a local model, so
  with an ambient `GEMINI_API_KEY` present, `resolveDefaultModel` routes
  to the cloud → dies on a Gemini API error (a policy violation). The
  eval script should explicitly force `MUSE_LOCAL_ONLY=true` or
  `MUSE_DEFAULT_MODEL=ollama/…`. This conflicts with testing.md's
  "cloud APIs never used" contract. — 2026-07-11, found during D1-S1
- [ ] **VQ-16** (D2-S2b) No auto-approve seam exists — the complete
  form of classifyCommandTopology's downgrade (turning auto-approve
  into explicit approval) has no auto-approve path to trigger it in
  practice: trust.json (`muse trust`) isn't wired at runtime, and
  it's unconfirmed whether channel paths (Telegram/Slack) execute
  unattended. Once trust.json is wired, or a channel auto-approves on
  execute, it must consult the topology check and fail-closed on
  un-analyzable commands. — 2026-07-11, found during D2-S2b
- [ ] **VQ-15** (D2-S2a/b) Shell-wrapper bypass — `classifyCommandTopology`
  only makes a determination when `command` is directly a shell
  (sh/bash/…), so `sudo sh -c '$(x)'` · `env X=y bash -c '…'` go
  undetected because the program resolves through sudo/env
  (analyzable=true). DS-2 already handles sudo/env wrappers via
  CMD_START — when wiring D2-S2b, decide whether to strip the wrapper
  and resolve the real program, or promote this to a separate sibling
  slice. — 2026-07-11, found by D2-S2a's Opus evaluator

<!-- Add new VQs above this line as "- [ ] **VQ-N** (slice) content — discovery date/source" -->
