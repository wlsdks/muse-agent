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

  it("the 'add' tool's title + startsAtIso carry concrete, example-bearing descriptions", () => {
    const server = createCalendarMcpServer({ registry: stubRegistry });
    const add = server.tools.find((t) => t.name === "add")!;
    const props = (add.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.title.description ?? "").toContain("e.g.");
    expect(props.startsAtIso.description ?? "").toMatch(/tomorrow 3pm|ISO/u);
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
    const event = await addEvent({ title: "Dentist", startsAtIso: "2026-06-05T06:00:00.000Z", endsAtIso: "2026-06-05T07:00:00.000Z" });
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
    const event = await addEvent({ title: "Holiday", startsAtIso: "2026-06-05T00:00:00.000Z", allDay: true });
    expect(String(event["startsAtLocal"])).not.toContain("AM");
    expect(String(event["startsAtLocal"])).not.toContain("PM");
    expect(String(event["startsAtLocal"])).not.toContain("T00:00");
    expect(String(event["startsAtLocal"])).toMatch(/2026/u);
  });
});
