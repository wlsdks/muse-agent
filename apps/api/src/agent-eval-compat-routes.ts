/**
 * Reactor-compat agent-eval + tool-stats routes extracted from
 * reactor-compat-routes.ts.
 *
 * Wires:
 *   - GET /api/admin/agent-eval/cases (filtered by tags + enabledOnly)
 *   - GET /api/admin/agent-eval/run-logs (merged with current runs)
 *   - POST /api/admin/agent-eval/cases/promote (promote a run to a case)
 *   - POST /api/admin/agent-eval/cases/:id/replay (replays through agentRuntime)
 *   - POST /api/admin/agent-eval/cases/:caseId/evaluate-run/:runId
 *   - GET /api/admin/agent-eval/results
 *   - GET /api/admin/tools/stats (toolOutcomeStats)
 *   - GET /api/admin/tools/accuracy (derived from outcome stats)
 */

import { createRunId } from "@muse/shared";
import type { FastifyInstance } from "fastify";
import {
  badRequest,
  countBehaviorAssertions,
  countEvalAssertions,
  errorResponse,
  evaluateRunAgainstCase,
  getAgentEvalCase,
  listAgentEvalCases,
  listAgentEvalResults,
  listAgentEvalRunLogs,
  listAllRuns,
  listAllToolCalls,
  readBodyString,
  readBoolean,
  readNullableNumber,
  readNumber,
  readQueryBoolean,
  readQueryInteger,
  readQueryString,
  readQueryStringSet,
  readStringSet,
  replayEvalCase,
  runLogRecord,
  runLogResponse,
  saveAgentEvalCase,
  storeEvalResult,
  toEvalCaseResponse,
  toEvalRunLogResponse,
  toJsonObject,
  toolOutcomeStats,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";
import type { JsonObject } from "@muse/shared";

export function registerAgentEvalCompatRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  registerAgentEvalCaseRoutes(server, options);
  registerAgentEvalRunLogRoutes(server, options);
  registerAgentEvalPromotionRoutes(server, options);
  registerAgentEvalReplayRoutes(server, options);
  registerAgentEvalResultRoutes(server, options);
  registerToolStatsRoutes(server, options);
}

function registerAgentEvalCaseRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/admin/agent-eval/cases", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const enabledOnly = readQueryBoolean(request, "enabledOnly", true);
    const tags = readQueryStringSet(request, "tags");
    const limit = Math.max(0, readQueryInteger(request, "limit", 100));
    return (await listAgentEvalCases(options, { enabledOnly, limit, tags: [...tags] })).map(toEvalCaseResponse);
  });
}

function registerAgentEvalRunLogRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/admin/agent-eval/run-logs", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const limit = Math.max(0, readQueryInteger(request, "limit", 50));
    const runs = await listAllRuns(options, { limit });
    const logsByRunId = new Map<string, JsonObject>();

    for (const log of await listAgentEvalRunLogs(options, limit)) {
      const response = toEvalRunLogResponse(log);
      logsByRunId.set(String(response.runId), response);
    }

    for (const run of runs) {
      logsByRunId.set(run.id, await runLogResponse(run, options));
    }

    return [...logsByRunId.values()].slice(0, limit);
  });
}

function registerAgentEvalPromotionRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.post("/api/admin/agent-eval/cases/promote", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const body = toJsonObject(request.body);
    const runId = readBodyString(body, "runId") ?? readBodyString(body, "sourceRunId");

    if (!runId) {
      return reply.status(400).send({
        code: "INVALID_AGENT_EVAL_PROMOTION",
        message: "Body must include runId"
      });
    }

    const behaviorAssertionCount = countBehaviorAssertions(body);

    if (behaviorAssertionCount === 0) {
      return reply.status(400).send({
        code: "INVALID_AGENT_EVAL_PROMOTION",
        message: "Promotion requires at least one deterministic assertion"
      });
    }

    const run = await options.historyStore?.findRun(runId);

    if (!run) {
      return reply.status(404).send(errorResponse(`run log를 찾을 수 없습니다: ${runId}`));
    }

    const toolCalls = await (options.historyStore?.listToolCalls(runId) ?? []);
    const toolNames = [...new Set(toolCalls.map((toolCall) => toolCall.name))];
    const id = readBodyString(body, "id") ?? createRunId("eval_case");
    const record = await saveAgentEvalCase(options, {
      agentType: run.mode,
      assertionCount: countEvalAssertions({ ...body, agentType: run.mode, model: run.model }),
      enabled: readBoolean(body.enabled, true),
      expectedAnswerContains: readStringSet(body.expectedAnswerContains),
      expectedExposedToolNames: readStringSet(body.expectedExposedToolNames),
      expectedToolNames: readStringSet(body.expectedToolNames),
      forbiddenAnswerContains: readStringSet(body.forbiddenAnswerContains),
      forbiddenExposedToolNames: readStringSet(body.forbiddenExposedToolNames),
      forbiddenToolNames: readStringSet(body.forbiddenToolNames),
      id,
      maxToolExposureCount: readNullableNumber(body.maxToolExposureCount) ?? null,
      minScore: readNumber(body.minScore, 1),
      model: run.model,
      name: readBodyString(body, "name") ?? `Promoted run ${run.id}`,
      sourceRunId: run.id,
      tags: readStringSet(body.tags),
      toolExposureNames: toolNames,
      userInput: run.input
    });
    await runLogRecord(run, options);
    return toEvalCaseResponse(record);
  });
}

function registerAgentEvalReplayRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.post("/api/admin/agent-eval/cases/:id/replay", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    const existing = await getAgentEvalCase(options, id);

    if (!existing) {
      return reply.status(404).send(errorResponse(`eval case를 찾을 수 없습니다: ${id}`));
    }

    if (!options.agentRuntime) {
      return badRequest(
        reply,
        "AGENT_EVAL_UNAVAILABLE",
        "AgentExecutor 미등록 — eval 기능을 사용할 수 없습니다"
      );
    }

    let replay;

    try {
      replay = await replayEvalCase(existing, request, options);
    } catch (error) {
      return reply.status(500).send({
        code: "AGENT_EVAL_REPLAY_FAILED",
        message: error instanceof Error ? error.message : "Agent eval replay failed"
      });
    }

    const result = await evaluateRunAgainstCase(existing, replay.run, options, replay.toolCalls);
    const stored = await storeEvalResult(
      result,
      readQueryBoolean(request, "llmJudge", false),
      options,
      existing,
      replay.run
    );
    return {
      caseId: id,
      deterministic: result,
      storedResults: stored
    };
  });

  server.post("/api/admin/agent-eval/cases/:caseId/evaluate-run/:runId", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { caseId, runId } = request.params as { readonly caseId: string; readonly runId: string };
    const existing = await getAgentEvalCase(options, caseId);

    if (!existing) {
      return reply.status(404).send(errorResponse(`eval case를 찾을 수 없습니다: ${caseId}`));
    }

    const run = await options.historyStore?.findRun(runId);

    if (!run) {
      return reply.status(404).send(errorResponse(`run log를 찾을 수 없습니다: ${runId}`));
    }

    const result = await evaluateRunAgainstCase(existing, run, options);
    const stored = await storeEvalResult(result, readQueryBoolean(request, "llmJudge", false), options, existing, run);
    return {
      caseId,
      deterministic: result,
      storedResults: stored
    };
  });
}

function registerAgentEvalResultRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/admin/agent-eval/results", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const caseId = readQueryString(request, "caseId");
    const tier = readQueryString(request, "tier");
    const limit = Math.max(0, readQueryInteger(request, "limit", 100));
    return listAgentEvalResults(options, { caseId, limit, tier });
  });
}

function registerToolStatsRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/admin/tools/stats", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return toolOutcomeStats(await listAllToolCalls(options), readQueryString(request, "server"));
  });

  server.get("/api/admin/tools/accuracy", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const stats = toolOutcomeStats(await listAllToolCalls(options));
    const total = Number(stats.total);
    const byOutcome = toJsonObject(stats.byOutcome);
    const ok = Number(byOutcome.ok ?? 0);
    const invalidArg = Number(byOutcome.invalid_arg ?? 0);
    const timeout = Number(byOutcome.timeout ?? 0);
    const errors = Number(byOutcome.error ?? 0);
    const notFound = Number(byOutcome.not_found ?? 0);
    const denominator = total > 0 ? total : 1;
    return {
      accuracy: stats.accuracy,
      errorRate: errors / denominator,
      invalidCallRate: invalidArg / denominator,
      ok,
      notFoundRate: notFound / denominator,
      timeoutRate: timeout / denominator,
      total
    };
  });
}
