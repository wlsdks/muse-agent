import { createApproximateTokenEstimator, type TokenEstimator } from "@muse/memory";
import type { MuseDatabase, RagDocumentTable, RagIngestionCandidateTable, RagIngestionPolicyTable } from "@muse/db";
import type { ModelMessage, ModelProvider, ModelRequest } from "@muse/model";
import { createRunId, type JsonObject, type JsonValue } from "@muse/shared";
import { sql, type Insertable, type Kysely, type Selectable } from "kysely";
import { createHash } from "node:crypto";

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

export interface ContextBuilder {
  build(documents: readonly RetrievedDocument[], maxTokens: number): string;
}

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
const ragPolicyDefaultId = "default";
const maxInMemoryRagCandidates = 20_000;

type RagIngestionPolicyRow = Selectable<RagIngestionPolicyTable>;
type RagIngestionPolicyInsert = Insertable<RagIngestionPolicyTable>;
type RagIngestionCandidateRow = Selectable<RagIngestionCandidateTable>;
type RagIngestionCandidateInsert = Insertable<RagIngestionCandidateTable>;
type RagDocumentRow = Selectable<RagDocumentTable>;
type RagDocumentInsert = Insertable<RagDocumentTable>;

export class InMemoryRagDocumentStore implements RagDocumentStore {
  private readonly byId = new Map<string, StoredRagDocument>();
  private readonly orderedIds: string[] = [];
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: { readonly idFactory?: () => string; readonly now?: () => Date } = {}) {
    this.idFactory = options.idFactory ?? (() => createRunId("document"));
    this.now = options.now ?? (() => new Date());
  }

  save(document: RagDocumentInput): StoredRagDocument {
    const existing = document.id ? this.byId.get(document.id) : undefined;
    const now = this.now();
    const saved = normalizeRagDocument(document, {
      createdAt: existing?.createdAt,
      idFactory: this.idFactory,
      now: () => now
    });

    this.byId.set(saved.id, saved);

    if (!existing) {
      this.orderedIds.unshift(saved.id);
    }

    return saved;
  }

  findById(id: string): StoredRagDocument | undefined {
    return this.byId.get(id);
  }

  findByContentHash(contentHash: string): StoredRagDocument | undefined {
    return [...this.byId.values()].find((document) => document.contentHash === contentHash);
  }

  list(options: { readonly limit?: number } = {}): readonly StoredRagDocument[] {
    return this.orderedIds
      .map((id) => this.byId.get(id))
      .filter((document): document is StoredRagDocument => Boolean(document))
      .slice(0, clampDocumentLimit(options.limit ?? 100));
  }

  search(query: string, options: { readonly limit?: number } = {}): readonly StoredRagDocument[] {
    const normalized = query.toLowerCase();
    return this.list({ limit: Number.MAX_SAFE_INTEGER })
      .filter((document) => JSON.stringify(toRagDocumentJson(document)).toLowerCase().includes(normalized))
      .slice(0, clampDocumentLimit(options.limit ?? 5));
  }

  delete(id: string): boolean {
    const existed = this.byId.delete(id);

    if (existed) {
      const index = this.orderedIds.indexOf(id);

      if (index >= 0) {
        this.orderedIds.splice(index, 1);
      }
    }

    return existed;
  }

  deleteMany(ids: readonly string[]): number {
    let deleted = 0;

    for (const id of ids) {
      deleted += this.delete(id) ? 1 : 0;
    }

    return deleted;
  }

  count(): number {
    return this.byId.size;
  }
}

export class KyselyRagDocumentStore implements RagDocumentStore {
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: { readonly idFactory?: () => string; readonly now?: () => Date } = {}
  ) {
    this.idFactory = options.idFactory ?? (() => createRunId("document"));
    this.now = options.now ?? (() => new Date());
  }

  async save(document: RagDocumentInput): Promise<StoredRagDocument> {
    const existing = document.id ? await this.findById(document.id) : undefined;
    const insert = createRagDocumentInsert(document, {
      createdAt: existing?.createdAt,
      idFactory: this.idFactory,
      now: this.now
    });
    const row = await this.db
      .insertInto("rag_documents")
      .values(insert)
      .onConflict((oc) => oc.column("id").doUpdateSet({
        chunk_count: insert.chunk_count,
        chunk_ids: insert.chunk_ids,
        content: insert.content,
        content_hash: insert.content_hash,
        indexed: insert.indexed,
        metadata: insert.metadata,
        source: insert.source,
        updated_at: insert.updated_at
      }))
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapRagDocumentRow(row);
  }

  async findById(id: string): Promise<StoredRagDocument | undefined> {
    const row = await this.db
      .selectFrom("rag_documents")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? mapRagDocumentRow(row) : undefined;
  }

  async findByContentHash(contentHash: string): Promise<StoredRagDocument | undefined> {
    const row = await this.db
      .selectFrom("rag_documents")
      .selectAll()
      .where("content_hash", "=", contentHash)
      .executeTakeFirst();

    return row ? mapRagDocumentRow(row) : undefined;
  }

  async list(options: { readonly limit?: number } = {}): Promise<readonly StoredRagDocument[]> {
    const rows = await this.db
      .selectFrom("rag_documents")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(clampDocumentLimit(options.limit ?? 100))
      .execute();

    return rows.map(mapRagDocumentRow);
  }

  async search(query: string, options: { readonly limit?: number } = {}): Promise<readonly StoredRagDocument[]> {
    const needle = `%${query.toLowerCase()}%`;
    const rows = await this.db
      .selectFrom("rag_documents")
      .selectAll()
      .where((expression) => expression.or([
        expression("content", "ilike", needle),
        expression(sql<string>`metadata::text`, "ilike", needle)
      ]))
      .orderBy("created_at", "desc")
      .limit(clampDocumentLimit(options.limit ?? 5))
      .execute();

    return rows.map(mapRagDocumentRow);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("rag_documents")
      .where("id", "=", id)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0) > 0;
  }

  async deleteMany(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const result = await this.db
      .deleteFrom("rag_documents")
      .where("id", "in", [...ids])
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0);
  }

  async count(): Promise<number> {
    const row = await this.db
      .selectFrom("rag_documents")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .executeTakeFirst();

    return Number(row?.count ?? 0);
  }
}

export function createRagDocumentInsert(
  document: RagDocumentInput,
  options: { readonly createdAt?: Date; readonly idFactory: () => string; readonly now: () => Date }
): RagDocumentInsert {
  const normalized = normalizeRagDocument(document, options);

  return {
    chunk_count: normalized.chunkCount,
    chunk_ids: [...normalized.chunkIds],
    content: normalized.content,
    content_hash: normalized.contentHash,
    created_at: normalized.createdAt,
    id: normalized.id,
    indexed: normalized.indexed,
    metadata: normalized.metadata,
    source: normalized.source ?? null,
    updated_at: normalized.updatedAt
  };
}

export function mapRagDocumentRow(row: RagDocumentRow | RagDocumentInsert): StoredRagDocument {
  return {
    chunkCount: Number(row.chunk_count ?? 1),
    chunkIds: jsonStringArray(row.chunk_ids ?? []),
    content: row.content ?? "",
    contentHash: row.content_hash ?? "",
    createdAt: dateValue(row.created_at ?? null),
    id: row.id ?? "",
    indexed: row.indexed ?? true,
    metadata: jsonObjectValue(row.metadata ?? {}),
    source: row.source ?? undefined,
    updatedAt: dateValue(row.updated_at ?? null)
  };
}

export class InMemoryRagIngestionPolicyStore implements RagIngestionPolicyStore {
  private policy?: RagIngestionPolicy;
  private readonly now: () => Date;

  constructor(options: { readonly initial?: RagIngestionPolicy; readonly now?: () => Date } = {}) {
    this.policy = options.initial;
    this.now = options.now ?? (() => new Date());
  }

  getOrNull(): RagIngestionPolicy | undefined {
    return this.policy;
  }

  save(policy: RagIngestionPolicy): RagIngestionPolicy {
    const now = this.now();
    const saved = normalizeRagIngestionPolicy(policy, {
      createdAt: this.policy?.createdAt ?? policy.createdAt ?? now,
      updatedAt: policy.updatedAt ?? now
    });

    this.policy = saved;
    return saved;
  }

  delete(): boolean {
    const existed = this.policy !== undefined;
    this.policy = undefined;
    return existed;
  }
}

export class KyselyRagIngestionPolicyStore implements RagIngestionPolicyStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: { readonly now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async getOrNull(): Promise<RagIngestionPolicy | undefined> {
    const row = await this.db
      .selectFrom("rag_ingestion_policy")
      .selectAll()
      .where("id", "=", ragPolicyDefaultId)
      .executeTakeFirst();

    return row ? mapRagIngestionPolicyRow(row) : undefined;
  }

  async save(policy: RagIngestionPolicy): Promise<RagIngestionPolicy> {
    const existing = await this.getOrNull();
    const row = await buildRagIngestionPolicyUpsertQuery(this.db, policy, {
      createdAt: existing?.createdAt,
      now: this.now
    }).executeTakeFirstOrThrow();

    return mapRagIngestionPolicyRow(row);
  }

  async delete(): Promise<boolean> {
    const result = await this.db
      .deleteFrom("rag_ingestion_policy")
      .where("id", "=", ragPolicyDefaultId)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0) > 0;
  }
}

export class InMemoryRagIngestionCandidateStore implements RagIngestionCandidateStore {
  private readonly byId = new Map<string, StoredRagIngestionCandidate>();
  private readonly byRunId = new Map<string, string>();
  private readonly orderedIds: string[] = [];
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: { readonly idFactory?: () => string; readonly now?: () => Date } = {}) {
    this.idFactory = options.idFactory ?? (() => createRunId("rag_candidate"));
    this.now = options.now ?? (() => new Date());
  }

  save(candidate: RagIngestionCandidate): StoredRagIngestionCandidate {
    const existingId = this.byRunId.get(candidate.runId);
    const existing = existingId ? this.byId.get(existingId) : undefined;

    if (existing) {
      return existing;
    }

    const saved = normalizeRagIngestionCandidate(candidate, {
      idFactory: this.idFactory,
      now: this.now
    });
    this.byId.set(saved.id, saved);
    this.byRunId.set(saved.runId, saved.id);
    this.orderedIds.unshift(saved.id);
    this.evictOldest();
    return saved;
  }

  findById(id: string): StoredRagIngestionCandidate | undefined {
    return this.byId.get(id);
  }

  findByRunId(runId: string): StoredRagIngestionCandidate | undefined {
    const id = this.byRunId.get(runId);
    return id ? this.byId.get(id) : undefined;
  }

  list(options: {
    readonly limit?: number;
    readonly status?: RagIngestionCandidateStatus;
    readonly channel?: string;
  } = {}): readonly StoredRagIngestionCandidate[] {
    const channel = normalizeOptionalLowercase(options.channel);
    const limit = clampRagCandidateLimit(options.limit ?? 100);

    return this.orderedIds
      .map((id) => this.byId.get(id))
      .filter((candidate): candidate is StoredRagIngestionCandidate => Boolean(candidate))
      .filter((candidate) => !options.status || candidate.status === options.status)
      .filter((candidate) => !channel || candidate.channel?.toLowerCase() === channel)
      .slice(0, limit);
  }

  updateReview(input: {
    readonly id: string;
    readonly status: Exclude<RagIngestionCandidateStatus, "PENDING">;
    readonly reviewedBy: string;
    readonly reviewComment?: string | null;
    readonly ingestedDocumentId?: string | null;
  }): StoredRagIngestionCandidate | undefined {
    const existing = this.byId.get(input.id);

    if (!existing) {
      return undefined;
    }

    const updated: StoredRagIngestionCandidate = {
      ...existing,
      ingestedDocumentId: input.ingestedDocumentId ?? null,
      reviewComment: input.reviewComment ?? null,
      reviewedAt: this.now(),
      reviewedBy: input.reviewedBy,
      status: input.status
    };
    this.byId.set(updated.id, updated);
    return updated;
  }

  private evictOldest(): void {
    while (this.orderedIds.length > maxInMemoryRagCandidates) {
      const old = this.orderedIds.pop();
      const removed = old ? this.byId.get(old) : undefined;

      if (old) {
        this.byId.delete(old);
      }

      if (removed) {
        this.byRunId.delete(removed.runId);
      }
    }
  }
}

export class KyselyRagIngestionCandidateStore implements RagIngestionCandidateStore {
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: { readonly idFactory?: () => string; readonly now?: () => Date } = {}
  ) {
    this.idFactory = options.idFactory ?? (() => createRunId("rag_candidate"));
    this.now = options.now ?? (() => new Date());
  }

  async save(candidate: RagIngestionCandidate): Promise<StoredRagIngestionCandidate> {
    const existing = await this.findByRunId(candidate.runId);

    if (existing) {
      return existing;
    }

    const row = await this.db
      .insertInto("rag_ingestion_candidates")
      .values(createRagIngestionCandidateInsert(candidate, {
        idFactory: this.idFactory,
        now: this.now
      }))
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapRagIngestionCandidateRow(row);
  }

  async findById(id: string): Promise<StoredRagIngestionCandidate | undefined> {
    const row = await this.db
      .selectFrom("rag_ingestion_candidates")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? mapRagIngestionCandidateRow(row) : undefined;
  }

  async findByRunId(runId: string): Promise<StoredRagIngestionCandidate | undefined> {
    const row = await this.db
      .selectFrom("rag_ingestion_candidates")
      .selectAll()
      .where("run_id", "=", runId)
      .executeTakeFirst();

    return row ? mapRagIngestionCandidateRow(row) : undefined;
  }

  async list(options: {
    readonly limit?: number;
    readonly status?: RagIngestionCandidateStatus;
    readonly channel?: string;
  } = {}): Promise<readonly StoredRagIngestionCandidate[]> {
    const channel = normalizeOptionalLowercase(options.channel);
    const query = this.db
      .selectFrom("rag_ingestion_candidates")
      .selectAll()
      .$if(Boolean(options.status), (builder) => builder.where("status", "=", options.status as RagIngestionCandidateStatus))
      .$if(Boolean(channel), (builder) => builder.where("channel", "=", channel ?? ""))
      .orderBy("captured_at", "desc")
      .limit(clampRagCandidateLimit(options.limit ?? 100));

    const rows = await query.execute();
    return rows.map(mapRagIngestionCandidateRow);
  }

  async updateReview(input: {
    readonly id: string;
    readonly status: Exclude<RagIngestionCandidateStatus, "PENDING">;
    readonly reviewedBy: string;
    readonly reviewComment?: string | null;
    readonly ingestedDocumentId?: string | null;
  }): Promise<StoredRagIngestionCandidate | undefined> {
    const row = await this.db
      .updateTable("rag_ingestion_candidates")
      .set({
        ingested_document_id: input.ingestedDocumentId ?? null,
        review_comment: input.reviewComment ?? null,
        reviewed_at: this.now(),
        reviewed_by: input.reviewedBy,
        status: input.status
      })
      .where("id", "=", input.id)
      .returningAll()
      .executeTakeFirst();

    return row ? mapRagIngestionCandidateRow(row) : undefined;
  }
}

export function buildRagIngestionPolicyUpsertQuery(
  db: Kysely<MuseDatabase>,
  policy: RagIngestionPolicy,
  options: { readonly createdAt?: Date; readonly now: () => Date }
) {
  const row = createRagIngestionPolicyInsert(policy, options);

  return db
    .insertInto("rag_ingestion_policy")
    .values(row)
    .onConflict((oc) => oc.column("id").doUpdateSet({
      allowed_channels: row.allowed_channels,
      blocked_patterns: row.blocked_patterns,
      enabled: row.enabled,
      min_query_chars: row.min_query_chars,
      min_response_chars: row.min_response_chars,
      require_review: row.require_review,
      updated_at: row.updated_at
    }))
    .returningAll();
}

export function createRagIngestionPolicyInsert(
  policy: RagIngestionPolicy,
  options: { readonly createdAt?: Date; readonly now: () => Date }
): RagIngestionPolicyInsert {
  const now = options.now();
  const normalized = normalizeRagIngestionPolicy(policy, {
    createdAt: options.createdAt ?? policy.createdAt ?? now,
    updatedAt: policy.updatedAt ?? now
  });

  return {
    allowed_channels: [...normalized.allowedChannels],
    blocked_patterns: [...normalized.blockedPatterns],
    created_at: normalized.createdAt,
    enabled: normalized.enabled,
    id: ragPolicyDefaultId,
    min_query_chars: normalized.minQueryChars,
    min_response_chars: normalized.minResponseChars,
    require_review: normalized.requireReview,
    updated_at: normalized.updatedAt
  };
}

export function createRagIngestionCandidateInsert(
  candidate: RagIngestionCandidate,
  options: { readonly idFactory: () => string; readonly now: () => Date }
): RagIngestionCandidateInsert {
  const normalized = normalizeRagIngestionCandidate(candidate, options);

  return {
    captured_at: normalized.capturedAt,
    channel: normalized.channel,
    id: normalized.id,
    ingested_document_id: normalized.ingestedDocumentId,
    query: normalized.query,
    response: normalized.response,
    review_comment: normalized.reviewComment,
    reviewed_at: normalized.reviewedAt,
    reviewed_by: normalized.reviewedBy,
    run_id: normalized.runId,
    session_id: normalized.sessionId,
    status: normalized.status,
    user_id: normalized.userId
  };
}

export function mapRagIngestionPolicyRow(row: RagIngestionPolicyRow): RagIngestionPolicy {
  return {
    allowedChannels: jsonStringArray(row.allowed_channels).map((channel) => channel.toLowerCase()),
    blockedPatterns: jsonStringArray(row.blocked_patterns),
    createdAt: dateValue(row.created_at),
    enabled: row.enabled,
    minQueryChars: row.min_query_chars,
    minResponseChars: row.min_response_chars,
    requireReview: row.require_review,
    updatedAt: dateValue(row.updated_at)
  };
}

export function mapRagIngestionCandidateRow(row: RagInestionCandidateRowAlias): StoredRagIngestionCandidate {
  return {
    capturedAt: dateValue(row.captured_at ?? null),
    channel: row.channel ?? null,
    id: row.id ?? "",
    ingestedDocumentId: row.ingested_document_id ?? null,
    query: row.query ?? "",
    response: row.response ?? "",
    reviewComment: row.review_comment ?? null,
    reviewedAt: row.reviewed_at ? dateValue(row.reviewed_at) : null,
    reviewedBy: row.reviewed_by ?? null,
    runId: row.run_id ?? "",
    sessionId: row.session_id ?? null,
    status: candidateStatusValue(row.status),
    userId: row.user_id ?? ""
  };
}

type RagInestionCandidateRowAlias = RagIngestionCandidateRow | RagIngestionCandidateInsert;

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

export class SimpleContextBuilder implements ContextBuilder {
  constructor(private readonly separator = "\n\n---\n\n") {}

  build(documents: readonly RetrievedDocument[], maxTokens: number): string {
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

    return sections.join(this.separator);
  }
}

export class StructuredContextBuilder implements ContextBuilder {
  build(documents: readonly RetrievedDocument[], maxTokens: number): string {
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
  }
}

export class PassthroughQueryTransformer implements QueryTransformer {
  transform(query: string): readonly string[] {
    return [query];
  }
}

export class ConversationAwareQueryTransformer implements QueryTransformer {
  private readonly history: readonly ConversationAwareQueryTurn[];
  private readonly includeOriginal: boolean;
  private readonly maxHistoryTurns: number;
  private readonly maxQueries: number;
  private readonly maxContextChars: number;

  constructor(options: ConversationAwareQueryTransformerOptions = {}) {
    this.history = options.history ?? [];
    this.includeOriginal = options.includeOriginal ?? true;
    this.maxHistoryTurns = Math.max(1, options.maxHistoryTurns ?? 3);
    this.maxQueries = Math.max(1, options.maxQueries ?? 3);
    this.maxContextChars = Math.max(80, options.maxContextChars ?? 800);
  }

  transform(query: string): readonly string[] {
    const trimmed = query.trim();

    if (trimmed.length === 0) {
      return [];
    }

    const queries = this.includeOriginal ? [trimmed] : [];
    const recentContext = this.recentUserContext(trimmed);

    if (recentContext && shouldExpandWithConversationContext(trimmed)) {
      queries.push(`${recentContext} ${trimmed}`);
    }

    if (queries.length === 0) {
      queries.push(trimmed);
    }

    return uniqueStrings(queries).slice(0, this.maxQueries);
  }

  private recentUserContext(query: string): string | undefined {
    const turns = this.history
      .filter((turn) => turn.role === "user")
      .map((turn) => normalizeWhitespace(turn.content))
      .filter((content) => content.length > 0 && content !== query)
      .slice(-this.maxHistoryTurns);

    if (turns.length === 0) {
      return undefined;
    }

    return truncateText(turns.join(" "), this.maxContextChars);
  }
}

export class HypotheticalDocumentQueryTransformer implements QueryTransformer {
  private readonly includeOriginal: boolean;
  private readonly generate: (query: string) => Awaitable<string>;

  constructor(options: HypotheticalDocumentQueryTransformerOptions) {
    this.generate = options.generate;
    this.includeOriginal = options.includeOriginal ?? true;
  }

  async transform(query: string): Promise<readonly string[]> {
    const trimmed = query.trim();

    if (trimmed.length === 0) {
      return [];
    }

    const hypothetical = (await this.generate(trimmed)).trim();
    const queries = this.includeOriginal ? [trimmed] : [];

    if (hypothetical.length > 0 && hypothetical !== trimmed) {
      queries.push(hypothetical);
    }

    return queries;
  }
}

export class DecomposingQueryTransformer implements QueryTransformer {
  private readonly includeOriginal: boolean;
  private readonly maxQueries: number;

  constructor(options: DecomposingQueryTransformerOptions = {}) {
    this.includeOriginal = options.includeOriginal ?? true;
    this.maxQueries = Math.max(1, options.maxQueries ?? 5);
  }

  transform(query: string): readonly string[] {
    const trimmed = query.trim();

    if (trimmed.length === 0) {
      return [];
    }

    const parts = trimmed
      .split(/\s+(?:and|or|then|vs\.?|versus)\s+|[?;]\s*|(?:그리고|또는|다음으로|대비|비교)\s*/iu)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const queries = this.includeOriginal ? [trimmed] : [];

    for (const part of parts) {
      if (!queries.includes(part)) {
        queries.push(part);
      }
      if (queries.length >= this.maxQueries) {
        break;
      }
    }

    return queries;
  }
}

export const HYDE_DEFAULT_SYSTEM_PROMPT =
  "Write a short passage (2-3 sentences) that would directly answer the following question. " +
  "Write as if you are quoting from an authoritative document. " +
  "Do not include any preamble like 'Here is...' — just write the passage itself.";

export const DECOMPOSE_DEFAULT_SYSTEM_PROMPT =
  "Break down this complex question into 2-4 simpler sub-questions that can be independently searched. " +
  "If the question is already simple, return it as-is.\n\n" +
  "Respond with one sub-question per line, no numbering or bullets.";

export interface LlmHypotheticalDocumentTransformerOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly includeOriginal?: boolean;
  readonly metadata?: JsonObject;
  readonly logger?: (message: string, error?: unknown) => void;
}

/**
 * LLM-backed HyDE (Hypothetical Document Embeddings) query transformer.
 *
 * Generates a short hypothetical answer document for the input query and
 * returns both the original query and the generated document so that vector
 * search can match against either form. Falls back to the original query on
 * provider error or empty output (fail-open) so retrieval is never blocked.
 *
 * Mirrors Reactor's `HyDEQueryTransformer` (Spring AI ChatClient) without the
 * vendor coupling — any `@muse/model` provider works.
 */
export function createLlmHypotheticalDocumentTransformer(
  options: LlmHypotheticalDocumentTransformerOptions
): QueryTransformer {
  const includeOriginal = options.includeOriginal ?? true;
  return {
    transform: async (query: string): Promise<readonly string[]> => {
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        return [];
      }
      let hypothetical = "";
      try {
        const messages: ModelMessage[] = [
          { content: options.systemPrompt ?? HYDE_DEFAULT_SYSTEM_PROMPT, role: "system" },
          { content: trimmed, role: "user" }
        ];
        const request: ModelRequest = {
          messages,
          model: options.model,
          ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
          ...(options.metadata ? { metadata: options.metadata } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {})
        };
        const response = await options.provider.generate(request);
        hypothetical = (response.output ?? "").trim();
      } catch (error) {
        options.logger?.("HyDE transformer fell back to original query", error);
      }
      const queries = includeOriginal ? [trimmed] : [];
      if (hypothetical.length > 0 && hypothetical !== trimmed) {
        queries.push(hypothetical);
      }
      return queries.length > 0 ? queries : [trimmed];
    }
  };
}

export interface LlmDecomposingQueryTransformerOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly maxQueries?: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly includeOriginal?: boolean;
  readonly metadata?: JsonObject;
  readonly logger?: (message: string, error?: unknown) => void;
}

/**
 * LLM-backed decomposition query transformer.
 *
 * Breaks a complex question into independent sub-questions and returns each
 * one alongside the original query. Each sub-question is a trimmed, non-empty
 * line from the model's response. Failing model calls fall back to the
 * original query — retrieval never blocks.
 *
 * Mirrors Reactor's `DecompositionQueryTransformer` without vendor coupling.
 */
export function createLlmDecomposingQueryTransformer(
  options: LlmDecomposingQueryTransformerOptions
): QueryTransformer {
  const includeOriginal = options.includeOriginal ?? true;
  const maxQueries = Math.max(1, options.maxQueries ?? 5);
  return {
    transform: async (query: string): Promise<readonly string[]> => {
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        return [];
      }
      let raw = "";
      try {
        const messages: ModelMessage[] = [
          { content: options.systemPrompt ?? DECOMPOSE_DEFAULT_SYSTEM_PROMPT, role: "system" },
          { content: trimmed, role: "user" }
        ];
        const request: ModelRequest = {
          messages,
          model: options.model,
          ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
          ...(options.metadata ? { metadata: options.metadata } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {})
        };
        const response = await options.provider.generate(request);
        raw = response.output ?? "";
      } catch (error) {
        options.logger?.("decomposition transformer fell back to original query", error);
      }
      const subQueries = parseDecompositionLines(raw);
      const queries: string[] = includeOriginal ? [trimmed] : [];
      for (const candidate of subQueries) {
        if (queries.length >= maxQueries) {
          break;
        }
        if (!queries.includes(candidate)) {
          queries.push(candidate);
        }
      }
      return queries.length > 0 ? queries : [trimmed];
    }
  };
}

export const LLM_CONTEXTUAL_COMPRESSOR_DEFAULT_SYSTEM_PROMPT =
  "You are a document compression assistant. " +
  "Extract only the information relevant to the user's query. " +
  "Remove all irrelevant content. " +
  "If nothing is relevant, respond with exactly \"IRRELEVANT\".";

const LLM_CONTEXTUAL_COMPRESSOR_IRRELEVANT_PATTERN = /^irrelevant[.!]?$/iu;

export interface LlmContextualCompressorOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly minContentLength?: number;
  readonly maxConcurrent?: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly metadata?: JsonObject;
  readonly logger?: (message: string, error?: unknown) => void;
}

/**
 * LLM-backed contextual compressor (RECOMP-style extractive compression).
 *
 * Mirrors Reactor's `LlmContextualCompressor` while staying provider-neutral:
 * - Documents shorter than `minContentLength` (default 200) skip the LLM call entirely.
 * - Concurrent LLM compressions are bounded by `maxConcurrent` (default 5) so a
 *   reranker that returns a large fan-out cannot saturate the model provider.
 * - When the model responds with `IRRELEVANT` (case-insensitive, optional terminal
 *   punctuation), the document is dropped from the output.
 * - Empty / blank responses preserve the original document. Provider errors also
 *   preserve the original (fail-open) so retrieval never silently loses content.
 * - The user prompt is assembled with `String + String` to avoid Reactor's template-
 *   replace double-substitution bug; the system prompt remains the only LLM directive.
 */
export function createLlmContextualCompressor(
  options: LlmContextualCompressorOptions
): ContextCompressor {
  const minContentLength = Math.max(0, options.minContentLength ?? 200);
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 5);
  const systemPrompt = options.systemPrompt ?? LLM_CONTEXTUAL_COMPRESSOR_DEFAULT_SYSTEM_PROMPT;

  async function compressOne(query: string, document: RetrievedDocument): Promise<RetrievedDocument | undefined> {
    if (document.content.length < minContentLength) {
      return document;
    }
    const userPrompt = `Query: ${query}\n\nDocument:\n${document.content}\n\nRelevant extract:`;
    let raw: string;
    try {
      const request: ModelRequest = {
        messages: [
          { content: systemPrompt, role: "system" },
          { content: userPrompt, role: "user" }
        ],
        model: options.model,
        ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {})
      };
      const response = await options.provider.generate(request);
      raw = response.output ?? "";
    } catch (error) {
      options.logger?.(`contextual compressor preserved document ${document.id} after provider error`, error);
      return document;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return document;
    }
    if (LLM_CONTEXTUAL_COMPRESSOR_IRRELEVANT_PATTERN.test(trimmed)) {
      return undefined;
    }
    return { ...document, content: trimmed };
  }

  return {
    compress: async (query: string, documents: readonly RetrievedDocument[]): Promise<readonly RetrievedDocument[]> => {
      if (documents.length === 0) {
        return [];
      }
      const results: (RetrievedDocument | undefined)[] = new Array(documents.length);
      let cursor = 0;
      async function worker(): Promise<void> {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= documents.length) {
            return;
          }
          const document = documents[index];
          if (!document) {
            continue;
          }
          results[index] = await compressOne(query, document);
        }
      }
      const lanes = Math.min(maxConcurrent, documents.length);
      await Promise.all(Array.from({ length: lanes }, () => worker()));
      return results.filter((document): document is RetrievedDocument => document !== undefined);
    }
  };
}

/** Visible for testing — splits an LLM response into trimmed, non-empty lines. */
export function parseDecompositionLines(raw: string): readonly string[] {
  return raw
    .split(/\r?\n/u)
    .map((line) => line.replace(/^[-*0-9.)\s]+/u, "").trim())
    .filter((line) => line.length > 0);
}

export class ExtractiveContextCompressor implements ContextCompressor {
  private readonly maxSentencesPerDocument: number;
  private readonly minScore: number;

  constructor(options: ExtractiveContextCompressorOptions = {}) {
    this.maxSentencesPerDocument = Math.max(1, options.maxSentencesPerDocument ?? 3);
    this.minScore = Math.max(0, options.minScore ?? 0);
  }

  compress(query: string, documents: readonly RetrievedDocument[]): readonly RetrievedDocument[] {
    const queryTokens = new Set(tokenize(query));

    return documents.flatMap((document) => {
      const selected = splitSentences(document.content)
        .map((sentence) => ({
          score: overlapScore(queryTokens, new Set(tokenize(sentence))),
          sentence
        }))
        .filter((candidate) => candidate.score >= this.minScore)
        .sort((left, right) => right.score - left.score)
        .slice(0, this.maxSentencesPerDocument)
        .map((candidate) => candidate.sentence);

      if (selected.length === 0) {
        return [];
      }

      const content = selected.join(" ");
      return [{
        ...document,
        content,
        estimatedTokens: Math.max(1, Math.ceil(document.estimatedTokens * (content.length / Math.max(1, document.content.length)))),
        metadata: {
          ...document.metadata,
          compressed: true,
          originalEstimatedTokens: document.estimatedTokens
        }
      }];
    });
  }
}

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
    this.contextBuilder = options.contextBuilder ?? new StructuredContextBuilder();
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

    const context = this.contextBuilder.build(compressed, this.maxContextTokens);

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

function normalizeRagIngestionPolicy(
  policy: RagIngestionPolicy,
  timestamps: { readonly createdAt: Date; readonly updatedAt: Date }
): Required<RagIngestionPolicy> {
  return {
    allowedChannels: normalizeStringList(policy.allowedChannels).map((channel) => channel.toLowerCase()),
    blockedPatterns: normalizeStringList(policy.blockedPatterns),
    createdAt: timestamps.createdAt,
    enabled: policy.enabled,
    minQueryChars: Math.max(1, Math.trunc(policy.minQueryChars)),
    minResponseChars: Math.max(1, Math.trunc(policy.minResponseChars)),
    requireReview: policy.requireReview,
    updatedAt: timestamps.updatedAt
  };
}

function normalizeRagIngestionCandidate(
  candidate: RagIngestionCandidate,
  options: { readonly idFactory: () => string; readonly now: () => Date }
): StoredRagIngestionCandidate {
  return {
    capturedAt: candidate.capturedAt ?? options.now(),
    channel: normalizeOptionalLowercase(candidate.channel),
    id: candidate.id ?? options.idFactory(),
    ingestedDocumentId: nullableString(candidate.ingestedDocumentId),
    query: candidate.query,
    response: candidate.response,
    reviewComment: nullableString(candidate.reviewComment),
    reviewedAt: candidate.reviewedAt ?? null,
    reviewedBy: nullableString(candidate.reviewedBy),
    runId: candidate.runId,
    sessionId: nullableString(candidate.sessionId),
    status: candidateStatusValue(candidate.status),
    userId: candidate.userId
  };
}

function normalizeRagDocument(
  document: RagDocumentInput,
  options: { readonly createdAt?: Date; readonly idFactory: () => string; readonly now: () => Date }
): StoredRagDocument {
  const now = options.now();
  const metadata = jsonObjectValue(document.metadata ?? {});
  const contentHash = document.contentHash ?? computeDocumentContentHash(document.content);

  return {
    chunkCount: Math.max(1, Math.trunc(document.chunkCount ?? 1)),
    chunkIds: normalizeStringList(document.chunkIds ?? []),
    content: document.content,
    contentHash,
    createdAt: options.createdAt ?? now,
    id: document.id ?? options.idFactory(),
    indexed: document.indexed ?? true,
    metadata: {
      ...metadata,
      content_hash: metadata.content_hash ?? contentHash
    },
    source: nullableString(document.source) ?? undefined,
    updatedAt: now
  };
}

function normalizeStringList(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeOptionalLowercase(value: string | null | undefined): string | null {
  const normalized = nullableString(value)?.toLowerCase();
  return normalized ?? null;
}

function nullableString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function candidateStatusValue(value: unknown): RagIngestionCandidateStatus {
  return value === "REJECTED" || value === "INGESTED" ? value : "PENDING";
}

function clampRagCandidateLimit(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 1), 500);
}

function clampDocumentLimit(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 1), 1000);
}

function computeDocumentContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function toRagDocumentJson(document: StoredRagDocument): JsonObject {
  return {
    chunkCount: document.chunkCount,
    chunkIds: [...document.chunkIds],
    content: document.content,
    id: document.id,
    indexed: document.indexed,
    metadata: document.metadata,
    source: document.source ?? null
  };
}

function jsonStringArray(value: JsonValue): readonly string[] {
  if (Array.isArray(value)) {
    return normalizeStringList(value.filter((entry): entry is string => typeof entry === "string"));
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as JsonValue;
      return jsonStringArray(parsed);
    } catch {
      return [];
    }
  }

  return [];
}

function jsonObjectValue(value: JsonValue): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  if (typeof value === "string") {
    try {
      return jsonObjectValue(JSON.parse(value) as JsonValue);
    } catch {
      return {};
    }
  }

  return {};
}

function dateValue(value: Date | string | null): Date {
  return value instanceof Date ? value : new Date(value ?? 0);
}

const sentenceEnds = new Set([".", "!", "?", "。", "！", "？"]);
