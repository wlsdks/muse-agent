import { createApproximateTokenEstimator, type TokenEstimator } from "@muse/memory";
import type { ModelMessage, ModelProvider, ModelRequest } from "@muse/model";
import { createRunId, type JsonObject, type JsonValue } from "@muse/shared";

export type Awaitable<T> = T | Promise<T>;

export interface RagDocument {
  readonly id: string;
  readonly content: string;
  readonly metadata: JsonObject;
  readonly source?: string;
}

export interface StoredRagDocument extends RagDocument {
  readonly chunkCount: number;
  readonly chunkIds: readonly string[];
  readonly contentHash: string;
  readonly createdAt: Date;
  readonly indexed: boolean;
  readonly updatedAt: Date;
}

export interface RetrievedDocument extends RagDocument {
  readonly score: number;
  readonly estimatedTokens: number;
}

export interface RagQuery {
  readonly query: string;
  readonly topK?: number;
  readonly filters?: JsonObject;
  readonly rerank?: boolean;
}

export interface RagContext {
  readonly context: string;
  readonly documents: readonly RetrievedDocument[];
  readonly totalTokens: number;
}

export interface DocumentChunker {
  chunk(document: RagDocument): readonly RagDocument[];
}

export interface DocumentRetriever {
  retrieve(queries: readonly string[], topK: number, filters?: JsonObject): Awaitable<readonly RetrievedDocument[]>;
}

export interface DocumentLookup {
  get(id: string): Awaitable<RagDocument | undefined>;
}

export interface EmbeddingModel {
  embed(text: string): Awaitable<readonly number[]>;
}

export interface VectorSearchResult {
  readonly id: string;
  readonly score: number;
}

export interface VectorStore extends DocumentLookup {
  upsert(document: RagDocument, embedding: readonly number[]): Awaitable<void>;
  search(embedding: readonly number[], topK: number, filters?: JsonObject): Awaitable<readonly VectorSearchResult[]>;
}

export interface DocumentReranker {
  rerank(query: string, documents: readonly RetrievedDocument[], topK: number): Awaitable<readonly RetrievedDocument[]>;
}

export interface QueryTransformer {
  transform(query: string): Awaitable<readonly string[]>;
}

export interface ConversationAwareQueryTurn {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ConversationAwareQueryTransformerOptions {
  readonly history?: readonly ConversationAwareQueryTurn[];
  readonly includeOriginal?: boolean;
  readonly maxHistoryTurns?: number;
  readonly maxQueries?: number;
  readonly maxContextChars?: number;
}

export interface HypotheticalDocumentQueryTransformerOptions {
  readonly generate: (query: string) => Awaitable<string>;
  readonly includeOriginal?: boolean;
}

export interface DecomposingQueryTransformerOptions {
  readonly includeOriginal?: boolean;
  readonly maxQueries?: number;
}

export interface ExtractiveContextCompressorOptions {
  readonly maxSentencesPerDocument?: number;
  readonly minScore?: number;
}

export interface ContextCompressor {
  compress(query: string, documents: readonly RetrievedDocument[]): Awaitable<readonly RetrievedDocument[]>;
}

export type ContextBuilder = (
  documents: readonly RetrievedDocument[],
  maxTokens: number
) => string;

export interface RagPipeline {
  retrieve(query: RagQuery): Promise<RagContext>;
}

export interface RetrievalEvalCase {
  readonly id: string;
  readonly query: string;
  readonly expectedDocumentIds?: readonly string[];
  readonly requiredSources?: readonly string[];
  readonly filters?: JsonObject;
  readonly topK?: number;
  readonly maxTotalTokens?: number;
}

export interface RetrievalEvalResult {
  readonly caseId: string;
  readonly passed: boolean;
  readonly recall: number;
  readonly retrievedDocumentIds: readonly string[];
  readonly missingDocumentIds: readonly string[];
  readonly missingSources: readonly string[];
  readonly totalTokens: number;
  readonly reasons: readonly string[];
}

export interface RetrievalEvalRunnerOptions {
  readonly pipeline: RagPipeline;
}

export type RagIngestionCandidateStatus = "PENDING" | "REJECTED" | "INGESTED";

export interface RagIngestionPolicy {
  readonly enabled: boolean;
  readonly requireReview: boolean;
  readonly allowedChannels: readonly string[];
  readonly minQueryChars: number;
  readonly minResponseChars: number;
  readonly blockedPatterns: readonly string[];
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface RagIngestionCandidate {
  readonly id?: string;
  readonly runId: string;
  readonly userId: string;
  readonly sessionId?: string | null;
  readonly channel?: string | null;
  readonly query: string;
  readonly response: string;
  readonly status?: RagIngestionCandidateStatus;
  readonly capturedAt?: Date;
  readonly reviewedAt?: Date | null;
  readonly reviewedBy?: string | null;
  readonly reviewComment?: string | null;
  readonly ingestedDocumentId?: string | null;
}

export interface StoredRagIngestionCandidate extends Required<Omit<RagIngestionCandidate, "id" | "sessionId" | "channel" | "status" | "capturedAt" | "reviewedAt" | "reviewedBy" | "reviewComment" | "ingestedDocumentId">> {
  readonly id: string;
  readonly sessionId: string | null;
  readonly channel: string | null;
  readonly status: RagIngestionCandidateStatus;
  readonly capturedAt: Date;
  readonly reviewedAt: Date | null;
  readonly reviewedBy: string | null;
  readonly reviewComment: string | null;
  readonly ingestedDocumentId: string | null;
}

export interface RagIngestionPolicyStore {
  getOrNull(): Awaitable<RagIngestionPolicy | undefined>;
  save(policy: RagIngestionPolicy): Awaitable<RagIngestionPolicy>;
  delete(): Awaitable<boolean>;
}

export interface RagIngestionCandidateStore {
  save(candidate: RagIngestionCandidate): Awaitable<StoredRagIngestionCandidate>;
  findById(id: string): Awaitable<StoredRagIngestionCandidate | undefined>;
  findByRunId(runId: string): Awaitable<StoredRagIngestionCandidate | undefined>;
  list(options?: {
    readonly limit?: number;
    readonly status?: RagIngestionCandidateStatus;
    readonly channel?: string;
  }): Awaitable<readonly StoredRagIngestionCandidate[]>;
  updateReview(input: {
    readonly id: string;
    readonly status: Exclude<RagIngestionCandidateStatus, "PENDING">;
    readonly reviewedBy: string;
    readonly reviewComment?: string | null;
    readonly ingestedDocumentId?: string | null;
  }): Awaitable<StoredRagIngestionCandidate | undefined>;
}

export interface RagDocumentInput {
  readonly id?: string;
  readonly content: string;
  readonly metadata?: JsonObject;
  readonly source?: string | null;
  readonly contentHash?: string;
  readonly chunkCount?: number;
  readonly chunkIds?: readonly string[];
  readonly indexed?: boolean;
}

export interface RagDocumentStore {
  save(document: RagDocumentInput): Awaitable<StoredRagDocument>;
  findById(id: string): Awaitable<StoredRagDocument | undefined>;
  findByContentHash(contentHash: string): Awaitable<StoredRagDocument | undefined>;
  list(options?: { readonly limit?: number }): Awaitable<readonly StoredRagDocument[]>;
  search(query: string, options?: { readonly limit?: number }): Awaitable<readonly StoredRagDocument[]>;
  delete(id: string): Awaitable<boolean>;
  deleteMany(ids: readonly string[]): Awaitable<number>;
  count(): Awaitable<number>;
}

export interface TokenBasedDocumentChunkerOptions {
  readonly chunkSize?: number;
  readonly minChunkSizeChars?: number;
  readonly minChunkThreshold?: number;
  readonly overlap?: number;
  readonly keepSeparator?: boolean;
  readonly maxNumChunks?: number;
  readonly tokenEstimator?: TokenEstimator;
}

export interface DefaultRagPipelineOptions {
  readonly queryTransformer?: QueryTransformer;
  readonly retriever: DocumentRetriever;
  readonly reranker?: DocumentReranker;
  readonly contextCompressor?: ContextCompressor;
  readonly contextBuilder?: ContextBuilder;
  readonly maxContextTokens?: number;
  readonly tokenEstimator?: TokenEstimator;
}

export interface InMemoryRagCorpusOptions {
  readonly chunker?: DocumentChunker;
  readonly tokenEstimator?: TokenEstimator;
}

export interface HybridDocumentRetrieverOptions {
  readonly lexical: DocumentRetriever;
  readonly vectorStore: VectorStore;
  readonly embeddingModel: EmbeddingModel;
  readonly bm25Weight?: number;
  readonly vectorWeight?: number;
  readonly tokenEstimator?: TokenEstimator;
}

export interface AdaptiveRagRetrieverOptions {
  readonly lexical: DocumentRetriever;
  readonly hybrid: DocumentRetriever;
  readonly route?: (queries: readonly string[]) => "lexical" | "hybrid";
}

export interface ParentDocumentRetrieverOptions {
  readonly childRetriever: DocumentRetriever;
  readonly parentLookup: DocumentLookup | ((id: string) => Awaitable<RagDocument | undefined>);
  readonly tokenEstimator?: TokenEstimator;
}

export interface ChunkMergingRetrieverOptions {
  readonly windowSize?: number;
  readonly separator?: string;
}

export const emptyRagContext: RagContext = {
  context: "",
  documents: [],
  totalTokens: 0
};

const defaultTopK = 5;
const defaultMaxContextTokens = 4_000;
const defaultChunkSize = 512;
const defaultMinChunkSizeChars = 350;
const defaultMinChunkThreshold = 512;
const defaultOverlap = 50;
const defaultMaxNumChunks = 100;
const minTokenLength = 2;
const maxKoreanNgramLength = 4;
// RAG persistence kernel (in-memory + Kysely stores, row mappers,
// upsert query builders, normalize helpers) lives in
// packages/rag/src/rag-stores.ts.
export {
  buildRagIngestionPolicyUpsertQuery,
  createRagDocumentInsert,
  createRagIngestionCandidateInsert,
  createRagIngestionPolicyInsert,
  InMemoryRagDocumentStore,
  InMemoryRagIngestionCandidateStore,
  InMemoryRagIngestionPolicyStore,
  KyselyRagDocumentStore,
  KyselyRagIngestionCandidateStore,
  KyselyRagIngestionPolicyStore,
  mapRagDocumentRow,
  mapRagIngestionCandidateRow,
  mapRagIngestionPolicyRow
} from "./rag-stores.js";

export class TokenBasedDocumentChunker implements DocumentChunker {
  private readonly chunkSize: number;
  private readonly minChunkSizeChars: number;
  private readonly minChunkThreshold: number;
  private readonly overlap: number;
  private readonly keepSeparator: boolean;
  private readonly maxNumChunks: number;
  private readonly tokenEstimator: TokenEstimator;

  constructor(options: TokenBasedDocumentChunkerOptions = {}) {
    this.chunkSize = Math.max(1, options.chunkSize ?? defaultChunkSize);
    this.minChunkSizeChars = Math.max(1, options.minChunkSizeChars ?? defaultMinChunkSizeChars);
    this.minChunkThreshold = Math.max(1, options.minChunkThreshold ?? defaultMinChunkThreshold);
    this.overlap = Math.max(0, options.overlap ?? defaultOverlap);
    this.keepSeparator = options.keepSeparator ?? true;
    this.maxNumChunks = Math.max(1, options.maxNumChunks ?? defaultMaxNumChunks);
    this.tokenEstimator = options.tokenEstimator ?? createApproximateTokenEstimator();
  }

  chunk(document: RagDocument): readonly RagDocument[] {
    const content = document.content;

    if (content.trim().length === 0) {
      return [document];
    }

    const estimatedTokens = this.tokenEstimator.estimate(content);

    if (estimatedTokens <= this.minChunkThreshold) {
      return [document];
    }

    const charsPerToken = content.length / estimatedTokens;
    const targetChars = Math.max(1, Math.floor(this.chunkSize * charsPerToken));
    const overlapChars = Math.max(0, Math.floor(this.overlap * charsPerToken));
    const chunks = this.splitRecursive(content, targetChars, overlapChars);

    if (chunks.length <= 1) {
      return [document];
    }

    return chunks.map((chunk, index) => ({
      content: chunk,
      id: chunkId(document.id, index),
      metadata: {
        ...document.metadata,
        chunk_index: index,
        chunk_total: chunks.length,
        chunked: true,
        parent_document_id: document.id
      },
      source: document.source
    }));
  }

  private splitRecursive(text: string, targetSize: number, overlapSize: number): readonly string[] {
    if (text.length <= targetSize) {
      return [text];
    }

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length && chunks.length < this.maxNumChunks) {
      let end = Math.min(start + targetSize, text.length);

      if (end < text.length) {
        end = this.findBreakPoint(text, start, end);
      }

      const chunk = text.slice(start, end).trim();

      if (chunk.length >= this.minChunkSizeChars || chunks.length === 0) {
        chunks.push(chunk);
      } else if (chunks.length > 0) {
        const previous = chunks.pop() ?? "";
        chunks.push(`${previous}\n${chunk}`);
      }

      const nextStart = end - overlapSize;
      start = nextStart <= start ? end : nextStart;
    }

    return chunks;
  }

  private findBreakPoint(text: string, start: number, end: number): number {
    const searchFrom = start + Math.floor((end - start) / 2);
    const paragraphBreak = text.lastIndexOf("\n\n", end);

    if (paragraphBreak > searchFrom) {
      return this.keepSeparator ? paragraphBreak : paragraphBreak + 2;
    }

    const lineBreak = text.lastIndexOf("\n", end);

    if (lineBreak > searchFrom) {
      return this.keepSeparator ? lineBreak : lineBreak + 1;
    }

    for (let index = end; index >= searchFrom; index -= 1) {
      const current = text[index];
      const next = text[index + 1];

      if (current && sentenceEnds.has(current) && (!next || /\s/u.test(next))) {
        return index + 1;
      }
    }

    const spaceBreak = text.lastIndexOf(" ", end);
    return spaceBreak > searchFrom ? spaceBreak + 1 : end;
  }
}

export class Bm25Scorer {
  private readonly docContents = new Map<string, string>();
  private readonly docMetadata = new Map<string, JsonObject>();
  private readonly termFrequencies = new Map<string, Map<string, number>>();
  private readonly documentLengths = new Map<string, number>();
  private readonly documentFrequency = new Map<string, number>();
  private idfCache = new Map<string, number>();
  private totalLength = 0;

  constructor(
    private readonly k1 = 1.5,
    private readonly b = 0.75
  ) {}

  index(docId: string, content: string, metadata: JsonObject = {}): void {
    const tokens = tokenize(content);
    const termFrequency = countTerms(tokens);
    const existing = this.termFrequencies.get(docId);

    if (existing) {
      this.totalLength -= sum([...existing.values()]);

      for (const token of existing.keys()) {
        const count = this.documentFrequency.get(token) ?? 1;
        count <= 1 ? this.documentFrequency.delete(token) : this.documentFrequency.set(token, count - 1);
      }
    }

    this.docContents.set(docId, content);
    this.docMetadata.set(docId, metadata);
    this.termFrequencies.set(docId, termFrequency);
    this.documentLengths.set(docId, tokens.length);
    this.totalLength += tokens.length;

    for (const token of termFrequency.keys()) {
      this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
    }

    this.idfCache = new Map();
  }

  score(query: string, docId: string): number {
    const termFrequency = this.termFrequencies.get(docId);

    if (!termFrequency) {
      return 0;
    }

    return this.scoreWithTokens(
      new Set(tokenize(query)),
      termFrequency,
      this.documentLengths.get(docId) ?? sum([...termFrequency.values()]),
      this.getIdf(),
      this.averageLength()
    );
  }

  search(query: string, topK: number, filters: JsonObject = {}): readonly (readonly [string, number])[] {
    const queryTokens = new Set(tokenize(query));
    const idf = this.getIdf();
    const averageLength = this.averageLength();
    const results: (readonly [string, number])[] = [];

    for (const [docId, termFrequency] of this.termFrequencies) {
      if (!this.matchesFilters(docId, filters)) {
        continue;
      }

      const score = this.scoreWithTokens(
        queryTokens,
        termFrequency,
        this.documentLengths.get(docId) ?? sum([...termFrequency.values()]),
        idf,
        averageLength
      );

      if (score > 0) {
        results.push([docId, score]);
      }
    }

    return results.sort((left, right) => right[1] - left[1]).slice(0, Math.max(0, topK));
  }

  getContent(docId: string): string | undefined {
    return this.docContents.get(docId);
  }

  getMetadata(docId: string): JsonObject {
    return this.docMetadata.get(docId) ?? {};
  }

  clear(): void {
    this.docContents.clear();
    this.docMetadata.clear();
    this.termFrequencies.clear();
    this.documentLengths.clear();
    this.documentFrequency.clear();
    this.idfCache.clear();
    this.totalLength = 0;
  }

  size(): number {
    return this.termFrequencies.size;
  }

  private averageLength(): number {
    return this.termFrequencies.size === 0 || this.totalLength === 0
      ? 1
      : this.totalLength / this.termFrequencies.size;
  }

  private getIdf(): Map<string, number> {
    if (this.idfCache.size > 0) {
      return this.idfCache;
    }

    const documentCount = this.termFrequencies.size;
    this.idfCache = new Map(
      [...this.documentFrequency.entries()].map(([token, frequency]) => [
        token,
        Math.log((documentCount - frequency + 0.5) / (frequency + 0.5) + 1)
      ])
    );
    return this.idfCache;
  }

  private scoreWithTokens(
    queryTokens: ReadonlySet<string>,
    termFrequency: ReadonlyMap<string, number>,
    documentLength: number,
    idf: ReadonlyMap<string, number>,
    averageLength: number
  ): number {
    let score = 0;

    for (const token of queryTokens) {
      const frequency = termFrequency.get(token) ?? 0;
      const idfScore = idf.get(token) ?? 0;
      const numerator = frequency * (this.k1 + 1);
      const denominator = frequency + this.k1 * (1 - this.b + (this.b * documentLength) / averageLength);
      score += denominator === 0 ? 0 : idfScore * (numerator / denominator);
    }

    return score;
  }

  private matchesFilters(docId: string, filters: JsonObject): boolean {
    if (Object.keys(filters).length === 0) {
      return true;
    }

    const metadata = this.docMetadata.get(docId);

    if (!metadata) {
      return false;
    }

    return Object.entries(filters).every(([key, expected]) => String(metadata[key]) === String(expected));
  }
}

export class InMemoryRagCorpus implements DocumentRetriever {
  private readonly scorer = new Bm25Scorer();
  private readonly documents = new Map<string, RagDocument>();
  private readonly chunker?: DocumentChunker;
  private readonly tokenEstimator: TokenEstimator;

  constructor(options: InMemoryRagCorpusOptions = {}) {
    this.chunker = options.chunker;
    this.tokenEstimator = options.tokenEstimator ?? createApproximateTokenEstimator();
  }

  add(document: RagDocument): readonly RagDocument[] {
    const chunks = this.chunker ? this.chunker.chunk(document) : [document];

    for (const chunk of chunks) {
      this.documents.set(chunk.id, chunk);
      this.scorer.index(chunk.id, chunk.content, chunk.metadata);
    }

    return chunks;
  }

  addText(content: string, metadata: JsonObject = {}, source?: string): readonly RagDocument[] {
    return this.add({
      content,
      id: createRunId("rag_doc"),
      metadata,
      source
    });
  }

  get(id: string): RagDocument | undefined {
    return this.documents.get(id);
  }

  retrieve(queries: readonly string[], topK: number, filters: JsonObject = {}): readonly RetrievedDocument[] {
    const merged = new Map<string, number>();

    for (const query of queries) {
      for (const [docId, score] of this.scorer.search(query, topK, filters)) {
        merged.set(docId, Math.max(merged.get(docId) ?? 0, score));
      }
    }

    return [...merged.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, Math.max(0, topK))
      .flatMap(([docId, score]) => {
        const document = this.documents.get(docId);

        if (!document) {
          return [];
        }

        return [
          {
            ...document,
            estimatedTokens: this.tokenEstimator.estimate(document.content),
            score
          }
        ];
      });
  }

  clear(): void {
    this.documents.clear();
    this.scorer.clear();
  }

  size(): number {
    return this.documents.size;
  }
}

export class InMemoryVectorStore implements VectorStore {
  private readonly documents = new Map<string, RagDocument>();
  private readonly embeddings = new Map<string, readonly number[]>();

  upsert(document: RagDocument, embedding: readonly number[]): void {
    if (embedding.length === 0) {
      throw new Error("Vector embedding must not be empty.");
    }

    this.documents.set(document.id, document);
    this.embeddings.set(document.id, [...embedding]);
  }

  get(id: string): RagDocument | undefined {
    return this.documents.get(id);
  }

  search(embedding: readonly number[], topK: number, filters: JsonObject = {}): readonly VectorSearchResult[] {
    if (embedding.length === 0 || topK <= 0) {
      return [];
    }

    const results: VectorSearchResult[] = [];

    for (const [id, candidateEmbedding] of this.embeddings) {
      const document = this.documents.get(id);

      if (!document || !matchesMetadataFilters(document.metadata, filters)) {
        continue;
      }

      const score = cosineSimilarity(embedding, candidateEmbedding);

      if (score > 0) {
        results.push({ id, score });
      }
    }

    return results.sort((left, right) => right.score - left.score).slice(0, Math.max(0, topK));
  }

  clear(): void {
    this.documents.clear();
    this.embeddings.clear();
  }

  size(): number {
    return this.documents.size;
  }
}

export class HybridDocumentRetriever implements DocumentRetriever {
  private readonly lexical: DocumentRetriever;
  private readonly vectorStore: VectorStore;
  private readonly embeddingModel: EmbeddingModel;
  private readonly bm25Weight: number;
  private readonly vectorWeight: number;
  private readonly tokenEstimator: TokenEstimator;

  constructor(options: HybridDocumentRetrieverOptions) {
    this.lexical = options.lexical;
    this.vectorStore = options.vectorStore;
    this.embeddingModel = options.embeddingModel;
    this.bm25Weight = options.bm25Weight ?? 0.5;
    this.vectorWeight = options.vectorWeight ?? 0.5;
    this.tokenEstimator = options.tokenEstimator ?? createApproximateTokenEstimator();
  }

  async retrieve(queries: readonly string[], topK: number, filters: JsonObject = {}): Promise<readonly RetrievedDocument[]> {
    const limit = Math.max(0, topK);
    const byId = new Map<string, RagDocument>();
    const lexicalRanks: (readonly [string, number])[] = [];
    const vectorRanks: (readonly [string, number])[] = [];

    if (limit === 0) {
      return [];
    }

    for (const query of queries) {
      const lexicalDocuments = await this.lexical.retrieve([query], limit, filters);

      for (const document of lexicalDocuments) {
        byId.set(document.id, document);
        lexicalRanks.push([document.id, document.score]);
      }

      const embedding = await this.embeddingModel.embed(query);
      const vectorDocuments = await this.vectorStore.search(embedding, limit, filters);

      for (const result of vectorDocuments) {
        const document = await this.vectorStore.get(result.id);

        if (document) {
          byId.set(document.id, document);
          vectorRanks.push([result.id, result.score]);
        }
      }
    }

    return rrfFuse(vectorRanks, lexicalRanks, {
      bm25Weight: this.bm25Weight,
      vectorWeight: this.vectorWeight
    })
      .slice(0, limit)
      .flatMap(([id, score]) => {
        const document = byId.get(id);

        if (!document) {
          return [];
        }

        return [{
          ...document,
          estimatedTokens: this.tokenEstimator.estimate(document.content),
          score
        }];
      });
  }
}

export class AdaptiveRagRetriever implements DocumentRetriever {
  private readonly lexical: DocumentRetriever;
  private readonly hybrid: DocumentRetriever;
  private readonly route: (queries: readonly string[]) => "lexical" | "hybrid";

  constructor(options: AdaptiveRagRetrieverOptions) {
    this.lexical = options.lexical;
    this.hybrid = options.hybrid;
    this.route = options.route ?? defaultRagRetrievalRoute;
  }

  retrieve(queries: readonly string[], topK: number, filters: JsonObject = {}): Awaitable<readonly RetrievedDocument[]> {
    return this.route(queries) === "hybrid"
      ? this.hybrid.retrieve(queries, topK, filters)
      : this.lexical.retrieve(queries, topK, filters);
  }
}

export class ParentDocumentRetriever implements DocumentRetriever {
  private readonly childRetriever: DocumentRetriever;
  private readonly parentLookup: (id: string) => Awaitable<RagDocument | undefined>;
  private readonly tokenEstimator: TokenEstimator;

  constructor(options: ParentDocumentRetrieverOptions) {
    this.childRetriever = options.childRetriever;
    const parentLookup = options.parentLookup;
    this.parentLookup = typeof parentLookup === "function"
      ? parentLookup
      : (id) => parentLookup.get(id);
    this.tokenEstimator = options.tokenEstimator ?? createApproximateTokenEstimator();
  }

  async retrieve(queries: readonly string[], topK: number, filters: JsonObject = {}): Promise<readonly RetrievedDocument[]> {
    const children = await this.childRetriever.retrieve(queries, topK, filters);
    const expanded = new Map<string, RetrievedDocument>();

    for (const child of children) {
      const parentId = typeof child.metadata.parent_document_id === "string"
        ? child.metadata.parent_document_id
        : undefined;

      if (!parentId) {
        this.addBest(expanded, child.id, child);
        continue;
      }

      const parent = await this.parentLookup(parentId);

      if (!parent) {
        this.addBest(expanded, child.id, child);
        continue;
      }

      this.addBest(expanded, parent.id, {
        ...parent,
        estimatedTokens: this.tokenEstimator.estimate(parent.content),
        metadata: {
          ...parent.metadata,
          matched_child_id: child.id,
          matched_child_score: child.score
        },
        score: child.score
      });
    }

    return [...expanded.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(0, topK));
  }

  private addBest(documents: Map<string, RetrievedDocument>, id: string, document: RetrievedDocument): void {
    const existing = documents.get(id);

    if (!existing || document.score > existing.score) {
      documents.set(id, document);
    }
  }
}

/**
 * Chunk-aware document merger (decorator pattern).
 *
 * Wraps a `DocumentRetriever` so chunk-level hits are merged back into a single
 * document per parent before being returned. Mirrors Reactor's
 * `ParentDocumentRetriever` Mixture-of-Granularity behavior: precise chunk
 * search + re-assembled context for the LLM, while non-chunked hits pass
 * through untouched.
 *
 * A document is considered "chunked" when its metadata carries `chunked: true`
 * and a `parent_document_id`. `chunk_index` is used to order the merged
 * content. The merged document keeps the highest score among its chunks and
 * surfaces `merged_chunks`, `window_size`, and `chunk_indices` metadata so
 * downstream rankers / evaluators can see what was joined.
 */
export function createChunkMergingRetriever(
  delegate: DocumentRetriever,
  options: ChunkMergingRetrieverOptions = {}
): DocumentRetriever {
  const windowSize = Math.max(0, options.windowSize ?? 1);
  const separator = options.separator ?? "\n";

  return {
    retrieve: async (
      queries: readonly string[],
      topK: number,
      filters: JsonObject = {}
    ): Promise<readonly RetrievedDocument[]> => {
      const results = await delegate.retrieve(queries, topK, filters);
      if (results.length === 0) {
        return results;
      }
      const chunked: RetrievedDocument[] = [];
      const nonChunked: RetrievedDocument[] = [];
      for (const document of results) {
        if (isChunkedDocument(document)) {
          chunked.push(document);
        } else {
          nonChunked.push(document);
        }
      }
      if (chunked.length === 0) {
        return results;
      }
      const grouped = new Map<string, RetrievedDocument[]>();
      for (const document of chunked) {
        const parentId = readParentId(document);
        const bucket = grouped.get(parentId);
        if (bucket) {
          bucket.push(document);
        } else {
          grouped.set(parentId, [document]);
        }
      }
      const merged: RetrievedDocument[] = [];
      for (const [parentId, hits] of grouped.entries()) {
        const sorted = [...hits].sort(
          (left, right) => (readChunkIndex(left) ?? 0) - (readChunkIndex(right) ?? 0)
        );
        const bestScore = sorted.reduce((max, hit) => Math.max(max, hit.score), Number.NEGATIVE_INFINITY);
        const firstChunk = sorted[0];
        if (!firstChunk) {
          continue;
        }
        const mergedContent = sorted.map((hit) => hit.content).join(separator);
        const chunkIndicesValue = sorted
          .map(readChunkIndex)
          .filter((value): value is number => value !== undefined)
          .join(",");
        const baseMetadata = (firstChunk.metadata ?? {}) as Record<string, JsonValue>;
        const mergedMetadata: Record<string, JsonValue> = {
          ...baseMetadata,
          chunk_indices: chunkIndicesValue,
          merged_chunks: sorted.length,
          window_size: windowSize
        };
        const totalEstimatedTokens = sorted.reduce((sum, hit) => sum + (hit.estimatedTokens ?? 0), 0);
        merged.push({
          ...(firstChunk.source ? { source: firstChunk.source } : {}),
          content: mergedContent,
          estimatedTokens: totalEstimatedTokens > 0 ? totalEstimatedTokens : Math.ceil(mergedContent.length / 4),
          id: parentId,
          metadata: mergedMetadata,
          score: bestScore
        });
      }
      const seen = new Map<string, RetrievedDocument>();
      for (const document of [...merged, ...nonChunked].sort((left, right) => right.score - left.score)) {
        if (!seen.has(document.id)) {
          seen.set(document.id, document);
        }
      }
      return [...seen.values()].slice(0, Math.max(0, topK));
    }
  };
}

function isChunkedDocument(document: RetrievedDocument): boolean {
  const metadata = (document.metadata ?? {}) as Record<string, JsonValue>;
  return metadata["chunked"] === true && typeof metadata["parent_document_id"] === "string";
}

function readParentId(document: RetrievedDocument): string {
  const metadata = (document.metadata ?? {}) as Record<string, JsonValue>;
  const value = metadata["parent_document_id"];
  return typeof value === "string" && value.length > 0 ? value : document.id;
}

function readChunkIndex(document: RetrievedDocument): number | undefined {
  const metadata = (document.metadata ?? {}) as Record<string, JsonValue>;
  const value = metadata["chunk_index"];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export class SimpleReranker implements DocumentReranker {
  rerank(query: string, documents: readonly RetrievedDocument[], topK: number): readonly RetrievedDocument[] {
    const queryTokens = new Set(tokenize(query));

    return [...documents]
      .map((document) => ({
        document,
        score: document.score + overlapScore(queryTokens, new Set(tokenize(document.content)))
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(0, topK))
      .map(({ document, score }) => ({ ...document, score }));
  }
}

/**
 * Factory for a `ContextBuilder` that joins documents with a configurable
 * separator and prefixes each one with `[<index>] Source: <source>`. Stops
 * once the cumulative `estimatedTokens` would exceed the requested budget.
 */
export function simpleContextBuilder(separator = "\n\n---\n\n"): ContextBuilder {
  return (documents, maxTokens) => {
    const sections: string[] = [];
    let currentTokens = 0;
    let index = 1;

    for (const document of documents) {
      if (currentTokens + document.estimatedTokens > maxTokens) {
        break;
      }

      const source = document.source ? ` Source: ${document.source}` : "";
      sections.push(`[${index}]${source}\n${document.content}`);
      currentTokens += document.estimatedTokens;
      index += 1;
    }

    return sections.join(separator);
  };
}

/**
 * Factory for a `ContextBuilder` that emits a JSON envelope
 * `{ documents: [{ id, source, content, score, metadata }] }`. Stops once
 * the cumulative `estimatedTokens` would exceed the requested budget.
 */
export function structuredContextBuilder(): ContextBuilder {
  return (documents, maxTokens) => {
    const selected: JsonObject[] = [];
    let currentTokens = 0;

    for (const document of documents) {
      if (currentTokens + document.estimatedTokens > maxTokens) {
        break;
      }

      selected.push({
        content: document.content,
        id: document.id,
        metadata: document.metadata,
        score: document.score,
        source: document.source ?? null
      });
      currentTokens += document.estimatedTokens;
    }

    return JSON.stringify({ documents: selected }, null, 2);
  };
}


// RAG query transformers + adaptive router + contextual compressors
// live in packages/rag/src/rag-query-transformers.ts.
export {
  ADAPTIVE_QUERY_ROUTER_DEFAULT_SYSTEM_PROMPT,
  ConversationAwareQueryTransformer,
  createLlmAdaptiveQueryRouter,
  createLlmContextualCompressor,
  createLlmDecomposingQueryTransformer,
  createLlmHypotheticalDocumentTransformer,
  DECOMPOSE_DEFAULT_SYSTEM_PROMPT,
  DecomposingQueryTransformer,
  ExtractiveContextCompressor,
  HYDE_DEFAULT_SYSTEM_PROMPT,
  HypotheticalDocumentQueryTransformer,
  LLM_CONTEXTUAL_COMPRESSOR_DEFAULT_SYSTEM_PROMPT,
  parseDecompositionLines,
  parseQueryComplexity,
  PassthroughQueryTransformer,
  type LlmAdaptiveQueryRouterOptions,
  type LlmContextualCompressorOptions,
  type LlmDecomposingQueryTransformerOptions,
  type LlmHypotheticalDocumentTransformerOptions,
  type QueryComplexity,
  type QueryRouter
} from "./rag-query-transformers.js";

export class DefaultRagPipeline implements RagPipeline {
  private readonly queryTransformer?: QueryTransformer;
  private readonly retriever: DocumentRetriever;
  private readonly reranker?: DocumentReranker;
  private readonly contextCompressor?: ContextCompressor;
  private readonly contextBuilder: ContextBuilder;
  private readonly maxContextTokens: number;
  private readonly tokenEstimator: TokenEstimator;

  constructor(options: DefaultRagPipelineOptions) {
    this.queryTransformer = options.queryTransformer;
    this.retriever = options.retriever;
    this.reranker = options.reranker;
    this.contextCompressor = options.contextCompressor;
    this.contextBuilder = options.contextBuilder ?? structuredContextBuilder();
    this.maxContextTokens = options.maxContextTokens ?? defaultMaxContextTokens;
    this.tokenEstimator = options.tokenEstimator ?? createApproximateTokenEstimator();
  }

  async retrieve(query: RagQuery): Promise<RagContext> {
    const queries = this.queryTransformer
      ? await this.queryTransformer.transform(query.query)
      : [query.query];
    const topK = query.topK ?? defaultTopK;
    const documents = await this.retriever.retrieve(queries, topK, query.filters);

    if (documents.length === 0) {
      return emptyRagContext;
    }

    const reranked = query.rerank !== false && this.reranker
      ? await this.reranker.rerank(query.query, documents, topK)
      : documents.slice(0, topK);
    const compressed = this.contextCompressor
      ? await this.contextCompressor.compress(query.query, reranked)
      : reranked;

    if (compressed.length === 0) {
      return emptyRagContext;
    }

    const context = this.contextBuilder(compressed, this.maxContextTokens);

    return {
      context,
      documents: compressed,
      totalTokens: this.tokenEstimator.estimate(context)
    };
  }
}

export class RetrievalEvalRunner {
  private readonly pipeline: RagPipeline;

  constructor(options: RetrievalEvalRunnerOptions) {
    this.pipeline = options.pipeline;
  }

  async runCase(testCase: RetrievalEvalCase): Promise<RetrievalEvalResult> {
    const context = await this.pipeline.retrieve({
      filters: testCase.filters,
      query: testCase.query,
      topK: testCase.topK
    });
    const retrievedDocumentIds = context.documents.map((document) => document.id);
    const expectedDocumentIds = [...new Set(testCase.expectedDocumentIds ?? [])];
    const requiredSources = [...new Set(testCase.requiredSources ?? [])];
    const retrievedIdSet = new Set(retrievedDocumentIds);
    const sourceSet = new Set(context.documents.flatMap((document) => document.source ? [document.source] : []));
    const missingDocumentIds = expectedDocumentIds.filter((id) => !retrievedIdSet.has(id));
    const missingSources = requiredSources.filter((source) => !sourceSet.has(source));
    const recall = expectedDocumentIds.length === 0
      ? 1
      : (expectedDocumentIds.length - missingDocumentIds.length) / expectedDocumentIds.length;
    const reasons: string[] = [];

    if (missingDocumentIds.length > 0) {
      reasons.push(`Missing expected documents: ${missingDocumentIds.join(", ")}`);
    }

    if (missingSources.length > 0) {
      reasons.push(`Missing required sources: ${missingSources.join(", ")}`);
    }

    if (testCase.maxTotalTokens !== undefined && context.totalTokens > testCase.maxTotalTokens) {
      reasons.push(`Context token budget exceeded: ${context.totalTokens} > ${testCase.maxTotalTokens}`);
    }

    return {
      caseId: testCase.id,
      missingDocumentIds,
      missingSources,
      passed: reasons.length === 0,
      reasons,
      recall,
      retrievedDocumentIds,
      totalTokens: context.totalTokens
    };
  }

  async runSuite(cases: readonly RetrievalEvalCase[]): Promise<readonly RetrievalEvalResult[]> {
    const results: RetrievalEvalResult[] = [];

    for (const testCase of cases) {
      results.push(await this.runCase(testCase));
    }

    return results;
  }
}

export function rrfFuse(
  vectorResults: readonly (readonly [string, number])[],
  bm25Results: readonly (readonly [string, number])[],
  options: {
    readonly bm25Weight?: number;
    readonly k?: number;
    readonly vectorWeight?: number;
  } = {}
): readonly (readonly [string, number])[] {
  const scores = new Map<string, number>();
  accumulateRrf(scores, vectorResults, options.vectorWeight ?? 0.5, options.k ?? 60);
  accumulateRrf(scores, bm25Results, options.bm25Weight ?? 0.5, options.k ?? 60);
  return [...scores.entries()].sort((left, right) => right[1] - left[1]);
}

export function chunkId(documentId: string, index: number): string {
  return `${documentId}::chunk-${index}`;
}

export function tokenize(text: string): readonly string[] {
  const normalized = text.toLowerCase();
  const words = normalized.split(/[^a-z0-9가-힣]+/u).filter((word) => word.length >= minTokenLength);
  const extra: string[] = [];

  for (const word of words) {
    for (const run of word.matchAll(/[가-힣]{2,}/gu)) {
      const value = run[0];

      for (let start = 0; start < value.length; start += 1) {
        for (let length = minTokenLength; length <= Math.min(maxKoreanNgramLength, value.length - start); length += 1) {
          const token = value.slice(start, start + length);

          if (token !== word) {
            extra.push(token);
          }
        }
      }
    }
  }

  return [...words, ...extra];
}

function countTerms(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return counts;
}

function overlapScore(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let matches = 0;

  for (const token of left) {
    if (right.has(token)) {
      matches += 1;
    }
  }

  return matches / left.size;
}

function splitSentences(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function shouldExpandWithConversationContext(query: string): boolean {
  const normalized = query.toLowerCase();

  if (/\b(it|that|this|those|them|they|he|she|what about|how about|follow up|same|previous|above)\b/u.test(normalized)) {
    return true;
  }

  if (/(그것|그건|이건|저건|이전|위의|같은|그러면|그럼|어떻게|뭐가|어떤가)/u.test(query)) {
    return true;
  }

  return tokenize(query).length <= 6;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd();
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }

  return unique;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function accumulateRrf(
  scores: Map<string, number>,
  results: readonly (readonly [string, number])[],
  weight: number,
  k: number
): void {
  results.forEach(([documentId], rank) => {
    scores.set(documentId, (scores.get(documentId) ?? 0) + weight / (k + rank + 1));
  });
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  }

  for (const value of left) {
    leftNorm += value * value;
  }

  for (const value of right) {
    rightNorm += value * value;
  }

  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? 0 : dot / denominator;
}

function matchesMetadataFilters(metadata: JsonObject, filters: JsonObject): boolean {
  if (Object.keys(filters).length === 0) {
    return true;
  }

  return Object.entries(filters).every(([key, expected]) => String(metadata[key]) === String(expected));
}

function defaultRagRetrievalRoute(queries: readonly string[]): "lexical" | "hybrid" {
  const text = queries.join(" ").toLowerCase();

  if (/\b(compare|versus|vs\.?|tradeoff|similar|semantic|related|decide)\b/u.test(text)) {
    return "hybrid";
  }

  if (/(비교|대비|유사|의미|관련|결정|선택)/u.test(text)) {
    return "hybrid";
  }

  return tokenize(text).length > 8 ? "hybrid" : "lexical";
}


const sentenceEnds = new Set([".", "!", "?", "。", "！", "？"]);
