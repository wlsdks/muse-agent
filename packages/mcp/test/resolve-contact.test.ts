import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  contactIdentifier,
  readContacts,
  removeContact,
  resolveContact,
  writeContacts,
  type Contact
} from "../src/personal-contacts-store.js";

const contacts: readonly Contact[] = [
  { email: "bob@acme.com", handle: "@bobby", id: "1", name: "Bob Smith" },
  { id: "2", name: "Bobby Jones" },
  { id: "3", name: "Carol" }
];

// Recipient resolution (outbound-safety rule 3: the destination must resolve
// unambiguously; an ambiguous / unknown query is NEVER best-guessed — it surfaces
// for a clarifying question instead).
describe("resolveContact", () => {
  it("resolves an exact match on name / email / handle to that one contact", () => {
    expect(resolveContact(contacts, "carol")).toMatchObject({ status: "resolved" });
    expect(resolveContact(contacts, "bob@acme.com")).toMatchObject({ contact: { id: "1" }, status: "resolved" });
    expect(resolveContact(contacts, "@bobby")).toMatchObject({ contact: { id: "1" }, status: "resolved" });
  });

  it("returns ambiguous (NOT a guess) when a partial query matches more than one contact", () => {
    const result = resolveContact(contacts, "bob"); // "Bob Smith" + "Bobby Jones", neither an exact "bob"
    expect(result.status).toBe("ambiguous");
    expect(result.status === "ambiguous" && result.matches).toHaveLength(2);
  });

  it("prefers an exact match over partial ones (an exact 'Bob' wins over the two partials)", () => {
    const withExact = [...contacts, { id: "4", name: "Bob" }];
    expect(resolveContact(withExact, "bob")).toMatchObject({ contact: { id: "4" }, status: "resolved" });
  });

  it("returns unknown for an empty/whitespace query and for a query that matches nothing", () => {
    expect(resolveContact(contacts, "   ")).toEqual({ status: "unknown" });
    expect(resolveContact(contacts, "zzz")).toEqual({ status: "unknown" });
  });
});

describe("contactIdentifier", () => {
  it("prefers email, falls back to handle, and is undefined when neither is set", () => {
    expect(contactIdentifier({ email: "e@x", handle: "@h", id: "a", name: "x" })).toBe("e@x");
    expect(contactIdentifier({ handle: "@h", id: "a", name: "x" })).toBe("@h");
    expect(contactIdentifier({ id: "a", name: "x" })).toBeUndefined();
  });
});

describe("removeContact", () => {
  let file: string;
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-contacts-")); file = join(dir, "contacts.json"); });
  afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

  it("removes a contact by id and reports true; reports false when the id is absent", async () => {
    await writeContacts(file, contacts);
    expect(await removeContact(file, "2")).toBe(true);
    expect((await readContacts(file)).map((c) => c.id).sort()).toEqual(["1", "3"]);
    expect(await removeContact(file, "999")).toBe(false);
  });
});
