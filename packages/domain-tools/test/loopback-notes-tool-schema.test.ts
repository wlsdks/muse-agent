import { validateToolDefinitions, type MuseTool } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { createNotesRegistryMcpServer } from "../src/index.js";

// Only the tool DEFINITIONS are inspected — the registry is never
// called — so a typed stub suffices to build the server.
const stubRegistry = {
  list: () => [],
  require: () => ({}),
  primary: () => undefined
} as unknown as Parameters<typeof createNotesRegistryMcpServer>[0]["registry"];

describe("notes-registry loopback tools meet the one-shot tool-calling bar", () => {
  it("every notes tool (list/read/search/save/append) describes ALL its parameters", () => {
    const server = createNotesRegistryMcpServer({ registry: stubRegistry });
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
    expect(server.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list", "read", "search", "save", "append"]));
  });

  it("the 'save' tool's title + body carry concrete descriptions", () => {
    const server = createNotesRegistryMcpServer({ registry: stubRegistry });
    const save = server.tools.find((t) => t.name === "save")!;
    const props = (save.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.title.description ?? "").toContain("e.g.");
    expect((props.body.description ?? "").length).toBeGreaterThan(0);
  });
});
