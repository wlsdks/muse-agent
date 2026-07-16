import { describe, expect, it } from "vitest";
import type { MuseDatabase } from "@muse/db";
import type { Kysely } from "kysely";

import { KyselyUserMemoryStore, mapUserMemoryRow } from "../src/memory-user-store.js";

/**
 * KyselyUserMemoryStore's SQL-BUILDER pieces (createUserMemoryInsert,
 * mapUserMemoryRow) already have round-trip coverage in test/memory.test.ts.
 * What's untested is (1) the CLASS's own runtime logic — does upsertFact
 * preserve existing preferences/userModel instead of clobbering them on
 * save(), does deleteByUserId translate numDeletedRows correctly — and
 * (2) mapUserMemoryRow's defensive parsing of a GARBAGE row (a stale
 * migration, a hand-edited row, a driver returning JSONB as a string
 * instead of pre-parsed). A silently mis-parsed row is exactly the
 * "silent corruption" class this task exists to catch.
 */

interface FakeRow {
  readonly user_id: string;
  [key: string]: unknown;
}

function createFakeUserMemoriesDb() {
  const rows = new Map<string, FakeRow>();
  const db = {
    deleteFrom(_table: string) {
      return {
        where(_col: string, _op: string, userId: string) {
          return {
            async executeTakeFirst() {
              const had = rows.has(userId);
              rows.delete(userId);
              return { numDeletedRows: had ? 1n : 0n };
            }
          };
        }
      };
    },
    insertInto(_table: string) {
      return {
        values(insert: Record<string, unknown>) {
          return {
            onConflict(fn: (oc: unknown) => unknown) {
              // Exercise the same builder-callback shape production code uses,
              // so a change to the .doUpdateSet({...}) call shape is exercised.
              fn({ column: () => ({ doUpdateSet: (set: unknown) => set }) });
              return {
                returningAll() {
                  return {
                    async executeTakeFirstOrThrow() {
                      const userId = insert.user_id as string;
                      const merged: FakeRow = { ...(rows.get(userId) ?? {}), ...insert, user_id: userId };
                      rows.set(userId, merged);
                      return merged;
                    }
                  };
                }
              };
            }
          };
        }
      };
    },
    selectFrom(_table: string) {
      return {
        selectAll() {
          return {
            where(_col: string, _op: string, userId: string) {
              return {
                async executeTakeFirst() {
                  return rows.get(userId);
                }
              };
            }
          };
        }
      };
    },
    transaction() {
      return {
        execute: async <T>(operation: (transaction: Kysely<MuseDatabase>) => Promise<T>) =>
          operation(db as unknown as Kysely<MuseDatabase>)
      };
    }
  };
  return { db: db as unknown as Kysely<MuseDatabase>, rows };
}

function createStore(db: Kysely<MuseDatabase>): KyselyUserMemoryStore {
  return new KyselyUserMemoryStore(db, { acquireUserLock: async () => undefined });
}

describe("KyselyUserMemoryStore (class runtime behavior against a fake db)", () => {
  it("findByUserId returns undefined when absent, the row once inserted", async () => {
    const { db } = createFakeUserMemoriesDb();
    const store = createStore(db);
    expect(await store.findByUserId("stark")).toBeUndefined();
    await store.upsertFact("stark", "name", "Stark");
    expect((await store.findByUserId("stark"))?.facts.name).toBe("Stark");
  });

  it("upsertFact preserves an EXISTING preference instead of clobbering it on save()", async () => {
    const { db } = createFakeUserMemoriesDb();
    const store = createStore(db);
    await store.upsertPreference("stark", "tone", "concise");
    await store.upsertFact("stark", "city", "Seoul");
    const memory = await store.findByUserId("stark");
    expect(memory?.facts).toEqual({ city: "Seoul" });
    expect(memory?.preferences).toEqual({ tone: "concise" }); // NOT wiped by the fact upsert
  });

  it("upsertPreference preserves EXISTING facts instead of clobbering them on save()", async () => {
    const { db } = createFakeUserMemoriesDb();
    const store = createStore(db);
    await store.upsertFact("stark", "city", "Seoul");
    await store.upsertPreference("stark", "tone", "concise");
    const memory = await store.findByUserId("stark");
    expect(memory?.facts).toEqual({ city: "Seoul" }); // NOT wiped by the preference upsert
    expect(memory?.preferences).toEqual({ tone: "concise" });
  });

  it("upsertUserModelSlot preserves existing facts/preferences and replaces a slot by id within its kind", async () => {
    const { db } = createFakeUserMemoriesDb();
    const store = createStore(db);
    await store.upsertFact("stark", "city", "Seoul");
    await store.upsertUserModelSlot!("stark", { id: "style", kind: "preference", updatedAt: new Date("2026-05-01T00:00:00Z"), value: "concise" });
    await store.upsertUserModelSlot!("stark", { id: "style", kind: "preference", updatedAt: new Date("2026-05-02T00:00:00Z"), value: "very concise" });

    const memory = await store.findByUserId("stark");
    expect(memory?.facts).toEqual({ city: "Seoul" }); // slot write doesn't drop facts
    expect(memory?.userModel?.preferences).toHaveLength(1); // replaced, not duplicated
    expect(memory?.userModel?.preferences[0]?.value).toBe("very concise");
  });

  it("deleteByUserId reports true only when a row actually existed", async () => {
    const { db } = createFakeUserMemoriesDb();
    const store = createStore(db);
    await store.upsertFact("stark", "name", "Stark");
    expect(await store.deleteByUserId("stark")).toBe(true);
    expect(await store.deleteByUserId("stark")).toBe(false); // already gone
    expect(await store.findByUserId("stark")).toBeUndefined();
  });

  it("keeps two users' rows independent", async () => {
    const { db } = createFakeUserMemoriesDb();
    const store = createStore(db);
    await store.upsertFact("stark", "name", "Stark");
    await store.upsertFact("rhodes", "name", "Rhodey");
    expect((await store.findByUserId("stark"))?.facts.name).toBe("Stark");
    expect((await store.findByUserId("rhodes"))?.facts.name).toBe("Rhodey");
  });

  it("takes a transaction-scoped user lock before same-user read-modify-write updates", async () => {
    const { db } = createFakeUserMemoriesDb();
    const lockedUsers: string[] = [];
    const store = new KyselyUserMemoryStore(db, {
      acquireUserLock: async (_transaction, userId) => {
        lockedUsers.push(userId);
      }
    });

    await store.upsertFact("stark", "name", "Stark");

    expect(lockedUsers).toEqual(["stark"]);
  });
});

describe("mapUserMemoryRow — malformed/garbage row resilience (never throws, never silently corrupts)", () => {
  const baseRow = { facts: {}, preferences: {}, recent_topics: "", updated_at: new Date("2026-05-01T00:00:00Z"), user_id: "u1" };

  it("parses facts/preferences given as a JSON STRING (a driver that doesn't auto-parse JSONB)", () => {
    const mapped = mapUserMemoryRow({ ...baseRow, facts: '{"city":"Seoul"}', preferences: '{"tone":"concise"}' });
    expect(mapped.facts).toEqual({ city: "Seoul" });
    expect(mapped.preferences).toEqual({ tone: "concise" });
  });

  it("degrades non-object / non-string facts to an empty record instead of throwing", () => {
    expect(mapUserMemoryRow({ ...baseRow, facts: null }).facts).toEqual({});
    expect(mapUserMemoryRow({ ...baseRow, facts: 42 }).facts).toEqual({});
    expect(mapUserMemoryRow({ ...baseRow, facts: ["not", "a", "record"] }).facts).toEqual({});
    expect(mapUserMemoryRow({ ...baseRow, facts: "not json at all {" }).facts).toEqual({});
  });

  it("drops non-string VALUES inside an otherwise-valid facts object", () => {
    const mapped = mapUserMemoryRow({ ...baseRow, facts: { city: "Seoul", bad: 123, alsoBad: null } });
    expect(mapped.facts).toEqual({ city: "Seoul" });
  });

  it("degrades a garbage updated_at to the epoch sentinel rather than an Invalid Date", () => {
    expect(mapUserMemoryRow({ ...baseRow, updated_at: "not-a-date" }).updatedAt.getTime()).toBe(0);
    expect(Number.isNaN(mapUserMemoryRow({ ...baseRow, updated_at: "not-a-date" }).updatedAt.getTime())).toBe(false);
    expect(mapUserMemoryRow({ ...baseRow, updated_at: undefined }).updatedAt.getTime()).toBe(0);
  });

  it("splits recent_topics on newlines and drops blank entries", () => {
    expect(mapUserMemoryRow({ ...baseRow, recent_topics: "a\n\nb\n " }).recentTopics).toEqual(["a", "b"]);
    expect(mapUserMemoryRow({ ...baseRow, recent_topics: 99 }).recentTopics).toEqual([]);
  });

  it("a non-object user_model column yields NO userModel field (array, string, number all rejected)", () => {
    expect(mapUserMemoryRow({ ...baseRow, user_model: [] }).userModel).toBeUndefined();
    expect(mapUserMemoryRow({ ...baseRow, user_model: "garbage" }).userModel).toBeUndefined();
    expect(mapUserMemoryRow({ ...baseRow, user_model: null }).userModel).toBeUndefined();
  });

  it("drops a slot entry missing id/value, an entry with a mismatched kind, and a bad updatedAt — without throwing or dropping its siblings", () => {
    const mapped = mapUserMemoryRow({
      ...baseRow,
      user_model: {
        goals: [],
        preferences: [
          { id: "good", kind: "preference", updatedAt: "2026-05-01T00:00:00.000Z", value: "concise" },
          { id: "no-value", kind: "preference", updatedAt: "2026-05-01T00:00:00.000Z" }, // missing value → dropped
          { kind: "preference", updatedAt: "2026-05-01T00:00:00.000Z", value: "no id" }, // missing id → dropped
          { id: "wrong-kind", kind: "veto", updatedAt: "2026-05-01T00:00:00.000Z", value: "x" }, // lives in wrong bucket → dropped from preferences
          { id: "bad-date", kind: "preference", updatedAt: "not-a-date", value: "x" }, // invalid updatedAt → dropped
          "not an object", // non-object element → dropped
          null
        ],
        schedule: [],
        vetoes: []
      }
    });
    expect(mapped.userModel?.preferences).toHaveLength(1);
    expect(mapped.userModel?.preferences[0]).toMatchObject({ id: "good", value: "concise" });
    expect(mapped.userModel?.vetoes).toHaveLength(0); // the mis-typed "wrong-kind" entry did NOT leak into vetoes either
  });

  it("a user_model whose every slot is malformed collapses to userModel=undefined (legacy shape, not an empty-but-present model)", () => {
    const mapped = mapUserMemoryRow({
      ...baseRow,
      user_model: { goals: [{ bad: true }], preferences: [{ nope: 1 }], schedule: [], vetoes: [] }
    });
    expect(mapped.userModel).toBeUndefined();
  });

  it("kind-specific fields (category/recurrence/scope/dueAt/progress/confidence) survive a JSON round-trip per slot kind", () => {
    const iso = "2026-05-01T00:00:00.000Z";
    const mapped = mapUserMemoryRow(JSON.parse(JSON.stringify({
      ...baseRow,
      user_model: {
        goals: [{ confidence: 0.6, dueAt: iso, id: "g1", kind: "goal", progress: 0.25, updatedAt: iso, value: "ship it" }],
        preferences: [{ category: "style", id: "p1", kind: "preference", updatedAt: iso, value: "concise" }],
        schedule: [{ id: "s1", kind: "schedule", recurrence: "daily 07:00", updatedAt: iso, value: "journal" }],
        vetoes: [{ id: "v1", kind: "veto", scope: "food", updatedAt: iso, value: "no eggs" }]
      }
    })));
    expect(mapped.userModel?.goals[0]).toMatchObject({ confidence: 0.6, progress: 0.25, value: "ship it" });
    expect(mapped.userModel?.goals[0]?.dueAt?.toISOString()).toBe(iso);
    expect(mapped.userModel?.preferences[0]).toMatchObject({ category: "style", value: "concise" });
    expect(mapped.userModel?.schedule[0]).toMatchObject({ recurrence: "daily 07:00", value: "journal" });
    expect(mapped.userModel?.vetoes[0]).toMatchObject({ scope: "food", value: "no eggs" });
  });

  it("a goal's malformed dueAt is dropped but the rest of the slot survives", () => {
    const mapped = mapUserMemoryRow({
      ...baseRow,
      user_model: { goals: [{ dueAt: "not-a-date", id: "g1", kind: "goal", updatedAt: "2026-05-01T00:00:00.000Z", value: "ship it" }], preferences: [], schedule: [], vetoes: [] }
    });
    expect(mapped.userModel?.goals[0]?.dueAt).toBeUndefined();
    expect(mapped.userModel?.goals[0]?.value).toBe("ship it");
  });
});
