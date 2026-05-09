import { describe, expect, it } from "vitest";
import {
  InMemoryRagDocumentStore,
  InMemoryRagIngestionCandidateStore,
  InMemoryRagIngestionPolicyStore
} from "@muse/rag";
import { buildServer } from "../src/server.js";
import { createAuthService } from "./helpers/test-auth.js";

describe("api server: RAG ingestion + documents", () => {
  it("persists Reactor-compatible RAG ingestion policy and candidate reviews through configured stores", async () => {
    const now = new Date("2026-05-06T00:00:00.000Z");
    const policyStore = new InMemoryRagIngestionPolicyStore({ now: () => now });
    const candidateStore = new InMemoryRagIngestionCandidateStore({
      idFactory: () => "candidate-1",
      now: () => now
    });
    await candidateStore.save({
      channel: "web",
      query: "How should Muse migrate RAG ingestion?",
      response: "Persist reviewed synthetic candidates.",
      runId: "run-rag",
      userId: "example-user"
    });
    const server = buildServer({
      logger: false,
      ragIngestion: { candidateStore, policyStore }
    });

    const savedPolicy = await server.inject({
      method: "PUT",
      payload: {
        allowedChannels: ["web"],
        blockedPatterns: ["secret"],
        enabled: true,
        minQueryChars: 8,
        minResponseChars: 16,
        requireReview: false
      },
      url: "/api/rag-ingestion/policy"
    });
    const policy = await server.inject({
      method: "GET",
      url: "/api/rag-ingestion/policy"
    });
    const candidates = await server.inject({
      method: "GET",
      url: "/api/rag-ingestion/candidates?status=PENDING&channel=web"
    });
    const approved = await server.inject({
      method: "POST",
      payload: { comment: "approved" },
      url: "/api/rag-ingestion/candidates/candidate-1/approve"
    });
    const approvedAgain = await server.inject({
      method: "POST",
      payload: { comment: "approved again" },
      url: "/api/rag-ingestion/candidates/candidate-1/approve"
    });

    expect(savedPolicy.json()).toMatchObject({ allowedChannels: ["web"], enabled: true });
    expect(policy.json()).toMatchObject({
      effective: { allowedChannels: ["web"], enabled: true },
      stored: { allowedChannels: ["web"], enabled: true }
    });
    expect(candidates.json()).toMatchObject([{ id: "candidate-1", status: "PENDING" }]);
    expect(approved.json()).toMatchObject({
      id: "candidate-1",
      reviewComment: "approved",
      status: "INGESTED"
    });
    expect(approvedAgain.statusCode).toBe(409);
  });

  it("reports Reactor vector store availability independently from document count", async () => {
    const authService = createAuthService();
    const registered = authService.register({
      email: "vector_store_admin",
      name: "Vector Store Admin",
      password: "password-1"
    });
    const server = buildServer({
      authService,
      logger: false,
      requireAuth: true
    });
    const headers = { authorization: `Bearer ${registered.token}` };

    const stats = await server.inject({
      headers,
      method: "GET",
      url: "/api/admin/platform/vectorstore/stats"
    });

    expect(stats.statusCode).toBe(200);
    expect(stats.json()).toEqual({ available: true, documentCount: 0 });
  });

  it("matches Reactor document management response contracts", async () => {
    const authService = createAuthService();
    const registered = authService.register({
      email: "first_account",
      name: "First",
      password: "password-1"
    });
    const server = buildServer({ authService, logger: false, requireAuth: true });
    const headers = { authorization: `Bearer ${registered.token}` };

    const created = await server.inject({
      headers,
      method: "POST",
      payload: {
        content: "Knowledge base entry",
        metadata: { source: "manual" }
      },
      url: "/api/documents"
    });
    const batch = await server.inject({
      headers,
      method: "POST",
      payload: {
        documents: [
          { content: "Batch entry one", metadata: { source: "batch" } },
          { content: "Batch entry two" }
        ]
      },
      url: "/api/documents/batch"
    });
    const duplicate = await server.inject({
      headers,
      method: "POST",
      payload: {
        content: "Knowledge base entry"
      },
      url: "/api/documents"
    });
    const invalidCreate = await server.inject({
      headers,
      method: "POST",
      payload: { content: "" },
      url: "/api/documents"
    });
    const invalidBatch = await server.inject({
      headers,
      method: "POST",
      payload: { documents: [{ metadata: { source: "batch" } }] },
      url: "/api/documents/batch"
    });
    const listed = await server.inject({
      headers,
      method: "GET",
      url: "/api/documents?limit=10"
    });
    const search = await server.inject({
      headers,
      method: "POST",
      payload: {
        query: "knowledge",
        topK: 5
      },
      url: "/api/documents/search"
    });
    const invalidSearch = await server.inject({
      headers,
      method: "POST",
      payload: {
        query: "knowledge",
        topK: 101
      },
      url: "/api/documents/search"
    });
    const invalidDelete = await server.inject({
      headers,
      method: "DELETE",
      payload: {
        ids: []
      },
      url: "/api/documents"
    });
    const deleted = await server.inject({
      headers,
      method: "DELETE",
      payload: {
        ids: [created.json().id]
      },
      url: "/api/documents"
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      chunkCount: 1,
      chunkIds: [],
      content: "Knowledge base entry",
      metadata: { content_hash: expect.any(String), source: "manual" }
    });
    expect(batch.statusCode).toBe(201);
    expect(batch.json()).toMatchObject({ count: 2, totalChunks: 2 });
    expect(batch.json().ids).toHaveLength(2);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: "Document with identical content already exists",
      existingId: created.json().id
    });
    expect(invalidCreate.statusCode).toBe(400);
    expect(invalidCreate.json()).toMatchObject({
      details: { content: "Document content is required" },
      error: "요청 형식이 올바르지 않습니다",
      timestamp: expect.any(String)
    });
    expect(invalidCreate.json()).not.toHaveProperty("code");
    expect(invalidBatch.statusCode).toBe(400);
    expect(invalidBatch.json()).toMatchObject({
      details: { "documents[0].content": "Document content is required" },
      error: "요청 형식이 올바르지 않습니다",
      timestamp: expect.any(String)
    });
    expect(invalidBatch.json()).not.toHaveProperty("code");
    expect(listed.json()).toMatchObject([
      { content: "Knowledge base entry", metadata: { source: "manual" } },
      { content: "Batch entry one", metadata: { source: "batch" } },
      { content: "Batch entry two", metadata: {} }
    ]);
    expect(search.json()).toMatchObject([
      {
        content: "Knowledge base entry",
        metadata: { source: "manual" },
        score: null
      }
    ]);
    expect(invalidSearch.statusCode).toBe(400);
    expect(invalidSearch.json()).toMatchObject({
      details: { topK: "topK must not exceed 100" },
      error: "요청 형식이 올바르지 않습니다",
      timestamp: expect.any(String)
    });
    expect(invalidSearch.json()).not.toHaveProperty("code");
    expect(invalidDelete.statusCode).toBe(400);
    expect(invalidDelete.json()).toMatchObject({
      details: { ids: "IDs list must not be empty" },
      error: "요청 형식이 올바르지 않습니다",
      timestamp: expect.any(String)
    });
    expect(invalidDelete.json()).not.toHaveProperty("code");
    expect(deleted.statusCode).toBe(204);
  });

  it("keeps Reactor document state in the configured RAG document store across API instances", async () => {
    const authService = createAuthService();
    const registered = authService.register({
      email: "document_persistence_account",
      name: "Document Persistence",
      password: "password-1"
    });
    const ragIngestion = {
      candidateStore: new InMemoryRagIngestionCandidateStore(),
      documentStore: new InMemoryRagDocumentStore(),
      policyStore: new InMemoryRagIngestionPolicyStore()
    };
    const firstServer = buildServer({ authService, logger: false, ragIngestion, requireAuth: true });
    const secondServer = buildServer({ authService, logger: false, ragIngestion, requireAuth: true });
    const headers = { authorization: `Bearer ${registered.token}` };

    const created = await firstServer.inject({
      headers,
      method: "POST",
      payload: {
        content: "Persisted migration document",
        metadata: { source: "persistence-test" }
      },
      url: "/api/documents"
    });
    const listed = await secondServer.inject({
      headers,
      method: "GET",
      url: "/api/documents"
    });
    const duplicate = await secondServer.inject({
      headers,
      method: "POST",
      payload: { content: "Persisted migration document" },
      url: "/api/documents"
    });
    const search = await secondServer.inject({
      headers,
      method: "POST",
      payload: {
        query: "migration",
        topK: 5
      },
      url: "/api/documents/search"
    });

    expect(created.statusCode).toBe(201);
    expect(listed.json()).toEqual([
      expect.objectContaining({
        content: "Persisted migration document",
        id: created.json().id,
        metadata: expect.objectContaining({ source: "persistence-test" })
      })
    ]);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ existingId: created.json().id });
    expect(search.json()).toEqual([
      expect.objectContaining({
        id: created.json().id,
        score: null
      })
    ]);
  });
});

