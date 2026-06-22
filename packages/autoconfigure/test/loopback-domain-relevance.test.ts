import { DefaultToolFilter } from "@muse/agent-core";
import { type MuseTool } from "@muse/mcp";
import { createCalendarMcpServer, createTasksMcpServer } from "@muse/domain-tools";
import { describe, expect, it } from "vitest";

// Plurals / natural phrasing for the loopback domains, through the REAL
// filter. Word-boundary matching dropped "events"/"tasks" (vs the
// singular keywords) — this guards the DEFAULT_DOMAIN_KEYWORDS plurals.
const filter = new DefaultToolFilter();

function asMuseTools(tools: readonly { name: string; description: string; inputSchema?: unknown; risk?: unknown; domain?: unknown }[]): MuseTool[] {
  return tools.map((tool) => ({
    definition: {
      description: tool.description,
      inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      name: tool.name,
      risk: (tool.risk ?? "read") as "read" | "write" | "execute",
      ...(typeof tool.domain === "string" ? { domain: tool.domain } : {})
    },
    execute: async () => "unused"
  }));
}

const calendarTools = asMuseTools(createCalendarMcpServer({ registry: { listEvents: async () => [], createEvent: async () => ({}), updateEvent: async () => ({}), deleteEvent: async () => undefined } as never }).tools);
const taskTools = asMuseTools(createTasksMcpServer({ file: "/tmp/muse-test-domrel.json" }).tools);

function surfaced(tools: MuseTool[], userMessage: string): string[] {
  return filter.filter(tools, { userMessage }).map((t) => t.definition.name);
}

describe("loopback domains surface for plural / natural prompts", () => {
  it("'what are my events today?' (plural) surfaces the calendar tools", () => {
    expect(surfaced(calendarTools, "what are my events today?").length).toBeGreaterThan(0);
  });

  it("'do I have any meetings this week?' surfaces the calendar tools", () => {
    expect(surfaced(calendarTools, "do I have any meetings this week?").length).toBeGreaterThan(0);
  });

  it("'show my tasks' (plural) surfaces the task tools", () => {
    expect(surfaced(taskTools, "show my tasks").length).toBeGreaterThan(0);
  });

  it("an unrelated prompt surfaces NO calendar tools (small exposed set)", () => {
    expect(surfaced(calendarTools, "what is the capital of France?")).toEqual([]);
  });
});
