# Capability-Parity Backlog — Judgment (Muse-fit assessment)

> Generated 2026-06-23 by 21 INDEPENDENT judges (maker≠judge) over all 231 opportunities in
> [`growth-backlog.md`](growth-backlog.md). The lens is **Muse's identity** —
> a single-user, LOCAL, grounded personal companion ("Learns you, not the world") — NOT the
> multi-tenant hosted gateways openclaw/hermes are. A real competitor feature can still be the
> wrong thing for Muse; that is what this judgment separates out.
>
> **fit**: core (serves single-user local Muse) · adjacent (useful, not central) · off-strategy
> (serves multi-tenant/cloud-scale, wrong for Muse). **verdict**: build / maybe / skip.
> **edge**: does it strengthen the grounding/"shows its work" edge.

## Scorecard

| Verdict | Count | | Fit | Count | | Edge | Count |
|---|---|---|---|---|---|---|---|
| ✅ build | 121 | | core | 126 | | strengthens | 108 |
| 🟡 maybe | 59 | | adjacent | 55 | | neutral | 80 |
| ⛔ skip | 51 | | off-strategy | 50 | | irrelevant | 43 |

**Headline:** of 231 listed, **121 are worth building**, 59 are conditional,
and **51 should be dropped** as wrong-for-Muse (mostly multi-tenant / cloud-scale competitor
features). 47 are top-tier (★5 + strengthens-the-edge).

## Per-theme verdicts (build / maybe / skip)

| Theme | ✅ | 🟡 | ⛔ |
|---|---|---|---|
| Agent Runtime | 5 | 5 | 2 |
| Context Compaction | 8 | 4 | 0 |
| Prompt & Caching | 10 | 1 | 0 |
| Tool-Call Repair | 8 | 2 | 0 |
| Tool Execution | 10 | 3 | 0 |
| Providers | 8 | 2 | 0 |
| Reliability | 8 | 2 | 0 |
| Billing & Cost | 0 | 2 | 7 |
| Memory | 10 | 1 | 0 |
| Dreaming & Curation | 7 | 4 | 0 |
| Sessions & State | 4 | 3 | 4 |
| Multi-Agent & ACP | 3 | 6 | 2 |
| Gateway & Relay | 0 | 2 | 12 |
| Channels | 1 | 2 | 10 |
| Cron & Automation | 7 | 4 | 1 |
| Media & Voice | 10 | 2 | 0 |
| Web & Browser | 7 | 1 | 3 |
| Security | 4 | 2 | 3 |
| Surfaces & UX | 7 | 3 | 1 |
| i18n | 2 | 5 | 4 |
| Critic extras | 2 | 3 | 2 |

---

## ⭐ Top-tier: build now (★5 + strengthens the edge) — 47

- `RT-3` **Turn Prologue/Epilogue Extraction & Structured Lifecycle** _(M)_ — Structured turn prologue/epilogue lifecycle with testable plugin hooks and resource cleanup. Visible, testable turn lifecycle = visible reasoning chain. Crash-resilience and MCP refresh in prologue strengthen local reliability. Independent cleanup guards prevent silent data loss. Foundational to shows-its-work.
- `RT-4` **Context Compression Preflight Integration** _(L)_ — Proactive context compression with multi-pass estimation and silent-reset detection. Prevents silent context resets (data loss). Makes compression visible in turn timing instead of hidden in cleanup. Critical to grounding: you can't show your work if context silently compacts without surfacing what was dropped.
- `RT-6` **Message Sequence Repair & Cursor Sync** _(M)_ — Message sequence validation/repair, cursor sync, JSON repair for corrupted tool arguments. Data integrity is foundational to grounding. Prevents provider 400s and silent message loss. Crash-recovery requires correct sequences. If the agent can't trust what the model saw, shows-its-work becomes meaningless.
- `RT-9` **Agentic Loop Iteration Caps & Lane Timeouts** _(S)_ — Hard iteration cap (32 max) with graceful timeout and cleanup grace period. Small local models (gemma4) are prone to infinite loops on stubborn tools. Explicit cap + graceful cleanup strengthens reliability. Shows-its-work: iteration budget becomes visible, agent can surface 'hit iteration limit' as explanation.
- `RT-11` **Session & Checkpoint Persistence — Early & Late** _(M)_ — Early + late checkpoint persistence (pre-model + post-execution) with dedup tracking. Crash-resilience between user input and model call (prevents data loss). Late persist with cleanup prevents re-triggering loops. Essential to single-user reliability. Grounding depends on session integrity.
- `CMP-1` **Pluggable Context Compressor Registry & Metadata Binding** _(M)_ — Pluggable registry allowing runtime swapping of compression engines (LCM vs Ollama vs deterministic) with transparent fallback. A local agent MUST survive compression engine failures gracefully. Fallback-routing is essential plumbing that makes the local-model reliability binding non-negotiable. Strengthens deterministic grounding by preventing silent stuck sessions.
- `CMP-2` **Auxiliary Model Compression (Cheap Model Summarization)** _(M)_ — Auxiliary model (Ollama gemma4:12b) generates summaries of dropped context windows while main model stays on task. Single-user LOCAL agent using local Ollama cheaply. Keeping the main inference model unblocked while a cheap aux model summarizes is exactly the local-resource-constrained trade-off Muse needs. Directly supports local grounding.
- `CMP-3` **Media & Image Stripping During Compaction** _(M)_ — Strips multi-MB base64 images from old turns before context trim, preserving only the last image and text-only tail. Image re-shipment every turn is a silent token-cost multiplier that breaks local model reliability. Deterministic stripping is low-risk, high-value cleanup that makes compression deterministic and observable. Core to local-model efficiency.
- `CMP-4` **Tool Result Pattern-Matched Summarization (Pre-LLM Pruning)** _(M)_ — Deterministic 1-line summaries of tool results (terminal exit codes, file paths, counts) before LLM-based compression. Deterministic pattern-matched summaries preserve causality without invoking the auxiliary model. Pre-LLM pruning reduces expensive summary calls and makes context shape deterministic and auditable. Strengthens the grounding + shows-its-work edge.
- `CMP-5` **Token Budget Tail Protection with Envelope-Aware Counting** _(M)_ — Envelope-aware token counting for tool_use/tool_result pairs; includes overhead instead of undercounting parallel tool turns. Undercounting tool envelopes is a real bug (4-tool parallel: 73 reported vs 1090 actual). Fixing this prevents silent overflow and makes token budgeting deterministic. Core to compression reliability and grounding.
- `PC-1` **Three-Tier System Prompt Architecture with Session-Lifetime Caching** _(M)_ — Three-tier system prompt (stable/context/volatile) with per-session cache, rebuild only volatile on memory snapshots Foundation for prompt caching; keeps 70%+ of prompt stable per session enabling 25-50% cost reduction. Tiered design separates identity from dynamic memory, maintaining deterministic cache prefix for shows-its-work compliance.
- `PC-2` **Anthropic Four-Marker Cache Control Strategy with Fixed Breakpoints** _(M)_ — Apply cache_control=ephemeral markers on Anthropic system + last 3 messages at fixed breakpoints Concrete Anthropic API implementation achieving 75% cost reduction (50% system, 25% tail). Fixed 4-slot placement is auditable; enables transparent cost-tracking per session. Pairs with PC-1.
- `TCR-1` **Streaming reasoning/think block scrubber with boundary-aware stateful buffering** _(M)_ — Stateful scrubber for reasoning/think block leakage across streaming deltas from open models (Qwen, MiniMax, Kimi). Local Ollama models leak reasoning tokens mid-stream; scrubbing prevents corrupted context in the grounding loop. Deterministic, no cloud call.
- `TX-6` **Tool Approval Gate with Dangerous Command Detection** _(M)_ — Require explicit approval for dangerous commands/paths (credentials, /etc, .env*, SSH keys) Essential for local single-user safety: prevents credential leakage or dangerous mutations without human confirmation. Core guard for grounded, sandboxed operation.
- `TX-8` **Multimodal Tool Results Envelope** _(M)_ — Standardize multimodal tool results (images + text) with text-only fallback for local models Muse runs on Ollama gemma4 (text-only); multimodal envelope with fallback ensures vision tools don't break local execution. Grounding via explicit content handling.
- `TX-9` **Untrusted Tool Result Wrapping (Injection Defense)** _(S)_ — Wrap high-risk tool results (web pages, MCP) in semantic <untrusted> markers to signal input vs instruction Injection defense via explicit semantics rather than regex; improves local model's ability to treat external data as data, not executable. Shows work: 'this is untrusted input'.
- `PRV-1` **Thinking-Level Clamping & Token Budget Adjustment** _(M)_ — Thinking-level clamping and token budget adjustment for models with extended thinking support. Muse runs local gemma4:12b by default, but supports multi-provider fallback. Negotiating thinking levels keeps reasoning on/off configurable for each model family. Essential for graceful degradation when reasoning unavailable on fallback. Strengthens deterministic, model-aware tool selection.
- `REL-1` **Multi-Layer Error Taxonomy (27 categories)** _(M)_ — 27-category error taxonomy (auth/billing/rate_limit/context_overflow/etc.) with priority-ordered classification pipeline to choose recovery strategy. Deterministic error classification is FUNDAMENTAL to Muse's reliability. Shows its work by explaining WHY a retry/fallback/compression decision was made instead of silent retries. Essential for local agents hitting Ollama, Anthropic, or fallback providers.
- `MEM-1` **Streaming context-fence scrubbing for memory blocks** _(M)_ — Streaming scrubber that removes memory XML fence tags from streamed responses to prevent leakage. Direct grounding safety: prevents memory injection artifacts from poisoning user-visible output during streaming. Pure local infrastructure, no cloud dependency. Deterministic block-boundary checks strengthen Muse's "shows its work" edge.
- `MEM-2` **Pluggable memory-provider lifecycle with single-external constraint** _(L)_ — Abstract provider interface + manager allowing one builtin + one external memory backend swap. Enables local memory stack extensibility without rewriting agent. Single-external constraint keeps complexity bounded for local-only ops. Builtin episodic+knowledge backends form grounding foundation; external providers (Honcho, Mem0) optional. Core to personal-agent memory architecture.
- `MEM-3` **Recall prefetch with timeout circuit-breaker and prompt-style differentiation** _(M)_ — Async memory recall with circuit-breaker timeout and prompt-style modes to avoid blocking turns. Non-blocking recall directly improves local-agent responsiveness. Circuit-breaker prevents cascading failures on slow/down backends. Prompt-style modes let single user control precision/recall trade-off. Essential for practical memory UX on Ollama+local providers.
- `MEM-4` **Hybrid vector+keyword search with temporal decay post-merge** _(M)_ — Hybrid vector+keyword search with FTS fallback and temporal decay for memory recall. FTS fallback enables local-only memory search when embeddings unavailable (airgapped setup). Temporal decay is deterministic ranking logic showing recency weight. Embedding cache improves local turn latency. Grounding: why a memory ranks where it does is visible.
- `MEM-5` **Weighted consolidation scoring with phase-signal retroactive boosting** _(M)_ — Six-component consolidation scoring (frequency/relevance/diversity/recency/consolidation/conceptual) with phase-signal boosting. Deterministic multi-signal scoring explains WHICH memories get promoted and WHY (not a black-box LLM judgment). Phase signals enable passive offline strengthening without turn-blocking. Directly strengthens "shows its work" edge: weights transparent, concept tags derived locally.
- `MEM-6` **Markdown-organized daily memory with cron-driven dream narratives** _(L)_ — Daily markdown memory vault with cron-driven dream phase narratives auto-appended. Portable standard markdown (Obsidian-compatible) stored locally. Human-readable daily snapshots enable audit + manual refinement of memory state. Detached cron narrative avoids blocking turns. Shows work: why memories promoted is visible in daily records. Central to personal-companion UX.
- `MEM-9` **Embedding-provider adapter registry with local/remote transport dispatch** _(M)_ — Embedding provider registry routing local workers vs. remote APIs with dimension verification. Airgapped local-only operation enabled by local embedding transport (all-minilm-l6, nomic). Deterministic dimension verification prevents silent schema mismatches. Registry pattern enables swap without code change. Essential infrastructure for local memory grounding (hybrid search, consolidation scoring).
- `MEM-10` **Memory wiki/vault with compiled digest and contradiction detection** _(L)_ — Personal wiki vault (markdown) with compiled digest, claim tagging, and contradiction detection. Standard markdown vault (Obsidian-compatible) stored locally, human-editable. Contradiction detection surfaces semantic conflicts proactively—classic grounding defense. Compiled digest with confidence/freshness tagging shows work. Portable, no vendor lock-in. Central to personal knowledge representation.
- `CUR-1` **Skill lifecycle curator: inactivity-triggered auto-transitions** _(M)_ — Auto-retire inactive skills (active → stale → archived) on 30/90-day clocks without LLM decision. Deterministic curation keeps a personal skill library discoverable + tractable. Failure-soft, no cloud, directly addresses bloat in single-user agent. Strengthens grounding by keeping tool surface legible.
- `CUR-2` **Skill usage telemetry sidecar with provenance filter** _(M)_ — Telemetry sidecar (.usage.json) tracking per-skill use/view/patch counts for curator input. Deterministic, local-only tracking enables CUR-1. No cloud egress, atomic writes, provenance guards. Foundation for show-its-work curation (curator visible to user, not black-box).
- `SES-2` **Session State Machine: Reset Policy & Lifecycle Flags** _(M)_ — Boolean state machine (was_auto_reset, suspended, resume_pending) governing reset vs resume behavior Crash recovery + graceful resume prevents silent context loss, foundational for 'shows its work' guarantee. Deterministic state machine ensures user explicitly controls reset vs resume, not hidden surprises.
- `SES-3` **Crash Recovery & Resume Pending Marking** _(M)_ — On startup, detect unclean shutdown, mark recent sessions resumable, prevent infinite restart loops Automatic resume without /resume command improves UX; stuck-loop counter prevents system becoming unusable after crashes. Preserves transcript evidence even after catastrophic failures.
- `SES-10` **Atomically-Safe Session Store Persistence & Startup Restore** _(M)_ — Atomic write of sessionState.json with .clean_shutdown marker for crash-safe recovery Atomic I/O prevents transcript corruption on crash, essential for 'shows its work' guarantee. Corrupted session files = lost conversation history. Startup restore preserves mid-turn recovery without manual intervention.
- `ORC-1` **Persistent Event Ledger with Replay & Trimming** _(M)_ — SQLite event ledger for multi-step orchestration crash-recovery with trimming/replay. Single-user agent crash recovery is essential. Deterministic replay from ledger = grounding + work-visibility. Scales to local session count (200 sessions, 16MB) which is reasonable for one user.
- `CHN-13` **Context variables for concurrent session isolation** _(L)_ — Context variables for concurrent session isolation (per-task platform/chat_id/thread_id). Per-task context isolation is fundamental plumbing for ANY concurrent agent execution (cron jobs, webhooks, delegated sub-agents). Works even in pure-local Muse: enables multi-threaded tool runs and concurrent user interactions WITHOUT race conditions. Prevents state pollution across concurrent async boundaries. Single-user LOCAL agent absolutely benefits from this.
- `CRON-1` **Error Classification & Transient Retry Backoff** _(M)_ — Classifying cron job errors (rate_limit/timeout/server) + exponential backoff schedule. Deterministic error classification (regex patterns) + backoff logic are foundational reliability patterns for LOCAL cron runs. No cloud-specific fallbacks needed — Muse runs embedded agent turns, must recover gracefully from transient model/network failures.
- `MED-1` **TTS Persona System with Provider Overrides** _(M)_ — TTS voice personas with provider-specific voice overrides and binding tracking. Enables local TTS personalities (Piper voices, local Ollama TTS) with persistent user prefs, fully local and deterministic. Strengthens personal-agent identity differentiation without cloud deps.
- `MED-3` **Multi-Provider TTS Fallback with Voice Model Routing** _(M)_ — Multi-provider TTS fallback chain with automatic retry and attempt tracking. Core resilience: primary local TTS (Piper) fails → fallback to alternative local/cloud. Deterministic attempt logging shows its work. Strengthens single-user reliability.
- `WEB-1` **Pluggable Web Search Provider Architecture** _(M)_ — Pluggable registry for multiple web search providers (DuckDuckGo, SearXNG, Brave, Exa, Tavily, Firecrawl) Muse is local-first; pluggable providers with local fallbacks (Ollama, DuckDuckGo) prevent cloud lock-in and let small models choose efficient sources. Registry pattern enables honest provider-capability advertisement to the model.
- `WEB-4` **Provider Auto-Detection with Capability Gates** _(M)_ — Auto-detection of best provider per capability (search vs extract) with explicit-config-wins semantics Small model with 6+ providers available needs honest routing: explicit config wins, exact-match shortcut, preference fallback. Prevents silent cloud upgrade when user only enabled local search.
- `WEB-11` **Conformal Abstention for Web Search (Low-Confidence Containment)** _(M)_ — Conformal abstention for web search with snippet validation and low-confidence containment Core to Muse's 'shows its work' identity. Validates search results before returning (embedding relevance, domain age, recency). Prevents fabrication: if a snippet doesn't support the claim, model queries alternatives.
- `SEC-1` **URL credential redaction with sensitive query parameter detection** _(M)_ — URL query parameter credential redaction (token=, api_key=, x_amz_signature=) with Unicode splicing resistance Prevents secrets from leaking into logs/audit trails. Single-user agent needs clean observability without exposing credentials. Strengthens grounding (shows work without exposing secrets).
- `SEC-2` **SSL CA bundle preventive validation at startup** _(S)_ — SSL CA bundle validation at startup with clear error messages for misconfig Prevents opaque 30-minute failures deep in httpx. Early, clear error messages support Muse's 'shows its work' principle. Single-user local agent needs deterministic startup validation.
- `SEC-5` **Borrowed credential sanitization with fingerprinting at disk boundary** _(S)_ — Strip plaintext secrets from persisted credentials, store only sha256 fingerprint prefix Prevents credential plaintext on disk while preserving auditability. Core defense for single-user agent. Strengthens grounding (shows what keys were used without exposing them).
- `UX-2` **CLI Terminal Theme Auto-Detection & Contrast Engine** _(M)_ — Auto-detect terminal background color and choose readable ANSI palette (dark vs light, WCAG contrast). Essential for local CLI usability. Detects COLORFGBG/TERM_PROGRAM, no network. Prevents unreadable output across user terminal preferences. Pure deterministic logic, strengthens UX polish.
- `UX-3` **Markdown Code Block Detection & Copy-Safe Token Wrapping** _(M)_ — Preserve exact copy-pasteable text in code blocks and credentials; wrap long lines with zero-width spaces except CJK. Protects user ability to copy URLs/credentials/code without accidental insertion. Deterministic text partitioning. Strengthens 'shows-its-work': what user sees is what they get on copy.
- `I18N-8` **Embedded approval prompt + security-critical message separation** _(S)_ — Embedded approval prompt + security-critical message separation (i18n CLI but English agent output) CRITICAL for grounding/auditability: agent output stays English so reasoning is auditable and not corrupted by locale injection. Approval gates can be localized (UX), but agent responses must be invariant. Directly protects grounding edge.
- `X-3` **Crash-Safe Background Process Registry with Watch Patterns** _(M)_ — Crash-safe terminal process registry with watch patterns and recovery by PID. Terminal execution is core Muse tool. Surviving crashes + watch patterns (for builds/tests) add reliability + enable long-running monitoring deterministically. Essential local-agent infrastructure.
- `X-6` **Session-Scoped Conversation Recall with FTS5 & Windowing** _(M)_ — Full-text search over session history with FTS5, windowing, and zero LLM cost. Deterministic search + recall is core to grounding. Session-scoped FTS + zero LLM cost exemplifies 'shows its work' without cloud egress. Strengthens memory reliability for a local personal agent.

## ✅ All BUILD verdicts (121) — by independent priority


**★5**
- `RT-3` Turn Prologue/Epilogue Extraction & Structured Lifecycle _(M, core)_ — Structured turn prologue/epilogue lifecycle with testable plugin hooks and resource cleanup.
- `RT-4` Context Compression Preflight Integration _(L, core)_ — Proactive context compression with multi-pass estimation and silent-reset detection.
- `RT-6` Message Sequence Repair & Cursor Sync _(M, core)_ — Message sequence validation/repair, cursor sync, JSON repair for corrupted tool arguments.
- `RT-9` Agentic Loop Iteration Caps & Lane Timeouts _(S, core)_ — Hard iteration cap (32 max) with graceful timeout and cleanup grace period.
- `RT-11` Session & Checkpoint Persistence — Early & Late _(M, core)_ — Early + late checkpoint persistence (pre-model + post-execution) with dedup tracking.
- `CMP-1` Pluggable Context Compressor Registry & Metadata Binding _(M, core)_ — Pluggable registry allowing runtime swapping of compression engines (LCM vs Ollama vs deterministic) with transparent fallback.
- `CMP-2` Auxiliary Model Compression (Cheap Model Summarization) _(M, core)_ — Auxiliary model (Ollama gemma4:12b) generates summaries of dropped context windows while main model stays on task.
- `CMP-3` Media & Image Stripping During Compaction _(M, core)_ — Strips multi-MB base64 images from old turns before context trim, preserving only the last image and text-only tail.
- `CMP-4` Tool Result Pattern-Matched Summarization (Pre-LLM Pruning) _(M, core)_ — Deterministic 1-line summaries of tool results (terminal exit codes, file paths, counts) before LLM-based compression.
- `CMP-5` Token Budget Tail Protection with Envelope-Aware Counting _(M, core)_ — Envelope-aware token counting for tool_use/tool_result pairs; includes overhead instead of undercounting parallel tool turns.
- `PC-1` Three-Tier System Prompt Architecture with Session-Lifetime Caching _(M, core)_ — Three-tier system prompt (stable/context/volatile) with per-session cache, rebuild only volatile on memory snapshots
- `PC-2` Anthropic Four-Marker Cache Control Strategy with Fixed Breakpoints _(M, core)_ — Apply cache_control=ephemeral markers on Anthropic system + last 3 messages at fixed breakpoints
- `TCR-1` Streaming reasoning/think block scrubber with boundary-aware stateful buffering _(M, core)_ — Stateful scrubber for reasoning/think block leakage across streaming deltas from open models (Qwen, MiniMax, Kimi).
- `TX-6` Tool Approval Gate with Dangerous Command Detection _(M, core)_ — Require explicit approval for dangerous commands/paths (credentials, /etc, .env*, SSH keys)
- `TX-8` Multimodal Tool Results Envelope _(M, core)_ — Standardize multimodal tool results (images + text) with text-only fallback for local models
- `TX-9` Untrusted Tool Result Wrapping (Injection Defense) _(S, core)_ — Wrap high-risk tool results (web pages, MCP) in semantic <untrusted> markers to signal input vs instruction
- `PRV-1` Thinking-Level Clamping & Token Budget Adjustment _(M, core)_ — Thinking-level clamping and token budget adjustment for models with extended thinking support.
- `REL-1` Multi-Layer Error Taxonomy (27 categories) _(M, core)_ — 27-category error taxonomy (auth/billing/rate_limit/context_overflow/etc.) with priority-ordered classification pipeline to choose recovery strategy.
- `MEM-1` Streaming context-fence scrubbing for memory blocks _(M, core)_ — Streaming scrubber that removes memory XML fence tags from streamed responses to prevent leakage.
- `MEM-2` Pluggable memory-provider lifecycle with single-external constraint _(L, core)_ — Abstract provider interface + manager allowing one builtin + one external memory backend swap.
- `MEM-3` Recall prefetch with timeout circuit-breaker and prompt-style differentiation _(M, core)_ — Async memory recall with circuit-breaker timeout and prompt-style modes to avoid blocking turns.
- `MEM-4` Hybrid vector+keyword search with temporal decay post-merge _(M, core)_ — Hybrid vector+keyword search with FTS fallback and temporal decay for memory recall.
- `MEM-5` Weighted consolidation scoring with phase-signal retroactive boosting _(M, core)_ — Six-component consolidation scoring (frequency/relevance/diversity/recency/consolidation/conceptual) with phase-signal boosting.
- `MEM-6` Markdown-organized daily memory with cron-driven dream narratives _(L, core)_ — Daily markdown memory vault with cron-driven dream phase narratives auto-appended.
- `MEM-9` Embedding-provider adapter registry with local/remote transport dispatch _(M, core)_ — Embedding provider registry routing local workers vs. remote APIs with dimension verification.
- `MEM-10` Memory wiki/vault with compiled digest and contradiction detection _(L, core)_ — Personal wiki vault (markdown) with compiled digest, claim tagging, and contradiction detection.
- `CUR-1` Skill lifecycle curator: inactivity-triggered auto-transitions _(M, core)_ — Auto-retire inactive skills (active → stale → archived) on 30/90-day clocks without LLM decision.
- `CUR-2` Skill usage telemetry sidecar with provenance filter _(M, core)_ — Telemetry sidecar (.usage.json) tracking per-skill use/view/patch counts for curator input.
- `SES-2` Session State Machine: Reset Policy & Lifecycle Flags _(M, core)_ — Boolean state machine (was_auto_reset, suspended, resume_pending) governing reset vs resume behavior
- `SES-3` Crash Recovery & Resume Pending Marking _(M, core)_ — On startup, detect unclean shutdown, mark recent sessions resumable, prevent infinite restart loops
- `SES-10` Atomically-Safe Session Store Persistence & Startup Restore _(M, core)_ — Atomic write of sessionState.json with .clean_shutdown marker for crash-safe recovery
- `ORC-1` Persistent Event Ledger with Replay & Trimming _(M, core)_ — SQLite event ledger for multi-step orchestration crash-recovery with trimming/replay.
- `CHN-13` Context variables for concurrent session isolation _(L, core)_ — Context variables for concurrent session isolation (per-task platform/chat_id/thread_id).
- `CRON-1` Error Classification & Transient Retry Backoff _(M, core)_ — Classifying cron job errors (rate_limit/timeout/server) + exponential backoff schedule.
- `MED-1` TTS Persona System with Provider Overrides _(M, core)_ — TTS voice personas with provider-specific voice overrides and binding tracking.
- `MED-3` Multi-Provider TTS Fallback with Voice Model Routing _(M, core)_ — Multi-provider TTS fallback chain with automatic retry and attempt tracking.
- `WEB-1` Pluggable Web Search Provider Architecture _(M, core)_ — Pluggable registry for multiple web search providers (DuckDuckGo, SearXNG, Brave, Exa, Tavily, Firecrawl)
- `WEB-4` Provider Auto-Detection with Capability Gates _(M, core)_ — Auto-detection of best provider per capability (search vs extract) with explicit-config-wins semantics
- `WEB-11` Conformal Abstention for Web Search (Low-Confidence Containment) _(M, core)_ — Conformal abstention for web search with snippet validation and low-confidence containment
- `SEC-1` URL credential redaction with sensitive query parameter detection _(M, core)_ — URL query parameter credential redaction (token=, api_key=, x_amz_signature=) with Unicode splicing resistance
- `SEC-2` SSL CA bundle preventive validation at startup _(S, core)_ — SSL CA bundle validation at startup with clear error messages for misconfig
- `SEC-5` Borrowed credential sanitization with fingerprinting at disk boundary _(S, core)_ — Strip plaintext secrets from persisted credentials, store only sha256 fingerprint prefix
- `UX-2` CLI Terminal Theme Auto-Detection & Contrast Engine _(M, core)_ — Auto-detect terminal background color and choose readable ANSI palette (dark vs light, WCAG contrast).
- `UX-3` Markdown Code Block Detection & Copy-Safe Token Wrapping _(M, core)_ — Preserve exact copy-pasteable text in code blocks and credentials; wrap long lines with zero-width spaces except CJK.
- `I18N-8` Embedded approval prompt + security-critical message separation _(S, core)_ — Embedded approval prompt + security-critical message separation (i18n CLI but English agent output)
- `X-3` Crash-Safe Background Process Registry with Watch Patterns _(M, core)_ — Crash-safe terminal process registry with watch patterns and recovery by PID.
- `X-6` Session-Scoped Conversation Recall with FTS5 & Windowing _(M, core)_ — Full-text search over session history with FTS5, windowing, and zero LLM cost.

**★4**
- `CMP-6` Compaction Failure Reason Classification & Telemetry _(S, core)_ — Classify compaction failures (timeout, guard_blocked, summary_failed, provider_error) into stable telemetry buckets.
- `CMP-7` Iterative Compression Summary Updates (Cross-Compaction Coherence) _(M, core)_ — On subsequent compressions, regenerate summary with prior summary as context to preserve facts and add resolution updates.
- `CMP-8` Deterministic Fallback Summary & Cooldown (Auxiliary Unavailable) _(M, core)_ — Fallback to deterministic summary (paths, questions, TODOs) + 10-min cooldown when auxiliary model fails.
- `PC-4` Prompt Normalization for Cache Stability Across Platforms _(S, core)_ — Normalize prompt (CRLF→LF, trim trailing whitespace, dedup capability IDs) before hashing for cache keys
- `PC-5` Cache Boundary Stable/Dynamic Split with Plugin Safety _(M, core)_ — Split system prompt at marker, apply cache_control only to stable prefix, validate plugin hooks don't leak into cached zone
- `PC-6` Provider-Family Cache Retention Routing with Eligibility Gates _(M, core)_ — Route cache config per provider family (Anthropic→short/long, Gemini→API cache, OpenAI→none), default safely to no caching
- `PC-7` Context Compression Anti-Resume Directive _(S, core)_ — Prepend compression summary with directive: don't auto-resume old tasks, respond only to latest user message after summary
- `PC-8` Coding-Context Mode with Immutable Git Snapshot _(L, core)_ — Detect git state (branch, dirty, test failures) at session start, bake immutable snapshot into stable system prompt tier
- `TCR-2` Buffer-capped plain-text tool-call detection and promotion with multi-format support _(L, core)_ — Detect and promote plain-text tool calls (JSON bracketed, XML-ish) leaked by small models instead of structured events.
- `TCR-3` Surrogate and malformed-JSON sanitization with nested payload walking _(M, core)_ — Walk nested message fields sanitizing UTF-8 surrogates (U+D800–DFFF) and repairing malformed JSON in tool args.
- `TCR-6` Stateless multimodal tool-result envelope with untrusted-content semantic delimiters _(M, core)_ — Wrap high-risk tool results (web, MCP, browser) with <untrusted> delimiters to change model interpretation semantics.
- `TX-1` Exact-Signature Tool Call Deduplication _(M, core)_ — Track SHA-256 hashes of tool call signatures to detect and block identical repeated-failure patterns
- `TX-2` Idempotent-Tool No-Progress Loop Detection _(M, core)_ — Detect when idempotent tools (read_file, web_search) return identical results across turns—a genuine no-progress state
- `TX-3` Hard-Stop Guardrail Actions (Warn vs Block Staging) _(M, core)_ — Replace binary tool-failure blocking with graduated warn/block staging based on thresholds
- `TX-7` Tool Result Persistence & Context Window Budgeting _(L, core)_ — Persist large tool results to disk, return sha256 references to preserve context budget
- `TX-11` Tool Loop Failure Classification & Metrics _(M, core)_ — Classify tool failures (exit code, timeout, permission, network, parsing) instead of binary success/failure
- `PRV-2` Model Catalog Merging with Source Authority Tiers _(M, core)_ — Model catalog merging with source authority tiers (config > manifest > cache > provider-index).
- `PRV-5` Rate-Limit Detection & Automatic Failover to Fallback Models _(M, core)_ — Rate-limit detection and automatic failover to fallback models mid-turn.
- `REL-2` Per-Provider Rate Limit Tracking (4-bucket state) _(S, core)_ — Per-provider 4-bucket rate-limit tracking (req/min, req/hour, token/min, token/hour) with remaining-time calculations.
- `REL-6` Context-Scaled Tool Output Budget (binds budget to model window) _(M, core)_ — Context-scaled tool-output budgets (per-result and per-turn) that adapt to small models (65K-token Ollama).
- `MEM-7` Recall-hit vocabulary tagging with concept deduplication _(S, core)_ — Concept tagging + query-hash dedup + recall-day tracking for memory vocabulary analysis.
- `MEM-11` Prefetch fan-out with background sync scheduling and skill unwrapping _(M, core)_ — Background prefetch+sync executor with single-worker serialization and skill-unwrapping.
- `CUR-3` Skill bundles: Multi-skill YAML slash command aliases _(M, core)_ — Bundle multi-skills into reusable slash-command aliases (e.g., /backend-dev loads 3 skills).
- `CUR-5` Skill discovery & indexing: Multi-root + home-prefix normalization + symlink validation _(M, core)_ — Multi-root skill discovery + home-prefix normalization + symlink validation; skips support dirs.
- `CUR-8` Dreaming REM phase: Pattern extraction & reflection signals _(M, core)_ — REM sleep phase extracts pattern summaries + reflection signals from traces, writes DREAMS.md block.
- `SES-7` Task-Local ContextVar for Concurrent Message Processing _(S, core)_ — AsyncLocalStorage isolation for session context per concurrent task (sessionId, chatId, platform)
- `ORC-4` Native Subagent Lifecycle Mirroring with Transcript Polling _(M, core)_ — Parent agent tracking child agent completion via transcript polling with dedup.
- `ORC-5` Session Persistence with Provider & CWD Portability (Dual Hybrid) _(M, core)_ — Session state persistence with provider/cwd portability across restarts + forks.
- `CRON-5` Run Isolation with Watchdog Timeout & Lane-Aware Setup Detection _(L, core)_ — Isolation (watchdog, timeout, lane awareness) for concurrent cron job sessions.
- `MED-2` TTS Text Summarization with Model-Driven Truncation _(M, core)_ — TTS text summarization with optional ML-driven truncation for long outputs.
- `MED-4` Image Generation Provider Registry (Text-to-Image & Image-to-Image) _(L, core)_ — Image generation provider registry for text-to-image and image-to-image routing.
- `MED-6` Document Extraction with PDF Text + Scanned Image Fallback _(L, core)_ — PDF extraction with text-first, scanned image fallback for OCR.
- `MED-8` Structured Media Extraction (Vision + Text Schema) _(S, core)_ — Unified media extraction tool routing vision + text extraction with schema validation.
- `MED-12` Image Source Routing from Freeform Text (URL + Local Path Extraction) _(S, core)_ — Auto-extract image URLs and local file paths from user messages for vision routing.
- `WEB-2` Web Content Extraction with Per-URL Timeouts _(M, core)_ — Per-URL timeout and SSRF re-validation for web content extraction
- `WEB-3` Credential Resolution & Provider Config Hierarchy _(M, core)_ — Credential resolution hierarchy with non-blocking availability guards
- `WEB-5` Link Detection & SSRF Filtering (Bare URL Extraction) _(S, core)_ — URL extraction and SSRF filtering with markdown-link stripping
- `WEB-10` Web Provider Tool Registration & Context-Aware Routing _(M, core)_ — Tool registration dispatch for web providers with policy-gating
- `SEC-4` Credential source removal contract with per-source cleanup handlers _(M, core)_ — Credential source removal with per-source cleanup handlers (.env, auth.json, config suppression)
- `UX-1` Streaming Watchdog & Run Lifecycle Tracker _(M, core)_ — Streaming watchdog detects 30s+ response silence and emits user-visible notice; manages tool result lifecycle phases.
- `UX-4` Slash Command Dynamic Registry & Context-Aware Completion _(M, core)_ — Dynamic registry of slash commands with aliases and context-aware completion hints from skills.
- `UX-10` Chat History Component Pooling & Tool Lifecycle Tracking _(M, core)_ — Chat history component pooling and memory management for 100+ turn conversations; tool progress streaming.
- `I18N-10` Local-first LLM-assisted batch translation workflow _(L, core)_ — Local-first LLM-assisted batch translation workflow with Ollama gemma4 + sourceHash provenance

**★3**
- `PC-9` Subdirectory Lazy Discovery with Tool-Result Hints _(S, core)_ — On tool call, discover AGENTS.md/.cursorrules in visited dirs (max 8K, respect git boundaries), append as hints to tool result (not system prompt)
- `PC-10` Payload Policy Quota Enforcement for Anthropic Markers _(S, core)_ — Count existing cache_control markers, enforce Anthropic 4-marker ceiling, gracefully apply remaining quota to messages
- `PC-11` Provider-Specific Parameter Aliasing and Model Routing _(M, core)_ — Resolve cache/parallel/format config per provider with snake/camelCase aliasing; merge global/model-family/agent-specific config layers
- `TCR-4` Type-safe record and string coercion with optional/nullable semantics _(S, core)_ — Type-safe coercion functions for record/string inputs with defined null/undefined/empty semantics.
- `TX-4` Mutation-Safe Concurrent Tool Execution (Path Overlap Detection) _(L, core)_ — Parallelize non-overlapping tool calls (3 independent file edits) while preventing concurrent writes to same path
- `TX-5` Checkpoint & Snapshot Before Destructive Commands _(L, core)_ — Snapshot file state before destructive commands so agent can restore on error
- `PRV-3` Provider-Specific Model ID Normalization & Aliasing _(S, core)_ — Provider-specific model ID normalization and aliasing (deprecated names, casing, quantization tags).
- `PRV-4` Exponential Backoff Orchestration for Transient Errors _(M, core)_ — Exponential backoff with jitter for transient provider errors (connection reset, DNS timeout).
- `REL-3` One-Shot Recovery Guards (TurnRetryState pattern) _(S, core)_ — Per-turn retry state with 16 boolean guards to prevent same recovery from firing twice in one API call.
- `REL-5` Per-Agent Iteration / Step Budget (independent subagent budgets) _(M, core)_ — Independent iteration budgets for parent + subagents (90 parent, 50 subagent) with consume/refund semantics.
- `REL-7` Simple Error Kind Detection (refusal/timeout/rate_limit/context_length) _(S, core)_ — Lightweight error-kind detection (refusal/timeout/rate_limit/context_length) via keyword matching for fallback decisions.
- `REL-10` Provider-Specific Error Patterns & Nested Metadata Extraction _(M, core)_ — Provider-specific error pattern handling (Anthropic thinking-signature, llama.cpp grammar, OpenRouter metadata.raw unwrap).
- `CUR-4` Skill preprocessing: Template vars & inline shell expansion _(S, core)_ — Template substitution (${MUSE_SKILL_DIR}, ${SESSION_ID}) + inline shell expansion (!`bash`) in skills.
- `CUR-9` Dreaming shadow trial: Report-only QA before promotion _(M, core)_ — Shadow trial: report-only QA for dreaming candidates, never mutates MEMORY.md, feeds review signal.
- `CRON-3` Active Job Marker (Deduplication Token) for Re-entrant Runs _(S, core)_ — Deduplication token to prevent re-entrant cron jobs running twice in same process.
- `CRON-6` Session Lifecycle Reaper with Archive Retention _(M, core)_ — Archiving + deleting old cron job session transcripts to prevent unbounded store growth.
- `CRON-9` Active Cron Task Run Tracking & Graceful Cancellation _(M, core)_ — Tracking active cron runs + graceful cancellation on scheduler shutdown.
- `MED-5` Vision Analysis with Explicit Vision Provider Routing _(M, core)_ — Vision provider registry separate from main model for cost/latency optimization.
- `MED-9` Pluggable Provider Registry with Unsafe-Key Filtering _(S, core)_ — Shared pluggable registry base class with prototype-pollution defense.
- `MED-10` Media Understanding with Model-Hydrated Providers _(M, core)_ — Auto-wire vision-capable models as implicit media understanding backends.
- `UX-5` Input Burst Coalescing & Multiline Paste Merge _(S, core)_ — Coalesce rapid single-line paste submissions into one message; detect multiline paste with platform-aware timing.
- `UX-8` Tool Result Diff Rendering with Luminance-Aware Colors _(M, core)_ — Render file diffs with ANSI colors that respect terminal background luminance (dark/light).

**★2**
- `TCR-5` Graduated number coercion with bounds checking and Node timeout clamping _(S, core)_ — Graduated number coercion with strict grammars and timeout/epoch clamping.
- `TCR-8` Parallel tool-batch execution gating with path-overlap conflict detection _(S, core)_ — Detect file-path overlaps to gate parallel tool batch execution; parallelize safe independent operations.
- `PRV-6` Model Metadata Fetching with Tiered Disk+In-Memory Caching _(M, core)_ — Model metadata fetching with tiered caching (in-mem < 1h, disk cache < 1h, network, stale fallback).
- `PRV-8` Configured Model References & Fallback Validation _(S, core)_ — Configured model references validation at startup (detects typos, missing models).
- `PRV-9` Provider Prefix Stripping & Ollama Model:Tag Preservation _(S, core)_ — Provider prefix stripping and Ollama model:tag preservation (qwen:7b, model:q4_K_M).
- `REL-9` Jittered Exponential Backoff (decorrelated per-process) _(S, core)_ — Jittered exponential backoff with decorrelated seed (golden-ratio XOR global counter) to prevent thundering-herd on concurrent retries.
- `CRON-4` Cron Schedule Computation with LRU Expression Cache _(M, core)_ — LRU cache for parsed cron expressions to avoid re-parsing thousands of jobs.
- `CRON-12` Cross-Process File Lock for Multi-Instance Scheduler Pause _(S, core)_ — Cross-process file lock for multi-instance scheduler pause coordination.

**★1**
- `TCR-10` Message content extraction with heterogeneous text-key resolution _(S, core)_ — Extract text from heterogeneous message content structures (text/content/input_text/output_text/summary/thinking keys).

## ⛔ SKIP verdicts (51) — wrong for Muse or low value


**Agent Runtime**
- `RT-1` Thinking Block Error Recovery & Signature Stripping _(off-strategy)_ — Cloud API resilience (Anthropic-specific thinking blocks, reasoning token artifacts) is orthogonal to Muse's local-only model (Ollama gemma4). Coping with cloud API quirks doesn't strengthen local grounding.
- `RT-5` Per-Provider OAuth & Credential Pool Rotation _(off-strategy)_ — Multi-provider credential pooling + fallback to remote models directly violates MUSE_LOCAL_ONLY. Muse runs Ollama gemma4 locally; cloud provider fallbacks defeat single-user local identity. Cloud-scale resilience pattern.

**Billing & Cost**
- `BIL-1` Real-Time Account Usage Snapshots (Multi-Provider) _(off-strategy)_ — Billing/credits out of scope for single-user local Muse. Multimodal cloud-egress (fetching from Anthropic/OpenAI) violates MUSE_LOCAL_ONLY. Non-essential decoration—Muse agent works without account visibility.
- `BIL-2` Cache Token Breakdown in Cost Estimation (Cache-Read/Write Separation) _(off-strategy)_ — Cost tracking for billing is out of scope. If Muse did track local Ollama usage (deterministic, no cost), this would be plumbing; but framed for multi-provider cloud cost accounting—wrong use case.
- `BIL-3` Model Pricing Catalog with Provider API Fallback (Current Pricing) _(off-strategy)_ — Billing/pricing is out of scope. Cloud egress to fetch pricing from OpenRouter/LiteLLM violates MUSE_LOCAL_ONLY. Muse uses local Ollama (no pricing).
- `BIL-4` Escalating Usage Notices & Depletion Guards (Credit State Parsing) _(off-strategy)_ — Credit depletion, cloud billing alerts explicitly out of scope. Non-goal for single-user local agent running on local model.
- `BIL-5` Billing State & Monthly Caps Portal Fetch (Account Balance Display) _(off-strategy)_ — Fetching from cloud billing portal via OAuth, displaying balance/card/monthly-cap. This is hosted multi-tenant billing infrastructure—antithetical to Muse's single-user local identity. Non-negotiable out of scope.
- `BIL-6` Terminal Billing Client (Charge/Reload Endpoints) _(off-strategy)_ — Money-movement (charging, billing endpoint) explicitly out of scope. Muse is personal single-user local agent, not a billing system. HTTP client for charges is multi-tenant hosted logic.
- `BIL-8` Expensive Model Guardrail (Pre-Invocation Cost Warning) _(off-strategy)_ — Billing guardrail (cost thresholds, expense detection) is out of scope. Typo detection is generic, but context is money-oriented. Muse runs local model—pricing guardrails don't apply.

**Sessions & State**
- `SES-4` Multi-User Session Isolation & Shared Conversations _(off-strategy)_ — Multi-tenant multi-channel isolation (Discord groups, Slack threads, per-user DMs) is wrong for single-user local agent. Muse is one person, one device, one Ollama. This belongs in platform adapters if needed, not core.
- `SES-6` SessionSource & Dynamic System Prompt Injection _(off-strategy)_ — Multi-channel connector logic ('Slack no history API', 'Discord needs token'). Muse is LOCAL, not a gateway. Platform capabilities belong in adapters, not core system prompt. Core prompt describes agent role and grounding, not infrastructure.
- `SES-9` Async Delivery Capability Detection & Message Queuing _(off-strategy)_ — Async delivery routing and queue collapsing are multi-channel adapter concerns (Slack webhooks, Discord callbacks). Muse is single-user local with no remote delivery context or channel-hopping.
- `SES-11` Session Envelope & Last-Route Tracking for Delivery Context _(off-strategy)_ — Follow-up delivery routing across channels is multi-tenant gateway logic. Muse single-user agent has no 'originating platform', no background completions to re-route, no channel switching.

**Multi-Agent & ACP**
- `ORC-2` Multi-Endpoint Session Routing & Supervisor Orchestration _(off-strategy)_ — Solves cloud-scale load-balanced worker pool problem ('large-scale orchestrations where worker instances may be load-balanced'). Muse is single-user local; multi-endpoint routing is hermes/openclaw territory (hosted gateway model). No local use-case.
- `ORC-7` Auxiliary Provider Fallback Chain with Credit-Exhaustion Recovery _(off-strategy)_ — Designed for cloud-scale multi-provider billing ('when main provider runs out of credits'). Muse locally runs one model (gemma4); auxiliary compression is optional. Cloud provider credit tracking + fallback is out-of-scope for local agent. Vision task override is useful but orthogonal.

**Gateway & Relay**
- `GW-1` Multi-instance relay bus with per-tenant routing _(off-strategy)_ — Muse is single-user local; this solves multi-tenant, multi-instance cloud gateway scaling. Relay architecture, Redis pub/sub, per-tenant routing are entirely off-strategy.
- `GW-2` Paired device/node identity & token lifecycle with role-scoped access _(off-strategy)_ — Multi-device ecosystem with role-bound tokens is for hosted multi-user systems. Muse local agent needs no device pairings or role hierarchies.
- `GW-3` Pairing-code generation with lockout & rate-limiting (8-char unambiguous alphabet) _(off-strategy)_ — Pairing codes for multi-user/multi-device enrollment. Single-user Muse has no enrollment flow; this is hosted-system infrastructure.
- `GW-4` Relay WebSocket transport with authenticated upgrade & full-duplex pipelining _(off-strategy)_ — Symmetric WebSocket relay between hosted gateway and cloud connector. Local Muse has no relay or outbound egress to cloud infrastructure.
- `GW-5` CapabilityDescriptor handshake for dynamic platform adaptation _(off-strategy)_ — Handshake protocol between relay gateway and connector for multi-platform negotiation. Local Muse has no relay connector.
- `GW-7` Trust boundary & capability vault architecture (connector is sole crypto/identity boundary) _(off-strategy)_ — Multi-tenant credential vault in cloud connector. Local Muse runs offline with no cloud infrastructure; secrets stay on user's machine.
- `GW-8` Device & node pending-work queue with wake signaling & expiry _(off-strategy)_ — Work queue for waking paired devices and IoT nodes. Single-user Muse has no paired devices or mobile/IoT ecosystem.
- `GW-9` Setup-code pairing with URL resolution & network preference (local/remote/public) _(off-strategy)_ — Multi-device pairing with Tailscale URL negotiation. Local Muse has no pairing flow or multi-device enrollment.
- `GW-10` Pairing-store atomic writes with file locking (per-channel, 10 retries, 30s stale timeout) _(off-strategy)_ — Persistent pairing-request store for device enrollment workflow. Irrelevant to single-user local agent.
- `GW-11` Device pairing metadata tracking & device family detection with notification subscriptions _(off-strategy)_ — Tracks enrolled devices, notifications per chat channel, subscriber subscriptions. Multi-device and channel-sprawl patterns incompatible with local Muse.
- `GW-12` Node-capability token minting & scoped HTTP routes (path-scoped tokens via /__openclaw__/cap/<token>) _(off-strategy)_ — Capability tokens for paired nodes to access plugin surfaces. Multi-device architecture not applicable to local single-user Muse.
- `GW-13` Multi-tenant relay endpoint & route-key provisioning (gateway self-registers with connector) _(off-strategy)_ — Self-provision gateway with cloud relay connector. Multi-instance, multi-tenant cloud scaling incompatible with local Muse architecture.

**Channels**
- `CHN-1` Keyed inbound message debouncing with same-key serialization _(off-strategy)_ — Multi-channel/multi-user routing is inherently multi-tenant. Muse is single-user local; message debouncing applies only if serving multiple concurrent streams (cron jobs, webhooks, delegated sub-agents). This is infrastructure for channel platforms, not grounding.
- `CHN-2` Channel conversation binding & outbound session routing _(off-strategy)_ — Multi-account thread binding and per-account session routing is a gateway/multi-tenant concern. Muse runs locally for ONE user, not managing accounts across different channels. Session routing is infrastructure for hosted agents.
- `CHN-3` Slack-style thread ownership coordination _(off-strategy)_ — Prevents multi-agent collision in shared spaces. Muse is NOT multi-agent or multi-tenant. This is a feature for hosted platforms where multiple agents compete for the same channel/thread. No relevance to local personal companion.
- `CHN-4` Multi-transport message actions with lazy module loading _(off-strategy)_ — Channel-specific actions (Slack, Discord, Telegram) are plumbing for multi-platform gateways. Even lazy loading doesn't fix the strategic mismatch: Muse is NOT a multi-channel relay. LocalLLM + single user + local tools is the edge.
- `CHN-7` Streaming & progress-draft formatting with mode normalization _(off-strategy)_ — Per-channel capability tuning (Slack blocks vs Telegram text vs Signal limits) is multi-platform gateway plumbing. Muse local-only agent doesn't TARGET different platforms; this is infrastructure for hosted multitenancy.
- `CHN-8` Typing indicator lifecycle with keepalive & TTL _(off-strategy)_ — Typing indicators are platform-specific UX (Slack/Discord/Telegram). Muse LOCAL agent doesn't interact with remote platforms. No relevance unless channels become in-scope; then minor plumbing.
- `CHN-9` Platform adapter base with thread metadata & media routing _(off-strategy)_ — Platform-aware threading and media encoding (Telegram UTF-16 truncation, Signal no-threading) is multi-platform gateway infrastructure. Single-user local Muse doesn't abstract over multiple platforms.
- `CHN-10` Delivery target parsing & routing with fallback _(off-strategy)_ — Delivery target parsing with platform routing is inherently multi-channel gateway plumbing. Muse single-user local agent doesn't route to external platforms. If local channels ever become in-scope, revisit.
- `CHN-11` Session mirroring for cross-platform message audit trail _(off-strategy)_ — Mirroring is plumbing for cross-platform multi-tenant audit. While audit is good, this ASSUMES agents are sending to external platforms, which contradicts Muse LOCAL-ONLY identity. Audit of LOCAL agent is different.
- `CHN-12` Channel directory with friendly-name overlays and auto-refresh _(off-strategy)_ — Channel discovery and aliasing is plumbing for multi-platform gateways (Discord, Slack, Telegram directories). Muse LOCAL agent doesn't enumerate or send to remote channels. No fit.

**Cron & Automation**
- `CRON-10` Distributed Scheduler Lock with PostgreSQL Upsert _(off-strategy)_ — Multi-pod, distributed lock, PostgreSQL backend — this is HOSTED/CLOUD infrastructure scaling. Muse is LOCAL single-instance. Distributed scheduler lock is a cloud-scale gateway feature (hermes/openclaw multi-tenant), not for embedded LOCAL Muse.

**Web & Browser**
- `WEB-7` Manifest-Driven Provider Discovery & Trust Boundaries _(off-strategy)_ — Muse is single-user local. Multi-tenancy (managed agents, sandbox filtering, verified-official separation) is openclaw/hermes territory. Single-user doesn't need trust boundaries between plugin origins.
- `WEB-8` Cloud Browser Session Lifecycle Management _(off-strategy)_ — Cloud browser sessions, managed billing, Nous gateway relay—all multi-tenant/hosted. Muse runs locally; CDP connections are direct to user's Chrome. 'Stateful cloud session' is not local.
- `WEB-9` Dual-Auth Gateway Routing (Direct vs. Managed Provider) _(off-strategy)_ — Nous gateway is a multi-tenant relay for billing aggregation. Muse users call providers directly (or not at all). Single-user agent has no 'managed billing account' to route through.

**Security**
- `SEC-3` Persistent credential pool with multi-strategy selection and refresh sync _(off-strategy)_ — Designed for multi-provider concurrent-access scenarios (hermes credential_pool.py, concurrent process sync). Muse is single-user, single-local-model. Not applicable to Ollama gemma4:12b setup.
- `SEC-7` Secret-scoped credential resolution with context variables (multi-profile isolation) _(off-strategy)_ — Explicitly designed for multi-tenant gateway: 'Multi-tenant gateway running N profiles in one process.' Muse is single-user, single profile. Entire feature is multi-tenant isolation plumbing.
- `SEC-8` Gateway config audit findings with bind/auth/SSRF risk classification _(off-strategy)_ — Explicitly for multi-user gateway: 'attack surface for multi-user deployments.' Muse is single-user, runs locally, no HTTP binding/auth/proxy complexity. Not applicable.

**Surfaces & UX**
- `UX-9` Subagent Status Normalization & Real-Time Event Gateway _(off-strategy)_ — Designed for multi-tenant hosted gateway (real-time events, subagent delegation across boundaries). Muse is single-user local; no subagent network, no event relay. Off-strategy.

**i18n**
- `I18N-2` Lazy-loaded locale modules with bundle-size optimization _(adjacent)_ — Bundle optimization is a micro-optimization for web. Muse is CLI-first + single-user local agent; bundle size (en+ko) is irrelevant to core functionality. Adds complexity for negligible value.
- `I18N-6` Scoped translator factory for component-level prefixing _(off-strategy)_ — Design-system / multi-component pattern for large scale UI. Muse is single-user local CLI + minimal web UI; scoped translator adds abstraction for problem Muse doesn't have (dozens of provider setup flows). Premature architecture.
- `I18N-7` Installable locale paths via environment override + sysconfig fallback _(off-strategy)_ — Solves Hermes' multi-deployment problem (pip wheels, Nix, Docker). Muse is single-user local with no package distribution strategy yet. Premature packaging optimization; revisit after actual distribution model chosen.
- `I18N-9` React controller / reactive component integration pattern _(off-strategy)_ — Lit component pattern is for design-system scaling. Muse is not using Lit. If Muse adds design-system shared with OpenClaw, this is a pre-fabricated pattern; not urgent now.

**Critic extras**
- `X-2` Progressive Tool Deferral with Stateless Bridge _(off-strategy)_ — Designed for multi-tenant scale (catalog drift in 100+ channel systems). Muse's local catalogs are small; tool pruning trades precision for tokens. Catalog stability is better than deferral.
- `X-5` Web Provider Abstraction with Plugin Routing _(off-strategy)_ — Contradicts MUSE_LOCAL_ONLY mandate. Firecrawl/Exa/Tavily are cloud-scale paid services. Framing mentions 'Nous Subscribers' → multi-tenant hosted design. Local web tools (curl, browser) are Muse's path.

## 🟡 MAYBE verdicts (59) — conditional / lower priority


**Agent Runtime**
- `RT-2` Streaming Callback Binding for Prefetch — Nice UX optimization but divorced from core edge (shows-its-work grounding). A single-user local agent can tolerate TTS delay. Adds complexity for latency win that multi-tenant systems care about more.
- `RT-7` System Prompt Caching & Prefix Stability — Anthropic-specific cache optimization (prompt caching isn't native to Ollama). Useful for cloud models but not foundational to local grounding. Local caching could be useful but is secondary optimization.
- `RT-8` Failover Decision Matrix & Stage-Aware Routing — Error classification is useful, but routing assumes multi-provider fallback (off-strategy). Local-only agent doesn't fall back to cloud. Could be salvaged as local error-type routing, but as written assumes cloud fallback.
- `RT-10` Interrupt Semantics & Per-Thread Scoping — Useful for background tasks / concurrent execution, but Muse is single-user with no mention of multi-task architecture. Per-thread scoping is premature until background tasks become core. Useful infrastructure if added later.
- `RT-12` Usage & Cost Tracking — Reasoning & Cache Tokens — Cloud billing concern (not single-user local). Reasoning tokens are Anthropic-specific; Ollama doesn't report them. Observability useful but secondary. Cost-status gating is multi-tenant entitlement logic.

**Context Compaction**
- `CMP-9` Context Reference Injection with Budget Gating (@file, @folder, @git) — Budget gating is necessary plumbing IF @references exist in Muse. Without evidence that Muse has @reference syntax, this is speculative. Hard limit prevents overflow, but the reference syntax is user-facing design, not grounding.
- `CMP-10` Thread Bootstrap Projection & Persistent Context Reuse — Thread-bootstrap caching optimizes long-running sessions but assumes Muse has multi-threaded execution model. If single-task, this is premature optimization. Dual-authority is defensive but adds complexity. Low priority without proof of multi-thread sessions.
- `CMP-11` Session Rotation & Transcript Succession (Archive-First Design) — Archive-first design is sound operational UX (prevents unbounded files). Session-ID rotation signals shape changes. But this is post-compaction lifecycle plumbing, not core to local grounding. Useful, low risk, but not essential.
- `CMP-12` Deferred Background Maintenance (Turn Latency Isolation) — Latency isolation is valuable if Muse uses expensive engines (LCM). But background task scheduling is plumbing that works equally well for any engine. Not specific to local grounding; useful if LCM is confirmed, otherwise speculative.

**Prompt & Caching**
- `PC-3` Google Prompt Cache Session Metadata Tracking — Serves cloud provider (Gemini), not local Ollama default. Real feature but off core local-single-user identity. Conditional on whether Gemini fallback is strategic priority.

**Tool-Call Repair**
- `TCR-7` Stream diagnostic headers and exception-chain flattening for retry logging — Useful observability for debugging transient failures, but not core to local agent functioning. Header capture is best-effort; exception flattening has value for crash recovery.
- `TCR-9` LM Studio reasoning-effort mapping with capability-aware clamping — LM Studio-specific capability negotiation. Nice to have for local-model flexibility, but low priority — only needed if LM Studio is primary. Not core to Muse identity.

**Tool Execution**
- `TX-10` Per-Thread Interrupt & Cancellation Tracking — Useful only if Muse implements concurrent tool dispatch. Today Muse is single-user, not multi-threaded. Prerequisite for TX-4, useful if threading added but not urgent.
- `TX-12` Tool Pre-Call Middleware & Plugin Hooks (Request Modification) — Useful for policy enforcement (team/sandbox rules), but Muse is single-user. If policies needed later (e.g., restricted tool sets), this is the right foundation. Not urgent today.
- `TX-13` Context-Scoped Session State (Approval, Terminal CWD, Environment) — Relevant only for concurrent multi-agent runs. Muse is single-user, not multi-tenant. Nice-to-have if threading added (TX-4 enabler), but not core today.

**Providers**
- `PRV-7` OpenAI-Compatible Endpoint Capability Detection & Auto-Adaptation — Muse's primary identity is local Ollama. OpenAI-compatible endpoints (Together, z.ai) are fallback/external. Auto-adaptation reduces per-model hardcoding, but adds complexity for users who stay local. Low priority unless multi-provider story becomes central.
- `PRV-10` Request Context Token Estimation for Timeout Detection — Timeout detection is important for reliability, but 'stale call' implies multi-turn streaming or connection pooling. Muse's default one-shot tool calls are simpler. Useful for long-running sessions but lower priority than core provider logic.

**Reliability**
- `REL-4` Cross-Session Rate Limit Breaker (Provider Saturation Detection) — Useful for multi-provider resilience, but OpenRouter (multi-upstream) is NOT Muse's default deployment. Muse is Ollama-first + optional Anthropic fallback—simpler 2-provider circuit logic would suffice. Implementable as plumbing but lower priority than core error classification.
- `REL-8` Diagnostic Request ID Extraction & Hashing (PII-safe tracing) — Useful for support debugging, but Muse is single-user + local-first. PII-safe tracing is better suited to multi-tenant hosted services. Optional observability enhancement; not core to reliability.

**Billing & Cost**
- `BIL-7` Per-Session Cost Tracking & Daily Breakdown (Session Cost Cache) — If Muse supported multi-provider fallback (local or remote), per-session usage tracking would help agent introspection. But framed around cost tracking/billing optimization—that's out of scope. The caching mechanism (fingerprints, JSON checkpoint) is sound; purpose is wrong.
- `BIL-9` Billing Error Attribution (Provider + Model Context in Error Messages) — Error context (provider+model) is useful for any multi-provider fallback. But this is billing-error-specific (credit errors, etc.)—out of scope. Generic error decoration would be useful; billing semantics are not.

**Memory**
- `MEM-8` Session-scoped usage insights with cost estimation and activity patterns — Self-serve token tracking is valuable for local budget awareness. However, this is observability plumbing, not core memory. Cost tracking is peripheral to Muse's grounding edge. Activity patterns are nice-to-have for engagement but not essential to memory or personal-agent identity. Lower fit than core memory features.

**Dreaming & Curation**
- `CUR-6` Skill file watching & snapshot versioning for runtime refresh — Useful UX (no restart needed after skill edit), but lower priority than curator logic. Deduped watchers save FDs, which is nice but not load-bearing for local grounding. File watching is plumbing, not core edge.
- `CUR-7` Skill workshop: Proposal lifecycle (draft → apply → rollback) — Safe concurrent skill authoring is valuable for multi-agent local setups, but effort:L and priority:2 in original. Rollback snapshots help, but lower priority than curator + usage tracking. Deferred if constraints are tight.
- `CUR-10` Active Memory: Circuit breaker + bounded context injection with tool allow-list — Useful resilience, but subagent architecture + bounded injection is plumbing for memory system. Circuit breaker is good, but not load-bearing for single-user grounding edge. Defer after core curator + CUR-8/9.
- `CUR-11` Skill contract versioning & re-read detection in prompts — Version hash + re-read policy prevents stale skill instructions. Token-efficient. Good for multi-turn robustness, but lower priority than curator + usage + bundles. Effort:S makes it worth doing as a refinement post-core work.

**Sessions & State**
- `SES-1` Deterministic Session Key Generation & Normalization — Session key consistency is housekeeping, not grounding. Proposal is sized for multi-channel platforms (Discord, Signal, Matrix) but Muse is single-user local—transcript lookup via timestamp+uuid is simpler. Effort M oversized for single-device scenario.
- `SES-5` Background Session Expiry Watcher & Resource Cleanup — Memory-management plumbing. Useful for long-lived background agents (cron jobs), but Muse single-user workload rarely has unbounded session explosion (no multi-tenant scaling threat). Lower priority than crash recovery.
- `SES-8` Session Lifecycle Events Broadcasting — Nice-to-have for plugin extensibility and decoupling, but Muse lacks plugin ecosystem yet. State-machine changes could be logged directly. Conditional value pending Muse plugin roadmap. Effort S is cheap but priority is low today.

**Multi-Agent & ACP**
- `ORC-3` ACP Gateway Bridge with Session Routing & Replay Fallback — Bridges local Muse to ACP editors — useful but adds channel-sprawl (Muse now serves VSCode, Zed, web clients). Depends on ORC-1 ledger. Core value is editor integration, not single-user grounding. Not off-strategy but lower priority than core agent reliability.
- `ORC-6` Async-First ACP Stdio Transport with Thread Pool Isolation — Solves VSCode/browser async driver integration but is plumbing for ORC-3 (editor channel). Useful for editor responsiveness, not core to local single-user grounding. Dependency on ACP adoption.
- `ORC-8` ACP Policy & Dispatch Control with Agent Allow-List — Useful policy engine if ACP support is adopted (ORC-3), but adds config complexity. Single-user doesn't need agent allow-list (no untrusted agents). Low priority unless ACP is first-class feature.
- `ORC-9` Permission Relay Bridge (Approval Gating & User Confirmation) — Valuable safety gate (approval before dangerous tool calls) but is ACP-specific plumbing. Muse already has approval gates for dangerous commands (TX-6). Benefit is UX (approve in editor vs dialog); marginal over existing approval-policy.ts.
- `ORC-10` Content Block Multimodal Conversion (Unified Adapter) — Required for ACP multimodal support (ORC-3 dependency). Single conversion point is good engineering but scope is limited to editor integration. Not core to local agent grounding.
- `ORC-11` Session Lineage & Identity Tracking (Provisional → Resolved) — Session resume verification is useful (avoid exposing stale IDs) and per-session model override is grounded. But scope is ACP-specific state tracking. Useful if ORC-3/ORC-5 adopted, not essential for local single-user.

**Gateway & Relay**
- `GW-6` Session-scoped context variables for concurrent async handlers (ContextVar not global env) — ContextVar pattern is sensible for isolation; framed for multi-session gateways. Single-session Muse doesn't need session-scoped context at this complexity.
- `GW-14` Interrupt routing & session-scoped task cancellation (per-session Event, not global) — Per-session task cancellation is sound; framed for connector→gateway coordination. Local Muse doesn't need relay interrupt routing.

**Channels**
- `CHN-5` Presentation-layer status reactions with debounce & TTL — Status indicators are UX-nice but not core to local grounding. Useful IF Muse ever supports channels (e.g., local Slack/Discord integration). For pure single-user local use, reaction status is cosmetic. Could wait until channel support is in scope.
- `CHN-6` Plugin-native message sent hook emission — Hook emission is generic plumbing useful for auditing/metrics. Not off-strategy, but only valuable IF channels/outbound messaging is enabled. For pure local agent, this is low-priority infrastructure.

**Cron & Automation**
- `CRON-2` Separate Failure Alert Routing with Cooldown — Useful for multi-channel deployments, but Muse is single-user LOCAL — one person, one alert destination (console/log/UI popup). Cooldown itself is good (avoid spam), but separate routing is plumbing for hosted multi-channel ops (slack/discord/email selection), not core to local grounding.
- `CRON-7` Committed Work Extraction with Batched Async Review — Commitment detection (learning user's unstated preferences) is interesting for personal agent, but relies on optional auxiliary LLM + batched async review. Useful enhancement, not core. Low-priority compared to reliability guarantees.
- `CRON-8` Cron Job Suggestions (Catalog/Blueprint/Usage/Integration Sources) — UI/UX feature — helps users auto-discover jobs rather than typing JSON. Dedup + dismissal latch is reasonable. But not core to grounding/shows-its-work; it's proactivity + consent-first acceptance (adjacent to personal agent, not essential).
- `CRON-11` Parallel Job Classification & Urgency Filtering Script — Utility script for noise reduction (suppresses low-urgency results). Interesting but not load-bearing — optional polish. Auxiliary LLM + filtering pattern is generic plumbing, not specific to Muse identity or grounding.

**Media & Voice**
- `MED-7` Real-time Transcription WebSocket Transport with Reconnection — Powers voice-mode conversation, but WebSocket implies cloud provider (Anthropic, OpenAI, etc.). Local transcription (Whisper.cpp) doesn't need this stateful machinery. Low priority unless voice mode is central to Muse identity.
- `MED-11` Talk Session State & Real-time Voice Output — Enables duplex voice interaction (listen+speak concurrently), but requires voice-first UX which is orthogonal to Muse's core local-grounded identity. Valuable only if voice becomes primary mode.

**Web & Browser**
- `WEB-6` Search Provider Tool Schemas & Setup Flow — Useful for operator onboarding but not core to agent capability. UX polish; lower priority. Could be deferred if provider auto-detection works well.

**Security**
- `SEC-6` File safety guardrails with soft write/read denylists and cross-profile awareness — Core path denylists are essential for single-user agent safety. But cross-profile detection is multi-user concern. Build the path guards; deprioritize cross-profile logic.
- `SEC-9` Proxy capture with MITM CA and body preview recording for test fixtures — Testing infrastructure, not core agent. Useful for deterministic test fixtures but not user-facing. Low priority unless test reliability becomes blocker.

**Surfaces & UX**
- `UX-6` Auto-Title Generation (Background LLM, Non-Blocking) — Nice-to-have convenience but not load-bearing. Requires auxiliary model call in background (Ollama compatible, OK), but adds plumbing for non-core UX. Skip for MVP, revisit after core surfaces work.
- `UX-7` First-Touch Onboarding Hints & Atomic Config Persistence — Helps new users learn Muse capabilities. Atomic YAML writes prevent corruption. But onboarding is nice-to-have; core agent reliability comes first. Low priority unless user retention data justifies.
- `UX-11` MCP Hook Installation Security Scanner — Security validation for hook installation is good practice, but low impact for single-user local agent. Assumes npm-based hooks (not Muse-native). Nice-to-have, low priority.

**i18n**
- `I18N-1` CLI approval/messaging prompts localization — Localized approval gates + CLI messages improve UX friction, but don't strengthen grounding/citation edge. Core value is UX polish for non-English users. Muse already supports English-only for core reasoning; this is optional polish.
- `I18N-3` Multi-level language normalization with alias mapping — Improves UX by accepting colloquial language input. Useful if supporting non-English users, but not core to Muse's personal-agent grounding. Is plumbing that enables I18N-1 to work smoothly.
- `I18N-4` Catalog parity testing with placeholder validation — Quality gate for i18n data integrity. Only necessary if shipping multiple locales. Generic testing infrastructure; low urgency if Muse is English-primary.
- `I18N-5` Config-driven language + LRU caching for hot paths — Enables language persistence across runs. Solid infrastructure pattern but only valuable if supporting non-English users. Muse is single-user local; caching/config complexity is low ROI if English-primary.
- `I18N-11` YAML-based flat catalog with nested readability — Good infrastructure choice (YAML readable for translators, flattened at load-time). But only essential if shipping multiple locales. Generic i18n plumbing; not core to grounding.

**Critic extras**
- `X-1` Realtime Voice Consult Integration for Muse — Voice I/O is genuinely local-friendly but is a UX modality, not a grounding edge. Subagent delegation (X-4) is more fundamental. Voice-first workflows are real but low-priority vs core reasoning reliability.
- `X-4` Daemon Executor for Async Subagent Delegation — Subagents exist but are not central to single-user grounded reasoning. Async execution is useful for UX but doesn't strengthen the core edge (shows-its-work + local model reliability).
- `X-7` Local Voice I/O with Adaptive Silence Detection — Voice is a useful input/output modality for accessibility but not a grounding edge. Local-first is good but cloud fallback goes against MUSE_LOCAL_ONLY. Lower priority than terminal reliability or memory search.
