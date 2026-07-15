import { mkdir, mkdtemp, open, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileUserMemoryStore } from "../src/index.js";

/**
 * The existing suite (test/memory-user-store-file.test.ts) covers the STALE
 * lock steal path. It does NOT cover what happens when another process holds
 * a genuinely LIVE lock (fresh mtime) for the whole retry window — the
 * fail-closed "give up" throw — nor a typed-slot write's interaction with the
 * legacy-'default'-bucket migration (only upsertFact/upsertPreference were
 * exercised against that migration). Both are real gaps in a data-loss-
 * critical path.
 */

async function newStore() {
  const dir = await mkdtemp(join(tmpdir(), "muse-user-mem-lock-"));
  const file = join(dir, "user-memory.json");
  return { dir, file, store: new FileUserMemoryStore({ file, now: () => new Date("2026-05-12T10:00:00Z") }) };
}

describe("FileUserMemoryStore — live cross-process lock contention (fail-closed)", () => {
  it("throws 'locked by another write in progress' when a LIVE (fresh) lock never releases, and never touches the file", async () => {
    const { file, store } = await newStore();
    await store.upsertFact("stark", "name", "Stark"); // seed real content
    const before = await readFile(file, "utf8");

    await mkdir(join(file, ".."), { recursive: true });
    const lockPath = `${file}.lock`;
    const handle = await open(lockPath, "wx"); // simulate a live concurrent writer holding the lock

    await expect(store.upsertFact("stark", "city", "Seoul")).rejects.toThrow(/locked by another write in progress/u);

    // fail-closed: the underlying file is untouched while the lock is held
    expect(await readFile(file, "utf8")).toBe(before);

    await handle.close();
    await unlink(lockPath).catch(() => undefined);

    // the lock release lets the NEXT write through normally
    await store.upsertFact("stark", "city", "Seoul");
    expect((await store.findByUserId("stark"))?.facts.city).toBe("Seoul");
  }, 8_000);
});

describe("FileUserMemoryStore — typed-slot writes interact correctly with legacy-bucket migration and empty baselines", () => {
  it("upsertUserModelSlot migrates the orphaned 'default' bucket exactly like upsertFact does", async () => {
    const { file, store } = await newStore();
    await writeFile(file, JSON.stringify({
      version: 1,
      users: { default: { facts: { dentist: "Dr. Kim" }, preferences: {}, recentTopics: [], updatedAt: "2026-05-01T00:00:00.000Z", userId: "default" } }
    }), "utf8");

    await store.upsertUserModelSlot("stark", { id: "style", kind: "preference", updatedAt: new Date("2026-05-12T10:00:00Z"), value: "concise" });

    const raw = JSON.parse(await readFile(file, "utf8")) as { users: Record<string, { facts?: Record<string, string> }> };
    expect(raw.users.default).toBeUndefined(); // migrated away
    expect(raw.users.stark.facts?.dentist).toBe("Dr. Kim"); // legacy facts carried over
    const memory = await store.findByUserId("stark");
    expect(memory?.userModel?.preferences[0]?.value).toBe("concise");
  });

  it("removeUserModelSlot as the FIRST write ever for a user is a safe no-op (creates an empty baseline, never throws)", async () => {
    const { store } = await newStore();
    await expect(store.removeUserModelSlot("brand-new-user", "nonexistent")).resolves.not.toThrow();
    const memory = await store.findByUserId("brand-new-user");
    expect(memory?.userModel?.preferences ?? []).toEqual([]);
    expect(memory?.facts).toEqual({});
  });
});

describe("FileUserMemoryStore — isEncryptedAtRest edge cases", () => {
  it("reports false for a missing file and for a corrupt (non-JSON) file, without throwing", async () => {
    const { store } = await newStore();
    expect(await store.isEncryptedAtRest()).toBe(false); // file doesn't exist yet

    const { file, store: store2 } = await newStore();
    await writeFile(file, "{not json", "utf8");
    expect(await store2.isEncryptedAtRest()).toBe(false);
  });
});
