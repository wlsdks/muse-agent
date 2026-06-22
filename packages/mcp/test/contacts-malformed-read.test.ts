import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readContacts, resolveContact, serializeContact, type Contact } from "@muse/stores";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-contacts-malformed-"));
  file = join(dir, "contacts.json");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("readContacts — tolerant read coerces wrong-typed fields from a hand-edited / synced store", () => {
  it("keeps the contact but drops a NON-STRING optional field (no crash in later resolution)", async () => {
    // A sync tool / hand-edit wrote phone + email as numbers, aliases with
    // a stray non-string, birthday as a number. id+name are valid strings.
    await writeFile(
      file,
      JSON.stringify({
        contacts: [
          { id: "c1", name: "Mom", phone: 14155550101, aliases: ["mum", 7] },
          { id: "c2", name: "Bob", email: 12345, birthday: 1225 },
          { id: "c3", name: "Carol", phone: "+1 212 555 9999" }
        ]
      }),
      "utf8"
    );

    const contacts = await readContacts(file);

    expect(contacts).toHaveLength(3);
    const mom = contacts.find((c) => c.id === "c1")!;
    expect(mom.name).toBe("Mom");
    expect(mom.phone).toBeUndefined(); // numeric phone dropped
    expect(mom.aliases).toEqual(["mum"]); // non-string alias filtered out
    const bob = contacts.find((c) => c.id === "c2")!;
    expect(bob.email).toBeUndefined(); // numeric email dropped
    expect(bob.birthday).toBeUndefined(); // numeric birthday dropped
    const carol = contacts.find((c) => c.id === "c3")!;
    expect(carol.phone).toBe("+1 212 555 9999"); // well-typed field preserved
  });

  it("a query that falls through to the phone clause no longer crashes the WHOLE store", async () => {
    await writeFile(
      file,
      JSON.stringify({
        contacts: [
          { id: "c1", name: "Mom", phone: 14155550101 }, // numeric phone
          { id: "c2", name: "Bob", email: "bob@x.com" }
        ]
      }),
      "utf8"
    );

    const contacts = await readContacts(file);

    // Before the fix this threw `TypeError: a.replace is not a function`
    // because phoneMatches ran .replace() on the numeric phone of c1.
    const r = resolveContact(contacts, "bob@x.com");
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" && r.contact.id).toBe("c2");

    // c1 still resolves by name (it wasn't dropped, just its bad field).
    expect(resolveContact(contacts, "Mom").status).toBe("resolved");
  });

  it("round-trips the `relationship` field and drops a non-string one", async () => {
    const dana: Contact = { id: "c1", name: "Dana Wu", email: "dana@x.com", relationship: "manager" };
    // serialize emits relationship...
    expect(serializeContact(dana).relationship).toBe("manager");
    // ...and a written store reads it back, while a numeric relationship is dropped.
    await writeFile(
      file,
      JSON.stringify({ contacts: [serializeContact(dana), { id: "c2", name: "Bad", email: "b@x.com", relationship: 7 }] }),
      "utf8"
    );
    const contacts = await readContacts(file);
    expect(contacts.find((c) => c.id === "c1")!.relationship).toBe("manager");
    expect(contacts.find((c) => c.id === "c2")!.relationship).toBeUndefined(); // numeric relationship dropped
  });

  it("an entry missing id or name is still dropped entirely", async () => {
    await writeFile(
      file,
      JSON.stringify({
        contacts: [
          { name: "No Id" },
          { id: "c2" },
          { id: "c3", name: "Valid" }
        ]
      }),
      "utf8"
    );

    const contacts = await readContacts(file);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.id).toBe("c3");
  });
});
