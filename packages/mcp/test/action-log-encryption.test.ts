import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendActionLog,
  decryptActionLogAtRest,
  encryptActionLogAtRest,
  isActionLogEncrypted,
  readActionLog,
  verifyActionLogChainFile,
  type ActionLogEntry
} from "../src/personal-action-log-store.js";

const KEY = { MUSE_MEMORY_KEY: "action-log-test-key-A" } as NodeJS.ProcessEnv;
const WRONG = { MUSE_MEMORY_KEY: "action-log-test-key-B" } as NodeJS.ProcessEnv;

// A dedicated dir, NOT bare tmpdir() — the loop PC's tmpdir holds ~750k entries,
// so a `readdir(tmpdir())` (the quarantine check) takes >1s and blows the timeout.
let dir = "";
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "muse-actlog-enc-")); });
afterAll(async () => { await rm(dir, { force: true, recursive: true }); });
const freshFile = (): string => join(dir, `action-log-${randomUUID()}.json`);

const entry = (id: string): ActionLogEntry => ({
  id,
  result: "performed",
  userId: "u",
  what: `did thing ${id}`,
  when: "2026-06-04T00:00:00Z",
  why: "objective"
});

describe("action log encryption-at-rest", () => {
  it("round-trips: encrypt then read returns the same entries, on-disk bytes are an AES envelope", async () => {
    const file = freshFile();
    await appendActionLog(file, entry("a"), KEY);
    await appendActionLog(file, entry("b"), KEY);
    expect(await isActionLogEncrypted(file)).toBe(false);

    const result = await encryptActionLogAtRest(file, KEY);
    expect(result.alreadyEncrypted).toBe(false);
    expect(await isActionLogEncrypted(file)).toBe(true);

    const onDisk = JSON.parse(await readFile(file, "utf8")) as { algorithm?: string };
    expect(onDisk.algorithm).toBe("aes-256-gcm");
    expect(await readFile(file, "utf8")).not.toContain("did thing a"); // the action text is not on disk in cleartext

    expect((await readActionLog(file, KEY)).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("an append on an encrypted store stays encrypted and the new entry is readable", async () => {
    const file = freshFile();
    await appendActionLog(file, entry("a"), KEY);
    await encryptActionLogAtRest(file, KEY);

    await appendActionLog(file, entry("c"), KEY);
    expect(await isActionLogEncrypted(file)).toBe(true);
    expect((await readActionLog(file, KEY)).map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("encrypting an absent store seeds an encrypted file so future appends stay encrypted", async () => {
    const file = freshFile();
    const result = await encryptActionLogAtRest(file, KEY);
    expect(result.alreadyEncrypted).toBe(false);
    expect(await isActionLogEncrypted(file)).toBe(true);
    expect(await readActionLog(file, KEY)).toEqual([]);

    await appendActionLog(file, entry("late"), KEY);
    expect(await isActionLogEncrypted(file)).toBe(true);
    expect((await readActionLog(file, KEY)).map((e) => e.id)).toEqual(["late"]);
  });

  it("writes a plaintext backup before the first encrypt, holding the original entries", async () => {
    const file = freshFile();
    await appendActionLog(file, entry("keep"), KEY);
    const result = await encryptActionLogAtRest(file, KEY);
    expect(result.backupPath).toBeDefined();
    const backup = JSON.parse(await readFile(result.backupPath!, "utf8")) as { entries: { id: string }[] };
    expect(backup.entries.map((e) => e.id)).toEqual(["keep"]);
  });

  it("is idempotent — encrypting an already-encrypted store does not re-backup or change bytes", async () => {
    const file = freshFile();
    await appendActionLog(file, entry("a"), KEY);
    await encryptActionLogAtRest(file, KEY);
    const before = await readFile(file, "utf8");
    const second = await encryptActionLogAtRest(file, KEY);
    expect(second.alreadyEncrypted).toBe(true);
    expect(second.backupPath).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("FAILS CLOSED on a wrong key: read throws and the ciphertext is byte-unchanged (never quarantined to empty)", async () => {
    const file = freshFile();
    await appendActionLog(file, entry("secret"), KEY);
    await encryptActionLogAtRest(file, KEY);
    const ciphertext = await readFile(file, "utf8");

    await expect(readActionLog(file, WRONG)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(ciphertext);
    expect(await isActionLogEncrypted(file)).toBe(true); // no `.corrupt-*` quarantine happened
    expect((await readActionLog(file, KEY)).map((e) => e.id)).toEqual(["secret"]); // the right key still reads it
  });

  it("an append under a wrong key throws (read-before-write seals the chain) and cannot bury the ciphertext", async () => {
    const file = freshFile();
    await appendActionLog(file, entry("secret"), KEY);
    await encryptActionLogAtRest(file, KEY);
    const ciphertext = await readFile(file, "utf8");

    await expect(appendActionLog(file, entry("intruder"), WRONG)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(ciphertext);
    expect((await readActionLog(file, KEY)).map((e) => e.id)).toEqual(["secret"]);
  });

  it("read NEVER writes: reading an encrypted store leaves mtime and bytes untouched", async () => {
    const file = freshFile();
    await appendActionLog(file, entry("a"), KEY);
    await encryptActionLogAtRest(file, KEY);
    const before = await readFile(file, "utf8");
    const mtimeBefore = (await stat(file)).mtimeMs;

    await readActionLog(file, KEY);
    await readActionLog(file, KEY);
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(mtimeBefore);
  });

  it("the tamper-evident hash chain still VERIFIES through an encryption round-trip (encryption is orthogonal to the chain)", async () => {
    const file = freshFile();
    await appendActionLog(file, entry("a"), KEY);
    await appendActionLog(file, entry("b"), KEY);
    await appendActionLog(file, entry("c"), KEY);
    const beforeEncrypt = await verifyActionLogChainFile(file, KEY);
    expect(beforeEncrypt.ok).toBe(true);

    await encryptActionLogAtRest(file, KEY);
    const afterEncrypt = await verifyActionLogChainFile(file, KEY);
    expect(afterEncrypt.ok).toBe(true); // the chain (over plaintext entries) survives encryption at rest

    // A later append on the encrypted store keeps the chain intact (the new tip is sealed to the decrypted history).
    await appendActionLog(file, entry("d"), KEY);
    expect((await verifyActionLogChainFile(file, KEY)).ok).toBe(true);
    expect((await readActionLog(file, KEY)).map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("decrypt reverses the migration to plaintext and stays readable + chain-valid", async () => {
    const file = freshFile();
    await appendActionLog(file, entry("a"), KEY);
    await appendActionLog(file, entry("b"), KEY);
    await encryptActionLogAtRest(file, KEY);

    const result = await decryptActionLogAtRest(file, KEY);
    expect(result.alreadyPlaintext).toBe(false);
    expect(await isActionLogEncrypted(file)).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8")) as { entries: unknown[] }).toHaveProperty("entries");
    expect((await readActionLog(file, KEY)).map((e) => e.id)).toEqual(["a", "b"]);
    expect((await verifyActionLogChainFile(file, KEY)).ok).toBe(true);
  });

  it("decrypt under a wrong key fails closed without destroying the ciphertext", async () => {
    const file = freshFile();
    await appendActionLog(file, entry("a"), KEY);
    await encryptActionLogAtRest(file, KEY);
    const ciphertext = await readFile(file, "utf8");

    await expect(decryptActionLogAtRest(file, WRONG)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(ciphertext);
    expect(await isActionLogEncrypted(file)).toBe(true);
  });

  it("isActionLogEncrypted is format-only — needs no key and never throws", async () => {
    const file = freshFile();
    await appendActionLog(file, entry("a"), KEY);
    expect(await isActionLogEncrypted(file)).toBe(false);
    await encryptActionLogAtRest(file, KEY);
    expect(await isActionLogEncrypted(file)).toBe(true);
    await expect(readActionLog(file, {} as NodeJS.ProcessEnv)).rejects.toThrow(); // no key → read throws, status did not
  });

  it("a corrupt PLAINTEXT store still quarantines (encryption did not break the corrupt path)", async () => {
    const file = freshFile();
    await writeFile(file, "{ this is not json", "utf8");
    expect(await readActionLog(file, KEY)).toEqual([]);
    await expect(stat(file)).rejects.toThrow(); // renamed aside, not left in place
    const siblings = await readdir(dirname(file));
    expect(siblings.filter((n) => n.startsWith(`${basename(file)}.corrupt-`)).length).toBe(1);
  });

  it("keeps every concurrently-appended entry on an ENCRYPTED store (lock + queue hold)", async () => {
    const file = freshFile();
    await encryptActionLogAtRest(file, KEY);
    await Promise.all(Array.from({ length: 15 }, (_unused, i) => appendActionLog(file, entry(`e${i.toString()}`), KEY)));
    expect(await isActionLogEncrypted(file)).toBe(true);
    const all = await readActionLog(file, KEY);
    expect(all).toHaveLength(15);
    expect(new Set(all.map((e) => e.id)).size).toBe(15);
    expect((await verifyActionLogChainFile(file, KEY)).ok).toBe(true); // no forked chain
  }, 30_000);
});
