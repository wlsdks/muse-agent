import { describe, expect, it } from "vitest";
import type { MuseDatabase } from "@muse/db";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";
import {
  Bm25Scorer,
  AdaptiveRagRetriever,
  DefaultRagPipeline,
  buildRagIngestionPolicyUpsertQuery,
  createRagDocumentInsert,
  createRagIngestionCandidateInsert,
  createRagIngestionPolicyInsert,
  ConversationAwareQueryTransformer,
  DecomposingQueryTransformer,
  ExtractiveContextCompressor,
  HybridDocumentRetriever,
  InMemoryRagDocumentStore,
  InMemoryVectorStore,
  KyselyRagDocumentStore,
  InMemoryRagIngestionCandidateStore,
  InMemoryRagIngestionPolicyStore,
  InMemoryRagCorpus,
  mapRagDocumentRow,
  mapRagIngestionCandidateRow,
  mapRagIngestionPolicyRow,
  PassthroughQueryTransformer,
  ParentDocumentRetriever,
  HypotheticalDocumentQueryTransformer,
  RetrievalEvalRunner,
  SimpleContextBuilder,
  SimpleReranker,
  StructuredContextBuilder,
  TokenBasedDocumentChunker,
  chunkId,
  emptyRagContext,
  rrfFuse,
  tokenize
} from "../src/index.js";

describe("TokenBasedDocumentChunker", () => {
  it("splits long documents with parent metadata", () => {
    const chunker = new TokenBasedDocumentChunker({
      chunkSize: 8,
      minChunkSizeChars: 8,
      minChunkThreshold: 4,
      overlap: 1
    });
    const chunks = chunker.chunk({
      content: "First paragraph has context.\n\nSecond paragraph has more context.\n\nThird paragraph ends.",
      id: "doc-1",
      metadata: { scope: "test" },
      source: "synthetic"
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatchObject({
      id: chunkId("doc-1", 0),
      metadata: { chunk_index: 0, chunked: true, parent_document_id: "doc-1" },
      source: "synthetic"
    });
  });
});

describe("RAG ingestion stores", () => {
  it("persists document records in memory with content-hash lookup", async () => {
    const now = new Date("2026-05-06T00:00:00.000Z");
    const store = new InMemoryRagDocumentStore({
      idFactory: () => "document-1",
      now: () => now
    });

    const document = await store.save({
      content: "Synthetic Reactor migration note",
      metadata: { source: "manual" }
    });

    expect(document).toMatchObject({
      chunkCount: 1,
      content: "Synthetic Reactor migration note",
      id: "document-1",
      indexed: true,
      metadata: { content_hash: expect.any(String), source: "manual" }
    });
    expect(await store.findByContentHash(document.contentHash)).toMatchObject({ id: "document-1" });
    expect(await store.search("reactor")).toHaveLength(1);
    expect(await store.count()).toBe(1);
    expect(await store.deleteMany(["document-1"])).toBe(1);
  });

  it("persists policy and candidate review state in memory", async () => {
    const now = new Date("2026-05-06T00:00:00.000Z");
    const policyStore = new InMemoryRagIngestionPolicyStore({ now: () => now });
    const candidateStore = new InMemoryRagIngestionCandidateStore({
      idFactory: () => "candidate-1",
      now: () => now
    });

    const policy = await policyStore.save({
      allowedChannels: ["Web"],
      blockedPatterns: ["secret"],
      enabled: true,
      minQueryChars: 10,
      minResponseChars: 20,
      requireReview: true
    });
    const candidate = await candidateStore.save({
      channel: "WEB",
      query: "How should Muse handle RAG?",
      response: "Use reviewed synthetic documents.",
      runId: "run-1",
      userId: "example-user"
    });
    const reviewed = await candidateStore.updateReview({
      id: candidate.id,
      ingestedDocumentId: "doc-1",
      reviewComment: "approved",
      reviewedBy: "admin",
      status: "INGESTED"
    });

    expect(policy).toMatchObject({ allowedChannels: ["web"], enabled: true });
    expect(candidate).toMatchObject({ channel: "web", id: "candidate-1", status: "PENDING" });
    expect(reviewed).toMatchObject({ ingestedDocumentId: "doc-1", status: "INGESTED" });
    expect(await candidateStore.list({ channel: "web", status: "INGESTED" })).toHaveLength(1);
  });

  it("builds PostgreSQL RAG ingestion queries and maps rows", () => {
    const db = createPostgresBuilder();
    const now = new Date("2026-05-06T00:00:00.000Z");
    const policy = createRagIngestionPolicyInsert({
      allowedChannels: ["web"],
      blockedPatterns: ["secret"],
      enabled: true,
      minQueryChars: 8,
      minResponseChars: 16,
      requireReview: false
    }, { now: () => now });
    const candidate = createRagIngestionCandidateInsert({
      channel: "web",
      query: "Question",
      response: "Answer",
      runId: "run-1",
      userId: "example-user"
    }, {
      idFactory: () => "candidate-1",
      now: () => now
    });
    const compiled = buildRagIngestionPolicyUpsertQuery(db, {
      allowedChannels: ["web"],
      blockedPatterns: [],
      enabled: true,
      minQueryChars: 1,
      minResponseChars: 1,
      requireReview: true
    }, { now: () => now }).compile();

    expect(compiled.sql).toContain('insert into "rag_ingestion_policy"');
    expect(compiled.sql).toContain('on conflict ("id") do update');
    expect(mapRagIngestionPolicyRow(policy)).toMatchObject({ allowedChannels: ["web"], enabled: true });
    expect(mapRagIngestionCandidateRow(candidate)).toMatchObject({
      channel: "web",
      id: "candidate-1",
      runId: "run-1",
      status: "PENDING"
    });
  });

  it("builds PostgreSQL RAG document queries and maps rows", () => {
    const db = createPostgresBuilder();
    const now = new Date("2026-05-06T00:00:00.000Z");
    const insert = createRagDocumentInsert({
      content: "Stored synthetic document",
      contentHash: "hash-1",
      id: "document-1",
      metadata: { source: "manual" }
    }, {
      idFactory: () => "unused",
      now: () => now
    });
    const compiled = db.insertInto("rag_documents").values(insert).compile();

    expect(new KyselyRagDocumentStore(db)).toBeInstanceOf(KyselyRagDocumentStore);
    expect(compiled.sql).toContain('insert into "rag_documents"');
    expect(mapRagDocumentRow(insert)).toMatchObject({
      contentHash: "hash-1",
      id: "document-1",
      metadata: { content_hash: "hash-1", source: "manual" }
    });
  });
});

function createPostgresBuilder(): Kysely<MuseDatabase> {
  return new Kysely<MuseDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
}

describe("Bm25Scorer", () => {
  it("scores and filters indexed documents", () => {
    const scorer = new Bm25Scorer();

    scorer.index("doc-1", "alpha beta beta", { workspaceId: "workspace-1" });
    scorer.index("doc-2", "gamma delta", { workspaceId: "workspace-2" });

    expect(scorer.score("beta", "doc-1")).toBeGreaterThan(0);
    expect(scorer.search("beta", 10, { workspaceId: "workspace-1" }).map(([id]) => id)).toEqual(["doc-1"]);
    expect(scorer.search("beta", 10, { workspaceId: "workspace-2" })).toEqual([]);
  });

  it("supports Korean partial matching tokens", () => {
    expect(tokenize("플랫폼팀은 문서를 관리한다")).toContain("플랫폼팀");
  });
});

describe("RRF and reranking", () => {
  it("fuses rankings without depending on raw score scale", () => {
    const fused = rrfFuse(
      [["a", 100], ["b", 90]],
      [["b", 1], ["c", 0.5]],
      { bm25Weight: 0.5, vectorWeight: 0.5 }
    );

    expect(fused[0]?.[0]).toBe("b");
  });

  it("reranks by lexical overlap while preserving original score", () => {
    const reranked = new SimpleReranker().rerank(
      "alpha",
      [
        { content: "nothing", estimatedTokens: 1, id: "low", metadata: {}, score: 10 },
        { content: "alpha alpha", estimatedTokens: 1, id: "match", metadata: {}, score: 0.1 }
      ],
      2
    );

    expect(reranked[0]?.id).toBe("low");
    expect(reranked[1]?.score).toBeGreaterThan(0.1);
  });
});

describe("advanced RAG retrieval", () => {
  it("combines lexical and vector rankings in a hybrid retriever", async () => {
    const corpus = new InMemoryRagCorpus();
    const vectorStore = new InMemoryVectorStore();
    const embeddingModel = {
      embed: async (text: string) => vectorFor(text)
    };
    const lexicalDocument = {
      content: "Cache invalidation uses deterministic keys.",
      id: "lexical",
      metadata: { workspaceId: "workspace-1" },
      source: "cache"
    };
    const semanticDocument = {
      content: "Muse remembers durable user preferences for future decisions.",
      id: "semantic",
      metadata: { workspaceId: "workspace-1" },
      source: "memory"
    };

    corpus.add(lexicalDocument);
    corpus.add(semanticDocument);
    await vectorStore.upsert(lexicalDocument, [0, 1]);
    await vectorStore.upsert(semanticDocument, [1, 0]);

    const retriever = new HybridDocumentRetriever({
      embeddingModel,
      lexical: corpus,
      vectorStore
    });
    const results = await retriever.retrieve(["remember user choices"], 2, { workspaceId: "workspace-1" });

    expect(results.map((document) => document.id)).toContain("semantic");
    expect(results[0]?.score).toBeGreaterThan(0);
    expect(results[0]?.metadata).toMatchObject({ workspaceId: "workspace-1" });
  });

  it("routes short exact queries to lexical retrieval and semantic comparison queries to hybrid retrieval", async () => {
    const calls: string[] = [];
    const lexical = {
      retrieve: async () => {
        calls.push("lexical");
        return [];
      }
    };
    const hybrid = {
      retrieve: async () => {
        calls.push("hybrid");
        return [];
      }
    };
    const retriever = new AdaptiveRagRetriever({ hybrid, lexical });

    await retriever.retrieve(["cache"], 5);
    await retriever.retrieve(["compare memory and rag tradeoffs for future context"], 5);

    expect(calls).toEqual(["lexical", "hybrid"]);
  });

  it("expands retrieved child chunks back to parent documents", async () => {
    const parent = {
      content: "Full parent document with all migration context.",
      id: "parent-1",
      metadata: { workspaceId: "workspace-1" },
      source: "architecture"
    };
    const parentStore = new InMemoryRagCorpus();
    parentStore.add(parent);
    const retriever = new ParentDocumentRetriever({
      childRetriever: {
        retrieve: async () => [
          {
            content: "migration context",
            estimatedTokens: 2,
            id: "parent-1::chunk-0",
            metadata: {
              chunk_index: 0,
              parent_document_id: "parent-1",
              workspaceId: "workspace-1"
            },
            score: 0.9,
            source: "architecture"
          }
        ]
      },
      parentLookup: parentStore
    });

    const results = await retriever.retrieve(["migration"], 5, { workspaceId: "workspace-1" });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      content: "Full parent document with all migration context.",
      id: "parent-1",
      metadata: {
        matched_child_id: "parent-1::chunk-0",
        workspaceId: "workspace-1"
      },
      score: 0.9,
      source: "architecture"
    });
  });
});

describe("context builders", () => {
  it("builds simple and structured context within a token budget", () => {
    const documents = [
      { content: "alpha", estimatedTokens: 1, id: "doc-1", metadata: {}, score: 1, source: "one" },
      { content: "beta", estimatedTokens: 10, id: "doc-2", metadata: {}, score: 1 }
    ];

    expect(new SimpleContextBuilder().build(documents, 1)).toContain("Source: one");
    expect(JSON.parse(new StructuredContextBuilder().build(documents, 1)).documents).toHaveLength(1);
  });
});

function vectorFor(text: string): readonly number[] {
  return text.includes("remember") || text.includes("preferences") || text.includes("choices")
    ? [1, 0]
    : [0, 1];
}

describe("DefaultRagPipeline", () => {
  it("retrieves, reranks, and builds context from an in-memory corpus", async () => {
    const corpus = new InMemoryRagCorpus();
    corpus.add({
      content: "Muse supports scheduler, cache, and RAG modules.",
      id: "doc-1",
      metadata: { workspaceId: "workspace-1" },
      source: "architecture"
    });
    corpus.add({
      content: "A different workspace has unrelated notes.",
      id: "doc-2",
      metadata: { workspaceId: "workspace-2" }
    });
    const pipeline = new DefaultRagPipeline({
      contextBuilder: new SimpleContextBuilder(),
      queryTransformer: new PassthroughQueryTransformer(),
      reranker: new SimpleReranker(),
      retriever: corpus
    });

    const context = await pipeline.retrieve({
      filters: { workspaceId: "workspace-1" },
      query: "scheduler RAG",
      topK: 3
    });

    expect(context.documents.map((document) => document.id)).toEqual(["doc-1"]);
    expect(context.context).toContain("Muse supports scheduler");
    expect(context.totalTokens).toBeGreaterThan(0);
  });

  it("returns an empty context when no documents match", async () => {
    const pipeline = new DefaultRagPipeline({ retriever: new InMemoryRagCorpus() });

    await expect(pipeline.retrieve({ query: "missing" })).resolves.toEqual(emptyRagContext);
  });

  it("uses conversation-aware query expansion during retrieval", async () => {
    const corpus = new InMemoryRagCorpus();
    corpus.add({
      content: "Slack Socket Mode must acknowledge envelopes before routing app mentions.",
      id: "slack-socket-mode",
      metadata: { workspaceId: "workspace-1" },
      source: "slack"
    });
    const pipeline = new DefaultRagPipeline({
      queryTransformer: new ConversationAwareQueryTransformer({
        history: [{ content: "Review Slack Socket Mode migration risk.", role: "user" }],
        maxHistoryTurns: 1
      }),
      retriever: corpus
    });

    const context = await pipeline.retrieve({
      filters: { workspaceId: "workspace-1" },
      query: "What about acknowledgements?",
      topK: 3
    });

    expect(context.documents.map((document) => document.id)).toEqual(["slack-socket-mode"]);
  });
});

describe("RetrievalEvalRunner", () => {
  it("scores retrieval cases by expected document recall and required source coverage", async () => {
    const corpus = new InMemoryRagCorpus();
    corpus.add({
      content: "Slack Socket Mode must acknowledge envelopes before routing app mentions.",
      id: "slack-socket-mode",
      metadata: { workspaceId: "workspace-1" },
      source: "slack"
    });
    corpus.add({
      content: "MCP runner governance requires dynamic policy checks before live calls.",
      id: "mcp-runner-governance",
      metadata: { workspaceId: "workspace-1" },
      source: "mcp"
    });
    const runner = new RetrievalEvalRunner({
      pipeline: new DefaultRagPipeline({
        queryTransformer: new ConversationAwareQueryTransformer({
          history: [{ content: "Review Slack Socket Mode migration risk.", role: "user" }]
        }),
        retriever: corpus
      })
    });

    const result = await runner.runCase({
      expectedDocumentIds: ["slack-socket-mode"],
      id: "rag-case-1",
      query: "What about acknowledgements?",
      requiredSources: ["slack"],
      topK: 3
    });

    expect(result).toMatchObject({
      caseId: "rag-case-1",
      missingDocumentIds: [],
      missingSources: [],
      passed: true,
      recall: 1,
      retrievedDocumentIds: ["slack-socket-mode"]
    });
  });

  it("fails retrieval cases when expected documents or token budgets are missed", async () => {
    const corpus = new InMemoryRagCorpus();
    corpus.add({
      content: "A long unrelated document that does not satisfy the expected migration evidence.",
      id: "unrelated",
      metadata: {},
      source: "notes"
    });
    const runner = new RetrievalEvalRunner({
      pipeline: new DefaultRagPipeline({
        contextBuilder: new SimpleContextBuilder(),
        retriever: corpus
      })
    });

    const result = await runner.runCase({
      expectedDocumentIds: ["target"],
      id: "rag-case-2",
      maxTotalTokens: 1,
      query: "unrelated",
      topK: 1
    });

    expect(result).toMatchObject({
      caseId: "rag-case-2",
      missingDocumentIds: ["target"],
      passed: false,
      recall: 0
    });
    expect(result.reasons).toContain("Missing expected documents: target");
    expect(result.reasons.some((reason) => reason.startsWith("Context token budget exceeded:"))).toBe(true);
  });
});

describe("HypotheticalDocumentQueryTransformer", () => {
  it("adds a generated hypothetical document query while preserving the original query first", async () => {
    const transformer = new HypotheticalDocumentQueryTransformer({
      generate: async (query) => `Hypothetical answer for ${query}`
    });

    await expect(transformer.transform("release checklist")).resolves.toEqual([
      "release checklist",
      "Hypothetical answer for release checklist"
    ]);
  });
});

describe("decomposition and compression", () => {
  it("expands follow-up retrieval queries with recent conversation context", () => {
    const transformer = new ConversationAwareQueryTransformer({
      history: [
        { content: "Compare Slack Socket Mode and MCP runner migration risks.", role: "user" },
        { content: "Socket Mode has live transport risk; MCP runner has policy risk.", role: "assistant" }
      ],
      maxHistoryTurns: 1
    });

    expect(transformer.transform("What about approval UX?")).toEqual([
      "What about approval UX?",
      "Compare Slack Socket Mode and MCP runner migration risks. What about approval UX?"
    ]);
  });

  it("keeps the original query when conversation expansion has no usable history", () => {
    const transformer = new ConversationAwareQueryTransformer({ includeOriginal: false });

    expect(transformer.transform("standalone retrieval query")).toEqual(["standalone retrieval query"]);
  });

  it("decomposes comparison queries into bounded subqueries", () => {
    const transformer = new DecomposingQueryTransformer({ maxQueries: 3 });

    expect(transformer.transform("compare cache and rag then decide")).toEqual([
      "compare cache and rag then decide",
      "compare cache",
      "rag"
    ]);
  });

  it("extracts query-relevant sentences from retrieved documents", () => {
    const compressor = new ExtractiveContextCompressor({ maxSentencesPerDocument: 1, minScore: 0.1 });
    const [document] = compressor.compress("rag scheduler", [
      {
        content: "Billing notes are unrelated. RAG scheduler keeps documents fresh. Slack alerts are separate.",
        estimatedTokens: 12,
        id: "doc-1",
        metadata: {},
        score: 1
      }
    ]);

    expect(document).toMatchObject({
      content: "RAG scheduler keeps documents fresh.",
      metadata: { compressed: true, originalEstimatedTokens: 12 }
    });
  });
});
