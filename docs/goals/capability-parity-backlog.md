# What Muse Should Build — grounded in openclaw & hermes analysis

> Generated 2026-06-23 by a **2-stage grounded workflow**: (1) 13 analysts read the
> actual competitor source (`/Users/jinan/ai/openclaw` TS/JS · `/Users/jinan/ai/hermes-agent`
> Python) and inventoried real capabilities — **253 competitor files opened**;
> (2) 13 analysts mapped each verified capability to a Muse opportunity, checking Muse for status.
>
> **Every evidence path below was mechanically verified to exist in the competitor repo.**
> Items whose cited file did not resolve were dropped (1 dropped of 167 raw)
> — this is the fix for the earlier pass, where agents projected Muse's own filenames onto openclaw.
>
> **166 opportunities** across 13 domains. Reference-only: each is **Muse's own**
> local-first, grounding-respecting build (Ollama default, `MUSE_LOCAL_ONLY` on, fabrication=0,
> model-agnostic core, draft-first outbound, banking out of scope). No item makes a cloud vendor
> the runtime owner or relies on a bigger model.
>
> **Reading:** `status` = `none` (Muse lacks it) / `partial` (weaker version). `★1–5` =
> leverage toward parity. `S/M/L` = effort. **Based-on** cites the verified competitor file.
> Quantitative figures in *Value* are analyst-asserted hypotheses — prove via the *Verify* gate.


## Priority index — do these first


### ★★★★★ (12)

- `CTX-1` — Legacy summary prefix stripping on re-compaction
- `MEM-1` — Multi-Provider Memory Backend Interface
- `MEM-2` — Concept Tagging and Semantic Vocabulary Extraction
- `MEM-3` — LanceDB Importance-Ranked Vector Store
- `TSF-1` — Tool-Level Policy Conformance Groups
- `REL-1` — Jittered exponential backoff with decorrelated seeds
- `REL-2` — Comprehensive API error classification taxonomy
- `CHN-1` — Webhook HMAC validation with constant-time comparison and rate limiting
- `MED-1` — Multi-Provider TTS Fallback with Ordered Chain
- `WEB-1` — Pluggable Web Search Provider Registry with Capability Routing
- `I18N-1` — CLI locale resolution from environment variables
- `I18N-2` — Catalog parity enforcement via test suite

### ★★★★ (32)

- `LLM-1` — Anthropic native output_config.effort (thinking level) mapping
- `CTX-2` — Parenthesis-aware reference preservation in chunking
- `CTX-3` — File-operation metadata tracking in compactions
- `CTX-4` — Compression metadata with summary-end markers
- `MEM-4` — Memory Wiki / Knowledge Vault with Hand-Curated Separation
- `MEM-5` — Deep Dreaming with Light Sleep + REM Phases
- `MEM-6` — Spaced-Practice Short-Term to Long-Term Promotion Pipeline
- `MEM-7` — Pluggable Embedding Provider Interface with Multi-Model Support
- `SKL-1` — Skill Config Variable Extraction and Frontmatter Resolution
- `SKL-2` — Skill Workshop Proposal and Approval Quarantine Workflow
- `TSF-2` — Network SSRF Policy & URL Credential Redaction
- `TSF-3` — Execution Approval Configuration & Allowlisting
- `TSF-4` — Tool Result Classification for Loop Detection
- `REL-3` — Per-attempt recovery bookkeeping with one-shot guards
- `REL-4` — Rate limit state parsing from response headers
- `REL-5` — Turn finalization with cleanup-error isolation
- `AUT-1` — Job delivery modes (announce/webhook/silent) with stale-response suppression
- `AUT-2` — Cron job idempotency via dedup_key and re-arming
- `ORC-1` — Multi-Agent Session Lifecycle & Eviction
- `ORC-2` — Session Event Bridge with Progress Callbacks
- `ORC-3` — Permission Gateway with Child Approval Timeout
- `CHN-2` — Multi-account Slack/Discord with per-account config & token resolution
- `CHN-3` — Thread-aware auto-reply routing per account with reply mode tracking
- `CHN-4` — Deterministic send-error classification with retryability signals
- `MED-2` — Streaming Audio Synthesis (TTS ReadableStream)
- `MED-3` — Audio Format Transcoding & Platform-Adaptive Delivery
- `MED-4` — PDF Extraction with Image Fallback (OCR via Vision Model)
- `WEB-2` — Pluggable Browser Provider Registry with Cloud Auto-Detection
- `WEB-3` — Native JavaScript Dialog Supervisor with Agent Visibility
- `UX-1` — Structured Health Checks with Repair Contracts and CI-Ready Linting
- `I18N-3` — Lazy-loaded locale splitting for web bundle optimization
- `I18N-4` — Hierarchical dotted-key fallback with depth-first traversal

---


## 1. LLM Runtime · Providers · Tool-Call Repair · Prompt Caching

_12 opportunities · 25 competitor files read_


### `LLM-1` Anthropic native output_config.effort (thinking level) mapping  ★★★★ · M · none

- **Based on (openclaw):** `packages/llm-core/src/model-contracts/anthropic.ts` — Normalized thinking/reasoning level mapping across providers (openclaw/hermes pattern)
- **Muse today:** none — packages/model/src/adapter-anthropic.ts, provider-anthropic.ts, and index.ts show no output_config, effort field, or thinking-level normalization
- **Proposal:** Add thinking-level resolution to packages/model/src/provider-anthropic.ts. Define ThinkingLevelMap type with normalized levels (minimal, low, medium, high, max). Extend toAnthropicRequest to accept an optional thinking_effort field from ModelRequest and translate it to output_config.effort. Build a per-model allowlist (claude-opus, claude-sonnet, etc.) that supports native thinking; older models get a no-op. Extend ModelRequest.reasoning to accept detailed thinking config.
- **Value:** Enables Muse to use Anthropic's native extended thinking (claude-opus reasoning) while maintaining provider-agnostic request API; critical for leveraging native model reasoning without cloud SDK coupling
- **Verify:** Unit test: verify that request with thinking_effort='high' maps to output_config.effort='high' for Opus; older Claude returns no-op. Integration test: generate with thinking enabled and verify thinking_tokens appear in response.usage.

### `LLM-2` Prompt caching message-history transformation (multi-turn cache markers)  ★★★ · M · partial

- **Based on (hermes):** `agent/prompt_caching.py` — Chat-completion message history transformation (Anthropic prompt caching) in hermes
- **Muse today:** partial — packages/cache/src has AnthropicPromptCache class and test shows cacheSystemPrompt/cacheTools support; packages/prompts/src has cache boundary markers. But no per-message cache_control block placement (all at top level).
- **Proposal:** Enhance packages/cache/src to implement apply_anthropic_cache_control: place cache_control markers on system prompt block + last 3 non-system message blocks (not just the outer request level). Update toAnthropicRequest in packages/model/src/provider-anthropic.ts to walk the message array and inject cache_control: {type: 'ephemeral', ttl_seconds: 300} at appropriate content-block positions (system only, tool results, assistant text). Preserve existing test coverage.
- **Value:** Enables ~75% token savings on multi-turn conversations by caching the most-recent stable prefix instead of whole-request; cost reduction without model changes
- **Verify:** Unit test: verify that a 5-turn conversation with cache markers produces usage.cache_read_input_tokens > 0 on the 4th+ turn. Cost regression test: confirm total tokens for multi-turn drops by measured ~75% vs uncached.

### `LLM-3` Event-driven streaming with separate final-result promise (AsyncIterable + Promise<Result>)  ★★★ · M · partial

- **Based on (openclaw):** `packages/llm-core/src/utils/event-stream.ts` — Event-driven streaming with separate final-result promise (openclaw pattern)
- **Muse today:** partial — packages/model/src/index.ts defines ModelProvider.stream() as AsyncIterable<ModelEvent>. model-loop.ts yields events but streams and final result are tightly coupled; callers can't elegantly await final message while iterating.
- **Proposal:** Create packages/model/src/event-stream.ts: EventStream<T, R> implements AsyncIterable<T> with separate Promise<R> for final result. Queue + waiting-callbacks handle async push/iteration. ModelProvider.stream() returns {[Symbol.asyncIterator](): AsyncIterator<ModelEvent>, result: Promise<ModelResponse>}. Update adapter implementations to yield events and resolve final promise on 'done' event. Update model-loop.ts and streaming callers to leverage separate promise for clean final-result handling.
- **Value:** Separates streaming progress (delta-by-delta) from final-result awaiting; prevents message fragmentation and enables proper error propagation without complex event reconstruction
- **Verify:** Unit test: stream ModelRequest, iterate 10 deltas while simultaneously awaiting .result promise; verify both complete without deadlock and final response is clean. Regression: existing streaming iterators still work.

### `LLM-4` Tool-call plain-text repair with streaming state machine  ★★ · L · partial

- **Based on (openclaw):** `packages/tool-call-repair/src/promote.ts, packages/tool-call-repair/src/stream-normalizer.ts` — Plain-text tool-call repair and promotion + Streaming tool-call text normalization (openclaw pattern)
- **Muse today:** partial — packages/model/src/provider-shared.ts has recoverToolArgsJson() and sanitizeToolCallName(); adapter-ollama.ts recovers args from strings. But no streaming state machine for partial-tag buffering across deltas, no plain-text [tool:name] bracket format detection or promotion to native ToolCall blocks.
- **Proposal:** Create packages/model/src/tool-call-repair.ts with PlainTextToolCallStreamNormalizer state machine: detect bracket ([tool:name]...) and XML-ish tool-call formats in text deltas, buffer partial payloads across chunk boundaries, emit normalized tool-call events. Export from index.ts. Integrate into streaming path in adapter-ollama.ts and OpenAI-compatible path. Add hooks in ModelProvider.stream to optional repair middleware.
- **Value:** Small local models (gemma4, qwen) leak tool calls as text when instruction-tuning is weak; stateful streaming repair recovers them without losing information, preventing tool-routing fallbacks
- **Verify:** Streaming test: mock a Qwen model that emits '[tool: search]\n{"query": "test"}' across 3 deltas; verify normalizer buffers and emits proper tool-call event. End-to-end: confirm leaky-model paths now route correctly instead of falling back to clarification.

### `LLM-5` Message sanitization with surrogate recovery (UTF-8 + control char handling)  ★★ · S · none

- **Based on (hermes):** `agent/message_sanitization.py` — Message and tool-payload sanitization with surrogate recovery (hermes pattern)
- **Muse today:** none — packages/model/src/provider-shared.ts and provider-openai-parse.ts show no surrogate handling or control-char escaping. No multi-field coverage for reasoning_content or tool arguments.
- **Proposal:** Add packages/model/src/message-sanitizer.ts: export sanitizeMessages(messages: ModelMessage[]) that walks all message content, tool arguments, and optional reasoning fields; replaces lone surrogates (U+D800-DFFF) with U+FFFD and unescaped control chars (0x00-0x1F) with safe escapes. Integrate into toAnthropicRequest, toGeminiRequest, toOpenAIChatRequest. No-op on clean input.
- **Value:** Byte-level models emit invalid UTF-8 that crashes JSON.dumps; deterministic sanitization prevents downstream crashes and silent data loss in multi-field structures
- **Verify:** Unit test: ModelMessage with lone surrogates in content and tool arguments; verify all replaced with U+FFFD and JSON stringification succeeds. Regression: ensure clean messages are byte-identical after sanitization.

### `LLM-6` Streaming thinking/reasoning block scrubber with partial-tag buffering  ★★ · M · partial

- **Based on (hermes):** `agent/think_scrubber.py` — Streaming reasoning/thinking block scrubbing with partial-tag buffering (hermes think_scrubber.py)
- **Muse today:** partial — packages/model/src/provider-shared.ts has stripLeadingThinkBlock() and createLeadingThinkStripper() that handle <think> tags. But createLeadingThinkStripper only strips LEADING blocks; no support for multiple variants (<thinking>, <reasoning>, <thought>), no per-consumer scrubbing for TTS/CLI hygiene.
- **Proposal:** Enhance packages/model/src/provider-shared.ts: extend createLeadingThinkStripper to handle variants (<thinking>, <reasoning>, <REASONING_SCRATCHPAD>, <thought>) and optionally scrub mid-stream (not just leading). Export as createUniversalThinkStripper(options: {stripLeading?: boolean; stripAll?: boolean; variants?: string[]}). Add StreamingThinkScrubber facade that composites stripe + buffering logic for multi-consumer use (CLI, TTS, gateway). Apply in streaming model loops.
- **Value:** Ensures consistent reasoning-free output across all consumers (UI, TTS, logging) without per-consumer custom filtering; prevents reasoning leakage in non-expert interfaces
- **Verify:** Streaming test: model emits '<thinking>solve step 1</thinking>answer', split across 3 deltas; verify scrubber yields only 'answer' and empty scrubbed blocks correctly. Multi-variant test: verify <reasoning>, <REASONING_SCRATCHPAD> are also handled. Consumer test: TTS flow receives only cleaned text.

### `LLM-7` Tool parallelism gating with destructive-command + file-path conflict detection  ★★ · M · partial

- **Based on (hermes):** `agent/tool_dispatch_helpers.py` — Tool parallelism gating with file-path conflict detection (hermes pattern)
- **Muse today:** partial — packages/agent-core/src/tool-batch-conflict.ts detects write-write conflicts on same identity arg. But no never-parallel tool allowlist (clarify), no destructive-command regex (rm/mv/sed -i/git-reset), no file-path-overlap detection across different tools targeting the same path.
- **Proposal:** Enhance packages/agent-core/src/tool-batch-conflict.ts with: (1) NEVER_PARALLEL_TOOLS constant (clarify, etc.). (2) isDestructiveCommand(tool, args) regex detector for rm/mv/cp with overwrite/git-reset/output-redirect. (3) extractFilePaths(tool, args): parse tool.inputSchema + args to detect file paths (e.g. file_edit.path, shell.command→sed -i target). (4) shouldParallelizeToolBatch(calls, tools, isMutating) returns false if batch contains never-parallel tools, destructive commands, or overlapping file-path scopes. Export and apply in model-loop.ts tool-execution gating.
- **Value:** Prevents data races when local models emit legitimate parallel read-only batches while blocking write-write and destructive races; fine-grained parallelism unlocks performance without safety compromise
- **Verify:** Unit test: batch=[file_read('/tmp/a'), file_read('/tmp/b')] → parallelizable=true. Batch=[file_edit('/tmp/a', {content:'new'}), file_edit('/tmp/a', {content:'other'})] → parallelizable=false. Batch=[shell('rm file'), anything] → parallelizable=false.

### `LLM-8` Gemini native API transport with OpenAI-compatible facade + tier detection  ★★ · S · partial

- **Based on (hermes):** `agent/gemini_native_adapter.py` — Gemini native API transport with OpenAI-compatible facade (hermes pattern)
- **Muse today:** partial — packages/model/src/adapter-gemini.ts exists and uses Gemini native generateContent API (not OpenAI-compat). But no tier detection (free vs paid), no rate-limit header probing to gate free-tier features.
- **Proposal:** Enhance packages/model/src/adapter-gemini.ts: add probeGeminiTier() that makes a lightweight request and inspects response headers (x-ratelimit-*) to detect free tier. Cache tier result. Block unsupported features (batching, vision, reasoning) on free tier by returning canUseFeature=false. Export tier info in ModelCapabilities.cost field ("free" vs "medium"). Update listModels to filter by tier.
- **Value:** Prevents silent free-tier failures (quota exhaustion, feature unavailable) by upfront tier detection; graceful degradation instead of cryptic errors
- **Verify:** Unit test: mock free-tier rate-limit headers, verify tier detection returns 'free'. Mock paid-tier headers, verify 'paid'. Feature-gating test: free tier blocks vision models from selection.

### `LLM-9` Model catalog with provider compatibility metadata (models.dev-like registry)  ★ · L · none

- **Based on (openclaw):** `packages/model-catalog-core/src/model-catalog-types.ts` — Model catalog with provider compatibility metadata (openclaw pattern)
- **Muse today:** none — packages/model/src/index.ts has ModelCapabilities and ModelInfo types; no central catalog with 40+ provider-specific compat flags (supportsStore, cacheControlFormat, requiresThinkingAsText, etc.). Static capabilities are hardcoded per-model in adapters.
- **Proposal:** Create packages/model-catalog/src with: (1) ModelCompatConfig interface with provider-specific flags (supportsEagerToolInputStreaming, cacheControlFormat, supportsXhighEffort, requiresThinkingAsText, etc.). (2) MODEL_CATALOG: a JSON/TypeScript record mapping provider+modelId to compat flags. (3) resolveCompat(provider, modelId): returns merged {defaultFlags + overrides}. Build offline-first snapshot of common models (Anthropic, OpenAI, Gemini, Ollama). Optional: lazy-load from models.dev API with 60-min refresh. Apply in provider adapters to auto-adjust request shape (e.g. thinking→text for legacy models).
- **Value:** Centralizes model metadata so a single model definition works across fundamentally different APIs with auto-detected workarounds; eliminates per-adapter hardcoding and shrinks maintenance surface
- **Verify:** Unit test: query MODEL_CATALOG for claude-opus-4 returns {supportsNativeThinking: true, supportsCache: true}; legacy claude-3-sonnet returns {supportsNativeThinking: false}. Integration: adapter uses compat flags to auto-omit thinking from legacy model request.

### `LLM-10` AWS Bedrock Converse API integration with credential chain + dynamic model discovery  ★ · L · none

- **Based on (hermes):** `agent/bedrock_adapter.py` — AWS Bedrock Converse API integration with dynamic model discovery (hermes pattern)
- **Muse today:** none — No bedrock adapter exists in packages/model/src. Only OpenAI-compatible, Anthropic native, Gemini, and Ollama adapters present.
- **Proposal:** Create packages/model/src/adapter-bedrock.ts: Direct boto3-equivalent using AWS SDK for JavaScript. Manage separate runtime + control-plane clients per region. Support Bedrock Converse API (not OpenAI-compat endpoint). Lazy-import AWS SDK (optional peer dep) to keep startup fast. Credential chain: env vars (AWS_ACCESS_KEY_ID), profiles, IAM instance roles. Dynamic model discovery via ListFoundationModels + cache. Export BedrockProviderOptions and BedrockProvider class. Wire into ModelProviderRegistry.
- **Value:** AWS-native environments get zero API-key management (IAM-based); Converse API is canonical Bedrock path. Unlocks Bedrock exclusive models (Claude via Bedrock) without OpenAI-compat fragility
- **Verify:** Unit test: mock AWS SDK, verify credentials resolved from env chain. Integration test (requires AWS account): list models and send inference, verify response parsed correctly. Regression: existing providers unaffected.

### `LLM-11` Multi-provider model ID normalization (preview→stable, model renames)  ★ · S · none

- **Based on (openclaw):** `packages/model-catalog-core/src/provider-model-id-normalize.ts` — Multi-provider model ID normalization with preview-to-stable promotion (openclaw pattern)
- **Muse today:** none — packages/model/src/index.ts has parseModelName() but no normalization for preview→stable transitions (gemini-3.1-flash-lite-preview), provider renames, or model deprecation mapping.
- **Proposal:** Create packages/model/src/model-id-normalize.ts: normalizeModelId(provider, modelId) → normalizedId. Implement per-provider functions: normalizeGooglePreviewId (preview→GA), normalizeTogetherId (Kimi versioning), etc. Maintain a DEPRECATED_MODELS map {old→new}. Apply in ModelProviderRegistry.selectModel() and provider.listModels() to present canonical names to users while internally routing to current APIs.
- **Value:** Models/providers rename/deprecate constantly; centralized normalization prevents config breakage when endpoints transition from preview to stable
- **Verify:** Unit test: normalizeGooglePreviewId('gemini-3.1-flash-lite-preview') → 'gemini-3.1-flash-lite'. Registry test: old model name still works via deprecation map redirect.

### `LLM-12` Anthropic native streaming vision support (streaming image+text handling)  ★ · S · partial

- **Based on (openclaw):** `packages/llm-core/src/model-contracts/anthropic.ts` — Normalized provider capabilities with vision streaming variant handling (implied in openclaw)
- **Muse today:** partial — packages/model/src/provider-anthropic.ts has vision attachment support in toAnthropicMessage (base64 + url). But no streaming vision metadata or incremental vision-block handling; only full-message attachment transform.
- **Proposal:** Extend packages/model/src/provider-anthropic.ts toAnthropicRequest: detect vision models (claude-opus-4 with vision flag); add streaming support for incremental image blocks if Anthropic's streaming API surfaces partial vision progress (checkpoint with Anthropic v1 spec). For non-streaming, keep current attach-to-message logic.
- **Value:** Enables streaming vision requests to Anthropic (if API supports), reducing time-to-first-token for vision-heavy workflows
- **Verify:** Unit test: vision message with attachment streams incrementally (if supported). Regression: non-vision still works identically.

## 2. Context Engineering · Compression · References · Windowing

_13 opportunities · 20 competitor files read_


### `CTX-1` Legacy summary prefix stripping on re-compaction  ★★★★★ · S · none

- **Based on (hermes):** `agent/context_compressor.py` — hermes: _HISTORICAL_SUMMARY_PREFIXES tuple holds old prefix variants; normalizer strips stale prefixes so old directives don't hijack model replies
- **Muse today:** none — packages/memory/src/memory-conversation-summary-store.ts doesn't strip legacy prefixes on re-load
- **Proposal:** Add LEGACY_COMPACTION_SUMMARY_PREFIXES tuple to packages/memory/src/index.ts (capturing old COMPACTION_SUMMARY_PREFIX formats across releases). In applyStoredConversationSummary() (packages/agent-core/src/context-transforms.ts), strip any legacy prefix found in summary narrative before re-injecting. Prevents carryover of old compression semantics into new sessions.
- **Value:** Sessions resume across client updates. Stale directives from older releases contradict new semantics. Scrubbing ensures consistent model behavior post-update.
- **Verify:** A summary from v0.8 with old prefix 'resume exactly from Active Task' has that prefix removed before v0.9 uses it.

### `CTX-2` Parenthesis-aware reference preservation in chunking  ★★★★ · S · none

- **Based on (openclaw):** `packages/markdown-core/src/render-aware-chunking.ts` — openclaw: findMarkdownIRPreservedSplitIndex() avoids breaking file refs like (path/file.ts)
- **Muse today:** none — packages/agent-core/src/recall-chunking.ts splits only on paragraph/word boundaries, no paren-depth tracking
- **Proposal:** Enhance packages/agent-core/src/recall-chunking.ts chunkText() to track parenthesis depth and prefer splits outside parentheses. Store lastOutsideParenBreak and lastOutsideParenWhitespaceBreak to avoid breaking file paths and references.
- **Value:** File paths and URLs in parentheses stay intact through chunking, preserving retrievability and citation accuracy.
- **Verify:** A chunk split with '(path/to/file.ts)' inside keeps the full path intact in one chunk.

### `CTX-3` File-operation metadata tracking in compactions  ★★★★ · S · none

- **Based on (openclaw):** `packages/agent-core/src/harness/compaction/compaction.ts` — openclaw: extractFileOperations() tracks read/write/edit files; CompactionDetails stores readFiles + modifiedFiles; formatFileOperations() appends as XML metadata tags
- **Muse today:** none — packages/memory/src/memory-token-trim.ts has no file-operation tracking; no metadata extraction from tool calls
- **Proposal:** Add extractFileOperations() to packages/memory/src (or new file file-operations-metadata.ts). Track read/write/edit files from tool results in the compaction range. Store in ConversationTrimResult as readFiles / modifiedFiles arrays. Append as XML-style summary metadata tags (<read-files>, <modified-files>) to the compaction summary so future model context knows what's been edited without full code inclusion.
- **Value:** Model knows what files were touched to avoid repeating changes or reading stale cache. File metadata is cheap compression-safe state conveyance.
- **Verify:** Compaction summary includes '<read-files>src/main.ts, src/util.ts</read-files>' tags extracted from prior tool calls.

### `CTX-4` Compression metadata with summary-end markers  ★★★★ · S · none

- **Based on (hermes):** `agent/context_compressor.py` — hermes: Compressed summaries receive _compressed_summary metadata key; SUMMARY_END_MARKER ('--- END OF CONTEXT SUMMARY ...') appended to signal boundary
- **Muse today:** none — packages/memory/src/memory-conversation-summary-store.ts stores narrative but adds no explicit boundary marker or metadata
- **Proposal:** Add COMPRESSED_SUMMARY_METADATA_KEY and SUMMARY_END_MARKER to packages/memory/src/index.ts. When insertCompactionSummary() generates a summary, append '--- END OF CONTEXT SUMMARY ---' marker. Tag the system message with _compressed_summary metadata (dropped by wire sanitizers before strict API gateways). Prevents weak models from re-executing old tasks embedded in the summary.
- **Value:** LLMs confuse summaries with instructions and can re-run old steps. Metadata + explicit markers prevent misinterpretation of old context.
- **Verify:** Summary message includes end marker; model doesn't re-execute old tasks from summary content.

### `CTX-5` Render-aware markdown chunking with style preservation  ★★★ · M · none

- **Based on (openclaw):** `packages/markdown-core/src/render-aware-chunking.ts` — openclaw: style spans + link offset adjustment during render-bounded splitting
- **Muse today:** none — packages/agent-core/src/recall-chunking.ts has char-based splitting, no format preservation
- **Proposal:** Add render-aware chunking to packages/agent-core/src/recall-chunking.ts: renderMarkdownIRChunksWithinLimit() splits by rendered size (not character count), tracking style spans and link offsets across chunk boundaries. Use binary-search-like logic to find character split points that fit rendered token budgets while preserving bold/italic/links.
- **Value:** Prevents markdown corruption (links split mid-URL, code blocks mid-backtick) when knowledge chunks are token-constrained.
- **Verify:** Test that a chunk containing '**bold [link](path.ts)**' splits at word boundary, not mid-format.

### `CTX-6` Subdirectory hint discovery with lazy loading  ★★★ · M · none

- **Based on (hermes):** `agent/subdirectory_hints.py` — hermes: SubdirectoryHintTracker loads AGENTS.md/.cursorrules per directory on first access, caps at 8KB, walks up 5 ancestors
- **Muse today:** none — No per-directory context file loading; no lazy AGENTS.md/.cursorrules discovery in Muse
- **Proposal:** Create packages/agent-core/src/subdirectory-hints.ts with SubdirectoryHintTracker. On tool_call (read_file, search, etc.), extract directory and load AGENTS.md/.cursorrules from that dir + up to 5 ancestors if not already cached. Cap each file at 8KB. Append hints as system section context without modifying prompt (preserves caching). Dedupe via _loaded_dirs Set.
- **Value:** Large projects have context files at each level. Lazy discovery surfaces relevant rules as agent navigates, without pre-loading every possible context file and bloating the session.
- **Verify:** Agent reads src/auth/main.ts; hints from src/auth/AGENTS.md and src/AGENTS.md auto-surface; second read of same dir doesn't re-load.

### `CTX-7` Compression threshold tuning with context-window ratio  ★★★ · S · partial

- **Based on (hermes):** `agent/context_compressor.py` — hermes: should_compress() checks prompt_tokens > threshold_tokens; dynamic threshold via _compute_threshold_tokens() with percentage-based + degenerate small-window handling
- **Muse today:** partial — packages/memory/src/memory-token-trim.ts has workingBudgetTokens + hardBudgetTokens but no dynamic threshold percentage tuning per model's effective window
- **Proposal:** Enhance ConversationTrimOptions in packages/memory/src/index.ts: add thresholdPercentage (default 75%) and effectiveContextWindow (contextWindow - maxCompletionTokens). In trimConversationMessages(), compute dynamic threshold as percentage of effective window, with degenerate case (window <10k) triggered at 85% instead. Fire compression before provider hard limit, not at it.
- **Value:** Triggers fire early enough to preserve quality, late enough to maximize budget usage. Tuning per model's actual output reservation prevents provider-side rejections.
- **Verify:** A 10k-token model with 1k max_completion_tokens triggers at 85% of 9k (7.65k), not 75%.

### `CTX-8` Split-turn prefix summarization for mid-conversation boundaries  ★★★ · M · partial

- **Based on (openclaw):** `packages/agent-core/src/harness/compaction/compaction.ts` — openclaw: When findCutPoint() splits an in-progress turn, messagesToSummarize + turnPrefixMessages are separated; prefix gets generateTurnPrefixSummary() with specialized prompt focusing early decisions + context bridge
- **Muse today:** partial — packages/memory/src/memory-token-trim.ts has trimming logic but no specialized split-turn prefix handling
- **Proposal:** Enhance insertCompactionSummary() in packages/memory/src/memory-token-trim.ts: when isSplitTurn=true, separate turnPrefixMessages from messagesToSummarize. Call generateTurnPrefixSummary() on prefix with a prompt targeting early decisions + context needed by the retained suffix. Concatenate both summaries with markdown separator so the boundary is explicit.
- **Value:** Conversations rarely end at message boundaries. Split-turn summarization preserves the context bridge between discarded prefix and kept suffix, preventing causality breaks.
- **Verify:** A cut splitting an assistant's multi-step response generates both prefix summary (what was attempted) and full summary (the plan).

### `CTX-9` Focus-topic-guided compression with asymmetric detail allocation  ★★ · M · none

- **Based on (hermes):** `agent/context_compressor.py` — hermes: compress() accepts optional focus_topic; summarization prompt directs ~60-70% allocation to focus-topic content with full detail
- **Muse today:** none — packages/memory/src/memory-token-trim.ts has uniform importance scoring, no focus-topic guidance
- **Proposal:** Add focusTopic parameter to ConversationTrimOptions in packages/memory/src/memory-token-trim.ts. When set, scoreMessageContent() weights messages mentioning the focus topic +0.4 (vs uniform weighting). Pass focusTopic into compaction summary generation so the summarizer allocates ~70% tokens to focus-content with verbatim detail (file paths, values) and summarizes others aggressively.
- **Value:** Compression preserves deep detail on user's current priority while aggressively compacting tangential old work, maintaining focus across recompaction cycles.
- **Verify:** Compacting a conversation with focusTopic='authentication' preserves full file paths + error messages in auth-related messages while summarizing unrelated tool outputs.

### `CTX-10` Context-reference expansion with @-syntax and token tracking  ★★ · M · none

- **Based on (hermes):** `agent/context_references.py` — hermes: parse_context_references() extracts @file/@folder/@diff/@url syntax; preprocess inlines content + tracks injected_tokens
- **Muse today:** none — No @-syntax reference expansion in Muse; no inline-context-expansion with token tracking
- **Proposal:** Add parseContextReferences() to packages/agent-core/src/context-transforms.ts (or new file context-references.ts). Extract @file:"path":10-20, @diff, @staged, @folder, @git:COMMIT, @url patterns from user messages via regex. Inline fetched content into messages, track injected_tokens for budget accounting. Scan inlined content for injection threats via deterministic pattern matching (no LLM).
- **Value:** Users say '@file:path.ts' and agent gets that content instantly without asking. Token counting stays accurate across reference expansion so budget trim accounts for injected context.
- **Verify:** User message '@file:src/main.ts:1-50' expands inline; injected_tokens is added to budget calculation; malicious '@file:../../../etc/passwd' is rejected.

### `CTX-11` Tool-result deduplication and pre-LLM compression  ★★ · M · none

- **Based on (hermes):** `agent/context_compressor.py` — hermes: _prune_old_tool_results() does 2-pass: dedup identical results (hash-based), then summarize old results as '[tool_name]first_arg (N chars result)'; preserves tail + recent
- **Muse today:** none — packages/memory/src/memory-token-trim.ts trims messages but doesn't pre-compactify tool results
- **Proposal:** Add pruneOldToolResults() to packages/memory/src/memory-token-trim.ts (or new file tool-result-compression.ts). Pass 1: hash-dedupe identical tool outputs (same content = one kept, others dropped). Pass 2: before LLM summarization, replace old results (before prune_boundary) with compact form '[tool_name]arg (N chars)'. Keep last protect_tail_count results verbatim. Returns (prunedMessages, prunedCount).
- **Value:** Tool outputs (file listings, command output) dominate token count. Pre-LLM dedup+summarization (no model call) buys space before expensive summarization, speeds up compression.
- **Verify:** Two identical 'ls -la' results are deduplicated; old 'grep' results become '[grep]pattern (1523 chars)'.

### `CTX-12` Iterative summary updates with previous-summary context  ★★ · M · partial

- **Based on (openclaw):** `packages/agent-core/src/harness/compaction/compaction.ts` — openclaw: generateSummary() accepts optional previousSummary; selects SUMMARIZATION_PROMPT (initial) vs UPDATE_SUMMARIZATION_PROMPT (incremental); update preserves prior info while adding new completions
- **Muse today:** partial — packages/memory/src/memory-token-trim.ts generates summaries but doesn't use prior summary to guide incremental updates; memory-conversation-summary-store.ts stores but doesn't feed back
- **Proposal:** Enhance insertCompactionSummary() in packages/memory/src/memory-token-trim.ts to accept previousSummary (from ConversationSummaryStore.get()). Use conditional prompts: SUMMARIZATION_PROMPT (initial) vs UPDATE_SUMMARIZATION_PROMPT (incremental, explicitly preserving prior info while adding new work + decisions). Update prompt names the sections: Goal, Constraints, Progress (Done/In Progress/Blocked), Key Decisions, Next Steps, Critical Context.
- **Value:** Recompression cycles don't lose context already summarized. Iterative updates prevent summary erosion and maintain continuity across multiple compactions in long sessions.
- **Verify:** Second compaction in a session produces a summary that retains facts from the first summary + adds new progress.

### `CTX-13` Prompt-cache-friendly system prompt partitioning  ★ · M · partial

- **Based on (hermes):** `agent/system_prompt.py` — hermes: system prompt built in 3 tiers (stable/context/volatile) with cache_control at stable+context boundary
- **Muse today:** partial — packages/prompts/src/index.ts has buildSystemPrompt() + prompt layers but no tier-based cache partitioning; packages/agent-core/src/context-transforms.ts injects multiple context sections post-composition
- **Proposal:** Add PromptCachePartition interface to packages/prompts/src/index.ts with stable (identity, tools, skills, platform hints, model info) / context (caller system_message, AGENTS.md) / volatile (memory, USER.md, session info, active-context, inbox, episodic) tiers. buildSystemPrompt() should compose these with clear boundaries and return both fullPrompt and cacheControlMarker. Compression triggers prompt rebuild only, leaving cache warm.
- **Value:** Prompt caching cuts costs ~75% on multi-turn when stable+context prefix is reused across turns. Partitioning isolates volatile content (memory, timestamps) so cache survives memory updates.
- **Verify:** System prompt is composed once per session; memory updates trigger re-render of volatile section only; cache hit rate stays >80% across 10+ turns.

## 3. Memory · Vector Store · Active Memory · Insights · Curation

_11 opportunities · 18 competitor files read_


### `MEM-1` Multi-Provider Memory Backend Interface  ★★★★★ · M · none

- **Based on (hermes):** `agent/memory_manager.py` — Hermes MemoryManager + MemoryProvider ABC pattern enabling Honcho/Hindsight/Mem0 pluggability
- **Muse today:** none — packages/memory/src (UserMemoryStore + TaskMemoryStore exist, no MemoryProvider ABC)
- **Proposal:** Create packages/memory/src/memory-provider.ts with MemoryProvider ABC (initialize, prefetch, sync_turn, get_tool_schemas, handle_tool_call, optional lifecycle hooks). Implement builtin provider wrapping UserMemoryStore + TaskMemoryStore. Manager coordinates single external provider via ThreadPoolExecutor-like pattern; streaming context scrubber sanitizes memory tags at chunk boundaries. Fail-close: external provider failure degrades gracefully, never blocks turn.
- **Value:** Unlocks third-party memory backend integration (Honcho citation tracking, Hindsight evidence pointers) without forking Muse memory core. One-provider limit prevents tool-schema bloat.
- **Verify:** Test memory provider instantiation, prefetch async execution, tool-schema synthesis from provider.get_tool_schemas(), turn-sync lifecycle, and degradation when external provider times out.

### `MEM-2` Concept Tagging and Semantic Vocabulary Extraction  ★★★★★ · M · none

- **Based on (openclaw):** `extensions/memory-core/src/concept-vocabulary.ts` — OpenClaw deriveConceptTags() — extract semantic tags via stop-word filtering + script-family analysis for cross-lingual indexing
- **Muse today:** none — packages/memory/src (pinned-entities, salient-facts exist; no concept-vocabulary module)
- **Proposal:** Create packages/memory/src/concept-vocabulary.ts exporting deriveConceptTags(text) → string[] (stop-word filtered, script-family labeled: latin/cjk/mixed). Build script-family.ts detector (reuse existing episodic-recall's cosineSimilarity precedent). Tag ShortTermRecallEntry.conceptTags on every auto-extract. Enable faceted search in recall tools ("security", "database", "user management" tags). Pure deterministic extraction — no model calls, respects local-first constraint.
- **Value:** Enables semantic clustering and faceted memory recall without external embedding on every fact. Cross-lingual indexing surfaces relevant memories across language boundaries.
- **Verify:** Test deriveConceptTags() on English/Korean/mixed content; verify stop-word filtering excludes corpus-common terms; confirm script-family detection routes Latin/CJK/mixed correctly; test faceted recall returning tagged memories.

### `MEM-3` LanceDB Importance-Ranked Vector Store  ★★★★★ · L · none

- **Based on (openclaw):** `extensions/memory-lancedb/index.ts` — OpenClaw lancedb extension — Apache Arrow columnar persistent long-term memory with importance weighting and category taxonomy
- **Muse today:** none — packages/stores/src (personal-episodes-store has episodic; no LanceDB import)
- **Proposal:** Create packages/stores/src/lancedb-memory-store.ts wrapping LanceDB with MemoryEntry schema: {id, text, embedding, importance (0-1), category (preference|fact|decision|entity|other), createdAt}. Auto-capture hooks run on turn-end (extract via existing auto-extract, embed, persist). Auto-recall hooks run pre-turn (retrieve by similarity + importance weight, inject into knowledge corpus). Importance user-settable per entry; default 0.5. Respects MUSE_LOCAL_ONLY — embeddings already local via Ollama.
- **Value:** Persistent learned semantic memory across sessions. Importance field prevents critical facts (team names, core decisions) from being diluted by ephemeral observations.
- **Verify:** Test auto-capture extracting + embedding facts, LanceDB persistence across sessions, importance-weighted ranking, category filtering in queries, and auto-recall injection into knowledge corpus.

### `MEM-4` Memory Wiki / Knowledge Vault with Hand-Curated Separation  ★★★★ · M · none

- **Based on (openclaw):** `extensions/memory-wiki/index.ts` — OpenClaw memory-wiki plugin — separate hand-curated reference vault from learned session memory, with wiki_search/wiki_get/wiki_lint/wiki_apply tools
- **Muse today:** none — packages/memory/src (no wiki-specific module; note-recall exists but not vault abstraction)
- **Proposal:** Create packages/memory-wiki/ plugin exporting createWikiPromptSectionBuilder(config) and createWikiCorpusSupplement(). Wiki tools: wiki_search (FTS + embedding hybrid), wiki_get (excerpt + source), wiki_lint (orphan + circular-ref detection), wiki_apply (edit markdown vault). Register via registerMemoryPromptSupplement() and registerMemoryCorpusSupplement() into memory-core's builder. Store state in source-sync + import-runs keyed stores. Vault lives in MUSE_HOME/memory-wiki/*.md (human-editable). Completely separate from learned episodic/task memory.
- **Value:** Operators curate stable reference knowledge (API docs, decision logs, runbooks) separately from agent-learned patterns. Reduces noise in learned memory, surfaces authoritative sources reliably.
- **Verify:** Test wiki_search finding markdown snippets, wiki_get returning correct excerpts with provenance, wiki_lint detecting orphans, wiki_apply persisting edits, and prompt section including wiki context without learned-memory clutter.

### `MEM-5` Deep Dreaming with Light Sleep + REM Phases  ★★★★ · M · partial

- **Based on (openclaw):** `extensions/memory-core/src/dreaming.ts` — OpenClaw dreaming.ts — managed cron jobs with light-sleep (incremental narrative) + REM (deep consolidation) phases; narrative synthesis of promoted short-term recalls
- **Muse today:** partial — packages/memory/src (consolidationPlan exists; no explicit light-sleep vs REM distinction, no dreaming narrative synthesis)
- **Proposal:** Extend packages/memory/src/recall-promotion.ts with dreamingPlan(promotedMemories, phase: 'light'|'rem') that generates narrative summaries. Light-sleep: incremental digest (~5-10 facts) with temporal ordering. REM: deeper pass extracting theme clusters (e.g., "user prefers async work", "database performance is critical"). Persist dream-diary entries in episodic store. Gate via scheduler (e.g., light-sleep every 12h, REM every 7d). Phase signals control which promotions run (REM gates elevation to always-on persona). Narrative generation uses small local model (not local-only enforcement required if deferred to cloud only on explicit opt-in).
- **Value:** Mimics human sleep consolidation. Agent re-processes activity without prompts, extracting behavioral themes and decision patterns. Produces human-readable summaries for review without explicit memory browsing.
- **Verify:** Test light-sleep generating incremental digests, REM producing themed narratives, phase-gating promotions, dream-diary persistence, and scheduler triggering correct phase on interval.

### `MEM-6` Spaced-Practice Short-Term to Long-Term Promotion Pipeline  ★★★★ · M · partial

- **Based on (openclaw):** `extensions/memory-core/src/short-term-promotion.ts` — OpenClaw short-term-promotion.ts — track recall frequency + diversity across days, promote durable (spaced) patterns over massed (single-session) bursts
- **Muse today:** partial — packages/memory/src/recall-promotion.ts (has scoreRecallHit + selectPromotableMemories; missing queryHashes, recallDays, concept-diversity weighting)
- **Proposal:** Extend RecallHitLike to include queryHashes: Set<string> and recallDays: Set<string> (ISO date strings). Track per-memory: how many distinct queries retrieved it, on how many distinct calendar days. Modify selectPromotableMemories(records) to weight by diversity: distinct-days count must exceed threshold (default 2) BEFORE a memory can promote into always-on persona. Prevents massed single-session bursts from polluting personality. Decay half-life remains 21 days. Integrate with dreaming narrative (themed facts come from diverse access patterns, not noise).
- **Value:** Separates durable learned patterns (proven useful across multiple days/contexts) from transient single-session observations. Persona stays focused on what the agent actually relies on repeatedly.
- **Verify:** Test spaced-practice gate: memory accessed 10x in one day stays ineligible; accessed 3x across 3 different days promotes. Verify decay and distinct-day thresholds work together. Confirm promoted facts feed into dream narratives.

### `MEM-7` Pluggable Embedding Provider Interface with Multi-Model Support  ★★★★ · M · partial

- **Based on (openclaw):** `extensions/memory-core/src/memory/embeddings.ts` — OpenClaw embeddings.ts — multi-provider adapter supporting OpenAI, local GGUF (llama.cpp), generic EmbeddingProvider API; hybrid merge with temporal decay
- **Muse today:** partial — packages/autoconfigure/src/embedder-base.ts (createOllamaEmbedder exists; no multi-provider abstraction, no hybrid merge with decay)
- **Proposal:** Create packages/model/src/embedding-provider.ts with EmbeddingProvider ABC (embedQuery(text), embedBatch(texts)). Implement OllamaEmbeddingProvider, GenericHttpEmbeddingProvider (for custom backends). Extend knowledge-ranking.ts rankKnowledgeChunks() to accept embedProvider instead of hardcoded embed function. Hybrid merge: combine vectorScore (cosine) with temporal-decay boost + frequency-decay. Query normalization + chunk-split BEFORE embedding (deterministic preprocessing). Fail-close: if embedProvider throws, fall back to BM25-only ranking.
- **Value:** Decouples embedding model choice from ranking. Supports Honcho/Mem0 backends that provide embeddings natively. Temporal+frequency weighting improves relevance of recent, frequently-accessed knowledge.
- **Verify:** Test embedQuery/embedBatch round-tripping through Ollama provider, fallback to BM25 on embedding error, hybrid ranking combining vector+temporal scores, and query normalization producing deterministic outputs.

### `MEM-8` Session-Level Insights and Usage Analytics Engine  ★★★ · M · none

- **Based on (hermes):** `agent/insights.py` — Hermes InsightsEngine — aggregate session/token/tool/skill/cost data; expose trends and self-awareness without external analytics
- **Muse today:** none — packages/cache/src (token counting exists); no session-level aggregation engine
- **Proposal:** Create packages/autoconfigure/src/insights-engine.ts exporting InsightsEngine.generate(days=30). Query session DB (via RunStoreProvider pattern already in place) for sessions, token counts, tool_usage, skill_usage within window. Compute: overview (total tokens, cost USD, model breakdown), platform breakdown, tool breakdown (top N tools), skill usage (skill_view vs manage_count), activity patterns (sessions/day, distribution). Return structured dict: {overview, models, platforms, tools, skills, activity}. Cost estimation via existing cache.estimateCostUsd(). Supports per-source filtering (model/platform/tool).
- **Value:** Agent self-awareness of its own usage patterns. Token spend, tool preference, skill evolution grounded in real data. Bridges in-house and cloud billing visibility.
- **Verify:** Test generating insights over 7/30/90-day windows, verifying token counts match cache records, cost USD matches model pricing, tool rankings are accurate, skill usage distinguishes view vs manage operations.

### `MEM-9` Memory Flushing Delta + Prompt Section Builder  ★★★ · L · none

- **Based on (openclaw):** `extensions/memory-core/src/flush-plan.ts` — OpenClaw flush-plan.ts + buildPromptSection() — identify delta edits in MEMORY.md during compression, decide which memory tier to inject based on session state
- **Muse today:** none — packages/memory/src/memory-token-trim.ts (context compression exists; no flush-plan or prompt-section-builder modules)
- **Proposal:** Create packages/memory/src/memory-flush-plan.ts exporting buildMemoryFlushPlan() that identifies MEMORY.md delta edits preserving key insights during compression (via git-like diff or hash comparison). Companion buildPromptSection() decides what memory tier to inject: full dump vs compact vs omit, based on session state (task-active, long-session, recent-edits). Coordinate via dreaming-state.ts keyed store tracking what's already in context. Prevents memory from bloating system prompt in sessions >20k tokens. Flush plan runs during CompactionTrimmer invocation.
- **Value:** Optimizes long-session context packing. Memory stays fresh without inflating prompt. Distinguishes what changed from what's stable.
- **Verify:** Test delta detection identifies new facts vs stable ones, buildPromptSection() returns compact vs full based on budget, and dreaming-state prevents double-injection of already-in-context facts.

### `MEM-10` Skill Curation Automaton with Stale Marking and Prefix Clustering  ★★ · L · partial

- **Based on (hermes):** `agent/curator.py` — Hermes Curator — auxiliary-model agent spawned on inactivity trigger, marks stale (30d), archives (90d), clusters by prefix, merges into umbrellas
- **Muse today:** partial — packages/agent-core/src/skill-merge.ts, packages/skills/src (skill-merge-gate exists; no curator orchestrator, no should_run_now gate, no prefix clustering)
- **Proposal:** Create packages/skills/src/skill-curator.ts exporting SkillCurator with should_run_now(lastRunMs) staleness gate (30d stale, 90d archive threshold), apply_automatic_transitions() walking authored-skill-store marking old skills. On consolidate=true, spawn forked-agent with CURATOR_REVIEW_PROMPT identifying PREFIX CLUSTERS (hermes-*, pr-*, test-*, etc.). Merge overlapping narrow skills into SKILL.md + support files. Pinned skills exempt from auto-archive. Never touches user-created umbrella classes. Respects Muse's constraint: curator is deterministic state machine + optional LLM review, not LLM-driven throughout.
- **Value:** Prevents skill library from growing unbounded with one-session micro-skills. Maintains discoverability via semantic umbrellas. Auto-archive cleans unused knowledge without operator intervention.
- **Verify:** Test should_run_now() triggers on 30-day stale threshold, apply_automatic_transitions() marks skills correctly, prefix clustering identifies hermes-*, pr-*, test-* groups, and merging preserves SKILL.md structure.

### `MEM-11` Active Memory with Secondary Agent Delegation + Circuit Breaker  ★★ · M · none

- **Based on (openclaw):** `extensions/active-memory/index.ts` — OpenClaw active-memory.ts — spawn secondary agent for recall with bounded timeouts, circuit breaker on repeated timeouts, result caching with TTL
- **Muse today:** none — packages/agent-core/src (multi-agent orchestration exists; no active-memory module with secondary delegation + circuit breaker + caching)
- **Proposal:** Create packages/agent-core/src/active-memory.ts exporting createActiveMemoryRecaller(config). Spawns secondary agent to execute memory_search/memory_get scoped to target agent. Bounded timeouts: 15s default, max 120s. Circuit breaker: max 3 consecutive timeouts → 60s cooldown before retry. LRU cache (15s TTL, max 1000 entries) storing results by query hash. Injects summary + recent transcript snippet into primary agent context. Failure modes degrade gracefully: partial data returned rather than blocking. Respects MUSE_LOCAL_ONLY: secondary agent uses same local model as primary.
- **Value:** Multi-agent memory coordination without stalling primary loop. Allows delegation while maintaining rich context. Prevents cascading latency from slow recall.
- **Verify:** Test secondary agent spawning with memory_search tool, circuit breaker opening after 3 timeouts, cache hit reducing latency, graceful degradation on timeout (returns partial), and TTL expiration evicting old entries.

## 4. Skills · Authoring · Bundles · Commands · Curation

_13 opportunities · 18 competitor files read_


### `SKL-1` Skill Config Variable Extraction and Frontmatter Resolution  ★★★★ · M · none

- **Based on (hermes):** `agent/skill_utils.py` — Skills declare config keys in frontmatter; values injected from config.yaml with fallback defaults
- **Muse today:** none — packages/skills/src/skill-contract.ts, skill-parser.ts
- **Proposal:** Extend SkillFrontmatter in packages/skills/src/skill-contract.ts to add optional `config?: readonly string[]` field. In skill-parser.ts, parse `config:` block as an array of strings. In packages/autoconfigure/src/personal-providers.ts, resolve config values from muse config and inject as a `configValues` object into the SkillCatalogEntry so agents see what values are available before skill execution.
- **Value:** Skills can declare runtime dependencies (API keys, paths, toggles) without hardcoding, enabling authors to write once and users to configure per-environment
- **Verify:** Write test in packages/skills/test/skill-parser.test.ts parsing `config: ["api_key", "output_dir"]` and verify muse.skills.read returns configValues block with resolved values or placeholders

### `SKL-2` Skill Workshop Proposal and Approval Quarantine Workflow  ★★★★ · L · partial

- **Based on (openclaw):** `src/skills/workshop/service.ts` — proposeCreateSkill drafts proposal in memory; SkillProposalRecord stores metadata/origin/approval; applySkillProposal persists approved proposals
- **Muse today:** partial — packages/skills/src/authored-skill-store.ts scanSkillBodyForRisks()
- **Proposal:** Extend authored-skill-store.ts: add proposeSkill(draft, origin) that always writes to `.pending/` folder with a manifest (metadata, origin, timestamp, risk-scan results). Add approveSkill(name) that moves from `.pending/` to active. In packages/agent-core/src, gate auto-authored skills behind this workflow — agent proposes, human approves, then writeOrPatch() commits. Display approval UI in CLI showing risk reasons and allowing bulk-reject or selective approve.
- **Value:** Prevents surprise auto-authored skills with prompt-injection from silently activating; users review before accepting, maintaining control over their skill library
- **Verify:** Test in packages/skills/test/authored-skill-store.test.ts: proposeSkill(draft) writes to `.pending/`; approveSkill() moves to active; pending skills are not listed by listAuthored()

### `SKL-3` Skill Platform and Environment Runtime Gating  ★★★ · M · none

- **Based on (hermes):** `agent/skill_utils.py` — Skills declare target platforms (darwin/linux/windows/termux) and runtime env (kanban/docker/s6); offer-time filter hides incompatible skills
- **Muse today:** none — packages/skills/src/skill-contract.ts, skill-loader.ts
- **Proposal:** Add `platforms?: readonly string[]` and `environment?: readonly string[]` to SkillFrontmatter (packages/skills/src/skill-contract.ts). In skill-parser.ts, parse both as arrays from frontmatter. In packages/autoconfigure/src/personal-providers.ts buildSkillRegistry(), detect current platform (process.platform) and environment (env vars or config keys), then filter before returning to registry.
- **Value:** Users won't be prompted to use macOS-only skills on Linux, or Docker-specific skills on bare metal, reducing model confusion and failed invocations
- **Verify:** Test in packages/skills/test/skill-loader.test.ts: a skill with `platforms: ["darwin"]` is skipped on linux (and vice versa); explicit skill name load bypasses filter

### `SKL-4` Foreground vs Background Skill Authoring Provenance Tracking  ★★★ · S · partial

- **Based on (hermes):** `tools/skill_provenance.py` — ContextVar tracks write origin (foreground agent vs background_review); curator never auto-archives user-created skills, only agent-synthesized ones
- **Muse today:** partial — packages/skills/src/authored-skill-store.ts
- **Proposal:** Extend the `muse` metadata block in serializeAuthoredSkill() to include an `origin?: "foreground" | "background_review"` field (defaulting to "foreground" for user skills). Pass origin when calling writeOrPatch(). In consolidate() and curate(), check origin before archiving — only archive skills with origin="background_review", preserving all foreground user creations.
- **Value:** Curator can safely auto-consolidate agent-proposed skills without the risk of silently archiving a user's handcrafted skill, maintaining user agency and trust
- **Verify:** Test in packages/skills/test/authored-skill-store.test.ts: a skill with origin="foreground" is never archived by curate() even if idle; background_review origin is eligible

### `SKL-5` Skill Marketplace and Multi-Source Registry with Integrity Hashing  ★★★ · L · none

- **Based on (hermes):** `tools/skills_hub.py` — SkillSource ABC defines registry adapter interface; HubLockFile tracks integrity hashes; sources: GitHub, marketplace taps with search/fetch/quarantine
- **Muse today:** none — packages/autoconfigure/src/personal-providers.ts
- **Proposal:** Create `packages/skills/src/skill-sources.ts` defining a SkillSource interface (fetch, search, verify). Implement LocalGitHubSource (fetches from github.com/owner/repo raw URLs) and RemoteHTTPSource (fetches from taps/registries). In packages/autoconfigure/src/personal-providers.ts, extend buildSkillRegistry() to accept optional external skill sources from config (e.g., MUSE_SKILL_SOURCES="https://skills-hub.example.com"). Download and cache with sha256 verification. Store a `skills.lock.json` locally recording source URLs and hashes for reproducibility.
- **Value:** Users can share and discover skills beyond their local workspace, enabling community skill reuse while maintaining offline-first integrity verification (no cloud-owner required)
- **Verify:** Integration test: fetch a skill from a remote GitHub raw URL, verify sha256, cache locally, muse.skills.list includes it; corrupted remote skill fails verify and is skipped

### `SKL-6` Curator Background Task Idle Trigger and Auto-Transition State Machine  ★★★ · M · partial

- **Based on (hermes):** `agent/curator.py` — Background task spawns on idle after interval; apply_automatic_transitions archives unused; config: enabled/interval_hours/min_idle_hours/stale_after_days/archive_after_days
- **Muse today:** partial — packages/skills/src/authored-skill-store.ts curate() and consolidate()
- **Proposal:** Create `packages/skills/src/skill-curator-daemon.ts` exporting a SkillCuratorDaemon class. Constructor accepts { staleAfterDays, archiveAfterDays, consolidationThreshold, checkIntervalMs }. Exposes async run() that periodically calls curate() and consolidate() on the AuthoredSkillStore. In packages/agent-core or packages/cli, integrate the daemon: at session-end or on idle timer, spawn curator in background. Make all config keys MUSE_SKILL_* env vars so users can tune or disable.
- **Value:** Authored skills automatically transition from active to stale to archived without explicit user action, keeping the library focused and the local model's tool-choice accurate without bloat
- **Verify:** Integration test: AuthoredSkillStore with daemon spawned; a skill unused for staleAfterDays is auto-transitioned to .archive/ when daemon runs; verify via listArchived()

### `SKL-7` Disabled Skills Per-User Configuration and Caching  ★★ · S · none

- **Based on (hermes):** `agent/skill_utils.py` — Users silently disable noisy/broken skills via config.skills.disabled list; caching avoids repeated config parses on cold start
- **Muse today:** none — packages/autoconfigure/src/personal-providers.ts, packages/skills/src/skill-loader.ts
- **Proposal:** Add `MUSE_DISABLED_SKILLS` env var and/or a `disabled?: readonly string[]` key in the Muse config file (alongside skills.external_dirs if added later). In packages/autoconfigure/src/personal-providers.ts buildSkillRegistry(), read the disable list once and pass it to the FileSystemSkillLoader. In loader, filter by name after reading but before returning so disabled skills are loadable via explicit name (not hidden completely).
- **Value:** Users can quickly silence problematic skills without deleting them, reducing session friction when a skill is flaky or irrelevant to the user's domain
- **Verify:** Test in packages/skills/test/skill-loader.test.ts: skill named "broken" in MUSE_DISABLED_SKILLS is omitted from list() but loadable via explicit get("broken")

### `SKL-8` Skill User Instruction Extraction from Authoring Scaffolding  ★★ · M · none

- **Based on (hermes):** `agent/skill_commands.py` — Extract user request from skill scaffolding markers (single-skill, bundle formats); return just instruction for memory providers, keeping memory clean
- **Muse today:** none — packages/skills/src/authored-skill-store.ts, packages/tools/src/muse-tools-skills.ts
- **Proposal:** In packages/skills/src/skill-parser.ts, add optional parsing for a `<!-- user-instruction: ... -->` or `<!-- request: ... -->` marker in the skill body. Export an `extractUserInstructionFromSkill()` function that returns the marker content if present, otherwise undefined. In packages/agent-core/src (memory provider), when recording a skill execution, prefer extractUserInstructionFromSkill() so the memory stores the bare user request, not the expanded skill body.
- **Value:** Session memory stays concise: agents recall "user asked for a git commit message generator" not the full skill markdown, reducing token cost and improving recall precision
- **Verify:** Unit test in packages/skills/test/skill-parser.test.ts: a skill with `<!-- user-instruction: generate git messages -->` extracts that instruction; one without returns undefined

### `SKL-9` Skill Entry Visibility and Access Control (Exposure Flags)  ★★ · M · none

- **Based on (openclaw):** `src/skills/types.ts` — SkillEntry exposes flags: includeInRuntimeRegistry, includeInAvailableSkillsPrompt, userInvocable; agent skillFilter narrows visible skills per role
- **Muse today:** none — packages/skills/src/skill-contract.ts, packages/tools/src/muse-tools-skills.ts
- **Proposal:** Add `exposure?: { includeInPrompt?: boolean; userInvocable?: boolean }` to SkillFrontmatter (packages/skills/src/skill-contract.ts). In packages/autoconfigure/src/personal-providers.ts, toCatalogEntry() respects these flags when building the SkillCatalogEntry. In muse-tools-skills.ts, muse.skills.list filters by includeInPrompt; muse.skills.read and muse.skills.run still allow explicit load (userInvocable check only blocks prompting, not direct calls).
- **Value:** Authors can author internal helper skills or advanced/niche skills that don't clutter the main agent prompt, while keeping them accessible to advanced users or other agents
- **Verify:** Test in packages/tools/test/muse-tools-skills.test.ts: a skill with `exposure.includeInPrompt=false` is omitted from list() but readable via read() and runnable via run()

### `SKL-10` Skill Bundles: Group Related Skills Under Coordinated Commands  ★★ · L · none

- **Based on (hermes):** `agent/skill_bundles.py` — scan_bundles walks bundle dir, parses skills list, slugifies name; build_bundle_invocation_message loads all skills content
- **Muse today:** none — packages/skills/src/skill-contract.ts, packages/skills/src/skill-loader.ts
- **Proposal:** Create a new `packages/skills/src/skill-bundles.ts` module. Define a BundleManifest type (name, description, skills: string[]). Add bundle-loading logic that scans for `BUNDLE.md` files (alongside SKILL.md folders) containing YAML frontmatter + a markdown body. In packages/autoconfigure/src/personal-providers.ts, extend buildSkillRegistry() to parse bundles and wrap their member skills into virtual "bundle:name" entries that muse.skills.read returns as a coordinated group.
- **Value:** Users can ask the agent for a cohesive workflow ("run the full release bundle") and get all related skills presented together, reducing friction vs finding and invoking skills individually
- **Verify:** Test in new packages/skills/test/skill-bundles.test.ts: a BUNDLE.md with skills: ["git-commit", "npm-publish"] loads both and muse.skills.read("bundle:release") returns both members

### `SKL-11` External Skill Directories with Layered Precedence and Configuration  ★★ · M · partial

- **Based on (hermes):** `agent/skill_utils.py` — get_all_skills_dirs returns local ~/.hermes/skills then config.skills.external_dirs expanded; iter walks sorted SKILL.md excluding .git/.venv/.pytest_cache
- **Muse today:** partial — packages/autoconfigure/src/personal-providers.ts buildSkillRegistry()
- **Proposal:** Extend MuseEnvironment in packages/autoconfigure/src/index.ts to support MUSE_SKILL_EXTERNAL_DIRS (comma-separated paths). In personal-providers.ts buildSkillRegistry(), parse that env var and insert external dirs into the roots array with correct precedence (after user but before workspace, so workspace wins). Skip .git, .venv, .pytest_cache folders during walk. Extend SkillSourceInfo to record which external dir a skill came from so users can trace origin.
- **Value:** Teams can maintain shared skill repos without symlinks; users can layer personal, team, and workspace skills with clear override semantics
- **Verify:** Test in packages/autoconfigure/test/skills-registry-precedence.test.ts: a skill in external_dir[0] overrides one in external_dir[1] if same name; user dir overrides both

### `SKL-12` Skill Custom Tool Dispatch and Runtime Routing  ★ · M · none

- **Based on (openclaw):** `src/skills/types.ts` — SkillCommandDispatchSpec declares kind/tool/toolName/argMode; at invocation, tool router directs command to named tool without model interpretation
- **Muse today:** none — packages/skills/src/skill-contract.ts, packages/tools/src/muse-tools-skills.ts
- **Proposal:** Add `dispatch?: { toolName?: string; argMode?: "raw" | "split" }` to SkillFrontmatter. In packages/tools/src/muse-tools-skills.ts createSkillRunTool(), before spawning, check if skill.frontmatter.dispatch exists and toolName is set. If present, route to that tool (via a dispatch map passed into createSkillRunTool options) instead of spawning a subprocess. This enables skills to invoke muse.* tools deterministically without model indirection.
- **Value:** Skills can safely orchestrate muse tools (e.g., a skill invoking muse.notes.read to compose a report) with zero-latency dispatch and no model misinterpretation risk
- **Verify:** Test in packages/tools/test/muse-tools-skills.test.ts: a skill with `dispatch.toolName="muse.notes.read"` routes the command to that tool's execute, not spawn

### `SKL-13` Skill Template Variable Substitution and Inline Shell Preprocessing  ★ · L · none

- **Based on (hermes):** `agent/skill_preprocessing.py` — substitute_template_vars replaces token placeholders; expand_inline_shell executes shell snippets before returning body
- **Muse today:** none — packages/skills/src/skill-parser.ts, packages/tools/src/muse-tools-skills.ts
- **Proposal:** In packages/tools/src/muse-tools-skills.ts createSkillReadTool(), after fetching the skill, preprocess the body: (1) replace `{{configVar}}` tokens with values from resolved config (from frontmatter.config), (2) find and execute `<!-- shell: ... -->` code blocks in isolated spawn, inject their stdout back into the body. Return the expanded body. Limit shell execution to 5s timeout and safe commands (no rm -rf, no credential access).
- **Value:** Skill authors can embed dynamic content (current date, user name, shell command output) in skill markdown without requiring agent interpolation, reducing model token consumption and improving skill portability
- **Verify:** Integration test: a skill with body `"Today is {{date}}"` and config resolve returns "Today is 2026-06-23"; a skill with `<!-- shell: echo hello -->` returns body with "hello" injected

## 5. Tool Execution · Guardrails · File Safety · Net Policy · Secrets

_11 opportunities · 11 competitor files read_


### `TSF-1` Tool-Level Policy Conformance Groups  ★★★★★ · S · partial

- **Based on (openclaw):** `extensions/policy/src/tool-policy-conformance.ts` — POLICY_TOOL_GROUPS maps 30+ tool names to semantic groups (group:fs, group:runtime, group:web, group:memory, group:sessions, etc.) enabling policy rules to target families by single group name.
- **Muse today:** partial — packages/tools/src/index.ts uses domain field (messaging, calendar, tasks, notes, system, core) for tool filtering, but no conformance groups for policy rules or deny/allow scoping
- **Proposal:** Extend packages/policy/src/index.ts with toolConformanceGroups: export const TOOL_CONFORMANCE_GROUPS = { 'group:fs': [file_read, file_grep, file_edit, file_list], 'group:runtime': [run_command, ...], 'group:web': [web_read, web_action, web_download], ... }. Support expandGroup(ruleTarget) to resolve 'group:X' into concrete tool names. Use in exec-approvals + tool-exposure-policy so adding a new file tool auto-includes it in group:fs rules.
- **Value:** Scales policy management. Policy rules written once against group:fs apply to all file tools (now + future) without manual update. Reduces config duplication.
- **Verify:** Write a policy rule denying group:fs. Add file_read + file_grep to approved tools. Verify both denied by expandGroup lookup. Add a new file tool; verify automatically denied by group.

### `TSF-2` Network SSRF Policy & URL Credential Redaction  ★★★★ · M · none

- **Based on (openclaw):** `packages/net-policy/src/redact-sensitive-url.ts` — Pattern-based detection + redaction of sensitive URL query params (token, key, password, auth, etc.) with Unicode separator handling, preserving scheme/host for debuggability.
- **Muse today:** none — packages/policy/src/migration-redaction.ts - only redacts generic patterns (email, url, token), no URL-param-specific credential detection
- **Proposal:** Add url-credential-redactor to packages/policy/src/; expose redactSensitiveUrl(urlString) + redactSensitiveUrlLikeString(malformed) pattern-matching library. Detect case-insensitive query param keys (token, api_key, auth, password, etc.) via URL constructor; mask values inline. Applied by web-read-tool and domain-tools fetch paths before logging/tracing.
- **Value:** Prevents leakage of API keys & OAuth tokens in HTTP logs and transcript surfaces, especially when URLs appear in tool arguments or tool output traces.
- **Verify:** Write test: pass URLs with token=sk-xxx&api_key=secret in query; verify keys masked in output, scheme+host preserved, malformed URLs handled by regex fallback.

### `TSF-3` Execution Approval Configuration & Allowlisting  ★★★★ · M · partial

- **Based on (openclaw):** `extensions/policy/src/policy-state.ts` — Per-agent or global exec approval settings: security level (deny/allowlist/full), ask mode (off/on-miss/always), auto-allow-skills flag. Pattern-based allowlist entries support optional argPattern.
- **Muse today:** partial — apps/cli/src/commands-approvals.ts + packages/messaging track PendingApproval for async gate, but no pattern-based allowlist or security-level (deny/allowlist/full) enum in exec-approvals.json
- **Proposal:** Enhance packages/policy/src/exec-approvals-schema.ts to support: security level (deny | allowlist | full), ask mode (off | on-miss | always), auto-allow-skills boolean, and allowlist[] with {tool, argPattern?} (regex). scanPolicyExecApprovals() merges legacy + modern with dedup. Validation layer ensures pattern is valid regex. Used by beforeTool hook to gate run_command/shell execution.
- **Value:** Fine-grained per-tool approval. deny blocks entirely, allowlist restricts to patterns (e.g., only node in 'tests/' dir), full allows any. Reduces approval-spam while maintaining security.
- **Verify:** Set deny on run_command. Verify hook blocks execution. Set allowlist with argPattern='npm test'. Verify 'npm test' allowed, 'rm -rf' denied. Pattern mismatch; verify blocked.

### `TSF-4` Tool Result Classification for Loop Detection  ★★★★ · S · partial

- **Based on (hermes):** `agent/tool_result_classification.py` — file_mutation_result_landed(tool_name, result) returns True when write_file or patch result proves mutation succeeded. Used by guardrail loop detector to distinguish success from failure accurately.
- **Muse today:** partial — packages/fs/src/fs-write-tools.ts returns success/bytes_written, packages/agent-core/src/tool-failure-streak.ts checks status='completed' but no unified classification layer distinguishing 'result contains success signal' vs 'tool returned error'
- **Proposal:** Add tool-result-classifier.ts to packages/agent-core/src/. Export isToolMutationLanded(toolName: string, result: ToolExecutionResult): boolean checking tool-specific success signals: file_write has bytes_written key, patch has success=true, file_delete has deleted=true, calendar_add/send_message have id keys. Used by model-loop to reset failure streaks when a mutation proves landed. Prevents false-positive no-progress detection when tool succeeds but emits warnings.
- **Value:** Distinguishes tool success from failure accurately. Prevents false-positive circuit-breaker when file operations succeed but emit warnings. Enables accurate cascading-failure vs stall detection.
- **Verify:** Call file_write; verify isToolMutationLanded returns true even if result contains warning text. Call file_grep (read-only); verify returns false. Call with tool_name not in classifier; verify false (safe default).

### `TSF-5` Policy Evidence Attestation & Cryptographic Hashing  ★★★ · M · none

- **Based on (openclaw):** `extensions/policy/src/policy-state.ts` — SHA256 hashing of stable JSON representations of policy document, workspace config, and findings; createPolicyAttestation() bundles policy path, hashes, checkedAt timestamp.
- **Muse today:** none — packages/policy/src/ - has injection/pii patterns but no policy-inventory or attestation/hash support
- **Proposal:** Add policy-attestation.ts to packages/policy/src/. Implement policyDocumentHash(config) + policyWorkspaceHash(mcp/model/fs/secrets) + policyFindingsHash(findings[]) using SHA256 of stable JSON. createPolicyAttestation() returns { policyPath, docHash, workspaceHash, findingsHash, checkedAt, signature }. Exposed from policy/index.ts for audit trails.
- **Value:** Enables tamper-evident proof that a specific config + workspace state + findings were audited at a point in time; foundation for compliance audits and policy change tracking.
- **Verify:** Hash identical config twice; verify same hash. Change one config field; verify different hash. Pass to external audit tool; verify signature holds.

### `TSF-6` Sandbox Posture Auditing with Multi-Backend Support  ★★★ · M · none

- **Based on (openclaw):** `extensions/policy/src/policy-state.ts` — Inventory sandbox backend (docker/ssh), browser CDP source ranges, container mounts, network mode, security profiles (apparmor/seccomp). Scope-aware: defaults + per-agent overrides.
- **Muse today:** none — crates/runner has sandbox integration but no policy/evidence reporting of backend type, mounts, or security profile
- **Proposal:** Add sandbox-posture.ts to packages/policy/src/. Export SandboxPostureEvidence interface {backend: 'docker'|'ssh'|'none', mounts?: {src, dest, readonly}[], networkMode?: string, securityProfile?: {type: 'apparmor'|'seccomp', rules?: string}, cdpSourceRanges?: string[]}. scanPolicySandboxPosture(runtimeConfig) reads runner config and returns evidence. Integrate into policy-inventory so workspace can declare sandbox infrastructure.
- **Value:** Maps actual code-execution isolation. Personal agents and compliance audits understand whether run_command is isolated and what network policies apply.
- **Verify:** Configure muse-runner with docker backend + apparmor profile. Scan sandbox posture; verify backend=docker, securityProfile.type=apparmor. Change to ssh; verify backend changes. No sandbox; verify backend=none.

### `TSF-7` Tool Posture Auditing with Inheritance Tracking  ★★★ · M · partial

- **Based on (openclaw):** `extensions/policy/src/policy-state.ts` — Captures per-tool profile (read-only/audit/full), allow/deny/elevatedAllowFrom lists, fs restrictions (workspaceOnly), exec settings (host/security/ask). Scope-aware: global + per-agent with inheritance. Tracks explicit vs inherited.
- **Muse today:** partial — packages/fs/src/fs-path-safety.ts + tool-filter.ts have read-only/audit concepts but no unified tool-posture evidence registry with inheritance tracking
- **Proposal:** Add tool-posture.ts to packages/policy/src/. Export scanPolicyToolPosture(toolRegistry, runtimeConfig) returning ToolPostureEvidence[] where each has {toolName, profile: 'read-only'|'audit'|'full', allowList?, denyList?, fsRestriction?, execMode?, scope: 'global'|'agent'|'default', inherited: boolean}. Inspect runtime + per-agent overrides. Use in policy-inventory to declare tool-level risk scoping.
- **Value:** Granular tool-level risk scoping. Security teams restrict terminal to sandbox-only execution or deny dangerous tools entirely. Inheritance tracking shows what was inherited from global vs what was agent-specific.
- **Verify:** Set global run_command profile to read-only. Set agent-X override to full. Scan tool posture; verify global inherited=true, agent-X inherited=false, both appear in report. Remove agent override; verify reverts to inherited=true.

### `TSF-8` Preventive SSL/TLS CA Bundle Verification  ★★★ · S · none

- **Based on (hermes):** `agent/ssl_guard.py` — verify_ca_bundle() pre-flight validates HERMES_CA_BUNDLE, SSL_CERT_FILE, REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE env vars before SDK uses them. Checks: exists, is file, >=1KB, can create SSL context, >=1 CA certs loaded. Early errors with actionable hints.
- **Muse today:** none — packages/model/src/ adapters read env vars but no pre-flight CA-bundle validation. No early error on missing/corrupted certs.
- **Proposal:** Add ssl-guard.ts to packages/model/src/. Export verifyCABundle(envVarNames: string[]) pre-flight validator. Checks each var: path exists, is regular file, size >=1KB, can instantiate tls.createSecureContext(), context has >=1 CA cert loaded. Throws with actionable hint (pip install --force-reinstall certifi for Python; npm list node --depth=0 for Node env). Called by model-provider-registry before first provider initialization. Can skip via MUSE_SKIP_SSL_GUARD.
- **Value:** Fails closed before network calls. Broken CA bundles cause opaque errors deep in SDK. Pre-flight catches config typos, missing files, corrupted bundles at startup with clear repair hints.
- **Verify:** Set SSL_CERT_FILE to nonexistent path; verify early error with hint. Set to empty file; verify size error. Set to valid bundle; verify success. Unset all CA vars; verify fallback to system default works.

### `TSF-9` Comprehensive Policy Evidence Inventory  ★★ · L · partial

- **Based on (openclaw):** `extensions/policy/src/policy-state.ts` — collectPolicyEvidence() scans 13+ categories: channels, mcpServers, modelProviders, modelRefs, network, ingress, gatewayExposure, agentWorkspace, toolPosture, sandboxPosture, dataHandling, secrets, authProfiles, execApprovals.
- **Muse today:** partial — packages/mcp/src/manager.ts + packages/agent-core/src/agent-runtime.ts list MCP servers + tools, but no unified policy evidence registry with source URIs, scope (global/agent/defaults), or inherited-vs-explicit tracking
- **Proposal:** Add policy-inventory.ts to packages/policy/src/. Export collectPolicyEvidence(runtimeConfig, workspace) scanning: mcpServers (health + allowlist), modelProviders (adapter type + endpoint), exposed tools (domain + risk), fileRoots + denylists, exec approvals (mode + allowlist patterns), sandbox backend (docker/ssh/etc), network policy (SSRF guard enabled). Return evidence[] with {category, source (oc:// URI), scope, explicit, inherited}. Integrate into AgentRuntimeOptions so runtime snapshot is audit-ready.
- **Value:** Enables security teams and personal agents to understand external integrations, permission boundaries, data handling posture, and secret surface without reading raw config. Feeds compliance audits and risk dashboards.
- **Verify:** Scan a test workspace with 2 MCP servers, 3 models, fs deny-list, exec approvals. Verify evidence includes all 7 categories, each with source URI, scope, inherited-flag. Add new tool; verify it appears in next scan.

### `TSF-10` Tool-Call Loop Guardrails with Configurable Thresholds  ★★ · M · partial

- **Based on (hermes):** `agent/tool_guardrails.py` — ToolCallGuardrailController tracks exact-failure counts (same tool+args), same-tool-failure counts, no-progress on idempotent tools. Warn after exact_failure=2, same_tool_failure=3; hard-stop after exact_failure=5, same_tool_failure=8.
- **Muse today:** partial — packages/agent-core/src/tool-failure-streak.ts + tool-loop-progress.ts handle per-tool-status streaks and no-progress stall detection, but no unified exact-failure or same-tool-failure counters with warn/hard-stop thresholds
- **Proposal:** Enhance packages/agent-core/src/tool-guardrails.ts (new file). Implement ToolCallGuardrailController tracking per-turn: exactFailure (same tool+args), sameToolFailure (tool name only), noProgress (idempotent hash equality). Warn thresholds (exactFailure=2, sameToolFailure=3), hard-stop thresholds (exactFailure=5, sameToolFailure=8); configurable via AgentRuntimeOptions. before_call() checks hard-stop; after_call() updates counts. Returns {action: 'allow'|'warn'|'block'|'halt'}. Integrated into model-loop before tool execution.
- **Value:** Circuit-breaker for cascading tool failures. Warnings nudge smart models; hard-stops prevent infinite loops. Exact-failure detection catches stuck tools early. Distinct from deduplicator (which memos identical calls) and stall detector (which checks result similarity).
- **Verify:** Call tool X with args A, fail twice. Verify warn on 2nd fail. Fail 5 times total; verify hard-stop halts loop. Call different tool Y; verify counters separate. Reset on success; verify streaks clear.

### `TSF-11` Comprehensive Credential Redaction Engine  ★ · M · partial

- **Based on (hermes):** `agent/redact.py` — redact_sensitive_text() applies 13+ regex patterns: vendor prefixes (sk-, ghp_, xox, AIza, etc.), ENV assignments, JSON fields, auth headers, Telegram tokens, private key blocks, DB connection strings, JWT (eyJ...), E.164 phones. Masking preserves 6 prefix + 4 suffix for long tokens.
- **Muse today:** partial — packages/policy/src/migration-redaction.ts + tool-output-sanitizer.ts detect tokens + redact, but no vendor-prefix patterns (sk-, ghp_, xox-, AIza, etc.), no auth-header/JWT/DB-connection-string/phone-number patterns, no masking strategy (prefix+suffix preservation)
- **Proposal:** Enhance packages/policy/src/redaction-engine.ts (new comprehensive version). Export redactSensitiveText(text, {patterns, force, codeFile}): apply 13+ patterns (vendor prefixes sk- / ghp_ / xox / AIza / stripe / telegram, ENV KEY=, JSON key:value, auth headers, JWT eyJ..., DB URIs, phone E.164, private-key blocks). Masking: short tokens fully masked, long tokens preserve 6 chars prefix + 4 suffix. Pre-gate expensive regexes. Integrate into tool-output-sanitizer.ts + model-invocation.ts so logs/transcripts never leak credentials.
- **Value:** Prevents credential leakage into logs, transcripts, and user-visible output across 30+ secret shapes (OpenAI, GitHub, Slack, Google, AWS, Stripe, etc.). Critical for multi-tenant gateways and user-facing logs.
- **Verify:** Pass text with sk-xxx token, ghp_ token, JWT eyJ..., DB postgres://user:pass@..., AWS key=AKIA..., phone +1-555-0123. Verify all masked. Verify 6+4 preservation for long tokens. Verify short tokens fully masked.

## 6. Reliability · Retry · Error Classification · Rate Limit · Budgets

_13 opportunities · 16 competitor files read_


### `REL-1` Jittered exponential backoff with decorrelated seeds  ★★★★★ · S · partial

- **Based on (hermes):** `agent/retry_utils.py` — hermes agent/retry_utils.py jittered_backoff()
- **Muse today:** partial — /Users/jinan/side-project/Muse/packages/resilience/src/index.ts:computeRetryDelay (lines 464-490)
- **Proposal:** Enhance computeRetryDelay in @muse/resilience to support jitter ratio adjustment per attempt using an atomic-counter XOR seed for decorrelation, preventing thundering-herd retries across multi-agent scenarios. Add jitterRatio validation and atomic seed generation.
- **Value:** Prevents cascading failures when multiple Muse agents hit rate-limited providers simultaneously; essential for multi-agent scenarios where retry storms amplify provider load.
- **Verify:** Unit test with 100 concurrent retry attempts verifies seed variance > 50% across instances.

### `REL-2` Comprehensive API error classification taxonomy  ★★★★★ · M · partial

- **Based on (hermes):** `agent/error_classifier.py` — hermes agent/error_classifier.py classify_api_error()
- **Muse today:** partial — /Users/jinan/side-project/Muse/packages/model/src/provider-base.ts:isRetryableHttpStatus (lines 65-69)
- **Proposal:** Build @muse/resilience/error-classifier with priority-ordered pipeline: provider patterns → HTTP status → error code extraction → message patterns → SSL/TLS transient detection. Return ClassifiedError enum (auth, billing, rate_limit, overloaded, context_overflow, image_too_large, model_not_found, content_policy_blocked) with recovery hints. Integrate with ModelProviderError.retryable decision.
- **Value:** Enables smart failover without generic retry loops; distinguishes transient 402 billing resets from permanent exhaustion, context overflow (needs compression) from network blips.
- **Verify:** Test suite with 20+ error patterns from real provider responses (OpenAI 429, Anthropic 529, Gemini overloaded, etc.) verifies correct classification per pattern.

### `REL-3` Per-attempt recovery bookkeeping with one-shot guards  ★★★★ · S · none

- **Based on (hermes):** `agent/turn_retry_state.py` — hermes agent/turn_retry_state.py TurnRetryState
- **Muse today:** none — /Users/jinan/side-project/Muse/packages/agent-core/src/model-loop.ts (no centralized recovery state tracking)
- **Proposal:** Create @muse/agent-core/turn-recovery-state with TurnRecoveryState dataclass tracking boolean guards per recovery branch (format_retry_attempted, image_compression_attempted, etc.). Fresh instance per model loop iteration; each guard fires once. Consolidates scattered inline *_attempted locals threaded through model-loop.ts.
- **Value:** Eliminates scattered recovery attempt flags; provides single testable home for bookkeeping. Ensures each format-recovery branch (thinking stripping, etc.) runs once per attempt without re-running on success.
- **Verify:** Unit test verifies guard fires once, remains false on subsequent attempts; integration test with streaming loop shows no duplicate recovery attempts.

### `REL-4` Rate limit state parsing from response headers  ★★★★ · S · none

- **Based on (hermes):** `agent/rate_limit_tracker.py` — hermes agent/rate_limit_tracker.py parse_rate_limit_headers()
- **Muse today:** none — /Users/jinan/side-project/Muse/packages/mcp-shared/src/http-retry.ts (only parseRetryAfterMs for Retry-After header, no x-ratelimit-* parsing)
- **Proposal:** Build @muse/observability/rate-limit-tracker with parse_rate_limit_headers() extracting x-ratelimit-{limit,remaining}-{requests,tokens} and reset windows into RateLimitState dataclass with RateLimitBucket per window (limit, remaining, reset_seconds). Provide usage_pct and format_rate_limit_display() for dashboard.
- **Value:** Gives agents visibility into quota consumption without guessing. Supports per-minute and hourly windows for requests and tokens. Users see exactly when buckets reset and headroom remaining.
- **Verify:** Unit test parses real Anthropic/OpenAI rate-limit headers; integration test records state after rate-limited response, verifies remaining decrements and reset time advances.

### `REL-5` Turn finalization with cleanup-error isolation  ★★★★ · M · partial

- **Based on (openclaw):** `extensions/diagnostics-otel/src/service.ts` — openclaw extensions/diagnostics-otel/src/service.ts turn_finalizer pattern
- **Muse today:** partial — /Users/jinan/side-project/Muse/packages/agent-core/src/agent-runtime.ts:finalizeInvocation (lines ~400-450) handles cleanup but no independent error isolation per step
- **Proposal:** Refactor finalizeInvocation in @muse/agent-core/agent-runtime.ts to use TurnFinalizer pattern: each cleanup step (trajectory save, cache write, summary persist, hook invocation) runs independently with try/except, collecting errors into cleanup_errors array rather than propagating. Budget exhaustion gets explicit audit trail. Plugin hooks fire (afterComplete, onError) at right seams.
- **Value:** Cleanup failures never lose the response. Trajectory, cache, and resource teardown can fail independently without skipping subsequent steps. Budget exhaustion and iteration overruns get explicit audit trails.
- **Verify:** Unit test fails one cleanup step (e.g., cache write), verifies response still returns and error captured; integration test shows summary persisted despite hook failure.

### `REL-6` Cross-session rate limit guard for shared provider quota  ★★★ · M · none

- **Based on (hermes):** `agent/nous_rate_guard.py` — hermes agent/nous_rate_guard.py record_nous_rate_limit()
- **Muse today:** none — /Users/jinan/side-project/Muse/packages/resilience/src (no cross-session state for multiplexed providers)
- **Proposal:** Build @muse/resilience/provider-quota-guard reading/writing ~/.muse/rate_limits/{providerId}.json after 429 responses. Distinguish account-level quota exhaustion (remaining==0, reset >= 60s) from upstream transience (seconds-scale). Automatic expiry of stale state. Prevent false-positive breaker trips when specific model temp outage vs genuine account depletion.
- **Value:** Multiplexed providers like OpenRouter return 429 from either caller's quota or upstream model blip. Cross-session breaker prevents false-positive blocks killing all requests when specific model temporarily down.
- **Verify:** Unit test simulates genuine quota exhaustion vs upstream transience, verifies only genuine blocks subsequent requests; integration test across two sessions verifies state persistence.

### `REL-7` Iteration budget with thread-safe consume/refund counter  ★★★ · S · partial

- **Based on (hermes):** `agent/iteration_budget.py` — hermes agent/iteration_budget.py IterationBudget
- **Muse today:** partial — /Users/jinan/side-project/Muse/packages/agent-core/src/step-budget.ts (token budget only, not iteration count budget; no refund for execute_code)
- **Proposal:** Extend @muse/agent-core/step-budget.ts with IterationBudgetTracker (separate from token budget): thread-safe consume() returns true if used < max, increments counter, else false. Support refund() for tool-call iterations (execute_code doesn't burn budget). Parent caps at max_iterations; each subagent gets independent budget. Expose used/remaining properties.
- **Value:** Prevents runaway agent loops without blocking. Programmatic tool calls (muse.tools.execute) refund iteration to avoid burning budget on non-LLM steps. Subagents get independent budgets while parent never exceeds max.
- **Verify:** Unit test verifies consume increment, refund decrement, max enforcement; test shows execute_code refunds while model calls do not.

### `REL-8` Configurable LLM request timeout and retry limits per provider  ★★★ · M · none

- **Based on (openclaw):** `packages/llm-core/src/types.ts` — openclaw packages/llm-core/src/types.ts StreamOptions
- **Muse today:** none — /Users/jinan/side-project/Muse/packages/model/src (no timeoutMs or maxRetryDelayMs fields on request; resilience/index.ts has defaults but no per-request override)
- **Proposal:** Add StreamOptions-style fields to ModelRequest: timeoutMs (HTTP timeout per attempt), maxRetries (max SDK attempts, default 2), maxRetryDelayMs (cap on server-requested delays, default 60s). Map these through provider adapters (OpenAI timeout, Anthropic max_retries, Ollama timeout). Validate maxRetryDelayMs prevents runaway waits.
- **Value:** Unified timeout/retry configuration across heterogeneous providers. Prevents SDK defaults from blocking agent turns indefinitely. Caps server-requested delays to keep user-facing response times predictable.
- **Verify:** Unit test with mocked provider enforces timeout per request, verifies maxRetryDelayMs cap applied; integration test shows request with custom timeouts succeeds where defaults would fail.

### `REL-9` Account usage windows with reset times and freshness tracking  ★★ · M · none

- **Based on (hermes):** `agent/account_usage.py` — hermes agent/account_usage.py AccountUsageSnapshot
- **Muse today:** none — /Users/jinan/side-project/Muse/packages/observability/src (MonthlyBudgetTracker exists but no multi-window per-provider usage snapshots)
- **Proposal:** Build @muse/observability/account-usage with AccountUsageSnapshot dataclass (provider, source, fetched_at, title, plan, windows with label/used_percent/reset_at/detail). Support provider-specific builders (build_anthropic_usage_snapshot, etc.). render_account_usage_lines() formats for dashboard. Freshness tracking via fetched_at timestamp.
- **Value:** Unified view of usage across provider-specific quota systems. Freshness tracking shows age of data. Reset-time visibility tells when buckets replenish. Graceful degradation when data unavailable.
- **Verify:** Unit test builds snapshot from Anthropic API response, verifies window structure, timestamps, and percentages render correctly in terminal format.

### `REL-10` Safe error introspection without triggering getters  ★★ · S · none

- **Based on (openclaw):** `src/infra/diagnostic-error-metadata.ts` — openclaw src/infra/diagnostic-error-metadata.ts diagnosticErrorCategory()
- **Muse today:** none — /Users/jinan/side-project/Muse/packages (no safe error introspection pattern; instanceof checks used in resilience/index.ts)
- **Proposal:** Build @muse/observability/safe-error-introspection with diagnosticErrorCategory() using instanceof checks not .name property, diagnosticErrorCode() via getOwnPropertyDescriptor (no getter invocation), findDiagnosticErrorProperty() walking error chains with cycle detection. Classify transport errors (ECONNRESET, ETIMEDOUT, etc.) deterministically.
- **Value:** Safe error inspection without triggering userland getters that might hide errors or corrupt state. Minimal trust in mutable Error properties. Transport-class classification enables proper telemetry routing.
- **Verify:** Unit test with custom Error subclass having getter-based .name property verifies inspector bypasses it; test error chains with cycles verifies cycle detection.

### `REL-11` Stream-based request/response contract with error encoding  ★★ · S · partial

- **Based on (openclaw):** `packages/llm-runtime/src/stream.ts` — openclaw packages/llm-runtime/src/stream.ts stream() complete()
- **Muse today:** partial — /Users/jinan/side-project/Muse/packages/model/src/index.ts (ModelResponse interface has no error encoding; ModelEvent has type:error but no stopReason propagation)
- **Proposal:** Extend ModelResponse in @muse/model/index.ts to add optional stopReason field (error, aborted, max_tokens, etc.) and errorMessage. Ensure errors are encoded in response stream not thrown, allowing callers to handle success/error/abort uniformly without breaking promise chains.
- **Value:** Failure propagation through streams avoids breaking caller's promise chains. Errors land in final response rather than bubbling as exceptions. Caller code handles all outcomes uniformly.
- **Verify:** Unit test streams error response with stopReason and errorMessage, verifies caller receives complete stream without exception; integration test shows error handling without try/catch.

### `REL-12` Prometheus metric collection with series cardinality limit  ★ · M · none

- **Based on (openclaw):** `extensions/diagnostics-prometheus/src/service.ts` — openclaw extensions/diagnostics-prometheus/src/service.ts createPrometheusMetricStore()
- **Muse today:** none — /Users/jinan/side-project/Muse/packages/observability (no Prometheus metrics implementation; AgentMetrics interface exists but no Prometheus exporter)
- **Proposal:** Build @muse/observability-prometheus with createPrometheusMetricStore() maintaining counters/gauges/histograms with bucket definitions (DURATION_BUCKETS_SECONDS, TOKEN_BUCKETS). metricKey() de-duplicates series by name+labels. canCreateSeries() enforces MAX_PROMETHEUS_SERIES (2048); exceeds increment dropped counter. Low-cardinality label validation.
- **Value:** Prevents cardinality explosion in production Prometheus. High-dimensional tags capped at 2K series to avoid memory runaway. Dropped series counter alerts ops when hitting limits.
- **Verify:** Unit test creates 2050 series, verifies 2048 succeed and 2 increment dropped counter; integration test exports valid Prometheus format.

### `REL-13` OpenTelemetry diagnostics with content-capture policy  ★ · L · partial

- **Based on (openclaw):** `extensions/diagnostics-otel/src/service.ts` — openclaw extensions/diagnostics-otel/src/service.ts createDiagnosticsOtelService()
- **Muse today:** partial — /Users/jinan/side-project/Muse/packages/observability/src/observability-tracers.ts (OpenTelemetry types defined but no content-capture policy or semantic conventions)
- **Proposal:** Enhance @muse/observability with full OTel integration: createDiagnosticsOtelService() with BatchSpanProcessor, PeriodicExportingMetricReader, BatchLogRecordProcessor. Content-capture policy controls logging of inputMessages, outputMessages, toolInputs, toolOutputs, systemPrompt based on config. Redact sensitive text, truncate JSON to 128KB, enforce max array items (200) and object fields (64).
- **Value:** Production-grade telemetry export without bleeding PII. Semantic conventions enable ML observability tools to ingest traces natively. Content policy lets users control export vs local retention.
- **Verify:** Integration test exports OTel trace with inputMessages redacted per policy, verifies JSON truncation and array/field limits applied; validate with OpenTelemetry collector.

## 7. Background Autonomy · Cron · Proactive Review · Trajectory

_13 opportunities · 19 competitor files read_


### `AUT-1` Job delivery modes (announce/webhook/silent) with stale-response suppression  ★★★★ · M · partial

- **Based on (openclaw):** `src/cron/delivery.ts` — Cron delivery with stale-acknowledgement suppression and subagent preferences (openclaw/src/cron/delivery.ts)
- **Muse today:** partial — packages/scheduler/src/scheduler-runtime.ts has webhook + notificationChannelId but lacks announce fallback, silent-token suppression, or subagent-aware suppression of interim text
- **Proposal:** Extend packages/scheduler/src/scheduler-runtime.ts SchedulerMessaging to support three delivery modes: announce (fallback-deliver final text when agent didn't send), webhook (POST payload), and silent (no output). Add structured execution-denial metadata parsing so failures are detected deterministically, not via prose parsing.
- **Value:** Completes Muse's job-delivery contract so scheduled jobs can route output to multiple channels (chat, webhook, external) and respects user preference for no-output runs — parity with openclaw's delivery semantics.
- **Verify:** Unit test: a silent job produces no output; announce mode falls back when agent doesn't send; webhook POSTs the payload.

### `AUT-2` Cron job idempotency via dedup_key and re-arming  ★★★★ · M · partial

- **Based on (hermes):** `docs/chronos-managed-cron-contract.md` — Managed-cron with external scheduler (hermes/docs/chronos-managed-cron-contract.md: 'dedup_key for transient provision failures, at-most-once via store-level CAS claim')
- **Muse today:** partial — packages/scheduler/src/scheduler-locks.ts has KyselyDistributedSchedulerLock with CAS (ON CONFLICT DO UPDATE WHERE), but no dedup_key concept for re-arming or one-shot job auto-delete
- **Proposal:** Add `dedup_key` to ScheduledJob (optional, for one-shot tracking). In DynamicScheduler trigger, after success, for one-shot recurring jobs marked with next_run_at=null, auto-delete the job record. Add `maxRunCount` (auto-delete after N runs). Re-arming logic: before releasing lock, advance next_run_at under lock (same pattern as CAS claim now does).
- **Value:** One-shot cron jobs auto-cleanup after firing, reducing store clutter. Idempotent re-arming survives transient provision failures without manual retry. Aligns Muse with hermes' serverless-ready cron model.
- **Verify:** Test: create one-shot job, trigger, verify auto-deleted; create 3-run-max job, fire 3x, verify auto-deleted on 3rd.

### `AUT-3` Command-payload execution (shell scripts inside Gateway/scheduler)  ★★★ · M · none

- **Based on (openclaw):** `docs/automation/cron-jobs.md` — Scheduled cron jobs with multiple execution styles (openclaw/docs/automation/cron-jobs.md mechanism: 'Command payload: runs shell inside Gateway (no model)')
- **Muse today:** none — packages/scheduler: only supports agent jobs or MCP tool invocation; no shell command execution
- **Proposal:** Add jobType 'command' to packages/scheduler/src/index.ts ScheduledJob. In packages/scheduler/src/dynamic-scheduler.ts dispatcher, detect command jobs and execute shell payload (via child_process) capturing stdout/stderr. Store result in ScheduledJobExecution without model invocation.
- **Value:** Enables lightweight batch jobs (backups, cleanup, reports) to run on schedule without an LLM, reducing cost and latency for deterministic tasks.
- **Verify:** Integration test: schedule a 'ls' command, trigger it, verify stdout in execution result.

### `AUT-4` Transient-failure detection and skipped-run classification  ★★★ · M · none

- **Based on (openclaw):** `docs/automation/cron-jobs.md` — Isolated cron with preflight provider checks and model fallbacks (openclaw/docs/automation/cron-jobs.md: 'If loopback/private/.local endpoint unreachable, marks run skipped (not error)')
- **Muse today:** none — packages/scheduler/src/dynamic-scheduler.ts treats all job failures uniformly; no preflight checks or skipped-run status
- **Proposal:** In packages/scheduler/src/dynamic-scheduler.ts, before agent execution, probe configured local endpoints (ollama, openai-compat). If unreachable (mark as 'skipped' not 'failed'). Cache endpoint result 5m. In ScheduledJobExecution index.ts, add distinct skipped status + metadata ("provider offline"). Treat skipped runs separately from retries.
- **Value:** Cold-start failures (local LLM server down) surface clearly as transient 'skipped', not permanent errors. Prevents hammering dead endpoints and avoids retry backoff for infrastructure issues.
- **Verify:** Test: mock offline ollama endpoint, trigger job, verify skipped status vs. failed; verify cache prevents re-probing within 5m.

### `AUT-5` Foreground/background job execution styles (main/isolated/custom session)  ★★★ · M · partial

- **Based on (openclaw):** `docs/automation/cron-jobs.md` — Scheduled cron jobs with multiple execution styles (openclaw/docs/automation/cron-jobs.md: main-session enqueues system event, isolated fresh per run, custom session)
- **Muse today:** partial — packages/scheduler/src/dynamic-scheduler.ts only supports agent jobs (no session-style distinction); ScheduledAgentExecutor is a callback, not a configurable style
- **Proposal:** Add `sessionStyle` to ScheduledJob ('main'|'isolated'|'custom') and optional `sessionId` for custom. In DynamicScheduler, detect style: main → enqueue system event to wake existing session; isolated → spawn fresh agent session; custom → enqueue to named sessionId. Default main.
- **Value:** Flexible execution: routine jobs integrate with ongoing conversation (main), or run detached (isolated), or join specific session (custom). Matches openclaw's job flexibility.
- **Verify:** Test: main job enqueues event; isolated job spawns fresh session; custom job routes to named sessionId.

### `AUT-6` Auto-stagger job execution to prevent thundering-herd  ★★ · S · none

- **Based on (openclaw):** `docs/automation/cron-jobs.md` — Scheduled cron jobs with auto-stagger (openclaw/docs/automation/cron-jobs.md: 'Auto-stagger top-of-hour by 5m unless --exact')
- **Muse today:** none — packages/scheduler/src/scheduler-helpers.ts computeNextRunAt has no stagger logic
- **Proposal:** Add optional `staggerEnabled` (default true) to ScheduledJob and `staggerMaxMinutes` (default 5) to DynamicSchedulerOptions. In packages/scheduler/src/scheduler-helpers.ts computeNextRunAt, after resolving cron time, if minute==0 and stagger enabled, add random[0, staggerMaxMinutes] offset. Unless --exact flag passed.
- **Value:** Prevents cache-stampedes and load spikes when many jobs trigger at top-of-hour. Distributes load smoothly without user coordination.
- **Verify:** Unit test: compute next run for top-of-hour cron; verify offset added is within stagger range; verify --exact disables stagger.

### `AUT-7` Cron job suggestions and catalog automation  ★★ · M · none

- **Based on (hermes):** `cron/suggestions.py` — Cron job suggestions and catalog automation (hermes/cron/suggestions.py: ready-to-run specs with source tracking, MAX_PENDING=5 cap, acceptance/dismiss state machine)
- **Muse today:** none — packages/scheduler: no suggestions feature; no proposal/acceptance/dismiss workflow
- **Proposal:** Add packages/scheduler/src/suggestions.ts with Suggestion type (dedup_key, source: 'catalog'|'blueprint'|'usage'|'integration', status: 'pending'|'accepted'|'dismissed', spec: ScheduledJobInput). In DynamicScheduler, expose createSuggestion(source, spec) and acceptSuggestion(dedup_key). Store dismissed dedup_keys so they're never re-offered. Cap pending to 5 (MAX_PENDING).
- **Value:** Surfaces automation opportunities to user (detected from usage patterns via background-review, or curated from catalog) without spamming. One-tap acceptance. Lowers friction to job creation.
- **Verify:** Test: create suggestion, verify in pending list; accept it, verify job created; dismiss another, verify never re-offered.

### `AUT-8` Usage insights and historical analysis engine  ★★ · M · none

- **Based on (hermes):** `agent/insights.py` — Usage insights and historical analysis engine (hermes/agent/insights.py: timeframe queries, token/cost/duration breakdowns, model/tool/skill usage, activity patterns)
- **Muse today:** none — packages/agent-core: has activity/ACT-R/telemetry but no usage-analytics queries (tokens, cost by model/tool, activity histograms)
- **Proposal:** Add packages/agent-core/src/usage-insights.ts InsightsEngine with generate(days=30) method. Query agent_runs table (via MuseDatabase) for timeframe, compute: total tokens (input/output/cache), cost estimation per session, model/tool/skill breakdowns (tool_calls JSON), activity patterns (histograms by day-of-week, hour, streaks). Export formatTerminal() and formatMessaging() for display.
- **Value:** Passive historical awareness of agent patterns (cost/productivity/tool preference) without real-time dashboards. Informs what to optimize next. Parity with hermes insights.
- **Verify:** Test: insert mock agent_runs, call generate(30), verify token sums, model breakdowns, and activity patterns are computed.

### `AUT-9` Active-hours gating with task-based wake triggers  ★★ · M · partial

- **Based on (openclaw):** `src/infra/heartbeat-runner.ts` — Heartbeat periodic polling with active-hours and task-based wake (openclaw/src/infra/heartbeat-runner.ts: isWithinActiveHours, listDueCommitmentsForSession, phases)
- **Muse today:** partial — packages/agent-core/src/active-context.ts surfaces active-hours but doesn't gate scheduling; no heartbeat phase machine or task-based wake
- **Proposal:** In packages/scheduler/src/dynamic-scheduler.ts, before firing scheduled agent job, check isWithinActiveHours(job.timezone). If false, reschedule to next active window. Add optional taskListResolver callback to DynamicSchedulerOptions; if provided, gate execution on listDueCommitmentsForSession returning non-empty (work pending). Respect HEARTBEAT_SKIP_CRON_IN_PROGRESS flag.
- **Value:** Prevents jobs from firing during user's off-hours or when no work is pending, reducing noise. Respects user's rhythm and prevents wasted compute.
- **Verify:** Test: configure active-hours 9-17, schedule job at 8pm, verify skipped; with pending task, verify fires; skip flag prevents concurrent fire.

### `AUT-10` Standing orders for permanent cron-backed operating authority  ★★ · L · none

- **Based on (openclaw):** `docs/automation/standing-orders.md` — Standing orders for permanent operating authority (openclaw/docs/automation/standing-orders.md: scope, triggers, approval gates, escalation rules in workspace files)
- **Muse today:** none — packages/agent-core: no standing-orders concept; cron jobs exist but no pre-authorized scope/escalation rules
- **Proposal:** Add packages/agent-core/src/standing-orders.ts with StandingOrder interface (scope: string[], triggers: ScheduledJobInput[], approvalGates: {action, requiresSign-off}, escalationRules: {when, stop, notify}). Load from agent workspace (AGENTS.md, SOUL.md). Before executing cron job matching standing order trigger, check escalationRules; if triggered, stop and ask user instead of proceeding.
- **Value:** Shifts bottleneck from per-task prompting to pre-defined authority boundaries. Routine work happens on schedule without repeating approval requests. Escalation prevents silent failures.
- **Verify:** Test: define standing order scope, trigger cron job, verify within scope auto-proceeds; verify escalation rule stops and notifies.

### `AUT-11` Session trajectory compression for training/analysis  ★ · M · none

- **Based on (hermes):** `trajectory_compressor.py` — Session trajectory saving with compression (hermes/trajectory_compressor.py: ShareGPT format, token-budget compression, success/failure splits)
- **Muse today:** none — packages/agent-core: no trajectory save or compression; plan-execute tests reference trajectories but don't persist
- **Proposal:** Add packages/agent-core/src/trajectory-saver.ts with save(messages: Message[], metadata: {model, timestamp, completed}) → JSONL append. Add trajectory-compressor.ts: compress(messages, maxTokens) → replaces middle region with human summary, preserves first/last turns. Separate files by success/failure for dataset quality filtering.
- **Value:** Builds training signal from real agent runs. Compression preserves semantic value while fitting under context limits. Enables fine-tuning and dataset audits without storing full transcripts.
- **Verify:** Test: save 100-turn trajectory, compress to 5000 tokens, verify first/last preserved; check JSONL format is valid.

### `AUT-12` Background review for memory/skill auto-learning from cron runs  ★ · S · partial

- **Based on (hermes):** `agent/background_review.py` — Background forked agent for autonomous self-improvement (hermes/agent/background_review.py: spawn daemon thread, tool whitelist, memory/skill updates)
- **Muse today:** partial — packages/agent-core/src/background-review.ts has the engine (trigger evaluation, counter store), but is NOT integrated into cron job completion path; runReview hook is injected but not called by scheduler
- **Proposal:** In packages/scheduler/src/dynamic-scheduler.ts, after agent job completes, check if background-review should fire (import BackgroundReviewInput logic). If enabled, call a registered backgroundReviewCallback(input) fire-and-forget. Collect memory/skill update signals (tool failures, user corrections in cron output) and persist without blocking job delivery.
- **Value:** Scheduled jobs auto-improve agent memory/skills without user coaching. Captures patterns from batch work, reducing manual skill authoring.
- **Verify:** Test: run agent job, verify background review fires fire-and-forget after job completes; memory/skill updates persist.

### `AUT-13` Task ledger with push-driven completion notifications  ★ · M · none

- **Based on (openclaw):** `docs/automation/tasks.md` — Background task ledger for activity tracking (openclaw/docs/automation/tasks.md: queued→running→terminal, linked to task/run/session, 7-day prune)
- **Muse today:** none — packages/scheduler: tracks executions but no unified task ledger; no task-state machine or completion notifications
- **Proposal:** Add packages/scheduler/src/task-ledger.ts with Task (queued|running|ok|error|skipped|timed_out|cancelled) state machine. On job trigger, create task entry linked to job_id + run_id + session_id. On completion, push notification to requester session (wakes waiting user). 7-day auto-prune. Export task_list/task_show/task_cancel CLI commands.
- **Value:** Single ledger for all background work (detached from conversation). Completion notifications prevent polling loops. Task-session linkage traces execution path across workers.
- **Verify:** Test: trigger job, create task; complete job, verify notification pushed; list tasks, verify 7-day cutoff.

## 8. Multi-Agent Orchestration · ACP · Sub-Agents · Gateways

_14 opportunities · 22 competitor files read_


### `ORC-1` Multi-Agent Session Lifecycle & Eviction  ★★★★ · M · partial

- **Based on (openclaw):** `packages/acp-core/src/session.ts` — openclaw's in-memory session store with TTL-based eviction, idle tracking, and runId binding
- **Muse today:** partial — packages/multi-agent/src/subagent-run-registry.ts tracks live sub-agent runs with status/timeout/heartbeat but lacks: (1) idle TTL eviction for long-lived parents, (2) AbortController per-session cancellation, (3) bounded capacity with FIFO eviction policy, (4) session resume/resume-from-parent chain
- **Proposal:** Extend SubAgentRunRegistry in packages/multi-agent/src to add: IdleSessionEvictorPolicy (30min default TTL, evict oldest-idle on capacity overflow), AbortController per-session for cascading cancellation, sessionResumeContext tracking (parent_sessionId + resume marker). Fail-close TTL: evict before timeout fires so no stalled child outlives its parent.
- **Value:** Parents can now clean up idle children automatically without manual GC; runaway multi-turn chains are bounded by capacity, preventing memory leaks in long-running swarms.
- **Verify:** SubAgentRunRegistry test: register 5k sessions, heartbeat 2k, advance time past TTL, verify detectStalled() identifies 3k timed-out and evict drops oldest 2k when capacity hit.

### `ORC-2` Session Event Bridge with Progress Callbacks  ★★★★ · M · partial

- **Based on (hermes):** `acp_adapter/events.py` — hermes' event callbacks bridging AIAgent threaded signals (tool_started, message, thought, tool_completed) to ACP session updates with deduplication
- **Muse today:** partial — packages/multi-agent/src/agent-message-bus.ts provides pub/sub for inter-agent messages but (1) no event-to-plan-entry bridge (events aren't surfaced as parent-visible progress), (2) no deduplication FIFO queue for concurrent tool calls, (3) no thought/reasoning callback channel, (4) onProposal callback in orchestrate.ts is loose, not a formal event bridge
- **Proposal:** Create packages/multi-agent/src/session-event-bridge.ts: (1) EventBridgeSession maps child tool_started→parent task/plan-entry, thought→advisory reasoning-delta, tool_completed→result, (2) FIFO deduplication queue (key=toolCallId) so duplicate-firing doesn't spawn two plan entries, (3) asyncio.run_coroutine_threadsafe-like batching so parent sees clean task tree, (4) integrate into SubAgentRunRegistry so heartbeat() is triggered by event arrivals. Extend agent-message-bus to emit structured events (not just messages).
- **Value:** Parents see real-time child progress without blocking; plan deduplication renders legible task trees for long-running multi-step orchestrations; progress callbacks enable responsive UIs.
- **Verify:** Test: child emits tool_started twice (dedup check), tool_completed once; parent event bridge collects exactly 2 plan entries (started, completed); no orphaned started-without-completed.

### `ORC-3` Permission Gateway with Child Approval Timeout  ★★★★ · M · none

- **Based on (hermes):** `acp_adapter/permissions.py` — hermes' ACP PermissionOption mapping (allow_once/allow_session/allow_always/deny) with timeout-aware future scheduling (5s default) from worker thread
- **Muse today:** none — packages/macos/src/macos-tools.ts has approval gates (approvalGate callback) but only for outbound actions; packages/multi-agent has no child-permission forwarding (a parent blocking on dangerous child operation).
- **Proposal:** Create packages/multi-agent/src/permission-gateway.ts: (1) PermissionRequest wraps child tool-call + risk level + description, routed to parent's approvalGate with unique perm-check-{uuid} id, (2) parent responds allow_once/allow_session/allow_always/deny within 5s (configurable timeout), (3) timeout = deny (fail-close), (4) session-level cache (allow_session applies to all subsequent same-tool in that child session). Integrate into tool-runner so a child's dangerous tool blocks until parent approves.
- **Value:** Multi-agent systems gain parent oversight of dangerous child operations (write tools, API calls); unique request ids prevent concurrent collision/races; timeout-aware scheduling prevents hangs.
- **Verify:** Test: child requests permission for dangerous_tool with 5s timeout, parent doesn't respond within time, permission-gateway blocks child and returns deny, subsequent request in same session uses cache (allow_session).

### `ORC-4` Typed ACP Protocol Gateway & Agent Capability Negotiation  ★★★ · M · partial

- **Based on (openclaw):** `packages/gateway-protocol/src/index.ts` — openclaw's TypeBox-validated ACP schemas for agent lifecycle (initialize, authenticate, create/load/resume sessions), model capabilities, tool unification
- **Muse today:** partial — packages/a2a/src/agent-card.ts publishes a minimal A2A card (skills, extensions, capabilities.streaming/pushNotifications) but: (1) no session lifecycle ops (initialize/load/resume/fork), (2) no model capability query (supportedReasoningEfforts, maxTokens, vision), (3) no tool unification schema (read/edit/execute/fetch/think ToolKind enum), (4) no device-auth handshake
- **Proposal:** Extend packages/a2a/src/agent-card.ts to include SessionLifecycleCapabilities (initialize, load, resume, fork ops with schema) and ModelCapabilityAdvertisement (modelId, reasoning-effort levels, max I/O tokens, vision boolean). Create packages/model/src/capability-schema.ts exporting ModelCapabilityInfo (matching openclaw's ToolKind classification + ModelInfo) so parent agents query child capabilities before spawn. Add device-identity fields (publicKey) to agent-card for future Ed25519 signing per-peer.
- **Value:** Parent agents introspect child capabilities (reasoning effort, token limits, vision) before spawn, routing requests to the right backend and degrading gracefully if a feature is unavailable; protocol-level schema validation prevents silent incompatibilities.
- **Verify:** A2A card roundtrip test: buildMuseAgentCard() includes sessionLifecycleCapabilities and modelCapabilities, a parent agent parses the card and correctly identifies that child can/cannot do reasoning, vision, extended context.

### `ORC-5` Tool Delegation with Concurrent Batching Caps  ★★★ · M · partial

- **Based on (hermes):** `acp_adapter/tools.py` — hermes' delegate_task tool that batches sub-task execution with concurrent-children cap to prevent runaway parallelism
- **Muse today:** partial — packages/multi-agent/src/lead-worker.ts defines Subtask splitting and execution but (1) no explicit batching of sub-tasks (sequential or all-at-once), (2) no concurrent-children capacity limit (could spawn unbounded fan-out), (3) no humanized task-call id (tc-{uuid}), (4) no polished-status marker per sub-task
- **Proposal:** Add packages/multi-agent/src/task-delegation-batcher.ts: (1) BatchedSubtaskExecutor with maxConcurrentChildren config (default 3), queues tasks and materializes results once all complete or timeout fires, (2) assign humanized id tc-{uuid4} per task for audit, (3) track per-task status ('pending'|'running'|'completed'|'failed') + humanized title for observability. Integrate into lead-worker orchestration path so splitSubtasks() delegates through the batcher.
- **Value:** Multi-agent fan-out is capped, preventing GPU/memory overload from unbounded child spawning; observability per task makes runaway parallelism detectable (audit shows which tc-id stalled).
- **Verify:** Unit test: batch 10 subtasks with maxConcurrentChildren=3, measure that at most 3 run in parallel, verify tc-ids are unique+humanized, status transitions correctly from pending→running→completed.

### `ORC-6` Provider Detection & Multi-Backend Auth Inheritance  ★★★ · M · partial

- **Based on (hermes):** `acp_adapter/auth.py` — hermes' detection of active runtime provider (openrouter/anthropic/azure) and auth fallback when agent not yet configured
- **Muse today:** partial — packages/model/src/index.ts has multi-provider adapters (anthropic/gemini/openai/ollama) with factory createModelProvider(providerId) but (1) no provider-auto-detect from env/config (assumes caller knows which to use), (2) no auth inheritance from parent→child (child re-bootstraps from scratch), (3) no callable api_key fallback (assumes static env vars)
- **Proposal:** Add packages/model/src/provider-detection.ts: (1) detectActiveProvider() reads MUSE_MODEL_PROVIDER env or inspects loaded config to find which provider is active, (2) createChildProviderAdapter() reuses parent's provider+auth if child not explicitly configured (inheritance), (3) support Callable<Promise<ApiKey>> for dynamic secrets (fetch from vault/pass on demand). Integrate into SupervisorAgent's worker spawning.
- **Value:** Child agents inherit parent's model provider config automatically, eliminating redundant authentication and bootstrap; dynamic secrets (Callable) let parents provide fresh creds without hardcoding.
- **Verify:** Test: parent with active anthropic provider spawns child worker; child detectActiveProvider() returns anthropic with inherited API key, fallback attempts parent's provider if child not configured.

### `ORC-7` Lazy Runtime Registration with Plugin Service Lifecycle  ★★★ · S · partial

- **Based on (openclaw):** `extensions/acpx/register.runtime.ts` — openclaw's ACPX lazy proxy for heavy service init, deferred until first session, with clean start/stop lifecycle
- **Muse today:** partial — packages/multi-agent/src doesn't expose lazy service init; SupervisorAgent creates workers eagerly. packages/model/src/index.ts has provider factories but no lazy-wrap pattern.
- **Proposal:** Create packages/agent-core/src/lazy-service-registry.ts: (1) LazyServiceProxy<T> wraps an async factory, first .get() call blocks until init (serialize first-call via Promise.race against timeout), (2) start() explicitly initializes; stop() teardown (unregisters from runtime, kills orphaned processes). Provide to SupervisorAgent so workers are lazy-loaded only when first run() comes in. Back runtime-tool-registry init.
- **Value:** Plugin systems with multiple backends avoid cold-start penalties (don't init unused endpoints); clean lifecycle prevents orphaned processes on Muse shutdown.
- **Verify:** Test: LazyServiceProxy with 100ms init delay, first .get() blocks ~100ms, second .get() returns cached, stop() releases resources.

### `ORC-8` Model Capability Introspection & Reasoning Effort Routing  ★★★ · M · partial

- **Based on (openclaw):** `extensions/codex/src/app-server/models.ts` — openclaw's listCodexAppServerModels() with inputModalities + supportedReasoningEfforts, and shared-client lease pattern to prevent connection pool explosion
- **Muse today:** partial — packages/model/src has listModels() per provider but (1) no unified reasoning-effort query (openclaw asks 'does this model support extended_thinking?'), (2) no input/output modality introspection (can it take images? multimodal output?), (3) no shared-client lease pattern for connection pooling, (4) no pagination (fetches full list every time)
- **Proposal:** Extend packages/model/src/index.ts: (1) add reasoningEfforts?: string[] to ModelCapabilities, (2) add inputModalities, outputModalities to ModelInfo, (3) implement ModelCapabilityCache with LRU eviction + TTL (5min), paginated listModels(offset, limit) with caching, (4) SharedClientLease pattern: borrowClient(providerId) → {release()} so concurrent queries share one connection. Parent agents use this to query 'does child-backend support reasoning?' before delegating.
- **Value:** Parent agents discover which models support reasoning/vision/extended-context before spawn, routing requests to capable backends and failing fast when feature unavailable; connection pooling prevents exhaustion in high-concurrency scenarios.
- **Verify:** Test: listModels() with pagination (limit=10, offset=20) returns page 3, ModelCapabilityCache caches results, second call is instant, LRU evicts oldest after capacity hit.

### `ORC-9` Turn Collection & Message Streaming Buffering  ★★★ · M · partial

- **Based on (openclaw):** `extensions/codex/src/conversation-turn-collector.ts` — openclaw's turn-collector that buffers async streaming notifications (item/agentMessage/delta, item/completed, turn/completed) and playback-materializes full turns
- **Muse today:** partial — packages/multi-agent/src/agent-message-bus.ts is a pub/sub broker but (1) doesn't buffer pending notifications until turnId set, (2) no playback materialization (just forwards messages), (3) no timeout with 100ms floor (unbuffered real-time only), (4) doesn't bind async streaming to specific child turns
- **Proposal:** Create packages/multi-agent/src/turn-collector.ts: (1) TurnCollector(threadId, turnId) buffers notifications (toolStarted, delta, toolCompleted, turnCompleted) until turnId is assigned, (2) playback() returns materialized Turn with full sequence, (3) timeout with configurable floor (default 100ms) to unblock long-polls, (4) integrate into session-event-bridge so parent turns can collect child output fragments and materialize before synthesis. Distinct from agent-message-bus (which is stateless pub/sub).
- **Value:** Streaming responses from children are correctly bound to their parent turns even when out-of-order; long-polls don't hang indefinitely; parents see complete turn history for audit.
- **Verify:** Test: threadId='t1', notifications arrive out-of-order (delta before toolStarted), collector buffers both, turnId assigned, playback() returns correct sequence.

### `ORC-10` Multi-Endpoint Supervisor & Health Checking  ★★ · L · none

- **Based on (openclaw):** `extensions/codex-supervisor/src/supervisor.ts` — openclaw's CodexSupervisor routing across stdio-proxy/websocket endpoints with auto-discovery, thread listing, and endpoint health reprobing
- **Muse today:** none — packages/multi-agent/src/orchestrator.ts routes to AgentWorkers by id+canHandle score but assumes single local runtime; no multi-backend coordination, no health checking, no pagination
- **Proposal:** Create packages/multi-agent/src/supervisor-endpoint-registry.ts: (1) Endpoint discovery via agent-card polling (A2A /.well-known/agent-card.json), (2) Health status cache with exponential backoff retry (1s→30s), (3) listWorkers() with pagination (offset+limit), (4) readWorkerStatus(workerId) fetches live run state. Gate to local-only: only probe file:// (loopback) endpoints or MUSE_MULTI_ENDPOINT_URLS allowlist.
- **Value:** Muse can now discover and load-balance work across multiple local inference backends (Ollama, LM Studio, multiple GPU machines) without manual config, mirroring hermes→openclaw federation.
- **Verify:** Integration test: start 3 loopback test endpoints (mock agent-cards), SupervisorEndpointRegistry discovers all, health check marks one down, listWorkers() pages correctly, selectWorker() avoids downed endpoint.

### `ORC-11` Session Persistence & Compression Lineage Tracking  ★★ · M · none

- **Based on (hermes):** `acp_adapter/provenance.py` — hermes' session DB persistence (parent_session_id, compression_depth, creator_kind) to reconstruct multi-agent ancestry without parsing status text
- **Muse today:** none — packages/multi-agent/src/subagent-run-registry.ts tracks parentRunId but (1) no DB persistence (in-memory only, lost on restart), (2) no compression_depth computation, (3) no root_session_id chain walk, (4) no sessionProvenance metadata export
- **Proposal:** Create packages/multi-agent/src/session-persistence-db.ts: (1) SQLite store (mirroring hermes SessionDB) with columns: runId, parentRunId, sessionStart, sessionEnd, compressionDepth, creatorKind, endReason, (2) walk parent chain on register to compute compressionDepth (0 for root, +1 per level), (3) exportSessionProvenance(runId) returns {currentMuseSessionId, rootMuseSessionId, compressionDepth, creatorKind} for audit, (4) prune old sessions on startup (age > 30 days). Integrate into orchestrator on worker.run().
- **Value:** Long-running multi-agent workflows have durable audit trails; parents reconstruct children lineage and detect compression depth (a deeply-nested handoff), enabling observability and failure forensics across restarts.
- **Verify:** Test: create 3-level hierarchy (parent→worker1→worker2), persist to DB, restart Muse, query rootSessionId from worker2's record shows parent, compressionDepth=2.

### `ORC-12` Session Workdir Translation & Platform Bridging  ★★ · S · partial

- **Based on (hermes):** `acp_adapter/session.py` — hermes' Windows→WSL path translation (C:\Users → /mnt/<drive>) and per-task cwd override registration
- **Muse today:** partial — packages/multi-agent has AgentRunInput.cwd but (1) no cross-platform path translation (Windows users can't run WSL workers), (2) no per-task override registry, (3) no path-normalization for symlinks/relative paths, (4) subprocess env inheritance not explicitly controlled
- **Proposal:** Create packages/multi-agent/src/workdir-translator.ts: (1) PlatformWorkdirBridge detects runtime OS, (2) Windows→WSL translator: 'C:\\Users\\alice\\Documents' → '/mnt/c/Users/alice/Documents', (3) per-task-id override registry so orchestrator can register 'worker-1' ↦ '/custom/path' for one-off redirects, (4) normalize paths (resolve symlinks, abs-path enforcement). Use in orchestrator.run() to override currentInput.cwd per worker.
- **Value:** Cross-platform multi-agent teams (Windows editor spawning WSL Hermes) work transparently; per-task overrides let orchestrators redirect child workdirs without rebuilding workers.
- **Verify:** Test on Windows+WSL: PlatformWorkdirBridge.translate('C:\\data') returns '/mnt/c/data', per-task override registered, worker gets correct cwd in env.

### `ORC-13` Process Supervisor with Multi-Scope Lifecycle & Grouped Cancellation  ★★ · L · partial

- **Based on (openclaw):** `src/process/supervisor/supervisor.ts` — openclaw's createProcessSupervisor with scopeKey grouping, enforced timeouts (overall + no-output), and cancelScope() mass-termination
- **Muse today:** partial — packages/multi-agent/src/subagent-run-registry.ts tracks timeout + detects stalled but (1) no AbortController per-scope for cascading cancellation, (2) no no-output-timeout (only total timeout), (3) no mass cancelScope() operation, (4) no PTY process supervisor (assumes in-process agents only)
- **Proposal:** Extend packages/multi-agent/src/subagent-run-registry.ts or create packages/multi-agent/src/process-supervisor.ts: (1) ProcessScope groups runs by scopeKey (e.g., 'orchestration-run-123'), (2) registerProcessRun(scopeKey, processHandle) with overallTimeout + noOutputTimeout (no heartbeat in N seconds), (3) cancelScope(scopeKey) sends SIGTERM to all processes in that scope, (4) integrate with SubAgentRunRegistry so children in a failed parent scope auto-cancel. Support Node child_process.spawn() + AbortSignal propagation.
- **Value:** Multi-agent fan-out with cascading cancellation: parent fails → all child processes are mass-terminated, no orphaned subprocesses; no-output timeout catches hung workers that miss heartbeats.
- **Verify:** Test: create scope with 5 child processes, trigger cancelScope(), all receive SIGTERM within 2s; no-output-timeout fires after 10s silence, marking process stalled.

### `ORC-14` ACP Session Manager & History Persistence for Resume  ★★ · M · none

- **Based on (hermes):** `acp_adapter/session.py` — hermes' SessionManager mapping ACP sessions to agents, persisting to SessionDB for resume-across-restarts with history filtering by cwd+source
- **Muse today:** none — packages/multi-agent has no session-manager abstraction; orchestrator creates new AgentRunInput each time, no resume mechanism.
- **Proposal:** Create packages/multi-agent/src/session-manager.ts: (1) SessionManager(db, agentFactory) maps sessionId → AgentWorkerSession, (2) newSession(workerId, cwd, model, history) creates + persists, (3) loadSession(sessionId) resumes from DB with history intact, (4) filterSessions(cwd, source) for session discovery (matching hermes pattern), (5) SessionDB schema: sessionId, workerId, cwd, model, historyId, sessionState ('active'|'suspended'|'closed'), (6) integrate into SupervisorAgent.run() as resume-first: check DB before spawning fresh worker.
- **Value:** Agents killed mid-turn resume cleanly without losing history; parents reconnect and continue without re-execution of prior steps; session persistence survives Muse restarts.
- **Verify:** Test: create session, kill mid-run, restart Muse, loadSession(sessionId) returns same history + session state, resume from last checkpoint.

## 9. Channels & Integrations · Messaging · Webhooks · Inbound Routing

_11 opportunities · 17 competitor files read_


### `CHN-1` Webhook HMAC validation with constant-time comparison and rate limiting  ★★★★★ · M · none

- **Based on (openclaw):** `/Users/jinan/ai/openclaw/extensions/webhooks/src/http.ts` — openclaw implements safeEqualSecret() for constant-time HMAC, fixed-window rate limiting per-route with deque tracking, and secret resolution from env|file|exec
- **Muse today:** none — /Users/jinan/side-project/Muse/packages/messaging/src: no webhook handling in messaging package; LINE webhook is written to inbox file by external apps/api routes, no HMAC validation layer
- **Proposal:** Add @muse/messaging/src/webhook-receiver.ts: export validateWebhookSignature(secret, body, signature, algorithm='sha256') using constant-time comparison (crypto.timingSafeEqual), and createWebhookRateLimiter(maxPerMinute) with fixed-window deque tracking per route. Wrap in fail-close semantics: reject on timing-attack risk or rate-limit breach. Apps/api/src/messaging-webhooks-routes.ts imports these guards before appending inbound.
- **Value:** Prevents timing attacks on webhook secrets and DoS via webhook flood; critical for production-grade Slack/Discord webhook integration.
- **Verify:** Unit tests: constant-time comparison, rate limit deque behavior, rejection on tampering. Integration: call webhook route twice with same signature, verify first succeeds and second hits rate limit.

### `CHN-2` Multi-account Slack/Discord with per-account config & token resolution  ★★★★ · M · none

- **Based on (openclaw):** `/Users/jinan/ai/openclaw/extensions/slack/src/accounts.ts` — openclaw resolveSlackAccount() reads enabled/disabled state + per-account overrides from channels.slack, resolves tokens from env (SLACK_BOT_TOKEN) or config (channels.slack.accounts.{id}.botToken), tracks tokenSource
- **Muse today:** none — /Users/jinan/side-project/Muse/packages/messaging/src/slack-provider.ts: single token only, no multi-account support; credential store is per-providerId, not per-account
- **Proposal:** Add multi-account abstraction to @muse/messaging: extend SlackProvider/DiscordProvider to accept an accountId param in SlackProviderOptions, resolve token from FileMessagingCredentialStore with key pattern `slack:account123`, and track tokenSource ('env'|'config'|'none'). Store merged config (base + per-account overrides) in new PerAccountSlackConfig shape. Registry.send() accepts optional accountId to select the instance.
- **Value:** Enables agents to operate across multiple Slack workspaces/Discord guilds simultaneously without token collision, essential for enterprise multi-org setups.
- **Verify:** Test SlackProvider with multiple accounts, verify each resolves distinct tokens, and that registry.send(providerId, message, accountId) routes to the correct account.

### `CHN-3` Thread-aware auto-reply routing per account with reply mode tracking  ★★★★ · M · partial

- **Based on (openclaw):** `/Users/jinan/ai/openclaw/extensions/slack/src/action-runtime.ts` — openclaw SlackActionContext carries replyToMode ('off'/'first'/'all'/'batched'), resolveSlackReplyingThreadTs() injects threadTs, hasRepliedRef tracks whether a reply has been sent
- **Muse today:** partial — /Users/jinan/side-project/Muse/packages/agent-core/src/inbox-context.ts: InboxSnapshot has source (channel id), but no thread tracking; /Users/jinan/side-project/Muse/packages/messaging/src/inbound-responder.ts: respondToInbound() always replies to source, no per-account replyToMode config
- **Proposal:** Extend InboundMessage in @muse/messaging to include optional threadTs (Slack), channelThreadId (Discord), threadId (generic). Add ReplyModeConfig per account ('off'/'first'/'all'). In inbound-responder.ts, resolveReplyDestination(message, replyMode, threadTracker) returns {destination, threadId} or null if mode='off' or already replied in 'first' mode. Persist threadReplies in inbound-reply-cursor.ts alongside message ids.
- **Value:** Prevents message leakage across threads, respects per-account reply behavior, and enables 'first reply only' mode for noisy channels.
- **Verify:** Test replyToMode='first': send two messages in same thread, verify only first triggers agent reply; test mode='off': verify no replies sent; test mode='all': verify both get replies.

### `CHN-4` Deterministic send-error classification with retryability signals  ★★★★ · M · none

- **Based on (hermes):** `/Users/jinan/ai/hermes-agent/gateway/platforms/base.py` — hermes SendResult carries error_kind (rate_limited|unauthorized|not_found|invalid_message|transient_network), retryable flag drives stream_consumer branching logic
- **Muse today:** none — /Users/jinan/side-project/Muse/packages/messaging/src/types.ts: OutboundReceipt is minimal {providerId, destination, messageId, raw?}, no error classification; inbound-responder.ts just logs errors, no branching on retryability
- **Proposal:** Extend OutboundReceipt in @muse/messaging to add error_kind?: 'rate_limited'|'unauthorized'|'not_found'|'invalid_message'|'transient_network'|'unknown' and retryable: boolean. Update each provider's send() to classify errors (e.g. Telegram 429 → rate_limited, 403 → unauthorized). In inbound-responder.ts, after send failure, branch: rate_limited/transient_network → don't mark handled (retry next pass), authorization/not_found → mark handled + log (permanent failure).
- **Value:** Intelligent retry logic: transient failures are retried, permanent ones are abandoned; prevents duplicate replies and silent message loss.
- **Verify:** Simulate rate-limit error from Slack, verify message is NOT marked handled and error is logged. Simulate 404, verify message IS marked handled. Verify retry on next polling cycle.

### `CHN-5` Unified DM policy resolution with multi-layer allow-from filtering  ★★★ · M · none

- **Based on (openclaw):** `/Users/jinan/ai/openclaw/extensions/slack/src/accounts.ts` — openclaw resolveSlackAccountDmPolicy() returns 'pairing'|'ignore'|custom, resolveSlackAccountAllowFrom() applies account→channel→user inclusion filtering with mapAllowFromEntries()
- **Muse today:** none — /Users/jinan/side-project/Muse/packages/messaging/src/channel-approval-gate.ts: only validates tool risk (read/write/execute), not inbound channel/user allowlist; no dm policy concept
- **Proposal:** Add DmPolicy config to MuseEnvironment + parsing in @muse/autoconfigure: MUSE_SLACK_DM_POLICY ('pairing'|'ignore'), MUSE_SLACK_ALLOW_FROM (CSV user/channel ids). Extend createChannelApprovalGate() to check allowFrom list before creating approval gate; deny inbound from non-allowed users with reason. Store config in FileMessagingCredentialStore as provider metadata.
- **Value:** Fine-grained inbound access control: agents can reject unwanted DMs and limit to specific users/channels, essential for shared agents or restricted deployments.
- **Verify:** Test channel-approval-gate with allowFrom set to specific user id; verify inbound from unlisted user is rejected with clear reason, and listed user passes through.

### `CHN-6` Delivery routing with silence-narration detection and platform-agnostic targets  ★★★ · M · none

- **Based on (hermes):** `/Users/jinan/ai/hermes-agent/gateway/delivery.py` — hermes DeliveryTarget.parse() resolves 'origin'/'local'/'telegram:chat_id' strings, _is_silence_narration() regex skips '(silent)' or '…' deliveries, adapters handle splitting/chunking
- **Muse today:** none — /Users/jinan/side-project/Muse: no explicit delivery routing; inbound-responder.ts sends to source always, no routing abstraction. No silence detection.
- **Proposal:** Add @muse/messaging/src/delivery-router.ts: DeliveryTarget enum ('origin'|'local') or string 'slack:C123'/'discord:channel123', isSilenceNarration(text) regex matching '(silent)', '…', '🔇'. Create a messaging-send tool in @muse/agent-core that accepts target param (user says 'send to #general'), resolves target ID via channel directory (future), and routes via provider + silence detection.
- **Value:** Flexible message routing: agents can target specific channels/users, cron jobs route to designated channels, silence prevents spam; enables bot-to-bot signaling and fine-grained message delivery.
- **Verify:** Test send with text='(silent)': verify no message is dispatched. Test send with target='slack:C123': verify message routes to correct channel. Test silence with agent-generated responses.

### `CHN-7` Platform-agnostic message normalization with media refs and reply semantics  ★★ · L · partial

- **Based on (hermes):** `/Users/jinan/ai/hermes-agent/gateway/platforms/base.py` — hermes MessageEvent normalizes across platforms: message_id, platform_update_id, media_urls/media_types, reply_to_* fields, auto_skill, channel_prompt, channel_context with backfilled history
- **Muse today:** partial — /Users/jinan/side-project/Muse/packages/messaging/src/types.ts: InboundMessage has messageId, source, text, sender, receivedAtIso, raw; Discord/Telegram providers populate these, but no media_urls, no reply_to_message_id, no backfilled history
- **Proposal:** Extend InboundMessage interface in @muse/messaging/src/types.ts to add: media_urls?: string[], media_types?: string[], reply_to_message_id?: string, backfilled_context?: {prior_messages: InboundMessage[]}. Update each provider (Slack, Discord, Telegram) to populate these fields. In inbox-surface.ts, render media refs as '[attached: image]' in summary. Store backfilled context in inbound-thread-store for agent context.
- **Value:** Unified context across platforms: agents see consistent reply/mention semantics and media attachments; enables richer, context-aware responses.
- **Verify:** Test Discord message with media attachment and reply: verify InboundMessage.media_urls is populated and reply_to_message_id is set. Render in inbox summary and confirm agent sees context.

### `CHN-8` Channel directory with friendly-name aliasing and dynamic discovery  ★★ · M · none

- **Based on (hermes):** `/Users/jinan/ai/hermes-agent/gateway/channel_directory.py` — hermes builds channel_directory.json periodically from adapters + session data, overlay channel_aliases.json applies durable human-friendly names, send_message tool reads directory for action='list'
- **Muse today:** none — /Users/jinan/side-project/Muse: no channel directory; no friendly-name resolution; no dynamic discovery. Agents must use raw channel IDs.
- **Proposal:** Add @muse/messaging/src/channel-directory.ts: ChannelDirectory persists to ~/.muse/channel-directory.json, built from live adapters.getChannels() calls (requires provider extension). User-maintained ~/.muse/channel-aliases.json overlay applies friendly names ('work-group' → 'C123'). Add messaging_list_channels() MCP tool that returns {platform, id, name, type} entries, and extend send/respond tools to accept friendly names (resolved via directory). Rebuild directory on startup + hourly timer.
- **Value:** Human-friendly channel addressing: users never memorize chat IDs; 'send to work-group' works, and directory auto-discovers reachable channels for autocomplete.
- **Verify:** Create channel-aliases.json with friendly name, verify send_message tool lists it, resolve friendly name to ID, and send succeeds to actual channel.

### `CHN-9` Provider profile abstraction with declarative auth modes and vision support flags  ★★ · S · partial

- **Based on (hermes):** `/Users/jinan/ai/hermes-agent/providers/base.py` — hermes ProviderProfile dataclass (name, api_mode, auth_type, env_vars, supports_vision, fallback_models), transport reads this instead of 20+ boolean flags
- **Muse today:** partial — /Users/jinan/side-project/Muse/packages/messaging/src/types.ts: MessagingProviderInfo has id, displayName, description, local?; providers are instantiated directly with options, no declarative profile
- **Proposal:** Add @muse/messaging/src/provider-profile.ts: MessagingProviderProfile dataclass (name, auth_type: 'api_key'|'oauth_device_code'|'env_only', env_vars, supports_inbound, supports_media, supports_threads). Each provider (Slack, Discord, etc.) exports a static profile. Registry.require() returns both provider instance and its profile, so tools/CLI can inspect capabilities without instantiation. Future: pluggable provider registration keyed by profile.
- **Value:** Declarative provider capabilities: tools can filter by 'supports_inbound', CLI can show auth requirements upfront, new providers plug in via profile only.
- **Verify:** Create a mock provider with profile, register it, verify registry.describe() returns profile fields, and tool filtering works.

### `CHN-10` Session-scoped delivery info persistence for multi-part responses  ★ · S · none

- **Based on (hermes):** `/Users/jinan/ai/hermes-agent/gateway/platforms/webhook.py` — hermes WebhookAdapter._delivery_info (keyed by chat_id) stores delivery target resolved from route config on first send, reused by interim + final responses, never popped until TTL
- **Muse today:** none — /Users/jinan/side-project/Muse/packages/messaging/src: no webhook adapter; inbound-responder sends each message independently, no interim-vs-final distinction
- **Proposal:** Add @muse/messaging/src/delivery-session.ts: DeliverySession keyed by (providerId, source, runId), stores target channel + thread resolved on first send, reused by agent-generated intermediate messages and final response. Implement in webhook scenario: first streaming chunk → resolve target, all chunks → use cached target. Clean up session on TTL (5min) or explicit close.
- **Value:** Seamless multi-part delivery: status messages and final response route to same destination without repeating lookup; supports streaming responses and interim progress.
- **Verify:** Emit three messages in same session (interim, status, final), verify all three route to same channel without target resolution repeating.

### `CHN-11` Model-agnostic transport abstraction with pluggable API mode handlers  ★ · M · partial

- **Based on (hermes):** `/Users/jinan/ai/hermes-agent/agent/transports/__init__.py` — hermes get_transport(api_mode) returns transport from registry, lazy discovery imports transports.{anthropic,chat_completions,codex,bedrock}, each normalizes response to uniform NormalizedResponse
- **Muse today:** partial — /Users/jinan/side-project/Muse/packages/model/src: has ModelAdapter interface + implementations (openai, anthropic, etc.), but no transport abstraction layer; normalization is per-adapter, not pluggable
- **Proposal:** Extend @muse/model with pluggable transport pattern: export Transport interface (request → normalized response), move api_mode dispatch from AIAgent.callModel() into dedicated transport registry. Each provider registers a transport via api_mode key. Keep ModelAdapter for credential/config, but have Transport own the wire protocol + response normalization. This unifies model + messaging under same pluggable arch.
- **Value:** Unified pluggable architecture: new providers (messaging adapters, LLM backends) plug in via single registry pattern, reducing config complexity.
- **Verify:** Register mock transport for a new api_mode, call it via registry, verify response is normalized correctly, and provider SDK is never imported directly by agent.

## 10. Voice · Speech · Media Gen/Understanding · Document Extract

_14 opportunities · 21 competitor files read_


### `MED-1` Multi-Provider TTS Fallback with Ordered Chain  ★★★★★ · M · none

- **Based on (openclaw):** `packages/speech-core/src/tts.ts` — OpenClaw synthesizeSpeech() executes ordered provider chain via resolveTtsProviderCandidates()
- **Muse today:** none — packages/voice/src/registry.ts, types.ts — only single provider dispatch, no fallback
- **Proposal:** Add TtsProviderChain to packages/voice/src/registry.ts with tryProviders(providers[], request) that sequentially attempts each STT/TTS provider and returns first success, with optional fallback policies ('fail'/'skip-local'/'skip-cloud'). Respect MUSE_LOCAL_ONLY during chain traversal.
- **Value:** Resilience: TTS continues if primary provider fails (API down, auth fail, format unsupported on one provider but supported on next). Critical for voice mode reliability.
- **Verify:** Test fallback: primary fails, secondary succeeds; primary format unsupported, secondary handles it; respect MUSE_LOCAL_ONLY and skip cloud providers when flag set.

### `MED-2` Streaming Audio Synthesis (TTS ReadableStream)  ★★★★ · M · none

- **Based on (openclaw):** `packages/speech-core/src/tts.ts` — OpenClaw textToSpeechStream() + streamSpeech() return ReadableStream<Uint8Array> directly from providers
- **Muse today:** none — packages/voice/src/openai-tts.ts — synthesize() buffers entire response, no streaming
- **Proposal:** Add optional stream() method to TextToSpeechProvider interface in packages/voice/src/types.ts. Implement in OpenAITtsProvider to return fetch() response body directly (no buffering). Add synthesizeStream(request) export that returns ReadableStream<Uint8Array> and falls back to synthesize()+buffer if stream() unavailable. Wire into voice-mode for low-latency delivery.
- **Value:** Low-latency voice output in chat/REPL — stream-as-you-synthesize instead of waiting for full audio buffer. Reduces perceived latency by 50-80%.
- **Verify:** Test: streamSpeech() returns stream that emits first chunk within 100ms; buffering path (fallback) still works; stream closes cleanly.

### `MED-3` Audio Format Transcoding & Platform-Adaptive Delivery  ★★★★ · M · partial

- **Based on (openclaw):** `packages/speech-core/src/tts.ts` — OpenClaw maybePreTranscodeForVoiceDelivery() converts MP3→Opus for Telegram, validates channel codecs
- **Muse today:** partial — packages/voice/src/types.ts supports TtsFormat (mp3, wav, opus, aac, flac) but no transcoding logic
- **Proposal:** Add packages/voice/src/audio-transcode.ts with maybeTranscodeAudio(buffer, fromFormat, toFormat) using ffmpeg-wasm or similar lazy-loaded codec. Wire into TTS delivery path: before sending to messaging platform, check platform requirements and transcode if needed. Default: send provider's native format, let delivery layer adapt.
- **Value:** Agents can send voice notes to Telegram (needs Opus), Slack (needs MP3), Discord (needs Opus) without re-invoking TTS. Saves latency and API cost.
- **Verify:** Test: MP3→Opus converts within 500ms; WAV→MP3 works; format validation rejects unsupported targets; fallback gracefully (send native if transcode fails).

### `MED-4` PDF Extraction with Image Fallback (OCR via Vision Model)  ★★★★ · M · partial

- **Based on (openclaw):** `extensions/document-extract/document-extractor.ts` — OpenClaw extractPdfContent() text extraction, fallback to image extraction + vision (lines 78-96)
- **Muse today:** partial — packages/fs/src/fs-document.ts has extractPdfTextWithPdfjs() but no fallback to image/OCR
- **Proposal:** Enhance packages/fs/src/fs-document.ts extractPdfTextWithPdfjs(): if extracted text.length < minTextChars (e.g., 200), fall back to image extraction. For each page ≤ maxPages (e.g., 5), render to PNG via canvas or pdfjs canvas, call vision_analyze() (injected describeImage), accumulate OCR text. Return {text, images?, ocr_used?}. Wire into file_read tool.
- **Value:** Scanned PDFs, image-only docs no longer fail silently. Vision-OCR recovers text from low-quality or embedded images, grounding the agent's claims.
- **Verify:** Test: text PDF extracts via pdfjs; image-only PDF falls back to vision; OCR text is grounded (cites page); minTextChars threshold triggers fallback correctly.

### `MED-5` Image Generation (Text-to-Image & Image Editing) with Provider Registry  ★★★ · L · none

- **Based on (hermes):** `agent/image_gen_provider.py` — Hermes ImageGenProvider.generate() routes text-to-image vs image-editing based on image_url presence
- **Muse today:** none — packages/ — no image generation tool or provider at all
- **Proposal:** Create packages/media/src/image-gen-provider.ts with ImageGenProvider interface { generate(text, image_url?, model?, options?) → {url, path, mimeType, modality} }. Implement adapters for local Ollama (if model supports it), OpenAI DALL-E, xAI (all behind local-only gate). Route on image_url: present → inpaint/edit endpoint, absent → text-to-image. Register in agent-core tool executor.
- **Value:** Enables agents to generate and iterate on visual assets locally (when Ollama has vision+generation), with cloud fallback (gated). Moves Muse toward visual-creative parity.
- **Verify:** Test: text→image generates URL/file; image+text→edit generates edited image; MUSE_LOCAL_ONLY=1 blocks OpenAI fallback; result has modality indicator.

### `MED-6` TTS Directive Parsing & Runtime Voice Overrides  ★★★ · S · none

- **Based on (openclaw):** `packages/speech-core/src/tts.ts` — OpenClaw parseTtsDirectives() parses [[tts:voice=aria]] and [[tts:text]]...[[/tts:text]] inline blocks
- **Muse today:** none — packages/voice/ — no directive parsing; agent output shipped as-is to TTS
- **Proposal:** Add packages/voice/src/tts-directives.ts with parseTtsDirectives(text) → {directives: {voice?, model?, speed?, language?}, cleanText}. Directives format: [[tts:voice=aria,speed=1.2]] or [[tts:model=tts-1-hd]]. In agent-core runtime (agent-runtime.ts), after final output, apply directives to synthesize() request. Fallback policy: 'provider-defaults' if override missing.
- **Value:** Agents specify voice/speed/language per-message without context switch. 'Speak faster' mid-conversation, switch voices for dialogue — all in output.
- **Verify:** Test: [[tts:voice=nova,speed=1.5]] parsed and applied; clean text excludes directive syntax; invalid directive ignored with fallback; speed ∈ [0.25, 4.0].

### `MED-7` Vision Model Routing (Native vs Text Pipeline with Capability Auto-Selection)  ★★★ · M · partial

- **Based on (hermes):** `agent/image_routing.py` — Hermes decide_image_input_mode() routes 'native'/'text' based on provider capability; auto checks model.supports_vision
- **Muse today:** partial — packages/model/src/index.ts defines vision capability; packages/macos/src/macos-screen-tools.ts calls injected describeImage() but no routing logic
- **Proposal:** Add packages/model/src/vision-routing.ts with decideImageInputMode(image, model, auxiliary.vision.provider?, mode='auto') → 'native'|'text'. In 'auto': check model.capabilities.vision, then check auxiliary override, then check cost (local vision is free, cloud vision ∈ [low, high] cost). Text-mode calls vision_analyze() up-front (packages/macos describeImage pattern), prepends result to context. Native-mode attaches image bytes via ModelMessage.attachments.
- **Value:** Agents automatically choose efficient path: local models use native pixels, cloud models describe first (cheaper). Users control via auxiliary.vision.provider or MUSE_LOCAL_ONLY.
- **Verify:** Test: auto-mode picks 'native' for Gemini (vision=true), 'text' for Ollama gemma (vision=false); provider override honored; MUSE_LOCAL_ONLY=1 forces text-mode.

### `MED-8` Image Asset Caching (Local Materialization of Ephemeral URLs)  ★★★ · M · none

- **Based on (hermes):** `agent/image_gen_provider.py` — Hermes save_url_image() caches generated images to $HERMES_HOME/cache/images/ with content-type sniffing
- **Muse today:** none — packages/media/ — no image caching layer exists
- **Proposal:** Add packages/cache/src/image-cache.ts with saveImageUrl(url, timeout_sec=3600, max_bytes=50*1024*1024) → {localPath, mimeType, cachedAt, expiresAt}. Save to ~/.muse/cache/images/prefix_YYYYMMDD_HHMMSS_uuid8.ext, sniff MIME from response headers + magic bytes. Before returning ephemeral URL to agent, cache it. Cache cleanup: hourly eviction of expired entries.
- **Value:** Generated images (xAI, fallback OpenAI) survive delivery delays. Browser tools, messaging tools reference cached local paths instead of dead URLs.
- **Verify:** Test: saveImageUrl() downloads and caches; MIME sniffing works (JPEG, PNG, WebP); expiration honored; cleanup removes stale entries; cache dir created if missing.

### `MED-9` Media Understanding Tools (Image/Video/Audio Description)  ★★★ · M · partial

- **Based on (openclaw):** `extensions/media-understanding-core/runtime-api.ts` — OpenClaw describeImageFile(), describeVideoFile(), transcribeAudioFile() abstract vision/audio models
- **Muse today:** partial — packages/macos/src/macos-screen-tools.ts has describeImage() but only for screenshots; no tools for user-uploaded media
- **Proposal:** Create packages/domain-tools/src/media-understand-tools.ts exporting three tools: describe_image_file(path?, url?, language?), describe_video_file(path, language?, focus?), transcribe_audio_file(path, model?). Each calls vision_analyze() or stt.transcribe(). Results include timestamps (video), language (audio), and citation pointers for grounding. Wire into agent-core tool registry.
- **Value:** Users upload images/videos/audio; agent analyzes them locally (Ollama) or via grounded cloud fallback. Enables media-rich interactions: 'what's in this screenshot', 'transcribe my voice memo', 'analyze this video'.
- **Verify:** Test: describe_image_file(path) returns text; transcribe_audio_file() returns text + language; describe_video_file(path) returns scene descriptions + timestamps; grounding gates prevent fabrication.

### `MED-10` Video Generation (Text-to-Video & Image-to-Video) with Duration/Aspect Metadata  ★★ · L · none

- **Based on (hermes):** `agent/video_gen_provider.py` — Hermes VideoGenProvider.generate() mirrors image_gen design, routes text-to-video vs animation on image_url
- **Muse today:** none — packages/ — no video generation capability exists
- **Proposal:** Create packages/media/src/video-gen-provider.ts parallel to image-gen, with VideoGenProvider { generate(text, image_url?, aspect_ratio?, duration?, audio?, model?) → {url, path, duration_ms, modality} }. Implement adapters for FAL, xAI, Google Veo (behind local-only + grounding gate). Expose capability metadata (supported_aspect_ratios, max_duration_sec, audio_support). Route: image_url → animation, else → text-to-video.
- **Value:** Agents can generate video content (e.g., training materials, social media) with deterministic routing and grounding-aware fallback. Capability metadata enables length-aware prompting.
- **Verify:** Test: text→video generates URL with duration_ms; image+text→animation; aspect_ratio honored; duration ≤ max_duration; grounding gate prevents fabricated metadata.

### `MED-11` TTS User Preferences & Session-State Persistence  ★★ · M · none

- **Based on (openclaw):** `packages/speech-core/src/tts.ts` — OpenClaw readPrefs() / updatePrefs() persist ~/.openclaw/settings/tts.json; getTtsProvider() checks prefs first
- **Muse today:** none — packages/voice/src/registry.ts — no preference persistence; no state across turns
- **Proposal:** Add packages/voice/src/tts-preferences.ts with TtsPreferences { enabled, provider, voice, persona, speed, summarize?, maxLength_chars? }. Persist to ~/.muse/user-<id>/voice-prefs.json (aligned with memory.json structure). In voice-mode REPL, check prefs before each synthesis; setVoice/setSpeed/setProvider update prefs + current turn. Support session overrides (--voice flag).
- **Value:** User 'use Nova voice for now' and it sticks for the session. 'Save that for next time' and prefs persist. No context lost between voice-mode runs.
- **Verify:** Test: setVoice updates prefs.json; next REPL session reads same voice; session --voice flag overrides; prefs survive CLI restart.

### `MED-12` Transcription Model Catalog with Metadata & Built-in Dispatch Order  ★★ · S · none

- **Based on (hermes):** `agent/transcription_provider.py` — Hermes transcription_provider.py list_models() returns catalog; dispatch checks built-ins first, rejects plugins shadowing built-ins
- **Muse today:** none — packages/voice/src/registry.ts lists providers but no model catalog, no dispatch guard
- **Proposal:** Extend packages/voice/src/types.ts SpeechToTextProvider with optional listModels() → [{id, display, languages, max_audio_sec}]. Implement in Whisper/Groq/Mistral adapters. In VoiceProviderRegistry, add requireSttModel(provider_id, model_id) with built-in-always-win guard. Export listSttModels() for CLI /stt-models or voice-mode model picker.
- **Value:** Agents and users know which STT models are available, what languages each supports, max audio length per model. Can switch models without config rewrites.
- **Verify:** Test: listModels() returns non-empty array with {id, languages}; requireSttModel() rejects non-existent model; built-in guard prevents plugin shadowing.

### `MED-13` Voice Catalog & Persona-Aware Voice Selection UI  ★★ · S · none

- **Based on (openclaw):** `packages/speech-core/voice-models.ts` — OpenClaw resolveSupportedVoiceModelRefs() filters catalog; synthesizeVoiceModelCatalogEntries() exports {id, display, language, gender, preview_url}
- **Muse today:** none — packages/voice/src/types.ts TtsProviderInfo.availableVoices is string[] only, no metadata
- **Proposal:** Add packages/voice/src/voice-catalog.ts with VoiceModelCatalogEntry { id, provider, display, language, gender?, preview_url?, capabilities: {tts, realtime_transcription, realtime_voice} }. TtsProvider.listVoices() → VoiceModelCatalogEntry[]. Export synthesizeVoiceCatalogEntries(providers[]) for CLI /tts-voices. Wire into voice-mode voice picker (--voice with auto-complete).
- **Value:** Voice-mode REPL shows preview URLs, filters by language/gender/capability. Users pick voices visually instead of blind 'alloy' / 'echo' strings.
- **Verify:** Test: listVoices() returns catalog with preview_url; preview URLs are valid HTTP; gender/language filter works; realtime_voice flag gates realtime synthesis.

### `MED-14` Provider-Scoped Directive Tokens (e.g., Azure-Only Output Format)  ★ · S · none

- **Based on (openclaw):** `extensions/azure-speech/speech-provider.ts` — OpenClaw buildAzureSpeechProvider() parseDirectiveToken() handles [[tts:output_format]], [[tts:lang]] specific to Azure
- **Muse today:** none — packages/voice/src/ — no provider-specific directive support
- **Proposal:** Extend TtsDirective parsing in packages/voice/src/tts-directives.ts to support provider-scoped overrides: [[tts:openai:model=tts-1-hd]], [[tts:azure:output_format=audio-16khz-32kbitrate-mono-pcm]]. In synthesis path, filter directives by provider and apply only matching scoped ones. Document per-provider directives in adapter files.
- **Value:** Agents can leverage provider-specific features (Azure output formats, xAI models) inline without hardcoding provider names. Directives become provider-agnostic UI.
- **Verify:** Test: [[tts:azure:output_format=opus]] parsed correctly; non-Azure directives ignored when Azure is primary; fallback gracefully if scoped directive unsupported.

## 11. Web · Browser Control · Search Providers · Content Extraction

_13 opportunities · 28 competitor files read_


### `WEB-1` Pluggable Web Search Provider Registry with Capability Routing  ★★★★★ · M · none

- **Based on (hermes):** `/Users/jinan/ai/hermes-agent/agent/web_search_provider.py` — Hermes' WebSearchProvider ABC with search()/extract() dispatch and fallback cascade
- **Muse today:** none — packages/model/src/web-search-policy.ts — only policy gating, no provider abstraction; packages/mcp/src — no multi-provider web search routing
- **Proposal:** Add `packages/web-search/src/web-search-provider.ts` with WebSearchProvider ABC (search, extract methods + capability flags). Implement local-first providers: BraveSearchProvider, DuckDuckGoSearchProvider, SearxngProvider. Add web-search-registry.ts for config-driven selection (MUSE_WEB_SEARCH_BACKEND env). Route agent web_search tool calls through registry; fall back via preference order.
- **Value:** Agents can swap web backends without code changes; Muse stays local-first (Brave free tier, Searxng self-hosted) while supporting optional cloud (Tavily/Exa) via packages/model adapters pattern Muse already uses
- **Verify:** Write a test that swaps backend configs and verifies search results come from the selected provider; confirm Brave/Searxng work offline

### `WEB-2` Pluggable Browser Provider Registry with Cloud Auto-Detection  ★★★★ · M · partial

- **Based on (hermes):** `/Users/jinan/ai/hermes-agent/agent/browser_registry.py` — Hermes' BrowserProvider ABC + browser_registry.py with cloud provider fallback chain
- **Muse today:** partial — packages/browser/src/puppeteer-controller.ts — local Chromium only via puppeteer; packages/mcp/src/chrome-devtools-mcp.ts — user's running Chrome (read-only wrapper). No cloud provider support (Browserbase, Browser Use, Firecrawl).
- **Proposal:** Add `packages/browser/src/browser-provider.ts` ABC with create_session() → {cdpUrl, features}. Implement LocalPuppeteerBrowserProvider (current behavior). Add cloud stubs: BrowserbaseProvider, BrowserUseProvider, FirecrawlBrowserProvider in `packages/browser/src/providers/`. Build browser-registry.ts to resolve provider via MUSE_BROWSER_PROVIDER env (local default). Browser controller factory routes through registry; agents stay agnostic.
- **Value:** Muse can opt into cloud browser execution (Browserbase for stealth, Browser Use for multi-tab) without touching agent code or violating local-first default
- **Verify:** Unit test that swaps providers and confirms create_session returns correct CDP URL shape; integration test with local provider

### `WEB-3` Native JavaScript Dialog Supervisor with Agent Visibility  ★★★★ · S · partial

- **Based on (hermes):** `/Users/jinan/ai/hermes-agent/tools/browser_dialog_tool.py` — Hermes' browser_dialog tool + dialog supervisor responding to pending dialogs in snapshots
- **Muse today:** partial — packages/browser/src/puppeteer-controller.ts — auto-accepts dialogs and surfaces them in snapshot.dialog field. Missing: agent-facing browser_dialog tool to respond (dismiss, fill prompt) or wait on pending dialogs
- **Proposal:** Add `browser_dialog` tool to `packages/browser/src/browser-tools.ts` (alongside browser_click/browser_type). Tool signature: {action: 'accept'|'dismiss', prompt_text?: string, dialog_id?: string}. Extend BrowserController with method: respondToDialog(dialogId, action, text). Update PuppeteerBrowserController to track dialog IDs and expose them in snapshot. Gated by approval gate (dismiss is free, accept/prompt-fill are execute).
- **Value:** Agents unblock pages with native JS dialogs (payment confirmations, quantity prompts) without hanging; fail-close on agent refusal (no dialog → no page submission)
- **Verify:** Unit test snapshot includes dialog with stable ID; tool can accept/dismiss via ID. Integration test: navigate to page with dialog, verify agent can read and respond.

### `WEB-4` Screenshot + Vision-Based Page Understanding Integration  ★★★ · S · partial

- **Based on (openclaw):** `/Users/jinan/ai/openclaw/extensions/browser/src/browser-tool.actions.ts` — OpenClaw's executeSnapshotAction returning both ariaSnapshot (text) + screenshot buffer + vision model call
- **Muse today:** partial — packages/browser/src/browser-tools.ts has browser_look (screenshot + vision). Missing: unified snapshot that includes screenshot base64 inline (agents now choose snapshot vs look separately; no single atomic snapshot-with-visual)
- **Proposal:** Extend PageSnapshot to optionally carry screenshotBase64?: string. Update PuppeteerBrowserController.snapshot() to attach screenshot when page is visual-heavy (heuristic: div-heavy, low text density, or explicit flag). Modify browser_read to accept includeScreenshot?: boolean param. Store screenshot in controller cache (reuse across multiple tool calls to avoid double-capture).
- **Value:** Agents can read a snapshot (text + elements) with optional inline screenshot in one call, reducing round-trips. Vision model focus remains in browser_look (intent-driven), but snapshot can hint 'screenshot available' field
- **Verify:** Unit test snapshot includes screenshot base64 when page qualifies. Agent test: confirm browser_read with includeScreenshot returns both text and image

### `WEB-5` Form Field Normalization and Intelligent Type Inference  ★★★ · M · partial

- **Based on (openclaw):** `/Users/jinan/ai/openclaw/extensions/browser/src/browser-tool.actions.ts` — OpenClaw's normalizeBrowserFormField with type detection (text, select, checkbox, file, password) and file-chooser arming
- **Muse today:** partial — packages/browser/src/matcher.ts — element matching by role/name. Missing: rich form field types (detect select vs text vs file); no file-chooser arming (setInputFiles prep)
- **Proposal:** Enhance `packages/browser/src/matcher.ts` normalizeBrowserElement() to detect and annotate field type (text, password, email, number, select, checkbox, radio, file, textarea). Extend SnapshotElement with fieldType?: string. Update type() in PuppeteerBrowserController to arm file-chooser BEFORE setInputFiles when type=file. Modify browser_type to auto-select option when target='Country' text='Korea' on a <select>.
- **Value:** Agents don't send text to a checkbox or try typing into file inputs; form fills auto-detect and coerce types (dropdown selection doesn't need browser_click, just browser_type)
- **Verify:** Unit test: snapshot includes fieldType for various inputs. Agent test: browser_type on a select auto-picks option; file input arms chooser correctly

### `WEB-6` Web Content Extraction with Mozilla Readability Fallback  ★★★ · M · none

- **Based on (openclaw):** `/Users/jinan/ai/openclaw/extensions/web-readability/web-content-extractor.ts` — OpenClaw's WebContentExtractionPlugin using @mozilla/readability for lightweight article extraction
- **Muse today:** none — packages/browser/src — no readability integration; browser_read returns snapshot (text capped at BROWSER_MAX_TEXT). No article/main-content extraction.
- **Proposal:** Add `packages/web-extract/src/web-readability.ts` exporting extractArticle(html: string, options?: {format: 'text'|'markdown'}) using @mozilla/readability library (lazy-load). Add tool `web_extract_article` to packages/tools with inputs {url}. Uses browser to fetch + readability to parse. Returns {title, byline, content, textLength}. Use when user asks to 'extract the article' vs read the page. Gated as 'read' (no state change).
- **Value:** Users get clean article text from news/blog pages without noise (navigation, ads, sidebars). Local-only (readability runs client-side); no cloud dependency
- **Verify:** Unit test readability extraction on sample HTML. Tool test: navigate to blog post, extract_article returns clean body text

### `WEB-7` Snapshot Accessibility Tree Generation with Deduplication and Stable Refs  ★★★ · M · partial

- **Based on (openclaw):** `/Users/jinan/ai/openclaw/extensions/browser/src/browser/chrome-mcp.snapshot.ts` — OpenClaw's flattenChromeMcpSnapshotToAriaNodes with dedup tracking and bounded ref assignment
- **Muse today:** partial — packages/browser/src/matcher.ts generates refs (0, 1, 2...). Missing: deduplication tracking (same element → same ref across snapshots); role-based filtering (INTERACTIVE_ROLES, CONTENT_ROLES); bounded node count with overflow reporting
- **Proposal:** Enhance PuppeteerBrowserController snapshot collection to track element fingerprints (domPath + text hash) and reuse refs for stable elements across calls. Filter by role: include INTERACTIVE_ROLES (button, link, textbox, select...) + CONTENT_ROLES (heading, paragraph...), exclude structural noise. Cap at SNAPSHOT_ELEMENT_CEILING with overflow report (total / shown / nextRef). Update snapshot return to include deduplication stability guarantee in docs.
- **Value:** Agents get stable element references across multiple reads (same button always has same @e5 ref), reducing confusion when page re-renders. Dedup + role filtering keeps snapshots focused, fighting snapshot bloat on large pages
- **Verify:** Unit test: same page snapshot twice, confirm matching elements have same ref. Large-page test: snapshot with 500+ elements returns capped list with dedup guarantee

### `WEB-8` Raw Chrome DevTools Protocol (CDP) Passthrough Tool  ★★ · M · none

- **Based on (hermes):** `/Users/jinan/ai/hermes-agent/tools/browser_cdp_tool.py` — Hermes' browser_cdp tool sending arbitrary CDP commands via WebSocket bridge
- **Muse today:** none — packages/browser/src — no CDP passthrough; puppeteer wraps CDP but no agent-facing raw protocol tool
- **Proposal:** Add `browser_cdp` tool to `packages/browser/src/browser-tools.ts`. Tool signature: {method: string, params: JsonObject}. Extend PuppeteerBrowserController with cdpSendCommand(method, params) that routes JSON-RPC over the browser's CDP socket. Gate as 'execute' risk (unbound power). Document use cases: network interception, advanced cookies, iframe eval.
- **Value:** Agents get escape hatch for browser operations outside the curated tool surface (e.g., intercepting network requests, manipulating cookies, evaluating code in cross-origin iframes) without adding 20+ niche tools
- **Verify:** Unit test CDP roundtrip with mock protocol responses. Integration test: execute a known CDP method (e.g., Network.enable) and verify response shape

### `WEB-9` Session-Aware Browser Tab Tracking and Auto-Cleanup  ★★ · M · none

- **Based on (openclaw):** `/Users/jinan/ai/openclaw/extensions/browser/src/browser-runtime.ts` — OpenClaw's closeTrackedBrowserTabsForSessions + trackSessionBrowserTab for per-task lifecycle
- **Muse today:** none — packages/browser/src/puppeteer-controller.ts — no multi-tab tracking or session-aware cleanup. Puppeteer page stays open until close() is called.
- **Proposal:** Add `packages/browser/src/session-manager.ts` tracking opened tabs by sessionId. Extend BrowserController with methods: trackTab(tabId, sessionId) and closeSessionTabs(sessionId). Modify PuppeteerBrowserController to record tab IDs on open(); hook into agent runtime lifecycle to call closeSessionTabs(sessionId) on run completion or error. Prevents tab orphaning.
- **Value:** Agents can open multiple tabs per run without manual cleanup; framework auto-closes them when run ends, preventing resource leaks and tab-window clutter
- **Verify:** Unit test track/close lifecycle. Integration test: run opens 3 tabs, confirms all closed on run completion

### `WEB-10` Accessibility Tree Snapshot with ARIA/Role-Based Element References  ★★ · M · partial

- **Based on (hermes):** `/Users/jinan/ai/hermes-agent/tools/browser_tool.py` — Hermes' ariaSnapshot (accessibility tree text) with ref IDs (@e1, @e2) for agent grounding
- **Muse today:** partial — packages/browser/src/browser-tools.ts already returns elements with refs (numbered). Missing: ARIA-native naming (role + accessible name per ARIA spec), explicit tree structure hints for nested content
- **Proposal:** Enhance packages/browser/src/matcher.ts to build full ARIA tree from accessibility properties (getComputedAccessibleName, role from role attribute / implicit). Return structured tree in snapshot showing nesting (main > nav > link, etc.). Document ref assignment: @e1 for first interactive, @e2 for second, with stable ordering (DOM order). Add snapshot.ariaTree?: TreeNode for agents wanting full hierarchy.
- **Value:** Agents understand page semantics deeply (main landmark vs aside, form grouped fields) without vision. ARIA-native naming prevents mismatching similarly-labeled elements (two 'Submit' buttons in different contexts get distinguished by role + context)
- **Verify:** Unit test ARIA snapshot includes role, accessible name, nesting. Agent test: two 'Submit' buttons are disambiguated by ARIA context

### `WEB-11` Browser Act Execution with Per-Action Timeout and Stale-Target Recovery  ★★ · M · partial

- **Based on (openclaw):** `/Users/jinan/ai/openclaw/extensions/browser/src/browser-tool.actions.ts` — OpenClaw's executeActAction with BROWSER_ACT_REQUEST_TIMEOUT_SLACK_MS negotiation and Chrome target churn retry
- **Muse today:** partial — packages/browser/src/puppeteer-controller.ts sets protocolTimeoutMs globally. Missing: per-action timeout negotiation; stale-target recovery (Chrome kills targets → retry without targetId)
- **Proposal:** Add timeout params to BrowserController action methods: click(ref, timeoutMs?), type(ref, text, submit, timeoutMs?). In PuppeteerBrowserController, wrap each Puppeteer action in try-catch for 'Chrome target was closed' errors. On stale-target error: re-query the element (re-find by role/text) and retry once. Default timeout = 10s; agent can override per-action.
- **Value:** Dynamic pages that churn targets mid-action (React re-renders, iframes load) don't fail; agents can tune timeouts for slow networks or heavy pages without global config changes
- **Verify:** Unit test: mock stale-target error, confirm retry without targetId succeeds. Agent test: page with heavy re-rendering, confirm action succeeds after retry

### `WEB-12` Provider Configuration Contract with Secret Resolution Templates  ★★ · S · partial

- **Based on (openclaw):** `/Users/jinan/ai/openclaw/packages/web-content-core/src/provider-runtime-shared.ts` — OpenClaw's provider config layer resolving ${VAR}/env-var/secret-ref patterns for all backends
- **Muse today:** partial — packages/model/src — has provider base classes (Anthropic, OpenAI, Gemini adapters). Missing: unified secret-resolution for non-model providers (web search, browser, content extraction); no config-scoped overrides (tools.web.search vs tools.browser)
- **Proposal:** Add `packages/config/src/provider-config.ts` with resolveConfigValue(raw: string|{$ref: string}, context: {env, secrets, exec?}) → string. Support ${VAR}, MUSE_VAR env-refs, secretref-env: legacy, and exec-based secrets (e.g. 1password). Add per-tool scoped config: tools.web.search, tools.browser, tools.extract with per-provider overrides. Use in web-search-registry, browser-registry to resolve API keys without hardcoding.
- **Value:** Operators can configure all providers (web search, browser, extraction) via env vars / secret stores without duplicating resolution logic per provider
- **Verify:** Unit test: config resolver handles ${VAR}, env-refs, legacy secretref-env. Integration test: web search and browser both use resolved API keys from same config layer

### `WEB-13` Multi-Backend Browser Execution via Agent-Browser CLI Pattern  ★ · L · partial

- **Based on (hermes):** `/Users/jinan/ai/hermes-agent/tools/browser_tool.py` — Hermes' agent-browser CLI subprocess model supporting local Chromium, Browser Use cloud, Browserbase cloud with session isolation
- **Muse today:** partial — packages/browser/src uses puppeteer-core directly in-process (local Chromium). No subprocess CLI abstraction; no cloud runtime swap support
- **Proposal:** Build `packages/browser-cli/src/agent-browser-cli.ts` subprocess wrapper. Muse CLI would invoke 'agent-browser open --url X --session-id Y' instead of linking puppeteer. CLI server manages session lifecycle per task_id. Return JSON snapshot over stdout. Supports local (puppeteer) and cloud via env (BROWSER_USE_API_KEY, BROWSERBASE_API_KEY). Keeps agent code unchanged; wiring is at CLI boundary.
- **Value:** Decouples agent from browser implementation; cloud execution becomes a deployment choice (CI/cloud agent → cloud browser; dev → local Chromium) without code changes
- **Verify:** CLI integration test: invoke agent-browser as subprocess, verify session isolation and JSON snapshot output. Confirm local and cloud (stub) paths both work

## 12. CLI/TUI/UX · Onboarding · Diagnostics · Usage Surfaces

_13 opportunities · 22 competitor files read_


### `UX-1` Structured Health Checks with Repair Contracts and CI-Ready Linting  ★★★★ · M · partial

- **Based on (openclaw):** `docs/cli/doctor.md` — OpenClaw doctor.md: detect(ctx, scope?) -> HealthFinding[] and repair?(ctx, findings) -> HealthRepairResult contracts. Findings carry checkId for --skip/--only filters, severity, fixHint. Exit codes 0/1/2.
- **Muse today:** partial — apps/cli/src/commands-doctor*.ts — has local checks (modelEnvCheck, localOnlyCheck, etc.) but no repair() contract, no --lint (CI-friendly JSON), no per-finding checkId, no --skip/--only filtering, no structured HealthFinding type with fixHint
- **Proposal:** Extend packages/observability (or new packages/doctor-core) with HealthFinding {checkId, severity, message, path?, line?, column?, ocPath?, fixHint?} and HealthRepairResult {applied, skipped, failed}. Separate concerns: detect owns diagnosis, repair owns mutation. Add --lint flag to CLI for CI gates returning JSON. Add --skip checkId1,checkId2 to skip known issues.
- **Value:** Mature health systems separate diagnosis from mutation and enable CI gating. Muse's doctor currently only reports; repair + structured findings unblock automated remediation and CI/CD integration.
- **Verify:** muse doctor --lint outputs JSON with checkId field. muse doctor --skip notes-index-stale skips that check. muse doctor --repair applies fixes with --confirm gate.

### `UX-2` Streaming Error Diagnostics with Transient Exception Chain Analysis  ★★★ · M · none

- **Based on (hermes):** `agent/stream_diag.py` — Hermes stream_diag.py per-attempt metadata (provider, CF ray, bytes before drop) plus exception chains in fixed format make retries debuggable at scale
- **Muse today:** none — packages/model/src, packages/observability/src — no exception chain flattening, no per-attempt breadcrumbs (provider name, error class, attempt, base_url)
- **Proposal:** Add stream-diagnostics module to packages/observability/src: stream_diag_init() per-attempt dict {started_at, first_chunk_at, chunks, bytes, headers, http_status}, capture_response() snapshots provider/model/CF-Ray, flatten_exception_chain() walks __cause__/__context__ dedup to render nested errors as 'Outer <- Inner', log_stream_retry() records attempt counter, mid_tool_call flag, elapsed time. Export to model adapters for inline use.
- **Value:** Transient LLM stream failures (mid-token drops, provider-side 5xx) are common frustrations. Capturing per-attempt metadata + exception chains in fixed format makes it actionable — operators answer 'is one CF edge / downstream provider responsible?' without swimming in logs.
- **Verify:** Unit test: stream dies at byte 512, captured dict shows {bytes: 512, provider: 'openrouter', http_status: 503, attempt: 2}. flatten_exception_chain() reduces 5-deep cause chain to 2 line output.

### `UX-3` Cron Job Form with Payload Locking and Stagger Configuration  ★★★ · M · partial

- **Based on (openclaw):** `ui/src/ui/app-defaults.ts` — OpenClaw DEFAULT_CRON_FORM: 50+ fields including staggerAmount/staggerUnit (seconds), sessionTarget (isolated/shared), wakeMode (now/backoff), deliveryMode (announce/quiet), failureAlertMode/failureAlertAfter/failureAlertCooldownSeconds, payloadLocked (gates edit)
- **Muse today:** partial — packages/scheduler/src/index.ts — ScheduledJob has cronExpression, timezone, retryOnFailure, maxRetryCount, executionTimeoutMs, notificationChannelId, webhookUrl, but NO staggerAmount/staggerUnit, NO sessionTarget, NO wakeMode, NO deliveryMode, NO failureAlertMode/failureAlertAfter/failureAlertCooldownSeconds, NO payloadLocked
- **Proposal:** Extend ScheduledJob in packages/scheduler/src/index.ts to add: staggerAmount, staggerUnit (enum 'seconds'|'minutes'), sessionTarget ('isolated'|'shared'), wakeMode ('now'|'backoff'), deliveryMode ('announce'|'quiet'), failureAlertMode ('none'|'after-n-failures'), failureAlertAfter (count), failureAlertCooldownSeconds, payloadLocked (bool gate for payload field edit). Update normalizeScheduledJob and validation in scheduler-validation.ts.
- **Value:** Stagger + wakeMode prevent thundering herd from recurring jobs (e.g., 100 sensors polling at :00s all at once). deliveryMode lets operators mute noisy success notifications. payloadLocked safety switch prevents accidental re-execution of the wrong payload.
- **Verify:** Save job with staggerAmount: 30, staggerUnit: 'seconds', verify next executions stagger by 30s. payloadLocked: true prevents UI edit of agentPrompt. failureAlertMode: 'after-n-failures', failureAlertAfter: 3 triggers only after 3 consecutive failures.

### `UX-4` Theme and Terminal Detection with ANSI 256-Color Downsampling  ★★★ · M · partial

- **Based on (hermes):** `ui-tui/src/theme.ts` — Hermes theme.ts: detectLightMode() checks HERMES_TUI_LIGHT -> HERMES_TUI_THEME -> HERMES_TUI_BACKGROUND (hex luminance) -> COLORFGBG (XFCE/rxvt/Terminal.app) -> TERM_PROGRAM allow-list. normalizeAnsiForeground() maps hex to ANSI8-bit via Rec.709 luma + hue/saturation/lightness matching. Light/dark palettes explicit.
- **Muse today:** partial — apps/cli/src/tty-color.ts, muse-banner.ts — has colorize() but no detectLightMode signal chain, no COLORFGBG or Terminal.app detection, no ANSI8-bit downsampling for light terminals, no light/dark palette separation
- **Proposal:** Extend apps/cli/src/tty-color.ts with detectLightMode() signal chain: env.MUSE_TUI_LIGHT -> env.MUSE_TUI_THEME -> env.MUSE_TUI_BACKGROUND (hex luminance check) -> COLORFGBG (XFCE/rxvt) -> TERM_PROGRAM allow-list (Apple_Terminal defaults light). Add normalizeAnsiForeground(hex) using Rec.709 luma + HSL matching to ANSI8-bit palette. Maintain separate DARK_THEME and LIGHT_THEME palettes (e.g., DARK uses #FFD700, LIGHT uses #8B6914).
- **Value:** Terminal theming is invisible when it works, jarring when wrong. Multi-signal detection (env > background hint > terminal type) + ANSI color normalization for light 8-bit terminals is sophisticated; users can override via env vars without breaking light-mode UIs.
- **Verify:** COLORFGBG=7:0 (light bg) triggers light palette. Apple_Terminal defaults light. Hex #FFD700 downsamples to correct ANSI8-bit yellow on light 256-color terminal.

### `UX-5` Tool Execution Display with Diff Rendering and Skin-Aware Emoji  ★★★ · M · partial

- **Based on (hermes):** `agent/display.py` — Hermes display.py: LocalEditSnapshot (before dict), _diff_ansi() resolves skin colors for diff output, _hex_fg() converts hex to ANSI8-bit, get_tool_emoji() resolves from skin.tool_emojis > tool registry > default, diff colors from ui_error/ui_ok skin colors with tinted backgrounds
- **Muse today:** partial — apps/cli/src/chat-ink-render.test.ts, citation-stream.ts — renders tool output but no LocalEditSnapshot, no skin-aware diff colors, no get_tool_emoji() with fallback chain, no tool output length limiting config
- **Proposal:** Add tool-display module to packages/tools/src: LocalEditSnapshot {paths: {[path]: before-text}}, set_tool_preview_max_len()/get_tool_preview_max_len() for config-driven limits. _diff_ansi(before, after, skin) resolves ANSI from theme + returns colored diff lines. get_tool_emoji(toolName, skin, registry) resolves from: (1) skin.tool_emojis overrides, (2) registry.emoji, (3) default. Pre-snapshot files before execution for low-latency diff rendering.
- **Value:** CLI tool output formatting looks cosmetic but affects readability at scale. Skin-aware emoji + theme-adaptive diff colors prevent 'red-on-blue' readability disasters. Pre-snapshot enables local diff rendering without re-fetching files.
- **Verify:** Tool output exceeds tool_preview_max_len (4KB), truncated output shows '[... 2KB more]'. Diff uses ui_error color on light theme (darker shade, not red). /file emoji overridden by skin.tool_emojis['file'].

### `UX-6` Memory Monitoring and Graceful Exit for Long-Running CLI  ★★★ · M · partial

- **Based on (hermes):** `ui-tui/src/entry.tsx` — Hermes entry.tsx: shebang node --max-old-space-size=8192 --expose-gc, resets terminal modes on startup (DEC mouse tracking), setupGracefulExit() installs SIGHUP/SIGTERM handlers, startMemoryMonitor() polls heap, critical threshold triggers process.exit(137), heap dumps auto-trigger, recordParentLifecycle() breadcrumbs
- **Muse today:** partial — apps/cli/src/program.ts, chat-repl.ts — has graceful exit for SIGTERM but no memory monitoring, no heap dump on OOM, no exit code 137 for OOM distinction, no terminal mode reset (mouse tracking, raw mode), no parent-process lifecycle breadcrumbs
- **Proposal:** Enhance apps/cli/src/program.ts with memory-monitor module: startMemoryMonitor(options: {criticalThresholdMB, highThresholdMB}) polls v8.getHeapStatistics() on interval. Critical threshold triggers process.exit(137) + stderr 'OOM on heap=512MB'. High threshold logs heap dump path to agent.log. setupGracefulExit() already exists, extend with resetTerminalModes() (write ANSI to clear DEC mouse tracking, raw mode). recordParentLifecycle() writes lifecycle breadcrumbs {started_at, memory_warning_at, exited_at, exit_code} to parent's agent.log.
- **Value:** Long-running TUIs crash silently without cleanup. Terminal modes (mouse tracking, raw mode) left armed break the parent shell. Memory monitoring + heap dumps + exit code 137 + parent-process logging transforms 'TUI died' into actionable 'OOM on heap=512MB, dump=/path'.
- **Verify:** TUI runs for 30min, heap grows to critical threshold, process.exit(137) fires with 'OOM' message. Heap dump written. Parent shell functional after exit. Lifecycle breadcrumb in parent.log shows memory_warning_at timestamp.

### `UX-7` Multi-Channel Session Display with Context-Aware Naming  ★★ · S · partial

- **Based on (openclaw):** `ui/src/ui/session-display.ts` — OpenClaw parseSessionKey() extracts session type (main/subagent/cron/direct-chat/group-chat), CHANNEL_LABELS maps channels to human-readable names, resolveSessionDisplayName() applies typed prefixes (Subagent:/Cron:) and prefers user label > displayName > fallback
- **Muse today:** partial — packages/runtime-state/src/session-tags.ts — carries sessionId, userId, tags but no display metadata. apps/web/src/views — no resolveSessionDisplayName, no CHANNEL_LABELS, no session type parsing
- **Proposal:** Add session-display module to packages/runtime-state/src: CHANNEL_LABELS map {imessage, telegram, discord, signal, slack, whatsapp, matrix, email, sms} -> human names. parseSessionKey(key: string) -> {type: 'main'|'subagent'|'cron'|'direct-chat'|'group-chat', channelId?, userId?}. resolveSessionDisplayName(key, userLabel?, displayName?) returns 'Discord · user#1234' or 'Subagent: task-x' with type prefix applied.
- **Value:** Showing 'Discord · user#1234' vs 'agent:main:discord:direct:user#1234' changes usability drastically. Abstraction here pays off when channels proliferate (mail, Teams, etc.).
- **Verify:** parseSessionKey('agent:subagent:discord:direct:user123') returns {type: 'subagent', channelId: 'discord', userId: 'user123'}. resolveSessionDisplayName with type prefix renders 'Subagent: Discord · user#123'.

### `UX-8` Slash Command Routing with Stale-Flight Detection and Local Tool Fallback  ★★ · M · none

- **Based on (hermes):** `ui-tui/src/app/createSlashHandler.ts` — Hermes createSlashHandler.ts: per-command flight counter prevents stale handlers, stale() = flight !== current || sid !== current.sid, guarded/guardedErr wrappers discard results if stale, findSlashCommand() queries local registry, fallback uses catalog.canon for canonicalized name, dispatch types exec/plugin/alias/skill/send
- **Muse today:** none — apps/cli/src/chat-ink.ts — has slash command menu rendering but no flight tracking, no stale detection, no local registry fallback for canonicalized names, no dispatch type union with state checking
- **Proposal:** Add slash-command-router module to packages/tools/src (or new packages/slash-router): SlashHandlerContext {gateway, local catalog, transcript page/send/sys}, SlashCommand with dispatch type union (exec/plugin/alias/skill/send). createSlashHandler() initializes per-command flight counter, stale() checks flight !== current || sid !== current.sid, guarded wrapper discards results if stale. findSlashCommand() queries local registry, fallback uses catalog.canon for alias resolution, ambiguous matches show up to 6 suggestions.
- **Value:** Slash handlers in reactive TUIs need flight tracking to prevent race conditions (user sends /cmd, switches session before response arrives). Local registry + catalog fallback + alias resolution + ambiguity hints make dispatch robust without server round-trips.
- **Verify:** User sends /ask, switches session before response arrives — result is discarded (stale() detected). /ask vs /ask-memory ambiguous match shows 2 suggestions. /a (alias) expands to /agent and delegates dispatch.

### `UX-9` State-Driven TUI with Nanostores Atoms and React Hooks  ★★ · L · none

- **Based on (hermes):** `ui-tui/src/app/turnStore.ts` — Hermes turnStore.ts: $turnState = atom<TurnState>() (immutable nanostores), useTurnSelector<T>(selector) bridges nanostores to React useSyncExternalStore, patchTurnState() shallow merge or function-based update, granular selectors prevent cascading re-renders
- **Muse today:** none — apps/cli/src/tui.ts — uses React hooks (useState) but no nanostores, no atom pattern, no granular selectors (renders full re-render on any state change), no useSyncExternalStore bridge for external state
- **Proposal:** If a Muse TUI (web or future terminal rebuild) is planned: adopt nanostores for immutable atom-based state. Create $turnState = atom<TurnState>(initialValue) carrying {activity[], outcome, reasoning, streamPendingTools[], subagents[], todos[], tools[], turnTrail[]}. Export useTurnSelector<T>(selector: (state) => T) wrapping useSyncExternalStore for granular subscriptions. Use patchTurnState() for shallow merge or function-based updates, avoiding full re-render when one field changes.
- **Value:** Nanostores + React hooks avoid Redux boilerplate while staying immutable + debuggable. Granular selectors + atom listen() subscriptions prevent cascading re-renders — critical for terminal UIs with tight frame budgets.
- **Verify:** Render component subscribing only to activity[] via useTurnSelector(s => s.activity) does not re-render when todos[] changes. Atom listen() logs state changes for debugging.

### `UX-10` Usage Metrics Tab with Daily Bar Tooltips and Dynamic Layout  ★★ · M · none

- **Based on (openclaw):** `ui/src/ui/views/usage-render-overview.ts` — OpenClaw usage-render-overview.ts: renderFloatingDailyBarTooltip renders date/tokens/cost/breakdown on hover/focus, positionFloatingDailyBarTooltip() clamps to viewport + flips if margin violated, tooltip state machine tracks activeDailyBarTooltip + reasons set (hover|focus), floating tooltip reuses single DOM element mutated in-place
- **Muse today:** none — apps/web/src/views — Dashboard exists but no usage metrics tab, no floating tooltip pattern, no daily bar chart with interactive breakdowns, no viewport clamping + flip logic
- **Proposal:** Add usage-metrics view to apps/web/src/views (or update Dashboard.tsx): renderFloatingDailyBarTooltip(day, tokens, cost, breakdown) displays {date, tokens, cost_breakdown per provider}. positionFloatingDailyBarTooltip(tooltipRect, barRect, viewportRect) clamps to 8px margin, flips below if top margin violated. activeDailyBarTooltip tracks {sourceElem, reasonsSet: Set<'hover'|'focus'>, content}. Reuse single DOM element, MutationObserver tracks mount/unmount. suppressNextDailyBarFocusTooltip timer prevents rapid re-shows.
- **Value:** Usage visualization tooltips need sub-100ms interaction latency. Floating single-element reuse + requestAnimationFrame positioning + stale-suppression timers keep the dashboard responsive even with frequent bar updates.
- **Verify:** Hover bar shows tooltip in <100ms. Tooltip clamped to viewport with 8px margin. Tab away and back doesn't show stale tooltip. Flip-below logic engages when tooltip height + bar > viewport top.

### `UX-11` Interactive Onboarding Wizard with Multi-Flow Selection and Locale Awareness  ★★ · M · partial

- **Based on (openclaw):** `docs/cli/onboard.md` — OpenClaw onboard.md: guided setup flows (quickstart/manual/import), locale-aware prompts, provider selection, auth-mode switching (plaintext/ref/OAuth), non-interactive flag for CI, post-setup bootstrap of workspace files (AGENTS.md, SOUL.md, IDENTITY.md)
- **Muse today:** partial — apps/cli/src/commands-onboard.ts — has single deterministic step flow (Ollama → chat model → embed model → corpus → index) but NO multi-flow selection (quickstart/manual/import), NO locale awareness, NO auth-mode switching, NO post-setup bootstrap of workspace files (AGENTS.md, SOUL.md, IDENTITY.md), NO non-interactive flag for CI
- **Proposal:** Enhance commands-onboard.ts with: (1) Multi-flow selection prompt asking 'quickstart (defaults) / manual (pick models) / import (restore backup)'. (2) Locale detection via LANG/LC_ALL for prompts. (3) Auth-mode flags (--auth-mode plaintext|ref|oauth) for credential setup. (4) Post-setup bootstrap: if ready, generate AGENTS.md (example agents), SOUL.md (instructions), IDENTITY.md (user profile hint). (5) Add --non-interactive flag that auto-selects quickstart path, suitable for CI scripting.
- **Value:** Multi-flow onboarding respects user expertise (power users can skip 'pick model' if they know it). Locale + locale-aware prompts + post-setup file bootstrap make the wedge feel polished. Non-interactive mode unblocks CI/Docker setup.
- **Verify:** muse onboard --flow quickstart auto-selects defaults without prompts. --flow manual prompts for model selection. --non-interactive + --flow quickstart runs unattended. AGENTS.md bootstrapped at end contains example agent invite. Prompts localized to LANG=fr_FR.

### `UX-12` Account Usage Windows with Provider-Specific Rendering and Reset Countdown  ★ · L · none

- **Based on (hermes):** `agent/account_usage.py` — Hermes account_usage.py: AccountUsageWindow (label, used_percent, reset_at, detail), AccountUsageSnapshot (immutable, fail-open, provider-aware), render_account_usage_lines() with reset-time countdown (in {days}d {hours}h, local tz)
- **Muse today:** none — packages/observability/src, apps/web/src — no AccountUsageSnapshot type, no usage window rendering, no reset countdown formatting, no provider-specific variance handling (e.g., MiniMax inverted usage_percent)
- **Proposal:** Add usage-account module to packages/observability/src: AccountUsageWindow (label, used_percent, reset_at, detail), AccountUsageSnapshot (provider, source, fetched_at, title, plan, windows[], details, unavailable_reason), render_account_usage_lines() converting snapshot to markdown lines with reset-time countdown in local tz. Handle provider variance (MiniMax: invert usage_percent, prefer model_remains). Use Decimal end-to-end, fail-open design.
- **Value:** Usage snapshots inform user decisions (should I wait for reset? upgrade?). Immutable dataclasses + provider-aware design + local tz formatting prevent time-zone confusion and allow graceful degradation when auth fails.
- **Verify:** AccountUsageSnapshot renders two windows (daily_requests, monthly_tokens) with correct reset countdown ('in 5d 3h', not raw UTC). MiniMax variant inverts usage_percent correctly. Fails open when provider auth unavailable.

### `UX-13` Banner Markup Parsing with Theme-Driven Color Gradients  ★ · S · partial

- **Based on (hermes):** `ui-tui/src/banner.ts` — Hermes banner.ts: parseRichMarkup() regex-matches [#RRGGBB]...[/] color regions, LOGO_ART (ASCII art) + CADUCEUS_ART (Braille art) plain strings, colorize() maps gradients to theme palette (LOGO_GRADIENT, CADUC_GRADIENT), logo()/caduceus() return [color, text][] arrays, artWidth() computes rendered width
- **Muse today:** partial — apps/cli/src/muse-banner.ts, muse-mascot-ansi.ts — has ASCII art + basic colorize but no parseRichMarkup for [#hex]...[/] markup, no gradient arrays (LOGO_GRADIENT, CADUC_GRADIENT), no [color, text][] tuple output, no artWidth() for rendered width calculation
- **Proposal:** Extend apps/cli/src/muse-banner.ts with banner-markup module: parseRichMarkup(text) regex-matches [#RRGGBB]...[/] regions, returns [color_hex, text][] tuples. Store LOGO_ART and CADUCEUS_ART as plain strings (6 and 15 lines). Add LOGO_GRADIENT = [0,0,1,1,2,2] (indices into theme.colors) and colorize() maps gradient indices to theme palette. Export logo(skin) and caduceus(skin) returning colored [color, text][] arrays for ink/blessed renderer. artWidth(tuples) computes rendered width.
- **Value:** ASCII art + gradients make TUI banners memorable. Parameterizing color mapping over theme means banners adapt to light/dark automatically without duplicating art or hardcoding colors.
- **Verify:** logo() with dark theme renders gold gradient (#FFD700), light theme renders darker gold (#8B6914). Braille art (caduceus) applies correct 15-element gradient. artWidth(tuples) matches actual rendered width in terminal.

## 13. Internationalization · Localization (multi-language UX + output)

_15 opportunities · 16 competitor files read_


### `I18N-1` CLI locale resolution from environment variables  ★★★★★ · M · none

- **Based on (openclaw):** `src/wizard/i18n/index.ts` — resolveWizardLocaleFromEnv checks OPENCLAW_LOCALE, LC_ALL, LC_MESSAGES, LANG in priority order; normalizes encoding suffixes and regional variants
- **Muse today:** none — Muse CLI apps/cli/src has no environment-based locale detection; all CLI output is hardcoded English
- **Proposal:** Add packages/i18n-cli with resolveLocaleFromEnv() that checks MUSE_LOCALE, LC_ALL, LC_MESSAGES, LANG in priority order, normalizes encoding (UTF-8 strips), and maps regional variants (zh_HK -> zh-TW). Integrate into apps/cli main startup via global.locale singleton read-once pattern.
- **Value:** CLI users get output in their system language without config; covers Linux/macOS/Windows environment variations
- **Verify:** CLI run with LANG=ko_KR.UTF-8 produces Korean output; MUSE_LOCALE=de overrides; fallback to en when unknown

### `I18N-2` Catalog parity enforcement via test suite  ★★★★★ · S · none

- **Based on (hermes):** `tests/agent/test_i18n.py` — hermes test_catalog_keys_match_english() flattens all YAML catalogs, asserts every non-English locale has identical key set as en.yaml; test_catalog_placeholders_match_english() regex-matches {placeholder} tokens
- **Muse today:** none — apps/web/e2e/i18n.spec.ts only tests toggling between languages; no validation that en and ko have matching keys or placeholder format
- **Proposal:** Add apps/web/src/i18n/strings.test.ts that flattens en and ko dicts, asserts key parity, and validates {placeholder} format consistency. Run on CI. Catch incomplete translations and typos before deploy.
- **Value:** Incomplete translations caught at test time, not silently at runtime; prevents UX breakage from missing keys or mismatched placeholders
- **Verify:** Test fails if ko is missing a key from en; test fails if ko has {count} but en has {n}; test passes on parity

### `I18N-3` Lazy-loaded locale splitting for web bundle optimization  ★★★★ · M · partial

- **Based on (openclaw):** `ui/src/i18n/lib/registry.ts` — openclaw's DEFAULT_LOCALE (en) bundled inline; 18 lazy locales via dynamic imports with loaders() returning Promise<LocaleModule>, cached in memory on first access
- **Muse today:** partial — apps/web/src/i18n/strings.ts embeds all locales statically (en + ko both hardcoded in one bundle); no lazy loading, no network round-trip optimization
- **Proposal:** Refactor apps/web/src/i18n to lazy-load non-English locales. Keep en inline; move ko/future locales to dynamic imports (e.g., import('./locales/ko.js')). Cache loaded locales in memory. Update I18nProvider to async-load on first useI18n() outside the default language.
- **Value:** Users only download English by default; switching languages adds single network round-trip, not zero-cost bloat
- **Verify:** Bundle size en-only < 50% of current; first switch to ko loads once and caches; reload preserves cached locale

### `I18N-4` Hierarchical dotted-key fallback with depth-first traversal  ★★★★ · M · partial

- **Based on (openclaw):** `ui/src/i18n/lib/translate.ts` — openclaw's t(key, params) splits 'approval.approve' by dot, walks TranslationMap tree. Missing in target locale falls back to English entire tree walk. Returns bare key path if English misses too. Params via {placeholder} regex; returns original if format fails.
- **Muse today:** partial — apps/web/src/i18n/index.tsx has simple flat-dict t() that falls back to en[key], but no dotted-path traversal or error recovery for malformed placeholders
- **Proposal:** Enhance apps/web/src/i18n/index.tsx fill() to handle dotted keys: t('nav.primary') splits to nav->primary walk. If locale dict missing, walk en. If en also missing, return bare key (never undefined/null). Add try-catch on regex replace to return original string on format error (malformed placeholder).
- **Value:** Incomplete translations never crash; partial locales work. Typos in translation placeholders don't silently lose values. Graceful degradation UX.
- **Verify:** t('nav.primary') returns translated value; t('missing.key') returns 'missing.key'; t('hi {name}', {}) returns 'hi {name}'

### `I18N-5` Language normalization for CLI with 40+ aliases  ★★★ · S · none

- **Based on (hermes):** `agent/i18n.py` — hermes _normalize_lang() accepts bare codes (en), natural aliases (english, Deutsch, 中文), regional tags (zh-CN, zh-Hans, pt-BR), and native scripts (українська, 한국어). Case-insensitive; maps 40+ aliases; unknown -> DEFAULT_LANGUAGE
- **Muse today:** none — packages/i18n-cli (not yet created) would need normalization; currently no CLI language arg at all
- **Proposal:** In packages/i18n-cli, add normalizeLanguage(input: string) -> Lang that accepts 'en'/'ko', natural names ('english', '한국어', 'korean'), and regional variants (en-US, ko-KR). Return normalized Lang or 'en' fallback. Use in CLI --language flag and env var resolution.
- **Value:** Users type 'korean' or '한국어' instead of exact code; multilingual teams with mixed systems all resolve correctly
- **Verify:** normalizeLanguage('korean') = 'ko'; normalizeLanguage('영어') = 'en'; normalizeLanguage('unknown') = 'en'

### `I18N-6` Scoped translator for agent subflows with key prefix delegation  ★★★ · M · none

- **Based on (openclaw):** `src/wizard/i18n/index.ts` — openclaw's createSetupTranslator({keyPrefix, locale}) auto-prefixes non-absolute keys. Keys starting with 'common.' or 'wizard.' skip prefix; others get 'wizard.{section}.{key}'. Shared keys remain importable from any subflow.
- **Muse today:** none — Muse has no CLI i18n at all; no agent subflow localization pattern
- **Proposal:** In packages/i18n-cli, export createScopedT(prefix: string, locale: Lang): Translate that auto-prefixes non-absolute keys. 'chat.help' becomes 'chat.section.help' for a 'section' scope. Keys starting 'common.' or 'chat.' skip prefix. Shared strings reusable across CLI flows.
- **Value:** Agent subflows (chat, decompose, recall) reuse shared UI strings without deep nesting; changes to common strings propagate globally; reduces duplication
- **Verify:** createScopedT('approval', ko)('myKey') -> ko['approval.myKey']; ('common.ok') -> ko['common.ok']

### `I18N-7` Multi-level config resolution for language preference with caching  ★★★ · M · none

- **Based on (hermes):** `agent/i18n.py` — hermes get_language() resolves HERMES_LANGUAGE env > _config_language_cached() (display.language from config.yaml, cached via @lru_cache) > DEFAULT_LANGUAGE. reset_language_cache() clears caches for runtime config changes.
- **Muse today:** none — packages/i18n-cli not yet created; Muse has no CLI config-file-based language preference
- **Proposal:** In packages/i18n-cli, add getLanguage(): Lang that resolves MUSE_LOCALE env > config.display.language (from runtime-settings, cached via lru-cache) > 'en'. Export resetLanguageCache() to clear both caches on config hotload.
- **Value:** Env override for quick testing; config file for persistent user choice; cached resolution avoids repeated I/O in hot paths (agent prompts, CLI commands)
- **Verify:** MUSE_LOCALE=ko getLanguage() -> 'ko'; config.display.language='ko' returns 'ko'; resetLanguageCache() clears the cache

### `I18N-8` Catalog flattening with nested YAML structure for maintainability  ★★★ · M · none

- **Based on (hermes):** `agent/i18n.py` — hermes _load_catalog(lang) reads nested YAML (gateway: { reset: { header: ... } }), calls _flatten_into() to convert to dotted flat dict. Flattening once per process; subsequent .t() calls hit memory cache. Thread-safe via _catalog_lock.
- **Muse today:** none — Muse web app uses flat TypeScript dicts; no nested structure. CLI has no i18n at all.
- **Proposal:** Create packages/i18n-core with loadCatalog(lang: Lang): Translations that (1) accepts nested YAML structure (e.g., { nav: { primary: '...' } }) (2) flattens to dotted keys (nav.primary) (3) caches in memory (4) thread-safe via _catalog_lock. Use in CLI for maintainable translation files.
- **Value:** Translators edit readable nested YAML instead of flat keys. Flattening happens once per process; hot paths hit cache. Scales to many languages.
- **Verify:** loadCatalog('ko') from nested YAML returns flat dict; second call returns cached result; parallel calls don't race

### `I18N-9` Storage-persisted locale preference with system fallback  ★★ · S · partial

- **Based on (openclaw):** `ui/src/i18n/lib/translate.ts` — openclaw's I18nManager reads localStorage[openclaw.i18n.locale], falls back to navigator.language resolution; setLocale() persists; unsubscribe() returns cleanup
- **Muse today:** partial — apps/web/src/i18n/index.tsx already persists to localStorage[muse.lang] and falls back to navigator.language; but no unsubscribe cleanup or observable pattern
- **Proposal:** Enhance apps/web/src/i18n/index.tsx with explicit subscription/unsubscribe pattern. Export I18nProvider-scoped listeners and a cleanup function. Add test that verifies storage survives SSR contexts (try-catch on localStorage).
- **Value:** Users stay in chosen language across sessions; navigator fallback handles first visit without friction; cleanup prevents memory leaks in tests
- **Verify:** Language persists across page reload; new user defaults to navigator.language; SSR context doesn't crash localStorage

### `I18N-10` Format-safe string interpolation with error recovery  ★★ · S · partial

- **Based on (openclaw):** `ui/src/i18n/lib/translate.ts` — openclaw's t() replaces /{\w+}/ globally. If param missing, keeps placeholder intact. If format() raises KeyError/IndexError/ValueError, logs warning and returns original string unchanged.
- **Muse today:** partial — apps/web/src/i18n/index.tsx fill() does {\w+} replace but doesn't guard against missing params or malformed templates
- **Proposal:** Enhance apps/web/src/i18n/index.tsx fill() to: (1) if param missing, keep placeholder (2) wrap regex replace in try-catch, return original on error, log warning. Add test for typo resilience.
- **Value:** Typos in translation placeholders surface as {placeholder} in UI, not silent data loss or crash. Helps localization teams catch interpolation bugs early.
- **Verify:** fill('hi {name}', {}) -> 'hi {name}'; fill('hi {name}', {user: 'Bob'}) -> 'hi {user}' (still shows literal {name})

### `I18N-11` Bundled vs. wheel vs. source locale resolution with sysconfig fallback  ★★ · M · none

- **Based on (hermes):** `agent/i18n.py` — hermes _locales_dir() checks HERMES_BUNDLED_LOCALES env, then <repo>/locales (source), then sysconfig schemes (pip wheel). Falls back to source path for logging if all missing.
- **Muse today:** none — Muse has no CLI i18n; no multi-deployment-mode locale loading
- **Proposal:** In packages/i18n-cli, add localesDir(): string that checks MUSE_BUNDLED_LOCALES env, then <repo>/locales (source dev), then sysconfig purelib/platlib (wheel install). Falls back to source for informative error. Load locales relative to this path.
- **Value:** Supports sealed installs (Nix container), source dev, and pip-wheel production without special config. Testers inject MUSE_BUNDLED_LOCALES for offline testing.
- **Verify:** MUSE_BUNDLED_LOCALES=/offline localesDir() -> /offline; wheel install localesDir() -> sysconfig path; dev fallback to <repo>/locales

### `I18N-12` Exhaustive language type with optional fields for staged rollout  ★★ · M · partial

- **Based on (hermes):** `web/src/i18n/types.ts` — hermes Translations interface defines mandatory keys and optional keys marked with '?' for staged rollout. Optional keys fall back to English literals in components until translated.
- **Muse today:** partial — apps/web/src/i18n/strings.ts has StringKey type enforcing all keys match en, but no optional field pattern for gradual rollout of new strings
- **Proposal:** Update apps/web/src/i18n/strings.ts to add optional marker syntax (e.g., 'future.key?': undefined in Strings type). Components null-coalesce missing optional strings to en fallback. Allows shipping partial locales without TypeScript errors; unblock new features for en-only users first.
- **Value:** New languages ship faster with partial translation. Optional keys prevent TypeScript errors. Stagger feature rollout across languages.
- **Verify:** Type-check with optional key missing from ko -> no error; runtime returns ko['key'] || en['key']

### `I18N-13` React context provider with localStorage persistence and fallback locale  ★★ · S · partial

- **Based on (hermes):** `web/src/i18n/context.tsx` — hermes I18nProvider wraps app with I18nContext, getInitialLocale() reads localStorage[hermes-locale], validates with isLocale(), defaults to 'en'. setLocale() updates state and try-catch writes localStorage. useI18n() hook returns {locale, setLocale, t: Translations}. LOCALE_META maps 16 locales to endonyms.
- **Muse today:** partial — apps/web/src/i18n/index.tsx already has Provider + useI18n hook + localStorage, but no endonym display (native names like '간체 중문')
- **Proposal:** Enhance apps/web/src/i18n/index.tsx to export LOCALE_META constant mapping Lang to endonym + flag. Use in language picker UI to show native names instead of codes. Validate locale with isLocale() before reading localStorage.
- **Value:** Language picker shows '한국어' not 'ko'; prevents ambiguity. Matches user's language preference in their own script.
- **Verify:** LOCALE_META['ko'] = { endonym: '한국어', flag: '🇰🇷' }; picker displays endonym; invalid lang validated out

### `I18N-14` Static message scope enforcement with catalog versioning  ★ · L · none

- **Based on (openclaw):** `scripts/control-ui-i18n.ts` — openclaw control-ui-i18n.ts uses OpenAI/Anthropic with glossary.json (term memory) and LLM-based translation with caching, batching (20 items, 2k char), and provenance tracking (model/provider, timestamp)
- **Muse today:** none — Muse has no automated translation tooling; no LLM-driven i18n pipeline
- **Proposal:** Create scripts/translate-cli-i18n.ts that scans apps/cli/src and packages/*/src for string literals matching i18n keys. Supports manual dispatch to local LLM (ollama + gemma4:12b via packages/model) with glossary.json (product names: 'Muse' -> 'Muse' for all langs). Records term memory (.i18n/{lang}.tm.jsonl) with hash, model, timestamp. Batches up to 20 items, fail-close on LLM timeout.
- **Value:** Scales CLI translation to many locales without per-language translator. Glossary ensures Muse/product names consistent. Term memory auditable (which LLM version, when translated).
- **Verify:** Script translates 100 English strings to ko via ollama; glossary enforces 'Muse' -> 'Muse' in all; .i18n/ko.tm.jsonl records provenance

### `I18N-15` Raw copy baseline detection and drift analysis for UI localization  ★ · M · none

- **Based on (openclaw):** `scripts/control-ui-i18n.ts` — openclaw RAW_COPY_BASELINE_PATH tracks untranslated UI strings by kind (html-attribute, html-text, object-property), path, line, text, count. control-ui-i18n reports new/removed/changed raw copy; helps identify UI needing translation.
- **Muse today:** none — Muse has no baseline tracking of raw English UI strings needing i18n
- **Proposal:** Add scripts/i18n-baseline.ts that scans apps/web/src and apps/cli/src for hardcoded strings (not from i18n dicts), emits raw-copy-baseline.json with {kind, path, line, text, count}. CI tracks drift: fail if new raw copy detected. Helps schedule proactive translation.
- **Value:** Catch new English UI strings before release; track raw-copy debt over sprints; schedule translation proactively instead of reactive.
- **Verify:** Baseline detects hardcoded 'Chat' in button label; drift report shows +1 new raw copy; adding i18n key removes it from report

---

## Totals

- Opportunities: **166** (from 167 raw; 1 dropped for unverifiable evidence path)
- Competitor files actually opened: **253**
- Muse status: none **88** · partial **78**
- Effort: S **40** · M **104** · L **22**
- Tiers: ★★★★★ **12** · ★★★★ **32** · ★★★ **48** · ★★ **53** · ★ **21**

### Dropped (evidence path did not resolve)

- orchestration: Typed Worker Result Parsing with Validation → hermes/acp_adapter tools validation patterns
