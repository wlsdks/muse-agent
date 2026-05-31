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
  it("keeps a note citation to a real source verbatim", () => {
    const out = enforceAnswerCitations("The VPN MTU is 1380 [from notes/vpn.md].", { notes: ["notes/vpn.md"] });
    expect(out.text).toBe("The VPN MTU is 1380 [from notes/vpn.md].");
    expect(out.stripped).toEqual([]);
  });

  it("strips a note citation to a source the user does NOT have, and reports it", () => {
    const out = enforceAnswerCitations("Your flight is at 9am [from trips/itinerary.md].", { notes: ["notes/vpn.md"] });
    expect(out.text).toBe("Your flight is at 9am.");
    expect(out.stripped).toEqual(["trips/itinerary.md"]);
  });

  it("keeps real, strips invented, in a mixed-note answer", () => {
    const answer = "MTU is 1380 [from notes/vpn.md] and your dentist is Tuesday [from cal/2026.md].";
    const out = enforceAnswerCitations(answer, { notes: ["notes/vpn.md"] });
    expect(out.text).toBe("MTU is 1380 [from notes/vpn.md] and your dentist is Tuesday.");
    expect(out.stripped).toEqual(["cal/2026.md"]);
  });

  it("matches notes case/space-insensitively so a real source isn't dropped over re-casing", () => {
    const out = enforceAnswerCitations("Note [from Journal/2026-05-12.md].", { notes: ["journal/2026-05-12.md"] });
    expect(out.stripped).toEqual([]);
    expect(out.text).toContain("[from Journal/2026-05-12.md]");
  });

  it("gates feeds by exact name — invented feed stripped, real kept", () => {
    const out = enforceAnswerCitations("News: a launch [feed: TechCrunch] and a thread [feed: Hacker News].", { feeds: ["Hacker News"] });
    expect(out.text).toBe("News: a launch and a thread [feed: Hacker News].");
    expect(out.stripped).toEqual(["TechCrunch"]);
  });

  it("gates tasks/events by content-token overlap — a paraphrased-but-real title survives, a fabricated one is stripped", () => {
    const out = enforceAnswerCitations(
      "Pay the rent [task: pay the rent] and see the dentist [event: lunch with Bob].",
      { events: ["Dentist cleaning 3pm"], tasks: ["Pay Q3 rent"] }
    );
    // "[task: pay the rent]" overlaps the real "Pay Q3 rent" (pay/rent) → kept;
    // "[event: lunch with Bob]" shares nothing with "Dentist cleaning 3pm" → stripped.
    expect(out.text).toContain("[task: pay the rent]");
    expect(out.text).not.toContain("[event: lunch with Bob]");
    expect(out.stripped).toEqual(["lunch with Bob"]);
  });

  it("gates sessions by content-token overlap against retrieved past-session summaries", () => {
    const out = enforceAnswerCitations(
      "We sorted the VPN [session: fixed the office VPN] and did your taxes [session: filed quarterly taxes].",
      { sessions: ["Fixed the office VPN handshake by setting MTU 1380 on wg0."] }
    );
    expect(out.text).toContain("[session: fixed the office VPN]"); // overlaps fixed/office/vpn → kept
    expect(out.text).not.toContain("filed quarterly taxes"); // no overlap with the retrieved session → stripped
    expect(out.stripped).toEqual(["filed quarterly taxes"]);
  });

  it("an answer with no citations is returned unchanged", () => {
    const out = enforceAnswerCitations("I'm not sure — nothing in your notes covers that.", { notes: ["notes/vpn.md"] });
    expect(out.text).toBe("I'm not sure — nothing in your notes covers that.");
    expect(out.stripped).toEqual([]);
  });
});
