/**
 * Reactor-compat document routes extracted from reactor-compat-routes.ts.
 *
 * Wires `/api/documents` list/create + batch + search + delete (single
 * + bulk) so the call site in registerReactorCompatibilityRoutes
 * doesn't change.
 */

import type { FastifyInstance } from "fastify";
import {
  computeContentHash,
  createDocument,
  deleteDocument,
  deleteDocuments,
  duplicateDocumentConflict,
  findDocumentByContentHash,
  jsonObjectField,
  listDocuments,
  prefixValidationDetails,
  readBodyString,
  readNumber,
  readQueryInteger,
  searchDocuments,
  stringArrayField,
  stringField,
  toBody,
  toDocumentResponse,
  toSearchResultResponse,
  validateAddDocumentBody,
  validationErrorResponse,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export function registerDocumentRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/documents", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const limit = readQueryInteger(request, "limit", 100);
    return (await listDocuments(options, { limit: Math.min(Math.max(limit, 1), 1000) }))
      .slice(0, Math.min(Math.max(limit, 1), 1000))
      .map((document) => ({
        content: stringField(document.content, ""),
        id: document.id,
        metadata: jsonObjectField(document.metadata)
      }));
  });
  server.post("/api/documents", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const body = toBody(request.body);
    const validationError = validateAddDocumentBody(body);

    if (validationError) {
      return reply.status(400).send(validationErrorResponse(validationError));
    }

    const duplicate = await findDocumentByContentHash(options, computeContentHash(readBodyString(body, "content") ?? ""));

    if (duplicate) {
      return duplicateDocumentConflict(reply, duplicate.id);
    }

    return reply.status(201).send(toDocumentResponse(await createDocument(options, body)));
  });
  server.post("/api/documents/batch", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const documents = toBody(request.body).documents;
    const items: readonly unknown[] = Array.isArray(documents) ? documents : [];

    if (items.length === 0) {
      return reply.status(400).send(validationErrorResponse({ documents: "Documents list must not be empty" }));
    }

    if (items.length > 100) {
      return reply.status(400).send(validationErrorResponse({ documents: "Batch must not exceed 100 documents" }));
    }

    for (const [index, item] of items.entries()) {
      const body = toBody(item);
      const validationError = validateAddDocumentBody(body);

      if (validationError) {
        return reply.status(400).send(validationErrorResponse(prefixValidationDetails(`documents[${index}]`, validationError)));
      }

      const duplicate = await findDocumentByContentHash(options, computeContentHash(readBodyString(body, "content") ?? ""));

      if (duplicate) {
        return duplicateDocumentConflict(reply, duplicate.id);
      }
    }

    const saved = await Promise.all(items.map((item) => createDocument(options, item)));
    return reply.status(201).send({
      count: saved.length,
      ids: saved.map((document) => document.id),
      totalChunks: saved.reduce((total, document) => total + readNumber(document.chunkCount, 1), 0)
    });
  });
  server.post("/api/documents/search", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const query = (readBodyString(request.body, "query") ?? "").toLowerCase();
    const topK = readNumber(toBody(request.body).topK, 5);

    if (query.trim().length === 0) {
      return reply.status(400).send(validationErrorResponse({ query: "Search query is required" }));
    }

    if (query.length > 10_000) {
      return reply.status(400).send(validationErrorResponse({
        query: "Search query must not exceed 10000 characters"
      }));
    }

    if (topK < 1) {
      return reply.status(400).send(validationErrorResponse({ topK: "topK must be at least 1" }));
    }

    if (topK > 100) {
      return reply.status(400).send(validationErrorResponse({ topK: "topK must not exceed 100" }));
    }

    return (await searchDocuments(options, query, { limit: Math.min(Math.max(topK, 1), 100) }))
      .map(toSearchResultResponse);
  });
  server.delete("/api/documents", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const ids = stringArrayField(toBody(request.body).ids, []);

    if (ids.length === 0) {
      return reply.status(400).send(validationErrorResponse({ ids: "IDs list must not be empty" }));
    }

    if (ids.length > 100) {
      return reply.status(400).send(validationErrorResponse({
        ids: "Cannot delete more than 100 documents at once"
      }));
    }

    await deleteDocuments(options, ids);

    return reply.status(204).send();
  });
  server.delete("/api/documents/:documentId", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { documentId } = request.params as { readonly documentId: string };
    await deleteDocument(options, documentId);
    return reply.status(204).send();
  });
}
