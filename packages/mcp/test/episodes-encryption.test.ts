import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  clearEpisodes,
  decryptEpisodesAtRest,
  encryptEpisodesAtRest,
  isEpisodesEncrypted,
  readEpisodes,
  upsertEpisode,
  writeEpisodes,
  type PersistedEpisode
} from "../src/personal-episodes-store.js";

const KEY = { MUSE_MEMORY_KEY: "episodes-test-key-A" } as NodeJS.ProcessEnv;
const WRONG = { MUSE_MEMORY_KEY: "episodes-test-key-B" } as NodeJS.ProcessEnv;

// A dedicated dir, NOT bare tmpdir() — the loop PC's tmpdir holds ~750k entries,
// so a `readdir(tmpdir())` (the quarantine check) takes >1s and blows the timeout.
let dir = "";
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "muse-episodes-enc-")); });
afterAll(async () => { await rm(dir, { force: true, recursive: true }); });
const freshFile = () => join(dir, `episodes-${randomUUID()}.json`);

const episode = (id: string): PersistedEpisode => ({
  endedAt: "2026-06-01T01:00:00Z",
  id,
  startedAt: "2026-06-01T00:00:00Z",
  summary: `recap ${id}`,
  userId: "u"
});

describe("episodes store encryption-at-rest", () => {
  it("round-trips: encrypt then read returns the same episodes, on-disk bytes are an envelope", async () => {
    const file = freshFile();
    await writeEpisodes(file, [episode("a"), episode("b")], KEY);
    expect(await isEpisodesEncrypted(file)).toBe(false);

    const result = await encryptEpisodesAtRest(file, KEY);
    expect(result.alreadyEncrypted).toBe(false);
    expect(await isEpisodesEncrypted(file)).toBe(true);

    const onDisk = JSON.parse(await readFile(file, "utf8")) as { algorithm?: string };
    expect(onDisk.algorithm).toBe("aes-256-gcm");
    expect(await readFile(file, "utf8")).not.toContain("recap a");

    const back = await readEpisodes(file, KEY);
    expect(back.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("preserves the encrypted format on a subsequent write", async () => {
    const file = freshFile();
    await writeEpisodes(file, [episode("a")], KEY);
    await encryptEpisodesAtRest(file, KEY);

    await writeEpisodes(file, [episode("a"), episode("c")], KEY);
    expect(await isEpisodesEncrypted(file)).toBe(true);
    expect((await readEpisodes(file, KEY)).map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("encrypting an absent store seeds an encrypted file so future episodes stay encrypted", async () => {
    const file = freshFile();
    const result = await encryptEpisodesAtRest(file, KEY);
    expect(result.alreadyEncrypted).toBe(false);
    expect(await isEpisodesEncrypted(file)).toBe(true);
    expect(await readEpisodes(file, KEY)).toEqual([]);

    await writeEpisodes(file, [episode("late")], KEY);
    expect(await isEpisodesEncrypted(file)).toBe(true);
    expect((await readEpisodes(file, KEY)).map((e) => e.id)).toEqual(["late"]);
  });

  it("writes a plaintext backup before the first encrypt, holding the original episodes", async () => {
    const file = freshFile();
    await writeEpisodes(file, [episode("keep")], KEY);
    const result = await encryptEpisodesAtRest(file, KEY);
    expect(result.backupPath).toBeDefined();
    const backup = JSON.parse(await readFile(result.backupPath!, "utf8")) as { episodes: { id: string }[] };
    expect(backup.episodes.map((e) => e.id)).toEqual(["keep"]);
  });

  it("is idempotent — encrypting an already-encrypted store does not re-backup or change bytes", async () => {
    const file = freshFile();
    await writeEpisodes(file, [episode("a")], KEY);
    await encryptEpisodesAtRest(file, KEY);
    const before = await readFile(file, "utf8");
    const second = await encryptEpisodesAtRest(file, KEY);
    expect(second.alreadyEncrypted).toBe(true);
    expect(second.backupPath).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("FAILS CLOSED on a wrong key: read throws and the ciphertext is byte-unchanged (never quarantined to empty)", async () => {
    const file = freshFile();
    await writeEpisodes(file, [episode("secret")], KEY);
    await encryptEpisodesAtRest(file, KEY);
    const ciphertext = await readFile(file, "utf8");

    await expect(readEpisodes(file, WRONG)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(ciphertext);
    // No `.corrupt-*` quarantine sibling was created.
    expect(await isEpisodesEncrypted(file)).toBe(true);
    // The right key still reads it — destruction did not happen.
    expect((await readEpisodes(file, KEY)).map((e) => e.id)).toEqual(["secret"]);
  });

  it("a write under a wrong key throws (read-before-write) and cannot bury the ciphertext", async () => {
    const file = freshFile();
    await writeEpisodes(file, [episode("secret")], KEY);
    await encryptEpisodesAtRest(file, KEY);
    const ciphertext = await readFile(file, "utf8");

    await expect(upsertEpisode(file, episode("intruder"), WRONG)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(ciphertext);
    expect((await readEpisodes(file, KEY)).map((e) => e.id)).toEqual(["secret"]);
  });

  it("read NEVER writes: reading an encrypted store leaves mtime and bytes untouched", async () => {
    const file = freshFile();
    await writeEpisodes(file, [episode("a")], KEY);
    await encryptEpisodesAtRest(file, KEY);
    const before = await readFile(file, "utf8");
    const mtimeBefore = (await stat(file)).mtimeMs;

    await readEpisodes(file, KEY);
    await readEpisodes(file, KEY);
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(mtimeBefore);
  });

  it("decrypt reverses the migration to plaintext and stays readable", async () => {
    const file = freshFile();
    await writeEpisodes(file, [episode("a"), episode("b")], KEY);
    await encryptEpisodesAtRest(file, KEY);

    const result = await decryptEpisodesAtRest(file, KEY);
    expect(result.alreadyPlaintext).toBe(false);
    expect(await isEpisodesEncrypted(file)).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8")) as { episodes: unknown[] }).toHaveProperty("episodes");
    expect((await readEpisodes(file, KEY)).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("decrypt under a wrong key fails closed without destroying the ciphertext", async () => {
    const file = freshFile();
    await writeEpisodes(file, [episode("a")], KEY);
    await encryptEpisodesAtRest(file, KEY);
    const ciphertext = await readFile(file, "utf8");

    await expect(decryptEpisodesAtRest(file, WRONG)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(ciphertext);
    expect(await isEpisodesEncrypted(file)).toBe(true);
  });

  it("isEpisodesEncrypted is format-only — needs no key and never throws", async () => {
    const file = freshFile();
    await writeEpisodes(file, [episode("a")], KEY);
    expect(await isEpisodesEncrypted(file)).toBe(false);
    await encryptEpisodesAtRest(file, KEY);
    // Query with NO key at all — the status signal must not depend on decrypt.
    const noKey = {} as NodeJS.ProcessEnv;
    expect(await isEpisodesEncrypted(file)).toBe(true);
    await expect(readEpisodes(file, noKey)).rejects.toThrow();
  });

  it("a corrupt PLAINTEXT store still quarantines (encryption did not break the corrupt path)", async () => {
    const file = freshFile();
    await writeFile(file, "{ this is not json", "utf8");
    expect(await readEpisodes(file, KEY)).toEqual([]);
    // The corrupt bytes are renamed aside to `<file>.corrupt-*`, not left in place.
    await expect(stat(file)).rejects.toThrow();
    const siblings = await readdir(dirname(file));
    const quarantined = siblings.filter((n) => n.startsWith(`${basename(file)}.corrupt-`));
    expect(quarantined.length).toBe(1);
  });

  it("steals a STALE lock so a crashed holder cannot block writes forever", async () => {
    const file = freshFile();
    await writeEpisodes(file, [episode("a")], KEY);
    const lockPath = `${file}.lock`;
    await writeFile(lockPath, "", "utf8");
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);

    // The stale lock is older than LOCK_STALE_MS (30s) → stolen, the write proceeds.
    await writeEpisodes(file, [episode("a"), episode("b")], KEY);
    expect((await readEpisodes(file, KEY)).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("keeps every concurrently-upserted episode on an ENCRYPTED store (lock + queue hold)", async () => {
    const file = freshFile();
    const prior = process.env.MUSE_MEMORY_KEY;
    process.env.MUSE_MEMORY_KEY = KEY.MUSE_MEMORY_KEY;
    try {
      await encryptEpisodesAtRest(file, KEY);
      await Promise.all(Array.from({ length: 20 }, (_unused, i) => upsertEpisode(file, episode(`ep${i.toString()}`))));
      expect(await isEpisodesEncrypted(file)).toBe(true);
      const all = await readEpisodes(file, KEY);
      expect(all).toHaveLength(20);
      expect(new Set(all.map((e) => e.id)).size).toBe(20);
    } finally {
      if (prior === undefined) delete process.env.MUSE_MEMORY_KEY;
      else process.env.MUSE_MEMORY_KEY = prior;
    }
  }, 30_000);

  it("clearEpisodes preserves the encrypted format", async () => {
    const file = freshFile();
    await writeEpisodes(file, [episode("a"), episode("b")], KEY);
    await encryptEpisodesAtRest(file, KEY);
    await clearEpisodes(file, KEY);
    expect(await isEpisodesEncrypted(file)).toBe(true);
    expect(await readEpisodes(file, KEY)).toEqual([]);
  });
});
