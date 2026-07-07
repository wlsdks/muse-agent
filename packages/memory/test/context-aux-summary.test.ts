import { describe, expect, it } from "vitest";

import { summarizeDroppedContext, type ConversationMessage } from "../src/index.js";

const dropped: ConversationMessage[] = [
  { content: "old user turn", role: "user" },
  { content: "old assistant turn", role: "assistant" }
];

describe("summarizeDroppedContext (CMP-2 aux compaction)", () => {
  it("returns the aux summary (trimmed) when the summarizer succeeds", async () => {
    const out = await summarizeDroppedContext(dropped, async () => "  aux summary  ", { fallback: "DET" });
    expect(out).toBe("aux summary");
  });

  it("falls back to deterministic when there is no summarizer", async () => {
    expect(await summarizeDroppedContext(dropped, undefined, { fallback: "DET" })).toBe("DET");
  });

  it("falls back when nothing was dropped (summarizer never called)", async () => {
    let called = false;
    const out = await summarizeDroppedContext([], async () => { called = true; return "x"; }, { fallback: "DET" });
    expect(out).toBe("DET");
    expect(called).toBe(false);
  });

  it("fails open to deterministic when the summarizer THROWS", async () => {
    const out = await summarizeDroppedContext(dropped, async () => { throw new Error("ollama down"); }, { fallback: "DET" });
    expect(out).toBe("DET");
  });

  it("falls back when the summarizer returns empty / whitespace", async () => {
    expect(await summarizeDroppedContext(dropped, async () => "", { fallback: "DET" })).toBe("DET");
    expect(await summarizeDroppedContext(dropped, async () => "   \n ", { fallback: "DET" })).toBe("DET");
  });

  it("truncates an over-long aux summary to maxChars", async () => {
    const out = await summarizeDroppedContext(dropped, async () => "abcdefghij", { fallback: "DET", maxChars: 4 });
    expect(out).toBe("abcd");
  });

  it("forwards focusTopic to the summarizer as its second argument", async () => {
    let seenOptions: { focusTopic?: string } | undefined;
    const summarizer = async (_msgs: typeof dropped, options?: { focusTopic?: string }) => {
      seenOptions = options;
      return "ok";
    };
    await summarizeDroppedContext(dropped, summarizer, { fallback: "DET", focusTopic: "vacation plans" });
    expect(seenOptions?.focusTopic).toBe("vacation plans");
  });

  it("does not pass a focusTopic option when unset", async () => {
    let seenOptions: { focusTopic?: string } | undefined = { focusTopic: "sentinel" };
    const summarizer = async (_msgs: typeof dropped, options?: { focusTopic?: string }) => {
      seenOptions = options;
      return "ok";
    };
    await summarizeDroppedContext(dropped, summarizer, { fallback: "DET" });
    expect(seenOptions).toBeUndefined();
  });
});
