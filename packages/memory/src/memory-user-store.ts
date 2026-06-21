/**
 * User-memory persistence primitives extracted from
 * packages/memory/src/index.ts.
 *
 * Owns `InMemoryUserMemoryStore` (in-process map keyed by `userId`,
 * supports `upsertFact` / `upsertPreference` patches) and
 * `KyselyUserMemoryStore` (Postgres `INSERT … ON CONFLICT (user_id)
 * DO UPDATE` upsert that round-trips facts/preferences/recentTopics
 * through the `user_memories` table). Plus the row-builder
 * `createUserMemoryInsert`, the row-mapper `mapUserMemoryRow`, and
 * the small private helpers (`cloneUserMemory`, `stringValue`,
 * `dateValue`, `jsonStringRecord`) inlined to keep the dependency
 * direction clean.
 *
 * Re-exported from the memory barrel for backwards compatibility.
 */

import type { MuseDatabase } from "@muse/db";
import { redactSecretsInText, type JsonValue } from "@muse/shared";
import type { Insertable, Kysely } from "kysely";
import { classifyValueChange } from "./belief-provenance-store.js";
import { EMPTY_USER_MODEL, type FactSupersession, type UserMemory, type UserMemoryStore, type UserModel, type UserModelSlot } from "./index.js";

type UserMemoryRow = Record<string, unknown>;
type UserMemoryInsert = Insertable<MuseDatabase["user_memories"]>;

/**
 * Maximum length, in code points, the user-memory store will
 * persist for a single fact / preference value. Chosen so the
 * persona-expansion path that re-emits these into the next turn's
 * system prompt can't be ballooned by a single oversized auto-
 * extract (whether from a hostile chat message or a malformed
 * tool result).
 */
export const MAX_USER_MEMORY_VALUE_CHARS = 2048;

/**
 * Strip C0/C1 control bytes (except newline / tab) and cap length.
 * Defense-in-depth at the persistence layer: `muse remember`'s
 * `--no-llm` direct path, the LLM-extract path, AND the chat-turn
 * auto-extract hook all funnel through `upsertFact` /
 * `upsertPreference` — pinning the sanitiser to the store means
 * every caller is covered with one rule.
 *
 * Treat the inputs as untrusted (an attacker who steers the model
 * into extracting a value containing `\x1b[2J` would otherwise
 * land it in `~/.muse/user-memory.json` and re-inject it next turn
 * via the persona-expansion path).
 */
export function sanitizeUserMemoryValue(raw: string): string {
  // user-memory is re-injected into every prompt via persona
  // expansion, so a credential in an extracted value would
  // round-trip into the model and persist long-term — scrub it
  // at this single write chokepoint.
  const scrubbed = redactSecretsInText(raw);
  const stripped = scrubbed.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "");
  if (stripped.length <= MAX_USER_MEMORY_VALUE_CHARS) {
    return stripped;
  }
  let head = stripped.slice(0, MAX_USER_MEMORY_VALUE_CHARS);
  // `slice` cuts on UTF-16 units; a boundary inside an astral
  // char (emoji / supplementary-plane) leaves a lone high surrogate.
  // The persisted value is re-injected into every prompt via persona
  // expansion — invalid UTF-8 there corrupts the prompt + downstream
  // JSON/SSE/messaging that echoes the memory. Drop the orphan.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    head = head.slice(0, -1);
  }
  return head;
}

/**
 * Merge `patch` into `existing` so any key the patch touches (re-confirmed
 * OR new) lands at the END of the returned record, untouched keys keeping
 * their original order. A plain `{ ...existing, ...patch }` updates an
 * existing key IN PLACE — so the persona builder's "freshest N (tail)" cap
 * would drop a fact the user just re-stated merely because its key was
 * inserted long ago. Touch-last makes the tail genuinely most-recently-used.
 */
/** Cap on retained fact-supersession entries (newest kept). Bounds the
 * file/in-memory daily-driver store so a fact toggled many times can't
 * grow the history without limit. */
export const MAX_FACT_HISTORY_ENTRIES = 50;

/**
 * The prior values overwritten when `patchFacts` changes already-known keys
 * to a DIFFERENT value. New keys and unchanged re-confirms yield nothing —
 * only a genuine value change is a supersession worth keeping.
 */
export function collectFactSupersessions(
  existingFacts: Readonly<Record<string, string>>,
  patchFacts: Readonly<Record<string, string>>,
  now: Date,
  scope: "fact" | "preference" = "fact"
): FactSupersession[] {
  const out: FactSupersession[] = [];
  for (const [key, nextValue] of Object.entries(patchFacts)) {
    const prior = existingFacts[key];
    if (prior !== undefined && prior !== nextValue) {
      // classifyValueChange never returns "same" here (the prior !== next guard
      // already excluded byte-equal; a case/space-only variant is still a
      // supersession worth logging — label it by the conservative branch).
      const change = classifyValueChange(prior, nextValue);
      const kind: "refine" | "contradict" = change === "refine" ? "refine" : "contradict";
      // scope omitted for facts (back-compat: legacy + fact entries carry none).
      out.push({ key, previousValue: prior, replacedAt: now, kind, ...(scope === "preference" ? { scope } : {}) });
    }
  }
  return out;
}

/** Append new supersessions to the prior log, newest last, capped. */
export function appendFactHistory(
  existing: readonly FactSupersession[] | undefined,
  additions: readonly FactSupersession[]
): readonly FactSupersession[] | undefined {
  if (additions.length === 0) return existing;
  return [...(existing ?? []), ...additions].slice(-MAX_FACT_HISTORY_ENTRIES);
}

/**
 * Canonicalize a memory key so casing/spacing variants of the same concept
 * collapse to ONE entry instead of fragmenting ("Home City" / "homeCity" /
 * "home_city" → "home_city"). Deterministic consolidation (the safe half of
 * the dedup story; semantic dedup would need the model). Unicode letters are
 * kept (Korean keys survive); empty result falls back to the original.
 */
export function normalizeMemoryKey(key: string): string {
  const normalized = key
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/gu, "_")
    .replace(/[^\p{L}\p{N}_]/gu, "")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized.length > 0 ? normalized : key.trim();
}

export type MemoryOperation = "add" | "update" | "noop" | "delete";

// Tokens an extractor emits when it found NO value for a key — storing them
// verbatim pollutes memory with "unknown"/"none" facts, so they map to DELETE
// (drop the key) rather than UPDATE. Bilingual (Muse runs KO + EN).
const RETRACTION_TOKENS = new Set(["", "none", "n/a", "na", "null", "nil", "unknown", "없음", "모름", "해당없음"]);

/**
 * Classify what a freshly-extracted value should do to the existing memory for
 * a key (Mem0, arXiv 2504.19413: an explicit ADD/UPDATE/DELETE/NOOP decision
 * per candidate fact instead of a blind overwrite). Deterministic — runs over
 * the extractor's already-produced output, no extra model call:
 *   - DELETE: the value is a no-value/retraction token → drop the key.
 *   - ADD:    no existing value for the key.
 *   - NOOP:   the value re-confirms what's already stored (skip the write).
 *   - UPDATE: a genuinely different value → supersede.
 */
export function classifyMemoryOperation(existing: string | undefined, incoming: string): MemoryOperation {
  if (RETRACTION_TOKENS.has(incoming.trim().toLowerCase())) {
    // A retraction for a key that was never stored has nothing to drop — NOOP,
    // not a spurious DELETE that calls forget() on a non-existent key.
    return existing === undefined ? "noop" : "delete";
  }
  if (existing === undefined) {
    return "add";
  }
  return existing.trim() === incoming.trim() ? "noop" : "update";
}

export function mergeRecordTouchLast(
  existing: Readonly<Record<string, string>>,
  patch: Readonly<Record<string, string>>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (!(key in patch)) result[key] = value;
  }
  for (const [key, value] of Object.entries(patch)) result[key] = value;
  return result;
}

export class InMemoryUserMemoryStore implements UserMemoryStore {
  private readonly memories = new Map<string, UserMemory>();

  findByUserId(userId: string): UserMemory | undefined {
    return cloneUserMemory(this.memories.get(userId));
  }

  upsertFact(userId: string, key: string, value: string): UserMemory {
    return this.upsert(userId, { facts: { [normalizeMemoryKey(key)]: sanitizeUserMemoryValue(value) } });
  }

  upsertPreference(userId: string, key: string, value: string): UserMemory {
    return this.upsert(userId, { preferences: { [normalizeMemoryKey(key)]: sanitizeUserMemoryValue(value) } });
  }

  deleteByUserId(userId: string): boolean {
    return this.memories.delete(userId);
  }

  forget(userId: string, rawKey: string, kind?: "fact" | "preference"): boolean {
    const existing = this.memories.get(userId);
    if (!existing) {
      return false;
    }
    // Keys are stored canonicalized (upsert normalizes), so resolve the raw key
    // to its stored form — exact first, else the normalized one — exactly as the
    // File store does, so "Home City" forgets the "home_city" entry.
    const key = (rawKey in existing.facts || rawKey in existing.preferences) ? rawKey : normalizeMemoryKey(rawKey);
    // Namespace-scoped: `kind` limits the delete to facts OR preferences (so an
    // auto-extracted FACT retraction can't wipe a same-key PREFERENCE). Omitting
    // `kind` keeps the dual-delete for the explicit `/forget` control.
    const dropFact = kind !== "preference";
    const dropPref = kind !== "fact";
    const hadFact = dropFact && key in existing.facts;
    const hadPref = dropPref && key in existing.preferences;
    if (!hadFact && !hadPref) {
      return false;
    }
    const { [key]: _f, ...factsWithout } = existing.facts;
    const { [key]: _p, ...prefsWithout } = existing.preferences;
    this.memories.set(userId, {
      ...existing,
      facts: dropFact ? factsWithout : existing.facts,
      preferences: dropPref ? prefsWithout : existing.preferences,
      updatedAt: new Date()
    });
    return true;
  }

  /**
   * typed-slot upsert. Replace-by-id semantics within
   * the slot's `kind` — a new preference with the same `id` overwrites
   * the prior one. New slots are appended. Other kinds are left
   * untouched.
   */
  upsertUserModelSlot(userId: string, slot: UserModelSlot): UserMemory {
    const existing = this.memories.get(userId);
    const baseModel = existing?.userModel ?? EMPTY_USER_MODEL;
    const nextModel = applyUserModelSlot(baseModel, slot);
    return this.upsert(userId, { userModel: nextModel });
  }

  private upsert(
    userId: string,
    patch: {
      readonly facts?: Readonly<Record<string, string>>;
      readonly preferences?: Readonly<Record<string, string>>;
      readonly userModel?: UserModel;
    }
  ): UserMemory {
    const existing = this.memories.get(userId);
    const now = new Date();
    const factHistory = appendFactHistory(
      existing?.factHistory,
      [
        ...collectFactSupersessions(existing?.facts ?? {}, patch.facts ?? {}, now),
        ...collectFactSupersessions(existing?.preferences ?? {}, patch.preferences ?? {}, now, "preference")
      ]
    );
    const updated: UserMemory = {
      facts: mergeRecordTouchLast(existing?.facts ?? {}, patch.facts ?? {}),
      preferences: mergeRecordTouchLast(existing?.preferences ?? {}, patch.preferences ?? {}),
      recentTopics: existing?.recentTopics ?? [],
      updatedAt: now,
      userId,
      ...(patch.userModel ? { userModel: patch.userModel } : (existing?.userModel ? { userModel: existing.userModel } : {})),
      ...(factHistory ? { factHistory } : {})
    };

    this.memories.set(userId, updated);
    return cloneUserMemory(updated) ?? updated;
  }
}

export class KyselyUserMemoryStore implements UserMemoryStore {
  constructor(private readonly db: Kysely<MuseDatabase>) {}

  async findByUserId(userId: string): Promise<UserMemory | undefined> {
    const row = await this.db.selectFrom("user_memories").selectAll().where("user_id", "=", userId).executeTakeFirst();
    return row ? mapUserMemoryRow(row as UserMemoryRow) : undefined;
  }

  async upsertFact(userId: string, key: string, value: string): Promise<UserMemory> {
    const existing = await this.findByUserId(userId);
    return this.save({
      facts: mergeRecordTouchLast(existing?.facts ?? {}, { [normalizeMemoryKey(key)]: sanitizeUserMemoryValue(value) }),
      preferences: existing?.preferences ?? {},
      recentTopics: existing?.recentTopics ?? [],
      updatedAt: new Date(),
      userId,
      ...(existing?.userModel ? { userModel: existing.userModel } : {})
    });
  }

  async upsertPreference(userId: string, key: string, value: string): Promise<UserMemory> {
    const existing = await this.findByUserId(userId);
    return this.save({
      facts: existing?.facts ?? {},
      preferences: mergeRecordTouchLast(existing?.preferences ?? {}, { [normalizeMemoryKey(key)]: sanitizeUserMemoryValue(value) }),
      recentTopics: existing?.recentTopics ?? [],
      updatedAt: new Date(),
      userId,
      ...(existing?.userModel ? { userModel: existing.userModel } : {})
    });
  }

  async deleteByUserId(userId: string): Promise<boolean> {
    const result = await this.db.deleteFrom("user_memories").where("user_id", "=", userId).executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  /**
   * typed-slot upsert, mirrors `InMemoryUserMemoryStore.upsertUserModelSlot`.
   * Replace-by-id within the slot's `kind`, other kinds untouched.
   * Stored as JSONB on `user_memories.user_model`.
   */
  async upsertUserModelSlot(userId: string, slot: UserModelSlot): Promise<UserMemory> {
    const existing = await this.findByUserId(userId);
    const baseModel = existing?.userModel ?? EMPTY_USER_MODEL;
    return this.save({
      facts: existing?.facts ?? {},
      preferences: existing?.preferences ?? {},
      recentTopics: existing?.recentTopics ?? [],
      updatedAt: new Date(),
      userId,
      userModel: applyUserModelSlot(baseModel, slot)
    });
  }

  private async save(memory: UserMemory): Promise<UserMemory> {
    const insert = createUserMemoryInsert(memory);
    const row = await this.db
      .insertInto("user_memories")
      .values(insert)
      .onConflict((oc) => oc.column("user_id").doUpdateSet({
        facts: insert.facts,
        preferences: insert.preferences,
        recent_topics: insert.recent_topics,
        updated_at: insert.updated_at,
        user_model: insert.user_model
      }))
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapUserMemoryRow(row as UserMemoryRow);
  }
}

export function createUserMemoryInsert(memory: UserMemory): UserMemoryInsert {
  return {
    facts: { ...memory.facts },
    preferences: { ...memory.preferences },
    recent_topics: memory.recentTopics.join("\n"),
    updated_at: memory.updatedAt,
    user_id: memory.userId,
    // null when userModel is undefined so Postgres stores SQL NULL
    // (column is nullable). On read, mapUserMemoryRow turns null
    // back into undefined.
    user_model: memory.userModel ? serializeUserModel(memory.userModel) : null
  };
}

export function mapUserMemoryRow(row: UserMemoryRow): UserMemory {
  const userModel = parseUserModelJson(row.user_model);
  return {
    facts: jsonStringRecord(row.facts),
    preferences: jsonStringRecord(row.preferences),
    recentTopics: typeof row.recent_topics === "string"
      ? row.recent_topics.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)
      : [],
    updatedAt: dateValue(row.updated_at),
    userId: stringValue(row.user_id),
    ...(userModel ? { userModel } : {})
  };
}

/**
 * Serialize the UserModel for JSONB storage. We store Date objects
 * as ISO strings so the column round-trips through JSON.parse
 * cleanly — `parseUserModelJson` rehydrates the Dates on read.
 */
function serializeUserModel(model: UserModel): JsonValue {
  return {
    goals: model.goals.map((slot) => slotToJson(slot)),
    preferences: model.preferences.map((slot) => slotToJson(slot)),
    schedule: model.schedule.map((slot) => slotToJson(slot)),
    vetoes: model.vetoes.map((slot) => slotToJson(slot))
  } as JsonValue;
}

function slotToJson(slot: UserModelSlot): JsonValue {
  // Drop optional Date fields when undefined and serialize present
  // ones to ISO strings. Cast through Record<string, JsonValue> at
  // the boundary; the runtime enforces the discriminated-union
  // invariants on read.
  const base: Record<string, JsonValue> = {
    id: slot.id,
    kind: slot.kind,
    updatedAt: slot.updatedAt instanceof Date ? slot.updatedAt.toISOString() : String(slot.updatedAt),
    value: slot.value,
    ...(slot.confidence !== undefined ? { confidence: slot.confidence } : {})
  };
  if (slot.kind === "preference" && slot.category) {
    base.category = slot.category;
  } else if (slot.kind === "schedule" && slot.recurrence) {
    base.recurrence = slot.recurrence;
  } else if (slot.kind === "veto" && slot.scope) {
    base.scope = slot.scope;
  } else if (slot.kind === "goal") {
    if (slot.dueAt instanceof Date) {
      base.dueAt = slot.dueAt.toISOString();
    }
    if (slot.progress !== undefined) {
      base.progress = slot.progress;
    }
  }
  return base as JsonValue;
}

function parseUserModelJson(raw: unknown): UserModel | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const result: UserModel = {
    goals: parseSlotArray(record.goals, "goal") as UserModel["goals"],
    preferences: parseSlotArray(record.preferences, "preference") as UserModel["preferences"],
    schedule: parseSlotArray(record.schedule, "schedule") as UserModel["schedule"],
    vetoes: parseSlotArray(record.vetoes, "veto") as UserModel["vetoes"]
  };
  // Any kind populated → return; otherwise undefined so callers see
  // legacy (no-userModel) shape for users who never wrote one.
  if (
    result.goals.length === 0 &&
    result.preferences.length === 0 &&
    result.schedule.length === 0 &&
    result.vetoes.length === 0
  ) {
    return undefined;
  }
  return result;
}

function parseSlotArray(raw: unknown, expectedKind: UserModelSlot["kind"]): readonly UserModelSlot[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: UserModelSlot[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const slot = entry as Record<string, unknown>;
    if (slot.kind !== expectedKind) {
      continue;
    }
    if (typeof slot.id !== "string" || typeof slot.value !== "string") {
      continue;
    }
    const updatedAt = typeof slot.updatedAt === "string" ? new Date(slot.updatedAt) : undefined;
    if (!updatedAt || Number.isNaN(updatedAt.getTime())) {
      continue;
    }
    const base = {
      id: slot.id,
      updatedAt,
      value: slot.value,
      ...(typeof slot.confidence === "number" ? { confidence: slot.confidence } : {})
    };
    if (expectedKind === "preference") {
      out.push({
        ...base,
        kind: "preference",
        ...(typeof slot.category === "string" ? { category: slot.category } : {})
      });
    } else if (expectedKind === "schedule") {
      out.push({
        ...base,
        kind: "schedule",
        ...(typeof slot.recurrence === "string" ? { recurrence: slot.recurrence } : {})
      });
    } else if (expectedKind === "veto") {
      out.push({
        ...base,
        kind: "veto",
        ...(typeof slot.scope === "string" ? { scope: slot.scope } : {})
      });
    } else if (expectedKind === "goal") {
      const dueAt = typeof slot.dueAt === "string" ? new Date(slot.dueAt) : undefined;
      out.push({
        ...base,
        kind: "goal",
        ...(dueAt && !Number.isNaN(dueAt.getTime()) ? { dueAt } : {}),
        ...(typeof slot.progress === "number" ? { progress: slot.progress } : {})
      });
    }
  }
  return out;
}

function cloneUserMemory(memory: UserMemory | undefined): UserMemory | undefined {
  return memory
    ? {
      facts: { ...memory.facts },
      preferences: { ...memory.preferences },
      recentTopics: [...memory.recentTopics],
      updatedAt: memory.updatedAt,
      userId: memory.userId,
      ...(memory.userModel ? { userModel: cloneUserModel(memory.userModel) } : {}),
      ...(memory.factHistory ? { factHistory: memory.factHistory.map((entry) => ({ ...entry })) } : {})
    }
    : undefined;
}

function cloneUserModel(model: UserModel): UserModel {
  return {
    goals: model.goals.map((slot) => ({ ...slot })),
    preferences: model.preferences.map((slot) => ({ ...slot })),
    schedule: model.schedule.map((slot) => ({ ...slot })),
    vetoes: model.vetoes.map((slot) => ({ ...slot }))
  };
}

/**
 * Replace-or-append the slot inside the matching kind's array.
 * Replace happens when an existing slot in the same kind shares
 * the same `id`; otherwise the slot is appended. Other kinds are
 * passed through unchanged.
 */
function applyUserModelSlot(model: UserModel, slot: UserModelSlot): UserModel {
  switch (slot.kind) {
    case "preference":
      return { ...model, preferences: replaceOrAppend(model.preferences, slot) };
    case "schedule":
      return { ...model, schedule: replaceOrAppend(model.schedule, slot) };
    case "veto":
      return { ...model, vetoes: replaceOrAppend(model.vetoes, slot) };
    case "goal":
      return { ...model, goals: replaceOrAppend(model.goals, slot) };
  }
}

function replaceOrAppend<T extends { readonly id: string }>(items: readonly T[], next: T): T[] {
  const idx = items.findIndex((item) => item.id === next.id);
  if (idx === -1) {
    return [...items, next];
  }
  const copy = [...items];
  copy[idx] = next;
  return copy;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function dateValue(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : new Date(0);
  }
  return new Date(0);
}

function jsonStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (typeof value === "string") {
      try {
        return jsonStringRecord(JSON.parse(value));
      } catch {
        return {};
      }
    }
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return result;
}
