import { DefaultToolFilter } from "@muse/agent-core";
import { createLoopbackMcpMuseTools } from "@muse/mcp";
import { createCalendarMcpServer } from "@muse/domain-tools";
import { describe, expect, it } from "vitest";

// The REAL calendar loopback tools, projected the production way
// (createLoopbackMcpMuseTools), through the REAL relevance filter. The
// availability tool answers "am I free?" — but the calendar DOMAIN
// keywords (calendar/meeting/event/…) miss free/busy vocabulary, so
// without per-tool keywords it was unreachable for its own prompts.
const filter = new DefaultToolFilter();
const registry = {
  createEvent: async () => ({}),
  deleteEvent: async () => undefined,
  describe: () => [],
  listEvents: async () => [],
  updateEvent: async () => ({})
} as never;
const tools = createLoopbackMcpMuseTools(createCalendarMcpServer({ registry }));

function surfaced(userMessage: string): string[] {
  return filter.filter(tools, { userMessage }).map((t) => t.definition.name);
}

describe("calendar availability is selectable for free/busy prompts", () => {
  it("'am I free at 3pm?' surfaces the availability tool", () => {
    expect(surfaced("am I free at 3pm?")).toContain("muse.calendar.availability");
  });

  it("'do I have any free time / find a gap / am I busy' surface availability", () => {
    expect(surfaced("do I have any free time this afternoon?")).toContain("muse.calendar.availability");
    expect(surfaced("find me a 30-minute gap tomorrow")).toContain("muse.calendar.availability");
    expect(surfaced("am I busy at 2?")).toContain("muse.calendar.availability");
  });

  it("a plain calendar prompt still surfaces the list tool (domain heuristic intact)", () => {
    expect(surfaced("what's on my calendar this week?")).toContain("muse.calendar.list");
  });

  it("per-tool keyword limits blast radius — a 'free' false-positive exposes ONLY availability, not list/add", () => {
    const names = surfaced("feel free to summarize this article");
    expect(names).not.toContain("muse.calendar.list");
    expect(names).not.toContain("muse.calendar.add");
  });

  it("a clearly-unrelated prompt surfaces no calendar tools", () => {
    expect(surfaced("what is the capital of France?")).toEqual([]);
  });
});
