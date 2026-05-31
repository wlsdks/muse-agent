import { describe, expect, it } from "vitest";

import { citedSourcesIn, enforceAnswerCitations } from "../src/index.js";

describe("citedSourcesIn", () => {
  it("extracts every [from <source>] token, trimmed, in order", () => {
    expect(citedSourcesIn("X [from journal/2026-05-12.md] and Y [from notes/vpn.md].")).toEqual([
      "journal/2026-05-12.md",
      "notes/vpn.md"
    ]);
  });
  it("returns [] when there are no citations", () => {
    expect(citedSourcesIn("just a plain answer, no sources")).toEqual([]);
  });
});

describe("enforceAnswerCitations — output-side recall grounding gate", () => {
  it("keeps a citation to a real source verbatim", () => {
    const out = enforceAnswerCitations("The VPN MTU is 1380 [from notes/vpn.md].", ["notes/vpn.md"]);
    expect(out.text).toBe("The VPN MTU is 1380 [from notes/vpn.md].");
    expect(out.stripped).toEqual([]);
  });

  it("strips a citation to a source the user does NOT have, and reports it", () => {
    const out = enforceAnswerCitations("Your flight is at 9am [from trips/itinerary.md].", ["notes/vpn.md"]);
    expect(out.text).toBe("Your flight is at 9am."); // the invented citation is gone; punctuation tidy
    expect(out.stripped).toEqual(["trips/itinerary.md"]);
  });

  it("keeps the real, strips the invented, in a mixed answer", () => {
    const answer = "MTU is 1380 [from notes/vpn.md] and your dentist is Tuesday [from cal/2026.md].";
    const out = enforceAnswerCitations(answer, ["notes/vpn.md"]);
    expect(out.text).toBe("MTU is 1380 [from notes/vpn.md] and your dentist is Tuesday.");
    expect(out.stripped).toEqual(["cal/2026.md"]);
  });

  it("matches case/space-insensitively so a real source is not dropped over re-casing", () => {
    const out = enforceAnswerCitations("Note [from Journal/2026-05-12.md].", ["journal/2026-05-12.md"]);
    expect(out.stripped).toEqual([]);
    expect(out.text).toContain("[from Journal/2026-05-12.md]");
  });

  it("an answer with no citations is returned unchanged", () => {
    const out = enforceAnswerCitations("I'm not sure — nothing in your notes covers that.", ["notes/vpn.md"]);
    expect(out.text).toBe("I'm not sure — nothing in your notes covers that.");
    expect(out.stripped).toEqual([]);
  });
});
