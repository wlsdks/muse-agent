/**
 * Reactor-compat prompt-lab + RAG-ingestion routes extracted from
 * reactor-compat-routes.ts. Also dispatches to the existing
 * persona / prompt-template / document / intent compat modules.
 *
 * Wires:
 *   - delegates to registerPersonaRoutes / PromptTemplateRoutes /
 *     DocumentRoutes / IntentRoutes
 *   - POST /api/admin/rag/seed-policy
 *   - GET/PUT/DELETE /api/rag-ingestion/policy
 *   - GET /api/rag-ingestion/candidates (+ approve/reject)
 *   - POST/GET/DELETE /api/prompt-lab/experiments (+ /:id, /run, /cancel,
 *     /activate, /status, /trials, /report)
 *   - POST /api/prompt-lab/auto-optimize
 *   - POST /api/prompt-lab/analyze
 */

import { createRunId } from "@muse/shared";
import type { FastifyInstance } from "fastify";
import { registerDocumentRoutes } from "./document-compat-routes.js";
import { registerIntentRoutes } from "./intent-compat-routes.js";
import { registerPersonaRoutes } from "./persona-compat-routes.js";
import { registerPromptTemplateRoutes } from "./prompt-template-compat-routes.js";
import {
  activatePromptExperiment,
  cancelPromptExperiment,
  chunkText,
  clearRagIngestionPolicy,
  createPromptExperiment,
  deletePromptExperiment,
  errorResponse,
  getPromptExperiment,
  getPromptExperimentReport,
  getStateRagIngestionPolicy,
  isRecord,
  listPromptExperimentTrials,
  listPromptExperiments,
  listRagCandidates,
  parsePromptExperimentRequest,
  parseRagIngestionPolicy,
  promptFeedbackAnalysis,
  reactorEnumString,
  readBodyNullableString,
  readBodyString,
  readNullableNumber,
  readQueryInteger,
  readQueryString,
  readStoredRagIngestionPolicy,
  respondPromptExperiment,
  reviewRagCandidate,
  runPromptAutoOptimize,
  runPromptExperiment,
  saveDocumentRecord,
  saveRagIngestionPolicy,
  toBody,
  toPromptExperimentResponse,
  toPromptExperimentStatusResponse,
  toPromptReportResponse,
  toPromptTrialResponse,
  toRagCandidateResponse,
  toRagIngestionPolicyResponse,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export function registerPromptAndRagRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  registerPersonaRoutes(server, options);
  registerPromptTemplateRoutes(server, options);
  registerDocumentRoutes(server, options);
  registerIntentRoutes(server, options);
  registerRagIngestionRoutes(server, options);
  registerPromptLabRoutes(server, options);
}

function registerRagIngestionRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.post("/api/admin/rag/seed-policy", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const body = toBody(request.body);
    const entries = Array.isArray(body.entries) ? body.entries.filter(isRecord).slice(0, 50) : [];
    const startedAt = Date.now();
    const keys: string[] = [];
    let chunkCount = 0;

    for (const entry of entries) {
      const key = readBodyString(entry, "key");
      const title = readBodyString(entry, "title");
      const content = readBodyString(entry, "content");

      if (!key || !title || !content) {
        continue;
      }

      keys.push(key);
      const chunks = chunkText(content);
      chunkCount += chunks.length;

      for (const [index, chunk] of chunks.entries()) {
        await saveDocumentRecord(options, {
          category: readBodyNullableString(entry, "category") ?? null,
          content: chunk,
          id: `policy-seed:${key}:${index}`,
          key,
          source: "policy-seed",
          spaceKey: readBodyNullableString(entry, "spaceKey") ?? null,
          title,
          url: readBodyNullableString(entry, "url") ?? null
        });
      }
    }

    return {
      chunkCount,
      documentCount: keys.length,
      durationMs: Date.now() - startedAt,
      keys
    };
  });
  server.get("/api/rag-ingestion/policy", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const stored = await readStoredRagIngestionPolicy(options);
    const fallback = getStateRagIngestionPolicy();
    const effective = stored ?? fallback;

    return {
      configEnabled: Boolean(fallback.enabled),
      dynamicEnabled: true,
      effective: toRagIngestionPolicyResponse(effective),
      stored: stored ? toRagIngestionPolicyResponse(stored) : null
    };
  });
  server.put("/api/rag-ingestion/policy", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const parsed = parseRagIngestionPolicy(request.body);

    if (!parsed.ok) {
      return reply.status(400).send(parsed.error);
    }

    const saved = await saveRagIngestionPolicy(options, parsed.value);
    return toRagIngestionPolicyResponse(saved);
  });
  server.delete("/api/rag-ingestion/policy", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    await clearRagIngestionPolicy(options);
    return reply.status(204).send();
  });
  server.get("/api/rag-ingestion/candidates", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const status = readQueryString(request, "status")?.toUpperCase();
    const channel = readQueryString(request, "channel");
    const limit = Math.min(Math.max(readQueryInteger(request, "limit", 100), 1), 500);
    const candidates = await listRagCandidates(options, { channel, limit, status });
    return candidates.map(toRagCandidateResponse);
  });
  server.post("/api/rag-ingestion/candidates/:id/approve", async (request, reply) =>
    reviewRagCandidate(request, reply, options, "INGESTED")
  );
  server.post("/api/rag-ingestion/candidates/:id/reject", async (request, reply) =>
    reviewRagCandidate(request, reply, options, "REJECTED")
  );
}

function registerPromptLabRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.post("/api/prompt-lab/experiments", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const parsed = parsePromptExperimentRequest(request);

    if (!parsed.ok) {
      return reply.status(400).send(parsed.error);
    }

    return reply.status(201).send(toPromptExperimentResponse(await createPromptExperiment(request, options, parsed.value)));
  });
  server.get("/api/prompt-lab/experiments", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const status = readQueryString(request, "status")?.toUpperCase();
    const templateId = readQueryString(request, "templateId");
    return (await listPromptExperiments(options))
      .filter((experiment) => !status || reactorEnumString(experiment.status, "PENDING") === status)
      .filter((experiment) => !templateId || experiment.templateId === templateId)
      .map(toPromptExperimentResponse);
  });
  server.get("/api/prompt-lab/experiments/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return respondPromptExperiment(request, reply, options);
  });
  server.delete("/api/prompt-lab/experiments/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    await deletePromptExperiment(options, id);
    return reply.status(204).send();
  });
  server.post("/api/prompt-lab/experiments/:id/run", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return runPromptExperiment(request, reply, options);
  });
  server.post("/api/prompt-lab/experiments/:id/cancel", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return cancelPromptExperiment(request, reply, options);
  });
  server.post("/api/prompt-lab/experiments/:id/activate", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return activatePromptExperiment(request, reply, options);
  });
  server.get("/api/prompt-lab/experiments/:id/status", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const id = (request.params as { readonly id: string }).id;
    const record = await getPromptExperiment(options, id);
    return record
      ? toPromptExperimentStatusResponse(record)
      : reply.status(404).send(errorResponse(`Experiment not found: ${id}`));
  });
  server.get("/api/prompt-lab/experiments/:id/trials", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    return (await listPromptExperimentTrials(options, id)).map(toPromptTrialResponse);
  });
  server.get("/api/prompt-lab/experiments/:id/report", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const id = (request.params as { readonly id: string }).id;
    const report = await getPromptExperimentReport(options, id);
    return report
      ? toPromptReportResponse(report)
      : reply.status(404).send(errorResponse(`Experiment report not found: ${id}`));
  });
  server.post("/api/prompt-lab/auto-optimize", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const templateId = readBodyString(request.body, "templateId")?.trim();

    if (!templateId) {
      return reply.status(400).send(errorResponse("Body must include templateId"));
    }

    await runPromptAutoOptimize(templateId, options, toBody(request.body));

    return reply.status(202).send({
      jobId: createRunId("prompt_auto"),
      status: "STARTED",
      templateId
    });
  });
  server.post("/api/prompt-lab/analyze", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const templateId = readBodyString(request.body, "templateId")?.trim();

    if (!templateId) {
      return reply.status(400).send(errorResponse("Body must include templateId"));
    }

    return promptFeedbackAnalysis(templateId, readNullableNumber(toBody(request.body).maxSamples) ?? 50, options);
  });
}
