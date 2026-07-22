import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatReminderDueLocal,
  type PersistedReminder,
  readReminderByIdStrict,
  readRemindersStrict,
  readReminderStatusFilter,
  readReminders,
  serializeReminder,
  serializeReminderForModel,
  snoozeReminder,
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

describe("snoozeReminder", () => {
  it("re-arms a fired reminder without retaining its prior firing receipt", () => {
    const next = snoozeReminder(
      [{ ...base, firedAt: "2026-01-01T09:01:00Z", status: "fired" }],
      base.id,
      "2026-01-01T10:00:00Z",
    );
    expect(next?.[0]).toMatchObject({ dueAt: "2026-01-01T10:00:00Z", status: "pending" });
    expect(next?.[0]).not.toHaveProperty("firedAt");
  });

  it("does not invent a reminder when the id is absent", () => {
    expect(snoozeReminder([base], "missing", "2026-01-01T10:00:00Z")).toBeUndefined();
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

  it("drops a reminder with a blank delivery route", async () => {
    const file = await tmp();
    await writeFile(file, JSON.stringify({ reminders: [{ ...base, via: { destination: " ", providerId: "slack" } }] }), "utf8");
    expect(await readReminders(file)).toEqual([]);
  });
});

describe("strict exact reminder reads", () => {
  const tmp = async (): Promise<{ file: string; root: string }> => {
    const root = await mkdtemp(join(tmpdir(), "muse-rem-strict-"));
    return { file: join(root, "reminders.json"), root };
  };

  it("returns only an exact id without changing the store", async () => {
    const { file } = await tmp();
    const strictBase = { ...base, createdAt: "2026-01-01T00:00:00.000Z", dueAt: "2026-01-01T09:00:00.000Z" };
    await writeReminders(file, [strictBase, { ...strictBase, id: "r10", text: "other" }]);
    const before = await readFile(file);
    await expect(readReminderByIdStrict(file, "r1")).resolves.toEqual(strictBase);
    await expect(readReminderByIdStrict(file, "r")).resolves.toBeUndefined();
    expect(await readFile(file)).toEqual(before);
  });

  it("fails closed on malformed rows without quarantine or sidecars", async () => {
    const { file, root } = await tmp();
    await writeFile(file, JSON.stringify({ reminders: [{ ...base, dueAt: "bad" }] }), "utf8");
    const before = await readFile(file);
    await expect(readRemindersStrict(file)).rejects.toThrow("reminder store cannot be read or validated");
    expect(await readFile(file)).toEqual(before);
    expect(await readdir(root)).toEqual(["reminders.json"]);
  });

  it("rejects duplicate canonical ids without selecting either row", async () => {
    const { file, root } = await tmp();
    await writeFile(file, JSON.stringify({ reminders: [base, { ...base, text: "conflicting duplicate" }] }), "utf8");
    const before = await readFile(file);
    await expect(readRemindersStrict(file)).rejects.toThrow("reminder store cannot be read or validated");
    await expect(readReminderByIdStrict(file, base.id)).rejects.toThrow("reminder store cannot be read or validated");
    expect(await readFile(file)).toEqual(before);
    expect(await readdir(root)).toEqual(["reminders.json"]);
  });

  it("distinguishes an unavailable store from an empty valid store", async () => {
    const { file } = await tmp();
    await expect(readRemindersStrict(file)).rejects.toThrow("reminder store cannot be read or validated");
    await writeReminders(file, []);
    await expect(readRemindersStrict(file)).resolves.toEqual([]);
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
