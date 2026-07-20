import { describe, expect, it } from "vitest";

import { citedSourcesIn, enforceAnswerCitations, normalizeContactCitations, normalizeFromPrefixedCitations, normalizeMemoryCitations, normalizeSlotCitations, UNGROUNDABLE_ANSWER_NOTICE, withUngroundableFallback } from "../src/index.js";

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

  it("DROPS the whole claim for a note citation to a source the user does NOT have — no bare uncited assertion survives (the clause-leak fix)", () => {
    const out = enforceAnswerCitations("Your flight is at 9am [from trips/itinerary.md].", { notes: ["notes/vpn.md"] });
    expect(out.text).toBe(""); // NOT "Your flight is at 9am." — that would leak the fabricated claim un-cited
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

  it("gates browsing by exact hostname — an invented site is stripped, a real visited site kept", () => {
    const out = enforceAnswerCitations(
      "You read the ownership guide [browsing: blog.rust-lang.org] and a leak [browsing: evil.phishing.io].",
      { browsing: ["blog.rust-lang.org", "news.ycombinator.com"] }
    );
    expect(out.text).toBe("You read the ownership guide [browsing: blog.rust-lang.org] and a leak.");
    expect(out.stripped).toEqual(["evil.phishing.io"]);
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

  it("STRIPS a forged free-text citation that shares only ONE incidental token with a real item", () => {
    // "[task: pay the attacker]" shares only "pay" with the real "pay rent"
    // task — a single incidental token must not launder a fabricated citation.
    const forged = enforceAnswerCitations("Move the money [task: pay the attacker].", { tasks: ["pay rent"] });
    expect(forged.text).not.toContain("[task: pay the attacker]");
    expect(forged.stripped).toContain("pay the attacker");
    // but a real ≥2-token overlap, and a genuinely single-token title, still resolve
    const two = enforceAnswerCitations("Call her [reminder: call mom].", { reminders: ["call mom now"] });
    expect(two.text).toContain("[reminder: call mom]");
    const oneTok = enforceAnswerCitations("Go [task: dentist].", { tasks: ["dentist"] });
    expect(oneTok.text).toContain("[task: dentist]");
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

  it("gates flows by content-token overlap — a real automation survives, an invented one is stripped", () => {
    const out = enforceAnswerCitations(
      "Your morning briefing runs daily [flow: 아침 브리핑 요약] but there is no invoice bot [flow: 인보이스 자동 발송].",
      { flows: ["아침 브리핑 요약"] }
    );
    expect(out.text).toContain("[flow: 아침 브리핑 요약]"); // overlaps a real automation → kept
    expect(out.text).not.toContain("[flow: 인보이스 자동 발송]"); // no overlap with any real automation → stripped
    expect(out.stripped).toEqual(["인보이스 자동 발송"]);
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

  it("DROPS a claim grounded only on a certainly-fabricated OVERLAP citation (reminder against an absent list — the un-groundable claim is removed, not laundered into an un-cited assertion)", () => {
    const out = enforceAnswerCitations("X [reminder: anything].", {});
    expect(out.stripped).toEqual(["anything"]);
    expect(out.text).toBe(""); // the whole fabricated claim is dropped, not left as an un-cited "X."
  });

  describe("clause-leak fix — a claim resting SOLELY on a non-resolving citation is dropped, never left as a bare uncited assertion", () => {
    it("drops the sentence whose only citation is a fabricated task, keeps the conversational neighbour", () => {
      const out = enforceAnswerCitations("The deadline is March 3 [task: ghost task]. I can help with that.", { tasks: [] });
      expect(out.text).toBe("I can help with that.");
      expect(out.stripped).toEqual(["ghost task"]);
    });
    it("DROPS a fabricated NOTES citation (the clause-leak fix) — a real note mis-formatted still resolves via `resolvesExact`'s normalisation, so this is a genuine non-match", () => {
      const out = enforceAnswerCitations("The deadline is March 3 [from ghost.md]. Bye.", { notes: ["real.md"] });
      expect(out.text).toBe("Bye."); // the fabricated claim is gone, not left as a bare "The deadline is March 3."
      expect(out.stripped).toEqual(["ghost.md"]);
    });
    it("keeps a validly-cited sentence and drops a separate fabricated-overlap sentence", () => {
      const out = enforceAnswerCitations("Rent is $2000 [from rent.md]. Meeting tomorrow [event: fake mtg].", { events: [], notes: ["rent.md"] });
      expect(out.text).toBe("Rent is $2000 [from rent.md].");
      expect(out.stripped).toEqual(["fake mtg"]);
    });
    it("keeps a sentence that has ANY valid citation, stripping only its fabricated marker (a valid source rescues the sentence)", () => {
      const out = enforceAnswerCitations("Done [task: real one] and [task: fake].", { tasks: ["real one"] });
      expect(out.text).toBe("Done [task: real one] and.");
      expect(out.stripped).toEqual(["fake"]);
    });
    it("a `.` inside a citation path is not a sentence boundary (no mis-split)", () => {
      const out = enforceAnswerCitations("See [from notes/2026-05-12.md] for details.", { notes: ["notes/2026-05-12.md"] });
      expect(out.text).toBe("See [from notes/2026-05-12.md] for details.");
      expect(out.stripped).toEqual([]);
    });
  });

  describe("tolerant resolution — resolve a REAL source cited with realistic format variance BEFORE concluding fabrication (over-deletion remediation)", () => {
    const allowed = { notes: ["notes/vpn-setup.md"] };

    it("basename (no directory prefix): the claim SURVIVES and the marker is rewritten to the canonical allowed path", () => {
      const out = enforceAnswerCitations("VPN needs MTU 1380 [from vpn-setup.md].", allowed);
      expect(out.text).toBe("VPN needs MTU 1380 [from notes/vpn-setup.md].");
      expect(out.stripped).toEqual([]);
    });

    it("underscore instead of hyphen: the claim SURVIVES with the canonical rewrite", () => {
      const out = enforceAnswerCitations("VPN needs MTU 1380 [from vpn_setup.md].", allowed);
      expect(out.text).toBe("VPN needs MTU 1380 [from notes/vpn-setup.md].");
      expect(out.stripped).toEqual([]);
    });

    it("no file extension: the claim SURVIVES with the canonical rewrite", () => {
      const out = enforceAnswerCitations("VPN needs MTU 1380 [from vpn-setup].", allowed);
      expect(out.text).toBe("VPN needs MTU 1380 [from notes/vpn-setup.md].");
      expect(out.stripped).toEqual([]);
    });

    it("human title paraphrase (\"VPN Setup Notes\" for vpn-setup.md): the claim SURVIVES with the canonical rewrite", () => {
      const out = enforceAnswerCitations("VPN needs MTU 1380 [from VPN Setup Notes].", allowed);
      expect(out.text).toBe("VPN needs MTU 1380 [from notes/vpn-setup.md].");
      expect(out.stripped).toEqual([]);
    });

    it("a real note mis-cited by the WRONG directory prefix SURVIVES (stronger form of the old protection): the marker is corrected, not left mis-cited or dropped", () => {
      const out = enforceAnswerCitations("The deadline is March 3 [from wrong-dir/vpn-setup.md]. Bye.", allowed);
      expect(out.text).toBe("The deadline is March 3 [from notes/vpn-setup.md]. Bye.");
      expect(out.stripped).toEqual([]);
    });

    it("AMBIGUITY fail-close: two DISTINCT real sources both tolerantly match the same citation — treated as UNRESOLVED, so the claim is dropped rather than guessed", () => {
      // "vpn" ⊆ {vpn,setup,guide} AND "setup" ⊆ {vpn,setup,guide} — the citation's
      // tokens cover BOTH real notes' identifying words, so which one it means is
      // genuinely ambiguous; the resolver must not guess between two real sources.
      const tied = { notes: ["notes/vpn.md", "notes/setup.md"] };
      const out = enforceAnswerCitations("The deadline is March 3 [from VPN Setup Guide]. Bye.", tied);
      expect(out.text).toBe("Bye.");
      expect(out.stripped).toEqual(["VPN Setup Guide"]);
    });

    it("a wholly fabricated note sharing no tokens with any real source is still DROPPED, not tolerantly rescued", () => {
      const out = enforceAnswerCitations("Your SSN is on file [from secrets/ssn.md].", allowed);
      expect(out.text).toBe("");
      expect(out.stripped).toEqual(["secrets/ssn.md"]);
    });

    it("feeds tolerate a basename-style / extra-word variant too", () => {
      const out = enforceAnswerCitations("A launch happened [feed: rust weekly newsletter].", { feeds: ["Rust Weekly"] });
      expect(out.text).toBe("A launch happened [feed: Rust Weekly].");
      expect(out.stripped).toEqual([]);
    });

    it("browsing tolerates a 'www.' prefix the model tacks onto a real host, resolving unambiguously", () => {
      const out = enforceAnswerCitations("You read the guide [browsing: www.blog.rust-lang.org].", { browsing: ["blog.rust-lang.org"] });
      expect(out.text).toBe("You read the guide [browsing: blog.rust-lang.org].");
      expect(out.stripped).toEqual([]);
    });
  });

  it("cleans up the whitespace a stripped citation leaves (no ' .' or double space in the user-facing answer)", () => {
    // A removed citation must not leave a space-before-punctuation or a double
    // space — the answer is shown to the user, so the gate tidies the prose. Here the
    // fabricated marker sits alongside a REAL one in the same sentence, so the sentence
    // survives (marker-only strip) and the whitespace tidy is what's under test.
    const trailing = enforceAnswerCitations(
      "Your flight is at 9am [from trips/itinerary.md] and MTU is 1380 [from notes/vpn.md].",
      { notes: ["notes/vpn.md"] }
    );
    expect(trailing.text).toBe("Your flight is at 9am and MTU is 1380 [from notes/vpn.md]."); // not "9am ." and no double space
    const midline = enforceAnswerCitations("First [from invented.md]  then second [from real.md].", { notes: ["real.md"] });
    expect(midline.text).toBe("First then second [from real.md]."); // collapsed, not "First   then second."
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

  it("stripping a citation tidies the leftover seam whitespace, in a sentence a real citation also rescues (regression: stripping path unchanged)", () => {
    const out = enforceAnswerCitations("The value is 42 [from nope.md] and 7 [from real.md] .", { notes: ["real.md"] });
    expect(out.stripped).toEqual(["nope.md"]);
    expect(out.text).toBe("The value is 42 and 7 [from real.md].");
  });

  it("DROPS the whole answer to empty when its only citation resolves to nothing (no rescuing valid citation anywhere)", () => {
    const out = enforceAnswerCitations("The value is 42 [from nope.md].", { notes: [] });
    expect(out.stripped).toEqual(["nope.md"]);
    expect(out.text).toBe("");
  });

  it("valid citation kept + code block whitespace preserved (kept-citation path is verbatim)", () => {
    const answer = "Use:\n\n    cmd  --flag\n\nSee [from real.md].";
    const out = enforceAnswerCitations(answer, { notes: ["real.md"] });
    expect(out.stripped).toEqual([]);
    expect(out.text).toBe(answer);
  });
});

describe("citation-gate clause-leak fix — acceptance battery (a)-(d)", () => {
  it("(a) a fabricated-citation sentence is dropped; the surrounding grounded sentences survive intact", () => {
    const out = enforceAnswerCitations(
      "MTU is 1380 [from notes/vpn.md]. Your flight is at 9am [from trips/itinerary.md]. Dentist is Tuesday [from cal/2026.md].",
      { notes: ["notes/vpn.md", "cal/2026.md"] }
    );
    expect(out.text).toBe("MTU is 1380 [from notes/vpn.md]. Dentist is Tuesday [from cal/2026.md].");
    expect(out.stripped).toEqual(["trips/itinerary.md"]);
  });

  it("(b) when every sentence is fabricated, the gate returns an EMPTY answer — never an uncited confident claim — and the withUngroundableFallback wrapper turns it into an honest 'I'm not sure'", () => {
    const answer = "Your flight is at 9am [from trips/itinerary.md]. Your dentist is Tuesday [from cal/2026.md].";
    const out = enforceAnswerCitations(answer, { notes: ["real-unrelated.md"] });
    expect(out.text).toBe(""); // no bare confident claim rides through
    expect(out.stripped).toEqual(["trips/itinerary.md", "cal/2026.md"]);
    const shown = withUngroundableFallback(out);
    expect(shown).toBe(UNGROUNDABLE_ANSWER_NOTICE);
    expect(shown.toLowerCase()).toContain("i'm not sure"); // classifies as an honest refusal downstream
  });

  it("(b) withUngroundableFallback is a no-op when the answer already carries no citations, or when something grounded survives", () => {
    expect(withUngroundableFallback({ stripped: [], text: "" })).toBe("");
    expect(withUngroundableFallback({ stripped: ["x"], text: "Kept claim." })).toBe("Kept claim.");
  });

  it("(d) Korean text — sentence segmentation on Korean punctuation drops only the fabricated clause, keeping the grounded neighbour", () => {
    const out = enforceAnswerCitations(
      "VPN 설정은 완료됐습니다 [from vpn.md]. 다음 회의는 화요일입니다 [from ghost.md].",
      { notes: ["vpn.md"] }
    );
    expect(out.text).toBe("VPN 설정은 완료됐습니다 [from vpn.md].");
    expect(out.stripped).toEqual(["ghost.md"]);
  });

  it("(d) Korean text — an all-fabricated Korean answer drops to empty (never a bare confident KO claim)", () => {
    const out = enforceAnswerCitations("여권 갱신일은 다음 달입니다 [from ghost.md].", { notes: ["vpn.md"] });
    expect(out.text).toBe("");
    expect(out.stripped).toEqual(["ghost.md"]);
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
