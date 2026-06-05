import { describe, expect, it } from "vitest";

import { findDuplicateContacts, formatDuplicateContacts } from "./contact-dupes.js";

const c = (over: { id: string; name: string; email?: string; phone?: string; handle?: string }) => over as Parameters<typeof findDuplicateContacts>[0][number];

describe("findDuplicateContacts", () => {
  it("flags a pair sharing an email (case-insensitive), labelled by the email", () => {
    const pairs = findDuplicateContacts([
      c({ email: "Bob@X.com", id: "1", name: "Bob" }),
      c({ email: "bob@x.com", id: "2", name: "Bob Smith" }),
      c({ email: "alice@x.com", id: "3", name: "Alice" })
    ]);
    expect(pairs).toHaveLength(1);
    expect([pairs[0]!.a.name, pairs[0]!.b.name].sort()).toEqual(["Bob", "Bob Smith"]);
    expect(pairs[0]!.reason).toContain("same email (bob@x.com)");
  });

  it("flags a pair sharing a phone (normalized digits) and a pair sharing a name", () => {
    const pairs = findDuplicateContacts([
      c({ id: "1", name: "Dana", phone: "+1 (555) 010-0000" }),
      c({ id: "2", name: "Dana W", phone: "15550100000" }),
      c({ id: "3", name: "John Smith" }),
      c({ id: "4", name: "john smith" })
    ]);
    expect(pairs.map((p) => p.reason).sort()).toEqual([
      "same name (john smith)",
      "same phone (15550100000)"
    ]);
  });

  it("reports a pair ONCE by its strongest signal (email before name) and never a pair without a shared signal", () => {
    const pairs = findDuplicateContacts([
      c({ email: "x@y.com", id: "1", name: "Sam" }),
      c({ email: "x@y.com", id: "2", name: "Sam" }), // shares BOTH email and name
      c({ id: "3", name: "Unrelated" })
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.reason).toContain("email"); // strongest signal wins, not name
  });

  it("ignores a too-short phone and returns nothing for distinct contacts", () => {
    expect(findDuplicateContacts([c({ id: "1", name: "A", phone: "123" }), c({ id: "2", name: "B", phone: "123" })])).toEqual([]);
    expect(findDuplicateContacts([c({ id: "1", name: "A", email: "a@x" }), c({ id: "2", name: "B", email: "b@x" })])).toEqual([]);
  });
});

describe("formatDuplicateContacts", () => {
  it("lists pairs with the reason, or an all-clear line", () => {
    const out = formatDuplicateContacts([{ a: { id: "1", name: "Bob" }, b: { id: "2", name: "Bob Smith" }, reason: "same email (bob@x.com)" }]);
    expect(out).toContain("1 likely-duplicate contact pair(s)");
    expect(out).toContain("Bob ↔ Bob Smith — same email (bob@x.com)");
    expect(formatDuplicateContacts([])).toBe("✓ No likely-duplicate contacts found.\n");
  });
});
