import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatReminderDueLocal,
  type PersistedReminder,
  readReminderStatusFilter,
  readReminders,
  serializeReminder,
  serializeReminderForModel,
  writeReminders,
} from "../src/personal-reminders-store.js";

const base: PersistedReminder = {
  id: "r1",
  text: "call mom",
  dueAt: "2026-01-01T09:00:00Z",
  status: "pending",
  createdAt: "2026-01-01T00:00:00Z",
};

describe("serializeReminder", () => {
  it("emits only the required fields for a minimal reminder", () => {
    expect(serializeReminder(base)).toEqual({
      createdAt: "2026-01-01T00:00:00Z",
      dueAt: "2026-01-01T09:00:00Z",
      id: "r1",
      status: "pending",
      text: "call mom",
    });
  });

  it("includes recurrence and firedAt when present", () => {
    expect(serializeReminder({ ...base, status: "fired", recurrence: "daily", firedAt: "2026-01-01T09:01:00Z" })).toMatchObject({
      recurrence: "daily",
      firedAt: "2026-01-01T09:01:00Z",
    });
  });

  it("projects only destination + providerId from via (dropping any extra fields)", () => {
    const out = serializeReminder({
      ...base,
      via: { destination: "C1", providerId: "slack", extra: "should-not-leak" } as PersistedReminder["via"],
    });
    expect(out.via).toEqual({ destination: "C1", providerId: "slack" });
  });

  it("omits via / recurrence / firedAt when absent", () => {
    const out = serializeReminder(base);
    expect(out).not.toHaveProperty("via");
    expect(out).not.toHaveProperty("recurrence");
    expect(out).not.toHaveProperty("firedAt");
  });

  it("includes the linked eventId when present, omits it otherwise", () => {
    expect(serializeReminder({ ...base, eventId: "evt_123" }).eventId).toBe("evt_123");
    expect(serializeReminder(base)).not.toHaveProperty("eventId");
  });
});

describe("eventId round-trip + read-boundary (calendar add --remind link)", () => {
  const tmp = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "muse-rem-")), "reminders.json");

  it("a reminder's eventId survives write → read", async () => {
    const file = await tmp();
    await writeReminders(file, [{ ...base, eventId: "evt_abc" }]);
    expect((await readReminders(file))[0]!.eventId).toBe("evt_abc");
  });

  it("drops a reminder with a non-string eventId (hand-edited bad value)", async () => {
    const file = await tmp();
    await writeFile(file, JSON.stringify({ reminders: [{ ...base, eventId: 42 }] }), "utf8");
    expect(await readReminders(file)).toEqual([]); // the malformed reminder is rejected at load
  });
});

describe("formatReminderDueLocal — renders the due time in the SERVER's local timezone (the bug: the model echoed the UTC ISO hour)", () => {
  it("renders the LOCAL clock hour + AM/PM + a relative hint, not the raw UTC ISO", () => {
    const dueIso = "2026-06-05T06:00:00.000Z";
    const now = (): Date => new Date("2026-06-04T01:00:00.000Z");
    const out = formatReminderDueLocal(dueIso, now);
    // The local hour as the runner's timezone renders it — proves it is NOT
    // blindly echoing the ISO "06". (In KST this is 3 PM; in UTC, 6 AM.)
    const localHour = new Date(dueIso).getHours();
    const hour12 = (localHour % 12) || 12;
    const ampm = localHour < 12 ? "AM" : "PM";
    expect(out).toContain(`${String(hour12)}:00`);
    expect(out).toContain(ampm);
    expect(out).toMatch(/\((?:tomorrow|today|in \d+ days)\)/u);
    // It must NOT look like a bare ISO instant (the failure mode).
    expect(out).not.toContain("T06:00");
    expect(out).not.toMatch(/Z$/u);
  });

  it("labels a past dueAt 'overdue' and a soon dueAt 'in N minutes'", () => {
    const now = (): Date => new Date("2026-06-04T12:00:00.000Z");
    expect(formatReminderDueLocal("2026-06-04T11:00:00.000Z", now)).toMatch(/\(overdue\)/u);
    expect(formatReminderDueLocal("2026-06-04T12:30:00.000Z", now)).toMatch(/\(in 30 minutes\)/u);
    expect(formatReminderDueLocal("2026-06-04T12:01:00.000Z", now)).toMatch(/\(in 1 minute\)/u);
  });

  it("echoes an unparseable value verbatim so the model never loses it", () => {
    expect(formatReminderDueLocal("not-a-real-date", () => new Date("2026-06-04T12:00:00.000Z"))).toBe("not-a-real-date");
  });
});

describe("serializeReminderForModel — the model-facing serialization carries dueAtLocal", () => {
  it("is serializeReminder plus a local-time dueAtLocal field", () => {
    const now = (): Date => new Date("2026-06-04T01:00:00.000Z");
    const out = serializeReminderForModel({ ...base, dueAt: "2026-06-05T06:00:00.000Z" }, now);
    expect(out).toMatchObject(serializeReminder({ ...base, dueAt: "2026-06-05T06:00:00.000Z" }));
    expect(typeof out["dueAtLocal"]).toBe("string");
    expect(out["dueAtLocal"]).toBe(formatReminderDueLocal("2026-06-05T06:00:00.000Z", now));
    expect(out["dueAtLocal"]).toMatch(/AM|PM/u);
  });
});

describe("readReminderStatusFilter", () => {
  it("passes through the recognised fired / all / due filters", () => {
    expect(readReminderStatusFilter("fired")).toBe("fired");
    expect(readReminderStatusFilter("all")).toBe("all");
    expect(readReminderStatusFilter("due")).toBe("due");
  });

  it("defaults to 'pending' for unset, empty, or unrecognised values", () => {
    expect(readReminderStatusFilter("pending")).toBe("pending");
    expect(readReminderStatusFilter(undefined)).toBe("pending");
    expect(readReminderStatusFilter("")).toBe("pending");
    expect(readReminderStatusFilter("bogus")).toBe("pending");
  });
});
