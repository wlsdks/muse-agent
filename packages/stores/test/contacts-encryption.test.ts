import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addContact,
  decryptContactsAtRest,
  encryptContactsAtRest,
  isContactsEncrypted,
  queryContacts,
  readContacts,
  resolveContact,
  type Contact
} from "../src/personal-contacts-store.js";

const KEY = { MUSE_MEMORY_KEY: "contacts-test-key-A" } as NodeJS.ProcessEnv;
const WRONG = { MUSE_MEMORY_KEY: "contacts-test-key-B" } as NodeJS.ProcessEnv;

let dir = "";
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "muse-contacts-enc-")); });
afterAll(async () => { await rm(dir, { force: true, recursive: true }); });
const freshFile = (): string => join(dir, `contacts-${randomUUID()}.json`);

const contact = (id: string, name: string, email?: string): Contact => ({ id, name, ...(email ? { email } : {}) });

describe("contacts (people graph) encryption-at-rest", () => {
  it("round-trips: encrypt then read returns the same contacts, on-disk bytes are an AES envelope", async () => {
    const file = freshFile();
    await addContact(file, contact("c1", "Dana Wu", "dana@example.com"), KEY);
    await addContact(file, contact("c2", "Sam Lee"), KEY);
    expect(await isContactsEncrypted(file)).toBe(false);

    const result = await encryptContactsAtRest(file, KEY);
    expect(result.alreadyEncrypted).toBe(false);
    expect(await isContactsEncrypted(file)).toBe(true);

    const onDisk = JSON.parse(await readFile(file, "utf8")) as { algorithm?: string };
    expect(onDisk.algorithm).toBe("aes-256-gcm");
    expect(await readFile(file, "utf8")).not.toContain("Dana Wu"); // the name is not on disk in cleartext
    expect(await readFile(file, "utf8")).not.toContain("dana@example.com");

    expect((await readContacts(file, KEY)).map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("an add on an encrypted store stays encrypted and the new contact is readable", async () => {
    const file = freshFile();
    await addContact(file, contact("c1", "Dana Wu"), KEY);
    await encryptContactsAtRest(file, KEY);

    await addContact(file, contact("c3", "Pat Kim"), KEY);
    expect(await isContactsEncrypted(file)).toBe(true);
    expect((await readContacts(file, KEY)).map((c) => c.id).sort()).toEqual(["c1", "c3"]);
  });

  it("encrypting an absent store seeds an encrypted file so future adds stay encrypted", async () => {
    const file = freshFile();
    const result = await encryptContactsAtRest(file, KEY);
    expect(result.alreadyEncrypted).toBe(false);
    expect(await isContactsEncrypted(file)).toBe(true);
    expect(await readContacts(file, KEY)).toEqual([]);

    await addContact(file, contact("late", "Late Add"), KEY);
    expect(await isContactsEncrypted(file)).toBe(true);
    expect((await readContacts(file, KEY)).map((c) => c.id)).toEqual(["late"]);
  });

  it("writes a plaintext backup before the first encrypt, holding the original contacts", async () => {
    const file = freshFile();
    await addContact(file, contact("keep", "Keep Me"), KEY);
    const result = await encryptContactsAtRest(file, KEY);
    expect(result.backupPath).toBeDefined();
    const backup = JSON.parse(await readFile(result.backupPath!, "utf8")) as { contacts: { id: string }[] };
    expect(backup.contacts.map((c) => c.id)).toEqual(["keep"]);
  });

  it("is idempotent — encrypting an already-encrypted store does not re-backup or change bytes", async () => {
    const file = freshFile();
    await addContact(file, contact("c1", "Dana Wu"), KEY);
    await encryptContactsAtRest(file, KEY);
    const before = await readFile(file, "utf8");
    const second = await encryptContactsAtRest(file, KEY);
    expect(second.alreadyEncrypted).toBe(true);
    expect(second.backupPath).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("FAILS CLOSED on a wrong key: read throws and the ciphertext is byte-unchanged (never quarantined to empty)", async () => {
    const file = freshFile();
    await addContact(file, contact("secret", "Secret Person"), KEY);
    await encryptContactsAtRest(file, KEY);
    const ciphertext = await readFile(file, "utf8");

    await expect(readContacts(file, WRONG)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(ciphertext);
    expect(await isContactsEncrypted(file)).toBe(true);
    expect((await readContacts(file, KEY)).map((c) => c.id)).toEqual(["secret"]);
  });

  it("OUTBOUND-SAFE on a wrong key: resolveContact gets NO contacts (read throws) so a recipient never mis-resolves", async () => {
    const file = freshFile();
    await addContact(file, contact("c1", "Dana Wu", "dana@example.com"), KEY);
    await encryptContactsAtRest(file, KEY);
    // The recipient-resolution path reads contacts; a wrong key throws, so it
    // resolves against an EMPTY set → not-found (a send refuses / clarifies),
    // never a wrong recipient. Here we assert the read fails closed.
    await expect(queryContacts(file, WRONG)).rejects.toThrow();
    // With the right key it resolves correctly.
    expect(resolveContact(await queryContacts(file, KEY), "Dana Wu").status).toBe("resolved");
  });

  it("an add under a wrong key throws (read-before-write) and cannot bury the ciphertext", async () => {
    const file = freshFile();
    await addContact(file, contact("secret", "Secret"), KEY);
    await encryptContactsAtRest(file, KEY);
    const ciphertext = await readFile(file, "utf8");

    await expect(addContact(file, contact("intruder", "Intruder"), WRONG)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(ciphertext);
    expect((await readContacts(file, KEY)).map((c) => c.id)).toEqual(["secret"]);
  });

  it("read NEVER writes: reading an encrypted store leaves mtime and bytes untouched", async () => {
    const file = freshFile();
    await addContact(file, contact("c1", "Dana"), KEY);
    await encryptContactsAtRest(file, KEY);
    const before = await readFile(file, "utf8");
    const mtimeBefore = (await stat(file)).mtimeMs;

    await readContacts(file, KEY);
    await readContacts(file, KEY);
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(mtimeBefore);
  });

  it("decrypt reverses the migration to plaintext and stays readable", async () => {
    const file = freshFile();
    await addContact(file, contact("c1", "Dana"), KEY);
    await addContact(file, contact("c2", "Sam"), KEY);
    await encryptContactsAtRest(file, KEY);

    const result = await decryptContactsAtRest(file, KEY);
    expect(result.alreadyPlaintext).toBe(false);
    expect(await isContactsEncrypted(file)).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8")) as { contacts: unknown[] }).toHaveProperty("contacts");
    expect((await readContacts(file, KEY)).map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("decrypt under a wrong key fails closed without destroying the ciphertext", async () => {
    const file = freshFile();
    await addContact(file, contact("c1", "Dana"), KEY);
    await encryptContactsAtRest(file, KEY);
    const ciphertext = await readFile(file, "utf8");

    await expect(decryptContactsAtRest(file, WRONG)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(ciphertext);
    expect(await isContactsEncrypted(file)).toBe(true);
  });

  it("isContactsEncrypted is format-only — needs no key and never throws", async () => {
    const file = freshFile();
    await addContact(file, contact("c1", "Dana"), KEY);
    expect(await isContactsEncrypted(file)).toBe(false);
    await encryptContactsAtRest(file, KEY);
    expect(await isContactsEncrypted(file)).toBe(true);
    await expect(readContacts(file, {} as NodeJS.ProcessEnv)).rejects.toThrow();
  });

  it("a corrupt PLAINTEXT store still quarantines (encryption did not break the corrupt path)", async () => {
    const file = freshFile();
    await writeFile(file, "{ this is not json", "utf8");
    expect(await readContacts(file, KEY)).toEqual([]);
    await expect(stat(file)).rejects.toThrow();
    const siblings = await readdir(dirname(file));
    expect(siblings.filter((n) => n.startsWith(`${basename(file)}.corrupt-`)).length).toBe(1);
  });

  it("keeps every concurrently-added contact on an ENCRYPTED store (lock + queue hold)", async () => {
    const file = freshFile();
    await encryptContactsAtRest(file, KEY);
    await Promise.all(Array.from({ length: 12 }, (_unused, i) => addContact(file, contact(`c${i.toString()}`, `Person ${i.toString()}`), KEY)));
    expect(await isContactsEncrypted(file)).toBe(true);
    const all = await readContacts(file, KEY);
    expect(all).toHaveLength(12);
    expect(new Set(all.map((c) => c.id)).size).toBe(12);
  }, 30_000);
});
