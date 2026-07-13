/**
 * Public types and option shapes for `AgentRuntime`. Pulled out of
 * `agent-runtime.ts` so the implementation file stays focused on the
 * runtime class itself — the interface surface is large enough
 * (40+ option fields, the tool-approval gate hooks, the stream-event
 * union) that mixing it with the class body crowded the reader.
 *
 * `agent-runtime.ts` re-exports every symbol here so existing
 * consumers (the `@muse/agent-core` barrel + tests) keep working
 * through the historical path.
 */

import type { CacheMetricsRecorder, ResponseCache } from "@muse/cache";
import type {
  ModelEvent,
  ModelProvider,
  ModelProviderRegistry,
  ModelToolCall
} from "@muse/model";
import type { AgentMetrics, MuseTracer, TokenUsageSink } from "@muse/observability";
import type { ExemplarRetriever, PromptLayerRegistry } from "@muse/prompts";

import type { ToolCallMiddleware } from "./tool-call-middleware.js";
import type { PersonaRegister } from "./conversational-register.js";
import type { CircuitBreaker, FallbackStrategy, RetryOptions } from "@muse/resilience";
import type {
  AgentRunHistoryStore,
  CheckpointStore,
  HookTraceStore
} from "@muse/runtime-state";
import type {
  ContextReferenceStore,
  ConversationSummaryStore,
  ConversationTrimOptions,
  DroppedContextSummarizer
} from "@muse/memory";
import type { GuardBlockRateMonitor } from "@muse/policy";
import type {
  EgressDecisionKind,
  ToolExecutor,
  ToolExposurePolicy,
  ToolRegistry
} from "@muse/tools";

import type { ActiveContextProvider } from "./active-context.js";
import type { AmbientSnapshotProvider } from "./ambient-context.js";
import type { VetoAvoidanceProvider } from "./veto-avoidance.js";
import type { PlaybookProvider } from "./playbook.js";
import type { PlanCacheProvider } from "./plan-cache.js";
import type { EpisodicRecallProvider } from "./episodic-recall.js";
import type { HookRegistry } from "./hook-registry.js";
import type { InboxContextProvider } from "./inbox-context.js";
import type { PlanStep } from "./plan-execute.js";
import type { SkillCatalogProvider } from "./skills-context.js";
import type { ToolExemplar } from "./tool-exemplars.js";
import type { TelemetryAggregator } from "./telemetry-aggregator.js";
import type { ToolFilter } from "./tool-filter.js";
import type {
  AgentSpecResolver,
  GuardStage,
  HookStage,
  OutputGuardStage,
  ResponseFilterStage,
  UserMemoryInjectionOptions,
  UserMemoryProvider
} from "./types.js";

export interface AgentRuntimeOptions {
  readonly modelProvider?: ModelProvider;
  readonly modelRegistry?: ModelProviderRegistry;
  readonly agentSpecResolver?: AgentSpecResolver;
  readonly historyStore?: AgentRunHistoryStore;
  readonly checkpointStore?: CheckpointStore;
  readonly hookRegistry?: HookRegistry;
  readonly hookTraceStore?: HookTraceStore;
  readonly responseCache?: ResponseCache;
  readonly cacheMetrics?: CacheMetricsRecorder;
  readonly guardBlockRateMonitor?: GuardBlockRateMonitor;
  readonly toolRegistry?: ToolRegistry;
  readonly toolExecutor?: ToolExecutor;
  readonly toolExposurePolicy?: ToolExposurePolicy;
  readonly maxToolCalls?: number;
  /** Hard token cap for the muse-sectioned system prompt; sections evict lowest-priority-first when exceeded. Off when unset. */
  readonly systemPromptTokenBudget?: number;
  /**
   * Wall-clock cap, in ms, for a single agent run's tool-loop.
   * Default 300_000 (5 min). CLAUDE.md non-negotiable: tool loops
   * have explicit limits AND timeouts. Checked between iterations
   * — when the deadline passes the loop disables tools on the
   * next model call so the agent gets one synthesis turn to wrap
   * up instead of being cut off mid-thought.
   */
  readonly maxRunWallclockMs?: number;
  /**
   * Idle cut, in ms, for the STREAMING model path: if the provider emits no
   * event within this window the stream is closed and the turn fails, so a
   * connected-but-unresponsive local model (a TCP black-hole) can't freeze the
   * turn. Default 180_000 (3 min); wired from `MUSE_STREAM_IDLE_TIMEOUT_MS` by
   * autoconfigure. A non-positive / non-finite value falls back to the default.
   */
  readonly streamIdleTimeoutMs?: number;
  /**
   * Liveness ping for an EXTERNAL stale-run registry: called at each
   * stream/tool progress point of a single run (`ModelLoopRunner.heartbeat`
   * — a text-delta, a tool-call event, and once per genuinely executed tool
   * call), so an in-tool/in-stream stall is visible while the run is still
   * going. `agent-core` never imports a registry; whichever assembly layer
   * ALSO owns one (e.g. `@muse/multi-agent`'s `SubAgentRunRegistry`) wires
   * its `heartbeat(runId)` method in here. Unset = no-op, byte-identical.
   */
  readonly heartbeat?: (runId: string) => void;
  /**
   * Per-tool-result character cap (Context Engineering step 1.b).
   * When set and a tool returns more than `maxChars` characters,
   * the message-bound copy is truncated head+tail with an explicit
   * elision marker so the agent sees the truncation rather than
   * guessing why the result looks short. The original result on
   * traces / metrics stays intact. 0 or undefined = no cap.
   */
  readonly maxToolOutputChars?: number;
  /**
   * Optional deterministic pre-call gate: each middleware may veto a
   * tool call before it executes (e.g. a restricted sub-agent's tool
   * allowlist, an environment that forbids a destructive tool). Empty
   * or undefined → tool execution is unchanged.
   */
  readonly toolCallMiddleware?: readonly ToolCallMiddleware[];
  /**
   * Optional ContextReferenceStore for just-in-time retrieval
   * (Context Engineering step 1.d). When provided AND a tool result
   * triggers truncation, the full original output is stashed in the
   * store under a sha256-prefix id and the truncation marker
   * surfaces `ref=<id>` so the agent can call
   * `muse.context.fetch({ ref })` to expand on demand. Same content
   * → same ref so repeated truncations dedupe. When undefined,
   * truncation behaves head+tail+marker only (no ref).
   */
  readonly contextReferenceStore?: ContextReferenceStore;
  readonly circuitBreaker?: CircuitBreaker;
  readonly fallbackStrategy?: FallbackStrategy;
  readonly retry?: RetryOptions;
  readonly requestTimeoutMs?: number;
  readonly contextWindow?: ConversationTrimOptions;
  /**
   * Optional auxiliary-model summarizer. When set AND a compaction
   * fired this turn, the messages dropped by the trim are summarized by
   * this injected model and the result is appended to the deterministic
   * `[Conversation summary …]` block. Fail-open: any error/empty result
   * leaves the deterministic summary untouched. Unset = no aux call (the
   * default; existing behavior byte-identical). Model-agnostic by
   * construction — the runtime never names a provider.
   */
  readonly contextSummarizer?: DroppedContextSummarizer;
  /** Char cap for the aux dropped-context summary (default 600). */
  readonly contextSummaryMaxChars?: number;
  readonly metrics?: AgentMetrics;
  readonly tracer?: MuseTracer;
  readonly tokenUsageSink?: TokenUsageSink;
  readonly userMemoryProvider?: UserMemoryProvider;
  readonly userMemoryInjection?: UserMemoryInjectionOptions;
  readonly conversationSummaryStore?: ConversationSummaryStore;
  readonly guards?: readonly GuardStage[];
  readonly hooks?: readonly HookStage[];
  readonly outputGuards?: readonly OutputGuardStage[];
  readonly responseFilters?: readonly ResponseFilterStage[];
  readonly exemplarRetriever?: ExemplarRetriever;
  readonly exemplarTopK?: number;
  /**
   * Few-shot tool-exemplar seed bank injected into the live tool-selection
   * prompt so the local model imitates a proven selection — the delivery
   * mechanism for Programmatic Tool Calling (a 12B never picks `run_tool_plan`
   * without it). Absent ⇒ no section (the autoconfigure builder withholds it
   * when `MUSE_TOOL_EXEMPLARS=false`). Fail-open per transform.
   */
  readonly toolExemplarBank?: readonly ToolExemplar[];
  readonly toolExemplarTopK?: number;
  readonly promptLayerRegistry?: PromptLayerRegistry;
  /**
   * The `PERSONA.md` `register` frontmatter setting (docs/strategy/
   * prompt-architecture.md §4), read once at startup alongside the
   * personality `PromptLayer`. WINS over per-turn 반말/존댓말 detection —
   * the user configured it deliberately. Undefined ⇒ detection alone
   * decides the register mirrored in `applyPromptLayers`.
   */
  readonly personaRegister?: PersonaRegister;
  /**
   * Context Engineering Phase 1: pull current time / timezone /
   * working-hours / active task and inject as a `[Active Context]`
   * system-prompt block. Fail-open per transform.
   */
  readonly activeContextProvider?: ActiveContextProvider;
  /**
   * Ambient perception: when set, the agent perceives the user's
   * environment (frontmost app / window / selection / clipboard /
   * notifications) as an `[Ambient Context]` system block, unasked.
   * Opt-in only — privacy-sensitive, so absence = off; fail-open.
   */
  readonly ambientSnapshotProvider?: AmbientSnapshotProvider;
  /**
   * Learns-from-correction: when set, the user's recorded vetoes
   * are surfaced as a `[Learned Avoidance]` system block so the
   * agent stops proposing a corrected action class everywhere.
   * Conservative — zero vetoes ⇒ exact no-op; fail-open.
   */
  readonly vetoAvoidanceProvider?: VetoAvoidanceProvider;
  /**
   * Learned-strategy playbook (ACE, arXiv 2510.04618): positive how-to
   * deltas from past feedback, injected as `[Learned Strategies]`.
   * Conservative — zero strategies ⇒ exact no-op; fail-open.
   */
  readonly playbookProvider?: PlaybookProvider;
  /**
   * Plan-template cache (Agentic Plan Caching, arXiv 2506.14852). When set,
   * the plan-execute path injects a similar past plan as a planning exemplar
   * and records successful plans. Conservative — no userId / no match ⇒ no-op;
   * fail-open.
   */
  readonly planCacheProvider?: PlanCacheProvider;
  /**
   * Context Engineering Phase 2: surface recent inbound messages
   * (Slack / Discord / Telegram / LINE) as a `[Recent Messages]`
   * system-prompt block.
   */
  readonly inboxContextProvider?: InboxContextProvider;
  /**
   * Context Engineering Phase 3: retrieve top-K prior session
   * summaries and inject as `[Episodic Memory]`.
   */
  readonly episodicRecallProvider?: EpisodicRecallProvider;
  /**
   * Context Engineering Phase 4: filter the tool catalog advertised
   * per request by user-prompt keywords + metadata scope hints.
   */
  readonly toolFilter?: ToolFilter;
  /**
   * SKILL.md catalog provider — surfaces an `[Available Skills]`
   * block listing registered external-CLI integrations.
   */
  readonly skillCatalogProvider?: SkillCatalogProvider;
  /**
   * Telemetry aggregator (phase A). When provided, the runtime
   * records one `RunTelemetryEvent` per successful run so the
   * operator can later query daily / weekly summaries via
   * `aggregator.summary()`.
   */
  readonly telemetryAggregator?: TelemetryAggregator;
  /**
   * Runtime gate consulted before each tool call. Returning
   * `{ allowed: false, reason }` short-circuits the executor and
   * surfaces a blocked-tool result so the model sees the rejection
   * and the run history records it. The personal-Muse shape uses
   * this to enforce ~/.muse/trust.json: read tools pass, execute
   * tools require an entry in `trustedTools`, anything in
   * `blockedTools` is always rejected.
   */
  readonly toolApprovalGate?: ToolApprovalGate;
  /**
   * Audit-only sink for a non-"allow" egress decision (S5): fired AFTER the
   * approval-gate/deny enforcement above already ran, never before or in
   * place of it. A "deny" is already hard-blocked by the runtime regardless
   * of this sink; a "confirm" (link-following a URL observed only in an
   * untrusted tool result, under the fan-out cap) is NOT blocked — it has no
   * other record anywhere today. Fire-and-record: a throwing sink is caught
   * and ignored, never crashes or gates the run. Never called on "allow"
   * (a trusted-typed fetch) — that would log every ordinary fetch as noise.
   */
  readonly egressAdvisorySink?: EgressAdvisorySink;
  readonly defaults?: {
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
  };
}

export type ToolRiskLevel = "read" | "write" | "execute";

export interface ToolApprovalGateInput {
  readonly toolCall: ModelToolCall;
  readonly risk: ToolRiskLevel;
  readonly userId?: string;
  readonly runId: string;
  /**
   * Set by the injection-provenance gate when this outbound-send call's sink
   * args derive from UNTRUSTED tool output rather than the user's own message.
   * The draft-first confirm surfaces it so the user sees WHY the send was
   * flagged; a policy gate may treat its presence as grounds to refuse. When
   * absent, the call carries no provenance concern.
   */
  readonly provenanceWarning?: string;
  /**
   * Set by the egress-authorization gate (S5) when this call carries an
   * http(s)/ws(s) URL that is not fully trusted-observed: either a
   * link-follow under the fan-out cap ("confirm") or a URL that was never
   * observed anywhere Muse read this run ("deny" — see `egressBlocked`).
   * Human-readable reason a surface gate MAY show before deciding.
   */
  readonly egressWarning?: string;
  /**
   * True ONLY when the egress decision is a hard "deny" (a model-composed /
   * never-observed URL, or the fan-out cap was exceeded). A gate MUST NOT
   * auto-allow when this is true — the runtime enforces the deny regardless
   * of what the gate returns, but a surface should still refuse to ask a
   * misleading "approve?" for a call that cannot proceed.
   */
  readonly egressBlocked?: boolean;
}

export interface ToolApprovalGateDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export type ToolApprovalGate = (
  input: ToolApprovalGateInput
) => ToolApprovalGateDecision | Promise<ToolApprovalGateDecision>;

/**
 * A single non-"allow" egress decision, handed to `egressAdvisorySink` for
 * the record — never consulted for the allow/confirm/deny decision itself
 * (that is `authorizeEgressForValue`'s job; this is downstream of it).
 */
export interface EgressAdvisory {
  readonly toolName: string;
  /**
   * "confirm"/"deny" are the URL rule's own decisions (URL-leaf gated).
   * "confidentiality" is a DIFFERENT axis — a NON-URL leaf (e.g. a header
   * value) carrying a private phrase the user didn't type this turn — and
   * never blocks; it rides the same sink purely to get a durable record.
   */
  readonly decision: Exclude<EgressDecisionKind, "allow"> | "confidentiality";
  readonly reason: string;
  /** The candidate URL the decision was about, when the gate resolved one. */
  readonly url?: string;
  readonly runId: string;
  readonly userId?: string;
}

export type EgressAdvisorySink = (advisory: EgressAdvisory) => void | Promise<void>;

export type AgentRuntimeStreamEvent =
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "text-delta" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "tool-call" }>)
  | { readonly runId: string; readonly toolCall: ModelToolCall; readonly type: "tool-result"; readonly grounding?: { readonly source: string; readonly text: string } }
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "tool-call-started" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "tool-call-finished" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "citations" }>)
  | { readonly plan: readonly PlanStep[]; readonly runId: string; readonly type: "plan-generated" }
  | {
      readonly description: string;
      readonly runId: string;
      readonly stepIndex: number;
      readonly tool: string;
      readonly type: "plan-step-executing";
    }
  | { readonly runId: string; readonly stepIndex: number; readonly success: boolean; readonly type: "plan-step-result" }
  | { readonly runId: string; readonly type: "synthesis-started" }
  | ({
      readonly runId: string;
      /** Store ids of the playbook strategies injected into this run's prompt (see `AgentRunResult.playbookInjectedIds`). */
      readonly playbookInjectedIds?: readonly string[];
    } & Extract<ModelEvent, { readonly type: "done" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "error" }>);
