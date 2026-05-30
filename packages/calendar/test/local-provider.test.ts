import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CalendarProviderError, CalendarValidationError } from "../src/errors.js";
import { LocalCalendarProvider } from "../src/local-provider.js";

// Direct coverage for the local file-backed calendar provider (untested module;
// calendar is a low test-density package). A lost/mis-filtered event is a missed
// appointment, so the CRUD round-trip, the range OVERLAP filter, and the
// validation guards are the load-bearing behaviors.

const dirs: string[] = [];
afterEach(() => { dirs.length = 0; });
const freshFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "muse-cal-"));
  dirs.push(dir);
  return join(dir, "calendar.json");
};
const d = (iso: string): Date => new Date(iso);
const seq = () => { let n = 0; return () => `e${(n++).toString()}`; };

describe("LocalCalendarProvider", () => {
  it("describes itself as local and round-trips a created event through a fresh provider (persisted to disk)", async () => {
    const file = freshFile();
    const p = new LocalCalendarProvider({ file, idFactory: seq() });
    expect(p.describe().local).toBe(true);
    await p.createEvent({ endsAt: d("2026-05-15T09:30:00Z"), startsAt: d("2026-05-15T09:00:00Z"), title: "Standup" });
    // a brand-new provider re-reads the same file (post-restart view)
    const fresh = new LocalCalendarProvider({ file });
    const events = await fresh.listEvents({ from: d("2026-05-15T00:00:00Z"), to: d("2026-05-16T00:00:00Z") });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ providerId: "local", title: "Standup" });
  });

  it("listEvents returns OVERLAPPING events sorted by start (a window between events is empty)", async () => {
    const file = freshFile();
    const p = new LocalCalendarProvider({ file, idFactory: seq() });
    await p.createEvent({ endsAt: d("2026-05-15T13:00:00Z"), startsAt: d("2026-05-15T12:00:00Z"), title: "Lunch" });
    await p.createEvent({ endsAt: d("2026-05-15T09:30:00Z"), startsAt: d("2026-05-15T09:00:00Z"), title: "Standup" });
    const all = await p.listEvents({ from: d("2026-05-15T00:00:00Z"), to: d("2026-05-16T00:00:00Z") });
    expect(all.map((e) => e.title)).toEqual(["Standup", "Lunch"]); // sorted by startsAt
    // a window strictly between the two events overlaps neither
    expect(await p.listEvents({ from: d("2026-05-15T11:00:00Z"), to: d("2026-05-15T11:30:00Z") })).toEqual([]);
    // a window inside the standup overlaps it
    expect((await p.listEvents({ from: d("2026-05-15T09:15:00Z"), to: d("2026-05-15T09:20:00Z") })).map((e) => e.title)).toEqual(["Standup"]);
  });

  it("rejects an empty title and an end-before-start range on create", async () => {
    const p = new LocalCalendarProvider({ file: freshFile(), idFactory: seq() });
    await expect(p.createEvent({ endsAt: d("2026-05-15T10:00:00Z"), startsAt: d("2026-05-15T09:00:00Z"), title: "  " }))
      .rejects.toMatchObject({ code: "INVALID_TITLE" });
    await expect(p.createEvent({ endsAt: d("2026-05-15T09:00:00Z"), startsAt: d("2026-05-15T10:00:00Z"), title: "Bad" }))
      .rejects.toBeInstanceOf(CalendarValidationError);
  });

  it("updateEvent merges fields, keeps the id/start when unset, and validates the merged range", async () => {
    const file = freshFile();
    const p = new LocalCalendarProvider({ file, idFactory: seq() });
    await p.createEvent({ endsAt: d("2026-05-15T09:30:00Z"), startsAt: d("2026-05-15T09:00:00Z"), title: "Standup" });
    const updated = await p.updateEvent("e0", { title: "Standup (moved)" });
    expect(updated).toMatchObject({ id: "e0", title: "Standup (moved)" });
    expect(updated.startsAt.toISOString()).toBe("2026-05-15T09:00:00.000Z"); // unchanged field preserved
    await expect(p.updateEvent("missing", { title: "x" })).rejects.toBeInstanceOf(CalendarProviderError);
    await expect(p.updateEvent("e0", { endsAt: d("2026-05-15T08:00:00Z"), startsAt: d("2026-05-15T10:00:00Z") }))
      .rejects.toMatchObject({ code: "INVALID_TIME_RANGE" });
  });

  it("deleteEvent removes a known event and throws EVENT_NOT_FOUND for an unknown id", async () => {
    const file = freshFile();
    const p = new LocalCalendarProvider({ file, idFactory: seq() });
    await p.createEvent({ endsAt: d("2026-05-15T09:30:00Z"), startsAt: d("2026-05-15T09:00:00Z"), title: "Standup" });
    await p.deleteEvent("e0");
    expect(await p.listEvents({ from: d("2026-05-15T00:00:00Z"), to: d("2026-05-16T00:00:00Z") })).toEqual([]);
    await expect(p.deleteEvent("e0")).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("tolerates a missing / malformed calendar file as an empty calendar", async () => {
    const p = new LocalCalendarProvider({ file: freshFile() }); // file never created
    expect(await p.listEvents({ from: d("2026-05-15T00:00:00Z"), to: d("2026-05-16T00:00:00Z") })).toEqual([]);
  });
});
