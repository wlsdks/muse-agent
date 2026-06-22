import { describe, expect, it } from "vitest";

import { createCalendarMcpServer } from "../src/index.js";

const EVENTS = [
  { allDay: false, endsAt: new Date("2026-06-10T16:00:00Z"), id: "e1", providerId: "p", startsAt: new Date("2026-06-10T15:00:00Z"), title: "Dentist appointment" },
  { allDay: false, endsAt: new Date("2026-06-11T13:00:00Z"), id: "e2", location: "Cafe Roma", providerId: "p", startsAt: new Date("2026-06-11T12:00:00Z"), title: "Lunch with Bob" },
  { allDay: false, endsAt: new Date("2026-06-12T09:15:00Z"), id: "e3", notes: "discuss Bob's PR", providerId: "p", startsAt: new Date("2026-06-12T09:00:00Z"), title: "Team standup" }
];

function listTool(events = EVENTS) {
  const server = createCalendarMcpServer({
    registry: {
      createEvent: async () => ({}),
      deleteEvent: async () => undefined,
      describe: () => [],
      listEvents: async () => events,
      updateEvent: async () => ({})
    } as never
  });
  return server.tools.find((t) => t.name === "list")!;
}

describe("muse.calendar list — query filter", () => {
  it("filters events by a case-insensitive substring of title/location/notes (value flows)", async () => {
    const out = await listTool().execute({ query: "bob" }) as { total: number; query?: string; events: { id: string }[] };
    const ids = out.events.map((e) => e.id).sort();
    expect(ids).toEqual(["e2", "e3"]); // "Bob" in the title (e2) and in the notes (e3)
    expect(ids).not.toContain("e1");
    expect(out.query).toBe("bob");
    expect(out.total).toBe(2);
  });

  it("matches a location term ('my event at Cafe Roma')", async () => {
    const out = await listTool().execute({ query: "cafe roma" }) as { events: { id: string }[] };
    expect(out.events.map((e) => e.id)).toEqual(["e2"]);
  });

  it("a non-matching query returns zero; no query returns all (no-op)", async () => {
    expect((await listTool().execute({ query: "nonexistent" }) as { total: number }).total).toBe(0);
    expect((await listTool().execute({}) as { total: number }).total).toBe(3);
  });
});
