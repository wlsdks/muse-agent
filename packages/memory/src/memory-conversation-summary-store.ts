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

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { isRecord, withBestEffort } from "@muse/shared";
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

interface SerializedStructuredFact {
  readonly key: string;
  readonly value: string;
  readonly category: FactCategory;
  readonly extractedAt: string;
}

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

interface SerializedConversationSummary {
  readonly sessionId: string;
  readonly narrative: string;
  readonly facts: readonly SerializedStructuredFact[];
  readonly summarizedUpToIndex: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly userId?: string;
}

function serializeSummary(s: RequiredConversationSummary): SerializedConversationSummary {
  return {
    createdAt: s.createdAt.toISOString(),
    facts: s.facts.map((f) => ({ category: f.category, extractedAt: f.extractedAt.toISOString(), key: f.key, value: f.value })),
    narrative: s.narrative,
    sessionId: s.sessionId,
    summarizedUpToIndex: s.summarizedUpToIndex,
    updatedAt: s.updatedAt.toISOString(),
    ...(s.userId ? { userId: s.userId } : {})
  };
}

function deserializeSummary(r: SerializedConversationSummary): RequiredConversationSummary {
  return {
    createdAt: toRequiredDate(r.createdAt),
    facts: r.facts.map(deserializeStructuredFact),
    narrative: r.narrative,
    sessionId: r.sessionId,
    summarizedUpToIndex: r.summarizedUpToIndex,
    updatedAt: toRequiredDate(r.updatedAt),
    ...(r.userId ? { userId: r.userId } : {})
  };
}

/**
 * File-backed conversation-summary store — the CLI has no Postgres, so without
 * this it falls back to `InMemoryConversationSummaryStore`, which is empty at the
 * start of every `muse ask`/`muse chat` PROCESS. That makes the "default-on"
 * cross-session episodic recall a no-op (nothing survives between invocations)
 * AND starves the recall-hit-driven fade/promotion consolidation of fuel. This
 * persists summaries to a JSON file (mirrors `FileBeliefProvenanceStore`), so a
 * summary saved in one session is recalled in the next. Same normalize-on-save
 * semantics as the in-memory store; Dates round-trip via ISO strings.
 */
export function defaultConversationSummaryFile(): string {
  const fromEnv = process.env.MUSE_CONVERSATION_SUMMARY_FILE?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".muse", "conversation-summaries.json");
}

export class FileConversationSummaryStore implements ConversationSummaryStore {
  private readonly file: string;
  private readonly now: () => Date;
  constructor(options: { readonly file?: string; readonly now?: () => Date } = {}) {
    this.file = options.file && options.file.trim().length > 0 ? options.file : defaultConversationSummaryFile();
    this.now = options.now ?? (() => new Date());
  }

  private async readMap(): Promise<Map<string, RequiredConversationSummary>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch {
      return new Map();
    }
    const list = parseConversationSummariesPayload(raw);
    const map = new Map<string, RequiredConversationSummary>();
    for (const entry of list) {
      if (entry.sessionId.length > 0) {
        map.set(entry.sessionId, entry);
      }
    }
    return map;
  }

  private async writeMap(map: Map<string, RequiredConversationSummary>): Promise<void> {
    const payload = `${JSON.stringify({ summaries: [...map.values()].map(serializeSummary) }, null, 2)}\n`;
    const tmp = `${this.file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
    await fs.mkdir(dirname(this.file), { recursive: true });
    const handle = await fs.open(tmp, "w", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, this.file);
    await withBestEffort(fs.chmod(this.file, 0o600), undefined);
  }

  async get(sessionId: string): Promise<ConversationSummary | undefined> {
    return (await this.readMap()).get(sessionId);
  }

  async save(summary: ConversationSummary): Promise<ConversationSummary> {
    const map = await this.readMap();
    const existing = map.get(summary.sessionId);
    const now = this.now();
    const normalized = normalizeConversationSummary(summary, {
      createdAt: existing?.createdAt ?? summary.createdAt ?? now,
      updatedAt: summary.updatedAt ?? now
    });
    map.set(normalized.sessionId, normalized);
    await this.writeMap(map);
    return normalized;
  }

  async delete(sessionId: string): Promise<boolean> {
    const map = await this.readMap();
    if (!map.delete(sessionId)) return false;
    await this.writeMap(map);
    return true;
  }

  async listAll(options: ConversationSummaryListOptions = {}): Promise<readonly ConversationSummary[]> {
    const limit = clampListLimit(options.limit);
    const all = [...(await this.readMap()).values()];
    const filtered = options.userId ? all.filter((entry) => entry.userId === options.userId) : all;
    return filtered.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, limit);
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
    createdAt: toRequiredDate(row.created_at),
    facts: parseJsonArray(row.facts_json, isSerializedStructuredFact).map(deserializeStructuredFact),
    narrative: row.narrative,
    sessionId: row.session_id,
    summarizedUpToIndex: row.summarized_up_to,
    updatedAt: toRequiredDate(row.updated_at),
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
    extractedAt: toRequiredDate(fact.extractedAt),
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

function toRequiredDate(value: unknown): Date {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : new Date(0);
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : new Date(0);
  }

  return new Date(0);
}

function parseConversationSummariesPayload(raw: string): readonly RequiredConversationSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }

  const summaries = parsed["summaries"];
  if (!Array.isArray(summaries)) {
    return [];
  }

  const out: RequiredConversationSummary[] = [];
  for (const entry of summaries) {
    const parsedEntry = parseConversationSummary(entry);
    if (parsedEntry) {
      out.push(parsedEntry);
    }
  }

  return out;
}

function parseConversationSummary(value: unknown): RequiredConversationSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const sessionId = toText(value.sessionId);
  if (sessionId.length === 0) {
    return undefined;
  }

  const summary = parseConversationSummaryCore(value);
  if (!summary) {
    return undefined;
  }

  return deserializeSummary({
    ...summary,
    sessionId
  });
}

function parseConversationSummaryCore(value: unknown): Omit<SerializedConversationSummary, "sessionId"> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const narrative = toText(value.narrative);
  const createdAt = toText(value.createdAt);
  const updatedAt = toText(value.updatedAt);
  if (createdAt.length === 0 || updatedAt.length === 0) {
    return undefined;
  }

  const summarizedUpToIndex = toFiniteInteger(value.summarizedUpToIndex) ?? 0;
  const facts = parseStructuredFacts(value.facts);
  if (!facts) {
    return undefined;
  }

  const userId = toOptionalText(value.userId);

  return {
    facts,
    narrative,
    summarizedUpToIndex,
    createdAt,
    updatedAt,
    ...(userId ? { userId } : {})
  };
}

function parseStructuredFacts(
  value: unknown
): readonly SerializedStructuredFact[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const facts: SerializedStructuredFact[] = [];
  for (const item of value) {
    const parsed = parseStructuredFact(item);
    if (parsed) {
      facts.push(parsed);
    }
  }

  return facts;
}

function parseStructuredFact(value: unknown): SerializedStructuredFact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const key = toText(value.key);
  const extractedAt = toText(value.extractedAt);
  const factValue = toText(value.value);
  if (key.length === 0 || extractedAt.length === 0 || factValue.length === 0) {
    return undefined;
  }

  return {
    category: factCategoryValue(value.category),
    extractedAt,
    key,
    value: factValue
  };
}

function toFiniteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toOptionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isSerializedStructuredFact(value: unknown): value is SerializedStructuredFact {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.category === "string"
    && typeof value.extractedAt === "string"
    && typeof value.key === "string"
    && typeof value.value === "string";
}

function parseJsonArray<T>(value: unknown, isEntry: (value: unknown) => value is T): readonly T[] {
  if (Array.isArray(value)) {
    return value.filter(isEntry);
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
    } catch {
      return [];
    }
  }

  return [];
}
