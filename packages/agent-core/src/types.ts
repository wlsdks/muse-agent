import type { AgentSpecResolution } from "@muse/agent-specs";
import type { UserModel } from "@muse/memory";
import type { ModelMessage, ModelProvider, ModelResponse, ModelToolCall } from "@muse/model";

export interface AgentSpecResolver {
  resolve(text: string): Awaitable<AgentSpecResolution | undefined>;
}
import type { JsonObject } from "@muse/shared";
import type { ToolExecutionResult } from "@muse/tools";
import type { ToolApprovalGate } from "./agent-runtime-types.js";

/**
 * Public runtime interface types for `@muse/agent-core` submodules to share.
 *
 * Kept minimal — only the types that are imported by more than one of the
 * extracted submodules (guards, response-filters, hooks, runtime). Anything
 * that lives entirely inside a single submodule (e.g. `PlanStep`) stays in
 * that submodule.
 */

export type Awaitable<T> = T | Promise<T>;

export interface AgentRunInput {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly runId?: string;
  readonly metadata?: JsonObject;
  /**
   * Run-scoped approval gate. When set it takes precedence over the
   * runtime's constructor gate for THIS run only — lets a caller
   * (e.g. the inbound-channel reply path) require in-chat approval
   * for risky tools without changing the global gate.
   */
  readonly toolApprovalGate?: ToolApprovalGate;
  /**
   * Cooperative cancellation. When the caller aborts this signal mid-run, the
   * tool loop stops cleanly at the next iteration boundary — no further model
   * call or tool execution — and returns what it has. Lets a surface (the CLI)
   * interrupt a long agent turn without a half-applied tool.
   */
  readonly signal?: AbortSignal;
  /**
   * Request per-token log-probabilities for the model's answer (forwarded to
   * `ModelRequest.logprobs`; returned in `AgentRunResult.response.logprobs`).
   * Observational only — never alters decoding. Lets a caller score answer
   * confidence (`summarizeTokenConfidence`) on an AGENT run, e.g. to drive
   * cascade escalation. Off by default; providers without the capability ignore it.
   */
  readonly logprobs?: boolean;
  /** Alternatives per position when `logprobs` is set (forwarded to `ModelRequest.topLogprobs`). */
  readonly topLogprobs?: number;
}

export interface AgentRunContext {
  readonly runId: string;
  readonly input: AgentRunInput;
  readonly startedAt: Date;
  readonly agentSpec?: AgentSpecResolution;
}

export type GuardDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly code?: string };

export interface GuardStage {
  readonly id: string;
  evaluate(context: AgentRunContext): Awaitable<GuardDecision>;
}

export interface LlmClassificationInputGuardOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly maxOutputTokens?: number;
}

export interface HookStage {
  readonly id: string;
  beforeStart?(context: AgentRunContext): Awaitable<void>;
  beforeTool?(context: AgentRunContext, toolCall: ModelToolCall): Awaitable<void>;
  afterTool?(context: AgentRunContext, toolCall: ModelToolCall, result: ToolExecutionResult): Awaitable<void>;
  afterComplete?(context: AgentRunContext, response: ModelResponse): Awaitable<void>;
  onError?(context: AgentRunContext, error: unknown): Awaitable<void>;
}

export type OutputGuardDecision =
  | { readonly action: "allow" }
  | { readonly action: "modify"; readonly content: string; readonly reason: string }
  | { readonly action: "reject"; readonly reason: string; readonly code?: string };

export interface OutputGuardContext {
  readonly runId: string;
  readonly input: AgentRunInput;
  readonly response: ModelResponse;
}

export interface OutputGuardStage {
  readonly id: string;
  check(content: string, context: OutputGuardContext): Awaitable<OutputGuardDecision>;
}

export interface VerifiedSource {
  readonly title: string;
  readonly url: string;
  readonly toolName?: string;
}

export interface ResponseFilterContext {
  readonly runId: string;
  readonly input: AgentRunInput;
  readonly response: ModelResponse;
  readonly toolInsights?: readonly string[];
  readonly toolsUsed?: readonly string[];
  readonly verifiedSources?: readonly VerifiedSource[];
}

export interface ResponseFilterStage {
  readonly id: string;
  apply(response: ModelResponse, context: ResponseFilterContext): Awaitable<ModelResponse>;
}

export interface AgentSpecRunReport {
  readonly name: string;
  readonly confidence: number;
  readonly matchedKeywords: readonly string[];
  readonly toolNames: readonly string[];
}

export interface UserMemorySnapshot {
  readonly userId: string;
  readonly facts: Readonly<Record<string, string>>;
  readonly preferences: Readonly<Record<string, string>>;
  readonly recentTopics?: readonly string[];
  /**
   * Optional typed user-model slots (Context Engineering 1.c).
   * Parallel structure to the free-text `facts`/`preferences`
   * Records — when set, downstream renderers (persona snapshot,
   * `renderUserMemorySection`) emit the typed shape WITH the legacy
   * Records, not in place of them. Stays optional so no existing
   * provider needs to change.
   */
  readonly userModel?: UserModel;
}

export interface UserMemoryProvider {
  findByUserId(userId: string): Awaitable<UserMemorySnapshot | undefined>;
}

export interface UserMemoryInjectionOptions {
  readonly maxEntries?: number;
}

export interface AgentContextWindowReport {
  readonly budgetTokens: number;
  readonly estimatedTokens: number;
  readonly removedCount: number;
  readonly summaryInserted: boolean;
  /**
   * Which compaction threshold caused the trim, if any. `none` =
   * no-op (under both budgets); `working_budget` = proactive trim
   * to the soft target (Anthropic / NoLiMa pattern); `hard_limit` =
   * the legacy forced-trim path. Surfacing this in the report lets
   * downstream observability distinguish proactive compaction from
   * forced compaction in dashboards.
   */
  readonly triggeredBy: "none" | "working_budget" | "hard_limit";
}

export interface AgentRunResult {
  readonly runId: string;
  readonly response: ModelResponse;
  readonly agentSpec?: AgentSpecRunReport;
  readonly contextWindow?: AgentContextWindowReport;
  readonly fromCache?: boolean;
  readonly toolsUsed?: readonly string[];
  /**
   * The evidence the AGENT was actually shown, each `{ source, text }`: the
   * text outputs of the read-tools it ran (knowledge_search, web fetches —
   * `source: toolName`) AND any freshly-injected inbox messages it could recall
   * (`source: "inbox/<provider>"`). Surfaced so a caller's output-side grounding
   * verdict scores the answer against this set — otherwise a correctly
   * web-grounded OR a just-arrived-message-grounded `--with-tools` answer
   * false-flags against a notes-only evidence set. Omitted when there was none
   * (e.g. a chat-only or actuator-only run with no recent inbox).
   */
  readonly groundingSources?: readonly { readonly source: string; readonly text: string }[];
}
