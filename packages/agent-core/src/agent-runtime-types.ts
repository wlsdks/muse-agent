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
import type { CircuitBreaker, FallbackStrategy, RetryOptions } from "@muse/resilience";
import type {
  AgentRunHistoryStore,
  CheckpointStore,
  HookTraceStore
} from "@muse/runtime-state";
import type {
  ContextReferenceStore,
  ConversationSummaryStore,
  ConversationTrimOptions
} from "@muse/memory";
import type { GuardBlockRateMonitor } from "@muse/policy";
import type {
  ToolExecutor,
  ToolExposurePolicy,
  ToolRegistry
} from "@muse/tools";

import type { ActiveContextProvider } from "./active-context.js";
import type { AmbientSnapshotProvider } from "./ambient-context.js";
import type { VetoAvoidanceProvider } from "./veto-avoidance.js";
import type { PlaybookProvider } from "./playbook.js";
import type { EpisodicRecallProvider } from "./episodic-recall.js";
import type { HookRegistry } from "./hook-registry.js";
import type { InboxContextProvider } from "./inbox-context.js";
import type { PlanStep } from "./plan-execute.js";
import type { SkillCatalogProvider } from "./skills-context.js";
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
   * Per-tool-result character cap (Context Engineering step 1.b).
   * When set and a tool returns more than `maxChars` characters,
   * the message-bound copy is truncated head+tail with an explicit
   * elision marker so the agent sees the truncation rather than
   * guessing why the result looks short. The original result on
   * traces / metrics stays intact. 0 or undefined = no cap.
   */
  readonly maxToolOutputChars?: number;
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
  readonly promptLayerRegistry?: PromptLayerRegistry;
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
}

export interface ToolApprovalGateDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export type ToolApprovalGate = (
  input: ToolApprovalGateInput
) => ToolApprovalGateDecision | Promise<ToolApprovalGateDecision>;

export type AgentRuntimeStreamEvent =
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "text-delta" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "tool-call" }>)
  | { readonly runId: string; readonly toolCall: ModelToolCall; readonly type: "tool-result" }
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
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "done" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "error" }>);
