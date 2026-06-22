import { describe, expect, it } from "vitest";

import { resolveContact, serializeContact, type Contact } from "@muse/stores";

const C1: Contact = { email: "bob@acme.com", handle: "@bobby", id: "c1", name: "Bob Acme" };
const C2: Contact = { email: "bob@other.com", id: "c2", name: "Bob Other" };
const C3: Contact = { email: "carol@zeta.com", id: "c3", name: "Carol" };
const ALL = [C1, C2, C3];

describe("resolveContact — resolve by email / handle, not just name", () => {
  it("a full email address resolves the matching contact", () => {
    const r = resolveContact(ALL, "bob@acme.com");
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" && r.contact.id).toBe("c1");
  });

  it("an exact email resolves UNIQUELY even when the names alone would be ambiguous", () => {
    // "Bob Acme" and "Bob Other" both partial-match "bob"; the exact email
    // is the unambiguous identifier and must win, not report ambiguity.
    const r = resolveContact(ALL, "bob@other.com");
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" && r.contact.id).toBe("c2");
  });

  it("a handle resolves with or without the leading '@'", () => {
    expect(resolveContact(ALL, "@bobby").status).toBe("resolved");
    const bare = resolveContact(ALL, "bobby");
    expect(bare.status).toBe("resolved");
    expect(bare.status === "resolved" && bare.contact.id).toBe("c1");
  });

  it("an email SUBSTRING (not in the name) does NOT match — only the full address resolves", () => {
    // "zeta" is a substring of carol@zeta.com but not of her name; email is
    // matched EXACTLY only, so this stays unknown (no spurious resolution).
    expect(resolveContact(ALL, "zeta").status).toBe("unknown");
  });

  it("name resolution is unchanged — a partial name still resolves / disambiguates", () => {
    expect(resolveContact(ALL, "carol").status).toBe("resolved");
    expect(resolveContact(ALL, "bob").status).toBe("ambiguous"); // both Bobs by name
  });
});

describe("serializeContact — includes phone when present", () => {
  it("emits a stored phone number", () => {
    expect(serializeContact({ id: "c5", name: "Mom", phone: "+1 415 555 0101" }))
      .toMatchObject({ id: "c5", name: "Mom", phone: "+1 415 555 0101" });
  });

  it("omits phone when the contact has none", () => {
    expect(serializeContact(C1)).not.toHaveProperty("phone");
  });
});
