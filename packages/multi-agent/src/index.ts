import type { AgentRunInput, AgentRunResult, AgentRuntime } from "@muse/agent-core";
import { trimToolOutput } from "@muse/memory";
import type { ModelMessage } from "@muse/model";
import { clamp, createRunId, type JsonObject } from "@muse/shared";
import { parseWorkerResult, validateWorkerHandoff } from "./worker-result.js";
export { createWorkerResult, parseWorkerResult, validateWorkerHandoff } from "./worker-result.js";
export type { ParsedWorkerResult, WorkerHandoff } from "./worker-result.js";
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
export type {
  ModelTier,
  PlanTieredRunArgs,
  TierModels,
  TieredAssignment,
  TieredRunPlan,
  TieredTask
} from "./tiering.js";
export { classifyTier, planTieredRun } from "./tiering.js";
export type { DecomposeDecision, DecomposedRequest, DecomposeSignals, Subtask } from "./decompose-trigger.js";
export { decomposeRequest, decomposeRequestWithKind, listHasBackReference, shouldDecompose, singleMarkerDependentSplit } from "./decompose-trigger.js";
export type {
  LeadWorkerDeps,
  LeadWorkerResult,
  SubtaskExecution,
  SubtaskOutput,
  SubtaskStatus,
  SynthesisVerdict
} from "./lead-worker.js";
export { dedupeSubtasks, detectSubtaskConflicts, runLeadWorkerTask, verifySynthesisCoverage } from "./lead-worker.js";

export interface AgentWorker {
  readonly id: string;
  readonly description: string;
  /**
   * Optional per-worker model override. When set, the orchestrator
   * dispatches this worker with `input.model` replaced by this value,
   * so a fast model can take a lookup while a high-capability model
   * takes the reasoning in the same run. Absent ⇒ the worker runs on
   * the run-default `input.model` (single-model behaviour unchanged).
   */
  readonly model?: string;
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
    private readonly matcher: (input: AgentRunInput) => number,
    readonly model?: string
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
    // Drop empty / whitespace-only keywords at construction. `text.includes("")`
    // is universally true, so a single blank slip would otherwise score confidence
    // > 0 against every input — silently inflating dispatch confidence.
    // Dedupe too — a duplicate keyword counts twice in the denominator AND the
    // numerator (when matched), shifting the ratio away from the operator's
    // intent (e.g. ["foo","foo","bar"] vs. text "foo" → 2/3 instead of 1/2).
    this.keywords = [...new Set(
      keywords
        .map((keyword) => keyword.toLowerCase().trim())
        .filter((keyword) => keyword.length > 0)
    )];
  }

  canHandle(input: AgentRunInput): number {
    const text = joinMessages(input.messages).toLowerCase();
    const matched = this.keywords.filter((keyword) => containsKeywordWithBoundary(text, keyword)).length;
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
      response: await buildOrchestrationResponse(
        runId,
        input.model,
        results,
        options.maxOutputCharsPerWorker,
        options.summarizeWorkerOutput,
        options.synthesizeFinalAnswer,
        objectiveFromInput(input),
        options.verifyFinalAnswer
      ),
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
        const raw = await worker.run(withSelectedWorker(currentInput, worker));
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
        const raw = await worker.run(withSelectedWorker(input, worker));
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

/** The user's request to verify the final answer against — the latest user turn,
 *  or the whole transcript if there is none. */
function objectiveFromInput(input: AgentRunInput): string {
  const lastUser = [...input.messages].reverse().find((message) => message.role === "user");
  return (lastUser?.content ?? joinMessages(input.messages)).trim();
}

// ASCII/Latin keywords must match on word boundaries — a raw substring
// lets a short keyword ("ai", "go", "db", "rag") fire inside unrelated
// words ("email", "ago", "fragment") and silently inflate dispatch
// confidence. CJK keywords keep substring matching: Korean
// agglutinates particles without spaces ("우선순위" inside
// "우선순위를"), where a word-boundary rule would wrongly miss the
// stem. Same posture as packages/policy/src/topic-drift.ts.
function containsKeywordWithBoundary(haystack: string, keyword: string): boolean {
  if (keyword.length === 0) {
    return false;
  }
  if (hasCjkCodePoint(keyword)) {
    return haystack.includes(keyword);
  }
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "u").test(haystack);
}

function hasCjkCodePoint(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0x3040 && cp <= 0x309f) ||
      (cp >= 0x30a0 && cp <= 0x30ff)
    ) {
      return true;
    }
  }
  return false;
}

async function buildOrchestrationResponse(
  runId: string,
  model: string,
  results: readonly OrchestrationStepResult[],
  maxOutputCharsPerWorker: number | undefined,
  summarizeWorkerOutput: ((workerId: string, output: string) => Promise<string>) | undefined,
  synthesizeFinalAnswer?: (parts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>, guidance?: string) => Promise<string>,
  objective?: string,
  verifyFinalAnswer?: (objective: string, output: string) => Promise<{ readonly satisfied: boolean; readonly missing?: string }>
): Promise<AgentRunResult["response"]> {
  const cap = maxOutputCharsPerWorker && maxOutputCharsPerWorker > 0 ? maxOutputCharsPerWorker : undefined;
  const projected = await Promise.all(results.map(async (result) => {
    if (result.status !== "completed") {
      return `## ${result.workerId}\nError: ${result.error ?? "unknown error"}`;
    }
    const raw = result.result?.response.output ?? "";
    const summarized = summarizeWorkerOutput
      ? await applyWorkerSummarizer(result.workerId, raw, summarizeWorkerOutput)
      : raw;
    return `## ${result.workerId}\n${capWorkerOutput(result.workerId, summarized, cap)}`;
  }));
  const concatenated = projected.join("\n\n");

  // Optional final-answer synthesis: fuse the completed workers into ONE
  // coherent answer. Fail-soft — a throwing / empty synthesizer keeps the
  // concatenation, so the orchestration never loses its output.
  const completedParts = results
    .filter((r) => r.status === "completed")
    .map((r) => ({ output: r.result?.response.output ?? "", workerId: r.workerId }));

  // Fuse the workers into one answer, optionally steered by `guidance` (the gap
  // the verifier found). Fail-soft — empty/throw keeps the prior output.
  const trySynthesize = async (guidance?: string): Promise<string | undefined> => {
    if (!synthesizeFinalAnswer || completedParts.length === 0) {
      return undefined;
    }
    try {
      const s = await synthesizeFinalAnswer(completedParts, guidance);
      return typeof s === "string" && s.trim().length > 0 ? s : undefined;
    } catch {
      return undefined;
    }
  };

  let output = (await trySynthesize()) ?? concatenated;

  // Verify against the original objective, then the evaluator-OPTIMIZER half: on an
  // incomplete verdict, RE-SYNTHESISE ONCE with the missing piece as guidance and
  // re-verify — MAST's +15.6% is catch AND fix, not just flag. The answer is only
  // marked incomplete if it's STILL missing something after the single retry (bounded
  // — small-model coherence degrades past 2 hops). Fail-soft throughout.
  let verification: { readonly satisfied: boolean; readonly missing?: string } | undefined;
  if (verifyFinalAnswer && objective && objective.trim().length > 0 && output.trim().length > 0) {
    try {
      let verdict = await verifyFinalAnswer(objective, output);
      if (!verdict.satisfied && verdict.missing && verdict.missing.trim().length > 0) {
        const fixed = await trySynthesize(`Make sure the final answer also fully covers: ${verdict.missing.trim()}`);
        if (fixed && fixed.trim() !== output.trim()) {
          output = fixed;
          verdict = await verifyFinalAnswer(objective, output);
        }
      }
      verification = verdict.missing ? { missing: verdict.missing, satisfied: verdict.satisfied } : { satisfied: verdict.satisfied };
      if (!verdict.satisfied) {
        const gap = verdict.missing?.trim();
        output = `${output}\n\n⚠ This answer may be incomplete${gap ? ` — still missing: ${gap}` : "."}`;
      }
    } catch {
      // keep the answer; verification is best-effort
    }
  }

  return {
    id: createRunId("multi_agent_response"),
    model,
    output,
    raw: {
      runId,
      workers: results.map((result) => ({
        status: result.status,
        workerId: result.workerId
      })),
      ...(verification ? { verification } : {})
    }
  };
}

async function applyWorkerSummarizer(
  workerId: string,
  output: string,
  summarize: (workerId: string, output: string) => Promise<string>
): Promise<string> {
  if (output.length === 0) {
    return output;
  }
  try {
    const summary = await summarize(workerId, output);
    return typeof summary === "string" && summary.length > 0 ? summary : output;
  } catch {
    return output;
  }
}

function capWorkerOutput(workerId: string, output: string, cap: number | undefined): string {
  if (!cap) {
    return output;
  }
  return trimToolOutput(output, {
    hint: `agent ${workerId} output trimmed by orchestrator fan-in`,
    maxChars: cap
  }).output;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

