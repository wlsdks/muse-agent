import type { AgentRunInput, AgentRunResult } from "@muse/agent-core";
import { neutralizeInjectionSpans } from "@muse/agent-core";
import type { ModelMessage } from "@muse/model";
import { clamp, createRunId, type JsonObject, withBestEffort } from "@muse/shared";
import type { AgentMessage, AgentMessageBus } from "./agent-message-bus.js";
import type { OrchestrationHistoryEntry, OrchestrationHistoryStore } from "./orchestration-history.js";
import {
  buildOrchestrationResponse,
  errorMessage,
  objectiveFromInput,
  withDeadline
} from "./orchestration-fan-in.js";
import type {
  HandoffDecision,
  MultiAgentOrchestrationResult,
  MultiAgentRunResult,
  OrchestrationMode,
  OrchestrationRunOptions,
  OrchestrationStepResult,
  SupervisorOptions
} from "./index.js";
import { parseWorkerResult, validateWorkerHandoff } from "./worker-result.js";
import { type AgentWorker, NoAgentWorkerError } from "./workers.js";
import type { SubAgentRunRegistry } from "./subagent-run-registry.js";
import type { BackgroundOrchestrationHandle, BackgroundOrchestrationStore } from "./background-orchestration.js";

export class SupervisorAgent {
  private readonly workers: readonly AgentWorker[];
  private readonly defaultWorkerId?: string;
  private readonly minConfidence: number;
  private readonly maxHandoffs: number;
  private readonly idFactory: () => string;

  constructor(options: SupervisorOptions) {
    if (options.workers.length === 0) {
      throw new NoAgentWorkerError("SupervisorAgent requires at least one worker");
    }

    this.workers = options.workers;
    this.defaultWorkerId = options.defaultWorkerId;
    this.minConfidence = options.minConfidence ?? 0.1;
    this.maxHandoffs = options.maxHandoffs ?? 3;
    this.idFactory = options.idFactory ?? (() => createRunId("multi_agent"));
  }

  selectWorker(input: AgentRunInput, excludedIds: ReadonlySet<string> = new Set()): HandoffDecision {
    const ranked = this.workers
      .filter((worker) => !excludedIds.has(worker.id))
      .map((worker) => ({
        confidence: clamp(worker.canHandle(input), 0, 1),
        worker
      }))
      .sort((left, right) => right.confidence - left.confidence || left.worker.id.localeCompare(right.worker.id));
    const best = ranked[0];

    if (best && best.confidence >= this.minConfidence) {
      return {
        confidence: best.confidence,
        reason: "highest-confidence-worker",
        to: best.worker.id
      };
    }

    const fallback = this.defaultWorkerId
      ? this.workers.find((worker) => worker.id === this.defaultWorkerId && !excludedIds.has(worker.id))
      : this.workers.find((worker) => !excludedIds.has(worker.id));

    if (!fallback) {
      throw new NoAgentWorkerError("No eligible worker remains for handoff");
    }

    return {
      confidence: best?.confidence ?? 0,
      reason: "default-worker",
      to: fallback.id
    };
  }

  async run(input: AgentRunInput): Promise<MultiAgentRunResult> {
    const runId = input.runId ?? this.idFactory();
    const handoffs: HandoffDecision[] = [];
    const excluded = new Set<string>();
    let currentInput: AgentRunInput = { ...input, runId };

    for (let attempt = 0; attempt <= this.maxHandoffs; attempt += 1) {
      const decision = this.selectWorker(currentInput, excluded);
      handoffs.push(decision);

      try {
        const worker = this.requireWorker(decision.to);
        const result = await worker.run({
          ...currentInput,
          metadata: {
            ...currentInput.metadata,
            selectedAgentId: worker.id
          }
        });

        const parsedResult = parseWorkerResult(result);
        if (!parsedResult.ok) {
          throw new NoAgentWorkerError(parsedResult.reason);
        }
        const handoff = validateWorkerHandoff(worker.id, result.response.output);
        if (!handoff.ok) {
          throw new NoAgentWorkerError(handoff.reason);
        }

        return {
          ...result,
          handoffs,
          runId: result.runId || runId,
          selectedAgentId: worker.id
        };
      } catch (error) {
        excluded.add(decision.to);

        if (attempt >= this.maxHandoffs || excluded.size >= this.workers.length) {
          throw error;
        }

        currentInput = addHandoffMessage(currentInput, decision.to, error);
      }
    }

    throw new NoAgentWorkerError("No worker completed the request");
  }

  private requireWorker(id: string): AgentWorker {
    const worker = this.workers.find((candidate) => candidate.id === id);

    if (!worker) {
      throw new NoAgentWorkerError(`Worker not found: ${id}`);
    }

    return worker;
  }
}

/** Thrown when a run stops because the user cancelled it — callers show "stopped", not "broke". */
export class OrchestrationCancelledError extends Error {
  constructor(runId: string) {
    super(`orchestration ${runId} cancelled by user`);
    this.name = "OrchestrationCancelledError";
  }
}

export class MultiAgentOrchestrator {
  private readonly workers: readonly AgentWorker[];
  private readonly idFactory: () => string;
  private readonly messageBus?: AgentMessageBus;
  private readonly historyStore?: OrchestrationHistoryStore;
  private readonly clock: () => Date;
  private readonly workerTimeoutMs?: number;
  private readonly runRegistry?: SubAgentRunRegistry;

  constructor(options: {
    readonly workers: readonly AgentWorker[];
    readonly idFactory?: () => string;
    readonly messageBus?: AgentMessageBus;
    readonly historyStore?: OrchestrationHistoryStore;
    readonly clock?: () => Date;
    /**
     * Live sub-agent run registry. When provided, the orchestration's parent
     * run and EACH spawned worker child run are registered, status-transitioned
     * (running → completed/failed/timed-out), and a hung worker becomes a
     * detectable `timed-out` record — so an orphaned/stalled child run is
     * observable BEFORE the orchestration finishes (distinct from the
     * finished-run audit in `historyStore`). Opt-in: omitted ⇒ no registration.
     */
    readonly runRegistry?: SubAgentRunRegistry;
    /**
     * Per-worker wall-clock deadline (ms). A worker whose run exceeds it is
     * marked `failed` (MAST "unaware of termination" — explicit termination of a
     * hung sub-agent) and the run proceeds with the survivors instead of hanging
     * forever. Opt-in: omitted ⇒ no deadline (legacy behavior). The deadline
     * bounds the WAIT, not the underlying compute — without provider-level
     * cancellation the abandoned call may still run; see backlog for the
     * AbortSignal follow-up.
     */
    readonly workerTimeoutMs?: number;
  }) {
    if (options.workers.length === 0) {
      throw new NoAgentWorkerError("MultiAgentOrchestrator requires at least one worker");
    }

    this.workers = options.workers;
    this.idFactory = options.idFactory ?? (() => createRunId("multi_agent_orchestration"));
    this.messageBus = options.messageBus;
    this.historyStore = options.historyStore;
    this.clock = options.clock ?? (() => new Date());
    this.workerTimeoutMs = options.workerTimeoutMs;
    this.runRegistry = options.runRegistry;
  }

  /**
   * Run a worker under the optional per-worker deadline. A hung worker rejects
   * at the deadline so the caller's existing catch marks it `failed` and the run
   * continues — the same path a throwing worker takes.
   */
  /** Cooperative cancel: the shared run registry carries the flag, so it
   *  reaches this run even though route handlers build a fresh orchestrator
   *  per request. */
  private isCancelled(runId: string): boolean {
    return this.runRegistry?.get(runId)?.status === "cancelled";
  }

  private async runWorkerWithDeadline(worker: AgentWorker, input: AgentRunInput): Promise<AgentRunResult> {
    return withDeadline(() => worker.run(input), this.workerTimeoutMs, `worker "${worker.id}"`);
  }

  async run(input: AgentRunInput, options: OrchestrationRunOptions = {}): Promise<MultiAgentOrchestrationResult> {
    const mode = options.mode ?? "sequential";
    const runId = input.runId ?? this.idFactory();
    const startedAt = this.clock();
    this.registerParentRun(runId);
    const selectedWorkers = this.selectWorkersOrRecordFailure(runId, mode, startedAt, options.workerIds, options.maxWorkers);
    return this.dispatchAndFinalize(runId, mode, selectedWorkers, { ...input, runId }, options, startedAt);
  }

  /**
   * Non-blocking twin of {@link run}: decompose + dispatch happen the same
   * way (selection, per-worker deadline, run registry), but the caller gets
   * a {@link BackgroundOrchestrationHandle} back SYNCHRONOUSLY — before any
   * worker has even started resolving — instead of awaiting the whole
   * fan-out. The consolidated result (the SAME fan-in shape `run` produces,
   * via the identical `dispatchAndFinalize` → `buildOrchestrationResponse`
   * path) is recorded to `store` exactly once, when the LAST worker settles.
   * A worker failure or a total-failure orchestration is captured as a
   * `"failed"` record — never a dangling, unobserved promise (MAST
   * "information withholding" / "unaware of termination").
   */
  runBackground(
    input: AgentRunInput,
    options: OrchestrationRunOptions = {},
    store?: BackgroundOrchestrationStore
  ): BackgroundOrchestrationHandle {
    const mode = options.mode ?? "sequential";
    const runId = input.runId ?? this.idFactory();
    const startedAt = this.clock();
    this.registerParentRun(runId);
    const selectedWorkers = this.selectWorkersOrRecordFailure(runId, mode, startedAt, options.workerIds, options.maxWorkers);
    const subtaskCount = selectedWorkers.length;
    const workerIds = selectedWorkers.map((worker) => worker.id);

    void (async () => {
      try {
        const result = await this.dispatchAndFinalize(runId, mode, selectedWorkers, { ...input, runId }, options, startedAt);
        store?.complete({
          finishedAt: this.clock(),
          orchestrationId: runId,
          response: result.response,
          results: result.results,
          status: "completed",
          subtaskCount,
          workerIds
        });
      } catch (error: unknown) {
        store?.complete({
          error: errorMessage(error),
          finishedAt: this.clock(),
          orchestrationId: runId,
          status: "failed",
          subtaskCount,
          workerIds
        });
      }
    })();

    return { orchestrationId: runId, subtaskCount };
  }

  /** Selection errors are recorded the same way for both the blocking and
   *  background paths — a bad `workerIds`/`maxWorkers` fails fast, before
   *  any dispatch, and is never silently absorbed into the background run. */
  private selectWorkersOrRecordFailure(
    runId: string,
    mode: OrchestrationMode,
    startedAt: Date,
    workerIds: readonly string[] | undefined,
    maxWorkers: number | undefined
  ): readonly AgentWorker[] {
    try {
      return this.selectWorkers(workerIds, maxWorkers);
    } catch (error) {
      this.runRegistry?.fail(runId, error instanceof Error ? error.message : "selection failed");
      this.recordHistory({
        completedCount: 0,
        failedCount: 0,
        finishedAt: this.clock(),
        mode,
        runId,
        startedAt,
        status: "failed",
        workerCount: 0,
        ...(error instanceof Error ? { error: error.message } : {})
      });
      throw error;
    }
  }

  /** Dispatch the selected workers and build the consolidated response — the
   *  ONE fan-out/fan-in body shared by `run` (awaited) and `runBackground`
   *  (chained off a detached promise). */
  private async dispatchAndFinalize(
    runId: string,
    mode: OrchestrationMode,
    selectedWorkers: readonly AgentWorker[],
    input: AgentRunInput,
    options: OrchestrationRunOptions,
    startedAt: Date
  ): Promise<MultiAgentOrchestrationResult> {
    let results: readonly OrchestrationStepResult[];
    try {
      if (mode === "parallel") {
        results = await this.runParallel(input, selectedWorkers);
      } else if (mode === "race") {
        // parked: resolves to sequential (see OrchestrationMode docs)
        results = await this.runSequential(input, selectedWorkers);
      } else {
        results = await this.runSequential(input, selectedWorkers);
      }
    } catch (error) {
      this.runRegistry?.fail(runId, error instanceof Error ? error.message : "orchestration failed");
      this.recordHistory({
        completedCount: 0,
        failedCount: selectedWorkers.length,
        finishedAt: this.clock(),
        mode,
        runId,
        startedAt,
        status: "failed",
        workerCount: selectedWorkers.length,
        ...(error instanceof Error ? { error: error.message } : {})
      });
      throw error;
    }

    if (this.isCancelled(runId)) {
      this.recordHistory({
        completedCount: results.filter((r) => r.status === "completed").length,
        error: "cancelled by user",
        failedCount: results.filter((r) => r.status === "failed").length,
        finishedAt: this.clock(),
        mode,
        runId,
        startedAt,
        status: "failed",
        workerCount: selectedWorkers.length
      });
      throw new OrchestrationCancelledError(runId);
    }

    if (!results.some((result) => result.status === "completed")) {
      const error = new NoAgentWorkerError("No worker completed the orchestration");
      this.runRegistry?.fail(runId, error.message);
      this.recordHistory({
        completedCount: 0,
        failedCount: results.length,
        finishedAt: this.clock(),
        mode,
        runId,
        startedAt,
        status: "failed",
        workerCount: selectedWorkers.length,
        error: error.message
      });
      throw error;
    }

    // Build the response BEFORE recording history so the coordination outcomes the
    // fan-in computed (cross-worker conflicts, objective-coverage verdict) are persisted
    // on the entry, not lost after the live response — a past run's "workers disagreed"
    // / "answer incomplete" stays queryable. (finishedAt now also covers synthesis time.)
    const response = await buildOrchestrationResponse(
      runId,
      input.model,
      results,
      options.maxOutputCharsPerWorker,
      options.summarizeWorkerOutput,
      options.synthesizeFinalAnswer,
      objectiveFromInput(input),
      options.verifyFinalAnswer,
      options.detectConflicts,
      options.detectRedundancies,
      this.workerTimeoutMs
    );
    const raw = response.raw as
      | { readonly conflicts?: readonly string[]; readonly redundancies?: readonly string[]; readonly verification?: { readonly satisfied: boolean } }
      | undefined;
    const completedCount = results.filter((step) => step.status === "completed").length;
    this.recordHistory({
      completedCount,
      failedCount: results.length - completedCount,
      finishedAt: this.clock(),
      mode,
      runId,
      startedAt,
      status: "completed",
      workerCount: selectedWorkers.length,
      ...(raw?.conflicts && raw.conflicts.length > 0 ? { conflicts: raw.conflicts } : {}),
      ...(raw?.redundancies && raw.redundancies.length > 0 ? { redundancies: raw.redundancies } : {}),
      ...(raw?.verification ? { verificationSatisfied: raw.verification.satisfied } : {})
    });
    this.runRegistry?.complete(runId, `${completedCount.toString()}/${results.length.toString()} workers completed`);

    return { mode, response, results, runId };
  }

  private registerParentRun(runId: string): void {
    if (!this.runRegistry || this.runRegistry.get(runId) !== undefined) {
      return;
    }
    this.runRegistry.register({ runId, ...(this.workerTimeoutMs ? { timeoutMs: this.workerTimeoutMs } : {}) });
  }

  /**
   * Register a spawned worker as a child run, run it, and transition its
   * registry record to a terminal status — `timed-out` when the per-worker
   * deadline fired (so a hung sub-agent is a detectable timed-out record),
   * else `failed` on any other error, `completed` on success. The worker's
   * own outcome (`AgentRunResult`) is returned unchanged; the registry side
   * effect never alters the orchestration result. Child run id namespaces the
   * worker under the parent so the same worker id across runs never collides.
   */
  private async runRegisteredWorker(parentRunId: string, worker: AgentWorker, input: AgentRunInput): Promise<AgentRunResult> {
    if (!this.runRegistry) {
      return this.runWorkerWithDeadline(worker, input);
    }
    const childRunId = `${parentRunId}::${worker.id}`;
    if (this.runRegistry.get(childRunId) === undefined) {
      this.runRegistry.register({
        runId: childRunId,
        parentRunId,
        ...(this.workerTimeoutMs ? { timeoutMs: this.workerTimeoutMs } : {})
      });
    }
    try {
      const result = await this.runWorkerWithDeadline(worker, input);
      this.runRegistry.complete(childRunId);
      return result;
    } catch (error) {
      const message = errorMessage(error);
      if (/exceeded the .* deadline/u.test(message)) {
        this.runRegistry.markTimedOut(childRunId, message);
      } else {
        this.runRegistry.fail(childRunId, message);
      }
      throw error;
    } finally {
      // A settled worker is real progress on the parent orchestration. Refresh
      // the PARENT run's heartbeat so its `lastHeartbeatAt` tracks liveness, not
      // just its start time — this is what keeps a per-run stall detector honest
      // (it measures idle-since-last-progress, so a long run that keeps finishing
      // workers is never mistaken for a hung one). No-op once the parent settles.
      this.runRegistry.heartbeat(parentRunId);
    }
  }

  private recordHistory(entry: Omit<OrchestrationHistoryEntry, "durationMs" | "conversation">): void {
    if (!this.historyStore) {
      return;
    }
    const conversation = this.messageBus?.getConversation() ?? [];
    this.historyStore.record({
      ...entry,
      durationMs: entry.finishedAt.getTime() - entry.startedAt.getTime(),
      ...(conversation.length > 0 ? { conversation: [...conversation] } : {})
    });
  }

  private selectWorkers(workerIds: readonly string[] | undefined, maxWorkers: number | undefined): readonly AgentWorker[] {
    const selected = workerIds
      ? workerIds.map((id) => this.requireWorker(id))
      : this.workers;
    const limit = Math.max(1, maxWorkers ?? selected.length);
    return selected.slice(0, limit);
  }

  /**
   * Run one worker to a terminal `OrchestrationStepResult`, publishing its
   * outcome on the message bus. Shared by `runSequential` and `runParallel` —
   * the only difference between the two callers is whether the next worker's
   * input is threaded (sequential) or every worker shares the same input
   * (parallel), which stays in the caller. `handoffOutput` is set on success
   * (sequential feeds it to `addWorkerResultMessage`); `failure` is set on
   * failure with the SAME error shape the previous inline code passed to
   * `addHandoffMessage` — a fresh `Error(reason)` for a parse/validate
   * rejection, the original caught error otherwise.
   */
  private async runWorkerStep(
    runId: string,
    worker: AgentWorker,
    workerInput: AgentRunInput
  ): Promise<{ step: OrchestrationStepResult; handoffOutput?: string; failure?: Error }> {
    try {
      const raw = await this.runRegisteredWorker(runId, worker, workerInput);
      const parsed = parseWorkerResult(raw);
      if (!parsed.ok) {
        const failure = new Error(parsed.reason);
      await withBestEffort(this.publishWorkerFailure(worker.id, failure), undefined);
        return { failure, step: { error: parsed.reason, status: "failed", workerId: worker.id } };
      }
      const result = parsed.result;
      const handoff = validateWorkerHandoff(worker.id, result.response.output);
      if (!handoff.ok) {
        const failure = new Error(handoff.reason);
        await withBestEffort(this.publishWorkerFailure(worker.id, failure), undefined);
        return { failure, step: { error: handoff.reason, status: "failed", workerId: worker.id } };
      }
      // A bus-publish failure must NOT re-trigger the catch (it would
      // double-push a `failed` entry for this worker and, for the sequential
      // caller, corrupt the pipeline input) — only worker.run decides status.
      // Same stance as runRace.
      await withBestEffort(this.publishWorkerResult(worker.id, result), undefined);
      return { handoffOutput: handoff.output, step: { result, status: "completed", workerId: worker.id } };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(errorMessage(error));
      await withBestEffort(this.publishWorkerFailure(worker.id, error), undefined);
      return { failure, step: { error: errorMessage(error), status: "failed", workerId: worker.id } };
    }
  }

  private async runSequential(input: AgentRunInput, workers: readonly AgentWorker[]): Promise<readonly OrchestrationStepResult[]> {
    const results: OrchestrationStepResult[] = [];
    let currentInput = input;

    for (const worker of workers) {
      if (this.isCancelled(input.runId!)) {
        results.push({ error: "cancelled before start", status: "failed", workerId: worker.id });
        continue;
      }
      const { step, handoffOutput, failure } = await this.runWorkerStep(
        input.runId!,
        worker,
        withSelectedWorker(currentInput, worker)
      );
      results.push(step);
      currentInput = failure
        ? addHandoffMessage(currentInput, worker.id, failure)
        : addWorkerResultMessage(currentInput, worker.id, handoffOutput!);
    }

    return results;
  }

  private async runParallel(input: AgentRunInput, workers: readonly AgentWorker[]): Promise<readonly OrchestrationStepResult[]> {
    return Promise.all(workers.map(async (worker): Promise<OrchestrationStepResult> => {
      const { step } = await this.runWorkerStep(input.runId!, worker, withSelectedWorker(input, worker));
      return step;
    }));
  }

  private async publishWorkerResult(workerId: string, result: AgentRunResult): Promise<void> {
    if (!this.messageBus) {
      return;
    }

    const metadata: JsonObject = {
      ...(result.toolsUsed && result.toolsUsed.length > 0 ? { toolsUsed: [...result.toolsUsed] } : {}),
      ...(result.fromCache ? { fromCache: true } : {})
    };

    const message: AgentMessage = {
      content: result.response.output,
      sourceAgentId: workerId,
      timestamp: new Date(),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {})
    };

    await this.messageBus.publish(message);
  }

  private async publishWorkerFailure(workerId: string, error: unknown): Promise<void> {
    if (!this.messageBus) {
      return;
    }

    await this.messageBus.publish({
      content: errorMessage(error),
      metadata: { status: "failed" },
      sourceAgentId: workerId,
      timestamp: new Date()
    });
  }

  private requireWorker(id: string): AgentWorker {
    const worker = this.workers.find((candidate) => candidate.id === id);

    if (!worker) {
      throw new NoAgentWorkerError(`Worker not found: ${id}`);
    }

    return worker;
  }
}

function withSelectedWorker(input: AgentRunInput, worker: AgentWorker): AgentRunInput {
  return {
    ...input,
    ...(worker.model ? { model: worker.model } : {}),
    metadata: {
      ...input.metadata,
      selectedAgentId: worker.id
    }
  };
}

function addWorkerResultMessage(input: AgentRunInput, workerId: string, output: string): AgentRunInput {
  // A prior worker that consumed a poisoned source can carry an embedded instruction
  // ("ignore previous instructions") or a forged `[from system]` citation. This output
  // is prepended as a SYSTEM-role message in the NEXT worker's prompt (sequential
  // handoff), so neutralize it here — the same funnel the fan-in already applies
  // (Prompt Infection, arXiv:2410.07283 / OWASP ASI07). Byte-identical on clean text.
  const message: ModelMessage = {
    content: `Worker '${workerId}' completed:\n${neutralizeInjectionSpans(output)}`,
    role: "system"
  };

  return {
    ...input,
    messages: [message, ...input.messages]
  };
}

function addHandoffMessage(input: AgentRunInput, workerId: string, error: unknown): AgentRunInput {
  // Sibling of addWorkerResultMessage: a failed worker's error text is also prepended
  // as a SYSTEM message in the next worker's prompt. Error strings are usually internal,
  // but a worker error can echo untrusted content (a tool error carrying its output), so
  // neutralize this funnel too (defense-in-depth, byte-identical on clean text).
  const message: ModelMessage = {
    content: `Worker '${workerId}' failed: ${neutralizeInjectionSpans(errorMessage(error))}`,
    role: "system"
  };

  return {
    ...input,
    messages: [message, ...input.messages]
  };
}
