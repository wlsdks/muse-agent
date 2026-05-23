import { describe, expect, it } from "vitest";

import { normalizeVCardBirthday, parseVCards } from "./vcard.js";

const VCF = `BEGIN:VCARD
VERSION:3.0
FN:Jane Doe
EMAIL;TYPE=work:jane@acme.com
TEL;TYPE=CELL:+1 415 555 0102
BDAY:1990-12-25
NICKNAME:Janey,JD
END:VCARD
BEGIN:VCARD
VERSION:4.0
FN:Bob Smith
TEL:+1 555 0199
BDAY:--0704
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:No Contact Method
END:VCARD
`;

describe("parseVCards", () => {
  it("parses multiple cards, stripping property params, first email/tel wins", () => {
    const cards = parseVCards(VCF);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toMatchObject({
      aliases: ["Janey", "JD"], birthday: "1990-12-25", email: "jane@acme.com", name: "Jane Doe", phone: "+1 415 555 0102"
    });
    expect(cards[1]).toMatchObject({ birthday: "07-04", name: "Bob Smith", phone: "+1 555 0199" });
    expect(cards[1]!.email).toBeUndefined();
    expect(cards[2]).toMatchObject({ name: "No Contact Method" }); // kept by parser; the import gate drops it
  });

  it("unfolds a folded (continued) line", () => {
    const folded = "BEGIN:VCARD\nFN:Very Long\n  Name Here\nEMAIL:x@y.com\nEND:VCARD\n";
    expect(parseVCards(folded)[0]!.name).toBe("Very Long Name Here");
  });

  it("skips a card with no FN", () => {
    expect(parseVCards("BEGIN:VCARD\nEMAIL:x@y.com\nEND:VCARD\n")).toHaveLength(0);
  });
});

describe("normalizeVCardBirthday", () => {
  it("accepts YYYY-MM-DD / YYYYMMDD / --MMDD / MM-DD; rejects junk", () => {
    expect(normalizeVCardBirthday("1990-12-25")).toBe("1990-12-25");
    expect(normalizeVCardBirthday("19901225")).toBe("1990-12-25");
    expect(normalizeVCardBirthday("--0704")).toBe("07-04");
    expect(normalizeVCardBirthday("12-25")).toBe("12-25");
    expect(normalizeVCardBirthday("sometime")).toBeUndefined();
  });
});
