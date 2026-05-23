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
// A realistic projection: the daily-driver tools PLUS web-developer
// tools the real Chrome DevTools MCP also advertises (which should be
// curated out so the browser-prompt catalog stays small).
const rawProjection = [
  "take_snapshot", "navigate_page", "click", "list_pages", "take_screenshot", "wait_for", "fill_form",
  "performance_start_trace", "take_memory_snapshot", "list_network_requests", "evaluate_script", "emulate", "resize_page"
].map(chromeTool);
const tools = withChromeDevToolsRisk(rawProjection);

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

describe("Chrome projection is curated to the daily-driver subset (one-shot selection)", () => {
  it("drops web-developer tools, keeps the perceive + navigate + act essentials", () => {
    const names = tools.map((t) => t.definition.name.replace("chrome-devtools.", "")).sort();
    // Curated to ≤7 (was 13 raw) so a browser prompt doesn't flood the catalog.
    expect(tools.length).toBeLessThanOrEqual(7);
    expect(names).toContain("take_snapshot");
    expect(names).toContain("navigate_page");
    expect(names).toContain("click");
    expect(names).toContain("fill_form");
    // Web-developer tools are NOT exposed to the agent.
    expect(names).not.toContain("performance_start_trace");
    expect(names).not.toContain("take_memory_snapshot");
    expect(names).not.toContain("evaluate_script");
    expect(names).not.toContain("emulate");
  });

  it("a state-changing curated tool is risk-stamped fail-close (not the server's read default)", () => {
    const click = tools.find((t) => t.definition.name === "chrome-devtools.click");
    expect(click?.definition.risk).toBe("write");
  });
});
