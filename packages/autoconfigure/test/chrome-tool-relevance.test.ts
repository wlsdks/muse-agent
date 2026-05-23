import { DefaultToolFilter } from "@muse/agent-core";
import { withChromeDevToolsRisk, type MuseTool } from "@muse/mcp";
import { describe, expect, it } from "vitest";

// Chrome DevTools MCP projects ~30 tools. Without a domain they were
// always-on, flooding every prompt's catalog. withChromeDevToolsRisk
// now stamps domain "web" so the filter only advertises them on a
// browser prompt — guarded here through the REAL filter.
const filter = new DefaultToolFilter();
const chromeTool = (name: string): MuseTool => ({
  definition: { description: name, inputSchema: { type: "object" }, name: `chrome-devtools.${name}`, risk: "read" },
  execute: async () => "ok"
});
const tools = withChromeDevToolsRisk([
  chromeTool("take_snapshot"),
  chromeTool("navigate_page"),
  chromeTool("click"),
  chromeTool("list_pages")
]);

function surfaced(userMessage: string): string[] {
  return filter.filter(tools, { userMessage }).map((t) => t.definition.name);
}

describe("Chrome tools are gated to web/browser prompts (not always-on)", () => {
  it("a browser prompt surfaces the chrome tools", () => {
    expect(surfaced("what's on the page in my browser?").length).toBeGreaterThan(0);
    expect(surfaced("summarize this web page").length).toBeGreaterThan(0);
  });

  it("an unrelated prompt surfaces NONE of the chrome tools (no flood)", () => {
    expect(surfaced("what is 2 + 2?")).toEqual([]);
    expect(surfaced("how am I feeling today?")).toEqual([]);
  });
});
