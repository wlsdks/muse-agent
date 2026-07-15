import { createRunId, isRecord, type JsonObject, type JsonValue } from "@muse/shared";
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

export class InMemoryDebugReplayCaptureStore implements DebugReplayCaptureStore {
  private readonly captures = new Map<string, JsonObject>();

  async saveDebugReplayCapture(record: JsonObject): Promise<JsonObject> {
    const saved = withIdentity(record, "debug_replay");
    this.captures.set(saved.id, saved);
    return saved;
  }

  async listDebugReplayCaptures(limit = 50): Promise<readonly JsonObject[]> {
    // Kysely path orders by captured_at DESC (newest first); the
    // pre-fix in-memory path returned Map iteration order (oldest
    // first), so tests using this store saw a different ordering than
    // production. Sort by parsed capturedAt DESC with an id ASC
    // tiebreaker so two captures at the same instant come out in a
    // deterministic, stable order across runs.
    const sorted = [...this.captures.values()].sort(compareDebugReplayByCapturedAtDesc);
    return sorted.slice(0, Math.max(0, limit));
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

  async listDebugReplayCaptures(limit = 50): Promise<readonly JsonObject[]> {
    const rows = await this.db
      .selectFrom("debug_replay_captures")
      .selectAll()
      .orderBy("captured_at", "desc")
      .limit(limit)
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
      return jsonArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

function jsonObject(value: unknown): JsonObject {
  if (isRecord(value)) {
    return toJsonObject(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      return jsonObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return {};
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (isJsonValue(item)) {
      out[key] = item;
    }
  }
  return out;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return Boolean(value) && typeof value === "object" && Object.values(value).every(isJsonValue);
}
