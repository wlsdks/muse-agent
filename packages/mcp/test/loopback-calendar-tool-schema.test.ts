import { validateToolDefinitions, type MuseTool } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { createCalendarMcpServer } from "../src/index.js";

// Only the tool DEFINITIONS are inspected here — the registry is never
// called — so a typed stub is enough to build the server.
const stubRegistry = {
  createEvent: async () => ({}),
  deleteEvent: async () => undefined,
  listEvents: async () => [],
  updateEvent: async () => ({})
} as unknown as Parameters<typeof createCalendarMcpServer>[0]["registry"];

describe("calendar loopback tools meet the one-shot tool-calling bar", () => {
  it("every event tool (list/add/update/delete) describes ALL its parameters", () => {
    const server = createCalendarMcpServer({ registry: stubRegistry });
    const asMuseTools: MuseTool[] = server.tools.map((tool) => ({
      definition: {
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: "object" },
        name: tool.name,
        risk: tool.risk ?? "read"
      },
      execute: async () => "unused"
    }));

    const issues = validateToolDefinitions(asMuseTools);
    expect(issues.filter((i) => i.code === "undescribed_parameter")).toEqual([]);
    // Sanity: the write tools the model fills the most are present.
    const names = server.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["add", "update", "delete"]));
  });

  it("the 'add' tool's title + startsAt carry concrete, example-bearing descriptions", () => {
    const server = createCalendarMcpServer({ registry: stubRegistry });
    const add = server.tools.find((t) => t.name === "add")!;
    const props = (add.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.title.description ?? "").toContain("e.g.");
    // The exposed time field is the NEUTRAL `startsAt`, not `startsAtIso`: the
    // "Iso" suffix made the local model pre-compute a wrong, un-timezone-converted
    // ISO instead of passing the user's phrase to the server-side resolver.
    expect(props.startsAtIso).toBeUndefined();
    expect(props.startsAt.description ?? "").toMatch(/오후 3시|tomorrow 3pm/u);
  });

  it("calendar add/list own the event NOUN keywords so '일정 추가/보여줘' isn't hijacked by tasks/reminders", () => {
    // "내일 3시 일정 추가해줘" was creating a TASK because calendar.add had no
    // keywords (score 0) and tasks.add matched "추가" (score 1). The event NOUN
    // (일정/캘린더/event) must live on the calendar tools so they outrank the
    // other "add" domains for calendar intent.
    const server = createCalendarMcpServer({ registry: stubRegistry });
    const kwOf = (name: string) => ((server.tools.find((t) => t.name === name) as { keywords?: string[] })?.keywords ?? []);
    for (const w of ["일정", "캘린더", "추가"]) expect(kwOf("add")).toContain(w);
    for (const w of ["일정", "캘린더", "보여줘"]) expect(kwOf("list")).toContain(w);
  });

  it("calendar update/delete own the event NOUN + verb so '일정 삭제/변경' isn't hijacked by tasks.delete/update", () => {
    // "내일 회의 일정 삭제해줘" hit muse.tasks.delete because calendar.delete had no
    // keywords while tasks.delete (keyworded last fire) matched "삭제". Each calendar
    // lifecycle write needs the event noun + its verb to win calendar intent.
    const server = createCalendarMcpServer({ registry: stubRegistry });
    const kwOf = (name: string) => ((server.tools.find((t) => t.name === name) as { keywords?: string[] })?.keywords ?? []);
    for (const w of ["일정", "삭제", "delete"]) expect(kwOf("delete")).toContain(w);
    for (const w of ["일정", "변경", "update"]) expect(kwOf("update")).toContain(w);
  });
});

describe("calendar add result carries LOCAL-time fields so the model echoes the time you asked for, not the UTC ISO", () => {
  // A registry whose createEvent echoes the parsed input back as the created event.
  const echoRegistry = {
    createEvent: async (_providerId: string, input: { startsAt: Date; endsAt: Date; allDay: boolean; title: string }) => ({
      ...input, id: "e1", providerId: "local"
    }),
    deleteEvent: async () => undefined,
    listEvents: async () => [],
    updateEvent: async () => ({})
  } as unknown as Parameters<typeof createCalendarMcpServer>[0]["registry"];

  const addEvent = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const server = createCalendarMcpServer({ registry: echoRegistry });
    const add = server.tools.find((t) => t.name === "add")!;
    const result = (await add.execute(args)) as { event?: Record<string, unknown> };
    return result.event ?? {};
  };

  it("a TIMED event → startsAtLocal renders the LOCAL clock hour + AM/PM, not the bare UTC ISO", async () => {
    const event = await addEvent({ title: "Dentist", startsAt: "2026-06-05T06:00:00.000Z", endsAt: "2026-06-05T07:00:00.000Z" });
    const localHour = new Date("2026-06-05T06:00:00.000Z").getHours(); // KST 15 (3 PM) / UTC 6 (6 AM)
    const hour12 = (localHour % 12) || 12;
    const ampm = localHour < 12 ? "AM" : "PM";
    expect(String(event["startsAtLocal"])).toContain(`${String(hour12)}:00`);
    expect(String(event["startsAtLocal"])).toContain(ampm);
    expect(String(event["startsAtLocal"])).not.toContain("T06:00");
    expect(String(event["startsAtIso"])).toBe("2026-06-05T06:00:00.000Z"); // raw ISO still present for machine use
    expect(String(event["endsAtLocal"])).toMatch(/AM|PM/u);
  });

  it("an ALL-DAY event → startsAtLocal is date-only (no misleading 12:00 AM)", async () => {
    const event = await addEvent({ title: "Holiday", startsAt: "2026-06-05T00:00:00.000Z", allDay: true });
    expect(String(event["startsAtLocal"])).not.toContain("AM");
    expect(String(event["startsAtLocal"])).not.toContain("PM");
    expect(String(event["startsAtLocal"])).not.toContain("T00:00");
    expect(String(event["startsAtLocal"])).toMatch(/2026/u);
  });
});

describe("calendar update — a time-only reschedule keeps the event's DATE (and duration)", () => {
  const seedStart = new Date("2026-06-09T05:00:00.000Z"); // a Tuesday, the original day
  const seedEnd = new Date("2026-06-09T06:00:00.000Z"); // +1h duration
  const seed = { allDay: false, endsAt: seedEnd, id: "e1", providerId: "local", startsAt: seedStart, title: "Dentist" };

  const updateWith = async (args: Record<string, unknown>): Promise<{ startsAt: Date; endsAt: Date }> => {
    let captured: { startsAt?: Date; endsAt?: Date } = {};
    const registry = {
      createEvent: async () => ({}),
      deleteEvent: async () => undefined,
      listEvents: async () => [seed],
      updateEvent: async (_pid: string, _id: string, update: { startsAt?: Date; endsAt?: Date }) => {
        captured = update;
        return { ...seed, ...update };
      }
    } as unknown as Parameters<typeof createCalendarMcpServer>[0]["registry"];
    const server = createCalendarMcpServer({ registry });
    await server.tools.find((t) => t.name === "update")!.execute(args);
    return { endsAt: captured.endsAt!, startsAt: captured.startsAt! };
  };

  it("'오후 4시' (time only) stays on the original day, moves to 16:00, and keeps the 1h duration", async () => {
    // The bug: resolving "오후 4시" against `now` jumped a future event to today.
    const { startsAt, endsAt } = await updateWith({ id: "Dentist", startsAt: "오후 4시" });
    expect(startsAt.toDateString()).toBe(seedStart.toDateString()); // DATE preserved (TZ-independent)
    expect(startsAt.getHours()).toBe(16); // 오후 4시 local
    expect(endsAt.getTime() - startsAt.getTime()).toBe(seedEnd.getTime() - seedStart.getTime()); // duration kept
  });

  it("a DATE-bearing phrase still resolves normally (anchor unchanged) — an explicit ISO date is honored", async () => {
    const { startsAt } = await updateWith({ id: "Dentist", startsAt: "2026-06-20T01:00:00.000Z" });
    expect(startsAt.toISOString()).toBe("2026-06-20T01:00:00.000Z"); // not anchored to the event's day
  });
});
