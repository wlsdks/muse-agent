import { describe, expect, it } from "vitest";

import { fireReminder, nextReminderOccurrence, normalizeReminderRecurrence, resolveReminderRef, type PersistedReminder } from "../src/index.js";

describe("resolveReminderRef — edit a reminder by id OR by a word from its text (one shot, not a 2-step search)", () => {
  const reminders: PersistedReminder[] = [
    { id: "rem_1", text: "Call the dentist", dueAt: "2026-06-05T06:00:00Z", status: "pending", createdAt: "2026-06-04T00:00:00Z" },
    { id: "rem_2", text: "Pay the electricity bill", dueAt: "2026-06-06T06:00:00Z", status: "pending", createdAt: "2026-06-04T00:00:00Z" },
    { id: "rem_3", text: "Call the dentist back", dueAt: "2026-06-01T06:00:00Z", status: "fired", createdAt: "2026-06-04T00:00:00Z" }
  ];

  it("resolves an exact id", () => {
    const r = resolveReminderRef(reminders, "rem_2");
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" && r.reminder.id).toBe("rem_2");
  });

  it("resolves a unique TEXT word (what the model actually passes) to the reminder", () => {
    const r = resolveReminderRef(reminders, "electricity");
    expect(r.status === "resolved" && r.reminder.id).toBe("rem_2");
  });

  it("prefers the PENDING match when a word hits both a pending and a fired reminder", () => {
    // "dentist" matches rem_1 (pending) and rem_3 (fired) → the pending one wins (unique among pending).
    const r = resolveReminderRef(reminders, "dentist");
    expect(r.status === "resolved" && r.reminder.id).toBe("rem_1");
  });

  it("returns AMBIGUOUS candidates (never a guess) when multiple PENDING reminders match", () => {
    const two: PersistedReminder[] = [
      { id: "a", text: "Call mom", dueAt: "2026-06-05T06:00:00Z", status: "pending", createdAt: "2026-06-04T00:00:00Z" },
      { id: "b", text: "Call dad", dueAt: "2026-06-05T06:00:00Z", status: "pending", createdAt: "2026-06-04T00:00:00Z" }
    ];
    const r = resolveReminderRef(two, "call");
    expect(r.status).toBe("ambiguous");
    expect(r.status === "ambiguous" && r.candidates.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("returns not-found for an empty ref or no match", () => {
    expect(resolveReminderRef(reminders, "").status).toBe("not-found");
    expect(resolveReminderRef(reminders, "groceries").status).toBe("not-found");
  });
});

describe("normalizeReminderRecurrence — coerce, never drop (a one-time reminder must still be created)", () => {
  it("passes through the real cadences daily/weekly (case-insensitive)", () => {
    expect(normalizeReminderRecurrence("daily")).toEqual({ recurrence: "daily" });
    expect(normalizeReminderRecurrence("Weekly")).toEqual({ recurrence: "weekly" });
  });

  it("treats omitted / empty / one-time SENTINELS as one-shot, silently (no error, no note)", () => {
    for (const sentinel of [undefined, "", "  ", "none", "once", "one-time", "one time", "single", "no", "never", "n/a", "false"]) {
      expect(normalizeReminderRecurrence(sentinel)).toEqual({});
    }
  });

  it("now passes through MONTHLY as a real cadence (rent / bills / subscriptions)", () => {
    expect(normalizeReminderRecurrence("monthly")).toEqual({ recurrence: "monthly" });
    expect(normalizeReminderRecurrence("Monthly")).toEqual({ recurrence: "monthly" });
  });

  it("a genuinely unsupported cadence still yields a one-shot + a note, NEVER a hard error", () => {
    const out = normalizeReminderRecurrence("fortnightly");
    expect(out.recurrence).toBeUndefined(); // created one-shot, not dropped
    expect(out.note).toMatch(/fortnightly.*supported.*one-time reminder/u);
  });
});

describe("nextReminderOccurrence — advance past the fire time, skip missed slots", () => {
  it("daily: advances one day when fired on time", () => {
    expect(nextReminderOccurrence("2026-05-24T09:00:00.000Z", "daily", "2026-05-24T09:00:00.000Z"))
      .toBe("2026-05-25T09:00:00.000Z");
  });

  it("weekly: advances seven days", () => {
    expect(nextReminderOccurrence("2026-05-24T09:00:00.000Z", "weekly", "2026-05-24T09:00:01.000Z"))
      .toBe("2026-05-31T09:00:00.000Z");
  });

  it("skips missed occurrences to the next FUTURE slot (daemon was off for days)", () => {
    // due Monday, fired the following Thursday → next daily slot is Friday, not a backlog.
    const next = nextReminderOccurrence("2026-05-18T09:00:00.000Z", "daily", "2026-05-21T10:00:00.000Z");
    expect(Date.parse(next)).toBeGreaterThan(Date.parse("2026-05-21T10:00:00.000Z"));
    expect(next).toBe("2026-05-22T09:00:00.000Z");
  });

  it("returns dueAt unchanged on an unparseable timestamp (defensive)", () => {
    expect(nextReminderOccurrence("not-a-date", "daily", "2026-05-24T09:00:00.000Z")).toBe("not-a-date");
  });
});

describe("nextReminderOccurrence — MONTHLY (calendar-aware, day clamped, anchor never drifts)", () => {
  // Built from LOCAL components so the calendar advance is asserted independent of
  // the runner's timezone (a monthly reminder fires on the user's local date).
  const localIso = (y: number, m: number, d: number, h = 9): string => new Date(y, m, d, h, 0).toISOString();
  const parts = (iso: string): { m: number; d: number } => { const x = new Date(iso); return { d: x.getDate(), m: x.getMonth() }; };

  it("advances one month when fired on time (the 1st → next 1st)", () => {
    expect(parts(nextReminderOccurrence(localIso(2026, 5, 1), "monthly", localIso(2026, 5, 1)))).toMatchObject({ d: 1, m: 6 }); // Jun 1 → Jul 1
  });

  it("clamps a 31st reminder to the last day of a SHORT month, then RETURNS to the 31st (no downward drift)", () => {
    // due Jan 31, fired Jan 31 → Feb 28 (clamped; 2026 is not a leap year)
    expect(parts(nextReminderOccurrence(localIso(2026, 0, 31), "monthly", localIso(2026, 0, 31)))).toMatchObject({ m: 1, d: 28 });
    // fired again at Feb 28 → Mar 31 (anchor day restored from the original due, NOT Mar 28)
    expect(parts(nextReminderOccurrence(localIso(2026, 0, 31), "monthly", localIso(2026, 1, 28)))).toMatchObject({ m: 2, d: 31 });
  });

  it("skips missed months to the next FUTURE occurrence (daemon was off)", () => {
    // due Jan 15, now Apr 10 → next is Apr 15, not a Feb/Mar backlog
    const next = nextReminderOccurrence(localIso(2026, 0, 15), "monthly", localIso(2026, 3, 10));
    expect(parts(next)).toMatchObject({ m: 3, d: 15 });
    expect(Date.parse(next)).toBeGreaterThan(Date.parse(localIso(2026, 3, 10)));
  });
});

describe("fireReminder — recurring re-arms (stays pending), one-shot fires", () => {
  const base: PersistedReminder = { createdAt: "2026-05-24T08:00:00.000Z", dueAt: "2026-05-24T09:00:00.000Z", id: "r1", status: "pending", text: "standup" };

  it("a one-shot reminder flips to fired with firedAt", () => {
    const next = fireReminder([base], "r1", "2026-05-24T09:00:05.000Z")!;
    expect(next[0]).toMatchObject({ firedAt: "2026-05-24T09:00:05.000Z", status: "fired" });
  });

  it("a recurring reminder stays pending and advances dueAt to the next occurrence", () => {
    const recurring: PersistedReminder = { ...base, recurrence: "weekly" };
    const next = fireReminder([recurring], "r1", "2026-05-24T09:00:05.000Z")!;
    expect(next[0]!.status).toBe("pending");
    expect(next[0]!.dueAt).toBe("2026-05-31T09:00:00.000Z");
    expect(next[0]!.firedAt).toBeUndefined();
  });

  it("returns undefined for an unknown id", () => {
    expect(fireReminder([base], "nope", "2026-05-24T09:00:05.000Z")).toBeUndefined();
  });
});
