import { describe, expect, it } from "vitest";

import { createHistorySearchTool } from "./history-search-tool.js";
import type { HistoryRecord } from "./history-search.js";

const rec = (ref: string, text: string, source: HistoryRecord["source"] = "episodes", timestampMs?: number): HistoryRecord => ({
  ref,
  source,
  text,
  ...(timestampMs !== undefined ? { timestampMs } : {})
});

const ctx = { runId: "test-run" };

describe("createHistorySearchTool — agent-callable history search (Gap1-S2)", () => {
  it("defines a read-risk history_search tool with a required query arg", () => {
    const tool = createHistorySearchTool({ records: () => [] });
    expect(tool.definition.name).toBe("history_search");
    expect(tool.definition.risk).toBe("read");
    expect(tool.definition.inputSchema.required).toEqual(["query"]);
    const props = tool.definition.inputSchema.properties as Record<string, { description?: string }>;
    expect(typeof props.query?.description).toBe("string");
    expect(props.query!.description!.length).toBeGreaterThan(20);
  });

  it("returns the matching past item with a source-labelled, citable line", async () => {
    const corpus = [
      rec("ep-1", "We compared VPN MTU settings and fixed dropped packets on the work laptop."),
      rec("ep-2", "Talked about the best ramen place downtown and weekend plans."),
      rec("ep-3", "Reviewed the Q3 launch retro and the marketing budget overrun.")
    ];
    const tool = createHistorySearchTool({ records: () => corpus });
    const out = await tool.execute({ query: "vpn mtu packets" }, ctx);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toContain("ep-1");
    expect(text).toContain("VPN MTU");
    expect(text).not.toContain("ep-2");
  });

  it("matches a Korean query against Korean history (CJK-aware)", async () => {
    const corpus = [
      rec("ep-ko", "지난주에 분기 보고서 마감과 예산 검토에 대해 길게 얘기했다."),
      rec("ep-en", "Talked about hiking trails and the camping gear we need.")
    ];
    const tool = createHistorySearchTool({ records: () => corpus });
    const out = await tool.execute({ query: "분기 보고서" }, ctx);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toContain("ep-ko");
    expect(text).not.toContain("ep-en");
  });

  it("returns an explicit no-match message when nothing shares a query term (no fabrication)", async () => {
    const corpus = [rec("ep-1", "We talked about the garden and the new tomato plants.")];
    const tool = createHistorySearchTool({ records: () => corpus });
    const out = await tool.execute({ query: "submarine telescope quarterly" }, ctx);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).not.toContain("ep-1");
    expect(text.toLowerCase()).toContain("no");
  });

  it("caps results at the requested topK", async () => {
    const corpus = [
      rec("a", "alpha report alpha report"),
      rec("b", "alpha report draft"),
      rec("c", "alpha report final"),
      rec("d", "alpha report appendix")
    ];
    const tool = createHistorySearchTool({ records: () => corpus });
    const out = await tool.execute({ query: "alpha report", topK: 2 }, ctx);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    const labelCount = (text.match(/\[(episodes|notes|memory):/g) ?? []).length;
    expect(labelCount).toBe(2);
  });

  it("handles an async records provider", async () => {
    const tool = createHistorySearchTool({
      records: async () => [rec("ep-async", "We discussed the rollback key rotation runbook.")]
    });
    const out = await tool.execute({ query: "rollback key rotation" }, ctx);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toContain("ep-async");
  });

  it("fails soft to a no-match message when the records provider throws", async () => {
    const tool = createHistorySearchTool({
      records: () => {
        throw new Error("store unreadable");
      }
    });
    const out = await tool.execute({ query: "anything at all" }, ctx);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text.toLowerCase()).toContain("no");
  });

  it("returns the no-match message for an empty / whitespace query (no eager fabrication)", async () => {
    const tool = createHistorySearchTool({ records: () => [rec("ep-1", "anything")] });
    const out = await tool.execute({ query: "   " }, ctx);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).not.toContain("ep-1");
  });
});
