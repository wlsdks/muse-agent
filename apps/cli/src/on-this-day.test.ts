import { describe, expect, it } from "vitest";

import { extractNoteDate, formatOnThisDay, selectOnThisDay } from "./on-this-day.js";

describe("extractNoteDate — explicit YYYY-MM-DD from the path only", () => {
  it("parses a dated journal path", () => {
    expect(extractNoteDate("journal/2025-06-06.md")?.getFullYear()).toBe(2025);
    expect(extractNoteDate("journal/2025-06-06.md")?.getMonth()).toBe(5); // June = 5
    expect(extractNoteDate("journal/2025-06-06.md")?.getDate()).toBe(6);
  });

  it("is undefined for an undated path", () => {
    expect(extractNoteDate("ideas/vpn-config.md")).toBeUndefined();
  });

  it("rejects an impossible calendar date (no false anniversary)", () => {
    expect(extractNoteDate("notes/2025-02-30.md")).toBeUndefined(); // Feb 30 overflows
    expect(extractNoteDate("notes/2025-13-01.md")).toBeUndefined(); // month 13
  });
});

describe("selectOnThisDay — same calendar day, prior years, most-recent first", () => {
  const now = new Date(2026, 5, 6); // June 6, 2026
  const dated = (id: string): { id: string; date: Date } => ({ date: extractNoteDate(id)!, id });

  it("matches notes from prior years on the exact day and orders them most-recent first", () => {
    const notes = [dated("j/2025-06-06.md"), dated("j/2023-06-06.md"), dated("j/2024-06-06.md")];
    const hits = selectOnThisDay(notes, now);
    expect(hits.map((h) => h.id)).toEqual(["j/2025-06-06.md", "j/2024-06-06.md", "j/2023-06-06.md"]);
    expect(hits.map((h) => h.yearsAgo)).toEqual([1, 2, 3]);
  });

  it("excludes a note from a DIFFERENT day and one from THIS year (only earlier years count)", () => {
    const notes = [dated("j/2025-06-07.md"), dated("j/2026-06-06.md"), dated("j/2024-06-06.md")];
    expect(selectOnThisDay(notes, now).map((h) => h.id)).toEqual(["j/2024-06-06.md"]);
  });

  it("honours a ±windowDays tolerance", () => {
    const notes = [dated("j/2025-06-07.md"), dated("j/2025-06-05.md"), dated("j/2025-06-09.md")];
    expect(selectOnThisDay(notes, now, { windowDays: 1 }).map((h) => h.id).sort()).toEqual(["j/2025-06-05.md", "j/2025-06-07.md"]);
    expect(selectOnThisDay(notes, now, { windowDays: 0 })).toEqual([]);
  });

  it("returns [] when nothing matches", () => {
    expect(selectOnThisDay([], now)).toEqual([]);
  });
});

describe("formatOnThisDay", () => {
  it("renders the dated hits, '' when empty", () => {
    const now = new Date(2026, 5, 6);
    const out = formatOnThisDay(selectOnThisDay([{ date: new Date(2024, 5, 6), id: "j/2024-06-06.md" }], now), now);
    expect(out).toContain("On this day");
    expect(out).toContain("2 years ago");
    expect(formatOnThisDay([], now)).toBe("");
  });
});
