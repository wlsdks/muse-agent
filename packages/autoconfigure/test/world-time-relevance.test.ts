import { DefaultToolFilter } from "@muse/agent-core";
import { createWorldTimeTool } from "@muse/domain-tools";
import { describe, expect, it } from "vitest";

// The REAL world_time tool through the REAL relevance filter — proves a
// natural "what time in X" prompt surfaces it (one-shot selection) and
// an unrelated prompt does NOT (small exposed set, tool-calling.md).
const filter = new DefaultToolFilter();
const tools = [createWorldTimeTool()];

function surfaces(userMessage: string): boolean {
  return filter.filter(tools, { userMessage }).some((t) => t.definition.name === "world_time");
}

describe("world_time surfaces for time/timezone prompts", () => {
  it("a 'what time is it in X' prompt surfaces it", () => {
    expect(surfaces("what time is it in tokyo?")).toBe(true);
    expect(surfaces("what's the current time in london")).toBe(true);
  });

  it("an unrelated prompt does NOT surface it", () => {
    expect(surfaces("what is 2 + 2?")).toBe(false);
    expect(surfaces("summarize this article")).toBe(false);
  });
});
