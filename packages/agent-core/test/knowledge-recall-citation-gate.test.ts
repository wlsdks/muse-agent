import { describe, expect, it } from "vitest";

import { citedSourcesIn, enforceAnswerCitations, normalizeContactCitations, normalizeFromPrefixedCitations, normalizeMemoryCitations, normalizeSlotCitations } from "../src/index.js";

describe("normalizeMemoryCitations — repair `[from <memory-key>]` (the model's note-verb mis-form, common in Korean)", () => {
  const keys = ["car_license_plate", "allergy_penicillin"];

  it("rewrites a [from <memory-key>] to [memory: <key>] (exact key match, separator-insensitive)", () => {
    expect(normalizeMemoryCitations("번호판은 12가 3456 [from car_license_plate].", keys))
      .toBe("번호판은 12가 3456 [memory: car_license_plate].");
    expect(normalizeMemoryCitations("plate [from Car License Plate].", keys))
      .toBe("plate [memory: Car License Plate].");
  });

  it("leaves a REAL note citation untouched (a note is never mistaken for a memory)", () => {
    expect(normalizeMemoryCitations("wifi is hunter2 [from home.md].", keys)).toBe("wifi is hunter2 [from home.md].");
    expect(normalizeMemoryCitations("see [from projects/vpn.md].", keys)).toBe("see [from projects/vpn.md].");
  });

  it("the rewritten form flows through the gate cleanly (no false strip on a real remembered fact)", () => {
    const repaired = normalizeMemoryCitations("plate is 12가 3456 [from car_license_plate].", keys);
    const gated = enforceAnswerCitations(repaired, { memories: ["car license plate: 12가 3456"] });
    expect(gated.stripped).toEqual([]);
    expect(gated.text).toContain("[memory: car_license_plate]");
  });

  it("is a no-op with no memory keys", () => {
    expect(normalizeMemoryCitations("x [from car_license_plate].", [])).toBe("x [from car_license_plate].");
  });
});

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

  it("gates contacts by content-token overlap — a real person's citation survives, an unknown one is stripped", () => {
    const out = enforceAnswerCitations(
      "Email Sarah at sarah@x.com [contact: Sarah Chen] and ask the plumber [contact: Mike's Plumbing].",
      { contacts: ["Sarah Chen", "Dr. Alice Wong"] }
    );
    expect(out.text).toContain("[contact: Sarah Chen]"); // a known contact → kept
    expect(out.text).not.toContain("[contact: Mike's Plumbing]"); // not in the address book → stripped
    expect(out.stripped).toEqual(["Mike's Plumbing"]);
  });

  it("gates git commits by content-token overlap — a real commit subject survives, an invented one is stripped", () => {
    const out = enforceAnswerCitations(
      "You added OAuth login [commit: feat(auth): add OAuth login] then broke the build [commit: chore: delete production database].",
      { commits: ["feat(auth): add OAuth login with Google", "fix(payments): handle the Stripe webhook"] }
    );
    expect(out.text).toContain("[commit: feat(auth): add OAuth login]"); // overlaps a real commit → kept
    expect(out.text).not.toContain("delete production database"); // no overlap with any real commit → stripped
    expect(out.stripped).toEqual(["chore: delete production database"]);
  });

  it("gates remembered facts by content-token overlap — a real one survives, an invented one is stripped", () => {
    const out = enforceAnswerCitations(
      "You are allergic to penicillin [memory: allergy_penicillin] and your bank PIN is 0000 [memory: bank_pin].",
      { memories: ["allergy penicillin", "favorite color: blue"] }
    );
    expect(out.text).toContain("[memory: allergy_penicillin]"); // overlaps a real remembered fact → kept
    expect(out.text).not.toContain("bank_pin"); // never told Muse a PIN → stripped
    expect(out.stripped).toEqual(["bank_pin"]);
  });

  it("gates shell commands by content-token overlap — a real one survives, an invented one is stripped", () => {
    const out = enforceAnswerCitations(
      "Run docker run -p 8080:80 nginx [command: docker run nginx] then helm install [command: helm install foo].",
      { commands: ["docker run -p 8080:80 nginx", "git status"] }
    );
    expect(out.text).toContain("[command: docker run nginx]"); // overlaps the real docker command → kept
    expect(out.text).not.toContain("[command: helm install foo]"); // no overlap with any real command → stripped
    expect(out.stripped).toEqual(["helm install foo"]);
  });

  it("gates actions by content-token overlap — a real logged action survives, an invented one is stripped", () => {
    const out = enforceAnswerCitations(
      "Yes, I emailed Sarah [action: email to sarah about Q3 budget] but I did not call the bank [action: phoned the bank].",
      { actions: ["email to sarah@x.io: Q3 budget", "telegram message to @team"] }
    );
    expect(out.text).toContain("[action: email to sarah about Q3 budget]"); // overlaps a real logged action → kept
    expect(out.text).not.toContain("[action: phoned the bank]"); // nothing logged about the bank → stripped
    expect(out.stripped).toEqual(["phoned the bank"]);
  });

  it("gates reminders by content-token overlap — paraphrased-real kept, fabricated stripped", () => {
    // The reminder source type has its own strip branch that no test exercised.
    const out = enforceAnswerCitations(
      "Take your meds [reminder: take medication] and book it [reminder: renew passport].",
      { reminders: ["take your medication at 8pm"] }
    );
    expect(out.text).toContain("[reminder: take medication]"); // take/medication overlap → kept
    expect(out.text).not.toContain("renew passport"); // no overlap with any real reminder → stripped
    expect(out.stripped).toEqual(["renew passport"]);
  });

  it("strips a citation against an ABSENT source list (undefined → treated as empty, so all are fabricated)", () => {
    const out = enforceAnswerCitations("X [reminder: anything].", {});
    expect(out.stripped).toEqual(["anything"]);
    expect(out.text).toBe("X.");
  });

  it("cleans up the whitespace a stripped citation leaves (no ' .' or double space in the user-facing answer)", () => {
    // A removed citation must not leave a space-before-punctuation or a double
    // space — the answer is shown to the user, so the gate tidies the prose.
    const trailing = enforceAnswerCitations("Your flight is at 9am [from trips/itinerary.md].", { notes: ["notes/vpn.md"] });
    expect(trailing.text).toBe("Your flight is at 9am."); // not "9am ." and no double space
    const midline = enforceAnswerCitations("First [from invented.md]  then second.", { notes: [] });
    expect(midline.text).toBe("First then second."); // collapsed, not "First   then second."
  });

  it("an answer with no citations is returned unchanged", () => {
    const out = enforceAnswerCitations("I'm not sure — nothing in your notes covers that.", { notes: ["notes/vpn.md"] });
    expect(out.text).toBe("I'm not sure — nothing in your notes covers that.");
    expect(out.stripped).toEqual([]);
  });

  it("clean answer with multi-space indentation is returned byte-for-byte (no whitespace mangling)", () => {
    const answer = "Here:\n\n    def f():\n        return  1\n\nDone.";
    const out = enforceAnswerCitations(answer, { notes: [] });
    expect(out.stripped).toEqual([]);
    expect(out.text).toBe(answer);
  });

  it("stripping a citation tidies the leftover seam whitespace (regression: stripping path unchanged)", () => {
    const out = enforceAnswerCitations("The value is 42 [from nope.md] .", { notes: [] });
    expect(out.stripped).toEqual(["nope.md"]);
    expect(out.text).toBe("The value is 42.");
  });

  it("valid citation kept + code block whitespace preserved (kept-citation path is verbatim)", () => {
    const answer = "Use:\n\n    cmd  --flag\n\nSee [from real.md].";
    const out = enforceAnswerCitations(answer, { notes: ["real.md"] });
    expect(out.stripped).toEqual([]);
    expect(out.text).toBe(answer);
  });
});

describe("normalizeContactCitations — repair the model's contact-citation mis-forms before the gate", () => {
  const book = [{ id: "mina", name: "Mina Park" }, { id: "jin", name: "Jin Lee" }];

  it("rewrites the note-verb form `[from contact 1]` to `[contact: <name>]` (slot number)", () => {
    expect(normalizeContactCitations("Email is mina@x.io [from contact 1].", book))
      .toBe("Email is mina@x.io [contact: Mina Park].");
  });

  it("rewrites `[from contact: <id>]` (note verb + id) to the canonical name form", () => {
    expect(normalizeContactCitations("Phone is +1 415 [from contact: mina].", book))
      .toBe("Phone is +1 415 [contact: Mina Park].");
  });

  it("rewrites the bare-slot form `[contact 2]` and the id form `[contact: jin]`", () => {
    expect(normalizeContactCitations("Reach them [contact 2].", book)).toBe("Reach them [contact: Jin Lee].");
    expect(normalizeContactCitations("Reach them [contact: jin].", book)).toBe("Reach them [contact: Jin Lee].");
  });

  it("the result flows through the gate cleanly (no false strip on a real contact)", () => {
    const repaired = normalizeContactCitations("mina@x.io [from contact 1].", book);
    const gated = enforceAnswerCitations(repaired, { contacts: book.map((c) => c.name) });
    expect(gated.stripped).toEqual([]);
    expect(gated.text).toContain("[contact: Mina Park]");
  });

  it("a first-name partial resolves by token overlap to the full name", () => {
    expect(normalizeContactCitations("ask [from contact: Mina].", book)).toBe("ask [contact: Mina Park].");
  });

  it("leaves an UNRESOLVABLE reference untouched for the gate to strip (out-of-range slot / unknown id)", () => {
    expect(normalizeContactCitations("see [from contact 9].", book)).toBe("see [from contact 9].");
    expect(normalizeContactCitations("see [from contact: nobody].", book)).toBe("see [from contact: nobody].");
  });

  it("never rewrites a real note citation whose filename merely starts with 'contact'", () => {
    // `[from contacts.md]` — the 's' blocks the `contact<sep>` anchor; `[from contact-list.md]`
    // matches the anchor but resolves to no contact → left for the note gate to judge.
    expect(normalizeContactCitations("X [from contacts.md].", book)).toBe("X [from contacts.md].");
    expect(normalizeContactCitations("X [from contact-list.md].", book)).toBe("X [from contact-list.md].");
  });

  it("is a no-op when there are no matched contacts (empty book)", () => {
    expect(normalizeContactCitations("X [from contact 1].", [])).toBe("X [from contact 1].");
  });

  it("an already-canonical `[contact: Mina Park]` is preserved (idempotent)", () => {
    expect(normalizeContactCitations("X [contact: Mina Park].", book)).toBe("X [contact: Mina Park].");
  });

  // The real-world contact id is `contact_<uuid>` (the grounding marker is
  // `<<contact N — contact_<uuid>>>`), and the model often echoes that raw id
  // with the NOTE verb: `[from contact_<uuid>]`. The `contact`-anchored regex
  // misses it (the `_` is not a separator), so without this pass the gate
  // false-strips a CORRECT contact recall and warns "treat as unverified".
  const uuidBook = [{ id: "contact_60a1f9d8-9bae-4c8e-9064-b33e0db22d31", name: "Mina Park" }];

  it("rewrites the raw `[from contact_<uuid>]` id form to `[contact: <name>]`", () => {
    expect(normalizeContactCitations("Email is mina@x.io [from contact_60a1f9d8-9bae-4c8e-9064-b33e0db22d31].", uuidBook))
      .toBe("Email is mina@x.io [contact: Mina Park].");
  });

  it("rewrites a `[from <Full Name>]` (note verb + exact contact name) to the canonical form", () => {
    expect(normalizeContactCitations("Ask [from Mina Park].", uuidBook)).toBe("Ask [contact: Mina Park].");
  });

  it("the raw-id rewrite flows through the gate cleanly (the false-strip + 'unverified' warning is gone)", () => {
    const repaired = normalizeContactCitations("mina@x.io [from contact_60a1f9d8-9bae-4c8e-9064-b33e0db22d31].", uuidBook);
    const gated = enforceAnswerCitations(repaired, { contacts: uuidBook.map((c) => c.name) });
    expect(gated.stripped).toEqual([]);
    expect(gated.text).toContain("[contact: Mina Park]");
  });

  it("never rewrites a real `[from <note>]` that merely resembles a contact (exact-match only, no fuzzy)", () => {
    expect(normalizeContactCitations("X [from contact-notes.md].", uuidBook)).toBe("X [from contact-notes.md].");
    expect(normalizeContactCitations("X [from mina-park-resume.md].", uuidBook)).toBe("X [from mina-park-resume.md].");
  });
});

describe("normalizeFromPrefixedCitations — drop the redundant 'from ' before a STRUCTURED citation", () => {
  it("rewrites `[from commit: …]` to `[commit: …]` (the git-recall false-strip)", () => {
    expect(normalizeFromPrefixedCitations("You shipped X [from commit: feat(cli): do a thing]."))
      .toBe("You shipped X [commit: feat(cli): do a thing].");
  });

  it("rewrites every structured class (task/event/reminder/session/feed/contact/command/memory/action)", () => {
    expect(normalizeFromPrefixedCitations("a [from task: ship it] b [from event: standup] c [from reminder: call mom]"))
      .toBe("a [task: ship it] b [event: standup] c [reminder: call mom]");
    expect(normalizeFromPrefixedCitations("[from action: sent the email] [from memory: home_city]"))
      .toBe("[action: sent the email] [memory: home_city]");
  });

  it("leaves a REAL note citation untouched (no class keyword)", () => {
    expect(normalizeFromPrefixedCitations("see [from vpn.md] and [from projects/notes.md]."))
      .toBe("see [from vpn.md] and [from projects/notes.md].");
    // a note whose name merely STARTS with a class word but has no ':' is safe
    expect(normalizeFromPrefixedCitations("[from commit-log.md]")).toBe("[from commit-log.md]");
  });

  it("the rewritten commit citation then survives the gate (the false-strip is gone)", () => {
    const normalized = normalizeFromPrefixedCitations("You shipped the HTML reader [from commit: feat(cli): html reader].");
    const gated = enforceAnswerCitations(normalized, { commits: ["feat(cli): html reader"] });
    expect(gated.stripped).toEqual([]);
    expect(gated.text).toContain("[commit: feat(cli): html reader]");
  });
});

describe("normalizeSlotCitations — rewrite a SLOT-numbered structured citation (the session false-strip)", () => {
  const slots = {
    session: ["We set up the office VPN: WireGuard MTU 1380.", "Discussed the Q3 budget: $42,000."],
    event: ["Dentist appointment", "Team standup"]
  };

  it("rewrites `[from session 1]` to `[session: <slot-1 summary>]`", () => {
    expect(normalizeSlotCitations("We chose MTU 1380 [from session 1].", slots))
      .toBe("We chose MTU 1380 [session: We set up the office VPN: WireGuard MTU 1380.].");
  });

  it("rewrites the BARE slot form `[feed 1]` / `[session 1]` (no 'from') — the feed-citation case", () => {
    const feedSlots = { feed: ["HN", "Lobsters"] };
    expect(normalizeSlotCitations("Top story [feed 1], then [feed 2].", feedSlots))
      .toBe("Top story [feed: HN], then [feed: Lobsters].");
    expect(normalizeSlotCitations("We discussed [session 2].", slots))
      .toBe("We discussed [session: Discussed the Q3 budget: $42,000.].");
  });

  it("ignores a trailing `— <id>` the model echoes from the `<<session N — id>>` marker", () => {
    expect(normalizeSlotCitations("MTU 1380 [from session 1 — ep_001].", slots))
      .toBe("MTU 1380 [session: We set up the office VPN: WireGuard MTU 1380.].");
  });

  it("maps the right slot (event 2 → the second event title)", () => {
    expect(normalizeSlotCitations("It's the [from event 2].", slots)).toBe("It's the [event: Team standup].");
  });

  it("leaves an out-of-range slot or an unknown class untouched", () => {
    expect(normalizeSlotCitations("[from session 9]", slots)).toBe("[from session 9]");
    expect(normalizeSlotCitations("[from notes 1]", slots)).toBe("[from notes 1]"); // 'notes' isn't a structured class
  });

  it("the rewritten session citation then survives the gate (the false-strip is gone)", () => {
    const normalized = normalizeSlotCitations("We chose MTU 1380 [from session 1].", slots);
    const gated = enforceAnswerCitations(normalized, { sessions: slots.session });
    expect(gated.stripped).toEqual([]);
    expect(gated.text).toContain("[session: We set up the office VPN");
  });
});
