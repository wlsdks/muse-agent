import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createThreadedInboundRunner, fileThreadedTurnStore, type ThreadedTurnStore, type ThreadTurn } from "../src/index.js";

/** An in-memory `ThreadedTurnStore` fake — proves the runner's prepend/
 *  isolate/persist logic is generic across backends (the API server wires
 *  the SAME runner to a `FileConversationStore`-backed store in production;
 *  this fake exercises the identical contract without touching disk). */
function memoryThreadedTurnStore(): ThreadedTurnStore {
  const threads = new Map<string, ThreadTurn[]>();
  return {
    append: async (key, turns) => {
      threads.set(key, [...(threads.get(key) ?? []), ...turns]);
    },
    read: async (key) => threads.get(key) ?? []
  };
}

describe("createThreadedInboundRunner — multi-turn inbound retains context", () => {
  it("prepends prior turns on the next message of the same channel, isolated per channel", async () => {
    const store = memoryThreadedTurnStore();
    const seen: ThreadTurn[][] = [];
    let n = 0;
    const runner = createThreadedInboundRunner({
      run: async ({ messages }) => {
        seen.push([...messages]);
        n += 1;
        return `reply-${n.toString()}`;
      },
      store
    });

    // Turn 1 on chat-1: no prior history.
    const r1 = await runner.run({ providerId: "telegram", source: "chat-1", text: "my name is Sam" });
    expect(r1).toBe("reply-1");
    expect(seen[0]).toEqual([{ content: "my name is Sam", role: "user" }]);

    // Turn 2 on chat-1: the agent sees turn-1's user msg + reply.
    await runner.run({ providerId: "telegram", source: "chat-1", text: "what's my name?" });
    expect(seen[1]).toEqual([
      { content: "my name is Sam", role: "user" },
      { content: "reply-1", role: "assistant" },
      { content: "what's my name?", role: "user" }
    ]);

    // A different channel is an independent thread — no bleed.
    await runner.run({ providerId: "telegram", source: "chat-2", text: "hello" });
    expect(seen[2]).toEqual([{ content: "hello", role: "user" }]);

    // Different provider, same source id → still isolated.
    await runner.run({ providerId: "slack", source: "chat-1", text: "yo" });
    expect(seen[3]).toEqual([{ content: "yo", role: "user" }]);
  });

  it("threads notify through to the wrapped run unmodified, but never persists the ack as a thread turn", async () => {
    const store = memoryThreadedTurnStore();
    const notified: string[] = [];
    const notify = async (text: string) => {
      notified.push(text);
    };
    const seen: ThreadTurn[][] = [];
    const runner = createThreadedInboundRunner({
      run: async ({ messages, notify: passedNotify }) => {
        seen.push([...messages]);
        await passedNotify?.("on it — I'll let you know");
        return "final reply";
      },
      store
    });

    const reply = await runner.run({ notify, providerId: "telegram", source: "chat-1", text: "book a flight" });
    expect(reply).toBe("final reply");
    expect(notified).toEqual(["on it — I'll let you know"]);

    // Second turn: only the user message + the FINAL reply are in history —
    // the ack text sent via notify is nowhere in it.
    await runner.run({ providerId: "telegram", source: "chat-1", text: "did it work?" });
    expect(seen[1]).toEqual([
      { content: "book a flight", role: "user" },
      { content: "final reply", role: "assistant" },
      { content: "did it work?", role: "user" }
    ]);
  });

  it("fileThreadedTurnStore — the file-backed adapter round-trips through createThreadedInboundRunner identically", async () => {
    const threadFile = join(mkdtempSync(join(tmpdir(), "muse-thread-")), "threads.json");
    const seen: ThreadTurn[][] = [];
    const runner = createThreadedInboundRunner({
      run: async ({ messages }) => {
        seen.push([...messages]);
        return "reply-1";
      },
      store: fileThreadedTurnStore(threadFile)
    });

    await runner.run({ providerId: "telegram", source: "chat-1", text: "hi" });
    await runner.run({ providerId: "telegram", source: "chat-1", text: "again" });

    expect(seen[1]).toEqual([
      { content: "hi", role: "user" },
      { content: "reply-1", role: "assistant" },
      { content: "again", role: "user" }
    ]);
  });
});
