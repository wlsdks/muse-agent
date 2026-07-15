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

  it("labels a conversations-source hit with its resumable ref (R3-1: actionable citation)", async () => {
    const corpus = [rec("telegram:1234", "We discussed the VPN MTU fix over Telegram.", "conversations")];
    const tool = createHistorySearchTool({ records: () => corpus });
    const out = await tool.execute({ query: "vpn mtu" }, ctx);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toContain("[conversations:telegram:1234]");
    expect(text).toContain("muse chats resume telegram:1234");
  });
});

describe("createHistorySearchTool — hybrid (lexical + embedding-cosine) when embed is injected (A2)", () => {
  // A deterministic stand-in for the local embedder: a record/query about cats
  // maps to one axis, dogs to another. "feline companion" shares NO lexical term
  // with "pet cat", so only the cosine arm can connect them.
  const topicVector = (text: string): readonly number[] => {
    if (/feline|cat|고양이/iu.test(text)) return [1, 0];
    if (/canine|dog|강아지/iu.test(text)) return [0, 1];
    return [0, 0];
  };
  const embedded = (ref: string, text: string): HistoryRecord => ({ ...rec(ref, text), embedding: topicVector(text) });

  it("surfaces a PARAPHRASE the lexical search alone misses (semantic hit)", async () => {
    const corpus = [
      embedded("ep-cat", "We talked about my cat and its vet visit last week."),
      embedded("ep-dog", "Notes on the dog park walk and the new leash.")
    ];
    const embed = (text: string): Promise<readonly number[]> => Promise.resolve(topicVector(text));

    // Lexical-only (no embed): "feline companion" shares no term → no match.
    const lexicalOnly = createHistorySearchTool({ records: () => corpus });
    const lexOut = await lexicalOnly.execute({ query: "feline companion" }, ctx);
    expect(String(lexOut)).not.toContain("ep-cat");
    expect(String(lexOut).toLowerCase()).toContain("no");

    // Hybrid (embed injected): the cosine arm connects "feline" to the cat record.
    const hybrid = createHistorySearchTool({ records: () => corpus, embed });
    const hybridOut = await hybrid.execute({ query: "feline companion" }, ctx);
    expect(String(hybridOut)).toContain("ep-cat");
    expect(String(hybridOut)).not.toContain("ep-dog");
  });

  it("degrades to byte-identical lexical search when records carry no embedding", async () => {
    const corpus = [rec("ep-1", "the quarterly budget review and the launch retro")];
    const embed = (text: string): Promise<readonly number[]> => Promise.resolve(topicVector(text));
    const hybrid = createHistorySearchTool({ records: () => corpus, embed });
    const lexical = createHistorySearchTool({ records: () => corpus });
    const q = { query: "quarterly budget" };
    expect(String(await hybrid.execute(q, ctx))).toBe(String(await lexical.execute(q, ctx)));
  });

  it("fails soft to lexical when the query embedder throws (no crash, still finds the lexical hit)", async () => {
    const corpus = [embedded("ep-cat", "the cat and the vet visit")];
    const embed = (): Promise<readonly number[]> => Promise.reject(new Error("ollama down"));
    const tool = createHistorySearchTool({ records: () => corpus, embed });
    const out = await tool.execute({ query: "cat vet" }, ctx);
    expect(String(out)).toContain("ep-cat");
  });
});
