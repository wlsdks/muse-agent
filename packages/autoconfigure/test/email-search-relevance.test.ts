import { DefaultToolFilter } from "@muse/agent-core";
import { type MuseTool } from "@muse/mcp";
import { createEmailSearchTool, type EmailSearcher } from "@muse/domain-tools";
import { describe, expect, it } from "vitest";

// search_email is only useful in reach when the user is looking for
// specific mail. Guarded here through the REAL DefaultToolFilter so a
// search prompt surfaces it and an unrelated prompt does not.
const filter = new DefaultToolFilter();
const searcher: EmailSearcher = { search: async () => [] };
const tools: MuseTool[] = [createEmailSearchTool({ searcher })];

function surfaced(userMessage: string): string[] {
  return filter.filter(tools, { userMessage }).map((t) => t.definition.name);
}

describe("search_email is gated to email-search prompts", () => {
  it("a 'find the email about X' prompt surfaces search_email", () => {
    expect(surfaced("find the email from the bank about my statement")).toContain("search_email");
    expect(surfaced("search my emails for the Paris trip")).toContain("search_email");
  });

  it("an unrelated prompt does NOT surface search_email", () => {
    expect(surfaced("what is 2 + 2?")).toEqual([]);
    expect(surfaced("turn on the lights")).toEqual([]);
  });
});
