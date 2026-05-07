import { Readable } from "node:stream";
import type { AgentRunInput, AgentRuntime } from "@muse/agent-core";
import type { AgentSpec, AgentSpecRegistry } from "@muse/agent-specs";
import {
  InMemoryAgentMessageBus,
  InMemoryOrchestrationHistoryStore,
  MultiAgentOrchestrator,
  type AgentMessage,
  type AgentWorker,
  type MultiAgentOrchestrationResult,
  type OrchestrationHistoryStore,
  type OrchestrationMode
} from "@muse/multi-agent";
import type { ModelMessage } from "@muse/model";
import type { JsonObject } from "@muse/shared";
import type { FastifyInstance } from "fastify";

export interface MultiAgentRouteOptions {
  readonly agentRuntime?: AgentRuntime;
  readonly agentSpecRegistry: AgentSpecRegistry;
  readonly defaultModel?: string;
  readonly historyStore?: OrchestrationHistoryStore;
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
}

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError };

export function registerMultiAgentRoutes(server: FastifyInstance, options: MultiAgentRouteOptions): void {
  const historyStore = options.historyStore ?? new InMemoryOrchestrationHistoryStore();

  server.get("/api/multi-agent/orchestrations", async (request, reply) => {
    const limitRaw = (request.query as { readonly limit?: string } | undefined)?.limit;
    let limit: number | undefined;

    if (limitRaw !== undefined) {
      const parsed = Number.parseInt(limitRaw, 10);
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

    const allSpecs = await options.agentSpecRegistry.listEnabled();
    const requestedIds = parsed.value.workerIds;
    const selected = requestedIds
      ? allSpecs.filter((spec) => requestedIds.includes(spec.name))
      : allSpecs;

    if (selected.length === 0) {
      return reply.status(409).send({
        code: "NO_AGENT_WORKERS",
        message: requestedIds
          ? "No enabled agent specs match the requested workerIds"
          : "No enabled agent specs are available to orchestrate"
      } satisfies ApiError);
    }

    const messageBus = new InMemoryAgentMessageBus();
    const workers: AgentWorker[] = selected.map((spec) => createSpecWorker(spec, options.agentRuntime!));
    const orchestrator = new MultiAgentOrchestrator({ historyStore, messageBus, workers });
    const input: AgentRunInput = {
      messages: [{ content: parsed.value.message, role: "user" }],
      model: parsed.value.model ?? options.defaultModel ?? "default"
    };

    try {
      const orchestration = await orchestrator.run(input, {
        ...(parsed.value.mode ? { mode: parsed.value.mode } : {}),
        ...(parsed.value.maxWorkers !== undefined ? { maxWorkers: parsed.value.maxWorkers } : {})
      });

      return {
        conversation: messageBus.getConversation().map(toConversationEntry),
        mode: orchestration.mode,
        response: {
          id: orchestration.response.id,
          model: orchestration.response.model,
          output: orchestration.response.output
        },
        results: orchestration.results.map((step) => ({
          status: step.status,
          workerId: step.workerId,
          ...(step.result ? { output: step.result.response.output } : {}),
          ...(step.error ? { error: step.error } : {})
        })),
        runId: orchestration.runId
      };
    } catch (error) {
      return reply.status(500).send({
        code: "MULTI_AGENT_ORCHESTRATION_FAILED",
        message: error instanceof Error ? error.message : "Multi-agent orchestration failed"
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

    const allSpecs = await options.agentSpecRegistry.listEnabled();
    const requestedIds = parsed.value.workerIds;
    const selected = requestedIds
      ? allSpecs.filter((spec) => requestedIds.includes(spec.name))
      : allSpecs;

    if (selected.length === 0) {
      return reply.status(409).send({
        code: "NO_AGENT_WORKERS",
        message: requestedIds
          ? "No enabled agent specs match the requested workerIds"
          : "No enabled agent specs are available to orchestrate"
      } satisfies ApiError);
    }

    const messageBus = new InMemoryAgentMessageBus();
    const workers: AgentWorker[] = selected.map((spec) => createSpecWorker(spec, options.agentRuntime!));
    const orchestrator = new MultiAgentOrchestrator({ historyStore, messageBus, workers });
    const input: AgentRunInput = {
      messages: [{ content: parsed.value.message, role: "user" }],
      model: parsed.value.model ?? options.defaultModel ?? "default"
    };
    const orchestrationOptions = {
      ...(parsed.value.mode ? { mode: parsed.value.mode } : {}),
      ...(parsed.value.maxWorkers !== undefined ? { maxWorkers: parsed.value.maxWorkers } : {})
    };

    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache");
    reply.header("x-accel-buffering", "no");

    return reply.send(
      Readable.from(toMultiAgentSseStream({ messageBus, orchestrator, input, options: orchestrationOptions, mode: parsed.value.mode ?? "sequential" }))
    );
  });
}

interface SseStreamArgs {
  readonly messageBus: InMemoryAgentMessageBus;
  readonly orchestrator: MultiAgentOrchestrator;
  readonly input: AgentRunInput;
  readonly options: { readonly mode?: OrchestrationMode; readonly maxWorkers?: number };
  readonly mode: OrchestrationMode;
}

async function* toMultiAgentSseStream(args: SseStreamArgs): AsyncIterable<string> {
  const queue: AgentMessage[] = [];
  let resolveNext: (() => void) | undefined;

  args.messageBus.subscribe("__sse__", (message) => {
    queue.push(message);
    const resume = resolveNext;
    resolveNext = undefined;
    resume?.();
  });

  yield `event: start\ndata: ${sseData(JSON.stringify({ mode: args.mode }))}\n\n`;

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

function sseData(value: string): string {
  return value.split(/\r?\n/u).map((line) => (line.length > 0 ? line : " ")).join("\ndata: ");
}

function createSpecWorker(spec: AgentSpec, runtime: AgentRuntime): AgentWorker {
  return {
    canHandle: () => 1,
    description: spec.description,
    id: spec.name,
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

  if (body.mode === "sequential" || body.mode === "parallel") {
    mode = body.mode;
  } else if (body.mode !== undefined) {
    return invalid("INVALID_ORCHESTRATE_REQUEST", "mode must be 'sequential' or 'parallel'");
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

  return {
    ok: true,
    value: {
      message: body.message,
      ...(typeof body.model === "string" && body.model.trim().length > 0 ? { model: body.model } : {}),
      ...(mode ? { mode } : {}),
      ...(workerIds ? { workerIds } : {}),
      ...(maxWorkers !== undefined ? { maxWorkers } : {})
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

export type MultiAgentOrchestrateResponseBody = {
  readonly conversation: readonly ConversationEntry[];
  readonly mode: OrchestrationMode;
  readonly response: { readonly id: string; readonly model: string; readonly output: string };
  readonly results: ReadonlyArray<{
    readonly status: "completed" | "failed";
    readonly workerId: string;
    readonly output?: string;
    readonly error?: string;
  }>;
  readonly runId: string;
};
