import type { AgentRunResult } from "@muse/agent-core";
export { createWorkerResult, parseHandoffPart, parseWorkerResult, validateWorkerHandoff } from "./worker-result.js";
export { addTask, DEFAULT_BOARD_MAX_DEPTH, expandTaskIntoSubtasks, lastFailureReason, latestOutput, nextReadyTask, reclaimStaleTasks, recordTaskRun, removeTask, resolveBoardMaxDepth, retryTask, staleInProgressTasks, taskDepsMet, tasksFromSubtasks, transitionTask, type AgentTask, type TaskRun, type TaskStatus } from "./task-board.js";
export { parallelDecomposePrompt, parseParallelPlan, planParallelSubtasks, type ParallelDecomposeDeps } from "./parallel-decompose.js";
export { defaultBoardFile, FileAgentTaskBoard, readBoard, writeBoard } from "./board-store.js";
export { dispatchNextTask, resolveReview, type DispatchResult, type TaskExecutionResult, type TaskExecutor } from "./dispatch-board.js";
export type { HandoffPart, ParsedHandoffPart, ParsedWorkerResult, WorkerHandoff } from "./worker-result.js";
import type { AgentWorker } from "./workers.js";

export type { AgentMessage, AgentMessageBus, AgentMessageHandler, InMemoryAgentMessageBusOptions } from "./agent-message-bus.js";
export { InMemoryAgentMessageBus } from "./agent-message-bus.js";
export type {
  InMemoryOrchestrationHistoryStoreOptions,
  OrchestrationHistoryEntry,
  OrchestrationHistoryStore,
  OrchestrationHistorySummary
} from "./orchestration-history.js";
export { InMemoryOrchestrationHistoryStore } from "./orchestration-history.js";
export type {
  RegisterRunArgs,
  SubAgentRunRecord,
  SubAgentRunRegistryOptions,
  SubAgentRunStatus
} from "./subagent-run-registry.js";
export { SubAgentRunRegistry } from "./subagent-run-registry.js";
export type {
  ModelTier,
  PlanTieredRunArgs,
  TierModels,
  TieredAssignment,
  TieredRunPlan,
  TieredTask
} from "./tiering.js";
export { classifyTier, DEFAULT_CASCADE_ESCALATE_LOGPROB, planTieredRun, shouldEscalateToHeavy } from "./tiering.js";
export type { CascadeOutcome, CascadeRunArgs } from "./cascade-run.js";
export { runCascade } from "./cascade-run.js";
export type { DecomposeDecision, DecomposedRequest, DecomposeSignals, Subtask } from "./decompose-trigger.js";
export { decomposeRequest, decomposeRequestWithKind, listHasBackReference, sentenceSplitDependentTwoStep, shouldDecompose, singleMarkerDependentSplit } from "./decompose-trigger.js";
export type {
  LeadWorkerDeps,
  LeadWorkerResult,
  SubtaskExecution,
  SubtaskOutput,
  SubtaskStatus,
  SynthesisVerdict
} from "./lead-worker.js";
export { dedupeSubtasks, detectFanInConflicts, detectFanInRedundancy, detectSubtaskConflicts, detectSubtaskRedundancies, runLeadWorkerTask, verifySequencedDependencyUse, verifySynthesisCoverage } from "./lead-worker.js";
export { resolveSubAgentToolBudget, SUB_AGENT_BUDGET_RATIO, SUB_AGENT_MIN_BUDGET, SUB_AGENT_UNCAPPED_DEFAULT } from "./sub-agent-budget.js";
export { inheritParentToolDeny } from "./sub-agent-tools.js";

export type { AgentWorker } from "./workers.js";
export { NoAgentWorkerError, RuleBasedAgentWorker, RuntimeAgentWorker } from "./workers.js";
export { MultiAgentOrchestrator, SupervisorAgent } from "./orchestrator.js";
export { buildOrchestrationResponse } from "./orchestration-fan-in.js";
export type {
  BackgroundOrchestrationHandle,
  BackgroundOrchestrationRecord,
  BackgroundOrchestrationStore
} from "./background-orchestration.js";
export { InMemoryBackgroundOrchestrationStore } from "./background-orchestration.js";

export interface HandoffDecision {
  readonly from?: string;
  readonly to: string;
  readonly reason: string;
  readonly confidence: number;
}

export interface MultiAgentRunResult extends AgentRunResult {
  readonly selectedAgentId: string;
  readonly handoffs: readonly HandoffDecision[];
}

/**
 * `race` is PARKED (2026-06 maturity review): on a single local GPU "first
 * useful answer wins" is fiction — Ollama serializes the workers anyway, so
 * race only added the most complex code path for a latency pessimization.
 * The wire value stays accepted for compat and resolves to `sequential`.
 */
export type OrchestrationMode = "sequential" | "parallel" | "race";

export interface OrchestrationStepResult {
  readonly workerId: string;
  readonly status: "completed" | "failed";
  readonly result?: AgentRunResult;
  readonly error?: string;
}

export interface OrchestrationRunOptions {
  readonly mode?: OrchestrationMode;
  readonly workerIds?: readonly string[];
  readonly maxWorkers?: number;
  /**
   * Per-worker output character cap for the fan-in summary (Context
   * Engineering step 1.e). When set, each worker's `response.output`
   * is run through `trimToolOutput` (head + tail + marker) BEFORE the
   * orchestrator concatenates the workers' outputs into the parent
   * response. Prevents N parallel workers from collectively blowing
   * the parent's context window.
   *
   * Tracked results (`MultiAgentOrchestrationResult.results`) keep the
   * full original `AgentRunResult.response.output` so traces / metrics
   * still see every worker's full reasoning — the cap applies only to
   * the fan-in concat the parent agent reads back.
   *
   * Undefined or 0 disables the cap (legacy verbatim concat).
   */
  readonly maxOutputCharsPerWorker?: number;
  /**
   * LLM-summarized fan-in (Context Engineering step 1.e). When
   * provided, each worker's `response.output` is replaced with the
   * summarizer's return value BEFORE the deterministic head+tail
   * trim and BEFORE the parent concat. Composes naturally with
   * `maxOutputCharsPerWorker`: summarize first, then trim the
   * summary as a belt-and-suspenders guard against an unbounded
   * summarizer return.
   *
   * Failures (rejected promise, timeout) fall back to the raw
   * worker output — the orchestrator never blocks on summarization.
   * Tracked results stay byte-identical regardless of summarizer
   * usage (same fidelity contract as `maxOutputCharsPerWorker`).
   *
   * Caller-provided so `@muse/multi-agent` stays model-agnostic; the
   * autoconfigure layer wires a real summarizer that uses the
   * configured `ModelProvider`.
   */
  readonly summarizeWorkerOutput?: (workerId: string, output: string) => Promise<string>;
  /**
   * When set, the completed workers' outputs are fused into ONE coherent
   * final answer (e.g. the direct answer + the Critic's risks merged), instead
   * of the `## <worker>` concatenation. Receives each completed worker's
   * `{ workerId, output }` in execution order. Caller-provided so this package
   * stays model-agnostic; fail-soft — if it throws or returns empty, the
   * orchestration falls back to the concatenation (never loses the answer).
   */
  readonly synthesizeFinalAnswer?: (parts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>, guidance?: string) => Promise<string>;
  /**
   * Verification against the ORIGINAL objective (MAST, arXiv 2503.13657: a verify
   * step focused on the high-level task → +15.6% success; most multi-agent
   * failures are coordination, not capability). After synthesis, a SEPARATE judge
   * (maker ≠ judge) checks the final answer actually satisfies the user's request
   * and names what's MISSING. The verdict is attached to `response.raw.verification`,
   * and an unsatisfied verdict appends one honest line to the output (Muse's
   * shows-its-work edge — never silently return an incomplete synthesis).
   * Caller-provided so this package stays model-agnostic; fail-soft.
   */
  readonly verifyFinalAnswer?: (objective: string, output: string) => Promise<{ readonly satisfied: boolean; readonly missing?: string }>;
  /**
   * Cross-worker CONTRADICTION on the fan-in — the grounding edge applied to the
   * orchestrate fan-OUT, mirroring lead-worker's `detectSubtaskConflicts`. Two
   * COMPLETED workers can each pass their own gate yet assert disagreeing values on
   * the SAME topic ("deadline Tuesday" vs "Wednesday"); the fused/concatenated answer
   * would then present a self-contradicting claim as one confident truth (a
   * GROUNDED≠TRUE leak coverage-checking can't catch). Given each completed worker's
   * NEUTRALIZED `{ workerId, output }` (same safe value the synthesizer sees), return
   * a caption per conflicting pair. A non-empty result records
   * `response.raw.conflicts` and appends one honest "⚠ Workers disagree" line — never
   * silently shipping an internally-inconsistent synthesis. Caller-provided so this
   * package stays model-agnostic; fail-soft (throw/empty ⇒ no flag).
   */
  readonly detectConflicts?: (parts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>) => Promise<readonly string[]>;
  /**
   * Fan-in REDUNDANCY detector (step-repetition): given the COMPLETED workers' parts,
   * return a caption per pair whose outputs are near-identical (a worker added nothing).
   * A non-empty result records `response.raw.redundancies` and appends one advisory line.
   * Caller-provided (model-agnostic); fail-soft (throw/empty ⇒ no flag).
   */
  readonly detectRedundancies?: (parts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>) => Promise<readonly string[]>;
}

export interface MultiAgentOrchestrationResult {
  readonly mode: OrchestrationMode;
  readonly runId: string;
  readonly results: readonly OrchestrationStepResult[];
  readonly response: AgentRunResult["response"];
}

export interface SupervisorOptions {
  readonly workers: readonly AgentWorker[];
  readonly defaultWorkerId?: string;
  readonly minConfidence?: number;
  readonly maxHandoffs?: number;
  readonly idFactory?: () => string;
}
