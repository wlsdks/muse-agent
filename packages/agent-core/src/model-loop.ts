/**
 * Model invocation loop extracted from packages/agent-core/src/index.ts.
 *
 * Owns the three react-style model-tool-model orchestration entry points:
 *   - executeModelLoop: blocking variant used by AgentRuntime.run.
 *   - executeStreamingModelLoop: streaming variant used by
 *     AgentRuntime.stream — yields text/tool-call/tool-result events.
 *   - streamModelTurn: a single provider-stream pump that buffers
 *     text deltas, captures tool calls, and records token-usage span
 *     attributes when the provider emits a usage event.
 *
 * All three are free functions taking a `ModelLoopRunner` facade so the
 * AgentRuntime keeps ownership of the constructor-bound dependencies
 * (tracer / metrics / tokenUsageSink / maxToolCalls / inner helpers)
 * while the loop control flow lives in its own module.
 */

import { USAGE_RECORDED_BY_RUNTIME_FLAG } from "@muse/model";
import type {
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelTool,
  ModelToolCall
} from "@muse/model";

import { maskStaleToolObservations, type ContextReferenceStore } from "@muse/memory";
import type { AgentMetrics, MuseTracer, TokenUsageSink } from "@muse/observability";
import { renderToolResults } from "@muse/prompts";
import type { CheckpointStore } from "@muse/runtime-state";

import { recordCheckpoint } from "./lifecycle.js";
import { applyCitationSanitisation, recordTokenUsageEvent } from "./model-invocation.js";
import type { PlanCacheProvider } from "./plan-cache.js";
import { appendSystemSection, recordUsageSpanAttributes } from "./runtime-helpers.js";
import {
  blockedToolResult,
  groundingSourceFromExecuted,
  type ExecutedToolResult,
  type ModelLoopExecution,
  type StreamExecutionOptions,
  type StreamedModelTurn
} from "./runtime-internals.js";
import { GeneralShellPhaseGate } from "./general-shell-phase.js";
import { buildPostCompactionSignature, PostCompactionLoopGuard, POST_COMPACTION_GUARD_WINDOW } from "./post-compaction-loop-guard.js";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, withStreamIdleTimeout } from "./stream-idle-timeout.js";
import { detectConflictingWritesInBatch } from "./tool-batch-conflict.js";
import { ToolCallDeduplicator } from "./tool-call-deduplicator.js";
import { applyToolCallMiddleware, type ToolCallMiddleware } from "./tool-call-middleware.js";
import { ToolFailureStreakTracker } from "./tool-failure-streak.js";
import { buildPingPongSignature, PingPongLoopGuard } from "./tool-loop-pingpong.js";
import { ToolLoopProgressTracker } from "./tool-loop-progress.js";
import { capToolOutput, deriveAnchorTerms } from "./tool-output-cap.js";
import { REVERIFY_NUDGE, ReverifyNudgeTracker, hasRunVerifyIntent, toolsIncludeExecute } from "./reverify-nudge.js";
import { BudgetExhaustionTracker, budgetExhaustionNotice } from "./budget-exhaustion-notice.js";
import type { AgentRunContext } from "./types.js";

export interface ModelLoopRunner {
  readonly maxToolCalls: number;
  /** Plan-template cache (Agentic Plan Caching) — used only by the plan-execute path. */
  readonly planCacheProvider?: PlanCacheProvider;
  /**
   * Wall-clock cap, in ms, for a single run's tool-loop. Counts
   * from the start of `executeModelLoop` / `executeStreamingModelLoop`.
   * Checked between iterations — if the deadline passes the loop
   * returns the current response with no further tool execution.
   * 0 / undefined disables the deadline. CLAUDE.md non-negotiable:
   * "Tool loops have explicit limits and timeouts."
   */
  readonly maxRunWallclockMs?: number;
  /** Wall-clock source for the deadline (injectable so the mid-batch cut is testable without timing flake). Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Idle cut for the STREAMING path: if the provider emits no event for this many
   * ms, the stream is closed and the turn fails instead of blocking forever. The
   * blocking path gets this via `withTimeout`; the streaming `for await` did not, so
   * a hung local Ollama stream could hang the whole agent (the smoke:live stall).
   * Defaults to 180s; 0/undefined-after-default disables. Injectable for tests.
   */
  readonly streamIdleTimeoutMs?: number;
  readonly tracer: MuseTracer;
  readonly metrics: AgentMetrics;
  readonly tokenUsageSink?: TokenUsageSink;
  /**
   * When set, a checkpoint of the messages-so-far (incl. completed tool results)
   * is saved AFTER EACH tool step so a crashed/interrupted run can resume mid-loop
   * — already-done tools aren't re-run because their results are in the replayed
   * messages (resumeRunInputFromCheckpoint). Best-effort: recordCheckpoint swallows
   * its own errors, so a checkpoint write never breaks the loop.
   */
  readonly checkpointStore?: CheckpointStore;
  /**
   * Per-tool-result character cap. When set and an individual tool
   * output exceeds the cap, the message-bound copy is truncated
   * head+tail with an
   * elision marker. The original `result.output` on the tracked
   * tool result is left unchanged so traces / metrics see the full
   * text. 0 or undefined disables the cap.
   */
  readonly maxToolOutputChars?: number;
  /**
   * Optional ref store for just-in-time retrieval. When set AND
   * `maxToolOutputChars` triggers a truncation, the full original
   * output is stashed in
   * the store under a sha256-prefix id and the truncation marker
   * surfaces `ref=<id>` so the agent can call
   * `muse.context.fetch({ ref })` to expand the elided bytes on
   * demand. Same content → same ref (content-addressed) so repeated
   * truncations of the same payload share storage.
   */
  readonly contextReferenceStore?: ContextReferenceStore;
  /**
   * Optional deterministic pre-call gate. Each middleware may VETO a
   * tool call before it executes (e.g. a restricted sub-agent's tool
   * allowlist). Empty/undefined → tool execution is unchanged.
   */
  readonly toolCallMiddleware?: readonly ToolCallMiddleware[];
  /**
   * True when THIS run's prepared request had a context-window compaction
   * fire (`preparedRequest.contextWindow?.summaryInserted`), decided once
   * before the loop starts. Arms the post-compaction loop guard for the
   * whole loop; undefined/false leaves the guard permanently unarmed, so a
   * run with no compaction is byte-identical to before this guard existed.
   */
  readonly compactionOccurred?: boolean;
  /**
   * Liveness ping for a stale-run detector: called at each stream/tool
   * progress point during a SINGLE run (a text-delta, a tool-call event, and
   * once per genuinely executed tool call) so an in-tool or in-stream stall
   * is visible WHILE the run is still going, not only after it settles.
   * agent-core stays dependency-neutral — this is a plain injected callback;
   * the assembly layer that also owns a run registry (e.g. `@muse/multi-agent`'s
   * `SubAgentRunRegistry.heartbeat`) wires it in. Undefined leaves the loop
   * byte-identical to before this seam existed.
   */
  readonly heartbeat?: (runId: string) => void;
  generateWithTracing(
    context: AgentRunContext,
    provider: ModelProvider,
    request: ModelRequest
  ): Promise<ModelResponse>;
  executeToolCall(
    context: AgentRunContext,
    toolCall: ModelToolCall,
    activeTools: NonNullable<ModelRequest["tools"]>
  ): Promise<ExecutedToolResult>;
}

export type ModelLoopStreamEvent =
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "text-delta" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "tool-call" }>)
  | { readonly runId: string; readonly toolCall: ModelToolCall; readonly type: "tool-result"; readonly grounding?: { readonly source: string; readonly text: string } }
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "tool-call-started" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "tool-call-finished" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "citations" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "error" }>);

// When a small local model re-issues an IDENTICAL tool call (same name+args, no
// intervening mutation — the deduplicator returns the cached result), it gets the
// same content back and can loop re-reading without ever acting (MAST
// "step repetition", arXiv:2503.13657 — a top multi-step failure mode; observed
// live in eval:multifile-fix as repeated file_read with no edit). Appending this
// to the MODEL-FACING tool message (only on a duplicate) gives a deterministic
// cue to break the loop and take the next action. Trace/metric copies
// (`executed.result`) are untouched.
const REPEAT_TOOL_CALL_NUDGE =
  "\n\n(NOTE: this was an IDENTICAL repeat of an earlier tool call this run — the result is unchanged. Do NOT repeat the same call; take the next concrete action toward the goal, e.g. edit the file or run the test.)";

function withRepetitionNudge(content: string, isDuplicate: boolean): string {
  return isDuplicate ? `${content}${REPEAT_TOOL_CALL_NUDGE}` : content;
}

/**
 * Best-effort liveness ping — a throwing callback (a bug in whatever registry
 * it's wired to) must never break the model loop it's only observing.
 */
function emitHeartbeat(runner: ModelLoopRunner, runId: string): void {
  try {
    runner.heartbeat?.(runId);
  } catch {
    // liveness is best-effort only
  }
}

/**
 * Time a single real tool execution as a `muse.tool.execute` span. The span's
 * start→end duration lands in the same trace-event store the existing
 * `LatencyQuery` reads, so per-tool latency is queryable via
 * `LatencyQuery.summary({ spanName: "muse.tool.execute" })` /
 * `.timeSeries(...)` — the same percentile machinery the
 * `/api/admin/metrics/latency` endpoints and the Muse observability snapshot
 * are built on. Mirrors the `muse.model.stream` span house-style. Only GENUINE
 * executions reach here; deduplicated / blocked / capped calls are never timed.
 * Tolerates a missing tracer (test runners omit it) via optional chaining.
 */
async function executeToolCallWithSpan(
  runner: ModelLoopRunner,
  context: AgentRunContext,
  toolCall: ModelToolCall,
  activeTools: NonNullable<ModelRequest["tools"]>
): Promise<ExecutedToolResult> {
  const startedAt = Date.now();
  const span = runner.tracer?.startSpan("muse.tool.execute", {
    "run.id": context.runId,
    "tool.name": toolCall.name
  });
  try {
    const executed = await runner.executeToolCall(context, toolCall, activeTools);
    span?.setAttribute("tool.status", executed.result.status === "failed" ? "error" : "ok");
    span?.setAttribute("duration.ms", Date.now() - startedAt);
    return executed;
  } catch (error) {
    span?.setAttribute("tool.status", "error");
    span?.setAttribute("duration.ms", Date.now() - startedAt);
    span?.setError(error);
    throw error;
  } finally {
    span?.end();
  }
}

function interruptedExecution(
  request: ModelRequest,
  intermediateMessages: ModelMessage[],
  toolResults: ExecutedToolResult[],
  toolsUsed: readonly string[]
): ModelLoopExecution {
  return {
    finalResponse: { id: "interrupted", model: request.model, output: "(run interrupted)" },
    intermediateMessages,
    toolResults,
    toolsUsed: [...new Set(toolsUsed)]
  };
}

/**
 * Terminal execution for a confirmed post-compaction loop: the same
 * mechanism as `interruptedExecution` (return the accumulated messages/
 * results immediately, never a throw) so this stop condition is handled
 * exactly like the other fail-closed loop exits.
 */
function postCompactionAbortedExecution(
  request: ModelRequest,
  intermediateMessages: ModelMessage[],
  toolResults: ExecutedToolResult[],
  toolsUsed: readonly string[]
): ModelLoopExecution {
  return {
    finalResponse: {
      id: "post-compaction-loop-guard",
      model: request.model,
      output: `Stopped: post-compaction loop detected — identical tool call repeated ${POST_COMPACTION_GUARD_WINDOW.toString()} times after context compaction.`
    },
    intermediateMessages,
    toolResults,
    toolsUsed: [...new Set(toolsUsed)]
  };
}

/**
 * Terminal execution for a confirmed ping-pong loop (the model alternating
 * between two tool calls without progress) — same shape as
 * `postCompactionAbortedExecution`, a different stop condition.
 */
function pingPongAbortedExecution(
  request: ModelRequest,
  intermediateMessages: ModelMessage[],
  toolResults: ExecutedToolResult[],
  toolsUsed: readonly string[]
): ModelLoopExecution {
  return {
    finalResponse: {
      id: "ping-pong-loop-guard",
      model: request.model,
      output: "Stopped: the agent was ping-ponging between two tool calls without progress."
    },
    intermediateMessages,
    toolResults,
    toolsUsed: [...new Set(toolsUsed)]
  };
}

/** Trackers threaded through the shared per-batch tool-execution body. */
interface ToolBatchTrackers {
  readonly deduplicator: ToolCallDeduplicator;
  readonly progress: ToolLoopProgressTracker;
  readonly failureStreak: ToolFailureStreakTracker;
  readonly shellPhase: GeneralShellPhaseGate;
  readonly reverify: ReverifyNudgeTracker;
  readonly postCompactionGuard: PostCompactionLoopGuard;
  readonly pingPong: PingPongLoopGuard;
}

interface ToolBatchState {
  toolCallCount: number;
  messages: readonly ModelMessage[];
  readonly deadlineMs: number | undefined;
  readonly now: () => number;
  readonly anchorTerms: readonly string[];
}

interface ToolBatchResult {
  readonly toolCallCount: number;
  readonly messages: readonly ModelMessage[];
  readonly postCompactionLoopDetected: boolean;
  readonly pingPongLoopDetected: boolean;
}

/**
 * A single tool call's resolved execution plan within one batch segment: the
 * sequential decision (gate + dedup + counter) captured in Phase 1, carrying
 * the in-flight `promise` for concurrently-launched read-only executions and
 * the per-call checkpoint `step` so Phase 3 bookkeeping stays byte-identical
 * to the previous sequential body regardless of execution overlap.
 */
interface PlannedToolCall {
  readonly toolCall: ModelToolCall;
  readonly toolRisk: string | undefined;
  readonly canRun: boolean;
  readonly signature: string;
  readonly step: number;
  readonly memoResult?: ExecutedToolResult["result"];
  readonly intraSegmentDuplicate: boolean;
  readonly middlewareBlock: string | null;
  readonly conflicting: boolean;
  readonly deadlineReason: boolean;
  promise?: Promise<ExecutedToolResult>;
}

/**
 * Per-batch tool-execution body shared by the blocking and streaming
 * loops. Yields a `tool-result` stream event per executed call (the
 * blocking caller iterates without forwarding them); mutates the shared
 * `toolResults` / `toolsUsed` / `intermediateMessages` arrays and the
 * trackers in place, and RETURNS the advanced `toolCallCount` and the
 * `messages` array (caller-owned scalars threaded explicitly to keep
 * behaviour identical to the inlined copies).
 */
async function* runToolBatch(
  runner: ModelLoopRunner,
  context: AgentRunContext,
  calls: readonly ModelToolCall[],
  activeTools: ModelRequest["tools"],
  assistantMessage: ModelMessage,
  intermediateMessages: ModelMessage[],
  toolResults: ExecutedToolResult[],
  toolsUsed: string[],
  trackers: ToolBatchTrackers,
  state: ToolBatchState
): AsyncGenerator<ModelLoopStreamEvent, ToolBatchResult, void> {
  const { deduplicator, progress, failureStreak, shellPhase, reverify, postCompactionGuard, pingPong } = trackers;
  const { deadlineMs, now, anchorTerms } = state;
  let toolCallCount = state.toolCallCount;
  let postCompactionLoopDetected = false;
  let pingPongLoopDetected = false;
  const toolMessages: ModelMessage[] = [];

  intermediateMessages.push(assistantMessage);
  let messages: readonly ModelMessage[] = [...state.messages, assistantMessage];

  // A batch the model already emitted is honoured even if the
  // deadline passed during the model call (the established
  // contract: the deadline disables tools for the *next* turn).
  // But once the deadline is crossed *while we run this batch*
  // sequentially — N calls each hitting a slow/hung MCP server —
  // the remaining calls are skipped so the wall-clock cap is a
  // real execution bound, not just a between-turn boundary.
  const batchStartedPastDeadline = deadlineMs !== undefined && now() > deadlineMs;
  // Conflicting-write guard (AgentSpec arXiv:2503.18666): a 2nd write to the same
  // target with conflicting args in this batch is withheld (zero side-effect) so
  // a double-act can't reach a write actuator.
  const conflictingIds = detectConflictingWritesInBatch(calls, (call) => {
    const risk = (activeTools ?? []).find((t) => t.name === call.name)?.risk;
    return risk === "write" || risk === "execute";
  });
  const riskOf = (toolCall: ModelToolCall): string | undefined =>
    (activeTools ?? []).find((t) => t.name === toolCall.name)?.risk;

  // DS-9: a read-only tool call (risk === "read") has no observable side
  // effect, so a MAXIMAL CONTIGUOUS RUN of read-only calls is EXECUTED
  // concurrently. Write / execute calls — and any call whose risk can't be
  // resolved — stay strictly sequential (their own singleton segment). Every
  // call's decision (gate + dedup + counter) and every call's bookkeeping
  // (dedup record, trackers, tool-result event, message, checkpoint) are
  // applied in the ORIGINAL call order, so observable side-effect ordering,
  // the max-tool-call cap, the wall-clock cut, and per-tool checkpoint steps
  // are byte-identical to the previous sequential body — only read EXECUTION
  // overlaps in wall-clock.
  let segmentStart = 0;
  while (segmentStart < calls.length) {
    let segmentEnd = segmentStart + 1;
    if (riskOf(calls[segmentStart]!) === "read") {
      while (segmentEnd < calls.length && riskOf(calls[segmentEnd]!) === "read") {
        segmentEnd += 1;
      }
    }
    const segment = calls.slice(segmentStart, segmentEnd);
    segmentStart = segmentEnd;

    // Phase 1 — decide each call's fate IN ORDER (pure/sync, no I/O): gate,
    // dedup, advance the tool-call counter. Nothing executes yet.
    const planned: PlannedToolCall[] = [];
    const launchedSignatures = new Set<string>();
    for (const toolCall of segment) {
      const remaining = runner.maxToolCalls - toolCallCount;
      const crossedDeadlineMidBatch = !batchStartedPastDeadline
        && deadlineMs !== undefined && now() > deadlineMs;
      const conflicting = conflictingIds.has(toolCall.id);
      // Deterministic pre-call policy gate: a middleware may veto this call
      // before it runs. Empty chain → null → unchanged execution.
      const middlewareBlock = applyToolCallMiddleware(toolCall, runner.toolCallMiddleware ?? []);
      const canRun = remaining > 0 && !crossedDeadlineMidBatch && !conflicting && !middlewareBlock;
      const signature = deduplicator.buildSignature(toolCall);
      const memo = canRun ? deduplicator.check(toolCall) : undefined;
      // An identical call earlier IN THIS SAME segment hasn't recorded its
      // result yet (records happen post-execution), so replicate the
      // sequential dedup by matching against signatures already launched here.
      const intraSegmentDuplicate = canRun === true && memo?.duplicate !== true && launchedSignatures.has(signature);
      const willExecute = canRun && memo?.duplicate !== true && !intraSegmentDuplicate;
      if (willExecute) {
        launchedSignatures.add(signature);
      }
      toolCallCount += canRun ? 1 : 0;
      planned.push({
        toolCall,
        toolRisk: riskOf(toolCall),
        canRun,
        signature,
        step: toolCallCount,
        ...(memo?.duplicate ? { memoResult: memo.result } : {}),
        intraSegmentDuplicate,
        middlewareBlock,
        conflicting,
        deadlineReason: crossedDeadlineMidBatch && remaining > 0
      });
    }

    // Phase 2 — launch the executable calls. A read-only segment with >1
    // executable call runs them CONCURRENTLY; a sequential singleton awaits
    // exactly as before. A thrown (unexpected) tool error propagates out of
    // the batch, replicating the old sequential stop-the-batch semantic.
    for (const plan of planned) {
      if (plan.canRun && plan.memoResult === undefined && !plan.intraSegmentDuplicate) {
        emitHeartbeat(runner, context.runId);
        plan.promise = executeToolCallWithSpan(runner, context, plan.toolCall, activeTools ?? []);
      }
    }
    await Promise.all(
      planned.map((plan) => plan.promise).filter((p): p is Promise<ExecutedToolResult> => p !== undefined)
    );
    const executedBySignature = new Map<string, ExecutedToolResult>();
    for (const plan of planned) {
      if (plan.promise) {
        executedBySignature.set(plan.signature, await plan.promise);
      }
    }

    // Phase 3 — apply bookkeeping and emit results IN ORDER, identical to the
    // pre-parallel sequential body.
    for (const plan of planned) {
      const { toolCall } = plan;
      const executed: ExecutedToolResult = plan.memoResult !== undefined
        ? { result: plan.memoResult, toolCall }
        : plan.intraSegmentDuplicate
          // Same content as the sibling that executed, but this call's id/name
          // (matching how deduplicator.check re-labels a cross-turn duplicate).
          ? { result: { ...executedBySignature.get(plan.signature)!.result, id: toolCall.id, name: toolCall.name }, toolCall }
          : plan.middlewareBlock
            ? blockedToolResult(toolCall, `Error: ${plan.middlewareBlock}`)
            : plan.conflicting
              ? blockedToolResult(toolCall, "Error: conflicting write withheld — ambiguous duplicate action in this batch")
              : plan.canRun
                ? executedBySignature.get(plan.signature)!
                : blockedToolResult(toolCall, plan.deadlineReason
                    ? "Error: run wall-clock deadline reached"
                    : "Error: max tool call limit reached");
      const isDuplicate = plan.memoResult !== undefined || plan.intraSegmentDuplicate;

      const grounding = groundingSourceFromExecuted(executed);
      yield { runId: context.runId, toolCall, type: "tool-result", ...(grounding ? { grounding } : {}) };
      const mutating = plan.toolRisk === "write" || plan.toolRisk === "execute";
      deduplicator.record(toolCall, executed.result, mutating);
      // Feed only GENUINE executions (not blocked / exact-dups) to the stall
      // tracker; a mutating call resets the window (it advanced state).
      if (plan.canRun && !isDuplicate) {
        progress.record(executed.result.output, mutating);
        failureStreak.record(toolCall.name, executed.result.status);
        shellPhase.record(toolCall.name, executed.result.output);
        reverify.recordTool(plan.toolRisk);
      }
      // Unlike the stall tracker above, the compaction guard DOES see
      // dedup-served repeats: the exact-signature deduplicator itself proves
      // "same tool+args+result again" — that is precisely the compaction-didn't-
      // break-the-loop signal, and gating this on `!isDuplicate` would mean a
      // model stuck re-asking the exact same thing never trips it (only its
      // FIRST occurrence would ever reach a `!isDuplicate` block). A blocked
      // call (middleware/conflict/deadline/budget) is a different, already-
      // handled stop condition, so `plan.canRun` alone is the right gate.
      if (plan.canRun && postCompactionGuard.record(buildPostCompactionSignature(toolCall, executed.result.output))) {
        postCompactionLoopDetected = true;
      }
      // Same rationale as the compaction guard above: an exact dedup-served
      // repeat IS the ping-pong signal (the model asked for the same A again
      // in the A,B,A,B pattern), so this gates on `plan.canRun` alone too.
      if (plan.canRun && pingPong.record(buildPingPongSignature(toolCall, executed.result.output)) === "block") {
        pingPongLoopDetected = true;
      }
      toolsUsed.push(toolCall.name);
      toolResults.push(executed);
      // cap individual tool results so a single big
      // output doesn't blow the context window. Original
      // executed.result.output is left intact for traces / metrics
      // — only the message-bound copy is truncated.
      const messageContent = withRepetitionNudge(
        capToolOutput(executed.result.output, toolCall.name, runner.maxToolOutputChars, runner.contextReferenceStore, anchorTerms),
        isDuplicate
      );
      toolMessages.push({
        content: messageContent,
        name: toolCall.name,
        role: "tool",
        toolCallId: toolCall.id
      });
      // Per-tool checkpoint for a MULTI-tool batch (rare): the post-batch checkpoint is
      // written only after ALL calls in the response, so a crash BETWEEN two tools in one
      // response would lose the ones already run — resume couldn't replay+dedup them, risking
      // a re-send/re-book. A 1-tool batch (the norm) is fully covered by the post-batch one,
      // so this fires only when it adds protection. Every tool pushes a result message
      // (above), so the replayed transcript is consistent. Best-effort (recordCheckpoint swallows).
      if (calls.length > 1) {
        await recordCheckpoint({ checkpointStore: runner.checkpointStore, context, messages: [...messages, ...toolMessages], phase: "act", step: plan.step });
      }
    }
  }

  const toolSummary = renderToolResults(
    toolResults
      .map((item) => `${item.result.name}: ${capToolOutput(item.result.output, item.result.name, runner.maxToolOutputChars, runner.contextReferenceStore, anchorTerms)}`)
      .join("\n\n")
  );
  const nextMessages = [...messages, ...toolMessages];
  messages = toolSummary
    ? appendSystemSection(nextMessages, toolSummary, "tool-results")
    : nextMessages;
  intermediateMessages.push(...toolMessages);

  return { messages, pingPongLoopDetected, postCompactionLoopDetected, toolCallCount };
}

export async function executeModelLoop(
  runner: ModelLoopRunner,
  context: AgentRunContext,
  provider: ModelProvider,
  request: ModelRequest
): Promise<ModelLoopExecution> {
  const intermediateMessages: ModelMessage[] = [];
  const toolResults: ExecutedToolResult[] = [];
  const toolsUsed: string[] = [];
  let messages: readonly ModelMessage[] = [...request.messages];
  const anchorTerms = deriveAnchorTerms(request.messages);
  let toolCallCount = 0;
  const deduplicator = new ToolCallDeduplicator();
  seedDeduplicatorFromHistory(deduplicator, messages, request.tools);
  const progress = new ToolLoopProgressTracker();
  const failureStreak = new ToolFailureStreakTracker();
  const shellPhase = new GeneralShellPhaseGate((request.tools ?? []).map((tool) => tool.name));
  const reverify = new ReverifyNudgeTracker();
  const budgetExhaustion = new BudgetExhaustionTracker();
  const postCompactionGuard = new PostCompactionLoopGuard();
  if (runner.compactionOccurred) postCompactionGuard.arm();
  const pingPong = new PingPongLoopGuard();
  const reverifyRunIntent = hasRunVerifyIntent(request.messages);
  const now = runner.now ?? Date.now;
  const deadlineMs = runner.maxRunWallclockMs && runner.maxRunWallclockMs > 0
    ? now() + runner.maxRunWallclockMs
    : undefined;

  while (true) {
    // Cooperative interrupt: a caller-aborted signal stops the loop cleanly
    // here — before any further model call or tool — and returns what we have.
    if (context.input.signal?.aborted) {
      return interruptedExecution(request, intermediateMessages, toolResults, toolsUsed);
    }
    // Wall-clock deadline cuts the loop short BEFORE the next model
    // call — disables tools for the final synthesis turn so the
    // model returns a clean response instead of asking for another
    // tool we'd refuse. Honours the "explicit limits and timeouts"
    // non-negotiable from CLAUDE.md.
    // No-progress early-exit (arXiv:2505.17616): a stalled read loop (the last
    // window observations near-identical) also disables tools → forces a clean
    // synthesis instead of burning the rest of the budget on spin.
    const wallclockExceeded = deadlineMs !== undefined && now() > deadlineMs;
    // Tool-failure-streak circuit breaker (arXiv:2509.25370): a tool that has
    // failed N times in a row is withheld for the next turn (the model keeps its
    // OTHER tools) so a cascading tool failure can't burn the whole budget.
    const activeTools = (!wallclockExceeded && toolCallCount < runner.maxToolCalls && !progress.stalled())
      ? request.tools?.filter((t) => !failureStreak.tripped(t.name) && !shellPhase.withholds(t.name))
      : [];
    // Budget-exhaustion notice: gated strictly on toolCallCount having hit
    // maxToolCalls (never on wallclock/stall, which also empty activeTools) so
    // the upcoming no-tools turn TELLS the model why instead of it silently
    // producing a truncated answer or describing calls it can no longer make.
    // Fired BEFORE the call it applies to (not after, like the reverify nudge)
    // — there is no tool left to re-enable, so there's nothing to gain from
    // discarding an already-good answer and asking for a second one.
    if (toolCallCount >= runner.maxToolCalls && budgetExhaustion.consumeNotice()) {
      messages = [...messages, { content: budgetExhaustionNotice(toolCallCount, runner.maxToolCalls), role: "user" }];
    }
    // Stale-observation masking (The Complexity Trap arXiv:2508.21433 +
    // ACON arXiv:2510.00615): rewrite PRIOR turns' tool outputs to a
    // re-fetchable placeholder so multi-turn context stops growing —
    // the latest turn stays full, nothing is dropped (every masked
    // observation is stashed in the ref store, re-fetchable by id).
    // No-op on the first turn (no prior tool messages) and when no ref
    // store is configured.
    messages = maskStaleToolObservations(messages, {
      ...(runner.contextReferenceStore ? { refStore: runner.contextReferenceStore } : {})
    }).messages;
    const response = await runner.generateWithTracing(context, provider, {
      ...request,
      messages,
      tools: activeTools
    });
    const calls = response.toolCalls ?? [];

    if (calls.length === 0 || (activeTools?.length ?? 0) === 0) {
      // Re-verification nudge: the model is finishing, but if it edited a file
      // and never re-ran a verifying command (and tools are still live so it
      // can), prompt it ONCE to re-run before answering — a reported failure can
      // hide a second one that only surfaces after the first is fixed and re-run.
      if (
        (activeTools?.length ?? 0) > 0 &&
        reverify.consumeNudge({ hasExecuteTool: toolsIncludeExecute(activeTools), runIntent: reverifyRunIntent })
      ) {
        messages = [...messages, { content: REVERIFY_NUDGE, role: "user" }];
        continue;
      }
      return {
        finalResponse: response,
        intermediateMessages,
        toolResults,
        toolsUsed: [...new Set(toolsUsed)]
      };
    }

    const assistantMessage: ModelMessage = {
      content: response.output,
      role: "assistant",
      toolCalls: calls
    };

    const batch = runToolBatch(
      runner,
      context,
      calls,
      activeTools,
      assistantMessage,
      intermediateMessages,
      toolResults,
      toolsUsed,
      { deduplicator, failureStreak, pingPong, postCompactionGuard, progress, reverify, shellPhase },
      { anchorTerms, deadlineMs, messages, now, toolCallCount }
    );
    // Blocking path: drain the per-batch generator without forwarding its
    // tool-result events; the streaming path yields them instead.
    let step = await batch.next();
    while (!step.done) {
      step = await batch.next();
    }
    messages = step.value.messages;
    toolCallCount = step.value.toolCallCount;
    if (step.value.postCompactionLoopDetected) {
      return postCompactionAbortedExecution(request, intermediateMessages, toolResults, toolsUsed);
    }
    if (step.value.pingPongLoopDetected) {
      return pingPongAbortedExecution(request, intermediateMessages, toolResults, toolsUsed);
    }
    // Per-step checkpoint: the messages now include this batch's tool results, so a
    // crash before the next model call can resume from here without re-running tools.
    if (toolCallCount > 0) {
      await recordCheckpoint({ checkpointStore: runner.checkpointStore, context, messages, phase: "act", step: toolCallCount });
    }
  }
}

export async function* executeStreamingModelLoop(
  runner: ModelLoopRunner,
  context: AgentRunContext,
  provider: ModelProvider,
  request: ModelRequest,
  options: StreamExecutionOptions
): AsyncGenerator<ModelLoopStreamEvent, ModelLoopExecution, void> {
  const intermediateMessages: ModelMessage[] = [];
  const toolResults: ExecutedToolResult[] = [];
  const toolsUsed: string[] = [];
  let messages: readonly ModelMessage[] = [...request.messages];
  const anchorTerms = deriveAnchorTerms(request.messages);
  let toolCallCount = 0;
  const deduplicator = new ToolCallDeduplicator();
  seedDeduplicatorFromHistory(deduplicator, messages, request.tools);
  const progress = new ToolLoopProgressTracker();
  const failureStreak = new ToolFailureStreakTracker();
  const shellPhase = new GeneralShellPhaseGate((request.tools ?? []).map((tool) => tool.name));
  const reverify = new ReverifyNudgeTracker();
  const budgetExhaustion = new BudgetExhaustionTracker();
  const postCompactionGuard = new PostCompactionLoopGuard();
  if (runner.compactionOccurred) postCompactionGuard.arm();
  const pingPong = new PingPongLoopGuard();
  const reverifyRunIntent = hasRunVerifyIntent(request.messages);
  const now = runner.now ?? Date.now;
  const deadlineMs = runner.maxRunWallclockMs && runner.maxRunWallclockMs > 0
    ? now() + runner.maxRunWallclockMs
    : undefined;

  while (true) {
    if (context.input.signal?.aborted) {
      return interruptedExecution(request, intermediateMessages, toolResults, toolsUsed);
    }
    // No-progress early-exit (arXiv:2505.17616): a stalled read loop disables
    // tools for this turn → clean synthesis instead of spinning the budget.
    const wallclockExceeded = deadlineMs !== undefined && now() > deadlineMs;
    // Tool-failure-streak circuit breaker (arXiv:2509.25370): a tool that has
    // failed N times in a row is withheld for the next turn (the model keeps its
    // OTHER tools) so a cascading tool failure can't burn the whole budget.
    const activeTools = (!wallclockExceeded && toolCallCount < runner.maxToolCalls && !progress.stalled())
      ? request.tools?.filter((t) => !failureStreak.tripped(t.name) && !shellPhase.withholds(t.name))
      : [];
    // Budget-exhaustion notice — see executeModelLoop. Same one-shot gate,
    // strictly on toolCallCount hitting maxToolCalls, fired BEFORE the
    // no-tools call it applies to.
    if (toolCallCount >= runner.maxToolCalls && budgetExhaustion.consumeNotice()) {
      messages = [...messages, { content: budgetExhaustionNotice(toolCallCount, runner.maxToolCalls), role: "user" }];
    }
    // Stale-observation masking — see executeModelLoop. Same growing-
    // `messages` pattern in the streaming path, same fix.
    messages = maskStaleToolObservations(messages, {
      ...(runner.contextReferenceStore ? { refStore: runner.contextReferenceStore } : {})
    }).messages;
    const turnStream = streamModelTurn(runner, context, provider, {
      ...request,
      messages,
      tools: activeTools
    }, options);
    let next = await turnStream.next();

    while (!next.done) {
      yield next.value;
      next = await turnStream.next();
    }

    const response = next.value.response;
    const calls = response.toolCalls ?? [];

    if (calls.length === 0 || (activeTools?.length ?? 0) === 0) {
      // Re-verification nudge: the model is finishing, but if it edited a file
      // and never re-ran a verifying command (and tools are still live so it
      // can), prompt it ONCE to re-run before answering — a reported failure can
      // hide a second one that only surfaces after the first is fixed and re-run.
      if (
        (activeTools?.length ?? 0) > 0 &&
        reverify.consumeNudge({ hasExecuteTool: toolsIncludeExecute(activeTools), runIntent: reverifyRunIntent })
      ) {
        messages = [...messages, { content: REVERIFY_NUDGE, role: "user" }];
        continue;
      }
      return {
        finalResponse: response,
        intermediateMessages,
        toolResults,
        toolsUsed: [...new Set(toolsUsed)]
      };
    }

    const assistantMessage: ModelMessage = {
      content: response.output,
      role: "assistant",
      toolCalls: calls
    };

    const batchResult = yield* runToolBatch(
      runner,
      context,
      calls,
      activeTools,
      assistantMessage,
      intermediateMessages,
      toolResults,
      toolsUsed,
      { deduplicator, failureStreak, pingPong, postCompactionGuard, progress, reverify, shellPhase },
      { anchorTerms, deadlineMs, messages, now, toolCallCount }
    );
    messages = batchResult.messages;
    toolCallCount = batchResult.toolCallCount;
    if (batchResult.postCompactionLoopDetected) {
      return postCompactionAbortedExecution(request, intermediateMessages, toolResults, toolsUsed);
    }
    if (batchResult.pingPongLoopDetected) {
      return pingPongAbortedExecution(request, intermediateMessages, toolResults, toolsUsed);
    }
    // Per-step checkpoint (streaming parity): resume mid-loop after a crash without
    // re-running already-completed tools (their results are in the replayed messages).
    if (toolCallCount > 0) {
      await recordCheckpoint({ checkpointStore: runner.checkpointStore, context, messages, phase: "act", step: toolCallCount });
    }
  }
}

/**
 * Re-seed the tool-call deduplicator from ALREADY-COMPLETED tool calls in the
 * initial messages, so a RESUMED run (resumeRunInputFromCheckpoint replays the
 * finished tool calls + their results) won't RE-EXECUTE a side-effecting tool — a
 * re-issued identical call returns the cached result instead of sending the message
 * / booking again. The deduplicator is otherwise in-memory and reset on resume,
 * leaving this anti-double-execution guard blind across a crash. A normal (non-
 * resume) run has no completed tool calls in its initial messages, so this is a
 * no-op there. Mutating-ness comes from the tool's risk (write/execute), matching
 * the live path so read-invalidation-on-write is reconstructed identically.
 */
export function seedDeduplicatorFromHistory(
  deduplicator: ToolCallDeduplicator,
  messages: readonly ModelMessage[],
  tools: readonly ModelTool[] | undefined
): void {
  const outputById = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) outputById.set(message.toolCallId, message.content);
  }
  if (outputById.size === 0) return; // no finished tool calls in the history — nothing to reconstruct
  const riskByName = new Map((tools ?? []).map((tool) => [tool.name, tool.risk]));
  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls) continue;
    for (const toolCall of message.toolCalls) {
      const output = toolCall.id ? outputById.get(toolCall.id) : undefined;
      if (output === undefined) continue; // an unanswered call (the crash point) — leave it runnable
      const risk = riskByName.get(toolCall.name);
      deduplicator.record(
        toolCall,
        { id: toolCall.id, name: toolCall.name, output, status: "completed" },
        risk === "write" || risk === "execute"
      );
    }
  }
}

/**
 * Default idle cut for the streaming path (3 min). Split out to
 * ./stream-idle-timeout.js; re-exported here so the direct-path tests
 * (test/stream-idle-timeout.test.ts) keep importing from ../src/model-loop.js.
 */
export { DEFAULT_STREAM_IDLE_TIMEOUT_MS, withStreamIdleTimeout } from "./stream-idle-timeout.js";

async function* streamModelTurn(
  runner: ModelLoopRunner,
  context: AgentRunContext,
  provider: ModelProvider,
  request: ModelRequest,
  options: StreamExecutionOptions
): AsyncGenerator<ModelLoopStreamEvent, StreamedModelTurn, void> {
  const span = runner.tracer.startSpan("muse.model.stream", {
    "model.id": request.model,
    "provider.id": provider.id,
    "run.id": context.runId
  });
  const toolCalls = new Map<string, ModelToolCall>();
  let streamedOutput = "";
  let response: ModelResponse | undefined;

  // The loop records its own usage via recordTokenUsageEvent below; flag the
  // request so a usage-recording provider decorator skips it (no double-count).
  const flaggedRequest: ModelRequest = { ...request, metadata: { ...request.metadata, [USAGE_RECORDED_BY_RUNTIME_FLAG]: true } };

  const idleMs = runner.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  try {
    for await (const event of withStreamIdleTimeout(provider.stream(flaggedRequest), idleMs, provider.id)) {
      if (event.type === "text-delta") {
        streamedOutput += event.text;
        emitHeartbeat(runner, context.runId);
        if (options.forwardTextDeltas) {
          yield { ...event, runId: context.runId };
        }
        continue;
      }

      if (event.type === "tool-call") {
        toolCalls.set(event.toolCall.id, event.toolCall);
        emitHeartbeat(runner, context.runId);
        yield { ...event, runId: context.runId };
        continue;
      }

      if (event.type === "tool-call-started" || event.type === "tool-call-finished" || event.type === "citations") {
        yield { ...event, runId: context.runId };
        continue;
      }

      if (event.type === "error") {
        span.setError(event.error);
        yield { ...event, runId: context.runId };
        throw event.error;
      }

      if (event.type !== "done") {
        continue;
      }

      for (const toolCall of event.response.toolCalls ?? []) {
        if (!toolCalls.has(toolCall.id)) {
          toolCalls.set(toolCall.id, toolCall);
          yield { runId: context.runId, toolCall, type: "tool-call" };
        }
      }

      response = {
        ...event.response,
        output: event.response.output || streamedOutput,
        toolCalls: toolCalls.size > 0 ? [...toolCalls.values()] : event.response.toolCalls
      };
      recordUsageSpanAttributes(span, response);

      if (response.usage) {
        runner.metrics.recordTokenUsage(response.usage, context.input.metadata);
        await recordTokenUsageEvent({
          provider,
          response,
          runId: context.runId,
          stepType: "act",
          ...(runner.tokenUsageSink ? { tokenUsageSink: runner.tokenUsageSink } : {}),
          tracer: runner.tracer
        });
      }
    }

    return {
      response: applyCitationSanitisation(response ?? {
        id: `${context.runId}:stream`,
        model: request.model,
        output: streamedOutput,
        toolCalls: toolCalls.size > 0 ? [...toolCalls.values()] : undefined
      })
    };
  } catch (error) {
    span.setError(error);
    throw error;
  } finally {
    span.end();
  }
}


/**
 * Per-tool-result output capping. Split out to ./tool-output-cap.js;
 * re-exported here so the direct-path test (test/cap-tool-output.test.ts)
 * keeps importing from ../src/model-loop.js.
 */
export { capToolOutput, deriveAnchorTerms } from "./tool-output-cap.js";
