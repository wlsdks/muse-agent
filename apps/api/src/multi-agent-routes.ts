import { Readable } from "node:stream";
import { summarizeTokenConfidence, type AgentRunInput, type AgentRunResult, type AgentRuntime } from "@muse/agent-core";
import type { AgentSpec, AgentSpecRegistry } from "@muse/agent-specs";
import {
  InMemoryAgentMessageBus,
  InMemoryOrchestrationHistoryStore,
  MultiAgentOrchestrator,
  SubAgentRunRegistry,
  detectFanInConflicts,
  detectFanInRedundancy,
  planTieredRun,
  runCascade,
  type AgentMessage,
  type AgentWorker,
  type MultiAgentOrchestrationResult,
  type OrchestrationHistoryStore,
  type OrchestrationMode,
  type TierModels
} from "@muse/multi-agent";
import type { ModelMessage, ModelProvider } from "@muse/model";
import type { JsonObject } from "@muse/shared";
import type { FastifyInstance } from "fastify";
import { createAnswerVerifier, createWorkerSummarizer, createWorkerSynthesizer } from "./multi-agent-workers.js";

export interface MultiAgentRouteOptions {
  readonly agentRuntime?: AgentRuntime;
  readonly agentSpecRegistry: AgentSpecRegistry;
  readonly defaultModel?: string;
  readonly historyStore?: OrchestrationHistoryStore;
  readonly modelProvider?: ModelProvider;
  readonly embed?: (text: string) => Promise<readonly number[]>;
  readonly runRegistry?: SubAgentRunRegistry;
  /**
   * Per-worker wall-clock deadline (ms) for an orchestration run. Threaded into
   * the orchestrator so a hung sub-agent is terminated and recorded `timed-out`
   * through the LIVE server, not just in constructor tests. Opt-in: omitted ⇒ no
   * deadline (legacy behavior). It is a HARD cap (not a no-progress timeout), so
   * it needs no heartbeat to be correct.
   */
  readonly workerTimeoutMs?: number;
}

interface ApiError {
  readonly code: string;
  readonly message: string;
}

interface OrchestrateBody {
  readonly message: string;
  readonly model?: string;
  readonly mode?: OrchestrationMode;
  readonly workerIds?: readonly string[];
  readonly maxWorkers?: number;
  readonly maxOutputCharsPerWorker?: number;
  readonly summarize?: boolean;
  readonly synthesize?: boolean;
  readonly verify?: boolean;
  readonly tiered?: boolean;
  /**
   * Dispatch the sub-agents without waiting for them — the handler returns
   * `202` with `{ orchestrationId, subtaskCount }` immediately instead of
   * blocking on the full fan-out. The consolidated result lands in
   * `historyStore` (same shape as the blocking path) the moment the last
   * worker settles; poll `GET /api/multi-agent/orchestrations/:runId`.
   */
  readonly background?: boolean;
}

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError };

export function registerMultiAgentRoutes(server: FastifyInstance, options: MultiAgentRouteOptions): void {
  const historyStore = options.historyStore ?? new InMemoryOrchestrationHistoryStore();
  const runRegistry = options.runRegistry ?? new SubAgentRunRegistry();

  server.get("/api/multi-agent/orchestrations", async (request, reply) => {
    const limitRaw = (request.query as { readonly limit?: string } | undefined)?.limit;
    let limit: number | undefined;

    if (limitRaw !== undefined) {
      // Strict-parse — `Number.parseInt("20x", 10)` returns 20 and
      // would pass the range check, so a typo'd `?limit=20x` /
      // unit-slip `?limit=5min` silently masqueraded as valid.
      const trimmed = limitRaw.trim();
      const parsed = /^\d+$/u.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000) {
        return reply.status(400).send({
          code: "INVALID_LIMIT",
          message: "limit must be an integer between 0 and 1000"
        } satisfies ApiError);
      }
      limit = parsed;
    }

    const entries = limit === undefined ? historyStore.list() : historyStore.list(limit);
    return {
      entries: entries.map((entry) => ({
        completedCount: entry.completedCount,
        durationMs: entry.durationMs,
        failedCount: entry.failedCount,
        finishedAt: entry.finishedAt.toISOString(),
        mode: entry.mode,
        runId: entry.runId,
        startedAt: entry.startedAt.toISOString(),
        status: entry.status,
        workerCount: entry.workerCount,
        ...(entry.conversation ? { conversationLength: entry.conversation.length } : { conversationLength: 0 }),
        ...(entry.error ? { error: entry.error } : {})
      })),
      total: entries.length
    };
  });

  server.get("/api/multi-agent/orchestrations/stats", async () => {
    return historyStore.summary();
  });

  // Live sub-agent run lifecycle (running runs + any stalled→timed-out
  // transitions), distinct from the finished-run audit above. Marking
  // stalled runs as timed-out on read makes a hung sub-agent observable
  // without a background sweep.
  server.get("/api/multi-agent/runs", async () => {
    const timedOut = runRegistry.markStalledAsTimedOut();
    return {
      activeCount: runRegistry.activeCount(),
      runs: runRegistry.list().map((run) => ({
        finishedAt: run.finishedAt?.toISOString(),
        lastHeartbeatAt: run.lastHeartbeatAt.toISOString(),
        parentRunId: run.parentRunId,
        runId: run.runId,
        startedAt: run.startedAt.toISOString(),
        status: run.status,
        ...(run.outcome ? { outcome: run.outcome } : {}),
        ...(run.error ? { error: run.error } : {})
      })),
      timedOutOnRead: timedOut.length
    };
  });

  server.get("/api/multi-agent/orchestrations/:runId", async (request, reply) => {
    const { runId } = request.params as { readonly runId: string };

    if (!runId || runId.length === 0) {
      return reply.status(400).send({
        code: "INVALID_RUN_ID",
        message: "runId path parameter is required"
      } satisfies ApiError);
    }

    const entry = historyStore.getByRunId(runId);

    if (!entry) {
      return reply.status(404).send({
        code: "ORCHESTRATION_NOT_FOUND",
        message: `Orchestration not found for runId: ${runId}`
      } satisfies ApiError);
    }

    return {
      completedCount: entry.completedCount,
      conversation: (entry.conversation ?? []).map((message) => ({
        content: message.content,
        sourceAgentId: message.sourceAgentId,
        timestamp: message.timestamp.toISOString(),
        ...(message.metadata ? { metadata: message.metadata } : {}),
        ...(message.targetAgentId ? { targetAgentId: message.targetAgentId } : {})
      })),
      durationMs: entry.durationMs,
      failedCount: entry.failedCount,
      finishedAt: entry.finishedAt.toISOString(),
      mode: entry.mode,
      runId: entry.runId,
      startedAt: entry.startedAt.toISOString(),
      status: entry.status,
      workerCount: entry.workerCount,
      ...(entry.conflicts && entry.conflicts.length > 0 ? { conflicts: entry.conflicts } : {}),
      ...(entry.redundancies && entry.redundancies.length > 0 ? { redundancies: entry.redundancies } : {}),
      ...(entry.verificationSatisfied !== undefined ? { verificationSatisfied: entry.verificationSatisfied } : {}),
      ...(entry.error ? { error: entry.error } : {})
    };
  });

  server.post("/api/multi-agent/orchestrate", async (request, reply) => {
    if (!options.agentRuntime) {
      return reply.status(503).send({
        code: "AGENT_RUNTIME_UNAVAILABLE",
        message: "Agent runtime is not configured"
      } satisfies ApiError);
    }

    const parsed = parseOrchestrateBody(request.body);

    if (!parsed.ok) {
      return reply.status(400).send(parsed.error);
    }

    const prepared = await prepareOrchestration(options, parsed.value, historyStore, runRegistry);

    if ("error" in prepared) {
      return reply.status(prepared.error.status).send(prepared.error.body);
    }

    const { messageBus, input, orchestrator, orchestrationOptions } = prepared;

    if (parsed.value.background === true) {
      try {
        const handle = orchestrator.runBackground(input, orchestrationOptions);
        return reply.status(202).send({
          background: true,
          orchestrationId: handle.orchestrationId,
          subtaskCount: handle.subtaskCount
        });
      } catch (error) {
        reply.log.error({ err: error }, "multi-agent background orchestration dispatch failed");
        return reply.status(500).send({
          code: "MULTI_AGENT_ORCHESTRATION_FAILED",
          message: "multi-agent orchestration failed"
        } satisfies ApiError);
      }
    }

    try {
      const orchestration = await orchestrator.run(input, orchestrationOptions);

      return {
        conversation: messageBus.getConversation().map(toConversationEntry),
        mode: orchestration.mode,
        response: {
          id: orchestration.response.id,
          model: orchestration.response.model,
          output: orchestration.response.output
        },
        ...readOrchestrationSignals(orchestration.response.raw),
        results: orchestration.results.map((step) => ({
          status: step.status,
          workerId: step.workerId,
          ...(step.result ? { model: step.result.response.model, output: step.result.response.output } : {}),
          ...(step.error ? { error: step.error } : {})
        })),
        runId: orchestration.runId
      };
    } catch (error) {
      // Server-side log only; the raw message can leak internals.
      reply.log.error({ err: error }, "multi-agent orchestration failed");
      return reply.status(500).send({
        code: "MULTI_AGENT_ORCHESTRATION_FAILED",
        message: "multi-agent orchestration failed"
      } satisfies ApiError);
    }
  });

  server.post("/api/multi-agent/orchestrate/stream", async (request, reply) => {
    if (!options.agentRuntime) {
      return reply.status(503).send({
        code: "AGENT_RUNTIME_UNAVAILABLE",
        message: "Agent runtime is not configured"
      } satisfies ApiError);
    }

    const parsed = parseOrchestrateBody(request.body);

    if (!parsed.ok) {
      return reply.status(400).send(parsed.error);
    }

    const prepared = await prepareOrchestration(options, parsed.value, historyStore, runRegistry);

    if ("error" in prepared) {
      return reply.status(prepared.error.status).send(prepared.error.body);
    }

    const { messageBus, input, orchestrator, orchestrationOptions, effectiveMode } = prepared;

    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache");
    reply.header("x-accel-buffering", "no");

    return reply.send(
      Readable.from(toMultiAgentSseStream({ messageBus, orchestrator, input, options: orchestrationOptions, mode: effectiveMode ?? "sequential" }))
    );
  });
}

interface PreparedOrchestrationError {
  readonly error: { readonly status: number; readonly body: ApiError };
}

type OrchestrationRunOptions = NonNullable<Parameters<MultiAgentOrchestrator["run"]>[1]>;

interface PreparedOrchestration {
  readonly messageBus: InMemoryAgentMessageBus;
  readonly input: AgentRunInput;
  readonly orchestrator: MultiAgentOrchestrator;
  readonly orchestrationOptions: OrchestrationRunOptions;
  readonly effectiveMode: OrchestrationMode | undefined;
}

// Shared setup for both /orchestrate handlers: spec selection, worker
// construction (incl. tiered), message bus, input, and orchestration
// options. Returns an `error` envelope (with the HTTP status the caller
// must send) instead of writing to `reply`, so the two handlers keep
// their distinct response shapes (JSON vs SSE) while sharing this body.
async function prepareOrchestration(
  options: MultiAgentRouteOptions,
  parsed: OrchestrateBody,
  historyStore: OrchestrationHistoryStore,
  runRegistry: SubAgentRunRegistry
): Promise<PreparedOrchestration | PreparedOrchestrationError> {
  const allSpecs = await options.agentSpecRegistry.listEnabled();
  const requestedIds = parsed.workerIds;
  const selected = requestedIds
    ? allSpecs.filter((spec) => requestedIds.includes(spec.name))
    : orderWorkersForPipeline(allSpecs);

  if (selected.length === 0) {
    return {
      error: {
        body: {
          code: "NO_AGENT_WORKERS",
          message: requestedIds
            ? "No enabled agent specs match the requested workerIds"
            : "No enabled agent specs are available to orchestrate"
        },
        status: 409
      }
    };
  }

  const messageBus = new InMemoryAgentMessageBus();
  const input: AgentRunInput = {
    messages: [{ content: parsed.message, role: "user" }],
    model: parsed.model ?? options.defaultModel ?? "default"
  };
  let workers: AgentWorker[];
  let effectiveMode = parsed.mode;
  if (parsed.tiered) {
    const tiered = await buildTieredOrchestration(
      selected,
      options.agentRuntime!,
      resolveOrchestrateTierModels(input.model, process.env),
      resolveTierCapacityProbe(process.env)
    );
    workers = tiered.workers;
    if (tiered.collapsedToHeavy) {
      effectiveMode = "sequential";
    }
  } else {
    workers = selected.map((spec) => createSpecWorker(spec, options.agentRuntime!));
  }
  const orchestrator = new MultiAgentOrchestrator({
    historyStore,
    messageBus,
    runRegistry,
    workers,
    ...(options.workerTimeoutMs !== undefined && options.workerTimeoutMs > 0
      ? { workerTimeoutMs: options.workerTimeoutMs }
      : {})
  });

  const summarizer = parsed.summarize === true
    ? createWorkerSummarizer(options.modelProvider, input.model)
    : undefined;
  const synthesizer = parsed.synthesize === true
    ? createWorkerSynthesizer(options.modelProvider, input.model)
    : undefined;
  const verifier = parsed.verify === true
    ? createAnswerVerifier(options.modelProvider, input.model)
    : undefined;
  const detectConflicts = options.embed
    ? (parts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>) =>
        detectFanInConflicts(parts, options.embed!)
    : undefined;
  const detectRedundancies = options.embed
    ? (parts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>) =>
        detectFanInRedundancy(parts, options.embed!)
    : undefined;
  const orchestrationOptions: OrchestrationRunOptions = {
    ...(effectiveMode ? { mode: effectiveMode } : {}),
    ...(parsed.maxWorkers !== undefined ? { maxWorkers: parsed.maxWorkers } : {}),
    ...(parsed.maxOutputCharsPerWorker !== undefined
      ? { maxOutputCharsPerWorker: parsed.maxOutputCharsPerWorker }
      : {}),
    ...(summarizer ? { summarizeWorkerOutput: summarizer } : {}),
    ...(synthesizer ? { synthesizeFinalAnswer: synthesizer } : {}),
    ...(verifier ? { verifyFinalAnswer: verifier } : {}),
    ...(detectConflicts ? { detectConflicts } : {}),
    ...(detectRedundancies ? { detectRedundancies } : {})
  };

  return { effectiveMode, input, messageBus, orchestrationOptions, orchestrator };
}

interface SseStreamArgs {
  readonly messageBus: InMemoryAgentMessageBus;
  readonly orchestrator: MultiAgentOrchestrator;
  readonly input: AgentRunInput;
  readonly options: {
    readonly mode?: OrchestrationMode;
    readonly maxWorkers?: number;
    readonly maxOutputCharsPerWorker?: number;
    readonly summarizeWorkerOutput?: (workerId: string, output: string) => Promise<string>;
  };
  readonly mode: OrchestrationMode;
}

/** Exported for direct test coverage of the unsubscribe lifecycle. */
export async function* toMultiAgentSseStream(args: SseStreamArgs): AsyncIterable<string> {
  const queue: AgentMessage[] = [];
  let resolveNext: (() => void) | undefined;

  args.messageBus.subscribe("__sse__", (message) => {
    queue.push(message);
    const resume = resolveNext;
    resolveNext = undefined;
    resume?.();
  });

  let result: MultiAgentOrchestrationResult | undefined;
  let runtimeError: unknown;
  let finished = false;

  const runPromise = args.orchestrator.run(args.input, args.options).then(
    (value) => {
      result = value;
      finished = true;
      resolveNext?.();
      resolveNext = undefined;
    },
    (error) => {
      runtimeError = error;
      finished = true;
      resolveNext?.();
      resolveNext = undefined;
    }
  );

  try {
    // Inside the try so an early consumer disconnect (generator
    // .return() suspended at the start frame) still runs `finally`
    // — otherwise the bus subscription + queue leak.
    yield `event: start\ndata: ${sseData(JSON.stringify({ mode: args.mode }))}\n\n`;

    while (!finished || queue.length > 0) {
      if (queue.length === 0 && !finished) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
        continue;
      }

      const message = queue.shift();

      if (message) {
        yield `event: agent_message\ndata: ${sseData(
          JSON.stringify({
            content: message.content,
            sourceAgentId: message.sourceAgentId,
            timestamp: message.timestamp.toISOString(),
            ...(message.metadata ? { metadata: message.metadata } : {}),
            ...(message.targetAgentId ? { targetAgentId: message.targetAgentId } : {})
          })
        )}\n\n`;
      }
    }

    await runPromise;

    if (runtimeError) {
      yield `event: error\ndata: ${sseData(
        runtimeError instanceof Error ? runtimeError.message : String(runtimeError)
      )}\n\n`;
      return;
    }

    if (result) {
      yield `event: done\ndata: ${sseData(
        JSON.stringify({
          mode: result.mode,
          response: { id: result.response.id, model: result.response.model, output: result.response.output },
          ...readOrchestrationSignals(result.response.raw),
          results: result.results.map((step) => ({
            status: step.status,
            workerId: step.workerId,
            ...(step.result ? { output: step.result.response.output } : {}),
            ...(step.error ? { error: step.error } : {})
          })),
          runId: result.runId
        })
      )}\n\n`;
    }
  } finally {
    args.messageBus.clear();
  }
}

interface OrchestrationSignals {
  readonly conflicts?: readonly string[];
  readonly verification?: { readonly satisfied: boolean; readonly missing?: string };
}

/**
 * Surface the orchestrator's structured coordination signals (cross-worker conflicts,
 * objective-coverage verdict) from the opaque `response.raw` so a consumer can ACT on
 * them — not just read the human ⚠ line baked into the answer text. Defensive narrowing:
 * `raw` is typed `unknown`, and an empty/malformed shape yields no field (no noise).
 */
function readOrchestrationSignals(raw: unknown): OrchestrationSignals {
  if (typeof raw !== "object" || raw === null) return {};
  const record = raw as { readonly conflicts?: unknown; readonly verification?: unknown };
  const signals: { conflicts?: readonly string[]; verification?: { satisfied: boolean; missing?: string } } = {};

  if (
    Array.isArray(record.conflicts) &&
    record.conflicts.length > 0 &&
    record.conflicts.every((entry) => typeof entry === "string")
  ) {
    signals.conflicts = record.conflicts as readonly string[];
  }

  if (typeof record.verification === "object" && record.verification !== null) {
    const verdict = record.verification as { readonly satisfied?: unknown; readonly missing?: unknown };
    if (typeof verdict.satisfied === "boolean") {
      signals.verification = {
        satisfied: verdict.satisfied,
        ...(typeof verdict.missing === "string" ? { missing: verdict.missing } : {})
      };
    }
  }

  return signals;
}

function sseData(value: string): string {
  return value.split(/\r?\n/u).map((line) => (line.length > 0 ? line : " ")).join("\ndata: ");
}

/**
 * The per-worker deadline (ms) from `MUSE_MULTI_AGENT_WORKER_TIMEOUT_MS`, or
 * undefined when unset/invalid (⇒ no deadline). Strict positive-integer parse so
 * a typo (`30x`, `0`, negative) disables it rather than silently capping at a
 * wrong value — the same fail-safe stance as the orchestrations `?limit` parse.
 */
export function resolveWorkerTimeoutMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.MUSE_MULTI_AGENT_WORKER_TIMEOUT_MS?.trim();
  if (!raw || !/^\d+$/u.test(raw)) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveOrchestrateTierModels(defaultModel: string, env: NodeJS.ProcessEnv): TierModels {
  const fast = env.MUSE_FAST_MODEL?.trim();
  const heavy = env.MUSE_HEAVY_MODEL?.trim();
  return {
    fast: fast && fast.length > 0 ? fast : defaultModel,
    heavy: heavy && heavy.length > 0 ? heavy : defaultModel
  };
}

// Tiered orchestration classifies each worker by its spec's role
// A host that declares it can hold only one model at a time
// (`MUSE_TIER_SINGLE_MODEL_HOST` truthy) makes the capacity probe
// report `false`, so `planTieredRun` collapses a tiered run to the
// single heavy model sequentially instead of thrashing two large
// models. Default (unset) ⇒ both tiers may run.
export function resolveTierCapacityProbe(env: NodeJS.ProcessEnv): () => boolean {
  const single = env.MUSE_TIER_SINGLE_MODEL_HOST?.trim().toLowerCase();
  const canHoldBoth = !(single === "1" || single === "true" || single === "yes");
  return () => canHoldBoth;
}

export interface TieredOrchestration {
  readonly workers: AgentWorker[];
  readonly collapsedToHeavy: boolean;
}

// Tiered orchestration runs each worker on the model `planTieredRun`
// assigns from its spec role (`description`): a "look up / fetch" worker
// takes the fast model, an "analyze / plan" worker the heavy one — so
// one run spreads across both local tiers. When the capacity probe says
// the host can't hold both (or throws), the plan collapses every worker
// to the single heavy model (the caller then forces sequential mode).
// Default-heavy classification never downgrades an unrecognised role.
export async function buildTieredOrchestration(
  specs: readonly AgentSpec[],
  runtime: AgentRuntime,
  tierModels: TierModels,
  canHoldBothTiers: () => boolean | Promise<boolean>
): Promise<TieredOrchestration> {
  const plan = await planTieredRun({
    canHoldBothTiers,
    models: tierModels,
    tasks: specs.map((spec) => ({ id: spec.name, text: spec.description }))
  });
  const modelByName = new Map(plan.assignments.map((assignment) => [assignment.id, assignment.model]));
  const tierByName = new Map(plan.assignments.map((assignment) => [assignment.id, assignment.tier]));
  // Opt-in cascade (FrugalGPT, arXiv:2305.05176): a FAST-classified worker runs
  // the fast model first and escalates to heavy only when its answer is
  // low-confidence — accuracy-positive (a weak fast answer is never kept) and
  // off by default, so the plan is unchanged unless MUSE_TIERED_CASCADE is set.
  const cascade = process.env.MUSE_TIERED_CASCADE === "1" || process.env.MUSE_TIERED_CASCADE?.toLowerCase() === "true";
  return {
    collapsedToHeavy: plan.collapsedToHeavy,
    workers: specs.map((spec) =>
      cascade && !plan.collapsedToHeavy && tierByName.get(spec.name) === "fast"
        ? createCascadeWorker(spec, runtime, tierModels)
        : createSpecWorker(spec, runtime, modelByName.get(spec.name))
    )
  };
}

/**
 * A worker that runs `runCascade` over the agent runtime: the fast
 * model answers first with logprobs, `summarizeTokenConfidence`
 * scores it, and a low / unmeasurable mean-logprob escalates ONCE to the heavy
 * model. Bounded — never a loop. Confidence drives the escalation, so a strong
 * fast answer pays only the fast model (the latency win) while a weak one still
 * gets the heavy model's quality.
 */
function createCascadeWorker(spec: AgentSpec, runtime: AgentRuntime, tierModels: TierModels): AgentWorker {
  return {
    canHandle: () => 1,
    description: spec.description,
    id: spec.name,
    model: tierModels.fast,
    async run(input) {
      const messages = spec.systemPrompt ? prependSystem(input.messages, spec.systemPrompt) : input.messages;
      const baseInput: AgentRunInput = {
        ...input,
        logprobs: true,
        messages,
        metadata: { ...(input.metadata ?? {}), agentSpecId: spec.id, selectedAgentId: spec.name }
      };
      const outcome = await runCascade<AgentRunResult>({
        confidenceOf: (result) => summarizeTokenConfidence(result.response.logprobs ?? [])?.meanLogprob,
        fast: tierModels.fast,
        heavy: tierModels.heavy,
        run: (model) => runtime.run({ ...baseInput, model })
      });
      return outcome.result;
    }
  };
}

/**
 * Order auto-selected workers (no explicit workerIds) for the sequential
 * pipeline by creation time, not the registry's alphabetical display sort —
 * so the first-seeded worker runs first (e.g. the default Generalist before
 * the Critic, rather than "Critic" winning on name alone). Name breaks ties.
 */
export function orderWorkersForPipeline(specs: readonly AgentSpec[]): readonly AgentSpec[] {
  return [...specs].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.name.localeCompare(b.name)
  );
}

function createSpecWorker(spec: AgentSpec, runtime: AgentRuntime, model?: string): AgentWorker {
  return {
    canHandle: () => 1,
    description: spec.description,
    id: spec.name,
    ...(model ? { model } : {}),
    async run(input) {
      const messages = spec.systemPrompt ? prependSystem(input.messages, spec.systemPrompt) : input.messages;

      return runtime.run({
        ...input,
        messages,
        metadata: {
          ...(input.metadata ?? {}),
          agentSpecId: spec.id,
          selectedAgentId: spec.name
        }
      });
    }
  };
}

function prependSystem(messages: readonly ModelMessage[], systemPrompt: string): readonly ModelMessage[] {
  const [first, ...rest] = messages;

  if (first?.role === "system") {
    return [{ content: `${systemPrompt}\n\n${first.content}`, role: "system" }, ...rest];
  }

  return [{ content: systemPrompt, role: "system" }, ...messages];
}

function parseOrchestrateBody(value: unknown): ParseResult<OrchestrateBody> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("INVALID_ORCHESTRATE_REQUEST", "Body must be a JSON object");
  }

  const body = value as Record<string, unknown>;

  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    return invalid("INVALID_ORCHESTRATE_REQUEST", "message is required");
  }

  let mode: OrchestrationMode | undefined;

  if (body.mode === "sequential" || body.mode === "parallel" || body.mode === "race") {
    mode = body.mode;
  } else if (body.mode !== undefined) {
    return invalid("INVALID_ORCHESTRATE_REQUEST", "mode must be 'sequential', 'parallel', or 'race'");
  }

  let workerIds: readonly string[] | undefined;

  if (Array.isArray(body.workerIds)) {
    if (!body.workerIds.every((id) => typeof id === "string")) {
      return invalid("INVALID_ORCHESTRATE_REQUEST", "workerIds must be string[]");
    }

    workerIds = body.workerIds as readonly string[];
  } else if (body.workerIds !== undefined) {
    return invalid("INVALID_ORCHESTRATE_REQUEST", "workerIds must be string[]");
  }

  let maxWorkers: number | undefined;

  if (typeof body.maxWorkers === "number" && Number.isFinite(body.maxWorkers) && body.maxWorkers > 0) {
    maxWorkers = body.maxWorkers;
  } else if (body.maxWorkers !== undefined) {
    return invalid("INVALID_ORCHESTRATE_REQUEST", "maxWorkers must be a positive number");
  }

  let maxOutputCharsPerWorker: number | undefined;

  if (typeof body.maxOutputCharsPerWorker === "number"
    && Number.isFinite(body.maxOutputCharsPerWorker)
    && body.maxOutputCharsPerWorker >= 0) {
    maxOutputCharsPerWorker = body.maxOutputCharsPerWorker;
  } else if (body.maxOutputCharsPerWorker !== undefined) {
    return invalid("INVALID_ORCHESTRATE_REQUEST", "maxOutputCharsPerWorker must be a non-negative number");
  }

  let summarize: boolean | undefined;
  if (typeof body.summarize === "boolean") {
    summarize = body.summarize;
  } else if (body.summarize !== undefined) {
    return invalid("INVALID_ORCHESTRATE_REQUEST", "summarize must be a boolean");
  }

  let synthesize: boolean | undefined;
  if (typeof body.synthesize === "boolean") {
    synthesize = body.synthesize;
  } else if (body.synthesize !== undefined) {
    return invalid("INVALID_ORCHESTRATE_REQUEST", "synthesize must be a boolean");
  }

  let verify: boolean | undefined;
  if (typeof body.verify === "boolean") {
    verify = body.verify;
  } else if (body.verify !== undefined) {
    return invalid("INVALID_ORCHESTRATE_REQUEST", "verify must be a boolean");
  }

  let tiered: boolean | undefined;
  if (typeof body.tiered === "boolean") {
    tiered = body.tiered;
  } else if (body.tiered !== undefined) {
    return invalid("INVALID_ORCHESTRATE_REQUEST", "tiered must be a boolean");
  }

  let background: boolean | undefined;
  if (typeof body.background === "boolean") {
    background = body.background;
  } else if (body.background !== undefined) {
    return invalid("INVALID_ORCHESTRATE_REQUEST", "background must be a boolean");
  }

  return {
    ok: true,
    value: {
      message: body.message,
      ...(typeof body.model === "string" && body.model.trim().length > 0 ? { model: body.model } : {}),
      ...(mode ? { mode } : {}),
      ...(workerIds ? { workerIds } : {}),
      ...(maxWorkers !== undefined ? { maxWorkers } : {}),
      ...(maxOutputCharsPerWorker !== undefined ? { maxOutputCharsPerWorker } : {}),
      ...(summarize !== undefined ? { summarize } : {}),
      ...(synthesize !== undefined ? { synthesize } : {}),
      ...(verify !== undefined ? { verify } : {}),
      ...(tiered !== undefined ? { tiered } : {}),
      ...(background !== undefined ? { background } : {})
    }
  };
}

function invalid(code: string, message: string): ParseResult<never> {
  return { error: { code, message }, ok: false };
}

interface ConversationEntry {
  readonly content: string;
  readonly sourceAgentId: string;
  readonly targetAgentId?: string;
  readonly metadata?: JsonObject;
  readonly timestamp: string;
}

function toConversationEntry(message: AgentMessage): ConversationEntry {
  const metadata = message.metadata
    ? (Object.fromEntries(
        Object.entries(message.metadata).filter(([, value]) => value !== undefined)
      ) as JsonObject)
    : undefined;

  return {
    content: message.content,
    sourceAgentId: message.sourceAgentId,
    timestamp: message.timestamp.toISOString(),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(message.targetAgentId !== undefined ? { targetAgentId: message.targetAgentId } : {})
  };
}
