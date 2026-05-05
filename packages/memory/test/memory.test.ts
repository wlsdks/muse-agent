import { describe, expect, it, vi } from "vitest";
import {
  COMPACTION_SUMMARY_PREFIX,
  computeApproximateTokens,
  createApproximateTokenEstimator,
  estimateConversationTokens,
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
