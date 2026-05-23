import { validateToolDefinitions, type MuseTool } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { createRemindersMcpServer, createTasksMcpServer, createTasksRegistryMcpServer } from "../src/index.js";

function asMuseTools(tools: readonly { name: string; description: string; inputSchema?: unknown; risk?: unknown }[]): MuseTool[] {
  return tools.map((tool) => ({
    definition: {
      description: tool.description,
      inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      name: tool.name,
      risk: (tool.risk ?? "read") as "read" | "write" | "execute"
    },
    execute: async () => "unused"
  }));
}

const stubRegistry = { list: () => [], require: () => ({}), primary: () => undefined } as never;

describe("tasks + reminders loopback tools meet the one-shot tool-calling bar", () => {
  it("tasks tools describe ALL their parameters", () => {
    const server = createTasksMcpServer({ file: "/tmp/muse-test-tasks.json" });
    const issues = validateToolDefinitions(asMuseTools(server.tools));
    expect(issues.filter((i) => i.code === "undescribed_parameter")).toEqual([]);
    const add = server.tools.find((t) => t.name === "add")!;
    expect((add.inputSchema as { properties: Record<string, { description?: string }> }).properties.title.description ?? "").toContain("e.g.");
  });

  it("tasks-registry tools describe ALL their parameters", () => {
    const server = createTasksRegistryMcpServer({ registry: stubRegistry });
    expect(validateToolDefinitions(asMuseTools(server.tools)).filter((i) => i.code === "undescribed_parameter")).toEqual([]);
  });

  it("reminders tools describe ALL their parameters", () => {
    const server = createRemindersMcpServer({ file: "/tmp/muse-test-reminders.json" });
    expect(validateToolDefinitions(asMuseTools(server.tools)).filter((i) => i.code === "undescribed_parameter")).toEqual([]);
  });
});
