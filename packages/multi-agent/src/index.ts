import type { AgentRunInput, AgentRunResult, AgentRuntime } from "@muse/agent-core";
import type { ModelMessage } from "@muse/model";
import { createRunId, type JsonObject } from "@muse/shared";
import type { AgentMessage, AgentMessageBus } from "./agent-message-bus.js";
import type { OrchestrationHistoryEntry, OrchestrationHistoryStore } from "./orchestration-history.js";

export type { AgentMessage, AgentMessageBus, AgentMessageHandler, InMemoryAgentMessageBusOptions } from "./agent-message-bus.js";
export { InMemoryAgentMessageBus } from "./agent-message-bus.js";
export type {
  InMemoryOrchestrationHistoryStoreOptions,
  OrchestrationHistoryEntry,
  OrchestrationHistoryStore,
  OrchestrationHistorySummary
} from "./orchestration-history.js";
export { InMemoryOrchestrationHistoryStore } from "./orchestration-history.js";

export interface AgentWorker {
  readonly id: string;
  readonly description: string;
  canHandle(input: AgentRunInput): number;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

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

export type OrchestrationMode = "sequential" | "parallel";

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

export class NoAgentWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAgentWorkerError";
  }
}

export class RuntimeAgentWorker implements AgentWorker {
  constructor(
    readonly id: string,
    readonly description: string,
    private readonly runtime: AgentRuntime,
    private readonly matcher: (input: AgentRunInput) => number
  ) {}

  canHandle(input: AgentRunInput): number {
    return this.matcher(input);
  }

  run(input: AgentRunInput): Promise<AgentRunResult> {
    return this.runtime.run(input);
  }
}

export class RuleBasedAgentWorker implements AgentWorker {
  private readonly keywords: readonly string[];

  constructor(
    readonly id: string,
    readonly description: string,
    keywords: readonly string[],
    private readonly handler: (input: AgentRunInput) => Promise<AgentRunResult> | AgentRunResult
  ) {
    this.keywords = keywords.map((keyword) => keyword.toLowerCase());
  }

  canHandle(input: AgentRunInput): number {
    const text = joinMessages(input.messages).toLowerCase();
    const matched = this.keywords.filter((keyword) => text.includes(keyword)).length;
    return this.keywords.length === 0 ? 0 : matched / this.keywords.length;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    return this.handler(input);
  }
}

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
      .sort((left, right) => right.confidence - left.confidence);
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

  constructor(options: {
    readonly workers: readonly AgentWorker[];
    readonly idFactory?: () => string;
    readonly messageBus?: AgentMessageBus;
    readonly historyStore?: OrchestrationHistoryStore;
    readonly clock?: () => Date;
  }) {
    if (options.workers.length === 0) {
      throw new NoAgentWorkerError("MultiAgentOrchestrator requires at least one worker");
    }

    this.workers = options.workers;
    this.idFactory = options.idFactory ?? (() => createRunId("multi_agent_orchestration"));
    this.messageBus = options.messageBus;
    this.historyStore = options.historyStore;
    this.clock = options.clock ?? (() => new Date());
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
      results = mode === "parallel"
        ? await this.runParallel({ ...input, runId }, selectedWorkers)
        : await this.runSequential({ ...input, runId }, selectedWorkers);
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

    const completedCount = results.filter((step) => step.status === "completed").length;
    this.recordHistory({
      completedCount,
      failedCount: results.length - completedCount,
      finishedAt: this.clock(),
      mode,
      runId,
      startedAt,
      status: "completed",
      workerCount: selectedWorkers.length
    });

    return {
      mode,
      response: buildOrchestrationResponse(runId, input.model, results),
      results,
      runId
    };
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
        const result = await worker.run(withSelectedWorker(currentInput, worker.id));
        results.push({ result, status: "completed", workerId: worker.id });
        await this.publishWorkerResult(worker.id, result);
        currentInput = addWorkerResultMessage(currentInput, worker.id, result.response.output);
      } catch (error) {
        results.push({ error: errorMessage(error), status: "failed", workerId: worker.id });
        await this.publishWorkerFailure(worker.id, error);
        currentInput = addHandoffMessage(currentInput, worker.id, error);
      }
    }

    return results;
  }

  private async runParallel(input: AgentRunInput, workers: readonly AgentWorker[]): Promise<readonly OrchestrationStepResult[]> {
    return Promise.all(workers.map(async (worker): Promise<OrchestrationStepResult> => {
      try {
        const result = await worker.run(withSelectedWorker(input, worker.id));
        await this.publishWorkerResult(worker.id, result);
        return { result, status: "completed", workerId: worker.id };
      } catch (error) {
        await this.publishWorkerFailure(worker.id, error);
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

export function createWorkerResult(
  workerId: string,
  output: string,
  input: AgentRunInput,
  metadata: JsonObject = {}
): AgentRunResult {
  return {
    response: {
      id: createRunId("response"),
      model: input.model,
      output,
      raw: metadata
    },
    runId: input.runId ?? createRunId(workerId)
  };
}

function withSelectedWorker(input: AgentRunInput, workerId: string): AgentRunInput {
  return {
    ...input,
    metadata: {
      ...input.metadata,
      selectedAgentId: workerId
    }
  };
}

function addWorkerResultMessage(input: AgentRunInput, workerId: string, output: string): AgentRunInput {
  const message: ModelMessage = {
    content: `Worker '${workerId}' completed:\n${output}`,
    role: "system"
  };

  return {
    ...input,
    messages: [message, ...input.messages]
  };
}

function addHandoffMessage(input: AgentRunInput, workerId: string, error: unknown): AgentRunInput {
  const message: ModelMessage = {
    content: `Worker '${workerId}' failed: ${errorMessage(error)}`,
    role: "system"
  };

  return {
    ...input,
    messages: [message, ...input.messages]
  };
}

function joinMessages(messages: readonly ModelMessage[]): string {
  return messages.map((message) => message.content).join("\n");
}

function buildOrchestrationResponse(
  runId: string,
  model: string,
  results: readonly OrchestrationStepResult[]
): AgentRunResult["response"] {
  const output = results
    .map((result) =>
      result.status === "completed"
        ? `## ${result.workerId}\n${result.result?.response.output ?? ""}`
        : `## ${result.workerId}\nError: ${result.error ?? "unknown error"}`
    )
    .join("\n\n");

  return {
    id: createRunId("multi_agent_response"),
    model,
    output,
    raw: {
      runId,
      workers: results.map((result) => ({
        status: result.status,
        workerId: result.workerId
      }))
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
