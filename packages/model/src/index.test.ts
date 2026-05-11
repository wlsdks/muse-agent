import { describe, expect, it } from "vitest";
import type { ModelEvent, ModelResponse, WebSearchCitation } from "./index.js";

describe("web search types", () => {
  it("ModelResponse accepts an optional citations array", () => {
    const r: ModelResponse = {
      id: "r1",
      model: "m",
      output: "hi",
      citations: [{ url: "https://example.com", title: "Ex" }]
    };
    expect(r.citations?.[0]?.url).toBe("https://example.com");
  });

  it("ModelEvent union includes tool-call-started, tool-call-finished, citations", () => {
    const events: ModelEvent[] = [
      { type: "tool-call-started", name: "web_search" },
      { type: "tool-call-finished", name: "web_search", count: 2 },
      { type: "citations", items: [{ url: "https://x.test", title: "X" }] }
    ];
    expect(events).toHaveLength(3);
  });

  it("WebSearchCitation requires url and title", () => {
    const c: WebSearchCitation = { url: "https://a.test", title: "A" };
    expect(c.title).toBe("A");
  });
});
