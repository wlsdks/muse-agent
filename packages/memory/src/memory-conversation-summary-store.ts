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
import type { Insertable, Kysely, Selectable } from "kysely";
import type {
  ConversationSummary,
  ConversationSummaryListOptions,
  ConversationSummaryStore,
  FactCategory,
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
  readonly userId?: string;
}

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1_000;

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

  listAll(options: ConversationSummaryListOptions = {}): readonly ConversationSummary[] {
    const limit = clampListLimit(options.limit);
    const all = [...this.summaries.values()];
    const filtered = options.userId
      ? all.filter((entry) => entry.userId === options.userId)
      : all;
    return filtered
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
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

  async listAll(options: ConversationSummaryListOptions = {}): Promise<readonly ConversationSummary[]> {
    const limit = clampListLimit(options.limit);
    let query = this.db
      .selectFrom("conversation_summaries")
      .selectAll()
      .orderBy("updated_at", "desc")
      .limit(limit);
    if (options.userId) {
      query = query.where("user_id", "=", options.userId);
    }
    const rows = await query.execute();
    return rows.map(mapConversationSummaryRow);
  }
}

function clampListLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(raw)));
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
