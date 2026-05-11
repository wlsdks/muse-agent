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

  it("retains tools the agent already used on a prior turn (iter 5)", () => {
    // No messaging keyword in this turn, but the agent invoked
    // muse.messaging.send last turn — retain it so a follow-up like
    // "reply to that" can still trigger the messaging path.
    const kept = filter.filter(tools, {
      recentToolNames: ["muse.messaging.send"],
      userMessage: "reply to that"
    });
    expect(kept.map((t) => t.definition.name)).toContain("muse.messaging.send");
    // Unrelated calendar / notes still hidden — no false-positive
    // expansion from the recent set.
    expect(kept.map((t) => t.definition.name)).not.toContain("muse.calendar.upcoming");
  });
});

describe("inferDomain prefix table (iter 5)", () => {
  it("recognises muse.skills.* as core (always-on)", () => {
    expect(inferDomain({ description: "", inputSchema: {}, name: "muse.skills.list", risk: "read" })).toBe("core");
    expect(inferDomain({ description: "", inputSchema: {}, name: "muse.skills.run", risk: "execute" })).toBe("core");
  });

  it("recognises muse.notes.* (Korean note keywords surface notes-domain tools)", () => {
    const filter = new DefaultToolFilter();
    const notesTool: MuseTool = tool({
      description: "List notes",
      inputSchema: {},
      name: "muse.notes.list",
      risk: "read"
    });
    const kept = filter.filter([notesTool], { userMessage: "내 노트 보여줘" });
    expect(kept).toHaveLength(1);
    const kept2 = filter.filter([notesTool], { userMessage: "위키 검색 좀" });
    expect(kept2).toHaveLength(1);
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
