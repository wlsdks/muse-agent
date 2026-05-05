import { describe, expect, it, vi } from "vitest";
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_PINNED_ENTITIES_PREFIX,
  computeApproximateTokens,
  createApproximateTokenEstimator,
  estimateConversationTokens,
  InMemoryTaskMemoryStore,
  trimConversationMessages,
  type ConversationMessage,
  type TokenEstimator
} from "../src/index.js";

const lengthEstimator: TokenEstimator = {
  estimate: (text) => text.length
};

describe("approximate token estimator", () => {
  it("uses character-class heuristics and returns zero for empty text", () => {
    expect(computeApproximateTokens("")).toBe(0);
    expect(computeApproximateTokens("abcd")).toBe(1);
    expect(computeApproximateTokens("안녕")).toBe(1);
    expect(computeApproximateTokens("😀😀")).toBe(2);
  });

  it("caches repeated long text estimates behind a bounded hash key", () => {
    const estimator = createApproximateTokenEstimator({ cacheKeyMaxChars: 4, maxEntries: 2, ttlMs: 60_000 });
    const longText = "a".repeat(20);

    expect(estimator.estimate(longText)).toBe(estimator.estimate(longText));
  });

  it("expires cache entries by ttl", () => {
    vi.useFakeTimers();
    const estimator = createApproximateTokenEstimator({ ttlMs: 10 });

    expect(estimator.estimate("abcd")).toBe(1);
    vi.advanceTimersByTime(11);
    expect(estimator.estimate("abcd")).toBe(1);
    vi.useRealTimers();
  });
});

describe("conversation trimming", () => {
  it("keeps only the most recent user message when budget is non-positive", () => {
    const result = trimConversationMessages(
      [
        user("old"),
        assistant("answer"),
        user("latest")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 5,
        outputReserveTokens: 10,
        systemPrompt: "system"
      }
    );

    expect(result.messages).toEqual([user("latest")]);
    expect(result.removedCount).toBe(2);
  });

  it("keeps leading system memory while old history can satisfy the budget", () => {
    const result = trimConversationMessages(
      [
        system("facts"),
        system("summary"),
        user("old question"),
        assistant("old answer"),
        user("latest")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 75,
        outputReserveTokens: 0
      }
    );

    expect(result.messages.map((message) => message.role)).toEqual(["system", "system", "user"]);
    expect(result.messages.at(-1)?.content).toBe("latest");
  });

  it("drops leading system memory before dropping fresh tool observations", () => {
    const result = trimConversationMessages(
      [
        system("memory-a"),
        system("memory-b"),
        user("keep"),
        assistantTool("search", { q: "status" }),
        tool("search result")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 97,
        outputReserveTokens: 0
      }
    );

    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(result.messages[0]?.content).toBe("keep");
  });

  it("removes assistant tool calls with their tool response as a pair", () => {
    const result = trimConversationMessages(
      [
        assistantTool("search", { q: "old" }),
        tool("old result"),
        user("latest")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 30,
        outputReserveTokens: 0
      }
    );

    expect(result.messages).toEqual([user("latest")]);
  });

  it("removes orphan tool responses after all trim phases", () => {
    const result = trimConversationMessages(
      [
        system("memory"),
        tool("orphan"),
        user("latest")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 100,
        outputReserveTokens: 0
      }
    );

    expect(result.messages.some((message) => message.role === "tool")).toBe(false);
    expect(result.messages.at(-1)?.content).toBe("latest");
  });

  it("does not trim Phase 2 messages when total tokens exactly matches the budget", () => {
    const messages = [user("keep"), assistant("fit")];
    const exactBudget = estimateConversationTokens(messages, { estimator: lengthEstimator });
    const result = trimConversationMessages(messages, {
      estimator: lengthEstimator,
      maxContextWindowTokens: exactBudget,
      outputReserveTokens: 0
    });

    expect(result.messages).toEqual(messages);
    expect(result.estimatedTokens).toBe(exactBudget);
  });

  it("inserts a neutral compaction summary after enough messages are removed", () => {
    const result = trimConversationMessages(
      [
        user("first topic"),
        assistant("first answer"),
        user("second topic"),
        assistant("second answer"),
        user("third topic"),
        assistant("third answer"),
        user("current topic")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 120,
        outputReserveTokens: 20
      }
    );

    expect(result.summaryInserted).toBe(true);
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content.startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
  });

  it("preserves pinned entities from dropped user messages in the compaction summary", () => {
    const result = trimConversationMessages(
      [
        user("Investigate REACTOR-100 and the \"billing drift\" report"),
        assistant("old answer"),
        user("Then compare BB30-2581"),
        assistant("second answer"),
        user("current topic")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 110,
        outputReserveTokens: 20
      }
    );

    expect(result.summaryInserted).toBe(true);
    expect(result.messages[0]?.content).toContain(COMPACTION_PINNED_ENTITIES_PREFIX);
    expect(result.messages[0]?.content).toContain("REACTOR-100");
    expect(result.messages[0]?.content).toContain("billing drift");
    expect(result.messages[0]?.content).toContain("BB30-2581");
  });

  it("merges the previous compaction summary on later trim rounds", () => {
    const first = trimConversationMessages(
      [
        user("first topic REACTOR-101"),
        assistant("first answer"),
        user("second topic"),
        assistant("second answer"),
        user("current topic")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 100,
        outputReserveTokens: 20
      }
    );
    const second = trimConversationMessages(
      [
        ...first.messages,
        user("new topic"),
        assistant("new answer"),
        user("latest")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 95,
        outputReserveTokens: 20
      }
    );

    expect(second.summaryInserted).toBe(true);
    expect(second.messages[0]?.content).toContain(COMPACTION_SUMMARY_PREFIX);
    expect(second.messages[0]?.content).toContain("Additional compaction round");
    expect(second.messages[0]?.content).toContain("REACTOR-101");
  });
});

describe("task memory store", () => {
  it("finds active task memory by session and user fallback rules", async () => {
    const store = new InMemoryTaskMemoryStore();

    await store.save({
      goal: "Keep migration context",
      sessionId: "session-1",
      taskId: "task-session"
    });
    await store.save({
      goal: "User-specific context",
      sessionId: "session-1",
      taskId: "task-user",
      userId: "user-1"
    });

    expect(await store.findActiveBySession("session-1", "user-1")).toMatchObject({
      taskId: "task-user"
    });
    expect(await store.findActiveBySession("session-1")).toMatchObject({
      taskId: "task-session"
    });
  });

  it("purges terminal task memory older than the cutoff", async () => {
    const store = new InMemoryTaskMemoryStore({ retentionMs: 365 * 24 * 60 * 60 * 1000 });
    const old = new Date("2026-01-01T00:00:00.000Z");
    const fresh = new Date("2026-04-01T00:00:00.000Z");

    await store.save({
      goal: "Old completed task",
      sessionId: "session-1",
      status: "completed",
      taskId: "old-task",
      updatedAt: old
    });
    await store.save({
      goal: "Fresh completed task",
      sessionId: "session-1",
      status: "completed",
      taskId: "fresh-task",
      updatedAt: fresh
    });

    expect(await store.purgeTerminalOlderThan(new Date("2026-02-01T00:00:00.000Z"))).toBe(1);
    expect(await store.findById("old-task")).toBeUndefined();
    expect(await store.findById("fresh-task")).toMatchObject({ taskId: "fresh-task" });
  });

  it("purges expired task memory by retention window", async () => {
    const store = new InMemoryTaskMemoryStore({ retentionMs: 1000 });

    await store.save({
      goal: "Expired task",
      sessionId: "session-1",
      taskId: "expired-task",
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    });

    expect(await store.purgeExpired(new Date("2026-01-01T00:00:01.001Z"))).toBe(1);
    expect(await store.findById("expired-task")).toBeUndefined();
  });
});

function system(content: string): ConversationMessage {
  return { content, role: "system" };
}

function user(content: string): ConversationMessage {
  return { content, role: "user" };
}

function assistant(content: string): ConversationMessage {
  return { content, role: "assistant" };
}

function assistantTool(name: string, args: Record<string, string>): ConversationMessage {
  return {
    content: "",
    role: "assistant",
    toolCalls: [{ arguments: args, id: `call-${name}`, name }]
  };
}

function tool(content: string): ConversationMessage {
  return { content, role: "tool", toolCallId: "call-search" };
}
