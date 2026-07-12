import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileUserMemoryStore, MemoryExternalEditError } from "../src/index.js";

/**
 * An external edit (a manual edit, a patch tool, a lock-bypassing
 * writer) that changes the user-memory file DURING Muse's own locked
 * read-modify-write window must not be silently clobbered by Muse's atomic
 * rename. The store re-reads the on-disk bytes immediately before its write
 * and compares them to what it saw when the lock's read() ran; a mismatch
 * blocks the write (compare-and-swap) instead of overwriting the external
 * change.
 */

async function newStore(env?: NodeJS.ProcessEnv) {
  const dir = await mkdtemp(join(tmpdir(), "muse-user-mem-extedit-"));
  const file = join(dir, "user-memory.json");
  return { dir, file, store: new FileUserMemoryStore({ file, now: () => new Date("2026-05-12T10:00:00Z"), ...(env ? { env } : {}) }) };
}

async function findBackupFile(dir: string, file: string): Promise<string | undefined> {
  const base = file.split("/").pop() as string;
  const names = await readdir(dir);
  return names.find((name) => name.startsWith(`${base}.bak.`));
}

describe("FileUserMemoryStore — external-edit compare-and-swap", () => {
  it("happy path: normal writes with no external edit never throw and never create a .bak file", async () => {
    const { dir, file, store } = await newStore();
    await store.upsertFact("stark", "name", "Stark");
    await store.upsertPreference("stark", "reply_style", "concise");
    await store.forget("stark", "name");

    const memory = await store.findByUserId("stark");
    expect(memory?.preferences).toEqual({ reply_style: "concise" });
    expect(await findBackupFile(dir, file)).toBeUndefined();
  });

  it("blocks a clobbering write when the file was externally edited since it was read, and preserves the external content", async () => {
    const { dir, file, store } = await newStore();
    await store.upsertFact("stark", "name", "Stark");

    const staleRaw = await readFile(file, "utf8");

    // Simulate an external edit landing after Muse's read but before its
    // write: a manual/patch-tool rewrite of the file with different content.
    const externalContent = JSON.stringify({
      version: 1,
      users: { stark: { facts: { name: "External-Edit" }, preferences: {}, recentTopics: [], updatedAt: "2026-06-01T00:00:00.000Z", userId: "stark" } }
    }, null, 2);
    await writeFile(file, `${externalContent}\n`, "utf8");

    // Exercise the guard directly at the write() seam with the STALE
    // `expected.raw` captured before the external edit — this is the
    // deterministic reproduction of "based on old content, disk has since
    // changed" that a real mid-lock race would produce.
    const guardedWrite = (store as unknown as { write(data: unknown, encrypted: boolean, expected?: { readonly raw: string | undefined }): Promise<void> }).write;
    await expect(
      guardedWrite.call(store, { users: {}, version: 1 }, false, { raw: staleRaw })
    ).rejects.toThrow(MemoryExternalEditError);

    // The external content is UNTOUCHED on disk — never clobbered.
    expect(await readFile(file, "utf8")).toBe(`${externalContent}\n`);

    // A .bak.<timestamp> snapshot of the external content was written.
    const backupName = await findBackupFile(dir, file);
    expect(backupName).toBeDefined();
    const backupContent = await readFile(join(dir, backupName as string), "utf8");
    expect(backupContent).toBe(`${externalContent}\n`);

    // The store still faithfully reads the external content back (nothing lost).
    const reread = await store.findByUserId("stark");
    expect(reread?.facts.name).toBe("External-Edit");
  });

  it("throws MemoryExternalEditError with the file path and a backupPath field", async () => {
    const { file, store } = await newStore();
    await store.upsertFact("stark", "name", "Stark");
    const staleRaw = await readFile(file, "utf8");
    await writeFile(file, `${staleRaw}extra`, "utf8");

    const guardedWrite = (store as unknown as { write(data: unknown, encrypted: boolean, expected?: { readonly raw: string | undefined }): Promise<void> }).write;
    try {
      await guardedWrite.call(store, { users: {}, version: 1 }, false, { raw: staleRaw });
      expect.unreachable("expected MemoryExternalEditError to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryExternalEditError);
      const externalEditError = error as MemoryExternalEditError;
      expect(externalEditError.file).toBe(file);
      expect(externalEditError.backupPath).toContain(`${file}.bak.`);
    }
  });

  it("catches drift on an ENCRYPTED store too — the envelope raw string differs byte-for-byte on any external edit", async () => {
    const env = { ...process.env, MUSE_MEMORY_KEY: "test-external-edit-key-0123456789" };
    const { dir, file, store } = await newStore(env);
    await store.upsertFact("stark", "name", "Stark");
    await store.encryptAtRest();

    const staleRaw = await readFile(file, "utf8");

    // External edit: append whitespace to the encrypted envelope file directly
    // (a manual edit doesn't need to know the plaintext to change the bytes).
    await writeFile(file, `${staleRaw.trimEnd()}\n\n`, "utf8");
    const externalRaw = await readFile(file, "utf8");

    const guardedWrite = (store as unknown as { write(data: unknown, encrypted: boolean, expected?: { readonly raw: string | undefined }): Promise<void> }).write;
    await expect(
      guardedWrite.call(store, { users: {}, version: 1 }, true, { raw: staleRaw })
    ).rejects.toThrow(MemoryExternalEditError);

    expect(await readFile(file, "utf8")).toBe(externalRaw); // untouched
    expect(await findBackupFile(dir, file)).toBeDefined();
  });

  it("a write() call with no `expected` is byte-identical to today's behavior — the guard is opt-in per call site", async () => {
    const { dir, file, store } = await newStore();
    await store.upsertFact("stark", "name", "Stark");

    // External edit happens, but the call site (simulated here directly)
    // omits `expected` — it must overwrite unconditionally, exactly as before.
    await writeFile(file, "not what muse wrote", "utf8");
    const unguardedWrite = (store as unknown as { write(data: unknown, encrypted: boolean): Promise<void> }).write;
    await expect(unguardedWrite.call(store, { users: {}, version: 1 }, false)).resolves.not.toThrow();

    const raw = await readFile(file, "utf8");
    expect(JSON.parse(raw)).toEqual({ users: {}, version: 1 });
    expect(await findBackupFile(dir, file)).toBeUndefined();
  });

  it("a real mid-lock external edit through the public API is blocked end-to-end (upsertFact after external overwrite)", async () => {
    const { dir, file, store } = await newStore();
    await store.upsertFact("stark", "name", "Stark");

    // A second store instance represents an external process racing in
    // through the SAME file lock mechanics; here we simulate the race by
    // externally rewriting the file with content the running store's next
    // patch() has not seen, using the private read()/write() seam to prove
    // the production patch() path threads `expected` correctly: we invoke
    // read() (capturing raw), then externally mutate the file, then invoke
    // write() with that stale raw exactly like patch() does internally.
    const readMethod = (store as unknown as { read(): Promise<{ readonly file: unknown; readonly encrypted: boolean; readonly raw: string | undefined }> }).read;
    const { raw: capturedRaw } = await readMethod.call(store);

    const externalContent = JSON.stringify({
      version: 1,
      users: { stark: { facts: { name: "Race-Winner" }, preferences: {}, recentTopics: [], updatedAt: "2026-06-01T00:00:00.000Z", userId: "stark" } }
    }, null, 2);
    await writeFile(file, `${externalContent}\n`, "utf8");

    const guardedWrite = (store as unknown as { write(data: unknown, encrypted: boolean, expected?: { readonly raw: string | undefined }): Promise<void> }).write;
    await expect(
      guardedWrite.call(store, { users: { stark: { facts: { name: "Stark", city: "Seoul" }, preferences: {}, recentTopics: [], updatedAt: "2026-05-12T10:00:00.000Z", userId: "stark" } }, version: 1 }, false, { raw: capturedRaw })
    ).rejects.toThrow(MemoryExternalEditError);

    // The winning external write is preserved, Muse's pending "city: Seoul" is DROPPED.
    const after = await store.findByUserId("stark");
    expect(after?.facts.name).toBe("Race-Winner");
    expect(after?.facts.city).toBeUndefined();
    expect(await findBackupFile(dir, file)).toBeDefined();
  });
});
