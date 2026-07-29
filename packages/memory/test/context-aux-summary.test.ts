import { describe, expect, it } from "vitest";

import {
  chunkDroppedOnToolPairs,
  summarizeDroppedContext,
  summarizeDroppedContextInStages,
  type ConversationMessage
} from "../src/index.js";

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

  it("forwards the caller signal without coupling the memory package to retry types", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    await summarizeDroppedContext(dropped, async (_messages, options) => {
      seen = options?.signal;
      return "ok";
    }, { fallback: "DET", signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });

  it("rethrows caller cancellation instead of laundering it into deterministic fallback", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancel compaction");
    controller.abort(cancellation);
    await expect(summarizeDroppedContext(dropped, async () => {
      throw cancellation;
    }, { fallback: "DET", signal: controller.signal })).rejects.toBe(cancellation);
  });
});

describe("chunkDroppedOnToolPairs", () => {
  const toolPairSequence: ConversationMessage[] = [
    { content: "u1".repeat(5), role: "user" },
    { content: "a1".repeat(5), role: "assistant", toolCalls: [{ arguments: "{}", id: "call-1", name: "t" }] },
    { content: "r1".repeat(5), role: "tool", toolCallId: "call-1" },
    { content: "r2".repeat(5), role: "tool", toolCallId: "call-1" },
    { content: "u2".repeat(5), role: "user" },
    { content: "a2".repeat(5), role: "assistant", toolCalls: [{ arguments: "{}", id: "call-2", name: "t" }] },
    { content: "r3".repeat(5), role: "tool", toolCallId: "call-2" }
  ];

  it("returns [] for an empty input", () => {
    expect(chunkDroppedOnToolPairs([], 1000)).toEqual([]);
  });

  it("returns one chunk when everything fits under the budget", () => {
    const chunks = chunkDroppedOnToolPairs(toolPairSequence, 10_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(toolPairSequence);
  });

  it("splits only at safe boundaries — never immediately before a role:tool message", () => {
    const chunks = chunkDroppedOnToolPairs(toolPairSequence, 15);

    // Reconstructing the chunks in order reproduces the input untouched.
    expect(chunks.flat()).toEqual(toolPairSequence);
    expect(chunks.length).toBeGreaterThan(1);

    // No chunk boundary opens on a tool message — every chunk after the
    // first starts with a non-tool message, so a tool result never gets
    // separated from the assistant call that produced it.
    for (const chunk of chunks) {
      expect(chunk[0]?.role).not.toBe("tool");
    }

    // Both tool results from the first pair land in the same chunk as
    // the assistant message that called them.
    const firstPairChunk = chunks.find((chunk) => chunk.includes(toolPairSequence[1]));
    expect(firstPairChunk).toContain(toolPairSequence[2]);
    expect(firstPairChunk).toContain(toolPairSequence[3]);

    // The second pair's tool result lands with its assistant call too.
    const secondPairChunk = chunks.find((chunk) => chunk.includes(toolPairSequence[5]));
    expect(secondPairChunk).toContain(toolPairSequence[6]);
  });

  it("keeps a single oversized tool pair as one chunk rather than splitting it", () => {
    const oversizedPair: ConversationMessage[] = [
      { content: "x".repeat(50), role: "assistant", toolCalls: [{ arguments: "{}", id: "call-1", name: "t" }] },
      { content: "y".repeat(50), role: "tool", toolCallId: "call-1" }
    ];
    const chunks = chunkDroppedOnToolPairs(oversizedPair, 10);
    expect(chunks).toEqual([oversizedPair]);
  });
});

describe("summarizeDroppedContextInStages (staged CMP-2 aux compaction)", () => {
  const bigSequence: ConversationMessage[] = [
    { content: "u1".repeat(20), role: "user" },
    { content: "a1".repeat(20), role: "assistant", toolCalls: [{ arguments: "{}", id: "call-1", name: "t" }] },
    { content: "r1".repeat(20), role: "tool", toolCallId: "call-1" },
    { content: "u2".repeat(20), role: "user" },
    { content: "a2".repeat(20), role: "assistant", toolCalls: [{ arguments: "{}", id: "call-2", name: "t" }] },
    { content: "r2".repeat(20), role: "tool", toolCallId: "call-2" },
    { content: "u3".repeat(20), role: "user" },
    { content: "a3".repeat(20), role: "assistant", toolCalls: [{ arguments: "{}", id: "call-3", name: "t" }] },
    { content: "r3".repeat(20), role: "tool", toolCallId: "call-3" }
  ];

  it("delegates to summarizeDroppedContext (byte-identical) when everything fits in one chunk", async () => {
    const dropped: ConversationMessage[] = [
      { content: "old user turn", role: "user" },
      { content: "old assistant turn", role: "assistant" }
    ];
    const direct = await summarizeDroppedContext(dropped, async () => "  aux summary  ", { fallback: "DET" });
    const staged = await summarizeDroppedContextInStages(dropped, async () => "  aux summary  ", {
      chunkMaxChars: 10_000,
      fallback: "DET"
    });
    expect(staged).toBe(direct);
  });

  it("merges the per-chunk summaries when the dropped context spans multiple chunks", async () => {
    let call = 0;
    const summarizer = async (messages: readonly ConversationMessage[]) => {
      call += 1;
      return `MARKER-${call}(len=${messages.length})`;
    };
    const out = await summarizeDroppedContextInStages(bigSequence, summarizer, {
      chunkMaxChars: 60,
      fallback: "DET"
    });
    expect(out).not.toBe("DET");
    expect(out).toContain("MARKER-1");
    expect(out).toContain("MARKER-2");
    expect(out).toContain("MARKER-3");
  });

  it("preserves the succeeded chunk summaries when one chunk's summarizer throws", async () => {
    let call = 0;
    const summarizer = async () => {
      call += 1;
      if (call === 2) {
        throw new Error("aux model down for this chunk");
      }
      return `SURVIVOR-${call}`;
    };
    const out = await summarizeDroppedContextInStages(bigSequence, summarizer, {
      chunkMaxChars: 60,
      fallback: "OVERALL_FALLBACK"
    });
    expect(out).toContain("SURVIVOR-1");
    expect(out).toContain("SURVIVOR-3");
    expect(out).not.toContain("OVERALL_FALLBACK");
  });

  it("falls back to the overall fallback when every chunk fails", async () => {
    const out = await summarizeDroppedContextInStages(bigSequence, async () => {
      throw new Error("aux model completely down");
    }, {
      chunkMaxChars: 60,
      fallback: "OVERALL_FALLBACK"
    });
    expect(out).toBe("OVERALL_FALLBACK");
  });

  it("stops staged summarization when a later chunk cancels", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancel later chunk");
    let calls = 0;
    await expect(summarizeDroppedContextInStages(bigSequence, async (_messages, options) => {
      calls += 1;
      expect(options?.signal).toBe(controller.signal);
      if (calls === 2) {
        controller.abort(cancellation);
        throw cancellation;
      }
      return `chunk-${calls.toString()}`;
    }, {
      chunkMaxChars: 60,
      fallback: "DET",
      signal: controller.signal
    })).rejects.toBe(cancellation);
    expect(calls).toBe(2);
  });

  it("returns the fallback for an empty dropped context (no chunks)", async () => {
    let called = false;
    const out = await summarizeDroppedContextInStages([], async () => {
      called = true;
      return "x";
    }, { fallback: "DET" });
    expect(out).toBe("DET");
    expect(called).toBe(false);
  });

  it("preserves an opaque identifier verbatim across merge + cap", async () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const path = "/Users/test-user/side-project/Muse/packages/memory/src/index.ts";
    let call = 0;
    const summarizer = async () => {
      call += 1;
      return call === 1 ? `Discussed identifier ${uuid}.` : `Referenced file ${path}.`;
    };
    const out = await summarizeDroppedContextInStages(bigSequence, summarizer, {
      chunkMaxChars: 60,
      fallback: "DET",
      maxChars: 500
    });
    expect(out).toContain(uuid);
    expect(out).toContain(path);
  });
});
