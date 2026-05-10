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
import type { Insertable, Kysely } from "kysely";
import { EMPTY_USER_MODEL, type UserMemory, type UserMemoryStore, type UserModel, type UserModelSlot } from "./index.js";

type UserMemoryRow = Record<string, unknown>;
type UserMemoryInsert = Insertable<MuseDatabase["user_memories"]>;

export class InMemoryUserMemoryStore implements UserMemoryStore {
  private readonly memories = new Map<string, UserMemory>();

  findByUserId(userId: string): UserMemory | undefined {
    return cloneUserMemory(this.memories.get(userId));
  }

  upsertFact(userId: string, key: string, value: string): UserMemory {
    return this.upsert(userId, { facts: { [key]: value } });
  }

  upsertPreference(userId: string, key: string, value: string): UserMemory {
    return this.upsert(userId, { preferences: { [key]: value } });
  }

  deleteByUserId(userId: string): boolean {
    return this.memories.delete(userId);
  }

  /**
   * Round 164: typed-slot upsert. Replace-by-id semantics within
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
    const updated: UserMemory = {
      facts: { ...(existing?.facts ?? {}), ...(patch.facts ?? {}) },
      preferences: { ...(existing?.preferences ?? {}), ...(patch.preferences ?? {}) },
      recentTopics: existing?.recentTopics ?? [],
      updatedAt: new Date(),
      userId,
      ...(patch.userModel ? { userModel: patch.userModel } : (existing?.userModel ? { userModel: existing.userModel } : {}))
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
      facts: { ...(existing?.facts ?? {}), [key]: value },
      preferences: existing?.preferences ?? {},
      recentTopics: existing?.recentTopics ?? [],
      updatedAt: new Date(),
      userId
    });
  }

  async upsertPreference(userId: string, key: string, value: string): Promise<UserMemory> {
    const existing = await this.findByUserId(userId);
    return this.save({
      facts: existing?.facts ?? {},
      preferences: { ...(existing?.preferences ?? {}), [key]: value },
      recentTopics: existing?.recentTopics ?? [],
      updatedAt: new Date(),
      userId
    });
  }

  async deleteByUserId(userId: string): Promise<boolean> {
    const result = await this.db.deleteFrom("user_memories").where("user_id", "=", userId).executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
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
        updated_at: insert.updated_at
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
    user_id: memory.userId
  };
}

export function mapUserMemoryRow(row: UserMemoryRow): UserMemory {
  return {
    facts: jsonStringRecord(row.facts),
    preferences: jsonStringRecord(row.preferences),
    recentTopics: typeof row.recent_topics === "string"
      ? row.recent_topics.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)
      : [],
    updatedAt: dateValue(row.updated_at),
    userId: stringValue(row.user_id)
  };
}

function cloneUserMemory(memory: UserMemory | undefined): UserMemory | undefined {
  return memory
    ? {
      facts: { ...memory.facts },
      preferences: { ...memory.preferences },
      recentTopics: [...memory.recentTopics],
      updatedAt: memory.updatedAt,
      userId: memory.userId,
      ...(memory.userModel ? { userModel: cloneUserModel(memory.userModel) } : {})
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
