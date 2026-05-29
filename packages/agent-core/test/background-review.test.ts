import { describe, expect, it } from "vitest";

import {
  BACKGROUND_REVIEW_HOOK_ID,
  createBackgroundReviewHook,
  createInMemoryReviewCounterStore,
  evaluateReviewTriggers,
  type BackgroundReviewInput
} from "../src/background-review.js";
import type { AgentRunContext, AgentRunInput } from "../src/types.js";
import type { ModelResponse, ModelToolCall, ToolExecutionResult } from "@muse/model";

const startedAt = new Date("2026-05-13T10:00:00.000Z");

function context(userId: string | null = "stark"): AgentRunContext {
  const input: AgentRunInput = {
    messages: [{ content: "hi", role: "user" }],
    model: "test/model",
    ...(userId !== null ? { metadata: { userId } as Record<string, string> } : {})
  };
  return { input, runId: "run_1", startedAt };
}

const response: ModelResponse = { id: "r1", model: "test/model", output: "ok" };
const toolCall = { id: "t1", input: {}, name: "noop" } as unknown as ModelToolCall;
const toolResult = {} as unknown as ToolExecutionResult;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("evaluateReviewTriggers", () => {
  it("fires a channel only once its accrued count reaches its interval; <=0 disables", () => {
    expect(evaluateReviewTriggers({ iters: 9, turns: 2 }, { memoryEveryTurns: 3, skillEveryIters: 10 })).toEqual({ reviewMemory: false, reviewSkill: false });
    expect(evaluateReviewTriggers({ iters: 10, turns: 3 }, { memoryEveryTurns: 3, skillEveryIters: 10 })).toEqual({ reviewMemory: true, reviewSkill: true });
    expect(evaluateReviewTriggers({ iters: 99, turns: 99 }, { memoryEveryTurns: 0, skillEveryIters: 0 })).toEqual({ reviewMemory: false, reviewSkill: false });
  });
});

describe("createInMemoryReviewCounterStore", () => {
  it("accumulates per user and resets only named fields", () => {
    const store = createInMemoryReviewCounterStore();
    store.increment("a", { iters: 4 });
    expect(store.increment("a", { turns: 1, iters: 2 })).toEqual({ iters: 6, turns: 1 });
    expect(store.increment("b", { turns: 1 })).toEqual({ iters: 0, turns: 1 }); // isolated per user
    store.reset("a", { turns: true });
    expect(store.increment("a", { turns: 0, iters: 0 })).toEqual({ iters: 6, turns: 0 }); // iters survived
  });
});

describe("createBackgroundReviewHook", () => {
  it("has the stable hook id and never reviews on a cheap turn (below both intervals)", async () => {
    const reviews: BackgroundReviewInput[] = [];
    const hook = createBackgroundReviewHook({ memoryEveryTurns: 3, runReview: (i) => { reviews.push(i); }, skillEveryIters: 10 });
    expect(hook.id).toBe(BACKGROUND_REVIEW_HOOK_ID);
    await hook.afterComplete!(context(), response); // turn 1, 0 iters → nothing
    await flush();
    expect(reviews).toEqual([]);
  });

  it("fires the MEMORY channel on the Nth turn and resets the turn counter", async () => {
    const reviews: BackgroundReviewInput[] = [];
    const hook = createBackgroundReviewHook({ memoryEveryTurns: 2, runReview: (i) => { reviews.push(i); }, skillEveryIters: 999 });
    await hook.afterComplete!(context(), response); // turn 1
    await flush();
    expect(reviews).toEqual([]);
    await hook.afterComplete!(context(), response); // turn 2 → memory fires
    await flush();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ reviewMemory: true, reviewSkill: false, userId: "stark" });
    // counter reset: two more turns needed before it fires again
    await hook.afterComplete!(context(), response);
    await flush();
    expect(reviews).toHaveLength(1);
  });

  it("fires the SKILL channel once accrued tool-iterations cross the threshold (hard tasks teach)", async () => {
    const reviews: BackgroundReviewInput[] = [];
    const hook = createBackgroundReviewHook({ memoryEveryTurns: 999, runReview: (i) => { reviews.push(i); }, skillEveryIters: 3 });
    // a hard turn: 3 tool iterations, then completes
    hook.afterTool!(context(), toolCall, toolResult);
    hook.afterTool!(context(), toolCall, toolResult);
    hook.afterTool!(context(), toolCall, toolResult);
    await hook.afterComplete!(context(), response);
    await flush();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ reviewMemory: false, reviewSkill: true });
  });

  it("swallows a throwing review (fail-soft, never blocks the turn)", async () => {
    const errors: unknown[] = [];
    const hook = createBackgroundReviewHook({
      memoryEveryTurns: 1,
      onError: (e) => { errors.push(e); },
      runReview: () => { throw new Error("review boom"); },
      skillEveryIters: 999
    });
    expect(() => hook.afterComplete!(context(), response)).not.toThrow(); // non-blocking: returns sync
    await flush();
    expect((errors[0] as Error).message).toBe("review boom");
  });

  it("skips a run with no resolvable userId (no metadata, no default)", async () => {
    const reviews: BackgroundReviewInput[] = [];
    const hook = createBackgroundReviewHook({ memoryEveryTurns: 1, runReview: (i) => { reviews.push(i); } });
    hook.afterComplete!(context(null), response); // null → no metadata.userId, no defaultUserId
    await flush();
    expect(reviews).toEqual([]);
  });
});
