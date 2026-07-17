# Competitor Teardown — openclaw & hermes (what they actually do)

> Generated 2026-06-23 by an exhaustive 20-theme source teardown + completeness critic.
> **442 competitor file-reads** (420 distinct) across `/Users/jinan/ai/openclaw`
> (TS/JS) and `/Users/jinan/ai/hermes-agent` (Python). Reference-only competitive analysis of
> open-source projects; Muse builds its own designs (see `growth-backlog.md`).
>
> This document explains **how the two reference agents actually work**, theme by theme, grounded
> in real source. 260 distinct capabilities catalogued. Use it to understand the field;
> use the backlog for what to build.

## Cross-cutting observations (architecture-level)

- Multi-channel orchestration (WhatsApp, Slack, Discord, Google Meet, realtime voice, browser, terminal) with session isolation, delivery routing, and per-channel streaming adaptors.
- Two-tier async: (1) daemon processes with watch-pattern notifications and crash recovery; (2) async delegation with background subagents returning completion events to shared queue.
- Stateless tool deferral: progressive disclosure via bridge tools only when thresholds crossed; catalog rebuilt each assembly to prevent drift (vs OpenClaw proactive discovery).
- Context compaction loop: (1) token budgets at tool-result/message level, (2) transcript rotation via session succession, (3) auxiliary-model summarization with fallback replay.
- Plugin/environment abstraction: backends (Firecrawl, Exa, web providers) and execution environments (local, Docker, Modal, SSH, Daytona) selected via config without hard coupling.
- Human-in-the-loop gates: approval flows, interactive clarify with UI fallback, write-approval, vision/web access checks pre-invocation.
- Batch evaluation infrastructure: parallel trajectory generation, toolset distributions, tool-statistics aggregation, reasoning coverage, corrupted-entry filtering.
- Platform detection/fallback stacks: audio (Termux:API → PortAudio → PulseAudio forwarding), STT (local faster-whisper → Groq → OpenAI), playback (sounddevice → afplay/ffplay/aplay).

## Notable capabilities the per-theme pass nearly missed (critic sweep)

- **Realtime Voice/Audio Bridge & Agent Consult Runtime** (openclaw) `/Users/jinan/ai/openclaw/src/talk/agent-consult-runtime.ts` — Full realtime voice session consultation with live transcription, session forking decisions, delivery-context routing, and prompt management for voice-driven agent delegation.
- **Batch Processing & Dataset Generation Pipeline** (hermes) `/Users/jinan/ai/hermes-agent/batch_runner.py` — Parallel multi-worker batch trajectory generation with checkpointing, resume semantics, toolset sampling distributions, and dataset-level statistics aggregation for evaluation.
- **Voice Recording with Adaptive Silence Detection** (hermes) `/Users/jinan/ai/hermes-agent/tools/voice_mode.py` — Push-to-talk with dip-tolerance silence detection, Termux:API fallback, platform-specific playback (afplay/ffplay/aplay), and Whisper hallucination filtering.
- **Progressive Tool Deferral (Tool Search Bridge)** (hermes) `/Users/jinan/ai/hermes-agent/tools/tool_search.py` — Stateless deferred-loading bridge tools replace large tool arrays only above context threshold; catalog rebuilt each assembly to prevent drift.
- **Async Background Delegation with Daemon Executor** (hermes) `/Users/jinan/ai/hermes-agent/tools/async_delegation.py` — Background subagent spawning on daemon threads with completion queue integration and task-source blocks; parent returns immediately without blocking.
- **Gateway-Side Interactive Clarify Primitive** (hermes) `/Users/jinan/ai/hermes-agent/tools/clarify_gateway.py` — Thread-safe blocking clarify with button UI fallback, text-capture resolution, timeout protection, and module-level state for platform adapters.
- **Process Registry with Output Buffering & Watch Patterns** (hermes) `/Users/jinan/ai/hermes-agent/tools/process_registry.py` — Background process tracking with rolling buffer, watch-pattern notifications with global circuit-breaker + strike limits, and crash-recovery JSON checkpoint.
- **Vision Tool with Image Download & Auxiliary Router** (hermes) `/Users/jinan/ai/hermes-agent/tools/vision_tools.py` — Multimodal image analysis via configurable auxiliary router (OpenRouter/Nous/Codex/Anthropic) with download timeout, file-size capping, and temp cleanup.
- **Web Tools Backend Abstraction (Firecrawl/Exa/Tavily/Parallel)** (hermes) `/Users/jinan/ai/hermes-agent/tools/web_tools.py` — Provider-agnostic search/extract with Nous tool-gateway routing, per-vendor client caching, and plugin-delegated implementations.
- **Session Search with FTS5, Windowing & Bookends** (hermes) `/Users/jinan/ai/hermes-agent/tools/session_search_tool.py` — Long-term conversation recall via SQLite FTS5 with snippet extraction, ±window scrolling by anchor, and bookend context (first/last 3 turns).

---


# 1. Agent Runtime Core — turn loop, model invocation, streaming, thinking

_11 capabilities · 13 files read_

# Agent Runtime Core Teardown: openclaw vs. hermes

## Overview

Both systems implement agentic loops that turn user input through model calls into tool dispatch and final responses. The core difference: **openclaw is async/streaming-first with lane-based concurrency and pluggable harnesses; hermes is sync/eager with single-thread-per-turn and baked-in tool dispatch**.

## The Agentic Loop

**openclaw** (`run.ts`): `runEmbeddedAgentInternal()` enqueues work onto global/session lanes (line 773-780) with explicit lifecycle generation tracking to handle concurrent reruns of the same sessionId. The main retry loop (line ~1872, `while(true)`) runs up to 32 attempts (`MAX_RUN_LOOP_ITERATIONS`). Each iteration:
1. Builds a `runtimePlan` (auth, model resolution, thinking level)
2. Dispatches to harness via `runEmbeddedAttemptWithBackend()` 
3. Observes result (error, timeout, format fail, empty response)
4. Routes to failover decision: `continue_normal`, `rotate_profile`, `fallback_model`, or `surface_error`

The loop is guarded by three abort signals: parent `abortSignal` (external caller), `attemptAbortController` (per-attempt), and `laneTaskReleaseController` (timeout grace). A heartbeat interval (`EMBEDDED_RUN_LANE_HEARTBEAT_MS=15s`) signals progress to the lane task timeout watchdog so transports owned by the harness (plugin-harnesses) don't kill waiting work.

**hermes** (`conversation_loop.py`): `run_conversation()` wraps the same three phases but as a single procedural function:
- **Prologue** (`build_turn_context()`, 20+ setup tasks): session DB init, MCP refresh, preflight compression, plugin hooks, memory prefetch
- **Loop** (`while api_call_count < max_iterations`, line 589): tool dispatch, retries, format recovery
- **Epilogue** (`finalize_turn()`, post-loop cleanup): budget-exhaustion summary, trajectory save, resource cleanup, plugin hooks

The retry loop mutates `agent` state directly (counters, cached prompt, interrupt flag). Each iteration increments `api_call_count`, checks budget, fires step_callback for gateway hooks, then drains pending /steer directives before building the API request.

**Distinction**: openclaw's lane queueing prevents runaway concurrency; hermes uses a simpler iteration budget with no concurrent work. openclaw's lifecycle generation guard lets a newer `runId` override a stale one; hermes has no multi-generation handling. hermes's prologue concentration makes turn lifecycle visible; openclaw spreads setup across the harness dispatch boundary.

## Streaming & Model Invocation

**openclaw** (`stream-resolution.ts`): `resolveEmbeddedAgentStreamFn()` (lines 118-213) is a multi-branch dispatcher:
- If `providerStreamFn` supplied, wrap and inject auth/signal
- Else if `provider == "anthropic-vertex"`, use native Vertex wrapper
- Else if `isOpenAICodexResponsesModel()`, route to Codex-specific stream (test-injected)
- Else if default OpenClaw stream, check for boundary-aware transport (API-specific HTTP wrapper)
- Else return current session stream or fallback to `streamSimple`

The wrapper (`wrapEmbeddedAgentStreamFn()`, lines 224-270) is a higher-order function that injects `apiKey` (lazy resolved from `authStorage` or `resolvedApiKey`), `signal`, `sessionId`, and `promptCacheKey` into options. Uses a `WeakMap` cache (`embeddedAgentBaseStreamFnCache`) to deduplicate per-session resolution.

**hermes** (`conversation_loop.py`, `_interruptible_api_call()`): Invokes the appropriate SDK (OpenAI, Anthropic, Ollama) with `stream=True` and `stream_callback` for TTS prefetch. The callback fires before the response arrives, allowing audio generation to start mid-stream. Catches provider exceptions, classifies via `error_classifier.FailoverReason`, and gates retries (e.g., 429 → credential pool rotation, 401/403 → OAuth refresh).

**Distinction**: openclaw's lazy authStorage lookup and WeakMap deduplication reduce credential roundtrips on streaming path; hermes's stream_callback wiring in prologue (line 163) decouples TTS generation from text buffering. Both use the same model SDK under the hood but route differently through transport layers.

## Thinking/Reasoning Block Handling

**openclaw** (`thinking.ts`): Three recovery paths for reasoning:
1. **Signature repair** (`stripThinkingSignaturesFromMessage()`, lines 138-166): removes `thinkingSignature`/`signature`/`thought_signature` fields on replay (cryptographic binding to context prefix).
2. **Stale signature detection** (`stripStaleThinkingSignaturesForCompaction()`, lines 185-222): timestamp-compares assistant messages against latest `compactionSummary` role; strips pre-compaction signatures (new context prefix invalidates old signatures).
3. **Stream error recovery** (`wrapAnthropicStreamWithRecovery()`, lines 700-753): intercepts stream errors matching `THINKING_BLOCK_ERROR_PATTERN` (regex for "thinking"/"redacted_thinking" + "signature"/"invalid"/"missing"), retries once with `stripAllThinkingBlocks()` (removes reasoning entirely).

**hermes** (`agent_runtime_helpers.py`, `turn_finalizer.py`): Handles reasoning via three mechanisms:
1. **Trajectory storage** (`convert_to_trajectory_format()`, lines 66-233): wraps reasoning in `<think>` tags for training data; handles both native thinking tokens and XML scratchpad (REASONING_SCRATCHPAD → `<think>` conversion).
2. **Multi-turn reasoning** (`_copy_reasoning_content_for_api()`): copies `msg["reasoning"]` to `reasoning_content` for APIs that preserve multi-turn context (OpenRouter); native Anthropic sends in reasoning_level control.
3. **Reasoning extraction** (`finalize_turn()`, lines 342-348): walks backwards from latest assistant to current user boundary (not crossing turns), captures most-recent non-empty reasoning field for result dict.

**Distinction**: openclaw's signature management is cryptographic (stale after compaction, signature validation is provider-owned); hermes's reasoning_content is semantic (multi-turn context flag for OpenRouter). openclaw drops thinking-only turns on stream error; hermes preserves them in session DB but drops pre-API so providers don't 400. Reasoning tokens (~40% overhead) both track separately in cost accounting.

## Failover & Auth Profile Rotation

**openclaw** (`failover-policy.ts`, `run.ts`): `resolveRunFailoverDecision()` is a stage-aware decision matrix (lines 148-200):
- **retry_limit stage**: if `fallbackConfigured && shouldEscalateRetryLimit(reason)`, escalate to `fallback_model`; else `return_error_payload`
- **prompt stage** (pre-API error): if `!profileRotated && shouldRotatePrompt()`, return `rotate_profile`; if fallback configured and not terminal format, return `fallback_model`; else `surface_error`
- **assistant stage** (post-API error): if `!aborted && failoverFailure`, return `rotate_profile` or `fallback_model` depending on reason; if timeout, allow rotation; if harness owns transport and timeout, `surface_error` (no recovery)

`mergeRetryFailoverReason()` (lines 140-146) preserves the strongest signal (explicit failover reason > timeout > prior reason) across attempts.

**hermes** (`conversation_loop.py`): Simpler linear recovery chain:
1. **Per-provider OAuth refresh** (TurnRetryState guards, lines 42-55): codex_auth_retry, anthropic_auth_retry, nous_auth_retry, nous_paid_entitlement_refresh, copilot_auth_retry (each fires once per attempt)
2. **Credential pool rotation** (line ~629): on 429, rotate to next profile in pool; check `isProfileInCooldown()` before reusing
3. **Fallback activation** (`try_activate_fallback()`): swaps provider/model, rewrites cached system prompt (Model:/Provider: lines) so agent reports actual identity
4. **Prefix-cache reuse** via `_sync_failover_system_message()` (lines 469-492): mutates api_messages[0] to keep cache warm during fallback

**Distinction**: openclaw's stage-aware logic prevents rotation before format-retry but allows it after; hermes fires OAuth per-provider (more attempts per iteration) then escalates to fallback. openclaw's mergeRetryFailoverReason preserves signal across iterations; hermes's TurnRetryState one-shots per attempt. Both avoid infinite retries on deterministic errors (format, content_policy).

## Context Compression & Overflow Recovery

**openclaw** (`run.ts`): On overflow, calls `contextEngine.compact()`, which may own compaction logic (per engine). Hook: `onCompactionSessionIdChange` fired for session migration. Compaction-continuation retry instruction prepended post-compress (line 924).

**hermes** (`turn_context.py`): Preflight compression runs in prologue (lines 291-365) as a 3-pass loop:
1. Estimate tokens (`estimate_request_tokens_rough()`)
2. Check threshold (`context_compressor.should_compress()`)
3. Compress via `agent._compress_context()`
4. Re-estimate and check progress: `_compression_made_progress()` requires >5% token reduction OR row reduction

The 5% floor (turn_context.py lines 53-57) prevents wobble (issue #39548: 220→220 messages, 288k→183k tokens looked like no progress without token re-estimation). Deferred preflight logic skips estimation if last_real_prompt < rough estimate (defer_preflight callback).

Auto-lowers compression threshold if auxiliary model context < threshold (`check_compression_model_feasibility()`, lines 74-250): new_threshold = aux_context so request fits in aux model's window.

**Distinction**: openclaw's engine-owned compaction is decoupled from turn orchestration; hermes's preflight is baked into prologue. Hermes's multi-pass loop and token re-estimation solve the "no progress" false positive. Both gate by explicit token thresholds.

## Message Repair & Sanitization

**hermes** (`agent_runtime_helpers.py`, `conversation_loop.py`): Two integrated repair steps before API call:
1. **Tool-call JSON repair** (`sanitize_tool_call_arguments()`, lines 237-300): detects corrupted arguments, runs `_repair_tool_call_arguments()` to fix syntax
2. **Role-alternation repair** (`repair_message_sequence_with_cursor()`, lines ~729-736): enforces user/assistant/tool alternation, detects orphaned tool results, recomputes _last_flushed_db_idx cursor (session DB flush synchronization, issue #44837)

Followed by:
- Surrogate character sanitization (`_sanitize_messages_surrogates()`)
- Thinking-only drop + adjacent-user merge (`_drop_thinking_only_and_merge_users()`)
- Whitespace/JSON normalization for prefix matching consistency

**openclaw**: Less explicit repair; relies on harness/model-resolution layers.

**Distinction**: hermes's cursor recomputation is non-obvious but load-bearing (prevents message loss on DB flush post-repair). One integrated pass per iteration before API call. openclaw defers validation to harness layer.

## Turn Prologue & Epilogue Architecture

**hermes** (`turn_context.py`, `turn_finalizer.py`, `conversation_loop.py`): Extracted into named functions returning dataclasses:
- **Prologue** `build_turn_context()` (lines 87-438): 20+ tasks including stdio guard, session DB ensure, auxiliary_client sync, MCP refresh, surrogate sanitization, task_id generation, retry counter reset, preflight compression, plugin hook (pre_llm_call), external memory prefetch. Returns TurnContext with produced locals.
- **Epilogue** `finalize_turn()` (lines 30-458): budget-exhaustion handler, trajectory save, resource cleanup, session persist (each guarded independently, issue #8049), file-mutation verifier footer, turn-completion explainer, plugin hooks (transform_llm_output, post_llm_call, on_session_end), background memory/skill review trigger.

Plugin hooks fire at defined checkpoints: on_session_start (first turn), pre_llm_call (context injection into user message, NOT system prompt to preserve cache prefix), transform_llm_output (one-shot post-loop), post_llm_call (async after response delivered), on_session_end (always).

**openclaw**: Setup spread across harness dispatch boundary; no equivalent epilogue function.

**Distinction**: Prologue/epilogue extraction makes turn lifecycle testable and tunable. Plugin hook ordering (pre_llm_call into user message, not system prompt) is non-obvious but critical for cache preservation. Independent cleanup guards prevent data loss when one cleanup path raises.

## Usage & Cost Tracking

**openclaw** (`run.ts`): `createUsageAccumulator()` sums tokens across attempts. `buildUsageAgentMetaFields()` extracts cost_source (e.g. "openai_native"), cost_status. Reasoning tokens tracked separately.

**hermes** (`turn_finalizer.py`): `normalize_usage()` reconciles API response usage (input/output/cache_read/cache_write/reasoning tokens) with `estimate_usage_cost()`. Result dict carries session totals (input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, estimated_cost_usd). cost_status enum gates billing/entitlement messages (e.g. 'credits_insufficient' → print Nous portal link, OpenRouter credits URL).

**Distinction**: Both track reasoning tokens separately (invisible to non-native-thinking models but real to cost). Hermes's cost_status enum enables provider-specific guidance; openclaw's cost_source tracks which provider's pricing was used.

## Session & Checkpoint Persistence

**hermes**: Early persist in prologue (turn_context.py line 283, crash-resilience before API) captures inbound user turn. Late persist in epilogue (turn_finalizer.py line 165, after scaffolding cleanup) captures agent response + tool results. Trajectory format (convert_to_trajectory_format()) is distinct from session DB: text-only, base64 image parts → text_summary, <think> tags for reasoning.

**openclaw**: Session file tracking via activeSessionFile variable, compaction-triggered session migration via onCompactionSessionIdChange hook.

**Distinction**: Hermes's two-point persistence (early + late) with scaffolding cleanup (#39550) prevents re-triggering empty-response loop on replay. Trajectory format enables training data generation without embedding megabyte image blobs.

## System Prompt Caching & Prefix Stability

**hermes** (`turn_context.py`): `_restore_or_build_system_prompt()` (lines 254-375):
- Checks session DB for stored prompt
- Validates via `_stored_prompt_matches_runtime()` (Model/Provider lines must match)
- If stale or missing, rebuilds from scratch
- Persists to session DB on first build

Cached on `agent._cached_system_prompt` across turns for Anthropic cache prefix matching. Plugin prefetch context and ephemeral_system_prompt injected into **user message** (not system prompt) at API time so cache prefix unchanged.

**Distinction**: Exact system prompt replay via DB cache critical for bit-perfect prefix matching. Model/Provider line validation prevents silent cache miss on model switch. User-message injection (not system-prompt) preserves cache across turns with different ephemeral context.

## The Cleverest Mechanism

**hermes's preflight compression + multi-pass progress detection** (turn_context.py lines 37-57, 291-365): The `_compression_made_progress()` function checks both message row count AND token count (>5% reduction floor). This solved issue #39548 where 220→220 messages, 288k→183k tokens looked like no progress (row-count-only logic would have given up and auto-reset). The 5% floor prevents wobble and keeps the loop spinning only when material progress is made. Deferred preflight logic (`should_defer_preflight_to_real_usage`) further gates estimation if last known real prompt < rough estimate. This is pure state-machine thinking: compress only when feasible, re-estimate to avoid false negatives, stop when progress plateaus.

**openclaw's dual-abort-signal architecture** (run.ts lines 1977-2030): Three abort signals (parent, per-attempt, lane-task-release) coordinate timeout + graceful cleanup. The lane heartbeat (every 15s) signals progress to the task timeout watchdog. A transport owned by the harness can ignore its own timeout (plugin-harnesses), so grace period (EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS=30s) allows cleanup before lane release. This avoids the classic async trap: hard kill on timeout → orphaned processes. The `onAttemptTimeoutArmed` callback (startLaneProgressHeartbeat) and `onAttemptTimeout` callback (armAttemptTimeoutRelease) let the harness and lane watchdog negotiate who owns timeout semantics.


# 2. Context Compaction — compression, truncation, trajectory, budgeting

_13 capabilities · 22 files read_

## Context Compaction: Comparative Architecture

Both openclaw (TypeScript) and hermes (Python) implement context compaction to extend long-running agent sessions within token windows. They diverge significantly in strategy, lifecycle management, and failure handling.

### OpenClaw's Multi-Engine, Pluggable Approach

OpenClaw treats context compaction as a pluggable subsystem via its **ContextEngine** registry (`context-engine/registry.ts`, `types.ts`). Rather than a single compressor, it allows third-party engines (e.g., LCM, custom DAG builders) to coexist and swap without restarts. Engines declare host-capability requirements (bootstrap, assemble-before-prompt, maintain, compact, thread-bootstrap-projection) and OpenClaw's harness validates compatibility before use. Failed engines are quarantined transparently via weak-map metadata binding, allowing automatic fallback to a backup engine without explicit error handling in the model loop.

The **context projection lifecycle** distinguishes per-turn assembly (project context every turn) from thread-bootstrap mode (inject once, reuse backend thread until epoch changes). Hosts with persistent backend threads opt into thread-bootstrap to avoid re-serializing static history; the system tracks dual-authority token estimates (assembled vs preassembly) to catch overflow artifacts hidden by compression summaries.

Compaction is **queued onto command lanes** (`compact.queued.ts`) to prevent deadlock in gateway deployments. Budget compaction for context-engine-owned transcripts can defer to background maintenance when the engine declares `turnMaintenanceMode: 'background'`; the harness schedules deferred tasks and manages SIGINT/SIGTERM cleanup via AbortSignal. This allows expensive operations (DAG building, database index updates) to run asynchronously without stalling the user's reply.

**Transcript rotation** (after `compaction-successor-transcript.ts`) optionally truncates history post-compaction: new session_id (UUID), new file with timestamp+compaction-entry link, parent-session pointer for lineage tracing. Rotation is atomic and leaves pre-compaction files as archives.

Token planning (`compaction-planning.ts`) splits messages into equal-token-share chunks while preserving tool_use/toolResult pairs. Sanitization strips runtime-context entries and toolResult.details **before any LLM call**, ensuring secrets never reach summarization. Per-message token counts are cached in a single pass to avoid O(n) wrapping overhead.

### Hermes's Auxiliary-Model Compression with Structured Prefixes

Hermes implements a single **ContextCompressor** engine that summarizes via a cheap auxiliary LLM (OpenRouter, Claude via Anthropic). The auxiliary model is separate from the main conversation model, allowing compression to run without consuming main-model quota or stalling user replies.

The compressor calculates **threshold_tokens** adaptively: for small-context models (≤ MINIMUM_CONTEXT_LENGTH), it triggers at 85% of window instead of 50%, avoiding premature compression on minimum-context models. Tail protection is **budget-based** (protect_last_n=6 by default, but measured in tokens via tail_token_budget), not message-count; this adapts naturally to variable-size turns (multi-image conversations are heavy; text-only are light).

**Summary prefixes** are explicitly reference-only: SUMMARY_PREFIX spans ~200 words clarifying that the summary is background, not active instructions, and that the latest user message always wins over historical task state. This directly addresses a failure mode in prior compaction systems where weak models re-read task sections as fresh instructions and resumed stale work. The prefix is versioned (_HISTORICAL_SUMMARY_PREFIXES); if a summary persists across session rotations, re-normalization strips old prefix versions before re-compacting, preventing stale directives from embedding in the body.

**Tool result pruning** runs pre-LLM as a cheap first pass: _summarize_tool_result() generates tool-specific summaries ('terminal ran X -> exit Y, Z lines', 'read_file X from line N (K chars)') for 20+ known tools, replacing bulky outputs before the auxiliary model is called. Fallback for unknown tools prevents toolchain expansion from blocking compression.

**Media stripping** (strip_historical_media) targets the **last user message with images**, replacing all image parts in earlier messages with a placeholder. This solves the multi-MB base64 image re-ship problem: if the tail is now text-only, earlier images are stripped; if tail still has images, only earlier ones are pruned.

**Iterative summary updates** preserve context across repeated compressions: the first compaction generates a summary; subsequent compactions receive the prior summary as context and update it with new resolved/pending items. This prevents summary drift and facts from evaporating.

**Fallback summarization** (abort_on_summary_failure=False) handles auxiliary-model failure gracefully. When the summary LLM times out/fails, hermes inserts a deterministic fallback: extracted path mentions, key questions, and turn summaries, capped at 8K chars. A 10-minute cooldown prevents re-attempting a failed provider endpoint, avoiding thrashing.

### Key Distinctive Mechanisms

**Weakest-Link Pluggability** (OpenClaw): Multiple compressors can coexist; quarantine proxies let one fail without cascading. Hermes is locked to a single compressor per session.

**Thread Bootstrap Projection** (OpenClaw): Avoids re-serializing static history on every turn by reusing a backend thread until context epoch changes (fingerprint-based); Hermes always rebuilds context per turn.

**Token Envelope Awareness** (Hermes): Counts full tool_call dict (id, type, function.name) not just arguments JSON, fixing 2-15x undercounts on parallel-tool turns. OpenClaw strips both before counting, so the issue doesn't arise.

**Summary Prefix Versioning** (Hermes): Handles summary inheritance across session rotations; stale prefix versions are stripped on re-compaction. OpenClaw rotates to a new session_id, avoiding this complexity.

**Deterministic Fallback** (Hermes): When summary fails, insert structured text (path mentions, Q&A) instead of re-sending uncompressed history. OpenClaw's fallback path (via classifyCompactionReason) aborts or retries the LLM; no deterministic handoff.

The **cleverest mechanism** across both systems is hermes's combination of **tool-result pruning + summary prefix + iterative updates**: pre-compaction pruning shrinks tool outputs cheaply, the auxiliary model summarizes what's left with explicit "this is background" framing, and iterative updates preserve facts across multiple compressions. This trilogy minimizes LLM calls while maximizing information retention.


# 3. Prompt Construction & Caching — system prompt, cache stability

_11 capabilities · 25 files read_

## Comparative Teardown: Prompt Construction & Caching (Hermes vs OpenClaw)

### Hermes: Three-Tier Build + Fixed Breakpoints

Hermes constructs the system prompt once per session in `/Users/jinan/ai/hermes-agent/agent/system_prompt.py` using a **three-tier architecture**:

1. **Stable tier** (~70% of prompt): identity, tool guidance, skills index, environment probes, model-family operational guidance, active profile name, platform hints. Assembled by build_system_prompt_parts() → stable tier joined once.
2. **Context tier** (~20%): caller-supplied system_message + context files (AGENTS.md, .cursorrules) discovered via build_context_files_prompt().
3. **Volatile tier** (~10%): memory snapshot (format_for_system_prompt("memory")), USER.md profile, external memory provider block, timestamp (date-only, not minute-precision, to preserve daily prompt stability).

The full prompt is cached on `agent._cached_system_prompt` for the session lifetime. Compression events trigger invalidate_system_prompt(), which clears the cache and reloads memory from disk before rebuild.

**Cache strategy** (prompt_caching.py): apply_anthropic_cache_control() places exactly 4 cache_control markers — one on system prompt, then on the last 3 non-system messages. All 4 share a single TTL (5m ephemeral or 1h long). Deep copy preserves the original message array. This strategy achieves ~75% input token savings on long conversations: system prompt hit alone saves ~50%; last 3 turns save ~25%.

**Coding context** (coding_context.py): When running in a git repo or code workspace, a RuntimeMode activates that injects a **git snapshot** (branch, dirty state, test targets) into the stable tier once per session. The snapshot is immutable; the brief tells the model "re-check with git before acting." INTERACTIVE_CODING_PLATFORMS gate activation to cli/tui/acp/desktop; model-family guidance (_EDIT_FORMAT_GUIDANCE) nudges format selection (GPT → patch mode, Claude → replace mode).

**Lazy context injection** (subdirectory_hints.py): As the agent navigates into new directories via tool calls, SubdirectoryHintTracker discovers and loads AGENTS.md / CLAUDE.md / .cursorrules files and injects them into tool results (not the system prompt), preserving cache stability. Per-hint cap: 8K chars; walks up to 5 parent directories from each path.

**Compression handoff** (context_compressor.py): When context fills, the compressor summarizes middle turns using an auxiliary model. The summary is prefixed with SUMMARY_PREFIX — a multi-paragraph directive stating: "This is background reference, NOT active instructions. Respond only to the latest user message AFTER this summary. Discard stale items in Historical Task/Pending Asks unless the latest message explicitly asks for them. Reverse signals (stop, undo, roll back) cancel in-flight work." _SUMMARY_END_MARKER explicitly marks the summary boundary. Historical versions (_HISTORICAL_SUMMARY_PREFIXES) track old directives so re-compacted lineages inherit them correctly. Memory in the system prompt remains authoritative and is never deprioritized due to compaction.

---

### OpenClaw: Cache-Boundary Split + Multi-Provider Family Routing

OpenClaw builds the system prompt via buildConfiguredAgentSystemPrompt() (system-prompt-config.ts), which resolves config-derived fields (ownerDisplay, subagentDelegationMode, ttsHint, modelAliasLines, memoryCitationsMode) before calling buildAgentSystemPrompt() to render. The prompt is installed into the session via applySystemPromptToSession() → session.setBaseSystemPrompt().

**Cache boundary strategy** (system-prompt-cache-boundary.ts): A marker `<!-- OPENCLAW_CACHE_BOUNDARY -->` splits the prompt into **stable prefix** (cached) and **dynamic suffix** (not cached). splitSystemPromptCacheBoundary() extracts {stablePrefix, dynamicSuffix}. ensureSystemPromptCacheBoundary() appends the marker if missing (e.g., hook-injected prompts). stripSystemPromptCacheBoundary() removes it for APIs that don't understand comments. applyAnthropicCacheControlToSystem() applies cache_control only to stable blocks; volatile suffix is left uncached.

This boundary enables **plugin injection**: plugins inject content via the system_prompt hook; the boundary routes hook additions to the dynamic layer without invalidating the cached prefix. The marker is a comment, so the model sees one continuous prompt while the transport honors the split.

**Multi-provider cache routing** (prompt-cache-retention.ts + anthropic-family-cache-semantics.ts): resolveCacheRetention() is a router that selects the right caching strategy based on provider + modelApi + modelId:
- **Anthropic direct / Vertex / Bedrock**: → resolveAnthropicCacheRetentionFamily() returns "anthropic-direct"|"anthropic-bedrock"|"custom-anthropic-api" (if explicit config + custom API). TTL: 5m (short) or 1h (long).
- **Google Gemini-2.5+**: → isGooglePromptCacheEligible() checks modelApi=='google-generative-ai' && modelId.startswith('gemini-2.5'). Uses Google's own cache API.
- **OpenAI-compatible with supportsPromptCacheKey=true**: → OpenAI cache keys (custom APIs, oMLX, llama.cpp).
- **Unknown families**: → no caching.

Each family has hardcoded eligibility gates (isAnthropicBedrockModel checks model patterns, etc.). No guessing; unknown models default to no caching.

**Google cache tracking** (google-prompt-cache.ts): Google GenAI requires explicit cachedContent IDs. OpenClaw persists cache metadata in session custom entries (GOOGLE_PROMPT_CACHE_CUSTOM_TYPE = 'openclaw.google-prompt-cache'). For each request, readLatestGooglePromptCacheEntry() scans backwards for the latest ready/failed entry matching a matchKey (built from provider + modelId + systemPromptDigest + cacheConfigDigest). On success, passes cachedContent to the next request. On expiry/failure, retries with backoff (10min). digestSystemPrompt() hashes the full prompt to detect mutations; cache invalidation is automatic — any prompt change = new digest = fresh cache creation.

**Payload policy enforcement** (anthropic-payload-policy.ts): applyAnthropicPayloadPolicyToParams() enforces the 4-marker ceiling. Counts cache_control entries already in system/tools, then distributes remaining quota to messages. If system/tools consume 3 markers, only 1 remains for message caching. countAnthropicCacheControlMarkers() walks arrays and counts entries with the cache_control property. Quota enforcement is reactive — counts real entries before adding more, so plugin-injected cache_control hints gracefully compete for quota.

**Prompt stability** (prompt-cache-stability.ts): normalizeStructuredPromptSection() canonicalizes newlines (\\r\\n → \\n), strips trailing whitespace, and trims. normalizePromptCapabilityIds() dedupes and sorts capability strings before baking, ensuring byte-stable output across platforms and input-order variations.

---

### Key Architectural Differences

| **Aspect** | **Hermes** | **OpenClaw** |
|:---|:---|:---|
| **Prompt structure** | Three tiers (stable/context/volatile) built once, volatile rebuilt on compression | Monolithic prompt with cache-boundary marker for split caching |
| **Cache markers** | Fixed 4-marker strategy: system + last 3 non-system messages | Flexible: cache_control applied to stable blocks only; message markers are secondary |
| **Compression** | Explicit handoff prefix + historical versions for lineage inheritance | No explicit compression framework (generic context overflow) |
| **Coding context** | RuntimeMode + immutable git snapshot baked in stable tier | Generic system-prompt hooks (plugins can inject) |
| **Lazy context** | SubdirectoryHintTracker injects hints into tool results per-turn | No built-in subdirectory discovery (relies on tool result formatting) |
| **Provider support** | Single Anthropic caching family (system_and_3 layout) | Multi-provider family router (Anthropic, Google, OpenAI-compatible) |
| **Google caching** | Not explicitly addressed | Dedicated google-prompt-cache.ts with digest-based invalidation + session tracking |
| **Boundary handling** | Implicit tier separation (prompt parts are opaque to transport) | Explicit marker in prompt text for transport-layer splitting |

### Cleverest Mechanisms

**Hermes' three-tier design** is elegant: the stable tier captures identity/skills/environment once, context captures project-specific state once, volatile captures runtime-only data (memory/timestamp). This separation means the agent can rebuild the volatile tier for memory updates without touching the stable tier, keeping the prefix cache warm. The explicit "tier" model also makes testing trivial: you can test each tier independently and validate that prompt rebuilds don't unexpectedly change the stable bytes.

**OpenClaw's cache-boundary marker** is deceptively simple: a single HTML comment in the prompt. Yet it solves a hard problem — allowing plugins to inject content without breaking the cache. By putting the boundary inside the prompt text (not a metadata layer), the split is transparent to the model (it sees one prompt) but visible to the transport. No need for a plugin to know about caching; just inject via the hook, and the boundary routes additions to the uncached suffix.

**OpenClaw's multi-provider family router** is the practical workhorse. Instead of hardcoding Anthropic-specific caching everywhere, resolveCacheRetention() encapsulates provider-family logic. New providers (Bedrock, Vertex, Google, custom APIs) are added via declarative gates in the router, not scattered across the codebase. This is why OpenClaw can support Bedrock Claude models, Google Gemini, and OpenAI-compatible backends with cache configs that actually work.

**Hermes' compression handoff prefix** is robust against session lineages. By recording historical versions of the prefix, re-compacted sessions (where the compressed summary itself gets compressed again) inherit the stale-task anti-resume directive without losing fidelity. The "treat as background reference, not active instructions" framing is universal enough to survive multiple compression rounds.


# 4. Tool-Call Repair & Stream Hygiene — repair, scrubbing, sanitization

_11 capabilities · 16 files read_

## Tool-Call Repair & Stream Hygiene Teardown: OpenClaw vs Hermes

### The Problem Domain

Both agents face the same three challenges: (1) models leak plain-text tool calls in their text stream instead of using structured APIs, requiring repair and promotion; (2) models emit malformed or dangerous output (surrogates, truncated JSON, injected instructions) that crashes downstream APIs or misleads the model; (3) streamed deltas may split across boundaries, leaving state machines unable to track partial tags or buffer limits, causing logic-breaking state loss or unbounded memory growth.

### OpenClaw's Architecture

OpenClaw implements **tool-call repair via grammar-driven parsing and buffer-windowed promotion** (TypeScript, packages/tool-call-repair + normalization-core).

**Plain-text tool-call promotion** (`stream-normalizer.ts` + `payload.ts`):
- Three format support: bracketed `[tool_name]{json}`, XML-ish `<function=name><parameter=...>`, Harmony `<|channel|>channel to=name code {json}`. Grammar module pre-materializes tag strings (no regex) and bounds checks to keep hot path fast.
- Stream normalization is an async generator buffering text deltas up to 256KB. State machine tracks three states: 'possible' (under cap, still tool-like), 'over-cap' (exceeds cap but may close), 'impossible' (not tool-shaped). Dual-state design allows huge leaked payloads to be detected post-hoc by scanning tail for closing markers.
- When tool-call-like text is detected, `promoteStandalonePlainTextToolCallMessage()` parses blocks and converts to provider-native tool-call events. When text is over-cap, `scrubOverCapPlainTextToolCallMessage()` strips the prefix and patches final message snapshots to match streamed reality.
- Truncation window: keeps 256KB (active scan) + 64KB (tail) to preserve closing-marker visibility while bounding memory. Marker rescanning is capped to 2048 chars to avoid O(n²) behavior.

**Normalization-core** provides type-safe coercion primitives:
- String coercers (`normalizeOptionalString`, `normalizeNullableString`, `normalizeOptionalLowercaseString`) define exact undefined/null/empty semantics. Record coercers (`asRecord`, `asOptionalRecord`) enable TypeScript narrowing.
- Number coercers enforce strict input grammars (integers: `/^[+-]?\d+$/`, decimals: `/^[+-]?(?:...)?e[+-]?\d+$/i`) to reject partial/corrupt numbers before calling Number().
- Slug normalization applies NFC Unicode (vs NFD) to preserve non-Latin names while matching visually identical composed forms.

**Distinctive mechanism**: The grammar module avoids regex in the hot path by pre-materializing literals and checking string positions directly. Boundary-aware text scrubbing uses index ranges to avoid reparsing over-cap text. The triple-state buffer machine allows tentative over-cap calls to resolve on the next delta without holding unbounded amounts.

### Hermes's Architecture

Hermes implements **stream hygiene via stateful scrubbers for reasoning blocks and message mutation** (Python, agent/ directory).

**Think/reasoning scrubber** (`think_scrubber.py`):
- Stateful state machine tracking `_in_block` (inside a tag), `_buf` (held-back partial-tag tail), `_last_emitted_ended_newline` (line boundary across feed() calls). Handles five tag variants: `<think>`, `<thinking>`, `<reasoning>`, `<thought>`, `<REASONING_SCRATCHPAD>` (case-insensitive).
- Priority logic: closed pairs `<tag>X</tag>` are unconditionally scrubbed (intentional constructs); unterminated opens are only scrubbed at block boundaries (start-of-stream, after newline, or after whitespace-only current line). Prose mentioning '<think>' mid-line is not suppressed.
- Partial-tag hold-back via `_max_partial_suffix()`: when buffer ends mid-tag, suffix is held back until next delta resolves it. At end-of-stream, held-back content is emitted verbatim (it turned out not to be a tag).
- Orphan close-tag stripping: any `</tag>` without matching open is always removed.

**Distinctive mechanism**: Boundary gating prevents over-suppression; the flag `_last_emitted_ended_newline` tracks line state across closures so split deltas (delta1='<thin', delta2='k>') don't lose context. Per-delta regex would destroy this state; centralized state machine ensures all downstream consumers (CLI, gateway, TTS) see identical scrubbed text.

**Message sanitization** (`message_sanitization.py`):
- Surrogate replacement: regex walks nested dicts/lists looking for lone surrogates (U+D800..U+DFFF) from byte-level models and replaces with U+FFFD. Covers content, name, tool_calls[].function.{name, arguments}, and any additional fields (reasoning_content, reasoning_details) so surrogates in nested structures don't kill downstream json.dumps().
- Graduated tool-call argument repair: (1) fast-path empty/None → '{}', (2) `json.loads(strict=False)` for unescaped control chars, (3) trailing-comma/brace-balance fixes, (4) excess-closing removal (50 iterations max), (5) escape-invalid-chars-in-json-strings (replace literal 0x00–0x1F with \\uXXXX). Fallback returns '{}' so API request doesn't crash the session.
- Image stripping: when server signals no image support, removes image_url parts from messages in-place, preserving tool_call_id linkage by replacing tool-message content with placeholders.

**Tool dispatch helpers** (`tool_dispatch_helpers.py`):
- Multimodal envelopes: `_is_multimodal_tool_result()` checks for `_multimodal=True` + `content` (list). `_multimodal_text_summary()` extracts text_summary or flattens text parts so downstream code needing strings doesn't handle lists.
- Untrusted-content wrapping: high-risk tools (web_extract, web_search, browser_*, mcp_*) have string results wrapped in `<untrusted_tool_result source="name">...DATA...</untrusted_tool_result>` (≥32 chars only) to tell the model the content is data, not instructions — the "promptware" architectural defense against indirect injection.
- Parallel dispatch gating: `_should_parallelize_tool_batch()` checks tool names against `_PARALLEL_SAFE_TOOLS` (read-only) and uses `_paths_overlap()` (prefix equality of Path.parts) to allow file tools to run concurrently when targeting independent subtrees.

**Stream diagnostics** (`stream_diag.py`):
- Per-attempt counters: `stream_diag_init()` → dict with started_at, first_chunk_at, chunks, bytes, headers, http_status. `stream_diag_capture_response()` snaps upstream headers (cf-ray, x-openrouter-provider, x-openrouter-id) before iteration.
- Exception chain flattening: `flatten_exception_chain()` walks `__cause__` then `__context__` up to 4 deep to expose underlying httpx errors (RemoteProtocolError, ConnectError) that hide under openai.APIError, allowing one line to capture the full path.

**Distinctive mechanism**: Stateful scrubbers avoid reimplementation across consumers (CLI, gateway, TTS). Nested structure walks in sanitization catch surrogates in reasoning output that flat field checks miss. Exception chains expose root cause; per-attempt headers let post-hoc analysis attribute drops to specific CF edges or providers.

### Key Differences

| Aspect | OpenClaw | Hermes |
|--------|----------|--------|
| **Primary concern** | Promote leaked plain-text tool calls; scrub over-cap payloads | Scrub reasoning blocks; repair malformed JSON; wrap untrusted content |
| **Language** | TypeScript (type-safe, fast hot path) | Python (duck-typed, gradual repairs) |
| **Stateful scrubbing** | Buffer-based state (text accumulation, 3-state FSM) | Tag-based state (open/close, partial tail) + payload walking |
| **Format variety** | 3 tool-call syntaxes (bracketed, XML, Harmony) | 5 reasoning tag variants, arbitrary JSON repairs |
| **Memory strategy** | Sliding window (256KB + 64KB tail) | Per-feed buffer (hold-back suffix) |
| **Grounding mechanism** | Grammar predicates (no regex) | String matching + optional regex (case-insensitive) |
| **Repair strategy** | Promote to native events OR scrub over-cap tail | Graduated JSON repairs (5 passes) + escape-control-chars |

### The Cleverest Bits

**OpenClaw's buffer windowing** (stream-normalizer.ts lines 41–48): The 256KB + 64KB split allows detection of huge payloads that would thrash memory or lose closing markers. Marker rescanning is bounded to 2048 chars of (prior_tail + new_event) so O(n²) behavior is prevented. When over-cap, suppression is not permanent—once a closing marker appears, the tool call is reclassified as visible text and the visible suffix is extracted mid-stream.

**Hermes's boundary-aware tag gating** (think_scrubber.py lines 298–331): `_is_block_boundary()` prevents over-suppression of prose mentioning '<think>' by checking: (1) is tag at position 0 AND prior emission ended with newline? (2) is preceding text on current line whitespace-only AND (if no newline in preceding buf) prior emission ended with newline? This two-level gate (current-line + cross-feed state) is simple but catches split deltas across closures.

**Hermes's graduated JSON repair** (message_sanitization.py lines 185–279): The 5-pass approach (fast-path, strict=False, brace-balance, excess-closing, escape-control-chars) handles models across the spectrum (GLM-5.1 via Ollama emitting truncated JSON, xiaomi/mimo emitting surrogates in reasoning). Last-resort '{}' fallback prevents session crash, logging each repair at WARNING level.

**OpenClaw's promote-from-text-parts** (promote.ts lines 56–71): When providers split structural markers across content parts, `createTextPartPromotionCandidates()` tries three join strategies (structural-line-break, exact, newline) and picks the first that parses. This handles model variation without changing content.


# 5. Tool Execution & Guardrails — dispatch, result classification, file safety

_16 capabilities · 18 files read_

# Tool Execution & Guardrails: OpenClaw vs Hermes

## Architecture Comparison

**Hermes (Python agent runtime)** embeds tool execution directly into the `AIAgent` class: `execute_tool_calls_concurrent()` and `execute_tool_calls_sequential()` live in `/agent/tool_executor.py`, owning dispatch decisions (when to parallelize, which tools run concurrently), worker lifecycle, and per-turn guardrail state. Tool definitions come from a flat registry; the agent evaluates availability on startup.

**OpenClaw (TypeScript descriptor system)** completely decouples tool definition from execution. A `ToolDescriptor` (immutable JSON record) declares name, schema, owner (core/plugin/channel/mcp), and availability (boolean expression over signals). The planner (`buildToolPlan()`) evaluates descriptors once, partitions into visible/hidden with diagnostics, assigns executor refs (discriminated unions), and emits a static plan. Actual dispatch is runtime-specific — the model adapter or runtime layer interprets the executor ref. Plugins, MCP servers, and channels don't need to know how the model invokes their tools.

## Core Mechanisms

### Dispatch & Parallelism
Hermes decides parallelism per batch: `_should_parallelize_tool_batch()` checks for never-parallel tools (clarify), parallel-safe tools (reads), and path overlap for file operations. Parallel-safe set is hardcoded. Path overlap detection uses prefix matching, so `write_file(/tmp/x)` blocks `write_file(/tmp/x/y)` even if `/tmp/x/y` doesn't exist yet. A single overlapping pair triggers sequential fallback.

OpenClaw leaves dispatch to the executor ref: the runtime decides how to invoke each tool after planning. This is why OpenClaw can integrate heterogeneous backends (local, Docker, SSH, GPU queue) without knowing at planning time.

### Failure Detection & Loop Guardrails
Hermes' `ToolCallGuardrailController` (tool_guardrails.py) tracks three dimensions per turn:
1. **Exact failure**: same tool + exact args (SHA-256 hash of canonical JSON). Warns after 2, blocks after 5.
2. **Same-tool failure**: any args, same tool name. Warns after 3, halts after 8.
3. **Idempotent no-progress**: read-only tools returning identical result. Warns after 2, blocks after 5.

Idempotent tools (read_file, web_search, session_search) are whitelisted; mutating tools (terminal, write_file, patch) are logged in MUTATING_TOOL_NAMES. Result hashing for idempotent tools catches silent loops where the tool runs but returns the same JSON repeatedly.

Hard stops are opt-in (config `hard_stop_enabled`). Warnings are always on, allowing models to learn from mistakes.

OpenClaw has no built-in loop detection — it's a planning layer, not runtime. Loop detection would live in the executor or the agent runtime.

### File Safety & Secrets
Hermes enforces multi-layered file denial:
- **Read denied**: project .env files anywhere, Hermes credential stores (auth.json, .anthropic_oauth.json, mcp-tokens/), skills/.hub/ cache.
- **Write denied**: exact files (/etc/sudoers, SSH keys, .netrc, .pgpass, .npmrc, .pypirc, .git-credentials) + prefix blocks (.ssh/, .aws/, .gnupg/, .kube/, .docker/, /etc/sudoers.d/).
- **Cross-profile guard**: detects writes to another Hermes profile's scoped areas (skills, plugins, cron, memories) and surfaces a soft warning.
- **Sandbox-mirror guard**: catches writes to `…/sandboxes/<backend>/<task>/home/.hermes/…` (the host-side mirror that container writes won't reach).

All checks use realpath so symlinks are resolved. Read denials return a clear error message so the model stops; they are defense-in-depth, not security boundaries (terminal tool can still `cat`).

OpenClaw's openshell extension validates remote path mutations server-side via a hardened shell script (PINNED_REMOTE_PATH_MUTATION_SCRIPT). Each directory component is checked for symlinks after resolution (pwd -P), preventing symlink-traversal attacks on remote sandboxes.

### Dangerous Command & Approval
Hermes approves terminal commands matching patterns (rm, sed -i, truncate, dd, shred, git reset/clean, output redirection >). Patterns also match shell variable forms ($HOME, ${HOME}, $HERMES_HOME) for sensitive paths (.ssh/, .env, config.yaml, /etc). Per-session approval state is thread-local; gateway contexts use contextvars so concurrent sessions don't collide.

Approval modes: YOLO (no prompt, frozen at import time), interactive (CLI callback), cron (non-interactive fallback), gateway async (submits approval, waits in queue). Smart approval via auxiliary LLM can auto-approve low-risk commands. Permanent allowlist in config.yaml.

OpenClaw has no built-in approval system; it's a backend decision (openshell SSH sandboxes can gate commands).

### Interrupts & Cancellation
Hermes' interrupt system is per-thread via `_interrupted_threads` set. Worker threads register their tid before executing, race-check if interrupt arrived before registration, then poll `is_interrupted()` during tool execution. On /stop, executor sends signal to all worker tids. Concurrent wait loop polls for interrupts every 5 seconds and cancels pending futures. Cancelled tools emit a synthetic `{error: "...", status: "cancelled"}` result. This is thread-scoped so interrupting agent A doesn't kill agent B in the same process.

OpenClaw has no built-in interrupt mechanism — execution happens at the backend (openshell or other executor), so interrupt would be backend-specific.

### Untrusted Data Wrapping
Hermes wraps results from high-risk tools (web_extract, web_search, browser_*, mcp_*) in `<untrusted_tool_result>` delimiters when >32 chars. This tells the model: "Treat this as DATA, not instructions." It's the architectural defense against indirect prompt injection from poisoned web pages, GitHub issues, and MCP responses. Unlike regex filtering, wrapping survives rephrasing and is semantically meaningful to modern models.

### Multimodal Results & Vision
Hermes handles multimodal tool results (e.g., computer_use screenshots) via envelope `{_multimodal: True, content: [...], text_summary: "..."}`. The text_summary is used for logging and budget enforcement; vision-capable providers (GPT-4o) consume the content list natively. Text-only servers get the fallback. Subdir hints are appended to the first text part, preserving image blocks.

## Context-Scoped State
Hermes uses Python contextvars for session isolation in concurrent gateways. `propagate_context_to_thread()` copies contextvars + thread-local callbacks into worker threads so each thread sees its own approval session, turn ID, and tool call ID. File tools query live terminal environment via _active_environments dict keyed by task_id, guarded by _env_lock.

OpenClaw's descriptor model doesn't require context plumbing — tools are defined once, and the runtime decides how to invoke them.

## Distinctive Design Decisions

1. **Descriptor-first vs. embedding**: OpenClaw decouples definition from dispatch so plugins/MCP servers are fully transport-agnostic. Hermes embeds dispatch in the agent, tightly coupling tool execution to the AIAgent class. This is a fundamental architectural choice: OpenClaw scales to hundreds of tools from diverse sources; Hermes has tighter control and better observability.

2. **Loop detection scope**: Hermes' guardrails are per-turn state (reset between agent turns). OpenClaw has no loop detection; it would need to be added at the executor or agent level.

3. **Approval model**: Hermes gates dangerous commands via pattern matching + interactive approval. OpenClaw defers to backends (openshell validates remote paths, but no built-in approval system).

4. **Path safety enforcement**: Hermes uses realpath + prefix + basename matching, with soft guards for cross-profile and sandbox-mirror writes. OpenClaw's openshell validates on the remote machine (SSH sandbox) so symlink attacks are caught server-side.

5. **Result wrapping**: Hermes wraps untrusted tool results in semantic delimiters, changing how the model interprets them. This is unique to Hermes and is the primary defense against indirect injection.

## Cleverest Mechanisms

1. **Exact-failure signature hashing** (Hermes): Canonicalizing tool args to sorted JSON (with custom separators) and hashing lets the guardrail detect identical-argument retries across language boundaries and minor formatting variations. This is both simple and effective.

2. **Idempotent result hashing** (Hermes): Tracking the result hash for read-only tools catches silent loops where the tool returns the same data repeatedly — a common failure mode where the model keeps calling the tool expecting different output.

3. **Per-thread interrupt tracking** (Hermes): Using thread ID sets instead of a global event allows fine-grained control in concurrent gateways. The small registration window + race-check ensures no interrupt is lost.

4. **Descriptor-driven planning with availability expressions** (OpenClaw): Boolean expressions over simple signals (auth, config, env, plugin, context) let tools hide themselves declaratively. No tool code needs to change when a config value changes or auth expires — the planner rebuilds and the tool is hidden.

5. **Remote path validation via hardened shell script** (OpenClaw openshell): Validating each path component after symlink resolution on the remote machine prevents client-side symlink-traversal attacks. The script is so hardened it's almost impossible to escape.


# 6. Providers & Model Catalog — adapters, discovery, fallback, switching

_12 capabilities · 24 files read_

# Providers & Model Catalog: Comparative Teardown

## OpenClaw (TypeScript)

OpenClaw implements a **schema-driven**, **plugin-aware** provider model catalog with explicit authority tiers and capability metadata.

### Core Architecture

**API Registry (packages/llm-runtime/src/api-registry.ts)**:
- Central dispatch via `registerApiProvider(provider: ApiProvider<TApi>, sourceId?)` storing in `Map<Api, RegisteredApiProvider>`
- Eight canonical API types (KnownApi union): openai-completions, openai-responses, openai-chatgpt-responses, anthropic-messages, bedrock-converse-stream, google-generative-ai, google-vertex, mistral-conversations
- Each provider entry holds both `stream()` (full options) and `streamSimple()` (lightweight) adapters
- `sourceId` parameter enables plugins to unregister all their adapters as a unit, supporting plugin lifecycle

**Model Catalog Merging (src/model-catalog/authority.ts)**:
- `mergeModelCatalogRowsByAuthority(rows)` resolves duplicates via four-tier source hierarchy:
  - **config** (0) — user-specified overrides beat everything
  - **manifest** (1) — bundled provider metadata
  - **cache** (2) — cached discovery results
  - **provider-index** (3) — advisory preview data from uninstalled plugins
- Lower numeric authority wins; merge key is case-insensitive `provider::modelId`
- Produces sorted, deduplicated NormalizedModelCatalogRow[] for runtime lookup

**Capability Discovery (src/llm/model-utils.ts)**:
- `getSupportedThinkingLevels(model)` queries `model.reasoning` + `model.thinkingLevelMap`
- `thinkingLevelMap: Record<'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max', string | null | undefined>` maps normalized levels to provider-specific values; explicit `null` blocks unsupported levels
- `clampThinkingLevel(model, requestedLevel)` walks EXTENDED_THINKING_LEVELS array: first tries upgrading to next available if request unsupported, then downgrades if needed, respecting explicit `null` blocks
- Claude model identity resolved via substring matching (resolveClaudeModelIdentity, supportsClaudeAdaptiveThinking, supportsClaudeNativeMaxEffort)

**Provider-Specific Normalization (packages/model-catalog-core/src/provider-model-id-normalize.ts)**:
- Explicit per-provider normalizers (normalizeGooglePreviewModelId, normalizeTogetherModelId, normalizeAntigravityPreviewModelId)
- Handles migration paths: Gemini 3-pro → 3.1-pro-preview, flash-lite-preview → flash-lite (GA graduation)
- Merge keys are `provider::modelId.toLowerCase()` to prevent duplicate entries from casing variations

**Token Budget Adjustment (src/llm/providers/simple-options.ts)**:
- `adjustMaxTokensForThinking(baseMaxTokens, modelMaxTokens, reasoningLevel, customBudgets)` subtracts thinking allocation from total limit
- Default budgets: minimal=1k, low=2k, medium=8k, high=16k, max=32k (customizable)
- If baseMaxTokens + thinkingBudget exceeds model ceiling, scales thinking down while preserving minimum 1k output tokens

**OpenAI-Compatible Adaptation (packages/llm-core/src/types.ts)**:
- `Model.compat` field with union type: OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat
- Per-model feature flags: supportsStore, supportsDeveloperRole, supportsReasoningEffort, requiresToolResultName, thinkingFormat ('openai'|'openrouter'|'deepseek'|'together'|'zai'|'qwen'), cacheControlFormat, openRouterRouting, vercelGatewayRouting
- Auto-detection from baseUrl; explicit overrides for non-standard endpoints

**Retry Logic (src/provider-runtime/operation-retry.ts)**:
- `isTransientProviderOperationError(error, message)` inspects HTTP status (500/502/503/504), error name/code/cause chain for transient signals (ECONNRESET, ETIMEDOUT, TimeoutError)
- `providerOperationRetry(error, maxRetries=2, baseDelayMs=250, maxDelayMs=1000, shouldRetry?)` runs exponential backoff with domain-specific retry callback

---

## Hermes (Python)

Hermes implements **protocol-specific adapter modules** with **lazy imports**, **pre-configured fallback chains**, and **tiered model metadata caching**.

### Core Architecture

**Adapter Modules (agent/anthropic_adapter.py, bedrock_adapter.py, gemini_native_adapter.py, codex_responses_adapter.py)**:
- No global registry; instead, each protocol gets a dedicated module with handler functions
- `_get_anthropic_sdk()` uses sentinel value to cache SDK import (loads only when Anthropic provider activated)
- anthropic_adapter exports: `build_anthropic_client(model, api_key)`, `anthropic_messages_request(...)`, thinking-level maps (ADAPTIVE_EFFORT_MAP: low/medium/high/xhigh/max), output-limit table (_ANTHROPIC_OUTPUT_LIMITS), legacy-thinking classifier (_LEGACY_MANUAL_THINKING_CLAUDE_SUBSTRINGS)
- bedrock_adapter: `_get_bedrock_runtime_client(region)`, `_get_bedrock_control_client(region)` caching boto3 clients; stale-connection detection via `_STALE_CONNECTION_SIGNALS` (ConnectionClosedError, ProtocolError)
- gemini_native_adapter: `bare_gemini_model_id()`, `is_native_gemini_base_url()`, `probe_gemini_tier(api_key, base_url, model)` (returns "free" | "paid" | "unknown" by checking x-ratelimit-limit-requests-per-day header)
- codex_responses_adapter: `_classify_responses_issuer()` stamps encrypted_content with issuer (xai_responses, github_responses, codex_backend); `_chat_content_to_responses_parts()` converts OpenAI-format multimodal content to Responses API format

**Capability Tables (agent/anthropic_adapter.py)**:
- `THINKING_BUDGET = {"xhigh": 32k, "high": 16k, "medium": 8k, "low": 4k}` hardcoded per effort level
- `ADAPTIVE_EFFORT_MAP`: minimal→low (all models), low/medium/high/xhigh/max (4.7+), max→max (4.6 which lacks xhigh)
- `_ANTHROPIC_OUTPUT_LIMITS` = {model: max_tokens}: claude-opus-4-8 (128k), claude-opus-4-7 (128k), claude-opus-4-6 (128k), claude-sonnet-4-6 (64k), claude-opus-4-5 (64k), minimax (131k), qwen3 (65536), DEFAULT=128k
- `_get_anthropic_max_output(model)` substring-matches model id (longest-prefix wins) against table; normalizes dots to hyphens so "claude-opus-4.6" matches "claude-opus-4-6" key

**Model Metadata Registry (agent/models_dev.py)**:
- `fetch_models_dev(force_refresh=False)` implements 4-stage cache hierarchy:
  1. In-memory cache if <1h old
  2. Disk cache (~/.hermes/models_dev_cache.json) if <1h old by mtime — **no network call**
  3. Network fetch to https://models.dev/api.json
  4. Fallback to ANY available disk cache (even stale) with 5-min grace period
- `ModelInfo` dataclass: id, name, family, provider_id, reasoning, tool_call, attachment (vision), context_window, max_output, cost_input/output/cache_read/cache_write, knowledge_cutoff, status, interleaved
- `PROVIDER_TO_MODELS_DEV` mapping: hermes provider names (anthropic, openai, gemini, etc.) → models.dev IDs (~80 entries); reverse-mapped on first call

**Fallback Chain Routing (agent/conversation_loop.py)**:
- `agent._fallback_chain = [{'provider': 'p1', 'model': 'm1'}, ...]` pre-configured ordered list
- `agent._try_activate_fallback()` increments `_fallback_index` to switch to next fallback
- Triggered on: HTTP 429 (rate limit), empty/malformed response (eager fallback at line 1293), max retries (line 1368), rate-limit classified via error_classifier.classify_api_error() or response-time heuristic
- `_sync_failover_system_message()` re-stamps system prompt for new model; retry_count/compression_attempts reset to 0

**Provider Prefix Stripping (agent/model_metadata.py)**:
- `_PROVIDER_PREFIXES` frozenset (~50 entries): openrouter, anthropic, openai, gemini, ollama, deepseek, qwen, kimi, github, etc.
- `_OLLAMA_TAG_PATTERN = r"^(\d+\.?\d*b|latest|stable|q\d|fp?\d|instruct|chat|coder|vision|text)"` matches Ollama quantization/variant tags
- `_strip_provider_prefix(model)` removes recognized prefix UNLESS suffix matches OLLAMA_TAG_PATTERN (preserves 'qwen:7b', 'qwen3.5:27b')

**Request Context Estimation (agent/chat_completion_helpers.py)**:
- `estimate_request_context_tokens(api_payload)` handles two API shapes:
  - **Chat Completions**: dict with 'messages' key; sum message + tools chars
  - **Responses API**: dict with 'input' key; sum input + instructions + tools chars
- Divides total chars by 4 as rough token estimate
- Used by stale-call detector: if estimated context << request size, timeout scaling doesn't fire (context-aware)

---

## Comparative Analysis

| Theme | OpenClaw | Hermes |
|-------|----------|--------|
| **Registry Pattern** | Typed global `Map<Api, ApiProvider>` with sourceId lifecycle | Protocol-specific modules with lazy imports; no global registry |
| **Capability Discovery** | Schema-driven: `thinkingLevelMap` on Model; explicit null for unsupported | Table-driven: hardcoded dicts (_ANTHROPIC_OUTPUT_LIMITS, THINKING_BUDGET); manual updates per release |
| **Fallback Handling** | Single model at a time; array fallbacks[]in config (src/llm/types suggests primary + fallbacks structure) | Pre-configured `_fallback_chain` array; simple index increment + system-prompt re-sync |
| **Model Normalization** | Explicit per-provider normalizers with migration paths | Provider prefix stripping with Ollama tag preservation |
| **Source Authority** | Four-tier hierarchy (config > manifest > cache > provider-index) with numeric ranks | No explicit tier; Hermes config is primary by design |
| **Error Detection** | Recursive error.cause chain inspection; status/code/name polymorphism | Error classifier enum (FailoverReason); response-time heuristic (fast <10s → rate-limit suspected) |
| **Metadata Caching** | (Not shown in deep read; likely per-provider) | models_dev (community registry) + openrouter (provider-specific); disk cache hits on cold-start |
| **Model ID Resolution** | Substring matching for version detection (Claude adaptive thinking checks) | Longest-prefix table lookup (claude-opus-4-8 beats claude-opus-4) |

---

## Distinctive Mechanisms

**OpenClaw's Strengths**:
1. **Plugin-aware registry** with sourceId-based lifecycle (register/unregister all adapters from one plugin)
2. **Authority tiers** for deterministic conflict resolution when multiple sources describe same model
3. **Explicit null mappings** in thinkingLevelMap to block unsupported levels without silent downgrades
4. **Recursive error.cause inspection** for deeply-wrapped SDK exceptions
5. **Per-model compat flags** allowing different endpoints (Together, z.ai, Vercel) to declare feature subsets

**Hermes's Strengths**:
1. **Lazy adapter imports** reduce startup overhead (anthropic SDK only loaded if Anthropic provider used)
2. **Tiered disk caching** (in-mem → fresh disk → network → stale disk) enables ~500ms faster cold-start
3. **Ollama tag preservation** logic prevents ambiguity between provider prefixes and model quantization tags
4. **Rate-limit detection heuristic** (fast response <10s) catches rate-limits that don't set 429 status
5. **Pre-configured fallback chains** with transparent model switching and system-prompt re-sync

---

## The Cleverest Bits

**OpenClaw**: The **authority tier system** is deceptively simple (4 numeric ranks) but solves a real problem: when bundled manifests, user config, runtime discovery, and cached snapshots all describe the same provider/model, which wins? Assigning numeric authority to sources + using merge keys ensures deterministic deduplication without requiring per-source-pair merge logic.

**Hermes**: The **tiered cache hierarchy with stale fallback** is elegant: disk cache hit on cold-start eliminates 500ms network roundtrip for catalog metadata that changes infrequently; stale fallback (5-min grace period) tolerates transient network glitches without blocking agent initialization. This is especially valuable in cloud/container environments where startup speed matters.

Both systems reason about **provider heterogeneity** but in different ways:
- OpenClaw treats adapters as pluggable types (8 canonical APIs, each with stream + streamSimple)
- Hermes treats adapters as protocol-specific modules with lazy imports and handcoded capability tables

OpenClaw's **per-model compat flags** allow agents to auto-adapt to OpenAI-compatible variants (Together, z.ai, OpenRouter) without recompiling; Hermes hardcodes provider-specific logic, accepting the cost of manual updates when new providers launch.


# 7. Reliability — error taxonomy, retry, rate limits, iteration budget

_9 capabilities · 20 files read_

## Reliability Theme: Error Taxonomy, Retry, Rate Limits, Iteration Budget

### Hermes-Agent Approach (Python)

Hermes implements a **heavyweight, provider-aware error taxonomy** centered on `FailoverReason` (27 categories) in `error_classifier.py`. The classification pipeline is a priority-ordered sequence:

1. **Provider-specific patterns first** (lines 536–669): thinking block signatures, long-context tier gates, Anthropic OAuth 1M-context rejections, llama.cpp grammar failures, xAI Grok subscription blocks. These are vendor-specific and must run before generic status codes, because a 400 for "thinking signature invalid" is retryable but must not be downgraded to a generic `format_error`.

2. **HTTP status code + message refinement** (lines 672–899): 401/403 (auth), 402 (402-specific disambiguator), 404 (model-not-found or provider-policy-blocked or generic 404), 413 (payload-too-large), 429 (rate-limit), 400 (context-overflow-aware fallback), 500–502 (request-validation patterns override generic server-error), 503/529 (overloaded).

3. **Message pattern matching** (lines 1143–1261): 40+ pattern lists (billing, rate-limit, context-overflow, auth, format-error, etc.) checked when status codes are absent or ambiguous. Examples: `"insufficient credits"`, `"rate limit exceeded"`, `"context length exceeded"`, `"prompt was flagged by our safety"`.

4. **SSL/TLS vs server-disconnect heuristics** (lines 701–732): SSL alerts mid-stream are transport hiccups (classified as `timeout`, not `context_overflow`). Server disconnects + large session → `context_overflow` with `should_compress=True` (attempt decompression recovery); server disconnects + small session → `timeout` (connection retry). This prevents false-positive compression requests on a network hiccup.

The distinctive innovation is the **two-phase 429 disambiguation** in `_classify_402` (lines 902–928): 429 + "usage limit" + "try again in 5m" = `rate_limit` (transient quota window); 429 + "usage limit" + no reset info = `billing` (hard credit exhaustion). This one distinction prevents retry amplification: a transient rate-limit 429 goes into backoff+rotate, a billing 429 goes into abort+fallback, not both.

**Retry mechanics** use `jittered_backoff` (retry_utils.py): delay = min(5 * 2^(attempt–1), 120) + uniform(0, 0.5*delay). The jitter seed is decorrelated via XOR with a process-global monotonic counter, ensuring concurrent sessions (e.g., 10 agents in the same process all hitting 429 on the same provider at t=5s) spread their retries across a 1–2 second window instead of all re-hammering at once.

**Rate limit tracking** (rate_limit_tracker.py) captures x-ratelimit-* headers (12 variants per Nous/OpenAI spec) into a RateLimitState with 4 buckets (RPM, RPH, TPM, TPH). The `remaining_seconds_now` property adjusts reset_seconds for elapsed time since capture, so the /usage command can display "resets in 2m 34s" instead of stale "resets in 3m 12s".

The **Nous cross-session rate-limit breaker** (nous_rate_guard.py) solves a multiplexing problem: Nous proxies 50+ upstream providers. A 429 from Nous can mean (a) the caller's own RPH bucket is exhausted, or (b) the specific upstream (DeepSeek) is overloaded. `is_genuine_nous_rate_limit()` discriminates: if remaining==0 AND reset >= 60s, it's (a) block all Nous; if reset < 60s, it's (b) just retry or switch models. This prevents a brief DeepSeek outage from blocking all Nous calls for 1 hour.

**Turn-level retry state** (turn_retry_state.py) holds 16 one-shot guards preventing re-entrance: `thinking_sig_retry_attempted`, `codex_auth_retry_attempted`, `image_shrink_retry_attempted`, etc. Fresh instance per API call attempt. Each recovery branch fires at most once; if credential refresh fails, the loop doesn't retry it again in the same turn.

**Per-agent iteration budgets** (iteration_budget.py) cap conversation turns: parent at max_iterations (default 90), each subagent at delegation.max_iterations (default 50). Budgets are independent (parent + subagent can exceed parent cap), and execute_code calls are refunded (programmatic tool dispatch doesn't compete with user-facing turns).

### OpenClaw Approach (TypeScript)

OpenClaw implements a **lightweight, pattern-based error detection** in `errors.ts` and `diagnostic-error-metadata.ts`, designed for fallback orchestration rather than recovery orchestration.

`detectErrorKind()` (errors.ts, lines 164–199) returns a simple 5-value enum: `"refusal" | "timeout" | "rate_limit" | "context_length" | "unknown"`. Pattern matching is generic ("refusal", "timeout", "rate limit") with no provider awareness, because the goal is to feed fallback-decision logic ("if refusal, try a different model/provider"), not to control retry internals (OpenClaw doesn't retry; it falls back).

Error metadata extraction (diagnostic-error-metadata.ts) focuses on **diagnostics**: `diagnosticHttpStatusCode()` (safe status code extraction), `diagnosticErrorFailureKind()` (classify transport failures: "timeout", "connection_reset", "connection_closed", "aborted"), `diagnosticProviderRequestIdHash()` (extract and hash provider request IDs for OTel without leaking raw IDs). The cause-chain traversal (via `findDiagnosticErrorProperty`) avoids triggering userland getters.

The distinction: Hermes treats errors as *internal state* (classify, decide recovery action, retry). OpenClaw treats errors as *diagnostic signals* (categorize, log, feed to fallback orchestrator). Hermes builds its own retry logic; OpenClaw delegates retry to providers' SDKs (OpenAI SDK retries internally) and uses error categorization to decide when to switch providers.

**Model fallback** (model-fallback.ts, lines 143+) is the retry equivalent: when a model call fails, iterate through fallback candidates (alternate providers, alternate models, credential pools), applying policy rules (cooldown probes for rate_limit, skip failed candidates, respect session suspension). The loop is external to the model call, not internal to it.

**Tool result budgets** (budget_config.py, unique to Hermes) scale to model context: small model (65K tokens) gets ~10K per-result budget (15% of window), large model (200K+ tokens) stays at fixed 100K (capped to stay byte-identical). This prevents a single tool result from consuming the entire context window on a small model.

### Head-to-Head Comparison

| Aspect | Hermes | OpenClaw |
|--------|--------|----------|
| **Error Categories** | 27 detailed FailoverReason values | 5-value ErrorKind enum |
| **Classification Depth** | Status code + message + provider context | Generic pattern matching |
| **Retry Orchestration** | Built-in retry loop with backoff, 429 disambiguation, per-turn guards | Delegated to provider SDKs + external fallback loop |
| **Rate Limit Awareness** | Parses x-ratelimit-* headers, tracks 4 buckets per provider, Nous cross-session breaker | Passive: logs rate-limit errors, lets fallback logic handle |
| **Iteration Control** | Per-agent budget (independent subagent budgets, refunded execute_code) | Per-message budget (not per-iteration); not shown in openclaw files |
| **Jitter Strategy** | Decorrelated jitter via XOR + process-global counter | No built-in retry (SDK handles); fallback has no jitter visible |
| **One-Shot Guards** | 16 boolean flags per turn prevent re-entrance | Pattern-based, no state needed |
| **Context Scaling** | Tool result budgets scale to window size | Not present in scanned files |

### Cleverest Mechanisms

**Hermes' 429 disambiguation** (error_classifier.py, lines 902–928): A single 429 response carries 12 x-ratelimit-* headers that tell you the reset window. A 429 with "usage limit" + "try again in 5m" (transient signal) is a periodic quota reset, not exhaustion. A 429 with "usage limit" but no reset time is hard credit exhaustion. The classifier checks for both signals in the message and decides: if transient signals present, it's `rate_limit` (backoff+rotate); if absent, it's `billing` (abort+fallback). This one field lets the retry loop avoid burning provider credits on a problem that a different provider could solve.

**OpenClaw's cause-chain + safe extraction** (diagnostic-error-metadata.ts, lines 43–60, 164–175): Many SDKs wrap errors (grammY HttpError wraps http.ClientError in .cause). Instead of `str(error)` (which loses context), the code recursively walks .cause + .error properties, using `Object.getOwnPropertyDescriptor` (avoids userland getters), and stops at max depth 5. This surfaces the real transport error without side effects and handles SDKs that mutate error messages.

**Nous' transient-vs-genuine breaker** (nous_rate_guard.py, lines 192–244): Distinguishing a 5-second upstream blip from a real 60-minute account quota exhaustion prevents cascading failures. The signal is: if remaining==0 AND reset >= 60s, it's real; if reset < 60s, it's transient. A second signal (last-known-good state from the previous successful call) can confirm: if the last bucket was already near-empty with a long reset window, the current 429 is a continuation of (a), not a new (b).


# 8. Billing & Cost — usage accounting, projection, credits, budgets

_16 capabilities · 17 files read_

# Billing & Cost Accounting: OpenClaw vs Hermes

## OpenClaw: Static-per-Session Session Cost Ledger

**Architecture**: OpenClaw treats billing as a **post-hoc session cost ledger**. Cost estimation happens offline after a session completes, persisted in `.usage-cost-cache.json`. Token counts are captured during inference (NormalizedUsage in /src/agents/usage.ts), normalized from provider-specific shapes (Anthropic's cache_read_input_tokens vs OpenAI's prompt_tokens_details.cached_tokens). Model pricing is loaded from a three-tier source stack: local config (models.json), plugin manifests (modelCatalog providers), and external APIs (OpenRouter /v1/models, LiteLLM GitHub). Cost breakdown is per-token-type: `input × input_cost + output × output_cost + cacheRead × cache_read_cost + cacheWrite × cache_write_cost` (all per-million, divided by 1M). Session summaries (in SessionCostSummary) include daily breakdown, per-model usage, UTC quarter-hour granularity, and latency stats.

**Cost Caching Strategy**: `.usage-cost-cache.json` (USAGE_COST_CACHE_VERSION=4) holds per-file entries with mtimeMs + pricingFingerprint to detect stale caches when model costs change. On scan of thousands of sessions, checkpoints every 256 files or 5s to bound serialization cost. Cache invalidation on version mismatch is automatic.

**Live Usage Display** (Status Command): OpenClaw fetches provider usage snapshots on-demand via plugin hooks (provider-usage.load.ts). Each provider returns a UsageSnapshot with windows (rate-limit percentages + reset times). Timeout of 3.5s per provider, filtered to only show providers with windows OR error-free status. This is a separate path from cost accounting—status shows rate limits, not cumulative spend.

**Tiered Pricing Support** (Future-Proofed): ModelCostConfig allows optional tieredPricing array (range: [start, end), input/output/cache rates per tier). estimateUsageCost() routes tiered calculations to computeTieredCost() (signature present, implementation deferred). Flat rates serve as fallback.

**Gateway Billing Error Attribution**: When inference fails (insufficient credits, rate limit), the error is decorated with provider + model via embedded-agent-subscribe, so users see "Anthropic (claude-3-5-sonnet): insufficient credits" instead of a bare API message.

---

## Hermes: Real-Time Credits Tracking + Portal Integration

**Architecture**: Hermes implements **real-time per-inference credits tracking**. Every Nous response includes x-nous-credits-* headers (version, remaining_micros, subscription_micros, subscription_limit_micros, paid_access, etc.). These headers are parsed once per response (parse_credits_headers() in credits_tracker.py) into a CreditsState dataclass. The state tracks subscription used_fraction (computed as (limit - subscription) / limit), which drives escalating notices: 50% (info), 75% (warn), 90% (warn). Depletion is keyed off `paid_access == False`, never `remaining == 0`, to avoid false positives when balance rolls to zero mid-period. The session maintains a latch dict to gate cold-start false positives and track band crossings.

**Pricing Engine** (usage_pricing.py): Canonical CanonicalUsage {input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens}. normalize_usage() handles Anthropic (cache_read_input_tokens), Codex (input_tokens_details.cached_tokens), and OpenAI (prompt_tokens_details.cached_tokens) cache semantics—detector logic differentiates "cache included in prompt" vs "pre-subtracted"—and subtracts accordingly. Pricing lookup layered: (1) _OFFICIAL_DOCS_PRICING snapshot (40+ models: Claude, GPT-4o, Gemini, Bedrock, MiniMax, DeepSeek); (2) endpoint /models API (Nous, OpenAI-compatible, OpenRouter); (3) None (unknown). estimate_usage_cost() is pure Decimal math: fail-hard on missing pricing for any non-zero bucket (returns CostResult with status='unknown', not partial estimate).

**Portal Integration** (account_usage.py, billing_view.py): build_nous_credits_snapshot() fetches from Nous Portal /account (OAuth), renders subscription gauge (% used) when monthly_credits cap and remaining balance are known. Includes rollover + top-up magnitudes. build_credits_view() reuses the same fetch, filters out portal-affordance lines (/credits CTA), returns balance block + identity line + top-up URL. build_billing_state() fetches /api/billing/state for balance, card, monthly cap, auto-reload config. All Decimal parsed (never float), money strings preserved verbatim from server (never re-parsed).

**Expensive Model Guard** (model_cost_guard.py): Thresholds $20/M input or $100/M output. Pricing source priority: (1) ModelInfo.cost_* (preloaded from models.dev); (2) get_pricing_entry() (snapshot + API); else silent pass. Returns ExpensiveModelWarning with formatted costs + source, or None (unknown pricing is not warned).

**Terminal Billing Client** (nous_billing.py): HTTP client for /api/billing/* (charge, poll charge, auto-reload). Fail-loud exception hierarchy: BillingError {status, error, portal_url, retry_after, payload}, BillingScopeRequired (403 → triggers scope step-up OAuth), BillingRateLimited (429/503 → includes retry_after), BillingAuthError (401 → not logged in). Token cached 30s to avoid re-locking auth store on charge-poll loop.

---

## Comparative Design Insights

### 1. **Money Representation**
- **OpenClaw**: Uses float (with formatUsd() for display; tiny costs shown to 4dp).
- **Hermes**: Strict Decimal throughout. Micros (int) for transactional data; *_usd strings preserved verbatim from server (display-only, never re-parsed). TypeGuard[float] on _is_finite_num() to reject NaN/Infinity.
  - **Winner**: Hermes. Precision is load-bearing for billing; float round-trip artifacts ($142.50 → float → $142.49999) are unacceptable.

### 2. **Usage Normalization**
- **OpenClaw**: normalizeUsage() detects cache-include vs pre-subtract via marker fields (cached_tokens, *_details presence).
- **Hermes**: Same logic, but adds fallback to Anthropic top-level fields (cache_read_input_tokens) when OpenAI-compatible proxy (OpenRouter, Cline) exposes both. Reasoning kept separate.
  - **Winner**: Hermes. Proxy fallback covers real-world router scenarios.

### 3. **Cost Estimation**
- **OpenClaw**: estimateUsageCost() returns number | undefined. Tiered pricing future-proofed but not implemented. Per-bucket breakdown in CostUsageTotals.
- **Hermes**: estimate_usage_cost() returns CostResult {amount_usd: Decimal, status, source, label, notes}. Status = included/estimated/unknown. Fail-hard on missing pricing (any bucket → unknown, not partial).
  - **Winner**: Hermes. Explicit status + notes enable caller to decide confidence. Fail-hard prevents silent under-estimates.

### 4. **Real-Time Credits (Nous)**
- **OpenClaw**: No built-in Nous header parsing. Cost is calculated post-hoc.
- **Hermes**: parse_credits_headers() + evaluate_credits_notices() pipeline. Escalating band notices (50%→75%→90%), depletion (paid_access=False), grant_spent, restored (TTL). Latch gate prevents cold-start false positives. Free-model suppression (free-tier can't run out of credits).
  - **Winner**: Hermes. Real-time UX. Users see 90% warning before cutoff. Free-tier suppression prevents user confusion.

### 5. **Portal Account Display**
- **OpenClaw**: No built-in portal fetching. Usage comes from provider plugin hooks (status command), not account balance.
- **Hermes**: build_nous_credits_snapshot() + build_credits_view() + build_billing_state(). Subscription gauge, top-up magnitudes, monthly cap, auto-reload config, card on file. Fail-open (None or empty BillingState) on network failure.
  - **Winner**: Hermes. Complete financial picture (balance, cap, auto-reload, card). Single fetch + parse used by CLI panel, TUI, /usage, and /credits surfaces identically.

### 6. **Model Cost Guardrail**
- **OpenClaw**: No guardrail.
- **Hermes**: expensive_model_warning() thresholds ($20/M input, $100/M output). Only warns when pricing is known. models.dev priority. Typo suggestion (gpt-5.5-pro → gpt-5.5).
  - **Winner**: Hermes. Prevents accidental $1k+ OpenAI runs. Typo detection saves support.

### 7. **Pricing Sources**
- **OpenClaw**: models.json (config) + plugin manifests + external APIs (OpenRouter, LiteLLM). Cache with 24h TTL.
- **Hermes**: _OFFICIAL_DOCS_PRICING snapshot (40+ models) + provider /models APIs + hardcoded fallbacks. TypeGuard + is_finite_num() guards against NaN/Infinity in JSON.
  - **Winner**: OpenClaw for extensibility (plugin stack, external sources). Hermes for stability (snapshot is ground truth, APIs are best-effort).

### 8. **Session Cost Persistence**
- **OpenClaw**: .usage-cost-cache.json with checkpoint logic (256 files / 5s). Fingerprint on pricingFingerprint invalidates stale caches. Quarter-hour granularity (96 buckets/day). Daily model usage + latency stats.
- **Hermes**: No session cost ledger. Focus is inference-time balance tracking (Nous) + terminal billing (portal).
  - **Winner**: OpenClaw. Long-term cost analysis, per-session ROI, historical aggregates.

### 9. **Error Attribution**
- **OpenClaw**: Lifecycle errors decorated with provider + model.
- **Hermes**: errors (insufficient credits, rate limit) are provider-specific exceptions (BillingError subclasses), included in agent notices.
  - **Winner**: Hermes. Explicit exception types enable different handlers (retry-able rate-limit vs terminal depletion).

### 10. **Fail-Open Policy**
- **OpenClaw**: provider-usage.load.ts filters errors (only show if windows OR summary OR no-error). Cache stale gracefully.
- **Hermes**: Explicit fail-open builders (build_billing_state, nous_credits_lines). Fail-loud HTTP client (nous_billing.py) expects callers to catch and degrade.
  - **Winner**: Hermes. Clear separation: builders fail-open (no crash), low-level client fail-loud (explicit errors). Callers decide UX.

---

## Cleverest Mechanisms

**1. Hermes CreditsState used_fraction Property** (credits_tracker.py:137–150)
```python
@property
def used_fraction(self) -> Optional[float]:
    if not isinstance(self.subscription_limit_micros, int):
        return None
    if self.subscription_limit_micros <= 0:
        return None
    used = self.subscription_limit_micros - self.subscription_micros
    return max(0.0, min(1.0, used / self.subscription_limit_micros))
```
Guarded on limit field, not denominator_kind. Clamps [0, 1] to handle debt (negative subscription). Returns None if limit missing/zero—elegant fallback to magnitude-only display.

**2. Hermes Cache Subtraction Logic** (usage_pricing.py:762–796)
Dual-detect + dual-fallback: OpenAI-style prompt_tokens_details.cached_tokens OR Anthropic cache_read_input_tokens, conditional on marker (is cached_tokens present?). Works across proxy boundaries without blind spots.

**3. Hermes Band Escalation Gate** (credits_tracker.py:276–332)
Latch dict {seen_below_90, usage_band} prevents spurious notices when session opens mid-range. Band replacement (not stacked notices). Top-up suppression: when purchased_micros > 0, set current_band = None (switch from gauge to info notice). Single line changes, others clear. Elegant state machine.

**4. OpenClaw Session Cost Cache Checkpoint** (session-cost-usage.ts:89–90)
Bounds serialization cost on 10k+ files: checkpoint every 256 files OR 5s, whichever is smaller. Fingerprint on pricingFingerprint (not mtime) detects price-change invalidation. Atomic file replacement (replaceFileAtomic) prevents corruption.

**5. Hermes Portal Base URL Resolution** (nous_billing.py:108–125)
Layered precedence: env → state → default. E2E preview/staging deployment override via single env var, zero code change. Cached 30s to avoid re-locking on charge-poll loop.

---

**Summary**: OpenClaw is a **cost analytics system** (session ledger, historical aggregates, tiered pricing future-proofed, quarterly-hour precision). Hermes is a **real-time credit & payment system** (live balance tracking, escalating notices, terminal portal integration, guardrails). OpenClaw excels at post-hoc auditing; Hermes excels at preventing overspend and user confusion mid-session.


# 9. Memory Systems — vector/active memory, prefetch, wiki/vault, insights

_11 capabilities · 14 files read_

## OpenClaw vs. Hermes Memory Systems: Comparative Teardown

### High-Level Architecture

**OpenClaw** implements a multi-layer memory system spanning three major plugins:

1. **Memory Core** (`memory-core`) — Short-term recall tracking and cron-orchestrated promotion ("dreaming") into long-term markdown-based memory
2. **Active Memory** (`active-memory`) — Real-time prefetch injection with prompt style differentiation and circuit breaker protection
3. **Memory Wiki** (`memory-wiki`) — Obsidian-compatible vault compiler with claim-level confidence tagging and digest-based prompt injection

Supporting these are vector search (`memory-lancedb`) and a hybrid keyword+embedding search engine with temporal decay.

**Hermes** uses a simpler, more abstract approach:

1. **Memory Manager** — Orchestrator for pluggable external providers (Honcho, Hindsight, Mem0, etc.) plus a built-in provider, with background sync scheduling
2. **Memory Provider** — Abstract base class defining a standard lifecycle (initialize, prefetch, sync_turn, on_session_switch, on_pre_compress, on_memory_write)
3. **Insights Engine** — Query-time analysis of session history (tokens, cost, tool/skill usage, activity patterns)

### Data Flow & Recall Mechanisms

**OpenClaw**:
- User message triggers active-memory prefetch via subagent recall (timeout-bounded, cached, configurable query modes)
- Prefetch queries memory via hybrid vector+keyword search (FTS fallback if embedding unavailable)
- Search results scored by recency half-life, temporal decay applied post-merge
- Prefetched context fenced in `<memory-context>` tags, visible to agent
- Post-turn, short-term recall store records hit events (queryHash, recallDays, conceptTags) in JSON store
- Cron-driven dreaming phase sweeps recall store, ranks candidates by 6-component score (frequency, relevance, diversity, recency, consolidation, conceptual), applies phase-signal boosts, promotes top N into daily markdown
- Narrative generation (sync or detached subagent) writes dream diary entries

**Hermes**:
- Before turn: `prefetch_all()` calls provider.prefetch(query), returns merged context
- Background: `queue_prefetch_all()` submits next-turn prefetch to single-worker executor (non-blocking)
- Post-turn: `sync_all(user_content, assistant_content, messages)` queued to executor, serialized per-manager
- Providers register tools; manager routes tool calls via `_tool_to_provider` dict
- Lifecycle hooks (on_session_switch, on_pre_compress, on_memory_write) notify providers of state changes
- Insights extracted on-demand via SQL queries against session database (token counts, tool usage, cost estimation)

### Key Distinctive Features

**OpenClaw Strengths**:

1. **Multi-stage Memory Curation**: Dreaming separates passive recall tracking from active promotion. Short-term store (JSON) is lightweight; long-term (markdown) is human-readable and editable. Phases (light, REM, deep) preserve semantic context.

2. **Weighted Scoring with Retroactive Boosting**: Six-component score includes consolidation (entries already in MEMORY.md ranked higher) and conceptual (semantic theme tagging). Phase signals allow sleep cycles to retroactively boost qualifying entries post-hoc, without recompute.

3. **Prompt Style Differentiation**: Active memory offers 6 prompt modes (strict, balanced, contextual, recall-heavy, precision-heavy, preference-only) with declarative instructions per style. Preference-only optimizes for stable habits vs. one-off facts—meaningful UX difference.

4. **Wiki Compilation with Claim-Level Tagging**: Memory wiki tracks confidence, freshness, contradiction at claim granularity. Digest auto-prioritizes high-signal pages (contradictions, open questions, top claims) into bounded prompt sections without manual ranking.

5. **Circuit Breaker per Provider/Model**: Active memory circuit breaker prevents cascade failures on slow backends. Reset after cooldown, not forever—enables eventual recovery.

**Hermes Strengths**:

1. **Abstraction & Pluggability**: One interface, multiple backends (Honcho, Hindsight, Mem0). No core coupling to any specific provider. New providers drop into plugins/ directory.

2. **Background Sync Serialization**: Single-worker executor per MemoryManager serializes turn N before N+1 across all providers without external locking. Lazy creation avoids overhead for builtin-only setups.

3. **Skill Unwrapping**: Strips /skill scaffolding once, shared across provider fan-out. Providers never see prompt pollution; simplifies their logic.

4. **Cost Estimation & Insights**: Built-in session analysis tracks token consumption, models used, tool patterns, activity streaks. Supports budget tracking and self-serve usage reporting.

5. **Signature Inspection for Backward Compat**: `inspect.signature()` detects provider parameter shapes (messages kwarg optional, metadata positional vs. keyword). Enables schema evolution without breaking existing providers.

### Search & Indexing

**OpenClaw**:
- Hybrid vector+keyword search (MemoryIndexManager)
- FTS via SQLite for keyword fallback
- Optional embedding provider (local all-minilm or remote OpenAI)
- Temporal decay applied post-merge (exponential, configurable half-life)
- Embedding cache separates compute from storage (30s TTL per text hash)
- Two-table schema (VECTOR_TABLE, FTS_TABLE) enables independent tuning
- Search preflight checks scope/permissions

**Hermes**:
- No built-in search infrastructure
- Providers implement their own recall (Honcho: vector DB, Hindsight: whatever backend they use)
- Prefetch result is merged text; no ranking or deduplication at manager level

### Dreaming & Promotion

**OpenClaw**:
- Cron-driven short-term promotion (reconcileShortTermDreamingCronJob)
- Ranking: `score = frequency*0.24 + relevance*0.3 + diversity*0.15 + recency*0.15 + consolidation*0.1 + conceptual*0.06`
- Recency: exponential half-life decay (default 14 days)
- Phase signals: light sleep boosts +6%, REM +9%, applied retroactively
- Concept vocabulary: auto-derived from snippet text (e.g., work, code, food themes)
- Output: markdown daily sections (##Light Sleep, ##REM Sleep, ##Deep Dreaming) with narrative
- Narrative: sync (blocks turn) or detached subagent (cron-compatible, async)

**Hermes**:
- No built-in dreaming or promotion
- on_pre_compress hook allows providers to extract summaries before context compression
- on_delegation hook notifies providers of subagent work
- Providers responsible for their own curation/summarization

### Configuration & Control

**OpenClaw**:
- Dreaming config: enable/disable, cron schedule, limit, minScore, minRecallCount, minUniqueQueries, recencyHalfLifeDays, maxAgeDays, maxPromotedSnippetTokens, verboseLogging, storage mode (inline/separate/both)
- Active memory: enabled per-agent, timeoutMs, queryMode (message/recent/full), promptStyle, toolsAllow, ciruitBreakerMaxTimeouts, cacheTtlMs, persistTranscripts
- Wiki: vault.path, context.includeCompiledDigestPrompt, source sync tracking

**Hermes**:
- memory.provider config key (e.g., "honcho", "hindsight", "builtin")
- Provider.get_config_schema() exposes provider-specific settings
- save_config(values, hermes_home) writes non-secret config to provider's native location
- env vars for secrets; get_config_schema() declares which fields are secret

### Most Clever Mechanism

**OpenClaw's Phase-Signal Retroactive Boosting**:
The dreaming system records phase signals (light sleep, REM sleep, deep dreaming invocations) as hit markers on short-term recall entries *during* sleep phases. Later, when `rankShortTermPromotionCandidates()` scores entries for promotion, it applies boost multipliers based on whether the entry was hit during a light sleep (+6% PHASE_SIGNAL_LIGHT_BOOST_MAX) or REM sleep (+9% PHASE_SIGNAL_REM_BOOST_MAX). This enables sleep phases to amplify memory consolidation *retroactively* without recomputing the entire recall store. The boost is time-gated (PHASE_SIGNAL_HALF_LIFE_DAYS) so old phase signals decay. This design is elegant: passive sleep cycles (which run frequently, low-latency) mark hot entries; promotion logic (expensive, runs less frequently) consumes those marks as guidance. Decouples the low-latency marking from the expensive ranking.

**Hermes's Single-Worker Executor Serialization**:
The background executor enforces turn-order serialization with zero locking. `MemoryManager._submit_background()` routes all async work (prefetch, sync) through a single ThreadPoolExecutor(max_workers=1). Provider A's turn N write completes before provider B's turn N+1 write touches the store. No per-provider locking, no external barriers, no deadlock risk. Fallback to inline execution if executor unavailable (at shutdown) preserves writes under resource exhaustion. This simplicity is compelling: one line (`executor.submit(fn)`) vs. custom lock trees.

---

### Summary

OpenClaw invests heavily in *in-process memory curation*: vector search, multi-phase dreaming, wiki compilation, prompt style tuning. It is a rich personal knowledge system. Hermes delegates memory entirely to *pluggable external backends* and focuses on *orchestration, cost tracking, and session lifecycle*. OpenClaw is "batteries included" for memory; Hermes is "pick your own" with standardized interfaces. For agents that demand fine-grained recall and human-readable memory artifacts, OpenClaw wins. For platforms needing multi-backend flexibility and cost visibility, Hermes's abstraction wins.


# 10. Dreaming, Curation & Skills — reflection, curator, bundles, marketplace

_11 capabilities · 14 files read_

## Comparative Teardown: Dreaming, Curation & Skill Lifecycle

### OpenClaw: Layered Memory Consolidation + Skill Workshop Authoring

**Memory consolidation (dreaming.md, active-memory/index.ts):** OpenClaw implements a three-phase background consolidation system separate from skill lifecycle. Light phase ingests daily signals into short-term staging (no durable write); Deep phase ranks candidates via six weighted signals (frequency 24%, relevance 30%, query diversity 15%, recency 15%, consolidation 10%, conceptual richness 6%) and appends to MEMORY.md only when minScore/minRecallCount/minUniqueQueries thresholds pass; REM phase extracts pattern summaries. The system is opt-in by default (disabled unless explicitly enabled), avoiding automatic memory bloat. Shadow trials provide optional report-only QA verdicts before promotion without mutating durable state. Dream Diary runs best-effort subagent turns appending narrative to DREAMS.md—human-readable output, deliberately excluded from promotion sources.

Active Memory (index.ts, ~3773 lines) handles bounded context injection: per-agent query modes (recent/message/full), configurable summary/turn/char limits, timeouts + circuit breakers (cool down 60s after 3 timeouts), tool allow-lists restricting agent actions in recalled context, subagent model overrides, and optional transcript persistence. This keeps memory injection safe and cost-controlled.

**Skill authoring & runtime (workshop/service.ts, runtime/refresh.ts, loading/workspace.ts):** Proposal system lets agents draft multi-file skill ideas before applying to workspace. Atomic proposal apply with rollback snapshots. File watcher (chokidar) monitors skill directories, deduped across agents sharing roots (one watcher per unique root, not per agent). Symlink validation prevents skill escape. formatSkillsForPrompt() generates XML <available_skills> with version hashes for mid-session re-read detection. Support directory filtering (references/, templates/, scripts/ are not themselves skills unless they have SKILL.md) prevents accidental skill inflation.

**The distinctive shape:** Memory consolidation is *entirely separate from skill lifecycle*—dreaming runs hourly on memory state, not on skills. Skills are authored via proposals + workshops, with strict file discovery exclusions. Active Memory is a plugin feature with circuit breakers and tool restrictions.

---

### Hermes: Inactivity-triggered Curator + Skill Bundling

**Skill curation (curator.py, ~1916 lines, curator_backup.py):** Runs inactivity-triggered, not cron-driven. When agent is idle AND interval_hours have elapsed (default 7 days), spawns forked aux-model review. Deterministic pass applies automatic state transitions: active → stale after stale_after_days (30 days default) → archived after archive_after_days (90 days default). Built-ins seeded on first sight so their inactivity clock starts NOW, not epoch, preventing mass-archive on first pass.

LLM consolidation pass (opt-in, DEFAULT_CONSOLIDATE=False) is umbrella-building not duplicate-finding. The curator's prompt (CURATOR_REVIEW_PROMPT, lines 365–504) instructs the model to: (1) identify PREFIX CLUSTERS of skills sharing keywords; (2) ask "what is the umbrella class these serve?" not "are they overlapping?"; (3) consolidate via MERGE INTO EXISTING UMBRELLA, CREATE NEW UMBRELLA, or DEMOTE TO REFERENCES/TEMPLATES/SCRIPTS. The model declares each consolidation as skill_manage(action='delete', absorbed_into=<umbrella>) or absorbed_into="". Classification logic (lines 808–936) reconciles three signals: (1) model-declared absorbed_into at delete time (authoritative); (2) model-declared consolidations in YAML block (validated against real destinations); (3) heuristic tool-call evidence (_classify_removed_skills reads skill_manage calls and looks for references). Built-in protection is explicit: protected PROTECTED_BUILTIN_SKILLS={'plan'} never touched, plus .curator_suppressed list persists pruned built-ins across hermes update re-seeds.

Snapshots (curator_backup.py) tar.gz the entire ~/.hermes/skills/ tree pre-run (excluding .curator_backups/ and .hub/), with companion manifest.json describing reason/time/size/file count. Rollback moves current tree aside, extracts chosen snapshot, optionally restores cron/jobs.json skill references. This makes consolidation undoable.

**Skill bundles (skill_bundles.py):** YAML files in ~/.hermes/skill-bundles/ load N skills under one slash command. Bundle wins over skill when slugs collide (/research invokes bundle if one exists, else skill). build_bundle_invocation_message() concatenates full skill bodies with activation notes. Missing skills are skipped + noted. Usage counters bumped per skill for telemetry. Hyphens/underscores treated interchangeably (Telegram compatibility).

**Skill usage telemetry (skill_usage.py):** Sidecar .usage.json keyed by skill name. Counters: use_count, view_count, patch_count; timestamps: last_used_at, last_viewed_at, last_patched_at, created_at. Provenance filter: agent-created flag set at creation, read from .bundled_manifest (seeded skills) and .hub/lock.json (hub-installed skills). Locked atomic writes (fcntl Unix, msvcrt Windows) prevent corruption. Curator queries is_agent_created() to filter candidates (never touches bundled/hub/protected built-ins).

**The distinctive shape:** Skill lifecycle is *entirely separate from memory*—no dreaming equivalent. Curation runs inactivity-triggered (not scheduled), with deterministic state transitions + optional LLM umbrella-building. Bundles are multi-skill aliases, not a skill authoring system. Usage tracking is sidecar + provenance, not embedded frontmatter.

---

### Comparison: Key Tensions & Cleverest Bits

| Dimension | OpenClaw | Hermes |
|-----------|----------|--------|
| **Memory consolidation** | Opt-in 3-phase (Light→REM→Deep) w/ weighted scoring (6 signals) + shadow trials | Separate from skill curation entirely |
| **Skill curation** | Proposal-based authoring (draft→apply→rollback) | Inactivity-triggered umbrella-building (reconcile 3 signals: declared→block→heuristic) |
| **Lifecycle automation** | File watcher + runtime refresh + snapshot versioning | State machine: active→stale→archived + optional LLM consolidation |
| **Bundle/composition** | Workshop proposals + support files | YAML bundles w/ slug dispatch (bundle-first) |
| **Telemetry** | Active-memory circuit breakers + transcript persistence | Usage sidecar (use/view/patch counters) + provenance tracking |
| **Trigger timing** | Scheduled cron (dreaming 0 3 * * *, defined by config) | Inactivity-triggered when agent idle + interval elapsed (7 days default) |
| **Rollback** | Proposal rollback (pre-apply snapshot) | Curator backup snapshots + cron job reference migration |
| **Built-in protection** | Bundled skills + plugin skills discoverable via root filtering | Protected PROTECTED_BUILTIN_SKILLS={'plan'} + .curator_suppressed persistence |

**Cleverest mechanisms:**

1. **Hermes' three-signal consolidation reconciliation (lines 808–936 in curator.py):** Cascade model-declared absorbed_into (at delete time, authoritative) → model-declared YAML block (validated against destinations) → heuristic tool-call audit (look for references in content). This lets the LLM declare intent at the moment of deletion (highest fidelity), but falls back to post-hoc YAML parsing and substring matching if the LLM got creative. The evidence chain is explicit and auditable.

2. **OpenClaw's version hashing in skill contract (formatSkillsForPrompt, skill-contract.ts):** Embeds promptVersion (deterministic hash of SKILL.md content) in XML so agent detects when a skill's instructions changed mid-session and re-reads it. Preamble tells agent exactly how to handle relative paths (skill-relative, not workspace-relative). Token-efficient (version hash, not full content).

3. **Hermes' inactivity-triggered scheduler with built-in protection (curator.py lines 219–269):** First-run behavior deliberately defers (doesn't run immediately after hermes update), seeding last_run_at to "now" and waiting one full interval. This prevents mass-pruning of newly-eligible built-ins on fresh install. Protected built-ins are never archived, and .curator_suppressed preserves that intent across updates.

4. **OpenClaw's active-memory circuit breaker (index.ts):** After N timeouts (default 3), cool down for 60s before retrying. Partial timeout grace (500ms) lets partial data through if LLM response arrives just after timeout. This prevents retry storms when memory backend is slow/unavailable, yet doesn't completely black-hole recalls.

Both systems reject automatic deletion (hermes archives, openclaw proposes then applies); both track provenance/authorship; both avoid polluting human-authored content with machine-generated state. Hermes' curation is more aggressive (class-level umbrella-building via LLM); OpenClaw's memory is more granular (six weighted signals, shadow trials). Neither system blocks the other—they solve different problems: OpenClaw consolidates *memory*, Hermes consolidates *skills*.


# 11. Sessions & State — persistence, lifecycle, crash recovery, isolation

_13 capabilities · 24 files read_

# Sessions & State: OpenClaw vs Hermes Comparative Teardown

OpenClaw (TypeScript) and Hermes (Python) both implement sophisticated session persistence and state machine systems to enable long-lived conversational agents across multiple messaging platforms. Despite architectural differences, they converge on core mechanisms: deterministic session key generation, reset policies, crash recovery, and async-safe concurrent message handling.

## Session Key Generation: Structural Determinism with Platform Pragmatism

**OpenClaw** (`/src/routing/session-key.ts`, buildAgentPeerSessionKey): Encodes agent:agentId:channel:peerKind:peerId with agent-scoped routing. Peer IDs are platform-specific: most lowercased for canonical lookup, but Matrix room IDs and Signal group IDs preserve case via opt-in CasePreservingPeerDescriptor (span: "segment" for single token, "tail" for opaque-with-colons). DM isolation uses dmScope enum (main/per-peer/per-channel-peer/per-account-channel-peer) for fine-grained control per channel plugin.

**Hermes** (`gateway/session.py`, build_session_key): Constructs agent:main:platform:chat_type:chat_id:thread:participant_id with WhatsApp-specific canonicalization via canonical_whatsapp_identifier() to collapse JID/LID alias flips. Thread handling defaults to shared (all participants in thread see same conversation) unless thread_sessions_per_user=True. DM fallback chain: chat_id > user_id_alt > user_id > bare per-platform sink—preventing cross-user history bleed when adapters lack stable chat_id.

**Key Difference**: OpenClaw allows per-channel opt-in for case preservation (plugin-declared), supporting both opaque IDs (Matrix `!room:server`) and regular ones in the same system. Hermes uses global config flags (group_sessions_per_user, thread_sessions_per_user) and platform-specific ID canonicalization (WhatsApp phone normalization). OpenClaw's approach is more extensible for heterogeneous channels; Hermes' is simpler for homogeneous multi-platform gateways.

## State Machine: Reset Policies & Lifecycle Flags

**Hermes** documents the full state machine explicitly (docs/session-lifecycle.md, gateway/session.py):
- SessionEntry flags: was_auto_reset (idle/daily expiry with user notice), is_fresh_reset (explicit /new without notice), suspended (hard wipe), resume_pending (soft recovery), expiry_finalized (cleanup completed).
- Evaluation order in get_or_create_session(): suspended > resume_pending > policy check > return existing.
- Reset policies are per-platform/chat_type: mode in {none, idle, daily, both}; idle deadline = updated_at + idle_minutes; daily deadline = today at at_hour.
- Distinct flags allow nuanced behavior: was_auto_reset fires context notice ("Session expired due to inactivity"), but is_fresh_reset skips notice and re-injects topic/skill metadata instead. reset_had_activity tracks whether old session had any turns for notice wording.

**OpenClaw** has distributed session lifecycle (session-lifecycle-events.ts, session.ts): emits SessionLifecycleEvent to listeners on session creation/linking, but does not explicitly document a centralized state machine. Session metadata is persisted via channel-specific handlers and inbound metadata recording.

**Key Difference**: Hermes explicitly names each state and documents transitions; OpenClaw distributes via listener pattern. Hermes' three-restart stuck-loop escalation (via restart_counts.json) prevents terminal loops where suspended sessions keep being created on every restart. OpenClaw relies on per-channel/plugin-specific reset logic.

## Crash Recovery & Resume Pending: Soft vs Hard Restart

**Hermes** implements a two-tier recovery system (gateway/run.py, docs/session-lifecycle.md):
1. **Startup check**: If no .clean_shutdown marker exists, gateway calls suspend_recently_active(max_age_seconds=120) to mark sessions updated in last 120s as resume_pending=True, resume_reason='restart_interrupted'.
2. **Stuck-loop detection**: _suspend_stuck_loop_sessions() reads restart_counts.json and suspends (not just marks resume_pending) sessions active across 3+ consecutive restarts, breaking the loop.
3. **Soft recovery**: resume_pending=True preserves existing session_id; agent auto-continues from that transcript.
4. **Hard recovery**: suspended=True forces new session_id; user gets clean slate.
5. **Auto-resume**: On next message, get_or_create_session() sees resume_pending and returns the entry without creating new session_id. Marking persists until the resumed turn completes successfully (clear_resume_pending() called post-turn).
6. **.clean_shutdown marker**: Written on graceful shutdown, skips suspend_recently_active() on next startup (sessions were already drained, no resumption needed).

**OpenClaw** has less explicit recovery documentation. Session lifecycle events are emitted, but the detailed crash recovery flow is distributed across channel plugins and session metadata writers.

**Key Difference**: Hermes' .clean_shutdown marker gates suspension logic, ensuring intentional restarts don't trigger unnecessary resumption. The two-tiered hard/soft distinction provides fine-grained control: stuck-loop sessions are hard-reset, but normal crash-interrupted sessions are soft-recovered, preserving user context.

## Multi-User Session Isolation & Shared Conversations

**Hermes** (gateway/session.py, is_shared_multi_user_session):
- DMs: never shared (always private).
- Threads: shared unless thread_sessions_per_user=True.
- Groups/channels: isolated unless group_sessions_per_user=False.
- When shared=True, system prompt omits fixed user name and instead notes "Multi-user {thread|session} — messages are prefixed with [sender name]." Individual sender names are injected as message prefixes by the gateway at turn-time, preserving prompt caching (system prompt is static).

**OpenClaw** (src/routing/session-key.ts, dmScope):
- Per-channel fine-grained control via dmScope parameter (main/per-peer/per-channel-peer/per-account-channel-peer).
- Allows plugins to declare isolation policy rather than global config.

**Key Difference**: Hermes uses global config defaults matching expected UX (groups isolated by default, threads shared). OpenClaw delegates to plugins. Hermes' prompt-caching preservation by injecting user names only in message content (not system prompt) is clever: ensures system prompt hash stays constant across multi-user turns.

## Background Expiry Watcher: Resource Cleanup Loop

**Hermes** (gateway/run.py, docs/session-lifecycle.md):
- _session_expiry_watcher() runs every 300 seconds.
- For each expired entry where expiry_finalized=False:
  1. Invoke on_session_finalize plugin hooks (e.g., Discord cleanup, notifications).
  2. Call _cleanup_agent_resources(agent) to close tool resources, shut down memory provider.
  3. Evict cached agent via _evict_cached_agent(key).
  4. Clear per-session overrides (_session_model_overrides, reasoning overrides).
  5. Mark expiry_finalized=True and persist.
- Per-entry retry counter (3 attempts) prevents infinite loops on persistent cleanup errors.
- Also sweeps idle agents beyond _AGENT_CACHE_IDLE_TTL_SECS (3600s / 1h), preventing unbounded cache growth in long-lived gateways (max 128 agents).

**OpenClaw** does not explicitly expose this background loop in the read files; cleanup is likely distributed across channel plugins.

**Key Difference**: Hermes' explicit per-entry retry counter (3 attempts) + force-mark prevents infinite retry on bad cleanup states. Separation of expiry_finalized from was_auto_reset ensures finalization runs exactly once even across restarts. Active process check prevents premature cleanup of sessions with background jobs running.

## Context Variables for Async Concurrency: Thread-Safe Session Isolation

**Hermes** (gateway/session_context.py):
- Replaces process-global os.environ with Python contextvars.ContextVar for task-local session state.
- ContextVars: _SESSION_PLATFORM, _SESSION_CHAT_ID, _SESSION_USER_ID, _SESSION_THREAD_ID, _SESSION_ID, _SESSION_MESSAGE_ID, _SESSION_ASYNC_DELIVERY, plus per-job cron delivery vars.
- set_session_vars() bulk-sets all at message handler entry; clear_session_vars() resets to empty string.
- Sentinel _UNSET pattern: contextvar defaults to _UNSET (never set); when set via set_session_vars(), it holds a value; when cleared, it holds ""; get_session_env() checks: if value is not _UNSET, return it (no fallback to os.environ); else fall back to os.environ (CLI/cron/test compat).
- Cron auto-delivery vars (_CRON_AUTO_DELIVER_PLATFORM, etc.) are separate slots set per-job so concurrent jobs don't clobber each other.

**OpenClaw** does not have explicit concurrent context variable documentation in the read files; likely uses lexical scoping / dependency injection for session state.

**Key Difference**: Hermes' contextvar + _UNSET sentinel pattern enables backward compatibility: old code (CLI, cron) omits contextvars and falls back to os.environ; new async code uses contextvars with per-task isolation. This solves a critical concurrency bug where two simultaneous messages would have their thread_id / chat_id clobbered in os.environ, causing wrong delivery and routing.

## Atomically-Safe Persistence & Startup Restore

**Hermes** (gateway/session.py, _save()):
- Atomic write: create temp file in sessions_dir, write JSON, fdopen + flush + fsync, then atomic_replace (platform-aware rename + sync).
- Sessions are loaded once at init via _ensure_loaded_locked(); mutations are in-memory dict + _save() on each state change.
- Startup restore: if no .clean_shutdown marker (crash indicator), calls suspend_recently_active() to mark recent sessions as resume_pending. Then synthesizes MessageEvents to restart agent turns for those sessions.

**OpenClaw** (src/channels/session.ts, recordInboundSession):
- Records session metadata via lazy-loaded inbound runtime (keep session writer out of channel startup paths that only need SDK types).
- Updates lastRoute with delivery context (channel, to, accountId, threadId, route) to enable follow-up routing.

**Key Difference**: Hermes' atomic temp-file-rename + fsync pattern ensures sessions.json is never partially written on power loss. The .clean_shutdown marker gates suspension logic, so intentional restarts don't trigger unnecessary recovery. OpenClaw's lazy-loaded inbound runtime is a cleaner dependency boundary.

## The Cleverest Mechanism: Three-Tier Recovery + Stuck-Loop Detection

Hermes' crash recovery stands out for its sophistication:
1. **Soft recovery** (resume_pending=True): Preserves session_id; agent auto-continues from transcript.
2. **Hard recovery** (suspended=True): Forces new session_id; user gets clean slate.
3. **Stuck-loop escalation**: After 3 consecutive restarts with the same session_key active, escalate from soft to hard. Prevents exponential restart cycles via filesystem-persisted restart_counts.json.

This three-tier approach gracefully degrades: first crash restores context (good UX), second crash still tries (maybe a transient error), third+ crash gives up and forces reset (prevents service degradation). The stuck-loop counter is simple but effective: a JSON file keyed by session_key tracking restart count, incremented on startup, decremented on successful turn.

No other message gateway architecture I'm aware of combines soft recovery + hard escalation this cleanly. OpenClaw's listener-based approach is more modular but less opinionated about recovery policy.


# 12. Multi-Agent & ACP — orchestration, sub-agents, supervisor, ledger

_11 capabilities · 12 files read_

## Multi-Agent & ACP Orchestration Teardown: OpenClaw vs. Hermes

### OpenClaw: Orchestration at the Bridge Layer

OpenClaw's architecture uses **ACP as the orchestration protocol** itself. The core innovation is the **AcpGatewayAgent** (`/Users/jinan/ai/openclaw/src/acp/translator.ts`), which translates ACP protocol requests (newSession, loadSession, prompt) into Gateway RPC calls. This creates a clean **request→response boundary**: each ACP call becomes a discrete Gateway invocation, with **event ledger** (`/Users/jinan/ai/openclaw/src/acp/event-ledger.ts`) recording SessionUpdate events for replay.

**Event Ledger (Persistent Storage)**:  
The ledger stores AcpEventLedgerEntry tuples (seq, at, sessionId, sessionKey, runId, update) in SQLite. On reconnect, the ledger is queried by sessionId (or sessionKey if ID is unknown) and replayed in order. Trimming enforces three constraints: max events per session (5k), max sessions (200), max serialized bytes (16MB). The distinctive feature is **completion flag**: sessions marked complete can be replayed atomically; incomplete sessions fallback to Gateway transcript. This dual-path recovery is essential because editor connections drop unpredictably.

**CodexSupervisor (Multi-Endpoint Fan-Out)**:  
When a single parent agent spawns multiple child agents (via spawn_agent tool), each child runs on a Codex app-server endpoint. The **CodexSupervisor** (`/Users/jinan/ai/openclaw/extensions/codex-supervisor/src/supervisor.ts`) maintains a map of JSON-RPC connections to each endpoint. Session listing happens in two phases: (1) query all loaded threads (live, real-time), (2) merge in stored threads (offline history) from each endpoint. Thread reads support lazy materialization (fall back if turns aren't ready). Turn steering resolves in-progress turnId by checking three sources: full thread.turns, summary API, turns/list endpoint.

**Native Subagent Monitor (Lifecycle Mirroring)**:  
For nested Codex subagents, the **CodexNativeSubagentMonitor** (`native-subagent-monitor.ts`) listens to Codex notifications and mirrors child completion into parent task runtimes. It maintains two state maps: ParentState (task runtime, delivery tracking) and ChildState (child turns, assistant messages, transcript path). When a child turn completes, the monitor reads the child's transcript JSONL file, finds task_complete/task_failed records, and delivers the completion to the parent via **deliverAgentHarnessTaskCompletion**. Delivery is deduplicated and retried on failure with exponential backoff.

**Policy & Dispatch Control**:  
ACP availability is gated by policy (`/Users/jinan/ai/openclaw/src/acp/policy.ts`): operators can disable ACP globally, disable only new dispatch (resume still works), or allow only specific agent IDs. This prevents rogue agents from being invoked and allows per-environment controls.

---

### Hermes: Orchestration via Direct Agent Invocation

Hermes takes the opposite approach: **AIAgent is the orchestration unit**, and ACP is a **transport adapter** on top of it. The **SessionManager** (`/Users/jinan/ai/hermes-agent/acp_adapter/session.py`) maps ACP sessions to in-memory AIAgent instances, persisting session state to SessionDB (~/.hermes/state.db) for durability.

**Session Persistence (Dual-Mode Storage)**:  
SessionState objects (session_id, agent, history, model, cancel_event) live in memory. SessionDB stores the conversation history (messages) as atomically-replaced rows (no partial updates). On process restart, get_session checks memory, then DB-restores if missing. Metadata (cwd, provider, api_mode, base_url) is JSON-serialized into model_config for portability. The distinctive pattern is **atomic message replacement**: a failed mid-transaction write rolls back to the previously persisted conversation, preventing corruption.

**Async Transport via Thread Pool**:  
The **entry point** (`acp_adapter/entry.py`) sets up logging (stderr only, stdout reserved for JSON-RPC), loads .env from ~/.hermes/, and starts the async event loop. **HermesACPAgent** wraps synchronous AIAgent in asyncio.to_thread calls using a ThreadPoolExecutor (max_workers=4). Tool execution callbacks (make_step_cb, make_tool_progress_cb) stream deltas back as ACP MessageChunk. This bridges the architectural gap: Hermes is synchronous; ACP clients are async.

**Multimodal Content Conversion**:  
ACP content blocks (TextContentBlock, ImageContentBlock, ResourceContentBlock, EmbeddedResourceContentBlock) are converted to OpenAI-compatible parts on-the-fly (`_content_blocks_to_openai_user_content` in server.py). Images are embedded as data URLs (base64). Files are read from disk, truncated to 512KB, and either inlined as text or marked binary-omitted. Path normalization handles Windows drive paths → /mnt/<drive>/... for WSL containers. This single conversion point makes multimodal behavior consistent across all ACP clients (Zed, VSCode, web).

**Auxiliary Provider Fallback Chain**:  
For auxiliary tasks (vision, compression, web extraction), **auxiliary_client** implements a resolution order: (1) user's main provider, (2) OpenRouter, (3) Nous Portal, (4) custom endpoint, (5) native Anthropic, (6) direct API providers. On HTTP 402 (credit exhausted), call_llm retries transparently. Interrupt protection (thread-local flag) marks atomic tasks as uninterruptible so mid-flight aborts don't trigger degraded fallbacks. OpenAI SDK is lazily imported via _OpenAIProxy to save 240ms cold-start.

---

### Comparative Summary

| Aspect | OpenClaw | Hermes |
|--------|----------|--------|
| **Dispatch Unit** | ACP request → Gateway RPC | AIAgent instance (in-process) |
| **Persistence** | Event ledger (SQLite) with replay | SessionDB (atomic message replacement) |
| **Multi-Agent** | CodexSupervisor (fan-out to multiple endpoints) | Single process, one AIAgent per session |
| **Subagent Tracking** | CodexNativeSubagentMonitor (async transcript polling) | Direct AIAgent method calls (synchronous) |
| **Policy Layer** | ACP-level (enable/disable/agent allow-list) | Config-level (provider fallback, model override) |
| **Transport** | JSON-RPC bridge over ACP protocol | Async event loop + thread pool executor |
| **Multimodal** | Content mapped by app-server (Codex native) | Content converted by HermesACPAgent on ingest |

**The Cleverest Bit**: OpenClaw's **completion flag + dual-path replay** (ledger vs. transcript fallback). On editor reconnect, if the event ledger says complete=true, the entire session is replayed atomically from events; if incomplete or missing, the Gateway transcript is fetched as a fallback. This handles the hard problem of reconnect: the client may have dropped mid-prompt, and the server may have partially recorded the turn. By marking sessions complete only when all events have been persisted, OpenClaw ensures clients never see half-conversations.

Hermes' **atomic message replacement** is equally elegant: every session save is a transaction that either fully commits or fully rolls back, preventing corruption even if the daemon crashes mid-write. Combined with per-session provider caching (each session remembers its provider choice), this allows users to switch providers without losing conversation context—a killer feature for cost-conscious deployments.


# 13. Gateway, Relay & Devices — connector, capability vault, node pairing

_24 capabilities · 24 files read_

# Gateway, Relay & Devices: OpenClaw vs Hermes Comparative Teardown

## OpenClaw Pairing Architecture

OpenClaw implements a **two-track pairing model**:

1. **Device Pairing** (ephemeral client sessions): Client sends `DevicePairRequestedEvent` with publicKey + metadata. Gateway approves via `DevicePairApproveParams`, minting role-bound tokens (e.g., 'bootstrap', 'admin'). Device auth is cryptographic: `buildDeviceAuthPayloadV3` constructs `v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily`, signed with privateKeyPem. Signature verification is byte-for-byte—metadata (platform, deviceFamily) is normalized lowercase pre-signature to prevent timing attacks. Tokens are stored per-device, per-role in host callbacks (`loadDeviceAuthToken`, `storeDeviceAuthToken`). Revocation is per-role: `DeviceTokenRevokeParams` zaps only that role's tokens; 'bootstrap' revocation doesn't touch 'admin'.

2. **Node Pairing** (durable registered devices): Node advertises capabilities + commands + permissions in `NodePairRequestParams`. Once approved, `NodeInvokeParams` enable idempotent command dispatch (idempotencyKey prevents duplicates on retries). Nodes drain queued work via `NodePendingDrainParams` and ACK consumed items. Pending work supports expiry (1s to 24h) and wake signaling (push notification to device). Presence heartbeats (`NodePresenceAlivePayload`) carry trigger reason ('silent_push', 'bg_app_refresh', 'significant_location', 'manual', 'connect') so the agent knows if the device woke naturally.

**Distinctive OpenClaw pattern**: Pairing codes are stored **plaintext** in the store (no hashing), because OpenClaw assumes a single-gateway setup and delegates rate-limiting + brute-force protection to the device pairing UI. Device metadata (displayName, platform, deviceFamily, remoteIp) is device-reported and persisted durably, surviving server restart. The device-pair plugin emits notifications and scoped QR codes per platform (Telegram + threadId, Discord + channelId, Slack + threadId).

---

## Hermes Relay & Multi-Instance Gateway Architecture

Hermes implements a **connector-gateway relay pattern** where the gateway is **stateless** and **multi-instance-scalable**:

### Relay Transport & WS Architecture

Gateway dials out to a connector over a **single persistent WebSocket per gateway** (`/relay` endpoint). The gateway authenticates the upgrade with `Authorization: Bearer <upgrade_token>` where `upgrade_token = base64url(gateway_id:exp:HMAC(gateway_id:exp, secret))`. Connector verifies and closes 4401 on mismatch.

The socket carries **newline-delimited JSON frames**:
- **Gateway → Connector (outbound)**: `{type: "outbound", requestId, action}` where action is `{op: "send"/"edit"/"typing"/"follow_up", chat_id, content, ...}`.
- **Connector → Gateway (inbound)**: `{type: "inbound", event: <MessageEvent>}` + `{type: "outbound_result", requestId, result}`.

Outbound actions block on per-request asyncio Futures (30s timeout per action). Multiple actions pipeline independently (action A doesn't block action B). Inbound arrives immediately (no polling).

### Multi-Instance Relay Bus

The connector runs **multiple platform adapter instances** (hot replica for load balance, per-tenant isolation). When a platform webhook arrives at **any instance**, it publishes via an internal **relay bus (Redis pub/sub, keyed by tenant)**. Every instance subscribes and routes the event to its **local sessions for that tenant**. Only the instance holding the **gateway's WS socket** pushes the inbound frame down it; other instances no-op.

This avoids N HTTP POST calls across instances—cross-instance delivery is a **single in-cluster Redis hop inside the connector trust domain**.

### Trust Boundary & Capability Vault (A2)

**Connector is the sole crypto/identity boundary.** Webhook signatures (Discord ed25519, Twilio HMAC, WeCom BizMsgCrypt) are verified at the connector edge. Shared-bot credentials (Discord interaction follow-up tokens, ~15min TTL) are **stripped at the edge and bound in a capability vault**, keyed by `(session_key, capability_kind, tenant)`.

When the agent wants to use a follow-up token:
1. Gateway calls `send_follow_up(session_key, kind='discord.interaction_token', content)`.
2. Connector resolves the real token from the vault.
3. Connector enforces tenant match (tenant B cannot wield tenant A's token).
4. If absent/expired, `success: false`—gateway has nothing to retry with.

**Gateway re-validates nothing.** Inbound is re-serialized (not byte-preserved) so the gateway trusts the connector's schema. This eliminates the requirement that gateway hold platform secrets—a major security win for hosted gateways.

### CapabilityDescriptor Handshake

At connect time, `RelayAdapter.connect()` calls `transport.handshake()` and receives a `CapabilityDescriptor` JSON object from the connector:

```python
@dataclass(frozen=True)
class CapabilityDescriptor:
    contract_version: int
    platform: str
    label: str
    max_message_length: int
    supports_draft_streaming: bool
    supports_edit: bool
    supports_threads: bool
    markdown_dialect: str
    len_unit: str  # "chars" | "utf16"
    emoji: str = "🔌"
    platform_hint: str = ""
    pii_safe: bool = False
```

The descriptor is **immutable** (frozen dataclass) and **forward-compatible** (unknown fields ignored, missing optionals fall back to defaults). `RelayAdapter` installs a message_len_fn based on `len_unit` ('chars' = Python `len()`, 'utf16' = UTF-16 code-unit counting for Telegram). If `markdown_dialect` is not 'plain' or '', `supports_code_blocks = True`.

**One generic adapter (`RelayAdapter`) fronts every platform.** No Discord-specific branching in the gateway. If the connector detects a new platform version with different chunking rules, only the descriptor changes; no gateway redeployment.

### SessionSource & Discriminator Invariants

Inbound MessageEvent includes a `SessionSource` with wire fields:
- **Always sent** (null ok): platform, chat_id, chat_type, chat_name, user_id, user_name, thread_id, chat_topic.
- **Conditional**: user_id_alt, chat_id_alt, guild_id, parent_chat_id, message_id.

Session key is built from discriminators:
- **Discord**: (guild_id, chat_id, thread_id, user_id)
- **Telegram**: (chat_id, thread_id, user_id)

**Guild_id is MANDATORY for Discord** to prevent server collision—get it wrong and two servers collapse into one session (High-severity risk per §3.1 of the contract). The connector's `build_session_key()` and the gateway's `build_session_key()` must produce the same hash, or sessions collide. Phase 1 stub tests assert known-input → known-key.

### Pairing System (Hermes Platform-Agnostic)

Hermes uses a **code-based pairing flow** (`gateway/pairing.py`):

1. **Code generation**: 8-char codes from a 32-char unambiguous alphabet (no 0/O/1/I confusion), using `secrets.choice()`.
2. **Storage**: Codes are **hashed with a salted SHA-256**—plaintext codes are never persisted. Only a salted hash is stored, so a compromised `pending.json` doesn't leak the code.
3. **Rate limiting**: 1 request per user per 10 minutes. WhatsApp-specific alias expansion normalizes `+123456789` ≡ `123456789` so the same user approved under aliases doesn't duplicate.
4. **Lockout**: After 5 failed attempts, the **platform is locked out for 1 hour** (brute-force protection).
5. **Code approval**: `approve_code()` does constant-time hash comparison (`secrets.compare_digest`), records failure, triggers lockout.
6. **Cleanup**: Expired codes (older than 1 hour) are pruned on each approve/generate call.

Data files live in `~/.hermes/pairing/{platform}-{pending,approved}.json` with `chmod 0o600` (owner read/write only). Atomic writes via tempfile + `os.replace()`.

**Why this is superior to long passwords**: 8 chars + 32 alphabet = ~37 billion combinations; 10-minute rate-limit window + 5 attempt lockout means average 2.3 tries before lockout. Perfect for low-tech bootstrap scenarios (voice call: "8 characters, delta alpha charlie bravo seven four two two", no passwords, no email).

### Self-Provisioning with NAS Integration

`self_provision_relay()` is called at gateway boot:
1. If relay_url() is set AND no `GATEWAY_RELAY_SECRET` is pinned AND the agent can resolve its own Nous access token.
2. Calls `_post_provision()` to POST `/relay/provision` with gateway_id, platform, bot_id, route_keys, endpoint, instance_id.
3. Connector validates the token, derives the tenant, mints per_gateway_secret + per_tenant_delivery_key, stores route rows, returns the secret.
4. Creds are set in `os.environ` (process-only memory, not persisted to `.env`).
5. Boot succeeds even if provision fails (logs warning, boots unauthenticated, connector rejects the upgrade).
6. Pinned secret (env or config.yaml) is RESPECTED and skips self-provision.

For hosted NAS agents, this is **zero-touch enrollment**: boot → auto-register → dial connector → agent starts. Stateless env creds work for ephemeral containers. Pinned secrets allow operators to override self-provision.

### Session Context Variables

`gateway/session_context.py` uses Python `contextvars.ContextVar` instead of `os.environ`:

```python
_SESSION_PLATFORM: ContextVar = ContextVar("HERMES_SESSION_PLATFORM", default=_UNSET)
_SESSION_CHAT_ID: ContextVar = ContextVar("HERMES_SESSION_CHAT_ID", default=_UNSET)
# ...
```

Each asyncio task gets its own copy. When two messages arrive concurrently, Message A's contextvar set doesn't clobber Message B's. Fallback to `os.environ` for CLI/cron compatibility. Tool code reads `get_session_env('HERMES_SESSION_CHAT_ID')` and gets the right value for its task. Background notifications use stored session context to route back to the origin thread.

---

## Comparison

| Feature | OpenClaw | Hermes |
|---------|----------|--------|
| **Pairing** | Device + Node tracks; device auth is cryptographic (privateKeyPem signature); role-based token revocation | Code-based flow; 8-char code hashed w/ salt; platform-wide lockout after 5 failed attempts |
| **Gateway Model** | Stateful single-gateway or coordinator; channels/accounts have persistent state | Stateless multi-instance; relay connector is the "server"; gateways dial out |
| **Secrets in Gateway** | Device auth tokens (per-device, per-role) | Zero platform secrets; per-gateway secret authenticates WS upgrade only |
| **Pairing Store** | Plaintext codes in JSON; single-gateway scope | Hashed codes; atomic writes; per-platform file lock |
| **Trust Boundary** | Gateway verifies auth tokens; stores device pairing state | Connector is sole boundary; gateway trusts only the connector (normalized MessageEvent) |
| **Capability Vault** | Plugin-node capability tokens (10-min TTL, path-scoped) | Connector capability vault (interaction tokens, follow-up tokens, etc.; tenant-scoped) |
| **Multi-Instance** | Requires external coordinator (channels DB) | Relay bus in connector (Redis pub/sub per tenant); inbound routed by owning instance's WS |
| **Pending Work** | NodePendingEnqueue/Drain with wake signaling | Not in Hermes (platform-specific buffering) |
| **Session Routing** | Session key from (chat_id, user_id, guild_id, thread_id) | Same discriminators; build_session_key() must match connector's |
| **Platform Adaptation** | Per-platform adapter in gateway | Single RelayAdapter; CapabilityDescriptor negotiated at connect |
| **Interrupt Routing** | Node events routed by gateway | Interrupt_inbound frame over WS; routed by relay bus to owning gateway |
| **Self-Provision** | Manual enrollment via 'hermes gateway enroll' CLI | Boot-time self-provision with Nous token; stateless env creds |

---

## The Cleverest Mechanisms

1. **Hermes Capability Vault (A2)**: Credentials live **only in the connector**, never in the gateway. Gateway issues semantic actions ('follow_up' with kind='discord.interaction_token') but never names the token. Connector resolves the real token from vault, enforces tenant match. If the gateway is compromised, it holds zero credential material. This is a **paradigm shift** from "gateway re-validates signatures" to "connector is sole boundary."

2. **Relay Bus with Per-Tenant Subscriptions**: Connector's Redis pub/sub is **keyed by tenant**, not by instance. Every instance subscribes and filters locally. Only the instance holding the gateway's WS socket sends inbound down it. This eliminates N HTTP POST calls across instances and keeps inbound routing deterministic.

3. **OpenClaw Device Metadata Tracking**: Device-reported metadata (displayName, platform, deviceFamily, remoteIp, approvedAtMs, lastSeenAtMs, lastSeenReason) is persisted durably and merged with node pairing state. Operator sees a **unified KnownNodeCatalog** with device, node, and live session views. Presence persistence is throttled (60s cooldown) to avoid hammering the session store.

4. **Code-Based Pairing with Hash Storage**: 8-char codes + 32-char alphabet (unambiguous) + salted SHA-256 hashing means a compromised pending.json doesn't leak the code. Rate-limit + lockout provide brute-force protection without a database. Perfect for voice-based pairing scenarios.

5. **CapabilityDescriptor Forward-Compatibility**: Unknown fields are ignored (from_json filters), missing optionals fall back to defaults. New connector versions announce new capabilities (supports_threads, supports_draft_streaming) without gateway code change. Descriptor is immutable (frozen dataclass) after handshake, preventing accidental capability misadvertisement.

6. **Session Context Variables for Concurrent Handlers**: Python `contextvars.ContextVar` isolates per-task session state. When two messages arrive concurrently, they don't interfere. Tool code reads `get_session_env('HERMES_SESSION_CHAT_ID')` and gets the right value. Background notifications use stored session context to route back to the origin thread. Fallback to os.environ for CLI/cron compatibility.


# 14. Channels & Messaging — adapters, presentation actions, dedupe, routing

_13 capabilities · 37 files read_

# Channels & Messaging: Comparative Teardown

## OpenClaw: TypeScript Multi-Channel Adapter Stack

**Architecture**: OpenClaw routes inbound messages and outbound actions through *channel plugins* (Slack, Discord, Telegram, Signal) that implement a shared contract. Each plugin exports (1) a `ChannelPlugin` with identity/config schema, (2) runtime actions (send, edit, delete, react, pin), and (3) conversation bindings for resolving message context.

**Key Mechanisms**:

1. **Keyed Debouncing** (`inbound-debounce.ts`): Inbound messages are buffered per channel+user key via `createInboundDebouncer()`. Each key maintains a Promise chain (keyChains Map) so same-key messages execute serially, preventing race conditions. Items buffer up to debounceMs before flushing. When saturation hits (maxTrackedKeys), overflow falls back to immediate keyed work, preserving order without blocking.

2. **Conversation Binding** (`conversation-binding-context.ts`, `thread-bindings-policy.ts`): Raw channel identifiers (e.g., `line:user:U123...`) resolve to normalized tuples (channel, accountId, conversationId) via plugin.bindings.resolveCommandConversation(). Thread-binding policy layers account > channel > session, with per-scope idle/max-age timeouts (in hours) controlling when thread-bound subagent sessions expire. Default thread placement (current vs child thread) comes from plugin.conversationBindings.defaultTopLevelPlacement or bundled metadata.

3. **Thread Ownership Coordination** (`thread-ownership/index.ts`): Multi-agent setups register a message_sending hook that queries an internal ownership forwarder service. On send, it POSTs {agent_id} to http://slack-forwarder:8750/api/v1/ownership/{channelId}/{threadTs}. If the response is 409 Conflict, another agent owns it—the send is cancelled. In-process mention cache (5-min TTL) tracks @-mentioned agents to avoid repeated lookups.

4. **Lazy-Loaded Action Runtime** (`slack/action-runtime.ts`): The slackActionRuntime object wraps channel operations (sendMessage, editMessage, etc.) with `createLazySlackAction<K>(key)`, which imports the runtime module only on first invocation. SlackActionContext carries currentChannelId, currentThreadTs, and replyToMode ('off'|'first'|'all'|'batched') to auto-inject replies into threads without explicit parameters.

5. **Status Reactions with Debounce** (`status-reactions.slack-lifecycle.test.ts`): The `createStatusReactionController()` manages emoji lifecycle (queued → thinking → tool:X → done → clear), debouncing rapid transitions. Tools map to emoji (web_search → 🔎, exec → 🛠️). TTL auto-cleanup prevents stale emoji on crashed agents. Test verifies deterministic timeline and idempotency.

6. **Message Sent Hooks** (`message-sent-hook.ts`): After Slack sends, `emitSlackMessageSentHooks()` fires both plugin (message_sent) and internal (message:sent) hooks with canonical context (to, content, success, error, channelId, accountId, sessionKey, messageId). Hook emission is gated: if no plugins observe, zero cost. Pattern mirrors Telegram's delivery, showing uniform plugin infra across channels.

7. **Streaming & Progress Formatting** (`streaming.ts`): ChannelStreamingConfig normalizes legacy flat keys into nested structure. Modes: 'off' | 'partial' | 'block' | 'progress'. Progress mode formats output with per-tool aggregates and status-line prefixes. Per-channel streaming overrides fall back to global defaults.

8. **Typing Indicator Lifecycle** (`typing.ts`): `createTypingCallbacks()` maintains typing via keepalive (re-fires start() every 3s), has a safety TTL (60s max), and implements circuit-breaker on consecutive start() failures. onIdle and onCleanup both call stop(); TTL prevents indefinite typing on crashed agents.

**Distinctive Design Decisions**:
- **Lazy loading** reduces bootstrap cost; only active channels load action modules.
- **Key-aware debouncing** prevents message reordering for the same user/channel while allowing concurrent processing of different keys.
- **Layered thread-binding policy** (account > channel > session) without duplication.
- **Hook gating** (only fire if plugins listen) keeps hot paths cheap.
- **Platform-specific status emojis** make progress visible without text spam.

---

## Hermes: Python Async Platform Adapter Gateway

**Architecture**: Hermes runs a long-lived async gateway that manages platform connections (Telegram, Discord, Signal, WhatsApp, Weixin, etc.) and routes messages through stateless adapters. Each adapter (BasePlatformAdapter subclass) handles inbound streaming (SSE for Signal, webhook polling for WhatsApp Cloud, etc.) and outbound sends.

**Key Mechanisms**:

1. **Platform Adapter Base** (`platforms/base.py`): All adapters inherit from `BasePlatformAdapter`, which defines the contract: async receive_messages(), async send_message(chat_id, text, ...), async handle_message(event), and media upload methods. `_thread_metadata_for_source()` builds platform-aware thread routing: Telegram DM topics use telegram_dm_topic_reply_fallback + direct_messages_topic_id + telegram_reply_to_message_id; other platforms use generic thread_id. `should_send_media_as_audio()` routes audio by extension and platform (Telegram Bot API only accepts MP3/M4A for sendAudio, Opus/OGG for sendVoice). Message length is UTF-16 for Telegram (surrogates counted), native for others.

2. **Delivery Target Parsing** (`delivery.py`): `DeliveryTarget.parse(target_str, origin)` parses strings: 'origin' (back to source), 'local' (files), 'telegram' (home channel), 'telegram:123456' (explicit chat), 'telegram:123456:789' (chat:thread). Returns DeliveryTarget with platform, chat_id, thread_id, is_origin, is_explicit flags. Message truncation (MAX_PLATFORM_OUTPUT = 4000 bytes) applies only to non-chunking platforms; adapters with splits_long_messages=True bypass truncation. `_is_silence_narration()` detects narration-only messages (anchored regex, max 64 chars) and skips delivery.

3. **Session Mirroring** (`mirror.py`): When a cron job or CLI command delivers to a platform, `mirror_to_session()` appends a mirror message to the target session's transcript (JSONL + SQLite). Finds the session via _find_session_id() by scanning sessions.json for matching platform + chat_id, preferring exact user_id matches to avoid cross-contamination in group chats. mirror_source labels the origin (cli, cron, webhook). All errors are silent (best-effort).

4. **Channel Directory with Aliases** (`channel_directory.py`): Directory maps reachable channels per platform, built on startup, refreshed every 5 min, saved to ~/.hermes/channel_directory.json. Friendly names come from ~/.hermes/channel_aliases.json and are re-applied on every load (durable across refreshes). send_message tool reads this file for action='list' and resolves names to IDs. Discord channels get '#' prefix; others get '(type)' suffix. Placeholder injection lets you pre-name a chat before its first message.

5. **Context Variables for Concurrency** (`session_context.py`): Python contextvars.ContextVar replaces process-global os.environ for per-task session state. Each asyncio task gets isolated copies of _SESSION_PLATFORM, _SESSION_CHAT_ID, _SESSION_THREAD_ID, etc. Sentinel _UNSET distinguishes \"never set\" (fall back to os.environ for CLI compat) from \"cleared\" (return empty). get_session_env(name, default) mirrors os.getenv() interface. _SESSION_ASYNC_DELIVERY controls whether the platform supports background task wakeup (stateless API server = False).

6. **Hook System for Lifecycle Events** (`hooks.py`): Hooks are discovered from ~/.hermes/hooks/ directories, each with HOOK.yaml (metadata) and handler.py. Events: gateway:startup, session:start/end/reset, agent:start/step/end, command:*. Handlers receive context (platform, user_id, chat_id, thread_id, chat_type, session_id, message). agent:end adds response text. Errors in hooks are caught and logged but never block the pipeline.

7. **Gateway Runner** (`run.py`): The gateway entry point starts all configured adapters and manages message routing. Includes agent cache tuning (_AGENT_CACHE_MAX_SIZE = 128, idle TTL eviction at 1h), platform connection timeout (30s default), adapter disconnect timeout (5s default). Status messages from the agent (prefixed with provider error preambles or noisy transient messages) are filtered before delivery to Telegram.

**Distinctive Design Decisions**:
- **Platform-specific thread metadata** (Telegram DM topics need reply anchors, Discord doesn't).
- **UTF-16 length measurement** for Telegram prevents message truncation mid-emoji.
- **Durable channel aliases** that survive gateway restarts (unlike the ephemeral directory).
- **Task-local context vars** prevent message routing errors under concurrency.
- **Best-effort mirroring** ensures audit trails without blocking sends.
- **Stateless adapter opt-out** for _SESSION_ASYNC_DELIVERY so API endpoints don't promise async delivery.

---

## Comparative Summary

| Feature | OpenClaw | Hermes |
|---------|----------|--------|
| **Language** | TypeScript | Python (async) |
| **Inbound Pattern** | Keyed debouncing + serialization | Adapter streaming (SSE, webhook, polling) |
| **Outbound** | Lazy-loaded action runtime per plugin | Platform-specific send_message() |
| **Thread Routing** | Explicit SlackActionContext, replyToMode | Platform-aware metadata (_thread_metadata_for_source) |
| **Concurrency Safety** | Promise chains per key | Python contextvars per task |
| **Delivery Fallback** | Home channel (None chat_id) | origin / local / platform:chat_id |
| **Session Binding** | resolveConversationBindingContext() | mirror_to_session() audit trail |
| **Status UI** | Emoji reactions (Slack-native) | Log filtering + hook events |
| **Plugin Hooks** | message_received, message_sending, message_sent | gateway:startup, session:*, agent:*, command:* |
| **Message Length** | Per-channel streaming config | Platform-specific (UTF-16 for Telegram) |
| **Scaling** | Per-agent plugin registry, lazy loads | Per-gateway adapter pool, agent cache LRU |

**The Cleverest Bit**: OpenClaw's **keyed debouncing with Promise chains** (same-key serialization, concurrent key processing, graceful saturation fallback) is elegant — it prevents race conditions and message reordering without mutexes or locks. Hermes' **context vars for task-local session state** solves the same concurrency problem from the opposite angle: by moving process-global state into task-local containers, concurrent messages never overwrite each other's routing context. Both approaches are sophisticated but OpenClaw's is more explicit (you see the Promise chains), while Hermes' is more Pythonic (you just use get_session_env() and the isolation is implicit).


# 15. Cron, Automation & Background — managed cron, webhooks, review

_13 capabilities · 31 files read_

## Cron, Automation & Background Work: openclaw vs hermes-agent

### OpenClaw Architecture

OpenClaw runs an **in-process 60-second timer loop** (`onTimer()` in `/src/cron/service/timer.ts`) that awakens, scans for due jobs (nextRunAtMs ≤ now), reserves them with `runningAtMs`, executes via a worker pool, and persists results. The timer is clamped at MAX_TIMER_DELAY_MS (60s) to recover from wall-clock skew and process pauses. If `state.running` is true, the timer re-arms without executing (preventing nested ticks per #12025).

Key distinctive mechanisms:

1. **Active Job Markers** (`/src/cron/active-jobs.ts`): Process-global `Map<jobId, CronActiveJobMarker>` with generation + token tracking. `markCronJobActive()` assigns unique tokens; `isCronActiveJobMarkerCurrent()` validates before finalizing. Survives module reloads (stored in global singleton via Symbol.for), preventing duplicate fires when a wake-path or re-entrant call tries to fire an already-executing job.

2. **Croner LRU Cache** (`/src/cron/schedule.ts`): Cron expressions are parsed lazily and cached in an LRU map (max 512 entries, key = timezone+expression). Handles timezone edge cases (Asia/Shanghai year-rollback bug) by retrying nextRun() from next-second and tomorrow-UTC if the result is in the past.

3. **Transient Retry with Exponential Backoff** (`/src/cron/retry-hint.ts`, `/src/cron/service/jobs.ts`): Errors are regex-classified into rate_limit, overloaded, network, timeout, server_error. One-shot jobs ('at' schedule) retry with backoff (30s, 60s, 5m, 15m, 1h); auto-disable after max attempts (default 3). Recurring jobs apply backoff but preserve their natural schedule, using max(naturalNext, backoffNext).

4. **Separate Delivery & Failure Routing** (`/src/cron/delivery.ts`, `/src/cron/delivery-plan.ts`): Job output goes to the primary channel; failure notifications route to a separate failureDestination (different channel/thread). Best-effort flag suppresses success-delivery errors but still attempts failure alerts. Last-delivery context is remembered so re-delivers land in the same Telegram topic.

5. **Isolated Agent per Job** (`/src/cron/isolated-agent.ts`): For sessionTarget='isolated' jobs, a separate AIAgent instance is spawned. Wall-clock timeout is deferred until execution starts (deferTimeoutUntilExecutionStart) so model bootstrap latency doesn't trigger false timeouts. Lane-wait observation distinguishes "waiting in queue" from "truly stuck setup," informing restart-recovery decisions (#26923).

6. **Background Commitment Extraction** (`/src/commitments/runtime.ts`): After each turn, hidden extraction batches items and runs a restricted embedded agent (memory + skill tools only) to infer follow-ups. Terminal failures throttle by 15m cooldown. No fork; batching amortizes LLM cost.

7. **Task Ledger Integration** (`/src/cron/service/task-runs.ts`, `/src/tasks/cron-task-cancel.ts`): Cron runs are tracked as detached tasks in a ledger. RunId = createCronExecutionId(jobId, startedAt). AbortController per run allows operator-initiated cancellation. Settlement grace period (60s) allows cleanup after abort.

8. **Session Reaper** (`/src/cron/session-reaper.ts`): Piggybacked on timer tick, prunes per-run sessions older than retention (default 24h). Throttled to 5 min per store path. Archives before deleting. Runs outside locked() section to avoid deadlock.

### Hermes Architecture

Hermes offers **two scheduler modes**: the built-in 60s daemon-thread ticker (default) and **Chronos** managed cron for scale-to-zero hosted deployments.

#### Built-In Ticker

Runs in a daemon thread, calls `tick()` every 60 seconds. Acquires dual locks: in-process `threading.RLock` + cross-process `fcntl`/`msvcrt` advisory file lock on `.jobs.lock`. Jobs are loaded from `jobs.json`, due jobs identified (via croniter or next_run_at), dispatched to parallel or sequential thread pools. Parallel pool handles CPU-bound jobs; sequential pool (single-thread executor) preserves env-mutation ordering (e.g., os.environ changes). Cross-process locking ensures a `hermes cron pause` CLI command is not silently lost to a concurrent gateway tick (historical #14926-era issue).

#### Chronos Managed Cron

Agent computes `next_run_at`, POSTs `/api/agent-cron/provision` to NAS (auth: agent Bearer token) with `{job_id, fire_at, agent_callback_url, dedup_key}`. NAS arms a one-shot on an external scheduler, holding all scheduler credentials. At fire time, scheduler POSTs `/api/agent-cron/relay` (auth: scheduler signature) → NAS mints a short-lived JWT (aud=agent:{instance_id}, purpose=cron_fire, exp≈60–120s) → POSTs agent's `/api/cron/fire` endpoint. Agent verifies the JWT (PyJWT against NAS JWKS) and claims the job via store-level CAS (compare-and-set). At-most-once across replicas sharing one HERMES_HOME store. Reconciliation on startup/job-change heals missed provisions.

Key advantages: **scale-to-zero** (agent sleeps, NAS keeps time), **no scheduler credentials on agent**, **CAS ensures safety across multi-replica agents**.

#### Background Self-Improvement

After every turn, `spawn_background_review_thread()` forks a daemon AIAgent from the parent's runtime (shared model, auth, cached system prompt). Fork replays the turn with a restricted toolset (memory + skill tools only) and asks "should any skill/memory be saved?" Writes go directly to memory/skill stores. Parent conversation is never touched. Because the fork shares the parent's prefix cache, review is cheap (amortized cost).

#### Suggestions & Blueprints

Suggestions (`/cron/suggestions.py`) are pre-built cron job specs from four sources: catalog (curated starters), blueprint (skill-provided), usage (background review detected recurring ask), integration (user connected a service). Suggestions.json stores them with dedup_key for latching dismissed ones. Accepting = calling `cron.jobs.create_job()` (same engine, no duplication). Blueprints (`/cron/blueprint_catalog.py`) parameterize automations: slot schema (time, enum, text, weekdays) is the single source of truth. `fill_blueprint()` validates inputs, emits job kwargs. MAX_PENDING = 5 caps the nag wall.

#### Utility Scripts

`classify_items.py` (`/cron/scripts/`) reads JSON from stdin, calls auxiliary.monitor LLM (cheap model, not main chat model) to score items, filters above urgency threshold, prints JSON. Empty output suppresses delivery. Composable filter for watcher-style jobs.

### Key Differences

| Aspect | OpenClaw | Hermes |
|--------|----------|--------|
| **Scheduler** | In-process timer (60s) | In-process ticker (60s) + optional Chronos (NAS-delegated) |
| **Duplicate Prevention** | Process-global active-job marker with generation + token | File lock + in-process thread safety |
| **Retry** | Regex error classification + exponential backoff (30s–1h) | No built-in retry (jobdef-level, or external requeue) |
| **Failure Notifications** | Separate failureDestination per job | Not separate (delivery is delivery) |
| **Isolated Execution** | Separate AIAgent per job, deferred timeout | Not isolated (same AIAgent, same session) |
| **Background Learning** | Batch commitment extraction (no fork) | Background review fork (self-improvement) |
| **Suggestions** | Not built-in (user-facing concept in OpenClaw config/tools) | First-class (catalog + blueprint + usage + integration) |
| **Delivery Composability** | Not exposed as scripts | `classify_items.py` et al. as reusable pipeline filters |
| **Session Lifetime** | Per-run sessions with reaper (24h default) | Per-job sessions (lifecycle bound to job) |
| **Scale-to-Zero** | Not supported | Chronos: NAS holds scheduler, agent sleeps |
| **Locking** | In-process locked() + SQLite transactions | Cross-process fcntl/msvcrt on .jobs.lock |

### Cleverest Mechanisms

**OpenClaw's active-job marker scheme** is subtle: by preserving markers across generation advance, main-session jobs can survive module reloads in dev, preventing duplicate fires on hot restarts. The token + generation pair is a two-level ID space that keeps the marker set bounded and correct.

**Hermes's Chronos contract** injects NAS into the critical path to keep scheduler credentials off the agent. A one-shot per job (not a cron daemon) scales to zero transparently. The fire is at-most-once via CAS, so webhook retries are safe. The escape hatch for direct per-job cron-key mode swaps in a different verifier without changing the webhook handler.

**OpenClaw's deferred timeout for isolated agent runs** is elegant: cold model startup (60–120s) shouldn't trip a setup timeout. By deferring timeout until execution starts and tracking lane waits, the system distinguishes "model is slow" (legitimate) from "truly hung setup" (timeout). This informs restart recovery decisions, not just binary failure/success.


# 16. Media & Voice — TTS/STT, image/video/music gen, understanding, vision

_15 capabilities · 38 files read_

# Media & Voice Architecture Teardown: openclaw vs hermes

## Registry & Provider Discovery

**openclaw**: Uses a two-stage provider map architecture (`canonical` + `aliases` in Maps). Each provider registry (TTS, image gen, video gen, media understanding, music gen) is built at config resolution time by merging built-in providers + plugin capabilities via `resolvePluginCapabilityProviders()`. Provider IDs are normalized and unsafe keys (e.g., `__proto__`) are blocked via `isBlockedObjectKey()` before they reach Map lookups. This enables safe dynamic provider selection from untrusted config.

**hermes**: Uses a simpler thread-safe dict-based registry (`_providers: Dict[str, ProviderType]`) with a `threading.Lock`. Registration is the entry point for safety: the registry enforces a "built-ins-always-win" invariant at both registration time (with a warning log) and dispatch time (defensive re-check). Names colliding with built-ins are rejected at registration. Hermes' registries are more explicit about precedence: built-in → command-provider → plugin provider.

**Difference**: openclaw's approach scales better to untrusted plugin sources (config pollution attacks); hermes' is simpler and favors explicit control flow over dynamic lookup. Both implement case-insensitive name normalization and support aliases.

## TTS & Voice

**openclaw**: Rich multi-layered TTS system with personas, voice models, and lazy provider config resolution. Personas are named voice identities with per-provider config overrides, fallback policies, and UI metadata (label, description). Voice models are catalog entries (`VoiceModelRef`: provider + model pair) with optional fallback chains and timeout overrides. The system reads base config + user prefs (JSON file) + persona bindings and merges them with `mergeProviderConfigWithPersona()`. Auto-summarization of long text (>1500 chars default) using a configurable summary model. System prompt hints inform the agent of max length and active persona.

**hermes**: No personas, just direct provider + voice/model selection via `tts.provider` in config. Built-in providers (edge, openai, elevenlabs, minimax, gemini, mistral, xai, piper, kittentts, neutts) are always available; plugins cannot shadow them. Simple synthesize/stream contract: `str → output_path`.

**Difference**: openclaw decouples voice identity (persona) from provider/model selection, enabling persistent voice preferences and multi-voice personalities. Hermes keeps it minimal: one active provider, fixed voice mapping. openclaw invests in text-length management and adaptive summarization; hermes delegates that to agent prompts.

## Realtime Transcription

**openclaw**: Dedicated `RealtimeTranscriptionSession` abstraction with `RealtimeTranscriptionWebSocketTransport`. Provider supplies URL (sync or async), headers (sync or async), message parser, and sendAudio callback. Core handles reconnection (up to 5 attempts, 1s exponential backoff), audio queueing (2MB buffer), connect timeout (10s), close timeout (5s). Session emits callbacks: `onPartial`, `onTranscript`, `onSpeechStart`, `onError`. Provider is responsible only for protocol details, not state/retry logic.

**hermes**: No built-in realtime transcription module yet. Transcription is batch-oriented via the `TranscriptionProvider` ABC.

**Difference**: openclaw enables low-latency streaming transcription with automatic resilience. hermes would need plugin-based extension for this capability.

## Image Generation

**openclaw**: `ImageGenerationRequest` carries source images as binary buffers (`ImageGenerationSourceImage[]`) with MIME type and optional metadata. Provider request also carries auth context (profile store) and SSRF policy. Results are `GeneratedImageAsset[]` with buffer/mimeType/fileName/metadata/revisedPrompt.

**hermes**: Routed by image presence: `image_url` → I2I, omitted → T2I. Provider decides which endpoint to hit. Response envelope: `{success, image: url|path, model, prompt, aspect_ratio, modality, provider, error?}`.

**Difference**: openclaw passes binary buffers; hermes passes URLs and expects providers to fetch. hermes' routing is presence-driven (implicit); openclaw is explicit. hermes includes aspect_ratio as a semantic field (landscape/square/portrait); openclaw uses pixel dimensions. hermes includes a revised prompt in the response for show-what-was-actually-generated semantics.

## Video Generation

**openclaw**: Unified `VideoGenerationRequest` with three input types: `inputImages`, `inputVideos`, `inputAudios`. Each asset carries a semantic `role` hint (first_frame, last_frame, reference_image/video/audio) that's forwarded as-is to the provider. Assets can be URL or buffer; core doesn't download URLs, allowing providers to stream output directly. Result includes `url` field for pre-signed cloud URLs (avoids buffering large files in memory).

**hermes**: Mirrors image-gen design: one tool, routing by `image_url` presence (I2V vs T2V). Multi-input assets not yet supported.

**Difference**: openclaw is richer: I2V + V2V + audio sync in one request. hermes is simpler: I2V only. openclaw's role hints enable provider optimization (e.g., "this image is the first frame" vs "this is a reference").

## Media Understanding

**openclaw**: Unified provider interface for image/audio/video analysis. `MediaUnderstandingProvider` declares capabilities (`image`, `audio`, `video`) and can implement hooks (`describeImage`, `describeImages`, `transcribeAudio`, `describeVideo`). If a provider declares image capability but no hook, the generic model runtime (`describeImageWithModel`) is auto-wired. This enables any image-capable LLM to serve as a vision backend without plugin code. Transport overrides (auth, proxy, TLS) are centralized in `MediaUnderstandingProviderRequestTransportOverrides`. Supports structured extraction with user-supplied JSON schema.

**hermes**: Vision is a separate tool (`vision_analyze_tool()`) that downloads images from URLs, base64-encodes them, and sends to the vision provider. Provider is chosen by `auxiliary.vision.provider`, orthogonal from the main model. Image routing (`native` vs `text` mode) depends on main model capabilities + explicit override.

**Difference**: openclaw integrates media understanding into the main provider registry; hermes keeps it separate and configurable. openclaw auto-wires model-based providers; hermes requires explicit tool calls. openclaw supports structured extraction; hermes is freeform analysis.

## The Cleverest Mechanisms

1. **openclaw's Persona System**: Decouples voice identity from provider implementation. A persona can map to different providers per output context (chat vs voice note), enabling voice switching without config reload and fallback chains without explicit provider lists.

2. **openclaw's Media Provider Hydration**: Auto-wiring generic model-based vision for config-only providers. One line of config (`"image_capable": true`) enables vision without writing plugin code. This bridges extensibility and simplicity.

3. **hermes' Provider Precedence Model**: Built-ins-always-win + command-provider-wins-over-plugins is explicit and enforced at both registration and dispatch. The three-level hierarchy is clearer than dynamic lookup.

4. **Real-time Transcription WebSocket Transport** (openclaw): Provider supplies only protocol details; core owns reconnection, queueing, and timeouts. Clean separation of concerns. Audio queueing prevents loss during transient network issues.

5. **Image Extraction from Free-Form Text** (hermes): `extract_image_refs()` uses regex to find local paths and URLs in user messages, skipping code blocks and backticks. Enables conversational image manipulation without explicit tool invocation.


# 17. Web & Browser — control, search providers, content extraction

_12 capabilities · 34 files read_

## Comparative Teardown: Web & Browser Theme

### What OpenClaw Does

**Provider Architecture (web-search, web-fetch, browser)**
OpenClaw uses a dual-plugin-interface model where `WebSearchProviderPlugin` and `WebFetchProviderPlugin` are separate contract types defined in `plugin-sdk/provider-web-search-contract` and `plugin-sdk/provider-web-fetch`. Each provider (Firecrawl, Exa, Tavily, DuckDuckGo) registers through `api.registerWebSearchProvider()` / `api.registerWebFetchProvider()`. Resolution happens in `/src/web-search/runtime.ts` and `/src/web-fetch/runtime.ts` via `resolveWebSearchDefinition()` / `resolveWebFetchDefinition()`: explicit `tools.web.search_backend` / `tools.web.fetch_backend` config wins first; then single-provider shortcut (if only one capable+configured provider exists); then legacy preference walk (firecrawl → parallel → tavily → exa → searxng → brave-free → ddgs) filtered by credential availability.

**Credential resolution** (`packages/web-content-core/src/provider-runtime-shared.ts`): `resolveWebProviderConfig(cfg, 'search'|'fetch')` extracts `cfg.tools.web.{search|fetch}` and looks up credentials hierarchically: configured secret → env var override → secretRef (env|file|exec source) with support for `$VAR` syntax and legacy `__env__:VAR` markers. Each provider tracks envVars, requiresCredential flags, and optional authProviderId for cross-provider auth.

**Web content extraction** (`extensions/firecrawl/src/firecrawl-fetch-provider.ts`): `runFirecrawlScrape` takes url + extractMode (text|markdown) + maxChars + proxy setting + storeInCache. Response shape is {url, title, content, raw_content, metadata}. Tavily and Exa follow similar patterns with schema-driven parameter coercion.

**Link understanding** (`src/link-understanding/`): `extractLinksFromMessage()` strips markdown link syntax, matches bare HTTP(S) URLs via regex, validates protocol + hostname (SSRF gate against localhost, 169.254.x.x, etc.), deduplicates via Set, respects maxLinks limit. Runner fetches through `fetchWithSsrFGuard(mode=STRICT)` and pipes content through CLI processors with template args (LinkUrl, LinkFinalUrl).

**Browser extension** (`extensions/browser/`): The browser plugin creates a single multi-action tool `BrowserTool` with actions (act, screenshot, navigate, open_tab, close_tab, profiles, console, snapshot). Runtime routing (`src/browser-tool.ts`) dispatches through sandbox bridge, host control service, or node-host depending on context. Security audit collectors scan for policy violations; auth middleware enforces control tokens.

**Manifest-driven provider discovery** (`src/plugins/web-provider-public-artifacts.ts`): Resolves bundled plugin IDs from manifest metadata without loading plugin code. `resolveManifestDeclaredWebProviderCandidates()` filters by origin (bundled|workspace), contract declaration, configKey hints. Sandbox-safe contexts restrict to origin='bundled' OR trustedOfficialInstall=true.

### What Hermes Does

**Provider ABC & Registry** (`agent/web_search_provider.py`, `agent/browser_provider.py`): Single Python ABC for web search/extract combining both capabilities via `supports_search()`/`supports_extract()` flags. `search(query, limit) → {success, data, error}` and `extract(urls) → [{url, title, content, raw_content, metadata|error}]`. Registration via `PluginContext.register_web_search_provider(instance)` populates global `_providers` dict. Active resolution in `web_search_registry.py._resolve(configured, capability='search'|'extract')`: explicit config wins (ignore availability); then single-eligible shortcut; then legacy preference walk filtered by availability check. Browser provider is similar lifecycle structure but narrower (no dual interface).

**Browser lifecycle** (`plugins/browser/browser_use/provider.py`): `BrowserProvider` ABC with `create_session(task_id) → {session_name, bb_session_id, cdp_url, features, external_call_id}`, `close_session(session_id) → bool`, `emergency_cleanup(session_id)`. Browser Use implements dual auth: direct `BROWSER_USE_API_KEY` unless `tool_gateway.browser='gateway'` redirects to managed Nous. Idempotency keys (`_pending_create_keys` dict) deduplicate retries on managed gateway. Session metadata contract preserved verbatim for tool_wrapper compatibility.

**Firecrawl dual-auth pattern** (`plugins/web/firecrawl/provider.py`): Lazy SDK import via `_FirecrawlProxy` (defers ~200ms of imports). Dual auth: direct `FIRECRAWL_API_KEY` OR `web.use_gateway=true` routes to Nous gateway. Client caching by config tuple `(source, api_url, api_key)` detects credential changes. Extract is async (`asyncio.to_thread` per URL, `asyncio.wait_for(timeout=60s)`). Response normalization via `_to_plain_object()` handles SDK objects / direct API / gateway variants. Post-redirect SSRF re-check via `check_website_access(final_url)`. Per-URL errors become dict items with error field (no raising).

**Availability checking** (`agent/web_search_registry.py`): `is_available()` is cheap (env var present, optional import test). Errors in is_available() are caught, logged, treated as unavailable (won't block resolution). Explicit config paths skip availability check so users get precise errors instead of silent switches.

**Plugin discovery** (`hermes_cli/plugins.py`): Four sources: bundled (`<repo>/plugins/`), user (`~/.hermes/plugins/`), project (`./.hermes/plugins/` with env gate), pip entry-point. Each directory must have `plugin.yaml` + `__init__.py` with `register(ctx)` function. Registry dict maps plugin IDs; tool registration delegates to `tools.registry.register()`.

### Key Differences

1. **Interface design**: OpenClaw splits web-search and web-fetch into separate plugin types (SearchProviderPlugin vs FetchProviderPlugin); Hermes uses one ABC with `supports_search()` / `supports_extract()` capability flags.

2. **Auto-detection safeguards**: Openclaw allows browser-use and firecrawl to auto-select if exactly one provider is available (shortcut rule); Hermes explicitly gates them from legacy preference unless configured, so `FIRECRAWL_API_KEY` doesn't silently trigger paid cloud browser if user only wanted web search.

3. **Credential model**: Openclaw path-based resolution (getConfiguredCredentialValue → fallback → env vars) with secretRef syntax (`${VAR}`, `$VAR`); Hermes cheap availability checks (no network) + explicit-config-wins pattern so unconfigured providers don't block discovery.

4. **Browser provider shape**: Openclaw: single multi-action tool with runtime routing; Hermes: separate cloud-browser ABC plugged into tool_wrapper dispatcher. Openclaw manages profiles/sessions/tabs directly; Hermes delegates session lifecycle to provider instances.

5. **Async handling**: Firecrawl in Hermes is async (per-URL timeout in asyncio.wait_for); OpenClaw's approach is SDK-determined (lazy client module loaded on demand, execute is async).

6. **Manifest discovery**: OpenClaw filters by origin + contracts without loading plugin code; Hermes loads entire plugin module to discover tools. OpenClaw gates sandboxed contexts to bundled+verified-official; Hermes relies on directory layout and HERMES_ENABLE_PROJECT_PLUGINS env var.

### The Cleverest Mechanism

**Hermes' idempotency-key pattern for managed Nous billing**: Browser Use and Firecrawl both support direct credentials and managed-gateway billing. When routing through Nous, they store an idempotency key in the request header. If the gateway returns 409 "already in progress" or 5xx, the key is preserved so a retry reaches the same gateway request (deduplicating charges). Only on terminal 4xx errors is the key dropped. This prevents double-billing on cloud retries and is preserved in `_pending_create_keys` dict per task_id, cleared on success/terminal failure. It's a minimal but complete solution to the race between agent timeout handling and expensive API charges.

**OpenClaw's lazy provider loading**: Rather than import all 6+ search provider SDKs at registration, each provider's `createTool()` returns an execute function that does `await import('./client.js')` on first call. This keeps CLI startup and tool-discovery fast while ensuring SDKs are loaded only when actually used. Paired with manifest-driven plugin discovery (no plugin code loaded until needed), it achieves both performance and security (malicious plugins never loaded in sandboxed contexts).


# 18. Security & Secrets — sandbox, net-policy/SSRF, credential pool, ssl

_12 capabilities · 18 files read_

# Security & Secrets Architecture: openclaw vs hermes

## Executive Summary

hermes and openclaw tackle security through different lenses. hermes focuses on **credential isolation and lifecycle** (multi-profile scoping, token refresh, removal contracts), while openclaw emphasizes **authorization policy and network boundaries** (SSRF blocking, gateway auth, channel DM policies). Both prevent **silent credential leaks**—hermes via fail-closed context variables, openclaw via config audit findings.

## Credential Management

### hermes: Scope-based isolation with token lifecycle

hermes prevents cross-profile credential disclosure through a context-variable approach:

- **secret_scope.py**: `set_secret_scope()` installs a per-turn mapping into `_SECRET_SCOPE` contextvar. When multiplexing is active, `get_secret(name)` **raises `UnscopedSecretError`** if called without an active scope—fail-closed enforcement. Legitimately global vars (PATH, HOME, HERMES_HOME, HERMES_PROFILE) are allowlisted by exact name or prefix, always reading from os.environ. This prevents the most dangerous leak: a misconfigured adapter reading another profile's credential from os.environ without realizing it.

- **credential_pool.py**: A persistent pool stores PooledCredential entries keyed by (provider, id). Each entry tracks status (ok/exhausted/dead), error reason, reset timestamps. Selection strategies (fill_first, round_robin, random, least_used) are configured per-provider. Terminal OAuth failures (token_revoked, invalid_grant) are marked STATUS_DEAD (no TTL retry); transient failures (401, 429) get STATUS_EXHAUSTED with provider-specific cooldowns (401: 5min, 429: 1hr). The distinctive design: **single-use token awareness**. After refresh, tokens are synced back to auth.json singletons so concurrent processes don't replay consumed refresh_tokens. Custom provider pools use (name, base_url) matching to solve the collision problem: two custom providers sharing a base_url but with different API keys.

- **credential_sources.py**: A RemovalStep registry defines per-source cleanup contracts. Each step (1) clears external state (.env lines, auth.json blocks), (2) suppresses the source in auth.json so `_seed_from_*` skips re-upsert, (3) returns a RemovalResult with hints. This replaces ad-hoc if/elif chains. Copilot removal is a showcase: it suppresses ALL variant sources (gh_cli + env:GH_TOKEN + env:COPILOT_GITHUB_TOKEN + env:GITHUB_TOKEN) in one call, preventing resurrection.

- **credential_persistence.py**: Before writing to auth.json, `to_dict()` sanitizes borrowed credentials. Owned sources (manual:*, hermes_pkce, device_code for Nous/Codex/xAI) pass through with full tokens. Borrowed sources (env-seeded, custom config, external CLIs) have secret values stripped and replaced with a sha256 fingerprint (non-reversible). This prevents plaintext secret storage while keeping enough metadata for diagnostics.

### openclaw: Policy audit with soft enforcement

openclaw doesn't manage credentials directly; instead it **audits gateway and channel configuration** for exposure risks:

- **audit-gateway-config.ts**: Emits SecurityAuditFinding[] with severity graded by context. bind=loopback + no auth is critical; loopback + no auth but Control UI exposed through a reverse proxy is also critical (trusted proxies required). Non-loopback without auth is critical. HTTP /tools/invoke defaults to a deny list (session spawning, memory write, etc.); re-enabling any tool is critical if bind is non-loopback. Control UI requires explicit allowedOrigins for non-loopback; '*' wildcard is critical if exposed. dangerouslyAllowHostHeaderOriginFallback weakens DNS rebinding protection. Tailscale funnel mode (public internet) is critical; serve mode (tailnet-only) is info. Token strength (<24 chars) gets a warn. Trusted-proxy auth requires the full chain: explicit proxy IPs, userHeader config, allowUsers list.

- **audit-channel.ts**: Per-plugin security hooks. For each account, resolves DM policy and checks if it's open (critical), disabled (info), or shares main session with multiple senders (warn). Plugin.security hooks let vendors implement channel-specific logic (e.g., Slack team owner checks). Findings are deduplicated by (checkId, severity, title, detail, remediation).

## Network Isolation & SSRF Prevention

### hermes: SSL CA validation + file access barriers

- **ssl_guard.py**: Eagerly validates CA bundle paths (HERMES_CA_BUNDLE, SSL_CERT_FILE, REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE) before OpenAI/httpx calls. Checks: (1) path exists, (2) is a file, (3) size > 1KB, (4) ssl.create_default_context() loads it, (5) cert count > 0. Wraps all errors in SSLConfigurationError with repair hints. Bypassable via HERMES_SKIP_SSL_GUARD for emergencies. Distinctive: it catches misconfigurations at startup (clear error) instead of opaque 'No such file' deep in httpx after 30 minutes.

- **file_safety.py**: Soft denylists (returns errors, doesn't block at filesystem level). write_denied_paths() covers .ssh/*, .env, .anthropic_oauth.json, auth.json, .netrc, .pgpass, .npmrc, /etc/sudoers, /etc/passwd. write_denied_prefixes() covers .ssh/, .aws/, .gnupg/, .kube/, .docker/, /etc/systemd/, /etc/sudoers.d/. read_denied covers Hermes internal cache (.hub/), credential stores (auth.json, .anthropic_oauth.json, mcp-tokens/), and project-local .env files (*.env*, .envrc). Also guards cross-profile writes (agents shouldn't edit another profile's skills/) and sandbox-mirror confusion (writes into …/sandboxes/<backend>/<task>/home/.hermes are mirrors the host never reads). Defense-in-depth: errors guide models that respect tool denials to stop early; the terminal tool can bypass.

### openclaw: IP blocking with legacy form detection + URL credential redaction

- **ip.ts**: parseCanonicalIpAddress() rejects legacy IPv4 forms (192.0.2, 0xc0a80001, octal); parseLooseIpAddress() accepts them for SSRF checks. isBlockedSpecialUseIpv4Address() blocks unspecified, broadcast, multicast, linkLocal, loopback, carrier-grade NAT, reserved. RFC 2544 benchmark range (198.18.0.0/15) is exemptible via allowRfc2544BenchmarkRange. isBlockedSpecialUseIpv6Address() blocks unspecified, loopback, linkLocal, uniqueLocal (exemptible for proxy fake-ip stacks like Clash/Sing-box/Surge), multicast, reserved. extractEmbeddedIpv4FromIpv6() decodes IPv4 literals from transition formats (IPv4-compatible ::w.x.y.z, NAT64 64:ff9b:1::/48, 6to4 2002::/16, Teredo 2001::/32, ISATAP). Prevents SSRF bypass: an attacker using a 6to4 address to reach cloud metadata can be caught by embedded IPv4 extraction. Cloud metadata IPs (100.100.100.200, fd00:ec2::254) are blocked.

- **redact-sensitive-url.ts**: isSensitiveUrlQueryParamName() matches 40+ auth param names (token, api_key, secret, access_token, auth_token, refresh_token, x_amz_signature, etc.). Normalizes inputs by decoding %encoding and stripping Unicode category Lo + Hangul fillers (prevents splicing). redactSensitiveUrl() parses valid URLs, redacts username/password to '***', redacts sensitive params. redactSensitiveUrlLikeString() handles unparseable strings via regex. isSensitiveUrlConfigPath() matches .baseUrl, .httpUrl, .cdpUrl, .request.proxy.url, mcp.servers.*.url. Distinctive: charset-aware normalization resists splicing attacks; hasSensitiveUrlHintTag() lets config fields opt in via UI metadata.

## Third-party Integration

### hermes: Bitwarden Secrets Manager with safe binary distribution

- **bitwarden.py**: Lazy-installs `bws` CLI with pinned version and SHA-256 verification. Stores access token in .env as BWS_ACCESS_TOKEN (one bootstrap secret). Pulls secrets via `bws secret list <project_id>`. Two-layer in-process (dict) + disk-persisted (bws_cache.json, mode 0600, 5min default TTL) cache avoids hammering the API. Failures never block startup. Distinctive: zip-slip guard (refuses path traversal during extraction), atomic writes to cache with temp-file + rename, platform-specific asset detection (macOS universal binary, Windows x86_64/aarch64, Linux with glibc/musl detection).

### openclaw: Proxy capture recording for test fixtures

- **ca.ts + proxy-server.ts**: Generates 7-day debug root CA via openssl, caches locally. MITM proxy logs traffic (sessionId, ts, event metadata, body preview 8KB). assertDebugProxyDirectUpstreamAllowed() enforces managed-proxy mode: when OPENCLAW_PROXY_ACTIVE=1, blocks direct upstream unless DEBUG_PROXY_DIRECT_CONNECT_OVERRIDE=1 (approved diagnostics only).

## Audit & Policy Consistency

### openclaw: Drift detection and policy coherence

- **exec-filesystem-policy.ts**: Scans tool policies per scope (global, agent). If sandbox.mode=all (constrained) + sandboxWorkspaceAccess≠rw + execHost≠gateway/node, then collecting policy violations: exec allowed but write/edit/apply_patch disabled = policy drift (logical inconsistency). Reports which runtime tools remain and which fs tools are blocked. Useful for audit: if fs tools are disabled for security, exec being available is likely unintended unless sandboxed.

## Distinctive Design Patterns

1. **Fail-closed secrets in hermes** (UnscopedSecretError) vs **audit-driven warnings in openclaw** (SecurityAuditFinding with severity grading). hermes stops the agent; openclaw informs operators.

2. **Token lifecycle management in hermes** (status states, cooldown TTLs, terminal vs transient) vs **config audit findings in openclaw** (bind+auth, Control UI origins, tool exposure). hermes tracks credential state; openclaw tracks configuration risk.

3. **Removal contracts in hermes** (RemovalStep registry) vs **soft write/read denylists in openclaw** (multiple guard layers—exact paths, prefixes, project-local). hermes makes removal stick (suppression); openclaw returns errors hoping models respect them.

4. **Charset-aware redaction in openclaw** (Hangul filler splicing resistance) is a defense-in-depth detail absent from hermes (which stores plaintext secrets in .env).

Both systems assume an adversarial agent or misconfigured human. hermes fails closed on credential reads (safe default). openclaw publishes all risks via audit and relies on operators to act. The cleanest design pattern: hermes's RemovalStep registry (small, single-purpose, composable) is more maintainable than openclaw's large audit-finding switch statements.


# 19. Surfaces & UX — CLI/TUI/web UI, canvas, onboarding, diagnostics

_14 capabilities · 29 files read_

## Surfaces & UX Comparison: OpenClaw vs Hermes

### OpenClaw (TypeScript/Node.js)
OpenClaw presents **native terminal UI** via pi-tui, a React-like TUI framework. The core loop (tui.ts) orchestrates three concurrent layers: (1) embedded local agent backend, (2) TuiBackend client interface for multi-agent sessions, (3) real-time event dispatch into pi-tui components. Every keystroke runs through CustomEditor (keyboard protocol aware—decodes Kitty CSI-u for AltGr on international layouts), then routes to one of three handlers: slash command → tui-command-handlers, bash (!) → shell dispatch, plain text → chat submission. Sessions are keyed by agent ID and conversation scope, with automatic fallback to global scope on agent switch.

**Status & diagnostics** are highly structured. status-message.ts aggregates runtime facts (auth mode, thinking level, fast mode, queue depth, plugin health per agent) into a single StatusArgs type, then delegates formatting to lazy-loaded runtime modules. The TUI footer shows compact token usage (total/remaining/percent), model name with provider, and brief health indicators. /gateway-status command expands into a full summary overlay listing session stores, recent conversations, queue depth, and per-agent heartbeat status.

**Rendering safety** is meticulous. Text normalization (tui-formatters.ts) preserves copy-sensitive tokens (paths, URLs, credentials) byte-for-byte by detecting structural patterns (slashes, dots, hyphens, base62-like runs), except in code blocks. CJK text is never chunked; it wraps naturally. Control characters are stripped, and long runs are word-wrapped at grapheme boundaries with zero-width spaces—except for credential-like tokens (24+ chars, alphanumeric + digits), which stay intact to avoid broken copy-paste.

**Hooks system** uses security scanning (install.ts): archive/directory packages are validated against manifest format (openclaw.plugin.json), dependency trees are checked, and install policies gate network-capable or mutable-source installations. Integrity drift (npm version mismatches) surfaces as warnings. Hooks run in agent runtime, so install safety is critical.

**Canvas extension** (extensions/canvas) provides a dual interface for rich UI: model-facing canvas tool calls listNodes() and invokes node commands (present, hide, eval, snapshot, A2UI); CLI wraps this via Gateway RPC. A2UI serialization abstracts away framework details—agents write structured JSON, UI renders it without knowing React/Vue. Snapshots are base64-encoded and sanitized by max dimension config.

### Hermes (Python)
Hermes splits **terminal surfaces** across CLI (display.py, onboarding.py) and web-based TUI (ui-tui, React + nanostores). The CLI emits spinner + kawaii emoji via display.py (lazy skin_engine loading), while the web TUI (ui-tui/src/app.tsx) runs React + Hermes Ink library on the backend (gateway spawned as Python subprocess).

**Onboarding** is first-touch hint driven (onboarding.py). Four flags (BUSY_INPUT_FLAG, TOOL_PROGRESS_FLAG, OPENCLAW_RESIDUE_FLAG, PROFILE_BUILD_FLAG) trigger context-aware messages once per install. The profile-build flow is consent-gated: system note appended to first message tells agent to OFFER profile collection and ask before any external lookup (email, calendar, web_search). Hints are marked seen in config.yaml via atomic YAML write to prevent concurrent corruption.

**Title generation** (title_generator.py) runs in background daemon thread after first exchange, so zero latency. Language is pinnable via config (auxiliary.title_generation.language). Failure callback wires errors to AIAgent._emit_auxiliary_failure for UI visibility—silent drops would hide OpenRouter credit exhaustion.

**Theme negotiation** (ui-tui/src/theme.ts) detects light vs dark via HERMES_TUI_LIGHT, HERMES_TUI_THEME, HERMES_TUI_BACKGROUND (hex luminance check), COLORFGBG (xterm slot 7/15 = light, 0–6/8–14 = dark), or TERM_PROGRAM allow-list (Apple_Terminal defaults light). Computed 8-bit xterm codes map hex colors to safe ANSI slots. Light-mode ANSI normalization coerces foreground colors to meet luminance floor so text stays visible on light terminals.

**Display formatting** (display.py) lazy-loads skin_engine for tool emojis and diff colors. Diff colors derive from ui_error/ui_ok hex values (dark terminal → lighter minus, light terminal → darker minus). Tool preview length is global config (set_tool_preview_max_len). LocalEditSnapshot captures pre-tool filesystem state for local diff rendering post-write.

**Gateway event handler** (ui-tui/src/app/createGatewayEventHandler.ts) listens for live GatewayEvent stream and patches UI state in real time: theme (applySkin), transcript (appendMessage), overlay (ClarifyPrompt, BgTask). Subagent status is normalized to known states; abandoned clarify prompts are deduplicated (persistedAbandonedClarify Set) to avoid double-persistence to transcript.

**Auxiliary client** (agent/auxiliary_client.py) provides unified fallback routing for side tasks (title generation, web extraction, vision). Resolution chain: main provider → OpenRouter → Nous Portal → custom endpoint → native Anthropic → direct API keys → none. Payment/credit exhaustion (HTTP 402) triggers auto-retry with next provider. This prevents silent failures when OpenRouter balance depletes mid-session.

### Key Differences

**1. Framework choice:** OpenClaw uses pi-tui (Node.js, component-based), Hermes uses React + Hermes Ink (Python gateway + web TUI). pi-tui is lighter and closer to kernel; React is more familiar to web devs.

**2. Status visibility:** OpenClaw embeds status in TUI footer + /gateway-status overlay; Hermes spreads it across CLI spinner and web status bar. OpenClaw's structured StatusArgs type makes programmatic queries easier.

**3. Onboarding:** Hermes has explicit first-touch hints + consent-gated profile-build; OpenClaw relies on docs and /help. Hermes's approach teaches users about delegation and privacy upfront.

**4. Failure visibility:** Hermes's auxiliary failure callbacks surface credit exhaustion to users; OpenClaw would silently skip title generation. Hermes philosophy: hidden failures become tech debt.

**5. Canvas/rich UI:** OpenClaw's A2UI abstraction lets agents render arbitrary UX without backend knowledge. Hermes doesn't have an equivalent—it relies on plain text + markdown + code blocks.

**6. Text safety:** OpenClaw's token-aware chunking (preserves credentials, paths, CJK) is more nuanced than Hermes's simpler diff color resolution.

### Cleverest Mechanisms

**OpenClaw:** ChatLog component pooling with automatic eviction (pruneOverflow caps at 180 messages, cleanly drops old tool/run refs). Streaming watchdog (30 s silence triggers "this is taking longer than expected" notice) teaches users latency is expected, not a bug.

**Hermes:** Consent-gated profile-build flow (ask before reading connected accounts) models privacy as a design pattern, not an afterthought. Auxiliary failure callbacks make payment/quota exhaustion visible instead of accumulating as NULL session titles.


# 20. Internationalization / Localization

_12 capabilities · 12 files read_

# Internationalization/Localization: OpenClaw vs Hermes Comparative Teardown

## OpenClaw: Browser-First, Lazy-Loaded, Lit-Reactive

### Core Architecture
OpenClaw's i18n is a **dual-layer system**: (1) **UI layer** in `/ui/src/i18n/` for browser-based Control UI, and (2) **wizard layer** in `/src/wizard/i18n/` for CLI onboarding dialogs. The UI layer dominates in sophistication—19 supported locales (en, zh-CN, zh-TW, pt-BR, de, es, ja-JP, ko, fr, ar, it, tr, uk, id, pl, th, vi, nl, fa) with lazy-loaded .ts module imports.

**Translation registry** (`/ui/src/i18n/lib/registry.ts`): A `LAZY_LOCALE_REGISTRY` maps each non-English locale to a dynamic import function. English (en) ships in the main bundle; all others are fetched on-demand. When user switches locale, `loadLazyLocaleTranslation(locale)` invokes the corresponding loader, extracting the translation map by export name (e.g., `zh_CN` export from `zh-CN.ts`). Failed loads return null; setLocale() silently aborts without crashing.

**I18nManager singleton** (`/ui/src/i18n/lib/translate.ts`): Stateful class that owns locale, translations cache, and subscriber list. Methods:
- `setLocale(locale)`: Load translations if needed, persist to localStorage under key `openclaw.i18n.locale`, notify subscribers.
- `t(key, params)`: Traverse nested translation map via dotted key (e.g., `common.health` → `map['common']['health']`), interpolate params with regex `/\{(\w+)\}/g`, fall back to English, then return key itself.
- `subscribe(subscriber)`: Observer pattern for Lit components to re-render on locale changes.

**Persistent state**: Resolves initial locale via (1) saved localStorage preference, (2) `navigator.language` (browser BCP-47), or (3) English default. Navigator fallback uses prefix matching—`zh-HK` → `zh-TW`, `pt-PT` → `pt-BR`—to map regional variants to supported locales.

**Lit ReactiveController** (`/ui/src/i18n/lib/lit-controller.ts`): Minimal integration—I18nController subscribes to i18n changes in hostConnected(), calls `requestUpdate()` on every locale change, unsubscribes on disconnect. Allows Lit elements using the controller to automatically re-render translated strings.

### Wizard Layer
Separate, minimal implementation for setup copy (only 3 locales: en, zh-CN, zh-TW). **wizardT()** function reads from in-memory LOCALES map, supports dotted-key lookup with fallback to English. **createSetupTranslator()** factory returns a scoped translator that auto-prefixes relative keys (e.g., `botToken` → `wizard.telegram.botToken`) while allowing absolute keys (`common.*`, `wizard.*`) to bypass prefix. Used by setup subflows to reuse shared copy without duplication.

### Locale Generation Pipeline
**control-ui-i18n.ts** script orchestrates batch translation via Claude/GPT APIs. Workflow:
1. Extract English source (`en.ts`) into TranslationBatchItem[] with cache keys.
2. Generate glossaries (glossary.*.json) for domain terminology (e.g., "gateway", "control UI").
3. Submit batch to LLM (default: claude-opus-4-6 or gpt-5.5) with glossary context.
4. Parse translated JSON, validate against placeholder parity ({token} counts must match English).
5. Write locale .ts files and metadata (.i18n/*.meta.json, .i18n/*.tm.jsonl translation-memory logs).

Metadata includes sourceHash (pins which source strings were translated), generatedAt timestamp, totalKeys, translatedKeys, workflow version. Translation memory is incremental—only changed segments need re-translation on future runs.

### Testing & Validation
**registry.test.ts**: Tests lazy loader behavior and locale fallback. Validates that loadLazyLocaleTranslation() returns correct nested structure and that resolveNavigatorLocale() maps browser locales correctly.

**translate.test.ts**: 20+ tests covering singleton initialization, parameter substitution, localStorage persistence, English fallback on missing keys, and **critical invariant tests** (all shipped locales must have identical key structure and non-English translations). Imports all 18 locales at once to verify structural alignment.

---

## Hermes: CLI-Centric, YAML-Native, Config-Aware

### Core Architecture
Hermes i18n (`/agent/i18n.py`) is a **lightweight, single-module solution** for static CLI messages only—approval prompts, gateway slash-command replies, a few restart/drain notices. Agent-generated output, logs, tool outputs, and skill descriptions stay in English (by design; see i18n docstring scope rationale).

**Catalog format**: YAML files under `/locales/{lang}.yaml` (16 supported languages: en, zh, zh-hant, ja, de, es, fr, tr, uk, af, ko, it, ga, pt, ru, hu). Each file is a nested dict that gets flattened at load time into dotted keys (e.g., `approval.dangerous_header`). YAML structure is human-readable for translators; internal lookup is flat O(1) dict.get(key).

**_normalize_lang()** function: Accepts supported codes (en, zh, de), natural-language aliases (chinese→zh, deutsch→de, українська→uk, türkçe→tr), and regional tags (zh-CN→zh, pt-br→pt). 40+ aliases in _LANGUAGE_ALIASES dict handle colloquial variants + native-script names. Falls back to English for unknown inputs.

**Language resolution hierarchy** (`get_language()`):
1. `HERMES_LANGUAGE` env var (immediate, no file I/O).
2. `display.language` from config.yaml (via _config_language_cached() LRU cache, single YAML parse per process).
3. Hardcoded DEFAULT_LANGUAGE ('en').

**Catalog caching** (`_load_catalog()`): Thread-safe _catalog_cache dict with _catalog_lock. First call flattens YAML on disk; subsequent calls return cached flat dict. Missing catalogs log debug, never raise. Thread safety allows gateway to load multiple locales concurrently.

**Dynamic config updates**: reset_language_cache() clears both the config and catalog caches. Called after config.save_config() if a running process needs to pick up a changed `display.language` without restart.

### Installation & Deployment
**_locales_dir()** resolution ladder:
1. `HERMES_BUNDLED_LOCALES` env override (for Nix sealed installs).
2. `{repo-root}/locales` (source checkout, editable pip install).
3. sysconfig data/purelib/platlib schemes (pip wheel installs via setuptools data-files).
4. Fallback to source path (informative error messages).

Supports sealed installs (Nix venvs, pip wheels) where no source tree exists next to agent/. Wheels include locales via setuptools data-files; Nix can override via env var.

### Approval Prompt Localization
In `tools/approval.py`, the dangerous command approval flow imports `from agent.i18n import t` immediately before the input() loop (not module-level). Calls like `t('approval.dangerous_header', description=description)` show prompts in user's language. Uses `.format(**kwargs)` for substitution (e.g., `t('gateway.draining', count=3)`). Approval system is security-critical, so i18n is **late-bound** to defer language resolution and prevent injection attacks that might change approval messages mid-run.

### Testing & Validation
**test_i18n.py** enforces three invariants:
1. **Catalog parity**: Every non-English locale must have exactly the same key set as English (test_catalog_keys_match_english). Catches missing keys that would silently fall back to English for an entire user cohort.
2. **Placeholder parity**: Every translated value must use identical {placeholder} tokens as English (test_catalog_placeholders_match_english). Regex-based validation catches typo'd placeholders (e.g., {descricao} vs {description}) that cause KeyError or silent value drops.
3. **Language resolution**: Tests cover normalization (english→en, ch-CN→zh), env override, config fallback, and unknown-language handling. Tests for _locales_dir() resolution ladder ensure wheel + Nix installs work correctly.

---

## Distinctive Mechanisms: The Cleverness

### 1. OpenClaw: Lazy Loading + Lit Reactivity
OpenClaw's **lazy-load registry** decouples file naming (`zh-CN.ts`) from locale keys (`zh-CN`), reducing initial bundle size. Most English users never fetch the 18 other locale bundles. Export-name indirection (`zh_CN` export) handles TypeScript file-naming constraints.

Lit integration via ReactiveController is tight—component developers never manually subscribe or wire observers. Just add `i18nController = new I18nController(this)` and components automatically re-render on locale changes.

### 2. Hermes: Alias Mapping + Config Caching
Hermes' **40-entry alias dict** accepts user input in dozens of forms (english, English, en-US, en_GB, 中文, zh-CN, chinese, mandarin, simplified-chinese, etc.) and normalizes to canonical codes. For languages with script variants (zh, zh-hant), distinct catalogs prevent Silent character-encoding gotchas.

The **LRU-cached config reader** (`_config_language_cached()`) balances startup performance (single YAML parse) against dynamic config changes. `reset_language_cache()` hook allows the setup wizard to change language and have it take effect immediately without restart.

### 3. Convergent Testing Patterns
Both repos validate **catalog parity** (same keys everywhere) and **placeholder matching** (substitution tokens must align). OpenClaw tests structural alignment at compile time via translate.test.ts; Hermes tests it at runtime via pytest. Both prevent the same class of bugs: incomplete translations and typo'd placeholders.

---

## Why It Matters for Personal Agents

**OpenClaw's dual-layer approach** (UI + wizard) shows how to handle different localization scopes. UI needs broad multi-language support (19 locales) because users access it globally; wizard needs only setup languages (3) because it's first-run only. Lazy loading ensures agents don't balloon with translation files for languages users never select.

**Hermes' scope discipline** (only static CLI messages, not agent output) is crucial for LLM systems. Agent-generated output stays English to preserve reasoning fidelity; only high-impact user-facing prompts (approval, gateway replies) are localized. This prevents "lost in translation" errors in agent behavior.

**Both systems lean on caching and lazy-binding** to avoid parsing YAML or loading modules until the user actually needs a language. Late-binding in Hermes' approval flow (import inside the function, not module-level) prevents language detection from running if no approval is needed that session.

The **alias mapping in Hermes** is a hidden gem—users in non-English locales can type language names in their native script without falling back to English. OpenClaw's navigator-language fallback achieves similar UX via browser signals instead of user input.
