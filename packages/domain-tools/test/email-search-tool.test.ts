import { describe, expect, it } from "vitest";

import { createEmailSearchTool, type EmailSearcher, type EmailSummary } from "../src/index.js";

const MATCHES: EmailSummary[] = [
  { from: "bank@x.com", id: "m1", snippet: "your statement is ready", subject: "Statement", unread: true }
];

function searcher(onArgs?: (query: string, limit: number) => void, messages: EmailSummary[] = MATCHES): EmailSearcher {
  return {
    async search(query: string, limit: number) {
      onArgs?.(query, limit);
      return messages;
    }
  };
}

describe("createEmailSearchTool — find specific mail", () => {
  it("is risk:read, requires a query, and returns the matches", async () => {
    const tool = createEmailSearchTool({ searcher: searcher() });
    expect(tool.definition.risk).toBe("read");
    expect(tool.definition.inputSchema.required).toEqual(["query"]);
    const out = await tool.execute({ query: "statement" }) as { count: number; messages: Array<{ from: string }>; query: string };
    expect(out.count).toBe(1);
    expect(out.messages[0]).toMatchObject({ from: "bank@x.com" });
    expect(out.query).toBe("statement");
  });

  it("passes the trimmed query + clamped limit to the searcher", async () => {
    let seenQ = "";
    let seenLimit = -1;
    await createEmailSearchTool({ searcher: searcher((q, n) => { seenQ = q; seenLimit = n; }) })
      .execute({ limit: 999, query: "  Paris trip  " });
    expect(seenQ).toBe("Paris trip");
    expect(seenLimit).toBe(50);
  });

  it("a blank query is rejected without calling the searcher", async () => {
    let called = false;
    const out = await createEmailSearchTool({ searcher: searcher(() => { called = true; }) })
      .execute({ query: "   " }) as { count: number; error?: string };
    expect(called).toBe(false);
    expect(out.count).toBe(0);
    expect(out.error).toContain("query");
  });

  it("a searcher error degrades to an empty list with the error (never throws)", async () => {
    const throwing: EmailSearcher = { search: async () => { throw new Error("gmail 503"); } };
    const out = await createEmailSearchTool({ searcher: throwing }).execute({ query: "x" }) as { messages: unknown[]; error?: string };
    expect(out.messages).toEqual([]);
    expect(out.error).toContain("gmail 503");
  });

  it("its description steers AWAY from email_recent (disjoint sibling tools)", () => {
    const def = createEmailSearchTool({ searcher: searcher() }).definition;
    expect(def.description).toContain("email_recent");
    expect(def.name).toBe("search_email");
  });
});
