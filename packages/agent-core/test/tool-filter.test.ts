import { describe, expect, it } from "vitest";
import type { MuseTool, MuseToolDefinition } from "@muse/tools";

import { DefaultToolFilter, inferDomain } from "../src/tool-filter.js";

function tool(definition: MuseToolDefinition): MuseTool {
  return { definition, execute: () => "ok" };
}

const tools: readonly MuseTool[] = [
  tool({ description: "Send slack", domain: "messaging", inputSchema: {}, name: "muse.messaging.send", risk: "write" }),
  tool({ description: "Read calendar", domain: "calendar", inputSchema: {}, name: "muse.calendar.upcoming", risk: "read" }),
  tool({ description: "Get time", domain: "core", inputSchema: {}, name: "muse.time.now", risk: "read" }),
  tool({ description: "Note search", domain: "notes", inputSchema: {}, name: "muse.notes.search", risk: "read" }),
  tool({ description: "No domain", inputSchema: {}, name: "legacy.untagged", risk: "read" })
];

describe("DefaultToolFilter", () => {
  const filter = new DefaultToolFilter();

  it("keeps core + untagged tools regardless of prompt", () => {
    const kept = filter.filter(tools, { userMessage: "completely unrelated topic" });
    expect(kept.map((t) => t.definition.name)).toContain("muse.time.now");
    expect(kept.map((t) => t.definition.name)).toContain("legacy.untagged");
    expect(kept.map((t) => t.definition.name)).not.toContain("muse.messaging.send");
  });

  it("surfaces messaging tools when prompt mentions slack", () => {
    const kept = filter.filter(tools, { userMessage: "check the slack channel" });
    expect(kept.map((t) => t.definition.name)).toContain("muse.messaging.send");
    expect(kept.map((t) => t.definition.name)).not.toContain("muse.calendar.upcoming");
  });

  it("scope hints override keyword matching", () => {
    const kept = filter.filter(tools, { scopeHints: ["calendar"], userMessage: "hi" });
    expect(kept.map((t) => t.definition.name)).toContain("muse.calendar.upcoming");
  });
});

describe("inferDomain", () => {
  it("returns the explicit domain when set", () => {
    expect(inferDomain({ description: "", domain: "messaging", inputSchema: {}, name: "x", risk: "read" })).toBe(
      "messaging"
    );
  });

  it("falls back to prefix-based detection", () => {
    expect(inferDomain({ description: "", inputSchema: {}, name: "muse.calendar.list", risk: "read" })).toBe("calendar");
    expect(inferDomain({ description: "", inputSchema: {}, name: "muse.time.now", risk: "read" })).toBe("core");
    expect(inferDomain({ description: "", inputSchema: {}, name: "legacy.foo", risk: "read" })).toBeUndefined();
  });
});
