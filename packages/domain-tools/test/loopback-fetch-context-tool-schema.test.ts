import { validateToolDefinitions, type MuseTool } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { createContextReferenceMcpServer, createFetchMcpServer } from "../src/index.js";

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

describe("fetch + context loopback tools meet the one-shot tool-calling bar", () => {
  it("fetch get/head describe their url parameter", () => {
    const server = createFetchMcpServer({ allowedHosts: ["example.com"] });
    const issues = validateToolDefinitions(asMuseTools(server.tools));
    expect(issues.filter((i) => i.code === "undescribed_parameter")).toEqual([]);
    const get = server.tools.find((t) => t.name === "get")!;
    const url = (get.inputSchema as { properties: Record<string, { description?: string }> }).properties.url;
    expect(url.description ?? "").toContain("http");
  });

  it("context active/get-by-ref describe all their parameters", () => {
    const store = {
      get: () => undefined,
      put: () => ({ id: "x" })
    } as unknown as Parameters<typeof createContextReferenceMcpServer>[0]["store"];
    const server = createContextReferenceMcpServer({
      activeContextProvider: () => undefined,
      store
    } as unknown as Parameters<typeof createContextReferenceMcpServer>[0]);
    const issues = validateToolDefinitions(asMuseTools(server.tools));
    expect(issues.filter((i) => i.code === "undescribed_parameter")).toEqual([]);
    // Both the active resolver and the ref-expand tool are present.
    expect(server.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["active"]));
  });
});
