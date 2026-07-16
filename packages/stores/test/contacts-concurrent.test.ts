import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addContact, mutateContactsWithResult, readContacts, writeContacts, type Contact } from "../src/personal-contacts-store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-contacts-concurrent-"));
  file = join(dir, "contacts.json");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

const contact = (id: string): Contact => ({ id, name: `Person ${id}` });

describe("addContact", () => {
  it("reads after an external lock releases so it cannot overwrite another process's change", async () => {
    await writeContacts(file, [contact("seed")]);
    const lockPath = `${file}.lock`;
    await writeFile(lockPath, "external-holder", "utf8");

    const pending = addContact(file, contact("local"));
    await sleep(300);

    // Simulate the process that owns the lock committing its own update before
    // releasing it. A stale pre-lock read would later erase `external`.
    await writeFile(file, JSON.stringify({ contacts: [contact("seed"), contact("external")] }), "utf8");
    await unlink(lockPath);
    await pending;

    expect((await readContacts(file)).map((entry) => entry.id).sort()).toEqual(["external", "local", "seed"]);
  }, 10_000);
});

describe("mutateContactsWithResult", () => {
  it("derives an import-style merge from the post-lock snapshot without losing an external change", async () => {
    await writeContacts(file, [contact("seed")]);
    const lockPath = `${file}.lock`;
    await writeFile(lockPath, "external-holder", "utf8");

    const pending = mutateContactsWithResult(file, (current) => ({
      contacts: [...current, contact("imported")],
      result: { imported: 1 }
    }));
    await sleep(300);

    await writeFile(file, JSON.stringify({ contacts: [contact("seed"), contact("external")] }), "utf8");
    await unlink(lockPath);

    await expect(pending).resolves.toEqual({ imported: 1 });
    expect((await readContacts(file)).map((entry) => entry.id).sort()).toEqual(["external", "imported", "seed"]);
  }, 10_000);
});
