import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  addContact,
  contactIdentifier,
  queryContacts,
  removeContact,
  resolveContact,
  resolveUpcomingBirthdays,
  type Contact
} from "./personal-contacts-store.js";

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-contacts-")), "contacts.json");
}

const bob: Contact = { email: "bob@example.com", id: "c_bob", name: "Bob" };
const bobby: Contact = { email: "bobby@example.com", id: "c_bobby", name: "Bobby" };
const bob2: Contact = { email: "bob.jones@example.com", id: "c_bob2", name: "Bob" };
const alice: Contact = { handle: "@alice", id: "c_alice", name: "Alice", aliases: ["Ally"] };

describe("contacts store round-trip", () => {
  it("add → query → remove reflects through the real ~/.muse/contacts.json", async () => {
    const file = tempFile();
    await addContact(file, bob);
    await addContact(file, alice);
    expect((await queryContacts(file)).map((c) => c.id)).toEqual(["c_alice", "c_bob"]);

    // Idempotent replace on id.
    await addContact(file, { ...bob, email: "bob@new.com" });
    expect((await queryContacts(file)).filter((c) => c.id === "c_bob")[0]?.email).toBe("bob@new.com");

    expect(await removeContact(file, "c_bob")).toBe(true);
    expect(await removeContact(file, "c_bob")).toBe(false);
    expect((await queryContacts(file)).map((c) => c.id)).toEqual(["c_alice"]);
  });
});

describe("resolveContact — recipient resolution backbone", () => {
  it("resolves a unique known contact to its identifier", () => {
    const r = resolveContact([bob, alice], "bob");
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(contactIdentifier(r.contact)).toBe("bob@example.com");
    }
  });

  it("resolves by alias too", () => {
    const r = resolveContact([bob, alice], "ally");
    expect(r.status === "resolved" && r.contact.id).toBe("c_alice");
  });

  it("prefers an exact name match over a substring one (Bob, not Bobby)", () => {
    const r = resolveContact([bobby, bob], "bob");
    expect(r.status === "resolved" && r.contact.id).toBe("c_bob");
  });

  it("reports AMBIGUOUS (never a guess) when two contacts share the queried name", () => {
    const r = resolveContact([bob, bob2], "bob");
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") {
      expect(r.matches.map((c) => c.id).sort()).toEqual(["c_bob", "c_bob2"]);
    }
  });

  it("reports AMBIGUOUS when a substring matches multiple contacts and none is exact", () => {
    const r = resolveContact([bobby, bob2], "bob");
    // "bob" is exact for neither "Bobby" nor "Bob" (bob2 is "Bob" → exact!).
    // Use a query exact for neither: "bo".
    const partial = resolveContact([bobby, bob2], "bo");
    expect(partial.status).toBe("ambiguous");
    expect(r.status).toBe("resolved"); // "bob" is exact for bob2 ("Bob")
  });

  it("reports UNKNOWN for no match and for an empty query", () => {
    expect(resolveContact([bob, alice], "carol").status).toBe("unknown");
    expect(resolveContact([bob, alice], "   ").status).toBe("unknown");
  });
});

describe("resolveUpcomingBirthdays", () => {
  const now = new Date(2026, 4, 20); // May 20 2026
  const people: Contact[] = [
    { birthday: "05-22", id: "a", name: "Ann" },        // in 2 days
    { birthday: "1990-05-20", id: "t", name: "Tom" },   // today (year ignored)
    { birthday: "12-25", id: "x", name: "Xander" },     // far off
    { id: "n", name: "NoBday" },                          // skipped
    { birthday: "garbage", id: "g", name: "Garbled" }     // skipped
  ];

  it("lists upcoming birthdays within the window, soonest first, year-agnostic", () => {
    const up = resolveUpcomingBirthdays(people, { now, withinDays: 30 });
    expect(up.map((u) => u.contact.name)).toEqual(["Tom", "Ann"]);
    expect(up[0]).toMatchObject({ date: "05-20", daysUntil: 0 });
    expect(up[1]).toMatchObject({ date: "05-22", daysUntil: 2 });
  });

  it("wraps a date already past this year to next year (not negative)", () => {
    const up = resolveUpcomingBirthdays([{ birthday: "01-01", id: "j", name: "Jan" }], { now, withinDays: 400 });
    expect(up[0]!.daysUntil).toBeGreaterThan(0);
  });

  it("excludes birthdays beyond the window and skips missing/malformed dates", () => {
    const up = resolveUpcomingBirthdays(people, { now, withinDays: 7 });
    expect(up.map((u) => u.contact.name)).toEqual(["Tom", "Ann"]); // Xander (Dec) excluded; NoBday/Garbled skipped
  });
});

// Concurrency (shared atomic-file helper migration): addContact / removeContact
// are read-modify-write. A lost contact is a recipient that later won't resolve —
// under outbound-safety rule 3 (recipient resolved, never guessed) that means a
// send is refused / a clarify fires instead of reaching the intended person.
describe("concurrent contact mutation", () => {
  it("preserves EVERY distinct contact added concurrently (no last-writer-wins loss)", async () => {
    const file = tempFile();
    await Promise.all(Array.from({ length: 20 }, (_unused, i) => addContact(file, { email: `c${i.toString()}@x.com`, id: `c${i.toString()}`, name: `C${i.toString()}` })));
    const all = await queryContacts(file);
    expect(all).toHaveLength(20);
    expect(new Set(all.map((c) => c.id)).size).toBe(20);
    // each remains resolvable by name (the recipient-resolution backbone sees them all)
    expect(resolveContact(all, "C7").status).toBe("resolved");
  });

  it("concurrent removes drop exactly the targeted contacts, leaving the rest", async () => {
    const file = tempFile();
    await Promise.all(Array.from({ length: 20 }, (_unused, i) => addContact(file, { email: `c${i.toString()}@x.com`, id: `c${i.toString()}`, name: `C${i.toString()}` })));
    await Promise.all(Array.from({ length: 10 }, (_unused, i) => removeContact(file, `c${i.toString()}`)));
    expect(await queryContacts(file)).toHaveLength(10);
  });
});
