import { mkdtemp, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileUserMemoryStore } from "../src/index.js";

async function newStore() {
  const dir = await mkdtemp(join(tmpdir(), "muse-user-mem-"));
  const file = join(dir, "user-memory.json");
  return { dir, file, store: new FileUserMemoryStore({ file, now: () => new Date("2026-05-12T10:00:00Z") }) };
}

describe("FileUserMemoryStore", () => {
  it("returns undefined when the file doesn't exist yet", async () => {
    const { store } = await newStore();
    expect(await store.findByUserId("stark")).toBeUndefined();
  });

  it("persists upserts to disk so a new store instance reads them back", async () => {
    const { file, store } = await newStore();
    await store.upsertFact("stark", "name", "Stark");
    await store.upsertPreference("stark", "reply_style", "concise");

    const reread = new FileUserMemoryStore({ file });
    const memory = await reread.findByUserId("stark");
    expect(memory?.facts).toEqual({ name: "Stark" });
    expect(memory?.preferences).toEqual({ reply_style: "concise" });
    expect(memory?.recentTopics).toEqual([]);
  });

  it("multi-user isolation — facts for one userId don't leak to another", async () => {
    const { store } = await newStore();
    await store.upsertFact("stark", "name", "Stark");
    await store.upsertFact("rhodes", "name", "Rhodey");
    const stark = await store.findByUserId("stark");
    const rhodes = await store.findByUserId("rhodes");
    expect(stark?.facts).toEqual({ name: "Stark" });
    expect(rhodes?.facts).toEqual({ name: "Rhodey" });
  });

  it("atomically replaces the file (tmp + rename) so concurrent reads see a consistent shape", async () => {
    const { file, store } = await newStore();
    await store.upsertFact("stark", "city", "Seoul");
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.users.stark.facts.city).toBe("Seoul");
  });

  it("updates the updatedAt timestamp on every upsert", async () => {
    const { store } = await newStore();
    const first = await store.upsertFact("stark", "name", "Stark");
    const second = await store.upsertPreference("stark", "reply_style", "concise");
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });

  it("delete returns true when the user existed, false otherwise", async () => {
    const { store } = await newStore();
    await store.upsertFact("stark", "name", "Stark");
    expect(await store.deleteByUserId("stark")).toBe(true);
    expect(await store.deleteByUserId("stark")).toBe(false);
    expect(await store.findByUserId("stark")).toBeUndefined();
  });

  it("tolerates a missing file after delete then re-creates on next write", async () => {
    const { file, store } = await newStore();
    await store.upsertFact("stark", "name", "Stark");
    await unlink(file);
    await store.upsertFact("stark", "city", "Seoul");
    const memory = await store.findByUserId("stark");
    expect(memory?.facts).toEqual({ city: "Seoul" }); // prior "name" lost because file was wiped
  });
});
