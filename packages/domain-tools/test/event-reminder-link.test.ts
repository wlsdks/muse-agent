import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { removeRemindersForEvent, rescheduleRemindersForEvent } from "../src/index.js";
import { readReminders, writeReminders, type PersistedReminder } from "@muse/stores";

const NOW = Date.parse("2026-06-10T12:00:00Z");
const reminder = (over: Partial<PersistedReminder>): PersistedReminder => ({
  createdAt: new Date(NOW - 3_600_000).toISOString(),
  dueAt: new Date(NOW + 1_800_000).toISOString(),
  id: "r1",
  status: "pending",
  text: "dentist heads-up",
  ...over
});

describe("removeRemindersForEvent", () => {
  it("removes ONLY the eventId-linked reminders", () => {
    const result = removeRemindersForEvent(
      [reminder({ eventId: "ev-1", id: "a" }), reminder({ eventId: "ev-2", id: "b" }), reminder({ id: "c" })],
      "ev-1"
    );
    expect(result.removed).toBe(1);
    expect(result.kept.map((r) => r.id).sort()).toEqual(["b", "c"]);
  });
});

describe("rescheduleRemindersForEvent", () => {
  const oldStart = new Date(NOW + 3_600_000);
  const newStart = new Date(NOW + 7_200_000);

  it("shifts linked reminders by the start delta, untouched otherwise", () => {
    const result = rescheduleRemindersForEvent(
      [reminder({ dueAt: new Date(NOW + 1_800_000).toISOString(), eventId: "ev-1", id: "a" }), reminder({ id: "b" })],
      "ev-1",
      oldStart,
      newStart,
      () => new Date(NOW)
    );
    expect(result.shifted).toBe(1);
    expect(result.next.find((r) => r.id === "a")?.dueAt).toBe(new Date(NOW + 1_800_000 + 3_600_000).toISOString());
    expect(result.next.find((r) => r.id === "b")?.dueAt).toBe(reminder({}).dueAt);
  });

  it("a FIRED reminder shifted into the future resets to pending so it can fire again (audit CLI #3)", () => {
    const result = rescheduleRemindersForEvent(
      [reminder({ dueAt: new Date(NOW - 1_800_000).toISOString(), eventId: "ev-1", firedAt: new Date(NOW - 1_700_000).toISOString(), id: "a", status: "fired" })],
      "ev-1",
      oldStart,
      newStart,
      () => new Date(NOW)
    );
    const shifted = result.next[0]!;
    expect(shifted.status).toBe("pending");
    expect(shifted.firedAt).toBeUndefined();
  });

  it("a fired reminder whose shifted dueAt is still in the PAST stays fired (no instant re-fire)", () => {
    const result = rescheduleRemindersForEvent(
      [reminder({ dueAt: new Date(NOW - 7_200_000).toISOString(), eventId: "ev-1", id: "a", status: "fired" })],
      "ev-1",
      new Date(NOW - 3_600_000),
      new Date(NOW - 1_800_000),
      () => new Date(NOW)
    );
    expect(result.next[0]?.status).toBe("fired");
  });
});

describe("loopback calendar update/delete sync the linked reminders (the orphan fix)", () => {
  it("delete removes the linked reminder; update reschedules it; unknown id touches nothing", async () => {
    // Anchored to the REAL clock (unlike the pure-function cases above): the
    // update/delete tools resolve events via a now()-relative listing window,
    // so a fixed past NOW silently ages out of it and the test time-bombs.
    const NOW = Date.now();
    const reminder = (over: Partial<PersistedReminder>): PersistedReminder => ({
      createdAt: new Date(NOW - 3_600_000).toISOString(),
      dueAt: new Date(NOW + 1_800_000).toISOString(),
      id: "r1",
      status: "pending",
      text: "dentist heads-up",
      ...over
    });
    const dir = mkdtempSync(join(tmpdir(), "muse-evlink-"));
    const remindersFile = join(dir, "reminders.json");
    const calendarFile = join(dir, "calendar.json");
    const { createCalendarMcpServer } = await import("@muse/domain-tools");
    const { CalendarProviderRegistry, LocalCalendarProvider } = await import("@muse/calendar");
    const registry = new CalendarProviderRegistry();
    registry.register(new LocalCalendarProvider({ file: calendarFile }));
    const start = new Date(NOW + 3_600_000);
    const created = await registry.createEvent(undefined, { endsAt: new Date(NOW + 7_200_000), startsAt: start, title: "dentist" });
    await writeReminders(remindersFile, [reminder({ dueAt: new Date(NOW + 1_800_000).toISOString(), eventId: created.id })]);

    const server = createCalendarMcpServer({ registry, remindersFile });
    const tool = (name: string) => server.tools.find((t) => t.name === name)!;

    // update: shift +2h → the linked reminder shifts too
    await tool("update").execute({ id: created.id, startsAt: new Date(NOW + 3_600_000 * 3).toISOString() });
    const afterUpdate = await readReminders(remindersFile);
    expect(afterUpdate[0]?.dueAt).toBe(new Date(NOW + 1_800_000 + 7_200_000).toISOString());

    // unknown id: nothing changes
    await tool("delete").execute({ id: "no-such-event-xyz" });
    expect((await readReminders(remindersFile)).length).toBe(1);

    // delete: linked reminder removed
    await tool("delete").execute({ id: created.id });
    expect((await readReminders(remindersFile)).length).toBe(0);
  });
});
