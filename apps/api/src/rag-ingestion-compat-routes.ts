/**
 * Personal-Muse RAG ingestion + admin policy-seed routes extracted from
 * the now-removed prompt-rag-compat-routes.ts (which also fanned out to
 * the deleted persona / prompt-template / intent / prompt-lab admin
 * surfaces). DocumentRoutes still wires `/api/documents` lifecycle from
 * `document-compat-routes.ts`.
 *
 * Wires:
 *   - delegates to registerDocumentRoutes
 *   - POST /api/admin/rag/seed-policy
 *   - GET/PUT/DELETE /api/rag-ingestion/policy
 *   - GET /api/rag-ingestion/candidates (+ approve/reject)
 */

import type { FastifyInstance } from "fastify";
import { registerDocumentRoutes } from "./document-compat-routes.js";
import {
  chunkText,
  clearRagIngestionPolicy,
  getStateRagIngestionPolicy,
  isRecord,
  listRagCandidates,
  parseRagIngestionPolicy,
  readBodyNullableString,
  readBodyString,
  readQueryInteger,
  readQueryString,
  readStoredRagIngestionPolicy,
  reviewRagCandidate,
  saveDocumentRecord,
  saveRagIngestionPolicy,
  toBody,
  toRagCandidateResponse,
  toRagIngestionPolicyResponse,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export function registerPromptAndRagRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  registerDocumentRoutes(server, options);
  registerRagIngestionRoutes(server, options);
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
