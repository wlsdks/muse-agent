import { createRunId, isJsonValue, type JsonObject, type JsonValue } from "@muse/shared";
import type { DebugReplayCaptureTable, MuseDatabase } from "@muse/db";
import type { Insertable, Kysely, Selectable } from "kysely";

export type DebugReplayCaptureRow = Selectable<DebugReplayCaptureTable>;
export type DebugReplayCaptureInsert = Insertable<DebugReplayCaptureTable>;

/**
 * Persistent store for the personal-Muse `/api/admin/debug/replay` surface —
 * keeps the in-memory and Postgres-backed paths symmetric so failed-run
 * captures can survive a restart while still being usable in tests.
 */
export interface DebugReplayCaptureStore {
  saveDebugReplayCapture(record: JsonObject): Promise<JsonObject>;
  listDebugReplayCaptures(limit?: number): Promise<readonly JsonObject[]>;
  getDebugReplayCapture(id: string): Promise<JsonObject | undefined>;
  purgeExpired(referenceTime?: Date): Promise<number>;
}

const DEFAULT_DEBUG_REPLAY_LIST_LIMIT = 50;

export class InMemoryDebugReplayCaptureStore implements DebugReplayCaptureStore {
  private readonly captures = new Map<string, JsonObject>();

  async saveDebugReplayCapture(record: JsonObject): Promise<JsonObject> {
    const saved = withIdentity(record, "debug_replay");
    this.captures.set(saved.id, saved);
    return saved;
  }

  async listDebugReplayCaptures(limit?: number): Promise<readonly JsonObject[]> {
    // Kysely path orders by captured_at DESC, id ASC; the
    // pre-fix in-memory path returned Map iteration order (oldest
    // first), so tests using this store saw a different ordering than
    // production. Sort by parsed capturedAt DESC with an id ASC
    // tiebreaker so two captures at the same instant come out in a
    // deterministic, stable order across runs.
    const normalizedLimit = normalizeDebugReplayListLimit(limit);
    const sorted = [...this.captures.values()].sort(compareDebugReplayByCapturedAtDesc);
    return sorted.slice(0, normalizedLimit);
  }

  async getDebugReplayCapture(id: string): Promise<JsonObject | undefined> {
    return this.captures.get(id);
  }

  async purgeExpired(referenceTime: Date = new Date()): Promise<number> {
    let purged = 0;
    for (const [id, record] of this.captures) {
      const expiresAt = nullableDate(record.expiresAt);

      if (expiresAt && expiresAt.getTime() <= referenceTime.getTime()) {
        this.captures.delete(id);
        purged += 1;
      }
    }
    return purged;
  }
}

export class KyselyDebugReplayCaptureStore implements DebugReplayCaptureStore {
  constructor(private readonly db: Kysely<MuseDatabase>) {}

  async saveDebugReplayCapture(record: JsonObject): Promise<JsonObject> {
    const row = createDebugReplayCaptureInsert(record);
    const saved = await this.db
      .insertInto("debug_replay_captures")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapDebugReplayCaptureRow(saved);
  }

  async listDebugReplayCaptures(limit?: number): Promise<readonly JsonObject[]> {
    const normalizedLimit = normalizeDebugReplayListLimit(limit);
    const rows = await this.db
      .selectFrom("debug_replay_captures")
      .selectAll()
      .orderBy("captured_at", "desc")
      .orderBy("id", "asc")
      .limit(normalizedLimit)
      .execute();
    return rows.map(mapDebugReplayCaptureRow);
  }

  async getDebugReplayCapture(id: string): Promise<JsonObject | undefined> {
    const row = await this.db
      .selectFrom("debug_replay_captures")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapDebugReplayCaptureRow(row) : undefined;
  }

  async purgeExpired(referenceTime: Date = new Date()): Promise<number> {
    const deleted = await this.db
      .deleteFrom("debug_replay_captures")
      .where("expires_at", "<=", referenceTime)
      .executeTakeFirst();
    return Number(deleted.numDeletedRows ?? 0);
  }
}

export function createDebugReplayCaptureInsert(record: JsonObject): DebugReplayCaptureInsert {
  return {
    captured_at: dateValue(record.capturedAt),
    error_code: nullableString(record.errorCode),
    error_message: nullableString(record.errorMessage),
    expires_at: dateValue(record.expiresAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString()),
    id: stringValue(record.id) || undefined,
    metadata_json: jsonObject(record.metadata),
    model_id: nullableString(record.modelId),
    tools_attempted: jsonArray(record.toolsAttempted),
    user_hash: nullableString(record.userHash),
    user_prompt: stringValue(record.userPrompt)
  };
}

export function mapDebugReplayCaptureRow(
  row: DebugReplayCaptureRow | DebugReplayCaptureInsert
): JsonObject {
  return {
    capturedAt: dateValue(row.captured_at).toISOString(),
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    expiresAt: dateValue(row.expires_at).toISOString(),
    id: stringValue(row.id),
    metadata: jsonObject(row.metadata_json),
    modelId: row.model_id ?? null,
    toolsAttempted: jsonArray(row.tools_attempted),
    userHash: row.user_hash ?? null,
    userPrompt: row.user_prompt
  };
}

function compareDebugReplayByCapturedAtDesc(a: JsonObject, b: JsonObject): number {
  const ta = parseTimestampMs(a.capturedAt);
  const tb = parseTimestampMs(b.capturedAt);
  if (ta !== tb) return tb - ta;
  return stringValue(a.id).localeCompare(stringValue(b.id));
}

function normalizeDebugReplayListLimit(limit: number | undefined): number {
  const candidate = limit ?? DEFAULT_DEBUG_REPLAY_LIST_LIMIT;
  if (!Number.isFinite(candidate)) {
    return DEFAULT_DEBUG_REPLAY_LIST_LIMIT;
  }

  const normalized = Math.trunc(candidate);
  return Number.isSafeInteger(normalized)
    ? Math.max(0, normalized)
    : DEFAULT_DEBUG_REPLAY_LIST_LIMIT;
}

function parseTimestampMs(value: unknown): number {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  }
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  }
  return Number.NEGATIVE_INFINITY;
}

function withIdentity(record: JsonObject, prefix: string): JsonObject & { readonly id: string } {
  const createdAt = dateValue(record.createdAt).toISOString();
  return {
    ...record,
    createdAt,
    id: stringValue(record.id) || createRunId(prefix),
    updatedAt: dateValue(record.updatedAt ?? createdAt).toISOString()
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  const normalized = stringValue(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function dateValue(value: unknown): Date {
  const candidate = value instanceof Date ? value : new Date(typeof value === "string" ? value : Date.now());
  // A corrupt persisted timestamp (hand-edited row, partial write)
  // would otherwise reach `.toISOString()` and throw a RangeError,
  // 500-ing the whole debug-replay list because one row is bad.
  return Number.isNaN(candidate.getTime()) ? new Date() : candidate;
}

function nullableDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  return typeof value === "string" && value.trim().length > 0 ? new Date(value) : null;
}

function jsonArray(value: unknown): JsonValue[] {
  if (Array.isArray(value)) {
    return value.filter(isJsonValue);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      return jsonArray(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  return [];
}

function jsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value) && isJsonValue(value)) {
    return value as JsonObject;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      return jsonObject(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return {};
}
