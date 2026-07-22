import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ContactStoreUnavailableError,
  encryptContactsAtRest,
  readContactByIdStrict,
  readContacts,
  readContactsStrict,
  writeContacts,
  type Contact
} from "../src/personal-contacts-store.js";

const KEY = { MUSE_MEMORY_KEY: "contacts-strict-key-A" } as NodeJS.ProcessEnv;
const WRONG_KEY = { MUSE_MEMORY_KEY: "contacts-strict-key-B" } as NodeJS.ProcessEnv;

let root: string;
let file: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "muse-contacts-strict-"));
  file = join(root, "contacts.json");
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

async function expectFailureWithoutWrites(action: () => Promise<unknown>): Promise<void> {
  const beforeBytes = await readFile(file);
  const beforeSiblings = (await readdir(dirname(file))).sort();
  await expect(action()).rejects.toBeInstanceOf(ContactStoreUnavailableError);
  expect(await readFile(file)).toEqual(beforeBytes);
  expect((await readdir(dirname(file))).sort()).toEqual(beforeSiblings);
}

const fullContact: Contact = {
  about: "Prefers a quiet room",
  aliases: ["Ada"],
  birthday: "12-10",
  connections: [{ as: "works with", to: "Grace Hopper" }],
  email: "ada@example.com",
  handle: "@ada",
  id: "contact_Äda-01",
  name: "Ada Lovelace",
  phone: "+44 20 0000",
  relationship: "collaborator"
};

describe("strict exact contacts reader", () => {
  it("round-trips the current plaintext and encrypted shape by byte-identical full id", async () => {
    await writeContacts(file, [fullContact], KEY);
    await expect(readContactsStrict(file, KEY)).resolves.toEqual([fullContact]);
    await expect(readContactByIdStrict(file, fullContact.id, KEY)).resolves.toEqual(fullContact);
    await expect(readContactByIdStrict(file, fullContact.id.toLowerCase(), KEY)).resolves.toBeUndefined();

    await encryptContactsAtRest(file, KEY);
    const encrypted = await readFile(file);
    await expect(readContactByIdStrict(file, fullContact.id, KEY)).resolves.toEqual(fullContact);
    expect(await readFile(file)).toEqual(encrypted);
    await expect(readContactByIdStrict(file, fullContact.id, WRONG_KEY)).rejects.toThrow();
    expect(await readFile(file)).toEqual(encrypted);
  });

  it("treats a missing file as empty without creating it", async () => {
    await expect(readContactsStrict(file, KEY)).resolves.toEqual([]);
    await expect(readFile(file)).rejects.toThrow();
  });

  it.each(["", " leading", "trailing ", "line\nbreak", "x\u007f", "x".repeat(257)])(
    "rejects noncanonical exact id %j before lookup",
    async (id) => {
      await writeContacts(file, [fullContact], KEY);
      await expectFailureWithoutWrites(() => readContactByIdStrict(file, id, KEY));
    }
  );

  it("bounds canonical contact ids by UTF-8 bytes", async () => {
    await writeContacts(file, [{ ...fullContact, id: "가".repeat(85) }], KEY);
    await expect(readContactByIdStrict(file, "가".repeat(85), KEY)).resolves.toMatchObject({ name: fullContact.name });
    await expectFailureWithoutWrites(() => readContactByIdStrict(file, "가".repeat(86), KEY));
  });

  it("rejects duplicate exact ids rather than picking one", async () => {
    await writeFile(file, `${JSON.stringify({ contacts: [fullContact, { ...fullContact, name: "Other" }] })}\n`);
    await expectFailureWithoutWrites(() => readContactsStrict(file, KEY));
  });

  it.each([
    ["invalid JSON", "{"],
    ["missing envelope", JSON.stringify({ people: [] })],
    ["extra envelope key", JSON.stringify({ contacts: [], version: 1 })],
    ["non-array envelope", JSON.stringify({ contacts: {} })],
    ["non-object row", JSON.stringify({ contacts: ["Ada"] })],
    ["unknown row key", JSON.stringify({ contacts: [{ ...fullContact, secret: true }] })],
    ["invalid id", JSON.stringify({ contacts: [{ ...fullContact, id: " contact" }] })],
    ["invalid name", JSON.stringify({ contacts: [{ ...fullContact, name: "" }] })],
    ["invalid optional string", JSON.stringify({ contacts: [{ ...fullContact, email: 7 }] })],
    ["invalid aliases", JSON.stringify({ contacts: [{ ...fullContact, aliases: ["Ada", 7] }] })],
    ["invalid connections", JSON.stringify({ contacts: [{ ...fullContact, connections: [{ to: 7 }] }] })],
    ["unknown connection key", JSON.stringify({ contacts: [{ ...fullContact, connections: [{ hidden: true, to: "Grace" }] }] })]
  ])("rejects %s without tolerant dropping or quarantine", async (_label, body) => {
    await writeFile(file, body as string);
    await expectFailureWithoutWrites(() => readContactsStrict(file, KEY));
  });

  it("rejects malformed decrypted JSON without changing ciphertext or creating another backup", async () => {
    await writeFile(file, "{ encrypted malformed payload");
    await encryptContactsAtRest(file, KEY);
    const before = await readFile(file);
    const siblings = (await readdir(root)).sort();
    await expect(readContactsStrict(file, KEY)).rejects.toBeInstanceOf(ContactStoreUnavailableError);
    expect(await readFile(file)).toEqual(before);
    expect((await readdir(root)).sort()).toEqual(siblings);
  });

  it("leaves the existing tolerant reader behavior unchanged", async () => {
    await writeFile(file, JSON.stringify({ contacts: [{ ...fullContact, phone: 7 }] }));
    expect(await readContacts(file, KEY)).toEqual([{ ...fullContact, phone: undefined }]);
  });
});
