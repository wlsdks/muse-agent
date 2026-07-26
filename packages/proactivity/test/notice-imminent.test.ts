import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CalendarProviderRegistry,
  type CalendarEvent,
  type CalendarProvider
} from "@muse/calendar";
import { writeTasks } from "@muse/stores";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  collectImminentCalendar,
  collectImminentTasks,
  type ImminentItem
} from "../src/notice-imminent.js";

const NOW = new Date("2026-07-27T03:00:00.000Z");
const STARTS_AT = new Date("2026-07-27T03:05:00.000Z");
const CUTOFF = new Date("2026-07-27T03:10:00.000Z");

function provider(id: string, event: CalendarEvent): CalendarProvider {
  return {
    createEvent: async () => { throw new Error("not used"); },
    deleteEvent: async () => { throw new Error("not used"); },
    describe: () => ({
      credentials: [],
      description: "test",
      displayName: id,
      id,
      local: true
    }),
    id,
    listEvents: async () => [event],
    updateEvent: async () => { throw new Error("not used"); }
  };
}

describe("imminent item provenance", () => {
  it("retains exact calendar provider identity for colliding event occurrences", async () => {
    const shared = {
      allDay: false,
      endsAt: new Date("2026-07-27T03:30:00.000Z"),
      id: "shared-event",
      startsAt: STARTS_AT,
      title: "Review"
    } as const;
    const registry = new CalendarProviderRegistry([
      provider("caldav", {
        ...shared,
        providerEventId: "caldav-raw-17",
        providerId: "caldav"
      }),
      provider("google", {
        ...shared,
        providerEventId: "google-raw-42",
        providerId: "google"
      })
    ]);

    const collected = await collectImminentCalendar(registry, NOW, CUTOFF);

    expect(collected.errors).toEqual([]);
    expect(collected.items).toEqual([
      expect.objectContaining({
        id: "shared-event",
        kind: "calendar",
        providerEventId: "caldav-raw-17",
        providerId: "caldav",
        startsAt: STARTS_AT
      }),
      expect.objectContaining({
        id: "shared-event",
        kind: "calendar",
        providerEventId: "google-raw-42",
        providerId: "google",
        startsAt: STARTS_AT
      })
    ]);
    expect(new Set(collected.items.map((item) => `${item.providerId}:${item.id}`)).size).toBe(2);
  });

  it("omits optional providerEventId when the calendar event has none", async () => {
    const registry = new CalendarProviderRegistry([
      provider("local", {
        allDay: false,
        endsAt: new Date("2026-07-27T03:30:00.000Z"),
        id: "local-event",
        providerId: "local",
        startsAt: STARTS_AT,
        title: "Local review"
      })
    ]);

    const [item] = (await collectImminentCalendar(registry, NOW, CUTOFF)).items;

    expect(item).toMatchObject({ id: "local-event", kind: "calendar", providerId: "local" });
    expect(item).not.toHaveProperty("providerEventId");
  });

  it("keeps task items free of calendar provenance fields in both type and value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-imminent-provenance-"));
    const tasksFile = join(dir, "tasks.json");
    await writeTasks(tasksFile, [{
      createdAt: "2026-07-27T02:00:00.000Z",
      dueAt: STARTS_AT.toISOString(),
      id: "task-1",
      status: "open",
      title: "Ship release"
    }]);

    const [item] = (await collectImminentTasks(tasksFile, NOW, CUTOFF)).items;
    type TaskItem = Extract<ImminentItem, { readonly kind: "task" }>;
    type TaskHasProviderId = "providerId" extends keyof TaskItem ? true : false;
    type TaskHasProviderEventId = "providerEventId" extends keyof TaskItem ? true : false;

    expectTypeOf<TaskHasProviderId>().toEqualTypeOf<false>();
    expectTypeOf<TaskHasProviderEventId>().toEqualTypeOf<false>();
    expect(item).toMatchObject({ id: "task-1", kind: "task" });
    expect(item).not.toHaveProperty("providerId");
    expect(item).not.toHaveProperty("providerEventId");
  });
});
