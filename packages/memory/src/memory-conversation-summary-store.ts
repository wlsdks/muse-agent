/**
 * Conversation-summary persistence primitives extracted from
 * packages/memory/src/index.ts.
 *
 * Owns `InMemoryConversationSummaryStore` (in-process map keyed by
 * `sessionId` with normalize-on-save) and
 * `KyselyConversationSummaryStore` (Postgres `INSERT … ON CONFLICT
 * (session_id) DO UPDATE` upsert via `buildConversationSummaryUpsertQuery`).
 * Plus the row-builder + row-mapper (`createConversationSummaryInsert`,
 * `mapConversationSummaryRow`), the structured-fact serializer pair
 * (`serializeStructuredFact` / `deserializeStructuredFact`), and the
 * private normalize coercers (`normalizeConversationSummary`,
 * `normalizeStructuredFact`) + small helpers.
 *
 * Re-exported from the memory barrel for backwards compatibility.
 */

import type { ConversationSummaryTable, MuseDatabase } from "@muse/db";
import { sql, type Insertable, type Kysely, type Selectable } from "kysely";
import type {
  ConversationSummary,
  ConversationSummaryStore,
  FactCategory,
  FindSimilarOptions,
  SimilarConversationSummary,
  StructuredFact
} from "./index.js";

type ConversationSummaryRow = Selectable<ConversationSummaryTable>;
type ConversationSummaryInsert = Insertable<ConversationSummaryTable>;

interface RequiredStructuredFact {
  readonly key: string;
  readonly value: string;
  readonly category: FactCategory;
  readonly extractedAt: Date;
}

interface RequiredConversationSummary {
  readonly sessionId: string;
  readonly narrative: string;
  readonly facts: readonly RequiredStructuredFact[];
  readonly summarizedUpToIndex: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly embedding?: readonly number[];
  readonly userId?: string;
}

type SerializedStructuredFact = Readonly<Record<string, string>>;

export class InMemoryConversationSummaryStore implements ConversationSummaryStore {
  private readonly summaries = new Map<string, RequiredConversationSummary>();
  private readonly now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  get(sessionId: string): ConversationSummary | undefined {
    return this.summaries.get(sessionId);
  }

  save(summary: ConversationSummary): ConversationSummary {
    const existing = this.summaries.get(summary.sessionId);
    const now = this.now();
    const normalized = normalizeConversationSummary(summary, {
      createdAt: existing?.createdAt ?? summary.createdAt ?? now,
      updatedAt: summary.updatedAt ?? now
    });

    this.summaries.set(normalized.sessionId, normalized);
    return normalized;
  }

  delete(sessionId: string): boolean {
    return this.summaries.delete(sessionId);
  }

  findSimilar(
    embedding: readonly number[],
    options: FindSimilarOptions = {}
  ): readonly SimilarConversationSummary[] {
    if (embedding.length === 0) {
      return [];
    }
    const topK = Math.max(1, options.topK ?? 3);
    const minScore = Math.max(0, options.minScore ?? 0);
    const scored: SimilarConversationSummary[] = [];
    for (const summary of this.summaries.values()) {
      if (options.userId && summary.userId !== options.userId) {
        continue;
      }
      if (!summary.embedding || summary.embedding.length !== embedding.length) {
        continue;
      }
      const similarity = cosineSimilarityVector(embedding, summary.embedding);
      if (similarity < minScore) {
        continue;
      }
      scored.push({ similarity, summary });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }
}

export class KyselyConversationSummaryStore implements ConversationSummaryStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: { readonly now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async get(sessionId: string): Promise<ConversationSummary | undefined> {
    const row = await this.db
      .selectFrom("conversation_summaries")
      .selectAll()
      .where("session_id", "=", sessionId)
      .executeTakeFirst();

    return row ? mapConversationSummaryRow(row) : undefined;
  }

  async save(summary: ConversationSummary): Promise<ConversationSummary> {
    const row = await buildConversationSummaryUpsertQuery(this.db, summary, { now: this.now })
      .executeTakeFirstOrThrow();

    return mapConversationSummaryRow(row);
  }

  async delete(sessionId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("conversation_summaries")
      .where("session_id", "=", sessionId)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0) > 0;
  }

  async findSimilar(
    embedding: readonly number[],
    options: FindSimilarOptions = {}
  ): Promise<readonly SimilarConversationSummary[]> {
    if (embedding.length === 0) {
      return [];
    }
    const topK = Math.max(1, options.topK ?? 3);
    const minScore = Math.max(0, options.minScore ?? 0);
    const vectorLiteral = formatVectorLiteral(embedding);
    // pgvector `<=>` is cosine *distance* (0 = identical, 2 = opposite).
    // Convert to similarity via `1 - distance` and apply min-score in JS
    // so the query stays readable.
    const rows = await this.db
      .selectFrom("conversation_summaries")
      .selectAll()
      .select(sql<number>`1 - (embedding <=> ${vectorLiteral}::vector)`.as("similarity"))
      .where("embedding", "is not", null)
      .$if(Boolean(options.userId), (qb) => qb.where("user_id", "=", options.userId ?? null))
      .orderBy(sql`embedding <=> ${vectorLiteral}::vector`)
      .limit(topK)
      .execute();

    return rows
      .map((row) => {
        const { similarity, ...rest } = row as typeof row & { similarity: number };
        return {
          similarity: Number(similarity ?? 0),
          summary: mapConversationSummaryRow(rest as ConversationSummaryRow)
        };
      })
      .filter((entry) => entry.similarity >= minScore);
  }
}

export function buildConversationSummaryUpsertQuery(
  db: Kysely<MuseDatabase>,
  summary: ConversationSummary,
  options: { readonly now: () => Date }
) {
  const row = createConversationSummaryInsert(summary, options);

  return db
    .insertInto("conversation_summaries")
    .values(row)
    .onConflict((oc) => oc.column("session_id").doUpdateSet({
      embedding: row.embedding ?? null,
      facts_json: row.facts_json,
      narrative: row.narrative,
      summarized_up_to: row.summarized_up_to,
      updated_at: row.updated_at,
      user_id: row.user_id ?? null
    }))
    .returningAll();
}

export function createConversationSummaryInsert(
  summary: ConversationSummary,
  options: { readonly now: () => Date }
): ConversationSummaryInsert {
  const now = options.now();
  const normalized = normalizeConversationSummary(summary, {
    createdAt: summary.createdAt ?? now,
    updatedAt: summary.updatedAt ?? now
  });

  return {
    created_at: normalized.createdAt,
    embedding: normalized.embedding ? formatVectorLiteral(normalized.embedding) : null,
    facts_json: normalized.facts.map(serializeStructuredFact),
    narrative: normalized.narrative,
    session_id: normalized.sessionId,
    summarized_up_to: normalized.summarizedUpToIndex,
    updated_at: normalized.updatedAt,
    user_id: normalized.userId ?? null
  };
}

export function mapConversationSummaryRow(row: ConversationSummaryRow): ConversationSummary {
  return {
    createdAt: dateValue(row.created_at),
    embedding: parseVectorLiteral(row.embedding),
    facts: jsonArray<SerializedStructuredFact>(row.facts_json).map(deserializeStructuredFact),
    narrative: row.narrative,
    sessionId: row.session_id,
    summarizedUpToIndex: row.summarized_up_to,
    updatedAt: dateValue(row.updated_at),
    userId: typeof row.user_id === "string" ? row.user_id : undefined
  };
}

function normalizeConversationSummary(
  summary: ConversationSummary,
  options: { readonly createdAt: Date; readonly updatedAt: Date }
): RequiredConversationSummary {
  return {
    createdAt: options.createdAt,
    embedding: summary.embedding && summary.embedding.length > 0 ? [...summary.embedding] : undefined,
    facts: (summary.facts ?? []).map(normalizeStructuredFact),
    narrative: summary.narrative.trim(),
    sessionId: summary.sessionId,
    summarizedUpToIndex: Math.max(0, Math.trunc(summary.summarizedUpToIndex)),
    updatedAt: options.updatedAt,
    userId: summary.userId && summary.userId.trim().length > 0 ? summary.userId.trim() : undefined
  };
}

function normalizeStructuredFact(fact: StructuredFact): RequiredStructuredFact {
  return {
    category: fact.category ?? "GENERAL",
    extractedAt: fact.extractedAt ?? new Date(),
    key: fact.key.trim(),
    value: fact.value.trim()
  };
}

function serializeStructuredFact(fact: RequiredStructuredFact): SerializedStructuredFact {
  return {
    category: fact.category,
    extractedAt: fact.extractedAt.toISOString(),
    key: fact.key,
    value: fact.value
  };
}

function deserializeStructuredFact(fact: SerializedStructuredFact): RequiredStructuredFact {
  return {
    category: factCategoryValue(fact.category),
    extractedAt: dateValue(fact.extractedAt),
    key: stringValue(fact.key),
    value: stringValue(fact.value)
  };
}

function factCategoryValue(value: unknown): FactCategory {
  return value === "ENTITY" ||
    value === "DECISION" ||
    value === "CONDITION" ||
    value === "STATE" ||
    value === "NUMERIC" ||
    value === "GENERAL"
    ? value
    : "GENERAL";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function dateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(typeof value === "string" ? value : 0);
}

export function formatVectorLiteral(vector: readonly number[]): string {
  // pgvector accepts `[v1,v2,v3]` text — pin to plain JSON-numeric so
  // we don't have to worry about locale-dependent decimal separators.
  return `[${vector.map((value) => (Number.isFinite(value) ? value.toString() : "0")).join(",")}]`;
}

export function parseVectorLiteral(value: unknown): readonly number[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const trimmed = value.trim().replace(/^\[/u, "").replace(/\]$/u, "");
  if (trimmed.length === 0) {
    return [];
  }
  const parts = trimmed.split(",").map((part) => Number.parseFloat(part.trim()));
  if (parts.some((entry) => !Number.isFinite(entry))) {
    return undefined;
  }
  return parts;
}

export function cosineSimilarityVector(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function jsonArray<T>(value: unknown): readonly T[] {
  if (Array.isArray(value)) {
    return value as readonly T[];
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed as readonly T[] : [];
    } catch {
      return [];
    }
  }

  return [];
}
