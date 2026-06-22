import type { AgentRunInput, AgentRunResult } from "@muse/agent-core";
import { neutralizeInjectionSpans } from "@muse/agent-core";
import type { ModelMessage } from "@muse/model";
import { clamp, createRunId, type JsonObject } from "@muse/shared";
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
  OrchestrationRunOptions,
  OrchestrationStepResult,
  SupervisorOptions
} from "./index.js";
import { parseWorkerResult, validateWorkerHandoff } from "./worker-result.js";
import { type AgentWorker, NoAgentWorkerError } from "./workers.js";

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

export class MultiAgentOrchestrator {
  private readonly workers: readonly AgentWorker[];
  private readonly idFactory: () => string;
  private readonly messageBus?: AgentMessageBus;
  private readonly historyStore?: OrchestrationHistoryStore;
  private readonly clock: () => Date;
  private readonly workerTimeoutMs?: number;

  constructor(options: {
    readonly workers: readonly AgentWorker[];
    readonly idFactory?: () => string;
    readonly messageBus?: AgentMessageBus;
    readonly historyStore?: OrchestrationHistoryStore;
    readonly clock?: () => Date;
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
  }

  /**
   * Run a worker under the optional per-worker deadline. A hung worker rejects
   * at the deadline so the caller's existing catch marks it `failed` and the run
   * continues — the same path a throwing worker takes.
   */
  private async runWorkerWithDeadline(worker: AgentWorker, input: AgentRunInput): Promise<AgentRunResult> {
    return withDeadline(() => worker.run(input), this.workerTimeoutMs, `worker "${worker.id}"`);
  }

  async run(input: AgentRunInput, options: OrchestrationRunOptions = {}): Promise<MultiAgentOrchestrationResult> {
    const mode = options.mode ?? "sequential";
    const runId = input.runId ?? this.idFactory();
    const startedAt = this.clock();
    let selectedWorkers: readonly AgentWorker[];

    try {
      selectedWorkers = this.selectWorkers(options.workerIds, options.maxWorkers);
    } catch (error) {
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

    let results: readonly OrchestrationStepResult[];
    try {
      if (mode === "parallel") {
        results = await this.runParallel({ ...input, runId }, selectedWorkers);
      } else if (mode === "race") {
        // parked: resolves to sequential (see OrchestrationMode docs)
        results = await this.runSequential({ ...input, runId }, selectedWorkers);
      } else {
        results = await this.runSequential({ ...input, runId }, selectedWorkers);
      }
    } catch (error) {
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

    if (!results.some((result) => result.status === "completed")) {
      const error = new NoAgentWorkerError("No worker completed the orchestration");
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

    return { mode, response, results, runId };
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

  private async runSequential(input: AgentRunInput, workers: readonly AgentWorker[]): Promise<readonly OrchestrationStepResult[]> {
    const results: OrchestrationStepResult[] = [];
    let currentInput = input;

    for (const worker of workers) {
      try {
        const raw = await this.runWorkerWithDeadline(worker, withSelectedWorker(currentInput, worker));
        const parsed = parseWorkerResult(raw);
        if (!parsed.ok) {
          results.push({ error: parsed.reason, status: "failed", workerId: worker.id });
          await this.publishWorkerFailure(worker.id, new Error(parsed.reason)).catch(() => undefined);
          currentInput = addHandoffMessage(currentInput, worker.id, new Error(parsed.reason));
          continue;
        }
        const result = parsed.result;
        const handoff = validateWorkerHandoff(worker.id, result.response.output);
        if (!handoff.ok) {
          results.push({ error: handoff.reason, status: "failed", workerId: worker.id });
          await this.publishWorkerFailure(worker.id, new Error(handoff.reason)).catch(() => undefined);
          currentInput = addHandoffMessage(currentInput, worker.id, new Error(handoff.reason));
          continue;
        }
        results.push({ result, status: "completed", workerId: worker.id });
        // A bus-publish failure must NOT re-trigger the catch (it
        // would double-push a `failed` entry for this worker and
        // corrupt the pipeline input) — only worker.run decides
        // status. Same stance as runRace.
        await this.publishWorkerResult(worker.id, result).catch(() => undefined);
        currentInput = addWorkerResultMessage(currentInput, worker.id, handoff.output);
      } catch (error) {
        results.push({ error: errorMessage(error), status: "failed", workerId: worker.id });
        await this.publishWorkerFailure(worker.id, error).catch(() => undefined);
        currentInput = addHandoffMessage(currentInput, worker.id, error);
      }
    }

    return results;
  }

  private async runParallel(input: AgentRunInput, workers: readonly AgentWorker[]): Promise<readonly OrchestrationStepResult[]> {
    return Promise.all(workers.map(async (worker): Promise<OrchestrationStepResult> => {
      try {
        const raw = await this.runWorkerWithDeadline(worker, withSelectedWorker(input, worker));
        const parsed = parseWorkerResult(raw);
        if (!parsed.ok) {
          await this.publishWorkerFailure(worker.id, new Error(parsed.reason)).catch(() => undefined);
          return { error: parsed.reason, status: "failed", workerId: worker.id };
        }
        const result = parsed.result;
        const handoff = validateWorkerHandoff(worker.id, result.response.output);
        if (!handoff.ok) {
          await this.publishWorkerFailure(worker.id, new Error(handoff.reason)).catch(() => undefined);
          return { error: handoff.reason, status: "failed", workerId: worker.id };
        }
        // A bus-publish failure must not downgrade a succeeded
        // worker to "failed" or reject the whole Promise.all —
        // only worker.run decides status. Same stance as runRace.
        await this.publishWorkerResult(worker.id, result).catch(() => undefined);
        return { result, status: "completed", workerId: worker.id };
      } catch (error) {
        await this.publishWorkerFailure(worker.id, error).catch(() => undefined);
        return { error: errorMessage(error), status: "failed", workerId: worker.id };
      }
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
