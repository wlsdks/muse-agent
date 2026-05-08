/**
 * RAG persistence kernel extracted from packages/rag/src/index.ts.
 *
 * Owns the in-memory + Kysely-backed implementations of the three
 * RAG stores (RagDocumentStore, RagIngestionPolicyStore,
 * RagIngestionCandidateStore), the row builders / mappers, and the
 * `normalizeRagDocument` / `normalizeRagIngestionPolicy` /
 * `normalizeRagIngestionCandidate` private coercers + their tiny
 * shared helpers.
 *
 * Re-exported from the rag barrel for backwards compatibility.
 */

import type {
  MuseDatabase,
  RagDocumentTable,
  RagIngestionCandidateTable,
  RagIngestionPolicyTable
} from "@muse/db";
import { createRunId, type JsonObject, type JsonValue } from "@muse/shared";
import { sql, type Insertable, type Kysely, type Selectable } from "kysely";
import { createHash } from "node:crypto";
import type {
  RagDocumentInput,
  RagDocumentStore,
  RagIngestionCandidate,
  RagIngestionCandidateStatus,
  RagIngestionCandidateStore,
  RagIngestionPolicy,
  RagIngestionPolicyStore,
  StoredRagDocument,
  StoredRagIngestionCandidate
} from "./index.js";

const ragPolicyDefaultId = "default";
const maxInMemoryRagCandidates = 20_000;

type RagIngestionPolicyRow = Selectable<RagIngestionPolicyTable>;
type RagIngestionPolicyInsert = Insertable<RagIngestionPolicyTable>;
type RagIngestionCandidateRow = Selectable<RagIngestionCandidateTable>;
type RagIngestionCandidateInsert = Insertable<RagIngestionCandidateTable>;
type RagDocumentRow = Selectable<RagDocumentTable>;
type RagDocumentInsert = Insertable<RagDocumentTable>;
type RagInestionCandidateRowAlias = RagIngestionCandidateRow | RagIngestionCandidateInsert;

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
