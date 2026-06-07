import { describe, expect, it } from "vitest";

import { normalizeStartsAt, shapeVisionAction } from "./vision-actions.js";

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
