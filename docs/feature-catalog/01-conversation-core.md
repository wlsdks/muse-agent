# Catalog 01 — Conversation & Agent-Core Runtime + Models

Domain: `packages/agent-core`, `packages/model`, `packages/prompts`, and CLI commands
`chat`, `ask`, `demo`, `runs`, `spec`, `tui`, `context`, `runtime`.

Verification legend: ✅ verified by running · 🧪 has tests · ⬜ code-only · ⚠️ broken/suspicious

Built CLI: `node /Users/jinan/side-project/Muse/apps/cli/dist/index.js` (`--version` → `0.0.0`).
Test-suite health (run this session):
- `@muse/agent-core` — **184 test files / 2434 tests pass** (`pnpm --filter @muse/agent-core test`)
- `@muse/model` — **17 files / 299 pass + 5 skipped** (`pnpm --filter @muse/model test`)
- `@muse/prompts` — **5 files / 38 pass** (`pnpm --filter @muse/prompts test`)

---

## A. Agent-Core Runtime (`packages/agent-core`)

### A1. AgentRuntime — the shared model-agnostic runtime
- **What it does:** Single runtime class (`agent-runtime.ts:171`) that server, CLI, and every surface share. Threads model provider/registry, hook registry, guards, output guards, response filters, tool registry/executor + exposure policy, checkpoint/history stores, circuit breaker, fallback strategy, retry, context-window trimming, metrics/tracer, token-usage sink, user/session/task memory providers, active/ambient context providers, exemplar retriever, prompt-layer registry, veto-avoidance.
- **Status:** 🧪 ⬜ — extensively unit-tested (2434 agent-core tests); not directly runnable as a CLI surface (driven via `chat --local`/`ask`).
- **Evidence:** `codegraph_context`; `packages/agent-core/src/agent-runtime.ts`.

### A2. Two agent loops — ReAct (default) + plan-execute
- **What it does:** `model-loop.ts` (`executeModelLoop`, `executeStreamingModelLoop`, `capToolOutput`) is the ReAct loop; `plan-execute-loop.ts` (`executePlanExecuteLoop`, `streamPlanExecute`) is the plan-then-execute loop. Selected by `chat --mode <react|plan_execute>` (default `react`).
- **Status:** 🧪 ✅ — exposed by `muse chat --mode`; covered by agent-core tests.
- **Evidence:** `node apps/cli/dist/index.js chat --help` shows `--mode <mode>  Agent mode: 'react' (default) or 'plan_execute'`; `program.ts:306`; `plan-execute-loop.ts:83/97`, `model-loop.ts:127/263/491`.

### A3. Guard pipeline (3 pipelines around the model call)
- **What it does:** `guard-pipeline.ts` — `evaluateGuards` (pre-exec input guards, **fail-closed**: exception/`allowed:false` → `GuardBlockedError`, short-circuits), `applyResponseFilters` (post-exec transforms, **fail-open**), `applyOutputGuards` (post-exec content guards, **fail-closed**, allow/modify/reject). Matches the CLAUDE.md "guards fail-close, hooks fail-open" non-negotiable.
- **Status:** 🧪 ⬜ — header doc + types confirmed; tested via agent-core suite.
- **Evidence:** `head packages/agent-core/src/guard-pipeline.ts`; `errors.ts` (`GuardBlockedError`, `OutputGuardBlockedError`).

### A4. Hook registry + orchestration
- **What it does:** `HookRegistry` (`hook-registry.ts:3`) keyed Map of `HookStage`; `hook-orchestration.ts` invokes lifecycle hooks `beforeStart` / `beforeTool` / `afterTool` / `afterComplete` / `onError` (typed overloads in `agent-runtime.ts:901-916`). Hook traces persisted via `HookTraceStore`.
- **Status:** 🧪 — `hook-registry.test.ts` present.
- **Evidence:** `codegraph_context`; `hook-registry.ts`.

### A5. Tool loop & tool hygiene (rich sub-system)
- **What it does:** Deterministic one-shot tool-calling support: argument grounding (`tool-argument-grounding.ts` — drops args whose tokens aren't in the input, prevents 8B fabricating optional actuator args), tool-call dedup (`tool-call-deduplicator.ts`), batch-conflict detection (`tool-batch-conflict.ts`), tool-failure-streak breaker (`tool-failure-streak.ts`), tool-loop-progress (`tool-loop-progress.ts`), tool exemplars (`tool-exemplars.ts`), tool filter / relevance (`tool-filter.ts`), tool-output-evidence (`tool-output-evidence.ts`), step/prompt budget enforcement (`step-budget.ts`, `prompt-budget.ts`), `maxToolCalls` / `maxToolOutputChars` / `maxRunWallclockMs` caps.
- **Status:** 🧪 — many `.test.ts` (tool-exemplars, prompt-budget-enforce, etc.).
- **Evidence:** file listing under `packages/agent-core/src/`.

### A6. Clarify directive (underspecified-request handling)
- **What it does:** `clarify-directive.ts` — `detectUnderspecifiedRequest(text)` flags ambiguous asks; `applyClarifyDirective(context)` injects a clarify instruction so the agent asks rather than guesses (ties into outbound-safety recipient-resolution rule).
- **Status:** 🧪 — covered in the agent-core run (clarify tests pass).
- **Evidence:** `clarify-directive.ts:32/58`.

### A7. Context transforms / trimming / active+ambient context
- **What it does:** `context-transforms.ts` conversation trimming (`ConversationTrimOptions`), `active-context.ts` / `ambient-context.ts` / `inbox-context.ts` / `attachment-context.ts` / `skills-context.ts` snapshot providers, `checkpoint.ts` (CheckpointStore), `lifecycle.ts`.
- **Status:** ⬜ 🧪 — code present, agent-core suite covers it.

### A8. Grounding / honesty machinery (the FUNCTIONAL edge, lives in this package)
- **What it does:** A large deterministic grounding + citation gate cluster: `grounding-eval.ts`, `claim-support-screen.ts`, `citation-precision.ts`/`citation-recall.ts`/`citation-sanitiser.ts`, `sentence-groundedness.ts`, `hedge-overclaim.ts`, `numeric-mismatch.ts`, `polarity-mismatch.ts`, `contradiction-detection`, `untrusted-sentences.ts`, `conformal.ts`, `token-confidence.ts`, `sdt-criterion.ts`, `verifier-vote.ts`, `reverify-format.ts`, `attributed-repair.ts`, `best-grounded-draft.ts`, `grounded-not-true.test.ts`. Plus self-improvement: `playbook.ts`/`playbook-merge.ts`, `skill-merge.ts`/`skill-review.ts`, `pattern-suggestion.ts`, `preference-inference.ts`, `correction-distiller.ts`, `reflection-synthesis.ts`, `council.ts`/`quorum.ts`, `episodic-recall.ts`, `associative-recall.ts`, `two-hop-recall.ts`, `plan-cache.ts`. (NOTE: a few of these names — `contradiction-detection`, `reverify-format`, `best-grounded-draft`, `two-hop-recall` — are *test-file* basenames; their implementations live inside `knowledge-recall.ts` as `detectEvidenceContradictions` / `parseGroundingReverifyJson`+`REVERIFY_RESPONSE_FORMAT` / `selectBestGroundedDraft` / `rankKnowledgeChunksWithHop`.)
- **Status:** 🧪 — dense test coverage (these are the grounding/self-improving batteries).
- **Note:** Cross-references the recall/grounding domain — listed here as the agent-core home, not duplicated as its own catalog.

---

## B. Models (`packages/model`)

### B1. ModelProvider contract + registry
- **What it does:** `index.ts` defines `ModelProvider` (`id`, `listModels`, `generate`, `stream`), `ModelInfo`/`ModelCapabilities` (streaming, toolCalling, structuredOutput, vision, reasoning, promptCaching, maxInput/OutputTokens, local, cost, latencyProfile), `ModelRequest`/`ModelResponse`/`ModelEvent` (text-delta, reasoning-delta, tool-call, tool-call-started/finished, citations, done, error), `ModelProviderRegistry` (provider resolution by id/prefix, `selectModel` by capability criteria), `parseModelName` (`provider/model` split), `knownModelPrefixes`.
- **Status:** 🧪 — `provider-base.test.ts`, `provider-wire.test.ts`.
- **Evidence:** `codegraph_explore`; `packages/model/src/index.ts`.

### B2. OpenAI-compatible base + the adapter family
- **What it does:** `OpenAICompatibleProvider` (`provider-base.ts:71`) is the shared base; `OpenAIProvider`, `OpenRouterProvider`, `OllamaProvider` all extend it. Adapters present: `adapter-openai.ts`, `adapter-anthropic.ts`, `adapter-gemini.ts`, `adapter-ollama.ts`, `adapter-diagnostic.ts` (no-network deterministic provider for `smoke:broad`/tests). Provider files: `provider-openai.ts`/`provider-openai-parse.ts`, `provider-anthropic.ts`, `provider-gemini.ts`, `provider-shared.ts`, `provider-wire.ts`.
- **Required families per architecture.md** (OpenAI Responses, OpenAI-compatible chat/completions, Anthropic, Gemini, OpenRouter, Ollama, LM Studio/OAI-compat, custom): all present. LM Studio reuses the OpenAI-compatible path.
- **Status:** 🧪 — 17 model test files pass.
- **Evidence:** dir listing; `provider-base.ts`.

### B3. Retry classification (deterministic, no hidden retry magic)
- **What it does:** `isRetryableHttpStatus` (`provider-base.ts:65`) — 408/429/5xx retryable; 4xx (400/401/403/404/422) fail-fast. `ModelProviderError.retryable` is the single source of truth. Connection-level fetch failures classified retryable with an actionable "is the local model server running?" hint for loopback URLs.
- **Status:** 🧪 — `provider-base.test.ts`.

### B4. Ollama native adapter (local-model specifics)
- **What it does:** `adapter-ollama.ts` routes `generate`/`stream` through Ollama's **native `/api/chat`** (not `/v1`), uses native `tool_calls`, keeps `think: false` so reasoning models don't stream/leak thoughts (the only way to suppress reasoning), surfaces native `thinking` channel as `reasoning` when present, supports image input. `MUSE_MODEL_TRACE=1` debug trace.
- **Status:** 🧪 — covered; matches `tool-calling.md` rule 6.
- **Evidence:** `head adapter-ollama.ts`; grep of `/api/chat`, `tool_calls`, `think`, `images`.

### B5. Local-only policy (fail-close cloud-egress gate)
- **What it does:** `local-only-policy.ts` — `classifyProviderLocality(providerId, effectiveBaseUrl)` → `local|cloud`. Local-inference ids `{ollama, lmstudio, diagnostic}` are local only on loopback; cloud ids `{openai, anthropic, gemini, openrouter}` always cloud; openai-compatible/unknown local only on loopback. `isLoopbackUrl` handles bare host, ::1, 127/8, 0.0.0.0, `.localhost`. `LocalOnlyViolationError` (code `LOCAL_ONLY_VIOLATION`) thrown loudly at runtime assembly under `MUSE_LOCAL_ONLY` (default on).
- **Status:** 🧪 — `local-only-policy.test.ts`.

### B6. Default-model resolution (local-first)
- **What it does:** `resolveDefaultModel` (autoconfigure pkg) — explicit `MUSE_MODEL`/`MUSE_DEFAULT_MODEL` wins; else if local-only (default true) → `LOCAL_FIRST_DEFAULT_MODEL = "ollama/gemma4:12b"`, **ignoring ambient cloud keys**; only under `MUSE_LOCAL_ONLY=false` does `inferDefaultModelFromCredentials` apply (GEMINI→`gemini-2.0-flash`, OPENAI→`gpt-4o-mini`, ANTHROPIC→`claude-haiku-4-5-20251001`, OPENROUTER→`gemini-2.0-flash-001`, OLLAMA_BASE_URL→`llama3.2`, then OAI-compat presets).
- **Status:** 🧪 ✅ — value confirmed in built dist + src.
- **Evidence:** `LOCAL_FIRST_DEFAULT_MODEL = "ollama/gemma4:12b"` at `autoconfigure-model-provider.ts:42`.
- **NOTE:** lives in `packages/autoconfigure` (adjacent to this domain) but is the model-selection brain — recorded here for completeness.

### B7. OpenAI-compatible presets (Groq/DeepSeek/Together/Mistral/Moonshot/Cerebras)
- **What it does:** `openai-compat-presets.ts` — 6 presets, each `{baseUrl, defaultModel, envKey}`: groq (`GROQ_API_KEY`, llama-3.3-70b-versatile), deepseek (deepseek-chat), together (Llama-3.3-70B-Instruct-Turbo), mistral (mistral-small-latest), moonshot (moonshot-v1-8k), cerebras (llama-3.3-70b).
- **Status:** ⬜ — config data, surfaced in README.
- **Evidence:** `packages/autoconfigure/src/openai-compat-presets.ts:23-29` (this file lives in `autoconfigure`, not `model`).

### B8. Web-search policy
- **What it does:** `web-search-policy.ts` — gates native `web_search` per request; surfaced by `chat --no-web-search` and `ask --notes-only`.
- **Status:** 🧪 — `web-search-policy.test.ts`.

---

## C. Prompts (`packages/prompts`)
- **What it does:** `index.ts` + `prompt-text.ts` — prompt assembly: `PromptBuildInput`/`PromptContextPacket` (basePrompt, exemplarContext, response format/schema, retrieved context, tool results, requester/user/session/task memory context, provider stable-prefix / dynamic-suffix for prompt caching, cache boundary). Helpers `cleanBlock`/`compactLines`/`compactSections`. `ResponseFormat = text|json|yaml`.
- **Status:** 🧪 — 5 files / 38 tests pass.

---

## D. CLI commands (this domain)

### D1. `muse chat` ✅ (help) / ⬜ (live run not exercised — would call Ollama)
- Run a chat request through the Muse API (or `--local` for the shared runtime). Flags: `--local`, `--model`, `--mode <react|plan_execute>` (default react), `--stream` (remote SSE), `--json`, `--no-log`, `--no-web-search`, `--no-tools` (skip tool registry, ~15× faster on small models), `-c/--continue` (cross-invocation memory via `~/.muse/last-chat.jsonl`, --local only), `--reset`, `-i/--interactive` (REPL, --local only), `--image <path>` (local vision via gemma4, --local only).
- **Evidence:** `chat --help`. Implementation across `chat-repl.ts`, `chat-history.ts`, `chat-grounding.ts`, `program.ts:301`.

### D2. `muse ask` ✅ (help) — RAG-grounded one-shot
- Ask with notes as context; reads piped stdin. Large flag surface: `--user`, `--persona`, `--model`, `--top <k>` (default 3), `--embed-model` (default **nomic-embed-text-v2-moe**), `--no-auto-reindex`, grounding-source toggles `--no-tasks/--no-calendar/--calendar-days/--no-reminders/--no-contacts/--no-actions`, opt-in sources `--shell/--git/--file/--url/--clipboard/--scope`, `--json`, `--with-tools` (+`--actuators`), `--notes-only`, `--connect`, `--tiered` (fast/heavy via MUSE_FAST_MODEL/MUSE_HEAVY_MODEL), `--repair`, `--best-of <n>`, `--why`, `--verify-claims`, vision `--image/--extract/--to-calendar/--auto/--apply`.
- **Status:** 🧪 — `commands-ask*.test.ts` (cite-as, onboarding, etc.).
- **Evidence:** `ask --help` (full capture).

### D3. `muse demo` ✅ — runs (degrades gracefully without Ollama)
- Bundled sample-corpus walkthrough (cited answer + honest refusal, zero setup). Shells out to `muse ask` against `apps/cli/sample-corpus/`, so it uses the resolved default model (gemma4:12b), NOT a hardcoded model.
- **Status:** ✅ — ran with `</dev/null`; without Ollama, embeddings fail per-file but the command exits 0 and prints structured output (no crash). 🧪 `commands-demo.test.ts`.
- **Evidence:** `timeout 8 ... demo` → "Muse demo — answering from a bundled sample corpus" + graceful "embedding failed — kept nothing".

### D4. `muse runs` ✅ (list/show/delete) — needs API
- `runs list [--limit <n>]` (default 20, max 1000), `runs show <run-id>`, `runs delete [run-id] [--before <iso>]`.
- **Status:** ✅ help verified; `runs list` correctly errors with an actionable message when API unreachable ("Re-run with --local … or start the Muse API server").
- **Evidence:** `runs list --help`, `runs list` (API-not-reachable message).

### D5. `muse spec` ✅ — fully runnable
- Prints the fixed runtime stack. `--json` → `{agentCore:"model-agnostic", cli:"typescript + ink", database:"postgresql + kysely", runner:"rust", server:"fastify"}`. Text → "Muse stack: TypeScript, Node.js, Fastify, PostgreSQL, Kysely, Ink, Rust runner".
- **Status:** ✅ — ran both forms. Defined inline in `program.ts:253`.

### D6. `muse tui` ⬜ — Ink status UI (not run; blocking)
- `--local` toggles local vs remote mode display. Model from `cliConfig.defaultModel`.
- **Status:** ⬜ — not executed (interactive). `program.ts:274`, `tui.ts`.

### D7. `muse context` ⬜ — API-only
- `GET /api/active-context` — prints the Phase-1 active-context snapshot the agent sees. `--json`, `--user`, `--session`. No `--local` fallback → API required.
- **Status:** ✅ help verified; errors cleanly without API.

### D8. `muse runtime` ⬜ — API-only
- `GET /api/muse/runtime` — capabilities, locales, tool risk counts, default model.
- **Status:** ✅ help verified; errors cleanly without API.

---

## E. DOC DRIFT (cross-check vs README / README.ko / FEATURES.md / SYSTEM-MAP.md)

1. ✅ FIXED 2026-06-14 — README demo comment now reads "runs on your local default model, gemma4:12b via Ollama" (was the stale "auto-picks any local Ollama Qwen 2.5"). The demo shells out to `muse ask` which uses `LOCAL_FIRST_DEFAULT_MODEL = "ollama/gemma4:12b"`.

2. **Not a README drift (correction):** the `qwen2.5:7b` "15× faster" line lives ONLY in the `--no-tools` flag DESCRIPTION (`program.ts:313`, shown in `--help`) — it is NOT in README. It's a benchmark anecdote in a flag description, not a default-model claim. Optional: refresh the example model.

3. **README ~188 "Anthropic (capability declared but unwired)" is correct in context** — it refers specifically to Anthropic **vision/image input** being unwired, NOT the adapter. `adapter-anthropic.ts`/`provider-anthropic.ts` exist and ANTHROPIC_API_KEY maps to `claude-haiku-4-5-20251001`; the adapter IS wired. Only image attachments aren't serialized on the Anthropic path (see README's vision-provider-limited note).

4. **FEATURES.md / SYSTEM-MAP.md coverage gap (feature missing from docs).**
   These Korean docs are end-user feature lists and contain **almost nothing**
   about the agent-core runtime, the two loops (react/plan_execute), the guard
   pipeline, the model-provider abstraction details, or the rich `ask`/`chat`
   flag surface. SYSTEM-MAP line 70 mentions vendor-neutrality (OpenAI·Anthropic·
   Google·OpenRouter·Ollama·LM Studio) but omits the 6 OpenAI-compat presets
   (Groq/DeepSeek/Together/Mistral/Moonshot/Cerebras). Not necessarily a bug
   (these are user-facing docs, runtime is internal) — but the `ask` flag
   surface (--why, --verify-claims, --best-of, --tiered, --repair, --connect,
   image --auto/--extract/--to-calendar) is genuinely user-facing and largely
   undocumented in FEATURES.md.

5. **Embedding default consistency — OK (no drift).** `ask --embed-model`
   default is `nomic-embed-text-v2-moe`, consistent with the memory note. README
   line 388 documents `MUSE_MODEL_BASE_URL` default `http://localhost:11434/v1` —
   matches `normalizeOllamaBaseUrl` behavior. No action.

---

## F. Nothing broken
No crashes, no failing tests in the three domain packages. `demo` degrades
gracefully without a running Ollama. All API-only commands (`runs`, `context`,
`runtime`) fail with a clear, actionable message rather than a stack trace.
