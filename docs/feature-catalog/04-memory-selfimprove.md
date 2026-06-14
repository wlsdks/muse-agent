# Catalog 04 — Memory (long/short-term) + Self-improvement / Learning (Whetstone + Playbook)

Domain owner packages: `packages/memory`, `packages/skills`, `packages/agent-specs`
Self-improvement engine code also lives in `packages/agent-core` (playbook, reflection-synthesis, correction-distiller, preference-inference) and `packages/mcp` (playbook store, reflections store, weakness ledger, swarm quarantine).
CLI base used for verification: `node /Users/jinan/side-project/Muse/apps/cli/dist/index.js <cmd> --help </dev/null`

Status legend: ✅ ran live · 🧪 tests-as-evidence · ⬜ code-only · ⚠ broken/suspicious · 🧠 needs local model

---

## A. USER MEMORY (long-term facts/preferences) — `muse memory`, `muse remember`, `muse forget`

### A1. User-memory store (facts / preferences / recent topics)
- **What:** Persistent personal model at `~/.muse/user-memory.json`. Three store impls share `UserMemoryStore` iface: `FileUserMemoryStore` (default CLI), `KyselyUserMemoryStore` (server/PG), `InMemoryUserMemoryStore` (tests). Keys normalized; values sanitized. Facts vs preferences are separate namespaces.
- **Status:** ✅ `memory show` printed real data (`user_name: 진안`, `dog_name: 보리`, `language_preference: 한국어 응답`). Note: emitted "API not reachable — reading memory from the local store" (graceful local fallback, not an error). 🧪 37 test files in `packages/memory/test`.
- **Evidence:** `packages/memory/src/memory-user-store.ts`, `memory-user-store-file.ts`, `index.ts:319 (UserMemoryStore)`.

### A2. `muse remember <text>` — NL fact extraction (manual)
- **What:** Free-text statement → LLM extracts facts/prefs/vetoes/goals into user-memory.json. `--json` emits `{written:[],skipped:[]}`. Persona-slot aware (`--persona work/home`).
- **Status:** 🧠 needs local model (LLM extraction). 🧪 `commands-remember.test.ts`. Help ✅ captured.

### A3. `muse memory` subcommands (read/write)
- **`show`** ✅ ran — facts/prefs/recent topics.
- **`search <query>`** ⬜ search facts/prefs by key/value.
- **`history [key]`** ⬜ — how a fact changed over time + when (supersession history).
- **`why <key>`** ⬜🧠 — provenance: when + which conversation a fact was learned from. Backed by `belief-provenance-store.ts` (`BeliefProvenance`/`BeliefProvenanceStore`).
- **`set <kind> <key> <value>`** ⬜ — no-LLM direct write path.
- **`diff`** ⬜ — added/changed/removed since a baseline snapshot.
- **`forget <key>` / `clear`** ⬜ (mutating; not run). `clear` wipes everything; `forget` one key. `InMemoryUserMemoryStore.forget` supports namespace-scoped delete (`kind` limits to fact OR preference so an auto-FACT retraction can't wipe a same-key PREFERENCE).
- **`consolidate`** ⬜🧠 — "Sleep consolidation": promotes salient recalled memories, down-ranks fading ones in recall (NEVER deletes). See E2.
- **`promote`** ⬜🧠 — "Dreaming": promote most recall-useful past sessions into always-on persona. See E1. (`--min-hits 3`, `--max 3`).
- **`encrypt` / `decrypt` / `encryption-status`** — AES-256-GCM at rest; `MUSE_MEMORY_KEY` or per-host key.
- **Status:** ✅ `memory encryption-status` → "🔓 plaintext". `memory-encryption.ts` is the primitive.
- **Evidence:** `apps/cli/src/commands-memory.ts`, `commands-memory.test.ts`.

### A4. `muse forget [key]`
- **What:** Remove a fact/pref by key, or `--all --force` wipes the entire persona. Top-level alias.
- **Status:** ⬜ (mutating, not run). Help ✅.

### A5. Auto fact-extraction hook (the long-term-memory engine)
- **What:** After each chat turn, an LLM hook auto-extracts facts/preferences/vetoes/goals and upserts them. **Default ON** (`MUSE_USER_MEMORY_AUTO_EXTRACT=true`). `dropModelAssertedValues` strips model-invented values; `pickAutoExtractSystemPrompt` selects a prompt; `readSkipAutoExtract` allows per-run opt-out. Sanitizer in `memory-auto-extract-sanitize.ts`, JSON parse in `memory-extract-json.ts`.
- **Status:** ⬜🧠 (runs inside chat). Wiring confirmed: `packages/autoconfigure/src/index.ts:822` gates the hook on the flag (default true) + a model provider.
- **Evidence:** `packages/memory/src/memory-auto-extract.ts` (exports `createUserMemoryAutoExtractHook`, `pickAutoExtractSystemPrompt`, `dropModelAssertedValues`, `readSkipAutoExtract`).

---

## B. TYPED USER MODEL + confidence/half-life decay — `muse user model`

### B1. Typed user model (preference / schedule / veto / goal slots)
- **What:** Richer than flat memory. Four typed slot kinds (`UserPreferenceSlot`, `UserScheduleSlot`, `UserVetoSlot`, `UserGoalSlot`), each with optional `confidence` (0..1) + `updatedAt`. Replace-by-id semantics. Persona-injected (capped `maxPerKind=5`, `maxChars=1000`).
- **Status:** ✅ `user model list` → "empty" (works). ✅ `user model` (no subcmd) shows subcommand list.
- **Evidence:** `packages/memory/src/user-model-slots.ts`, `apps/cli/src/commands-user.ts`.

### B2. Confidence + exponential half-life decay (REAL, verified math)
- **What:** `effectiveConfidence(confidence, updatedAt, now, halfLifeDays)` = `confidence · 2^(-ageDays/halfLifeDays)`. **Half-life default 30 days** (`DEFAULT_CONFIDENCE_HALF_LIFE_DAYS`). KEY DISTINCTION: a slot with NO stored confidence is an ASSERTED fact (user typed it) → never decays, returns 1. A slot WITH a confidence is INFERRED (auto-extractor) → fades. During persona composition, inferred slots below `confidenceFloor` are dropped; **asserted slots and vetoes (safety constraints) are NEVER decay-dropped**.
- **Status:** ⬜ code verified verbatim. 🧪 `packages/memory/test/user-model-decay.test.ts`, `user-model-slots.test.ts`.

### B3. `user model review` — re-confirm faded inferred preferences
- **What:** `selectReconfirmableSlots` returns inferred slots whose effective confidence decayed below `DEFAULT_RECONFIRM_BELOW=0.35` (most-faded first). `--confirm <id>` re-asserts (clears confidence → trusted again, resets updatedAt); `--reject <id>` drops it. Closes the loop on stale guesses.
- **Status:** ⬜ (mutating). Backed by `runUserModelReview` / `UserModelReviewResult`.

### B4. `user model infer` — preference inference from corrections (behavior-inferred)
- **What:** Detects corrections in last chat (`detectCorrections`), infers the stable preference behind each (`inferPreferenceFromCorrection`), upserts into typed model. **Supersede-by-category** (id `pref-<category>` replaces same-category) + **cross-category belief revision** (`findSupersededPreferenceId` drops a stale different-category belief that the new one contradicts, arXiv:2606.09483). **Held-out support gate** (SkillOpt) drops a trait the correction doesn't semantically support. **Confidence calibration** (`calibrateConfidence`, DINCO arXiv:2509.25532) — over-confident one-shot traits decay sooner.
- **Status:** ⬜🧠 needs model. Shared helper `inferSessionPreferences` used by both CLI and session-end auto-infer.
- **Evidence:** `apps/cli/src/commands-user.ts:41`, `packages/agent-core/src/preference-inference.ts`, `correction-distiller.ts`.

---

## C. EPISODIC MEMORY (past sessions) — `muse episode`

### C1. Episode store + capture
- **What:** Self-captured prior-session summaries auto-written at REPL exit when `MUSE_EPISODIC_MEMORY_ENABLED=true` (**opt-in / default OFF**). Surfaced in persona / recall.
- **Status:** ✅ `episode list` → "No episodes captured yet" (works; nothing captured because flag off by default). Flag confirmed in `apps/cli/.../commands-episode` + `chat-end-session`.

### C2. Episode subcommands
- **`list` / `show <id>` / `remove <id>` / `clear --yes`** — read + drop (clear needs `--yes`). ✅ `list` ran.
- **`search <query>`** — substring default, or `--llm-judge` LLM-relevance. 🧠 for `--llm-judge`.
- **`themes`** ✅ ran → "No topic recurs across 2+ sessions yet." Topics recurring across ≥2 sessions (`--min-count 2`). A deterministic reflection over episodic memory.
- **`consolidate`** ⬜ — find near-dup sessions (`--threshold 0.85`); `--apply` archives the redundant, keeps the richer, writes `.bak` first. (Mutating — not run.)
- **`reindex`** ⬜ — embed every summary into `~/.muse/episodes-index.json` (semantic recall).
- **`encrypt`/`decrypt`/`encryption-status`** — at-rest AES-256-GCM.
- **Evidence:** `apps/cli/src/commands-episode.ts`, `commands-episode.test.ts`, `commands-episode-encryption.test.ts`.

---

## D. REFLECTION / DREAMING (grounded cross-session insights) — `muse reflections`

### D1. Grounded reflection synthesis
- **What:** `synthesizeReflections` (in `packages/agent-core/src/reflection-synthesis.ts`) LLM-synthesizes higher-level insights about the user across episodes. Requires `minSupport` (≥2) recurring items. Each insight **cites the source episode ids** and goes through **RGV re-verification** — a one-shot local judge re-checks each insight against the TEXT of its cited episodes and drops a confabulated "dream" that cites real-but-unrelated sources. Near-duplicate insights collapsed via embeddings; cross-tick NOOP dedup (Mem0) drops insights semantically equal to already-stored ones. Fail-soft (background nicety, never blocking).
- **Status:** ✅ `reflections` (read) → "No reflections yet…" (works). 🧠 `reflections refresh` needs configured local model. 🧪 `commands-reflections.test.ts`.
- **Evidence:** `apps/cli/src/commands-reflections.ts` (`runReflectionPass`, `renderReflections` shows followable `[date] summary` grounding lines).

### D2. Daemon "dreaming" (auto reflection)
- **What:** `shouldRunReflection` + `DEFAULT_REFLECTION_INTERVAL_MS = 6h` — daemon runs the same reflection pass a few times a day when idle. Insights then feed `muse ask` answers as context ("dreaming closes the loop").
- **Status:** ⬜ code-only (daemon path).

---

## E. MEMORY CONSOLIDATION + PROMOTION (recall-promotion engine)

### E1. Dreaming = recall-usefulness promotion — `muse memory promote`
- **What:** `scoreRecallHit` = `hits · 2^(-ageDays/halfLifeDays)`, **half-life 21 days** (`recall-promotion.ts` `DEFAULT_HALF_LIFE_DAYS=21`). `selectPromotableMemories` picks the most recall-useful (frequent+recent) past memories and promotes them into the always-on persona; re-runs SWAP the top set (idempotent, doesn't bloat). Also ACT-R style `actrActivation` / `recallActivation`.
- **Status:** ⬜ code verified. 🧪 has memory tests.

### E2. Sleep consolidation — `muse memory consolidate`
- **What:** Promotes salient recalled memories, down-ranks fading ones in recall — **never deletes**. `selectForgettable` mirrors promote (lowest score). `shouldConsolidateMemory` schedules it.
- **Status:** ⬜🧠. `--json` plan available.

### E3. Salient fact extraction (short-term → structured)
- **What:** `extractSalientFacts` pulls structured facts from conversation; `mergeSalientFacts`, `renderKeyDetailsBlock`/`parseKeyDetailsBlock`/`stripKeyDetailsBlock` — a Key-Details block embedded in summaries.
- **Evidence:** `packages/memory/src/salient-facts.ts`, `recall-promotion.ts`.

### E4. Context/short-term memory primitives (packages/memory)
- **What:** token trimming (`memory-token-trim.ts`, `token-estimator.ts`), tool-output trimming (`memory-tool-output-trim.ts`, `tool-output-importance.ts`), conversation summaries (`memory-conversation-summary-store.ts`), message importance (`message-importance.ts`), pinned entities (`pinned-entities.ts`), context references (`context-reference-store.ts`), task store (`memory-task-store.ts`).
- **Status:** ⬜ code-only (internal). 🧪 covered in the 37 memory test files.

---

## F. PATTERN DETECTION (proactive — borderline domain, included) — `muse pattern`

### F1. Pattern detectors
- **What:** `detectTimeOfDayPatterns` (weekday×hour-band×path-family clusters, confidence = distinctDays/observedWeeks, floor 0.4) + weekly-task patterns. Stable sha256 ids. `pattern-signals.ts`, `pattern-orchestration.ts`.
- **Subcommands:** `list` (all clusters), `shifts` (regime change onset), `upcoming` (allostatic — recurring needs landing within a lead window), `lapsed` (CUSUM change-point — habits you've STOPPED), `fired` (cooldown sidecar `~/.muse/patterns-fired.json`), `reset` (wipe cooldown), `dismiss <id>` (learned avoidance, survives reset), `dismissed` (list).
- **Status:** ✅ `pattern dismissed` → "No dismissed patterns"; ✅ `pattern fired` → "No patterns have fired yet". 🧪 `commands-pattern.test.ts`.
- **Note:** This straddles the Proactivity domain; included here because `learned`/dismissal is learned-avoidance.

---

## G. SELF-AUTHORED SKILLS — `muse skills`

### G1. Skill registry/loader/parser (`packages/skills`)
- **What:** `skill-registry.ts` (`SkillRegistry`/`InMemorySkillRegistry`, `buildSkillRegistry`, `buildSkillCatalogProvider`), `skill-loader.ts` (`createSkillRuntime`, `createSkillListTool`/`createSkillReadTool`), `skill-parser.ts` (`parseSkillFile`), `skill-contract.ts` (`Skill`). Skills dir `~/.muse/skills`.
- **Status:** ✅ `skills list` → "No skills yet"; ✅ `skills path`. 🧪 4 test files (`skill-parser`, `skill-registry`, `authored-skill-store`, `skill-loader`).

### G2. Self-authoring + quarantine (the differentiation)
- **What:** `muse skills author` distills reusable skills from procedural corrections in last chat. Authored skills are **execute-gated (no run permission until a human promotes)** AND every body runs `scanSkillBodyForRisks` — high-precision regex patterns for prompt-injection ("ignore previous instructions", "reveal system prompt"), dangerous-shell (`rm -rf`, `curl|sh`, fork-bomb), embedded-secret (PEM private key, `AKIA…` AWS key). A flagged body is **quarantined, not activated** (2nd-line defense against poisoned corrections persisting as injection). Pattern attributed to OpenClaw skill-workshop (MIT), deterministic reimplementation.
- **Status:** ✅ `skills authored` → "No authored skills yet"; ✅ `skills archived` → "No archived". 🧠 `skills author` needs model. 🧪 `authored-skill-store.test.ts`, `commands-skills.test.ts`.
- **Evidence:** `packages/skills/src/authored-skill-store.ts` (`scanSkillBodyForRisks`, `SKILL_RISK_PATTERNS`, `DEFAULT_MAX_AUTHORED_SKILLS=30`, `PATCH_SIMILARITY_THRESHOLD=0.6`).

### G3. Skill lifecycle: reward / curate / consolidate / archive / restore
- **`reward <name> [amount]`** (`--down` to penalise) — RL-style reinforcement of authored-skill reward.
- **`curate`** — archive skills idle > `--max-idle-days 90` (NEVER deletes).
- **`consolidate`** — merge overlapping skills into "umbrella" skills (preview default, `--apply` archives originals). Skips dissimilar ones.
- **`archived` / `restore <name>`** — list archived + roll back curate/consolidate. ✅ `archived` ran.
- **Status:** mostly ⬜ (mutating). `restore`/`archived` are read-ish; `archived` ✅.

---

## H. PLAYBOOK (learned strategies, ACE/ReasoningBank + RL reward/decay) — `muse playbook`

### H1. Playbook store + RL-style reward/decay
- **What:** Learned strategies the agent applies from past feedback. Store `packages/mcp/src/personal-playbook-store.ts`; ranking/reward logic `packages/agent-core/src/playbook.ts`. Reward model = **net `reinforcements − decays`**. **Asymmetric credit floors**: a DECAY needs a STRONGER cue↔strategy match (0.62) than a reinforce — wrong decay of a grounded/manual strategy is costlier than a missed reinforce (cost-sensitive). Evidence-damped reward (Memp arXiv:2508.06433), SSGM temporal-decay governance (arXiv:2603.11768). Retrieval ranks by reward but a relevance hit still beats a fully-decayed −5 reward.
- **Status:** ✅ `playbook list` → "(no learned strategies yet)". ✅ `playbook encryption-status` → plaintext. 🧪 `commands-playbook.test.ts`, `playbook-consolidate.test.ts`, `commands-ask-playbook.test.ts`.

### H2. Playbook subcommands
- **`add <text>`** (`--tag`) — record a strategy. ⬜
- **`list` / `remove <id>`** — ✅ list ran.
- **`undo <id>`** — remove AND teach not to re-learn (the idle distiller won't bring it back). ⬜
- **`pause` / `resume`** — pause/resume ALL background self-learning (distill + correction enqueue). ⬜
- **`reward <id> [amount]`** (`--down`) — reinforce/penalise. ⬜
- **`consolidate`** — merge near-dup strategies (preview default, `--apply`). ⬜🧠
- **`distill`** — learn strategies from corrections in last chat (ReasoningBank). ⬜🧠
- **`encrypt`/`decrypt`/`encryption-status`** — at-rest.

### H3. Correction-decay (SUBTRACTIVE self-correction, P43-1)
- **What:** `classifyCorrectionContradiction` (`correction-distiller.ts:372`) — LLM polarity gate: does a correction genuinely CONTRADICT a stored strategy? Decays ONLY a genuinely-contradicted INJECTED strategy; a contradiction it can't confirm → "do nothing" (no decay). `detectCorrections` (negative signal) + a positive-reward detector (a user "got it right" turn). A false CONTRADICT decays a user's learned strategy, so detection is deliberately conservative.
- **Status:** ⬜🧠 code verified. Suppressed lessons sidecar `~/.muse/suppressed-lessons.json` (`resolveSuppressedLessonsFile`).

### H4. `muse learned` — learning dashboard
- **What:** Shows trusted/avoided strategies & skills + recent reflections.
- **Status:** ✅ ran → reveals **learning is OFF by default**: prints `MUSE_PLAYBOOK_DISTILL_ENABLED=true MUSE_SKILL_AUTHOR_ENABLED=true` to enable. IMPORTANT product fact: self-learning (distill + author) is opt-in.
- **Evidence:** `commands-learned.test.ts`.

---

## I. WHETSTONE (self-weakness detection — the 3rd pillar) — `muse doctor --weaknesses`

### I1. Weakness ledger
- **What:** Records what Muse noticed it couldn't answer / didn't actually do. Ledger `~/.muse/weaknesses.json` (`resolveWeaknessesFile`), store `packages/mcp/src/weakness-ledger.ts`, recall side `packages/recall/src/weakness.ts`. README principle 3 = Whetstone.
- **Status:** ✅ **`doctor --weaknesses` ran and showed REAL data** — "🪨 Whetstone — what I've noticed I'm weak at (13 topics)" with counts + last-seen dates (e.g. "할일 — couldn't answer (24×, last 2026-06-06)"). README's `muse doctor --weaknesses` claim **VERIFIED**.
- **Evidence:** `apps/cli/src/commands-doctor-checks.ts`, `commands-doctor.test.ts`.

### I2. `doctor --run-outcomes`
- **What:** Grounding-failure RATE over recent `.muse/runs` run-logs (the denominator the ledger lacks) + top failing topics. `commands-doctor-outcomes.ts`, `run-outcome-analysis.ts`.
- **Status:** ⬜ (not run; read-only, safe but skipped for time).

---

## J. PERSONA / TRUST / SPECS (supporting surfaces)

### J1. `muse persona` — system-prompt persona templates
- **What:** Built-in (`default`, `jarvis`, `casual`, `professional`) + user-defined. `list`/`add`/`use`/`remove`/`show`.
- **Status:** ✅ `persona list` → active: jarvis (+4 builtins); ✅ `persona show` → JARVIS butler preamble. 🧪 `commands-persona.test.ts`.

### J2. `muse trust` — per-user tool trust calibration (skills trust)
- **What:** Per-user trusted/blocked tool lists. `grant`/`revoke`/`block`/`unblock`/`list`. Trusted tool runs without per-call confirmation; blocked tool never runs.
- **Status:** ✅ `trust list` → "trusted (0) / blocked (0)" for jinan. 🧪 `commands-trust.test.ts`. Store is `withFileMutationQueue` atomic (same primitive as swarm quarantine).

### J3. `muse specs` — agent specs (`packages/agent-specs`)
- **What:** Registered agent specs; `list`/`get <name>`/`resolve <text>`.
- **Status:** ⚠ **`specs` is genuinely server-only** — requires the API server at `:3030` with NO local fallback. Verified 2026-06-14: `specs list --local` → `error: unknown option '--local'` (the generic error message advertises `--local`, but `specs` does not implement it). Unlike every other domain command (memory/playbook/user/etc. all fall back to the local store), `specs` cannot run standalone. 🧪 `packages/agent-specs/test/agent-specs.test.ts`, `default-agent-specs.test.ts`. (Tracked as INDEX B3 — follow-up: add `--local` or document the server requirement.)

### J4. Swarm quarantine (inbound know-how is inert) — `packages/mcp/src/swarm-quarantine-store.ts`
- **What:** Skills/strategies/council-utterances received over A2A land INERT (`pending`) until a human promotes. Never auto-run. Kinds restricted to `skill|strategy|council-utterance` (never executable/tool). FIFO-trimmed (max 1000), atomic writes, tolerant reads. Surfaced via `muse swarm` (outside this domain's command list but is the multi-agent half of self-improvement safety).
- **Status:** ⬜ code verified.

---

## CROSS-CHECK / DOC DRIFT

**README.md** — ACCURATE. Principle 3 Whetstone + `muse doctor --weaknesses` **verified live**. §"How it improves on a fixed local model: Playbook + Whetstone" matches code (reward/decay). Research-attribution table (lines 449-452: SkillOpt, Hermes, OpenClaw, Generative Agents) matches the code's cited papers. Auto-extract default-true documented (line 413).

**docs/FEATURES.md** — ACCURATE and detailed (Korean). Lines 107-110 cover reflection/themes/consolidation/dreaming; 158-159 cover self-authored skills (quarantine, curate, consolidate, archive/restore) + playbook consolidate. All claims map to real code.

**docs/SYSTEM-MAP.md** — ACCURATE. §5 "기억 (장·단기)" covers auto fact-learning (default-on), recall, consolidation, dreaming-promotion. §9 "자기개선" covers playbook consolidate + RL-style reward/decay (applies to skills too). §11 covers swarm quarantine. No stale claims found.

### Drift / suspicious items (small):
1. **`muse specs` is genuinely server-only** (verified): requires API server at :3030, `--local` is `unknown option`, no auto-fallback (every other domain command falls back to the local store). Follow-up: add `--local` or document the server requirement. (⚠ only surface in this domain that doesn't work standalone. = INDEX B3.)
2. **Self-learning is OFF by default** — `muse learned` advertises `MUSE_PLAYBOOK_DISTILL_ENABLED` + `MUSE_SKILL_AUTHOR_ENABLED` must be set. Docs describe the capabilities as present (correct) but a reader could assume they're auto-on; FEATURES.md §158 does note "기본 꺼짐" for background consolidation. Minor — make the opt-in nature of distill/author explicit if not already.
3. **Episodic memory is OFF by default** (`MUSE_EPISODIC_MEMORY_ENABLED=true` required). This is the substrate reflections/themes/dreaming feed on — so a fresh install shows "no episodes / no reflections / no themes" until enabled. Help text documents the flag; just flagging the dependency chain (episodes → themes/reflections/consolidate) for docs accuracy.

### NOT broken (clarifications):
- "API not reachable — reading memory from the local store" on `memory show` is the intended graceful local fallback, not a bug.
- Many commands are 🧠 needs-model (remember, infer, distill, author, reflections refresh, consolidate, llm-judge search) — expected; they require local Ollama, not broken.

## Verification coverage summary
- **Ran live (✅):** memory show, memory encryption-status, playbook encryption-status, user model list, user model (root), persona list, persona show, trust list, pattern dismissed, pattern fired, learned, skills list/authored/archived, playbook list, reflections (read), episode list, episode themes, **doctor --weaknesses (13 real topics)**.
- **Tests as evidence (🧪):** 37 in packages/memory/test, 4 in packages/skills/test, 2 in packages/agent-specs/test, 12 CLI command test files (memory/user/playbook/skills/pattern/reflections/learned/episode/persona/trust/remember + episode-encryption).
- **Code verified verbatim (⬜):** half-life decay math, recall-promotion scoring (21d), skill risk-scan patterns, playbook asymmetric reward/decay, correction-contradiction polarity gate, preference inference w/ belief revision + held-out gate, swarm quarantine.
