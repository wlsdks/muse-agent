import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adjustPlaybookReward,
  decryptPlaybookAtRest,
  encryptPlaybookAtRest,
  isPlaybookEncrypted,
  queryPlaybook,
  readPlaybook,
  recordPlaybookStrategy,
  type PlaybookEntry
} from "../src/personal-playbook-store.js";

const KEY = { MUSE_MEMORY_KEY: "playbook-test-key-A" } as NodeJS.ProcessEnv;
const WRONG = { MUSE_MEMORY_KEY: "playbook-test-key-B" } as NodeJS.ProcessEnv;

let dir = "";
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "muse-playbook-enc-")); });
afterAll(async () => { await rm(dir, { force: true, recursive: true }); });
const freshFile = (): string => join(dir, `playbook-${randomUUID()}.json`);

const strat = (id: string, text: string, over: Partial<PlaybookEntry> = {}): PlaybookEntry => ({
  createdAt: "2026-06-01T00:00:00Z", id, reward: 2, text, userId: "u", ...over
});

describe("playbook (learned dossier) encryption-at-rest", () => {
  it("round-trips: encrypt then read returns the same strategies, on-disk bytes are an AES envelope", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, strat("s1", "Answer concisely, no preamble."), KEY);
    await recordPlaybookStrategy(file, strat("s2", "Always cite the source note."), KEY);
    expect(await isPlaybookEncrypted(file)).toBe(false);

    const result = await encryptPlaybookAtRest(file, KEY);
    expect(result.alreadyEncrypted).toBe(false);
    expect(await isPlaybookEncrypted(file)).toBe(true);

    const onDisk = JSON.parse(await readFile(file, "utf8")) as { algorithm?: string };
    expect(onDisk.algorithm).toBe("aes-256-gcm");
    expect(await readFile(file, "utf8")).not.toContain("Answer concisely"); // the learned strategy is not on disk in cleartext

    expect((await readPlaybook(file, KEY)).map((e) => e.id).sort()).toEqual(["s1", "s2"]);
  });

  it("a record on an encrypted store stays encrypted and the new strategy is readable", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, strat("s1", "Be concise."), KEY);
    await encryptPlaybookAtRest(file, KEY);

    await recordPlaybookStrategy(file, strat("s3", "Use metric units."), KEY);
    expect(await isPlaybookEncrypted(file)).toBe(true);
    expect((await readPlaybook(file, KEY)).map((e) => e.id).sort()).toEqual(["s1", "s3"]);
  });

  it("the RL reward update (adjustPlaybookReward — the daemon's decay/reinforce) works THROUGH encryption", async () => {
    const file = freshFile();
    const prior = process.env.MUSE_MEMORY_KEY;
    process.env.MUSE_MEMORY_KEY = KEY.MUSE_MEMORY_KEY;
    try {
      await recordPlaybookStrategy(file, strat("s1", "Give long detailed answers.", { reward: 3, probation: false }), KEY);
      await encryptPlaybookAtRest(file, KEY);
      // The P43-1 autonomous correction-decay drops a contradicted strategy via
      // adjustPlaybookReward — it must still mutate the bank when encrypted.
      const newReward = await adjustPlaybookReward(file, "s1", -7); // → clamps to the floor
      expect(newReward).toBe(-4);
      expect(await isPlaybookEncrypted(file)).toBe(true); // format preserved across the mutation
      expect((await readPlaybook(file, KEY))[0]!.reward).toBe(-4);
    } finally {
      if (prior === undefined) delete process.env.MUSE_MEMORY_KEY;
      else process.env.MUSE_MEMORY_KEY = prior;
    }
  });

  it("encrypting an absent store seeds an encrypted file so future records stay encrypted", async () => {
    const file = freshFile();
    const result = await encryptPlaybookAtRest(file, KEY);
    expect(result.alreadyEncrypted).toBe(false);
    expect(await isPlaybookEncrypted(file)).toBe(true);
    expect(await readPlaybook(file, KEY)).toEqual([]);

    await recordPlaybookStrategy(file, strat("late", "Late lesson."), KEY);
    expect(await isPlaybookEncrypted(file)).toBe(true);
    expect((await readPlaybook(file, KEY)).map((e) => e.id)).toEqual(["late"]);
  });

  it("writes a plaintext backup before the first encrypt, holding the original strategies", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, strat("keep", "Keep this lesson."), KEY);
    const result = await encryptPlaybookAtRest(file, KEY);
    expect(result.backupPath).toBeDefined();
    const backup = JSON.parse(await readFile(result.backupPath!, "utf8")) as { entries: { id: string }[] };
    expect(backup.entries.map((e) => e.id)).toEqual(["keep"]);
  });

  it("is idempotent — encrypting an already-encrypted store does not re-backup or change bytes", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, strat("s1", "x"), KEY);
    await encryptPlaybookAtRest(file, KEY);
    const before = await readFile(file, "utf8");
    const second = await encryptPlaybookAtRest(file, KEY);
    expect(second.alreadyEncrypted).toBe(true);
    expect(second.backupPath).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("FAILS CLOSED on a wrong key: read throws and the ciphertext is byte-unchanged (never quarantined to empty)", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, strat("secret", "A secret learned preference."), KEY);
    await encryptPlaybookAtRest(file, KEY);
    const ciphertext = await readFile(file, "utf8");

    await expect(readPlaybook(file, WRONG)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(ciphertext);
    expect(await isPlaybookEncrypted(file)).toBe(true);
    expect((await readPlaybook(file, KEY)).map((e) => e.id)).toEqual(["secret"]);
  });

  it("a record under a wrong key throws (read-before-write) and cannot bury the ciphertext", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, strat("secret", "secret"), KEY);
    await encryptPlaybookAtRest(file, KEY);
    const ciphertext = await readFile(file, "utf8");

    await expect(recordPlaybookStrategy(file, strat("intruder", "intruder"), WRONG)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(ciphertext);
    expect((await readPlaybook(file, KEY)).map((e) => e.id)).toEqual(["secret"]);
  });

  it("read NEVER writes: reading an encrypted store leaves mtime and bytes untouched", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, strat("s1", "x"), KEY);
    await encryptPlaybookAtRest(file, KEY);
    const before = await readFile(file, "utf8");
    const mtimeBefore = (await stat(file)).mtimeMs;

    await readPlaybook(file, KEY);
    await readPlaybook(file, KEY);
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(mtimeBefore);
  });

  it("decrypt reverses the migration to plaintext and stays readable", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, strat("s1", "a"), KEY);
    await recordPlaybookStrategy(file, strat("s2", "b"), KEY);
    await encryptPlaybookAtRest(file, KEY);

    const result = await decryptPlaybookAtRest(file, KEY);
    expect(result.alreadyPlaintext).toBe(false);
    expect(await isPlaybookEncrypted(file)).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8")) as { entries: unknown[] }).toHaveProperty("entries");
    expect((await queryPlaybook(file, "u", KEY)).map((e) => e.id).sort()).toEqual(["s1", "s2"]);
  });

  it("decrypt under a wrong key fails closed without destroying the ciphertext", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, strat("s1", "a"), KEY);
    await encryptPlaybookAtRest(file, KEY);
    const ciphertext = await readFile(file, "utf8");

    await expect(decryptPlaybookAtRest(file, WRONG)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(ciphertext);
    expect(await isPlaybookEncrypted(file)).toBe(true);
  });

  it("isPlaybookEncrypted is format-only — needs no key and never throws", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, strat("s1", "a"), KEY);
    expect(await isPlaybookEncrypted(file)).toBe(false);
    await encryptPlaybookAtRest(file, KEY);
    expect(await isPlaybookEncrypted(file)).toBe(true);
    await expect(readPlaybook(file, {} as NodeJS.ProcessEnv)).rejects.toThrow();
  });

  it("a corrupt PLAINTEXT store still quarantines (encryption did not break the corrupt path)", async () => {
    const file = freshFile();
    await writeFile(file, "{ this is not json", "utf8");
    expect(await readPlaybook(file, KEY)).toEqual([]);
    await expect(stat(file)).rejects.toThrow();
    const siblings = await readdir(dirname(file));
    expect(siblings.filter((n) => n.startsWith(`${basename(file)}.corrupt-`)).length).toBe(1);
  });

  it("keeps every concurrently-recorded strategy on an ENCRYPTED store (lock + queue hold)", async () => {
    const file = freshFile();
    await encryptPlaybookAtRest(file, KEY);
    await Promise.all(Array.from({ length: 12 }, (_unused, i) => recordPlaybookStrategy(file, strat(`s${i.toString()}`, `lesson ${i.toString()}`), KEY)));
    expect(await isPlaybookEncrypted(file)).toBe(true);
    const all = await readPlaybook(file, KEY);
    expect(all).toHaveLength(12);
    expect(new Set(all.map((e) => e.id)).size).toBe(12);
  }, 30_000);
});
