import { describe, expect, it } from "vitest";

import { dropUnverifiedOptional, fieldIsGrounded, gateVisionAction, normalizeStartsAt, shapeVisionAction, splitUnverified } from "./vision-actions.js";

describe("shapeVisionAction", () => {
  it("routes an event with title+startsAt to the calendar", () => {
    const a = shapeVisionAction({ kind: "event", title: "Jazz Night", startsAt: "July 18 8pm", location: "Seoul" });
    expect(a.route).toBe("calendar");
    expect(a.fields).toMatchObject({ title: "Jazz Night", startsAt: "July 18 8pm", location: "Seoul" });
    expect(a.draftText).toContain("Jazz Night");
  });

  it("routes a receipt to a note with a composed expense line", () => {
    const a = shapeVisionAction({ kind: "receipt", merchant: "Blue Bottle", total: "11,300 KRW", date: "2026-06-07" });
    expect(a.route).toBe("note");
    expect(String(a.fields.note)).toBe("Expense — Blue Bottle: 11,300 KRW on 2026-06-07");
  });

  it("routes a contact (name + email/phone) to contacts", () => {
    const a = shapeVisionAction({ kind: "contact", name: "Dr. Park", phone: "010-1234-5678", relationship: "dentist" });
    expect(a.route).toBe("contact");
    expect(a.fields).toMatchObject({ name: "Dr. Park", phone: "010-1234-5678", relationship: "dentist" });
  });

  it("routes a document (title+body) to a note with a titled path and markdown body", () => {
    const a = shapeVisionAction({ kind: "document", title: "Meeting Notes", body: "discuss roadmap" });
    expect(a.route).toBe("note");
    expect(a.fields.path).toBe("meeting-notes.md");
    expect(String(a.fields.note)).toBe("# Meeting Notes\n\ndiscuss roadmap\n");
  });

  it("falls back to 'none' when the kind's required fields are missing (no fabrication)", () => {
    expect(shapeVisionAction({ kind: "event", title: "No date here" }).route).toBe("none"); // missing startsAt
    expect(shapeVisionAction({ kind: "contact", name: "Anon" }).route).toBe("none"); // no email/phone
    expect(shapeVisionAction({ kind: "other" }).route).toBe("none");
    expect(shapeVisionAction({ kind: "receipt" }).route).toBe("none"); // no merchant/total
  });

  it("treats an unknown kind as 'other'", () => {
    expect(shapeVisionAction({ kind: "weird" }).kind).toBe("other");
    expect(shapeVisionAction({}).kind).toBe("other");
  });

  it("ignores blank-string fields (whitespace is not 'visible')", () => {
    expect(shapeVisionAction({ kind: "event", title: "   ", startsAt: "8pm" }).route).toBe("none");
  });
});

describe("fieldIsGrounded — tolerant matching (no false-drop), catches hallucination", () => {
  it("grounds an ISO date against a WORDED-month transcription via the year (fire-5 defect a)", () => {
    expect(fieldIsGrounded("2026-06-07", "Invoice date: June 7, 2026 — paid")).toBe(true);
  });

  it("grounds a country-code phone against the local-format transcription (fire-5 defect a)", () => {
    expect(fieldIsGrounded("+1-415-555-0123", "Call us at 415-555-0123 today")).toBe(true);
  });

  it("grounds an amount despite a thousands separator", () => {
    expect(fieldIsGrounded("123,450 KRW", "Total due ₩123,450")).toBe(true);
    expect(fieldIsGrounded("11,300", "11,300 KRW")).toBe(true);
  });

  it("grounds a text field by word/entity tokens (incl. CJK)", () => {
    expect(fieldIsGrounded("Cafe Muse", "CAFE MUSE — receipt")).toBe(true);
    expect(fieldIsGrounded("강남 치과", "강남 치과 의원 영수증")).toBe(true);
  });

  it("does NOT ground a hallucinated value absent from the image", () => {
    expect(fieldIsGrounded("Starbucks", "Cafe Muse total 12,400")).toBe(false);
    expect(fieldIsGrounded("2026-06-07", "no date visible here at all")).toBe(false);
    expect(fieldIsGrounded("99,999", "Total ₩12,400")).toBe(false);
  });

  it("does NOT ground a bare SHORT-numeric value on a coincidental digit match (weak-numeric guard)", () => {
    // "50" only appears as a discount %, not as a grounded field — must not pass.
    expect(fieldIsGrounded("50", "Cafe Muse — 50% loyalty discount, total 12,400")).toBe(false);
    // "12" only appears inside a time "12:30" — coincidental, must not pass.
    expect(fieldIsGrounded("12", "Meeting at 12:30 with the team")).toBe(false);
  });

  it("STILL grounds ≥4-digit and text/CJK values (no over-drop from the weak-numeric guard)", () => {
    expect(fieldIsGrounded("12,400", "Cafe Muse total 12,400")).toBe(true);
    expect(fieldIsGrounded("2026", "Concert in 2026 at Seoul Hall")).toBe(true);
    expect(fieldIsGrounded("Cafe Muse", "CAFE MUSE — receipt")).toBe(true);
    expect(fieldIsGrounded("강남 치과", "강남 치과 의원 영수증")).toBe(true);
  });
});

describe("fieldIsGrounded — amount-role anchoring (fire-6: leak + over-drop on amounts)", () => {
  it("LEAK closed: a hallucinated amount whose run coincides with a YEAR (no currency anchor) is NOT grounded", () => {
    // "$2026" — its 2026 run sits next to "Concert"/"Hall", no currency marker ⇒ false.
    expect(fieldIsGrounded("$2026", "Concert 2026 — Main Hall — ticket $40", "total")).toBe(false);
  });

  it("OVER-DROP repaired: a REAL small amount next to a currency marker IS grounded", () => {
    // "$40" — run 40 sits next to "$" ⇒ true (the fire-4 weak-numeric guard wrongly dropped it).
    expect(fieldIsGrounded("$40", "Concert 2026 — Main Hall — ticket $40", "total")).toBe(true);
  });

  it("grounds a real ≥4-digit amount with a currency anchor; rejects a hallucinated one", () => {
    expect(fieldIsGrounded("12,400", "Cafe Muse total 12,400", "total")).toBe(true);
    expect(fieldIsGrounded("99,999", "Total ₩12,400", "total")).toBe(false);
  });

  it("grounds a small amount next to a word amount-marker (total/due/paid)", () => {
    expect(fieldIsGrounded("40", "ticket total 40", "total")).toBe(true);
    expect(fieldIsGrounded("25", "Amount due 25", "total")).toBe(true);
  });

  it("rejects a small amount run with NO adjacent currency/amount marker", () => {
    // 40 appears only inside "2040" address fragment / no marker ⇒ false.
    expect(fieldIsGrounded("$40", "Hall row 40A, gate 12", "total")).toBe(false);
  });

  it("amount-role only changes amount NAMES — passing an amount name leaves non-amount text/date untouched", () => {
    // Non-amount field names are unaffected by the amount path even when a name is passed.
    expect(fieldIsGrounded("Cafe Muse", "CAFE MUSE — receipt", "merchant")).toBe(true);
    expect(fieldIsGrounded("2026-06-07", "Invoice date: June 7, 2026 — paid", "date")).toBe(true);
    expect(fieldIsGrounded("강남 치과", "강남 치과 의원 영수증", "merchant")).toBe(true);
    expect(fieldIsGrounded("010-1234-5678", "Call 010-1234-5678", "phone")).toBe(true);
  });

  it("back-compat: omitting the name reproduces today's exact behavior (incl. the fire-4 weak-numeric guard)", () => {
    // The over-drop is the OLD behavior when name is absent — unchanged.
    expect(fieldIsGrounded("$40", "Concert 2026 — Main Hall — ticket $40")).toBe(false);
    expect(fieldIsGrounded("$2026", "Concert 2026 — Main Hall — ticket $40")).toBe(true);
    expect(fieldIsGrounded("12,400", "Cafe Muse total 12,400")).toBe(true);
  });
});

describe("gateVisionAction — grounding gate over a shaped action", () => {
  it("leaves a fully-grounded action with no unverified fields (no over-drop on real data)", () => {
    const action = shapeVisionAction({ date: "2026-06-07", kind: "receipt", merchant: "Cafe Muse", total: "12,400" });
    const gated = gateVisionAction(action, "Cafe Muse\nTotal: 12,400 KRW\nDate: June 7, 2026");
    expect(gated.unverified).toEqual([]);
    expect(gated.draftText).not.toContain("unverified");
  });

  it("flags a hallucinated field as unverified and annotates the draft", () => {
    const action = shapeVisionAction({ kind: "receipt", merchant: "Starbucks", total: "12,400" });
    const gated = gateVisionAction(action, "Cafe Muse\nTotal: 12,400 KRW");
    expect(gated.unverified).toContain("merchant");
    expect(gated.unverified).not.toContain("total");
    expect(gated.draftText).toContain("unverified");
  });

  it("fails CLOSED on empty/failed evidence — every extracted field is unverified (fire-5 defect b)", () => {
    const action = shapeVisionAction({ kind: "receipt", merchant: "Cafe Muse", total: "12,400" });
    expect(gateVisionAction(action, "").unverified).toEqual(expect.arrayContaining(["merchant", "total"]));
    expect(gateVisionAction(action, undefined).unverified).toEqual(expect.arrayContaining(["merchant", "total"]));
  });

  it("does not gate a non-routed action", () => {
    expect(gateVisionAction(shapeVisionAction({ kind: "other" }), undefined).unverified).toEqual([]);
  });

  it("OUTCOME (fire-6): a year-coincidence total lands in unverified; a real $-anchored small total does not", () => {
    // total "$2026" — 2026 is only a year in evidence, no $2026 amount ⇒ unverified.
    const hall = shapeVisionAction({ kind: "receipt", merchant: "Concert", total: "$2026" });
    const gatedHall = gateVisionAction(hall, "Concert 2026 — Main Hall — ticket $40");
    expect(gatedHall.unverified).toContain("total");

    // total "$40" — matches the "$40" run ⇒ NOT unverified.
    const real = shapeVisionAction({ kind: "receipt", merchant: "Concert", total: "$40" });
    const gatedReal = gateVisionAction(real, "Concert 2026 — Main Hall — ticket $40");
    expect(gatedReal.unverified).not.toContain("total");
  });

  it("OUTCOME: a hallucinated SHORT total lands in unverified, a genuine ≥4-digit total stays grounded", () => {
    const hallucinated = shapeVisionAction({ kind: "receipt", merchant: "Cafe Muse", total: "50" });
    const gatedHall = gateVisionAction(hallucinated, "Cafe Muse — 50% loyalty discount, total 12,400");
    expect(gatedHall.unverified).toContain("total");

    const genuine = shapeVisionAction({ kind: "receipt", merchant: "Cafe Muse", total: "12,400" });
    const gatedGenuine = gateVisionAction(genuine, "Cafe Muse — 50% loyalty discount, total 12,400");
    expect(gatedGenuine.unverified).toEqual([]);
  });
});

describe("splitUnverified — field-level fail-close (REQUIRED blocks, OPTIONAL drops)", () => {
  it("DROPPABLE: a receipt with grounded merchant+total but an un-grounded date drops the date only", () => {
    // merchant+total visible, date hallucinated (absent from evidence).
    const action = shapeVisionAction({ date: "2026-06-99", kind: "receipt", merchant: "Cafe Muse", total: "12,400" });
    const gated = gateVisionAction(action, "Cafe Muse\nTotal: 12,400 KRW");
    expect(gated.unverified).toEqual(["date"]);
    const split = splitUnverified(gated);
    expect(split).toEqual({ blocking: [], droppable: ["date"] });

    // Recompose drops the date — and it must NOT leak into the persisted note/body.
    const applied = dropUnverifiedOptional(gated, split.droppable);
    expect(applied.fields.date).toBeUndefined();
    expect(String(applied.fields.note)).toBe("Expense — Cafe Muse: 12,400");
    expect(String(applied.fields.note)).not.toContain("2026-06-99");
    expect(applied.draftText).not.toContain("2026-06-99");
    expect(applied.unverified).toEqual([]);
  });

  it("BLOCKING: a receipt whose REQUIRED merchant is un-grounded blocks the whole action", () => {
    const action = shapeVisionAction({ kind: "receipt", merchant: "Starbucks", total: "12,400" });
    const gated = gateVisionAction(action, "Cafe Muse\nTotal: 12,400 KRW");
    expect(gated.unverified).toContain("merchant");
    const split = splitUnverified(gated);
    expect(split.blocking).toContain("merchant");
    expect(split.blocking.length).toBeGreaterThan(0);
  });

  it("EMPTY: a fully-grounded action splits to empty/empty and recomposes unchanged", () => {
    const action = shapeVisionAction({ date: "2026-06-07", kind: "receipt", merchant: "Cafe Muse", total: "12,400" });
    const gated = gateVisionAction(action, "Cafe Muse\nTotal: 12,400 KRW\nDate: June 7, 2026");
    expect(splitUnverified(gated)).toEqual({ blocking: [], droppable: [] });
    expect(dropUnverifiedOptional(gated, [])).toBe(gated);
  });

  it("EVENT kind: REQUIRED title/startsAt block; OPTIONAL location/notes drop (required-map is not receipt-only)", () => {
    // title+startsAt grounded, location hallucinated.
    const action = shapeVisionAction({ kind: "event", location: "Busan", startsAt: "2026-07-18", title: "Jazz Night" });
    const gated = gateVisionAction(action, "Jazz Night — 2026-07-18 at Seoul Hall");
    expect(gated.unverified).toEqual(["location"]);
    expect(splitUnverified(gated)).toEqual({ blocking: [], droppable: ["location"] });
    const applied = dropUnverifiedOptional(gated, ["location"]);
    expect(applied.fields.location).toBeUndefined();
    expect(applied.draftText).not.toContain("Busan");
    expect(applied.route).toBe("calendar");

    // An un-grounded REQUIRED startsAt blocks.
    const hall = gateVisionAction(shapeVisionAction({ kind: "event", startsAt: "2099-01-01", title: "Jazz Night" }), "Jazz Night — 2026-07-18");
    expect(splitUnverified(hall).blocking).toContain("startsAt");
  });
});

describe("normalizeStartsAt", () => {
  it("converts a parseable absolute date (with the comma format the calendar parser rejects) to ISO", () => {
    process.env.TZ = "Asia/Seoul";
    // "July 18, 2026, 8:00 PM" in Asia/Seoul = 11:00 UTC
    expect(normalizeStartsAt("July 18, 2026, 8:00 PM")).toBe("2026-07-18T11:00:00.000Z");
  });

  it("passes an ISO-8601 string through untouched", () => {
    expect(normalizeStartsAt("2026-07-18T11:00:00.000Z")).toBe("2026-07-18T11:00:00.000Z");
    expect(normalizeStartsAt("2026-07-18")).toBe("2026-07-18");
  });

  it("passes a relative phrase through unchanged (the calendar's NL resolver handles it)", () => {
    expect(normalizeStartsAt("내일 오후 3시")).toBe("내일 오후 3시");
    expect(normalizeStartsAt("tomorrow 9am")).toBe("tomorrow 9am");
    expect(normalizeStartsAt("next monday 6pm")).toBe("next monday 6pm");
  });
});
