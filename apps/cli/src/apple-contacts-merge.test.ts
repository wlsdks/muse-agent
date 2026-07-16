import type { AppleContact } from "@muse/macos";
import { resolveUpcomingBirthdays, type Contact } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { mergeAppleContacts } from "./apple-contacts-merge.js";

/** Deterministic id factory so assertions are stable. */
function idFactory(): () => string {
  let n = 0;
  return () => `id-${(n += 1).toString()}`;
}

const apple = (partial: Partial<AppleContact> & { name: string }): AppleContact => ({
  emails: [],
  phones: [],
  ...partial
});

describe("mergeAppleContacts — dedup + additive merge", () => {
  it("imports a brand-new contact", () => {
    const result = mergeAppleContacts([], [apple({ birthday: "05-20", emails: ["bob@x.com"], name: "Bob", phones: ["+1 415 555 1000"] })], idFactory());
    expect(result.imported).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.contacts).toEqual([{ birthday: "05-20", email: "bob@x.com", id: "id-1", name: "Bob", phone: "+1 415 555 1000" }]);
  });

  it("updates an existing contact matched by PHONE — fills a blank email WITHOUT clobbering user-set relationship/about", () => {
    const existing: Contact = {
      about: "allergic to nuts",
      id: "u1",
      name: "Bobby",
      phone: "(415) 555-1000",
      relationship: "manager"
    };
    const incoming = apple({ emails: ["bob@work.com"], name: "Robert", phones: ["+1 415-555-1000"] });
    const result = mergeAppleContacts([existing], [incoming], idFactory());
    expect(result.imported).toBe(0);
    expect(result.updated).toBe(1);
    const merged = result.contacts[0]!;
    expect(merged.email).toBe("bob@work.com"); // blank filled
    expect(merged.phone).toBe("(415) 555-1000"); // NOT overwritten
    expect(merged.relationship).toBe("manager"); // user enrichment preserved
    expect(merged.about).toBe("allergic to nuts");
    expect(merged.name).toBe("Bobby"); // name never changed on a phone match
  });

  it("matches by normalized name and fills a blank birthday", () => {
    const existing: Contact = { email: "sara@x.com", id: "u2", name: "Sara Kim" };
    const result = mergeAppleContacts([existing], [apple({ birthday: "1991-08-14", name: "sara kim" })], idFactory());
    expect(result.updated).toBe(1);
    expect(result.contacts[0]!.birthday).toBe("1991-08-14");
    expect(result.contacts[0]!.email).toBe("sara@x.com");
  });

  it("does not collapse same-named people when both sides have different addressable identifiers", () => {
    const existing: Contact = { id: "u2", name: "Alex Kim", phone: "555-0101" };
    const result = mergeAppleContacts([existing], [apple({ emails: ["alex@example.com"], name: "Alex Kim" })], idFactory());
    expect(result.imported).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.contacts).toEqual([
      existing,
      { email: "alex@example.com", id: "id-1", name: "Alex Kim" }
    ]);
  });

  it("uses the unique name fallback only when the stored contact has no address", () => {
    const existing: Contact = { id: "u3", name: "Sara Kim", relationship: "coworker" };
    const result = mergeAppleContacts([existing], [apple({ emails: ["sara@x.com"], name: "sara kim" })], idFactory());
    expect(result.imported).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.contacts).toEqual([{ email: "sara@x.com", id: "u3", name: "Sara Kim", relationship: "coworker" }]);
  });

  it("keeps same-named records with conflicting phone and email identities separate", () => {
    const existing: Contact = { birthday: "01-01", email: "e@x.com", id: "u3", name: "Ed", phone: "5551234567" };
    const result = mergeAppleContacts([existing], [apple({ birthday: "12-31", emails: ["other@x.com"], name: "Ed", phones: ["5559999999"] })], idFactory());
    expect(result.updated).toBe(0);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.contacts).toEqual([
      existing,
      { birthday: "12-31", email: "other@x.com", id: "id-1", name: "Ed", phone: "5559999999" }
    ]);
  });

  it("skips a bare label with no name+phone/email/birthday", () => {
    const result = mergeAppleContacts([], [apple({ name: "Just A Name" })], idFactory());
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.contacts).toEqual([]);
  });

  it("is idempotent — re-importing the SAME apple book converges to 0 new / 0 updated", () => {
    const book: AppleContact[] = [
      apple({ birthday: "05-20", emails: ["bob@x.com"], name: "Bob", phones: ["+1 415 555 1000"] }),
      apple({ birthday: "1991-08-14", emails: ["sara@x.com"], name: "Sara Kim" })
    ];
    const first = mergeAppleContacts([], book, idFactory());
    expect(first.imported).toBe(2);
    const second = mergeAppleContacts(first.contacts, book, idFactory());
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.contacts).toEqual(first.contacts);
  });
});

describe("imported birthdays feed resolveUpcomingBirthdays (with-year AND without-year)", () => {
  it("surfaces both a year-less (MM-DD) and a with-year (YYYY-MM-DD) imported birthday", () => {
    const now = new Date("2026-05-18T12:00:00.000Z");
    const book: AppleContact[] = [
      apple({ birthday: "05-20", name: "NoYear Person", phones: ["5550000001"] }), // year-less
      apple({ birthday: "1990-05-19", name: "WithYear Person", phones: ["5550000002"] }) // with year
    ];
    const { contacts } = mergeAppleContacts([], book, idFactory());
    const upcoming = resolveUpcomingBirthdays(contacts, { now, withinDays: 30 });
    const names = upcoming.map((u) => u.contact.name);
    expect(names).toContain("NoYear Person");
    expect(names).toContain("WithYear Person");
    // Soonest first: the with-year (05-19) lands before the year-less (05-20).
    expect(names.indexOf("WithYear Person")).toBeLessThan(names.indexOf("NoYear Person"));
  });
});
