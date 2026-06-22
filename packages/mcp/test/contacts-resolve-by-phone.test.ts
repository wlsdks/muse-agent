import { describe, expect, it } from "vitest";

import { resolveContact, type Contact } from "@muse/stores";

const MOM: Contact = { id: "c1", name: "Mom", phone: "+1 415-555-0101" };
const BOB: Contact = { id: "c2", name: "Bob Acme", phone: "(212) 555-9999" };
const NOPHONE: Contact = { id: "c3", name: "Carol" };
const ALL = [MOM, BOB, NOPHONE];

describe("resolveContact — resolve by phone number, tolerating format differences", () => {
  it("a differently-formatted phone resolves the matching contact (digits-only compare)", () => {
    for (const q of ["4155550101", "415-555-0101", "(415) 555-0101", "+1 415 555 0101"]) {
      const r = resolveContact(ALL, q);
      expect(r.status, q).toBe("resolved");
      expect(r.status === "resolved" && r.contact.id, q).toBe("c1");
    }
  });

  it("a local number resolves a stored country-code-prefixed number via suffix match", () => {
    // stored "(212) 555-9999"; query carries +1.
    const r = resolveContact(ALL, "+1 212 555 9999");
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" && r.contact.id).toBe("c2");
  });

  it("a short / digit-light query does NOT spuriously match a phone (≥7-digit guard)", () => {
    expect(resolveContact(ALL, "555").status).toBe("unknown");
    expect(resolveContact(ALL, "Mom").status).toBe("resolved"); // name still wins
  });

  it("a phone query against contacts with no matching number stays unknown", () => {
    expect(resolveContact(ALL, "+1 999 000 1234").status).toBe("unknown");
  });
});
