import { describe, expect, it } from "vitest";

import { InMemoryContextReferenceStore } from "../src/context-reference-store.js";
import { maskStaleToolObservations } from "../src/observation-mask.js";

interface Msg {
  role: string;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: readonly { id: string; name: string; arguments: unknown }[];
}

function call(id: string, name: string) {
  return { id, name, arguments: {} };
}

function conversation(staleSize = 5000, latestSize = 4000): Msg[] {
  return [
    { role: "user", content: "do a multi-step task" },
    { role: "assistant", content: "", toolCalls: [call("c1", "muse.fs.read")] },
    { role: "tool", content: "A".repeat(staleSize), name: "muse.fs.read", toolCallId: "c1" },
    { role: "assistant", content: "", toolCalls: [call("c2", "knowledge_search")] },
    { role: "tool", content: "B".repeat(latestSize), name: "knowledge_search", toolCallId: "c2" }
  ];
}

describe("maskStaleToolObservations", () => {
  it("masks a stale tool message to a ref-bearing placeholder; original is recoverable from the store", () => {
    const store = new InMemoryContextReferenceStore();
    const original = "A".repeat(5000);
    const { messages, maskedCount } = maskStaleToolObservations(conversation(), { refStore: store });

    expect(maskedCount).toBe(1);
    const stale = messages[2];
    expect(stale.content).toContain("[observation masked:");
    expect(stale.content).toContain("ref=");
    const refMatch = stale.content.match(/ref=([0-9a-f]+)/);
    expect(refMatch).not.toBeNull();
    const ref = refMatch![1];
    expect(store.get(ref)?.content).toBe(original);
  });

  it("keeps the latest turn's tool output FULL (default keepLatestTurns:1)", () => {
    const store = new InMemoryContextReferenceStore();
    const latest = "B".repeat(4000);
    const { messages } = maskStaleToolObservations(conversation(), { refStore: store });

    expect(messages[4].content).toBe(latest);
    expect(messages[4].content).not.toContain("[observation masked:");
  });

  it("preserves pairing — no tool message dropped, each remaining tool message keeps its toolCallId", () => {
    const store = new InMemoryContextReferenceStore();
    const input = conversation();
    const { messages } = maskStaleToolObservations(input, { refStore: store });

    expect(messages).toHaveLength(input.length);
    const toolMsgs = messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    for (const m of toolMsgs) {
      expect(m.toolCallId).toBeTruthy();
    }
    expect(messages[2].toolCallId).toBe("c1");
    expect(messages[4].toolCallId).toBe("c2");
  });

  it("is idempotent — re-masking an already-masked conversation is stable", () => {
    const store = new InMemoryContextReferenceStore();
    const once = maskStaleToolObservations(conversation(), { refStore: store });
    const twice = maskStaleToolObservations(once.messages, { refStore: store });

    expect(twice.maskedCount).toBe(0);
    expect(twice.messages.map((m) => m.content)).toEqual(once.messages.map((m) => m.content));
  });

  it("content-addressed — same content yields the same ref id", () => {
    const store = new InMemoryContextReferenceStore();
    const a = maskStaleToolObservations(conversation(), { refStore: store });
    const b = maskStaleToolObservations(conversation(), { refStore: new InMemoryContextReferenceStore() });

    const refA = a.messages[2].content.match(/ref=([0-9a-f]+)/)![1];
    const refB = b.messages[2].content.match(/ref=([0-9a-f]+)/)![1];
    expect(refA).toBe(refB);
  });

  it("is a no-op when no ref store is supplied (existing callers unaffected)", () => {
    const input = conversation();
    const { messages, maskedCount } = maskStaleToolObservations(input);

    expect(maskedCount).toBe(0);
    expect(messages.map((m) => m.content)).toEqual(input.map((m) => m.content));
  });

  it("keepLatestTurns:0 masks every stale and latest tool observation", () => {
    const store = new InMemoryContextReferenceStore();
    const { messages, maskedCount } = maskStaleToolObservations(conversation(), {
      refStore: store,
      keepLatestTurns: 0
    });

    expect(maskedCount).toBe(2);
    expect(messages[2].content).toContain("[observation masked:");
    expect(messages[4].content).toContain("[observation masked:");
  });
});
